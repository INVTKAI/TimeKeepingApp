// export-labor — spec §8 / §9.
//
// Tenant-scoped labor export. Returns CSV or XLSX.
//
// Body:
//   {
//     "format": "csv" | "xlsx",      // required
//     "from": "YYYY-MM-DD",           // required; inclusive
//     "to":   "YYYY-MM-DD",           // required; inclusive
//     "project_ids":      ["uuid"]?,  // optional — filters by timesheets.project_id
//     "subcontractor_ids":["uuid"]?,  // optional — filters by timesheets.subcontractor_id
//     "statuses": ["approved","submitted",...]?  // optional — defaults to ALL
//   }
//
// Output columns mirror the legacy export_labor.py reference:
//   Source, Employee, Emp ID, Craft, Date, Day, Project #, Project Name,
//   Area, Task Code, CWP, FCO/PCR, Type (ST|OT), Hours, Comment
//
// Each `timesheet_lines` row expands to TWO output rows when both ST and OT
// are non-zero (one per hour type). Zero-hour rows are skipped in both.
//
// The XLSX path adds a second "Summary by Project" sheet with ST / OT / Total
// aggregates per project, matching the legacy shape.
//
// Source filter: only non-'open'/non-'recalled'/non-'rejected' statuses land in
// payroll by default. Callers who want everything pass `statuses: [...]`
// explicitly (e.g. to include 'rejected' for audit).

import "@supabase/functions-js/edge-runtime.d.ts";
import * as XLSX from "npm:xlsx@0.18.5";
import { withAdminContext, type AdminContext } from "../_shared/with-admin-context.ts";
import { Problems, problemResponse } from "../_shared/problem.ts";
import { parseJsonBody, writeAudit } from "../_shared/admin-helpers.ts";

// --- Types -------------------------------------------------------------------

type ExportRow = {
  Source: string;
  Employee: string;
  "Emp ID": string;
  Craft: string;
  Date: string;
  Day: string;
  "Project #": string;
  "Project Name": string;
  Area: string;
  "Task Code": string;
  CWP: string;
  "FCO/PCR": string;
  Type: "ST" | "OT";
  Hours: number;
  Comment: string;
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DEFAULT_STATUSES = ["submitted", "in_review", "approved"];

// --- Query -------------------------------------------------------------------

async function fetchLaborRows(
  ctx: AdminContext,
  from: string,
  to: string,
  projectIds: string[] | null,
  subIds: string[] | null,
  statuses: string[],
): Promise<{ ok: true; rows: ExportRow[] } | { ok: false; response: Response }> {
  // Supabase-js PostgREST embed syntax: one-level-deep joins on FK columns.
  // We filter `timesheet_lines` by date + tenant, then embed the parent
  // timesheet (for kind + status + subcontractor) and the dimension rows.
  const query = ctx.adminClient
    .from("timesheet_lines")
    .select(
      `
        date,
        hours_st,
        hours_ot,
        comment,
        employees!inner(first_name, last_name, external_id, craft),
        areas(code, name),
        task_codes(code, name),
        cwps(code),
        fcos(code),
        timesheet:timesheets!inner(
          kind,
          status,
          project_id,
          subcontractor_id,
          projects!inner(number, name)
        )
      `,
    )
    .eq("tenant_id", ctx.tenantId)
    .gte("date", from)
    .lte("date", to);

  const { data, error } = await query;
  if (error) {
    return {
      ok: false,
      response: problemResponse(
        Problems.Internal(`export-labor query: ${error.message}`),
      ),
    };
  }

  // Post-filter on embedded fields — PostgREST can't push-down filters on
  // embed paths as deep as we need without a view. Acceptable because the
  // primary date window already does the bulk of the narrowing.
  const rows: ExportRow[] = [];
  for (const line of data ?? []) {
    const ts = (line as Record<string, unknown>).timesheet as {
      kind: "staff" | "field";
      status: string;
      project_id: string;
      subcontractor_id: string;
      projects: { number: string; name: string };
    } | null;
    if (!ts) continue;
    if (!statuses.includes(ts.status)) continue;
    if (projectIds && !projectIds.includes(ts.project_id)) continue;
    if (subIds && !subIds.includes(ts.subcontractor_id)) continue;

    const emp = (line as Record<string, unknown>).employees as {
      first_name: string;
      last_name: string;
      external_id: string | null;
      craft: string | null;
    };
    const area = (line as Record<string, unknown>).areas as {
      code: string;
      name: string;
    } | null;
    const taskCode = (line as Record<string, unknown>).task_codes as {
      code: string;
      name: string;
    } | null;
    const cwp = (line as Record<string, unknown>).cwps as { code: string } | null;
    const fco = (line as Record<string, unknown>).fcos as { code: string } | null;
    const dateStr = (line as Record<string, unknown>).date as string;
    const hoursSt = Number((line as Record<string, unknown>).hours_st ?? 0);
    const hoursOt = Number((line as Record<string, unknown>).hours_ot ?? 0);
    const comment = ((line as Record<string, unknown>).comment as string | null) ?? "";

    const base: Omit<ExportRow, "Type" | "Hours"> = {
      Source: ts.kind,
      Employee: `${emp.first_name} ${emp.last_name}`,
      "Emp ID": emp.external_id ?? "",
      Craft: emp.craft ?? "",
      Date: dateStr,
      Day: DAY_NAMES[new Date(dateStr + "T00:00:00Z").getUTCDay()],
      "Project #": ts.projects.number,
      "Project Name": ts.projects.name,
      Area: area?.code ?? "",
      "Task Code": taskCode?.code ?? "",
      CWP: cwp?.code ?? "",
      "FCO/PCR": fco?.code ?? "",
      Comment: comment,
    };

    if (hoursSt > 0) rows.push({ ...base, Type: "ST", Hours: hoursSt });
    if (hoursOt > 0) rows.push({ ...base, Type: "OT", Hours: hoursOt });
  }

  // Stable sort: date, then employee, then type (ST before OT).
  rows.sort((a, b) => {
    if (a.Date !== b.Date) return a.Date < b.Date ? -1 : 1;
    if (a.Employee !== b.Employee) return a.Employee < b.Employee ? -1 : 1;
    if (a.Type !== b.Type) return a.Type === "ST" ? -1 : 1;
    return 0;
  });

  return { ok: true, rows };
}

// --- Format helpers ----------------------------------------------------------

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Column order is fixed — don't derive from Object.keys because row
// construction spreads `base` fields first and appends Type/Hours, which would
// put Comment between FCO/PCR and Type in the CSV.
const CSV_HEADERS: (keyof ExportRow)[] = [
  "Source",
  "Employee",
  "Emp ID",
  "Craft",
  "Date",
  "Day",
  "Project #",
  "Project Name",
  "Area",
  "Task Code",
  "CWP",
  "FCO/PCR",
  "Type",
  "Hours",
  "Comment",
];

function rowsToCsv(rows: ExportRow[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(CSV_HEADERS.map((h) => csvEscape(r[h])).join(","));
  }
  return lines.join("\n") + "\n";
}

function rowsToXlsx(rows: ExportRow[]): Uint8Array {
  const wb = XLSX.utils.book_new();

  // --- Detail sheet ---
  const headers: (keyof ExportRow)[] = [
    "Source",
    "Employee",
    "Emp ID",
    "Craft",
    "Date",
    "Day",
    "Project #",
    "Project Name",
    "Area",
    "Task Code",
    "CWP",
    "FCO/PCR",
    "Type",
    "Hours",
    "Comment",
  ];
  const detailData: unknown[][] = [headers as unknown as unknown[]];
  for (const r of rows) detailData.push(headers.map((h) => r[h]));
  // Trailing totals row (SUM formula over the Hours column).
  const totalRow = new Array(headers.length).fill("");
  totalRow[0] = "TOTALS";
  if (rows.length > 0) {
    totalRow[13] = {
      t: "n",
      f: `SUM(N2:N${rows.length + 1})`,
      z: "#,##0.00;(#,##0.00);\"-\"",
    };
  }
  detailData.push(totalRow);
  const detailSheet = XLSX.utils.aoa_to_sheet(detailData);
  // Column widths modeled on export_labor.py.
  detailSheet["!cols"] = [
    { wch: 8 }, { wch: 22 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 10 },
    { wch: 10 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 10 },
    { wch: 5 }, { wch: 8 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, detailSheet, "Labor Detail");

  // --- Summary by Project ---
  const byProject = new Map<
    string,
    { name: string; st: number; ot: number }
  >();
  for (const r of rows) {
    const key = r["Project #"];
    const entry = byProject.get(key) ?? { name: r["Project Name"], st: 0, ot: 0 };
    if (r.Type === "ST") entry.st += r.Hours;
    else entry.ot += r.Hours;
    byProject.set(key, entry);
  }
  const summaryHeaders = ["Project #", "Project Name", "ST Hours", "OT Hours", "Total Hours"];
  const summaryData: unknown[][] = [summaryHeaders];
  const sortedProjects = [...byProject.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [num, entry] of sortedProjects) {
    summaryData.push([num, entry.name, entry.st, entry.ot, entry.st + entry.ot]);
  }
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
  summarySheet["!cols"] = [
    { wch: 10 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(wb, summarySheet, "Summary by Project");

  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new Uint8Array(out);
}

// --- Handler -----------------------------------------------------------------

Deno.serve(
  withAdminContext(async (req, ctx) => {
    const parsed = await parseJsonBody(req);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;

    const format = typeof body.format === "string" ? body.format : null;
    const from = typeof body.from === "string" ? body.from : null;
    const to = typeof body.to === "string" ? body.to : null;
    if (!format || (format !== "csv" && format !== "xlsx")) {
      return problemResponse(
        Problems.ValidationError("format must be 'csv' or 'xlsx'"),
      );
    }
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return problemResponse(
        Problems.ValidationError("from must be YYYY-MM-DD"),
      );
    }
    if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return problemResponse(Problems.ValidationError("to must be YYYY-MM-DD"));
    }
    if (from > to) {
      return problemResponse(
        Problems.ValidationError("from must be <= to"),
      );
    }

    const projectIds =
      Array.isArray(body.project_ids) && body.project_ids.length > 0
        ? (body.project_ids.filter((v) => typeof v === "string") as string[])
        : null;
    const subIds =
      Array.isArray(body.subcontractor_ids) && body.subcontractor_ids.length > 0
        ? (body.subcontractor_ids.filter((v) => typeof v === "string") as string[])
        : null;
    const statuses =
      Array.isArray(body.statuses) && body.statuses.length > 0
        ? (body.statuses.filter((v) => typeof v === "string") as string[])
        : DEFAULT_STATUSES;

    const result = await fetchLaborRows(ctx, from, to, projectIds, subIds, statuses);
    if (!result.ok) return result.response;
    const rows = result.rows;

    const baseFilename = `labor-export_${from}_to_${to}`;
    let buffer: Uint8Array;
    let contentType: string;
    let filename: string;
    if (format === "csv") {
      buffer = new TextEncoder().encode(rowsToCsv(rows));
      contentType = "text/csv; charset=utf-8";
      filename = `${baseFilename}.csv`;
    } else {
      buffer = rowsToXlsx(rows);
      contentType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      filename = `${baseFilename}.xlsx`;
    }

    const auditErr = await writeAudit(
      ctx.adminClient,
      ctx.tenantId,
      ctx.userId,
      "tenant.export_labor",
      "tenant",
      ctx.tenantId,
      {
        format,
        from,
        to,
        rows: rows.length,
        project_ids: projectIds,
        subcontractor_ids: subIds,
        statuses,
      },
    );
    if (auditErr) return problemResponse(auditErr);

    return new Response(new Blob([buffer as BlobPart]), {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-disposition": `attachment; filename="${filename}"`,
        "x-invenio-rows": String(rows.length),
      },
    });
  }),
);
