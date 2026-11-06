import "server-only";
import type { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { integer, object, status, text, timestamp, uuid } from "@/lib/execution/contracts";
import { ExecutionFault, publicError } from "@/lib/execution/errors";
import type { FailureCode } from "@/lib/execution/types";
import { RequestError } from "./http";

type Client = Awaited<ReturnType<typeof requireSuperadmin>>["supabase"];
const FIELDS = "id,original_chain_id,chain_name,chain_slug,status,invocation_count,created_at,started_at,completed_at,deadline_at,error_code,final_text";
const failures = new Set(["input_invalid", "provider_error", "provider_timeout", "output_invalid", "artifact_error", "persistence_error"]);

/** Explicit projection, including for history shared by current superadmins. */
export function projectStatus(value: unknown, steps: unknown, now = Date.now()) {
  const row = object(value), savedStatus = status(row.status);
  const total = integer(row.invocation_count, 1, 5);
  if (!Array.isArray(steps) || steps.length !== total) throw new ExecutionFault("persistence_error");
  const expired = (savedStatus === "prepared" || savedStatus === "running") && timestamp(row.deadline_at) <= now;
  const progress = { total, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, interrupted: 0 };
  const positions = new Set<number>();
  for (const value of steps) {
    const step = object(value), position = integer(step.execution_position, 1, total);
    if (positions.has(position)) throw new ExecutionFault("persistence_error");
    positions.add(position);
    let state = step.status;
    if (expired && state === "pending") state = "skipped";
    if (expired && state === "running") state = "interrupted";
    if (typeof state !== "string" || !["pending", "running", "succeeded", "failed", "skipped", "interrupted"].includes(state)) throw new ExecutionFault("persistence_error");
    progress[state as Exclude<keyof typeof progress, "total">]++;
  }
  const effectiveStatus = expired ? "interrupted" : savedStatus;
  const error = effectiveStatus === "failed" || effectiveStatus === "interrupted"
    ? expired || row.error_code === "execution_expired"
      ? { code: "execution_expired", message: "Execution expired before completion." }
      : publicError(new ExecutionFault(failures.has(String(row.error_code)) ? row.error_code as FailureCode : "persistence_error"))
    : undefined;
  const date = (value: unknown) => value === null ? null : new Date(timestamp(value)).toISOString();
  return {
    runId: uuid(row.id), chain: { id: uuid(row.original_chain_id), name: text(row.chain_name), slug: text(row.chain_slug) },
    status: effectiveStatus, progress,
    createdAt: new Date(timestamp(row.created_at)).toISOString(), startedAt: date(row.started_at), completedAt: date(row.completed_at),
    ...(error ? { error } : {}),
    // Never publish partial/unfinalized output as a successful result.
    ...(effectiveStatus === "succeeded" ? { finalText: text(row.final_text, 32768) } : {}),
  };
}

export async function readRunStatus(client: Client, runId: string, signal: AbortSignal) {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const run = await client.from("prompt_chain_runs").select(FIELDS).eq("id", runId).abortSignal(boundedSignal).maybeSingle();
  if (run.error) throw new ExecutionFault("persistence_error");
  if (!run.data) throw new RequestError(404, "run_not_found", "The generation run was not found.");
  const steps = await client.from("prompt_chain_run_steps").select("execution_position,status").eq("run_id", runId).abortSignal(boundedSignal);
  if (steps.error) throw new ExecutionFault("persistence_error");
  const result = projectStatus(run.data, steps.data);
  if (result.runId !== runId) throw new ExecutionFault("persistence_error");
  return result;
}
