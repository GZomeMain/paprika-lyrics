import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import config
import storage
from config import default_latency_for


class CacheManagerTest(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.path = Path(self.tmp_dir) / "cache.json"
        self.store = storage.CacheManager(filepath=self.path)

    def tearDown(self):
        try:
            self.store.flush()
        except Exception:
            pass
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_lyrics_expire_after_ttl(self):
        now = 1_000_000.0
        with mock.patch("storage.time.time", return_value=now):
            self.store.set_lyrics("song", {"parser_version": 7, "lines": [1]})

        with mock.patch("storage.time.time", return_value=now + storage.CACHE_TTL_SECONDS + 10):
            self.assertIsNone(self.store.get_lyrics("song", 7))

    def test_fresh_lyrics_are_returned(self):
        self.store.set_lyrics("song", {"parser_version": 7, "lines": [1]})
        payload = self.store.get_lyrics("song", 7)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["lines"], [1])
        self.assertIn("saved_at", payload)

    def test_version_mismatch_is_evicted(self):
        self.store.set_lyrics("song", {"parser_version": 7, "lines": [1]})
        self.assertIsNone(self.store.get_lyrics("song", 8))
        self.assertNotIn("song", self.store._data["lyrics"])

    def test_legacy_entry_without_timestamp_is_stale(self):
        self.store._data["lyrics"]["legacy"] = {"parser_version": 7, "lines": []}
        self.assertIsNone(self.store.get_lyrics("legacy", 7))

    def test_lru_bound_evicts_oldest(self):
        self.store.MAX_LYRICS_ENTRIES = 3
        for i in range(4):
            self.store.set_lyrics(f"k{i}", {"parser_version": 7, "lines": []})
        self.assertEqual(len(self.store._data["lyrics"]), 3)
        self.assertNotIn("k0", self.store._data["lyrics"])

    def test_expired_entry_removed_on_access_and_flush(self):
        self.store.set_lyrics("k", {"parser_version": 7, "lines": []})
        self.store.flush()

        data = json.loads(self.path.read_text(encoding="utf-8"))
        data["lyrics"]["k"]["saved_at"] = 0
        self.path.write_text(json.dumps(data), encoding="utf-8")

        reloaded = storage.CacheManager(filepath=self.path)
        # Construction must be non-destructive: expiry is pruned lazily.
        self.assertIn("k", reloaded._data["lyrics"])
        self.assertIsNone(reloaded.get_lyrics("k", 7))
        self.assertNotIn("k", reloaded._data["lyrics"])

        reloaded.flush()
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertNotIn("k", on_disk["lyrics"])

    def test_atomic_roundtrip(self):
        self.store.set_lyrics("k", {"parser_version": 7, "lines": [{"text": "hi"}]})
        self.store.flush()

        reloaded = storage.CacheManager(filepath=self.path)
        payload = reloaded.get_lyrics("k", 7)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["lines"][0]["text"], "hi")
        self.assertFalse(self.path.with_suffix(".tmp").exists())
        reloaded.flush()

    def test_latency_clamped(self):
        self.store.set_latency("track", 999999)
        self.assertEqual(self.store.get_latency("track", 0), 3000)
        self.store.set_latency("track", -999999)
        self.assertEqual(self.store.get_latency("track", 0), -3000)

    def test_drop_lyrics_evicts_one_entry(self):
        self.store.set_lyrics("keep", {"parser_version": 7, "lines": [1]})
        self.store.set_lyrics("drop", {"parser_version": 7, "lines": [1]})

        self.assertTrue(self.store.drop_lyrics("drop"))
        self.assertFalse(self.store.drop_lyrics("drop"))
        self.assertNotIn("drop", self.store._data["lyrics"])
        self.assertIn("keep", self.store._data["lyrics"])

    def test_drop_lyrics_persists_on_flush(self):
        self.store.set_lyrics("drop", {"parser_version": 7, "lines": [1]})
        self.store.drop_lyrics("drop")
        self.store.flush()
        reloaded = storage.CacheManager(filepath=self.path)
        self.assertNotIn("drop", reloaded._data["lyrics"])

    def test_scrub_removes_older_versions_but_keeps_current(self):
        now = 1_000_000.0
        with mock.patch("storage.time.time", return_value=now):
            self.store.set_lyrics("old", {"parser_version": 10, "lines": [1]})
            self.store.set_lyrics("current", {"parser_version": 11, "lines": [1]})

        with mock.patch("storage.time.time", return_value=now):
            self.assertEqual(self.store.scrub_lyrics(11), 1)
        self.assertEqual(list(self.store._data["lyrics"]), ["current"])

    def test_scrub_removes_expired_and_malformed_entries(self):
        now = 1_000_000.0
        with mock.patch("storage.time.time", return_value=now - storage.CACHE_TTL_SECONDS - 100):
            self.store.set_lyrics("stale", {"parser_version": 11, "lines": [1]})
        with mock.patch("storage.time.time", return_value=now):
            self.store.set_lyrics("fresh", {"parser_version": 11, "lines": [1]})
        # A hand-edited / truncated entry must not crash the sweep either.
        self.store._data["lyrics"]["junk"] = "not a payload"

        with mock.patch("storage.time.time", return_value=now):
            removed = self.store.scrub_lyrics(11)

        self.assertEqual(removed, 2)
        self.assertNotIn("stale", self.store._data["lyrics"])
        self.assertNotIn("junk", self.store._data["lyrics"])
        self.assertIn("fresh", self.store._data["lyrics"])

    def test_scrub_without_version_only_drops_expired(self):
        self.store.set_lyrics("old", {"parser_version": 10, "lines": [1]})
        self.assertEqual(self.store.scrub_lyrics(), 0)
        self.assertIn("old", self.store._data["lyrics"])

    def test_scrub_on_empty_cache_is_a_noop(self):
        self.assertEqual(self.store.scrub_lyrics(11), 0)

    def test_corrupt_cache_reinitializes(self):
        self.path.write_text("{ not valid json", encoding="utf-8")
        reloaded = storage.CacheManager(filepath=self.path)
        self.assertEqual(reloaded._data["lyrics"], {})
        self.assertEqual(reloaded._data["tracks"], {})
        reloaded.flush()


class LatencyDefaultTest(unittest.TestCase):
    """A fresh fetch starts wider than a cached one, and a tuned value wins."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.path = Path(self.tmp_dir) / "cache.json"
        self.store = storage.CacheManager(filepath=self.path)

    def tearDown(self):
        try:
            self.store.flush()
        except Exception:
            pass
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_cache_state_picks_the_starting_offset(self):
        self.assertEqual(default_latency_for("hit"), config.DEFAULT_LATENCY_MS)
        self.assertEqual(default_latency_for("miss"), config.UNCACHED_LATENCY_MS)
        # Unknown / absent diagnostics must not silently land on the small value.
        self.assertEqual(default_latency_for(None), config.UNCACHED_LATENCY_MS)
        self.assertEqual(config.UNCACHED_LATENCY_MS, 1500)

    def test_a_local_ttml_file_opens_at_the_tuned_baseline(self):
        # Nothing was fetched, so there is no network latency to compensate for.
        self.assertEqual(default_latency_for("local"), config.DEFAULT_LATENCY_MS)

    def test_a_tuned_offset_survives_the_new_default(self):
        self.store.set_latency("track", 250)
        self.assertEqual(self.store.get_latency("track", default_latency_for("miss")), 250)
        self.assertEqual(self.store.get_latency("other", default_latency_for("miss")), 1500)


class TtmlStoreTest(unittest.TestCase):
    """The local-TTML index and per-track bindings, which are user choices and
    must survive a restart exactly as made."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.path = Path(self.tmp_dir) / "cache.json"
        self.store = storage.CacheManager(filepath=self.path)

    def tearDown(self):
        try:
            self.store.flush()
        except Exception:
            pass
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_index_roundtrips(self):
        self.store.set_ttml_files({"a.ttml": {"title": "A", "line_count": 4}})
        self.store.flush()
        reloaded = storage.CacheManager(filepath=self.path)
        self.assertEqual(reloaded.get_ttml_files()["a.ttml"]["title"], "A")

    def test_index_reads_are_copies(self):
        # Callers annotate entries for the UI; that must not reach the disk.
        self.store.set_ttml_files({"a.ttml": {"title": "A"}})
        files = self.store.get_ttml_files()
        files["a.ttml"]["state"] = "bound"
        self.assertNotIn("state", self.store.get_ttml_files()["a.ttml"])

    def test_replacing_the_index_forgets_removed_files(self):
        self.store.set_ttml_files({"a.ttml": {"title": "A"}, "b.ttml": {"title": "B"}})
        self.store.set_ttml_files({"b.ttml": {"title": "B"}})
        self.assertEqual(list(self.store.get_ttml_files()), ["b.ttml"])

    def test_binding_keeps_its_enabled_flag(self):
        self.store.set_ttml_binding("song___artist", "a.ttml", enabled=False)
        self.assertEqual(self.store.ttml_bindings()["song___artist"],
                         {"file": "a.ttml", "enabled": False})

    def test_bindings_roundtrip_through_disk(self):
        self.store.set_ttml_binding("song___artist", "a.ttml", enabled=False)
        self.store.flush()
        reloaded = storage.CacheManager(filepath=self.path)
        self.assertEqual(reloaded.ttml_bindings()["song___artist"]["enabled"], False)

    def test_prune_drops_bindings_to_missing_files_but_keeps_markers(self):
        self.store.set_ttml_binding("gone___artist", "gone.ttml")
        self.store.set_ttml_binding("off___artist", "", enabled=False)
        self.store.set_ttml_binding("kept___artist", "kept.ttml")

        removed = self.store.prune_ttml_bindings({"kept.ttml"})

        self.assertEqual(removed, 1)
        bindings = self.store.ttml_bindings()
        self.assertNotIn("gone___artist", bindings)
        self.assertIn("kept___artist", bindings)
        # The "no local lyrics here" marker names no file: forgetting it would
        # let the auto-match quietly take the song back.
        self.assertIn("off___artist", bindings)

    def test_binding_map_is_bounded(self):
        self.store.MAX_TTML_BINDINGS = 3
        for i in range(5):
            self.store.set_ttml_binding(f"k{i}", "a.ttml")
        self.assertEqual(len(self.store.ttml_bindings()), 3)
        self.assertNotIn("k0", self.store.ttml_bindings())

    def test_dropping_a_file_leaves_bindings_alone(self):
        # The library prunes bindings itself; a naked index drop must not take
        # the user's choices with it.
        self.store.set_ttml_files({"a.ttml": {"title": "A"}})
        self.store.set_ttml_binding("song___artist", "a.ttml")
        self.assertTrue(self.store.drop_ttml_file("a.ttml"))
        self.assertFalse(self.store.drop_ttml_file("a.ttml"))
        self.assertEqual(list(self.store.get_ttml_files()), [])

    def test_a_cache_without_the_ttml_section_gains_one(self):
        self.path.write_text(json.dumps({"tracks": {}, "lyrics": {}}), encoding="utf-8")
        reloaded = storage.CacheManager(filepath=self.path)
        self.assertEqual(reloaded.get_ttml_files(), {})
        self.assertEqual(reloaded.ttml_bindings(), {})


class ShutdownFlushTest(unittest.TestCase):
    """Writes are debounced; the exit path must not be.

    Every mutation schedules a `threading.Timer`, so a process that exits inside
    the debounce window loses whatever it just wrote. The state most likely to be
    pending is the state the user changed by hand a second before closing — a
    local TTML binding, or the marker that says "online lyrics for this song".
    """

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.path = Path(self.tmp_dir) / "cache.json"
        self.store = storage.CacheManager(filepath=self.path)

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_a_pending_write_is_not_on_disk_yet(self):
        # The premise of the test below: without the debounce this would already
        # be saved, and there would be no race to fix.
        self.store.set_ttml_binding("song___artist", "a.ttml", enabled=False)
        self.assertFalse(self.path.exists())

    def test_flush_sync_persists_a_pending_binding(self):
        self.store.set_ttml_binding("song___artist", "a.ttml", enabled=False)
        self.assertTrue(self.store.flush_sync())

        reloaded = storage.CacheManager(filepath=self.path)
        self.assertEqual(reloaded.ttml_bindings()["song___artist"],
                         {"file": "a.ttml", "enabled": False})

    def test_flush_sync_persists_a_pending_index_and_marker(self):
        self.store.set_ttml_files({"a.ttml": {"title": "A"}})
        self.store.set_ttml_binding("off___artist", "", enabled=False)
        self.assertTrue(self.store.flush_sync())

        reloaded = storage.CacheManager(filepath=self.path)
        self.assertEqual(reloaded.get_ttml_files()["a.ttml"]["title"], "A")
        # The "no local lyrics here" marker survives an exit too: losing it
        # would let the auto-match take the song back on the next launch.
        self.assertEqual(reloaded.ttml_bindings()["off___artist"]["enabled"], False)

    def test_flush_sync_cancels_the_pending_timer(self):
        self.store.set_ttml_binding("song___artist", "a.ttml")
        timer = self.store._save_timer
        self.assertIsNotNone(timer)
        self.store.flush_sync()
        self.assertIsNone(self.store._save_timer)
        self.assertFalse(timer.is_alive())

    def test_flush_sync_reports_a_write_that_cannot_happen(self):
        # Called from the window's close handler: it must report, never raise,
        # or a cache problem replaces a clean exit with a crash.
        self.store.set_ttml_binding("song___artist", "a.ttml")
        with mock.patch.object(self.store, "_save_atomic",
                               side_effect=OSError("disk full")):
            self.assertFalse(self.store.flush_sync())

    def test_flush_sync_is_safe_on_a_cache_with_nothing_pending(self):
        self.assertTrue(self.store.flush_sync())
        self.assertTrue(self.store.flush_sync())

    def test_the_close_handler_uses_the_synchronous_flush(self):
        # The method only helps if the exit path calls it. Wiring that cannot be
        # executed headlessly (pywebview owns the close event), so it is asserted
        # against the source the way the WebView2 profile wiring is.
        src = (Path(__file__).resolve().parent.parent / "paprika_app.py").read_text(
            encoding="utf-8")
        self.assertIn("CACHE.flush_sync()", src)
        self.assertNotIn("CACHE.flush()\n", src)


class WindowGeometryTest(unittest.TestCase):
    """The mini player keeps its own size so leaving it restores the real one."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.path = Path(self.tmp_dir) / "cache.json"
        self.store = storage.CacheManager(filepath=self.path)

    def tearDown(self):
        try:
            self.store.flush()
        except Exception:
            pass
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_mini_size_roundtrips_without_touching_the_normal_size(self):
        self.store.save_window_size(980, 720)
        self.store.save_mini_size(440, 560)
        self.store.flush()

        reloaded = storage.CacheManager(filepath=self.path)
        self.assertEqual(reloaded.get_mini_size(), {"width": 440, "height": 560})
        self.assertEqual(reloaded.get_window_geometry()["width"], 980)
        self.assertEqual(reloaded.get_window_geometry()["height"], 720)

    def test_missing_mini_size_is_an_empty_dict(self):
        self.assertEqual(self.store.get_mini_size(), {})

    def test_a_later_normal_size_save_leaves_the_mini_size_alone(self):
        self.store.save_mini_size(400, 520)
        self.store.save_window_size(1100, 800)
        self.assertEqual(self.store.get_mini_size(), {"width": 400, "height": 520})


if __name__ == "__main__":
    unittest.main()
