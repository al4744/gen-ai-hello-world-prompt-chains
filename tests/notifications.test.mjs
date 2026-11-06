import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";

// Node's EventTarget needs the options-object form when removing capture
// listeners; browsers also support the equivalent boolean form used by the UI.
class BrowserEvents extends EventTarget {
  addEventListener(type, callback, options) {
    super.addEventListener(type, callback, typeof options === "boolean" ? { capture: options } : options);
  }
  removeEventListener(type, callback, options) {
    super.removeEventListener(type, callback, typeof options === "boolean" ? { capture: options } : options);
  }
}

// Exercise the real notice at the browser/router boundary, using the same
// isolated-module approach as the existing tests. No database or network.
function fixture(href = "https://example.test/chains/chain?step_deleted=1", message = "Step deleted. Remaining positions updated.") {
  let dismissed = null, navigation = "first", setup;
  const replacements = [];
  const document = new BrowserEvents();
  const window = Object.assign(new BrowserEvents(), {
    location: { href },
    history: { replaceState(data, title, path) {
      replacements.push({ data, title, path });
      window.location.href = new URL(path, window.location.href).href;
    } },
  });
  const react = {
    createContext: defaultValue => ({ Provider: "notice-provider", defaultValue }),
    useContext: context => context.defaultValue,
    useState: () => [dismissed, value => { dismissed = value; }],
    useCallback: callback => callback,
    useEffect: effect => { setup = effect; },
  };
  const imports = { react, "react/jsx-runtime": jsx, "next/navigation": { useRouter: () => ({ bfcacheId: navigation }) } };
  const { outputText } = ts.transpileModule(readFileSync(new URL("../components/chains/chain-success-notice.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  });
  const testModule = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${outputText}\n})`, { URL, window, document })(name => {
    assert.ok(Object.hasOwn(imports, name), name);
    return imports[name];
  }, testModule, testModule.exports);
  const children = jsx.jsx("div", { children: "Stored steps and their independent feedback" });
  return {
    window, document, replacements, children,
    render: (nextMessage = message) => testModule.exports.default({ message: nextMessage, children }),
    mount: () => setup(),
    navigate: id => { navigation = id; },
    defaultDismiss: testModule.exports.useDismissChainSuccess(),
  };
}

const notice = tree => tree.props.children[0];

for (const [flag, message] of [
  ["created", "Prompt chain created."], ["updated", "Changes saved."],
  ["step_created", "Step added."], ["step_updated", "Step changes saved."],
  ["step_deleted", "Step deleted. Remaining positions updated."],
]) {
  test(`${flag} confirmation is visible once, and its consumed URL cannot replay it on refresh`, () => {
    const f = fixture(`https://example.test/chains/chain?${flag}=1`, message);
    assert.equal(notice(f.render()).props.children, message);
    const cleanup = f.mount();
    assert.equal(f.window.location.href, "https://example.test/chains/chain");
    assert.equal(notice(f.render()).props.children, message); // URL cleanup retains useful feedback.
    const refreshed = fixture(f.window.location.href, null);
    assert.equal(notice(refreshed.render()), null);
    cleanup();
  });
}

test("URL consumption removes all duplicate success flags, preserving unrelated params, pathname and step anchor", () => {
  const f = fixture("https://example.test/chains/chain?view=full&step_deleted=1&step_deleted=1&created=1&updated=1&step_created=1&step_updated=1#step-stable-id");
  f.render(); const cleanup = f.mount();
  assert.equal(f.replacements.length, 1);
  assert.equal(f.replacements[0].path, "/chains/chain?view=full#step-stable-id");
  cleanup();
});

test("clean URL and missing success do not replace history or show a stale notice", () => {
  const f = fixture("https://example.test/chains/chain?view=full#step-id", null);
  assert.equal(notice(f.render()), null);
  assert.equal(f.mount(), undefined);
  assert.equal(f.replacements.length, 0);
});

test("mouse/touch pointerdown retains layout until click; keyboard click clears only the redirect notice", () => {
  const f = fixture();
  f.render(); const cleanup = f.mount();
  f.document.dispatchEvent(new Event("pointerdown"));
  assert.ok(notice(f.render()));
  let actionCalls = 0;
  f.document.addEventListener("click", () => actionCalls++);
  const click = new Event("click", { cancelable: true });
  f.document.dispatchEvent(click);
  const tree = f.render();
  assert.equal(notice(tree), false);
  assert.equal(tree.props.children[1], f.children);
  assert.equal(actionCalls, 1);
  assert.equal(click.defaultPrevented, false);
  cleanup();
});

test("a reorder dismisses previous success without resetting children, and revalidation cannot resurrect it", () => {
  const f = fixture();
  const tree = f.render(); const cleanup = f.mount();
  tree.props.value(); // Same callback supplied to the real step list through context.
  assert.equal(notice(f.render()), false);
  assert.equal(f.render().props.children[1], f.children);
  assert.equal(notice(f.render()), false); // Same props after server revalidation.
  cleanup();
});

test("a fresh redirect to the same chain shows new feedback, including the same operation again", () => {
  const f = fixture();
  f.render().props.value();
  assert.equal(notice(f.render()), false);
  f.navigate("new-redirect");
  assert.ok(notice(f.render()));
  assert.equal(notice(f.render("Step added.")).props.children, "Step added.");
});

for (const event of ["popstate", "pagehide"]) {
  test(`${event} clears feedback before history restoration`, () => {
    const f = fixture();
    f.render(); const cleanup = f.mount();
    f.window.dispatchEvent(new Event(event));
    assert.equal(notice(f.render()), false);
    cleanup();
  });
}

test("Strict Mode effect restart neither loses initial feedback nor repeats URL consumption", () => {
  const f = fixture();
  f.render(); f.mount()();
  const cleanup = f.mount();
  assert.ok(notice(f.render()));
  assert.equal(f.replacements.length, 1);
  cleanup();
  f.document.dispatchEvent(new Event("click"));
  f.window.dispatchEvent(new Event("popstate"));
  assert.ok(notice(f.render())); // Removed listeners do not affect hidden pages.
  assert.doesNotThrow(() => f.defaultDismiss()); // Standalone read-only/fixture use is safe.
});
