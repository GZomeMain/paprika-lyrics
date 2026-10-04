import re

def extract_clean_metadata(raw_title: str, raw_artist: str) -> tuple[str, str, str]:
    """
    Cleans noisy YouTube Music metadata, removing video labels, bracketed noise,
    and featuring artists to maximize resolution hit rates on Spotify and Apple Music.
    Returns: (cleaned_title, primary_artist, full_artist)
    """
    title = (raw_title or "").strip()
    artist = (raw_artist or "").strip()

    # Normalize full-width Asian brackets to standard brackets
    title = title.replace("【", "[").replace("】", "]").replace("（", "(").replace("）", ")")

    # Strip bracketed metadata noise
    bracket_noise = (
        r"[\(\[\{]\s*(?:official\s*(?:music\s*)?video|official\s*audio|visualizer|"
        r"lyrics?(\s*video)?|music\s*video|audio|mv|hd|4k|remaster(?:ed)?(?:\s*\d{4})?|"
        r"deluxe|bonus\s*track|explicit|clean)\s*[\)\]\}]"
    )
    title = re.sub(bracket_noise, "", title, flags=re.IGNORECASE)
    
    # Remove bracketed features e.g. "(feat. Drake)"
    title = re.sub(r"[\(\[\{]\s*(?:feat\.|ft\.).*?[\)\]\}]", "", title, flags=re.IGNORECASE)
    
    # Remove inline features e.g. "feat. Drake"
    title = re.sub(r"\b(?:feat\.|ft\.)\s+.*", "", title, flags=re.IGNORECASE)
    title = re.sub(r"\b(?:official\s*video|official\s*audio|music\s*video|audio|lyrics)\b\s*$", "", title, flags=re.IGNORECASE)

    # Clean artist noise
    artist = re.sub(r"\s*-\s*topic$", "", artist, flags=re.IGNORECASE).strip()
    artist = re.sub(r"\b(?:feat\.|ft\.).*", "", artist, flags=re.IGNORECASE).strip()

    # If title starts with the artist name, strip it
    if artist:
        title = re.sub(rf"^{re.escape(artist)}\s*[-:|]\s*", "", title, flags=re.IGNORECASE)

    # Handle "Artist - Title" formatted titles
    if " - " in title:
        parts = title.split(" - ", 1)
        if artist and parts[0].strip().lower() == artist.lower():
            title = parts[1].strip()
        elif not artist:
            artist = parts[0].strip()
            title = parts[1].strip()

    title = re.sub(r"\s+", " ", title).strip(" -_[](){}:|")
    primary_artist = re.split(r"[,/&]", artist)[0].strip() if artist else ""

    return title, primary_artist, artist


# Common audio extensions a player may leave inside the broadcast title when
# it is really a filename stem.
_AUDIO_EXT_PATTERN = re.compile(
    r"\.(?:mp3|flac|ogg|oga|m4a|mp4|wav|wma|opus|aac|alac|aiff?|ape|dsf)\s*$",
    re.IGNORECASE,
)
_TRACK_NUM_PATTERN = re.compile(r"^(\d{1,3})\s*[-._)\]]?\s+(.+)$")


def strip_audio_extension(text: str) -> str:
    """Removes a trailing audio-file extension, e.g. 'song.mp3' -> 'song'."""
    return _AUDIO_EXT_PATTERN.sub("", (text or "").strip()).strip()


def split_track_number_prefix(text: str) -> tuple[int | None, str]:
    """Splits a leading track number: '01 - Artist - Title' -> (1, 'Artist - Title')."""
    m = _TRACK_NUM_PATTERN.match((text or "").strip())
    if not m:
        return None, (text or "").strip()
    return int(m.group(1)), m.group(2).strip()


def track_cache_key(title: str, artist: str, duration_ms: float | None = None,
                    album: str | None = None) -> str:
    """
    The stable identity of one recording, shared by every store that keys
    something to a track: the lyrics cache, the per-track sync offset, and the
    local-TTML bindings.

    A coarse duration bucket and (when present) the album keep two different
    recordings that share a title/artist from colliding — remasters, live
    versions, same-name singles. Omitting the album keeps the legacy key shape,
    so entries written before it existed remain reachable.
    """
    # str() because these arrive over the JS bridge, where a numeric album tag
    # (or a missing one) is entirely possible.
    base = f"{str(title or '').strip()}___{str(artist or '').strip()}".lower()
    album = str(album or "").strip()
    if album:
        base = f"{base}___{album.lower()}"
    if duration_ms and duration_ms > 0:
        return f"{base}___{int(round(duration_ms / 1000.0))}s"
    return base


def normalize_weak_title(title: str, artist: str) -> tuple[str, str, str]:
    """
    Repairs weak local-file metadata (players that broadcast filename stems).

    Returns (cleaned_title, cleaned_artist, source). `source` is "smtc" when
    the input already looked like real tags, and "filename" when repair fired
    — the diagnostics layer reports it so users can see why a lookup missed.
    Well-tagged input is passed through `extract_clean_metadata` unchanged.
    """
    raw_title, raw_artist = (title or "").strip(), (artist or "").strip()

    # Looks like real tags: nothing to repair beyond the standard clean.
    if raw_artist and not _AUDIO_EXT_PATTERN.search(raw_title):
        c_title, primary, _full = extract_clean_metadata(raw_title, raw_artist)
        return c_title, primary, "smtc"

    repaired = strip_audio_extension(raw_title)
    _track_no, repaired = split_track_number_prefix(repaired)

    # Underscore filenames ('nightcall_kavinsky') carry structure the player
    # lost: with no artist tag, the last underscore-separated segment is the
    # artist far more often than part of the title.
    inferred_artist = raw_artist
    if "_" in repaired and not raw_artist:
        stem, _, tail = repaired.rpartition("_")
        if stem and tail:
            repaired, inferred_artist = stem, tail

    repaired = repaired.replace("_", " ")
    repaired = re.sub(r"\s+", " ", repaired).strip()

    c_title, primary_artist, _full = extract_clean_metadata(repaired, inferred_artist)
    source = "smtc" if (raw_artist and c_title == raw_title) else "filename"
    return c_title, primary_artist, source