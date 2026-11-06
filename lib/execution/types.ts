import "server-only";

export const EXECUTION_BUCKET = "prompt-chain-execution-media";
export const EXECUTION_MODEL = "openrouter/free";
export const LIMITS = {
  imageBytes: 5_242_880, pixels: 20_000_000, dimension: 8192,
  outputBytes: 32_768, providerBodyBytes: 131_072, contextBytes: 65_536,
  completionTokens: 2000, leaseMs: 120_000, providerMs: 20_000,
  ioMs: 5000, finalReserveMs: 30_000, cleanupMs: 5000, minProviderMs: 5000,
} as const;

export type ImageMime = "image/jpeg" | "image/png" | "image/webp";
export type RunStatus = "prepared" | "running" | "succeeded" | "failed" | "interrupted";
export type FailureCode = "input_invalid" | "provider_error" | "provider_timeout" | "output_invalid" | "artifact_error" | "persistence_error";
export type ErrorCode = FailureCode | "access_denied" | "contract_mismatch" | "provider_not_configured" | "generation_disabled"
  | "renderer_unavailable" | "cancelled" | "deadline_exceeded" | "execution_conflict";
export type StepSnapshot = { id: string; step_order: number; name: string; prompt_template: string };
export type RunPlan = {
  id: string; creatorId: string; originalChainId: string; currentChainId: string | null;
  slug: string; mode: "composed" | "sequential"; steps: StepSnapshot[]; invocations: number;
  input: { path: string; mime: ImageMime; size: number; sha256: string };
  artifactPath: string; userContext: string; status: RunStatus; deadline: number;
  finalText: string | null; artifactSha256: string | null; artifactSize: number | null;
};
export type SubmittedContext = {
  prompt: string; user_context: string;
  image: { bucket: typeof EXECUTION_BUCKET; path: string; mime: ImageMime; sha256: string };
  previous_outputs: { position: number; source_step_id: string; output_text: string }[];
  requested_model: typeof EXECUTION_MODEL;
  request_config: { provider: "openrouter"; max_completion_tokens: 2000 };
};
export type ValidatedImage = {
  bytes: Uint8Array; mime: ImageMime; size: number; sha256: string; width: number; height: number;
};
export type ProviderMetadata = {
  actual_model?: string; provider_response_id?: string; provider_http_status?: number;
  finish_reason?: string; prompt_tokens?: number; completion_tokens?: number;
  total_tokens?: number; cost_usd?: number; output_text?: string;
};
export type ProviderResult = ProviderMetadata & { actual_model: string; output_text: string };
export type Command =
  | { operation: "claim"; payload: { verified_input_sha256: string } }
  | { operation: "start_step"; token: string; payload: { position: number } }
  | { operation: "complete_step"; token: string; payload: ProviderResult & { position: number } }
  | { operation: "finalize"; token: string; payload: { artifact_sha256: string } }
  | { operation: "fail"; token?: string; payload: ProviderMetadata & { error_code: FailureCode } }
  | { operation: "expire" };
export type Transition = {
  runId: string; status: RunStatus; accepted: boolean;
  token?: string; deadline?: number; context?: unknown;
};
export type PrepareMetadata = {
  chainId: string; idempotencyKey: string; mime: ImageMime; size: number; sha256: string; userContext: string;
};
export interface ExecutionPersistence {
  prepare(input: PrepareMetadata, signal: AbortSignal): Promise<{ runId: string; status: RunStatus }>;
  load(runId: string, signal: AbortSignal): Promise<RunPlan>;
  advance(runId: string, command: Command, signal: AbortSignal): Promise<Transition>;
}
export interface ExecutionStorage {
  readInput(plan: RunPlan, signal: AbortSignal): Promise<Uint8Array>;
  storeArtifact(plan: RunPlan, image: ValidatedImage, signal: AbortSignal): Promise<void>;
}
export interface ExecutionProvider {
  checkConfigured(): void;
  generate(context: SubmittedContext, image: ValidatedImage, mode: RunPlan["mode"], signal: AbortSignal): Promise<ProviderResult>;
}
export interface ArtifactRenderer {
  render(input: { image: ValidatedImage; finalText: string; mode: RunPlan["mode"]; signal: AbortSignal }): Promise<Uint8Array>;
}
export interface ExecutionSession { userId: string; persistence: ExecutionPersistence; storage: ExecutionStorage }
export interface Clock {
  now(): number;
  monotonic(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
}
export type ExecutionResult = {
  runId: string; status: RunStatus | "unknown" | "unavailable";
  error?: { code: ErrorCode; message: string };
};
