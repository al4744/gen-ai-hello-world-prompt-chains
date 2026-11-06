# Prompt Chain Tool

The standalone Week 8 Caption Arena superadmin application, with Google OAuth, session management, themes, chain/step CRUD, custom-chain step reordering, and a server-only execution core. The user confirmed installation of the step-management RPCs, execution migrations 003/004, and private execution bucket. Generation entry points, the real artifact renderer, browser UI, and history pages remain future integration work.

See [the Step 7D.1 execution core](lib/execution/README.md) for module contracts, mocked validation, renderer requirements, deadline protections, and installed-persistence limitations. No real AI call or media upload was made during implementation.

Run `npm run dev -- --port 3002`, then visit `http://localhost:3002`.

Required local environment names are `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Keep their values in the existing ignored `.env.local`; no service-role key is used.

## Authentication and authorization

- The browser, server, and proxy share the cookie name in `lib/supabase/options.ts`. Cookies do not distinguish localhost ports, so the app-specific name prevents collisions with the public/Admin development servers. Cookies remain host-scoped; separate deployed hosts require their own login.
- `lib/supabase/proxy.ts` refreshes/verifies tokens with `getClaims()`, propagates cookies to the request and response, and prevents shared/browser response caching. The server client also disables fetch caching.
- `lib/auth/require-superadmin.ts` verifies the current user with `getUser()`, requires a Google identity, and checks that the matching `profiles.is_superadmin` is exactly `true`. Missing profiles, errors, and failed authentication deny access. No authorization result is cached across requests.
- Both the protected layout and dashboard call `requireSuperadmin()` independently. Future protected reads and mutations must call it themselves. Route Handlers can call `requireSuperadmin({ onDenied: "throw" })` and return the safe `AuthorizationError.status` as 401/403.
- `/auth/callback` exchanges the PKCE authorization code through the cookie-aware server client. Success goes to `/dashboard`; failure/denial goes to fixed public destinations. Client-supplied redirect parameters and provider error descriptions are ignored.
- Authenticated non-superadmins see Access denied with a sign-out control. Their session is retained only so they can sign out or change accounts; no protected data is returned.
- Sign-out is a Server Action with `scope: "local"`. Successful cookie removal revalidates the root layout and redirects home. Failures display a generic retry message. Existing public/Admin global sign-out behavior can still revoke this app's refresh session; already-issued access tokens expire according to Supabase's configured lifetime.

In Supabase Dashboard → Authentication → URL Configuration → Redirect URLs, allow `http://localhost:3002/auth/callback` if it is not already allowed. Add a future production host's exact `/auth/callback` URL when that deployment exists. This milestone does not alter hosted configuration.

## Interface

The interface adapts Week 7 Admin's dark zinc background, restrained panels, thin borders, rounded cards, numbered sidebar navigation, Arial body typography/Geist font configuration, and white primary buttons with black text. The sidebar is a compact 240px variant of Admin's 256px layout, with 44px navigation rows, a smaller page title, 24px card padding, and a mobile header. Dashboard cards sit side by side when space allows.

The authenticated application includes a compact segmented theme switcher: Sun (Light), Moon (Dark), and Laptop (System default). It sits immediately above Sign out in the desktop sidebar and at the top-right of the mobile header. Native radio controls provide accessible names, selected states, arrow-key navigation, and visible focus. Dark is the default when no valid preference is saved. Preferences persist in this application's `caption-arena-prompt-chains-theme` localStorage key and synchronize between tabs on the same origin. They also apply to the login and access-denied screens. If storage is blocked, the selected theme works for the current page and the control explains that it cannot save the preference.

`lib/theme.ts` provides validated preference handling and the small inline script in the root `<head>` that applies the saved mode before content paints. Only the root theme attribute opts out of hydration warnings. `components/theme-selector.tsx` synchronizes the radio controls with that attribute through `useSyncExternalStore`. Semantic colors are centralized in `app/globals.css`; System mode uses `prefers-color-scheme` and responds immediately to OS changes without a JavaScript listener. Theme state is independent of authentication. No theme library is required.

## Prompt chain management

- `/chains` lists chains in pages of 50, with metadata, creation dates in UTC, and related step counts where available. The directory includes the original default chain.
- `/chains/new` creates only the name, slug, and description. The database generates the UUID and timestamp; no steps or mix entries are created.
- `/chains/[id]` displays metadata and ordered stored steps with previews and expandable full templates. Custom chains have Add step, Edit, Delete, and a narrow left rail with up/down chevrons and a six-dot drag handle. The default chain remains read-only. Chain `/edit` and `/delete` pages are preserved.
- Every page and Server Action independently calls `requireSuperadmin()`. Reads and writes use its authenticated Supabase client, preserving RLS and column privileges. No chain data is publicly cached and no mutation runs on GET.
- `caption-arena-default` is reserved and read-only. Actions fetch the current record by UUID and reject edits/deletion of the default chain. UPDATE and DELETE also exclude its slug in the mutation query itself. Custom chains cannot be assigned the reserved slug.
- Edit and delete forms carry an original-metadata snapshot. Actions compare it against current data and filter the write by UUID plus original name/slug/description. Concurrent metadata changes produce inline feedback rather than silently overwriting data. Reopen the form to review the latest version; no schema or version column is added.
- Chain deletion first opens a confirmation page. Cancel only navigates. Final confirmation deletes one custom parent row; the existing database foreign keys cascade to its steps and mix entry. Chain CRUD issues no direct child-table, media, or generation writes.
- Forms retain submitted text on validation failure, suppress repeated submissions, and disable submit controls while pending. Duplicate slugs, query failures, permission failures, and missing records produce safe feedback without exposing database errors. Successful writes revalidate chain pages and redirect to fixed internal destinations.

### Validation limits and schema verification

The schema summary confirms required/unique fields, but does not provide the exact CHECK definitions or numeric name-length limits. No schema dump or SQL connector was available in this workspace. Application guardrails currently allow a trimmed nonempty name up to 120 characters, a slug up to 80 characters matching `^[a-z0-9]+(?:-[a-z0-9]+)*$`, and an optional description up to 4,000 characters. These are application limits, not claimed database limits. Database constraints remain authoritative; additional constraint failures return a safe inline message. Confirm the actual definitions before claiming exact validation parity:

```sql
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.prompt_chains'::regclass;

select column_name, data_type, character_maximum_length
from information_schema.columns
where table_schema = 'public' and table_name = 'prompt_chains';
```

These queries are read-only. Do not change schemas, RLS, privileges, or the default chain to perform verification.

## Custom-chain step management

- Add/edit routes are `/chains/[id]/steps/new` and `/chains/[id]/steps/[stepId]/edit`. Step deletion uses a dedicated `/delete` confirmation page identifying name, position, and parent. Cancel is navigation only.
- Every step page and action independently calls `requireSuperadmin()`, validates UUIDs, verifies the parent and ownership, and rejects the system chain. Forms preserve input, validate nonempty name/template, suppress duplicate submission, and disable pending controls. Literal template whitespace is retained; no execution or interpolation occurs.
- Step CRUD and adjacent arrow moves keep using one installed `manage_prompt_chain_steps_v1` RPC per operation. Arbitrary drops use one additive `reorder_prompt_chain_step_v2` call; until v2 is manually installed, drag saves report its absence while arrows remain usable. Hover, canceled drags, and no-op drops never save. No direct-update or repeated-arrow fallback exists.
- The v1 schema/permissions are documented in [`supabase/README.md`](supabase/README.md); the drag UI, additive migration, preflight checks, rollback, and validation limits are in [`supabase/DRAG_REORDERING.md`](supabase/DRAG_REORDERING.md). Do not apply migrations automatically.

## Local checks

```bash
npx tsc --noEmit
npm run lint
npm run build
node --test tests/auth.test.mjs
node --test tests/theme.test.mjs
node --test tests/chains.test.mjs
node --test tests/steps.test.mjs
node --test tests/reordering.test.mjs
node --test tests/notifications.test.mjs
node --test tests/execution-persistence.test.mjs
node --test tests/execution-core.test.mjs
git diff --check
git status --short
```

The Node tests transpile actual modules with isolated SDK/framework boundaries. They do not read environment files, contact Supabase, or modify database records. They cover authentication, themes, chain CRUD, step Server Actions, forms and ordered UI. Step rollback/concurrency tests use a clearly labeled behavioral transaction model; they do not execute the unapplied SQL function or establish PostgreSQL/RLS integration behavior.

## Manual browser verification

1. Open `/` and `/dashboard` signed out; only the login screen should appear.
2. Complete Google OAuth with an existing approved superadmin. Confirm the callback, dashboard email, refresh persistence, and direct `/dashboard` access.
3. Use an existing ordinary account. Confirm Access denied and working sign-out, without any protected dashboard content.
4. Sign out, refresh, revisit `/dashboard`, and use Back. Protected reads must require a new valid session; previously viewed information cannot be erased from browser history or memory.
5. Verify missing/expired callbacks and altered `next` parameters fail safely. Check that sign-in/sign-out failures show retry feedback.
6. Test session expiry/refresh using isolated test sessions, without editing production profiles or privileges.
7. Keep the other Caption Arena apps signed in while signing out here. Confirm their separate sessions remain usable.
8. Inspect mobile/desktop layout (including 320px width and browser zoom), keyboard focus, loading/error states, reduced motion, and long account emails.
9. Tab into the theme switcher and use arrow keys to select each option. Reload with a saved Light preference to check for a theme flash or hydration warnings. Select System default and change the OS appearance while the page is open; both directions should update immediately. Explicit Dark/Light must stay fixed when the OS changes.
10. Verify the preference persists through sign-out and a new login, synchronizes between tabs, and uses Dark for a fresh browser origin. Check the storage-blocked feedback and both themes' login, access-denied, button, and focus states.

11. As a superadmin, browse `/chains`, including the default-chain badge, descriptions, dates, step counts, pagination, and step details. Check all themes at mobile and desktop sizes.
12. Using a disposable custom test chain, create it, test invalid/duplicate slugs, edit metadata, inspect that its steps are unchanged, cancel deletion, then confirm deletion. Check success feedback, preserved entries, keyboard focus, and pending states. No live CRUD test is run automatically.
13. Open edit/confirmation forms in two tabs, change metadata in one, and confirm that the stale form refuses to overwrite/delete. Direct visits to the default chain's edit/delete pages must show a read-only notice.
14. Before v2 is installed, confirm drag saves report the missing update and leave order unchanged while arrows still work. After manual review/installation in an isolated test environment, check arbitrary moves, refresh persistence, v1/v2 concurrency, stale snapshots, default protection, and rollback using `supabase/DRAG_REORDERING.md`.

Live Google OAuth and database policy enforcement require real browser sessions and configuration verification; isolated tests do not establish those outcomes.
