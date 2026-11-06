import "server-only";

export class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Vary": "Cookie, Origin",
  } });
}

export const invalid = () => new RequestError(400, "invalid_request", "The generation request is invalid.");

/** JSON + exact Origin blocks cookie-based cross-site/form submissions. No CORS. */
export async function readMutation(request: Request): Promise<unknown> {
  if (request.method !== "POST") throw new RequestError(405, "method_not_allowed", "Use POST for this operation.");
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site");
  if (!origin || origin !== new URL(request.url).origin || (site !== null && site !== "same-origin")) {
    throw new RequestError(403, "origin_denied", "A same-origin request is required.");
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
      || (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity")) {
    throw new RequestError(415, "unsupported_media_type", "Send an uncompressed JSON request.");
  }
  const maximum = 8192, length = request.headers.get("content-length");
  const tooLarge = () => new RequestError(413, "request_too_large", "The generation request is too large.");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) throw tooLarge();
  if (!request.body) throw invalid();
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let size = 0;
    if (signal.aborted) throw invalid();
    for (;;) {
      const part = await reader.read();
      if (signal.aborted) throw invalid();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw tooLarge();
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    cancel();
    throw error instanceof RequestError ? error : invalid();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
