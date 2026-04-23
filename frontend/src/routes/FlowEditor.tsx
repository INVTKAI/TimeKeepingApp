import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { humanizeError } from "@/lib/problem";
import { Banner, PageHeader } from "@/components/PageHeader";

// Flow template editor. A flow has 1-5 ordered nodes; each node has one or
// more approvers via one of three branch types:
//   - user            : direct reference to public.users.id
//   - role_on_silo    : role_label resolved via silo_role_assignments
//   - role_on_project : role_label resolved via project_role_assignments
//
// Spec §5 + §7.1 canonical role labels:
//   silo:     foreman, timekeeper_admin
//   project:  pm, prime_rep, accounting
// We expose these as a dropdown; admins type free text if they've extended
// the schema with custom labels.

type Flow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
};

type Node = {
  id: string;
  flow_id: string;
  ordinal: number;
  name: string;
};

type Approver = {
  id: string;
  node_id: string;
  approver_type: "user" | "role_on_silo" | "role_on_project";
  user_id: string | null;
  role_label: string | null;
};

type UserRow = { id: string; username: string; role: string };

const SILO_ROLES = ["foreman", "timekeeper_admin"];
const PROJECT_ROLES = ["pm", "prime_rep", "accounting"];

// ---------------------------------------------------------------------------

export function FlowEditor() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [banner, setBanner] = useState<
    | { kind: "info"; text: string }
    | { kind: "error"; text: string }
    | null
  >(null);

  const flowQuery = useQuery<Flow | null>({
    queryKey: ["flow", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("approval_flows")
        .select("id, name, description, active")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as Flow | null;
    },
  });

  const nodesQuery = useQuery<Node[]>({
    queryKey: ["flow_nodes", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("approval_nodes")
        .select("id, flow_id, ordinal, name")
        .eq("flow_id", id!)
        .order("ordinal");
      if (error) throw error;
      return (data ?? []) as Node[];
    },
  });

  const approversQuery = useQuery<Approver[]>({
    queryKey: ["flow_approvers", id, nodesQuery.data?.map((n) => n.id).join(",")],
    enabled: !!nodesQuery.data && nodesQuery.data.length > 0,
    queryFn: async () => {
      const nodeIds = (nodesQuery.data ?? []).map((n) => n.id);
      if (nodeIds.length === 0) return [];
      const { data, error } = await supabase
        .from("approval_node_approvers")
        .select("id, node_id, approver_type, user_id, role_label")
        .in("node_id", nodeIds);
      if (error) throw error;
      return (data ?? []) as Approver[];
    },
  });

  const usersQuery = useQuery<UserRow[]>({
    queryKey: ["tenant_users_for_flow"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, username, role")
        .eq("status", "active")
        .order("username");
      if (error) throw error;
      return (data ?? []) as UserRow[];
    },
  });

  // --- Mutations -----------------------------------------------------------

  const patchFlow = useMutation({
    mutationFn: async (patch: Partial<Pick<Flow, "name" | "description" | "active">>) => {
      const { error } = await supabase
        .from("approval_flows")
        .update(patch)
        .eq("id", id!);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow", id] }),
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  const addNode = useMutation({
    mutationFn: async () => {
      const existing = nodesQuery.data ?? [];
      if (existing.length >= 5) {
        throw new Error("Flows are capped at 5 nodes per spec §7.1.");
      }
      const nextOrdinal = Math.max(0, ...existing.map((n) => n.ordinal)) + 1;
      const { error } = await supabase.from("approval_nodes").insert({
        flow_id: id!,
        ordinal: nextOrdinal,
        name: `Node ${nextOrdinal}`,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow_nodes", id] }),
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  const removeNode = useMutation({
    mutationFn: async (nodeId: string) => {
      // Cascades to approval_node_approvers via FK ON DELETE CASCADE.
      const { error } = await supabase.from("approval_nodes").delete().eq("id", nodeId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow_nodes", id] }),
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  const swapNodes = useMutation({
    mutationFn: async (input: { a: Node; b: Node }) => {
      // Two-step reorder via a temp ordinal that can't collide (UNIQUE on
      // (flow_id, ordinal)). Pick a value higher than the schema-allowed max.
      const temp = 99;
      const { error: e1 } = await supabase
        .from("approval_nodes")
        .update({ ordinal: temp })
        .eq("id", input.a.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase
        .from("approval_nodes")
        .update({ ordinal: input.a.ordinal })
        .eq("id", input.b.id);
      if (e2) throw e2;
      const { error: e3 } = await supabase
        .from("approval_nodes")
        .update({ ordinal: input.b.ordinal })
        .eq("id", input.a.id);
      if (e3) throw e3;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow_nodes", id] }),
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  const renameNode = useMutation({
    mutationFn: async (input: { nodeId: string; name: string }) => {
      const { error } = await supabase
        .from("approval_nodes")
        .update({ name: input.name })
        .eq("id", input.nodeId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow_nodes", id] }),
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  const addApprover = useMutation({
    mutationFn: async (input: {
      nodeId: string;
      approver_type: Approver["approver_type"];
      user_id: string | null;
      role_label: string | null;
    }) => {
      const { error } = await supabase.from("approval_node_approvers").insert({
        node_id: input.nodeId,
        approver_type: input.approver_type,
        user_id: input.user_id,
        role_label: input.role_label,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow_approvers", id] }),
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  const removeApprover = useMutation({
    mutationFn: async (approverId: string) => {
      const { error } = await supabase
        .from("approval_node_approvers")
        .delete()
        .eq("id", approverId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["flow_approvers", id] }),
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  // --- Rendering -----------------------------------------------------------

  if (flowQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-ink-muted">Loading flow…</p>
      </div>
    );
  }
  const flow = flowQuery.data;
  if (!flow) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="invenio-card max-w-md">
          <h1 className="text-lg font-semibold mb-2">Flow not found</h1>
          <Link to="/admin/flows" className="text-brand hover:underline text-sm">
            Back to list
          </Link>
        </div>
      </div>
    );
  }

  const nodes = nodesQuery.data ?? [];
  const approversByNode = new Map<string, Approver[]>();
  for (const a of approversQuery.data ?? []) {
    const list = approversByNode.get(a.node_id) ?? [];
    list.push(a);
    approversByNode.set(a.node_id, list);
  }

  return (
    <div className="invenio-page">
      <PageHeader
        title={flow.name}
        subtitle={`${flow.active ? "Active" : "Inactive"} · ${nodes.length} node${nodes.length === 1 ? "" : "s"}`}
        actions={
          <>
            <button
              className="invenio-btn-secondary"
              disabled={patchFlow.isPending}
              onClick={() => patchFlow.mutate({ active: !flow.active })}
            >
              {flow.active ? "Deactivate" : "Reactivate"}
            </button>
            <Link to="/admin/flows" className="invenio-btn-secondary">
              Back to list
            </Link>
          </>
        }
      />
      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

        {/* Flow metadata */}
        <div className="invenio-card">
          <label className="invenio-label">Name</label>
          <input
            className="invenio-input mb-3"
            defaultValue={flow.name}
            onBlur={(e) => {
              if (e.target.value !== flow.name) patchFlow.mutate({ name: e.target.value });
            }}
          />
          <label className="invenio-label">Description</label>
          <input
            className="invenio-input"
            defaultValue={flow.description ?? ""}
            onBlur={(e) => {
              const next = e.target.value || null;
              if (next !== flow.description) patchFlow.mutate({ description: next });
            }}
          />
          <p className="text-xs text-ink-muted mt-2">
            Saves on blur. Changes are immediate — any in-flight approval runs
            keep their original flow version by reference.
          </p>
        </div>

        {/* Nodes */}
        <h2 className="text-lg font-semibold mt-2">Nodes</h2>
        {nodes.length === 0 && (
          <div className="invenio-card">
            <p className="text-ink-muted">No nodes yet.</p>
          </div>
        )}
        {nodes.map((node, i) => (
          <NodeCard
            key={node.id}
            node={node}
            index={i}
            total={nodes.length}
            approvers={approversByNode.get(node.id) ?? []}
            users={usersQuery.data ?? []}
            onRename={(name) => renameNode.mutate({ nodeId: node.id, name })}
            onRemove={() => removeNode.mutate(node.id)}
            onSwap={(direction) => {
              const other = direction === "up" ? nodes[i - 1] : nodes[i + 1];
              if (other) swapNodes.mutate({ a: node, b: other });
            }}
            onAddApprover={(approver_type, user_id, role_label) =>
              addApprover.mutate({ nodeId: node.id, approver_type, user_id, role_label })
            }
            onRemoveApprover={(approverId) => removeApprover.mutate(approverId)}
          />
        ))}

        <div>
          <button
            className="invenio-btn-secondary"
            disabled={addNode.isPending || nodes.length >= 5}
            onClick={() => addNode.mutate()}
            title={nodes.length >= 5 ? "Max 5 nodes per flow" : undefined}
          >
            + Add node
          </button>
        </div>
    </div>
  );
}

// ---- Node card --------------------------------------------------------------

function NodeCard({
  node,
  index,
  total,
  approvers,
  users,
  onRename,
  onRemove,
  onSwap,
  onAddApprover,
  onRemoveApprover,
}: {
  node: Node;
  index: number;
  total: number;
  approvers: Approver[];
  users: UserRow[];
  onRename: (name: string) => void;
  onRemove: () => void;
  onSwap: (direction: "up" | "down") => void;
  onAddApprover: (
    approver_type: Approver["approver_type"],
    user_id: string | null,
    role_label: string | null,
  ) => void;
  onRemoveApprover: (approverId: string) => void;
}) {
  const [pendingType, setPendingType] = useState<Approver["approver_type"]>("user");
  const [pendingUserId, setPendingUserId] = useState("");
  const [pendingRole, setPendingRole] = useState("");
  const [pendingCustomRole, setPendingCustomRole] = useState("");

  const handleAdd = () => {
    if (pendingType === "user") {
      if (!pendingUserId) return;
      onAddApprover("user", pendingUserId, null);
      setPendingUserId("");
    } else {
      const role =
        pendingRole === "__custom__" ? pendingCustomRole.trim() : pendingRole;
      if (!role) return;
      onAddApprover(pendingType, null, role);
      setPendingRole("");
      setPendingCustomRole("");
    }
  };

  const roleOptions =
    pendingType === "role_on_silo" ? SILO_ROLES : PROJECT_ROLES;

  return (
    <div className="invenio-card">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1 text-xs text-ink-muted font-mono">
            Node {node.ordinal}
          </div>
          <input
            className="invenio-input"
            defaultValue={node.name}
            onBlur={(e) => {
              if (e.target.value !== node.name) onRename(e.target.value);
            }}
          />
        </div>
        <div className="flex gap-1">
          <button
            className="invenio-btn-secondary text-xs !px-2 !py-1 !min-h-0"
            onClick={() => onSwap("up")}
            disabled={index === 0}
            title="Move up"
          >
            ↑
          </button>
          <button
            className="invenio-btn-secondary text-xs !px-2 !py-1 !min-h-0"
            onClick={() => onSwap("down")}
            disabled={index === total - 1}
            title="Move down"
          >
            ↓
          </button>
          <button
            className="invenio-btn-danger text-xs !px-2 !py-1 !min-h-0"
            onClick={() => {
              if (confirm(`Delete node ${node.ordinal}? This removes its approvers too.`)) {
                onRemove();
              }
            }}
            title="Delete node"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="text-xs text-ink-muted mb-2">Approvers</div>
      {approvers.length === 0 && (
        <p className="text-sm text-ink-muted italic mb-2">
          No approvers yet — this node will fail at submit-time until at least one is added.
        </p>
      )}
      <ul className="flex flex-col gap-1 mb-3">
        {approvers.map((a) => (
          <li
            key={a.id}
            className="flex items-center justify-between gap-2 bg-raised rounded-sm px-3 py-1.5 text-sm"
          >
            <span>
              {a.approver_type === "user" && (
                <>
                  <span className="font-mono text-xs text-ink-muted">user:</span>{" "}
                  {users.find((u) => u.id === a.user_id)?.username ??
                    a.user_id?.slice(0, 8)}
                </>
              )}
              {a.approver_type === "role_on_silo" && (
                <>
                  <span className="font-mono text-xs text-ink-muted">role_on_silo:</span>{" "}
                  {a.role_label}
                </>
              )}
              {a.approver_type === "role_on_project" && (
                <>
                  <span className="font-mono text-xs text-ink-muted">role_on_project:</span>{" "}
                  {a.role_label}
                </>
              )}
            </span>
            <button
              className="text-danger hover:text-danger-hover text-xs"
              onClick={() => onRemoveApprover(a.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>

      {/* Add-approver row */}
      <div className="flex gap-2 flex-wrap items-end">
        <div>
          <label className="invenio-label !text-xs">Type</label>
          <select
            className="invenio-input !min-h-0 !py-1 !text-xs"
            value={pendingType}
            onChange={(e) => {
              setPendingType(e.target.value as Approver["approver_type"]);
              setPendingRole("");
              setPendingUserId("");
            }}
          >
            <option value="user">user</option>
            <option value="role_on_silo">role_on_silo</option>
            <option value="role_on_project">role_on_project</option>
          </select>
        </div>

        {pendingType === "user" && (
          <div className="flex-1 min-w-[200px]">
            <label className="invenio-label !text-xs">User</label>
            <select
              className="invenio-input !min-h-0 !py-1 !text-xs"
              value={pendingUserId}
              onChange={(e) => setPendingUserId(e.target.value)}
            >
              <option value="">— pick a user —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username} ({u.role})
                </option>
              ))}
            </select>
          </div>
        )}

        {pendingType !== "user" && (
          <>
            <div>
              <label className="invenio-label !text-xs">Role</label>
              <select
                className="invenio-input !min-h-0 !py-1 !text-xs"
                value={pendingRole}
                onChange={(e) => setPendingRole(e.target.value)}
              >
                <option value="">— pick a role —</option>
                {roleOptions.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
                <option value="__custom__">custom…</option>
              </select>
            </div>
            {pendingRole === "__custom__" && (
              <div>
                <label className="invenio-label !text-xs">Custom label</label>
                <input
                  className="invenio-input !min-h-0 !py-1 !text-xs"
                  value={pendingCustomRole}
                  onChange={(e) => setPendingCustomRole(e.target.value)}
                  placeholder="e.g. safety_officer"
                />
              </div>
            )}
          </>
        )}

        <button className="invenio-btn-secondary !min-h-0 !py-1 !text-xs" onClick={handleAdd}>
          + Add approver
        </button>
      </div>
    </div>
  );
}
