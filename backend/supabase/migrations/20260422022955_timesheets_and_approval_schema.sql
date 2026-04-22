-- ============================================================================
-- Timesheets + approval-subsystem schema (Batch 4a) — spec §6.6, §7.1–§7.5, §8
-- ----------------------------------------------------------------------------
-- Tables only. The state-machine RPCs (submit_timesheet / approve_run /
-- reject_run / recall_run / field claim-release / reassign_run / override_run
-- / resolve_badge_override), their supporting views/RPCs (project_readiness,
-- my_pending_approvals), idempotency-key enforcement, and notification outbox
-- land in Batch 4b/4c/5.
--
-- RLS policy conventions (derived from spec §8 write-path table):
--   * Most admin-gated tables: tenant-SELECT, admin-only INSERT/UPDATE/DELETE
--     (same template as Batch 3a).
--   * timesheets / timesheet_lines: scope-filtered SELECT (admin tenant-wide;
--     submitter sees rows they submitted, rows for their own employee record,
--     or rows on silos in their submitter_assignments); submitter writes
--     allowed while status IN ('draft','open'); post-submit mutation only via
--     Batch 4b RPCs.
--   * approval_runs / approval_actions / approval_reassignments /
--     badge_overrides: tenant-SELECT only; all writes via Batch 4b+ RPCs
--     which run SECURITY DEFINER to bypass the no-direct-write stance.
--   * idempotency_keys: no direct access from authenticated / anon (RPCs only).
-- ============================================================================

-- ============================================================================
-- Enums
-- ============================================================================

-- §7.4: staff never enters 'open'; field may.
CREATE TYPE public.timesheet_kind AS ENUM ('staff', 'field');

-- §7.4 state machine:
--   open ⇄ draft → submitted → in_review → approved | rejected | recalled
CREATE TYPE public.timesheet_status AS ENUM (
  'open', 'draft', 'submitted', 'in_review', 'approved', 'rejected', 'recalled'
);

-- §7.3 run lifecycle.
CREATE TYPE public.approval_run_status AS ENUM (
  'open', 'approved', 'rejected', 'recalled', 'abandoned'
);

-- §7.3 approval_actions.action.
CREATE TYPE public.approval_action_type AS ENUM (
  'approve', 'reject', 'reassign', 'recall', 'admin_override'
);

-- §7.1 approval_node_approvers.approver_type.
CREATE TYPE public.approver_ref_type AS ENUM (
  'user', 'role_on_silo', 'role_on_project'
);

-- §7.7 badge_overrides.status.
CREATE TYPE public.badge_override_status AS ENUM (
  'open', 'resolved_submitted_canonical', 'resolved_badge_canonical'
);

-- ============================================================================
-- Flow templates (§7.1)
-- ============================================================================

CREATE TABLE public.approval_flows (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name         text        NOT NULL,
  description  text        NULL,
  active       boolean     NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX approval_flows_tenant_idx ON public.approval_flows (tenant_id);

CREATE TABLE public.approval_nodes (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id    uuid    NOT NULL REFERENCES public.approval_flows(id) ON DELETE CASCADE,
  tenant_id  uuid    NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  ordinal    integer NOT NULL,
  name       text    NOT NULL,
  CHECK (ordinal BETWEEN 1 AND 5),   -- §7.1 "up to 5 ordered nodes"
  UNIQUE (flow_id, ordinal)
);
CREATE INDEX approval_nodes_tenant_idx ON public.approval_nodes (tenant_id);
CREATE INDEX approval_nodes_flow_ordinal_idx ON public.approval_nodes (flow_id, ordinal);

CREATE TABLE public.approval_node_approvers (
  id             uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id        uuid    NOT NULL REFERENCES public.approval_nodes(id) ON DELETE CASCADE,
  tenant_id      uuid    NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  approver_type  public.approver_ref_type NOT NULL,
  user_id        uuid    NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  role_label     text    NULL,
  -- Branch invariant: 'user' has user_id and no role_label; role-ref has role_label and no user_id.
  CHECK (
    (approver_type = 'user'            AND user_id IS NOT NULL AND role_label IS NULL)
    OR (approver_type IN ('role_on_silo','role_on_project')
        AND user_id IS NULL AND role_label IS NOT NULL)
  )
);
CREATE INDEX approval_node_approvers_tenant_idx ON public.approval_node_approvers (tenant_id);
CREATE INDEX approval_node_approvers_node_idx   ON public.approval_node_approvers (node_id);
-- Per-branch partial uniques (per spec §7.1 guidance: "use NULLS NOT DISTINCT or per-branch partial indexes").
CREATE UNIQUE INDEX approval_node_approvers_user_uidx
  ON public.approval_node_approvers (node_id, user_id)
  WHERE approver_type = 'user';
CREATE UNIQUE INDEX approval_node_approvers_role_uidx
  ON public.approval_node_approvers (node_id, approver_type, role_label)
  WHERE approver_type IN ('role_on_silo','role_on_project');

-- ============================================================================
-- Role assignments (§7.1) — effective-dated membership tables
-- ============================================================================

CREATE TABLE public.silo_role_assignments (
  id                uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid    NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  project_id        uuid    NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  subcontractor_id  uuid    NOT NULL REFERENCES public.subcontractors(id) ON DELETE RESTRICT,
  role_label        text    NOT NULL,
  user_id           uuid    NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  effective_from    date    NOT NULL,
  effective_to      date    NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from)
);
CREATE INDEX silo_role_assignments_tenant_idx ON public.silo_role_assignments (tenant_id);
CREATE INDEX silo_role_assignments_resolve_idx
  ON public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label);
CREATE INDEX silo_role_assignments_user_idx
  ON public.silo_role_assignments (tenant_id, user_id);

CREATE TABLE public.project_role_assignments (
  id              uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid    NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  project_id      uuid    NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  role_label      text    NOT NULL,
  user_id         uuid    NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  effective_from  date    NOT NULL,
  effective_to    date    NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, project_id, role_label, user_id, effective_from)
);
CREATE INDEX project_role_assignments_tenant_idx ON public.project_role_assignments (tenant_id);
CREATE INDEX project_role_assignments_resolve_idx
  ON public.project_role_assignments (tenant_id, project_id, role_label);
CREATE INDEX project_role_assignments_user_idx
  ON public.project_role_assignments (tenant_id, user_id);

-- ============================================================================
-- submitter_assignments (§5 + §9 Phase B row 8)
-- ----------------------------------------------------------------------------
-- Grants proxy-submission scope to a user on a (project, subcontractor) silo.
-- No effective-dating in v1 — admins revoke by deleting the row.
-- ============================================================================

CREATE TABLE public.submitter_assignments (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  user_id           uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  project_id        uuid        NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  subcontractor_id  uuid        NOT NULL REFERENCES public.subcontractors(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, project_id, subcontractor_id)
);
CREATE INDEX submitter_assignments_tenant_idx ON public.submitter_assignments (tenant_id);
CREATE INDEX submitter_assignments_user_idx
  ON public.submitter_assignments (user_id, project_id, subcontractor_id);

-- ============================================================================
-- project_flow_assignments (§7.2)
-- ----------------------------------------------------------------------------
-- "Which flow does this project currently use?". UNIQUE(tenant, project, start)
-- plus the runtime resolver picks the row with max effective_from <= now() for
-- a given project.
-- ============================================================================

CREATE TABLE public.project_flow_assignments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  project_id      uuid        NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  flow_id         uuid        NOT NULL REFERENCES public.approval_flows(id) ON DELETE RESTRICT,
  effective_from  date        NOT NULL,
  effective_to    date        NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (tenant_id, project_id, effective_from)
);
CREATE INDEX project_flow_assignments_tenant_idx ON public.project_flow_assignments (tenant_id);
CREATE INDEX project_flow_assignments_resolve_idx
  ON public.project_flow_assignments (tenant_id, project_id, effective_from DESC);

-- ============================================================================
-- Timesheets (§6.6)
-- ============================================================================

CREATE TABLE public.timesheets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  kind              public.timesheet_kind   NOT NULL,
  status            public.timesheet_status NOT NULL DEFAULT 'draft',
  submitter_user_id uuid        NULL REFERENCES public.users(id) ON DELETE RESTRICT,  -- NULL while in 'open' (pre-claim)
  employee_id       uuid        NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  project_id        uuid        NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  subcontractor_id  uuid        NOT NULL REFERENCES public.subcontractors(id) ON DELETE RESTRICT,
  period_start      date        NOT NULL,
  period_end        date        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  submitted_at      timestamptz NULL,
  CHECK (period_end >= period_start),
  -- Staff kind must have employee_id set; field kind may not (crew aggregates on lines).
  CHECK (kind <> 'staff' OR employee_id IS NOT NULL),
  -- 'open' is field-only (§7.4).
  CHECK (status <> 'open' OR kind = 'field'),
  -- 'open' implies no submitter yet (§7.4 "sets submitter_user_id on claim").
  CHECK (status <> 'open' OR submitter_user_id IS NULL),
  -- Any non-'open' status must have a submitter.
  CHECK (status = 'open' OR submitter_user_id IS NOT NULL)
);
CREATE INDEX timesheets_tenant_idx              ON public.timesheets (tenant_id);
CREATE INDEX timesheets_tenant_submitter_idx    ON public.timesheets (tenant_id, submitter_user_id);
CREATE INDEX timesheets_tenant_employee_idx     ON public.timesheets (tenant_id, employee_id);
CREATE INDEX timesheets_tenant_silo_period_idx  ON public.timesheets (tenant_id, project_id, subcontractor_id, period_start);
CREATE INDEX timesheets_tenant_status_idx       ON public.timesheets (tenant_id, status);

CREATE TABLE public.timesheet_lines (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  timesheet_id  uuid    NOT NULL REFERENCES public.timesheets(id) ON DELETE CASCADE,
  tenant_id     uuid    NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  date          date    NOT NULL,
  area_id       uuid    NULL REFERENCES public.areas(id) ON DELETE RESTRICT,
  task_code_id  uuid    NULL REFERENCES public.task_codes(id) ON DELETE RESTRICT,
  cwp_id        uuid    NULL REFERENCES public.cwps(id) ON DELETE RESTRICT,
  fco_id        uuid    NULL REFERENCES public.fcos(id) ON DELETE RESTRICT,
  employee_id   uuid    NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  hours_st      numeric(5,2) NOT NULL DEFAULT 0,
  hours_ot      numeric(5,2) NOT NULL DEFAULT 0,
  comment       text    NULL,
  CHECK (hours_st >= 0 AND hours_ot >= 0),
  CHECK (hours_st + hours_ot <= 24)
);
CREATE INDEX timesheet_lines_tenant_idx         ON public.timesheet_lines (tenant_id);
CREATE INDEX timesheet_lines_timesheet_idx      ON public.timesheet_lines (timesheet_id);
CREATE INDEX timesheet_lines_employee_date_idx  ON public.timesheet_lines (tenant_id, employee_id, date);

-- ============================================================================
-- Approval runs & audit (§7.3)
-- ============================================================================

CREATE TABLE public.approval_runs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  timesheet_id    uuid        NOT NULL REFERENCES public.timesheets(id) ON DELETE RESTRICT,
  flow_id         uuid        NOT NULL REFERENCES public.approval_flows(id) ON DELETE RESTRICT,
  status          public.approval_run_status NOT NULL DEFAULT 'open',
  current_node_id uuid        NULL REFERENCES public.approval_nodes(id) ON DELETE RESTRICT,
  version         integer     NOT NULL DEFAULT 0,    -- optimistic-concurrency marker (§7.4)
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz NULL,
  -- Terminal states close the run and null out current_node_id.
  CHECK (
    (status = 'open' AND current_node_id IS NOT NULL AND closed_at IS NULL)
    OR (status IN ('approved','rejected','recalled','abandoned')
        AND current_node_id IS NULL AND closed_at IS NOT NULL)
  )
);
CREATE INDEX approval_runs_tenant_idx           ON public.approval_runs (tenant_id);
CREATE INDEX approval_runs_timesheet_idx        ON public.approval_runs (timesheet_id);
CREATE INDEX approval_runs_tenant_status_idx    ON public.approval_runs (tenant_id, status);
-- Stall detection (§7.6): one cheap scan per day for open runs ordered by opened_at.
CREATE INDEX approval_runs_open_opened_at_idx
  ON public.approval_runs (tenant_id, opened_at)
  WHERE status = 'open';

CREATE TABLE public.approval_actions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  run_id         uuid        NOT NULL REFERENCES public.approval_runs(id) ON DELETE CASCADE,
  node_id        uuid        NOT NULL REFERENCES public.approval_nodes(id) ON DELETE RESTRICT,
  actor_user_id  uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action         public.approval_action_type NOT NULL,
  comment        text        NULL,
  ts             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_actions_tenant_idx ON public.approval_actions (tenant_id);
CREATE INDEX approval_actions_run_ts_idx ON public.approval_actions (run_id, ts);
-- No UPDATE/DELETE policies — append-only (§7.3).

CREATE TABLE public.approval_reassignments (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  run_id         uuid        NOT NULL REFERENCES public.approval_runs(id) ON DELETE CASCADE,
  node_id        uuid        NOT NULL REFERENCES public.approval_nodes(id) ON DELETE RESTRICT,
  from_user_id   uuid        NULL REFERENCES public.users(id) ON DELETE RESTRICT,  -- NULL when the stalled pool wasn't one specific user
  to_user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  reason         text        NOT NULL,
  admin_user_id  uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  ts             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_reassignments_tenant_idx ON public.approval_reassignments (tenant_id);
CREATE INDEX approval_reassignments_run_idx    ON public.approval_reassignments (run_id);

-- ============================================================================
-- Badge overrides (§6.6 + §7.7)
-- ============================================================================

CREATE TABLE public.badge_overrides (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  timesheet_line_id     uuid        NULL REFERENCES public.timesheet_lines(id) ON DELETE SET NULL,  -- NULL if retroactive with no matching line
  employee_id           uuid        NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  date                  date        NOT NULL,
  submitted_hours_st    numeric(5,2) NOT NULL DEFAULT 0,
  submitted_hours_ot    numeric(5,2) NOT NULL DEFAULT 0,
  badge_hours_st        numeric(5,2) NOT NULL DEFAULT 0,
  badge_hours_ot        numeric(5,2) NOT NULL DEFAULT 0,
  reason                text        NULL,    -- required at resolution, not at creation
  status                public.badge_override_status NOT NULL DEFAULT 'open',
  resolved_by_user_id   uuid        NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  resolved_at           timestamptz NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opened_by_user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  -- Resolved states must have a resolver + timestamp; open must not.
  CHECK (
    (status = 'open' AND resolved_by_user_id IS NULL AND resolved_at IS NULL)
    OR (status IN ('resolved_submitted_canonical','resolved_badge_canonical')
        AND resolved_by_user_id IS NOT NULL AND resolved_at IS NOT NULL
        AND reason IS NOT NULL)
  ),
  CHECK (submitted_hours_st >= 0 AND submitted_hours_ot >= 0
         AND badge_hours_st   >= 0 AND badge_hours_ot   >= 0)
);
CREATE INDEX badge_overrides_tenant_idx
  ON public.badge_overrides (tenant_id);
CREATE INDEX badge_overrides_tenant_status_idx
  ON public.badge_overrides (tenant_id, status);
CREATE INDEX badge_overrides_employee_date_idx
  ON public.badge_overrides (tenant_id, employee_id, date);
CREATE INDEX badge_overrides_line_idx
  ON public.badge_overrides (timesheet_line_id)
  WHERE timesheet_line_id IS NOT NULL;

-- ============================================================================
-- idempotency_keys (§8)
-- ----------------------------------------------------------------------------
-- Composite key is (actor_user_id, key) — different actors with the same
-- key value race normally. 24h TTL; a pg_cron job (Batch 5) cleans by
-- created_at. No RLS policies; revoked from authenticated/anon so the only
-- access path is service-role (Batch 4b RPCs).
-- ============================================================================

CREATE TABLE public.idempotency_keys (
  actor_user_id  uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  key            text        NOT NULL,
  response       jsonb       NULL,  -- cached successful response; NULL while in-flight
  status_code    integer     NULL,  -- cached HTTP status; NULL while in-flight
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, key)
);
CREATE INDEX idempotency_keys_created_at_idx ON public.idempotency_keys (created_at);

-- ============================================================================
-- Row-Level Security
-- ============================================================================

-- ---- Bulk template: tenant-SELECT + admin-only INSERT/UPDATE/DELETE --------
-- Applied to config/template tables where direct PostgREST writes are expected
-- and always admin-only. Same pattern as Batch 3a.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'approval_flows',
    'approval_nodes',
    'approval_node_approvers',
    'silo_role_assignments',
    'project_role_assignments',
    'submitter_assignments',
    'project_flow_assignments'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
         USING (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid);',
      t || '_tenant_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
         WITH CHECK (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                     AND (auth.jwt() ->> ''app_role'') = ''admin'');',
      t || '_admin_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
         USING      (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                     AND (auth.jwt() ->> ''app_role'') = ''admin'')
         WITH CHECK (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                     AND (auth.jwt() ->> ''app_role'') = ''admin'');',
      t || '_admin_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
         USING (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                AND (auth.jwt() ->> ''app_role'') = ''admin'');',
      t || '_admin_delete', t);
  END LOOP;
END $$;

-- ---- timesheets: scope-filtered SELECT + submitter-edits-own-drafts --------

ALTER TABLE public.timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheets FORCE  ROW LEVEL SECURITY;

-- SELECT: admin sees tenant-wide; submitter sees rows they submitted, rows
-- for their own employee record, or rows on silos in their submitter_assignments.
-- Approver visibility (runs they're eligible for) is layered on in Batch 4b via
-- a view or a refined policy — kept deliberately narrow here to avoid leaking
-- rows before the approval layer is built.
CREATE POLICY timesheets_scoped_select ON public.timesheets
  FOR SELECT TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (
      (auth.jwt() ->> 'app_role') = 'admin'
      OR submitter_user_id = (SELECT auth.uid())
      OR employee_id = (SELECT u.employee_id FROM public.users u WHERE u.id = (SELECT auth.uid()))
      OR EXISTS (
        SELECT 1 FROM public.submitter_assignments sa
        WHERE sa.user_id = (SELECT auth.uid())
          AND sa.project_id = timesheets.project_id
          AND sa.subcontractor_id = timesheets.subcontractor_id
      )
    )
  );

-- INSERT: admin always; submitter creates their own draft (or open, field-only)
-- either for themselves (self-scope via employee_id) or on a proxy silo.
CREATE POLICY timesheets_scoped_insert ON public.timesheets
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND status IN ('draft','open')
    AND (
      (auth.jwt() ->> 'app_role') = 'admin'
      OR (
        -- submitter paths: either status='open' (admin-like field pre-creation
        -- — disallow here; admin-only) or status='draft' with submitter=self.
        status = 'draft'
        AND submitter_user_id = (SELECT auth.uid())
        AND (
          employee_id = (SELECT u.employee_id FROM public.users u WHERE u.id = (SELECT auth.uid()))
          OR EXISTS (
            SELECT 1 FROM public.submitter_assignments sa
            WHERE sa.user_id = (SELECT auth.uid())
              AND sa.project_id = timesheets.project_id
              AND sa.subcontractor_id = timesheets.subcontractor_id
          )
        )
      )
    )
  );

-- UPDATE: admin always; submitter edits their own while draft/open.
CREATE POLICY timesheets_scoped_update ON public.timesheets
  FOR UPDATE TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (
      (auth.jwt() ->> 'app_role') = 'admin'
      OR (submitter_user_id = (SELECT auth.uid()) AND status IN ('draft','open'))
    )
  )
  WITH CHECK (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (
      (auth.jwt() ->> 'app_role') = 'admin'
      OR (submitter_user_id = (SELECT auth.uid()) AND status IN ('draft','open'))
    )
  );

-- DELETE: admin-only.
CREATE POLICY timesheets_admin_delete ON public.timesheets
  FOR DELETE TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'app_role') = 'admin'
  );

-- ---- timesheet_lines: inherit visibility + editability from parent ---------

ALTER TABLE public.timesheet_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_lines FORCE  ROW LEVEL SECURITY;

-- SELECT: the EXISTS subquery re-triggers timesheets' SELECT RLS, so callers
-- see lines only for timesheets they can see.
CREATE POLICY timesheet_lines_inherit_select ON public.timesheet_lines
  FOR SELECT TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND EXISTS (SELECT 1 FROM public.timesheets t WHERE t.id = timesheet_lines.timesheet_id)
  );

-- INSERT / UPDATE / DELETE: admin always; submitter may write while the parent
-- is draft/open AND the parent is visible to the caller (piggybacks on
-- timesheets' SELECT RLS via the EXISTS subquery).
CREATE POLICY timesheet_lines_inherit_insert ON public.timesheet_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND EXISTS (
      SELECT 1 FROM public.timesheets t
      WHERE t.id = timesheet_lines.timesheet_id
        AND t.status IN ('draft','open')
    )
  );

CREATE POLICY timesheet_lines_inherit_update ON public.timesheet_lines
  FOR UPDATE TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND EXISTS (
      SELECT 1 FROM public.timesheets t
      WHERE t.id = timesheet_lines.timesheet_id
        AND t.status IN ('draft','open')
    )
  )
  WITH CHECK (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND EXISTS (
      SELECT 1 FROM public.timesheets t
      WHERE t.id = timesheet_lines.timesheet_id
        AND t.status IN ('draft','open')
    )
  );

CREATE POLICY timesheet_lines_inherit_delete ON public.timesheet_lines
  FOR DELETE TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND EXISTS (
      SELECT 1 FROM public.timesheets t
      WHERE t.id = timesheet_lines.timesheet_id
        AND t.status IN ('draft','open')
    )
  );

-- ---- approval_runs / approval_actions / approval_reassignments -------------
-- Tenant-SELECT only (scope-filtering across the run graph lands in Batch 4b
-- via a composed view once the RPCs exist). No direct-PostgREST writes —
-- Batch 4b RPCs use SECURITY DEFINER to write.

ALTER TABLE public.approval_runs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_runs          FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.approval_actions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_actions       FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.approval_reassignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_reassignments FORCE  ROW LEVEL SECURITY;

CREATE POLICY approval_runs_tenant_select ON public.approval_runs
  FOR SELECT TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY approval_actions_tenant_select ON public.approval_actions
  FOR SELECT TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

CREATE POLICY approval_reassignments_tenant_select ON public.approval_reassignments
  FOR SELECT TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ---- badge_overrides: tenant-SELECT; writes via RPC ------------------------

ALTER TABLE public.badge_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badge_overrides FORCE  ROW LEVEL SECURITY;

CREATE POLICY badge_overrides_tenant_select ON public.badge_overrides
  FOR SELECT TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ---- idempotency_keys: no direct access --------------------------------------

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE  ROW LEVEL SECURITY;

-- No policies created. Revoke direct table privileges from application roles.
REVOKE ALL ON TABLE public.idempotency_keys FROM authenticated, anon, public;
