// Run only as a fresh child, never import the preconfigured renderer test file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

assert.equal(process.env.FONTCONFIG_FILE, undefined);
assert.equal(process.env.FONTCONFIG_PATH, undefined);
assert.equal(process.env.PROMPT_CHAIN_GENERATION_ENABLED, undefined);
const mode = process.argv[2];
assert.ok(["renderer-before-image", "image-before-renderer"].includes(mode));

let networkCalls = 0;
const noNetwork = () => { networkCalls++; throw new Error("Network is forbidden in the renderer cold-start test"); };
globalThis.fetch = noNetwork;
http.request = http.get = https.request = https.get = noNetwork;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = noNetwork;

// This imports Sharp before loading any application module, just as the engine
// can use Sharp for input generation/validation before it invokes the renderer.
const { loadExecution, root, image } = await import("./execution-core-fixture.mjs");
const { default: sharp } = await import("sharp");
const expectedConfig = join(root, "lib/execution/fonts/fonts.conf");
const expectedFont = join(root, "lib/execution/fonts/NotoSans-Regular.ttf");
const config = await readFile(expectedConfig, "utf8");
assert.equal((config.match(/<dir\b/g) ?? []).length, 1);
assert.match(config, /<dir prefix="relative">\.<\/dir>/);
assert.doesNotMatch(config, /<include\b|<\/?selectfont\b|<!DOCTYPE/);

let configured = 0, textOperations = 0;
const realSharp = (...args) => {
  if (args[0]?.text) {
    textOperations++;
    assert.equal(configured, 1, "Renderer must initialize Fontconfig before its first native text operation");
    assert.equal(process.env.FONTCONFIG_FILE, expectedConfig);
    assert.equal(process.env.FONTCONFIG_PATH, undefined);
    assert.equal(args[0].text.fontfile, expectedFont);
    assert.match(args[0].text.font, /^Noto Sans /);
    assert.match(args[0].text.text, /fallback="false"/);
  }
  return sharp(...args); // Actual native Sharp/Pango; no rendering mock.
};
const load = loadExecution({ sharp: realSharp }, {}, (key, value) => {
  assert.equal(key, "FONTCONFIG_FILE");
  assert.equal(value, expectedConfig);
  assert.equal(process.env.FONTCONFIG_FILE, undefined);
  configured++;
  // Forward the real renderer's side effect through the existing VM loader.
  // There is no external preconfiguration and no access to any credential.
  process.env.FONTCONFIG_FILE = value;
});
const { validateImage } = load("lib/execution/images.ts");
let renderer;
if (mode === "renderer-before-image") renderer = load("lib/execution/renderer.ts").createCaptionRenderer();
const input = await validateImage(await image("png", 320, 160));
// An additional non-text transformation exercises initialized native pipelines.
await sharp(input.bytes).resize(160, 80).webp().toBuffer();
assert.equal(process.env.FONTCONFIG_FILE, undefined);
assert.equal(process.env.FONTCONFIG_PATH, undefined);
if (mode === "image-before-renderer") renderer = load("lib/execution/renderer.ts").createCaptionRenderer();

const bytes = await renderer.render({ image: input, mode: "sequential",
  finalText: "Café, déjà vu — naïve & “quoted” punctuation!", signal: new AbortController().signal });
const result = await validateImage(bytes, { mime: "image/png" });
assert.equal(result.width, 1200);
assert.ok(result.height <= 3200);
assert.ok(bytes.length <= 5242880);
assert.equal(configured, 1);
assert.ok(textOperations >= 3);
assert.equal(process.env.FONTCONFIG_FILE, expectedConfig);
assert.equal(process.env.FONTCONFIG_PATH, undefined);
assert.equal(process.env.PROMPT_CHAIN_GENERATION_ENABLED, undefined);

const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
// A 320x160 input fits at 1104x552, starting at y=100. Count only body text
// below the photo, panel gap and label, excluding masthead, photo and borders.
let visibleCaptionPixels = 0, visibleCaptionRows = 0;
for (let y = 750; y < info.height - 48; y++) {
  let visible = false;
  for (let x = 80; x < 1120; x++) {
    const offset = (y * info.width + x) * 3;
    if (data[offset] < 80 && data[offset + 1] < 80 && data[offset + 2] < 80) {
      visibleCaptionPixels++; visible = true;
    }
  }
  if (visible) visibleCaptionRows++;
}
assert.ok(visibleCaptionPixels > 300, "Caption body must contain visible ink");
assert.ok(visibleCaptionRows >= 15);
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ mode, width: result.width, configuredBundledFont: true, visibleCaptionPixels, networkCalls }));
