import unittest

from core.beat import (
    EXIT_OCCUPANCY,
    GAP_BRIDGE_MAX_SLOTS,
    MACRO_FLOOR,
    MIN_ONSETS,
    PEAK_MIN_SEPARATION,
    _bridge_gaps,
    _collect_onsets,
    _estimate_bpm,
    _find_builds,
    _find_peaks,
    _macro_curve,
    beat_phase_at,
    beat_plan_at,
    build_beat_plan,
)

STEADY_MS = 500.0   # one syllable per beat -> 120 BPM


def _line(syllables, **extra):
    line = {
        "startTimeMs": syllables[0]["startTimeMs"],
        "endTimeMs": syllables[-1]["endTimeMs"],
        "text": "la " * len(syllables),
        "words": [
            {"text": "la", "startTimeMs": s["startTimeMs"], "endTimeMs": s["endTimeMs"],
             "syllables": [s]}
            for s in syllables
        ],
        "isBackground": False,
    }
    line.update(extra)
    return line


def _track(onsets, dur_ms=120.0, per_line=4, **extra):
    """A payload whose syllables begin at each of `onsets` (ms)."""
    lines = []
    chunk = []
    for t in onsets:
        chunk.append({"text": "la", "startTimeMs": float(t), "endTimeMs": float(t) + dur_ms})
        if len(chunk) == per_line:
            lines.append(_line(chunk, **extra))
            chunk = []
    if chunk:
        lines.append(_line(chunk, **extra))
    return lines


def _steady(start_ms, end_ms, step=STEADY_MS, dur_ms=120.0, **extra):
    return [
        t for t in range(int(start_ms), int(end_ms), int(step))
    ] and _track(range(int(start_ms), int(end_ms), int(step)), dur_ms, **extra)


def _covered(plan, start_ms, end_ms):
    """Total pulsing time inside a window."""
    total = 0.0
    for run_start, run_end, _ in plan["runs"]:
        total += max(0.0, min(run_end, end_ms) - max(run_start, start_ms))
    return total


def _levels_track(levels, step=STEADY_MS):
    """
    One syllable per beat, plus an off-beat syllable wherever `levels` says 2.

    The onset grid therefore stays a steady 120 BPM while the *density* varies by
    section, which is what a verse-to-chorus jump looks like in an onset stream:
    the delivery gets busier, the beat does not move.
    """
    onsets = []
    for i, level in enumerate(levels):
        base = i * step
        onsets.append(base)
        if level >= 2:
            onsets.append(base + step / 2)
    return _track(onsets, dur_ms=140.0)


def _ramp(count, low=1, high=2):
    return [low + (high - low) * i / (count - 1) for i in range(count)]


def _strength_at_ms(plan, ms):
    return beat_plan_at(plan, ms)[1]


class OnsetExtractionTest(unittest.TestCase):
    def test_short_syllables_weigh_more_than_held_ones(self):
        same = [0, 500, 1000, 1500]
        struck = _collect_onsets(_track(same, dur_ms=120))
        held = _collect_onsets(_track(same, dur_ms=1600))
        self.assertGreater(struck[1].w, held[1].w)

    def test_a_phrase_opening_after_silence_is_accented(self):
        # 6.5s of silence before the second phrase makes it a downbeat, not
        # another syllable in the run.
        onsets = _collect_onsets(_track([0, 500, 1000, 1500, 8000, 8500, 9000, 9500], dur_ms=120))
        self.assertGreater(onsets[4].w, onsets[1].w)

    def test_tolerates_malformed_payloads(self):
        self.assertEqual(_collect_onsets(None), [])
        self.assertEqual(_collect_onsets([{}, "junk", {"words": None}]), [])
        self.assertEqual(_collect_onsets([{"words": [{"syllables": [{"startTimeMs": "x"}]}]}]), [])
        self.assertTrue(_collect_onsets([{"words": [{"syllables": [{"startTimeMs": 5}]}]}]))


class TempoTest(unittest.TestCase):
    def test_reads_the_syllable_rate(self):
        self.assertEqual(_estimate_bpm(_collect_onsets(_track(range(0, 20000, 500)))), 120)

    def test_folds_double_time_into_the_musical_band(self):
        self.assertEqual(_estimate_bpm(_collect_onsets(_track(range(0, 20000, 250)))), 120)

    def test_has_no_opinion_without_onsets(self):
        self.assertEqual(_estimate_bpm([]), 0.0)


class GridTest(unittest.TestCase):
    def test_phase_lands_on_the_onset_grid(self):
        plan = build_beat_plan(_track(range(137, 30000, 500)))
        period = plan["periodMs"]
        offset = ((plan["phaseMs"] - 137) % period + period) % period
        self.assertLess(min(offset, period - offset), 60.0,
                        f"phase {plan['phaseMs']} does not sit on the 137ms grid")

    def test_period_matches_the_track_tempo(self):
        plan = build_beat_plan(_track(range(0, 30000, 500)))
        self.assertEqual(plan["bpm"], 120)
        self.assertAlmostEqual(plan["periodMs"], 500.0, places=1)


class TriggerTest(unittest.TestCase):
    """
    The bug this replaces: the pulse ran on every lyric line, including calm and
    undriven ones. These are the properties that make it mean something.
    """

    def test_steady_driven_delivery_pulses(self):
        plan = build_beat_plan(_track(range(2000, 40000, 500)))
        self.assertIsNotNone(plan)
        self.assertGreater(_covered(plan, 5000, 35000), 25_000)

    def test_held_notes_do_not_pulse(self):
        # One long syllable every two seconds: a sustain, not a groove.
        held = _track([t for t in range(0, 60000, 2000)], dur_ms=1600)
        self.assertIsNone(build_beat_plan(held))

    def test_calm_section_inside_a_driven_track_rests(self):
        onsets = list(range(0, 20000, 500)) + list(range(22000, 45000, 2000))
        plan = build_beat_plan(_track(onsets, dur_ms=120))
        self.assertIsNotNone(plan)
        self.assertGreater(_covered(plan, 3000, 18000), 10_000)
        # Well inside the held passage: nothing should be pulsing.
        self.assertEqual(_covered(plan, 32000, 44000), 0.0)

    def test_pulse_returns_after_a_calm_bridge(self):
        onsets = (list(range(0, 20000, 500))
                  + list(range(22000, 32000, 2000))
                  + list(range(34000, 60000, 500)))
        plan = build_beat_plan(_track(onsets, dur_ms=120))
        self.assertGreater(_covered(plan, 42000, 58000), 10_000)

    def test_short_instrumental_break_between_driven_sections_stays_live(self):
        # Two dense 120 BPM blocks with a ~6 s instrumental break between them —
        # a drop's quiet middle. The pulse eases through instead of dying.
        onsets = list(range(0, 20000, 500)) + list(range(26000, 46000, 500))
        plan = build_beat_plan(_track(onsets, dur_ms=120))
        self.assertIsNotNone(plan)
        # The gap window (20.0s–26.0s) is carried: over 3 s of pulse in it.
        self.assertGreater(_covered(plan, 20500, 25500), 3000)
        # Carried at reduced depth: the gap's strength is the quieter boundary
        # and never above either neighbour's.
        before = _strength_at_ms(plan, 19000)
        inside = _strength_at_ms(plan, 23000)
        after = _strength_at_ms(plan, 30000)
        self.assertGreaterEqual(inside, MACRO_FLOOR)
        self.assertLessEqual(inside, max(before, after) + 1e-9)

    def test_bridge_strength_is_the_quieter_boundary(self):
        # Quiet verse → loud chorus with a short break: the bridge rides at the
        # verse's depth, not the chorus's.
        onsets = (list(range(0, 20000, 1000))          # sparse-ish verse
                  + list(range(26000, 46000, 250)))    # double-time chorus
        plan = build_beat_plan(_track(onsets, dur_ms=120))
        self.assertIsNotNone(plan)
        inside = _strength_at_ms(plan, 23000)
        after = _strength_at_ms(plan, 30000)
        self.assertLessEqual(inside, after + 1e-9)

    def test_chorus_flag_alone_does_not_trigger(self):
        # Structure is deliberately ignored: a chorus with no rhythmic drive is
        # still calm, which is precisely what used to over-trigger.
        held_chorus = _track([t for t in range(0, 60000, 2000)], dur_ms=1600, isChorus=True)
        self.assertIsNone(build_beat_plan(held_chorus))

    def test_instrumental_gap_rests(self):
        plan = build_beat_plan(_track(range(0, 20000, 500)) + _track(range(60000, 80000, 500)))
        self.assertEqual(_covered(plan, 30000, 55000), 0.0)

    def test_too_little_evidence_gives_no_plan(self):
        self.assertIsNone(build_beat_plan([]))
        self.assertIsNone(build_beat_plan(None))
        self.assertIsNone(build_beat_plan(_track(range(0, MIN_ONSETS * 500 - 500, 500))))

    def test_line_only_payloads_never_pulse(self):
        # LRCLIB fallbacks ship words but no syllable timing at all.
        lines = [{"text": "hello", "startTimeMs": i * 2000, "endTimeMs": i * 2000 + 1800,
                  "words": []} for i in range(40)]
        self.assertIsNone(build_beat_plan(lines))


class PlanShapeTest(unittest.TestCase):
    def setUp(self):
        self.plan = build_beat_plan(_track(range(0, 60000, 500)))

    def test_runs_are_sorted_and_never_overlap(self):
        runs = self.plan["runs"]
        self.assertTrue(runs)
        for (_, previous_end, _), (next_start, _, _) in zip(runs, runs[1:]):
            self.assertLessEqual(previous_end, next_start)

    def test_runs_stay_inside_the_track(self):
        for start, end, _ in self.plan["runs"]:
            self.assertGreaterEqual(start, 0)
            self.assertLessEqual(end, 60000)
            self.assertLess(start, end)

    def test_strength_is_bounded_and_never_invisible(self):
        # The floor is MACRO_FLOOR, not STRENGTH_FLOOR: the macro gain multiplies
        # the local depth, so a calm section is allowed to sit below the old
        # local-only floor. It must still never be zero.
        for _, _, strength in self.plan["runs"]:
            self.assertGreaterEqual(strength, MACRO_FLOOR)
            self.assertLessEqual(strength, 1.0)

    def test_plan_is_json_sized(self):
        import json
        self.assertLess(len(json.dumps(self.plan)), 20_000)

    def test_lookup_matches_the_runs(self):
        start, end, strength = self.plan["runs"][0]
        self.assertEqual(beat_plan_at(self.plan, start + 1), (True, strength))
        self.assertEqual(beat_plan_at(self.plan, start - 1), (False, 0.0))
        self.assertEqual(beat_plan_at(None, start), (False, 0.0))

    def test_stats_report_bridged_slots(self):
        plan = build_beat_plan(
            _track(list(range(0, 20000, 500)) + list(range(26000, 36000, 500))))
        self.assertIn("bridgedSlots", plan["stats"])
        self.assertGreater(plan["stats"]["bridgedSlots"], 0)

    def test_lookup_walks_forward_the_way_playback_does(self):
        runs = self.plan["runs"]
        for run in runs:
            live, strength = beat_plan_at(self.plan, run[0] + 1)
            self.assertTrue(live)
            self.assertEqual(strength, run[2])


class MacroIntensityTest(unittest.TestCase):
    """
    The build-and-drop envelope: strength has to *shape* itself around the song
    instead of being equally hard in every driven section.
    """

    def test_flat_delivery_has_no_phases(self):
        # Nothing in this track is more intense than anything else, so there is
        # no build and no drop to report — and none to invent.
        plan = build_beat_plan(_levels_track([1] * 64))
        self.assertIsNotNone(plan)
        self.assertEqual(plan["phases"], [])
        self.assertEqual(plan["stats"]["builds"], 0)
        self.assertEqual(plan["stats"]["drops"], 0)

    def test_climb_is_reported_as_a_build_into_a_drop(self):
        plan = build_beat_plan(_levels_track([1] * 20 + _ramp(28) + [2] * 20))
        kinds = [phase[2] for phase in plan["phases"]]
        self.assertIn("build", kinds)
        self.assertIn("drop", kinds)
        # The build's own drop follows it, so the shapes come in pairs.
        self.assertEqual(kinds, ["build", "drop"])

    def test_a_drop_pulses_harder_than_the_verse_before_it(self):
        # 20 beats of verse, a 28-beat climb, 20 beats of chorus: 10 s of the
        # timeline is verse and 30 s is the drop.
        plan = build_beat_plan(_levels_track([1] * 20 + _ramp(28) + [2] * 20))
        verse = _strength_at_ms(plan, 6000)
        drop = _strength_at_ms(plan, 30000)
        self.assertGreater(verse, 0.0)
        self.assertGreaterEqual(drop - verse, 0.1)

    def test_a_step_into_a_chorus_still_deepens_the_pulse(self):
        # No climb at all — the delivery just gets busier. The peak is still a
        # drop, because that is what it sounds like.
        plan = build_beat_plan(_levels_track([1] * 24 + [2] * 24))
        self.assertTrue(plan["stats"]["drops"] >= 1)
        self.assertGreaterEqual(_strength_at_ms(plan, 20000) - _strength_at_ms(plan, 6000), 0.1)

    def test_phases_are_sorted_and_never_overlap(self):
        # Neighbouring peaks used to each claim the same rising passage, so one
        # crescendo came back as three overlapping builds.
        plan = build_beat_plan(_levels_track([1] * 12 + _ramp(20) + [2] * 10
                                            + [1] * 12 + _ramp(20) + [2] * 10))
        spans = [(phase[0], phase[1]) for phase in plan["phases"]]
        for (_, previous_end), (next_start, _) in zip(spans, spans[1:]):
            self.assertLessEqual(previous_end, next_start)

    def test_phase_lookup_matches_the_spans(self):
        plan = build_beat_plan(_levels_track([1] * 20 + _ramp(28) + [2] * 20))
        for start, end, kind, level in plan["phases"]:
            # Sampled just inside, because a build's end is exactly its drop's
            # start: the boundary instant itself belongs to the earlier span.
            self.assertEqual(beat_phase_at(plan, start + 0.5), (kind, level))
            self.assertEqual(beat_phase_at(plan, (start + end) / 2), (kind, level))
        # Adjacent spans are contiguous, so "outside" is only past the last one.
        self.assertEqual(beat_phase_at(plan, plan["phases"][-1][1] + 1), (None, 0.0))
        self.assertEqual(beat_phase_at(None, 1000), (None, 0.0))
        self.assertEqual(beat_phase_at({"runs": []}, 1000), (None, 0.0))

    def test_density_is_relative_so_a_quiet_mix_behaves_the_same(self):
        # Absolute loudness is unobservable, so everything is measured against
        # the track's own median. Halving every onset leaves the shape identical.
        _, macro = _macro_curve([2.0, 2.0, 4.0, 1.0, 1.0, 3.0] * 6)
        _, half = _macro_curve([1.0, 1.0, 2.0, 0.5, 0.5, 1.5] * 6)
        for a, b in zip(macro, half):
            self.assertAlmostEqual(a, b, places=6)

    def test_macro_curve_is_neutral_at_the_tracks_own_median(self):
        _, macro = _macro_curve([1.0] * 40)
        for level in macro:
            self.assertAlmostEqual(level, 0.5, places=6)

    def test_peaks_respect_the_minimum_separation(self):
        # Two spikes five slots apart are one moment, not two.
        close = [1.0] * 20 + [1.0, 2.4, 1.0] * 2 + [1.0] * 20
        self.assertLessEqual(len(_find_peaks(close)), 1)
        apart = [1.0] * 20 + [2.4] + [1.0] * (PEAK_MIN_SEPARATION + 6) + [2.4] + [1.0] * 20
        self.assertEqual(len(_find_peaks(apart)), 2)

    def test_builds_never_overlap_each_other(self):
        rel = [1.0] * 12 + [1.0 + 0.04 * i for i in range(24)] \
            + [1.0] * 8 + [2.0] + [1.0] * 8 + [1.0 + 0.05 * i for i in range(20)] + [2.1] + [1.0] * 8
        builds = _find_builds(rel, _find_peaks(rel))
        spans = [(start, end) for start, end in builds]
        for (_, previous_end), (next_start, _) in zip(spans, spans[1:]):
            self.assertLessEqual(previous_end, next_start)


class BridgeGapsTest(unittest.TestCase):
    """The instrumental-drop fix: a bounded break between two driven sections
    carries the pulse at reduced depth; anything else stays dark."""

    def _active(self, n, filled_ranges):
        a = [False] * n
        for lo, hi in filled_ranges:
            for k in range(lo, hi):
                a[k] = True
        return a

    def test_short_gap_between_driven_sections_is_carried(self):
        active = self._active(20, [(0, 8), (12, 20)])
        strength = [0.8] * 8 + [0.3] * 4 + [0.6] * 8
        bridged = _bridge_gaps(active, strength)
        self.assertEqual(bridged, 4)
        self.assertTrue(all(active[8:12]))
        # Carried depth is the quieter of the two boundaries, not the gap's own
        # evidence-free reading.
        self.assertEqual(strength[8:12], [0.6, 0.6, 0.6, 0.6])

    def test_long_gap_stays_dark(self):
        # 40 s gap in test_instrumental_gap_rests is ~80 slots: far over the cap.
        active = self._active(40, [(0, 10), (30, 40)])
        strength = [0.8] * 10 + [0.3] * 20 + [0.6] * 10
        bridged = _bridge_gaps(active, strength, max_slots=GAP_BRIDGE_MAX_SLOTS)
        self.assertEqual(bridged, 0)
        self.assertEqual(active[10:30], [False] * 20)

    def test_leading_gap_stays_dark(self):
        active = self._active(10, [(4, 10)])
        strength = [0.3] * 4 + [0.7] * 6
        self.assertEqual(_bridge_gaps(active, strength), 0)
        self.assertEqual(active[:4], [False] * 4)

    def test_trailing_gap_stays_dark(self):
        active = self._active(10, [(0, 6)])
        strength = [0.7] * 6 + [0.3] * 4
        self.assertEqual(_bridge_gaps(active, strength), 0)
        self.assertEqual(active[6:], [False] * 4)

    def test_gap_bounded_by_only_one_active_side_stays_dark(self):
        # Sparse delivery (inactive) on the far side: no bridge, the calm bridge
        # behaviour is preserved.
        active = self._active(20, [(0, 8)])  # slots 8..19 inactive
        strength = [0.8] * 8 + [0.3] * 12
        self.assertEqual(_bridge_gaps(active, strength), 0)


class OccupancyBoundaryTest(unittest.TestCase):
    def test_exit_threshold_sits_below_enter(self):
        # Hysteresis is what stops the pulse strobing on a section boundary.
        from core.beat import ENTER_OCCUPANCY
        self.assertLess(EXIT_OCCUPANCY, ENTER_OCCUPANCY)


if __name__ == "__main__":
    unittest.main()
