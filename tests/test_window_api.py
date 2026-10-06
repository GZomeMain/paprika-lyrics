import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import paprika_app
import storage
from core.ttml_library import TtmlLibrary

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
        # What the native file picker should answer: a tuple of paths, None for
        # "cancelled", or an exception instance to raise.
        self.dialog_result = None
        self.dialog_calls = []

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

    def create_file_dialog(self, *args, **kwargs):
        self.dialog_calls.append((args, kwargs))
        if isinstance(self.dialog_result, BaseException):
            raise self.dialog_result
        return self.dialog_result


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
        self.api = paprika_app.WindowApi(self.window)
        patches = (
            (paprika_app, "CACHE", self.cache),
            # Entering mini pins the window on top; there is no HWND here, so the
            # native call is stubbed rather than left to fail loudly.
            (paprika_app.native_window, "set_topmost", mock.Mock(return_value=True)),
        )
        for target, attr, value in patches:
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_entering_mini_shrinks_to_the_default_and_remembers_the_old_size(self):
        self.assertTrue(self.api.set_mini_mode(True))
        self.assertEqual((self.window.width, self.window.height), paprika_app.MINI_SIZE)
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
        self.assertEqual((self.window.width, self.window.height), paprika_app.MINI_MAX)

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
        self.assertEqual((self.window.width, self.window.height), paprika_app.NORMAL_MAX)
        self.api.set_mini_mode(True)
        self.api.resize_window(2000, 2000, "e")
        self.assertEqual((self.window.width, self.window.height), paprika_app.MINI_MAX)

    def test_resize_below_the_floor_is_clamped_for_both_modes(self):
        self.api.resize_window(100, 100, "w")
        self.assertEqual((self.window.width, self.window.height), paprika_app.NORMAL_MIN)
        self.api.set_mini_mode(True)
        self.api.resize_window(100, 100, "w")
        self.assertEqual((self.window.width, self.window.height), paprika_app.MINI_MIN)

    def test_resize_passes_the_anchor_through_as_a_fix_point(self):
        self.api.resize_window(900, 700, "w")
        _w, _h, fix_point = self.window.resizes[-1]
        self.assertIsNotNone(fix_point)
        self.assertTrue(fix_point & paprika_app.FixPoint.EAST)

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


@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class MiniPinsOnTopTest(unittest.TestCase):
    """The mini player is a floating strip, so the host pins it while it is up.

    The user's own always-on-top setting is a preference, so it is remembered and
    put back — but a change they make *while* mini is the preference that comes
    back, otherwise turning it off inside mini would look like it did nothing.
    """

    def setUp(self):
        self.window = FakeWindow()
        self.api = paprika_app.WindowApi(self.window)
        self.topmost = mock.Mock(return_value=True)
        self.pushes = []
        patches = (
            (paprika_app, "CACHE", FakeCache()),
            (paprika_app, "WINDOW_REF",
             mock.Mock(evaluate_js=lambda script: self.pushes.append(script))),
            (paprika_app.native_window, "set_topmost", self.topmost),
        )
        for target, attr, value in patches:
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_entering_mini_pins_the_window_and_leaving_puts_it_back(self):
        self.api.set_always_on_top(False)          # the preference
        self.api.set_mini_mode(True)
        self.assertEqual(self.topmost.call_args_list[-1], mock.call(self.window, True))
        self.api.set_mini_mode(False)
        self.assertEqual(self.topmost.call_args_list[-1], mock.call(self.window, False))

    def test_a_choice_made_while_mini_is_what_comes_back(self):
        self.api.set_mini_mode(True)               # pins (the preference was off)
        self.api.set_always_on_top(False)          # ... and the user turns it off
        self.topmost.reset_mock()
        self.api.set_mini_mode(False)
        self.assertEqual(self.topmost.call_args_list, [mock.call(self.window, False)])

    def test_the_ui_is_told_about_the_forced_pin(self):
        self.api.set_mini_mode(True)
        self.assertIn("window.setAlwaysOnTop(true);", self.pushes)
        self.api.set_mini_mode(False)
        self.assertIn("window.setAlwaysOnTop(false);", self.pushes)


@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class WindowAlphaApiTest(unittest.TestCase):
    """The UI asks for an alpha; the host owns the fade and the floor."""

    def setUp(self):
        self.window = FakeWindow()
        self.api = paprika_app.WindowApi(self.window)
        self.applied = []

        def record(window, alpha, **kwargs):
            self.applied.append(alpha)
            return True

        patcher = mock.patch.object(paprika_app.native_window, "set_window_alpha", record)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_request_fades_in_steps_and_lands_on_the_target(self):
        self.assertAlmostEqual(self.api.set_window_alpha(0.7), 0.7, places=3)
        self.assertGreater(len(self.applied), 1)          # stepped, not snapped
        self.assertAlmostEqual(self.applied[-1], 0.7, places=3)
        self.assertTrue(all(0.7 <= a <= 1.0 for a in self.applied))

    def test_the_floor_is_enforced_so_the_window_never_sinks(self):
        # A 1% window would be a hole in the desktop; the UI cannot ask for it.
        self.assertEqual(self.api.set_window_alpha(0.01), paprika_app.HOVER_FADE_FLOOR)
        self.assertAlmostEqual(self.applied[-1], paprika_app.HOVER_FADE_FLOOR, places=3)

    def test_a_non_numeric_request_keeps_the_last_target(self):
        self.api.set_window_alpha(0.7)
        self.assertEqual(self.api.set_window_alpha("nope"), 0.7)

    def test_a_failing_native_call_does_not_spin(self):
        with mock.patch.object(paprika_app.native_window, "set_window_alpha",
                               return_value=False):
            self.assertEqual(self.api.set_window_alpha(0.6), 0.6)
            self.assertEqual(self.api._alpha_current, 0.6)

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

    def test_starting_a_drag_goes_through_the_native_gesture(self):
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
        self.api._spawn_detached = self._record_spawn()
        self.api.set_hover_fade(True)
        self.assertEqual(self.spawned, [self.api._hover_probe])
        self.assertIsNotNone(self.api._hover_probe_thread)
        self.api.set_hover_fade(False)
        self.assertIsNone(self.api._hover_probe_thread)

    def test_leaving_click_through_hands_the_pointer_state_back_to_the_page(self):
        self.api._spawn_detached = self._record_spawn()
        self.api.set_hover_fade(True)
        with mock.patch.object(paprika_app, "CLICK_THROUGH_ENABLED", False):
            self.api._sync_hover_probe()
        self.assertIsNone(self.api._hover_probe_thread)
        self.assertEqual(self.pushed[-1], "window.setHoverFadeInside(false);")

    def test_without_click_through_the_page_owns_the_pointer_state(self):
        self.api._spawn_detached = self._record_spawn()
        with mock.patch.object(paprika_app, "CLICK_THROUGH_ENABLED", False):
            self.api.set_hover_fade(True)
        self.assertEqual(self.spawned, [])
        self.assertIsNone(self.api._hover_probe_thread)

    def _record_spawn(self):
        """A stand-in for the detached-thread seam that records and returns a token."""
        self.spawned = []

        def spawn(target):
            self.spawned.append(target)
            return "thread"

        return spawn


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
            (paprika_app.HOTKEY_MANAGER, "click_through_bound", True),
            (paprika_app, "WINDOW_REF",
             mock.Mock(evaluate_js=lambda script: self.pushes.append(script))),
            (paprika_app.native_window, "set_click_through", self.click_through),
            (paprika_app.native_window, "set_window_alpha", mock.Mock(return_value=True)),
        )
        for target, attr, value in patches:
            patcher = mock.patch.object(target, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.api._cancel_peek_timer)

    def test_peeking_turns_click_through_off_and_the_ui_is_told(self):
        self.assertTrue(self.api.start_peek())
        self.assertIn("window.setClickThrough(false);", self.pushes)
        self.assertTrue(self.api.end_peek())

    def test_ending_the_peek_puts_click_through_back(self):
        self.api.start_peek()
        self.assertTrue(self.api.end_peek())
        self.assertIn("window.setClickThrough(true);", self.pushes)

    def test_a_peek_starts_interactive_immediately(self):
        # The window it hands back is the one the user was already looking at:
        # no geometry or alpha change, only the mouse.
        self.assertTrue(self.api.start_peek())
        self.assertEqual(self.window.resizes, [])
        self.assertEqual(self.window.moves, [])

    def test_peeking_is_a_noop_when_the_window_is_already_clickable(self):
        with mock.patch.object(paprika_app, "CLICK_THROUGH_ENABLED", False):
            self.assertFalse(self.api.start_peek())
        self.assertEqual(self.pushes, [])


@unittest.skipUnless(HAS_PYWEBVIEW, "pywebview is required for the window API")
class TtmlApiTest(unittest.TestCase):
    """The bridge surface the settings panel drives.

    Each mutation returns a full snapshot of the library, so the UI renders from
    one source of truth; a change that can alter the lyrics on screen also asks
    the SMTC bridge to reload the track.
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.library = TtmlLibrary(directory=self.tmp / "ttml",
                                   cache=storage.CacheManager(filepath=self.tmp / "cache.json"))
        self.window = FakeWindow()
        self.bridge = mock.Mock()
        self.api = paprika_app.WindowApi(self.window)
        for attr, value in (("TTML_LIBRARY", self.library), ("SMTC_BRIDGE", self.bridge)):
            patcher = mock.patch.object(paprika_app, attr, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def source_doc(self, title, artist):
        return ('<tt xmlns="http://www.w3.org/ns/ttml" '
                'xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><head><metadata>'
                f'<ttm:title>{title}</ttm:title>'
                f'<ttm:agent type="person" xml:id="v1"><ttm:name type="full">{artist}</ttm:name>'
                '</ttm:agent></metadata></head><body dur="00:20.000">'
                '<p begin="1.0" end="3.0"><span begin="1.0">Gold </span>'
                '<span begin="2.0">jewelry</span></p></body></tt>')

    def write_download(self, name, title, artist):
        path = self.tmp / "downloads"
        path.mkdir(exist_ok=True)
        target = path / name
        target.write_text(self.source_doc(title, artist), encoding="utf-8")
        return str(target)

    def test_list_reports_the_library_and_the_current_track(self):
        self.window.dialog_result = [self.write_download("ode.ttml", "Ode To The Mets", "The Strokes")]
        self.api.ttml_import()

        snapshot = self.api.ttml_list("Ode To The Mets", "The Strokes", "The New Abnormal", 200_000)
        self.assertEqual(snapshot["count"], 1)
        self.assertEqual(snapshot["current"]["kind"], "match")
        self.assertEqual(snapshot["entries"][0]["title"], "Ode To The Mets")

    def test_the_bridge_survives_javascript_undefined_arguments(self):
        # pywebview serialises a missing argument as null, so every string-shaped
        # parameter can arrive as None.
        snapshot = self.api.ttml_list(None, None, None, None)
        self.assertEqual(snapshot["count"], 0)
        self.assertIsNone(snapshot["current"])

    def test_import_copies_the_chosen_files_and_reports_what_happened(self):
        self.window.dialog_result = [
            self.write_download("ode.ttml", "Ode To The Mets", "The Strokes"),
            self.write_download("other.ttml", "Other", "Someone"),
        ]
        snapshot = self.api.ttml_import()
        self.assertEqual(snapshot["count"], 2)
        self.assertIn("Added 2 files", snapshot["status"])
        self.assertTrue((self.library.directory / "ode.ttml").exists())
        # The picker opens where the files will land.
        _args, kwargs = self.window.dialog_calls[0]
        self.assertEqual(kwargs["directory"], str(self.library.directory))
        self.assertTrue(kwargs["allow_multiple"])

    def test_import_cancelled_is_not_an_error(self):
        self.window.dialog_result = None
        snapshot = self.api.ttml_import()
        self.assertEqual(snapshot["status"], "")
        self.assertEqual(snapshot["count"], 0)

    def test_import_reports_a_file_that_will_not_parse(self):
        broken = self.tmp / "broken.ttml"
        broken.write_text("<tt><body><p>x</p>", encoding="utf-8")
        self.window.dialog_result = [str(broken)]
        snapshot = self.api.ttml_import()
        self.assertIn("broken.ttml", snapshot["status"])
        self.assertIn("not valid XML", snapshot["status"])
        self.assertEqual(snapshot["count"], 1)   # kept, so it can be fixed in place

    def test_import_reports_a_dialog_that_cannot_open(self):
        self.window.dialog_result = RuntimeError("no shell")
        snapshot = self.api.ttml_import()
        self.assertIn("File picker unavailable", snapshot["status"])
        self.assertEqual(snapshot["count"], 0)

    def test_rescan_and_reveal(self):
        with mock.patch.object(self.library, "reveal", return_value=True) as reveal:
            self.assertTrue(self.api.ttml_reveal("ode.ttml"))
            reveal.assert_called_once_with("ode.ttml")

        self.assertIn("Rescanned", self.api.ttml_rescan()["status"])

    def test_bind_returns_the_snapshot_and_reloads_the_track(self):
        self.window.dialog_result = [self.write_download("ode.ttml", "Ode To The Mets", "The Strokes")]
        self.api.ttml_import()

        snapshot = self.api.ttml_bind("ode.ttml", "Some Song", "Someone", "Album", 200_000)
        self.assertIn("ode.ttml", snapshot["status"])
        self.assertEqual(snapshot["current"]["kind"], "bound")
        self.bridge.request_reload.assert_called_once()

    def test_binding_an_unknown_file_is_reported_without_a_reload(self):
        snapshot = self.api.ttml_bind("ghost.ttml", "Song", "Artist")
        self.assertEqual(snapshot["status"], "unknown file")
        self.bridge.request_reload.assert_not_called()

    def test_disable_and_enable_report_their_state(self):
        self.window.dialog_result = [self.write_download("ode.ttml", "Ode To The Mets", "The Strokes")]
        self.api.ttml_import()
        self.bridge.reset_mock()

        off = self.api.ttml_set_enabled(False, "Ode To The Mets", "The Strokes")
        self.assertEqual(off["current"]["kind"], "off")
        self.assertIn("online lyrics", off["status"])
        self.bridge.request_reload.assert_called_once()

        self.bridge.reset_mock()
        on = self.api.ttml_set_enabled(True, "Ode To The Mets", "The Strokes")
        self.assertEqual(on["current"]["kind"], "match")
        self.assertIn("local lyrics", on["status"])
        self.bridge.request_reload.assert_called_once()

    def test_untitled_playback_cannot_be_bound(self):
        self.window.dialog_result = [self.write_download("ode.ttml", "Ode To The Mets", "The Strokes")]
        self.api.ttml_import()
        snapshot = self.api.ttml_set_enabled(False, "", "")
        self.assertEqual(snapshot["status"], "no track")
        self.bridge.request_reload.assert_not_called()

    def test_remove_moves_the_file_to_trash_and_reloads(self):
        self.window.dialog_result = [self.write_download("ode.ttml", "Ode To The Mets", "The Strokes")]
        self.api.ttml_import()
        self.bridge.reset_mock()

        snapshot = self.api.ttml_remove("ode.ttml", "Ode To The Mets", "The Strokes")
        self.assertEqual(snapshot["count"], 0)
        self.assertIn("Removed ode.ttml", snapshot["status"])
        self.assertEqual(snapshot["trash"], 1)
        self.bridge.request_reload.assert_called_once()

    def test_a_broken_library_returns_an_empty_snapshot_instead_of_raising(self):
        exploding = mock.Mock()
        exploding.directory = self.tmp / "ttml"
        exploding.snapshot.side_effect = OSError("drive disconnected")
        with mock.patch.object(paprika_app, "TTML_LIBRARY", exploding):
            snapshot = self.api.ttml_list("Song", "Artist")
        self.assertEqual(snapshot["entries"], [])
        self.assertEqual(snapshot["count"], 0)

    def test_spicy_api_key_window_api(self):
        with mock.patch("core.resolver.http_get") as mock_get:
            mock_get.return_value = mock.Mock(status_code=200)
            res = self.api.set_spicy_api_key("sl_sk_testkey9999")
            self.assertTrue(res["ok"])
            self.assertTrue(res["verified"])
            self.bridge.request_reload.assert_called()

        info = self.api.get_spicy_api_key()
        self.assertTrue(info["set"])
        self.assertEqual(info["key"], "sl_sk_testkey9999")
        self.assertIn("sl_sk_", info["masked"])

        self.bridge.reset_mock()
        clear_res = self.api.set_spicy_api_key("")
        self.assertTrue(clear_res["ok"])
        self.assertFalse(clear_res["key_set"])
        self.bridge.request_reload.assert_called()

        info_after = self.api.get_spicy_api_key()
        self.assertFalse(info_after["set"])


class ShutdownTest(unittest.TestCase):
    """Teardown must not let one failing step swallow the ones behind it.

    `on_closed` is the last code the process runs, so a raise inside it is both
    invisible (a windowed build has no console) and expensive: the window-geometry
    write and the cache flush that follow the failure are skipped, and the user
    loses their window position and any local-TTML binding they had just made.
    The reported crash was `HOTKEY_MANAGER.stop()` on a manager that had never
    been constructed; the guard is per-step, so the rest runs whatever fails.
    """

    class FakeCache:
        def __init__(self, ok=True):
            self.ok = ok
            self.flushes = 0

        def flush_sync(self):
            self.flushes += 1
            return self.ok

    class FakeExecutor:
        def __init__(self):
            self.shutdowns = 0
            self.wait = None

        def shutdown(self, wait=False):
            self.shutdowns += 1
            self.wait = wait

    class FakeApi:
        def __init__(self, explode=None):
            self.explode = explode
            self.steps = []

        def _cancel_peek_timer(self):
            self._step("peek")

        def _stop_hover_probe(self):
            self._step("probe")

        def _record_window_geometry(self):
            self._step("geometry")

        def _step(self, name):
            self.steps.append(name)
            if self.explode == name:
                raise RuntimeError(f"{name} blew up")

    def test_every_step_runs_when_none_fails(self):
        api = self.FakeApi()
        cache = self.FakeCache()
        executor = self.FakeExecutor()
        signal = threading.Event()
        failures = paprika_app.shutdown_app(api, mock.Mock(), cache, executor, signal)
        self.assertEqual(failures, [])
        self.assertEqual(api.steps, ["peek", "probe", "geometry"])
        self.assertEqual(cache.flushes, 1)
        self.assertEqual(executor.shutdowns, 1)
        self.assertTrue(signal.is_set())

    def test_a_failing_step_does_not_skip_the_writes_behind_it(self):
        api = self.FakeApi(explode="probe")
        cache = self.FakeCache()
        executor = self.FakeExecutor()
        with mock.patch.object(paprika_app, "log_to_file"):
            failures = paprika_app.shutdown_app(
                api, mock.Mock(), cache, executor, threading.Event())
        self.assertEqual([name for name, _ in failures], ["hover probe"])
        self.assertIn("geometry", api.steps)
        self.assertEqual(cache.flushes, 1)
        self.assertEqual(executor.shutdowns, 1)

    def test_a_missing_hotkey_manager_or_api_is_not_fatal(self):
        cache = self.FakeCache()
        executor = self.FakeExecutor()
        failures = paprika_app.shutdown_app(
            None, None, cache, executor, threading.Event())
        self.assertEqual(failures, [])
        self.assertEqual(cache.flushes, 1)
        self.assertEqual(executor.shutdowns, 1)

    def test_a_cache_that_cannot_be_written_is_reported_not_raised(self):
        cache = self.FakeCache(ok=False)
        executor = self.FakeExecutor()
        failures = paprika_app.shutdown_app(
            None, mock.Mock(), cache, executor, threading.Event())
        self.assertEqual(failures, [])
        self.assertEqual(executor.shutdowns, 1)

    def test_on_closed_is_wired_to_the_guarded_path(self):
        # The guard only helps if the teardown actually goes through it. Asserted
        # against the source because on_closed is defined inside the __main__
        # block, which cannot be called from a test.
        src = (Path(__file__).resolve().parent.parent / "paprika_app.py").read_text(
            encoding="utf-8")
        self.assertIn(
            "shutdown_app(api, HOTKEY_MANAGER, CACHE, ASYNC_EXECUTOR, SHUTDOWN_SIGNAL)",
            src)

class FatalStartupErrorTest(unittest.TestCase):
    """A frozen build is windowed, so `print` goes nowhere.

    Without this, a machine missing the WebView2 runtime got a double-click that
    did nothing at all — no window, no message, no log. `_fatal` is the path that
    replaces that silence, so its two channels are exercised here rather than
    only asserted against the source.
    """

    def _fatal_with(self, has_console, logged):
        # config.log_to_file, not paprika_app's own name: `_fatal` must import it
        # lazily, because it also has to report a failure to import config.
        with mock.patch.object(paprika_app, "_HAS_CONSOLE", has_console), \
             mock.patch("config.log_to_file", side_effect=lambda m: logged.append(m)), \
             mock.patch.object(paprika_app.ctypes, "windll", mock.Mock(),
                               create=True) as windll:
            paprika_app._fatal("no WebView2 runtime")
        return windll

    def test_without_a_console_it_shows_a_dialog_and_writes_the_log(self):
        logged = []
        windll = self._fatal_with(False, logged)
        windll.user32.MessageBoxW.assert_called_once()
        self.assertTrue(any("no WebView2 runtime" in line for line in logged))

    def test_with_a_console_it_does_not_show_a_dialog(self):
        # A console build is a developer or a debug artifact: printing is enough,
        # and a modal box would block an automated run.
        logged = []
        windll = self._fatal_with(True, logged)
        windll.user32.MessageBoxW.assert_not_called()
        self.assertTrue(any("no WebView2 runtime" in line for line in logged))

    def test_every_fatal_startup_path_uses_it(self):
        # Missing pywebview, a missing core module, and a failed webview.start()
        # (the WebView2 case) — each must go through _fatal, not print.
        src = (Path(__file__).resolve().parent.parent / "paprika_app.py").read_text(
            encoding="utf-8")
        self.assertIn("def _fatal(", src)
        self.assertEqual(src.count("_fatal("), 4)


if __name__ == "__main__":
    unittest.main()
