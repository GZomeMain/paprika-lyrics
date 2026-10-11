"""Regression tests for the pure GSMTC timeline handling in core.timeline.

Two halves: the unit/origin rules for one raw reading, and the playhead clock
that turns a stream of them into a position. Nearly every case in the second
half is a symptom reported from a real player, so the tests are named after the
symptom rather than the mechanism:

* lyrics jumping or resetting around a pause (the clock used to project paused
  time as if it had been played, and used to drag the playhead back to whatever
  stale snapshot the player had left behind);
* lyrics sitting behind the audio for a browser, whose timeline snapshot is
  written seconds before we read it (`last_updated_time` was ignored);
* lyrics freezing or stuttering while a player's snapshot went stale (there was
  no bound on how far the clock would run past the last thing the player said);
* the current line re-singing itself on a repeated reading (no deadband, so
  every repeated number was treated as new information);
* the wipe re-sweeping the same letters and the lyrics only syncing on a pause,
  because the clock's parked projection was reported as drift instead of being
  labelled ``held`` (see HeldReadingTest).
"""
import datetime
import unittest

from core.timeline import (
    DEADBAND_MS,
    DISCONTINUITY_MS,
    MAX_GRACE_MS,
    MAX_RESUME_CREDIT_MS,
    MAX_SAMPLE_AGE_MS,
    PositionClock,
    clamp_rate,
    never_updated,
    normalize_timeline,
    sample_age_ms,
    to_ms,
    utcnow,
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


class SampleAgeTest(unittest.TestCase):
    """How old the player's position snapshot is (see sample_age_ms)."""

    def test_a_recent_write_time_is_the_age(self):
        now = datetime.datetime(2026, 1, 1, 12, 0, 10, tzinfo=datetime.timezone.utc)
        written = datetime.datetime(2026, 1, 1, 12, 0, 7, 500000,
                                    tzinfo=datetime.timezone.utc)
        self.assertEqual(sample_age_ms(written, now), 2500.0)

    def test_the_sentinel_means_no_age_not_an_ancient_one(self):
        sentinel = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
        self.assertIsNone(sample_age_ms(sentinel, utcnow()))

    def test_a_clock_ahead_of_ours_is_not_evidence(self):
        # A player whose wall clock runs ahead cannot tell us how old a snapshot
        # is; the caller falls back to the read instant instead of inventing a
        # position from the difference.
        now = datetime.datetime(2026, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        ahead = now + datetime.timedelta(seconds=30)
        self.assertIsNone(sample_age_ms(ahead, now))

    def test_naive_or_absent_timestamps_are_ignored(self):
        self.assertIsNone(sample_age_ms(None, utcnow()))
        self.assertIsNone(sample_age_ms(datetime.datetime.now(), utcnow()))

    def test_an_absurd_age_is_not_believed(self):
        now = datetime.datetime(2026, 1, 1, 12, 0, 0, tzinfo=datetime.timezone.utc)
        ancient = now - datetime.timedelta(hours=3)
        self.assertIsNone(sample_age_ms(ancient, now))


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

    def test_a_zeroed_timeline_with_a_live_stamp_is_not_a_position(self):
        # Measured on a real browser player: a seek left start, end, position and
        # both seek bounds at zero while last_updated_time kept ticking, and it
        # stayed that way while the player was paused. Reading it as "the song is
        # at 0:00" is what reset the lyrics to the top of the track and dropped
        # the length; it is a player with no position state, not a song at zero.
        sample = normalize_timeline(start=delta(0), end=delta(0), position=delta(0),
                                    updated=utcnow(), min_seek=delta(0),
                                    max_seek=delta(0))
        self.assertFalse(sample.published)
        self.assertEqual(sample.position_ms, 0.0)
        self.assertIsNone(sample.duration_ms)

    def test_a_zero_position_with_a_published_length_is_a_position(self):
        # The other side of it: a song really at 0:00 publishes its length (a user
        # who seeked back to the start wants the lyrics back at the top).
        sample = normalize_timeline(start=delta(0), end=delta(200000),
                                    position=delta(0), updated=utcnow())
        self.assertTrue(sample.published)

    def test_write_time_is_carried_through_for_ageing(self):
        written = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
        sample = normalize_timeline(start=delta(0), end=delta(1000),
                                    position=delta(0), updated=written)
        self.assertIs(sample.updated_at, written)

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
    """The clock's contract: position to show *now*, and whether it jumped."""

    # ---------------------------------------------------------------- basics
    def test_first_sample_anchors_and_projects(self):
        clock = PositionClock()
        first = clock.observe(1000.0, 10.0, playing=True)
        self.assertEqual(first.position_ms, 1000.0)
        self.assertTrue(first.discontinuity)      # nothing on screen yet
        second = clock.observe(1000.0, 11.0, playing=True)
        self.assertEqual(second.position_ms, 2000.0)
        self.assertFalse(second.discontinuity)

    def test_projection_is_bounded_when_the_player_goes_quiet(self):
        # A stalled player must not drag the lyrics ahead: past the leash the
        # clock holds the last position it can justify. Before this it ran ahead
        # without limit and snapped back when the player answered, which read as
        # the line freezing and then repeating.
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        clock.observe(11_000.0, 1.0, playing=True)      # teaches a 1s cadence
        held = clock.observe(11_000.0, 600.0, playing=True)
        # 2 * 1s cadence + 500ms, past the last thing the player actually said.
        self.assertEqual(held.position_ms, 11_000.0 + 2_500.0)
        self.assertLess(held.position_ms, MAX_GRACE_MS + 11_000.0)

    def test_projection_stops_at_a_known_duration(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True, duration_ms=2000.0)
        self.assertEqual(clock.observe(1000.0, 30.0, playing=True,
                                       duration_ms=2000.0).position_ms, 2000.0)

    def test_projection_scales_with_the_reported_rate(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True, rate=2.0)
        self.assertEqual(clock.observe(1000.0, 1.0, playing=True,
                                       rate=2.0).position_ms, 3000.0)

    def test_paused_player_never_creeps_forward(self):
        # The old code added wall-clock time since the player's last snapshot
        # even while paused, so a paused track's playhead drifted forward.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=False)
        self.assertEqual(clock.observe(5000.0, 14.0, playing=False).position_ms, 5000.0)
        self.assertEqual(clock.observe(5000.0, 90.0, playing=False).position_ms, 5000.0)

    def test_unreadable_sample_keeps_the_running_clock(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True)
        self.assertEqual(clock.observe(None, 1.0, playing=True).position_ms, 2000.0)
        # Nothing to project from yet: answer None rather than invent a position.
        self.assertIsNone(PositionClock().observe(None, 1.0, playing=True).position_ms)

    def test_unreadable_while_paused_is_none(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=False)
        self.assertIsNone(clock.observe(None, 5.0, playing=False).position_ms)

    def test_reset_drops_the_previous_track_s_state(self):
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True, duration_ms=200000.0)
        clock.observe(11_000.0, 1.0, playing=True)         # teaches a 1s cadence
        self.assertIsNotNone(clock.cadence_ms)
        clock.reset()
        self.assertIsNone(clock.anchor_ms)
        self.assertIsNone(clock.duration_ms)
        self.assertIsNone(clock.cadence_ms)
        self.assertFalse(clock.playing)
        # The next reading is a fresh start, not a comparison against the
        # previous track's position.
        self.assertTrue(clock.observe(500.0, 0.5, playing=True).discontinuity)

    # ------------------------------------------------------------ the pause
    def test_a_pause_that_publishes_nothing_new_does_not_drag_the_lyrics_back(self):
        # Reported: "songs often change positions and reset when and after
        # pausing". A player that leaves its last playing snapshot in place must
        # not pull the frozen lyrics back to a number it has not refreshed.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=True)
        clock.observe(5000.0, 10.5, playing=True)          # 5500 on screen
        # The pause is detected at 11.0, so the estimate has run one second: the
        # freeze is at most one poll interval past where playback stopped, and
        # crucially it is NOT dragged back to the 5000-second snapshot.
        paused = clock.observe(5000.0, 11.0, playing=False)
        self.assertEqual(paused.position_ms, 6000.0)
        self.assertEqual(clock.observe(5000.0, 40.0, playing=False).position_ms, 6000.0)

    def test_a_pause_that_publishes_the_stop_position_is_believed(self):
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=True)
        paused = clock.observe(6100.0, 11.0, playing=False)
        self.assertEqual(paused.position_ms, 6100.0)

    def test_a_paused_move_is_a_discontinuity_the_ui_lands_on(self):
        # Reported: "when moving around the timeline in the audio player the
        # lyrics don't automatically change with it, and only update once
        # paused and unpaused". A fresh position published while paused used
        # to arrive as plain (no discontinuity), and the UI only repaints its
        # words on a snap — so the timer moved and the highlight waited for
        # the next pause/resume edge.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=True)
        clock.observe(5000.0, 11.0, playing=False)          # frozen at 6000
        moved = clock.observe(120_000.0, 12.0, playing=False)
        self.assertEqual(moved.position_ms, 120_000.0)
        self.assertTrue(moved.discontinuity)

    def test_paused_jitter_is_not_a_discontinuity(self):
        # The guard above must not repaint the words twice a second: noise
        # inside the deadband while paused stays a plain parked reading.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=True)
        clock.observe(5000.0, 11.0, playing=False)          # frozen at 6000
        parked = clock.observe(5000.0, 12.0, playing=False)
        self.assertEqual(parked.position_ms, 6000.0)
        self.assertFalse(parked.discontinuity)

    def test_resume_carries_the_paused_position_without_counting_the_pause(self):
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=True)
        clock.observe(5000.0, 10.5, playing=True)
        clock.observe(5000.0, 11.0, playing=False)         # 6000, frozen
        clock.observe(5000.0, 90.0, playing=False)         # still 6000
        resumed = clock.observe(5000.0, 90.0, playing=True)
        self.assertEqual(resumed.position_ms, 6000.0)      # not 6000 + 80s
        self.assertEqual(clock.observe(5000.0, 91.0, playing=True).position_ms, 7000.0)

    def test_a_pause_with_no_readable_timeline_does_not_leak_into_the_resume(self):
        # A player that stops publishing a timeline while paused never gets an
        # observe() call, so the bridge reports the edge with note_playing. The
        # 30-second pause itself is never counted as elapsed audio; the only part
        # of it credited is the bounded interval in which the resume can actually
        # have happened (see MAX_RESUME_CREDIT_MS).
        clock = PositionClock()
        clock.observe(5000.0, 0.0, playing=True)
        clock.observe(5000.0, 0.5, playing=True)           # 5500 on screen
        clock.note_playing(False, 0.5)                     # paused, nothing to read
        clock.note_playing(True, 30.5)                     # resumed 30s later
        resumed = clock.observe(5000.0, 30.5, playing=True)
        self.assertEqual(resumed.position_ms, 5500.0 + MAX_RESUME_CREDIT_MS)

    def test_a_resume_credits_the_poll_it_was_noticed_late(self):
        # Reported: "pausing and unpausing causes slight delay". A resume is only
        # ever discovered on the poll after it happened, and the pause point was
        # correct as of the last PAUSED reading — so resuming from it as of now
        # leaves the wipe a whole poll behind the audio and eases that away over
        # the next second instead of starting right.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=True)
        clock.observe(5000.0, 10.2, playing=False)         # parked at 5200
        resumed = clock.observe(5000.0, 10.45, playing=True)
        # 5200 + the 250 ms the poll cost (the arithmetic is float, hence the
        # tolerance rather than an equality).
        self.assertAlmostEqual(resumed.position_ms, 5450.0, places=6)
        self.assertAlmostEqual(
            clock.observe(5000.0, 11.45, playing=True).position_ms, 6450.0, places=6)

    def test_a_resume_credits_the_snapshot_the_player_stamped_when_it_restarted(self):
        # A player that republishes its position state as it resumes writes the
        # pause position with a live stamp. Ageing that snapshot to the present
        # recovers the same interval, from the player's own numbers rather than
        # from ours.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=True)
        clock.observe(5000.0, 10.2, playing=False)         # parked at 5200
        resumed = clock.observe(5200.0, 10.45, playing=True, sample_age_ms=250.0)
        self.assertEqual(resumed.position_ms, 5450.0)

    def test_a_resume_never_credits_more_than_a_poll_of_uncertainty(self):
        # A pause reported without a readable timeline leaves no snapshot at all, so
        # the interval since the last reading is a guess — and a bounded one. A
        # player that went quiet for minutes must not hand the wipe the length of
        # the pause on the way out.
        clock = PositionClock()
        clock.observe(5000.0, 0.0, playing=True)
        clock.note_playing(False, 0.5)                     # 5500, paused
        clock.note_playing(True, 30.5)                     # nothing observed between
        resolved = clock.observe(5000.0, 30.5, playing=True)
        self.assertEqual(resolved.position_ms, 5500.0 + MAX_RESUME_CREDIT_MS)

    def test_a_pause_that_keeps_being_reported_moves_the_resume_leash(self):
        # The guard above only holds because a pause that is still being reported
        # keeps refreshing the leash: the resume then credits the poll it was
        # actually late for, not the length of the pause.
        clock = PositionClock()
        clock.observe(5000.0, 0.0, playing=True)
        clock.note_playing(False, 0.5)                     # 5500, paused
        clock.note_playing(False, 20.0)                    # still paused, 20s on
        clock.note_playing(True, 20.3)
        resolved = clock.observe(5000.0, 20.3, playing=True)
        self.assertAlmostEqual(resolved.position_ms, 5800.0, places=6)

    def test_note_playing_without_an_estimate_is_harmless(self):
        clock = PositionClock()
        clock.note_playing(False, 1.0)
        clock.note_playing(True, 2.0)
        self.assertIsNone(clock.observe(None, 3.0, playing=True).position_ms)

    # ------------------------------------------------------------ the sample
    def test_a_stale_snapshot_is_aged_to_the_present(self):
        # The browser case: it republishes its position every few seconds, so a
        # reading taken now can be seconds old. Believing it as "now" is what put
        # the lyrics a lot behind the audio from the first second of a song.
        clock = PositionClock()
        reading = clock.observe(30_000.0, 100.0, playing=True, sample_age_ms=3500.0)
        self.assertEqual(reading.position_ms, 33_500.0)

    def test_a_track_change_credits_the_new_snapshot_s_whole_age(self):
        # The reported "lyrics are a lot behind when a song starts": a browser
        # publishes its position every few seconds, so the snapshot the next
        # track opens on is often seconds old. Bounding that age by the gap since
        # our own previous read (which was about the PREVIOUS track, and half a
        # poll ago) threw those seconds away and left the lyrics behind for the
        # whole song.
        clock = PositionClock()
        clock.observe(200_000.0, 3.0, playing=True)        # the track before
        clock.reset()                                      # ... and a new one
        reading = clock.observe(3_000.0, 3.5, playing=True, sample_age_ms=3000.0)
        self.assertEqual(reading.position_ms, 6_000.0)
        self.assertTrue(reading.discontinuity)             # nothing on screen yet

    def test_an_absurd_write_time_is_never_credited_whole(self):
        # A stamp from hours ago (a suspended player, a skewed clock) says nothing
        # about where the track is now: the age credited is bounded, so one
        # nonsense number cannot fling the lyrics minutes into the song.
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True)
        reading = clock.observe(5000.0, 0.5, playing=True, sample_age_ms=3_600_000.0)
        self.assertLessEqual(reading.position_ms, 5000.0 + MAX_SAMPLE_AGE_MS)

    def test_age_is_not_applied_to_a_paused_reading(self):
        clock = PositionClock()
        clock.observe(4000.0, 0.0, playing=False)
        self.assertEqual(
            clock.observe(4000.0, 9.0, playing=False, sample_age_ms=9000.0).position_ms,
            4000.0)

    # ------------------------------------------------------- drift and jumps
    def test_a_repeated_snapshot_does_not_move_the_clock(self):
        # The "line re-sings itself" glitch: a player that repeats the same
        # number every poll used to have it applied as a correction on each one.
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        for tick in (1.0, 2.0, 3.0):
            reading = clock.observe(10_000.0, tick, playing=True)
            self.assertEqual(reading.correction_ms, 0.0)
            self.assertFalse(reading.discontinuity)
        self.assertEqual(reading.position_ms, 13_000.0)

    def test_a_small_residual_is_absorbed_without_being_called_a_jump(self):
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        reading = clock.observe(10_400.0, 0.0, playing=True)
        self.assertEqual(reading.position_ms, 10_400.0)
        self.assertFalse(reading.discontinuity)
        self.assertEqual(reading.correction_ms, 400.0)

    def test_a_residual_inside_the_deadband_is_left_alone(self):
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        reading = clock.observe(10_000.0 + DEADBAND_MS / 2, 0.0, playing=True)
        self.assertEqual(reading.correction_ms, 0.0)
        self.assertEqual(reading.position_ms, 10_000.0)

    def test_a_large_jump_is_a_discontinuity(self):
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        reading = clock.observe(10_000.0 + DISCONTINUITY_MS + 500.0, 0.2, playing=True)
        self.assertTrue(reading.discontinuity)
        self.assertEqual(reading.position_ms, 10_000.0 + DISCONTINUITY_MS + 500.0)

    def test_a_jump_reports_how_far_it_moved(self):
        # The size of a move is what lets the bridge tell a seek inside the song
        # (short enough to ease to) from a skip somewhere else in it (which must
        # land). ``correction_ms`` cannot serve: it is only comparable against the
        # estimate it was measured from.
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        reading = clock.observe(16_000.0, 0.1, playing=True)
        self.assertTrue(reading.discontinuity)
        self.assertEqual(reading.jump_ms, 5900.0)

    def test_drift_and_the_first_reading_carry_no_jump_size(self):
        # Nothing to travel along: the first reading of a track has no previous
        # position to have moved from, and ordinary drift is not a move at all.
        clock = PositionClock()
        first = clock.observe(10_000.0, 0.0, playing=True)
        self.assertTrue(first.discontinuity)      # nothing on screen yet
        self.assertIsNone(first.jump_ms)
        drifted = clock.observe(10_500.0, 0.1, playing=True)
        self.assertFalse(drifted.discontinuity)
        self.assertIsNone(drifted.jump_ms)

    def test_a_move_while_paused_reports_its_size_too(self):
        clock = PositionClock()
        clock.observe(5000.0, 0.0, playing=True)
        clock.observe(5000.0, 1.0, playing=False)          # parked at 6000
        moved = clock.observe(30_000.0, 1.1, playing=False)
        self.assertTrue(moved.discontinuity)
        self.assertEqual(moved.jump_ms, 24_000.0)

    def test_a_dated_snapshot_licenses_the_projection_without_a_cadence(self):
        # Reported: "lyrics get stuck". A browser publishes its position a few
        # seconds apart, so the projection between those publications is the only
        # thing keeping the lyrics moving; leashing the clock on a refresh
        # cadence the player has not had the chance to show froze them mid-song.
        # The write time is what makes running the playhead on from it honest.
        clock = PositionClock()
        clock.observe(1_000.0, 0.0, playing=True, sample_age_ms=0.0)
        reading = clock.observe(1_000.0, 60.0, playing=True, sample_age_ms=59_000.0)
        self.assertEqual(reading.position_ms, 61_000.0)

    def test_a_snapshot_that_cannot_be_dated_bounds_the_projection(self):
        # The other side of it, measured on this machine: a player that reports
        # PLAYING while its timeline has not been written for a minute (position
        # frozen at 4ms, stamp two minutes old) is not evidence that audio is
        # advancing at all. Running the lyrics on from that number indefinitely
        # is worse than holding them just past it.
        clock = PositionClock()
        clock.observe(1_000.0, 0.0, playing=True)          # no usable write time
        reading = clock.observe(1_000.0, 60.0, playing=True)
        self.assertEqual(reading.position_ms, 1_000.0 + MAX_GRACE_MS)

    def test_the_leash_widens_for_a_player_that_refreshes_slowly(self):
        # A player republishing every 4 seconds must be allowed to project for
        # 4 seconds; a leash tuned for a chatty player would freeze its lyrics
        # between refreshes.
        clock = PositionClock()
        clock.observe(0.0, 0.0, playing=True)
        clock.observe(4000.0, 4.0, playing=True)      # cadence sample
        clock.observe(8000.0, 8.0, playing=True)
        held = clock.observe(8000.0, 8.0 + 5.5, playing=True)
        self.assertGreater(held.position_ms - 8000.0, 5000.0)

    # ------------------------------------------------------------- the seek
    def test_a_seek_we_sent_ignores_the_player_echo(self):
        # The player reports the pre-seek position until it acts; obeying that
        # echo yanked the lyrics back to where the user seeked FROM.
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        clock.note_seek(120_000.0, 0.1)
        echo = clock.observe(10_200.0, 0.4, playing=True)
        self.assertEqual(echo.position_ms, 120_300.0)   # the target, advanced
        landed = clock.observe(120_500.0, 1.0, playing=True)
        self.assertFalse(landed.discontinuity)
        self.assertEqual(landed.position_ms, 120_500.0)

    def test_a_seek_the_player_refused_believes_the_player_again(self):
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        clock.note_seek(120_000.0, 0.1)
        clock.cancel_seek()
        back = clock.observe(11_000.0, 1.0, playing=True)
        self.assertTrue(back.discontinuity)
        self.assertEqual(back.position_ms, 11_000.0)

    def test_a_seek_that_never_lands_falls_back_to_the_player(self):
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        clock.note_seek(120_000.0, 0.0)
        # Still the pre-seek position, well past the wait: believe it.
        reading = clock.observe(10_500.0, 5.0, playing=True)
        self.assertTrue(reading.discontinuity)
        self.assertEqual(reading.position_ms, 10_500.0)

    # --------------------------------------------------- coarse sources (VLC)
    def test_a_coarse_position_is_a_bucket_rather_than_a_point(self):
        # VLC reports whole seconds. Each new second must NOT be taken as a
        # correction just because it differs from the estimate inside it — that
        # is what made a VLC-sourced playhead stutter once per poll.
        clock = PositionClock()
        clock.observe(42_000.0, 0.0, playing=True, quantized_ms=1000.0)
        for second in (1.0, 2.0, 3.0):
            reading = clock.observe(42_000.0 + second * 1000.0, second, playing=True,
                                    quantized_ms=1000.0)
            self.assertEqual(reading.correction_ms, 0.0, f"t={second}")
            self.assertFalse(reading.discontinuity)
            self.assertAlmostEqual(reading.position_ms, 42_000.0 + second * 1000.0)

    def test_a_coarse_source_outside_its_bucket_is_pulled_to_the_edge(self):
        clock = PositionClock()
        clock.observe(42_000.0, 0.0, playing=True, quantized_ms=1000.0)
        # Our estimate has run 4s while the source still only claims 44s: land on
        # the nearest point that source actually reported, not on the raw value.
        reading = clock.observe(44_000.0, 4.0, playing=True, quantized_ms=1000.0)
        self.assertEqual(reading.position_ms, 44_500.0)
        self.assertEqual(reading.correction_ms, -1500.0)


class HeldReadingTest(unittest.TestCase):
    """Which readings are corrections, and which are only projections.

    ``held`` is how the bridge tells the UI "this is my best estimate, not the
    player telling you where the audio is". A held reading must never be obeyed
    as drift: doing so dragged the wipe back to a parked number on every poll,
    which stalled real-time sync on players that publish rarely or blank their
    timeline (a browser after a site-side seek, SimpMusic) and re-swept the
    syllables it had already passed.
    """

    def test_a_repeated_snapshot_is_held(self):
        # The player republished a value we have already seen: there is nothing
        # new to compare against, so the clock's own projection is not a
        # correction and must be labelled as such.
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True)
        self.assertTrue(clock.observe(1000.0, 1.0, playing=True).held)

    def test_an_unreadable_sample_while_playing_is_held(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True)
        reading = clock.observe(None, 1.0, playing=True)
        self.assertEqual(reading.position_ms, 2000.0)
        self.assertTrue(reading.held)

    def test_a_rendering_sample_is_not_held(self):
        clock = PositionClock()
        clock.observe(1000.0, 0.0, playing=True)
        self.assertFalse(clock.observe(1500.0, 0.5, playing=True).held)

    def test_the_first_reading_is_not_held(self):
        # The first reading of a track is a discontinuity the UI must land on,
        # and the player's own number is the truth for it.
        reading = PositionClock().observe(1000.0, 0.0, playing=True)
        self.assertTrue(reading.discontinuity)
        self.assertFalse(reading.held)

    def test_a_jump_is_not_held(self):
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        reading = clock.observe(60_000.0, 0.2, playing=True)
        self.assertTrue(reading.discontinuity)
        self.assertFalse(reading.held)

    def test_a_paused_projection_is_not_held(self):
        # A paused anchor IS the truth — the position does not advance — so it is
        # a report the UI may land on, not a held guess.
        clock = PositionClock()
        clock.observe(5000.0, 10.0, playing=False)
        self.assertFalse(clock.observe(5000.0, 11.0, playing=False).held)

    def test_a_seek_echo_is_held(self):
        # The player's pre-seek echo is a projection of where we already sent the
        # playhead; obeying it would walk the wipe back off the seek it drew.
        clock = PositionClock()
        clock.observe(10_000.0, 0.0, playing=True)
        clock.note_seek(120_000.0, 0.1)
        self.assertTrue(clock.observe(10_200.0, 0.2, playing=True).held)


if __name__ == "__main__":
    unittest.main()
