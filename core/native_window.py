"""
Native window mutations for the Windows overlay, behind one injectable seam.

The overlay's window state is changed from several places — fullscreen,
always-on-top, click-through, rounded corners — and every one of them goes
through ctypes calls into user32/dwmapi. Spreading raw ctypes across modules
made the interaction between them invisible, and that interaction is exactly
where the fullscreen bug lived:

**Why fullscreen must not use WindowState = Maximized.** pywebview's WinForms
`toggle_fullscreen` enters fullscreen by setting `WindowState = Maximized` with
`FormBorderStyle = None` and bounds stretched over the monitor. Windows treats
a maximized window's bounds as derived state: anything that touches the native
window afterwards (SetWindowPos, a style change, certain focus transitions)
makes the form manager re-apply them from the *work area* — the monitor minus
the taskbar. The window then silently shrinks to work-area size while the UI
still believes it is fullscreen, which presented as "changing a setting breaks
fullscreen": with the taskbar auto-hidden, hovering the screen edge brought it
up over the no-longer-covering overlay.

The fix here is to drive fullscreen ourselves: `SetWindowPos` to the *monitor's*
full bounds while `WindowState` stays `Normal`. A normal-state window has no
derived bounds for Windows to re-apply, so later style mutations are inert. As
belt and braces, `reassert_fullscreen` re-applies the monitor bounds after any
mutation that could conceivably disturb them, and `is_covering_monitor` lets a
caller detect (and repair) a window that has lost its fullscreen geometry.

Every function takes the WinRT/webview window object (for `.native.Handle`)
plus an injectable `user32`/`dwmapi` — defaulting to the real ctypes DLLs — so
tests can drive the full logic against a fake without a display.
"""
from __future__ import annotations

import ctypes

# winuser constants (local so importing this module never needs pywin32).
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_NOOWNERZORDER = 0x0200
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
GWL_STYLE = -16
GWL_EXSTYLE = -20
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_POPUP = 0x80000000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_LAYERED = 0x00080000
MONITOR_DEFAULTTONEAREST = 2

# dwmapi
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 2
DWMWA_BORDER_COLOR = 34
DWMWA_COLOR_NONE = 0xFFFFFFFE
DWMWA_COLOR_DEFAULT = 0xFFFFFFFF

# The style bits a borderless fullscreen window must have cleared. WS_CAPTION
# adds a title bar; WS_THICKFRAME adds a resize border that also draws a 1px
# edge; the *BOX bits keep the system menu / min-max semantics alive, which a
# frameless overlay does not want while covering the screen.
FULLSCREEN_CLEAR_STYLE = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX


# Window resizing is anchored, and the anchor is chosen by *which edge the user
# grabbed*: dragging the west edge must keep the east edge still, and a corner
# drag must pin the opposite corner. pywebview's Window.resize already takes a
# fix_point and the winforms backend applies it in a single SetWindowPos
# (`x = x + Width - newWidth` for EAST, the same for SOUTH), so the whole
# anchored resize is one atomic native call. The alternative — dispatching a
# move plus a resize from JavaScript — was two async bridge calls with the move
# gated on a size threshold, and because the resize ran with the default
# NORTH|WEST fix the window always grew from its top-left corner.
#
# Keyed by resize-handle direction; the value lists the edges that must NOT
# move. 'e' keeps north+west, which for winforms means "do not touch x/y".
ANCHOR_EDGES = {
    "e": ("NORTH", "WEST"),
    "s": ("NORTH", "WEST"),
    "se": ("NORTH", "WEST"),
    "w": ("EAST",),
    "n": ("SOUTH",),
    "sw": ("NORTH", "EAST"),
    "ne": ("SOUTH", "WEST"),
    "nw": ("SOUTH", "EAST"),
}
DEFAULT_ANCHOR = "e"


def fix_point_for(anchor: str, fix_point):
    """
    The pywebview FixPoint flags that hold `anchor`'s opposite edge still.

    `fix_point` is passed in (it is `webview.window.FixPoint`) so this module
    stays free of pywebview imports and testable with plain-int fakes. An
    unknown/missing anchor falls back to 'e' — the common case, and the one
    whose behavior (grow toward the bottom-right) is what a plain resize does
    anyway.
    """
    edges = ANCHOR_EDGES.get(str(anchor or "").lower(), ANCHOR_EDGES[DEFAULT_ANCHOR])
    flags = None
    for name in edges:
        bit = getattr(fix_point, name)
        flags = bit if flags is None else (flags | bit)
    return flags


def _real_dlls():
    """The real Win32 DLLs, resolved lazily so import never touches ctypes.windll."""
    return ctypes.windll.user32, ctypes.windll.dwmapi


def _hwnd_of(window) -> int | None:
    """
    The native HWND for a pywebview window, or None when it cannot be found.

    Deliberately no FindWindowW fallback: a title-based search can find an
    unrelated (or a live) "Spicy Lyrics Overlay" window — e.g. while running
    the unit tests on the same machine — and mutate the wrong window. Callers
    that genuinely need the fallback keep it on their side of the seam.
    """
    try:
        if window is not None and hasattr(window, "native") and hasattr(window.native, "Handle"):
            handle = int(window.native.Handle)
            if handle:
                return handle
    except Exception:
        pass
    return None


def monitor_bounds(user32, hwnd: int) -> tuple[int, int, int, int] | None:
    """
    The full bounds (x, y, w, h) of the monitor the window is on — not the work
    area, which excludes the taskbar. Monitor-from-window + GetMonitorInfoW is
    the canonical pair; both are declared with explicit restypes/argtypes so
    64-bit handles and pointers survive the ctypes default truncation.
    """
    try:
        _declare(user32.MonitorFromWindow, ctypes.c_void_p, [ctypes.c_void_p, ctypes.c_uint])
        hmon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        if not hmon:
            return None

        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                        ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

        class MONITORINFO(ctypes.Structure):
            _fields_ = [("cbSize", ctypes.c_uint), ("rcMonitor", RECT),
                        ("rcWork", RECT), ("dwFlags", ctypes.c_uint)]

        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        _declare(user32.GetMonitorInfoW, None, [ctypes.c_void_p, ctypes.c_void_p])
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            return None
        rc = mi.rcMonitor
        return rc.left, rc.top, rc.right - rc.left, rc.bottom - rc.top
    except Exception:
        return None


def apply_fullscreen(window, user32=None) -> bool:
    """
    Cover the monitor completely, at normal window state.

    Entering: saves nothing — the caller owns geometry bookkeeping — clears the
    caption/thickframe style bits, and SetWindowPos to the monitor's full
    bounds. Leaving: restores the style bits and the geometry the caller hands
    back via `restore_geometry` (this function only clears the style; the
    caller re-applies its saved windowed rect). Returns True when the native
    calls succeeded.

    Because WindowState is never set to Maximized, Windows has no derived
    bounds to re-apply from the work area later — the property that made the
    taskbar cut into the overlay after any subsequent native mutation.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        style = _get_window_long(user32, hwnd, GWL_STYLE)
        _set_window_long(user32, hwnd, GWL_STYLE, style & ~FULLSCREEN_CLEAR_STYLE)
        bounds = monitor_bounds(user32, hwnd)
        if not bounds:
            return False
        return _set_bounds(user32, hwnd, bounds)
    except Exception:
        return False


def restore_windowed(window, rect: tuple[int, int, int, int] | None, user32=None) -> bool:
    """
    Leave fullscreen: put the border style bits back and re-apply the windowed
    rectangle the caller saved at fullscreen entry. `rect` is (x, y, w, h).
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        style = _get_window_long(user32, hwnd, GWL_STYLE)
        _set_window_long(user32, hwnd, GWL_STYLE, style | FULLSCREEN_CLEAR_STYLE)
        if rect:
            return _set_bounds(user32, hwnd, rect)
        return True
    except Exception:
        return False


def reassert_fullscreen(window, user32=None) -> bool:
    """
    Re-apply the monitor bounds for a window that should be fullscreen.

    Called after any native mutation (style change, SetWindowPos from
    always-on-top, etc.) as a defensive repair: if the window no longer covers
    its monitor, put it back. Returns True when the window is (now) covering.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    if is_covering_monitor(user32, hwnd):
        return True
    bounds = monitor_bounds(user32, hwnd)
    if not bounds:
        return False
    return _set_bounds(user32, hwnd, bounds)


def is_covering_monitor(user32, hwnd: int) -> bool:
    """True when the window's rect equals its monitor's full bounds."""
    try:
        bounds = monitor_bounds(user32, hwnd)

        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                        ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

        rect = RECT()
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
            return False
        if not bounds:
            return False
        x, y, w, h = bounds
        return (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top) == (x, y, w, h)
    except Exception:
        return False


def set_topmost(window, enabled: bool, user32=None) -> bool:
    """Always-on-top via SetWindowPos. Returns whether the call succeeded."""
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        _declare(user32.SetWindowPos, ctypes.c_int, [
            ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
        ])
        return bool(user32.SetWindowPos(
            hwnd, HWND_TOPMOST if enabled else HWND_NOTOPMOST,
            0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        ))
    except Exception:
        return False


def set_click_through(window, enabled: bool, user32=None) -> bool:
    """Toggles WS_EX_TRANSPARENT (with WS_EX_LAYERED, which it requires)."""
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
        _set_window_long(user32, hwnd, GWL_EXSTYLE, new)
        return True
    except Exception:
        return False


def apply_rounded_corners(window, dwmapi=None) -> bool:
    """Windows 11 native DWM rounded corners (DWMWCP_ROUND), border default."""
    dwmapi = dwmapi or ctypes.windll.dwmapi
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        val = ctypes.c_int(DWMWCP_ROUND)
        return bool(dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE,
            ctypes.byref(val), ctypes.sizeof(val)
        ))
    except Exception:
        return False


def _declare(func, restype=None, argtypes=None):
    """Set restype/argtypes on a DLL function, tolerating fakes without them."""
    try:
        if restype is not None:
            func.restype = restype
        if argtypes is not None:
            func.argtypes = argtypes
    except (AttributeError, TypeError):
        pass
    return func


def _get_window_long(user32, hwnd: int, index: int) -> int:
    # 64-bit processes need the PtrW variants; declare them once here.
    get_long = user32.GetWindowLongPtrW if hasattr(user32, "GetWindowLongPtrW") else user32.GetWindowLongW
    _declare(get_long, ctypes.c_longlong, [ctypes.c_void_p, ctypes.c_int])
    return int(get_long(hwnd, index))

# Values coming back from GetWindowLongPtrW are c_longlong; convert once so
# callers (and tests with plain-int fakes) always see Python ints.


def _set_window_long(user32, hwnd: int, index: int, value: int) -> None:
    set_long = user32.SetWindowLongPtrW if hasattr(user32, "SetWindowLongPtrW") else user32.SetWindowLongW
    _declare(set_long, ctypes.c_longlong, [ctypes.c_void_p, ctypes.c_int, ctypes.c_longlong])
    set_long(hwnd, index, int(value))



def _set_bounds(user32, hwnd: int, bounds: tuple[int, int, int, int]) -> bool:
    _declare(user32.SetWindowPos, ctypes.c_int, [
        ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
    ])
    x, y, w, h = bounds
    return bool(user32.SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE))
