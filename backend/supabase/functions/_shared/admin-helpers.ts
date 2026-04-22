// Shared helpers for admin Edge Functions. All call sites expect to receive
// an already-authenticated AdminContext from withAdminContext — these helpers
// wrap common sequences (tenant-scoped user fetch, audit write, session
// invalidation) with consistent RFC 7807 error handling.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { Problems, problemResponse, type Problem } from "./problem.ts";

// Conservative body size cap for admin requests; nothing here should need more.
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Parse the request body as JSON with a small size cap. Returns either the
 * parsed object or a problem+json Response ready to be returned to the caller.
 */
export async function parseJsonBody(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      response: problemResponse(
        Problems.ValidationError("Request Content-Type must be application/json"),
      ),
    };
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: problemResponse(
        Problems.ValidationError(`Request body exceeds ${MAX_BODY_BYTES} bytes`),
      ),
    };
  }
  try {
    const parsed = raw.length === 0 ? {} : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        response: problemResponse(
          Problems.ValidationError("Request body must be a JSON object"),
        ),
      };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: problemResponse(Problems.ValidationError("Request body is not valid JSON")),
    };
  }
}

/**
 * Assert the caller-supplied body has a string field at the given key.
 * Returns the validated string, or a Problem if absent / wrong type.
 */
export function requireString(
  body: Record<string, unknown>,
  field: string,
): { ok: true; value: string } | { ok: false; problem: Problem } {
  const v = body[field];
  if (typeof v !== "string" || v.length === 0) {
    return {
      ok: false,
      problem: Problems.ValidationError(`Missing or invalid field: ${field}`),
    };
  }
  return { ok: true, value: v };
}

/**
 * Fetch a public.users row scoped to the caller's verified tenant. Returns a
 * 404 problem if the user is absent in that tenant — avoids existence leaks
 * across tenants. Use this before any admin operation that references a
 * target user_id from the request body.
 */
export async function getUserInTenant(
  adminClient: SupabaseClient,
  userId: string,
  tenantId: string,
): Promise<
  | {
      ok: true;
      user: {
        id: string;
        tenant_id: string;
        username: string;
        email: string;
        role: string;
        status: string;
      };
    }
  | { ok: false; problem: Problem }
> {
  const { data, error } = await adminClient
    .from("users")
    .select("id, tenant_id, username, email, role, status")
    .eq("id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) {
    return { ok: false, problem: Problems.Internal(error.message) };
  }
  if (!data) {
    return { ok: false, problem: Problems.UserNotFound() };
  }
  return { ok: true, user: data };
}

/**
 * Write a row to public.audit_events under the caller's tenant. Admin Edge
 * Functions use the service-role client, which bypasses the
 * audit_events_self_insert RLS policy (scoped to authenticated callers).
 */
export async function writeAudit(
  adminClient: SupabaseClient,
  tenantId: string,
  actorUserId: string,
  actionType: string,
  subjectType: string,
  subjectId: string,
  details: Record<string, unknown>,
): Promise<Problem | null> {
  const { error } = await adminClient.from("audit_events").insert({
    tenant_id: tenantId,
    actor_user_id: actorUserId,
    action_type: actionType,
    subject_type: subjectType,
    subject_id: subjectId,
    details,
  });
  if (error) {
    return Problems.Internal(`audit_events insert failed: ${error.message}`);
  }
  return null;
}

/**
 * Invalidate every session for a user — the admin equivalent of
 * auth.admin.signOut(user_id, 'global'). Deletes refresh_tokens +
 * auth.sessions and sets public.users.sessions_revoked_at so any outstanding
 * access token is rejected by assert_session_live() on the next state-mutating
 * RPC (§4.2). Implemented as a plpgsql RPC that's service_role-only.
 */
export async function invalidateUserSessions(
  adminClient: SupabaseClient,
  userId: string,
): Promise<Problem | null> {
  const { error } = await adminClient.rpc("admin_invalidate_user_sessions", {
    p_user_id: userId,
  });
  if (error) {
    return Problems.Internal(`admin_invalidate_user_sessions failed: ${error.message}`);
  }
  return null;
}
