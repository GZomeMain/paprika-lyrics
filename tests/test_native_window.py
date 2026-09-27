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

    def SetWindowLongPtrW(self, hwnd, index, value):
        self.calls.append(("SetWindowLongPtrW", hwnd, index, int(value)))
        self.styles["style" if index == nw.GWL_STYLE else "ex"] = int(value)
        return int(value)

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


class FakeWindow:
    class _Native:
        Handle = 0x140000
    native = _Native()


def _rect_fields(t):
    return t[0], t[1], t[0] + t[2], t[1] + t[3]


def nw_normalize(t):
    """(x, y, w, h) -> internal [x, y, w, h] list for FakeUser32.rect."""
    return [t[0], t[1], t[2], t[3]]


class ApplyFullscreenTest(unittest.TestCase):
    def test_fullscreen_sets_monitor_bounds_at_normal_state(self):
        u = FakeUser32()
        self.assertTrue(nw.apply_fullscreen(FakeWindow(), user32=u))
        self.assertTrue(u.has_monitor_bounds())
        self.assertFalse(u.has_work_area_bounds())
        # The style bits that draw a frame must be cleared.
        self.assertEqual(u.styles["style"] & nw.FULLSCREEN_CLEAR_STYLE, 0)

    def test_restore_windowed_puts_back_style_and_rect(self):
        u = FakeUser32()
        nw.apply_fullscreen(FakeWindow(), user32=u)
        rect = (100, 100, 800, 600)
        self.assertTrue(nw.restore_windowed(FakeWindow(), rect, user32=u))
        self.assertEqual(u.pos, rect)
        self.assertNotEqual(u.styles["style"] & nw.FULLSCREEN_CLEAR_STYLE, 0)

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


class FailurePathsTest(unittest.TestCase):
    def test_no_hwnd_returns_false_everywhere(self):
        class NoHandle:
            pass
        u = FakeUser32()
        self.assertFalse(nw.apply_fullscreen(NoHandle(), user32=u))
        self.assertFalse(nw.restore_windowed(NoHandle(), None, user32=u))
        self.assertFalse(nw.reassert_fullscreen(NoHandle(), user32=u))
        self.assertFalse(nw.set_topmost(NoHandle(), True, user32=u))
        self.assertFalse(nw.set_click_through(NoHandle(), True, user32=u))

    def test_monitor_query_failure_fails_cleanly(self):
        u = FakeUser32()
        u.MonitorFromWindow = lambda *a: 0
        self.assertFalse(nw.apply_fullscreen(FakeWindow(), user32=u))

    def test_missing_handle_attribute_is_tolerated(self):
        class Weird:
            native = object()
        u = FakeUser32()
        self.assertFalse(nw.apply_fullscreen(Weird(), user32=u))


if __name__ == "__main__":
    unittest.main()
