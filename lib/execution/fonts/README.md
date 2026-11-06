# Bundled renderer font

Unmodified `NotoSans-Regular.ttf` (569,208 bytes), redistributed under the included
SIL Open Font License (`OFL.txt`).

- Source: https://github.com/notofonts/noto-fonts/blob/main/hinted/ttf/NotoSans/NotoSans-Regular.ttf
- License: https://github.com/notofonts/noto-fonts/blob/main/LICENSE
- SHA256: `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`

`coverage.ts` was generated from this exact font's Unicode cmap, selecting only
codepoints with nonzero glyph IDs and merging adjacent codepoints into ranges.
The renderer verifies the font digest once per module instance and checks text
against that manifest before rendering. Updating the font requires regenerating
and reviewing its coverage/digest together; no runtime font download occurs.

Coverage includes Latin/extended Latin, Vietnamese, Greek, Cyrillic, combining
accents and common punctuation/currency. CJK, emoji and many other scripts/symbols
are **not included** and fail with a sanitized artifact error. No host-font
fallback or missing-glyph boxes are accepted. Expanding coverage is a deliberate
future asset/layout change, not a network lookup or silent character substitution.

`fonts.conf` makes native Fontconfig discover only this directory. Before the
first text operation, the renderer sets process-local `FONTCONFIG_FILE` to this
fixed bundled config. It does not inspect or modify any environment file. Native
font caches use `/tmp/caption-arena-font-cache-v1` on the supported macOS/Linux
Node hosts; the runtime needs a writable `/tmp`. Next output tracing explicitly
includes the font and config for the execution endpoint. Pango markup disables
fallback too, so it cannot select external/system/user fonts for model text.
