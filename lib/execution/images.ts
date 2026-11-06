import "server-only";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ExecutionFault } from "./errors";
import { LIMITS, type ImageMime, type ValidatedImage } from "./types";

function signature(bytes: Buffer): ImageMime | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF"
      && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) === bytes.length - 8) return "image/webp";
  return null;
}

export async function validateImage(input: Uint8Array, expected?: { mime: ImageMime; size?: number; sha256?: string },
  signal?: AbortSignal): Promise<ValidatedImage> {
  if (signal?.aborted) throw new ExecutionFault("cancelled");
  if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > LIMITS.imageBytes) throw new ExecutionFault("input_invalid");
  const bytes = Buffer.from(input); // Own the bytes; callers cannot change the checked hash later.
  const mime = signature(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (!mime || (expected && (expected.mime !== mime || (expected.size !== undefined && expected.size !== bytes.length)
      || (expected.sha256 !== undefined && expected.sha256 !== sha256)))) throw new ExecutionFault("input_invalid");
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: LIMITS.pixels, sequentialRead: true }).timeout({ seconds: 2 });
  const abort = () => decoder.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const metadata = await decoder.metadata();
    if (metadata.format !== mime.slice(6) || !metadata.width || !metadata.height
        || metadata.width > LIMITS.dimension || metadata.height > LIMITS.dimension
        || metadata.width * metadata.height > LIMITS.pixels || (metadata.pages ?? 1) !== 1) throw new ExecutionFault("input_invalid");
    // metadata() alone accepts some truncated files. Force a complete bounded
    // decode, without changing or re-encoding the original provider input.
    await decoder.raw().toBuffer();
    if (signal?.aborted) throw new ExecutionFault("cancelled");
    return { bytes, mime, size: bytes.length, sha256, width: metadata.width, height: metadata.height };
  } catch (error) {
    if (signal?.aborted) throw new ExecutionFault("cancelled");
    throw error instanceof ExecutionFault ? error : new ExecutionFault("input_invalid");
  } finally { signal?.removeEventListener("abort", abort); decoder.destroy(); }
}
