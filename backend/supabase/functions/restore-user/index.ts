// restore-user — spec §4.6. Reverses a revoke: lifts the Supabase ban,
// sends the restored user a password-reset email (forces new password
// before next login), and flips public.users.status from 'revoked' back
// to 'pending'.
//
// Body: { user_id }

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
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

    if (target.user.status !== "revoked") {
      return problemResponse(
        Problems.UserStateConflict(
          `Cannot restore a user in '${target.user.status}' state; restore applies only to 'revoked' users.`,
        ),
      );
    }

    // 1. Lift the Supabase ban.
    const { error: unbanErr } = await ctx.adminClient.auth.admin.updateUserById(targetId, {
      ban_duration: "none",
    });
    if (unbanErr) return problemResponse(Problems.SupabaseAuthError(unbanErr.message));

    // 2. Send the user a password-reset email via the same flow as /reset-password.
    //    Using an anon-key client because resetPasswordForEmail is a public
    //    method that dispatches through Supabase's configured SMTP; calling it
    //    with service-role can suppress email delivery in some configs.
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const anonClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const redirectBase = Deno.env.get("INVITE_REDIRECT_BASE");
    const redirectTo = redirectBase
      ? `${redirectBase.replace(/\/$/, "")}/accept-invite`
      : undefined;

    const { error: resetErr } = await anonClient.auth.resetPasswordForEmail(
      target.user.email,
      redirectTo ? { redirectTo } : undefined,
    );
    if (resetErr) {
      return problemResponse(
        Problems.SupabaseAuthError(`password-reset email failed: ${resetErr.message}`),
      );
    }

    // 3. Domain marker: pending until they complete the new password flow.
    const { error: updErr } = await ctx.adminClient
      .from("users")
      .update({ status: "pending" })
      .eq("id", targetId)
      .eq("tenant_id", ctx.tenantId);
    if (updErr) return problemResponse(Problems.Internal(updErr.message));

    // 4. Audit.
    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "user.restore",
      "user",
      targetId,
      { target_email: target.user.email },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({ ok: true, user_id: targetId, status: "pending" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
);
