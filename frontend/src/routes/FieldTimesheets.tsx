import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { useProjects, useSubcontractors } from "@/lib/referenceData";
import { useClaimField } from "@/lib/mutations";
import { humanizeError } from "@/lib/problem";
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

export function FieldTimesheets() {
  const { user, claims } = useAuth();
  const navigate = useNavigate();
  const userId = user?.id ?? null;
  const { data: projects } = useProjects();
  const { data: subs } = useSubcontractors();

  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);

  const { data, isLoading, error } = useQuery<TimesheetRow[]>({
    queryKey: ["field_timesheets_list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("timesheets")
        .select(
          "id, kind, status, submitter_user_id, employee_id, project_id, subcontractor_id, period_start, period_end, created_at",
        )
        .eq("kind", "field")
        .order("period_start", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TimesheetRow[];
    },
  });

  const { claimed, open } = useMemo(() => {
    const rows = data ?? [];
    const claimed: TimesheetRow[] = [];
    const open: TimesheetRow[] = [];
    for (const row of rows) {
      if (row.status === "open") open.push(row);
      else if (row.submitter_user_id === userId) claimed.push(row);
    }
    return { claimed, open };
  }, [data, userId]);

  const claim = useClaimField();

  const handleClaim = async (id: string) => {
    setBanner(null);
    try {
      await claim.mutateAsync({ timesheet_id: id });
      navigate(`/timesheets/field/${id}`);
    } catch (err) {
      setBanner({ kind: "error", text: humanizeError(err) });
    }
  };

  return (
    <div className="invenio-page">
      <PageHeader
        title="Field Timesheets"
        subtitle="Crew day-sheets you can claim or continue working on."
        actions={
          claims.appRole === "admin" && (
            <Link
              to="/timesheets/field/new"
              className="invenio-btn-secondary"
            >
              + Field shells
            </Link>
          )
        }
      />
      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

      {isLoading && <p className="text-ink-muted">Loading…</p>}
      {error && <Banner kind="error">{String(error)}</Banner>}

      <Section
        title="Claimed by me"
        rows={claimed}
        empty="No claimed field timesheets."
        projects={projects ?? []}
        subs={subs ?? []}
        renderAction={(row) => (
          <Link to={`/timesheets/field/${row.id}`} className="invenio-btn-secondary">
            Open
          </Link>
        )}
      />

      <Section
        title="Open — available to claim"
        rows={open}
        empty="No unclaimed field timesheets in your silos right now."
        projects={projects ?? []}
        subs={subs ?? []}
        renderAction={(row) => (
          <button
            className="invenio-btn-primary"
            onClick={() => handleClaim(row.id)}
            disabled={claim.isPending}
          >
            {claim.isPending ? "Claiming…" : "Claim"}
          </button>
        )}
      />
    </div>
  );
}

function Section({
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
          <table className="invenio-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Project</th>
                <th>Sub</th>
                <th>Date</th>
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
                  <td className="font-mono text-xs">{r.period_start}</td>
                  <td className="text-right">{renderAction(r)}</td>
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
  return <span className={`invenio-chip ${cls}`}>{status}</span>;
}
