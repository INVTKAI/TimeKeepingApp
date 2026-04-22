// Approval-subsystem mutations.
//
// Each RPC does its own version check inside a `FOR UPDATE` + conditional
// UPDATE — callers don't pass `p_version`. The P0002 RUN_STATE_CHANGED code
// fires when another actor has moved the run between the client's list
// refresh and this mutation; the UI should refetch and surface it as "state
// moved, try again."
//
// Idempotency keys are generated per action. On network retry the second call
// returns the same cached response (via `_idempotency_begin` on the backend),
// so the action is not double-applied.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import type { PostgrestError } from "./problem";

const PENDING_KEY = ["my_pending_approvals"];

async function rpc<T = unknown>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error as PostgrestError;
  return data as T;
}

export function useApproveRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { run_id: string; comment?: string }) =>
      rpc("approve_run", {
        p_run_id: input.run_id,
        p_comment: input.comment ?? null,
        p_idempotency_key: crypto.randomUUID(),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: PENDING_KEY }),
  });
}

export function useRejectRun() {
  const qc = useQueryClient();
  return useMutation({
    // Spec requires comment on reject.
    mutationFn: (input: { run_id: string; comment: string }) =>
      rpc("reject_run", {
        p_run_id: input.run_id,
        p_comment: input.comment,
        p_idempotency_key: crypto.randomUUID(),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: PENDING_KEY }),
  });
}

export function useReassignRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { run_id: string; to_user_id: string; reason: string }) =>
      rpc("reassign_run", {
        p_run_id: input.run_id,
        p_to_user_id: input.to_user_id,
        p_reason: input.reason,
        p_idempotency_key: crypto.randomUUID(),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: PENDING_KEY }),
  });
}

// ----- Submitter-side mutations (timesheet editors) -----

const TS_LIST_KEY = ["timesheets_list"];

export function useSubmitTimesheet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { timesheet_id: string }) =>
      rpc("submit_timesheet", {
        p_timesheet_id: input.timesheet_id,
        p_idempotency_key: crypto.randomUUID(),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: TS_LIST_KEY }),
  });
}

export function useRecallRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { run_id: string }) =>
      rpc("recall_run", {
        p_run_id: input.run_id,
        p_idempotency_key: crypto.randomUUID(),
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: TS_LIST_KEY }),
  });
}

export function useClaimField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { timesheet_id: string }) =>
      rpc("claim_field_timesheet", { p_timesheet_id: input.timesheet_id }),
    onSettled: () => qc.invalidateQueries({ queryKey: TS_LIST_KEY }),
  });
}

export function useReleaseField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { timesheet_id: string }) =>
      rpc("release_field_timesheet", { p_timesheet_id: input.timesheet_id }),
    onSettled: () => qc.invalidateQueries({ queryKey: TS_LIST_KEY }),
  });
}
