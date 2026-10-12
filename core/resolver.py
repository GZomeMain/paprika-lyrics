import json
import re
import threading
import time
from urllib.parse import urlencode

import requests

from config import debug_log
from storage import CACHE
from core.metadata import extract_clean_metadata

# Zero-auth Spotify Scraper (PyPI: `spotifyscraper`). A single client is shared
# across resolver threads, so all calls are serialized by this lock to avoid
# concurrent-session corruption.
#
# OPTIONAL: it is not in the pinned requirements, so a packaged exe does not
# contain it and the built-in search below is what such a build actually runs.
# When it is installed — the development machine has it — it stays the FIRST
# tier, because it is the lookup this app has always used and validated.
try:
    from spotify_scraper import SpotifyClient
    SPOTIFY_SCRAPER_AVAILABLE = True
    SCRAPER_CLIENT = SpotifyClient()
except ImportError:
    SPOTIFY_SCRAPER_AVAILABLE = False
    SCRAPER_CLIENT = None

SCRAPER_LOCK = threading.Lock()

SPOTIFY_ID_REGEX = re.compile(r"^[a-zA-Z0-9]{22}$")

HTTP_SESSION = requests.Session()
HTTP_SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9"
})


def http_get(url: str, **kwargs) -> requests.Response | None:
    kwargs.setdefault("timeout", 3.5)
    try:
        return HTTP_SESSION.get(url, **kwargs)
    except requests.RequestException as exc:
        print(f"↳ HTTP error for {url}: {exc}")
        return None


# ---------------------------------------------------------------------------
# Spotify's own search, over the pinned requirements and nothing else
# ---------------------------------------------------------------------------
# The Spicy Lyrics API takes a Spotify TRACK ID and nothing else — it has exactly
# one endpoint and no title/artist lookup — so every syllable-synced lyric in
# this app depends on resolving "title + artist" to an ID first. Both tiers that
# used to do that were gone in a shipped build:
#
#   * SpotifyScraper is not in `requirements.txt`, so the exe built from them
#     never contained it (`grep` finds no such string in the shipped binary) and
#     its tier could not run at all;
#   * Odesli, which the Apple Music and Deezer tiers went through, retired its
#     public API — `api.song.link` now answers `401 PUBLIC_API_ACCESS_DEPRECATED`
#     to every request.
#
# Between them, a released exe resolved NO track id for any song and fell back to
# line-synced LRCLIB for all of them, API key or not: its own cache held artwork
# URLs and not one track id. That is the bug this tier fixes. It is the same
# two-step lookup the library performs — an embed page hands out a short-lived
# anonymous token, and the web player's persisted-query search accepts it —
# written against `requests` alone, so it needs no dependency that a packaged
# build might not have.
SPOTIFY_EMBED_TRACK_URL = "https://open.spotify.com/embed/track/{}"
SPOTIFY_SEARCH_URL = "https://api-partner.spotify.com/pathfinder/v1/query"
# Any public track seeds the token, which is not tied to the track it was read
# from; one long-lived release is the stable choice.
SPOTIFY_TOKEN_BOOTSTRAP_ID = "4uLU6hMCjMI75M1A2tKUQC"
# The persisted query the web player uses for its aggregate search. Spotify
# rotating this hash is a one-line change here.
SPOTIFY_SEARCH_OPERATION = "searchDesktop"
SPOTIFY_SEARCH_QUERY_HASH = "eff59fa0a3d026b88b56fddbcf4bdfa16a186b8175a5c1a358c072e053c2e5b0"
# Asked for more than one hit because the right one is not always first: see
# `_pick_search_hit`.
SPOTIFY_SEARCH_LIMIT = 5
# A token is refreshed this long before it lapses, so it cannot expire mid-flight.
TOKEN_EXPIRY_SKEW_MS = 60_000
# Used only when a response carries no expiry of its own. Refreshing a token
# costs one request; trusting a lapsed one costs the track.
TOKEN_FALLBACK_TTL_MS = 300_000
# How far a search hit's length may differ from the playing track's before it is
# a different recording rather than the same one.
DURATION_TOLERANCE_MS = 5_000

_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.DOTALL)
TOKEN_LOCK = threading.Lock()
_ANONYMOUS_TOKEN: dict[str, object] = {"value": "", "expires_at_ms": 0.0}


def _anonymous_web_token(force_refresh: bool = False) -> str:
    """
    A short-lived anonymous Spotify bearer token, or "" when none can be had.

    Read from a public embed page's `__NEXT_DATA__`, cached until it nears the
    expiry the page itself states. Never raises: a tier that cannot authenticate
    has to behave like a tier that found nothing, or one unreachable endpoint
    would take lyric loading with it.
    """
    with TOKEN_LOCK:
        now_ms = time.time() * 1000
        cached = str(_ANONYMOUS_TOKEN["value"] or "")
        if cached and not force_refresh and now_ms < float(_ANONYMOUS_TOKEN["expires_at_ms"]) - TOKEN_EXPIRY_SKEW_MS:
            return cached

        token, expires_at_ms = "", 0.0
        res = http_get(SPOTIFY_EMBED_TRACK_URL.format(SPOTIFY_TOKEN_BOOTSTRAP_ID), timeout=5.0)
        if res is not None and res.status_code == 200:
            try:
                match = _NEXT_DATA_RE.search(res.text or "")
                payload = json.loads(match.group(1)) if match else {}
                page_props = (payload.get("props") or {}).get("pageProps") or {}
                session = (page_props.get("state") or {}).get("settings", {}) or {}
                session = session.get("session") or {}
                token = str(session.get("accessToken") or "")
                expires_at_ms = float(session.get("accessTokenExpirationTimestampMs") or 0)
            except Exception as exc:
                debug_log("Spotify embed page carried no usable token:", exc)

        if not token:
            print("   ⚠️ [Spotify Search] No anonymous search token (embed page unreachable or changed).")
        elif not expires_at_ms:
            expires_at_ms = now_ms + TOKEN_FALLBACK_TTL_MS

        _ANONYMOUS_TOKEN["value"] = token
        _ANONYMOUS_TOKEN["expires_at_ms"] = expires_at_ms
        return token


def _spotify_search_hits(query: str, token: str,
                         limit: int = SPOTIFY_SEARCH_LIMIT) -> tuple[list[dict], int]:
    """
    `(hits, status)` for a free-text search.

    A hit carries only what the resolver needs — the track id, its title and its
    length. The status comes back with it so a lapsed token (401/403, worth one
    retry) can be told apart from a query that matched nothing (worth none).
    """
    variables = {
        "searchTerm": query,
        "offset": 0,
        "limit": limit,
        "numberOfTopResults": 5,
        "includeAudiobooks": True,
        "includePreReleases": True,
        "includeAlbumPreReleases": False,
        "includeAuthors": False,
        "includeEpisodeContentRatingsV2": False,
    }
    params = {
        "operationName": SPOTIFY_SEARCH_OPERATION,
        "variables": json.dumps(variables, separators=(",", ":")),
        "extensions": json.dumps(
            {"persistedQuery": {"version": 1, "sha256Hash": SPOTIFY_SEARCH_QUERY_HASH}},
            separators=(",", ":")),
    }
    res = http_get(
        SPOTIFY_SEARCH_URL, params=params,
        headers={"Authorization": f"Bearer {token}", "app-platform": "WebPlayer"},
        timeout=5.0,
    )
    if res is None or res.status_code != 200:
        status = getattr(res, "status_code", 0)
        debug_log(f"Spotify search returned HTTP {status}.")
        return [], status
    try:
        union = (res.json().get("data") or {}).get("searchV2") or {}
    except Exception as exc:
        debug_log("Spotify search returned a non-JSON payload:", exc)
        return [], 200

    hits: list[dict] = []
    _collect_search_tracks(union.get("tracksV2"), hits)
    return hits, 200


def _collect_search_tracks(node, out: list[dict]) -> None:
    """
    Appends every distinct track in a search section, in result order.

    Spotify nests each hit several layers deep (`items[].item.data` today) and
    reshapes those wrappers whenever it renames a section, while an entity's own
    `uri` stays put — so the walk keys off `uri` instead of a path that would
    quietly stop matching. All hits are collected rather than the first, because
    which one is right is a decision for the caller, which knows the track's
    length.
    """
    if isinstance(node, dict):
        uri = node.get("uri")
        if isinstance(uri, str) and uri.startswith("spotify:track:"):
            track_id = uri.split(":")[-1]
            if SPOTIFY_ID_REGEX.match(track_id) and not any(h["id"] == track_id for h in out):
                duration = (node.get("duration") or {}).get("totalMilliseconds")
                out.append({
                    "id": track_id,
                    "name": str(node.get("name") or ""),
                    "duration_ms": int(duration) if isinstance(duration, (int, float)) else 0,
                })
        for value in node.values():
            _collect_search_tracks(value, out)
    elif isinstance(node, list):
        for value in node:
            _collect_search_tracks(value, out)


def _pick_search_hit(hits: list[dict], duration_ms: float | None) -> str | None:
    """
    The hit to use, preferring the one whose length matches the playing track.

    Spotify's first result is usually right and stays the fallback, but a search
    for a title and an artist also returns remixes, live takes and other
    pressings — and the Spicy Lyrics API answers the wrong pressing with a 404,
    which costs the whole track its syllable timing. The length the player is
    already reporting is enough to tell those apart, so when it is known the
    closest hit within tolerance wins; otherwise the search order is left alone.

    Measurement of real searches is why this is not "just take the first one":
    for `Levitating Dua Lipa` Spotify returns the album take at 203.807s and the
    feat. DaBaby single at 203.064s, and a session playing either one reports its
    own length to the millisecond. Ties (two pressings of the same length) keep
    the search order, because `min` keeps the first minimal hit.
    """
    usable = [h for h in hits if SPOTIFY_ID_REGEX.match(str(h.get("id") or ""))]
    if not usable:
        return None
    if duration_ms and duration_ms > 0:
        timed = [h for h in usable if h.get("duration_ms")]
        if timed:
            closest = min(timed, key=lambda h: abs(h["duration_ms"] - duration_ms))
            if abs(closest["duration_ms"] - duration_ms) <= DURATION_TOLERANCE_MS:
                return closest["id"]
    return usable[0]["id"]


def search_spotify_track_id(query: str, duration_ms: float | None = None) -> str | None:
    """
    A Spotify track id for a free-text query, or None.

    Written against the pinned requirements only (`requests`), which is what
    makes the packaged exe resolve tracks the way a source checkout does. Every
    failure returns None so the chain moves on to the next tier, rather than
    raising on a track change.
    """
    token = _anonymous_web_token()
    if not token:
        return None
    hits, status = _spotify_search_hits(query, token)
    if status in (401, 403):
        # The token lapsed between the embed page and the search. Worth exactly
        # one retry: a second rejection is a changed policy, not a stale token.
        token = _anonymous_web_token(force_refresh=True)
        if not token:
            return None
        hits, status = _spotify_search_hits(query, token)

    if not hits:
        debug_log(f"Spotify search found no track for {query!r} (HTTP {status}).")
        return None
    track_id = _pick_search_hit(hits, duration_ms)
    if track_id:
        print(f"   ✅ [Spotify Search] Found ID: {track_id}")
    return track_id


def resolve_spotify_track_id(raw_title: str, raw_artist: str,
                             album: str | None = None,
                             duration_ms: float | None = None) -> str | None:
    """
    Resolves a Spotify Track ID through multi-tiered resolution:
    Cache -> SpotifyScraper (when installed) -> built-in Spotify search -> none.

    `album` sharpens the search term and the cache key when present; omitting it
    keeps the legacy cache-key shape so existing entries stay valid. `duration_ms`
    only breaks ties between search hits (see `_pick_search_hit`) and never
    reaches the cache key, so a track resolved without it stays found.
    """
    c_title, primary_artist, full_artist = extract_clean_metadata(raw_title, raw_artist)
    artist_query = primary_artist or full_artist
    cache_key = f"{c_title}___{artist_query}".lower()
    if album:
        cache_key = f"{cache_key}___{album.lower()}"

    cached_id = CACHE.get_track(cache_key)
    if cached_id:
        print(f"⚡ [Disk Cache Hit] '{c_title}' -> {cached_id}")
        return cached_id

    print(f"\n🔎 [Resolver] Searching Spotify ID for: '{c_title}' by '{artist_query}'...")

    search_query = f"{c_title} {artist_query}".strip()
    if album:
        search_query = f"{search_query} {album}".strip()

    # Tier 1: Direct Spotify Scraper, when this machine has it. Unchanged, and
    # still the first tier: it is the lookup this app has always shipped and
    # validated, and it is present on a development checkout.
    if SPOTIFY_SCRAPER_AVAILABLE and SCRAPER_CLIENT:
        try:
            with SCRAPER_LOCK:
                results = SCRAPER_CLIENT.search(search_query, types=("track",), limit=1)
            if results and results.tracks:
                t_id = results.tracks[0].id
                if SPOTIFY_ID_REGEX.match(t_id):
                    print(f"   ✅ [SpotifyScraper Match] Found ID: {t_id}")
                    CACHE.set_track(cache_key, t_id)
                    return t_id
        except Exception as e:
            debug_log(f"SpotifyScraper bypass: {e}")

    # Tier 2: the built-in search, over `requests` alone. This is the tier a
    # packaged build actually runs, since the library above is not in the pinned
    # requirements; it also covers a development machine's transient failures.
    track_id = search_spotify_track_id(search_query, duration_ms)
    if track_id:
        CACHE.set_track(cache_key, track_id)
        return track_id

    print(f"   ❌ [Resolver] Exhausted all resolution tiers for '{c_title}'.")
    return None


def resolve_artwork_url(raw_title: str, raw_artist: str) -> str | None:
    """
    Resolves a hi-res (1000x1000 or larger) artwork URL for the background bloom.
    Independent of track-ID resolution: it only needs the artwork, so it goes
    straight to the sources that expose it. The iTunes and Deezer search
    responses already carry the URL; we just keep it.
    """
    c_title, primary_artist, full_artist = extract_clean_metadata(raw_title, raw_artist)
    artist_query = primary_artist or full_artist
    cache_key = f"art___{c_title}___{artist_query}".lower()

    cached = CACHE.get_track(cache_key)
    if cached:
        return cached

    # Tier 1: iTunes search — returns artworkUrlLarge up to 1000x1000.
    try:
        it_res = http_get(
            "https://itunes.apple.com/search",
            params={"term": f"{c_title} {artist_query}", "media": "music", "entity": "song", "limit": 3},
        )
        if it_res and it_res.status_code == 200:
            for item in it_res.json().get("results", []):
                art = item.get("artworkUrl100")
                if art:
                    # iTunes serves any requested size; ask for the large square.
                    url = art.replace("100x100", "1000x1000")
                    CACHE.set_track(cache_key, url)
                    return url
    except Exception as e:
        debug_log(f"Artwork (iTunes) bypass: {e}")

    # Tier 2: Deezer search — cover_xl is 1000x1000.
    try:
        dz_res = http_get(
            "https://api.deezer.com/search",
            params={"q": f"{c_title} {artist_query}", "limit": 3},
        )
        if dz_res and dz_res.status_code == 200:
            for item in dz_res.json().get("data", []):
                album = item.get("album") or {}
                url = album.get("cover_xl")
                if url:
                    CACHE.set_track(cache_key, url)
                    return url
    except Exception as e:
        debug_log(f"Artwork (Deezer) bypass: {e}")

    return None
