# Execution persistence verification plan

No SQL installation or mutation scenario below was executed by this session.
Use an independently approved, disposable Supabase/PostgreSQL environment with
the reviewed source schema, Auth fixture users and Storage service. Do not use
production users, history, source chains, credentials or files. Never call AI.

## Automated local checks available now

Run the existing Node suite plus `tests/execution-persistence.test.mjs`.
The added tests read the actual prepared SQL for scope/permission contracts and
use a small isolated state fixture for duplicate claims, immutability, context
passing, rollback, failure and media gates. The fixture does not execute SQL or
prove any PostgreSQL, PostgREST, Auth, Storage or policy behavior.

SQL/PLpgSQL syntax can additionally be checked with a temporary external parser,
without applying migrations. Parsing does not resolve table columns, function
overloads, roles, RLS, triggers or privileges. No parser dependency is added to
the application or required by the Node suite.

## Before independently approved installation

1. Save `execution_preflight.sql` results. Resolve all assumptions in
   `EXECUTION_PERSISTENCE.md`, including source fields/types, unique step order,
   profile protections, role/default ACLs, v1/v2 definitions, policy composition
   and Storage owner/size/MIME metadata. Check all new names for collisions.
2. Take test-only snapshots/counts/hashes of source chain/step/mix rows, profile
   protection trigger definitions, installed v1/v2 ACL/definitions, existing
   generation tables, and old Storage policies/bucket settings.
3. In an isolated environment only, approve/install the two additive migrations
   in order; guards precede new bucket creation. Create the bucket using the
   Storage API/Dashboard with the supplied options. No direct metadata writes.
4. Run the read-only post-installation queries. Compare the old-object snapshot;
   only the planned execution objects/new scoped Storage policies may differ.
   A partial SQL failure must roll back the relevant migration transaction.

## Isolated authorization and privilege scenarios

Use anonymous, ordinary Google user, superadmin A, and superadmin B JWTs. Also
test missing profile, NULL flag, revoked superadmin flag and expired session.
Queries from a SQL-editor owner do not substitute for these user-JWT tests.

| Operation | Expected |
|---|---|
| Anonymous/ordinary SELECT run or step history | No rows/access; no private output |
| Anonymous/ordinary preparation or advance RPC | Denied before any row write |
| Current A/B SELECT explicit history columns | Allowed; all-superadmin history |
| Any API-role direct INSERT/UPDATE/DELETE/TRUNCATE | Denied by privileges, independently of RLS |
| Authenticated SELECT lease hash / `SELECT *` on runs | Denied; use explicit allowed columns |
| B advances A's run, even with A's leaked token | Denied; creator checked independently |
| A advances with missing/forged token | Denied, except prepared failure or elapsed expiry |
| A supplies creator/status/path/snapshot/final text/timestamps as payload keys | Rejected; those fields are database-derived |
| Revoke A's flag during execution | Future transitions/media access denied; prior history remains |

Verify helper public execute returns only false for anonymous/ordinary callers,
without profile/table permission errors that break unrelated Storage operations.
Do not temporarily broaden profile SELECT or grant service-role credentials to
make a failed test pass. Verify default function/table privileges did not leak
EXECUTE or column-write access through unexpected role membership.

## Lifecycle and idempotency scenarios

Create only isolated custom-chain fixtures (empty, one-step, five-step,
six-step, gapped positions and large literal templates). Use the pre-existing
default fixture's four sections without modifying them. Generate no AI output;
provide deterministic mock text/usage as the authorized creator.

1. Preparation: validate type/size/hash/context bounds; missing chain, empty/six
   steps or >64 KiB serialized snapshot must create neither a run nor child rows.
2. Same creator/key/input in two sessions: one run/one child set. Changed context,
   image hash/size/type or chain under the same key must conflict. Retry after
   editing/deleting the chain returns the original run and snapshot. Different
   creators with the same key do not share a run.
3. Default: four source snapshots, one invocation, third-section literal binding
   substituted once. Include `$&`, backslashes, braces, another `{{user_prompt}}`,
   Unicode and empty context. Original templates/snapshots must stay unchanged.
   Missing/misplaced default binding or changed section order must fail closed.
4. Custom: gapped live order is preserved in the snapshot and sorted execution;
   positions enumerate invocation order. Templates containing braces are literal.
   Check original image reference/context and all prior accepted results in each
   submitted context. A custom plain-text or custom-JSON final output must work.
5. No input object, wrong owner, MIME/size mismatch, wrong asserted hash: claim
   rejected. The server's actual byte verification remains a later runner test.
6. Two concurrent claim calls: exactly one `accepted: true` and one token. The
   losing request gets no token. One active run per creator; expired old runs
   must be expired explicitly before another claim. Other creators are independent.
7. Two concurrent starts for the same position: only one accepted. Cannot skip
   positions, restart, overwrite completed output or complete an unstarted step.
   A lost claim/start response must never trigger an automatic provider retry.
8. Record mocked usage/actual model/HTTP status and inspect persistence. Optional
   unknown fields are omitted; JSON null, malformed/negative/fractional/oversized
   counts, invalid finish reasons and extra keys are rejected without mutations.
9. Default final output: reject malformed JSON, extra keys, non-string fields,
   whitespace-only captions, or equal captions after edge-whitespace trimming.
   Preserve rejected bounded output and usage, with failed status. Do not enforce
   that JSON shape on custom final output. Accepted output is preserved literally.
10. Fail during a later invocation: previous successes unchanged, active failure
    metadata saved, later rows skipped, run failed. Raw error messages/headers
    cannot be passed through; only fixed sanitized messages are stored. Verify
    input/preparation failures and output/artifact/persistence errors separately.
11. Complete all model invocations without an artifact: cannot finalize. Upload a
    valid PNG to the fixed output path; verify owner/type/size/hash assertion and
    finalize. Check immutable final text comes from the last recorded result.
12. Finalize/fail/start after a terminal state: `accepted: false`, unchanged row
    contents/timestamps/results. Do not describe this as a second execution.
13. Advance the test clock by waiting past the fixed lease (or using test-only
    fixture setup before grants): expired work becomes interrupted/skipped, with
    previous successes retained. No heartbeat extends the 120-second deadline.
    The read-only effective-status query identifies expired rows before repair.
14. Delete a custom step/chain during execution: invocation results/snapshots stay
    intact, live chain FK becomes NULL, original UUID still filters history.
    Running work may finish; a prepared run cannot claim after chain deletion.
    Isolated account deletion nulls the live creator FK without deleting history.

## Transaction/lock fault injection — disposable database only

Use a test-only trigger on a new execution table that raises at a selected write
point. Never install such a trigger in production or modify profile/source
protection triggers. Test failures after parent insertion, child insertion,
complete-step update, final-text update and finalization. Compare full test rows
before/after: the entire RPC must roll back, including lease/child state. Remove
the test-only trigger before other scenarios.

Run simultaneous preparation versus v1/v2 step edit/reorder and parent deletion.
The resulting snapshot must be a consistent version, with source rows unchanged
by preparation. Inspect real waits/timeout behavior and lock ordering. Model
tests do not establish these properties. Verify an unrelated non-cooperating
source writer cannot mutate captured snapshot records, and document that such
writers can still change live definitions after the snapshot transaction ends.

## Storage service scenarios — no direct metadata DML

Use Storage upload/download/list/move/copy/update/remove APIs under each JWT.
Test JPEG, PNG and WebP, oversized bytes, mismatched metadata, SVG/GIF/HTML, wrong
run/user path, arbitrary filename, cross-run reuse and upload after expiry.

- Anonymous/ordinary users cannot list or download the new bucket, even with a
  known path. Guessing a public URL must not retrieve the object.
- Current superadmins can read recorded inputs; outputs are readable only after
  success. One creator cannot upload to another creator's paths.
- Input INSERT is prepared-only; output INSERT requires every invocation succeeded
  and an active deadline. A repeated INSERT, upsert/update, rename/move (including
  across bucket boundaries), copy-overwrite or delete cannot replace accepted data.
- In this isolated environment, deliberately add a broad **permissive** Storage
  policy to demonstrate that new restrictive guards still deny ordinary access,
  overwrite and deletion. Remove this test-only policy afterwards.
- Verify the Public/Admin bucket workflows still work under their existing
  sessions, and unrelated anonymous public reads are not broken by helpers.
- Verify failure/in-flight upload orphans are private and never displayed as
  successful media. Do not install automatic cleanup without retention review.

Later runner tests must decode/verify actual image dimensions, bytes and digests,
cap text/model context/cost, render and verify PNG artifacts, sanitize provider
errors and stream authenticated images with private/no-store/nosniff headers.
The persistence RPC checks metadata and reported hashes, not the physical bytes
or whether an image actually contains the caption. A JWT-authorized mock result
is a test fixture, not evidence of AI provenance.

## Disable/rollback rehearsal

Rehearse the non-destructive disable in `EXECUTION_PERSISTENCE.md`: revoke only new
mutation RPC execution and deny inserts only to the new bucket, retaining privacy
guards/history. Confirm old v1/v2, source CRUD, profile protection and existing
generation tables/buckets are unchanged. Complete deletion requires explicit
data-retention approval and Storage API cleanup first; never use SQL CASCADE.
