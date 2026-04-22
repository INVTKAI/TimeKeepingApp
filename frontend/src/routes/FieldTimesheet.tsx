import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  useAreas,
  useCwps,
  useEmployees,
  useFcos,
  useProjects,
  useTaskCodes,
} from "@/lib/referenceData";
import {
  useClaimField,
  useRecallRun,
  useReleaseField,
  useSubmitTimesheet,
} from "@/lib/mutations";
import {
  humanizeError,
  P_CODES,
  type PostgrestError,
} from "@/lib/problem";

// Field timesheet editor. Single-day, multi-employee. The foreman picks the
// shared work-context (area / task_code / cwp / fco) once; each crew row
// stores its employee and per-day hours. On save, all lines inherit the
// header context so the schema's per-line dimensions stay populated.

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
  id: string | null;
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

type CrewRow = {
  key: string;
  persistedId: string | null;
  employee_id: string;
  hours_st: number;
  hours_ot: number;
  comment: string | null;
};

function toCrewRows(lines: LineRow[]): CrewRow[] {
  return lines.map((l) => ({
    key: l.id ?? `new-${l.employee_id}`,
    persistedId: l.id,
    employee_id: l.employee_id,
    hours_st: l.hours_st,
    hours_ot: l.hours_ot,
    comment: l.comment,
  }));
}

export function FieldTimesheet() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [banner, setBanner] = useState<
    { kind: "info"; text: string } | { kind: "error"; text: string } | null
  >(null);

  const projects = useProjects();
  const areas = useAreas();
  const taskCodes = useTaskCodes();
  const cwps = useCwps();
  const fcos = useFcos();
  const employees = useEmployees();

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

  // Shared work-context: derived from the first existing line (consistent by
  // construction — all field lines share it) or empty when pre-claim.
  const [areaId, setAreaId] = useState<string | null>(null);
  const [taskCodeId, setTaskCodeId] = useState<string | null>(null);
  const [cwpId, setCwpId] = useState<string | null>(null);
  const [fcoId, setFcoId] = useState<string | null>(null);
  const [crew, setCrew] = useState<CrewRow[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!linesQuery.data) return;
    const first = linesQuery.data[0];
    setAreaId(first?.area_id ?? null);
    setTaskCodeId(first?.task_code_id ?? null);
    setCwpId(first?.cwp_id ?? null);
    setFcoId(first?.fco_id ?? null);
    setCrew(toCrewRows(linesQuery.data));
    setDirty(false);
  }, [linesQuery.data]);

  const editable =
    ts?.status === "draft" &&
    ts?.submitter_user_id === userId;
  const canClaim = ts?.status === "open";
  const canRelease =
    ts?.status === "draft" && ts.submitter_user_id === userId;

  const project = useMemo(
    () => projects.data?.find((p) => p.id === ts?.project_id) ?? null,
    [projects.data, ts?.project_id],
  );

  const scopedAreas = useMemo(
    () => (areas.data ?? []).filter((a) => a.project_id === ts?.project_id),
    [areas.data, ts?.project_id],
  );

  const siloEmployees = useMemo(
    () =>
      (employees.data ?? [])
        .filter((e) => e.active && e.subcontractor_id === ts?.subcontractor_id)
        .sort((a, b) =>
          `${a.last_name} ${a.first_name}`.localeCompare(
            `${b.last_name} ${b.first_name}`,
          ),
        ),
    [employees.data, ts?.subcontractor_id],
  );

  const addCrew = () => {
    setCrew((prev) => [
      ...prev,
      {
        key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        persistedId: null,
        employee_id: "",
        hours_st: 0,
        hours_ot: 0,
        comment: null,
      },
    ]);
    setDirty(true);
  };
  const patchCrew = (key: string, patch: Partial<CrewRow>) => {
    setCrew((prev) => prev.map((c) => (c.key === key ? { ...c, ...patch } : c)));
    setDirty(true);
  };
  const removeCrew = (key: string) => {
    setCrew((prev) => prev.filter((c) => c.key !== key));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!ts) throw new Error("timesheet not loaded");
      const serverLines = linesQuery.data ?? [];
      const serverById = new Map(serverLines.map((l) => [l.id!, l]));
      const keepIds = new Set<string>();
      const toInsert: Record<string, unknown>[] = [];
      const toUpdate: { id: string; patch: Record<string, unknown> }[] = [];

      for (const row of crew) {
        if (!row.employee_id) continue;
        const hasHours = row.hours_st > 0 || row.hours_ot > 0;
        if (!hasHours && !row.comment) continue;
        if (row.persistedId) {
          keepIds.add(row.persistedId);
          const before = serverById.get(row.persistedId);
          if (
            before &&
            (before.hours_st !== row.hours_st ||
              before.hours_ot !== row.hours_ot ||
              before.area_id !== areaId ||
              before.task_code_id !== taskCodeId ||
              before.cwp_id !== cwpId ||
              before.fco_id !== fcoId ||
              before.employee_id !== row.employee_id ||
              (before.comment ?? null) !== (row.comment ?? null))
          ) {
            toUpdate.push({
              id: row.persistedId,
              patch: {
                area_id: areaId,
                task_code_id: taskCodeId,
                cwp_id: cwpId,
                fco_id: fcoId,
                employee_id: row.employee_id,
                hours_st: row.hours_st,
                hours_ot: row.hours_ot,
                comment: row.comment,
              },
            });
          }
        } else {
          toInsert.push({
            timesheet_id: ts.id,
            tenant_id: ts.tenant_id,
            date: ts.period_start,
            area_id: areaId,
            task_code_id: taskCodeId,
            cwp_id: cwpId,
            fco_id: fcoId,
            employee_id: row.employee_id,
            hours_st: row.hours_st,
            hours_ot: row.hours_ot,
            comment: row.comment,
          });
        }
      }

      const toDelete = serverLines
        .filter((l) => l.id && !keepIds.has(l.id))
        .map((l) => l.id!);
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
        const { error } = await supabase
          .from("timesheet_lines")
          .insert(toInsert);
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
  const claim = useClaimField();
  const release = useReleaseField();
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
          <Link to="/timesheets" className="text-brand hover:underline text-sm">
            Back to list
          </Link>
        </div>
      </div>
    );
  }

  const crewTotal = crew.reduce((s, r) => s + r.hours_st + r.hours_ot, 0);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-semibold">
              Field timesheet — <span className="font-mono">{ts.period_start}</span>
            </h1>
            <p className="text-xs text-ink-muted">
              {project ? `${project.number} · ${project.name}` : ts.project_id.slice(0, 8)}
              {" · "}
              <span className="font-mono">status={ts.status}</span>
              {!editable && !canClaim && (
                <span className="ml-2 text-warn-deep font-medium">read-only</span>
              )}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {canClaim && (
              <button
                className="invenio-btn-primary"
                disabled={claim.isPending}
                onClick={async () => {
                  setBanner(null);
                  try {
                    await claim.mutateAsync({ timesheet_id: ts.id });
                    setBanner({ kind: "info", text: "Claimed." });
                    qc.invalidateQueries({ queryKey: ["timesheet", id] });
                  } catch (err) {
                    handleError(err);
                  }
                }}
              >
                {claim.isPending ? "Claiming…" : "Claim"}
              </button>
            )}
            {canRelease && (
              <button
                className="invenio-btn-secondary"
                disabled={release.isPending}
                onClick={async () => {
                  setBanner(null);
                  try {
                    await release.mutateAsync({ timesheet_id: ts.id });
                    setBanner({ kind: "info", text: "Released back to open." });
                    navigate("/timesheets");
                  } catch (err) {
                    handleError(err);
                  }
                }}
              >
                {release.isPending ? "Releasing…" : "Release"}
              </button>
            )}
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
                save.mutate(undefined, { onError: (err) => handleError(err) });
              }}
            >
              {save.isPending ? "Saving…" : dirty ? "Save draft" : "Saved"}
            </button>
            <button
              className="invenio-btn-primary"
              disabled={!editable || dirty || submit.isPending}
              title={dirty ? "Save your draft before submitting" : undefined}
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

      <main className="max-w-5xl mx-auto p-6 flex flex-col gap-4">
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

        {/* Header context */}
        <div className="invenio-card">
          <h2 className="text-sm font-semibold mb-3">Work context</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="invenio-label">Area</label>
              <select
                className="invenio-input"
                disabled={!editable}
                value={areaId ?? ""}
                onChange={(e) => { setAreaId(e.target.value || null); setDirty(true); }}
              >
                <option value="">—</option>
                {scopedAreas.map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="invenio-label">Task</label>
              <select
                className="invenio-input"
                disabled={!editable}
                value={taskCodeId ?? ""}
                onChange={(e) => { setTaskCodeId(e.target.value || null); setDirty(true); }}
              >
                <option value="">—</option>
                {(taskCodes.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.code} · {t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="invenio-label">CWP</label>
              <select
                className="invenio-input"
                disabled={!editable}
                value={cwpId ?? ""}
                onChange={(e) => { setCwpId(e.target.value || null); setDirty(true); }}
              >
                <option value="">—</option>
                {(cwps.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.code}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="invenio-label">FCO / PCR</label>
              <select
                className="invenio-input"
                disabled={!editable}
                value={fcoId ?? ""}
                onChange={(e) => { setFcoId(e.target.value || null); setDirty(true); }}
              >
                <option value="">—</option>
                {(fcos.data ?? []).map((f) => (
                  <option key={f.id} value={f.id}>{f.code}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Crew grid */}
        <div className="invenio-card p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-raised text-ink-muted text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 font-medium">Employee</th>
                <th className="px-3 py-2 font-medium">Craft</th>
                <th className="px-3 py-2 font-medium text-center">ST hours</th>
                <th className="px-3 py-2 font-medium text-center">OT hours</th>
                <th className="px-3 py-2 font-medium">Comment</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {crew.map((row) => {
                const emp = siloEmployees.find((e) => e.id === row.employee_id);
                return (
                  <tr key={row.key} className="border-t border-border">
                    <td className="px-2 py-1">
                      <select
                        className="invenio-input !min-h-0 !py-1 !text-xs"
                        disabled={!editable}
                        value={row.employee_id}
                        onChange={(e) => patchCrew(row.key, { employee_id: e.target.value })}
                      >
                        <option value="">— pick employee —</option>
                        {siloEmployees.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.last_name}, {e.first_name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-1 text-ink-muted text-xs">{emp?.craft ?? "—"}</td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="number"
                        step="0.25"
                        min={0}
                        max={24}
                        disabled={!editable}
                        value={row.hours_st === 0 ? "" : row.hours_st}
                        onChange={(e) =>
                          patchCrew(row.key, { hours_st: Number(e.target.value || 0) })
                        }
                        className="invenio-input !min-h-0 !py-1 !px-1 !text-xs text-center w-20"
                        placeholder="0"
                      />
                    </td>
                    <td className="px-2 py-1 text-center">
                      <input
                        type="number"
                        step="0.25"
                        min={0}
                        max={24}
                        disabled={!editable}
                        value={row.hours_ot === 0 ? "" : row.hours_ot}
                        onChange={(e) =>
                          patchCrew(row.key, { hours_ot: Number(e.target.value || 0) })
                        }
                        className="invenio-input !min-h-0 !py-1 !px-1 !text-xs text-center w-20 text-danger"
                        placeholder="0"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        disabled={!editable}
                        value={row.comment ?? ""}
                        onChange={(e) =>
                          patchCrew(row.key, { comment: e.target.value || null })
                        }
                        className="invenio-input !min-h-0 !py-1 !text-xs"
                        placeholder="—"
                      />
                    </td>
                    <td className="px-2 py-1 text-right">
                      {editable && (
                        <button
                          className="text-danger hover:text-danger-hover text-xs"
                          onClick={() => removeCrew(row.key)}
                          title="Remove"
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {crew.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-ink-muted">
                    No crew rows yet. {editable && "Click “+ Add crew member” to start."}
                  </td>
                </tr>
              )}
              <tr className="border-t border-border bg-raised">
                <td colSpan={2} className="px-3 py-2 font-semibold text-xs">
                  Total
                </td>
                <td colSpan={2} className="px-3 py-2 font-mono text-right">
                  {crewTotal.toFixed(2)}
                </td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </div>

        {editable && (
          <div>
            <button className="invenio-btn-secondary" onClick={addCrew}>
              + Add crew member
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
