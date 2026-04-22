-- State-machine RPCs (Batch 4b): submit_timesheet, approve_run, reject_run,
-- recall_run, claim_field_timesheet, release_field_timesheet,
-- project_readiness, my_pending_approvals. Exercises happy paths and the
-- key P0001/P0002/P0003/P0004/P0008 error codes.
--
-- Concurrency-specific tests (racing approve+approve, approve+reject, etc.)
-- land in Batch 4d where we can compose pg_background or similar; same-tx
-- pgTAP can't easily race actors.

BEGIN;
SELECT plan(37);

-- ---- Fixtures ---- (seeded as postgres; bypasses RLS and FK checks)

INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test'),
  ('22222222-2222-2222-2222-222222222222','Other','other','x@y.test');
INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','PX','Other');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','self@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','foreman@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','00000000-0000-0000-0000-000000000000','authenticated','authenticated','stranger@acme.test','x',now(),now(),now(),'','','','','','','');

INSERT INTO public.subcontractors (id, tenant_id, name, short_code) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Invenio','INV');

INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','P1','Acme proj'),
  ('aaaaaaaa-0000-0000-0000-000000000099','11111111-1111-1111-1111-111111111111','P-NOTREADY','Not configured');

INSERT INTO public.employees (id, tenant_id, first_name, last_name, type, subcontractor_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Self','E','staff','aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.users (id, tenant_id, username, email, role, status, employee_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','adm','adm@acme.test','admin','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','self','self@acme.test','submitter','active','aaaaaaaa-0000-0000-0000-000000000003'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','foreman','foreman@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','11111111-1111-1111-1111-111111111111','pm','pm@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','11111111-1111-1111-1111-111111111111','stranger','stranger@acme.test','submitter','active',NULL);

-- Silo + flow: two-node (foreman, pm).
INSERT INTO public.project_subcontractors (tenant_id, project_id, subcontractor_id, start_date) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-01-01');

INSERT INTO public.approval_flows (id, tenant_id, name) VALUES
  ('aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111','2-node');
INSERT INTO public.approval_nodes (id, flow_id, tenant_id, ordinal, name) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',1,'Foreman'),
  ('aaaaaaaa-0000-3333-0000-000000000002','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',2,'PM');
INSERT INTO public.approval_node_approvers (node_id, tenant_id, approver_type, role_label) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','11111111-1111-1111-1111-111111111111','role_on_silo','foreman'),
  ('aaaaaaaa-0000-3333-0000-000000000002','11111111-1111-1111-1111-111111111111','role_on_project','pm');

INSERT INTO public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','foreman','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','2026-01-01');
INSERT INTO public.project_role_assignments (tenant_id, project_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','pm','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','2026-01-01');

INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-1111-0000-000000000001','2026-01-01');

-- Admin pre-created field 'open' timesheet (used in claim_field_timesheet tests).
INSERT INTO public.timesheets (id, tenant_id, kind, status, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000f','11111111-1111-1111-1111-111111111111','field','open',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-21','2026-04-21');

-- Helper: assume a given user's JWT.
CREATE OR REPLACE FUNCTION _assume_jwt(p_sub uuid, p_role text DEFAULT 'submitter')
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object(
      'sub', p_sub::text,
      'tenant_id', '11111111-1111-1111-1111-111111111111',
      'app_role', p_role,
      'iat', extract(epoch from now())::bigint
    )::text, true);
END; $$;

-- ============================================================================
-- project_readiness
-- ============================================================================
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (public.project_readiness('aaaaaaaa-0000-0000-0000-000000000002') ->> 'ready')::boolean,
  true,
  'project_readiness: fully configured project returns ready=true');
SELECT is(
  (public.project_readiness('aaaaaaaa-0000-0000-0000-000000000099') -> 'missing' ->> 0),
  'project_flow_assignment',
  'project_readiness: missing flow is surfaced first');
-- Cross-tenant: readiness on a project not in caller's tenant must 404-equivalent.
SELECT is(
  (public.project_readiness('bbbbbbbb-0000-0000-0000-000000000002') -> 'missing' ->> 0),
  'project_not_found',
  'project_readiness: cross-tenant project returns project_not_found');

-- ============================================================================
-- submit_timesheet — happy path
-- ============================================================================

-- self submits their own draft on the fully-configured project.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter');
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','staff','draft',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-13','2026-04-19');

SELECT is(
  (public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000a') ->> 'timesheet_status'),
  'in_review',
  'submit_timesheet: draft → in_review on happy path');

SELECT is(
  (SELECT status::text FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000a'),
  'in_review',
  'submit_timesheet: timesheet row persisted in_review');

SELECT is(
  (SELECT count(*)::int FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
  1,
  'submit_timesheet: one open run created');

SELECT is(
  (SELECT status::text FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
  'open',
  'submit_timesheet: run is open');

SELECT is(
  (SELECT version FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
  0,
  'submit_timesheet: run starts at version=0');

-- Idempotent re-call returns the same cached result.
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','staff','draft',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-06','2026-04-12');

SELECT is(
  (public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000b','idem-1') ->> 'timesheet_status'),
  'in_review',
  'submit_timesheet: first call with idempotency key succeeds');
-- Second call with same key returns the cached response (not a "draft is now in_review" error).
SELECT is(
  (public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000b','idem-1') ->> 'timesheet_status'),
  'in_review',
  'submit_timesheet: retry with same idempotency key returns cached response');

-- ============================================================================
-- submit_timesheet — error paths
-- ============================================================================

-- Stranger attempts to submit someone else's draft → P0004
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','staff','draft',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-03-30','2026-04-05');
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','submitter');
SELECT throws_ok(
  $$SELECT public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000c')$$,
  'P0004', NULL,
  'submit_timesheet: non-submitter rejected with P0004');

-- Admin CAN submit someone else's draft.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000c') ->> 'timesheet_status'),
  'in_review',
  'submit_timesheet: admin can submit any draft');

-- Project with no flow assignment → P0001.
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000d','11111111-1111-1111-1111-111111111111','staff','draft',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000099','aaaaaaaa-0000-0000-0000-000000000001','2026-03-23','2026-03-29');
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter');
SELECT throws_ok(
  $$SELECT public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000d')$$,
  'P0001', NULL,
  'submit_timesheet: missing flow → P0001 PROJECT_NOT_READY');

-- Already-submitted timesheet resubmit → P0003.
SELECT throws_ok(
  $$SELECT public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000a')$$,
  'P0003', NULL,
  'submit_timesheet: re-submitting an in_review timesheet → P0003');

-- ============================================================================
-- approve_run — happy path + advance + terminal
-- ============================================================================

-- Foreman approves node 1 → advance to node 2.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','submitter');
DO $$
DECLARE v_run uuid; v_result jsonb; BEGIN
  SELECT id INTO v_run FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a';
  v_result := public.approve_run(v_run, 'ok from foreman');
END $$;

SELECT is(
  (SELECT current_node_id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
  'aaaaaaaa-0000-3333-0000-000000000002'::uuid,
  'approve_run: advanced from node 1 to node 2');

SELECT is(
  (SELECT version FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
  1,
  'approve_run: version bumped on advance');

SELECT is(
  (SELECT count(*)::int FROM public.approval_actions WHERE action='approve'
     AND run_id = (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a')),
  1,
  'approve_run: one approve action written');

-- Non-eligible actor at node 2: foreman tries to approve again → P0004
-- (eligibility at node 2 is PM, not foreman).
SELECT throws_ok(
  $$SELECT public.approve_run(
      (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a')
    )$$,
  'P0004', NULL,
  'approve_run: foreman rejected at node 2 (PM-only) → P0004');

-- PM approves node 2 → terminal: run='approved', timesheet='approved'.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','submitter');
DO $$
DECLARE v_run uuid; BEGIN
  SELECT id INTO v_run FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a';
  PERFORM public.approve_run(v_run, 'pm signs off');
END $$;

-- Verify terminal state under admin JWT (PM has no timesheets-SELECT scope).
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (SELECT status::text FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
  'approved',
  'approve_run: final approve → run approved');
SELECT is(
  (SELECT status::text FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000a'),
  'approved',
  'approve_run: final approve → timesheet approved');
SELECT is(
  (SELECT current_node_id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a'),
  NULL,
  'approve_run: terminal run has current_node_id NULL');
-- Return to PM context for the follow-on negative test.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','submitter');

-- Approving a terminal run → P0002 RUN_STATE_CHANGED.
SELECT throws_ok(
  $$SELECT public.approve_run(
      (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000a')
    )$$,
  'P0002', NULL,
  'approve_run: re-approve on terminal run → P0002');

-- ============================================================================
-- reject_run — happy path + comment-required
-- ============================================================================

-- Run on timesheet b (also in_review from submit above). Reject at node 1.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','submitter');
DO $$
DECLARE v_run uuid; BEGIN
  SELECT id INTO v_run FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000b';
  PERFORM public.reject_run(v_run, 'hours look wrong');
END $$;
-- Verify rejected state under admin JWT (foreman has no timesheets-SELECT scope on b).
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (SELECT status::text FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000b'),
  'rejected',
  'reject_run: run rejected');
SELECT is(
  (SELECT status::text FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000b'),
  'rejected',
  'reject_run: timesheet rejected');

-- reject without comment → P0003.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','submitter');
SELECT throws_ok(
  $$SELECT public.reject_run(
      (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000c'),
      '   '
    )$$,
  'P0003', NULL,
  'reject_run: empty/whitespace comment → P0003');

-- ============================================================================
-- recall_run — submitter withdraws open run
-- ============================================================================

-- Self submits a fresh timesheet → run open at node 1 → self recalls.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','submitter');
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000e','11111111-1111-1111-1111-111111111111','staff','draft',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-20','2026-04-26');
DO $$ DECLARE v_run uuid; BEGIN
  PERFORM public.submit_timesheet('aaaaaaaa-0000-0000-0000-00000000000e');
  SELECT id INTO v_run FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000e';
  PERFORM public.recall_run(v_run);
END $$;

SELECT is(
  (SELECT status::text FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000e'),
  'recalled',
  'recall_run: run recalled');
SELECT is(
  (SELECT status::text FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000e'),
  'draft',
  'recall_run: timesheet back to draft');

-- Non-submitter attempts recall on the earlier c timesheet's run → P0004.
-- (c's run is still open at node 1.)
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','submitter');
SELECT throws_ok(
  $$SELECT public.recall_run(
      (SELECT id FROM public.approval_runs WHERE timesheet_id='aaaaaaaa-0000-0000-0000-00000000000c')
    )$$,
  'P0004', NULL,
  'recall_run: stranger cannot recall someone else''s run → P0004');

-- ============================================================================
-- claim_field_timesheet / release_field_timesheet
-- ============================================================================

-- Foreman has no submitter_assignment → can't claim.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','submitter');
SELECT throws_ok(
  $$SELECT public.claim_field_timesheet('aaaaaaaa-0000-0000-0000-00000000000f')$$,
  'P0004', NULL,
  'claim_field_timesheet: user without submitter_assignment → P0004');

-- Grant the foreman a submitter_assignment (admin action). Switch to admin context.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
INSERT INTO public.submitter_assignments (tenant_id, user_id, project_id, subcontractor_id) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001');

-- Foreman claims successfully.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','submitter');
SELECT is(
  (public.claim_field_timesheet('aaaaaaaa-0000-0000-0000-00000000000f') ->> 'status'),
  'draft',
  'claim_field_timesheet: silo submitter claims open → draft');
SELECT is(
  (SELECT submitter_user_id FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000f'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'::uuid,
  'claim_field_timesheet: submitter_user_id set to claimer');

-- Second claim attempt (already claimed) → P0003.
SELECT throws_ok(
  $$SELECT public.claim_field_timesheet('aaaaaaaa-0000-0000-0000-00000000000f')$$,
  'P0003', NULL,
  'claim_field_timesheet: claiming a draft → P0003');

-- Foreman releases.
SELECT is(
  (public.release_field_timesheet('aaaaaaaa-0000-0000-0000-00000000000f') ->> 'status'),
  'open',
  'release_field_timesheet: draft → open');
SELECT is(
  (SELECT submitter_user_id FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000f'),
  NULL,
  'release_field_timesheet: submitter_user_id cleared');

-- ============================================================================
-- my_pending_approvals
-- ============================================================================

-- After all the above, c's run is still open at node 1 (foreman is eligible).
-- e was recalled, a/b are terminal.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','submitter');
SELECT is(
  (SELECT count(*)::int FROM public.my_pending_approvals()),
  1,
  'my_pending_approvals: foreman sees exactly 1 pending run (c)');

-- PM should see 0 (c is still at node 1, not 2 yet).
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','submitter');
SELECT is(
  (SELECT count(*)::int FROM public.my_pending_approvals()),
  0,
  'my_pending_approvals: PM sees 0 (not at node 2 yet)');

-- Stranger sees 0.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','submitter');
SELECT is(
  (SELECT count(*)::int FROM public.my_pending_approvals()),
  0,
  'my_pending_approvals: stranger sees 0');

SELECT * FROM finish();
ROLLBACK;
