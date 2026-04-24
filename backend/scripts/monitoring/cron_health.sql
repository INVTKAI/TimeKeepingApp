-- Monitoring: pg_cron schedule health (drain + reconcile + stall).
-- -----------------------------------------------------------------------------
-- Three expected jobs from prod-bootstrap.sql:
--   * drain-notifications       — every minute
--   * reconcile-stuck-sending   — every 5 minutes
--   * emit-stall-notifications  — hourly
--
-- Alert target:
--   drain         — no success in > 10 min → drain EF unreachable or cron dead
--   reconcile     — no success in > 30 min
--   stall         — no success in > 2 h
--   any job       — failures_24h > 3 → investigate
--
-- The schedule-window math below tracks "how late is each job vs. its cadence."
--
-- Usage:
--   docker exec -i supabase_db_invenio-timekeeping psql -U postgres -d postgres \
--     -f backend/scripts/monitoring/cron_health.sql
-- or
--   supabase db query --linked < backend/scripts/monitoring/cron_health.sql

WITH expected AS (
  SELECT jobname, max_staleness
    FROM (VALUES
      ('drain-notifications',      interval '10 minutes'),
      ('reconcile-stuck-sending',  interval '30 minutes'),
      ('emit-stall-notifications', interval '2 hours')
    ) AS t(jobname, max_staleness)
),
stats AS (
  SELECT j.jobname,
         j.active,
         j.schedule,
         max(r.end_time) FILTER (WHERE r.status = 'succeeded') AS last_success,
         max(r.end_time) FILTER (WHERE r.status = 'failed')    AS last_failure,
         count(*) FILTER (WHERE r.status = 'failed'
                          AND r.end_time > now() - interval '24 hours') AS failures_24h
    FROM cron.job j
    LEFT JOIN cron.job_run_details r ON r.jobid = j.jobid
   GROUP BY j.jobname, j.active, j.schedule
)
SELECT e.jobname,
       coalesce(s.active, false)                        AS active,
       coalesce(s.schedule, '(unregistered)')           AS schedule,
       coalesce(s.last_success::text, 'NEVER')          AS last_success,
       coalesce(s.last_failure::text, '—')              AS last_failure,
       coalesce(s.failures_24h, 0)                      AS failures_24h,
       CASE
         WHEN s.jobname IS NULL                                            THEN 'BLOCKED: not registered'
         WHEN NOT s.active                                                 THEN 'BLOCKED: disabled'
         WHEN s.last_success IS NULL                                       THEN 'BLOCKED: never succeeded'
         WHEN s.last_success < now() - e.max_staleness                     THEN 'ALERT: stale'
         WHEN coalesce(s.failures_24h, 0) > 3                              THEN 'WARN: flapping'
         ELSE 'ok'
       END AS status
  FROM expected e
  LEFT JOIN stats s ON s.jobname = e.jobname
 ORDER BY e.jobname;
