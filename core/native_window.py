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
`apply_fullscreen` is what `paprika_app.WindowApi.toggle_fullscreen` calls —
pywebview's own toggle is deliberately unused — and it is a whole gesture rather
than a rectangle: it leaves the maximized state first, swaps the frame bits for
`WS_POPUP`, lands the change with `SWP_FRAMECHANGED`, drops DWM's rounded corners
and border, and returns the window's previous style so `restore_windowed` can put
the window back exactly as it was.

The same treatment went to the window move. pywebview dragged the window from
JavaScript (a body-level walk-up over marked ancestors plus a bridge message per
mousemove), which could not see the page's `no-drag` opt-outs: a mousedown onthe overlay's seek bar moved the window instead of seeking. `begin_drag` hands the
gesture to DefWindowProc's own modal move loop instead, which is where Aero Snap,
per-monitor DPI and drag-to-restore come from — and because that loop only runs
if it gets the mouse capture, which WebView2 holds while the page has the button
down, the host also has its own move (`follow_drag`) for when the loop never
takes over: `drag_handed_off` is how a caller tells the two apart.

Every function takes the WinRT/webview window object (for `.native.Handle`)
plus an injectable `user32`/`dwmapi` — defaulting to the real ctypes DLLs — so
tests can drive the full logic against a fake without a display.
"""
from __future__ import annotations

import ctypes
import time

# winuser constants (local so importing this module never needs pywin32).
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOZORDER = 0x0004
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
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
# SetLayeredWindowAttributes flags: apply the alpha byte to the whole window.
LWA_ALPHA = 0x00000002
MONITOR_DEFAULTTONEAREST = 2
# ShowWindow commands. SW_RESTORE is how a window leaves the maximized state.
SW_RESTORE = 9

# A window move, handed to Windows rather than driven from the page: DefWindowProc
# answers WM_NCLBUTTONDOWN with HTCAPTION by taking capture and running its own
# modal move loop.
WM_NCLBUTTONDOWN = 0x00A1
HTCAPTION = 2

# The host-driven half of the same gesture: how often the pointer is read while
# the button is held, and the longest one gesture may run before it is abandoned.
VK_LBUTTON = 0x01
DRAG_POLL_SECONDS = 0.008
DRAG_MAX_SECONDS = 120


class POINT(ctypes.Structure):
    """GetCursorPos writes a POINT; named here so tests can fill one in."""
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]

# dwmapi
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 2
DWMWCP_DONOTROUND = 1
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

    `window.native.Handle` is a System.IntPtr (pythonnet), and `int()` on an
    IntPtr is a TypeError on current .NET runtimes — pywebview itself converts
    with `.ToInt32()` for the same reason. The int() is still tried first (some
    backends expose a plain Python int) with ToInt64/ToInt32 as the fallbacks,
    and any failure returns None: a lost handle must disable the mutation, not
    pick a target by window title.

    Deliberately no FindWindowW fallback: a title-based search can find an
    unrelated (or a live) "Paprika Lyrics" window — e.g. while running
    the unit tests on the same machine — and mutate the wrong window. Callers
    that genuinely need the fallback keep it on their side of the seam.
    """
    try:
        if window is not None and hasattr(window, "native") and hasattr(window.native, "Handle"):
            handle = window.native.Handle
            for name in ("__int__", "ToInt64", "ToInt32"):
                method = getattr(handle, name, None)
                if method is None:
                    continue
                try:
                    value = method()
                except Exception:
                    continue
                if value:
                    return int(value)
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

    Geometry bookkeeping stays with the caller (it owns the windowed rect it
    wants back); this returns only the native state that has to be restored.
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
    # Re-clear the frame bits as well: a style-mutating call (an ex-style change,
    # another SetWindowPos) can bring a frame back, and a framed window can no
    # longer cover the monitor cleanly.
    style = _get_window_long(user32, hwnd, GWL_STYLE)
    _set_window_long(user32, hwnd, GWL_STYLE, (style | WS_POPUP) & ~FULLSCREEN_CLEAR_STYLE)
    return _set_bounds(user32, hwnd, bounds, SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE)


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


def set_window_alpha(window, alpha: float, user32=None) -> bool:
    """
    Uniform window transparency (1.0 = fully opaque). Returns success.

    A layered window is the only way to fade the *whole* surface: the overlay's
    own background is opaque, so dimming the web content alone would leave a
    black slab behind it. With LWA_ALPHA the window — WebView2 content, glass and
    background together — reads as one translucent pane, which is what a lyrics
    overlay wants when the pointer is over it. Clicking, dragging and the DWM
    rounded corners are unaffected: the window still hit-tests normally.

    WS_EX_LAYERED is the same bit click-through uses (it is required by
    WS_EX_TRANSPARENT), so the two features compose: leaving click-through only
    clears the transparent bit and this alpha survives.
    """
    user32 = user32 or ctypes.windll.user32
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    try:
        clamped = max(0.0, min(1.0, float(alpha)))
        byte = int(round(clamped * 255.0))
        ex = _get_window_long(user32, hwnd, GWL_EXSTYLE)
        if not (ex & WS_EX_LAYERED):
            _set_window_long(user32, hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED)
        return _set_layered_alpha(user32, hwnd, byte)
    except Exception:
        return False


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

    It is only half of the move, though, which is why it reports whether the post
    landed instead of pretending the gesture happened: that modal loop needs the
    mouse capture, and while the page has the button down the capture belongs to
    WebView2's child window. Callers check that the loop took over
    (drag_handed_off) and drive the move themselves (follow_drag) when it did not.
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


def _read_window_rect(user32, hwnd: int) -> tuple[int, int, int, int] | None:
    """GetWindowRect as (x, y, width, height), or None when it cannot be read."""
    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    try:
        rect = RECT()
        _declare(user32.GetWindowRect, ctypes.c_int, [ctypes.c_void_p, ctypes.c_void_p])
        if not user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(rect)):
            return None
        return (int(rect.left), int(rect.top),
                int(rect.right - rect.left), int(rect.bottom - rect.top))
    except Exception:
        return None


def _window_origin(user32, hwnd: int) -> tuple[int, int] | None:
    """The window's top-left corner in screen coordinates."""
    rect = _read_window_rect(user32, hwnd)
    return None if rect is None else (rect[0], rect[1])


def _window_size(user32, hwnd: int) -> tuple[int, int] | None:
    """The window's size in screen pixels (right/bottom are exclusive edges)."""
    rect = _read_window_rect(user32, hwnd)
    return None if rect is None else (rect[2], rect[3])


def _left_button_down(user32) -> bool:
    """Whether the primary mouse button is held, with no window proc involved."""
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
    the cursor, and a drag handed over mid-gesture continues instead of jumping.

    Coordinates are read with GetCursorPos/GetWindowRect and written with
    SetWindowPos — all screen pixels for this process, so a scaled display needs
    no conversion here. `sleep` and `clock` are injectable so the seam is testable
    without a real pointer or a real wall clock, and the deadline keeps a lost
    button-up from leaving the loop running forever. Returns whether the window
    was moved at all.
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
    size = _window_size(user32, hwnd)
    if point is None or origin is None or size is None:
        return False
    return (origin[0] <= point[0] < origin[0] + size[0]
            and origin[1] <= point[1] < origin[1] + size[1])


def apply_window_frame(window, dwmapi=None) -> bool:
    """
    The windowed frame: rounded corners, no border.

    DWMWA_BORDER_COLOR is the 1px line Windows 11 draws around a window, and a
    frameless lyrics overlay has no business being outlined in anything — with it
    on, the app reads as a rectangle sitting on the desktop instead of a surface
    floating over it. The rounded corners are the one frame feature worth keeping,
    so this is the fullscreen frame helper in its windowed state rather than a
    second definition of the same two attributes (see _set_dwm_frame).
    """
    hwnd = _hwnd_of(window)
    if not hwnd:
        return False
    _set_dwm_frame(dwmapi, hwnd, False)
    return True


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
    # Values come back as c_longlong; convert once so callers (and tests with
    # plain-int fakes) always see Python ints.
    return int(get_long(hwnd, index))


def _set_window_long(user32, hwnd: int, index: int, value: int) -> None:
    set_long = user32.SetWindowLongPtrW if hasattr(user32, "SetWindowLongPtrW") else user32.SetWindowLongW
    _declare(set_long, ctypes.c_longlong, [ctypes.c_void_p, ctypes.c_int, ctypes.c_longlong])
    set_long(hwnd, index, int(value))


def _set_layered_alpha(user32, hwnd: int, byte: int) -> bool:
    """The one place LWA_ALPHA is written, so the two users agree on the byte."""
    _declare(user32.SetLayeredWindowAttributes, ctypes.c_int,
             [ctypes.c_void_p, ctypes.c_uint, ctypes.c_ubyte, ctypes.c_uint])
    return bool(user32.SetLayeredWindowAttributes(
        ctypes.c_void_p(hwnd), 0, ctypes.c_ubyte(max(0, min(255, int(byte)))), LWA_ALPHA))


def _show_window(user32, hwnd: int, command: int) -> bool:
    _declare(user32.ShowWindow, ctypes.c_int, [ctypes.c_void_p, ctypes.c_int])
    return bool(user32.ShowWindow(hwnd, command))


def _set_dwm_frame(dwmapi, hwnd: int, fullscreen: bool) -> None:
    """
    Turns DWM's rounded corners off for fullscreen and back on for windowed, and
    keeps the 1px border off in both states. A rounded overlay covering a whole
    monitor shows four desktop wedges in the corners; the border draws a light
    line around a window that is meant to have no edge at all.
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
        border = ctypes.c_int(DWMWA_COLOR_NONE)
        dwmapi.DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR,
                                     ctypes.byref(border), ctypes.sizeof(border))
    except Exception:
        pass


def _set_bounds(user32, hwnd: int, bounds: tuple[int, int, int, int],
                flags: int = None) -> bool:
    _declare(user32.SetWindowPos, ctypes.c_int, [
        ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
    ])
    if flags is None:
        flags = SWP_NOZORDER | SWP_NOACTIVATE
    x, y, w, h = bounds
    return bool(user32.SetWindowPos(hwnd, None, x, y, w, h, flags))
