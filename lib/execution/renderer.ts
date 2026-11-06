import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import sharp, { type Sharp, type OverlayOptions } from "sharp";
import { validateOutput } from "./contracts";
import { ExecutionFault } from "./errors";
import { FONT_RANGES, FONT_SHA256 } from "./fonts/coverage";
import { LIMITS, type ArtifactRenderer, type RunPlan } from "./types";

const WIDTH = 1200, MARGIN = 48, INNER = WIDTH - 2 * MARGIN;
const TEXT_WIDTH = INNER - 64, TEXT_HEIGHT = 750, MAX_HEIGHT = 3200;
const PAPER = "#fafafa", PANEL = "#f0f1f3", INK = "#17191d", MUTED = "#585e68";

/** Pango markup is XML: model text never becomes markup or an SVG resource. */
export function escapeCaption(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

/** Display normalization only. The caller's raw finalText is never mutated. */
export function captionPanels(mode: RunPlan["mode"], finalText: string) {
  if ((mode !== "composed" && mode !== "sequential") || !validateOutput(mode, finalText)) throw new ExecutionFault("artifact_error");
  const normalize = (value: string) => value.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").normalize("NFC").trim();
  const raw: string[] = mode === "composed"
    ? (() => { const captions = JSON.parse(finalText); return [captions.caption_a, captions.caption_b]; })()
    : finalText.split(/\r\n?|\n/).filter(line => line.trim().length > 0);
  if (!raw.length || raw.length > 12) throw new ExecutionFault("artifact_error");
  let characters = 0;
  return raw.map((value, i) => {
    const content = normalize(value);
    characters += Array.from(content).length;
    if (!content || characters > 6000 || content.split("\n").length > 24
        || /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(content)) throw new ExecutionFault("artifact_error");
    for (const char of content) {
      const point = char.codePointAt(0)!;
      if (char !== "\n" && !FONT_RANGES.some(([start, end]) => point >= start && point <= end)) throw new ExecutionFault("artifact_error");
    }
    for (const part of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(content)) {
      if (Array.from(part.segment).length > 16) throw new ExecutionFault("artifact_error");
    }
    return { label: mode === "composed" ? `CAPTION ${i === 0 ? "A" : "B"}` : `OUTPUT ${i + 1}`, text: content };
  });
}

let fontReady: Promise<string> | undefined;
function bundledFont() {
  if (!fontReady) fontReady = (async () => {
    const directory = join(process.cwd(), "lib/execution/fonts");
    const file = join(directory, "NotoSans-Regular.ttf");
    if (createHash("sha256").update(await readFile(file)).digest("hex") !== FONT_SHA256) throw new ExecutionFault("artifact_error");
    // Pango's Fontconfig is process-global. Pin discovery to this app's trusted
    // bundle before the first text operation; never read host/user fonts.
    // This changes no environment file and contains no user-supplied path.
    process.env.FONTCONFIG_FILE = join(directory, "fonts.conf");
    return file;
  })();
  return fontReady;
}

export function createCaptionRenderer(): ArtifactRenderer {
  return { async render({ image, finalText, mode, signal }) {
    const started = performance.now(), active = new Set<Sharp>();
    const check = () => {
      if (signal.aborted) throw new ExecutionFault("cancelled");
      if (performance.now() - started >= 4500) throw new ExecutionFault("artifact_error");
    };
    const abort = () => { for (const operation of active) operation.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    async function raster(operation: Sharp) {
      check(); active.add(operation);
      try {
        const result = await operation.timeout({ seconds: 2 }).raw().toBuffer({ resolveWithObject: true });
        check(); return result;
      } finally { active.delete(operation); operation.destroy(); }
    }
    try {
      check();
      const panels = captionPanels(mode, finalText), fontfile = await bundledFont();
      if (!(image.bytes instanceof Uint8Array) || image.bytes.byteLength < 1 || image.bytes.byteLength > LIMITS.imageBytes
          || !["image/jpeg", "image/png", "image/webp"].includes(image.mime)
          || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
          || image.width < 1 || image.height < 1 || image.width > LIMITS.dimension || image.height > LIMITS.dimension
          || image.width * image.height > LIMITS.pixels) throw new ExecutionFault("artifact_error");
      const photo = await raster(sharp(image.bytes, { failOn: "warning", limitInputPixels: LIMITS.pixels, sequentialRead: true })
        .rotate().resize(INNER, 1000, { fit: "inside" }).flatten({ background: PANEL }).toColourspace("srgb").ensureAlpha());
      async function lettering(content: string, size: number, colour: string, maximum: number, preflight = false) {
        const text = `<span fallback="false" foreground="${colour}">${escapeCaption(content)}</span>`;
        const options = { text, font: `Noto Sans ${size}`, fontfile, width: TEXT_WIDTH, rgba: true,
          wrap: "word-char" as const, spacing: 8 };
        if (preflight) {
          // Height auto-fit bounds native allocation. Reject shrink-to-fit below
          // the chosen readable size; then rasterize at exactly that fixed size.
          const fitted = await raster(sharp({ text: { ...options, height: maximum } }));
          if (!fitted.info.textAutofitDpi || fitted.info.textAutofitDpi < 72) throw new ExecutionFault("artifact_error");
        }
        const result = await raster(sharp({ text: { ...options, dpi: 72 } }));
        if (result.info.width > TEXT_WIDTH || result.info.height > maximum) throw new ExecutionFault("artifact_error");
        return result;
      }
      const overlays: OverlayOptions[] = [], backgrounds: string[] = [];
      function place(result: Awaited<ReturnType<typeof raster>>, left: number, top: number) {
        overlays.push({ input: result.data, raw: { width: result.info.width, height: result.info.height, channels: result.info.channels }, left, top });
      }
      place(await lettering("CAPTION ARENA", 18, MUTED, 36), MARGIN, MARGIN);
      const imageTop = 100;
      backgrounds.push(`<rect x="${MARGIN}" y="${imageTop}" width="${INNER}" height="${photo.info.height}" rx="16" fill="${PANEL}"/>`);
      place(photo, MARGIN + Math.floor((INNER - photo.info.width) / 2), imageTop);
      let y = imageTop + photo.info.height + 32;
      for (const panel of panels) {
        const label = await lettering(panel.label, 16, MUTED, 32);
        const body = await lettering(panel.text, 30, INK, TEXT_HEIGHT, true);
        const height = 32 + label.info.height + 16 + body.info.height + 32;
        if (y + height + MARGIN > MAX_HEIGHT) throw new ExecutionFault("artifact_error");
        backgrounds.push(`<rect x="${MARGIN}" y="${y}" width="${INNER}" height="${height}" rx="16" fill="${PANEL}" stroke="#e0e2e6"/>`);
        place(label, MARGIN + 32, y + 32);
        place(body, MARGIN + 32, y + 32 + label.info.height + 16);
        y += height + 20;
      }
      const height = y - 20 + MARGIN;
      // SVG contains fixed geometry/colours only. No model text, URLs, fonts,
      // entities, images or foreignObject can be inserted into this SVG.
      const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}"><rect width="100%" height="100%" fill="${PAPER}"/>${backgrounds.join("")}</svg>`);
      const output = sharp(background, { limitInputPixels: WIDTH * MAX_HEIGHT }).composite(overlays).png({ compressionLevel: 9, adaptiveFiltering: true });
      check(); active.add(output);
      try {
        const bytes = await output.timeout({ seconds: 2 }).toBuffer();
        check();
        if (bytes.length > LIMITS.imageBytes) throw new ExecutionFault("artifact_error");
        return bytes;
      } finally { active.delete(output); output.destroy(); }
    } catch {
      throw new ExecutionFault(signal.aborted ? "cancelled" : "artifact_error");
    } finally { signal.removeEventListener("abort", abort); abort(); }
  } };
}
