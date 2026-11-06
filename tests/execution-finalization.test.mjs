import test from "node:test";
import assert from "node:assert/strict";
import { executionFixture, completion, jsonResponse, uuid } from "./helpers/execution-core-fixture.mjs";

function staleRun(f, overrides = {}) {
  return { id: uuid(70), creator_id: f.userId, status: "running",
    deadline_at: new Date(f.clock.now() - 1).toISOString(),
    steps: [{ status: "succeeded", output_text: "Preserve this prior output" }, { status: "running" }, { status: "pending" }], ...overrides };
}
const operations = f => f.calls.map(call => call.operation);

test("finalization reserves seven I/O stages and pre-step admission reserves all three step writes/checks", async () => {
  const f = await executionFixture(), { LIMITS } = f.load("lib/execution/types.ts");
  const { ExecutionBudget } = f.load("lib/execution/budget.ts");
  assert.equal(LIMITS.finalReserveMs, 7 * LIMITS.ioMs); assert.equal(LIMITS.finalReserveMs, 35000);
  const minimum = LIMITS.finalReserveMs + 3 * LIMITS.ioMs + LIMITS.minProviderMs;
  assert.equal(minimum, 55000);
  const budget = new ExecutionBudget(f.clock);
  f.clock.advance(budget.remaining() - minimum);
  budget.beforeStep();
  f.clock.advance(1);
  assert.throws(() => budget.beforeStep(), error => error.code === "deadline_exceeded");
});

test("three successful steps retain full allowance for rendering, validation, upload, finalize and confirmation", async () => {
  const f = await executionFixture({ count: 3 });
  const persistence = f.session.persistence, storage = f.session.storage;
  const saved = () => f.steps.every(step => step.status === "succeeded");
  const third = () => f.steps.filter(step => step.status === "succeeded").length >= 2;
  const timed = (duration, work) => async (...args) => {
    const value = await work(...args); f.clock.advance(duration()); return value;
  };
  const stages = [], scheduled = [], schedule = f.clock.schedule;
  f.clock.schedule = (callback, ms) => { scheduled.push(ms); return schedule(callback, ms); };
  const session = { ...f.session, persistence: { ...persistence,
    reconcileExpiredRunning: timed(() => 2000, (...args) => persistence.reconcileExpiredRunning(...args)),
    load: timed(() => saved() ? 4900 : 2000, (...args) => persistence.load(...args)),
    advance: async (...args) => {
      const value = await persistence.advance(...args), command = args[1];
      f.clock.advance(command.payload?.position === 3 || command.operation === "finalize" ? 4900 : 2000);
      if (command.operation === "complete_step" && command.payload.position === 3) stages.push(["last_step", f.clock.monotonic()]);
      return value;
    },
  }, storage: { ...storage,
    readInput: timed(() => 2000, (...args) => storage.readInput(...args)),
    storeArtifact: timed(() => 4900, (...args) => { stages.push(["upload", f.clock.monotonic()]); return storage.storeArtifact(...args); }),
  } };
  const images = f.load("lib/execution/images.ts"), validateImage = images.validateImage;
  images.validateImage = timed(() => saved() ? 4900 : 0, (...args) => validateImage(...args));
  f.reply = async index => { f.clock.advance(index === 3 ? 11100 : 15000); return jsonResponse(completion(`Caption ${index}`)); };
  f.render = async () => {
    assert.equal(scheduled.at(-1), 5000, "Renderer receives its full ceiling, not a leftover fraction");
    stages.push(["render", f.clock.monotonic()]); f.clock.advance(4400); return f.bytes;
  };
  const result = await f.engine({ authorize: timed(() => third() ? 4900 : 2000, async () => session) }).execute(f.runId);
  assert.equal(result.status, "succeeded"); assert.equal(result.error, undefined);
  assert.equal(f.requests.length, 3); assert.deepEqual(f.steps.map(step => step.status), ["succeeded", "succeeded", "succeeded"]);
  assert.equal(f.uploads.length, 1); assert.equal(operations(f).filter(op => op === "finalize").length, 1);
  assert.equal(stages[0][0], "last_step");
  assert.ok(115000 - stages[0][1] >= 35000, "At least 35 seconds remain after the final step write");
  assert.equal(f.row.final_text, "Caption 3"); assert.ok(f.clock.monotonic() < 115000);
});

test("insufficient pre-step time refuses a new provider request and preserves prior output", async () => {
  const f = await executionFixture({ count: 3 });
  f.afterCommit = async (op, args) => { if (op === "complete_step" && args.p_payload.position === 1) f.clock.advance(4900); };
  f.reply = async () => { f.clock.advance(19000); return jsonResponse(completion()); };
  const result = await f.engine({ hostBudgetMs: 80000 }).execute(f.runId);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "deadline_exceeded");
  assert.equal(f.requests.length, 1); assert.equal(f.steps[0].status, "succeeded");
  assert.equal(f.steps[0].output_text, "A literal custom caption"); assert.equal(f.uploads.length, 0);
});

for (const phase of ["render", "artifact_validation"]) test(`expiry during ${phase} prevents upload and finalization`, async () => {
  const f = await executionFixture({ count: 3 });
  if (phase === "render") f.render = async () => { f.clock.advance(120001); return f.bytes; };
  else {
    const images = f.load("lib/execution/images.ts"), original = images.validateImage;
    images.validateImage = async (...args) => {
      const value = await original(...args);
      if (f.steps.every(step => step.status === "succeeded")) f.clock.advance(120001);
      return value;
    };
  }
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "interrupted"); assert.equal(f.row.error_code, "execution_expired");
  assert.equal(f.requests.length, 3); assert.ok(f.steps.every(step => step.status === "succeeded"));
  assert.equal(f.uploads.length, 0); assert.equal(operations(f).includes("finalize"), false);
});

test("a late in-flight upload is never finalized or reported as successful", async () => {
  const f = await executionFixture({ count: 3 }), storage = f.session.storage;
  f.session.storage = { ...storage, storeArtifact: async (...args) => {
    await storage.storeArtifact(...args); f.clock.advance(120001);
  } };
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "interrupted"); assert.equal(operations(f).includes("finalize"), false);
  assert.equal(f.row.artifact_sha256, null); assert.equal(f.requests.length, 3);
});

for (const stage of ["render", "upload"]) test(`${stage} failure preserves all successful steps and confirms terminal cleanup`, async () => {
  const f = await executionFixture({ count: 3 });
  if (stage === "render") f.render = async () => { throw new Error("SECRET renderer path/token"); };
  else f.uploadFailure = true;
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "artifact_error");
  assert.ok(f.steps.every(step => step.status === "succeeded")); assert.equal(f.row.final_text, "A literal custom caption");
  assert.equal(operations(f).includes("finalize"), false);
  assert.equal(f.diagnostics[0].stage, stage); assert.equal(f.diagnostics[0].cleanup, "confirmed");
});

test("failed terminal cleanup is explicitly unknown and diagnostic fields cannot leak execution data", async () => {
  const f = await executionFixture();
  f.render = async () => { f.throwAt = "fail"; throw new Error("SECRET raw response and lease token"); };
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "unknown"); assert.equal(result.error.code, "artifact_error"); assert.equal(f.row.status, "running");
  assert.equal(f.diagnostics.length, 1);
  assert.deepEqual(Object.keys(f.diagnostics[0]).sort(), ["runId", "stage", "code", "elapsedMs", "remainingMs", "cleanup"].sort());
  assert.equal(f.diagnostics[0].cleanup, "unconfirmed"); assert.equal(f.diagnostics[0].runId, f.runId);
  assert.doesNotMatch(JSON.stringify([result, f.diagnostics]), /SECRET|synthetic|lease|base64|Authorization|captioned\.png|Literal instruction|A literal custom caption/);
  assert.equal(f.requests.length, 3); assert.equal(f.uploads.length, 0);
});

test("diagnostic logging failure cannot disrupt terminal cleanup", async () => {
  const f = await executionFixture(); f.uploadFailure = true;
  assert.equal((await f.engine({ diagnose() { throw new Error("offline logger failure"); } }).execute(f.runId)).status, "failed");
});

test("provider failure diagnostics omit credentials, response text and provider metadata", async () => {
  const f = await executionFixture();
  f.reply = async () => jsonResponse({ ...completion("SECRET raw model response"), error: { message: "SECRET credential and database detail" } });
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "failed"); assert.equal(f.diagnostics[0].stage, "provider");
  assert.equal(f.diagnostics[0].code, "provider_error"); assert.equal(f.diagnostics[0].cleanup, "confirmed");
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /SECRET|synthetic|response-test|mock\/vision|input\.|captioned\.png|lease|output_text/);
  assert.equal(f.requests.length, 1);
});

test("expired owned execution is reconciled with the exact RPC before claiming a new run", async () => {
  const f = await executionFixture(); const old = staleRun(f); f.otherRuns.push(old);
  const preserved = structuredClone(old.steps[0]);
  assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
  assert.equal(old.status, "interrupted"); assert.deepEqual(old.steps[0], preserved);
  assert.deepEqual(old.steps.map(step => step.status), ["succeeded", "interrupted", "skipped"]);
  assert.deepEqual(f.calls.find(call => call.operation === "expire").args,
    { p_run_id: old.id, p_operation: "expire", p_lease_token: null, p_payload: {} });
  assert.ok(operations(f).indexOf("expire") < operations(f).indexOf("claim"));
  const lookup = f.persistenceQueries.find(query => query.filters.creator_id);
  assert.deepEqual(lookup.filters, { creator_id: f.userId, status: "running" });
  assert.equal(lookup.fields, "id,creator_id,status,deadline_at");
  assert.equal(f.requests.length, 3); assert.ok(f.calls.filter(call => call.operation !== "expire").every(call => call.args.p_run_id === f.runId));
});

test("unexpired running execution blocks a new claim without expiration or provider calls", async () => {
  const f = await executionFixture(); const old = staleRun(f, { deadline_at: new Date(f.clock.now() + 60000).toISOString() });
  f.otherRuns.push(old); const before = structuredClone(old);
  const result = await f.engine().execute(f.runId);
  assert.equal(result.error.code, "persistence_error"); assert.equal(f.row.status, "prepared");
  assert.deepEqual(old, before); assert.equal(operations(f).includes("expire"), false); assert.equal(f.requests.length, 0);
});

test("foreign-owned expired run is untouched and cannot be selected for reconciliation", async () => {
  const f = await executionFixture(); const foreign = staleRun(f, { creator_id: uuid(71) });
  f.otherRuns.push(foreign); const before = structuredClone(foreign);
  assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
  assert.deepEqual(foreign, before); assert.equal(operations(f).includes("expire"), false);
});

test("expiration cannot be confirmed: stop before claim, without replaying old or new providers", async () => {
  const f = await executionFixture(); f.otherRuns.push(staleRun(f)); f.throwAt = "expire";
  const result = await f.engine().execute(f.runId);
  assert.equal(result.error.code, "persistence_error"); assert.equal(f.row.status, "prepared");
  assert.equal(operations(f).includes("claim"), false); assert.equal(f.requests.length, 0);
  assert.equal(f.diagnostics[0].stage, "reconcile");
});

test("revoked authorization at expiration cannot mutate a stale run or claim new work", async () => {
  const f = await executionFixture(); const old = staleRun(f); f.otherRuns.push(old);
  const before = structuredClone(old), rpc = f.client.rpc;
  f.client.rpc = (name, args) => {
    if (args.p_operation === "expire") f.authorized = false;
    return rpc(name, args);
  };
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "unknown"); assert.equal(result.error.code, "persistence_error");
  assert.deepEqual(old, before); assert.equal(operations(f).includes("claim"), false); assert.equal(f.requests.length, 0);
});

test("database refuses expiry under clock skew; claim remains blocked", async () => {
  const f = await executionFixture(); f.otherRuns.push(staleRun(f, { deadline_at: new Date(f.clock.now() + 60000).toISOString() }));
  const { createExecutionPersistence } = f.load("lib/execution/supabase.ts");
  f.session.persistence = createExecutionPersistence(f.client, f.userId, () => f.clock.now() + 120000);
  const result = await f.engine().execute(f.runId);
  assert.equal(result.error.code, "persistence_error"); assert.equal(f.otherRuns[0].status, "running");
  assert.equal(operations(f).includes("claim"), false); assert.equal(f.requests.length, 0);
});

for (const invalid of [{ run_id: uuid(99) }, { status: "running" }, { accepted: true }]) test(`ambiguous expiry receipt prevents claim: ${JSON.stringify(invalid)}`, async () => {
  const f = await executionFixture(); f.otherRuns.push(staleRun(f));
  const rpc = f.client.rpc;
  f.client.rpc = (name, args) => ({ async abortSignal(signal) {
    const value = await rpc(name, args).abortSignal(signal);
    return args.p_operation === "expire" ? { ...value, data: { ...value.data, ...invalid } } : value;
  } });
  const result = await f.engine().execute(f.runId);
  assert.equal(result.error.code, "persistence_error"); assert.equal(operations(f).includes("claim"), false);
  assert.equal(f.requests.length, 0); assert.equal(f.row.status, "prepared");
});

test("a foreign-owned row returned unexpectedly by the lookup is rejected before mutation", async () => {
  const f = await executionFixture(), from = f.client.from;
  f.client.from = table => {
    const builder = from(table), select = builder.select;
    builder.select = fields => {
      select(fields);
      if (fields === "id,creator_id,status,deadline_at") builder.maybeSingle = async () => ({ data: staleRun(f, { creator_id: uuid(71) }), error: null });
      return builder;
    };
    return builder;
  };
  assert.equal((await f.engine().execute(f.runId)).error.code, "contract_mismatch");
  assert.equal(operations(f).includes("expire"), false); assert.equal(operations(f).includes("claim"), false); assert.equal(f.requests.length, 0);
});

test("a new active run between reconciliation and claim is still blocked by the database", async () => {
  const f = await executionFixture(); f.otherRuns.push(staleRun(f));
  f.afterCommit = async op => {
    if (op === "expire") f.otherRuns.push(staleRun(f, { id: uuid(72), deadline_at: new Date(f.clock.now() + 60000).toISOString() }));
  };
  const result = await f.engine().execute(f.runId);
  assert.equal(result.error.code, "persistence_error"); assert.equal(f.row.status, "prepared");
  assert.equal(f.requests.length, 0); assert.equal(f.otherRuns[1].status, "running");
});

test("concurrent reconciliations retain one winning claim and one set of new provider requests", async () => {
  const f = await executionFixture(); f.otherRuns.push(staleRun(f));
  const results = await Promise.all([f.engine().execute(f.runId), f.engine().execute(f.runId)]);
  assert.ok(results.some(result => result.status === "succeeded")); assert.equal(f.row.status, "succeeded");
  assert.equal(f.otherRuns[0].status, "interrupted"); assert.equal(f.requests.length, 3);
  assert.equal(operations(f).filter(op => op === "start_step").length, 3);
  assert.equal(operations(f).filter(op => op === "finalize").length, 1);
});

test("default composed generation remains one invocation after stale-run reconciliation", async () => {
  const f = await executionFixture({ mode: "composed" }); f.otherRuns.push(staleRun(f));
  assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
  assert.equal(f.requests.length, 1); assert.equal(f.uploads.length, 1);
  assert.equal(f.row.final_text, '{"caption_a":"First caption","caption_b":"Second caption"}');
});
