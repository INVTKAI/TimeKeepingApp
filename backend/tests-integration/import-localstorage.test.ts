import {
  adminClient,
  assertEquals,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

// Minimal localStorage-shaped payload mirroring the legacy DB.exportAll().
function minimalBlob(tag: string) {
  return {
    default_subcontractor: { name: "Invenio", short_code: `INV2-${tag}` },
    users: [
      {
        id: "U-001",
        username: `imp-${tag}-admin`,
        email: `imp-${tag}-admin@test.invenio.local`,
        role: "admin",
        empId: null,
      },
      {
        id: "U-002",
        username: `imp-${tag}-staff`,
        email: `imp-${tag}-staff@test.invenio.local`,
        role: "staff",
        empId: "E-001",
      },
    ],
    employees: [
      {
        id: "E-001",
        firstName: "Jane",
        lastName: "Engineer",
        type: "staff",
        craft: "Engineer",
        active: true,
      },
      {
        id: "E-002",
        firstName: "John",
        lastName: "Welder",
        type: "field",
        craft: "Welder",
        active: true,
      },
    ],
    projects: [
      { id: "P-001", number: "2024-001", name: "Refinery TA", active: true },
    ],
    areas: [{ id: "A-001", code: "UNIT-1", name: "Unit 1", projectId: "P-001" }],
    taskCodes: [{ id: "T-001", code: "INST", name: "Install" }],
    cwps: [{ id: "CW-001", code: "CWP-001", description: "Pipe rack" }],
    fcos: [{ id: "F-001", code: "FCO-101", description: "Change order" }],
  };
}

Deno.test("import-localstorage — unauth 401", async () => {
  const res = await callEdgeFunction("import-localstorage", {});
  assertEquals(res.status, 401);
});

Deno.test("import-localstorage — empty body creates default sub + zero counts", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction<{
      counts: Record<string, Record<string, number>>;
    }>("import-localstorage", {}, { jwt: fx.adminJwt });
    assertEquals(res.status, 200);
    assertEquals(res.json?.counts?.employees, { created: 0, updated: 0, skipped: 0 });
    assertEquals(res.json?.counts?.projects, { created: 0, updated: 0, skipped: 0 });
    // The default-sub upsert creates 'Invenio' / 'INV' in an empty tenant.
    const { data: sub } = await adminClient
      .from("subcontractors")
      .select("short_code")
      .eq("tenant_id", fx.tenantId)
      .eq("short_code", "INV");
    assertEquals(sub?.length, 1);
  });
});

Deno.test("import-localstorage — minimal blob loads entities + users", async () => {
  await withFixture(async (fx) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const blob = minimalBlob(tag);

    const res = await callEdgeFunction<{
      counts: Record<string, Record<string, number>>;
      skipped_users: unknown[];
    }>("import-localstorage", blob, { jwt: fx.adminJwt });
    assertEquals(res.status, 200);
    assertEquals(res.json?.counts?.employees, { created: 2, updated: 0, skipped: 0 });
    assertEquals(res.json?.counts?.projects, { created: 1, updated: 0, skipped: 0 });
    assertEquals(res.json?.counts?.areas, { created: 1, updated: 0, skipped: 0 });
    assertEquals(res.json?.counts?.task_codes, { created: 1, updated: 0, skipped: 0 });
    assertEquals(res.json?.counts?.cwps, { created: 1, updated: 0, skipped: 0 });
    assertEquals(res.json?.counts?.fcos, { created: 1, updated: 0, skipped: 0 });
    assertEquals(res.json?.counts?.users?.created, 2);

    // Verify role remap: staff → submitter + employee_id set.
    const { data: staffUser } = await adminClient
      .from("users")
      .select("role, employee_id, status")
      .eq("tenant_id", fx.tenantId)
      .eq("username", `imp-${tag}-staff`)
      .single();
    assertEquals(staffUser?.role, "submitter");
    assertEquals(staffUser?.status, "pending");
    assertEquals(typeof staffUser?.employee_id, "string");

    // employees.external_id round-trips.
    const { data: e1 } = await adminClient
      .from("employees")
      .select("first_name, last_name, external_id, subcontractor_id")
      .eq("tenant_id", fx.tenantId)
      .eq("external_id", "E-001")
      .single();
    assertEquals(e1?.first_name, "Jane");
    assertEquals(e1?.last_name, "Engineer");

    // Cleanup downstream rows so withFixture's tenant delete doesn't hit FK RESTRICT.
    const { data: importedUsers } = await adminClient
      .from("users")
      .select("id")
      .eq("tenant_id", fx.tenantId);
    for (const u of importedUsers ?? []) {
      if (u.id !== fx.adminUserId) {
        await adminClient.from("users").delete().eq("id", u.id);
        await adminClient.auth.admin.deleteUser(u.id).catch(() => {});
      }
    }
    await adminClient.from("employees").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("areas").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("projects").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("task_codes").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("cwps").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("fcos").delete().eq("tenant_id", fx.tenantId);
  });
});

Deno.test("import-localstorage — re-run is idempotent (counts flip to updated)", async () => {
  await withFixture(async (fx) => {
    const tag = Math.random().toString(36).slice(2, 8);
    const blob = minimalBlob(tag);

    const first = await callEdgeFunction<{
      counts: Record<string, Record<string, number>>;
    }>("import-localstorage", blob, { jwt: fx.adminJwt });
    assertEquals(first.status, 200);
    assertEquals(first.json?.counts?.employees?.created, 2);

    const second = await callEdgeFunction<{
      counts: Record<string, Record<string, number>>;
    }>("import-localstorage", blob, { jwt: fx.adminJwt });
    assertEquals(second.status, 200);
    // Second run UPDATEs the rows — created should be 0.
    assertEquals(second.json?.counts?.employees, {
      created: 0,
      updated: 2,
      skipped: 0,
    });
    assertEquals(second.json?.counts?.projects, {
      created: 0,
      updated: 1,
      skipped: 0,
    });
    // Users: re-run finds existing rows by (tenant, email) and logs as updated.
    assertEquals(second.json?.counts?.users?.created, 0);
    assertEquals(second.json?.counts?.users?.updated, 2);

    // Cleanup (same pattern as above).
    const { data: importedUsers } = await adminClient
      .from("users")
      .select("id")
      .eq("tenant_id", fx.tenantId);
    for (const u of importedUsers ?? []) {
      if (u.id !== fx.adminUserId) {
        await adminClient.from("users").delete().eq("id", u.id);
        await adminClient.auth.admin.deleteUser(u.id).catch(() => {});
      }
    }
    await adminClient.from("employees").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("areas").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("projects").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("task_codes").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("cwps").delete().eq("tenant_id", fx.tenantId);
    await adminClient.from("fcos").delete().eq("tenant_id", fx.tenantId);
  });
});
