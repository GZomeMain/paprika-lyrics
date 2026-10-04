import unittest
from types import SimpleNamespace

import config
from core.lyrics import (
    _build_diagnostics,
    _count_syllables,
    _lines_look_corrupt,
    _lyrics_cache_key,
)


def _lead(text, ms):
    return {"text": text, "startTimeMs": ms, "isBackground": False, "words": []}


class CorruptPayloadTest(unittest.TestCase):
    """A cached payload that stacked repeated performances onto one timestamp must
    never be served, even though its version tag looks current."""

    def test_stacked_duplicate_lines_are_corrupt(self):
        # Exactly the shape the collapsing bug wrote: one chorus performance
        # stamped four times on the same instant.
        lines = [_lead("Screamin' for me, baby", 40590) for _ in range(4)]
        self.assertTrue(_lines_look_corrupt(lines))

    def test_identical_text_at_one_instant_is_enough(self):
        lines = [_lead("Control yourself", 85330) for _ in range(3)]
        self.assertTrue(_lines_look_corrupt(lines))

    def test_repeated_chorus_at_its_own_times_is_fine(self):
        lines = [_lead("Screamin' for me, baby", ms) for ms in (40515, 50014, 107039, 116536)]
        self.assertFalse(_lines_look_corrupt(lines))

    def test_two_simultaneous_lead_lines_are_tolerated(self):
        lines = [_lead("Hold me", 1_000), _lead("Hold me", 1_000)]
        self.assertFalse(_lines_look_corrupt(lines))

    def test_simultaneous_backing_vocals_are_not_duplicates(self):
        lines = [_lead("Like you're gonna die", 42_883)]
        lines += [{"text": "Ah-ah", "startTimeMs": 42_883, "isBackground": True, "words": []}
                  for _ in range(6)]
        self.assertFalse(_lines_look_corrupt(lines))

    def test_untimed_payload_is_never_flagged(self):
        # Line-only fallbacks have no startTimeMs at all; every line would sit at 0.
        lines = [{"text": "Hold me", "words": []} for _ in range(5)]
        self.assertFalse(_lines_look_corrupt(lines))
        self.assertFalse(_lines_look_corrupt([_lead("Hold me", 0) for _ in range(5)]))

    def test_tolerates_missing_or_malformed_input(self):
        self.assertFalse(_lines_look_corrupt(None))
        self.assertFalse(_lines_look_corrupt([{}, "junk", {"text": None, "startTimeMs": 5}]))
        self.assertFalse(_lines_look_corrupt([_lead("", 5) for _ in range(4)]))


class CountSyllablesTest(unittest.TestCase):
    def test_counts_nested_syllables(self):
        lines = [
            {"words": [{"syllables": [1, 2]}, {"syllables": [3]}]},
            {"words": [{"syllables": [4]}]},
        ]
        self.assertEqual(_count_syllables(lines), 4)

    def test_tolerates_missing_or_malformed_words(self):
        self.assertEqual(_count_syllables([{}, {"words": None}, {"words": [{}]}]), 0)
        self.assertEqual(_count_syllables(None), 0)


class DiagnosticsTest(unittest.TestCase):
    def test_syllable_timing_when_syllables_exist(self):
        lines = [{"words": [{"syllables": [1]}]}]
        diag = _build_diagnostics("Spicy (Apple Music)", "miss", lines, 1, "abcdefghijklmnopqrstuv")
        self.assertEqual(diag["timing"], "Syllable")
        self.assertEqual(diag["cache"], "miss")
        self.assertEqual(diag["lines"], 1)
        self.assertEqual(diag["syllables"], 1)
        self.assertEqual(diag["track_id"], "abcdefghijklmnopqrstuv")

    def test_syllable_count_is_derived_when_not_supplied(self):
        diag = _build_diagnostics("LRCLIB", "hit", [{"words": [{"syllables": [1, 2, 3]}]}])
        self.assertEqual(diag["syllables"], 3)
        self.assertEqual(diag["timing"], "Syllable")

    def test_line_timing_when_no_syllables(self):
        diag = _build_diagnostics("LRCLIB", "hit", [{"words": [], "text": "hello"}], 0)
        self.assertEqual(diag["timing"], "Line")
        self.assertEqual(diag["cache"], "hit")

    def test_empty_payload_reports_none(self):
        diag = _build_diagnostics("None", "miss", [], 0)
        self.assertEqual(diag["timing"], "None")
        self.assertEqual(diag["lines"], 0)
        self.assertFalse(diag["track_id"])
        # The UI also surfaces whether the API key was present at all.
        self.assertIn("api_key", diag)

    def test_report_names_the_build_and_the_payload_format(self):
        """
        A resolve report is what a user pastes into a bug report, so it has to
        name the build it came from — and the payload format separately, because
        that one versions the cache and moves on its own schedule. Both are read
        from config.py rather than restated as literals here, so this test cannot
        drift away from the source of truth it is checking.
        """
        diag = _build_diagnostics("Spicy (Apple Music)", "hit", [{"words": []}], 0)
        self.assertEqual(diag["app_version"], config.APP_VERSION)
        self.assertEqual(diag["parser_version"], config.PARSER_VERSION)
        self.assertTrue(diag["app_version"], "the app version must not be blank")


class PipelineLatencyTest(unittest.TestCase):
    """
    The Spicy chain must not wait on LRCLIB.

    LRCLIB is only a timing reference for the minority of payloads with flat
    syllables; blocking the Spotify resolution on it meant every track-load
    paid max(LRCLIB, ID) + Spicy instead of max(LRCLIB, ID + Spicy).
    """

    def test_spicy_chain_fetches_before_lrclib_completes(self):
        import threading
        import time as _time
        import core.lyrics as L

        release = threading.Event()

        def slow_lrclib(*a, **k):
            release.wait(timeout=5)      # simulates a hung/slow LRCLIB
            return []

        def fast_resolve(*a, **k):
            return "tid_123"

        fetch_calls = []

        def fake_fetch(track_id, lrclib_lines=None):
            fetch_calls.append((track_id, lrclib_lines))
            # LRCLIB is still blocked here: the chain must already have called us.
            self.assertFalse(release.is_set(),
                             "Spicy fetch happened after LRCLIB finished — it is blocked again")
            return [{'text': 'x', 'startTimeMs': 0, 'endTimeMs': 1, 'words': []}], "Spicy (test)"

        orig = (L.fetch_lrclib, L.resolve_spotify_track_id, L.fetch_spicy_with_id,
                L.CACHE.get_lyrics, L.CACHE.set_lyrics)
        L.fetch_lrclib, L.resolve_spotify_track_id, L.fetch_spicy_with_id = \
            slow_lrclib, fast_resolve, fake_fetch
        L.CACHE.get_lyrics = lambda *a, **k: None
        L.CACHE.set_lyrics = lambda *a, **k: None
        try:
            lines, source, tid, diag = L.fetch_lyrics('T', 'A', 200_000)
        finally:
            release.set()
            (L.fetch_lrclib, L.resolve_spotify_track_id, L.fetch_spicy_with_id,
             L.CACHE.get_lyrics, L.CACHE.set_lyrics) = orig

        self.assertEqual(source, "Spicy (test)")
        self.assertEqual(fetch_calls, [("tid_123", [])])   # ref passed through


class LyricsCacheKeyTest(unittest.TestCase):
    def test_duration_bucket_disambiguates_same_title(self):
        self.assertNotEqual(
            _lyrics_cache_key("Song", "Artist", 200_000),
            _lyrics_cache_key("Song", "Artist", 360_000),
        )

    def test_key_is_lowercased_and_omits_unknown_duration(self):
        self.assertEqual(_lyrics_cache_key("Song", "Artist"), "song___artist")
        self.assertEqual(_lyrics_cache_key("Song", "Artist", 0), "song___artist")
        self.assertEqual(_lyrics_cache_key("Song", "Artist", 205_000), "song___artist___205s")

    def test_album_disambiguates_same_title_and_artist(self):
        self.assertNotEqual(
            _lyrics_cache_key("Song", "Artist", 200_000, "Album A"),
            _lyrics_cache_key("Song", "Artist", 200_000, "Album B"),
        )

    def test_no_album_keeps_legacy_key_shape(self):
        # Existing cache entries must stay reachable: album is folded in only
        # when present.
        self.assertEqual(
            _lyrics_cache_key("Song", "Artist", 200_000, None),
            "song___artist___200s",
        )
        self.assertEqual(
            _lyrics_cache_key("Song", "Artist", 200_000, ""),
            "song___artist___200s",
        )


class AlbumAwareLookupTest(unittest.TestCase):
    def test_album_scoped_search_attempted_first(self):
        import core.lyrics as L

        calls = []

        def fake_get(url, **kwargs):
            calls.append((url, kwargs.get("params", {})))
            if "api/search" in url:
                return SimpleNamespace(status_code=200, json=lambda: [
                    {"trackName": "Song", "syncedLyrics": "[00:01.00]hello"}])
            return SimpleNamespace(status_code=404, json=lambda: {})

        orig = L.http_get
        L.http_get = fake_get
        try:
            lines = L.fetch_lrclib("Song", "Artist", 200_000, album="Album A")
        finally:
            L.http_get = orig

        self.assertEqual(len(lines), 1)
        searches = [p for u, p in calls if "api/search" in u]
        self.assertEqual(searches[0].get("album_name"), "Album A")
        # A successful album-scoped search returns immediately: the plain
        # search is a fallback for the MISS case, not a second always-on call.
        self.assertEqual(len(searches), 1)

    def test_plain_search_fires_when_album_scoped_misses(self):
        import core.lyrics as L

        calls = []

        def fake_get(url, **kwargs):
            calls.append((url, kwargs.get("params", {})))
            if "api/search" in url:
                if "album_name" in kwargs.get("params", {}):
                    return SimpleNamespace(status_code=200, json=lambda: [])  # album miss
                return SimpleNamespace(status_code=200, json=lambda: [
                    {"trackName": "Song", "syncedLyrics": "[00:01.00]hello"}])
            return SimpleNamespace(status_code=404, json=lambda: {})

        orig = L.http_get
        L.http_get = fake_get
        try:
            lines = L.fetch_lrclib("Song", "Artist", 200_000, album="Album A")
        finally:
            L.http_get = orig

        self.assertEqual(len(lines), 1)
        searches = [p for u, p in calls if "api/search" in u]
        self.assertEqual(len(searches), 2)
        self.assertIn("album_name", searches[0])
        self.assertNotIn("album_name", searches[1])

    def test_fetch_lyrics_forwards_album(self):
        import core.lyrics as L
        seen = {}

        orig = (L.CACHE.get_lyrics, L.fetch_lrclib, L.fetch_spicy_with_id)
        L.CACHE.get_lyrics = lambda *a, **k: None

        def fake_lrclib(t, a, d=None, album=None):
            seen["album"] = album
            return [{"text": "x", "startTimeMs": 0, "endTimeMs": 1, "words": []}]

        L.fetch_lrclib = fake_lrclib
        L.fetch_spicy_with_id = lambda tid, lrclib_lines=None: ([], None)
        try:
            L.fetch_lyrics("Song", "Artist", 200_000, album="Album A")
        finally:
            (L.CACHE.get_lyrics, L.fetch_lrclib, L.fetch_spicy_with_id) = orig

        self.assertEqual(seen["album"], "Album A")


class LocalTtmlPipelineTest(unittest.TestCase):
    """
    A local .ttml file outranks every online source AND the disk cache.

    It is the one lyric source the user put there on purpose, so the pipeline
    must reach it before it spends a network round trip — and must not read or
    write the lyrics cache on the way, because the file itself stays the source
    of truth and can be edited between plays.
    """

    LOCAL_LINES = [{
        "startTimeMs": 1000, "endTimeMs": 3000, "text": "Gold jewelry",
        "isBackground": False,
        "words": [{"text": "Gold", "startTimeMs": 1000, "endTimeMs": 2000,
                   "syllables": [{"text": "Gold", "startTimeMs": 1000,
                                  "endTimeMs": 2000, "isExtended": False}]}],
    }]

    def setUp(self):
        import core.lyrics as L
        self.L = L
        self.originals = {
            "library": L.TTML_LIBRARY,
            "get_lyrics": L.CACHE.get_lyrics,
            "set_lyrics": L.CACHE.set_lyrics,
            "fetch_lrclib": L.fetch_lrclib,
            "fetch_spicy": L.fetch_spicy_with_id,
            "resolve": L.resolve_spotify_track_id,
        }
        self.network_calls = []

        def _network_used(*a, **k):
            self.network_calls.append(a)
            return []

        self.network_calls.clear()
        L.fetch_lrclib = _network_used
        L.resolve_spotify_track_id = lambda *a, **k: ""
        L.fetch_spicy_with_id = lambda *a, **k: ([], None)

    def tearDown(self):
        L = self.L
        L.TTML_LIBRARY = self.originals["library"]
        L.CACHE.get_lyrics = self.originals["get_lyrics"]
        L.CACHE.set_lyrics = self.originals["set_lyrics"]
        L.fetch_lrclib = self.originals["fetch_lrclib"]
        L.fetch_spicy_with_id = self.originals["fetch_spicy"]
        L.resolve_spotify_track_id = self.originals["resolve"]

    def _library(self, result, calls=None):
        class FakeLibrary:
            directory = "ttml"

            def resolve(self, title, artist, album=None, duration_ms=None):
                if calls is not None:
                    calls.append((title, artist, album, duration_ms))
                return result

        self.L.TTML_LIBRARY = FakeLibrary()

    def test_a_bound_file_is_returned_with_its_own_diagnostics(self):
        calls = []
        self._library({"kind": "bound", "file": "ode.ttml", "name": "ode.ttml",
                       "lines": self.LOCAL_LINES}, calls)
        self.L.CACHE.get_lyrics = lambda *a, **k: self.fail("cache read for a local file")
        self.L.CACHE.set_lyrics = lambda *a, **k: self.fail("cache write for a local file")

        lines, source, track_id, diag = self.L.fetch_lyrics("Ode To The Mets", "The Strokes", 200_000)

        self.assertEqual(lines, self.LOCAL_LINES)
        self.assertEqual(source, "Local TTML (ode.ttml)")
        self.assertIsNone(track_id)
        self.assertEqual(diag["cache"], "local")
        self.assertEqual(diag["source"], "Local TTML (ode.ttml)")
        self.assertEqual(diag["ttml"], "ode.ttml")
        self.assertEqual(diag["ttml_match"], "bound")
        self.assertEqual(diag["timing"], "Syllable")
        self.assertEqual(self.network_calls, [])
        # The library is asked about the CLEANED metadata the rest of the
        # pipeline searches with, not the raw broadcast title.
        self.assertEqual(calls, [("Ode To The Mets", "The Strokes", None, 200_000)])

    def test_a_local_file_beats_an_already_cached_payload(self):
        self._library({"kind": "match", "file": "ode.ttml", "name": "ode.ttml",
                       "lines": self.LOCAL_LINES})
        self.L.CACHE.get_lyrics = lambda *a, **k: {
            "source": "Spicy (Apple Music)",
            "lines": [{"text": "stale", "startTimeMs": 1, "endTimeMs": 2, "words": []}],
        }
        self.L.CACHE.set_lyrics = lambda *a, **k: None

        lines, source, _tid, diag = self.L.fetch_lyrics("Ode To The Mets", "The Strokes", 200_000)

        self.assertEqual(lines, self.LOCAL_LINES)
        self.assertEqual(diag["ttml_match"], "match")

    def test_without_a_local_file_the_pipeline_runs_as_before(self):
        self._library(None)
        self.L.CACHE.get_lyrics = lambda *a, **k: None
        self.L.CACHE.set_lyrics = lambda *a, **k: None

        lines, source, _tid, diag = self.L.fetch_lyrics("Ode To The Mets", "The Strokes", 200_000)

        self.assertEqual(source, "None")
        self.assertEqual(diag["cache"], "miss")
        self.assertEqual(diag["ttml"], "")
        self.assertNotEqual(self.network_calls, [])

    def test_a_broken_library_never_costs_the_user_their_lyrics(self):
        class Exploding:
            directory = "ttml"

            def resolve(self, *a, **k):
                raise OSError("library on a disconnected drive")

        self.L.TTML_LIBRARY = Exploding()
        self.L.CACHE.get_lyrics = lambda *a, **k: None
        self.L.CACHE.set_lyrics = lambda *a, **k: None

        lines, source, _tid, diag = self.L.fetch_lyrics("Ode To The Mets", "The Strokes", 200_000)

        self.assertEqual(lines, [])
        self.assertEqual(diag["cache"], "miss")

    def test_an_unusable_local_payload_is_ignored(self):
        self._library({"kind": "bound", "file": "empty.ttml", "name": "empty.ttml",
                       "lines": []})
        self.L.CACHE.get_lyrics = lambda *a, **k: None
        self.L.CACHE.set_lyrics = lambda *a, **k: None
        _lines, source, _tid, diag = self.L.fetch_lyrics("Song", "Artist", 200_000)
        self.assertEqual(diag["cache"], "miss")
        self.assertNotIn("Local TTML", source)


class MetadataSourceDiagnosticsTest(unittest.TestCase):
    def test_album_and_metadata_surface(self):
        diag = _build_diagnostics("LRCLIB", "miss", [], 0, None,
                                  album="MAYHEM", metadata_source="filename")
        self.assertEqual(diag["album"], "MAYHEM")
        self.assertEqual(diag["metadata"], "filename")

    def test_defaults_keep_legacy_shape(self):
        diag = _build_diagnostics("LRCLIB", "hit", [])
        self.assertEqual(diag["album"], "")
        self.assertEqual(diag["metadata"], "smtc")


if __name__ == "__main__":
    unittest.main()
