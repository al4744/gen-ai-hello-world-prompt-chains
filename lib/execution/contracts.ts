import "server-only";
import { UUID_PATTERN, SYSTEM_CHAIN_SLUG } from "@/lib/chains/model";
import { ExecutionFault } from "./errors";
import { EXECUTION_BUCKET, EXECUTION_MODEL, LIMITS, type ImageMime, type RunPlan, type RunStatus, type SubmittedContext } from "./types";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ExecutionFault("contract_mismatch");
  return value as Record<string, unknown>;
}
export function text(value: unknown, maximum: number = LIMITS.contextBytes): string {
  if (typeof value !== "string" || value.includes("\0") || !value.isWellFormed() || Buffer.byteLength(value) > maximum) throw new ExecutionFault("contract_mismatch");
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw new ExecutionFault("contract_mismatch");
  return value.toLowerCase();
}
export function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new ExecutionFault("contract_mismatch");
  return value;
}
export function status(value: unknown): RunStatus {
  if (typeof value !== "string" || !["prepared", "running", "succeeded", "failed", "interrupted"].includes(value)) throw new ExecutionFault("contract_mismatch");
  return value as RunStatus;
}
export function timestamp(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ExecutionFault("contract_mismatch");
  return Date.parse(value);
}
export function imageMime(value: unknown): ImageMime {
  if (value !== "image/jpeg" && value !== "image/png" && value !== "image/webp") throw new ExecutionFault("contract_mismatch");
  return value;
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new ExecutionFault("contract_mismatch");
  return value;
}
function config(value: unknown) {
  const entry = object(value);
  if (entry.provider !== "openrouter" || entry.max_completion_tokens !== 2000 || Object.keys(entry).length !== 2) throw new ExecutionFault("contract_mismatch");
  return { provider: "openrouter", max_completion_tokens: 2000 } as const;
}

export function parseRun(value: unknown, userId: string): RunPlan {
  const row = object(value), user = uuid(userId);
  if (row.creator_id !== user || row.creator_id_snapshot !== user) throw new ExecutionFault("access_denied");
  const id = uuid(row.id), originalChainId = uuid(row.original_chain_id);
  const currentChainId = row.current_chain_id === null ? null : uuid(row.current_chain_id);
  if (currentChainId && currentChainId !== originalChainId) throw new ExecutionFault("contract_mismatch");
  if (!Array.isArray(row.step_snapshot) || row.step_snapshot.length < 1 || row.step_snapshot.length > 5
      || Buffer.byteLength(JSON.stringify(row.step_snapshot)) > 65_536) throw new ExecutionFault("contract_mismatch");
  const steps = row.step_snapshot.map(value => {
    const step = object(value);
    return { id: uuid(step.id), step_order: integer(step.step_order, 1, 2147483647), name: text(step.name), prompt_template: text(step.prompt_template) };
  });
  if (new Set(steps.map(step => step.id)).size !== steps.length || steps.some((step, i) => i > 0 && step.step_order <= steps[i - 1].step_order)) throw new ExecutionFault("contract_mismatch");
  const slug = text(row.chain_slug), mode = slug === SYSTEM_CHAIN_SLUG ? "composed" : "sequential";
  const invocations = mode === "composed" ? 1 : steps.length;
  if (row.execution_mode !== mode || row.invocation_count !== invocations || row.execution_version !== 1
      || row.requested_model !== EXECUTION_MODEL || (mode === "composed" && (steps.length !== 4 || steps.some((step, i) => step.step_order !== i + 1)))) throw new ExecutionFault("contract_mismatch");
  config(row.request_config);
  const mime = imageMime(row.input_mime), prefix = `${user}/${id}`;
  const expectedPath = `${prefix}/input.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`;
  if (row.input_path !== expectedPath || row.artifact_path !== `${prefix}/captioned.png`) throw new ExecutionFault("contract_mismatch");
  const userContext = text(row.user_context, 2000);
  if (Array.from(userContext).length > 500) throw new ExecutionFault("contract_mismatch");
  const plan: RunPlan = {
    id, creatorId: user, originalChainId, currentChainId, slug, mode, steps, invocations,
    input: { path: expectedPath, mime, size: integer(row.input_size_bytes, 1, LIMITS.imageBytes), sha256: sha(row.input_sha256) },
    artifactPath: `${prefix}/captioned.png`, userContext, status: status(row.status), deadline: timestamp(row.deadline_at),
    finalText: row.final_text === null ? null : text(row.final_text, LIMITS.outputBytes),
    artifactSha256: row.artifact_sha256 === null ? null : sha(row.artifact_sha256),
    artifactSize: row.artifact_size_bytes === null ? null : integer(row.artifact_size_bytes, 1, LIMITS.imageBytes),
  };
  if (plan.status === "succeeded" && (!plan.finalText || !plan.artifactSha256 || !plan.artifactSize)) throw new ExecutionFault("contract_mismatch");
  return plan;
}

/** Validate the RPC envelope; never re-compose the default prompt here. */
export function parseContext(value: unknown, plan: RunPlan, position: number, prior: string[]): SubmittedContext {
  const context = object(value), image = object(context.image);
  const prompt = text(context.prompt);
  if (context.user_context !== plan.userContext || image.bucket !== EXECUTION_BUCKET || image.path !== plan.input.path
      || image.mime !== plan.input.mime || image.sha256 !== plan.input.sha256 || context.requested_model !== EXECUTION_MODEL
      || !Array.isArray(context.previous_outputs) || context.previous_outputs.length !== position - 1
      || prior.length !== position - 1 || (plan.mode === "sequential" && prompt !== plan.steps[position - 1].prompt_template)) throw new ExecutionFault("contract_mismatch");
  const previous = context.previous_outputs.map((value, index) => {
    const output = object(value);
    if (output.position !== index + 1 || output.source_step_id !== plan.steps[index].id || output.output_text !== prior[index]) throw new ExecutionFault("contract_mismatch");
    return { position: index + 1, source_step_id: plan.steps[index].id, output_text: prior[index] };
  });
  const parsed: SubmittedContext = { prompt, user_context: plan.userContext,
    image: { bucket: EXECUTION_BUCKET, path: plan.input.path, mime: plan.input.mime, sha256: plan.input.sha256 },
    previous_outputs: previous, requested_model: EXECUTION_MODEL, request_config: config(context.request_config) };
  if (Buffer.byteLength(prompt) + Buffer.byteLength(JSON.stringify({ user_context: parsed.user_context, previous_outputs: previous })) > LIMITS.contextBytes) throw new ExecutionFault("output_invalid");
  return parsed;
}

export function validateOutput(mode: RunPlan["mode"], output: string): boolean {
  if (!output.trim() || output.includes("\0") || !output.isWellFormed() || Buffer.byteLength(output) > LIMITS.outputBytes) return false;
  if (mode === "sequential") return true;
  try {
    const parsed = object(JSON.parse(output));
    return Object.keys(parsed).length === 2 && typeof parsed.caption_a === "string" && typeof parsed.caption_b === "string"
      && !parsed.caption_a.includes("\0") && !parsed.caption_b.includes("\0") && parsed.caption_a.isWellFormed() && parsed.caption_b.isWellFormed()
      && Boolean(parsed.caption_a.trim()) && Boolean(parsed.caption_b.trim()) && parsed.caption_a.trim() !== parsed.caption_b.trim();
  } catch { return false; }
}
