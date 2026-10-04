"""Regression tests for the pure GSMTC timeline handling in core.timeline.

These cover the unit/origin rules and the playhead clock's anchoring behaviour,
including the cases that used to be wrong in core.smtc: reading `end_time` as
the duration, extrapolating a paused player with a wall clock, and re-anchoring
to a snapshot the player had not refreshed.
"""
import datetime
import unittest

from core.timeline import (
    MAX_EXTRAPOLATION_MS,
    PositionClock,
    clamp_rate,
    never_updated,
    normalize_timeline,
    to_ms,
)


def delta(ms):
    return datetime.timedelta(milliseconds=ms)


class ToMsTest(unittest.TestCase):
    def test_none_and_unusable_values(self):
        self.assertIsNone(to_ms(None))
        self.assertIsNone(to_ms(1234))          # no total_seconds
        self.assertIsNone(to_ms("5 seconds"))
        self.assertIsNone(to_ms(float("nan")))
        self.assertIsNone(to_ms(float("inf")))

    def test_timedelta_to_milliseconds(self):
        self.assertEqual(to_ms(delta(1500)), 1500.0)
        self.assertEqual(to_ms(datetime.timedelta(0)), 0.0)


class ClampRateTest(unittest.TestCase):
    def test_unusable_rates_fall_back_to_one(self):
        # SimpMusic reports playback_rate None; extrapolating at anything other
        # than 1.0x would invent a speed the player never claimed.
        for value in (None, "", "fast", float("nan"), 0, 0.0, -1, 99):
            self.assertEqual(clamp_rate(value), 1.0, value)

    def test_sensible_rates_survive(self):
        self.assertEqual(clamp_rate(1.5), 1.5)
        self.assertEqual(clamp_rate(2), 2.0)


class NeverUpdatedTest(unittest.TestCase):
    def test_winrt_sentinel_is_detected(self):
        sentinel = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
        self.assertTrue(never_updated(sentinel))
        self.assertTrue(never_updated(None))
        self.assertFalse(never_updated(datetime.datetime.now()))


class NormalizeTimelineTest(unittest.TestCase):
    def test_duration_is_end_minus_start(self):
        sample = normalize_timeline(start=delta(1000), end=delta(181000),
                                    position=delta(31000))
        self.assertEqual(sample.duration_ms, 180000.0)
        self.assertEqual(sample.position_ms, 30000.0)

    def test_zero_origin_matches_raw_values(self):
        sample = normalize_timeline(start=delta(0), end=delta(240000),
                                    position=delta(50000))
        self.assertEqual(sample.duration_ms, 240000.0)
        self.assertEqual(sample.position_ms, 50000.0)
        self.assertTrue(sample.published)

    def test_position_before_origin_is_clamped_not_negative(self):
        sample = normalize_timeline(start=delta(5000), position=delta(1000))
        self.assertEqual(sample.position_ms, 0.0)

    def test_dead_timeline_is_unpublished(self):
        # Exactly what SimpMusic published on Windows: every field zero and
        # last_updated_time left at the WinRT sentinel (measured with
        # tools/smtc_diagnose.py).
        sample = normalize_timeline(
            start=delta(0), end=delta(0), position=delta(0),
            min_seek=delta(0), max_seek=delta(0),
            updated=datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc),
        )
        self.assertFalse(sample.published)
        self.assertIsNone(sample.duration_ms)
        self.assertIsNotNone(sample.position_ms)   # 0.0 is a real reading
        self.assertEqual(sample.position_ms, 0.0)
        self.assertFalse(sample.seekable)

    def test_zero_duration_is_reported_as_missing(self):
        # A player that publishes a position but no usable length must not have a
        # duration invented for it...
        sample = normalize_timeline(start=delta(0), end=delta(0), position=delta(9000))
        self.assertIsNone(sample.duration_ms)
        # ...but its position is still real, so the timeline counts as published.
        self.assertTrue(sample.published)

    def test_missing_end_is_missing_not_zero(self):
        sample = normalize_timeline(start=delta(0), position=delta(4000))
        self.assertIsNone(sample.end_ms)
        self.assertIsNone(sample.duration_ms)

    def test_seekable_requires_a_positive_seek_range(self):
        self.assertTrue(normalize_timeline(max_seek=delta(180000)).seekable)
        self.assertFalse(normalize_timeline(max_seek=delta(0)).seekable)

    def test_published_without_sentinel_when_position_advances(self):
        sample = normalize_timeline(start=delta(0), end=delta(1000),
                                    position=delta(0),
                                    updated=datetime.datetime.now())
        self.assertTrue(sample.published)


class PositionClockTest(unittest.TestCase):
    def test_first_sample_anchors_and_projects(self):
        clock = PositionClock()
        self.assertEqual(clock.observe(1000.0, 10.0, playing=True), 1000.0)
        self.assertEqual(clock.observe(1000.0, 11.0, playing=True), 2000.0)

    def test_paused_player_never_creeps_forward(self):
        # The old code added wall-clock time since the player's last snapshot
        # even while paused, so a paused track's playhead drifted forward.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=False)
        self.assertEqual(clock.observe(5000.0, 14.0, playing=False), 5000.0)
        self.assertEqual(clock.observe(5000.0, 90.0, playing=False), 5000.0)

    def test_resume_reanchors_from_the_paused_position(self):
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=False)
        clock.observe(5000.0, 90.0, playing=False)
        # Resuming: the frozen sample is the truth again, not 80s of projection.
        self.assertEqual(clock.observe(5000.0, 90.0, playing=True), 5000.0)
        self.assertEqual(clock.observe(5000.0, 91.0, playing=True), 6000.0)

    def test_stale_sample_does_not_snap_the_playhead_back(self):
        # A player that refreshes every few seconds must not pull the playhead
        # back to its last snapshot on every read.
        clock = PositionClock()
        clock.observe(10000.0, 0.0, playing=True)
        self.assertEqual(clock.observe(10000.0, 3.0, playing=True), 13000.0)
        self.assertEqual(clock.observe(10000.0, 3.5, playing=True), 13500.0)

    def test_fresh_sample_reanchors(self):
        clock = PositionClock()
        clock.observe(10000.0, 0.0, playing=True)
        clock.observe(10000.0, 3.0, playing=True)
        # A genuinely new reading wins outright, even if it is behind ours.
        self.assertEqual(clock.observe(11200.0, 3.2, playing=True), 11200.0)
        self.assertEqual(clock.observe(11200.0, 4.2, playing=True), 12200.0)

    def test_projection_is_bounded_when_the_player_goes_quiet(self):
        clock = PositionClock()
        clock.observe(10000.0, 0.0, playing=True)
        self.assertEqual(clock.observe(10000.0, 600.0, playing=True),
                         10000.0 + MAX_EXTRAPOLATION_MS)

    def test_projection_stops_at_a_known_duration(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True, duration_ms=2000.0)
        self.assertEqual(clock.observe(1000.0, 30.0, playing=True,
                                       duration_ms=2000.0), 2000.0)

    def test_projection_scales_with_the_reported_rate(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True, rate=2.0)
        self.assertEqual(clock.observe(1000.0, 1.0, playing=True, rate=2.0), 3000.0)

    def test_session_change_resets_the_anchor(self):
        # Session replacement (same app id, new object) has its own timeline.
        old, new = object(), object()
        clock = PositionClock()
        clock.observe(300000.0, 0.0, playing=True, session=old)
        self.assertEqual(
            clock.observe(1000.0, 1.0, playing=True, session=new), 1000.0)

    def test_unreadable_sample_keeps_the_running_clock(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True)
        self.assertEqual(clock.observe(None, 1.0, playing=True), 2000.0)
        # Nothing to project from yet: answer None rather than invent a position.
        self.assertIsNone(PositionClock().observe(None, 1.0, playing=True))

    def test_unreadable_while_paused_is_none(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=False)
        self.assertIsNone(clock.observe(None, 5.0, playing=False))

    def test_invalidate_makes_the_next_sample_authoritative(self):
        # After a seek we do not know where the player went; the next real
        # sample must win instead of being compared against the pre-seek value.
        clock = PositionClock()
        clock.observe(10000.0, 0.0, playing=True)
        clock.invalidate()
        self.assertEqual(clock.observe(60000.0, 0.2, playing=True), 60000.0)

    def test_reset_clears_everything(self):
        clock = PositionClock()
        clock.observe(10000.0, 0.0, playing=True, duration_ms=200000.0)
        clock.reset()
        self.assertIsNone(clock.anchor_ms)
        self.assertIsNone(clock.duration_ms)
        self.assertFalse(clock.playing)


if __name__ == "__main__":
    unittest.main()
