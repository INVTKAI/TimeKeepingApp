-- Monitoring: notification delivery failures by hour (last 24h).
-- -----------------------------------------------------------------------------
-- Alert target: any hour with > 5 failures, or any single tenant with > 3
-- failures in the last hour. Tune thresholds against tenant volume once baseline
-- is known (seed: <tenant> typical traffic).
--
-- Data source: public.notification_failures (populated by drain-notifications
-- when an outbox row exhausts its retry budget — see spec §7.6, migration
-- 20260422142824).
--
-- Usage:
--   docker exec -i supabase_db_invenio-timekeeping psql -U postgres -d postgres \
--     -f backend/scripts/monitoring/notification_failures_spike.sql
-- or
--   supabase db query --linked < backend/scripts/monitoring/notification_failures_spike.sql

WITH hourly AS (
  SELECT date_trunc('hour', failed_at) AS hour,
         tenant_id,
         count(*)                      AS failures,
         array_agg(DISTINCT event_type) AS event_types,
         array_agg(DISTINCT left(last_error, 80)) AS error_samples
    FROM public.notification_failures
   WHERE failed_at > now() - interval '24 hours'
   GROUP BY 1, 2
)
SELECT hour,
       tenant_id,
       failures,
       event_types,
       error_samples,
       CASE
         WHEN hour > now() - interval '1 hour' AND failures > 3 THEN 'ALERT: tenant spike'
         WHEN failures > 5                                      THEN 'WARN: elevated'
         ELSE 'ok'
       END AS status
  FROM hourly
 ORDER BY hour DESC, failures DESC;
