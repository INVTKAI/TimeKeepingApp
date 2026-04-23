-- Prod bootstrap — one-time setup for the prod Supabase project.
--
-- Run via Dashboard → SQL Editor → New query. Replace the two
-- __REPLACE_*__ placeholders with real values BEFORE running, then paste
-- all + Run. Idempotent: cron.unschedule + cron.schedule per job makes
-- re-runs safe.
--
-- The drain_secret here MUST MATCH NOTIFICATION_DRAIN_SECRET in the Edge
-- Function env (Dashboard → Edge Functions → Secrets, or
-- `supabase secrets set`). Otherwise cron fires but drain rejects with 403.
--
-- ============================================================================
-- WHY WE INLINE THE SECRET (not pull from Vault inside cron)
--
-- On Supabase cloud (tested 2026-04-22 against pg_net 0.20.0, pg_cron on
-- a Pro-tier Small compute project), calling
--   SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'x'
-- from inside a pg_cron job causes `net.http_post` to throw
--   ERROR:  Out of memory
--   CONTEXT: insert into net.http_request_queue ...
-- every tick. The same SELECT works fine from the SQL Editor directly,
-- and `net.http_post` works fine when called directly. The bug is in
-- the pg_cron-subprocess × vault.decrypted_secrets combination.
--
-- Workaround: inline the secret into cron.command. Security trade-off:
-- the secret lives in `cron.job.command` which is readable by the
-- postgres role (scoped to this project on Supabase cloud — not
-- cross-tenant). For a drain-only secret whose compromise impact is
-- bounded to "attacker can trigger notification deliveries for events
-- already queued" (not RLS bypass), this is acceptable.
--
-- Rotation: when NOTIFICATION_DRAIN_SECRET rotates, rerun this file
-- with the new value. The cron.unschedule + cron.schedule handles the
-- update. See docs/ops/service-role-rotation-runbook.md §Drain secret.
-- ============================================================================

-- 1. Extensions (Pro tier — available on all Pro projects).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 2. Cron schedules. `cron.unschedule` first makes re-runs idempotent.

-- 2a. Drain notifications — every minute. Secret inlined per the
--     Vault-in-cron OOM note above.
SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'drain-notifications';
SELECT cron.schedule(
  'drain-notifications',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url     := '__REPLACE_WITH_https_URL__/functions/v1/drain-notifications',
    headers := jsonb_build_object(
      'Authorization', 'Bearer __REPLACE_WITH_NOTIFICATION_DRAIN_SECRET__',
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb
  );
  $job$
);

-- 2b. Reconcile rows stuck in 'sending' — every 5 minutes. No HTTP; this
--     calls a public RPC directly so it doesn't need a secret.
SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'reconcile-stuck-sending';
SELECT cron.schedule(
  'reconcile-stuck-sending',
  '*/5 * * * *',
  $job$ SELECT public._reconcile_stuck_sending(5) $job$
);

-- 2c. Emit stall notifications — hourly. Same shape as 2b.
SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'emit-stall-notifications';
SELECT cron.schedule(
  'emit-stall-notifications',
  '0 * * * *',
  $job$ SELECT public._emit_stall_notifications() $job$
);

-- 3. Verification — expect 3 rows, all active.
SELECT jobid, jobname, schedule, active
  FROM cron.job
 WHERE jobname IN ('drain-notifications', 'reconcile-stuck-sending', 'emit-stall-notifications')
 ORDER BY jobname;

-- 4. Optional — wait 90 seconds, then confirm the drain is actually firing.
-- SELECT r.start_time, r.status, left(r.return_message, 120)
--   FROM cron.job_run_details r
--   JOIN cron.job j ON j.jobid = r.jobid
--  WHERE j.jobname = 'drain-notifications'
--  ORDER BY r.start_time DESC LIMIT 5;
