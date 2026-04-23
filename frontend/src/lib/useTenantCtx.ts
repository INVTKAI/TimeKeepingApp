import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { useAuth } from "@/context/AuthContext";
import {
  useEmployees,
  useProjects,
  useSubcontractors,
} from "./referenceData";
import type { TenantContext } from "./importTemplates";

// Gathers the bits of tenant data needed to populate example rows in
// downloadable templates. Returns null until all the underlying queries have
// settled, so callers can `if (!ctx) return null` to wait on the data.
export function useTenantCtx(): TenantContext | null {
  const { claims } = useAuth();
  const { data: projects } = useProjects();
  const { data: subs } = useSubcontractors();
  const { data: employees } = useEmployees();
  const usersQuery = useQuery<{ id: string; username: string }[]>({
    queryKey: ["tenant_users_for_templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, username")
        .eq("status", "active")
        .order("username");
      if (error) throw error;
      return (data ?? []) as { id: string; username: string }[];
    },
  });
  const flowsQuery = useQuery<{ id: string; name: string }[]>({
    queryKey: ["tenant_flows_for_templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("approval_flows")
        .select("id, name")
        .eq("active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });
  if (!projects || !subs || !employees || !usersQuery.data || !flowsQuery.data) {
    return null;
  }
  return {
    projects,
    subs,
    employees,
    users: usersQuery.data,
    flows: flowsQuery.data,
    adminUsername: claims.username,
  };
}
