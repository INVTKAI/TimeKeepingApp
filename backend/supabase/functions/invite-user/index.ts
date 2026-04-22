// invite-user — spec §4.3. Admin creates a new user, inserts the paired
// public.users row (status='pending'), and sends an invite email carrying a
// one-time password-setup token. tenant_id + app_role are injected into
// auth.users.user_metadata so the custom access-token hook can read them
// when the user first signs in.
//
// Body: { username, email, role, employee_id? }
//   username   — tenant-unique, per public.users UNIQUE(tenant_id, username)
//   email      — tenant-unique, per public.users UNIQUE(tenant_id, email)
//   role       — 'admin' | 'submitter' (user_role enum)
//   employee_id — optional FK to public.employees (required for submitters
//                 who submit their own timesheets; NULL for non-worker admins)

import "@supabase/functions-js/edge-runtime.d.ts";
import { withAdminContext } from "../_shared/with-admin-context.ts";
import { Problems, problemResponse } from "../_shared/problem.ts";
import { parseJsonBody, requireString, writeAudit } from "../_shared/admin-helpers.ts";

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const usernameR = requireString(body, "username");
    if (!usernameR.ok) return problemResponse(usernameR.problem);
    const emailR = requireString(body, "email");
    if (!emailR.ok) return problemResponse(emailR.problem);
    const roleR = requireString(body, "role");
    if (!roleR.ok) return problemResponse(roleR.problem);

    if (roleR.value !== "admin" && roleR.value !== "submitter") {
      return problemResponse(
        Problems.ValidationError("role must be 'admin' or 'submitter'"),
      );
    }
    const employeeId = typeof body.employee_id === "string" ? body.employee_id : null;

    // 1. Pre-flight uniqueness check in THIS tenant. Supabase's
    //    inviteUserByEmail treats a repeat invite for an existing email as
    //    idempotent-resend (returns the existing auth.users row) — so checking
    //    our own public.users first is the only way to safely fail before
    //    touching Supabase Auth state.
    const { data: existing, error: existingErr } = await ctx.adminClient
      .from("users")
      .select("id, username, email")
      .eq("tenant_id", ctx.tenantId)
      .or(`username.eq.${usernameR.value},email.eq.${emailR.value}`)
      .maybeSingle();
    if (existingErr) return problemResponse(Problems.Internal(existingErr.message));
    if (existing) {
      return problemResponse(
        Problems.UserStateConflict(
          "A user with this username or email already exists in this tenant.",
        ),
      );
    }

    // 2. Invite via Supabase Auth. This creates auth.users (or reuses an
    //    existing one at the tenant-agnostic auth.users level) AND queues
    //    the invite email (delivered via Mailpit locally; via Resend in prod
    //    once §11.1 SMTP is wired). The `data` field lands in
    //    auth.users.raw_user_meta_data; the custom access-token hook can
    //    read it as a fallback, but the authoritative source is the
    //    public.users row inserted next.
    const { data: inviteData, error: inviteErr } = await ctx.adminClient.auth.admin
      .inviteUserByEmail(emailR.value, {
        data: { tenant_id: ctx.tenantId, app_role: roleR.value, username: usernameR.value },
      });
    if (inviteErr || !inviteData.user) {
      return problemResponse(
        Problems.SupabaseAuthError(inviteErr?.message ?? "unknown invite error"),
      );
    }
    const newUserId = inviteData.user.id;

    // 3. Insert the paired public.users row. With the preflight check above,
    //    a 23505 here indicates a concurrent-invite race — vanishingly rare
    //    for admin-driven flows, but surface it cleanly.
    const { error: publicInsertErr } = await ctx.adminClient.from("users").insert({
      id: newUserId,
      tenant_id: ctx.tenantId,
      username: usernameR.value,
      email: emailR.value,
      role: roleR.value,
      employee_id: employeeId,
      status: "pending",
      created_by: ctx.userId,
    });
    if (publicInsertErr) {
      if (publicInsertErr.code === "23505") {
        return problemResponse(
          Problems.UserStateConflict(
            "Concurrent invite created the same user; retry or inspect audit log.",
          ),
        );
      }
      return problemResponse(Problems.Internal(publicInsertErr.message));
    }

    // 3. Audit trail.
    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "user.invite",
      "user",
      newUserId,
      { username: usernameR.value, email: emailR.value, role: roleR.value },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({
        ok: true,
        user_id: newUserId,
        username: usernameR.value,
        email: emailR.value,
        role: roleR.value,
        status: "pending",
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }),
);
