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
except ImportError as exc:
    print(f"[Spicy Lyrics] Failed to load a core module: {exc}\n" + DEPENDENCY_HINT)
    sys.exit(1)

SHUTDOWN_SIGNAL = threading.Event()
SMTC_BRIDGE = SmtcBridge(SHUTDOWN_SIGNAL)
HOTKEY_MANAGER = None
WINDOW_REF = None
WINDOW_API_REF = None
CLICK_THROUGH_ENABLED = False

# Extended window styles used by click-through mode.
GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_LAYERED = 0x00080000


def _overlay_hwnd(window=None) -> int:
    """
    Resolves the overlay's native window handle. FindWindowW is declared with an
    explicit restype because the default c_int truncates a 64-bit HWND.
    """
    user32 = ctypes.windll.user32
    try:
        if window is not None and hasattr(window, 'native') and hasattr(window.native, 'Handle'):
            handle = int(window.native.Handle)
            if handle:
                return handle
    except Exception:
        pass
    try:
        user32.FindWindowW.restype = ctypes.c_void_p
        user32.FindWindowW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
        return int(user32.FindWindowW(None, 'Spicy Lyrics Overlay') or 0)
    except Exception:
        return 0

def apply_native_rounded_corners(window):
    """Enables Windows 11 native DWM rounded corners safely without DPI cropping."""
    try:
        hwnd = _overlay_hwnd(window)
        if hwnd:
            # DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2
            val = ctypes.c_int(2)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(
                hwnd, 33, ctypes.byref(val), ctypes.sizeof(val)
            )
    except Exception:
        pass

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

    def resize_window(self, width: int, height: int):
        try:
            w = max(320, min(1400, int(width)))
            h = max(380, min(1600, int(height)))
            self.window.resize(w, h)
        except Exception:
            pass

    def move_window(self, x: int, y: int):
        """Moves the window (used by edge-drag resizing that also moves the
        opposite edge, and by any future drag-handle paths)."""
        try:
            self.window.move(int(x), int(y))
        except Exception:
            pass

    def save_window_size(self, width: int, height: int):
        try:
            w = max(320, min(1400, int(width)))
            h = max(380, min(1600, int(height)))
            CACHE.save_window_size(w, h)
        except Exception:
            pass

    def toggle_fullscreen(self) -> bool:
        """
        Toggles fullscreen. The windowed geometry is saved first so leaving
        fullscreen restores exactly where the user was. Returns the new state,
        which the UI mirrors back for its layout scaling.
        """
        try:
            self._fullscreen = not getattr(self, '_fullscreen', False)
            if self._fullscreen:
                try:
                    self._saved_geometry = (self.window.x, self.window.y, self.window.width, self.window.height)
                except Exception:
                    self._saved_geometry = None
            self.window.toggle_fullscreen()
            return self._fullscreen
        except Exception as exc:
            print(f"[Spicy Lyrics] Fullscreen toggle failed: {exc}")
            return getattr(self, '_fullscreen', False)

    def _record_window_geometry(self):
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
        try:
            hwnd = _overlay_hwnd(self.window)
            if not hwnd:
                return

            user32 = ctypes.windll.user32
            get_long = user32.GetWindowLongPtrW
            set_long = user32.SetWindowLongPtrW
            get_long.restype = ctypes.c_longlong
            get_long.argtypes = [ctypes.c_void_p, ctypes.c_int]
            set_long.restype = ctypes.c_longlong
            set_long.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_longlong]

            ex_style = get_long(ctypes.c_void_p(hwnd), GWL_EXSTYLE)
            if enabled:
                new_style = ex_style | WS_EX_TRANSPARENT | WS_EX_LAYERED
            else:
                new_style = ex_style & ~WS_EX_TRANSPARENT
            set_long(ctypes.c_void_p(hwnd), GWL_EXSTYLE, new_style)
        except Exception as exc:
            print(f"[Spicy Lyrics] Could not change click-through state: {exc}")

    def set_always_on_top(self, enabled: bool):
        """
        Toggles always-on-top via Win32. pywebview exposes no runtime setter for
        on_top (assigning window.on_top is a no-op at best, and touching the
        events object here crashes), so go straight to SetWindowPos.
        """
        try:
            hwnd = _overlay_hwnd(self.window)
            if not hwnd:
                return
            HWND_TOPMOST = -1
            HWND_NOTOPMOST = -2
            SWP_NOMOVE = 0x0002
            SWP_NOSIZE = 0x0001
            ctypes.windll.user32.SetWindowPos(
                ctypes.c_void_p(hwnd),
                ctypes.c_void_p(HWND_TOPMOST if enabled else HWND_NOTOPMOST),
                0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE,
            )
        except Exception as exc:
            print(f"[Spicy Lyrics] Could not change always-on-top: {exc}")

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
        api.move_window,
        api.save_window_size,
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