-- ============================================================================
-- Init migration: tenancy + users + unlock markers + audit events
-- ----------------------------------------------------------------------------
-- Implements the schema in docs/backend-spec.md §6.1 (v0.4.2), minus the
-- auth-owned tables (subsumed by Supabase Auth per §4). RLS policies read
-- tenancy from the JWT claim injected by the custom access-token hook in
-- Batch 2 (`auth.jwt() ->> 'tenant_id'` / `auth.jwt() ->> 'app_role'`).
--
-- Batch 1 scope:
--   * Enums: user_role, user_status
--   * Tables: public.tenants, public.users, public.user_unlock_markers,
--             public.audit_events
--   * RLS + baseline policies keyed off auth.jwt() claims
--
-- Deferred to Batch 2:
--   * custom_access_token hook (JWT claim injection)
--   * before_login hook (per-account lockout via §4.7)
--   * finalize_self_activation RPC (§4.3 step 4)
--   * assert_session_live / assert_tenant_claim_present helper fns (§4.2, §4.8)
--
-- Deferred to Batch 3 (core domain CRUD):
--   * public.users.employee_id FK to employees(id) — employees table not yet created.
-- ============================================================================

-- ============================================================================
-- Enums
-- ============================================================================

-- Two roles only in v1 (§5). "approver" is NOT a role — it is a capability
-- derived from assignment tables (silo_role_assignments, project_role_assignments,
-- approval_node_approvers). See spec §5 for the rationale.
CREATE TYPE public.user_role AS ENUM ('admin', 'submitter');

-- pending: invited, has not yet completed password setup + finalize_self_activation RPC.
-- active:  fully provisioned and usable.
-- revoked: soft-deleted; retained for FK/attribution of historical approval actions (§4.6).
CREATE TYPE public.user_status AS ENUM ('pending', 'active', 'revoked');

-- ============================================================================
-- tenants
-- ----------------------------------------------------------------------------
-- Global directory table — each row IS a tenant. Not tenant-scoped itself.
-- Session-lifetime knobs (access-token TTL, refresh-token TTL) are Supabase
-- project-level, not per-tenant — see spec §4.2. Only per-account-lockout
-- knobs are per-tenant (§4.7).
-- ============================================================================

CREATE TABLE public.tenants (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text        NOT NULL,
  slug                        text        NOT NULL,
  status                      text        NOT NULL DEFAULT 'active'
                                            CHECK (status IN ('active', 'suspended')),
  timezone                    text        NOT NULL DEFAULT 'UTC',
  locale                      text        NOT NULL DEFAULT 'en-US',
  email_from_address          text        NOT NULL,
  webhook_url                 text        NULL,
  webhook_signing_secret_ref  text        NULL,        -- pointer to Supabase Vault key, not the raw secret (§3 table)
  stall_hours                 integer     NOT NULL DEFAULT 48,
  login_max_attempts          integer     NOT NULL DEFAULT 5   CHECK (login_max_attempts  > 0),  -- §4.7
  login_lockout_minutes       integer     NOT NULL DEFAULT 15  CHECK (login_lockout_minutes > 0), -- §4.7
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tenants_slug_key ON public.tenants (slug);

-- ============================================================================
-- public.users
-- ----------------------------------------------------------------------------
-- 1:1 linked to auth.users. Supabase Auth owns credentials + lifecycle; this
-- row carries tenant membership, app role, and domain state. See §6.1.
-- ============================================================================

CREATE TABLE public.users (
  id                   uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  username             text        NOT NULL,
  email                text        NOT NULL,   -- denormalized mirror of auth.users.email for RLS/readability
  role                 public.user_role   NOT NULL,
  employee_id          uuid        NULL,       -- FK to employees(id) added in Batch 3 (core domain CRUD)
  status               public.user_status NOT NULL DEFAULT 'pending',
  sessions_revoked_at  timestamptz NULL,       -- revocation denylist marker; compared against JWT `iat` in §4.2
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, username),
  UNIQUE (tenant_id, email)
);

CREATE INDEX users_tenant_id_idx ON public.users (tenant_id);

-- ============================================================================
-- public.user_unlock_markers
-- ----------------------------------------------------------------------------
-- Inserted by the admin unlock Edge Function (§4.7). The before-login hook
-- reads the latest marker per user and only counts auth.audit_log_entries
-- failures after that timestamp — resetting the lockout window on unlock
-- without mutating Supabase-owned auth.users state.
-- ============================================================================

CREATE TABLE public.user_unlock_markers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  user_id     uuid        NOT NULL REFERENCES public.users(id)   ON DELETE CASCADE,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  unlocked_by uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL
);

-- Hot path for the before-login hook: "latest unlock for this user".
CREATE INDEX user_unlock_markers_user_unlocked_at_idx
  ON public.user_unlock_markers (user_id, unlocked_at DESC);

-- ============================================================================
-- public.audit_events
-- ----------------------------------------------------------------------------
-- Domain audit log. Written by plpgsql RPCs and Edge Functions for actions
-- OTHER than approval-subsystem events (which have their own dedicated tables:
-- approval_actions, approval_reassignments — added in Batch 3). See §4.7, §6.1.
-- Append-only: no UPDATE/DELETE policies.
-- ============================================================================

CREATE TABLE public.audit_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  actor_user_id   uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  action_type     text        NOT NULL,     -- e.g. 'user.revoke', 'user.restore', 'user.unlock', 'flow.create'
  subject_type    text        NULL,         -- e.g. 'user', 'flow', 'project'
  subject_id      uuid        NULL,
  ts              timestamptz NOT NULL DEFAULT now(),
  details         jsonb       NULL
);

CREATE INDEX audit_events_tenant_ts_idx
  ON public.audit_events (tenant_id, ts DESC);
CREATE INDEX audit_events_tenant_actor_ts_idx
  ON public.audit_events (tenant_id, actor_user_id, ts DESC);
CREATE INDEX audit_events_tenant_subject_ts_idx
  ON public.audit_events (tenant_id, subject_type, subject_id, ts DESC);

-- ============================================================================
-- Row-Level Security
-- ----------------------------------------------------------------------------
-- Primary isolation mechanism (spec §3). All policies read tenancy from the
-- JWT claim injected by the custom access-token hook (Batch 2). Until that
-- hook is deployed, authenticated clients' JWTs will NOT carry the `tenant_id`
-- claim, so `(auth.jwt() ->> 'tenant_id')::uuid` yields NULL, `NULL = anything`
-- is false, and authenticated reads return zero rows. This is the desired
-- fail-closed behavior — §4.8 "hook returns a token missing tenant_id".
--
-- Service-role key bypasses RLS entirely — used only inside withAdminContext
-- (Batch 2) and in provisioning / migration Edge Functions.
-- ============================================================================

ALTER TABLE public.tenants             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants             FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users               FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.user_unlock_markers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_unlock_markers FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.audit_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events        FORCE  ROW LEVEL SECURITY;

-- ---- tenants --------------------------------------------------------------
-- Read own tenant's directory row (needed for displaying tenant name/slug,
-- reading tenant-level config). Writes go through provision-tenant /
-- admin Edge Functions under service-role (bypasses RLS).
CREATE POLICY tenants_self_select
  ON public.tenants
  FOR SELECT
  TO authenticated
  USING (id = (auth.jwt() ->> 'tenant_id')::uuid);

-- ---- public.users ---------------------------------------------------------
-- Tenant-scoped SELECT.
CREATE POLICY users_tenant_select
  ON public.users
  FOR SELECT
  TO authenticated
  USING (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- Self-UPDATE — narrow to caller's own row only. Used by
-- finalize_self_activation RPC (Batch 2). Broader admin user-management
-- (invite, revoke, restore, change-role, unlock) runs via Edge Functions
-- under service-role.
--
-- Note: `auth.uid()` is Supabase's helper returning the caller's auth.users.id.
CREATE POLICY users_self_update
  ON public.users
  FOR UPDATE
  TO authenticated
  USING      (id = (SELECT auth.uid()) AND tenant_id = (auth.jwt() ->> 'tenant_id')::uuid)
  WITH CHECK (id = (SELECT auth.uid()) AND tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- No INSERT/DELETE policies for authenticated users — those paths are
-- admin-bypass only (Edge Functions with service-role key).

-- ---- public.user_unlock_markers -------------------------------------------
-- Admin-only read for the audit UI. Writes happen inside the unlock Edge
-- Function under service-role. The before-login hook (Batch 2) reads via
-- SECURITY DEFINER, also bypassing RLS.
CREATE POLICY user_unlock_markers_admin_select
  ON public.user_unlock_markers
  FOR SELECT
  TO authenticated
  USING (
        tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'app_role') = 'admin'
  );

-- ---- public.audit_events --------------------------------------------------
-- Admin-only read for the audit UI. No UPDATE/DELETE (append-only).
-- Inserts happen inside plpgsql RPCs / Edge Functions under service-role
-- or via SECURITY DEFINER helpers in Batch 2+.
CREATE POLICY audit_events_admin_select
  ON public.audit_events
  FOR SELECT
  TO authenticated
  USING (
        tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'app_role') = 'admin'
  );
