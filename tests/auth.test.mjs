import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server.js";
import * as jsxRuntime from "react/jsx-runtime";

// Execute the actual TypeScript modules with isolated framework/SDK boundaries.
// No real Supabase client, environment file, network call, or user record is used.
function load(relativePath, imports, globals = {}) {
  const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    fileName: relativePath,
  });
  const testModule = { exports: {} };
  const execute = vm.runInNewContext(`(function(require, module, exports) { ${outputText}\n})`, {
    URL, ...globals,
  }, { filename: fileURLToPath(new URL(`../${relativePath}`, import.meta.url)) });
  execute((name) => {
    assert.ok(Object.hasOwn(imports, name), `Unmocked dependency: ${name}`);
    return imports[name];
  }, testModule, testModule.exports);
  return testModule.exports;
}

function redirect(path) {
  const error = new Error("Redirect");
  error.destination = path;
  throw error;
}

const googleUser = { id: "fixture-user", email: "superadmin@example.invalid", identities: [{ provider: "google" }] };

function fixture(options = {}) {
  const calls = { queries: [], exchanges: [], signOut: [], revalidations: [] };
  const client = {
    auth: {
      async getUser() {
        if (options.authThrows) throw new Error("Auth unavailable");
        return { data: { user: Object.hasOwn(options, "user") ? options.user : googleUser }, error: options.authError ?? null };
      },
      async exchangeCodeForSession(code) {
        calls.exchanges.push(code);
        if (options.exchangeThrows) throw new Error("Exchange unavailable");
        return { error: options.exchangeError ?? null };
      },
      async signOut(input) {
        calls.signOut.push(input);
        if (options.signOutThrows) throw new Error("Sign-out unavailable");
        return { error: options.signOutError ?? null };
      },
    },
    from(table) {
      calls.queries.push(["from", table]);
      return {
        select(fields) {
          calls.queries.push(["select", fields]);
          return {
            eq(field, value) {
              calls.queries.push(["eq", field, value]);
              return {
                async maybeSingle() {
                  if (options.profileThrows) throw new Error("Profile unavailable");
                  return { data: Object.hasOwn(options, "profile") ? options.profile : { is_superadmin: true }, error: options.profileError ?? null };
                },
              };
            },
          };
        },
      };
    },
  };
  const server = { async createClient() {
    if (options.clientThrows) throw new Error("Client unavailable");
    return client;
  } };
  const guard = load("lib/auth/require-superadmin.ts", {
    "server-only": {}, "next/navigation": { redirect }, "@/lib/supabase/server": server,
  });
  const callback = load("app/auth/callback/route.ts", {
    "next/server": { NextResponse }, "@/lib/supabase/server": server, "@/lib/auth/require-superadmin": guard,
  });
  const actions = load("app/auth/actions.ts", {
    "next/navigation": { redirect }, "next/cache": { revalidatePath: (...args) => calls.revalidations.push(args) },
    "@/lib/supabase/server": server,
  });
  return { client, calls, guard, callback, actions };
}

for (const [name, options, status] of [
  ["signed-out user", { user: null }, "signed-out"],
  ["expired or invalid session", { authError: { message: "Invalid session" } }, "signed-out"],
  ["Auth service exception", { authThrows: true }, "signed-out"],
  ["client initialization exception", { clientThrows: true }, "signed-out"],
  ["ordinary user", { profile: { is_superadmin: false } }, "denied"],
  ["missing profile", { profile: null }, "denied"],
  ["profile query error", { profileError: { message: "Unavailable" } }, "denied"],
  ["profile query exception", { profileThrows: true }, "denied"],
  ["truthy string flag", { profile: { is_superadmin: "true" } }, "denied"],
  ["truthy numeric flag", { profile: { is_superadmin: 1 } }, "denied"],
  ["null superadmin flag", { profile: { is_superadmin: null } }, "denied"],
  ["non-Google identity", { user: { ...googleUser, identities: [{ provider: "email" }] } }, "denied"],
  ["missing identities", { user: { id: "fixture-user" } }, "denied"],
  ["verified Google superadmin", {}, "authorized"],
]) {
  test(`authorization: ${name}`, async () => {
    const { guard } = fixture(options);
    const result = await guard.getAccessState();
    assert.equal(result.status, status);
    if (status !== "authorized") {
      assert.equal(result.user, undefined);
      assert.equal(result.supabase, undefined);
    }
  });
}

test("profile lookup uses only the Auth-verified user ID", async () => {
  const { guard, calls } = fixture();
  await guard.requireSuperadmin();
  assert.deepEqual(calls.queries, [["from", "profiles"], ["select", "is_superadmin"], ["eq", "id", googleUser.id]]);
});

test("page guard redirects signed-out and denied users to terminal public states", async () => {
  await assert.rejects(fixture({ user: null }).guard.requireSuperadmin(), { destination: "/" });
  await assert.rejects(fixture({ profile: null }).guard.requireSuperadmin(), { destination: "/?auth_error=access_denied" });
});

test("future API guard exposes safe 401/403 errors", async () => {
  for (const [options, status] of [[{ user: null }, 401], [{ profile: null }, 403]]) {
    const { guard } = fixture(options);
    await assert.rejects(guard.requireSuperadmin({ onDenied: "throw" }), (error) => error instanceof guard.AuthorizationError && error.status === status);
  }
});

test("authorization is checked again after privileges or session change", async () => {
  const options = {};
  const { guard } = fixture(options);
  assert.equal((await guard.getAccessState()).status, "authorized");
  options.profile = { is_superadmin: false };
  assert.equal((await guard.getAccessState()).status, "denied");
  options.user = null;
  assert.equal((await guard.getAccessState()).status, "signed-out");
});

for (const path of ["/auth/callback", "/auth/callback?code=", "/auth/callback?code=%20", "/auth/callback?error=access_denied&code=fake"]) {
  test(`callback rejects malformed or cancelled request: ${path}`, async () => {
    const { callback, calls } = fixture();
    const response = await callback.GET(new Request(`http://localhost:3002${path}`));
    assert.equal(response.headers.get("location"), "http://localhost:3002/?auth_error=authentication_failed");
    assert.equal(calls.exchanges.length, 0);
    assert.match(response.headers.get("cache-control"), /no-store/);
  });
}

for (const options of [{ exchangeError: { message: "Expired" } }, { exchangeThrows: true }, { user: null }, { authThrows: true }]) {
  test(`callback fails safely after exchange/auth failure: ${JSON.stringify(options)}`, async () => {
    const { callback } = fixture(options);
    const response = await callback.GET(new Request("http://localhost:3002/auth/callback?code=fixture-code"));
    assert.equal(response.headers.get("location"), "http://localhost:3002/?auth_error=authentication_failed");
  });
}

test("callback keeps unauthorized session for the Access denied sign-out control", async () => {
  const { callback, calls } = fixture({ profile: { is_superadmin: false } });
  const response = await callback.GET(new Request("http://localhost:3002/auth/callback?code=fixture-code"));
  assert.equal(response.headers.get("location"), "http://localhost:3002/?auth_error=access_denied");
  assert.equal(calls.signOut.length, 0);
});

test("callback ignores external, protocol-relative, and encoded return destinations", async () => {
  for (const target of ["https://attacker.invalid", "//attacker.invalid", "%2F%2Fattacker.invalid", "/dashboard"]) {
    const { callback, calls } = fixture();
    const response = await callback.GET(new Request(`http://localhost:3002/auth/callback?code=fixture-code&next=${encodeURIComponent(target)}&returnTo=${encodeURIComponent(target)}`, {
      headers: { "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https" },
    }));
    assert.equal(response.headers.get("location"), "http://localhost:3002/dashboard");
    assert.deepEqual(calls.exchanges, ["fixture-code"]);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});

test("sign-out revokes the local session, clears router state, and redirects home", async () => {
  const { actions, calls } = fixture();
  await assert.rejects(actions.signOut(), { destination: "/" });
  assert.equal(calls.signOut[0].scope, "local");
  assert.deepEqual(calls.revalidations, [["/", "layout"]]);
});

test("sign-out errors stay visible and do not falsely report success", async () => {
  for (const options of [{ signOutError: { message: "Internal details" } }, { signOutThrows: true }]) {
    const { actions, calls } = fixture(options);
    const result = await actions.signOut();
    assert.equal(result.error, "Unable to sign out. Please try again.");
    assert.equal(calls.revalidations.length, 0);
  }
});

test("proxy propagates refreshed cookies and disables browser/CDN caching", async () => {
  const request = new NextRequest("http://localhost:3002/dashboard");
  let clientOptions;
  const { updateSession } = load("lib/supabase/proxy.ts", {
    "next/server": { NextResponse }, "./options": { authCookieOptions: { name: "fixture-app-auth" } },
    "@supabase/ssr": { createServerClient(url, key, options) {
      clientOptions = options;
      return { auth: { async getClaims() {
        options.cookies.setAll([{ name: "fixture-app-auth.0", value: "fixture-token", options: { path: "/", sameSite: "lax" } }], { Pragma: "no-cache" });
        options.cookies.setAll([{ name: "fixture-app-auth.1", value: "fixture-token-2", options: { path: "/" } }], {});
      } } };
    } },
  }, { process: { env: {} } });
  const response = await updateSession(request);
  assert.equal(clientOptions.cookieOptions.name, "fixture-app-auth");
  assert.equal(request.cookies.get("fixture-app-auth.0").value, "fixture-token");
  assert.equal(response.cookies.get("fixture-app-auth.0").value, "fixture-token");
  assert.equal(response.cookies.get("fixture-app-auth.1").value, "fixture-token-2");
  assert.match(response.headers.get("cache-control"), /private.*no-store/);
  assert.equal(response.headers.get("cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
});

test("proxy refresh exceptions grant no authorization and still prevent caching", async () => {
  const { updateSession } = load("lib/supabase/proxy.ts", {
    "next/server": { NextResponse }, "./options": { authCookieOptions: {} },
    "@supabase/ssr": { createServerClient: () => ({ auth: { getClaims: async () => { throw new Error("Expired"); } } }) },
  }, { process: { env: {} } });
  const response = await updateSession(new NextRequest("http://localhost:3002/dashboard"));
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("location"), null);
});

test("SSR and browser clients share an app-specific cookie name", async () => {
  const optionsModule = load("lib/supabase/options.ts", {});
  let serverOptions, browserOptions;
  const writes = [];
  const { createClient: serverClient } = load("lib/supabase/server.ts", {
    "server-only": {}, "./options": optionsModule,
    "next/headers": { cookies: async () => ({ getAll: () => [], set: (...args) => writes.push(args) }) },
    "@supabase/ssr": { createServerClient: (url, key, options) => { serverOptions = options; return {}; } },
  }, { process: { env: {} }, fetch: async (input, init) => init });
  const { createClient: browserClient } = load("lib/supabase/client.ts", {
    "./options": optionsModule,
    "@supabase/ssr": { createBrowserClient: (url, key, options) => { browserOptions = options; return {}; } },
  }, { process: { env: {} } });
  await serverClient();
  browserClient();
  assert.equal(serverOptions.cookieOptions.name, "caption-arena-prompt-chains-auth");
  assert.equal(browserOptions.cookieOptions.name, serverOptions.cookieOptions.name);
  serverOptions.cookies.setAll([{ name: "fixture-cookie", value: "fixture-token", options: { path: "/" } }]);
  assert.equal(writes[0][0], "fixture-cookie");
  assert.equal((await serverOptions.global.fetch("https://fixture.invalid", {})).cache, "no-store");
});

test("dashboard verifies authorization independently before returning authenticated UI", async () => {
  for (const [options, allowed] of [[{ user: null }, false], [{ profile: null }, false], [{}, true]]) {
    const { guard } = fixture(options);
    const page = load("app/(protected)/dashboard/page.tsx", {
      "react/jsx-runtime": jsxRuntime, "next/server": { connection: async () => {} }, "@/lib/auth/require-superadmin": guard,
    });
    if (!allowed) await assert.rejects(page.default(), (error) => Boolean(error.destination));
    else assert.match(JSON.stringify(await page.default()), /superadmin@example.invalid/);
  }
});

test("home renders terminal login/denial states without exposing user data or raw error parameters", async () => {
  for (const [options, expected] of [[{ user: null }, "Continue"], [{ profile: null }, "Access denied"]]) {
    const { guard } = fixture(options);
    const page = load("app/page.tsx", {
      "react/jsx-runtime": jsxRuntime, "next/server": { connection: async () => {} }, "next/navigation": { redirect },
      "@/lib/auth/require-superadmin": guard,
      "@/components/app-shell": { AuthShell: "auth-shell" },
      "@/components/google-sign-in": { default: "google-sign-in" },
      "@/components/sign-out-button": { default: "sign-out" },
    });
    const rendered = JSON.stringify(await page.default({ searchParams: Promise.resolve({ auth_error: "untrusted-provider-details" }) }));
    assert.doesNotMatch(rendered, /superadmin@example.invalid|untrusted-provider-details/);
    assert.match(rendered, new RegExp(expected === "Continue" ? "google-sign-in" : expected));
  }
});
