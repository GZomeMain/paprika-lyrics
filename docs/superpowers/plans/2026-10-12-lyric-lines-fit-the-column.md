# Lyric lines must fit the column — Implementation Plan

> **Status: SHIPPED** (2026-10-12). Every step is done and verified; the "Verification
> results" section at the end records what was measured, including the two mechanisms that
> the first attempt got wrong.

**Goal:** no lyric glyph is ever drawn outside the lyrics column, at any window size,
zoom, font, alignment or fullscreen state. Today a line whose widest unbreakable run is
wider than the column is clipped by `#lyrics-container { overflow-x: clip }`: the tail of
the line just disappears (the user's "a word or two goes beyond the screen").

## The defect, measured

Real page, real `loadLyrics` payloads, measured in a browser (`#lyrics-container`'s
`overflow-x: clip` means anything past the column is cut, not scrolled):

| viewport | state | column | font | line | overflow |
| --- | --- | --- | --- | --- | --- |
| 1400x900 | fullscreen | 1300px | 51px | `Supercalifragilisticexpialidocious…` (one word) | **+243px** |
| 1400x900 | fullscreen | 1300px | 51px | a 28-character CJK line | **+91px** |
| 1400x900 | zoom 48px | 1300px | 48px | same long word | **+152px** |
| 330x380 | windowed | 270px | 30px | same long word | **+638px** |
| 330x380 | fullscreen | 270px | 51px | 8-character CJK word | **+142px** |

Ordinary text is fine: lines **do** wrap (a 12-word line wrapped to 2 rows and came within
48px of the column). Only a run with nothing to break at overflows — a long word, or a
script that does not use spaces (line-synced CJK, where the whole line is one word). The
inactive-line DOF scales are 0.935–0.98 (smaller, not larger), so "not being highlighted"
lines are not being grown by anything.

## What shipped

1. **A word that cannot fit the column wraps between its syllables, at full size.**
   `fitLyricLines` (`ui/app.js`) marks such a word `.is-wrapped`, which makes it a block of
   its own with `flex-wrap: wrap` (`ui/style.css`), and its syllables become the rows. The
   first attempt kept it an inline-flex with `max-width: 100%`; that measured wrong in a way
   worth recording — an inline-flex that wraps is sized by its `max-width` while the inline
   layout places it by its width, so it was put on a row with too little room left and its
   rows painted past the column (at 330x380: a 230px box laid out 12px over the edge). As a
   block it starts its own row, its rows are the only thing on them, and the inline content
   around it keeps its order in the anonymous blocks on either side. `flex-shrink: 0` on the
   syllables stops the flex algorithm squeezing a long word into a sliver instead of wrapping.
2. **A script that writes no spaces gets syllable boundaries to wrap at.**
   `splitWordSyllables` splits a token in `SPACELESS_SCRIPT` (kana, ideographs, Hangul,
   Thai, Lao, Khmer) per character, which is the granularity it is read at and the same one
   the host's word-synced data uses. Without it a line-synced CJK line was ONE syllable and
   could only be scaled — at 9px for a 28-character line, i.e. unreadable.
3. **A single syllable that still cannot fit is scaled**, never clipped: `--line-fit` is a
   ratio written per line and multiplied into the shared lyric size in CSS, so the
   translation layer and backing-vocal sizes follow it and a zoom, a fullscreen multiplier
   or a font change keeps composing on top. Measured against the column MINUS one space
   (a preserved space hangs at the end of its row and the word after it is laid out from
   there, so a word that only fits when it starts the row does not fit at all — measured:
   a 269px word in a 270px column, 9px over the edge). 7% headroom covers the active line's
   own 1.025 scale and a sung syllable's 6.5% pop.
4. **The measurements are canvas metrics, not layout reads.** A syllable is an inline-block
   laid out at its own advance width, which is what `measureText` returns for it — verified
   against the DOM within 1px on every probe line (the first canvas attempt was 2x wrong
   because `syllable.textContent` counts the base AND highlight copies). Nothing is laid out
   to be fitted, so the half of a 400-line song that `content-visibility: auto` deliberately
   skips stays skipped. Widths are cached per line against the type (size/family/weight),
   because they do not depend on the column: a resize re-decides with the cached numbers
   (0.5ms for 400 lines) instead of re-measuring on every frame, and the resize hook is a
   140ms trailing debounce since the text re-wraps natively while the edge is dragged.
5. **The column's right inset is now proportional** (`max(32px, 3%)`). It is the room the
   scaled active line needs (2.5% of the column + its 2px lean); a flat 32px was that room
   for a column of ~1280px and nothing wider, so on a wide window the active line's last
   glyph landed outside the window. The 32px floor keeps narrow windows as they were, and
   the harness now asserts the *rule* (the inset covers the overshoot) instead of the literal.

## Verification (as run)

| Check | Command | Result |
| --- | --- | --- |
| UI regression | `node tools/run-ui-preview-regression.mjs` | **PASS 5/5 viewports, 318 checks each** (was 309) |
| Syntax | `node --check ui/app.js tools/ui-preview-regression.js` | OK |
| Full suite | `python -m unittest discover -s tests` | **568 tests, OK, exit 0** |
| Live sweep | real page: 5 font families × 4 zooms × 3 alignments × windowed/fullscreen | see below |

The new regression section loads real payloads (a 102-character word, a 28-character
line-synced CJK line, a translated line, a Cyrillic word that is one unbreakable syllable)
and asserts, at every viewport, in the idle and the sung state and in two faces: no glyph of
a line at rest is past the column, and no glyph of the line being sung is past the window.
It also asserts the fixture still exercises the path (the long word's syllables are wider
than the column and the line is taller than one row, the CJK line has more than 8 syllables),
so the section cannot pass for free.

**Live sweep (real page, real Windows font bytes: Georgia, Impact, Broadway, Consolas,
plus the default stack):** 40 configurations, **worst glyph 24px inside the window** in all
of them; no line at rest past the column; the smallest fit applied was 0.35 (a 28-character
CJK run in a 270px column) and ordinary songs get no fit at all (0 fitted lines out of 400).
The wipe still runs on a word-synced payload — the active line is found, syllables reach
their `passed`/`singing` states, and the playhead keeps every glyph inside the window.

## Deliberately not in this plan

- **Splitting a word across rows without wrapping.** Turning the syllable `inline-block` /
  word-group architecture into breakable inline content would put the karaoke wipe and the
  per-word motion at risk for a defect that wrapping already fixes.
- **A global font-size ceiling.** Shrinking every line to the narrowest window's width would
  change every song's look to fix a rare line.
- **A horizontal scroll for the long line.** The scroller is vertical, and a sideways scroll
  in a karaoke overlay is not a gesture anyone expects.
- **Making the active line's scale proportional to the gutter instead of the gutter
  proportional to the scale.** The emphasis is a design choice with a settled look; the
  inset is what had to follow it.
