-- Auth guard primitives: assert_tenant_claim_present, assert_session_live,
-- enforce_public_users_pairing_on_auth_session trigger (§4.8).
-- These are the mechanism behind the §11.6 tenant-claim-presence +
-- revocation-denylist CI gates.

BEGIN;
SELECT plan(11);

-- ---- Fixtures ----
INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test');
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','a@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','orphan@acme.test','x',now(),now(),now(),'','','','','','','');
INSERT INTO public.users (id, tenant_id, username, email, role, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','usera','a@acme.test','submitter','active');
-- 'orphan' deliberately lacks a public.users row to exercise the pairing trigger.

-- ========================================================================
-- assert_tenant_claim_present
-- ========================================================================
SELECT throws_ok(
  $$SELECT public.assert_tenant_claim_present()$$,
  'P0005', NULL,
  'assert_tenant_claim_present raises P0005 when JWT claims absent');

-- With claim present: no throw.
SELECT set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1","tenant_id":"11111111-1111-1111-1111-111111111111","app_role":"submitter","iat":1700000000}',
  true);
SELECT lives_ok(
  $$SELECT public.assert_tenant_claim_present()$$,
  'assert_tenant_claim_present passes when tenant_id claim present');

-- With claim set but empty string: should raise.
SELECT set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1","tenant_id":"","app_role":"submitter","iat":1700000000}',
  true);
SELECT throws_ok(
  $$SELECT public.assert_tenant_claim_present()$$,
  'P0005', NULL,
  'assert_tenant_claim_present raises P0005 on empty tenant_id claim');

-- ========================================================================
-- assert_session_live
-- ========================================================================

-- No iat claim -> P0006.
SELECT set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1","tenant_id":"11111111-1111-1111-1111-111111111111","app_role":"submitter"}',
  true);
SELECT throws_ok(
  $$SELECT public.assert_session_live()$$,
  'P0006', NULL,
  'assert_session_live raises P0006 when iat claim missing');

-- iat present, no revocation marker -> lives.
SELECT set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1","tenant_id":"11111111-1111-1111-1111-111111111111","app_role":"submitter","iat":1700000000}',
  true);
SELECT lives_ok(
  $$SELECT public.assert_session_live()$$,
  'assert_session_live passes when iat present and no revocation marker');

-- sessions_revoked_at set in the FUTURE relative to iat -> P0006.
UPDATE public.users SET sessions_revoked_at = now() + interval '1 day'
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
SELECT throws_ok(
  $$SELECT public.assert_session_live()$$,
  'P0006', NULL,
  'assert_session_live raises P0006 when iat predates sessions_revoked_at');

-- Clear the revoke marker (iat unchanged from test 6, still past) -> lives.
UPDATE public.users SET sessions_revoked_at = NULL
  WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
SELECT lives_ok(
  $$SELECT public.assert_session_live()$$,
  'assert_session_live passes after sessions_revoked_at is cleared');

-- ========================================================================
-- auth.sessions pairing trigger (§4.8)
-- ========================================================================

-- Insert for a user WITH a paired public.users row: lives.
SELECT lives_ok(
  $$INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
    VALUES (gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'::uuid, now(), now())$$,
  'auth.sessions INSERT lives for user with paired public.users row');

-- Insert for an orphan auth.users (no public.users): P0010.
SELECT throws_ok(
  $$INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
    VALUES (gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid, now(), now())$$,
  'P0010', NULL,
  'auth.sessions INSERT raises P0010 USER_NOT_PROVISIONED for orphan user');

-- service_role bypass branch: assert the trigger function's source contains
-- the bypass clause. Note: stock Supabase does NOT grant INSERT on auth.sessions
-- to service_role (the admin import path goes through supabase_auth_admin via
-- the Supabase Auth Admin API, not direct SQL), so we can't exercise the
-- bypass at runtime here. The branch exists as defense-in-depth per spec §4.8.
SELECT ok(
  (SELECT pg_get_functiondef(oid) LIKE '%current_user = ''service_role''%'
   FROM pg_proc WHERE proname = 'enforce_public_users_pairing_on_auth_session'),
  'pairing trigger has defensive service_role bypass branch');

-- ========================================================================
-- Revocation-denylist static gate (§11.6)
-- ----------------------------------------------------------------------
-- For the names the spec enumerates as state-mutating categories, verify
-- each such function's source contains `assert_session_live(` AND
-- `assert_tenant_claim_present(`. Today the set is empty (those RPCs land
-- in Batch 4+); the test will start enforcing as new RPCs are added.
-- ========================================================================
SELECT is(
  (SELECT count(*)::int
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND (
       p.proname ~ '^(approve|reject|reassign|override|submit|resolve|recall)_' OR
       p.proname IN ('finalize_self_activation')
     )
     AND (
       pg_get_functiondef(p.oid) NOT LIKE '%assert_session_live(%'
       OR pg_get_functiondef(p.oid) NOT LIKE '%assert_tenant_claim_present(%'
     )
  ),
  0,
  '§11.6 static gate: every state-mutating RPC calls both assert helpers');

SELECT * FROM finish();
ROLLBACK;
