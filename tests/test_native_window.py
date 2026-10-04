import ctypes
import unittest

from core import native_window as nw


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("rcMonitor", RECT),
                ("rcWork", RECT), ("dwFlags", ctypes.c_uint)]


class FakeUser32:
    """
    Records the Win32 calls the helpers make, over a small virtual desktop.

    Monitor: 1920x1080 at (0,0); work area excludes a 48px taskbar — which is
    exactly the distinction the fullscreen fix turns on. The window starts at
    (100,100) sized 800x600.
    """

    MONITOR = (0, 0, 1920, 1080)
    WORK = (0, 0, 1920, 1032)

    def __init__(self):
        self.hwnd = 0x140000
        self.rect = list(nw_normalize((100, 100, 800, 600)))
        self.styles = {"style": nw.WS_CAPTION | nw.WS_THICKFRAME | 0x10000000, "ex": 0}
        self.calls = []
        self.topmost = False
        self.pos = (100, 100, 800, 600)
        self.alpha_calls = []
        self.window_commands = []
        # A pointer at the middle of the window, and a scripted path the move loop
        # can walk through; `button_polls` is how many times the button still
        # reads as held.
        self.cursor = (500, 400)
        self.cursor_path = []
        self.button_polls = 0
        self.capture = 0

    # --- Win32 surface used by core.native_window -------------------------
    def MonitorFromWindow(self, hwnd, flags):
        self.calls.append(("MonitorFromWindow", hwnd, flags))
        return 0x90000  # fake HMONITOR

    def GetMonitorInfoW(self, hmon, ptr):
        mi = ctypes.cast(ptr, ctypes.POINTER(MONITORINFO)).contents
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        mi.rcMonitor = RECT(*_rect_fields(self.MONITOR))
        mi.rcWork = RECT(*_rect_fields(self.WORK))
        self.calls.append(("GetMonitorInfoW", hmon))
        return 1

    def GetWindowRect(self, hwnd, ptr):
        r = ctypes.cast(ptr, ctypes.POINTER(RECT)).contents
        r.left, r.top = self.rect[0], self.rect[1]
        r.right, r.bottom = self.rect[0] + self.rect[2], self.rect[1] + self.rect[3]
        self.calls.append(("GetWindowRect", hwnd))
        return 1

    def GetWindowLongPtrW(self, hwnd, index):
        self.calls.append(("GetWindowLongPtrW", hwnd, index))
        return int(self.styles["style" if index == nw.GWL_STYLE else "ex"])

    def GetCursorPos(self, ptr):
        # A scripted path lets a test walk the pointer across the move loop; a
        # path that runs out keeps answering with the last point.
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
            return -32768        # the high bit is what "held" means
        return 0

    def GetCapture(self):
        self.calls.append(("GetCapture",))
        return self.capture

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

    def SetWindowLongPtrW(self, hwnd, index, value):
        self.calls.append(("SetWindowLongPtrW", hwnd, index, int(value)))
        self.styles["style" if index == nw.GWL_STYLE else "ex"] = int(value)
        return int(value)

    def SetLayeredWindowAttributes(self, hwnd, color, alpha, flags):
        # `alpha` arrives as a c_ubyte (the helpers declare the argtypes on the
        # real DLL, but a fake keeps whatever it was handed), so read its value.
        value = int(getattr(alpha, "value", alpha))
        self.alpha_calls.append((value, flags))
        self.calls.append(("SetLayeredWindowAttributes", value, flags))
        return 1

    def SetWindowPos(self, hwnd, after, x, y, w, h, flags):
        self.calls.append(("SetWindowPos", hwnd, after, x, y, w, h, flags))
        if not (flags & nw.SWP_NOSIZE) or not (flags & nw.SWP_NOMOVE):
            self.pos = (x, y, w, h)
            self.rect = [x, y, w, h]
        if after == nw.HWND_TOPMOST:
            self.topmost = True
        elif after == nw.HWND_NOTOPMOST:
            self.topmost = False
        return 1

    # --- test helpers ------------------------------------------------------
    def last(self, name):
        for call in reversed(self.calls):
            if call[0] == name:
                return call
        return None

    def has_work_area_bounds(self):
        return self.pos == self.WORK

    def has_monitor_bounds(self):
        return self.pos == self.MONITOR


class IntPtrHandle:
    """A .NET-shaped handle: refuses int(), answers ToInt64/ToInt32.

    The real BrowserForm.Handle is a System.IntPtr, and int() on one is a
    TypeError on current runtimes — the shape that used to make every handle
    lookup return None and silently kill always-on-top and click-through.
    """

    def __init__(self, value):
        self._value = value

    def ToInt64(self):
        return self._value

    def ToInt32(self):
        return self._value


class FakeWindow:
    class _Native:
        Handle = 0x140000
    native = _Native()


class FakeWindowDotNet:
    """FakeWindow, but with the real .NET IntPtr shape for the Handle."""

    class _Native:
        Handle = IntPtrHandle(0x150000)
    native = _Native()


def _rect_fields(t):
    return t[0], t[1], t[0] + t[2], t[1] + t[3]


def nw_normalize(t):
    """(x, y, w, h) -> internal [x, y, w, h] list for FakeUser32.rect."""
    return [t[0], t[1], t[2], t[3]]


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
        # Leaving fullscreen must not bring the 1px border back: the app has no
        # outline in either state.
        self.assertEqual(d.calls[-1],
                         (nw.DWMWA_BORDER_COLOR, ctypes.c_int(nw.DWMWA_COLOR_NONE).value))

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
        # Windows re-applied derived bounds from the work area (the bug).
        u.pos = list(u.WORK)
        u.rect = list(u.WORK)
        self.assertTrue(nw.reassert_fullscreen(FakeWindow(), user32=u))
        self.assertTrue(u.has_monitor_bounds())

    def test_reassert_is_a_noop_when_still_covering(self):
        u = FakeUser32()
        nw.apply_fullscreen(FakeWindow(), user32=u)
        setpos_calls = sum(1 for c in u.calls if c[0] == "SetWindowPos")
        self.assertTrue(nw.reassert_fullscreen(FakeWindow(), user32=u))
        after = sum(1 for c in u.calls if c[0] == "SetWindowPos")
        # Still covering: the reassert must not have issued a second SetWindowPos.
        self.assertEqual(after, setpos_calls)
        self.assertTrue(u.has_monitor_bounds())

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


class FakeDwmapi:
    """Records DWM attribute writes so the fullscreen frame can be asserted."""

    def __init__(self):
        self.calls = []

    def DwmSetWindowAttribute(self, hwnd, attribute, ptr, size):
        value = ctypes.cast(ptr, ctypes.POINTER(ctypes.c_int)).contents.value
        self.calls.append((attribute, value))
        return 0


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


class FixPointTest(unittest.TestCase):
    """
    Resize anchoring: dragging an edge must hold the opposite one still.

    FixPoint is faked as plain ints so the mapping can be asserted without
    pywebview, and the assertions are written in terms of the edges that end up
    held rather than the flag arithmetic that produces them.
    """

    class FakeFixPoint:
        NORTH = 1
        WEST = 2
        EAST = 4
        SOUTH = 8

    def _held(self, anchor):
        flags = nw.fix_point_for(anchor, self.FakeFixPoint)
        return {name for name in ("NORTH", "WEST", "EAST", "SOUTH")
                if flags & getattr(self.FakeFixPoint, name)}

    def test_right_and_bottom_edges_grow_from_the_top_left(self):
        for anchor in ("e", "s", "se"):
            with self.subTest(anchor=anchor):
                self.assertEqual(self._held(anchor), {"NORTH", "WEST"})

    def test_west_edge_holds_the_east_edge(self):
        held = self._held("w")
        self.assertIn("EAST", held)
        self.assertNotIn("SOUTH", held)   # width only: the height must not move

    def test_north_edge_holds_the_south_edge(self):
        held = self._held("n")
        self.assertIn("SOUTH", held)
        self.assertNotIn("EAST", held)

    def test_each_corner_pins_the_opposite_corner(self):
        self.assertEqual(self._held("nw"), {"SOUTH", "EAST"})
        self.assertEqual(self._held("ne"), {"SOUTH", "WEST"})
        self.assertEqual(self._held("sw"), {"NORTH", "EAST"})

    def test_unknown_or_missing_anchor_falls_back_to_east(self):
        fallback = self._held("e")
        for anchor in (None, "", "sideways", "E"):
            with self.subTest(anchor=anchor):
                self.assertEqual(self._held(anchor), fallback)

    def test_mapping_covers_every_handle_direction(self):
        self.assertEqual(set(nw.ANCHOR_EDGES), {"e", "w", "n", "s", "ne", "nw", "se", "sw"})


class TopmostAndClickThroughTest(unittest.TestCase):
    def test_set_topmost_true_then_false(self):
        u = FakeUser32()
        self.assertTrue(nw.set_topmost(FakeWindow(), True, user32=u))
        self.assertTrue(u.topmost)
        self.assertTrue(nw.set_topmost(FakeWindow(), False, user32=u))
        self.assertFalse(u.topmost)

    def test_a_dotnet_intptr_handle_still_resolves(self):
        """The regression: int(IntPtr) raises, so nothing ever got an hwnd."""
        self.assertEqual(nw._hwnd_of(FakeWindowDotNet()), 0x150000)
        u = FakeUser32()
        self.assertTrue(nw.set_topmost(FakeWindowDotNet(), True, user32=u))
        self.assertTrue(u.topmost)
        self.assertTrue(nw.set_click_through(FakeWindowDotNet(), True, user32=u))
        self.assertEqual(u.styles["ex"] & nw.WS_EX_TRANSPARENT, nw.WS_EX_TRANSPARENT)

    def test_topmost_setwindowpos_keeps_size_and_position(self):
        u = FakeUser32()
        nw.set_topmost(FakeWindow(), True, user32=u)
        call = u.last("SetWindowPos")
        self.assertTrue(call[7] & nw.SWP_NOMOVE and call[7] & nw.SWP_NOSIZE)

    def test_click_through_toggles_transparent_ex_style(self):
        u = FakeUser32()
        self.assertTrue(nw.set_click_through(FakeWindow(), True, user32=u))
        self.assertEqual(u.styles["ex"] & nw.WS_EX_TRANSPARENT, nw.WS_EX_TRANSPARENT)
        self.assertTrue(u.styles["ex"] & nw.WS_EX_LAYERED)
        self.assertTrue(nw.set_click_through(FakeWindow(), False, user32=u))
        self.assertEqual(u.styles["ex"] & nw.WS_EX_TRANSPARENT, 0)


class WindowAlphaTest(unittest.TestCase):
    """`set_window_alpha` fades the whole window by making it a layered one."""

    def test_the_alpha_is_written_as_a_byte(self):
        u = FakeUser32()
        self.assertTrue(nw.set_window_alpha(FakeWindow(), 0.25, user32=u))
        self.assertEqual(u.alpha_calls[-1], (64, nw.LWA_ALPHA))

    def test_opaque_and_clear_are_the_ends_of_the_range(self):
        u = FakeUser32()
        nw.set_window_alpha(FakeWindow(), 1.0, user32=u)
        self.assertEqual(u.alpha_calls[-1][0], 255)
        nw.set_window_alpha(FakeWindow(), 0.0, user32=u)
        self.assertEqual(u.alpha_calls[-1][0], 0)

    def test_out_of_range_values_are_clamped(self):
        u = FakeUser32()
        nw.set_window_alpha(FakeWindow(), 4, user32=u)
        self.assertEqual(u.alpha_calls[-1][0], 255)
        nw.set_window_alpha(FakeWindow(), -3, user32=u)
        self.assertEqual(u.alpha_calls[-1][0], 0)

    def test_the_layered_bit_is_added_once_and_kept(self):
        u = FakeUser32()
        nw.set_window_alpha(FakeWindow(), 0.8, user32=u)
        self.assertTrue(u.styles["ex"] & nw.WS_EX_LAYERED)
        writes = sum(1 for c in u.calls if c[0] == "SetWindowLongPtrW")
        nw.set_window_alpha(FakeWindow(), 0.5, user32=u)
        self.assertEqual(sum(1 for c in u.calls if c[0] == "SetWindowLongPtrW"), writes)

    def test_the_alpha_survives_leaving_click_through(self):
        # Both features need WS_EX_LAYERED, so turning click-through off must not
        # take the window's transparency with it.
        u = FakeUser32()
        nw.set_window_alpha(FakeWindow(), 0.7, user32=u)
        nw.set_click_through(FakeWindow(), True, user32=u)
        nw.set_click_through(FakeWindow(), False, user32=u)
        self.assertTrue(u.styles["ex"] & nw.WS_EX_LAYERED)
        self.assertEqual(u.styles["ex"] & nw.WS_EX_TRANSPARENT, 0)

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
        self.assertEqual(u.alpha_calls[-1], (178, nw.LWA_ALPHA))


class FollowDragTest(unittest.TestCase):
    """The host's own move: the gesture Windows' loop can refuse to take."""

    def test_the_window_follows_the_pointer_until_the_button_comes_up(self):
        u = FakeUser32()                    # window at (100,100), cursor at (500,400)
        u.cursor_path = [(500, 400), (520, 420), (560, 460)]
        u.button_polls = 2                  # two polls of movement, then released
        self.assertTrue(nw.follow_drag(FakeWindow(), user32=u, sleep=lambda _s: None))
        # The grab offset is kept: +60,+60 on the last polled pointer position.
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
    """The capture is how a posted gesture is known to have been taken."""

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


class CursorOverWindowTest(unittest.TestCase):
    """The pointer question a click-through window cannot ask the page."""

    def test_a_pointer_inside_the_window_rect_counts(self):
        u = FakeUser32()                    # window spans (100,100)-(900,700)
        u.cursor = (500, 400)
        self.assertTrue(nw.cursor_over_window(FakeWindow(), user32=u))
        u.cursor = (899, 699)
        self.assertTrue(nw.cursor_over_window(FakeWindow(), user32=u))

    def test_a_pointer_outside_is_outside(self):
        u = FakeUser32()
        for point in ((99, 400), (900, 400), (500, 99), (500, 700)):
            u.cursor = point
            self.assertFalse(nw.cursor_over_window(FakeWindow(), user32=u))

    def test_no_handle_is_never_over_the_window(self):
        class NoHandle:
            pass
        self.assertFalse(nw.cursor_over_window(NoHandle(), user32=FakeUser32()))


class FailurePathsTest(unittest.TestCase):
    def test_no_hwnd_returns_false_everywhere(self):
        class NoHandle:
            pass
        u = FakeUser32()
        self.assertIsNone(nw.apply_fullscreen(NoHandle(), user32=u))
        self.assertFalse(nw.restore_windowed(NoHandle(), None, user32=u))
        self.assertFalse(nw.reassert_fullscreen(NoHandle(), user32=u))
        self.assertFalse(nw.set_topmost(NoHandle(), True, user32=u))
        self.assertFalse(nw.set_click_through(NoHandle(), True, user32=u))
        self.assertFalse(nw.set_window_alpha(NoHandle(), 0.5, user32=u))
        self.assertFalse(nw.begin_drag(NoHandle(), user32=u))
        self.assertFalse(nw.drag_handed_off(NoHandle(), user32=u))
        self.assertFalse(nw.cursor_over_window(NoHandle(), user32=u))

    def test_monitor_query_failure_fails_cleanly(self):
        u = FakeUser32()
        u.MonitorFromWindow = lambda *a: 0
        self.assertIsNone(nw.apply_fullscreen(FakeWindow(), user32=u))

    def test_missing_handle_attribute_is_tolerated(self):
        class Weird:
            native = object()
        u = FakeUser32()
        self.assertIsNone(nw.apply_fullscreen(Weird(), user32=u))


if __name__ == "__main__":
    unittest.main()
