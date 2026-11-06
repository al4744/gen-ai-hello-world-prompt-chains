# Step 6C: additive drag reordering

The user confirmed the installed v1 RPC and Step 6B workflows work against Supabase. They remain the path for step CRUD and arrow moves. **Only arbitrary drag moves require the new, unapplied migration** `migrations/202611050002_drag_step_reordering.sql`.

## UI and request behavior

Custom chains render a left rail containing an up chevron, six-dot handle (2 columns × 3 rows), and down chevron. Native arrow buttons remain keyboard/touch accessible, expose descriptive names, and disable at the first/last boundary. There are no interactive reorder controls on system-chain steps.

`@dnd-kit/react`/`@dnd-kit/dom` 0.5.3 provide pointer/touch activation, handle-only gesture initiation, Escape/pointer cancellation, a compact drag overlay, and viewport/ancestor auto-scrolling. Mouse/pen activation requires 6px movement; touch uses a 180ms hold with 8px tolerance. Only the handle disables native touch scrolling. Keyboard users use the up/down buttons. Drop animation is disabled and the application's reduced-motion rules remain effective.

Rows stay in their confirmed positions during hover. The insertion line measures actual row midpoints and boundaries, including expanded templates, and updates during scrolling. Before-first and after-last are real target slots. The source row remains in the measured list, so the gap index is converted to the destination **after removing the source**. The line and marker use the primary semantic color (white in Dark, charcoal in Light). The step UUID identifies the drag source throughout.

Hover, Escape cancellation, an outside-list release, and same-position drops make no save request. A completed changed drop calls `reorderStep` once, and it calls v2 once. An arrow calls the existing `moveStep`/v1 once. There is no repeated-adjacent-move or direct-table fallback. A shared pending lock disables every reorder control and guards against duplicate events. React `useOptimistic` previews the completed move while saving; failed saves revert to server-confirmed props and show inline feedback. Stable UUID keys retain native expanded details panels across optimistic moves and server revalidation. Cancellation does not toggle details because handles are outside summaries.

When v2 is missing, an inline message explains that arrows remain usable. This does not mark all step management unavailable.

## SQL compatibility and review

The migration creates only `public.reorder_prompt_chain_step_v2(uuid, uuid, integer, jsonb) RETURNS uuid`, plus its function-specific permissions/comment. It never drops/replaces v1 and changes no tables, constraints, policies, or existing records at installation. It is VOLATILE, SECURITY INVOKER, schema-qualified, with `search_path = pg_catalog`, `row_security = on`, and a five-second lock timeout. Unwanted default grants are revoked before granting EXECUTE only to authenticated.

Every invocation rechecks `auth.uid()` and `profiles.is_superadmin IS TRUE`; locks the parent first; rejects `caption-arena-default`; then locks that parent's steps in UUID order. This matches the repository's installed-v1 source protocol. It validates unique complete ID/position snapshots, ownership, and an integer destination in `1..N` after locking. Changed snapshots raise 40001; invalid/missing inputs and permission failures roll back safely. Same-position requests are no-ops even if called directly.

The function removes the target UUID from the ordered array and inserts it at the requested 1-based destination. It reserves N unused positive slots in `[N+1, 3N]`, moves all rows there, then assigns `[1,N]`, checking affected rows and final ordering. This works with immediate uniqueness, existing gaps, and an old INT_MAX position without assuming space exists above the maximum. Integer capacity is checked. Only `step_order` is updated: UUIDs, names, and literal templates remain untouched. One RPC is one transaction; an exception rolls back both temporary phases. v1 and v2 serialize on the same parent lock.

Review `verification/drag_reordering_preflight.sql` manually before installation. It only SELECTs function definitions/security, constraint deferrability, relevant column grants, RLS, and triggers. Confirm the live v1 lock protocol matches the source, the unique key is `(chain_id, step_order)`, and no extra position bound or trigger conflicts with temporary positions or changes step content. The already-working v1 column grants should suffice: SELECT of profiles/parent/steps and UPDATE(step_order), with at least one parent UPDATE column privilege for row locking. No wider grant or SECURITY DEFINER switch is proposed. Existing unrelated direct table writers do not automatically adopt this cooperative locking protocol; the limitation documented for v1 still applies.

Primary references: [current dnd-kit React API](https://dndkit.com/react/quickstart/), [sensors](https://dndkit.com/react/guides/sensors/), [PostgreSQL locks](https://www.postgresql.org/docs/current/explicit-locking.html), [immediate uniqueness](https://www.postgresql.org/docs/current/sql-set-constraints.html), and [Supabase invoker security](https://supabase.com/docs/guides/database/functions).

## Validation limits and manual checks

The migration is syntax-parsed (SQL and PL/pgSQL) without execution. Node tests use actual Server Actions plus isolated SDK/transaction models; they do not prove PostgreSQL execution, RLS, or locking. An isolated headless Chrome fixture runs the actual React component and dnd-kit with mock Server Actions, including mouse and touch, insertion geometry, cancellation/no-op, keyboard arrows, rollback, expanded panels, themes, and auto-scrolling. It does not use Supabase or a real authenticated app session.

After manual review/installation in an isolated database environment, verify first-to-last/last-to-first arbitrary moves, immediate uniqueness, integer/gap cases, cross-chain and default rejection, stale snapshots, concurrent v1/v2 calls, and injected rollback. In the real application verify reload persistence, all themes, physical trackpad/mobile input, screen-reader announcements/focus, expanded panels, and network failures. Until v2 is installed, verify the unavailable-drag message and functioning v1 arrows. No live mutation tests or migration execution were performed during this implementation.

## Rollback guidance — not executed

After reviewing active callers, manually remove only the additive function:

```sql
DROP FUNCTION public.reorder_prompt_chain_step_v2(uuid, uuid, integer, jsonb);
```

Do not use CASCADE and do not remove or modify v1. Arrows/CRUD continue to use v1; drag attempts show the unavailable-function message. Dropping v2 does not revert already committed valid custom-chain ordering. An installation error before COMMIT rolls back the new function and its permissions together.
