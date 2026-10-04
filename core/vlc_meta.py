"""VLC HTTP-interface source: parse status.json and build command URLs.

VLC 3.x does not broadcast to Windows SMTC; its Lua HTTP interface is the
supported integration point. When enabled (Preferences > Interface > Main
interfaces: "Web", plus a password under Lua HTTP), VLC serves
``/requests/status.json`` with the playing file's tags, position and length.

This module is pure (no I/O) so the payload parsing is unit-testable; the
polling and command dispatch live in core/vlc_source.py and paprika_app.py.
"""
from __future__ import annotations

import base64
import re
from dataclasses import dataclass

from core.metadata import normalize_weak_title

DEFAULT_PORT = 8080
# Poll interval while VLC is playing / paused / absent (seconds).
POLL_PLAYING = 0.7
POLL_IDLE = 2.0


@dataclass(frozen=True)
class VlcState:
    """Normalised snapshot of one status.json read."""
    playing: bool = False
    title: str = ""
    artist: str = ""
    album: str = ""
    filename: str = ""
    length_ms: float | None = None
    position_ms: float | None = None


def parse_status(data, now_ms: float | None = None) -> VlcState:
    """Tolerant status.json -> VlcState. Accepts None/garbage, returns empty."""
    if not isinstance(data, dict):
        return VlcState()

    state = (data.get("state") or "").strip().lower()
    playing = state == "playing"

    info = data.get("information") or {}
    if not isinstance(info, dict):
        info = {}
    meta = info.get("category") or {}
    if not isinstance(meta, dict):
        meta = {}
    meta = meta.get("meta") or {}
    if not isinstance(meta, dict):
        meta = {}

    def text(*keys: str) -> str:
        for key in keys:
            value = meta.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    raw_title = text("title", "Title")
    raw_artist = text("artist", "Artist")
    album = text("album", "Album")
    filename = text("filename")

    # Untagged files: VLC reports only the filename. Repair the same way the
    # SMTC path does so "07 - Artist - Title.mp3" still resolves lyrics.
    if not raw_artist or not raw_title:
        stem_title, stem_artist, _src = normalize_weak_title(
            filename or raw_title, raw_artist)
        if not raw_title:
            raw_title = stem_title
        if not raw_artist:
            raw_artist = stem_artist

    length = data.get("length")
    length_ms = float(length) * 1000.0 if isinstance(length, (int, float)) and length > 0 else None

    position_ms = None
    if isinstance(now_ms, (int, float)) and now_ms >= 0:
        position_ms = float(now_ms)
    elif isinstance(data.get("time"), (int, float)):
        position_ms = float(data["time"]) * 1000.0

    return VlcState(
        playing=playing,
        title=raw_title,
        artist=raw_artist,
        album=album,
        filename=filename,
        length_ms=length_ms,
        position_ms=position_ms,
    )


def auth_header(password: str) -> str:
    """VLC's HTTP interface uses HTTP Basic auth with ANY username."""
    token = base64.b64encode(f":{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def build_status_url(host: str, port: int = DEFAULT_PORT) -> str:
    host = (host or "127.0.0.1").strip() or "127.0.0.1"
    if "://" not in host:
        host = "http://" + host
    return f"{host.rstrip('/')}:{int(port)}/requests/status.json"


def build_command_url(base_url: str, command: str, **params) -> str:
    """Command URL, e.g. pl_play / pl_pause / pl_next / pl_previous / seek."""
    query = f"command={command}"
    for key, value in params.items():
        query += f"&{key}={_qs(str(value))}"
    sep = "&" if "?" in base_url else "?"
    return base_url + sep + query


def _qs(value: str) -> str:
    from urllib.parse import quote
    return quote(value, safe="")
