"""Pure media-session selection policy.

Kept separate from ``core.smtc`` on purpose: the policy needs no Windows
Runtime, so it can be unit-tested on any platform, and the I/O loop keeps only
the thin job of turning live sessions into descriptors and mapping the result
back. ``SmtcBridge`` owns the mutable conversation state (``pinned_app_id``,
``challenger_since``) and passes it in each tick.

Rules, in order:

1. A pinned session keeps the overlay while it exists **and is still the best
   thing to follow** — it is playing, or nothing else is playing. A pinned app
   that has gone idle no longer blocks a different, playing app: it relinquishes
   the pin and a challenger has to earn the handover, exactly as when there is
   no pin at all.
2. With no pin, a challenger must be the session we would follow for a quiet
   period before it is pinned. Until then we keep following whatever we were
   already following, so alt-tabbing through apps does not flick the lyrics.
"""

from __future__ import annotations

# An idle challenger must be the best candidate for this long before it may
# take the overlay (seconds).
HANDOVER_QUIET_S = 4.0


def select_session(descriptors, pinned_app_id, challenger_since, now,
                   quiet_s: float = HANDOVER_QUIET_S):
    """
    Choose which session the overlay should follow.

    ``descriptors`` is a list of dicts with keys:
      ``app_id``     stable identity of the source app (may be "")
      ``playing``    whether that session is currently playing
      ``is_current`` whether Windows considers it the current session
      ``in_current`` whether it is the session the bridge is already following
      (extra keys, e.g. the live session object, are ignored)

    Returns ``(chosen_app_id | None, pinned_app_id, challenger_since)``.
    """
    if not descriptors:
        return None, "", None

    def find(app_id):
        for d in descriptors:
            if d["app_id"] == app_id:
                return d
        return None

    pinned = find(pinned_app_id) if pinned_app_id else None
    if pinned is not None:
        others_playing = any(
            d["playing"] for d in descriptors if d["app_id"] != pinned_app_id
        )
        if pinned["playing"] or not others_playing:
            return pinned_app_id, pinned_app_id, None
        # The pinned app went idle while something else is playing. Relinquish
        # the pin and let the challenger rule below decide, instead of freezing
        # the overlay on a paused app for as long as its session lives.
        pinned_app_id = ""
    else:
        pinned_app_id = ""   # the pinned session is gone

    if len(descriptors) == 1:
        candidate = descriptors[0]
    else:
        playing = [d for d in descriptors if d["playing"]]
        current = next((d for d in descriptors if d["is_current"]), None)
        # A playing session outranks Windows' notion of "current" when the
        # current one is idle; otherwise honour current, then fall back to the
        # first playing session, then to whatever is left.
        if current is not None and (current["playing"] or not playing):
            candidate = current
        elif playing:
            candidate = playing[0]
        else:
            candidate = current or descriptors[0]

    app_id = candidate["app_id"]
    if challenger_since and challenger_since[0] == app_id \
            and now - challenger_since[1] >= quiet_s:
        return app_id, app_id, None
    if not challenger_since or challenger_since[0] != app_id:
        challenger_since = (app_id, now)

    # Keep following the current session while the challenger earns the handover.
    held = next((d for d in descriptors if d["in_current"]), None)
    if held is not None:
        return held["app_id"], pinned_app_id, challenger_since
    return app_id, pinned_app_id, challenger_since
