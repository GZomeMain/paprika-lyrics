# One light: an artwork accent, a beat lamp, a snap-free moment, a quiet viewport, and settings that survive a relaunch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the hard-coded amber "moment" grade with a colour derived from the playing artwork, make the beat sync a light the sleeve emits instead of a window-wide flash, remove the stray scrollbar from the lyric viewport, and stop the host from wiping every setting on exit.

**Architecture:** Today the app has two unrelated visual effects that both reached for a full-window layer: the beat pulse animates the blurred backdrop's opacity, and a *song moment* paints a hard-coded warm `soft-light` gradient plus a warm text-shadow over the whole frame. That is where the orange comes from, why it cannot fit the theme, and why toggling it snaps — the shadow transitions are declared *inside* the state class, so removing the class removes the transition and the value in the same style change, and nothing eases. This plan introduces one missing primitive — **`--art-accent`, a colour taken from the cover art** — and rebuilds both effects on top of it under a strict rule: **one property, one owner.** The beat owns `transform` (the specular gesture); a moment owns `opacity` (the sustained grade); the glyphs own neither.

**Tech Stack:** Python 3.13 host (pywebview 6.2.1 → Edge WebView2), plain JS + CSS in `ui/`, `node --check` for syntax, `python -m unittest` for the host, and `tools/ui-preview-regression.js` run in a browser as the UI test suite.

## Global Constraints

- **No Python-side behaviour changes** except Task 1. `python -m unittest discover -s tests` must stay green (330 passing on this branch at plan time, 333 after Task 1).
- **No per-frame re-blur.** The blurred backdrop is the single most expensive layer in the app; a design that filters it per frame is out. Animate `opacity` and `transform` only.
- **The type never takes a second transform, and never takes a moment tint.** Words and syllables already animate; `--line-breath` is the only channel the whole-line gestures read.
- **One property, one owner.** Before writing any rule, name the property and its owner. `.ambient-backdrop`'s `opacity`/`transform` and `.track-art`'s `transform`/`box-shadow`: the beat. `.cover-art-blur`'s `transform`: the drift. `.float-art-wrap::after` / `.side-art-wrap::after`: the hover scrim. `.art-light`'s `transform`: the beat. `.art-light`'s `opacity`: a moment. `.syllable-highlight`'s `text-shadow`: the syllable engine.
- **A transition a state class needs is declared on the element's BASE rule, never inside the state class.** This is the fix for the reported artifact; it is also a rule every later task must obey.
- **`Off`, reduced motion and the mini player leave the track completely stock.** No half-on state.
- **Gate parity.** `node --check ui/app.js` and `node --check tools/ui-preview-regression.js` must be silent, and `tools/ui-preview-regression.js` must PASS at 1400×900, 900×700, 800×600, 360×420 and 330×380.

---

### Task 1: Settings survive a relaunch (host)

The root cause is not the settings code. `paprika_app.py` calls `webview.start(SMTC_BRIDGE.start, window)` with pywebview's defaults, and `webview/platforms/winforms.py::init_storage` then does:

```python
if not _state['private_mode'] or _state['storage_path']:
    cache_dir = _state['storage_path'] or os.path.join(data_folder, 'pywebview')
else:
    cache_dir = tempfile.TemporaryDirectory().name      # ← a NEW temp dir every launch
```

`private_mode` defaults to `True`, and `edgechromium.py` passes that straight to `props.set_IsInPrivateModeEnabled(...)`, so WebView2 runs an in-memory profile. Every `Settings.set` (`sl_layout`, `sl_beatMode`, `sl_momentsMode`, `sl_font`, `sl_zoom`, `sl_opacity`, `sl_ontop`, …) goes into localStorage and is discarded when the window closes. Nothing in `ui/app.js` needs to change.

Because the UI loads from a `file://` URL, every page shares one `file://` origin — so the profile must live in the app's own directory, or another pywebview app on the machine could read this app's keys.

**Files:**
- Modify: `config.py` (add the profile dir beside `CACHE_FILE` / `TTML_DIR`)
- Modify: `paprika_app.py:874`
- Modify: `.gitignore`
- Create: `tests/test_config_paths.py`
- Modify: `README.md`

**Interfaces:**
- Produces: `config.WEBVIEW_PROFILE_DIR: Path` — the WebView2 user-data folder, beside the app like `CACHE_FILE` and `TTML_DIR`, movable with `SPICY_WEBVIEW_DIR`.

- [x] **Step 1: Save this plan** to `docs/superpowers/plans/2026-10-01-visual-language-and-persistence.md`.
- [x] **Step 2: Write the failing tests** — `tests/test_config_paths.py`.
- [x] **Step 3: Run it to verify it fails** (`ImportError: cannot import name 'WEBVIEW_PROFILE_DIR' from 'config'`).
- [x] **Step 4: Add `WEBVIEW_PROFILE_DIR` to `config.py`.**
- [x] **Step 5: Ignore `.webview/`** in `.gitignore`.
- [x] **Step 6: Start the window with `private_mode=False, storage_path=str(WEBVIEW_PROFILE_DIR)`.**
- [x] **Step 7: Run the tests** — 3 new PASS, full suite green at 333.
- [ ] **Step 8: Manual smoke (Windows).** Launch, change Motion style / Beat sync / Big moments / window opacity, close, relaunch: all four are still set. Delete `.webview/` and relaunch: the defaults are back.
- [x] **Step 9: README** — Settings persist bullet.
- [x] **Step 10: Commit.**

---

### Task 2: The lyric viewport loses its scrollbar

`#lyrics-container` is `overflow-y: scroll` with `overflow-x` unspecified, so its computed `overflow-x` becomes `auto` — and the active line really does overflow horizontally: `app.js:2366` writes `transform = 'scale(1.025) translateX(2px)'` onto the **line element itself**, and transformed ink counts toward scrollable overflow. That is the bar along the bottom of the window. The vertical bar is a deliberate decoration (`scrollbar-width: thin`, dim until hover) but the viewport is a karaoke auto-scroller, so the bar was never the thing doing the scrolling.

The right inset grows from 22px to 32px on the way: today the classic 10px scrollbar eats space *inside* the padding box, so the column's real right inset is 32px. Preserving it exactly keeps the type column where it is, and the extra 10px is the room the scaled active line needs.

**Files:** `ui/style.css:685-744`, `ui/style.css:3413-3418`, `tools/ui-preview-regression.js`, `README.md`

- [x] **Step 1: Write the failing gate assertions** (new section 12: `lyricsOverflowX`, `lyricsScrollbarWidth`, `lyricsPaddingRight`, `lyricsCanScrollSideways`).
- [x] **Step 2: Run the gate and watch it fail.**
- [x] **Step 3: `overflow-x: clip`, `scrollbar-width: none`, `padding: 180px 32px 240px 28px`; delete the `::-webkit-scrollbar*` block.**
- [x] **Step 4: Drop the dead reduced-motion `::-webkit-scrollbar-thumb` rule.**
- [x] **Step 5: Run the gate at 1400×900 and 330×380** — PASS.
- [x] **Step 6: Look at it** — no bar along the bottom, no clipped glyph.
- [x] **Step 7: README.**
- [x] **Step 8: Commit.**

---

### Task 3: `--art-accent` — the room's colour comes from the artwork

One number, derived from the cover, that every light in the app reads. A warm cover may still grade warm — but it will be *that* album's warm, and a blue album grades blue.

The extraction runs on the **low-resolution `data:` thumbnail** the host pushes first (`core/smtc.py:308`). A `data:` URL can never taint a canvas, so the accent needs no CORS handling. `--art-accent` is registered as a `<color>` so a track change cross-fades, and alphas are composed with `color-mix`.

**Files:** `ui/style.css` (registered property), `ui/app.js` (`extractAccent`, `clampAccentToLight`, `applyCoverAccent`, the `setCoverArt` call sites), `tools/ui-preview-regression.js`, `README.md`

- [x] **Step 1: Write the failing gate assertions** (new section 13: `accentFromBlue`, `accentFromGrey`, `accentDefault`, `accentRegistered`).
- [x] **Step 2: Run the gate and watch it fail** (`extractAccent is not defined`).
- [x] **Step 3: Register `@property --art-accent` + `:root { transition: --art-accent 1.6s }`.**
- [x] **Step 4: Write the extractor, the lightness clamp and the applier.**
- [x] **Step 5: Call it from `setCoverArt`**, and reset the accent on `setCoverArt(null)`.
- [x] **Step 6: Run the gate** — PASS.
- [x] **Step 7: See it change colour** — two covers, ~1.6 s cross-fade.
- [x] **Step 8: README.**
- [x] **Step 9: Commit.**

---

### Task 4: Beat sync becomes a light the sleeve emits

The lamp is one element per art wrap, behind the sleeve, filled with the accent. The beat owns its `transform` (a fast swell that decays), a moment owns its `opacity` (the sustained lift), and the two compose with `max()`. The per-beat gesture rests at `scale(1)` — the same value the declared style has — so dropping the animation on pause or rest jumps nothing, and the accompanying opacity change runs through a plain base-rule transition. Bold's whole-window jump drops from 30 opacity points to 16.

**Files:** `ui/index.html` (one `.art-light` in each art wrap), `ui/style.css` (`.art-light`, `--lamp-beat`, keyframes, `.side-art-wrap` clipping, reduce motion), `tools/ui-preview-regression.js`, `README.md`

- [x] **Step 1: Write the failing gate assertions** (new section 14: `lampCount`, `lampZ`, `lampAccentTint`, `lampRestOpacity`, `lampBeatRule`, `lampBeatGrid`, `lampKeyframeTransformOnly`, `lampMomentOpacity`, `lampTouchesPulse`).
- [x] **Step 2: Run the gate and watch it fail** (`every art wrap needs exactly one beat lamp: 0`).
- [x] **Step 3: Add the elements.**
- [x] **Step 4: Style the lamp, the steady levels and the keyframes.**
- [x] **Step 5: Pull Bold's backdrop jump back** (0.30 → 0.16, 0.09 → 0.05).
- [x] **Step 6: Stop `.side-art-wrap` clipping** and give `.side-art` its own radius.
- [x] **Step 7: Reduced motion** — add `.art-light` to the `animation: none` list.
- [x] **Step 8: Run the gate at all five viewports.**
- [x] **Step 9: Watch the beat** at peak/rest, Subtle/Bold.
- [x] **Step 10: README.**
- [x] **Step 11: Commit.**

---

### Task 5: The moment becomes one veil — and stops snapping

Deleting `.moment-wash` removes the orange, the diagonal gradient seam and the full-window `soft-light` compositing pass in one move. Four specific defects go with it:

1. `body.moment-live .float-art-wrap { box-shadow: …; transition: box-shadow … }` — the transition is declared **inside** the state class, so entering and leaving both happen with no transition at all. This is the snap.
2. `body.moment-live .line.is-active .word-group { text-shadow: … }` — a warm glow **over the glyphs**. This is the "hue in the text".
3. `body.moment-live .moment-dim { animation-name: moment-breathe; … }` — an animation on the same property the class also sets, so the release cannot transition.
4. `mix-blend-mode: soft-light` over the whole window forces a full-window compositing pass every frame.

**Files:** `ui/index.html:22-34` and the Visuals hint, `ui/style.css:336-459` and the reduce-motion list, `tools/ui-preview-regression.js` (the moment section), `README.md`

- [x] **Step 1: Update the gate first** — one veil, no blend, no animation, type untouched, base-rule transition, `--lamp-moment`.
- [x] **Step 2: Run the gate and watch it fail.**
- [x] **Step 3: Collapse the markup to one `.moment-veil`.**
- [x] **Step 4: Rebuild the CSS block.**
- [x] **Step 5: Reduce motion** — `.moment-veil` replaces the two old names.
- [x] **Step 6: Update the Visuals hint copy.**
- [x] **Step 7: Run the gate at all five viewports.**
- [x] **Step 8: Watch it, and watch it let go.**
- [x] **Step 9: README.**
- [x] **Step 10: Commit.**

---

### Task 6: The full pass

- [x] **Step 1: Syntax** — `node --check ui/app.js`, `node --check tools/ui-preview-regression.js`.
- [x] **Step 2: Host tests** — `python -m unittest discover -s tests`.
- [x] **Step 3: Gate** at all five viewports.
- [ ] **Step 4: Look at all three states side by side** at 1400×900 (Beat Off; Beat Bold driven; a Bold drop).
- [x] **Step 5: The visual smoke list** in the README.
- [x] **Step 6: Commit.**

---

## Material tradeoffs the request cannot resolve

- **Bold becomes quieter overall.** It was the loudest thing in the app (a 30-point window jump). It is now a deeper lamp and a 16-point room breath. Anyone who liked Bold's flash will find it calmer — but the flash is what read as a screen flicker, and the sleeve now carries the gesture.
- **`overflow-x: clip` can, in theory, shave the last pixel or two off a full-width *active* line on a very wide window** (>1300px of lyric column) because the active line is scaled 2.5% on its own element. The right inset goes 22px → 32px to absorb most of it, which narrows the column's right side by 10px; re-wrapping a line is possible.
- **The accent is a heuristic.** A monochrome-sleeved album gets the theme's cool lamp, and a two-tone cover picks the more saturated of the two.
- **The moment no longer breathes on the beat inside its own layer.** Its depth is steady and its *light* pulses with the sleeve's lamp instead. Two clocks were the reason a release could not ease.
