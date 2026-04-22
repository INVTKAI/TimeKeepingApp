// revoke-user — spec §4.6. Soft-delete: admin blocks a user's login and
// revokes all their sessions. The public.users row stays so historical
// approval actions / timesheets still resolve their actor.
//
// Body: { user_id }

import "@supabase/functions-js/edge-runtime.d.ts";
import { withAdminContext } from "../_shared/with-admin-context.ts";
import { Problems, problemResponse } from "../_shared/problem.ts";
import {
  getUserInTenant,
  invalidateUserSessions,
  parseJsonBody,
  requireString,
  writeAudit,
} from "../_shared/admin-helpers.ts";

// "Forever" for Supabase's ban_duration (supabase-js v2 doesn't accept
// 'infinity'; 100-year horizon is effectively permanent).
const PERMANENT_BAN = "876000h";

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;

    const userIdR = requireString(parsed.body, "user_id");
    if (!userIdR.ok) return problemResponse(userIdR.problem);
    const targetId = userIdR.value;

    if (targetId === ctx.userId) {
      return problemResponse(Problems.CannotTargetSelf());
    }

    const target = await getUserInTenant(ctx.adminClient, targetId, ctx.tenantId);
    if (!target.ok) return problemResponse(target.problem);

    if (target.user.status === "revoked") {
      return problemResponse(Problems.UserStateConflict("User is already revoked."));
    }

    // 1. Ban at Supabase Auth — future logins rejected.
    const { error: banErr } = await ctx.adminClient.auth.admin.updateUserById(targetId, {
      ban_duration: PERMANENT_BAN,
    });
    if (banErr) return problemResponse(Problems.SupabaseAuthError(banErr.message));

    // 2. Revoke current sessions + set sessions_revoked_at.
    const invErr = await invalidateUserSessions(ctx.adminClient, targetId);
    if (invErr) return problemResponse(invErr);

    // 3. Set domain marker. sessions_revoked_at was set by step 2; we also
    //    flip status so downstream UI + reports reflect the revocation.
    const { error: updErr } = await ctx.adminClient
      .from("users")
      .update({ status: "revoked" })
      .eq("id", targetId)
      .eq("tenant_id", ctx.tenantId);
    if (updErr) return problemResponse(Problems.Internal(updErr.message));

    // 4. Audit.
    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "user.revoke",
      "user",
      targetId,
      { target_email: target.user.email },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({ ok: true, user_id: targetId, status: "revoked" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
);
