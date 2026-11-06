import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { completion, executionFixture, hash, image, jsonResponse, loadExecution, plain, root } from "./helpers/execution-core-fixture.mjs";

// Most in-process tests use this native Fontconfig setup because VM writes are
// virtualized. The fresh-process tests below explicitly inherit none of it.
// This selects bundled fonts only. No generation flag or credential is set.
process.env.FONTCONFIG_FILE = join(root, "lib/execution/fonts/fonts.conf");
const load = loadExecution();
const { captionPanels, createCaptionRenderer, escapeCaption } = load("lib/execution/renderer.ts");
const { validateImage } = load("lib/execution/images.ts");
const signal = () => new AbortController().signal;
const rawDefault = ' { "caption_a": "A small moment. A big adventure.", "caption_b": "Taking the scenic route home." }\n';
const five = '1. The meeting could have been a nap.\n2. Professional overthinker.\n3. One more coffee should do it.\n4. Deadline? I thought you said lifeline.\n5. Running on snacks and optimism.';
const safe = value => assert.doesNotMatch(JSON.stringify(value), /SECRET|synthetic-test-credential|lease_token|authorization|stack/i);
const render = async (text = five, mode = "sequential", width = 320, height = 240) => createCaptionRenderer().render({
  image: await validateImage(await image("png", width, height)), finalText: text, mode, signal: signal(),
});

for (const mode of ["renderer-before-image", "image-before-renderer"]) {
  test(`fresh Node renderer initializes bundled Fontconfig itself: ${mode}`, { timeout: 20000 }, async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      [join(root, "tests/helpers/renderer-cold-start.mjs"), mode], {
        cwd: root, env: {}, timeout: 15000, maxBuffer: 65536,
      });
    // Empty environment removes FONTCONFIG_FILE/PATH, inherited flags, secrets,
    // and NODE_OPTIONS. Native Fontconfig state cannot cross a process boundary.
    assert.equal(stderr, "");
    const result = JSON.parse(stdout);
    assert.equal(result.mode, mode);
    assert.equal(result.width, 1200);
    assert.equal(result.configuredBundledFont, true);
    assert.ok(result.visibleCaptionPixels > 300);
    assert.equal(result.networkCalls, 0);
  });
}

test("default captions become two separate alternatives; the raw JSON remains intact", () => {
  const panels = plain(captionPanels("composed", rawDefault));
  assert.deepEqual(panels, [{ label: "CAPTION A", text: "A small moment. A big adventure." },
    { label: "CAPTION B", text: "Taking the scenic route home." }]);
  assert.equal(rawDefault.startsWith(' { "caption_a"'), true);
});

test("custom five-caption output preserves numbering and does not require JSON", () => {
  const panels = plain(captionPanels("sequential", five));
  assert.equal(panels.length, 5); assert.equal(panels[0].label, "OUTPUT 1");
  assert.equal(panels[4].text, "5. Running on snacks and optimism.");
});

test("display normalization is explicit: CRLF, tabs, blank lines, edge whitespace and NFC", () => {
  assert.deepEqual(plain(captionPanels("sequential", '  Cafe\u0301\t"hello"  \r\n\r\nsecond line\rthird line')),
    [{ label: "OUTPUT 1", text: 'Café    "hello"' }, { label: "OUTPUT 2", text: "second line" }, { label: "OUTPUT 3", text: "third line" }]);
  assert.equal(captionPanels("sequential", '{"arbitrary":"JSON stays literal"}')[0].text, '{"arbitrary":"JSON stays literal"}');
});

test("model strings are escaped as literal text, not SVG, Pango tags or resource references", () => {
  assert.equal(escapeCaption('<span foreground="red">A&B\'s</span>'), '&lt;span foreground=&quot;red&quot;&gt;A&amp;B&apos;s&lt;/span&gt;');
  assert.equal(captionPanels("sequential", '<svg><image href="https://attacker.invalid/SECRET"/></svg>')[0].text,
    '<svg><image href="https://attacker.invalid/SECRET"/></svg>');
});

for (const [shape, width, height] of [["portrait", 180, 320], ["landscape", 360, 180], ["square", 240, 240]]) {
  test(`real ${shape} rendering is a new, bounded PNG with undistorted image and visible caption panels`, async () => {
    const bytes = await render(rawDefault, "composed", width, height);
    const result = await validateImage(bytes, { mime: "image/png" }, signal());
    assert.equal(result.width, 1200); assert.ok(result.height <= 3200); assert.ok(bytes.length < 5242881);
    const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    // Input fixture is uniformly RGB(20,40,60); find the rendered image extent.
    let left = 1200, right = 0, bottom = 100;
    for (let y = 100; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const [r, g, b] = at(x, y);
      if (r === 20 && g === 40 && b === 60) { left = Math.min(left, x); right = Math.max(right, x); bottom = Math.max(bottom, y); }
    }
    const photoWidth = right - left + 1, photoHeight = bottom - 100 + 1;
    assert.ok(Math.abs(photoWidth / photoHeight - width / height) < 0.01);
    assert.ok(left >= 48 && right < 1152); assert.ok(bottom < info.height - 100);
    // Both panels contribute real dark text below the photo.
    let inkRows = 0;
    for (let y = bottom + 32; y < info.height - 48; y++) {
      let ink = false;
      for (let x = 80; x < 1120; x++) {
        const [r, g, b] = at(x, y);
        if (r < 100 && g < 100 && b < 110) { ink = true; break; }
      }
      if (ink) inkRows++;
    }
    assert.ok(inkRows > 60); assert.notEqual(hash(bytes), hash(await image("png", width, height)));
  });
}

test("five-caption custom output and common Unicode decode as readable-sized PNGs", async () => {
  for (const text of [five, 'Café, déjà vu — “naïve” & piñata.\nΕλληνικά και Ωμέγα.\nПривет мир.\nCafe\u0301: £ € © ™ …']) {
    const result = await validateImage(await render(text), { mime: "image/png" });
    assert.equal(result.width, 1200); assert.ok(result.height < 3201);
  }
});

test("long words wrap rather than escape the canvas", async () => {
  const result = await validateImage(await render("Supercalifragilisticexpialidocious".repeat(6)), { mime: "image/png" });
  assert.equal(result.width, 1200); assert.ok(result.height < 3201);
});

for (const format of ["jpeg", "webp"]) test(`validated ${format} input renders a real PNG`, async () => {
  const input = await validateImage(await image(format, 240, 160));
  const bytes = await createCaptionRenderer().render({ image: input, finalText: "A clear caption.", mode: "sequential", signal: signal() });
  assert.equal((await validateImage(bytes, { mime: "image/png" })).width, 1200);
});

test("EXIF orientation is applied without cropping or distorting the photo", async () => {
  const bytes = await sharp(await image("jpeg", 360, 180)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const input = await validateImage(bytes);
  const output = await createCaptionRenderer().render({ image: input, finalText: "Portrait after orientation.", mode: "sequential", signal: signal() });
  const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
  assert.ok(info.height > 1200);
  assert.ok(pixel(600, 1090)[0] < 30); // Photo is 500x1000 after rotation.
  assert.ok(pixel(300, 600)[0] > 220); // Centred side margin, not stretched to full width.
  assert.equal((await sharp(output).metadata()).orientation, undefined);
});

test("hostile markup is painted literally without executing or fetching resources", async () => {
  const bytes = await render('<span size="999999999" foreground="red">Literal & safe</span>\n<svg><image href="https://attacker.invalid/SECRET"/></svg>');
  assert.equal((await sharp(bytes).metadata()).format, "png");
});

for (const [name, text, mode] of [
  ["empty", "  ", "sequential"], ["too many panels", Array(13).fill("caption").join("\n"), "sequential"],
  ["too many characters", "x".repeat(6001), "sequential"], ["too large provider output", "x".repeat(32769), "sequential"],
  ["unsupported glyphs", "A caption 😀 中文", "sequential"], ["invisible control", "caption\u0001", "sequential"],
  ["bidi override", "safe\u202esecret", "sequential"], ["combining complexity", "a" + "\u0301".repeat(40), "sequential"],
  ["bad default JSON", '{"caption_a":"one","caption_b":"two","extra":true}', "composed"],
]) test(`unrenderable ${name} fails with sanitized artifact error, without truncation`, async () => {
  await assert.rejects(render(text, mode), error => { assert.equal(error.code, "artifact_error"); safe(error.message); return true; });
});

test("legibility and overall canvas limits reject text that cannot fit", async () => {
  for (const text of ["Long paragraph with readable words. ".repeat(160), Array(12).fill("wrapped readable caption ".repeat(10)).join("\n")]) {
    await assert.rejects(render(text), error => error.code === "artifact_error");
  }
});

test("corrupt image/native rendering failure and cancellation never return a placeholder", async () => {
  const validated = await validateImage(await image());
  await assert.rejects(createCaptionRenderer().render({ image: { ...validated, bytes: Buffer.from("SECRET broken image") },
    finalText: "caption", mode: "sequential", signal: signal() }), error => error.code === "artifact_error");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createCaptionRenderer().render({ image: validated, finalText: "caption", mode: "sequential", signal: controller.signal }), error => error.code === "cancelled");
});

test("bundled font matches its coverage manifest and has its redistribution license", async () => {
  const font = await readFile(join(root, "lib/execution/fonts/NotoSans-Regular.ttf"));
  assert.equal(hash(font), load("lib/execution/fonts/coverage.ts").FONT_SHA256);
  assert.match(await readFile(join(root, "lib/execution/fonts/OFL.txt"), "utf8"), /SIL OPEN FONT LICENSE/);
});

for (const mode of ["composed", "sequential"]) test(`real renderer integrates with ${mode} execution; exact output persists and duplicate never replays`, async () => {
  const f = await executionFixture({ mode }), raw = mode === "composed" ? rawDefault : five;
  f.reply = async () => jsonResponse(completion(raw));
  const engine = f.engine({ renderer: createCaptionRenderer() });
  const result = await engine.execute(f.runId);
  assert.equal(result.status, "succeeded"); safe(result);
  assert.equal(f.row.final_text, raw); assert.equal(f.steps.at(-1).output_text, raw);
  assert.equal(f.requests.length, mode === "composed" ? 1 : 3);
  const artifact = f.objects.get(f.row.artifact_path).bytes;
  assert.equal((await validateImage(artifact, { mime: "image/png" })).width, 1200);
  assert.equal(f.row.artifact_sha256, hash(artifact)); assert.equal(f.row.artifact_size_bytes, artifact.length);
  assert.equal(f.calls.filter(call => call.operation === "finalize").length, 1);
  const calls = f.requests.length;
  assert.equal((await engine.execute(f.runId)).status, "succeeded");
  assert.equal(f.requests.length, calls); assert.equal(f.uploads.length, 1);
});

for (const failure of ["upload", "artifact validation", "renderer"]) test(`real execution ${failure} failure preserves text and prevents finalization`, async () => {
  const f = await executionFixture({ count: 1 });
  let renderer = createCaptionRenderer();
  if (failure === "upload") f.uploadFailure = true;
  if (failure === "artifact validation") renderer = { render: async () => Buffer.from("SECRET invalid artifact") };
  if (failure === "renderer") f.reply = async () => jsonResponse(completion("Too much text ".repeat(500)));
  const result = await f.engine({ renderer }).execute(f.runId);
  assert.equal(result.status, "failed"); assert.equal(result.error.code, "artifact_error"); safe(result);
  assert.ok(f.row.final_text); assert.equal(f.steps[0].status, "succeeded");
  assert.equal(f.calls.some(call => call.operation === "finalize"), false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.uploads.length, failure === "upload" ? 1 : 0);
});

test("encoded output exceeding the exact five-megabyte cap fails instead of returning oversized PNG", async () => {
  const wrappedSharp = (...args) => {
    const operation = sharp(...args);
    if (Buffer.isBuffer(args[0]) && args[0].toString("utf8", 0, 4) === "<svg") {
      operation.toBuffer = async () => Buffer.alloc(5242881);
    }
    return operation;
  };
  const renderer = loadExecution({ sharp: wrappedSharp })("lib/execution/renderer.ts").createCaptionRenderer();
  await assert.rejects(renderer.render({ image: await validateImage(await image()), finalText: "caption", mode: "sequential", signal: signal() }),
    error => error.code === "artifact_error");
});

test("enabled endpoint executes the existing mock-backed engine with the production renderer", async () => {
  const f = await executionFixture({ count: 3 }); f.reply = async () => jsonResponse(completion(five));
  const engine = f.engine({ renderer: createCaptionRenderer() });
  let authorized = 0;
  const authorize = async () => { authorized++; return { supabase: f.client, user: { id: f.userId } }; };
  const modules = loadExecution({
    "@/lib/auth/require-superadmin": { requireSuperadmin: authorize, AuthorizationError: class extends Error {} },
    "@/lib/execution": { createServerExecutionEngine: () => engine },
  }, { PROMPT_CHAIN_GENERATION_ENABLED: "true" });
  const handlers = modules("lib/generation/handlers.ts").createGenerationHandlers();
  const request = () => new Request("https://chains.example.test/api/generation/runs/run/execute", {
    method: "POST", headers: { origin: "https://chains.example.test", "content-type": "application/json" }, body: "{}" });
  const response = await handlers.execute(request(), f.runId);
  assert.equal(response.status, 200); assert.equal(authorized, 1);
  const dto = await response.json(); assert.equal(dto.status, "succeeded"); safe(dto);
  assert.equal(f.row.final_text, five); assert.equal(f.requests.length, 3); assert.equal(f.uploads.length, 1);
  assert.equal((await handlers.execute(request(), f.runId)).status, 200);
  assert.equal(f.requests.length, 3); assert.equal(f.uploads.length, 1);
});
