import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import {
  addDays,
  DAY_LABELS,
  useAreas,
  useCwps,
  useFcos,
  useProjects,
  useTaskCodes,
} from "@/lib/referenceData";
import {
  useRecallRun,
  useSubmitTimesheet,
} from "@/lib/mutations";
import {
  humanizeError,
  P_CODES,
  type PostgrestError,
} from "@/lib/problem";

// --- Types -------------------------------------------------------------------

type Timesheet = {
  id: string;
  tenant_id: string;
  kind: "staff" | "field";
  status:
    | "draft"
    | "open"
    | "submitted"
    | "in_review"
    | "approved"
    | "rejected"
    | "recalled";
  submitter_user_id: string | null;
  employee_id: string | null;
  project_id: string;
  subcontractor_id: string;
  period_start: string;
  period_end: string;
};

type LineRow = {
  id: string | null; // null for new rows
  date: string;
  area_id: string | null;
  task_code_id: string | null;
  cwp_id: string | null;
  fco_id: string | null;
  employee_id: string;
  hours_st: number;
  hours_ot: number;
  comment: string | null;
};

// Each "display row" is a unique (project+area+task+cwp+fco) combo with 7 days
// laid out as { [date]: {st, ot} }. The local stateful key is a client-only id
// so user-added rows remain stable across rerenders.
type DisplayRow = {
  key: string;
  area_id: string | null;
  task_code_id: string | null;
  cwp_id: string | null;
  fco_id: string | null;
  hours: Record<string, { st: number; ot: number; comment: string | null }>;
  // Maps date → DB row id; null means "not saved yet".
  persistedIds: Record<string, string | null>;
};

function dimKey(
  areaId: string | null,
  taskId: string | null,
  cwpId: string | null,
  fcoId: string | null,
): string {
  return [areaId, taskId, cwpId, fcoId].map((v) => v ?? "-").join("|");
}

function toDisplayRows(lines: LineRow[], weekDates: string[]): DisplayRow[] {
  const grouped = new Map<string, DisplayRow>();
  for (const l of lines) {
    const k = dimKey(l.area_id, l.task_code_id, l.cwp_id, l.fco_id);
    let row = grouped.get(k);
    if (!row) {
      row = {
        key: k,
        area_id: l.area_id,
        task_code_id: l.task_code_id,
        cwp_id: l.cwp_id,
        fco_id: l.fco_id,
        hours: Object.fromEntries(
          weekDates.map((d) => [d, { st: 0, ot: 0, comment: null }]),
        ),
        persistedIds: Object.fromEntries(weekDates.map((d) => [d, null])),
      };
      grouped.set(k, row);
    }
    row.hours[l.date] = {
      st: l.hours_st,
      ot: l.hours_ot,
      comment: l.comment,
    };
    row.persistedIds[l.date] = l.id;
  }
  return [...grouped.values()];
}

// ---------------------------------------------------------------------------

export function StaffTimesheet() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [banner, setBanner] = useState<
    | { kind: "info"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);

  const projects = useProjects();
  const areas = useAreas();
  const taskCodes = useTaskCodes();
  const cwps = useCwps();
  const fcos = useFcos();

  const tsQuery = useQuery<Timesheet | null>({
    queryKey: ["timesheet", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("timesheets")
        .select(
          "id, tenant_id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end",
        )
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as Timesheet | null;
    },
  });

  const linesQuery = useQuery<LineRow[]>({
    queryKey: ["timesheet_lines", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("timesheet_lines")
        .select(
          "id, date, area_id, task_code_id, cwp_id, fco_id, employee_id, hours_st, hours_ot, comment",
        )
        .eq("timesheet_id", id!);
      if (error) throw error;
      return (data ?? []) as LineRow[];
    },
  });

  // Active run for Recall button. NULL if none open.
  const runQuery = useQuery<{ id: string } | null>({
    queryKey: ["active_run_for_timesheet", id],
    enabled: !!id && tsQuery.data?.status === "submitted",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("approval_runs")
        .select("id")
        .eq("timesheet_id", id!)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return data as { id: string } | null;
    },
  });

  const ts = tsQuery.data ?? null;
  const weekDates = useMemo(() => {
    if (!ts) return [];
    return Array.from({ length: 7 }, (_, i) => addDays(ts.period_start, i));
  }, [ts]);

  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (linesQuery.data && ts) {
      setRows(toDisplayRows(linesQuery.data, weekDates));
      setDirty(false);
    }
  }, [linesQuery.data, ts, weekDates]);

  const editable = ts?.status === "draft" || ts?.status === "rejected";

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        area_id: null,
        task_code_id: null,
        cwp_id: null,
        fco_id: null,
        hours: Object.fromEntries(
          weekDates.map((d) => [d, { st: 0, ot: 0, comment: null }]),
        ),
        persistedIds: Object.fromEntries(weekDates.map((d) => [d, null])),
      },
    ]);
    setDirty(true);
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    setDirty(true);
  };

  const patchRow = (key: string, patch: Partial<DisplayRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const patchCell = (
    key: string,
    date: string,
    which: "st" | "ot",
    value: number,
  ) => {
    setRows((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r;
        const cur = r.hours[date] ?? { st: 0, ot: 0, comment: null };
        return {
          ...r,
          hours: {
            ...r.hours,
            [date]: { ...cur, [which]: isFinite(value) && value >= 0 ? value : 0 },
          },
        };
      }),
    );
    setDirty(true);
  };

  // ---- Save (diff-sync lines) ----
  const save = useMutation({
    mutationFn: async () => {
      if (!ts) throw new Error("timesheet not loaded");
      const serverLines = linesQuery.data ?? [];
      const toInsert: Record<string, unknown>[] = [];
      const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];

      const targetIds = new Set<string>();

      for (const row of rows) {
        for (const date of weekDates) {
          const cell = row.hours[date];
          if (!cell) continue;
          const persistedId = row.persistedIds[date];
          const keep = cell.st > 0 || cell.ot > 0 || !!cell.comment;

          if (persistedId) {
            if (keep) {
              targetIds.add(persistedId);
              const before = serverLines.find((l) => l.id === persistedId);
              if (
                before &&
                (before.hours_st !== cell.st ||
                  before.hours_ot !== cell.ot ||
                  before.area_id !== row.area_id ||
                  before.task_code_id !== row.task_code_id ||
                  before.cwp_id !== row.cwp_id ||
                  before.fco_id !== row.fco_id ||
                  (before.comment ?? null) !== (cell.comment ?? null))
              ) {
                toUpdate.push({
                  id: persistedId,
                  patch: {
                    area_id: row.area_id,
                    task_code_id: row.task_code_id,
                    cwp_id: row.cwp_id,
                    fco_id: row.fco_id,
                    hours_st: cell.st,
                    hours_ot: cell.ot,
                    comment: cell.comment,
                  },
                });
              }
            }
            // if !keep, we leave it out of targetIds → gets deleted
          } else if (keep) {
            toInsert.push({
              timesheet_id: ts.id,
              tenant_id: ts.tenant_id,
              date,
              area_id: row.area_id,
              task_code_id: row.task_code_id,
              cwp_id: row.cwp_id,
              fco_id: row.fco_id,
              employee_id: ts.employee_id,
              hours_st: cell.st,
              hours_ot: cell.ot,
              comment: cell.comment,
            });
          }
        }
      }

      const toDelete = serverLines
        .filter((l) => l.id && !targetIds.has(l.id))
        .map((l) => l.id!)
        .filter((id) => id);

      if (toDelete.length > 0) {
        const { error } = await supabase
          .from("timesheet_lines")
          .delete()
          .in("id", toDelete);
        if (error) throw error;
      }
      for (const u of toUpdate) {
        const { error } = await supabase
          .from("timesheet_lines")
          .update(u.patch)
          .eq("id", u.id);
        if (error) throw error;
      }
      if (toInsert.length > 0) {
        const { error } = await supabase.from("timesheet_lines").insert(toInsert);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      setDirty(false);
      setBanner({ kind: "info", text: "Draft saved." });
      qc.invalidateQueries({ queryKey: ["timesheet_lines", id] });
    },
  });

  const submit = useSubmitTimesheet();
  const recall = useRecallRun();

  const handleError = (err: unknown) => {
    const e = err as PostgrestError | undefined;
    if (e?.code === P_CODES.RUN_STATE_CHANGED) {
      setBanner({ kind: "error", text: "State moved on the server — reloading." });
      qc.invalidateQueries({ queryKey: ["timesheet", id] });
      qc.invalidateQueries({ queryKey: ["active_run_for_timesheet", id] });
      return;
    }
    setBanner({ kind: "error", text: humanizeError(err) });
  };

  if (tsQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-muted">Loading timesheet…</p>
      </div>
    );
  }
  if (tsQuery.error || !ts) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="invenio-card max-w-md">
          <h1 className="text-lg font-semibold mb-2">Timesheet not found</h1>
          <p className="text-ink-muted mb-4">
            {tsQuery.error instanceof Error ? tsQuery.error.message : null}
          </p>
          <Link to="/timesheets" className="text-brand hover:underline text-sm">
            Back to list
          </Link>
        </div>
      </div>
    );
  }

  const project = projects.data?.find((p) => p.id === ts.project_id);
  const scopedAreas = (areas.data ?? []).filter(
    (a) => a.project_id === ts.project_id,
  );

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-[1100px] mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold">
              Week of <span className="font-mono">{ts.period_start}</span>
            </h1>
            <p className="text-xs text-ink-muted">
              {project ? `${project.number} · ${project.name}` : ts.project_id.slice(0, 8)}
              {" · "}
              <span className="font-mono">status={ts.status}</span>
              {!editable && (
                <span className="ml-2 text-warn-deep font-medium">read-only</span>
              )}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {ts.status === "submitted" && runQuery.data && (
              <button
                className="invenio-btn-secondary"
                disabled={recall.isPending}
                onClick={async () => {
                  setBanner(null);
                  try {
                    await recall.mutateAsync({ run_id: runQuery.data!.id });
                    setBanner({ kind: "info", text: "Recalled to draft." });
                    qc.invalidateQueries({ queryKey: ["timesheet", id] });
                  } catch (err) {
                    handleError(err);
                  }
                }}
              >
                {recall.isPending ? "Recalling…" : "Recall"}
              </button>
            )}
            <button
              className="invenio-btn-secondary"
              disabled={!editable || !dirty || save.isPending}
              onClick={() => {
                setBanner(null);
                save.mutate(undefined, {
                  onError: (err) => handleError(err),
                });
              }}
            >
              {save.isPending ? "Saving…" : dirty ? "Save draft" : "Saved"}
            </button>
            <button
              className="invenio-btn-primary"
              disabled={!editable || dirty || submit.isPending}
              title={
                dirty
                  ? "Save your draft before submitting"
                  : !editable
                  ? `Cannot submit — current status is ${ts.status}`
                  : undefined
              }
              onClick={async () => {
                setBanner(null);
                try {
                  await submit.mutateAsync({ timesheet_id: ts.id });
                  setBanner({ kind: "info", text: "Submitted." });
                  qc.invalidateQueries({ queryKey: ["timesheet", id] });
                } catch (err) {
                  handleError(err);
                }
              }}
            >
              {submit.isPending ? "Submitting…" : "Submit"}
            </button>
            <Link to="/timesheets" className="invenio-btn-secondary">
              Back
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-[1100px] mx-auto p-6 flex flex-col gap-4">
        {banner && (
          <div
            role={banner.kind === "error" ? "alert" : "status"}
            className={
              banner.kind === "error"
                ? "rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-sm text-danger-deep"
                : "rounded-md bg-brand-soft border border-brand/40 px-3 py-2 text-sm text-brand-hover"
            }
          >
            {banner.text}
          </div>
        )}

        <div className="invenio-card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised text-ink-muted text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 font-medium text-left">Area</th>
                <th className="px-3 py-2 font-medium text-left">Task</th>
                <th className="px-3 py-2 font-medium text-left">CWP</th>
                <th className="px-3 py-2 font-medium text-left">FCO</th>
                {weekDates.map((d, i) => (
                  <th key={d} className="px-2 py-2 font-medium text-center">
                    <div className="font-mono">{DAY_LABELS[i]}</div>
                    <div className="text-[10px] opacity-70">{d.slice(5)}</div>
                  </th>
                ))}
                <th className="px-2 py-2 font-medium text-right">Total</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <LineRowView
                  key={row.key}
                  row={row}
                  editable={editable}
                  weekDates={weekDates}
                  areas={scopedAreas}
                  taskCodes={taskCodes.data ?? []}
                  cwps={cwps.data ?? []}
                  fcos={fcos.data ?? []}
                  onPatchRow={(patch) => patchRow(row.key, patch)}
                  onPatchCell={(date, which, v) => patchCell(row.key, date, which, v)}
                  onRemove={() => removeRow(row.key)}
                />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7 + 6}
                    className="px-3 py-6 text-center text-ink-muted"
                  >
                    No lines yet. {editable && "Click “+ Add line” below to start."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {editable && (
          <div>
            <button className="invenio-btn-secondary" onClick={addRow}>
              + Add line
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

// ---- Row view --------------------------------------------------------------

function LineRowView({
  row,
  editable,
  weekDates,
  areas,
  taskCodes,
  cwps,
  fcos,
  onPatchRow,
  onPatchCell,
  onRemove,
}: {
  row: DisplayRow;
  editable: boolean;
  weekDates: string[];
  areas: { id: string; code: string; name: string }[];
  taskCodes: { id: string; code: string; name: string }[];
  cwps: { id: string; code: string }[];
  fcos: { id: string; code: string }[];
  onPatchRow: (patch: Partial<DisplayRow>) => void;
  onPatchCell: (date: string, which: "st" | "ot", value: number) => void;
  onRemove: () => void;
}) {
  const total = weekDates.reduce((sum, d) => {
    const c = row.hours[d];
    return sum + (c ? c.st + c.ot : 0);
  }, 0);

  return (
    <tr className="border-t border-border">
      <td className="px-2 py-1">
        <select
          className="invenio-input !min-h-0 !py-1 !text-xs"
          value={row.area_id ?? ""}
          disabled={!editable}
          onChange={(e) => onPatchRow({ area_id: e.target.value || null })}
        >
          <option value="">—</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>{a.code}</option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1">
        <select
          className="invenio-input !min-h-0 !py-1 !text-xs"
          value={row.task_code_id ?? ""}
          disabled={!editable}
          onChange={(e) => onPatchRow({ task_code_id: e.target.value || null })}
        >
          <option value="">—</option>
          {taskCodes.map((t) => (
            <option key={t.id} value={t.id}>{t.code}</option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1">
        <select
          className="invenio-input !min-h-0 !py-1 !text-xs"
          value={row.cwp_id ?? ""}
          disabled={!editable}
          onChange={(e) => onPatchRow({ cwp_id: e.target.value || null })}
        >
          <option value="">—</option>
          {cwps.map((c) => (
            <option key={c.id} value={c.id}>{c.code}</option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1">
        <select
          className="invenio-input !min-h-0 !py-1 !text-xs"
          value={row.fco_id ?? ""}
          disabled={!editable}
          onChange={(e) => onPatchRow({ fco_id: e.target.value || null })}
        >
          <option value="">—</option>
          {fcos.map((f) => (
            <option key={f.id} value={f.id}>{f.code}</option>
          ))}
        </select>
      </td>
      {weekDates.map((d) => {
        const c = row.hours[d] ?? { st: 0, ot: 0, comment: null };
        return (
          <td key={d} className="px-1 py-1 text-center">
            <div className="flex flex-col gap-0.5">
              <input
                type="number"
                step="0.25"
                min={0}
                max={24}
                disabled={!editable}
                value={c.st === 0 ? "" : c.st}
                onChange={(e) =>
                  onPatchCell(d, "st", Number(e.target.value || 0))
                }
                className="invenio-input !min-h-0 !py-0.5 !px-1 !text-xs text-center w-16"
                placeholder="ST"
                aria-label={`ST ${d}`}
              />
              <input
                type="number"
                step="0.25"
                min={0}
                max={24}
                disabled={!editable}
                value={c.ot === 0 ? "" : c.ot}
                onChange={(e) =>
                  onPatchCell(d, "ot", Number(e.target.value || 0))
                }
                className="invenio-input !min-h-0 !py-0.5 !px-1 !text-xs text-center w-16 text-danger"
                placeholder="OT"
                aria-label={`OT ${d}`}
              />
            </div>
          </td>
        );
      })}
      <td className="px-2 py-1 text-right font-mono text-sm">{total.toFixed(2)}</td>
      <td className="px-2 py-1 text-right">
        {editable && (
          <button
            className="text-danger hover:text-danger-hover text-xs"
            onClick={onRemove}
            title="Remove line"
          >
            ✕
          </button>
        )}
      </td>
    </tr>
  );
}
