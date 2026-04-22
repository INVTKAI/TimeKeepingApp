-- Notification outbox enqueue (Batch 5a) — spec §7.6.
-- For each event type, verify the correct recipients appear in
-- public.notification_outbox, deduplicated per (event, user), with the
-- right role_context attribution. Delivery (status transitions beyond
-- 'pending') is 5b and is NOT exercised here.

BEGIN;
SELECT plan(20);

-- ---- Fixtures -------------------------------------------------------------

INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm2@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','self@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','00000000-0000-0000-0000-000000000000','authenticated','authenticated','foreman@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tka@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pm@acme.test','x',now(),now(),now(),'','','','','','','');

INSERT INTO public.subcontractors (id, tenant_id, name, short_code) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Invenio','INV');
INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','P1','Acme proj');
INSERT INTO public.project_subcontractors (tenant_id, project_id, subcontractor_id, start_date) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-01-01');
INSERT INTO public.employees (id, tenant_id, first_name, last_name, type, subcontractor_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Self','E','staff','aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.users (id, tenant_id, username, email, role, status, employee_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','adm','adm@acme.test','admin','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','adm2','adm2@acme.test','admin','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','self','self@acme.test','submitter','active','aaaaaaaa-0000-0000-0000-000000000003'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','11111111-1111-1111-1111-111111111111','foreman','foreman@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','11111111-1111-1111-1111-111111111111','tka','tka@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6','11111111-1111-1111-1111-111111111111','pm','pm@acme.test','submitter','active',NULL);

-- Two-node flow: foreman @ node 1, pm @ node 2.
INSERT INTO public.approval_flows (id, tenant_id, name) VALUES
  ('aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111','2-node');
INSERT INTO public.approval_nodes (id, flow_id, tenant_id, ordinal, name) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',1,'Foreman'),
  ('aaaaaaaa-0000-3333-0000-000000000002','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',2,'PM');
INSERT INTO public.approval_node_approvers (node_id, tenant_id, approver_type, role_label) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','11111111-1111-1111-1111-111111111111','role_on_silo','foreman'),
  ('aaaaaaaa-0000-3333-0000-000000000002','11111111-1111-1111-1111-111111111111','role_on_project','pm');
INSERT INTO public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','foreman','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','2026-01-01'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','timekeeper_admin','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','2026-01-01');
INSERT INTO public.project_role_assignments (tenant_id, project_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','pm','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6','2026-01-01');
INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-1111-0000-000000000001','2026-01-01');

-- A draft timesheet owned by self, plus a separate one to exercise recall.
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','staff','draft','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-13','2026-04-19'),
  ('aaaaaaaa-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','staff','draft','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-06','2026-04-12');

CREATE OR REPLACE FUNCTION _assume(p_sub uuid, p_role text DEFAULT 'submitter')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_sub::text,
      'tenant_id', '11111111-1111-1111-1111-111111111111',
      'app_role', p_role,
      'iat', extract(epoch from now())::bigint)::text, true);
END; $$;

-- Step back to postgres for the outbox-verification SELECTs. RLS on
-- notification_outbox is admin-only, so queries under 'authenticated' as the
-- submitter etc. would see 0 rows regardless of what the trigger wrote.
CREATE OR REPLACE FUNCTION _unassume() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END; $$;

-- ============================================================================
-- submitted
-- ============================================================================
-- Recipients per matrix: submitter + foreman + timekeeper_admin + current node
-- approvers (foreman again, via role_on_silo). Dedup'd → 3 users.

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');  -- self
DO $$ BEGIN PERFORM public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000a'); END $$;
SELECT _unassume();

SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='submitted'
      AND run_id = (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a')),
  3,
  'submitted: 3 deduplicated recipients (submitter + foreman + tka)');

-- Submitter sees themself exactly once (dedup across submitter / current_approver / etc.).
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='submitted'
      AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'),
  1,
  'submitted: submitter deduplicated to one row');
SELECT is(
  (SELECT role_context FROM public.notification_outbox
    WHERE event_type='submitted'
      AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'),
  'submitter',
  'submitted: submitter role_context is submitter (highest precedence)');

-- Foreman holds silo role 'foreman' AND is the current-node approver via
-- role_on_silo:foreman. Deduplicated to one row; role_context is
-- current_node_approver (precedence over foreman).
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='submitted'
      AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'),
  1,
  'submitted: foreman deduplicated to one row');
SELECT is(
  (SELECT role_context FROM public.notification_outbox
    WHERE event_type='submitted'
      AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'),
  'current_node_approver',
  'submitted: foreman role_context = current_node_approver (precedence over foreman)');

-- PM NOT notified on submitted (PM is a node-2 approver; current node is 1).
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='submitted' AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6'),
  0,
  'submitted: PM (node-2 approver) not notified at submit time');

-- ============================================================================
-- node_advanced (mid-flow approve)
-- ============================================================================
-- Foreman approves node 1. Run advances to node 2 (PM). Recipients:
-- submitter ✓ + current node (PM) ✓. NOT foreman, NOT tka.

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4');  -- foreman
DO $$ BEGIN
  PERFORM public.approve_run(
    (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
    'ok node 1');
END $$;
SELECT _unassume();

SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='node_advanced'),
  2,
  'node_advanced: 2 recipients (submitter + next-node approver)');
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='node_advanced'
      AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6'),
  1,
  'node_advanced: PM (next node) notified');
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='node_advanced'
      AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'),
  0,
  'node_advanced: tka NOT notified');

-- ============================================================================
-- approved (terminal)
-- ============================================================================
-- PM approves node 2. Run terminal. Recipients: submitter + foreman + tka.

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6');  -- pm
DO $$ BEGIN
  PERFORM public.approve_run(
    (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
    'ok node 2');
END $$;
SELECT _unassume();

SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox WHERE event_type='approved'),
  3,
  'approved (terminal): 3 recipients (submitter + foreman + tka)');
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='approved' AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6'),
  0,
  'approved: PM (actor) not in recipient set for terminal approved');

-- ============================================================================
-- rejected
-- ============================================================================
-- Submit b → foreman rejects. Recipients: submitter + foreman + tka.

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');  -- self
DO $$ BEGIN PERFORM public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000b'); END $$;

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4');  -- foreman
DO $$ BEGIN
  PERFORM public.reject_run(
    (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000b'),
    'hours look off');
END $$;
SELECT _unassume();

SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox WHERE event_type='rejected'),
  3,
  'rejected: 3 recipients (submitter + foreman + tka)');
SELECT ok(
  (SELECT bool_and(recipient_user_id IN (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'
  ))
   FROM public.notification_outbox WHERE event_type='rejected'),
  'rejected: recipients are exactly {submitter, foreman, tka}');

-- ============================================================================
-- reassigned
-- ============================================================================
-- Need a fresh open run to reassign; use a new draft + submit.
SELECT _unassume();

-- Create a third draft + submit it to get a fresh open run.
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','staff','draft','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-03-30','2026-04-05');
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');
DO $$ BEGIN PERFORM public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000c'); END $$;
SELECT _unassume();

-- Clear any outbox rows for this new run so the reassign count is clean.
DELETE FROM public.notification_outbox
 WHERE run_id = (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000c');

-- Admin reassigns.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
DO $$
DECLARE v_run uuid;
BEGIN
  SELECT id INTO v_run FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000c';
  PERFORM public.reassign_run(v_run, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6'::uuid, 'covering');
END $$;
SELECT _unassume();

-- Recipients per matrix for 'reassigned':
--   tka ✓ + current-node approvers (foreman at node 1) ✓ + tenant admins ✓ (×2)
--     + reassignee (PM) via approval_reassignments ✓
-- Distinct users: foreman, tka, adm, adm2, pm → 5.
SELECT is(
  (SELECT count(DISTINCT recipient_user_id)::int
     FROM public.notification_outbox WHERE event_type='reassigned'),
  5,
  'reassigned: 5 distinct recipients (foreman + tka + 2 admins + pm-reassignee)');

-- Tenant admins ARE in the pool (audit copy).
SELECT ok(
  EXISTS (SELECT 1 FROM public.notification_outbox
           WHERE event_type='reassigned' AND role_context='tenant_admin'),
  'reassigned: tenant_admin audit copy present');

-- Reassignee (PM) appears with role_context='reassignee' (6th precedence —
-- they are not currently a silo/project/user approver at node 1).
SELECT is(
  (SELECT role_context FROM public.notification_outbox
    WHERE event_type='reassigned' AND recipient_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6'),
  'reassignee',
  'reassigned: PM role_context=reassignee');

-- ============================================================================
-- parent_approval_invalidated via badge cascade
-- ============================================================================
-- Seed an approved run tied to a line, plus a badge override on that line.
-- Resolve with badge_canonical → parent_approval_invalidated emitted.

SELECT _unassume();

INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, submitted_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000d','11111111-1111-1111-1111-111111111111','staff','approved','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-03-23','2026-03-29', now());
INSERT INTO public.timesheet_lines (id, timesheet_id, tenant_id, date, employee_id, hours_st) VALUES
  ('aaaaaaaa-0000-5555-0000-00000000000d','aaaaaaaa-0000-0000-0000-00000000000d','11111111-1111-1111-1111-111111111111','2026-03-25','aaaaaaaa-0000-0000-0000-000000000003',8);
INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id, closed_at) VALUES
  ('aaaaaaaa-0000-4444-0000-00000000000d','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000d','aaaaaaaa-0000-1111-0000-000000000001','approved',NULL,now());
INSERT INTO public.badge_overrides (id, tenant_id, timesheet_line_id, employee_id, date, project_id, subcontractor_id,
  submitted_hours_st, submitted_hours_ot, badge_hours_st, badge_hours_ot, status, opened_by_user_id) VALUES
  ('aaaaaaaa-0000-6666-0000-00000000000d','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-5555-0000-00000000000d','aaaaaaaa-0000-0000-0000-000000000003','2026-03-25','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',8,0,6,0,'open','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1');

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
DO $$ BEGIN
  PERFORM public.resolve_badge_override(
    'aaaaaaaa-0000-6666-0000-00000000000d'::uuid,
    'resolved_badge_canonical', 'badge authoritative');
END $$;
SELECT _unassume();

-- parent_approval_invalidated recipients: tenant admins only.
SELECT is(
  (SELECT count(DISTINCT recipient_user_id)::int
     FROM public.notification_outbox WHERE event_type='parent_approval_invalidated'),
  2,
  'parent_approval_invalidated: both tenant admins notified');
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox
    WHERE event_type='parent_approval_invalidated' AND role_context='tenant_admin'),
  2,
  'parent_approval_invalidated: all recipients have role_context=tenant_admin');

-- ============================================================================
-- Outbox RLS: admin sees, non-admin doesn't
-- ============================================================================

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT ok(
  (SELECT count(*) FROM public.notification_outbox) > 0,
  'outbox RLS: admin can SELECT tenant rows');

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','submitter');
SELECT is(
  (SELECT count(*)::int FROM public.notification_outbox),
  0,
  'outbox RLS: non-admin sees 0 rows (admin-only select)');

SELECT * FROM finish();
ROLLBACK;
