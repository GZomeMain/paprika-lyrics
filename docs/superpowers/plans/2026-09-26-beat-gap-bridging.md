# Beat Gap-Bridging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the beat pulse from dying during instrumental drops/choruses (and from lingering uncontrolled over silence) by carrying it, at reduced depth, across *bounded* instrumental breaks between driven sections — while keeping long gaps, held notes and sparse verses dark.

**Architecture:** `core/beat.py` derives every grid slot's occupancy from sung-syllable onsets only, so instrumental passages have no evidence and the hysteresis gate closes exactly when the beat drops. The fix is one pure post-pass, `_bridge_gaps(active, strength)`, run after the existing hysteresis pass: any maximal stretch of inactive slots that is bounded by active slots on **both** sides and is at most `GAP_BRIDGE_MAX_SLOTS` long becomes active with `strength = min(left boundary, right boundary)`. Leading/trailing gaps and gaps longer than the limit stay dark. The plan JSON shape (`runs`/`phases`/`stats`) is unchanged, so `ui/app.js` needs no edits.

**Tech Stack:** Python 3.13 stdlib only (`unittest`, no pytest installed). `core/beat.py` is pure (no winsdk) and fully unit-testable.

**Future direction (agreed, out of scope here):** WASAPI loopback capture + a real-time onset/beat analyzer (librosa or aubio) as a follow-up sub-project — a separate plan with its own task breakdown. It would override the lyric-based plan whenever audio capture is healthy; nothing in this plan is wasted since the lyric model remains the fallback. The two-sentence user symptom ("pulse triggers with nothing happening, then ditches at the drop") is the audio-evidence gap this loopback plan will close at the root.

## Global Constraints

- Test runner: `python -m unittest discover -s tests` (unittest, NOT pytest). Single test: `python -m unittest tests.test_beat.<Class>.<method> -v`.
- Plan/run format must not change: `runs: [[startMs, endMs, strength], ...]`, sorted, non-overlapping, `strength` in `[MACRO_FLOOR, 1.0]`.
- `core/beat.py` stays pure — no winsdk/IO imports.
- Existing dark behaviors are pinned by tests and MUST NOT regress: `test_instrumental_gap_rests` (40 s gap), `test_held_notes_do_not_pulse`, `test_calm_section_inside_a_driven_track_rests`, `test_pulse_returns_after_a_calm_bridge`, `test_line_only_payloads_never_pulse`, `test_too_little_evidence_gives_no_plan`.
- Full suite is currently 147 tests OK; it must be green after every task.
- Commit after each task with the message given in the task.

## File Structure

- Modify: `core/beat.py` — add constant `GAP_BRIDGE_MAX_SLOTS = 16` (trigger section, near `MIN_RUN`), add pure function `_bridge_gaps`, call it in `build_beat_plan` between the hysteresis pass and run splitting, add `stats["bridgedSlots"]`, extend module docstring's Occupancy bullet.
- Modify: `tests/test_beat.py` — new `BridgeGapsTest` (helper-level) and new integration tests in `TriggerTest` / `PlanShapeTest`.
- Modify: `README.md` — amend the beat-sync feature bullets and add one manual-smoke item.
- No UI changes: `ui/app.js` reads only `runs`, `phases`, `stats.coherence/builds/drops`; `stats.bridgedSlots` is additive and ignored by the UI.

---

### Task 1: `_bridge_gaps` helper (pure, unit-tested)

**Files:**
- Modify: `core/beat.py` (add constant + function; placement shown below)
- Test: `tests/test_beat.py`

**Interfaces:**
- Consumes: nothing new (operates on the `active: list[bool]` and `strength: list[float]` arrays `build_beat_plan` already builds).
- Produces: `GAP_BRIDGE_MAX_SLOTS = 16` and `_bridge_gaps(active: list[bool], strength: list[float], max_slots: int = GAP_BRIDGE_MAX_SLOTS) -> int` — mutates both lists in place, returns the number of slots bridged. Task 2 relies on exactly this signature.

- [x] **Step 1: Write the failing tests**

Add to `tests/test_beat.py` (new import line piece + new test class; put `GAP_BRIDGE_MAX_SLOTS` and `_bridge_gaps` into the existing `from core.beat import (...)` block alphabetically):

```python
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
```

- [x] **Step 2: Run tests to verify they fail**

Run: `python -m unittest tests.test_beat.BridgeGapsTest -v`
Expected: FAIL/ERROR — `ImportError: cannot import name '_bridge_gaps'` (and `GAP_BRIDGE_MAX_SLOTS`).

- [x] **Step 3: Write the minimal implementation**

In `core/beat.py`, add the constant in the trigger section right after `MIN_RUN = 3`:

```python
# An instrumental break this short, sitting between two driven sections, is a
# drop's quiet middle — not the end of the groove. The pulse is carried across
# it at the quieter neighbour's depth. Longer breaks, and anything before the
# first or after the last driven slot, stay dark: with no evidence on one side
# there is nothing to carry.
GAP_BRIDGE_MAX_SLOTS = 16  # ~8 s at 120 BPM
```

And the function, placed directly after `_percussiveness` (before `_rolling`):

```python
def _bridge_gaps(active: list[bool], strength: list[float],
                 max_slots: int = GAP_BRIDGE_MAX_SLOTS) -> int:
    """
    Carry the pulse across bounded instrumental breaks between driven sections.

    Occupancy is built from sung syllables only, so a drop's quiet middle has
    zero evidence and the hysteresis gate closes exactly where the beat lands —
    the one place the pulse matters most. A dark stretch bounded by active
    sections on *both* sides and no longer than `max_slots` is made active at
    the quieter neighbour's depth. Longer gaps, and gaps touching the first or
    last driven slot, stay dark: on one side there is nothing to carry.
    """
    count = len(active)
    bridged = 0
    k = 0
    while k < count:
        if active[k]:
            k += 1
            continue
        j = k
        while j < count and not active[j]:
            j += 1
        if 0 < k and j < count and (j - k) <= max_slots:
            level = min(strength[k - 1], strength[j])
            for m in range(k, j):
                active[m] = True
                strength[m] = level
                bridged += 1
        k = j
    return bridged
```

Add `GAP_BRIDGE_MAX_SLOTS` and `_bridge_gaps` to the test file's import block.

- [x] **Step 4: Run tests to verify they pass**

Run: `python -m unittest tests.test_beat.BridgeGapsTest -v`
Expected: PASS (5 tests).

- [x] **Step 5: Run the full suite to confirm no regressions**

Run: `python -m unittest discover -s tests`
Expected: 152 tests OK (147 + 5 new).

- [x] **Step 6: Commit**

```bash
git add core/beat.py tests/test_beat.py
git commit -m "feat(beat): add pure gap-bridging helper for bounded instrumental breaks"
```

---

### Task 2: Wire the bridge into `build_beat_plan` + stats + docs

**Files:**
- Modify: `core/beat.py` (hysteresis block in `build_beat_plan`, `stats` dict, module docstring)
- Modify: `tests/test_beat.py` (integration tests in `TriggerTest` and `PlanShapeTest`)
- Modify: `README.md` (beat-sync bullets + one smoke item)

**Interfaces:**
- Consumes: `_bridge_gaps(active, strength)` and `GAP_BRIDGE_MAX_SLOTS` from Task 1 (exact signatures above).
- Produces: `build_beat_plan(lines)` now returns plans whose `runs` stay live across instrumental breaks ≤ ~16 slots between driven sections; `stats` gains `"bridgedSlots": int`. Nothing else in the return shape changes; consumers (`core/smtc.py`, `ui/app.js`) are untouched.

- [x] **Step 1: Write the failing tests**

In `tests/test_beat.py`, add to `TriggerTest`:

```python
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
```

In `PlanShapeTest` (uses the existing `self.plan` setUp of a fully steady track):

```python
    def test_stats_report_bridged_slots(self):
        plan = build_beat_plan(
            _track(list(range(0, 20000, 500)) + list(range(26000, 36000, 500))))
        self.assertIn("bridgedSlots", plan["stats"])
        self.assertGreater(plan["stats"]["bridgedSlots"], 0)
```

- [x] **Step 2: Run tests to verify they fail**

Run: `python -m unittest tests.test_beat.TriggerTest.test_short_instrumental_break_between_driven_sections_stays_live tests.test_beat.TriggerTest.test_bridge_strength_is_the_quieter_boundary tests.test_beat.PlanShapeTest.test_stats_report_bridged_slots -v`
Expected: FAIL — `_covered(plan, 20500, 25500)` is 0.0 today (the gap is dark), and `bridgedSlots` is missing.

- [x] **Step 3: Write the minimal implementation**

In `build_beat_plan`, insert one call after the `strength = [...]` list comprehension and directly above the run-splitting `while k < count:` loop:

```python
    # Instrumental breaks: occupancy only sees sung syllables, so a drop's
    # quiet middle reads as empty slots and the gate closes exactly at the
    # drop. A bounded break between two driven sections is carried instead.
    bridged = _bridge_gaps(active, strength)
```

In the `stats` dict at the end of `build_beat_plan`, add one key:

```python
            "bridgedSlots": bridged,
```

In the module docstring, extend the **Occupancy** bullet's last sentence. Replace:

```
a rubato phrase, a held note, an a cappella bar or an instrumental gap leaves them empty.
```

with:

```
a rubato phrase, a held note, an a cappella bar or a long instrumental gap leaves them empty. A *bounded* break (≤ ~16 slots, ~8 s at 120 BPM) that sits between two driven sections is the exception: it is bridged after the gate, at the quieter neighbour's depth, because a drop's quiet middle is exactly where the pulse must survive. Long breaks, intros and outros keep nothing to bridge against and stay dark.
```

- [x] **Step 4: Run the new tests to verify they pass**

Run: `python -m unittest tests.test_beat.TriggerTest tests.test_beat.PlanShapeTest tests.test_beat.BridgeGapsTest -v`
Expected: PASS.

- [x] **Step 5: Run the full suite — the pinned dark behaviors must hold**

Run: `python -m unittest discover -s tests`
Expected: 155 tests OK. In particular these must still pass unchanged:
- `test_instrumental_gap_rests` — the 40 s gap is ~80 slots; the ≤16-slot bridge ends near 27.6 s, outside the asserted 30–55 s dark window.
- `test_calm_section_inside_a_driven_track_rests` — the sparse 2 s-spaced passage decays below `EXIT_OCCUPANCY` mid-passage; it is not bounded by two *active* regions, so no bridge applies.
- `test_pulse_returns_after_a_calm_bridge` — the 32–34 s gap is bounded by *inactive* sparse delivery, so `_bridge_gaps` never fires.
- `test_held_notes_do_not_pulse`, `test_line_only_payloads_never_pulse`, `test_too_little_evidence_gives_no_plan` — no active regions at all, nothing to bridge.

If any of these fail, STOP and re-derive: the bridge condition requires active slots on both sides — do not weaken the existing tests.

- [x] **Step 6: Update README**

In the "**Where it pulses is a rhythm model, not a chorus flag**" bullet, amend the occupancy sub-bullet. Replace:

```
and it is what makes an a cappella bar, a held note or an instrumental gap go dark.
```

with:

```
and it is what makes an a cappella bar, a held note or a long instrumental gap go dark. A short instrumental break (~≤8 s) between two driven sections is bridged at reduced depth instead — the pulse survives the quiet middle of a drop rather than dying at it — while long breaks, intros and outros stay dark.
```

In the "✅ Manual Smoke Checklist", add one item after the "Instrumental break" countdown item:

```
- [ ] Beat pulse: on a track with a short instrumental break (~4–8 s) the pulse eases through the break at reduced depth instead of going dark; on a track with a 30 s+ break the pulse stops during it.
```

- [x] **Step 7: Commit**

```bash
git add core/beat.py tests/test_beat.py README.md
git commit -m "feat(beat): carry the pulse across short instrumental drops instead of dying at them"
```

---

## Self-Review

- **Spec coverage:** the user's report has two halves, both covered by one mechanism — "ditches when beat drops" = the gate closing at evidence-free drop middles (bridged now); "triggers without anything happening" = the uncontrolled ~4 s window-linger over silence, which the bridge replaces with a deliberate, bounded, reduced-depth carry and a hard dark past 16 slots. Held notes, sparse verses, long gaps, intros/outros and line-only payloads stay dark (pinned by existing tests, explicitly re-checked in Task 2 Step 5).
- **Placeholder scan:** every step carries concrete code, exact commands, expected outputs, and exact commit messages — no TBDs.
- **Type consistency:** `_bridge_gaps(active, strength, max_slots=GAP_BRIDGE_MAX_SLOTS) -> int` is defined in Task 1 and consumed with that exact name/order in Task 2; `stats["bridgedSlots"]` is written in Task 2 Step 3 and asserted in Task 2 Step 1's test; plan `runs` shape untouched so `ui/app.js` cursors (`beatRunAt`/`beatPhaseAt`) need no change.
- **Deliberately out of scope:** retuning `ENTER/EXIT_OCCUPANCY`/`MIN_RUN` (corpus-tuned; no corpus available here), using line start/end times as extra onsets (would make held notes pulse and break `test_held_notes_do_not_pulse`), and audio analysis (WASAPI loopback + librosa/aubio — agreed follow-up sub-project, separate plan).
