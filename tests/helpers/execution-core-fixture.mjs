// Actual execution modules with isolated SDK/fetch boundaries. This is not a
// PostgreSQL or Storage-policy emulator; no network or environment values used.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";

export const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
export const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const plain = value => JSON.parse(JSON.stringify(value));

export function loadExecution(overrides = {}) {
  const cache = new Map();
  const globals = { Buffer, Uint8Array, URL, TextDecoder, TextEncoder, Request, Response, Headers, crypto,
    AbortController, AbortSignal, ReadableStream, performance,
    setTimeout, clearTimeout, fetch: () => { throw new Error("Live network is disabled in tests"); },
    process: { env: new Proxy({}, { get() { throw new Error("Real environment reads are disabled in tests"); } }) } };
  function load(path) {
    path = resolve(root, path);
    if (cache.has(path)) return cache.get(path).exports;
    const testModule = { exports: {} }; cache.set(path, testModule);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { fileName: path,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, globals)(name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === "server-only") return {};
      if (name.startsWith("@/")) return load(`${name.slice(2)}.ts`);
      if (name.startsWith(".")) return load(resolve(dirname(path), `${name}.ts`));
      if (name === "sharp" || name.startsWith("node:")) return require(name);
      throw new Error(`Unmocked execution dependency: ${name}`);
    }, testModule, testModule.exports);
    return testModule.exports;
  }
  return load;
}

export function fakeClock() {
  let elapsed = 0, id = 0;
  const timers = new Map(), base = Date.parse("2026-11-06T12:00:00Z");
  return {
    now: () => base + elapsed, monotonic: () => elapsed,
    schedule(callback, ms) { const key = ++id; timers.set(key, { at: elapsed + ms, callback }); return () => timers.delete(key); },
    advance(ms) {
      elapsed += ms;
      for (const [key, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timers.has(key) && timer.at <= elapsed) { timers.delete(key); timer.callback(); }
      }
    },
  };
}

const imagePromises = new Map();
export function image(format = "png", width = 3, height = 2) {
  const key = `${format}/${width}/${height}`;
  if (!imagePromises.has(key)) imagePromises.set(key,
    sharp({ create: { width, height, channels: 3, background: { r: 20, g: 40, b: 60 } } })[format]().toBuffer());
  return imagePromises.get(key);
}
export function completion(output = "A literal custom caption", extra = {}) {
  return { id: "response-test", model: "mock/vision:free", choices: [{ message: { content: output }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15, cost: 0 }, ...extra };
}
export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

export async function executionFixture({ mode = "sequential", count = 3, format = "png" } = {}) {
  const load = loadExecution(), clock = fakeClock(), bytes = await image(format);
  const userId = uuid(1), runId = uuid(2), chainId = uuid(3), mime = format === "jpeg" ? "image/jpeg" : `image/${format}`;
  const snapshot = Array.from({ length: mode === "composed" ? 4 : count }, (_, i) => ({ id: uuid(10 + i), step_order: mode === "composed" ? i + 1 : i * 2 + 1,
    name: `Step ${i + 1}`, prompt_template: i === 2 && mode === "composed" ? "<context>{{user_prompt}}</context>" : `Literal instruction ${i + 1} {{never_evaluate}}` }));
  const f = {
    load, clock, userId, runId, bytes, authorized: true, calls: [], requests: [], uploads: [], reads: [],
    refuse: null, throwAt: null, afterCommit: null, readFailure: false, uploadFailure: false, badUploadReceipt: false,
    leaseDelta: 120_000, dbPrompt: "Authoritative composed prompt from the RPC; $& and {{literal}} stay literal.",
    row: { id: runId, creator_id: userId, creator_id_snapshot: userId, original_chain_id: chainId, current_chain_id: chainId,
      chain_slug: mode === "composed" ? "caption-arena-default" : "custom-chain", step_snapshot: structuredClone(snapshot),
      execution_mode: mode, execution_version: 1, invocation_count: mode === "composed" ? 1 : count,
      input_path: `${userId}/${runId}/input.${format === "jpeg" ? "jpg" : format}`, input_mime: mime,
      input_size_bytes: bytes.length, input_sha256: hash(bytes), artifact_path: `${userId}/${runId}/captioned.png`,
      user_context: "Optional user context", status: "prepared", deadline_at: new Date(clock.now() + 1_800_000).toISOString(),
      requested_model: "openrouter/free", request_config: { provider: "openrouter", max_completion_tokens: 2000 },
      final_text: null, artifact_sha256: null, artifact_size_bytes: null },
    source: structuredClone(snapshot), steps: [], objects: new Map(),
    reply: async () => jsonResponse(completion(mode === "composed" ? '{"caption_a":"First caption","caption_b":"Second caption"}' : "A literal custom caption")),
    render: async () => image("png"),
  };
  f.steps = Array.from({ length: f.row.invocation_count }, (_, i) => ({ status: "pending", position: i + 1 }));
  f.objects.set(f.row.input_path, { bytes, mime });
  function terminal(status, code) {
    f.row.status = status; f.row.error_code = code;
    f.steps.forEach(step => {
      if (step.status === "running") step.status = status === "interrupted" ? "interrupted" : "failed";
      if (step.status === "pending") step.status = "skipped";
    });
  }
  async function rpc(name, args, signal) {
    assert.equal(signal instanceof AbortSignal, true);
    const op = args.p_operation ?? "prepare";
    f.calls.push({ name, operation: op, args: structuredClone(args) });
    if (!f.authorized) return { data: null, error: { code: "42501", message: "SECRET profile failure" } };
    if (op === f.throwAt) throw new Error("SECRET database transport failure");
    let data = { run_id: runId, status: f.row.status, accepted: true };
    const payload = args.p_payload ?? {};
    if (op === "prepare") {
      assert.equal(name, "prepare_prompt_chain_run_v1");
      assert.equal(args.p_chain_id, chainId);
    } else {
      assert.equal(name, "advance_prompt_chain_run_v1"); assert.equal(args.p_run_id, runId);
      if (!["prepared", "running"].includes(f.row.status)) return { data: { ...data, accepted: false }, error: null };
      if (Date.parse(f.row.deadline_at) <= clock.now()) {
        terminal("interrupted", "execution_expired"); return { data: { ...data, status: "interrupted", accepted: false }, error: null };
      }
      if (f.refuse === op) return { data: { ...data, accepted: false }, error: null };
      if (op === "claim") {
        if (f.row.status !== "prepared") return { data: { ...data, accepted: false }, error: null };
        if (!f.row.current_chain_id || payload.verified_input_sha256 !== f.row.input_sha256 || !f.objects.has(f.row.input_path)) throw new Error("Invalid claim");
        f.row.status = "running"; f.row.deadline_at = new Date(clock.now() + f.leaseDelta).toISOString();
        data = { ...data, status: "running", deadline_at: f.row.deadline_at, lease_token: "a".repeat(64) };
      } else {
        if (op !== "expire" && !(op === "fail" && f.row.status === "prepared")) assert.equal(args.p_lease_token, "a".repeat(64));
        const step = f.steps[payload.position - 1];
        if (op === "start_step") {
          if (step.status !== "pending") return { data: { ...data, accepted: false }, error: null };
          assert.ok(f.steps.slice(0, payload.position - 1).every(step => step.status === "succeeded"));
          step.status = "running";
          data.submitted_context = { prompt: mode === "composed" ? f.dbPrompt : snapshot[payload.position - 1].prompt_template,
            user_context: f.row.user_context, image: { bucket: "prompt-chain-execution-media", path: f.row.input_path, mime, sha256: f.row.input_sha256 },
            previous_outputs: f.steps.slice(0, payload.position - 1).map((step, i) => ({ position: i + 1, source_step_id: snapshot[i].id, output_text: step.output_text })),
            requested_model: f.row.requested_model, request_config: f.row.request_config };
        } else if (op === "complete_step") {
          assert.equal(step.status, "running"); Object.assign(step, payload); step.status = "succeeded";
          if (mode === "composed") {
            let valid = false;
            try { const value = JSON.parse(payload.output_text); valid = Object.keys(value).length === 2
              && typeof value.caption_a === "string" && typeof value.caption_b === "string"
              && value.caption_a.trim() && value.caption_b.trim() && value.caption_a.trim() !== value.caption_b.trim(); } catch { /* invalid mock result */ }
            if (!valid) { step.status = "failed"; terminal("failed", "output_invalid"); }
          }
          if (f.row.status === "running" && payload.position === f.steps.length) f.row.final_text = payload.output_text;
        } else if (op === "fail") {
          const active = f.steps.find(step => step.status === "running"); if (active) Object.assign(active, payload);
          terminal("failed", payload.error_code);
        } else if (op === "finalize") {
          assert.ok(f.steps.every(step => step.status === "succeeded"));
          const stored = f.objects.get(f.row.artifact_path); assert.equal(stored.mime, "image/png");
          f.row.artifact_sha256 = payload.artifact_sha256; f.row.artifact_size_bytes = stored.bytes.length; f.row.status = "succeeded";
        } else if (op === "expire") throw new Error("Run has not expired");
      }
    }
    data.status = f.row.status;
    if (f.afterCommit) await f.afterCommit(op, args, signal);
    return { data: structuredClone(data), error: null };
  }
  f.client = {
    rpc: (name, args) => ({ abortSignal: signal => rpc(name, args, signal) }),
    from(table) {
      assert.equal(table, "prompt_chain_runs");
      const builder = {
        select(fields) { assert.ok(!fields.includes("*") && !fields.includes("lease_token_hash")); return builder; },
        eq(field, id) { assert.equal(field, "id"); assert.equal(id, runId); return builder; },
        abortSignal() { return builder; },
        async maybeSingle() { return !f.authorized || f.readFailure ? { data: null, error: { message: "SECRET query failure" } } : { data: structuredClone(f.row), error: null }; },
      };
      return builder;
    },
    storage: { from(bucket) {
      assert.equal(bucket, "prompt-chain-execution-media");
      return {
        download(path, options, parameters) {
          assert.equal(parameters.cache, "no-store"); f.reads.push(path);
          return { async asStream() {
            const stored = f.objects.get(path);
            if (!stored || (path === f.row.artifact_path && f.row.status !== "succeeded")) return { data: null, error: { message: "SECRET Storage denial" } };
            return { data: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(stored.bytes)); controller.close(); } }), error: null };
          } };
        },
        async upload(path, data, options) {
          f.uploads.push(path); assert.equal(options.upsert, false); assert.equal(options.contentType, "image/png");
          if (f.uploadFailure) throw new Error("SECRET upload failure");
          assert.ok(f.steps.every(step => step.status === "succeeded"));
          f.objects.set(path, { bytes: Buffer.from(data), mime: options.contentType });
          return { data: { id: uuid(99), path: f.badUploadReceipt ? "wrong/path" : path }, error: null };
        },
      };
    } },
  };
  const adapters = load("lib/execution/supabase.ts"), engine = load("lib/execution/engine.ts"), openrouter = load("lib/execution/openrouter.ts");
  f.provider = openrouter.createOpenRouterProvider({ clock, getApiKey: () => "synthetic-test-credential",
    fetch: async (url, options) => { f.requests.push({ url, options, body: JSON.parse(options.body) }); return f.reply(f.requests.length, options.signal); } });
  f.session = { userId, persistence: adapters.createExecutionPersistence(f.client, userId), storage: adapters.createExecutionStorage(f.client) };
  f.engine = overrides => engine.createExecutionEngine({ clock, provider: f.provider,
    authorize: async () => { if (!f.authorized) throw new Error("SECRET authorization denial"); return f.session; },
    renderer: { render: args => f.render(args) }, ...overrides });
  return f;
}
