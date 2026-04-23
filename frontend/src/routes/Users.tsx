import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { humanizeError, invokeEdgeFunction } from "@/lib/problem";
import { Modal } from "@/components/Modal";
import { Banner, PageHeader } from "@/components/PageHeader";

// Admin user management — list of tenant users with Invite / Revoke / Restore /
// Unlock actions. Writes go through the admin Edge Functions via
// invokeEdgeFunction; errors flow back as RFC 7807 problem+json.

type UserRow = {
  id: string;
  username: string;
  email: string;
  role: "admin" | "submitter";
  status: "pending" | "active" | "revoked";
  created_at: string;
};

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export function Users() {
  const { session, user } = useAuth();
  const userId = user?.id ?? null;
  const qc = useQueryClient();
  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const { data, error, isLoading } = useQuery<UserRow[]>({
    queryKey: ["tenant_users_admin"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, username, email, role, status, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as UserRow[];
    },
  });

  const callEf = async (name: string, body: unknown) => {
    if (!session?.access_token) throw new Error("No active session");
    return invokeEdgeFunction(
      SUPABASE_URL,
      name,
      body,
      session.access_token,
      ANON_KEY,
    );
  };

  const revoke = useMutation({
    mutationFn: (id: string) => callEf("revoke-user", { user_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant_users_admin"] }),
  });
  const restore = useMutation({
    mutationFn: (id: string) => callEf("restore-user", { user_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant_users_admin"] }),
  });
  const unlock = useMutation({
    mutationFn: (id: string) => callEf("unlock-user", { user_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant_users_admin"] }),
  });

  const anyWorking = revoke.isPending || restore.isPending || unlock.isPending;

  const guard = async (label: string, fn: () => Promise<unknown>) => {
    setBanner(null);
    try {
      await fn();
      setBanner({ kind: "info", text: `${label} succeeded.` });
    } catch (err) {
      setBanner({ kind: "error", text: humanizeError(err) });
    }
  };

  return (
    <div className="invenio-page">
      <PageHeader
        title="Users"
        subtitle="Tenant directory — admin only."
        actions={
          <button
            onClick={() => setInviteOpen(true)}
            className="invenio-btn-primary"
          >
            Invite user…
          </button>
        }
      />
      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

      {isLoading && <p className="text-ink-muted">Loading…</p>}
        {error && (
          <div className="invenio-card border-danger/40 bg-danger-soft">
            <p className="text-danger-deep">
              {error instanceof Error ? error.message : String(error)}
            </p>
          </div>
        )}

        {data && data.length > 0 && (
          <div className="invenio-card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-raised text-ink-muted text-left text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2 font-medium">Username</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((u) => {
                  const isSelf = u.id === userId;
                  return (
                    <tr key={u.id} className="border-t border-border">
                      <td className="px-4 py-2 font-mono">{u.username}</td>
                      <td className="px-4 py-2">{u.email}</td>
                      <td className="px-4 py-2">{u.role}</td>
                      <td className="px-4 py-2">
                        <StatusChip status={u.status} />
                      </td>
                      <td className="px-4 py-2 text-ink-muted">
                        {new Date(u.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right space-x-2 whitespace-nowrap">
                        {(u.status === "active" || u.status === "pending") && !isSelf && (
                          <button
                            className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                            disabled={anyWorking}
                            onClick={() => guard(`Revoked ${u.username}`, () => revoke.mutateAsync(u.id))}
                            title={
                              u.status === "pending"
                                ? "Cancels the unaccepted invite + bans sign-in"
                                : undefined
                            }
                          >
                            Revoke
                          </button>
                        )}
                        {u.status === "revoked" && (
                          <button
                            className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                            disabled={anyWorking}
                            onClick={() => guard(`Restored ${u.username}`, () => restore.mutateAsync(u.id))}
                          >
                            Restore
                          </button>
                        )}
                        {u.status !== "revoked" && (
                          <button
                            className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                            disabled={anyWorking}
                            onClick={() => guard(`Unlocked ${u.username}`, () => unlock.mutateAsync(u.id))}
                            title="Clear lockout counter"
                          >
                            Unlock
                          </button>
                        )}
                        {isSelf && (
                          <span className="text-xs text-ink-subtle font-mono">(you)</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onSuccess={(username) => {
          setInviteOpen(false);
          setBanner({ kind: "info", text: `Invited ${username}.` });
          qc.invalidateQueries({ queryKey: ["tenant_users_admin"] });
        }}
        callEf={callEf}
      />
    </div>
  );
}

function StatusChip({ status }: { status: UserRow["status"] }) {
  const cls =
    status === "active"
      ? "bg-success-soft text-success-deep"
      : status === "pending"
      ? "bg-warn-soft text-warn-deep"
      : "bg-raised text-ink-muted";
  return (
    <span className={`inline-block rounded-sm px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

type InviteForm = {
  username: string;
  email: string;
  role: "admin" | "submitter";
};

function InviteModal({
  open,
  onClose,
  onSuccess,
  callEf,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (username: string) => void;
  callEf: (name: string, body: unknown) => Promise<unknown>;
}) {
  const { register, handleSubmit, reset, formState } = useForm<InviteForm>({
    defaultValues: { role: "submitter" },
  });
  const [apiError, setApiError] = useState<string | null>(null);

  const onSubmit = async (values: InviteForm) => {
    setApiError(null);
    try {
      await callEf("invite-user", values);
      reset();
      onSuccess(values.username);
    } catch (err) {
      setApiError(humanizeError(err));
    }
  };

  return (
    <Modal open={open} onClose={() => { reset(); setApiError(null); onClose(); }} title="Invite user">
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <div>
          <label htmlFor="invite-username" className="invenio-label">Username</label>
          <input
            id="invite-username"
            className="invenio-input"
            autoComplete="off"
            {...register("username", { required: "Required" })}
          />
          {formState.errors.username && (
            <p className="invenio-error">{formState.errors.username.message}</p>
          )}
        </div>
        <div>
          <label htmlFor="invite-email" className="invenio-label">Email</label>
          <input
            id="invite-email"
            type="email"
            className="invenio-input"
            autoComplete="off"
            {...register("email", { required: "Required" })}
          />
          {formState.errors.email && (
            <p className="invenio-error">{formState.errors.email.message}</p>
          )}
        </div>
        <div>
          <label htmlFor="invite-role" className="invenio-label">Role</label>
          <select
            id="invite-role"
            className="invenio-input"
            {...register("role", { required: true })}
          >
            <option value="submitter">submitter</option>
            <option value="admin">admin</option>
          </select>
        </div>
        {apiError && (
          <div role="alert" className="rounded-md bg-danger-soft border border-danger/40 px-3 py-2 text-sm text-danger-deep">
            {apiError}
          </div>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            className="invenio-btn-secondary"
            onClick={() => { reset(); setApiError(null); onClose(); }}
            disabled={formState.isSubmitting}
          >
            Cancel
          </button>
          <button type="submit" className="invenio-btn-primary" disabled={formState.isSubmitting}>
            {formState.isSubmitting ? "Inviting…" : "Send invite"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
