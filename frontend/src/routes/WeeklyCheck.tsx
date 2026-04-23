import { useState } from "react";
import { Link } from "react-router-dom";
import { mondayOf } from "@/lib/referenceData";
import { PageHeader } from "@/components/PageHeader";

export function WeeklyCheck() {
  const today = new Date().toISOString().slice(0, 10);
  const [weekStart, setWeekStart] = useState(mondayOf(today));

  return (
    <div className="invenio-page">
      <PageHeader
        title="Weekly Check"
        subtitle="Reconcile badge-records with entered timesheet hours."
      />

      <div className="invenio-card flex flex-col gap-3">
        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="invenio-label">Week starting (Monday)</label>
            <input
              type="date"
              className="invenio-input"
              value={weekStart}
              onChange={(e) => setWeekStart(mondayOf(e.target.value))}
            />
          </div>
        </div>

        <div className="rounded-md bg-warn-soft border border-warn/40 px-4 py-3 text-sm text-warn-deep">
          <p className="font-medium mb-2">
            Badge reconciliation is deferred in v1.
          </p>
          <p>
            The backend currently has no <span className="font-mono">badge_records</span> table —
            the spec parks the data-shape decision on the customer. Until then,
            the Weekly Check view doesn't have real data to reconcile against.
          </p>
          <p className="mt-2">
            In the meantime, admins can manage one-off discrepancies in the{" "}
            <Link to="/admin/badges" className="underline">Badge Overrides</Link> page
            using the <span className="font-mono">create_badge_override</span> +{" "}
            <span className="font-mono">resolve_badge_override</span> RPCs (spec §7.7).
          </p>
        </div>
      </div>
    </div>
  );
}
