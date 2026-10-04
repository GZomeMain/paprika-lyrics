import concurrent.futures
from config import (SPICY_API_KEY, BASE_URL, APP_VERSION, PARSER_VERSION,
                    debug_log, warn_missing_api_key)
from storage import CACHE
from core.metadata import extract_clean_metadata, track_cache_key
from core.resolver import http_get, resolve_spotify_track_id
from core.parser import count_syllables, parse_spicy_body, parse_lrc
from core.ttml_library import TTML_LIBRARY

ASYNC_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=4)

_API_KEY_WARNED = False


def _warn_key_once():
    """Prints the missing-API-key notice at most once per process."""
    global _API_KEY_WARNED
    if not SPICY_API_KEY and not _API_KEY_WARNED:
        _API_KEY_WARNED = True
        warn_missing_api_key()


def _lyrics_cache_key(title: str, artist: str, duration_ms: float | None = None,
                      album: str | None = None) -> str:
    """
    Cache key folding in a coarse duration bucket and (when present) the album,
    so two different tracks sharing a title/artist (remasters, live vs studio,
    same-name singles) never collide. Omitting the album keeps the legacy key
    shape so existing cache entries remain reachable.

    The single implementation lives in `core.metadata`: the same identity keys
    the local-TTML bindings, and two sources of truth for "which recording is
    this" would drift apart exactly where it matters.
    """
    return track_cache_key(title, artist, duration_ms, album)


def fetch_lrclib(title: str, artist: str, duration_ms: float | None = None,
                 album: str | None = None) -> list[dict]:
    # Tier 1: exact LRCLIB lookup (unchanged — adding album here would miss
    # entries whose album metadata disagrees with ours).
    try:
        res = http_get(
            "https://lrclib.net/api/get",
            params={"track_name": title, "artist_name": artist},
        )
        if res and res.status_code == 200:
            data = res.json()
            if isinstance(data, dict) and data.get("syncedLyrics"):
                return parse_lrc(data["syncedLyrics"])
    except Exception as exc:
        debug_log("LRCLIB exact lookup failed:", exc)

    # Tier 2: fuzzy search. An album-scoped attempt first gives compilations
    # and same-name tracks the right recording; the plain search below is the
    # unchanged fallback that keeps today's hit rate.
    base_params = {"track_name": title, "artist_name": artist}
    if duration_ms and duration_ms > 0:
        base_params["duration"] = int(round(duration_ms / 1000.0))
    attempts = []
    if album:
        album_params = dict(base_params)
        album_params["album_name"] = album
        attempts.append(album_params)
    attempts.append(dict(base_params))

    for params in attempts:
        try:
            res = http_get("https://lrclib.net/api/search", params=params)
            if res and res.status_code == 200:
                results = res.json()
                if isinstance(results, list):
                    candidates = [r for r in results if isinstance(r, dict) and r.get("syncedLyrics")]
                    if duration_ms and duration_ms > 0:
                        target_s = duration_ms / 1000.0
                        candidates.sort(key=lambda r: abs(float(r.get("duration") or 0) - target_s))
                    for item in candidates:
                        lines = parse_lrc(item["syncedLyrics"])
                        if lines:
                            debug_log(f"LRCLIB search matched '{item.get('trackName')}'")
                            return lines
        except Exception as exc:
            debug_log("LRCLIB search failed:", exc)

    return []


def fetch_spicy_with_id(track_id: str, lrclib_lines: list[dict] = None) -> tuple[list[dict], str | None]:
    if track_id and SPICY_API_KEY:
        url = f"{BASE_URL}/v1/lyrics/{track_id}"
        headers = {"Authorization": f"Bearer {SPICY_API_KEY}"}
        print(f"📡 Querying Spicy Lyrics: {url} ...")
        res = http_get(url, headers=headers, timeout=4.5)
        if res and res.status_code == 200:
            try:
                data = res.json()
            except Exception as exc:
                debug_log("Spicy Lyrics returned non-JSON payload:", exc)
                data = None

            # The API may return either a dict envelope or a bare list of lines.
            if isinstance(data, list):
                body = {"Content": data}
            elif isinstance(data, dict):
                body = data.get("Body") or data.get("body")
                if not isinstance(body, dict):
                    body = data
            else:
                body = None

            if not isinstance(body, dict):
                debug_log("Spicy Lyrics returned an unexpected body type:", type(data).__name__)
                return [], None

            try:
                lines, syl_count = parse_spicy_body(body, lrclib_lines=lrclib_lines)
            except Exception as exc:
                # The parser is defensive, but a shape nobody anticipated must
                # degrade to the LRCLIB fallback rather than propagate. A raise
                # here previously aborted the whole track load.
                debug_log("Spicy payload failed to parse:", exc)
                return [], None
            if lines:
                raw_src = body.get("source") or body.get("Source") or "Apple Music"
                source_label = f"Spicy ({raw_src})"
                print(f"   ✨ Loaded {len(lines)} lines with {syl_count} exact syllables! ({raw_src})")
                return lines, source_label
        elif res and res.status_code == 404:
            print(f"   ℹ️ Spicy Lyrics has no synced syllables for Spotify ID {track_id} (HTTP 404).")
        elif res and res.status_code in (401, 403):
            print("   ⚠️ Spicy Lyrics rejected the API key (HTTP %s). Check SPICY_API_KEY." % res.status_code)
    return [], None


# A repeated chorus legitimately reappears many times, but never twice at the same
# millisecond. Three identical lead lines sharing one timestamp is therefore not a
# song structure — it is the fingerprint of several performances being collapsed
# onto a single line's clock.
_DUPLICATE_LINE_THRESHOLD = 3
_MIN_DUPLICATE_TEXT_CHARS = 2


def _lines_look_corrupt(lines: list[dict] | None) -> bool:
    """
    True when a payload repeats the same lead line at the same instant often
    enough that its timings cannot be real.

    PARSER_VERSION is a manual bump, so a payload written by a buggy build can
    still carry a version tag the current parser accepts. Validating the timings
    themselves is what makes a poisoned cache self-heal instead of requiring the
    user to notice the duplication and clear it by hand.
    """
    counts: dict[tuple[int, str], int] = {}
    for line in lines or []:
        if not isinstance(line, dict) or line.get("isBackground"):
            continue
        start_ms = line.get("startTimeMs")
        # Untimed payloads (line-only fallbacks, malformed entries) all sit at 0 and
        # would otherwise look like a pile-up. Only judge real, positive timings.
        if isinstance(start_ms, bool) or not isinstance(start_ms, (int, float)):
            continue
        if start_ms <= 0:
            continue
        text = " ".join(str(line.get("text") or "").split()).casefold()
        if len(text) < _MIN_DUPLICATE_TEXT_CHARS:
            continue
        key = (round(start_ms), text)
        counts[key] = counts.get(key, 0) + 1
        if counts[key] >= _DUPLICATE_LINE_THRESHOLD:
            return True
    return False


def _count_syllables(lines: list[dict]) -> int:
    """Counts timed syllables across a payload; 0 means line-level timing only."""
    return count_syllables(lines)


def _build_diagnostics(source: str, cache: str, lines: list[dict],
                       syllables: int | None = None, track_id: str | None = None,
                       album: str = "", metadata_source: str = "smtc",
                       ttml: str = "", ttml_match: str = "") -> dict:
    """
    Small, user-facing report of how this track's lyrics were obtained. Surfaced
    in the UI so a fallback to line-synced lyrics is explainable without stdout.
    `album` and `metadata_source` report what the player broadcast ("filename"
    means a local file whose tags needed repair).
    """
    syl = _count_syllables(lines) if syllables is None else syllables
    if not lines:
        timing = "None"
    elif syl > 0:
        timing = "Syllable"
    else:
        timing = "Line"
    return {
        "source": source,
        "cache": cache,
        "timing": timing,
        "lines": len(lines or []),
        "syllables": syl,
        "track_id": track_id or "",
        "album": album,
        "metadata": metadata_source,
        # The build that produced this report, next to the version of the payload
        # format it speaks. A user pasting their resolve report has named both.
        "app_version": APP_VERSION,
        "parser_version": PARSER_VERSION,
        "api_key": bool(SPICY_API_KEY),
        # Which local file served this track, and whether the user bound it or
        # its own metadata matched. Empty when no local file was involved.
        "ttml": ttml,
        "ttml_match": ttml_match,
    }


def _local_ttml(title: str, artist: str, duration_ms: float | None, album: str | None):
    """
    The local TTML override for a track, if the library has one.

    Isolated (and defensive) because it sits in front of every other lyric
    source: a broken library folder must cost the user nothing more than the
    fallback to the online pipeline.
    """
    try:
        return TTML_LIBRARY.resolve(title, artist, album, duration_ms)
    except Exception as exc:
        debug_log("Local TTML lookup failed:", exc)
        return None


def fetch_lyrics(title: str, artist: str, duration_ms: float | None = None,
                 album: str | None = None,
                 metadata_source: str = "smtc") -> tuple[list[dict], str, str | None, dict]:
    c_title, primary_artist, _ = extract_clean_metadata(title, artist)
    lyrics_cache_key = _lyrics_cache_key(c_title, primary_artist, duration_ms, album)

    # A local file wins over BOTH the network and the disk cache. It is a
    # deliberate choice the user made about this song, so re-parsing it costs a
    # few milliseconds and returning anything else would ignore them. It is also
    # never written into the lyrics cache: the file stays the source of truth,
    # editable between plays.
    local = _local_ttml(c_title, primary_artist, duration_ms, album)
    if local and local.get("lines"):
        # `lines` is checked, not assumed: a bound file that has since gone
        # empty or unreadable must fall through to the online pipeline rather
        # than blank the lyric view.
        lines = local["lines"]
        syl = _count_syllables(lines)
        source = f"Local TTML ({local['name']})"
        print(f"📁 [Local TTML] '{c_title}' <- {local['name']} "
              f"({len(lines)} lines, {syl} syllables, {local['kind']})")
        return lines, source, None, _build_diagnostics(
            source, "local", lines, syl, None, album=album or "",
            metadata_source=metadata_source,
            ttml=local["file"], ttml_match=local["kind"])

    cached_payload = CACHE.get_lyrics(lyrics_cache_key, PARSER_VERSION)
    if cached_payload and _lines_look_corrupt(cached_payload.get("lines")):
        # Discard rather than serve: a stale payload is always cheaper to lose than
        # to show the user a chorus stamped on top of itself.
        print(f"⚠️ [Lyrics Cache] {c_title!r} had duplicated line timings; refetching.")
        CACHE.drop_lyrics(lyrics_cache_key)
        cached_payload = None

    if cached_payload:
        print(f"⚡ [Lyrics Disk Cache Hit] '{c_title}'")
        cached_lines = cached_payload.get("lines", [])
        cached_source = cached_payload.get("source", "Cached")
        cached_track_id = cached_payload.get("track_id")
        diag = _build_diagnostics(
            cached_source, "hit", cached_lines,
            syllables=cached_payload.get("syllables"), track_id=cached_track_id
        )
        return cached_lines, cached_source, cached_track_id, diag

    print(f"\n======================================")
    print(f"🎵 [SimpMusic Event] '{c_title}' by '{primary_artist}'")

    _warn_key_once()

    lrclib_future = ASYNC_EXECUTOR.submit(
        fetch_lrclib, c_title, primary_artist, duration_ms, album)

    # The Spicy chain (resolve ID -> fetch -> parse) runs as ONE background task,
    # and only waits on LRCLIB at the last moment it is actually needed (parse
    # time, not fetch time). Blocking on `lrclib_future.result()` up front held
    # every track-load hostage to the slower of the two network calls: a slow
    # LRCLIB response delayed the syllable-synced fetch from even starting, even
    # though LRCLIB is only a timing reference for the minority of payloads with
    # flat syllables. Now a slow LRCLIB costs nothing once the Spicy response is
    # in hand — total latency is max(LRCLIB, ID+Spicy) instead of
    # max(LRCLIB, ID) + Spicy.
    def _spicy_chain():
        tid = resolve_spotify_track_id(title, artist, album)
        if not tid:
            return tid, None
        return tid, fetch_spicy_with_id(tid, lrclib_lines=lrclib_future.result())

    spicy_future = ASYNC_EXECUTOR.submit(_spicy_chain)

    track_id, spicy = spicy_future.result()
    lines = source = None
    if spicy:
        lines, source = spicy
    if lines:
            syl_count = _count_syllables(lines)
            CACHE.set_lyrics(lyrics_cache_key, {
                "parser_version": PARSER_VERSION,
                "source": source,
                "lines": lines,
                "track_id": track_id,
                "syllables": syl_count
            })
            return lines, source, track_id, _build_diagnostics(
                source, "miss", lines, syl_count, track_id,
                album=album, metadata_source=metadata_source)

    print("⚠️ Falling back to LRCLIB (Line-only timing)...")
    lrclib_lines = lrclib_future.result()
    if lrclib_lines:
        CACHE.set_lyrics(lyrics_cache_key, {
            "parser_version": PARSER_VERSION,
            "source": "LRCLIB",
            "lines": lrclib_lines,
            "track_id": track_id,
            "syllables": 0
        })
        return lrclib_lines, "LRCLIB", track_id, _build_diagnostics(
            "LRCLIB", "miss", lrclib_lines, 0, track_id,
            album=album, metadata_source=metadata_source)

    return [], "None", track_id, _build_diagnostics(
        "None", "miss", [], 0, track_id,
        album=album, metadata_source=metadata_source)