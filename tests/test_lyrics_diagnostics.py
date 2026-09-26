import unittest

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


if __name__ == "__main__":
    unittest.main()
