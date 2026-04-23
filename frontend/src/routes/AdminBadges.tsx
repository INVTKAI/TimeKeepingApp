import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import {
  useEmployees,
  useProjects,
  useSubcontractors,
} from "@/lib/referenceData";
import { humanizeError } from "@/lib/problem";
import { Modal } from "@/components/Modal";
import { Banner, PageHeader } from "@/components/PageHeader";

type BadgeRow = {
  id: string;
  employee_id: string;
  date: string;
  project_id: string;
  subcontractor_id: string;
  submitted_hours_st: number;
  submitted_hours_ot: number;
  badge_hours_st: number;
  badge_hours_ot: number;
  reason: string | null;
  status:
    | "open"
    | "resolved_submitted_canonical"
    | "resolved_badge_canonical";
  opened_at: string;
  resolved_at: string | null;
  resolved_by_user_id: string | null;
};

export function AdminBadges() {
  const qc = useQueryClient();
  const [filterStatus, setFilterStatus] = useState<"open" | "resolved" | "all">(
    "open",
  );
  const [filterProject, setFilterProject] = useState("");
  const [filterSub, setFilterSub] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<BadgeRow | null>(null);
  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);

  const { data: projects } = useProjects();
  const { data: subs } = useSubcontractors();
  const { data: employees } = useEmployees();

  const { data, isLoading, error } = useQuery<BadgeRow[]>({
    queryKey: ["admin_badge_overrides", filterStatus, filterProject, filterSub],
    queryFn: async () => {
      let q = supabase
        .from("badge_overrides")
        .select(
          "id, employee_id, date, project_id, subcontractor_id, submitted_hours_st, submitted_hours_ot, badge_hours_st, badge_hours_ot, reason, status, opened_at, resolved_at, resolved_by_user_id",
        )
        .order("opened_at", { ascending: false })
        .limit(200);
      if (filterStatus === "open") q = q.eq("status", "open");
      else if (filterStatus === "resolved")
        q = q.neq("status", "open");
      if (filterProject) q = q.eq("project_id", filterProject);
      if (filterSub) q = q.eq("subcontractor_id", filterSub);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as BadgeRow[];
    },
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin_badge_overrides"] });

  const empLabel = (id: string) => {
    const e = employees?.find((x) => x.id === id);
    return e ? `${e.last_name}, ${e.first_name}` : id.slice(0, 8);
  };
  const projectLabel = (id: string) => {
    const p = projects?.find((x) => x.id === id);
    return p ? `${p.number}` : id.slice(0, 8);
  };
  const subLabel = (id: string) => {
    const s = subs?.find((x) => x.id === id);
    return s ? s.short_code : id.slice(0, 6);
  };

  return (
    <div className="invenio-page">
      <PageHeader
        title="Badge Overrides"
        subtitle="Retroactive badge-vs-submitted-hours reconciliation."
        actions={
          <button
            className="invenio-btn-primary"
            onClick={() => setCreateOpen(true)}
          >
            + New override
          </button>
        }
      />

      <div className="invenio-card">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="invenio-label">Status</label>
            <select
              className="invenio-input"
              value={filterStatus}
              onChange={(e) =>
                setFilterStatus(
                  e.target.value as "open" | "resolved" | "all",
                )
              }
            >
              <option value="open">Open only</option>
              <option value="resolved">Resolved only</option>
              <option value="all">All</option>
            </select>
          </div>
          <div>
            <label className="invenio-label">Project</label>
            <select
              className="invenio-input"
              value={filterProject}
              onChange={(e) => setFilterProject(e.target.value)}
            >
              <option value="">Any</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} · {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="invenio-label">Sub</label>
            <select
              className="invenio-input"
              value={filterSub}
              onChange={(e) => setFilterSub(e.target.value)}
            >
              <option value="">Any</option>
              {(subs ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.short_code}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}
      {isLoading && <p className="text-ink-muted">Loading…</p>}
      {error && <Banner kind="error">{String(error)}</Banner>}

      {data && data.length === 0 && !isLoading && (
        <div className="invenio-card">
          <p className="text-ink-muted">No badge overrides match these filters.</p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="invenio-card p-0 overflow-hidden">
          <table className="invenio-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee</th>
                <th>Project</th>
                <th>Sub</th>
                <th className="text-right">Submitted (ST/OT)</th>
                <th className="text-right">Badge (ST/OT)</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.date}</td>
                  <td>{empLabel(r.employee_id)}</td>
                  <td className="font-mono text-xs">
                    {projectLabel(r.project_id)}
                  </td>
                  <td className="font-mono text-xs">
                    {subLabel(r.subcontractor_id)}
                  </td>
                  <td className="text-right font-mono text-xs">
                    {Number(r.submitted_hours_st).toFixed(2)} /{" "}
                    {Number(r.submitted_hours_ot).toFixed(2)}
                  </td>
                  <td className="text-right font-mono text-xs">
                    {Number(r.badge_hours_st).toFixed(2)} /{" "}
                    {Number(r.badge_hours_ot).toFixed(2)}
                  </td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                  <td className="text-right">
                    {r.status === "open" ? (
                      <button
                        className="invenio-btn-primary text-xs !px-3 !py-1 !min-h-0"
                        onClick={() => setResolveTarget(r)}
                      >
                        Resolve…
                      </button>
                    ) : (
                      <span className="text-xs text-ink-muted">
                        {r.resolved_at
                          ? new Date(r.resolved_at).toLocaleDateString()
                          : ""}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {createOpen && (
        <CreateOverrideModal
          onClose={() => setCreateOpen(false)}
          onSuccess={() => {
            setCreateOpen(false);
            invalidate();
            setBanner({ kind: "info", text: "Override created." });
          }}
          onError={(err) =>
            setBanner({ kind: "error", text: humanizeError(err) })
          }
        />
      )}

      {resolveTarget && (
        <ResolveOverrideModal
          row={resolveTarget}
          onClose={() => setResolveTarget(null)}
          onSuccess={() => {
            setResolveTarget(null);
            invalidate();
            setBanner({ kind: "info", text: "Override resolved." });
          }}
          onError={(err) =>
            setBanner({ kind: "error", text: humanizeError(err) })
          }
        />
      )}
    </div>
  );
}

function StatusChip({ status }: { status: BadgeRow["status"] }) {
  const cls =
    status === "open"
      ? "bg-warn-soft text-warn-deep"
      : "bg-success-soft text-success-deep";
  const label =
    status === "open"
      ? "open"
      : status === "resolved_submitted_canonical"
        ? "submitted canonical"
        : "badge canonical";
  return <span className={`invenio-chip ${cls}`}>{label}</span>;
}

// ---- Create override modal ------------------------------------------------

type CreateForm = {
  employee_id: string;
  date: string;
  project_id: string;
  subcontractor_id: string;
  submitted_hours_st: string;
  submitted_hours_ot: string;
  badge_hours_st: string;
  badge_hours_ot: string;
};

function CreateOverrideModal({
  onClose,
  onSuccess,
  onError,
}: {
  onClose: () => void;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}) {
  const { data: projects } = useProjects();
  const { data: subs } = useSubcontractors();
  const { data: employees } = useEmployees();
  const [empSearch, setEmpSearch] = useState("");
  const { register, handleSubmit, formState, watch } = useForm<CreateForm>({
    defaultValues: {
      date: new Date().toISOString().slice(0, 10),
      submitted_hours_st: "0",
      submitted_hours_ot: "0",
      badge_hours_st: "0",
      badge_hours_ot: "0",
    },
  });

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    const all = (employees ?? []).filter((e) => e.active);
    if (!q) return all.slice(0, 100);
    return all
      .filter((e) =>
        `${e.first_name} ${e.last_name}`.toLowerCase().includes(q),
      )
      .slice(0, 100);
  }, [employees, empSearch]);

  const create = useMutation({
    mutationFn: async (v: CreateForm) => {
      const { error, data } = await supabase.rpc("create_badge_override", {
        p_employee_id: v.employee_id,
        p_date: v.date,
        p_project_id: v.project_id,
        p_subcontractor_id: v.subcontractor_id,
        p_submitted_hours_st: Number(v.submitted_hours_st),
        p_submitted_hours_ot: Number(v.submitted_hours_ot),
        p_badge_hours_st: Number(v.badge_hours_st),
        p_badge_hours_ot: Number(v.badge_hours_ot),
      });
      if (error) throw error;
      return data;
    },
    onSuccess,
    onError,
  });

  const subId = watch("subcontractor_id");

  return (
    <Modal open onClose={onClose} title="New badge override">
      <form
        className="flex flex-col gap-3"
        onSubmit={handleSubmit((v) => create.mutate(v))}
      >
        <div>
          <label className="invenio-label">Search employees</label>
          <input
            className="invenio-input"
            placeholder="Type a name…"
            value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)}
          />
        </div>
        <div>
          <label className="invenio-label">Employee</label>
          <select
            className="invenio-input"
            {...register("employee_id", { required: true })}
          >
            <option value="">— pick an employee —</option>
            {filteredEmployees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.last_name}, {e.first_name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="invenio-label">Date</label>
            <input
              type="date"
              className="invenio-input"
              {...register("date", { required: true })}
            />
          </div>
          <div>
            <label className="invenio-label">Project</label>
            <select
              className="invenio-input"
              {...register("project_id", { required: true })}
            >
              <option value="">— pick —</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="invenio-label">Sub</label>
            <select
              className="invenio-input"
              {...register("subcontractor_id", { required: true })}
            >
              <option value="">— pick —</option>
              {(subs ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.short_code}
                </option>
              ))}
            </select>
            {!subId && (
              <p className="text-xs text-ink-muted mt-1">Required.</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
          <div>
            <p className="text-sm font-medium text-ink-primary mb-1">
              Submitted hours
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="invenio-label !text-xs">ST</label>
                <input
                  type="number"
                  step="0.25"
                  className="invenio-input"
                  {...register("submitted_hours_st")}
                />
              </div>
              <div>
                <label className="invenio-label !text-xs">OT</label>
                <input
                  type="number"
                  step="0.25"
                  className="invenio-input"
                  {...register("submitted_hours_ot")}
                />
              </div>
            </div>
          </div>
          <div>
            <p className="text-sm font-medium text-ink-primary mb-1">
              Badge hours
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="invenio-label !text-xs">ST</label>
                <input
                  type="number"
                  step="0.25"
                  className="invenio-input"
                  {...register("badge_hours_st")}
                />
              </div>
              <div>
                <label className="invenio-label !text-xs">OT</label>
                <input
                  type="number"
                  step="0.25"
                  className="invenio-input"
                  {...register("badge_hours_ot")}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            className="invenio-btn-secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="invenio-btn-primary"
            disabled={formState.isSubmitting}
          >
            {formState.isSubmitting ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Resolve override modal -----------------------------------------------

function ResolveOverrideModal({
  row,
  onClose,
  onSuccess,
  onError,
}: {
  row: BadgeRow;
  onClose: () => void;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}) {
  const [outcome, setOutcome] = useState<
    "resolved_submitted_canonical" | "resolved_badge_canonical"
  >("resolved_submitted_canonical");
  const [reason, setReason] = useState("");

  const resolve = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("resolve_badge_override", {
        p_override_id: row.id,
        p_outcome: outcome,
        p_reason: reason,
      });
      if (error) throw error;
    },
    onSuccess,
    onError,
  });

  return (
    <Modal open onClose={onClose} title="Resolve badge override">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          Pick the canonical source. If the override was created from a
          submitted timesheet line, resolving as badge-canonical will cascade
          to that line's parent run (see spec §7.7).
        </p>

        <div>
          <label className="invenio-label">Outcome</label>
          <div className="flex flex-col gap-2">
            <label className="flex items-start gap-2 border border-border rounded-md p-3 cursor-pointer hover:bg-raised">
              <input
                type="radio"
                name="outcome"
                checked={outcome === "resolved_submitted_canonical"}
                onChange={() => setOutcome("resolved_submitted_canonical")}
              />
              <div>
                <div className="font-medium text-sm">
                  Submitted is canonical
                </div>
                <div className="text-xs text-ink-muted">
                  Accept submitted hours ({Number(row.submitted_hours_st).toFixed(2)} ST / {Number(row.submitted_hours_ot).toFixed(2)} OT). No hours change.
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 border border-border rounded-md p-3 cursor-pointer hover:bg-raised">
              <input
                type="radio"
                name="outcome"
                checked={outcome === "resolved_badge_canonical"}
                onChange={() => setOutcome("resolved_badge_canonical")}
              />
              <div>
                <div className="font-medium text-sm">Badge is canonical</div>
                <div className="text-xs text-ink-muted">
                  Use badge hours ({Number(row.badge_hours_st).toFixed(2)} ST / {Number(row.badge_hours_ot).toFixed(2)} OT). May reopen parent run.
                </div>
              </div>
            </label>
          </div>
        </div>

        <div>
          <label className="invenio-label">Reason (required)</label>
          <textarea
            className="invenio-input min-h-[80px] py-2"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <button
            className="invenio-btn-secondary"
            onClick={onClose}
            disabled={resolve.isPending}
          >
            Cancel
          </button>
          <button
            className="invenio-btn-primary"
            onClick={() => resolve.mutate()}
            disabled={resolve.isPending || !reason.trim()}
          >
            {resolve.isPending ? "Resolving…" : "Resolve"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
