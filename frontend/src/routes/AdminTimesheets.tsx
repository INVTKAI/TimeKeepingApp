import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import {
  useProjects,
  useSubcontractors,
} from "@/lib/referenceData";
import { Banner, PageHeader } from "@/components/PageHeader";

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

type UserSlim = { id: string; username: string };

const STATUSES: TimesheetRow["status"][] = [
  "open",
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "recalled",
];

export function AdminTimesheets() {
  const { data: projects } = useProjects();
  const { data: subs } = useSubcontractors();

  const [filterKind, setFilterKind] = useState<"" | "staff" | "field">("");
  const [filterStatus, setFilterStatus] = useState<"" | TimesheetRow["status"]>(
    "",
  );
  const [filterProject, setFilterProject] = useState("");
  const [filterSub, setFilterSub] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const { data, isLoading, error } = useQuery<TimesheetRow[]>({
    queryKey: [
      "admin_timesheets",
      filterKind,
      filterStatus,
      filterProject,
      filterSub,
      filterFrom,
      filterTo,
    ],
    queryFn: async () => {
      let q = supabase
        .from("timesheets")
        .select(
          "id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, created_at",
        )
        .order("period_start", { ascending: false })
        .limit(500);
      if (filterKind) q = q.eq("kind", filterKind);
      if (filterStatus) q = q.eq("status", filterStatus);
      if (filterProject) q = q.eq("project_id", filterProject);
      if (filterSub) q = q.eq("subcontractor_id", filterSub);
      if (filterFrom) q = q.gte("period_start", filterFrom);
      if (filterTo) q = q.lte("period_start", filterTo);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TimesheetRow[];
    },
  });

  const submitterIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of data ?? []) if (r.submitter_user_id) set.add(r.submitter_user_id);
    return Array.from(set);
  }, [data]);

  const { data: submitters } = useQuery<UserSlim[]>({
    queryKey: ["admin_timesheets_submitters", submitterIds.join(",")],
    enabled: submitterIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, username")
        .in("id", submitterIds);
      if (error) throw error;
      return (data ?? []) as UserSlim[];
    },
  });

  const submitterLabel = (id: string | null) => {
    if (!id) return "—";
    const u = submitters?.find((x) => x.id === id);
    return u ? u.username : id.slice(0, 8);
  };
  const projectLabel = (id: string) => {
    const p = projects?.find((x) => x.id === id);
    return p ? `${p.number} · ${p.name}` : id.slice(0, 8);
  };
  const subLabel = (id: string) => {
    const s = subs?.find((x) => x.id === id);
    return s ? s.short_code : id.slice(0, 6);
  };

  return (
    <div className="invenio-page">
      <PageHeader
        title="Manage Timesheets"
        subtitle="Tenant-wide timesheet list with filters."
        actions={
          <Link
            to="/timesheets/field/new"
            className="invenio-btn-primary"
          >
            + Field shells
          </Link>
        }
      />

      <div className="invenio-card">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div>
            <label className="invenio-label">Kind</label>
            <select
              className="invenio-input"
              value={filterKind}
              onChange={(e) => setFilterKind(e.target.value as "" | "staff" | "field")}
            >
              <option value="">Any</option>
              <option value="staff">staff</option>
              <option value="field">field</option>
            </select>
          </div>
          <div>
            <label className="invenio-label">Status</label>
            <select
              className="invenio-input"
              value={filterStatus}
              onChange={(e) =>
                setFilterStatus(e.target.value as "" | TimesheetRow["status"])
              }
            >
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
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
          <div>
            <label className="invenio-label">From</label>
            <input
              type="date"
              className="invenio-input"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="invenio-label">To</label>
            <input
              type="date"
              className="invenio-input"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
            />
          </div>
        </div>
      </div>

      {isLoading && <p className="text-ink-muted">Loading…</p>}
      {error && <Banner kind="error">{String(error)}</Banner>}

      {data && data.length === 0 && !isLoading && (
        <div className="invenio-card">
          <p className="text-ink-muted">No timesheets match these filters.</p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="invenio-card p-0 overflow-hidden">
          <table className="invenio-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Submitter</th>
                <th>Project</th>
                <th>Sub</th>
                <th>Period</th>
                <th className="text-right">Open</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">{r.kind}</td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                  <td className="font-mono text-xs">
                    {submitterLabel(r.submitter_user_id)}
                  </td>
                  <td>{projectLabel(r.project_id)}</td>
                  <td className="font-mono text-xs">{subLabel(r.subcontractor_id)}</td>
                  <td className="font-mono text-xs">
                    {r.period_start}
                    {r.period_start !== r.period_end && ` → ${r.period_end}`}
                  </td>
                  <td className="text-right">
                    <Link
                      to={
                        r.kind === "staff"
                          ? `/timesheets/staff/${r.id}`
                          : `/timesheets/field/${r.id}`
                      }
                      className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.length === 500 && (
            <p className="text-xs text-ink-muted px-4 py-2 bg-raised">
              Showing 500 most-recent. Narrow your filters to see older timesheets.
            </p>
          )}
        </div>
      )}
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
