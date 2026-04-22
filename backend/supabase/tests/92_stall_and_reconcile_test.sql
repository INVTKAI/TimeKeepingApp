-- Stall detection + stuck-sending reconciliation (Batch 5c). Exercises the
-- two producer/maintenance RPCs _emit_stall_notifications and
-- _reconcile_stuck_sending via direct calls — pg_cron scheduling of these
-- RPCs is a production/CI setup step, not wired locally.

BEGIN;
SELECT plan(9);

-- ---- Fixtures (as postgres; RLS bypassed) ---------------------------------

INSERT INTO public.tenants (id, name, slug, email_from_address, stall_hours) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test', 48);

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','self@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','foreman@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tka@acme.test','x',now(),now(),now(),'','','','','','','');

INSERT INTO public.subcontractors (id, tenant_id, name, short_code) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Invenio','INV');
INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','P1','Acme');
INSERT INTO public.project_subcontractors (tenant_id, project_id, subcontractor_id, start_date) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-01-01');
INSERT INTO public.employees (id, tenant_id, first_name, last_name, type, subcontractor_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','E','mp','staff','aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.users (id, tenant_id, username, email, role, status, employee_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','adm','adm@acme.test','admin','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','self','self@acme.test','submitter','active','aaaaaaaa-0000-0000-0000-000000000003'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','fore','foreman@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','11111111-1111-1111-1111-111111111111','tka','tka@acme.test','submitter','active',NULL);

INSERT INTO public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','foreman','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','2026-01-01'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','timekeeper_admin','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','2026-01-01');

-- Flow (single foreman node).
INSERT INTO public.approval_flows (id, tenant_id, name) VALUES
  ('aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111','1-node');
INSERT INTO public.approval_nodes (id, flow_id, tenant_id, ordinal, name) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',1,'Foreman');
INSERT INTO public.approval_node_approvers (node_id, tenant_id, approver_type, role_label) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','11111111-1111-1111-1111-111111111111','role_on_silo','foreman');

-- Two timesheets + runs: one opened long ago (stalled), one opened now (fresh).
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, submitted_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','staff','in_review','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-01-06','2026-01-12', now()),
  ('aaaaaaaa-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','staff','in_review','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-13','2026-04-19', now());

INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id, opened_at) VALUES
  -- Stalled: opened_at is 72 hours ago (> 48 stall_hours).
  ('aaaaaaaa-0000-4444-0000-00000000000a','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000a','aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001', now() - interval '72 hours'),
  -- Fresh: opened_at is now (well under 48 stall_hours).
  ('aaaaaaaa-0000-4444-0000-00000000000b','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000b','aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001', now());

-- ============================================================================
-- _emit_stall_notifications
-- ============================================================================

SELECT is(
  public._emit_stall_notifications(),
  1,
  'stall detection: 1 stalled run found (the 72h-old one)');

-- Recipients for 'stalled' per §7.6 matrix (and my _resolve_recipients):
-- submitter, foreman (current_node_approver via silo role), tka
-- (timekeeper_admin), admin (tenant_admin) — 4 distinct users.
SELECT is(
  (SELECT count(DISTINCT recipient_user_id)::int
     FROM public.notification_outbox WHERE event_type='stalled'),
  4,
  'stall detection: 4 distinct recipients (submitter + foreman + tka + admin)');

SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox WHERE event_type='stalled'
     AND role_context='tenant_admin'),
  1,
  'stall detection: admin audit copy included');

-- Fresh run produces nothing.
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox WHERE event_type='stalled'
     AND run_id='aaaaaaaa-0000-4444-0000-00000000000b'),
  0,
  'stall detection: fresh run not flagged');

-- Re-running stall detection emits ANOTHER round of notifications (it's
-- stateless — caller is responsible for dedup via outbox history).
-- This is acceptable for a daily-cron model; revisit if we add a
-- "notified_at" marker.
SELECT is(
  public._emit_stall_notifications(),
  1,
  'stall detection: repeat call finds same stalled run');

-- ============================================================================
-- _reconcile_stuck_sending
-- ============================================================================

-- Seed an outbox row stuck in 'sending' for 10 minutes.
INSERT INTO public.notification_outbox (
  id, tenant_id, event_type, recipient_user_id, role_context, payload,
  status, attempts, last_attempt_at
) VALUES (
  'aaaaaaaa-0000-7777-0000-0000000000e1','11111111-1111-1111-1111-111111111111','approved',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter',
  jsonb_build_object('stuck', true),
  'sending', 1, clock_timestamp() - interval '10 minutes'
);

-- And a fresh 'sending' row (< 5 minutes old): should NOT be reconciled.
INSERT INTO public.notification_outbox (
  id, tenant_id, event_type, recipient_user_id, role_context, payload,
  status, attempts, last_attempt_at
) VALUES (
  'aaaaaaaa-0000-7777-0000-0000000000e2','11111111-1111-1111-1111-111111111111','approved',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter',
  jsonb_build_object('fresh', true),
  'sending', 1, clock_timestamp() - interval '30 seconds'
);

SELECT is(
  public._reconcile_stuck_sending(5),
  1,
  'reconcile: 1 stuck-sending row reset to pending (older than 5m)');

SELECT is(
  (SELECT status FROM public.notification_outbox WHERE id='aaaaaaaa-0000-7777-0000-0000000000e1'),
  'pending',
  'reconcile: stuck row now pending');

SELECT is(
  (SELECT status FROM public.notification_outbox WHERE id='aaaaaaaa-0000-7777-0000-0000000000e2'),
  'sending',
  'reconcile: fresh sending row NOT reset');

-- last_error annotated for observability.
SELECT ok(
  (SELECT last_error LIKE '%reconciled: stuck in sending%'
     FROM public.notification_outbox WHERE id='aaaaaaaa-0000-7777-0000-0000000000e1'),
  'reconcile: last_error annotated with the reconciliation reason');

SELECT * FROM finish();
ROLLBACK;
