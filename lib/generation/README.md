# Protected generation entry points — Step 7E.1

These Node Route Handlers use the existing session client and execution core.
The existing Cache Components configuration requires Node.js; this Next version
forbids explicit route `runtime` exports, including `runtime = 'nodejs'`.
Step 7F.1 integrates a real [renderer](../execution/RENDERER.md) behind a default-off
server-only safety flag. Step 7F.8 adds the protected Generate page and completed
PNG retrieval below. Step 7G.1 adds [the protected history gallery](../history/README.md)
using that same media endpoint. No privileged credential, SQL or Storage policy
change is included. No live mutation, upload or AI request was used.

| Method and route | Request | Successful response |
|---|---|---|
| `POST /api/generation/runs` | `{ chainId, idempotencyKey, image: { mime, size, sha256 }, userContext? }` | `{ runId, status, upload?: { bucket, path, contentType } }` |
| `POST /api/generation/runs/:runId/execute` | `{}` | `{ runId, status, error?: { code, message } }` |
| `GET /api/generation/runs/:runId` | No body | `{ runId, chain: { id, name, slug }, status, progress, createdAt, startedAt, completedAt, error?, finalText? }` |
| `GET /api/generation/runs/:runId/media` | Optional `?download=1` | Verified PNG; inline preview or attachment |

## Generate page — Step 7F.8

`/generate` sits under the existing protected layout, independently calls
`requireSuperadmin()` before loading data/readiness, and is item 03 in the shared
sidebar/mobile navigation. Its compact header, two responsive panels, buttons,
form controls and semantic colours reuse the Prompt Chain Tool design system.
No global CSS or theme logic changed. Public Generate's prominent upload,
original preview, captions/results and Create another flow informed the UX;
both reference applications were inspected read-only. Generation is explicitly
submitted after choosing a chain/context instead of starting on file selection.

The server reuses `listChains` across all directory pages, supplying names,
descriptions and step counts without prompt templates. The system chain is the
sensible default when executable; custom chains are equally selectable. Empty
or unsupported step configurations remain inspectable but cannot be submitted.
Preparation still snapshots/validates the authoritative definition in the RPC.

The client receives only a non-sensitive server readiness boolean. While false,
chain selection, optional context and local image preview work, but the primary
action and workflow guard prevent hashing/preparation/upload/execution. No real
flag or credential is set by the UI, tests or build. Existing backend execution
and production-factory gates remain unchanged, including if the UI is bypassed.
As before, the metadata preparation endpoint itself is not disabled by this flag;
its existing contract is preserved. A stale enabled page encountering a disabled
backend shows configuration unavailable and prevents further submissions.

`workflow.ts` coordinates existing endpoints and `uploadPreparedInput`, not a
second execution engine. A synchronous lock prevents duplicate clicks before a
React paint. It validates the selected chain/file/context, computes SHA256 using
Web Crypto, prepares with a UUID idempotency key, uploads original bytes through
the existing helper, executes once, then reads authoritative persisted status.
Ambiguous preparation retains its key for an explicit identical submission;
changed inputs get a new key. An acknowledged preparation followed by a failed
upload can be replaced by a new intentional run, never an overwrite.
The browser bounds its upload wait to 60 seconds and stops on unmount. The
existing Storage SDK helper cannot cancel an already-started upload; a late
private object may remain, but its acknowledgement never triggers execution
after cancellation/timeout. Cleanup/retention remains separately approved work.

Loading messages distinguish image checking, preparation, secure upload,
execution and status/media loading. Because execution is request-bound, the client
awaits that single POST. After two seconds, a bounded read-only observer displays
persisted step progress while that request is pending and is cancelled with its
acknowledgement. Recovery/active-run polling is also read-only; each observer is
limited to 60 reads / a 150-second window, with two-second gaps and bounded
individual requests. A lost execution response only triggers status reads, never
automatic execution replay. Failed/interrupted statuses and saved step counts
come from the database; configuration unavailable is distinct from a failed run.

The acknowledged run UUID is kept in `/generate?run=...` for refresh recovery.
Only this identifier is persisted in the URL; no input image, context, upload
descriptor, provider metadata, lease, or credential is stored in browser storage.
Refresh reauthorizes the page and resumes read-only status/media retrieval,
including while generation is disabled. Unknown/running work blocks another
submission until its status is checked. Prepared work is never automatically
re-executed; an explicit Start a new run begins a different intention.

`preview.ts` checks MIME, size and image signature before creating a local object
URL, then waits for browser decoding and checks dimension/pixel bounds. Failed,
cancelled and replaced selections cannot publish a broken preview. Object URLs
are revoked on failure, replacement, reset and unmount. Existing server byte
validation before claim is still authoritative. Context allows up to 500 Unicode
characters / 2,000 UTF-8 bytes and stays intact when changing chains.

Only confirmed successful status exposes generated text and loads media. Default
caption JSON is shown as Caption A/B with the exact saved JSON available in a
disclosure; custom output stays literal text. React escapes all output. Completed
PNGs are fetched through the new guarded media route and previewed with temporary
blob URLs. Next Image uses `unoptimized` so private images never enter its public
optimization/cache path. Downloads reauthorize through the same endpoint with
`?download=1`. Media-load failure preserves the successful run/text and retries
only the image GET. Controls have labels, visible global focus indicators and
live status/error feedback; motion follows the existing reduced-motion rule.

## Completed PNG retrieval

`media.ts` independently verifies the current Google superadmin on every request,
then validates the UUID and selects only the saved status, creator snapshot,
artifact path, length and SHA256. A successful record is required. The path must
equal `<creator snapshot UUID>/<run UUID>/captioned.png`; no query-supplied path,
URL, bucket or filename is trusted. Current-superadmin history scope permits
reading other creators' completed artifacts and retained deleted-chain history.

The existing session client downloads only from the fixed private bucket using
RLS and `no-store`. Streaming stops at the recorded size or 5 MiB; independent
Sharp validation confirms PNG signature/full decode, dimensions/pixels, exact
length and saved digest before any bytes are returned. A ten-second overall
bound and request AbortSignal cover querying/downloading/validation. No upload,
RPC, mutation, signed URL, public bucket or privileged client is involved.

Success sets `Content-Type: image/png`, exact Content-Length, a UUID-only fixed
Content-Disposition filename, `Cache-Control: private, no-store`, `Vary: Cookie`,
`X-Content-Type-Options: nosniff`, and restrictive image-response CSP. Anonymous
and ordinary users get 401/403; invalid IDs 400; absent runs/objects 404;
unfinished runs 409; invalid artifacts 422; unavailable persistence/transport 503.
Errors use fixed sanitized JSON and private/no-store headers, never paths or
diagnostics. Status/media remain readable while the generation flag is off.

IDs are UUIDs, SHA256 is 64 lowercase hexadecimal characters, size is an integer
from 1 through 5,242,880 bytes, and MIME is JPEG/PNG/WebP. Optional context is at
most 500 Unicode characters / 2,000 UTF-8 bytes. Unknown fields are rejected.
Both POSTs require an uncompressed `application/json` body, at most 8,192 bytes
including chunked bodies, with a five-second body-read deadline. Execution
accepts no input, model, path, snapshot, creator, provider result or lease token.

Every handler independently invokes `requireSuperadmin({ onDenied: 'throw' })`;
the engine also authorizes and retains its existing per-stage checks. The guard
verifies the Auth user, Google identity and current strict database superadmin
flag. Cookie mutations require an exact `Origin` matching the request URL's
origin. If present, `Sec-Fetch-Site` must be `same-origin`. No wildcard CORS or
redirect is returned. JSON plus Origin/fetch-metadata checks block cross-site
cookie/form submissions. API clients must send the same Origin explicitly.
Forwarded host headers are not used to expand trusted origins; deployment must
preserve the correct public request origin through its trusted proxy.

Handled success/error responses use `Cache-Control: private, no-store`,
`Vary: Cookie, Origin` and `X-Content-Type-Options: nosniff`. The existing session
proxy also supplies CDN no-store headers. Next rejects unexported HTTP methods
with 405. The GET handler uses runtime authorization and uncached database access;
it has no `use cache` or prerendered protected payload.

Errors are fixed public messages: 401/403 authorization, 400 malformed input,
413 body limit, 415 content type, 404 absent status row, 409 execution conflict,
422 execution/input failure, 503 configuration/persistence unavailable. Execution
results retain the core's authoritative state, including `unknown` when a commit
cannot be confirmed. Treat this as uncertain, never as success or permission to
replay a provider request. Database preparation conflicts currently map to the
core's sanitized persistence error; no raw SQL message is classified or returned.

## Browser upload protocol

1. Keep the original File. Check its MIME/5 MiB bound and compute SHA256 with Web
   Crypto over its bytes. Use a new `crypto.randomUUID()` idempotency key for a
   new intentional run; preserve it for a repeated identical preparation.
2. POST the metadata to preparation with same-origin cookies. The installed
   `prepare_prompt_chain_run_v1` derives the snapshot, creator, paths and model.
   Duplicate keys/fingerprints return the existing run, including after edits;
   changed metadata under the same key fails. The route does not emulate this
   state or automatically retry.
3. For a `prepared` response, call
   `uploadPreparedInput(preparedResult, submittedImageMetadata, originalFile)`
   from `upload.ts`. It verifies the current Google user, fixed private bucket,
   exact user/run input path, MIME, size and local digest, then uses the existing
   authenticated browser client with `upsert: false`. Caller filenames are unused.
4. Installed Storage RLS is authoritative even if browser checks are bypassed:
   only the current superadmin creator can insert the recorded input for an
   unexpired prepared run. Ordinary users, other creators, arbitrary paths,
   overwrite/update/delete and public access remain denied. The helper sanitizes
   Storage errors and makes one upload attempt. An expired preparation or lost
   upload acknowledgement may require checking saved state; never overwrite it.
5. Only after successful upload, POST `{}` to execute. The existing engine will
   independently stream, decode, bound and hash the private stored bytes before
   claiming when live execution is approved/enabled. Browser hashes are not trusted proof.

Files go directly to Storage, avoiding a 5 MiB file in a function JSON/body
request. No signed/public upload URLs, service key or external image URL is used.
Preparation/upload can be exercised now; actual execution remains unavailable.

## Execution gate and polling

The production factory now injects a real Sharp `ArtifactRenderer`. Execution
requires the server-only `PROMPT_CHAIN_GENERATION_ENABLED` flag to equal the exact
string `true`. By default, after authorization and request validation, the endpoint
returns HTTP 503 with `status: 'unavailable'` and `error.code: 'generation_disabled'`
before engine construction, run loading, credential lookup, Storage, claim or AI.
Status remains available while execution is disabled. The factory independently
checks the flag before provider configuration/input download/claim. When enabled,
terminal/running runs retain the existing state/conflict behavior. No automatic
execution, provider retry, resume, dummy output or lease extension is added.

The execute route declares `maxDuration = 150` for platform headroom around the
existing at-most-120-second core and fixed 120-second DB lease. Confirm hosting
support before enabling actual execution; a shorter host limit requires a lower
core budget. No process survives the request intentionally.

Status uses explicit run columns plus only step position/status, never leases,
Storage paths, prompts, provider diagnostics, creator details or raw DB errors.
All current superadmins may read retained history snapshots, including runs of
other creators/deleted chains, per the approved history model. Only successful,
finalized runs expose final text. Progress includes total, pending, running,
succeeded, failed, skipped and interrupted invocation counts (one invocation for
the composed default chain, not four source sections).

Expired prepared/running rows are projected as interrupted; pending steps become
effectively skipped and running steps effectively interrupted. GET performs no
expiry write. It leaves `completedAt` null until the database actually records
completion. Run and step reads are separate, so progress can advance between
reads; a subsequent authorized poll resolves that normal observation race.

## Verification and remaining work

`tests/generation.test.mjs` exercises the actual handlers/guard/core factory and
browser helper with mocked SDK boundaries and real in-memory image fixtures.
Real environment reads and network are blocked. It does not prove live installed
RLS/Storage/RPC compatibility. Existing execution tests cover byte validation,
single accepted claims/starts, partial failures, ambiguous acknowledgements,
timeouts, provider response validation and sanitized results.

Before actual generation: approve live testing and the exact server flag, quota and
provider-spending controls, confirm host duration and server-only provider
configuration, and perform approved browser/RLS integration tests. Chain-specific
history/gallery is now implemented separately in Step 7G.1; Generate still only
recovers the current run. Direct RPCs remain
callable by an authorized creator under the installed model: server-only AI
provenance is not attested by this HTTP layer. Orphan cleanup/retention remains
separate work. No new permission or service identity is introduced here.

`tests/generate-page.test.mjs`, `tests/generation-workflow.test.mjs` and
`tests/generation-media.test.mjs` cover guarded page/endpoint access, multi-page
chain selection, disabled SSR controls, local previews, actual hashing and upload
helper integration, duplicate prevention, idempotency, status/recovery/failures,
object URL cleanup and PNG verification. All fetch/Supabase/Storage boundaries
are mocked. Browser layout, actual drag/drop/decoding, keyboard/screen-reader
interaction and real RLS compatibility still need manual approved validation.
