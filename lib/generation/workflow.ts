"use client";

import { uploadPreparedInput } from "./upload";
import { SYSTEM_CHAIN_SLUG, UUID_PATTERN } from "@/lib/chains/model";
import type { projectStatus } from "./status";

export type GenerationChain = { id: string; name: string; slug: string; description: string; stepCount: number | null };
export type RunView = ReturnType<typeof projectStatus>;
type Phase = "idle" | "hashing" | "preparing" | "uploading" | "executing" | "checking" | "error" | "uncertain" | "unavailable" | RunView["status"];
export type WorkflowState = {
  phase: Phase; busy: boolean; message: string; serviceDisabled: boolean;
  runId?: string; run?: RunView; mediaUrl?: string; mediaError?: string;
};
const initial: WorkflowState = { phase: "idle", busy: false, message: "", serviceDisabled: false };
const messages = {
  disabled: "Generation is not currently enabled. You can explore chains and preview an image here.",
  configuration: "Generation is currently unavailable. Your run has not been confirmed as started. Refresh this page after configuration is updated.",
  chain: "Choose a prompt chain with executable steps.",
  image: "Choose an image before generating.",
  type: "Please choose a JPEG, PNG, or WebP image.",
  size: "Choose a nonempty image no larger than 5 MiB.",
  context: "Context must contain at most 500 characters and no invalid control characters.",
  prepare: "The run could not be prepared. Your inputs are preserved; submitting the same inputs again uses the same preparation key.",
  upload: "The image could not be uploaded. Check your session. An existing input cannot be overwritten; Generate again creates a new run.",
  access: "Your session or superadmin access could not be verified. Sign in again before continuing.",
  uncertain: "The run could not be confirmed. Check its status before starting another generation. Execution will not be retried.",
  media: "Your generation is saved, but its image could not be loaded. Try loading the saved image again.",
};

export function imageError(file: Pick<File, "type" | "size"> | null): string | null {
  if (!file) return messages.image;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return messages.type;
  return !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 5242880 ? messages.size : null;
}
export function contextError(context: string) {
  return !context.isWellFormed() || context.includes("\0") || Array.from(context).length > 500
    || new TextEncoder().encode(context).length > 2000 ? messages.context : null;
}
export function executableChain(chain?: GenerationChain) {
  return !!chain && UUID_PATTERN.test(chain.id) && (chain.stepCount === null || (chain.slug === SYSTEM_CHAIN_SLUG ? chain.stepCount === 4 : chain.stepCount >= 1 && chain.stepCount <= 5));
}
export function defaultChainId(chains: GenerationChain[]) {
  return (chains.find(chain => chain.slug === SYSTEM_CHAIN_SLUG && executableChain(chain)) ?? chains.find(executableChain))?.id ?? "";
}
export function canStart(state: WorkflowState, enabled: boolean) {
  return enabled && !state.serviceDisabled && !state.busy && !["running", "prepared", "uncertain"].includes(state.phase);
}
export function defaultCaptions(run: RunView) {
  if (run.status !== "succeeded" || run.chain.slug !== SYSTEM_CHAIN_SLUG || !run.finalText) return null;
  try {
    const data = JSON.parse(run.finalText);
    return data && Object.keys(data).length === 2 && typeof data.caption_a === "string" && typeof data.caption_b === "string"
      ? [data.caption_a, data.caption_b] as [string, string] : null;
  } catch { return null; }
}

class WorkflowError extends Error {}
const runErrors = {
  input_invalid: "The input image or context could not be verified. Choose a valid image before generating again.",
  provider_error: "The AI provider could not complete this run. Completed steps remain saved.",
  provider_timeout: "An AI request ran out of time. Completed steps remain saved; execution is not retried.",
  output_invalid: "The generated text did not meet the chain's output requirements.",
  artifact_error: "The text was saved, but the captioned image could not be rendered legibly within safe limits or saved.",
  persistence_error: "This run failed. Its completed steps remain saved.",
  execution_expired: "This run expired or was interrupted before completion.",
};
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function runView(value: unknown, id: string): RunView {
  const row = record(value), chain = record(row.chain), progress = record(row.progress);
  const states = ["prepared", "running", "succeeded", "failed", "interrupted"];
  const counts = ["pending", "running", "succeeded", "failed", "skipped", "interrupted"];
  if (row.runId !== id || !states.includes(String(row.status)) || typeof chain.id !== "string" || !UUID_PATTERN.test(chain.id)
      || typeof chain.name !== "string" || typeof chain.slug !== "string" || !Number.isInteger(progress.total) || Number(progress.total) < 1 || Number(progress.total) > 5
      || counts.some(key => !Number.isInteger(progress[key]) || Number(progress[key]) < 0)
      || counts.reduce((sum, key) => sum + Number(progress[key]), 0) !== progress.total
      || (row.status === "succeeded" && (typeof row.finalText !== "string" || !row.finalText.trim() || new TextEncoder().encode(row.finalText).length > 32768))) {
    throw new WorkflowError(messages.uncertain);
  }
  // Do not retain arbitrary diagnostics or error messages from a response.
  const savedCode = record(row.error).code;
  const code = typeof savedCode === "string" && Object.hasOwn(runErrors, savedCode) ? savedCode as keyof typeof runErrors : "persistence_error";
  return { runId: id, status: row.status as RunView["status"],
    chain: { id: chain.id, name: chain.name, slug: chain.slug }, progress: { total: Number(progress.total), pending: Number(progress.pending),
      running: Number(progress.running), succeeded: Number(progress.succeeded), failed: Number(progress.failed), skipped: Number(progress.skipped), interrupted: Number(progress.interrupted) },
    createdAt: String(row.createdAt ?? ""), startedAt: typeof row.startedAt === "string" ? row.startedAt : null,
    completedAt: typeof row.completedAt === "string" ? row.completedAt : null,
    ...(row.status === "succeeded" ? { finalText: row.finalText as string } : {}),
    ...(row.status === "failed" || row.status === "interrupted" ? { error: { code, message:
      row.status === "interrupted" ? runErrors.execution_expired : runErrors[code] } } : {}),
  };
}

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error("Cancelled")); return; }
  const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  signal.addEventListener("abort", abort, { once: true });
});

/** Browser orchestration only. The existing server engine/RPCs own execution. */
export function createGenerationWorkflow(options: {
  enabled: boolean; fetch?: typeof fetch; upload?: typeof uploadPreparedInput;
  randomUUID?: () => string; digest?: (bytes: ArrayBuffer) => Promise<string>;
  sleep?: typeof pause; now?: () => number; urls?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  onRunId?: (id?: string) => void;
}) {
  const fetcher = options.fetch ?? ((...args) => fetch(...args));
  const upload = options.upload ?? uploadPreparedInput, urls = options.urls ?? URL;
  const now = options.now ?? (() => performance.now());
  let state = initial, locked = false, disposed = false, serial = 0, active: AbortController | undefined;
  let pending: { fingerprint: string; key: string } | undefined;
  const listeners = new Set<() => void>();
  const rememberId = (id?: string) => { try { options.onRunId?.(id); } catch { /* URL persistence can be blocked; the in-memory run remains usable. */ } };
  const update = (patch: Partial<WorkflowState>) => { if (!disposed) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); } };
  const releaseMedia = () => { if (state.mediaUrl) urls.revokeObjectURL(state.mediaUrl); };
  function begin() {
    if (locked || disposed) return null;
    locked = true; const number = ++serial; active = new AbortController();
    const signal = active.signal;
    update({ busy: true });
    return { signal, check() { if (disposed || serial !== number || signal.aborted) throw new Error("Cancelled"); },
      finish() { if (!disposed && serial === number) { locked = false; update({ busy: false }); } } };
  }
  async function jsonRequest(path: string, method: "GET" | "POST", signal: AbortSignal, body?: unknown, timeout = 7000) {
    const response = await fetcher(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    if (response.status === 401 || response.status === 403) throw new WorkflowError(messages.access);
    return { ok: response.ok, body: record(await response.json()) };
  }
  async function media(id: string, operation: NonNullable<ReturnType<typeof begin>>) {
    try {
      const response = await fetcher(`/api/generation/runs/${id}/media`, { credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "image/png") throw new Error("Invalid media");
      const blob = await response.blob(); operation.check();
      if (blob.size < 1 || blob.size > 5242880) throw new Error("Invalid size");
      const header = new Uint8Array(await blob.slice(0, 8).arrayBuffer()); operation.check();
      if (header.join(",") !== "137,80,78,71,13,10,26,10") throw new Error("Invalid image");
      releaseMedia(); update({ mediaUrl: urls.createObjectURL(blob), mediaError: undefined });
    } catch { operation.check(); update({ mediaError: messages.media }); }
  }
  async function poll(id: string, operation: NonNullable<ReturnType<typeof begin>>, waitForStart: boolean) {
    const stop = now() + 150000;
    for (let attempt = 0; attempt < 60 && now() < stop; attempt++) {
      operation.check();
      const response = await jsonRequest(`/api/generation/runs/${id}`, "GET", operation.signal);
      operation.check();
      if (!response.ok) throw new WorkflowError(messages.uncertain);
      const run = runView(response.body, id);
      update({ run, phase: run.status, message: run.status === "succeeded" ? "Generation saved successfully."
        : run.error?.message ?? (run.status === "prepared" ? "This run is prepared or still starting. Execution is never automatically retried."
          : `${run.progress.succeeded} of ${run.progress.total} AI steps complete. Rendering and saving follow the final step.`) });
      if (run.status === "succeeded") { await media(id, operation); return; }
      if (run.status === "failed" || run.status === "interrupted" || (run.status === "prepared" && !waitForStart)) return;
      await (options.sleep ?? pause)(2000, operation.signal);
    }
    update({ message: "Status checking has paused. This run may still be active. Check again; execution will not be replayed." });
  }
  async function observeExecution(id: string, operation: NonNullable<ReturnType<typeof begin>>, stop: AbortSignal) {
    const signal = AbortSignal.any([operation.signal, stop]);
    const deadline = now() + 150000;
    try {
      for (let attempt = 0; attempt < 60 && now() < deadline; attempt++) {
        // No extra read for fast executions; cancel this observer with the POST.
        await pause(2000, signal);
        const response = await jsonRequest(`/api/generation/runs/${id}`, "GET", signal);
        operation.check();
        if (signal.aborted || !response.ok) return;
        const run = runView(response.body, id);
        if (run.status !== "prepared" && run.status !== "running") return;
        update({ run, message: run.status === "prepared" ? "Verifying the uploaded image before execution…"
          : run.progress.succeeded === run.progress.total ? "All AI steps are saved. Rendering and saving the captioned image…"
          : `${run.progress.succeeded} of ${run.progress.total} AI steps complete.` });
      }
    } catch { /* Progress is optional; authoritative readback still follows the POST. */ }
  }
  const recoverError = (error: unknown, operation: NonNullable<ReturnType<typeof begin>>, phase: "error" | "uncertain") => {
    try { operation.check(); } catch { return; }
    update({ phase, message: error instanceof WorkflowError ? error.message : phase === "uncertain" ? messages.uncertain : messages.prepare });
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => state,
    activate() { disposed = false; },
    dispose() { disposed = true; serial++; active?.abort(); locked = false; releaseMedia(); state = initial; },
    reset() {
      if (locked) return;
      releaseMedia(); state = { ...initial, serviceDisabled: state.serviceDisabled }; pending = undefined;
      rememberId(); update({});
    },
    async start(input: { chain: GenerationChain | undefined; file: File | null; userContext: string }) {
      if (locked || disposed) return;
      if (!options.enabled || state.serviceDisabled) { update({ phase: "unavailable", serviceDisabled: true, message: messages.disabled }); return; }
      if (!canStart(state, options.enabled)) return;
      const error = !executableChain(input.chain) ? messages.chain : imageError(input.file) ?? contextError(input.userContext);
      if (error) { update({ phase: "error", message: error }); return; }
      const operation = begin()!;
      let executionSent = false;
      releaseMedia(); update({ phase: "hashing", run: undefined, runId: undefined, mediaUrl: undefined, mediaError: undefined, message: "Checking your image…" });
      rememberId();
      try {
        const file = input.file!, bytes = await file.arrayBuffer(); operation.check();
        const sha256 = await (options.digest ?? (async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte => byte.toString(16).padStart(2, "0")).join("")))(bytes);
        operation.check();
        const image = { mime: file.type, size: file.size, sha256 };
        const fingerprint = JSON.stringify([input.chain!.id, image, input.userContext]);
        if (pending?.fingerprint !== fingerprint) pending = { fingerprint, key: (options.randomUUID ?? (() => crypto.randomUUID()))() };
        update({ phase: "preparing", message: "Preparing your selected prompt chain…" });
        const prepared = await jsonRequest("/api/generation/runs", "POST", operation.signal, { chainId: input.chain!.id,
          idempotencyKey: pending.key, image, userContext: input.userContext }, 25000);
        operation.check();
        if (!prepared.ok || typeof prepared.body.runId !== "string" || !UUID_PATTERN.test(prepared.body.runId)) throw new WorkflowError(messages.prepare);
        const id = prepared.body.runId.toLowerCase();
        pending = undefined; update({ runId: id }); rememberId(id);
        if (prepared.body.status !== "prepared") { await poll(id, operation, false); return; }
        const descriptor = record(prepared.body.upload);
        if (typeof descriptor.bucket !== "string" || typeof descriptor.path !== "string" || typeof descriptor.contentType !== "string") throw new WorkflowError(messages.prepare);
        update({ phase: "uploading", message: "Uploading your image securely…" });
        const uploadStop = new AbortController();
        let uploaded;
        try {
          uploaded = await Promise.race([
            upload({ runId: id, status: "prepared", upload: { bucket: descriptor.bucket, path: descriptor.path, contentType: descriptor.contentType } }, image, file),
            pause(60000, AbortSignal.any([operation.signal, uploadStop.signal])).then(() => { throw new WorkflowError(messages.upload); }),
          ]);
        } finally { uploadStop.abort(); }
        operation.check();
        if (!uploaded.ok) throw new WorkflowError(messages.upload);
        update({ phase: "executing", message: "Running your prompt chain, then rendering and saving the captioned image…" });
        executionSent = true;
        let response;
        const progressStop = new AbortController();
        const progress = observeExecution(id, operation, progressStop.signal);
        try { response = await jsonRequest(`/api/generation/runs/${id}/execute`, "POST", operation.signal, {}, 150000); }
        catch { operation.check(); /* Lost execution acknowledgement: read only. */ }
        finally { progressStop.abort(); await progress; }
        operation.check();
        const code = record(response?.body.error).code;
        if (code === "generation_disabled" || code === "provider_not_configured" || code === "renderer_unavailable") {
          update({ phase: "unavailable", serviceDisabled: true, message: code === "generation_disabled" ? messages.disabled : messages.configuration }); return;
        }
        await poll(id, operation, !response);
      } catch (error) { recoverError(error, operation, executionSent ? "uncertain" : "error"); }
      finally { operation.finish(); }
    },
    async resume(id: string) {
      if (!UUID_PATTERN.test(id)) { update({ phase: "error", message: messages.uncertain }); return; }
      const operation = begin(); if (!operation) return;
      update({ runId: id.toLowerCase(), phase: "checking", message: "Checking the saved run…", mediaError: undefined });
      try { await poll(id.toLowerCase(), operation, false); }
      catch (error) { recoverError(error, operation, "uncertain"); }
      finally { operation.finish(); }
    },
    async loadMedia() {
      if (state.run?.status !== "succeeded") return;
      const operation = begin(); if (!operation) return;
      try { await media(state.run.runId, operation); } catch { /* Disposed/cancelled read; no execution is retried. */ } finally { operation.finish(); }
    },
    mediaFailed() { releaseMedia(); update({ mediaUrl: undefined, mediaError: messages.media }); },
  };
}
