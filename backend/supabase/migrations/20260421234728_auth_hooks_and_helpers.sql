-- ============================================================================
-- Auth hooks + assert helpers + finalize_self_activation RPC (Batch 2a)
-- ----------------------------------------------------------------------------
-- Implements:
--   * assert_tenant_claim_present()           §4.8 — JWT sanity gate for mutating RPCs.
--   * assert_session_live()                   §4.2 — revocation denylist check.
--   * finalize_self_activation()              §4.3 step 4 — pending → active on first login.
--   * custom_access_token_hook(event jsonb)   §4.2 — injects tenant_id + app_role claims.
--   * password_verification_attempt_hook(event jsonb)  §4.7 — per-account lockout.
--   * public.login_failure_counters           backing state for the lockout hook.
--
-- ----------------------------------------------------------------------------
-- Spec deviation worth flagging (§4.7):
-- Spec §4.7 says the lockout hook "counts login_failure entries in
-- auth.audit_log_entries". That table's payload is an unstructured json blob
-- whose schema Supabase does not contractually stabilize. Following Supabase's
-- documented Password Verification Attempt hook pattern (which receives
-- `valid: boolean` as input), we instead maintain our own per-user failure
-- counter in public.login_failure_counters. Semantically equivalent (same
-- window, same max_attempts, same reset-on-unlock behavior), contract-stable,
-- and cheaper at read time (indexed single-row lookup vs audit-log scan).
-- ============================================================================

-- ============================================================================
-- Assert helpers (§4.2, §4.8)
-- ----------------------------------------------------------------------------
-- Called at the top of every state-mutating RPC and Edge Function inner
-- handler. SECURITY INVOKER — they read auth.jwt() and go through RLS on
-- public.users like the caller would.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assert_tenant_claim_present()
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_tenant_claim text;
BEGIN
  v_tenant_claim := auth.jwt() ->> 'tenant_id';
  IF v_tenant_claim IS NULL OR v_tenant_claim = '' THEN
    -- P0005 — mapped to HTTP 403 by PostgREST per spec §8 error table.
    RAISE EXCEPTION USING
      ERRCODE = 'P0005',
      MESSAGE = 'TENANT_CLAIM_MISSING',
      DETAIL  = 'JWT does not carry tenant_id. Custom access-token hook may be disabled or misconfigured.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_tenant_claim_present() IS
  'Spec §4.8 — raises P0005 TENANT_CLAIM_MISSING when the JWT tenant claim is absent. Call at the top of every state-mutating RPC.';

CREATE OR REPLACE FUNCTION public.assert_session_live()
RETURNS void
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_iat_epoch  bigint;
  v_iat_ts     timestamptz;
  v_revoked_at timestamptz;
BEGIN
  v_iat_epoch := (auth.jwt() ->> 'iat')::bigint;
  IF v_iat_epoch IS NULL THEN
    -- Missing `iat` claim — token was minted without passing through our custom
    -- access-token hook. Treat as a revoked session (fail-closed).
    RAISE EXCEPTION USING
      ERRCODE = 'P0006',
      MESSAGE = 'SESSION_REVOKED',
      DETAIL  = 'JWT is missing the iat claim.';
  END IF;
  v_iat_ts := to_timestamp(v_iat_epoch);

  -- Read the caller's revocation marker. Goes through RLS; users_self_update
  -- isn't relevant (this is SELECT), users_tenant_select allows reading one's
  -- own row when the tenant claim matches. If the tenant claim is missing,
  -- this returns NULL and we treat it as "no revocation" — but in that case
  -- assert_tenant_claim_present() should have fired first.
  SELECT sessions_revoked_at
    INTO v_revoked_at
    FROM public.users
    WHERE id = (SELECT auth.uid());

  IF v_revoked_at IS NOT NULL AND v_iat_ts < v_revoked_at THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0006',
      MESSAGE = 'SESSION_REVOKED',
      DETAIL  = 'Token issued before session revocation marker.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_session_live() IS
  'Spec §4.2 — raises P0006 SESSION_REVOKED when the JWT iat predates public.users.sessions_revoked_at for the caller. Call at the top of every state-mutating RPC.';

GRANT EXECUTE ON FUNCTION public.assert_tenant_claim_present() TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_session_live()          TO authenticated;

-- ============================================================================
-- finalize_self_activation RPC (§4.3 step 4)
-- ----------------------------------------------------------------------------
-- Flips the caller's public.users.status from pending → active after they
-- complete password setup via the Supabase invite flow. Idempotent: a caller
-- already in `active` state is a no-op success; a caller in `revoked` is an
-- explicit error.
--
-- SECURITY INVOKER so the UPDATE flows through the users_self_update RLS
-- policy. The returned JSON is the activation result, useful for the client
-- to confirm the transition happened.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.finalize_self_activation()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_user_id      uuid := (SELECT auth.uid());
  v_old_status   public.user_status;
  v_new_status   public.user_status;
  v_tenant_id    uuid;
BEGIN
  -- Gate 1: JWT must carry the tenant claim (custom access-token hook live).
  PERFORM public.assert_tenant_claim_present();
  -- Gate 2: session must post-date any revocation marker.
  PERFORM public.assert_session_live();

  -- Fetch current state. RLS restricts this to the caller's own row.
  SELECT status, tenant_id INTO v_old_status, v_tenant_id
    FROM public.users
    WHERE id = v_user_id;

  IF NOT FOUND THEN
    -- No public.users row for an authenticated caller — indicates an auth.users
    -- row was created outside our invite flow (should never happen in normal
    -- operation; a BEFORE INSERT trigger on auth.sessions enforces this in Batch 3).
    RAISE EXCEPTION USING
      ERRCODE = 'P0008',
      MESSAGE = 'USER_NOT_PROVISIONED',
      DETAIL  = 'Authenticated caller has no matching public.users row.';
  END IF;

  IF v_old_status = 'revoked' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0009',
      MESSAGE = 'USER_REVOKED',
      DETAIL  = 'Revoked users cannot self-activate.';
  END IF;

  IF v_old_status = 'active' THEN
    -- Idempotent no-op.
    RETURN jsonb_build_object('status', 'active', 'already_active', true);
  END IF;

  -- pending → active.
  UPDATE public.users SET status = 'active' WHERE id = v_user_id;
  v_new_status := 'active';

  INSERT INTO public.audit_events (tenant_id, actor_user_id, action_type, subject_type, subject_id, details)
  VALUES (v_tenant_id, v_user_id, 'user.self_activate', 'user', v_user_id,
          jsonb_build_object('from', v_old_status::text, 'to', v_new_status::text));

  RETURN jsonb_build_object('status', v_new_status::text, 'already_active', false);
END;
$$;

COMMENT ON FUNCTION public.finalize_self_activation() IS
  'Spec §4.3 step 4 — promotes caller from pending to active after password setup. Idempotent on re-call. RLS-bounded to the caller''s own row.';

GRANT EXECUTE ON FUNCTION public.finalize_self_activation() TO authenticated;

-- ----------------------------------------------------------------------------
-- audit_events INSERT policy (self-attributed rows only)
-- ----------------------------------------------------------------------------
-- Authenticated callers (via invoker-rights RPCs like finalize_self_activation)
-- may insert audit rows where:
--   * tenant_id matches their JWT tenant claim, AND
--   * actor_user_id is themselves (can't forge rows attributing actions to others).
-- Admin-bypass audit writes (e.g. "admin revoked user Y") go through service-role
-- Edge Functions which bypass RLS entirely.
-- ----------------------------------------------------------------------------
CREATE POLICY audit_events_self_insert
  ON public.audit_events
  FOR INSERT
  TO authenticated
  WITH CHECK (
        tenant_id     = (auth.jwt() ->> 'tenant_id')::uuid
    AND actor_user_id = (SELECT auth.uid())
  );

-- ============================================================================
-- login_failure_counters — backing state for the lockout hook (§4.7)
-- ----------------------------------------------------------------------------
-- One row per user_id with an active failure window. Reset by (a) successful
-- sign-in, (b) an admin unlock marker newer than first_failed_at, or (c) the
-- window (tenants.login_lockout_minutes) expiring naturally since
-- first_failed_at.
--
-- No RLS policies — access is admin-role-only via explicit grants below.
-- Not intended to be exposed via PostgREST.
-- ============================================================================

CREATE TABLE public.login_failure_counters (
  user_id          uuid        PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  failure_count    integer     NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  first_failed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.login_failure_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_failure_counters FORCE  ROW LEVEL SECURITY;
-- No policies — authenticated callers cannot read or write. Supabase Auth
-- accesses via SECURITY DEFINER hook functions; admins bypass via service_role
-- when needed.

REVOKE ALL ON TABLE public.login_failure_counters FROM authenticated, anon, public;

-- ============================================================================
-- custom_access_token hook (§4.2)
-- ----------------------------------------------------------------------------
-- Reads the authenticating user's public.users row, injects tenant_id and
-- app_role into the JWT claims. Runs as the supabase_auth_admin role when
-- Supabase mints / refreshes a token. SECURITY DEFINER + search_path lockdown
-- so the function can SELECT from public.* regardless of caller grants.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id   uuid   := (event->>'user_id')::uuid;
  v_claims    jsonb  := COALESCE(event->'claims', '{}'::jsonb);
  v_tenant_id uuid;
  v_role      public.user_role;
BEGIN
  SELECT tenant_id, role
    INTO v_tenant_id, v_role
    FROM public.users
    WHERE id = v_user_id;

  IF v_tenant_id IS NOT NULL THEN
    v_claims := jsonb_set(v_claims, '{tenant_id}', to_jsonb(v_tenant_id::text));
    v_claims := jsonb_set(v_claims, '{app_role}',  to_jsonb(v_role::text));
  END IF;
  -- If no public.users row: claims are passed through unmodified. The absence
  -- of tenant_id is caught fail-closed at the next state-mutating call via
  -- assert_tenant_claim_present() — see §4.8.

  RETURN jsonb_build_object('claims', v_claims);
END;
$$;

COMMENT ON FUNCTION public.custom_access_token_hook(jsonb) IS
  'Spec §4.2 — Supabase Auth custom access-token hook. Injects tenant_id and app_role claims from public.users at token mint time.';

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM authenticated, anon, public;

-- ============================================================================
-- password_verification_attempt hook (§4.7)
-- ----------------------------------------------------------------------------
-- Per-account lockout. See top-of-file note on the counter-table approach.
--
-- Logic:
--   * Look up caller's tenant config (login_max_attempts, login_lockout_minutes).
--     If no public.users row, no opinion — return continue.
--   * On successful verification (valid=true): delete counter, allow.
--   * On failed verification (valid=false):
--       - Compute window_start = max(latest_unlock_marker, now() - lockout_minutes).
--       - Upsert counter: reset to 1 if current first_failed_at pre-dates window,
--         otherwise increment.
--       - If resulting count >= max_attempts, return HTTP 429 error.
--       - Otherwise allow the normal "invalid credentials" response to flow.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.password_verification_attempt_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id           uuid    := (event->>'user_id')::uuid;
  v_valid             boolean := (event->>'valid')::boolean;
  v_max_attempts      integer;
  v_lockout_minutes   integer;
  v_latest_unlock     timestamptz;
  v_window_start      timestamptz;
  v_count             integer;
  v_existing_count    integer;
  v_existing_started  timestamptz;
  v_lockout_response  jsonb;
BEGIN
  -- 1. Resolve tenant config for this user. If they aren't in public.users yet
  --    (pre-activation race, or auth.users-only edge case), no opinion.
  SELECT t.login_max_attempts, t.login_lockout_minutes
    INTO v_max_attempts, v_lockout_minutes
    FROM public.users u
    JOIN public.tenants t ON t.id = u.tenant_id
    WHERE u.id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('decision', 'continue');
  END IF;

  -- 2. Compute effective window start:
  --    max(latest unlock marker, now() - lockout window).
  SELECT MAX(unlocked_at) INTO v_latest_unlock
    FROM public.user_unlock_markers
    WHERE user_id = v_user_id;

  v_window_start := GREATEST(
    COALESCE(v_latest_unlock, '-infinity'::timestamptz),
    now() - make_interval(mins => v_lockout_minutes)
  );

  -- 3. Lockout-precedence check: if the EXISTING counter shows an active lockout
  --    (count >= max AND first_failed_at within the effective window), reject
  --    regardless of whether this attempt's password is valid. This is the spec
  --    §4.7 credential-stuffing defense — a correct password presented during
  --    the window must not bypass the lockout.
  SELECT failure_count, first_failed_at
    INTO v_existing_count, v_existing_started
    FROM public.login_failure_counters
    WHERE user_id = v_user_id;

  v_lockout_response := jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 429,
      'message', 'Account temporarily locked. Too many failed sign-in attempts. Contact an administrator or wait for the lockout window to expire.'
    )
  );

  IF v_existing_count IS NOT NULL
     AND v_existing_count >= v_max_attempts
     AND v_existing_started >= v_window_start THEN
    RETURN v_lockout_response;
  END IF;

  -- 4. Not currently locked. On a valid password, clear the counter and allow.
  IF v_valid THEN
    DELETE FROM public.login_failure_counters WHERE user_id = v_user_id;
    RETURN jsonb_build_object('decision', 'continue');
  END IF;

  -- 5. Not currently locked, password invalid — record the failure. Reset the
  --    counter to 1 if the prior window has elapsed / been unlocked.
  INSERT INTO public.login_failure_counters (user_id, failure_count, first_failed_at, updated_at)
  VALUES (v_user_id, 1, now(), now())
  ON CONFLICT (user_id) DO UPDATE
    SET failure_count = CASE
          WHEN public.login_failure_counters.first_failed_at < v_window_start THEN 1
          ELSE public.login_failure_counters.failure_count + 1
        END,
        first_failed_at = CASE
          WHEN public.login_failure_counters.first_failed_at < v_window_start THEN now()
          ELSE public.login_failure_counters.first_failed_at
        END,
        updated_at = now()
  RETURNING failure_count INTO v_count;

  -- 6. If THIS failure tipped the limit, 429 immediately. Otherwise let
  --    Supabase's default "invalid credentials" response flow.
  IF v_count >= v_max_attempts THEN
    RETURN v_lockout_response;
  END IF;

  RETURN jsonb_build_object('decision', 'continue');
END;
$$;

COMMENT ON FUNCTION public.password_verification_attempt_hook(jsonb) IS
  'Spec §4.7 — Supabase Auth password verification hook. Enforces per-account lockout (default 5 failures per 15-minute window, tenant-configurable).';

-- Grants for the Auth-invoked hook functions + their state.
GRANT EXECUTE ON FUNCTION public.password_verification_attempt_hook(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.password_verification_attempt_hook(jsonb) FROM authenticated, anon, public;

GRANT SELECT          ON TABLE public.users                TO supabase_auth_admin;
GRANT SELECT          ON TABLE public.tenants              TO supabase_auth_admin;
GRANT SELECT          ON TABLE public.user_unlock_markers  TO supabase_auth_admin;
GRANT SELECT, INSERT, UPDATE, DELETE
                      ON TABLE public.login_failure_counters TO supabase_auth_admin;
