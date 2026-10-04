# Song moments, settings reorg, and the fullscreen lyric column — design

Date: 2026-09-30
Status: approved in conversation (tab set, search scope and the moments row were
each chosen by the user); implementation not started.

## Why

Three requests from the same review pass:

1. In fullscreen the lyrics hug the left edge while the track card sits further
   in, so the two read as unrelated columns.
2. The settings sheet has grown to six stacked groups. Reaching the latency
   stepper means scrolling past every window row, and nothing can be found by
   name.
3. Nothing in the app marks the song's big moments. The beat pulse is a
   continuous breath and the type animates per syllable, so a drop lands and a
   chorus hook arrives with the same weight as a verse line.

## Scope

In:

- The fullscreen lyric gutter.
- A tabbed, searchable settings sheet, and the preview gate that proves it.
- A "big moments" effect driven by the rhythm plan and by chorus hook arrivals,
  with its own settings row and a resolve-report line.

Out:

- Any change to windowed, split or mini layout geometry.
- Any change to the beat pulse's own layers, amplitudes or timing.
- Any new Python-side behaviour; the three items are CSS/JS and the Python test
  suite is expected to stay green untouched.
- Native window behaviour (parked from the previous pass; still unverifiable on
  this host).

## 1 · The fullscreen lyric column

Today `#lyrics-container` is `padding: 180px 22px 240px 28px`, so a lyric line's
left edge is x=28 at every size. In fullscreen the card row is
`body.is-fullscreen .track-float { top: 40px; left: 84px; right: 200px }` with a
96×96 sleeve, so the artwork begins at x=84 and the lyrics begin 56px to its
left — two columns with no relationship.

The fullscreen gutter becomes **68px**: the type column starts 16px outside the
sleeve's left edge, so the sleeve sits *inside* the column the lyrics belong to
and the eye reads them as one block instead of a card and a column that happen
to share a screen.

Rules:

- `body.is-fullscreen #lyrics-container { padding-left: 68px; }` — a single rule
  next to the existing fullscreen block. Windowed compact, split and mini keep
  28px.
- The container already transitions `padding-left var(--dur-4)`, so leaving
  fullscreen eases back to 28px with no new transition.
- The hover parting stays exactly as it is (`padding-top: 380px`). At 68px the
  column still clears the sleeve's 96px resting width, so the two never overlap
  while the art is at rest; while hovered, the lyrics have already parted
  downward.

Gate: the preview tool records `fullscreenLyricGutter` — the computed
`padding-left` of `#lyrics-container` must be 68px in fullscreen and 28px with
fullscreen off.

## 2 · Settings: four tabs and one search field

### The tab map

Every row that exists today survives; only the grouping changes.

| Tab | Groups (in order) | Rows |
| --- | --- | --- |
| `Window` | `Window` | Window opacity, Fade while hovered, Layout, Fullscreen, Always on top, Click-through, Card position, opacity hint |
| `Lyrics` | `Sync`, `Lyrics`, `Local lyrics` | Latency stepper, sync hint; Translations, Font, Alignment; the TTML bar, status, current binding, file list and library hint |
| `Visuals` | `Motion` | Motion, Motion style, Beat sync, Big moments, moments hint |
| `Diagnostics` | `Diagnostics` | Resolve report (collapsed) and its report body |

The user chose four tabs from three options (four / three with the report folded
into Window / six with one per group).

### Markup contract

```
#quick-panel.settings-page
  .sp-sheet
    header.sp-head              (unchanged: title, subtitle, close)
    div.sp-search               (new)
      label.sp-search-field > svg + input#qp-search + button#qp-search-clear
      span.sp-search-hint       (`/` kbd)
    div.sp-tabs[role=tablist]#qp-tabs      (new)
      button.sp-tab[role=tab][aria-selected][tabindex][aria-controls]#qp-tab-<id>
    div.sp-body#qp-body
      div.sp-empty#qp-empty     (new; hidden unless a query matches nothing)
      div.sp-panel[role=tabpanel][aria-labelledby]#qp-panel-<id>   × 4
        section.sp-group > h2.sp-group-title + rows (unchanged markup)
    footer (unchanged)
```

Tab ids: `window`, `lyrics`, `visuals`, `diag`. The panel ids are
`qp-panel-<id>` and the labels `qp-tab-<id>`; `aria-controls`/`aria-labelledby`
point at each other so the pairing is reversible. Row ids (`qp-opacity`,
`qp-latency`, `qp-ttml-*`, …) and their inline handlers do not change, so
`syncSettingsPanel()` keeps working untouched.

The sheet "arrival" animation, the glass, the footer and the density query all
stay; the tab strip and search row are added above `.sp-body`, which keeps the
only scrollbar.

### Behaviour

- **Tabs**: click or `←`/`→`/`Home`/`End` when the strip is focused. Roving
  tabindex (the selected tab is the only tab stop), `aria-selected` on exactly
  one. Selecting a tab clears any active search.
- **Persistence**: the active tab is stored as `settingsTab` through `Settings`
  (localStorage), validated against the known id list like `motionStyle` is.
  The query is never persisted.
- **Search**: matches row labels *and* row prose (hints, TTML status/current,
  the file list, and the action labels inside the TTML bar), case-insensitive,
  across all four panels. The matched run is marked in place with
  `<mark class="qp-mark">`, so a row that matched through prose shows its own
  sentence with the word marked — the reason it is on screen is visible instead
  of guessed at.
- **Search view**: while a query is up the tab strip is hidden, every panel is
  hidden, and results are rendered as one `.sp-result` section per group that
  has hits, under that group's own heading, in tab order. The result rows ARE
  the live rows, moved into the result sections and put back in their recorded
  order when the query clears — a clone would duplicate every id, keep the
  state it was copied with (so acting on a result looked like it did nothing),
  and drop the handlers the TTML rows are wired with, since cloneNode carries
  markup and attributes but not an assigned onclick.
- **Nothing matched**: `.sp-empty` shows "No settings match “<query>”." plus a
  pointer that local `.ttml` files live under Lyrics.
- **Resolve report excluded**: report rows are not searchable. A report says
  what the pipeline did; it is not a setting, and a query that names a lyric
  source must not drag four report lines into the results. The `Resolve report`
  row itself stays searchable, being a setting.
- **Keyboard**: `/` focuses the field while the sheet is open; `Escape` clears a
  non-empty query instead of closing the sheet (a second `Escape` closes);
  `↓` from the field focuses the first result. The existing Tab trap already
  includes `input`, so the field is inside the modal cycle.
- **Small sizes**: at `max-height: 420px` the search field is 26px and the tab
  strip tightens to 6px padding, both above the 28px rows the density query
  already sets. The strip scrolls sideways (`overflow-x: auto`, hidden
  scrollbar) rather than wrapping or shrinking, so a 320px-wide window keeps
  four readable labels.

### Gate: section 5 of `tools/ui-preview-regression.js`

Rewritten around the tabs:

- `settingsTabs` equals `['Window', 'Lyrics', 'Visuals', 'Diagnostics']`, and
  each tab's panel contains exactly the group titles in the table above
  (`settingsTabGroups`).
- `settingsTabWiring`: `aria-controls`/`aria-labelledby` resolve, exactly one
  `aria-selected="true"`, exactly one tab with `tabindex="0"`.
- Alignment and the label column are measured on the **rendered** panel only
  (a hidden panel reports zero rects), then the old assertions run unchanged:
  one label x, and that x within 2px of the group title's text x.
- Search: `opacity` → one row, label marked; `timing` → the sync hint with the
  run marked and no other row; `ttml` → the file library; `zzz` → empty state
  visible and zero results; clearing → the previously active tab returns and the
  strip is visible again.
- `settingsHints` totals 4 across the panels (Window, Sync, Local lyrics, and
  the new Motion hint that explains the moments row), `settingsFits` /
  `sheetCentered` / `rowMinH` unchanged, at all five viewports (1400×900,
  900×700, 800×600, 360×420, 330×380).

## 3 · Big moments

> **Superseded in the 2026-10-01 visual pass.** The two-layer grade (`.moment-wash`
> soft-light + `.moment-dim`), the warm halo on the art wrappers, the active line's
> text-shadow bloom and the `moment-breathe` animation are all **gone**. Reviewing the
> shipped effect found three defects the design had not accounted for: a hard-coded
> amber grade that clashed with the app's cool theme, a transition declared inside the
> state class (so neither entering nor leaving a moment eased — the visible snap), and
> an animation on the same property the class set, which left the release unable to
> transition. The shipped design is one `.moment-veil` whose opacity is transitioned by
> its own base rule, tinted with an accent taken from the cover art (so a moment can
> never clash with what is playing), with the sleeve's light carried by the beat's own
> lamp. Sections below about *when* a moment fires, the hook-vs-drop merge and the
> settings row still describe the shipped behaviour; the layer table and the "what it
> looks like" rationale do not. See
> `docs/superpowers/plans/2026-10-01-visual-language-and-persistence.md`.

### When it fires

Two triggers, one envelope:

- **Drop** — an entry in `beatPlan.phases` whose kind is `drop`. Attack on the
  phase start, hold for the phase, release when it ends. Strength is the level
  the phase already carries: a plan phase is `[startMs, endMs, kind, level]`,
  where `level` is the mean strength the pulse reaches across the span, so a
  soft-hitting drop grades shallow and a hard one grades deep with no second
  measurement.
- **Hook arrival** — the first line of each chorus block. `detectChorusSections`
  today flags *single lines* whose normalised text repeats (a hook can be eight
  consecutive flagged lines), so a new pure function derives arrivals:
  `momentHooks(lines, gapMs = 3500)` returns the index of every `isChorus` line
  that is the track's first, or whose *previous chorus line* is not part of the
  same block: two or more non-chorus lines sit between the two, or the silence
  between that line's end and this one's start is longer than `gapMs`. Adjacent
  chorus lines therefore never re-fire, which is the whole point — a hook is an
  arrival, not a flag. A hook inside an open drop is absorbed and does not fire
  twice.

`momentStarts(lines, plan)` merges both into one ascending list of
`{ms, kind: 'drop' | 'hook', strength, holdMs}`; it is exposed on `window` so the
preview tool can drive it with synthetic lyrics and plans and assert the merge,
the de-duplication and the gap rule without a song playing.

### The envelope

- `--moment-strength` is the whole intensity, registered with `@property`
  exactly like `--beat-strength` (`syntax: '<number>'`, `inherits: true`). One
  number, one system: the grade's depth, the sleeve's halo and the line's bloom
  all read it, so a Subtle drop and a Bold hook differ only by its value and the
  mode multiplier.
- Attack: a drop snaps (transition duration ~90ms); a hook eases in over
  ~`--dur-4`, the mirror of the two phase rules the pulse already uses.
- Hold: while the moment holds, the wash's brightness breathes once per beat on
  the plan's own grid — `animation-delay: var(--beat-lead-ms)` and
  `var(--beat-ms)` — so the grade is phase-locked to the same beats the pulse
  lands on. A hook with no plan holds a steady grade.
- Release: ~1.2s back to zero. Paused playback rests the grade, exactly as
  `beat-paused` rests the pulse.

### What it looks like, and which layer owns what

The rule that makes this safe next to the existing animations: nothing the moment
touches is owned by anyone else. The beat pulse owns `.ambient-backdrop`'s
opacity and scale and `.track-art`'s transform; `.cover-art-blur` owns its own
drifting transform; the sleeve's hover scrim owns `::after`; the sung spans own
their own `text-shadow`. Every surface below was free before this change.

| Surface | Property | Owner |
| --- | --- | --- |
| New `.moment-wash` (absolute, inset 0, z-index 2, `pointer-events: none`) | the warm grade, blended with `mix-blend-mode: soft-light`, as `opacity` | moments only |
| New `.moment-dim` (same geometry) | the dim, the deeper vignette, and the per-beat breathe on the plan's own `--beat-ms` / `--beat-lead-ms`, as `opacity` | moments only |
| `--cover-zoom`, declared on `body` and registered with `@property` like `--beat-strength` | the recession's push-in, inherited and applied as a multiplier *inside* the existing `cover-bloom-drift` keyframes | the drift keeps owning the transform; the moment only supplies the scale it multiplies, and the value lives where the transition runs |
| `.float-art-wrap` / `.side-art-wrap` `box-shadow` | the sleeve's warm halo | moments only (the wrap carries no shadow today; the pulse's shadow lives on `.track-art`) |
| `.line.is-active .word-group` `text-shadow` | the active line's bloom | moments only (the group carries no shadow today, so the group's shadow and each sung span's own shadow paint together) |

The user picked treatments B (Commit) and C (Depth) from the mockups and asked
for the best of both plus the existing animations: C's recession (the surface
steps back and the vignette deepens, so the lyric line comes forward without
being moved) carrying B's grade (the room warms).

The grade is two sibling elements rather than one with pseudo-elements, which is
compositing rather than taste: an element with `opacity < 1` renders its subtree
as an isolated group, so a `soft-light` layer nested inside the dim would blend
with that group's own transparency instead of the artwork and paint as a plain
tint. Siblings share the app root's stacking context, so the blend reaches the
cover.

Two deliberate departures from what the mockups literally did, both because of
properties that are already spoken for:

- **The recession does not re-blur.** The mockup pushed the blurred layer's
  `filter: blur()` deeper; here the push-in is a scale and the darkening is the
  wash's opacity. Filtering the full-window blurred layer repaints it every
  frame, which is the exact cost the beat pulse was designed to avoid — it moves
  opacity only, for that reason.
- **The grade does not wash over the glyphs.** The wash sits *under* the card and
  the lyrics (z-index 2 against their 10 and up), so the scenery recedes while
  the sleeve and the line are simply not in it — which is what brings them
  forward without moving them. Completing B's "the whole room commits" is then
  done where it reads — in the line's bloom and the sleeve's halo — instead of in
  one full-window blend pass over every glyph on screen.

**The type never receives a second transform on a moment.** Words and syllables
already animate; a moment that also scaled the words would fight the variant
engine and read as a different animation rather than a bigger moment.

### Where it lives in `ui/app.js`

The seam, so the plan does not have to invent names:

- State next to the beat engine's: `momentsMode` (`'on' | 'bold' | 'off'`),
  `MOMENT_MODES`, `MOMENT_LABELS`, `momentPlan`, `momentIndex`, `momentLast`.
- Pure, exported for the gate: `momentHooks(lines, gapMs)` and
  `momentStarts(lines, plan)`.
- Per frame: `updateMoment(ms)`, called from the same place `updateBeatLive(ms)`
  is, and it publishes `--moment-strength` before the class exactly as the beat
  engine does, so the grade starts at the right depth instead of snapping to it a
  frame later.
- Lifecycle: `startMomentEngine()` / `stopMomentEngine()`, with the reset inside
  `stopBeatEngine()`'s neighbour so a track change clears the plan and the class
  in one move; a seek re-derives from the new playhead rather than replaying.
- Settings row: `cycleMoments()`, the four-line mirror of `cycleBeatMode()`
  (`Settings.set('momentsMode', …)`, engine restart, `syncSettingsPanel()`,
  `renderDiagnostics()`, `wakeRenderLoop()`), restored from `Settings.get` in the
  boot block that already restores `motionStyle`.

### Settings and reporting

- New row `Visuals > Big moments`, `Subtle / Bold / Off`, mirroring `Beat sync`:
  the same three states, the same labels, the same persistence through
  `Settings` under `momentsMode`, and the same `--beat-strength`-shaped
  multiplier so Subtle genuinely whispers (a full-window grade reads far
  stronger than its number suggests).
- `Off`, reduced motion and the mini player all leave the track completely
  stock; there is no half-on state to explain.
- The resolve report gains a `Moments` line: how many fired, split by kind
  (`4 fired · 2 drops · 2 hooks`), so a track that never dropped says so.

### Gate

The preview tool asserts: `momentClasses` (no leftover `moment-live` when off,
reduced motion or paused), `momentStarts` maths against a synthetic fixture
(merge order, one arrival per chorus block, hook absorbed by a drop),
`momentStrength` bounds (0 ≤ value ≤ 1 and 0 while off), both moment layers'
existence and rise/fall and that nothing animates the pulse's own properties while a moment is
live, and that the row cycles Subtle → Bold → Off and persists.

## Failure modes the design answers

- **No rhythm plan**: hooks still fire, at a fixed neutral strength, with no
  breathing. A track with too little rhythmic evidence is a result, not a
  failure.
- **Seeking**: moments are re-derived from the new playhead rather than replayed
  from a queue, so a seek into the middle of a drop shows the grade already
  established — no burst of stale attacks.
- **Long holds**: a hold has a ceiling (~8s) so a malformed plan cannot leave
  the grade pinned on.
- **Track change**: the envelope resets with everything else; the moment state
  is reset in the same place `stopBeatEngine()` resets the plan cursors.

## Manual smoke (Windows, after implementation)

- Fullscreen a track with a card: the lyrics and the sleeve share a column; exit
  fullscreen and the gutter returns to 28px without a jump.
- Open settings at 320×380 and at 1400×900: four tabs reachable, search field
  usable, sheet still centred, rows still 28px tall in the small window.
- Play a track with a drop and a chorus: the grade lands on the drop, the sleeve
  takes its halo, the line blooms, and nothing moves the words twice.
- Turn Big moments Off mid-song: the grade releases and the track is stock.

## Test plan

- `python -m unittest discover -s tests` stays at the current 330 passing (no
  Python behaviour changes).
- `node --check ui/app.js` and `node --check tools/ui-preview-regression.js` must
  both be silent (the JS gate this repo already runs by hand).
- `tools/ui-preview-regression.js` PASS at all five viewports with the new keys
  (`fullscreenLyricGutter`, `settingsTabs`, `settingsTabGroups`,
  `settingsTabWiring`, the search keys, `momentClasses`, `momentStarts`,
  `momentStrength`, `momentsRowCycles`).
- README: the Settings section, the fullscreen column note, and the smoke list
  updated to match.
