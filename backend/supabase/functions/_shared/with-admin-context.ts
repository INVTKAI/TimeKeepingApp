// withAdminContext — the mandatory wrapper for every admin Edge Function.
// Spec §3, §8: service-role-key use is permitted ONLY inside this wrapper.
// A CI lint gate (§11.6, deferred — see followup in Batch 3/CI hardening)
// rejects Edge Functions that import the service-role key directly.
//
// Responsibilities:
//   1. Require and cryptographically verify a Bearer JWT via Supabase Auth.
//   2. Assert `app_role === 'admin'` (claim injected by the custom
//      access-token hook, §4.2).
//   3. Extract `tenant_id` from the JWT — never from request payload.
//   4. Build a service-role client scoped to the verified tenant and hand
//      the inner handler a context object.
//   5. Convert any unhandled exception into an RFC 7807 500 response.

import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2";
import { Problems, problemResponse } from "./problem.ts";

export type AdminContext = {
  user: User;
  userId: string;
  tenantId: string;
  adminClient: SupabaseClient;
};

export type AdminHandler = (req: Request, ctx: AdminContext) => Promise<Response>;

// Decode the JWT payload for claim extraction. Signature verification is
// performed separately by supabase.auth.getUser() before we trust anything
// from these decoded claims.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

export function withAdminContext(
  handler: AdminHandler,
): (req: Request) => Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRoleKey || !anonKey) {
    throw new Error(
      "withAdminContext: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY must all be set in the Edge Function environment.",
    );
  }

  return async (req: Request): Promise<Response> => {
    const authz = req.headers.get("authorization");
    if (!authz || !authz.toLowerCase().startsWith("bearer ")) {
      return problemResponse(Problems.MissingAuth());
    }
    const token = authz.slice("bearer ".length).trim();

    // Cryptographic validation of the token via Supabase Auth. Returns 401
    // material if expired or tampered with.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return problemResponse(Problems.InvalidToken(userErr?.message));
    }

    // Extract claims from the same token we just verified.
    const claims = decodeJwtPayload(token);
    if (!claims) {
      return problemResponse(Problems.InvalidToken("Malformed JWT payload"));
    }
    const tenantId = typeof claims.tenant_id === "string" ? claims.tenant_id : null;
    const appRole = typeof claims.app_role === "string" ? claims.app_role : null;

    if (!tenantId) {
      // Fail-closed — §4.8 hook-missing-claim mitigation.
      return problemResponse(Problems.TenantClaimMissing());
    }
    if (appRole !== "admin") {
      return problemResponse(Problems.Forbidden("Admin role required"));
    }

    // Service-role client bypasses RLS. Every handler call site MUST scope
    // writes by ctx.tenantId (from the verified JWT) — never trust tenant
    // identifiers from request bodies.
    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
      return await handler(req, {
        user: userData.user,
        userId: userData.user.id,
        tenantId,
        adminClient,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[withAdminContext] unhandled error:", msg);
      return problemResponse(Problems.Internal(msg));
    }
  };
}
