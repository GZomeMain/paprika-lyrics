"""Standalone GSMTC (Windows System Media Transport Controls) diagnostic.

Answers, with evidence, the questions the overlay cannot answer from inside its
own loop:

* Which media sessions exist, and which SourceAppUserModelId each reports?
* What does a session actually publish — playback status, playback rate,
  control flags, and the raw timeline (start / end / position / seek bounds /
  last-update time)?
* Do the ``try_*_async`` transport calls work for this player, and what do they
  return?
* Is the timeline live (does it move) or dead (all zeros and the WinRT
  "never updated" sentinel)?

The script is READ-ONLY by default: it enumerates sessions and prints state.
Playback is only changed by an explicit flag (``--play``, ``--pause``,
``--toggle``, ``--seek``), because a diagnostic that pauses the user's music on
startup is a bug, not a tool.

Run with the project's Python environment::

    python tools/smtc_diagnose.py                  # read-only survey
    python tools/smtc_diagnose.py --watch 8        # is the timeline moving?
    python tools/smtc_diagnose.py --app SimpMusic  # pick the target app
    python tools/smtc_diagnose.py --toggle         # explicit play/pause test
    python tools/smtc_diagnose.py --seek 30000     # explicit seek + read-back

Nothing here imports the app, so it can run while the overlay is running.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import sys

from winsdk.windows.media.control import (
    GlobalSystemMediaTransportControlsSessionManager as MediaManager,
)

# WinRT's default ("never updated") timestamp is 1601-01-01T00:00:00Z. A player
# that has never touched the timeline leaves it at exactly this value.
NEVER_UPDATED_YEAR = 1700
HANDLE_NAMES = (
    "start_time",
    "end_time",
    "position",
    "min_seek_time",
    "max_seek_time",
    "last_updated_time",
)


def app_id_of(session) -> str:
    try:
        return session.source_app_user_model_id or "<no app id>"
    except Exception as exc:  # pragma: no cover - defensive
        return f"<unreadable: {exc!r}>"


def status_name(playback) -> str:
    try:
        return str(playback.playback_status)
    except Exception as exc:  # pragma: no cover - defensive
        return f"<unreadable: {exc!r}>"


def as_ms(value):
    """Timedelta -> milliseconds, or None when the field is absent/unusable."""
    if value is None:
        return None
    try:
        return value.total_seconds() * 1000.0
    except Exception:
        return None


def as_ticks(value):
    """Timedelta -> 100-nanosecond ticks, i.e. what WinRT stores."""
    if value is None:
        return None
    try:
        return int(round(value.total_seconds() * 10_000_000))
    except Exception:
        return None


def fmt(value) -> str:
    if isinstance(value, datetime.timedelta):
        return (f"{value} ({as_ms(value):.3f} ms, {as_ticks(value)} ticks)"
                if as_ms(value) is not None else str(value))
    if isinstance(value, datetime.datetime):
        return value.isoformat() + ("" if value.year > NEVER_UPDATED_YEAR
                                    else "   <-- WinRT 'never updated' sentinel")
    return repr(value)


def describe_controls(playback) -> str:
    try:
        controls = playback.controls
    except Exception as exc:  # pragma: no cover - defensive
        return f"<unreadable: {exc!r}>"
    if controls is None:
        return "<none>"
    flags = (
        "is_play_pause_toggle_enabled",
        "is_play_enabled",
        "is_pause_enabled",
        "is_next_enabled",
        "is_previous_enabled",
        "is_fast_forward_enabled",
        "is_rewind_enabled",
        "is_stop_enabled",
    )
    return ", ".join(
        f"{name.removeprefix('is_').removesuffix('_enabled')}="
        f"{bool(getattr(controls, name, False))}"
        for name in flags
    )


def request_manager():
    return MediaManager.request_async()


def pick(manager, needle: str):
    sessions = list(manager.get_sessions())
    if not needle:
        return sessions, manager.get_current_session()
    lowered = needle.lower()
    matches = [s for s in sessions if lowered in app_id_of(s).lower()]
    if not matches:
        return sessions, None
    current = manager.get_current_session()
    for s in matches:
        if s is current:
            return sessions, s
    return sessions, matches[0]


def report_sessions(manager, needle: str):
    sessions = list(manager.get_sessions())
    current = manager.get_current_session()
    print(f"sessions: {len(sessions)}")
    for s in sessions:
        marker = "  <-- current" if s is current else ""
        print(f"  {app_id_of(s)!r}{marker}")
    return sessions


def report_session(session, label: str):
    print(f"\n=== {label}: {app_id_of(session)!r}")

    playback = session.get_playback_info()
    print(f"playback_status : {status_name(playback)}")
    try:
        rate = playback.playback_rate
    except Exception:
        rate = None
    print(f"playback_rate   : {rate!r}"
          f"{'   <-- absent: extrapolation must assume 1.0x' if rate is None else ''}")
    try:
        print(f"playback_type   : {playback.playback_type}")
        print(f"shuffle/repeat  : {bool(playback.is_shuffle_active)} / "
              f"{playback.auto_repeat_mode}")
    except Exception as exc:  # pragma: no cover - defensive
        print(f"playback extras : <unreadable: {exc!r}>")
    print(f"controls        : {describe_controls(playback)}")

    timeline = session.get_timeline_properties()
    if timeline is None:
        print("timeline        : <None>")
    else:
        for name in HANDLE_NAMES:
            print(f"  {name:<16}: {fmt(getattr(timeline, name, None))}")
        end_ms, start_ms = as_ms(timeline.end_time), as_ms(timeline.start_time)
        if end_ms is not None and start_ms is not None:
            print(f"  -> duration (end - start)         : "
                  f"{end_ms - start_ms:.3f} ms")
            print(f"  -> elapsed  (position - start)    : "
                  f"{(as_ms(timeline.position) or 0.0) - start_ms:.3f} ms")
        updated = getattr(timeline, "last_updated_time", None)
        if getattr(updated, "year", 0) <= NEVER_UPDATED_YEAR:
            print("  !! last_updated_time is the WinRT sentinel: this player has "
                  "never published a timeline update.")
    return playback, timeline


def snapshot(session):
    """(position_ms, end_ms, last_updated) for movement detection."""
    try:
        timeline = session.get_timeline_properties()
    except Exception:
        return None
    if timeline is None:
        return None
    return (as_ms(timeline.position), as_ms(timeline.end_time),
            getattr(timeline, "last_updated_time", None))


async def watch(session, seconds: float, interval: float = 1.0,
                label: str = "watching timeline"):
    print(f"\n--- {label} for {seconds:.0f}s (interval {interval}s)")
    first = None
    moved = False
    steps = max(1, int(seconds / interval))
    for i in range(steps):
        snap = snapshot(session)
        if first is None:
            first = snap
        elif snap != first:
            moved = True
        playback = session.get_playback_info()
        print(f"  t={i * interval:5.1f}s  status={status_name(playback):<8} "
              f"pos={snap[0] if snap else None}  end={snap[1] if snap else None}")
        await asyncio.sleep(interval)
    print("timeline moved during the watch: "
          f"{'YES' if moved else 'NO — all readings identical'}")
    return moved


async def metadata(session):
    print("\n--- media properties")
    try:
        props = await session.try_get_media_properties_async()
    except Exception as exc:
        print(f"  try_get_media_properties_async raised {exc!r}")
        return
    if props is None:
        print("  <None>")
        return
    for name in ("title", "artist", "album_title", "subtitle", "track_number",
                 "playback_type"):
        print(f"  {name:<14}: {getattr(props, name, None)!r}")


async def call(label, coro):
    """Awaits a transport call and prints what it returned / raised."""
    try:
        result = await coro
    except Exception as exc:
        print(f"  {label:<34} raised {exc!r}")
        return None
    print(f"  {label:<34} returned {result!r}")
    return result


async def transport_tests(session, args):
    print("\n--- explicit transport tests (these CHANGE playback)")
    print(f"  before: status={status_name(session.get_playback_info())} "
          f"pos={snapshot(session)[0] if snapshot(session) else None}")

    if args.toggle:
        await call("try_play_pause_async()",
                   session.try_toggle_play_pause_async())
        await asyncio.sleep(1.0)
        print(f"    after: status={status_name(session.get_playback_info())}")
        await call("try_play_pause_async() [restore]",
                   session.try_toggle_play_pause_async())
        await asyncio.sleep(0.5)

    if args.pause:
        await call("try_pause_async()", session.try_pause_async())
        await asyncio.sleep(1.0)
        print(f"    after: status={status_name(session.get_playback_info())}")

    if args.play:
        await call("try_play_async()", session.try_play_async())
        await asyncio.sleep(1.0)
        print(f"    after: status={status_name(session.get_playback_info())}")

    if args.seek is not None:
        target_ms = float(args.seek)
        print(f"  seek target: {target_ms:.0f} ms "
              f"({target_ms * 10_000:.0f} ticks, 1 ms = 10,000 100ns units)")
        if args.seek_as_timedelta:
            value = datetime.timedelta(milliseconds=target_ms)
            print(f"  argument form: datetime.timedelta {value!r}")
        else:
            value = int(target_ms * 10_000)
            print(f"  argument form: int ticks {value}")
        before = snapshot(session)[0] if snapshot(session) else None
        await call("try_change_playback_position_async()",
                   session.try_change_playback_position_async(value))
        await asyncio.sleep(1.0)
        after = snapshot(session)
        print(f"    position before={before} after={after[0] if after else None}")
        if after and after[0] is not None and before is not None:
            landed = abs(after[0] - target_ms) < 2500 or (after[0] == before)
            print("    read-back: "
                  + ("position moved near the target (units correct)"
                     if abs((after[0] or 0) - target_ms) < 2500
                     else "position did NOT land on the target"
                     if after[0] != before
                     else "position unchanged — player ignored the seek, or it "
                          "publishes no timeline to read back"))
        else:
            print("    read-back impossible: this player publishes no timeline.")


async def amain(args) -> int:
    try:
        manager = await request_manager()
    except Exception as exc:
        print(f"ERROR: could not reach the Windows media manager: {exc!r}")
        return 2

    sessions = report_sessions(manager, args.app)

    if args.list_only:
        return 0

    if not sessions:
        print("\nNo media sessions exist. Start a player first.")
        return 1

    session = None
    if args.app:
        _, session = pick(manager, args.app)
        if session is None:
            print(f"\nNo session matching {args.app!r}.")
            return 1
    else:
        session = manager.get_current_session()
        if session is None:
            print("\nWindows reports no current session; pass --app to choose one.")
            return 1
        print(f"\nNo --app given; using Windows' current session: "
              f"{app_id_of(session)!r}")

    report_session(session, "target session")
    await metadata(session)

    if args.watch:
        await watch(session, args.watch, args.interval)

    if args.toggle or args.pause or args.play or args.seek is not None:
        await transport_tests(session, args)
        if args.watch_after:
            await watch(session, args.watch_after, args.interval,
                        label="watching AFTER the transport tests")
    else:
        print("\n(playback untouched — pass --toggle/--play/--pause/--seek to test)")

    return 0


# ---------------------------------------------------------------------------
# Bridge mode: drive the overlay's OWN code path against the live session.
# This is the decisive overlay-vs-upstream test. Nothing in it changes playback
# unless an explicit transport flag is passed; the loop itself only reads.
# ---------------------------------------------------------------------------

class RecordingWindow:
    """Stands in for the pywebview window and records what the bridge pushes."""

    def __init__(self):
        self.calls = []

    def evaluate_js(self, script):
        self.calls.append(script)


def bridge_position_probe(bridge):
    """What the overlay's read path returns for the live session right now."""
    try:
        return bridge._get_position_ms()
    except Exception as exc:
        return f"<raised {exc!r}>"


def bridge_duration_probe(bridge):
    try:
        return bridge._get_duration_ms()
    except Exception as exc:
        return f"<raised {exc!r}>"


def bridge_mode(args) -> int:
    import os
    import threading
    import time

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if root not in sys.path:
        sys.path.insert(0, root)
    try:
        from core.smtc import SmtcBridge
    except Exception as exc:
        print(f"ERROR: could not import the overlay's bridge: {exc!r}")
        return 2

    shutdown = threading.Event()
    bridge = SmtcBridge(shutdown)
    window = RecordingWindow()
    thread = threading.Thread(target=bridge.start, args=(window,), daemon=True)
    thread.start()

    print(f"\n=== overlay bridge running (settling {args.bridge:.0f}s)")
    time.sleep(args.bridge)

    session = bridge.current_session
    print(f"current_session      : {app_id_of(session) if session else None}")
    print(f"pinned_app_id        : {bridge.pinned_app_id!r}")
    print(f"event_loop running   : "
          f"{bool(bridge.event_loop and bridge.event_loop.is_running())}")
    if session is None:
        print("!! the bridge has NO session: every transport call will be dropped.")
        print("   (VLC fallback configured: "
              f"{bridge.vlc.configured})")
    else:
        playback = session.get_playback_info()
        print(f"session status       : {status_name(playback)}")
    print(f"_get_position_ms()   : {bridge_position_probe(bridge)!r}")
    print(f"_get_duration_ms()   : {bridge_duration_probe(bridge)!r}")

    pushed = [c for c in window.calls]
    print(f"\n--- bridge pushed {len(pushed)} JS call(s); first 12:")
    for call in pushed[:12]:
        print(f"  {call[:150]}")

    if args.toggle or args.pause or args.play or args.skip_next or args.seek is not None:
        print("\n--- driving the bridge's transport entry points "
              "(these CHANGE playback)")
        before = status_name(session.get_playback_info()) if session else None
        pushed_before = len(window.calls)
        print(f"  before: status={before}")
        if args.toggle:
            bridge.toggle_playback()
        if args.pause or args.play:
            bridge.toggle_playback()
        if args.skip_next:
            bridge.skip_next()
        if args.seek is not None:
            bridge.seek_position(float(args.seek))
        time.sleep(2.0)
        after = status_name(session.get_playback_info()) if session else None
        print(f"  after 2s: status={after}")
        if args.seek is not None:
            print(f"  _get_position_ms() after seek: {bridge_position_probe(bridge)!r}")
        print("  (bridge transport calls are fire-and-forget; the try_* return "
              "values are logged by the bridge, not returned here)")
        print(f"  the command pushed {len(window.calls) - pushed_before} JS call(s):")
        for call in window.calls[pushed_before:]:
            print(f"    {call[:160]}")
        if args.watch_after and session is not None:
            print(f"  polling status for {args.watch_after:.0f}s to see where it "
                  "settles:")
            steps = max(1, int(args.watch_after / 0.5))
            for i in range(steps):
                print(f"    t={i * 0.5:4.1f}s status="
                      f"{status_name(session.get_playback_info())}")
                time.sleep(0.5)
    else:
        print("\n(no transport flags — the bridge loop only read state)")

    shutdown.set()
    thread.join(timeout=5.0)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", default="",
                        help="substring of the target SourceAppUserModelId, "
                             "e.g. SimpMusic (default: Windows' current session)")
    parser.add_argument("--list", dest="list_only", action="store_true",
                        help="list sessions and exit")
    parser.add_argument("--watch", type=float, default=0, metavar="SECONDS",
                        help="poll the timeline and report whether it moves")
    parser.add_argument("--watch-after", type=float, default=0, metavar="SECONDS",
                        help="keep polling after the transport tests, in the same "
                             "process, to see whether a reported success settles")
    parser.add_argument("--toggle", action="store_true",
                        help="explicitly press play/pause twice (changes playback)")
    parser.add_argument("--play", action="store_true", help="explicitly play")
    parser.add_argument("--pause", action="store_true", help="explicitly pause")
    parser.add_argument("--seek", type=float, default=None, metavar="MS",
                        help="explicitly seek to MS and read the position back")
    parser.add_argument("--seek-as-timedelta", action="store_true",
                        help="send the seek as datetime.timedelta instead of "
                             "WinRT ticks")
    parser.add_argument("--bridge", type=float, default=0, metavar="SECONDS",
                        help="drive the overlay's OWN SmtcBridge against the "
                             "live session for SECONDS before running any "
                             "transport test (settle time)")
    parser.add_argument("--skip-next", action="store_true",
                        help="with --bridge: send a skip-next once "
                             "(changes playback)")
    parser.add_argument("--interval", type=float, default=1.0, metavar="SECONDS",
                        help="watch polling interval (default 1.0s)")
    args = parser.parse_args(argv)

    if sys.platform != "win32":
        print("This diagnostic needs Windows (GSMTC).")
        return 2

    if args.bridge:
        return bridge_mode(args)

    try:
        return asyncio.run(amain(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
