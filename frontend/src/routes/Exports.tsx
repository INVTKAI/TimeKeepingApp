import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { downloadEdgeFunction, humanizeError } from "@/lib/problem";

// Admin-only labor export. Calls the export-labor Edge Function and streams
// the returned CSV or XLSX as a browser download. Includes status/project/sub
// filters as a follow-on — v1 is a date window + format only to prove the
// pipe end-to-end.

type Form = {
  from: string;
  to: string;
};

export function Exports() {
  const { session } = useAuth();
  const { register, handleSubmit, formState, watch } = useForm<Form>({
    defaultValues: {
      from: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    },
  });
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "working"; format: "csv" | "xlsx" }
    | { kind: "done"; filename: string; rows: number | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const values = watch();

  const run = async (format: "csv" | "xlsx") => {
    if (!session?.access_token) {
      setStatus({ kind: "error", message: "Not signed in." });
      return;
    }
    setStatus({ kind: "working", format });
    try {
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
      const { filename, rows } = await downloadEdgeFunction(
        supabaseUrl,
        "export-labor",
        { format, from: values.from, to: values.to },
        session.access_token,
        anonKey,
      );
      setStatus({ kind: "done", filename, rows });
    } catch (err) {
      setStatus({ kind: "error", message: humanizeError(err) });
    }
  };

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Labor export</h1>
            <p className="text-xs text-ink-muted font-mono">
              Admin only · exports timesheet_lines × employees × projects
            </p>
          </div>
          <Link to="/" className="invenio-btn-secondary">
            Back to dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-6 flex flex-col gap-6">
        <form
          onSubmit={handleSubmit(() => void 0)}
          className="invenio-card flex flex-col gap-4"
        >
          <div>
            <h2 className="text-xl font-semibold">Date range</h2>
            <p className="text-sm text-ink-muted mt-1">
              Pulls every non-zero ST and OT line with <span className="font-mono">date</span>{" "}
              between these bounds (inclusive). Default filter is submitted + in_review + approved
              — recalled, rejected, draft, and open timesheets are excluded.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="from" className="invenio-label">
                From
              </label>
              <input
                id="from"
                type="date"
                className="invenio-input"
                {...register("from", { required: true })}
              />
            </div>
            <div>
              <label htmlFor="to" className="invenio-label">
                To
              </label>
              <input
                id="to"
                type="date"
                className="invenio-input"
                {...register("to", { required: true })}
              />
            </div>
          </div>

          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <button
              type="button"
              className="invenio-btn-secondary"
              onClick={() => run("csv")}
              disabled={status.kind === "working" || !formState.isValid}
            >
              {status.kind === "working" && status.format === "csv"
                ? "Generating CSV…"
                : "Download CSV"}
            </button>
            <button
              type="button"
              className="invenio-btn-primary"
              onClick={() => run("xlsx")}
              disabled={status.kind === "working" || !formState.isValid}
            >
              {status.kind === "working" && status.format === "xlsx"
                ? "Generating XLSX…"
                : "Download XLSX"}
            </button>
          </div>
        </form>

        {status.kind === "done" && (
          <div
            role="status"
            className="rounded-md bg-success-soft border border-success/40 px-3 py-2 text-sm text-success-deep"
          >
            Downloaded <span className="font-mono">{status.filename}</span>
            {status.rows != null && ` · ${status.rows.toLocaleString()} rows`}
          </div>
        )}
        {status.kind === "error" && (
          <div
            role="alert"
            className="rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-sm text-danger-deep"
          >
            {status.message}
          </div>
        )}

        <section className="invenio-card">
          <h3 className="font-semibold mb-2">Heads-up about output shape</h3>
          <ul className="text-sm text-ink-muted list-disc pl-5 space-y-1">
            <li>
              Each timesheet line expands into up to two output rows — one for ST hours, one
              for OT — so a week with 40 ST + 6 OT becomes seven ST rows and one OT row.
            </li>
            <li>Zero-hour lines are suppressed in both paths.</li>
            <li>XLSX adds a <span className="font-mono">Summary by Project</span> sheet with ST/OT/Total aggregates.</li>
            <li>
              Filename encodes the window:{" "}
              <span className="font-mono">labor-export_YYYY-MM-DD_to_YYYY-MM-DD.csv</span>.
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
