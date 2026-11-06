import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const { outputText } = ts.transpileModule(
  readFileSync(new URL("../lib/theme.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
);
const storageKey = "caption-arena-prompt-chains-theme";

function browser(saved = null, blocked = false) {
  const attributes = new Map([["data-theme", "dark"]]);
  const storage = new Map(saved === null ? [] : [[storageKey, saved]]);
  const window = new EventTarget();
  const context = vm.createContext({
    exports: {}, window, Event,
    document: { documentElement: {
      getAttribute: (key) => attributes.get(key) ?? null,
      setAttribute: (key, value) => attributes.set(key, value),
    } },
    localStorage: {
      getItem(key) {
        if (blocked) throw new Error("Storage blocked");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (blocked) throw new Error("Storage blocked");
        storage.set(key, value);
      },
    },
  });
  vm.runInContext(outputText, context);
  const theme = context.exports;
  return {
    theme, storage,
    initialize: () => vm.runInContext(theme.themeInitScript, context),
    storageEvent(key, newValue) {
      const event = new Event("storage");
      Object.assign(event, { key, newValue });
      window.dispatchEvent(event);
    },
  };
}

test("head initialization restores valid preferences and defaults safely to dark", () => {
  for (const [saved, expected] of [
    [null, "dark"], ["dark", "dark"], ["light", "light"], ["system", "system"],
    ["invalid", "dark"], ["<script>alert(1)</script>", "dark"],
  ]) {
    const page = browser(saved);
    page.initialize();
    assert.equal(page.theme.getTheme(), expected);
    assert.equal(page.theme.getServerTheme(), "dark");
  }
});

test("blocked storage leaves a usable default and supports unsaved theme changes", () => {
  const page = browser("light", true);
  assert.doesNotThrow(page.initialize);
  assert.equal(page.theme.getTheme(), "dark");
  assert.equal(page.theme.setTheme("light"), false);
  assert.equal(page.theme.getTheme(), "light");
});

test("selection updates subscribers, persists only the theme, and survives refresh", () => {
  const page = browser();
  let notifications = 0;
  const unsubscribe = page.theme.subscribeTheme(() => notifications++);
  for (const selected of ["light", "system", "dark"]) {
    assert.equal(page.theme.setTheme(selected), true);
    assert.equal(page.theme.getTheme(), selected);
    assert.equal(page.storage.get(storageKey), selected);
    const refreshed = browser(page.storage.get(storageKey));
    refreshed.initialize();
    assert.equal(refreshed.theme.getTheme(), selected);
  }
  assert.equal(page.storage.size, 1);
  assert.equal(notifications, 3);
  unsubscribe();
  page.theme.setTheme("light");
  assert.equal(notifications, 3);
});

test("other-tab theme changes synchronize without reacting to unrelated keys", () => {
  const page = browser();
  let notifications = 0;
  const unsubscribe = page.theme.subscribeTheme(() => notifications++);
  page.storageEvent("unrelated-preference", "light");
  assert.equal(page.theme.getTheme(), "dark");
  assert.equal(notifications, 0);
  for (const [key, value, expected] of [
    [storageKey, "light", "light"], [storageKey, "system", "system"],
    [storageKey, "invalid", "dark"], [storageKey, null, "dark"], [null, null, "dark"],
  ]) {
    page.storageEvent(key, value);
    assert.equal(page.theme.getTheme(), expected);
  }
  assert.equal(notifications, 5);
  unsubscribe();
  page.storageEvent(storageKey, "light");
  assert.equal(notifications, 5);
  assert.equal(page.theme.getTheme(), "dark");
});
