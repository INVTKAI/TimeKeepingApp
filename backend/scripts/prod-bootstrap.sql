-- Prod bootstrap — one-time setup for the prod Supabase project.
--
-- Run via Dashboard → SQL Editor → New query. Replace the two placeholder
-- values below (__REPLACE_*__) with real values BEFORE running, then paste
-- all + Run. Idempotent: cron.unschedule + cron.schedule per job makes
-- re-runs safe; vault.create_secret errors on duplicate name, so the
-- UPDATE-or-create helper handles rotation.
--
-- The drain_secret value stored in Vault must MATCH the
-- NOTIFICATION_DRAIN_SECRET in the Edge Function env (Dashboard → Edge
-- Functions → Secrets, or `supabase secrets set`). Otherwise cron fires
-- but drain-notifications rejects every call with 403.
--
-- Why Vault (not ALTER DATABASE SET): Supabase cloud doesn't grant the
-- project `postgres` role ALTER DATABASE privileges. Vault is the
-- sanctioned secret-management surface on Pro+; `vault.decrypted_secrets`
-- is a view the postgres role can read.
--
-- Rotation: update the Vault secret via the upsert block below + update
-- the NOTIFICATION_DRAIN_SECRET Edge Function env to match, then re-run.
-- Do NOT commit a real secret to git — keep the placeholder version.
-- ============================================================================

-- 1. Drain secret → Vault. Upsert pattern (Vault doesn't have a native
--    "create or update"; we delete-then-create if the name exists).
DO $$
DECLARE
  v_secret_id uuid;
BEGIN
  SELECT id INTO v_secret_id FROM vault.secrets WHERE name = 'drain_secret';
  IF v_secret_id IS NOT NULL THEN
    PERFORM vault.update_secret(
      v_secret_id,
      '__REPLACE_WITH_NOTIFICATION_DRAIN_SECRET__',
      'drain_secret',
      'Shared-secret Bearer for pg_cron → /functions/v1/drain-notifications'
    );
  ELSE
    PERFORM vault.create_secret(
      '__REPLACE_WITH_NOTIFICATION_DRAIN_SECRET__',
      'drain_secret',
      'Shared-secret Bearer for pg_cron → /functions/v1/drain-notifications'
    );
  END IF;
END $$;

-- 2. Extensions (Supabase Pro only — available on all Pro projects).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 3. Cron schedules. `cron.unschedule` first makes re-runs idempotent.

-- 3a. Drain notifications — every minute. Project URL inlined (not secret);
--     drain_secret read from Vault at cron-tick time.
SELECT cron.unschedule(jobid)
  FROM cron.job WHERE jobname = 'drain-notifications';
SELECT cron.schedule(
  'drain-notifications',
  '* * * * *',
  $job$
  SELECT net.http_post(
    url     := '__REPLACE_WITH_https_URL__' || '/functions/v1/drain-notifications',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
          FROM vault.decrypted_secrets
         WHERE name = 'drain_secret'
      ),
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

-- 4. Verification — expect 3 rows.
SELECT jobid, jobname, schedule, active
  FROM cron.job
 WHERE jobname IN ('drain-notifications', 'reconcile-stuck-sending', 'emit-stall-notifications')
 ORDER BY jobname;
