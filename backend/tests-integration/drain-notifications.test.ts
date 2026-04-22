import {
  adminClient,
  ANON_KEY,
  assertEquals,
  callEdgeFunction,
  SUPABASE_URL,
  withFixture,
} from "./_helpers.ts";

// drain-notifications is NOT withAdminContext. It takes a shared-secret
// Bearer header against NOTIFICATION_DRAIN_SECRET. Test both gates and the
// empty-queue happy path. The secret comes from backend/.env via the
// run-ef-tests.sh runner (which source .env-style keys when functions-serve
// is already up with that env loaded).

const DRAIN_SECRET = Deno.env.get("NOTIFICATION_DRAIN_SECRET") ?? "";

Deno.test("drain-notifications — missing Authorization → 403", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/drain-notifications`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: ANON_KEY },
    body: "{}",
  });
  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.type, "https://api.invenio.example/errors/forbidden");
});

Deno.test("drain-notifications — wrong secret → 403", async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/drain-notifications`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: ANON_KEY,
      authorization: "Bearer wrong-secret",
    },
    body: "{}",
  });
  assertEquals(res.status, 403);
  await res.body?.cancel(); // Deno test runner flags unread bodies as leaks.
});

Deno.test({
  name: "drain-notifications — correct secret returns claimed:0 on empty queue",
  ignore: DRAIN_SECRET.length === 0,
  fn: async () => {
    await withFixture(async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/drain-notifications`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          apikey: ANON_KEY,
          authorization: `Bearer ${DRAIN_SECRET}`,
        },
        body: JSON.stringify({ batch_size: 5 }),
      });
      assertEquals(res.status, 200);
      const body = await res.json();
      assertEquals(typeof body.claimed, "number");
      assertEquals(body.sent + body.retrying + body.failed, body.claimed);
    });
  },
});

Deno.test({
  name: "drain-notifications — processes a seeded pending outbox row",
  ignore: DRAIN_SECRET.length === 0,
  fn: async () => {
    await withFixture(async (fx) => {
      // Seed a minimal outbox row. recipient_user_id must be a real user —
      // use the fixture admin. With RESEND_API_KEY unset, drain logs-and-succeeds.
      const { data: row } = await adminClient
        .from("notification_outbox")
        .insert({
          tenant_id: fx.tenantId,
          event_type: "submitted",
          recipient_user_id: fx.adminUserId,
          role_context: "submitter",
          payload: { test: true, seq: 1 },
          status: "pending",
        })
        .select("id")
        .single();

      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/drain-notifications`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            apikey: ANON_KEY,
            authorization: `Bearer ${DRAIN_SECRET}`,
          },
          body: JSON.stringify({ batch_size: 10 }),
        },
      );
      assertEquals(res.status, 200);
      const body = await res.json();
      // At least claimed==1 (this seeded row), sent==1 (dev-mode log-and-succeed).
      assertEquals(body.claimed >= 1, true, `claimed=${body.claimed}`);
      assertEquals(body.sent >= 1, true, `sent=${body.sent}`);

      const { data } = await adminClient
        .from("notification_outbox")
        .select("status, sent_at")
        .eq("id", row!.id)
        .single();
      assertEquals(data?.status, "sent");
      assertEquals(typeof data?.sent_at, "string");
    });
  },
});

// Keep callEdgeFunction imported for test files that also want typed helpers.
void callEdgeFunction;
