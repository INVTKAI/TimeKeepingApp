// reset-password — spec §4.5. Admin triggers a password-reset flow for a
// user in their tenant. Supabase sends the recovery email; the admin call
// also invalidates all existing sessions so the target user cannot continue
// operating on the old credential while the reset is outstanding.
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

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;

    const userIdR = requireString(parsed.body, "user_id");
    if (!userIdR.ok) return problemResponse(userIdR.problem);
    const targetId = userIdR.value;

    const target = await getUserInTenant(ctx.adminClient, targetId, ctx.tenantId);
    if (!target.ok) return problemResponse(target.problem);

    // 1. Generate recovery link. Supabase sends the email via the configured
    //    SMTP provider (Mailpit locally, Resend in prod once §11.1 wiring lands).
    const { data: linkData, error: linkErr } = await ctx.adminClient.auth.admin.generateLink({
      type: "recovery",
      email: target.user.email,
    });
    if (linkErr || !linkData.properties?.action_link) {
      return problemResponse(Problems.SupabaseAuthError(linkErr?.message ?? "recovery link generation failed"));
    }

    // 2. Revoke all current sessions so the target can't keep acting while
    //    the reset is outstanding.
    const invErr = await invalidateUserSessions(ctx.adminClient, targetId);
    if (invErr) return problemResponse(invErr);

    // 3. Audit.
    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "user.password_reset_admin",
      "user",
      targetId,
      { target_email: target.user.email },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({ ok: true, user_id: targetId, email_sent: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
);
