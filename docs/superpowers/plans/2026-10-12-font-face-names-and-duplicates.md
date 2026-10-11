# Font face names and duplicate imports — Implementation Plan

> **Status: SHIPPED** (2026-10-12). Every step below is done and verified; the
> "Verification results" section at the end records what was actually observed.
> Where the shipped code differs from the sketch in a step, the difference is
> noted under that step — the sketch is kept so the reasoning stays readable.

**Goal:** Make every face in the font library identifiable by name without reading its file name, and stop the same face from entering the library twice.

**Architecture:** The parsing already exists — `core/font_library.read_font_meta` reads the name table's family *and subfamily*, and the snapshot already carries `weight`/`style`. Task 1 exposes the subfamily so the UI can compose a display name (`Georgia Bold`) instead of repeating the family four times, and uses it everywhere the face is named. Task 2 adds a content hash to the import path so a file whose bytes are already in the library is reported as already there rather than copied in as `georgia (2).ttf`. Task 3 removes the duplication the audit found in the code the previous pass added.

**Tech Stack:** Python 3 (host: `core/font_library.py`, pywebview API in `paprika_app.py`), plain-script JS overlay (`ui/app.js`), unittest, and the CDP-driven UI regression in `tools/ui-preview-regression.js`.

## Global Constraints

- Windows-only app (WinRT/GSMTC, WebView2); tests run on Windows.
- No new dependencies, no new files in `ui/`, no change to `index.html`'s script tags.
- Host replies keep their existing shape: `{dir, count, trash, status, entries[]}`; existing keys keep their meaning and type.
- `ui/app.js` keeps its invariant that every host call is null-safe (`fontBridge` returns `null` when there is no bridge).
- Every mutation returns the whole snapshot, so the panel renders from one source of truth.
- Removal stays non-destructive (`.trash`), and a removed face must remain re-importable.
- The UI regression must stay green at 5 viewports; `node --check` on every JS file touched.
- Nothing is committed; the working tree already holds unrelated uncommitted work.

---

### Task 1: A face is named the way its own file names it

**Files:**
- Modify: `core/font_library.py` (`_describe`, ~line 349)
- Modify: `ui/app.js` (`fontCatalog`, `fontRow`, `ensureFontFace`, ~lines 305, 350, 520)
- Test: `tests/test_font_library.py`, `tools/ui-preview-regression.js`

**Interfaces:**
- Consumes: `read_font_meta(bytes) -> {"family", "subfamily", "weight", "italic"}`.
- Produces: snapshot entry gains `"subfamily": str`; `ui/app.js` gains `faceDisplayName(entry) -> str`.

- [x] **Step 1: Write the failing test**

Shipped as `FolderTests.test_a_files_own_subfamily_travels_with_its_entry` (in the
snapshot, beside the existing label assertions, rather than as a mocked
`read_font_meta` — the folder's own file is a stronger subject than a mocked parser).

- [x] **Step 2: Run test to verify it fails**

Run: `python -m unittest tests.test_font_library -v`
Expected: FAIL — `KeyError: 'subfamily'` *(confirmed: failed before the change)*

- [x] **Step 3: Expose the subfamily**

In `core/font_library.py`, `_describe`'s returned dict gains one key after `"family"`:

```python
            "family": meta["family"],
            "subfamily": meta["subfamily"],
```

In the `except` branch above it the fallback already sets `"subfamily": ""`, so a file
whose name table cannot be read reports an empty subfamily rather than a guess.

- [x] **Step 4: Compose the display name on the page**

`ui/app.js` gained `faceDisplayName(entry)`: the family, plus the file's own subfamily
when that says more than "regular" (and never when it merely repeats the family). It is
used by `fontCatalog` (the summary label), `ensureFontFace` (the tables the overlay
registers), and therefore by `fontRow`, which prints `face.label`. The row's `title`
still carries the file name, which is what distinguishes two same-named faces.

Shipped at `ui/app.js:305`-ish, just above `fontCatalog`. Note the guards: an empty
subfamily, `Regular`/`Normal`/`Book`, and a subfamily equal to the family all return the
family alone — "Georgia Regular" is noise, "Georgia Bold" is the face.

- [x] **Step 5: Run tests to verify they pass**

Run: `python -m unittest tests.test_font_library -v`
Expected: PASS — **43 tests, OK** (the file grew by the new folder-level test)

- [x] **Step 6: Pin it in the UI regression**

In `tools/ui-preview-regression.js`, the font stub's `zany.woff2` entry carries
`subfamily: 'Bold'`, and section 15b asserts the rendered row names:

```js
  result.fontRowNames = namesByFace;
  if (namesByFace['custom-zany'] !== 'Zany Bold') { ... }
  if (namesByFace['custom-honk'] !== 'Honk') { ... }
```

The second assertion is the important one: a plain regular import must still be named by
its family alone, so the fix cannot degenerate into appending every subfamily.

- [x] **Step 7: Run the UI regression**

Run: `node tools/run-ui-preview-regression.mjs`
Expected: PASS at all 5 viewports — **PASS at 5/5, 309 checks each**

### Task 2: The same face cannot enter the library twice

**Files:**
- Modify: `core/font_library.py` (`add_files`, `adopt`, ~lines 386-490)
- Test: `tests/test_font_library.py`, `tests/test_window_api.py`

**Interfaces:**
- Consumes: the library's own folder listing (`self._files()`, top level only).
- Produces (as shipped): `FontLibrary._library_digests(sizes=None) -> dict[str, str]`
  (sha256 hex → the name holding those bytes) and the module-level
  `_file_digest(path) -> str`. `add_files`/`adopt` keep their report shape
  (`{"added": [...], "skipped": [...], "failed": [...]}`); `skipped` now also names the
  library file that already holds a face, not just a path that was already inside the
  folder.

- [x] **Step 1: Write the failing tests**

Shipped as four tests in `AddFilesTests`/`AdoptTests`:

```python
    def test_the_same_face_is_not_imported_twice(self):      # the "georgia (2).ttf" defect
    def test_two_identical_files_in_one_import_land_once(self):
    def test_a_removed_face_can_be_imported_again(self):     # .trash must not block it
    def test_adopt_does_not_double_a_face_under_another_name(self):
```

The first reproduces the measured defect by name: importing the same face again added
`georgia (2).ttf` beside `georgia.ttf`, one face under two file names and one label.

- [x] **Step 2: Run tests to verify they fail**

Run: `python -m unittest tests.test_font_library -v`
Expected: FAIL — the duplicate is added *(confirmed: 3 of the 4 failed; the removal
guard passed from the start, as it had to)*

- [x] **Step 3: Implement the digest map**

```python
    def _library_digests(self, sizes=None) -> dict[str, str]:
        """
        Maps the SHA-256 of each live file to the name it is kept under.

        The live files only: `_files` skips `.trash`, so a face the user removed
        on purpose can be imported again. Given `sizes`, only files of those
        lengths are hashed — equal bytes have equal length, so a length nothing
        being imported shares cannot hold a duplicate of it.
        """
```

plus, at module level:

```python
def _file_digest(path: Path) -> str:
    """The SHA-256 of a file, read in blocks so a large font is not held twice."""
```

Two departures from the sketch, both deliberate: the directory walk lives on the class
(`_library_digests`, beside `_files`, which is the thing it interprets) rather than in a
`_known_digests` twin of it, and the digest is read in 1 MiB blocks instead of
`read_bytes()`, because a variable font is megabytes and this runs per import.

- [x] **Step 4: Consult it in `add_files`**

The library's own digests are read once per import, filtered to the sizes of the files
being imported (`wanted`); each source is hashed before it is copied, and a hit in the
map is reported as skipped under the name holding it. The digest of an accepted copy is
recorded immediately, so picking the same file twice in one multi-select answers exactly
as importing it twice would.

The in-folder check stays where it was (before the hash), which keeps "a file already in
the folder is left alone" from costing a read of a multi-megabyte file.

- [x] **Step 5: Consult it in `adopt`**

Same rule for the one-time store handover: the decoded bytes are hashed and looked up
before anything is written, so a rerun — or a crash halfway through the handover — cannot
leave one face stored twice under two legacy ids.

- [x] **Step 6: Run tests to verify they pass**

Run: `python -m unittest tests.test_font_library -v`
Expected: PASS — **43 tests, OK**

- [x] **Step 7: Report the duplicate in the sheet's own words**

The status string already had the wording (`paprika_app.font_import` reports
`N already in the library`), so the work here was to prove the wording is reached with
the new `skipped` entries. Shipped as
`FontApiTest.test_import_reports_a_face_it_already_holds` in `tests/test_window_api.py`:

```python
    def test_import_reports_a_face_it_already_holds(self):
        body = b"\x00\x01\x00\x00" + b"\x2a" * 32
        self.window.dialog_result = [self.font_file("face.ttf", body)]
        self.api.font_import()
        self.window.dialog_result = [self.font_file("face-copy.ttf", body)]
        snapshot = self.api.font_import()
        self.assertEqual(snapshot["count"], 1)
        self.assertIn("1 already in the library", snapshot["status"])
```

The second import is a *renamed copy*, not the same path, so this is the new behaviour
and not the pre-existing "already inside the folder" branch.

### Task 3: One telling of the duration story, one writer per label

**Files:**
- Modify: `core/smtc.py` (the step-2 comment)
- Modify: `ui/app.js` (`updateArtProgress`, ~line 3656)
- Test: `tests/test_smtc_transport.py`, `tools/ui-preview-regression.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `window.setTrackDuration(ms)` is the ONLY writer of `#art-duration-display` and
  `#side-time-total`; the length's rationale lives in one place.

- [x] **Step 1: Pin the invariant first**

Section 15 of `tools/ui-preview-regression.js` now asserts, right after the known-duration
checks:

```js
  // One writer for a track's length: `setTrackDuration` owns both labels, so a
  // progress tick must not be the thing that paints the total. If it were, a
  // render that never consulted the host could put a length on screen.
  const knownSideText15 = totalEl15.textContent;
  const knownArtText15 = artDurEl15.textContent;
  updateArtProgress(120000);
  result.progressTickLeavesTheTotalAlone = artDurEl15.textContent === knownArtText15
    && totalEl15.textContent === knownSideText15;
```

Both labels are checked, not just the one that was rewritten — a second writer could as
easily have been added on the split layout's side.

- [x] **Step 2: Delete the second writer**

In `ui/app.js`, `updateArtProgress` lost its two writing lines; the comment left in their
place says why the total is not this function's.

- [x] **Step 3: Run the regression again**

Run: `node tools/run-ui-preview-regression.mjs`
Expected: PASS at all 5 viewports — **PASS at 5/5, 309 checks each**

- [x] **Step 4: One telling of the SMTC rationale**

`core/smtc.py`'s step-2 comment is now three lines, and it points at
`_publish_duration`, whose docstring keeps the full story of what announcing the length
late cost (the measured `--:--`-for-the-rest-of-the-song defect).

- [x] **Step 5: Trim the duplicated test narrative**

`tests/test_smtc_transport.py` has no test docstrings — the two long narratives are
comment blocks on the end-time tests, and those are what was cut to their first sentence:

- `test_a_length_the_ui_never_got_is_announced_again` — keeps the quoted report and the
  rule ("what is remembered as pushed has to be what the UI was TOLD").
- `test_the_length_is_announced_while_the_lyric_lookup_keeps_failing` — keeps the one
  sentence the test proves.

The full account lives in `core/smtc.py::_publish_duration`; a test that restates it is a
second copy to keep in sync, and the tests' names already say what they pin.

- [x] **Step 6: Run the transport tests**

Run: `python -m unittest tests.test_smtc_transport -v`
Expected: PASS — **OK** (as part of the module runs below; no test was changed)

---

## Deliberately not in this plan

- **A length derived from `max_seek_time - min_seek_time`.** It would make the end time
  appear for a player that publishes only a seekable range, but a live stream or a
  chaptered item publishes a *window* there, so the overlay would show a total that is
  not the track's — the one thing this codebase refuses to do. It needs player evidence
  before it can be written, not a heuristic.
- **The page asking the host for a transport snapshot on load.** It only helps a
  mid-song webview reload (nothing in the app reloads the page, and a failed delivery is
  already retried every tick), and it touches the startup path where an exception blanks
  the window. Worth its own pass with the harness as the gate.
- **Splitting `ui/app.js`.** It is ~5,980 lines and every feature lives in it, but a
  second global script that calls into the first is not a boundary — the split needs
  real modules (or a per-feature init hook) before it is an improvement.

## Verification results (as run)

| Check | Command | Result |
| --- | --- | --- |
| Full suite | `python -m unittest discover -s tests` | **568 tests, OK, exit 0** |
| Syntax | `node --check ui/app.js && node --check tools/ui-preview-regression.js` | OK |
| UI regression | `node tools/run-ui-preview-regression.mjs` | **PASS 5/5, 309 checks each** |
| Live, real faces | real page + real `WindowApi` + real `C:\Windows\Fonts` bytes | see below |
| Live, duplicate import | same, through the page's own Import button | see below |

**Live run (real page, real host API, real font bytes).** A throwaway server served the
unmodified `ui/` page against `paprika_app.WindowApi` over a real `FontLibrary` and a real
file picker that answers with `C:\Windows\Fonts` paths. Importing Georgia's four real
faces produced four rows reading `Georgia`, `Georgia Bold`, `Georgia Italic`,
`Georgia Bold Italic` — before the fix all four read `Georgia` — each row's family
registered and drawing in its own face (`document.fonts.check` true for all four, and
canvas widths of the same string at 32px of 110.83 / 129.94 / 116.42 / 134.69, distinct
per face rather than one fallback). The host's parse agreed: `subfamily`
`Regular`/`Bold`/`Italic`/`Bold Italic` with `weight` 400/700/400/700 and
`style` `normal`/`normal`/`italic`/`italic`.

Choosing two of those files again through the page's Import button answered
**"2 already in the library"** with the folder unchanged at four files and the list still
showing four Georgia rows. The store handover (`adopt`) with one of those real faces under
an id the library had never seen also left the folder at four files.

The probe server and its script were deleted after the run (`tools/` holds no `_probe` or
`_audit` files, the port refuses connections, and the preview tab is closed).
