import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executionFixture, loadExecution, fakeClock, image, completion, jsonResponse, uuid, hash, plain, root } from "./helpers/execution-core-fixture.mjs";

test("default: one RPC-composed invocation, exact raw JSON, real mock PNG upload, persisted success", async () => {
  const f = await executionFixture({ mode: "composed" }), raw = '  {"caption_a":"First caption","caption_b":"Second caption"}\n';
  const original = structuredClone(f.source);
  f.reply = async () => jsonResponse(completion(raw));
  let rendered;
  f.render = async input => { rendered = input; return image(); };
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "succeeded"); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.messages[1].content[0].text, f.dbPrompt);
  assert.equal(f.requests[0].body.response_format.type, "json_object");
  assert.equal(f.steps.length, 1); assert.equal(f.row.step_snapshot.length, 4);
  assert.equal(f.row.final_text, raw); assert.equal(rendered.finalText, raw);
  assert.deepEqual(f.source, original); assert.deepEqual(f.row.step_snapshot, original);
  assert.deepEqual(f.uploads, [f.row.artifact_path]);
  assert.equal(f.row.artifact_sha256, hash(await image()));
  assert.deepEqual(plain(result), { runId: f.runId, status: "succeeded" });
});

test("custom: five gapped snapshot steps execute literally with every preceding raw output and original image", async () => {
  const f = await executionFixture({ count: 5 });
  f.reply = async index => jsonResponse(completion(` Raw output ${index}\n`));
  assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
  assert.equal(f.requests.length, 5);
  f.requests.forEach((request, i) => {
    const parts = request.body.messages[1].content;
    assert.equal(parts[0].text, f.source[i].prompt_template);
    assert.ok(parts[0].text.includes("{{never_evaluate}}"));
    assert.equal(parts[1].image_url.url, `data:image/png;base64,${f.bytes.toString("base64")}`);
    const inputs = JSON.parse(parts[2].text.split("\n").slice(1).join("\n"));
    assert.equal(inputs.user_context, f.row.user_context);
    assert.deepEqual(inputs.previous_outputs.map(step => step.output_text), Array.from({ length: i }, (_, j) => ` Raw output ${j + 1}\n`));
    assert.equal(request.body.response_format, undefined);
  });
  assert.equal(f.row.final_text, " Raw output 5\n");
});

test("prepare guards metadata and returns only the database-derived private upload descriptor", async () => {
  const f = await executionFixture();
  const result = await f.engine().prepare({ chainId: f.row.original_chain_id, idempotencyKey: uuid(77),
    image: { mime: "image/png", size: f.bytes.length, sha256: hash(f.bytes) }, userContext: f.row.user_context,
    creatorId: "forged", storagePath: "forged", model: "paid-model", snapshot: "forged" });
  assert.equal(result.status, "prepared"); assert.equal(result.upload.path, f.row.input_path);
  assert.equal(f.requests.length, 0); assert.equal(f.uploads.length, 0);
  const args = f.calls[0].args;
  assert.equal(args.p_input_sha256, hash(f.bytes)); assert.equal(args.p_idempotency_key, uuid(77));
  assert.doesNotMatch(JSON.stringify(args), /forged|paid-model|snapshot|creatorId/);
  const bad = await f.engine().prepare({ chainId: f.row.original_chain_id, idempotencyKey: uuid(77), image: { mime: "image/svg+xml", size: 1, sha256: "bad" } });
  assert.equal(bad.error.code, "input_invalid");
});

for (const format of ["jpeg", "png", "webp"]) {
  test(`actual ${format} signatures, full decode, dimensions and SHA256 are checked`, async () => {
    const f = await executionFixture({ count: 1, format });
    assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
    assert.match(f.requests[0].body.messages[1].content[1].image_url.url, new RegExp(`^data:image/${format};base64,`));
    const validated = await f.load("lib/execution/images.ts").validateImage(f.bytes);
    assert.equal(validated.width, 3); assert.equal(validated.height, 2); assert.equal(validated.sha256, hash(f.bytes));
  });
}

test("malformed/truncated files, MIME mismatch, hash mismatch, oversized bytes and excessive dimensions are rejected", async () => {
  const validate = loadExecution()("lib/execution/images.ts").validateImage, png = await image();
  for (const bytes of [Buffer.from("not an image"), png.subarray(0, 20), Buffer.alloc(5_242_881), await image("png", 8193, 1), await image("png", 5000, 4001),
    (await image("jpeg")).subarray(0, 20), (await image("webp")).subarray(0, 20)]) {
    await assert.rejects(validate(bytes), error => error.code === "input_invalid");
  }
  await assert.rejects(validate(png, { mime: "image/jpeg" }), error => error.code === "input_invalid");
  await assert.rejects(validate(png, { mime: "image/png", sha256: "0".repeat(64) }), error => error.code === "input_invalid");
  // A valid signature and header alone is not sufficient decoding evidence.
  await assert.rejects(validate(png.subarray(0, png.length - 20)), error => error.code === "input_invalid");
});

test("input hash failure persists an input error before claim/provider; arbitrary storage paths fail closed", async () => {
  const f = await executionFixture();
  f.row.input_sha256 = "0".repeat(64);
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "input_invalid");
  assert.equal(f.calls.some(call => call.operation === "claim"), false); assert.equal(f.requests.length, 0);
  const other = await executionFixture(); other.row.input_path = "https://attacker.invalid/image.png";
  assert.equal((await other.engine().execute(other.runId)).error.code, "contract_mismatch");
  assert.equal(other.reads.length, 0); assert.equal(other.requests.length, 0);
});

test("missing renderer and missing provider configuration make no AI call and cannot finish a run", async () => {
  const f = await executionFixture();
  const absent = await f.engine({ renderer: undefined }).execute(f.runId);
  assert.equal(absent.status, "prepared"); assert.equal(absent.error.code, "renderer_unavailable");
  const provider = f.load("lib/execution/openrouter.ts").createOpenRouterProvider({ clock: f.clock,
    getApiKey: () => undefined, fetch: async () => { assert.fail("Missing configuration must not request"); } });
  const missing = await f.engine({ provider }).execute(f.runId);
  assert.equal(missing.status, "prepared"); assert.equal(missing.error.code, "provider_not_configured");
  assert.equal(f.requests.length, 0); assert.equal(f.calls.length, 0);
});

test("authorization denies before private input reads; mid-execution demotion prevents further provider calls", async () => {
  const f = await executionFixture(); f.authorized = false;
  assert.equal((await f.engine().execute(f.runId)).status, "unavailable");
  assert.equal(f.reads.length, 0); assert.equal(f.requests.length, 0);
  const demoted = await executionFixture();
  demoted.afterCommit = async op => { if (op === "complete_step") demoted.authorized = false; };
  const result = await demoted.engine().execute(demoted.runId);
  assert.equal(result.error.code, "access_denied"); assert.equal(demoted.requests.length, 1);
  assert.equal(demoted.steps[0].status, "succeeded"); assert.equal(demoted.steps[1].status, "pending");
});

test("provider requests are fixed, capped, no-store, redirect-resistant and contain no tool/fallback instructions", async () => {
  const f = await executionFixture({ count: 1 }); await f.engine().execute(f.runId);
  const { url, options, body } = f.requests[0];
  assert.equal(url, "https://openrouter.ai/api/v1/chat/completions"); assert.equal(options.redirect, "error");
  assert.equal(options.cache, "no-store"); assert.equal(body.model, "openrouter/free"); assert.equal(body.max_completion_tokens, 2000);
  assert.equal(body.n, 1); assert.equal(body.stream, false); assert.equal(body.provider.allow_fallbacks, false);
  assert.equal(body.provider.require_parameters, true);
  for (const field of ["tools", "plugins", "models", "route", "web_search_options"]) assert.equal(body[field], undefined);
});

test("completion validation: normalized stop succeeds and keeps raw output and safe metadata", async () => {
  const f = await executionFixture({ count: 1 }), output = "  Normally completed caption\n";
  f.reply = async () => jsonResponse(completion(output, {
    choices: [{ message: { content: output }, finish_reason: "stop", native_finish_reason: "end_turn" }],
  }));
  assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
  assert.equal(f.requests.length, 1); assert.equal(f.steps[0].finish_reason, "stop");
  assert.equal(f.row.final_text, output); assert.equal(f.steps[0].actual_model, "mock/vision:free");
});

for (const [name, choiceFields, code, topLevel = {}] of [
  ["missing finish reason", {}, "output_invalid"],
  ["null finish reason", { finish_reason: null }, "output_invalid"],
  ["unexpected finish reason", { finish_reason: "unrecognized_completion" }, "output_invalid"],
  ["native-only end turn", { finish_reason: "end_turn" }, "output_invalid"],
  ["malformed finish reason", { finish_reason: { value: "stop" } }, "output_invalid"],
  ["empty finish reason", { finish_reason: "" }, "output_invalid"],
  ["padded stop", { finish_reason: " stop " }, "output_invalid"],
  ["uppercase stop", { finish_reason: "STOP" }, "output_invalid"],
  ["length finish reason", { finish_reason: "length" }, "output_invalid"],
  ["error finish reason", { finish_reason: "error" }, "output_invalid"],
  ["filtered finish reason", { finish_reason: "content_filter" }, "output_invalid"],
  ["tool-call finish reason", { finish_reason: "tool_calls" }, "output_invalid"],
  ["raw native stop without normalized reason", { native_finish_reason: "stop" }, "output_invalid"],
  ["raw native stop with normalized error", { finish_reason: "error", native_finish_reason: "stop" }, "output_invalid"],
  ["unsafe finish reason", { finish_reason: "SECRET raw\ncompletion status" }, "output_invalid"],
  ["choice error despite stop", { finish_reason: "stop", error: { code: 503, message: "SECRET raw provider error", metadata: { raw: "SECRET upstream detail" } } }, "provider_error"],
  ["empty choice error object", { finish_reason: "stop", error: {} }, "provider_error"],
  ["top-level error despite stop", { finish_reason: "stop" }, "provider_error", { error: { message: "SECRET top-level provider error" } }],
]) {
  test(`completion validation: ${name} fails closed despite valid text, without retry or leakage`, async () => {
    const f = await executionFixture(), output = "Valid-looking caption text must not override failed completion.";
    f.reply = async () => jsonResponse(completion(output, { ...topLevel,
      choices: [{ message: { content: output }, ...choiceFields }],
    }));
    const result = await f.engine().execute(f.runId);
    assert.equal(result.status, "failed"); assert.equal(result.error.code, code);
    assert.equal(f.requests.length, 1); assert.equal(f.calls.filter(call => call.operation === "fail").length, 1);
    assert.equal(f.calls.some(call => call.operation === "complete_step" || call.operation === "finalize"), false);
    assert.deepEqual(f.steps.map(step => step.status), ["failed", "skipped", "skipped"]);
    assert.equal(f.uploads.length, 0);
    const failed = f.steps[0];
    assert.equal(failed.provider_http_status, 200); assert.equal(failed.actual_model, "mock/vision:free");
    assert.equal(failed.provider_response_id, "response-test"); assert.equal(failed.output_text, output);
    assert.equal(failed.prompt_tokens, 11); assert.equal(failed.completion_tokens, 4); assert.equal(failed.total_tokens, 15); assert.equal(failed.cost_usd, 0);
    const reason = choiceFields.finish_reason;
    assert.equal(failed.finish_reason, typeof reason === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(reason) ? reason : undefined);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|synthetic-test-credential|lease_token|aaaaaaaa/);
    assert.doesNotMatch(JSON.stringify(f.calls), /SECRET|synthetic-test-credential|base64/);
  });
}

for (const [name, reply, code] of [
  ["HTTP 429", () => jsonResponse({ error: { message: "SECRET provider credential detail" } }, 429), "provider_error"],
  ["HTTP 503", () => jsonResponse({ error: "SECRET unavailable" }, 503), "provider_error"],
  ["invalid JSON", () => new Response("SECRET not JSON", { status: 200 }), "provider_error"],
  ["empty output", () => jsonResponse(completion("  \n")), "output_invalid"],
  ["missing returned model", () => jsonResponse(completion("text", { model: null })), "provider_error"],
  ["wrong content shape", () => jsonResponse(completion([{}])), "output_invalid"],
  ["unfinished output", () => jsonResponse(completion("partial", { choices: [{ message: { content: "partial" }, finish_reason: "length" }] })), "output_invalid"],
  ["too much output", () => jsonResponse(completion("x".repeat(32769))), "output_invalid"],
  ["reported paid usage", () => jsonResponse(completion("text", { usage: { cost: 0.1 } })), "provider_error"],
]) {
  test(`provider ${name} is sanitized, persisted as failure and never retried`, async () => {
    const f = await executionFixture(); f.reply = async () => reply();
    const result = await f.engine().execute(f.runId);
    assert.equal(result.status, "failed"); assert.equal(result.error.code, code);
    assert.equal(f.requests.length, 1); assert.equal(f.steps[0].status, "failed"); assert.equal(f.steps[1].status, "skipped");
    assert.doesNotMatch(JSON.stringify(result), /SECRET|synthetic-test-credential|lease_token|aaaa/);
    assert.doesNotMatch(JSON.stringify(f.calls), /SECRET|synthetic-test-credential|base64/);
  });
}

test("missing/malformed optional usage remains absent; valid zero metadata stays zero", async () => {
  for (const usage of [undefined, { prompt_tokens: -1, completion_tokens: "4", total_tokens: 1.5, cost: "0" }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 }]) {
    const f = await executionFixture({ count: 1 }); f.reply = async () => jsonResponse(completion("caption", { usage }));
    assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
    assert.equal(f.steps[0].prompt_tokens, usage?.prompt_tokens === 0 ? 0 : undefined);
    assert.equal(f.steps[0].cost_usd, usage?.cost === 0 ? 0 : undefined);
  }
});

test("provider timeout aborts a stalled mock request once and records no automatic retry", async () => {
  const f = await executionFixture(); let aborted = false;
  f.reply = async (_, signal) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    f.clock.advance(20_001); return new Promise(() => {});
  };
  const result = await f.engine().execute(f.runId);
  assert.equal(result.error.code, "provider_timeout"); assert.equal(result.status, "failed");
  assert.equal(aborted, true); assert.equal(f.requests.length, 1);
});

test("response stream and declared body caps stop oversized responses without persisting the body", async () => {
  for (const declared of [false, true]) {
    const f = await executionFixture(); let cancelled = false;
    f.reply = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(131073)); }, cancel() { cancelled = true; } }),
      { status: 200, headers: declared ? { "Content-Length": "131073" } : {} });
    assert.equal((await f.engine().execute(f.runId)).status, "failed");
    assert.equal(cancelled, true); assert.equal(f.requests.length, 1); assert.equal(f.steps[0].output_text, undefined);
  }
});

test("cancellation during provider call aborts once and retains a safe persisted failure", async () => {
  const f = await executionFixture(), controller = new AbortController();
  f.reply = async () => { controller.abort(); return new Promise(() => {}); };
  const result = await f.engine().execute(f.runId, { signal: controller.signal });
  assert.equal(result.error.code, "cancelled"); assert.equal(result.status, "failed"); assert.equal(f.requests.length, 1);
  assert.equal(f.row.error_code, "provider_timeout"); // Installed RPC has no cancellation code.
});

test("a short lease refuses to start a provider; an expired lease records interrupted work", async () => {
  const f = await executionFixture(); f.leaseDelta = 2000;
  const short = await f.engine().execute(f.runId);
  assert.equal(short.status, "failed"); assert.equal(short.error.code, "deadline_exceeded"); assert.equal(f.requests.length, 0);
  const expired = await executionFixture();
  expired.reply = async () => { expired.clock.advance(120_001); return jsonResponse(completion()); };
  const result = await expired.engine().execute(expired.runId);
  assert.equal(result.status, "interrupted"); assert.equal(expired.requests.length, 1);
});

test("the next provider is not started after preceding calls exhaust safe finalization reserves", async () => {
  const f = await executionFixture({ count: 5 });
  f.reply = async () => { f.clock.advance(19_000); return jsonResponse(completion()); };
  const result = await f.engine().execute(f.runId);
  assert.notEqual(result.status, "succeeded"); assert.ok(f.requests.length < 5);
  assert.equal(f.uploads.length, 0);
});

test("Step 2 failure preserves Step 1's original result and skips later calls", async () => {
  const f = await executionFixture();
  f.reply = async index => index === 1 ? jsonResponse(completion("  Keep step 1 raw\n")) : jsonResponse({ error: "SECRET" }, 429);
  assert.equal((await f.engine().execute(f.runId)).status, "failed");
  assert.deepEqual(f.steps.map(step => step.status), ["succeeded", "failed", "skipped"]);
  assert.equal(f.steps[0].output_text, "  Keep step 1 raw\n"); assert.equal(f.steps[1].provider_http_status, 429);
  assert.equal(f.requests.length, 2); assert.equal(f.uploads.length, 0);
});

test("duplicate execution attempts cannot cause two provider calls or steal the winning claim", async () => {
  const f = await executionFixture({ count: 1 });
  const results = await Promise.all([f.engine().execute(f.runId), f.engine().execute(f.runId)]);
  assert.equal(f.requests.length, 1); assert.equal(f.row.status, "succeeded");
  assert.ok(results.some(result => result.status === "succeeded"));
  assert.equal(f.calls.filter(call => call.operation === "fail").length, 0);
});

test("non-accepted starts and completions never advance, retry, or fail another in-flight transition", async () => {
  for (const operation of ["start_step", "complete_step"]) {
    const f = await executionFixture(); f.refuse = operation;
    const result = await f.engine().execute(f.runId);
    assert.equal(result.error.code, "execution_conflict");
    assert.equal(f.requests.length, operation === "start_step" ? 0 : 1);
    assert.equal(f.calls.some(call => call.operation === "fail"), false);
    assert.equal(f.uploads.length, 0);
  }
});

test("database completion failure preserves prior results; an ambiguous claim never starts a provider", async () => {
  const f = await executionFixture();
  f.afterCommit = async (op, args) => { if (op === "complete_step" && args.p_payload.position === 1) f.throwAt = "complete_step"; };
  assert.equal((await f.engine().execute(f.runId)).status, "failed");
  assert.equal(f.steps[0].status, "succeeded"); assert.equal(f.requests.length, 2);
  const ambiguous = await executionFixture();
  ambiguous.afterCommit = async op => { if (op === "claim") { ambiguous.clock.advance(5001); return new Promise(() => {}); } };
  const result = await ambiguous.engine().execute(ambiguous.runId);
  assert.equal(result.status, "running"); assert.equal(result.error.code, "persistence_error");
  assert.equal(ambiguous.requests.length, 0); assert.equal(ambiguous.calls.filter(call => call.operation === "claim").length, 1);
});

for (const [name, setup] of [
  ["renderer throws", f => { f.render = async () => { throw new Error("SECRET renderer detail"); }; }],
  ["invalid PNG", f => { f.render = async () => Buffer.from("not PNG"); }],
  ["upload fails", f => { f.uploadFailure = true; }],
  ["wrong upload acknowledgement", f => { f.badUploadReceipt = true; }],
]) {
  test(`artifact ${name} prevents finalization and preserves the generated text`, async () => {
    const f = await executionFixture({ count: 1 }); setup(f);
    const result = await f.engine().execute(f.runId);
    assert.equal(result.status, "failed"); assert.equal(result.error.code, "artifact_error");
    assert.equal(f.row.final_text, "A literal custom caption"); assert.equal(f.steps[0].status, "succeeded");
    assert.equal(f.calls.some(call => call.operation === "finalize"), false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|lease_token|base64/);
  });
}

test("default invalid caption JSON is recorded raw but cannot render or succeed; custom formats remain unrestricted", async () => {
  for (const output of ["not JSON", '{"caption_a":"same","caption_b":"same"}', '{"caption_a":" ","caption_b":"other"}', '{"caption_a":"one","caption_b":"two","extra":true}']) {
    const f = await executionFixture({ mode: "composed" }); f.reply = async () => jsonResponse(completion(output));
    assert.equal((await f.engine().execute(f.runId)).status, "failed");
    assert.equal(f.steps[0].output_text, output); assert.equal(f.uploads.length, 0);
  }
  const custom = await executionFixture({ count: 1 }); custom.reply = async () => jsonResponse(completion('{"custom_format":[1,2]}'));
  assert.equal((await custom.engine().execute(custom.runId)).status, "succeeded");
});

test("persisted envelopes reject a changed model or snapshot and all browser-safe results omit private execution data", async () => {
  const f = await executionFixture(); f.row.requested_model = "paid/model";
  assert.equal((await f.engine().execute(f.runId)).error.code, "contract_mismatch"); assert.equal(f.requests.length, 0);
  const good = await executionFixture({ count: 1 }); const result = await good.engine().execute(good.runId);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /synthetic|aaaa|base64|snapshot|lease|provider_response|Optional user context/);
  assert.doesNotMatch(JSON.stringify(good.calls), /Authorization|synthetic|data:image/);
});

test("public server factory invokes the existing guard and does not read a credential when unintegrated", async () => {
  let guards = 0;
  const load = loadExecution({ "@/lib/auth/require-superadmin": { async requireSuperadmin() { guards++; throw new Error("SECRET denied"); } } });
  const core = load("lib/execution/index.ts").createServerExecutionEngine();
  const result = await core.execute(uuid(2));
  assert.equal(guards, 1); assert.equal(result.error.code, "access_denied");
});

test("budget uses monotonic elapsed time and cannot inherit a longer database lease", () => {
  const clock = fakeClock(), { ExecutionBudget } = loadExecution()("lib/execution/budget.ts");
  const budget = new ExecutionBudget(clock);
  budget.claim(clock.now() + 600_000, clock.monotonic());
  assert.ok(budget.remaining() <= 115_000);
  clock.advance(90_000);
  assert.throws(() => budget.beforeStep(), error => error.code === "deadline_exceeded");
});

test("late synchronous work cannot bypass its timeout by delaying the event-loop timer", async () => {
  const clock = fakeClock(), { bounded } = loadExecution()("lib/execution/budget.ts");
  const delayedTimerClock = { ...clock, schedule: () => () => {} };
  await assert.rejects(bounded(delayedTimerClock, 100, undefined, "artifact_error", async () => {
    clock.advance(101); return "late PNG";
  }), error => error.code === "artifact_error");
});

test("lost finalization acknowledgement is resolved by readback; failed confirmation never invents success", async () => {
  const f = await executionFixture({ count: 1 });
  f.afterCommit = async op => { if (op === "finalize") throw new Error("SECRET lost acknowledgement"); };
  const result = await f.engine().execute(f.runId);
  assert.equal(result.status, "succeeded"); assert.equal(result.error, undefined);
  assert.equal(f.requests.length, 1); assert.equal(f.calls.filter(call => call.operation === "finalize").length, 1);
  const unknown = await executionFixture({ count: 1 });
  unknown.afterCommit = async op => { if (op === "finalize") unknown.readFailure = true; };
  const unconfirmed = await unknown.engine().execute(unknown.runId);
  assert.equal(unconfirmed.status, "unknown"); assert.equal(unconfirmed.error.code, "persistence_error");
  assert.equal(unknown.row.status, "succeeded");
});

test("deleting the live custom chain during execution leaves the frozen plan and successful history intact", async () => {
  const f = await executionFixture(); const snapshot = structuredClone(f.row.step_snapshot);
  f.afterCommit = async op => { if (op === "claim") { f.row.current_chain_id = null; f.source = []; } };
  assert.equal((await f.engine().execute(f.runId)).status, "succeeded");
  assert.equal(f.row.current_chain_id, null); assert.deepEqual(f.row.step_snapshot, snapshot); assert.equal(f.requests.length, 3);
});

test("all execution files are server-only and none registers a route, action, service-role client or SQL write", () => {
  for (const name of ["types", "errors", "budget", "contracts", "images", "openrouter", "supabase", "engine", "index"]) {
    const source = readFileSync(`${root}/lib/execution/${name}.ts`, "utf8");
    assert.match(source, /^import "server-only";/);
    assert.doesNotMatch(source, /["']use server["']|SERVICE_ROLE|\.from\("(?:profiles|prompt_chains|prompt_chain_steps|generation_sets|generations)"\)/);
    // Only the new structured, allowlisted failure event may reach the console.
    const withoutDiagnostic = name === "engine" ? source.replace('console.warn("[prompt-chain-execution]", event)', "") : source;
    assert.doesNotMatch(withoutDiagnostic, /console\.(?:log|warn|error)/);
  }
});
