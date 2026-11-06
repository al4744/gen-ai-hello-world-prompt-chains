import "server-only";
import { bounded, ExecutionBudget, systemClock } from "./budget";
import { imageMime, integer, parseContext, sha, text, uuid, validateOutput } from "./contracts";
import { ExecutionFault, fault, publicError } from "./errors";
import { validateImage } from "./images";
import { EXECUTION_BUCKET, LIMITS, type ArtifactRenderer, type Clock, type ExecutionProvider,
  type ExecutionResult, type ExecutionSession, type FailureCode, type ProviderMetadata, type RunPlan, type Transition } from "./types";

export type PrepareInput = { chainId: string; idempotencyKey: string;
  image: { mime: string; size: number; sha256: string }; userContext?: string };
export type PreparationResult = ExecutionResult & { upload?: { bucket: string; path: string; contentType: string } };

/** Internal server factory: authorization is mandatory, never supplied by a browser. */
export function createExecutionEngine(dependencies: {
  authorize: () => Promise<ExecutionSession>; provider: ExecutionProvider; renderer?: ArtifactRenderer;
  clock?: Clock; hostBudgetMs?: number;
}) {
  const clock = dependencies.clock ?? systemClock;
  const authorize = async () => {
    try { return await dependencies.authorize(); }
    catch { throw new ExecutionFault("access_denied"); }
  };
  const result = (runId: string, status: ExecutionResult["status"], error?: ExecutionFault): ExecutionResult =>
    ({ runId, status, ...(error ? { error: publicError(error) } : {}) });

  async function prepare(input: PrepareInput, options: { signal?: AbortSignal } = {}): Promise<PreparationResult> {
    let runId = "";
    const budget = new ExecutionBudget(clock, dependencies.hostBudgetMs);
    try {
      const session = await bounded(clock, budget.io(), options.signal, "deadline_exceeded", authorize);
      let metadata;
      try {
        const context = text(input.userContext ?? "", 2000);
        if (Array.from(context).length > 500) throw new ExecutionFault("input_invalid");
        metadata = { chainId: uuid(input.chainId), idempotencyKey: uuid(input.idempotencyKey),
          mime: imageMime(input.image.mime), size: integer(input.image.size, 1, LIMITS.imageBytes),
          sha256: sha(input.image.sha256), userContext: context };
      } catch { throw new ExecutionFault("input_invalid"); }
      // This is declared upload metadata only. execute() independently downloads,
      // decodes and hashes the actual stored object before it can claim a run.
      const receipt = await bounded(clock, budget.io(), options.signal, "persistence_error", signal => session.persistence.prepare(metadata, signal));
      runId = receipt.runId;
      const plan = await bounded(clock, budget.io(), options.signal, "persistence_error", signal => session.persistence.load(runId, signal));
      if (plan.creatorId !== session.userId || plan.originalChainId !== metadata.chainId) throw new ExecutionFault("access_denied");
      return { ...result(runId, plan.status), ...(plan.status === "prepared"
        ? { upload: { bucket: EXECUTION_BUCKET, path: plan.input.path, contentType: plan.input.mime } } : {}) };
    } catch (error) { return result(runId, runId ? "unknown" : "unavailable", fault(error)); }
  }

  async function execute(runId: string, options: { signal?: AbortSignal } = {}): Promise<ExecutionResult> {
    const budget = new ExecutionBudget(clock, dependencies.hostBudgetMs);
    let session: ExecutionSession | undefined, plan: RunPlan | undefined, token: string | undefined;
    let stage: "input" | "claim" | "step" | "provider" | "artifact" | "finalize" = "input";
    let providerMetadata: ProviderMetadata | undefined, transitionRefused = false, finalized = false;
    let storedArtifact: { sha256: string; size: number; finalText: string } | undefined;
    const io = <T>(work: (signal: AbortSignal) => Promise<T>, code: "persistence_error" | "input_invalid" | "artifact_error" = "persistence_error") =>
      bounded(clock, budget.io(), options.signal, code, work);
    const accepted = (transition: Transition) => {
      if (!transition.accepted) { transitionRefused = true; throw new ExecutionFault("execution_conflict"); }
      return transition;
    };
    const reauthorize = async () => {
      const fresh = await io(authorize);
      if (fresh.userId !== session!.userId) throw new ExecutionFault("access_denied");
      session = fresh;
    };
    try {
      session = await io(authorize);
      runId = uuid(runId);
      plan = await io(signal => session!.persistence.load(runId, signal));
      if (plan.creatorId !== session.userId) throw new ExecutionFault("access_denied");
      if (plan.status !== "prepared") {
        if (plan.status === "running" && plan.deadline <= clock.now()) await io(signal => session!.persistence.advance(runId, { operation: "expire" }, signal));
        const current = await io(signal => session!.persistence.load(runId, signal));
        return result(runId, current.status, current.status === "running" ? new ExecutionFault("execution_conflict") : undefined);
      }
      if (plan.deadline <= clock.now()) {
        await io(signal => session!.persistence.advance(runId, { operation: "expire" }, signal));
        return result(runId, (await io(signal => session!.persistence.load(runId, signal))).status, new ExecutionFault("deadline_exceeded"));
      }
      if (!dependencies.renderer) throw new ExecutionFault("renderer_unavailable");
      dependencies.provider.checkConfigured();
      const bytes = await io(signal => session!.storage.readInput(plan!, signal), "input_invalid");
      const image = await io(signal => validateImage(bytes, plan!.input, signal), "input_invalid");
      await reauthorize();
      stage = "claim";
      const claimStarted = clock.monotonic();
      const claim = accepted(await io(signal => session!.persistence.advance(runId,
        { operation: "claim", payload: { verified_input_sha256: image.sha256 } }, signal)));
      if (!claim.token || claim.deadline === undefined || claim.status !== "running") throw new ExecutionFault("contract_mismatch");
      token = claim.token;
      budget.claim(claim.deadline, claimStarted);
      const previous: string[] = [];
      for (let position = 1; position <= plan.invocations; position++) {
        stage = "step"; providerMetadata = undefined;
        budget.beforeStep();
        await reauthorize();
        const start = accepted(await io(signal => session!.persistence.advance(runId,
          { operation: "start_step", token: token!, payload: { position } }, signal)));
        if (start.status !== "running") throw new ExecutionFault("contract_mismatch");
        const context = parseContext(start.context, plan, position, previous);
        stage = "provider";
        const generated = await bounded(clock, budget.provider(), options.signal, "provider_timeout",
          signal => dependencies.provider.generate(context, image, plan!.mode, signal));
        providerMetadata = generated;
        const valid = validateOutput(plan.mode, generated.output_text);
        stage = "step"; // A lost completion response has an ambiguous commit.
        const complete = accepted(await io(signal => session!.persistence.advance(runId,
          { operation: "complete_step", token: token!, payload: { ...generated, position } }, signal)));
        if (complete.status === "failed") return result(runId, "failed", new ExecutionFault("output_invalid"));
        if (complete.status !== "running") throw new ExecutionFault("contract_mismatch");
        if (!valid) throw new ExecutionFault("output_invalid");
        previous.push(generated.output_text); // Exact raw output; no trim/reformat.
      }
      stage = "artifact"; providerMetadata = undefined;
      await reauthorize();
      const saved = await io(signal => session!.persistence.load(runId, signal));
      if (saved.status !== "running" || saved.finalText !== previous.at(-1)) throw new ExecutionFault("contract_mismatch");
      const renderMs = Math.min(LIMITS.ioMs, budget.remaining() - 4 * LIMITS.ioMs);
      const rendered = await bounded(clock, renderMs, options.signal, "artifact_error",
        signal => dependencies.renderer!.render({ image, finalText: saved.finalText!, mode: plan!.mode, signal }));
      let artifact;
      try { artifact = await io(signal => validateImage(rendered, { mime: "image/png" }, signal), "artifact_error"); }
      catch (error) { if (fault(error).code === "cancelled") throw error; throw new ExecutionFault("artifact_error"); }
      await io(signal => session!.storage.storeArtifact(plan!, artifact, signal), "artifact_error");
      storedArtifact = { sha256: artifact.sha256, size: artifact.size, finalText: saved.finalText! };
      stage = "finalize";
      const finish = accepted(await io(signal => session!.persistence.advance(runId,
        { operation: "finalize", token: token!, payload: { artifact_sha256: artifact.sha256 } }, signal)));
      if (finish.status !== "succeeded") throw new ExecutionFault("contract_mismatch");
      finalized = true;
      const confirmed = await io(signal => session!.persistence.load(runId, signal));
      if (confirmed.status !== "succeeded" || confirmed.finalText !== saved.finalText || confirmed.artifactSha256 !== artifact.sha256
          || confirmed.artifactSize !== artifact.size) throw new ExecutionFault("contract_mismatch");
      return result(runId, "succeeded");
    } catch (error) {
      const failure = fault(error, stage === "artifact" ? "artifact_error" : stage === "provider" ? "provider_error" : "persistence_error");
      // Never fail another worker's claim, retry a provider, repeat a refused
      // transition, or pretend an unsuccessful cleanup persisted a failed state.
      if (session && plan && plan.creatorId === session.userId && !transitionRefused && !finalized) {
        const code: FailureCode = stage === "artifact" ? "artifact_error"
          : failure.code === "cancelled" || failure.code === "deadline_exceeded" ? "provider_timeout"
          : ["input_invalid", "provider_error", "provider_timeout", "output_invalid"].includes(failure.code)
            ? failure.code as FailureCode : "persistence_error";
        const canFailPrepared = !token && plan.status === "prepared" && stage === "input" && failure.code === "input_invalid";
        if (token || canFailPrepared) {
          try {
            await bounded(clock, LIMITS.cleanupMs / 2, undefined, "persistence_error", signal => session!.persistence.advance(runId,
              { operation: "fail", ...(token ? { token } : {}), payload: { error_code: code,
                ...(stage === "provider" ? failure.metadata ?? providerMetadata : {}) } }, signal));
          } catch { /* A bounded authoritative read below reports uncertainty. */ }
        }
      }
      if (session && plan && plan.creatorId === session.userId) {
        try {
          const current = await bounded(clock, LIMITS.cleanupMs / 2, undefined, "persistence_error", signal => session!.persistence.load(runId, signal));
          if (stage === "finalize" && storedArtifact && current.status === "succeeded" && current.artifactSha256 === storedArtifact.sha256
              && current.artifactSize === storedArtifact.size && current.finalText === storedArtifact.finalText) return result(runId, "succeeded");
          return result(runId, current.status === "succeeded" && failure.code === "contract_mismatch" ? "unknown" : current.status, failure);
        } catch { /* Never claim failed/succeeded without persisted confirmation. */ }
      }
      return result(runId, failure.code === "access_denied" ? "unavailable" : "unknown", failure);
    }
  }
  return { prepare, execute };
}
