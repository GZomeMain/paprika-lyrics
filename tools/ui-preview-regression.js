/**
 * UI preview regression checks — paste into the browser devtools console
 * (or evaluate via the preview tooling) while serving the repo over HTTP:
 *
 *   python -m http.server 8471
 *
 * Then at each viewport size (resize the preview, run `run('label')`):
 *
 *   run('1400x900'); run('900x700'); run('800x600'); run('360x420'); run('330x380')
 *
 * Asserts the invariants behind the tracked card, the window chrome and the
 * motion system:
 *   1. Windowed art controls are layout / settings / fullscreen / mini; in
 *      fullscreen the exit replaces the windowed pair. The compact row and the
 *      split panel's row must agree on which ids are visible in a given state.
 *   2. The window has exactly three drag SURFACES windowed (top strip, track
 *      card, mini bar), nothing covers them at the pixels a user grabs, the seek
 *      bar and the transport opt out of the gesture, no element still carries
 *      pywebview's own drag marker, and fullscreen has no resize grips.
 *   3. The windowed card is anchored to the LEFT gutter by default — and centred
 *      when Card position says so — square, and ordered art -> seek row ->
 *      title -> artist, all left-aligned with the art; the lyric mask's top
 *      fade clears the card.
 *   4. The lyrics-only mini player hides the card/header/split panel and shows
 *      its own bar, whose buttons sit outside the drag region and stay hidden
 *      until the pointer reaches the top band.
 *   5. The settings sheet is centred, inside the window, its groups are ordered
 *      overlay-first, and the density token still compacts below 420px of height.
 *   6. The on-art progress bar publishes a playhead position for its dot.
 *   7. Motion: one variant per WORD (a split word never moves in two pieces),
 *      a waiting word leans in only as it approaches and clears after, the lean
 *      it reached is CONTINUED by the first sung frame (never dropped, never
 *      invented), and the line-level breath factor exists. Needs lyrics loaded
 *      to be meaningful.
 *   8. The local TTML panel renders one row per file with its state chip, and a
 *      row's "Use here" binds THAT file through the bridge (with the playing
 *      track's metadata). Driven against a stub bridge, since a plain browser
 *      has no Python behind it.
 *   9. Window transparency: the base opacity applies while windowed, the hover
 *      dip goes below it but never under the base, Ctrl and the settings sheet
 *      cancel only the dip, click-through keeps the base, and fullscreen is
 *      opaque.
 *  10. Transport honesty: an unpublished duration clears the labels and turns
 *      the seek rails inert instead of keeping the last track's length, the
 *      resolve report states what the player publishes, names the build that
 *      produced it, a refused seek is
 *      rolled back while an accepted one is kept, and a refusal that arrives
 *      after the seek already landed is ignored.
 *  11. Room air and cover tilt: the motes are laid out deterministically and are
 *      tinted with the album's colour, the air never takes a pointer event, and
 *      Off / reduced motion / the mini player leave the room stock; and the
 *      sleeve leans only because its own stage carries the tilt, with the beat's
 *      surfaces and the artwork's stacking order untouched.
 *  12. Artwork and air hygiene: a cover URL from a third-party lookup cannot
 *      break out of the CSS it is written into (a quote or a paren in it stays
 *      inside the url()), and rebuilding the air never stacks a second mote
 *      field on the first.
 *  12. Artwork and air hygiene: a cover URL from a third-party lookup cannot
 *      break out of the CSS it is written into (a quote or a paren in it stays
 *      inside the url()), and rebuilding the air never stacks a second mote
 *      field on the first.
 *
 * Transitions are suspended for the whole run: this measures settled geometry,
 * and a throttled preview can otherwise freeze a transition mid-flight and
 * report the value it was leaving (the card is 96px wide in fullscreen only
 * once its width transition has finished).
 *
 * Requires the page globals from app.js (`setFullscreen`, `updateArtProgress`,
 * `setTrackDuration`, `cycleLayout`), so run it against the served app.
 */
/*
 * Every CSS rule the page has loaded, flattened into one list.
 *
 * Six checks read rules back — the moment layers, the lyric scroller's chrome,
 * the accent, the lamp, the air and the tilt — and each one used to carry its own
 * copy of this walk, ``catch`` included. One helper means one definition of
 * "the rules", and a sheet that refuses to be read is handled the same way
 * everywhere instead of six ways.
 */
function flattenSheetRules() {
  return [...document.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules]; } catch (e) { return []; }
  });
}

async function run(label) {
  const body = document.body;
  const isVisible = (el) => !!el && getComputedStyle(el).display !== 'none';
  // Ids differ only by the row prefix (art-btn- / side-btn-), so compare roles.
  const ids = (root) => [...document.querySelectorAll(root + ' .art-btn')]
    .filter(isVisible).map((b) => b.id.replace(/^(art-btn|side-btn)-/, '')).sort();
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
             width: r.width, height: r.height };
  };
  const problems = [];
  const result = { label, viewport: window.innerWidth + 'x' + window.innerHeight };

  const noAnim = document.createElement('style');
  noAnim.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(noAnim);

  const panel = document.getElementById('quick-panel');
  const wasFullscreen = body.classList.contains('is-fullscreen');
  const wasMini = body.classList.contains('mini');

  // --- 1. art controls --------------------------------------------------
  // Driven through the app's own state setter, not by poking classes: the
  // gating reads the isFullscreen/ miniMode variables, so a class poke would
  // assert against a state the app is not in.
  setFullscreen(false);
  result.windowedCompactIds = ids('#art-controls');
  const expectedWindowed = ['fs', 'layout', 'pip', 'settings'];
  if (JSON.stringify(result.windowedCompactIds) !== JSON.stringify(expectedWindowed)) {
    problems.push('windowed art controls are ' + result.windowedCompactIds.join(',') +
      ' (expected ' + expectedWindowed.join(',') + ')');
  }

  setFullscreen(true);
  result.fullscreenCompactIds = ids('#art-controls');
  result.fullscreenSideIds = ids('.side-art-controls');
  if (result.fullscreenCompactIds.includes('pip') || result.fullscreenCompactIds.includes('fs')) {
    problems.push('windowed-only controls survived into fullscreen');
  }
  if (!result.fullscreenCompactIds.includes('exit')) {
    problems.push('fullscreen has no exit button');
  }
  if (JSON.stringify(result.fullscreenCompactIds) !== JSON.stringify(result.fullscreenSideIds)) {
    problems.push('compact and split disagree on the fullscreen controls');
  }

  // --- 2. drag surfaces (the window's move affordance) ------------------
  // The gesture itself is native (a caption hit-test the host posts to the
  // window), so what a page can prove is the part that decides it: which elements
  // are surfaces, that nothing invisible covers them, and that the things which
  // own their own gesture are opted out.
  setFullscreen(true);
  result.fullscreenDragSurfaces = document.querySelectorAll('[data-drag]').length;
  result.fullscreenResizeGrips = [...document.querySelectorAll('.resize-handle')]
    .filter((h) => getComputedStyle(h).display !== 'none').length;
  if (result.fullscreenResizeGrips !== 0) problems.push('fullscreen still has resize grips');
  // Fullscreen refuses the gesture in JS, so the surfaces may stay marked; what
  // must not survive is pywebview's own selector — that path moved the window
  // from the page and could not see a no-drag opt-out.
  if (document.querySelector('.pywebview-drag-region')) {
    problems.push('a pywebview drag region is still marked');
  }

  setFullscreen(false);
  result.windowedDragSurfaces = [...document.querySelectorAll('[data-drag]')]
    .map((el) => el.id || el.className.split(' ')[0]);
  if (result.windowedDragSurfaces.length !== 3) {
    problems.push('windowed drag surfaces are ' + result.windowedDragSurfaces.join(',') +
      ' (expected the top strip, the card and the mini drag handle)');
  }
  // …and they do not advertise themselves with a web page's grab hand: a native
  // window never changes the pointer over its title bar either.
  result.dragSurfacesHaveNoGrabCursor = [...document.querySelectorAll('[data-drag]')]
    .every((el) => getComputedStyle(el).cursor !== 'grab' && getComputedStyle(el).cursor !== 'grabbing');
  if (!result.dragSurfacesHaveNoGrabCursor) {
    problems.push('a drag surface still shows the grab cursor');
  }
  // The opt-out never stomps the cursors of the controls inside it.
  result.seekBarKeepsItsCursor = getComputedStyle(document.getElementById('art-progress')).cursor === 'pointer';
  if (!result.seekBarKeepsItsCursor) problems.push('the seek bar lost its pointer cursor');
  // The seek bar and the transport must opt out, or a mousedown on them would
  // move the window instead of seeking / playing.
  result.seekOptsOut = !!document.querySelector('#art-progress')?.closest('[data-no-drag]');
  result.transportOptsOut = !!document.querySelector('#art-player')?.closest('[data-no-drag]');
  if (!result.seekOptsOut) problems.push('the seek bar is inside a drag surface with no opt-out');
  if (!result.transportOptsOut) problems.push('the transport is inside a drag surface with no opt-out');
  // The seek row is the on-art player's second line: the times sit under the
  // transport they belong to, on the cover, not down in the text column.
  const seekBarEl = document.querySelector('#art-progress');
  result.seekRowOnArt = !!seekBarEl && !!seekBarEl.closest('#art-player');
  if (!result.seekRowOnArt) problems.push('the seek row is not on the cover');
  result.seekTimesWithTheRow = !!document.querySelector('#art-player #art-timer-display') &&
    !!document.querySelector('#art-player #art-duration-display');
  if (!result.seekTimesWithTheRow) problems.push('the seek times are not on the cover');

  // Reachability, sampled across the strip the user actually grabs: whatever is
  // hit at those pixels must belong to a drag surface. (This is what catches an
  // invisible layer sitting over the top band.) The samples start past the west
  // resize grip: the outermost 8px of every edge belong to resizing on purpose.
  const stripEl = document.querySelector('.top-drag-strip');
  const strip = box(stripEl);
  const bandMisses = [];
  // Past the 8px edge grips and the 22px corner grips, both of which own their
  // pixels on purpose.
  for (const x of [strip.left + 30, strip.left + strip.width * 0.35, strip.left + strip.width * 0.7]) {
    for (const y of [strip.top + 26, strip.top + 36, strip.top + 46]) {
      const hit = document.elementFromPoint(x, y);
      if (!hit || !hit.closest('[data-drag]')) bandMisses.push(Math.round(x) + ',' + Math.round(y));
    }
  }
  result.topBandMisses = bandMisses;
  // The grips still own the outermost pixels, so a drag surface that reached the
  // very corner would mean the edges stopped being resizable.
  const cornerHit = document.elementFromPoint(strip.left + 2, strip.top + 2);
  result.cornerStillAResizeGrip = !!cornerHit && !!cornerHit.closest('.resize-handle');
  if (!result.cornerStillAResizeGrip) problems.push('the top-left corner is not a resize grip');
  result.dragStrip = { left: Math.round(strip.left), height: Math.round(strip.height) };
  if (bandMisses.length) problems.push('the top band misses a drag surface at ' + bandMisses.join(' '));
  if (strip.left > 1 || strip.left < -1) problems.push('the top drag strip misses the left edge');
  if (strip.height < 44) problems.push('the top drag strip is shorter than the header band');
  // ... and a lyric click must not become a window move. Two questions, because
  // the card floats over the lyric list: when the window is short the card sits
  // on the middle of it, and a point-sample of the window's centre would measure
  // the card (which IS a drag surface, by design). So the container is asked
  // first, and the sampled pixel is taken below the card when there is one.
  const lyricBox = document.getElementById('lyrics-container');
  result.lyricsNotADragSurface = !lyricBox || !lyricBox.closest('[data-drag]');
  if (!result.lyricsNotADragSurface) problems.push('the lyric area is a drag surface');
  const cardForLyricProbe = document.getElementById('track-float');
  const cardBody = cardForLyricProbe && isVisible(cardForLyricProbe) ? box(cardForLyricProbe) : null;
  const lyricProbeY = cardBody
    ? Math.min(window.innerHeight - 6, cardBody.bottom + 10)
    : window.innerHeight * 0.55;
  const lyricHit = document.elementFromPoint(window.innerWidth * 0.5, lyricProbeY);
  result.lyricPixelIsNotADragSurface = !lyricHit || !lyricHit.closest('[data-drag]');
  if (!result.lyricPixelIsNotADragSurface) problems.push('a lyric pixel sits inside a drag surface');
  // Window controls stay reachable, and they are not inside a drag surface.
  const controls = document.querySelector('#app-header .window-controls');
  result.controlsInteractive = !!controls &&
    !controls.closest('[data-drag]') &&
    getComputedStyle(controls).pointerEvents === 'auto' &&
    getComputedStyle(controls.querySelector('.btn')).pointerEvents !== 'none';
  if (!result.controlsInteractive) problems.push('window controls are unreachable while windowed');
  if (strip.right > controls.getBoundingClientRect().left + 1) {
    problems.push('the top drag strip covers the window controls');
  }

  // --- 2b. fullscreen: Esc leaves, an idle cursor hides ------------------
  setFullscreen(true);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  result.escapeLeavesFullscreen = !document.body.classList.contains('is-fullscreen');
  if (!result.escapeLeavesFullscreen) problems.push('Esc does not leave fullscreen');
  setFullscreen(true);
  body.classList.add('cursor-hidden');
  result.cursorHiddenInFullscreen = getComputedStyle(body).cursor === 'none';
  body.classList.remove('cursor-hidden');
  // …and the very next movement brings it back: the hide is an idle timeout, not
  // a state the user has to leave fullscreen to escape.
  body.classList.add('cursor-hidden');
  document.dispatchEvent(new MouseEvent('mousemove'));
  result.cursorReturnsOnMove = !body.classList.contains('cursor-hidden');
  if (!result.cursorReturnsOnMove) problems.push('the pointer does not come back on movement');
  body.classList.remove('cursor-hidden');
  setFullscreen(false);
  if (!result.cursorHiddenInFullscreen) problems.push('the cursor does not hide in fullscreen');

  // --- 3. the centred track card ---------------------------------------
  if (typeof cycleLayout === 'function' && !body.classList.contains('layout-compact')) {
    cycleLayout();   // a remembered split layout only lives in fullscreen
  }
  const card = document.getElementById('track-float');
  const artEl = document.getElementById('float-art-wrap');
  const seekRow = document.querySelector('.art-progress');
  const titleEl = document.getElementById('title');
  const artistEl = document.getElementById('artist');
  if (isVisible(card)) {
    // The card measures itself once the sleeve has a source; a fresh page with
    // no track has an empty (0-height) art, so the geometry checks only run
    // when there is something to lay out.
    const c = box(card);
    const art = box(artEl);
    const seek = box(seekRow);
    const title = box(titleEl);
    const artist = box(artistEl);
    // Left by default: level with the lyrics' own gutter, never centred — and
    // centred exactly while `card-center` is on (the opt-in half of the setting).
    result.cardLeft = Math.round(c.left);
    result.cardAnchoredLeft = c.left <= 32 && c.left >= 0;
    body.classList.add('card-center');
    const centered = box(card);
    result.cardCenteredWhenAsked =
      Math.abs((centered.left + centered.width / 2) - window.innerWidth / 2) <= 1.5;
    body.classList.remove('card-center');
    if (!result.cardAnchoredLeft) problems.push('the windowed card is not left-anchored by default');
    if (!result.cardCenteredWhenAsked) problems.push('card-center does not centre the card');
    result.cardFits = c.left >= 0 && c.right <= window.innerWidth + 1;
    result.artSquare = Math.abs(art.width - art.height) <= 1.5;
    // The seek row is over the cover now (the player's second line), so the text
    // column below the art is title then artist, and the row itself sits inside
    // the sleeve's own box rather than under it.
    result.cardOrder = art.bottom <= title.top + 1 && title.bottom <= artist.top + 1;
    result.seekOnCover = seek.top > art.top && seek.top < art.bottom;
    result.textAlignsWithArt = Math.abs(title.left - art.left) <= 1.5 &&
      Math.abs(artist.left - art.left) <= 1.5;
    result.cardW = Math.round(c.width);
    result.cardH = Math.round(c.height);
    if (!result.cardFits) problems.push('card overflows the window');
    if (art.width > 1 && !result.artSquare) problems.push('sleeve is not square');
    if (!result.cardOrder) problems.push('card order is not art -> title -> artist');
    if (!result.seekOnCover) problems.push('the seek row is not sitting on the cover');
    if (!result.textAlignsWithArt) problems.push('title/artist are not aligned with the art');
    const fade = parseFloat(getComputedStyle(document.getElementById('lyrics-container'))
      .getPropertyValue('--lyrics-fade-top')) || 0;
    result.lyricsClearance = Math.round(c.bottom - (document.getElementById('lyrics-container')
      .getBoundingClientRect().top + fade));
    if (result.lyricsClearance > 0) problems.push('lyrics fade out above the card');
  } else {
    problems.push('windowed compact has no track card');
  }

  // --- 4. mini player ---------------------------------------------------
  body.classList.add('mini');
  result.miniHidesCard = !isVisible(card);
  result.miniHidesHeader = !isVisible(document.getElementById('app-header'));
  result.miniBarVisible = isVisible(document.getElementById('mini-bar'));
  const miniDrag = document.querySelector('.mini-drag');
  result.miniBarDragIsSiblingOfButtons =
    !!miniDrag && !miniDrag.querySelector('button') &&
    !document.querySelector('.mini-bar button')?.closest('[data-drag]');
  const miniDragBox = miniDrag ? box(miniDrag) : null;
  const miniHit = miniDragBox
    ? document.elementFromPoint(miniDragBox.left + miniDragBox.width / 2, miniDragBox.top + 8)
    : null;
  result.miniDragReachable = !!miniHit && !!miniHit.closest('[data-drag]');
  if (!result.miniDragReachable) problems.push('the mini bar drag handle is not reachable');
  if (!result.miniHidesCard || !result.miniHidesHeader || !result.miniBarVisible) {
    problems.push('mini player chrome is wrong');
  }
  if (!result.miniBarDragIsSiblingOfButtons) problems.push('mini bar buttons sit inside the drag region');
  // Hidden chrome, live drag handle: the buttons are away until the pointer
  // reaches the top band, and the strip that moves the window never moves.
  const miniButtons = document.getElementById('mini-buttons');
  setMiniBarRevealed(false);
  result.miniButtonsHiddenOpacity = getComputedStyle(miniButtons).opacity;
  result.miniDragReachableWhileHidden =
    getComputedStyle(miniDrag).pointerEvents === 'auto' && box(miniDrag).height >= 16;
  setMiniBarRevealed(true);
  result.miniButtonsRevealedOpacity = getComputedStyle(miniButtons).opacity;
  if (result.miniButtonsHiddenOpacity !== '0' || result.miniButtonsRevealedOpacity !== '1') {
    problems.push('the mini bar does not hide/reveal its buttons');
  }
  if (!result.miniDragReachableWhileHidden) {
    problems.push('the mini window cannot be dragged while its bar is hidden');
  }
  setMiniBarRevealed(false);
  body.classList.remove('mini');

  // --- 5. settings sheet ------------------------------------------------
  // The entry animation starts the sheet at scale(0.98) + 10px down; the
  // suspended animations above already flatten that, so the rect read here is
  // the settled one.
  panel.classList.add('open');
  const tabs = [...document.querySelectorAll('#quick-panel .sp-tab')];
  result.settingsTabs = tabs.map((t) => t.textContent.trim());
  const expectedTabs = ['Window', 'Lyrics', 'Visuals', 'Diagnostics'];
  if (JSON.stringify(result.settingsTabs) !== JSON.stringify(expectedTabs)) {
    problems.push('settings tabs are ' + result.settingsTabs.join(' / ') +
      ' (expected ' + expectedTabs.join(' / ') + ')');
  }
  // Every tab must open on the groups it claims, in the order it claims them: the
  // sheet is a set of short pages now, and this is what says which page a row
  // lives on.
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
  // A tablist has one tab stop and one selection, and its tabs and panels point
  // back at each other — otherwise a screen reader announces a tab that leads
  // nowhere.
  result.settingsTabWiring = tabs.every((t) => {
    const p = document.getElementById(t.getAttribute('aria-controls'));
    return p && p.getAttribute('aria-labelledby') === t.id;
  }) && tabs.filter((t) => t.getAttribute('aria-selected') === 'true').length === 1 &&
    tabs.filter((t) => t.tabIndex === 0).length === 1;
  if (!result.settingsTabWiring) problems.push('the settings tablist is wired wrong');

  // The search filter, one page over every page. This starts on Visuals so the
  // restore check at the end has a tab to come back to.
  openSettingsTab('visuals');
  // A label match comes back as the row itself, with the matched run marked.
  runSettingsSearch('opacity');
  const hits = [...document.querySelectorAll('#qp-body .sp-result .qp-row')];
  result.settingsSearchLabelHit = hits.map((r) => r.querySelector('.qp-label').textContent.trim());
  const firstMark = document.querySelector('#qp-body .sp-result .qp-mark');
  result.settingsSearchLabelMark = firstMark ? firstMark.textContent : null;
  // The hint under the row names the same word, so it comes along — filtered to
  // the rows themselves so the count says what it means.
  if (hits.length !== 1 || result.settingsSearchLabelHit[0] !== 'Window opacity') {
    problems.push('searching a label did not find its row: ' + result.settingsSearchLabelHit.join(','));
  }
  if (result.settingsSearchLabelMark !== 'opacity') {
    problems.push('the matched run is not marked in place: ' + result.settingsSearchLabelMark);
  }
  // The result has to BE the row, not a copy of it. A copy carries a second
  // version of every id into the document, keeps showing the state it was copied
  // with (so acting on it looks like it did nothing) and loses the handlers the
  // TTML rows are wired with, since cloneNode does not carry an assigned onclick.
  result.settingsSearchResultIsTheRow =
    document.querySelector('#qp-body .sp-result .qp-row') === document.getElementById('qp-opacity');
  const allIds = [...document.querySelectorAll('[id]')].map((el) => el.id);
  result.settingsSearchUniqueIds = allIds.length === new Set(allIds).size;
  if (!result.settingsSearchResultIsTheRow) {
    problems.push('a search result is a copy of its row rather than the row itself');
  }
  if (!result.settingsSearchUniqueIds) problems.push('the search view duplicated ids into the document');
  // A prose match is how the sync row is found at all: its label is "Latency",
  // and "timing" only appears in the hint under it.
  runSettingsSearch('timing');
  result.settingsSearchProseSections = document.querySelectorAll('#qp-body .sp-result').length;
  result.settingsSearchProseMark = [...document.querySelectorAll('#qp-body .sp-result .qp-mark')]
    .map((m) => m.textContent);
  result.settingsSearchProseRows = document.querySelectorAll('#qp-body .sp-result .qp-row').length;
  if (result.settingsSearchProseSections !== 1 || result.settingsSearchProseRows !== 0 ||
      result.settingsSearchProseMark.join() !== 'timing') {
    problems.push('a prose match did not surface its sentence: ' +
      result.settingsSearchProseMark.join(','));
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
  // The strip hides while a query is up — results are a different view, not a
  // fifth page — and the page you were on comes back when you clear it.
  runSettingsSearch('motion');
  result.settingsSearchTabsHidden = document.getElementById('qp-tabs').hidden;
  if (!result.settingsSearchTabsHidden) problems.push('the tab strip stayed up during a search');
  runSettingsSearch('zzz-no-such-setting');
  result.settingsSearchEmpty = !document.getElementById('qp-empty').hidden;
  result.settingsSearchEmptyText = document.getElementById('qp-empty').textContent.trim();
  if (!result.settingsSearchEmpty) problems.push('an empty search shows no empty state');
  if (!result.settingsSearchEmptyText.includes('zzz-no-such-setting')) {
    problems.push('the empty state does not name the query');
  }
  runSettingsSearch('');
  // Home again: the row is back inside its own group, so the page it lives on is
  // whole once the query goes.
  result.settingsSearchRowsGoHome =
    document.getElementById('qp-opacity').closest('.sp-panel') !== null &&
    document.querySelector('#qp-body .sp-result') === null;
  if (!result.settingsSearchRowsGoHome) {
    problems.push('a searched row did not return to its own group');
  }
  result.settingsSearchMarksLifted =
    document.querySelectorAll('#qp-body .qp-mark').length === 0;
  if (!result.settingsSearchMarksLifted) {
    problems.push('the search mark was left behind in the row');
  }
  result.settingsSearchRestoresTab = document.getElementById('qp-panel-visuals').hidden === false;
  result.settingsSearchTabsReturn = document.getElementById('qp-tabs').hidden === false;
  result.settingsSearchCleared = document.querySelectorAll('#qp-body .sp-result').length;
  if (!result.settingsSearchRestoresTab) problems.push('clearing the search did not restore the tab');
  if (!result.settingsSearchTabsReturn) problems.push('the tab strip did not come back after a search');
  if (result.settingsSearchCleared !== 0) problems.push('clearing the search left its results behind');

  // The Big moments row mirrors Beat sync: same three states, same labels, and it
  // has to be reachable on the page it claims to live on.
  openSettingsTab('visuals');
  const momentsRow = document.getElementById('qp-moments');
  result.settingsMomentsOnVisuals = !!momentsRow;
  if (!momentsRow) problems.push('the Big moments row is not on the Visuals tab');
  // Pinned to Subtle first and put back afterwards: the row cycles from wherever
  // it last was, and a run that left it on Bold would otherwise make the next run
  // report a different sequence for the same wiring.
  const savedMomentsMode = momentsMode;
  momentsMode = 'on';
  const cycles = [];
  for (let i = 0; i < 4; i++) {
    cycleMoments();
    cycles.push(document.getElementById('qp-moments-state').textContent.trim());
  }
  result.momentsRowCycles = cycles;
  if (JSON.stringify(cycles) !== JSON.stringify(['Bold', 'Off', 'Subtle', 'Bold'])) {
    problems.push('the Big moments row cycles ' + cycles.join(' -> '));
  }
  momentsMode = savedMomentsMode;
  startMomentEngine();
  syncSettingsPanel();

  openSettingsTab('window');
  // Four hints across the four pages: Window, Sync, Local lyrics and Motion.
  result.settingsHints = document.querySelectorAll('#quick-panel .sp-hint').length;
  if (result.settingsHints !== 4) {
    problems.push('the sheet carries ' + result.settingsHints + ' hints, expected 4');
  }
  // Every row is a <button>, whose user-agent text-align is `center` — the label
  // span inside inherits it, so action rows centred their text while the div rows
  // and the group titles stayed left. One column, one edge. A hidden panel
  // reports zero rects, so this reads the panel that is up.
  const shown = document.querySelector('#quick-panel .sp-panel:not([hidden])');
  const labels = [...shown.querySelectorAll('.qp-row .qp-label')];
  const labelLefts = labels.map((el) => Math.round(el.getBoundingClientRect().left));
  result.settingsLabelLefts = [...new Set(labelLefts)];
  if (labelLefts.length && new Set(labelLefts).size !== 1) {
    problems.push('settings labels start at different x: ' + result.settingsLabelLefts.join(','));
  }
  const groupTitle = shown.querySelector('.sp-group-title');
  // The title's own box starts at the group's left edge and insets its text with
  // padding, so the column the labels must line up with is box + padding.
  const titleTextLeft = groupTitle
    ? groupTitle.getBoundingClientRect().left + parseFloat(getComputedStyle(groupTitle).paddingLeft)
    : null;
  result.settingsTitleTextLeft = titleTextLeft === null ? null : Math.round(titleTextLeft);
  result.settingsLabelAlignedWithTitle = titleTextLeft !== null && labelLefts.length > 0 &&
    Math.abs(labelLefts[0] - titleTextLeft) <= 2;
  if (!result.settingsLabelAlignedWithTitle) {
    problems.push('settings labels do not line up with the group title');
  }
  const sheetEl = document.querySelector('.sp-sheet');
  const sheet = box(sheetEl);
  result.settingsFits =
    sheet.left >= -1 && sheet.right <= window.innerWidth + 1 &&
    sheet.top >= -1 && sheet.bottom <= window.innerHeight + 1;
  result.sheetCentered = Math.abs((sheet.top + sheet.bottom) / 2 - window.innerHeight / 2) <= 2;
  result.sheetW = Math.round(sheet.width);
  result.sheetH = Math.round(sheet.height);
  result.rowMinH = getComputedStyle(sheetEl)
    .getPropertyValue('--sp-row-min-h').trim();
  if (!result.settingsFits) problems.push('settings sheet overflows');
  if (!result.sheetCentered) problems.push('settings sheet is not centred');
  if (window.innerHeight <= 420 && parseInt(result.rowMinH) !== 28) problems.push('density query not applying');
  panel.classList.remove('open');

  // --- 6. fullscreen hover parting --------------------------------------
  // Only fullscreen's art grows on hover, so only there must the lyrics part
  // downward to stay clear of it. (The preview freezes transitions, so the
  // styles are suspended for the read — this measures the settled value.)
  // The lyric column belongs to the same block as the card: in fullscreen the
  // gutter moves out to the card's own column (the sleeve starts at 84px, so the
  // type starts 16px outside it), and returns to the windowed gutter with it.
  const lcEl = document.getElementById('lyrics-container');
  setFullscreen(false);
  result.windowedLyricGutter = Math.round(parseFloat(getComputedStyle(lcEl).paddingLeft));
  setFullscreen(true);
  result.fullscreenLyricGutter = Math.round(parseFloat(getComputedStyle(lcEl).paddingLeft));
  if (result.windowedLyricGutter !== 28) {
    problems.push('the windowed lyric gutter is ' + result.windowedLyricGutter + ', expected 28');
  }
  if (result.fullscreenLyricGutter !== 68) {
    problems.push('the fullscreen lyric gutter is ' + result.fullscreenLyricGutter + ', expected 68');
  }
  const padBefore = parseFloat(getComputedStyle(lcEl).paddingTop);
  body.classList.add('art-hover');
  const padHover = parseFloat(getComputedStyle(lcEl).paddingTop);
  body.classList.remove('art-hover');
  setFullscreen(false);
  result.hoverPartsLyrics = padHover > padBefore + 100;
  if (!result.hoverPartsLyrics) problems.push('lyrics do not part under the hovered fullscreen art');

  // --- 7. on-art playhead dot -------------------------------------------
  // Driven between two positions of the SAME run: comparing against whatever the
  // last run left on the thumb made every run after the first report a dot that
  // "never moved" (it had already been put exactly there).
  window.setTrackDuration(180_000);   // the dot only rides a known duration
  updateArtProgress(45_000);          // 25%
  const before = parseFloat(document.getElementById('art-thumb').style.left) || 0;
  updateArtProgress(135_000);         // 75%
  const after = parseFloat(document.getElementById('art-thumb').style.left) || 0;
  result.thumbLeft = { at25: before, at75: after };
  if (after - before < 10 || Math.abs(after - 75) > 2) {
    problems.push('the playhead dot does not track the position: ' + before + ' -> ' + after);
  }

  // --- 8. motion system -------------------------------------------------
  result.lineBreath = getComputedStyle(body).getPropertyValue('--line-breath').trim();
  if (!result.lineBreath) problems.push('--line-breath is missing');

  const lines = (typeof lyricDom !== 'undefined' ? lyricDom : []).filter((l) => l && l.hydrated);
  if (lines.length === 0) {
    result.motion = 'skipped: no lyrics loaded';
  } else {
    const split = [];
    for (const l of lines) {
      for (const w of l.words) {
        const ids = new Set(w.syllables.map((s) => s.variant && s.variant.id).filter(Boolean));
        if (ids.size > 1) split.push([...ids].join('+'));
      }
    }
    result.wordsMovingInPieces = split.length;
    if (split.length) problems.push('a word moves in two pieces: ' + split.slice(0, 3).join(', '));

    const active = typeof activeLineIdx === 'number' ? lyricDom[activeLineIdx] : null;
    const waiting = active && active.hydrated
      ? active.words.flatMap((w) => w.syllables).find((s) => s.startTimeMs > 0)
      : null;
    if (waiting) {
      setSyllableState(waiting, 'future', 0, null, waiting.startTimeMs - 200);
      const leaning = waiting.baseEl.style.transform;
      setSyllableState(waiting, 'future', 0, null, waiting.startTimeMs - 5_000);
      const cleared = waiting.baseEl.style.transform;
      result.anticipation = { leaning, cleared };
      // Chromium normalises the inline value, so `0` comes back as `0px`.
      if (!/^translate3d\(0(px)?, -?0?\.\d+px, 0(px)?\) scale\(1\.0\d+\)$/.test(leaning)) {
        problems.push('a waiting word does not lean in: ' + JSON.stringify(leaning));
      }
      if (cleared !== '') problems.push('anticipation did not clear ' + JSON.stringify(cleared));

      // The lean must HAND OVER to the sung motion, not be dropped at it. The
      // first sung frame used to start from rest while the waiting frame above
      // was at full lean, so every word snapped ~1% smaller and ~1px down the
      // instant the playhead reached it. Compare the two frames the way the
      // eye does: the rendered scale and lift.
      const shape = (el) => {
        const value = (el && el.style.transform) || '';
        const scale = /scale\(([\d.]+)\)/.exec(value);
        const lift = /translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(value);
        return { scale: scale ? +scale[1] : 1, lift: lift ? +lift[1] : 0 };
      };
      // Only meaningful once the syllable has a motion of its own to hand over to.
      if (!waiting.variant) result.anticipationHandoff = 'skipped: no variant';
      if (waiting.variant) {
      setSyllableState(waiting, 'future', 0, null, waiting.startTimeMs - 8);
      const lastWaiting = shape(waiting.baseEl);
      setSyllableState(waiting, 'singing', 4, 0.04, waiting.startTimeMs);
      const firstSung = shape(waiting.baseEl);
      result.anticipationHandoff = {
        waiting: lastWaiting, sung: firstSung,
        dScale: +(firstSung.scale - lastWaiting.scale).toFixed(4),
        dLift: +(firstSung.lift - lastWaiting.lift).toFixed(3),
      };
      if (Math.abs(firstSung.scale - lastWaiting.scale) > 0.002 ||
          Math.abs(firstSung.lift - lastWaiting.lift) > 0.1) {
        problems.push('the first sung frame does not continue the lean: ' +
          JSON.stringify(result.anticipationHandoff));
      }
      // ...and it must not invent one either: a word that never had a waiting
      // frame (the first syllable of a song, or one arriving out of a seek)
      // carries nothing, so its first sung frame stays at rest like the variants
      // are built to.
      setSyllableState(waiting, 'passed', 100);
      waiting.leanCarry = 0;
      setSyllableState(waiting, 'singing', 0, 0, waiting.startTimeMs);
      result.anticipationNoCarry = shape(waiting.baseEl);
      if (result.anticipationNoCarry.scale > 1.002 || Math.abs(result.anticipationNoCarry.lift) > 0.1) {
        problems.push('a word that never waited invented a lean: ' +
          JSON.stringify(result.anticipationNoCarry));
      }
      setSyllableState(waiting, 'passed', 100);
      }
    }
  }

  // --- 9. local TTML library panel -------------------------------------
  // A stub bridge stands in for the Python library so the render path and the
  // click wiring are exercised for real (file names included: they travel
  // through dataset, never through an inline handler).
  const ttmlSnapshotStub = {
    dir: 'ttml',
    count: 3,
    trash: 1,
    current: { title: 'Ode To The Mets', artist: 'The Strokes', kind: 'match',
               file: 'ode.ttml', name: 'ode.ttml', candidates: [] },
    entries: [
      { file: 'ode.ttml', name: 'ode.ttml', title: 'Ode To The Mets', artist: 'The Strokes',
        timing: 'Word', line_count: 62, syllables: 210, state: 'match', error: '' },
      { file: 'other.ttml', name: 'other.ttml', title: 'Other Song', artist: 'Someone',
        timing: 'Line', line_count: 30, syllables: 0, state: 'candidate', error: '' },
      { file: 'broken.ttml', name: 'broken.ttml', title: 'broken', artist: '',
        error: 'not valid XML', state: '' },
    ],
  };
  const calls = [];
  const previousBridge = window.pywebview;
  window.pywebview = {
    api: {
      ttml_list: () => ttmlSnapshotStub,
      ttml_bind: (file, ...rest) => { calls.push(['bind', file, ...rest]); return ttmlSnapshotStub; },
      ttml_set_enabled: (enabled, ...rest) => { calls.push(['enabled', enabled, ...rest]); return ttmlSnapshotStub; },
      ttml_remove: (file, ...rest) => { calls.push(['remove', file, ...rest]); return ttmlSnapshotStub; },
    },
  };
  currentTrackMeta = { title: 'Ode To The Mets', artist: 'The Strokes' };
  await refreshTtml();
  result.ttmlRows = document.querySelectorAll('#qp-ttml-list .ttml-row').length;
  result.ttmlChips = [...document.querySelectorAll('#qp-ttml-list .ttml-chip')]
    .map((c) => c.textContent);
  result.ttmlCurrentValue = document.querySelector('#qp-ttml-current .ttml-current-value').textContent;
  if (result.ttmlRows !== 3) problems.push('TTML panel did not render one row per file');
  if (!result.ttmlCurrentValue.includes('ode.ttml')) problems.push('TTML panel does not name the file in use');
  if (!result.ttmlChips.includes('Auto-matched')) problems.push('TTML panel lost the state chips');
  // The unreadable file must be reported and not offer to be used.
  const brokenRow = document.querySelector('.ttml-row[data-file="broken.ttml"]');
  if (brokenRow && brokenRow.querySelector('button[data-action="use"]')) {
    problems.push('an unreadable file offers to be used');
  }
  const useButton = document.querySelector('.ttml-row[data-file="other.ttml"] button[data-action="use"]');
  if (useButton) {
    useButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bind = calls.find((c) => c[0] === 'bind');
    result.ttmlBindCall = bind || null;
    if (!bind || bind[1] !== 'other.ttml') {
      problems.push('a row did not bind its own file');
    } else if (bind[2] !== 'Ode To The Mets' || bind[3] !== 'The Strokes') {
      problems.push('a bind did not carry the playing track\u2019s metadata');
    }
  } else {
    problems.push('TTML rows have no Use action');
  }
  window.pywebview = previousBridge;
  ttmlSnapshot = null;
  renderTtmlPanel();

  // --- 10. window transparency ------------------------------------------
  // The host applies whatever alpha it is handed, so the whole policy is testable
  // here: the base applies while windowed, the dip goes below it without going
  // under it, Ctrl and the settings sheet cancel only the dip, click-through
  // keeps the base AND takes the dip from the host's pointer probe, and
  // fullscreen is opaque.
  const alphaCalls = [];
  const fadeBridge = window.pywebview;
  window.pywebview = { api: { set_window_alpha: (a) => { alphaCalls.push(a); return a; } } };
  const savedFadeState = { opacityIndex, hoverFade, hoverFadeInside, hoverFadeCtrl,
                           appliedAlpha, clickThrough };
  const lastAlpha = () => alphaCalls[alphaCalls.length - 1];

  opacityIndex = 0;           // base Off, so the dip is what is being measured
  hoverFade = 'light';
  hoverFadeInside = false;
  hoverFadeCtrl = false;
  clickThrough = false;
  appliedAlpha = 1;
  applyWindowOpacity();
  result.alphaWithPointerAway = alphaCalls.length ? lastAlpha() : null;
  result.alphaTargetWithPointerAway = windowAlphaTarget();
  hoverFadeInside = true;
  applyWindowOpacity();
  result.dipAlpha = lastAlpha();
  const pushesBeforeRepeat = alphaCalls.length;
  applyWindowOpacity();
  result.alphaPushesOnlyOnChange = alphaCalls.length === pushesBeforeRepeat;
  hoverFadeCtrl = true;
  applyWindowOpacity();
  result.alphaWithCtrl = lastAlpha();
  hoverFadeCtrl = false;

  opacityIndex = 3;           // 80% base, with the pointer still inside
  appliedAlpha = 1;
  applyWindowOpacity();
  result.baseAlpha = lastAlpha();
  // The dip is a floor, not a target of its own: with a 80% base and a 86% dip
  // the window stays at the base rather than going brighter than the user asked.
  result.alphaDipsBelowBase = windowAlphaTarget() === result.baseAlpha;

  // Click-through: the page cannot see the pointer at all, so this state arrives
  // from the host's probe — the pip case that used to dim for nothing at all.
  clickThrough = true;
  hoverFade = 'clear';        // 0.7, below the 0.8 base, so the dip is visible
  hoverFadeInside = false;
  appliedAlpha = 1;
  applyWindowOpacity();
  result.alphaWhileClickThrough = lastAlpha();
  window.setHoverFadeInside(true);
  result.alphaClickThroughDip = lastAlpha();
  window.setHoverFadeInside(false);
  result.alphaClickThroughAfterLeave = lastAlpha();
  clickThrough = false;
  hoverFade = 'light';        // back to the level the checks above used

  setFullscreen(true);        // the one mode that refuses transparency
  result.alphaInFullscreen = lastAlpha();
  setFullscreen(false);
  result.alphaBackWindowed = lastAlpha();

  result.hasOpacityRow = !!document.getElementById('qp-opacity');
  if (result.alphaTargetWithPointerAway !== 1) {
    problems.push('the hover dip applied with the pointer away: ' + result.alphaTargetWithPointerAway);
  }
  if (!(result.dipAlpha < 1 && result.dipAlpha >= 0.7)) {
    problems.push('the hover dip is out of range: ' + result.dipAlpha);
  }
  if (!result.alphaPushesOnlyOnChange) problems.push('every re-evaluation pushed an alpha to the host');
  if (result.alphaWithCtrl !== 1) problems.push('Ctrl does not cancel the dip: ' + result.alphaWithCtrl);
  if (result.baseAlpha !== 0.8) problems.push('the base opacity was not applied: ' + result.baseAlpha);
  if (!result.alphaDipsBelowBase) problems.push('the dip went below the chosen base');
  if (result.alphaWhileClickThrough !== 0.8) {
    problems.push('click-through did not keep the base opacity: ' + result.alphaWhileClickThrough);
  }
  if (!(result.alphaClickThroughDip < 0.8)) {
    problems.push('the hover dip is dead while click-through is on: ' + result.alphaClickThroughDip);
  }
  if (result.alphaClickThroughAfterLeave !== 0.8) {
    problems.push('the dip stuck after the host reported the pointer away: ' +
      result.alphaClickThroughAfterLeave);
  }
  if (result.alphaInFullscreen !== 1) problems.push('fullscreen is not opaque: ' + result.alphaInFullscreen);
  if (result.alphaBackWindowed !== 0.8) {
    problems.push('leaving fullscreen lost the base opacity: ' + result.alphaBackWindowed);
  }
  if (!result.hasOpacityRow) problems.push('the settings sheet has no window-opacity row');

  opacityIndex = savedFadeState.opacityIndex;
  hoverFade = savedFadeState.hoverFade;
  hoverFadeInside = savedFadeState.hoverFadeInside;
  hoverFadeCtrl = savedFadeState.hoverFadeCtrl;
  appliedAlpha = savedFadeState.appliedAlpha;
  clickThrough = savedFadeState.clickThrough;
  window.pywebview = fadeBridge;

  // --- 11. moments: which ones, and how hard ----------------------------
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
  if (JSON.stringify(result.momentStarts) !==
      JSON.stringify(['hook@2000', 'hook@14000', 'drop@20000', 'hook@40000'])) {
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
    problems.push('hooks do not survive a track with no plan: ' +
      result.momentStartsWithoutPlan.join(','));
  }
  // A held moment has a ceiling, so a malformed plan cannot pin the grade on.
  result.momentHoldCap = Math.max(...starts.map((m) => m.endMs - m.ms));
  if (result.momentHoldCap > 8000) {
    problems.push('a moment can hold longer than the ceiling: ' + result.momentHoldCap);
  }

  // The engine, driven directly: the tool owns beatPlan, lyrics and isPlaying in
  // this page, so a moment can be stepped through frame by frame.
  const savedPlan = beatPlan, savedPlaying = isPlaying, savedLines = lyrics;
  const savedMode = momentsMode;
  beatPlan = fixturePlan;
  lyrics = fixtureLines;
  isPlaying = true;
  momentsMode = 'off';
  startMomentEngine();
  updateMoment(25000);
  result.momentOffStrength = document.body.style.getPropertyValue('--moment-strength');
  result.momentOffLive = document.body.classList.contains('moment-live');
  result.momentOffPlan = momentPlan;
  if (result.momentOffLive || result.momentOffStrength) problems.push('moments run while Off');
  // Off is honest: no plan is built at all, so nothing is left running behind the
  // setting rather than merely hidden.
  if (result.momentOffPlan) problems.push('Off still builds a moment plan');
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

  // One veil with one job: the room steps back and takes the song's own colour.
  // It is deliberately NOT a full-window blend pass over the glyphs — a moment
  // tints the room, never the type, which is why the old soft-light wash and its
  // warm text-shadow are both gone.
  const veil = document.querySelector('.moment-veil');
  result.momentVeilCount = document.querySelectorAll('.moment-veil').length;
  result.momentWashCount = document.querySelectorAll('.moment-wash').length;
  result.momentDimCount = document.querySelectorAll('.moment-dim').length;
  result.momentVeilZ = veil ? getComputedStyle(veil).zIndex : null;
  result.momentVeilBlend = veil ? getComputedStyle(veil).mixBlendMode : null;
  if (result.momentVeilCount !== 1) problems.push('expected exactly one moment veil');
  if (result.momentWashCount || result.momentDimCount) {
    problems.push('the old two-layer moment is still in the tree');
  }
  if (parseInt(result.momentVeilZ) >= 10) {
    problems.push('a moment layer is painted over the lyrics: ' + result.momentVeilZ);
  }
  // `normal` is the point, not an oversight: a blend mode here tints every glyph
  // on screen and costs a full-window composite on every beat.
  if (result.momentVeilBlend !== 'normal') {
    problems.push('the moment veil still blends over the whole window: ' + result.momentVeilBlend);
  }
  // Transitions are suspended for the whole run (the tool's own stylesheet), so
  // every read below is the settled target rather than a frame mid-flight.
  beatPlan = fixturePlan;
  lyrics = fixtureLines;
  isPlaying = true;
  momentsMode = 'on';
  // Beat sync is forced OFF for the reads below so the lamp's level is
  // attributable: with the pulse dark, anything lit is a moment's doing, and a
  // moment that does not light the sleeve cannot hide behind the beat's own glow.
  const savedBeatModeForMoment = beatMode;
  beatMode = 'off';
  startBeatEngine();
  startMomentEngine();
  updateMoment(20100);
  result.momentVeilOpacity = veil ? parseFloat(getComputedStyle(veil).opacity) : null;
  result.momentVeilTint = veil ? getComputedStyle(veil).backgroundImage : null;
  result.momentCoverZoom = parseFloat(
    getComputedStyle(document.body).getPropertyValue('--cover-zoom').trim() || '1');
  // The sleeve's light is read off the LAMP, not off the variable that drives it:
  // --lamp-moment is an unregistered custom property holding a calc(), so it
  // reads back as text rather than a number, and the question worth asking is
  // what the user can see anyway.
  const lampEl = document.querySelector('.art-light');
  result.momentLampLive = lampEl ? parseFloat(getComputedStyle(lampEl).opacity) : null;
  if (!(result.momentVeilOpacity > 0)) problems.push('a live moment does not raise the veil');
  // Behavioural, like the lamp's tint: getComputedStyle resolves color-mix() to
  // literal rgba(), so the honest question is whether the veil's paint follows
  // --art-accent — which is what makes a warm cover grade warm and a blue one
  // blue, instead of every moment wearing the same hard-coded amber.
  const veilRoot = document.documentElement;
  const veilAccentBefore = veilRoot.style.getPropertyValue('--art-accent');
  veilRoot.style.setProperty('--art-accent', 'rgb(220 40 40)');
  const warmVeil = veil ? getComputedStyle(veil).backgroundImage : '';
  veilRoot.style.setProperty('--art-accent', 'rgb(40 90 220)');
  const coolVeil = veil ? getComputedStyle(veil).backgroundImage : '';
  if (veilAccentBefore) veilRoot.style.setProperty('--art-accent', veilAccentBefore);
  else veilRoot.style.removeProperty('--art-accent');
  result.momentVeilFollowsAccent = !!warmVeil && warmVeil !== coolVeil;
  if (!result.momentVeilFollowsAccent) {
    problems.push('the moment grade does not follow the artwork accent');
  }
  if (!(result.momentCoverZoom > 1)) problems.push('the recession pushes nothing in');
  if (!(result.momentLampLive > 0)) problems.push('a live moment does not light the sleeve');
  updateMoment(35000);
  result.momentVeilRestOpacity = veil ? parseFloat(getComputedStyle(veil).opacity) : null;
  // A moment lifts the light; between moments, with the pulse dark, it is out.
  result.momentLampRest = lampEl ? parseFloat(getComputedStyle(lampEl).opacity) : null;
  result.momentCoverZoomRest = parseFloat(
    getComputedStyle(document.body).getPropertyValue('--cover-zoom').trim() || '1');
  beatMode = savedBeatModeForMoment;
  startBeatEngine();
  if (result.momentVeilRestOpacity >= result.momentVeilOpacity) {
    problems.push('the veil does not come back down between moments');
  }
  if (result.momentLampRest !== 0) problems.push('the sleeve stays lit between moments');
  if (result.momentCoverZoomRest !== 1) problems.push('the recession does not relax');
  // ---- the snap guard ----
  // Asserted against the RULES, because the run suspends transitions and because
  // this is the defect being fixed. The rule that matters: every property a moment
  // drives must be transitioned by a rule that is NOT itself gated on the moment.
  // A transition declared inside a state class is removed by the same style change
  // that removes the value, so nothing eases — that was the flash on entry and the
  // hard cut on release.
  const momentRules = flattenSheetRules();
  const ruleText = momentRules.map((r) => (r.selectorText || '') + '{' +
    (r.style ? r.style.cssText : '') + '}').join('\n');
  result.momentBaseTransitionRule =
    /\.moment-veil[^{]*\{[^}]*transition[^}]*opacity/.test(ruleText);
  // A moment class may only SHORTEN the base transition (the 90ms attack). Saying
  // `transition` or `transition-property` there would put the whole transition
  // back inside the state class, which is the defect this pass removes.
  result.momentDeclaresOwnTransition = /body\.moment-(live|attack)[^{]*\.moment-veil[^{]*\{[^}]*transition(\s*:|\s*,\s*--|-property|-duration\s*:\s*var)/.test(ruleText);
  // An animation owns whatever property it drives, so a moment layer must not
  // carry one: the release of an animation cannot transition, and the moment's
  // per-beat life already comes from the beat's own clock. `animation: none`
  // (the reduced-motion opt-out) is the one honest exception.
  // The `.reduce-motion` group is the opt-out and is asserted on its own, so it is
  // excluded here: its shorthand serializes as `animation: auto ease 0s 1 normal
  // none running none !important`, which no readable pattern can tell apart from a
  // real animation without re-parsing the shorthands.
  result.momentAnimatingRules = momentRules.filter((r) =>
    r.selectorText && r.selectorText.includes('moment') &&
    !r.selectorText.includes('.reduce-motion') && r.style &&
    /(^|[^-])animation(-name|-duration)?\s*:/.test(r.style.cssText)).length;
  result.momentNoAnimation = result.momentAnimatingRules === 0;
  result.momentTypeUntouched = !/body\.moment-live[^{]*\.(line|word-group|syllable)/.test(ruleText);
  result.momentRulesTouchingPulse = momentRules.filter((r) => r.selectorText &&
    r.selectorText.includes('moment') && /\.ambient-backdrop|\.track-art/.test(r.selectorText) &&
    /transform/.test(r.style ? r.style.cssText : '')).length;
  result.momentLampRule = /body\.moment-live[^{]*\{[^}]*--lamp-moment/.test(ruleText);
  if (!result.momentBaseTransitionRule) {
    problems.push('the veil has no transition outside the moment class');
  }
  if (result.momentDeclaresOwnTransition) {
    problems.push('a moment class declares its own transition — it will snap on release');
  }
  if (!result.momentNoAnimation) {
    problems.push('a moment rule carries an animation — its release cannot transition');
  }
  if (!result.momentTypeUntouched) problems.push('a moment rule reaches the type');
  if (result.momentRulesTouchingPulse) {
    problems.push('a moment rule transforms a layer the beat pulse owns');
  }
  if (!result.momentLampRule) problems.push('no moment rule lifts the sleeve lamp');
  momentsMode = savedMode;
  beatPlan = savedPlan; lyrics = savedLines; isPlaying = savedPlaying;
  startMomentEngine();

  // --- 12. the lyric viewport is the whole view: no bar, no gutter ---------
  // The active line is scaled on its OWN element, and a transformed descendant
  // counts as scrollable overflow — off `overflow-y: scroll`, which leaves
  // overflow-x computing to auto, that put a horizontal bar along the bottom of
  // the window. `clip` is declared, and Chromium then COMPUTES it to `hidden`
  // because the other axis is a scrolling value (CSS Overflow 3's pairing
  // rule), so both spellings are accepted here. What matters is that a bar can
  // no longer be drawn: no gutter is reserved, nothing is styled as a scroller,
  // and app.js only ever writes scrollTop.
  const scroller = document.getElementById('lyrics-container');
  result.lyricsOverflowX = getComputedStyle(scroller).overflowX;
  result.lyricsScrollbarWidth = getComputedStyle(scroller).scrollbarWidth;
  result.lyricsPaddingRight = getComputedStyle(scroller).paddingRight;
  result.lyricsScrollerChromeRules = flattenSheetRules().filter((r) => r.selectorText && /#lyrics-container.*::-webkit-scrollbar/.test(r.selectorText)).length;
  if (result.lyricsOverflowX !== 'clip' && result.lyricsOverflowX !== 'hidden') {
    problems.push('the lyric viewport can still scroll sideways: ' + result.lyricsOverflowX);
  }
  if (result.lyricsScrollbarWidth !== 'none') {
    problems.push('the lyric scroller still reserves a bar: ' + result.lyricsScrollbarWidth);
  }
  if (result.lyricsScrollerChromeRules !== 0) {
    problems.push('the lyric scroller still styles its own chrome');
  }
  if (result.lyricsPaddingRight !== '32px') {
    problems.push('the lyric column right inset moved: ' + result.lyricsPaddingRight);
  }

  // --- 13. the room's colour comes from the artwork ------------------------
  // The grade is no longer a hard-coded amber: one accent, taken from the cover,
  // is what the moment veil and the beat lamp are both tinted with. The extractor
  // is pure, so it is driven with synthetic pixels here instead of a real image.
  const bluePixels = new Uint8ClampedArray(4 * 16);
  for (let i = 0; i < 16; i++) {
    bluePixels[i * 4] = 40; bluePixels[i * 4 + 1] = 90; bluePixels[i * 4 + 2] = 220;
    bluePixels[i * 4 + 3] = 255;
  }
  const greyPixels = new Uint8ClampedArray(4 * 16);
  for (let i = 0; i < 16; i++) {
    greyPixels[i * 4] = 128; greyPixels[i * 4 + 1] = 128; greyPixels[i * 4 + 2] = 128;
    greyPixels[i * 4 + 3] = 255;
  }
  result.accentFromBlue = extractAccent(bluePixels);
  result.accentFromGrey = extractAccent(greyPixels);
  if (!result.accentFromBlue || result.accentFromBlue.b <= result.accentFromBlue.r) {
    problems.push('the accent is not taken from the pixels: ' +
      JSON.stringify(result.accentFromBlue));
  }
  // The winner is clamped to a band that always reads as LIGHT on a dark UI, so
  // a muddy album colour cannot paint a smudge instead of a glow.
  if (result.accentFromBlue && result.accentFromBlue.b < 140) {
    problems.push('the accent was not lifted into the light band: ' +
      JSON.stringify(result.accentFromBlue));
  }
  if (result.accentFromGrey !== null) {
    problems.push('a colourless cover produced an accent: ' + JSON.stringify(result.accentFromGrey));
  }
  result.accentDefault = getComputedStyle(document.documentElement)
    .getPropertyValue('--art-accent').trim();
  if (!result.accentDefault) problems.push('--art-accent has no registered default');
  const accentSheet = flattenSheetRules();
  // A <color>, so a track change cross-fades the room rather than snapping it to
  // a new hue a frame later — and a transition, or the fade never runs.
  result.accentRegistered = accentSheet.some((r) =>
    r.constructor.name === 'CSSPropertyRule' && r.name === '--art-accent' &&
    r.syntax === '<color>');
  result.accentTransition = accentSheet.some((r) =>
    r.selectorText === ':root' && /--art-accent/.test(r.style.cssText));
  if (!result.accentRegistered) problems.push('--art-accent is not a registered <color>');
  if (!result.accentTransition) problems.push('--art-accent does not cross-fade with the track');

  // --- 14. the beat is a light the sleeve emits ---------------------------
  // One lamp per art wrap, behind the art. The BEAT owns its transform (the
  // swell) and a moment owns its opacity (the sustained lift), composed with
  // max() so neither rule has to know about the other.
  const lampCount = document.querySelectorAll('.art-light').length;
  const artCount = document.querySelectorAll('.track-art, .side-art').length;
  result.lampCount = lampCount;
  if (lampCount !== artCount) {
    problems.push('every art wrap needs exactly one beat lamp: ' + lampCount + '/' + artCount);
  }
  const lamp = document.querySelector('.art-light');
  result.lampZ = lamp ? getComputedStyle(lamp).zIndex : null;
  if (!lamp) problems.push('no beat lamp');
  if (result.lampZ !== '0') problems.push('the lamp has no stacking level of its own: ' + result.lampZ);
  // Paint order, not decoration: a positioned box at z-index 0 paints ABOVE
  // in-flow content, so the sleeve has to be positioned and lifted above the lamp
  // or the lamp would wash the cover instead of lighting the room around it.
  const artEls = [...document.querySelectorAll('.track-art, .side-art')];
  result.artOverLamp = artEls.length > 0 && artEls.every((el) => {
    const cs = getComputedStyle(el);
    return cs.position !== 'static' && parseInt(cs.zIndex) > parseInt(result.lampZ);
  });
  result.artPositions = artEls.map((el) => getComputedStyle(el).position + '/' + getComputedStyle(el).zIndex);
  if (!result.artOverLamp) {
    problems.push('the artwork does not paint above the lamp: ' + result.artPositions.join(' '));
  }
  // The tint is checked BEHAVIOURALLY rather than by reading a declaration back:
  // getComputedStyle resolves color-mix() and var() into literal rgba(), so the
  // only honest question is whether the painted gradient follows --art-accent.
  const rootEl = document.documentElement;
  const readLamp = () => (lamp ? getComputedStyle(lamp).backgroundImage : '');
  const savedAccent = rootEl.style.getPropertyValue('--art-accent');
  rootEl.style.setProperty('--art-accent', 'rgb(220 40 40)');
  const warmLamp = readLamp();
  rootEl.style.setProperty('--art-accent', 'rgb(40 90 220)');
  const coolLamp = readLamp();
  if (savedAccent) rootEl.style.setProperty('--art-accent', savedAccent);
  else rootEl.style.removeProperty('--art-accent');
  result.lampFollowsAccent = !!warmLamp && warmLamp !== coolLamp;
  if (!result.lampFollowsAccent) {
    problems.push('the lamp does not follow the artwork accent');
  }
  // Off, reduced motion and the mini player all have to leave it dark, and the
  // lamp must be dark between beats rather than merely small: that is what makes
  // it the artwork's light instead of a permanent decorative glow.
  const savedBeatModeForLamp = beatMode;
  beatMode = 'off';
  startBeatEngine();
  result.lampOffOpacity = lamp ? parseFloat(getComputedStyle(lamp).opacity) : null;
  if (result.lampOffOpacity !== 0) {
    problems.push('the lamp is lit while Beat sync is off: ' + result.lampOffOpacity);
  }
  beatMode = savedBeatModeForLamp;
  startBeatEngine();
  const allRules = flattenSheetRules();
  const lampRules = allRules.filter((r) => r.selectorText && r.selectorText.includes('art-light'));
  const lampText = lampRules.map((r) => r.selectorText + '{' + (r.style ? r.style.cssText : '') + '}').join('\n');
  result.lampBeatRule = /body\.beat-live[^{]*\.art-light[^{]*\{[^}]*animation-name/.test(lampText);
  result.lampBeatGrid = /animation-duration[^}]*--beat-ms/.test(lampText);
  // The per-beat gesture is transform only. An animation on the SAME property a
  // moment drives would leave the moment unable to transition, which is exactly
  // the snap this pass is removing from the veil — the lamp must not reintroduce
  // it on its own layer.
  const lampKeyframes = allRules.filter((r) =>
    r.constructor.name === 'CSSKeyframesRule' && /art-light-beat/.test(r.name));
  result.lampKeyframeCount = lampKeyframes.length;
  result.lampKeyframesTransformOnly = lampKeyframes.length === 2 &&
    lampKeyframes.every((r) => [...r.cssRules].every((k) => !/opacity/.test(k.style.cssText)));
  result.lampAnimatesOpacity = lampRules.some((r) =>
    /animation/.test(r.style ? r.style.cssText : '') && /(^|[^-])opacity/.test(r.style.cssText));
  result.lampMomentOpacity = /--lamp-moment/.test(lampText);
  // The declaration half of the tint: the rule has to name the variable, or a
  // future edit could pin the lamp to one colour and the behavioural check above
  // would still pass on the day it was written.
  result.lampUsesAccentVar = /--art-accent/.test(lampText);
  if (!result.lampUsesAccentVar) problems.push('the lamp rule does not read --art-accent');
  if (!result.lampBeatRule) problems.push('the beat does not drive the lamp');
  if (!result.lampBeatGrid) problems.push('the lamp is not phase-locked to the beat grid');
  if (!result.lampKeyframesTransformOnly) problems.push('a lamp keyframe touches opacity');
  if (result.lampAnimatesOpacity) problems.push('a lamp animation rule also declares opacity');
  if (!result.lampMomentOpacity) problems.push('a moment cannot lift the lamp');
  // The lamp is the only new layer, and the pulse's own surfaces stay its own.
  result.lampTouchesPulse = lampRules.some((r) =>
    /ambient-backdrop|track-art/.test(r.selectorText) && /transform/.test(r.style.cssText));
  if (result.lampTouchesPulse) problems.push('a lamp rule transforms a layer the pulse owns');

  // --- 15. what the player can and cannot tell us --------------------------
  // A player that publishes no timeline (SimpMusic) must not leave the previous
  // track's length on screen, must not offer a seek it cannot map to a fraction,
  // and must not have a refused command read as a successful one.
  const totalEl15 = document.getElementById('side-time-total');
  const artDurEl15 = document.getElementById('art-duration-display');
  const rail15 = document.getElementById('art-progress');
  const sideRail15 = document.querySelector('.side-progress-track');

  setTrackDuration(300000);
  result.durationKnownLabels = totalEl15.textContent + ' / ' + artDurEl15.textContent;
  result.durationKnownClass = body.classList.contains('duration-unknown');
  result.durationKnownPointerEvents = getComputedStyle(rail15).pointerEvents;
  if (result.durationKnownClass) problems.push('a known duration is marked unknown');
  if (result.durationKnownLabels.indexOf('5:00') === -1) {
    problems.push('the known duration was not shown: ' + result.durationKnownLabels);
  }
  if (result.durationKnownPointerEvents !== 'auto') {
    problems.push('the seek rail is inert while the duration is known: ' +
      result.durationKnownPointerEvents);
  }

  // null (and 0) mean "this player publishes no duration".
  setTrackDuration(null);
  result.durationUnknownLabels = totalEl15.textContent + ' / ' + artDurEl15.textContent;
  result.durationUnknownClass = body.classList.contains('duration-unknown');
  result.durationUnknownPointerEvents = getComputedStyle(rail15).pointerEvents;
  result.durationUnknownSidePointerEvents = getComputedStyle(sideRail15).pointerEvents;
  if (!result.durationUnknownClass) {
    problems.push('an unpublished duration is not marked unknown');
  }
  if (result.durationUnknownLabels.indexOf('--:--') === -1) {
    problems.push('an unpublished duration left stale text: ' + result.durationUnknownLabels);
  }
  if (result.durationUnknownPointerEvents !== 'none' ||
      result.durationUnknownSidePointerEvents !== 'none') {
    problems.push('the seek rail still offers a seek with no known total');
  }
  setTrackDuration(0);
  result.zeroDurationUnknown = body.classList.contains('duration-unknown');
  if (!result.zeroDurationUnknown) {
    problems.push('a zero duration was treated as a real total');
  }

  // The resolve report states the player's transport facts, so a dead timeline
  // reads as a fact about the player rather than a broken overlay.
  setTransportState({ app: 'Simpmusic_ejp2bhxmz1qq6!Simpmusic', timeline: false, duration: false });
  renderDiagnostics();
  const report15 = document.getElementById('qp-info-body').textContent;
  result.transportReport = /no timeline from player/.test(report15)
    && /duration unknown/.test(report15);
  if (!result.transportReport) {
    problems.push('the resolve report does not state the player transport: ' + report15);
  }
  setTransportState({ app: 'Spotify.exe', timeline: true, duration: true });
  renderDiagnostics();
  result.transportLiveReport =
    /timeline live/.test(document.getElementById('qp-info-body').textContent);
  if (!result.transportLiveReport) {
    problems.push('the resolve report does not report a live timeline');
  }

  // The report names the build that produced it. A user pasting theirs into a
  // bug report has then said which release they are on, which is the difference
  // between a fixable report and a guess.
  const savedDiagnostics = diagnostics;
  diagnostics = { app_version: '9.9.9', parser_version: 11 };
  renderDiagnostics();
  const versionReport = document.getElementById('qp-info-body').textContent;
  result.appVersionReported = /v9\.9\.9/.test(versionReport);
  result.parserVersionReported = /v11/.test(versionReport);
  if (!result.appVersionReported) {
    problems.push('the resolve report does not name the app version: ' + versionReport);
  }
  if (!result.parserVersionReported) {
    problems.push('the resolve report does not name the parser version');
  }
  diagnostics = savedDiagnostics;
  renderDiagnostics();

  // A refused seek goes back to where playback actually is; an accepted one is
  // kept, and reported as unverifiable when the player publishes no timeline.
  // The engine distrusts position reports for 900ms after a user seek (they are
  // echoes of the pre-seek position). That guard is WALL CLOCK, and a whole run
  // takes a few tens of milliseconds, so a second run in the same page session
  // would have its baseline swallow by the previous run's tail seek — the harness
  // expires the guard on purpose to stand in for real elapsed time.
  setPlaybackState(false);
  lastUserSeekAt = -Infinity;
  syncPlayhead(40000);
  applySeek(200000);
  result.seekOptimistic = Math.round(playheadMs);
  transportResult({ action: 'seek', ok: false, detail: 'player refused' });
  result.seekRolledBack = Math.round(playheadMs);
  result.seekRefusalReported =
    /refused/.test(document.getElementById('qp-info-body').textContent);
  if (result.seekOptimistic < 190000) {
    problems.push('the optimistic seek did not move the playhead');
  }
  if (Math.abs(result.seekRolledBack - 40000) > 2000) {
    problems.push('a refused seek was not rolled back: ' + result.seekRolledBack);
  }
  if (!result.seekRefusalReported) {
    problems.push('the refused seek is not reported');
  }
  applySeek(60000);
  transportResult({ action: 'seek', ok: true, verified: false, detail: '' });
  result.seekKept = Math.round(playheadMs);
  if (Math.abs(result.seekKept - 60000) > 2000) {
    problems.push('an accepted seek was rolled back anyway: ' + result.seekKept);
  }
  // ...and an accepted seek retires its rollback target, so a late or duplicate
  // refusal cannot drag the overlay back to a position playback already left.
  transportResult({ action: 'seek', ok: false, detail: 'late refusal' });
  result.seekLateRefusalIgnored = Math.abs(playheadMs - 60000) <= 2000;
  if (!result.seekLateRefusalIgnored) {
    problems.push('a late refusal rolled the playhead back: ' + Math.round(playheadMs));
  }

  setTransportState(null);
  setTrackDuration(213000);

  // --- 16. room air -------------------------------------------------------
  // The room has air in it, tinted with the album's own colour, and it must never
  // get in the way of a grab. The layout is asserted as a FUNCTION rather than by
  // reading back the elements it happened to build: a field that reshuffles on
  // every launch would pass an element count and fail its user.
  const dustField = document.getElementById('dust-field');
  result.dustPresent = !!dustField;
  if (!dustField) problems.push('no dust field');
  const motes = [...document.querySelectorAll('#dust-field .mote')];
  result.dustCount = motes.length;
  if (result.dustCount !== 28) {
    problems.push('the dust field holds ' + result.dustCount + ' motes, expected 28');
  }
  result.dustFieldPointerEvents = dustField ? getComputedStyle(dustField).pointerEvents : null;
  result.dustPointerEvents = motes.length > 0
    ? getComputedStyle(motes[0]).pointerEvents : null;
  if (result.dustFieldPointerEvents !== 'none' || result.dustPointerEvents !== 'none') {
    problems.push('the air takes pointer events: ' + result.dustFieldPointerEvents + '/' +
      result.dustPointerEvents);
  }

  const layoutA = dustLayout(16);
  const layoutB = dustLayout(16);
  result.dustLayoutDeterministic = JSON.stringify(layoutA) === JSON.stringify(layoutB);
  if (!result.dustLayoutDeterministic) problems.push('the dust layout is not deterministic');
  result.dustLayoutShape = layoutA.length;
  result.dustLayoutInRange = layoutA.every((m) =>
    m.x >= 0 && m.x < 1 && m.y >= 0 && m.y < 1 &&
    m.size >= 2.5 && m.size < 7 &&
    m.delay <= 0 && m.delay > -16 &&
    m.dur >= 10 && m.dur < 20 &&
    m.drift >= 0.6 && m.drift < 2.6);
  if (!result.dustLayoutInRange) {
    problems.push('a mote is outside its range: ' + JSON.stringify(layoutA.slice(0, 3)));
  }
  // A mote has to be big enough to BE a light. The first pass shipped 1.5-5px on
  // a single long gradient fade, which is a smudge on a dark room, not a mote.
  result.dustMoteMaxSize = Math.max(...layoutA.map((m) => m.size));
  if (!(result.dustMoteMaxSize >= 6)) {
    problems.push('the largest mote is ' + result.dustMoteMaxSize.toFixed(1) +
      'px — too small to read as a light');
  }

  // The tint is checked BEHAVIOURALLY, like the lamp: getComputedStyle resolves
  // color-mix() into literal rgba(), so the honest question is whether the painted
  // dot follows --art-accent.
  const rootDust = document.documentElement;
  const savedAccentDust = rootDust.style.getPropertyValue('--art-accent');
  const readMote = () => (motes[0] ? getComputedStyle(motes[0]).backgroundImage : '');
  rootDust.style.setProperty('--art-accent', 'rgb(220 40 40)');
  const warmMote = readMote();
  rootDust.style.setProperty('--art-accent', 'rgb(40 90 220)');
  const coolMote = readMote();
  if (savedAccentDust) rootDust.style.setProperty('--art-accent', savedAccentDust);
  else rootDust.style.removeProperty('--art-accent');
  result.dustFollowsAccent = !!warmMote && warmMote !== coolMote;
  if (!result.dustFollowsAccent) problems.push('the motes do not follow the artwork accent');

  // The drift moves transform and opacity only. A keyframe that moved `left`/`top`
  // would run layout on every frame of a layer that is on for the whole song.
  const dustSheet = flattenSheetRules();
  const driftKeyframes = dustSheet.filter((r) =>
    r.constructor.name === 'CSSKeyframesRule' && /mote-drift/.test(r.name));
  result.dustDriftKeyframes = driftKeyframes.length;
  result.dustDriftTransformOnly = driftKeyframes.length === 1 &&
    [...driftKeyframes[0].cssRules].every((k) =>
      !/\b(left|top|width|height|filter)\b/.test(k.style.cssText));
  if (!result.dustDriftTransformOnly) {
    problems.push('a mote-drift keyframe touches a layout or filter property');
  }
  result.dustTintDeclaration = dustSheet.some((r) =>
    r.selectorText === '.mote' && /--art-accent/.test(r.style ? r.style.cssText : ''));
  if (!result.dustTintDeclaration) problems.push('.mote does not read --art-accent');

  // The mode is the whole intensity, and every "leave it stock" state has to be
  // exactly stock: Off is invisible, mini hides it, and reduced motion hides it.
  const savedAmbientMode = ambientMode;
  ambientMode = 'off';
  applyAmbientMode();
  result.dustOffOpacity = parseFloat(getComputedStyle(dustField).opacity);
  if (result.dustOffOpacity !== 0) {
    problems.push('the air is visible while Room air is Off: ' + result.dustOffOpacity);
  }
  ambientMode = 'on';
  applyAmbientMode();
  result.dustOnOpacity = parseFloat(getComputedStyle(dustField).opacity);
  if (!(result.dustOnOpacity > 0)) {
    problems.push('the air is invisible while Room air is on');
  }
  ambientMode = savedAmbientMode;
  applyAmbientMode();

  setMiniMode(true);
  result.dustMiniDisplay = getComputedStyle(dustField).display;
  if (result.dustMiniDisplay !== 'none') {
    problems.push('the mini player keeps the room air: ' + result.dustMiniDisplay);
  }
  setMiniMode(false);

  // Reduced motion is asserted from the rule rather than by toggling the global
  // preference mid-run: the rule is what does the work, and toggling would restart
  // every engine for a check that is about CSS. `--dust-op` and the tilt numbers
  // are registered and transitioned on the root, but the gate's own `noAnim`
  // stylesheet suspends every transition, so these values settle immediately.
  const dustRules = dustSheet.filter((r) => r.selectorText && /dust-field/.test(r.selectorText));
  const dustText = dustRules.map((r) => r.selectorText + '{' + (r.style ? r.style.cssText : '') + '}').join('\n');
  result.dustReducedHidden = /\.reduce-motion[^{]*\.dust-field[^{]*\{[^}]*display:\s*none/.test(dustText);
  if (!result.dustReducedHidden) problems.push('reduced motion does not hide the room air');

  // The beat nudges the whole body of air on its own grid, and the drop puffs it —
  // both on properties the motes' drift does not use.
  result.dustBeatKick = /body\.beat-live[^{]*\.dust-field[^{]*\{[^}]*animation-name/.test(dustText);
  result.dustKickGrid = /animation-duration[^}]*--beat-ms/.test(dustText);
  if (!result.dustBeatKick) problems.push('the beat does not nudge the room air');
  if (!result.dustKickGrid) problems.push('the room air is not phase-locked to the beat grid');
  const kickKeyframes = dustSheet.filter((r) =>
    r.constructor.name === 'CSSKeyframesRule' && /dust-kick/.test(r.name));
  result.dustKickKeyframes = kickKeyframes.length;
  // The kick writes ONLY the field's own standalone properties: `translate` and
  // `scale`. Anything else — `transform` (a mote's own), `opacity` (the mode's),
  // or a layout property — is a bug the motes' drift or the setting would pay for.
  result.dustKickOwnProperties = kickKeyframes.length === 1 &&
    [...kickKeyframes[0].cssRules].every((k) => {
      const text = k.style.cssText;
      return !/\btransform\b|\bopacity\b/.test(text) &&
             !/\bleft\b|\btop\b|\bwidth\b|\bheight\b|\bfilter\b/.test(text);
    });
  if (!result.dustKickOwnProperties) {
    problems.push('a dust-kick keyframe writes a property another layer owns');
  }
  result.dustDropSurge = dustSheet.some((r) =>
    r.selectorText === 'body.beat-phase-drop' && /--dust-surge/.test(r.style ? r.style.cssText : ''));
  if (!result.dustDropSurge) problems.push('a drop does not puff the room air');

  // The row cycles the same three states as Beat sync and Big moments, and the
  // choice is written down.
  const ambientRow = document.getElementById('qp-ambient');
  const ambientState = document.getElementById('qp-ambient-state');
  result.ambientRow = !!ambientRow && !!ambientState;
  if (!result.ambientRow) problems.push('no Room air row');
  const ambientSeen = [];
  if (ambientRow && ambientState) {
    const startAmbient = ambientState.textContent.trim();
    for (let i = 0; i < 3; i++) {
      ambientRow.click();
      ambientSeen.push(ambientState.textContent.trim());
    }
    result.ambientRowCycles = ambientSeen;
    if (JSON.stringify(ambientSeen) !== JSON.stringify(['Bold', 'Off', 'Subtle'])) {
      problems.push('the Room air row cycles ' + ambientSeen.join(',') +
        ' (expected Bold,Off,Subtle from ' + startAmbient + ')');
    }
  }
  result.ambientPersisted = (() => {
    try { return localStorage.getItem('sl_ambientMode'); } catch (e) { return '(unavailable)'; }
  })();

  // Off has to be exactly stock, not merely transparent: leaving the field in the
  // tree keeps sixteen blurred layers animating behind nothing for the rest of the
  // session, which is the whole song.
  const savedAmbientForOff = ambientMode;
  ambientMode = 'off';
  applyAmbientMode();
  result.dustOffDisplay = getComputedStyle(dustField).display;
  if (result.dustOffDisplay !== 'none') {
    problems.push('Room air Off leaves the field in the tree: ' + result.dustOffDisplay);
  }
  result.dustOffPaused = getComputedStyle(motes[0]).animationPlayState;
  ambientMode = savedAmbientForOff;
  applyAmbientMode();
  result.dustOnDisplay = getComputedStyle(dustField).display;
  if (result.dustOnDisplay === 'none') problems.push('Room air On leaves the field hidden');

  // A mote is a 1.5-5px dot. A blur pass per mote buys nothing at that size and
  // costs a composited layer each, so the field must not carry one.
  result.moteFilter = motes.length > 0 ? getComputedStyle(motes[0]).filter : null;
  if (result.moteFilter !== 'none') {
    problems.push('a mote carries a filter: ' + result.moteFilter);
  }
  // The field has to be bright enough to see. Loud-pass feedback: the shipped
  // Subtle level read as nothing at all on a dark room.
  if (!(result.dustOnOpacity >= 0.6)) {
    problems.push('the room air is too faint on Subtle: ' + result.dustOnOpacity);
  }
  const moteOpacityMid = (() => {
    const kf = dustSheet.filter((r) =>
      r.constructor.name === 'CSSKeyframesRule' && /mote-drift/.test(r.name));
    if (kf.length !== 1) return null;
    const mid = [...kf[0].cssRules].find((k) => /50%/.test(k.keyText));
    return mid ? parseFloat(mid.style.opacity) : null;
  })();
  result.motePeakOpacity = moteOpacityMid;
  if (!(moteOpacityMid >= 0.8)) {
    problems.push('a mote never brightens past ' + moteOpacityMid + ' — too dim to notice');
  }

  // --- 17. cover tilt -----------------------------------------------------
  // The sleeve leans toward the pointer, and the room's blurred artwork
  // counter-moves. It has to lean on a layer of its OWN: the beat animates
  // .track-art's and .art-light's transforms, and the drift owns
  // .cover-art-blur's, so a tilt on either of those would be overwritten.
  setFullscreen(false);
  setMiniMode(false);
  const stages = [...document.querySelectorAll('.tilt-stage')];
  result.tiltStageCount = stages.length;
  if (result.tiltStageCount !== 2) {
    problems.push('expected one tilt stage per art wrap, found ' + result.tiltStageCount);
  }
  result.tiltStageHoldsArt = stages.length === 2 && stages.every((s) =>
    s.querySelectorAll('.art-light').length === 1 &&
    s.querySelectorAll('.track-art, .side-art').length === 1);
  if (!result.tiltStageHoldsArt) {
    problems.push('a tilt stage does not hold exactly one lamp and one artwork');
  }
  // The controls must NOT lean with the sleeve: chrome that tilts reads as broken.
  result.tiltChromeOutsideStage = stages.length === 2 && stages.every((s) =>
    !s.querySelector('.art-controls'));
  if (!result.tiltChromeOutsideStage) problems.push('the control row sits inside the tilt stage');
  // Stacking is NOT re-derived here: section 14 already measures whether the
  // artwork paints above its lamp (`artOverLamp` / `artPositions`), and a second
  // copy of that reading is a second thing to keep in step.

  result.tiltVectorEdges = [
    tiltVector(0, 0, { left: 0, top: 0, width: 100, height: 100 }),
    tiltVector(100, 100, { left: 0, top: 0, width: 100, height: 100 }),
    tiltVector(50, 50, { left: 0, top: 0, width: 100, height: 100 }),
  ];
  result.tiltVectorEdgesOk =
    result.tiltVectorEdges[0].x === -1 && result.tiltVectorEdges[0].y === -1 &&
    result.tiltVectorEdges[1].x === 1 && result.tiltVectorEdges[1].y === 1 &&
    result.tiltVectorEdges[2].x === 0 && result.tiltVectorEdges[2].y === 0;
  if (!result.tiltVectorEdgesOk) {
    problems.push('tiltVector is wrong at the edges: ' + JSON.stringify(result.tiltVectorEdges));
  }
  const clamped = tiltVector(-500, 900, { left: 0, top: 0, width: 100, height: 100 });
  result.tiltVectorClamped = clamped.x === -1 && clamped.y === 1;
  if (!result.tiltVectorClamped) {
    problems.push('tiltVector does not clamp: ' + JSON.stringify(clamped));
  }
  const degenerate = tiltVector(10, 10, { left: 0, top: 0, width: 0, height: 0 });
  result.tiltVectorDegenerate = Number.isFinite(degenerate.x) && Number.isFinite(degenerate.y);
  if (!result.tiltVectorDegenerate) problems.push('tiltVector returns NaN for a zero-size rect');

  const tiltSheet = flattenSheetRules();
  result.tiltRegistered = ['--tilt-x', '--tilt-y'].every((name) =>
    tiltSheet.some((r) => r.constructor.name === 'CSSPropertyRule' && r.name === name &&
      r.syntax === '<number>'));
  if (!result.tiltRegistered) problems.push('--tilt-x/--tilt-y are not registered <number>s');
  result.tiltTransition = tiltSheet.some((r) =>
    r.selectorText === ':root' && /--tilt-x/.test(r.style ? r.style.cssText : ''));
  if (!result.tiltTransition) problems.push('the tilt does not ease with the track');
  result.tiltBackdropParallax = tiltSheet.some((r) => r.selectorText === '.cover-art-blur' &&
    /translate/.test(r.style ? r.style.cssText : '') && /--tilt-x/.test(r.style.cssText));
  if (!result.tiltBackdropParallax) problems.push('the room does not counter-move with the tilt');
  const stageRules = tiltSheet.filter((r) => r.selectorText &&
    /tilt-stage/.test(r.selectorText));
  const stageText = stageRules.map((r) => r.selectorText + '{' + (r.style ? r.style.cssText : '') + '}').join('\n');
  result.tiltStageOwnsTransform = /transform[^;]*--tilt-x/.test(stageText);
  if (!result.tiltStageOwnsTransform) problems.push('the tilt stage does not read --tilt-x');
  result.tiltReducedNeutral = tiltSheet.some((r) =>
    r.selectorText && /\.reduce-motion[^{]*\.tilt-stage/.test(r.selectorText) &&
    /transform:\s*none/.test(r.style ? r.style.cssText : ''));
  if (!result.tiltReducedNeutral) problems.push('reduced motion does not rest the tilt');

  // The pointer publishes the lean; leaving the art releases it. Both are driven
  // through a real event on the wrap, because that is what the app listens for.
  const tiltRoot = document.documentElement;
  const tiltWrap = document.getElementById('float-art-wrap');
  const tiltRect = tiltWrap ? tiltWrap.getBoundingClientRect() : null;
  const tiltRead = () => [
    tiltRoot.style.getPropertyValue('--tilt-x'),
    tiltRoot.style.getPropertyValue('--tilt-y'),
  ];
  result.tiltWrapVisible = !!tiltRect && tiltRect.width > 0 && tiltRect.height > 0;
  if (!result.tiltWrapVisible) problems.push('the compact art is not measurable for the tilt');
  const savedTiltMode = tiltMode;
  if (tiltMode === 'off') cycleTilt();
  if (tiltRect && tiltRect.width > 0) {
    tiltWrap.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: tiltRect.right - 2,
      clientY: tiltRect.bottom - 2,
    }));
    result.tiltBottomRight = tiltRead().map((v) => parseFloat(v));
    tiltWrap.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: tiltRect.left + 2,
      clientY: tiltRect.top + 2,
    }));
    result.tiltTopLeft = tiltRead().map((v) => parseFloat(v));
    tiltWrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    result.tiltAfterLeave = tiltRead().map((v) => parseFloat(v));
  } else {
    result.tiltBottomRight = null;
    result.tiltTopLeft = null;
    result.tiltAfterLeave = null;
  }
  result.tiltFollowsPointer =
    !!result.tiltBottomRight && !!result.tiltTopLeft &&
    result.tiltBottomRight[0] > 0.5 && result.tiltBottomRight[1] > 0.5 &&
    result.tiltTopLeft[0] < -0.5 && result.tiltTopLeft[1] < -0.5;
  if (!result.tiltFollowsPointer) {
    problems.push('the sleeve does not follow the pointer: ' +
      JSON.stringify([result.tiltTopLeft, result.tiltBottomRight]));
  }
  result.tiltLeaveResets =
    !!result.tiltAfterLeave &&
    Math.abs(result.tiltAfterLeave[0]) < 0.001 && Math.abs(result.tiltAfterLeave[1]) < 0.001;
  if (!result.tiltLeaveResets) {
    problems.push('leaving the art does not release the lean: ' + JSON.stringify(result.tiltLeaveResets));
  }

  // And the lean has to be big enough to READ. Loud-pass feedback was that even
  // Bold did not register: at 2.4deg on a 760px perspective a 96px sleeve moves
  // its corners about two pixels. This pins the shipped angle so a later "tidy"
  // cannot quietly shrink it back into nothingness.
  while (tiltMode !== 'bold' && tiltMode !== 'off') cycleTilt();
  if (tiltMode === 'off') cycleTilt();
  const angleWrap = document.getElementById('float-art-wrap');
  const angleRect = angleWrap.getBoundingClientRect();
  angleWrap.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, clientX: angleRect.right - 2, clientY: angleRect.top + 2,
  }));
  const angleStage = document.querySelector('.tilt-stage');
  const angleMatrix = getComputedStyle(angleStage).transform;
  const angleNums = ((angleMatrix.match(/matrix3d\(([^)]+)\)/) || [null, ''])[1])
    .split(',').map(Number);
  result.tiltBoldAngleDeg = angleNums.length === 16
    ? +(Math.asin(Math.max(-1, Math.min(1, angleNums[2]))) * 180 / Math.PI).toFixed(2)
    : null;
  if (!(Math.abs(result.tiltBoldAngleDeg) >= 6.5)) {
    problems.push('the lean is too small to read in Bold: ' + result.tiltBoldAngleDeg + 'deg');
  }
  // The lift and the gloss are what make the lean legible; both must scale with
  // the amplitude, so Off and reduced motion keep showing an unlifted, unglossed
  // sleeve rather than a shiny one held at a stale angle.
  result.tiltLiftScalesWithAmp = /scale\(calc\([^)]*--tilt-amp/.test(stageText);
  if (!result.tiltLiftScalesWithAmp) {
    problems.push('the tilt lift does not scale with the amplitude');
  }
  result.tiltGloss = tiltSheet.some((r) =>
    /tilt-stage::after/.test(r.selectorText || '') &&
    /linear-gradient/.test(r.style ? r.style.cssText : ''));
  result.tiltGlossScalesWithAmp = tiltSheet.some((r) =>
    /tilt-stage::after/.test(r.selectorText || '') &&
    /opacity[^;]*--tilt-mag/.test(r.style ? r.style.cssText : ''));
  if (!result.tiltGloss) problems.push('the sleeve has no gloss to make the lean legible');
  if (!result.tiltGlossScalesWithAmp) problems.push('the gloss does not follow the lean');
  resetTilt();

  // Off is the same code path at zero: the multiplier is 0 and a pointer move
  // publishes nothing.
  while (tiltMode !== 'off') cycleTilt();
  result.tiltAmpOff = tiltRoot.style.getPropertyValue('--tilt-amp');
  if (result.tiltAmpOff !== '0') problems.push('Cover tilt Off leaves an amplitude: ' + result.tiltAmpOff);
  resetTilt();
  if (tiltRect && tiltRect.width > 0) {
    tiltWrap.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: tiltRect.right - 2, clientY: tiltRect.bottom - 2,
    }));
  }
  result.tiltOffNeutral = tiltRead().every((v) => parseFloat(v) === 0);
  if (!result.tiltOffNeutral) problems.push('the sleeve leans while Cover tilt is Off');

  // ...and the row cycles the same three states as the rest of the family.
  const tiltRow = document.getElementById('qp-tilt');
  const tiltState = document.getElementById('qp-tilt-state');
  result.tiltRow = !!tiltRow && !!tiltState;
  if (!result.tiltRow) problems.push('no Cover tilt row');
  const tiltSeen = [];
  if (tiltRow && tiltState) {
    for (let i = 0; i < 3; i++) {
      tiltRow.click();
      tiltSeen.push(tiltState.textContent.trim());
    }
    result.tiltRowCycles = tiltSeen;
    if (JSON.stringify(tiltSeen) !== JSON.stringify(['Subtle', 'Bold', 'Off'])) {
      problems.push('the Cover tilt row cycles ' + tiltSeen.join(',') +
        ' (expected Subtle,Bold,Off from Off)');
    }
  }
  result.tiltPersisted = (() => {
    try { return localStorage.getItem('sl_tiltMode'); } catch (e) { return '(unavailable)'; }
  })();

  // A lean must not survive a path that takes the art away. The layout button
  // sits ON the sleeve, so "lean it, then switch compact -> split" is two clicks
  // rather than a corner case: the float goes display:none, and no mouseleave is
  // dispatched for a subtree that left the rendering tree.
  // The row-cycle block above leaves Cover tilt Off, and a lean cannot be
  // published in that state — put it back on so these two checks are about the
  // reset, not about the setting.
  if (tiltMode === 'off') cycleTilt();
  setFullscreen(true);
  resetTilt();
  const leanWrap = document.getElementById('float-art-wrap');
  const leanRect = leanWrap.getBoundingClientRect();
  leanWrap.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, clientX: leanRect.right - 2, clientY: leanRect.bottom - 2,
  }));
  result.tiltLeanBeforeLayout = tiltRead().map((v) => parseFloat(v));
  if (!(Math.abs(result.tiltLeanBeforeLayout[0]) > 0.5)) {
    problems.push('the layout-change check could not lean the sleeve first');
  }
  cycleLayout();                                   // compact -> split
  result.tiltLeanClearedOnLayout = tiltRead().every((v) => parseFloat(v) === 0);
  if (!result.tiltLeanClearedOnLayout) {
    problems.push('a lean survives a layout change: ' + JSON.stringify(tiltRead()));
  }
  cycleLayout();                                   // back to compact
  setFullscreen(false);

  // ...and the same for the window losing focus. Chromium does not dispatch
  // mouseleave for a pointer parked on the art when you Alt-Tab away, so without
  // a blur reset the sleeve stays leaned for as long as you are gone.
  const blurWrap = document.getElementById('float-art-wrap');
  const blurRect = blurWrap.getBoundingClientRect();
  blurWrap.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, clientX: blurRect.right - 2, clientY: blurRect.top + 2,
  }));
  result.tiltLeanBeforeBlur = tiltRead().map((v) => parseFloat(v));
  if (!(Math.abs(result.tiltLeanBeforeBlur[1]) > 0.5)) {
    problems.push('the blur check could not lean the sleeve first');
  }
  window.dispatchEvent(new Event('blur'));
  result.tiltLeanClearedOnBlur = tiltRead().every((v) => parseFloat(v) === 0);
  if (!result.tiltLeanClearedOnBlur) {
    problems.push('a lean survives the window losing focus: ' + JSON.stringify(tiltRead()));
  }

  // --- 12. artwork and air hygiene --------------------------------------
  // A cover URL comes from a third-party artwork lookup (iTunes / Deezer), so it
  // is untrusted text written into a CSS value. Bare interpolation into
  // url("${url}") means a quote in the URL ends the value early, and the rest of
  // it is then parsed as more CSS — the stylesheet equivalent of an injection,
  // reachable from a lookup result, a redirect or a hand-crafted URL.
  //
  // The assertion is survival, not a substring match on the CSS text: an escaped
  // URL parses back into exactly the string that was set, so it round-trips
  // through the CSSOM byte-for-byte, while an unescaped one is cut short at the
  // break-out and the layer loses its artwork entirely (measured against the
  // original code: BOTH a quote and an ampersand URL resolved to an EMPTY
  // backgroundImage, which is the silent way to lose every cover with an & in
  // its query string).
  const backdrop = document.querySelector('.ambient-backdrop');
  const coverProbe = (url) => {
    window.setCoverArt(url, false);
    const layers = backdrop ? backdrop.querySelectorAll('.cover-art-blur') : [];
    const layer = layers[layers.length - 1];
    const value = layer ? layer.style.backgroundImage || '' : '';
    if (layer) layer.remove();
    return value;
  };
  // A surviving URL keeps its head, its tail and its closing quote. Asserted
  // structurally rather than by equality with the input: the CSSOM re-serializes
  // what it parsed, so an escaped quote comes back escaped and a byte-for-byte
  // comparison would fail on the fix it is meant to accept.
  const survived = (value, url) => {
    const trimmed = (value || '').trim();
    return trimmed.startsWith('url("') && trimmed.endsWith('")')
      && trimmed.includes(url.slice(0, 24)) && trimmed.includes(url.slice(-6));
  };
  const quoteUrl = 'https://example.invalid/a"b.png';
  const quoteResult = coverProbe(quoteUrl);
  result.coverQuoteUrlSurvives = survived(quoteResult, quoteUrl);
  if (!result.coverQuoteUrlSurvives) {
    problems.push('a quote in a cover URL did not survive into the background: '
      + JSON.stringify(quoteResult));
  }
  const ampUrl = 'https://example.invalid/a&b.png';
  const ampResult = coverProbe(ampUrl);
  result.coverAmpersandUrlSurvives = survived(ampResult, ampUrl);
  if (!result.coverAmpersandUrlSurvives) {
    problems.push('an ampersand in a cover URL did not survive into the background: '
      + JSON.stringify(ampResult));
  }
  window.setCoverArt(null, false);

  // Rebuilding the air must REPLACE the field, not leave the previous motes
  // behind. The old guard returned early only while the field was non-empty, so
  // the moment anything left it holding a different count the next build
  // appended a second full set: twice the nodes, twice the compositing, for a
  // count the design tuned. Seeded with a known-wrong count first, because that
  // is the state a mode change can actually leave behind — and the only state in
  // which the old early-return let a rebuild stack.
  const dust = document.getElementById('dust-field');
  if (!dust) {
    problems.push('the dust field is missing from the page');
  } else {
    const savedMotes = [...dust.children];
    dust.textContent = '';
    for (let i = 0; i < 3; i++) dust.appendChild(document.createElement('i'));
    buildDustField();
    result.dustRebuildFromPartialCount = dust.childElementCount;
    result.dustRebuildIsExact = dust.childElementCount === DUST_COUNT;
    if (!result.dustRebuildIsExact) {
      problems.push('rebuilding the air from a partial field left '
        + dust.childElementCount + ' motes, expected ' + DUST_COUNT);
    }
    if (dust.childElementCount !== DUST_COUNT) {
      dust.textContent = '';
      for (const mote of savedMotes) dust.appendChild(mote);
    }
  }

  // leave the app in the state the checks started from
  tiltMode = savedTiltMode;
  applyTiltMode();
  resetTilt();

  // restore the state the checks started from
  noAnim.remove();
  setFullscreen(wasFullscreen);
  if (wasMini) setMiniMode(true);

  console[problems.length ? 'error' : 'log'](problems.length ? problems : 'PASS', result);
  // The failures travel with the result, not only through the console: a caller
  // that runs these checks programmatically (tools/run-ui-preview-regression.mjs)
  // reads `result.problems`, and a caller that does not see them there can only
  // report a pass — which is how a suite that never ran its assertions looks
  // exactly like a suite that passed them.
  result.problems = problems;
  return result;
}
