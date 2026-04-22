// change-role — spec §1 / §5. Flip a user between 'admin' and 'submitter'.
// Session invalidation forces the next JWT to carry the new app_role claim.
//
// Body: { user_id, new_role }

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

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;

    const userIdR = requireString(parsed.body, "user_id");
    if (!userIdR.ok) return problemResponse(userIdR.problem);
    const roleR = requireString(parsed.body, "new_role");
    if (!roleR.ok) return problemResponse(roleR.problem);
    const targetId = userIdR.value;
    const newRole = roleR.value;

    if (newRole !== "admin" && newRole !== "submitter") {
      return problemResponse(
        Problems.ValidationError("new_role must be 'admin' or 'submitter'"),
      );
    }

    // Admins cannot change their own role — protects against self-demotion
    // lockout.
    if (targetId === ctx.userId) {
      return problemResponse(Problems.CannotTargetSelf());
    }

    const target = await getUserInTenant(ctx.adminClient, targetId, ctx.tenantId);
    if (!target.ok) return problemResponse(target.problem);

    if (target.user.status === "revoked") {
      return problemResponse(
        Problems.UserStateConflict("Cannot change role of a revoked user. Restore first."),
      );
    }

    const oldRole = target.user.role;
    if (oldRole === newRole) {
      return new Response(
        JSON.stringify({ ok: true, user_id: targetId, role: newRole, changed: false }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // 1. Update domain role.
    const { error: updErr } = await ctx.adminClient
      .from("users")
      .update({ role: newRole })
      .eq("id", targetId)
      .eq("tenant_id", ctx.tenantId);
    if (updErr) return problemResponse(Problems.Internal(updErr.message));

    // 2. Invalidate all sessions so next sign-in carries the new app_role claim.
    const invErr = await invalidateUserSessions(ctx.adminClient, targetId);
    if (invErr) return problemResponse(invErr);

    // 3. Audit.
    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "user.role_change",
      "user",
      targetId,
      { from: oldRole, to: newRole },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({ ok: true, user_id: targetId, role: newRole, changed: true, previous_role: oldRole }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
);
