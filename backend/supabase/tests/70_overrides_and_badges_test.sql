-- Admin overrides + badge-override RPCs (Batch 4c). Tests:
--   reassign_run   — §7.5 targeted reassignment
--   override_run   — §7.5 admin override
--   create_badge_override  — §7.7 retroactive creation
--   resolve_badge_override — §7.7 resolution (timekeeper_admin or admin)

BEGIN;
SELECT plan(27);

-- ---- Fixtures (all as postgres, bypass RLS) --------------------------------

INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','self@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','foreman@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pm@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','00000000-0000-0000-0000-000000000000','authenticated','authenticated','stranger@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6','00000000-0000-0000-0000-000000000000','authenticated','authenticated','tka@acme.test','x',now(),now(),now(),'','','','','','','');

INSERT INTO public.subcontractors (id, tenant_id, name, short_code) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Invenio','INV');
INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','P1','Acme');
INSERT INTO public.employees (id, tenant_id, first_name, last_name, type, subcontractor_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Self','E','staff','aaaaaaaa-0000-0000-0000-000000000001');

INSERT INTO public.users (id, tenant_id, username, email, role, status, employee_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','adm','adm@acme.test','admin','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','self','self@acme.test','submitter','active','aaaaaaaa-0000-0000-0000-000000000003'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','fore','foreman@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','11111111-1111-1111-1111-111111111111','pm','pm@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5','11111111-1111-1111-1111-111111111111','stranger','stranger@acme.test','submitter','active',NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6','11111111-1111-1111-1111-111111111111','tka','tka@acme.test','submitter','active',NULL);

INSERT INTO public.project_subcontractors (tenant_id, project_id, subcontractor_id, start_date) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-01-01');

-- Two-node flow (foreman, pm).
INSERT INTO public.approval_flows (id, tenant_id, name) VALUES
  ('aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111','2-node');
INSERT INTO public.approval_nodes (id, flow_id, tenant_id, ordinal, name) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',1,'Foreman'),
  ('aaaaaaaa-0000-3333-0000-000000000002','aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111',2,'PM');
INSERT INTO public.approval_node_approvers (node_id, tenant_id, approver_type, role_label) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','11111111-1111-1111-1111-111111111111','role_on_silo','foreman'),
  ('aaaaaaaa-0000-3333-0000-000000000002','11111111-1111-1111-1111-111111111111','role_on_project','pm');

INSERT INTO public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','foreman','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','2026-01-01'),
  -- timekeeper_admin assigned to the tka user for badge override tests.
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','timekeeper_admin','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6','2026-01-01');
INSERT INTO public.project_role_assignments (tenant_id, project_id, role_label, user_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','pm','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4','2026-01-01');

INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-1111-0000-000000000001','2026-01-01');

-- Three submitted timesheets; we'll drive different outcomes through each run.
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, submitted_at) VALUES
  ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','staff','in_review','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-13','2026-04-19', now()),
  ('aaaaaaaa-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','staff','in_review','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-06','2026-04-12', now()),
  ('aaaaaaaa-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','staff','in_review','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-03-30','2026-04-05', now());

INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id) VALUES
  ('aaaaaaaa-0000-4444-0000-00000000000a','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000a','aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001'),
  ('aaaaaaaa-0000-4444-0000-00000000000b','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000b','aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001'),
  ('aaaaaaaa-0000-4444-0000-00000000000c','11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000c','aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001');

-- JWT switch helper.
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

-- Helper used by resolve_badge_override tests; must be created as postgres
-- (before any role switch) so CREATE FUNCTION succeeds.
CREATE OR REPLACE FUNCTION _pick_open_override() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM public.badge_overrides WHERE status='open' ORDER BY opened_at LIMIT 1
$$;

-- ============================================================================
-- reassign_run
-- ============================================================================

-- Non-admin rejected (foreman tries to reassign).
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');
SELECT throws_ok(
  $$SELECT public.reassign_run(
      'aaaaaaaa-0000-4444-0000-00000000000a'::uuid,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'::uuid, 'because')$$,
  'P0004', NULL,
  'reassign_run: non-admin caller → P0004');

-- Admin reassigns: run version bumps, reassignment row appears.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (public.reassign_run(
    'aaaaaaaa-0000-4444-0000-00000000000a'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'::uuid,
    'coverage for foreman out sick') ->> 'reassigned_to'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  'reassign_run: admin can reassign');
SELECT is(
  (SELECT version FROM public.approval_runs WHERE id='aaaaaaaa-0000-4444-0000-00000000000a'),
  1,
  'reassign_run: version bumped');
SELECT is(
  (SELECT count(*)::int FROM public.approval_reassignments WHERE run_id='aaaaaaaa-0000-4444-0000-00000000000a'),
  1,
  'reassign_run: approval_reassignments row written');
SELECT is(
  (SELECT count(*)::int FROM public.approval_actions
    WHERE run_id='aaaaaaaa-0000-4444-0000-00000000000a' AND action='reassign'),
  1,
  'reassign_run: approval_actions reassign row written');

-- The reassignee (stranger) is now eligible on node 1: run A appears in their
-- my_pending_approvals. Goes through the public eligibility surface.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5');
SELECT ok(
  EXISTS (SELECT 1 FROM public.my_pending_approvals()
          WHERE run_id = 'aaaaaaaa-0000-4444-0000-00000000000a'),
  'reassign_run: reassignee now sees the run in my_pending_approvals');
-- Return to admin for subsequent reassign tests.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');

-- Empty reason → P0003.
SELECT throws_ok(
  $$SELECT public.reassign_run('aaaaaaaa-0000-4444-0000-00000000000b'::uuid,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'::uuid, '  ')$$,
  'P0003', NULL,
  'reassign_run: empty reason → P0003');

-- Invalid target user (not in tenant / inactive) → P0004. Use a bogus uuid.
SELECT throws_ok(
  $$SELECT public.reassign_run('aaaaaaaa-0000-4444-0000-00000000000b'::uuid,
    '00000000-0000-0000-0000-000000000099'::uuid, 'reason')$$,
  'P0004', NULL,
  'reassign_run: unknown/inactive target user → P0004');

-- ============================================================================
-- override_run
-- ============================================================================

-- Non-admin rejected.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');
SELECT throws_ok(
  $$SELECT public.override_run('aaaaaaaa-0000-4444-0000-00000000000b'::uuid, 'approve', 'please')$$,
  'P0004', NULL,
  'override_run: non-admin caller → P0004');

-- Admin override approve on multi-node: run advances to node 2.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (public.override_run(
    'aaaaaaaa-0000-4444-0000-00000000000b'::uuid, 'approve',
    'foreman unreachable; admin override node 1') ->> 'current_node_id'),
  'aaaaaaaa-0000-3333-0000-000000000002',
  'override_run: admin approve advances to next node');
SELECT is(
  (SELECT count(*)::int FROM public.approval_actions
    WHERE run_id='aaaaaaaa-0000-4444-0000-00000000000b' AND action='admin_override'),
  1,
  'override_run: approval_actions admin_override row written');

-- Admin override reject terminates.
SELECT is(
  (public.override_run(
    'aaaaaaaa-0000-4444-0000-00000000000c'::uuid, 'reject',
    'hours exceed weekly cap') ->> 'status'),
  'rejected',
  'override_run: admin reject → run rejected');
SELECT is(
  (SELECT status::text FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000c'),
  'rejected',
  'override_run: admin reject → timesheet rejected');

-- Invalid decision / empty comment.
SELECT throws_ok(
  $$SELECT public.override_run('aaaaaaaa-0000-4444-0000-00000000000a'::uuid, 'frobnicate', 'c')$$,
  'P0003', NULL,
  'override_run: unknown decision → P0003');
SELECT throws_ok(
  $$SELECT public.override_run('aaaaaaaa-0000-4444-0000-00000000000a'::uuid, 'reject', '   ')$$,
  'P0003', NULL,
  'override_run: empty comment → P0003');

-- Already terminal (c was rejected above) → P0002.
SELECT throws_ok(
  $$SELECT public.override_run('aaaaaaaa-0000-4444-0000-00000000000c'::uuid, 'approve', 'oops')$$,
  'P0002', NULL,
  'override_run: already-terminal run → P0002');

-- ============================================================================
-- create_badge_override
-- ============================================================================

-- Non-admin without submitter_assignment → P0004.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5');
SELECT throws_ok(
  $$SELECT public.create_badge_override(
      'aaaaaaaa-0000-0000-0000-000000000003'::uuid, '2026-04-15'::date,
      'aaaaaaaa-0000-0000-0000-000000000002'::uuid,
      'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      8, 0, 7, 0)$$,
  'P0004', NULL,
  'create_badge_override: non-authorized caller → P0004');

-- Admin creates successfully.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (public.create_badge_override(
    'aaaaaaaa-0000-0000-0000-000000000003'::uuid, '2026-04-15'::date,
    'aaaaaaaa-0000-0000-0000-000000000002'::uuid,
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    8, 0, 7.5, 0) ->> 'status'),
  'open',
  'create_badge_override: admin creates in open state');

-- Silo-submitter can create (grant a submitter_assignment, switch to them).
INSERT INTO public.submitter_assignments (tenant_id, user_id, project_id, subcontractor_id) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001');
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');
SELECT is(
  (public.create_badge_override(
    'aaaaaaaa-0000-0000-0000-000000000003'::uuid, '2026-04-16'::date,
    'aaaaaaaa-0000-0000-0000-000000000002'::uuid,
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    8, 0, 9, 0) ->> 'status'),
  'open',
  'create_badge_override: silo-submitter can create');

-- Cross-tenant spoof (unknown project id) → P0003.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT throws_ok(
  $$SELECT public.create_badge_override(
      'aaaaaaaa-0000-0000-0000-000000000003'::uuid, '2026-04-17'::date,
      '00000000-0000-0000-0000-000000000099'::uuid,
      'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      8, 0, 8, 0)$$,
  'P0003', NULL,
  'create_badge_override: unknown project → P0003');

-- ============================================================================
-- resolve_badge_override
-- ============================================================================

-- Stranger attempts resolve → P0004.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5');
SELECT throws_ok(
  $$SELECT public.resolve_badge_override(_pick_open_override(),
    'resolved_submitted_canonical','reason')$$,
  'P0004', NULL,
  'resolve_badge_override: stranger (no silo timekeeper_admin) → P0004');

-- Invalid outcome → P0003.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6');  -- tka user
SELECT throws_ok(
  $$SELECT public.resolve_badge_override(_pick_open_override(),
    'wrong_label','reason')$$,
  'P0003', NULL,
  'resolve_badge_override: invalid outcome → P0003');

-- Empty reason → P0003.
SELECT throws_ok(
  $$SELECT public.resolve_badge_override(_pick_open_override(),
    'resolved_submitted_canonical', '  ')$$,
  'P0003', NULL,
  'resolve_badge_override: empty reason → P0003');

-- Timekeeper_admin resolves successfully.
SELECT is(
  (public.resolve_badge_override(_pick_open_override(),
    'resolved_submitted_canonical',
    'crew reports confirm the submitted hours') ->> 'status'),
  'resolved_submitted_canonical',
  'resolve_badge_override: timekeeper_admin resolves to submitted_canonical');

-- Admin resolves a different open override.
SELECT _assume('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','admin');
SELECT is(
  (public.resolve_badge_override(_pick_open_override(),
    'resolved_badge_canonical',
    'badge terminal was authoritative') ->> 'status'),
  'resolved_badge_canonical',
  'resolve_badge_override: admin resolves to badge_canonical');

-- Re-resolving an already-resolved override → P0002.
SELECT throws_ok(
  $$SELECT public.resolve_badge_override(
      (SELECT id FROM public.badge_overrides
        WHERE status='resolved_submitted_canonical' LIMIT 1),
      'resolved_badge_canonical', 'second try')$$,
  'P0002', NULL,
  'resolve_badge_override: already-resolved → P0002');

-- audit_events captured two resolve rows (one per successful resolve).
SELECT is(
  (SELECT count(*)::int FROM public.audit_events WHERE action_type='badge_override.resolve'),
  2,
  'resolve_badge_override: audit_events rows written');

SELECT * FROM finish();
ROLLBACK;
