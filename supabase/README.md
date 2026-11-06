# Step management RPC — review required

For the separate **unapplied Step 7C.1 execution persistence proposal**, see
[EXECUTION_PERSISTENCE.md](EXECUTION_PERSISTENCE.md). It does not replace either step-management RPC.

The user confirmed that `migrations/202611050001_step_management.sql` was manually installed after Step 6B and its CRUD/arrow operations were live verified. The original implementation session did not execute it; the validation history below describes that session. Existing step writes continue using this installed v1 function. Step 6C's arbitrary drag moves use a separate, **unapplied** additive migration documented in [DRAG_REORDERING.md](DRAG_REORDERING.md). Neither migration was executed by this development session.

## Review the live schema first

`verification/step_management_preflight.sql` contains only SELECT queries. It lists the actual unique constraint's name, `condeferrable`/`condeferred`, all CHECK definitions, column defaults, authenticated grants, RLS policies, triggers, and existing ordering gaps. It also inspects the installed function's security/grants after manual installation. These queries have not been run against Supabase here.

Confirm:

- The unique constraint is on exactly `(chain_id, step_order)`. The migration verifies its existence without assuming its name. Both immediate and deferrable uniqueness are supported; no `SET CONSTRAINTS` or constraint changes are used.
- `step_order` is a positive integer with no additional upper bound below the integer type's maximum. Temporary positions can exceed the final step count. Inspect additional CHECKs, unique indexes, triggers, and inbound step references before applying; unexpected restrictions must be addressed in the algorithm, not silently removed.
- `id` has a working UUID default. Name/template constraints and any numeric limits match the supplied schema. Application input caps (120 UTF-16 units for names; 100,000 for templates) are request guardrails, not claimed database limits. Exact database name-length parity remains unverified until the CHECK definitions are inspected.
- RLS permits superadmins to read **all** steps of the selected chain and update/delete them. The function's caller can SELECT `profiles.id/is_superadmin`, the parent `id/slug`, and step fields. INSERT is limited to `chain_id`, `step_order`, `name`, and `prompt_template`; UPDATE uses only `step_order`, `name`, and `prompt_template`.
- The authenticated role already has UPDATE privilege on at least one parent-chain column for `SELECT ... FOR UPDATE`. Existing chain CRUD's column-specific grants normally meet this requirement. Child row locking also needs an UPDATE column privilege, provided by the stated step grants. No broader table UPDATE grant is proposed. If either privilege is missing, report it and review the smallest column-level grant separately; do not replace this with `SECURITY DEFINER`.

## Function security and contract

The only new database object is `public.manage_prompt_chain_steps_v1(uuid, text, jsonb, uuid, text, text, text, text) RETURNS uuid`. Supported operations are `create`, `update`, `delete`, `move_up`, and `move_down`. It is VOLATILE, SECURITY INVOKER, uses `search_path = pg_catalog`, schema-qualified relations, `row_security = on`, and a five-second lock timeout. Default/unwanted execution grants are revoked from PUBLIC, anon, authenticated, and service_role before granting EXECUTE to authenticated only. Existing table grants and policies are untouched.

Every call checks `auth.uid()` and `profiles.is_superadmin IS TRUE`, locks the parent, and rejects `caption-arena-default`. It then locks that chain's steps in UUID order. A non-create target must belong to the locked parent. The complete expected ID/position snapshot must match the database, with no duplicates. Edit/delete additionally compare the selected step's original name and literal template. No client-supplied role or superadmin flag is accepted. Server Actions independently repeat the existing `requireSuperadmin()` guard and parent/ownership checks before the RPC.

The RPC is called by POST, in one PostgREST transaction. Create appends, edit changes only one step's name/template, delete removes only its selected step, and adjacent moves preserve every ID and prompt. The function never writes the parent chain, the default chain, mix entries, media, or history.

## Ordering and concurrency

All new step operations use the same parent-first locking protocol, including content edits. Existing parent-chain updates/deletes naturally acquire conflicting row locks. The parent FOR UPDATE lock also conflicts with foreign-key key-share locks from concurrent inserts. Every expected order is rechecked **after** acquiring the locks; an outdated operation raises SQLSTATE 40001 and the UI asks the user to refresh. A content edit preserves the existing position, including existing gaps. Create/delete/move normalize to contiguous 1-based positions.

For a final count N, choose N currently unused temporary positions in `[N+1, 3N]`. This interval contains 2N positions and at most N occupied positions, so N free slots exist. They are disjoint from both existing rows and final positions `[1,N]`. Move every affected row to its reserved slot, then assign final positions. This avoids immediate uniqueness collisions without assuming that `max(step_order) + N` fits in an integer. The function checks integer capacity, affected row counts, final IDs, and contiguous ordering. Failure at any point aborts the whole transaction; no exception handler commits partial work.

The coordination guarantee applies to callers using this RPC. Existing roles retain their direct table privileges as required. Unrelated clients performing direct child UPDATE/DELETE after this transaction commits can still introduce gaps; without changing their write paths or grants, this function cannot globally prohibit later non-cooperating writes. Visible conflicting snapshots are rejected and later order-changing RPCs normalize gaps. Do not describe this as a global database invariant enforced against every possible client.

Relevant primary references: [PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html), [SELECT locking privileges](https://www.postgresql.org/docs/current/sql-select.html), [immediate constraints](https://www.postgresql.org/docs/current/sql-set-constraints.html), [Supabase function security/grants](https://supabase.com/docs/guides/database/functions), and [PostgREST transactions](https://docs.postgrest.org/en/stable/references/transactions.html).

## Verification performed and outstanding

The migration and the read-only verification file are syntax-checked using a temporary PostgreSQL parser installed under `/tmp`; SQL and PL/pgSQL parsing does not execute migrations or resolve actual tables/privileges. PostgreSQL itself is not installed in the execution environment. No database-function integration test, live RLS/grant test, or live rollback/concurrency test was performed.

The Node suite runs actual TypeScript Server Actions and pages with isolated SDK/framework boundaries. `tests/helpers/step-transaction-model.mjs` is explicitly a behavioral model, not a PostgreSQL emulator. It checks single-RPC routing, expected snapshots, authorization, cross-chain/default rejection, gapped/maximum positions, injected partial failures, rollback of the model, and concurrent model calls. These results do not prove PostgreSQL execution or locking.

After manual schema review and installation in an approved isolated environment, verify: create/append, content edits retaining positions, middle/last deletion, move step 2 to 1, Move Down, first/last boundaries, refresh persistence, concurrent create/delete/move sessions, deliberately stale snapshots, and injected transaction failures. Confirm default rejection via both the app and direct authenticated RPC, and ordinary/signed-out denial. Compare IDs/names/templates before/after reordering. Verify rollback with an isolated test-only failure trigger; never install such a trigger in production. Verify the actual immediate/deferrable unique constraint and all RLS/grant behavior. No destructive automated tests target live Supabase.

Browser checks remain: cancellation without mutation, draft preservation, pending/double-submission states, clear unavailable-RPC/conflict messages, keyboard controls, 320px/mobile and desktop layouts, long templates, and Dark/Light/System modes.

## Safe rollback guidance

Revert the application to its previous read-only step UI or accept unavailable-RPC feedback first. After reviewing active callers, manually remove **only** the new function:

```sql
DROP FUNCTION public.manage_prompt_chain_steps_v1(uuid, text, jsonb, uuid, text, text, text, text);
```

This is guidance, not an executed migration. Do not use CASCADE. No table, constraint, policy, data, or pre-existing grant is dropped or restored. Dropping the function does not undo previously committed custom-step changes; valid ordering remains in the existing table. If installation fails before COMMIT, PostgreSQL rolls back the function/grant changes together.
