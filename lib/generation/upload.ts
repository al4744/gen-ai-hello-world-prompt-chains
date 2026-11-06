"use client";

import { createClient } from "@/lib/supabase/client";
import { UUID_PATTERN } from "@/lib/chains/model";

type PreparedUpload = {
  runId: string; status: string;
  upload?: { bucket: string; path: string; contentType: string };
};
type ImageMetadata = { mime: string; size: number; sha256: string };
const failure = () => ({ ok: false as const, error: { code: "upload_failed", message:
  "The image could not be uploaded. Check your session and prepared run; an existing input cannot be overwritten." } });

/** Use the original File and metadata from preparation. Storage RLS is the
 * security boundary even if a caller bypasses these browser-side checks. */
export async function uploadPreparedInput(prepared: PreparedUpload, image: ImageMetadata, file: File) {
  try {
    const descriptor = prepared.upload;
    if (prepared.status !== "prepared" || !UUID_PATTERN.test(prepared.runId) || !descriptor
        || descriptor.bucket !== "prompt-chain-execution-media" || descriptor.contentType !== image.mime
        || !["image/jpeg", "image/png", "image/webp"].includes(image.mime)
        || file.type !== image.mime || file.size !== image.size || file.size < 1 || file.size > 5242880
        || !/^[a-f0-9]{64}$/.test(image.sha256)) return failure();
    const client = createClient();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user?.identities?.some(identity => identity.provider === "google")) return failure();
    const suffix = image.mime === "image/jpeg" ? "jpg" : image.mime.slice(6);
    if (descriptor.path !== `${data.user.id}/${prepared.runId}/input.${suffix}`) return failure();
    const bytes = await file.arrayBuffer();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== image.sha256) return failure();
    const uploaded = await client.storage.from("prompt-chain-execution-media").upload(descriptor.path, file,
      { contentType: image.mime, cacheControl: "0", upsert: false });
    if (uploaded.error || uploaded.data?.path !== descriptor.path || !uploaded.data.id) return failure();
    return { ok: true as const, runId: prepared.runId };
  } catch { return failure(); }
}
