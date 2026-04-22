-- Prod bootstrap — one-time setup for the prod Supabase project.
--
-- Run via Dashboard → SQL Editor → New query. Replace the two placeholder
-- values below with real secrets BEFORE running, then paste all + Run.
-- Idempotent: every statement is IF NOT EXISTS or cron.unschedule +
-- cron.schedule, so re-runs are safe.
--
-- The drain_secret value must MATCH what you set as NOTIFICATION_DRAIN_SECRET
-- in the Edge Function env (Dashboard → Edge Functions → Secrets, or via
-- `supabase secrets set`). Otherwise cron fires but drain rejects every call
-- with 403.
--
-- project_url is the standard https://<ref>.supabase.co URL — find it under
-- Dashboard → Project Settings → API → Project URL.
--
-- Rotation: when the drain secret rotates (see
-- docs/ops/service-role-rotation-runbook.md), update both this file AND the
-- Edge Function secret, then re-run. Do NOT commit a real secret to git.
-- ============================================================================

-- 1. GUCs the scheduler needs. ALTER DATABASE values persist across sessions.
ALTER DATABASE postgres SET app.drain_secret = '__REPLACE_WITH_NOTIFICATION_DRAIN_SECRET__';
ALTER DATABASE postgres SET app.project_url  = '__REPLACE_WITH_https_URL__';

-- 2. Extensions (Supabase Pro only — available on all Pro projects).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3. Cron schedules. Unschedule first for idempotency on re-run.

-- 3a. Drain notifications — every minute.
SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'drain-notifications';
SELECT cron.schedule(
  'drain-notifications',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url     := current_setting('app.project_url') || '/functions/v1/drain-notifications',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.drain_secret'),
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb
  );
  $job$
);

-- 3b. Reconcile rows stuck in 'sending' — every 5 minutes. Reclaims rows
--     whose drain attempt crashed mid-delivery.
SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'reconcile-stuck-sending';
SELECT cron.schedule(
  'reconcile-stuck-sending',
  '*/5 * * * *',
  $job$ SELECT public._reconcile_stuck_sending(5) $job$
);

-- 3c. Emit stall notifications — hourly. Scans open approval runs past
--     tenants.stall_hours and enqueues 'stalled' notifications.
SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'emit-stall-notifications';
SELECT cron.schedule(
  'emit-stall-notifications',
  '0 * * * *',
  $job$ SELECT public._emit_stall_notifications() $job$
);

-- 4. Verification.
SELECT jobid, jobname, schedule, active
  FROM cron.job
 WHERE jobname IN ('drain-notifications', 'reconcile-stuck-sending', 'emit-stall-notifications')
 ORDER BY jobname;
