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

**Liveness.** ``published`` is decided by the *values*: a duration, a position or
a seekable range is a position report, and none of them is a player saying
nothing. A player that has never published a timeline leaves every field at zero
*and* ``last_updated_time`` at WinRT's "never updated" sentinel
(1601-01-01T00:00:00Z), but the sentinel is not what decides it — measured on a
real player, a seek zeroed the whole timeline (start, end, position and both seek
bounds) while leaving a *live* write time, for as long as it stayed paused.
Reading that as "the song is at 0:00" reset the overlay to the top of the track
and threw away its length.

**The snapshot problem.** A GSMTC ``position`` is not a live value: it is the
position *at the instant the player wrote it*, and players write it at wildly
different rates — every frame, every second, only on a seek. Reading that number
and calling it "now" is the single largest source of sync error in this app: a
browser that republishes every four seconds makes the lyrics four seconds late,
and a player that republishes continuously makes them jitter with every read.
``sample_age_ms`` recovers the write instant from ``last_updated_time`` so a
snapshot can be aged forward to the present before it is believed — always, not
just on the first read, because a player that republishes rarely is exactly the
one whose snapshots spend most of their life being old.

**The clock.** ``PositionClock`` turns those corrected snapshots into a
continuously advancing position and classifies what it sees:

* a play/pause transition re-anchors without treating the gap as elapsed audio,
  which is what used to teleport the lyrics up to five seconds forward after a
  pause — and a RESUME ages the snapshot the player wrote when it resumed, so the
  overlay starts where the audio actually is instead of one poll behind it;
* a residual inside ``DEADBAND_MS`` is noise and is ignored, so a jittery or
  second-quantized player cannot make the highlight shimmer;
* a residual up to ``DISCONTINUITY_MS`` is drift and is absorbed, reported as a
  correction the UI is free to ease into;
* anything larger is a real move — a seek, a skip, a stall recovering — and is
  reported as a discontinuity the UI must land on; * between snapshots the position is projected forward, but only for as long as
  the evidence justifies: the player's own refresh cadence once it has shown
  one, and — before that — whether its snapshot can be dated at all. A dated
  snapshot licenses the projection (a browser publishing every few seconds
  would otherwise freeze its lyrics mid-song), while an undated one leaves
  nothing but a number to run from, so the clock is held within
  ``MAX_GRACE_MS`` of it. Past the bound the audio may have stopped progressing
  (buffering, a detached tab) and holding the last known position beats running
  ahead and snapping back.
"""
from __future__ import annotations

import datetime
from dataclasses import dataclass

# WinRT's default timestamp before anything has been written to it.
NEVER_UPDATED_YEAR = 1700

# A residual below this is measurement noise, not sync error. Correcting it
# would make the timeline shimmer without teaching it anything.
DEADBAND_MS = 90.0
# Beyond this the playhead did not drift, it MOVED: a seek, a player-side skip,
# or a resume after a long stall. That is a discontinuity to land on, never a
# correction to glide through the rest of the song to reach.
DISCONTINUITY_MS = 1500.0

# How far past the last snapshot the clock may run, learned from how often the
# player actually refreshes. A player that republishes every 4 seconds needs a
# long leash; one that republishes every frame is stalled 1.5 seconds in.
MIN_CADENCE_MS = 200.0
MAX_CADENCE_MS = 6000.0
MIN_GRACE_MS = 1500.0
MAX_GRACE_MS = 12000.0
GRACE_FACTOR = 2.0
GRACE_EXTRA_MS = 500.0

# A seek we sent: the player keeps reporting the pre-seek position for a moment,
# and obeying that echo snaps the lyrics back to where they came from. Samples
# that disagree with the target are ignored until the player agrees or this long
# has passed.
SEEK_TOLERANCE_MS = 1500.0
SEEK_TIMEOUT_S = 3.0

# The most a resume may be carried forward by. A resume is only ever noticed a
# poll after it happened, so the interval since the last reading that still saw
# playback stopped is real evidence — but it is bounded, because a pause whose
# timeline went quiet for minutes leaves that reading minutes old, and crediting
# all of it would fling the lyrics forward by the length of the pause. Two polls
# at the bridge's own cadence is enough to cover the interval that is ever
# genuinely recoverable.
MAX_RESUME_CREDIT_MS = 600.0

# Sanity bounds on a reported write time. A timestamp from the far future is a
# skewed clock, not information, and one from hours ago says nothing about the
# track that is playing now.
MAX_SAMPLE_AGE_MS = 60_000.0

# Two readings closer together than this are the same reading. WinRT positions
# are 100-nanosecond ticks and players round them differently every time (a
# resumed track republishes the position it was paused at, often to the last
# bit), so comparing exactly made a repeat look like news.
FRESH_EPSILON_MS = 1.0


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
    if value != value or not (0.05 <= value <= 4.0):
        return 1.0
    return value


def never_updated(updated) -> bool:
    """True when ``last_updated_time`` is WinRT's 'never written' sentinel."""
    year = getattr(updated, "year", None)
    if year is None:
        return True
    return year <= NEVER_UPDATED_YEAR


def sample_age_ms(updated_at, now_utc) -> float | None:
    """How long ago the player wrote this snapshot, or None when it did not say.

    ``last_updated_time`` is a UTC ``datetime`` — the wall clock at which the
    player published the position — so the age is a subtraction, not a count of
    ticks. Neither a sentinel ("never written"), an unusable value, nor a clock
    that runs ahead of ours produces a usable age, and the caller then falls back
    to treating the read instant as the write instant.
    """
    if updated_at is None or now_utc is None or never_updated(updated_at):
        return None
    try:
        age_s = (now_utc - updated_at).total_seconds()
    except Exception:
        return None
    if age_s != age_s:
        return None
    if age_s < -0.5:
        # The player's clock is ahead of ours by more than rounding. Its own
        # timestamp is then not evidence of anything; use the read instant.
        return None
    if age_s * 1000.0 > MAX_SAMPLE_AGE_MS:
        return None
    return max(0.0, age_s * 1000.0)


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
    # The raw ``last_updated_time``, kept so the caller can age the snapshot with
    # ``sample_age_ms``. Normalization does not try to be clever about it: the
    # wall clock is only comparable to another wall clock.
    updated_at: object | None = None

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

    # A duration, a position or a seekable range is the player saying where
    # playback is; a write time on its own is not, and an all-zero timeline with a
    # live write time means the player has no position state right now (see the
    # module docstring — that is what a seek leaves behind on a browser player).
    published = bool(
        (duration_ms or 0) > 0
        or (position_ms or 0) > 0
        or (max_seek_ms or 0) > 0
    )

    return TimelineSample(
        start_ms=start_ms,
        end_ms=end_ms,
        duration_ms=duration_ms,
        position_ms=position_ms,
        min_seek_ms=min_seek_ms,
        max_seek_ms=max_seek_ms,
        published=published,
        updated_at=updated,
    )


@dataclass(frozen=True)
class Reading:
    """One answer from the playhead clock: where playback is, right now.

    ``discontinuity`` means the position moved somewhere the UI has to land on
    rather than glide through; ``correction_ms`` is the residual that was folded
    in (kept for diagnostics — it is what a bug report needs to explain a
    visible jump).
    """
    position_ms: float | None
    discontinuity: bool = False
    correction_ms: float = 0.0
    # How far the position MOVED when this reading is a discontinuity, or None
    # when it is not a move at all (the first reading of a session or track). The
    # bridge classifies on this rather than on ``correction_ms``: a size is a
    # fact, while a residual is only comparable against the estimate it was
    # measured from.
    jump_ms: float | None = None
    # True when the position is a pure forward projection from a sample the
    # player has NOT refreshed — the clock's answer while a player is quiet or
    # has blanked its timeline. It is the best estimate available, but it is not
    # a correction: the bridge labels it ``hold`` so the UI keeps its own 1x
    # projection instead of being dragged back to a parked number on every poll
    # (see ui/app.js window.syncPlayhead). Without that label a parked reading
    # was sent as ordinary drift, and obeying it rewound the wipe over letters it
    # had already sung — the reported "lyrics loop on a few letters".
    held: bool = False


@dataclass
class PositionClock:
    """Turns repeated player snapshots into a continuously advancing position.

    ``observe`` is the only entry point: feed it the latest normalized sample
    position, the monotonic instant it was read, and what the player says about
    playback, and it answers with the position to hand the UI *now*.

    Deliberately holds no session reference. WinRT hands back a fresh Python
    wrapper for the same media session on every ``get_sessions()`` call, so
    comparing ``is`` against the previous tick's object is always False — the
    clock used to reset itself every single tick because of exactly that, which
    silently disabled every projection it exists to make. Session identity is
    the bridge's business (it knows when the session or track really changed)
    and it calls ``reset`` explicitly.
    """
    anchor_ms: float | None = None
    anchor_at: float = 0.0
    playing: bool = False
    rate: float = 1.0
    duration_ms: float | None = None
    last_raw_ms: float | None = None
    cadence_ms: float | None = None
    # Whether the newest snapshot came with a usable write time. A position we
    # can date says *when* the audio was there, which is what licenses running
    # the playhead forward from it; one we cannot is a number, not a rate.
    last_sample_dated: bool = False
    first_reading: bool = True
    # The last position the player actually SAID (and when): the leash in
    # ``_project`` is measured from here rather than from the anchor, which can be
    # older than the newest snapshot.
    verified_ms: float | None = None
    verified_at: float | None = None
    # The instant of the last reading taken while the clock was PAUSED. A resume
    # is only ever discovered after the fact, so this is the last moment playback
    # was known to be stopped — and therefore the earliest the resumed audio can
    # have started moving again. Refreshed on every paused reading, in both
    # directions (observe and note_playing), precisely so a long quiet pause
    # cannot leave it stale and be credited as elapsed audio.
    paused_at: float | None = None
    # (target_ms, deadline, pre_seek_value) while a seek we sent is still being
    # acknowledged.
    pending_seek: tuple[float, float, float | None] | None = None

    # ---------------------------------------------------------------- state
    def reset(self) -> None:
        """Drop every anchor. Used when the session or the track really changes."""
        self.anchor_ms = None
        self.anchor_at = 0.0
        self.playing = False
        self.rate = 1.0
        self.duration_ms = None
        self.last_raw_ms = None
        self.cadence_ms = None
        self.last_sample_dated = False
        self.first_reading = True
        self.verified_ms = None
        self.verified_at = None
        self.paused_at = None
        self.pending_seek = None

    def note_playing(self, playing: bool, now: float) -> None:
        """Record a playback transition that arrived without a readable sample.

        A player that publishes no timeline while paused would otherwise leave
        the clock believing it had been playing the whole time, and the first
        snapshot after the resume would then be projected forward by the length
        of the pause — the exact teleport this clock exists to prevent. The
        estimate itself is carried across the transition; only the instant it is
        measured from moves.

        Resuming goes through ``_resume_estimate`` rather than keeping the parked
        position, for the same reason ``observe`` does: this edge is reported a
        poll after it happened, and parking at the pause point as of NOW is what
        left the wipe a poll behind the audio after every unpause.
        """
        playing = bool(playing)
        if playing == self.playing:
            if not playing:
                # Still paused, still nothing readable. Keep the resume leash
                # moving with the polls: a pause that goes quiet for minutes must
                # not hand the eventual resume a minutes-old starting point to
                # credit elapsed audio from.
                self.paused_at = now
            return
        position = self._resume_estimate(now) if playing else self._project(now)
        self.playing = playing
        if not playing:
            self.paused_at = now
        if position is not None:
            self.anchor_ms, self.anchor_at = position, now
            self.verified_ms, self.verified_at = position, now
        else:
            self.anchor_at = now

    def note_seek(self, target_ms: float, now: float) -> None:
        """Record a seek we just sent, so the player's echo cannot undo it.

        The player needs a moment to act, and until it does every position it
        reports is the pre-seek one. Our own estimate moves to the target
        immediately — that is where the user asked to be, and the UI has already
        drawn it there — and contradicting samples are ignored until the player
        catches up (``SEEK_TOLERANCE_MS``) or the wait times out.
        """
        self.anchor_ms = float(target_ms)
        self.anchor_at = float(now)
        self.verified_ms = float(target_ms)
        self.verified_at = float(now)
        self.pending_seek = (float(target_ms), float(now) + SEEK_TIMEOUT_S,
                             self.last_raw_ms)
        # A snapshot taken before the seek must not be mistaken for a fresh one.
        self.last_raw_ms = None

    def cancel_seek(self) -> None:
        """Forget a seek the player refused, so its position is believed again."""
        self.pending_seek = None

    def grace_ms(self) -> float | None:
        """How far the clock may run past the last snapshot, or None if unbounded.

        A cadence the player has actually shown is the honest bound. Before that,
        it comes down to whether its snapshot can be dated: one that arrived with
        a usable write time says when the audio was there, which is exactly what
        licenses running forward from it — and a player that stamps its timeline
        is one whose silence has to be believed, because a browser publishing
        every few seconds would otherwise freeze its lyrics mid-song. One that
        could not be dated (a player that never stamps, or has not written
        anything for a minute) leaves nothing but a number, and the lyrics are
        not run more than ``MAX_GRACE_MS`` past it on that.
        """
        if self.cadence_ms is not None:
            return min(MAX_GRACE_MS,
                       max(MIN_GRACE_MS,
                           self.cadence_ms * GRACE_FACTOR + GRACE_EXTRA_MS))
        return None if self.last_sample_dated else MAX_GRACE_MS

    # ---------------------------------------------------------------- observe
    def observe(self, raw_ms, now, *, playing, rate=None, duration_ms=None,
                sample_age_ms=None, quantized_ms: float = 0.0) -> Reading:
        """Fold one player snapshot into the running position.

        ``raw_ms`` is the sample's position in ms (``None`` when unreadable),
        ``now`` our monotonic instant, ``sample_age_ms`` how long ago the player
        wrote that position (``None`` when it did not say), and ``quantized_ms``
        the width of a position bucket the source cannot resolve (VLC reports
        whole seconds), in which case the sample is a range rather than a point.
        """
        playing = bool(playing)
        was_playing = self.playing
        # A transition only means something once there is an estimate to carry
        # across it; the first reading of a track is not one.
        transition = (playing != was_playing and self.anchor_ms is not None)
        # The estimate as it stands a moment ago, with the transport state this
        # reading is about to replace: a pause freezes where playback actually
        # was, which is where the *previous* state would have taken it.
        prior = self._project(now)
        self.playing = playing
        # Every reading taken while stopped refreshes the resume leash, and one
        # taken while playing must not: see _resume_estimate.
        if not playing:
            self.paused_at = now
        self.rate = clamp_rate(rate)
        if duration_ms is not None:
            self.duration_ms = duration_ms

        if self.pending_seek is not None:
            target, deadline, pre_seek = self.pending_seek
            if raw_ms is not None and abs(raw_ms - target) <= SEEK_TOLERANCE_MS:
                self.pending_seek = None          # the player landed where we asked
            elif (not playing and raw_ms is not None and raw_ms != pre_seek):
                # Paused, and the player published something other than the
                # position it was frozen at: that is its answer about where the
                # seek landed, even when it is not the target. A paused echo
                # never changes, so this cannot mistake one for an answer.
                self.pending_seek = None
            elif playing and now >= deadline:
                # Playing: the echo advances, so only time can tell us that the
                # player is never going to honour the seek.
                self.pending_seek = None
            else:
                # The player's pre-seek echo: a projection of where we already
                # sent the playhead, not news. Hold, so the UI cannot be walked
                # back off the seek it just drew.
                return Reading(position_ms=self._project(now), held=True)

        if raw_ms is None:
            # Nothing readable this tick. Keep the running clock alive — a single
            # failed read is not a pause — but do not invent a position when
            # there is no anchor to project from.
            if self.playing and self.anchor_ms is not None:
                # Nothing readable, but playback is believed to be running. The
                # projection is the best estimate there is and it is leashed
                # (see grace_ms); it is still not a correction.
                return Reading(position_ms=self._project(now), held=True)
            return Reading(position_ms=None)

        implied, window = self._implied_position(
            raw_ms, now, sample_age_ms, quantized_ms)
        self.last_sample_dated = sample_age_ms is not None
        fresh = (self.last_raw_ms is None
                 or abs(raw_ms - self.last_raw_ms) > FRESH_EPSILON_MS)
        self.last_raw_ms = raw_ms

        if self.anchor_ms is None:
            # First reading of a session or a track: there is nothing to compare
            # against, so the player's own number is the position, aged to now.
            self._anchor(implied, now)
            discontinuity = self.first_reading
            self.first_reading = False
            return Reading(position_ms=implied, discontinuity=discontinuity)

        if transition:
            # A play/pause edge, and the two directions need different answers.
            #
            # PAUSING: a snapshot the player wrote with the stop position is the
            # truth; with nothing new to read, our own estimate is better evidence
            # than the snapshot it left behind, and that estimate ran to this
            # instant. Either way the parked position is where playback stopped,
            # and paused time is never projected as elapsed audio.
            #
            # RESUMING: a snapshot the player stamped as it restarted is aged to
            # now (see _implied_position), so it is the truth as well. With
            # nothing new to read, the pause point is carried forward by the
            # interval playback is known to have restarted inside —
            # _resume_estimate. Both resume paths exist for one reason: the resume
            # is discovered a poll after it happened, and parking at the pause
            # point as of NOW silently throws that poll away, which is the "slight
            # delay" after every unpause.
            if was_playing:
                keep = implied if fresh else prior
            elif fresh and self.last_sample_dated:
                keep = implied
            else:
                keep = self._resume_estimate(now)
            self._anchor(keep, now)
            return Reading(position_ms=keep)

        if not self.playing:
            # Paused: the position does not advance, so there is nothing to
            # project — and nothing to correct to unless the player published
            # something new. Dragging the lyrics back to a snapshot written
            # before the pause is what made a pause look like a seek.
            if fresh:
                self._anchor(implied, now)
                # A paused move is not drift to ease into: the wipe is frozen
                # and has no sweep to hide a glide in, so the UI must land on
                # it now. Without this a scrub of the player's own timeline
                # while paused (or a seek that landed while paused) arrived as
                # "soft", and the UI only repaints its words on a snap — the
                # timer moved, the lyric highlight waited for the next
                # pause/resume edge. Noise under the deadband still returns
                # plain so jitter cannot repaint the words twice a second.
                moved = implied - (prior if prior is not None else implied)
                if abs(moved) > DEADBAND_MS:
                    return Reading(position_ms=self._project(now),
                                   discontinuity=True,
                                   correction_ms=moved,
                                   jump_ms=abs(moved))
            # Paused: the frozen anchor IS the truth, so this is not a hold.
            return Reading(position_ms=self._project(now))

        if not fresh:
            # A snapshot we have already seen: the player has not refreshed, so
            # there is nothing new to compare against. Keep projecting — bounded
            # by the leash once this player has shown a cadence, so a player that
            # stops moving cannot drag the lyrics ahead of the audio.
            return Reading(position_ms=self._project(now), held=True)

        self._note_cadence(now)

        estimate = self._project(now)
        residual = self._residual(estimate, implied, window)
        if abs(residual) <= DEADBAND_MS:
            # Sub-frame noise. Leave the trajectory alone — but the snapshot is
            # still the newest thing the player said, so the leash starts here.
            self._verified(estimate, now)
            return Reading(position_ms=estimate)

        discontinuity = abs(residual) > DISCONTINUITY_MS
        target = implied if window is None else _nearest_in_window(estimate, window)
        self._anchor(target, now)
        return Reading(position_ms=target, discontinuity=discontinuity,
                       correction_ms=residual,
                       jump_ms=abs(residual) if discontinuity else None)

    # ---------------------------------------------------------------- helpers
    def _anchor(self, position_ms, now) -> None:
        """Make this position the new trajectory, and the new leash origin."""
        self.anchor_ms, self.anchor_at = position_ms, now
        self._verified(position_ms, now)

    def _verified(self, position_ms, now) -> None:
        """Remember the newest position the player actually reported."""
        self.verified_ms, self.verified_at = position_ms, now

    def _resume_estimate(self, now) -> float | None:
        """Where playback is, per the last reading that still saw it stopped.

        A resume is only ever noticed after the fact: the player was still paused
        at the last reading, so the audio restarted somewhere between then and
        this poll. Keeping the parked position as of NOW throws that whole
        interval away — the wipe then sits up to a poll behind the audio and only
        closes the gap as the player's later snapshots drift it forward, which is
        the small delay after every unpause. Crediting the interval is the best
        available estimate: exact for a resume taken straight after that reading,
        an overshoot of at most one poll for one taken just before this poll, and
        half a poll on average. ``MAX_RESUME_CREDIT_MS`` bounds it so an
        unrefreshed pause cannot be credited as elapsed audio.
        """
        if self.anchor_ms is None:
            return self.anchor_ms
        if self.paused_at is None:
            return self.anchor_ms
        credit_ms = max(0.0, (now - self.paused_at) * 1000.0)
        credit_ms = min(credit_ms, MAX_RESUME_CREDIT_MS)
        return self.anchor_ms + credit_ms * self.rate

    def _implied_position(self, raw_ms, now, sample_age_ms, quantized_ms):
        """Where the playhead is now, per one snapshot, plus its window if coarse.

        Returns ``(implied_ms, window | None)``. The window is the range the
        source's resolution leaves open; for a point-like source it is None.

        The player's own write time is the only honest measure of how much audio
        has played since it wrote that position, and it is applied on *every*
        read: a browser republishing every few seconds needs exactly those
        seconds added back, whether it is the first read of a track (where
        ignoring them is what opened the lyrics seconds behind the song from the
        very first line) or the thousandth.

        A PAUSED clock ages nothing. A snapshot taken while paused describes the
        position playback is frozen at, so projecting it with the wall clock is
        what used to make the lyrics creep forward while paused and jump on the
        way out.

        A RESUME is the opposite case, and used to be handled as if it were the
        same one. The snapshot a player writes when it resumes says when the
        audio started moving again, so aging it recovers exactly the audio that
        elapsed between the resume and the poll that noticed it — a poll's worth
        of lag at the start of every resume, which the overlay otherwise had to
        ease away over the following second. Only a ``fresh`` snapshot ever
        reaches this on a resume: a player that does not republish hands back the
        value it was paused at, and the caller then keeps its own estimate rather
        than aging a pause-length-old snapshot by the length of the pause.
        """
        half = max(0.0, quantized_ms) / 2.0
        window = None
        if half > 0:
            lo, hi = raw_ms - half, raw_ms + half
            window = (lo, hi)
            implied = (lo + hi) / 2.0
        else:
            implied = float(raw_ms)

        if not self.playing or sample_age_ms is None:
            return implied, window

        age_ms = max(0.0, min(float(sample_age_ms), MAX_SAMPLE_AGE_MS))
        advance = age_ms * self.rate
        if window is None:
            return implied + advance, None
        return implied + advance, (window[0] + advance, window[1] + advance)

    def _residual(self, estimate, implied, window) -> float:
        """How far our trajectory is from the player's, ignoring a coarse bucket."""
        if window is not None:
            lo, hi = window
            if lo <= estimate <= hi:
                return 0.0
            return lo - estimate if estimate < lo else hi - estimate
        return implied - estimate

    def _note_cadence(self, now) -> None:
        """Learn how often this player actually moves its position."""
        if self.verified_at is None:
            interval_ms = None
        else:
            interval_ms = (now - self.verified_at) * 1000.0
        if interval_ms is None or not (MIN_CADENCE_MS <= interval_ms <= MAX_CADENCE_MS):
            # A gap longer than the leash says nothing about cadence: that was a
            # stall, a seek or a track change, not this player's refresh rate.
            return
        if self.cadence_ms is None:
            self.cadence_ms = interval_ms
        else:
            self.cadence_ms = 0.6 * self.cadence_ms + 0.4 * interval_ms

    def position_now(self, now=None):
        import time as _time
        return self._project(now if now is not None else _time.monotonic())

    def _project(self, now) -> float | None:
        """The playhead now: the trajectory, held in check by the leash (see grace_ms)."""
        if self.anchor_ms is None:
            return None
        if not self.playing:
            position = self.anchor_ms
        else:
            elapsed_ms = max(0.0, (now - self.anchor_at) * 1000.0)
            position = self.anchor_ms + elapsed_ms * self.rate
            grace_ms = self.grace_ms()
            if (grace_ms is not None and self.verified_at is not None
                    and self.verified_ms is not None):
                # The leash: never further than grace_ms of silence past the last
                # position the player actually reported. Measured from that
                # snapshot rather than from the anchor, which may be older — a
                # residual inside the deadband deliberately leaves the anchor
                # alone, and a leash measured from there would cut the lyrics off
                # mid-song.
                silence_ms = max(0.0, (now - self.verified_at) * 1000.0)
                leash_ms = min(silence_ms, grace_ms)
                position = min(position, self.verified_ms + leash_ms * self.rate)
        if self.duration_ms is not None and self.duration_ms > 0:
            position = min(position, self.duration_ms)
        return max(0.0, position)


def _nearest_in_window(value: float, window: tuple[float, float]) -> float:
    """The point of a coarse window closest to ``value``, clamped inside it."""
    lo, hi = window
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def utcnow() -> datetime.datetime:
    """UTC now, as a helper so callers do not each import datetime."""
    return datetime.datetime.now(datetime.timezone.utc)
