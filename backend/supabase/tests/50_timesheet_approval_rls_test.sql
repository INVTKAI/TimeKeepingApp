-- RLS isolation + scope-filtering for Batch 4a (timesheets + approval schema).
-- Covers §2 P0: every write path has multi-tenant isolation.
--
-- What we test here:
--   (a) tenant-SELECT isolation on every admin-gated table
--   (b) admin-only writes on template/config tables
--   (c) timesheets/timesheet_lines scope-filtering:
--       - admin sees tenant-wide
--       - submitter sees own-submitted + own-employee + proxy-silo rows
--       - submitter can INSERT own drafts but not others'
--       - submitter can UPDATE own drafts but cannot lift status past 'draft'/'open'
--   (d) approval_runs / approval_actions / approval_reassignments /
--       badge_overrides are tenant-SELECT-only (no direct PostgREST writes)
--   (e) idempotency_keys is fully inaccessible to authenticated roles

BEGIN;
SELECT plan(29);

-- ---- Fixtures: two tenants, admin + submitter + proxy-timekeeper in tenant A ----
INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111','Acme','acme','hr@acme.test'),
  ('22222222-2222-2222-2222-222222222222','Other','other','hr@other.test');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin-a@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','00000000-0000-0000-0000-000000000000','authenticated','authenticated','self-a@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','00000000-0000-0000-0000-000000000000','authenticated','authenticated','proxy-a@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','00000000-0000-0000-0000-000000000000','authenticated','authenticated','admin-b@other.test','x',now(),now(),now(),'','','','','','','');

-- Tenant A skeleton.
INSERT INTO public.subcontractors (id, tenant_id, name, short_code) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Invenio-A','INV');
INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','P1','Acme proj');
INSERT INTO public.employees (id, tenant_id, first_name, last_name, type, subcontractor_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Self','Employee','staff','aaaaaaaa-0000-0000-0000-000000000001'),
  ('aaaaaaaa-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Crew','Member','field','aaaaaaaa-0000-0000-0000-000000000001');

-- Tenant B skeleton.
INSERT INTO public.subcontractors (id, tenant_id, name, short_code) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','Invenio-B','INV');
INSERT INTO public.projects (id, tenant_id, number, name) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','P1','Other proj');
INSERT INTO public.employees (id, tenant_id, first_name, last_name, type, subcontractor_id) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','Staff','B','staff','bbbbbbbb-0000-0000-0000-000000000001');

INSERT INTO public.users (id, tenant_id, username, email, role, status, employee_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','admin-a','admin-a@acme.test','admin','active', NULL),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','self-a','self-a@acme.test','submitter','active','aaaaaaaa-0000-0000-0000-000000000003'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','proxy-a','proxy-a@acme.test','submitter','active', NULL),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','22222222-2222-2222-2222-222222222222','admin-b','admin-b@other.test','admin','active', NULL);

-- proxy-a gets submitter_assignments on the tenant-A silo.
INSERT INTO public.submitter_assignments (tenant_id, user_id, project_id, subcontractor_id) VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001');

-- Approval flows + node for both tenants (pre-seeded as postgres, bypasses RLS).
INSERT INTO public.approval_flows (id, tenant_id, name) VALUES
  ('aaaaaaaa-0000-1111-0000-000000000001','11111111-1111-1111-1111-111111111111','flow-a'),
  ('bbbbbbbb-0000-1111-0000-000000000001','22222222-2222-2222-2222-222222222222','flow-b');
INSERT INTO public.approval_nodes (id, flow_id, tenant_id, ordinal, name) VALUES
  ('aaaaaaaa-0000-3333-0000-000000000001','aaaaaaaa-0000-1111-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',1,'Foreman');

-- Seed timesheets (both tenants).
INSERT INTO public.timesheets (id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end) VALUES
  -- In A: a draft by self-a for their own employee record
  ('aaaaaaaa-0000-0000-0000-00000000000a','11111111-1111-1111-1111-111111111111','staff','draft',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-13','2026-04-19'),
  -- In A: a field draft by proxy-a (on their assigned silo)
  ('aaaaaaaa-0000-0000-0000-00000000000b','11111111-1111-1111-1111-111111111111','field','draft',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', NULL,
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-20','2026-04-20'),
  -- In A: an unrelated submitter-less 'open' field timesheet (admin pre-created)
  ('aaaaaaaa-0000-0000-0000-00000000000c','11111111-1111-1111-1111-111111111111','field','open',
   NULL, NULL,
   'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','2026-04-21','2026-04-21'),
  -- In B: a draft under admin-b
  ('bbbbbbbb-0000-0000-0000-00000000000a','22222222-2222-2222-2222-222222222222','staff','draft',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','bbbbbbbb-0000-0000-0000-000000000003',
   'bbbbbbbb-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-000000000001','2026-04-13','2026-04-19');

-- Seed an approval_run for later test.
INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id) VALUES
  ('aaaaaaaa-0000-4444-0000-000000000001','11111111-1111-1111-1111-111111111111',
   'aaaaaaaa-0000-0000-0000-00000000000a','aaaaaaaa-0000-1111-0000-000000000001',
   'open','aaaaaaaa-0000-3333-0000-000000000001');

-- Helper to assume a JWT.
CREATE OR REPLACE FUNCTION _assume_jwt(p_sub uuid, p_tenant uuid, p_role text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object(
      'sub', p_sub::text,
      'tenant_id', p_tenant::text,
      'app_role', p_role,
      'iat', extract(epoch from now())::bigint
    )::text, true);
END; $$;

-- ============================================================================
-- (a) tenant-SELECT isolation on config/template tables
-- ============================================================================

SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','admin');
SELECT is((SELECT count(*)::int FROM public.approval_flows), 1, 'approval_flows: admin-A sees only tenant-A flows');
SELECT is((SELECT name FROM public.approval_flows), 'flow-a', 'approval_flows: correct name');

SELECT _assume_jwt('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','22222222-2222-2222-2222-222222222222','admin');
SELECT is((SELECT count(*)::int FROM public.approval_flows), 1, 'approval_flows: admin-B sees only tenant-B flows');
SELECT is((SELECT name FROM public.approval_flows), 'flow-b', 'approval_flows: tenant-B sees its own flow');

-- ============================================================================
-- (b) admin-only writes on template tables
-- ============================================================================

SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','submitter');
SELECT throws_ok(
  $$INSERT INTO public.approval_flows (tenant_id, name)
    VALUES ('11111111-1111-1111-1111-111111111111','bad-flow')$$,
  '42501', NULL,
  'approval_flows: submitter INSERT blocked (admin-only)');

SELECT throws_ok(
  $$INSERT INTO public.submitter_assignments (tenant_id, user_id, project_id, subcontractor_id)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001')$$,
  '42501', NULL,
  'submitter_assignments: submitter INSERT blocked (admin-only)');

SELECT throws_ok(
  $$INSERT INTO public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002',
      'aaaaaaaa-0000-0000-0000-000000000001','foreman','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','2026-04-01')$$,
  '42501', NULL,
  'silo_role_assignments: submitter INSERT blocked (admin-only)');

-- Admin-A can insert on a tenant-A template table.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','admin');
SELECT lives_ok(
  $$INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000002',
      'aaaaaaaa-0000-1111-0000-000000000001','2026-01-01')$$,
  'admin can insert project_flow_assignment in own tenant');

-- Admin-A cannot spoof tenant-B.
SELECT throws_ok(
  $$INSERT INTO public.approval_flows (tenant_id, name)
    VALUES ('22222222-2222-2222-2222-222222222222','spoof')$$,
  '42501', NULL,
  'approval_flows: admin-A cannot spoof tenant-B INSERT');

-- ============================================================================
-- (c) timesheets scope-filtering
-- ============================================================================

-- admin-A sees all 3 tenant-A timesheets.
SELECT is((SELECT count(*)::int FROM public.timesheets), 3, 'timesheets: admin-A sees all tenant-A rows');

-- self-a sees their own draft (submitter_user_id match + employee_id match — both apply).
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','submitter');
SELECT is((SELECT count(*)::int FROM public.timesheets), 1, 'timesheets: self-a sees only their own staff draft');
SELECT is((SELECT id FROM public.timesheets), 'aaaaaaaa-0000-0000-0000-00000000000a'::uuid,
  'timesheets: self-a sees the right row');

-- proxy-a sees: the 'open' row (proxy silo match), the field draft they submitted, and
-- the self-a staff draft (also on the proxy silo). So 3 rows.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','submitter');
SELECT is((SELECT count(*)::int FROM public.timesheets), 3,
  'timesheets: proxy-a sees all rows on their assigned silo');

-- proxy-a can UPDATE their own draft (submitter_user_id = them).
SELECT lives_ok(
  $$UPDATE public.timesheets SET period_end = period_end
    WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000b'$$,
  'timesheets: proxy-a can UPDATE their own draft');

-- proxy-a CANNOT UPDATE self-a's draft (different submitter).
SELECT lives_ok(
  $$UPDATE public.timesheets SET period_end = period_end
    WHERE id = 'aaaaaaaa-0000-0000-0000-00000000000a'$$,
  'timesheets: proxy-a UPDATE on self-a''s row runs cleanly (RLS filters; 0 rows)');
-- Assert self-a's row unchanged.
SELECT is((SELECT submitter_user_id FROM public.timesheets WHERE id='aaaaaaaa-0000-0000-0000-00000000000a'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'::uuid,
  'timesheets: self-a''s row untouched after proxy-a''s attempted UPDATE');

-- Tenant isolation: admin-B never sees tenant-A rows.
SELECT _assume_jwt('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','22222222-2222-2222-2222-222222222222','admin');
SELECT is((SELECT count(*)::int FROM public.timesheets), 1, 'timesheets: admin-B sees only tenant-B rows');

-- Submitter INSERT: self-a can INSERT a staff draft for their own employee.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','11111111-1111-1111-1111-111111111111','submitter');
SELECT lives_ok(
  $$INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end)
    VALUES ('11111111-1111-1111-1111-111111111111','staff','draft',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
      'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
      '2026-04-06','2026-04-12')$$,
  'timesheets: self-a can INSERT their own draft');

-- self-a CANNOT INSERT as a different submitter (spoofing).
SELECT throws_ok(
  $$INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end)
    VALUES ('11111111-1111-1111-1111-111111111111','staff','draft',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','aaaaaaaa-0000-0000-0000-000000000003',
      'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
      '2026-04-06','2026-04-12')$$,
  '42501', NULL,
  'timesheets: self-a cannot spoof submitter_user_id on INSERT');

-- self-a CANNOT INSERT directly in 'submitted' status (must go through submit_timesheet RPC in 4b).
SELECT throws_ok(
  $$INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end)
    VALUES ('11111111-1111-1111-1111-111111111111','staff','submitted',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','aaaaaaaa-0000-0000-0000-000000000003',
      'aaaaaaaa-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001',
      '2026-04-06','2026-04-12')$$,
  '42501', NULL,
  'timesheets: submitter cannot INSERT directly as ''submitted'' (RPC-only path)');

-- ============================================================================
-- timesheet_lines: inherit parent visibility + editability
-- ============================================================================

-- Seed a line as postgres.
INSERT INTO public.timesheet_lines (id, timesheet_id, tenant_id, date, employee_id, hours_st) VALUES
  ('aaaaaaaa-0000-2222-0000-000000000001','aaaaaaaa-0000-0000-0000-00000000000a',
   '11111111-1111-1111-1111-111111111111','2026-04-15','aaaaaaaa-0000-0000-0000-000000000003',8);

SELECT is((SELECT count(*)::int FROM public.timesheet_lines), 1,
  'timesheet_lines: self-a sees line on own timesheet');

-- proxy-a can also see it (proxy silo match on parent).
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3','11111111-1111-1111-1111-111111111111','submitter');
SELECT is((SELECT count(*)::int FROM public.timesheet_lines), 1,
  'timesheet_lines: proxy-a sees line on silo they''re assigned to');

-- admin-B sees nothing.
SELECT _assume_jwt('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','22222222-2222-2222-2222-222222222222','admin');
SELECT is((SELECT count(*)::int FROM public.timesheet_lines), 0,
  'timesheet_lines: admin-B sees no lines from tenant A');

-- ============================================================================
-- (d) approval_runs / approval_actions / approval_reassignments: tenant-SELECT
-- ============================================================================

-- admin-A can SELECT.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','admin');
SELECT is((SELECT count(*)::int FROM public.approval_runs), 1,
  'approval_runs: admin-A sees tenant-A runs');

-- No direct INSERT on approval_runs / approval_actions (no policy = all denied for authenticated).
SELECT throws_ok(
  $$INSERT INTO public.approval_runs (tenant_id, timesheet_id, flow_id, status, current_node_id)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-00000000000a',
      'aaaaaaaa-0000-1111-0000-000000000001','open','aaaaaaaa-0000-3333-0000-000000000001')$$,
  '42501', NULL,
  'approval_runs: no direct INSERT policy for authenticated (RPC-only)');

SELECT throws_ok(
  $$INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-4444-0000-000000000001',
      'aaaaaaaa-0000-3333-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','approve')$$,
  '42501', NULL,
  'approval_actions: no direct INSERT policy for authenticated (RPC-only)');

-- Tenant-B sees nothing.
SELECT _assume_jwt('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1','22222222-2222-2222-2222-222222222222','admin');
SELECT is((SELECT count(*)::int FROM public.approval_runs), 0,
  'approval_runs: admin-B sees no tenant-A runs');

-- ============================================================================
-- (e) idempotency_keys: fully inaccessible to authenticated
-- ============================================================================
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','11111111-1111-1111-1111-111111111111','admin');
SELECT throws_ok(
  $$SELECT * FROM public.idempotency_keys$$,
  '42501', NULL,
  'idempotency_keys: admin SELECT rejected (revoked for authenticated)');
SELECT throws_ok(
  $$INSERT INTO public.idempotency_keys (actor_user_id, key)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','k')$$,
  '42501', NULL,
  'idempotency_keys: admin INSERT rejected (revoked for authenticated)');

SELECT * FROM finish();
ROLLBACK;
