import asyncio
import base64
import datetime
import json
import threading
import time
from dataclasses import replace as dc_replace
from winsdk.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as MediaManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
)

from config import DEFAULT_LATENCY_MS, debug_log
from storage import CACHE
from core.beat import build_beat_plan
from core.lyrics import fetch_lyrics
from core.media_meta import (
    album_for_search,
    build_track_signature,
    media_meta_from_smtc,
)
from core.metadata import normalize_weak_title
from core.resolver import resolve_artwork_url
from core.session import select_session


async def _get_thumbnail_base64(info):
    """Extracts song cover art directly from Windows Media without extra HTTP calls."""
    if not info or not getattr(info, 'thumbnail', None):
        return None
    try:
        from winsdk.windows.storage.streams import DataReader
        stream = await info.thumbnail.open_read_async()
        if not stream or stream.size == 0:
            return None
        reader = DataReader(stream)
        await reader.load_async(stream.size)
        data = bytearray(stream.size)
        reader.read_bytes(data)
        return "data:image/jpeg;base64," + base64.b64encode(data).decode('utf-8')
    except Exception:
        return None


class SmtcBridge:
    """
    Manages Windows System Media Transport Controls (GSMTC).
    Tracks active song changes, handles play/pause/seek, extracts live cover art,
    and isolates Windows COM errors.

    Sessions are PINNED: once lyrics are being shown for a source app, that app
    keeps the overlay until its session disappears. `get_current_session()` alone
    hands over to whatever Windows currently considers "current" — a YouTube
    tab in Edge or a Discord call would silently hijack the lyrics mid-song.
    A different app only takes over after it has been the sole active session
    for a few seconds, so a transitive blip does not steal the overlay either.
    """

    # An app that lost the overlay must be the only game in town this long before
    # it is allowed to take it back (seconds).
    HANDOVER_QUIET_S = 4.0

    def __init__(self, shutdown_event: threading.Event):
        self.shutdown_event = shutdown_event
        self.current_session = None
        self.event_loop: asyncio.AbstractEventLoop | None = None
        self.request_generation = 0
        # The app id the overlay is currently following, and since when another
        # app has been the only candidate to replace it.
        self.pinned_app_id = ""
        self.challenger_since: tuple[str, float] | None = None

    # =========================================================================
    # Media Control Actions (Called from UI Buttons / Seeking)
    # =========================================================================
    def toggle_playback(self):
        if self.current_session and self.event_loop and self.event_loop.is_running():
            asyncio.run_coroutine_threadsafe(self._do_toggle(), self.event_loop)

    def seek_position(self, target_ms: float):
        if self.current_session and self.event_loop and self.event_loop.is_running():
            asyncio.run_coroutine_threadsafe(self._do_seek(target_ms), self.event_loop)

    async def _do_toggle(self):
        try:
            if not self.current_session:
                return
            playback = self.current_session.get_playback_info()
            if playback:
                if playback.playback_status == PlaybackStatus.PLAYING:
                    await self.current_session.try_pause_async()
                else:
                    await self.current_session.try_play_async()
        except Exception:
            pass  # Session may have closed or changed

    async def _do_seek(self, target_ms: float):
        try:
            if not self.current_session:
                return
            # Windows Media expects 100-nanosecond units (1ms = 10,000 units)
            time_span = int(target_ms * 10_000)
            was_playing = False
            playback = self.current_session.get_playback_info()
            if playback:
                was_playing = playback.playback_status == PlaybackStatus.PLAYING
            await self.current_session.try_change_playback_position_async(time_span)
            # Only nudge playback if it was already playing — seeking while
            # paused must never start the track.
            if was_playing:
                await self.current_session.try_play_async()
        except Exception:
            pass

    def _get_position_ms(self) -> float | None:
        """
        Real-time playback position, or None when it cannot be read.

        Returning None rather than 0.0 matters: 0.0 is a valid position and the
        UI has a guard that swallows a spurious zero, so a failed read used to
        present itself as a legitimate "at the start" and silently disable all
        playhead corrections. None lets the caller skip the sync instead.

        WinRT's `timeline.position` is the position AT `last_updated_time` — a
        snapshot some players only refresh every few seconds. Sent raw to the UI
        once a second, the playhead kept snapping BACK to the stale snapshot and
        then jumping forward again. Adding the time elapsed since that snapshot
        turns it into the interpolated position the listener expects.
        """
        try:
            if not self.current_session:
                return None
            timeline = self.current_session.get_timeline_properties()
            if timeline and timeline.position:
                pos_ms = timeline.position.total_seconds() * 1000.0
                updated = getattr(timeline, "last_updated_time", None)
                if updated:
                    # `last_updated_time` is normally a naive UTC datetime, but a
                    # timezone-aware value would raise on subtraction. Match
                    # awareness so the extrapolation never silently stops.
                    if getattr(updated, "tzinfo", None) is not None:
                        now = datetime.datetime.now(datetime.timezone.utc)
                    else:
                        now = datetime.datetime.now()
                    elapsed_ms = (now - updated).total_seconds() * 1000.0
                    # Clamp: a suspended player (or a paused one) leaves the
                    # snapshot ageing while the position does not advance. Only
                    # extrapolate while the elapsed time is plausible for a
                    # snapshot lag, not for an hour-old reading.
                    if 0 <= elapsed_ms <= 10_000:
                        pos_ms += elapsed_ms
                return pos_ms
        except Exception as exc:
            debug_log("Could not read playback position:", exc)
        return None

    def _get_duration_ms(self) -> float | None:
        """Total track length, used to disambiguate lyrics cache keys."""
        try:
            if not self.current_session:
                return None
            timeline = self.current_session.get_timeline_properties()
            if timeline and timeline.end_time:
                total = timeline.end_time.total_seconds() * 1000.0
                if total > 0:
                    return total
        except Exception:
            pass
        return None

    # =========================================================================
    # Background Listener Loop
    # =========================================================================
    async def run(self, window):
        self.event_loop = asyncio.get_running_loop()

        try:
            manager = await MediaManager.request_async()
        except Exception as exc:
            print(f"⚠️ [SMTC] Could not connect to Windows Media Manager: {exc}")
            return

        last_track_sig = ""
        last_playing = False
        last_periodic_sync = 0.0

        while not self.shutdown_event.is_set():
            sleep_duration = 0.6  # Default checking rate

            try:
                session = self._pick_session(manager)
                self.current_session = session

                if not session:
                    if last_track_sig != "":
                        last_track_sig = ""
                        window.evaluate_js("window.setPlaybackState(false);")
                        window.evaluate_js("window.setCoverArt(null);")
                    # Sleep longer when no media player is active
                    await asyncio.sleep(1.2)
                    continue

                playback = session.get_playback_info()
                is_playing = (playback.playback_status == PlaybackStatus.PLAYING) if playback else False

                # Read track metadata safely
                info = await session.try_get_media_properties_async()
                meta = media_meta_from_smtc(info, duration_ms=self._get_duration_ms())
                title, artist, metadata_source = normalize_weak_title(
                    meta.raw_title, meta.raw_artist)
                meta = dc_replace(meta, raw_title=title, raw_artist=artist)
                album = album_for_search(meta)

                app_id = ""
                try:
                    app_id = session.source_app_user_model_id or ""
                except Exception:
                    pass

                # Computed from the REPAIRED title/artist, so the signature
                # matches what fetch_lyrics will search for. Album and duration
                # join the key so same-name tracks on different albums reload
                # instead of reusing the previous track's lyrics.
                track_sig = build_track_signature(meta, app_id)

                # 1. Update Play / Pause state in UI if changed
                if is_playing != last_playing:
                    last_playing = is_playing
                    window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")

                # 2. Track Change Detected: Fetch new lyrics & stream album cover
                if title and track_sig != last_track_sig:
                    # NOTE: last_track_sig is committed only AFTER the fetch
                    # succeeds (below). Committing it here meant any throw in
                    # between — a malformed API payload, an evaluate_js before
                    # app.js was ready — was swallowed by the loop's except and
                    # left the signature recorded, so the track never retried
                    # and the UI sat on the loading spinner forever.
                    self.request_generation += 1
                    gen = self.request_generation

                    window.evaluate_js(f"window.showLoading({json.dumps(title)}, {json.dumps(artist)});")

                    # 1. Instant low-res thumbnail: pushed right away so the header
                    #    art and backdrop update with zero perceptible delay.
                    cover_data = await _get_thumbnail_base64(info)
                    window.evaluate_js(f"window.setCoverArt({json.dumps(cover_data)}, false);")

                    # 2. Hi-res artwork resolves in a fire-and-forget background task,
                    #    fully concurrent with the lyric fetch below — the lyrics never
                    #    wait on the artwork, and the bloom upgrades in place when ready.
                    async def _push_hires_artwork(t, a, gen):
                        try:
                            url = await self.event_loop.run_in_executor(
                                None, resolve_artwork_url, t, a
                            )
                            if url and gen == self.request_generation and not self.shutdown_event.is_set():
                                window.evaluate_js(
                                    f"window.setCoverArt({json.dumps(url)}, true);"
                                )
                        except Exception as exc:
                            debug_log("Hi-res artwork push failed:", exc)

                    self.event_loop.create_task(_push_hires_artwork(title, artist, gen))

                    duration_ms = self._get_duration_ms()
                    try:
                        lines, source, track_id, diagnostics = await self.event_loop.run_in_executor(
                            None, fetch_lyrics, title, artist, duration_ms, album, metadata_source
                        )
                    except Exception as exc:
                        # Do NOT commit the signature: a transient failure has to
                        # retry instead of leaving the track stranded on the
                        # spinner. The short sleep stops a persistently broken
                        # track from hammering the network every tick.
                        debug_log("Lyrics fetch failed; will retry:", exc)
                        await asyncio.sleep(2.0)
                        continue

                    # Discard result if a newer song started while fetching
                    if gen != self.request_generation or self.shutdown_event.is_set():
                        continue

                    initial_elapsed_ms = self._get_position_ms()
                    if initial_elapsed_ms is None:
                        initial_elapsed_ms = 0.0
                    track_key = track_id or track_sig
                    saved_offset = CACHE.get_latency(track_key, DEFAULT_LATENCY_MS)

                    lines_json = json.dumps(lines)
                    # Bridge payloads are serialized into a JS string; flag unusually large ones.
                    if len(lines_json) > 2_000_000:
                        debug_log(f"Large lyrics payload for '{title}': {len(lines_json)} chars")

                    # Where the track is actually driven. Derived here rather than
                    # in the UI because this side sees the payload before the UI
                    # rewrites syllable durations, and because it is unit-testable
                    # in Python. A failure must never cost the user their lyrics.
                    try:
                        beat_plan = build_beat_plan(lines)
                    except Exception as exc:
                        debug_log("Beat plan failed:", exc)
                        beat_plan = None
                    if beat_plan:
                        debug_log(
                            f"Beat plan: {beat_plan['bpm']} BPM, "
                            f"{len(beat_plan['runs'])} pulse run(s), "
                            f"coherence {beat_plan['stats']['coherence']}"
                        )

                    window.evaluate_js(
                        f"window.loadLyrics("
                        f"{lines_json}, "
                        f"{json.dumps(title)}, "
                        f"{json.dumps(artist)}, "
                        f"{json.dumps(source)}, "
                        f"{initial_elapsed_ms}, "
                        f"{json.dumps(track_key)}, "
                        f"{saved_offset}, "
                        f"{json.dumps(beat_plan)});"
                    )
                    # Explains in the UI why these lyrics are syllable- or line-synced.
                    window.evaluate_js(f"window.setDiagnostics({json.dumps(diagnostics)});")
                    # Feeds the split-layout transport (elapsed / total / progress bar).
                    window.evaluate_js(f"window.setTrackDuration({self._get_duration_ms() or 0});")
                    window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")

                    # Commit only once the track is actually on screen. A throw
                    # in any bridge call above (e.g. before app.js has defined
                    # loadLyrics) then retries rather than sticking on a track
                    # whose signature was already recorded.
                    last_track_sig = track_sig

                # 3. Position Sync Heartbeat (fires once per second during playback)
                now_ts = time.time()
                if is_playing:
                    sleep_duration = 0.5
                    if now_ts - last_periodic_sync >= 1.0:
                        last_periodic_sync = now_ts
                        current_pos = self._get_position_ms()
                        if current_pos is not None and current_pos > 0:
                            window.evaluate_js(f"window.syncPlayhead({current_pos});")
                else:
                    # Player is paused: conserve CPU
                    sleep_duration = 1.0

            except Exception:
                # Silently catch disconnected sessions when player is closed
                self.current_session = None

            await asyncio.sleep(sleep_duration)

    def _session_app_id(self, session) -> str:
        try:
            return session.source_app_user_model_id or ""
        except Exception:
            return ""

    def _pick_session(self, manager):
        """
        The session the overlay should follow.

        Thin I/O wrapper around the pure policy in ``core.session``: it turns the
        live sessions into plain descriptors, lets the policy decide, and maps
        the chosen app id back to the session object. Keeping the decision out
        of this method is what makes the paused-pin handover testable without
        Windows Runtime.
        """
        try:
            sessions = list(manager.get_sessions())
        except Exception:
            sessions = []
        if not sessions:
            self.pinned_app_id = ""
            self.challenger_since = None
            return None

        def playing(s):
            try:
                info = s.get_playback_info()
                return bool(info) and info.playback_status == PlaybackStatus.PLAYING
            except Exception:
                return False

        try:
            current = manager.get_current_session()
        except Exception:
            current = None

        by_id = {}
        descriptors = []
        for s in sessions:
            app_id = self._session_app_id(s)
            descriptors.append({
                "app_id": app_id,
                "playing": playing(s),
                "is_current": s is current,
                "in_current": s is self.current_session,
                "session": s,
            })
            by_id.setdefault(app_id, s)

        chosen_id, self.pinned_app_id, self.challenger_since = select_session(
            descriptors, self.pinned_app_id, self.challenger_since,
            time.time(), quiet_s=self.HANDOVER_QUIET_S,
        )
        if chosen_id is None:
            return None
        return by_id.get(chosen_id)

    def start(self, window):
        """Entry point for the pywebview background worker thread."""
        asyncio.run(self.run(window))