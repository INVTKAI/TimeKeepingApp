-- Batch 4d: parent-run cascade for resolve_badge_override, plus deterministic
-- checks on the optimistic-concurrency and idempotency-key paths.
--
-- True multi-session racing (approve+approve producing a real P0002 via
-- concurrent conditional UPDATEs) requires pg_background or shell-level
-- parallel psql — not achievable in pgTAP's single-tx model. These tests
-- validate the code paths by simulating the pre-conditions the RPC checks
-- (manual state change between a would-be SELECT and the RPC, in-flight
-- idempotency row) — enough to catch regressions of the error-code
-- mapping and state-check ordering.

BEGIN;
SELECT plan(12);

-- ---- Fixtures (as postgres; RLS bypassed) ----

INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','foreman@acme.test','x',now(),now(),now(),'','','','','','','');

INSERT INTO public.subcontractors (id, tenant_id, name, short_code) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Invenio','INV');
INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','P1','Acme');
INSERT INTO public.employees (id, tenant_id, first_name, last_name, type, subcontractor_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','E','mp','staff','aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.users (id, tenant_id, username, email, role, status, employee_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','adm','adm@acme.test','admin','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','fore','foreman@acme.test','submitter','active',NULL);

-- Minimal flow (single foreman node) so we can have an open run.
INSERT INTO public.approval_flows (id, tenant_id, name) VALUES
  ('aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111','1-node');
INSERT INTO public.approval_nodes (id, flow_id, tenant_id, ordinal, name) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',1,'Foreman');
INSERT INTO public.approval_node_approvers (node_id, tenant_id, approver_type, role_label) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','11111111-1111-1111-1111-111111111111','role_on_silo','foreman');
INSERT INTO public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','foreman','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','2026-01-01'),
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','timekeeper_admin','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','2026-01-01');
INSERT INTO public.project_subcontractors (tenant_id, project_id, subcontractor_id, start_date) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-01-01');

-- Three parallel timesheets, each in_review with an open run, one with a line.
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, submitted_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','staff','in_review','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-13','2026-04-19',now()),
  ('aaaaaaaa-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','staff','approved','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-06','2026-04-12',now()),
  ('aaaaaaaa-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','staff','in_review','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-03-30','2026-04-05',now());

INSERT INTO public.timesheet_lines (id, timesheet_id, tenant_id, date, employee_id, hours_st) VALUES
  ('aaaaaaaa-0000-5555-0000-00000000000a','aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','2026-04-15','aaaaaaaa-0000-0000-0000-000000000003',8),
  ('aaaaaaaa-0000-5555-0000-00000000000b','aaaaaaaa-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','2026-04-08','aaaaaaaa-0000-0000-0000-000000000003',8),
  ('aaaaaaaa-0000-5555-0000-00000000000c','aaaaaaaa-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','2026-04-01','aaaaaaaa-0000-0000-0000-000000000003',8);

-- Approval runs: open for a + c, approved for b.
INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id) VALUES
  ('aaaaaaaa-0000-4444-0000-00000000000a','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000a','aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001'),
  ('aaaaaaaa-0000-4444-0000-00000000000c','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000c','aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001');
INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id, closed_at) VALUES
  ('aaaaaaaa-0000-4444-0000-00000000000b','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000b','aaaaaaaa-0000-1111-0000-000000000001','approved',NULL,now());

-- Three overrides: one tied to the open-parent line, one to the approved-parent
-- line, one retroactive (no line).
INSERT INTO public.badge_overrides (id, tenant_id, timesheet_line_id, employee_id, date, project_id, subcontractor_id,
  submitted_hours_st, submitted_hours_ot, badge_hours_st, badge_hours_ot, status, opened_by_user_id) VALUES
  ('aaaaaaaa-0000-6666-0000-00000000000a','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-5555-0000-00000000000a',
   'aaaaaaaa-0000-0000-0000-000000000003','2026-04-15','aaaaaaaa-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001',8,0,6,0,'open','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  ('aaaaaaaa-0000-6666-0000-00000000000b','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-5555-0000-00000000000b',
   'aaaaaaaa-0000-0000-0000-000000000003','2026-04-08','aaaaaaaa-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001',8,0,6,0,'open','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  ('aaaaaaaa-0000-6666-0000-00000000000c','11111111-1111-1111-1111-111111111111', NULL,
   'aaaaaaaa-0000-0000-0000-000000000003','2026-04-01','aaaaaaaa-0000-0000-0000-000000000002',
   'aaaaaaaa-0000-0000-0000-000000000001',8,0,6,0,'open','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1');

-- JWT helper.
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

-- Step out of the authenticated role for fixture-surgery writes that RLS
-- wouldn't allow (manual approval_runs UPDATE, idempotency_keys INSERT).
-- postgres has BYPASSRLS + all table grants.
CREATE OR REPLACE FUNCTION _unassume()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'postgres', true);
  PERFORM set_config('request.jwt.claims', '', true);
END; $$;

-- ============================================================================
-- Parent-run cascade
-- ============================================================================

-- resolved_submitted_canonical: no cascade (baseline sanity).
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (public.resolve_badge_override(
     'aaaaaaaa-0000-6666-0000-00000000000c'::uuid,   -- retroactive, no line
     'resolved_submitted_canonical', 'crew confirms') ->> 'parent_run_cascade'),
  'none',
  'resolve (submitted_canonical, no line): parent_run_cascade=none');

-- resolved_badge_canonical with OPEN parent: cascades to rejected.
SELECT is(
  (public.resolve_badge_override(
     'aaaaaaaa-0000-6666-0000-00000000000a'::uuid,
     'resolved_badge_canonical', 'badge terminal authoritative') ->> 'parent_run_cascade'),
  'rejected',
  'resolve (badge_canonical, open parent): parent_run_cascade=rejected');
SELECT is(
  (SELECT status::text FROM public.approval_runs WHERE id='aaaaaaaa-0000-4444-0000-00000000000a'),
  'rejected',
  'cascade: parent run transitioned to rejected');
SELECT is(
  (SELECT status::text FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000a'),
  'rejected',
  'cascade: parent timesheet transitioned to rejected');
SELECT is(
  (SELECT comment FROM public.approval_actions
    WHERE run_id='aaaaaaaa-0000-4444-0000-00000000000a' AND action='admin_override'),
  'HOURS_RECONCILED_TO_BADGE',
  'cascade: approval_actions row carries the reconciliation comment');

-- resolved_badge_canonical with APPROVED parent: invalidated audit, no state change.
SELECT is(
  (public.resolve_badge_override(
     'aaaaaaaa-0000-6666-0000-00000000000b'::uuid,
     'resolved_badge_canonical', 'badge correction after payroll lock') ->> 'parent_run_cascade'),
  'invalidated',
  'resolve (badge_canonical, approved parent): parent_run_cascade=invalidated');
SELECT is(
  (SELECT status::text FROM public.approval_runs WHERE id='aaaaaaaa-0000-4444-0000-00000000000b'),
  'approved',
  'cascade (invalidated): parent run UNTOUCHED (still approved)');
SELECT is(
  (SELECT count(*)::int FROM public.audit_events
    WHERE action_type='approval.parent_approval_invalidated'
      AND subject_id='aaaaaaaa-0000-4444-0000-00000000000b'),
  1,
  'cascade (invalidated): audit_events row written');

-- ============================================================================
-- P0002 RUN_STATE_CHANGED via manual state change
-- ============================================================================
-- Run c is still open. Simulate "another actor already terminated it" by
-- manually flipping the run to 'rejected'. Next approve_run call finds a
-- non-'open' status on its SELECT FOR UPDATE and must raise P0002.
SELECT _unassume();   -- approval_runs has no UPDATE policy for authenticated
UPDATE public.approval_runs
   SET status='rejected', current_node_id=NULL, closed_at=now(), version=version+1
 WHERE id='aaaaaaaa-0000-4444-0000-00000000000c';

SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');   -- foreman
SELECT throws_ok(
  $$SELECT public.approve_run('aaaaaaaa-0000-4444-0000-00000000000c'::uuid)$$,
  'P0002', NULL,
  'approve_run: run already terminal (state changed by another actor) → P0002');

-- ============================================================================
-- P0008 IDEMPOTENCY_CONFLICT via synthetic in-flight row
-- ============================================================================
-- Pretend a prior request claimed (actor, key) but crashed before
-- _idempotency_commit. A second call with the same key must see the
-- placeholder and raise P0008.
SELECT _unassume();
INSERT INTO public.idempotency_keys (actor_user_id, key, response) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', 'stale-in-flight', NULL);

-- Seed another timesheet to try submit against; doesn't matter what it
-- points at because the idempotency check fires before any work runs.
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000d','11111111-1111-1111-1111-111111111111','staff','draft','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-20','2026-04-26');

-- Need project flow for submit to pass the readiness check; add it.
INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-1111-0000-000000000001','2026-01-01');
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');   -- back to foreman for submit

SELECT throws_ok(
  $$SELECT public.submit_timesheet(
      'aaaaaaaa-0000-0000-0000-00000000000d'::uuid,
      'stale-in-flight')$$,
  'P0008', NULL,
  'submit_timesheet: synthetic in-flight idempotency row → P0008 IDEMPOTENCY_CONFLICT');

-- Completed cached row returns the cached response (no P0008).
SELECT _unassume();
UPDATE public.idempotency_keys
   SET response = jsonb_build_object('ok', true, 'cached', true)
 WHERE actor_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3' AND key='stale-in-flight';
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');   -- back to foreman
SELECT is(
  (public.submit_timesheet(
    'aaaaaaaa-0000-0000-0000-00000000000d'::uuid,
    'stale-in-flight') ->> 'cached'),
  'true',
  'submit_timesheet: completed idempotency row returns cached response');

-- Idempotency with an unrelated key still proceeds normally.
SELECT is(
  (public.submit_timesheet(
    'aaaaaaaa-0000-0000-0000-00000000000d'::uuid,
    'different-key-2') ->> 'timesheet_status'),
  'in_review',
  'submit_timesheet: unrelated key proceeds normally');

SELECT * FROM finish();
ROLLBACK;
