# Overlay Chrome Fixes + Lyrics-Only Mini Player — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five overlay-chrome bugs (fullscreen still draggable, the track-details band seeking lyrics instead of taking the click, focus outlines on lyric lines, the missing fullscreen/exit art buttons, and off-corner resize anchoring) and land five polish changes (uniform art darken, bolder icons + Spicy-style dot thumb progress, a lyric scrollbar, a shorter/wider/centred settings sheet, and a lyrics-only mini player replacing the windowed exit button).

**Architecture:** Two root causes do most of the work here.

1. **Drag regions are implemented in JavaScript, not by `-webkit-app-region`.** pywebview injects a `document.body` mousedown listener (`webview/js/customize.js`) that walks up from `event.target` looking for an element that literally *is* one of the `pywebview-drag-region` elements; on a match it installs a mousemove loop that calls `pywebviewMoveWindow`. CSS `-webkit-app-region: no-drag` therefore never stopped a drag, which is why fullscreen (bug 1) was still movable. Disabling dragging is a DOM question: strip the marker class from the regions while fullscreen, restore it when windowed. The existing CSS stays as belt-and-braces (WebView2 may also honour app-region on some builds).
2. **pywebview already implements anchored resizing.** `Window.resize(width, height, fix_point)` takes a `FixPoint` and the winforms backend applies the whole change in a single `SetWindowPos` (`x = x + Width - newWidth` for `EAST`, same for `SOUTH`). Our `initResizeHandles` instead dispatched `move_window` + `resize_window` as two separate async bridge calls, with the move only sent when the size had changed by ≥4 px — and `resize_window` called `window.resize(w, h)` with the default `NORTH|WEST`, i.e. always growing from the top-left. Fix: pass the anchor edge down and let pywebview do it atomically. `move_window` then has no callers and is deleted (API + JS + docs), per this repo's no-dead-code convention.

**Tech Stack:** Python 3.13 stdlib (`unittest`, no pytest), pywebview/Edge WebView2, vanilla JS + CSS in `ui/`. `core/native_window.py` stays pure/injectable; `WindowApi` in `paprika_app.py` stays a thin adapter.

## Global Constraints

- Test runner: `python -m unittest discover -s tests` (unittest, NOT pytest). Full suite is 166 tests OK at the start and MUST stay green.
- JS syntax gate: `node --check ui/app.js`.
- Reuse the design tokens in `ui/style.css` (`--dur-1..4`, `--ease-*`, `--glass-*`, `--r-*`, `--icon-idle/hot`, `--sp-row-min-h`). No parallel systems.
- Every interactive child placed inside a `pywebview-drag-region` ancestor must sit *outside* that ancestor in the DOM (the pywebview walk-up matches ancestors), or the click starts a window drag.
- Fullscreen still must never be entered/exited by hand-rolled style bits: `reassert_fullscreen()` stays the repair pass after every native mutation.
- The settings sheet must keep fitting every window size (verified by `tools/ui-preview-regression.js`).
- Commit after each task with the message given in the task.

## File Structure

- Modify: `ui/index.html` — art-controls rows (compact + split): add `art-btn-fs`, `art-btn-exit`, `art-btn-pip`/`side-btn-*`; add the mini bar markup.
- Modify: `ui/style.css` — fullscreen drag/handle neutralisation, art darken layer, control row reveal rules, progress dot thumb, lyric scrollbar, settings sheet geometry, mini-mode layout.
- Modify: `ui/app.js` — drag-region marker sync, click shield, mini mode + persistence, art-control sync for the new buttons, anchored resize, progress dot drive.
- Modify: `paprika_app.py` — `resize_window(width, height, anchor)`, `set_mini_mode(enabled)`, mini-aware clamping/persistence, delete `move_window`.
- Modify: `storage.py` — mini-window geometry helpers.
- Modify: `tests/test_storage.py` (or `test_native_window.py`) — coverage for any new pure logic.
- Modify: `tools/ui-preview-regression.js` — new invariants (4 art slots, drag marker count, sheet geometry).
- Modify: `README.md` — controls table, layout/mini docs, smoke checklist.

---

### Task 1: Fullscreen is not draggable or resizable (bug 1)

**Files:** `ui/app.js`, `ui/style.css`

**Interfaces:**
- Produces: `syncWindowDrag()` — re-asserts the `pywebview-drag-region` marker on the elements that had it at boot, and removes it while `isFullscreen`. Called from `applyLayoutState()`.

Steps:
- [ ] Record the marked elements once at boot (`Array.from(document.querySelectorAll('.pywebview-drag-region'))`) and toggle the class off while fullscreen.
- [ ] Hide `.resize-handle`s in fullscreen (`body.is-fullscreen .resize-handle { display: none }`) so a stray edge drag cannot shrink the fullscreen window.
- [ ] Keep the existing `-webkit-app-region` rules, and rewrite the "a fullscreen overlay must not be movable" comment to state the real JS mechanism.

**Verify:** `node --check ui/app.js`; in the preview, add `is-fullscreen` to `<body>`, assert no element carries the marker class and every `.resize-handle` computes `display: none`; remove the class and assert the marker count returns to its boot value.

---

### Task 2: Track-details band takes the click (bug 2)

**Files:** `ui/app.js`, `ui/style.css`

**Problem:** the compact card's grown footprint is only live *after* the art's 0.48 s expansion finishes, and the card's bounding box does not cover the band the details visually occupy; a click there lands on the lyric line behind it and seeks.

**Interfaces:**
- Produces: `cardCoversPoint(x, y)` — the single hit-test used by `lineDiv.onclick`, covering the card's rect, the art's *grown* footprint (so a click during expansion cannot fall through) and the header's rect.

Steps:
- [ ] Add `cardCoversPoint` and use it in place of the current inline rect test in `lineDiv.onclick` (compact *and* split).
- [ ] Give the art wrap an always-present interaction hotspot equal to its grown size so aiming at the on-art buttons works before the art finishes growing.
- [ ] Make sure the hotspot does not swallow plain lyric clicks further down the list: keep it to the art's own top-left anchored footprint.

**Verify:** in the preview at 1400×900, assert `cardCoversPoint` is true inside the art footprint immediately (before hover growing) and false two card-heights below the card.

---

### Task 3: Lyric lines never show a focus outline (bug 3)

**Files:** `ui/style.css`

Steps:
- [ ] `.line:focus, .line:focus-visible { outline: none; }` with a comment: lines are roving-tabindex buttons for keyboard seeking, and Chromium's default ring made a stray Tab press look like a selected lyric.
- [ ] Re-check nothing else in the container draws a ring (`#lyrics-container` gets `outline: none` too).

**Verify:** preview — focus the active line, assert `getComputedStyle(line).outlineStyle === 'none'`.

---

### Task 4: Art controls carry fullscreen + a fullscreen-only exit (bug 4)

**Files:** `ui/index.html`, `ui/style.css`, `ui/app.js`, `tools/ui-preview-regression.js`

**Interfaces:**
- Slot order (both compact and split): `layout`, `settings`, then `fullscreen` (windowed only) and `exit` (fullscreen only) — or `pip` (windowed only) once Task 5 lands.
- `syncArtControls()` gains `syncArtControlVisibility()` which is driven from `applyLayoutState()`.

Steps:
- [ ] Add `art-btn-fs` (enter fullscreen) / `art-btn-exit` (leave fullscreen) to the compact row and the matching `side-btn-fs-entry` / `side-btn-exit` to the split row; retire `side-btn-close` (app close already lives in the header's window controls).
- [ ] Toggle `.is-hidden` on `[data-when="windowed"|"fullscreen"]` controls from `applyLayoutState()`.
- [ ] Update the regression tool: 4 art slots per layout, `art-btn-fs` hidden while fullscreen, `art-btn-exit` hidden while windowed.

**Verify:** `node --check ui/app.js`; preview asserts: windowed → `fs` visible, `exit` hidden; fullscreen → mirrored.

---

### Task 5: Lyrics-only mini player replaces the windowed exit slot (improvement 5)

**Files:** `ui/index.html`, `ui/style.css`, `ui/app.js`, `paprika_app.py`, `storage.py`, `tests/test_storage.py`

**Interfaces:**
- Python: `WindowApi.set_mini_mode(enabled: bool) -> bool`; mini clamps `MINI_MIN = (320, 380)`, `MINI_MAX = (900, 1200)`, default `MINI_SIZE = (460, 560)`; `resize_window`/`save_window_size` clamp against the mini range while mini is on; `_record_window_geometry` keeps the pre-mini geometry when closing in mini.
- `storage.py`: `CacheManager.save_mini_size(width, height)` / `get_mini_size() -> dict` under `window.mini`.
- JS: `setMiniMode(on)` → `document.body.classList.toggle('mini', on)` + `Settings.set('mini', ...)`; the window resize request goes through the existing `resize_window` bridge call.

Steps:
- [ ] Python: add the mini constants, `set_mini_mode`, mini-aware clamps, and the cache helpers (+ `tests/test_storage.py` case).
- [ ] HTML: a `#mini-bar` — a `pywebview-drag-region` spacer as a *sibling* of its buttons (never their ancestor), a gear, a restore and a close.
- [ ] CSS: `body.mini` hides the compact card, the header, the split panel, the latency rail and the resize handles that no longer apply; the bay shows only lyrics with tighter padding.
- [ ] JS: `setMiniMode`, the pip button wiring, escape/F11 leaving mini, and `applyLayoutState` applying the mini padding/clearance.

**Verify:** `python -m unittest tests.test_storage -v`; preview asserts `body.mini` hides `#track-float` and the header and reveals `#mini-bar`.

---

### Task 6: Resize anchors at the edge being dragged (bug 5)

**Files:** `ui/app.js`, `paprika_app.py`, `ui/index.html` (nothing), `core/native_window.py` (mapping helper)

**Interfaces:**
- Implemented: `WindowApi.resize_window(width: int, height: int, anchor: str = 'e')` where `anchor` names the *fixed* point: one of `nw` (no shift), `n` (south edge fixed), `w` (east edge fixed), `ne`, `sw`, `se`, plus the two-edge combos the handles need.
- Deleted: `WindowApi.move_window` and both JS call sites.

Steps:
- [ ] Add `core/native_window.py: anchor_fix_point(anchor, fix_point_cls)` — a pure mapping from the handle direction to pywebview's `FixPoint` flags, unit-tested (no live window needed).
- [ ] `WindowApi.resize_window` learns `anchor` and forwards it; the webview `expose` list drops `move_window`.
- [ ] `initResizeHandles` sends the anchor for its `data-dir` and no longer computes `pendingX/pendingY`.

**Verify:** `python -m unittest discover -s tests` (new `anchor_fix_point` cases); `node --check ui/app.js`.

---

### Task 7: Uniform art darken on hover (improvement 1)

**Files:** `ui/style.css`

Steps:
- [ ] Add a full-bleed `::after` overlay on `.float-art-wrap` / `.side-art-wrap` (`rgba(0,0,0,0.34)`, `pointer-events: none`, `z-index: 2`, below the `z-index: 3` control layers) that fades in with `--dur-3` under `:hover`, keeping the existing gradient scrims for legibility.
- [ ] Honour reduced motion (opacity-only, no transition).

**Verify:** preview — assert `getComputedStyle(wrap, '::after').opacity` is 0 unhovered and > 0.2 once `.art-hover`/`:hover` is simulated via the class the JS already toggles.

---

### Task 8: Bolder icons + Spicy-style dot-thumb progress (improvement 2)

**Files:** `ui/style.css`, `ui/app.js`

Steps:
- [ ] `.art-btn .icon { stroke-width: 2.15 }` and one size step up for the on-art transport glyphs.
- [ ] `#art-progress::after` — an 11 px white dot at `left: calc(var(--art-progress, 0) * 1%)`, `translate(-50%, -50%)`, soft shadow, hidden until the art is hovered, scaling up on hover.
- [ ] `updateArtProgress()` publishes `--art-progress` (0–100) next to the fill width; `applySeek`/`body.seeking` snap the dot instead of sliding.

**Verify:** preview — assert `--art-progress` lands on `#art-progress` after a simulated progress update and that the pseudo-element's `left` resolves to a percentage.

---

### Task 9: Lyric scroller's smooth custom scrollbar (improvement 3)

**Files:** `ui/style.css`

Steps:
- [ ] Replace `scrollbar-width: none` / `display: none` with a 10 px Chromium scrollbar: transparent track, `rgba(255,255,255,0.12)` pill thumb inset with `border: 3px solid transparent; background-clip: content-box`, brightening to `0.3` on container hover, plus `scrollbar-width: thin; scrollbar-color:` for the non-WebKit path.
- [ ] Keep the padding balanced so the added 10 px does not visibly shift the lyric column.

**Verify:** preview screenshot/inspection at 1400×900 and 360×420.

---

### Task 10: Settings sheet shorter, a bit thicker, centred (improvement 4)

**Files:** `ui/style.css`, `tools/ui-preview-regression.js`

Steps:
- [ ] `.settings-page { align-items: center }`, `.sp-sheet { max-width: 560px; max-height: min(78%, 720px) }` with `--sp-row-min-h` raised to 40 px and slightly larger label/heading sizes — the sheet reads substantial instead of stretched to full height.
- [ ] Keep the `@media (max-height: 420px)` / `(max-width: 340px)` density rules applying on top.
- [ ] Regression tool: assert the sheet is vertically centred and inside the window at each test size.

**Verify:** `run('1400x900')`, `run('800x600')`, `run('360x420')`, `run('330x380')` in the preview.

---

### Task 11: Docs + full verification sweep

**Files:** `README.md`, `tools/ui-preview-regression.js`

Steps:
- [ ] README: controls table (art buttons, mini player, resize anchors), a mini-player line in the features, and two manual-smoke items.
- [ ] Run the final sweep: `node --check ui/app.js`, `python -m unittest discover -s tests`, the preview regression at 5 sizes, and a `grep` for stale references to `move_window` / `side-btn-close`.
