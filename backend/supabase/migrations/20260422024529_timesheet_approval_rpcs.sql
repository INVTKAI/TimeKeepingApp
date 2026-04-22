-- ============================================================================
-- Timesheet + approval state-machine RPCs (Batch 4b) — spec §7.4, §8
-- ----------------------------------------------------------------------------
-- Mutating RPCs: submit_timesheet, approve_run, reject_run, recall_run,
--                claim_field_timesheet, release_field_timesheet
-- Read RPCs:     project_readiness, my_pending_approvals
--
-- All mutating RPCs are SECURITY DEFINER because §4a's RLS on
-- approval_runs / approval_actions / approval_reassignments is tenant-SELECT
-- only; writes bypass via SDef and do their own authorization checks.
--
-- Every mutating RPC begins with:
--   PERFORM public.assert_tenant_claim_present();
--   PERFORM public.assert_session_live();
-- per §11.6 — the pgTAP static gate matches `approve_*`, `reject_*`,
-- `recall_*`, `submit_*`, `resolve_*`, `reassign_*`, `override_*`.
-- `claim_field_timesheet` + `release_field_timesheet` don't match a guarded
-- prefix but are state-mutating, so they call the helpers defensively.
--
-- Error codes (spec §8):
--   P0001 PROJECT_NOT_READY         — submit precondition missing; DETAIL is
--                                     jsonb {missing: [...]}::text
--   P0002 RUN_STATE_CHANGED         — version mismatch on conditional UPDATE
--   P0003 INVALID_STATE_TRANSITION  — current state doesn't permit action
--   P0004 APPROVER_NOT_ELIGIBLE     — also used for submitter-not-authorized
--                                     and recaller-not-original-submitter
--   P0008 IDEMPOTENCY_CONFLICT      — same (actor, key) in-flight
--
-- DEFERRED to Batch 4c: reassign_run, override_run, badge-override detection
-- on INSERT INTO timesheet_lines, resolve_badge_override.
-- DEFERRED to Batch 5:  notification_outbox + pg_cron drain + Resend.
-- ============================================================================

-- ============================================================================
-- Internal helper: _is_eligible_approver
-- ----------------------------------------------------------------------------
-- Resolves the eligible-actor set for a run's CURRENT node (§7.1) AND the
-- targeted-reassignment overlay (§7.5). Returns true if the given actor is
-- in the union.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._is_eligible_approver(p_run_id uuid, p_actor_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current_node    uuid;
  v_project_id      uuid;
  v_subcontractor   uuid;
BEGIN
  SELECT r.current_node_id, t.project_id, t.subcontractor_id
    INTO v_current_node, v_project_id, v_subcontractor
    FROM public.approval_runs r
    JOIN public.timesheets t ON t.id = r.timesheet_id
    WHERE r.id = p_run_id
      AND r.status = 'open';
  IF NOT FOUND THEN
    RETURN false;  -- run not open or not found
  END IF;

  -- Targeted reassignment overrides the pool for the current node/run.
  IF EXISTS (
    SELECT 1 FROM public.approval_reassignments ar
     WHERE ar.run_id = p_run_id
       AND ar.node_id = v_current_node
       AND ar.to_user_id = p_actor_user_id
  ) THEN
    RETURN true;
  END IF;

  -- Direct user reference.
  IF EXISTS (
    SELECT 1 FROM public.approval_node_approvers na
     WHERE na.node_id = v_current_node
       AND na.approver_type = 'user'
       AND na.user_id = p_actor_user_id
  ) THEN
    RETURN true;
  END IF;

  -- Silo-role reference.
  IF EXISTS (
    SELECT 1
      FROM public.approval_node_approvers na
      JOIN public.silo_role_assignments  sra
        ON sra.role_label = na.role_label
       AND sra.project_id = v_project_id
       AND sra.subcontractor_id = v_subcontractor
       AND sra.user_id = p_actor_user_id
       AND sra.effective_from <= current_date
       AND (sra.effective_to IS NULL OR sra.effective_to >= current_date)
     WHERE na.node_id = v_current_node
       AND na.approver_type = 'role_on_silo'
  ) THEN
    RETURN true;
  END IF;

  -- Project-role reference.
  IF EXISTS (
    SELECT 1
      FROM public.approval_node_approvers na
      JOIN public.project_role_assignments pra
        ON pra.role_label = na.role_label
       AND pra.project_id = v_project_id
       AND pra.user_id = p_actor_user_id
       AND pra.effective_from <= current_date
       AND (pra.effective_to IS NULL OR pra.effective_to >= current_date)
     WHERE na.node_id = v_current_node
       AND na.approver_type = 'role_on_project'
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

-- Internal — no grants to authenticated. Only callable from other SDef RPCs.
REVOKE ALL ON FUNCTION public._is_eligible_approver(uuid, uuid) FROM public, anon, authenticated;

-- ============================================================================
-- Internal helper: idempotency begin/commit
-- ----------------------------------------------------------------------------
-- Begin: returns cached response if (actor, key) already committed;
--        claims the key via PK INSERT if not. Raises P0008 on concurrent race.
-- Commit: stores the result on the claimed row.
-- Both are SDef — idempotency_keys is revoked from authenticated.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._idempotency_begin(p_key text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   uuid := (SELECT auth.uid());
  v_cached  jsonb;
BEGIN
  IF p_key IS NULL OR p_key = '' THEN
    RETURN NULL;  -- no idempotency requested
  END IF;

  SELECT response INTO v_cached
    FROM public.idempotency_keys
    WHERE actor_user_id = v_actor AND key = p_key;
  IF v_cached IS NOT NULL THEN
    RETURN v_cached;  -- caller returns this directly
  END IF;

  -- Reserve the (actor, key) slot. On PK conflict the SELECT above would
  -- have already returned the cached row; reaching here means the other
  -- writer hasn't committed response yet -> treat as in-flight.
  BEGIN
    INSERT INTO public.idempotency_keys (actor_user_id, key) VALUES (v_actor, p_key);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION USING ERRCODE='P0008',
      MESSAGE='IDEMPOTENCY_CONFLICT',
      DETAIL='Another request with the same (actor, key) is in flight';
  END;

  RETURN NULL;  -- proceed; caller stores result via _idempotency_commit
END;
$$;

CREATE OR REPLACE FUNCTION public._idempotency_commit(p_key text, p_result jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_key IS NULL OR p_key = '' THEN RETURN; END IF;
  UPDATE public.idempotency_keys
    SET response = p_result
   WHERE actor_user_id = (SELECT auth.uid()) AND key = p_key;
END;
$$;

REVOKE ALL ON FUNCTION public._idempotency_begin(text)         FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public._idempotency_commit(text, jsonb) FROM public, anon, authenticated;

-- ============================================================================
-- Internal helper: _resolve_project_readiness
-- ----------------------------------------------------------------------------
-- Returns a text[] of missing-configuration identifiers. Empty array means
-- the project is fully ready for submission. Checked at submit time and
-- exposed read-only as the `project_readiness` RPC.
--
-- What we check:
--   1. An effective project_flow_assignment exists for (project, today).
--   2. For every node in the assigned flow, every approver reference
--      resolves:
--      - `user`: user exists + status='active'.
--      - `role_on_silo`: silo_role_assignments row active for every
--        project_subcontractors silo on this project AND role_label.
--      - `role_on_project`: project_role_assignments row active for role_label.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._resolve_project_readiness(p_project_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_id    uuid;
  v_flow_id      uuid;
  v_missing      text[] := ARRAY[]::text[];
  v_node_rec     record;
  v_approver_rec record;
  v_sub_rec      record;
BEGIN
  SELECT tenant_id INTO v_tenant_id
    FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND THEN
    RETURN ARRAY['project_not_found'];
  END IF;

  -- 1. Current flow assignment.
  SELECT flow_id INTO v_flow_id
    FROM public.project_flow_assignments
    WHERE project_id = p_project_id
      AND effective_from <= current_date
      AND (effective_to IS NULL OR effective_to >= current_date)
    ORDER BY effective_from DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN ARRAY['project_flow_assignment'];
  END IF;

  -- 2. For each node in the flow, for each approver reference, verify it resolves.
  FOR v_node_rec IN
    SELECT id, ordinal FROM public.approval_nodes
     WHERE flow_id = v_flow_id ORDER BY ordinal
  LOOP
    FOR v_approver_rec IN
      SELECT approver_type, user_id, role_label
        FROM public.approval_node_approvers
       WHERE node_id = v_node_rec.id
    LOOP
      IF v_approver_rec.approver_type = 'user' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.users
           WHERE id = v_approver_rec.user_id AND status = 'active'
        ) THEN
          v_missing := v_missing || format('node:%s:user:%s:inactive',
            v_node_rec.ordinal, v_approver_rec.user_id);
        END IF;

      ELSIF v_approver_rec.approver_type = 'role_on_project' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.project_role_assignments
           WHERE project_id = p_project_id
             AND role_label = v_approver_rec.role_label
             AND effective_from <= current_date
             AND (effective_to IS NULL OR effective_to >= current_date)
        ) THEN
          v_missing := v_missing || format('project_role_assignments:role=%s',
            v_approver_rec.role_label);
        END IF;

      ELSIF v_approver_rec.approver_type = 'role_on_silo' THEN
        -- silo references check per active sub on this project
        FOR v_sub_rec IN
          SELECT DISTINCT subcontractor_id
            FROM public.project_subcontractors
           WHERE project_id = p_project_id
             AND start_date <= current_date
             AND (end_date IS NULL OR end_date >= current_date)
        LOOP
          IF NOT EXISTS (
            SELECT 1 FROM public.silo_role_assignments
             WHERE project_id = p_project_id
               AND subcontractor_id = v_sub_rec.subcontractor_id
               AND role_label = v_approver_rec.role_label
               AND effective_from <= current_date
               AND (effective_to IS NULL OR effective_to >= current_date)
          ) THEN
            v_missing := v_missing || format('silo_role_assignments:sub=%s:role=%s',
              v_sub_rec.subcontractor_id, v_approver_rec.role_label);
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;

  RETURN v_missing;
END;
$$;

REVOKE ALL ON FUNCTION public._resolve_project_readiness(uuid) FROM public, anon, authenticated;

-- ============================================================================
-- project_readiness — public read RPC
-- ============================================================================

CREATE OR REPLACE FUNCTION public.project_readiness(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid := (auth.jwt() ->> 'tenant_id')::uuid;
  v_project_tenant uuid;
  v_missing text[];
BEGIN
  -- Tenant scope: the project must live in the caller's tenant (or we 404).
  SELECT tenant_id INTO v_project_tenant
    FROM public.projects WHERE id = p_project_id;
  IF NOT FOUND OR v_project_tenant <> v_tenant_claim THEN
    RETURN jsonb_build_object('ready', false, 'missing', jsonb_build_array('project_not_found'));
  END IF;

  v_missing := public._resolve_project_readiness(p_project_id);
  RETURN jsonb_build_object(
    'ready',  (cardinality(v_missing) = 0),
    'missing', COALESCE(to_jsonb(v_missing), '[]'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.project_readiness(uuid) TO authenticated;

-- ============================================================================
-- submit_timesheet — §7.4 routing
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_timesheet(
  p_timesheet_id   uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid := (auth.jwt() ->> 'tenant_id')::uuid;
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_actor        uuid := (SELECT auth.uid());
  v_cached       jsonb;
  v_t            record;
  v_flow_id      uuid;
  v_first_node   uuid;
  v_missing      text[];
  v_run_id       uuid := gen_random_uuid();
  v_result       jsonb;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  v_cached := public._idempotency_begin(p_idempotency_key);
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  -- 1. Lock + load timesheet, tenant-scoped.
  SELECT * INTO v_t FROM public.timesheets
   WHERE id = p_timesheet_id
     AND tenant_id = v_tenant_claim
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('timesheet %s not found in tenant', p_timesheet_id);
  END IF;

  -- 2. Authorize submitter (or admin).
  IF NOT v_is_admin AND v_t.submitter_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION USING ERRCODE='P0004',
      MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Only the timesheet submitter or a tenant admin can submit this timesheet';
  END IF;

  -- 3. Current state must be 'draft'.
  IF v_t.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('cannot submit timesheet in status %s; must be draft', v_t.status);
  END IF;

  -- 4. Resolve project flow assignment.
  SELECT flow_id INTO v_flow_id
    FROM public.project_flow_assignments
   WHERE project_id = v_t.project_id
     AND effective_from <= current_date
     AND (effective_to IS NULL OR effective_to >= current_date)
   ORDER BY effective_from DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='PROJECT_NOT_READY',
      DETAIL=jsonb_build_object('missing',
        jsonb_build_array('project_flow_assignment'))::text;
  END IF;

  -- 5. Validate the entire flow's configuration for this silo.
  v_missing := public._resolve_project_readiness(v_t.project_id);
  -- Reduce the generic silo-missing entries to this submission's silo only —
  -- we only need enough config for THIS silo to route.
  v_missing := ARRAY(
    SELECT m FROM unnest(v_missing) AS m
     WHERE m NOT LIKE 'silo_role_assignments:sub=%'
        OR m LIKE 'silo_role_assignments:sub=' || v_t.subcontractor_id::text || ':%'
  );
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='PROJECT_NOT_READY',
      DETAIL=jsonb_build_object('missing', to_jsonb(v_missing))::text;
  END IF;

  -- 6. Pick node ordinal 1 for this flow.
  SELECT id INTO v_first_node
    FROM public.approval_nodes
   WHERE flow_id = v_flow_id AND ordinal = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='PROJECT_NOT_READY',
      DETAIL=jsonb_build_object('missing',
        jsonb_build_array('approval_nodes:ordinal=1'))::text;
  END IF;

  -- 7. Create the run. Timesheet goes to in_review (spec state 'submitted'
  --    is transient and collapsed inside this tx; kept in the enum for
  --    hypothetical non-atomic flows).
  INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id, version)
  VALUES (v_run_id, v_tenant_claim, v_t.id, v_flow_id, 'open', v_first_node, 0);

  UPDATE public.timesheets
     SET status = 'in_review',
         submitted_at = now()
   WHERE id = v_t.id;

  v_result := jsonb_build_object(
    'ok', true,
    'run_id', v_run_id,
    'timesheet_id', v_t.id,
    'timesheet_status', 'in_review',
    'flow_id', v_flow_id,
    'current_node_id', v_first_node,
    'version', 0
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.submit_timesheet(uuid, text) TO authenticated;

-- ============================================================================
-- approve_run — §7.4 approve
-- ============================================================================

CREATE OR REPLACE FUNCTION public.approve_run(
  p_run_id          uuid,
  p_comment         text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid := (auth.jwt() ->> 'tenant_id')::uuid;
  v_actor        uuid := (SELECT auth.uid());
  v_cached       jsonb;
  v_r            record;
  v_current_ord  integer;
  v_max_ord      integer;
  v_next_node    uuid;
  v_rows         integer;
  v_new_status   public.approval_run_status;
  v_new_node     uuid;
  v_new_closed   timestamptz;
  v_result       jsonb;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  v_cached := public._idempotency_begin(p_idempotency_key);
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  SELECT * INTO v_r FROM public.approval_runs
   WHERE id = p_run_id AND tenant_id = v_tenant_claim
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('run %s not found in tenant', p_run_id);
  END IF;
  IF v_r.status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0002',
      MESSAGE='RUN_STATE_CHANGED',
      DETAIL=jsonb_build_object(
        'run_id', p_run_id, 'status', v_r.status, 'version', v_r.version
      )::text;
  END IF;

  IF NOT public._is_eligible_approver(p_run_id, v_actor) THEN
    RAISE EXCEPTION USING ERRCODE='P0004',
      MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Caller is not in the eligible-approver set for the current node';
  END IF;

  -- Compute next state: advance or terminate.
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

  -- Optimistic-concurrency UPDATE keyed on version (§7.4).
  UPDATE public.approval_runs
     SET status          = v_new_status,
         current_node_id = v_new_node,
         closed_at       = v_new_closed,
         version         = version + 1
   WHERE id = p_run_id
     AND version = v_r.version;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0002',
      MESSAGE='RUN_STATE_CHANGED',
      DETAIL='Conditional UPDATE found no matching version; another actor changed the run';
  END IF;

  INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action, comment)
  VALUES (v_tenant_claim, p_run_id, v_r.current_node_id, v_actor, 'approve', p_comment);

  IF v_new_status = 'approved' THEN
    UPDATE public.timesheets SET status = 'approved'
     WHERE id = v_r.timesheet_id;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'run_id', p_run_id,
    'status', v_new_status,
    'current_node_id', v_new_node,
    'version', v_r.version + 1,
    'terminal', (v_new_status = 'approved')
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.approve_run(uuid, text, text) TO authenticated;

-- ============================================================================
-- reject_run — §7.4 reject. Comment required.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reject_run(
  p_run_id          uuid,
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
  v_tenant_claim uuid := (auth.jwt() ->> 'tenant_id')::uuid;
  v_actor        uuid := (SELECT auth.uid());
  v_cached       jsonb;
  v_r            record;
  v_rows         integer;
  v_result       jsonb;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  IF p_comment IS NULL OR btrim(p_comment) = '' THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='reject_run requires a non-empty comment';
  END IF;

  v_cached := public._idempotency_begin(p_idempotency_key);
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  SELECT * INTO v_r FROM public.approval_runs
   WHERE id = p_run_id AND tenant_id = v_tenant_claim
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('run %s not found in tenant', p_run_id);
  END IF;
  IF v_r.status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0002',
      MESSAGE='RUN_STATE_CHANGED',
      DETAIL=jsonb_build_object(
        'run_id', p_run_id, 'status', v_r.status, 'version', v_r.version
      )::text;
  END IF;

  IF NOT public._is_eligible_approver(p_run_id, v_actor) THEN
    RAISE EXCEPTION USING ERRCODE='P0004',
      MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Caller is not in the eligible-approver set for the current node';
  END IF;

  UPDATE public.approval_runs
     SET status          = 'rejected',
         current_node_id = NULL,
         closed_at       = now(),
         version         = version + 1
   WHERE id = p_run_id AND version = v_r.version;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL='Conditional UPDATE found no matching version';
  END IF;

  INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action, comment)
  VALUES (v_tenant_claim, p_run_id, v_r.current_node_id, v_actor, 'reject', p_comment);

  UPDATE public.timesheets SET status = 'rejected' WHERE id = v_r.timesheet_id;

  v_result := jsonb_build_object(
    'ok', true, 'run_id', p_run_id, 'status', 'rejected',
    'version', v_r.version + 1, 'terminal', true
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reject_run(uuid, text, text) TO authenticated;

-- ============================================================================
-- recall_run — §7.4 submitter withdraw
-- ============================================================================

CREATE OR REPLACE FUNCTION public.recall_run(
  p_run_id          uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid := (auth.jwt() ->> 'tenant_id')::uuid;
  v_actor        uuid := (SELECT auth.uid());
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_cached       jsonb;
  v_r            record;
  v_t            record;
  v_rows         integer;
  v_result       jsonb;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  v_cached := public._idempotency_begin(p_idempotency_key);
  IF v_cached IS NOT NULL THEN RETURN v_cached; END IF;

  SELECT * INTO v_r FROM public.approval_runs
   WHERE id = p_run_id AND tenant_id = v_tenant_claim FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('run %s not found in tenant', p_run_id);
  END IF;
  IF v_r.status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL=jsonb_build_object('run_id', p_run_id, 'status', v_r.status,
                                'version', v_r.version)::text;
  END IF;

  SELECT * INTO v_t FROM public.timesheets WHERE id = v_r.timesheet_id;
  IF NOT v_is_admin AND v_t.submitter_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Only the original submitter (or a tenant admin) can recall';
  END IF;

  UPDATE public.approval_runs
     SET status='recalled', current_node_id=NULL, closed_at=now(),
         version = version + 1
   WHERE id = p_run_id AND version = v_r.version;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL='Conditional UPDATE found no matching version';
  END IF;

  INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action, comment)
  VALUES (v_tenant_claim, p_run_id, v_r.current_node_id, v_actor, 'recall', NULL);

  UPDATE public.timesheets SET status = 'draft' WHERE id = v_r.timesheet_id;

  v_result := jsonb_build_object(
    'ok', true, 'run_id', p_run_id, 'status', 'recalled',
    'timesheet_status', 'draft', 'version', v_r.version + 1, 'terminal', true
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recall_run(uuid, text) TO authenticated;

-- ============================================================================
-- claim_field_timesheet — open → draft (field-only, §7.4)
-- ----------------------------------------------------------------------------
-- Only silo submitters (via submitter_assignments) or admins can claim.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.claim_field_timesheet(p_timesheet_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid := (auth.jwt() ->> 'tenant_id')::uuid;
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_actor        uuid := (SELECT auth.uid());
  v_t            record;
  v_rows         integer;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  SELECT * INTO v_t FROM public.timesheets
   WHERE id = p_timesheet_id AND tenant_id = v_tenant_claim FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('timesheet %s not found', p_timesheet_id);
  END IF;
  IF v_t.kind <> 'field' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='claim_field_timesheet applies only to field timesheets';
  END IF;
  IF v_t.status <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('cannot claim timesheet in status %s; must be open', v_t.status);
  END IF;
  IF NOT v_is_admin AND NOT EXISTS (
    SELECT 1 FROM public.submitter_assignments
     WHERE user_id = v_actor
       AND project_id = v_t.project_id
       AND subcontractor_id = v_t.subcontractor_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Caller has no submitter_assignments for this silo';
  END IF;

  UPDATE public.timesheets
     SET status='draft', submitter_user_id = v_actor
   WHERE id = p_timesheet_id AND status='open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Another claimer beat us between SELECT FOR UPDATE and UPDATE (shouldn't
    -- happen with row lock, but defensively).
    RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
      DETAIL='Timesheet was claimed by another actor';
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'timesheet_id', p_timesheet_id, 'status', 'draft',
    'submitter_user_id', v_actor
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_field_timesheet(uuid) TO authenticated;

-- ============================================================================
-- release_field_timesheet — draft → open (field-only, §7.4)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_field_timesheet(p_timesheet_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant_claim uuid := (auth.jwt() ->> 'tenant_id')::uuid;
  v_is_admin     boolean := ((auth.jwt() ->> 'app_role') = 'admin');
  v_actor        uuid := (SELECT auth.uid());
  v_t            record;
BEGIN
  PERFORM public.assert_tenant_claim_present();
  PERFORM public.assert_session_live();

  SELECT * INTO v_t FROM public.timesheets
   WHERE id = p_timesheet_id AND tenant_id = v_tenant_claim FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('timesheet %s not found', p_timesheet_id);
  END IF;
  IF v_t.kind <> 'field' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL='release_field_timesheet applies only to field timesheets';
  END IF;
  IF v_t.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE='P0003', MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('cannot release timesheet in status %s; must be draft', v_t.status);
  END IF;
  IF NOT v_is_admin AND v_t.submitter_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION USING ERRCODE='P0004', MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Only the current claimer (or admin) can release';
  END IF;

  UPDATE public.timesheets
     SET status='open', submitter_user_id=NULL
   WHERE id = p_timesheet_id;

  RETURN jsonb_build_object(
    'ok', true, 'timesheet_id', p_timesheet_id, 'status', 'open'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_field_timesheet(uuid) TO authenticated;

-- ============================================================================
-- my_pending_approvals — read-only RPC
-- ----------------------------------------------------------------------------
-- Returns open runs where the caller is currently in the eligible-approver
-- pool. Used by approver dashboards; also the primary signal for "approvers
-- poll" pattern in §7.6 (there's no in-app inbox in v1).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.my_pending_approvals()
RETURNS TABLE (
  run_id          uuid,
  timesheet_id    uuid,
  project_id      uuid,
  subcontractor_id uuid,
  current_node_id uuid,
  flow_id         uuid,
  version         integer,
  opened_at       timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.id, r.timesheet_id, t.project_id, t.subcontractor_id,
         r.current_node_id, r.flow_id, r.version, r.opened_at
    FROM public.approval_runs r
    JOIN public.timesheets t ON t.id = r.timesheet_id
   WHERE r.status = 'open'
     AND r.tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
     AND public._is_eligible_approver(r.id, (SELECT auth.uid()));
$$;

GRANT EXECUTE ON FUNCTION public.my_pending_approvals() TO authenticated;
