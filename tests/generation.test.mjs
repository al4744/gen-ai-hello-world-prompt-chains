import test from "node:test";
import assert from "node:assert/strict";
import { executionFixture, hash, image, loadExecution, plain, uuid } from "./helpers/execution-core-fixture.mjs";

const origin = "https://chains.example.test";
function request(body = {}, options = {}) {
  return new Request(`${origin}/api/generation/runs`, {
    method: "POST", headers: { "content-type": "application/json", origin, ...options.headers },
    body: options.raw ?? JSON.stringify(body),
  });
}
const getRequest = () => new Request(`${origin}/api/generation/runs/${uuid(2)}`);
function assertPrivate(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}
function assertSafe(value) {
  assert.doesNotMatch(JSON.stringify(value), /SECRET|synthetic-test-credential|lease_token|snapshot_sha256|authorization|provider_response_id/i);
}

async function apiFixture(options = {}) {
  const f = await executionFixture();
  f.row.chain_name = "Frozen chain name";
  f.row.created_at = "2026-11-06T11:00:00Z";
  f.row.started_at = null; f.row.completed_at = null; f.row.error_code = null;
  f.row.deadline_at = new Date(Date.now() + 1800000).toISOString();
  f.row.lease_token_hash = "SECRET lease hash";
  f.row.error_message = "SECRET internal database diagnostic";
  f.profileReads = 0; f.authReads = 0; f.statusReads = []; f.queries = [];
  const originalFrom = f.client.from.bind(f.client);
  f.client.auth = { async getUser() {
    f.authReads++;
    if (options.authThrows) throw new Error("SECRET invalid credential");
    return { data: { user: Object.hasOwn(options, "user") ? options.user : { id: f.userId, identities: [{ provider: "google" }] } },
      error: options.authError ? { message: "SECRET invalid credential" } : null };
  } };
  f.client.from = table => {
    if (table === "profiles") return { select(fields) {
      assert.equal(fields, "is_superadmin");
      return { eq(field, value) {
        assert.equal(field, "id"); assert.equal(value, f.userId);
        return { async maybeSingle() {
          f.profileReads++;
          return { data: Object.hasOwn(options, "profile") ? options.profile : { is_superadmin: true },
            error: options.profileError ? { message: "SECRET profile failure" } : null };
        } };
      } };
    } };
    if (table === "prompt_chain_run_steps") return { select(fields) {
      f.queries.push([table, fields]); assert.equal(fields, "execution_position,status");
      return { eq(field, value) {
        assert.equal(field, "run_id"); assert.equal(value, f.runId);
        return { async abortSignal(signal) {
          assert.ok(signal instanceof AbortSignal); f.statusReads.push("steps");
          return { data: f.steps.map(step => ({ execution_position: step.position, status: step.status })),
            error: options.stepError ? { message: "SECRET step failure" } : null };
        } };
      } };
    } };
    const builder = originalFrom(table), select = builder.select, maybeSingle = builder.maybeSingle;
    builder.select = fields => { f.queries.push([table, fields]); return select(fields); };
    builder.maybeSingle = async () => options.missingRun ? { data: null, error: null } : maybeSingle();
    return builder;
  };
  let load;
  const overrides = {
    "next/navigation": { redirect() { throw new Error("Unexpected HTML redirect"); } },
    "@/lib/supabase/server": { createClient: async () => f.client },
    "@/lib/execution": { createServerExecutionEngine: () => load("lib/execution/index.ts").createServerExecutionEngine() },
  };
  load = loadExecution(overrides);
  f.handlers = load("lib/generation/handlers.ts").createGenerationHandlers();
  f.loadRoutes = path => load(path);
  f.input = { chainId: f.row.original_chain_id, idempotencyKey: uuid(5),
    image: { mime: f.row.input_mime, size: f.bytes.length, sha256: hash(f.bytes) }, userContext: f.row.user_context };
  return f;
}

for (const [name, options, expected] of [
  ["signed out", { user: null }, 401],
  ["invalid session", { authError: true }, 401],
  ["auth exception", { authThrows: true }, 401],
  ["ordinary user", { profile: { is_superadmin: false } }, 403],
  ["missing profile", { profile: null }, 403],
  ["profile database error", { profileError: true }, 403],
  ["truthy profile", { profile: { is_superadmin: "true" } }, 403],
  ["non-Google identity", { user: { id: uuid(1), identities: [{ provider: "email" }] } }, 403],
]) test(`all generation endpoints reject ${name} before execution/storage`, async () => {
  const f = await apiFixture(options);
  for (const response of [await f.handlers.prepare(request(f.input)), await f.handlers.execute(request(), f.runId),
    await f.handlers.status(getRequest(), f.runId)]) {
    assert.equal(response.status, expected); assertPrivate(response); assertSafe(await response.json());
    assert.equal(response.headers.get("location"), null);
  }
  assert.equal(f.authReads, 3); assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.uploads.length, 0);
});

test("each request rechecks current role and returns no cached privileged result", async () => {
  const options = {}, f = await apiFixture(options);
  assert.equal((await f.handlers.prepare(request(f.input))).status, 200);
  options.profile = { is_superadmin: false };
  assert.equal((await f.handlers.status(getRequest(), f.runId)).status, 403);
  assert.equal((await f.handlers.execute(request(), f.runId)).status, 403);
  assert.equal(f.calls.length, 1);
});

for (const [name, mutate] of [
  ["chain UUID", input => { input.chainId = "bad"; }],
  ["idempotency UUID", input => { input.idempotencyKey = "bad"; }],
  ["hash", input => { input.image.sha256 = "bad"; }],
  ["image size", input => { input.image.size = 5242881; }],
  ["zero size", input => { input.image.size = 0; }],
  ["fractional size", input => { input.image.size = 1.5; }],
  ["MIME", input => { input.image.mime = "image/svg+xml"; }],
  ["context", input => { input.userContext = "a".repeat(501); }],
  ["null context", input => { input.userContext = null; }],
  ["creator", input => { input.creatorId = uuid(100); }],
  ["external image URL", input => { input.image.url = "https://attacker.test/image"; }],
  ["model", input => { input.model = "paid/model"; }],
  ["lease", input => { input.lease_token = "SECRET lease"; }],
]) test(`preparation rejects invalid/untrusted ${name}`, async () => {
  const f = await apiFixture(); mutate(f.input);
  const response = await f.handlers.prepare(request(f.input));
  assert.equal(response.status, 400); assertPrivate(response); assertSafe(await response.json());
  assert.equal(f.calls.length, 0);
});

for (const [name, raw, expected] of [
  ["malformed JSON", "{", 400], ["null body", "null", 400], ["array body", "[]", 400],
  ["oversized JSON", JSON.stringify({ text: "x".repeat(8192) }), 413],
]) test(`bounded parser rejects ${name}`, async () => {
  const f = await apiFixture();
  const response = await f.handlers.prepare(request({}, { raw }));
  assert.equal(response.status, expected); assertPrivate(response); assert.equal(f.calls.length, 0);
});

test("invalid UTF-8 and chunked overflow fail before RPC", async () => {
  const f = await apiFixture();
  for (const [chunks, code] of [[[new Uint8Array([0xff])], 400], [[new Uint8Array(4096), new Uint8Array(4097)], 413]]) {
    let cancelled = false;
    const stream = new ReadableStream({ pull(controller) {
      if (chunks.length) controller.enqueue(chunks.shift()); else if (code !== 413) controller.close();
    }, cancel() { cancelled = true; } });
    const req = new Request(`${origin}/api/generation/runs`, { method: "POST", body: stream, duplex: "half",
      headers: { origin, "content-type": "application/json" } });
    assert.equal((await f.handlers.prepare(req)).status, code);
    if (code === 413) assert.equal(cancelled, true);
  }
  assert.equal(f.calls.length, 0);
});

for (const [name, headers, expected] of [
  ["cross origin", { origin: "https://attacker.test" }, 403],
  ["null origin", { origin: "null" }, 403], ["missing origin", { origin: "" }, 403],
  ["same-site sibling", { "sec-fetch-site": "same-site" }, 403],
  ["foreign fetch site", { "sec-fetch-site": "cross-site" }, 403],
  ["spoofed forwarded host", { origin: "https://attacker.test", "x-forwarded-host": "attacker.test" }, 403],
  ["form", { "content-type": "application/x-www-form-urlencoded" }, 415],
  ["compressed body", { "content-encoding": "gzip" }, 415],
  ["oversized length", { "content-length": "9000" }, 413],
]) test(`both mutations reject ${name}`, async () => {
  const f = await apiFixture();
  for (const response of [await f.handlers.prepare(request(f.input, { headers })),
    await f.handlers.execute(request({}, { headers }), f.runId)]) {
    assert.equal(response.status, expected); assertPrivate(response); assertSafe(await response.json());
  }
  assert.equal(f.calls.length, 0);
});

test("preparation uses installed RPC and returns the same run on duplicate idempotency key", async () => {
  const f = await apiFixture();
  const first = await f.handlers.prepare(request(f.input, { headers: { "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" } }));
  const second = await f.handlers.prepare(request(f.input));
  assert.equal(first.status, 200); assertPrivate(first);
  const dto = await first.json(); assert.deepEqual(dto, await second.json()); assertSafe(dto);
  assert.deepEqual(dto, { runId: f.runId, status: "prepared", upload: {
    bucket: "prompt-chain-execution-media", path: f.row.input_path, contentType: "image/png" } });
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.equal(call.name, "prepare_prompt_chain_run_v1"); assert.equal(call.args.p_idempotency_key, f.input.idempotencyKey);
  }
  assert.equal(f.reads.length, 0); assert.equal(f.uploads.length, 0); assert.equal(f.requests.length, 0);
  assert.equal(f.authReads, 4); // Endpoint and engine guards, each time.
});

test("RPC idempotency conflict is sanitized without retry or misleading upload descriptor", async () => {
  const f = await apiFixture();
  f.client.rpc = () => ({ abortSignal: async () => { f.calls.push("conflict"); return {
    data: null, error: { message: "SECRET idempotency_input_conflict" } }; } });
  const response = await f.handlers.prepare(request(f.input));
  assert.equal(response.status, 503);
  const dto = await response.json(); assertSafe(dto); assert.equal(dto.upload, undefined);
  assert.equal(dto.status, "unavailable"); assert.equal(f.calls.length, 1);
});

test("production factory fails renderer gate before credential lookup, image download, claim or AI", async () => {
  const f = await apiFixture();
  const response = await f.handlers.execute(request(), f.runId);
  assert.equal(response.status, 503); assertPrivate(response);
  const dto = await response.json(); assertSafe(dto);
  assert.equal(dto.runId, f.runId); assert.equal(dto.status, "prepared"); assert.equal(dto.error.code, "renderer_unavailable");
  assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.uploads.length, 0);
  assert.equal(f.authReads, 2);
  // The loader throws on any real env read/network. Repeating never claims.
  assert.equal((await (await f.handlers.execute(request(), f.runId)).json()).error.code, "renderer_unavailable");
  assert.equal(f.calls.length, 0);
});

test("execution checks creator before renderer gate", async () => {
  const f = await apiFixture(); f.row.creator_id = uuid(99); f.row.creator_id_snapshot = uuid(99);
  const response = await f.handlers.execute(request(), f.runId);
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "access_denied");
  assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 0);
});

test("bad run UUID, nonempty execution payload, and wrong methods never advance a run", async () => {
  const f = await apiFixture();
  for (const response of [await f.handlers.execute(request(), "not-a-uuid"),
    await f.handlers.status(getRequest(), "not-a-uuid"),
    await f.handlers.execute(request({ lease_token: "SECRET" }), f.runId)]) assert.equal(response.status, 400);
  assert.equal((await f.handlers.prepare(getRequest())).status, 405);
  assert.equal((await f.handlers.execute(getRequest(), f.runId)).status, 405);
  assert.equal((await f.handlers.status(request(), f.runId)).status, 405);
  assert.equal(f.calls.length, 0);
});

for (const state of ["prepared", "running", "succeeded", "failed", "interrupted"]) test(`status safely projects ${state}`, async () => {
  const f = await apiFixture(); f.row.status = state;
  if (state !== "prepared") f.row.started_at = "2026-11-06T11:01:00Z";
  if (["succeeded", "failed", "interrupted"].includes(state)) f.row.completed_at = "2026-11-06T11:02:00Z";
  f.row.final_text = "Private partial output";
  f.row.error_code = state === "interrupted" ? "execution_expired" : "provider_error";
  f.steps[0].status = state === "prepared" ? "pending" : state === "running" ? "running" : state;
  const response = await f.handlers.status(getRequest(), f.runId), dto = await response.json();
  assert.equal(response.status, 200); assertPrivate(response); assertSafe(dto);
  assert.deepEqual(Object.keys(dto).sort(), ["runId", "chain", "status", "progress", "createdAt", "startedAt", "completedAt",
    ...(["failed", "interrupted"].includes(state) ? ["error"] : []), ...(state === "succeeded" ? ["finalText"] : [])].sort());
  assert.equal(dto.status, state); assert.equal(dto.progress.total, 3); assert.equal(f.calls.length, 0);
  assert.equal(dto.finalText, state === "succeeded" ? "Private partial output" : undefined);
  assert.deepEqual(dto.chain, { id: f.row.original_chain_id, name: "Frozen chain name", slug: "custom-chain" });
  assert.doesNotMatch(JSON.stringify(dto), /input_path|artifact_path|sha256|creator_id|deadline_at|request_config|submitted_context/);
  for (const [, fields] of f.queries) assert.doesNotMatch(fields, /\*|lease|input|artifact|error_message|provider/);
});

for (const state of ["prepared", "running"]) test(`expired ${state} projects interruption without mutation`, async () => {
  const f = await apiFixture(); f.row.status = state; f.row.deadline_at = new Date(Date.now() - 10000).toISOString();
  if (state === "running") f.steps[0].status = "running";
  const dto = await (await f.handlers.status(getRequest(), f.runId)).json();
  assert.equal(dto.status, "interrupted"); assert.equal(dto.error.code, "execution_expired");
  assert.equal(dto.progress.pending, 0); assert.equal(dto.progress.running, 0);
  assert.equal(dto.progress.interrupted, state === "running" ? 1 : 0);
  assert.equal(dto.progress.skipped, state === "running" ? 2 : 3);
  assert.equal(dto.completedAt, null); assert.equal(f.row.status, state); assert.equal(f.calls.length, 0);
});

test("current superadmins can read retained snapshots of another creator/deleted chain", async () => {
  const f = await apiFixture(); f.row.creator_id = null; f.row.creator_id_snapshot = uuid(77); f.row.current_chain_id = null;
  const dto = await (await f.handlers.status(getRequest(), f.runId)).json();
  assert.equal(dto.chain.id, f.row.original_chain_id); assert.equal(dto.chain.name, "Frozen chain name"); assertSafe(dto);
});

test("status missing rows and database failures are private/sanitized", async () => {
  for (const [options, code] of [[{ missingRun: true }, 404], [{ stepError: true }, 503], [{}, 503]]) {
    const f = await apiFixture(options);
    if (!Object.keys(options).length) f.readFailure = true;
    const response = await f.handlers.status(getRequest(), f.runId);
    assert.equal(response.status, code); assertPrivate(response); assertSafe(await response.json());
  }
});

test("unknown saved errors and malformed progress fail safely without publishing raw errors", async () => {
  const f = await apiFixture(); f.row.status = "failed"; f.row.error_code = "SECRET provider token";
  const dto = await (await f.handlers.status(getRequest(), f.runId)).json(); assertSafe(dto);
  assert.equal(dto.error.code, "persistence_error");
  f.steps[1].position = 1;
  const response = await f.handlers.status(getRequest(), f.runId);
  assert.equal(response.status, 503); assertSafe(await response.json());
});

test("route wiring uses guarded handlers and async route params with no renderer injection", async () => {
  const f = await apiFixture();
  const prep = f.loadRoutes("app/api/generation/runs/route.ts");
  const exec = f.loadRoutes("app/api/generation/runs/[runId]/execute/route.ts");
  const status = f.loadRoutes("app/api/generation/runs/[runId]/route.ts");
  const context = { params: Promise.resolve({ runId: f.runId }) };
  assert.equal(exec.maxDuration, 150);
  assert.equal((await prep.POST(request(f.input))).status, 200);
  assert.equal((await status.GET(getRequest(), context)).status, 200);
  assert.equal((await exec.POST(request(), context)).status, 503);
});

async function uploadFixture(format = "png") {
  const bytes = await image(format), mime = format === "jpeg" ? "image/jpeg" : `image/${format}`;
  const f = { calls: [], user: { id: uuid(1), identities: [{ provider: "google" }] }, error: null, throws: false,
    prepared: { runId: uuid(2), status: "prepared", upload: { bucket: "prompt-chain-execution-media",
      path: `${uuid(1)}/${uuid(2)}/input.${format === "jpeg" ? "jpg" : format}`, contentType: mime } },
    metadata: { mime, size: bytes.length, sha256: hash(bytes) }, file: new File([bytes], "untrusted-name.png", { type: mime }) };
  const load = loadExecution({ "@/lib/supabase/client": { createClient: () => ({
    auth: { getUser: async () => ({ data: { user: f.user }, error: f.authError }) },
    storage: { from(bucket) { return { async upload(path, file, options) {
      f.calls.push({ bucket, path, file, options });
      if (f.throws) throw new Error("SECRET upload token");
      return { data: { id: uuid(99), path }, error: f.error };
    } }; } },
  }) } });
  f.upload = () => load("lib/generation/upload.ts").uploadPreparedInput(f.prepared, f.metadata, f.file);
  return f;
}

for (const format of ["jpeg", "png", "webp"]) test(`browser helper uploads ${format} to approved private path without overwrite`, async () => {
  const f = await uploadFixture(format); assert.deepEqual(plain(await f.upload()), { ok: true, runId: uuid(2) });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].bucket, "prompt-chain-execution-media");
  assert.equal(f.calls[0].path, f.prepared.upload.path); assert.equal(f.calls[0].file, f.file);
  assert.deepEqual(plain(f.calls[0].options), { contentType: f.metadata.mime, cacheControl: "0", upsert: false });
});

for (const [name, mutate] of [
  ["anonymous", f => { f.user = null; }], ["invalid session", f => { f.authError = { message: "SECRET" }; }],
  ["other creator", f => { f.user.id = uuid(77); }], ["non-Google user", f => { f.user.identities = []; }],
  ["public bucket", f => { f.prepared.upload.bucket = "public-images"; }],
  ["external path", f => { f.prepared.upload.path = "https://attacker.test/image"; }],
  ["artifact path", f => { f.prepared.upload.path = `${uuid(1)}/${uuid(2)}/captioned.png`; }],
  ["another run path", f => { f.prepared.runId = uuid(100); }],
  ["claimed run", f => { f.prepared.status = "running"; }],
  ["bad MIME", f => { f.metadata.mime = "image/svg+xml"; }],
  ["changed bytes/hash", f => { f.metadata.sha256 = "a".repeat(64); }],
  ["wrong declared size", f => { f.metadata.size++; }],
  ["oversized file", f => { f.file = new File([new Uint8Array(5242881)], "big.png", { type: "image/png" }); f.metadata.size = f.file.size; }],
]) test(`browser helper rejects ${name} before Storage upload`, async () => {
  const f = await uploadFixture(); mutate(f);
  const result = await f.upload(); assert.equal(result.ok, false); assertSafe(result); assert.equal(f.calls.length, 0);
});

test("Storage RLS denials, duplicate upload and transport failures are sanitized and never retried", async () => {
  for (const failure of ["ordinary-user RLS denial", "expired preparation", "duplicate object", "network exception"]) {
    const f = await uploadFixture();
    if (failure === "network exception") f.throws = true; else f.error = { message: `SECRET ${failure}`, statusCode: 403 };
    const result = await f.upload(); assert.equal(result.ok, false); assertSafe(result);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.upsert, false);
  }
});
