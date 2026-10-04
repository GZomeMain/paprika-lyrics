# SimpMusic transport: what the player publishes, what the overlay assumed

**Goal:** make the overlay truthful and correct about a GSMTC player that publishes
no timeline (SimpMusic on Windows), and fix the overlay-side defects the
investigation turned up for every player — wrong duration against a non-zero
timeline origin, wall-clock extrapolation while paused, transport commands whose
outcome was discarded, and a seek bar that could not be used or confirmed.

**Reported symptoms:** timeline sync, play/pause, seek and other transport fail or
behave incorrectly in the overlay for SimpMusic; the duration shown is wrong.
Native Windows media controls work. Other players work, and must keep working.

**Tech Stack:** Python 3.13, winsdk 1.0.0b10 (GSMTC), pywebview/WebView2 front end,
`unittest`, `node --check`, `tools/ui-preview-regression.js`.

## Global Constraints (as instructed)

- Keep GSMTC as the default backend; preserve Spotify/browser/VLC behaviour.
- One authoritative session for reads and commands; commands run through a safe
  async path; failures surfaced; UI reconciled after a command.
- Normalize time units and the timeline origin at one clear boundary.
- Monotonic time for local extrapolation; anchors reset on pause, seek, track
  change and session change; extrapolation bounded.
- Handle unavailable/zero/stale/invalid duration without fabricating a timeline,
  and never substitute lyric duration for player duration.
- No hard-coded SimpMusic multiplier/delay/exception, no global media keys, no UI
  automation, no new player backend.
- Do not assume SimpMusic lacks SMTC support, and do not assume the symptoms share
  one cause.

---

## What was measured on this machine (Windows, SimpMusic running)

Read-only probe (`tools/smtc_diagnose.py`), with a track playing:

```text
sessions: 1
  'Simpmusic_ejp2bhxmz1qq6!Simpmusic'
playback_status : 4              (PLAYING)
playback_rate   : None
controls        : play_pause_toggle=True, play=False, pause=True, next=True, previous=True, stop=True
  start_time      : 0:00:00 (0.000 ms, 0 ticks)
  end_time        : 0:00:00 (0.000 ms, 0 ticks)
  position        : 0:00:00 (0.000 ms, 0 ticks)
  min_seek_time   : 0:00:00 (0.000 ms, 0 ticks)
  max_seek_time   : 0:00:00 (0.000 ms, 0 ticks)
  last_updated_time: 1601-01-01T00:00:00+00:00   <-- WinRT "never updated" sentinel
title 'Why Are Sundays So Depressing' / 'The Strokes' / 'The New Abnormal'
```

Nine consecutive one-second polls: **every** timeline field static, status
constant. Reproduced across three different tracks.

Transport, each call explicit (`--toggle/--pause/--play/--seek`):

| Call | Returned | Observed effect |
| --- | --- | --- |
| `try_play_pause_async()` | `True` | status 4 → 5, restored to 4 |
| `try_pause_async()` | `True` | settled at status 5 |
| `try_play_async()` | `True` | (called while already playing) |
| `try_change_playback_position_async(45000 * 10_000)` | `True` | no read-back possible (no timeline) |

Reported **status flaps**: right after a pause, one poll reported `4` again before
settling at `5`.

The overlay's own path, driven directly (`--bridge`, `SmtcBridge` with a recording
window):

```text
current_session    : Simpmusic_ejp2bhxmz1qq6!Simpmusic
event_loop running : True
_get_position_ms() : None
_get_duration_ms() : None
pushed: window.setTrackDuration(0);
        (no window.syncPlayhead at all)
```

## Root causes

**Upstream (SimpMusic, not the overlay):**

1. **No timeline is published at all** — position, end, both seek bounds zero and
   `last_updated_time` left at WinRT's never-written sentinel, static while
   playing. Consequences for any GSMTC client: no duration to show, no position to
   sync a playhead to, and no way to confirm a seek. This is the sole cause of the
   wrong duration. Evidence: the probe output above; the flapping status shows the
   session itself is live and commandable, so this is not "no SMTC support".

**Overlay (core/smtc.py, ui/app.js):**

2. **Duration was read as `end_time`, ignoring `start_time`.** Correct by accident
   whenever a player keeps the origin at zero, wrong for any player that does not
   (chapters, cues). *Fixed in `core/timeline.normalize_timeline`.*
3. **Position was extrapolated with a wall clock against the player's
   `last_updated_time`** and without regard for playback status, so a paused
   player's frozen snapshot gained up to the 10 s clamp every read (the playhead
   crept forward while paused), and a skewed player clock moved the playhead with
   it. Extrapolation also re-anchored to the raw snapshot every read, so a player
   that refreshes every few seconds pulled the highlight backwards each pass.
   *Fixed by `core/timeline.PositionClock` (monotonic anchors, re-anchor on a
   fresh sample only, paused/stopped freezes, bounded projection, rate-aware).*
4. **Command outcomes were discarded.** `_do_toggle/_do_seek/_do_skip_*` swallowed
   every exception and dropped the `try_*_async` boolean; a session with a
   non-running loop silently dropped the click; nothing was logged or reported.
   *Fixed with `_dispatch` + `_report` (debug log + `window.transportResult`).*
5. **Play/pause chose a direction from a status read.** `_do_toggle` picked
   `try_pause_async` vs `try_play_async` from `playback_status`, which SimpMusic
   reports wrongly for about a second after a change (measured), producing a
   pause sent to an already-paused player — a click that visibly did nothing.
   Windows' own controls use the combined toggle, which is why native works.
   *Fixed: `try_toggle_play_pause_async` first (the control the player
   advertises), status-directed play/pause only as a fallback; plus
   `COMMAND_SETTLE_S` so a stale echo cannot flip the play button back.*
6. **`setTrackDuration(0)` could not mean "unknown".** The labels were only
   written when the total was positive, so a player with no duration kept the
   *previous* track's length on screen, and `sideTotalMs = 0` disabled
   `seekFromFraction` — the seek bar was dead with no explanation. *Fixed: `null`
   clears the labels to `--:--`, marks `body.duration-unknown`, turns the rails
   inert; the diagnostics panel states what the player publishes.*
7. **The optimistic seek had no reconciliation.** `applySeek` moved the UI
   immediately and nothing ever verified or rolled it back. *Fixed:
   `window.transportResult` rolls a refused seek back to the pre-seek position and
   reports the refusal; `_do_seek` reports `verified: false` when the player
   publishes no timeline to confirm against.*

## File changes

| File | Change |
| --- | --- |
| `core/timeline.py` (new) | `to_ms`, `clamp_rate`, `never_updated`, `normalize_timeline` (origin-relative duration/position, liveness), `PositionClock` (monotonic anchor, freeze on pause, bounded projection, reset/invalidate). Pure, winsdk-free. |
| `core/smtc.py` | `_dispatch` (one session for reads and commands, reported drops), `_report`/`_push_js`, `_playback_state`, `_effective_playing` + `_reconcile_playback` (stale-echo guard), `_do_toggle` on the combined control, `_do_seek` reporting + clock invalidate, `_do_skip` reporting + clock reset, `_read_timeline`/`_note_timeline`, duration from the normalized sample, `setTrackDuration(null)` when unpublished, `setTransportState` pushes, `self.window` for reconciliation. |
| `ui/app.js` | `setTrackDuration` handles unknown/zero (`--:--`, clears fills, `duration-unknown`), `setTransportState`, `transportResult` (logs, reports, rolls back a refused seek), `applySeek` records the rollback anchor, resolve report gains Player / Transport / Last command rows. |
| `ui/style.css` | `body.duration-unknown` makes both seek rails inert. |
| `tools/smtc_diagnose.py` (new) | Read-only session survey, raw timeline dump, `--watch`, explicit `--play/--pause/--toggle/--seek`, `--bridge` to drive the overlay's own bridge. Never changes playback without an explicit flag. |
| `tools/ui-preview-regression.js` | New section 15: unknown duration clears the labels and disables the rails, the resolve report states the player's transport, a refused seek rolls back and an accepted one does not. |
| `tests/test_timeline.py` (new, 26) | Units, origin, liveness/sentinel, clock anchoring: paused freeze, stale-sample no-snap-back, fresh-sample re-anchor, bound, rate, session change, invalidate/reset, invalid duration. |
| `tests/test_smtc_transport.py` (new, 30) | Mocked sessions: dead timeline → `None` position/duration; origin-relative duration; combined toggle preferred and fallback; refusal and exception surfaced; stale-echo ignore; seek ticks, paused seek never plays, forward/backward, verified flag; skip refusal; dispatch on the loop, no-session/VLC fallback, dead-loop report; the real `run()` loop's payloads for a dead vs live timeline and for a session replacement. |
| `README.md` | Diagnostics/transport feature copy, a FAQ entry for "no duration / dead seek bar", the project structure rows. |

## Verification

- `python -m unittest discover -s tests` → **389 tests, OK** (was 333).
- `node --check ui/app.js`, `node --check tools/ui-preview-regression.js` → OK.
- `tools/ui-preview-regression.js` → **PASS at 1400×900, 900×700, 800×600,
  360×420, 330×380**, with section 15 reporting
  `durationKnown "5:00 / 5:00"`, `durationUnknown "--:-- / --:--"`,
  rails `auto`/`none`/`none`, seek `200000 → 40000 (rolled back) → 60000 (kept)`.
- Live SimpMusic, after the fix: `setTrackDuration(null)`,
  `setTransportState({app: SimpMusic…, timeline: false, duration: false})`,
  no `syncPlayhead`; `[SMTC] toggle: ok=True accepted` with the status settling
  5 → 4 across a 4 s poll; `[SMTC] seek: ok=True target=45000ms` reported to the
  UI with `verified: false`.

## Manual Windows procedure

1. `python tools/smtc_diagnose.py --list`, then
   `python tools/smtc_diagnose.py --app SimpMusic --watch 10`.
   Expect: metadata and status, timeline all zeros, "never published" sentinel,
   `timeline moved: NO`.
2. `python tools/smtc_diagnose.py --app SimpMusic --toggle --watch-after 4`.
   Expect `returned True` and the status settling at the opposite value.
3. Repeat both against one working player (Spotify, a browser tab, VLC) — expect a
   live timeline (position advancing, non-zero `end_time`) and
   `timeline moved: YES`.
4. Run the overlay with `SPICY_DEBUG=1` and read the resolve report's
   **Player / Transport / Last command** rows with each player:
   SimpMusic shows `no timeline from player · duration unknown`, the working player
   `timeline live · duration known`.
5. With SimpMusic: the duration reads `--:--`, the seek rails do not highlight or
   seek, play/pause and next/previous work, lyrics scroll. With the working player:
   duration, playhead, drag-to-seek and the on-art fill all behave as before.

## Still unverified / open

- The seek acceptance for SimpMusic cannot be confirmed: it returns `True` but
  publishes nothing to read back. Whether the app's playback position actually
  moved needs an audible/visual check in the app.
- `try_play_async()` from a paused state was only exercised while the player was
  already playing (a human was using the machine); the resume direction is covered
  by the falling-back path and by the combined toggle, not measured directly.
- Whether the diagnostics panel rows read well at every window size was checked in
  the preview gate, not on the running overlay.
- Upstream: SimpMusic publishes no timeline (position/length/seek bounds/sentinel
  last-update) while playing. Worth reporting to `maxrave-dev/SimpMusic` (its
  desktop playback lives in the `core` submodule): clients cannot show a duration,
  sync a playhead, or confirm a seek for it. Separately, its reported playback
  status flaps back to PLAYING for about a second after a change.
