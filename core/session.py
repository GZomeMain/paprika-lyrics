"""Pure media-session selection policy.

Kept separate from ``core.smtc`` on purpose: the policy needs no Windows
Runtime, so it can be unit-tested on any platform, and the I/O loop keeps only
the thin job of turning live sessions into descriptors and mapping the result
back. ``SmtcBridge`` owns the mutable conversation state (``pinned_key``,
``challenger_since``) and passes it in each tick.

**Identity.** WinRT hands back a *fresh Python wrapper* for the same media
session on every ``get_sessions()`` call, so ``is`` and ``==`` against a session
from a previous tick are always False. The previous policy compared them and
therefore never saw Windows' current session, never recognised the session it
was already following, and — because two browser tabs share one
``SourceAppUserModelId`` — could end up following a *paused* tab while the other
one played. Sessions are identified here by a ``key`` the bridge computes from
what a session actually reports: the app id plus the media title it is playing.
That distinguishes two tabs of the same browser, and it is stable for exactly as
long as the decision has to hold (a session showing the same track).

Rules, in order:

1. A pinned session that is still playing keeps the overlay. This is what stops
   a second player starting up from stealing the lyrics mid-song.
2. A pinned session that has gone idle keeps the overlay while nothing else is
   playing — the lyrics stay on the song the user last listened to.
3. If the pinned session is gone entirely, the best available session takes over
   immediately: there is nothing on screen worth protecting.
4. If the pinned session is idle and something else is playing, that challenger
   has to be the best available session for a quiet period before it may take
   over, so a blip or a transient tab switch cannot flick the lyrics.
"""

from __future__ import annotations

# A challenger must be the best candidate for this long before it may take the
# overlay (seconds).
HANDOVER_QUIET_S = 4.0


def _best(descriptors, prefer_app: str = ""):
    """The session to follow out of a set: playing first, then same-app, then first.

    A playing session outranks an idle one. Among equals the app the overlay is
    already following wins, because a second tab of the same browser is a
    continuation of what the user is listening to, while another app is a
    context switch.
    """
    playing = [d for d in descriptors if d["playing"]]
    pool = playing if playing else descriptors
    if prefer_app:
        for d in pool:
            if d.get("app_id") == prefer_app:
                return d
    return pool[0]


def select_session(descriptors, pinned_key, challenger_since, now,
                   pinned_app_id: str = "", quiet_s: float = HANDOVER_QUIET_S,
                   locked_key: str | None = None):
    """
    Choose which session the overlay should follow.

    ``descriptors`` is a list of dicts with keys:

      ``key``      stable identity of this *session* (app id + what it plays)
      ``app_id``   stable identity of the source app (shared by its sessions)
      ``playing``  whether that session is currently playing

    (extra keys, e.g. the live session object, are ignored.)

    If ``locked_key`` is specified, it overrides automatic handover arbitration
    and forces the overlay to adhere to the requested session (matching either
    exact session key or source app_id), even while multiple other apps are playing.

    Returns ``(chosen_key | None, pinned_key, challenger_since)``.
    """
    if not descriptors:
        return None, "", None

    # Manual lock overrides automatic arbitration and forces the overlay to keep the chosen session
    if locked_key:
        match = next((d for d in descriptors
                      if d["key"] == locked_key or d.get("app_id") == locked_key), None)
        if match:
            return match["key"], match["key"], None

    pinned = (next((d for d in descriptors if d["key"] == pinned_key), None)
              if pinned_key else None)
    prefer_app = pinned["app_id"] if pinned is not None else (pinned_app_id or "")

    # 1 & 2: a live pin keeps the overlay unless something else is playing.
    if pinned is not None:
        if pinned["playing"]:
            return pinned["key"], pinned["key"], None
        others_playing = [d for d in descriptors
                          if d["playing"] and d["key"] != pinned["key"]]
        if not others_playing:
            return pinned["key"], pinned["key"], None
        candidate = _best(others_playing, prefer_app)
        # 4: the challenger must earn the handover. The pin stays on screen
        # (still pinned, so the check above keeps firing) until it has.
        if challenger_since is not None and challenger_since[0] == candidate["key"]:
            if now - challenger_since[1] >= quiet_s:
                return candidate["key"], candidate["key"], None
        else:
            challenger_since = (candidate["key"], now)
        return pinned["key"], pinned["key"], challenger_since

    # 3: no live pin — take the best session right away.
    candidate = _best(descriptors, prefer_app)
    return candidate["key"], candidate["key"], None
