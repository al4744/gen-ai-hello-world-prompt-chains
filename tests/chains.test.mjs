import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

// Execute the real modules at isolated framework/SDK boundaries. No environment
// files, network calls, or production records are used by these tests.
function load(path, imports = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX }, fileName: path,
  });
  const testModule = { exports: {} };
  const execute = vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, { FormData, URL, Intl });
  execute(name => {
    assert.ok(Object.hasOwn(imports, name), `Unmocked dependency: ${name}`);
    return imports[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}

const model = load("lib/chains/model.ts");
const stepModel = load("lib/steps/model.ts", { "@/lib/chains/model": model });
const validation = load("lib/chains/validation.ts", { "./model": model });
const systemId = "11111111-1111-4111-8111-111111111111";
const customId = "22222222-2222-4222-8222-222222222222";
const createdId = "33333333-3333-4333-8333-333333333333";
const timestamp = "2026-11-05T12:00:00.000Z";
const system = { id: systemId, name: "Caption Arena default", slug: "caption-arena-default", description: "Original Week 7 chain", created_at: timestamp };
const custom = { id: customId, name: "Custom chain", slug: "custom-chain", description: "Custom description", created_at: timestamp };
const initial = { values: { name: "", slug: "", description: "" }, errors: {} };

function redirect(destination) { const error = new Error("Redirect"); error.destination = destination; throw error; }
function notFound() { const error = new Error("Not found"); error.notFound = true; throw error; }

function fixture(options = {}) {
  const rows = { prompt_chains: structuredClone([system, custom]), prompt_chain_steps: [
    { id: "s2", chain_id: customId, name: "Second", step_order: 2, prompt_template: "Second prompt" },
    { id: "s1", chain_id: customId, name: "First", step_order: 1, prompt_template: "First prompt" },
  ] };
  const calls = [], revalidations = [];
  const client = {
    auth: { async getUser() { return { data: { user: options.signedOut ? null : { id: "verified-admin", identities: [{ provider: "google" }] } }, error: null }; } },
    from(table) {
      const query = { table, operation: "read", filters: [], orders: [], fields: "", range: null };
      const builder = {
        select(fields) { query.fields = fields; return builder; },
        insert(values) { query.operation = "insert"; query.values = values; return builder; },
        update(values) { query.operation = "update"; query.values = values; return builder; },
        delete() { query.operation = "delete"; return builder; },
        eq(key, value) { query.filters.push([key, value, true]); return builder; },
        neq(key, value) { query.filters.push([key, value, false]); return builder; },
        order(key, order = {}) { query.orders.push([key, order.ascending !== false]); return builder; },
        range(start, end) { query.range = [start, end]; return builder; },
        maybeSingle() { return execute(true); }, single() { return execute(true); },
        then(resolve, reject) { return execute(false).then(resolve, reject); },
      };
      async function execute(single) {
        calls.push(structuredClone(query));
        if (table === "profiles") return { data: options.profileMissing ? null : { is_superadmin: !options.nonAdmin }, error: options.profileError ? { message: "SECRET: profile database detail" } : null };
        if (query.operation === "read" && (options.readError || (options.stepsError && table === "prompt_chain_steps") || (options.countError && query.fields.includes("prompt_chain_steps(count)")))) return { data: null, error: { message: "SECRET: database internals" } };
        if (query.operation !== "read") {
          if (options.writeThrows) throw new Error("SECRET: backend outage");
          if (options.writeError) return { data: null, error: options.writeError };
          options.beforeWrite?.(rows, query);
        }
        const matches = row => query.filters.every(([key, value, equal]) => equal ? row[key] === value : row[key] !== value);
        let selected = rows[table].filter(matches);
        if (query.operation === "insert") {
          if (rows.prompt_chains.some(row => row.slug === query.values.slug)) return { data: null, error: { code: "23505", message: "SECRET: unique constraint" } };
          const inserted = { ...query.values, id: createdId, created_at: timestamp };
          rows[table].push(inserted); selected = [inserted];
        } else if (query.operation === "update") {
          if (rows.prompt_chains.some(row => row.id !== customId && row.slug === query.values.slug)) return { data: null, error: { code: "23505", message: "SECRET: unique constraint" } };
          selected.forEach(row => Object.assign(row, query.values));
        } else if (query.operation === "delete") rows[table] = rows[table].filter(row => !matches(row));
        for (const [key, ascending] of [...query.orders].reverse()) selected.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (ascending ? 1 : -1));
        const count = selected.length;
        if (query.range) selected = selected.slice(query.range[0], query.range[1] + 1);
        const output = selected.map(row => query.fields.includes("prompt_chain_steps(count)") ? {
          ...row, prompt_chain_steps: [{ count: rows.prompt_chain_steps.filter(step => step.chain_id === row.id).length }],
        } : { ...row });
        return { data: single ? output[0] ?? null : output, error: null, count };
      }
      return builder;
    },
  };
  const guard = load("lib/auth/require-superadmin.ts", {
    "server-only": {}, "next/navigation": { redirect }, "@/lib/supabase/server": { createClient: async () => client },
  });
  const data = load("lib/chains/data.ts", { "server-only": {}, "./model": model });
  const actions = load("app/(protected)/chains/actions.ts", {
    "next/cache": { revalidatePath: path => revalidations.push(path) }, "next/navigation": { redirect },
    "@/lib/auth/require-superadmin": guard, "@/lib/chains/data": data,
    "@/lib/chains/model": model, "@/lib/chains/validation": validation,
  });
  function page(path) {
    return load(`app/(protected)/chains/${path}`, {
      "react/jsx-runtime": jsx, "next/server": { connection: async () => {} }, "next/navigation": { notFound }, "next/link": { default: "a" },
      "@/lib/auth/require-superadmin": guard, "@/lib/chains/data": data, "@/lib/chains/model": model, "@/lib/chains/validation": validation,
      "@/components/chains/chain-ui": { ChainPage: "chain-page", ChainReadError: "read-error", SystemBadge: "system-badge", SystemChainNotice: "system-notice", BackToChains: "back-link" },
      "@/components/chains/chain-form": { default: "chain-form" }, "@/components/chains/delete-chain-form": { default: "delete-form" },
      "@/lib/steps/model": stepModel, "@/components/steps/step-move-controls": { default: "step-move-controls" },
      "@/components/steps/step-reorder-list": { default: "step-reorder-list" },
      "@/components/chains/chain-success-notice": { default: "chain-success-notice" },
      "../actions": actions, "../../actions": actions,
    }).default;
  }
  return { rows, calls, revalidations, client, actions, data, page };
}

function form(values = { name: "New chain", slug: "new-chain", description: "New description" }, original = custom) {
  const data = new FormData();
  Object.entries(values).forEach(([key, value]) => data.set(key, value));
  data.set("original", model.metadataSnapshot(original));
  return data;
}
const writes = calls => calls.filter(call => call.operation !== "read");
function elements(node) { return !node || typeof node !== "object" ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(elements)]; }

for (const [name, options, destination] of [
  ["signed out", { signedOut: true }, "/"], ["ordinary account", { nonAdmin: true }, "/?auth_error=access_denied"],
  ["missing profile", { profileMissing: true }, "/?auth_error=access_denied"], ["profile error", { profileError: true }, "/?auth_error=access_denied"],
]) {
  test(`all mutations deny ${name}, including direct action invocation`, async () => {
    const f = fixture(options);
    await assert.rejects(f.actions.createChain(initial, form()), { destination });
    await assert.rejects(f.actions.updateChain(customId, initial, form()), { destination });
    await assert.rejects(f.actions.deleteChain(customId, { error: null }, form()), { destination });
    assert.equal(f.calls.filter(call => call.table !== "profiles").length, 0);
  });
}

test("create writes only metadata, uses database-generated ID, invalidates, and redirects", async () => {
  const f = fixture();
  await assert.rejects(f.actions.createChain(initial, form({ name: " New chain ", slug: " new-chain ", description: " Description " })), { destination: `/chains/${createdId}?created=1` });
  assert.deepEqual(writes(f.calls).map(call => [call.table, call.operation, call.values]), [["prompt_chains", "insert", { name: "New chain", slug: "new-chain", description: "Description" }]]);
  assert.ok(f.revalidations.includes("/chains"));
  assert.ok(f.revalidations.includes(`/chains/${createdId}`));
  assert.deepEqual(f.rows.prompt_chains.find(row => row.id === systemId), system);
});

for (const slug of ["Uppercase", "-leading", "trailing-", "double--hyphen", "with space", "underscore_slug", "caption-arena-default"]) {
  test(`invalid or reserved slug is rejected inline: ${slug}`, async () => {
    const f = fixture();
    const state = await f.actions.createChain(initial, form({ name: "A name", slug, description: "Keep my text" }));
    assert.ok(state.errors.slug);
    assert.equal(state.values.slug, slug);
    assert.equal(state.values.description, "Keep my text");
    assert.equal(writes(f.calls).length, 0);
  });
}

test("required fields and application length limits validate before insert", async () => {
  const f = fixture();
  const empty = await f.actions.createChain(initial, form({ name: "  ", slug: "", description: "" }));
  assert.ok(empty.errors.name); assert.ok(empty.errors.slug);
  const long = await f.actions.createChain(initial, form({ name: "x".repeat(121), slug: "x".repeat(81), description: "x".repeat(4001) }));
  for (const field of ["name", "slug", "description"]) assert.ok(long.errors[field]);
  assert.equal(writes(f.calls).length, 0);
});

test("empty description is supported; files, null characters, and forged form types fail safely", async () => {
  const f = fixture();
  const valid = validation.validateChainForm(form({ name: "Name", slug: "name", description: "" }));
  assert.equal(Object.keys(valid.errors).length, 0);
  const invalid = form(); invalid.set("name", new Blob(["file"]), "file.txt"); invalid.set("description", "bad\0text");
  const state = await f.actions.createChain(initial, invalid);
  assert.ok(state.errors.name); assert.ok(state.errors.description);
  assert.ok((await f.actions.createChain(initial, {})).message);
  assert.equal(writes(f.calls).length, 0);
});

test("duplicate create/replayed submission returns an inline slug error without extra records", async () => {
  const f = fixture();
  await assert.rejects(f.actions.createChain(initial, form()), { destination: `/chains/${createdId}?created=1` });
  const state = await f.actions.createChain(initial, form());
  assert.match(state.errors.slug, /already in use/);
  assert.equal(f.rows.prompt_chains.filter(row => row.slug === "new-chain").length, 1);
  assert.doesNotMatch(JSON.stringify(state), /SECRET|23505/);
});

test("edit uses UUID and atomic original-metadata filters, preserving all steps", async () => {
  const f = fixture(); const steps = structuredClone(f.rows.prompt_chain_steps);
  await assert.rejects(f.actions.updateChain(customId, initial, form()), { destination: `/chains/${customId}?updated=1` });
  const mutation = writes(f.calls)[0];
  assert.equal(mutation.operation, "update");
  assert.ok(mutation.filters.some(([key, value, equal]) => key === "id" && value === customId && equal));
  assert.ok(mutation.filters.some(([key, value, equal]) => key === "slug" && value === model.SYSTEM_CHAIN_SLUG && !equal));
  for (const key of ["name", "slug", "description"]) assert.ok(mutation.filters.some(([field, value, equal]) => field === key && value === custom[key] && equal));
  assert.deepEqual(f.rows.prompt_chain_steps, steps);
  assert.deepEqual(f.rows.prompt_chains.find(row => row.id === systemId), system);
  assert.equal(writes(f.calls).length, 1);
});

test("duplicate edit produces inline feedback and preserves submitted values", async () => {
  const f = fixture(); f.rows.prompt_chains.push({ ...custom, id: createdId, slug: "taken" });
  const state = await f.actions.updateChain(customId, initial, form({ name: "My draft", slug: "taken", description: "Preserve this" }));
  assert.match(state.errors.slug, /already in use/);
  assert.equal(state.values.name, "My draft"); assert.equal(state.values.description, "Preserve this");
});

test("default chain rejects edit and delete even with a forged original snapshot", async () => {
  const f = fixture(); const before = structuredClone(f.rows);
  const updated = await f.actions.updateChain(systemId, initial, form(undefined, system));
  const deleted = await f.actions.deleteChain(systemId, { error: null }, form(undefined, system));
  assert.match(updated.message, /read-only/); assert.match(deleted.error, /protected/);
  assert.equal(writes(f.calls).length, 0); assert.deepEqual(f.rows, before);
});

test("stale or missing snapshots cannot edit or delete", async () => {
  for (const original of [null, "broken json", JSON.stringify({ ...custom, name: "Old name" })]) {
    const f = fixture(); const submission = form();
    if (original === null) submission.delete("original"); else submission.set("original", original);
    assert.match((await f.actions.updateChain(customId, initial, submission)).message, /changed/);
    assert.match((await f.actions.deleteChain(customId, { error: null }, submission)).error, /changed/);
    assert.equal(writes(f.calls).length, 0);
  }
});

for (const operation of ["update", "delete"]) {
  test(`concurrent ${operation} is detected by the mutation's metadata filters`, async () => {
    const f = fixture({ beforeWrite(rows) { rows.prompt_chains.find(row => row.id === customId).name = "Changed concurrently"; } });
    const state = operation === "update" ? await f.actions.updateChain(customId, initial, form()) : await f.actions.deleteChain(customId, { error: null }, form());
    assert.match(state.message ?? state.error, /changed/);
    assert.equal(f.rows.prompt_chains.find(row => row.id === customId).name, "Changed concurrently");
    assert.equal(f.rows.prompt_chains.length, 2);
  });
  test(`${operation} cannot cross a race into the protected default slug`, async () => {
    const f = fixture({ beforeWrite(rows) { rows.prompt_chains.find(row => row.id === customId).slug = model.SYSTEM_CHAIN_SLUG; } });
    const state = operation === "update" ? await f.actions.updateChain(customId, initial, form()) : await f.actions.deleteChain(customId, { error: null }, form());
    assert.ok(state.message ?? state.error);
    assert.equal(f.rows.prompt_chains.find(row => row.id === customId).name, custom.name);
    assert.equal(f.rows.prompt_chains.length, 2);
  });
}

test("confirmed delete targets only the selected parent and redirects to the fixed directory", async () => {
  const f = fixture();
  const submission = form(); submission.set("next", "https://attacker.invalid");
  await assert.rejects(f.actions.deleteChain(customId, { error: null }, submission), { destination: "/chains?deleted=1" });
  assert.equal(f.rows.prompt_chains.some(row => row.id === customId), false);
  assert.deepEqual(f.rows.prompt_chains, [system]);
  assert.deepEqual(writes(f.calls).map(call => [call.table, call.operation]), [["prompt_chains", "delete"]]);
});

test("missing records and invalid UUIDs do not cause mutations", async () => {
  const f = fixture(); f.rows.prompt_chains = [structuredClone(system)];
  assert.match((await f.actions.updateChain(customId, initial, form())).message, /no longer exists/);
  await assert.rejects(f.actions.deleteChain(customId, { error: null }, form()), { destination: "/chains?already_deleted=1" });
  for (const id of ["bad", "https://attacker.invalid", null]) {
    assert.match((await f.actions.updateChain(id, initial, form())).message, /Invalid chain ID/);
    assert.match((await f.actions.deleteChain(id, { error: null }, form())).error, /Invalid chain ID/);
  }
  assert.equal(writes(f.calls).length, 0);
});

for (const options of [
  { writeError: { code: "23514", message: "SECRET: check constraint" } },
  { writeError: { code: "42501", message: "SECRET: RLS detail" } },
  { writeError: { code: "23503", message: "SECRET: foreign key" } }, { writeThrows: true },
]) {
  test(`database failures are safe form states: ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    const create = await f.actions.createChain(initial, form());
    const edit = await f.actions.updateChain(customId, initial, form());
    const remove = await f.actions.deleteChain(customId, { error: null }, form());
    assert.ok(create.message || Object.keys(create.errors).length); assert.ok(edit.message); assert.ok(remove.error);
    assert.doesNotMatch(JSON.stringify([create, edit, remove]), /SECRET|42501|23514|23503/);
    assert.equal(f.revalidations.length, 0);
  });
}

test("failed metadata reads stop edit and deletion before any write", async () => {
  const f = fixture({ readError: true });
  const edit = await f.actions.updateChain(customId, initial, form());
  const remove = await f.actions.deleteChain(customId, { error: null }, form());
  assert.match(edit.message, /Unable to load/); assert.match(remove.error, /Unable to load/);
  assert.doesNotMatch(JSON.stringify([edit, remove]), /SECRET/);
  assert.equal(writes(f.calls).length, 0);
});

const pagePaths = ["page.tsx", "new/page.tsx", "[id]/page.tsx", "[id]/edit/page.tsx", "[id]/delete/page.tsx"];
const pageProps = { params: Promise.resolve({ id: customId }), searchParams: Promise.resolve({}) };
test("every chain page independently guards signed-out and ordinary users before reading records", async () => {
  for (const options of [{ signedOut: true }, { nonAdmin: true }]) {
    const f = fixture(options);
    for (const path of pagePaths) await assert.rejects(f.page(path)(pageProps), error => Boolean(error.destination));
    assert.equal(f.calls.filter(call => call.table !== "profiles").length, 0);
  }
});

test("directory loads default and custom chains with related counts; unavailable counts fall back safely", async () => {
  const f = fixture(); const result = await f.data.listChains(f.client, 1);
  assert.equal(result.status, "ready"); assert.equal(result.total, 2);
  assert.equal(result.chains.find(row => row.id === customId).stepCount, 2);
  const rendered = JSON.stringify(await f.page("page.tsx")(pageProps));
  assert.match(rendered, /system-badge/); assert.match(rendered, /custom-chain/);
  const fallback = fixture({ countError: true });
  assert.equal((await fallback.data.listChains(fallback.client, 1)).chains[0].stepCount, null);
});

test("detail reads existing steps in order without mutating them", async () => {
  const f = fixture(); const result = await f.data.getChainSteps(f.client, customId);
  assert.deepEqual(Array.from(result.steps, step => step.name), ["First", "Second"]);
  const rendered = JSON.stringify(await f.page("[id]/page.tsx")(pageProps));
  assert.match(rendered, /First prompt/); assert.match(rendered, /Second prompt/);
  assert.ok(rendered.indexOf("First prompt") < rendered.indexOf("Second prompt"));
  assert.equal(writes(f.calls).length, 0);
});

test("detail hands each redirect confirmation to the one-time notice, with no notice on refresh", async () => {
  const f = fixture();
  for (const [flag, message] of [
    ["created", "Prompt chain created."], ["updated", "Changes saved."],
    ["step_created", "Step added."], ["step_updated", "Step changes saved."],
    ["step_deleted", "Step deleted. Remaining positions updated."],
    [null, null], ["unrelated", null],
  ]) {
    const tree = await f.page("[id]/page.tsx")({ ...pageProps, searchParams: Promise.resolve(flag ? { [flag]: "1" } : {}) });
    const notice = elements(tree).find(node => node.type === "chain-success-notice");
    assert.equal(notice.props.message, message);
    assert.equal(elements(tree).filter(node => node.props?.role === "status").length, 0);
  }
  assert.equal(writes(f.calls).length, 0);
});

test("delete confirmation only reads; it identifies name/slug, warns about cascades, and uses a fixed Cancel URL", async () => {
  const f = fixture(); const tree = await f.page("[id]/delete/page.tsx")(pageProps);
  const rendered = JSON.stringify(tree);
  assert.match(rendered, /Are you sure/); assert.match(rendered, /Custom chain/); assert.match(rendered, /custom-chain/);
  assert.match(rendered, /stored steps and mix entry/);
  const control = elements(tree).find(node => node.type === "delete-form");
  assert.equal(control.props.cancelHref, `/chains/${customId}`);
  assert.equal(writes(f.calls).length, 0);
});

test("default edit/delete pages show a read-only notice instead of mutation forms", async () => {
  const f = fixture(); const props = { ...pageProps, params: Promise.resolve({ id: systemId }) };
  for (const path of ["[id]/edit/page.tsx", "[id]/delete/page.tsx"]) {
    const rendered = JSON.stringify(await f.page(path)(props));
    assert.match(rendered, /system-notice/); assert.doesNotMatch(rendered, /"type":"(?:chain|delete)-form"/);
  }
  assert.equal(writes(f.calls).length, 0);
});

test("directory empty/error and detail step-error states are safe rendered results", async () => {
  const empty = fixture(); empty.rows.prompt_chains = [];
  assert.match(JSON.stringify(await empty.page("page.tsx")(pageProps)), /No prompt chains yet/);
  const failed = fixture({ readError: true });
  for (const path of ["page.tsx", "[id]/page.tsx", "[id]/edit/page.tsx", "[id]/delete/page.tsx"]) {
    const rendered = JSON.stringify(await failed.page(path)(pageProps));
    assert.match(rendered, /read-error/); assert.doesNotMatch(rendered, /SECRET/);
  }
  const steps = fixture({ stepsError: true });
  assert.match(JSON.stringify(await steps.page("[id]/page.tsx")(pageProps)), /Stored steps could not be loaded/);
});

test("invalid and deleted detail IDs render not-found through framework control flow", async () => {
  const f = fixture();
  for (const id of ["bad-id", createdId]) {
    await assert.rejects(f.page("[id]/page.tsx")({ ...pageProps, params: Promise.resolve({ id }) }), error => error.notFound === true);
  }
});

test("Cancel is navigation only; pending confirmation disables final Delete", () => {
  let actionCalls = 0;
  for (const pending of [false, true]) {
    const component = load("components/chains/delete-chain-form.tsx", {
      "react/jsx-runtime": jsx, "next/link": { default: "a" },
      react: { useActionState: () => [{ error: null }, () => actionCalls++, pending], useRef: () => ({ current: false }), useEffect: () => {} },
    }).default;
    const tree = elements(component({ action: () => actionCalls++, original: model.metadataSnapshot(custom), cancelHref: `/chains/${customId}`, name: custom.name }));
    const cancel = tree.find(node => node.type === "a");
    assert.equal(cancel.props.href, `/chains/${customId}`);
    cancel.props.onClick({ preventDefault() {} });
    assert.equal(actionCalls, 0);
    assert.equal(tree.find(node => node.type === "button").props.disabled, pending);
  }
});

test("metadata form retains returned entries and associates inline errors with inputs", () => {
  const values = { name: " My draft ", slug: "INVALID SLUG", description: "Keep this\ntext" };
  const component = load("components/chains/chain-form.tsx", {
    "react/jsx-runtime": jsx, "next/link": { default: "a" }, "@/lib/chains/validation": validation,
    react: { useId: () => "fixture-form", useActionState: () => [{ values, errors: { slug: "Invalid slug" } }, () => {}, false], useRef: () => ({ current: false }), useEffect: () => {} },
  }).default;
  const tree = elements(component({ action() {}, values: initial.values, cancelHref: "/chains", mode: "create" }));
  for (const field of ["name", "slug", "description"]) {
    const input = tree.find(node => node.props?.name === field);
    assert.equal(input.props.defaultValue, values[field]);
  }
  const slug = tree.find(node => node.props?.name === "slug");
  assert.equal(slug.props["aria-invalid"], true);
  assert.match(slug.props["aria-describedby"], /slug-error/);
});

test("both mutation forms block repeated submissions and disable pending controls", () => {
  for (const path of ["chain-form.tsx", "delete-chain-form.tsx"]) {
    for (const pending of [false, true]) {
      const component = load(`components/chains/${path}`, {
        "react/jsx-runtime": jsx, "next/link": { default: "a" }, "@/lib/chains/validation": validation,
        react: { useId: () => "fixture-form", useActionState: () => [path === "chain-form.tsx" ? initial : { error: null }, () => {}, pending], useRef: () => ({ current: false }), useEffect: () => {} },
      }).default;
      const tree = elements(component({ action() {}, values: initial.values, original: model.metadataSnapshot(custom), cancelHref: "/chains", mode: "create", name: custom.name }));
      let prevented = 0;
      const event = { preventDefault() { prevented++; } };
      tree[0].props.onSubmit(event); tree[0].props.onSubmit(event);
      assert.equal(prevented, pending ? 2 : 1);
      assert.equal(tree.find(node => node.type === "button" && node.props.type === "submit").props.disabled, pending);
    }
  }
});
