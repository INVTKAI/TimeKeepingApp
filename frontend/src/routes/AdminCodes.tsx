import { useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { humanizeError } from "@/lib/problem";
import { Download } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Banner, PageHeader } from "@/components/PageHeader";
import { DownloadTemplateButton } from "@/components/DownloadTemplateButton";
import {
  buildPhaseBCsv,
  downloadText,
  type DirectTemplate,
} from "@/lib/importTemplates";
import { useTenantCtx } from "@/lib/useTenantCtx";

// Tabs:
//   - Task Codes  — (code, name)
//   - CWPs        — (code, description)
//   - FCOs        — (code, description)
//   - Subcontractors — (name, short_code, active)
// All four render through the same shape-agnostic CrudTable component.

type Tab = "task_codes" | "cwps" | "fcos" | "subcontractors";

type RowBase = { id: string; active?: boolean };

type FieldSpec = {
  key: string;
  label: string;
  required?: boolean;
  type?: "text" | "checkbox";
};

const SPECS: Record<
  Tab,
  {
    label: string;
    selectCols: string;
    fields: FieldSpec[];
    orderBy: string;
    invalidateRefKey?: readonly unknown[];
  }
> = {
  task_codes: {
    label: "Task Codes",
    selectCols: "id, code, name",
    fields: [
      { key: "code", label: "Code", required: true },
      { key: "name", label: "Name", required: true },
    ],
    orderBy: "code",
    invalidateRefKey: ["ref", "task_codes"] as const,
  },
  cwps: {
    label: "CWPs",
    selectCols: "id, code, description",
    fields: [
      { key: "code", label: "Code", required: true },
      { key: "description", label: "Description", required: true },
    ],
    orderBy: "code",
    invalidateRefKey: ["ref", "cwps"] as const,
  },
  fcos: {
    label: "FCOs",
    selectCols: "id, code, description",
    fields: [
      { key: "code", label: "Code", required: true },
      { key: "description", label: "Description", required: true },
    ],
    orderBy: "code",
    invalidateRefKey: ["ref", "fcos"] as const,
  },
  subcontractors: {
    label: "Subcontractors",
    selectCols: "id, short_code, name, active",
    fields: [
      { key: "short_code", label: "Short code", required: true },
      { key: "name", label: "Name", required: true },
      { key: "active", label: "Active", type: "checkbox" },
    ],
    orderBy: "short_code",
    invalidateRefKey: ["ref", "subcontractors"] as const,
  },
};

// Subs tab uses the Phase B `subs` CSV shape (name, short_code, active).
// Task codes / CWPs / FCOs use the direct table template.
function TabTemplateButton({ table }: { table: Tab }) {
  const ctx = useTenantCtx();
  if (table === "subcontractors") {
    const disabled = !ctx;
    return (
      <button
        type="button"
        className="invenio-btn-secondary"
        disabled={disabled}
        title={
          disabled
            ? "Loading reference data…"
            : "Download subcontractors CSV template"
        }
        onClick={() => {
          if (!ctx) return;
          downloadText("template-subs.csv", buildPhaseBCsv("subs", ctx), "text/csv");
        }}
      >
        <Download size={14} aria-hidden />
        Template
      </button>
    );
  }
  return <DownloadTemplateButton table={table as DirectTemplate} size="md" />;
}

export function AdminCodes() {
  const [tab, setTab] = useState<Tab>("task_codes");
  const spec = SPECS[tab];

  return (
    <div className="invenio-page">
      <PageHeader
        title="Codes & Areas"
        subtitle="Manage task codes, CWPs, FCOs, and subcontractors."
      />

      <div className="flex gap-2 flex-wrap border-b border-border">
        {(Object.keys(SPECS) as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "px-4 py-2 text-sm font-medium text-brand-hover border-b-2 border-brand -mb-px"
                : "px-4 py-2 text-sm text-ink-muted hover:text-ink-primary"
            }
          >
            {SPECS[t].label}
          </button>
        ))}
      </div>

      <CrudTable table={tab} spec={spec} />
    </div>
  );
}

function CrudTable({
  table,
  spec,
}: {
  table: Tab;
  spec: (typeof SPECS)[Tab];
}) {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  const qc = useQueryClient();
  const [editTarget, setEditTarget] = useState<RowBase | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);

  const { data, isLoading, error } = useQuery<Record<string, unknown>[]>({
    queryKey: ["admin_codes", table],
    queryFn: async () => {
      const { data, error } = await supabase
        .from(table)
        .select(spec.selectCols)
        .order(spec.orderBy as "code");
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, unknown>[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin_codes", table] });
    if (spec.invalidateRefKey) {
      qc.invalidateQueries({ queryKey: spec.invalidateRefKey });
    }
  };

  return (
    <>
      <div className="flex justify-end gap-2">
        <TabTemplateButton table={table} />
        <button className="invenio-btn-primary" onClick={() => setAddOpen(true)}>
          + Add
        </button>
      </div>

      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}
      {isLoading && <p className="text-ink-muted">Loading…</p>}
      {error && <Banner kind="error">{String(error)}</Banner>}

      {data && data.length === 0 && !isLoading && (
        <div className="invenio-card">
          <p className="text-ink-muted">No rows yet.</p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="invenio-card p-0 overflow-hidden">
          <table className="invenio-table">
            <thead>
              <tr>
                {spec.fields.map((f) => (
                  <th key={f.key}>{f.label}</th>
                ))}
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id as string}>
                  {spec.fields.map((f) => (
                    <td
                      key={f.key}
                      className={
                        f.key === "code" || f.key === "short_code"
                          ? "font-mono text-xs"
                          : ""
                      }
                    >
                      {f.type === "checkbox" ? (
                        r[f.key] ? (
                          <span className="invenio-chip bg-success-soft text-success-deep">
                            active
                          </span>
                        ) : (
                          <span className="invenio-chip bg-raised text-ink-muted">
                            inactive
                          </span>
                        )
                      ) : (
                        String(r[f.key] ?? "")
                      )}
                    </td>
                  ))}
                  <td className="text-right">
                    <button
                      className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                      onClick={() => setEditTarget(r as RowBase)}
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

      {addOpen && (
        <CodeFormModal
          table={table}
          spec={spec}
          tenantId={tenantId}
          onClose={() => setAddOpen(false)}
          onSuccess={() => {
            setAddOpen(false);
            invalidate();
            setBanner({ kind: "info", text: "Saved." });
          }}
          onError={(err) =>
            setBanner({ kind: "error", text: humanizeError(err) })
          }
        />
      )}
      {editTarget && (
        <CodeFormModal
          table={table}
          spec={spec}
          tenantId={tenantId}
          row={editTarget as Record<string, unknown>}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            invalidate();
            setBanner({ kind: "info", text: "Saved." });
          }}
          onError={(err) =>
            setBanner({ kind: "error", text: humanizeError(err) })
          }
        />
      )}
    </>
  );
}

function CodeFormModal({
  table,
  spec,
  tenantId,
  row,
  onClose,
  onSuccess,
  onError,
}: {
  table: Tab;
  spec: (typeof SPECS)[Tab];
  tenantId: string | null;
  row?: Record<string, unknown>;
  onClose: () => void;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}) {
  const defaults: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = row?.[f.key];
    defaults[f.key] = f.type === "checkbox" ? (v ?? true) : (v ?? "");
  }
  const { register, handleSubmit, formState } = useForm<Record<string, unknown>>(
    { defaultValues: defaults },
  );

  const upsert = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const payload: Record<string, unknown> = {};
      for (const f of spec.fields) {
        const v = values[f.key];
        if (f.type === "checkbox") payload[f.key] = !!v;
        else payload[f.key] = typeof v === "string" ? v.trim() : v;
      }
      if (row) {
        const { error } = await supabase
          .from(table)
          .update(payload)
          .eq("id", row.id as string);
        if (error) throw error;
      } else {
        if (!tenantId) throw new Error("No tenant in session");
        const { error } = await supabase
          .from(table)
          .insert({ tenant_id: tenantId, ...payload });
        if (error) throw error;
      }
    },
    onSuccess,
    onError,
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!row) return;
      const { error } = await supabase
        .from(table)
        .delete()
        .eq("id", row.id as string);
      if (error) throw error;
    },
    onSuccess,
    onError,
  });

  return (
    <Modal open onClose={onClose} title={row ? `Edit ${spec.label}` : `Add ${spec.label}`}>
      <form
        className="flex flex-col gap-3"
        onSubmit={handleSubmit((v) => upsert.mutate(v))}
      >
        {spec.fields.map((f) => (
          <div key={f.key}>
            {f.type === "checkbox" ? (
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" {...register(f.key)} />
                <span className="text-sm">{f.label}</span>
              </label>
            ) : (
              <>
                <label className="invenio-label">{f.label}</label>
                <input
                  className="invenio-input"
                  {...register(f.key, f.required ? { required: true } : undefined)}
                />
              </>
            )}
          </div>
        ))}
        <div className="flex gap-2 justify-between pt-2 border-t border-border">
          {row ? (
            <button
              type="button"
              className="invenio-btn-danger"
              onClick={() => {
                if (
                  confirm(
                    "Delete this row? Rows referenced by timesheet lines cannot be deleted.",
                  )
                ) {
                  remove.mutate();
                }
              }}
              disabled={remove.isPending}
            >
              Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="invenio-btn-secondary"
              onClick={onClose}
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
