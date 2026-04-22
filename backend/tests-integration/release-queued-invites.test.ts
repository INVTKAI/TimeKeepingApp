import {
  adminClient,
  assertEquals,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

// Helper: create a pending user directly (skip invite-user's auth flow so we
// don't conflate with the queued-invite call under test).
async function seedPendingUser(
  tenantId: string,
  tag: string,
): Promise<{ id: string; email: string; username: string }> {
  const email = `rqi-${tag}@test.invenio.local`;
  const username = `rqi-${tag}`;
  const { data: authData, error } = await adminClient.auth.admin.createUser({
    email,
    email_confirm: false,
    user_metadata: { tenant_id: tenantId, app_role: "submitter", username },
  });
  if (error || !authData?.user) throw new Error(`seed pending user: ${error?.message}`);
  const id = authData.user.id;
  await adminClient.from("users").insert({
    id,
    tenant_id: tenantId,
    username,
    email,
    role: "submitter",
    status: "pending",
  });
  return { id, email, username };
}

async function cleanupUser(id: string): Promise<void> {
  await adminClient.from("users").delete().eq("id", id);
  await adminClient.auth.admin.deleteUser(id).catch(() => {});
}

Deno.test("release-queued-invites — empty tenant returns pending_found=0", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction<{
      pending_found: number;
      released: number;
      outcomes: unknown[];
    }>("release-queued-invites", {}, { jwt: fx.adminJwt });
    assertEquals(res.status, 200);
    assertEquals(res.json?.pending_found, 0);
    assertEquals(res.json?.released, 0);
    assertEquals(res.json?.outcomes?.length, 0);
  });
});

Deno.test("release-queued-invites — dry_run returns action_links without sending", async () => {
  await withFixture(async (fx) => {
    const tag = Math.random().toString(36).slice(2, 6);
    const pending = await seedPendingUser(fx.tenantId, tag);

    const res = await callEdgeFunction<{
      dry_run: boolean;
      pending_found: number;
      released: number;
      outcomes: Array<{ sent: boolean; action_link?: string }>;
    }>(
      "release-queued-invites",
      { dry_run: true },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.dry_run, true);
    assertEquals(res.json?.pending_found, 1);
    assertEquals(res.json?.released, 0); // dry_run: count held at 0
    assertEquals(res.json?.outcomes?.[0]?.sent, false);
    assertEquals(
      typeof res.json?.outcomes?.[0]?.action_link === "string",
      true,
    );

    await cleanupUser(pending.id);
  });
});

Deno.test("release-queued-invites — iterates all pending users by default", async () => {
  await withFixture(async (fx) => {
    const u1 = await seedPendingUser(fx.tenantId, `a-${Math.random().toString(36).slice(2, 6)}`);
    const u2 = await seedPendingUser(fx.tenantId, `b-${Math.random().toString(36).slice(2, 6)}`);

    const res = await callEdgeFunction<{
      pending_found: number;
      released: number;
      outcomes: Array<{ user_id: string; sent: boolean }>;
    }>("release-queued-invites", {}, { jwt: fx.adminJwt });
    assertEquals(res.status, 200);
    assertEquals(res.json?.pending_found, 2);
    assertEquals(res.json?.released, 2);
    const sentIds = (res.json?.outcomes ?? [])
      .filter((o) => o.sent)
      .map((o) => o.user_id)
      .sort();
    assertEquals(sentIds, [u1.id, u2.id].sort());

    await cleanupUser(u1.id);
    await cleanupUser(u2.id);
  });
});

Deno.test("release-queued-invites — user_ids filter narrows to a subset", async () => {
  await withFixture(async (fx) => {
    const u1 = await seedPendingUser(fx.tenantId, `x-${Math.random().toString(36).slice(2, 6)}`);
    const u2 = await seedPendingUser(fx.tenantId, `y-${Math.random().toString(36).slice(2, 6)}`);

    const res = await callEdgeFunction<{
      pending_found: number;
      outcomes: Array<{ user_id: string }>;
    }>(
      "release-queued-invites",
      { user_ids: [u1.id] },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.pending_found, 1);
    assertEquals(res.json?.outcomes?.[0]?.user_id, u1.id);

    await cleanupUser(u1.id);
    await cleanupUser(u2.id);
  });
});

Deno.test("release-queued-invites — active users are not surfaced", async () => {
  await withFixture(async (fx) => {
    const pending = await seedPendingUser(fx.tenantId, `z-${Math.random().toString(36).slice(2, 6)}`);
    // Flip to active — release should skip.
    await adminClient.from("users").update({ status: "active" }).eq("id", pending.id);

    const res = await callEdgeFunction<{ pending_found: number }>(
      "release-queued-invites",
      {},
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.pending_found, 0);

    await cleanupUser(pending.id);
  });
});
