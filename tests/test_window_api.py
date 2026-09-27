import unittest
from unittest import mock

import spicy_app

try:
    import webview  # noqa: F401
    HAS_PYWEBVIEW = True
except ImportError:  # pragma: no cover - the test below is skipped without it
    HAS_PYWEBVIEW = False


class FakeWindow:
    """Records geometry mutations the way pywebview's Window would apply them."""

    def __init__(self, x=200, y=150, width=980, height=700):
        self.x, self.y, self.width, self.height = x, y, width, height
        self.resizes = []
        self.moves = []
        self.toggles = 0
        self.destroyed = False

    def resize(self, width, height, fix_point=None):
        self.resizes.append((width, height, fix_point))
        self.width, self.height = width, height

    def move(self, x, y):
        self.moves.append((x, y))
        self.x, self.y = x, y

    def toggle_fullscreen(self):
        self.toggles += 1

    def destroy(self):
        self.destroyed = True

    def minimize(self):
        pass


class FakeCache:
    def __init__(self, mini=None):
        self.mini = dict(mini or {})
        self.sizes = []
        self.positions = []

    def get_mini_size(self):
        return dict(self.mini)

    def save_mini_size(self, width, height):
        self.mini = {"width": width, "height": height}

    def save_window_size(self, width, height):
        self.sizes.append((width, height))

    def save_window_position(self, x, y):
        self.positions.append((x, y))


@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class MiniModeTest(unittest.TestCase):
    def setUp(self):
        self.window = FakeWindow()
        self.cache = FakeCache()
        self.api = spicy_app.WindowApi(self.window)
        patcher = mock.patch.object(spicy_app, "CACHE", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_entering_mini_shrinks_to_the_default_and_remembers_the_old_size(self):
        self.assertTrue(self.api.set_mini_mode(True))
        self.assertEqual((self.window.width, self.window.height), spicy_app.MINI_SIZE)
        self.assertEqual(self.api._pre_mini_geometry, (200, 150, 980, 700))

    def test_leaving_mini_restores_the_geometry_it_came_from(self):
        self.api.set_mini_mode(True)
        self.assertFalse(self.api.set_mini_mode(False))
        self.assertEqual((self.window.x, self.window.y), (200, 150))
        self.assertEqual((self.window.width, self.window.height), (980, 700))
        self.assertIsNone(self.api._pre_mini_geometry)

    def test_the_remembered_mini_size_is_reused_and_clamped(self):
        self.cache.mini = {"width": 5000, "height": 5000}
        self.api.set_mini_mode(True)
        self.assertEqual((self.window.width, self.window.height), spicy_app.MINI_MAX)

    def test_mini_exits_fullscreen_first(self):
        self.api._fullscreen = True
        with mock.patch.object(self.api, "toggle_fullscreen") as toggle:
            self.api.set_mini_mode(True)
        toggle.assert_called_once()

    def test_windowed_entry_does_not_touch_fullscreen(self):
        with mock.patch.object(self.api, "toggle_fullscreen") as toggle:
            self.api.set_mini_mode(True)
        toggle.assert_not_called()

    def test_toggling_to_the_state_it_is_already_in_is_a_noop(self):
        self.assertFalse(self.api.set_mini_mode(False))
        self.assertEqual(self.window.resizes, [])

    def test_resize_clamp_follows_the_mode(self):
        self.api.resize_window(2000, 2000, "e")
        self.assertEqual((self.window.width, self.window.height), spicy_app.NORMAL_MAX)
        self.api.set_mini_mode(True)
        self.api.resize_window(2000, 2000, "e")
        self.assertEqual((self.window.width, self.window.height), spicy_app.MINI_MAX)

    def test_resize_below_the_floor_is_clamped_for_both_modes(self):
        self.api.resize_window(100, 100, "w")
        self.assertEqual((self.window.width, self.window.height), spicy_app.NORMAL_MIN)
        self.api.set_mini_mode(True)
        self.api.resize_window(100, 100, "w")
        self.assertEqual((self.window.width, self.window.height), spicy_app.MINI_MIN)

    def test_resize_passes_the_anchor_through_as_a_fix_point(self):
        self.api.resize_window(900, 700, "w")
        _w, _h, fix_point = self.window.resizes[-1]
        self.assertIsNotNone(fix_point)
        self.assertTrue(fix_point & spicy_app.FixPoint.EAST)

    def test_closing_while_mini_records_the_pre_mini_geometry(self):
        self.api.set_mini_mode(True)
        self.api._record_window_geometry()
        self.assertEqual(self.cache.sizes[-1], (980, 700))
        self.assertEqual(self.cache.positions[-1], (200, 150))

    def test_saving_the_size_while_mini_keeps_it_out_of_the_normal_slot(self):
        self.api.set_mini_mode(True)
        self.api.save_window_size(520, 600)
        self.assertEqual(self.cache.mini, {"width": 520, "height": 600})
        self.assertEqual(self.cache.sizes, [])


if __name__ == "__main__":
    unittest.main()
