# Font library — imported faces as files, and a list to choose them in

**Goal:** make importing a font an understandable thing to do. Before this, the Fonts group was
two rows against a hidden store: "Import font" reported `1/8 imported`, applying a font happened as
a side effect of importing it, and "Remove custom font" deleted whichever import the **Lyrics row
happened to be showing** — so removing a font meant first cycling onto it. The cap existed only
because of where the fonts were kept.

**Architecture:** the faces live in a **folder the host owns** (`core/font_library.py`, `config.FONT_DIR`,
default `fonts/` beside the app), exactly like the local TTML library. The sheet renders the folder;
the overlay fetches one face's bytes on demand, registers it with the FontFace API for the life of
the window, and persists nothing. `paprika_app.WindowApi` is the thin adapter, as it is for TTML.

**Tech stack:** Python 3.13 stdlib (`unittest`), pywebview 6.2.1 (Edge WebView2), vanilla JS/CSS in
`ui/`, `node --check`, the CDP-driven `tools/run-ui-preview-regression.mjs` at five viewports.

---

## Why files rather than the WebView store

The first version kept each import as a base64 data URL in `localStorage`. That store is quotad per
origin and a font is megabytes (base64 adds a third), which is why there was a `CUSTOM_FONT_LIMIT = 8`
and an 8 MB file cap — and why a large import could fail to save **silently**: `persistCustomFonts`
swallowed the quota error, so the font worked for the session and was gone after a restart. Removing
the cap honestly means removing the store from the path. A folder has no cap to enforce, and
`fonts/.trash` makes removal reversible instead of final.

## Tasks

- [x] **`config.py`** — `FONT_DIR = Path(os.getenv("SPICY_FONT_DIR") or (DATA_DIR / "fonts"))`, beside
      the cache and the TTML library, git-ignored (the folder writes its own `.gitignore` marker too).
- [x] **`core/font_library.py`** — one folder of `.ttf/.otf/.woff/.woff2` files:
      - `read_font_meta(data)` reads the `name` table (family 16/1, subfamily 17/2, Windows and
        English records preferred) plus `OS/2` (weight, italic) and `head.macStyle`, so a row says
        `Honk` rather than `Honk Regular VariableFont MORF,SHLN`, and the face is registered at the
        weight it was drawn at instead of a synthesized 700. WOFF2 (Brotli-compressed directory) and
        malformed files fall back to a cleaned file name — total, never raising.
      - `family_ids()` derives each file's CSS family from its own name with the same slug the old
        importer used, so a stored choice keeps naming a face. Two files sharing a stem fold the
        extension in rather than sharing one family.
      - `entries()`/`snapshot()` (no bytes), `data(rel)` (one data URL, path-checked against `..`),
        `add_files()` (copy, never overwrite, no cap, reports what it will not use), `adopt()` (the
        one-time handover from the store), `remove_file()` (`.trash`), `reveal()`.
- [x] **`paprika_app.py`** — `font_list`, `font_import` (multi-select native picker), `font_adopt`,
      `font_remove`, `font_reveal`, `font_data`; every mutation returns the whole snapshot plus a
      status line, and `_font_snapshot` degrades to an empty folder instead of raising.
- [x] **`ui/index.html`** — the Fonts group is a list: `Add font…` / `Open folder`, a status line, the
      list itself, and a hint that describes what the rows do (and never a ceiling).
- [x] **`ui/app.js`** — `BUILTIN_FACES` names one row per FACE (the stock `System` is two ids in two
      tables with one stack), the catalog adds the folder's entries, each row is drawn in its own
      face, a face offers only the jobs it can hold (`Barriecito` has no Interface button), one click
      applies, `Remove` arms then confirms, and an unreadable file is reported on its row and refused.
      `adoptLegacyFonts()` hands the old store's blobs over once and clears the key only after the
      host confirms. `CUSTOM_FONT_LIMIT`, `CUSTOM_FONT_MAX_BYTES` and the park/restore dance are gone.
- [x] **Tests** — `tests/test_font_library.py` (38: synthesized sfnt/WOFF fixtures, junk and truncated
      files, family ids, no-cap import, clash, data URLs, traversal, trash, adopt, snapshot);
      `FontApiTest` in `tests/test_window_api.py` (12); `FontDirTests` + the path/env tests in
      `tests/test_config_paths.py`.
- [x] **`tools/ui-preview-regression.js`** — the Fonts section now asserts the cap is gone (constant
      and prose), six stock rows each drawn in its own face, the role rules, the active marking, a
      click applying a face, and — against a stub bridge — the folder's rows, the on-demand
      `font_data` fetch, an unreadable face marked and refused, `Remove` arming before it removes,
      `Add font…`/`Open folder` reaching the host, and the host's status text reaching the sheet.
- [x] **Docs** — README feature bullet + a Fonts section, `.env.example` (`SPICY_FONT_DIR`),
      `.gitignore` (`fonts/`).

## Verification

- `node --check` clean on `ui/app.js` and both tools.
- UI regression: **5/5 viewports PASS, 305 checks each** (was 286; the two failures it caught during
  development were real — built-in rows lost their table ids and drew in the UI font, and the Remove
  check was reading a stale row).
- `python -m unittest discover -s tests`: **558 tests OK** (was 505).
- Live in a browser, with the real `Honk-Regular-VariableFont_MORF,SHLN.ttf`: the row showed `Honk`
  (family read from the font), the face registered (`document.fonts` status `loaded`,
  `fonts.check('16px <family>')` true, glyph widths 212 vs 240 against the fallback), applying it set
  `--lyric-font-family`, `Remove` armed and then removed it and fell the lyrics back to `System`, and
  the legacy handover adopted a `sl_customFonts` entry under its stored id and cleared the key.
