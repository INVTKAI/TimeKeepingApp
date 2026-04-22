import {
  adminClient,
  assertEquals,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

async function inviteSubmitter(jwt: string): Promise<{ id: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { json, status } = await callEdgeFunction<{ user_id: string }>(
    "invite-user",
    {
      username: `cr-${suffix}`,
      email: `cr-${suffix}@test.invenio.local`,
      role: "submitter",
    },
    { jwt },
  );
  assertEquals(status, 201);
  return { id: json!.user_id };
}

Deno.test("change-role — submitter → admin flips role + invalidates sessions", async () => {
  await withFixture(async (fx) => {
    const target = await inviteSubmitter(fx.adminJwt);

    const res = await callEdgeFunction<{
      role: string;
      changed: boolean;
      previous_role?: string;
    }>(
      "change-role",
      { user_id: target.id, new_role: "admin" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.role, "admin");
    assertEquals(res.json?.changed, true);
    assertEquals(res.json?.previous_role, "submitter");

    const { data } = await adminClient
      .from("users")
      .select("role, sessions_revoked_at")
      .eq("id", target.id)
      .single();
    assertEquals(data?.role, "admin");
    // sessions_revoked_at must be set so the next JWT carries the new app_role.
    assertEquals(typeof data?.sessions_revoked_at, "string");

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("change-role — no-op when role unchanged (changed:false)", async () => {
  await withFixture(async (fx) => {
    const target = await inviteSubmitter(fx.adminJwt);

    const res = await callEdgeFunction<{ changed: boolean }>(
      "change-role",
      { user_id: target.id, new_role: "submitter" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.changed, false);

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("change-role — self-target rejected 409 CannotTargetSelf", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "change-role",
      { user_id: fx.adminUserId, new_role: "submitter" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 409);
    assertEquals(
      res.json?.type,
      "https://api.invenio.example/errors/cannot-target-self",
    );
  });
});

Deno.test("change-role — invalid new_role returns 400", async () => {
  await withFixture(async (fx) => {
    const target = await inviteSubmitter(fx.adminJwt);
    const res = await callEdgeFunction(
      "change-role",
      { user_id: target.id, new_role: "superadmin" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 400);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/validation-error");

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("change-role — revoked users rejected with UserStateConflict", async () => {
  await withFixture(async (fx) => {
    const target = await inviteSubmitter(fx.adminJwt);
    await adminClient.from("users").update({ status: "revoked" }).eq("id", target.id);

    const res = await callEdgeFunction(
      "change-role",
      { user_id: target.id, new_role: "admin" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 409);
    assertEquals(
      res.json?.type,
      "https://api.invenio.example/errors/user-state-conflict",
    );

    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});
