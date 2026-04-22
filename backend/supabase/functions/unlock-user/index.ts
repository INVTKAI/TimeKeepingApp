// unlock-user — spec §4.7 admin unlock. Inserts a user_unlock_markers row
// that the password_verification_attempt hook treats as a reset of the
// failure window. Does NOT mutate Supabase-owned auth.users state.
//
// Body: { user_id }

import "@supabase/functions-js/edge-runtime.d.ts";
import { withAdminContext } from "../_shared/with-admin-context.ts";
import { Problems, problemResponse } from "../_shared/problem.ts";
import {
  getUserInTenant,
  parseJsonBody,
  requireString,
  writeAudit,
} from "../_shared/admin-helpers.ts";

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;

    const userIdR = requireString(parsed.body, "user_id");
    if (!userIdR.ok) return problemResponse(userIdR.problem);
    const targetId = userIdR.value;

    const target = await getUserInTenant(ctx.adminClient, targetId, ctx.tenantId);
    if (!target.ok) return problemResponse(target.problem);

    // Insert the unlock marker. The before-login hook's window-computation
    // (GREATEST(latest unlock, now() - lockout_minutes)) makes this a
    // cooldown-window reset.
    const { data: markerData, error: markerErr } = await ctx.adminClient
      .from("user_unlock_markers")
      .insert({
        tenant_id: ctx.tenantId,
        user_id: targetId,
        unlocked_by: ctx.userId,
      })
      .select("id, unlocked_at")
      .single();
    if (markerErr) return problemResponse(Problems.Internal(markerErr.message));

    // Clear the counter too — defensive, since the hook already ignores stale
    // rows pre-dating the unlock marker. Best-effort; ignore errors.
    await ctx.adminClient
      .from("login_failure_counters")
      .delete()
      .eq("user_id", targetId);

    // Audit.
    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "user.unlock",
      "user",
      targetId,
      { target_email: target.user.email, marker_id: markerData.id },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({
        ok: true,
        user_id: targetId,
        marker_id: markerData.id,
        unlocked_at: markerData.unlocked_at,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
);
