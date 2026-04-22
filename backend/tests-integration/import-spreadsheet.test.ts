import {
  adminClient,
  assertEquals,
  callEdgeFunction,
  withFixture,
} from "./_helpers.ts";

Deno.test("import-spreadsheet — unknown file_type 400", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "import-spreadsheet",
      { file_type: "mystery", rows: [] },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 400);
    assertEquals(res.json?.type, "https://api.invenio.example/errors/validation-error");
  });
});

Deno.test("import-spreadsheet — missing rows array 400", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction(
      "import-spreadsheet",
      { file_type: "subs" },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("import-spreadsheet — subs happy path inserts new sub", async () => {
  await withFixture(async (fx) => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const res = await callEdgeFunction<{
      file_type: string;
      created: number;
      errors: unknown[];
    }>(
      "import-spreadsheet",
      {
        file_type: "subs",
        rows: [{ name: `Kindred-${suffix}`, short_code: `KND-${suffix}` }],
      },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.file_type, "subs");
    assertEquals(res.json?.created, 1);
    assertEquals(res.json?.errors?.length, 0);

    const { data } = await adminClient
      .from("subcontractors")
      .select("id, name")
      .eq("tenant_id", fx.tenantId)
      .eq("short_code", `KND-${suffix}`)
      .single();
    assertEquals(data?.name, `Kindred-${suffix}`);
  });
});

Deno.test("import-spreadsheet — subs re-run updates + skips duplicate insert", async () => {
  await withFixture(async (fx) => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const row = { name: `Acme-${suffix}`, short_code: `AC-${suffix}` };

    const first = await callEdgeFunction<{ created: number; updated: number }>(
      "import-spreadsheet",
      { file_type: "subs", rows: [row] },
      { jwt: fx.adminJwt },
    );
    assertEquals(first.json?.created, 1);

    const second = await callEdgeFunction<{ created: number; updated: number }>(
      "import-spreadsheet",
      { file_type: "subs", rows: [{ ...row, name: `Acme-Renamed-${suffix}` }] },
      { jwt: fx.adminJwt },
    );
    assertEquals(second.status, 200);
    assertEquals(second.json?.created, 0);
    assertEquals(second.json?.updated, 1);

    const { data } = await adminClient
      .from("subcontractors")
      .select("name")
      .eq("tenant_id", fx.tenantId)
      .eq("short_code", `AC-${suffix}`)
      .single();
    assertEquals(data?.name, `Acme-Renamed-${suffix}`);
  });
});

Deno.test("import-spreadsheet — project_subs rejects unknown project", async () => {
  await withFixture(async (fx) => {
    const res = await callEdgeFunction<{ errors: Array<{ reason: string }> }>(
      "import-spreadsheet",
      {
        file_type: "project_subs",
        rows: [{ project: "NO-SUCH-PROJECT", sub: "NO-SUCH-SUB", start_date: "2024-01-01" }],
      },
      { jwt: fx.adminJwt },
    );
    assertEquals(res.status, 200);
    assertEquals(res.json?.errors?.length, 1);
    assertEquals(res.json?.errors?.[0]?.reason?.includes("project") ?? false, true);
  });
});
