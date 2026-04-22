-- ============================================================================
-- Notification delivery state machine (Batch 5b) — spec §7.6
-- ----------------------------------------------------------------------------
-- The enqueue path (5a) puts rows into public.notification_outbox as 'pending'.
-- This migration adds the delivery state machine:
--
--   pending → sending    (a drain claims the row; sets last_attempt_at, attempts++)
--   sending → sent       (on successful delivery)
--   sending → pending    (on failure with attempts < max; back to the queue)
--   sending → failed     (on failure with attempts >= max; row copied to
--                         notification_failures for admin review)
--
-- Actual HTTP delivery (Resend + HMAC-signed webhooks) + the Edge Function
-- that calls these RPCs + the pg_cron schedules + stall detection all land
-- in Batch 5c. 5b is the state-machine substrate — proven via pgTAP under
-- direct RPC calls, no mock HTTP.
-- ============================================================================

-- ---- Extend status CHECK to include 'sending' ------------------------------
ALTER TABLE public.notification_outbox
  DROP CONSTRAINT notification_outbox_status_check;
ALTER TABLE public.notification_outbox
  ADD  CONSTRAINT notification_outbox_status_check
       CHECK (status IN ('pending','sending','sent','failed','abandoned'));

-- ---- notification_failures: admin-visible record of permanently-failed rows
CREATE TABLE public.notification_failures (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
  outbox_id            uuid        NOT NULL REFERENCES public.notification_outbox(id) ON DELETE CASCADE,
  event_type           public.notification_event_type NOT NULL,
  recipient_user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  attempts             integer     NOT NULL,
  last_error           text        NULL,
  failed_at            timestamptz NOT NULL DEFAULT now(),
  payload_snapshot     jsonb       NOT NULL
);

CREATE INDEX notification_failures_tenant_idx      ON public.notification_failures (tenant_id);
CREATE INDEX notification_failures_outbox_idx      ON public.notification_failures (outbox_id);
CREATE INDEX notification_failures_recipient_idx   ON public.notification_failures (recipient_user_id, failed_at DESC);

ALTER TABLE public.notification_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_failures FORCE  ROW LEVEL SECURITY;

CREATE POLICY notification_failures_admin_select ON public.notification_failures
  FOR SELECT TO authenticated
  USING (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    AND (auth.jwt() ->> 'app_role') = 'admin'
  );

-- ============================================================================
-- _claim_pending_notifications(batch_size) — atomic claim via SKIP LOCKED
-- ----------------------------------------------------------------------------
-- Multiple concurrent drains each claim a disjoint subset: FOR UPDATE SKIP
-- LOCKED inside a CTE picks distinct rows per drain. The UPDATE transitions
-- status to 'sending' and bumps attempts + last_attempt_at — so if a drain
-- crashes mid-delivery, the row stays 'sending' and a follow-up reconciliation
-- (Batch 5c) picks it up. For now, operators can manually re-queue stuck
-- 'sending' rows by resetting status to 'pending'.
--
-- Returns the claimed rows. Service-role only; called by the drain Edge
-- Function (5c) or manually by pgTAP tests.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._claim_pending_notifications(p_batch_size integer DEFAULT 10)
RETURNS TABLE (
  id                uuid,
  tenant_id         uuid,
  event_type        public.notification_event_type,
  recipient_user_id uuid,
  role_context      text,
  payload           jsonb,
  attempts          integer,
  run_id            uuid,
  timesheet_id      uuid
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH claimed AS (
    SELECT o.id
      FROM public.notification_outbox o
     WHERE o.status = 'pending'
     ORDER BY o.created_at
     LIMIT p_batch_size
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notification_outbox o
     SET status          = 'sending',
         attempts        = o.attempts + 1,
         last_attempt_at = clock_timestamp()
    FROM claimed
   WHERE o.id = claimed.id
  RETURNING o.id, o.tenant_id, o.event_type, o.recipient_user_id,
            o.role_context, o.payload, o.attempts, o.run_id, o.timesheet_id;
$$;

REVOKE ALL ON FUNCTION public._claim_pending_notifications(integer)
  FROM public, anon, authenticated;

-- ============================================================================
-- _record_notification_success(id) — sending → sent
-- ============================================================================

CREATE OR REPLACE FUNCTION public._record_notification_success(p_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  UPDATE public.notification_outbox
     SET status   = 'sent',
         sent_at  = clock_timestamp(),
         last_error = NULL
   WHERE id = p_id
     AND status = 'sending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  -- v_rows = 0 means the row was never claimed / already terminal; silently
  -- no-op. (Retries on the same id are safe.)
END;
$$;

REVOKE ALL ON FUNCTION public._record_notification_success(uuid)
  FROM public, anon, authenticated;

-- ============================================================================
-- _record_notification_failure(id, error, max_attempts)
-- ----------------------------------------------------------------------------
-- Transitions:
--   attempts < max_attempts  →  back to 'pending' (retry on next drain)
--   attempts >= max_attempts →  'failed' + copy to notification_failures
-- ============================================================================

CREATE OR REPLACE FUNCTION public._record_notification_failure(
  p_id           uuid,
  p_error        text,
  p_max_attempts integer DEFAULT 3
)
RETURNS text   -- returns the resulting status for observability
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row   record;
  v_status text;
BEGIN
  SELECT * INTO v_row FROM public.notification_outbox WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_row.status <> 'sending' THEN
    -- Likely a stale retry after a different drain already committed an
    -- outcome. Leave as-is.
    RETURN v_row.status;
  END IF;

  IF v_row.attempts >= p_max_attempts THEN
    UPDATE public.notification_outbox
       SET status     = 'failed',
           last_error = p_error
     WHERE id = p_id;

    INSERT INTO public.notification_failures
      (tenant_id, outbox_id, event_type, recipient_user_id, attempts,
       last_error, payload_snapshot)
    VALUES
      (v_row.tenant_id, v_row.id, v_row.event_type, v_row.recipient_user_id,
       v_row.attempts, p_error, v_row.payload);
    v_status := 'failed';
  ELSE
    UPDATE public.notification_outbox
       SET status     = 'pending',
           last_error = p_error
     WHERE id = p_id;
    v_status := 'pending';
  END IF;

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public._record_notification_failure(uuid, text, integer)
  FROM public, anon, authenticated;
