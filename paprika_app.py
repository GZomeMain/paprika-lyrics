import ctypes
import sys
import threading
import time

DEPENDENCY_HINT = (
    "Missing a required dependency. Install everything with:\n"
    "    pip install -r requirements.txt"
)

try:
    import webview
except ImportError:
    print("[Paprika Lyrics] Could not import 'pywebview'.\n" + DEPENDENCY_HINT)
    sys.exit(1)

try:
    from webview.window import FixPoint
except ImportError:  # pragma: no cover - pre-5.x pywebview
    FixPoint = None

# pywebview's own resize default: keep the top-left corner. Used when a resize
# is not driven by a handle (mini-player entry, geometry restore).
_DEFAULT_FIX_POINT = (FixPoint.NORTH | FixPoint.WEST) if FixPoint is not None else None

try:
    from config import (
        DEFAULT_WIDTH,
        DEFAULT_HEIGHT,
        INDEX_HTML_PATH,
        PARSER_VERSION,
        WEBVIEW_PROFILE_DIR,
    )
    from storage import CACHE
    from core.lyrics import ASYNC_EXECUTOR
    from core.smtc import SmtcBridge
    from core.hotkeys import GlobalHotkeyManager
    from core.ttml_library import TTML_LIBRARY
    from core import native_window
except ImportError as exc:
    print(f"[Paprika Lyrics] Failed to load a core module: {exc}\n" + DEPENDENCY_HINT)
    sys.exit(1)

SHUTDOWN_SIGNAL = threading.Event()
SMTC_BRIDGE = SmtcBridge(SHUTDOWN_SIGNAL)
HOTKEY_MANAGER = None
WINDOW_REF = None
WINDOW_API_REF = None
CLICK_THROUGH_ENABLED = False

# Window size bounds. The normal range is the windowed overlay; the mini range
# is the lyrics-only mini player. Both are mirrored in ui/app.js (the resize
# handles clamp against them before they ever reach this side) and enforced
# here as well, because the UI is not the only thing that can ask for a size.
NORMAL_MIN = (320, 380)
NORMAL_MAX = (1400, 1600)
MINI_MIN = (320, 380)
MINI_MAX = (900, 1200)
MINI_SIZE = (460, 560)

# Hover transparency. The alpha the UI asks for while the pointer is over the
# overlay, the floor it is clamped to, and how long a fade takes — short enough
# to feel immediate, long enough not to flash when the pointer crosses the edge.
HOVER_FADE_FLOOR = 0.35
FADE_STEP = 0.11
FADE_STEP_SECONDS = 0.015

# How long a click-through "peek" hands the mouse back for. Long enough to drag
# the overlay where you want it, short enough that forgetting about it does not
# leave a window that keeps swallowing clicks.
PEEK_SECONDS = 8

# How often the pointer is read on behalf of a click-through window: fast enough
# that the hover dip tracks the pointer, slow enough that one GetCursorPos per
# tick is nothing next to the window's own painting.
HOVER_PROBE_SECONDS = 0.1

# How long Windows' own move loop is given to take a posted drag gesture before
# the host drives the move instead. Long enough for the posted message to be
# processed, short enough that the window is never visibly stuck under the
# pointer. See WindowApi.begin_drag.
DRAG_HANDOFF_SECONDS = 0.12


def apply_native_window_frame(window):
    """
    Gives the window its finished frame: DWM rounded corners and no border.

    Windows 11 draws a 1px border around every window, and DWM's rounded corners
    are the only edge an overlay wants — see core.native_window.apply_window_frame.
    """
    native_window.apply_window_frame(window)

def on_hotkey_adjust(delta_ms: int):
    """Dispatches latency adjustments to the webview UI."""
    global WINDOW_REF
    if WINDOW_REF:
        try:
            WINDOW_REF.evaluate_js(f"window.adjustLatency({delta_ms});")
        except Exception:
            pass

def on_hotkey_click_through():
    """
    Global escape hatch for click-through mode. It has to be global because once
    the overlay ignores the mouse, nothing inside the window can be clicked.
    """
    api = WINDOW_API_REF
    if api is None:
        return
    api.set_click_through(not CLICK_THROUGH_ENABLED)
    if WINDOW_REF:
        try:
            # setClickThrough(false) closes any settings panel left stranded
            # under click-through, so the UI comes back clean.
            WINDOW_REF.evaluate_js(f"window.setClickThrough({str(CLICK_THROUGH_ENABLED).lower()});")
        except Exception:
            pass

def on_hotkey_peek():
    """
    Ctrl+Shift+M. Pressing it again while a peek is up ends it early, so the
    shortcut reads as a toggle rather than a timer you have to wait out.
    """
    api = WINDOW_API_REF
    if api is None:
        return
    timer = getattr(api, '_peek_timer', None)
    if timer is not None and timer.is_alive():
        api.end_peek()
    else:
        api.start_peek()

HOTKEY_MANAGER = GlobalHotkeyManager(on_hotkey_adjust, on_hotkey_click_through, on_hotkey_peek)

class WindowApi:
    def __init__(self, window):
        self.window = window
        # Native state this class owns and has to be able to restore. The UI is
        # the source of truth for the user's *preference*; these mirror what is
        # actually applied right now.
        self._ontop = False
        self._pre_mini_ontop = None
        self._fullscreen = False
        self._mini = False
        self._alpha_current = 1.0
        self._alpha_target = 1.0
        self._alpha_lock = threading.Lock()
        self._fs_style = None          # GWL_STYLE captured at fullscreen entry
        self._saved_geometry = None    # the windowed rect fullscreen comes back to
        self._peek_timer = None        # click-through peek timer, see start_peek
        self._hover_fade = False       # the UI's setting: is the hover dip switched on
        self._hover_probe_thread = None
        self._hover_probe_stop = threading.Event()
        self._hover_probe_inside = None

    def close(self):
        self._record_window_geometry()
        SHUTDOWN_SIGNAL.set()
        self.window.destroy()

    def minimize(self):
        self.window.minimize()

    def resize_window(self, width: int, height: int, anchor: str = 'e'):
        """
        Resizes the window, holding the edge opposite `anchor` still.

        `anchor` is the direction of the resize handle the user grabbed ('e',
        'w', 'n', 's', 'ne', 'nw', 'se', 'sw'), which determines the anchor:
        dragging the west edge must keep the east edge where it is, or the
        window appears to resize from the wrong side. pywebview's resize takes
        the fix point and the winforms backend applies position and size in one
        SetWindowPos, so the anchor is exact and atomic — no move/resize pair to
        land in different frames.
        """
        try:
            min_w, min_h = MINI_MIN if getattr(self, '_mini', False) else NORMAL_MIN
            max_w, max_h = MINI_MAX if getattr(self, '_mini', False) else NORMAL_MAX
            w = max(min_w, min(max_w, int(width)))
            h = max(min_h, min(max_h, int(height)))
            fix_point = native_window.fix_point_for(anchor, FixPoint) if FixPoint is not None else None
            if fix_point is None:
                self.window.resize(w, h)
            else:
                self.window.resize(w, h, fix_point)
            # A resize while fullscreen would shrink the window out of monitor
            # coverage; put the monitor bounds back (no-op while windowed).
            if getattr(self, '_fullscreen', False):
                native_window.reassert_fullscreen(self.window)
        except Exception:
            pass

    def begin_drag(self) -> bool:
        """
        Starts the window's native move gesture for a mousedown the UI accepted.

        The UI is the authority on *where* the window can be grabbed (its
        [data-drag] surfaces, minus anything marked [data-no-drag]), because only
        the page knows which of those pixels belong to a control. The gesture
        itself is the operating system's (see core.native_window.begin_drag) —
        which is also why this returns a bool instead of nothing: a refused grab
        is worth saying out loud once, not silently dropping the pointer.

        Windows' modal move loop is still not the whole story, though: it needs
        the mouse capture, and while the page has the button down that capture
        belongs to WebView2's child window. So this does not report "started" and
        walk away — a detached thread checks whether the loop took over and moves
        the window itself when it did not. That check sleeps for as long as the
        user holds the button, which is why it is off the bridge thread.
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
        compute the position from the same grab point, so a handover mid-gesture
        continues the same drag rather than doubling or jumping it.
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

    def save_window_size(self, width: int, height: int):
        try:
            if getattr(self, '_mini', False):
                min_w, min_h = MINI_MIN
                max_w, max_h = MINI_MAX
                CACHE.save_mini_size(
                    max(min_w, min(max_w, int(width))),
                    max(min_h, min(max_h, int(height))),
                )
                return
            w = max(NORMAL_MIN[0], min(NORMAL_MAX[0], int(width)))
            h = max(NORMAL_MIN[1], min(NORMAL_MAX[1], int(height)))
            CACHE.save_window_size(w, h)
        except Exception:
            pass

    def set_mini_mode(self, enabled: bool) -> bool:
        """
        Shrinks the window to the lyrics-only mini player, or restores the
        windowed geometry the user had before it. Returns the state applied,
        which the UI mirrors back.

        This is the same window, not a second one: the overlay exists to show
        one audio source's lyrics, and a separate window would need a second
        copy of the whole sync pipeline (SMTC pushes, playhead, latency) for no
        gain. Mini is a mode of the surface, so it is a resize plus a layout
        class, and the lyrics keep playing seamlessly through it.

        Mini also PINS the window on top. A lyrics-only strip is meant to float
        over whatever the user is actually working in, and being buried behind a
        browser made it useless the moment they clicked away from it. The user's
        own always-on-top preference is restored on the way out — unless they
        changed it while mini, which is respected as their new preference.
        """
        enabled = bool(enabled)
        if enabled == getattr(self, '_mini', False):
            return enabled
        try:
            if enabled:
                # Fullscreen owns the whole monitor: a mini window inside it is
                # meaningless, so leave fullscreen first.
                if getattr(self, '_fullscreen', False):
                    self.toggle_fullscreen()
                self._pre_mini_geometry = self._current_geometry()
                self._pre_mini_ontop = self._ontop
                saved = CACHE.get_mini_size()
                w = int(saved.get('width') or MINI_SIZE[0])
                h = int(saved.get('height') or MINI_SIZE[1])
                w = max(MINI_MIN[0], min(MINI_MAX[0], w))
                h = max(MINI_MIN[1], min(MINI_MAX[1], h))
                self._mini = True
                self.window.resize(w, h, _DEFAULT_FIX_POINT)
                self._apply_topmost(True)
            else:
                self._mini = False
                geometry = getattr(self, '_pre_mini_geometry', None)
                restore_ontop = getattr(self, '_pre_mini_ontop', None)
                self._pre_mini_geometry = None
                self._pre_mini_ontop = None
                if geometry:
                    x, y, w, h = geometry
                    self.window.move(x, y)
                    self.window.resize(
                        max(NORMAL_MIN[0], min(NORMAL_MAX[0], w)),
                        max(NORMAL_MIN[1], min(NORMAL_MAX[1], h)),
                        _DEFAULT_FIX_POINT,
                    )
                if restore_ontop is not None:
                    self._apply_topmost(restore_ontop)
        except Exception as exc:
            print(f"[Paprika Lyrics] Mini player toggle failed: {exc}")
            return getattr(self, '_mini', False)
        return self._mini

    def _current_geometry(self):
        try:
            return (self.window.x, self.window.y, self.window.width, self.window.height)
        except Exception:
            return None

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

        The alpha policy itself is the UI's: fullscreen is opaque because it
        pushes 1.0 right after this returns, not because the host forces it.
        """
        try:
            if not getattr(self, '_fullscreen', False):
                # Save first: SW_RESTORE inside apply_fullscreen may move the
                # window (it leaves the maximized state) before we could read it.
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

    def _record_window_geometry(self):
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
        # Closing while mini records the geometry the user left behind, not the
        # stub the mini player happens to be: the next launch should open at the
        # size they were actually working in.
        if getattr(self, '_mini', False) and getattr(self, '_pre_mini_geometry', None):
            x, y, w, h = self._pre_mini_geometry
            try:
                CACHE.save_window_position(x, y)
                CACHE.save_window_size(w, h)
            except Exception:
                pass
            return
        try:
            CACHE.save_window_position(getattr(self.window, "x", None), getattr(self.window, "y", None))
        except Exception:
            pass

    def save_latency(self, track_key: str, offset_ms: int):
        CACHE.set_latency(track_key, offset_ms)

    def set_click_through(self, enabled: bool) -> bool:
        """
        Makes the overlay ignore mouse input so it can sit over a game or browser.
        Returns the state actually applied, which the UI mirrors back.

        Refused when the Ctrl+Shift+T escape hatch failed to register: enabling it
        then would leave no way to hand the mouse back to the window.
        """
        global CLICK_THROUGH_ENABLED
        enabled = bool(enabled)
        if enabled and not HOTKEY_MANAGER.click_through_bound:
            print(
                "[Paprika Lyrics] Click-through refused: Ctrl+Shift+T is not registered by "
                "this app, so it would be impossible to turn the mouse back on."
            )
            return False

        CLICK_THROUGH_ENABLED = enabled
        self._apply_click_through(enabled)
        return CLICK_THROUGH_ENABLED

    def _apply_click_through(self, enabled: bool):
        if native_window.set_click_through(self.window, enabled):
            # The ex-style write above can drop the layered attributes the
            # transparency lives in: put the alpha back before anything repaints.
            self._reapply_alpha()
            # Click-through is exactly what hides the pointer from the page, so
            # the hover probe starts and stops with it.
            self._sync_hover_probe()
            # A style mutation can nudge a maximized/borderless window's derived
            # bounds back to the work area; if we were fullscreen, put the
            # monitor coverage back immediately.
            if getattr(self, '_fullscreen', False):
                native_window.reassert_fullscreen(self.window)
        else:
            print("[Paprika Lyrics] Could not change click-through state.")

    # =====================================================================
    # Click-through peek
    #
    # Click-through is mouse-proof by definition, so with it on there is no way
    # to move or resize the overlay at all — the only route was to leave the
    # mode, fix the position and turn it back on. A peek hands the mouse back for
    # a few seconds while keeping the window where it is and at the opacity the
    # user chose: it flips the same switch click-through uses, so a refused
    # click-through (no escape hotkey bound) can never be peeked into an
    # unrecoverable state.
    # =====================================================================
    def start_peek(self) -> bool:
        """Ctrl+Shift+M: make a click-through overlay mouse-reachable for a while."""
        if not CLICK_THROUGH_ENABLED:
            return False
        self._cancel_peek_timer()
        # Turning click-through off cannot be refused — only enabling it is
        # guarded by the escape hotkey — and set_click_through reports the state
        # it applied, which is False here, so its return value is not a flag.
        self.set_click_through(False)
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

    # =====================================================================
    # Hover probe
    #
    # A click-through window never receives a mouse message, so the page cannot
    # tell whether the pointer is over the overlay — and the hover dip would be
    # dead in exactly the mode where it is most useful, a mini player floating
    # over a game. The operating system can still answer the question (see
    # core.native_window.cursor_over_window), so while click-through is on and
    # the dip is switched on, the host asks it and pushes the answer, the same way
    # it pushes a forced always-on-top state. The opacity policy stays in the UI.
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
        Ends the probe and hands the pointer state back to the page.

        The push matters: the last thing the UI was told may have been "inside",
        and leaving that cached would hold a dip that nothing is hovering over.
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

    def set_always_on_top(self, enabled: bool):
        """
        Toggles always-on-top via Win32. pywebview exposes no runtime setter for
        on_top (assigning window.on_top is a no-op at best, and touching the
        events object here crashes), so go straight to SetWindowPos.

        A SetWindowPos against a maximized fullscreen window makes Windows
        re-derive its bounds from the work area — the fullscreen-breaking bug —
        so the monitor bounds are reasserted right after when fullscreen is on.
        """
        enabled = bool(enabled)
        # Remembered, not just applied: the mini player pins the window on top and
        # has to know what to restore afterwards.
        self._ontop = enabled
        if getattr(self, '_mini', False):
            # Changed while mini: that is the preference to come back to.
            self._pre_mini_ontop = enabled
        self._apply_topmost(enabled)

    def _apply_topmost(self, enabled: bool):
        """Applies always-on-top and mirrors the result into the UI."""
        enabled = bool(enabled)
        self._ontop = enabled
        if native_window.set_topmost(self.window, enabled):
            if getattr(self, '_fullscreen', False):
                native_window.reassert_fullscreen(self.window)
        else:
            print("[Paprika Lyrics] Could not change always-on-top.")
        self._push_js(f"window.setAlwaysOnTop({str(enabled).lower()});")

    # =====================================================================
    # Hover transparency
    #
    # The UI decides when the window should be see-through (pointer over the
    # overlay, Ctrl not held) and this side owns the native alpha. The fade is
    # stepped here rather than snapped because the bridge call already runs on
    # its own thread: ~7 steps of 15ms is a smooth 100ms fade that costs the UI
    # nothing, and a request that lands mid-fade simply retargets the loop
    # instead of starting a second one.
    # =====================================================================
    def set_window_alpha(self, alpha: float) -> float:
        """Fades the whole window to `alpha` (1.0 = opaque). Returns the target."""
        try:
            target = max(HOVER_FADE_FLOOR, min(1.0, float(alpha)))
        except (TypeError, ValueError):
            return self._alpha_target
        self._alpha_target = target
        if not self._alpha_lock.acquire(blocking=False):
            return target   # a fade is already running; it will pick this up
        try:
            while True:
                current = self._alpha_current
                goal = self._alpha_target
                if abs(goal - current) < 0.008:
                    break
                step = FADE_STEP if goal > current else -FADE_STEP
                if abs(goal - current) < FADE_STEP:
                    step = goal - current
                current += step
                self._alpha_current = current
                if not native_window.set_window_alpha(self.window, current):
                    # No layered window available (or no HWND yet): keep the state
                    # consistent so the next request does not spin here.
                    self._alpha_current = goal
                    break
                time.sleep(FADE_STEP_SECONDS)
        finally:
            self._alpha_lock.release()
        return self._alpha_target

    def _reapply_alpha(self):
        """
        Re-assert the alpha the UI last asked for, without animating.

        Every path that rewrites GWL_EXSTYLE — click-through, a fullscreen style
        change — can drop a layered window's attributes, and the transparency is
        exactly those attributes. Re-applying them keeps the two features
        composing instead of one silently cancelling the other. When the window
        is meant to be opaque there is nothing to re-assert, and leaving it
        unlayered also keeps DWM's rounded corners on their normal path.
        """
        if self._alpha_current >= 1.0:
            return
        native_window.set_window_alpha(self.window, self._alpha_current)

    def _push_js(self, script: str):
        """Best-effort state push to the UI (used when the host changes state)."""
        if not WINDOW_REF:
            return
        try:
            WINDOW_REF.evaluate_js(script)
        except Exception:
            pass

    def get_hotkey_binding(self) -> dict:
        """
        Reports which system-wide shortcuts actually bound. The UI uses this to
        decide whether it should also handle Ctrl+[ / Ctrl+] itself: while the
        global hotkey is live, in-window handling would apply every nudge twice.
        Click-through and peek are reported so the settings hint can say when a
        shortcut is unavailable rather than leaving it a silent no-op.
        """
        return {
            "sync": bool(HOTKEY_MANAGER.sync_bound),
            "click_through": bool(HOTKEY_MANAGER.click_through_bound),
            "peek": bool(HOTKEY_MANAGER.peek_bound),
        }

    # =====================================================================
    # Local TTML library (the settings panel's whole API)
    #
    # Every method returns the full panel snapshot, so the UI renders from one
    # source of truth and never has to guess what a mutation did. Whenever a
    # change can alter the lyrics on screen, the track is reloaded right away.
    # =====================================================================
    def ttml_list(self, title: str = "", artist: str = "", album: str = "",
                  duration_ms: float = 0) -> dict:
        """Library contents plus this track's state (bound / matched / off)."""
        return self._ttml_snapshot(title, artist, album, duration_ms, "")

    def ttml_import(self, title: str = "", artist: str = "", album: str = "",
                    duration_ms: float = 0) -> dict:
        """
        Opens a native file picker and copies the chosen .ttml files in.

        The dialog is the one part of this feature that cannot be unit-tested or
        driven from the UI, so its failure is reported in the same `status`
        string the panel already renders rather than raising into the bridge.
        """
        try:
            files = self.window.create_file_dialog(
                webview.FileDialog.OPEN,
                directory=str(TTML_LIBRARY.ensure_dir()),
                allow_multiple=True,
                file_types=('TTML lyrics (*.ttml;*.xml)', 'All files (*.*)'),
            )
        except Exception as exc:
            return self._ttml_snapshot(
                title, artist, album, duration_ms,
                f"File picker unavailable ({exc}). Use “Open folder” instead.")

        if not files:
            return self._ttml_snapshot(title, artist, album, duration_ms, "")

        report = TTML_LIBRARY.add_files(files)
        added = report.get("added", [])
        failed = report.get("failed", [])
        skipped = report.get("skipped", [])
        parts = []
        if added:
            parts.append(f"Added {len(added)} file{'s' if len(added) != 1 else ''}")
        if skipped:
            parts.append(f"{len(skipped)} already in the library")
        for item in failed:
            parts.append(f"{item.get('name')}: {item.get('reason')}")
        return self._ttml_snapshot(
            title, artist, album, duration_ms,
            " · ".join(parts) if parts else "Nothing imported.")

    def ttml_rescan(self, title: str = "", artist: str = "", album: str = "",
                    duration_ms: float = 0) -> dict:
        """
        Re-reads the folder from scratch.

        Forced, unlike the implicit scan on every track load: a Rescan is a user
        saying "look again" (they just edited or replaced a file), and the cheap
        size/mtime shortcut is exactly what would make it look broken.
        """
        try:
            TTML_LIBRARY.scan(force=True)
        except Exception as exc:
            print(f"[Paprika Lyrics] TTML rescan failed: {exc}")
        snapshot = self._ttml_snapshot(title, artist, album, duration_ms, "")
        count = snapshot.get("count", 0)
        snapshot["status"] = f"Rescanned — {count} file{'s' if count != 1 else ''} in the library"
        return snapshot

    def ttml_reveal(self, file: str = "") -> bool:
        """Opens the library folder (or selects one file in it) in Explorer."""
        return TTML_LIBRARY.reveal(file or "")

    def ttml_bind(self, file: str, title: str, artist: str, album: str = "",
                  duration_ms: float = 0) -> dict:
        """Binds a library file to the track that is playing right now."""
        result = TTML_LIBRARY.set_binding(file, title, artist, album or None,
                                          duration_ms or None, enabled=True)
        status = (f"Using {file} for “{title}”" if result.get("ok")
                  else str(result.get("reason")))
        if result.get("ok"):
            SMTC_BRIDGE.request_reload()
        return self._ttml_snapshot(title, artist, album, duration_ms, status)

    def ttml_set_enabled(self, enabled: bool, title: str, artist: str, album: str = "",
                         duration_ms: float = 0) -> dict:
        """
        Turns local lyrics for the current track on or off.

        Turning them OFF is sticky: without the explicit marker, the next
        auto-match would silently take the song back and the user's choice would
        look broken.
        """
        result = TTML_LIBRARY.set_enabled(title, artist, album or None,
                                          duration_ms or None, enabled=bool(enabled))
        status = ("Using local lyrics for this song" if enabled
                  else "Using online lyrics for this song")
        if result.get("ok"):
            SMTC_BRIDGE.request_reload()
        return self._ttml_snapshot(
            title, artist, album, duration_ms,
            status if result.get("ok") else str(result.get("reason")))

    def ttml_remove(self, file: str, title: str = "", artist: str = "",
                    album: str = "", duration_ms: float = 0) -> dict:
        """Moves a library file to its .trash folder and forgets it."""
        result = TTML_LIBRARY.remove_file(file)
        if result.get("ok"):
            status = f"Removed {result.get('name')} (moved to .trash)"
            SMTC_BRIDGE.request_reload()
        else:
            status = str(result.get("reason"))
        return self._ttml_snapshot(title, artist, album, duration_ms, status)

    def _ttml_snapshot(self, title, artist, album, duration_ms, status: str) -> dict:
        """
        One panel payload, current track included.

        The UI passes the track it is displaying into every call, so every
        mutation comes back with the per-track state already resolved — the
        panel never renders a stale "using X" line after a change.
        """
        try:
            snapshot = TTML_LIBRARY.snapshot(title or "", artist or "",
                                             album or None, duration_ms or None)
        except Exception as exc:
            print(f"[Paprika Lyrics] Could not read the TTML library: {exc}")
            snapshot = {"dir": str(TTML_LIBRARY.directory), "count": 0,
                        "entries": [], "current": None, "trash": 0}
        snapshot["status"] = status
        return snapshot

    def toggle_playback(self):
        SMTC_BRIDGE.toggle_playback()

    def skip_next(self):
        SMTC_BRIDGE.skip_next()

    def skip_previous(self):
        SMTC_BRIDGE.skip_previous()

    def seek_position(self, target_ms: float):
        SMTC_BRIDGE.seek_position(target_ms)

# =====================================================================
# APPLICATION RUNTIME ENTRY
# =====================================================================
if __name__ == '__main__':
    # Purge cached lyrics from older parser versions (and anything past its TTL)
    # before the UI can ever be handed one. Reading still re-validates each
    # payload, so this only stops dead weight accumulating on disk.
    purged = CACHE.scrub_lyrics(PARSER_VERSION)
    if purged:
        print(f"[Paprika Lyrics] Purged {purged} outdated cached lyric payload(s).")

    saved_win = CACHE.get_window_geometry()
    init_x = saved_win.get("x")
    init_y = saved_win.get("y")

    init_w = max(320, min(1400, int(saved_win.get("width") or DEFAULT_WIDTH)))
    init_h = max(380, min(1600, int(saved_win.get("height") or DEFAULT_HEIGHT)))

    if init_x is not None and init_y is not None:
        try:
            u32 = ctypes.windll.user32
            max_x = u32.GetSystemMetrics(78)
            max_y = u32.GetSystemMetrics(79)
            if not (-2000 < init_x < max_x and -1000 < init_y < max_y):
                init_x, init_y = None, None
        except Exception:
            init_x, init_y = None, None

    window = webview.create_window(
        title='Paprika Lyrics',
        url=INDEX_HTML_PATH.resolve().as_uri(),
        width=init_w,
        height=init_h,
        x=init_x,
        y=init_y,
        frameless=True,
        resizable=True,
        min_size=(320, 380),
        easy_drag=False,
        # Not topmost at creation: the saved setting (off by default) is applied
        # by the UI once the bridge is ready.
        on_top=False,
        background_color='#090909'
    )
    WINDOW_REF = window

    api = WindowApi(window)
    WINDOW_API_REF = api
    window.expose(
        api.close,
        api.minimize,
        api.resize_window,
        api.begin_drag,
        api.save_window_size,
        api.set_mini_mode,
        api.toggle_playback,
        api.seek_position,
        api.skip_next,
        api.skip_previous,
        api.save_latency,
        api.set_click_through,
        api.toggle_fullscreen,
        api.set_always_on_top,
        api.get_hotkey_binding,
        api.set_window_alpha,
        api.set_hover_fade,
        api.ttml_list,
        api.ttml_import,
        api.ttml_rescan,
        api.ttml_reveal,
        api.ttml_bind,
        api.ttml_set_enabled,
        api.ttml_remove
    )

    def on_shown():
        apply_native_window_frame(window)

    def on_closed():
        SHUTDOWN_SIGNAL.set()
        HOTKEY_MANAGER.stop()
        api._cancel_peek_timer()
        api._stop_hover_probe()
        api._record_window_geometry()
        # flush_sync, not flush: the writes are debounced behind a timer, and a
        # timer that has not fired is gone with the process — which is how a
        # just-made local-TTML binding could be forgotten. It also reports its own
        # failure, so a cache that cannot be written is said out loud instead of
        # costing the user their settings silently.
        if not CACHE.flush_sync():
            print("[Paprika Lyrics] Warning: the cache could not be saved on exit.")
        ASYNC_EXECUTOR.shutdown(wait=False)

    window.events.shown += on_shown
    window.events.closed += on_closed
    HOTKEY_MANAGER.start()
    try:
        # private_mode=False gives WebView2 a durable profile, and storage_path
        # pins it to this app's own folder. Both are required: private_mode alone
        # falls back to a shared ~/AppData/pywebview profile, and storage_path
        # alone still runs the profile in memory. Together they are what makes
        # ui/app.js's Settings survive a relaunch. The UI is loaded from
        # file://, so every page on the machine shares one origin — the folder
        # has to be ours or another app's keys could mix with ours.
        webview.start(
            SMTC_BRIDGE.start,
            window,
            private_mode=False,
            storage_path=str(WEBVIEW_PROFILE_DIR),
        )
    except Exception as exc:
        print(
            "[Paprika Lyrics] The window failed to start. This usually means the "
            "Microsoft Edge WebView2 Runtime is missing.\n"
            "Download it from https://developer.microsoft.com/en-us/microsoft-edge/webview2/\n"
            f"Details: {exc}"
        )
        sys.exit(1)