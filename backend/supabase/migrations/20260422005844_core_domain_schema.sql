-- ============================================================================
-- Core domain schema (Batch 3a) — spec §6.2–§6.5 + §4.8 pairing trigger
-- ----------------------------------------------------------------------------
-- Lands the tenant-scoped reference/domain tables that downstream batches
-- (timesheets, approval flow, notifications) will build on. Every table uses
-- the standard RLS template: SELECT for authenticated members of the tenant,
-- INSERT/UPDATE/DELETE for admins of the tenant only. Service-role bypass
-- (used by admin Edge Functions and import tooling in Batch 3b+) skips RLS
-- entirely and handles audit writes in the caller.
--
-- Also in this migration (since it completes the Batch-1 deferred FK and the
-- Batch-2 deferred pairing trigger):
--   * public.users.employee_id now FK'd to public.employees(id).
--   * BEFORE INSERT trigger on auth.sessions enforcing a paired public.users
--     row (spec §4.8 — fail-closed on orphan auth.users). Bypassed under
--     service_role for admin batch-import paths.
-- ============================================================================

-- ============================================================================
-- Enums
-- ============================================================================

-- §6.2: "type ∈ {field, staff}".
CREATE TYPE public.employee_type AS ENUM ('field', 'staff');

-- ============================================================================
-- public.subcontractors (§6.3)
-- ----------------------------------------------------------------------------
-- Referenced from employees (current employer) and project_subcontractors
-- (silo membership). "Invenio" (the prime) is inserted as a subcontractor
-- row during tenant provisioning — treated identically to any other sub by
-- the approval routing; no special-case.
-- ============================================================================

CREATE TABLE public.subcontractors (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  name        text        NOT NULL,
  short_code  text        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, short_code)
);

CREATE INDEX subcontractors_tenant_idx ON public.subcontractors (tenant_id);

-- ============================================================================
-- public.employees (§6.2)
-- ----------------------------------------------------------------------------
-- Every employee has a current subcontractor_id; historical transitions land
-- in employee_subcontractor_history.
-- ============================================================================

CREATE TABLE public.employees (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  external_id        text        NULL,     -- original 'E001' etc. preserved for migration imports
  first_name         text        NOT NULL,
  last_name          text        NOT NULL,
  type               public.employee_type NOT NULL,
  craft              text        NULL,
  active             boolean     NOT NULL DEFAULT true,
  subcontractor_id   uuid        NOT NULL REFERENCES public.subcontractors(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

CREATE INDEX employees_tenant_idx               ON public.employees (tenant_id);
CREATE INDEX employees_tenant_subcontractor_idx ON public.employees (tenant_id, subcontractor_id);
CREATE INDEX employees_tenant_active_idx        ON public.employees (tenant_id, active);

-- ----------------------------------------------------------------------------
-- public.users.employee_id FK backfill (Batch 1 deferred item)
-- ----------------------------------------------------------------------------
ALTER TABLE public.users
  ADD CONSTRAINT users_employee_id_fkey
  FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT;

-- ============================================================================
-- public.employee_subcontractor_history (§6.2)
-- ----------------------------------------------------------------------------
-- Append-only log of an employee's subcontractor moves. Each row captures a
-- time span; the OPEN span (ended_at IS NULL) matches employees.subcontractor_id.
-- Backend invariant (not enforced here; belongs to the transition RPC in a
-- later batch): exactly one open span per employee at any moment.
-- ============================================================================

CREATE TABLE public.employee_subcontractor_history (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  employee_id       uuid        NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  subcontractor_id  uuid        NOT NULL REFERENCES public.subcontractors(id) ON DELETE RESTRICT,
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz NULL,
  CHECK (ended_at IS NULL OR ended_at > started_at)
);

CREATE INDEX esh_employee_started_idx
  ON public.employee_subcontractor_history (employee_id, started_at DESC);
CREATE INDEX esh_tenant_subcontractor_idx
  ON public.employee_subcontractor_history (tenant_id, subcontractor_id);

-- ============================================================================
-- public.projects (§6.4)
-- ============================================================================

CREATE TABLE public.projects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  number      text        NOT NULL,
  name        text        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE INDEX projects_tenant_idx        ON public.projects (tenant_id);
CREATE INDEX projects_tenant_active_idx ON public.projects (tenant_id, active);

-- ============================================================================
-- public.areas (§6.4)
-- ============================================================================

CREATE TABLE public.areas (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  project_id  uuid        NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  code        text        NOT NULL,
  name        text        NOT NULL,
  UNIQUE (tenant_id, project_id, code)
);

CREATE INDEX areas_tenant_project_idx ON public.areas (tenant_id, project_id);

-- ============================================================================
-- public.project_subcontractors (§6.4)
-- ----------------------------------------------------------------------------
-- Time-bounded engagement between a project and a subcontractor. Multiple
-- historical rows per (project, subcontractor) are allowed — the silo can
-- come and go. The unique key enforces one row per start date.
-- ============================================================================

CREATE TABLE public.project_subcontractors (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  project_id        uuid        NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
  subcontractor_id  uuid        NOT NULL REFERENCES public.subcontractors(id) ON DELETE RESTRICT,
  start_date        date        NOT NULL,
  end_date          date        NULL,
  CHECK (end_date IS NULL OR end_date >= start_date),
  UNIQUE (tenant_id, project_id, subcontractor_id, start_date)
);

CREATE INDEX project_subcontractors_tenant_project_sub_idx
  ON public.project_subcontractors (tenant_id, project_id, subcontractor_id);
-- Quick "who's engaged on this project right now?" lookup.
CREATE INDEX project_subcontractors_open_idx
  ON public.project_subcontractors (tenant_id, project_id)
  WHERE end_date IS NULL;

-- ============================================================================
-- public.task_codes / cwps / fcos (§6.5) — reference data
-- ============================================================================

CREATE TABLE public.task_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  code        text        NOT NULL,
  name        text        NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX task_codes_tenant_idx ON public.task_codes (tenant_id);

CREATE TABLE public.cwps (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  code         text        NOT NULL,
  description  text        NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX cwps_tenant_idx ON public.cwps (tenant_id);

CREATE TABLE public.fcos (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  code         text        NOT NULL,
  description  text        NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX fcos_tenant_idx ON public.fcos (tenant_id);

-- ============================================================================
-- Row-Level Security
-- ----------------------------------------------------------------------------
-- Standard template: SELECT for tenant members; INSERT/UPDATE/DELETE for
-- tenant admins. Service-role bypasses RLS — admin Edge Functions using
-- service-role-bypass clients still MUST scope their writes by the
-- withAdminContext-verified tenant_id (not from request payload).
-- ============================================================================

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'subcontractors',
    'employees',
    'employee_subcontractor_history',
    'projects',
    'areas',
    'project_subcontractors',
    'task_codes',
    'cwps',
    'fcos'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY;', t);

    -- Tenant-scoped SELECT.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         FOR SELECT TO authenticated
         USING (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid);',
      t || '_tenant_select', t
    );

    -- Admin-only write policies (INSERT / UPDATE / DELETE). Keeping them as
    -- three separate policies mirrors the spec §3 "one per write verb" phrasing
    -- and lets future migrations loosen a single verb without rewriting the
    -- whole thing.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         FOR INSERT TO authenticated
         WITH CHECK (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                     AND (auth.jwt() ->> ''app_role'') = ''admin'');',
      t || '_admin_insert', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         FOR UPDATE TO authenticated
         USING      (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                     AND (auth.jwt() ->> ''app_role'') = ''admin'')
         WITH CHECK (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                     AND (auth.jwt() ->> ''app_role'') = ''admin'');',
      t || '_admin_update', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I
         FOR DELETE TO authenticated
         USING (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid
                AND (auth.jwt() ->> ''app_role'') = ''admin'');',
      t || '_admin_delete', t
    );
  END LOOP;
END $$;

-- ============================================================================
-- auth.sessions BEFORE INSERT trigger (§4.8 mitigation)
-- ----------------------------------------------------------------------------
-- Enforces the "every auth.users row has a paired public.users row at
-- first-session time" invariant. Fail-closed on orphan — better than
-- silently admitting a user whose JWT lacks tenant_id because no public.users
-- row exists for the access-token hook to read from.
--
-- Bypass: admin bulk imports running under service_role can insert auth.sessions
-- out of order (the import scripts are expected to insert public.users first,
-- but the trigger doesn't enforce order to avoid breaking legitimate batch
-- flows).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_public_users_pairing_on_auth_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = NEW.user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0010',
      MESSAGE = 'USER_NOT_PROVISIONED',
      DETAIL  = format(
        'auth.sessions insert for auth.users.id=%s has no matching public.users row. Admin must complete provisioning (invite flow) before sign-in.',
        NEW.user_id
      );
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_public_users_pairing_on_auth_session() IS
  'Spec §4.8 — fail-closed trigger preventing auth.sessions rows for users lacking a paired public.users row. Bypassed under service_role for admin batch imports.';

CREATE TRIGGER enforce_public_users_pairing_on_auth_session
  BEFORE INSERT ON auth.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_public_users_pairing_on_auth_session();
