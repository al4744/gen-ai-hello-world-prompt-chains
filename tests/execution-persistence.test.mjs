import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { executionAdmin as admin, executionFixture } from "./helpers/execution-state-model.mjs";

const read = path => readFileSync(new URL(`../supabase/${path}`, import.meta.url), "utf8");
const core = read("migrations/202611050003_prompt_chain_execution.sql").replace(/--[^\n]*/g, "");
const storage = read("migrations/202611050004_prompt_chain_execution_storage.sql").replace(/--[^\n]*/g, "");
const steps = count => Array.from({ length: count }, (_, index) => ({ id: `step-${index + 1}`, step_order: index + 1, name: `Step ${index + 1}`, prompt_template: ` Literal template ${index + 1}\n` }));
const custom = { id: "custom", name: "Custom", slug: "custom", steps: steps(3) };
const system = { id: "default", name: "Default", slug: "caption-arena-default", steps: steps(4) };
system.steps[2].prompt_template = "<context>{{user_prompt}}</context>";
const input = { chainId: custom.id, key: "request-1" };

async function claimed(f, request = input) {
  const run = await f.prepare(admin, request);
  f.upload(run.id, "input");
  const { token } = await f.advance(admin, run.id, "claim");
  return { run, token };
}

test("migration scope excludes source tables, old RPCs, profile triggers and Storage metadata writes", () => {
  for (const sql of [core, storage]) {
    assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE)\s+(?:TABLE|FUNCTION|POLICY|public\.)|\bDISABLE\s+ROW|\bCREATE\s+OR\s+REPLACE\b/i);
    assert.doesNotMatch(sql, /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+(?:public\.(?:profiles|prompt_chains|prompt_chain_steps|prompt_chain_mix|generations|generation_sets|generation_requests|llm_responses)|storage\.(?:objects|buckets)|auth\.users)\b/i);
    assert.doesNotMatch(sql, /\b(?:ALTER|CREATE)\s+TRIGGER\b/i);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;/);
  }
  assert.equal((core.match(/CREATE TABLE/g) || []).length, 2);
});

test("write boundary uses only two guarded definers, no app-role DML grant, and hides the lease hash", () => {
  assert.equal((core.match(/SECURITY DEFINER/g) || []).length, 2);
  assert.equal((core.match(/SECURITY INVOKER/g) || []).length, 2);
  assert.equal((core.match(/ENABLE ROW LEVEL SECURITY/g) || []).length, 2);
  assert.equal((core.match(/FORCE ROW LEVEL SECURITY/g) || []).length, 2);
  assert.doesNotMatch(core, /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE|TRUNCATE)\b/);
  assert.doesNotMatch(core, /GRANT SELECT ON TABLE public\.prompt_chain_runs\b/);
  const grants = core.match(/GRANT SELECT \([\s\S]*?\) ON public\.prompt_chain_runs TO authenticated;/)[0];
  assert.doesNotMatch(grants, /lease_token_hash/);
  for (const name of ["prepare_prompt_chain_run_v1", "advance_prompt_chain_run_v1"]) {
    const body = core.slice(core.indexOf(`CREATE FUNCTION public.${name}`)).split("$function$;")[0];
    assert.match(body, /auth\.uid\(\)/); assert.match(body, /auth\.role\(\) IS DISTINCT FROM 'authenticated'/);
    assert.match(body, /p\.is_superadmin IS TRUE/); assert.match(body, /SET search_path = pg_catalog/);
    assert.match(core, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}[^;]+FROM PUBLIC, anon, authenticated, service_role;`));
  }
  assert.match(core, /v_run\.creator_id IS DISTINCT FROM v_user/);
  assert.match(core, /'unexpected_run_fields'/);
  assert.match(core, /has_any_column_privilege\(v_role::name, v_table, 'INSERT'\)/);
  assert.match(core, /has_any_column_privilege\(v_role::name, v_table, 'UPDATE'\)/);
  assert.match(core, /'execution_storage_policies_unavailable'/);
});

test("retention, uniqueness, lease and source lock contracts are present", () => {
  assert.match(core, /current_chain_id uuid REFERENCES public\.prompt_chains\(id\) ON DELETE SET NULL/);
  assert.match(core, /creator_id uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  assert.doesNotMatch(core, /source_step_id uuid REFERENCES/);
  assert.match(core, /run_id uuid NOT NULL REFERENCES public\.prompt_chain_runs\(id\) ON DELETE RESTRICT/);
  assert.match(core, /UNIQUE \(creator_id_snapshot, idempotency_key\)/);
  assert.match(core, /CREATE UNIQUE INDEX[^;]+WHERE status = 'running'/);
  assert.match(core, /pg_advisory_xact_lock/);
  assert.ok(core.indexOf("WHERE id = p_chain_id FOR UPDATE") < core.indexOf("ORDER BY s.id FOR UPDATE"));
  assert.match(core, /v_run\.lease_token_hash IS DISTINCT FROM pg_catalog\.sha256/);
});

test("private Storage setup and restrictive guards do not grant overwrite or expose other buckets", () => {
  const config = JSON.parse(read("storage/prompt-chain-execution-media.json"));
  assert.equal(config.public, false); assert.equal(config.fileSizeLimit, 5 * 1024 * 1024);
  assert.deepEqual(config.allowedMimeTypes, ["image/jpeg", "image/png", "image/webp"]);
  assert.equal((storage.match(/AS RESTRICTIVE/g) || []).length, 4);
  assert.match(storage, /FOR UPDATE TO PUBLIC\s+USING \(bucket_id <> 'prompt-chain-execution-media'\)\s+WITH CHECK \(bucket_id <> 'prompt-chain-execution-media'\)/);
  assert.match(storage, /FOR DELETE TO PUBLIC USING \(bucket_id <> 'prompt-chain-execution-media'\)/);
  assert.doesNotMatch(storage, /FOR (?:UPDATE|DELETE) TO authenticated/);
  assert.equal((storage.match(/CREATE POLICY pc_execution_media_/g) || []).length, 2);
});

test("pre/post verification files are read-only statements and contain no lifecycle calls", () => {
  for (const path of ["verification/execution_preflight.sql", "verification/execution_postinstall.sql"]) {
    const sql = read(path).replace(/--[^\n]*/g, "");
    assert.ok(sql.split(";").filter(statement => statement.trim()).every(statement => /^\s*SELECT\b/.test(statement)));
    assert.doesNotMatch(sql, /SELECT\s+(?:public\.)?(?:prepare|advance)_prompt_chain_run_v1\s*\(/);
  }
});

for (const actor of [{ user: null, admin: false }, { user: "ordinary", admin: false }]) {
  test(`model: ${actor.user || "anonymous"} cannot prepare, advance or access media`, async () => {
    const f = executionFixture([custom]);
    const { run } = await claimed(f);
    await assert.rejects(f.prepare(actor, input), /superadmin_required/);
    await assert.rejects(f.advance(actor, run.id, "finalize"), /superadmin_required/);
    assert.equal(f.media(actor, run.id, "input", "read"), false);
  });
}

test("model: another superadmin may inspect, but cannot claim/advance/upload a creator's run", async () => {
  const f = executionFixture([custom]), other = { user: "other-admin", admin: true };
  const { run, token } = await claimed(f);
  await assert.rejects(f.advance(other, run.id, "finalize", { token }), /run_unavailable/);
  assert.equal(f.media(other, run.id, "input", "read"), true);
  assert.equal(f.media(other, run.id, "input", "insert"), false);
});

test("model: a creator with a missing or revoked superadmin flag fails closed on an existing lease", async () => {
  const f = executionFixture([custom]); const { run, token } = await claimed(f);
  for (const actor of [{ user: admin.user }, { user: admin.user, admin: false }]) {
    await assert.rejects(f.advance(actor, run.id, "start_step", { token, position: 1 }), /superadmin_required/);
    assert.equal(f.media(actor, run.id, "input", "read"), false);
  }
});

test("model: concurrent preparations replay one immutable run; changed input under the key fails", async () => {
  const f = executionFixture([custom]);
  const runs = await Promise.all([f.prepare(admin, input), f.prepare(admin, input)]);
  assert.equal(runs[0].id, runs[1].id); assert.equal(f.state().runs.length, 1);
  await assert.rejects(f.prepare(admin, { ...input, context: "Changed" }), /idempotency_input_conflict/);
  f.editChain(custom.id, chain => { chain.steps[0].prompt_template = "Edited later"; });
  assert.equal((await f.prepare(admin, input)).snapshot[0].prompt_template, custom.steps[0].prompt_template);
  f.deleteChain(custom.id);
  assert.equal((await f.prepare(admin, input)).originalChainId, custom.id);
});

test("model: default snapshots retain four sections, one invocation, and literal single-pass substitution", async () => {
  const f = executionFixture([system]);
  const context = "$& \\ {{user_prompt}} <user text>";
  const { run, token } = await claimed(f, { ...input, chainId: system.id, context });
  assert.equal(run.snapshot.length, 4); assert.equal(run.steps.length, 1);
  const start = await f.advance(admin, run.id, "start_step", { token, position: 1 });
  assert.ok(start.context.prompt.includes(`<context>${context}</context>`));
  assert.equal(f.state().chains[0].steps[2].prompt_template, "<context>{{user_prompt}}</context>");
  assert.equal(f.state().runs[0].snapshot[2].prompt_template, "<context>{{user_prompt}}</context>");
});

test("model: custom templates stay literal; image/context and previous output pass to the next invocation", async () => {
  const f = executionFixture([custom]); const { run, token } = await claimed(f);
  await assert.rejects(f.advance(admin, run.id, "start_step", { token, position: 2 }), /execution_order_conflict/);
  await f.advance(admin, run.id, "start_step", { token, position: 1 });
  await f.advance(admin, run.id, "complete_step", { token, position: 1, output: "Natural-language analysis" });
  const next = await f.advance(admin, run.id, "start_step", { token, position: 2 });
  assert.equal(next.context.prompt, custom.steps[1].prompt_template);
  assert.deepEqual(next.context.previous_outputs, ["Natural-language analysis"]);
  assert.equal(next.context.image, run.path);
});

test("model: only one claim and one invocation start win; wrong lease and second active run fail", async () => {
  const f = executionFixture([custom]); const run = await f.prepare(admin, input); f.upload(run.id, "input");
  const claims = await Promise.all([f.advance(admin, run.id, "claim"), f.advance(admin, run.id, "claim")]);
  assert.equal(claims.filter(result => result.accepted).length, 1);
  const token = claims.find(result => result.accepted).token;
  await assert.rejects(f.advance(admin, run.id, "start_step", { token: "wrong", position: 1 }), /valid_execution_lease_required/);
  const starts = await Promise.all([1, 2].map(() => f.advance(admin, run.id, "start_step", { token, position: 1 })));
  assert.equal(starts.filter(result => result.accepted).length, 1);
  const second = await f.prepare(admin, { ...input, key: "request-2" }); f.upload(second.id, "input");
  await assert.rejects(f.advance(admin, second.id, "claim"), /another_run_is_active/);
});

test("model: input and artifact gates, completion and terminal replay preserve a custom non-JSON result", async () => {
  const f = executionFixture([{ ...custom, steps: steps(1) }]); const run = await f.prepare(admin, input);
  await assert.rejects(f.advance(admin, run.id, "claim"), /uploaded_input_unavailable/);
  assert.equal(f.media(admin, run.id, "artifact", "insert"), false);
  f.upload(run.id, "input"); const { token } = await f.advance(admin, run.id, "claim");
  assert.equal(f.media(admin, run.id, "input", "insert"), false);
  await assert.rejects(f.advance(admin, run.id, "finalize", { token }), /execution_incomplete/);
  await f.advance(admin, run.id, "start_step", { token, position: 1 });
  await f.advance(admin, run.id, "complete_step", { token, position: 1, output: "A custom caption" });
  assert.equal(f.media(admin, run.id, "artifact", "insert"), true);
  await assert.rejects(f.advance(admin, run.id, "finalize", { token }), /captioned_artifact_unavailable/);
  f.upload(run.id, "artifact"); await f.advance(admin, run.id, "finalize", { token });
  const before = f.state();
  assert.equal((await f.advance(admin, run.id, "fail", { token })).accepted, false);
  assert.deepEqual(f.state(), before);
  assert.equal(f.media(admin, run.id, "artifact", "read"), true);
  assert.equal(f.media(admin, run.id, "input", "update"), false);
});

test("model: default JSON contract rejects repeated captions while preserving the rejected response", async () => {
  const f = executionFixture([system]); const { run, token } = await claimed(f, { ...input, chainId: system.id });
  await f.advance(admin, run.id, "start_step", { token, position: 1 });
  const output = '{"caption_a":"same","caption_b":"same"}';
  await f.advance(admin, run.id, "complete_step", { token, position: 1, output });
  const saved = f.state().runs[0];
  assert.equal(saved.status, "failed"); assert.equal(saved.error, "output_invalid"); assert.equal(saved.steps[0].output, output);
});

test("model: oversized output is a failed result with an explicitly truncated bounded diagnostic", async () => {
  const f = executionFixture([custom]); const { run, token } = await claimed(f);
  await f.advance(admin, run.id, "start_step", { token, position: 1 });
  await f.advance(admin, run.id, "complete_step", { token, position: 1, output: "x".repeat(32769) });
  const saved = f.state().runs[0];
  assert.equal(saved.status, "failed"); assert.equal(saved.steps[0].outputTruncated, true);
  assert.equal(saved.steps[0].output.length, 8192);
});

test("model: provider failure preserves earlier output and skips future steps; expiry never resumes work", async () => {
  const f = executionFixture([custom]); const { run, token } = await claimed(f);
  await f.advance(admin, run.id, "start_step", { token, position: 1 });
  await f.advance(admin, run.id, "complete_step", { token, position: 1, output: "Keep this result" });
  await f.advance(admin, run.id, "start_step", { token, position: 2 });
  await f.advance(admin, run.id, "fail", { token });
  const saved = f.state().runs[0];
  assert.deepEqual(saved.steps.map(step => step.status), ["succeeded", "failed", "skipped"]);
  assert.equal(saved.steps[0].output, "Keep this result");
  const next = await claimed(f, { ...input, key: "request-2" });
  f.tick(121);
  const expired = await f.advance(admin, next.run.id, "start_step", { token: next.token, position: 1 });
  assert.equal(expired.status, "interrupted"); assert.equal(expired.accepted, false);
});

test("model: injection rolls back preparation and complete-step writes; deletion does not remove history", async () => {
  const f = executionFixture([custom]);
  await assert.rejects(f.prepare(admin, input, true), /injected/); assert.equal(f.state().runs.length, 0);
  const { run, token } = await claimed(f);
  await f.advance(admin, run.id, "start_step", { token, position: 1 });
  const before = f.state();
  await assert.rejects(f.advance(admin, run.id, "complete_step", { token, position: 1, output: "Not committed" }, true), /injected/);
  assert.deepEqual(f.state(), before);
  f.deleteChain(custom.id);
  assert.equal(f.state().runs[0].currentChainId, null);
  assert.deepEqual(f.state().runs[0].snapshot, run.snapshot);
});

test("model: over-limit images and custom chains fail before creating records", async () => {
  const f = executionFixture([{ ...custom, steps: steps(6) }]);
  await assert.rejects(f.prepare(admin, { ...input, size: 5242881 }), /invalid_run_input/);
  await assert.rejects(f.prepare(admin, { ...input, mime: "image/svg+xml" }), /invalid_run_input/);
  await assert.rejects(f.prepare(admin, input), /chain_outside_execution_limits/);
  assert.equal(f.state().runs.length, 0);
});
