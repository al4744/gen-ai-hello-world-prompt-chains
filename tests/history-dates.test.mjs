import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { root } from "./helpers/execution-core-fixture.mjs";

// Model independent browser/server Intl defaults using real ICU conversions.
// No TZ or other process environment variable is read or modified.
function datesIn(timeZone) {
  const calls = [], testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(join(root, "lib/history/dates.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(module,exports){${code}\n})`, { Intl: {
    DateTimeFormat: function(locale, options) {
      calls.push(options);
      // Supplying timeZone here emulates this realm's native default, not an
      // override passed by the production formatter (which must omit it).
      return new Intl.DateTimeFormat(locale, { ...options, timeZone: options.timeZone ?? timeZone });
    },
  } })(testModule, testModule.exports);
  assert.equal(calls.length, 0, "Import must not cache a server-local formatter");
  return { ...testModule.exports, calls };
}
function component(dates, react = React) {
  const testModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(join(root, "components/history/local-date-time.tsx"), "utf8"), {
    fileName: "local-date-time.tsx", compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`)(name => {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return jsx;
    assert.equal(name, "@/lib/history/dates"); return dates;
  }, testModule, testModule.exports);
  return testModule.exports.default;
}

const timestamp = "2026-11-06T22:00:00.000Z";

test("November 6 at 22:00 UTC displays as 5:00 PM EST for a New York browser", () => {
  const dates = datesIn("America/New_York");
  assert.equal(dates.formatLocalHistoryTime(timestamp), "Nov 6, 2026, 5:00 PM EST");
  assert.ok(dates.calls.every(options => !Object.hasOwn(options, "timeZone")));
  assert.equal(dates.calls[0].timeZoneName, "short");
});

test("summer dates use New York daylight saving time", () => {
  assert.equal(datesIn("America/New_York").formatLocalHistoryTime("2026-07-06T22:00:00Z"), "Jul 6, 2026, 6:00 PM EDT");
});

test("spring DST transition skips the nonexistent local hour", () => {
  const dates = datesIn("America/New_York");
  assert.equal(dates.formatLocalHistoryTime("2026-03-08T06:59:00Z"), "Mar 8, 2026, 1:59 AM EST");
  assert.equal(dates.formatLocalHistoryTime("2026-03-08T07:00:00Z"), "Mar 8, 2026, 3:00 AM EDT");
});

test("fall DST transition distinguishes the repeated local hour by its zone", () => {
  const dates = datesIn("America/New_York");
  assert.equal(dates.formatLocalHistoryTime("2026-11-01T05:59:00Z"), "Nov 1, 2026, 1:59 AM EDT");
  assert.equal(dates.formatLocalHistoryTime("2026-11-01T06:00:00Z"), "Nov 1, 2026, 1:00 AM EST");
});

test("conversion crosses into the previous calendar date", () => {
  assert.equal(datesIn("America/New_York").formatLocalHistoryTime("2026-11-07T02:00:00Z"), "Nov 6, 2026, 9:00 PM EST");
  assert.equal(datesIn("America/Los_Angeles").formatLocalHistoryTime("2026-11-07T01:30:00Z"), "Nov 6, 2026, 5:30 PM PST");
});

test("conversion crosses into the next calendar date with a clear Intl offset", () => {
  assert.equal(datesIn("Asia/Tokyo").formatLocalHistoryTime(timestamp), "Nov 7, 2026, 7:00 AM GMT+9");
});

test("offset-qualified values preserve the same absolute instant", () => {
  const dates = datesIn("America/New_York");
  assert.equal(dates.formatLocalHistoryTime("2026-11-06T17:00:00-05:00"), dates.formatLocalHistoryTime(timestamp));
});

for (const value of [undefined, null, "", "not-a-date", "2026-13-06T22:00:00Z", "2026-02-30T22:00:00Z", "2026-02-29T22:00:00Z", "2026-11-06T22:00:00"]) {
  test(`missing, invalid or timezone-less timestamp is unavailable: ${String(value)}`, () => {
    const dates = datesIn("America/New_York");
    assert.equal(dates.formatLocalHistoryTime(value), "Unavailable"); assert.equal(dates.calls.length, 0);
    const Time = component(dates);
    const html = renderToStaticMarkup(jsx.jsx(Time, { value }));
    assert.match(html, /Unavailable/); assert.doesNotMatch(html, /datetime=/i);
  });
}

test("a real leap day remains valid", () => {
  assert.equal(datesIn("America/New_York").formatLocalHistoryTime("2028-02-29T22:00:00Z"), "Feb 29, 2028, 5:00 PM EST");
});

test("server HTML never formats dates in the server's timezone", () => {
  const outputs = [];
  for (const serverZone of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
    const dates = datesIn(serverZone), Time = component(dates);
    outputs.push(renderToStaticMarkup(jsx.jsx(Time, { value: timestamp, prefix: "Created ", className: "text-muted" })));
    assert.equal(dates.calls.length, 0);
  }
  assert.equal(outputs[0], outputs[1]); assert.equal(outputs[1], outputs[2]);
  assert.match(outputs[0], /Loading local time/); assert.match(outputs[0], /class="text-muted"/);
});

test("hydration starts with identical HTML then formats in the browser, not the server", () => {
  const serverDates = datesIn("Asia/Tokyo"), ServerTime = component(serverDates);
  const props = { value: timestamp, prefix: "Created ", className: "text-muted" };
  const serverHTML = renderToStaticMarkup(jsx.jsx(ServerTime, props));
  const browserDates = datesIn("America/New_York"); let hydrating = true;
  const BrowserTime = component(browserDates, { ...React,
    useSyncExternalStore(_subscribe, clientSnapshot, serverSnapshot) { return hydrating ? serverSnapshot() : clientSnapshot(); },
  });
  assert.equal(renderToStaticMarkup(jsx.jsx(BrowserTime, props)), serverHTML);
  assert.equal(browserDates.calls.length, 0);
  hydrating = false;
  const html = renderToStaticMarkup(jsx.jsx(BrowserTime, props));
  assert.match(html, /Nov 6, 2026, 5:00 PM EST/); assert.doesNotMatch(html, /Loading local time/);
  assert.equal(serverDates.calls.length, 0);
});

test("client navigation and refresh recompute time without changing timestamp attributes", () => {
  const dates = datesIn("America/New_York");
  const react = { ...React, useSyncExternalStore: (_subscribe, clientSnapshot) => clientSnapshot() };
  const Time = component(dates, react);
  const original = "2026-07-06T22:00:00.123456Z";
  assert.equal(Time({ value: original }).props.dateTime, original);
  assert.match(renderToStaticMarkup(jsx.jsx(Time, { value: original })), /6:00 PM EDT/);
  assert.match(renderToStaticMarkup(jsx.jsx(Time, { value: timestamp })), /5:00 PM EST/);
  const Refreshed = component(datesIn("America/New_York"), react);
  assert.equal(renderToStaticMarkup(jsx.jsx(Refreshed, { value: timestamp })), renderToStaticMarkup(jsx.jsx(Time, { value: timestamp })));
});
