-- RLS isolation — spec §2 P0 (test plan) + §3.
-- For every tenant-scoped table, verify:
--   (a) authenticated user in tenant A sees only tenant-A rows,
--   (b) non-admin writes are rejected (admin-gated tables),
--   (c) cross-tenant tenant_id spoofing on INSERT is rejected,
--   (d) no-tenant-claim JWT sees zero rows (§4.8 fail-closed).
--
-- Tested tables: tenants, public.users, audit_events, user_unlock_markers,
-- subcontractors, employees, projects, areas, project_subcontractors,
-- task_codes, cwps, fcos, employee_subcontractor_history.

BEGIN;
SELECT plan(38);

-- ---- Fixtures ----
-- Two tenants, each with an admin and a submitter user.
INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme',  'acme',  'hr@acme.test'),
  ('22222222-2222-2222-2222-222222222222', 'Other', 'other', 'hr@other.test');

INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  reauthentication_token, phone_change, phone_change_token) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adminA@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','00000000-0000-0000-0000-000000000000','authenticated','authenticated','subA@acme.test','x',now(),now(),now(),'','','','','','',''),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','00000000-0000-0000-0000-000000000000','authenticated','authenticated','adminB@other.test','x',now(),now(),now(),'','','','','','','');

INSERT INTO public.users (id, tenant_id, username, email, role, status) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','admin-a','adminA@acme.test','admin','active'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','sub-a','subA@acme.test','submitter','active'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222','admin-b','adminB@other.test','admin','active');

-- One domain row in each tenant, pre-seeded as postgres (bypasses RLS).
INSERT INTO public.subcontractors (tenant_id, name, short_code) VALUES
  ('11111111-1111-1111-1111-111111111111','Invenio-A','INV'),
  ('22222222-2222-2222-2222-222222222222','Invenio-B','INV');
INSERT INTO public.projects (tenant_id, number, name) VALUES
  ('11111111-1111-1111-1111-111111111111','P1','Acme proj'),
  ('22222222-2222-2222-2222-222222222222','P1','Other proj');
INSERT INTO public.task_codes (tenant_id, code, name) VALUES
  ('11111111-1111-1111-1111-111111111111','TASK-A','Work'),
  ('22222222-2222-2222-2222-222222222222','TASK-B','Work');

-- ---- helpers --------------------------------------------------------------
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

-- ---- (a) tenant isolation on SELECT --------------------------------------

-- admin-A: sees exactly one subcontractor (their tenant's).
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','admin');
SELECT is((SELECT count(*)::int FROM public.subcontractors), 1, 'admin-A sees 1 subcontractor');
SELECT is((SELECT short_code FROM public.subcontractors), 'INV', 'admin-A sees only own-tenant sub');
SELECT is((SELECT count(*)::int FROM public.projects), 1, 'admin-A sees 1 project');
SELECT is((SELECT count(*)::int FROM public.task_codes), 1, 'admin-A sees 1 task_code');
SELECT is((SELECT count(*)::int FROM public.users), 2, 'admin-A sees the 2 users in tenant A');
SELECT is((SELECT id FROM public.tenants), '11111111-1111-1111-1111-111111111111'::uuid, 'admin-A sees only own tenant row');

-- submitter-A: same visibility, tenant-scoped.
SELECT _assume_jwt('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','submitter');
SELECT is((SELECT count(*)::int FROM public.subcontractors), 1, 'submitter-A sees 1 subcontractor');
SELECT is((SELECT count(*)::int FROM public.projects),       1, 'submitter-A sees 1 project');
SELECT is((SELECT count(*)::int FROM public.users),          2, 'submitter-A sees 2 users in tenant A');

-- admin-B: sees tenant B's rows only.
SELECT _assume_jwt('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222','admin');
SELECT is((SELECT short_code FROM public.subcontractors), 'INV', 'admin-B sees own-tenant sub');
SELECT is((SELECT name FROM public.subcontractors), 'Invenio-B', 'admin-B name is Invenio-B not Invenio-A');
SELECT is((SELECT number FROM public.projects), 'P1', 'admin-B sees own project');
SELECT is((SELECT count(*)::int FROM public.users), 1, 'admin-B sees only own-tenant user');

-- ---- (b) admin-only write policies ---------------------------------------

-- submitter-A cannot INSERT into admin-gated tables (expect RLS 42501).
SELECT _assume_jwt('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','submitter');
SELECT throws_ok(
  $$INSERT INTO public.subcontractors (tenant_id, name, short_code)
    VALUES ('11111111-1111-1111-1111-111111111111','Bad','BAD')$$,
  '42501', NULL,
  'submitter cannot insert subcontractors');
SELECT throws_ok(
  $$INSERT INTO public.projects (tenant_id, number, name)
    VALUES ('11111111-1111-1111-1111-111111111111','P9','Bad')$$,
  '42501', NULL,
  'submitter cannot insert projects');
SELECT throws_ok(
  $$INSERT INTO public.employees (tenant_id, first_name, last_name, type, subcontractor_id)
    VALUES ('11111111-1111-1111-1111-111111111111','Bad','E','staff',
      (SELECT id FROM public.subcontractors WHERE tenant_id='11111111-1111-1111-1111-111111111111'))$$,
  '42501', NULL,
  'submitter cannot insert employees');
SELECT throws_ok(
  $$INSERT INTO public.task_codes (tenant_id, code, name)
    VALUES ('11111111-1111-1111-1111-111111111111','X','Bad')$$,
  '42501', NULL,
  'submitter cannot insert task_codes');
SELECT throws_ok(
  $$INSERT INTO public.cwps (tenant_id, code, description)
    VALUES ('11111111-1111-1111-1111-111111111111','X','Bad')$$,
  '42501', NULL,
  'submitter cannot insert cwps');
SELECT throws_ok(
  $$INSERT INTO public.fcos (tenant_id, code, description)
    VALUES ('11111111-1111-1111-1111-111111111111','X','Bad')$$,
  '42501', NULL,
  'submitter cannot insert fcos');
SELECT throws_ok(
  $$INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES ('11111111-1111-1111-1111-111111111111',
      (SELECT id FROM public.projects WHERE tenant_id='11111111-1111-1111-1111-111111111111'),
      'A1','Bad')$$,
  '42501', NULL,
  'submitter cannot insert areas');
SELECT throws_ok(
  $$INSERT INTO public.project_subcontractors (tenant_id, project_id, subcontractor_id, start_date)
    VALUES ('11111111-1111-1111-1111-111111111111',
      (SELECT id FROM public.projects WHERE tenant_id='11111111-1111-1111-1111-111111111111'),
      (SELECT id FROM public.subcontractors WHERE tenant_id='11111111-1111-1111-1111-111111111111'),
      '2026-01-01')$$,
  '42501', NULL,
  'submitter cannot insert project_subcontractors');
SELECT throws_ok(
  $$INSERT INTO public.employee_subcontractor_history (tenant_id, employee_id, subcontractor_id, started_at)
    VALUES ('11111111-1111-1111-1111-111111111111', gen_random_uuid(),
      (SELECT id FROM public.subcontractors WHERE tenant_id='11111111-1111-1111-1111-111111111111'),
      now())$$,
  '42501', NULL,
  'submitter cannot insert employee_subcontractor_history');

-- submitter-A UPDATE: RLS USING clause filters rows (no exception, 0 affected).
-- We assert the statement runs clean AND that the row is unchanged.
SELECT lives_ok(
  $$UPDATE public.subcontractors SET name='hacked' WHERE tenant_id='11111111-1111-1111-1111-111111111111'$$,
  'submitter UPDATE runs cleanly (RLS silently filters — no exception)');
SELECT is((SELECT name FROM public.subcontractors WHERE tenant_id='11111111-1111-1111-1111-111111111111' AND short_code='INV'), 'Invenio-A',
  'subcontractors.name unchanged after RLS-filtered UPDATE');

-- admin-A CAN insert into own tenant.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','admin');
SELECT lives_ok(
  $$INSERT INTO public.subcontractors (tenant_id, name, short_code)
    VALUES ('11111111-1111-1111-1111-111111111111','Second','SCD')$$,
  'admin can insert subcontractor in own tenant');
SELECT lives_ok(
  $$INSERT INTO public.projects (tenant_id, number, name)
    VALUES ('11111111-1111-1111-1111-111111111111','P2','Second proj')$$,
  'admin can insert project in own tenant');

-- ---- (c) tenant-spoofing on INSERT ---------------------------------------

-- admin-A tries to insert into tenant B via explicit tenant_id. WITH CHECK blocks.
SELECT throws_ok(
  $$INSERT INTO public.subcontractors (tenant_id, name, short_code)
    VALUES ('22222222-2222-2222-2222-222222222222','Spoof','SPF')$$,
  '42501', NULL,
  'admin-A cannot spoof tenant_id to tenant B');

-- ---- (d) no-tenant-claim JWT sees nothing --------------------------------

SELECT set_config('role', 'authenticated', true);
SELECT set_config('request.jwt.claims',
  json_build_object('sub','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','app_role','admin','iat',extract(epoch from now())::bigint)::text, true);

SELECT is((SELECT count(*)::int FROM public.tenants),        0, 'no tenant_id claim: tenants query empty (fail-closed)');
SELECT is((SELECT count(*)::int FROM public.subcontractors), 0, 'no tenant_id claim: subcontractors empty');
SELECT is((SELECT count(*)::int FROM public.projects),       0, 'no tenant_id claim: projects empty');
SELECT is((SELECT count(*)::int FROM public.users),          0, 'no tenant_id claim: users empty');

-- ---- audit_events: self-insert policy -----------------------------------

-- Submitter-A can insert a row attributing themselves.
SELECT _assume_jwt('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','submitter');
SELECT lives_ok(
  $$INSERT INTO public.audit_events (tenant_id, actor_user_id, action_type, subject_type, subject_id)
    VALUES ('11111111-1111-1111-1111-111111111111','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','test.self','user','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  'submitter can insert self-attributed audit_events row');

-- Submitter-A CANNOT insert attributing someone else (spoofing actor_user_id).
SELECT throws_ok(
  $$INSERT INTO public.audit_events (tenant_id, actor_user_id, action_type, subject_type, subject_id)
    VALUES ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','test.spoof','user','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  '42501', NULL,
  'submitter cannot spoof actor_user_id on audit_events');

-- Submitter-A cannot read audit_events (admin-only SELECT policy).
SELECT is((SELECT count(*)::int FROM public.audit_events), 0,
  'submitter sees 0 audit_events (admin-only select)');

-- admin-A CAN read audit_events in own tenant.
SELECT _assume_jwt('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','admin');
SELECT is((SELECT count(*)::int FROM public.audit_events WHERE tenant_id='11111111-1111-1111-1111-111111111111'), 1,
  'admin-A sees the self-inserted row');
SELECT is((SELECT count(*)::int FROM public.audit_events WHERE tenant_id='22222222-2222-2222-2222-222222222222'), 0,
  'admin-A sees no audit rows from tenant B');

-- user_unlock_markers: admin-only read in own tenant.
SELECT is((SELECT count(*)::int FROM public.user_unlock_markers), 0,
  'no unlock markers yet in tenant A');

-- login_failure_counters: no RLS policy = no access for authenticated.
SELECT throws_ok(
  $$SELECT * FROM public.login_failure_counters$$,
  '42501', NULL,
  'login_failure_counters not accessible to authenticated (table grants revoked)');

SELECT * FROM finish();
ROLLBACK;
