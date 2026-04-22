-- Deterministic drain ordering (follow-up to Batch 5b).
-- ----------------------------------------------------------------------------
-- `_claim_pending_notifications` originally ordered pending rows by created_at
-- alone. That's ambiguous under identical created_at values — which happens
-- both in pgTAP (all DEFAULT now() inside a single test transaction resolve
-- to the same timestamp) and, more rarely, in prod under bursty enqueues where
-- two outbox rows share a microsecond. Intermittent test flakes on
-- `attempts=1` / `last_attempt_at IS NOT NULL` stem from this: a claim might
-- pick rows {b,c} instead of {a,b}, leaving row a untouched.
--
-- Adding `id` as a tiebreaker gives stable FIFO-ish ordering (uuid v4 isn't
-- monotonic, so it isn't strict insertion order — but it's deterministic per
-- batch, which is what the test asserts and what prod needs for replayability).
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
     ORDER BY o.created_at, o.id
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
