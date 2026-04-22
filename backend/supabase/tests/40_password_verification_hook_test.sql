-- Password verification attempt hook — spec §4.7. Per-account lockout via
-- public.login_failure_counters. Tests exercise the hook function directly
-- with synthetic event payloads.

BEGIN;
SELECT plan(13);

-- ---- Fixtures ----
INSERT INTO public.tenants (id, name, slug, email_from_address, login_max_attempts, login_lockout_minutes) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test', 5, 15);
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','u@acme.test','x',now(),now(),now(),'','','','','','','');
INSERT INTO public.users (id, tenant_id, username, email, role, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','u','u@acme.test','submitter','active');

-- helper
CREATE OR REPLACE FUNCTION _verify(p_user_id uuid, p_valid boolean)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.password_verification_attempt_hook(jsonb_build_object(
    'user_id', p_user_id::text,
    'valid',   p_valid
  ));
$$;

-- ---- No public.users row: no opinion ----
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('ffffffff-ffff-ffff-ffff-ffffffffffff','00000000-0000-0000-0000-000000000000','authenticated','authenticated','orphan@acme.test','x',now(),now(),now(),'','','','','','','');
SELECT is(
  _verify('ffffffff-ffff-ffff-ffff-ffffffffffff', false) ->> 'decision',
  'continue',
  'orphan user (no public.users row): hook has no opinion');

-- ---- 4 failures stay below threshold ----
SELECT is(_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', false) ->> 'decision', 'continue', 'failure #1: continue');
SELECT is(_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', false) ->> 'decision', 'continue', 'failure #2: continue');
SELECT is(_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', false) ->> 'decision', 'continue', 'failure #3: continue');
SELECT is(_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', false) ->> 'decision', 'continue', 'failure #4: continue');

-- 5th failure trips the limit (http_code=429).
SELECT is(
  (_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', false) -> 'error' ->> 'http_code')::int,
  429,
  'failure #5: error http_code=429 (lockout tripped)');

-- Correct-password-while-locked STILL rejects (credential-stuffing defense).
SELECT is(
  (_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true) -> 'error' ->> 'http_code')::int,
  429,
  'correct password during lockout window: still 429');

-- ---- admin unlock resets the window ----
-- Test-env note: pgTAP wraps the suite in one transaction, so now() is
-- identical across statements. Real Auth hook calls are in distinct
-- transactions with monotonically advancing clocks. To simulate that here,
-- set the unlock marker's unlocked_at 1 minute in the "future" relative to
-- the counter's first_failed_at (which was set at transaction start via
-- the hook's own now()-based default).
INSERT INTO public.user_unlock_markers (tenant_id, user_id, unlocked_at) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
   now() + interval '1 minute');

-- After unlock: a valid attempt should succeed (counter is stale).
SELECT is(
  _verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', true) ->> 'decision',
  'continue',
  'after unlock: valid attempt returns continue');

-- Successful login cleared the counter.
SELECT is((SELECT count(*)::int FROM public.login_failure_counters WHERE user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'), 0,
  'counter cleared after successful login');

-- ---- Failures after unlock count from fresh (1-min-future unlock still dominates window) ----
SELECT is(_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', false) ->> 'decision', 'continue', 'post-unlock failure #1: continue (fresh window)');
SELECT is(_verify('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', false) ->> 'decision', 'continue', 'post-unlock failure #2: continue');

-- Per-tenant config respected. Use a FRESH user (no prior counter or unlock
-- markers) to isolate the tenant_max=2 threshold from the earlier test state.
UPDATE public.tenants SET login_max_attempts = 2 WHERE id = '11111111-1111-1111-1111-111111111111';
INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','00000000-0000-0000-0000-000000000000','authenticated','authenticated','fresh@acme.test','x',now(),now(),now(),'','','','','','','');
INSERT INTO public.users (id, tenant_id, username, email, role, status) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','11111111-1111-1111-1111-111111111111','fresh','fresh@acme.test','submitter','active');
SELECT is(_verify('dddddddd-dddd-dddd-dddd-dddddddddddd', false) ->> 'decision', 'continue',
  'tenant_max=2 (fresh user): failure #1 continues');
SELECT is(
  (_verify('dddddddd-dddd-dddd-dddd-dddddddddddd', false) -> 'error' ->> 'http_code')::int,
  429,
  'tenant_max=2 (fresh user): failure #2 trips 429');

SELECT * FROM finish();
ROLLBACK;
