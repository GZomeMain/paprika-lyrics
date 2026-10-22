"""Canonical Media Source Realization & Detection.

Classifies Windows SystemMediaTransportControls (GSMTC) AppUserModelIDs, process names,
and media session descriptors into rich, normalized source metadata with brand names,
SVG-ready icon identifiers, and baseline audio pipeline latency compensation.
"""

from __future__ import annotations
from dataclasses import asdict, dataclass
import re

@dataclass(frozen=True)
class SourceInfo:
    id: str                   # Canonical unique key: "spotify", "simpmusic", "youtube", "browser", "vlc", etc.
    group: str                # Grouping key for profile binding: "spotify", "simpmusic", "browser", "vlc", "apple_music", "local", "generic"
    name: str                 # Human-friendly display name: "Spotify", "SimpMusic", "YouTube (Chrome)", "VLC", etc.
    icon: str                 # Icon key for UI: "spotify", "simpmusic", "youtube", "browser", "vlc", "apple", "generic"
    default_latency_ms: int   # Baseline audio buffer latency (e.g. +180ms for Chrome/YouTube, 0ms for Spotify)
    is_browser: bool          # Whether playback occurs in a web browser
    raw_app_id: str           # The original raw AUMID or process path from Windows


# Common browser executable and AUMID patterns
_BROWSER_PATTERNS = [
    (re.compile(r"chrome(?:\.exe)?", re.I), "Chrome", "browser"),
    (re.compile(r"msedge(?:\.exe)?|microsoft\.edge", re.I), "Edge", "browser"),
    (re.compile(r"firefox(?:\.exe)?|mozilla\.firefox", re.I), "Firefox", "browser"),
    (re.compile(r"brave(?:\.exe)?", re.I), "Brave", "browser"),
    (re.compile(r"opera(?:\.exe)?", re.I), "Opera", "browser"),
    (re.compile(r"vivaldi(?:\.exe)?", re.I), "Vivaldi", "browser"),
]


def detect_source(raw_app_id: str | None, title: str = "", artist: str = "") -> SourceInfo:
    """Classifies an SMTC session into a normalized SourceInfo descriptor."""
    app = str(raw_app_id or "").strip()
    low = app.lower()
    title_low = (title or "").lower()

    # 1. Spotify (Desktop Win32 or Windows Store App)
    if "spotify" in low:
        return SourceInfo(
            id="spotify",
            group="spotify",
            name="Spotify",
            icon="spotify",
            default_latency_ms=0,
            is_browser=False,
            raw_app_id=app,
        )

    # 2. SimpMusic (YouTube Music Client)
    if "simpmusic" in low or "brahmkshatriya" in low:
        return SourceInfo(
            id="simpmusic",
            group="simpmusic",
            name="SimpMusic",
            icon="simpmusic",
            default_latency_ms=120,
            is_browser=False,
            raw_app_id=app,
        )

    # 3. Apple Music
    if "applemusic" in low or "appleinc.applemusic" in low:
        return SourceInfo(
            id="apple_music",
            group="apple_music",
            name="Apple Music",
            icon="apple",
            default_latency_ms=50,
            is_browser=False,
            raw_app_id=app,
        )

    # 4. VLC Media Player
    if "vlc" in low:
        return SourceInfo(
            id="vlc",
            group="vlc",
            name="VLC Media Player",
            icon="vlc",
            default_latency_ms=0,
            is_browser=False,
            raw_app_id=app,
        )

    # 5. Foobar2000
    if "foobar" in low:
        return SourceInfo(
            id="foobar2000",
            group="local",
            name="Foobar2000",
            icon="music",
            default_latency_ms=0,
            is_browser=False,
            raw_app_id=app,
        )

    # 6. Tidal
    if "tidal" in low:
        return SourceInfo(
            id="tidal",
            group="streaming",
            name="TIDAL",
            icon="music",
            default_latency_ms=0,
            is_browser=False,
            raw_app_id=app,
        )

    # 7. Web Browsers (Chrome, Edge, Firefox, Brave, etc.)
    for pattern, browser_name, icon_name in _BROWSER_PATTERNS:
        if pattern.search(low):
            # Check if playing YouTube or YouTube Music in the browser
            is_youtube = "youtube" in title_low or "youtube" in (artist or "").lower()
            if is_youtube:
                return SourceInfo(
                    id=f"youtube_{browser_name.lower()}",
                    group="browser",
                    name=f"YouTube ({browser_name})",
                    icon="youtube",
                    default_latency_ms=180,
                    is_browser=True,
                    raw_app_id=app,
                )
            return SourceInfo(
                id=f"browser_{browser_name.lower()}",
                group="browser",
                name=f"{browser_name} Media",
                icon="browser",
                default_latency_ms=180,
                is_browser=True,
                raw_app_id=app,
            )

    # 8. Windows Media Player / Groove
    if "zunemusic" in low or "windows.media" in low or "wmplayer" in low:
        return SourceInfo(
            id="windows_media",
            group="local",
            name="Windows Media Player",
            icon="music",
            default_latency_ms=0,
            is_browser=False,
            raw_app_id=app,
        )

    # 9. Generic Fallback
    # Derive a readable name from filename or bundle if possible
    clean_name = "Media Player"
    if app:
        # Strip path or package hashes if present
        tail = app.split("\\")[-1].split("/")[-1].split("!")[-1]
        tail = re.sub(r"\.(exe|app)$", "", tail, flags=re.I)
        if tail:
            clean_name = tail.capitalize()

    return SourceInfo(
        id="generic",
        group="generic",
        name=clean_name,
        icon="generic",
        default_latency_ms=0,
        is_browser=False,
        raw_app_id=app,
    )


def source_to_dict(source: SourceInfo) -> dict:
    """Serializes SourceInfo to a JSON-ready dictionary."""
    return asdict(source)
