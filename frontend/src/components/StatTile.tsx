import type { ReactNode } from "react";

// Uppercase-label + big-number tile per InvenioStyle's stat-tile recipe.
// Used on the dashboard and Weekly Check for at-a-glance counters.

type Props = {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "success" | "warn" | "danger" | "brand";
};

export function StatTile({ label, value, hint, tone = "neutral" }: Props) {
  const valueCls =
    tone === "success"
      ? "text-success-deep"
      : tone === "warn"
        ? "text-warn-deep"
        : tone === "danger"
          ? "text-danger-deep"
          : tone === "brand"
            ? "text-brand"
            : "text-ink-primary";
  return (
    <div className="invenio-card !p-4 min-w-[150px] flex-1">
      <p className="text-xs uppercase tracking-wide text-ink-subtle font-semibold">
        {label}
      </p>
      <p className={`text-h2 font-semibold leading-tight ${valueCls}`}>
        {value}
      </p>
      {hint && <p className="text-xs text-ink-muted mt-1">{hint}</p>}
    </div>
  );
}
