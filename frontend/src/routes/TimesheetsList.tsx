import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  mondayOf,
  useMyPublicUser,
  useProjects,
  useSubcontractors,
} from "@/lib/referenceData";
import { useClaimField } from "@/lib/mutations";
import { humanizeError } from "@/lib/problem";
import { Modal } from "@/components/Modal";

type TimesheetRow = {
  id: string;
  kind: "staff" | "field";
  status:
    | "open"
    | "draft"
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
  created_at: string;
};

export function TimesheetsList() {
  const { user, claims } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const userId = user?.id ?? null;
  const { data: me } = useMyPublicUser();
  const { data: projects } = useProjects();
  const { data: subs } = useSubcontractors();

  const [newWeekOpen, setNewWeekOpen] = useState(false);
  const [banner, setBanner] = useState<
    | { kind: "info"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);

  const { data, isLoading, error } = useQuery<TimesheetRow[]>({
    queryKey: ["timesheets_list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("timesheets")
        .select(
          "id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, created_at",
        )
        .order("period_start", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TimesheetRow[];
    },
  });

  const { myStaff, myField, openField } = useMemo(() => {
    const rows = data ?? [];
    const myStaff: TimesheetRow[] = [];
    const myField: TimesheetRow[] = [];
    const openField: TimesheetRow[] = [];
    for (const row of rows) {
      if (row.kind === "staff") {
        // Staff visible if I submitted OR I'm the employee on it. Both cases
        // should show up here.
        myStaff.push(row);
      } else {
        if (row.status === "open") openField.push(row);
        else if (row.submitter_user_id === userId) myField.push(row);
      }
    }
    return { myStaff, myField, openField };
  }, [data, userId]);

  const claim = useClaimField();

  const handleClaim = async (id: string) => {
    setBanner(null);
    try {
      await claim.mutateAsync({ timesheet_id: id });
      setBanner({ kind: "info", text: "Claimed — opening editor…" });
      navigate(`/timesheets/field/${id}`);
    } catch (err) {
      setBanner({ kind: "error", text: humanizeError(err) });
    }
  };

  const createStaffWeek = useMutation({
    mutationFn: async (input: { weekStart: string; projectId: string; subId: string }) => {
      if (!me?.employee_id) {
        throw new Error(
          "Your user has no employee_id set — only users linked to an employee can submit staff timesheets.",
        );
      }
      const weekEnd = new Date(input.weekStart + "T00:00:00");
      weekEnd.setDate(weekEnd.getDate() + 6);
      const { data, error } = await supabase
        .from("timesheets")
        .insert({
          kind: "staff",
          status: "draft",
          submitter_user_id: userId,
          employee_id: me.employee_id,
          project_id: input.projectId,
          subcontractor_id: input.subId,
          period_start: input.weekStart,
          period_end: weekEnd.toISOString().slice(0, 10),
        })
        .select("id")
        .single();
      if (error) throw error;
      return data as { id: string };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["timesheets_list"] });
      navigate(`/timesheets/staff/${data.id}`);
    },
  });

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Timesheets</h1>
            <p className="text-xs text-ink-muted font-mono">
              {claims.username ?? "—"} · {claims.appRole ?? "—"}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="invenio-btn-primary"
              onClick={() => setNewWeekOpen(true)}
              disabled={!me?.employee_id}
              title={
                !me?.employee_id
                  ? "Your account is not linked to an employee — ask an admin"
                  : undefined
              }
            >
              New staff week…
            </button>
            {claims.appRole === "admin" && (
              <Link to="/timesheets/field/new" className="invenio-btn-secondary">
                + Field shells
              </Link>
            )}
            <Link to="/" className="invenio-btn-secondary">
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 flex flex-col gap-8">
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

        {isLoading && <p className="text-ink-muted">Loading…</p>}
        {error && (
          <div className="invenio-card border-danger/40 bg-danger-soft">
            <p className="text-danger-deep">{String(error)}</p>
          </div>
        )}

        <TimesheetSection
          title="My staff weeks"
          rows={myStaff}
          empty="No staff timesheets yet. Use 'New staff week…' above to start one."
          renderAction={(row) => (
            <Link to={`/timesheets/staff/${row.id}`} className="invenio-btn-secondary">
              Open
            </Link>
          )}
          projects={projects ?? []}
          subs={subs ?? []}
        />

        <TimesheetSection
          title="My field timesheets"
          rows={myField}
          empty="No claimed field timesheets."
          renderAction={(row) => (
            <Link to={`/timesheets/field/${row.id}`} className="invenio-btn-secondary">
              Open
            </Link>
          )}
          projects={projects ?? []}
          subs={subs ?? []}
        />

        <TimesheetSection
          title="Open field timesheets — available to claim"
          rows={openField}
          empty="No unclaimed field timesheets in your silos right now."
          renderAction={(row) => (
            <button
              className="invenio-btn-primary"
              onClick={() => handleClaim(row.id)}
              disabled={claim.isPending}
            >
              {claim.isPending ? "Claiming…" : "Claim"}
            </button>
          )}
          projects={projects ?? []}
          subs={subs ?? []}
        />
      </main>

      <NewStaffWeekModal
        open={newWeekOpen}
        onClose={() => setNewWeekOpen(false)}
        projects={projects ?? []}
        subs={subs ?? []}
        onSubmit={async (weekStart, projectId, subId) => {
          try {
            await createStaffWeek.mutateAsync({ weekStart, projectId, subId });
            setNewWeekOpen(false);
          } catch (err) {
            setBanner({ kind: "error", text: humanizeError(err) });
          }
        }}
      />
    </div>
  );
}

// ---- Section rendering -----------------------------------------------------

function TimesheetSection({
  title,
  rows,
  empty,
  renderAction,
  projects,
  subs,
}: {
  title: string;
  rows: TimesheetRow[];
  empty: string;
  renderAction: (row: TimesheetRow) => React.ReactNode;
  projects: { id: string; number: string; name: string }[];
  subs: { id: string; short_code: string; name: string }[];
}) {
  const projectLabel = (id: string) => {
    const p = projects.find((x) => x.id === id);
    return p ? `${p.number} · ${p.name}` : id.slice(0, 8);
  };
  const subLabel = (id: string) => {
    const s = subs.find((x) => x.id === id);
    return s ? s.short_code : id.slice(0, 6);
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      {rows.length === 0 ? (
        <div className="invenio-card">
          <p className="text-ink-muted">{empty}</p>
        </div>
      ) : (
        <div className="invenio-card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-raised text-ink-muted text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Sub</th>
                <th className="px-4 py-2 font-medium">Period</th>
                <th className="px-4 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">{r.kind}</td>
                  <td className="px-4 py-2">
                    <StatusChip status={r.status} />
                  </td>
                  <td className="px-4 py-2">{projectLabel(r.project_id)}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {subLabel(r.subcontractor_id)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {r.period_start}
                    {r.period_start !== r.period_end && ` → ${r.period_end}`}
                  </td>
                  <td className="px-4 py-2 text-right">{renderAction(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function StatusChip({ status }: { status: TimesheetRow["status"] }) {
  const cls =
    status === "approved"
      ? "bg-success-soft text-success-deep"
      : status === "rejected" || status === "recalled"
      ? "bg-danger-soft text-danger-deep"
      : status === "submitted" || status === "in_review"
      ? "bg-warn-soft text-warn-deep"
      : status === "open"
      ? "bg-brand-soft text-brand-hover"
      : "bg-raised text-ink-muted";
  return (
    <span className={`inline-block rounded-sm px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

// ---- New-week modal --------------------------------------------------------

function NewStaffWeekModal({
  open,
  onClose,
  projects,
  subs,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  projects: { id: string; number: string; name: string; active: boolean }[];
  subs: { id: string; short_code: string; name: string; active: boolean }[];
  onSubmit: (weekStart: string, projectId: string, subId: string) => void | Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [weekStart, setWeekStart] = useState(mondayOf(today));
  const [projectId, setProjectId] = useState("");
  const [subId, setSubId] = useState("");

  return (
    <Modal open={open} onClose={onClose} title="Start a new week">
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="nw-week" className="invenio-label">Week starting (Monday)</label>
          <input
            id="nw-week"
            type="date"
            className="invenio-input"
            value={weekStart}
            onChange={(e) => setWeekStart(mondayOf(e.target.value))}
          />
          <p className="text-xs text-ink-muted mt-1">Snaps to the Monday of the selected week.</p>
        </div>
        <div>
          <label htmlFor="nw-project" className="invenio-label">Primary project</label>
          <select
            id="nw-project"
            className="invenio-input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">— pick a project —</option>
            {projects.filter((p) => p.active).map((p) => (
              <option key={p.id} value={p.id}>{p.number} · {p.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="nw-sub" className="invenio-label">Subcontractor</label>
          <select
            id="nw-sub"
            className="invenio-input"
            value={subId}
            onChange={(e) => setSubId(e.target.value)}
          >
            <option value="">— pick a sub —</option>
            {subs.filter((s) => s.active).map((s) => (
              <option key={s.id} value={s.id}>{s.short_code} · {s.name}</option>
            ))}
          </select>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button className="invenio-btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="invenio-btn-primary"
            disabled={!projectId || !subId}
            onClick={() => onSubmit(weekStart, projectId, subId)}
          >
            Create week
          </button>
        </div>
      </div>
    </Modal>
  );
}
