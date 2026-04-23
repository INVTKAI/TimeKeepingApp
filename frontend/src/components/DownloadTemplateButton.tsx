import { Download } from "lucide-react";
import {
  buildDirectCsv,
  downloadText,
  type DirectTemplate,
} from "@/lib/importTemplates";
import { useTenantCtx } from "@/lib/useTenantCtx";

// One-click download of a CSV template for a given direct-CRUD table. Used
// on admin pages (Employees, Projects, Codes…) as a small "Template" button
// next to the primary add action. Users hand the filled-out CSV back to the
// admin for bulk SQL loading — there's no in-app upload endpoint for these
// tables yet.

export function DownloadTemplateButton({
  table,
  label = "Template",
  size = "sm",
}: {
  table: DirectTemplate;
  label?: string;
  size?: "sm" | "md";
}) {
  const ctx = useTenantCtx();
  const cls =
    size === "sm"
      ? "invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
      : "invenio-btn-secondary";
  return (
    <button
      type="button"
      className={cls}
      disabled={!ctx}
      title={
        !ctx
          ? "Loading reference data…"
          : `Download ${table} CSV template with example rows`
      }
      onClick={() => {
        if (!ctx) return;
        downloadText(
          `template-${table}.csv`,
          buildDirectCsv(table, ctx),
          "text/csv",
        );
      }}
    >
      <Download size={14} aria-hidden />
      {label}
    </button>
  );
}
