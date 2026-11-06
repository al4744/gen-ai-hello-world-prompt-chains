# Step 7C.1 — execution persistence proposal

**Prepared locally; not installed, executed, or connected to an AI provider.**
Checkpoint inspected: `fcd8a24`, initially clean. This step changes no application
runtime, existing migration, dependency, environment file, or Supabase resource.
The SQL is a reviewable design, not a claim of live database compatibility.

## Files and installation order

1. Run/review `verification/execution_preflight.sql` with an approved read-only
   metadata session. Resolve every assumption below before approving installation.
2. Review `migrations/202611050003_prompt_chain_execution.sql`: two new tables,
   indexes, RLS/read grants, two mutation RPCs and two invoker access helpers.
3. Review `migrations/202611050004_prompt_chain_execution_storage.sql`: six new
   policies scoped to the new bucket. **Install policies before creating the bucket.**
4. Independently create the new bucket using the Supabase Dashboard or Storage
   API, with the exact options in `storage/prompt-chain-execution-media.json`.
   For the JavaScript API, use `name` as `createBucket`'s first argument and the
   remaining fields as its options. No setup script or credential is supplied.
5. Review/run `verification/execution_postinstall.sql`. Then perform the isolated
   behavioral/security tests in `EXECUTION_TEST_PLAN.md` before wiring a runner.

No migration creates a bucket or writes Storage metadata. Supabase advises
managing physical files/buckets through its API, rather than editing metadata
rows ([Storage schema](https://supabase.com/docs/guides/storage/schema/design),
[createBucket](https://supabase.com/docs/reference/javascript/storage-createbucket)).
Each migration is independently transactional and fails on object collisions.
There is no `CREATE OR REPLACE`, `IF NOT EXISTS` reuse, source-table data write,
profile trigger alteration, or installation-time execution RPC call.

## Verified contracts and live assumptions

Repository/source facts:

- `requireSuperadmin()` verifies `getUser()`, Google identity, and current
  `profiles.is_superadmin === true`. Future pages/endpoints must keep calling it.
- Current clients use user JWTs and publishable keys, with no service-role client.
- Chain IDs are UUIDs. Steps have UUIDs, `chain_id`, positive `step_order`, name,
  and literal `prompt_template`; the supplied schema specifies unique parent/order.
- Installed-v1/v2 source locks the parent first, then children in UUID order.
- Source references/earlier schema summaries specify cascading deletion of live
  steps/mix, but do not supply a full live schema dump.

User-confirmed execution facts:

- `caption-arena-default` has four ordered sections; the third contains
  `{{user_prompt}}`; their original templates must remain unchanged.
- One composed invocation must produce exactly two distinct nonempty captions in
  `caption_a` / `caption_b` JSON. Custom invocations do not inherit that JSON rule.
- Custom execution is ascending stored order, at most five steps, with the same
  original image/context and bounded preceding results supplied to each step.
- Media means uploaded JPEG/PNG/WebP (maximum **5 MiB**), AI-generated text, and a
  saved captioned-image artifact. It does not mean an AI-synthesized photograph.

Unverified live installation requirements:

- UUID source PK/FK types, text/bool columns, required/nonempty step constraints,
  source RLS, unique chain/order key, all incoming FKs and unexpected triggers.
- Actual v1/v2 locking definitions, existing profile protection triggers, and
  whether global DDL event triggers add privileges/policies to new objects.
- PostgreSQL core `gen_random_uuid`, `sha256`, role memberships, default ACLs,
  trusted `postgres` installation ownership, and policy-creation permissions.
- All new relation/index/function/policy names and bucket ID/name are unused.
- Storage tables have `objects.owner_id` text and service-generated
  `metadata.mimetype` / `metadata.size`; owner IDs are populated on JWT uploads.
  Storage itself already has working table grants and enabled objects RLS.
- Existing permissive/restrictive Storage policies permit the intended service
  operations for other buckets. New guards cannot undo an existing denial.
- Authenticated callers can SELECT their own profile fields; missing privileges
  must fail closed, not cause a fallback to privileged credentials.
- Default section positions are 1–4 and only the third section contains the
  binding. Snapshot creation rejects a changed/missing default contract.
- Manual authenticated/anonymous API probes are required; SQL-editor owner
  results do not establish RLS behavior under a user JWT.

Do not silently edit existing policies, triggers, grants, or constraint timing
when a preflight result differs. Revise this proposal before installation.

## Database design and retention

`prompt_chain_runs` stores identity, name/slug, ordered literal step snapshot,
snapshot hash, execution mode/version, original creator UUID, nullable live
creator reference, idempotency/fingerprint, input metadata/path, optional context,
requested model/config, last generated text, artifact metadata/path, lifecycle,
fixed errors and server timestamps/deadline. The lease is stored only as a SHA256
hash, excluded from authenticated column SELECT grants.

`original_chain_id` has no live FK; `current_chain_id` has `ON DELETE SET NULL`.
The immutable original UUID remains the history filter after deletion or slug
reuse. Snapshots/results never follow subsequent chain or step edits. A nullable
creator FK uses SET NULL on account deletion, preserving history without blocking
existing account deletion; the historical UUID/path remains (no email is copied).

`prompt_chain_run_steps` has `(run_id, execution_position)` as its PK. Its parent
FK is RESTRICT, never CASCADE. Custom `source_step_id` references the parent
snapshot, not live steps. Names/templates are not duplicated here. Requested
model/provider/config are on the run; actual model, provider HTTP/response IDs,
usage/cost and start/completion times are per invocation. Durations and usage
totals are derived; unknown cost/tokens remain NULL, rather than invented zero.

Preparation pre-creates all invocation rows atomically with the run. A composed
run has **one** invocation and all **four** source sections in its snapshot.
Sequential runs have one row per snapshot step. Gapped custom orders remain
unchanged; execution positions enumerate the sorted snapshot, not a second live
ordering system. No generation_sets/generations/observability/mix row is written.

## Permission boundary: deliberate definer exception

Invoker functions are preferred and used for both read/access helpers. However,
an invoker mutation needs caller table-write grants. Granting those and merely
putting checks inside an RPC would leave a direct-table bypass. This proposal
instead gives API roles **no INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or
TRIGGER privileges** on the two new tables and no general run-table SELECT.

Only the two bounded mutation RPCs are SECURITY DEFINER, explicitly owned by the
trusted `postgres` installation role. They have pinned `pg_catalog` search paths,
schema-qualified relation access, no dynamic SQL, a five-second lock timeout,
explicit authenticated/UID/current-profile checks, and creator ownership checks
on every advance. They accept no snapshot, storage path, status, creator, final
text, completion timestamp, or arbitrary provider endpoint/model from callers.
Unexpected payload keys are rejected. Only authenticated has mutation EXECUTE;
PUBLIC, anon and service_role default grants are explicitly revoked.

**Owner bypass is real:** RLS and FORCE RLS stay enabled, but `postgres` can
bypass them. `row_security = on` does not remove that power. Explicit function
authorization and least-privilege execute grants are therefore essential. This
is a narrow privilege boundary for the new tables, not an invoker function
masquerading as server-only. Review these functions before approving the exception
([Supabase function security](https://supabase.com/docs/guides/database/functions)).

Read policies query the current superadmin flag, not mutable JWT user metadata.
Only current superadmins can SELECT history. Helpers are invoker and publicly
executable because restrictive Storage policies may be evaluated for unrelated
buckets/anonymous requests; the helpers return false before querying protected
relations when unauthenticated, and false for ordinary users. They return no
history or role data. No service-role credential, new role or profile policy is
introduced. Existing step RPCs retain their original invoker security.

An authenticated creator can invoke a permitted RPC directly. The same JWT does
not prove that a caller is the Next.js server or that a reported model response
actually came from a provider. The lease prevents conflicting/replayed advances;
it is **not AI provenance attestation**. A future server must keep the token
out of browser props/logs, derive provider results from real calls, and verify
file bytes. Strict server-only attestation would require a separate reviewed
writer identity/capability boundary, not an RLS claim this design cannot deliver.

## RPC protocol

`prepare_prompt_chain_run_v1(chain_id, idempotency_key, input_mime,
input_size_bytes, input_sha256, user_context = '')`:

- Validates image metadata (not bytes) and ≤500-character context. Requires the
  new bucket with the exact private/MIME/size configuration and all six reviewed
  Storage policies. A partial installation cannot prepare runs.
- A per-creator transaction advisory lock serializes preparation/claiming. A
  duplicate key and fingerprint returns the existing run, even after chain edits
  or deletion; changed inputs under that key raise `idempotency_input_conflict`.
- Reads/locks the live parent, then children in UUID order, and captures literal
  content sorted by stored order. The default mode is derived from the reserved
  slug. Preparation never updates those records.
- Derives snapshot SHA256, paths, model/config, timestamps, invocation rows and
  `prepared` status in one transaction; deadline is 30 minutes for upload.
- Request fingerprint is database-derived from chain UUID, image metadata/hash,
  context and execution version. It intentionally excludes mutable live prompt
  contents: replay refers to the original frozen run, not a new definition.

`advance_prompt_chain_run_v1(run_id, operation, lease_token = NULL, payload = {})`:

| Operation | Payload | Outcome |
|---|---|---|
| `claim` | `verified_input_sha256` | Checks caller/creator, live-chain reference, input object owner/type/size and declared verified hash. Prepared → running, new fixed 120-second deadline; returns a random token only on the winning claim. |
| `start_step` | `position` | Requires running lease and preceding successes. Pending → running; returns database-built submitted context. |
| `complete_step` | `position`, `output_text`, `actual_model`, optional provider/usage fields | Records result and server completion time atomically. Invalid output marks the run failed; valid last output becomes run final text. |
| `finalize` | `artifact_sha256` | Requires all invocations succeeded and the fixed PNG object with valid owner/type/size. Running → succeeded; final text is taken from the recorded result, not the caller. |
| `fail` | `error_code`, optional provider-result metadata | Preserves previous successes, records active provider diagnostics if available, marks running step failed and pending steps skipped. Prepared failures accept only input/persistence failure codes. |
| `expire` | none | Only once the deadline passed: records interrupted/skipped work. Never resumes or calls a provider. |

Optional provider fields: `provider_response_id`, `provider_http_status`,
`finish_reason`, `prompt_tokens`, `completion_tokens`, `total_tokens`, `cost_usd`.
`fail` also accepts bounded `output_text` and `actual_model` when an invocation is
running. Omit unknown optional values; explicit JSON null is rejected. Errors
accept fixed codes only, never raw provider messages/headers/stacks.

Every advance locks the creator advisory key and run row before changing state.
One running run per creator is also enforced by a partial unique index. An old
expired active run must be explicitly expired before another claim. Sequential
positions cannot be skipped or restarted. A duplicate start/complete/claim returns
`accepted: false`; terminal records are immutable and return their current status.
**The future runner must call a provider only after `start_step` returns
`accepted: true`**, and only report success after finalization confirms it.

After expiry, any creator advance records interruption without accepting new
results. A claimed run cannot be failed/finalized without its token. Expiration
does not require a token but requires the current creator/superadmin and an
elapsed deadline. Deleted/demoted creators cannot advance; other superadmins can
still view expired status via the read-only effective-status query. Recovery for
those accounts is an explicit maintenance concern, not a hidden privilege grant.

Composed context joins the four frozen sections with two newlines and performs
one literal `replace` in section three only. Empty context uses `No additional
context provided.` User `$`, backslashes, braces and placeholder-like text are
plain data; no evaluation or recursive expansion occurs. Custom templates remain
literal, with user context/image/prior results supplied separately.

`submitted_context` records the prompt, context, image reference/hash, preceding
outputs, model and request configuration used by the future adapter. No base64
image, signed URL, authorization header or credential is stored. Adapter roles,
fixed system instruction and wire formatting still need an execution-versioned
contract when the runner is implemented; this is not a captured HTTP request.

Limits proposed for v1: five custom steps, 64 KiB serialized definition snapshot,
32 KiB UTF-8 per accepted output, 1 MiB serialized submitted context, 256 KiB RPC
result payload, and 2,000 maximum completion tokens per future request. Oversized
results fail; only their bounded diagnostic prefix is retained with
`output_truncated = true`. Accepted outputs are never silently truncated. The
provider/context token budget must still be checked by the future runner.

The requested model is intentionally pinned to the existing `openrouter/free`;
actual selected models are recorded separately. Paid/pinned-model configuration,
per-day quotas, provider-side spending controls, real HTTP aborts, and hosting
duration must be reviewed before enabling AI calls. This step makes none.

## Storage and media retrieval

Bucket: `prompt-chain-execution-media`, private, maximum 5,242,880 bytes, exact
JPEG/PNG/WebP MIME allowlist. Input path is
`<creator UUID>/<run UUID>/input.jpg|png|webp`; output is
`<creator UUID>/<run UUID>/captioned.png`. Caller filenames/paths are never used.
PNG artifacts must also fit 5 MiB; later rendering must resize/compress or fail.
The artifact layout for the default caption pair remains a renderer decision.

Current superadmins can read recorded inputs and successfully finalized artifacts.
Only a current creator may insert the prepared input before its deadline, or
insert the output after every model invocation succeeded and before finalization.
All UPDATE/DELETE operations for this bucket are denied to application roles,
including renames/moves into or out of it. Unique bucket/name prevents a second
INSERT. Accepted inputs/artifacts cannot be overwritten, even by their creator.
In-flight uploads can leave unreferenced objects on failure; they are not shown
as successful outputs and need separately approved retention/cleanup.

Four restrictive guards apply to PUBLIC but return true for other buckets; two
permissive policies grant the intended new-bucket read/insert access. Restrictive
AND guards prevent broad older permissive OR policies from leaking this bucket.
They do not grant access to, or change the intended rules of, other buckets
([PostgreSQL policy combination](https://www.postgresql.org/docs/current/sql-createpolicy.html)).
Storage RLS and metadata cannot validate decoded bytes/dimensions, SHA256,
caption correctness or AI provenance. The future server must verify image bytes
before claim, render the captioned artifact, and verify its bytes before finalize.
Never claim that the asserted `verified_input_sha256` alone proves byte identity.

For history, use a future guarded same-origin media handler: call
`requireSuperadmin({ onDenied: 'throw' })`, select authorized run columns, choose
the recorded input or succeeded output, download using the user's Storage client,
and return a verified image type with `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`. Do not accept an arbitrary path/URL. Short-lived
signed URLs are bearer capabilities and remain usable until expiry; the guarded
handler is the preferred strict superadmin-access design. No retrieval route is
implemented in this step.

## Failure boundaries and rollback

Database preparation and each transition are separate atomic transactions.
Unexpected SQL errors roll back the whole RPC, including child writes. Valid
failure operations intentionally commit partial successes plus a terminal error.
There is no transaction spanning PostgreSQL, Storage and an AI provider. A
timeout/lost HTTP response can leave an ambiguous or paid provider attempt;
leases make it observable, not exactly-once billable. Do not automatically retry
model calls or resume a claimed invocation. Re-reading a terminal run is safe.

For a **non-destructive disable**, stop future application callers, then manually
review a transaction revoking authenticated EXECUTE on the two mutation RPCs and
changing only `pc_execution_insert_guard` to:

```sql
BEGIN;
REVOKE EXECUTE ON FUNCTION public.prepare_prompt_chain_run_v1(uuid, uuid, text, bigint, text, text) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.advance_prompt_chain_run_v1(uuid, text, text, jsonb) FROM authenticated;
ALTER POLICY pc_execution_insert_guard ON storage.objects
  WITH CHECK (bucket_id <> 'prompt-chain-execution-media');
COMMIT;
```

Keep SELECT RLS, the private bucket and all restrictive guards. Merely dropping
the new permissive policy is insufficient if an older broad policy grants INSERT.
Preserve tables/history/media. If a migration fails before COMMIT it rolls back
its own objects; it does not roll back a separate manual bucket API operation.

If only the first migration was installed, revoke the two RPCs in a separate
reviewed transaction without attempting to ALTER a nonexistent Storage policy.

For complete removal, first stop callers and verify/export retained records and
referenced media with authorization. Remove physical objects and the bucket using
the Dashboard/API during an explicitly approved maintenance window. Only after
the bucket is absent may the six new policies be dropped safely. Remove the media
helper, the two mutation RPCs, child table, parent table, then the superadmin helper
with exact signatures/names from the migration and **without CASCADE**. This is
destructive if records exist and is not an automatic rollback. Never remove or
reinstall v1/v2, source tables, mix configuration or profile-protection triggers.

## Verification limits

`tests/execution-persistence.test.mjs` checks the prepared permission/scope
contracts and an isolated behavioral state model. It is not a PostgreSQL engine
or a replacement for RLS/Storage/concurrency tests. SQL/PLpgSQL parsing does not
resolve live relations, function calls, privileges, trigger behavior or policies.
No migration, live SQL, Storage upload, provider call or browser execution is run
by those tests. Follow `EXECUTION_TEST_PLAN.md` in an approved isolated environment
after independent installation review; do not point mutation tests at production.
