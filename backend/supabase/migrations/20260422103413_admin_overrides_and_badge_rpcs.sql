-- ============================================================================
-- Admin override + badge-override RPCs (Batch 4c) — spec §7.5, §7.7
-- ----------------------------------------------------------------------------
-- RPCs:
--   reassign_run(p_run_id, p_to_user_id, p_reason, p_idempotency_key?)
--     — §7.5 targeted reassignment (admin-only).
--   override_run(p_run_id, p_decision, p_comment, p_idempotency_key?)
--     — §7.5 admin override, bypasses _is_eligible_approver (admin-only).
--   create_badge_override(...)
--     — §7.7 retroactive creation (admin or silo timekeeper_admin).
--   resolve_badge_override(p_override_id, p_outcome, p_reason, p_idempotency_key?)
--     — §7.7 resolution (admin or silo timekeeper_admin).
--
-- Schema patch: badge_overrides gains project_id + subcontractor_id so we can
-- authorize by silo-role assignment on resolution. Safe to add NOT NULL
-- without a default because there are no existing rows in v1.
--
-- Deliberate scope deferrals to 4d / later batches:
--   * Automatic badge-override detection at timesheet_lines INSERT — depends
--     on a badge_records table not defined in the spec.
--   * Parent-run side-effects of resolved_badge_canonical (§7.7 table): when
--     parent is 'open', spec asks us to transition it to 'rejected' with
--     reason 'HOURS_RECONCILED_TO_BADGE'. Not implemented here — the badge
--     override resolves independently; the parent stays unchanged. Noted
--     in resolve_badge_override's body.
--   * Approval_runs-based badge-override lifecycle (spec §7.7 "single-node
--     run"). We treat badge_overrides.status + audit_events as the audit
--     trail. Deviation documented in the Batch 4c commit.
-- ============================================================================

-- ---- Schema patch ----------------------------------------------------------
ALTER TABLE public.badge_overrides
  ADD COLUMN project_id       uuid NOT NULL REFERENCES public.projects(id)        ON DELETE RESTRICT,
  ADD COLUMN subcontractor_id uuid NOT NULL REFERENCES public.subcontractors(id)  ON DELETE RESTRICT;

CREATE INDEX badge_overrides_silo_idx
  ON public.badge_overrides (tenant_id, project_id, subcontractor_id);

-- ============================================================================
-- reassign_run — §7.5 targeted reassignment
-- ----------------------------------------------------------------------------
-- Admin replaces the current node's approver pool (for THIS run only) with
-- `to_user_id`. Writes both approval_reassignments and approval_actions
-- (action=reassign). Does NOT advance the run — the reassignee must still
-- act. Subsequent approve_run / reject_run calls by the reassignee pass
-- _is_eligible_approver via the approval_reassignments-overlay branch.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reassign_run(
  p_run_id          uuid,
  p_to_user_id      uuid,
  p_reason          text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid    := (auth.jwt() ->> 'tenant_id')::uuid;
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_actor        uuid    := (SELECT auth.uid());
  v_cached       jsonb;
  v_r            record;
  v_rows         integer;
  v_result       jsonb;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  IF NOT v_is_admin THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='reassign_run is admin-only';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='reassign_run requires a non-empty reason';
  END IF;

  v_cached := public._idempotency_begin(p_idempotency_key);
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  SELECT * INTO v_r FROM public.approval_runs
   WHERE id = p_run_id AND tenant_id = v_tenant_claim FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('run %s not found in tenant', p_run_id);
  END IF;
  IF v_r.status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL=jsonb_build_object('run_id', p_run_id, 'status', v_r.status,
                                'version', v_r.version)::text;
  END IF;

  -- Target user must be in the tenant + active.
  IF NOT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = p_to_user_id
       AND tenant_id = v_tenant_claim
       AND status = 'active'
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL=format('to_user_id %s is not an active user in this tenant', p_to_user_id);
  END IF;

  -- Version-keyed bump only — no status / current_node_id change.
  UPDATE public.approval_runs SET version = version + 1
   WHERE id = p_run_id AND version = v_r.version;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL='Conditional UPDATE found no matching version';
  END IF;

  INSERT INTO public.approval_reassignments (tenant_id, run_id, node_id, from_user_id, to_user_id, reason, admin_user_id)
  VALUES (v_tenant_claim, p_run_id, v_r.current_node_id, NULL, p_to_user_id, p_reason, v_actor);

  INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action, comment)
  VALUES (v_tenant_claim, p_run_id, v_r.current_node_id, v_actor, 'reassign', p_reason);

  v_result := jsonb_build_object(
    'ok', true, 'run_id', p_run_id, 'status', v_r.status,
    'current_node_id', v_r.current_node_id,
    'reassigned_to', p_to_user_id,
    'version', v_r.version + 1
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reassign_run(uuid, uuid, text, text) TO authenticated;

-- ============================================================================
-- override_run — §7.5 admin override
-- ----------------------------------------------------------------------------
-- Admin bypasses the eligibility check and directly approves or rejects the
-- current node. On approve of a mid-flow node the run advances; on terminal
-- or reject, timesheet status is updated accordingly.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.override_run(
  p_run_id          uuid,
  p_decision        text,     -- 'approve' | 'reject'
  p_comment         text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid    := (auth.jwt() ->> 'tenant_id')::uuid;
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_actor        uuid    := (SELECT auth.uid());
  v_cached       jsonb;
  v_r            record;
  v_current_ord  integer;
  v_max_ord      integer;
  v_next_node    uuid;
  v_new_status   public.approval_run_status;
  v_new_node     uuid;
  v_new_closed   timestamptz;
  v_rows         integer;
  v_result       jsonb;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  IF NOT v_is_admin THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='override_run is admin-only';
  END IF;
  IF p_decision NOT IN ('approve','reject') THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='decision must be approve or reject';
  END IF;
  IF p_comment IS NULL OR btrim(p_comment) = '' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='override_run requires a non-empty comment';
  END IF;

  v_cached := public._idempotency_begin(p_idempotency_key);
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  SELECT * INTO v_r FROM public.approval_runs
   WHERE id = p_run_id AND tenant_id = v_tenant_claim FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('run %s not found in tenant', p_run_id);
  END IF;
  IF v_r.status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL=jsonb_build_object('run_id', p_run_id, 'status', v_r.status,
                                'version', v_r.version)::text;
  END IF;

  IF p_decision = 'reject' THEN
    v_new_status := 'rejected';
    v_new_node   := NULL;
    v_new_closed := now();
  ELSE
    SELECT ordinal INTO v_current_ord FROM public.approval_nodes WHERE id = v_r.current_node_id;
    SELECT max(ordinal) INTO v_max_ord FROM public.approval_nodes WHERE flow_id = v_r.flow_id;
    IF v_current_ord < v_max_ord THEN
      SELECT id INTO v_next_node FROM public.approval_nodes
       WHERE flow_id = v_r.flow_id AND ordinal = v_current_ord + 1;
      v_new_status := 'open';
      v_new_node   := v_next_node;
      v_new_closed := NULL;
    ELSE
      v_new_status := 'approved';
      v_new_node   := NULL;
      v_new_closed := now();
    END IF;
  END IF;

  UPDATE public.approval_runs
     SET status = v_new_status,
         current_node_id = v_new_node,
         closed_at       = v_new_closed,
         version         = version + 1
   WHERE id = p_run_id AND version = v_r.version;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL='Conditional UPDATE found no matching version';
  END IF;

  INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action, comment)
  VALUES (v_tenant_claim, p_run_id, v_r.current_node_id, v_actor, 'admin_override', p_comment);

  IF v_new_status = 'approved' THEN
    UPDATE public.timesheets SET status='approved' WHERE id = v_r.timesheet_id;
  ELSIF v_new_status = 'rejected' THEN
    UPDATE public.timesheets SET status='rejected' WHERE id = v_r.timesheet_id;
  END IF;

  v_result := jsonb_build_object(
    'ok', true, 'run_id', p_run_id, 'status', v_new_status,
    'current_node_id', v_new_node, 'version', v_r.version + 1,
    'terminal', (v_new_status IN ('approved','rejected')),
    'decision', p_decision
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.override_run(uuid, text, text, text) TO authenticated;

-- ============================================================================
-- create_badge_override — §7.7 retroactive creation
-- ----------------------------------------------------------------------------
-- Caller: admin OR a user with submitter_assignments on (project, sub) —
-- representing the "timekeeper noticed a badge gap" path in §7.7 item 2.
-- The stricter silo_role_assignments('timekeeper_admin') check is applied
-- by resolve_badge_override; creation is more permissive.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_badge_override(
  p_employee_id        uuid,
  p_date               date,
  p_project_id         uuid,
  p_subcontractor_id   uuid,
  p_submitted_hours_st numeric,
  p_submitted_hours_ot numeric,
  p_badge_hours_st     numeric,
  p_badge_hours_ot     numeric,
  p_timesheet_line_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid    := (auth.jwt() ->> 'tenant_id')::uuid;
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_actor        uuid    := (SELECT auth.uid());
  v_id           uuid    := gen_random_uuid();
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  -- Authz: admin OR proxy-submitter on the silo.
  IF NOT v_is_admin AND NOT EXISTS (
    SELECT 1 FROM public.submitter_assignments
     WHERE user_id = v_actor
       AND project_id = p_project_id
       AND subcontractor_id = p_subcontractor_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Only admin or a silo submitter can create a badge override';
  END IF;

  -- Validate the silo + employee belong to the tenant (tenant-spoofing check).
  IF NOT EXISTS (SELECT 1 FROM public.projects      WHERE id = p_project_id       AND tenant_id = v_tenant_claim)
     OR NOT EXISTS (SELECT 1 FROM public.subcontractors WHERE id = p_subcontractor_id AND tenant_id = v_tenant_claim)
     OR NOT EXISTS (SELECT 1 FROM public.employees     WHERE id = p_employee_id      AND tenant_id = v_tenant_claim)
  THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='project, subcontractor, or employee not found in tenant';
  END IF;

  INSERT INTO public.badge_overrides (
    id, tenant_id, timesheet_line_id, employee_id, date,
    project_id, subcontractor_id,
    submitted_hours_st, submitted_hours_ot, badge_hours_st, badge_hours_ot,
    status, opened_by_user_id
  ) VALUES (
    v_id, v_tenant_claim, p_timesheet_line_id, p_employee_id, p_date,
    p_project_id, p_subcontractor_id,
    p_submitted_hours_st, p_submitted_hours_ot, p_badge_hours_st, p_badge_hours_ot,
    'open', v_actor
  );

  INSERT INTO public.audit_events (tenant_id, actor_user_id, action_type, subject_type, subject_id, details)
  VALUES (v_tenant_claim, v_actor, 'badge_override.open', 'badge_override', v_id,
          jsonb_build_object('employee_id', p_employee_id, 'date', p_date,
                             'project_id', p_project_id, 'subcontractor_id', p_subcontractor_id));

  RETURN jsonb_build_object('ok', true, 'badge_override_id', v_id, 'status', 'open');
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_badge_override(uuid, date, uuid, uuid, numeric, numeric, numeric, numeric, uuid) TO authenticated;

-- ============================================================================
-- resolve_badge_override — §7.7 resolution
-- ----------------------------------------------------------------------------
-- Caller: admin OR timekeeper_admin (via silo_role_assignments) on the
-- override's (project, sub). Writes the resolution to the badge_overrides
-- row directly and to audit_events for the trail.
--
-- NOT YET IMPLEMENTED (deferred to 4d): parent-run side-effects of
-- 'resolved_badge_canonical' (§7.7 table — open parent → rejected with
-- reason HOURS_RECONCILED_TO_BADGE; approved parent → audit event
-- parent_approval_invalidated). The resolution is recorded correctly;
-- cascading updates are a follow-up.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_badge_override(
  p_override_id     uuid,
  p_outcome         text,   -- 'resolved_submitted_canonical' | 'resolved_badge_canonical'
  p_reason          text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid    := (auth.jwt() ->> 'tenant_id')::uuid;
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_actor        uuid    := (SELECT auth.uid());
  v_cached       jsonb;
  v_bo           record;
  v_outcome      public.badge_override_status;
  v_result       jsonb;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  IF p_outcome NOT IN ('resolved_submitted_canonical', 'resolved_badge_canonical') THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='outcome must be resolved_submitted_canonical or resolved_badge_canonical';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='resolve_badge_override requires a non-empty reason';
  END IF;

  v_cached := public._idempotency_begin(p_idempotency_key);
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  SELECT * INTO v_bo FROM public.badge_overrides
   WHERE id = p_override_id AND tenant_id = v_tenant_claim FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('badge_override %s not found in tenant', p_override_id);
  END IF;
  IF v_bo.status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL=jsonb_build_object('badge_override_id', p_override_id,
                                'status', v_bo.status)::text;
  END IF;

  -- Authz: admin OR current timekeeper_admin on (project, sub).
  IF NOT v_is_admin AND NOT EXISTS (
    SELECT 1 FROM public.silo_role_assignments
     WHERE project_id = v_bo.project_id
       AND subcontractor_id = v_bo.subcontractor_id
       AND role_label = 'timekeeper_admin'
       AND user_id = v_actor
       AND effective_from <= current_date
       AND (effective_to IS NULL OR effective_to >= current_date)
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Only admin or a silo timekeeper_admin can resolve this override';
  END IF;

  v_outcome := p_outcome::public.badge_override_status;

  UPDATE public.badge_overrides
     SET status = v_outcome,
         reason = p_reason,
         resolved_by_user_id = v_actor,
         resolved_at = now()
   WHERE id = p_override_id;

  INSERT INTO public.audit_events (tenant_id, actor_user_id, action_type, subject_type, subject_id, details)
  VALUES (v_tenant_claim, v_actor, 'badge_override.resolve', 'badge_override', p_override_id,
          jsonb_build_object('outcome', p_outcome, 'reason', p_reason));

  -- TODO (Batch 4d): parent-run cascade when outcome='resolved_badge_canonical'
  -- and v_bo.timesheet_line_id -> parent timesheet has an open approval_run.
  -- Per §7.7 that should transition the parent to 'rejected' with reason
  -- HOURS_RECONCILED_TO_BADGE. For 4c the badge resolution stands alone.

  v_result := jsonb_build_object(
    'ok', true,
    'badge_override_id', p_override_id,
    'status', v_outcome::text,
    'parent_run_cascade', false  -- explicit: cascade is 4d work
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.resolve_badge_override(uuid, text, text, text) TO authenticated;
