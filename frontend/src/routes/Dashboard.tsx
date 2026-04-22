import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";

// First-pass dashboard — lists the caller's pending approval runs via the
// `my_pending_approvals` RPC (backend §8). Approve / reject UI lands in a
// follow-on; this screen just proves the wiring end-to-end.

type PendingApproval = {
  run_id: string;
  timesheet_id: string;
  flow_name: string;
  node_name: string;
  node_ordinal: number;
  version: number;
  opened_at: string;
  submitter_username: string | null;
  project_number: string | null;
  project_name: string | null;
  period_start: string;
  period_end: string;
};

export function Dashboard() {
  const { claims, signOut } = useAuth();

  const { data, error, isLoading } = useQuery<PendingApproval[]>({
    queryKey: ["my_pending_approvals"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_pending_approvals");
      if (error) throw error;
      return (data ?? []) as PendingApproval[];
    },
    refetchInterval: 30_000,
  });

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Invenio Timekeeping</h1>
            <p className="text-xs text-ink-muted font-mono">
              {claims.username ?? "—"} · {claims.appRole ?? "—"} · tenant {claims.tenantId?.slice(0, 8) ?? "—"}
            </p>
          </div>
          <button onClick={signOut} className="invenio-btn-secondary">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 flex flex-col gap-6">
        <section>
          <h2 className="text-h2 font-semibold mb-4">My pending approvals</h2>

          {isLoading && (
            <div className="invenio-card">
              <p className="text-ink-muted">Loading…</p>
            </div>
          )}

          {error && (
            <div className="invenio-card border-danger/40 bg-danger-soft">
              <p className="text-danger-deep">
                Failed to load: {error instanceof Error ? error.message : String(error)}
              </p>
            </div>
          )}

          {data && data.length === 0 && (
            <div className="invenio-card">
              <p className="text-ink-muted">Nothing to approve right now.</p>
            </div>
          )}

          {data && data.length > 0 && (
            <ul className="flex flex-col gap-3">
              {data.map((row) => (
                <li key={row.run_id} className="invenio-card flex flex-col gap-2">
                  <div className="flex items-baseline justify-between gap-4">
                    <div>
                      <h3 className="font-medium text-ink-primary">
                        {row.project_name ?? "—"}{" "}
                        <span className="text-ink-muted font-mono text-sm">
                          {row.project_number ?? ""}
                        </span>
                      </h3>
                      <p className="text-sm text-ink-muted">
                        {row.flow_name} · node {row.node_ordinal}: {row.node_name}
                      </p>
                    </div>
                    <div className="text-right text-sm text-ink-muted font-mono">
                      {row.period_start} → {row.period_end}
                    </div>
                  </div>
                  <div className="text-sm text-ink-muted">
                    Submitted by{" "}
                    <span className="font-mono">{row.submitter_username ?? "—"}</span>{" "}
                    · opened {new Date(row.opened_at).toLocaleString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
