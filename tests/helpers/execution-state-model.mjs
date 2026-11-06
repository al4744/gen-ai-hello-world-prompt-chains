// Behavioral fixture, NOT a PostgreSQL/RLS/Storage emulator. SQL is never run.
// Transactions serialize here only to exercise claims, replay and injected
// rollback at the contract boundary; real lock behavior needs isolated PG tests.
import { createHash } from "node:crypto";

const fail = message => { throw new Error(message); };
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const executionAdmin = { user: "admin", admin: true };

export function executionFixture(chains) {
  let state = { chains: structuredClone(chains), runs: [] }, now = 0, queue = Promise.resolve();
  async function transaction(work, injectFailure) {
    const result = queue.then(() => {
      const draft = structuredClone(state);
      const value = work(draft);
      if (injectFailure) fail("injected persistence failure");
      state = draft;
      return structuredClone(value);
    });
    queue = result.catch(() => {});
    return result;
  }
  function authorize(actor) { if (!actor.user || actor.admin !== true) fail("superadmin_required"); }
  function finish(run, status, code) {
    run.status = status; run.error = code; run.token = null;
    for (const step of run.steps) {
      if (step.status === "pending") step.status = "skipped";
      else if (step.status === "running") step.status = status === "interrupted" ? "interrupted" : "failed";
    }
  }
  return {
    state: () => structuredClone(state),
    tick: seconds => { now += seconds; },
    editChain: (id, work) => work(state.chains.find(chain => chain.id === id)),
    deleteChain(id) {
      state.chains = state.chains.filter(chain => chain.id !== id);
      state.runs.filter(run => run.originalChainId === id).forEach(run => { run.currentChainId = null; });
    },
    upload(id, kind) { state.runs.find(run => run.id === id)[kind === "input" ? "uploaded" : "artifact"] = true; },
    prepare(actor, input, injectFailure = false) {
      return transaction(draft => {
        authorize(actor);
        const { chainId, key, context = "", size = 100, mime = "image/png" } = input;
        if (!["image/png", "image/jpeg", "image/webp"].includes(mime) || size < 1 || size > 5242880 || context.length > 500) fail("invalid_run_input");
        const fingerprint = digest(input);
        const existing = draft.runs.find(run => run.creator === actor.user && run.key === key);
        if (existing) {
          if (existing.fingerprint !== fingerprint) fail("idempotency_input_conflict");
          return existing;
        }
        const chain = draft.chains.find(chain => chain.id === chainId);
        if (!chain) fail("chain_unavailable");
        const snapshot = structuredClone(chain.steps).sort((a, b) => a.step_order - b.step_order);
        if (snapshot.length < 1 || snapshot.length > 5) fail("chain_outside_execution_limits");
        const composed = chain.slug === "caption-arena-default";
        if (composed && (snapshot.length !== 4 || !snapshot[2].prompt_template.includes("{{user_prompt}}"))) fail("default_prompt_contract_unavailable");
        const id = `run-${draft.runs.length + 1}`;
        const run = { id, originalChainId: chain.id, currentChainId: chain.id, creator: actor.user,
          key, fingerprint, snapshot, context, composed, status: "prepared", deadline: now + 1800,
          path: `${actor.user}/${id}/input.${({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[mime]}`, artifactPath: `${actor.user}/${id}/captioned.png`,
          steps: (composed ? [null] : snapshot).map(source => ({ sourceId: source?.id ?? null, status: "pending" })) };
        draft.runs.push(run);
        return run;
      }, injectFailure);
    },
    advance(actor, id, operation, { token, position, output, code = "provider_error" } = {}, injectFailure = false) {
      return transaction(draft => {
        authorize(actor);
        const run = draft.runs.find(run => run.id === id);
        if (!run || run.creator !== actor.user) fail("run_unavailable");
        if (!["prepared", "running"].includes(run.status)) return { accepted: false, status: run.status };
        if (run.deadline <= now) { finish(run, "interrupted", "execution_expired"); return { accepted: false, status: run.status }; }
        if (operation === "expire") fail("run_has_not_expired");
        if (operation === "claim") {
          if (run.status !== "prepared") return { accepted: false };
          if (!run.currentChainId) fail("chain_deleted_before_execution");
          if (!run.uploaded) fail("uploaded_input_unavailable");
          if (draft.runs.some(other => other.creator === actor.user && other.status === "running")) fail("another_run_is_active");
          run.status = "running"; run.token = `lease-${run.id}`; run.deadline = now + 120;
          return { accepted: true, token: run.token };
        }
        if (!(operation === "fail" && run.status === "prepared") && (run.status !== "running" || token !== run.token)) fail("valid_execution_lease_required");
        const step = run.steps[position - 1];
        if (["start_step", "complete_step"].includes(operation) && (!step || run.steps.slice(0, position - 1).some(step => step.status !== "succeeded"))) fail("execution_order_conflict");
        if (operation === "start_step") {
          if (step.status !== "pending") return { accepted: false };
          const prompt = run.composed ? run.snapshot.map((source, index) => index === 2
            ? source.prompt_template.replaceAll("{{user_prompt}}", () => run.context || "No additional context provided.")
            : source.prompt_template).join("\n\n") : run.snapshot[position - 1].prompt_template;
          step.context = { prompt, image: run.path, user_context: run.context,
            previous_outputs: run.steps.slice(0, position - 1).map(step => step.output) };
          step.status = "running";
          return { accepted: true, context: step.context };
        }
        if (operation === "complete_step") {
          if (step.status !== "running") return { accepted: false };
          let invalid = typeof output !== "string" || !output.trim() || Buffer.byteLength(output) > 32768;
          if (run.composed && !invalid) {
            try {
              const parsed = JSON.parse(output);
              invalid = !parsed || Object.keys(parsed).length !== 2 || typeof parsed.caption_a !== "string" || typeof parsed.caption_b !== "string"
                || !parsed.caption_a.trim() || !parsed.caption_b.trim() || parsed.caption_a.trim() === parsed.caption_b.trim();
            } catch { invalid = true; }
          }
          step.outputTruncated = typeof output === "string" && Buffer.byteLength(output) > 32768;
          step.output = step.outputTruncated ? Array.from(output).slice(0, 8192).join("") : output;
          if (invalid) { finish(run, "failed", "output_invalid"); return { accepted: true, status: "failed" }; }
          step.status = "succeeded";
          if (position === run.steps.length) run.finalText = output;
          return { accepted: true };
        }
        if (operation === "finalize") {
          if (!run.finalText || run.steps.some(step => step.status !== "succeeded")) fail("execution_incomplete");
          if (!run.artifact) fail("captioned_artifact_unavailable");
          run.status = "succeeded"; run.token = null;
          return { accepted: true, status: run.status };
        }
        if (operation === "fail") {
          finish(run, "failed", code);
          return { accepted: true, status: run.status };
        }
        fail("invalid_run_operation");
      }, injectFailure);
    },
    media(actor, id, kind, operation) {
      if (!actor.user || !actor.admin) return false;
      const run = state.runs.find(run => run.id === id);
      if (!run) return false;
      if (operation === "read") return kind === "input" || run.status === "succeeded";
      if (operation !== "insert" || run.creator !== actor.user || run.deadline <= now) return false;
      return kind === "input" ? run.status === "prepared"
        : run.status === "running" && run.steps.every(step => step.status === "succeeded");
    },
  };
}
