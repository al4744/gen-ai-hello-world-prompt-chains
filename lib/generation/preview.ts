"use client";
import { imageError } from "./workflow";

function decode(url: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    const finish = (error?: Error) => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      image.onload = null; image.onerror = null;
      if (error) { image.src = ""; reject(error); } else resolve();
    };
    const abort = () => finish(new Error("Cancelled"));
    const timer = setTimeout(() => finish(new Error("Preview timeout")), 10000);
    image.onload = () => finish(image.naturalWidth < 1 || image.naturalHeight < 1 || image.naturalWidth > 8192
      || image.naturalHeight > 8192 || image.naturalWidth * image.naturalHeight > 20000000 ? new Error("Image dimensions") : undefined);
    image.onerror = () => finish(new Error("Image decode"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else image.src = url;
  });
}

/** Caller owns a successful URL; rejected or cancelled previews are revoked here. */
export async function createImagePreview(file: File, signal: AbortSignal, dependencies = { urls: URL, decode }) {
  const invalid = imageError(file);
  if (invalid) throw new Error(invalid);
  if (signal.aborted) throw new Error("Image selection was cancelled.");
  let url: string | undefined;
  try {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const matches = file.type === "image/png" ? bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
      : file.type === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!matches || signal.aborted) throw new Error("Invalid image");
    url = dependencies.urls.createObjectURL(file);
    await dependencies.decode(url, signal);
    if (signal.aborted) throw new Error("Cancelled");
    return url;
  } catch {
    if (url) dependencies.urls.revokeObjectURL(url);
    throw new Error("This image could not be previewed. Choose a valid JPEG, PNG, or WebP within the image limits.");
  }
}
