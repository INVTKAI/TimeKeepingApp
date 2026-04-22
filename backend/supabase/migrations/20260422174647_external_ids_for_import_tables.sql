-- ============================================================================
-- External IDs for import tables (Batch 6 prep) — spec §9.1
-- ----------------------------------------------------------------------------
-- Spec §9 Phase A ("Stable external IDs") calls for preserving the legacy
-- `E001`/`P001` strings on every entity that the localStorage import touches,
-- so the importer is idempotent per tenant and can map old → new UUIDs across
-- re-runs.
--
-- `employees.external_id` already exists (Batch 3a). This migration extends the
-- same shape to projects, areas, task_codes, cwps, fcos. All imports land the
-- stable id; native-provisioned entities leave it NULL (UNIQUE NULLS DISTINCT
-- is the default, so multiple NULLs coexist without conflict).
-- ============================================================================

DO $$
DECLARE
  t text;
  tables text[] := ARRAY['projects', 'areas', 'task_codes', 'cwps', 'fcos'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN external_id text NULL;',
      t
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (tenant_id, external_id);',
      t, t || '_tenant_external_id_key'
    );
  END LOOP;
END $$;
