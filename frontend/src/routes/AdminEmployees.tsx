import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { useSubcontractors } from "@/lib/referenceData";
import { humanizeError } from "@/lib/problem";
import { Modal } from "@/components/Modal";
import { Banner, PageHeader } from "@/components/PageHeader";

type Employee = {
  id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  type: "staff" | "field";
  craft: string | null;
  active: boolean;
  subcontractor_id: string;
  created_at: string;
};

type SubRow = { id: string; short_code: string; name: string; active: boolean };

type HistoryRow = {
  id: string;
  employee_id: string;
  subcontractor_id: string;
  started_at: string;
  ended_at: string | null;
};

export function AdminEmployees() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  const qc = useQueryClient();
  const { data: subs } = useSubcontractors();

  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editTarget, setEditTarget] = useState<Employee | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);

  const { data, isLoading, error } = useQuery<Employee[]>({
    queryKey: ["admin_employees"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employees")
        .select(
          "id, external_id, first_name, last_name, type, craft, active, subcontractor_id, created_at",
        )
        .order("last_name")
        .order("first_name");
      if (error) throw error;
      return (data ?? []) as Employee[];
    },
  });

  const subLabel = (id: string) => {
    const s = subs?.find((x) => x.id === id);
    return s ? s.short_code : id.slice(0, 6);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = data ?? [];
    if (!includeInactive) rows = rows.filter((e) => e.active);
    if (!q) return rows;
    return rows.filter((e) => {
      const full = `${e.first_name} ${e.last_name} ${e.external_id ?? ""} ${
        e.craft ?? ""
      }`.toLowerCase();
      return full.includes(q);
    });
  }, [data, search, includeInactive]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["admin_employees"] });

  return (
    <div className="invenio-page">
      <PageHeader
        title="Employees"
        subtitle="Tenant roster. Full name + current subcontractor required."
        actions={
          <button className="invenio-btn-primary" onClick={() => setAddOpen(true)}>
            + Add employee
          </button>
        }
      />
      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

      <div className="flex gap-3 items-center flex-wrap">
        <input
          className="invenio-input max-w-sm"
          placeholder="Search by name, external_id, or craft…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          <span>Include inactive</span>
        </label>
      </div>

      {isLoading && <p className="text-ink-muted">Loading…</p>}
      {error && <Banner kind="error">{String(error)}</Banner>}

      {filtered.length === 0 && !isLoading && (
        <div className="invenio-card">
          <p className="text-ink-muted">
            {search ? "No employees match your search." : "No employees yet."}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="invenio-card p-0 overflow-hidden">
          <table className="invenio-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>External ID</th>
                <th>Type</th>
                <th>Craft</th>
                <th>Sub</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td className="font-medium">
                    {e.last_name}, {e.first_name}
                  </td>
                  <td className="font-mono text-xs">{e.external_id ?? "—"}</td>
                  <td className="font-mono text-xs">{e.type}</td>
                  <td>{e.craft ?? "—"}</td>
                  <td className="font-mono text-xs">
                    {subLabel(e.subcontractor_id)}
                  </td>
                  <td>
                    {e.active ? (
                      <span className="invenio-chip bg-success-soft text-success-deep">
                        active
                      </span>
                    ) : (
                      <span className="invenio-chip bg-raised text-ink-muted">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <button
                      className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                      onClick={() => setEditTarget(e)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddEmployeeModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        subs={subs ?? []}
        tenantId={tenantId}
        onSuccess={() => {
          setAddOpen(false);
          setBanner({ kind: "info", text: "Employee added." });
          invalidate();
        }}
        onError={(err) => setBanner({ kind: "error", text: humanizeError(err) })}
      />

      {editTarget && (
        <EditEmployeeModal
          employee={editTarget}
          subs={subs ?? []}
          tenantId={tenantId}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            invalidate();
            setBanner({ kind: "info", text: "Employee updated." });
          }}
          onError={(err) =>
            setBanner({ kind: "error", text: humanizeError(err) })
          }
        />
      )}
    </div>
  );
}

// ---- Add ------------------------------------------------------------------

type AddForm = {
  first_name: string;
  last_name: string;
  external_id: string;
  type: "staff" | "field";
  craft: string;
  subcontractor_id: string;
  active: boolean;
};

function AddEmployeeModal({
  open,
  onClose,
  subs,
  tenantId,
  onSuccess,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  subs: SubRow[];
  tenantId: string | null;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}) {
  const { register, handleSubmit, reset, formState } = useForm<AddForm>({
    defaultValues: { type: "field", active: true },
  });

  const create = useMutation({
    mutationFn: async (values: AddForm) => {
      if (!tenantId) throw new Error("No tenant in session");
      const { error } = await supabase.from("employees").insert({
        tenant_id: tenantId,
        first_name: values.first_name.trim(),
        last_name: values.last_name.trim(),
        external_id: values.external_id.trim() || null,
        type: values.type,
        craft: values.craft.trim() || null,
        subcontractor_id: values.subcontractor_id,
        active: values.active,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      reset();
      onSuccess();
    },
    onError,
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add employee"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={handleSubmit((v) => create.mutate(v))}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="invenio-label">First name</label>
            <input
              className="invenio-input"
              {...register("first_name", { required: true })}
            />
          </div>
          <div>
            <label className="invenio-label">Last name</label>
            <input
              className="invenio-input"
              {...register("last_name", { required: true })}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="invenio-label">External ID (optional)</label>
            <input
              className="invenio-input"
              placeholder="e.g. E001"
              {...register("external_id")}
            />
          </div>
          <div>
            <label className="invenio-label">Type</label>
            <select className="invenio-input" {...register("type")}>
              <option value="field">field</option>
              <option value="staff">staff</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="invenio-label">Craft</label>
            <input
              className="invenio-input"
              placeholder="e.g. Carpenter"
              {...register("craft")}
            />
          </div>
          <div>
            <label className="invenio-label">Subcontractor</label>
            <select
              className="invenio-input"
              {...register("subcontractor_id", { required: true })}
            >
              <option value="">— pick a sub —</option>
              {subs
                .filter((s) => s.active)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.short_code} · {s.name}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" {...register("active")} />
          <span className="text-sm">Active</span>
        </label>

        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            className="invenio-btn-secondary"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={formState.isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="invenio-btn-primary"
            disabled={formState.isSubmitting}
          >
            {formState.isSubmitting ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Edit -----------------------------------------------------------------

function EditEmployeeModal({
  employee,
  subs,
  tenantId,
  onClose,
  onSuccess,
  onError,
}: {
  employee: Employee;
  subs: SubRow[];
  tenantId: string | null;
  onClose: () => void;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}) {
  const qc = useQueryClient();
  const { register, handleSubmit, watch, formState } = useForm<AddForm>({
    defaultValues: {
      first_name: employee.first_name,
      last_name: employee.last_name,
      external_id: employee.external_id ?? "",
      type: employee.type,
      craft: employee.craft ?? "",
      subcontractor_id: employee.subcontractor_id,
      active: employee.active,
    },
  });

  const watchedSubId = watch("subcontractor_id");
  const changingSub = watchedSubId && watchedSubId !== employee.subcontractor_id;

  const { data: history } = useQuery<HistoryRow[]>({
    queryKey: ["employee_sub_history", employee.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_subcontractor_history")
        .select("id, employee_id, subcontractor_id, started_at, ended_at")
        .eq("employee_id", employee.id)
        .order("started_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as HistoryRow[];
    },
  });

  const update = useMutation({
    mutationFn: async (values: AddForm) => {
      const nowIso = new Date().toISOString();
      const subChanged = values.subcontractor_id !== employee.subcontractor_id;

      // Guard the §6.2 "exactly one open span" invariant — if the user fires
      // save before the sub-history query returns, we'd miss the close step
      // and leave two open spans. Ask them to wait a tick.
      if (subChanged && !history) {
        throw new Error(
          "Still loading sub-history — try Save again in a moment.",
        );
      }

      const { error: updErr } = await supabase
        .from("employees")
        .update({
          first_name: values.first_name.trim(),
          last_name: values.last_name.trim(),
          external_id: values.external_id.trim() || null,
          type: values.type,
          craft: values.craft.trim() || null,
          subcontractor_id: values.subcontractor_id,
          active: values.active,
        })
        .eq("id", employee.id);
      if (updErr) throw updErr;

      if (subChanged) {
        if (!tenantId) throw new Error("No tenant in session");
        // Close the open span (if any) and open a new one. Spec §6.2 calls
        // for a dedicated RPC to enforce the "exactly one open span"
        // invariant; until that lands we rely on admin-only writes + the
        // fact that sub changes are rare.
        const openRow = (history ?? []).find((h) => h.ended_at === null);
        if (openRow) {
          const { error: closeErr } = await supabase
            .from("employee_subcontractor_history")
            .update({ ended_at: nowIso })
            .eq("id", openRow.id);
          if (closeErr) throw closeErr;
        }
        const { error: insErr } = await supabase
          .from("employee_subcontractor_history")
          .insert({
            tenant_id: tenantId,
            employee_id: employee.id,
            subcontractor_id: values.subcontractor_id,
            started_at: nowIso,
          });
        if (insErr) throw insErr;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employee_sub_history", employee.id] });
      onSuccess();
    },
    onError,
  });

  const toggleActive = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("employees")
        .update({ active: !employee.active })
        .eq("id", employee.id);
      if (error) throw error;
    },
    onSuccess,
    onError,
  });

  const subLabel = (id: string) => {
    const s = subs.find((x) => x.id === id);
    return s ? `${s.short_code} · ${s.name}` : id.slice(0, 8);
  };

  return (
    <Modal open onClose={onClose} title={`Edit ${employee.first_name} ${employee.last_name}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={handleSubmit((v) => update.mutate(v))}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="invenio-label">First name</label>
            <input
              className="invenio-input"
              {...register("first_name", { required: true })}
            />
          </div>
          <div>
            <label className="invenio-label">Last name</label>
            <input
              className="invenio-input"
              {...register("last_name", { required: true })}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="invenio-label">External ID</label>
            <input className="invenio-input" {...register("external_id")} />
          </div>
          <div>
            <label className="invenio-label">Type</label>
            <select className="invenio-input" {...register("type")}>
              <option value="field">field</option>
              <option value="staff">staff</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="invenio-label">Craft</label>
            <input className="invenio-input" {...register("craft")} />
          </div>
          <div>
            <label className="invenio-label">Subcontractor</label>
            <select
              className="invenio-input"
              {...register("subcontractor_id", { required: true })}
            >
              <option value="">— pick a sub —</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.short_code} · {s.name}
                </option>
              ))}
            </select>
            {changingSub && (
              <p className="text-xs text-warn-deep mt-1">
                Sub change detected. A history entry will close the current span
                and open a new one on save.
              </p>
            )}
          </div>
        </div>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" {...register("active")} />
          <span className="text-sm">Active</span>
        </label>

        {(history?.length ?? 0) > 0 && (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-brand hover:underline">
              Sub-history ({history?.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {(history ?? []).map((h) => (
                <li
                  key={h.id}
                  className="text-xs text-ink-muted bg-raised rounded-sm px-2 py-1 font-mono"
                >
                  {subLabel(h.subcontractor_id)} ·{" "}
                  {new Date(h.started_at).toISOString().slice(0, 10)} →{" "}
                  {h.ended_at
                    ? new Date(h.ended_at).toISOString().slice(0, 10)
                    : "open"}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex gap-2 justify-between pt-2 border-t border-border">
          <button
            type="button"
            className={employee.active ? "invenio-btn-danger" : "invenio-btn-secondary"}
            onClick={() => {
              const nextActive = !employee.active;
              const verb = nextActive ? "Reactivate" : "Deactivate";
              const tail = nextActive
                ? "They will reappear in crew pickers."
                : "They will stop appearing in crew pickers.";
              if (
                confirm(
                  `${verb} ${employee.first_name} ${employee.last_name}? ${tail}`,
                )
              ) {
                toggleActive.mutate();
              }
            }}
            disabled={toggleActive.isPending}
          >
            {employee.active ? "Deactivate" : "Reactivate"}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              className="invenio-btn-secondary"
              onClick={onClose}
              disabled={formState.isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="invenio-btn-primary"
              disabled={formState.isSubmitting}
            >
              {formState.isSubmitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
