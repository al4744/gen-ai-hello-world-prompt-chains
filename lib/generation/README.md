# Protected generation entry points — Step 7E.1

These Node Route Handlers use the existing session client and execution core.
The existing Cache Components configuration requires Node.js; this Next version
forbids explicit route `runtime` exports, including `runtime = 'nodejs'`.
Step 7F.1 integrates a real [renderer](../execution/RENDERER.md) behind a default-off
server-only safety flag. No page, gallery, privileged credential, SQL or
Storage-policy change is included. No live mutation, upload or AI request was used.

| Method and route | Request | Successful response |
|---|---|---|
| `POST /api/generation/runs` | `{ chainId, idempotencyKey, image: { mime, size, sha256 }, userContext? }` | `{ runId, status, upload?: { bucket, path, contentType } }` |
| `POST /api/generation/runs/:runId/execute` | `{}` | `{ runId, status, error?: { code, message } }` |
| `GET /api/generation/runs/:runId` | No body | `{ runId, chain: { id, name, slug }, status, progress, createdAt, startedAt, completedAt, error?, finalText? }` |

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
configuration, and perform approved browser/RLS integration tests. Then add the
generation UI, safe media retrieval and chain-specific history. Direct RPCs remain
callable by an authorized creator under the installed model: server-only AI
provenance is not attested by this HTTP layer. Orphan cleanup/retention remains
separate work. No new permission or service identity is introduced here.
