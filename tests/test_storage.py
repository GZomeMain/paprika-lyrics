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
        #
        # The call lives in `shutdown_app`, which `on_closed` routes through (it
        # had to become parameterised so a failing teardown step cannot swallow
        # the flush), so the guard follows it there — and adds the routing check
        # rather than dropping one.
        src = (Path(__file__).resolve().parent.parent / "paprika_app.py").read_text(
            encoding="utf-8")
        self.assertIn("cache.flush_sync()", src)
        self.assertNotIn("cache.flush()\n", src)
        # Flattened so the call's line wrapping is not the thing under test: what
        # matters is that on_closed routes the teardown through the guarded
        # function with the real objects.
        wired = " ".join(src.split())
        self.assertIn(
            "shutdown_app(api, HOTKEY_MANAGER, CACHE, ASYNC_EXECUTOR, SHUTDOWN_SIGNAL)",
            wired)


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




class CacheTtlSection7Test(unittest.TestCase):
    """
    Tests for SpicyLyrics Developer Terms Section 7 Caching requirements:
    - Default TTL is 3 days (259,200s).
    - Hard cap of 30 days (2,592,000s) strictly enforced.
    - No caching can be unbounded or set to 0 (never expire).
    - Any cached lyric older than min(CACHE_TTL_SECONDS, 30*86400) is strictly evicted.
    """

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

    def test_default_cache_ttl_constants(self):
        self.assertEqual(config.DEFAULT_CACHE_TTL_SECONDS, 259200)
        self.assertEqual(config.MAX_CACHE_TTL_SECONDS, 2592000)
        self.assertEqual(storage.DEFAULT_CACHE_TTL_SECONDS, 259200)
        self.assertEqual(storage.MAX_CACHE_TTL_SECONDS, 2592000)

    def test_clamp_cache_ttl_rules(self):
        # None or empty defaults to 3 days
        self.assertEqual(config.clamp_cache_ttl(None), 259200)
        self.assertEqual(config.clamp_cache_ttl(""), 259200)
        self.assertEqual(storage.clamp_cache_ttl(None), 259200)

        # Zero or negative values clamp to 3 days (never unbounded)
        self.assertEqual(config.clamp_cache_ttl(0), 259200)
        self.assertEqual(config.clamp_cache_ttl("0"), 259200)
        self.assertEqual(config.clamp_cache_ttl(-1), 259200)
        self.assertEqual(config.clamp_cache_ttl(-86400), 259200)
        self.assertEqual(storage.clamp_cache_ttl(0), 259200)
        self.assertEqual(storage.clamp_cache_ttl(-500), 259200)

        # Invalid strings clamp to 3 days
        self.assertEqual(config.clamp_cache_ttl("not-a-number"), 259200)
        self.assertEqual(storage.clamp_cache_ttl("invalid"), 259200)

        # Valid values within range (1s .. 2,592,000s) are preserved
        self.assertEqual(config.clamp_cache_ttl(86400), 86400)
        self.assertEqual(config.clamp_cache_ttl(259200), 259200)
        self.assertEqual(config.clamp_cache_ttl(2592000), 2592000)
        self.assertEqual(storage.clamp_cache_ttl(86400), 86400)

        # Values exceeding 30 days are clamped to 30 days maximum
        self.assertEqual(config.clamp_cache_ttl(2592001), 2592000)
        self.assertEqual(config.clamp_cache_ttl(5000000), 2592000)
        self.assertEqual(config.clamp_cache_ttl("99999999"), 2592000)
        self.assertEqual(storage.clamp_cache_ttl(5000000), 2592000)

    def test_cached_lyric_strictly_evicted_at_30_day_hard_cap(self):
        now = 10_000_000.0
        # Save a lyric at `now`
        with mock.patch("storage.time.time", return_value=now):
            self.store.set_lyrics("track_30d", {"parser_version": 7, "lines": ["spicy lyrics"]})

        # Check at 29 days (29 * 86400 = 2,505,600s): should still be fresh when TTL is 30 days
        with mock.patch.object(storage, "CACHE_TTL_SECONDS", 2592000):
            with mock.patch("storage.time.time", return_value=now + (29 * 86400)):
                payload = self.store.get_lyrics("track_30d", 7)
                self.assertIsNotNone(payload)

        # Check at 30 days + 1 second: MUST strictly be expired and evicted
        with mock.patch.object(storage, "CACHE_TTL_SECONDS", 2592000):
            with mock.patch("storage.time.time", return_value=now + (30 * 86400) + 1):
                self.assertIsNone(self.store.get_lyrics("track_30d", 7))
                self.assertNotIn("track_30d", self.store._data["lyrics"])

    def test_cached_lyric_evicted_even_if_ttl_set_higher_than_30_days(self):
        now = 10_000_000.0
        with mock.patch("storage.time.time", return_value=now):
            self.store.set_lyrics("track_unbounded", {"parser_version": 7, "lines": []})

        # Even if someone attempts to configure 100 days TTL
        with mock.patch.object(storage, "CACHE_TTL_SECONDS", 100 * 86400):
            with mock.patch("storage.time.time", return_value=now + (30 * 86400) + 10):
                self.assertIsNone(self.store.get_lyrics("track_unbounded", 7))
                self.assertNotIn("track_unbounded", self.store._data["lyrics"])

    def test_max_age_s_zero_or_negative_does_not_disable_expiration(self):
        now = 10_000_000.0
        with mock.patch("storage.time.time", return_value=now):
            self.store.set_lyrics("song_zero_ttl", {"parser_version": 7, "lines": []})

        # 4 days later (> default 3 days)
        with mock.patch("storage.time.time", return_value=now + (4 * 86400)):
            # Passing max_age_s=0 must NOT allow unbounded caching; it clamps to default 3 days
            self.assertIsNone(self.store.get_lyrics("song_zero_ttl", 7, max_age_s=0))
            self.assertNotIn("song_zero_ttl", self.store._data["lyrics"])

    def test_max_age_s_clamped_to_30_days(self):
        now = 10_000_000.0
        with mock.patch("storage.time.time", return_value=now):
            self.store.set_lyrics("song_big_ttl", {"parser_version": 7, "lines": []})

        # 31 days later
        with mock.patch("storage.time.time", return_value=now + (31 * 86400)):
            # Passing max_age_s=99999999 must clamp to 30 days and evict at 31 days
            self.assertIsNone(self.store.get_lyrics("song_big_ttl", 7, max_age_s=99999999))
            self.assertNotIn("song_big_ttl", self.store._data["lyrics"])

    def test_scrub_strictly_evicts_lyrics_exceeding_30_days(self):
        now = 10_000_000.0
        with mock.patch("storage.time.time", return_value=now - (31 * 86400)):
            self.store.set_lyrics("stale_month_old", {"parser_version": 11, "lines": []})
        with mock.patch("storage.time.time", return_value=now - (2 * 86400)):
            self.store.set_lyrics("fresh_two_days", {"parser_version": 11, "lines": []})

        with mock.patch("storage.time.time", return_value=now):
            removed = self.store.scrub_lyrics(11)
            self.assertEqual(removed, 1)
            self.assertNotIn("stale_month_old", self.store._data["lyrics"])
            self.assertIn("fresh_two_days", self.store._data["lyrics"])


class ApiKeyRejectionTest(unittest.TestCase):
    """
    Tests for publishable key enforcement and secret key rejection:
    - Desktop client only accepts publishable keys starting with 'sl_pk_'.
    - Secret keys starting with 'sl_sk_' are strictly rejected with a clear error message.
    - Non-publishable keys are rejected with an error message.
    - Clearing keys (empty string) is supported.
    """

    def setUp(self):
        self._orig_env = os.environ.get("SPICY_API_KEY")
        self._orig_cfg_key = config.SPICY_API_KEY
        if "SPICY_API_KEY" in os.environ:
            del os.environ["SPICY_API_KEY"]
        config.SPICY_API_KEY = ""

    def tearDown(self):
        if self._orig_env is not None:
            os.environ["SPICY_API_KEY"] = self._orig_env
        else:
            os.environ.pop("SPICY_API_KEY", None)
        config.SPICY_API_KEY = self._orig_cfg_key

    def test_set_spicy_api_key_rejects_secret_key(self):
        with self.assertRaises(ValueError) as ctx:
            config.set_spicy_api_key("sl_sk_test_secret_key_1234567890")
        self.assertIn("Secret keys", str(ctx.exception))
        self.assertIn("sl_sk_", str(ctx.exception))
        self.assertIn("sl_pk_", str(ctx.exception))
        # Verify key was not set
        self.assertEqual(config.SPICY_API_KEY, "")
        self.assertNotIn("SPICY_API_KEY", os.environ)

    def test_set_spicy_api_key_rejects_non_publishable_keys(self):
        invalid_keys = ["sk_live_12345", "random_key_string", "api_key_123"]
        for bad_key in invalid_keys:
            with self.subTest(key=bad_key):
                with self.assertRaises(ValueError) as ctx:
                    config.set_spicy_api_key(bad_key)
                self.assertIn("sl_pk_", str(ctx.exception))

    def test_set_spicy_api_key_accepts_publishable_key(self):
        pub_key = "sl_pk_live_abcdef1234567890"
        res = config.set_spicy_api_key(pub_key)
        self.assertTrue(res["ok"])
        self.assertTrue(res["key_set"])
        self.assertEqual(res["masked"], "sl_pk_••••••••7890")
        self.assertEqual(config.get_spicy_api_key(), pub_key)
        self.assertEqual(os.environ.get("SPICY_API_KEY"), pub_key)

    def test_set_spicy_api_key_clears_key(self):
        config.set_spicy_api_key("sl_pk_sample_key_123456")
        self.assertEqual(config.get_spicy_api_key(), "sl_pk_sample_key_123456")

        res = config.set_spicy_api_key("")
        self.assertTrue(res["ok"])
        self.assertFalse(res["key_set"])
        self.assertEqual(res["masked"], "")
        self.assertEqual(config.get_spicy_api_key(), "")
        self.assertNotIn("SPICY_API_KEY", os.environ)

    def test_get_spicy_api_key_rejects_secret_key_in_env(self):
        with mock.patch.dict(os.environ, {"SPICY_API_KEY": "sl_sk_live_unauthorized_key"}):
            self.assertEqual(config.get_spicy_api_key(), "")
            with self.assertRaises(ValueError) as ctx:
                config.get_spicy_api_key(raise_on_invalid=True)
            self.assertIn("Secret keys", str(ctx.exception))

    def test_get_spicy_api_key_rejects_non_publishable_key_in_env(self):
        with mock.patch.dict(os.environ, {"SPICY_API_KEY": "invalid_bearer_token"}):
            self.assertEqual(config.get_spicy_api_key(), "")
            with self.assertRaises(ValueError) as ctx:
                config.get_spicy_api_key(raise_on_invalid=True)
            self.assertIn("sl_pk_", str(ctx.exception))

    def test_get_spicy_api_key_returns_publishable_key(self):
        pub_key = "sl_pk_prod_1122334455667788"
        with mock.patch.dict(os.environ, {"SPICY_API_KEY": pub_key}):
            self.assertEqual(config.get_spicy_api_key(), pub_key)

    def test_get_spicy_api_key_rejects_secret_key_in_cache(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            config.SPICY_API_KEY = ""
            with mock.patch("storage.CACHE.get_setting", return_value="sl_sk_cached_secret_123"):
                with mock.patch("storage.CACHE.set_setting") as mock_set:
                    self.assertEqual(config.get_spicy_api_key(), "")
                    # Purges secret key from persistent storage
                    mock_set.assert_called_with("spicy_api_key", None)

    def test_get_spicy_api_key_empty_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            config.SPICY_API_KEY = ""
            with mock.patch("storage.CACHE.get_setting", return_value=None):
                self.assertEqual(config.get_spicy_api_key(), "")


if __name__ == "__main__":
    unittest.main()
