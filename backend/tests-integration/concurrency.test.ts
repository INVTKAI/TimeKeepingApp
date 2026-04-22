// True multi-session concurrency test for the approval state machine.
//
// Spec §7.4 says approve_run protects against concurrent state changes via a
// FOR UPDATE lock + version-matched UPDATE. pgTAP can only exercise the
// single-session branch (the suite asserts P0002 via manual state mutation)
// because every pgTAP file runs inside ONE transaction.
//
// This test fires two fetches in parallel from the same client — because
// HTTP requests fan out to separate Postgres connections via PostgREST,
// they race at the DB level. Expected outcome: exactly one returns 200
// "approved", the other returns a 400-ish PostgREST error carrying
// SQLSTATE P0002 (RUN_STATE_CHANGED).

import {
  adminClient,
  ANON_KEY,
  assertEquals,
  mintJwt,
  SUPABASE_URL,
} from "./_helpers.ts";

type RpcCall = { status: number; body: unknown };

async function rpcApprove(
  runId: string,
  jwt: string,
  comment: string,
): Promise<RpcCall> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/approve_run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: ANON_KEY,
      authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ p_run_id: runId, p_comment: comment }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

Deno.test("concurrency — two parallel approve_run on the same run: exactly one wins with P0002 on the other", async () => {
  const tag = `race-${Date.now().toString(36)}`;
  const tenantId = crypto.randomUUID();

  // --- Seed minimal tenant with ONE node pointing at TWO approvers ---
  await adminClient.from("tenants").insert({
    id: tenantId,
    name: `Race ${tag}`,
    slug: tag,
    email_from_address: "hr@race.test",
  });
  const { data: sub } = await adminClient
    .from("subcontractors")
    .insert({ tenant_id: tenantId, name: "Acme", short_code: `A-${tag}` })
    .select("id")
    .single();
  const { data: project } = await adminClient
    .from("projects")
    .insert({ tenant_id: tenantId, number: `R-${tag}`, name: `Race ${tag}` })
    .select("id")
    .single();
  const { data: employee } = await adminClient
    .from("employees")
    .insert({
      tenant_id: tenantId,
      first_name: "E",
      last_name: "Worker",
      type: "staff",
      subcontractor_id: sub!.id,
      active: true,
    })
    .select("id")
    .single();

  const submitterEmail = `submitter-${tag}@race.test`;
  const { data: subAuth } = await adminClient.auth.admin.createUser({
    email: submitterEmail,
    password: `Pass-${tag}!!12345`,
    email_confirm: true,
    user_metadata: { tenant_id: tenantId, app_role: "submitter", username: `submitter-${tag}` },
  });
  const submitterId = subAuth!.user!.id;
  await adminClient.from("users").insert({
    id: submitterId,
    tenant_id: tenantId,
    username: `submitter-${tag}`,
    email: submitterEmail,
    role: "submitter",
    employee_id: employee!.id,
    status: "active",
  });

  // Two approvers — both eligible on the same node so both could legitimately
  // act first. This models the "two PMs see the same run, both click Approve"
  // scenario the version check is designed to survive.
  const a1Email = `a1-${tag}@race.test`;
  const { data: a1Auth } = await adminClient.auth.admin.createUser({
    email: a1Email,
    password: `Pass-${tag}!!12345`,
    email_confirm: true,
    user_metadata: { tenant_id: tenantId, app_role: "submitter", username: `a1-${tag}` },
  });
  const a1Id = a1Auth!.user!.id;
  await adminClient.from("users").insert({
    id: a1Id,
    tenant_id: tenantId,
    username: `a1-${tag}`,
    email: a1Email,
    role: "submitter",
    status: "active",
  });

  const a2Email = `a2-${tag}@race.test`;
  const { data: a2Auth } = await adminClient.auth.admin.createUser({
    email: a2Email,
    password: `Pass-${tag}!!12345`,
    email_confirm: true,
    user_metadata: { tenant_id: tenantId, app_role: "submitter", username: `a2-${tag}` },
  });
  const a2Id = a2Auth!.user!.id;
  await adminClient.from("users").insert({
    id: a2Id,
    tenant_id: tenantId,
    username: `a2-${tag}`,
    email: a2Email,
    role: "submitter",
    status: "active",
  });

  const { data: flow } = await adminClient
    .from("approval_flows")
    .insert({ tenant_id: tenantId, name: `flow-${tag}` })
    .select("id")
    .single();
  const { data: node } = await adminClient
    .from("approval_nodes")
    .insert({
      flow_id: flow!.id,
      tenant_id: tenantId,
      ordinal: 1,
      name: "single",
    })
    .select("id")
    .single();
  // Both approvers on the same node — either is eligible.
  await adminClient.from("approval_node_approvers").insert([
    { node_id: node!.id, tenant_id: tenantId, approver_type: "user", user_id: a1Id },
    { node_id: node!.id, tenant_id: tenantId, approver_type: "user", user_id: a2Id },
  ]);
  await adminClient.from("project_flow_assignments").insert({
    tenant_id: tenantId,
    project_id: project!.id,
    flow_id: flow!.id,
    effective_from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
  });
  await adminClient.from("project_subcontractors").insert({
    tenant_id: tenantId,
    project_id: project!.id,
    subcontractor_id: sub!.id,
    start_date: new Date().toISOString().slice(0, 10),
  });

  // Timesheet + submit
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  const { data: ts } = await adminClient
    .from("timesheets")
    .insert({
      tenant_id: tenantId,
      kind: "staff",
      status: "draft",
      submitter_user_id: submitterId,
      employee_id: employee!.id,
      project_id: project!.id,
      subcontractor_id: sub!.id,
      period_start: today,
      period_end: weekEnd,
    })
    .select("id")
    .single();
  await adminClient.from("timesheet_lines").insert([
    {
      timesheet_id: ts!.id,
      tenant_id: tenantId,
      date: today,
      employee_id: employee!.id,
      hours_st: 8,
      hours_ot: 0,
    },
  ]);

  const submitterJwt = await mintJwt({
    sub: submitterId,
    tenant_id: tenantId,
    app_role: "submitter",
    username: `submitter-${tag}`,
    email: submitterEmail,
  });
  const submitRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_timesheet`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: ANON_KEY,
      authorization: `Bearer ${submitterJwt}`,
    },
    body: JSON.stringify({ p_timesheet_id: ts!.id }),
  });
  const submitBody = await submitRes.json();
  assertEquals(submitRes.status, 200);
  const runId = submitBody.run_id as string;

  // --- The race -------------------------------------------------------
  const a1Jwt = await mintJwt({
    sub: a1Id,
    tenant_id: tenantId,
    app_role: "submitter",
    username: `a1-${tag}`,
    email: a1Email,
  });
  const a2Jwt = await mintJwt({
    sub: a2Id,
    tenant_id: tenantId,
    app_role: "submitter",
    username: `a2-${tag}`,
    email: a2Email,
  });

  const [r1, r2] = await Promise.all([
    rpcApprove(runId, a1Jwt, "A1 says yes"),
    rpcApprove(runId, a2Jwt, "A2 says yes"),
  ]);

  // --- Expectations ---------------------------------------------------
  // Exactly one of (r1, r2) is 200-OK; the other carries P0002 in its body.
  // PostgREST's mapping of RAISE EXCEPTION with custom SQLSTATE: the body
  // is JSON with `code` = the SQLSTATE, `message` = the RAISE MESSAGE.
  // HTTP status is typically 400 for P0*, but the authoritative marker is
  // body.code.
  const winners = [r1, r2].filter((r) => r.status === 200);
  const losers = [r1, r2].filter((r) => r.status !== 200);
  assertEquals(
    winners.length,
    1,
    `expected exactly 1 winner, got ${winners.length} (r1=${r1.status}, r2=${r2.status})`,
  );
  assertEquals(
    losers.length,
    1,
    `expected exactly 1 loser, got ${losers.length}`,
  );

  const loserBody = losers[0].body as { code?: string; message?: string };
  assertEquals(
    loserBody.code,
    "P0002",
    `loser should carry P0002 RUN_STATE_CHANGED; got code=${loserBody.code} message=${loserBody.message}`,
  );

  // Sanity: run is now approved, timesheet is approved.
  const { data: runAfter } = await adminClient
    .from("approval_runs")
    .select("status, version")
    .eq("id", runId)
    .single();
  assertEquals(runAfter?.status, "approved");
  assertEquals(runAfter?.version, 1); // bumped exactly once

  const { data: tsAfter } = await adminClient
    .from("timesheets")
    .select("status")
    .eq("id", ts!.id)
    .single();
  assertEquals(tsAfter?.status, "approved");

  // --- Cleanup --------------------------------------------------------
  await adminClient.from("notification_outbox").delete().eq("tenant_id", tenantId);
  await adminClient.from("approval_actions").delete().eq("tenant_id", tenantId);
  await adminClient.from("approval_runs").delete().eq("tenant_id", tenantId);
  await adminClient.from("timesheet_lines").delete().eq("tenant_id", tenantId);
  await adminClient.from("timesheets").delete().eq("tenant_id", tenantId);
  await adminClient.from("project_flow_assignments").delete().eq("tenant_id", tenantId);
  await adminClient.from("approval_node_approvers").delete().eq("tenant_id", tenantId);
  await adminClient.from("approval_nodes").delete().eq("tenant_id", tenantId);
  await adminClient.from("approval_flows").delete().eq("tenant_id", tenantId);
  await adminClient.from("project_subcontractors").delete().eq("tenant_id", tenantId);
  await adminClient.from("projects").delete().eq("tenant_id", tenantId);
  await adminClient.from("employees").delete().eq("tenant_id", tenantId);
  await adminClient.from("users").delete().eq("tenant_id", tenantId);
  await adminClient.from("subcontractors").delete().eq("tenant_id", tenantId);
  await adminClient.from("tenants").delete().eq("id", tenantId);
  await adminClient.auth.admin.deleteUser(submitterId).catch(() => {});
  await adminClient.auth.admin.deleteUser(a1Id).catch(() => {});
  await adminClient.auth.admin.deleteUser(a2Id).catch(() => {});
});
