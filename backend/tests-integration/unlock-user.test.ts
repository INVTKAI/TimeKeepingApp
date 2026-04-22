import {
  adminClient,
  assertEquals,
  assertExists,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

async function inviteTarget(jwt: string): Promise<{ id: string }> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { json, status } = await callEdgeFunction<{ user_id: string }>(
    "invite-user",
    {
      username: `ulk-${suffix}`,
      email: `ulk-${suffix}@test.invenio.local`,
      role: "submitter",
    },
    { jwt },
  );
  assertEquals(status, 201);
  return { id: json!.user_id };
}

Deno.test("unlock-user — inserts user_unlock_markers row + clears counter", async () => {
  await withFixture(async (fx) => {
    const target = await inviteTarget(fx.adminJwt);

    // Seed a synthetic counter row — unlock should delete it. Schema: user_id
    // is PK; failure_count is the bump column; tenant lives on public.users.
    const { error: seedErr } = await adminClient
      .from("login_failure_counters")
      .insert({ user_id: target.id, failure_count: 5 });
    assertEquals(seedErr, null);

    const res = await callEdgeFunction<{
      marker_id: string;
      unlocked_at: string;
    }>("unlock-user", { user_id: target.id }, { jwt: fx.adminJwt });
    assertEquals(res.status, 200);
    assertExists(res.json?.marker_id);
    assertExists(res.json?.unlocked_at);

    // Marker is present.
    const { data: marker } = await adminClient
      .from("user_unlock_markers")
      .select("id, unlocked_by, tenant_id")
      .eq("id", res.json!.marker_id)
      .single();
    assertEquals(marker?.tenant_id, fx.tenantId);
    assertEquals(marker?.unlocked_by, fx.adminUserId);

    // Counter cleared.
    const { data: counter, error: counterErr } = await adminClient
      .from("login_failure_counters")
      .select("user_id")
      .eq("user_id", target.id);
    assertEquals(counterErr, null);
    assertEquals(counter ?? [], []);

    // Audit trail.
    const { data: audit } = await adminClient
      .from("audit_events")
      .select("action_type")
      .eq("tenant_id", fx.tenantId)
      .eq("subject_id", target.id)
      .eq("action_type", "user.unlock")
      .limit(1);
    assertEquals(audit?.length, 1);

    await adminClient.from("user_unlock_markers").delete().eq("id", res.json!.marker_id);
    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("unlock-user — works fine when there's no prior counter", async () => {
  await withFixture(async (fx) => {
    const target = await inviteTarget(fx.adminJwt);
    const res = await callEdgeFunction<{ marker_id: string }>(
      "unlock-user",
      { user_id: target.id },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertExists(res.json?.marker_id);

    await adminClient.from("user_unlock_markers").delete().eq("id", res.json!.marker_id);
    await adminClient.from("users").delete().eq("id", target.id);
    await adminClient.auth.admin.deleteUser(target.id).catch(() => {});
  });
});

Deno.test("unlock-user — 404 on cross-tenant user", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "unlock-user",
      { user_id: "00000000-0000-0000-0000-000000000000" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 404);
  });
});
