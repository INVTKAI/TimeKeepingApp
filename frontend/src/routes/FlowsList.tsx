import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Modal } from "@/components/Modal";
import { humanizeError } from "@/lib/problem";

// Lists approval flows for the tenant. Click a flow to edit its nodes +
// approvers. "+ New flow" creates a skeleton (one node) then routes into
// the editor for customization.

type FlowRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  created_at: string;
  node_count: number;
};

export function FlowsList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [newOpen, setNewOpen] = useState(false);
  const [banner, setBanner] = useState<
    | { kind: "info"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);

  const { data, isLoading, error } = useQuery<FlowRow[]>({
    queryKey: ["flows_list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("approval_flows")
        .select("id, name, description, active, created_at")
        .order("name");
      if (error) throw error;
      const flows = (data ?? []) as Omit<FlowRow, "node_count">[];
      if (flows.length === 0) return [];
      const { data: counts } = await supabase
        .from("approval_nodes")
        .select("flow_id")
        .in("id", flows.map(() => "").filter(Boolean) as string[])
        .neq("flow_id", "00000000-0000-0000-0000-000000000000");
      // Simpler: one query on approval_nodes for this tenant, group client-side.
      const { data: allNodes } = await supabase
        .from("approval_nodes")
        .select("flow_id")
        .in("flow_id", flows.map((f) => f.id));
      const byFlow = new Map<string, number>();
      for (const n of allNodes ?? []) {
        byFlow.set(n.flow_id, (byFlow.get(n.flow_id) ?? 0) + 1);
      }
      void counts;
      return flows.map((f) => ({ ...f, node_count: byFlow.get(f.id) ?? 0 }));
    },
  });

  const createFlow = useMutation({
    mutationFn: async (input: { name: string; description: string }) => {
      const { data: flow, error: flowErr } = await supabase
        .from("approval_flows")
        .insert({
          name: input.name,
          description: input.description || null,
          active: true,
        })
        .select("id")
        .single();
      if (flowErr) throw flowErr;
      // Seed one node so the editor has something to show.
      const { error: nodeErr } = await supabase.from("approval_nodes").insert({
        flow_id: flow!.id,
        ordinal: 1,
        name: "Node 1",
      });
      if (nodeErr) throw nodeErr;
      return flow!.id as string;
    },
    onSuccess: (id) => {
      qc.invalidateQueries({ queryKey: ["flows_list"] });
      setNewOpen(false);
      navigate(`/admin/flows/${id}`);
    },
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Approval flow templates</h1>
            <p className="text-xs text-ink-muted">
              Admin only. Attach flows to projects via `project_flow_assignments`.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="invenio-btn-primary" onClick={() => setNewOpen(true)}>
              + New flow
            </button>
            <Link to="/" className="invenio-btn-secondary">
              Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 flex flex-col gap-4">
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

        {data && data.length === 0 && (
          <div className="invenio-card">
            <p className="text-ink-muted">
              No flows yet. Click "+ New flow" to create one.
            </p>
          </div>
        )}

        {data && data.length > 0 && (
          <div className="invenio-card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-raised text-ink-muted text-left text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium text-center">Nodes</th>
                  <th className="px-4 py-2 font-medium text-center">Active</th>
                  <th className="px-4 py-2 font-medium text-right">Edit</th>
                </tr>
              </thead>
              <tbody>
                {data.map((f) => (
                  <tr key={f.id} className="border-t border-border">
                    <td className="px-4 py-2 font-medium">{f.name}</td>
                    <td className="px-4 py-2 text-ink-muted">{f.description ?? "—"}</td>
                    <td className="px-4 py-2 text-center font-mono text-xs">{f.node_count}</td>
                    <td className="px-4 py-2 text-center">
                      {f.active ? (
                        <span className="inline-block rounded-sm px-2 py-0.5 text-xs font-medium bg-success-soft text-success-deep">
                          active
                        </span>
                      ) : (
                        <span className="inline-block rounded-sm px-2 py-0.5 text-xs font-medium bg-raised text-ink-muted">
                          inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        to={`/admin/flows/${f.id}`}
                        className="text-brand hover:underline text-sm"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <NewFlowModal
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onSubmit={(name, desc) => createFlow.mutate({ name, description: desc })}
        submitting={createFlow.isPending}
      />
    </div>
  );
}

function NewFlowModal({
  open,
  onClose,
  onSubmit,
  submitting,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, desc: string) => void;
  submitting: boolean;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  return (
    <Modal open={open} onClose={() => { setName(""); setDesc(""); onClose(); }} title="New flow template">
      <div className="flex flex-col gap-3">
        <div>
          <label htmlFor="nf-name" className="invenio-label">Name</label>
          <input
            id="nf-name"
            className="invenio-input"
            placeholder="e.g. Standard construction flow"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-xs text-ink-muted mt-1">
            Unique per tenant. Used in project_flow_assignments to reference the flow.
          </p>
        </div>
        <div>
          <label htmlFor="nf-desc" className="invenio-label">Description (optional)</label>
          <input
            id="nf-desc"
            className="invenio-input"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <button className="invenio-btn-secondary" onClick={() => { setName(""); setDesc(""); onClose(); }} disabled={submitting}>
            Cancel
          </button>
          <button
            className="invenio-btn-primary"
            onClick={() => onSubmit(name, desc)}
            disabled={submitting || name.trim().length === 0}
          >
            {submitting ? "Creating…" : "Create + edit"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
