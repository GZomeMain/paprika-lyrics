import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import storage


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
