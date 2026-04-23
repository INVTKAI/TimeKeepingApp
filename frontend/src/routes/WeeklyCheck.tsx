import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import {
  DAY_LABELS,
  addDays,
  mondayOf,
  useEmployees,
} from "@/lib/referenceData";
import { humanizeError } from "@/lib/problem";
import { Banner, PageHeader } from "@/components/PageHeader";

// Weekly Check — pattern B.
//
// Legacy demo compared "badge_records" (from a timeclock system) against
// entered timesheet hours. We don't have a badge_records schema yet
// (customer-dependent, spec §10 known-gap), so instead this page lets the
// admin paste or upload a CSV of badge data for the selected week and
// diffs it row-for-row against what got entered. Each mismatched row gets
// a one-click "Create override" that calls create_badge_override with the
// submitted vs. badge hours pre-populated.
//
// CSV header (case-insensitive): external_id, date, st, ot
// — external_id maps to employees.external_id
// — date is YYYY-MM-DD and must fall within the selected Mon..Sun
//
// Comparison rounding: 0.05 hrs (3 min) tolerance — any smaller gap is
// ignored as clock noise.

type TsLine = {
  employee_id: string;
  date: string;
  hours_st: number;
  hours_ot: number;
  project_id: string;
  subcontractor_id: string;
};

type BadgeRow = {
  external_id: string;
  date: string;
  st: number;
  ot: number;
};

type ComparisonRow = {
  employee_id: string;
  external_id: string | null;
  name: string;
  date: string;
  submitted_st: number;
  submitted_ot: number;
  badge_st: number;
  badge_ot: number;
  project_id: string | null;
  subcontractor_id: string | null;
  delta: number;
  match: boolean;
};

const TOL = 0.05;

export function WeeklyCheck() {
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const [weekStart, setWeekStart] = useState(mondayOf(today));
  const [badgeText, setBadgeText] = useState("");
  const [badgeRows, setBadgeRows] = useState<BadgeRow[]>([]);
  const [filterMode, setFilterMode] = useState<"all" | "mismatched" | "missing">(
    "mismatched",
  );
  const [banner, setBanner] = useState<
    { kind: "info" | "error" | "success"; text: string } | null
  >(null);

  const { data: employees } = useEmployees();

  const weekEnd = addDays(weekStart, 6);

  const { data: tsLines, isLoading } = useQuery<TsLine[]>({
    queryKey: ["weekly_check_lines", weekStart, weekEnd],
    queryFn: async () => {
      // RLS restricts to tenant via the join to timesheets; we fetch lines
      // directly because the scoped-select on timesheet_lines tenant-filters.
      const { data, error } = await supabase
        .from("timesheet_lines")
        .select(
          "employee_id, date, hours_st, hours_ot, timesheets!inner(project_id, subcontractor_id, status)",
        )
        .gte("date", weekStart)
        .lte("date", weekEnd);
      if (error) throw error;
      type Raw = {
        employee_id: string;
        date: string;
        hours_st: string | number;
        hours_ot: string | number;
        timesheets: {
          project_id: string;
          subcontractor_id: string;
          status: string;
        };
      };
      return (data as unknown as Raw[]).map((r) => ({
        employee_id: r.employee_id,
        date: r.date,
        hours_st: Number(r.hours_st),
        hours_ot: Number(r.hours_ot),
        project_id: r.timesheets?.project_id ?? "",
        subcontractor_id: r.timesheets?.subcontractor_id ?? "",
      }));
    },
  });

  const parseBadgeText = () => {
    try {
      const rows = parseCsv(badgeText);
      setBadgeRows(rows);
      setBanner({
        kind: "success",
        text: `Parsed ${rows.length} badge row${rows.length === 1 ? "" : "s"}.`,
      });
    } catch (err) {
      setBanner({ kind: "error", text: humanizeError(err) });
    }
  };

  const clearBadges = () => {
    setBadgeText("");
    setBadgeRows([]);
    setBanner(null);
  };

  const comparisonRows = useMemo<ComparisonRow[]>(() => {
    if (!employees || !tsLines) return [];

    // Sum submitted hours per (employee_id, date). Choose any project/sub
    // from among that day's lines for the override-creation default.
    type Agg = {
      st: number;
      ot: number;
      project_id: string;
      subcontractor_id: string;
    };
    const subm = new Map<string, Agg>();
    for (const l of tsLines) {
      const key = `${l.employee_id}|${l.date}`;
      const prev = subm.get(key) ?? {
        st: 0,
        ot: 0,
        project_id: l.project_id,
        subcontractor_id: l.subcontractor_id,
      };
      subm.set(key, {
        st: prev.st + l.hours_st,
        ot: prev.ot + l.hours_ot,
        project_id: prev.project_id || l.project_id,
        subcontractor_id: prev.subcontractor_id || l.subcontractor_id,
      });
    }

    const byExternalId = new Map(
      employees.filter((e) => e.external_id).map((e) => [e.external_id!, e]),
    );

    const seen = new Set<string>();
    const out: ComparisonRow[] = [];
    for (const b of badgeRows) {
      const emp = byExternalId.get(b.external_id);
      if (!emp) continue; // unknown external_id — surfaced in the banner instead
      const key = `${emp.id}|${b.date}`;
      seen.add(key);
      const s = subm.get(key);
      const submittedSt = s?.st ?? 0;
      const submittedOt = s?.ot ?? 0;
      const delta = Math.abs(
        submittedSt + submittedOt - (b.st + b.ot),
      );
      out.push({
        employee_id: emp.id,
        external_id: emp.external_id,
        name: `${emp.last_name}, ${emp.first_name}`,
        date: b.date,
        submitted_st: submittedSt,
        submitted_ot: submittedOt,
        badge_st: b.st,
        badge_ot: b.ot,
        project_id: s?.project_id ?? null,
        subcontractor_id: s?.subcontractor_id ?? null,
        delta,
        match: delta < TOL,
      });
    }

    // Surface any submitted-hours rows that had no badge record at all —
    // these are "entered but didn't badge" mismatches.
    for (const [key, agg] of subm) {
      if (seen.has(key)) continue;
      const [empId, date] = key.split("|");
      const emp = employees.find((e) => e.id === empId);
      if (!emp) continue;
      out.push({
        employee_id: emp.id,
        external_id: emp.external_id,
        name: `${emp.last_name}, ${emp.first_name}`,
        date,
        submitted_st: agg.st,
        submitted_ot: agg.ot,
        badge_st: 0,
        badge_ot: 0,
        project_id: agg.project_id,
        subcontractor_id: agg.subcontractor_id,
        delta: agg.st + agg.ot,
        match: agg.st + agg.ot < TOL,
      });
    }

    out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
    return out;
  }, [employees, tsLines, badgeRows]);

  const { matched, mismatched, unknownBadgeIds } = useMemo(() => {
    const matched = comparisonRows.filter((r) => r.match).length;
    const mismatched = comparisonRows.filter((r) => !r.match).length;
    const known = new Set(
      (employees ?? []).map((e) => e.external_id).filter(Boolean) as string[],
    );
    const unknownBadgeIds = Array.from(
      new Set(badgeRows.filter((b) => !known.has(b.external_id)).map((b) => b.external_id)),
    );
    return { matched, mismatched, unknownBadgeIds };
  }, [comparisonRows, employees, badgeRows]);

  const filtered = useMemo(() => {
    switch (filterMode) {
      case "all":
        return comparisonRows;
      case "mismatched":
        return comparisonRows.filter((r) => !r.match);
      case "missing":
        return comparisonRows.filter(
          (r) => r.badge_st + r.badge_ot === 0 && r.submitted_st + r.submitted_ot > 0,
        );
    }
  }, [comparisonRows, filterMode]);

  const createOverride = useMutation({
    mutationFn: async (row: ComparisonRow) => {
      if (!row.project_id || !row.subcontractor_id) {
        throw new Error(
          "Can't create override from a badge-only row (no timesheet context). Pick a project + sub manually in Badge Overrides.",
        );
      }
      const { error } = await supabase.rpc("create_badge_override", {
        p_employee_id: row.employee_id,
        p_date: row.date,
        p_project_id: row.project_id,
        p_subcontractor_id: row.subcontractor_id,
        p_submitted_hours_st: row.submitted_st,
        p_submitted_hours_ot: row.submitted_ot,
        p_badge_hours_st: row.badge_st,
        p_badge_hours_ot: row.badge_ot,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setBanner({ kind: "info", text: "Override created. Resolve it in Badge Overrides." });
      qc.invalidateQueries({ queryKey: ["admin_badge_overrides"] });
    },
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  const handleFile = async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      setBadgeText(text);
      const rows = parseCsv(text);
      setBadgeRows(rows);
      setBanner({
        kind: "success",
        text: `Loaded ${rows.length} badge row${rows.length === 1 ? "" : "s"} from ${file.name}.`,
      });
    } catch (err) {
      setBanner({ kind: "error", text: humanizeError(err) });
    }
  };

  return (
    <div className="invenio-page">
      <PageHeader
        title="Weekly Check"
        subtitle="Reconcile badge hours vs entered timesheet hours for a single week."
        actions={
          <Link to="/admin/badges" className="invenio-btn-secondary">
            Open badge overrides
          </Link>
        }
      />

      <div className="invenio-card flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="invenio-label">Week starting (Monday)</label>
            <input
              type="date"
              className="invenio-input"
              value={weekStart}
              onChange={(e) => setWeekStart(mondayOf(e.target.value))}
            />
          </div>
          <p className="text-sm text-ink-muted pb-2">
            Comparing <span className="font-mono">{weekStart}</span> →{" "}
            <span className="font-mono">{weekEnd}</span>
          </p>
        </div>

        <details className="text-sm" open>
          <summary className="cursor-pointer font-medium">Paste or upload badge CSV</summary>
          <div className="flex flex-col gap-3 mt-3">
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
              />
              <span className="text-xs text-ink-muted">
                or paste below
              </span>
            </div>
            <textarea
              className="invenio-input min-h-[120px] py-2 font-mono text-xs"
              placeholder={"external_id,date,st,ot\nE005,2026-04-20,8,2\nE006,2026-04-20,10,0"}
              value={badgeText}
              onChange={(e) => setBadgeText(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="invenio-btn-secondary" onClick={parseBadgeText}>
                Parse
              </button>
              <button className="invenio-btn-secondary" onClick={clearBadges}>
                Clear
              </button>
            </div>
          </div>
        </details>
      </div>

      {banner && <Banner kind={banner.kind === "success" ? "success" : banner.kind}>{banner.text}</Banner>}

      {unknownBadgeIds.length > 0 && (
        <Banner kind="warn">
          Unknown external_ids in badge CSV (skipped):{" "}
          <span className="font-mono">{unknownBadgeIds.join(", ")}</span>
        </Banner>
      )}

      {badgeRows.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <StatTile label="Badge rows" value={badgeRows.length} />
          <StatTile label="Matched" value={matched} tone="success" />
          <StatTile
            label="Mismatched"
            value={mismatched}
            tone={mismatched > 0 ? "warn" : "neutral"}
          />
        </div>
      )}

      {isLoading && <p className="text-ink-muted">Loading timesheets…</p>}

      {comparisonRows.length > 0 && (
        <>
          <div className="flex gap-2 border-b border-border">
            {(["mismatched", "all", "missing"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setFilterMode(k)}
                className={
                  filterMode === k
                    ? "px-4 py-2 text-sm font-medium text-brand-hover border-b-2 border-brand -mb-px"
                    : "px-4 py-2 text-sm text-ink-muted hover:text-ink-primary"
                }
              >
                {k === "mismatched"
                  ? `Mismatched (${mismatched})`
                  : k === "missing"
                    ? "Entered but not badged"
                    : `All (${comparisonRows.length})`}
              </button>
            ))}
          </div>

          <div className="invenio-card p-0 overflow-hidden">
            <table className="invenio-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>ExtID</th>
                  <th className="text-right">Submitted (ST/OT)</th>
                  <th className="text-right">Badge (ST/OT)</th>
                  <th className="text-right">Δ</th>
                  <th className="text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={`${r.employee_id}|${r.date}`}>
                    <td className="font-mono text-xs">{dayLabel(r.date, weekStart)}</td>
                    <td>{r.name}</td>
                    <td className="font-mono text-xs">{r.external_id ?? "—"}</td>
                    <td className="text-right font-mono text-xs">
                      {r.submitted_st.toFixed(2)} / {r.submitted_ot.toFixed(2)}
                    </td>
                    <td className="text-right font-mono text-xs">
                      {r.badge_st.toFixed(2)} / {r.badge_ot.toFixed(2)}
                    </td>
                    <td className="text-right font-mono text-xs">
                      {r.match ? (
                        <span className="text-success-deep">✓</span>
                      ) : (
                        r.delta.toFixed(2)
                      )}
                    </td>
                    <td className="text-right">
                      {r.match ? (
                        <span className="text-xs text-ink-muted">—</span>
                      ) : (
                        <button
                          className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                          disabled={createOverride.isPending}
                          onClick={() => createOverride.mutate(r)}
                        >
                          Create override
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {badgeRows.length === 0 && (
        <div className="invenio-card">
          <p className="text-sm text-ink-muted">
            Paste a badge CSV above to start a reconciliation. Until you do,
            this page just shows the selected week's range.
          </p>
          <p className="text-xs text-ink-muted mt-2">
            Note:{" "}
            <span className="font-mono">badge_records</span> table isn't in the
            backend yet (§10 known-gap). Once the customer confirms a data
            shape, this page will read directly from that table instead.
          </p>
        </div>
      )}
    </div>
  );
}

function dayLabel(date: string, weekStart: string): string {
  const d = new Date(date + "T00:00:00");
  const start = new Date(weekStart + "T00:00:00");
  const diffDays = Math.floor(
    (d.getTime() - start.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diffDays < 0 || diffDays > 6) return date;
  return `${DAY_LABELS[diffDays]} ${date.slice(5)}`;
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warn" | "neutral";
}) {
  const cls =
    tone === "success"
      ? "text-success-deep"
      : tone === "warn"
        ? "text-warn-deep"
        : "text-ink-primary";
  return (
    <div className="invenio-card !p-4 min-w-[140px]">
      <p className="text-xs uppercase tracking-wide text-ink-subtle">{label}</p>
      <p className={`text-h2 font-semibold ${cls}`}>{value}</p>
    </div>
  );
}

// Minimal CSV parser — accepts quoted cells but otherwise forgiving. Input is
// admin-curated so we don't need to handle every edge case.
function parseCsv(text: string): BadgeRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  // Detect optional header.
  const first = lines[0].split(",").map((s) => s.trim().toLowerCase());
  let startIdx = 0;
  let colExt = 0;
  let colDate = 1;
  let colSt = 2;
  let colOt = 3;
  if (
    first.includes("external_id") ||
    first.includes("date") ||
    first.includes("st")
  ) {
    colExt = first.indexOf("external_id");
    colDate = first.indexOf("date");
    colSt = first.indexOf("st");
    colOt = first.indexOf("ot");
    if (colExt === -1 || colDate === -1 || colSt === -1 || colOt === -1) {
      throw new Error(
        "CSV header must include external_id, date, st, ot (any order).",
      );
    }
    startIdx = 1;
  }
  const out: BadgeRow[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const cells = lines[i].split(",").map((s) => s.trim());
    const external_id = cells[colExt];
    const date = cells[colDate];
    const st = Number(cells[colSt]);
    const ot = Number(cells[colOt]);
    if (!external_id || !date || Number.isNaN(st) || Number.isNaN(ot)) {
      throw new Error(
        `Row ${i + 1} is malformed — expected external_id,date,st,ot.`,
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Row ${i + 1}: date must be YYYY-MM-DD.`);
    }
    out.push({ external_id, date, st, ot });
  }
  return out;
}
