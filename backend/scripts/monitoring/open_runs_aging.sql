-- Monitoring: approval runs open past the tenant's stall threshold.
-- -----------------------------------------------------------------------------
-- A complement to emit-stall-notifications — this surfaces runs WITHOUT relying
-- on whether the stall notifier has fired. Useful when triaging "why hasn't
-- this been approved" reports, or verifying the stall job is catching what it
-- should.
--
-- Idle clock: we use the latest approval_action timestamp if any, else the
-- run's opened_at. This matches the stall-notifier's intent ("nothing has
-- happened on this run in N hours") more closely than opened_at alone. The
-- built-in `_emit_stall_notifications` uses opened_at as a simpler proxy —
-- see migration 20260422151417.
--
-- Alert target: NONE by default — this is an operator view, not a pager.
--
-- Usage:
--   docker exec -i supabase_db_invenio-timekeeping psql -U postgres -d postgres \
--     -f backend/scripts/monitoring/open_runs_aging.sql
-- or
--   supabase db query --linked < backend/scripts/monitoring/open_runs_aging.sql

WITH last_action AS (
  SELECT run_id, max(ts) AS last_action_at
    FROM public.approval_actions
   GROUP BY run_id
),
aged AS (
  SELECT r.id                                           AS run_id,
         r.tenant_id,
         t.kind                                         AS timesheet_kind,
         t.period_start,
         p.number                                       AS project_number,
         r.status,
         r.current_node_id,
         coalesce(la.last_action_at, r.opened_at)       AS idle_since,
         tn.stall_hours
    FROM public.approval_runs r
    JOIN public.timesheets t  ON t.id = r.timesheet_id
    JOIN public.projects p    ON p.id = t.project_id
    JOIN public.tenants tn    ON tn.id = r.tenant_id
    LEFT JOIN last_action la  ON la.run_id = r.id
   WHERE r.status = 'open'
)
SELECT run_id,
       tenant_id,
       timesheet_kind,
       period_start,
       project_number,
       current_node_id,
       age(now(), idle_since) AS idle_for,
       stall_hours,
       CASE
         WHEN idle_since < now() - (stall_hours * 2 * interval '1 hour') THEN '2x overdue'
         WHEN idle_since < now() - (stall_hours *     interval '1 hour') THEN '1x overdue'
         ELSE 'within SLA'
       END AS sla_status
  FROM aged
 WHERE idle_since < now() - (stall_hours * interval '1 hour')
 ORDER BY idle_since ASC
 LIMIT 100;
