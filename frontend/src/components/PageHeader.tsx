import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="invenio-page-header">
      <div>
        <h1 className="invenio-page-title">{title}</h1>
        {subtitle && <p className="invenio-page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: "info" | "error" | "success" | "warn";
  children: ReactNode;
}) {
  const cls =
    kind === "error"
      ? "bg-danger-soft border-danger/40 text-danger-deep"
      : kind === "success"
        ? "bg-success-soft border-success/40 text-success-deep"
        : kind === "warn"
          ? "bg-warn-soft border-warn/40 text-warn-deep"
          : "bg-brand-soft border-brand/40 text-brand-hover";
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`rounded-md border px-3 py-2 text-sm ${cls}`}
    >
      {children}
    </div>
  );
}
