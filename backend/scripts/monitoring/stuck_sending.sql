-- Monitoring: notification_outbox rows stuck in 'sending' state.
-- -----------------------------------------------------------------------------
-- The drain pipeline transitions rows pending → sending → sent|pending|failed
-- (spec §7.6, migration 20260422142824). A row stuck in 'sending' means the
-- drain EF crashed or timed out mid-delivery. `_reconcile_stuck_sending` runs
-- on a pg_cron every 5 min and resets rows older than 15 min back to 'pending'.
--
-- Alert target: any row in 'sending' for > 20 min → reconciler is broken.
-- Any row in 'sending' for > 5 min → drain EF may be timing out.
--
-- Usage:
--   docker exec -i supabase_db_invenio-timekeeping psql -U postgres -d postgres \
--     -f backend/scripts/monitoring/stuck_sending.sql
-- or
--   supabase db query --linked < backend/scripts/monitoring/stuck_sending.sql

SELECT id,
       tenant_id,
       event_type,
       run_id,
       attempts,
       age(now(), last_attempt_at) AS stuck_for,
       CASE
         WHEN last_attempt_at < now() - interval '20 minutes' THEN 'ALERT: reconciler broken'
         WHEN last_attempt_at < now() - interval '5 minutes'  THEN 'WARN: drain timing out'
         ELSE 'ok (in-flight)'
       END AS status,
       last_error
  FROM public.notification_outbox
 WHERE status = 'sending'
 ORDER BY last_attempt_at ASC
 LIMIT 50;
