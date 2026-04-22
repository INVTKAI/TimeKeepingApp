import {
  adminClient,
  assertEquals,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

Deno.test("export-labor — validation: missing format/from/to", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction("export-labor", {}, { jwt: fx.adminJwt });
    assertEquals(res.status, 400);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/validation-error");
  });
});

Deno.test("export-labor — CSV path returns text/csv with header row", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "export-labor",
      { format: "csv", from: "2024-01-01", to: "2024-12-31" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.contentType.includes("text/csv"), true);
    assertEquals(
      res.text.split("\n")[0],
      "Source,Employee,Emp ID,Craft,Date,Day,Project #,Project Name,Area,Task Code,CWP,FCO/PCR,Type,Hours,Comment",
    );
    assertEquals(res.headers.get("x-invenio-rows"), "0"); // empty tenant
    assertEquals(
      res.headers.get("content-disposition"),
      'attachment; filename="labor-export_2024-01-01_to_2024-12-31.csv"',
    );
  });
});

Deno.test("export-labor — XLSX path returns xlsx binary", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "export-labor",
      { format: "xlsx", from: "2024-01-01", to: "2024-12-31" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(
      res.contentType.includes(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
      true,
    );
    // XLSX files are zip containers — magic bytes: 50 4B 03 04.
    const first4 = res.text.slice(0, 4);
    assertEquals(first4.charCodeAt(0), 0x50);
    assertEquals(first4.charCodeAt(1), 0x4b);
  });
});

Deno.test("export-labor — non-admin JWT is rejected", async () => {
  await withFixture(async (fx) => {
    // Forge a submitter-role JWT for the same tenant.
    const { mintJwt } = await import("./_helpers.ts");
    const submitterJwt = await mintJwt({
      sub: fx.adminUserId, // reuse existing auth.users
      tenant_id: fx.tenantId,
      app_role: "submitter",
      username: fx.adminUsername,
      email: fx.adminEmail,
    });
    const res = await callEdgeFunction(
      "export-labor",
      { format: "csv", from: "2024-01-01", to: "2024-12-31" },
      { jwt: submitterJwt },
    );
    assertEquals(res.status, 403);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/forbidden");
  });
});

Deno.test("export-labor — returns rows for seeded timesheet data", async () => {
  await withFixture(async (fx) => {
    // Seed minimal domain data needed to make an actual row appear.
    const { data: project } = await adminClient
      .from("projects")
      .insert({ tenant_id: fx.tenantId, number: "TEST-001", name: "Export Test Project" })
      .select("id")
      .single();
    const { data: employee } = await adminClient
      .from("employees")
      .insert({
        tenant_id: fx.tenantId,
        first_name: "Test",
        last_name: "Worker",
        type: "staff",
        active: true,
        subcontractor_id: fx.defaultSubId,
        external_id: "TEST-EMP-1",
      })
      .select("id")
      .single();
    const { data: taskCode } = await adminClient
      .from("task_codes")
      .insert({ tenant_id: fx.tenantId, code: "INST", name: "Install" })
      .select("id")
      .single();

    const { data: ts } = await adminClient
      .from("timesheets")
      .insert({
        tenant_id: fx.tenantId,
        kind: "staff",
        status: "approved",
        submitter_user_id: fx.adminUserId,
        employee_id: employee!.id,
        project_id: project!.id,
        subcontractor_id: fx.defaultSubId,
        period_start: "2024-06-03",
        period_end: "2024-06-09",
      })
      .select("id")
      .single();
    await adminClient.from("timesheet_lines").insert([
      {
        timesheet_id: ts!.id,
        tenant_id: fx.tenantId,
        date: "2024-06-03",
        task_code_id: taskCode!.id,
        employee_id: employee!.id,
        hours_st: 8,
        hours_ot: 2,
      },
    ]);

    const res = await callEdgeFunction(
      "export-labor",
      { format: "csv", from: "2024-06-01", to: "2024-06-30" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    const lines = res.text.trim().split("\n");
    assertEquals(lines.length, 3); // header + ST row + OT row
    const combined = lines[1] + "\n" + lines[2];
    // Tolerant matches — hours may render as "8" or "8.00" depending on numeric
    // parsing; the important thing is the split into two rows with the right labels.
    assertEquals(combined.includes("Test Worker"), true, `expected 'Test Worker' in:\n${combined}`);
    assertEquals(combined.includes("TEST-001"), true, `expected 'TEST-001' in:\n${combined}`);
    assertEquals(/,ST,8(\.0+)?,/.test(combined), true, `expected ST row with 8 hours in:\n${combined}`);
    assertEquals(/,OT,2(\.0+)?,/.test(combined), true, `expected OT row with 2 hours in:\n${combined}`);
    assertEquals(res.headers.get("x-invenio-rows"), "2");

    // Cleanup (withFixture won't know about downstream rows — FK RESTRICT
    // would block cleanupTenant without this.)
    await adminClient.from("timesheet_lines").delete().eq("timesheet_id", ts!.id);
    await adminClient.from("timesheets").delete().eq("id", ts!.id);
    await adminClient.from("employees").delete().eq("id", employee!.id);
    await adminClient.from("projects").delete().eq("id", project!.id);
    await adminClient.from("task_codes").delete().eq("id", taskCode!.id);
  });
});
