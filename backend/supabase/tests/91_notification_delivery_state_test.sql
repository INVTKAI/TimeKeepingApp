-- Notification delivery state machine (Batch 5b) — spec §7.6.
-- Exercises the three service-role-only RPCs directly; no mock HTTP.
-- Real delivery (Resend + HMAC webhooks + pg_cron) lands in 5c.
--
-- State transitions covered:
--   pending → sending                       via _claim_pending_notifications
--   sending → sent                          via _record_notification_success
--   sending → pending (attempts < max)      via _record_notification_failure
--   sending → failed  (attempts >= max)     via _record_notification_failure
--                                           (+ row in notification_failures)

BEGIN;
SELECT plan(15);

-- ---- Fixtures -------------------------------------------------------------

INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','r1@acme.test','x',now(),now(),now(),'','','','','','','');
INSERT INTO public.users (id, tenant_id, username, email, role, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','adm','adm@acme.test','admin','active'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','r1','r1@acme.test','submitter','active');

-- Seed three pending outbox rows manually (no need for a real run / timesheet
-- here — we're testing the state machine, not enqueue).
INSERT INTO public.notification_outbox (id, tenant_id, event_type, recipient_user_id, role_context, payload) VALUES
  ('aaaaaaaa-0000-7777-0000-00000000000a','11111111-1111-1111-1111-111111111111','submitted',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter',
   jsonb_build_object('seq', 1)),
  ('aaaaaaaa-0000-7777-0000-00000000000b','11111111-1111-1111-1111-111111111111','rejected',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter',
   jsonb_build_object('seq', 2)),
  ('aaaaaaaa-0000-7777-0000-00000000000c','11111111-1111-1111-1111-111111111111','approved',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter',
   jsonb_build_object('seq', 3));

-- ============================================================================
-- _claim_pending_notifications: transitions pending → sending, bumps attempts
-- ============================================================================

SELECT is(
  (SELECT count(*)::int FROM public._claim_pending_notifications(2)),
  2,
  'claim(2) returns 2 rows');

SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox WHERE status = 'sending'),
  2,
  'claim: 2 rows moved to sending');
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox WHERE status = 'pending'),
  1,
  'claim: 1 row still pending');
SELECT is(
  (SELECT attempts FROM public.notification_outbox WHERE id = 'aaaaaaaa-0000-7777-0000-00000000000a'),
  1,
  'claim: attempts bumped to 1');
SELECT ok(
  (SELECT last_attempt_at IS NOT NULL FROM public.notification_outbox
     WHERE id = 'aaaaaaaa-0000-7777-0000-00000000000a'),
  'claim: last_attempt_at populated');

-- A second claim picks up the remaining pending row (and nothing else).
SELECT is(
  (SELECT count(*)::int FROM public._claim_pending_notifications(5)),
  1,
  'claim(5) on one-remaining-pending returns 1 (rest are in sending/sent)');

-- ============================================================================
-- _record_notification_success: sending → sent
-- ============================================================================

SELECT public._record_notification_success('aaaaaaaa-0000-7777-0000-00000000000a');
SELECT is(
  (SELECT status FROM public.notification_outbox WHERE id = 'aaaaaaaa-0000-7777-0000-00000000000a'),
  'sent',
  'success: sending → sent');
SELECT ok(
  (SELECT sent_at IS NOT NULL FROM public.notification_outbox WHERE id = 'aaaaaaaa-0000-7777-0000-00000000000a'),
  'success: sent_at populated');

-- Idempotent re-call on already-sent row: no error, no state change.
SELECT public._record_notification_success('aaaaaaaa-0000-7777-0000-00000000000a');
SELECT is(
  (SELECT status FROM public.notification_outbox WHERE id = 'aaaaaaaa-0000-7777-0000-00000000000a'),
  'sent',
  'success (repeat): still sent, no exception');

-- ============================================================================
-- _record_notification_failure: below max → back to pending (retry)
-- ============================================================================
-- Row b: attempts=1 (from the first claim). max_attempts=3. Failure should
-- return 'pending' and move the row back.
SELECT is(
  public._record_notification_failure('aaaaaaaa-0000-7777-0000-00000000000b',
                                      'smtp timeout', 3),
  'pending',
  'failure (attempts=1, max=3): returns pending');
SELECT is(
  (SELECT status FROM public.notification_outbox WHERE id = 'aaaaaaaa-0000-7777-0000-00000000000b'),
  'pending',
  'failure (below max): row back to pending for retry');

-- ============================================================================
-- _record_notification_failure: at max → failed + notification_failures row
-- ============================================================================
-- Row c was claimed in the second batch so attempts=1. Fail again with
-- max=1 to force exhaustion.
SELECT is(
  public._record_notification_failure('aaaaaaaa-0000-7777-0000-00000000000c',
                                      'resend 503 repeated', 1),
  'failed',
  'failure (attempts=1, max=1): returns failed');
SELECT is(
  (SELECT status FROM public.notification_outbox WHERE id = 'aaaaaaaa-0000-7777-0000-00000000000c'),
  'failed',
  'failure (at max): row marked failed');
SELECT is(
  (SELECT count(*)::int FROM public.notification_failures
     WHERE outbox_id = 'aaaaaaaa-0000-7777-0000-00000000000c'),
  1,
  'failure (at max): notification_failures row written');
SELECT is(
  (SELECT last_error FROM public.notification_failures
     WHERE outbox_id = 'aaaaaaaa-0000-7777-0000-00000000000c'),
  'resend 503 repeated',
  'failure (at max): last_error captured in failures row');

SELECT * FROM finish();
ROLLBACK;
