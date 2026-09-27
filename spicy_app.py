import ctypes
import sys
import threading

DEPENDENCY_HINT = (
    "Missing a required dependency. Install everything with:\n"
    "    pip install -r requirements.txt"
)

try:
    import webview
except ImportError:
    print("[Spicy Lyrics] Could not import 'pywebview'.\n" + DEPENDENCY_HINT)
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
    )
    from storage import CACHE
    from core.lyrics import ASYNC_EXECUTOR
    from core.smtc import SmtcBridge
    from core.hotkeys import GlobalHotkeyManager
    from core import native_window
except ImportError as exc:
    print(f"[Spicy Lyrics] Failed to load a core module: {exc}\n" + DEPENDENCY_HINT)
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


def apply_native_rounded_corners(window):
    """Enables Windows 11 native DWM rounded corners safely without DPI cropping."""
    native_window.apply_rounded_corners(window)

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

HOTKEY_MANAGER = GlobalHotkeyManager(on_hotkey_adjust, on_hotkey_click_through)

class WindowApi:
    def __init__(self, window):
        self.window = window

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
                saved = CACHE.get_mini_size()
                w = int(saved.get('width') or MINI_SIZE[0])
                h = int(saved.get('height') or MINI_SIZE[1])
                w = max(MINI_MIN[0], min(MINI_MAX[0], w))
                h = max(MINI_MIN[1], min(MINI_MAX[1], h))
                self._mini = True
                self.window.resize(w, h, _DEFAULT_FIX_POINT)
            else:
                self._mini = False
                geometry = getattr(self, '_pre_mini_geometry', None)
                self._pre_mini_geometry = None
                if geometry:
                    x, y, w, h = geometry
                    self.window.move(x, y)
                    self.window.resize(
                        max(NORMAL_MIN[0], min(NORMAL_MAX[0], w)),
                        max(NORMAL_MIN[1], min(NORMAL_MAX[1], h)),
                        _DEFAULT_FIX_POINT,
                    )
        except Exception as exc:
            print(f"[Spicy Lyrics] Mini player toggle failed: {exc}")
            return getattr(self, '_mini', False)
        return self._mini

    def _current_geometry(self):
        try:
            return (self.window.x, self.window.y, self.window.width, self.window.height)
        except Exception:
            return None

    def toggle_fullscreen(self) -> bool:
        """
        Toggles fullscreen. The windowed geometry is saved first so leaving
        fullscreen restores exactly where the user was. Returns the new state,
        which the UI mirrors back for its layout scaling.

        Entry/exit go through pywebview's own toggle (it handles the style and
        DWM border attributes correctly). What this adds on top is a repair
        pass: pywebview enters fullscreen as a *maximized* borderless window,
        and Windows re-applies a maximized window's derived bounds from the
        *work area* whenever the window is later touched — SetWindowPos from
        always-on-top, an ex-style change from click-through. The overlay then
        silently shrank to taskbar-cut size while the UI still believed it was
        fullscreen. After every native mutation we therefore reapply the
        monitor bounds (see set_always_on_top / _apply_click_through).
        """
        try:
            self._fullscreen = not getattr(self, '_fullscreen', False)
            self.window.toggle_fullscreen()
            if self._fullscreen:
                try:
                    self._saved_geometry = (self.window.x, self.window.y, self.window.width, self.window.height)
                except Exception:
                    self._saved_geometry = None
                # Enter at true monitor bounds, not the maximized work area.
                native_window.reassert_fullscreen(self.window)
            else:
                self._saved_geometry = None
            return self._fullscreen
        except Exception as exc:
            print(f"[Spicy Lyrics] Fullscreen toggle failed: {exc}")
            return getattr(self, '_fullscreen', False)

    def _record_window_geometry(self):
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
                "[Spicy Lyrics] Click-through refused: Ctrl+Shift+T is not registered by "
                "this app, so it would be impossible to turn the mouse back on."
            )
            return False

        CLICK_THROUGH_ENABLED = enabled
        self._apply_click_through(enabled)
        return CLICK_THROUGH_ENABLED

    def _apply_click_through(self, enabled: bool):
        if native_window.set_click_through(self.window, enabled):
            # A style mutation can nudge a maximized/borderless window's derived
            # bounds back to the work area; if we were fullscreen, put the
            # monitor coverage back immediately.
            if getattr(self, '_fullscreen', False):
                native_window.reassert_fullscreen(self.window)
        else:
            print("[Spicy Lyrics] Could not change click-through state.")

    def set_always_on_top(self, enabled: bool):
        """
        Toggles always-on-top via Win32. pywebview exposes no runtime setter for
        on_top (assigning window.on_top is a no-op at best, and touching the
        events object here crashes), so go straight to SetWindowPos.

        A SetWindowPos against a maximized fullscreen window makes Windows
        re-derive its bounds from the work area — the fullscreen-breaking bug —
        so the monitor bounds are reasserted right after when fullscreen is on.
        """
        if native_window.set_topmost(self.window, enabled):
            if getattr(self, '_fullscreen', False):
                native_window.reassert_fullscreen(self.window)
        else:
            print("[Spicy Lyrics] Could not change always-on-top.")

    def get_hotkey_binding(self) -> dict:
        """
        Reports which system-wide shortcuts actually bound. The UI uses this to
        decide whether it should also handle Ctrl+[ / Ctrl+] itself: while the
        global hotkey is live, in-window handling would apply every nudge twice.
        """
        return {
            "sync": bool(HOTKEY_MANAGER.sync_bound),
            "click_through": bool(HOTKEY_MANAGER.click_through_bound),
        }

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
        print(f"[Spicy Lyrics] Purged {purged} outdated cached lyric payload(s).")

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
        title='Spicy Lyrics Overlay',
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
        api.get_hotkey_binding
    )

    def on_shown():
        apply_native_rounded_corners(window)

    def on_closed():
        SHUTDOWN_SIGNAL.set()
        HOTKEY_MANAGER.stop()
        api._record_window_geometry()
        CACHE.flush()
        ASYNC_EXECUTOR.shutdown(wait=False)

    window.events.shown += on_shown
    window.events.closed += on_closed
    HOTKEY_MANAGER.start()
    try:
        webview.start(SMTC_BRIDGE.start, window)
    except Exception as exc:
        print(
            "[Spicy Lyrics] The window failed to start. This usually means the "
            "Microsoft Edge WebView2 Runtime is missing.\n"
            "Download it from https://developer.microsoft.com/en-us/microsoft-edge/webview2/\n"
            f"Details: {exc}"
        )
        sys.exit(1)