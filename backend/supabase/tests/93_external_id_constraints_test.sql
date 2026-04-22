-- External IDs on import-target tables (Batch 6) — spec §9.1.
-- Confirms the UNIQUE(tenant_id, external_id) constraint added by
-- `20260422174647_external_ids_for_import_tables.sql` gates idempotent imports:
-- re-inserting the same (tenant, external_id) pair fails with 23505 on every
-- covered table, while the same external_id in a different tenant is fine.

BEGIN;
SELECT plan(12);

-- ---- Fixtures -----------------------------------------------------------
INSERT INTO public.tenants (id, name, slug, email_from_address) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Acme',  'acme',  'a@acme.test'),
  ('22222222-2222-2222-2222-222222222222', 'Other', 'other', 'o@other.test');

-- Shared project for area inserts.
INSERT INTO public.projects (id, tenant_id, number, name, external_id) VALUES
  ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','2024-100','Acme P100','P100'),
  ('33333333-3333-3333-3333-333333333334','22222222-2222-2222-2222-222222222222','2024-100','Other P100','P100');

-- ---- projects: UNIQUE(tenant, external_id) ---------------------------------

SELECT throws_ok(
  $$INSERT INTO public.projects (tenant_id, number, name, external_id)
    VALUES ('11111111-1111-1111-1111-111111111111','2024-101','Acme P101','P100')$$,
  '23505',
  NULL,
  'projects: duplicate external_id in same tenant rejected');

SELECT lives_ok(
  $$INSERT INTO public.projects (tenant_id, number, name, external_id)
    VALUES ('22222222-2222-2222-2222-222222222222','2024-101','Other P101','P100-in-other-tenant-uses-P101-instead')$$,
  'projects: tenant isolation — new external_id is fine across tenants');

-- ---- areas: UNIQUE(tenant, external_id) ------------------------------------

INSERT INTO public.areas (id, tenant_id, project_id, code, name, external_id) VALUES
  ('44444444-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333','A1','Area 1','A001');

SELECT throws_ok(
  $$INSERT INTO public.areas (tenant_id, project_id, code, name, external_id)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '33333333-3333-3333-3333-333333333333','A2','Area 2','A001')$$,
  '23505',
  NULL,
  'areas: duplicate external_id in same tenant rejected');

SELECT lives_ok(
  $$INSERT INTO public.areas (tenant_id, project_id, code, name, external_id)
    VALUES ('22222222-2222-2222-2222-222222222222',
            '33333333-3333-3333-3333-333333333334','A1','Other A1','A001')$$,
  'areas: same external_id in different tenant allowed');

-- ---- task_codes ------------------------------------------------------------

INSERT INTO public.task_codes (tenant_id, code, name, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111','INST','Install','T001');

SELECT throws_ok(
  $$INSERT INTO public.task_codes (tenant_id, code, name, external_id)
    VALUES ('11111111-1111-1111-1111-111111111111','FAB','Fabricate','T001')$$,
  '23505',
  NULL,
  'task_codes: duplicate external_id rejected in same tenant');

SELECT lives_ok(
  $$INSERT INTO public.task_codes (tenant_id, code, name, external_id)
    VALUES ('22222222-2222-2222-2222-222222222222','INST','Install','T001')$$,
  'task_codes: same external_id across tenants allowed');

-- ---- cwps ------------------------------------------------------------------

INSERT INTO public.cwps (tenant_id, code, description, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111','CWP-001','Pipe rack','CW001');

SELECT throws_ok(
  $$INSERT INTO public.cwps (tenant_id, code, description, external_id)
    VALUES ('11111111-1111-1111-1111-111111111111','CWP-002','Foundation','CW001')$$,
  '23505',
  NULL,
  'cwps: duplicate external_id rejected in same tenant');

SELECT lives_ok(
  $$INSERT INTO public.cwps (tenant_id, code, description, external_id)
    VALUES ('22222222-2222-2222-2222-222222222222','CWP-001','Pipe rack','CW001')$$,
  'cwps: same external_id across tenants allowed');

-- ---- fcos ------------------------------------------------------------------

INSERT INTO public.fcos (tenant_id, code, description, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111','FCO-101','Change order','F001');

SELECT throws_ok(
  $$INSERT INTO public.fcos (tenant_id, code, description, external_id)
    VALUES ('11111111-1111-1111-1111-111111111111','FCO-102','Change order 2','F001')$$,
  '23505',
  NULL,
  'fcos: duplicate external_id rejected in same tenant');

SELECT lives_ok(
  $$INSERT INTO public.fcos (tenant_id, code, description, external_id)
    VALUES ('22222222-2222-2222-2222-222222222222','FCO-101','Change order','F001')$$,
  'fcos: same external_id across tenants allowed');

-- ---- Multiple NULL external_ids coexist (NULLS DISTINCT default) -----------
-- Native-provisioned entities won't have external_id; verify that pattern works.

SELECT lives_ok(
  $$INSERT INTO public.projects (tenant_id, number, name)
    VALUES ('11111111-1111-1111-1111-111111111111','2024-200','Acme P200')$$,
  'projects: NULL external_id insert allowed');

SELECT lives_ok(
  $$INSERT INTO public.projects (tenant_id, number, name)
    VALUES ('11111111-1111-1111-1111-111111111111','2024-201','Acme P201')$$,
  'projects: second NULL external_id in same tenant allowed (NULLS DISTINCT)');

SELECT * FROM finish();
ROLLBACK;
