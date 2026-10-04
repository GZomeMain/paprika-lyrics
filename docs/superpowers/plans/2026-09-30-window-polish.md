# Window polish: the move that moves, the dip under click-through, and the outlines

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the six things the user can see wrong with the running overlay right: the seek row belongs on the cover, the pointer must come back in fullscreen, the window must actually move under the top band (and stop advertising a grabbing hand), the hover dip must work while click-through hides the pointer, the settings rows must line up, and the app must lose its 1px outline.

**Architecture:** Four changes are UI policy and geometry only (`ui/*`). Two are the same story as the previous batch and belong on the existing native seam: the window move is *not* left to Windows' modal loop any more — that loop is still tried first because it carries Aero Snap, but the capture it needs is taken by the WebView2 child window, so the host now drives the move itself when the capture never changed hands; and the pointer state a click-through window cannot observe from the page is probed natively (`GetCursorPos` against the window rect) and pushed to the UI, which keeps owning the opacity policy.

**Tech Stack:** Python 3.13, pywebview 6.2.1 (WinForms + Edge WebView2, `FormBorderStyle.None`, `easy_drag=False`), ctypes/user32+dwmapi, vanilla JS/CSS front end, `unittest`, `node --check`.

## Global Constraints

- **Do not commit, push, branch or stash.** The working tree holds uncommitted work from earlier turns (the TTML library feature and two earlier window-fix batches) in *the same files this plan edits*. Each task ends with a `git diff --stat` checkpoint instead. Say so if you want a commit — the user decides what goes in it.
- Stay on `master` (this repo has no remote and all prior work is direct-to-master). Confirmed with the user for this plan.
- **Test runner is `unittest`, never pytest:** `python -m unittest <module> -v`, full suite `python -m unittest discover -s tests`. Baseline before this plan: **314 tests, OK**.
- JS gate after every UI edit: `node --check ui/app.js` and `node --check tools/ui-preview-regression.js`.
- Every native function keeps the existing seam contract: takes the pywebview window plus optional injectable `user32`/`dwmapi` (and, where it sleeps or reads a clock, an injectable `sleep`), **never imports pywebview or pythonnet**, returns `False`/`None` instead of raising, and resolves the HWND with `_hwnd_of` (no title-based `FindWindowW`).
- Do not rename `core/native_window.set_window_alpha`, `fix_point_for`, `reassert_fullscreen`, `is_covering_monitor`, `apply_fullscreen`, `restore_windowed` or the JS globals `setFullscreen`, `setMiniMode`, `setClickThrough`, `updateArtProgress`, `setTrackDuration`, `cycleLayout`, `applyWindowOpacity`, `windowAlphaTarget` — `tools/ui-preview-regression.js` and the host push state through them.
- Copy rule: comments explain *why* a thing is the way it is, in the repo's existing voice (see `core/native_window.py` and `ui/app.js` headers). No `TODO`, no placeholder text, no "handle edge cases".
- User-facing copy stays sentence case, uses typographic quotes (“…”) inside prose, and never says "please".
- Native behaviour cannot be exercised on this host (no Windows session). Every native function gets seam tests with a fake; the preview tool covers the DOM half; the README smoke list is the manual gate. Say so again at the end.

---

## File structure

| File | Responsibility after this plan |
| --- | --- |
| `core/native_window.py` | Adds the host-driven move (`follow_drag`, `drag_handed_off`), the pointer probe (`cursor_over_window`), and a windowed frame that drops DWM's 1px border. |
| `paprika_app.py` | `WindowApi`: the drag handoff thread, the click-through hover probe, `set_hover_fade`, the windowed DWM frame call. |
| `ui/index.html` | The seek row moves onto the art; the card comment stops claiming otherwise. |
| `ui/app.js` | Idle-cursor fix, `window.setHoverFadeInside`, the opacity policy without the click-through early-out, drag-cursor removal is CSS-only. |
| `ui/style.css` | Seek row on the cover, no app outline, left-aligned settings rows, no grab cursors. |
| `tests/test_native_window.py` | `FollowDragTest`, `DragHandoffTest`, `CursorOverWindowTest`, frame-border assertions, extended `FakeUser32`/`FakeDwmapi`. |
| `tests/test_window_api.py` | `WindowDragApiTest` rewritten, new `HoverProbeTest`. |
| `tools/ui-preview-regression.js` | Seek row on the art, settings alignment, cursor returns on move, the dip under click-through. |
| `README.md` | Controls/smoke rows brought in line. |

---

### Task 1: The app loses its outline

**Files:**
- Modify: `ui/style.css` (`.app-root`), `core/native_window.py` (`apply_rounded_corners` → `apply_window_frame`, windowed branch of `_set_dwm_frame`), `paprika_app.py` (`apply_native_rounded_corners` → `apply_native_window_frame`, `on_shown`)
- Test: `tests/test_native_window.py` (new frame test, `ApplyFullscreenTest` border expectation updated)

**Interfaces:**
- Produces: `native_window.apply_window_frame(window, dwmapi=None) -> bool` (corners round, border none); `_set_dwm_frame(dwmapi, hwnd, fullscreen)` writes `DWMWA_COLOR_NONE` in **both** states.
- Removes: `native_window.apply_rounded_corners`, `paprika_app.apply_native_rounded_corners` (both renamed, no callers left).

**Why:** two things draw the window edge — the stylesheet's `1px solid rgba(255,255,255,0.10)` on `.app-root` (plus its inset top highlight) and Windows' own DWM border, which the app only drops while fullscreen. Together they read as a bright rectangle around the whole app, which is exactly what the user is asking to be rid of. A window that is a lyrics surface should have no frame at all.

- [ ] **Step 1: Write the failing test**

In `tests/test_native_window.py`, add to `ApplyFullscreenTest` (or a new `WindowFrameTest` next to it):

```python
class WindowFrameTest(unittest.TestCase):
    """The windowed frame is rounded and unlined — the app has no outline."""

    def test_the_windowed_frame_drops_the_border(self):
        d = FakeDwmapi()
        self.assertTrue(nw.apply_window_frame(FakeWindow(), dwmapi=d))
        self.assertIn((nw.DWMWA_WINDOW_CORNER_PREFERENCE, nw.DWMWCP_ROUND), d.calls)
        self.assertIn((nw.DWMWA_BORDER_COLOR, ctypes.c_int(nw.DWMWA_COLOR_NONE).value), d.calls)

    def test_no_handle_is_refused(self):
        class NoHandle:
            pass
        self.assertFalse(nw.apply_window_frame(NoHandle(), dwmapi=FakeDwmapi()))
```

and in `ApplyFullscreenTest.test_the_dwm_frame_is_dropped_for_fullscreen_and_restored_after`, change the last two assertions to expect `DWMWA_COLOR_NONE` in both states (leaving fullscreen must not bring the border back):

```python
        self.assertEqual(d.calls[-2], (nw.DWMWA_WINDOW_CORNER_PREFERENCE, nw.DWMWCP_ROUND))
        self.assertEqual(d.calls[-1], (nw.DWMWA_BORDER_COLOR, ctypes.c_int(nw.DWMWA_COLOR_NONE).value))
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `python -m unittest tests.test_native_window.WindowFrameTest tests.test_native_window.ApplyFullscreenTest -v`
Expected: FAIL — `apply_window_frame` does not exist; the restore still writes `DWMWA_COLOR_DEFAULT`.

- [ ] **Step 3: Implement**

In `core/native_window.py`, change the windowed half of `_set_dwm_frame`:

```python
        corner = ctypes.c_int(DWMWCP_DONOTROUND if fullscreen else DWMWCP_ROUND)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
                                     ctypes.byref(corner), ctypes.sizeof(corner))
        # Always unlined, fullscreen or not: DWM's 1px border draws a light edge
        # around a frameless overlay, which is the outline the app should not have.
        border = ctypes.c_int(DWMWA_COLOR_NONE)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR,
                                     ctypes.byref(border), ctypes.sizeof(border))
```

and update its docstring's first sentence to say the border is off in both states. Replace `apply_rounded_corners` with:

```python
def apply_window_frame(window, dwmapi=None) -> bool:
    """
    The windowed frame: rounded corners, no border.

    DWMWA_BORDER_COLOR is the 1px line Windows 11 draws around a window, and a
    frameless lyrics overlay has no business being outlined in anything — with it
    on, the app reads as a rectangle sitting on the desktop instead of a surface
    floating over it. The corners stay rounded, which is the one frame feature
    worth keeping. Best effort: DWM is optional.
    """
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    _set_dwm_frame(dwmapi, hwnd, False)
    return True
```

In `paprika_app.py`, rename `apply_native_rounded_corners` to `apply_native_window_frame` (body calls `native_window.apply_window_frame(window)`) and update the `on_shown` callback that calls it.

In `ui/style.css`, `.app-root` loses the border and the inset highlight:

```css
.app-root {
  ...
  background: #09090b;
  color: var(--text);
  border-radius: 0; /* Let Windows 11 DWM round the window cleanly without gaps */
  /* No border and no inset top highlight: the window is a lyrics surface, and a
     1px light rectangle around the whole app reads as a frame for a picture
     rather than a surface over the desktop. DWM's own border is off too — see
     core.native_window.apply_window_frame. */
  overflow: hidden;
}
```

- [ ] **Step 4: Run the tests**

Run: `python -m unittest tests.test_native_window -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/style.css core/native_window.py paprika_app.py tests/test_native_window.py
```

---

### Task 2: Settings rows line up (a centred button row fixed)

**Files:**
- Modify: `ui/style.css` (`.qp-row`), `tools/ui-preview-regression.js` (section 5)

**Interfaces:**
- Produces: DOM contract — every `#quick-panel .qp-label` shares one left edge (within 1px), and that edge is within 2px of `#quick-panel .sp-group-title`'s left edge.

**Why:** the rows are `<button>`s, and a button's user-agent style is `text-align: center` — which the label `<span>` inside inherits, so every action row's label floats to the middle of the free space while the value stays hard right. The `div` rows (Sync's latency stepper) do not, and neither do the group titles or hints, so the sheet has a ragged column that changes alignment from row to row. One declaration fixes the whole class of it.

- [ ] **Step 1: Add the regression assertion**

In section 5 of `tools/ui-preview-regression.js`, after the settings-order check:

```js
  // Every row is a <button>, whose user-agent text-align is `center` — the label
  // inside inherits it, so action rows centred their text while the div rows and
  // the group titles stayed left. One column, one edge.
  const labels = [...document.querySelectorAll('#quick-panel .qp-row .qp-label')];
  const labelLefts = labels.map((el) => Math.round(el.getBoundingClientRect().left));
  result.settingsLabelLefts = [...new Set(labelLefts)];
  if (labelLefts.length && new Set(labelLefts).size !== 1) {
    problems.push('settings labels start at different x: ' + result.settingsLabelLefts.join(','));
  }
  const groupTitle = document.querySelector('#quick-panel .sp-group-title');
  result.settingsLabelAlignedWithTitle = !!groupTitle && labelLefts.length > 0 &&
    Math.abs(labelLefts[0] - Math.round(groupTitle.getBoundingClientRect().left)) <= 2;
  if (!result.settingsLabelAlignedWithTitle) {
    problems.push('settings labels do not line up with the group title');
  }
```

- [ ] **Step 2: Run the tool to watch it fail**

Serve the UI (`python -m http.server 8471` from the repo root, open `http://127.0.0.1:8471/ui/index.html`), eval the tool, `await run('pre-fix')`. Expected: FAIL with `settings labels start at different x`.

- [ ] **Step 3: Fix the stylesheet**

In `ui/style.css`, on `.qp-row`:

```css
.qp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  ...
  font-family: var(--ui-font);
  /* Rows are <button>s, and a button centres its text by default — the label
     span inherits that, so action rows floated their labels to the middle while
     the static rows and the group titles above them stayed left. The sheet is a
     column: label on the left edge, value on the right. */
  text-align: left;
}
```

- [ ] **Step 4: Verify**

`node --check tools/ui-preview-regression.js`, then re-run the tool at 1400×900, 900×700, 800×600, 360×420 and 330×380. Expected `PASS` at every size with `settingsLabelLefts` a single value.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/style.css tools/ui-preview-regression.js
```

---

### Task 3: The seek row moves onto the cover

**Files:**
- Modify: `ui/index.html` (the row moves into `#art-player`), `ui/style.css` (`.art-player .art-progress`), `tools/ui-preview-regression.js` (section 2)

**Interfaces:**
- Consumes: nothing new.
- Produces: DOM contract — `#art-progress` is a descendant of `#art-player` and still inside a `[data-no-drag]`; `#art-timer-display` / `#art-duration-display` / `#art-progress-fill` / `#art-thumb` keep their ids and stay reachable from `updateArtProgress()`.

**Why:** the on-art player is the card's player (transport on the hovered sleeve), but the seek row was left behind in the text column beneath it, so the times and the bar sit apart from the controls that drive them — and the art, which is the whole point of the card, stays a picture rather than a player. The reference the user sent puts transport and seek on the cover as one block; this is the windowed compact card only (the split panel's row stays where it is, since it is fullscreen-only and permanently visible).

- [ ] **Step 1: Move the markup**

In `ui/index.html`, cut this block out of `.track-text`:

```html
        <div class="float-progress-row art-progress" data-no-drag>
          <span class="art-time" id="art-timer-display">0:00</span>
          <div class="float-progress" id="art-progress" title="Seek">
            <div class="float-progress-fill" id="art-progress-fill"></div>
            <div class="art-thumb" id="art-thumb"></div>
          </div>
          <span class="art-time" id="art-duration-display">0:00</span>
        </div>
```

and paste it inside `#art-player`, directly after the `.transport-row` closing `</div>`, so the on-art player reads transport first, seek second. Update the two comments that describe the placement:

- `#art-player`'s comment ends with “…the transport row and the seekable progress row with times, one block on the hovered sleeve — the times belong to the bar, not to the text column under the art.”
- `.track-text`'s comment becomes: “Title and artist only: the seek row lives on the cover (see #art-player), so the text column is exactly what it says it is.”

- [ ] **Step 2: Fix the row's spacing on the art**

In `ui/style.css`, under the `.art-progress` rule, add:

```css
/* On the art the row is the player's second line, not a row of the text column:
   the player's own gap spaces it, and .art-player stretches it to the card's
   inner width. */
.art-player .art-progress {
  margin: 0;
}
```

- [ ] **Step 3: Assert it in the regression tool**

In section 2 of `tools/ui-preview-regression.js`, after the `seekOptsOut` check:

```js
  // The seek row is the on-art player's second line: the times sit under the
  // transport they belong to, on the cover, not down in the text column.
  const seekRow = document.querySelector('#art-progress');
  result.seekRowOnArt = !!seekRow && !!seekRow.closest('#art-player');
  if (!result.seekRowOnArt) problems.push('the seek row is not on the cover');
  result.seekTimesWithTheRow = !!document.querySelector('#art-player #art-timer-display') &&
    !!document.querySelector('#art-player #art-duration-display');
  if (!result.seekTimesWithTheRow) problems.push('the seek times are not on the cover');
```

- [ ] **Step 4: Verify**

```bash
node --check ui/app.js && node --check tools/ui-preview-regression.js
```
then the tool at all five viewports. Expected `PASS` with `seekRowOnArt`, `seekTimesWithTheRow` and the existing `seekOptsOut` all true.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/index.html ui/style.css tools/ui-preview-regression.js
```

---

### Task 4: The pointer comes back in fullscreen

**Files:**
- Modify: `ui/app.js` (`scheduleCursorHide`), `tools/ui-preview-regression.js` (section 2b)

**Interfaces:**
- Consumes: `isFullscreen`, existing body classes `settings-open`, `seeking`, `resizing`.
- Produces: `scheduleCursorHide()` removes `cursor-hidden` on every call (so any movement reveals the pointer) and only re-arms the timer when the hide is actually wanted.

**Why:** `scheduleCursorHide` only ever *adds* `cursor-hidden` — the mousemove listener re-arms the timer but never takes the class off, so once two idle seconds pass the pointer is gone for the rest of the fullscreen session. That is the "sometimes the mouse disappears": it depends on whether you stopped moving, and from then on you are hunting for a pointer that is not drawn. The hide has to be a timeout that anything cancels, not a state you have to leave fullscreen to escape.

- [ ] **Step 1: Add the regression assertion**

In section 2b of `tools/ui-preview-regression.js`, after the `cursorHiddenInFullscreen` check:

```js
  // …and the very next movement brings it back: the hide is an idle timeout, not
  // a state the user has to leave fullscreen to escape.
  body.classList.add('cursor-hidden');
  document.dispatchEvent(new MouseEvent('mousemove'));
  result.cursorReturnsOnMove = !body.classList.contains('cursor-hidden');
  if (!result.cursorReturnsOnMove) problems.push('the pointer does not come back on movement');
  body.classList.remove('cursor-hidden');
```

- [ ] **Step 2: Run the tool to watch it fail**

Expected: FAIL with `the pointer does not come back on movement`.

- [ ] **Step 3: Fix the timer**

In `ui/app.js`:

```js
function scheduleCursorHide() {
  clearTimeout(cursorIdleTimer);
  // Any movement shows the pointer again immediately: hiding a parked cursor is
  // an idle timeout, and a timeout that only ever turns the cursor off is a
  // pointer you cannot get back without leaving fullscreen.
  document.body.classList.remove('cursor-hidden');
  // Never hide it while something is being read or dragged with it — the
  // settings sheet, a seek, a resize all want the pointer on screen.
  if (!isFullscreen || document.body.classList.contains('settings-open') ||
      document.body.classList.contains('seeking') ||
      document.body.classList.contains('resizing')) {
    return;
  }
  cursorIdleTimer = setTimeout(() => document.body.classList.add('cursor-hidden'), CURSOR_IDLE_MS);
}
```

- [ ] **Step 4: Verify**

`node --check ui/app.js && node --check tools/ui-preview-regression.js`, then the tool at all five viewports. Expected `PASS` with `cursorHiddenInFullscreen` and `cursorReturnsOnMove` both true.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/app.js tools/ui-preview-regression.js
```

---

### Task 5: A move gesture that moves, whatever the WebView2 has captured

**Files:**
- Modify: `core/native_window.py` (constants, `POINT`, `_cursor_pos`, `_window_origin`, `_left_button_down`, `_handle_value`, `follow_drag`, `drag_handed_off`, `begin_drag` docstring)
- Test: `tests/test_native_window.py` (extend `FakeUser32`, new `FollowDragTest` and `DragHandoffTest`)

**Interfaces:**
- Consumes: `_hwnd_of`, `_set_bounds`, `_declare`, `SWP_NOSIZE`
- Produces: `follow_drag(window, user32=None, sleep=None, clock=None) -> bool`; `drag_handed_off(window, user32=None) -> bool`; `cursor_over_window(window, user32=None) -> bool` (Task 7); `POINT`; `VK_LBUTTON = 0x01`; `DRAG_POLL_SECONDS = 0.008`; `DRAG_MAX_SECONDS = 120`

**Why:** `begin_drag` posts `WM_NCLBUTTONDOWN`/`HTCAPTION` and trusts `DefWindowProc` to run the move loop. That loop only starts if the *form* takes the mouse capture, and at the moment of the mousedown the capture belongs to WebView2's child window (Chromium captures on mousedown), so the overlay can be handed a gesture that is silently dropped — which is the state the user is in: the surface highlights as draggable and the window does not move. Windows' loop is still the gesture to want, because Aero Snap, per-monitor DPI and drag-to-restore come with it, so it is tried first and its capture is checked; when the capture never changes hands, the host runs the move itself. Nothing in the page, pywebview or WebView2 can refuse a `SetWindowPos`.

- [ ] **Step 1: Extend the fake and write the failing tests**

In `tests/test_native_window.py`, add to `FakeUser32.__init__`: `self.cursor = (500, 400)`, `self.cursor_path = []`, `self.button_polls = 0`, `self.capture = 0`. Then, next to `GetWindowRect`:

```python
    def GetCursorPos(self, ptr):
        # A scripted path lets a test walk the pointer across the move loop.
        if self.cursor_path:
            self.cursor = self.cursor_path.pop(0)
        point = ctypes.cast(ptr, ctypes.POINTER(nw.POINT)).contents
        point.x, point.y = self.cursor
        self.calls.append(("GetCursorPos", self.cursor))
        return 1

    def GetAsyncKeyState(self, key):
        self.calls.append(("GetAsyncKeyState", key))
        if self.button_polls > 0:
            self.button_polls -= 1
            return -32768        # the high bit is "down"
        return 0

    def GetCapture(self):
        self.calls.append(("GetCapture",))
        return self.capture
```

New test classes at the end of the file:

```python
class FollowDragTest(unittest.TestCase):
    """The host's own move: the gesture Windows' loop can refuse."""

    def test_the_window_follows_the_pointer_until_the_button_comes_up(self):
        u = FakeUser32()                       # window at (100,100), cursor at (500,400)
        u.cursor_path = [(500, 400), (520, 420), (560, 460)]
        u.button_polls = 2                     # two polls of movement, then released
        self.assertTrue(nw.follow_drag(FakeWindow(), user32=u, sleep=lambda _s: None))
        # The window keeps its grab offset: +60,+60 on the last polled position.
        call = u.last("SetWindowPos")
        self.assertEqual((call[3], call[4]), (160, 160))
        self.assertTrue(call[7] & nw.SWP_NOSIZE)
        self.assertTrue(call[7] & nw.SWP_NOACTIVATE)

    def test_a_click_that_is_already_over_moves_nothing(self):
        u = FakeUser32()
        u.button_polls = 0
        self.assertFalse(nw.follow_drag(FakeWindow(), user32=u, sleep=lambda _s: None))
        self.assertIsNone(u.last("SetWindowPos"))

    def test_no_handle_is_refused(self):
        class NoHandle:
            pass
        self.assertFalse(nw.follow_drag(NoHandle(), user32=FakeUser32(), sleep=lambda _s: None))


class DragHandoffTest(unittest.TestCase):
    """The capture is how a posted gesture is known to have been taken by Windows."""

    def test_the_windows_move_loop_is_recognised_by_its_capture(self):
        u = FakeUser32()
        u.capture = u.hwnd
        self.assertTrue(nw.drag_handed_off(FakeWindow(), user32=u))
        u.capture = 0
        self.assertFalse(nw.drag_handed_off(FakeWindow(), user32=u))

    def test_no_handle_is_never_handed_off(self):
        class NoHandle:
            pass
        self.assertFalse(nw.drag_handed_off(NoHandle(), user32=FakeUser32()))
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `python -m unittest tests.test_native_window.FollowDragTest tests.test_native_window.DragHandoffTest -v`
Expected: FAIL — `follow_drag` / `drag_handed_off` do not exist, and `nw.POINT` does not exist.

- [ ] **Step 3: Implement the native half**

In `core/native_window.py`, add to the constants block:

```python
# A host-driven window move: how often the pointer is read while the button is
# held, and the longest a single gesture may run before it is abandoned.
VK_LBUTTON = 0x01
DRAG_POLL_SECONDS = 0.008
DRAG_MAX_SECONDS = 120
```

and next to the module's other structures:

```python
class POINT(ctypes.Structure):
    """GetCursorPos writes a POINT; named here so tests can fill one in."""
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
```

Then, after `set_window_alpha` (before `begin_drag`):

```python
def _handle_value(value) -> int:
    """An HWND that may arrive as a ctypes pointer or a plain int (fakes)."""
    raw = getattr(value, "value", value)
    try:
        return int(raw or 0)
    except (TypeError, ValueError):
        return 0


def _cursor_pos(user32) -> tuple[int, int] | None:
    """The pointer's screen position, or None when it cannot be read."""
    try:
        point = POINT()
        _declare(user32.GetCursorPos, ctypes.c_int, [ctypes.c_void_p])
        if not user32.GetCursorPos(ctypes.byref(point)):
            return None
        return (int(point.x), int(point.y))
    except Exception:
        return None


def _window_origin(user32, hwnd: int) -> tuple[int, int] | None:
    """The window's top-left corner in screen coordinates."""
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    try:
        rect = RECT()
        _declare(user32.GetWindowRect, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p])
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
            return None
        return (int(rect.left), int(rect.top))
    except Exception:
        return None


def _left_button_down(user32) -> bool:
    """Whether the primary mouse button is held, read without a window proc."""
    try:
        _declare(user32.GetAsyncKeyState, ctypes.c_short, [ctypes.c_int])
        return bool(user32.GetAsyncKeyState(VK_LBUTTON) & 0x8000)
    except Exception:
        return False


def drag_handed_off(window, user32=None) -> bool:
    """
    True when Windows' own move loop has taken the capture for this window.

    A posted WM_NCLBUTTONDOWN is answered by DefWindowProc entering a modal move
    loop, and the first thing that loop does is capture the mouse. The capture is
    therefore the evidence that the gesture was taken: if it is still not ours a
    moment later, nothing is moving the window and the host has to.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        _declare(user32.GetCapture, ctypes.c_void_p, [])
        return _handle_value(user32.GetCapture()) == hwnd
    except Exception:
        return False


def follow_drag(window, user32=None, sleep=None, clock=None) -> bool:
    """
    Move the window under the pointer until the primary button comes up.

    This is the fallback for the gesture Windows' loop will not take (see
    drag_handed_off), and it is deliberately the dumb one: remember where the
    pointer was and where the window was, then put the window at grab-origin plus
    pointer-delta on every poll. Nothing is computed from an accumulated series of
    events, so a late start or a dropped poll cannot drift the window away from
    the cursor, and the drag can be handed over mid-gesture without a jump.

    Coordinates are read with GetCursorPos/GetWindowRect and written with
    SetWindowPos — all screen pixels for the same process, so a scaled display
    needs no conversion here. `sleep` and `clock` are injectable so the seam is
    testable without a real pointer or a real wall clock. Returns whether the
    window was moved at all.
    """
    user32 = user32 or ctypes.windll.user32
    sleep = sleep or time.sleep
    clock = clock or time.monotonic
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    start = _cursor_pos(user32)
    origin = _window_origin(user32, hwnd)
    if start is None or origin is None:
        return False
    moved = False
    last = origin
    deadline = clock() + DRAG_MAX_SECONDS
    while clock() < deadline:
        if not _left_button_down(user32):
            break
        point = _cursor_pos(user32)
        if point is None:
            break
        target = (origin[0] + point[0] - start[0], origin[1] + point[1] - start[1])
        if target != last:
            if not _set_bounds(user32, hwnd, (target[0], target[1], 0, 0),
                               SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE):
                break
            last = target
            moved = True
        sleep(DRAG_POLL_SECONDS)
    return moved
```

Add `import time` next to `import ctypes` at the top of the module, and extend `begin_drag`'s docstring so it no longer claims the OS loop is the whole answer:

```python
    Windows implements this gesture, and it is the one to want: DefWindowProc
    answers WM_NCLBUTTONDOWN carrying HTCAPTION by setting capture and running its
    own modal move loop until the button comes up, which is where Aero Snap,
    per-monitor DPI correctness and drag-to-restore come from. It is posted rather
    than sent because the modal loop occupies the UI thread for the whole gesture
    while this runs on the bridge thread.

    It is only half of the move, though, which is why it reports whether the post
    landed instead of pretending the gesture happened: the loop needs the capture
    that WebView2 holds while the page has the button down, so a caller has to
    check that it took over (drag_handed_off) and drive the move itself
    (follow_drag) when it did not.
```

- [ ] **Step 4: Run the tests**

Run: `python -m unittest tests.test_native_window -v`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat core/native_window.py tests/test_native_window.py
```

---

### Task 6: The gesture reaches the UI, and stops lying about it

**Files:**
- Modify: `paprika_app.py` (`DRAG_HANDOFF_SECONDS`, `begin_drag`, `_ensure_drag_moves`, `_spawn_detached`), `ui/style.css` (drag cursors), `tools/ui-preview-regression.js` (section 2)
- Test: `tests/test_window_api.py` (`WindowDragApiTest` rewritten)

**Interfaces:**
- Consumes: `native_window.begin_drag`, `drag_handed_off`, `follow_drag` (Task 5)
- Produces: `WindowApi.begin_drag() -> bool` unchanged in shape (now the whole gesture, not just the post), `paprika_app.DRAG_HANDOFF_SECONDS = 0.12`, `WindowApi._spawn_detached(target) -> Thread`

**Why (the cursor half):** the stylesheet advertises the drag surfaces with `cursor: grab`, which on Windows reads as a web page's "click and drag me" palm rather than a title bar — the user calls it an ugly hand. A native window does not decorate its title bar with a special pointer either; dropping the rule also stops `[data-no-drag], [data-no-drag] * { cursor: auto }` from stomping the pointer cursors of the buttons inside those regions.

- [ ] **Step 1: Rewrite the API test**

In `tests/test_window_api.py`, replace `WindowDragApiTest` with:

```python
@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class WindowDragApiTest(unittest.TestCase):
    """Windows' own move loop is preferred; the host's own loop is the guarantee."""

    def setUp(self):
        self.window = FakeWindow()
        self.api = paprika_app.WindowApi(self.window)
        patches = (
            (paprika_app.native_window, "begin_drag", mock.Mock(return_value=True)),
            (paprika_app.native_window, "drag_handed_off", mock.Mock(return_value=True)),
            (paprika_app.native_window, "follow_drag", mock.Mock(return_value=True)),
            # No real wait, and no real thread: the handoff runs inline so the
            # assertions below cannot race the drag.
            (paprika_app, "DRAG_HANDOFF_SECONDS", 0),
        )
        for target, attr, value in patches:
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.api._spawn_detached = lambda target: target()

    def test_the_posted_gesture_goes_through_the_native_seam(self):
        self.assertTrue(self.api.begin_drag())
        self.assertEqual(paprika_app.native_window.begin_drag.call_args_list,
                         [mock.call(self.window)])

    def test_a_gesture_windows_took_is_left_alone(self):
        self.assertTrue(self.api.begin_drag())
        paprika_app.native_window.follow_drag.assert_not_called()

    def test_a_gesture_windows_never_took_is_driven_by_the_host(self):
        paprika_app.native_window.drag_handed_off.return_value = False
        self.assertTrue(self.api.begin_drag())
        self.assertEqual(paprika_app.native_window.follow_drag.call_args_list,
                         [mock.call(self.window)])

    def test_the_bridge_reports_a_refused_gesture(self):
        # No HWND yet (the window is still being created): the UI must be told,
        # not left believing the window is following the pointer.
        paprika_app.native_window.begin_drag.return_value = False
        self.assertFalse(self.api.begin_drag())
        paprika_app.native_window.follow_drag.assert_not_called()
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `python -m unittest tests.test_window_api.WindowDragApiTest -v`
Expected: FAIL — `follow_drag` is never called (the handoff does not exist yet).

- [ ] **Step 3: Implement the host side**

In `paprika_app.py`, next to `PEEK_SECONDS`:

```python
# How long Windows' own move loop is given to take the gesture before the host
# drives it instead. Long enough for the posted message to be processed, short
# enough that the window is never visibly stuck under the pointer.
DRAG_HANDOFF_SECONDS = 0.12
```

and rewrite `begin_drag`, adding the two helpers next to it:

```python
    def begin_drag(self) -> bool:
        """
        Starts the window's native move gesture for a mousedown the UI accepted.

        The UI is the authority on *where* the window can be grabbed (its
        [data-drag] surfaces, minus anything marked [data-no-drag]), because only
        the page knows which of those pixels belong to a control. The gesture
        itself is Windows' (core.native_window.begin_drag), which is also why this
        returns a bool instead of nothing: a refused grab is worth saying out loud
        once, not silently dropping the pointer.

        Windows' loop is still not the whole story — it needs the mouse capture
        WebView2 holds while the page has the button down — so this does not
        return "started" and walk away: a detached thread checks whether the
        capture changed hands and moves the window itself if it did not. The
        check happens off the bridge thread because driving a drag means sleeping
        between polls for as long as the user holds the button.
        """
        started = native_window.begin_drag(self.window)
        if not started:
            print("[Paprika Lyrics] Could not start a window move (no window handle yet).")
            return False
        self._spawn_detached(self._ensure_drag_moves)
        return True

    def _ensure_drag_moves(self):
        """
        Hands the gesture to the host's own move loop when Windows did not take it.

        The wait is what makes the two paths exclusive: DefWindowProc captures the
        mouse as it enters its modal move loop, so a capture that is still not ours
        shortly after the post means nothing is moving the window. Both paths
        compute the window's position from the same grab point, so a handover
        mid-gesture continues the same drag instead of doubling or jumping it.
        """
        time.sleep(DRAG_HANDOFF_SECONDS)
        if native_window.drag_handed_off(self.window):
            return
        native_window.follow_drag(self.window)

    def _spawn_detached(self, target):
        """Runs `target` off the bridge thread; tests override it to run inline."""
        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        return thread
```

- [ ] **Step 4: Drop the grab cursors**

In `ui/style.css`, replace the whole drag-cursor block with:

```css
/* ---------- Drag surfaces are invisible ----------
   The window's move affordance is the surface itself, exactly like a title bar:
   Windows never changes the pointer over one, and `grab`/`grabbing` on a desktop
   overlay read as a web page's palm rather than a window. The surfaces are declared
   with [data-drag] and their opt-outs with [data-no-drag] — see ui/app.js — and
   nothing here sets a cursor, which also leaves the buttons inside them with the
   pointer cursor they declare themselves. */
```

Then in section 2 of `tools/ui-preview-regression.js`, replace the cursor-era assertion (if the tool still checks one) with:

```js
  // The surfaces must not advertise themselves with a web-page grab hand.
  result.dragSurfacesHaveNoGrabCursor = ['top-drag-strip', 'track-float'].every((id) => {
    const el = document.getElementById(id) || document.querySelector('.' + id);
    return !el || getComputedStyle(el).cursor === 'auto';
  });
  if (!result.dragSurfacesHaveNoGrabCursor) {
    problems.push('a drag surface still shows the grab cursor');
  }
```

- [ ] **Step 5: Verify**

```bash
python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"
node --check ui/app.js && node --check tools/ui-preview-regression.js
```
Expected: `OK`; both JS checks silent. Then the tool at all five viewports, expecting `PASS`.

- [ ] **Step 6: Checkpoint**

```bash
git diff --stat paprika_app.py ui/style.css tools/ui-preview-regression.js tests/test_window_api.py
```

---

### Task 7: The hover dip works while click-through hides the pointer

**Files:**
- Modify: `core/native_window.py` (`cursor_over_window`), `paprika_app.py` (`HOVER_PROBE_SECONDS`, `set_hover_fade`, `_sync_hover_probe`, `_hover_probe`, `_hover_probe_tick`, `_stop_hover_probe`, `_apply_click_through`, `__init__`, `window.expose`, `on_closed`), `ui/app.js` (`windowAlphaTarget`, `window.setHoverFadeInside`, `pushHoverFadeSetting`, `window.setClickThrough`, boot), `tools/ui-preview-regression.js` (section 10)
- Test: `tests/test_native_window.py` (`CursorOverWindowTest`), `tests/test_window_api.py` (`HoverProbeTest`)

**Interfaces:**
- Consumes: `_cursor_pos`, `_window_origin`, `_hwnd_of` (Task 5)
- Produces: `native_window.cursor_over_window(window, user32=None) -> bool`; `paprika_app.HOVER_PROBE_SECONDS = 0.1`; `WindowApi.set_hover_fade(enabled) -> bool` (exposed to JS), `WindowApi._hover_probe_tick() -> bool`, `WindowApi._hover_probe_thread`; JS `window.setHoverFadeInside(inside)`, `pushHoverFadeSetting()`

**Why:** two things kill the dip under click-through today. The UI returns the base alpha outright when `clickThrough` is on, and — the deeper reason — a window with `WS_EX_TRANSPARENT` never receives a mouse message, so the page cannot know the pointer is over it. That is the one input the host *can* supply: the operating system still answers "where is the pointer" and "where is the window". So the policy stays in the UI and the missing fact is pushed to it, which is what makes the dip work in the mini player over a game — the mode where a see-through overlay most wants to get out of the way.

- [ ] **Step 1: Write the failing native test**

In `tests/test_native_window.py`, add:

```python
class CursorOverWindowTest(unittest.TestCase):
    """The pointer question a click-through window cannot ask the page."""

    def test_a_pointer_inside_the_window_rect_counts(self):
        u = FakeUser32()                       # window (100,100)-(900,700)
        u.cursor = (500, 400)
        self.assertTrue(nw.cursor_over_window(FakeWindow(), user32=u))
        u.cursor = (899, 699)
        self.assertTrue(nw.cursor_over_window(FakeWindow(), user32=u))

    def test_a_pointer_outside_is_outside(self):
        u = FakeUser32()
        for point in ((99, 400), (901, 400), (500, 99), (500, 701)):
            u.cursor = point
            self.assertFalse(nw.cursor_over_window(FakeWindow(), user32=u))

    def test_no_handle_is_never_over_the_window(self):
        class NoHandle:
            pass
        self.assertFalse(nw.cursor_over_window(NoHandle(), user32=FakeUser32()))
```

- [ ] **Step 2: Write the failing host test**

In `tests/test_window_api.py`, append:

```python
@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class HoverProbeTest(unittest.TestCase):
    """A click-through window hears about the pointer from the host instead."""

    def setUp(self):
        self.window = FakeWindow()
        self.api = paprika_app.WindowApi(self.window)
        self.pushed = []
        self.cursor = mock.Mock(return_value=True)
        patches = (
            (paprika_app.native_window, "cursor_over_window", self.cursor),
            (paprika_app.native_window, "set_window_alpha", mock.Mock(return_value=True)),
            (paprika_app, "CLICK_THROUGH_ENABLED", True),
        )
        for target, attr, value in patches:
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.api._push_js = lambda script: self.pushed.append(script)

    def test_the_pointer_state_is_pushed_when_it_changes_and_not_otherwise(self):
        self.assertTrue(self.api._hover_probe_tick())
        self.assertEqual(self.pushed, ["window.setHoverFadeInside(true);"])
        self.api._hover_probe_tick()
        self.assertEqual(len(self.pushed), 1)      # nothing changed, nothing pushed
        self.cursor.return_value = False
        self.assertFalse(self.api._hover_probe_tick())
        self.assertEqual(self.pushed[-1], "window.setHoverFadeInside(false);")

    def test_the_probe_runs_only_while_click_through_needs_it(self):
        spawned = []
        self.api._spawn_detached = lambda target: spawned.append(target)
        self.api.set_hover_fade(True)
        self.assertEqual(len(spawned), 1)
        self.assertEqual(spawned[0], self.api._hover_probe)
        self.assertIsNotNone(self.api._hover_probe_thread)
        self.api.set_hover_fade(False)
        self.assertIsNone(self.api._hover_probe_thread)

    def test_without_click_through_the_page_owns_the_pointer_state(self):
        spawned = []
        self.api._spawn_detached = lambda target: spawned.append(target)
        with mock.patch.object(paprika_app, "CLICK_THROUGH_ENABLED", False):
            self.api.set_hover_fade(True)
        self.assertEqual(spawned, [])
        self.assertIsNone(self.api._hover_probe_thread)
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `python -m unittest tests.test_native_window.CursorOverWindowTest tests.test_window_api.HoverProbeTest -v`
Expected: FAIL — `cursor_over_window` and `set_hover_fade` do not exist.

- [ ] **Step 4: Implement the native probe**

In `core/native_window.py`, next to `follow_drag`:

```python
def cursor_over_window(window, user32=None) -> bool:
    """
    Whether the pointer is inside the window's rectangle right now.

    This is the fact a click-through overlay cannot get any other way: with
    WS_EX_TRANSPARENT the window receives no mouse messages at all, so the page
    never sees a mouseover and the hover dip would be dead in exactly the mode it
    is most useful in. The OS still answers both halves of the question —
    GetCursorPos for the pointer, GetWindowRect for the window — and both are
    screen pixels for this process, so no conversion is needed. The right and
    bottom edges are exclusive, as in every other hit test.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    point = _cursor_pos(user32)
    origin = _window_origin(user32, hwnd)
    width, height = _window_size(user32, hwnd)
    if point is None or origin is None or width is None:
        return False
    return (origin[0] <= point[0] < origin[0] + width
            and origin[1] <= point[1] < origin[1] + height)
```

with a small `_window_size` reading the same rect (one more `GetWindowRect`, kept separate so each caller's intent is readable):

```python
def _window_size(user32, hwnd: int) -> tuple[int, int] | None:
    """The window's size in screen pixels (right/bottom are exclusive edges)."""
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    try:
        rect = RECT()
        _declare(user32.GetWindowRect, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p])
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
            return None
        return (int(rect.right - rect.left), int(rect.bottom - rect.top))
    except Exception:
        return None
```

- [ ] **Step 5: Implement the host probe**

In `paprika_app.py`, next to `PEEK_SECONDS`:

```python
# How often the pointer is read on behalf of a click-through window. Fast enough
# that the dip tracks the pointer, slow enough that a GetCursorPos per tick is
# nothing next to the window's own painting.
HOVER_PROBE_SECONDS = 0.1
```

In `WindowApi.__init__`:

```python
        self._hover_fade = False       # the UI's setting: is the dip switched on
        self._hover_probe_thread = None
        self._hover_probe_stop = threading.Event()
        self._hover_probe_inside = None
```

Next to `set_click_through`:

```python
    # =====================================================================
    # Hover probe
    #
    # A click-through window never receives a mouse message, so the page cannot
    # tell whether the pointer is over the overlay and the hover dip would be dead
    # in the mode where it is most useful — a mini player floating over a game.
    # The OS can still answer the question (see core.native_window.
    # cursor_over_window), so while click-through is on and the dip is switched on
    # the host asks it and pushes the answer, exactly as it pushes a forced
    # always-on-top state. The opacity policy stays in the UI.
    # =====================================================================
    def set_hover_fade(self, enabled: bool) -> bool:
        """The UI reports whether the hover dip is switched on. Returns it back."""
        self._hover_fade = bool(enabled)
        self._sync_hover_probe()
        return self._hover_fade

    def _sync_hover_probe(self):
        """Runs the pointer probe exactly while click-through hides the pointer."""
        wants = self._hover_fade and CLICK_THROUGH_ENABLED
        if wants and self._hover_probe_thread is None:
            self._hover_probe_stop.clear()
            self._hover_probe_thread = self._spawn_detached(self._hover_probe)
        elif not wants:
            self._stop_hover_probe()

    def _stop_hover_probe(self):
        """
        Ends the probe and tells the UI it owns the pointer state again.

        The push matters: the last thing the UI was told may have been "inside",
        and leaving it there would hold a dip that nothing is hovering.
        """
        if self._hover_probe_thread is None:
            return
        self._hover_probe_stop.set()
        self._hover_probe_thread = None
        self._hover_probe_inside = None
        self._push_js("window.setHoverFadeInside(false);")

    def _hover_probe(self):
        """Polls the pointer until the probe is stopped; one pass is _hover_probe_tick."""
        while not self._hover_probe_stop.is_set():
            self._hover_probe_tick()
            self._hover_probe_stop.wait(HOVER_PROBE_SECONDS)

    def _hover_probe_tick(self) -> bool:
        """Pushes the pointer's state to the UI when it changed. Returns it."""
        inside = native_window.cursor_over_window(self.window)
        if inside == self._hover_probe_inside:
            return inside
        self._hover_probe_inside = inside
        self._push_js(f"window.setHoverFadeInside({str(bool(inside)).lower()});")
        return inside
```

In `_apply_click_through`, re-derive the probe after the style change (so turning click-through on starts it and turning it off stops it):

```python
    def _apply_click_through(self, enabled: bool):
        if native_window.set_click_through(self.window, enabled):
            # The ex-style write above can drop the layered attributes the
            # transparency lives in: put the alpha back before anything repaints.
            self._reapply_alpha()
            # Click-through is what hides the pointer from the page, so the probe
            # starts and stops with it.
            self._sync_hover_probe()
            ...
```

Expose it in `window.expose(...)` (`api.set_hover_fade,` after `api.set_window_alpha,`), and stop the probe in `on_closed` next to `_cancel_peek_timer()`.

- [ ] **Step 6: Implement the UI half**

In `ui/app.js`, `windowAlphaTarget` loses the click-through early-out and gains the fact that the state may come from the host:

```js
function windowAlphaTarget() {
  if (isFullscreen) return 1;
  const base = windowOpacityValue();
  // The settings sheet is text being read: the pointer being over it is not a
  // reason to dim the thing being read.
  if (document.body.classList.contains('settings-open')) return base;
  // hoverFadeInside is fed by this page's own pointer events, or — while
  // click-through takes them away — pushed by the host's pointer probe. Either
  // way it is the same fact, so the dip needs no click-through special case.
  if (hoverFade === 'off' || !hoverFadeInside || hoverFadeCtrl) return base;
  return Math.min(base, HOVER_FADE_ALPHA[hoverFade] || base);
}
```

And the host's push, next to `initHoverFade`:

```js
// The host's answer to a question this page cannot ask while click-through is on:
// with WS_EX_TRANSPARENT the window receives no mouse messages, so the host reads
// the pointer against the window rect and pushes it here (paprika_app._hover_probe).
window.setHoverFadeInside = function (inside) {
  hoverFadeInside = !!inside;
  applyWindowOpacity();
};

// The host needs to know whether a dip is switched on before it polls for one.
function pushHoverFadeSetting() {
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_hover_fade) api.set_hover_fade(hoverFade !== 'off');
}

function pushHoverFadeSettingWhenReady() {
  if (window.pywebview && window.pywebview.api) {
    pushHoverFadeSetting();
    return;
  }
  window.addEventListener('pywebviewready', () => pushHoverFadeSetting());
}
```

Call `pushHoverFadeSetting()` at the end of `cycleHoverFade()`, call `pushHoverFadeSettingWhenReady();` in the boot block (after `initCursorIdle();`), and in `window.setClickThrough` clear the state the page can no longer observe:

```js
window.setClickThrough = function(enabled) {
  clickThrough = !!enabled;
  // The pointer state is a different authority in each mode: the page's own
  // events while the window can be clicked, the host's probe while it cannot.
  // Drop the cached answer so neither mode starts out holding the other's.
  hoverFadeInside = false;
  hoverFadeCtrl = false;
  applyWindowOpacity();
  ...
```

Update the top-of-block comment on `window.setClickThrough` (it currently says the dip "stops being observable" and the base applies undipped) to say the host now supplies the state, and update the transparency header comment's click-through paragraph to match.

- [ ] **Step 7: Rewrite section 10 of the regression tool**

Replace the click-through and Ctrl checks in section 10 with the mode matrix, including the new one:

```js
  clickThrough = true;
  hoverFade = 'clear';        // 0.7, below the 0.8 base, so the dip is visible
  hoverFadeInside = false;
  appliedAlpha = 1;
  applyWindowOpacity();
  result.alphaClickThroughBase = alphaCalls[alphaCalls.length - 1];
  window.setHoverFadeInside(true);
  result.alphaClickThroughDip = alphaCalls[alphaCalls.length - 1];
  window.setHoverFadeInside(false);
  clickThrough = false;
  if (result.alphaClickThroughBase !== 0.8) problems.push('click-through lost the base opacity: ' + result.alphaClickThroughBase);
  if (!(result.alphaClickThroughDip < 0.8)) problems.push('the hover dip is dead while click-through is on: ' + result.alphaClickThroughDip);
```

- [ ] **Step 8: Run everything**

Run: `python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"`
Expected: `OK`. Then `node --check ui/app.js && node --check tools/ui-preview-regression.js` and the preview tool at all five viewports; expected `PASS` with `alphaClickThroughBase 0.8` and `alphaClickThroughDip 0.7`.

- [ ] **Step 9: Checkpoint**

```bash
git diff --stat core/native_window.py paprika_app.py ui/app.js tools/ui-preview-regression.js tests/
```

---

### Task 8: Final pass and docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full gates**

```bash
python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"
node --check ui/app.js && node --check tools/ui-preview-regression.js && echo "JS OK"
grep -rn "apply_native_rounded_corners\|apply_rounded_corners\|cursor: grab" ui/ core/ paprika_app.py || echo "no stale references"
```
Expected: `OK`; `JS OK`; `no stale references`.

- [ ] **Step 2: Preview regression at five viewports**

`python -m http.server 8471` from the repo root, open `http://127.0.0.1:8471/ui/index.html`, eval the tool, then `await run('<label>')` at 1400×900, 900×700, 800×600, 360×420 and 330×380. Expected `PASS` at every size. Bust a stale stylesheet with `document.querySelector('link[rel="stylesheet"]').href = 'style.css?v=' + Date.now()`.

- [ ] **Step 3: README**

- **Move Window** row: it is a native move, Windows' caption loop when it takes the capture and the host's own pointer-following move when it does not; surfaces and opt-outs unchanged; no grab cursor; fullscreen still refuses the gesture.
- **Window Opacity** row: unchanged, plus that the hover dip now also applies while click-through is on (the host reads the pointer).
- **Fade While Hovered** row: the dip goes below the chosen opacity and works with click-through, where the host probes the pointer because the page cannot see it.
- **Fullscreen** row: the pointer hides after two idle seconds **and any movement brings it straight back** (and it is never hidden while the settings sheet or a drag is up).
- **Player** row (or the layout notes): the compact card's seek row with its times sits on the cover, under the transport.
- **Settings page** row: labels line up on one column; the app has no border (stylesheet and DWM both).
- Smoke checklist: add the three items only a real Windows run can settle — drag the overlay from the top band and from the card, snap it to a screen edge, and confirm the pointer reappears the moment the mouse moves in fullscreen; enable click-through + 80% opacity + a hover dip and confirm the window dims as the pointer crosses it; check there is no light outline around the window on a light desktop.

- [ ] **Step 4: Checkpoint**

```bash
git status --short; git diff --stat
```
Expected: only files touched by this plan plus the pre-existing uncommitted work. Report the list and ask whether to commit — **do not commit or stage anything**.

---

## Self-review

**Spec coverage**
- *1. Progress bar onto the song cover* → Task 3.
- *2. The mouse disappears in fullscreen* → Task 4.
- *3. Cannot move the window / ugly hand cursor* → Tasks 5, 6.
- *4. The hover dip in pip with click-through on* → Task 7.
- *5. Settings text not aligned properly* → Task 2.
- *6. Remove the app outline* → Task 1.

**Known gaps, called out honestly**
- Whether Windows' move loop takes the capture on this machine, and whether the host's own loop then feels as good as a native title-bar drag (no Aero Snap in the fallback), cannot be checked here. The seam is unit-tested both ways; the README smoke list is the manual gate.
- The fallback move does not snap to screen edges. If the user misses snapping, that is a follow-up worth doing deliberately (snap on release against the monitor work area), not something to bolt on blind.
- The pointer probe costs one `GetCursorPos` per 100 ms, and only while click-through and the dip are both on.
