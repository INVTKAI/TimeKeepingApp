-- ============================================================================
-- admin_invalidate_user_sessions RPC (Batch 3b prologue)
-- ----------------------------------------------------------------------------
-- Spec §4.2 / §4.6 call for "auth.admin.signOut(user_id, 'global')" when
-- admin revokes, reset-passwords, or changes-role on a user. supabase-js v2's
-- admin.signOut only accepts a JWT (not a user_id), so we provide this
-- plpgsql RPC as the admin-side primitive. It atomically:
--   * DELETEs auth.refresh_tokens for the user (no more refresh-token-based
--     session renewal)
--   * DELETEs auth.sessions for the user (kills current session records)
--   * UPDATEs public.users.sessions_revoked_at = now() so
--     assert_session_live() rejects any pre-existing access token on the next
--     state-mutating RPC (§4.2 revocation denylist).
--
-- Access: SECURITY DEFINER, EXECUTE granted to service_role only. Admin Edge
-- Functions call it via adminClient.rpc('admin_invalidate_user_sessions', ...).
-- Never reachable from authenticated or anon roles.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_invalidate_user_sessions(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  DELETE FROM auth.refresh_tokens WHERE user_id = p_user_id::text;
  DELETE FROM auth.sessions       WHERE user_id = p_user_id;
  UPDATE public.users             SET sessions_revoked_at = now() WHERE id = p_user_id;
END;
$$;

COMMENT ON FUNCTION public.admin_invalidate_user_sessions(uuid) IS
  'Spec §4.2/§4.6 — admin primitive equivalent to auth.admin.signOut(user_id, ''global''). Clears auth.refresh_tokens + auth.sessions and sets sessions_revoked_at. service_role only.';

REVOKE ALL       ON FUNCTION public.admin_invalidate_user_sessions(uuid) FROM public, anon, authenticated;
GRANT  EXECUTE   ON FUNCTION public.admin_invalidate_user_sessions(uuid) TO service_role;
