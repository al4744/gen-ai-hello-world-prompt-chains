import test from "node:test";
import assert from "node:assert/strict";
import { hash, image, loadExecution, uuid } from "./helpers/execution-core-fixture.mjs";

const runId = uuid(2), creator = uuid(1);
const request = (suffix = "") => new Request(`https://chains.test/api/generation/runs/${runId}/media${suffix}`);
const safe = value => assert.doesNotMatch(JSON.stringify(value), /SECRET|lease_token|artifact_path|service.role|private.path/i);
async function fixture(options = {}) {
  const bytes = await image(), calls = [];
  const row = { id: runId, status: "succeeded", creator_id_snapshot: creator, artifact_path: `${creator}/${runId}/captioned.png`,
    artifact_size_bytes: bytes.length, artifact_sha256: hash(bytes), lease_token_hash: "SECRET lease", error_message: "SECRET database" };
  const client = {
    auth: { getUser: async () => ({ data: { user: Object.hasOwn(options, "user") ? options.user : { id: creator, identities: [{ provider: "google" }] } },
      error: options.authError ? { message: "SECRET credential" } : null }) },
    from(table) {
      const builder = {
        select(fields) {
          if (table === "prompt_chain_runs") {
            assert.equal(fields, "id,status,creator_id_snapshot,artifact_path,artifact_size_bytes,artifact_sha256");
            calls.push("run");
          } else assert.equal(table, "profiles");
          return builder;
        },
        eq(field, value) { assert.equal(field, "id"); assert.equal(value, table === "profiles" ? creator : runId); return builder; },
        abortSignal(signal) { assert.ok(signal instanceof AbortSignal); return builder; },
        async maybeSingle() {
          if (table === "profiles") return { data: Object.hasOwn(options, "profile") ? options.profile : { is_superadmin: true }, error: options.profileError ? { message: "SECRET profile" } : null };
          if (options.queryThrows) throw new Error("SECRET database stack");
          return { data: options.missingRun ? null : row, error: options.queryError ? { message: "SECRET query" } : null };
        },
      };
      return builder;
    },
    storage: { from(bucket) {
      assert.equal(bucket, "prompt-chain-execution-media");
      return { download(path, _options, config) {
        calls.push(path); assert.equal(config.cache, "no-store"); assert.ok(config.signal instanceof AbortSignal);
        return { async asStream() {
          if (options.storageThrows) throw new Error("SECRET private path");
          return options.missingObject ? { data: null, error: { message: "SECRET object" } }
            : { error: null, data: new ReadableStream({ start(controller) { controller.enqueue(options.bytes ?? bytes); },
              pull(controller) { if (!options.bytes || options.bytes.byteLength <= row.artifact_size_bytes) controller.close(); }, cancel() { calls.push("stream-cancelled"); } }) };
        } };
      } };
    } },
  };
  const load = loadExecution({ "next/navigation": { redirect() { throw new Error("Unexpected redirect"); } },
    "@/lib/supabase/server": { createClient: async () => client } });
  return { row, bytes, calls, handle: load("lib/generation/media.ts").createMediaHandler(), load };
}
async function assertError(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("location"), null);
  safe(await response.json());
}

for (const [name, options, status] of [
  ["anonymous", { user: null }, 401], ["invalid session", { authError: true }, 401],
  ["ordinary user", { profile: { is_superadmin: false } }, 403], ["missing profile", { profile: null }, 403],
  ["database profile failure", { profileError: true }, 403], ["truthy profile", { profile: { is_superadmin: "true" } }, 403],
  ["non-Google identity", { user: { id: creator, identities: [{ provider: "email" }] } }, 403],
]) test(`media denies ${name} before run lookup or Storage`, async () => {
  const f = await fixture(options); await assertError(await f.handle(request(), runId), status); assert.equal(f.calls.length, 0);
});

test("media rechecks current role on every preview and download", async () => {
  const options = {}, f = await fixture(options);
  assert.equal((await f.handle(request(), runId)).status, 200);
  const calls = f.calls.length; options.profile = { is_superadmin: false };
  await assertError(await f.handle(request("?download=1"), runId), 403);
  assert.equal(f.calls.length, calls);
});

test("valid completed PNG has private image headers and fixed safe filename", async () => {
  const f = await fixture(); const response = await f.handle(request("?path=https://attacker.test&filename=bad"), runId);
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("content-length"), String(f.bytes.length));
  assert.equal(response.headers.get("content-disposition"), `inline; filename="caption-${runId}.png"`);
  safe([...response.headers]);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  assert.equal(f.calls.filter(call => call === f.row.artifact_path).length, 1);
});

test("download uses the same guarded endpoint and attachment headers", async () => {
  const f = await fixture(); const response = await f.handle(request("?download=1"), runId);
  assert.equal(response.headers.get("content-disposition"), `attachment; filename="caption-${runId}.png"`);
  assert.equal(response.headers.get("content-type"), "image/png");
});

test("approved current-superadmin history model permits another creator's finalized artifact", async () => {
  const f = await fixture(); f.row.creator_id_snapshot = uuid(77); f.row.artifact_path = `${uuid(77)}/${runId}/captioned.png`;
  assert.equal((await f.handle(request(), runId)).status, 200);
  assert.ok(f.calls.includes(f.row.artifact_path));
});

test("media rejects malformed IDs and wrong methods without run reads", async () => {
  const f = await fixture(); await assertError(await f.handle(request(), "../../SECRET"), 400);
  await assertError(await f.handle(new Request(request().url, { method: "POST" }), runId), 405);
  assert.equal(f.calls.length, 0);
});

for (const status of ["prepared", "running", "failed", "interrupted"]) test(`media rejects ${status} runs before Storage`, async () => {
  const f = await fixture(); f.row.status = status;
  await assertError(await f.handle(request(), runId), 409); assert.deepEqual(f.calls, ["run"]);
});

for (const [name, options, status] of [
  ["missing run", { missingRun: true }, 404], ["query failure", { queryError: true }, 503],
  ["query exception", { queryThrows: true }, 503], ["missing object", { missingObject: true }, 404],
  ["Storage exception", { storageThrows: true }, 503],
]) test(`media sanitizes ${name}`, async () => {
  const f = await fixture(options); await assertError(await f.handle(request(), runId), status);
});

for (const [name, mutate] of [
  ["arbitrary path", row => { row.artifact_path = "https://attacker.test/SECRET"; }],
  ["different run path", row => { row.artifact_path = `${creator}/${uuid(99)}/captioned.png`; }],
  ["missing hash", row => { row.artifact_sha256 = null; }],
  ["oversized declared artifact", row => { row.artifact_size_bytes = 5242881; }],
  ["invalid creator snapshot", row => { row.creator_id_snapshot = null; }],
]) test(`media rejects ${name} before Storage`, async () => {
  const f = await fixture(); mutate(f.row);
  await assertError(await f.handle(request(), runId), 422); assert.deepEqual(f.calls, ["run"]);
});

test("media rejects invalid, truncated and wrong-type bytes", async () => {
  for (const bytes of [Buffer.from("SECRET invalid image"), (await image()).subarray(0, 35), await image("jpeg")]) {
    const f = await fixture({ bytes }); f.row.artifact_size_bytes = bytes.length; f.row.artifact_sha256 = hash(bytes);
    await assertError(await f.handle(request(), runId), 422);
  }
});

test("media independently verifies saved SHA256 and exact length", async () => {
  for (const change of [row => { row.artifact_sha256 = "a".repeat(64); }, row => { row.artifact_size_bytes++; }]) {
    const f = await fixture(); change(f.row); await assertError(await f.handle(request(), runId), 422);
  }
});

test("media stops oversized streamed bytes without returning or caching them", async () => {
  const f = await fixture({ bytes: new Uint8Array(5242881) });
  await assertError(await f.handle(request(), runId), 422); assert.ok(f.calls.includes("stream-cancelled"));
});

test("media route resolves async params through its independently guarded handler", async () => {
  const f = await fixture();
  const route = f.load("app/api/generation/runs/[runId]/media/route.ts");
  assert.equal((await route.GET(request(), { params: Promise.resolve({ runId }) })).status, 200);
});
