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
        return self.payloads("window.syncPlayhead(")

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
class SkipTest(unittest.TestCase):
    def test_skip_next_reports_success_and_resets_the_clock(self):
        session = FakeSession()
        bridge = make_bridge(session)
        bridge.clock.observe(200000.0, 0.0, playing=True, session=session)
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
        for value in syncs:
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

        before = [json.loads(s[len("window.syncPlayhead("):-2])
                  for s in bridge.window.scripts[:swapped["at"]]
                  if s.startswith("window.syncPlayhead(")]
        after = [json.loads(s[len("window.syncPlayhead("):-2])
                 for s in bridge.window.scripts[swapped["at"]:]
                 if s.startswith("window.syncPlayhead(")]
        self.assertTrue(before)
        self.assertGreater(before[0], 199000.0)     # the old session was followed
        self.assertTrue(after)                      # and then the new one
        # Nothing from the old session's 200s position survives the swap.
        for value in after:
            self.assertLess(value, 60000.0)
        self.assertGreaterEqual(before[-1], 200000.0)


if __name__ == "__main__":
    unittest.main()
