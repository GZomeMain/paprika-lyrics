# Song moments, a tabbed settings sheet, and the fullscreen lyric column

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the three things the user asked for true in the running overlay: in fullscreen the lyric column starts on the card's own column instead of hugging the window edge, the settings sheet is reachable by name through four tabs and one search field, and a drop or a chorus hook now makes the room step back and warm instead of passing like any other bar.

**Architecture:** All three are UI-only (`ui/*`), and all three are the same shape: one decision in JS, one number published to CSS, and the preview gate extended before the code that satisfies it. The lyric column is one fullscreen rule. The sheet is a static restructure of `#quick-panel` into `role=tabpanel`s plus a filter that clones live rows into a results view — the resolve report is deliberately outside it. The moments effect adds a pure maths layer (`momentHooks`, `momentStarts`) over the rhythm plan and the existing chorus flags, a small state machine next to the beat engine, and two grade layers whose every animated property is one nobody else owns (see the ownership table in the spec).

**Tech Stack:** vanilla JS/CSS front end, pywebview 6.2.1 (Edge WebView2), `unittest`, `node --check`, `tools/ui-preview-regression.js` driven from the Browser panel at five viewports.

**Spec:** `docs/superpowers/specs/2026-09-30-moments-and-settings-design.md`.

## Global Constraints

- **Do not commit, push, branch or stash.** The working tree holds uncommitted work from earlier turns (the TTML library feature, two window-fix batches, the phase-1 window polish) in *the same files this plan edits*. Each task ends with a `git diff --stat` checkpoint instead. Say so if you want a commit — the user decides what goes in it.
- Stay on `master` (the repo has no remote; all prior work is direct-to-master). Confirmed with the user.
- **Test runner is `unittest`, never pytest:** `python -m unittest discover -s tests`, filtered with `grep -E "^(OK|FAILED|Ran )"`. Baseline before this plan: **330 tests, OK** — and this plan adds no Python, so it must end at 330 too.
- JS gate after every UI edit: `node --check ui/app.js && node --check tools/ui-preview-regression.js`.
- Every UI change is gated by `tools/ui-preview-regression.js` at 1400×900, 900×700, 800×600, 360×420 and 330×380, and each task adds its assertion **before** the code that satisfies it.
- Do not rename the JS globals the tool pushes state through: `setFullscreen`, `setMiniMode`, `setClickThrough`, `cycleLayout`, `applyWindowOpacity`, `windowAlphaTarget`, `updateArtProgress`, `setTrackDuration`, `refreshTtml`, `renderTtmlPanel`, `setSyllableState`, `setMiniBarRevealed`, `setBeatPhase`. Do not change row ids (`qp-opacity`, `qp-latency`, `qp-ttml-*`, …) or the inline handlers on them.
- Copy rule: comments explain *why* a thing is the way it is, in the repo's existing voice (see the headers in `ui/app.js` and `ui/style.css`). No `TODO`, no placeholders, no "handle edge cases".
- User-facing copy stays sentence case, uses typographic quotes (“…”) inside prose, and never says "please". The sheet's hint prose keeps its current wording unless a task says otherwise.
- Nothing here changes Python, the native seam, or the host; the README smoke list is the manual gate for the parts a browser cannot show (a real drop on a real track, the native window).

---

## File structure

| File | Responsibility after this plan |
| --- | --- |
| `ui/style.css` | The fullscreen lyric gutter; the tab strip and search row; the moment wash, the sleeve halo, the line bloom, and the `--cover-zoom` multiplier inside the existing drift keyframes. |
| `ui/index.html` | `#quick-panel` becomes a search row + a tab strip + four panels; the new **Big moments** row lives in the Visuals panel. |
| `ui/app.js` | Tab state and persistence, the search filter, `momentHooks`/`momentStarts`, the moment state machine and engine, `cycleMoments()`, the diagnostics `Moments` row. |
| `tools/ui-preview-regression.js` | Section 5 rewritten around tabs and search; section 6 gains the gutter check; new section 11 for the moments. |
| `README.md` | The Settings row, the moments feature, the fullscreen column, and the smoke list. |

---

### Task 1: The fullscreen lyric column starts on the card's column

**Files:**
- Modify: `ui/style.css` (the fullscreen block), `tools/ui-preview-regression.js` (section 6)

**Interfaces:**
- Produces: computed `padding-left` of `#lyrics-container` is `68px` with `body.is-fullscreen` and `28px` without it, at every viewport.

**Why:** the lyrics start at x=28 everywhere, but in fullscreen the card row is pinned at `left: 84px` with a 96px sleeve. The two columns are 56px apart with nothing relating them, so the card reads as an overlay parked on top of the lyrics rather than the head of the same block. 68px puts the type column 16px outside the sleeve's left edge — the sleeve sits inside the column the lyrics belong to.

- [ ] **Step 1: Add the failing assertion**

In `tools/ui-preview-regression.js`, section 6, read the gutter both ways and restore the state the section had:

```js
  // The lyric column belongs to the same block as the card: in fullscreen the
  // gutter moves out to the card's own column (the sleeve starts at 84px, so the
  // type starts 16px outside it), and returns to the windowed gutter with it.
  setFullscreen(false);
  result.windowedLyricGutter =
    Math.round(parseFloat(getComputedStyle(lyrics).paddingLeft));
  setFullscreen(true);
  result.fullscreenLyricGutter =
    Math.round(parseFloat(getComputedStyle(lyrics).paddingLeft));
  if (result.windowedLyricGutter !== 28) {
    problems.push('windowed lyric gutter is ' + result.windowedLyricGutter + ', expected 28');
  }
  if (result.fullscreenLyricGutter !== 68) {
    problems.push('fullscreen lyric gutter is ' + result.fullscreenLyricGutter + ', expected 68');
  }
```

(`lyrics` is the same `#lyrics-container` element the section already holds; if the section reads it by id, reuse that.)

- [ ] **Step 2: Run it to make sure it fails**

Open `http://127.0.0.1:8471/ui/index.html` from the repo root (a `python -m http.server 8471` is normally already running), eval the tool, then `await run('gutter')`.
Expected: FAIL — `fullscreen lyric gutter is 28, expected 68`.

- [ ] **Step 3: Implement the rule**

In `ui/style.css`, in the fullscreen group next to `body.is-fullscreen .track-float`:

```css
/* Fullscreen: the card row is pinned at 84px, so the lyric column moves out to
   meet it — 68px puts the type's left edge 16px outside the sleeve's, which
   makes the card the head of the lyric column instead of an overlay parked over
   it. Windowed layouts keep the 28px gutter they were composed against, and the
   container's own padding-left transition eases the move in both directions. */
body.is-fullscreen #lyrics-container {
  padding-left: 68px;
}
```

- [ ] **Step 4: Run the gate**

`node --check ui/app.js && node --check tools/ui-preview-regression.js`, then the tool at 1400×900, 900×700, 800×600, 360×420, 330×380.
Expected: `PASS` with `windowedLyricGutter 28` and `fullscreenLyricGutter 68` at every size.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/style.css tools/ui-preview-regression.js
```

---

### Task 2: The settings sheet becomes four tabs

**Files:**
- Modify: `ui/index.html` (`#quick-panel`), `ui/style.css` (the sheet block), `ui/app.js` (`openSettings`, new `openSettingsTab`/`initSettingsTabs`, boot), `tools/ui-preview-regression.js` (section 5)

**Interfaces:**
- Produces: DOM contract — `.sp-tabs[role=tablist]` with four `.sp-tab[role=tab]` (`data-tab` = `window` | `lyrics` | `visuals` | `diag`), four `.sp-panel[role=tabpanel]` (`#qp-panel-<id>`), exactly one selected, one tab stop.
- Produces: JS `openSettingsTab(id)`, `initSettingsTabs()`, and the persisted key `settingsTab`.
- Consumes: the existing `Settings` helper, `setValueText`, `refreshTtml`, and every existing row id.

**Why:** six stacked groups means the latency stepper — the row most often touched mid-song — lives below every window row, and nothing in the sheet can be reached by name. Tabs make the sheet a set of short pages, which is also the only structure search can then flatten.

- [ ] **Step 1: Rewrite the section 5 assertions**

Replace `result.settingsOrder` and its `expectedOrder` check with the tab contract, and scope the existing alignment reads to the rendered panel:

```js
  panel.classList.add('open');
  const tabs = [...document.querySelectorAll('#quick-panel .sp-tab')];
  result.settingsTabs = tabs.map((t) => t.textContent.trim());
  const expectedTabs = ['Window', 'Lyrics', 'Visuals', 'Diagnostics'];
  if (JSON.stringify(result.settingsTabs) !== JSON.stringify(expectedTabs)) {
    problems.push('settings tabs are ' + result.settingsTabs.join(' / ') +
      ' (expected ' + expectedTabs.join(' / ') + ')');
  }
  // Every tab must open on the groups it claims, in the order it claims them:
  // the sheet is now a set of short pages, and this is what says which page a
  // row lives on.
  const expectedTabGroups = {
    window: ['Window'],
    lyrics: ['Sync', 'Lyrics', 'Local lyrics'],
    visuals: ['Motion'],
    diag: ['Diagnostics'],
  };
  result.settingsTabGroups = {};
  for (const tab of tabs) {
    const id = tab.dataset.tab;
    openSettingsTab(id);
    result.settingsTabGroups[id] = [...document.querySelectorAll('#qp-panel-' + id + ' .sp-group-title')]
      .map((h) => h.textContent.trim());
    if (JSON.stringify(result.settingsTabGroups[id]) !== JSON.stringify(expectedTabGroups[id])) {
      problems.push('tab ' + id + ' holds ' + result.settingsTabGroups[id].join(' / ') +
        ' (expected ' + expectedTabGroups[id].join(' / ') + ')');
    }
  }
  // A tablist has one tab stop and one selection, and its controls/labels pair
  // back to the panels — otherwise a screen reader announces a tab that points
  // nowhere.
  result.settingsTabWiring = tabs.every((t) => {
    const p = document.getElementById(t.getAttribute('aria-controls'));
    return p && p.getAttribute('aria-labelledby') === t.id;
  }) && tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length === 1 &&
    tabs.filter((t) => t.tabIndex === 0).length === 1;
  if (!result.settingsTabWiring) problems.push('the settings tablist is wired wrong');
  openSettingsTab('window');
  // A hidden panel reports zero rects, so the column check has to read the rows
  // of the panel that is up.
  const shown = document.querySelector('#quick-panel .sp-panel:not([hidden])');
  const labels = [...shown.querySelectorAll('.qp-row .qp-label')];
```

Then the existing label-left, `settingsLabelAlignedWithTitle`, `settingsHints`, `settingsFits`, `sheetCentered`, `rowMinH` reads run unchanged, except the group-title read must come from `shown` too:

```js
  const groupTitle = shown.querySelector('.sp-group-title');
```

- [ ] **Step 2: Run it to make sure it fails**

Expected: FAIL — `settings tabs are` (no `.sp-tab` elements yet).

- [ ] **Step 3: Restructure `ui/index.html`**

Between `</header>` and `<div class="sp-body">`, add the search row (Task 3 fills in its behaviour; the markup lands here so the tab strip is not restructured twice) and the tab strip:

```html
        <!-- One filter over every page below it. The sheet is short pages now,
             so the field is how a row is reached when you know its name. -->
        <div class="sp-search">
          <label class="sp-search-field" for="qp-search">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>
            </svg>
            <input id="qp-search" type="search" placeholder="Search settings"
                   aria-label="Search settings" autocomplete="off" spellcheck="false">
            <button class="sp-search-clear" id="qp-search-clear" type="button"
                    aria-label="Clear search">&#10005;</button>
          </label>
          <span class="sp-search-hint"><kbd>/</kbd></span>
        </div>

        <!-- Group-wise tabs. The groups are the same rows they always were; only
             the page they sit on changed, so nothing here has to know about a
             setting's own state. -->
        <div class="sp-tabs" id="qp-tabs" role="tablist" aria-label="Settings sections">
          <button class="sp-tab" role="tab" id="qp-tab-window" data-tab="window"
                  aria-controls="qp-panel-window" aria-selected="true" tabindex="0">Window</button>
          <button class="sp-tab" role="tab" id="qp-tab-lyrics" data-tab="lyrics"
                  aria-controls="qp-panel-lyrics" aria-selected="false" tabindex="-1">Lyrics</button>
          <button class="sp-tab" role="tab" id="qp-tab-visuals" data-tab="visuals"
                  aria-controls="qp-panel-visuals" aria-selected="false" tabindex="-1">Visuals</button>
          <button class="sp-tab" role="tab" id="qp-tab-diag" data-tab="diag"
                  aria-controls="qp-panel-diag" aria-selected="false" tabindex="-1">Diagnostics</button>
        </div>
```

Give the scrolling region the id the search filter works against — `<div class="sp-body" id="qp-body">` — and wrap the existing six `.sp-group` sections into the four panels, moving the markup unchanged (row ids, classes, hints and inline handlers all stay exactly as they are):

- `#qp-panel-window` → the `Window` group.
- `#qp-panel-lyrics` → `Sync`, `Lyrics`, `Local lyrics` in that order.
- `#qp-panel-visuals` → `Motion`.
- `#qp-panel-diag` → `Diagnostics`.

Each panel is `<div class="sp-panel" id="qp-panel-<id>" role="tabpanel" aria-labelledby="qp-tab-<id>">`, and the three inactive ones carry `hidden` in the markup so the sheet is correct before any script runs. Add an empty results container ahead of the panels:

```html
        <div class="sp-empty" id="qp-empty" hidden></div>
```

Update the block comment above `#quick-panel` (it currently explains the six-group ordering) to explain the four pages and the search field instead.

- [ ] **Step 4: Style the strip and the panels**

In `ui/style.css`, next to `.sp-head`/`.sp-body`:

```css
/* The tab strip is the sheet's own map: four short pages instead of one long
   scroll. It scrolls sideways rather than wrapping, so a 320px window keeps
   readable labels instead of two rows of squeezed ones. */
.sp-tabs {
  flex-shrink: 0;
  display: flex;
  gap: 6px;
  padding: 10px 12px 8px;
  overflow-x: auto;
  scrollbar-width: none;
}

.sp-tabs::-webkit-scrollbar { display: none; }

.sp-tab {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-muted);
  font-family: var(--ui-font);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur-2) var(--ease-fluid), color var(--dur-2) var(--ease-fluid),
              border-color var(--dur-2) var(--ease-fluid);
}

.sp-tab:hover { background: var(--hover-surface); color: #ffffff; }

.sp-tab[aria-selected="true"] {
  background: var(--active-surface);
  border-color: rgba(255, 255, 255, 0.16);
  color: #ffffff;
}

.sp-panel { display: flex; flex-direction: column; gap: 14px; }
.sp-panel[hidden] { display: none; }
```

`--r-pill` and `--active-surface` already exist. In the `@media (max-height: 420px)` block add `.sp-tabs { padding: 7px 9px 6px; }` so the chrome row does not eat a row of lyrics at 320×380.

- [ ] **Step 5: Wire the tabs in `ui/app.js`**

Next to `openSettings` (which owns the sheet's focus and opacity policy):

```js
// The sheet is four pages, and the last one read is where it opens next time —
// a row you set once (the TTML library) should not need finding again. The value
// is validated against the markup rather than trusted, the way motionStyle is.
let settingsTab = 'window';

function openSettingsTab(id) {
  const strip = document.getElementById('qp-tabs');
  if (!strip) return;
  const tabs = [...strip.querySelectorAll('.sp-tab')];
  const known = tabs.map((t) => t.dataset.tab);
  const want = known.includes(id) ? id : known[0];
  for (const tab of tabs) {
    const on = tab.dataset.tab === want;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    const panel = document.getElementById('qp-panel-' + tab.dataset.tab);
    if (panel) panel.hidden = !on;
  }
  settingsTab = want;
  Settings.set('settingsTab', want);
}

// Arrow keys move between tabs, Home/End jump to the ends — the ARIA tabs
// pattern, so the strip behaves like the control it claims to be.
function initSettingsTabs() {
  const strip = document.getElementById('qp-tabs');
  if (!strip) return;
  const tabs = [...strip.querySelectorAll('.sp-tab')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => openSettingsTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      const last = tabs.length - 1;
      let next = null;
      if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
      else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      if (next === null) return;
      e.preventDefault();
      openSettingsTab(tabs[next].dataset.tab);
      tabs[next].focus();
    });
  });
}
```

Call `initSettingsTabs();` in the boot block next to `initCursorIdle();`, restore the saved tab there:

```js
  const savedTab = Settings.get('settingsTab', 'window');
  openSettingsTab(savedTab);
```

and have `openSettings(true)` re-apply it after `refreshTtml();` so a tab whose content is re-read on open is the one actually shown:

```js
    openSettingsTab(settingsTab);
```

- [ ] **Step 6: Run the gate**

Expected: `PASS` at all five viewports with `settingsTabs`, `settingsTabGroups` per tab, `settingsTabWiring true`, one `settingsLabelLefts` value, `settingsTitleTextLeft` aligned, `settingsHints 3`, `rowMinH 28` at 360×420 and 330×380.

- [ ] **Step 7: Checkpoint**

```bash
git diff --stat ui/index.html ui/style.css ui/app.js tools/ui-preview-regression.js
```

---

### Task 3: One search field over every page

**Files:**
- Modify: `ui/app.js` (the filter), `ui/style.css` (the field, the mark, the empty state), `tools/ui-preview-regression.js` (section 5)

**Interfaces:**
- Produces: JS `runSettingsSearch(query)` and `markSettingsText(root, query)`; `#qp-search` focused by `/`; `Escape` clears before it closes.
- Consumes: the panels from Task 2. The results ARE the live rows — moved into
  the result sections while a query is up, put back in their recorded order on
  clear — never clones and never filtered into invisibility. (The task
  originally said "clones rows, never filters the live ones"; the build proved
  a clone wrong — duplicated ids, frozen state, handlers lost — so the
  mechanism was inverted and the plan corrected here.)

**Why:** four pages make a row reachable *if you know its page*. Search is what makes it reachable by name — and a match on a row's prose, not just its label, is the difference between finding the latency row and being told there is no such setting, because its label is "Latency" and the word you remembered was "timing".

- [ ] **Step 1: Add the failing assertions**

In section 5, after the tab checks:

```js
  // A label match comes back as the row itself, with the matched run marked.
  runSettingsSearch('opacity');
  const hits = [...document.querySelectorAll('#qp-body .sp-result .qp-row')];
  result.settingsSearchLabelHit = hits.map((r) => r.querySelector('.qp-label').textContent.trim());
  result.settingsSearchLabelMark = document.querySelector('#qp-body .sp-result .qp-mark')
    ? document.querySelector('#qp-body .sp-result .qp-mark').textContent : null;
  if (hits.length !== 1 || result.settingsSearchLabelHit[0] !== 'Window opacity') {
    problems.push('searching a label did not find its row: ' + result.settingsSearchLabelHit.join(','));
  }
  if (result.settingsSearchLabelMark !== 'opacity') {
    problems.push('the matched run is not marked in place: ' + result.settingsSearchLabelMark);
  }
  // A prose match is how the sync row is found at all: its label is "Latency",
  // and "timing" only appears in the hint under it.
  runSettingsSearch('timing');
  result.settingsSearchProseHit = document.querySelectorAll('#qp-body .sp-result:not(:empty)').length;
  result.settingsSearchProseMark = [...document.querySelectorAll('#qp-body .sp-result .qp-mark')]
    .map((m) => m.textContent);
  if (result.settingsSearchProseHit !== 1 || result.settingsSearchProseMark[0] !== 'timing') {
    problems.push('a prose match did not surface its sentence: ' + result.settingsSearchProseMark.join(','));
  }
  // The report is not a setting: searching its own wording must not drag it in.
  // The report is populated first, so this asserts against real report content
  // rather than an empty body that could not match anything anyway.
  window.setDiagnostics({ source: 'LRCLIB', cache: 'hit', lines: 42, syllables: 310 });
  runSettingsSearch('lrclib');
  result.settingsSearchIgnoresReport =
    document.querySelectorAll('#qp-body .sp-result .qp-info-row').length;
  result.settingsSearchReportOnlyEmpty = !document.getElementById('qp-empty').hidden;
  if (result.settingsSearchIgnoresReport !== 0 || !result.settingsSearchReportOnlyEmpty) {
    problems.push('the resolve report is still searchable');
  }
  window.setDiagnostics(null);
  runSettingsSearch('zzz-no-such-setting');
  result.settingsSearchEmpty = !document.getElementById('qp-empty').hidden;
  if (!result.settingsSearchEmpty) problems.push('an empty search shows no empty state');
  runSettingsSearch('');
  result.settingsSearchRestoresTab = document.getElementById('qp-panel-visuals').hidden === false;
  result.settingsSearchTabsReturn = document.getElementById('qp-tabs').hidden === false;
  if (!result.settingsSearchRestoresTab) problems.push('clearing the search did not restore the tab');
  if (!result.settingsSearchTabsReturn) problems.push('the tab strip did not come back after a search');
```

The section must visit the Visuals tab (via `openSettingsTab('visuals')`) before these lines, so the restore check has a tab to come back to.

- [ ] **Step 2: Run it to make sure it fails**

Expected: FAIL — `runSettingsSearch is not defined`.

- [ ] **Step 3: Implement the filter**

In `ui/app.js`, next to the tab code:

```js
// =========================================================
// Settings search
// Four pages make a row reachable if you know its page; this makes it reachable
// by name. The results are CLONES of the live rows rendered under their own
// group heading, so filtering can never write a state value back into the sheet,
// and a query that matched a hint shows that hint — the reason a row is on screen
// is readable instead of guessed at.
//
// The resolve report is deliberately outside this: it reports what the pipeline
// did, it is not a setting, and a query that named a lyric source should not drag
// four report lines into the results.
// =========================================================
let settingsQuery = '';

function settingsRowText(row) {
  return (row.textContent || '').toLowerCase();
}

// The rows a query can reach: the sheet's own rows, hints and TTML list, panel by
// panel so each result keeps the group heading it came from.
function settingsSearchableRows() {
  const out = [];
  for (const panel of document.querySelectorAll('#qp-body .sp-panel')) {
    for (const group of panel.querySelectorAll('.sp-group')) {
      const title = group.querySelector('.sp-group-title');
      const rows = [...group.children].filter((el) =>
        el.classList.contains('qp-row') || el.classList.contains('ttml-bar') ||
        el.classList.contains('ttml-status') || el.classList.contains('ttml-current') ||
        el.classList.contains('ttml-list') || el.classList.contains('sp-hint'));
      if (rows.length) out.push({ title: title ? title.textContent.trim() : '', rows });
    }
  }
  return out;
}

// Wraps the matched run by walking text nodes. A hint carries <code> and <kbd>,
// and rebuilding markup would either flatten that or invent structure, so the
// highlight is added to the text it is actually in.
function markSettingsText(root, query) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const at = text.toLowerCase().indexOf(query);
    if (at < 0 || !node.parentNode) continue;
    const mark = document.createElement('span');
    mark.className = 'qp-mark';
    mark.textContent = text.slice(at, at + query.length);
    const after = node.splitText(at + query.length);
    node.nodeValue = text.slice(0, at);
    node.parentNode.insertBefore(mark, after);
  }
}

function runSettingsSearch(raw) {
  const query = (raw || '').trim().toLowerCase();
  settingsQuery = query;
  const body = document.getElementById('qp-body');
  const empty = document.getElementById('qp-empty');
  const strip = document.getElementById('qp-tabs');
  const searchRow = document.querySelector('.sp-search');
  if (!body || !strip) return;

  for (const el of body.querySelectorAll('.sp-result')) el.remove();
  if (empty) empty.hidden = true;
  if (searchRow) searchRow.classList.toggle('has-query', query.length > 0);

  if (!query) {
    // Back to the page that was up: the strip is the sheet's map again.
    strip.hidden = false;
    openSettingsTab(settingsTab);
    return;
  }
  strip.hidden = true;
  for (const panel of body.querySelectorAll('.sp-panel')) panel.hidden = true;

  let matches = 0;
  for (const { title, group, rows } of settingsSearchableRows()) {
    const hits = rows.filter((row) => settingsRowText(row).includes(query));
    if (!hits.length) continue;
    matches += hits.length;
    settingsSearchHomes.push({ group, order: [...group.children] });
    const section = document.createElement('section');
    section.className = 'sp-group sp-result';
    const heading = document.createElement('h2');
    heading.className = 'sp-group-title';
    heading.textContent = title;
    section.appendChild(heading);
    for (const row of hits) {
      // The mark is lifted on the way home, so the row serves clean on its own
      // page afterwards; the mark goes where the match actually is: a label when
      // the row has one and the label is what matched, otherwise anywhere in the
      // row — a hint that matched through its prose shows ITS sentence marked,
      // and the file list shows the file the query named.
      const label = row.querySelector('.qp-label');
      if (label && settingsRowText(label).includes(query)) markSettingsText(label, query);
      else markSettingsText(row, query);
      section.appendChild(row);
    }
    body.appendChild(section);
  }

  if (!matches && empty) {
    empty.hidden = false;
    empty.textContent = '';
    const lead = document.createElement('p');
    lead.textContent = `No settings match \u201c${raw.trim()}\u201d.`;
    const tail = document.createElement('p');
    tail.textContent = 'Local .ttml files live under Lyrics.';
    empty.appendChild(lead);
    empty.appendChild(tail);
  }
}
```

Wire it where the tabs are wired (`initSettingsTabs`):

```js
  const search = document.getElementById('qp-search');
  const clear = document.getElementById('qp-search-clear');
  if (search) {
    search.addEventListener('input', () => runSettingsSearch(search.value));
    search.addEventListener('keydown', (e) => {
      // Escape backs out of the query first: the sheet is open because the query
      // is a layer inside it, and a stray Escape should not close the whole sheet
      // while a search is up.
      if (e.key === 'Escape' && search.value) {
        e.stopPropagation();
        search.value = '';
        runSettingsSearch('');
      }
      if (e.key === 'ArrowDown') {
        const first = document.querySelector('#qp-body .sp-result .qp-row, #qp-body .sp-result .ttml-act');
        if (first) { e.preventDefault(); first.focus(); }
      }
    });
  }
  if (clear) clear.addEventListener('click', () => {
    search.value = '';
    runSettingsSearch('');
    search.focus();
  });
```

and in the document-level keydown handler that already owns `Escape`, `F11` and the Tab trap, add the `/` shortcut:

```js
  // `/` is the field's own shortcut while the sheet is up — the sheet has no
  // scroll position or text selection worth protecting, and it is the fastest way
  // back to a row you know the name of.
  if (e.key === '/' && document.body.classList.contains('settings-open') &&
      document.activeElement !== document.getElementById('qp-search')) {
    e.preventDefault();
    const field = document.getElementById('qp-search');
    if (field) field.focus();
  }
```

`openSettings(false)` must also reset the filter, so a sheet reopened tomorrow does not greet the user with yesterday's query:

```js
    if (searchEl) { searchEl.value = ''; runSettingsSearch(''); }
```

- [ ] **Step 4: Style the field, the mark and the empty state**

```css
/* The search field is the sheet's other map: a row whose page you have forgotten
   is still one word away. It sits above the strip, so the strip hides while a
   query is up — results are a different view, not a fifth page. */
.sp-search {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 0;
}

.sp-search-field {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: var(--r-md);
  background: rgba(255, 255, 255, 0.04);
  transition: border-color var(--dur-2) var(--ease-fluid), background var(--dur-2) var(--ease-fluid);
}

.sp-search-field:focus-within {
  border-color: rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.07);
}

.sp-search-field .icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  opacity: 0.45;
}

.sp-search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: #ffffff;
  font-family: var(--ui-font);
  font-size: 12px;
}

.sp-search input::placeholder { color: rgba(255, 255, 255, 0.34); }

.sp-search-clear {
  display: none;
  border: none;
  background: transparent;
  color: var(--icon-idle);
  cursor: pointer;
  padding: 0 2px;
  font-family: var(--ui-font);
  font-size: 13px;
  line-height: 1;
}

.sp-search.has-query .sp-search-clear { display: block; }

.sp-search-hint { flex-shrink: 0; font-size: 10px; color: var(--text-muted); }
.sp-search-hint kbd {
  font-family: inherit;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: var(--r-xs);
  padding: 1px 5px;
}

/* The mark says WHY a row is on screen: a row that only matched through its own
   prose shows that sentence with the word lifted out of it. */
.qp-mark {
  background: rgba(255, 200, 120, 0.22);
  color: #ffffff;
  border-radius: var(--r-xs);
  padding: 0 2px;
}

.sp-empty {
  padding: 22px 12px;
  text-align: center;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-muted);
}

.sp-empty[hidden] { display: none; }
.sp-empty p { margin: 0; }
```

In the `@media (max-height: 420px)` block add `.sp-search { padding: 7px 10px 0; }`, `.sp-search-field { min-height: 26px; }` and `.sp-search-hint { display: none; }` so the chrome fits above the 28px rows at 320×380 without eating a lyric row.

- [ ] **Step 5: Run the gate**

Expected: `PASS` at all five viewports with `settingsSearchLabelHit ['Window opacity']`, `settingsSearchLabelMark 'opacity'`, `settingsSearchProseHit 1`, `settingsSearchProseMark ['timing']`, `settingsSearchIgnoresReport 0`, `settingsSearchEmpty true`, `settingsSearchRestoresTab true`, `settingsSearchTabsReturn true`.

- [ ] **Step 6: Look at it**

In the Browser panel at 1400×900 and at 360×420: type `ttml`, `latency`, `motion` and `zzz`; confirm the results read as a list under their group headings, the mark lands on the word you typed, the empty state names what you typed, and clearing puts the Visuals tab back if that is where you were.

- [ ] **Step 7: Checkpoint**

```bash
git diff --stat ui/app.js ui/style.css tools/ui-preview-regression.js
```

---

### Task 4: Which moments exist — the maths

**Files:**
- Modify: `ui/app.js` (pure functions only), `tools/ui-preview-regression.js` (new section 11)

**Interfaces:**
- Produces: `momentHooks(lines, gapMs, hooks) -> number[]` (line indices), `momentStarts(lines, plan, hooks) -> {ms, endMs, kind, strength}[]` sorted by `ms`.
- Consumes: `lines[i].isChorus`, `.startTimeMs`, `.endTimeMs` from the parser/`detectChorusSections`; `plan.phases` entries `[startMs, endMs, kind, level]`.

**Why:** the rhythm plan already knows where a drop is and how hard it lands (`phases` carries the level), and the chorus flags already know which lines are hooks — but a hook is currently a *flag on eight consecutive lines*, so firing on the flag would fire eight times. The missing piece is arrivals, and it is pure maths, which is what makes it testable without a song.

- [ ] **Step 1: Add the failing assertions**

New section 11 at the end of `tools/ui-preview-regression.js`, before the final return:

```js
  // --- 11. moments: which ones, and how hard -----------------------------
  // Pure maths over synthetic input: the plan and the lyrics are the only inputs,
  // so the merge, the de-duplication and the arrival rule can be pinned down
  // without a track playing.
  const fixtureLines = [
    { startTimeMs: 0, endTimeMs: 2000, isChorus: false },
    { startTimeMs: 2000, endTimeMs: 4000, isChorus: true },
    { startTimeMs: 4000, endTimeMs: 6000, isChorus: true },
    { startTimeMs: 6000, endTimeMs: 8000, isChorus: true },
    { startTimeMs: 12000, endTimeMs: 14000, isChorus: false },
    { startTimeMs: 14000, endTimeMs: 16000, isChorus: true },
    { startTimeMs: 40000, endTimeMs: 42000, isChorus: true },
  ];
  const fixturePlan = {
    periodMs: 500, phaseMs: 0, bpm: 120,
    runs: [[0, 20000, 0.6], [20000, 30000, 1], [40000, 50000, 0.8]],
    phases: [[20000, 30000, 'drop', 1], [0, 10000, 'build', 0.4]],
    stats: { builds: 1, drops: 1, coherence: 0.9 },
  };
  const hooks = momentHooks(fixtureLines);
  result.momentHooks = hooks;
  // One arrival per chorus block: lines 1-3 are one hook, 5 is the next one
  // (a 6s gap), 6 is the one after that (14s later).
  if (JSON.stringify(hooks) !== JSON.stringify([1, 5, 6])) {
    problems.push('moment hooks are ' + hooks.join(',') + ' (expected 1,5,6)');
  }
  const starts = momentStarts(fixtureLines, fixturePlan);
  result.momentStarts = starts.map((m) => m.kind + '@' + m.ms);
  // In track order, not grouped by kind: the list is a timeline the engine walks.
  if (JSON.stringify(result.momentStarts) !== JSON.stringify(['hook@2000', 'hook@14000', 'drop@20000', 'hook@40000'])) {
    problems.push('moment starts are ' + result.momentStarts.join(','));
  }
  // A hook arriving inside an open drop is the drop, not a second moment.
  const insideDrop = momentStarts(
    [{ startTimeMs: 24000, endTimeMs: 26000, isChorus: true }], fixturePlan);
  result.momentHookInsideDrop = insideDrop.map((m) => m.kind);
  if (JSON.stringify(result.momentHookInsideDrop) !== JSON.stringify(['drop'])) {
    problems.push('a hook inside a drop fired again: ' + result.momentHookInsideDrop.join(','));
  }
  // No plan: hooks still arrive, at a neutral strength, with a fixed hold.
  const noPlan = momentStarts(fixtureLines, null);
  result.momentStartsWithoutPlan = noPlan.map((m) => m.kind + '@' + m.ms);
  result.momentNeutralStrength = noPlan.every((m) => m.strength > 0 && m.strength <= 1);
  if (result.momentStartsWithoutPlan.length !== 3 || !result.momentNeutralStrength) {
    problems.push('hooks do not survive a track with no plan: ' + result.momentStartsWithoutPlan.join(','));
  }
  // A held moment has a ceiling, so a malformed plan cannot pin the grade on.
  result.momentHoldCap = Math.max(...starts.map((m) => m.endMs - m.ms));
  if (result.momentHoldCap > 8000) {
    problems.push('a moment can hold longer than the ceiling: ' + result.momentHoldCap);
  }
```

- [ ] **Step 2: Run it to make sure it fails**

Expected: FAIL — `momentHooks is not defined`.

- [ ] **Step 3: Implement**

In `ui/app.js`, next to `detectChorusSections` (which produces the `isChorus` field these read):

```js
// =========================================================
// Song moments: where they are
// Two things in this app already know when something happens — the rhythm plan
// knows where a drop lands and how hard (its phases carry the level the pulse
// reaches), and the chorus detector knows which lines are hooks. Neither is a
// moment on its own: a hook is a FLAG on a repeated line, so a chorus can carry
// eight of them, and firing on the flag would fire eight times at the same
// arrival. This layer turns both into arrivals, and it is pure: the lines and the
// plan go in, the moments come out.
// =========================================================
const MOMENT_HOOK_GAP_MS = 3500;   // a gap this long ends a hook block
const MOMENT_HOOK_HOLD_MS = 4000;  // no plan to read a length from
const MOMENT_MAX_HOLD_MS = 8000;   // no moment outstays this, whatever the plan says
const MOMENT_NEUTRAL_STRENGTH = 0.7;

// The index of every chorus line that STARTS a hook block. A hook block is
// continuous: two or more non-chorus lines between two hooks, or a silence longer
// than gapMs, means the first block ended and a new one began. Adjacent chorus
// lines therefore never re-fire — a hook is an arrival, not a flag.
function momentHooks(lines, gapMs = MOMENT_HOOK_GAP_MS) {
  const out = [];
  let prev = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].isChorus) continue;
    const separate = prev < 0 || (i - prev) >= 3 ||
      ((lines[i].startTimeMs || 0) - (lines[prev].endTimeMs || 0)) > gapMs;
    if (separate) out.push(i);
    prev = i;
  }
  return out;
}

// The run strength at `ms`, so a hook grades with the music around it; a track
// with no plan gets the neutral grade, which is a result, not a fallback bug.
function momentStrengthAt(plan, ms) {
  const runs = plan && plan.runs;
  if (!runs) return MOMENT_NEUTRAL_STRENGTH;
  for (const [start, end, level] of runs) {
    if (ms < start) break;
    if (ms <= end) return Math.max(0, Math.min(1, level));
  }
  return MOMENT_NEUTRAL_STRENGTH;
}

// Every moment in the track, in order. Drops come straight from the plan's phase
// spans; hooks come from the line indices above, and a hook that arrives while a
// drop is open is the drop — one arrival, one moment.
function momentStarts(lines, plan) {
  const out = [];
  const phases = (plan && plan.phases) || [];
  for (const phase of phases) {
    const kind = phase[2];
    if (kind !== 'drop') continue;
    const startMs = phase[0];
    const holdMs = Math.min(MOMENT_MAX_HOLD_MS, Math.max(0, phase[1] - startMs));
    out.push({ ms: startMs, endMs: startMs + holdMs, kind: 'drop',
               strength: Math.max(0, Math.min(1, phase[3] || 0)) });
  }
  const hookLines = lines || [];
  for (const index of momentHooks(hookLines)) {
    const line = hookLines[index];
    const startMs = line.startTimeMs || 0;
    if (out.some((m) => startMs >= m.ms && startMs <= m.endMs)) continue;
    const holdMs = plan
      ? Math.min(MOMENT_MAX_HOLD_MS, Math.max(1000, 2 * plan.periodMs))
      : MOMENT_HOOK_HOLD_MS;
    out.push({ ms: startMs, endMs: startMs + holdMs, kind: 'hook',
               strength: momentStrengthAt(plan, startMs) });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}
```

- [ ] **Step 4: Run the gate**

Expected: `PASS` at all five viewports with `momentHooks [1,5,6]`, `momentStarts ['drop@20000','hook@2000','hook@14000','hook@40000']`, `momentHookInsideDrop ['drop']`, `momentStartsWithoutPlan` three hooks, `momentHoldCap <= 8000`.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/app.js tools/ui-preview-regression.js
```

---

### Task 5: The moment engine and the one number it publishes

**Files:**
- Modify: `ui/app.js` (state, `momentAt`, `updateMoment`, `startMomentEngine`/`stopMomentEngine`, the render hook, `stopBeatEngine` reset), `tools/ui-preview-regression.js` (section 11)

**Interfaces:**
- Produces: `momentsMode` (`'on' | 'bold' | 'off'`), `MOMENT_MODES`, `MOMENT_LABELS`, `MOMENT_DEPTH`, `momentPlan`, `momentIndex`, `momentLast`, `momentsFired`; `updateMoment(ms)`, `startMomentEngine()`, `stopMomentEngine()`, `momentAt(ms)`.
- Produces: body classes `moment-live`, `moment-attack`; the custom property `--moment-strength` (0..1).
- Consumes: `momentStarts` (Task 4), `beatPlan`, `lyrics`, `isPlaying`, `reducedMotion`, `miniMode`, and the same per-frame hook `updateBeatLive(ms)` is called from.

**Why:** the grade has to sit on the music's own clock, and the app already has exactly one such clock — the rhythm plan's grid, published as `--beat-ms`/`--beat-lead-ms`. This task adds the envelope and nothing visible: a drop attacks at the phase start and holds to its end, a hook eases in and holds two bars, and the single number is published *before* the class so the grade starts at the right depth instead of snapping to it a frame later, which is the same ordering the beat engine uses and for the same reason.

- [ ] **Step 1: Add the failing assertions**

In section 11, after the maths checks:

```js
  // The engine, driven directly: the tool owns beatPlan, lyrics and isPlaying in
  // this page, so a moment can be stepped through frame by frame.
  const savedPlan = beatPlan, savedPlaying = isPlaying, savedLines = lyrics;
  beatPlan = fixturePlan;
  lyrics = fixtureLines;
  isPlaying = true;
  const savedMode = momentsMode;
  momentsMode = 'off';
  startMomentEngine();
  updateMoment(25000);
  result.momentOffStrength = document.body.style.getPropertyValue('--moment-strength');
  result.momentOffLive = document.body.classList.contains('moment-live');
  if (result.momentOffLive || result.momentOffStrength) problems.push('moments run while Off');
  momentsMode = 'on';
  startMomentEngine();
  updateMoment(20100);
  result.momentLive = document.body.classList.contains('moment-live');
  result.momentAttack = document.body.classList.contains('moment-attack');
  result.momentStrength = parseFloat(document.body.style.getPropertyValue('--moment-strength'));
  if (!result.momentLive) problems.push('a drop did not put the grade up');
  if (!result.momentAttack) problems.push('a drop does not attack immediately');
  if (!(result.momentStrength > 0 && result.momentStrength <= 1)) {
    problems.push('moment strength is out of range: ' + result.momentStrength);
  }
  // Between moments the grade is down, and nothing is left on the body.
  updateMoment(35000);
  result.momentRestLive = document.body.classList.contains('moment-live');
  if (result.momentRestLive) problems.push('the grade stays up between moments');
  // Paused playback rests, exactly as the pulse does.
  isPlaying = false;
  updateMoment(20100);
  result.momentPausedLive = document.body.classList.contains('moment-live');
  if (result.momentPausedLive) problems.push('a paused track still grades');
  isPlaying = true;
  // Bold is deeper than Subtle at the same moment, and Off releases.
  momentsMode = 'bold';
  startMomentEngine();
  updateMoment(20100);
  result.momentBoldStrength = parseFloat(document.body.style.getPropertyValue('--moment-strength'));
  if (!(result.momentBoldStrength > result.momentStrength)) {
    problems.push('Bold is not deeper than Subtle: ' + result.momentBoldStrength);
  }
  momentsMode = 'off';
  startMomentEngine();
  updateMoment(20100);
  result.momentReleasedLive = document.body.classList.contains('moment-live');
  if (result.momentReleasedLive) problems.push('turning moments Off mid-song left the grade up');
  momentsMode = savedMode;
  beatPlan = savedPlan; lyrics = savedLines; isPlaying = savedPlaying;
  startMomentEngine();
```

- [ ] **Step 2: Run it to make sure it fails**

Expected: FAIL — `momentsMode is not defined`.

- [ ] **Step 3: Implement the engine**

In `ui/app.js`, directly after the beat engine block (it reads the same plan and the same playhead):

```js
// =========================================================
// Song moments: the envelope
// A drop attacks on the phase start and holds to its end; a hook eases in and
// holds two bars. --moment-strength is the whole intensity, registered like
// --beat-strength and read by the grade, the sleeve's halo and the line's bloom,
// so Subtle and Bold differ only by this number's multiplier.
// =========================================================
const MOMENT_MODES = ['on', 'bold', 'off'];
const MOMENT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
// Subtle deliberately whispers: a full-window grade reads far stronger than its
// number suggests, which is the same lesson the beat pulse's amplitudes encode.
const MOMENT_DEPTH = { on: 0.6, bold: 1 };
let momentsMode = 'on';
let momentPlan = null;     // the merged arrivals for the current track
let momentIndex = 0;       // cursor; the playhead usually walks forward
let momentLast = null;     // the moment the grade is currently on, or null
let momentsFired = { total: 0, drop: 0, hook: 0 };

// The moment containing `ms`, with the same forward-walking cursor the beat
// engine uses — a track holds tens of moments and the playhead moves forward.
function momentAt(ms) {
  const list = momentPlan;
  if (!list || !list.length) return null;
  let i = Math.min(momentIndex, list.length - 1);
  while (i > 0 && ms < list[i].ms) i--;
  while (i < list.length - 1 && ms > list[i].endMs) i++;
  momentIndex = i;
  const moment = list[i];
  return (ms >= moment.ms && ms <= moment.endMs) ? moment : null;
}

function stopMomentEngine() {
  // The cursor points into the old track's moments; a new track must not inherit
  // it. The counters are per track too — the report says what THIS track did.
  momentPlan = null;
  momentIndex = 0;
  momentLast = null;
  momentsFired = { total: 0, drop: 0, hook: 0 };
  const body = document.body;
  body.classList.remove('moment-live', 'moment-attack');
  body.style.removeProperty('--moment-strength');
}

function startMomentEngine() {
  stopMomentEngine();
  if (momentsMode === 'off' || reducedMotion || !lyrics || !lyrics.length) return;
  momentPlan = momentStarts(lyrics, beatPlan);
}

function updateMoment(ms) {
  const body = document.body;
  if (momentsMode === 'off' || reducedMotion || !isPlaying) {
    // Paused, unplanned or off: park the grade without tearing the state down, so
    // resuming does not need a re-render to come back.
    if (body.classList.contains('moment-live')) {
      body.classList.remove('moment-live', 'moment-attack');
      momentLast = null;
    }
    return;
  }
  const moment = momentAt(ms);
  if (!moment) {
    if (body.classList.contains('moment-live')) {
      body.classList.remove('moment-live', 'moment-attack');
      momentLast = null;
    }
    return;
  }
  if (moment !== momentLast) {
    momentLast = moment;
    momentsFired.total += 1;
    momentsFired[moment.kind] += 1;
  }
  // The number is published before the class, so the grade starts at the right
  // depth instead of snapping to it a frame later — the same ordering, and the
  // same reason, as the beat engine's strength write.
  const depth = MOMENT_DEPTH[momentsMode] || MOMENT_DEPTH.on;
  body.style.setProperty('--moment-strength', (moment.strength * depth).toFixed(2));
  body.classList.toggle('moment-attack', moment.kind === 'drop');
  body.classList.add('moment-live');
}
```

Then hook it up:

- In the function that already calls `updateBeatLive(ms)` every frame, call `updateMoment(ms)` on the next line — the two read the same playhead and belong to the same clock.
- Where the beat engine is stopped/started for a track change (the same place `stopBeatEngine()`/`startBeatEngine()` are called, next to `detectChorusSections` and the beat-plan install), call `stopMomentEngine()` and then `startMomentEngine()` after the plan and the lines are in place.
- `cycleMoments()` comes in Task 7; until then, `startMomentEngine()` is only reached from the track-change path and the boot block.

- [ ] **Step 4: Run the gate**

Expected: `PASS` with `momentOffLive false`, `momentLive true`, `momentAttack true`, `momentStrength` in (0,1], `momentRestLive false`, `momentPausedLive false`, `momentBoldStrength > momentStrength`, `momentReleasedLive false`.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/app.js tools/ui-preview-regression.js
```

---

### Task 6: What a moment looks like

**Files:**
- Modify: `ui/index.html` (the two moment layers), `ui/style.css` (`@property`s, the grade, the dim, the halo, the bloom, `--cover-zoom` inside the drift), `tools/ui-preview-regression.js` (section 11)

**Interfaces:**
- Consumes: `--moment-strength`, `moment-live`, `moment-attack` (Task 5), and the plan's `--beat-ms`/`--beat-lead-ms`.
- Produces: `.moment-wash` (the warm soft-light grade) and `.moment-dim` (the dim, the deeper vignette and the per-beat breathe), both new siblings of the backdrop at z-index 2; `--cover-zoom` read inside `cover-bloom-drift`; the sleeve's halo; the active line's bloom.

**Why:** the grade has to change the room without touching anything the beat pulse or the mouse already owns — the pulse owns the backdrop's opacity/scale and the artwork's transform, the drift owns the blurred layer's transform, the sleeve's `::after` is the hover scrim, and the sung spans own their `text-shadow`. Everything in this task uses a property that was free before it: two new layers, the drift's `--cover-zoom` multiplier, the wrap's unused `box-shadow`, and `.word-group`'s unused `text-shadow`.

The grade is **two** elements rather than one with pseudo-elements, and the reason is compositing rather than taste: an element with `opacity < 1` renders its subtree as an isolated group, so a `soft-light` child of the dim layer would blend with that group's own transparency and never see the artwork at all — it would paint as a plain warm tint. Two siblings in the app root's stacking context, each doing one job, keeps the blend on the cover where it belongs.

- [ ] **Step 1: Add the failing assertions**

In section 11:

```js
  // Two layers with one job each: the warm grade blends with the artwork, the dim
  // carries the deeper vignette and the breathe. Both sit UNDER the lyrics — this
  // is deliberately not a full-window blend pass over the glyphs.
  const grade = document.querySelector('.moment-wash');
  const dim = document.querySelector('.moment-dim');
  result.momentGradeCount = document.querySelectorAll('.moment-wash').length;
  result.momentDimCount = document.querySelectorAll('.moment-dim').length;
  result.momentLayerZ = [grade, dim].map((el) => (el ? getComputedStyle(el).zIndex : null));
  result.momentGradeBlend = grade ? getComputedStyle(grade).mixBlendMode : null;
  if (result.momentGradeCount !== 1 || result.momentDimCount !== 1) {
    problems.push('the moment needs exactly one grade layer and one dim layer');
  }
  if (result.momentLayerZ.some((z) => parseInt(z) >= 10)) {
    problems.push('a moment layer is painted over the lyrics: ' + result.momentLayerZ.join(','));
  }
  // soft-light is the whole reason B's grade reads on a black cover as well as a
  // white one; a plain overlay lifts the blacks instead of colouring them.
  if (result.momentGradeBlend !== 'soft-light') {
    problems.push('the grade does not blend with the artwork: ' + result.momentGradeBlend);
  }
  // Transitions are suspended for the whole run (the tool's own stylesheet), so
  // every read below is the settled target rather than a frame mid-flight.
  const wrap = document.getElementById('float-art-wrap');
  momentsMode = 'on';
  startMomentEngine();
  updateMoment(20100);
  result.momentWashOpacity = parseFloat(getComputedStyle(grade).opacity);
  result.momentDimOpacity = parseFloat(getComputedStyle(dim).opacity);
  result.momentCoverZoom = parseFloat(
    getComputedStyle(document.body).getPropertyValue('--cover-zoom').trim() || '1');
  result.momentHaloLive = getComputedStyle(wrap).boxShadow;
  if (!(result.momentWashOpacity > 0) || !(result.momentDimOpacity > 0)) {
    problems.push('a live moment does not raise both layers');
  }
  if (!(result.momentCoverZoom > 1)) problems.push('the recession pushes nothing in');
  if (!result.momentHaloLive || result.momentHaloLive === 'none') {
    problems.push('a live moment does not light the sleeve');
  }
  updateMoment(35000);
  result.momentWashRestOpacity = parseFloat(getComputedStyle(grade).opacity);
  result.momentDimRestOpacity = parseFloat(getComputedStyle(dim).opacity);
  result.momentHaloRest = getComputedStyle(wrap).boxShadow;
  result.momentCoverZoomRest = parseFloat(
    getComputedStyle(document.body).getPropertyValue('--cover-zoom').trim() || '1');
  if (result.momentWashRestOpacity >= result.momentWashOpacity) {
    problems.push('the grade does not come back down between moments');
  }
  if (result.momentDimRestOpacity >= result.momentDimOpacity) {
    problems.push('the dim does not come back down between moments');
  }
  if (result.momentHaloRest === result.momentHaloLive) {
    problems.push('the sleeve halo does not come back down between moments');
  }
  if (result.momentCoverZoomRest !== 1) problems.push('the recession does not relax');
  // Ownership is asserted by reading the rules themselves: no rule whose selector
  // mentions a moment may transform a layer the beat pulse owns, and the two
  // effects that carry the grade to the eye must exist as rules at all.
  const momentRules = [...document.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules]; } catch (e) { return []; }
  });
  const ruleText = momentRules.map((r) => (r.selectorText || '') + '{' +
    (r.style ? r.style.cssText : '') + '}').join('\n');
  result.momentRulesTouchingPulse = momentRules.filter((r) => r.selectorText &&
    r.selectorText.includes('moment') && /\.ambient-backdrop|\.track-art/.test(r.selectorText) &&
    /transform/.test(r.style ? r.style.cssText : '')).length;
  result.momentHaloRule =
    /body\.moment-live[^{]*\.(float-art-wrap|side-art-wrap)[^{]*\{[^}]*box-shadow/.test(ruleText);
  result.momentBloomRule =
    /body\.moment-live[^{]*\.line\.is-active[^{]*\.word-group[^{]*\{[^}]*text-shadow/.test(ruleText);
  // The breathe is asserted as a RULE rather than a computed animation, because
  // the run suspends animations: what matters is that the hold rides the same
  // grid variables the pulse is phase-locked to.
  result.momentBreatheRule =
    /body\.moment-live[^{]*\.moment-dim[^{]*\{[^}]*animation-duration[^}]*--beat-ms/.test(ruleText);
  if (result.momentRulesTouchingPulse) {
    problems.push('a moment rule transforms a layer the beat pulse owns');
  }
  if (!result.momentHaloRule) problems.push('no moment rule lights the sleeve');
  if (!result.momentBloomRule) problems.push('no moment rule blooms the active line');
  if (!result.momentBreatheRule) problems.push('the hold does not breathe on the beat grid');
```

- [ ] **Step 2: Run it to make sure it fails**

Expected: FAIL — `the moment needs exactly one grade layer and one dim layer`.

- [ ] **Step 3: Add the layers**

In `ui/index.html`, immediately after the `.ambient-backdrop` block:

```html
    <!-- The moment grade, as two siblings of the backdrop rather than layers
         inside it: they paint over the whole backdrop (grain included) while
         staying UNDER the card and the lyrics at z-index 10 and up, so the
         scenery steps back and warms and the sleeve and the line are what is
         left in front of it.

         Two elements rather than one with pseudo-elements, because the warm
         grade has to blend with the ARTWORK: a soft-light layer inside an
         element that carries opacity would blend with that element's own
         transparent group instead, and paint as a plain tint. Siblings share the
         app root's stacking context, so the blend reaches the cover. -->
    <div class="moment-wash" aria-hidden="true"></div>
    <div class="moment-dim" aria-hidden="true"></div>
```

- [ ] **Step 4: Style it**

In `ui/style.css`, next to the beat-pulse block:

```css
/* =========================================================
   Song moments: the grade
   C · Depth and B · Commit, folded into the beat system the app already has:
   the scenery recedes and warms, and the sleeve and the active line come forward
   WITHOUT either of them moving. The type never takes a second transform here —
   words and syllables already animate, and a moment that also scaled them would
   read as a different animation rather than a bigger moment.

   Every property below is free: the beat pulse owns the backdrop's opacity and
   scale and the artwork's transform, the drift owns the blurred layer's
   transform, the sleeve's ::after is the hover scrim.
   ========================================================= */
@property --moment-strength {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}

/* The recession's push-in. The drift keeps its own transform and this only
   supplies the scale it multiplies, so there is one transform on the layer and
   two reasons for it. */
@property --cover-zoom {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}

.moment-wash,
.moment-dim {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  opacity: 0;
  /* The release: a moment lets go slowly, which is what makes it read as the song
     exhaling rather than the effect cutting out. */
  transition: opacity var(--dur-4) var(--ease-fluid);
}

/* A drop attacks immediately — it lands ON the beat, and an eased rise would
   arrive behind it. Same rule the pulse uses for its own drop, same reason. */
body.moment-attack .moment-wash,
body.moment-attack .moment-dim {
  transition-duration: 90ms;
}

/* B's grade: the room warms. soft-light keeps a white cover from blowing out
   while still colouring a black one. */
.moment-wash {
  background: linear-gradient(160deg,
    rgba(255, 196, 142, 0.30),
    rgba(255, 120, 180, 0.18) 55%,
    transparent);
  mix-blend-mode: soft-light;
}

body.moment-live .moment-wash {
  opacity: calc(0.75 * var(--moment-strength, 0));
}

/* C's recession: a dim and a deeper vignette over the scrims the backdrop already
   carries, breathing once per beat while the moment holds. The animation rides
   the SAME grid variables the pulse is phase-locked to, so the room and the
   sleeve breathe on one clock, and its keyframes carry the strength too — an
   animation on opacity would otherwise flatten the depth the class set. */
.moment-dim {
  background:
    linear-gradient(180deg, rgba(6, 6, 10, 0.34), rgba(6, 6, 10, 0.08) 40%, rgba(6, 6, 10, 0.38)),
    radial-gradient(125% 95% at 50% 42%, transparent 26%, rgba(6, 6, 10, 0.44) 100%);
}

body.moment-live .moment-dim {
  opacity: calc(0.9 * var(--moment-strength, 0));
  /* Longhands, not the animation shorthand: a shorthand carrying var() serializes
     every one of its longhands empty, so the gate cannot read back which clock
     this breathe is locked to. */
  animation-name: moment-breathe;
  animation-duration: var(--beat-ms, 520ms);
  animation-timing-function: cubic-bezier(0.2, 0.9, 0.35, 1);
  animation-iteration-count: infinite;
  animation-delay: var(--beat-lead-ms, -90ms);
}

@keyframes moment-breathe {
  0%, 100% { opacity: calc(0.72 * var(--moment-strength, 0)); }
  16%      { opacity: calc(1.00 * var(--moment-strength, 0)); }
}

/* The multiplier is declared on the body, the way --beat-strength is: the drift
   below inherits it, and the transition runs where the value changes. It has to
   be declared inside the beat rule's own transition LIST, not beside it: that
   shorthand replaces the whole list, so a separate `body { transition: ... }`
   would silently drop --beat-strength's transition (or be dropped by it) the
   moment a track is driven. */
body.beat-on,
body.beat-bold {
  transition: --beat-strength var(--dur-4) var(--ease-fluid),
              --cover-zoom var(--dur-4) var(--ease-fluid);
}

body {
  transition: --cover-zoom var(--dur-4) var(--ease-fluid);
}

body.moment-live {
  --cover-zoom: calc(1 + 0.06 * var(--moment-strength, 0));
}

/* The sleeve's halo, not a lift: the on-art controls live inside the same wrap,
   so scaling it would shove the transport and the seek row sideways for the
   length of a drop. A warm shadow says "this is lit" without moving a pixel. */
body.moment-live .float-art-wrap,
body.moment-live .side-art-wrap {
  box-shadow:
    0 0 calc(26px * var(--moment-strength, 0)) rgba(255, 190, 130, 0.34),
    0 0 calc(64px * var(--moment-strength, 0)) rgba(255, 150, 110, 0.18);
  transition: box-shadow var(--dur-4) var(--ease-fluid);
}

/* The line comes forward without moving: the halo paints on the line's own
   wrapper, which carries no shadow today, so it composes with the per-syllable
   bloom instead of replacing it. */
body.moment-live .line.is-active .word-group {
  text-shadow:
    0 0 calc(14px * var(--moment-strength, 0)) rgba(255, 205, 150, 0.40),
    0 0 calc(38px * var(--moment-strength, 0)) rgba(255, 170, 120, 0.22);
}
```

Then change the drift keyframes to read the multiplier (all five waypoints; the loop keeps its 2.x baseline, so coverage is unchanged at any `--cover-zoom` the moment can reach):

```css
@keyframes cover-bloom-drift {
  0%   { transform: scale(calc(2.00 * var(--cover-zoom, 1))) translate3d(-1.6%, -1.0%, 0); }
  25%  { transform: scale(calc(2.06 * var(--cover-zoom, 1))) translate3d(0.8%, 1.3%, 0); }
  50%  { transform: scale(calc(1.97 * var(--cover-zoom, 1))) translate3d(1.7%, -0.6%, 0); }
  75%  { transform: scale(calc(2.05 * var(--cover-zoom, 1))) translate3d(-0.5%, 1.4%, 0); }
  100% { transform: scale(calc(2.01 * var(--cover-zoom, 1))) translate3d(-1.5%, 0.9%, 0); }
}
```

And in the reduced-motion block that already stops `.cover-art-blur` and `.ambient-backdrop`:

```css
.reduce-motion .moment-wash,
.reduce-motion .moment-dim,
.reduce-motion body.moment-live .moment-dim {
  animation: none;
  transition: none;
}
```

- [x] **Step 5: Run the gate and look at it**

`node --check` both files, then the tool at all five viewports. Expected: `PASS` with `momentGradeCount 1`, `momentDimCount 1`, `momentLayerZ ['2','2']`, `momentGradeBlend 'soft-light'`, both live opacities above zero, `momentCoverZoom > 1`, `momentHaloLive` set, `momentHaloRule true`, `momentBloomRule true`, `momentBreatheRule true`, `momentRulesTouchingPulse 0`, and at rest both opacities back to 0, `momentHaloRest` back to `none`, `momentCoverZoomRest 1`.

Then set the fixture plan and lines from step 1, call `updateMoment(20100)`, and screenshot at 1400×900: the room should be visibly dimmer and warmer than at rest, the sleeve should carry a warm halo, and the active line should bloom — with no movement in the words. Compare against treatments B and C in `docs/superpowers/specs/mockups/2026-09-30-song-moments.html`.

**Done 2026-09-30 (the screenshot pass, once capture healed).** Drove `window.loadLyrics` with the fixture data plus a warm synthetic cover so all three treatments had material: the soft-light wash had a mid-tone room to colour, the sleeve a wrap to halo, the line a word to bloom. Judgement, grounded in three stills at 1400×900 plus a 7 s recording through the whole arc (attack, hold, release; `momentsFired` counted exactly one drop):

- **B holds.** The wash warms the room directionally and the white cover does not blow out — the soft-light choice is right, and the 0.30/0.18 stops match the mockup's field.
- **C holds.** Between-moments reads measurably calmer than the drop; the corners deepen without going muddy.
- **The bloom is the strongest part.** Sung words glow against the dimmed room; no word moves.
- **Subtle (0.60) vs Bold (1.00) is a real difference** in wash, halo and bloom, because every channel scales with `--moment-strength` (`calc(Npx * var(--moment-strength))`), not just the two layers' opacity. Off vs Subtle is obvious.
- **No constants changed.** Depth 0.6/1, wash 0.75, dim 0.9, zoom 0.06, halo 26/64 px all stand — the grade reads as an event at Bold and stays tasteful at Subtle.
- Unverified by eye remains only the *breathe* (one hold oscillation per beat): it was suspended for the stills and the recording is 7 s of a 4 s hold, so the oscillation is in the recording but was not separately eyeballed.

- [ ] **Step 6: Checkpoint**

```bash
git diff --stat ui/index.html ui/style.css tools/ui-preview-regression.js
```

---

### Task 7: The Big moments row, and the report line

**Files:**
- Modify: `ui/index.html` (the Visuals panel), `ui/app.js` (`cycleMoments`, `syncSettingsPanel`, boot restore, the diagnostics rows), `tools/ui-preview-regression.js` (section 5 and 11)

**Interfaces:**
- Produces: `#qp-moments` row with `#qp-moments-state`, `cycleMoments()`, the persisted key `momentsMode`, and the `Moments` line in the resolve report.
- Consumes: `MOMENT_MODES`/`MOMENT_LABELS`/`momentsFired` (Task 5), `renderDiagnostics`, `syncSettingsPanel`.

**Why:** an effect nobody can turn off is a bug waiting to be reported; the row mirrors Beat sync exactly (same three states, same labels, same persistence) so the two intensity systems read as one family rather than two inventions. The report line exists so a track that never dropped says so out loud instead of leaving the user wondering whether the effect is broken.

- [ ] **Step 1: Add the failing assertions**

In section 5, after the tab checks:

```js
  // The moments row mirrors Beat sync: same states, same labels, and it has to be
  // reachable on the page it claims to live on.
  openSettingsTab('visuals');
  const momentsRow = document.getElementById('qp-moments');
  result.settingsMomentsOnVisuals = !!momentsRow;
  if (!momentsRow) problems.push('the Big moments row is not on the Visuals tab');
  const seen = [];
  for (let i = 0; i < 4; i++) {
    cycleMoments();
    seen.push(document.getElementById('qp-moments-state').textContent.trim());
  }
  result.momentsRowCycles = seen;
  if (JSON.stringify(seen) !== JSON.stringify(['Bold', 'Off', 'Subtle', 'Bold'])) {
    problems.push('the Big moments row cycles ' + seen.join(' -> '));
  }
```

In section 11:

```js
  // Off is honest: the grade is down and the engine holds no plan, so nothing is
  // left running behind the setting.
  momentsMode = 'off';
  startMomentEngine();
  result.momentOffPlan = momentPlan;
  if (result.momentOffPlan) problems.push('Off still builds a moment plan');
  momentsMode = 'on';
```

- [ ] **Step 2: Run it to make sure it fails**

Expected: FAIL — `the Big moments row is not on the Visuals tab`.

- [ ] **Step 3: Add the row and the handler**

In `ui/index.html`, in the Visuals panel's `Motion` group, after the Beat sync row:

```html
            <button class="qp-row qp-action" id="qp-moments" onclick="cycleMoments()">
              <span class="qp-label">Big moments</span>
              <span class="qp-state" id="qp-moments-state">Subtle</span>
            </button>
            <p class="sp-hint">Big moments step the scene back and warm it when a drop
              lands or a chorus hook arrives; the words themselves never move from it. Reduced
              motion and this row being Off both leave the track untouched.</p>
```

(That makes the sheet's hint count 4, so update `settingsHints` in section 5 from 3 to 4 — and say in the comment there that four hints now live across the pages: Window, Sync, Local lyrics, Motion.)

In `ui/app.js`, next to `cycleBeatMode()`:

```js
function cycleMoments() {
  const idx = MOMENT_MODES.indexOf(momentsMode);
  momentsMode = MOMENT_MODES[(idx + 1) % MOMENT_MODES.length];
  Settings.set('momentsMode', momentsMode);
  startMomentEngine();
  syncSettingsPanel();
  renderDiagnostics();
  // startMomentEngine clears the grade, so re-gate it now instead of waiting for
  // the next animation frame — otherwise a mode flip blanks the grade for a frame.
  wakeRenderLoop();
  if (lyrics.length > 0) renderProgress(playheadMs + latencyOffsetMs);
}
```

In `syncSettingsPanel()`, next to the Beat sync line:

```js
  setValueText(document.getElementById('qp-moments-state'), MOMENT_LABELS[momentsMode] || 'Subtle');
```

In the boot block, beside the beat mode restore:

```js
  const savedMoments = Settings.get('momentsMode', 'on');
  if (MOMENT_MODES.includes(savedMoments)) momentsMode = savedMoments;
```

In `renderDiagnostics()`, after the `Beat shape` row:

```js
    // Moments are a per-track result, like the beat plan: a track that never
    // dropped says so instead of leaving the effect looking broken.
    ['Moments', momentsMode === 'off' ? 'Off'
      : (momentsFired.total
        ? `${momentsFired.total} fired \u00b7 ${momentsFired.drop} drop(s) \u00b7 ${momentsFired.hook} hook(s)`
        : 'none yet')],
```

- [ ] **Step 4: Run the gate**

Expected: `PASS` with `settingsMomentsOnVisuals true`, `momentsRowCycles ['Bold','Off','Subtle','Bold']`, `settingsHints 4`, `momentOffPlan null`.

- [ ] **Step 5: Checkpoint**

```bash
git diff --stat ui/index.html ui/app.js tools/ui-preview-regression.js
```

---

### Task 8: Final pass and docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full gates**

```bash
python -m unittest discover -s tests 2>&1 | grep -E "^(OK|FAILED|Ran )"
node --check ui/app.js && node --check tools/ui-preview-regression.js && echo "JS OK"
grep -rn "settingsOrder" tools/ ui/ || echo "no stale settings order"
grep -rn "moment-live\|moment-wash" ui/style.css ui/app.js ui/index.html | head -20
```

Expected: `Ran 330 tests` / `OK`; `JS OK`; `no stale settings order`; the moment rules present in all three UI files.

- [ ] **Step 2: Preview regression at five viewports**

`python -m http.server 8471` from the repo root, open `http://127.0.0.1:8471/ui/index.html`, eval the tool, then `await run('<label>')` at 1400×900, 900×700, 800×600, 360×420 and 330×380. Expected `PASS` at every size. Bust a stale stylesheet with `document.querySelector('link[rel="stylesheet"]').href = 'style.css?v=' + Date.now()` and a stale script with a `?v=` on the page URL; if `app.js` looks stale in a long-lived tab, open a fresh incognito tab.

- [ ] **Step 3: README**

- **Settings page** row: the sheet is four tabs — **Window**, **Lyrics** (latency, translations, font, alignment and the local TTML library), **Visuals** (motion, motion style, beat sync, big moments) and the **Diagnostics** report — with a search field over the whole sheet (`/` to focus, the tab you were on comes back when you clear it). The resolve report is not searchable.
- Feature list, next to the beat-sync bullet: **Big moments** — a drop, or the first hook of a chorus, steps the scenery back and warms it while the sleeve takes a halo and the live line blooms; the words themselves never move from it, it respects reduced motion, and **Subtle / Bold / Off** lives in Settings under Visuals.
- **Fullscreen** row / layout notes: the lyric column starts on the card's own column (68px, 16px outside the sleeve) rather than at the window edge.
- Smoke checklist, for the parts only a real run settles: play a track with a known drop and a repeated chorus and confirm the grade lands on the drop, the sleeve haloes, the line blooms and the words do not move twice; turn Big moments Off mid-song and confirm the grade releases to stock; open the sheet at 320×380 and confirm four tabs plus the search field are usable and the rows are still compact.

- [ ] **Step 4: Checkpoint**

```bash
git status --short; git diff --stat
```

Expected: only files touched by this plan plus the pre-existing uncommitted work. Report the list and ask whether to commit — **do not commit or stage anything**.

---

## Self-review

**Spec coverage**

- *1 · The fullscreen lyric column* → Task 1.
- *2 · Settings: four tabs and one search field* → Tasks 2 (tabs, persistence, ARIA, responsive) and 3 (search, marks, empty state, keyboard, report exclusion).
- *3 · Big moments* → Task 4 (which moments), Task 5 (the envelope and the number), Task 6 (the look and the layer ownership), Task 7 (the row, the persistence, the report line).
- Spec gates → Task 1 `fullscreenLyricGutter`; Task 2 `settingsTabs`/`settingsTabGroups`/`settingsTabWiring` and the panel-scoped alignment; Task 3 every `settingsSearch*` key; Tasks 4–6 `momentHooks`/`momentStarts`/`momentClasses` (as `momentLive`, `momentAttack`, `momentRestLive`, `momentPausedLive`, `momentReleasedLive`), `momentStrength`, `momentWash*`; Task 7 `momentsRowCycles`.
- README and the manual smoke list → Task 8.

**Known gaps, called out honestly**

- The preview tool can prove the maths, the classes, the number's range, the layer ownership and the wash's rise and fall. It cannot prove the grade *looks* good on a real cover: the tuning (`MOMENT_DEPTH`, the wash's 0.55, the halo's radii) is a judgement call made against the mockups in a browser, and Task 6's screenshot step is where that judgement is recorded.
- Whether a drop in a real track reads as a moment rather than a flicker depends on `--beat-ms` and the phase length, which only real material shows. The plan keeps the numbers in named constants for exactly that reason.
- The search has no ranking: a query that matches a hint and a label returns both in page order. If that reads as noise in use, ranking label matches first is a small follow-up, not something to guess at now.
- Nothing here touches Python, so the native window questions parked in the previous plan (Aero Snap in the fallback move, DWM behaviour on a real desktop) are still open and still listed in the README smoke list.
