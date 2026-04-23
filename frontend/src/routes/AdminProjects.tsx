import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { humanizeError } from "@/lib/problem";
import { Modal } from "@/components/Modal";
import { Banner, PageHeader } from "@/components/PageHeader";
import { DownloadTemplateButton } from "@/components/DownloadTemplateButton";

type Project = {
  id: string;
  number: string;
  name: string;
  active: boolean;
  created_at: string;
};

type AreaCount = { project_id: string; count: number };

export function AdminProjects() {
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);

  const { data, isLoading, error } = useQuery<Project[]>({
    queryKey: ["admin_projects"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, number, name, active, created_at")
        .order("number");
      if (error) throw error;
      return (data ?? []) as Project[];
    },
  });

  const { data: areaCounts } = useQuery<AreaCount[]>({
    queryKey: ["admin_projects_area_counts"],
    enabled: !!data && data.length > 0,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("areas")
        .select("project_id");
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const r of (rows ?? []) as { project_id: string }[]) {
        counts.set(r.project_id, (counts.get(r.project_id) ?? 0) + 1);
      }
      return Array.from(counts.entries()).map(([project_id, count]) => ({
        project_id,
        count,
      }));
    },
  });

  const countByProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of areaCounts ?? []) m.set(c.project_id, c.count);
    return m;
  }, [areaCounts]);

  return (
    <div className="invenio-page">
      <PageHeader
        title="Projects"
        subtitle="Projects contain areas; labor rolls up to these."
        actions={
          <>
            <DownloadTemplateButton table="projects" size="md" />
            <button
              className="invenio-btn-primary"
              onClick={() => setAddOpen(true)}
            >
              + Add project
            </button>
          </>
        }
      />
      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}
      {isLoading && <p className="text-ink-muted">Loading…</p>}
      {error && <Banner kind="error">{String(error)}</Banner>}

      {data && data.length === 0 && (
        <div className="invenio-card">
          <p className="text-ink-muted">No projects yet.</p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="invenio-card p-0 overflow-hidden">
          <table className="invenio-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Name</th>
                <th className="text-center">Areas</th>
                <th>Status</th>
                <th>Created</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono">{p.number}</td>
                  <td className="font-medium">{p.name}</td>
                  <td className="text-center font-mono text-xs">
                    {countByProject.get(p.id) ?? 0}
                  </td>
                  <td>
                    {p.active ? (
                      <span className="invenio-chip bg-success-soft text-success-deep">
                        active
                      </span>
                    ) : (
                      <span className="invenio-chip bg-raised text-ink-muted">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="text-ink-muted">
                    {new Date(p.created_at).toLocaleDateString()}
                  </td>
                  <td className="text-right">
                    <Link
                      to={`/admin/projects/${p.id}`}
                      className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AddProjectModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        tenantId={tenantId}
        onSuccess={() => {
          setAddOpen(false);
          qc.invalidateQueries({ queryKey: ["admin_projects"] });
          qc.invalidateQueries({ queryKey: ["ref", "projects"] });
          setBanner({ kind: "info", text: "Project added." });
        }}
        onError={(err) => setBanner({ kind: "error", text: humanizeError(err) })}
      />
    </div>
  );
}

type AddForm = { number: string; name: string; active: boolean };

function AddProjectModal({
  open,
  onClose,
  tenantId,
  onSuccess,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  tenantId: string | null;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}) {
  const { register, handleSubmit, reset, formState } = useForm<AddForm>({
    defaultValues: { active: true },
  });
  const create = useMutation({
    mutationFn: async (values: AddForm) => {
      if (!tenantId) throw new Error("No tenant in session");
      const { error } = await supabase.from("projects").insert({
        tenant_id: tenantId,
        number: values.number.trim(),
        name: values.name.trim(),
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
      title="Add project"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={handleSubmit((v) => create.mutate(v))}
      >
        <div>
          <label className="invenio-label">Number</label>
          <input
            className="invenio-input"
            placeholder="e.g. P-1024"
            {...register("number", { required: true })}
          />
        </div>
        <div>
          <label className="invenio-label">Name</label>
          <input
            className="invenio-input"
            {...register("name", { required: true })}
          />
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
