# Chain-specific generation history — Step 7G.1

`/history` is workspace item 04. `/history?chain=<UUID>` scopes the gallery to the
immutable original prompt-chain ID; every existing chain detail page links there,
including the read-only system chain. `/history/<run UUID>` shows the complete
saved captions, captioned PNG, browser-local creation/completion times, download, chain
history and Generate links. Deleted chains retain their history without a broken
live-chain link. History is readable even while live generation is disabled.

Both pages independently call `connection()` and `requireSuperadmin()` before
reading filters or records, in addition to the existing protected layout. Auth
verification, Google identity and the current strict database superadmin flag
remain unchanged. The existing proxy sets private/no-store browser/CDN response
headers; the session client's database fetches also use `no-store`. No `use cache`,
public prerendered record, privileged client or new API permission is introduced.
The installed history RLS intentionally allows **all current superadmins** to
read saved runs across creator accounts. No creator-only filter is invented.

History dates use `LocalDateTime` and the small `dates.ts` formatter. SSR and
initial hydration render an identical loading placeholder; after hydration,
`Intl.DateTimeFormat` uses the viewer's browser timezone with a short zone name
(such as EST/EDT, or an Intl-provided GMT offset where abbreviations are unavailable).
The formatter is created in the browser rather than cached on the server; no
environment variable is changed. Daylight saving and calendar-date conversion come from Intl.
Invalid, absent or timezone-less timestamps show `Unavailable`. Original values
remain in the semantic `time` element's `dateTime` attribute; database values,
query ordering and the chain-directory date formatter are unchanged.

## Query and integrity boundary

`data.ts` accepts only a previously authorized session client. Its fixed-column
query reads `prompt_chain_runs`, requires `status = 'succeeded'`, non-null final
text/completion/path/digest/size, and a size from 1 through 5,242,880 bytes. It
orders by `created_at DESC, id DESC`, matching the existing per-chain history
index when filtered. It never accepts caller columns, sort syntax, creator IDs,
Storage paths or model/provider fields.

Each page fetches **12 rows plus one lookahead**, without a full COUNT or loading
all runs. Page numbers must be integers from 1 through 10,000; filters must be
single canonical UUID values. Malformed values/arrays are rejected before record
or chain-directory queries. Previous/Next retain the chain filter. The small
controlled client selector navigates immediately using the existing `historyHref`
helper and Next router, with no Apply button. Selecting a chain resets pagination
to page one; selecting All or Clear filter navigates to `/history`, removing both
chain and page parameters. The value comes from the server-parsed URL rather
than local/default state, so Clear, refresh and Back/Forward stay synchronized.
The maximum page suppresses Next and suggests refining
the filter. Offset pages reflect the current database contents; new successful
runs can shift page boundaries between requests. Reload page one for the newest
entries rather than assuming a frozen browsing snapshot.

Runtime projection independently verifies status, run/original/live-chain UUIDs,
the exact `<creator snapshot UUID>/<run UUID>/captioned.png` receipt path, SHA256,
size, valid ordered timestamps and complete nonempty UTF-8 output. The existing
output validator checks the default chain's exact caption JSON; custom formats
remain literal. Output is at most 32 KiB; saved names/slugs are capped at 2,048 /
256 UTF-8 bytes. Inconsistent rows fail closed. Malformed rows within a page's
12 raw slots are hidden with a notice; the query does not scan additional pages
to fill holes. A malformed-only page can therefore be empty with Next available.
Full-generation lookup applies the same checks, with distinct missing, invalid
and unavailable states, without leaking database/provider errors.

Only the following display DTO leaves the server-side data layer: run ID,
original/current chain IDs, saved chain name/slug, creation/completion times and
exact final text. Receipt paths, digests, sizes, creator IDs, lease information,
prompts, context and provider diagnostics are not passed to client components or
rendered into HTML. Gallery caption excerpts are explicitly labelled previews;
full output remains intact in the full view, with separate Caption A/B for the
default format and an exact JSON disclosure. React renders all content as text.

The filter reuses the current chain directory once per page, including its
existing metadata pagination. The directory's current names label live filter
options; each gallery/detail entry always uses its historical saved name. Visible
archived snapshots add filter choices too. A selected archived chain on an empty
page needs at most one additional one-row name lookup. If the directory is
unavailable, history remains usable with a clear partial-data notice. Unknown
valid UUIDs show an empty state, never guessed chain identity.

## Private PNGs and presentation

Every preview and download uses the existing guarded
`GET /api/generation/runs/<run UUID>/media` endpoint. Download adds only
`?download=1`. Thumbnail requests are lazy, full-view images load normally, and
Next Image is explicitly `unoptimized` to bypass the image optimizer/cache.
There is no public bucket URL, signed URL, browser Storage client or copied
private object path in this feature. Failed image loads show a useful fallback
and an explicit retry button that re-requests only this authenticated endpoint.

Successful status plus its receipt is the installed database's confirmation of
artifact persistence. History does not issue an extra Storage probe for every
card. The media endpoint independently bounds/decodes/hashes the actual PNG on
each retrieval. A privileged out-of-band object deletion/corruption therefore
produces the image-unavailable state rather than an invented image or a claim
that a PNG was revalidated by the metadata query.

The gallery uses the existing page container, compact headers, cards, borders,
buttons, typography and semantic dark/light/system colours. It has one column on
small screens, two at `sm`, and three at `xl`; full views place image/text side by
side on large screens. Images use contain sizing because the installed schema
does not store artifact width/height. Labels, alt text, focus styles, the native
select control and status/error feedback preserve keyboard access. Generic
loading/not-found pages contain no saved record information. No global CSS,
appearance logic, Generate page or editor behavior was redesigned.

## Validation and remaining checks

`tests/history.test.mjs` runs actual data/model/page/gallery modules against
mocked Supabase and framework boundaries. It covers role/session denial and
reauthorization, creator-independent visibility, original-ID filtering, renamed
and deleted chains, safe pagination/order/boundaries, receipt/output validation,
empty/error/partial states, protected media URL construction, escaped full
captions, chain-detail entry points and active navigation. No live query,
mutation, Storage operation or provider request is used by these tests.

The installed contract provides all required history fields; no SQL, policy,
bucket, dependency, credential or feature-flag change is needed. The unfiltered
newest-first query has no dedicated global-created-time index in migration 003;
measure it at real data volume before proposing an index separately. Live RLS /
Storage compatibility, Vercel behavior, mobile/theme layouts, keyboard/screen
reader interaction and image failures still need approved manual validation.
Live generation remains default-off and requires separate approval/configuration.
