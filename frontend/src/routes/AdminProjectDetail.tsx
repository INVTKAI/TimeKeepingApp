import { useState } from "react";
import { useForm } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { supabase } from "@/lib/supabase";
import { humanizeError } from "@/lib/problem";
import { Modal } from "@/components/Modal";
import { Banner, PageHeader } from "@/components/PageHeader";

type Project = {
  id: string;
  number: string;
  name: string;
  active: boolean;
  created_at: string;
};

type Area = {
  id: string;
  project_id: string;
  code: string;
  name: string;
};

export function AdminProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const { claims } = useAuth();
  const tenantId = claims.tenantId;
  const qc = useQueryClient();

  const [editArea, setEditArea] = useState<Area | null>(null);
  const [addArea, setAddArea] = useState(false);
  const [banner, setBanner] = useState<
    { kind: "info" | "error"; text: string } | null
  >(null);

  const projectQuery = useQuery<Project | null>({
    queryKey: ["admin_project", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("id, number, name, active, created_at")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data as Project | null;
    },
  });

  const areasQuery = useQuery<Area[]>({
    queryKey: ["admin_project_areas", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("areas")
        .select("id, project_id, code, name")
        .eq("project_id", id!)
        .order("code");
      if (error) throw error;
      return (data ?? []) as Area[];
    },
  });

  const updateProject = useMutation({
    mutationFn: async (patch: Partial<Pick<Project, "number" | "name" | "active">>) => {
      const { error } = await supabase
        .from("projects")
        .update(patch)
        .eq("id", id!);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin_project", id] });
      qc.invalidateQueries({ queryKey: ["admin_projects"] });
      qc.invalidateQueries({ queryKey: ["ref", "projects"] });
      setBanner({ kind: "info", text: "Project updated." });
    },
    onError: (err) => setBanner({ kind: "error", text: humanizeError(err) }),
  });

  if (projectQuery.isLoading) {
    return (
      <div className="invenio-page">
        <p className="text-ink-muted">Loading project…</p>
      </div>
    );
  }
  const project = projectQuery.data;
  if (!project) {
    return (
      <div className="invenio-page">
        <div className="invenio-card">
          <h1 className="text-lg font-semibold mb-2">Project not found</h1>
          <Link to="/admin/projects" className="text-brand hover:underline text-sm">
            Back to list
          </Link>
        </div>
      </div>
    );
  }

  const areas = areasQuery.data ?? [];

  return (
    <div className="invenio-page">
      <PageHeader
        title={`${project.number} · ${project.name}`}
        subtitle={`${project.active ? "Active" : "Inactive"} · created ${new Date(project.created_at).toLocaleDateString()}`}
        actions={
          <>
            <button
              className="invenio-btn-secondary"
              disabled={updateProject.isPending}
              onClick={() =>
                updateProject.mutate({ active: !project.active })
              }
            >
              {project.active ? "Deactivate" : "Reactivate"}
            </button>
            <Link to="/admin/projects" className="invenio-btn-secondary">
              Back
            </Link>
          </>
        }
      />
      {banner && <Banner kind={banner.kind}>{banner.text}</Banner>}

      <div className="invenio-card flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Details</h2>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="invenio-label">Number</label>
            <input
              className="invenio-input"
              defaultValue={project.number}
              onBlur={(e) => {
                if (e.target.value !== project.number) {
                  updateProject.mutate({ number: e.target.value });
                }
              }}
            />
          </div>
          <div>
            <label className="invenio-label">Name</label>
            <input
              className="invenio-input"
              defaultValue={project.name}
              onBlur={(e) => {
                if (e.target.value !== project.name) {
                  updateProject.mutate({ name: e.target.value });
                }
              }}
            />
          </div>
        </div>
        <p className="text-xs text-ink-muted">Saves on blur.</p>
      </div>

      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold">Areas ({areas.length})</h2>
          <button
            className="invenio-btn-primary"
            onClick={() => setAddArea(true)}
          >
            + Add area
          </button>
        </div>

        {areas.length === 0 ? (
          <div className="invenio-card">
            <p className="text-ink-muted">No areas yet for this project.</p>
          </div>
        ) : (
          <div className="invenio-card p-0 overflow-hidden">
            <table className="invenio-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {areas.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono text-xs">{a.code}</td>
                    <td>{a.name}</td>
                    <td className="text-right space-x-2">
                      <button
                        className="invenio-btn-secondary text-xs !px-3 !py-1 !min-h-0"
                        onClick={() => setEditArea(a)}
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
      </section>

      {addArea && (
        <AreaModal
          onClose={() => setAddArea(false)}
          tenantId={tenantId}
          projectId={project.id}
          onSuccess={() => {
            setAddArea(false);
            qc.invalidateQueries({ queryKey: ["admin_project_areas", id] });
            qc.invalidateQueries({ queryKey: ["ref", "areas"] });
            setBanner({ kind: "info", text: "Area added." });
          }}
          onError={(err) =>
            setBanner({ kind: "error", text: humanizeError(err) })
          }
        />
      )}
      {editArea && (
        <AreaModal
          area={editArea}
          onClose={() => setEditArea(null)}
          tenantId={tenantId}
          projectId={project.id}
          onSuccess={() => {
            setEditArea(null);
            qc.invalidateQueries({ queryKey: ["admin_project_areas", id] });
            qc.invalidateQueries({ queryKey: ["ref", "areas"] });
            setBanner({ kind: "info", text: "Area saved." });
          }}
          onError={(err) =>
            setBanner({ kind: "error", text: humanizeError(err) })
          }
        />
      )}
    </div>
  );
}

function AreaModal({
  area,
  projectId,
  tenantId,
  onClose,
  onSuccess,
  onError,
}: {
  area?: Area;
  projectId: string;
  tenantId: string | null;
  onClose: () => void;
  onSuccess: () => void;
  onError: (err: unknown) => void;
}) {
  const { register, handleSubmit, formState } = useForm<{
    code: string;
    name: string;
  }>({
    defaultValues: { code: area?.code ?? "", name: area?.name ?? "" },
  });

  const upsert = useMutation({
    mutationFn: async (values: { code: string; name: string }) => {
      if (area) {
        const { error } = await supabase
          .from("areas")
          .update({ code: values.code.trim(), name: values.name.trim() })
          .eq("id", area.id);
        if (error) throw error;
      } else {
        if (!tenantId) throw new Error("No tenant in session");
        const { error } = await supabase.from("areas").insert({
          tenant_id: tenantId,
          project_id: projectId,
          code: values.code.trim(),
          name: values.name.trim(),
        });
        if (error) throw error;
      }
    },
    onSuccess,
    onError,
  });

  const remove = useMutation({
    mutationFn: async () => {
      if (!area) return;
      const { error } = await supabase.from("areas").delete().eq("id", area.id);
      if (error) throw error;
    },
    onSuccess,
    onError,
  });

  return (
    <Modal open onClose={onClose} title={area ? "Edit area" : "Add area"}>
      <form
        className="flex flex-col gap-3"
        onSubmit={handleSubmit((v) => upsert.mutate(v))}
      >
        <div>
          <label className="invenio-label">Code</label>
          <input
            className="invenio-input"
            placeholder="e.g. A-01"
            {...register("code", { required: true })}
          />
        </div>
        <div>
          <label className="invenio-label">Name</label>
          <input
            className="invenio-input"
            {...register("name", { required: true })}
          />
        </div>
        <div className="flex gap-2 justify-between pt-2 border-t border-border">
          {area ? (
            <button
              type="button"
              className="invenio-btn-danger"
              onClick={() => {
                if (
                  confirm(
                    `Delete area ${area.code}? Areas referenced by timesheet lines cannot be deleted.`,
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
