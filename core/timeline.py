"""Pure GSMTC timeline handling: unit/origin normalization and the playhead clock.

Kept free of winsdk so both halves are unit-testable anywhere, and so the
fragile parts of the integration live in one reviewable place.

**Units and origin.** Windows hands back ``start_time``, ``end_time``,
``position``, ``min_seek_time`` and ``max_seek_time`` as ``datetime.timedelta``
objects counted in 100-nanosecond ticks, all on the *item's own* timeline.
Duration is therefore ``end_time - start_time`` and elapsed is
``position - start_time`` — not the raw values. Reading ``end_time`` directly
(as the bridge used to) happens to work for players that keep the origin at
zero and is wrong for players that do not.

**Liveness.** A player that has never published a timeline leaves every field at
zero *and* ``last_updated_time`` at WinRT's "never updated" sentinel
(1601-01-01T00:00:00Z). ``published`` reports that separately from the values,
so callers can tell "the player says 0:00" from "the player says nothing".

**Extrapolation.** ``PositionClock`` keeps the last raw sample and the monotonic
instant it was read, and projects forward between player updates. Anchoring on
*our* monotonic clock rather than the player's ``last_updated_time`` means a
player whose clock is skewed, or whose snapshot is old, cannot drag the playhead
with it. Re-anchoring only happens on a genuinely fresh sample, so a snapshot the
player has not refreshed never snaps the highlight backwards; a switch to paused,
stopped or a different session re-anchors immediately, and the projection is
bounded so a player that goes silent cannot run away.
"""
from __future__ import annotations

from dataclasses import dataclass

# WinRT's default timestamp before anything has been written to it.
NEVER_UPDATED_YEAR = 1700

# Never project further than this beyond the last fresh sample (ms). A player
# that has said nothing for longer than this is paused, detached or buffering,
# and the honest answer is the last position it actually reported.
MAX_EXTRAPOLATION_MS = 5_000.0

# Playback rates outside this band are treated as "not reported" (1.0x).
RATE_MIN = 0.05
RATE_MAX = 4.0


def to_ms(value) -> float | None:
    """A ``timedelta`` (or anything with ``total_seconds``) as milliseconds."""
    if value is None:
        return None
    total_seconds = getattr(value, "total_seconds", None)
    if total_seconds is None:
        return None
    try:
        ms = float(total_seconds()) * 1000.0
    except Exception:
        return None
    if ms != ms or ms in (float("inf"), float("-inf")):
        return None
    return ms


def clamp_rate(rate) -> float:
    """The playback rate to extrapolate with, defaulting to 1.0x when unusable."""
    try:
        value = float(rate)
    except (TypeError, ValueError):
        return 1.0
    if value != value or not (RATE_MIN <= value <= RATE_MAX):
        return 1.0
    return value


def never_updated(updated) -> bool:
    """True when ``last_updated_time`` is WinRT's 'never written' sentinel."""
    year = getattr(updated, "year", None)
    if year is None:
        return True
    return year <= NEVER_UPDATED_YEAR


@dataclass(frozen=True)
class TimelineSample:
    """One timeline reading, normalized to milliseconds from the item's origin."""
    start_ms: float | None = None
    end_ms: float | None = None
    duration_ms: float | None = None
    position_ms: float | None = None
    min_seek_ms: float | None = None
    max_seek_ms: float | None = None
    published: bool = False

    @property
    def seekable(self) -> bool:
        """Whether the player advertises a seekable range."""
        return bool((self.max_seek_ms or 0) > 0)


def normalize_timeline(start=None, end=None, position=None, updated=None,
                       min_seek=None, max_seek=None) -> TimelineSample:
    """Normalize one raw WinRT timeline reading.

    Every argument is optional because players populate different subsets. A
    value that cannot be read stays ``None`` — nothing is invented to fill a
    gap, and in particular a missing duration is reported as missing rather than
    as a plausible-looking number.
    """
    start_ms = to_ms(start)
    end_ms = to_ms(end)
    raw_position_ms = to_ms(position)
    min_seek_ms = to_ms(min_seek)
    max_seek_ms = to_ms(max_seek)

    origin = start_ms if start_ms is not None else 0.0

    duration_ms = None
    if end_ms is not None:
        candidate = end_ms - origin
        if candidate > 0:
            duration_ms = candidate

    position_ms = None
    if raw_position_ms is not None:
        position_ms = max(0.0, raw_position_ms - origin)

    published = bool(
        (duration_ms or 0) > 0
        or (position_ms or 0) > 0
        or (max_seek_ms or 0) > 0
        or not never_updated(updated)
    )

    return TimelineSample(
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=duration_ms,
        position_ms=position_ms,
        min_seek_ms=min_seek_ms,
        max_seek_ms=max_seek_ms,
        published=published,
    )


@dataclass
class PositionClock:
    """Turns repeated timeline samples into a continuously advancing position.

    ``observe`` is the only entry point: feed it the latest normalized sample
    position and the monotonic instant it was read, and it answers with the
    position to hand the UI *now*. It returns ``None`` when there is nothing
    honest to report.
    """
    session: object | None = None
    anchor_ms: float | None = None
    anchor_at: float = 0.0
    last_raw_ms: float | None = None
    playing: bool = False
    rate: float = 1.0
    duration_ms: float | None = None

    def reset(self, session: object | None = None) -> None:
        """Drop every anchor. Used on session change and after a seek."""
        self.session = session
        self.anchor_ms = None
        self.anchor_at = 0.0
        self.last_raw_ms = None
        self.playing = False
        self.rate = 1.0
        self.duration_ms = None

    def invalidate(self) -> None:
        """Make the next sample authoritative (after a command we sent)."""
        self.last_raw_ms = None

    def observe(self, raw_ms, now, *, playing, session=None, rate=None,
                duration_ms=None) -> float | None:
        if session is not self.session:
            # A different session object (replaced, or a different app) has its
            # own timeline: never extrapolate across that boundary.
            self.reset(session)

        self.playing = bool(playing)
        self.rate = clamp_rate(rate)
        self.duration_ms = duration_ms

        if raw_ms is None:
            # Nothing readable this tick. Keep the running clock alive — a
            # single failed read is not a pause — but do not invent a position
            # when there is no anchor to project from.
            if self.playing and self.anchor_ms is not None:
                return self._project(now)
            return None

        fresh = raw_ms != self.last_raw_ms
        self.last_raw_ms = raw_ms

        if not self.playing or fresh or self.anchor_ms is None:
            # Fresh player sample, first reading, or a state change: this is the
            # authoritative position, so anchor to it at *our* monotonic instant.
            self.anchor_ms = raw_ms
            self.anchor_at = now

        if not self.playing:
            # A paused player's snapshot does not advance; projecting it with a
            # wall clock was what made the playhead creep forward while paused.
            return max(0.0, raw_ms)
        return self._project(now)

    def _project(self, now) -> float | None:
        if self.anchor_ms is None:
            return None
        elapsed_ms = (now - self.anchor_at) * 1000.0
        if not (elapsed_ms > 0):
            elapsed_ms = 0.0
        if elapsed_ms > MAX_EXTRAPOLATION_MS:
            elapsed_ms = MAX_EXTRAPOLATION_MS
        position = self.anchor_ms + elapsed_ms * self.rate
        if self.duration_ms is not None and self.duration_ms > 0:
            position = min(position, self.duration_ms)
        return max(0.0, position)
