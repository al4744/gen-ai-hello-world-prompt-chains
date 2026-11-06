import "server-only";
import type { requireSuperadmin } from "@/lib/auth/require-superadmin";
import { readLimited } from "./budget";
import { imageMime, integer, object, parseRun, sha, status, timestamp, uuid } from "./contracts";
import { ExecutionFault } from "./errors";
import { EXECUTION_BUCKET, LIMITS, type ExecutionPersistence, type ExecutionStorage, type ProviderMetadata, type Transition } from "./types";

type Client = Awaited<ReturnType<typeof requireSuperadmin>>["supabase"];
// Explicit column grants exclude the internal lease hash. Never SELECT *.
const RUN_FIELDS = "id,creator_id,creator_id_snapshot,original_chain_id,current_chain_id,chain_slug,step_snapshot,execution_mode,execution_version,invocation_count,input_path,input_mime,input_size_bytes,input_sha256,artifact_path,user_context,status,deadline_at,requested_model,request_config,final_text,artifact_sha256,artifact_size_bytes";
const META_FIELDS = ["actual_model", "provider_response_id", "provider_http_status", "finish_reason", "prompt_tokens", "completion_tokens", "total_tokens", "cost_usd", "output_text"] as const;

export function providerFields(metadata: ProviderMetadata): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  for (const name of META_FIELDS) {
    const value = metadata[name]; if (value !== undefined) result[name] = value;
  }
  return result;
}

export function createExecutionPersistence(client: Client, userId: string): ExecutionPersistence {
  async function rpc(name: "prepare_prompt_chain_run_v1" | "advance_prompt_chain_run_v1", args: Record<string, unknown>, signal: AbortSignal) {
    try {
      const { data, error } = await client.rpc(name, args).abortSignal(signal);
      if (error) throw new ExecutionFault("persistence_error");
      return object(data);
    } catch (error) { throw error instanceof ExecutionFault ? error : new ExecutionFault("persistence_error"); }
  }
  return {
    async prepare(input, signal) {
      const receipt = await rpc("prepare_prompt_chain_run_v1", {
        p_chain_id: uuid(input.chainId), p_idempotency_key: uuid(input.idempotencyKey),
        p_input_mime: imageMime(input.mime), p_input_size_bytes: integer(input.size, 1, LIMITS.imageBytes),
        p_input_sha256: sha(input.sha256), p_user_context: input.userContext,
      }, signal);
      return { runId: uuid(receipt.run_id), status: status(receipt.status) };
    },
    async load(runId, signal) {
      try {
        const { data, error } = await client.from("prompt_chain_runs").select(RUN_FIELDS).eq("id", uuid(runId)).abortSignal(signal).maybeSingle();
        if (error || !data) throw new ExecutionFault("persistence_error");
        const plan = parseRun(data, userId);
        if (plan.id !== uuid(runId)) throw new ExecutionFault("contract_mismatch");
        return plan;
      } catch (error) { throw error instanceof ExecutionFault ? error : new ExecutionFault("persistence_error"); }
    },
    async advance(runId, command, signal) {
      const payload = command.operation === "expire" ? {} : command.operation === "complete_step"
        ? { ...providerFields(command.payload), position: command.payload.position }
        : command.operation === "fail" ? { ...providerFields(command.payload), error_code: command.payload.error_code } : command.payload;
      const receipt = await rpc("advance_prompt_chain_run_v1", {
        p_run_id: uuid(runId), p_operation: command.operation,
        p_lease_token: "token" in command ? command.token ?? null : null, p_payload: payload,
      }, signal);
      if (receipt.run_id !== runId || typeof receipt.accepted !== "boolean") throw new ExecutionFault("contract_mismatch");
      const transition: Transition = { runId: uuid(receipt.run_id), status: status(receipt.status), accepted: receipt.accepted };
      if (command.operation === "claim" && transition.accepted) {
        if (transition.status !== "running" || typeof receipt.lease_token !== "string" || !/^[a-f0-9]{64}$/.test(receipt.lease_token)) throw new ExecutionFault("contract_mismatch");
        transition.token = receipt.lease_token; transition.deadline = timestamp(receipt.deadline_at);
      }
      if (command.operation === "start_step" && transition.accepted) transition.context = receipt.submitted_context;
      return transition;
    },
  };
}

/** Fixed bucket/path inputs come only from the validated database plan. */
export function createExecutionStorage(client: Client): ExecutionStorage {
  return {
    async readInput(plan, signal) {
      try {
        const { data, error } = await client.storage.from(EXECUTION_BUCKET).download(plan.input.path, {}, { signal, cache: "no-store" }).asStream();
        if (error || !data) throw new ExecutionFault("input_invalid");
        const bytes = await readLimited(data, Math.min(plan.input.size, LIMITS.imageBytes), signal, "input_invalid");
        if (bytes.byteLength !== plan.input.size) throw new ExecutionFault("input_invalid");
        return bytes;
      } catch (error) { throw error instanceof ExecutionFault ? error : new ExecutionFault("input_invalid"); }
    },
    async storeArtifact(plan, image, signal) {
      if (signal.aborted) throw new ExecutionFault("cancelled");
      if (image.mime !== "image/png" || image.size > LIMITS.imageBytes) throw new ExecutionFault("artifact_error");
      try {
        // This SDK upload API has no AbortSignal option. The runner bounds its
        // wait and never finalizes a late upload; an orphan stays private.
        const { data, error } = await client.storage.from(EXECUTION_BUCKET).upload(plan.artifactPath, image.bytes,
          { contentType: "image/png", cacheControl: "0", upsert: false });
        if (error || !data || data.path !== plan.artifactPath || !data.id || signal.aborted) throw new ExecutionFault("artifact_error");
      } catch (error) { throw error instanceof ExecutionFault ? error : new ExecutionFault("artifact_error"); }
    },
  };
}
