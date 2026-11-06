# Step 7D.1 — server execution core

Implemented against the migration 003/004 source contracts at checkpoint
`65cf9c1`. The user confirmed those migrations and the private bucket were
installed manually. This implementation session executes no SQL, contacts no AI
provider, uploads no media, and reads no real AI credential. Tests use synthetic
credentials, mock fetch/Supabase/Storage/renderers and in-memory image fixtures.

The core itself registers **no generation routes, Server Actions, browser UI or
history pages**. Step 7F.1 adds an injected [production PNG renderer](RENDERER.md)
with live execution disabled by a server-only feature flag. Step 7E.1 adds separate
[protected generation routes and an upload helper](../generation/README.md).
Importing the core starts no work. Every module is `server-only`; use Node.js,
not Edge, for Sharp/crypto. No Supabase client or SQL migration is replaced.

## Modules

| File | Responsibility |
|---|---|
| `index.ts` | Request-scoped production factory using the existing `requireSuperadmin({ onDenied: 'throw' })` and SSR user client |
| `engine.ts` | Guarded preparation/execution, accepted-transition gates, sequential orchestration, failure recovery and minimal public DTOs |
| `types.ts` | DI interfaces, internal contracts, immutable free-model/bucket constants, explicit limits |
| `contracts.ts` | Runtime validation of database plans, paths, snapshots, returned contexts and final text |
| `images.ts` | Signature checks, full Sharp decode, dimensions/pixels, MIME/size/digest verification |
| `renderer.ts` | Bounded caption panels, bundled font, escaped text and real PNG composition |
| `enabled.ts` | Deferred exact-match server-only generation safety flag |
| `openrouter.ts` | Fixed chat-completions endpoint, multimodal encoding, response limits, metadata and safe errors |
| `supabase.ts` | Exact v1 RPC arguments/whitelisted metadata and private Storage adapter |
| `budget.ts` | Cancellable bounded I/O, monotonic host/lease budgets and bounded stream reads |
| `errors.ts` | Fixed error messages; internal metadata never becomes a browser DTO |

Sharp `0.35.5` is now a direct, pinned dependency. It was already resolved as an
optional dependency of Next; no existing package version was upgraded. Direct
declaration makes successful native decoding a required runtime capability.

## Entry and upload contract for Step 7E

The following contract is now wired by Step 7E.1; see the endpoint documentation
above for JSON/origin limits and the browser upload helper. The production
renderer is integrated; the feature flag and quota review precede live testing.

The authenticated POST handlers independently invoke the guard,
then construct `createServerExecutionEngine({ renderer, hostBudgetMs })` inside
the request. The core itself also authorizes preparation/execution and rechecks
the same user before each step and artifact stage. Do not cache the factory,
session, plan, token or results across requests/users. Do not invoke execution
from a page render, prefetch, effect, or GET request.

1. Call `prepare({ chainId, idempotencyKey, image: { mime, size, sha256 },
   userContext })` with a UUID idempotency key and declared upload metadata.
   This accepts no creator, model, status, path, lease or snapshot fields.
   The RPC derives those fields, and the adapter loads/validates the owned run.
2. Only a prepared result includes an authorized upload descriptor containing
   the fixed private bucket, database-generated input path and MIME. Upload the
   original file through the authenticated Storage client with `upsert: false`.
   The Step 7E helper handles this transport; `prepare` does not upload
   bytes or claim that client-supplied metadata is verified.
3. Call `execute(runId, { signal })`. No lease/provider result is accepted from
   the entry-point payload. Only the run ID and cancellation signal are inputs.

Direct Storage input upload avoids sending a 5 MiB file through a Vercel
function's 4.5 MB request-body limit. The new metadata request/returned DTO is
small. Step 7E adds CSRF/origin checks, bounded JSON parsing and Node duration
configuration. Request-level quotas remain required before enabling real AI
([Vercel limits](https://vercel.com/docs/functions/limitations)).

The public result is `{ runId, status, error?: { code, message } }`, plus an
upload descriptor from preparation only. It contains no image bytes/base64,
prompt, provider response, authorization header, token or raw internal error.
`unknown` explicitly means persistence could not be confirmed; it is not a
persisted database status and must not be displayed as success or failure.

## Plan and RPC semantics

Only `prompt_chain_runs` is read, using explicit granted columns, never `*` or
the internal lease hash. The adapter uses only `prepare_prompt_chain_run_v1`
and `advance_prompt_chain_run_v1` for writes. It does not touch live chain/step,
mix, profile, battle, generation or observability records.

Plan validation checks ownership, version 1, approved model/configuration,
snapshot UUIDs/order/count, mode/slug consistency, five-step cap, MIME/size/hash,
exact creator/run input and output paths, and deadline/status fields. Uploaded
input is streamed only from the fixed private bucket/path with `no-store` and an
abort signal. Streaming stops at the declared byte count or 5 MiB, whichever is
smaller. Actual length, signature, decoding, dimensions and SHA256 must match
the prepared run before claim. No public bucket or arbitrary URL is fetched.

`claim`'s winning response is the only source of the local lease token and
deadline. Only an accepted `start_step` permits a provider call. Complete the
previous step transaction before starting the next. A refused claim/start/
completion stops this invocation without trying to fail another worker's state,
resuming, repeating a started step, or replaying an AI request.

For `caption-arena-default`, use the RPC-returned composed `prompt` verbatim,
once. The engine performs no independent concatenation/substitution. It validates
exactly two distinct, nonempty string captions with keys `caption_a` and
`caption_b`, while preserving the original raw JSON text. Database rejection
also stops execution. No stored section is trimmed or rewritten.

Custom steps use literal templates and the original image on every invocation.
Their optional user context and all preceding successful outputs are separate
JSON-encoded input data, not executable templates. Returned RPC envelopes must
match the run's image/configuration and preceding results. Accepted output stays
byte-for-byte intact, including whitespace. Nonempty custom plain text or other
JSON formats are supported; the last successful raw output is final text.

The provider wire policy for execution version 1 is the fixed `SYSTEM` string
in `openrouter.ts`: a system message, RPC prompt as the first user text part,
base64 image part, and (custom mode only) a JSON input-data text part. The DB
stores the submitted data envelope, not a literal HTTP request; no base64 or
credential is added to history. There is no template evaluator, tool loop or URL
loader. Changing wire semantics needs an explicitly reviewed execution version.

## Provider, image and cost limits

- Fixed `https://openrouter.ai/api/v1/chat/completions`, `openrouter/free`, one
  completion, non-streaming, 2,000 `max_completion_tokens`, no provider fallbacks,
  required parameter support, `no-store`, and redirects rejected. No tools,
  plugins, browsing settings, client model or endpoint is sent.
- Only default mode requests JSON-object output. Custom output is not globally
  forced to JSON. Unknown usage/cost is omitted, not fabricated as zero.
- Metadata is whitelisted and bounded for the installed RPC: requested model
  lives on the run; actual model, response ID, HTTP status, finish reason,
  integral token counts and finite reported cost are recorded when available.
  Malformed optional metadata is omitted; a missing actual model is a failure.
- Provider body is capped at 128 KiB while reading, including decompressed
  streams. Accepted text is capped at 32 KiB UTF-8; prompt plus context/prior
  output data is capped at 64 KiB. Empty, malformed, truncated, tool-call,
  filtered or unfinished responses fail safely. No output is automatically
  repaired. An oversized rejected response may be retained only as the installed
  RPC's explicitly truncated diagnostic, never as accepted output.
- Every request is aborted/bounded at at most 20 seconds, including reading the
  body. There are no automatic requests/retries on network errors, 429, unavailable
  models, invalid output or timeouts. Reported positive cost or completion-token
  usage beyond the cap stops subsequent execution on the approved free route.
- Image validation supports JPEG/PNG/WebP only, with 5,242,880 bytes, 8,192 pixels
  per side, 20 million pixels total and one frame/page. Sharp validates format
  and metadata, then fully decodes with warnings treated as failures and a native
  two-second processing timeout. Metadata alone is insufficient. Input bytes are
  not re-encoded; the provider sees the original validated image.

`OPENROUTER_API_KEY` is read only by a deferred server runtime getter after
authorization and renderer integration. Construction/import/tests never invoke
that production getter. Do not add a `NEXT_PUBLIC_` AI credential. No value is
logged, copied into a DB payload, returned, or written to an environment file.

References: [OpenRouter chat API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion),
[free router](https://openrouter.ai/docs/guides/routing/routers/free-router),
[Sharp constructor](https://sharp.pixelplumbing.com/api-constructor/),
[Sharp timeout](https://sharp.pixelplumbing.com/api-output/#timeout).

## Artifact renderer and installed Storage constraint

The injected `ArtifactRenderer.render({ image, finalText, mode, signal })` returns
PNG bytes. It receives the exact persisted final text and no token/key. The
production factory now injects the real Sharp renderer; [its layout, normalization,
font coverage and bounds](RENDERER.md) are documented separately. The endpoint
returns `generation_disabled` before any run load, claim, Storage or AI work unless
the server-only flag is exactly `true`. The factory independently checks the flag
before provider configuration/input download/claim. No dummy artifact is used.

After all model results persist, the core independently validates rendered PNG
bytes and computes their digest, then uploads those exact bytes with fixed path,
`image/png`, `upsert: false`, and a checked Storage path/ID acknowledgement. Only
then does it finalize, letting the RPC check stored owner/MIME/size. A final read
must confirm success, matching final text and artifact digest/size. Lost final
acknowledgements can be confirmed by readback without repeating finalization or
provider calls; failed confirmation returns `unknown`.

**Migration 004 disallows downloading a staged artifact before success.** This
core therefore validates the upload bytes plus Storage acknowledgement and RPC
metadata; it does not falsely claim a pre-finalization download-and-rehash.
If that stronger guarantee is required, a future reviewed policy/version must
permit the current creator to read the staged output under narrow conditions.

The installed Storage SDK upload method has no AbortSignal parameter. The core
bounds its wait, checks cancellation before/after, and never finalizes a late
upload. An in-flight upload may still leave a private orphan after cancellation;
cleanup/retention needs separate approval. Downloads and RPC calls support abort
signals. No service-role client is used to bypass either limitation.

## Deadline and failure behavior

The actual claim deadline is honored without extension. Monotonic elapsed time
and the claim-request start also cap the budget, so network latency, remote clock
skew, wall-clock rollback or a silently extended RPC cannot buy more execution
time. The host budget can be configured **downward only**, at most 120 seconds.
Five seconds are reserved for bounded failure persistence/authoritative readback.
Provider allocation additionally reserves 30 seconds for final stages and a
five-second completion write. No new provider starts with less than five seconds
of request budget. Each I/O/rendering stage is bounded; delayed event-loop timers
cannot turn late work into timely work. There is no fire-and-forget continuation.

Five fast free-model calls can fit; five near-20-second calls plus DB/image work
and finalization cannot reliably fit. No live latency benchmark was performed
(real requests were explicitly prohibited). The free router has variable model
selection/availability; there is no reliable latency bound to assume. Insufficient
budget stops safely and records failure/interruption when possible.

Current [Vercel duration documentation](https://vercel.com/docs/functions/configuring-functions/duration)
lists Fluid Compute defaults of 300 seconds, with maximum 300 on Hobby and 800 on
Pro/Enterprise. The actual project's plan, Fluid setting and deployed duration
are not available in this repository. A future Node entry must explicitly choose
an allowed duration with startup/cleanup headroom (for example 150 seconds for
this 120-second core), or pass a lower host budget. Platform duration never
extends the database lease.

**Future proposal, not SQL in this change:** review a versioned v2 execution
contract with a fixed 240-second lease, a 300-second Node entry budget, bounded
35-second calls (5 × 35 = 175 seconds), about 20 seconds for DB work, 30 seconds
for artifact work and 15 seconds cleanup/skew. Add v2 functions and deliberately
extend the new execution tables' version constraints while preserving v1 rows
and callers; merely returning a longer deadline from v1 is insufficient. This
still needs measured free-provider latency, rate limits and cost/quota review.
No job queue or migration modification is introduced now.

Fixed RPC failure codes are used; previous successes remain. At actual expiry,
the RPC records interrupted/skipped work. Before expiry, insufficient AI budget
or a cancelled AI request maps to the installed `provider_timeout` code; the
public result distinguishes cancellation. Artifact-stage cancellation maps to
`artifact_error`. The installed contract has no `cancelled` status/error code.
Pre-claim cancellation/configuration/renderer failures leave the run prepared
rather than inventing an unsupported failure code. A later version can make
these distinctions persist explicitly.

A failed completion acknowledgement is an ambiguous commit, so the runner does
not replay that provider/step or attach potentially conflicting provider metadata
to another transition. It attempts bounded failure recording and then reads the
actual run. If writes/reads are unavailable, it returns `unknown`, not a made-up
failed/succeeded status. Hard process termination, revoked permissions and client
disconnects can prevent cleanup; the lease/effective-status history and a later
authorized expiry call remain the recovery mechanism. No automatic resume occurs.

## Validation and remaining integration

`tests/execution-core.test.mjs` runs actual TS modules through the existing
isolated-module test style. The helper blocks real environment reads/network,
uses real local Sharp codecs for image validation, and injects mock RPCs,
Storage, clock, fetch and renderer. It is not a PostgreSQL/RLS/Storage emulator.
Earlier suites remain unchanged. No live test proves the manually installed SQL
matches this source; future isolated/user-approved integration must check that.

- **7E:** protected metadata preparation/direct private upload/execute/status
  routes, CSRF and JSON limits, and duration settings are implemented separately.
  Request quotas and server credential configuration remain pre-generation work.
  Do not send client tokens, snapshots or provider results.
- **7F.1:** the real renderer is implemented and integrated behind the default-off
  flag. Browser generation UI and approved live integration remain future work.
- **7G:** guarded history/media retrieval, chain-specific filtering, expired/
  failed/unknown feedback, retained deleted-chain snapshots, responsive themes.

Existing persistence security limitations remain: the same authorized creator
JWT can call granted RPCs directly, so SQL does not attest that reported text
came from AI. The server factory accepts no client provider responses and adds
no new access path, role, endpoint or credential. Stronger server-only provenance
would require a separately reviewed writer/capability architecture.
