// End-to-end happy path — seeds a tenant from scratch, drives the full
// submit → approve → drain → delivered pipeline, asserts each state
// transition. Intended as the ops smoke before every release: "did we break
// anything that a single user would notice?"
//
// NOT meant to run against prod by default (it'd leave seed rows). If you
// want to run against prod for a canary, swap the Supabase URL + keys and
// accept that cleanup is best-effort.

import {
  adminClient,
  assertEquals,
  assertExists,
  callEdgeFunction,
  mintJwt,
  SUPABASE_URL,
  ANON_KEY,
} from "./_helpers.ts";

const DRAIN_SECRET = Deno.env.get("NOTIFICATION_DRAIN_SECRET") ?? "";

Deno.test({
  name: "e2e — staff timesheet: seed → submit → approve → drain → sent",
  ignore: DRAIN_SECRET.length === 0,
  fn: async () => {
    const tag = `e2e-${Date.now().toString(36)}`;
    const tenantId = crypto.randomUUID();

    // --- Provision tenant + principals ----------------------------------
    const { error: tErr } = await adminClient.from("tenants").insert({
      id: tenantId,
      name: `E2E ${tag}`,
      slug: tag,
      email_from_address: "hr@e2e.invenio.local",
    });
    assertEquals(tErr, null);

    // Admin
    const adminEmail = `admin-${tag}@e2e.invenio.local`;
    const { data: adminAuth } = await adminClient.auth.admin.createUser({
      email: adminEmail,
      password: `Pass-${tag}!!12345`,
      email_confirm: true,
      user_metadata: { tenant_id: tenantId, app_role: "admin", username: `admin-${tag}` },
    });
    const adminId = adminAuth!.user!.id;
    await adminClient.from("users").insert({
      id: adminId,
      tenant_id: tenantId,
      username: `admin-${tag}`,
      email: adminEmail,
      role: "admin",
      status: "active",
    });

    // Sub + employee used by both submitter and timesheet
    const { data: sub } = await adminClient
      .from("subcontractors")
      .insert({ tenant_id: tenantId, name: "Invenio", short_code: `INV-${tag}` })
      .select("id")
      .single();

    // Project + area + task
    const { data: project } = await adminClient
      .from("projects")
      .insert({ tenant_id: tenantId, number: `E2E-${tag}`, name: `E2E Project ${tag}` })
      .select("id")
      .single();
    const { data: area } = await adminClient
      .from("areas")
      .insert({ tenant_id: tenantId, project_id: project!.id, code: "UNIT-1", name: "Unit 1" })
      .select("id")
      .single();
    const { data: taskCode } = await adminClient
      .from("task_codes")
      .insert({ tenant_id: tenantId, code: "INST", name: "Install" })
      .select("id")
      .single();

    // Submitter user + linked employee
    const { data: employee } = await adminClient
      .from("employees")
      .insert({
        tenant_id: tenantId,
        first_name: "E2E",
        last_name: "Employee",
        type: "staff",
        subcontractor_id: sub!.id,
        active: true,
        external_id: `EMP-${tag}`,
      })
      .select("id")
      .single();

    const submitterEmail = `sub-${tag}@e2e.invenio.local`;
    const { data: subAuth } = await adminClient.auth.admin.createUser({
      email: submitterEmail,
      password: `Pass-${tag}!!12345`,
      email_confirm: true,
      user_metadata: { tenant_id: tenantId, app_role: "submitter", username: `sub-${tag}` },
    });
    const submitterId = subAuth!.user!.id;
    await adminClient.from("users").insert({
      id: submitterId,
      tenant_id: tenantId,
      username: `sub-${tag}`,
      email: submitterEmail,
      role: "submitter",
      employee_id: employee!.id,
      status: "active",
    });

    // Approver user — different identity so submitter can't self-approve
    const approverEmail = `appr-${tag}@e2e.invenio.local`;
    const { data: apprAuth } = await adminClient.auth.admin.createUser({
      email: approverEmail,
      password: `Pass-${tag}!!12345`,
      email_confirm: true,
      user_metadata: { tenant_id: tenantId, app_role: "submitter", username: `appr-${tag}` },
    });
    const approverId = apprAuth!.user!.id;
    await adminClient.from("users").insert({
      id: approverId,
      tenant_id: tenantId,
      username: `appr-${tag}`,
      email: approverEmail,
      role: "submitter",
      status: "active",
    });

    // --- Flow template with a single node pointing at the approver -----
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
        name: "Project Manager",
      })
      .select("id")
      .single();
    await adminClient.from("approval_node_approvers").insert({
      node_id: node!.id,
      tenant_id: tenantId,
      approver_type: "user",
      user_id: approverId,
    });
    await adminClient.from("project_flow_assignments").insert({
      tenant_id: tenantId,
      project_id: project!.id,
      flow_id: flow!.id,
      effective_from: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    });

    // Project-sub engagement for RLS (submitter needs visibility via silo)
    await adminClient.from("project_subcontractors").insert({
      tenant_id: tenantId,
      project_id: project!.id,
      subcontractor_id: sub!.id,
      start_date: new Date().toISOString().slice(0, 10),
    });

    // --- Submitter creates a staff timesheet (draft) ---------------------
    const periodStart = new Date().toISOString().slice(0, 10);
    const periodEnd = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
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
        period_start: periodStart,
        period_end: periodEnd,
      })
      .select("id")
      .single();
    await adminClient.from("timesheet_lines").insert([
      {
        timesheet_id: ts!.id,
        tenant_id: tenantId,
        date: periodStart,
        area_id: area!.id,
        task_code_id: taskCode!.id,
        employee_id: employee!.id,
        hours_st: 8,
        hours_ot: 0,
      },
    ]);

    // --- Submit via submitter's JWT ---------------------------------------
    const submitterJwt = await mintJwt({
      sub: submitterId,
      tenant_id: tenantId,
      app_role: "submitter",
      username: `sub-${tag}`,
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
    assertEquals(submitRes.status, 200, `submit failed: ${JSON.stringify(submitBody)}`);
    assertEquals(submitBody?.ok, true);

    const runId = submitBody.run_id as string;
    assertExists(runId);

    // Timesheet flips straight to in_review (submit_timesheet collapses the
    // transient 'submitted' state inside the same transaction per the
    // migration 20260422024529 comment).
    const { data: tsAfterSubmit } = await adminClient
      .from("timesheets")
      .select("status")
      .eq("id", ts!.id)
      .single();
    assertEquals(tsAfterSubmit?.status, "in_review");

    // --- Approve via approver's JWT ---------------------------------------
    const approverJwt = await mintJwt({
      sub: approverId,
      tenant_id: tenantId,
      app_role: "submitter",
      username: `appr-${tag}`,
      email: approverEmail,
    });

    const approveRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/approve_run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: ANON_KEY,
        authorization: `Bearer ${approverJwt}`,
      },
      body: JSON.stringify({ p_run_id: runId, p_comment: "LGTM" }),
    });
    const approveBody = await approveRes.json();
    assertEquals(approveRes.status, 200, `approve failed: ${JSON.stringify(approveBody)}`);
    assertEquals(approveBody?.status, "approved");
    assertEquals(approveBody?.terminal, true);

    // Timesheet flipped to approved
    const { data: tsAfterApprove } = await adminClient
      .from("timesheets")
      .select("status")
      .eq("id", ts!.id)
      .single();
    assertEquals(tsAfterApprove?.status, "approved");

    // --- Notification outbox populated -----------------------------------
    const { data: outbox } = await adminClient
      .from("notification_outbox")
      .select("id, event_type, recipient_user_id, status")
      .eq("tenant_id", tenantId);
    assertEquals((outbox?.length ?? 0) >= 1, true, `expected outbox rows, got ${outbox?.length}`);
    // All should be pending before drain.
    for (const row of outbox ?? []) {
      assertEquals(row.status, "pending");
    }

    // --- Drain -----------------------------------------------------------
    const drainRes = await fetch(`${SUPABASE_URL}/functions/v1/drain-notifications`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: ANON_KEY,
        authorization: `Bearer ${DRAIN_SECRET}`,
      },
      body: JSON.stringify({ batch_size: 20 }),
    });
    const drainBody = await drainRes.json();
    assertEquals(drainRes.status, 200);
    assertEquals(drainBody.claimed >= 1, true);
    assertEquals(drainBody.sent >= 1, true);
    assertEquals(drainBody.failed, 0);

    // --- All outbox rows now sent ---------------------------------------
    const { data: postDrainOutbox } = await adminClient
      .from("notification_outbox")
      .select("status, sent_at")
      .eq("tenant_id", tenantId);
    for (const row of postDrainOutbox ?? []) {
      assertEquals(row.status, "sent");
      assertEquals(typeof row.sent_at, "string");
    }

    // --- Cleanup ---------------------------------------------------------
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
    await adminClient.from("task_codes").delete().eq("tenant_id", tenantId);
    await adminClient.from("areas").delete().eq("tenant_id", tenantId);
    await adminClient.from("projects").delete().eq("tenant_id", tenantId);
    await adminClient.from("employees").delete().eq("tenant_id", tenantId);
    await adminClient.from("users").delete().eq("tenant_id", tenantId);
    await adminClient.from("subcontractors").delete().eq("tenant_id", tenantId);
    await adminClient.from("tenants").delete().eq("id", tenantId);
    await adminClient.auth.admin.deleteUser(adminId).catch(() => {});
    await adminClient.auth.admin.deleteUser(submitterId).catch(() => {});
    await adminClient.auth.admin.deleteUser(approverId).catch(() => {});
  },
});
