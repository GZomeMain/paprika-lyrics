import json
import os
import threading
import time
from pathlib import Path
from config import CACHE_FILE, CACHE_TTL_SECONDS

class CacheManager:
    """
    Thread-safe, bounded LRU cache manager with debounced atomic disk persistence.
    Protects against disk thrashing and unbounded cache file growth.
    """

    MAX_LYRICS_ENTRIES = 250      # Rich syllable timing trees (~1-2MB total)
    MAX_TRACK_ENTRIES = 800       # Spotify ID string mappings
    MAX_LATENCY_ENTRIES = 800     # Track latency offsets
    MAX_TTML_BINDINGS = 500       # Track -> local TTML file choices

    def __init__(self, filepath: Path = CACHE_FILE):
        self.filepath = filepath
        self._lock = threading.RLock()
        self._save_timer: threading.Timer | None = None
        # NOTE: expiry is pruned lazily (on access and at flush time). Pruning here
        # would turn a plain `import storage` into a cache-file rewrite.
        self._data = self._load()

    def _load(self) -> dict:
        default_structure = {
            "tracks": {}, "lyrics": {}, "latency_ms": {}, "window": {},
            # Local TTML library: the index of the files on disk and the user's
            # per-track choice of file. Kept apart from `lyrics` because a local
            # file is authoritative and re-read from disk, never cached.
            "ttml": {"files": {}, "bindings": {}},
        }
        if not self.filepath.exists():
            return default_structure
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    for k in default_structure:
                        data.setdefault(k, {})
                    return data
        except Exception as exc:
            print(f"⚠️ [Storage] Failed to read cache, reinitializing: {exc}")
        return default_structure

    def _save_atomic(self):
        """Atomic write: writes to temporary file first, then atomically replaces target."""
        tmp_file = self.filepath.with_suffix(".tmp")
        try:
            with open(tmp_file, "w", encoding="utf-8") as f:
                json.dump(self._data, f, indent=2)
            os.replace(tmp_file, self.filepath)
        except Exception as exc:
            print(f"⚠️ [Storage] Cache flush failed: {exc}")

    def _schedule_save(self, delay: float = 0.5):
        """Debounces disk writes so rapid updates flush once within `delay` seconds."""
        if self._save_timer:
            self._save_timer.cancel()
        self._save_timer = threading.Timer(delay, self.flush)
        self._save_timer.daemon = True
        self._save_timer.start()

    def flush(self):
        """Explicitly flushes in-memory cache to disk immediately (thread-safe)."""
        with self._lock:
            if self._save_timer:
                self._save_timer.cancel()
                self._save_timer = None
            # Drop anything that aged out while the app was running.
            self._prune_expired_lyrics(self._data)
            self._save_atomic()

    def flush_sync(self) -> bool:
        """
        Flush for process shutdown, and the one call that cannot be debounced.

        Every write in this class is scheduled through a `threading.Timer` so a
        burst of updates lands as one disk write. That is right while the app is
        running and wrong at the end of it: a timer that has not fired yet is
        lost when the process exits, and the state most likely to be pending is
        the state the user just changed by hand — a local TTML binding, or the
        "online lyrics for this song" marker that stops an auto-match from taking
        the song back. So this cancels the pending timer and writes NOW.

        Returns whether the write succeeded. It never raises: it is called from
        the window's close handler, where an exception would replace a clean exit
        with a crash.
        """
        try:
            self.flush()
            return True
        except Exception as exc:
            print(f"⚠️ [Storage] Final cache flush failed: {exc}")
            return False

    # =========================================================================
    # Track ID Resolution Cache (Bounded LRU)
    # =========================================================================
    def get_track(self, cache_key: str) -> str | None:
        with self._lock:
            tracks = self._data["tracks"]
            if cache_key in tracks:
                # Mark as recently used by moving to end
                val = tracks.pop(cache_key)
                tracks[cache_key] = val
                return val
            return None

    def set_track(self, cache_key: str, track_id: str):
        with self._lock:
            tracks = self._data["tracks"]
            if cache_key in tracks:
                del tracks[cache_key]
            elif len(tracks) >= self.MAX_TRACK_ENTRIES:
                # Evict oldest entry
                oldest = next(iter(tracks))
                del tracks[oldest]

            tracks[cache_key] = track_id
            self._schedule_save()

    # =========================================================================
    # Synced Lyrics Cache (Bounded LRU + TTL)
    # =========================================================================
    def _is_expired(self, payload: dict, max_age_s: int | None = None) -> bool:
        """A lyric payload is stale when it predates the configured TTL."""
        max_age = CACHE_TTL_SECONDS if max_age_s is None else max_age_s
        if max_age <= 0:
            return False
        saved_at = payload.get("saved_at")
        if not isinstance(saved_at, (int, float)):
            # Legacy entries (pre-TTL) are treated as expired so they get refreshed once.
            return True
        return (time.time() - saved_at) > max_age

    def _prune_expired_lyrics(self, data: dict) -> bool:
        """Drops every expired lyric entry. Returns True if anything was removed."""
        lyrics_map = data.get("lyrics")
        if not isinstance(lyrics_map, dict) or not lyrics_map:
            return False
        stale = [k for k, v in lyrics_map.items() if not isinstance(v, dict) or self._is_expired(v)]
        for k in stale:
            del lyrics_map[k]
        return bool(stale)

    def get_lyrics(self, cache_key: str, required_version: int, max_age_s: int | None = None) -> dict | None:
        with self._lock:
            lyrics_map = self._data["lyrics"]
            payload = lyrics_map.get(cache_key)
            if not payload:
                return None
            if payload.get("parser_version") != required_version or self._is_expired(payload, max_age_s):
                # Version bump or expiry: evict so a fresh copy is fetched.
                del lyrics_map[cache_key]
                self._schedule_save()
                return None
            # Refresh LRU positioning
            val = lyrics_map.pop(cache_key)
            lyrics_map[cache_key] = val
            return val

    def set_lyrics(self, cache_key: str, payload: dict):
        with self._lock:
            lyrics_map = self._data["lyrics"]
            payload = dict(payload)
            payload["saved_at"] = time.time()
            if cache_key in lyrics_map:
                del lyrics_map[cache_key]
            elif len(lyrics_map) >= self.MAX_LYRICS_ENTRIES:
                oldest = next(iter(lyrics_map))
                del lyrics_map[oldest]

            lyrics_map[cache_key] = payload
            self._schedule_save()

    def drop_lyrics(self, cache_key: str) -> bool:
        """Evicts one lyric payload. Used when a cached copy fails validation."""
        with self._lock:
            if cache_key in self._data["lyrics"]:
                del self._data["lyrics"][cache_key]
                self._schedule_save()
                return True
            return False

    def scrub_lyrics(self, required_version: int | None = None) -> int:
        """
        Sweeps out lyric payloads the current parser cannot trust: entries from an
        older PARSER_VERSION, anything past its TTL, and malformed entries.

        `get_lyrics` already evicts these, but only for the exact key being read.
        Without a sweep, one stale generation of payloads per parser change lingers
        on disk forever, keeping the cache file saturated with dead weight. Returns
        the number of entries removed.
        """
        with self._lock:
            lyrics_map = self._data.get("lyrics")
            if not isinstance(lyrics_map, dict) or not lyrics_map:
                return 0
            stale = [
                key for key, payload in lyrics_map.items()
                if not isinstance(payload, dict)
                or (required_version is not None
                    and payload.get("parser_version") != required_version)
                or self._is_expired(payload)
            ]
            for key in stale:
                del lyrics_map[key]
            if stale:
                self._schedule_save()
            return len(stale)

    # =========================================================================
    # Latency Offset Cache
    # =========================================================================
    def get_latency(self, track_key: str, default_ms: int) -> int:
        with self._lock:
            return self._data["latency_ms"].get(track_key, default_ms)

    def set_latency(self, track_key: str, offset_ms: int):
        with self._lock:
            latencies = self._data["latency_ms"]
            clamped = max(-3000, min(3000, int(offset_ms)))
            if track_key in latencies:
                del latencies[track_key]
            elif len(latencies) >= self.MAX_LATENCY_ENTRIES:
                oldest = next(iter(latencies))
                del latencies[oldest]

            latencies[track_key] = clamped
            self._schedule_save(delay=0.4)

    # =========================================================================
    # Local TTML Library (index + per-track bindings)
    # =========================================================================
    def _ttml(self) -> dict:
        section = self._data.get("ttml")
        if not isinstance(section, dict):
            section = {"files": {}, "bindings": {}}
            self._data["ttml"] = section
        section.setdefault("files", {})
        section.setdefault("bindings", {})
        return section

    def get_ttml_files(self) -> dict:
        """Copy of the library index (entries are copied too, so callers may
        annotate them for the UI without touching persisted state)."""
        with self._lock:
            files = self._ttml().get("files") or {}
            return {k: dict(v) for k, v in files.items() if isinstance(v, dict)}

    def set_ttml_files(self, files: dict):
        """Replaces the whole index. The library owns it and always writes the
        complete, reconciled set — a merge would let deleted files linger."""
        with self._lock:
            self._ttml()["files"] = {
                k: dict(v) for k, v in (files or {}).items() if isinstance(v, dict)
            }
            self._schedule_save(delay=0.6)

    def drop_ttml_file(self, key: str) -> bool:
        with self._lock:
            files = self._ttml().get("files") or {}
            if key in files:
                del files[key]
                self._schedule_save(delay=0.4)
                return True
            return False

    def ttml_bindings(self) -> dict:
        with self._lock:
            bindings = self._ttml().get("bindings") or {}
            return {
                k: (dict(v) if isinstance(v, dict) else v)
                for k, v in bindings.items()
            }

    def set_ttml_binding(self, track_key: str, file: str, enabled: bool = True):
        """
        Records which local TTML file a track uses.

        `enabled=False` is a real state, not the absence of one: it is how a
        user says "online lyrics for this song" and keeps the auto-match from
        quietly taking the song back on the next launch.
        """
        with self._lock:
            bindings = self._ttml()["bindings"]
            if track_key in bindings:
                del bindings[track_key]
            elif len(bindings) >= self.MAX_TTML_BINDINGS:
                oldest = next(iter(bindings))
                del bindings[oldest]
            bindings[track_key] = {"file": str(file or ""), "enabled": bool(enabled)}
            self._schedule_save(delay=0.4)

    def drop_ttml_binding(self, track_key: str) -> bool:
        with self._lock:
            bindings = self._ttml().get("bindings") or {}
            if track_key in bindings:
                del bindings[track_key]
                self._schedule_save(delay=0.4)
                return True
            return False

    def prune_ttml_bindings(self, valid_files) -> int:
        """Drops bindings whose file is gone. Marker-only (disabled) entries are
        kept: they name no file, and forgetting them would restore a match the
        user explicitly turned off."""
        valid = {str(f) for f in (valid_files or ())}
        with self._lock:
            bindings = self._ttml().get("bindings") or {}
            stale = [
                key for key, value in bindings.items()
                if isinstance(value, dict) and value.get("file") and value["file"] not in valid
            ]
            for key in stale:
                del bindings[key]
            if stale:
                self._schedule_save(delay=0.6)
            return len(stale)

    # =========================================================================
    # Window Geometry Persistence
    # =========================================================================
    def get_window_geometry(self) -> dict:
        with self._lock:
            return dict(self._data.get("window", {}))

    def save_window_size(self, width: int, height: int):
        with self._lock:
            win = self._data.setdefault("window", {})
            win["width"] = width
            win["height"] = height
            self._schedule_save(delay=0.6)

    def save_window_position(self, x: int | None, y: int | None):
        with self._lock:
            win = self._data.setdefault("window", {})
            if x is not None and y is not None:
                win["x"] = x
                win["y"] = y
                self._schedule_save(delay=0.6)

    # The mini (lyrics-only) player is the same window at a much smaller size, so
    # its size lives beside the normal one, under window["mini"]. Keeping them
    # separate means leaving mini restores the size the user had before it, and
    # closing the app while mini never boots the next launch into a stub window.
    def save_mini_size(self, width: int, height: int):
        with self._lock:
            win = self._data.setdefault("window", {})
            win["mini"] = {"width": int(width), "height": int(height)}
            self._schedule_save(delay=0.6)

    def get_mini_size(self) -> dict:
        with self._lock:
            mini = self._data.get("window", {}).get("mini") or {}
            return dict(mini)

CACHE = CacheManager()