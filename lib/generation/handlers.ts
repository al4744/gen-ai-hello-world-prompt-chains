import "server-only";
import { AuthorizationError, requireSuperadmin } from "@/lib/auth/require-superadmin";
import { createServerExecutionEngine } from "@/lib/execution";
import { imageMime, integer, object, sha, text, uuid } from "@/lib/execution/contracts";
import { ExecutionFault, fault, publicError } from "@/lib/execution/errors";
import type { PrepareInput } from "@/lib/execution/engine";
import type { ExecutionResult } from "@/lib/execution/types";
import { invalid, json, readMutation, RequestError } from "./http";
import { readRunStatus } from "./status";

function keys(row: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(row).some(key => !allowed.includes(key))) throw invalid();
}
function prepareInput(value: unknown): PrepareInput {
  try {
    const row = object(value), image = object(row.image);
    keys(row, ["chainId", "idempotencyKey", "image", "userContext"]);
    keys(image, ["mime", "size", "sha256"]);
    const userContext = row.userContext === undefined ? "" : text(row.userContext, 2000);
    if (Array.from(userContext).length > 500) throw invalid();
    return { chainId: uuid(row.chainId), idempotencyKey: uuid(row.idempotencyKey), userContext,
      image: { mime: imageMime(image.mime), size: integer(image.size, 1, 5242880), sha256: sha(image.sha256) } };
  } catch { throw invalid(); }
}
function resultResponse(result: ExecutionResult & { upload?: { bucket: string; path: string; contentType: string } }) {
  const error = result.error ? publicError(new ExecutionFault(result.error.code)) : undefined;
  const code = error?.code;
  const status = !error ? 200 : code === "input_invalid" ? 422 : code === "access_denied" ? 403
    : code === "execution_conflict" ? 409 : ["renderer_unavailable", "provider_not_configured", "persistence_error"].includes(code!) ? 503 : 422;
  return json({ runId: result.runId, status: result.status, ...(error ? { error } : {}),
    ...(result.upload ? { upload: { bucket: result.upload.bucket, path: result.upload.path, contentType: result.upload.contentType } } : {}) }, status);
}

/** Request-scoped dependencies; Step 7F can inject the real renderer in engine(). */
export function createGenerationHandlers(dependencies = {
  authorize: () => requireSuperadmin({ onDenied: "throw" }),
  engine: () => createServerExecutionEngine(),
  readStatus: readRunStatus,
}) {
  async function guarded(operation: () => Promise<Response>) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof AuthorizationError) return json({ error: { code: "access_denied", message: error.message } }, error.status);
      if (error instanceof RequestError) return json({ error: { code: error.code, message: error.message } }, error.status);
      return json({ error: publicError(fault(error)) }, 503);
    }
  }
  return {
    prepare(request: Request) { return guarded(async () => {
      await dependencies.authorize();
      const input = prepareInput(await readMutation(request));
      return resultResponse(await dependencies.engine().prepare(input, { signal: request.signal }));
    }); },
    execute(request: Request, runId: string) { return guarded(async () => {
      await dependencies.authorize();
      let id: string;
      try { id = uuid(runId); } catch { throw invalid(); }
      const body = await readMutation(request);
      try { keys(object(body), []); } catch { throw invalid(); }
      return resultResponse(await dependencies.engine().execute(id, { signal: request.signal }));
    }); },
    status(request: Request, runId: string) { return guarded(async () => {
      const { supabase } = await dependencies.authorize();
      if (request.method !== "GET") throw new RequestError(405, "method_not_allowed", "Use GET for this operation.");
      let id: string;
      try { id = uuid(runId); } catch { throw invalid(); }
      return json(await dependencies.readStatus(supabase, id, request.signal));
    }); },
  };
}
