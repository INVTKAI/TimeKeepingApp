import {
  adminClient,
  assertEquals,
  assertExists,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

Deno.test("invite-user — missing Authorization returns 401 problem+json", async () => {
  const res = await callEdgeFunction("invite-user", {});
  assertEquals(res.status, 401);
  assertEquals(res.contentType.includes("problem+json"), true);
  assertEquals(res.json?.type, "https://api.invenio.example/errors/missing-authorization");
});

Deno.test("invite-user — invalid JWT returns 401", async () => {
  const res = await callEdgeFunction("invite-user", {}, { jwt: "not.a.token" });
  assertEquals(res.status, 401);
});

Deno.test("invite-user — validation error on missing fields", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "invite-user",
      { role: "submitter" }, // missing username + email
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 400);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/validation-error");
  });
});

Deno.test("invite-user — happy path creates auth.users + public.users", async () => {
  await withFixture(async (fx) => {
    const inviteEmail = `invitee-${Date.now()}@test.invenio.local`;
    const inviteUsername = `invitee-${Date.now()}`;
    const res = await callEdgeFunction<{
      ok: boolean;
      user_id: string;
      status: string;
    }>(
      "invite-user",
      {
        username: inviteUsername,
        email: inviteEmail,
        role: "submitter",
      },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 201);
    assertEquals(res.json?.ok, true);
    assertEquals(res.json?.status, "pending");
    assertExists(res.json?.user_id);

    // Verify the public.users row landed under the correct tenant.
    const { data: publicRow } = await adminClient
      .from("users")
      .select("id, tenant_id, username, email, role, status")
      .eq("id", res.json!.user_id)
      .single();
    assertExists(publicRow);
    assertEquals(publicRow?.tenant_id, fx.tenantId);
    assertEquals(publicRow?.role, "submitter");
    assertEquals(publicRow?.status, "pending");
    assertEquals(publicRow?.username, inviteUsername);

    // And that audit_events captured it.
    const { data: audit } = await adminClient
      .from("audit_events")
      .select("action_type, subject_id")
      .eq("tenant_id", fx.tenantId)
      .eq("action_type", "user.invite")
      .limit(1);
    assertEquals(audit?.length, 1);
    assertEquals(audit?.[0]?.subject_id, res.json!.user_id);

    // Clean up the invitee we just created (withFixture won't know about them).
    await adminClient.from("users").delete().eq("id", res.json!.user_id);
    await adminClient.auth.admin.deleteUser(res.json!.user_id).catch(() => {});
  });
});

Deno.test("invite-user — duplicate username in same tenant returns 409", async () => {
  await withFixture(async (fx) => {
    const email1 = `dup-${Date.now()}@test.invenio.local`;
    const email2 = `dup2-${Date.now()}@test.invenio.local`;
    const username = `dup-${Date.now()}`;

    const first = await callEdgeFunction<{ user_id: string }>(
      "invite-user",
      { username, email: email1, role: "submitter" },
      { jwt: fx.adminJwt },
    );
    assertEquals(first.status, 201);
    const firstId = first.json!.user_id;

    const second = await callEdgeFunction(
      "invite-user",
      { username, email: email2, role: "submitter" },
      { jwt: fx.adminJwt },
    );
    assertEquals(second.status, 409);
    assertEquals(
      second.json?.type,
      "https://api.invenio.example/errors/user-state-conflict",
    );

    // Cleanup the first invitee.
    await adminClient.from("users").delete().eq("id", firstId);
    await adminClient.auth.admin.deleteUser(firstId).catch(() => {});
  });
});
