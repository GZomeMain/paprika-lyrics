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
    build_track_core,
    build_track_signature,
    media_meta_from_smtc,
)
from core.metadata import normalize_weak_title
from core.timeline import (
    PositionClock,
    clamp_rate,
    normalize_timeline,
    sample_age_ms,
    utcnow,
)
from core.vlc_source import VlcSource
from core.resolver import resolve_artwork_url
from core.session import select_session


# A discontinuity no larger than this is a move WITHIN the song — a scrub of the
# player's own progress bar, a chapter skip, a click on the site's own seek bar —
# and the UI is asked to ease the lyrics to it (a quarter of a second) rather
# than cut. A bigger move is somewhere else in the song entirely, and sweeping
# that much lyric in 250 ms reads as a glitch rather than as catching up, so
# those land hard. This is a taste bound on one gesture, not a correctness one:
# every track change and play/pause edge is a snap regardless.
GLIDE_MAX_MS = 8000.0

# A duration the UI has not been told yet (see SmtcBridge._pushed_duration).
_UNPUSHED = object()


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
    A different session only takes over after it has been the best candidate for
    a few seconds, so a transitive blip does not steal the overlay either.

    Which session is which is decided by ``core.session`` from what each session
    *reports* (its app id plus the title it is playing), never from Python object
    identity: WinRT hands back a fresh wrapper object for the same session on
    every `get_sessions()` call, so the identity comparisons this used to do
    never matched anything, and every tab of one browser shares an app id.
    """

    # A session that lost the overlay must be the best candidate this long before
    # it is allowed to take it back (seconds).
    HANDOVER_QUIET_S = 4.0

    # How long after a command we sent a contradicting status read is treated as
    # a pre-command echo rather than a real change. SimpMusic reports PLAYING for
    # up to a second after it has paused (measured with tools/smtc_diagnose.py),
    # which made the overlay flip its play button back to "playing".
    COMMAND_SETTLE_S = 1.5

    # One poll of the media session while playing, while paused, and while there
    # is nothing to follow at all (seconds). The UI extrapolates the playhead
    # between polls, so this is only how often the player's own numbers are
    # re-read — not how often the lyrics move. Paused is not slower than playing:
    # how late a resume is noticed is exactly how much of the resumed audio the
    # lyrics missed, and that error is one poll wide. That is why the paused
    # interval is not the relaxed one — it is the interval a resume is measured
    # in, and it is the single biggest remaining delay between pressing play and
    # the words moving.
    PLAYING_POLL_S = 0.25
    PAUSED_POLL_S = 0.25
    IDLE_POLL_S = 1.2

    # While a player that says it is PLAYING has blanked its timeline — the
    # measured signature of a site-side seek — the next republish is the news the
    # lyrics are waiting for. The position is already sitting in the player, so
    # the only cost of looking is a timeline read; waiting a full interval for it
    # would be most of the delay the user sees between seeking and the lyrics
    # arriving.
    BLANK_POLL_S = 0.15

    # Metadata that arrives in stages (a browser publishes the album and the
    # duration after the title, sometimes seconds later) must not be mistaken for
    # a new song. A duration that was unknown and is now known is a refinement;
    # two known durations this far apart are a different recording — and even
    # then the change is confirmed over TRACK_SETTLE_S first, so a value that
    # flaps cannot restart the lyrics on every poll.
    TRACK_SETTLE_S = 1.0
    DURATION_CHANGE_MS = 1500.0

    # VLC's status.json reports `time` in whole seconds, so its position is a
    # bucket rather than a point (see PositionClock.observe).
    VLC_QUANTIZED_MS = 1000.0

    def __init__(self, shutdown_event: threading.Event):
        self.shutdown_event = shutdown_event
        self.current_session = None
        self.event_loop: asyncio.AbstractEventLoop | None = None
        self.request_generation = 0
        # The pywebview window, kept so a command can reconcile the UI with its
        # actual outcome instead of waiting for the next poll tick.
        self.window = None
        # Monotonic playhead clock: owns the projection, the stall bound and the
        # meaning of a jump (see core.timeline). Reset on a real session or track
        # change, never per tick.
        self.clock = PositionClock()
        # The session whose lyrics are on screen, and the app it belongs to (used
        # as a preference when that exact session is gone). Both are computed
        # from what sessions report, never from object identity.
        self.followed_key = ""
        self.pinned_app_id = ""
        self.challenger_since: tuple[str, float] | None = None
        # The next position this bridge sends is a place the UI must land on
        # exactly (a track change, a seek, a play/pause transition) rather than a
        # drift it may ease into.
        self._force_snap = False
        # The length the player last published for the track whose core signature
        # this is, so that a blank timeline (a seek) cannot take a known song's
        # length away from the UI — and a new track cannot inherit the previous
        # one's.
        self._length_core = ""
        self._length_ms: float | None = None
        # The length the UI has been told. _UNPUSHED rather than None, because
        # "this player publishes no length" is itself something to say once.
        self._pushed_duration: object = _UNPUSHED
        # The track currently loaded into the UI: the core signature (title and
        # artist) decides a change outright, the full one (album and duration)
        # only after TRACK_SETTLE_S of agreement.
        self._loaded_core = ""
        self._loaded_full = ""
        self._loaded_album = ""
        self._loaded_duration: float | None = None
        self._pending_full: str | None = None
        self._pending_since = 0.0
        self._current_title = ""
        self._current_artist = ""
        # Whether the UI has already been told that nothing is playing at all.
        self._idle = False
        # Whether the selected player publishes a usable timeline at all, and a
        # signature of the last shape we logged/pushed so neither happens per tick.
        self._timeline_published: bool | None = None
        self._timeline_signature = None
        # The playback state a command of ours should have produced, and when.
        self._expect_playing: bool | None = None
        self._expect_at = 0.0
        # VLC 3.x never appears in GSMTC; when no media session exists we poll
        # its HTTP interface instead. Password comes from the environment
        # (VLC_HTTP_PASSWORD / VLC_HTTP_HOST / VLC_HTTP_PORT).
        self.vlc = VlcSource(
            password=os.getenv("VLC_HTTP_PASSWORD", ""),
            host=os.getenv("VLC_HTTP_HOST", "127.0.0.1"),
            port=int(os.getenv("VLC_HTTP_PORT", "8080")),
        )
        # The whole VLC checkpoint is initialized HERE, not on the first pass of
        # run(): `_vlc_tick` reads both, and state that only exists once the loop
        # has started makes the tick uncallable (and untestable) on its own.
        self._vlc_track_sig = ""
        self._vlc_last_playing = False
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
            # A different track: nothing about the old timeline carries over, and
            # the UI must land on the new song's position rather than glide there
            # from this one's.
            self.clock.reset()
            self._force_snap = True
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
            # Our clock follows the command immediately, and the player's
            # pre-seek echo is ignored until it catches up. Without this the
            # overlay was yanked back to where the user seeked FROM, once per
            # poll, for as long as the player took to move (see PositionClock).
            self.clock.note_seek(target_ms, time.monotonic())
            self._force_snap = True
            ok = bool(await session.try_change_playback_position_async(time_span))
            if not ok:
                # Refused: believe the player again instead of holding a position
                # it never went to. The UI rolls its own optimistic move back on
                # the same report.
                self.clock.cancel_seek()
            if was_playing:
                # Only nudge playback if it was already playing — seeking while
                # paused must never start the track. Some players flip to paused
                # on a seek inside the current item, so re-assert play.
                await session.try_play_async()
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
        Includes normalized source realization metadata for the profile & sync engine.
        """
        from core.source_detector import detect_source, source_to_dict
        title = getattr(self, '_current_title', '')
        artist = getattr(self, '_current_artist', '')
        source_info = detect_source(app_id, title=title, artist=artist)
        state = {
            "app": app_id or "",
            "timeline": bool(timeline_ok),
            "duration": bool(duration_ms and duration_ms > 0),
            "source": source_to_dict(source_info),
        }
        self._push_js(f"window.setTransportState({json.dumps(state)});")

    def _publish_duration(self, window, duration_ms):
        """Tell the UI the track's length, and remember only what it was TOLD.

        ``_pushed_duration`` answers "what does the UI currently know", so it is
        recorded *after* the call, not before it. Recording it first meant a
        delivery that never landed — the page still loading, an exception thrown
        by any bridge call in the same tick, a webview that has reloaded — was
        never retried, and the bar read ``--:--`` for the rest of a song whose
        length the player had been publishing all along. That is the reported
        "the end time does not show even for apps which do provide the timeline":
        the length was known here and never reached there.

        Retrying every tick until it lands is the same choice the playhead makes
        (step 4 of the loop): a redundant ``setTrackDuration`` is one idempotent
        JS call, while a lost one costs the user their end time until the next
        track. ``None`` is a value like any other — it is how the UI is told that
        this player publishes no length — so it is recorded and re-sent on the
        same terms as a number.
        """
        if duration_ms == self._pushed_duration:
            return
        try:
            window.evaluate_js(
                f"window.setTrackDuration({json.dumps(duration_ms)});")
        except Exception as exc:
            # Deliberately NOT recorded: the next tick tries again instead of
            # believing a UI that never heard us.
            debug_log("[SMTC] could not push the track length; will retry:", exc)
            return
        self._pushed_duration = duration_ms

    def _read_tick(self, playing: bool, rate: float):
        """One timeline read for a whole tick: ``(reading, sample)``.

        The reading is where the playhead is *now*, plus whether that was a jump
        the UI must land on, or None when there is nothing honest to report.
        Returning None rather than 0.0 matters: 0.0 is a valid position, so a
        failed read used to present itself as a legitimate "at the start" and
        silently disabled every correction.

        The sample comes back too because it is the only read this tick makes: the
        position, the duration and the track signature are then guaranteed to
        describe the same instant of a moving timeline, and the player's timeline
        is a live WinRT object that is another chance to catch mid-write on every
        extra look.

        A player with no position state (never published a timeline, or zeroed it
        after a seek — see ``normalize_timeline``) answers None here as well;
        nothing is invented to fill the gap. Extrapolation between real samples is
        the clock's job; see core.timeline.PositionClock.
        """
        sample = self._read_timeline()
        if sample is None:
            return None, None
        # One instant for the whole tick. Every clock call below shares it, so
        # the tick's own latency (metadata reads, lyric fetch, artwork) cannot
        # move the anchored position — that drift is exactly the "always a beat
        # behind until I pause" lag, and stamping once removes it for free.
        now_monotonic = time.monotonic()
        self._note_timeline(sample)
        if not sample.published:
            # Nothing readable, but the transport state is still real, and a
            # player that stops publishing a timeline while it is paused must not
            # leave the clock believing it was playing through the pause.
            self.clock.note_playing(playing, now_monotonic)
            if playing:
                # A blank timeline is also what a browser left behind right after
                # a seek while it carried on PLAYING (measured: ~4s of zeros with
                # a live stamp, then the new position). Pushing nothing here let
                # the UI free-run from its stale anchor with no correction at
                # all — the reported "a site-side seek does not sync until I
                # pause". The clock's answer is a held, leashed position: better
                # to park the lyrics at the last known truth than to run them on
                # uncontrolled, and the publish that lands later is the move the
                # UI glides to (or a snap, if it moved further than
                # GLIDE_MAX_MS).
                parked = self.clock.observe(None, now_monotonic, playing=True)
                return parked, sample
            return None, sample
        # How long ago the player wrote that position. A browser republishes it
        # every few seconds, and reading it as "now" was the largest single
        # source of late lyrics; the clock ages it back to the present instead.
        age = sample_age_ms(sample.updated_at, utcnow())
        reading = self.clock.observe(
            sample.position_ms, now_monotonic, playing=playing,
            rate=rate, duration_ms=sample.duration_ms, sample_age_ms=age)
        return reading, sample

    def _read_playhead(self, playing: bool, rate: float):
        """The playhead reading alone, for callers that need nothing else.

        Thin wrapper over ``_read_tick`` for the diagnostic tool and the tests;
        the listener loop takes the sample too so one read serves the whole tick.
        """
        reading, _sample = self._read_tick(playing, rate)
        return reading

    def _get_position_ms(self) -> float | None:
        """The current playhead in ms, or None when there is none to report.

        Thin wrapper over `_read_playhead` for the diagnostic tool and tests; the
        listener loop uses the Reading so it can tell a drift from a jump.
        """
        playing, rate = self._playback_state()
        reading = self._read_playhead(playing=playing, rate=rate)
        return reading.position_ms if reading is not None else None

    def _push_playhead(self, reading):
        """Send the playhead to the UI, telling it how to take the new value.

        Three modes, because there are three different things a position report
        can be:

        * ``snap`` — the lyrics must LAND on it now. A track change, a player
          skip, the first reading of a track, a play/pause edge, or a move too
          large to animate.
        * ``glide`` — a real move the UI should travel to. A seek inside the song
          whose size is one the eye can follow, where easing reads as the wipe
          catching up rather than as a jump.
        * ``soft`` — ordinary drift the UI is free to absorb as a decaying
          correction.
        * ``hold`` — the clock had no fresh sample and is reporting its leashed
          projection (see ``Reading.held``). The number is the best estimate
          available but it is NOT a correction: sent as drift it dragged the
          wipe back to a parked position on every poll, which stalled real-time
          sync on players that publish rarely or blank their timeline (browsers
          after a site-side seek, SimpMusic) and re-swept the syllables already
          passed. The UI keeps its own 1x projection on a hold.

        The bridge decides because it is the only side that sees the chronology
        of samples — the UI used to guess from a 900 ms threshold, and every
        guess it got wrong was a visible reset.
        """
        if self._force_snap:
            mode = "snap"
        elif reading.held:
            mode = "hold"
        elif not reading.discontinuity:
            mode = "soft"
        elif reading.jump_ms is not None and reading.jump_ms <= GLIDE_MAX_MS:
            mode = "glide"
        else:
            # A move with no measured size is one the clock could not compare
            # against anything (the first reading of a session): there is nothing
            # to glide along, so it lands.
            mode = "snap"
        self._force_snap = False
        # Project to push time, not read time. The tick reads the player once
        # up front, then spends real time on metadata/lyric payloads before it
        # gets here; pushing the read-time value would anchor the UI whole
        # projection that far behind the audio. Same leash as the clock, no
        # extra SMTC read, and a paused clock projects to its frozen anchor.
        try:
            live_ms = self.clock.position_now()
        except Exception:
            live_ms = None
        if live_ms is None:
            live_ms = reading.position_ms
        self._push_js(f"window.syncPlayhead({live_ms:.1f}, "
                      f"{json.dumps(mode)});")

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

        self._vlc_last_playing = False
        self._vlc_track_sig = ""
        # Set when something outside the audio source invalidates the lyrics
        # currently on screen (the user just bound a local TTML file, or cleared
        # one). The loop treats it exactly like a track change: refetch, reload,
        # re-render — without waiting for the song to end.
        self.reload_requested = False
        last_playing = False

        while not self.shutdown_event.is_set():
            # The tick rate is the player's poll rate, not the UI's frame rate:
            # the overlay extrapolates the playhead between reads.
            sleep_duration = self.PAUSED_POLL_S

            try:
                chosen = await self._pick_session(manager)
                session = chosen["session"] if chosen else None
                self.current_session = session

                if session is None:
                    vlc_state = self._vlc_tick(window)
                    if vlc_state is None:
                        if not self._idle:
                            # Nothing is playing at all. Said once, not per tick:
                            # the lyrics stay on screen, frozen, so the user keeps
                            # their place in the song they were listening to.
                            # (_pick_session has already dropped the followed
                            # session and its clock.)
                            self._idle = True
                            window.evaluate_js("window.setPlaybackState(false);")
                            window.evaluate_js("window.setCoverArt(null);")
                        # Sleep longer when no media player is active
                        await asyncio.sleep(self.IDLE_POLL_S)
                        continue
                    self._idle = False
                    await asyncio.sleep(self.vlc.poll_interval(vlc_state))
                    continue
                self._idle = False

                playing, rate = self._playback_state()
                # A status read taken within the settle window of our own command
                # may still be the pre-command value (measured on SimpMusic).
                is_playing = self._effective_playing(playing)

                # One timeline read per tick, through the clock: it ages the
                # player's snapshot to the present, projects it forward within
                # what that player's own refresh cadence justifies, and says
                # whether the result drifted or jumped. The sample it came from
                # serves the rest of the tick — the duration and the signature.
                reading, sample = self._read_tick(playing=is_playing, rate=rate)

                # 1. Update Play / Pause state in UI if changed. A pause is an
                #    event the UI cannot see coming: its clock freezes wherever it
                #    had reached, so the position that follows is a place to land
                #    on exactly. A resume is the mirror image: the UI freezes on
                #    pause, and by the time this side notices the resume and reads
                #    the player's position, that position has already moved on by
                #    however long the poll took. The clock ages the player's
                #    resume-time snapshot to make up the difference, and the snap
                #    is what hands the corrected position to the UI — landing on
                #    it now instead of letting it ease in from the pause point
                #    over the next second. On both edges, land.
                if is_playing != last_playing:
                    last_playing = is_playing
                    self._force_snap = True
                    window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")

                # Read track metadata safely. The duration comes from this tick's
                # single timeline read and is used for everything downstream — the
                # signature, the lyrics lookup and the UI's total — so the three
                # can never disagree.
                info = chosen.get("info")
                if info is None:
                    info = await session.try_get_media_properties_async()
                published_duration = sample.duration_ms if sample is not None else None
                meta = media_meta_from_smtc(info, duration_ms=published_duration)
                title, artist, metadata_source = normalize_weak_title(
                    meta.raw_title, meta.raw_artist)
                meta = dc_replace(meta, raw_title=title, raw_artist=artist)
                album = album_for_search(meta)
                app_id = chosen["app_id"]

                # Computed from the REPAIRED title/artist, so the signature
                # matches what fetch_lyrics will search for. Album and duration
                # join the key so same-name tracks on different albums reload
                # instead of reusing the previous track's lyrics.
                track_core = build_track_core(meta, app_id)
                if track_core != self._loaded_core:
                    # A song announces its own length again on a change, even when
                    # that length is the value already on screen. A feed of
                    # 60-second items is full of tracks whose total never moves,
                    # and after the webview reloads this side's memory of what the
                    # UI was told is all that is left — nothing else re-sends it.
                    self._pushed_duration = _UNPUSHED
                # The length this player publishes, and the length of THIS track,
                # are not the same thing: a browser publishes the duration a moment
                # after the title, and a seek zeroes its whole timeline for as long
                # as it stays paused (measured). So the last length published under
                # this track's own core signature is remembered — a blank read then
                # neither takes a known song's length away from the UI nor hands a
                # new track the previous one's.
                if published_duration is not None:
                    self._length_core, self._length_ms = track_core, published_duration
                duration_ms = published_duration
                if duration_ms is None and self._length_core == track_core:
                    duration_ms = self._length_ms
                meta = dc_replace(meta, duration_ms=duration_ms)
                track_sig = build_track_signature(meta, app_id)

                # 2. The track's length, announced before the lyric work below:
                #    the length is not the lyrics' business, and a lookup that keeps
                #    throwing (the `continue` further down) must not hold it back.
                #    `_publish_duration` keeps the full story of what that cost.
                self._publish_duration(window, duration_ms)

                # 3. Track Change Detected: Fetch new lyrics & stream album cover
                should_load = False
                if self.reload_requested:
                    self.reload_requested = False
                    self._pending_full = None
                    should_load = bool(title)
                elif track_core != self._loaded_core:
                    # Title or artist changed: a different song, whatever the
                    # album says, and it loads immediately.
                    self._pending_full = None
                    should_load = bool(title)
                elif track_sig != self._loaded_full:
                    # Same title and artist; the album or the duration differs.
                    # Players publish those seconds after the title (a browser
                    # fills them in late), so most of the time this is metadata
                    # catching up and reloading would restart the lyrics of a
                    # song that never changed.
                    if self._metadata_only_refined(duration_ms):
                        self._loaded_full = track_sig
                        self._loaded_album = album
                        self._loaded_duration = duration_ms
                        self._pending_full = None
                    elif self._pending_full != track_sig:
                        self._pending_full = track_sig
                        self._pending_since = time.time()
                    elif time.time() - self._pending_since >= self.TRACK_SETTLE_S:
                        self._pending_full = None
                        should_load = True
                else:
                    self._pending_full = None

                if should_load:
                    # NOTE: the signature is committed only AFTER the fetch
                    # succeeds (below). Committing it here meant any throw in
                    # between — a malformed API payload, an evaluate_js before
                    # app.js was ready — was swallowed by the loop's except and
                    # left the signature recorded, so the track never retried
                    # and the UI sat on the loading spinner forever.
                    self.request_generation += 1
                    gen = self.request_generation

                    # The clock restarts with the lyrics: the player's next
                    # snapshot belongs to the new song, and comparing it against
                    # the old song's position would read as a monstrous seek.
                    self.clock.reset()
                    self._force_snap = True

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

                    # Read AFTER the fetch, so the lyrics open where the audio has
                    # reached by the time they exist rather than where it was when
                    # the change was noticed — a two-second lookup used to cost
                    # two seconds of sync. The clock was reset just above, so this
                    # reading belongs to the NEW song even if the player's own
                    # timeline still lags for a moment.
                    reading, _sample = self._read_tick(playing=is_playing, rate=rate)
                    initial_elapsed_ms = (reading.position_ms
                                          if reading is not None else None)
                    if initial_elapsed_ms is None:
                        # No timeline to read yet: open at the top rather than at
                        # a position invented from nothing, and let the first real
                        # sample land the playhead (see _push_playhead).
                        initial_elapsed_ms = 0.0
                    track_key = track_id or track_sig
                    # Starting offset depends on where the lyrics came from: a
                    # cached payload opens at the tuned baseline, a fresh fetch
                    # at the wider one. The stored per-track value (if the user
                    # has nudged this song before) still wins — and is reported as
                    # such, because the UI's opt-in auto-latency may replace the
                    # DEFAULT for this track but must never overwrite a value the
                    # user chose.
                    stored_offset = CACHE.get_latency(track_key, None)
                    saved_offset = (stored_offset if stored_offset is not None
                                    else default_latency_for(diagnostics.get("cache")))

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
                        f"{json.dumps(beat_plan)}, "
                        f"{json.dumps(stored_offset is None)});"
                    )
                    # Explains in the UI why these lyrics are syllable- or line-synced.
                    window.evaluate_js(f"window.setDiagnostics({json.dumps(diagnostics)});")
                    # Feeds the split-layout transport (elapsed / total / progress bar).
                    # `null` means "this player publishes no duration" — the UI clears
                    # the labels and disables the seek bar instead of showing the
                    # previous track's length or a fabricated 0:00.
                    window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")
                    # What this player's transport can actually do, for the
                    # diagnostics panel.
                    self._push_transport_state(app_id, bool(self._timeline_published),
                                               duration_ms)

                    # Commit only once the track is actually on screen. A throw
                    # in any bridge call above (e.g. before app.js has defined
                    # loadLyrics) then retries rather than sticking on a track
                    # whose signature was already recorded.
                    self._loaded_core = track_core
                    self._loaded_full = track_sig
                    self._loaded_album = album
                    self._loaded_duration = duration_ms

                # 4. Push the playhead. This side is the clock: it is the only
                #    one that has seen the player's snapshot, aged it to the
                #    present and decided whether the position drifted or jumped,
                #    and the UI's own 1x projection is nothing more than
                #    interpolation between these reports. So one goes out every
                #    tick; the UI drops the ones that agree with where its wipe
                #    already is and eases the rest in (SYNC_IGNORE_MS /
                #    SYNC_SNAP_MS). Sending them only when a sample happened to
                #    change is what let a player which republishes rarely — or a
                #    reporting gap after a resume — leave the lyrics behind with
                #    nothing left to correct them.
                if reading is not None and reading.position_ms is not None:
                    self._push_playhead(reading)

                sleep_duration = (self.BLANK_POLL_S
                                  if (sample is not None and not sample.published
                                      and is_playing)
                                  else (self.PLAYING_POLL_S if is_playing
                                        else self.PAUSED_POLL_S))

            except Exception as exc:
                # Catch disconnected sessions when a player is closed — but say
                # so, because a tick that dies silently is a sync bug nobody can
                # report.
                debug_log("[SMTC] tick failed:", exc)
                self.current_session = None

            await asyncio.sleep(sleep_duration)

    def _metadata_only_refined(self, duration_ms) -> bool:
        """Whether a signature change is a player filling in a missing field.

        The album and the duration are the two fields players publish late, so a
        change in them alone is far more often metadata catching up than a
        different recording — and reloading on it restarts the lyrics of a song
        that never changed. A different *recording* of the same title and artist
        (live vs studio, remaster, a longer edit) shows up as a duration that was
        already known and now differs by more than a rounding error.
        """
        previous, current = self._loaded_duration, duration_ms
        if previous is None or current is None:
            return True
        return abs(float(current) - float(previous)) < self.DURATION_CHANGE_MS

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
            self._force_snap = True
            window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")

        if not state.title:
            return state  # radio/untitled stream: nothing to look up

        track_sig = f"vlc:::{state.title}:::{state.artist}:::{state.album}:::{int(state.length_ms or 0)}"
        if self.reload_requested:
            # Same invalidation as the SMTC path: drop the remembered signature so
            # the current track is refetched with the new local file in play.
            self.reload_requested = False
            self._vlc_track_sig = ""
        changed = track_sig != self._vlc_track_sig
        if changed:
            self._vlc_track_sig = track_sig
            self.clock.reset()
            self._force_snap = True
            window.evaluate_js(f"window.showLoading({json.dumps(state.title)}, {json.dumps(state.artist)});")
            window.evaluate_js("window.setCoverArt(null);")

        # One position read per poll, through the same clock the SMTC path uses.
        # VLC reports whole seconds, so the sample is a bucket rather than a
        # point; telling the clock that is what stops a coarsely reported second
        # from pulling the lyrics back on every single poll. The read also opens
        # a new track, so it happens before the lyrics are seeded with it.
        reading = None
        if state.position_ms is not None:
            reading = self.clock.observe(
                state.position_ms, time.monotonic(), playing=is_playing,
                duration_ms=state.length_ms, quantized_ms=self.VLC_QUANTIZED_MS)

        if changed:
            try:
                lines, source, _tid, diagnostics = fetch_lyrics(
                    state.title, state.artist, state.length_ms, state.album, "filename")
                if not self.shutdown_event.is_set():
                    lines_json = json.dumps(lines)
                    # Same cache-aware starting offset as the SMTC path, the same
                    # per-track override, and the same default-vs-chosen flag (the
                    # VLC path used to ignore both and always hand the UI the
                    # baseline). VLC reports its own position, so it publishes a
                    # live timeline and the UI's auto-latency stays out of the way.
                    stored_offset = CACHE.get_latency(track_sig, None)
                    saved_offset = (stored_offset if stored_offset is not None
                                    else default_latency_for(diagnostics.get("cache")))
                    seed_ms = (reading.position_ms
                               if reading is not None and reading.position_ms is not None
                               else 0)
                    window.evaluate_js(
                        f"window.loadLyrics({lines_json}, {json.dumps(state.title)}, "
                        f"{json.dumps(state.artist)}, {json.dumps(source)}, "
                        f"{seed_ms}, {json.dumps(track_sig)}, "
                        f"{saved_offset}, null, "
                        f"{json.dumps(stored_offset is None)});"
                    )
                    window.evaluate_js(f"window.setDiagnostics({json.dumps(diagnostics)});")
                    # VLC reports its own position and length, so its timeline is
                    # live; the length can still be missing on a stream.
                    self._push_transport_state("VLC", True, state.length_ms)
                    window.evaluate_js(f"window.setPlaybackState({str(is_playing).lower()});")
            except Exception as exc:
                debug_log("VLC lyric fetch failed:", exc)
                self._vlc_track_sig = ""   # retry next tick

        # Every poll, not just the one that loaded the track: VLC answers with no
        # length at all until its status has been read once, so a length that
        # appears a moment later used to reach the UI never — the push lived
        # inside the track-changed branch. Ordering it after the load keeps the
        # same promise the SMTC path makes (the length is the tick's own read),
        # and ``_publish_duration`` skips it when nothing changed.
        self._publish_duration(window, state.length_ms or None)

        if reading is not None and reading.position_ms is not None:
            self._push_playhead(reading)
        return state

    async def _pick_session(self, manager):
        """
        The session the overlay should follow.

        Wrapper around the pure policy in ``core.session``: it turns the live
        sessions into plain descriptors — including the one piece of identity
        that tells two tabs of the same browser apart, the title each session
        says it is playing — lets the policy decide, and maps the chosen key
        back to the session object.

        Reading each session's title is what forces this to be asynchronous, and
        it is not optional: `get_sessions()` hands back new wrapper objects every
        call, so "is this the session we were following" and "which of these tabs
        is playing" can only be answered from what the sessions say about
        themselves. The read is reused by the caller, so choosing a session does
        not cost a second look at its metadata.
        """
        try:
            sessions = list(manager.get_sessions())
        except Exception as exc:
            debug_log("[SMTC] session enumeration failed:", exc)
            sessions = []
        if not sessions:
            if self.followed_key:
                # The session we were following is gone: neither VLC nor the idle
                # path inherits its timeline, and the UI must land wherever the
                # next source says instead of gliding from the old playhead.
                self.followed_key = ""
                self.clock.reset()
                self._force_snap = True
            self.pinned_app_id = ""
            self.challenger_since = None
            return None

        descriptors = []
        for index, live in enumerate(sessions):
            app_id = self._session_app_id(live)
            info = None
            title = ""
            try:
                info = await live.try_get_media_properties_async()
                title = getattr(info, "title", "") or ""
            except Exception as exc:
                debug_log("[SMTC] session properties read failed:", exc)
            title = " ".join(str(title).split())
            # The app id alone merges every tab of one browser, which is exactly
            # the confusion this key exists to remove. With no title to report,
            # the slot in the session list is the best remaining identity.
            key = f"{app_id}\u0001{title}" if title else f"{app_id}\u0001#{index}"
            descriptors.append({
                "key": key,
                "app_id": app_id,
                "playing": self._is_playing(live),
                "session": live,
                "info": info,
            })

        previous = self.followed_key
        chosen_key, self.followed_key, self.challenger_since = select_session(
            descriptors, previous, self.challenger_since, time.time(),
            pinned_app_id=self.pinned_app_id, quiet_s=self.HANDOVER_QUIET_S,
        )
        if previous and chosen_key != previous:
            self.clock.reset()
            self._force_snap = True

        if chosen_key is None:
            return None
        for descriptor in descriptors:
            if descriptor["key"] == chosen_key:
                self.pinned_app_id = descriptor["app_id"]
                return descriptor
        return None

    def start(self, window):
        """Entry point for the pywebview background worker thread."""
        asyncio.run(self.run(window))