import asyncio
import base64
import json
import os
import threading
import time
from dataclasses import replace as dc_replace
from winsdk.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as MediaManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
)

from config import default_latency_for, debug_log
from storage import CACHE
from core.beat import build_beat_plan
from core.lyrics import fetch_lyrics
from core.media_meta import (
    album_for_search,
    build_track_signature,
    media_meta_from_smtc,
)
from core.metadata import normalize_weak_title
from core.timeline import PositionClock, clamp_rate, normalize_timeline
from core.vlc_source import VlcSource
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

    # How long after a command we sent a contradicting status read is treated as
    # a pre-command echo rather than a real change. SimpMusic reports PLAYING for
    # up to a second after it has paused (measured with tools/smtc_diagnose.py),
    # which made the overlay flip its play button back to "playing".
    COMMAND_SETTLE_S = 1.5

    def __init__(self, shutdown_event: threading.Event):
        self.shutdown_event = shutdown_event
        self.current_session = None
        self.event_loop: asyncio.AbstractEventLoop | None = None
        self.request_generation = 0
        # The pywebview window, kept so a command can reconcile the UI with its
        # actual outcome instead of waiting for the next poll tick.
        self.window = None
        # Monotonic playhead clock: anchored to our own clock, reset on session
        # change and after a seek (see core.timeline).
        self.clock = PositionClock()
        # Whether the selected player publishes a usable timeline at all, and a
        # signature of the last shape we logged/pushed so neither happens per tick.
        self._timeline_published: bool | None = None
        self._timeline_signature = None
        # The playback state a command of ours should have produced, and when.
        self._expect_playing: bool | None = None
        self._expect_at = 0.0
        # The app id the overlay is currently following, and since when another
        # app has been the only candidate to replace it.
        self.pinned_app_id = ""
        self.challenger_since: tuple[str, float] | None = None
        # VLC 3.x never appears in GSMTC; when no media session exists we poll
        # its HTTP interface instead. Password comes from the environment
        # (VLC_HTTP_PASSWORD / VLC_HTTP_HOST / VLC_HTTP_PORT).
        self.vlc = VlcSource(
            password=os.getenv("VLC_HTTP_PASSWORD", ""),
            host=os.getenv("VLC_HTTP_HOST", "127.0.0.1"),
            port=int(os.getenv("VLC_HTTP_PORT", "8080")),
        )
        self._vlc_track_sig = ""
        # Also initialized here: a local-TTML change can arrive before the
        # listener loop has started, and it must not be lost.
        self.reload_requested = False

    # =========================================================================
    # Media Control Actions (Called from UI Buttons / Seeking)
    # =========================================================================
    #
    # Every command goes through `_dispatch`, and every outcome is reported:
    # a `try_*_async` call that returns False, or a session whose loop is not
    # running, used to be indistinguishable from success — the click vanished and
    # the user was left guessing whether the player or the overlay was broken.
    def toggle_playback(self):
        self._dispatch(self._do_toggle(), "pl_pause")

    def seek_position(self, target_ms: float):
        self._dispatch(self._do_seek(target_ms), "seek",
                       val=f"{int(target_ms / 1000)}")

    def skip_next(self):
        self._dispatch(self._do_skip_next(), "pl_next")

    def skip_previous(self):
        self._dispatch(self._do_skip_previous(), "pl_previous")

    def _dispatch(self, coro, vlc_command: str, **vlc_params):
        """Runs a transport coroutine on the loop that owns the session.

        The command must target the same session the metadata came from; when
        there is no session at all, VLC (which never appears in GSMTC) is the
        only fallback. A session with a dead loop is a bug in this process, so it
        is reported rather than silently dropping the user's click.
        """
        if self.current_session is not None:
            loop = self.event_loop
            if loop is not None and loop.is_running():
                asyncio.run_coroutine_threadsafe(coro, loop)
            else:
                coro.close()
                debug_log("[SMTC] command dropped: event loop not running")
                self._report("transport", False, "event loop not running")
            return

        coro.close()
        if self.vlc.configured:
            self.vlc.command(vlc_command, **vlc_params)
        else:
            debug_log("[SMTC] command dropped: no media session and VLC is not configured")
            self._report("transport", False, "no media session")

    def _report(self, action: str, ok: bool, detail: str = "", verified=None):
        """Logs a command's outcome and pushes it to the UI.

        Nothing about this is per-frame: transport commands are user-initiated.
        """
        debug_log(f"[SMTC] {action}: ok={bool(ok)} {detail}")
        payload = {"action": action, "ok": bool(ok), "detail": detail}
        if verified is not None:
            payload["verified"] = bool(verified)
        self._push_js(f"window.transportResult({json.dumps(payload)});")

    def _push_js(self, script: str):
        """Best-effort evaluate_js: the UI may not have loaded yet."""
        if self.window is None:
            return
        try:
            self.window.evaluate_js(script)
        except Exception as exc:
            debug_log("[SMTC] evaluate_js failed:", exc)

    def _is_playing(self, session) -> bool:
        try:
            playback = session.get_playback_info()
            return bool(playback) and playback.playback_status == PlaybackStatus.PLAYING
        except Exception:
            return False

    def _playback_state(self):
        """(is_playing, playback_rate) for the current session, safely."""
        try:
            playback = self.current_session.get_playback_info() if self.current_session else None
        except Exception as exc:
            debug_log("[SMTC] playback info read failed:", exc)
            playback = None
        if not playback:
            return False, 1.0
        status = getattr(playback, "playback_status", None)
        return (status == PlaybackStatus.PLAYING,
                clamp_rate(getattr(playback, "playback_rate", None)))

    def _effective_playing(self, is_playing: bool) -> bool:
        """The playback state to show, ignoring a stale post-command echo.

        When a player keeps reporting the PRE-command status for a moment after
        accepting our command, obeying it flips the play button back and then
        forward again. Within the settle window the commanded state wins.
        """
        if (self._expect_playing is not None
                and bool(is_playing) != self._expect_playing
                and time.monotonic() - self._expect_at < self.COMMAND_SETTLE_S):
            return self._expect_playing
        self._expect_playing = None
        return bool(is_playing)

    def _reconcile_playback(self, playing: bool):
        """Reflect a command's outcome immediately instead of a tick later."""
        self._expect_playing = bool(playing)
        self._expect_at = time.monotonic()
        self._push_js(f"window.setPlaybackState({str(bool(playing)).lower()});")

    async def _do_skip_next(self):
        await self._do_skip("next", "try_skip_next_async")

    async def _do_skip_previous(self):
        await self._do_skip("previous", "try_skip_previous_async")

    async def _do_skip(self, label: str, method: str):
        session = self.current_session
        if not session:
            return
        try:
            ok = bool(await getattr(session, method)())
        except Exception as exc:
            debug_log(f"[SMTC] skip {label} failed:", exc)
            self._report(f"skip_{label}", False, repr(exc))
            return
        if ok:
            # A different track: nothing about the old timeline carries over.
            self.clock.reset()
        self._report(f"skip_{label}", ok, "accepted" if ok else "player refused")

    async def _do_toggle(self):
        session = self.current_session
        if not session:
            return
        playing_before = self._is_playing(session)
        try:
            # The combined toggle is what Windows' own media controls use, and
            # the action players advertise for it (SimpMusic reports
            # is_play_pause_toggle_enabled=True). Picking play-vs-pause from a
            # status read instead races the player: SimpMusic's reported status
            # flaps back to PLAYING for about a second after a state change
            # (measured), which sent a pause to an already-paused player — a
            # click that visibly did nothing.
            ok = bool(await session.try_toggle_play_pause_async())
            if not ok:
                ok = await self._fallback_play_pause(session)
        except Exception as exc:
            debug_log("[SMTC] toggle failed:", exc)
            self._report("toggle", False, repr(exc))
            return
        if ok:
            self._reconcile_playback(not playing_before)
        self._report("toggle", ok, "accepted" if ok else "player refused")

    async def _fallback_play_pause(self, session) -> bool:
        """Status-directed play/pause, only when the combined toggle is refused."""
        try:
            playback = session.get_playback_info()
            if playback and playback.playback_status == PlaybackStatus.PLAYING:
                return bool(await session.try_pause_async())
            return bool(await session.try_play_async())
        except Exception as exc:
            debug_log("[SMTC] play/pause fallback failed:", exc)
            return False

    async def _do_seek(self, target_ms: float):
        session = self.current_session
        if not session:
            return
        target_ms = float(target_ms)
        try:
            # WinRT TimeSpan is in 100-nanosecond units: 1 ms = 10,000 units.
            # Verified against the installed bindings with tools/smtc_diagnose.py
            # (a seek lands on the requested position for players that publish a
            # timeline, so the argument form is not the bug here).
            time_span = int(target_ms * 10_000)
            was_playing = self._is_playing(session)
            ok = bool(await session.try_change_playback_position_async(time_span))
            if was_playing:
                # Only nudge playback if it was already playing — seeking while
                # paused must never start the track. Some players flip to paused
                # on a seek inside the current item, so re-assert play.
                await session.try_play_async()
            # Our clock is no longer authoritative; the player's next sample is.
            self.clock.invalidate()
            self._report("seek", ok, f"target={int(target_ms)}ms",
                         verified=bool(self._timeline_published))
        except Exception as exc:
            debug_log("[SMTC] seek failed:", exc)
            self._report("seek", False, f"target={int(target_ms)}ms {exc!r}")

    # =========================================================================
    # Timeline Reads
    # =========================================================================
    def _read_timeline(self):
        """One normalized timeline reading, or None when it cannot be read.

        Single read point for position, duration and seek bounds, so the UI can
        never be fed values that came from different snapshots of a moving
        timeline.
        """
        if not self.current_session:
            return None
        try:
            timeline = self.current_session.get_timeline_properties()
        except Exception as exc:
            debug_log("[SMTC] timeline read failed:", exc)
            return None
        if timeline is None:
            return None
        return normalize_timeline(
            start=getattr(timeline, "start_time", None),
            end=getattr(timeline, "end_time", None),
            position=getattr(timeline, "position", None),
            updated=getattr(timeline, "last_updated_time", None),
            min_seek=getattr(timeline, "min_seek_time", None),
            max_seek=getattr(timeline, "max_seek_time", None),
        )

    def _note_timeline(self, sample):
        """Log the timeline's shape when it changes, and tell the UI about it.

        Deliberately not per tick: the interesting event is a player that starts
        or stops publishing a timeline, not the number itself.
        """
        self._timeline_published = sample.published
        signature = (sample.published, sample.duration_ms, sample.max_seek_ms,
                     sample.start_ms is not None)
        if signature == self._timeline_signature:
            return
        self._timeline_signature = signature
        debug_log(
            f"[SMTC] timeline: published={sample.published} "
            f"start_ms={sample.start_ms} position_ms={sample.position_ms} "
            f"duration_ms={sample.duration_ms} max_seek_ms={sample.max_seek_ms}"
        )
        # The pin is only set once an app has held the overlay; report the
        # session's own app id until then, so the UI is never told "no player".
        self._push_transport_state(
            self.pinned_app_id or self._session_app_id(self.current_session),
            sample.published, sample.duration_ms)

    def _push_transport_state(self, app_id: str, timeline_ok: bool,
                              duration_ms: float | None):
        """Tells the UI what this player's transport can actually do.

        The overlay can only be honest about a missing duration or a missing
        timeline if it says so; the diagnostics panel shows these three facts.
        """
        state = {
            "app": app_id or "",
            "timeline": bool(timeline_ok),
            "duration": bool(duration_ms and duration_ms > 0),
        }
        self._push_js(f"window.setTransportState({json.dumps(state)});")

    def _get_position_ms(self) -> float | None:
        """
        Real-time playback position, or None when there is none to report.

        Returning None rather than 0.0 matters: 0.0 is a valid position and the
        UI has a guard that swallows a spurious zero, so a failed read used to
        present itself as a legitimate "at the start" and silently disable all
        playhead corrections. None lets the caller skip the sync instead.

        A player that publishes no timeline (every field zero, `last_updated_time`
        left at WinRT's sentinel) also answers None here — nothing is invented to
        fill the gap. Extrapolation between real samples is the monotonic clock's
        job; see core.timeline.PositionClock.
        """
        sample = self._read_timeline()
        if sample is None:
            return None
        self._note_timeline(sample)
        if not sample.published:
            return None
        playing, rate = self._playback_state()
        return self.clock.observe(sample.position_ms, time.monotonic(),
                                  playing=playing, session=self.current_session,
                                  rate=rate, duration_ms=sample.duration_ms)

    def _get_duration_ms(self) -> float | None:
        """Total track length in ms, or None when the player does not publish one.

        Duration is `end_time - start_time` (the timeline's own origin), not the
        raw `end_time`: it used to be right by accident for players that keep the
        origin at zero and wrong for anyone who does not.
        """
        sample = self._read_timeline()
        if sample is None:
            return None
        return sample.duration_ms

    # =========================================================================
    # Background Listener Loop
    # =========================================================================
    async def run(self, window):
        self.event_loop = asyncio.get_running_loop()
        # Kept so a transport command can reconcile the UI with its outcome.
        self.window = window

        try:
            manager = await MediaManager.request_async()
        except Exception as exc:
            print(f"⚠️ [SMTC] Could not connect to Windows Media Manager: {exc}")
            return

        last_track_sig = ""
        last_playing = False
        self._vlc_last_playing = False
        self._vlc_track_sig = ""
        self._vlc_last_pos_ms = 0.0
        last_periodic_sync = 0.0
        # Set when something outside the audio source invalidates the lyrics
        # currently on screen (the user just bound a local TTML file, or cleared
        # one). The loop treats it exactly like a track change: refetch, reload,
        # re-render — without waiting for the song to end.
        self.reload_requested = False

        while not self.shutdown_event.is_set():
            sleep_duration = 0.6  # Default checking rate

            try:
                session = self._pick_session(manager)
                self.current_session = session

                if not session:
                    vlc_state = self._vlc_tick(window)
                    if vlc_state is None:
                        if last_track_sig != "":
                            last_track_sig = ""
                            window.evaluate_js("window.setPlaybackState(false);")
                            window.evaluate_js("window.setCoverArt(null);")
                        # Sleep longer when no media player is active
                        await asyncio.sleep(1.2)
                        continue
                    await asyncio.sleep(self.vlc.poll_interval(vlc_state))
                    continue

                playback = session.get_playback_info()
                is_playing = (playback.playback_status == PlaybackStatus.PLAYING) if playback else False
                # A status read taken within the settle window of our own command
                # may still be the pre-command value (measured on SimpMusic).
                is_playing = self._effective_playing(is_playing)

                # Read track metadata safely. The duration is one read used for
                # everything downstream: the signature, the lyrics lookup and the
                # UI's total, so they can never disagree.
                info = await session.try_get_media_properties_async()
                duration_ms = self._get_duration_ms()
                meta = media_meta_from_smtc(info, duration_ms=duration_ms)
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
                if title and (track_sig != last_track_sig or self.reload_requested):
                    # Consumed here rather than at the end of the block: the
                    # signature is only committed on success below, so a failed
                    # fetch already retries on its own and re-arming this flag
                    # would just replay the same failure.
                    self.reload_requested = False
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
                    # Starting offset depends on where the lyrics came from: a
                    # cached payload opens at the tuned baseline, a fresh fetch
                    # at the wider one. The stored per-track value (if the user
                    # has nudged this song before) still wins.
                    saved_offset = CACHE.get_latency(
                        track_key, default_latency_for(diagnostics.get("cache")))

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
                    # `null` means "this player publishes no duration" — the UI clears
                    # the labels and disables the seek bar instead of showing the
                    # previous track's length or a fabricated 0:00.
                    window.evaluate_js(f"window.setTrackDuration({json.dumps(duration_ms)});")
                    window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")
                    # What this player's transport can actually do, for the
                    # diagnostics panel.
                    self._push_transport_state(app_id, bool(self._timeline_published),
                                               duration_ms)

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

    def request_reload(self):
        """
        Asks the loop to reload the current track's lyrics.

        Used when something other than the audio source changes what the lyrics
        should be — binding or clearing a local TTML file, or removing one from
        the library — so the change is visible immediately instead of on the
        next song.
        """
        self.reload_requested = True

    def _session_app_id(self, session) -> str:
        try:
            return session.source_app_user_model_id or ""
        except Exception:
            return ""

    def _vlc_tick(self, window):
        """One VLC poll cycle when SMTC has no session. Returns the state or None.

        Feeds the same JS entry points the SMTC path uses, so the overlay's
        behaviour is identical no matter which source is live.
        """
        state = self.vlc.poll()
        if state is None:
            return None

        is_playing = state.playing
        if is_playing != self._vlc_last_playing:
            self._vlc_last_playing = is_playing
            window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")

        if not state.title:
            return state  # radio/untitled stream: nothing to look up

        track_sig = f"vlc:::{state.title}:::{state.artist}:::{state.album}:::{int(state.length_ms or 0)}"
        if self.reload_requested:
            # Same invalidation as the SMTC path: drop the remembered signature so
            # the current track is refetched with the new local file in play.
            self.reload_requested = False
            self._vlc_track_sig = ""
        if track_sig != self._vlc_track_sig:
            self._vlc_track_sig = track_sig
            window.evaluate_js(f"window.showLoading({json.dumps(state.title)}, {json.dumps(state.artist)});")
            window.evaluate_js("window.setCoverArt(null);")
            try:
                lines, source, _tid, diagnostics = fetch_lyrics(
                    state.title, state.artist, state.length_ms, state.album, "filename")
                if not self.shutdown_event.is_set():
                    lines_json = json.dumps(lines)
                    # Same cache-aware starting offset as the SMTC path, and the
                    # same per-track override (the VLC path used to ignore both
                    # and always hand the UI the baseline).
                    saved_offset = CACHE.get_latency(
                        track_sig, default_latency_for(diagnostics.get("cache")))
                    window.evaluate_js(
                        f"window.loadLyrics({lines_json}, {json.dumps(state.title)}, "
                        f"{json.dumps(state.artist)}, {json.dumps(source)}, "
                        f"{state.position_ms or 0}, {json.dumps(track_sig)}, "
                        f"{saved_offset}, null);"
                    )
                    window.evaluate_js(f"window.setDiagnostics({json.dumps(diagnostics)});")
                    window.evaluate_js(
                        f"window.setTrackDuration({json.dumps(state.length_ms or None)});")
                    # VLC reports its own position and length, so its timeline is
                    # live; the length can still be missing on a stream.
                    self._push_transport_state("VLC", True, state.length_ms)
                    window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")
            except Exception as exc:
                debug_log("VLC lyric fetch failed:", exc)
                self._vlc_track_sig = ""   # retry next tick

        if is_playing and state.position_ms is not None and state.position_ms > 0:
            window.evaluate_js(f"window.syncPlayhead({state.position_ms});")
        return state

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