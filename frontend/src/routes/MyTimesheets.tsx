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
import { humanizeError } from "@/lib/problem";
import { Modal } from "@/components/Modal";
import { Banner, PageHeader } from "@/components/PageHeader";

// "My Timesheet" — personal staff-week list. Field timesheets now live on
// their own page at /field-timesheets.

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

export function MyTimesheets() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const userId = user?.id ?? null;
  const { data: me } = useMyPublicUser();
  const { data: projects } = useProjects();
  const { data: subs } = useSubcontractors();

  const [newWeekOpen, setNewWeekOpen] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);

  const { data, isLoading, error } = useQuery<TimesheetRow[]>({
    queryKey: ["my_timesheets_staff"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("timesheets")
        .select(
          "id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, created_at",
        )
        .eq("kind", "staff")
        .order("period_start", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TimesheetRow[];
    },
  });

  const createStaffWeek = useMutation({
    mutationFn: async (input: {
      weekStart: string;
      projectId: string;
      subId: string;
    }) => {
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
      qc.invalidateQueries({ queryKey: ["my_timesheets_staff"] });
      navigate(`/timesheets/staff/${data.id}`);
    },
  });

  const rows = useMemo(() => data ?? [], [data]);

  return (
    <div className="invenio-page">
      <PageHeader
        title="My Timesheet"
        subtitle="Personal staff-week timesheets."
        actions={
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
        }
      />
      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

      {isLoading && <p className="text-ink-muted">Loading…</p>}
      {error && (
        <Banner kind="error">{String(error)}</Banner>
      )}

      <TimesheetSection
        rows={rows}
        empty="No staff timesheets yet. Use 'New staff week…' to start one."
        projects={projects ?? []}
        subs={subs ?? []}
        renderAction={(row) => (
          <Link
            to={`/timesheets/staff/${row.id}`}
            className="invenio-btn-secondary"
          >
            Open
          </Link>
        )}
      />

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

function TimesheetSection({
  rows,
  empty,
  renderAction,
  projects,
  subs,
}: {
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
  if (rows.length === 0) {
    return (
      <div className="invenio-card">
        <p className="text-ink-muted">{empty}</p>
      </div>
    );
  }
  return (
    <div className="invenio-card p-0 overflow-hidden">
      <table className="invenio-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Project</th>
            <th>Sub</th>
            <th>Period</th>
            <th className="text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <StatusChip status={r.status} />
              </td>
              <td>{projectLabel(r.project_id)}</td>
              <td className="font-mono text-xs">{subLabel(r.subcontractor_id)}</td>
              <td className="font-mono text-xs">
                {r.period_start}
                {r.period_start !== r.period_end && ` → ${r.period_end}`}
              </td>
              <td className="text-right">{renderAction(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
  return <span className={`invenio-chip ${cls}`}>{status}</span>;
}

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
  onSubmit: (
    weekStart: string,
    projectId: string,
    subId: string,
  ) => void | Promise<void>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [weekStart, setWeekStart] = useState(mondayOf(today));
  const [projectId, setProjectId] = useState("");
  const [subId, setSubId] = useState("");

  return (
    <Modal open={open} onClose={onClose} title="Start a new week">
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="nw-week" className="invenio-label">
            Week starting (Monday)
          </label>
          <input
            id="nw-week"
            type="date"
            className="invenio-input"
            value={weekStart}
            onChange={(e) => setWeekStart(mondayOf(e.target.value))}
          />
          <p className="text-xs text-ink-muted mt-1">
            Snaps to the Monday of the selected week.
          </p>
        </div>
        <div>
          <label htmlFor="nw-project" className="invenio-label">
            Primary project
          </label>
          <select
            id="nw-project"
            className="invenio-input"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">— pick a project —</option>
            {projects
              .filter((p) => p.active)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} · {p.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor="nw-sub" className="invenio-label">
            Subcontractor
          </label>
          <select
            id="nw-sub"
            className="invenio-input"
            value={subId}
            onChange={(e) => setSubId(e.target.value)}
          >
            <option value="">— pick a sub —</option>
            {subs
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.short_code} · {s.name}
                </option>
              ))}
          </select>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button className="invenio-btn-secondary" onClick={onClose}>
            Cancel
          </button>
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
