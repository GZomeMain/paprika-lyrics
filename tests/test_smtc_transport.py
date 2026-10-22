"""Regression tests for the GSMTC bridge (core.smtc) with mocked sessions.

Every symptom reported for SimpMusic is pinned down here on a fake session whose
behaviour matches what was measured on Windows with tools/smtc_diagnose.py:

* the player publishes no timeline at all (zero fields, sentinel
  last_updated_time), yet accepts transport commands;
* its reported playback status flaps back to PLAYING for a moment after a state
  change;
* it reports playback_rate None.

The mocked sessions cannot prove the fix works on the real player — that is what
the diagnostic script and the manual procedure are for — but they do pin the
behaviour the overlay now guarantees.
"""
import asyncio
import datetime
import json
import threading
import time
import unittest
from types import SimpleNamespace
from unittest import mock

try:
    from winsdk.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    )
    HAS_WINSDK = True
except ImportError:  # pragma: no cover - winsdk is Windows-only
    HAS_WINSDK = False

if HAS_WINSDK:
    import core.smtc as smtc_mod
    from core import smtc as _smtc  # noqa: F401  (ensures the module is loadable)

# Pure (no I/O), so these import on every platform.
from core.timeline import Reading
from core.vlc_meta import VlcState


SENTINEL = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)


def delta(ms):
    return datetime.timedelta(milliseconds=ms)


class FakeTimeline:
    """A WinRT timeline: every field present, in 100ns-tick timedeltas."""

    def __init__(self, start_ms=0, end_ms=0, position_ms=0, updated=SENTINEL,
                 min_seek_ms=0, max_seek_ms=0):
        self.start_time = delta(start_ms)
        self.end_time = delta(end_ms)
        self.position = delta(position_ms)
        self.last_updated_time = updated
        self.min_seek_time = delta(min_seek_ms)
        self.max_seek_time = delta(max_seek_ms)


def dead_timeline():
    """Exactly what SimpMusic published on Windows: nothing at all."""
    return FakeTimeline()


class FakeSession:
    def __init__(self, app_id="Simpmusic_ejp2bhxmz1qq6!Simpmusic", playing=True,
                 timeline=None, toggle=True, pause=True, play=True, seek=True,
                 next_track=True, previous=True, rate=None, title="Everything Is Easy"):
        self.source_app_user_model_id = app_id
        self.playing = playing
        self.timeline = timeline if timeline is not None else dead_timeline()
        self.rate = rate
        self.title = title
        self.results = {"toggle": toggle, "pause": pause, "play": play, "seek": seek,
                        "next": next_track, "previous": previous}
        self.calls = []

    # --- reads -----------------------------------------------------------
    def get_playback_info(self):
        return SimpleNamespace(
            playback_status=(PlaybackStatus.PLAYING if self.playing
                             else PlaybackStatus.PAUSED),
            playback_rate=self.rate,
        )

    def get_timeline_properties(self):
        return self.timeline

    async def try_get_media_properties_async(self):
        return SimpleNamespace(title=self.title, artist="Rum Jungle",
                               album_title="Everything Is Easy",
                               subtitle="", trackNumber=0)

    # --- commands --------------------------------------------------------
    async def try_toggle_play_pause_async(self):
        self.calls.append("toggle")
        if self.results["toggle"]:
            self.playing = not self.playing
        return self.results["toggle"]

    async def try_pause_async(self):
        self.calls.append("pause")
        if self.results["pause"]:
            self.playing = False
        return self.results["pause"]

    async def try_play_async(self):
        self.calls.append("play")
        if self.results["play"]:
            self.playing = True
        return self.results["play"]

    async def try_change_playback_position_async(self, value):
        self.calls.append(("seek", value))
        return self.results["seek"]

    async def try_skip_next_async(self):
        self.calls.append("next")
        return self.results["next"]

    async def try_skip_previous_async(self):
        self.calls.append("previous")
        return self.results["previous"]


class FakeWindow:
    def __init__(self, on_js=None):
        self.scripts = []
        self.on_js = on_js

    def evaluate_js(self, script):
        self.scripts.append(script)
        if self.on_js:
            self.on_js(script, self)

    # --- helpers for assertions -----------------------------------------
    def payloads(self, prefix):
        out = []
        for script in self.scripts:
            if script.startswith(prefix):
                out.append(json.loads(script[len(prefix):-2]))
        return out

    def transport_results(self):
        return self.payloads("window.transportResult(")

    def syncs(self):
        """(position_ms, mode) for every playhead push, in order.

        The mode is part of the bridge's contract with the UI: 'snap' means the
        lyrics must land on that position, 'soft' means they may ease into it.
        """
        out = []
        for script in self.scripts:
            if script.startswith("window.syncPlayhead("):
                position, mode = script[len("window.syncPlayhead("):-2].split(",", 1)
                out.append((json.loads(position), json.loads(mode)))
        return out

    def sync_values(self):
        return [position for position, _mode in self.syncs()]

    def durations(self):
        return self.payloads("window.setTrackDuration(")

    def transport_states(self):
        return self.payloads("window.setTransportState(")


def make_bridge(session=None, window=None, vlc_configured=False):
    bridge = smtc_mod.SmtcBridge(threading.Event())
    bridge.current_session = session
    bridge.window = window if window is not None else FakeWindow()
    # Deterministic: never let a developer's VLC_HTTP_PASSWORD change the path
    # these tests take.
    bridge.vlc = SimpleNamespace(configured=vlc_configured, calls=[],
                                 command=lambda cmd, **params: bridge.vlc.calls.append((cmd, params)))
    return bridge


class LoopThread:
    """A real background event loop, i.e. the path the shell actually uses."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)


def wait_for(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class TimelineReadTest(unittest.TestCase):
    def test_position_and_duration_are_none_for_a_dead_timeline(self):
        # SimpMusic: status and metadata are fine, the timeline is empty. The
        # overlay must report "no reading", never 0.0 and never a duration.
        bridge = make_bridge(FakeSession(playing=True))
        self.assertIsNone(bridge._get_position_ms())
        self.assertIsNone(bridge._get_duration_ms())

    def test_duration_subtracts_the_item_origin(self):
        # A chapter/cue-less player with a non-zero origin: end_time alone used
        # to be reported as the duration.
        session = FakeSession(timeline=FakeTimeline(start_ms=1000, end_ms=181000,
                                                   position_ms=31000))
        bridge = make_bridge(session)
        self.assertEqual(bridge._get_duration_ms(), 180000.0)
        self.assertEqual(bridge._get_position_ms(), 30000.0)

    def test_live_timeline_projects_between_samples(self):
        clock = {"now": 100.0}
        session = FakeSession(timeline=FakeTimeline(end_ms=240000, position_ms=50000))
        bridge = make_bridge(session)
        with mock.patch.object(smtc_mod.time, "monotonic", lambda: clock["now"]):
            self.assertEqual(bridge._get_position_ms(), 50000.0)
            clock["now"] = 101.0
            # Same snapshot, one second later: interpolated, not repeated.
            self.assertEqual(bridge._get_position_ms(), 51000.0)

    def test_published_timeline_is_reported_once_to_the_ui(self):
        bridge = make_bridge(FakeSession(
            app_id="Spotify.exe", timeline=FakeTimeline(end_ms=200000, position_ms=1000)))
        bridge._get_position_ms()
        bridge._get_position_ms()
        states = bridge.window.transport_states()
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0]["timeline"], True)
        self.assertEqual(states[0]["duration"], True)
        self.assertEqual(states[0]["app"], "Spotify.exe")

    def test_dead_timeline_is_reported_as_unpublished(self):
        bridge = make_bridge(FakeSession())
        bridge._get_position_ms()
        states = bridge.window.transport_states()
        self.assertEqual(len(states), 1)
        self.assertEqual(states[0]["timeline"], False)
        self.assertEqual(states[0]["duration"], False)

    def test_rate_is_taken_from_the_player_or_defaulted(self):
        session = FakeSession(timeline=FakeTimeline(end_ms=240000, position_ms=0))
        bridge = make_bridge(session)
        self.assertEqual(bridge._playback_state(), (True, 1.0))
        session.rate = 1.5
        self.assertEqual(bridge._playback_state(), (True, 1.5))

    def test_no_session_reads_nothing(self):
        bridge = make_bridge(None)
        self.assertIsNone(bridge._get_position_ms())
        self.assertIsNone(bridge._get_duration_ms())


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class ToggleTest(unittest.TestCase):
    def test_uses_the_combined_toggle_the_player_advertises(self):
        # Windows' own media controls press the combined toggle; SimpMusic
        # advertises is_play_pause_toggle_enabled=True and honours it.
        session = FakeSession(playing=True)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_toggle())
        self.assertEqual(session.calls, ["toggle"])
        self.assertFalse(session.playing)

    def test_reconciles_the_ui_without_waiting_for_a_tick(self):
        session = FakeSession(playing=True)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_toggle())
        self.assertIn("window.setPlaybackState(false);", bridge.window.scripts)
        results = bridge.window.transport_results()
        self.assertEqual(results[-1]["action"], "toggle")
        self.assertTrue(results[-1]["ok"])

    def test_falls_back_to_play_pause_when_the_toggle_is_refused(self):
        session = FakeSession(playing=True, toggle=False, pause=True)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_toggle())
        self.assertEqual(session.calls, ["toggle", "pause"])
        self.assertTrue(bridge.window.transport_results()[-1]["ok"])

    def test_refusal_is_surfaced_not_swallowed(self):
        session = FakeSession(playing=True, toggle=False, pause=False)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_toggle())
        result = bridge.window.transport_results()[-1]
        self.assertFalse(result["ok"])
        self.assertEqual(result["detail"], "player refused")
        # Nothing was achieved, so the UI must not be told playback changed.
        self.assertNotIn("window.setPlaybackState(false);", bridge.window.scripts)

    def test_exception_is_surfaced(self):
        session = FakeSession(playing=True)
        session.try_toggle_play_pause_async = mock.AsyncMock(side_effect=RuntimeError("closed"))
        bridge = make_bridge(session)
        asyncio.run(bridge._do_toggle())
        result = bridge.window.transport_results()[-1]
        self.assertFalse(result["ok"])
        self.assertIn("closed", result["detail"])

    def test_stale_status_within_the_settle_window_is_ignored(self):
        # Measured on SimpMusic: a status read taken right after our command can
        # still report the PRE-command state, which flipped the play button back.
        bridge = make_bridge(FakeSession(playing=True))
        bridge._reconcile_playback(False)
        self.assertFalse(bridge._effective_playing(True))
        # Once the window has passed, the player's answer wins again.
        bridge._expect_at -= smtc_mod.SmtcBridge.COMMAND_SETTLE_S * 2
        self.assertTrue(bridge._effective_playing(True))

    def test_agreement_clears_the_expectation(self):
        bridge = make_bridge(FakeSession(playing=True))
        bridge._reconcile_playback(False)
        self.assertFalse(bridge._effective_playing(False))
        self.assertIsNone(bridge._expect_playing)


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class SeekTest(unittest.TestCase):
    def test_seek_argument_is_100ns_ticks(self):
        session = FakeSession(playing=True)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_seek(30000))
        self.assertEqual(session.calls[0], ("seek", 300_000_000))

    def test_playing_seek_re_asserts_play(self):
        session = FakeSession(playing=True)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_seek(30000))
        self.assertIn("play", session.calls)

    def test_paused_seek_never_starts_playback(self):
        session = FakeSession(playing=False)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_seek(30000))
        self.assertNotIn("play", session.calls)
        self.assertIn(("seek", 300_000_000), session.calls)

    def test_backward_seek_is_the_same_conversion(self):
        session = FakeSession(playing=False)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_seek(1500.5))
        self.assertEqual(session.calls[0], ("seek", 15_005_000))

    def test_success_is_reported_and_marked_unverifiable_without_a_timeline(self):
        session = FakeSession(playing=True)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_seek(30000))
        result = bridge.window.transport_results()[-1]
        self.assertTrue(result["ok"])
        self.assertFalse(result["verified"])
        self.assertEqual(result["detail"], "target=30000ms")

    def test_success_is_verifiable_when_the_player_publishes_a_timeline(self):
        session = FakeSession(timeline=FakeTimeline(end_ms=240000, position_ms=1000))
        bridge = make_bridge(session)
        bridge._get_position_ms()          # observes the published timeline
        asyncio.run(bridge._do_seek(30000))
        self.assertTrue(bridge.window.transport_results()[-1]["verified"])

    def test_refusal_is_reported_so_the_ui_can_roll_back(self):
        session = FakeSession(playing=True, seek=False)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_seek(30000))
        result = bridge.window.transport_results()[-1]
        self.assertFalse(result["ok"])
        self.assertEqual(result["action"], "seek")


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class PushModeTest(unittest.TestCase):
    """How the bridge tells the UI to take a position report.

    The mode is part of the contract: 'snap' lands the lyrics where they belong,
    'glide' travels there over a third of a second, 'soft' eases drift in. Which
    one a report deserves is the bridge's call, because only it sees the
    chronology of the player's samples.
    """

    def _push(self, bridge, **reading):
        bridge._push_playhead(Reading(**reading))
        return bridge.window.syncs()[-1]

    def test_ordinary_drift_is_soft(self):
        bridge = make_bridge(FakeSession())
        self.assertEqual(self._push(bridge, position_ms=1000.0)[1], "soft")

    def test_a_track_change_lands(self):
        bridge = make_bridge(FakeSession())
        bridge._force_snap = True
        self.assertEqual(self._push(bridge, position_ms=1000.0)[1], "snap")
        # ...and the flag is spent, not left armed for the next report.
        self.assertEqual(self._push(bridge, position_ms=1200.0)[1], "soft")

    def test_a_seek_inside_the_song_glides(self):
        # Reported: "when changing progression in the music player it should
        # smoothly go to the part of the song." A move this size is a scrub of the
        # player's own bar, and the wipe travels to it rather than cutting.
        bridge = make_bridge(FakeSession())
        mode = self._push(bridge, position_ms=30_000.0, discontinuity=True,
                          jump_ms=4500.0)[1]
        self.assertEqual(mode, "glide")
        self.assertEqual(bridge.window.sync_values()[-1], 30_000.0)

    def test_a_move_across_the_song_lands(self):
        # Sweeping a whole verse' worth of lyric in 250 ms reads as a glitch, so a
        # move beyond GLIDE_MAX_MS lands where the audio actually is.
        bridge = make_bridge(FakeSession())
        mode = self._push(bridge, position_ms=200_000.0, discontinuity=True,
                          jump_ms=smtc_mod.GLIDE_MAX_MS + 1.0)[1]
        self.assertEqual(mode, "snap")

    def test_the_glide_boundary_is_inclusive(self):
        bridge = make_bridge(FakeSession())
        mode = self._push(bridge, position_ms=10_000.0, discontinuity=True,
                          jump_ms=smtc_mod.GLIDE_MAX_MS)[1]
        self.assertEqual(mode, "glide")

    def test_a_move_of_unknown_size_lands(self):
        # The first reading of a track is a discontinuity with nothing to have
        # moved from, so there is no travel to ease along.
        bridge = make_bridge(FakeSession())
        mode = self._push(bridge, position_ms=0.0, discontinuity=True)[1]
        self.assertEqual(mode, "snap")

    def test_a_forced_snap_beats_a_small_move(self):
        # A play/pause edge is never a matter of taste, whatever the size of the
        # move attached to it.
        bridge = make_bridge(FakeSession())
        bridge._force_snap = True
        mode = self._push(bridge, position_ms=60_000.0, discontinuity=True,
                          jump_ms=1200.0)[1]
        self.assertEqual(mode, "snap")

    def test_a_held_reading_holds(self):
        # A parked projection (no fresh sample) is sent as 'hold', so the UI keeps
        # its own 1x projection instead of being dragged back to it. Reporting it
        # as 'soft' stalled real-time sync and re-swept the syllables already
        # passed on browsers and SimpMusic.
        bridge = make_bridge(FakeSession())
        self.assertEqual(self._push(bridge, position_ms=1000.0, held=True)[1],
                         "hold")

    def test_a_forced_snap_beats_a_hold(self):
        # A play/pause edge still lands, whatever the reading says about its
        # freshness.
        bridge = make_bridge(FakeSession())
        bridge._force_snap = True
        self.assertEqual(self._push(bridge, position_ms=1000.0, held=True)[1],
                         "snap")


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class SkipTest(unittest.TestCase):
    def test_skip_next_reports_success_and_resets_the_clock(self):
        session = FakeSession()
        bridge = make_bridge(session)
        bridge.clock.observe(200000.0, 0.0, playing=True)
        asyncio.run(bridge._do_skip_next())
        self.assertEqual(session.calls, ["next"])
        self.assertTrue(bridge.window.transport_results()[-1]["ok"])
        self.assertIsNone(bridge.clock.anchor_ms)

    def test_skip_previous_refusal_is_surfaced(self):
        session = FakeSession(previous=False)
        bridge = make_bridge(session)
        asyncio.run(bridge._do_skip_previous())
        result = bridge.window.transport_results()[-1]
        self.assertFalse(result["ok"])
        self.assertEqual(result["action"], "skip_previous")


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class DispatchTest(unittest.TestCase):
    def test_command_runs_on_the_session_loop(self):
        session = FakeSession(playing=True)
        bridge = make_bridge(session)
        loop_thread = LoopThread()
        try:
            bridge.event_loop = loop_thread.loop
            bridge.toggle_playback()
            self.assertTrue(wait_for(lambda: session.calls == ["toggle"]))
        finally:
            loop_thread.stop()
        # Reads and commands went to the same session object.
        self.assertIs(bridge.current_session, session)

    def test_no_session_and_no_vlc_reports_the_drop(self):
        bridge = make_bridge(None)
        bridge.toggle_playback()
        result = bridge.window.transport_results()[-1]
        self.assertFalse(result["ok"])
        self.assertEqual(result["detail"], "no media session")

    def test_no_session_falls_back_to_vlc(self):
        bridge = make_bridge(None, vlc_configured=True)
        bridge.seek_position(30000)
        self.assertEqual(bridge.vlc.calls, [("seek", {"val": "30"})])

    def test_session_with_a_dead_loop_is_not_silently_dropped(self):
        bridge = make_bridge(FakeSession())
        bridge.event_loop = None
        bridge.skip_next()
        results = bridge.window.transport_results()
        self.assertEqual(len(results), 1)
        self.assertFalse(results[0]["ok"])
        self.assertEqual(results[0]["detail"], "event loop not running")


# ---------------------------------------------------------------------------
# The loop's payload: what the UI is actually fed for each kind of player.
# ---------------------------------------------------------------------------

def fake_fetch(title, artist, duration_ms, album, metadata_source):
    return ([{"startTimeMs": 1000.0, "endTimeMs": 2000.0, "text": "hi", "words": []}],
            "test", "tid", {"cache": "hit"})


async def _no_thumbnail(_info):
    return None


class FakeManager:
    def __init__(self, sessions):
        self.sessions = list(sessions)

    def get_sessions(self):
        return list(self.sessions)

    def get_current_session(self):
        return self.sessions[0] if self.sessions else None


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class LoopPayloadTest(unittest.TestCase):
    """Drives the real run() loop against a fake Windows media manager."""

    def _drive(self, manager, seconds=2.0, on_js=None):
        bridge = make_bridge(None, FakeWindow(on_js=on_js))
        async def request_async():
            return manager

        async def _run():
            task = asyncio.create_task(bridge.run(bridge.window))
            await asyncio.sleep(seconds)
            bridge.shutdown_event.set()
            await asyncio.wait_for(task, timeout=10)

        with mock.patch.object(smtc_mod, "MediaManager",
                               SimpleNamespace(request_async=request_async)), \
             mock.patch.object(smtc_mod, "fetch_lyrics", fake_fetch), \
             mock.patch.object(smtc_mod, "_get_thumbnail_base64", _no_thumbnail), \
             mock.patch.object(smtc_mod, "resolve_artwork_url",
                               lambda *a, **k: None):
            asyncio.run(_run())
        return bridge

    def test_player_without_a_timeline_gets_no_position_sync_and_no_duration(self):
        # The SimpMusic case: honest "unknown" all the way to the UI, and no
        # fabricated 0:00 duration or syncPlayhead(0) spam.
        session = FakeSession(playing=True)
        bridge = self._drive(FakeManager([session]))
        self.assertEqual(bridge.window.durations(), [None])
        self.assertEqual(bridge.window.syncs(), [])
        states = bridge.window.transport_states()
        self.assertTrue(states)
        self.assertEqual(states[-1]["timeline"], False)
        self.assertEqual(states[-1]["duration"], False)

    def test_player_with_a_timeline_gets_a_duration_and_position_syncs(self):
        session = FakeSession(
            app_id="Spotify.exe", playing=True,
            timeline=FakeTimeline(end_ms=240000, position_ms=50000))
        bridge = self._drive(FakeManager([session]))
        self.assertEqual(bridge.window.durations(), [240000.0])
        syncs = bridge.window.syncs()
        self.assertTrue(syncs)
        for value, _mode in syncs:
            self.assertGreaterEqual(value, 50000.0)
            self.assertLess(value, 60000.0)
        self.assertEqual(bridge.window.transport_states()[-1]["duration"], True)

    def test_session_replacement_does_not_inherit_the_old_position(self):
        old = FakeSession(playing=True,
                          timeline=FakeTimeline(end_ms=400000, position_ms=200000))
        new = FakeSession(playing=True, title="Night Running",
                          timeline=FakeTimeline(end_ms=400000, position_ms=2000))
        manager = FakeManager([old])
        swapped = {"at": None}

        def on_js(script, window):
            # Windows replaces the session object when a player restarts its SMTC
            # session, always at a tick boundary: swap after the first position
            # sync has been pushed for the old one.
            if swapped["at"] is None and script.startswith("window.syncPlayhead("):
                swapped["at"] = len(window.scripts)
                manager.sessions = [new]

        bridge = self._drive(manager, on_js=on_js)
        self.assertIsNotNone(swapped["at"])
        self.assertIs(bridge.current_session, new)

        def values(scripts):
            return [json.loads(s[len("window.syncPlayhead("):-2].split(",", 1)[0])
                    for s in scripts if s.startswith("window.syncPlayhead(")]

        before = values(bridge.window.scripts[:swapped["at"]])
        after = values(bridge.window.scripts[swapped["at"]:])
        self.assertTrue(before)
        self.assertGreater(before[0], 199000.0)     # the old session was followed
        self.assertTrue(after)                      # and then the new one
        # Nothing from the old session's 200s position survives the swap.
        for value in after:
            self.assertLess(value, 60000.0)
        self.assertGreaterEqual(before[-1], 200000.0)


class ScriptedVlc:
    """A VLC source whose status read is set by the test; no HTTP involved."""

    def __init__(self, state=None):
        self.state = state
        self.configured = True
        self.commands = []

    def poll(self):
        return self.state

    def poll_interval(self, _state):
        return 0.0

    def command(self, command, **params):
        self.commands.append((command, params))


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class VlcTrackChangeTest(unittest.TestCase):
    """The VLC fallback must refetch on a new track — and only then.

    VLC 3.x never appears in GSMTC, so when no session exists the bridge polls
    VLC's HTTP interface and decides for itself when the track changed. That
    decision is the signature it keeps in `_vlc_track_sig`, and it is the whole
    feature: a signature that never changed would leave the previous song's
    lyrics on screen for the length of the next one.

    These drive the real `_vlc_tick`, not a helper, because the dead
    `VlcSource.changed_track` this replaced was exactly the kind of detector that
    passes review and never runs.
    """

    def _bridge(self):
        bridge = make_bridge(None)
        bridge.vlc = ScriptedVlc()
        return bridge

    def _tick(self, bridge, title, artist, length_ms, calls):
        bridge.vlc.state = VlcState(title=title, artist=artist, length_ms=length_ms,
                                   position_ms=1000.0, playing=True)

        def fake_fetch(fetched_title, fetched_artist, _duration, _album, _source):
            calls.append((fetched_title, fetched_artist))
            return ([{"startTimeMs": 0.0, "endTimeMs": 1000.0, "text": "hi", "words": []}],
                    "test", "tid", {"cache": "hit"})

        with mock.patch.object(smtc_mod, "fetch_lyrics", fake_fetch):
            bridge._vlc_tick(bridge.window)

    def test_a_new_track_refetches_and_a_repeat_does_not(self):
        bridge = self._bridge()
        calls = []
        self._tick(bridge, "Song A", "Artist", 100000, calls)
        self._tick(bridge, "Song A", "Artist", 100000, calls)   # same track
        self._tick(bridge, "Song B", "Artist", 120000, calls)   # next track
        self.assertEqual(calls, [("Song A", "Artist"), ("Song B", "Artist")])

    def test_the_lyrics_reach_the_ui_for_the_new_track(self):
        bridge = self._bridge()
        self._tick(bridge, "Song A", "Artist", 100000, [])
        self.assertTrue([s for s in bridge.window.scripts
                         if s.startswith("window.loadLyrics(")])

    def test_an_untagged_stream_is_not_looked_up(self):
        # VLC reports only the filename for an untagged stream, so there is
        # nothing to resolve; hammering the resolvers for it would be noise.
        bridge = self._bridge()
        calls = []
        self._tick(bridge, "", "", None, calls)
        self.assertEqual(calls, [])

    def test_the_ui_is_told_whether_the_offset_was_the_users_own(self):
        # The UI's opt-in auto-latency may replace the host's DEFAULT offset for a
        # track, and must never overwrite one the user nudged. That distinction is
        # only available to it because the bridge says which of the two it sent, so
        # the flag is pinned here — if it silently went missing, auto-latency would
        # start clobbering offsets the user had already tuned.
        def last_load_script(stored):
            bridge = self._bridge()
            bridge.vlc.state = VlcState(title="Song A", artist="Artist", length_ms=1000)

            def fake_fetch(*_args):
                return ([{"startTimeMs": 0.0, "endTimeMs": 1000.0, "text": "hi", "words": []}],
                        "test", "tid", {"cache": "hit"})

            fake_cache = SimpleNamespace(get_latency=lambda _key, _default: stored)
            with mock.patch.object(smtc_mod, "fetch_lyrics", fake_fetch), \
                 mock.patch.object(smtc_mod, "CACHE", fake_cache):
                bridge._vlc_tick(bridge.window)
            return [s for s in bridge.window.scripts
                    if s.startswith("window.loadLyrics(")][-1]

        self.assertTrue(
            last_load_script(1200).rstrip().endswith("false);"),
            "a stored offset must reach the UI as the user's own, not as a default")
        self.assertTrue(
            last_load_script(None).rstrip().endswith("true);"),
            "an absent offset must reach the UI as a default the UI may replace")

    def test_a_length_vlc_reports_late_reaches_the_ui(self):
        # VLC answers its first status poll with no length at all and fills it in
        # once the item is open. The push lived inside the track-changed branch,
        # so a length that appeared a moment later was never sent: the bar sat on
        # --:-- for the whole song while VLC knew exactly how long it was.
        bridge = self._bridge()
        self._tick(bridge, "Song A", "Artist", None, [])
        self.assertIs(bridge.window.durations()[-1], None)
        self._tick(bridge, "Song A", "Artist", 245000, [])
        self.assertEqual(bridge.window.durations()[-1], 245000.0)

    def test_a_failed_lookup_is_retried_on_the_next_tick(self):
        # The signature is cleared on failure, so a transient network error does
        # not leave the song lyric-less until the user skips.
        bridge = self._bridge()
        attempts = []

        def failing_fetch(fetched_title, *_args):
            attempts.append(fetched_title)
            raise RuntimeError("network down")

        bridge.vlc.state = VlcState(title="Song A", artist="Artist", length_ms=1000)
        with mock.patch.object(smtc_mod, "fetch_lyrics", failing_fetch):
            bridge._vlc_tick(bridge.window)
            bridge._vlc_tick(bridge.window)
        self.assertEqual(attempts, ["Song A", "Song A"])


# ---------------------------------------------------------------------------
# A browser-shaped session, driven through the real loop.
#
# These cover the symptoms reported from YouTube Music in a browser, end to end:
# what the bridge actually pushes to the UI, compared against where the audio
# really is at that moment.
# ---------------------------------------------------------------------------


class BrowserSession:
    """A media session shaped like a browser tab's.

    The property that matters is that the timeline is only *republished* every
    few seconds — a page calling ``setPositionState`` on a timer — so a reading
    taken at an arbitrary moment describes a position that is often seconds old.
    Everything else about the tab is honest: the position advances with real
    time, the write timestamp is truthful, and (as Chrome does) a state change
    republishes immediately.
    """

    def __init__(self, title="Song A", artist="Artist", duration_ms=240_000.0,
                 publish_interval_s=3.0, app_id="msedge.exe",
                 publishes_on_state_change=True, already_playing_s=0.0):
        self.source_app_user_model_id = app_id
        self.title = title
        self.artist = artist
        self.duration_ms = duration_ms
        self.publish_interval_s = float(publish_interval_s)
        self.publishes_on_state_change = publishes_on_state_change
        self.playing = True
        self.rate = 1.0
        self.base_ms = 0.0
        # The tab may have been playing long before the overlay started following
        # it, which is how old the snapshot it left behind is.
        self.base_at = time.monotonic() - float(already_playing_s)
        self.frozen_ms = 0.0
        self.published_ms = 0.0
        self.published_at = self.base_at
        self.published_wall = (smtc_mod.utcnow()
                               - datetime.timedelta(seconds=float(already_playing_s)))
        self.stalled = False
        self.blanked = False

    # --- the tab's own clock ---------------------------------------------
    def truth_at(self, instant=None):
        """Where the audio really is, at this instant or now."""
        if not self.playing or self.stalled:
            return self.frozen_ms
        return self.base_ms + ((time.monotonic() if instant is None else instant)
                               - self.base_at) * 1000.0

    def _publish(self):
        self.published_ms = self.truth_at()
        self.published_at = time.monotonic()
        self.published_wall = smtc_mod.utcnow()

    def stall(self):
        """Stop advancing while still reporting PLAYING.

        Measured on this machine: a media session whose playback status is
        PLAYING while its timeline has not been written for minutes and its
        position sits frozen. The page is not republishing, so from the outside
        it looks exactly like a tab that publishes rarely.
        """
        self.stalled = True
        self.frozen_ms = self.published_ms

    def blank_timeline(self):
        """Zero the whole timeline the way this player answers a seek.

        Measured on the machine's own player: after a seek it reported start,
        end, position and both seek bounds as zero while last_updated_time kept
        ticking, and stayed that way until it published its position state again.
        """
        self.blanked = True

    def republish(self):
        """The player writes its position state again: the blank spell is over."""
        self.blanked = False
        self._publish()

    def pause(self):
        self.frozen_ms = self.truth_at()
        self.playing = False
        self.base_at = time.monotonic()
        if self.publishes_on_state_change:
            self._publish()

    def resume(self):
        self.base_ms = self.frozen_ms
        self.base_at = time.monotonic()
        self.playing = True
        if self.publishes_on_state_change:
            self._publish()

    def change_track(self, title, position_ms=0.0):
        self.title = title
        self.base_ms = self.frozen_ms = self.published_ms = float(position_ms)
        self.base_at = self.published_at = time.monotonic()
        self.published_wall = smtc_mod.utcnow()

    # --- the WinRT surface ------------------------------------------------
    def get_playback_info(self):
        return SimpleNamespace(
            playback_status=(PlaybackStatus.PLAYING if self.playing
                             else PlaybackStatus.PAUSED),
            playback_rate=self.rate)

    def get_timeline_properties(self):
        if self.blanked:
            # No position state at all, with a live write time — exactly what the
            # measured player publishes after a seek.
            return FakeTimeline(updated=smtc_mod.utcnow())
        if (self.playing and not self.stalled
                and time.monotonic() - self.published_at >= self.publish_interval_s):
            self._publish()
        return FakeTimeline(end_ms=self.duration_ms, position_ms=self.published_ms,
                            updated=self.published_wall)

    async def try_get_media_properties_async(self):
        return SimpleNamespace(title=self.title, artist=self.artist,
                               album_title="Album", subtitle="", trackNumber=0)


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class BrowserSyncTest(unittest.TestCase):
    def _drive(self, session, steps, on_script=None, fetch=None):
        """Run the real loop while `steps` scripts what happens to the session.

        `steps` is a list of (seconds to wait, callable or None). Every playhead
        push is recorded with the exact instant it happened and the truth at that
        instant, which is what makes the assertions measurements rather than
        guesses.

        `on_script` sees every script before it is recorded, so a test can make
        one push fail the way a real webview does (a page that is still loading,
        an ``evaluate_js`` that raises); `fetch` replaces the lyric lookup.
        """
        pushes = []

        def on_js(script, window):
            if on_script is not None:
                on_script(script, window)
            if not script.startswith("window.syncPlayhead("):
                return
            position, mode = script[len("window.syncPlayhead("):-2].split(",", 1)
            at = time.monotonic()
            pushes.append({"at": at, "value": json.loads(position),
                           "mode": json.loads(mode), "truth": session.truth_at(at)})

        bridge = make_bridge(None, FakeWindow(on_js=on_js))
        window = bridge.window

        async def _run():
            task = asyncio.create_task(bridge.run(window))
            for wait, action in steps:
                await asyncio.sleep(wait)
                if action:
                    action()
            bridge.shutdown_event.set()
            await asyncio.wait_for(task, timeout=10)

        async def request_async():
            return FakeManager([session])

        with mock.patch.object(smtc_mod, "MediaManager",
                               SimpleNamespace(request_async=request_async)), \
             mock.patch.object(smtc_mod, "fetch_lyrics", fetch or fake_fetch), \
             mock.patch.object(smtc_mod, "_get_thumbnail_base64", _no_thumbnail), \
             mock.patch.object(smtc_mod, "resolve_artwork_url",
                               lambda *a, **k: None):
            asyncio.run(_run())
        return bridge, window, pushes

    def test_a_browser_that_republishes_every_few_seconds_is_not_behind(self):
        # Reported: "off the bat when a song starts, even with no default latency,
        # the song isn't synced and the lyrics become a lot behind." A snapshot
        # that is seconds old must be aged to the present, or every push
        # describes where the audio was when the page last spoke.
        session = BrowserSession(publish_interval_s=3.0)
        _bridge, _window, pushes = self._drive(session, [(2.6, None)])
        self.assertTrue(pushes)
        for push in pushes:
            self.assertAlmostEqual(push["value"], push["truth"], delta=250.0,
                                   msg=f"push at +{push['at']:.2f}s")

    def test_a_timeline_that_never_republishes_still_advances(self):
        # The other half of the same bug: a tab that only stamps its timeline
        # once. Freezing the lyrics after the leash would be worse than trusting
        # the wall clock, so a player that has shown no cadence gets no leash.
        session = BrowserSession(publish_interval_s=600.0)
        _bridge, _window, pushes = self._drive(session, [(3.0, None)])
        self.assertTrue(pushes)
        self.assertGreater(pushes[-1]["value"], 2500.0)
        for push in pushes:
            self.assertAlmostEqual(push["value"], push["truth"], delta=300.0)

    def test_a_pause_and_resume_never_sends_the_playhead_backwards(self):
        # Reported: "songs often change positions and reset to the beginning when
        # and after pausing." The paused position must also be where the audio
        # stopped, not wherever the player's last stale snapshot pointed.
        session = BrowserSession(publish_interval_s=4.0)
        paused = {}

        def pause():
            paused["at"] = time.monotonic()
            session.pause()

        _bridge, _window, pushes = self._drive(session, [
            (0.8, pause),
            (1.4, session.resume),
            (1.4, None),
        ])
        self.assertTrue(pushes)
        # The pause is a place the lyrics have to land on: their own clock freezes
        # wherever it had reached, which is ahead of where the audio stopped.
        after_pause = [push for push in pushes if push["at"] >= paused["at"]]
        self.assertEqual(after_pause[0]["mode"], "snap")
        values = [push["value"] for push in pushes]
        for previous, current in zip(values, values[1:]):
            self.assertGreater(current, previous - 300.0,
                               f"the playhead went backwards: {previous} -> {current}")
        for push in pushes:
            # The pause is detected up to one poll after it happened, so allow a
            # poll of overshoot there — but never a jump to another position.
            self.assertAlmostEqual(push["value"], push["truth"], delta=700.0)

    def test_an_unpause_lands_where_the_audio_is(self):
        # Reported: "pausing and unpausing causes slight delay". The paused clock
        # freezes, the resume is only noticed on the next poll, and the position
        # that follows has to be the corrected one — landed, not eased out of — or
        # the wipe spends the next second sliding up to where the song already is.
        session = BrowserSession(publish_interval_s=4.0)
        resumed = {}

        def resume():
            session.resume()
            resumed["at"] = time.monotonic()

        _bridge, _window, pushes = self._drive(session, [
            (0.7, session.pause),
            (1.0, resume),
            (0.5, None),
        ])
        after = [push for push in pushes if push["at"] >= resumed["at"]]
        self.assertTrue(after, "nothing was pushed after the resume")
        self.assertEqual(after[0]["mode"], "snap")
        # A poll of uncertainty is credited forward, never more: the wipe opens
        # within one poll of the audio rather than a poll behind it.
        self.assertAlmostEqual(after[0]["value"], after[0]["truth"], delta=300.0)

    def test_a_song_that_was_already_playing_opens_where_the_audio_is(self):
        # Reported: "sometimes off the bat when a song starts, even with no default
        # latency, the song isn't synced and the lyrics become a lot behind." A
        # page that published its position four seconds ago hands the bridge a
        # snapshot that old, and the write time is the only thing that says so.
        session = BrowserSession(publish_interval_s=5.0, already_playing_s=4.0)
        _bridge, _window, pushes = self._drive(session, [(1.4, None)])
        self.assertTrue(pushes)
        self.assertGreater(pushes[0]["value"], 3_900.0,
                           "the first report ignored how old the snapshot was")
        for push in pushes:
            self.assertAlmostEqual(push["value"], push["truth"], delta=400.0)

    def test_ordinary_playback_is_never_reported_as_a_jump(self):
        # A snap mid-song is a visible reset, so the bridge must only ever ask for
        # one when the position really moved: the first report of a track, a track
        # change, a seek, a play/pause edge. Ordinary drift is eased in.
        #
        # A browser republishing once a second leaves most polls with nothing new,
        # and that is what 'hold' is for: the clock still offers its leashed
        # projection, but as an estimate rather than as drift for the UI to obey —
        # obeying it is what dragged the wipe back over the same letters on every
        # poll. What this case is about is unchanged: nothing after the first
        # report may be a landing, and a player that really does republish still
        # gets real corrections through.
        session = BrowserSession(publish_interval_s=1.0)
        _bridge, _window, pushes = self._drive(session, [(2.6, None)])
        self.assertTrue(pushes)
        self.assertGreater(len(pushes), 3, "the playhead is not being reported")
        self.assertEqual(pushes[0]["mode"], "snap")
        modes = [push["mode"] for push in pushes[1:]]
        self.assertNotIn("snap", modes)
        self.assertNotIn("glide", modes)
        self.assertTrue(all(mode in ("soft", "hold") for mode in modes), modes)
        self.assertIn("soft", modes, modes)

    def test_a_player_that_claims_playing_with_a_frozen_timeline_is_held(self):
        # Measured on this machine: a session reports PLAYING while its timeline
        # has not been written for minutes and its position sits still. Running
        # the lyrics on from a number like that would sweep the whole song while
        # the audio went nowhere, so they stop just past the last thing the
        # player actually said — and they do still move up to that point, because
        # the same silence from a browser that publishes every few seconds is a
        # song the user is listening to.
        session = BrowserSession(publish_interval_s=600.0)
        session.published_ms = 4.0
        session.published_at = time.monotonic() - 300.0
        session.published_wall = smtc_mod.utcnow() - datetime.timedelta(minutes=5)
        session.stall()
        # A short leash, so the bound is observable inside a test-length run.
        with mock.patch("core.timeline.MAX_GRACE_MS", 2_000.0):
            _bridge, _window, pushes = self._drive(session, [(5.0, None)])
        self.assertTrue(pushes)
        self.assertGreater(pushes[-1]["value"], 1_500.0,
                           "the playhead was frozen instead of projected")
        self.assertLess(pushes[-1]["value"], 2_500.0,
                        "the playhead ran past everything the player said")

    def test_a_blank_timeline_while_playing_holds_the_lyrics_instead_of_free_running(self):
        # Reported: "changing progression from the music site itself doesn't sync
        # automatically, only pausing fixes it — and even the pause has light
        # latency". Measured on the machine's own browser session: a site-side
        # seek zeroes the whole timeline for about four seconds WHILE the player
        # keeps reporting PLAYING, then republishes the new position. Pushing
        # nothing through that window left the UI's wipe free-running from a
        # stale anchor with no correction at all; parking it at the last known
        # truth keeps the lyrics near where the audio is until the publish
        # lands (which arrives as a snap).
        session = BrowserSession(publish_interval_s=1.0, duration_ms=200_000.0)
        session.change_track("Hold Song", position_ms=50_000.0)
        seek = {}

        def blank():
            seek["at"] = time.monotonic()
            session.blank_timeline()

        bridge, window, pushes = self._drive(session, [
            (1.2, blank),
            (1.8, None),          # the measured ~4s blank stretch
            (0.6, session.republish),
            (0.6, None),
        ])
        self.assertTrue(pushes)
        after = [push for push in pushes if push["at"] >= seek["at"]]
        self.assertTrue(after, "nothing was pushed through the blank window at all")
        # The hold: through the blank the values stay parked at the pre-seek
        # truth rather than riding on with the UI's own 1x wipe (which by the
        # end of the blank spell would be ~2.4s past everything the player said).
        before = [push["value"] for push in pushes if push["at"] < seek["at"]]
        self.assertTrue(before)
        # During the blank the clock is deliberately still aging its last snapshot
        # forward (a fresh-stamped snapshot licenses projection), so the hold is
        # "no further than the leash the clock learned (cadence 1s → 2.5s) plus
        # one poll" rather than a hard freeze; what it must NOT do is ride on
        # unbounded while the player says nothing.
        window = self._drive_blank_window(pushes, seek["at"])
        self.assertLessEqual(window['drift'], 2500.0 + 500.0,
                             "the playhead free-ran through the blank window: "
                             f"{window['first']} -> {window['last']}")
        # ...and the publish lands the lyrics where the audio is.
        self.assertAlmostEqual(after[-1]["value"], after[-1]["truth"], delta=700.0)

    def _drive_blank_window(self, pushes, seek_at):
        """First/last/drift over the pushes that fall inside the blank window."""
        inside = [push for push in pushes if push["at"] >= seek_at]
        return {"first": inside[0]["value"],
                "last": inside[-1]["value"],
                "drift": inside[-1]["value"] - inside[0]["value"]}
        # Reported: "when changing progression from the music app/site itself it
        # resets from the beginning, and doesn't track the time." Measured on the
        # machine's own player: a seek zeroes the WHOLE timeline (start, end,
        # position, both seek bounds) while keeping a live write time, and holds
        # it until it publishes its position state again. The overlay must keep
        # its place — and its knowledge of the song's length — rather than read
        # that as "the song is at 0:00".
        session = BrowserSession(publish_interval_s=1.0, duration_ms=170_887.5)
        seek = {}

        def blank():
            seek["at"] = time.monotonic()
            session.blank_timeline()

        bridge, window, pushes = self._drive(session, [
            (1.2, blank),
            (0.6, session.republish),
            (0.6, None),
        ])
        self.assertTrue(pushes)
        after = [push for push in pushes if push["at"] >= seek["at"]]
        self.assertTrue(after, "no playhead was reported after the seek")
        for push in after:
            self.assertGreater(push["value"], 1_000.0,
                               "the overlay was reset to the top of the song")
        # The clock never took the blank for a position — so nothing is ever sent
        # backwards from where the lyrics already were — and the length the player
        # had already published for this track never left the UI.
        before = [push["value"] for push in pushes if push["at"] < seek["at"]]
        self.assertTrue(before)
        for push in after:
            self.assertGreater(push["value"], before[-1] - 300.0)
        self.assertEqual(window.durations()[-1], 170_887.5)
        # And once the player publishes again, the lyrics land where the audio is.
        self.assertAlmostEqual(after[-1]["value"], after[-1]["truth"], delta=700.0)

    def test_a_track_change_lands_on_the_new_song(self):
        session = BrowserSession(publish_interval_s=10.0)
        session.change_track("Song A", position_ms=200_000.0)
        switched = {}

        def switch():
            switched["at"] = time.monotonic()
            session.change_track("Song B")

        _bridge, window, pushes = self._drive(session, [(1.0, switch), (1.0, None)])
        later = [push for push in pushes if push["at"] >= switched["at"]]
        self.assertTrue(later, "no playhead was pushed after the track change")
        for push in later:
            self.assertLess(push["value"], 5000.0,
                            "the new song inherited the old song's playhead")
            self.assertAlmostEqual(push["value"], push["truth"], delta=300.0)
        # The UI is told to land on it rather than glide there.
        self.assertEqual(later[0]["mode"], "snap")
        titles = [s for s in window.scripts if s.startswith("window.loadLyrics(")]
        self.assertEqual(len(titles), 2)

    def test_a_duration_that_arrives_late_does_not_restart_the_lyrics(self):
        # A browser publishes the title first and the length seconds later. That
        # is not a new song, and reloading on it visibly restarts the lyrics of
        # the song that is already on screen.
        session = BrowserSession(publish_interval_s=1.0)
        session.duration_ms = 0.0
        _bridge, window, _pushes = self._drive(session, [
            (1.2, lambda: setattr(session, "duration_ms", 245_000.0)),
            (1.5, None),
        ])
        loads = [s for s in window.scripts if s.startswith("window.loadLyrics(")]
        self.assertEqual(len(loads), 1)
        # ...and the length it announced late still reaches the overlay. Reported:
        # "even for apps which do publish the timeline, the app doesn't give the
        # song length" — the duration used to be pushed only at load time, so a
        # player that published it a moment later left the bar reading --:-- for
        # the rest of the song.
        self.assertEqual(window.durations()[-1], 245_000.0)

    def test_a_length_the_ui_never_got_is_announced_again(self):
        # Reported (again): "the end time does not show even for apps which do
        # provide the timeline and song details". What is remembered as pushed has
        # to be what the UI was TOLD, or a delivery that failed is never retried.
        session = BrowserSession(publish_interval_s=1.0, duration_ms=200_000.0)
        dropped = []

        def on_script(script, _window):
            if (script.startswith("window.setTrackDuration(")
                    and not dropped):
                dropped.append(True)
                raise RuntimeError("page not ready")

        _bridge, window, _pushes = self._drive(session, [(1.6, None)],
                                               on_script=on_script)
        self.assertTrue(dropped, "the test never made a push fail")
        self.assertEqual(window.durations()[-1], 200_000.0)
        # Announced again rather than once: the failed delivery is retried.
        self.assertGreaterEqual(window.durations().count(200_000.0), 2)

    def test_the_length_is_announced_while_the_lyric_lookup_keeps_failing(self):
        # The length is not the lyrics' business: a resolver that keeps throwing
        # must not take the end time down with it.
        session = BrowserSession(publish_interval_s=1.0, duration_ms=180_000.0)

        def exploding_fetch(*_args, **_kwargs):
            raise RuntimeError("resolver down")

        _bridge, window, _pushes = self._drive(session, [(1.6, None)],
                                               fetch=exploding_fetch)
        self.assertEqual(window.durations()[-1], 180_000.0)
        self.assertFalse([s for s in window.scripts
                          if s.startswith("window.loadLyrics(")],
                         "the lyrics were loaded even though the lookup failed")

    def test_a_new_track_re_announces_a_length_the_ui_already_had(self):
        # A feed of equal-length items (every Short is a minute) never CHANGES the
        # value, so a change-only push announced the first one and stayed silent
        # for the rest of the session — and a webview that had reloaded in between
        # was never told again at all.
        session = BrowserSession(publish_interval_s=1.0, duration_ms=60_000.0)
        _bridge, window, _pushes = self._drive(session, [
            (1.2, lambda: session.change_track("Song B")),
            (1.2, None),
        ])
        self.assertEqual(window.durations().count(60_000.0), 2)

    def test_a_different_recording_of_the_same_song_reloads_after_settling(self):
        # Same title and artist, a duration that was known and now differs: a
        # live take or another edit. Reload once, and only after the value has
        # held still for the settle window.
        session = BrowserSession(publish_interval_s=1.0, duration_ms=200_000.0)
        _bridge, window, _pushes = self._drive(session, [
            (0.8, lambda: setattr(session, "duration_ms", 260_000.0)),
            (1.6, None),
        ])
        loads = [s for s in window.scripts if s.startswith("window.loadLyrics(")]
        self.assertEqual(len(loads), 2)


@unittest.skipUnless(HAS_WINSDK, "winsdk is required for the SMTC bridge")
class SessionPickingTest(unittest.TestCase):
    """Which session the loop follows when two tabs share one browser app id.

    Reported: "songs keep switching from yt music to another tab which is not
    even playing". WinRT hands back a new wrapper object on every read, so a
    session's identity can only come from what it reports — which is what these
    pin.
    """

    def _pick(self, bridge, sessions):
        return asyncio.run(bridge._pick_session(FakeManager(sessions)))

    def test_the_playing_tab_of_one_browser_wins(self):
        bridge = make_bridge(None)
        paused = FakeSession(app_id="msedge.exe", playing=False, title="Song A")
        playing = FakeSession(app_id="msedge.exe", playing=True, title="Other Video")
        chosen = self._pick(bridge, [paused, playing])
        self.assertIs(chosen["session"], playing)

    def test_a_later_idle_tab_never_steals_a_playing_one(self):
        bridge = make_bridge(None)
        bridge.HANDOVER_QUIET_S = 0.01
        playing = FakeSession(app_id="msedge.exe", playing=True, title="Song A")
        self._pick(bridge, [playing])
        idle = FakeSession(app_id="msedge.exe", playing=False, title="Other Video")
        for _ in range(3):
            chosen = self._pick(bridge, [idle, playing])
            self.assertIs(chosen["session"], playing)

    def test_an_idle_pin_hands_over_once_another_tab_plays(self):
        bridge = make_bridge(None)
        bridge.HANDOVER_QUIET_S = 0.01
        first = FakeSession(app_id="msedge.exe", playing=True, title="Song A")
        self._pick(bridge, [first])
        other = FakeSession(app_id="msedge.exe", playing=True, title="Other Video")
        first.playing = False
        # The challenger has to earn the handover, so the pin holds the overlay.
        self.assertIs(self._pick(bridge, [first, other])["session"], first)
        time.sleep(0.02)
        self.assertIs(self._pick(bridge, [first, other])["session"], other)

    def test_a_session_change_restarts_the_playhead_clock(self):
        # A different session's timeline says nothing about the one on screen,
        # and the UI has to land on the new position instead of gliding from the
        # old song's playhead.
        bridge = make_bridge(None)
        bridge.HANDOVER_QUIET_S = 0.01
        first = FakeSession(app_id="msedge.exe", playing=True, title="Song A")
        self._pick(bridge, [first])
        bridge.clock.observe(200_000.0, 0.0, playing=True)
        bridge._force_snap = False
        second = FakeSession(app_id="msedge.exe", playing=True, title="Other Video")
        self._pick(bridge, [second])
        self.assertIsNone(bridge.clock.anchor_ms)
        self.assertTrue(bridge._force_snap)

    def test_the_same_session_across_ticks_does_not_restart_the_clock(self):
        # The wrapper object is new every read, so the identity has to come from
        # the key: re-picking the same tab must NOT be treated as a change.
        bridge = make_bridge(None)
        session = FakeSession(app_id="msedge.exe", playing=True, title="Song A")
        self._pick(bridge, [session])
        bridge.clock.observe(200_000.0, 0.0, playing=True)
        self._pick(bridge, [session])
        self.assertEqual(bridge.clock.anchor_ms, 200_000.0)

    def test_manual_lock_source_keeps_chosen_session(self):
        bridge = make_bridge(None)
        bridge.HANDOVER_QUIET_S = 0.01
        spotify = FakeSession(app_id="Spotify.exe", playing=True, title="Song A")
        chrome = FakeSession(app_id="chrome.exe", playing=True, title="Lofi Beats")
        # Normal arbitration picks first playing
        self.assertIs(self._pick(bridge, [spotify, chrome])["session"], spotify)
        # Lock to Chrome: even while Spotify is also playing, Chrome is chosen and kept
        bridge.lock_source("chrome.exe")
        self.assertIs(self._pick(bridge, [spotify, chrome])["session"], chrome)
        # Lock stays even if Chrome is paused while Spotify is playing!
        chrome.playing = False
        self.assertIs(self._pick(bridge, [spotify, chrome])["session"], chrome)
        # Unlocking restores normal arbitration
        bridge.unlock_source()
        self.assertIs(self._pick(bridge, [spotify, chrome])["session"], spotify)


if __name__ == "__main__":
    unittest.main()
