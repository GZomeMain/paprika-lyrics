# Native window controls: drag, transparency, fullscreen, settings order

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the overlay's window behave like a native window: a move gesture that works and snaps, transparency that composes with click-through and holds all the time you are windowed, a real fullscreen (cover the monitor at normal window state, never maximized) instead of pywebview's maximized form, and a settings sheet ordered by how often you actually touch it.

**Architecture:** All four items are the same story: the window's native behaviour is owned by `core/native_window.py` (one ctypes seam, fake-drivable in tests) and driven by `paprika_app.WindowApi` over pywebview's bridge; the UI owns *policy* and *geometry* only. We take over the two gestures pywebview was doing badly — the window move (its JS drag loop) and fullscreen (its `WindowState = Maximized` toggle) — leaving pywebview to host the WebView2 content, resize and file dialogs.

**Tech Stack:** Python 3.13, pywebview 6.2.1 (WinForms + Edge WebView2), ctypes/user32+dwmapi, vanilla JS/CSS front end, `unittest`, `node --check`.

## Global Constraints

- **Do not commit, push, branch or stash.** The working tree already holds uncommitted work from earlier turns (the TTML library feature and the previous window-fixes batch) in *the same files this plan edits*, so any `git add` would mix threads. Each task ends with a `git diff --stat` checkpoint instead. Say so if you want a commit — the user decides what goes in it.
- Stay on `master` (this repo has no remote and all prior work is direct-to-master).
- **Test runner is `unittest`, never pytest:** `python -m unittest <module> -v`, full suite `python -m unittest discover -s tests`. Baseline is **294 tests, OK**.
- JS gate after every UI edit: `node --check ui/app.js` and `node --check tools/ui-preview-regression.js`.
- Every native function keeps the existing seam contract: take the pywebview window plus optional injectable `user32`/`dwmapi`, **never import pywebview or pythonnet**, return `False`/`None` instead of raising, and resolve the HWND with `_hwnd_of` (no title-based `FindWindowW` fallbacks).
- New behaviour must not change the lyric pipeline, the TTML library, resize anchoring, mini mode or the SMTC bridge.
- Do not rename `core/native_window.set_window_alpha`, `fix_point_for`, `reassert_fullscreen`, or the JS globals `setFullscreen`, `setMiniMode`, `setClickThrough`, `updateArtProgress`, `setTrackDuration`, `cycleLayout` — `tools/ui-preview-regression.js` and the host push state through them.
- Copy rule: comments explain *why* a thing is the way it is, in the repo's existing voice (see `core/native_window.py` and `ui/app.js` headers). No `TODO`, no placeholder text, no "handle edge cases".
- User-facing copy stays sentence case, uses typographic quotes (“…”) inside prose, and never says "please".

---

## File structure (no new runtime files)

| File | Responsibility after this plan |
| --- | --- |
| `core/native_window.py` | Every native window mutation: rounded corners, topmost, click-through, layered alpha, **the window move gesture**, **fullscreen enter/leave**, fullscreen repair. Still ctypes-only, still fake-drivable. |
| `paprika_app.py` | `WindowApi`: owns native *state* (mini, fullscreen, alpha, saved fullscreen style/geometry), applies UI-requested opacity, runs the click-through peek timer, exposes the bridge. |
| `ui/app.js` | Owns *policy*: when the window is see-through, which pixels are drag surfaces, cursor idle, Esc, peek mirroring. |
| `ui/index.html` | `data-drag` / `data-no-drag` on the right elements; new opacity row; reordered settings groups. |
| `ui/style.css` | Drag affordance cursors, cursor-hide rule, dead `-webkit-app-region` declarations removed. |
| `tests/test_native_window.py` | Seam tests for `begin_drag` and the rewritten fullscreen pair. |
| `tests/test_window_api.py` | Host tests: no pywebview fullscreen toggle, style/geometry bookkeeping, alpha durability, drag passthrough. |
| `tools/ui-preview-regression.js` | The DOM-level gate: drag surfaces reachable, transparency policy, settings order, Esc, cursor hide. |
| `README.md` | Controls table + smoke checklist brought in line. |
| `docs/superpowers/plans/2026-09-29-native-window-controls.md` | This plan. |

**Decisions locked in (from the user):** settings order is overlay-first (Window → Sync → Lyrics → Motion → Local lyrics → Diagnostics); the always-on opacity applies **windowed, mini and click-through but not fullscreen** (fullscreen snaps opaque); fullscreen covers the monitor and *respects* the Always-on-top setting rather than forcing it; click-through gains a **Ctrl+Shift+M peek** that hands the mouse back for a few seconds so a mouse-proof overlay can still be moved.

---

### Task 0: Save the plan

**Files:**
- Create: `docs/superpowers/plans/2026-09-29-native-window-controls.md`

- [ ] **Step 1: Write the approved plan to its file**

Create `docs/superpowers/plans/2026-09-29-native-window-controls.md` containing this plan's markdown **verbatim** (the approved text of this turn, from the `# Native window controls…` heading to the last task). Do not re-summarise it.

- [ ] **Step 2: Checkpoint**

```bash
git status --short docs/superpowers/plans/
```
Expected: one new untracked file listed.

---

### Task 1: A native window move gesture (`core/native_window.begin_drag`)

**Files:**
- Modify: `core/native_window.py` (constants near the top; new function after `set_window_alpha`)
- Test: `tests/test_native_window.py` (new `BeginDragTest`, extend `FakeUser32`)

**Interfaces:**
- Consumes: `_hwnd_of(window)`, `_declare(func, restype, argtypes)` (both already in the module)
- Produces: `begin_drag(window, user32=None) -> bool`; module constants `WM_NCLBUTTONDOWN = 0x00A1`, `HTCAPTION = 2`

**Why:** pywebview moves the window from JavaScript — a `document.body` mousedown listener walks up from the target looking for an element that *is* `.pywebview-drag-region`, then drives `pywebviewMoveWindow` per mousemove. Two consequences are visible in this app: the stylesheet's `-webkit-app-region: no-drag` never participates (the walk-up matches **ancestors**, so a mousedown on the card's seek bar starts a window move instead of a seek), and the whole gesture depends on page state we cannot observe or test from here. Windows already implements this gesture: `DefWindowProc` handles `WM_NCLBUTTONDOWN` with `HTCAPTION` by taking capture and running its own modal move loop — the standard frameless-window move, and the reason to switch: Aero Snap, per-monitor DPI correctness and drag-to-restore come free, and nothing in the page can shadow it.

- [ ] **Step 1: Write the failing test**

In `tests/test_native_window.py`, add to `FakeUser32.__init__`: `self.window_commands = []`, and add these methods to `FakeUser32` (next to `SetLayeredWindowAttributes`):

```python
    def PostMessageW(self, hwnd, message, wparam, lparam):
        self.calls.append(("PostMessageW", hwnd, message, wparam, lparam))
        return 1

    def ReleaseCapture(self):
        self.calls.append(("ReleaseCapture",))
        return 1

    def ShowWindow(self, hwnd, command):
        self.calls.append(("ShowWindow", hwnd, command))
        self.window_commands.append(command)
        return 1
```

Then a new test class at the end of the file:

```python
class BeginDragTest(unittest.TestCase):
    """The window move is Windows' own: a caption hit-test, posted to the form."""

    def test_a_drag_posts_a_caption_hit_test_to_the_window(self):
        u = FakeUser32()
        self.assertTrue(nw.begin_drag(FakeWindow(), user32=u))
        call = u.last("PostMessageW")
        self.assertIsNotNone(call)
        self.assertEqual(call[1], u.hwnd)
        self.assertEqual(call[2], nw.WM_NCLBUTTONDOWN)
        self.assertEqual(call[3], nw.HTCAPTION)
        # Posted, not sent: the modal move loop runs on the UI thread for the
        # whole gesture, and this call comes from the bridge thread.
        self.assertIn(("ReleaseCapture",), u.calls)

    def test_no_handle_is_refused(self):
        class NoHandle:
            pass
        self.assertFalse(nw.begin_drag(NoHandle(), user32=FakeUser32()))

    def test_a_refused_post_is_reported(self):
        u = FakeUser32()
        u.PostMessageW = lambda *a: 0
        self.assertFalse(nw.begin_drag(FakeWindow(), user32=u))
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python -m unittest tests.test_native_window.BeginDragTest -v`
Expected: FAIL — `AttributeError: module 'core.native_window' has no attribute 'begin_drag'`

- [ ] **Step 3: Implement `begin_drag`**

In `core/native_window.py`, next to the other winuser constants (after `MONITOR_DEFAULTTONEAREST`):

```python
# A window move, handed to Windows rather than driven from the page: DefWindowProc
# answers WM_NCLBUTTONDOWN with HTCAPTION by taking capture and running its own
# modal move loop.
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2
```

And the function, placed after `set_window_alpha`:

```python
def begin_drag(window, user32=None) -> bool:
    """
    Start the window move for a mousedown on one of the UI's drag surfaces.

    Windows implements this gesture already: DefWindowProc answers
    WM_NCLBUTTONDOWN carrying HTCAPTION by setting capture and running its own
    modal move loop until the button comes up. Handing the gesture over is what
    replaced pywebview's JS drag, which moved the window from the page (one
    bridge message per mousemove, position computed in JavaScript, walk-up over
    marked ancestors). That path could not see the stylesheet's
    `-webkit-app-region: no-drag`, so a mousedown on the card's seek bar moved
    the card out from under the pointer instead of seeking, and the gesture was
    invisible to the native tests. The OS loop also brings Aero Snap, per-monitor
    DPI correctness and drag-to-restore, none of which a JS move loop has.

    PostMessage, not SendMessage: the modal loop occupies the UI thread for the
    whole gesture, and this runs on the bridge thread — SendMessage would block
    it until the mouse came up, PostMessage returns immediately and the gesture
    is run by the thread that owns the mouse messages anyway.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        # Best effort. If this thread does not own the capture it is a no-op, and
        # DefWindowProc sets its own capture as the loop starts.
        _declare(user32.ReleaseCapture, ctypes.c_int, [])
        user32.ReleaseCapture()
        _declare(user32.PostMessageW, ctypes.c_int,
                 [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p])
        return bool(user32.PostMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0))
    except Exception:
        return False
```

- [ ] **Step 4: Run it to make sure it passes**

Run: `python -m unittest tests.test_native_window -v`
Expected: PASS, `BeginDragTest` 3 tests, whole module OK.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat core/native_window.py tests/test_native_window.py
```

---

### Task 2: Expose the gesture to the UI (`WindowApi.begin_drag`)

**Files:**
- Modify: `paprika_app.py` (`WindowApi` method next to `resize_window`; `window.expose(...)` list)
- Test: `tests/test_window_api.py` (new `WindowDragApiTest`)

**Interfaces:**
- Consumes: `native_window.begin_drag(window, user32=None) -> bool` (Task 1)
- Produces: `WindowApi.begin_drag() -> bool`, exposed to JS as `window.pywebview.api.begin_drag()`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_window_api.py`:

```python
@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class WindowDragApiTest(unittest.TestCase):
    """The UI decides *where* the window can be grabbed; the host does the grab."""

    def setUp(self):
        self.window = FakeWindow()
        self.api = paprika_app.WindowApi(self.window)
        self.drag = mock.Mock(return_value=True)
        patcher = mock.patch.object(paprika_app.native_window, "begin_drag", self.drag)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_starting_a_drag_goes_through_the_native_gesture(self):
        self.assertTrue(self.api.begin_drag())
        self.assertEqual(self.drag.call_args_list, [mock.call(self.window)])

    def test_the_bridge_reports_a_refused_gesture(self):
        # No HWND yet (the window is still being created): the UI must be told,
        # not left believing the window is following the pointer.
        self.drag.return_value = False
        self.assertFalse(self.api.begin_drag())
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python -m unittest tests.test_window_api.WindowDragApiTest -v`
Expected: FAIL — `AttributeError: 'WindowApi' object has no attribute 'begin_drag'`

- [ ] **Step 3: Implement and expose**

In `paprika_app.py`, in `WindowApi` directly after `resize_window`:

```python
    def begin_drag(self) -> bool:
        """
        Starts the window's native move gesture for a mousedown the UI accepted.

        The UI is the authority on *where* the window can be grabbed (its
        [data-drag] surfaces, minus anything marked [data-no-drag]), because only
        the page knows which of those pixels belong to a control. What it cannot
        do is move the window, so the gesture itself is the operating system's
        (see core.native_window.begin_drag) — which is also why this returns a
        bool instead of nothing: a refused grab is worth logging once, not
        silently dropping the pointer.
        """
        started = native_window.begin_drag(self.window)
        if not started:
            print("[Paprika Lyrics] Could not start a window move (no window handle yet).")
        return started
```

In the `window.expose(...)` call, add `api.begin_drag,` after `api.resize_window,`.

- [ ] **Step 4: Run it to make sure it passes**

Run: `python -m unittest tests.test_window_api -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat paprika_app.py tests/test_window_api.py
```

---

### Task 3: Drag surfaces in the UI (`data-drag` / `data-no-drag`), pywebview drag retired

**Files:**
- Modify: `ui/index.html` (drag attributes), `ui/app.js` (handler + `syncWindowDrag` rewrite + boot call), `ui/style.css` (cursors, delete `-webkit-app-region`), `tools/ui-preview-regression.js` (section 2 rewritten)

**Interfaces:**
- Consumes: `window.pywebview.api.begin_drag()` (Task 2)
- Produces: DOM contract — three `[data-drag]` surfaces (`.top-drag-strip`, `#track-float`, `.mini-drag`), `[data-no-drag]` on `#art-controls`, `#art-player`, `.float-progress-row`, `#latency-slider`, `#latency-rail`, `#quick-panel`; JS `initWindowDrag()`, `syncWindowDrag()` (same name, still called by `applyLayoutState`/`applyMiniState`)

- [ ] **Step 1: Mark the surfaces in `ui/index.html`**

- `<div class="top-drag-strip pywebview-drag-region" aria-hidden="true">` → `<div class="top-drag-strip" data-drag aria-hidden="true">`
- `<div class="track-float pywebview-drag-region" id="track-float">` → `<div class="track-float" id="track-float" data-drag>`
- `<div class="mini-drag pywebview-drag-region" aria-hidden="true">` → `<div class="mini-drag" data-drag aria-hidden="true">`
- `<div class="art-controls" id="art-controls">` → add `data-no-drag`
- `<div class="art-player" id="art-player">` → add `data-no-drag`
- `<div class="float-progress-row art-progress">` → add `data-no-drag`
- `.side-art-controls` div and the split panel's `.art-player` div → add `data-no-drag`
- `.latency-rail` div, `.latency-slider` div → add `data-no-drag`
- `<section class="settings-page" …>` → add `data-no-drag`
- Put `data-no-drag` on `<header id="app-header">` too, so a future nested drag surface cannot swallow the minimise/close buttons.

Update the three HTML comments that describe the pywebview walk-up (the card comment, the header comment, the mini-bar comment) to describe the new rule: *a mousedown inside `[data-drag]` moves the window unless an ancestor on the way up is `[data-no-drag]`; pywebview's own drag is not used.*

- [ ] **Step 2: Replace the drag logic in `ui/app.js`**

Replace the block at lines ~217-232 (`DRAG_REGION_CLASS`, `dragRegionElements`, `syncWindowDrag`) with:

```js
// ---------------------------------------------------------
// Window dragging
//
// One handler, one rule: a mousedown inside a [data-drag] surface moves the
// window, unless something on the way up is [data-no-drag] — the seek bar, the
// transport, the on-art buttons. The gesture itself is native
// (core.native_window.begin_drag): the operating system's own window move, with
// Aero Snap and per-monitor DPI, which nothing in the page can shadow.
//
// pywebview's own drag is deliberately not used. It moved the window from
// JavaScript — a body-level walk-up over `.pywebview-drag-region` ancestors plus
// a bridge message per mousemove — so the stylesheet's
// `-webkit-app-region: no-drag` never participated: a mousedown on the card's
// seek bar dragged the card away instead of seeking, and while fullscreen the
// overlay could still be torn off the monitor. No element carries that class any
// more (tools/ui-preview-regression.js asserts it stays that way).
// ---------------------------------------------------------
let dragSurfacesEnabled = true;

function syncWindowDrag() {
  // A fullscreen surface is fixed: the gesture is refused wholesale.
  dragSurfacesEnabled = !isFullscreen;
}

function initWindowDrag() {
  // Capture phase: a control that stops propagation on mousedown must not be
  // able to leave the window glued in place.
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !dragSurfacesEnabled) return;
    // A double-click is a click, not a drag. Windows turns a caption double-click
    // into a maximise, which an overlay never wants.
    if (event.detail > 1) return;
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-no-drag]')) return;
    if (!target.closest('[data-drag]')) return;
    const api = window.pywebview && window.pywebview.api;
    if (api && api.begin_drag) api.begin_drag();
  }, true);
}
```

Then add `initWindowDrag();` to the boot sequence in `ui/app.js` (the block that calls `initFloatArt(); initHoverFade(); initPointerChrome();`), after `initPointerChrome();`.

Also update the comment block above `setMiniBarRevealed` (which says "the drag strip behind them stays live") to say *drag surface*, and the comment above `MINI_BAR_REVEAL_PX` accordingly — no code change there.

- [ ] **Step 3: Fix the stylesheet**

Run `grep -n "app-region" ui/style.css` and delete **every** `-webkit-app-region` declaration (16 of them today: `drag` at the header, `.track-float`, `.top-drag-strip`, `.mini-drag`; `no-drag` at `.window-controls`, `.track-float .art-controls/.art-player/.float-progress`, `#lyrics-container`, the latency rail/buttons, `.resize-handle`, `.mini-btn`, and the two fullscreen blocks). They are inert under WebView2 and they taught the wrong model in their comments.

Replace the affordance with cursors:

```css
/* Drag surfaces say so with the pointer: `grab` is how a Windows title bar reads.
   The interactive children of a surface set their own cursor back to default (or
   keep their own), so the affordance never lies. */
[data-drag] { cursor: grab; }
[data-drag]:active { cursor: grabbing; }
[data-no-drag], [data-no-drag] * { cursor: auto; }
.top-drag-strip { cursor: grab; }
.track-float .track-text { cursor: grab; }
```

Delete the now-wrong comment blocks that explain `pywebview-drag-region` at style.css ~440-455 and ~2750-2775 (keep the fullscreen rules themselves: `body.is-fullscreen .top-drag-strip { display: none; }` and the grips being hidden in fullscreen and mini).

- [ ] **Step 4: Rewrite section 2 of `tools/ui-preview-regression.js`**

Replace the `--- 2. no drag regions while fullscreen ---` block with a version that asserts reachability rather than class presence:

```js
  // --- 2. drag surfaces (the window's move affordance) ------------------
  // The gesture is native now, so what a page can prove is the part that decides
  // it: which elements are surfaces, that nothing invisible covers them, and that
  // the controls stay opted out.
  setFullscreen(true);
  result.fullscreenDragSurfaces = document.querySelectorAll('[data-drag]').length;
  result.fullscreenResizeGrips = [...document.querySelectorAll('.resize-handle')]
    .filter((h) => getComputedStyle(h).display !== 'none').length;
  if (result.fullscreenResizeGrips !== 0) problems.push('fullscreen still has resize grips');
  // Fullscreen refuses the gesture in JS, so the surfaces may stay marked; what
  // must not survive is pywebview's own selector - that path moved the window
  // from the page and could not see a no-drag opt-out.
  if (document.querySelector('.pywebview-drag-region')) {
    problems.push('a pywebview drag region is still marked');
  }

  setFullscreen(false);
  result.windowedDragSurfaces = [...document.querySelectorAll('[data-drag]')]
    .map((el) => el.id || el.className.split(' ')[0]);
  if (result.windowedDragSurfaces.length !== 3) {
    problems.push('windowed drag surfaces are ' + result.windowedDragSurfaces.join(',') +
      ' (expected the top strip, the card and the mini drag handle)');
  }
  // The seek bar and the transport must opt out, or a mousedown on them would
  // move the window instead of seeking / playing.
  result.seekOptsOut = !!document.querySelector('#art-progress')?.closest('[data-no-drag]');
  result.transportOptsOut = !!document.querySelector('#art-player')?.closest('[data-no-drag]');
  if (!result.seekOptsOut) problems.push('the seek bar is inside a drag surface with no opt-out');
  if (!result.transportOptsOut) problems.push('the transport is inside a drag surface with no opt-out');

  // Reachability, sampled across the strip the user actually grabs: whatever is
  // hit at those pixels must belong to a drag surface. (This is what would have
  // caught an invisible layer sitting over the top band.)
  const stripEl = document.querySelector('.top-drag-strip');
  const strip = box(stripEl);
  const misses = [];
  for (const x of [strip.left + 3, strip.left + strip.width * 0.35, strip.left + strip.width * 0.7]) {
    for (const y of [strip.top + 14, strip.top + 30, strip.top + 46]) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !hit.closest('[data-drag]')) misses.push(Math.round(x) + ',' + Math.round(y));
    }
  }
  result.topBandMisses = misses;
  if (misses.length) problems.push('the top band misses a drag surface at ' + misses.join(' '));
  if (strip.height < 44) problems.push('the top drag strip is shorter than the header band');
  if (strip.right > document.querySelector('#app-header .window-controls').getBoundingClientRect().left + 1) {
    problems.push('the top drag strip covers the window controls');
  }
  // ... and a lyric click must not become a window move.
  const lyricHit = document.elementFromPoint(window.innerWidth * 0.5, window.innerHeight * 0.55);
  result.lyricsNotADragSurface = !lyricHit || !lyricHit.closest('[data-drag]');
  if (!result.lyricsNotADragSurface) problems.push('the lyric area is a drag surface');
  // Window controls stay reachable and opted out.
  const controls = document.querySelector('#app-header .window-controls');
  result.controlsInteractive = !!controls &&
    !controls.closest('[data-drag]') &&
    getComputedStyle(controls).pointerEvents === 'auto' &&
    getComputedStyle(controls.querySelector('.btn')).pointerEvents !== 'none';
  if (!result.controlsInteractive) problems.push('window controls are unreachable while windowed');
```

Keep the mini-player assertions from the old section 4, but change `miniBarDragIsSiblingOfButtons` to:

```js
  const miniDrag = document.querySelector('.mini-drag');
  result.miniBarDragIsSiblingOfButtons =
    !!miniDrag && !miniDrag.querySelector('button') &&
    !document.querySelector('.mini-bar button')?.closest('[data-drag]');
```

and the reachability check to `elementFromPoint` in the middle of `.mini-drag` being inside `[data-drag]`.

- [ ] **Step 5: Verify**

```bash
node --check ui/app.js && node --check tools/ui-preview-regression.js
grep -rn "pywebview-drag-region" ui/ | grep -v "^ui/app.js" || echo "no stale markers"
python -m http.server 8471 > /dev/null 2>&1 &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8471/ui/index.html
```
Expected: both `node --check` silent; `no stale markers` (the surviving mention is inside the explanatory comment in `app.js`); `200`.

Then in the preview (`http://127.0.0.1:8471/ui/index.html`) at 1400×900, 900×700, 800×600, 360×420, 330×380: load the tool (`await fetch('tools/ui-preview-regression.js').then(r => r.text()).then(t => eval(t))`) and run `await run('<size>')` at each. Expected: `PASS` with `windowedDragSurfaces` = `['top-drag-strip','track-float','mini-drag']`, `topBandMisses` empty, `seekOptsOut`/`transportOptsOut`/`lyricsNotADragSurface`/`controlsInteractive` all true.

- [ ] **Step 6: Checkpoint**

```bash
git diff --stat ui/index.html ui/app.js ui/style.css tools/ui-preview-regression.js
```

---

### Task 4: Transparency that holds — one base opacity, on top of the hover dip (UI policy)

**Files:**
- Modify: `ui/app.js` (opacity model + rename), `ui/index.html` (the new row; final position set in Task 6), `tools/ui-preview-regression.js` (section 10 rewritten)

**Interfaces:**
- Consumes: `window.pywebview.api.set_window_alpha(alpha)` (unchanged)
- Produces: JS `OPACITY_LEVELS`, `OPACITY_LABELS`, `opacityIndex`, `windowOpacityValue()`, `windowAlphaTarget()`, `applyWindowOpacity()`, `cycleWindowOpacity()`, `appliedAlpha`; DOM `#qp-opacity`, `#qp-opacity-state`. The names `applyHoverFade`, `hoverFadeTarget` and `hoverFadeApplied` **cease to exist**.

**Why:** transparency and click-through are two bits of one window today, and the UI forces the window opaque the moment click-through is on (`hoverFadeTarget()` returns 1) — which is exactly backwards for a seamless overlay. There is also no way to ask for a permanently translucent window: the alpha is only ever driven by the pointer. The model becomes: a saved **base opacity** that applies the whole time the overlay is windowed (mini and click-through included), and the hover fade as a **dip below** it. Fullscreen is the one mode that returns to opaque — the chosen scope.

- [ ] **Step 1: Rewrite the transparency block in `ui/app.js`**

Replace lines ~450-495 (from the `Fade while hovered` header through `cycleHoverFade`) with:

```js
// =========================================================
// Window transparency
// One value in two parts. The BASE opacity is what the user picked and applies
// the whole time the overlay is windowed — the mini player and click-through
// included, because a see-through overlay you can click through is the point of
// both. The hover dip takes it a little further down while the pointer is over
// the overlay, and stands down the moment the pointer leaves or Ctrl is held.
//
// Fullscreen is the one mode that refuses transparency: there the overlay covers
// the monitor the user is looking at, and dimming the screen is not
// transparency, it is a bug. Click-through is the other edge: it removes the
// pointer events the dip is derived from, so the base applies undipped instead
// of leaving a stuck dip behind.
//
// The host owns the mechanism (core.native_window.set_window_alpha makes the
// window a layered one, so content, artwork and glass fade as one surface); the
// policy lives here, because every input that decides it — the setting, the
// pointer, Ctrl, click-through, fullscreen — is in this file.
// =========================================================
const OPACITY_LEVELS = [1, 0.95, 0.9, 0.8, 0.7, 0.6];
const OPACITY_LABELS = ['Off', '95%', '90%', '80%', '70%', '60%'];
const HOVER_FADE_LEVELS = ['off', 'light', 'clear'];
const HOVER_FADE_LABELS = { off: 'Off', light: 'Light', clear: 'Clear' };
const HOVER_FADE_ALPHA = { light: 0.86, clear: 0.7 };
let opacityIndex = 0;        // index into OPACITY_LEVELS; 0 is fully opaque
let hoverFade = 'off';
let hoverFadeInside = false;
let hoverFadeCtrl = false;
let appliedAlpha = 1;        // what the host was last asked for

function windowOpacityValue() {
  return OPACITY_LEVELS[opacityIndex] || 1;
}

function windowAlphaTarget() {
  if (isFullscreen) return 1;
  const base = windowOpacityValue();
  if (clickThrough) return base;
  // The settings sheet is text being read: the pointer being over it is not a
  // reason to dim the thing being read.
  if (document.body.classList.contains('settings-open')) return base;
  if (hoverFade === 'off' || !hoverFadeInside || hoverFadeCtrl) return base;
  return Math.min(base, HOVER_FADE_ALPHA[hoverFade] || base);
}

function applyWindowOpacity() {
  const target = windowAlphaTarget();
  if (Math.abs(target - appliedAlpha) < 0.001) return;
  appliedAlpha = target;
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_window_alpha) api.set_window_alpha(target);
}

function cycleWindowOpacity() {
  opacityIndex = (opacityIndex + 1) % OPACITY_LEVELS.length;
  Settings.set('opacity', String(opacityIndex));
  // The pointer is on the row that was just clicked, so the window changes under
  // it immediately — which is the whole point of a transparency setting.
  applyWindowOpacity();
  syncSettingsPanel();
}

function cycleHoverFade() {
  const idx = HOVER_FADE_LEVELS.indexOf(hoverFade);
  hoverFade = HOVER_FADE_LEVELS[(idx + 1) % HOVER_FADE_LEVELS.length];
  Settings.set('hoverFade', hoverFade);
  applyWindowOpacity();
  syncSettingsPanel();
}
```

Rename every remaining call: `applyHoverFade()` → `applyWindowOpacity()` at the 9 call sites (`setFullscreen`, `initHoverFade`'s five listeners, `window.setClickThrough`, `openSettings`) and update the two comments that name it (`initHoverFade`'s header, `openSettings`'s sheet comment).

- [ ] **Step 2: Load and show the setting**

In the persisted-preferences block at the bottom of `ui/app.js` (where `savedHoverFade` is read), add:

```js
  const savedOpacity = parseInt(Settings.get('opacity', '0'), 10);
  if (Number.isInteger(savedOpacity) && savedOpacity >= 0 && savedOpacity < OPACITY_LEVELS.length) {
    opacityIndex = savedOpacity;
  }
```

In `syncSettingsPanel()`, add next to the hover-fade line:

```js
  setValueText(document.getElementById('qp-opacity-state'), OPACITY_LABELS[opacityIndex] || 'Off');
```

- [ ] **Step 3: Add the row to `ui/index.html`**

Immediately above the existing `qp-hover-fade` button (Task 6 moves the whole group; the row order inside it starts here):

```html
            <button class="qp-row qp-action" id="qp-opacity" onclick="cycleWindowOpacity()">
              <span class="qp-label">Window opacity</span>
              <span class="qp-state" id="qp-opacity-state">Off</span>
            </button>
```

- [ ] **Step 4: Rewrite section 10 of the regression tool**

Replace `--- 10. fade while hovered ---` with the opacity policy checks:

```js
  // --- 10. window transparency ------------------------------------------
  // The host applies whatever alpha it is handed, so the whole policy is testable
  // here: the base applies while windowed, the dip goes below it, Ctrl and the
  // settings sheet cancel only the dip, click-through keeps the base, and
  // fullscreen is opaque.
  const alphaCalls = [];
  const fadeBridge = window.pywebview;
  window.pywebview = { api: { set_window_alpha: (a) => { alphaCalls.push(a); return a; } } };
  const savedFadeState = { opacityIndex, hoverFade, hoverFadeInside, hoverFadeCtrl, appliedAlpha, clickThrough };
  hoverFadeInside = false;
  hoverFadeCtrl = false;
  hoverFade = 'light';        // the dip is on, so it must be visible in the numbers
  opacityIndex = 0;           // base Off
  appliedAlpha = 1;
  applyWindowOpacity();
  result.alphaWithPointerAway = alphaCalls.length ? alphaCalls[alphaCalls.length - 1] : null;
  hoverFadeInside = true;
  applyWindowOpacity();
  result.dipAlpha = alphaCalls[alphaCalls.length - 1];
  const pushesBeforeRepeat = alphaCalls.length;
  applyWindowOpacity();
  result.alphaPushesOnlyOnChange = alphaCalls.length === pushesBeforeRepeat;
  hoverFadeCtrl = true;
  applyWindowOpacity();
  result.alphaWithCtrl = alphaCalls[alphaCalls.length - 1];
  hoverFadeCtrl = false;
  opacityIndex = 3;           // 80% base
  appliedAlpha = 1;
  applyWindowOpacity();
  result.baseAlpha = alphaCalls[alphaCalls.length - 1];
  result.alphaDipsBelowBase = Math.min(result.baseAlpha, HOVER_FADE_ALPHA.light) === result.baseAlpha;
  clickThrough = true;
  appliedAlpha = 1;
  applyWindowOpacity();
  result.alphaWhileClickThrough = alphaCalls[alphaCalls.length - 1];
  clickThrough = false;
  setFullscreen(true);
  appliedAlpha = 1;
  applyWindowOpacity();
  result.alphaInFullscreen = alphaCalls[alphaCalls.length - 1];
  setFullscreen(false);
  appliedAlpha = 1;
  applyWindowOpacity();
  result.alphaBackWindowed = alphaCalls[alphaCalls.length - 1];
  body.classList.remove('is-fullscreen');
  if (result.alphaWithPointerAway !== 1) problems.push('the base opacity leaked onto an opaque setting');
  if (!(result.dipAlpha < 1 && result.dipAlpha >= 0.7)) problems.push('the hover dip is out of range: ' + result.dipAlpha);
  if (!result.alphaPushesOnlyOnChange) problems.push('every re-evaluation pushed an alpha to the host');
  if (result.alphaWithCtrl !== 1) problems.push('Ctrl does not cancel the dip: ' + result.alphaWithCtrl);
  if (result.baseAlpha !== 0.8) problems.push('the base opacity was not applied: ' + result.baseAlpha);
  if (!result.alphaDipsBelowBase) problems.push('the dip went below the chosen base');
  if (result.alphaWhileClickThrough !== 0.8) problems.push('click-through did not keep the base opacity: ' + result.alphaWhileClickThrough);
  if (result.alphaInFullscreen !== 1) problems.push('fullscreen is not opaque: ' + result.alphaInFullscreen);
  if (result.alphaBackWindowed !== 0.8) problems.push('leaving fullscreen lost the base opacity: ' + result.alphaBackWindowed);
  result.hasOpacityRow = !!document.getElementById('qp-opacity');
  if (!result.hasOpacityRow) problems.push('the settings sheet has no window-opacity row');
  Object.assign({ opacityIndex, hoverFade, hoverFadeInside, hoverFadeCtrl, appliedAlpha, clickThrough }, savedFadeState);
  window.pywebview = fadeBridge;
```

(Note the restored state uses `Object.assign` onto the top-level bindings — `clickThrough`, `hoverFade` etc. are `let` at module scope, so assigning them directly is what the rest of the tool already does.)

- [ ] **Step 5: Verify**

```bash
node --check ui/app.js && node --check tools/ui-preview-regression.js
```
Expected: silent. Then run the tool at all five viewports as in Task 3 Step 5. Expected `PASS`, with `baseAlpha 0.8`, `alphaInFullscreen 1`.

- [ ] **Step 6: Checkpoint**

```bash
git diff --stat ui/app.js ui/index.html tools/ui-preview-regression.js
```

---

### Task 5: Make the host's alpha survive every native mutation

**Files:**
- Modify: `paprika_app.py` (`_apply_click_through`, new `_reapply_alpha`, delete `_reset_window_alpha`), `core/native_window.py` (`set_click_through` says "opaque" when it layers the window; extract `_set_layered_alpha`)
- Test: `tests/test_window_api.py` (alpha tests updated), `tests/test_native_window.py` (one new test)

**Interfaces:**
- Consumes: `native_window.set_window_alpha`, `native_window.set_click_through`
- Produces: private `native_window._set_layered_alpha(user32, hwnd, byte) -> bool`; `WindowApi._reapply_alpha()`; `WindowApi._reset_window_alpha` **removed**

**Why:** rewriting `GWL_EXSTYLE` can drop a layered window's attributes, and the transparency is exactly those attributes — so the two features can silently cancel each other. The host must also stop forcing the window opaque on fullscreen (that decision now lives in the UI, per Task 4).

- [ ] **Step 1: Write the failing tests**

In `tests/test_native_window.py`, inside `TopmostAndClickThroughTest`:

```python
    def test_layering_a_window_says_opaque_out_loud(self):
        # WS_EX_LAYERED with no attributes set is not a defined opacity; say
        # "opaque" once, so turning click-through on can never blank the overlay.
        u = FakeUser32()
        nw.set_click_through(FakeWindow(), True, user32=u)
        self.assertEqual(u.alpha_calls, [(255, nw.LWA_ALPHA)])

    def test_an_existing_alpha_is_left_alone(self):
        u = FakeUser32()
        nw.set_window_alpha(FakeWindow(), 0.7, user32=u)
        nw.set_click_through(FakeWindow(), True, user32=u)
        # The alpha the user asked for is the last word, not our 255.
        self.assertEqual(u.alpha_calls[-1], (179, nw.LWA_ALPHA))
```

In `tests/test_window_api.py`, inside `WindowAlphaApiTest`, replace `test_fullscreen_forces_the_window_opaque` with:

```python
    def test_leaving_the_alpha_to_the_ui_means_fullscreen_does_not_snap_it(self):
        # The mode policy (fullscreen is opaque) lives in the UI, which pushes the
        # new alpha right after a toggle. The host only re-asserts what it holds.
        self.api.set_window_alpha(0.6)
        self.applied.clear()
        self.api.toggle_fullscreen()
        self.assertEqual(self.applied, [])

    def test_a_click_through_change_re_asserts_the_alpha(self):
        # GWL_EXSTYLE churn can drop a layered window's attributes; without this
        # the window came back fully opaque the moment click-through was toggled.
        self.api.set_window_alpha(0.6)
        self.applied.clear()
        with mock.patch.object(paprika_app, "CLICK_THROUGH_ENABLED", False), \
                mock.patch.object(paprika_app.HOTKEY_MANAGER, "click_through_bound", True), \
                mock.patch.object(paprika_app.native_window, "set_click_through", return_value=True):
            self.api.set_click_through(True)
        self.assertEqual(self.applied, [0.6])
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `python -m unittest tests.test_native_window.TopmostAndClickThroughTest tests.test_window_api.WindowAlphaApiTest -v`
Expected: FAIL — no alpha call on click-through (`[]` vs `[(255, ...)]`), and `test_a_click_through_change_re_asserts_the_alpha` gets `[]`.

- [ ] **Step 3: Extract the layered-alpha write and use it in click-through**

In `core/native_window.py`, add after `_set_window_long`:

```python
def _set_layered_alpha(user32, hwnd: int, byte: int) -> bool:
    """The one place LWA_ALPHA is written, so the two users agree on the byte."""
    _declare(user32.SetLayeredWindowAttributes, ctypes.c_int,
             [ctypes.c_void_p, ctypes.c_uint, ctypes.c_ubyte, ctypes.c_uint])
    return bool(user32.SetLayeredWindowAttributes(
        ctypes.c_void_p(hwnd), 0, ctypes.c_ubyte(max(0, min(255, int(byte)))), LWA_ALPHA))
```

Rewrite `set_click_through` to:

```python
def set_click_through(window, enabled: bool, user32=None) -> bool:
    """
    Toggles WS_EX_TRANSPARENT (with WS_EX_LAYERED, which it requires).

    When this is what layers the window, the alpha is written as fully opaque
    straight away: a layered window with no attributes set is not a defined
    opacity, and the failure mode is an invisible overlay the user cannot click.
    A window that is already layered keeps whatever alpha it has — the UI's
    transparency is the last word (paprika_app re-asserts it right after this).
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        ex = _get_window_long(user32, hwnd, GWL_EXSTYLE)
        if enabled:
            new = ex | WS_EX_TRANSPARENT | WS_EX_LAYERED
        else:
            new = ex & ~WS_EX_TRANSPARENT
        if new == ex:
            return True
        _set_window_long(user32, hwnd, GWL_EXSTYLE, new)
        if enabled and not (ex & WS_EX_LAYERED):
            _set_layered_alpha(user32, hwnd, 255)
        return True
    except Exception:
        return False
```

and have `set_window_alpha` end with `return _set_layered_alpha(user32, hwnd, byte)` instead of its inline `_declare`/`SetLayeredWindowAttributes` pair.

- [ ] **Step 4: Make the host re-assert the alpha**

In `paprika_app.py`:

1. Delete `_reset_window_alpha` and replace it with:

```python
    def _reapply_alpha(self):
        """
        Re-assert the alpha the UI last asked for, without animating.

        Every path that rewrites GWL_EXSTYLE — click-through, a fullscreen style
        change — can drop a layered window's attributes, and the transparency is
        exactly those attributes. Re-applying them keeps the two features
        composing instead of one silently cancelling the other. When the window is
        meant to be opaque there is nothing to re-assert and the window is left
        unlayered, which also keeps DWM's rounded corners on their normal path.
        """
        if self._alpha_current >= 1.0:
            return
        native_window.set_window_alpha(self.window, self._alpha_current)
```

2. In `_apply_click_through`, call it after a successful style change:

```python
    def _apply_click_through(self, enabled: bool):
        if native_window.set_click_through(self.window, enabled):
            # The ex-style write above can drop the layered attributes the
            # transparency lives in: put the alpha back before anything repaints.
            self._reapply_alpha()
            if getattr(self, '_fullscreen', False):
                native_window.reassert_fullscreen(self.window)
        else:
            print("[Paprika Lyrics] Could not change click-through state.")
```

3. In `toggle_fullscreen`, replace `self._reset_window_alpha()` with `self._reapply_alpha()` (Task 8 rewrites this method wholesale; do it there if Task 8 lands first — the rename must not be left dangling either way).

- [ ] **Step 5: Run the suite**

Run: `python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"`
Expected: `Ran <N> tests` (294 + 4 new − 1 removed/replaced) `OK`.

- [ ] **Step 6: Checkpoint**

```bash
git diff --stat core/native_window.py paprika_app.py tests/
```

---

### Task 6: Settings ordered by how often you touch it

**Files:**
- Modify: `ui/index.html` (group order, hints), `tools/ui-preview-regression.js` (new order assertion)

**Interfaces:**
- Consumes: `#qp-opacity` (Task 4)
- Produces: DOM contract — `#quick-panel .sp-group-title` reads, in order: `Window`, `Sync`, `Lyrics`, `Motion`, `Local lyrics`, `Diagnostics`

**Why:** the sheet opens on Sync, then wanders through Lyrics/Local lyrics/Motion before reaching the window controls — the rows you touch while looking at the overlay are last, and one paragraph about the fade sits *outside* every group, which reads as unfinished. Ordering by how often a row is used, keeping the two long hints down to the line that matters, and leaving Diagnostics collapsed at the bottom is the clutter fix.

- [ ] **Step 1: Reorder and re-title the groups in `ui/index.html`**

The `<div class="sp-body">` children become, in this order:

1. **`Window`** — rows in this order: `qp-opacity`, `qp-hover-fade`, `qp-layout`, `qp-fullscreen`, `qp-ontop`, `qp-clickthrough`, `qp-card-position`, followed by this hint (replacing the orphan paragraph and the old fade paragraph; delete the old one after the Window group entirely):

```html
            <p class="sp-hint">Opacity applies whenever the overlay is windowed — the hover
              dip goes a little further while the pointer is over it, and <kbd
              style="font-family:inherit;opacity:.6">Ctrl</kbd> holds it at your level. Fullscreen
              always stays solid. With click-through on, <kbd
              style="font-family:inherit;opacity:.6">Ctrl+Shift+M</kbd> hands the mouse back for a
              few seconds so the window can still be moved.</p>
```

2. **`Sync`** — unchanged rows and stepper; shorten the hint to:

```html
            <p class="sp-hint">Lyric timing against playback — a larger offset shows lyrics
              earlier. Also on <kbd style="font-family:inherit;opacity:.6">Ctrl+[</kbd> later /
              <kbd style="font-family:inherit;opacity:.6">Ctrl+]</kbd> earlier, saved per track.</p>
```

3. **`Lyrics`** — unchanged (`qp-trans`, `qp-font`, `qp-align`).
4. **`Motion`** — unchanged.
5. **`Local lyrics`** — unchanged, with its hint shortened to two lines:

```html
            <p class="sp-hint">Add Apple Music <code>.ttml</code> files for songs the online lookup
              mis-times. A file is used when its own title and artist match the playing song;
              anything else is one click away below. Removed files move to a <code>.trash</code>
              folder inside the library.</p>
```

6. **`Diagnostics`** — unchanged (collapsed `qp-info-toggle` + `qp-info`).

Update the README quote of the section order later (Task 11); the `<section class="sp-group">` markup itself moves as a block — do not re-indent the inner rows beyond the existing two levels.

- [ ] **Step 2: Assert the order in the regression tool**

In section 5 (settings sheet), after `panel.classList.add('open')`:

```js
  result.settingsOrder = [...document.querySelectorAll('#quick-panel .sp-group-title')]
    .map((h) => h.textContent.trim());
  const expectedOrder = ['Window', 'Sync', 'Lyrics', 'Motion', 'Local lyrics', 'Diagnostics'];
  if (JSON.stringify(result.settingsOrder) !== JSON.stringify(expectedOrder)) {
    problems.push('settings groups are ' + result.settingsOrder.join(' / ') +
      ' (expected ' + expectedOrder.join(' / ') + ')');
  }
  result.settingsHints = document.querySelectorAll('#quick-panel .sp-hint').length;
```

- [ ] **Step 3: Verify**

Run the preview tool at all five viewports; expected `PASS` with `settingsOrder` equal to the expected array and `settingsHints` = 3 (Window, Sync, Local lyrics).

- [ ] **Step 4: Checkpoint**

```bash
git diff --stat ui/index.html tools/ui-preview-regression.js
```

---

### Task 7: Real fullscreen — cover the monitor, never maximize (`core/native_window`)

**Files:**
- Modify: `core/native_window.py` (`apply_fullscreen`, `restore_windowed`, `reassert_fullscreen`, `_set_bounds`, new `_show_window`, `_set_dwm_frame`, new constants, module docstring)
- Test: `tests/test_native_window.py` (`ApplyFullscreenTest` rewritten, new `FakeDwmapi`)

**Interfaces:**
- Consumes: `_hwnd_of`, `monitor_bounds`, `_get_window_long`, `_set_window_long`, `is_covering_monitor`
- Produces: `apply_fullscreen(window, user32=None, dwmapi=None) -> int | None` (the window's previous `GWL_STYLE`), `restore_windowed(window, rect, style=None, user32=None, dwmapi=None) -> bool`, `reassert_fullscreen(window, user32=None) -> bool` (unchanged signature), `_set_bounds(user32, hwnd, bounds, flags=None) -> bool`, `_show_window(user32, hwnd, command) -> bool`, `_set_dwm_frame(dwmapi, hwnd, fullscreen: bool) -> None`; constants `SW_RESTORE = 9`, `SWP_FRAMECHANGED = 0x0020`, `DWMWCP_DONOTROUND = 1`

**Why:** pywebview's `toggle_fullscreen` enters fullscreen as `FormBorderStyle=None` + `WindowState=Maximized`. Windows treats a maximized window's bounds as *derived state*, so the next thing that touches the window (a `SetWindowPos` from always-on-top, an ex-style change from click-through) makes the form manager re-apply them from the **work area** — the overlay silently shrinks to taskbar-cut size while the UI still believes it is fullscreen. The seam already had the right implementation (`apply_fullscreen`, keeping `WindowState` Normal) but nothing called it. This task makes it correct and the next one wires it up.

- [ ] **Step 1: Write the failing tests**

In `tests/test_native_window.py`, add a fake DWM next to `FakeUser32`:

```python
class FakeDwmapi:
    """Records DWM attribute writes so the fullscreen frame can be asserted."""

    def __init__(self):
        self.calls = []

    def DwmSetWindowAttribute(self, hwnd, attribute, ptr, size):
        value = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_int)).contents.value
        self.calls.append((attribute, value))
        return 0
```

Replace `ApplyFullscreenTest` with:

```python
class ApplyFullscreenTest(unittest.TestCase):
    """Fullscreen covers the monitor at NORMAL state — never a maximized form."""

    def test_fullscreen_covers_the_monitor_and_takes_the_maximize_away_first(self):
        u = FakeUser32()
        style = nw.apply_fullscreen(FakeWindow(), user32=u)
        self.assertIsNotNone(style)
        self.assertTrue(u.has_monitor_bounds())
        self.assertFalse(u.has_work_area_bounds())
        # A maximized window's bounds are derived state: leave that state or
        # Windows re-applies them from the work area on the next native touch.
        self.assertIn(nw.SW_RESTORE, u.window_commands)
        self.assertEqual(u.styles["style"] & nw.FULLSCREEN_CLEAR_STYLE, 0)
        self.assertTrue(u.styles["style"] & nw.WS_POPUP)
        # The style change has to land on this pass, not on the next resize.
        self.assertTrue(u.last("SetWindowPos")[7] & nw.SWP_FRAMECHANGED)

    def test_leaving_fullscreen_puts_the_exact_style_and_rect_back(self):
        u = FakeUser32()
        before = u.styles["style"]
        style = nw.apply_fullscreen(FakeWindow(), user32=u)
        self.assertTrue(nw.restore_windowed(FakeWindow(), (100, 100, 800, 600), style, user32=u))
        self.assertEqual(u.styles["style"], before)
        self.assertEqual(u.pos, (100, 100, 800, 600))
        self.assertTrue(u.last("SetWindowPos")[7] & nw.SWP_FRAMECHANGED)

    def test_the_dwm_frame_is_dropped_for_fullscreen_and_restored_after(self):
        u, d = FakeUser32(), FakeDwmapi()
        style = nw.apply_fullscreen(FakeWindow(), user32=u, dwmapi=d)
        self.assertIn((nw.DWMWA_WINDOW_CORNER_PREFERENCE, nw.DWMWCP_DONOTROUND), d.calls)
        # COLOR_NONE/DEFAULT are 0xFFFFFFFE / 0xFFFFFFFF, which the c_int they are
        # written as represents as negative numbers.
        self.assertIn((nw.DWMWA_BORDER_COLOR, ctypes.c_int(nw.DWMWA_COLOR_NONE).value), d.calls)
        nw.restore_windowed(FakeWindow(), (100, 100, 800, 600), style, user32=u, dwmapi=d)
        self.assertEqual(d.calls[-2], (nw.DWMWA_WINDOW_CORNER_PREFERENCE, nw.DWMWCP_ROUND))
        self.assertEqual(d.calls[-1], (nw.DWMWA_BORDER_COLOR, ctypes.c_int(nw.DWMWA_COLOR_DEFAULT).value))

    def test_a_missing_dwm_never_fails_the_gesture(self):
        class ExplodingDwm:
            def DwmSetWindowAttribute(self, *a):
                raise OSError("no dwm")
        u = FakeUser32()
        self.assertIsNotNone(nw.apply_fullscreen(FakeWindow(), user32=u, dwmapi=ExplodingDwm()))

    def test_a_failed_bounds_call_reports_failure(self):
        u = FakeUser32()
        u.SetWindowPos = lambda *a: 0
        self.assertIsNone(nw.apply_fullscreen(FakeWindow(), user32=u))

    def test_reassert_reapplies_monitor_bounds_after_work_area_shrink(self):
        u = FakeUser32()
        nw.apply_fullscreen(FakeWindow(), user32=u)
        u.pos = list(u.WORK)
        u.rect = list(u.WORK)
        self.assertTrue(nw.reassert_fullscreen(FakeWindow(), user32=u))
        self.assertTrue(u.has_monitor_bounds())

    def test_reassert_is_a_noop_when_still_covering(self):
        u = FakeUser32()
        nw.apply_fullscreen(FakeWindow(), user32=u)
        setpos_calls = sum(1 for c in u.calls if c[0] == "SetWindowPos")
        self.assertTrue(nw.reassert_fullscreen(FakeWindow(), user32=u))
        self.assertEqual(sum(1 for c in u.calls if c[0] == "SetWindowPos"), setpos_calls)

    def test_is_covering_monitor_distinguishes_monitor_from_work_area(self):
        u = FakeUser32()
        nw.apply_fullscreen(FakeWindow(), user32=u)
        self.assertTrue(nw.is_covering_monitor(u, u.hwnd))
        u.rect = list(u.WORK)
        self.assertFalse(nw.is_covering_monitor(u, u.hwnd))

    def test_restore_without_a_saved_style_still_drops_the_fullscreen_bits(self):
        u = FakeUser32()
        nw.apply_fullscreen(FakeWindow(), user32=u)
        self.assertTrue(nw.restore_windowed(FakeWindow(), (100, 100, 800, 600), user32=u))
        self.assertNotEqual(u.styles["style"] & nw.FULLSCREEN_CLEAR_STYLE, 0)
```

Also update `FailurePathsTest.test_no_hwnd_returns_false_everywhere` to `self.assertIsNone(nw.apply_fullscreen(NoHandle(), user32=u))` and add `self.assertFalse(nw.begin_drag(NoHandle(), user32=u))`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `python -m unittest tests.test_native_window.ApplyFullscreenTest -v`
Expected: FAIL on the new assertions (`ShowWindow` missing, no `SWP_FRAMECHANGED`, DWM calls `[]`, `apply_fullscreen` returns `True` not a style).

- [ ] **Step 3: Implement**

In `core/native_window.py`:

1. Extend the constants block:

```python
SWP_FRAMECHANGED = 0x0020
SW_RESTORE = 9
DWMWCP_DONOTROUND = 1
```

2. Give `_set_bounds` an explicit flags argument:

```python
def _set_bounds(user32, hwnd: int, bounds: tuple[int, int, int, int], flags: int = None) -> bool:
    _declare(user32.SetWindowPos, ctypes.c_int, [
        ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
    ])
    if flags is None:
        flags = SWP_NOZORDER | SWP_NOACTIVATE
    x, y, w, h = bounds
    return bool(user32.SetWindowPos(hwnd, None, x, y, w, h, flags))
```

3. Add the two small helpers:

```python
def _show_window(user32, hwnd: int, command: int) -> bool:
    _declare(user32.ShowWindow, ctypes.c_int, [ctypes.c_void_p, ctypes.c_int])
    return bool(user32.ShowWindow(hwnd, command))


def _set_dwm_frame(dwmapi, hwnd: int, fullscreen: bool) -> None:
    """
    Turns DWM's rounded corners and 1px border off for fullscreen, back on for
    windowed. A rounded overlay covering a whole monitor shows four desktop
    wedges in the corners, and the border draws a line around the picture.
    Best effort: DWM is optional for the gesture.
    """
    if dwmapi is None:
        try:
            dwmapi = ctypes.windll.dwmapi
        except Exception:
            return
    try:
        corner = ctypes.c_int(DWMWCP_DONOTROUND if fullscreen else DWMWCP_ROUND)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                                     ctypes.byref(corner), ctypes.sizeof(corner))
        border = ctypes.c_int(DWMWA_COLOR_NONE if fullscreen else DWMWA_COLOR_DEFAULT)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR,
                                     ctypes.byref(border), ctypes.sizeof(border))
    except Exception:
        pass
```

4. Replace `apply_fullscreen` and `restore_windowed`:

```python
def apply_fullscreen(window, user32=None, dwmapi=None) -> int | None:
    """
    Cover the window's monitor at NORMAL window state; return the previous
    GWL_STYLE so it can be put back exactly, or None if the calls did not land.

    Entering fullscreen by *maximising* is what this replaces, and why: Windows
    derives a maximized window's bounds from the work area, so anything that
    later touches the window — a SetWindowPos from always-on-top, an ex-style
    change from click-through — makes the form manager re-apply them and the
    overlay silently shrinks to taskbar-cut size while the UI still believes it
    is fullscreen. A normal-state window has no derived bounds to re-apply. The
    style bits are swapped for WS_POPUP so nothing draws a frame, and
    SWP_FRAMECHANGED makes that land on this pass instead of the next resize.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return None
    try:
        style = _get_window_long(user32, hwnd, GWL_STYLE)
        # A maximized window has to leave that state before anything else, or its
        # derived bounds come back the moment another native call touches it.
        _show_window(user32, hwnd, SW_RESTORE)
        bounds = monitor_bounds(user32, hwnd)
        if not bounds:
            return None
        _set_window_long(user32, hwnd, GWL_STYLE,
                         (style | WS_POPUP) & ~FULLSCREEN_CLEAR_STYLE)
        if not _set_bounds(user32, hwnd, bounds,
                           SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE):
            return None
        _set_dwm_frame(dwmapi, hwnd, True)
        return style
    except Exception:
        return None


def restore_windowed(window, rect: tuple[int, int, int, int] | None,
                     style: int | None = None, user32=None, dwmapi=None) -> bool:
    """
    Leave fullscreen: put the saved window style and the windowed rectangle back.

    `style` is what apply_fullscreen returned; without it the frame bits are
    simply set again, which is right for a window that was created frameless.
    `rect` is (x, y, w, h) as the caller saved it — the overlay re-applies the
    size the user was working in, not the monitor it just covered.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        current = _get_window_long(user32, hwnd, GWL_STYLE)
        target = int(style) if style is not None else (current | FULLSCREEN_CLEAR_STYLE)
        _set_window_long(user32, hwnd, GWL_STYLE, target)
        ok = True
        if rect:
            ok = _set_bounds(user32, hwnd, rect,
                             SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE)
        _set_dwm_frame(dwmapi, hwnd, False)
        return ok
    except Exception:
        return False
```

5. In `reassert_fullscreen`, reheal the frame bits too:

```python
    bounds = monitor_bounds(user32, hwnd)
    if not bounds:
        return False
    # Re-clear the frame bits as well: a style-mutating call (an ex-style change,
    # another SetWindowPos) can bring a frame back, and a framed window can no
    # longer cover the monitor cleanly.
    style = _get_window_long(user32, hwnd, GWL_STYLE)
    _set_window_long(user32, hwnd, GWL_STYLE, (style | WS_POPUP) & ~FULLSCREEN_CLEAR_STYLE)
    return _set_bounds(user32, hwnd, bounds, SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE)
```

6. Update the module docstring: keep the "Why fullscreen must not use WindowState = Maximized" section, and add that this path is now the one `WindowApi.toggle_fullscreen` calls (pywebview's own toggle is not used), and that leaving fullscreen restores the saved style as well as the rect.

- [ ] **Step 4: Run it to make sure it passes**

Run: `python -m unittest tests.test_native_window -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat core/native_window.py tests/test_native_window.py
```

---

### Task 8: Wire fullscreen to `WindowApi` (and stop recording the monitor as the window)

**Files:**
- Modify: `paprika_app.py` (`toggle_fullscreen` rewritten, `_record_window_geometry` made fullscreen-aware, `_fs_style` state)
- Test: `tests/test_window_api.py` (new `FullscreenApiTest`, `MiniModeTest.test_mini_exits_fullscreen_first` re-checked)

**Interfaces:**
- Consumes: `native_window.apply_fullscreen(window) -> int | None`, `native_window.restore_windowed(window, rect, style)`, `WindowApi._reapply_alpha()` (Task 5)
- Produces: `WindowApi.toggle_fullscreen() -> bool` (unchanged signature and meaning: the state now applied), `WindowApi._fs_style`, `WindowApi._saved_geometry` (windowed rect while fullscreen)

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_window_api.py`:

```python
@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class FullscreenApiTest(unittest.TestCase):
    """Fullscreen is driven natively, and never as a maximized window."""

    def setUp(self):
        self.window = FakeWindow()
        self.cache = FakeCache()
        self.api = paprika_app.WindowApi(self.window)
        self.full_style = 0x14000000
        self.applied = mock.Mock(return_value=self.full_style)
        self.restored = mock.Mock(return_value=True)
        patches = (
            (paprika_app, "CACHE", self.cache),
            (paprika_app.native_window, "apply_fullscreen", self.applied),
            (paprika_app.native_window, "restore_windowed", self.restored),
            (paprika_app.native_window, "set_window_alpha", mock.Mock(return_value=True)),
        )
        for target, attr, value in patches:
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_entering_fullscreen_goes_through_the_native_cover(self):
        # pywebview's toggle_fullscreen is deliberately not used: it enters as a
        # maximized window, whose bounds Windows then re-derives from the work area.
        self.assertTrue(self.api.toggle_fullscreen())
        self.applied.assert_called_once_with(self.window)
        self.assertEqual(self.window.toggles, 0)
        self.assertEqual(self.api._saved_geometry, (200, 150, 980, 700))

    def test_leaving_fullscreen_restores_the_rect_and_the_style(self):
        self.api.toggle_fullscreen()
        self.assertFalse(self.api.toggle_fullscreen())
        self.assertEqual(self.restored.call_args_list,
                         [mock.call(self.window, (200, 150, 980, 700), self.full_style)])
        self.assertIsNone(self.api._saved_geometry)

    def test_a_failed_cover_leaves_the_window_windowed(self):
        self.applied.return_value = None
        self.assertFalse(self.api.toggle_fullscreen())
        self.assertFalse(self.api._fullscreen)
        self.assertIsNone(self.api._saved_geometry)

    def test_closing_in_fullscreen_records_the_windowed_geometry(self):
        self.api.toggle_fullscreen()
        # Stand in for the covered window, so a naive read would save the monitor.
        self.window.x, self.window.y = 0, 0
        self.window.width, self.window.height = 1920, 1080
        self.api._record_window_geometry()
        self.assertEqual(self.cache.sizes[-1], (980, 700))
        self.assertEqual(self.cache.positions[-1], (200, 150))
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python -m unittest tests.test_window_api.FullscreenApiTest -v`
Expected: FAIL — `window.toggles` is 1 (pywebview's toggle was called), `self.applied` never called, `_record_window_geometry` saves 1920×1080.

- [ ] **Step 3: Implement**

In `paprika_app.py`, replace `toggle_fullscreen` with:

```python
    def toggle_fullscreen(self) -> bool:
        """
        Toggles fullscreen by covering this window's monitor, at normal window
        state. Returns the applied state, which the UI mirrors for its layout.

        pywebview's own toggle_fullscreen is deliberately not used: it enters
        fullscreen as a borderless *maximized* window, and Windows re-applies a
        maximized window's derived bounds from the work area whenever anything
        later touches the window — an always-on-top SetWindowPos, an ex-style
        change from click-through — so the overlay silently shrank to
        taskbar-cut size while the UI still believed it was fullscreen. The
        native cover (core.native_window.apply_fullscreen) keeps WindowState
        Normal throughout, swaps the frame bits for a popup, drops DWM's rounded
        corners and border for the duration, and hands back the exact style to
        restore. The windowed rect is saved before any native call can move the
        window, so leaving fullscreen is exact, and the alpha is re-asserted
        because the style change is one more thing that can drop a layered
        window's attributes.
        """
        try:
            if not getattr(self, '_fullscreen', False):
                # Save first: SW_RESTORE inside apply_fullscreen may move the
                # window (it leaves the maximized state) before we read it.
                self._saved_geometry = self._current_geometry()
                style = native_window.apply_fullscreen(self.window)
                if style is None:
                    self._saved_geometry = None
                    print("[Paprika Lyrics] Could not enter fullscreen (no window handle).")
                    return False
                self._fs_style = style
                self._fullscreen = True
            else:
                geometry = getattr(self, '_saved_geometry', None)
                style = getattr(self, '_fs_style', None)
                self._fullscreen = False
                self._saved_geometry = None
                self._fs_style = None
                native_window.restore_windowed(self.window, geometry, style)
            self._reapply_alpha()
            return self._fullscreen
        except Exception as exc:
            print(f"[Paprika Lyrics] Fullscreen toggle failed: {exc}")
            return getattr(self, '_fullscreen', False)
```

In `__init__`, next to `self._fullscreen`, add:

```python
        self._fs_style = None          # GWL_STYLE captured at fullscreen entry
        self._saved_geometry = None    # the windowed rect to come back to
```

In `_record_window_geometry`, put fullscreen ahead of the mini branch:

```python
        # Closing while fullscreen records the windowed rect the user left, not
        # the monitor the overlay happens to be covering: reopening at 1920x1080
        # would read as the app having forgotten what kind of window it is.
        if getattr(self, '_fullscreen', False) and getattr(self, '_saved_geometry', None):
            x, y, w, h = self._saved_geometry
            try:
                CACHE.save_window_position(x, y)
                CACHE.save_window_size(w, h)
            except Exception:
                pass
            return
```

Also check `_current_geometry` returns `(x, y, width, height)` — it does — and that `MiniModeTest.test_mini_exits_fullscreen_first` still passes: it sets `api._fullscreen = True` then expects `toggle_fullscreen` to be called, which the patched-method assertion covers.

- [ ] **Step 4: Run the suite**

Run: `python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"`
Expected: `OK`.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat paprika_app.py tests/test_window_api.py
```

---

### Task 9: Fullscreen polish — Esc exits, the cursor gets out of the way

**Files:**
- Modify: `ui/app.js` (Esc branch, cursor idle), `ui/style.css` (cursor rule), `tools/ui-preview-regression.js` (new assertions)

**Interfaces:**
- Consumes: `isFullscreen`, `toggleFullscreen()`, `setFullscreen(on)`, `openSettings`, `miniMode`
- Produces: JS `CURSOR_IDLE_MS`, `scheduleCursorHide()`; body class `cursor-hidden`

- [ ] **Step 1: Esc leaves fullscreen**

In the `document.addEventListener('keydown', …)` handler, replace the Escape branch:

```js
  // Escape backs out of whatever is on top, in the order a native player would:
  // the settings sheet, then the mini player, then fullscreen itself.
  if (e.key === 'Escape') {
    if (document.body.classList.contains('settings-open')) openSettings(false);
    else if (miniMode) setMiniMode(false);
    else if (isFullscreen) toggleFullscreen();
  }
```

- [ ] **Step 2: Hide an idle cursor in fullscreen**

Add after `initPointerChrome`:

```js
// A fullscreen overlay is something you look at, so the pointer stops being
// useful once it holds still — after two seconds it hides, and the first
// movement brings it straight back. That is what every fullscreen player does,
// and it is the difference between "a big window" and a surface meant to be
// watched. Windowed it stays visible: there the pointer is how the app is used.
const CURSOR_IDLE_MS = 2000;
let cursorIdleTimer = null;

function scheduleCursorHide() {
  clearTimeout(cursorIdleTimer);
  if (!isFullscreen) {
    document.body.classList.remove('cursor-hidden');
    return;
  }
  cursorIdleTimer = setTimeout(() => document.body.classList.add('cursor-hidden'), CURSOR_IDLE_MS);
}
```

Wire it inside a new `initCursorIdle()` called from the boot block (`document.addEventListener('mousemove', scheduleCursorHide, { passive: true })`, `document.addEventListener('mouseleave', …)` clearing the timer and the class), and call `scheduleCursorHide();` at the end of `setFullscreen(on)`.

- [ ] **Step 3: The stylesheet**

```css
/* A watched surface should not keep a parked arrow on it. */
body.is-fullscreen.cursor-hidden,
body.is-fullscreen.cursor-hidden * {
  cursor: none !important;
}
```

- [ ] **Step 4: Regression assertions**

Add to the tool after the fullscreen checks:

```js
  // --- 2b. fullscreen: Esc leaves, idle cursor hides -------------------
  setFullscreen(true);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  result.escapeLeavesFullscreen = !document.body.classList.contains('is-fullscreen');
  if (!result.escapeLeavesFullscreen) problems.push('Esc does not leave fullscreen');
  setFullscreen(true);
  body.classList.add('cursor-hidden');
  result.cursorHiddenInFullscreen = getComputedStyle(body).cursor === 'none';
  body.classList.remove('cursor-hidden');
  setFullscreen(false);
  if (!result.cursorHiddenInFullscreen) problems.push('the cursor does not hide in fullscreen');
```

- [ ] **Step 5: Verify**

```bash
node --check ui/app.js && node --check tools/ui-preview-regression.js
```
then the tool at all five viewports; expected `PASS` with `escapeLeavesFullscreen` and `cursorHiddenInFullscreen` true.

- [ ] **Step 6: Checkpoint**

```bash
git diff --stat ui/app.js ui/style.css tools/ui-preview-regression.js
```

---

### Task 10: The click-through peek (Ctrl+Shift+M)

**Files:**
- Modify: `core/hotkeys.py` (third binding), `paprika_app.py` (`on_hotkey_peek`, `WindowApi.start_peek`/`end_peek`, manager construction, `get_hotkey_binding`), `ui/app.js` (mirror the peek), `ui/index.html` (the hint already mentions it from Task 6)
- Test: `tests/test_window_api.py` (new `PeekTest`)

**Interfaces:**
- Consumes: `WindowApi.set_click_through(enabled) -> bool`, `WindowApi._push_js(script)`, `GlobalHotkeyManager.click_through_bound`
- Produces: `GlobalHotkeyManager(..., on_toggle_peek=None)`, `.peek_bound`, `HOTKEY_PEEK_ID = 4`; `paprika_app.PEEK_SECONDS`, `on_hotkey_peek()`, `WindowApi.start_peek() -> bool`, `WindowApi.end_peek() -> bool`; `get_hotkey_binding()` gains `"peek"`

**Why:** a click-through window is mouse-proof by definition, so with it on there is no way to nudge the overlay at all — the only route was to leave click-through, move the window and turn it back on. Peek hands the mouse back for a few seconds while keeping the window where it is and at the opacity the user chose.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_window_api.py`:

```python
@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class PeekTest(unittest.TestCase):
    """Ctrl+Shift+M hands the mouse back to a click-through overlay, briefly."""

    def setUp(self):
        self.window = FakeWindow()
        self.api = paprika_app.WindowApi(self.window)
        self.click_through = mock.Mock(return_value=True)
        self.pushes = []
        patches = (
            (paprika_app, "CACHE", FakeCache()),
            (paprika_app, "CLICK_THROUGH_ENABLED", True),
            (paprika_app, "WINDOW_REF",
             mock.Mock(evaluate_js=lambda script: self.pushes.append(script))),
            (paprika_app, "native_window", mock.Mock(set_click_through=self.click_through,
                                                   set_window_alpha=mock.Mock(return_value=True))),
        )
        for target, attr, value in patches:
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_peeking_turns_click_through_off_and_the_ui_is_told(self):
        self.assertTrue(self.api.start_peek())
        self.assertIn("window.setClickThrough(false);", self.pushes)
        self.api.end_peek()

    def test_ending_the_peek_puts_click_through_back(self):
        self.api.start_peek()
        self.assertTrue(self.api.end_peek())
        self.assertIn("window.setClickThrough(true);", self.pushes)

    def test_peeking_is_a_noop_when_the_window_is_already_clickable(self):
        with mock.patch.object(paprika_app, "CLICK_THROUGH_ENABLED", False):
            self.assertFalse(self.api.start_peek())
        self.assertEqual(self.pushes, [])
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python -m unittest tests.test_window_api.PeekTest -v`
Expected: FAIL — `'WindowApi' object has no attribute 'start_peek'`.

- [ ] **Step 3: Bind the shortcut**

In `core/hotkeys.py`: add `HOTKEY_PEEK_ID = 4`, `VK_M = 0x4D` (next to `VK_T`), extend the constructor to `def __init__(self, on_adjust_callback, on_toggle_click_through=None, on_toggle_peek=None)` storing `self.on_toggle_peek` and `self.peek_bound = False`, register it:

```python
        ok4 = user32.RegisterHotKey(
            None, HOTKEY_PEEK_ID, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_M
        )
        self.peek_bound = bool(ok4)
```

dispatch it (`elif msg.wParam == HOTKEY_PEEK_ID and self.on_toggle_peek: self.on_toggle_peek()`), unregister it in the teardown block, mention it in the not-bound notice, and extend the class docstring.

- [ ] **Step 4: Implement the host side**

In `paprika_app.py`, above `class WindowApi` (next to `FADE_STEP_SECONDS`):

```python
# How long a click-through "peek" hands the mouse back for. Long enough to drag
# the overlay where you want it, short enough that forgetting about it does not
# leave a window that keeps swallowing clicks.
PEEK_SECONDS = 8
```

Add to `WindowApi.__init__`: `self._peek_timer = None`.

Then, next to `set_click_through`:

```python
    def start_peek(self) -> bool:
        """
        Ctrl+Shift+M: hand the mouse back to a click-through overlay for a while.

        Click-through is mouse-proof by definition, so with it on there is no way
        to move or resize the overlay at all — the only route was to leave the
        mode, fix the position and turn it back on. A peek keeps the window where
        it is and at the opacity the user chose, and only stops ignoring the
        mouse; it uses the same switch, so a refused click-through (no escape
        hotkey bound) can never be peeked into an unrecoverable state.
        """
        if not CLICK_THROUGH_ENABLED:
            return False
        self._cancel_peek_timer()
        if not self.set_click_through(False):
            return False
        # The UI closes an open settings sheet when click-through starts, so it
        # has to hear about the state it is now in, not the one it asked for.
        self._push_js("window.setClickThrough(false);")
        self._peek_timer = threading.Timer(PEEK_SECONDS, self.end_peek)
        self._peek_timer.daemon = True
        self._peek_timer.start()
        return True

    def end_peek(self) -> bool:
        """Puts click-through back when the peek is over (or is dismissed)."""
        self._cancel_peek_timer()
        if not self.set_click_through(True):
            return False
        self._push_js("window.setClickThrough(true);")
        return True

    def _cancel_peek_timer(self):
        timer = getattr(self, '_peek_timer', None)
        if timer is not None:
            timer.cancel()
            self._peek_timer = None
```

Add the module-level hotkey callback next to `on_hotkey_click_through`:

```python
def on_hotkey_peek():
    """
    Ctrl+Shift+M. Pressing it again while a peek is up ends it early, so the
    shortcut reads as a toggle rather than a timer you have to wait out.
    """
    api = WINDOW_API_REF
    if api is None:
        return
    if getattr(api, '_peek_timer', None) is not None and api._peek_timer.is_alive():
        api.end_peek()
    else:
        api.start_peek()
```

Change the manager construction to `GlobalHotkeyManager(on_hotkey_adjust, on_hotkey_click_through, on_hotkey_peek)`, cancel any peek when the window closes (`on_closed` → `api._cancel_peek_timer()`), and extend `get_hotkey_binding`'s dict with `"peek": bool(HOTKEY_MANAGER.peek_bound)`.

- [ ] **Step 5: Mirror it in the UI**

`window.setClickThrough(...)` already recomputes the alpha and the settings row, so the peek needs no new JS state; only the row's `value-flash` comes free. Confirm (read, do not edit) that `setClickThrough` calls `applyWindowOpacity()` and `syncSettingsPanel()`.

- [ ] **Step 6: Run the suite**

Run: `python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"`
Expected: `OK`.

- [ ] **Step 7: Checkpoint**

```bash
git diff --stat core/hotkeys.py paprika_app.py ui/app.js tests/test_window_api.py
```

---

### Task 11: Final verification pass and docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full test + syntax pass**

```bash
python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"
node --check ui/app.js && node --check tools/ui-preview-regression.js && echo "JS OK"
grep -rn "pywebview-drag-region" ui/ ; grep -rn "applyHoverFade\|hoverFadeApplied\|hoverFadeTarget\|_reset_window_alpha" ui/ paprika_app.py
```
Expected: `OK`; `JS OK`; the only `pywebview-drag-region` hit is the explanatory comment in `ui/app.js`; the second grep returns nothing.

- [ ] **Step 2: Preview regression at five viewports**

```bash
python -m http.server 8471 > /dev/null 2>&1 &
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8471/ui/index.html
```
Open `http://127.0.0.1:8471/ui/index.html`, eval the tool, then `await run('<label>')` at 1400×900, 900×700, 800×600, 360×420 and 330×380. Expected: `PASS` at every size. If the stylesheet is stale in the preview's cache, bust it with `document.querySelector('link[rel="stylesheet"]').href = 'style.css?v=' + Date.now()`.

- [ ] **Step 3: README — controls table**

- **Move Window** row: the native caption drag, snapping, surfaces, opt-outs; fullscreen still refuses the gesture.
- New **Window Opacity** row: `Window opacity` cycles **Off → 95% → 90% → 80% → 70% → 60%** (saved locally) and applies whenever the overlay is windowed, including the mini player and click-through; fullscreen stays solid.
- **Fade While Hovered** row: the dip goes *below* the chosen opacity; `Ctrl` and an open settings sheet cancel the dip; click-through keeps the opacity.
- **Fullscreen** row: covers the monitor at normal window state, drops DWM's frame and rounding, restores the exact windowed rect, exits on `Esc`, hides the pointer after two idle seconds, leaves Always-on-top to you.
- **Click-Through Mode** row: add Ctrl+Shift+M and that click-through keeps the chosen opacity.
- **Settings page** row: new section order.

- [ ] **Step 4: README — smoke checklist**

Add items only a real Windows run can settle: move/snap the overlay from the top band; drag the seek bar without moving the window; opacity survives restart; click-through + 80% opacity + Ctrl+Shift+M peek; fullscreen corner wedges/taskbar/Esc/idle cursor; close in fullscreen then relaunch opens windowed; Ctrl keeps the opacity instead of dipping.

- [ ] **Step 5: Checkpoint**

```bash
git status --short; git diff --stat
```
Expected: only files touched by this plan plus the pre-existing uncommitted work. Report the list and ask whether to commit — **do not commit or stage anything**.

---

## Self-review

**Spec coverage**
- *1. Still cannot move window* → Tasks 1-3.
- *2. Clear/transparent compatible with click-through, plus transparency at all times* → Tasks 4, 5, 10 (scope matches the user's "not fullscreen" choice).
- *3. Rearrange settings by importance* → Task 6.
- *4. Proper native fullscreen* → Tasks 7, 8, 9.
- Verification and docs → Task 11.

**Known gaps, called out honestly**
- The native half (does the OS move the window, does the layered alpha compose with DWM, does the cover hide an auto-hidden taskbar) cannot be exercised on this host. The seams are unit-tested and the DOM half is regression-asserted; the README smoke items are the manual gate.
- The preview freezes CSS transitions and cannot capture frames, so all measurements disable transitions and read computed styles/geometry.
- Opening the settings sheet during a peek and letting the peek expire closes the sheet (click-through has no pointer). Documented in the hint, not "fixed".
