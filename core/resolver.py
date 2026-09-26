import re
import threading
import time
import requests
from config import debug_log
from storage import CACHE
from core.metadata import extract_clean_metadata

# Zero-auth Spotify Scraper. A single client is shared across resolver threads,
# so all calls are serialized by this lock to avoid concurrent-session corruption.
try:
    from spotify_scraper import SpotifyClient
    SPOTIFY_SCRAPER_AVAILABLE = True
    SCRAPER_CLIENT = SpotifyClient()
except ImportError:
    SPOTIFY_SCRAPER_AVAILABLE = False
    SCRAPER_CLIENT = None

SCRAPER_LOCK = threading.Lock()

SPOTIFY_ID_REGEX = re.compile(r"^[a-zA-Z0-9]{22}$")
ODESLI_BLOCKED_UNTIL = 0

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

def query_odesli(url_or_id: str, platform: str | None = None) -> str | None:
    global ODESLI_BLOCKED_UNTIL
    if time.time() < ODESLI_BLOCKED_UNTIL:
        return None

    try:
        clean_url = re.sub(r"&uo=\d+", "", url_or_id)
        if clean_url.startswith("http"):
            res = http_get("https://api.song.link/v1-alpha.1/links", params={"url": clean_url})
        elif platform:
            res = http_get(
                "https://api.song.link/v1-alpha.1/links",
                params={"platform": platform, "type": "song", "id": url_or_id, "userCountry": "US"}
            )
        else:
            return None

        if res and res.status_code == 200:
            data = res.json()
            spotify_link = data.get("linksByPlatform", {}).get("spotify", {})
            spotify_url = spotify_link.get("url", "")
            if spotify_url:
                match = re.search(r"track/([a-zA-Z0-9]{22})", spotify_url)
                if match:
                    return match.group(1)
            for uid in data.get("entitiesByUniqueId", {}).keys():
                if uid.startswith("SPOTIFY_SONG::"):
                    candidate = uid.split("::")[-1]
                    if SPOTIFY_ID_REGEX.match(candidate):
                        return candidate
        elif res and res.status_code == 429:
            print("   ⚠️ [Odesli] Rate limit hit. Cooling down for 60s.")
            ODESLI_BLOCKED_UNTIL = time.time() + 60
    except Exception:
        pass
    return None

def resolve_spotify_track_id(raw_title: str, raw_artist: str,
                             album: str | None = None) -> str | None:
    """
    Resolves Spotify Track ID through multi-tiered resolution:
    Cache -> SpotifyScraper -> Apple Music (iTunes + Odesli) -> Deezer (+ Odesli)

    `album` sharpens the scraper search term and the cache key when present;
    omitting it keeps the legacy cache-key shape so existing entries stay valid.
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

    # Tier 1: Direct Spotify Scraper
    if SPOTIFY_SCRAPER_AVAILABLE and SCRAPER_CLIENT:
        try:
            search_query = f"{c_title} {artist_query}".strip()
            if album:
                search_query = f"{search_query} {album}".strip()
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

    # Tier 2: Apple Music Search + Odesli
    try:
        it_res = http_get(
            "https://itunes.apple.com/search",
            params={"term": f"{c_title} {artist_query}", "media": "music", "entity": "song", "limit": 2}
        )
        if it_res and it_res.status_code == 200:
            for item in it_res.json().get("results", []):
                apple_url = item.get("trackViewUrl")
                if apple_url:
                    sid = query_odesli(apple_url)
                    if sid:
                        print(f"   ✅ [Apple/Odesli Match] Found ID: {sid}")
                        CACHE.set_track(cache_key, sid)
                        return sid
    except Exception as e:
        debug_log(f"Tier 2 (Apple) bypass: {e}")

    # Tier 3: Deezer Search + Odesli
    try:
        dz_res = http_get(
            "https://api.deezer.com/search",
            params={"q": f"{c_title} {artist_query}", "limit": 2}
        )
        if dz_res and dz_res.status_code == 200:
            for item in dz_res.json().get("data", []):
                dz_url = item.get("link")
                if dz_url:
                    sid = query_odesli(dz_url)
                    if sid:
                        print(f"   ✅ [Deezer/Odesli Match] Found ID: {sid}")
                        CACHE.set_track(cache_key, sid)
                        return sid
    except Exception as e:
        debug_log(f"Tier 3 (Deezer) bypass: {e}")

    print(f"   ❌ [Resolver] Exhausted all resolution tiers for '{c_title}'.")
    return None


def resolve_artwork_url(raw_title: str, raw_artist: str) -> str | None:
    """
    Resolves a hi-res (1000x1000 or larger) artwork URL for the background bloom.
    Independent of track-ID resolution: it only needs the artwork, so it goes
    straight to the sources that expose it and never touches Odesli. The iTunes
    and Deezer search responses already carry the URL; we just keep it.
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