-- ============================================================================
-- Stall detection + drain support (Batch 5c) — spec §7.6
-- ----------------------------------------------------------------------------
-- Three pieces that round out the notification subsystem's database side:
--
-- 1. public.notification_webhook_dispatches — one row per
--    (tenant, run, event_type) that's had a webhook fired. The drain Edge
--    Function claims the right to send a webhook via INSERT ... ON CONFLICT
--    DO NOTHING; losers skip. Outbox rows are per-recipient (for email
--    fan-out); webhooks are per-event (spec §7.6).
--
-- 2. _emit_stall_notifications() — scans open approval_runs where the
--    current state has been unchanged longer than tenants.stall_hours and
--    emits 'stalled' outbox rows. Intended for a daily pg_cron schedule.
--
-- 3. _reconcile_stuck_sending(max_age_minutes) — resets 'sending' rows that
--    have been in that state longer than max_age_minutes back to 'pending'.
--    Covers the case where the drain Edge Function crashed between claim
--    and outcome recording. Intended for a frequent pg_cron schedule
--    (e.g. every 5 minutes).
--
-- pg_cron schedules themselves are NOT registered here — they're a
-- production/staging deployment step (requires pg_cron + pg_net
-- extensions + an internal-callable URL for the drain Edge Function).
-- README documents the setup.
--
-- Known scope deviation from spec §7.6:
-- - Stall notifications currently always include tenant admins. Spec says
--   1× SLA excludes admins, 2× SLA includes them. Refining to a two-step
--   escalation ('stalled' + 'stalled_escalated') is deferred to future
--   work — the single-event approach still surfaces stalls reliably.
-- ============================================================================

-- ---- notification_webhook_dispatches ---------------------------------------
CREATE TABLE public.notification_webhook_dispatches (
  tenant_id   uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  run_id      uuid        NOT NULL REFERENCES public.approval_runs(id) ON DELETE CASCADE,
  event_type  public.notification_event_type NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  last_status_code integer NULL,
  last_error  text        NULL,
  PRIMARY KEY (tenant_id, run_id, event_type)
);

ALTER TABLE public.notification_webhook_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_webhook_dispatches FORCE  ROW LEVEL SECURITY;

-- Admin-SELECT; writes are service-role-only (drain Edge Function).
CREATE POLICY notification_webhook_dispatches_admin_select
  ON public.notification_webhook_dispatches
  FOR SELECT TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'app_role') = 'admin'
  );

-- ============================================================================
-- _emit_stall_notifications() — produces 'stalled' outbox rows
-- ----------------------------------------------------------------------------
-- "Time at current state" is the max of opened_at and any approval_actions.ts
-- for the run — this captures both never-acted-on runs AND runs that advanced
-- and then stalled at a later node.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._emit_stall_notifications()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run       record;
  v_last_ts   timestamptz;
  v_stall_hrs integer;
  v_emitted   integer := 0;
BEGIN
  FOR v_run IN
    SELECT r.id, r.tenant_id, r.opened_at, t.stall_hours
      FROM public.approval_runs r
      JOIN public.tenants t ON t.id = r.tenant_id
     WHERE r.status = 'open'
  LOOP
    SELECT GREATEST(v_run.opened_at, COALESCE(MAX(a.ts), v_run.opened_at))
      INTO v_last_ts
      FROM public.approval_actions a
     WHERE a.run_id = v_run.id;
    v_stall_hrs := v_run.stall_hours;

    IF (clock_timestamp() - v_last_ts) > (v_stall_hrs * interval '1 hour') THEN
      PERFORM public._emit_notifications(
        'stalled'::public.notification_event_type,
        v_run.id,
        NULL,
        jsonb_build_object(
          'last_action_at', v_last_ts,
          'stall_hours_threshold', v_stall_hrs,
          'age_hours', round(extract(epoch from (clock_timestamp() - v_last_ts))/3600::numeric, 2)
        )
      );
      v_emitted := v_emitted + 1;
    END IF;
  END LOOP;
  RETURN v_emitted;
END;
$$;

REVOKE ALL ON FUNCTION public._emit_stall_notifications()
  FROM public, anon, authenticated;

-- ============================================================================
-- _reconcile_stuck_sending(max_age_minutes)
-- ----------------------------------------------------------------------------
-- Resets notification_outbox rows that have been 'sending' longer than
-- max_age_minutes back to 'pending'. The drain will pick them up on the
-- next cycle. attempts is NOT decremented — a crashed attempt still counts
-- toward the exhaustion threshold so we don't retry forever on a genuinely
-- broken target.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._reconcile_stuck_sending(p_max_age_minutes integer DEFAULT 5)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.notification_outbox
     SET status = 'pending',
         last_error = COALESCE(last_error || ' | reconciled: stuck in sending', 'reconciled: stuck in sending')
   WHERE status = 'sending'
     AND last_attempt_at < clock_timestamp() - make_interval(mins => p_max_age_minutes);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public._reconcile_stuck_sending(integer)
  FROM public, anon, authenticated;
