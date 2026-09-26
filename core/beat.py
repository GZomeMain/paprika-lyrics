"""
Beat plan: where a track is actually *driven*, so the UI only pulses there.

The overlay gets no audio — Windows exposes transport metadata, not samples — so
the only rhythmic evidence available is the stream of sung-syllable onsets in
the lyric payload. That stream turns out to be enough to do much better than
"this line is a chorus, so pulse":

* **Grid.** A tempo is estimated from the interval histogram of the onsets, and
  then a *phase* is searched for, so the ping sits where the onsets actually
  land rather than on an arbitrary clock. Both halves matter: a correct period
  with the wrong offset puts the pulse half a beat out.
* **Occupancy.** Every grid slot is scored by whether any onset lands on it,
  rolled over a window of recent slots. Delivery that rides a beat fills most
  of them;a rubato phrase, a held note, an a cappella bar or a long instrumental gap
  leaves them empty. A *bounded* break (≤ ~16 slots, ~8 s at 120 BPM) that sits
  between two driven sections is the exception: it is bridged after the gate, at
  the quieter neighbour's depth, because a drop's quiet middle is exactly where
  the pulse must survive. Long breaks, intros and outros keep nothing to bridge
  against and stay dark. Measured over a 60-track corpus this is the one
  feature that actually separates driven from calm delivery (0.27 → 0.92,
  median 0.57).
* **Rate.** Syllables per beat, from the onset mass rather than just presence,
  so a double-time run outranks an occasional word.
* **Percussiveness.** Sustained notes are calm even when there are several of
  them: slots built from long syllables are attenuated, so a legato ballad gets
  a shimmer where a rap verse gets a pulse.
* **Hysteresis + minimum run.** Starting demands more evidence than continuing,
  and the evidence must hold for several consecutive slots, so the pulse cannot
  strobe on a section boundary.
* **Macro intensity (builds and drops).** Occupancy is local: it knows the
  delivery is driven, not whether it is *arriving* somewhere. A second curve over
  the whole track — onset density against the track's own median — finds the
  peaks, walks back from each to where the climb began, requires the climb to be
  genuinely underway by its midpoint, forces it monotone, and holds full strength
  through the hit before relaxing. Every live section's strength is then scaled
  by it, so the pulse ramps through a build and lands on a drop instead of being
  equally hard throughout.

Deliberately absent: line structure and chorus flags. A chorus with no rhythmic
drive stays dark, which is the over-triggering this replaces. Absolute loudness
is absent too — Windows exposes no audio — so "louder" is approximated by
"busier", which is what a build and a drop look like in an onset stream.

Honest limit: the grid phase is *alignment*, not evidence. Grid coherence sits
at ~0.30-0.35 (chance level) on every track measured, because a sung syllable
is not a drum hit — it leads or lags the beat by tens of milliseconds. So the
phase is used to land the pulse on the beat, and never to decide whether to
pulse at all.
"""
from __future__ import annotations

import math

# --- tempo search ---------------------------------------------------------
BPM_MIN = 70.0
BPM_MAX = 180.0
# Below this there is not enough evidence to call a tempo at all.
MIN_ONSETS = 24
# Onsets further apart than this are silence between phrases, not a beat.
IOI_MIN_MS = 80.0
IOI_MAX_MS = 2500.0

# --- grid ----------------------------------------------------------------
# An onset this close to a slot (as a fraction of the period, floored in ms so
# it still works at slow tempos) counts as landing on the beat.
ON_TOL_FRAC = 0.14
ON_TOL_MIN_MS = 55.0

# --- trigger -------------------------------------------------------------
COVER_WINDOW = 8        # slots the rolling occupancy window looks back over
MIN_RUN = 3             # consecutive driven slots before a pulse may start
# An instrumental break this short, sitting between two driven sections, is a
# drop's quiet middle — not the end of the groove. The pulse is carried across
# it at the quieter neighbour's depth. Longer breaks, and anything before the
# first or after the last driven slot, stay dark: with no evidence on one side
# there is nothing to carry.
GAP_BRIDGE_MAX_SLOTS = 16  # ~8 s at 120 BPM
ENTER_OCCUPANCY = 0.50  # occupancy needed to start...
EXIT_OCCUPANCY = 0.34   # ...versus to keep going (hysteresis)
# Sustained delivery has to clear a higher bar to start, but is not banned: a
# legato chorus still shimmers, it just does not shout.
SUSTAIN_PENALTY = 0.16
PERCUSSIVE_MS = 340.0   # syllables longer than this read as held, not struck
PERCUSSIVE_FLOOR = 0.40 # attenuation floor for a fully sustained passage
DEFAULT_SYL_MS = 180.0  # assumed syllable length when the payload omits one
STRENGTH_BUCKET = 0.1   # strength quantisation, keeps the run list small
# An active section always has *some* presence: a section that earned a pulse
# should not then be given a strength of zero, which would be an invisible run
# carried in the plan for nothing.
STRENGTH_FLOOR = 0.4
STRENGTH_SMOOTH = 3     # slots of moving average on the strength, so it breathes

# --- macro intensity: builds and drops -------------------------------------
# Occupancy answers "is the delivery driven right now" and nothing else, so every
# driven section came out equally strong and the pulse never shaped itself around
# the song. The curve below adds the shape: it ramps a section up across several
# bars into a peak, and slams to full at the peak before relaxing.
#
# Absolute loudness is not observable (no audio), so intensity is read as onset
# density *relative to the track's own median*. Relative is also what makes it
# portable: a hushed ballad and a loud mix both build, at their own scale.
MACRO_HALF_SLOTS = 8       # density window: +/- this many slots (about 2 bars)
MACRO_SMOOTH = 3           # so a single flourish cannot become a peak
PEAK_NEIGHBOURHOOD = 8     # a peak has to dominate this many slots either side
PEAK_MIN_REL = 1.15        # ...and sit this far above the track's own reference
PEAK_MIN_PROMINENCE = 0.28 # ...and this far above its surrounding bars
# Two peaks closer together than this are one moment, not two: a chorus with a
# slightly busier second half was being reported as two drops.
PEAK_MIN_SEPARATION = 20
BUILD_MIN_SLOTS = 16       # shortest climb that may be called a build (~4 bars)
BUILD_MAX_SLOTS = 96       # longest look-back for a build's start (~24 bars)
BUILD_MIN_RISE = 0.22      # relative rise across the climb to qualify
# Share of the total rise that has to have happened by the halfway point. This is
# what separates a climb from a step: a flat verse that jumps into a chorus has
# made ~0% of its rise at the midpoint and is not a build.
BUILD_RAMP_FRACTION = 0.25
BUILD_TOLERANCE = 0.05     # a dip this small does not break a climb
DROP_HOLD_SLOTS = 8        # the hit is held flat for this long...
DROP_SLOTS = 16            # ...then relaxes over this window (~4 bars)
GAIN_LOW = 0.55            # macro -> strength gain: the calmest live section
GAIN_SPAN = 0.75           # ...through to the hardest drop (0.55 -> 1.30)
MACRO_FLOOR = 0.30         # a live section never goes fully dark


class _Onset:
    __slots__ = ("t", "w", "dur", "line_start")

    def __init__(self, t: float, w: float, dur: float, line_start: bool):
        self.t = t
        self.w = w
        self.dur = dur
        self.line_start = line_start


def _collect_onsets(lines: list[dict] | None) -> list[_Onset]:
    """
    Every sung syllable onset, weighted by how much it reads as a *strike*.

    Salience comes from three things that correlate with an accented beat: the
    silence before it, how short the syllable is (percussive vs held), and
    whether it opens a phrase.
    """
    onsets: list[_Onset] = []
    # Carried across lines on purpose: the silence before a phrase opening is an
    # accent, and resetting per line would throw that signal away.
    prev_end: float | None = None
    for line in lines or []:
        if not isinstance(line, dict):
            continue
        syls = []
        for word in (line.get("words") or []):
            if not isinstance(word, dict):
                continue
            for syl in (word.get("syllables") or []):
                if isinstance(syl, dict):
                    syls.append(syl)
        for i, syl in enumerate(syls):
            start = syl.get("startTimeMs")
            if isinstance(start, bool) or not isinstance(start, (int, float)):
                continue
            start = float(start)
            end = syl.get("endTimeMs")
            end = float(end) if isinstance(end, (int, float)) and not isinstance(end, bool) else None
            dur = end - start if end is not None and end > start else DEFAULT_SYL_MS
            weight = 1.0
            if prev_end is not None and start > prev_end:
                weight += min(1.5, (start - prev_end) / 500.0)
            if dur <= PERCUSSIVE_MS:
                weight *= 1.25
            onsets.append(_Onset(start, weight, dur, i == 0))
            prev_end = end if end is not None else start
    onsets.sort(key=lambda o: o.t)
    return onsets


def _estimate_bpm(onsets: list[_Onset]) -> float:
    """
    Dominant inter-onset interval, folded into the musical 70-180 BPM band so a
    300 ms spacing and a 600 ms spacing resolve to the same groove. Intervals
    that cross a line boundary are skipped: a gap between phrases is silence,
    not a musical rest, and an 8 s break would otherwise plant a slow-tempo bin.
    """
    hist: dict[int, float] = {}
    for i in range(1, len(onsets)):
        if onsets[i].line_start:
            continue
        ioi = onsets[i].t - onsets[i - 1].t
        if ioi < IOI_MIN_MS or ioi > IOI_MAX_MS:
            continue
        bpm = 60000.0 / ioi
        while bpm < BPM_MIN:
            bpm *= 2
        while bpm > BPM_MAX:
            bpm /= 2
        bin_index = int(round(bpm))
        hist[bin_index] = hist.get(bin_index, 0.0) + onsets[i].w

    if not hist:
        return 0.0
    best_score, best_bpm = -1.0, 0.0
    for bpm, score in hist.items():
        # Smooth so a 124 BPM song does not split across 123/125.
        smoothed = score + 0.5 * (hist.get(bpm - 1, 0.0) + hist.get(bpm + 1, 0.0))
        if smoothed > best_score:
            best_score, best_bpm = smoothed, float(bpm)
    return best_bpm


def _grid_mass(onsets: list[_Onset], period: float, phase: float, tol: float) -> float:
    """Weighted onset mass that lands within `tol` of any grid slot."""
    total = 0.0
    for o in onsets:
        slot = round((o.t - phase) / period)
        if abs(o.t - (phase + slot * period)) <= tol:
            total += o.w
    return total


def _best_phase(onsets: list[_Onset], period: float) -> tuple[float, float]:
    """
    The phase (a slot time) that puts the most onset weight on the grid.

    Found by folding every onset into a phase histogram of the period, then
    refining the winning bin at 2 ms resolution — a full scan of the period at
    that resolution would be ~300x the work for the same answer.
    """
    tol = max(ON_TOL_MIN_MS, period * ON_TOL_FRAC)
    bins = max(32, int(round(period / 10.0)))
    t0 = onsets[0].t
    hist = [0.0] * bins
    for o in onsets:
        p = (o.t - t0) % period
        hist[min(bins - 1, int(p / period * bins))] += o.w

    half = max(0, int(round(tol / period * bins)))
    best_index, best_value = 0, -1.0
    for i in range(bins):
        value = 0.0
        for d in range(-half, half + 1):
            value += hist[(i + d) % bins]
        if value > best_value:
            best_value, best_index = value, i

    coarse = t0 + (best_index + 0.5) / bins * period
    span = period / bins
    step = max(1.0, span / 6.0)
    phase, value = coarse, _grid_mass(onsets, period, coarse, tol)
    probe = coarse - span
    while probe <= coarse + span:
        candidate = _grid_mass(onsets, period, probe, tol)
        if candidate > value:
            value, phase = candidate, probe
        probe += step
    return phase, value


def _slot_arrays(onsets: list[_Onset], period: float, phase: float,
                 first_ms: float, last_ms: float):
    """Bucket the onsets onto the grid, keeping weight and duration sums."""
    k0 = math.floor((first_ms - phase) / period)
    k1 = math.ceil((last_ms - phase) / period) + COVER_WINDOW
    count = max(1, k1 - k0 + 1)
    mass = [0.0] * count
    dur_weighted = [0.0] * count
    weight = [0.0] * count
    for o in onsets:
        slot = int(round((o.t - phase) / period)) - k0
        if 0 <= slot < count:
            mass[slot] += o.w
            dur_weighted[slot] += o.w * o.dur
            weight[slot] += o.w
    return k0, count, mass, dur_weighted, weight


def _percussiveness(count: int, dur_weighted: list[float], weight: list[float]) -> list[float]:
    """
    1.0 where the delivery is struck and short, falling toward PERCUSSIVE_FLOOR
    where it is sustained. Smoothed over neighbouring slots so one long note
    cannot open a hole in an otherwise percussive run.
    """
    out: list[float] = []
    running = 1.0
    for k in range(count):
        num = den = 0.0
        for j in range(max(0, k - 1), min(count, k + 2)):
            num += dur_weighted[j]
            den += weight[j]
        if den > 0:
            running = max(PERCUSSIVE_FLOOR, min(1.0, PERCUSSIVE_MS / (num / den)))
        out.append(running)
    return out


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


def _rolling(values: list[float]) -> list[float]:
    """Mean of the last COVER_WINDOW slots, so a local reading can toggle mid-song."""
    out: list[float] = []
    acc = 0.0
    for k in range(len(values)):
        acc += values[k]
        if k >= COVER_WINDOW:
            acc -= values[k - COVER_WINDOW]
        out.append(acc / min(k + 1, COVER_WINDOW))
    return out


def _smooth(values: list[float], radius: int = 2) -> list[float]:
    out: list[float] = []
    for k in range(len(values)):
        lo, hi = max(0, k - radius), min(len(values), k + radius + 1)
        window = values[lo:hi]
        out.append(sum(window) / len(window))
    return out


def _bucket(value: float) -> float:
    # STRENGTH_BUCKET is a tenth, so rounding to one decimal is exact and avoids
    # the 0.35/0.1 floating-point wobble landing a level on 0.3 instead of 0.4.
    return round(min(1.0, max(0.0, value)), 1)


def _strength_at(drive: float) -> float:
    """
    Map drive onto [STRENGTH_FLOOR, 1] so an active section is always visible.

    This is the *local* depth only; the macro gain is applied on top of it in
    build_beat_plan, which is what lets a cautious verse fall to MACRO_FLOOR
    while its chorus reaches 1.0.
    """
    span = 1.0 - EXIT_OCCUPANCY
    normalised = max(0.0, min(1.0, (drive - EXIT_OCCUPANCY) / span))
    return _bucket(STRENGTH_FLOOR + (1.0 - STRENGTH_FLOOR) * normalised)


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return 0.5 * (ordered[mid - 1] + ordered[mid])


def _density(mass: list[float], half: int) -> list[float]:
    """Onset mass per slot over a +/- half-slot window."""
    count = len(mass)
    out: list[float] = []
    for k in range(count):
        lo, hi = max(0, k - half), min(count, k + half + 1)
        out.append(sum(mass[lo:hi]) / (hi - lo))
    return out


def _macro_curve(mass: list[float]) -> tuple[list[float], list[float]]:
    """
    The track's intensity shape: (relative density, macro level 0..1).

    Density (onsets per slot) measured against the track's own median. A build
    and a drop are exactly what this looks like in a lyric onset stream: the
    delivery accelerates into the peak and thins out in the quiet parts. tanh
    keeps an unusually dense passage from running away with the levels while
    staying near-linear close to the reference.
    """
    dens = _smooth(_density(mass, MACRO_HALF_SLOTS), MACRO_SMOOTH)
    ref = _median([d for d in dens if d > 0]) or 1.0
    rel = [d / ref for d in dens]
    macro = [0.5 + 0.5 * math.tanh((r - 1.0) * 0.85) for r in rel]
    return rel, macro


def _find_peaks(rel: list[float]) -> list[int]:
    """
    Local maxima that are really peaks: dominant within a neighbourhood, clearly
    above the track's own reference, and standing out from the surrounding bars.
    Without the prominence test every wobble of a busy mix qualifies.
    """
    count = len(rel)
    candidates: list[int] = []
    for k in range(count):
        r = rel[k]
        if r < PEAK_MIN_REL:
            continue
        lo, hi = max(0, k - PEAK_NEIGHBOURHOOD), min(count, k + PEAK_NEIGHBOURHOOD + 1)
        if r < max(rel[lo:hi]):
            continue
        base_lo = max(0, k - 4 * PEAK_NEIGHBOURHOOD)
        base_hi = min(count, k + 4 * PEAK_NEIGHBOURHOOD + 1)
        if r - _median(rel[base_lo:base_hi]) < PEAK_MIN_PROMINENCE:
            continue
        candidates.append(k)

    # A plateau yields a run of equal maxima, and a chorus can swell twice a few
    # bars apart: keep the strongest of each cluster so one moment is one drop.
    peaks: list[int] = []
    for k in candidates:
        if peaks and k - peaks[-1] < PEAK_MIN_SEPARATION:
            if rel[k] > rel[peaks[-1]]:
                peaks[-1] = k
            continue
        peaks.append(k)
    return peaks


def _find_builds(rel: list[float], peaks: list[int]) -> list[tuple[int, int]]:
    """
    The climb into each peak: the longest span whose start is meaningfully lower
    than the peak and which rises the whole way, small dips tolerated. A song
    that gradually gets busier qualifies; a peak that simply appears out of a
    flat passage does not.

    One build per peak, and they cannot overlap: a build may not start until the
    previous peak's drop has finished, and may not reach back further than
    BUILD_MAX_SLOTS. Without that, neighbouring peaks each claimed the same
    rising passage and the track reported three builds through one crescendo.
    """
    builds: list[tuple[int, int]] = []
    earliest = 0
    for p in peaks:
        lo = max(earliest, p - BUILD_MAX_SLOTS)
        for s in range(lo, p - BUILD_MIN_SLOTS + 1):
            rise = rel[p] - rel[s]
            if rise < BUILD_MIN_RISE:
                continue
            span = p - s
            mid = rel[s + span // 2]
            if mid - rel[s] < BUILD_RAMP_FRACTION * rise:
                continue
            if rel[p] < mid - BUILD_TOLERANCE:
                continue
            builds.append((s, p))
            break
        # Reserved for this peak's own hit, whether or not a build was found.
        earliest = p + DROP_SLOTS
    return builds


def _shape_macro(macro: list[float], rel: list[float], peaks: list[int],
                 builds: list[tuple[int, int]]) -> list[float]:
    """
    Fold the climbs and the hits into the macro curve.

    A build is forced monotone: the raw density curve wobbles (a held note, a
    breath), and a ramp that dips in the middle does not read as a build. A drop
    is held flat at full for a few beats and then relaxes back onto the curve,
    so the hit lands and the section keeps its energy afterwards.
    """
    shaped = list(macro)
    for s, p in builds:
        start_level, peak_level = macro[s], macro[p]
        span = max(1, p - s)
        for k in range(s, p + 1):
            # progress**0.8 creeps early and accelerates late, which is how a
            # musical build actually feels.
            progress = (k - s) / span
            ramp = start_level + (peak_level - start_level) * (progress ** 0.8)
            if ramp > shaped[k]:
                shaped[k] = ramp
    for p in peaks:
        hit = min(1.0, 0.80 + 0.20 * min(1.0, (rel[p] - PEAK_MIN_REL) / 0.8))
        for k in range(p, min(len(macro), p + DROP_SLOTS)):
            offset = k - p
            if offset <= DROP_HOLD_SLOTS:
                level = hit
            else:
                relax = (offset - DROP_HOLD_SLOTS) / max(1, DROP_SLOTS - DROP_HOLD_SLOTS)
                level = hit + (macro[k] - hit) * relax
            if level > shaped[k]:
                shaped[k] = level
    return shaped


def _phase_spans(count: int, peaks: list[int], builds: list[tuple[int, int]]) -> list[tuple[int, int, str]]:
    """
    Build and drop spans in slot indices, as a partition with no overlaps: a
    build ends the slot before its drop begins, and the next build starts after
    that drop. A consumer therefore never has to decide which one wins, and a
    readout can name a single phase for any playhead position.
    """
    spans: list[tuple[int, int, str]] = []
    for s, p in builds:
        if p - 1 >= s:
            spans.append((s, p - 1, "build"))
    for p in peaks:
        spans.append((p, min(count - 1, p + DROP_SLOTS - 1), "drop"))
    spans.sort(key=lambda item: item[0])
    return spans


def build_beat_plan(lines: list[dict] | None) -> dict | None:
    """
    Returns where the pulse should run, or None when the track gives too little
    rhythmic evidence to justify pulsing at all.

    Shape: ``{bpm, periodMs, phaseMs, runs: [[startMs, endMs, strength], ...]}``
    with ``strength`` in 0..1. Runs are sorted, non-overlapping and in absolute
    track time, so the UI only has to find the containing run.
    """
    onsets = _collect_onsets(lines)
    if len(onsets) < MIN_ONSETS:
        return None

    bpm = _estimate_bpm(onsets)
    if bpm <= 0:
        return None
    period = 60000.0 / bpm
    phase, grid_mass = _best_phase(onsets, period)

    total_weight = sum(o.w for o in onsets) or 1.0
    coherence = grid_mass / total_weight

    first_ms = min(o.t for o in onsets)
    last_ms = max(o.t + o.dur for o in onsets)
    k0, count, mass, dur_weighted, weight = _slot_arrays(onsets, period, phase, first_ms, last_ms)
    perc = _percussiveness(count, dur_weighted, weight)
    occupancy = _rolling([1.0 if m > 0 else 0.0 for m in mass])
    # Rate as well as presence: a double-time run is more driven than an
    # occasional word landing on the same number of slots.
    rate = _rolling([min(2.0, mass[k]) for k in range(count)])
    drive = [max(occupancy[k], 0.5 * rate[k]) * perc[k] for k in range(count)]

    # Hysteresis: harder to start than to keep, and a run is only allowed once
    # several consecutive slots have earned it.
    active = [False] * count
    on = False
    run = 0
    for k in range(count):
        if on:
            if occupancy[k] < EXIT_OCCUPANCY:
                on = False
                run = 0
        else:
            enter = ENTER_OCCUPANCY + (1.0 - perc[k]) * SUSTAIN_PENALTY
            run = run + 1 if occupancy[k] >= enter else 0
            if run >= MIN_RUN:
                on = True
                for j in range(max(0, k - MIN_RUN + 1), k + 1):
                    active[j] = True
        active[k] = on

    smoothed = _smooth(drive, STRENGTH_SMOOTH)

    # The gate above says *whether* to pulse; the macro curve says *how hard*.
    # Without it every driven section came out at the same depth, so a chorus
    # landing after a build felt identical to a verse that happened to be busy.
    rel, macro = _macro_curve(mass)
    peaks = _find_peaks(rel)
    builds = _find_builds(rel, peaks)
    shaped = _shape_macro(macro, rel, peaks, builds)
    strength = [
        max(MACRO_FLOOR, _bucket(_strength_at(smoothed[k]) * (GAIN_LOW + GAIN_SPAN * shaped[k])))
        for k in range(count)
    ]

    # Instrumental breaks: occupancy only sees sung syllables, so a drop's
    # quiet middle reads as empty slots and the gate closes exactly at the
    # drop. A bounded break between two driven sections is carried instead.
    bridged = _bridge_gaps(active, strength)

    # Runs are split where the strength changes, so the pulse deepens and eases
    # with the music rather than switching between flat on and off.
    runs: list[list[float]] = []
    k = 0
    while k < count:
        if not active[k]:
            k += 1
            continue
        level = strength[k]
        j = k
        while j + 1 < count and active[j + 1] and abs(strength[j + 1] - level) <= STRENGTH_BUCKET:
            j += 1
        start_ms = phase + (k0 + k) * period
        end_ms = phase + (k0 + j + 1) * period
        # The grid runs a coverage window past the last onset, so late slots can
        # land beyond the track. Clamping them would leave a zero-length run.
        if start_ms >= last_ms:
            break
        runs.append([round(start_ms, 1), round(min(end_ms, last_ms), 1), level])
        k = j + 1

    if not runs:
        return None

    # Build/drop spans in absolute track time, carrying the strength the pulse
    # actually reaches there. A span with nothing active in it is dropped: the
    # pulse cannot run there, so reporting it would be a claim the plan cannot
    # honour. Consumers treat this as decoration — `runs` alone is sufficient.
    phases: list[list] = []
    spans = _phase_spans(count, peaks, builds)
    for a, b, kind in spans:
        end = min(count, b + 1)
        if not any(active[j] for j in range(a, end)):
            continue
        start_ms = phase + (k0 + a) * period
        if start_ms >= last_ms:
            continue
        window = strength[a:end]
        phases.append([
            round(start_ms, 1),
            round(min(phase + (k0 + end) * period, last_ms), 1),
            kind,
            _bucket(sum(window) / len(window) if window else 0.0),
        ])

    return {
        "bpm": int(round(bpm)),
        "periodMs": round(period, 3),
        "phaseMs": round(phase, 3),
        "runs": runs,
        "phases": phases,
        "stats": {
            "onsets": len(onsets),
            "coherence": round(coherence, 3),
            "slots": count,
            "activeSlots": sum(1 for a in active if a),
            "builds": sum(1 for _, _, kind in spans if kind == "build"),
            "drops": len(peaks),
            "bridgedSlots": bridged,
        },
    }


def beat_plan_at(plan: dict | None, ms: float) -> tuple[bool, float]:
    """Live/strength at a playhead position. Mirrors the UI's lookup."""
    if not plan:
        return False, 0.0
    for start, end, level in plan.get("runs") or []:
        if ms < start:
            return False, 0.0
        if ms <= end:
            return True, level
    return False, 0.0


def beat_phase_at(plan: dict | None, ms: float) -> tuple[str | None, float]:
    """
    Which shape the pulse is in at a playhead position: 'build', 'drop', or None
    for the steady stretches between them. Mirrors the UI's lookup too.
    """
    if not plan:
        return None, 0.0
    for start, end, kind, level in plan.get("phases") or []:
        if ms < start:
            return None, 0.0
        if ms <= end:
            return kind, level
    return None, 0.0
