// Tenant-scoped reference data for timesheet editors.
//
// All five lookup tables (projects, areas, task_codes, cwps, fcos) plus
// `employees` are fetched once per mount and cached 5 minutes — small enough
// for any realistic tenant, avoids N dropdown fetches, and refetches on tab
// re-entry keep staleness bounded.
//
// RLS guarantees tenant isolation automatically; we just SELECT.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "./supabase";

export type Project = { id: string; number: string; name: string; active: boolean };
export type Area = {
  id: string;
  project_id: string;
  code: string;
  name: string;
};
export type TaskCode = { id: string; code: string; name: string };
export type Cwp = { id: string; code: string; description: string };
export type Fco = { id: string; code: string; description: string };
export type Subcontractor = {
  id: string;
  name: string;
  short_code: string;
  active: boolean;
};
export type Employee = {
  id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  type: "field" | "staff";
  craft: string | null;
  active: boolean;
  subcontractor_id: string;
};

const STALE = 5 * 60 * 1000; // 5 minutes

async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const { data, error } = await supabase.from(table).select(columns);
  if (error) throw error;
  return (data ?? []) as T[];
}

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ["ref", "projects"],
    queryFn: () => fetchAll<Project>("projects", "id, number, name, active"),
    staleTime: STALE,
  });
}

export function useAreas() {
  return useQuery<Area[]>({
    queryKey: ["ref", "areas"],
    queryFn: () => fetchAll<Area>("areas", "id, project_id, code, name"),
    staleTime: STALE,
  });
}

export function useTaskCodes() {
  return useQuery<TaskCode[]>({
    queryKey: ["ref", "task_codes"],
    queryFn: () => fetchAll<TaskCode>("task_codes", "id, code, name"),
    staleTime: STALE,
  });
}

export function useCwps() {
  return useQuery<Cwp[]>({
    queryKey: ["ref", "cwps"],
    queryFn: () => fetchAll<Cwp>("cwps", "id, code, description"),
    staleTime: STALE,
  });
}

export function useFcos() {
  return useQuery<Fco[]>({
    queryKey: ["ref", "fcos"],
    queryFn: () => fetchAll<Fco>("fcos", "id, code, description"),
    staleTime: STALE,
  });
}

export function useSubcontractors() {
  return useQuery<Subcontractor[]>({
    queryKey: ["ref", "subcontractors"],
    queryFn: () => fetchAll<Subcontractor>(
      "subcontractors",
      "id, name, short_code, active",
    ),
    staleTime: STALE,
  });
}

export function useEmployees() {
  return useQuery<Employee[]>({
    queryKey: ["ref", "employees"],
    queryFn: () =>
      fetchAll<Employee>(
        "employees",
        "id, external_id, first_name, last_name, type, craft, active, subcontractor_id",
      ),
    staleTime: STALE,
  });
}

// Fetch the current user's public.users row — specifically their employee_id,
// which the editor uses to pre-fill the "which employee is this timesheet for"
// default on staff timesheet creation.
export function useMyPublicUser() {
  return useQuery<{ id: string; employee_id: string | null; role: string } | null>({
    queryKey: ["me", "public_users"],
    queryFn: async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user?.id) return null;
      const { data, error } = await supabase
        .from("users")
        .select("id, employee_id, role")
        .eq("id", auth.user.id)
        .single();
      if (error) throw error;
      return data;
    },
    staleTime: STALE,
  });
}

// Returns the canonical Monday for a date (local time — spec is week-Mon to
// week-Sun). Accepts a YYYY-MM-DD string or Date.
export function mondayOf(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : new Date(date);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const offset = day === 0 ? -6 : 1 - day; // shift back to Monday
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
