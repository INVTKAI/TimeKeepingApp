-- ============================================================================
-- Notification outbox + recipient resolution (Batch 5a) — spec §7.6
-- ----------------------------------------------------------------------------
-- Ships the enqueue side: one outbox row per (event, recipient). Delivery
-- (the Edge Function that drains the outbox, Resend/webhook wiring, retry
-- policy, stall detection via pg_cron) lands in Batch 5b. Separation of
-- concerns: enqueue is transactional with the RPC that triggered it;
-- delivery is an eventually-consistent side-effect loop.
--
-- Recipient resolution follows §7.6's event × recipient matrix, deduplicated
-- per (event, user) so a user holding multiple reserved labels on a silo
-- receives one row per event. The `role_context` field attributes the
-- highest-precedence reason the user is a recipient; it's informational
-- (helps delivery pick a presentation) and not load-bearing.
-- ============================================================================

-- ---- Event enum ------------------------------------------------------------
CREATE TYPE public.notification_event_type AS ENUM (
  'submitted',
  'node_advanced',
  'approved',
  'rejected',
  'recalled',
  'reassigned',
  'admin_override',
  'parent_approval_invalidated',
  'stalled'
);

-- ---- Outbox table ----------------------------------------------------------
CREATE TABLE public.notification_outbox (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  event_type        public.notification_event_type NOT NULL,
  run_id            uuid        NULL REFERENCES public.approval_runs(id) ON DELETE SET NULL,
  timesheet_id      uuid        NULL REFERENCES public.timesheets(id) ON DELETE SET NULL,
  recipient_user_id uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_context      text        NULL,    -- 'submitter' | 'foreman' | 'timekeeper_admin' | 'current_node_approver' | 'tenant_admin' | 'reassignee'
  payload           jsonb       NOT NULL,
  status            text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','sent','failed','abandoned')),
  attempts          integer     NOT NULL DEFAULT 0,
  last_attempt_at   timestamptz NULL,
  sent_at           timestamptz NULL,
  last_error        text        NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_outbox_tenant_idx      ON public.notification_outbox (tenant_id);
CREATE INDEX notification_outbox_pending_idx
  ON public.notification_outbox (created_at)
  WHERE status = 'pending';
CREATE INDEX notification_outbox_recipient_idx
  ON public.notification_outbox (recipient_user_id, created_at DESC);

-- RLS: tenant admins can read their own tenant's outbox (for debugging /
-- history UI); everybody else blocked. Writes are RPC/trigger-only, no policy.
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_outbox_admin_select ON public.notification_outbox
  FOR SELECT TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'app_role') = 'admin'
  );

-- ============================================================================
-- _resolve_recipients — §7.6 event × recipient matrix
-- ----------------------------------------------------------------------------
-- Returns the deduplicated set of (user_id, role_context) pairs to notify
-- for the given event. role_context picks the highest-precedence reason
-- (submitter > current_node_approver > foreman > timekeeper_admin >
-- tenant_admin > reassignee). Actor_user_id is passed through for callers
-- that want to elide self-notifications, but this helper DOES include the
-- actor — the trigger decides whether to filter (e.g. we do want "submitted"
-- ack going to the submitter even though they're the actor).
-- ============================================================================

CREATE OR REPLACE FUNCTION public._resolve_recipients(
  p_event_type      public.notification_event_type,
  p_run_id          uuid,
  p_actor_user_id   uuid
)
RETURNS TABLE (user_id uuid, role_context text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH run_ctx AS (
    SELECT r.id AS run_id, r.tenant_id, r.current_node_id,
           t.id AS ts_id, t.submitter_user_id,
           t.project_id, t.subcontractor_id
      FROM public.approval_runs r
      JOIN public.timesheets   t ON t.id = r.timesheet_id
     WHERE r.id = p_run_id
  ),

  -- Submitter.
  r_submitter AS (
    SELECT submitter_user_id AS user_id, 'submitter'::text AS role_context
      FROM run_ctx
     WHERE submitter_user_id IS NOT NULL
       AND p_event_type IN ('submitted','node_advanced','approved','rejected','admin_override','stalled')
  ),

  -- Current-node approvers: union of direct user refs + silo-role refs +
  -- project-role refs + targeted reassignment.
  r_current_user AS (
    SELECT na.user_id, 'current_node_approver'::text AS role_context
      FROM run_ctx rc
      JOIN public.approval_node_approvers na ON na.node_id = rc.current_node_id
     WHERE na.approver_type = 'user'
       AND p_event_type IN ('submitted','node_advanced','recalled','reassigned','admin_override','stalled')
  ),
  r_current_silo AS (
    SELECT sra.user_id, 'current_node_approver'::text AS role_context
      FROM run_ctx rc
      JOIN public.approval_node_approvers na ON na.node_id = rc.current_node_id
      JOIN public.silo_role_assignments sra
        ON sra.role_label = na.role_label
       AND sra.project_id = rc.project_id
       AND sra.subcontractor_id = rc.subcontractor_id
       AND sra.effective_from <= current_date
       AND (sra.effective_to IS NULL OR sra.effective_to >= current_date)
     WHERE na.approver_type = 'role_on_silo'
       AND p_event_type IN ('submitted','node_advanced','recalled','reassigned','admin_override','stalled')
  ),
  r_current_project AS (
    SELECT pra.user_id, 'current_node_approver'::text AS role_context
      FROM run_ctx rc
      JOIN public.approval_node_approvers na ON na.node_id = rc.current_node_id
      JOIN public.project_role_assignments pra
        ON pra.role_label = na.role_label
       AND pra.project_id = rc.project_id
       AND pra.effective_from <= current_date
       AND (pra.effective_to IS NULL OR pra.effective_to >= current_date)
     WHERE na.approver_type = 'role_on_project'
       AND p_event_type IN ('submitted','node_advanced','recalled','reassigned','admin_override','stalled')
  ),
  r_reassignee AS (
    -- Targeted reassignment pool — spec calls this out as notified on
    -- 'reassigned' and acts as current-node pool for subsequent events.
    SELECT ar.to_user_id AS user_id, 'reassignee'::text AS role_context
      FROM public.approval_reassignments ar
     WHERE ar.run_id = p_run_id
       AND p_event_type IN ('reassigned','node_advanced','recalled','admin_override','stalled')
  ),

  -- Reserved silo roles.
  r_foreman AS (
    SELECT sra.user_id, 'foreman'::text AS role_context
      FROM run_ctx rc
      JOIN public.silo_role_assignments sra
        ON sra.role_label = 'foreman'
       AND sra.project_id = rc.project_id
       AND sra.subcontractor_id = rc.subcontractor_id
       AND sra.effective_from <= current_date
       AND (sra.effective_to IS NULL OR sra.effective_to >= current_date)
     WHERE p_event_type IN ('submitted','approved','rejected','recalled','admin_override','stalled')
  ),
  r_timekeeper AS (
    SELECT sra.user_id, 'timekeeper_admin'::text AS role_context
      FROM run_ctx rc
      JOIN public.silo_role_assignments sra
        ON sra.role_label = 'timekeeper_admin'
       AND sra.project_id = rc.project_id
       AND sra.subcontractor_id = rc.subcontractor_id
       AND sra.effective_from <= current_date
       AND (sra.effective_to IS NULL OR sra.effective_to >= current_date)
     WHERE p_event_type IN ('submitted','approved','rejected','recalled','reassigned','admin_override','stalled')
  ),

  -- Tenant admins — audit copy on reassignment + 2× SLA stall + parent
  -- approval invalidation. (The 2× stall distinction vs 1× is handled by
  -- the stall producer in Batch 5b; here we just note that admins go in
  -- the pool on 'stalled' events too.)
  r_admins AS (
    SELECT u.id AS user_id, 'tenant_admin'::text AS role_context
      FROM run_ctx rc
      JOIN public.users u ON u.tenant_id = rc.tenant_id
     WHERE u.role = 'admin'
       AND u.status = 'active'
       AND p_event_type IN ('reassigned','parent_approval_invalidated','stalled')
  ),

  unioned AS (
    SELECT user_id, role_context, 1 AS pri FROM r_submitter
    UNION ALL SELECT user_id, role_context, 2 FROM r_current_user
    UNION ALL SELECT user_id, role_context, 2 FROM r_current_silo
    UNION ALL SELECT user_id, role_context, 2 FROM r_current_project
    UNION ALL SELECT user_id, role_context, 3 FROM r_foreman
    UNION ALL SELECT user_id, role_context, 4 FROM r_timekeeper
    UNION ALL SELECT user_id, role_context, 5 FROM r_admins
    UNION ALL SELECT user_id, role_context, 6 FROM r_reassignee
  ),

  ranked AS (
    SELECT user_id, role_context,
           row_number() OVER (PARTITION BY user_id ORDER BY pri) AS rn
      FROM unioned
  )

  SELECT user_id, role_context FROM ranked WHERE rn = 1;
$$;

REVOKE ALL ON FUNCTION public._resolve_recipients(public.notification_event_type, uuid, uuid)
  FROM public, anon, authenticated;

-- ============================================================================
-- _emit_notifications — unified outbox enqueue helper
-- ----------------------------------------------------------------------------
-- Resolves recipients and inserts one outbox row per recipient. Callers:
--   * notify_on_approval_action() trigger
--   * submit_timesheet RPC (inline for 'submitted')
--   * resolve_badge_override RPC (inline for 'parent_approval_invalidated')
-- ============================================================================

CREATE OR REPLACE FUNCTION public._emit_notifications(
  p_event_type     public.notification_event_type,
  p_run_id         uuid,
  p_actor_user_id  uuid,
  p_extra          jsonb DEFAULT '{}'::jsonb
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run        record;
  v_inserted   integer := 0;
  v_payload    jsonb;
BEGIN
  SELECT r.tenant_id, r.timesheet_id, t.project_id, t.subcontractor_id,
         t.period_start, t.period_end
    INTO v_run
    FROM public.approval_runs r
    JOIN public.timesheets   t ON t.id = r.timesheet_id
    WHERE r.id = p_run_id;
  IF NOT FOUND THEN
    RETURN 0;   -- run vanished; nothing to emit
  END IF;

  v_payload := jsonb_build_object(
    'event_type', p_event_type::text,
    'run_id', p_run_id,
    'timesheet_id', v_run.timesheet_id,
    'project_id', v_run.project_id,
    'subcontractor_id', v_run.subcontractor_id,
    'actor_user_id', p_actor_user_id,
    'period_start', v_run.period_start,
    'period_end', v_run.period_end
  ) || COALESCE(p_extra, '{}'::jsonb);

  INSERT INTO public.notification_outbox
    (tenant_id, event_type, run_id, timesheet_id, recipient_user_id, role_context, payload)
  SELECT v_run.tenant_id, p_event_type, p_run_id, v_run.timesheet_id,
         r.user_id, r.role_context, v_payload
    FROM public._resolve_recipients(p_event_type, p_run_id, p_actor_user_id) r;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public._emit_notifications(public.notification_event_type, uuid, uuid, jsonb)
  FROM public, anon, authenticated;

-- ============================================================================
-- Trigger: notify_on_approval_action
-- ----------------------------------------------------------------------------
-- Fires AFTER INSERT on approval_actions and dispatches to _emit_notifications
-- with the right event type. Event type derived from NEW.action + the run's
-- post-transition status (since the run UPDATE happens in the same tx and is
-- visible here).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.notify_on_approval_action()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run_status public.approval_run_status;
  v_event      public.notification_event_type;
  v_extra      jsonb := jsonb_build_object('action', NEW.action, 'comment', NEW.comment);
BEGIN
  SELECT status INTO v_run_status FROM public.approval_runs WHERE id = NEW.run_id;

  v_event := CASE NEW.action
    WHEN 'approve' THEN
      CASE WHEN v_run_status = 'approved' THEN 'approved'::public.notification_event_type
           ELSE 'node_advanced'::public.notification_event_type END
    WHEN 'reject'         THEN 'rejected'::public.notification_event_type
    WHEN 'recall'         THEN 'recalled'::public.notification_event_type
    WHEN 'reassign'       THEN 'reassigned'::public.notification_event_type
    WHEN 'admin_override' THEN
      -- If the override terminated the run, treat as admin_override regardless;
      -- the consumer can inspect payload.action + run status if needed.
      'admin_override'::public.notification_event_type
  END;

  PERFORM public._emit_notifications(v_event, NEW.run_id, NEW.actor_user_id, v_extra);
  RETURN NEW;
END;
$$;

CREATE TRIGGER notify_on_approval_action
  AFTER INSERT ON public.approval_actions
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_on_approval_action();

-- ============================================================================
-- Patch submit_timesheet: emit 'submitted' after the run is created.
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

  SELECT * INTO v_t FROM public.timesheets
   WHERE id = p_timesheet_id
     AND tenant_id = v_tenant_claim
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('timesheet %s not found in tenant', p_timesheet_id);
  END IF;

  IF NOT v_is_admin AND v_t.submitter_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION USING ERRCODE='P0004',
      MESSAGE='APPROVER_NOT_ELIGIBLE',
      DETAIL='Only the timesheet submitter or a tenant admin can submit this timesheet';
  END IF;

  IF v_t.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE='P0003',
      MESSAGE='INVALID_STATE_TRANSITION',
      DETAIL=format('cannot submit timesheet in status %s; must be draft', v_t.status);
  END IF;

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

  v_missing := public._resolve_project_readiness(v_t.project_id);
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

  SELECT id INTO v_first_node
    FROM public.approval_nodes
   WHERE flow_id = v_flow_id AND ordinal = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0001',
      MESSAGE='PROJECT_NOT_READY',
      DETAIL=jsonb_build_object('missing',
        jsonb_build_array('approval_nodes:ordinal=1'))::text;
  END IF;

  INSERT INTO public.approval_runs (id, tenant_id, timesheet_id, flow_id, status, current_node_id, version)
  VALUES (v_run_id, v_tenant_claim, v_t.id, v_flow_id, 'open', v_first_node, 0);

  UPDATE public.timesheets
     SET status = 'in_review',
         submitted_at = now()
   WHERE id = v_t.id;

  -- 5a: emit 'submitted' notifications inline (no approval_actions row at
  -- submit time, so the AFTER INSERT trigger doesn't fire for this event).
  PERFORM public._emit_notifications(
    'submitted'::public.notification_event_type, v_run_id, v_actor, '{}'::jsonb);

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

-- ============================================================================
-- Patch resolve_badge_override: emit 'parent_approval_invalidated' on the
-- approved-parent branch (§7.7 "notify tenant admins").
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
  v_parent_line  record;
  v_parent_run   record;
  v_rows         integer;
  v_cascade_kind text := 'none';
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
             SET status='rejected', current_node_id=NULL, closed_at=now(),
                 version = version + 1
           WHERE id = v_parent_run.id AND version = v_parent_run.version;
          GET DIAGNOSTICS v_rows = ROW_COUNT;
          IF v_rows = 0 THEN
            RAISE EXCEPTION USING ERRCODE='P0002', MESSAGE='RUN_STATE_CHANGED',
              DETAIL='Parent run version changed between lookup and cascade update';
          END IF;
          -- The approval_actions INSERT below fires the notify trigger, which
          -- emits admin_override notifications for the parent-run rejection.
          INSERT INTO public.approval_actions (tenant_id, run_id, node_id, actor_user_id, action, comment)
          VALUES (v_tenant_claim, v_parent_run.id, v_parent_run.current_node_id, v_actor,
                  'admin_override', 'HOURS_RECONCILED_TO_BADGE');
          UPDATE public.timesheets SET status='rejected' WHERE id = v_parent_line.ts_id;
          v_cascade_kind := 'rejected';
        ELSIF v_parent_run.status = 'approved' THEN
          INSERT INTO public.audit_events (tenant_id, actor_user_id, action_type, subject_type, subject_id, details)
          VALUES (v_tenant_claim, v_actor, 'approval.parent_approval_invalidated',
                  'approval_run', v_parent_run.id,
                  jsonb_build_object('badge_override_id', p_override_id,
                                     'reason', 'HOURS_RECONCILED_TO_BADGE'));
          -- 5a: emit parent_approval_invalidated notifications (tenant admins).
          PERFORM public._emit_notifications(
            'parent_approval_invalidated'::public.notification_event_type,
            v_parent_run.id, v_actor,
            jsonb_build_object('badge_override_id', p_override_id,
                               'reason', 'HOURS_RECONCILED_TO_BADGE'));
          v_cascade_kind := 'invalidated';
        END IF;
      END IF;
    END IF;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'badge_override_id', p_override_id,
    'status', v_outcome::text,
    'parent_run_cascade', v_cascade_kind
  );

  PERFORM public._idempotency_commit(p_idempotency_key, v_result);
  RETURN v_result;
END;
$$;
