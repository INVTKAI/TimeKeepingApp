// import-localstorage — spec §9 Phase A.
//
// One-time (idempotent) import of the customer's legacy localStorage blob into
// a freshly provisioned Supabase tenant. Accepts the shape produced by the
// legacy app's DB.exportAll() plus an augmentation that injects per-user email
// (the legacy app had no email field — it must be supplied at import time by
// the operator running the migration).
//
// Idempotency: external_id UNIQUE(tenant_id, external_id) on employees /
// projects / areas / task_codes / cwps / fcos lets re-runs UPDATE-on-match.
// Users matched by (tenant_id, email) at public.users level; existing users
// are left untouched.
//
// Dependency order (all within the wrapping tenant scope):
//   subcontractor → employees → projects → areas → task_codes → cwps → fcos →
//   users → (optional) historical timesheets as draft
//
// Historical timesheets (spec §9 "Historical timesheet handling") default to
// skipped (option a — "leave as draft" reframed: simply not imported). Set
// `import_timesheets: true` to land them as draft with submitter_user_id =
// invoking admin + subcontractor_id = default sub (for operator's onward curation).
//
// This function is service-role heavy (every insert bypasses RLS) — covered
// by the §11.6 allow-list entry added alongside.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withAdminContext, type AdminContext } from "../_shared/with-admin-context.ts";
import { Problems, problemResponse } from "../_shared/problem.ts";
import { writeAudit } from "../_shared/admin-helpers.ts";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB — customer blobs can be large.

type Counts = { created: number; updated: number; skipped: number };
const zero = (): Counts => ({ created: 0, updated: 0, skipped: 0 });

// ----- Input-shape typing (all fields optional-tolerant; we validate per-row). -----

type LegacyUser = {
  id?: string;
  username?: string;
  email?: string;
  role?: string;
  name?: string;
  empId?: string | null;
};
type LegacyEmployee = {
  id?: string;
  firstName?: string;
  lastName?: string;
  type?: string;
  craft?: string | null;
  active?: boolean;
};
type LegacyProject = { id?: string; name?: string; number?: string; active?: boolean };
type LegacyArea = { id?: string; code?: string; name?: string; projectId?: string };
type LegacyCoded = { id?: string; code?: string; name?: string; description?: string };
type LegacyStaffTs = {
  id?: string;
  empId?: string;
  weekStarting?: string;
  status?: string;
  lines?: Array<{
    projectId?: string;
    area?: string;
    taskCode?: string;
    fco?: string;
    comment?: string;
    hours?: Record<string, { st?: number; ot?: number }>;
  }>;
};
type LegacyFieldTs = {
  id?: string;
  timesheetNumber?: string;
  projectId?: string;
  areaCode?: string;
  taskCode?: string;
  fco?: string;
  foreman?: string;
  day?: string;
  date?: string;
  status?: string;
  crewEntries?: Array<{ empId?: string; records?: Array<{ st?: number; ot?: number }> }>;
};

type ImportBody = {
  default_subcontractor?: { name?: string; short_code?: string };
  import_timesheets?: boolean;
  users?: LegacyUser[];
  employees?: LegacyEmployee[];
  projects?: LegacyProject[];
  areas?: LegacyArea[];
  taskCodes?: LegacyCoded[];
  task_codes?: LegacyCoded[];
  cwps?: LegacyCoded[];
  fcos?: LegacyCoded[];
  staffTimesheets?: LegacyStaffTs[];
  fieldTimesheets?: LegacyFieldTs[];
};

// ----- Large-body parser (the shared helper's 16KB cap is too small here). -----

async function parseLargeJsonBody(
  req: Request,
): Promise<{ ok: true; body: ImportBody } | { ok: false; response: Response }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      response: problemResponse(
        Problems.ValidationError("Request Content-Type must be application/json"),
      ),
    };
  }
  const raw = await req.text();
  if (raw.length > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      response: problemResponse(
        Problems.ValidationError(`Request body exceeds ${MAX_IMPORT_BYTES} bytes`),
      ),
    };
  }
  try {
    const parsed = raw.length === 0 ? {} : JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        response: problemResponse(
          Problems.ValidationError("Request body must be a JSON object"),
        ),
      };
    }
    return { ok: true, body: parsed as ImportBody };
  } catch {
    return {
      ok: false,
      response: problemResponse(Problems.ValidationError("Request body is not valid JSON")),
    };
  }
}

// ----- Section importers. Each returns Counts + an id-map (legacy-id → uuid). -----

async function ensureDefaultSubcontractor(
  ctx: AdminContext,
  name: string,
  shortCode: string,
): Promise<{ ok: true; id: string } | { ok: false; response: Response }> {
  const { data: existing, error: existingErr } = await ctx.adminClient
    .from("subcontractors")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("short_code", shortCode)
    .maybeSingle();
  if (existingErr) {
    return { ok: false, response: problemResponse(Problems.Internal(existingErr.message)) };
  }
  if (existing) return { ok: true, id: existing.id };

  const { data: inserted, error: insErr } = await ctx.adminClient
    .from("subcontractors")
    .insert({ tenant_id: ctx.tenantId, name, short_code: shortCode })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return {
      ok: false,
      response: problemResponse(
        Problems.Internal(`subcontractor insert failed: ${insErr?.message ?? "unknown"}`),
      ),
    };
  }
  return { ok: true, id: inserted.id };
}

async function importEmployees(
  ctx: AdminContext,
  input: LegacyEmployee[] | undefined,
  defaultSubId: string,
): Promise<
  | { ok: true; counts: Counts; idMap: Record<string, string> }
  | { ok: false; response: Response }
> {
  const rows = input ?? [];
  const counts = zero();
  const idMap: Record<string, string> = {};

  for (const row of rows) {
    if (!row.id || !row.firstName || !row.lastName || !row.type) {
      counts.skipped += 1;
      continue;
    }
    if (row.type !== "field" && row.type !== "staff") {
      counts.skipped += 1;
      continue;
    }
    const { data: existing, error: exErr } = await ctx.adminClient
      .from("employees")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("external_id", row.id)
      .maybeSingle();
    if (exErr) {
      return { ok: false, response: problemResponse(Problems.Internal(exErr.message)) };
    }
    if (existing) {
      const { error: upErr } = await ctx.adminClient
        .from("employees")
        .update({
          first_name: row.firstName,
          last_name: row.lastName,
          type: row.type,
          craft: row.craft ?? null,
          active: row.active ?? true,
        })
        .eq("id", existing.id);
      if (upErr) {
        return { ok: false, response: problemResponse(Problems.Internal(upErr.message)) };
      }
      idMap[row.id] = existing.id;
      counts.updated += 1;
    } else {
      const { data: ins, error: insErr } = await ctx.adminClient
        .from("employees")
        .insert({
          tenant_id: ctx.tenantId,
          external_id: row.id,
          first_name: row.firstName,
          last_name: row.lastName,
          type: row.type,
          craft: row.craft ?? null,
          active: row.active ?? true,
          subcontractor_id: defaultSubId,
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        return {
          ok: false,
          response: problemResponse(
            Problems.Internal(`employees insert (${row.id}): ${insErr?.message ?? "unknown"}`),
          ),
        };
      }
      idMap[row.id] = ins.id;
      counts.created += 1;
    }
  }
  return { ok: true, counts, idMap };
}

async function importProjects(
  ctx: AdminContext,
  input: LegacyProject[] | undefined,
): Promise<
  | { ok: true; counts: Counts; idMap: Record<string, string> }
  | { ok: false; response: Response }
> {
  const rows = input ?? [];
  const counts = zero();
  const idMap: Record<string, string> = {};

  for (const row of rows) {
    if (!row.id || !row.name || !row.number) {
      counts.skipped += 1;
      continue;
    }
    const { data: existing, error: exErr } = await ctx.adminClient
      .from("projects")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("external_id", row.id)
      .maybeSingle();
    if (exErr) {
      return { ok: false, response: problemResponse(Problems.Internal(exErr.message)) };
    }
    if (existing) {
      const { error: upErr } = await ctx.adminClient
        .from("projects")
        .update({ name: row.name, number: row.number, active: row.active ?? true })
        .eq("id", existing.id);
      if (upErr) {
        return { ok: false, response: problemResponse(Problems.Internal(upErr.message)) };
      }
      idMap[row.id] = existing.id;
      counts.updated += 1;
    } else {
      const { data: ins, error: insErr } = await ctx.adminClient
        .from("projects")
        .insert({
          tenant_id: ctx.tenantId,
          external_id: row.id,
          name: row.name,
          number: row.number,
          active: row.active ?? true,
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        return {
          ok: false,
          response: problemResponse(
            Problems.Internal(`projects insert (${row.id}): ${insErr?.message ?? "unknown"}`),
          ),
        };
      }
      idMap[row.id] = ins.id;
      counts.created += 1;
    }
  }
  return { ok: true, counts, idMap };
}

async function importAreas(
  ctx: AdminContext,
  input: LegacyArea[] | undefined,
  projectIdMap: Record<string, string>,
): Promise<
  | { ok: true; counts: Counts; idMapByCode: Record<string, string> }
  | { ok: false; response: Response }
> {
  // idMapByCode keyed by `${legacyProjectId}:${code}` — legacy areas use (projectId, code)
  // as their identity (no area-level external_id in the legacy blob).
  const rows = input ?? [];
  const counts = zero();
  const idMapByCode: Record<string, string> = {};

  for (const row of rows) {
    if (!row.id || !row.code || !row.name || !row.projectId) {
      counts.skipped += 1;
      continue;
    }
    const projectUuid = projectIdMap[row.projectId];
    if (!projectUuid) {
      counts.skipped += 1;
      continue;
    }
    const { data: existing, error: exErr } = await ctx.adminClient
      .from("areas")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("external_id", row.id)
      .maybeSingle();
    if (exErr) {
      return { ok: false, response: problemResponse(Problems.Internal(exErr.message)) };
    }
    if (existing) {
      const { error: upErr } = await ctx.adminClient
        .from("areas")
        .update({ name: row.name, code: row.code, project_id: projectUuid })
        .eq("id", existing.id);
      if (upErr) {
        return { ok: false, response: problemResponse(Problems.Internal(upErr.message)) };
      }
      idMapByCode[`${row.projectId}:${row.code}`] = existing.id;
      counts.updated += 1;
    } else {
      const { data: ins, error: insErr } = await ctx.adminClient
        .from("areas")
        .insert({
          tenant_id: ctx.tenantId,
          external_id: row.id,
          project_id: projectUuid,
          code: row.code,
          name: row.name,
        })
        .select("id")
        .single();
      if (insErr || !ins) {
        return {
          ok: false,
          response: problemResponse(
            Problems.Internal(`areas insert (${row.id}): ${insErr?.message ?? "unknown"}`),
          ),
        };
      }
      idMapByCode[`${row.projectId}:${row.code}`] = ins.id;
      counts.created += 1;
    }
  }
  return { ok: true, counts, idMapByCode };
}

async function importCodedReference(
  ctx: AdminContext,
  table: "task_codes" | "cwps" | "fcos",
  input: LegacyCoded[] | undefined,
  nameField: "name" | "description",
): Promise<
  | { ok: true; counts: Counts; idMapByCode: Record<string, string> }
  | { ok: false; response: Response }
> {
  const rows = input ?? [];
  const counts = zero();
  const idMapByCode: Record<string, string> = {};

  for (const row of rows) {
    if (!row.id || !row.code || !row[nameField]) {
      counts.skipped += 1;
      continue;
    }
    const nameValue = row[nameField] as string;
    const { data: existing, error: exErr } = await ctx.adminClient
      .from(table)
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("external_id", row.id)
      .maybeSingle();
    if (exErr) {
      return { ok: false, response: problemResponse(Problems.Internal(exErr.message)) };
    }
    if (existing) {
      const update: Record<string, unknown> = { code: row.code };
      update[nameField] = nameValue;
      const { error: upErr } = await ctx.adminClient
        .from(table)
        .update(update)
        .eq("id", existing.id);
      if (upErr) {
        return { ok: false, response: problemResponse(Problems.Internal(upErr.message)) };
      }
      idMapByCode[row.code] = existing.id;
      counts.updated += 1;
    } else {
      const insert: Record<string, unknown> = {
        tenant_id: ctx.tenantId,
        external_id: row.id,
        code: row.code,
      };
      insert[nameField] = nameValue;
      const { data: ins, error: insErr } = await ctx.adminClient
        .from(table)
        .insert(insert)
        .select("id")
        .single();
      if (insErr || !ins) {
        return {
          ok: false,
          response: problemResponse(
            Problems.Internal(`${table} insert (${row.id}): ${insErr?.message ?? "unknown"}`),
          ),
        };
      }
      idMapByCode[row.code] = ins.id;
      counts.created += 1;
    }
  }
  return { ok: true, counts, idMapByCode };
}

async function importUsers(
  ctx: AdminContext,
  input: LegacyUser[] | undefined,
  employeeIdMap: Record<string, string>,
): Promise<
  | { ok: true; counts: Counts; skipped: Array<{ id?: string; username?: string; reason: string }> }
  | { ok: false; response: Response }
> {
  const rows = input ?? [];
  const counts = zero();
  const skipped: Array<{ id?: string; username?: string; reason: string }> = [];

  for (const row of rows) {
    if (!row.username || !row.email || !row.role) {
      counts.skipped += 1;
      skipped.push({
        id: row.id,
        username: row.username,
        reason: "missing required field (username / email / role)",
      });
      continue;
    }
    const appRole =
      row.role === "admin"
        ? "admin"
        : row.role === "staff" || row.role === "timekeeper"
        ? "submitter"
        : null;
    if (!appRole) {
      counts.skipped += 1;
      skipped.push({ id: row.id, username: row.username, reason: `unknown legacy role: ${row.role}` });
      continue;
    }
    const employeeId = row.empId ? employeeIdMap[row.empId] ?? null : null;

    // Pre-flight: does a public.users row already exist in this tenant
    // (by email or username)? If so, no-op (idempotent re-run).
    const { data: existingPublic, error: exErr } = await ctx.adminClient
      .from("users")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .or(`email.eq.${row.email},username.eq.${row.username}`)
      .maybeSingle();
    if (exErr) {
      return { ok: false, response: problemResponse(Problems.Internal(exErr.message)) };
    }
    if (existingPublic) {
      counts.updated += 1; // treated as no-op-idempotent
      continue;
    }

    // Create auth.users — no password, no confirmation email. Metadata carries
    // tenant_id + app_role + username so the custom access-token hook can pick
    // them up at first sign-in.
    const { data: created, error: createErr } = await ctx.adminClient.auth.admin.createUser({
      email: row.email,
      email_confirm: false,
      user_metadata: {
        tenant_id: ctx.tenantId,
        app_role: appRole,
        username: row.username,
        legacy_id: row.id ?? null,
      },
    });
    if (createErr || !created?.user) {
      // Most likely: email collides with an auth.users row in another tenant
      // (auth.users is tenant-agnostic). Record + skip.
      counts.skipped += 1;
      skipped.push({
        id: row.id,
        username: row.username,
        reason: `auth.admin.createUser: ${createErr?.message ?? "no user returned"}`,
      });
      continue;
    }
    const authUserId = created.user.id;

    const { error: pubErr } = await ctx.adminClient.from("users").insert({
      id: authUserId,
      tenant_id: ctx.tenantId,
      username: row.username,
      email: row.email,
      role: appRole,
      employee_id: employeeId,
      status: "pending",
      created_by: ctx.userId,
    });
    if (pubErr) {
      // Roll back the auth.users row so the pair stays consistent — without
      // this we'd leave a ghost auth.users with no public.users, and the
      // §4.8 pairing trigger would block that user's first sign-in anyway.
      await ctx.adminClient.auth.admin.deleteUser(authUserId);
      return {
        ok: false,
        response: problemResponse(
          Problems.Internal(`public.users insert (${row.username}): ${pubErr.message}`),
        ),
      };
    }
    counts.created += 1;
  }
  return { ok: true, counts, skipped };
}

async function importHistoricalTimesheets(
  ctx: AdminContext,
  staffInput: LegacyStaffTs[] | undefined,
  fieldInput: LegacyFieldTs[] | undefined,
  defaultSubId: string,
  employeeIdMap: Record<string, string>,
  projectIdMap: Record<string, string>,
  areaIdMapByCode: Record<string, string>,
  taskCodeIdByCode: Record<string, string>,
  fcoIdByCode: Record<string, string>,
): Promise<{ ok: true; counts: Counts } | { ok: false; response: Response }> {
  const counts = zero();

  // --- Staff timesheets: one per row; one line per line × day with nonzero hours. ---
  for (const ts of staffInput ?? []) {
    if (!ts.empId || !ts.weekStarting || !Array.isArray(ts.lines)) {
      counts.skipped += 1;
      continue;
    }
    const employeeUuid = employeeIdMap[ts.empId];
    if (!employeeUuid) {
      counts.skipped += 1;
      continue;
    }

    // Pick the project from the first line (all lines in a legacy staff ts share
    // the week but can differ per project; we record the timesheet project as the
    // modal one — simplest proxy for the legacy-to-normalized mapping).
    const firstLine = ts.lines[0];
    if (!firstLine?.projectId) {
      counts.skipped += 1;
      continue;
    }
    const projectUuid = projectIdMap[firstLine.projectId];
    if (!projectUuid) {
      counts.skipped += 1;
      continue;
    }

    const periodStart = ts.weekStarting;
    const periodEnd = addDays(periodStart, 6);

    const { data: tsIns, error: tsErr } = await ctx.adminClient
      .from("timesheets")
      .insert({
        tenant_id: ctx.tenantId,
        kind: "staff",
        status: "draft",
        submitter_user_id: ctx.userId,
        employee_id: employeeUuid,
        project_id: projectUuid,
        subcontractor_id: defaultSubId,
        period_start: periodStart,
        period_end: periodEnd,
      })
      .select("id")
      .single();
    if (tsErr || !tsIns) {
      return {
        ok: false,
        response: problemResponse(
          Problems.Internal(`staff timesheet insert (${ts.id}): ${tsErr?.message ?? "unknown"}`),
        ),
      };
    }

    const dayOffsets: Record<string, number> = {
      mon: 0,
      tue: 1,
      wed: 2,
      thu: 3,
      fri: 4,
      sat: 5,
      sun: 6,
    };
    const linesToInsert: Record<string, unknown>[] = [];
    for (const line of ts.lines) {
      if (!line.hours) continue;
      const lineProjectUuid = line.projectId ? projectIdMap[line.projectId] ?? null : null;
      if (line.projectId && !lineProjectUuid) continue; // dangling ref; skip the line
      const areaId =
        line.area && line.projectId ? areaIdMapByCode[`${line.projectId}:${line.area}`] ?? null : null;
      const taskId = line.taskCode ? taskCodeIdByCode[line.taskCode] ?? null : null;
      const fcoId = line.fco ? fcoIdByCode[line.fco] ?? null : null;
      for (const [dayKey, offset] of Object.entries(dayOffsets)) {
        const h = line.hours[dayKey];
        if (!h) continue;
        const st = Number(h.st ?? 0);
        const ot = Number(h.ot ?? 0);
        if (st === 0 && ot === 0) continue;
        linesToInsert.push({
          timesheet_id: tsIns.id,
          tenant_id: ctx.tenantId,
          date: addDays(periodStart, offset),
          area_id: areaId,
          task_code_id: taskId,
          fco_id: fcoId,
          employee_id: employeeUuid,
          hours_st: st,
          hours_ot: ot,
          comment: line.comment ?? null,
        });
      }
    }
    if (linesToInsert.length > 0) {
      const { error: linesErr } = await ctx.adminClient.from("timesheet_lines").insert(linesToInsert);
      if (linesErr) {
        return {
          ok: false,
          response: problemResponse(
            Problems.Internal(`staff timesheet_lines insert: ${linesErr.message}`),
          ),
        };
      }
    }
    counts.created += 1;
  }

  // --- Field timesheets: single-day; each crewEntry record becomes one line. ---
  for (const ts of fieldInput ?? []) {
    if (!ts.projectId || !ts.date || !Array.isArray(ts.crewEntries)) {
      counts.skipped += 1;
      continue;
    }
    const projectUuid = projectIdMap[ts.projectId];
    if (!projectUuid) {
      counts.skipped += 1;
      continue;
    }

    const { data: tsIns, error: tsErr } = await ctx.adminClient
      .from("timesheets")
      .insert({
        tenant_id: ctx.tenantId,
        kind: "field",
        status: "draft",
        submitter_user_id: ctx.userId,
        employee_id: null,
        project_id: projectUuid,
        subcontractor_id: defaultSubId,
        period_start: ts.date,
        period_end: ts.date,
      })
      .select("id")
      .single();
    if (tsErr || !tsIns) {
      return {
        ok: false,
        response: problemResponse(
          Problems.Internal(`field timesheet insert (${ts.id}): ${tsErr?.message ?? "unknown"}`),
        ),
      };
    }

    const areaId = ts.areaCode ? areaIdMapByCode[`${ts.projectId}:${ts.areaCode}`] ?? null : null;
    const taskId = ts.taskCode ? taskCodeIdByCode[ts.taskCode] ?? null : null;
    const fcoId = ts.fco ? fcoIdByCode[ts.fco] ?? null : null;

    const linesToInsert: Record<string, unknown>[] = [];
    for (const crew of ts.crewEntries) {
      if (!crew.empId || !Array.isArray(crew.records)) continue;
      const employeeUuid = employeeIdMap[crew.empId];
      if (!employeeUuid) continue;
      // Each record lands as a single line at ts.date (legacy semantics: record
      // is an activity bucket for that day, not a separate day).
      let st = 0;
      let ot = 0;
      for (const rec of crew.records) {
        st += Number(rec.st ?? 0);
        ot += Number(rec.ot ?? 0);
      }
      if (st === 0 && ot === 0) continue;
      linesToInsert.push({
        timesheet_id: tsIns.id,
        tenant_id: ctx.tenantId,
        date: ts.date,
        area_id: areaId,
        task_code_id: taskId,
        fco_id: fcoId,
        employee_id: employeeUuid,
        hours_st: st,
        hours_ot: ot,
        comment: null,
      });
    }
    if (linesToInsert.length > 0) {
      const { error: linesErr } = await ctx.adminClient.from("timesheet_lines").insert(linesToInsert);
      if (linesErr) {
        return {
          ok: false,
          response: problemResponse(
            Problems.Internal(`field timesheet_lines insert: ${linesErr.message}`),
          ),
        };
      }
    }
    counts.created += 1;
  }

  return { ok: true, counts };
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ----- Handler -----

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseLargeJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const defaultSubName = body.default_subcontractor?.name ?? "Invenio";
    const defaultSubShortCode = body.default_subcontractor?.short_code ?? "INV";
    const importTimesheets = body.import_timesheets === true;

    const subResult = await ensureDefaultSubcontractor(ctx, defaultSubName, defaultSubShortCode);
    if (!subResult.ok) return subResult.response;
    const defaultSubId = subResult.id;

    const empResult = await importEmployees(ctx, body.employees, defaultSubId);
    if (!empResult.ok) return empResult.response;

    const projResult = await importProjects(ctx, body.projects);
    if (!projResult.ok) return projResult.response;

    const areaResult = await importAreas(ctx, body.areas, projResult.idMap);
    if (!areaResult.ok) return areaResult.response;

    const tcInput = body.taskCodes ?? body.task_codes;
    const tcResult = await importCodedReference(ctx, "task_codes", tcInput, "name");
    if (!tcResult.ok) return tcResult.response;

    const cwpResult = await importCodedReference(ctx, "cwps", body.cwps, "description");
    if (!cwpResult.ok) return cwpResult.response;

    const fcoResult = await importCodedReference(ctx, "fcos", body.fcos, "description");
    if (!fcoResult.ok) return fcoResult.response;

    const userResult = await importUsers(ctx, body.users, empResult.idMap);
    if (!userResult.ok) return userResult.response;

    let tsCounts: Counts = zero();
    if (importTimesheets) {
      const tsResult = await importHistoricalTimesheets(
        ctx,
        body.staffTimesheets,
        body.fieldTimesheets,
        defaultSubId,
        empResult.idMap,
        projResult.idMap,
        areaResult.idMapByCode,
        tcResult.idMapByCode,
        fcoResult.idMapByCode,
      );
      if (!tsResult.ok) return tsResult.response;
      tsCounts = tsResult.counts;
    }

    const countsOut = {
      default_subcontractor_id: defaultSubId,
      employees: empResult.counts,
      projects: projResult.counts,
      areas: areaResult.counts,
      task_codes: tcResult.counts,
      cwps: cwpResult.counts,
      fcos: fcoResult.counts,
      users: userResult.counts,
      timesheets: tsCounts,
    };

    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "tenant.import_localstorage",
      "tenant",
      ctx.tenantId,
      countsOut,
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(
      JSON.stringify({
        ok: true,
        tenant_id: ctx.tenantId,
        counts: countsOut,
        skipped_users: userResult.skipped,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
);
