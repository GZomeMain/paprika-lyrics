import json
import unittest
from types import SimpleNamespace
from unittest import mock

import core.resolver as R

EMBED_HTML = (
    '<html><script id="__NEXT_DATA__" type="application/json">'
    + json.dumps({"props": {"pageProps": {"state": {"settings": {"session": {
        "accessToken": "anon-token",
        "accessTokenExpirationTimestampMs": 9_999_999_999_999}}}}}})
    + "</script></html>"
)


def search_payload(*tracks):
    """
    A search response shaped the way Spotify really nests one.

    Each hit arrives as ``items[].item.data``, several wrappers deep, and the
    tier's job is to find the tracks inside that without depending on the
    wrapper names — so the fixture keeps the wrappers rather than flattening
    them, and a parser that hard-codes a path fails here.
    """
    items = [{"item": {"data": {
        "__typename": "Track",
        "uri": f"spotify:track:{track_id}",
        "name": name,
        "duration": {"totalMilliseconds": duration_ms},
        "album": {"uri": "spotify:album:aaaaaaaaaaaaaaaaaaaaaa"},
        "artists": {"items": [{"uri": "spotify:artist:bbbbbbbbbbbbbbbbbbbbbb"}]},
    }}} for track_id, name, duration_ms in tracks]
    return {"data": {"searchV2": {"tracksV2": {"items": items}}}}


class FakeWeb:
    """
    The two HTTP calls the built-in search tier makes, as canned responses.

    Nothing here touches the network on purpose. This tier is the only way a
    packaged exe reaches a syllable-synced lyric at all, so its behaviour is
    pinned by tests instead of being whatever Spotify happens to answer today.
    """

    def __init__(self, payload=None, token_status=200, search_status=200):
        self.payload = payload if payload is not None else search_payload()
        self.token_status = token_status
        # Statuses are consumed in order, so one test can lapse a token and then
        # have the refreshed one succeed.
        self.search_status = list(search_status) if isinstance(search_status, list) else [search_status]
        self.token_calls = 0
        self.search_calls = 0
        self.search_terms = []

    def __call__(self, url, **kwargs):
        if "embed/track" in url:
            self.token_calls += 1
            return SimpleNamespace(status_code=self.token_status, text=EMBED_HTML)
        self.search_calls += 1
        params = kwargs.get("params") or {}
        if "variables" in params:
            self.search_terms.append(json.loads(params["variables"]).get("searchTerm"))
        status = self.search_status[min(self.search_calls - 1, len(self.search_status) - 1)]
        if status != 200:
            return SimpleNamespace(status_code=status, text="")
        return SimpleNamespace(status_code=200, text=json.dumps(self.payload),
                               json=lambda: self.payload)


class ResolveTestBase(unittest.TestCase):
    """Resolution tests never read or write the real cache."""

    def setUp(self):
        self._orig_get_track = R.CACHE.get_track
        self._orig_set_track = R.CACHE.set_track
        R.CACHE.get_track = lambda key: None
        self.set_track_calls = []
        R.CACHE.set_track = lambda k, v: self.set_track_calls.append((k, v))
        # A fresh anonymous token per test: the real one is cached in the module.
        R._ANONYMOUS_TOKEN["value"] = ""
        R._ANONYMOUS_TOKEN["expires_at_ms"] = 0.0

    def tearDown(self):
        R.CACHE.get_track = self._orig_get_track
        R.CACHE.set_track = self._orig_set_track
        (R._ANONYMOUS_TOKEN["value"], R._ANONYMOUS_TOKEN["expires_at_ms"]) = ("", 0.0)


class BuiltInSearchTierTest(ResolveTestBase):
    """
    The tier that has to work in a packaged exe.

    The exe is built from `requirements.txt` only, so it has no spotify-scraper,
    and Odesli — which the Apple Music and Deezer tiers went through — retired its
    public API. Between them every track in a released build resolved to no id at
    all and fell back to line-synced LRCLIB even with a valid API key, which is
    what these tests exist to keep from happening again.
    """

    def test_resolves_a_track_id_with_no_scraper_installed(self):
        web = FakeWeb(search_payload(("0VjIjW4GlUZAMYd2vXMi3b", "Blinding Lights", 200_040)))
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            track_id = R.resolve_spotify_track_id("Blinding Lights", "The Weeknd")

        self.assertEqual(track_id, "0VjIjW4GlUZAMYd2vXMi3b")
        self.assertEqual(web.search_calls, 1)
        self.assertEqual(self.set_track_calls,
                         [("blinding lights___the weeknd", "0VjIjW4GlUZAMYd2vXMi3b")])

    def test_hit_is_found_below_the_result_wrappers(self):
        """The id lives under items[].item.data, and the walk must not depend on it."""
        web = FakeWeb(search_payload(("39LLxExYz6ewLAcYrzQQyP", "Levitating", 203_000)))
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            self.assertEqual(R.search_spotify_track_id("Levitating Dua Lipa"),
                             "39LLxExYz6ewLAcYrzQQyP")

    def test_anonymous_token_is_reused_between_tracks(self):
        web = FakeWeb(search_payload(("0VjIjW4GlUZAMYd2vXMi3b", "Blinding Lights", 200_040)))
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            R.resolve_spotify_track_id("Blinding Lights", "The Weeknd")
            R.resolve_spotify_track_id("Levitating", "Dua Lipa")

        self.assertEqual(web.token_calls, 1, "the embed page must not be fetched per search")
        self.assertEqual(web.search_calls, 2)

    def test_a_lapsed_token_is_refreshed_once(self):
        web = FakeWeb(search_payload(("0VjIjW4GlUZAMYd2vXMi3b", "Blinding Lights", 200_040)),
                      search_status=[401, 200])
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            track_id = R.resolve_spotify_track_id("Blinding Lights", "The Weeknd")

        self.assertEqual(track_id, "0VjIjW4GlUZAMYd2vXMi3b")
        self.assertEqual(web.token_calls, 2, "a rejected token is worth exactly one refresh")

    def test_no_hits_returns_nothing_and_caches_nothing(self):
        web = FakeWeb(search_payload())
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            self.assertIsNone(R.resolve_spotify_track_id("Nothing", "Nobody"))

        self.assertEqual(self.set_track_calls, [])

    def test_an_unreachable_embed_page_is_not_an_error(self):
        """A token that cannot be read has to behave like a search that found nothing."""
        with mock.patch.object(R, "http_get", lambda *a, **k: None), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            self.assertIsNone(R.resolve_spotify_track_id("Song", "Artist"))

    def test_albums_and_artists_in_the_payload_are_not_mistaken_for_tracks(self):
        payload = {"data": {"searchV2": {"tracksV2": {"items": [{"item": {"data": {
            "uri": "spotify:album:4yP0hdKOZPNshxUOjY0cZj",
            "artists": {"items": [{"uri": "spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ"}]},
        }}}]}}}}
        web = FakeWeb(payload)
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            self.assertIsNone(R.search_spotify_track_id("After Hours The Weeknd"))


class SearchHitChoiceTest(ResolveTestBase):
    """Which of Spotify's hits is the recording that is actually playing."""

    HITS = [
        ("6zaxxZxxjUJ0I3AYkzp2WA", "Blinding Lights - Instrumental", 199_000),
        ("0VjIjW4GlUZAMYd2vXMi3b", "Blinding Lights", 200_040),
        ("6qYkmqFsXbj8CQjAdbYz07", "Blinding Lights - Remix", 245_000),
    ]

    def _resolve(self, duration_ms, payload=None):
        web = FakeWeb(payload if payload is not None else search_payload(*self.HITS))
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            return R.resolve_spotify_track_id("Blinding Lights", "The Weeknd", duration_ms=duration_ms)

    def test_the_playing_tracks_length_picks_its_pressing(self):
        self.assertEqual(self._resolve(200_040), "0VjIjW4GlUZAMYd2vXMi3b")

    def test_length_still_wins_when_several_pressings_are_close(self):
        # Two instrumentals and the real thing; only one is within tolerance of
        # the length the player reported.
        self.assertEqual(self._resolve(245_500), "6qYkmqFsXbj8CQjAdbYz07")

    def test_first_hit_is_kept_when_none_matches_the_length(self):
        # A different master (+40s) is still the best available answer, and
        # rejecting it would throw away the only hit that is the right song.
        self.assertEqual(self._resolve(360_000), "6zaxxZxxjUJ0I3AYkzp2WA")

    def test_unknown_length_leaves_the_search_order_alone(self):
        self.assertEqual(self._resolve(None), "6zaxxZxxjUJ0I3AYkzp2WA")
        self.assertEqual(self._resolve(0), "6zaxxZxxjUJ0I3AYkzp2WA")


class SearchQueryTest(ResolveTestBase):
    def test_album_is_added_to_the_search_term(self):
        web = FakeWeb(search_payload(("aaaaaaaaaaaaaaaaaaaaaa", "Song", 200_000)))
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            R.resolve_spotify_track_id("Song", "Artist", album="Album A")

        self.assertEqual(web.search_terms, ["Song Artist Album A"])

    def test_cache_key_includes_the_album_when_present(self):
        web = FakeWeb(search_payload(("aaaaaaaaaaaaaaaaaaaaaa", "Song", 200_000)))
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            R.resolve_spotify_track_id("Song", "Artist", album="Album A")

        key, _value = self.set_track_calls[0]
        self.assertIn("album a", key)

    def test_no_album_keeps_legacy_cache_key(self):
        web = FakeWeb(search_payload(("bbbbbbbbbbbbbbbbbbbbbb", "Song", 200_000)))
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            R.resolve_spotify_track_id("Song", "Artist")

        key, _value = self.set_track_calls[0]
        self.assertEqual(key, "song___artist")


class TierOrderTest(ResolveTestBase):
    """
    The installed library keeps its place first; the built-in search backs it up.

    `spotifyscraper` is the lookup this app has always used, so it stays in front.
    It is also absent from the pinned requirements — the shipped exe contains no
    `spotify_scraper` at all — so the built-in tier has to carry that build on its
    own, and must answer whenever the library finds nothing or fails.
    """

    def test_the_installed_library_is_tried_before_the_built_in_search(self):
        web = FakeWeb(search_payload(("aaaaaaaaaaaaaaaaaaaaaa", "Song", 200_000)))

        class FakeClient:
            def search(self, query, types=None, limit=1):
                return SimpleNamespace(tracks=[SimpleNamespace(id="cccccccccccccccccccccc")])

        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SCRAPER_CLIENT", FakeClient()), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", True):
            track_id = R.resolve_spotify_track_id("Song", "Artist")

        self.assertEqual(track_id, "cccccccccccccccccccccc")
        self.assertEqual(web.search_calls, 0, "the library answered, so nothing else was needed")

    def test_built_in_search_answers_when_the_library_finds_nothing(self):
        web = FakeWeb(search_payload(("aaaaaaaaaaaaaaaaaaaaaa", "Song", 200_000)))

        class FakeClient:
            def search(self, query, types=None, limit=1):
                return None

        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SCRAPER_CLIENT", FakeClient()), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", True):
            track_id = R.resolve_spotify_track_id("Song", "Artist")

        self.assertEqual(track_id, "aaaaaaaaaaaaaaaaaaaaaa")
        self.assertEqual(web.search_calls, 1)

    def test_a_broken_library_does_not_take_the_built_in_search_with_it(self):
        web = FakeWeb(search_payload(("aaaaaaaaaaaaaaaaaaaaaa", "Song", 200_000)))

        class Exploding:
            def search(self, query, types=None, limit=1):
                raise RuntimeError("spotify changed its markup again")

        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SCRAPER_CLIENT", Exploding()), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", True):
            self.assertEqual(R.resolve_spotify_track_id("Song", "Artist"),
                             "aaaaaaaaaaaaaaaaaaaaaa")

    def test_scraper_search_includes_the_album(self):
        seen = {}

        class FakeClient:
            def search(self, query, types=None, limit=1):
                seen["query"] = query
                return None

        web = FakeWeb(search_payload())
        with mock.patch.object(R, "http_get", web), \
             mock.patch.object(R, "SCRAPER_CLIENT", FakeClient()), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", True):
            R.resolve_spotify_track_id("Song", "Artist", album="Album A")

        self.assertIn("Album A", seen.get("query", ""))

    def test_a_track_id_already_in_the_cache_is_not_searched_for_again(self):
        R.CACHE.get_track = lambda key: "dddddddddddddddddddddd"
        with mock.patch.object(R, "http_get", lambda *a, **k: self.fail("cache hit made a request")), \
             mock.patch.object(R, "SCRAPER_CLIENT", None), \
             mock.patch.object(R, "SPOTIFY_SCRAPER_AVAILABLE", False):
            self.assertEqual(R.resolve_spotify_track_id("Song", "Artist"),
                             "dddddddddddddddddddddd")


if __name__ == "__main__":
    unittest.main()
