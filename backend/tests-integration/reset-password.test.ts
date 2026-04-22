import {
  adminClient,
  assertEquals,
  assertExists,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

async function inviteTarget(jwt: string): Promise<{ id: string; username: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { json, status } = await callEdgeFunction<{ user_id: string }>(
    "invite-user",
    {
      username: `reset-${suffix}`,
      email: `reset-${suffix}@test.invenio.local`,
      role: "submitter",
    },
    { jwt },
  );
  assertEquals(status, 201);
  return { id: json!.user_id, username: `reset-${suffix}` };
}

Deno.test("reset-password — happy path generates link + invalidates sessions", async () => {
  await withFixture(async (fx) => {
    const target = await inviteTarget(fx.adminJwt);

    const res = await callEdgeFunction<{
      ok: boolean;
      user_id: string;
      email_sent: boolean;
    }>("reset-password", { user_id: target.id }, { jwt: fx.adminJwt });
    assertEquals(res.status, 200);
    assertEquals(res.json?.ok, true);
    assertEquals(res.json?.email_sent, true);

    // sessions_revoked_at should be set by invalidateUserSessions.
    const { data } = await adminClient
      .from("users")
      .select("sessions_revoked_at")
      .eq("id", target.id)
      .single();
    assertExists(data?.sessions_revoked_at);

    // Audit trail.
    const { data: audit } = await adminClient
      .from("audit_events")
      .select("action_type")
      .eq("tenant_id", fx.tenantId)
      .eq("subject_id", target.id)
      .eq("action_type", "user.password_reset_admin")
      .limit(1);
    assertEquals(audit?.length, 1);

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("reset-password — 404 on cross-tenant user", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "reset-password",
      { user_id: "00000000-0000-0000-0000-000000000000" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 404);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/user-not-found");
  });
});

Deno.test("reset-password — missing user_id returns 400", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction("reset-password", {}, { jwt: fx.adminJwt });
    assertEquals(res.status, 400);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/validation-error");
  });
});
