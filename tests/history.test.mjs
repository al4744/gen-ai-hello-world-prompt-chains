import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadExecution, root, plain, uuid } from "./helpers/execution-core-fixture.mjs";

const chainId = uuid(3), creator = uuid(1), runId = uuid(100);
const currentChain = { id: chainId, name: "Renamed chain", slug: "new-slug", description: "Current description", stepCount: 3 };
function row(n = 100, extra = {}) {
  const id = uuid(n), created = Date.parse("2026-11-06T12:00:00Z") + n * 1000;
  return { id, original_chain_id: chainId, current_chain_id: chainId, chain_name: "Original chain name", chain_slug: "old-slug",
    status: "succeeded", created_at: new Date(created).toISOString(), completed_at: new Date(created + 500).toISOString(),
    final_text: "Five captions from the original saved instructions.", creator_id_snapshot: creator,
    artifact_path: `${creator}/${id}/captioned.png`, artifact_sha256: "a".repeat(64), artifact_size_bytes: 2048,
    input_path: "SECRET input", lease_token_hash: "SECRET lease", provider_response_id: "SECRET provider", user_context: "SECRET context",
    ...extra };
}
const safe = value => assert.doesNotMatch(typeof value === "string" ? value : JSON.stringify(value), /SECRET|artifact_path|input_path|lease_token|provider_response_id|creator_id_snapshot|artifact_sha256|service.role/);
function redirect(destination) { const error = new Error("Redirect"); error.destination = destination; throw error; }
function notFound() { const error = new Error("Not found"); error.notFound = true; throw error; }

function fixture(options = {}) {
  const f = { rows: options.rows ?? [row()], calls: [], directoryReads: 0, pushes: [], options };
  const client = {
    auth: { async getUser() { return { data: { user: options.signedOut ? null : { id: creator, identities: [{ provider: options.nonGoogle ? "email" : "google" }] } },
      error: options.authError ? { message: "SECRET auth" } : null }; } },
    from(table) {
      const query = { table, fields: "", filters: [], orders: [], range: null, limit: null };
      const builder = {
        select(fields) { query.fields = fields; assert.ok(!fields.includes("*")); return builder; },
        eq(field, value) { query.filters.push({ op: "eq", field, value }); return builder; },
        not(field, op, value) { assert.equal(op, "is"); assert.equal(value, null); query.filters.push({ op: "not-null", field }); return builder; },
        gte(field, value) { query.filters.push({ op: "gte", field, value }); return builder; },
        lte(field, value) { query.filters.push({ op: "lte", field, value }); return builder; },
        order(field, value) { query.orders.push([field, value.ascending]); return builder; },
        range(start, end) { query.range = [start, end]; return builder; },
        limit(value) { query.limit = value; return builder; },
        abortSignal(signal) { assert.ok(signal instanceof AbortSignal); return builder; },
        maybeSingle() { return execute(true); },
        then(resolve, reject) { return execute(false).then(resolve, reject); },
      };
      async function execute(single) {
        if (table === "profiles") return { data: options.profileMissing ? null : { is_superadmin: !options.nonAdmin }, error: options.profileError ? { message: "SECRET profile" } : null };
        assert.equal(table, "prompt_chain_runs"); f.calls.push(structuredClone(query));
        if (options.queryThrows) throw new Error("SECRET database exception");
        if (options.queryError) return { data: null, error: { message: "SECRET SQL diagnostics" } };
        let rows = [...f.rows];
        for (const filter of query.filters) rows = rows.filter(value => filter.op === "eq" ? value[filter.field] === filter.value
          : filter.op === "not-null" ? value[filter.field] != null
          : filter.op === "gte" ? value[filter.field] >= filter.value : value[filter.field] <= filter.value);
        for (const [field, ascending] of [...query.orders].reverse()) rows.sort((a, b) => a[field] < b[field] ? (ascending ? -1 : 1) : a[field] > b[field] ? (ascending ? 1 : -1) : 0);
        if (query.range && !options.ignoreRange) rows = rows.slice(query.range[0], query.range[1] + 1);
        if (query.limit) rows = rows.slice(0, query.limit);
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      return builder;
    },
    rpc() { throw new Error("History must never mutate"); },
    storage: { from() { throw new Error("History query must not bypass the media endpoint"); } },
  };
  const load = loadExecution({ "@/lib/supabase/server": { createClient: async () => client }, "next/navigation": { redirect, notFound } });
  f.client = client; f.data = load("lib/history/data.ts"); f.model = load("lib/history/model.ts"); f.guard = load("lib/auth/require-superadmin.ts");
  function ui(path, imports) {
    const code = ts.transpileModule(readFileSync(join(root, path), "utf8"), { fileName: path,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
    const testModule = { exports: {} };
    vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { URL, URLSearchParams, Intl })(name => {
      if (name === "react/jsx-runtime") return jsx;
      if (name === "react") return React;
      if (name === "next/link") return { __esModule: true, default: ({ href, children, className, "aria-current": current }) => jsx.jsx("a", { href, className, "aria-current": current, children }) };
      if (name === "next/image") return { __esModule: true, default: ({ src, alt, width, height, className, loading }) => jsx.jsx("img", { src, alt, width, height, className, loading }) };
      if (name === "next/server") return { connection: async () => {} };
      if (name === "next/navigation") return { redirect, notFound, usePathname: () => options.pathname ?? "/history",
        useRouter: () => ({ push: (href, config) => f.pushes.push({ href, config }) }) };
      if (name === "@/lib/auth/require-superadmin") return f.guard;
      if (name === "@/lib/history/data") return f.data;
      if (name === "@/lib/history/model") return f.model;
      if (name === "@/lib/chains/model") return load("lib/chains/model.ts");
      assert.ok(Object.hasOwn(imports, name), `Unmocked history UI dependency ${name}`); return imports[name];
    }, testModule, testModule.exports);
    return testModule.exports;
  }
  const shared = ui("components/chains/chain-ui.tsx", {});
  const image = ui("components/history/completed-image.tsx", {});
  const localTime = ui("components/history/local-date-time.tsx", { "@/lib/history/dates": load("lib/history/dates.ts") });
  const gallery = ui("components/history/history-gallery.tsx", { "./completed-image": image, "./local-date-time": localTime });
  const filter = ui("components/history/history-filter.tsx", {});
  const common = { "@/components/chains/chain-ui": shared, "@/components/history/history-gallery": gallery, "@/components/history/completed-image": image,
    "@/components/history/local-date-time": localTime };
  f.Page = ui("app/(protected)/history/page.tsx", { ...common,
    "@/components/history/history-filter": filter,
    "@/lib/generation/chains": { listGenerationChains: async supplied => {
      assert.equal(supplied, client); f.directoryReads++;
      return options.directoryError ? { status: "error" } : { status: "ready", chains: options.chains ?? [currentChain] };
    } },
  }).default;
  f.Detail = ui("app/(protected)/history/[runId]/page.tsx", common).default;
  f.gallery = gallery; f.image = image;
  f.Filter = filter.default;
  f.Nav = ui("components/workspace-nav.tsx", {}).default;
  f.ChainDetail = ui("app/(protected)/chains/[id]/page.tsx", { "@/components/chains/chain-ui": shared,
    "@/lib/chains/data": { getChain: async () => ({ status: "ready", chain: { ...currentChain, created_at: row().created_at, ...options.chain } }), getChainSteps: async () => ({ status: "ready", steps: [] }) },
    "@/components/steps/step-reorder-list": { __esModule: true, default: () => null },
    "@/components/chains/chain-success-notice": { __esModule: true, default: ({ children }) => children },
  }).default;
  return f;
}

for (const [name, options, destination] of [
  ["anonymous", { signedOut: true }, "/"], ["invalid session", { authError: true }, "/"],
  ["ordinary user", { nonAdmin: true }, "/?auth_error=access_denied"], ["missing profile", { profileMissing: true }, "/?auth_error=access_denied"],
  ["profile query failure", { profileError: true }, "/?auth_error=access_denied"], ["non-Google identity", { nonGoogle: true }, "/?auth_error=access_denied"],
]) test(`history and full generation reject ${name} before reading records`, async () => {
  const f = fixture(options);
  await assert.rejects(f.Page({ searchParams: Promise.resolve({}) }), error => error.destination === destination);
  await assert.rejects(f.Detail({ params: Promise.resolve({ runId }) }), error => error.destination === destination);
  assert.equal(f.calls.length, 0); assert.equal(f.directoryReads, 0);
});

test("current superadmins can browse successful records across creator accounts", async () => {
  const other = uuid(77), f = fixture({ rows: [row(100, { creator_id_snapshot: other, artifact_path: `${other}/${runId}/captioned.png` })] });
  const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({}) }));
  assert.match(html, /All completed generations/); assert.match(html, /Original chain name/); safe(html);
  assert.equal(f.calls.length, 1); assert.equal(f.directoryReads, 1);
  assert.ok(!f.calls[0].filters.some(filter => filter.field === "creator_id" || filter.field === "creator_id_snapshot"));
});

test("history reauthorizes after the current role changes", async () => {
  const options = {}, f = fixture(options);
  await f.Page({ searchParams: Promise.resolve({}) }); const queries = f.calls.length;
  options.nonAdmin = true;
  await assert.rejects(f.Page({ searchParams: Promise.resolve({}) }), error => error.destination === "/?auth_error=access_denied");
  assert.equal(f.calls.length, queries);
});

test("filter uses immutable original_chain_id, not name, slug, creator or current-chain FK", async () => {
  const f = fixture({ rows: [row(), row(101, { original_chain_id: uuid(4), current_chain_id: uuid(4), chain_name: "Original chain name" })] });
  const result = await f.data.listHistory(f.client, { page: 1, chainId });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].id, runId);
  assert.ok(f.calls[0].filters.some(filter => filter.field === "original_chain_id" && filter.value === chainId));
  assert.ok(!f.calls[0].filters.some(filter => ["chain_name", "chain_slug", "current_chain_id"].includes(filter.field)));
});

test("renamed/edited chain keeps its old saved name and original ID", async () => {
  const f = fixture(); const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({ chain: chainId }) }));
  assert.match(html, /Generations from Renamed chain/); assert.match(html, /Original chain name/);
  assert.equal(f.calls.length, 1); assert.match(html, new RegExp(`/history\\?chain=${chainId}`));
  const full = renderToStaticMarkup(await f.Detail({ params: Promise.resolve({ runId }) }));
  assert.match(full, /Prompt chain when generated/); assert.match(full, /Original chain name/); assert.match(full, new RegExp(`/chains/${chainId}`));
  assert.match(full, /Five captions from the original saved instructions/);
});

test("deleted chain history remains filterable and omits a broken live-chain link", async () => {
  const f = fixture({ rows: [row(100, { current_chain_id: null })], chains: [] });
  const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({ chain: chainId }) }));
  assert.match(html, /Generations from Original chain name/);
  const full = renderToStaticMarkup(await f.Detail({ params: Promise.resolve({ runId }) }));
  assert.match(full, /original chain has been deleted/); assert.doesNotMatch(full, /href="\/chains\//);
});

test("archived selected name is resolved once on an empty later page", async () => {
  const f = fixture({ rows: [row(100, { current_chain_id: null })], chains: [] });
  const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({ chain: chainId, page: "2" }) }));
  assert.match(html, /Generations from Original chain name/); assert.match(html, /First page/);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].limit, 1);
  assert.equal(f.calls[1].fields, "original_chain_id,chain_name");
});

for (const params of [ { chain: "bad" }, { chain: "https://attacker.test" }, { chain: [chainId, uuid(4)] }, { page: "0" },
  { page: "-1" }, { page: "1.5" }, { page: "10001" }, { page: "1e3" }, { page: ["1", "2"] } ]) {
  test(`invalid filter is rejected before records: ${JSON.stringify(params)}`, async () => {
    const f = fixture(), html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve(params) }));
    assert.match(html, /Choose a valid prompt chain and page number/); assert.equal(f.calls.length, 0); assert.equal(f.directoryReads, 0);
  });
}

test("filter parsing and links canonicalize IDs and bound pagination", () => {
  const f = fixture(); assert.deepEqual(plain(f.model.parseHistoryFilter({ chain: chainId.toUpperCase(), page: "10000" })), { page: 10000, chainId });
  assert.deepEqual(plain(f.model.parseHistoryFilter({ chain: "" })), { page: 1 });
  assert.equal(f.model.historyHref({ page: 2, chainId }), `/history?chain=${chainId}&page=2`);
  assert.equal(f.model.historyHref({ page: 1, chainId }), `/history?chain=${chainId}`);
  assert.throws(() => f.model.historyHref({ page: 10001 }));
});

test("server query fetches one bounded page plus lookahead, newest first with UUID tie-break", async () => {
  const sameTime = "2026-11-06T12:00:00.000Z";
  const f = fixture({ rows: Array.from({ length: 13 }, (_, i) => row(100 + i, { created_at: sameTime, completed_at: "2026-11-06T12:00:01.000Z" })) });
  const first = await f.data.listHistory(f.client, { page: 1 });
  assert.equal(first.entries.length, 12); assert.equal(first.hasNext, true);
  assert.equal(first.entries[0].id, uuid(112)); assert.equal(first.entries[11].id, uuid(101));
  assert.deepEqual(f.calls[0].orders, [["created_at", false], ["id", false]]); assert.deepEqual(f.calls[0].range, [0, 12]);
  const second = await f.data.listHistory(f.client, { page: 2 });
  assert.equal(second.entries.length, 1); assert.equal(second.entries[0].id, uuid(100)); assert.equal(second.hasNext, false);
  assert.deepEqual(f.calls[1].range, [12, 24]);
});

test("distinct creation times are ordered newest-first", async () => {
  const f = fixture({ rows: [row(101), row(100), row(102)] });
  const result = await f.data.listHistory(f.client, { page: 1 });
  assert.deepEqual(plain(result.entries.map(entry => entry.id)), [uuid(102), uuid(101), uuid(100)]);
});

test("maximum page is bounded and disables a next link if more raw rows exist", async () => {
  const f = fixture({ rows: Array.from({ length: 13 }, (_, i) => row(100 + i)), ignoreRange: true });
  const result = await f.data.listHistory(f.client, { page: 10000 });
  assert.equal(result.entries.length, 12); assert.equal(result.hasNext, false); assert.equal(result.capped, true);
  assert.deepEqual(f.calls[0].range, [119988, 120000]);
  assert.equal((await f.data.listHistory(f.client, { page: Infinity })).status, "invalid"); assert.equal(f.calls.length, 1);
});

test("pagination links preserve the selected chain and reset filtering to page one", async () => {
  const f = fixture({ rows: Array.from({ length: 25 }, (_, i) => row(100 + i)) });
  const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({ chain: chainId, page: "2" }) }));
  assert.match(html, new RegExp(`/history\\?chain=${chainId}&amp;page=3`));
  assert.match(html, new RegExp(`href="/history\\?chain=${chainId}"`));
  assert.doesNotMatch(html, /name="page"|Apply filter/); assert.match(html, /role="group" aria-label="History filter"/);
});

function findElement(element, predicate) {
  if (!element || typeof element !== "object") return null;
  if (predicate(element)) return element;
  for (const child of React.Children.toArray(element.props?.children)) {
    const found = findElement(child, predicate); if (found) return found;
  }
  return null;
}

test("selecting a chain navigates immediately to its ID filter on page one", () => {
  const f = fixture(), nextId = uuid(4);
  const tree = f.Filter({ chainId, choices: [[chainId, "Current"], [nextId, "Next"]] });
  const select = findElement(tree, element => element.type === "select");
  assert.equal(select.props.value, chainId); assert.equal(select.props.defaultValue, undefined);
  select.props.onChange({ target: { value: nextId } });
  assert.equal(f.pushes.length, 1); assert.equal(f.pushes[0].href, `/history?chain=${nextId}`);
  assert.equal(f.pushes[0].config.scroll, false);
  assert.equal(findElement(tree, element => element.type === "button"), null);
});

test("selecting All prompt chains clears chain and pagination parameters immediately", () => {
  const f = fixture();
  const tree = f.Filter({ chainId, choices: [[chainId, "Current"]] });
  findElement(tree, element => element.type === "select").props.onChange({ target: { value: "" } });
  assert.equal(f.pushes[0].href, "/history");
  const filter = f.model.parseHistoryFilter(Object.fromEntries(new URL(f.pushes[0].href, "https://chains.test").searchParams));
  assert.deepEqual(plain(filter), { page: 1 });
});

test("Clear filter resets the controlled dropdown and loads unfiltered page-one records", async () => {
  const f = fixture({ rows: [row(), row(101, { original_chain_id: uuid(4), current_chain_id: uuid(4) })] });
  const tree = f.Filter({ chainId, choices: [[chainId, "Current"]] });
  const clear = findElement(tree, element => element.props.children === "Clear filter");
  assert.equal(clear.props.href, "/history");
  const params = Object.fromEntries(new URL(clear.props.href, "https://chains.test").searchParams);
  const filter = f.model.parseHistoryFilter(params);
  assert.deepEqual(plain(filter), { page: 1 });
  const reset = f.Filter({ chainId: filter.chainId, choices: [[chainId, "Current"]] });
  assert.equal(findElement(reset, element => element.type === "select").props.value, "");
  const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve(params) }));
  assert.match(html, /All completed generations/); assert.doesNotMatch(html, /Clear filter|Apply filter/);
  assert.equal((html.match(/View generation/g) ?? []).length, 2);
  assert.deepEqual(f.calls[0].range, [0, 12]);
  assert.ok(!f.calls[0].filters.some(value => value.field === "original_chain_id"));
});

test("URL-backed selection restores on refresh and Back/Forward without stale local state", async () => {
  const other = uuid(4), f = fixture();
  const choices = [[chainId, "First"], [other, "Second"]];
  const visits = [`/history?chain=${chainId}&page=3`, `/history?chain=${other}`, "/history", `/history?chain=${other}`, `/history?chain=${chainId}&page=3`];
  for (const href of visits) {
    const params = Object.fromEntries(new URL(href, "https://chains.test").searchParams);
    const filter = f.model.parseHistoryFilter(params);
    const tree = f.Filter({ chainId: filter.chainId, choices });
    const select = findElement(tree, element => element.type === "select");
    assert.equal(select.props.value, filter.chainId ?? ""); assert.equal(select.props.defaultValue, undefined);
    const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve(params) }));
    if (filter.chainId) assert.match(html, new RegExp(`value="${filter.chainId}" selected=""`));
    else assert.match(html, /value="" selected=""/);
  }
  assert.equal(f.pushes.length, 0); // Restoring a URL never initiates another navigation.
});

for (const status of ["pending", "prepared", "running", "failed", "interrupted"]) test(`history excludes ${status} rows`, async () => {
  const f = fixture({ rows: [row(), row(101, { status })] });
  const result = await f.data.listHistory(f.client, { page: 1 });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].id, runId);
});

for (const [name, change] of [
  ["absent artifact digest", { artifact_sha256: null }], ["malformed artifact digest", { artifact_sha256: "invalid" }],
  ["absent size", { artifact_size_bytes: null }], ["oversized artifact", { artifact_size_bytes: 5242881 }],
  ["absent completion", { completed_at: null }], ["invalid timestamp", { created_at: "invalid" }],
  ["completion before creation", { completed_at: "2000-01-01T00:00:00Z" }], ["wrong path", { artifact_path: "SECRET external/path" }],
  ["empty output", { final_text: "  " }], ["oversized output", { final_text: "a".repeat(32769) }],
  ["invalid chain identity", { original_chain_id: "bad" }], ["wrong live-chain identity", { current_chain_id: uuid(99) }],
  ["oversized saved chain name", { chain_name: "x".repeat(2049) }],
  ["empty saved chain name", { chain_name: "  " }],
  ["invalid default output", { chain_slug: "caption-arena-default", final_text: '{"caption_a":"only one"}' }],
]) test(`history excludes malformed/unpersisted ${name}`, async () => {
  const f = fixture({ rows: [row(), row(101, change)] });
  const result = await f.data.listHistory(f.client, { page: 1 });
  assert.equal(result.entries.length, 1); assert.equal(result.entries[0].id, runId); safe(result);
});

test("safe projection exposes only display fields, never receipt paths, creator IDs or diagnostics", async () => {
  const f = fixture(); const result = await f.data.listHistory(f.client, { page: 1 });
  safe(result); assert.deepEqual(Object.keys(result.entries[0]).sort(), ["id", "chainId", "currentChainId", "chainName", "chainSlug", "createdAt", "completedAt", "finalText"].sort());
  assert.doesNotMatch(f.calls[0].fields, /lease|input_path|user_context|provider|request_config/);
});

test("empty, out-of-range and malformed-only pages are helpful UI states", async () => {
  const empty = fixture({ rows: [] });
  assert.match(renderToStaticMarkup(await empty.Page({ searchParams: Promise.resolve({ chain: chainId }) })), /No completed generations yet/);
  assert.match(renderToStaticMarkup(await empty.Page({ searchParams: Promise.resolve({ chain: chainId, page: "2" }) })), /No completed generations on this page/);
  const malformed = fixture({ rows: [row(100, { artifact_sha256: "bad" })] });
  const html = renderToStaticMarkup(await malformed.Page({ searchParams: Promise.resolve({}) }));
  assert.match(html, /Some saved entries could not be verified/); assert.doesNotMatch(html, /View generation/);
});

for (const options of [{ queryError: true }, { queryThrows: true }]) test(`query failures are sanitized: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options); const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({}) }));
  assert.match(html, /Unable to load this information/); safe(html);
  assert.equal((await f.data.getHistoryRun(f.client, runId)).status, "error");
});

test("directory failure preserves the saved gallery with a clear partial-data notice", async () => {
  const f = fixture({ directoryError: true }); const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({}) }));
  assert.match(html, /chain directory could not be loaded/); assert.match(html, /View generation/); safe(html);
});

test("gallery and full view use only the existing protected media preview/download URLs", async () => {
  const f = fixture(); const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({}) }));
  assert.match(html, new RegExp(`/api/generation/runs/${runId}/media`));
  assert.match(html, new RegExp(`/api/generation/runs/${runId}/media\\?download=1`));
  assert.match(html, /loading="lazy"/); safe(html);
  const full = renderToStaticMarkup(await f.Detail({ params: Promise.resolve({ runId }) }));
  assert.match(full, /Saved captions/); assert.match(full, /Download PNG/); assert.match(full, /href="\/generate"/); safe(full);
  assert.equal(f.model.completedMediaHref(runId, true), `/api/generation/runs/${runId}/media?download=1`);
  assert.throws(() => f.model.completedMediaHref("https://attacker.test"));
});

test("gallery and both detail timestamps use hydration-safe local time without changing saved values", async () => {
  const f = fixture(), before = structuredClone(f.rows);
  const gallery = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({}) }));
  assert.match(gallery, /Dates are shown in your local time zone/); assert.doesNotMatch(gallery, /Dates are shown in UTC/);
  assert.equal((gallery.match(/Loading local time/g) ?? []).length, 1);
  const full = renderToStaticMarkup(await f.Detail({ params: Promise.resolve({ runId }) }));
  assert.equal((full.match(/Loading local time/g) ?? []).length, 2);
  assert.ok(full.includes(before[0].created_at)); assert.ok(full.includes(before[0].completed_at));
  assert.deepEqual(f.rows, before);
});

test("invalid, missing or unfinished detail requests never render a gallery image", async () => {
  const f = fixture({ rows: [row(100, { status: "running" })] });
  await assert.rejects(f.Detail({ params: Promise.resolve({ runId: "bad" }) }), error => error.notFound);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.Detail({ params: Promise.resolve({ runId }) }), error => error.notFound);
  const invalid = fixture({ rows: [row(100, { artifact_sha256: "bad" })] });
  const html = renderToStaticMarkup(await invalid.Detail({ params: Promise.resolve({ runId }) }));
  assert.match(html, /Generation unavailable/); assert.doesNotMatch(html, /<img|Download PNG/);
});

test("full default captions are separate alternatives and exact saved JSON is retained and escaped", async () => {
  const text = ' {"caption_a":"First <script> literal","caption_b":"Second caption"}\n';
  const f = fixture({ rows: [row(100, { chain_slug: "caption-arena-default", final_text: text })] });
  const entry = (await f.data.getHistoryRun(f.client, runId)).entry;
  assert.equal(entry.finalText, text);
  const html = renderToStaticMarkup(await f.Detail({ params: Promise.resolve({ runId }) }));
  assert.match(html, /Caption A/); assert.match(html, /Caption B/); assert.match(html, /View exact saved output/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});

test("caption previews are bounded by Unicode characters without changing full output", () => {
  const f = fixture(), text = "😀".repeat(300);
  assert.equal(Array.from(f.model.captionPreview(text)).length, 201); assert.equal(text.length, 600);
  assert.equal(f.model.savedCaptionAlternatives({ chainSlug: "custom", finalText: '{"caption_a":"a","caption_b":"b"}' }), null);
});

for (const system of [false, true]) test(`chain detail exposes ID-scoped history for ${system ? "system" : "custom"} chains`, async () => {
  const f = fixture({ chain: { slug: system ? "caption-arena-default" : "custom" } });
  const html = renderToStaticMarkup(await f.ChainDetail({ params: Promise.resolve({ id: chainId }), searchParams: Promise.resolve({}) }));
  assert.match(html, new RegExp(`href="/history\\?chain=${chainId}"`)); assert.match(html, /Generation history/);
});

test("workspace navigation marks History active for both its gallery and full-generation routes", () => {
  for (const pathname of ["/history", `/history/${runId}`]) {
    const f = fixture({ pathname }); const html = renderToStaticMarkup(jsx.jsx(f.Nav, {}));
    assert.match(html, /href="\/history"[^>]*aria-current="page"/); assert.match(html, />04</);
  }
});
