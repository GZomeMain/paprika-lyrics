import unittest
from unittest import mock

import core.resolver as R


class ResolveAlbumTest(unittest.TestCase):
    def setUp(self):
        self._orig_get_track = R.CACHE.get_track
        self._orig_set_track = R.CACHE.set_track
        R.CACHE.get_track = lambda key: None
        self.set_track_calls = []
        R.CACHE.set_track = lambda k, v: self.set_track_calls.append((k, v))

    def tearDown(self):
        R.CACHE.get_track = self._orig_get_track
        R.CACHE.set_track = self._orig_set_track

    def test_scraper_search_includes_album(self):
        seen = {}

        class FakeClient:
            def search(self, query, types=None, limit=1):
                seen["query"] = query
                return None

        orig = (R.SCRAPER_CLIENT, R.SPOTIFY_SCRAPER_AVAILABLE)
        R.SCRAPER_CLIENT, R.SPOTIFY_SCRAPER_AVAILABLE = FakeClient(), True
        try:
            R.resolve_spotify_track_id("Song", "Artist", album="Album A")
        finally:
            R.SCRAPER_CLIENT, R.SPOTIFY_SCRAPER_AVAILABLE = orig

        self.assertIn("Album A", seen.get("query", ""))

    def test_cache_key_includes_album_when_present(self):
        self.set_track_calls.clear()
        with mock.patch.object(R, "http_get") as fake_get, \
             mock.patch.object(R, "query_odesli", return_value="a" * 22), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            fake_get.return_value = mock.Mock(
                status_code=200, json=lambda: {"results": [{"trackViewUrl": "https://music.apple.com/x"}]})
            R.resolve_spotify_track_id("Song", "Artist", album="Album A")

        key, _val = self.set_track_calls[0]
        self.assertIn("album a", key)

    def test_no_album_keeps_legacy_cache_key(self):
        self.set_track_calls.clear()
        with mock.patch.object(R, "http_get") as fake_get, \
             mock.patch.object(R, "query_odesli", return_value="b" * 22), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            fake_get.return_value = mock.Mock(
                status_code=200, json=lambda: {"results": [{"trackViewUrl": "https://music.apple.com/x"}]})
            R.resolve_spotify_track_id("Song", "Artist")

        key, _val = self.set_track_calls[0]
        self.assertEqual(key, "song___artist")


if __name__ == "__main__":
    unittest.main()
