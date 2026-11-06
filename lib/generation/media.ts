import "server-only";
import { AuthorizationError, requireSuperadmin } from "@/lib/auth/require-superadmin";
import { bounded, readLimited, systemClock } from "@/lib/execution/budget";
import { integer, object, sha, uuid } from "@/lib/execution/contracts";
import { validateImage } from "@/lib/execution/images";
import { EXECUTION_BUCKET, LIMITS } from "@/lib/execution/types";
import { invalid, json, RequestError } from "./http";

const FIELDS = "id,status,creator_id_snapshot,artifact_path,artifact_size_bytes,artifact_sha256";
const unavailable = () => new RequestError(422, "media_invalid", "The saved image could not be verified.");

export function createMediaHandler(authorize = () => requireSuperadmin({ onDenied: "throw" })) {
  return async (request: Request, runId: string): Promise<Response> => {
    try {
      const { supabase } = await authorize();
      if (request.method !== "GET") throw new RequestError(405, "method_not_allowed", "Use GET for this operation.");
      let id: string;
      try { id = uuid(runId); } catch { throw invalid(); }
      return await bounded(systemClock, 10000, request.signal, "artifact_error", async signal => {
        const result = await supabase.from("prompt_chain_runs").select(FIELDS).eq("id", id).abortSignal(signal).maybeSingle();
        if (result.error) throw new RequestError(503, "media_unavailable", "The saved image is temporarily unavailable.");
        if (!result.data) throw new RequestError(404, "run_not_found", "The generation run was not found.");
        const row = object(result.data);
        if (row.status !== "succeeded") throw new RequestError(409, "media_not_ready", "This run has no completed image yet.");
        let path: string, size: number, digest: string;
        try {
          if (uuid(row.id) !== id) throw unavailable();
          path = `${uuid(row.creator_id_snapshot)}/${id}/captioned.png`;
          if (row.artifact_path !== path) throw unavailable();
          size = integer(row.artifact_size_bytes, 1, LIMITS.imageBytes);
          digest = sha(row.artifact_sha256);
        } catch { throw unavailable(); }
        const downloaded = await supabase.storage.from(EXECUTION_BUCKET).download(path, {}, { signal, cache: "no-store" }).asStream();
        if (downloaded.error || !downloaded.data) throw new RequestError(404, "media_missing", "The completed image could not be found.");
        let bytes: Uint8Array;
        try {
          const input = await readLimited(downloaded.data, size, signal, "artifact_error");
          bytes = (await validateImage(input, { mime: "image/png", size, sha256: digest }, signal)).bytes;
        } catch { throw unavailable(); }
        const download = new URL(request.url).searchParams.get("download") === "1";
        return new Response(new Uint8Array(bytes), { headers: {
          "Content-Type": "image/png", "Content-Length": String(bytes.byteLength),
          "Content-Disposition": `${download ? "attachment" : "inline"}; filename="caption-${id}.png"`,
          "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        } });
      });
    } catch (error) {
      if (error instanceof AuthorizationError) return json({ error: { code: "access_denied", message: error.message } }, error.status);
      if (error instanceof RequestError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: { code: "media_unavailable", message: "The completed image could not be retrieved or verified." } }, 503);
    }
  };
}
