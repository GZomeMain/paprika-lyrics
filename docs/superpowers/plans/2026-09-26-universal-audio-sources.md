# Universal Audio Source Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the overlay work reliably with any Windows audio source — Spotify, browsers, and local-file players (MusicBee, foobar2000, WMP) — by extracting every metadata field GSMTC offers, repairing weak local-file metadata (filename stems, track-number prefixes, missing artists), and threading album context through the lyric/resolver chain.

**Architecture:** A new pure module `core/media_meta.py` turns the raw GSMTC media-properties object into a `MediaMeta` value object and repairs weak metadata using the existing cleaners in `core/metadata.py`. `core/smtc.py` keeps only I/O and calls the pure module (which keeps tests Windows-free). Album context flows into `core/lyrics.py` (LRCLIB search + lyrics cache key) and `core/resolver.py` (search terms + track-ID cache key), and surfaces in the UI's Resolve report.

**Tech Stack:** Python 3.10+, winsdk (SMTC, I/O only), unittest. No new dependencies.

## Global Constraints

- Tests must never import `winsdk` or `webview`: all new logic lives in pure modules (`core/media_meta.py`, `core/metadata.py`, `core/lyrics.py`, `core/resolver.py`); `core/smtc.py` stays a thin I/O wrapper.
- Test command: `python -m unittest discover -s tests` (this project uses unittest, not pytest).
- No new pip dependencies.
- `PARSER_VERSION` stays `11`: the parsed lyric payload shape does not change in this plan.
- Behavior preservation: when metadata is already good (Spotify, YouTube Music), resolution results must be identical to today — album context is used only as an *additional* attempt, never a replacement.
- Platform: Windows-only app; `core/smtc.py` changes are verified by manual smoke, not automated tests.
- Commit style: conventional commits (`feat:`, `test:`, `docs:`).

---

### Task 0: Repository bootstrap (one-time) — DONE

Git repo initialized; baseline commit `462e639`; 115 tests green before work started.

### Task 1: `MediaMeta` value object — DONE (commit `6370d6e`)

Created `core/media_meta.py` + `tests/test_media_meta.py` per the plan. **Deviation from the plan:** the plan's `album_for_search` relied on `extract_clean_metadata` to strip "(Deluxe Edition)", but that cleaner only strips a known keyword list and left `MAYHEM (Deluxe Edition` half-stripped. The implementation adds a `_BRACKETED_TAIL` regex that drops any trailing bracketed segment wholesale before the standard clean — the test caught this and the fix is committed.

### Task 2: Weak local-file metadata repair — DONE (commit `6a11b71`)

Appended `strip_audio_extension`, `split_track_number_prefix`, `normalize_weak_title` to `core/metadata.py`. **Deviation from the plan:** the plan's implementation produced `nightcall kavinsky` for `"nightcall_kavinsky"` while its own test expected `nightcall` + artist `kavinsky`. The test's expectation is the useful behavior, so the implementation infers the artist from the last underscore-separated segment when the artist tag is empty.

### Task 3: Wire MediaMeta into SMTC — DONE (commit `33602c9`)

`core/smtc.py` now builds `MediaMeta`, repairs weak title/artist, computes `album`, and uses `build_track_signature` (app_id + title + artist + album + duration). `fetch_lyrics` is called with `(title, artist, duration_ms, album, metadata_source)`. Note: the plan's edit initially collided with the try/except retry wrapper added during the earlier review round; indentation was corrected and `py_compile` + import check pass.

### Task 4: Album-aware LRCLIB + cache key + diagnostics — DONE (commit `e4ee68e`)

`_lyrics_cache_key(title, artist, duration_ms, album)`; `fetch_lrclib(..., album)` tries album-scoped search first, plain search as fallback; `_build_diagnostics` carries `album` and `metadata` keys. **Deviation from the plan:** the plan's test asserted the plain search is *also* attempted when the album-scoped search succeeds; that contradicts the implementation (a successful attempt returns immediately). The test was corrected to assert the real contract, plus a new test covering the miss→fallback path.

### Task 5: Album-aware Spotify resolver — DONE (commit `d78526c`)

`resolve_spotify_track_id(raw_title, raw_artist, album=None)`: album appended to the scraper search term and to the cache key (legacy shape preserved without album). Tiers 2/3 unchanged by design. `_spicy_chain` forwards the album.

### Task 6: Resolve report UI rows — DONE (commit `dd75465`)

`renderDiagnostics` in `ui/app.js` shows `Album` and `Metadata` rows after `Timing`. `node --check` passes.

### Task 7: Docs + verification — DONE (commit `e73daf0`)

README feature bullet + three manual smoke checklist items added. Final suite: **139 tests OK** (was 115 at baseline). All Python modules compile; app.js passes syntax check.

## Remaining manual verification (Windows-only, cannot be automated here)

- [ ] Play a local file whose tags are missing (filename only): lyrics resolve, and the Resolve report's Metadata row shows `filename`.
- [ ] Play the same song from two different albums: the second triggers a lyric reload.
- [ ] Play from Spotify, then from a local player: session handover after ~4 s.

## Known limitation (documented in README)

Apps that never broadcast to Windows media controls (SMTC) cannot be followed — Windows offers no alternative short of audio capture.
