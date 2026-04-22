-- Access-token hook — spec §11.6 P0 CI gate.
-- For each representative user profile, call custom_access_token_hook with a
-- synthetic event payload and assert the returned claims are correctly shaped.
-- A deploy that mutates the hook without passing this suite is a CI gate failure.

BEGIN;
SELECT plan(14);

-- ---- Fixtures ----
INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','submitter@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pending@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','00000000-0000-0000-0000-000000000000','authenticated','authenticated','revoked@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','00000000-0000-0000-0000-000000000000','authenticated','authenticated','orphan@acme.test','x',now(),now(),now(),'','','','','','','');

INSERT INTO public.users (id, tenant_id, username, email, role, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','admin1','admin@acme.test','admin','active'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','submit1','submitter@acme.test','submitter','active'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','pending1','pending@acme.test','submitter','pending'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','11111111-1111-1111-1111-111111111111','revoked1','revoked@acme.test','submitter','revoked');
-- note: orphan intentionally has no public.users row

-- Helper: invoke the hook with a minimal event payload.
CREATE OR REPLACE FUNCTION _invoke_hook(p_user_id uuid, p_base_claims jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.custom_access_token_hook(jsonb_build_object(
    'user_id', p_user_id::text,
    'claims',  p_base_claims,
    'authentication_method', 'password'
  ));
$$;

-- ---- Profile 1: admin (active) ----
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1') -> 'claims' ->> 'tenant_id',
  '11111111-1111-1111-1111-111111111111',
  'admin hook: tenant_id injected');
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1') -> 'claims' ->> 'app_role',
  'admin',
  'admin hook: app_role is admin');

-- ---- Profile 2: submitter (active) ----
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2') -> 'claims' ->> 'tenant_id',
  '11111111-1111-1111-1111-111111111111',
  'submitter hook: tenant_id injected');
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2') -> 'claims' ->> 'app_role',
  'submitter',
  'submitter hook: app_role is submitter');

-- ---- Profile 3: pending user (not yet activated) ----
-- The hook should still inject claims — the user can sign in and call
-- finalize_self_activation. Gating by status happens at the domain layer,
-- not at JWT-mint time.
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3') -> 'claims' ->> 'tenant_id',
  '11111111-1111-1111-1111-111111111111',
  'pending hook: tenant_id injected (gating deferred to domain layer)');
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3') -> 'claims' ->> 'app_role',
  'submitter',
  'pending hook: app_role is submitter');

-- ---- Profile 4: revoked user ----
-- Status='revoked' in public.users still yields claims. Supabase Auth blocks
-- the login upstream via banned_until; the hook itself doesn't gate by status.
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4') -> 'claims' ->> 'tenant_id',
  '11111111-1111-1111-1111-111111111111',
  'revoked hook: tenant_id still injected (revoke is an auth.users-level gate)');

-- ---- Profile 5: orphan (auth.users exists but no public.users row) ----
-- §4.8 failure mode: the hook passes claims through unmodified. The absence
-- of tenant_id is caught fail-closed downstream by assert_tenant_claim_present.
SELECT ok(
  (_invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5') -> 'claims') ? 'tenant_id' = false,
  'orphan hook: tenant_id absent (no public.users row)');
SELECT ok(
  (_invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5') -> 'claims') ? 'app_role' = false,
  'orphan hook: app_role absent');

-- ---- Base claims are preserved ----
-- The hook must not clobber claims it didn't set (sub, email, etc.).
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1","email":"admin@acme.test","iss":"local"}'::jsonb
  ) -> 'claims' ->> 'sub',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'hook preserves existing sub claim');
SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1","email":"admin@acme.test","iss":"local"}'::jsonb
  ) -> 'claims' ->> 'email',
  'admin@acme.test',
  'hook preserves existing email claim');

-- ---- Return shape ----
SELECT ok(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1') ? 'claims',
  'hook response has claims key (Supabase Auth expects this shape)');

-- ---- Multi-tenant sanity: second tenant's user gets its own tenant_id ----
INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('22222222-2222-2222-2222-222222222222','Other','other','hr@other.test');
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin@other.test','x',now(),now(),now(),'','','','','','','');
INSERT INTO public.users (id, tenant_id, username, email, role, status) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','22222222-2222-2222-2222-222222222222','admin-b','admin@other.test','admin','active');

SELECT is(
  _invoke_hook('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1') -> 'claims' ->> 'tenant_id',
  '22222222-2222-2222-2222-222222222222',
  'multi-tenant: hook routes claims per user_id');

SELECT is(
  _invoke_hook('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1') -> 'claims' ->> 'tenant_id',
  '11111111-1111-1111-1111-111111111111',
  'multi-tenant: admin-A still gets tenant A (no caching across calls)');

SELECT * FROM finish();
ROLLBACK;
