"""VLC HTTP-interface polling source (I/O side).

Complements the SMTC listener: VLC 3.x never appears in GSMTC, so when no
media session exists the bridge polls VLC's status.json instead and feeds the
same evaluate_js entry points the SMTC path uses. Kept in its own module so
core/smtc.py stays the SMTC specialist and everything VLC-specific (including
its errors) is contained here.
"""
from __future__ import annotations

import threading
import time

import requests

from config import debug_log
from core.vlc_meta import (
    POLL_IDLE,
    POLL_PLAYING,
    VlcState,
    auth_header,
    build_status_url,
    parse_status,
)

# One shared session; VLC's interface is single-threaded per client.
_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": "PaprikaLyrics/1.0"})


class VlcSource:
    """Polls VLC's HTTP interface; remembers the last state for dedupe."""

    def __init__(self, password: str = "", host: str = "127.0.0.1", port: int = 8080):
        self.password = password
        self.status_url = build_status_url(host, port)
        self.last_state: VlcState | None = None
        self.consecutive_failures = 0
        self.lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.password)

    def poll(self) -> VlcState | None:
        """One status read. None when VLC is unreachable/unconfigured."""
        if not self.configured:
            return None
        try:
            res = _SESSION.get(
                self.status_url,
                headers={"Authorization": auth_header(self.password)},
                timeout=1.2,
            )
            if res.status_code != 200:
                raise RuntimeError(f"HTTP {res.status_code}")
            self.consecutive_failures = 0
            state = parse_status(res.json(), now_ms=None)
            with self.lock:
                self.last_state = state
            return state
        except Exception as exc:
            self.consecutive_failures += 1
            if self.consecutive_failures == 1 or self.consecutive_failures % 30 == 0:
                debug_log("VLC poll failed:", exc)
            return None

    def changed_track(self, state: VlcState) -> bool:
        """True when this state is a different track than the last pushed one."""
        prev = self.last_state
        if prev is None:
            return True
        return (state.title, state.artist, state.album, state.length_ms) != (
            prev.title, prev.artist, prev.album, prev.length_ms)

    def command(self, command: str, **params) -> None:
        """Fire a playback command (pl_next, seek, ...). Best-effort."""
        if not self.configured:
            return
        from core.vlc_meta import build_command_url
        try:
            _SESSION.get(
                build_command_url(self.status_url, command, **params),
                headers={"Authorization": auth_header(self.password)},
                timeout=1.2,
            )
        except Exception as exc:
            debug_log("VLC command failed:", command, exc)

    def poll_interval(self, state: VlcState | None) -> float:
        return POLL_PLAYING if (state and state.playing) else POLL_IDLE
