import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadExecution, root, uuid, plain } from "./helpers/execution-core-fixture.mjs";

function loadUI(path, imports) {
  const code = ts.transpileModule(readFileSync(join(root, path), "utf8"), { fileName: path,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const testModule = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, { URL, AbortController, console })(name => {
    if (name === "react/jsx-runtime") return jsx;
    if (name === "react") return React;
    assert.ok(Object.hasOwn(imports, name), `Unmocked UI dependency ${name}`); return imports[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}
const chain = { id: uuid(3), name: "Custom captions", slug: "custom", description: "Five captions from a custom chain", stepCount: 3 };

function pageFixture(options = {}) {
  let reads = 0, readinessReads = 0;
  const client = { auth: { getUser: async () => ({ data: { user: options.signedOut ? null : { id: uuid(1), identities: [{ provider: "google" }] } }, error: null }) },
    from() { return { select() { return { eq() { return { maybeSingle: async () => ({ data: { is_superadmin: !options.nonAdmin }, error: null }) }; } }; } }; } };
  const guard = loadExecution({ "next/navigation": { redirect(destination) { const error = new Error("Redirect"); error.destination = destination; throw error; } },
    "@/lib/supabase/server": { createClient: async () => client } })("lib/auth/require-superadmin.ts");
  const Form = props => jsx.jsx("div", { "data-enabled": String(props.enabled), "data-run": props.initialRunId, children: "Generation form" });
  const Page = loadUI("app/(protected)/generate/page.tsx", {
    "next/server": { connection: async () => {} }, "@/lib/auth/require-superadmin": guard,
    "@/lib/execution/enabled": { generationEnabled() { readinessReads++; return options.enabled ?? false; } },
    "@/lib/generation/chains": { listGenerationChains: async supplied => { assert.equal(supplied, client); reads++; return options.readError ? { status: "error" } : { status: "ready", chains: [chain] }; } },
    "@/lib/chains/model": { UUID_PATTERN: /^[a-f0-9-]{36}$/i },
    "@/components/chains/chain-ui": { ChainPage: ({ title, children }) => jsx.jsx("section", { children: [title, children] }), ChainReadError: () => jsx.jsx("p", { children: "Could not load chains" }) },
    "@/components/generation-form": { default: Form, __esModule: true },
  }).default;
  return { Page, counts: () => ({ reads, readinessReads }) };
}

for (const [name, options, destination] of [["anonymous", { signedOut: true }, "/"], ["ordinary user", { nonAdmin: true }, "/?auth_error=access_denied"]]) {
  test(`Generate page independently rejects ${name} before chain/readiness data`, async () => {
    const f = pageFixture(options);
    await assert.rejects(f.Page({ searchParams: Promise.resolve({}) }), error => error.destination === destination);
    assert.deepEqual(f.counts(), { reads: 0, readinessReads: 0 });
  });
}

test("authorized Generate page receives only server readiness and validated recovery UUID", async () => {
  const f = pageFixture();
  const html = renderToStaticMarkup(await f.Page({ searchParams: Promise.resolve({ run: uuid(2) }) }));
  assert.match(html, /data-enabled="false"/); assert.match(html, new RegExp(`data-run="${uuid(2)}"`));
  assert.deepEqual(f.counts(), { reads: 1, readinessReads: 1 }); assert.doesNotMatch(html, /OPENROUTER|lease_token|artifact_path/);
});

test("chain lookup errors and invalid recovery IDs are safe page states", async () => {
  assert.match(renderToStaticMarkup(await pageFixture({ readError: true }).Page({ searchParams: Promise.resolve({}) })), /Could not load chains/);
  assert.doesNotMatch(renderToStaticMarkup(await pageFixture().Page({ searchParams: Promise.resolve({ run: "https://attacker.test" }) })), /data-run/);
});

test("Generate chain selector reuses every directory page and retains only metadata", async () => {
  const calls = [];
  const load = loadExecution({ "@/lib/chains/data": { PAGE_SIZE: 50, listChains: async (_client, page) => {
    calls.push(page);
    return { status: "ready", total: 51, chains: page === 1 ? [{ ...chain, prompt_template: "SECRET not for selector" }]
      : [{ ...chain, id: uuid(4), name: "Default", slug: "caption-arena-default", stepCount: 4 }] };
  } } });
  const result = await load("lib/generation/chains.ts").listGenerationChains({});
  assert.equal(result.status, "ready"); assert.equal(result.chains.length, 2); assert.deepEqual(calls, [1, 2]);
  assert.doesNotMatch(JSON.stringify(plain(result)), /SECRET|prompt_template/);
});

test("partial directory failures show an error rather than silently omitting chains", async () => {
  const load = loadExecution({ "@/lib/chains/data": { PAGE_SIZE: 50, listChains: async (_client, page) =>
    page === 1 ? { status: "ready", total: 51, chains: [chain] } : { status: "error" } } });
  assert.equal((await load("lib/generation/chains.ts").listGenerationChains({})).status, "error");
});

test("disabled Generate form renders accessible themed controls and no automatic network work", () => {
  let network = 0;
  const load = loadExecution({ "@/lib/supabase/client": { createClient() { network++; throw new Error("Unexpected client"); } } });
  const workflow = load("lib/generation/workflow.ts");
  const Form = loadUI("components/generation-form.tsx", {
    "next/image": { default: ({ src, alt, width, height, className }) => jsx.jsx("img", { src, alt, width, height, className }), __esModule: true },
    "next/link": { default: ({ href, children, className }) => jsx.jsx("a", { href, className, children }), __esModule: true },
    "@/lib/generation/workflow": workflow, "@/lib/generation/preview": { createImagePreview() { network++; throw new Error("Unexpected preview"); } },
  }).default;
  const html = renderToStaticMarkup(jsx.jsx(Form, { chains: [chain], enabled: false }));
  assert.match(html, /Generation is not currently enabled/);
  assert.match(html, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(html, /for="generation-chain"/); assert.match(html, /for="generation-context"/);
  assert.match(html, /role="status"/); assert.match(html, /bg-surface/); assert.match(html, /text-muted/);
  assert.match(html, /Custom captions/); assert.equal(network, 0);
});

test("empty chain list is a useful Generate state with a disabled primary action", () => {
  const load = loadExecution({ "@/lib/supabase/client": {} });
  const Form = loadUI("components/generation-form.tsx", {
    "next/image": { default: () => null, __esModule: true }, "next/link": { default: ({ children }) => jsx.jsx("a", { children }), __esModule: true },
    "@/lib/generation/workflow": load("lib/generation/workflow.ts"), "@/lib/generation/preview": {},
  }).default;
  const html = renderToStaticMarkup(jsx.jsx(Form, { chains: [], enabled: true }));
  assert.match(html, /No prompt chains are available/); assert.match(html, /type="submit"[^>]*disabled=""/);
});
