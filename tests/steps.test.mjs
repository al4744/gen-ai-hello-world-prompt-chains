import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { applyStepTransaction, failure } from "./helpers/step-transaction-model.mjs";

function load(path, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX }, fileName: path,
  });
  const testModule = { exports: {} };
  const execute = vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, { FormData });
  execute(name => { assert.ok(Object.hasOwn(imports, name), `Unmocked dependency: ${name}`); return imports[name]; }, testModule, testModule.exports);
  return testModule.exports;
}

const chainModel = load("lib/chains/model.ts");
const model = load("lib/steps/model.ts", { "@/lib/chains/model": chainModel });
const chainId = "11111111-1111-4111-8111-111111111111";
const defaultId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const ids = [1, 2, 3, 4, 5, 6, 7, 8].map(value => `aaaaaaaa-aaaa-4aaa-8aaa-${String(value).padStart(12, "0")}`);
const newId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const initial = { values: { name: "", prompt_template: "" }, errors: {} };
function redirect(destination) { const error = new Error("Redirect"); error.destination = destination; throw error; }
function notFound() { const error = new Error("Not found"); error.notFound = true; throw error; }

function fixture(options = {}) {
  const rows = {
    chains: [{ id: chainId, slug: "custom-chain", name: "Custom chain", description: "", created_at: "2026-11-05T12:00:00Z" }, { id: defaultId, slug: "caption-arena-default", name: "Default chain" }, { id: otherId, slug: "other-chain", name: "Other chain" }],
    steps: ids.map((id, index) => ({ id, chain_id: index < 3 ? chainId : index < 7 ? defaultId : otherId, step_order: index < 3 ? index + 1 : index < 7 ? index - 2 : 1, name: `Step ${index + 1}`, prompt_template: `  Prompt ${index + 1}\nKeep spacing.  ` })),
  };
  const calls = [], revalidations = [], queues = new Map();
  let arrivals = 0, releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });
  const client = {
    auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: "verified-admin", identities: [{ provider: "google" }] } }, error: null }) },
    from(table) {
      const filters = [], query = { table, operation: "read" }; let range;
      const builder = {
        select() { return builder; }, eq(key, value) { filters.push([key, value]); return builder; }, order() { return builder; },
        range(start, end) { range = [start, end]; return builder; },
        maybeSingle: async () => execute(true), then(resolve, reject) { return Promise.resolve(execute(false)).then(resolve, reject); },
      };
      function execute(single) {
        calls.push(query);
        if (table === "profiles") return { data: options.profileMissing ? null : { is_superadmin: !options.nonAdmin }, error: options.profileError ? failure("42501") : null };
        if (options.readError) return { data: null, error: failure("XX000") };
        let result = (table === "prompt_chains" ? rows.chains : rows.steps).filter(row => filters.every(([key, value]) => row[key] === value));
        if (table === "prompt_chain_steps") result = [...result].sort((a, b) => a.step_order - b.step_order);
        if (range) result = result.slice(range[0], range[1] + 1);
        return { data: structuredClone(single ? result[0] ?? null : result), error: null };
      }
      return builder;
    },
    async rpc(name, input) {
      calls.push({ operation: "rpc", name, input: structuredClone(input) });
      if (options.barrier) { arrivals++; if (arrivals === 2) releaseBarrier(); await barrier; }
      const previous = queues.get(input.p_chain_id) ?? Promise.resolve();
      let release;
      const done = new Promise(resolve => { release = resolve; });
      queues.set(input.p_chain_id, previous.then(() => done));
      await previous;
      try {
        options.beforeRPC?.(rows, input);
        if (options.rpcThrows) throw new Error("SECRET: network failure");
        if (options.rpcError) return { data: null, error: options.rpcError };
        const transaction = name === "reorder_prompt_chain_step_v2" ? { ...input, p_operation: "move_to" } : input;
        return { data: applyStepTransaction(rows, transaction, { ...options, newId }), error: null };
      } catch (error) {
        if (options.rpcThrows) throw error;
        return { data: null, error };
      } finally { release(); }
    },
  };
  const guard = load("lib/auth/require-superadmin.ts", { "server-only": {}, "next/navigation": { redirect }, "@/lib/supabase/server": { createClient: async () => client } });
  const data = load("lib/chains/data.ts", { "server-only": {}, "./model": chainModel });
  const rpc = load("lib/steps/rpc.ts", { "server-only": {}, "@/lib/chains/model": chainModel });
  const reorderRPC = load("lib/steps/reorder-rpc.ts", { "server-only": {}, "./rpc": rpc });
  const actions = load("app/(protected)/chains/[id]/steps/actions.ts", {
    "next/navigation": { redirect }, "next/cache": { revalidatePath: (...args) => revalidations.push(args) },
    "@/lib/auth/require-superadmin": guard, "@/lib/chains/data": data, "@/lib/chains/model": chainModel,
    "@/lib/steps/model": model, "@/lib/steps/rpc": rpc,
    "@/lib/steps/reorder-rpc": reorderRPC,
  });
  const steps = () => rows.steps.filter(step => step.chain_id === chainId).sort((a, b) => a.step_order - b.step_order);
  function form(values = { name: "New step", prompt_template: "  Literal template\n  {{untouched}}  " }, step = steps()[1]) {
    const result = new FormData(); Object.entries(values).forEach(([key, value]) => result.set(key, value));
    result.set("expected_order", model.orderSnapshot(steps()));
    if (step) result.set("original", model.originalStep(step));
    return result;
  }
  function page(path) {
    return load(`app/(protected)/chains/[id]/steps/${path}`, {
      "react/jsx-runtime": jsx, "next/link": { default: "a" }, "next/server": { connection: async () => {} }, "next/navigation": { notFound },
      "@/lib/auth/require-superadmin": guard, "@/lib/chains/data": data, "@/lib/chains/model": chainModel, "@/lib/steps/model": model,
      "@/components/chains/chain-ui": { ChainPage: "chain-page", ChainReadError: "read-error", SystemChainNotice: "system-notice" },
      "@/components/steps/step-form": { default: "step-form" }, "@/components/steps/delete-step-form": { default: "delete-step-form" },
      "../actions": actions, "../../actions": actions,
    }).default;
  }
  return { rows, calls, revalidations, client, actions, steps, form, page };
}
const rpcCalls = f => f.calls.filter(call => call.operation === "rpc");
function elements(node) { return !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(elements)]; }

for (const options of [{ signedOut: true }, { nonAdmin: true }, { profileMissing: true }, { profileError: true }]) {
  test(`all step actions reject unauthorized direct invocation: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    for (const call of [
      () => f.actions.createStep(chainId, initial, f.form()),
      () => f.actions.updateStep(chainId, ids[1], initial, f.form()),
      () => f.actions.deleteStep(chainId, ids[1], { error: null }, f.form()),
      () => f.actions.moveStep(chainId, ids[1], { error: null }, f.form()),
      () => f.actions.reorderStep(chainId, ids[1], { error: null }, f.form()),
    ]) await assert.rejects(call(), error => Boolean(error.destination));
    assert.equal(f.calls.filter(call => call.table !== "profiles").length, 0);
  });
}

test("create appends through one RPC, preserves literal template, and invalidates the chain", async () => {
  const f = fixture(); const template = "  Literal template\n  {{untouched}}  ";
  await assert.rejects(f.actions.createStep(chainId, initial, f.form()), { destination: `/chains/${chainId}?step_created=1#step-${newId}` });
  assert.deepEqual(f.steps().map(step => step.step_order), [1, 2, 3, 4]);
  assert.equal(f.steps()[3].prompt_template, template);
  assert.equal(rpcCalls(f).length, 1); assert.equal(rpcCalls(f)[0].name, "manage_prompt_chain_steps_v1");
  assert.ok(f.revalidations.some(([path]) => path === `/chains/${chainId}`));
});

test("empty-chain create starts at position one", async () => {
  const f = fixture(); f.rows.steps = f.rows.steps.filter(step => step.chain_id !== chainId);
  await assert.rejects(f.actions.createStep(chainId, initial, f.form()), error => Boolean(error.destination));
  assert.equal(f.steps()[0].step_order, 1);
});

for (const values of [{ name: " ", prompt_template: "Content" }, { name: "Name", prompt_template: "\t\n  " }, { name: "x".repeat(121), prompt_template: "Text" }, { name: "Name", prompt_template: "bad\0text" }]) {
  test(`validation preserves entries without issuing RPC: ${values.name.length > 120 ? "long name" : JSON.stringify(values)}`, async () => {
    const f = fixture(); const state = await f.actions.createStep(chainId, initial, f.form(values));
    assert.ok(Object.keys(state.errors).length); assert.equal(state.values.name, values.name); assert.equal(state.values.prompt_template, values.prompt_template);
    assert.equal(rpcCalls(f).length, 0);
  });
}

test("edit changes one step's content and preserves all IDs/positions and other steps", async () => {
  const f = fixture(); const before = structuredClone(f.rows.steps);
  await assert.rejects(f.actions.updateStep(chainId, ids[1], initial, f.form()), { destination: `/chains/${chainId}?step_updated=1#step-${ids[1]}` });
  assert.deepEqual(f.rows.steps.filter(step => step.id !== ids[1]).sort((a, b) => a.id.localeCompare(b.id)), before.filter(step => step.id !== ids[1]).sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(f.steps()[1].step_order, 2); assert.equal(f.steps()[1].id, ids[1]);
});

test("cross-chain, missing, and invalid identifiers fail before RPC", async () => {
  const f = fixture();
  for (const id of [ids[7], newId, "invalid", null]) {
    assert.ok((await f.actions.updateStep(chainId, id, initial, f.form())).message);
    assert.ok((await f.actions.deleteStep(chainId, id, { error: null }, f.form())).error);
  }
  assert.ok((await f.actions.createStep("invalid", initial, f.form())).message);
  assert.ok((await f.actions.createStep(newId, initial, f.form())).message);
  assert.equal(rpcCalls(f).length, 0);
});

test("default chain rejects create, edit, delete and reorder, including RPC-side protection", async () => {
  const f = fixture(); const before = structuredClone(f.rows.steps);
  assert.match((await f.actions.createStep(defaultId, initial, f.form())).message, /read-only/);
  assert.match((await f.actions.updateStep(defaultId, ids[3], initial, f.form())).message, /read-only/);
  assert.match((await f.actions.deleteStep(defaultId, ids[3], { error: null }, f.form())).error, /read-only/);
  assert.match((await f.actions.moveStep(defaultId, ids[3], { error: null }, f.form())).error, /read-only/);
  assert.equal(rpcCalls(f).length, 0);
  assert.equal((await f.client.rpc("manage_prompt_chain_steps_v1", { p_chain_id: defaultId })).error.code, "42501");
  assert.deepEqual(f.rows.steps, before);
});

test("RPC rechecks a parent changed to the protected slug after the action's read", async () => {
  const f = fixture({ beforeRPC(rows) { rows.chains.find(chain => chain.id === chainId).slug = "caption-arena-default"; } });
  const state = await f.actions.createStep(chainId, initial, f.form());
  assert.match(state.message, /read-only/); assert.equal(f.steps().length, 3);
});

test("confirmed middle deletion targets the selected step and compacts the remaining order", async () => {
  const f = fixture(); const unrelated = structuredClone(f.rows.steps.filter(step => step.chain_id !== chainId));
  await assert.rejects(f.actions.deleteStep(chainId, ids[1], { error: null }, f.form()), { destination: `/chains/${chainId}?step_deleted=1` });
  assert.deepEqual(f.steps().map(step => [step.id, step.step_order]), [[ids[0], 1], [ids[2], 2]]);
  assert.deepEqual(f.rows.steps.filter(step => step.chain_id !== chainId), unrelated);
  assert.equal(f.rows.chains.length, 3);
});

for (const direction of ["up", "down"]) {
  test(`move step 2 ${direction} changes only order and preserves IDs/content`, async () => {
    const content = step => ({ id: step.id, chain_id: step.chain_id, name: step.name, prompt_template: step.prompt_template });
    const f = fixture(); const before = f.steps().map(content).sort((a, b) => a.id.localeCompare(b.id));
    const form = f.form(); form.set("direction", direction);
    const state = await f.actions.moveStep(chainId, ids[1], { error: null }, form);
    assert.equal(state.error, null); assert.match(state.success, /moved/);
    assert.deepEqual(f.steps().map(step => step.id), direction === "up" ? [ids[1], ids[0], ids[2]] : [ids[0], ids[2], ids[1]]);
    assert.deepEqual(f.steps().map(content).sort((a, b) => a.id.localeCompare(b.id)), before);
    assert.equal(rpcCalls(f).length, 1);
  });
}

test("first/last boundaries and invalid directions reject without RPC", async () => {
  const f = fixture();
  for (const [id, direction] of [[ids[0], "up"], [ids[2], "down"], [ids[1], "arbitrary"]]) {
    const form = f.form(); form.set("direction", direction);
    assert.ok((await f.actions.moveStep(chainId, id, { error: null }, form)).error);
  }
  assert.equal(rpcCalls(f).length, 0);
});

test("gapped positions including INT_MAX normalize without temporary collisions", async () => {
  const f = fixture(); f.steps().forEach((step, i) => { step.step_order = [4, 8, 2147483647][i]; });
  const form = f.form(); form.set("direction", "up");
  assert.equal((await f.actions.moveStep(chainId, ids[1], { error: null }, form)).error, null);
  assert.deepEqual(f.steps().map(step => step.step_order), [1, 2, 3]);
});

test("malformed, duplicate, missing, or stale ordering snapshots are rejected", async () => {
  for (const raw of [null, "broken", JSON.stringify([{ id: ids[0], step_order: 1 }, { id: ids[0], step_order: 2 }]), JSON.stringify([{ id: ids[0], step_order: 0 }]), JSON.stringify([{ id: "invalid", step_order: 1 }]), "[]"]) {
    const f = fixture(); const form = f.form();
    if (raw === null) form.delete("expected_order"); else form.set("expected_order", raw);
    assert.ok((await f.actions.createStep(chainId, initial, form)).message);
    assert.equal(rpcCalls(f).length, 0);
  }
});

test("stale step content rejects edits/deletion and preserves drafts", async () => {
  const f = fixture(); const form = f.form(); f.steps()[1].prompt_template = "Changed elsewhere";
  const edit = await f.actions.updateStep(chainId, ids[1], initial, form);
  assert.match(edit.message, /changed/); assert.equal(edit.values.name, "New step");
  assert.match((await f.actions.deleteStep(chainId, ids[1], { error: null }, form)).error, /changed/);
  assert.equal(rpcCalls(f).length, 0);
});

for (const failAt of ["after-delete", "temporary:2", "final:2"]) {
  test(`transaction MODEL rolls back deletion and order on partial failure: ${failAt}`, async () => {
    const f = fixture({ failAt }); const before = structuredClone(f.rows.steps);
    const state = await f.actions.deleteStep(chainId, ids[1], { error: null }, f.form());
    assert.ok(state.error); assert.doesNotMatch(state.error, /SECRET/); assert.deepEqual(f.rows.steps, before);
  });
}

test("transaction MODEL rolls back an inserted step when normalization fails", async () => {
  const f = fixture({ failAt: "final:2" }); const before = structuredClone(f.rows.steps);
  assert.ok((await f.actions.createStep(chainId, initial, f.form())).message);
  assert.deepEqual(f.rows.steps, before);
});

test("serialized concurrent creates accept one snapshot and reject the other", async () => {
  const f = fixture({ barrier: true });
  const results = await Promise.allSettled([f.actions.createStep(chainId, initial, f.form()), f.actions.createStep(chainId, initial, f.form())]);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.destination).length, 1);
  assert.match(results.find(result => result.status === "fulfilled").value.message, /changed/);
  assert.equal(f.steps().length, 4);
});

test("transaction MODEL rolls back reordering when the final phase fails", async () => {
  const f = fixture({ failAt: "final:2" }); const before = structuredClone(f.rows.steps);
  const form = f.form(); form.set("direction", "up");
  assert.ok((await f.actions.moveStep(chainId, ids[1], { error: null }, form)).error);
  assert.deepEqual(f.rows.steps, before);
});

test("concurrent reorder and deletion serialize and reject the stale operation", async () => {
  const f = fixture({ barrier: true }); const move = f.form(); move.set("direction", "up");
  const results = await Promise.allSettled([
    f.actions.moveStep(chainId, ids[1], { error: null }, move),
    f.actions.deleteStep(chainId, ids[1], { error: null }, f.form()),
  ]);
  const successes = results.filter(result => result.status === "rejected" ? Boolean(result.reason.destination) : result.value.error === null);
  assert.equal(successes.length, 1);
  assert.equal(results.filter(result => result.status === "fulfilled" && /changed/.test(result.value.error ?? "")).length, 1);
  assert.deepEqual(f.steps().map(step => step.step_order), f.steps().map((_, index) => index + 1));
});

test("stale/duplicate RPC identifiers are rejected by the transaction MODEL too", async () => {
  const f = fixture();
  const expected = [{ id: ids[0], step_order: 1 }, { id: ids[0], step_order: 2 }];
  const result = await f.client.rpc("manage_prompt_chain_steps_v1", { p_chain_id: chainId, p_operation: "move_up", p_step_id: ids[1], p_expected_order: expected });
  assert.equal(result.error.code, "22023");
  assert.deepEqual(f.steps().map(step => step.step_order), [1, 2, 3]);
});

test("step Cancel is navigation-only; forms preserve drafts and suppress repeated/pending submissions", () => {
  const values = { name: " Draft ", prompt_template: "\n  Preserve this text  " };
  for (const pending of [false, true]) {
    let calls = 0;
    const react = { useId: () => "fixture", useActionState: () => [{ values, errors: { name: "Inline error" }, error: null }, () => calls++, pending], useRef: () => ({ current: false }), useEffect() {} };
    const imports = { "react/jsx-runtime": jsx, "next/link": { default: "a" }, react, "@/lib/steps/model": model };
    for (const path of ["step-form.tsx", "delete-step-form.tsx"]) {
      const component = load(`components/steps/${path}`, imports).default;
      const tree = elements(component({ action() {}, values, expectedOrder: "[]", original: "{}", chainHref: `/chains/${chainId}`, mode: "edit", name: "Step name" }));
      const cancel = tree.find(node => node.type === "a");
      assert.equal(cancel.props.href, `/chains/${chainId}`);
      cancel.props.onClick?.({ preventDefault() {} }); assert.equal(calls, 0);
      let prevented = 0;
      tree[0].props.onSubmit({ preventDefault() { prevented++; } }); tree[0].props.onSubmit({ preventDefault() { prevented++; } });
      assert.equal(prevented, pending ? 2 : 1);
      assert.equal(tree.find(node => node.type === "button" && node.props.type === "submit").props.disabled, pending);
      if (path === "step-form.tsx") {
        assert.equal(tree.find(node => node.type === "textarea").props.defaultValue, values.prompt_template);
        assert.equal(tree.find(node => node.props?.name === "name").props.defaultValue, values.name);
      }
    }
  }
});

for (const options of [{ rpcError: failure("PGRST202") }, { rpcError: failure("40001") }, { rpcError: failure("23514") }, { rpcError: failure("55P03") }, { rpcThrows: true }]) {
  test(`RPC errors are safe feedback without direct-write fallback: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options); const before = structuredClone(f.rows.steps);
    const result = await f.actions.createStep(chainId, initial, f.form());
    assert.ok(result.message); assert.doesNotMatch(result.message, /SECRET|PGRST202|23514/);
    if (options.rpcError?.code === "PGRST202") assert.match(result.message, /database update/);
    assert.deepEqual(f.rows.steps, before); assert.equal(rpcCalls(f).length, 1);
  });
}

const pagePaths = ["new/page.tsx", "[stepId]/edit/page.tsx", "[stepId]/delete/page.tsx"];
test("new step pages authorize independently and reject cross-chain step routes", async () => {
  for (const options of [{ signedOut: true }, { nonAdmin: true }]) {
    const f = fixture(options);
    for (const path of pagePaths) await assert.rejects(f.page(path)({ params: Promise.resolve({ id: chainId, stepId: ids[1] }) }), error => Boolean(error.destination));
    assert.equal(f.calls.filter(call => call.table !== "profiles").length, 0);
  }
  const f = fixture();
  await assert.rejects(f.page("[stepId]/edit/page.tsx")({ params: Promise.resolve({ id: chainId, stepId: ids[7] }) }), error => error.notFound);
});

test("confirmation GET identifies name, number and parent, and never invokes RPC", async () => {
  const f = fixture(); const tree = await f.page("[stepId]/delete/page.tsx")({ params: Promise.resolve({ id: chainId, stepId: ids[1] }) });
  const text = JSON.stringify(tree); assert.match(text, /Are you sure/); assert.match(text, /Step 2/); assert.match(text, /Custom chain/);
  const control = elements(tree).find(node => node.type === "delete-step-form");
  assert.equal(control.props.chainHref, `/chains/${chainId}`); assert.equal(rpcCalls(f).length, 0);
});

test("all default-chain step pages remain read-only", async () => {
  const f = fixture();
  for (const path of pagePaths) {
    const text = JSON.stringify(await f.page(path)({ params: Promise.resolve({ id: defaultId, stepId: ids[3] }) }));
    assert.match(text, /system-notice/); assert.doesNotMatch(text, /"type":"(?:step-form|delete-step-form)"/);
  }
});

test("move controls expose keyboard buttons and disable first/last boundaries", () => {
  for (const [first, last] of [[true, false], [false, true], [true, true]]) {
    const component = load("components/steps/step-move-controls.tsx", {
      "react/jsx-runtime": jsx, "@/app/(protected)/chains/[id]/steps/actions": { moveStep() {} },
      react: { useActionState: () => [{ error: null }, () => {}, false], useRef: () => ({ current: false }), useEffect() {} },
    }).default;
    const nodes = elements(component({ name: "Joke step", first, last, handleRef() {}, onMove() {}, instructionsId: "instructions" }));
    const buttons = nodes.filter(node => node.type === "button" && node.props.name === "direction");
    assert.deepEqual(buttons.map(node => node.props.disabled), [first, last]);
    assert.equal(buttons[0].props["aria-label"], "Move Joke step up");
    assert.equal(buttons[1].props.name, "direction");
  }
});

for (const [source, destination, expected] of [[2, 1, [2, 0, 1]], [0, 3, [1, 2, 0]], [1, 3, [0, 2, 1]]]) {
  test(`arbitrary reorder uses one v2 RPC: ${source + 1} to ${destination}`, async () => {
    const f = fixture(); const before = f.steps().map(step => ({ id: step.id, name: step.name, prompt_template: step.prompt_template }));
    const form = f.form(); form.set("destination", String(destination));
    assert.equal((await f.actions.reorderStep(chainId, ids[source], { error: null }, form)).error, null);
    assert.deepEqual(f.steps().map(step => step.id), expected.map(index => ids[index]));
    assert.equal(rpcCalls(f).length, 1); assert.equal(rpcCalls(f)[0].name, "reorder_prompt_chain_step_v2");
    assert.deepEqual(f.steps().map(step => ({ id: step.id, name: step.name, prompt_template: step.prompt_template })).sort((a,b)=>a.id.localeCompare(b.id)), before.sort((a,b)=>a.id.localeCompare(b.id)));
  });
}

test("same-position drops are no-ops and invalid destinations reject before RPC", async () => {
  const f = fixture(); const form = f.form(); form.set("destination", "2");
  assert.match((await f.actions.reorderStep(chainId, ids[1], { error: null }, form)).success, /unchanged/);
  for (const value of ["0", "4", "-1", "2.5", "NaN", "https://attacker.invalid"]) {
    form.set("destination", value); assert.ok((await f.actions.reorderStep(chainId, ids[1], { error: null }, form)).error);
  }
  assert.equal(rpcCalls(f).length, 0);
});

test("arbitrary reorders reject default, cross-chain, duplicate and stale snapshots", async () => {
  const f = fixture(); const form = f.form(); form.set("destination", "1");
  assert.match((await f.actions.reorderStep(defaultId, ids[3], { error: null }, form)).error, /read-only/);
  assert.ok((await f.actions.reorderStep(chainId, ids[7], { error: null }, form)).error);
  form.set("expected_order", JSON.stringify([{id:ids[0],step_order:1},{id:ids[0],step_order:2}]));
  assert.ok((await f.actions.reorderStep(chainId, ids[1], { error: null }, form)).error);
  form.set("expected_order", "[]");
  assert.match((await f.actions.reorderStep(chainId, ids[1], { error: null }, form)).error, /changed/);
  assert.equal(rpcCalls(f).length, 0);
});

test("missing v2 reports an inline error and leaves the v1 arrow path usable", async () => {
  const options = { rpcError: failure("PGRST202") };
  const f = fixture(options); const form = f.form(); form.set("destination", "1");
  const result = await f.actions.reorderStep(chainId, ids[2], { error: null }, form);
  assert.match(result.error, /Use the arrows/); assert.equal(rpcCalls(f).length, 1);
  assert.equal(rpcCalls(f)[0].name, "reorder_prompt_chain_step_v2");
  delete options.rpcError; const arrow = f.form(); arrow.set("direction", "up");
  assert.equal((await f.actions.moveStep(chainId, ids[1], { error: null }, arrow)).error, null);
  assert.equal(rpcCalls(f)[1].name, "manage_prompt_chain_steps_v1");
});

test("v2 transaction MODEL rolls back a partially failed arbitrary move", async () => {
  const f = fixture({failAt:"final:2"}); const before = structuredClone(f.rows.steps);
  const form = f.form(); form.set("destination", "1");
  assert.ok((await f.actions.reorderStep(chainId, ids[2], {error:null}, form)).error);
  assert.deepEqual(f.rows.steps, before);
});

test("v1 and v2 MODEL calls share a chain lock and reject the stale operation", async () => {
  const f = fixture({barrier:true}); const drop = f.form(); drop.set("destination", "1"); const arrow = f.form(); arrow.set("direction", "up");
  const results = await Promise.all([f.actions.reorderStep(chainId, ids[2], {error:null}, drop), f.actions.moveStep(chainId, ids[1], {error:null}, arrow)]);
  assert.equal(results.filter(result=>result.error===null).length,1);
  assert.match(results.find(result=>result.error).error,/changed/);
  assert.deepEqual(f.steps().map(step=>step.step_order),[1,2,3]);
});
