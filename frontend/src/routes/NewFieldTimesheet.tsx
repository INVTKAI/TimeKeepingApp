import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/context/AuthContext";
import {
  useProjects,
  useSubcontractors,
  addDays,
} from "@/lib/referenceData";
import { humanizeError } from "@/lib/problem";

// Admin creates empty field-timesheet "shells" for a range of days. Each
// shell lands as kind='field', status='open', submitter_user_id=null —
// foremen see them in the "Open field timesheets" section of the list and
// claim via claim_field_timesheet.
//
// Bulk-by-day-range is the realistic workflow: an admin kicks off Monday
// morning creating shells for Mon→Fri on every active silo.

type CreatedRow = {
  id: string;
  period_start: string;
  project_number: string;
  sub_short_code: string;
};

export function NewFieldTimesheet() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { claims } = useAuth();
  const tenantId = claims.tenantId;

  const projects = useProjects();
  const subs = useSubcontractors();

  const today = new Date().toISOString().slice(0, 10);
  const [projectId, setProjectId] = useState("");
  const [subId, setSubId] = useState("");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [banner, setBanner] = useState<
    | { kind: "info"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);
  const [created, setCreated] = useState<CreatedRow[]>([]);

  const create = useMutation({
    mutationFn: async () => {
      if (!tenantId) throw new Error("No tenant in session");
      if (!projectId || !subId) throw new Error("Pick a project and sub first.");
      if (startDate > endDate) throw new Error("End date must be on or after start date.");

      const days: string[] = [];
      let d = startDate;
      while (d <= endDate) {
        days.push(d);
        d = addDays(d, 1);
      }
      if (days.length > 14) {
        throw new Error(
          `Range is ${days.length} days — limit is 14 per batch. Pick a narrower window.`,
        );
      }

      const rowsToInsert = days.map((date) => ({
        tenant_id: tenantId,
        kind: "field",
        status: "open",
        submitter_user_id: null,
        project_id: projectId,
        subcontractor_id: subId,
        period_start: date,
        period_end: date,
      }));
      const { data, error } = await supabase
        .from("timesheets")
        .insert(rowsToInsert)
        .select("id, period_start");
      if (error) throw error;

      const project = projects.data?.find((p) => p.id === projectId);
      const sub = subs.data?.find((s) => s.id === subId);
      return ((data ?? []) as { id: string; period_start: string }[]).map((row) => ({
        id: row.id,
        period_start: row.period_start,
        project_number: project?.number ?? "",
        sub_short_code: sub?.short_code ?? "",
      }));
    },
    onSuccess: (rows) => {
      setCreated(rows);
      setBanner({
        kind: "info",
        text: `Created ${rows.length} open field timesheet${rows.length === 1 ? "" : "s"}.`,
      });
      qc.invalidateQueries({ queryKey: ["timesheets_list"] });
    },
    onError: (err) => {
      setBanner({ kind: "error", text: humanizeError(err) });
    },
  });

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">New field timesheet shells</h1>
            <p className="text-xs text-ink-muted">
              Admin pre-creates empty shells for foremen to claim.
            </p>
          </div>
          <Link to="/timesheets" className="invenio-btn-secondary">
            Back
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-6 flex flex-col gap-4">
        {banner && (
          <div
            role={banner.kind === "error" ? "alert" : "status"}
            className={
              banner.kind === "error"
                ? "rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-sm text-danger-deep"
                : "rounded-md bg-success-soft border border-success/40 px-3 py-2 text-sm text-success-deep"
            }
          >
            {banner.text}
          </div>
        )}

        <form
          className="invenio-card flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setBanner(null);
            setCreated([]);
            create.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="nf-project" className="invenio-label">Project</label>
              <select
                id="nf-project"
                className="invenio-input"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="">— pick a project —</option>
                {(projects.data ?? [])
                  .filter((p) => p.active)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.number} · {p.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="nf-sub" className="invenio-label">Subcontractor</label>
              <select
                id="nf-sub"
                className="invenio-input"
                value={subId}
                onChange={(e) => setSubId(e.target.value)}
              >
                <option value="">— pick a sub —</option>
                {(subs.data ?? [])
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.short_code} · {s.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="nf-start" className="invenio-label">First day</label>
              <input
                id="nf-start"
                type="date"
                className="invenio-input"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="nf-end" className="invenio-label">Last day</label>
              <input
                id="nf-end"
                type="date"
                className="invenio-input"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
              <p className="text-xs text-ink-muted mt-1">
                Inclusive. Max 14 days per batch.
              </p>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              className="invenio-btn-primary"
              disabled={create.isPending || !projectId || !subId}
            >
              {create.isPending ? "Creating…" : "Create shells"}
            </button>
          </div>
        </form>

        {created.length > 0 && (
          <div className="invenio-card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-raised text-ink-muted text-left text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Project</th>
                  <th className="px-4 py-2 font-medium">Sub</th>
                  <th className="px-4 py-2 font-medium text-right">Open</th>
                </tr>
              </thead>
              <tbody>
                {created.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-2 font-mono">{r.period_start}</td>
                    <td className="px-4 py-2">{r.project_number}</td>
                    <td className="px-4 py-2 font-mono text-xs">{r.sub_short_code}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        className="text-brand hover:underline text-xs"
                        onClick={() => navigate(`/timesheets/field/${r.id}`)}
                      >
                        Open →
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
