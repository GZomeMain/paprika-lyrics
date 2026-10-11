# The end time that never arrived

**Reported:** "Fix the issue with the end time not showing even for apps which
provide the timeline and song details."

**Symptom (from the screenshot):** the elapsed timer counts (`0:46`) and the
playhead sits at the start of the bar, while the total reads `--:--`. Read out of
the image itself: the right-hand label is five narrow ink marks — dash, dash,
colon, dash, dash — not four digit-width glyphs, so the page really is showing
the *unknown* label, not a clipped or dimmed number.

`--:--` is written by exactly one thing: `window.setTrackDuration(null)` (or a
zero), pushed by `core/smtc.py`. So the question was not "does the UI render a
length" — it does; the time is written the moment a real number arrives — but
"why does the host keep saying it has none".

## What was measured on this machine

`tools/smtc_diagnose.py` with the reported player live:

```text
sessions: 3
  'msedgewebview2.exe'                     end=3:45.266  pos=1:02.905  paused
  'Simpmusic_ejp2bhxmz1qq6!Simpmusic'      every field 0, sentinel stamp  (known)
  'F0DC299D809B9700'                       end=3:45.701  pos≈0  PLAYING
```

The playing session **does** publish a length, and the overlay's own bridge reads
it back:

```text
_get_duration_ms()   : 177701.0
duration pushes      : ['window.setTrackDuration(177701.0);']
```

Yet a run taken minutes earlier, on the same app, pushed:

```text
window.setTransportState({"app": "F0DC299D809B9700", "timeline": false, "duration": false});
window.setTrackDuration(null);
```

Both are correct at the moment they happened: this player blanks its whole
timeline between items (the same behaviour already documented for a browser
after a seek), so the length is genuinely unknown while the next item opens. What
was *not* correct is what happened next — the length it published a moment later
never reached the page, and the `--:--` stayed for the rest of the song.

## Root cause

`core/smtc.py` told the UI the track's length from one guarded push:

```python
if duration_ms != self._pushed_duration:
    self._pushed_duration = duration_ms          # recorded BEFORE delivery
    window.evaluate_js(f"window.setTrackDuration({json.dumps(duration_ms)});")
```

Two things conspired, and either one alone breaks the feature:

1. **It recorded the push before delivering it.** `_pushed_duration` is the
   answer to "what does the UI know", so a delivery that never landed — the page
   still loading, an exception thrown by an earlier bridge call in the same tick,
   a webview that has reloaded — was never retried. From then on the value looked
   already-sent, and the bar kept the `--:--` for the whole song.
2. **It sat behind the lyric work.** The push was step 3, *after* the track-change
   block — and that block `continue`s when the lookup throws, so a resolver that
   kept failing carried the end time off the end of the tick with it. The length
   has nothing to do with the lyrics.

The same shape existed in the VLC source: the push lived inside the
track-changed branch, and VLC answers with no length at all on its first status
poll, so a length that appeared a moment later reached the UI never.

## Fix

| File | Change |
| --- | --- |
| `core/smtc.py` | `_publish_duration(window, duration_ms)` — the one place that says a length. It records `_pushed_duration` only after the call returns, so a failed delivery is retried on the next tick (the same choice the playhead already makes: a redundant `setTrackDuration` is one idempotent JS call, a lost one costs the user their end time). `None` is recorded and re-sent on the same terms as a number. |
| `core/smtc.py` | The push moved to step 2, before the lyric load: the length cannot be held back by a slow lookup, and a failing one can no longer skip it. |
| `core/smtc.py` | A track change forgets what the UI was told (`_pushed_duration = _UNPUSHED`), so a song re-announces its own length even when that length is the number already on screen — a feed of equal-length items, or a UI that came back from a reload. |
| `core/smtc.py` | `_vlc_tick` uses the same push on every poll instead of only on a track change. |
| `ui/index.html` | The totals the page ships are `--:--` under `body.duration-unknown`: a length the host has not reported is not `0:00`, and shipping a fabricated total made an honest unknown indistinguishable from a push that never arrived. |
| `tests/test_smtc_transport.py` | Four new tests (see below). |
| `tools/ui-preview-regression.js` | Asserts the shipped totals/`duration-unknown`, read from the page source (an earlier pass in a repeated run has already pushed a length, so reading the live DOM would pass for the wrong reason). The seek-cursor check now establishes a known length first: a rail with no total is inert *on purpose*, which is a different rule. |

## Tests

- `test_a_length_the_ui_never_got_is_announced_again` — a push that raises is
  delivered on the next tick (asserts the value arrives, and more than once).
- `test_the_length_is_announced_while_the_lyric_lookup_keeps_failing` — the end
  time lands even though the lyrics never load.
- `test_a_new_track_re_announces_a_length_the_ui_already_had` — equal-length
  items announce per track, not per change.
- `test_a_length_vlc_reports_late_reaches_the_ui` — VLC's late length lands.

All four were checked against the pre-fix behaviour reconstructed in a throwaway
script: all four fail there (two failures, two errors), and pass on the fix.

## Verification

- `python -m unittest discover -s tests` — **562 tests OK**.
- UI regression — **5/5 viewports, 307 checks each**.
- Live, against the reported player: the bridge now pushes
  `window.setTrackDuration(65461.0)` and records it; replayed into the served
  page, the label reads `1:05 / 1:05` with the fill and dot at 70.27%, and the
  page as shipped reads `--:-- / --:--` with `body.duration-unknown` and an inert
  rail.
