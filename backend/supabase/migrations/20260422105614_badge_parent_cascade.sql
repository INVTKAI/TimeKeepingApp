-- ============================================================================
-- resolve_badge_override: parent-run cascade on resolved_badge_canonical
-- (Batch 4d) — closes §7.7 TODO flagged in Batch 4c.
-- ----------------------------------------------------------------------------
-- When an override is resolved with outcome='resolved_badge_canonical' AND
-- the override is tied to a specific timesheet_line_id, look up that line's
-- parent timesheet and its latest approval_run:
--
--   * Parent run 'open' (still mid-approval): version-checked UPDATE to
--     'rejected', close the run, transition the timesheet to 'rejected', and
--     write an approval_actions row with action='admin_override' and comment
--     'HOURS_RECONCILED_TO_BADGE' — attributing the reject to the resolver
--     (the timekeeper_admin or admin who resolved).
--   * Parent run 'approved' (terminal): write an audit_events row with
--     action_type='approval.parent_approval_invalidated'. Per §7.7 the admin
--     handles subsequent remediation (replacement run or follow-on correction
--     timesheet). Tenant-admin notification lands in Batch 5.
--   * Other states (rejected / recalled / abandoned) or no run found: no-op.
--
-- For the 'resolved_submitted_canonical' outcome: unchanged from 4c — no
-- parent effect.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_badge_override(
  p_override_id     uuid,
  p_outcome         text,
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
  v_parent_line  record;   -- parent timesheet + any open run
  v_parent_run   record;
  v_rows         integer;
  v_cascade_kind text := 'none';  -- 'rejected' | 'invalidated' | 'none'
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

  -- Parent-run cascade — only on resolved_badge_canonical AND when the
  -- override is tied to a specific line (retroactive overrides with NULL
  -- timesheet_line_id have no parent run to cascade to).
  IF v_outcome = 'resolved_badge_canonical' AND v_bo.timesheet_line_id IS NOT NULL THEN
    SELECT tl.timesheet_id AS ts_id INTO v_parent_line
      FROM public.timesheet_lines tl
      WHERE tl.id = v_bo.timesheet_line_id;
    IF FOUND THEN
      SELECT * INTO v_parent_run
        FROM public.approval_runs r
        WHERE r.timesheet_id = v_parent_line.ts_id
        ORDER BY r.opened_at DESC LIMIT 1
        FOR UPDATE;
      IF FOUND THEN
        IF v_parent_run.status = 'open' THEN
          UPDATE public.approval_runs
             SET status='rejected',
                 current_node_id = NULL,
                 closed_at = now(),
                 version = version + 1
           WHERE id = v_parent_run.id
             AND version = v_parent_run.version;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows = 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
              DETAIL='Parent run version changed between lookup and cascade update';
          END IF;
          INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action, comment)
          VALUES (v_tenant_claim, v_parent_run.id, v_parent_run.current_node_id, v_actor,
                  'admin_override', 'HOURS_RECONCILED_TO_BADGE');
          UPDATE public.timesheets SET status='rejected' WHERE id = v_parent_line.ts_id;
          v_cascade_kind := 'rejected';
        ELSIF v_parent_run.status = 'approved' THEN
          -- Already-approved parent: record the invalidation for admin follow-up.
          INSERT INTO public.audit_events (tenant_id, actor_user_id, action_type, subject_type, subject_id, details)
          VALUES (v_tenant_claim, v_actor, 'approval.parent_approval_invalidated',
                  'approval_run', v_parent_run.id,
                  jsonb_build_object('badge_override_id', p_override_id,
                                     'reason', 'HOURS_RECONCILED_TO_BADGE'));
          v_cascade_kind := 'invalidated';
        END IF;
        -- Other parent states (rejected / recalled / abandoned): no-op.
      END IF;
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'badge_override_id', p_override_id,
    'status', v_outcome::text,
    'parent_run_cascade', v_cascade_kind  -- 'none' | 'rejected' | 'invalidated'
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

-- Keep the existing GRANT (from 4c); CREATE OR REPLACE preserves privileges.
