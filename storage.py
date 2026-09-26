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

    def __init__(self, filepath: Path = CACHE_FILE):
        self.filepath = filepath
        self._lock = threading.RLock()
        self._save_timer: threading.Timer | None = None
        # NOTE: expiry is pruned lazily (on access and at flush time). Pruning here
        # would turn a plain `import storage` into a cache-file rewrite.
        self._data = self._load()

    def _load(self) -> dict:
        default_structure = {"tracks": {}, "lyrics": {}, "latency_ms": {}, "window": {}}
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

CACHE = CacheManager()