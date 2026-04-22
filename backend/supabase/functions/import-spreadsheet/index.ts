// import-spreadsheet — spec §9 Phase B.
//
// Loads Invenio-curated, customer-provided spreadsheets into the tenant-scoped
// configuration tables that Phase A cannot populate. Dispatches on file_type;
// each spreadsheet type has its own row shape and target table(s).
//
// Caller is responsible for parsing XLSX → JSON; this function accepts JSON
// rows only. Keeping parse client-side means we don't carry an XLSX dep into
// the Edge runtime and the function signature stays narrow.
//
// Row references (employees, projects, subs, users) use the legacy external_id
// strings (for entities imported in Phase A) or the new codes/usernames (for
// entities created natively in Phase B). Dangling references are collected
// and returned with per-row error detail — the whole file fails as a unit only
// if dangling refs prevent ANY row from loading. Partially-applied loads are
// safe to re-run; idempotency keys are designed so repeat upload is no-op on
// unchanged rows.
//
// Supported file_types (spec §9 Phase B table):
//   subs                   → public.subcontractors
//   employee_subs          → public.employees.subcontractor_id + employee_subcontractor_history
//   project_subs           → public.project_subcontractors
//   project_flows          → public.project_flow_assignments
//   silo_roles             → public.silo_role_assignments
//   project_roles          → public.project_role_assignments
//   timekeeper_assignments → public.submitter_assignments

import "@supabase/functions-js/edge-runtime.d.ts";
import { withAdminContext, type AdminContext } from "../_shared/with-admin-context.ts";
import { Problems, problemResponse } from "../_shared/problem.ts";
import { parseJsonBody, writeAudit } from "../_shared/admin-helpers.ts";

type RowOutcome = { ok: true } | { ok: false; reason: string };
type LoadResult = {
  file_type: string;
  processed: number;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ index: number; reason: string; row: Record<string, unknown> }>;
};

const SUPPORTED = new Set([
  "subs",
  "employee_subs",
  "project_subs",
  "project_flows",
  "silo_roles",
  "project_roles",
  "timekeeper_assignments",
]);

// ----- Lookup helpers -----

async function lookupSubByShortCode(
  ctx: AdminContext,
  shortCode: string,
): Promise<string | null> {
  const { data } = await ctx.adminClient
    .from("subcontractors")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("short_code", shortCode)
    .maybeSingle();
  return data?.id ?? null;
}

async function lookupEmployeeByExternalId(
  ctx: AdminContext,
  externalId: string,
): Promise<string | null> {
  const { data } = await ctx.adminClient
    .from("employees")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("external_id", externalId)
    .maybeSingle();
  return data?.id ?? null;
}

async function lookupProjectByExternalId(
  ctx: AdminContext,
  externalId: string,
): Promise<string | null> {
  const { data } = await ctx.adminClient
    .from("projects")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("external_id", externalId)
    .maybeSingle();
  return data?.id ?? null;
}

async function lookupFlowByName(ctx: AdminContext, name: string): Promise<string | null> {
  const { data } = await ctx.adminClient
    .from("approval_flows")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("name", name)
    .maybeSingle();
  return data?.id ?? null;
}

async function lookupUserByUsername(
  ctx: AdminContext,
  username: string,
): Promise<string | null> {
  const { data } = await ctx.adminClient
    .from("users")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .eq("username", username)
    .maybeSingle();
  return data?.id ?? null;
}

// ----- Loaders per file_type -----

async function loadSubs(
  ctx: AdminContext,
  rows: Record<string, unknown>[],
): Promise<LoadResult> {
  const out: LoadResult = {
    file_type: "subs",
    processed: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = typeof row.name === "string" ? row.name : null;
    const shortCode = typeof row.short_code === "string" ? row.short_code : null;
    const active = typeof row.active === "boolean" ? row.active : true;
    if (!name || !shortCode) {
      out.errors.push({ index: i, reason: "name and short_code required", row });
      continue;
    }
    const existingId = await lookupSubByShortCode(ctx, shortCode);
    if (existingId) {
      const { error } = await ctx.adminClient
        .from("subcontractors")
        .update({ name, active })
        .eq("id", existingId);
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.updated += 1;
    } else {
      const { error } = await ctx.adminClient
        .from("subcontractors")
        .insert({ tenant_id: ctx.tenantId, name, short_code: shortCode, active });
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.created += 1;
    }
  }
  return out;
}

async function loadEmployeeSubs(
  ctx: AdminContext,
  rows: Record<string, unknown>[],
): Promise<LoadResult> {
  const out: LoadResult = {
    file_type: "employee_subs",
    processed: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const externalId = typeof row.external_id === "string" ? row.external_id : null;
    const subShortCode = typeof row.sub === "string" ? row.sub : null;
    const startedAt =
      typeof row.started_at === "string"
        ? row.started_at
        : new Date().toISOString();
    if (!externalId || !subShortCode) {
      out.errors.push({ index: i, reason: "external_id and sub required", row });
      continue;
    }
    const employeeId = await lookupEmployeeByExternalId(ctx, externalId);
    if (!employeeId) {
      out.errors.push({ index: i, reason: `employee external_id ${externalId} not found`, row });
      continue;
    }
    const subId = await lookupSubByShortCode(ctx, subShortCode);
    if (!subId) {
      out.errors.push({ index: i, reason: `subcontractor ${subShortCode} not found`, row });
      continue;
    }

    const { data: currentRow } = await ctx.adminClient
      .from("employees")
      .select("subcontractor_id")
      .eq("id", employeeId)
      .single();

    if (currentRow && currentRow.subcontractor_id === subId) {
      // Already on the target sub — skip (idempotent re-run).
      out.skipped += 1;
      continue;
    }

    // Close the most recent open history span (if any), insert new open span,
    // and update employees.subcontractor_id.
    const { error: closeErr } = await ctx.adminClient
      .from("employee_subcontractor_history")
      .update({ ended_at: startedAt })
      .eq("tenant_id", ctx.tenantId)
      .eq("employee_id", employeeId)
      .is("ended_at", null);
    if (closeErr) {
      out.errors.push({ index: i, reason: `close prior span: ${closeErr.message}`, row });
      continue;
    }

    const { error: histErr } = await ctx.adminClient
      .from("employee_subcontractor_history")
      .insert({
        tenant_id: ctx.tenantId,
        employee_id: employeeId,
        subcontractor_id: subId,
        started_at: startedAt,
      });
    if (histErr) {
      out.errors.push({ index: i, reason: `history insert: ${histErr.message}`, row });
      continue;
    }

    const { error: empErr } = await ctx.adminClient
      .from("employees")
      .update({ subcontractor_id: subId })
      .eq("id", employeeId);
    if (empErr) {
      out.errors.push({ index: i, reason: `employees update: ${empErr.message}`, row });
      continue;
    }
    out.updated += 1;
  }
  return out;
}

async function loadProjectSubs(
  ctx: AdminContext,
  rows: Record<string, unknown>[],
): Promise<LoadResult> {
  const out: LoadResult = {
    file_type: "project_subs",
    processed: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const projectExt = typeof row.project === "string" ? row.project : null;
    const subShort = typeof row.sub === "string" ? row.sub : null;
    const startDate = typeof row.start_date === "string" ? row.start_date : null;
    const endDate = typeof row.end_date === "string" ? row.end_date : null;
    if (!projectExt || !subShort || !startDate) {
      out.errors.push({ index: i, reason: "project, sub, start_date required", row });
      continue;
    }
    const projectId = await lookupProjectByExternalId(ctx, projectExt);
    if (!projectId) {
      out.errors.push({ index: i, reason: `project ${projectExt} not found`, row });
      continue;
    }
    const subId = await lookupSubByShortCode(ctx, subShort);
    if (!subId) {
      out.errors.push({ index: i, reason: `subcontractor ${subShort} not found`, row });
      continue;
    }
    const { data: existing } = await ctx.adminClient
      .from("project_subcontractors")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("project_id", projectId)
      .eq("subcontractor_id", subId)
      .eq("start_date", startDate)
      .maybeSingle();
    if (existing) {
      const { error } = await ctx.adminClient
        .from("project_subcontractors")
        .update({ end_date: endDate })
        .eq("id", existing.id);
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.updated += 1;
    } else {
      const { error } = await ctx.adminClient.from("project_subcontractors").insert({
        tenant_id: ctx.tenantId,
        project_id: projectId,
        subcontractor_id: subId,
        start_date: startDate,
        end_date: endDate,
      });
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.created += 1;
    }
  }
  return out;
}

async function loadProjectFlows(
  ctx: AdminContext,
  rows: Record<string, unknown>[],
): Promise<LoadResult> {
  const out: LoadResult = {
    file_type: "project_flows",
    processed: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const projectExt = typeof row.project === "string" ? row.project : null;
    const flowName = typeof row.flow === "string" ? row.flow : null;
    const effectiveFrom =
      typeof row.effective_from === "string"
        ? row.effective_from
        : new Date().toISOString().slice(0, 10);
    const effectiveTo = typeof row.effective_to === "string" ? row.effective_to : null;
    if (!projectExt || !flowName) {
      out.errors.push({ index: i, reason: "project and flow required", row });
      continue;
    }
    const projectId = await lookupProjectByExternalId(ctx, projectExt);
    if (!projectId) {
      out.errors.push({ index: i, reason: `project ${projectExt} not found`, row });
      continue;
    }
    const flowId = await lookupFlowByName(ctx, flowName);
    if (!flowId) {
      out.errors.push({ index: i, reason: `flow ${flowName} not found`, row });
      continue;
    }
    const { data: existing } = await ctx.adminClient
      .from("project_flow_assignments")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("project_id", projectId)
      .eq("effective_from", effectiveFrom)
      .maybeSingle();
    if (existing) {
      const { error } = await ctx.adminClient
        .from("project_flow_assignments")
        .update({ flow_id: flowId, effective_to: effectiveTo })
        .eq("id", existing.id);
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.updated += 1;
    } else {
      const { error } = await ctx.adminClient.from("project_flow_assignments").insert({
        tenant_id: ctx.tenantId,
        project_id: projectId,
        flow_id: flowId,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
      });
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.created += 1;
    }
  }
  return out;
}

async function loadSiloRoles(
  ctx: AdminContext,
  rows: Record<string, unknown>[],
): Promise<LoadResult> {
  const out: LoadResult = {
    file_type: "silo_roles",
    processed: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const projectExt = typeof row.project === "string" ? row.project : null;
    const subShort = typeof row.sub === "string" ? row.sub : null;
    const roleLabel = typeof row.role_label === "string" ? row.role_label : null;
    const username = typeof row.user === "string" ? row.user : null;
    const effectiveFrom =
      typeof row.effective_from === "string"
        ? row.effective_from
        : new Date().toISOString().slice(0, 10);
    const effectiveTo = typeof row.effective_to === "string" ? row.effective_to : null;
    if (!projectExt || !subShort || !roleLabel || !username) {
      out.errors.push({ index: i, reason: "project, sub, role_label, user required", row });
      continue;
    }
    const projectId = await lookupProjectByExternalId(ctx, projectExt);
    if (!projectId) {
      out.errors.push({ index: i, reason: `project ${projectExt} not found`, row });
      continue;
    }
    const subId = await lookupSubByShortCode(ctx, subShort);
    if (!subId) {
      out.errors.push({ index: i, reason: `sub ${subShort} not found`, row });
      continue;
    }
    const userId = await lookupUserByUsername(ctx, username);
    if (!userId) {
      out.errors.push({ index: i, reason: `user ${username} not found`, row });
      continue;
    }
    const { data: existing } = await ctx.adminClient
      .from("silo_role_assignments")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("project_id", projectId)
      .eq("subcontractor_id", subId)
      .eq("role_label", roleLabel)
      .eq("user_id", userId)
      .eq("effective_from", effectiveFrom)
      .maybeSingle();
    if (existing) {
      const { error } = await ctx.adminClient
        .from("silo_role_assignments")
        .update({ effective_to: effectiveTo })
        .eq("id", existing.id);
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.updated += 1;
    } else {
      const { error } = await ctx.adminClient.from("silo_role_assignments").insert({
        tenant_id: ctx.tenantId,
        project_id: projectId,
        subcontractor_id: subId,
        role_label: roleLabel,
        user_id: userId,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
      });
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.created += 1;
    }
  }
  return out;
}

async function loadProjectRoles(
  ctx: AdminContext,
  rows: Record<string, unknown>[],
): Promise<LoadResult> {
  const out: LoadResult = {
    file_type: "project_roles",
    processed: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const projectExt = typeof row.project === "string" ? row.project : null;
    const roleLabel = typeof row.role_label === "string" ? row.role_label : null;
    const username = typeof row.user === "string" ? row.user : null;
    const effectiveFrom =
      typeof row.effective_from === "string"
        ? row.effective_from
        : new Date().toISOString().slice(0, 10);
    const effectiveTo = typeof row.effective_to === "string" ? row.effective_to : null;
    if (!projectExt || !roleLabel || !username) {
      out.errors.push({ index: i, reason: "project, role_label, user required", row });
      continue;
    }
    const projectId = await lookupProjectByExternalId(ctx, projectExt);
    if (!projectId) {
      out.errors.push({ index: i, reason: `project ${projectExt} not found`, row });
      continue;
    }
    const userId = await lookupUserByUsername(ctx, username);
    if (!userId) {
      out.errors.push({ index: i, reason: `user ${username} not found`, row });
      continue;
    }
    const { data: existing } = await ctx.adminClient
      .from("project_role_assignments")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("project_id", projectId)
      .eq("role_label", roleLabel)
      .eq("user_id", userId)
      .eq("effective_from", effectiveFrom)
      .maybeSingle();
    if (existing) {
      const { error } = await ctx.adminClient
        .from("project_role_assignments")
        .update({ effective_to: effectiveTo })
        .eq("id", existing.id);
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.updated += 1;
    } else {
      const { error } = await ctx.adminClient.from("project_role_assignments").insert({
        tenant_id: ctx.tenantId,
        project_id: projectId,
        role_label: roleLabel,
        user_id: userId,
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
      });
      if (error) {
        out.errors.push({ index: i, reason: error.message, row });
        continue;
      }
      out.created += 1;
    }
  }
  return out;
}

async function loadTimekeeperAssignments(
  ctx: AdminContext,
  rows: Record<string, unknown>[],
): Promise<LoadResult> {
  const out: LoadResult = {
    file_type: "timekeeper_assignments",
    processed: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const username = typeof row.user === "string" ? row.user : null;
    const projectExt = typeof row.project === "string" ? row.project : null;
    const subShort = typeof row.sub === "string" ? row.sub : null;
    if (!username || !projectExt || !subShort) {
      out.errors.push({ index: i, reason: "user, project, sub required", row });
      continue;
    }
    const userId = await lookupUserByUsername(ctx, username);
    if (!userId) {
      out.errors.push({ index: i, reason: `user ${username} not found`, row });
      continue;
    }
    const projectId = await lookupProjectByExternalId(ctx, projectExt);
    if (!projectId) {
      out.errors.push({ index: i, reason: `project ${projectExt} not found`, row });
      continue;
    }
    const subId = await lookupSubByShortCode(ctx, subShort);
    if (!subId) {
      out.errors.push({ index: i, reason: `sub ${subShort} not found`, row });
      continue;
    }
    const { data: existing } = await ctx.adminClient
      .from("submitter_assignments")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("user_id", userId)
      .eq("project_id", projectId)
      .eq("subcontractor_id", subId)
      .maybeSingle();
    if (existing) {
      out.skipped += 1;
      continue;
    }
    const { error } = await ctx.adminClient.from("submitter_assignments").insert({
      tenant_id: ctx.tenantId,
      user_id: userId,
      project_id: projectId,
      subcontractor_id: subId,
    });
    if (error) {
      out.errors.push({ index: i, reason: error.message, row });
      continue;
    }
    out.created += 1;
  }
  return out;
}

// ----- Handler -----

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const fileType = typeof body.file_type === "string" ? body.file_type : null;
    if (!fileType || !SUPPORTED.has(fileType)) {
      return problemResponse(
        Problems.ValidationError(
          `file_type must be one of: ${Array.from(SUPPORTED).join(", ")}`,
        ),
      );
    }
    const rows = Array.isArray(body.rows) ? (body.rows as Record<string, unknown>[]) : null;
    if (!rows) {
      return problemResponse(Problems.ValidationError("rows must be an array"));
    }
    if (rows.length > 5000) {
      return problemResponse(
        Problems.ValidationError("rows limit is 5000 per request; split large files"),
      );
    }

    let result: LoadResult;
    switch (fileType) {
      case "subs":
        result = await loadSubs(ctx, rows);
        break;
      case "employee_subs":
        result = await loadEmployeeSubs(ctx, rows);
        break;
      case "project_subs":
        result = await loadProjectSubs(ctx, rows);
        break;
      case "project_flows":
        result = await loadProjectFlows(ctx, rows);
        break;
      case "silo_roles":
        result = await loadSiloRoles(ctx, rows);
        break;
      case "project_roles":
        result = await loadProjectRoles(ctx, rows);
        break;
      case "timekeeper_assignments":
        result = await loadTimekeeperAssignments(ctx, rows);
        break;
      default:
        return problemResponse(Problems.ValidationError(`unhandled file_type ${fileType}`));
    }

    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "tenant.import_spreadsheet",
      "tenant",
      ctx.tenantId,
      {
        file_type: fileType,
        processed: result.processed,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        error_count: result.errors.length,
      },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
);
