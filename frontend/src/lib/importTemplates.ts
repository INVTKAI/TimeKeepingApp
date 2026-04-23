// Import templates — generate CSVs/JSON with real tenant IDs baked in so an
// admin can round-trip the file: download → edit in Excel → upload → see
// results. Each Phase B file_type has its own header row + 2-3 example rows
// wired to actual project/sub/user/employee records from the tenant.
//
// Columns match what backend/supabase/functions/import-spreadsheet/index.ts
// expects. `project` means projects.external_id, `sub` means
// subcontractors.short_code, `user` means users.username.

import type {
  Employee,
  Project,
  Subcontractor,
} from "./referenceData";

export type PhaseBType =
  | "subs"
  | "employee_subs"
  | "project_subs"
  | "project_flows"
  | "silo_roles"
  | "project_roles"
  | "timekeeper_assignments";

// Direct-CRUD templates — simple column shapes matching the `public.<table>`
// rows an admin maintains via the UI. These aren't wired to a specific
// importer endpoint; the expected workflow is:
//   1. Admin downloads a template and sends it to a non-technical user.
//   2. User fills it in Excel, returns the .csv.
//   3. Admin either pastes rows into the UI (small batch) or hands it off
//      for a one-off SQL bulk-insert (large batch).
// Column names match the PG table exactly so a simple \copy or SQL loader
// works without translation.
export type DirectTemplate =
  | "employees"
  | "projects"
  | "areas"
  | "task_codes"
  | "cwps"
  | "fcos";

export type TenantContext = {
  projects: Project[];
  subs: Subcontractor[];
  employees: Employee[];
  users: { id: string; username: string }[];
  flows: { id: string; name: string }[];
  adminUsername: string | null;
};

type TemplateSpec = {
  headers: string[];
  buildRows: (ctx: TenantContext) => string[][];
  notes?: string[]; // lines prepended as `# <note>` comments
};

const today = () => new Date().toISOString().slice(0, 10);

const SPECS: Record<PhaseBType, TemplateSpec> = {
  subs: {
    headers: ["name", "short_code", "active"],
    buildRows: () => [
      ["Acme Mechanical", "ACME", "true"],
      ["Buckeye Electric", "BUCK", "true"],
      ["Delta Scaffolding", "DELTA", "true"],
    ],
    notes: [
      "`active` is optional — defaults to true. Accepts true/false.",
      "Matches existing subs by `short_code` (updates name on match).",
    ],
  },

  employee_subs: {
    headers: ["external_id", "sub", "started_at"],
    buildRows: (ctx) => {
      const rows: string[][] = [];
      const emps = ctx.employees.slice(0, 3);
      const fallbackSub = ctx.subs[0]?.short_code ?? "ACME";
      for (const e of emps) {
        const sub = ctx.subs.find((s) => s.id !== e.subcontractor_id);
        rows.push([
          e.external_id ?? `EMP-${e.id.slice(0, 4)}`,
          sub?.short_code ?? fallbackSub,
          `${today()}T00:00:00Z`,
        ]);
      }
      if (rows.length === 0) {
        rows.push(["E001", fallbackSub, `${today()}T00:00:00Z`]);
      }
      return rows;
    },
    notes: [
      "Use each employee's `external_id` (not their first/last name).",
      "`sub` is the subcontractor's `short_code`.",
      "`started_at` is an ISO timestamp. Close-off of the prior span happens automatically.",
      "Re-runs skip rows where the employee is already on the target sub (idempotent).",
    ],
  },

  project_subs: {
    headers: ["project", "sub", "start_date", "end_date"],
    buildRows: (ctx) => {
      const rows: string[][] = [];
      for (const p of ctx.projects.slice(0, 2)) {
        for (const s of ctx.subs.slice(0, 2)) {
          rows.push([
            p.number,
            s.short_code,
            "2026-01-01",
            "", // open span
          ]);
        }
      }
      if (rows.length === 0) {
        rows.push(["P-1001", "INV", "2026-01-01", ""]);
      }
      return rows;
    },
    notes: [
      "`project` is projects.external_id (equal to projects.number for seed-loaded projects).",
      "`sub` is the subcontractor's `short_code`.",
      "`end_date` is optional — leave blank for an open span.",
    ],
  },

  project_flows: {
    headers: ["project", "flow", "effective_from", "effective_to"],
    buildRows: (ctx) => {
      const rows: string[][] = [];
      const flow1 = ctx.flows[0]?.name ?? "Standard approval";
      const flow2 = ctx.flows[1]?.name ?? flow1;
      for (const p of ctx.projects.slice(0, 2)) {
        rows.push([p.number, flow1, "2026-01-01", ""]);
      }
      if (ctx.projects[2]) {
        rows.push([ctx.projects[2].number, flow2, "2026-01-01", ""]);
      }
      if (rows.length === 0) {
        rows.push(["P-1001", "Standard approval", "2026-01-01", ""]);
      }
      return rows;
    },
    notes: [
      "`flow` is the approval_flows.name (must match exactly, case-sensitive).",
      "Re-assigning a project: insert a new row with a later effective_from.",
    ],
  },

  silo_roles: {
    headers: ["project", "sub", "role_label", "user", "effective_from", "effective_to"],
    buildRows: (ctx) => {
      const rows: string[][] = [];
      const username = ctx.adminUsername ?? ctx.users[0]?.username ?? "admin";
      const roles = ["foreman", "timekeeper_admin"];
      let ri = 0;
      outer: for (const p of ctx.projects.slice(0, 2)) {
        for (const s of ctx.subs.slice(0, 2)) {
          rows.push([p.number, s.short_code, roles[ri % 2], username, "2026-01-01", ""]);
          ri++;
          if (rows.length >= 3) break outer;
        }
      }
      if (rows.length === 0) {
        rows.push(["P-1001", "INV", "foreman", username, "2026-01-01", ""]);
      }
      return rows;
    },
    notes: [
      "Canonical `role_label` values on silos: foreman, timekeeper_admin.",
      "`user` is the public.users.username.",
      "`project` is projects.external_id; `sub` is subcontractors.short_code.",
    ],
  },

  project_roles: {
    headers: ["project", "role_label", "user", "effective_from", "effective_to"],
    buildRows: (ctx) => {
      const rows: string[][] = [];
      const username = ctx.adminUsername ?? ctx.users[0]?.username ?? "admin";
      const roles = ["pm", "prime_rep", "accounting"];
      let ri = 0;
      for (const p of ctx.projects.slice(0, 3)) {
        rows.push([p.number, roles[ri % 3], username, "2026-01-01", ""]);
        ri++;
      }
      if (rows.length === 0) {
        rows.push(["P-1001", "pm", username, "2026-01-01", ""]);
      }
      return rows;
    },
    notes: [
      "Canonical `role_label` values on projects: pm, prime_rep, accounting.",
    ],
  },

  timekeeper_assignments: {
    headers: ["user", "project", "sub"],
    buildRows: (ctx) => {
      const rows: string[][] = [];
      const username = ctx.adminUsername ?? ctx.users[0]?.username ?? "admin";
      for (const p of ctx.projects.slice(0, 2)) {
        for (const s of ctx.subs.slice(0, 2)) {
          rows.push([username, p.number, s.short_code]);
          if (rows.length >= 3) break;
        }
        if (rows.length >= 3) break;
      }
      if (rows.length === 0) {
        rows.push([username, "P-1001", "INV"]);
      }
      return rows;
    },
    notes: [
      "Grants proxy-submit access to `user` on the (project, sub) silo.",
      "Idempotent: existing rows are skipped silently.",
    ],
  },
};

const DIRECT_SPECS: Record<DirectTemplate, TemplateSpec> = {
  employees: {
    headers: [
      "external_id",
      "first_name",
      "last_name",
      "type",
      "craft",
      "sub_short_code",
      "active",
    ],
    buildRows: (ctx) => {
      const s0 = ctx.subs[0]?.short_code ?? "INV";
      const s1 = ctx.subs[1]?.short_code ?? s0;
      return [
        ["E101", "Jordan", "Lee", "field", "Welder", s0, "true"],
        ["E102", "Sam", "Carter", "field", "Pipefitter", s1, "true"],
        ["E103", "Avery", "Nguyen", "staff", "Project Engineer", s0, "true"],
      ];
    },
    notes: [
      "`external_id` must be unique per tenant — use the customer's payroll ID if possible.",
      "`type` is `field` or `staff` (lowercase).",
      "`sub_short_code` must match an existing subcontractors.short_code.",
      "`active` is optional (defaults to true).",
    ],
  },

  projects: {
    headers: ["number", "external_id", "name", "active"],
    buildRows: () => [
      ["P-2001", "P-2001", "Offshore Platform Retrofit", "true"],
      ["P-2002", "P-2002", "New Building Superstructure", "true"],
      ["P-2003", "P-2003", "Compressor Station Upgrade", "true"],
    ],
    notes: [
      "`number` is the display identifier; `external_id` is the stable lookup key used by Phase B imports.",
      "Setting them equal is a safe default — deviate only if you already have an external identifier system.",
      "`active` is optional (defaults to true).",
    ],
  },

  areas: {
    headers: ["project_number", "code", "name"],
    buildRows: (ctx) => {
      const p = ctx.projects[0]?.number ?? "P-1001";
      return [
        [p, "A-01", "North Yard"],
        [p, "A-02", "South Yard"],
        [p, "A-03", "Equipment Laydown"],
      ];
    },
    notes: [
      "`project_number` must match an existing projects.number in this tenant.",
      "`code` + `name` are the area identifiers — both free-form text.",
    ],
  },

  task_codes: {
    headers: ["code", "name"],
    buildRows: () => [
      ["CARP", "Carpentry"],
      ["WELD", "Welding"],
      ["ELEC", "Electrical"],
      ["LAB", "General Labor"],
    ],
    notes: [
      "`code` should be short + unique per tenant (e.g. CARP, WELD).",
      "`name` is the human-readable label.",
    ],
  },

  cwps: {
    headers: ["code", "description"],
    buildRows: () => [
      ["CWP-100", "Foundations + Civil"],
      ["CWP-200", "Structural Steel"],
      ["CWP-300", "Mechanical Installation"],
      ["CWP-400", "Electrical + Instrumentation"],
    ],
    notes: [
      "CWP = Construction Work Package. One row per package.",
    ],
  },

  fcos: {
    headers: ["code", "description"],
    buildRows: () => [
      ["FCO-001", "Additional foundation pour"],
      ["FCO-002", "Scope growth — pipe spool rework"],
      ["FCO-003", "Weather-related demobilization"],
    ],
    notes: [
      "FCO = Field Change Order. One row per change-order tracking code.",
    ],
  },
};

export function buildDirectCsv(
  table: DirectTemplate,
  ctx: TenantContext,
): string {
  const spec = DIRECT_SPECS[table];
  const rows = spec.buildRows(ctx);
  const lines: string[] = [];
  if (spec.notes) {
    for (const n of spec.notes) lines.push(`# ${n}`);
    lines.push(`# ---`);
  }
  lines.push(spec.headers.map(csvCell).join(","));
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

// Combined walkthrough of every Phase B file_type in one human-readable
// file. Each section is a complete CSV (header + example rows) preceded by
// a markdown heading, so the admin can review the whole set and split into
// individual files for upload. Intended as the Phase B analog to the
// Phase A single-file example.
const PHASE_B_ORDER: Array<{ type: PhaseBType; label: string }> = [
  { type: "subs", label: "Subcontractors" },
  { type: "employee_subs", label: "Employee → Sub mapping" },
  { type: "project_subs", label: "Project → Sub engagements" },
  { type: "project_flows", label: "Project → Flow assignments" },
  { type: "silo_roles", label: "Silo role assignments" },
  { type: "project_roles", label: "Project role assignments" },
  { type: "timekeeper_assignments", label: "Submitter assignments" },
];

export function buildPhaseBBundle(ctx: TenantContext): string {
  const lines: string[] = [];
  lines.push("# Phase B Import Bundle");
  lines.push("");
  lines.push(
    "Each section below is a complete CSV for one `file_type` in the Phase B importer.",
  );
  lines.push(
    "Copy each section (from the `# ---` separator before it down to the separator after) into its own `.csv` file,",
  );
  lines.push(
    "then upload via /admin/imports → Phase B with the matching file type.",
  );
  lines.push("");
  lines.push(
    "Comment lines (`#` prefix) are stripped by the importer, so files are safe to upload as-is.",
  );
  lines.push("");
  for (const entry of PHASE_B_ORDER) {
    lines.push("");
    lines.push(`# ==============================================================`);
    lines.push(`# ${entry.label}  (file_type: ${entry.type})`);
    lines.push(`# ==============================================================`);
    lines.push(buildPhaseBCsv(entry.type, ctx).trimEnd());
  }
  lines.push("");
  return lines.join("\n");
}

export function buildPhaseBCsv(
  fileType: PhaseBType,
  ctx: TenantContext,
): string {
  const spec = SPECS[fileType];
  const rows = spec.buildRows(ctx);
  const lines: string[] = [];
  if (spec.notes) {
    for (const n of spec.notes) lines.push(`# ${n}`);
    lines.push(`# ---`);
  }
  lines.push(spec.headers.map(csvCell).join(","));
  for (const r of rows) lines.push(r.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

// ----- Phase A sample JSON ---------------------------------------------------

// Minimal but representative example of the legacy DB.exportAll() shape.
// Real customer blobs include far more rows — this is enough to show the
// required fields and let an admin test the pipe end-to-end.
export function buildPhaseAExampleJson(ctx: TenantContext): string {
  const firstSub = ctx.subs[0];
  const body = {
    default_subcontractor: {
      name: firstSub?.name ?? "Invenio Construction",
      short_code: firstSub?.short_code ?? "INV",
    },
    import_timesheets: false,
    users: [
      {
        id: "u-legacy-001",
        username: "jdoe",
        email: "jdoe@example.com",
        role: "submitter",
        name: "J. Doe",
      },
    ],
    employees: [
      {
        id: "E-LEGACY-001",
        firstName: "Jane",
        lastName: "Doe",
        type: "field",
        craft: "Welder",
        active: true,
      },
      {
        id: "E-LEGACY-002",
        firstName: "John",
        lastName: "Smith",
        type: "staff",
        craft: "Superintendent",
        active: true,
      },
    ],
    projects: [
      { id: "P-LEGACY-001", name: "Legacy Project Alpha", number: "P-9001", active: true },
    ],
    areas: [
      { id: "A-001", code: "A-01", name: "North Yard", projectId: "P-LEGACY-001" },
    ],
    taskCodes: [
      { id: "TC-001", code: "CARP", name: "Carpentry" },
      { id: "TC-002", code: "WELD", name: "Welding" },
    ],
    cwps: [
      { id: "C-001", code: "CWP-100", description: "Foundations" },
    ],
    fcos: [
      { id: "F-001", code: "FCO-001", description: "Additional foundation pour" },
    ],
  };
  return JSON.stringify(body, null, 2);
}

// ----- Utilities -------------------------------------------------------------

function csvCell(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
