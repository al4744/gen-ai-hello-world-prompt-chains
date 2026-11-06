# Production captioned-image renderer — Step 7F.1

`createCaptionRenderer()` implements the existing server-only `ArtifactRenderer`
interface using the pinned Sharp dependency. The production execution factory
injects it by default; no parallel runner, renderer service, browser code or new
dependency was introduced. It returns real newly composed PNG bytes.

## Layout and display interpretation

The artifact is theme-independent: off-white paper, a muted Caption Arena label,
the uploaded photo and distinct light-grey caption panels with dark text, subtle
borders, 16px corners and balanced padding. Width is 1,200px. The image fits within
1,104 × 1,000px, centred, EXIF-oriented and resized proportionally without cropping
or stretching. Landscape, portrait and square inputs share the same layout.
Transparent inputs are flattened onto the neutral photo background. No original
metadata or EXIF orientation is copied to the final PNG.

- **Default/composed:** revalidate the exact two-key caption JSON and render
  `caption_a` and `caption_b` in panels labelled CAPTION A and CAPTION B, under
  one shared image. These are two alternatives from one composed AI invocation.
- **Custom/sequential:** each nonempty logical line is a panel labelled OUTPUT 1,
  OUTPUT 2, etc. Single-paragraph text is one panel; five newline-separated short
  captions are five panels. Existing list numbers/bullets and punctuation remain
  literal. JSON/Markdown/HTML are displayed as text without parsing, evaluating,
  executing, rewriting or making an additional AI call.
- Display-only normalization converts CRLF/CR to LF, tabs to four spaces, Unicode
  to NFC, trims panel-edge whitespace and ignores custom blank lines. Default
  captions retain internal newlines. The raw final output, including the default
  JSON and its whitespace, is unchanged in the database and renderer input.

Body type is fixed at 30px (72 DPI); labels are 16px, masthead 18px. Pango performs
actual font shaping and word/character wrapping, including long words. A bounded
auto-fit preflight checks whether text can fit at the chosen readable size; the
final raster uses the fixed size, never reduced type or ellipsis. Pixel bounds
are checked before panels are placed. Text does not become SVG: every model
string is XML-escaped in Pango markup. The background SVG contains only fixed
geometry and colours, with no URLs, external resources, entities or model text.

## Explicit safe limits

- At most 12 panels, 6,000 normalized codepoints in total, 24 logical lines per
  panel, and 16 codepoints per grapheme cluster. Existing 32 KiB output validation
  remains in place. Invalid controls and bidi overrides are rejected.
- Body text is at most 1,040 × 750px per panel. Auto-fit preflight constrains
  native text allocation; text requiring shrinkage below 30px is rejected. Total
  artifact height is at most 3,200px (3.84 million canvas pixels).
- Existing validated input limits remain 5 MiB, 20 million pixels and 8,192px per
  dimension. Photo intermediates are at most 1,104 × 1,000px. Text/photograph
  rasters are processed sequentially. No unbounded original-size canvas is made.
- Each native operation has a two-second timeout, and the renderer checks its
  monotonic 4.5-second overall budget between operations. The existing engine's
  five-second render bound and AbortSignal remain authoritative. Abort destroys
  active Sharp pipelines; native cancellation is best-effort, and the engine
  rejects late results rather than finalizing them.
- Final output is lossless PNG and must be at most **5,242,880 bytes**. Excess
  output is rejected without lossy fallback, truncation or automatic re-render.

The [bundled, licensed Noto Sans](fonts/README.md) supports Latin, Greek, Cyrillic,
accents and common punctuation. Emoji, CJK and unsupported glyphs fail explicitly;
this phase does not claim universal Unicode coverage or render missing-glyph boxes.
Oversized, unsupported, illegible, malformed or failed rendering raises a fixed
sanitized `artifact_error`. Exact model output remains saved even when rendering
fails, so no text is silently lost from history.

## Safety gate and persistence

Actual execution is **disabled by default**. Only a deferred server lookup equal
to the literal string `PROMPT_CHAIN_GENERATION_ENABLED=true` enables it. Missing,
empty, other case, whitespace, booleans or other truthy values do not. No public
flag is exported and no environment file was changed or inspected. This is an
operator gate, never an authorization substitute.

The execute endpoint first performs its existing superadmin verification and
request/Origin/JSON validation. When disabled, it returns HTTP 503,
`status: 'unavailable'`, `error.code: 'generation_disabled'`, without constructing
the engine, loading a run, reading credentials, accessing Storage, claiming or
calling a provider. Preparation, uploading and read-only status remain available.
The production factory also checks the gate in provider configuration before
input download or claim, protecting a future direct server caller. It leaves an
owned prepared row prepared. Low-level DI engines are internal/offline-test
primitives and do not read runtime configuration themselves.

When enabled in a separately approved environment, the existing engine still:
authorizes; downloads/decodes/hashes the private original; claims through the RPC;
performs accepted database-backed steps; renders persisted final text; independently
validates and hashes the real PNG; uploads to the fixed private artifact path
with `upsert: false`; finalizes via RPC; and reads back persisted success and
matching text/artifact digest/size. Rendering/upload/validation failure never
finalizes or erases earlier model results. Duplicate or ambiguous work is never
automatically replayed. The free model, 120-second lease and all existing RPCs
are unchanged. No dummy artifact or provider fallback is supplied.

## Offline verification and remaining integration

Tests use actual Sharp/font/image decoding with synthetic images, mock provider
responses and mock Supabase/Storage. They check both captions, five custom lines,
all image orientations, wrapping/Unicode, escaping, pixel geometry, size caps,
failures, persistence/finalization, disabled execution and duplicate requests.
Enabled scenarios inject the literal flag into an isolated VM only; the real
process flag and credential remain untouched. Fontconfig alone is configured
inside the renderer test child process for native font discovery.

Step 7F.3 adds two genuinely fresh Node children with an empty environment,
including no `FONTCONFIG_FILE`, `FONTCONFIG_PATH`, credentials or generation flag.
They import real Sharp and exercise image validation/encoding both before and
after loading the renderer module. A narrowly checked VM-loader hook forwards
only the renderer's own fixed `FONTCONFIG_FILE` write to the native child process;
neither child is externally preconfigured. Tests verify bundled-only font
discovery with fallback disabled, visible Latin/accent/punctuation caption pixels,
a valid bounded PNG, no Fontconfig diagnostics and zero network calls. These
local cold-start cases passed without changing production initialization. Native
Vercel/Linux runtime behavior and writable `/tmp` still need deployment validation;
the production output-file trace is checked separately for both bundled assets.

No real AI request, live Storage upload, SQL or Supabase change was performed.
Browser generation forms, media retrieval and history gallery remain future
work. Before approved live testing, review quotas/spending, host duration/native
font bundle, and installed RLS/RPC compatibility. The existing staged-artifact
read restriction, possible private orphan after interrupted upload, and lack of
server-only AI-provenance attestation in the creator-JWT RPC model remain unchanged.

Implementation references: [Sharp text constructor](https://sharp.pixelplumbing.com/api-constructor/),
[font discovery](https://sharp.pixelplumbing.com/install/#fonts), and installed
Next.js output-tracing documentation. No hosted renderer resources are used.
