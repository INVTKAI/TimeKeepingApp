-- Go-live gate checks (spec §9.10).
-- ----------------------------------------------------------------------------
-- Runs every cutover-blocking invariant as a single-row-per-check result set.
-- A `violations > 0` row for any check BLOCKS cutover — fix the underlying
-- data (usually a Phase B spreadsheet gap) and re-run.
--
-- Usage:
--   psql <conn-url> -f go-live-gate.sql -v tenant_id="'<uuid>'"
-- or
--   docker exec -i supabase_db_invenio-timekeeping psql -U postgres -d postgres \
--     -v tenant_id="'<uuid>'" -f - < backend/scripts/go-live-gate.sql
--
-- `:tenant_id` binding is required — the gate is tenant-scoped. CI passes
-- it explicitly; ops fills it in before running.
-- ----------------------------------------------------------------------------

\set ON_ERROR_STOP on

-- Collect every gate result into a single-table output. Each row:
--   gate     : stable identifier per spec §9.10 item
--   violations : count of rows failing the invariant
--   sample     : up to 5 offending identifiers for fix-it convenience
--
-- Gate PASSES iff violations = 0.

WITH
  -- 1. Every active employee has a subcontractor_id (NOT NULL enforced by
  --    schema; this check surfaces any NULL row that snuck in via legacy data).
  emp_no_sub AS (
    SELECT id, first_name || ' ' || last_name AS label
      FROM public.employees
     WHERE tenant_id = :tenant_id
       AND active = true
       AND subcontractor_id IS NULL
  ),

  -- 2. Every active project has an ACTIVE project_flow_assignments row
  --    (effective_from <= today AND (effective_to IS NULL OR effective_to >= today)).
  proj_no_flow AS (
    SELECT p.id, p.number AS label
      FROM public.projects p
     WHERE p.tenant_id = :tenant_id
       AND p.active = true
       AND NOT EXISTS (
         SELECT 1 FROM public.project_flow_assignments a
          WHERE a.tenant_id = :tenant_id
            AND a.project_id = p.id
            AND a.effective_from <= CURRENT_DATE
            AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE)
       )
  ),

  -- 3. Every active silo (project_subcontractors with NULL end_date) has a
  --    foreman AND timekeeper_admin in silo_role_assignments, effective today.
  silo_role_missing AS (
    SELECT ps.id,
           (SELECT number FROM public.projects WHERE id = ps.project_id) || '/'
           || (SELECT short_code FROM public.subcontractors WHERE id = ps.subcontractor_id) AS label,
           string_agg(missing_role, ',') AS missing_roles
      FROM (
        SELECT ps.id,
               ps.project_id,
               ps.subcontractor_id,
               r.role AS missing_role
          FROM public.project_subcontractors ps
         CROSS JOIN (VALUES ('foreman'), ('timekeeper_admin')) r(role)
         WHERE ps.tenant_id = :tenant_id
           AND ps.end_date IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM public.silo_role_assignments s
              WHERE s.tenant_id = :tenant_id
                AND s.project_id = ps.project_id
                AND s.subcontractor_id = ps.subcontractor_id
                AND s.role_label = r.role
                AND s.effective_from <= CURRENT_DATE
                AND (s.effective_to IS NULL OR s.effective_to >= CURRENT_DATE)
           )
      ) ps
    GROUP BY ps.id, ps.project_id, ps.subcontractor_id
  ),

  -- 4. Every active project has pm + prime_rep in project_role_assignments
  --    (accounting is optional per §9.10 note).
  proj_role_missing AS (
    SELECT p.id,
           p.number AS label,
           string_agg(missing_role, ',') AS missing_roles
      FROM (
        SELECT p.id,
               p.number,
               r.role AS missing_role
          FROM public.projects p
         CROSS JOIN (VALUES ('pm'), ('prime_rep')) r(role)
         WHERE p.tenant_id = :tenant_id
           AND p.active = true
           AND NOT EXISTS (
             SELECT 1 FROM public.project_role_assignments pr
              WHERE pr.tenant_id = :tenant_id
                AND pr.project_id = p.id
                AND pr.role_label = r.role
                AND pr.effective_from <= CURRENT_DATE
                AND (pr.effective_to IS NULL OR pr.effective_to >= CURRENT_DATE)
           )
      ) p
    GROUP BY p.id, p.number
  ),

  -- 5. Every flow template's nodes resolve to at least one eligible user at
  --    run time. Uses _resolve_recipients' eligibility logic: for each node,
  --    is there at least one (user | role_on_silo | role_on_project) entry
  --    that resolves to a live user_id? Nodes with zero eligible approvers
  --    would cause every submission down that flow to fail at `submit_timesheet`.
  flow_node_empty AS (
    SELECT n.id AS id,
           (SELECT name FROM public.approval_flows WHERE id = n.flow_id) || ' / node ' || n.ordinal AS label
      FROM public.approval_nodes n
     WHERE n.tenant_id = :tenant_id
       AND NOT EXISTS (
         -- Direct user reference
         SELECT 1 FROM public.approval_node_approvers a
          INNER JOIN public.users u ON u.id = a.user_id
          WHERE a.node_id = n.id
            AND a.approver_type = 'user'
            AND u.status = 'active'
       )
       AND NOT EXISTS (
         -- Role on silo resolves via silo_role_assignments
         SELECT 1 FROM public.approval_node_approvers a
          INNER JOIN public.silo_role_assignments s
             ON s.role_label = a.role_label
            AND s.tenant_id = a.tenant_id
            AND s.effective_from <= CURRENT_DATE
            AND (s.effective_to IS NULL OR s.effective_to >= CURRENT_DATE)
          INNER JOIN public.users u ON u.id = s.user_id AND u.status = 'active'
          WHERE a.node_id = n.id
            AND a.approver_type = 'role_on_silo'
       )
       AND NOT EXISTS (
         -- Role on project resolves via project_role_assignments
         SELECT 1 FROM public.approval_node_approvers a
          INNER JOIN public.project_role_assignments pr
             ON pr.role_label = a.role_label
            AND pr.tenant_id = a.tenant_id
            AND pr.effective_from <= CURRENT_DATE
            AND (pr.effective_to IS NULL OR pr.effective_to >= CURRENT_DATE)
          INNER JOIN public.users u ON u.id = pr.user_id AND u.status = 'active'
          WHERE a.node_id = n.id
            AND a.approver_type = 'role_on_project'
       )
  ),

  -- 6. Every imported user is in status='pending' and has a paired auth.users
  --    row. Orphan auth.users OR public.users rows break the §4.8 invariant.
  user_pair_orphans AS (
    SELECT u.id, u.username AS label
      FROM public.users u
     WHERE u.tenant_id = :tenant_id
       AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)
  ),

  -- 7. Pre-cutover: nobody should have status='active' yet (release-queued-invites
  --    flips them to active on cutover). If anyone is already active, an invite
  --    has already gone out — the big-bang cutover is no longer clean.
  users_already_active AS (
    SELECT id, username AS label
      FROM public.users
     WHERE tenant_id = :tenant_id
       AND status = 'active'
  )

SELECT gate, violations, sample FROM (
  -- Gate 0 keeps the operator honest about whether they passed a real uuid:
  -- violations=1 means "tenant not found", which BLOCKS overall even though
  -- every other gate will show 0 in that case (no data to violate).
  SELECT 0 AS ord,
         '0. Tenant exists + active' AS gate,
         CASE WHEN EXISTS (SELECT 1 FROM public.tenants WHERE id = :tenant_id AND status = 'active')
              THEN 0 ELSE 1 END AS violations,
         (SELECT name FROM public.tenants WHERE id = :tenant_id) AS sample
  UNION ALL
  SELECT 1 AS ord,
         '1. Active employees have subcontractor_id' AS gate,
         (SELECT count(*)::int FROM emp_no_sub) AS violations,
         (SELECT string_agg(label, ', ' ORDER BY label) FROM (SELECT label FROM emp_no_sub LIMIT 5) x) AS sample
  UNION ALL
  SELECT 2, '2. Active projects have active flow assignment',
         (SELECT count(*)::int FROM proj_no_flow),
         (SELECT string_agg(label, ', ' ORDER BY label) FROM (SELECT label FROM proj_no_flow LIMIT 5) x)
  UNION ALL
  SELECT 3, '3. Active silos have foreman + timekeeper_admin',
         (SELECT count(*)::int FROM silo_role_missing),
         (SELECT string_agg(label || ' [' || missing_roles || ']', ', ' ORDER BY label) FROM (SELECT label, missing_roles FROM silo_role_missing LIMIT 5) x)
  UNION ALL
  SELECT 4, '4. Active projects have pm + prime_rep',
         (SELECT count(*)::int FROM proj_role_missing),
         (SELECT string_agg(label || ' [' || missing_roles || ']', ', ' ORDER BY label) FROM (SELECT label, missing_roles FROM proj_role_missing LIMIT 5) x)
  UNION ALL
  SELECT 5, '5. Flow nodes resolve to >=1 eligible user',
         (SELECT count(*)::int FROM flow_node_empty),
         (SELECT string_agg(label, ', ' ORDER BY label) FROM (SELECT label FROM flow_node_empty LIMIT 5) x)
  UNION ALL
  SELECT 6, '6. public.users rows all paired with auth.users',
         (SELECT count(*)::int FROM user_pair_orphans),
         (SELECT string_agg(label, ', ' ORDER BY label) FROM (SELECT label FROM user_pair_orphans LIMIT 5) x)
  UNION ALL
  SELECT 7, '7. Pre-cutover: no users in status=active yet',
         (SELECT count(*)::int FROM users_already_active),
         (SELECT string_agg(label, ', ' ORDER BY label) FROM (SELECT label FROM users_already_active LIMIT 5) x)
) ordered
ORDER BY ord;

-- Summary row.
SELECT
  CASE WHEN sum(violations) = 0 THEN 'GO-LIVE READY' ELSE 'BLOCKED' END AS overall,
  sum(violations)::int AS total_violations
FROM (
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.tenants WHERE id = :tenant_id AND status = 'active') THEN 0 ELSE 1 END AS violations
  UNION ALL SELECT (SELECT count(*) FROM (SELECT 1 FROM public.employees WHERE tenant_id = :tenant_id AND active = true AND subcontractor_id IS NULL) x) AS violations
  UNION ALL SELECT (SELECT count(*) FROM (
    SELECT 1 FROM public.projects p
     WHERE p.tenant_id = :tenant_id AND p.active = true
       AND NOT EXISTS (
         SELECT 1 FROM public.project_flow_assignments a
          WHERE a.tenant_id = :tenant_id AND a.project_id = p.id
            AND a.effective_from <= CURRENT_DATE
            AND (a.effective_to IS NULL OR a.effective_to >= CURRENT_DATE))
  ) x)
  UNION ALL SELECT (SELECT count(*) FROM public.project_subcontractors ps
     WHERE ps.tenant_id = :tenant_id AND ps.end_date IS NULL
       AND (
         NOT EXISTS (SELECT 1 FROM public.silo_role_assignments s
                      WHERE s.tenant_id = :tenant_id AND s.project_id = ps.project_id
                        AND s.subcontractor_id = ps.subcontractor_id
                        AND s.role_label = 'foreman'
                        AND s.effective_from <= CURRENT_DATE
                        AND (s.effective_to IS NULL OR s.effective_to >= CURRENT_DATE))
         OR NOT EXISTS (SELECT 1 FROM public.silo_role_assignments s
                         WHERE s.tenant_id = :tenant_id AND s.project_id = ps.project_id
                           AND s.subcontractor_id = ps.subcontractor_id
                           AND s.role_label = 'timekeeper_admin'
                           AND s.effective_from <= CURRENT_DATE
                           AND (s.effective_to IS NULL OR s.effective_to >= CURRENT_DATE))
       ))
  UNION ALL SELECT (SELECT count(*) FROM public.projects p
     WHERE p.tenant_id = :tenant_id AND p.active = true
       AND (
         NOT EXISTS (SELECT 1 FROM public.project_role_assignments pr
                      WHERE pr.tenant_id = :tenant_id AND pr.project_id = p.id
                        AND pr.role_label = 'pm'
                        AND pr.effective_from <= CURRENT_DATE
                        AND (pr.effective_to IS NULL OR pr.effective_to >= CURRENT_DATE))
         OR NOT EXISTS (SELECT 1 FROM public.project_role_assignments pr
                         WHERE pr.tenant_id = :tenant_id AND pr.project_id = p.id
                           AND pr.role_label = 'prime_rep'
                           AND pr.effective_from <= CURRENT_DATE
                           AND (pr.effective_to IS NULL OR pr.effective_to >= CURRENT_DATE))
       ))
  UNION ALL SELECT (SELECT count(*) FROM public.approval_nodes n
     WHERE n.tenant_id = :tenant_id
       AND NOT EXISTS (SELECT 1 FROM public.approval_node_approvers a
          INNER JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
          WHERE a.node_id = n.id AND a.approver_type = 'user')
       AND NOT EXISTS (SELECT 1 FROM public.approval_node_approvers a
          INNER JOIN public.silo_role_assignments s ON s.role_label = a.role_label AND s.tenant_id = a.tenant_id
            AND s.effective_from <= CURRENT_DATE
            AND (s.effective_to IS NULL OR s.effective_to >= CURRENT_DATE)
          INNER JOIN public.users u ON u.id = s.user_id AND u.status = 'active'
          WHERE a.node_id = n.id AND a.approver_type = 'role_on_silo')
       AND NOT EXISTS (SELECT 1 FROM public.approval_node_approvers a
          INNER JOIN public.project_role_assignments pr ON pr.role_label = a.role_label AND pr.tenant_id = a.tenant_id
            AND pr.effective_from <= CURRENT_DATE
            AND (pr.effective_to IS NULL OR pr.effective_to >= CURRENT_DATE)
          INNER JOIN public.users u ON u.id = pr.user_id AND u.status = 'active'
          WHERE a.node_id = n.id AND a.approver_type = 'role_on_project'))
  UNION ALL SELECT (SELECT count(*) FROM public.users u
     WHERE u.tenant_id = :tenant_id
       AND NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id))
  UNION ALL SELECT (SELECT count(*) FROM public.users
     WHERE tenant_id = :tenant_id AND status = 'active')
) s(violations);
