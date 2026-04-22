-- ============================================================================
-- password_verification_attempt_hook: use clock_timestamp() instead of now()
-- ----------------------------------------------------------------------------
-- Each Auth hook call is a distinct transaction in real operation, so now()
-- (which returns transaction-start time) vs clock_timestamp() (per-statement
-- fresh) produces identical behavior there. But under pgTAP (where a whole
-- test suite runs inside a single rollback'd transaction), now() collapses
-- all timestamps to one value, making time-ordered tests impossible.
--
-- Surfaced by the Batch 3c pgTAP suite. Switching to clock_timestamp()
-- unblocks per-tenant config testing and is marginally more accurate in
-- production (actual operation time vs transaction-start time).
--
-- Unchanged: the column DEFAULT now() stays — it only matters for direct
-- SQL inserts outside the hook, where transaction-start time is fine.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.password_verification_attempt_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id           uuid    := (event->>'user_id')::uuid;
  v_valid             boolean := (event->>'valid')::boolean;
  v_max_attempts      integer;
  v_lockout_minutes   integer;
  v_latest_unlock     timestamptz;
  v_window_start      timestamptz;
  v_count             integer;
  v_existing_count    integer;
  v_existing_started  timestamptz;
  v_lockout_response  jsonb;
  v_now               timestamptz := clock_timestamp();
BEGIN
  SELECT t.login_max_attempts, t.login_lockout_minutes
    INTO v_max_attempts, v_lockout_minutes
    FROM public.users u
    JOIN public.tenants t ON t.id = u.tenant_id
    WHERE u.id = v_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('decision', 'continue');
  END IF;

  SELECT MAX(unlocked_at) INTO v_latest_unlock
    FROM public.user_unlock_markers
    WHERE user_id = v_user_id;

  v_window_start := GREATEST(
    COALESCE(v_latest_unlock, '-infinity'::timestamptz),
    v_now - make_interval(mins => v_lockout_minutes)
  );

  SELECT failure_count, first_failed_at
    INTO v_existing_count, v_existing_started
    FROM public.login_failure_counters
    WHERE user_id = v_user_id;

  v_lockout_response := jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 429,
      'message', 'Account temporarily locked. Too many failed sign-in attempts. Contact an administrator or wait for the lockout window to expire.'
    )
  );

  IF v_existing_count IS NOT NULL
     AND v_existing_count >= v_max_attempts
     AND v_existing_started >= v_window_start THEN
    RETURN v_lockout_response;
  END IF;

  IF v_valid THEN
    DELETE FROM public.login_failure_counters WHERE user_id = v_user_id;
    RETURN jsonb_build_object('decision', 'continue');
  END IF;

  INSERT INTO public.login_failure_counters (user_id, failure_count, first_failed_at, updated_at)
  VALUES (v_user_id, 1, v_now, v_now)
  ON CONFLICT (user_id) DO UPDATE
    SET failure_count = CASE
          WHEN public.login_failure_counters.first_failed_at < v_window_start THEN 1
          ELSE public.login_failure_counters.failure_count + 1
        END,
        first_failed_at = CASE
          WHEN public.login_failure_counters.first_failed_at < v_window_start THEN v_now
          ELSE public.login_failure_counters.first_failed_at
        END,
        updated_at = v_now
  RETURNING failure_count INTO v_count;

  IF v_count >= v_max_attempts THEN
    RETURN v_lockout_response;
  END IF;

  RETURN jsonb_build_object('decision', 'continue');
END;
$$;
