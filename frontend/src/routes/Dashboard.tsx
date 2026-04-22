import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import {
  useApproveRun,
  useRejectRun,
  useReassignRun,
} from "@/lib/mutations";
import {
  P_CODES,
  humanizeError,
  type PostgrestError,
} from "@/lib/problem";
import { Modal } from "@/components/Modal";

// ---- Types ------------------------------------------------------------------

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

type ActionBanner =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | null;

// ---- Dashboard --------------------------------------------------------------

export function Dashboard() {
  const { claims, signOut } = useAuth();
  const qc = useQueryClient();

  const [banner, setBanner] = useState<ActionBanner>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingApproval | null>(null);
  const [reassignTarget, setReassignTarget] = useState<PendingApproval | null>(
    null,
  );

  const { data, error, isLoading } = useQuery<PendingApproval[]>({
    queryKey: ["my_pending_approvals"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("my_pending_approvals");
      if (error) throw error;
      return (data ?? []) as PendingApproval[];
    },
    refetchInterval: 30_000,
  });

  const approve = useApproveRun();
  const reject = useRejectRun();
  const reassign = useReassignRun();

  const handleMutationError = (err: unknown) => {
    const e = err as PostgrestError | undefined;
    if (e?.code === P_CODES.RUN_STATE_CHANGED) {
      setBanner({
        kind: "info",
        text: "The run moved while you were reviewing — refreshing the list.",
      });
      qc.invalidateQueries({ queryKey: ["my_pending_approvals"] });
      return;
    }
    setBanner({ kind: "error", text: humanizeError(err) });
  };

  const handleApprove = async (row: PendingApproval) => {
    setBanner(null);
    try {
      await approve.mutateAsync({ run_id: row.run_id });
      setBanner({ kind: "info", text: `Approved ${row.project_number ?? row.run_id.slice(0, 8)}.` });
    } catch (err) {
      handleMutationError(err);
    }
  };

  const handleRejectSubmit = async (comment: string) => {
    if (!rejectTarget) return;
    setBanner(null);
    try {
      await reject.mutateAsync({ run_id: rejectTarget.run_id, comment });
      setBanner({ kind: "info", text: `Rejected ${rejectTarget.project_number ?? rejectTarget.run_id.slice(0, 8)}.` });
      setRejectTarget(null);
    } catch (err) {
      handleMutationError(err);
    }
  };

  const handleReassignSubmit = async (toUserId: string, reason: string) => {
    if (!reassignTarget) return;
    setBanner(null);
    try {
      await reassign.mutateAsync({
        run_id: reassignTarget.run_id,
        to_user_id: toUserId,
        reason,
      });
      setBanner({ kind: "info", text: `Reassigned ${reassignTarget.project_number ?? reassignTarget.run_id.slice(0, 8)}.` });
      setReassignTarget(null);
    } catch (err) {
      handleMutationError(err);
    }
  };

  const anyMutationInFlight =
    approve.isPending || reject.isPending || reassign.isPending;

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Invenio Timekeeping</h1>
            <p className="text-xs text-ink-muted font-mono">
              {claims.username ?? "—"} · {claims.appRole ?? "—"} · tenant{" "}
              {claims.tenantId?.slice(0, 8) ?? "—"}
            </p>
          </div>
          <button onClick={signOut} className="invenio-btn-secondary">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto p-6 flex flex-col gap-6">
        {banner && (
          <div
            role="status"
            className={
              banner.kind === "error"
                ? "rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-sm text-danger-deep"
                : "rounded-md bg-brand-soft border border-brand/40 px-3 py-2 text-sm text-brand-hover"
            }
          >
            {banner.text}
          </div>
        )}

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
                Failed to load:{" "}
                {error instanceof Error ? error.message : String(error)}
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
                <li key={row.run_id} className="invenio-card flex flex-col gap-3">
                  <div className="flex items-baseline justify-between gap-4">
                    <div>
                      <h3 className="font-medium text-ink-primary">
                        {row.project_name ?? "—"}{" "}
                        <span className="text-ink-muted font-mono text-sm">
                          {row.project_number ?? ""}
                        </span>
                      </h3>
                      <p className="text-sm text-ink-muted">
                        {row.flow_name} · node {row.node_ordinal}:{" "}
                        {row.node_name}
                      </p>
                    </div>
                    <div className="text-right text-sm text-ink-muted font-mono">
                      {row.period_start} → {row.period_end}
                    </div>
                  </div>
                  <div className="text-sm text-ink-muted">
                    Submitted by{" "}
                    <span className="font-mono">
                      {row.submitter_username ?? "—"}
                    </span>{" "}
                    · opened {new Date(row.opened_at).toLocaleString()}
                  </div>
                  <div className="flex gap-2 flex-wrap justify-end pt-2 border-t border-border">
                    <button
                      className="invenio-btn-secondary"
                      onClick={() => setRejectTarget(row)}
                      disabled={anyMutationInFlight}
                    >
                      Reject…
                    </button>
                    {claims.appRole === "admin" && (
                      <button
                        className="invenio-btn-secondary"
                        onClick={() => setReassignTarget(row)}
                        disabled={anyMutationInFlight}
                      >
                        Reassign…
                      </button>
                    )}
                    <button
                      className="invenio-btn-primary"
                      onClick={() => handleApprove(row)}
                      disabled={anyMutationInFlight}
                    >
                      Approve
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <RejectModal
        target={rejectTarget}
        onCancel={() => setRejectTarget(null)}
        onSubmit={handleRejectSubmit}
        submitting={reject.isPending}
      />
      <ReassignModal
        target={reassignTarget}
        onCancel={() => setReassignTarget(null)}
        onSubmit={handleReassignSubmit}
        submitting={reassign.isPending}
      />
    </div>
  );
}

// ---- Reject modal -----------------------------------------------------------

function RejectModal({
  target,
  onCancel,
  onSubmit,
  submitting,
}: {
  target: PendingApproval | null;
  onCancel: () => void;
  onSubmit: (comment: string) => void;
  submitting: boolean;
}) {
  const [comment, setComment] = useState("");
  return (
    <Modal
      open={!!target}
      onClose={() => {
        setComment("");
        onCancel();
      }}
      title={`Reject ${target?.project_number ?? ""}`}
    >
      <p className="text-sm text-ink-muted">
        A comment is required on rejections. The submitter will receive it with
        the notification.
      </p>
      <label className="invenio-label" htmlFor="reject-comment">
        Comment
      </label>
      <textarea
        id="reject-comment"
        className="invenio-input min-h-[100px] py-2"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Why is this being rejected?"
      />
      <div className="flex gap-2 justify-end">
        <button
          className="invenio-btn-secondary"
          onClick={() => {
            setComment("");
            onCancel();
          }}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          className="invenio-btn-danger"
          onClick={() => {
            onSubmit(comment);
            setComment("");
          }}
          disabled={submitting || comment.trim().length === 0}
        >
          {submitting ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </Modal>
  );
}

// ---- Reassign modal ---------------------------------------------------------

type UserPickOption = { id: string; username: string; role: string };

function useTenantUsers(enabled: boolean) {
  return useQuery<UserPickOption[]>({
    queryKey: ["tenant_users"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, username, role")
        .eq("status", "active")
        .order("username");
      if (error) throw error;
      return (data ?? []) as UserPickOption[];
    },
  });
}

function ReassignModal({
  target,
  onCancel,
  onSubmit,
  submitting,
}: {
  target: PendingApproval | null;
  onCancel: () => void;
  onSubmit: (toUserId: string, reason: string) => void;
  submitting: boolean;
}) {
  const { data: users, isLoading } = useTenantUsers(!!target);
  const [toUserId, setToUserId] = useState("");
  const [reason, setReason] = useState("");
  const open = !!target;
  const close = () => {
    setToUserId("");
    setReason("");
    onCancel();
  };

  return (
    <Modal open={open} onClose={close} title={`Reassign ${target?.project_number ?? ""}`}>
      <p className="text-sm text-ink-muted">
        Hands the current node to another user. The original and target users
        both receive notifications.
      </p>
      <label className="invenio-label" htmlFor="reassign-user">
        Reassign to
      </label>
      <select
        id="reassign-user"
        className="invenio-input"
        value={toUserId}
        onChange={(e) => setToUserId(e.target.value)}
        disabled={isLoading}
      >
        <option value="">{isLoading ? "Loading users…" : "— pick a user —"}</option>
        {(users ?? []).map((u) => (
          <option key={u.id} value={u.id}>
            {u.username} ({u.role})
          </option>
        ))}
      </select>

      <label className="invenio-label mt-2" htmlFor="reassign-reason">
        Reason
      </label>
      <textarea
        id="reassign-reason"
        className="invenio-input min-h-[80px] py-2"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this being reassigned? (required)"
      />

      <div className="flex gap-2 justify-end">
        <button className="invenio-btn-secondary" onClick={close} disabled={submitting}>
          Cancel
        </button>
        <button
          className="invenio-btn-primary"
          onClick={() => onSubmit(toUserId, reason)}
          disabled={submitting || !toUserId || reason.trim().length === 0}
        >
          {submitting ? "Reassigning…" : "Reassign"}
        </button>
      </div>
    </Modal>
  );
}
