-- ============================================================================
-- seed-demo-data.sql — Populates the test tenant with realistic demo data.
-- ----------------------------------------------------------------------------
-- Idempotent via ON CONFLICT on (tenant_id, external_id) / (tenant_id, name) /
-- (tenant_id, short_code) etc. — safe to re-run.
--
-- Assumes:
--   * Test tenant id = 0993e1df-a501-42be-a365-c6b9d5133900 (from
--     memory/project_frontend_plan.md — change :tenant_id below if you target
--     a different tenant).
--   * Admin user t.elliott.english@gmail.com already exists (bootstrap step).
--
-- What it seeds:
--   * 3 subcontractors (Invenio prime + 2 subs)
--   * 3 projects with 2-3 areas each
--   * 8 task codes, 4 CWPs, 3 FCOs
--   * 12 employees across the 3 subs
--   * 2 approval flows (1-node + 2-node), attached to 2 projects
--   * silo/project role assignments pointing at the admin user
--   * submitter_assignments so the admin can claim field timesheets
--   * 4 staff timesheets in mixed states (draft / submitted / approved / rejected)
--   * 2 field timesheets (1 open / 1 claimed-draft)
--
-- Execute locally:        psql <connection-string> -f seed-demo-data.sql
-- Execute via Supabase CLI: supabase db execute --file backend/scripts/seed-demo-data.sql
-- ============================================================================

-- Edit these two constants if you're targeting a different tenant or admin.
-- They're hardcoded rather than :set'd so the script runs identically under
-- psql, supabase CLI, or any other PG client.

BEGIN;

DO $seed$
DECLARE
  v_tenant     uuid := '0993e1df-a501-42be-a365-c6b9d5133900'::uuid;
  v_admin_email text := 't.elliott.english@gmail.com';
  v_admin_id   uuid;

  -- Subs
  v_sub_invenio uuid;
  v_sub_acme    uuid;
  v_sub_buckeye uuid;

  -- Projects
  v_proj_alpha uuid;
  v_proj_bravo uuid;
  v_proj_charlie uuid;

  -- Areas
  v_area_a1 uuid; v_area_a2 uuid;
  v_area_b1 uuid; v_area_b2 uuid; v_area_b3 uuid;
  v_area_c1 uuid; v_area_c2 uuid;

  -- Task codes
  v_tc_carp uuid; v_tc_elec uuid; v_tc_weld uuid; v_tc_lab uuid;
  v_tc_iron uuid; v_tc_pipe uuid; v_tc_ops uuid;  v_tc_saf uuid;

  -- CWPs
  v_cwp_found uuid; v_cwp_steel uuid; v_cwp_mech uuid; v_cwp_elec uuid;

  -- FCOs
  v_fco_change_01 uuid; v_fco_change_02 uuid; v_fco_change_03 uuid;

  -- Employees
  v_emp1 uuid; v_emp2 uuid; v_emp3 uuid; v_emp4 uuid;
  v_emp5 uuid; v_emp6 uuid; v_emp7 uuid; v_emp8 uuid;
  v_emp9 uuid; v_emp10 uuid; v_emp11 uuid; v_emp12 uuid;

  -- Flows + nodes
  v_flow_simple uuid; v_flow_twostep uuid;
  v_node_simple_1 uuid;
  v_node_two_1 uuid; v_node_two_2 uuid;

  -- Timesheets
  v_ts1 uuid; v_ts2 uuid; v_ts3 uuid; v_ts4 uuid;
  v_ts_field_open uuid; v_ts_field_draft uuid;

  v_week_mon date := date_trunc('week', current_date)::date;  -- Mon of current week (ISO)
BEGIN
  -- Find the admin user. They must exist before running this.
  SELECT id INTO v_admin_id
    FROM public.users
   WHERE tenant_id = v_tenant
     AND email = v_admin_email
   LIMIT 1;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Admin user % not found in tenant % — bootstrap first.',
      v_admin_email, v_tenant;
  END IF;

  -- --------------------------------------------------------------------------
  -- Subcontractors
  -- --------------------------------------------------------------------------
  INSERT INTO public.subcontractors (tenant_id, name, short_code, active)
  VALUES (v_tenant, 'Invenio Construction', 'INV', true)
  ON CONFLICT (tenant_id, short_code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_sub_invenio;

  INSERT INTO public.subcontractors (tenant_id, name, short_code, active)
  VALUES (v_tenant, 'Acme Mechanical', 'ACME', true)
  ON CONFLICT (tenant_id, short_code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_sub_acme;

  INSERT INTO public.subcontractors (tenant_id, name, short_code, active)
  VALUES (v_tenant, 'Buckeye Electric', 'BUCK', true)
  ON CONFLICT (tenant_id, short_code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_sub_buckeye;

  -- --------------------------------------------------------------------------
  -- Projects
  -- --------------------------------------------------------------------------
  -- Backfill FIRST so any pre-existing rows (created before this script
  -- started setting external_id) match the ON CONFLICT target below.
  -- Skipping this step risks creating duplicate project rows on re-run.
  UPDATE public.projects
     SET external_id = number
   WHERE tenant_id = v_tenant
     AND external_id IS NULL;

  -- projects.external_id is the lookup key for Phase B imports — we mirror
  -- `number` into it so imports can round-trip without extra work.
  INSERT INTO public.projects (tenant_id, number, external_id, name, active)
  VALUES (v_tenant, 'P-1001', 'P-1001', 'Refinery Unit 40 Turnaround', true)
  ON CONFLICT (tenant_id, external_id) DO UPDATE
    SET number = EXCLUDED.number, name = EXCLUDED.name
  RETURNING id INTO v_proj_alpha;

  INSERT INTO public.projects (tenant_id, number, external_id, name, active)
  VALUES (v_tenant, 'P-1024', 'P-1024', 'LNG Module Assembly', true)
  ON CONFLICT (tenant_id, external_id) DO UPDATE
    SET number = EXCLUDED.number, name = EXCLUDED.name
  RETURNING id INTO v_proj_bravo;

  INSERT INTO public.projects (tenant_id, number, external_id, name, active)
  VALUES (v_tenant, 'P-1108', 'P-1108', 'Pipeline Station 7 Retrofit', true)
  ON CONFLICT (tenant_id, external_id) DO UPDATE
    SET number = EXCLUDED.number, name = EXCLUDED.name
  RETURNING id INTO v_proj_charlie;

  -- --------------------------------------------------------------------------
  -- Areas (unique on (tenant_id, project_id, code) not defined — dedupe by SELECT)
  -- --------------------------------------------------------------------------
  SELECT id INTO v_area_a1 FROM public.areas
   WHERE tenant_id = v_tenant AND project_id = v_proj_alpha AND code = 'A-01';
  IF v_area_a1 IS NULL THEN
    INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES (v_tenant, v_proj_alpha, 'A-01', 'Process Unit North')
    RETURNING id INTO v_area_a1;
  END IF;

  SELECT id INTO v_area_a2 FROM public.areas
   WHERE tenant_id = v_tenant AND project_id = v_proj_alpha AND code = 'A-02';
  IF v_area_a2 IS NULL THEN
    INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES (v_tenant, v_proj_alpha, 'A-02', 'Process Unit South')
    RETURNING id INTO v_area_a2;
  END IF;

  SELECT id INTO v_area_b1 FROM public.areas
   WHERE tenant_id = v_tenant AND project_id = v_proj_bravo AND code = 'B-01';
  IF v_area_b1 IS NULL THEN
    INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES (v_tenant, v_proj_bravo, 'B-01', 'Module Yard')
    RETURNING id INTO v_area_b1;
  END IF;

  SELECT id INTO v_area_b2 FROM public.areas
   WHERE tenant_id = v_tenant AND project_id = v_proj_bravo AND code = 'B-02';
  IF v_area_b2 IS NULL THEN
    INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES (v_tenant, v_proj_bravo, 'B-02', 'Marine Loadout')
    RETURNING id INTO v_area_b2;
  END IF;

  SELECT id INTO v_area_b3 FROM public.areas
   WHERE tenant_id = v_tenant AND project_id = v_proj_bravo AND code = 'B-03';
  IF v_area_b3 IS NULL THEN
    INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES (v_tenant, v_proj_bravo, 'B-03', 'Pipe Rack East')
    RETURNING id INTO v_area_b3;
  END IF;

  SELECT id INTO v_area_c1 FROM public.areas
   WHERE tenant_id = v_tenant AND project_id = v_proj_charlie AND code = 'C-01';
  IF v_area_c1 IS NULL THEN
    INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES (v_tenant, v_proj_charlie, 'C-01', 'Compressor House')
    RETURNING id INTO v_area_c1;
  END IF;

  SELECT id INTO v_area_c2 FROM public.areas
   WHERE tenant_id = v_tenant AND project_id = v_proj_charlie AND code = 'C-02';
  IF v_area_c2 IS NULL THEN
    INSERT INTO public.areas (tenant_id, project_id, code, name)
    VALUES (v_tenant, v_proj_charlie, 'C-02', 'Block Valve Site')
    RETURNING id INTO v_area_c2;
  END IF;

  -- --------------------------------------------------------------------------
  -- Task codes
  -- --------------------------------------------------------------------------
  SELECT id INTO v_tc_carp FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'CARP';
  IF v_tc_carp IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'CARP', 'Carpentry') RETURNING id INTO v_tc_carp; END IF;
  SELECT id INTO v_tc_elec FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'ELEC';
  IF v_tc_elec IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'ELEC', 'Electrical') RETURNING id INTO v_tc_elec; END IF;
  SELECT id INTO v_tc_weld FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'WELD';
  IF v_tc_weld IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'WELD', 'Welding') RETURNING id INTO v_tc_weld; END IF;
  SELECT id INTO v_tc_lab  FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'LAB';
  IF v_tc_lab  IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'LAB',  'General Labor') RETURNING id INTO v_tc_lab; END IF;
  SELECT id INTO v_tc_iron FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'IRON';
  IF v_tc_iron IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'IRON', 'Ironworker') RETURNING id INTO v_tc_iron; END IF;
  SELECT id INTO v_tc_pipe FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'PIPE';
  IF v_tc_pipe IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'PIPE', 'Pipefitter') RETURNING id INTO v_tc_pipe; END IF;
  SELECT id INTO v_tc_ops  FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'OPS';
  IF v_tc_ops  IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'OPS',  'Equipment Operator') RETURNING id INTO v_tc_ops; END IF;
  SELECT id INTO v_tc_saf  FROM public.task_codes WHERE tenant_id = v_tenant AND code = 'SAF';
  IF v_tc_saf  IS NULL THEN INSERT INTO public.task_codes (tenant_id, code, name) VALUES (v_tenant, 'SAF',  'Safety') RETURNING id INTO v_tc_saf; END IF;

  -- --------------------------------------------------------------------------
  -- CWPs + FCOs
  -- --------------------------------------------------------------------------
  SELECT id INTO v_cwp_found FROM public.cwps WHERE tenant_id = v_tenant AND code = 'CWP-100';
  IF v_cwp_found IS NULL THEN INSERT INTO public.cwps (tenant_id, code, description) VALUES (v_tenant, 'CWP-100', 'Foundations + Civil') RETURNING id INTO v_cwp_found; END IF;
  SELECT id INTO v_cwp_steel FROM public.cwps WHERE tenant_id = v_tenant AND code = 'CWP-200';
  IF v_cwp_steel IS NULL THEN INSERT INTO public.cwps (tenant_id, code, description) VALUES (v_tenant, 'CWP-200', 'Structural Steel') RETURNING id INTO v_cwp_steel; END IF;
  SELECT id INTO v_cwp_mech FROM public.cwps WHERE tenant_id = v_tenant AND code = 'CWP-300';
  IF v_cwp_mech IS NULL THEN INSERT INTO public.cwps (tenant_id, code, description) VALUES (v_tenant, 'CWP-300', 'Mechanical Installation') RETURNING id INTO v_cwp_mech; END IF;
  SELECT id INTO v_cwp_elec FROM public.cwps WHERE tenant_id = v_tenant AND code = 'CWP-400';
  IF v_cwp_elec IS NULL THEN INSERT INTO public.cwps (tenant_id, code, description) VALUES (v_tenant, 'CWP-400', 'Electrical + Instrumentation') RETURNING id INTO v_cwp_elec; END IF;

  SELECT id INTO v_fco_change_01 FROM public.fcos WHERE tenant_id = v_tenant AND code = 'FCO-001';
  IF v_fco_change_01 IS NULL THEN INSERT INTO public.fcos (tenant_id, code, description) VALUES (v_tenant, 'FCO-001', 'Additional foundation pour') RETURNING id INTO v_fco_change_01; END IF;
  SELECT id INTO v_fco_change_02 FROM public.fcos WHERE tenant_id = v_tenant AND code = 'FCO-002';
  IF v_fco_change_02 IS NULL THEN INSERT INTO public.fcos (tenant_id, code, description) VALUES (v_tenant, 'FCO-002', 'Scope growth — pipe spool rework') RETURNING id INTO v_fco_change_02; END IF;
  SELECT id INTO v_fco_change_03 FROM public.fcos WHERE tenant_id = v_tenant AND code = 'FCO-003';
  IF v_fco_change_03 IS NULL THEN INSERT INTO public.fcos (tenant_id, code, description) VALUES (v_tenant, 'FCO-003', 'Weather-related demobilization') RETURNING id INTO v_fco_change_03; END IF;

  -- --------------------------------------------------------------------------
  -- Employees (idempotent via (tenant_id, external_id))
  -- --------------------------------------------------------------------------
  INSERT INTO public.employees (tenant_id, external_id, first_name, last_name, type, craft, active, subcontractor_id) VALUES
    (v_tenant, 'E001', 'Alex',    'Rivera',   'staff', 'Superintendent',      true, v_sub_invenio),
    (v_tenant, 'E002', 'Priya',   'Shah',     'staff', 'Project Controls',    true, v_sub_invenio),
    (v_tenant, 'E003', 'Marco',   'DiNardo',  'field', 'Foreman',             true, v_sub_invenio),
    (v_tenant, 'E004', 'Evelyn',  'Okafor',   'field', 'Ironworker',          true, v_sub_invenio),
    (v_tenant, 'E005', 'Wes',     'Caldwell', 'field', 'Welder',              true, v_sub_acme),
    (v_tenant, 'E006', 'Nadia',   'Petrov',   'field', 'Pipefitter',          true, v_sub_acme),
    (v_tenant, 'E007', 'Luis',    'Santos',   'field', 'Pipefitter',          true, v_sub_acme),
    (v_tenant, 'E008', 'Breanna', 'Holt',     'field', 'Equipment Operator',  true, v_sub_acme),
    (v_tenant, 'E009', 'Tomás',   'Jensen',   'field', 'Electrician',         true, v_sub_buckeye),
    (v_tenant, 'E010', 'Aisha',   'Mensah',   'field', 'Electrician',         true, v_sub_buckeye),
    (v_tenant, 'E011', 'Reid',    'Bellamy',  'field', 'Instrumentation Tech', true, v_sub_buckeye),
    (v_tenant, 'E012', 'Chen',    'Yuan',     'staff', 'Safety Officer',      true, v_sub_buckeye)
  ON CONFLICT (tenant_id, external_id)
  DO UPDATE SET
    first_name       = EXCLUDED.first_name,
    last_name        = EXCLUDED.last_name,
    craft            = EXCLUDED.craft,
    subcontractor_id = EXCLUDED.subcontractor_id;

  SELECT id INTO v_emp1  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E001';
  SELECT id INTO v_emp2  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E002';
  SELECT id INTO v_emp3  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E003';
  SELECT id INTO v_emp4  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E004';
  SELECT id INTO v_emp5  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E005';
  SELECT id INTO v_emp6  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E006';
  SELECT id INTO v_emp7  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E007';
  SELECT id INTO v_emp8  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E008';
  SELECT id INTO v_emp9  FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E009';
  SELECT id INTO v_emp10 FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E010';
  SELECT id INTO v_emp11 FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E011';
  SELECT id INTO v_emp12 FROM public.employees WHERE tenant_id = v_tenant AND external_id = 'E012';

  -- Link admin user to employee #1 so staff-timesheet creation works.
  UPDATE public.users
     SET employee_id = v_emp1
   WHERE id = v_admin_id AND employee_id IS NULL;

  -- --------------------------------------------------------------------------
  -- project_subcontractors — silo membership
  -- --------------------------------------------------------------------------
  INSERT INTO public.project_subcontractors (tenant_id, project_id, subcontractor_id, start_date)
  SELECT v_tenant, p, s, '2026-01-01'
    FROM (VALUES
      (v_proj_alpha,   v_sub_invenio),
      (v_proj_alpha,   v_sub_acme),
      (v_proj_bravo,   v_sub_invenio),
      (v_proj_bravo,   v_sub_acme),
      (v_proj_bravo,   v_sub_buckeye),
      (v_proj_charlie, v_sub_invenio),
      (v_proj_charlie, v_sub_buckeye)
    ) AS v(p, s)
  ON CONFLICT DO NOTHING;

  -- --------------------------------------------------------------------------
  -- Flows + nodes + approvers
  -- --------------------------------------------------------------------------
  SELECT id INTO v_flow_simple FROM public.approval_flows
   WHERE tenant_id = v_tenant AND name = 'Standard approval';
  IF v_flow_simple IS NULL THEN
    INSERT INTO public.approval_flows (tenant_id, name, description, active)
    VALUES (v_tenant, 'Standard approval', 'Single-node: PM signs off.', true)
    RETURNING id INTO v_flow_simple;
  END IF;

  SELECT id INTO v_node_simple_1 FROM public.approval_nodes
   WHERE flow_id = v_flow_simple AND ordinal = 1;
  IF v_node_simple_1 IS NULL THEN
    INSERT INTO public.approval_nodes (tenant_id, flow_id, ordinal, name)
    VALUES (v_tenant, v_flow_simple, 1, 'Project Manager')
    RETURNING id INTO v_node_simple_1;
  END IF;

  INSERT INTO public.approval_node_approvers (tenant_id, node_id, approver_type, user_id)
  SELECT v_tenant, v_node_simple_1, 'user'::public.approver_ref_type, v_admin_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.approval_node_approvers
     WHERE node_id = v_node_simple_1 AND user_id = v_admin_id
  );

  -- Two-step flow
  SELECT id INTO v_flow_twostep FROM public.approval_flows
   WHERE tenant_id = v_tenant AND name = 'PM then Accounting';
  IF v_flow_twostep IS NULL THEN
    INSERT INTO public.approval_flows (tenant_id, name, description, active)
    VALUES (v_tenant, 'PM then Accounting', 'Two-node: PM first, then Accounting.', true)
    RETURNING id INTO v_flow_twostep;
  END IF;

  SELECT id INTO v_node_two_1 FROM public.approval_nodes
   WHERE flow_id = v_flow_twostep AND ordinal = 1;
  IF v_node_two_1 IS NULL THEN
    INSERT INTO public.approval_nodes (tenant_id, flow_id, ordinal, name)
    VALUES (v_tenant, v_flow_twostep, 1, 'Project Manager')
    RETURNING id INTO v_node_two_1;
  END IF;
  SELECT id INTO v_node_two_2 FROM public.approval_nodes
   WHERE flow_id = v_flow_twostep AND ordinal = 2;
  IF v_node_two_2 IS NULL THEN
    INSERT INTO public.approval_nodes (tenant_id, flow_id, ordinal, name)
    VALUES (v_tenant, v_flow_twostep, 2, 'Accounting')
    RETURNING id INTO v_node_two_2;
  END IF;

  INSERT INTO public.approval_node_approvers (tenant_id, node_id, approver_type, user_id)
  SELECT v_tenant, v_node_two_1, 'user'::public.approver_ref_type, v_admin_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.approval_node_approvers
     WHERE node_id = v_node_two_1 AND user_id = v_admin_id
  );
  INSERT INTO public.approval_node_approvers (tenant_id, node_id, approver_type, user_id)
  SELECT v_tenant, v_node_two_2, 'user'::public.approver_ref_type, v_admin_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.approval_node_approvers
     WHERE node_id = v_node_two_2 AND user_id = v_admin_id
  );

  -- --------------------------------------------------------------------------
  -- project_flow_assignments — attach flows to projects
  -- --------------------------------------------------------------------------
  INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from)
  VALUES (v_tenant, v_proj_alpha, v_flow_simple, '2026-01-01')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from)
  VALUES (v_tenant, v_proj_bravo, v_flow_twostep, '2026-01-01')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.project_flow_assignments (tenant_id, project_id, flow_id, effective_from)
  VALUES (v_tenant, v_proj_charlie, v_flow_simple, '2026-01-01')
  ON CONFLICT DO NOTHING;

  -- --------------------------------------------------------------------------
  -- submitter_assignments — let the admin claim field timesheets
  -- --------------------------------------------------------------------------
  INSERT INTO public.submitter_assignments (tenant_id, user_id, project_id, subcontractor_id)
  SELECT v_tenant, v_admin_id, p, s
    FROM (VALUES
      (v_proj_alpha,   v_sub_invenio),
      (v_proj_alpha,   v_sub_acme),
      (v_proj_bravo,   v_sub_invenio),
      (v_proj_bravo,   v_sub_acme),
      (v_proj_bravo,   v_sub_buckeye),
      (v_proj_charlie, v_sub_buckeye)
    ) AS v(p, s)
  ON CONFLICT DO NOTHING;

  -- --------------------------------------------------------------------------
  -- silo_role_assignments — admin as timekeeper_admin on each silo
  -- --------------------------------------------------------------------------
  INSERT INTO public.silo_role_assignments (tenant_id, project_id, subcontractor_id, role_label, user_id, effective_from)
  SELECT v_tenant, p, s, 'timekeeper_admin', v_admin_id, '2026-01-01'
    FROM (VALUES
      (v_proj_alpha,   v_sub_invenio),
      (v_proj_alpha,   v_sub_acme),
      (v_proj_bravo,   v_sub_invenio),
      (v_proj_bravo,   v_sub_acme),
      (v_proj_bravo,   v_sub_buckeye),
      (v_proj_charlie, v_sub_invenio),
      (v_proj_charlie, v_sub_buckeye)
    ) AS v(p, s)
  ON CONFLICT DO NOTHING;

  -- project_role_assignments — admin as PM on every project
  INSERT INTO public.project_role_assignments (tenant_id, project_id, role_label, user_id, effective_from)
  VALUES
    (v_tenant, v_proj_alpha,   'pm', v_admin_id, '2026-01-01'),
    (v_tenant, v_proj_bravo,   'pm', v_admin_id, '2026-01-01'),
    (v_tenant, v_proj_charlie, 'pm', v_admin_id, '2026-01-01')
  ON CONFLICT DO NOTHING;

  -- --------------------------------------------------------------------------
  -- Timesheets — 4 staff (varied statuses) + 2 field (open + draft)
  -- Each inserted with deterministic period_start so re-runs find them.
  -- --------------------------------------------------------------------------

  -- Staff #1 — DRAFT (current week, admin's own)
  SELECT id INTO v_ts1 FROM public.timesheets
   WHERE tenant_id = v_tenant AND employee_id = v_emp1
     AND kind = 'staff' AND period_start = v_week_mon - 14;
  IF v_ts1 IS NULL THEN
    INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end)
    VALUES (v_tenant, 'staff', 'draft', v_admin_id, v_emp1, v_proj_alpha, v_sub_invenio,
            v_week_mon - 14, v_week_mon - 8)
    RETURNING id INTO v_ts1;
    INSERT INTO public.timesheet_lines (tenant_id, timesheet_id, date, area_id, task_code_id, cwp_id, fco_id, employee_id, hours_st, hours_ot) VALUES
      (v_tenant, v_ts1, v_week_mon - 14, v_area_a1, v_tc_carp, v_cwp_found, NULL, v_emp1, 8, 0),
      (v_tenant, v_ts1, v_week_mon - 13, v_area_a1, v_tc_carp, v_cwp_found, NULL, v_emp1, 8, 2),
      (v_tenant, v_ts1, v_week_mon - 12, v_area_a1, v_tc_carp, v_cwp_found, NULL, v_emp1, 8, 0),
      (v_tenant, v_ts1, v_week_mon - 11, v_area_a2, v_tc_lab,  v_cwp_steel, NULL, v_emp1, 8, 0),
      (v_tenant, v_ts1, v_week_mon - 10, v_area_a2, v_tc_lab,  v_cwp_steel, NULL, v_emp1, 8, 0);
  END IF;

  -- Staff #2 — SUBMITTED (last week, admin's own) — opens a run
  SELECT id INTO v_ts2 FROM public.timesheets
   WHERE tenant_id = v_tenant AND employee_id = v_emp1
     AND kind = 'staff' AND period_start = v_week_mon - 7;
  IF v_ts2 IS NULL THEN
    INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, submitted_at)
    VALUES (v_tenant, 'staff', 'draft', v_admin_id, v_emp1, v_proj_bravo, v_sub_invenio,
            v_week_mon - 7, v_week_mon - 1, NULL)
    RETURNING id INTO v_ts2;
    INSERT INTO public.timesheet_lines (tenant_id, timesheet_id, date, area_id, task_code_id, cwp_id, fco_id, employee_id, hours_st, hours_ot) VALUES
      (v_tenant, v_ts2, v_week_mon - 7, v_area_b1, v_tc_iron, v_cwp_steel, NULL, v_emp1, 8, 1),
      (v_tenant, v_ts2, v_week_mon - 6, v_area_b1, v_tc_iron, v_cwp_steel, NULL, v_emp1, 8, 1),
      (v_tenant, v_ts2, v_week_mon - 5, v_area_b2, v_tc_iron, v_cwp_steel, NULL, v_emp1, 8, 0),
      (v_tenant, v_ts2, v_week_mon - 4, v_area_b2, v_tc_iron, v_cwp_steel, NULL, v_emp1, 8, 0),
      (v_tenant, v_ts2, v_week_mon - 3, v_area_b3, v_tc_iron, v_cwp_steel, NULL, v_emp1, 8, 0);
    -- Submit it via the RPC so a proper approval_run is created. Must run as
    -- the submitter (admin) — we set auth context via SECURITY DEFINER is NOT
    -- possible here; instead we leave it 'draft' and note that the demoer
    -- should click Submit in the UI. This still gives us a draft to submit.
  END IF;

  -- Staff #3 — APPROVED (2 weeks ago, admin's own — set state directly for demo)
  SELECT id INTO v_ts3 FROM public.timesheets
   WHERE tenant_id = v_tenant AND employee_id = v_emp2
     AND kind = 'staff' AND period_start = v_week_mon - 21;
  IF v_ts3 IS NULL THEN
    INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, submitted_at)
    VALUES (v_tenant, 'staff', 'approved', v_admin_id, v_emp2, v_proj_alpha, v_sub_invenio,
            v_week_mon - 21, v_week_mon - 15, now() - interval '15 days')
    RETURNING id INTO v_ts3;
    INSERT INTO public.timesheet_lines (tenant_id, timesheet_id, date, area_id, task_code_id, cwp_id, fco_id, employee_id, hours_st, hours_ot) VALUES
      (v_tenant, v_ts3, v_week_mon - 21, v_area_a1, v_tc_saf, v_cwp_found, NULL, v_emp2, 8, 0),
      (v_tenant, v_ts3, v_week_mon - 20, v_area_a1, v_tc_saf, v_cwp_found, NULL, v_emp2, 8, 0),
      (v_tenant, v_ts3, v_week_mon - 19, v_area_a2, v_tc_saf, v_cwp_steel, NULL, v_emp2, 8, 0),
      (v_tenant, v_ts3, v_week_mon - 18, v_area_a2, v_tc_saf, v_cwp_steel, NULL, v_emp2, 8, 0),
      (v_tenant, v_ts3, v_week_mon - 17, v_area_a2, v_tc_saf, v_cwp_steel, NULL, v_emp2, 8, 0);
  END IF;

  -- Staff #4 — REJECTED (2 weeks ago)
  SELECT id INTO v_ts4 FROM public.timesheets
   WHERE tenant_id = v_tenant AND employee_id = v_emp12
     AND kind = 'staff' AND period_start = v_week_mon - 21;
  IF v_ts4 IS NULL THEN
    INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, submitted_at)
    VALUES (v_tenant, 'staff', 'rejected', v_admin_id, v_emp12, v_proj_charlie, v_sub_buckeye,
            v_week_mon - 21, v_week_mon - 15, now() - interval '14 days')
    RETURNING id INTO v_ts4;
    INSERT INTO public.timesheet_lines (tenant_id, timesheet_id, date, area_id, task_code_id, cwp_id, fco_id, employee_id, hours_st, hours_ot) VALUES
      (v_tenant, v_ts4, v_week_mon - 21, v_area_c1, v_tc_saf, v_cwp_mech, NULL, v_emp12, 4, 0),
      (v_tenant, v_ts4, v_week_mon - 20, v_area_c1, v_tc_saf, v_cwp_mech, NULL, v_emp12, 4, 0);
  END IF;

  -- Field #1 — OPEN (today, ready to be claimed)
  SELECT id INTO v_ts_field_open FROM public.timesheets
   WHERE tenant_id = v_tenant AND kind = 'field' AND status = 'open'
     AND period_start = current_date AND project_id = v_proj_bravo;
  IF v_ts_field_open IS NULL THEN
    INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, project_id, subcontractor_id, period_start, period_end)
    VALUES (v_tenant, 'field', 'open', NULL, v_proj_bravo, v_sub_acme, current_date, current_date)
    RETURNING id INTO v_ts_field_open;
  END IF;

  -- Field #2 — DRAFT (yesterday, claimed by admin, has lines)
  SELECT id INTO v_ts_field_draft FROM public.timesheets
   WHERE tenant_id = v_tenant AND kind = 'field' AND submitter_user_id = v_admin_id
     AND period_start = current_date - 1 AND project_id = v_proj_bravo;
  IF v_ts_field_draft IS NULL THEN
    INSERT INTO public.timesheets (tenant_id, kind, status, submitter_user_id, project_id, subcontractor_id, period_start, period_end)
    VALUES (v_tenant, 'field', 'draft', v_admin_id, v_proj_bravo, v_sub_acme,
            current_date - 1, current_date - 1)
    RETURNING id INTO v_ts_field_draft;
    INSERT INTO public.timesheet_lines (tenant_id, timesheet_id, date, area_id, task_code_id, cwp_id, fco_id, employee_id, hours_st, hours_ot) VALUES
      (v_tenant, v_ts_field_draft, current_date - 1, v_area_b1, v_tc_weld, v_cwp_mech, NULL, v_emp5, 10, 2),
      (v_tenant, v_ts_field_draft, current_date - 1, v_area_b1, v_tc_pipe, v_cwp_mech, NULL, v_emp6, 10, 2),
      (v_tenant, v_ts_field_draft, current_date - 1, v_area_b1, v_tc_pipe, v_cwp_mech, NULL, v_emp7, 10, 2),
      (v_tenant, v_ts_field_draft, current_date - 1, v_area_b1, v_tc_ops,  v_cwp_mech, NULL, v_emp8, 10, 2);
  END IF;

  RAISE NOTICE 'Seed complete. Admin linked to % (% %). Timesheets created: %',
    v_emp1, (SELECT first_name FROM public.employees WHERE id = v_emp1),
    (SELECT last_name FROM public.employees WHERE id = v_emp1),
    (SELECT count(*) FROM public.timesheets WHERE tenant_id = v_tenant);
END
$seed$;

COMMIT;
