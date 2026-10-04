"""Pure metadata model for the media session.

Turns the raw GSMTC media-properties object into a `MediaMeta` value and
repairs weak metadata from local-file players. Kept free of winsdk so the
whole model is unit-testable on any platform; `core.smtc` stays a thin I/O
wrapper.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from core.metadata import extract_clean_metadata

# Album values that identify a source or a playlist rather than a real album;
# searching with them actively hurts match rates.
_NOISE_ALBUMS = {
    "various artists", "va", "unknown album", "unknown", "singles",
    "youtube search", "youtube", "spotify", "local files", "music",
}


@dataclass(frozen=True)
class MediaMeta:
    raw_title: str = ""
    raw_artist: str = ""
    album: str = ""
    subtitle: str = ""
    track_number: int | None = None
    duration_ms: float | None = None
    metadata_source: str = "smtc"   # "smtc" | "filename" | "partial"


def media_meta_from_smtc(info, duration_ms: float | None = None) -> MediaMeta:
    """Reads the fields this app uses off the GSMTC media-properties object.

    Duck-typed on purpose: `info` may be a real WinRT object, a
    SimpleNamespace in tests, or None. Every field access is guarded because
    players differ wildly in what they broadcast.
    """
    if info is None:
        return MediaMeta(duration_ms=duration_ms, metadata_source="partial")

    def text(attr: str) -> str:
        value = getattr(info, attr, None)
        return value.strip() if isinstance(value, str) else ""

    raw_title, raw_artist = text("title"), text("artist")
    track_number = getattr(info, "trackNumber", None)
    if isinstance(track_number, bool) or not isinstance(track_number, int) or track_number <= 0:
        track_number = None

    source = "smtc" if (raw_title and raw_artist) else "partial"
    return MediaMeta(
        raw_title=raw_title,
        raw_artist=raw_artist,
        album=text("albumTitle"),
        subtitle=text("subtitle"),
        track_number=track_number,
        duration_ms=duration_ms,
        metadata_source=source,
    )


_BRACKETED_TAIL = re.compile(r"\s*[\(\[\{].*[\)\]\}]\s*$")


def album_for_search(meta: MediaMeta) -> str:
    """The album name cleaned for API search, or "" when it would hurt.

    Any trailing bracketed segment ("(Deluxe Edition)", "[Remastered]") is
    edition noise for search purposes and is dropped wholesale —
    extract_clean_metadata alone only strips a known keyword list, which would
    leave e.g. 'MAYHEM (Deluxe Edition' half-stripped behind.
    """
    album = (meta.album or "").strip()
    if not album:
        return ""
    cleaned = _BRACKETED_TAIL.sub("", album).strip()
    cleaned = extract_clean_metadata(cleaned, "")[0]
    if not cleaned or cleaned.lower() in _NOISE_ALBUMS:
        return ""
    return cleaned


def build_track_signature(meta: MediaMeta, app_id: str) -> str:
    """Stable identity of the playing track.

    Album and duration join title/artist because same-name tracks on
    different albums (remasters, live vs studio) previously reused the old
    track's lyrics without a reload.
    """
    duration = int(meta.duration_ms or 0)
    return f"{app_id}:::{meta.raw_title}:::{meta.raw_artist}:::{meta.album}:::{duration}"
