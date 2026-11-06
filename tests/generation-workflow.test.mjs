import test from "node:test";
import assert from "node:assert/strict";
import { hash, image, loadExecution, plain, uuid } from "./helpers/execution-core-fixture.mjs";

const runId = uuid(2), creator = uuid(1), chainId = uuid(3);
const chain = { id: chainId, name: "Five captions", slug: "custom-captions", description: "Three sequential steps", stepCount: 3 };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const safe = value => assert.doesNotMatch(JSON.stringify(value), /SECRET|lease_token|artifact_path|input_path|synthetic-test-credential/);
function saved(status = "succeeded") {
  const progress = { total: 3, pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, interrupted: 0 };
  if (status === "succeeded") progress.succeeded = 3;
  if (status === "prepared") progress.pending = 3;
  if (status === "running") { progress.succeeded = 1; progress.running = 1; progress.pending = 1; }
  if (status === "failed" || status === "interrupted") { progress.succeeded = 1; progress[status] = 1; progress.skipped = 1; }
  return { runId, chain: { id: chainId, name: chain.name, slug: chain.slug }, status, progress,
    createdAt: "2026-11-06T12:00:00Z", startedAt: null, completedAt: null,
    ...(status === "succeeded" ? { finalText: "1. First caption.\n2. Second caption.\n3. Third caption.\n4. Fourth caption.\n5. Fifth caption." } : {}),
    ...(status === "failed" || status === "interrupted" ? { error: { code: "provider_error", message: "SECRET provider diagnostic" } } : {}) };
}
async function fixture(options = {}) {
  const bytes = await image(); let elapsed = 0, nonce = 20;
  const f = { calls: [], uploads: [], keys: [], urls: [], revoked: [], states: [], remembered: [],
    file: new File([bytes], "image.png", { type: "image/png" }), statuses: [...(options.statuses ?? ["succeeded"])],
    blocked: null, prepareAttempts: 0, mediaAttempts: 0 };
  const load = loadExecution({ "@/lib/supabase/client": { createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: creator, identities: [{ provider: "google" }] } }, error: null }) },
    storage: { from(bucket) { assert.equal(bucket, "prompt-chain-execution-media"); return { async upload(path, file, config) {
      f.uploads.push({ path, file, config });
      if (options.waitUpload) await new Promise(resolve => { f.finishUpload = resolve; });
      return { data: { id: uuid(99), path }, error: options.uploadFailure ? { message: "SECRET Storage" } : null };
    } }; } },
  }) } });
  f.modules = load("lib/generation/workflow.ts");
  f.preview = load("lib/generation/preview.ts");
  f.workflow = f.modules.createGenerationWorkflow({ enabled: options.enabled ?? true,
    randomUUID: () => { const key = uuid(nonce++); f.keys.push(key); return key; },
    now: () => elapsed, sleep: async ms => { elapsed += ms; },
    urls: { createObjectURL(blob) { assert.ok(blob.size > 0); const url = `blob:result-${f.urls.length}`; f.urls.push(url); return url; },
      revokeObjectURL(url) { f.revoked.push(url); } },
    onRunId: id => { f.remembered.push(id); if (options.blockedHistory) throw new Error("SECRET browser restriction"); },
    fetch: async (path, config = {}) => {
      f.calls.push({ path, config }); assert.equal(config.cache, "no-store"); assert.equal(config.credentials, "same-origin"); assert.equal(config.redirect, "error");
      if (path === "/api/generation/runs") {
        f.prepareAttempts++;
        if (options.waitPrepare) await new Promise(resolve => { f.blocked = resolve; });
        if (options.prepareThrows || (options.prepareThrowsOnce && f.prepareAttempts === 1)) throw new Error("SECRET transport");
        if (options.prepareFailure) return response({ error: { message: "SECRET database", code: "persistence_error" } }, 503);
        return response({ runId, status: options.preparedState ?? "prepared", upload: { bucket: "prompt-chain-execution-media", path: `${creator}/${runId}/input.png`, contentType: "image/png" } });
      }
      if (path.endsWith("/execute")) {
        assert.equal(config.method, "POST"); assert.deepEqual(JSON.parse(config.body), {});
        if (options.executeThrows) throw new Error("SECRET provider acknowledgement");
        if (options.progressBeforeAck) await new Promise(resolve => { f.acknowledge = resolve; });
        return options.disabledResponse ? response({ status: "unavailable", error: { code: "generation_disabled", message: "SECRET ignored" } }, 503)
          : response({ runId, status: options.executeFailure ? "failed" : "succeeded", error: options.executeFailure ? { code: "provider_error", message: "SECRET provider" } : undefined }, options.executeFailure ? 422 : 200);
      }
      if (path.endsWith("/media")) {
        f.mediaAttempts++;
        if (options.mediaFailure && f.mediaAttempts === 1) return response({ error: "SECRET object" }, 404);
        return new Response(bytes, { headers: { "Content-Type": "image/png" } });
      }
      assert.equal(path, `/api/generation/runs/${runId}`);
      if (options.statusThrows) throw new Error("SECRET status read");
      const status = f.statuses.length > 1 ? f.statuses.shift() : f.statuses[0];
      return response(options.malformedStatus ? { runId, status: "succeeded", finalText: "fake" } : saved(status));
    },
  });
  f.workflow.subscribe(() => {
    const state = f.workflow.getSnapshot(); f.states.push(plain(state));
    if (options.progressBeforeAck && state.phase === "executing" && state.run?.status === "running") f.acknowledge?.();
  });
  f.start = (overrides = {}) => f.workflow.start({ chain, file: f.file, userContext: "Exact context $& {{literal}}", ...overrides });
  return f;
}

test("chain defaults prefer the executable system chain while custom chains remain selectable", async () => {
  const f = await fixture(), system = { ...chain, id: uuid(4), slug: "caption-arena-default", stepCount: 4 };
  assert.equal(f.modules.defaultChainId([chain, system]), system.id);
  assert.equal(f.modules.defaultChainId([{ ...system, stepCount: 0 }, chain]), chain.id);
  assert.equal(f.modules.defaultChainId([]), "");
  assert.equal(f.modules.executableChain({ ...chain, stepCount: 0 }), false);
  assert.equal(f.modules.executableChain({ ...chain, stepCount: 6 }), false);
});

test("selected custom chain, exact context, SHA256 and approved upload flow reach persisted success", async () => {
  const f = await fixture(); await f.start();
  const state = f.workflow.getSnapshot(); assert.equal(state.phase, "succeeded"); assert.equal(state.busy, false); safe(state);
  assert.equal(state.run.chain.name, chain.name); assert.ok(state.mediaUrl.startsWith("blob:"));
  const body = JSON.parse(f.calls[0].config.body);
  assert.deepEqual(body, { chainId, idempotencyKey: f.keys[0], image: { mime: "image/png", size: f.file.size, sha256: hash(new Uint8Array(await f.file.arrayBuffer())) }, userContext: "Exact context $& {{literal}}" });
  assert.equal(f.uploads.length, 1); assert.equal(f.uploads[0].path, `${creator}/${runId}/input.png`);
  assert.equal(f.uploads[0].config.upsert, false);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/generation/runs", `/api/generation/runs/${runId}/execute`, `/api/generation/runs/${runId}`, `/api/generation/runs/${runId}/media`]);
  assert.ok(f.states.some(state => state.phase === "hashing")); assert.ok(f.states.some(state => state.phase === "uploading"));
  assert.deepEqual(f.remembered, [undefined, runId]);
});

test("disabled generation performs no hashing, preparation, upload, execution or nonce creation", async () => {
  const f = await fixture({ enabled: false }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "unavailable"); assert.equal(f.modules.canStart(f.workflow.getSnapshot(), false), false);
  assert.equal(f.calls.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.keys.length, 0);
});

for (const [name, values] of [
  ["missing chain", { chain: undefined }], ["missing image", { file: null }],
  ["unsupported type", { file: new File(["x"], "bad.svg", { type: "image/svg+xml" }) }],
  ["oversized image", { file: new File([new Uint8Array(5242881)], "big.png", { type: "image/png" }) }],
  ["invalid context", { userContext: "a".repeat(501) }], ["null character", { userContext: "bad\0context" }],
]) test(`workflow rejects ${name} before any network or upload`, async () => {
  const f = await fixture(); await f.start(values);
  assert.equal(f.workflow.getSnapshot().phase, "error"); assert.equal(f.calls.length, 0); assert.equal(f.uploads.length, 0);
});

test("context counts Unicode characters rather than UTF-16 units", async () => {
  const f = await fixture(); assert.equal(f.modules.contextError("😀".repeat(500)), null);
  assert.ok(f.modules.contextError("😀".repeat(501)));
});

test("duplicate clicks are synchronously blocked before state is painted", async () => {
  const f = await fixture({ waitPrepare: true });
  const first = f.start(), second = f.start();
  assert.equal(f.workflow.getSnapshot().busy, true);
  while (!f.blocked) await new Promise(resolve => setTimeout(resolve, 1));
  f.blocked(); await Promise.all([first, second]);
  assert.equal(f.prepareAttempts, 1); assert.equal(f.uploads.length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith("/execute")).length, 1);
});

test("failed preparation exposes safe feedback and performs no upload or execution", async () => {
  const f = await fixture({ prepareFailure: true }); await f.start();
  const state = f.workflow.getSnapshot(); assert.equal(state.phase, "error"); safe(state);
  assert.equal(f.uploads.length, 0); assert.equal(f.calls.length, 1);
});

test("ambiguous preparation reuses its idempotency key for the same exact inputs", async () => {
  const f = await fixture({ prepareThrowsOnce: true }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "error"); await f.start();
  const prepares = f.calls.filter(call => call.path === "/api/generation/runs");
  assert.equal(prepares.length, 2); assert.equal(f.keys.length, 1);
  assert.equal(JSON.parse(prepares[0].config.body).idempotencyKey, JSON.parse(prepares[1].config.body).idempotencyKey);
  assert.equal(f.workflow.getSnapshot().phase, "succeeded");
});

test("changing the chain preserves context and uses a new preparation fingerprint", async () => {
  const f = await fixture({ prepareThrowsOnce: true }); await f.start();
  const selected = { ...chain, id: uuid(4), name: "Another custom chain" };
  await f.start({ chain: selected });
  const bodies = f.calls.filter(call => call.path === "/api/generation/runs").map(call => JSON.parse(call.config.body));
  assert.equal(bodies[1].chainId, selected.id); assert.equal(bodies[1].userContext, bodies[0].userContext);
  assert.notEqual(bodies[1].idempotencyKey, bodies[0].idempotencyKey);
});

test("upload failure leaves execution uncalled and allows a new explicit generation", async () => {
  const f = await fixture({ uploadFailure: true }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "error"); safe(f.workflow.getSnapshot());
  assert.equal(f.calls.length, 1); assert.equal(f.uploads.length, 1);
  assert.equal(f.modules.canStart(f.workflow.getSnapshot(), true), true);
});

test("execution rejection is resolved from persisted failed status, never raw provider error", async () => {
  const f = await fixture({ executeFailure: true, statuses: ["failed"] }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "failed"); safe(f.workflow.getSnapshot());
  assert.equal(f.mediaAttempts, 0); assert.equal(f.modules.canStart(f.workflow.getSnapshot(), true), true);
});

test("disabled backend is configuration unavailable rather than a failed saved run", async () => {
  const f = await fixture({ disabledResponse: true }); await f.start();
  const state = f.workflow.getSnapshot(); assert.equal(state.phase, "unavailable"); assert.equal(state.serviceDisabled, true); safe(state);
  const count = f.calls.length; await f.start(); assert.equal(f.calls.length, count);
});

test("lost execution acknowledgement uses bounded read-only recovery and never repeats POST", async () => {
  const f = await fixture({ executeThrows: true, statuses: ["running", "succeeded"] }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "succeeded");
  assert.equal(f.calls.filter(call => call.path.endsWith("/execute")).length, 1);
  assert.equal(f.calls.filter(call => call.path === `/api/generation/runs/${runId}`).length, 2);
});

test("a long request exposes persisted step progress before its execution acknowledgement", { timeout: 15000 }, async () => {
  const f = await fixture({ progressBeforeAck: true, statuses: ["running", "succeeded"] }); await f.start();
  assert.ok(f.states.some(state => state.phase === "executing" && state.run?.progress.succeeded === 1));
  assert.equal(f.workflow.getSnapshot().phase, "succeeded");
  assert.equal(f.calls.filter(call => call.path.endsWith("/execute")).length, 1);
});

for (const status of ["prepared", "running", "succeeded", "failed", "interrupted"]) test(`refresh recovery reads ${status} without preparation/upload/execution`, async () => {
  const f = await fixture({ enabled: false, statuses: status === "running" ? ["running", "interrupted"] : [status] });
  await f.workflow.resume(runId);
  assert.equal(f.workflow.getSnapshot().phase, status === "running" ? "interrupted" : status); safe(f.workflow.getSnapshot());
  assert.equal(f.uploads.length, 0); assert.equal(f.keys.length, 0);
  assert.ok(f.calls.every(call => call.config.method !== "POST"));
});

test("status network failure remains uncertain and cannot begin a duplicate generation", async () => {
  const f = await fixture({ executeThrows: true, statusThrows: true }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "uncertain"); safe(f.workflow.getSnapshot());
  const calls = f.calls.length; await f.start(); assert.equal(f.calls.length, calls);
});

test("polling stops at its bound and never resumes an active AI request", async () => {
  const f = await fixture({ statuses: ["running"] }); await f.workflow.resume(runId);
  assert.equal(f.calls.length, 60); assert.equal(f.workflow.getSnapshot().busy, false);
  assert.match(f.workflow.getSnapshot().message, /paused/);
  assert.ok(f.calls.every(call => call.config.method === "GET"));
});

test("malformed success never fabricates a result or requests media", async () => {
  const f = await fixture({ malformedStatus: true }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "uncertain"); assert.equal(f.mediaAttempts, 0);
});

test("media failure preserves confirmed saved output and retries only the protected GET", async () => {
  const f = await fixture({ mediaFailure: true }); await f.start();
  assert.equal(f.workflow.getSnapshot().phase, "succeeded"); assert.ok(f.workflow.getSnapshot().mediaError); safe(f.workflow.getSnapshot());
  const executeCalls = f.calls.filter(call => call.path.endsWith("/execute")).length;
  await f.workflow.loadMedia(); assert.ok(f.workflow.getSnapshot().mediaUrl);
  assert.equal(f.calls.filter(call => call.path.endsWith("/execute")).length, executeCalls); assert.equal(f.mediaAttempts, 2);
});

test("reset, media failure and unmount release temporary result URLs", async () => {
  const f = await fixture(); await f.start(); const url = f.workflow.getSnapshot().mediaUrl;
  f.workflow.mediaFailed(); assert.ok(f.revoked.includes(url)); assert.equal(f.workflow.getSnapshot().mediaUrl, undefined);
  await f.workflow.loadMedia(); const second = f.workflow.getSnapshot().mediaUrl;
  f.workflow.reset(); assert.ok(f.revoked.includes(second)); assert.equal(f.workflow.getSnapshot().phase, "idle");
  await f.start(); const third = f.workflow.getSnapshot().mediaUrl;
  f.workflow.dispose(); assert.ok(f.revoked.includes(third));
});

test("unmount during preparation prevents later upload/execute and supports Strict Mode reactivation", async () => {
  const f = await fixture({ waitPrepare: true }); const pending = f.start();
  while (!f.blocked) await new Promise(resolve => setTimeout(resolve, 1));
  f.workflow.dispose(); f.blocked(); await pending;
  assert.equal(f.uploads.length, 0); assert.equal(f.calls.length, 1);
  f.workflow.activate(); await f.workflow.resume(runId); assert.equal(f.workflow.getSnapshot().phase, "succeeded");
});

test("unmount stops waiting for an unabortable upload and its late acknowledgement never executes", async () => {
  const f = await fixture({ waitUpload: true }); const pending = f.start();
  while (!f.finishUpload) await new Promise(resolve => setTimeout(resolve, 1));
  f.workflow.dispose(); await pending;
  assert.equal(f.calls.length, 1);
  f.finishUpload(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.calls.length, 1); assert.equal(f.workflow.getSnapshot().phase, "idle");
});

test("blocked browser history does not break a valid generation", async () => {
  const f = await fixture({ blockedHistory: true }); await f.start(); assert.equal(f.workflow.getSnapshot().phase, "succeeded");
});

test("default output separates Caption A/B while preserving exact JSON and custom output", async () => {
  const f = await fixture(), run = saved();
  run.chain.slug = "caption-arena-default"; run.finalText = ' {"caption_a":"First <literal>","caption_b":"Second"}\n';
  assert.deepEqual(plain(f.modules.defaultCaptions(run)), ["First <literal>", "Second"]);
  assert.equal(run.finalText.startsWith(" "), true); run.chain.slug = chain.slug;
  assert.equal(f.modules.defaultCaptions(run), null);
});

test("preview validates metadata before creating URLs, and decodes before displaying", async () => {
  const f = await fixture(), urls = [], revoked = []; let decoded = false;
  const dependencies = { urls: { createObjectURL: () => { urls.push("blob:preview"); return "blob:preview"; }, revokeObjectURL: url => revoked.push(url) },
    decode: async () => { decoded = true; } };
  await assert.rejects(f.preview.createImagePreview(new File(["x"], "bad.svg", { type: "image/svg+xml" }), new AbortController().signal, dependencies));
  assert.equal(urls.length, 0);
  assert.equal(await f.preview.createImagePreview(f.file, new AbortController().signal, dependencies), "blob:preview");
  assert.equal(decoded, true); assert.equal(revoked.length, 0); // Caller owns successful preview until replacement/unmount.
});

test("bad or cancelled previews revoke their URL and cannot leave a broken preview", async () => {
  const f = await fixture();
  for (const cancelled of [false, true]) {
    const revoked = [], abort = new AbortController();
    const dependencies = { urls: { createObjectURL: () => "blob:bad", revokeObjectURL: url => revoked.push(url) },
      decode: async () => { if (cancelled) abort.abort(); else throw new Error("SECRET decoder"); } };
    await assert.rejects(f.preview.createImagePreview(f.file, abort.signal, dependencies), error => !error.message.includes("SECRET"));
    assert.deepEqual(revoked, ["blob:bad"]);
  }
});

test("preview rejects masquerading non-image bytes before a URL or decoder is used", async () => {
  const f = await fixture(); let touched = false;
  const dependencies = { urls: { createObjectURL: () => { touched = true; return "blob:bad"; }, revokeObjectURL() {} }, decode: async () => { touched = true; } };
  await assert.rejects(f.preview.createImagePreview(new File(['<svg><image href="https://attacker.test"/></svg>'], "fake.png", { type: "image/png" }), new AbortController().signal, dependencies));
  assert.equal(touched, false);
});
