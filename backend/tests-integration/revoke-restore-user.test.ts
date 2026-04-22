import {
  adminClient,
  assertEquals,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

async function inviteTestUser(
  jwt: string,
  suffix: string,
): Promise<{ id: string; email: string; username: string }> {
  const email = `target-${suffix}-${Date.now()}@test.invenio.local`;
  const username = `target-${suffix}-${Date.now()}`;
  const res = await callEdgeFunction<{ user_id: string }>(
    "invite-user",
    { username, email, role: "submitter" },
    { jwt },
  );
  assertEquals(res.status, 201);
  return { id: res.json!.user_id, email, username };
}

Deno.test("revoke-user — flips status to revoked + sets sessions_revoked_at", async () => {
  await withFixture(async (fx) => {
    const target = await inviteTestUser(fx.adminJwt, "rev");

    const res = await callEdgeFunction(
      "revoke-user",
      { user_id: target.id },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);

    const { data } = await adminClient
      .from("users")
      .select("status, sessions_revoked_at")
      .eq("id", target.id)
      .single();
    assertEquals(data?.status, "revoked");
    // sessions_revoked_at is set to a timestamp so §4.2 assert_session_live
    // rejects any outstanding JWTs issued before that moment.
    assertEquals(typeof data?.sessions_revoked_at, "string");

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("revoke-user — rejects self-revocation (409 CannotTargetSelf)", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "revoke-user",
      { user_id: fx.adminUserId },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 409);
    assertEquals(
      res.json?.type,
      "https://api.invenio.example/errors/cannot-target-self",
    );
  });
});

Deno.test("revoke-user — 404 on cross-tenant user_id", async () => {
  await withFixture(async (fx) => {
    // An id that doesn't exist in this tenant — expect 404 (no existence leak).
    const res = await callEdgeFunction(
      "revoke-user",
      { user_id: "00000000-0000-0000-0000-000000000000" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 404);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/user-not-found");
  });
});

Deno.test("restore-user — flips revoked → pending (new password required)", async () => {
  // Spec §4.6: restore lifts the Supabase ban + generates a fresh recovery
  // link, but public.users.status goes back to 'pending', not 'active' —
  // the restored user must complete a new password flow before signing in.
  await withFixture(async (fx) => {
    const target = await inviteTestUser(fx.adminJwt, "rst");

    await adminClient
      .from("users")
      .update({ status: "revoked" })
      .eq("id", target.id);

    const res = await callEdgeFunction<{ status: string }>(
      "restore-user",
      { user_id: target.id },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.status, "pending");

    const { data } = await adminClient
      .from("users")
      .select("status")
      .eq("id", target.id)
      .single();
    assertEquals(data?.status, "pending");

    // restore-user on a non-revoked user should 409.
    const bad = await callEdgeFunction(
      "restore-user",
      { user_id: target.id },
      { jwt: fx.adminJwt },
    );
    assertEquals(bad.status, 409);

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("revoke-user — idempotent on an already-revoked user", async () => {
  await withFixture(async (fx) => {
    const target = await inviteTestUser(fx.adminJwt, "idm");
    // Flip to active first (invite leaves as pending; revoke needs active).
    await adminClient.from("users").update({ status: "active" }).eq("id", target.id);

    const first = await callEdgeFunction(
      "revoke-user",
      { user_id: target.id },
      { jwt: fx.adminJwt },
    );
    assertEquals(first.status, 200);

    const second = await callEdgeFunction(
      "revoke-user",
      { user_id: target.id },
      { jwt: fx.adminJwt },
    );
    // Second call should conflict because user is no longer 'active'.
    assertEquals(second.status, 409);
    assertEquals(
      second.json?.type,
      "https://api.invenio.example/errors/user-state-conflict",
    );

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});
