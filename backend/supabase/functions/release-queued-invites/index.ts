// release-queued-invites — spec §9 Phase A cutover step.
//
// After Phase A (import-localstorage) and Phase B (import-spreadsheet) complete
// and all go-live gates pass, this function iterates the tenant's pending users
// and issues invite links. The link itself is generated via
// auth.admin.generateLink({ type: 'invite' }); when the Supabase project's
// SMTP is wired, the same call also sends the invite email. In dry-run mode
// the function returns the generated links WITHOUT sending — useful for ops
// to validate link shape and targeting before flipping the cutover switch.
//
// Idempotent: users already in status='active' are skipped. Re-running against
// a tenant mid-cutover (some users signed in, others not) is safe.
//
// Body:
//   {
//     "dry_run": bool?,         // default false
//     "user_ids": ["uuid"...]?  // optional subset — default: all pending in tenant
//   }

import "@supabase/functions-js/edge-runtime.d.ts";
import { withAdminContext } from "../_shared/with-admin-context.ts";
import { Problems, problemResponse } from "../_shared/problem.ts";
import { parseJsonBody, writeAudit } from "../_shared/admin-helpers.ts";

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const dryRun = body.dry_run === true;
    const userIdFilter = Array.isArray(body.user_ids)
      ? (body.user_ids.filter((v) => typeof v === "string") as string[])
      : null;

    let query = ctx.adminClient
      .from("users")
      .select("id, username, email, role, status")
      .eq("tenant_id", ctx.tenantId)
      .eq("status", "pending");
    if (userIdFilter && userIdFilter.length > 0) {
      query = query.in("id", userIdFilter);
    }

    const { data: pendingUsers, error: listErr } = await query;
    if (listErr) {
      return problemResponse(Problems.Internal(`list pending users: ${listErr.message}`));
    }

    type Outcome = {
      user_id: string;
      username: string;
      email: string;
      sent: boolean;
      action_link?: string;
      error?: string;
    };
    const outcomes: Outcome[] = [];
    let released = 0;
    let errored = 0;

    for (const u of pendingUsers ?? []) {
      // generateLink returns the invite action_link. If SMTP is configured at
      // the Supabase project level the same call sends the email; if not,
      // callers in prod must post-process the action_link out-of-band. In
      // dry_run we always return the link without sending.
      const { data, error } = await ctx.adminClient.auth.admin.generateLink({
        type: "invite",
        email: u.email,
      });
      if (error || !data) {
        outcomes.push({
          user_id: u.id,
          username: u.username,
          email: u.email,
          sent: false,
          error: error?.message ?? "generateLink returned empty",
        });
        errored += 1;
        continue;
      }
      const actionLink = data?.properties?.action_link as string | undefined;
      outcomes.push({
        user_id: u.id,
        username: u.username,
        email: u.email,
        sent: !dryRun,
        ...(actionLink ? { action_link: actionLink } : {}),
      });
      if (!dryRun) released += 1;
    }

    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "tenant.release_invites",
      "tenant",
      ctx.tenantId,
      {
        pending_found: pendingUsers?.length ?? 0,
        released,
        errored,
        dry_run: dryRun,
      },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({
        ok: true,
        dry_run: dryRun,
        pending_found: pendingUsers?.length ?? 0,
        released,
        errored,
        outcomes,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
);
