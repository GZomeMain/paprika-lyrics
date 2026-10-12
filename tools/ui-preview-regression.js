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
 *      overlay-first, the density token still compacts below 420px of height, and
 *      every group is a dropdown: closed unless it was opened before, still saying
 *      what it stands for while closed, opening one group at a time, and handing
 *      its rows to a search that lifted them out of it. A group that declares
 *      itself `data-static` in the markup stays open with no toggle — Diagnostics,
 *      whose own row already carries the disclosure.
 *   6. The on-art progress bar publishes a playhead position for its dot, and
 *      both totals start as `--:--` under `body.duration-unknown` rather than as
 *      a 0:00 length the host has not reported.
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
 *      after the seek already landed is ignored. A position report from the
 *      bridge carries how the playhead must take it: a snap lands on it, soft
 *      drift is absorbed as a correction instead of teleporting the wipe, a
 *      report inside the noise floor is dropped, and a hold moves nothing — the
 *      wipe keeps its own 1x clock through any number of them, because a held
 *      source is still a live one.
 *  11. Room air and cover tilt: the motes are laid out deterministically and are
 *      tinted with the album's colour, the air never takes a pointer event, and
 *      Off / reduced motion / the mini player leave the room stock; and the
 *      sleeve leans only because its own stage carries the tilt, with the beat's
 *      surfaces and the artwork's stacking order untouched.
 *  12. Artwork and air hygiene: a cover URL from a third-party lookup cannot
 *      break out of the CSS it is written into (a quote or a paren in it stays
 *      inside the url()), and rebuilding the air never stacks a second mote
 *      field on the first.
 *  13. The lyric-video export: the settings row expands and collapses, and the
 *      recording HUD it stands in for is OUTSIDE the settings sheet (so closing
 *      the sheet cannot hide a recording with minutes left), hidden at rest,
 *      carrying both ways out of one, and clear of every drag surface. The
 *      frame renderer is proven to draw the snapshot it is handed rather than
 *      the track playing right now: the same snapshot redrawn after the live
 *      lyric list is swapped out is pixel-identical, and a snapshot built from
 *      other lines is not — which is what keeps the first half from passing
 *      vacuously on a blank canvas.
 *  14. The playhead's glide: a player-side seek inside the song travels to its
 *      new position instead of cutting to it (the catch-up is over in a fraction
 *      of a second), a snap still lands on the frame it is reported on, and the
 *      glide is not secretly a snap — the report that opens it leaves the wipe
 *      exactly where it already was. The wipe RIDES that travel, backwards
 *      included: held forward-only, a seek backwards pinned the wipe and the
 *      lyrics never followed the player.
 *  15. Fonts are a list of faces, not a counter against a cap: each row is drawn
 *      in the face it names, a face is offered only the jobs it can hold, one
 *      click gives it one, and an import is removed from its own row — armed
 *      first, through the host, with the bytes fetched from the font folder on
 *      demand and a file that will not load reported instead of used.
 *  19. A long line cannot leave the column: the column clips sideways, so a run
 *      wider than it is CUT rather than scrolled, and the tail of the line is
 *      simply gone. A long word and a line-synced script that writes no spaces
 *      (the fallback splits those per character) wrap between their syllables at
 *      full size, and a line whose widest SYLLABLE still does not fit is scaled
 *      through --line-fit — measured here against real payloads at both windowed
 *      and fullscreen sizes, in the idle and the sung state, because the fitting
 *      is only as good as the metrics it used.
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
  // The opt-out never stomps the cursors of the controls inside it. Measured
  // with a length in hand, because a rail with no known total is inert ON
  // PURPOSE (see body.duration-unknown in the stylesheet) — that is a different
  // rule, and reading the cursor without establishing which state the page is in
  // made this pass or fail on whatever the previous check happened to leave.
  setTrackDuration(213000);
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
    lyrics: ['Sync', 'Lyrics', 'Fonts', 'Spicy Lyrics API', 'Local lyrics'],
    visuals: ['Motion'],
    diag: ['Diagnostics'],
  };
  result.settingsTabGroups = {};
  for (const tab of tabs) {
    const id = tab.dataset.tab;
    openSettingsTab(id);
    // Named by the group, not by its heading row's text: the heading now carries
    // the dropdown toggle and the state it reports, which is not the group's name.
    result.settingsTabGroups[id] = [...document.querySelectorAll('#qp-panel-' + id + ' .sp-group')]
      .map((g) => g.dataset.groupName || (g.querySelector('.sp-group-title') || {}).textContent || '');
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

  // --- 5b. the groups are dropdowns --------------------------------------
  // A page opens as a short list of summary rows. The rows stay inside their own
  // group — the search lifts them in and out — so what has to hold is: closed
  // unless this group was opened before, one toggle one group, the closed row
  // still reporting the state it stands for, and a row inside a CLOSED group
  // still reachable by the search.
  openSettingsTab('lyrics');
  const lyricGroups = [...document.querySelectorAll('#qp-panel-lyrics .sp-group[data-group]')];
  result.settingsGroupCount = lyricGroups.length;
  if (lyricGroups.length !== 5) {
    problems.push('the Lyrics page holds ' + lyricGroups.length + ' groups, expected 5');
  }
  result.settingsGroupsHonourSavedState = lyricGroups.filter((g) =>
    g.classList.contains('collapsed') === (localStorage.getItem('sl_spGroup_' + g.dataset.group) !== '1')
  ).length === lyricGroups.length;
  if (!result.settingsGroupsHonourSavedState) {
    problems.push('a settings group does not match the state saved for it');
  }
  // The default is closed: with no choice saved for a group, restoring it closes
  // it. Driven through the app's own restore path, so this reads the behaviour a
  // first run gets rather than a hook the harness invented.
  const fontsGroup = document.querySelector('#qp-panel-lyrics .sp-group[data-group="fonts"]');
  const savedFontsGroup = localStorage.getItem('sl_spGroup_fonts');
  localStorage.removeItem('sl_spGroup_fonts');
  applySettingsGroup('fonts', settingsGroupOpen('fonts'), false);
  result.settingsGroupDefaultIsClosed = fontsGroup.classList.contains('collapsed');
  if (!result.settingsGroupDefaultIsClosed) problems.push('a settings group opens expanded by default');
  result.settingsGroupTogglesWired = lyricGroups.every((g) => {
    const t = g.querySelector('.sp-group-title > .sp-group-toggle');
    return !!t && t.getAttribute('aria-controls') === g.id && !!g.id
      && t.getAttribute('aria-expanded') === (g.classList.contains('collapsed') ? 'false' : 'true');
  });
  if (!result.settingsGroupTogglesWired) problems.push('a settings group toggle is not wired to its group');
  // A closed group lays out none of its own rows: the heading row is all there is.
  const syncGroup = document.querySelector('#qp-panel-lyrics .sp-group[data-group="sync"]');
  const syncRows = [...syncGroup.children].filter((el) => el.classList.contains('qp-row'));
  result.closedGroupHidesItsRows = syncRows.length > 0
    && syncRows.every((el) => el.getBoundingClientRect().height === 0);
  if (!result.closedGroupHidesItsRows) problems.push('a closed group still lays out its rows');
  // The closed row reports the state the group stands for, and reports the SAME
  // state the row inside it does — read live, not at the moment it was built.
  result.closedGroupSummary = (document.getElementById('sp-group-sum-sync') || {}).textContent;
  const movedLatency = document.getElementById('qp-latency').textContent.trim();
  // Driven through the setting itself, not by writing the row's text: the panel
  // sync rewrites that row from `latencyOffsetMs`, so a poked string would be
  // overwritten before the summary could ever read it.
  const savedLatencyMs = latencyOffsetMs;
  latencyOffsetMs = 1230;
  syncSettingsPanel();
  result.closedGroupSummaryFollows =
    document.getElementById('sp-group-sum-sync').textContent.trim() === '+1230ms';
  if (!result.closedGroupSummaryFollows) {
    problems.push('the closed Sync row does not follow the row it stands for');
  }
  latencyOffsetMs = savedLatencyMs;
  syncSettingsPanel();
  result.closedGroupSummaryMatchesRow =
    document.getElementById('sp-group-sum-sync').textContent.trim() === movedLatency;
  if (!result.closedGroupSummaryMatchesRow) {
    problems.push('the closed Sync row reads "' + result.closedGroupSummary.trim() + '"');
  }
  // One click opens one group. The state a click writes is put back, so a run
  // does not silently change what the reader will see next time.
  const storedSyncGroup = localStorage.getItem('sl_spGroup_sync');
  const openBefore = lyricGroups.filter((g) => !g.classList.contains('collapsed')).length;
  syncGroup.querySelector('.sp-group-toggle').click();
  result.groupOpensOnClick = !syncGroup.classList.contains('collapsed')
    && syncGroup.querySelector('.sp-group-toggle').getAttribute('aria-expanded') === 'true'
    && syncGroup.querySelector('.qp-row').getBoundingClientRect().height > 0;
  result.oneClickOpensOneGroup =
    lyricGroups.filter((g) => !g.classList.contains('collapsed')).length === openBefore + 1;
  if (!result.groupOpensOnClick) problems.push('clicking a group row did not expand its group');
  if (!result.oneClickOpensOneGroup) problems.push('one click expanded more than its own group');
  syncGroup.querySelector('.sp-group-toggle').click();
  result.groupClosesOnClick = syncGroup.classList.contains('collapsed')
    && syncGroup.querySelector('.sp-group-toggle').getAttribute('aria-expanded') === 'false';
  if (!result.groupClosesOnClick) problems.push('clicking an expanded group row did not close it');
  if (storedSyncGroup === null) {
    localStorage.removeItem('sl_spGroup_sync');
  } else {
    localStorage.setItem('sl_spGroup_sync', storedSyncGroup);
  }
  if (savedFontsGroup === null) {
    localStorage.removeItem('sl_spGroup_fonts');
  } else {
    localStorage.setItem('sl_spGroup_fonts', savedFontsGroup);
  }
  applySettingsGroup('sync', settingsGroupOpen('sync'), false);
  applySettingsGroup('fonts', settingsGroupOpen('fonts'), false);
  // A row inside a CLOSED group is still found: the result view is built out of
  // the group's own rows and is never itself collapsed.
  runSettingsSearch('default latency');
  result.closedGroupRowIsSearchable =
    document.querySelector('#qp-body .sp-result #qp-default-latency') ===
    document.getElementById('qp-default-latency');
  if (!result.closedGroupRowIsSearchable) {
    problems.push('a row inside a closed group is unreachable by the search');
  }
  // …and the result is headed by the group's name, not by the closed row's own
  // text (the heading carries the toggle and the state now).
  const searchGroupHeading = document.querySelector('#qp-body .sp-result .sp-group-title');
  result.searchResultHeadingIsGroupName = !!searchGroupHeading
    && searchGroupHeading.textContent.trim() === 'Sync';
  if (!result.searchResultHeadingIsGroupName) {
    problems.push('a search result is headed "' +
      (searchGroupHeading ? searchGroupHeading.textContent.trim() : '(none)') + '"');
  }
  runSettingsSearch('');
  result.dropdownLeavesSearchClean = document.querySelectorAll('#qp-body .sp-result').length === 0;
  if (!result.dropdownLeavesSearchClean) {
    problems.push('clearing the search after a group was collapsed left results behind');
  }
  // …except a group that declares itself static in the markup. Diagnostics is one
  // row whose own Show / Hide IS the disclosure, so the group must not add a
  // second one: no toggle, never collapsed, and its row laid out to prove it.
  openSettingsTab('diag');
  const staticGroup = document.querySelector('#qp-panel-diag .sp-group');
  result.staticGroupHasNoDropdown = !!staticGroup
    && !staticGroup.querySelector('.sp-group-toggle')
    && !staticGroup.classList.contains('collapsed')
    && document.getElementById('qp-info-toggle').getBoundingClientRect().height > 0;
  if (!result.staticGroupHasNoDropdown) {
    problems.push('the Diagnostics group is a dropdown again');
  }
  openSettingsTab('visuals');

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

  // The Line-by-line row cycles Auto -> On -> Off under a persisted mode.
  const savedLineSync = lineSyncMode;
  lineSyncMode = 'auto';
  const lineCycles = [];
  for (let i = 0; i < 4; i++) {
    cycleLineSync();
    lineCycles.push(document.getElementById('qp-linesync-state').textContent.trim());
  }
  result.lineSyncRowCycles = lineCycles;
  if (JSON.stringify(lineCycles) !== JSON.stringify(['On', 'Off', 'Auto', 'On'])) {
    problems.push('the Line-by-line row cycles ' + lineCycles.join(' -> '));
  }
  lineSyncMode = savedLineSync;
  syncSettingsPanel();
  // --- 14. a player-side seek glides to its place -------------------------
  const expSavedPlaying = isPlaying;
  const expSavedHead = playheadMs;
  const expSavedDrift = targetDriftMs;
  const expSavedAnchor = anchorPosMs;
  const expSavedWall = anchorWallMs;
  const expSavedSeekAt = lastUserSeekAt;
  const expSavedGlide = glideUntilMs;
  try {
    // Seeded, not inherited. With no transport behind it a plain browser leaves
    // the app on the clock it boots with (anchor 0, wall stamp 0), so
    // ``predictedPlayhead()`` reads as the PAGE's uptime — and a glide measured
    // from there eases in from uptime instead of from the wipe. Where the wipe is
    // has to be stated for this to measure the glide rather than the page load.
    lastUserSeekAt = -Infinity;   // a seek an earlier check made must not veto this one
    isPlaying = true;
    glideUntilMs = 0;             // so the window below is the one THIS report opens
    playheadMs = 300000;
    renderMs = 300000;
    anchorPosMs = 300000;
    anchorWallMs = performance.now();
    targetDriftMs = 0;
    const expFrom = playheadMs;
    const expStartedAt = performance.now();
    syncPlayhead(301200, 'glide');
    // No frame can run between those two statements: a glide that teleported
    // would already be at the new position here.
    result.glideDoesNotTeleport = playheadMs === expFrom && expFrom === 300000;
    if (!result.glideDoesNotTeleport) {
      problems.push('a glide landed at ' + Math.round(playheadMs) + ' instead of travelling from ' + expFrom);
    }
    // A snap lands and opens no travel window. A glide opens SYNC_GLIDE_MS from
    // now, and that window is the whole difference: it is what tells tick() to
    // ease the wipe across instead of cutting it.
    result.glideWindowOpened = glideUntilMs > performance.now() + 100;
    if (!result.glideWindowOpened) {
      problems.push('a player-side seek opened no glide window (glideUntilMs ' + Math.round(glideUntilMs) + ')');
    }
    // Where the audio is, measured from the moment the report arrived.
    const expAudioAt = (now) => 301200 + (now - expStartedAt);
    let expCaught = -1;
    const expGiveUp = expStartedAt + 1500;
    // The error series is kept so a failure says HOW the travel went wrong —
    // standing still and easing too slowly look the same in a single number.
    const expErrors = [];
    const expTrace = [];
    for (;;) {
      const expNow = performance.now();
      expErrors.push(Math.round(playheadMs - expAudioAt(expNow)));
      expTrace.push(Math.round(expNow - expStartedAt) + 'ms a=' + Math.round(anchorPosMs)
        + ' w=' + Math.round(anchorWallMs - expStartedAt) + ' d=' + Math.round(targetDriftMs)
        + ' g=' + Math.round(glideUntilMs - expStartedAt));
      if (Math.abs(playheadMs - expAudioAt(expNow)) <= 100) {
        expCaught = Math.round(expNow - expStartedAt);
        break;
      }
      if (expNow >= expGiveUp) break;
      // Whichever comes first: waiting for a frame must not be able to hang the run.
      await Promise.race([
        new Promise((resolve) => requestAnimationFrame(resolve)),
        new Promise((resolve) => setTimeout(resolve, 250)),
      ]);
    }
    result.glideCatchUpMs = expCaught;
    if (expCaught < 0 || expCaught > 500) {
      // With the frame loop named in the failure: a catch-up that never happens
      // because no frame ran is a different bug from one that eases too slowly.
      problems.push('a player-side seek took '
        + (expCaught < 0 ? 'longer than 1500ms' : expCaught + 'ms')
        + ' to catch up with the audio (loop=' + renderLoopActive
        + ' lastFrameAgo=' + Math.round(performance.now() - lastTick)
        + 'ms playing=' + isPlaying
        + ' errors=' + expErrors.slice(0, 6).join(',') + '…' + expErrors.slice(-2).join(',')
        + ' trace=' + expTrace.slice(0, 5).join(' | ') + ' … ' + expTrace.slice(-2).join(' | ') + ')');
    }
    // A snap still lands on the frame it is reported on.
    syncPlayhead(400000, 'snap');
    result.snapLandsAtOnce = playheadMs === 400000;
    if (!result.snapLandsAtOnce) problems.push('a snap settled at ' + Math.round(playheadMs));
  } finally {
    isPlaying = expSavedPlaying;
    playheadMs = expSavedHead;
    targetDriftMs = expSavedDrift;
    anchorPosMs = expSavedAnchor;
    anchorWallMs = expSavedWall;
    lastUserSeekAt = expSavedSeekAt;
    glideUntilMs = expSavedGlide;
  }


  openSettingsTab('window');
  // One hint per page that needs one: Window, Sync, Lyrics (the font families),
  // Local lyrics and Motion. The count is pinned so a new hint has to be a
  // deliberate edit here rather than an unremarked sixth page of prose.
  result.settingsHints = document.querySelectorAll('#quick-panel .sp-hint').length;
  if (result.settingsHints !== 5) {
    problems.push('the sheet carries ' + result.settingsHints + ' hints, expected 5');
  }
  // Every row is a <button>, whose user-agent text-align is `center` — the label
  // span inside inherits it, so action rows centred their text while the div rows
  // and the group titles stayed left. One column, one edge. A hidden panel
  // reports zero rects, so this reads the panel that is up — and the groups are
  // dropdowns, so they are opened first: a closed group lays out none of its rows,
  // and a zero-height rect is not a measurement. Opened without persisting, so a
  // regression run cannot edit the reader's own saved groups.
  for (const g of document.querySelectorAll('#qp-body .sp-group[data-group]')) {
    applySettingsGroup(g.dataset.group, true, false);
  }
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
  // Opened for the measurement above, so closed again here: this suite is run at
  // five viewports against ONE page, and the next run has to find the sheet the
  // way it boots. Restored to the saved state, not blanket-closed, so a reader
  // who has a group open keeps it.
  for (const g of document.querySelectorAll('#qp-body .sp-group[data-group]')) {
    applySettingsGroup(g.dataset.group, settingsGroupOpen(g.dataset.group), false);
  }
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
  // The totals the page SHIPS are `--:--` under a body marked duration-unknown:
  // a length the host has not reported is not a 0:00 total, which is the same
  // fabricated number the host refuses to report for a player that publishes
  // none, and it made an honest `--:--` indistinguishable from a push that never
  // arrived. Read from the source rather than the live DOM, because by this point
  // a repeated run has already pushed a real length — a check that only works
  // when it happens to go first passes for the wrong reason.
  let shipped = '';
  try { shipped = await (await fetch('index.html')).text(); } catch (e) { shipped = ''; }
  const shippedDur = shipped.match(/id="art-duration-display"[^>]*>([^<]*)</);
  const shippedTotal = shipped.match(/id="side-time-total"[^>]*>([^<]*)</);
  result.shippedDurationLabels = (shippedTotal ? shippedTotal[1] : '?') + ' / ' +
    (shippedDur ? shippedDur[1] : '?');
  result.shippedDurationUnknown = /<body[^>]*class="[^"]*duration-unknown/.test(shipped);
  if (!shipped) {
    problems.push('the page source could not be read back to check its shipped totals');
  } else {
    if (result.shippedDurationLabels.indexOf('--:--') === -1) {
      problems.push('the page ships a total before the host has reported one: ' +
        result.shippedDurationLabels);
    }
    if (!result.shippedDurationUnknown) {
      problems.push('the page does not ship marked duration-unknown');
    }
  }

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
  const scrollerStyle = getComputedStyle(scroller);
  result.lyricsOverflowX = scrollerStyle.overflowX;
  result.lyricsScrollbarWidth = scrollerStyle.scrollbarWidth;
  // The right inset is the room the active line's scale needs, so the thing worth
  // pinning is that it HAS that room — a row that reaches the edge of the column is
  // drawn at scale(1.025) from its left edge plus a 2px lean, and a flat 32px inset left
  // the last glyph of the active line a few px outside a wide window. The 32px floor is
  // asserted too: narrow windows must keep the gutter they always had.
  result.lyricsPaddingRight = parseFloat(scrollerStyle.paddingRight) || 0;
  const columnWidth = scroller.clientWidth - (parseFloat(scrollerStyle.paddingLeft) || 0)
    - result.lyricsPaddingRight;
  const activeLineRoom = columnWidth * 0.025 + 2;
  result.lyricsActiveLineRoom = Math.round(activeLineRoom * 10) / 10;
  if (result.lyricsPaddingRight < 32) {
    problems.push('the lyric column lost its minimum right inset: ' + result.lyricsPaddingRight);
  }
  if (result.lyricsPaddingRight + 0.5 < activeLineRoom) {
    problems.push('the lyric column has no room for the active line\u2019s scale: '
      + result.lyricsPaddingRight + 'px inset for ' + activeLineRoom.toFixed(1) + 'px of growth');
  }
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
  // The air takes its tint from the cover, per vertical half, pre-offset
  // against the region it floats in front of. The same synthetic pixels drive it:
  // blue on top, red below, so the two halves MUST come back distinct, and the
  // tint must not equal the raw winner (the region contrast is part of the deal).
  const halfPixels = new Uint8ClampedArray(4 * ACCENT_GRID * ACCENT_GRID);
  for (let y = 0; y < ACCENT_GRID; y++) {
    for (let x = 0; x < ACCENT_GRID; x++) {
      const i = (y * ACCENT_GRID + x) * 4;
      if (y < ACCENT_GRID / 2) {
        halfPixels[i] = 40; halfPixels[i + 1] = 90; halfPixels[i + 2] = 220;
      } else {
        halfPixels[i] = 220; halfPixels[i + 1] = 60; halfPixels[i + 2] = 40;
      }
      halfPixels[i + 3] = 255;
    }
  }
  result.motePalette = extractPalette(halfPixels);
  if (!result.motePalette || !result.motePalette[0] || !result.motePalette[1] ||
      result.motePalette[0].b <= result.motePalette[0].r ||
      result.motePalette[1].r <= result.motePalette[1].b) {
    problems.push('the mote palette does not split by vertical half: ' +
      JSON.stringify(result.motePalette));
  }
  result.moteTintTop = offsetTintAgainstRegion(result.motePalette[0],
    halfRegionLuma(halfPixels, 0));
  result.moteTintBottom = offsetTintAgainstRegion(result.motePalette[1],
    halfRegionLuma(halfPixels, 1));
  if (result.moteTintTop === result.moteTintBottom) {
    problems.push('a two-region cover produced one mote tint');
  }
  // The motes carry their colour as --mote-c with the accent as the fallback, so
  // a cover with no palette (grey, blown out) leaves the accent lighting the air.
  const moteTintDecl = flattenSheetRules().some((r) =>
    r.selectorText === '.mote' && /--mote-c/.test(r.style ? r.style.cssText : ''));
  if (!moteTintDecl) problems.push('.mote does not read the per-mote tint (--mote-c)');
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

  // One writer for a track's length: `setTrackDuration` owns both labels, so a
  // progress tick must not be the thing that paints the total. If it were, a
  // render that never consulted the host could put a length on screen.
  const knownSideText15 = totalEl15.textContent;
  const knownArtText15 = artDurEl15.textContent;
  updateArtProgress(120000);
  result.progressTickLeavesTheTotalAlone = artDurEl15.textContent === knownArtText15
    && totalEl15.textContent === knownSideText15;
  if (!result.progressTickLeavesTheTotalAlone) {
    problems.push('a progress tick rewrote the track length: ' + totalEl15.textContent
      + ' / ' + artDurEl15.textContent);
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

  // The report says WHY the syllable-synced lookup was skipped. A key that was
  // accepted while the resolver found no Spotify id reads exactly like a song
  // Spicy has no lyric for, and the two need different answers — so the reason
  // is named, and the row is absent when there was nothing to explain.
  diagnostics = { source: 'LRCLIB', resolve: 'no-track-id' };
  renderDiagnostics();
  const skipReport = document.getElementById('qp-info-body').textContent;
  result.skipReasonReported = /no Spotify track id found/.test(skipReport);
  if (!result.skipReasonReported) {
    problems.push('the resolve report does not name a skipped Spicy lookup: ' + skipReport);
  }
  diagnostics = { source: 'Spicy (Apple Music)', lines: 41 };
  renderDiagnostics();
  result.noSkipRowOnAHealthyReport =
    !/Resolution/.test(document.getElementById('qp-info-body').textContent);
  if (!result.noSkipRowOnAHealthyReport) {
    problems.push('a report that used Spicy still carries the skip row');
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
  // The bridge's position report is the clock, and it says how the playhead has
  // to take the new value: 'snap' is a place the lyrics must land on (a track
  // change, a seek, a play/pause edge, or a jump it measured), 'soft' is ordinary
  // drift it may ease into. Getting that wrong in either direction is a visible
  // reset mid-song, so all three behaviours are pinned here.
  setPlaybackState(true);
  lastUserSeekAt = -Infinity;
  playheadMs = 100000;
  anchorPosMs = 100000;
  anchorWallMs = performance.now();
  targetDriftMs = 0;
  syncPlayhead(100020, 'soft');          // inside the noise floor of the wipe
  result.syncNoiseIgnored = Math.abs(playheadMs - 100000) < 1 && targetDriftMs === 0;
  if (!result.syncNoiseIgnored) {
    problems.push('a position report that agreed with the wipe was not dropped: '
      + Math.round(playheadMs) + ' / ' + Math.round(targetDriftMs));
  }
  syncPlayhead(100400, 'soft');          // 400ms of drift: eased in, not teleported
  result.syncSoftEased = Math.abs(playheadMs - 100000) < 60
    && targetDriftMs < -350 && targetDriftMs > -450;
  if (!result.syncSoftEased) {
    problems.push('a soft report moved the playhead instead of easing it: '
      + Math.round(playheadMs) + ' / ' + Math.round(targetDriftMs));
  }
  syncPlayhead(140000, 'snap');          // a real move: the lyrics land on it
  result.syncSnapLanded = Math.abs(playheadMs - 140000) < 1 && targetDriftMs === 0;
  if (!result.syncSnapLanded) {
    problems.push('a snap report did not land the playhead: ' + Math.round(playheadMs));
  }

  // Back to a paused overlay for the seek checks below.
  setPlaybackState(false);
  lastUserSeekAt = -Infinity;
  syncPlayhead(40000, 'snap');
  // A paused move from the player itself (an external scrub while paused,
  // or a soft landing the clock did not call a jump) must repaint the words,
  // not just the timer — the highlight used to sit frozen until the next
  // pause/resume edge. 40400 stays under SYNC_SNAP_MS on purpose: only the
  // paused path may repaint here, never the snap upgrade.
  lastActiveSig = "0";
  syncPlayhead(40400, 'soft');
  result.pausedSoftRepaints = lastActiveSig === "";
  if (!result.pausedSoftRepaints) {
    problems.push('a paused move left the lyric highlight frozen: ' + lastActiveSig);
  }
  syncPlayhead(40000, 'snap');
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

  // --- 15b. the font list -------------------------------------------------
  // The Fonts group is a LIST of faces, not a pair of counter rows: nothing to
  // import against a cap, every row drawn in the face it names, a face offered
  // only the jobs it can hold, one click to give it a job, and an import removed
  // from its own row — two-step, through the host, whose bytes were fetched on
  // demand rather than kept here. Driven against a stub bridge, since a plain
  // browser has no Python behind it.
  openSettingsTab('lyrics');
  const savedFontsOpen = localStorage.getItem('sl_spGroup_fonts');
  applySettingsGroup('fonts', true, false);

  result.fontCapIsGone = typeof CUSTOM_FONT_LIMIT === 'undefined'
    && typeof CUSTOM_FONT_MAX_BYTES === 'undefined';
  if (!result.fontCapIsGone) {
    problems.push('the font import is still capped by a constant');
  }
  result.fontCounterRowsAreGone = !document.getElementById('qp-font-import')
    && !document.getElementById('qp-font-remove');
  if (!result.fontCounterRowsAreGone) {
    problems.push('the old import/remove counter rows are still in the sheet');
  }
  const fontsGroupEl = document.querySelector('#qp-panel-lyrics .sp-group[data-group="fonts"]');
  const fontsText = fontsGroupEl ? fontsGroupEl.textContent : '';
  // No count against a ceiling, and no prose about one: a limit the sheet no
  // longer enforces must not survive as a sentence either.
  result.fontLimitProse = /\blimit/i.test(fontsText) || /\d+\s*\/\s*\d+/.test(fontsText)
    || /(MB max|up to \d)/i.test(fontsText);
  if (result.fontLimitProse) {
    problems.push('the Fonts group still talks about an import limit');
  }
  const fontActionBar = document.getElementById('qp-font-add') && document.getElementById('qp-font-open');
  if (!fontActionBar) problems.push('the font list has no Add font / Open folder buttons');
  if (!document.getElementById('qp-font-list')) problems.push('the font list is not in the sheet');

  syncSettingsPanel();
  const stockFontRows = [...document.querySelectorAll('#qp-font-list .font-row')];
  result.fontStockRows = stockFontRows.length;
  if (result.fontStockRows !== 6) {
    problems.push('the list shows ' + result.fontStockRows + ' faces with no font folder, expected 6');
  }
  // Every row is drawn in its own face — that is the whole point of the list, and
  // two rows sharing a stack would mean it is not showing what it claims to.
  const stockStacks = stockFontRows.map((row) =>
    getComputedStyle(row.querySelector('.font-row-name')).fontFamily);
  result.fontRowStacksDistinct = new Set(stockStacks).size === stockStacks.length
    && stockStacks.every((s) => s && s !== 'none');
  if (!result.fontRowStacksDistinct) {
    problems.push('two font rows are drawn in the same face');
  }
  // A face is only offered the jobs it can hold.
  const actionsIn = (face) => [...document.querySelectorAll(
    '.font-row[data-face="' + face + '"] button[data-action]')].map((b) => b.dataset.action);
  result.fontRoleButtons = { system: actionsIn('system'), barriecito: actionsIn('barriecito'),
                             inter: actionsIn('inter') };
  if (result.fontRoleButtons.system.join() !== 'lyrics,interface') {
    problems.push('a face that holds both jobs does not offer both: '
      + result.fontRoleButtons.system.join());
  }
  if (result.fontRoleButtons.barriecito.join() !== 'lyrics') {
    problems.push('a lyrics-only face is offered the interface');
  }
  if (result.fontRoleButtons.inter.join() !== 'interface') {
    problems.push('an interface-only face is offered the lyrics');
  }
  // The face in use is marked on its own row, and one click moves the job.
  const applyLyrics = (face) => document.querySelector(
    '.font-row[data-face="' + face + '"] button[data-action="lyrics"]');
  const markedButton = applyLyrics(lyricFontName);
  result.fontActiveMarked = !!(markedButton && markedButton.getAttribute('aria-pressed') === 'true'
    && markedButton.classList.contains('is-active'));
  if (!result.fontActiveMarked) problems.push('the face in use is not marked on its row');
  const faceBeforePick = lyricFontName;
  const serifButton = applyLyrics('serif');
  if (serifButton) {
    serifButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    result.fontPickedFromRow = lyricFontName;
    result.fontPickChangedTheSheet = /serif/i.test(
      document.documentElement.style.getPropertyValue('--lyric-font-family') || '');
    if (result.fontPickedFromRow !== 'serif') {
      problems.push('clicking Lyrics on a row did not apply that face');
    }
    if (!result.fontPickChangedTheSheet) {
      problems.push('the applied face never reached the stylesheet');
    }
  } else {
    problems.push('the Serif row has no Lyrics action');
  }
  applyFont(faceBeforePick);   // put the run back where it found it

  // With a font folder behind it: the imports appear as rows, their bytes are
  // fetched from the host (one face at a time, never held here), a file that
  // will not load says so instead of standing in for a face it is not, and
  // Remove takes two clicks and names the file it removes.
  const fontCalls = [];
  const fontStub = {
    dir: 'C:\\PaprikaLyrics\\fonts', count: 2, trash: 0, status: '',
    entries: [
      { file: 'honk.ttf', name: 'honk.ttf', label: 'Honk', id: 'custom-honk', size: 3100000,
        suffix: '.ttf', weight: 400, style: 'normal', family: 'Honk' },
      { file: 'zany.woff2', name: 'zany.woff2', label: 'Zany', id: 'custom-zany', size: 90000,
        suffix: '.woff2', weight: 700, style: 'normal', family: 'Zany',
        subfamily: 'Bold' },
    ],
  };
  const fontBridgeBefore = window.pywebview;
  window.pywebview = { api: {
    font_list: () => fontStub,
    font_data: (file) => { fontCalls.push(['data', file]); return 'data:font/ttf;base64,AAAA'; },
    font_import: () => { fontCalls.push(['import']); return { ...fontStub, count: 3, status: 'Added 1 font' }; },
    font_reveal: (file) => { fontCalls.push(['reveal', file]); return true; },
    font_remove: (file) => {
      fontCalls.push(['remove', file]);
      return { ...fontStub, count: 1, trash: 1, entries: [fontStub.entries[1]],
               status: 'Removed ' + file + ' (moved to .trash)' };
    },
  } };
  await refreshFonts();
  // Each row is named the way its own file names it: a family's bold file says so
  // instead of repeating the family, which is what makes four faces of one family
  // distinguishable without reading file names.
  const namesByFace = {};
  document.querySelectorAll('#qp-font-list .font-row').forEach((row) => {
    namesByFace[row.dataset.face] = row.querySelector('.font-row-name').textContent;
  });
  result.fontRowNames = namesByFace;
  if (namesByFace['custom-zany'] !== 'Zany Bold') {
    problems.push('a bold import is listed as "' + namesByFace['custom-zany'] +
      '" instead of its own subfamily');
  }
  if (namesByFace['custom-honk'] !== 'Honk') {
    problems.push('a plain regular import is not named by its family alone: ' +
      namesByFace['custom-honk']);
  }

  result.fontRowsWithFolder = document.querySelectorAll('#qp-font-list .font-row').length;
  if (result.fontRowsWithFolder !== 8) {
    problems.push('the folder\u2019s fonts are not listed: ' + result.fontRowsWithFolder + ' rows');
  }
  result.fontListHead = (document.querySelector('#qp-font-list .font-list-head') || {}).textContent;
  if (!/2 fonts/.test(result.fontListHead || '')) {
    problems.push('the list does not say how many fonts are in the folder: ' + result.fontListHead);
  }
  result.fontDataCalls = fontCalls.filter((c) => c[0] === 'data').map((c) => c[1]);
  if (result.fontDataCalls.length < 2) {
    problems.push('the list never asked the host for the imported faces');
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Re-queried on every read: the list rebuilds itself (a status, a re-render
  // after a mutation), so a row captured once goes stale and the check would be
  // comparing a detached node with the page.
  const honkRow = () => document.querySelector('.font-row[data-face="custom-honk"]');
  const honkName = honkRow() && honkRow().querySelector('.font-row-name');
  result.fontUnreadableMarked = !!(honkName && honkName.classList.contains('is-unreadable'));
  result.fontUnreadableNote = honkRow() ? honkRow().querySelector('.font-row-sub').textContent : '';
  if (!result.fontUnreadableMarked || !/could not be read/i.test(result.fontUnreadableNote)) {
    problems.push('a font whose bytes will not load is not reported on its row');
  }
  // …and an unreadable face is never applied, whatever is clicked.
  const honkLyrics = honkRow() && honkRow().querySelector('button[data-action="lyrics"]');
  if (honkLyrics) {
    honkLyrics.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    result.fontUnreadableRefused = lyricFontName !== 'custom-honk';
    if (!result.fontUnreadableRefused) {
      problems.push('an unreadable face was applied to the lyrics anyway');
    }
  } else {
    problems.push('an imported face is not listed with its actions');
  }
  // Remove: first click arms, second click removes THAT file.
  const removeButton = () => honkRow() && honkRow().querySelector('button[data-action="remove"]');
  result.fontRemoveNeedsConfirm = false;
  if (removeButton()) {
    removeButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    result.fontRemoveAfterArm = removeButton() ? removeButton().textContent : '';
    result.fontRemoveCalledEarly = fontCalls.some((c) => c[0] === 'remove');
    result.fontRemoveNeedsConfirm = result.fontRemoveAfterArm === 'Confirm' && !result.fontRemoveCalledEarly;
    if (!result.fontRemoveNeedsConfirm) {
      problems.push('Remove does not ask for confirmation before touching the file');
    }
    removeButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const removeCall = fontCalls.find((c) => c[0] === 'remove');
    result.fontRemoveCall = removeCall || null;
    if (!removeCall || removeCall[1] !== 'honk.ttf') {
      problems.push('Confirm did not remove that row\u2019s own file');
    }
    result.fontRowsAfterRemove = document.querySelectorAll('#qp-font-list .font-row').length;
    if (result.fontRowsAfterRemove !== 7) {
      problems.push('the removed font is still listed: ' + result.fontRowsAfterRemove + ' rows');
    }
  } else {
    problems.push('an imported face cannot be removed from its own row');
  }
  // The bar: Add font asks the host to open a picker, Open folder asks it to show
  // the folder — no inline file input, no path assembled in the page.
  document.getElementById('qp-font-add').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  result.fontAddCall = fontCalls.some((c) => c[0] === 'import');
  if (!result.fontAddCall) problems.push('Add font\u2026 never asks the host for a file picker');
  document.getElementById('qp-font-open').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  result.fontRevealCall = fontCalls.some((c) => c[0] === 'reveal');
  if (!result.fontRevealCall) problems.push('Open folder never asks the host to show the folder');
  result.fontStatusLine = document.getElementById('qp-font-status').textContent;
  if (!/Added 1 font/.test(result.fontStatusLine)) {
    problems.push('the list does not show what the host reported: ' + result.fontStatusLine);
  }

  // Put the page back: no stub bridge, no folder, and the group as it was found.
  window.pywebview = fontBridgeBefore;
  fontLibrary = null;
  fontListSig = "";
  fontFaceState.clear();
  fontFacePromises.clear();
  fontStatusText = "";
  renderFontPanel();
  if (savedFontsOpen === null) {
    localStorage.removeItem('sl_spGroup_fonts');
  } else {
    localStorage.setItem('sl_spGroup_fonts', savedFontsOpen);
  }
  applySettingsGroup('fonts', settingsGroupOpen('fonts'), false);

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
  // Loud-pass feedback dimmed the mote itself: the firefly look came from the
  // keyframe peak, not from the field level, so the peak is pinned here at the
  // dimmed value — a later "brighten the air" tidy turns the field dial (which
  // the modes own), not this per-mote constant
  result.motePeakOpacity = moteOpacityMid;
  if (!(moteOpacityMid >= 0.55 && moteOpacityMid <= 0.68)) {
    problems.push('the mote peak opacity drifted from the dimmed pass: ' + moteOpacityMid);
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
  // The gloss is clipped to the sleeve by a layer of its own. The stage cannot
  // clip — the beat lamp bleeds past the artwork on every side — so a band
  // rotated on the stage painted its corners OUTSIDE the sleeve, which showed as
  // a bright sliver along the edge, obvious when leaning right.
  result.tiltGlossLayerPerStage = stages.length === 2 && stages.every((s) =>
    s.querySelectorAll('.tilt-gloss').length === 1);
  if (!result.tiltGlossLayerPerStage) {
    problems.push('a tilt stage has no gloss clipping layer');
  }
  result.tiltGlossClips = stages.length === 2 && stages.every((s) => {
    const gloss = s.querySelector('.tilt-gloss');
    return !!gloss && getComputedStyle(gloss).overflowX === 'hidden';
  });
  if (!result.tiltGlossClips) {
    problems.push('the gloss layer does not clip the band to the sleeve');
  }
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
  // The band itself must live on the clipping layer, and the stage must no
  // longer paint one directly — that is the whole fix for the edge sliver.
  const glossText = tiltSheet.filter((r) => r.selectorText && /tilt-gloss/.test(r.selectorText))
    .map((r) => r.selectorText + '{' + (r.style ? r.style.cssText : '') + '}').join('\n');
  result.tiltBandOnGlossLayer = /rotate/.test(glossText) && /--tilt-x/.test(glossText);
  if (!result.tiltBandOnGlossLayer) problems.push('the gloss band is not on the clipping layer');
  result.tiltStagePaintsNoGloss = !tiltSheet.some((r) => r.selectorText === '.tilt-stage::after');
  if (!result.tiltStagePaintsNoGloss) {
    problems.push('.tilt-stage::after still paints the gloss outside the sleeve');
  }
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
  // The lean is published once per frame from the newest pointer sample, so a
  // check that read it in the same task as the event would read the previous
  // frame's value — and the wrap is measured once per hover, because a rect read
  // inside the move handler is what made the lean crawl whenever the lyric engine
  // was busy.
  const tiltFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const tiltMove = async (x, y) => {
    tiltWrap.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: x, clientY: y,
    }));
    await tiltFrame();
    await tiltFrame();
  };
  // The stage's rotation is itself a transition (--tilt-dur), so a check that wants
  // the settled ANGLE has to wait for the value to stop moving. Two frames is
  // enough to see the published numbers, not enough to see where the ease ends.
  const tiltSettle = async (el, frames = 48) => {
    let previous = '';
    for (let i = 0; i < frames; i++) {
      await tiltFrame();
      const current = getComputedStyle(el).transform;
      if (current === previous) return current;
      previous = current;
    }
    return previous;
  };
  result.tiltWrapVisible = !!tiltRect && tiltRect.width > 0 && tiltRect.height > 0;
  if (!result.tiltWrapVisible) problems.push('the compact art is not measurable for the tilt');
  const savedTiltMode = tiltMode;
  if (tiltMode === 'off') cycleTilt();
  let tiltRects = 0;
  if (tiltRect && tiltRect.width > 0) {
    const realRect = tiltWrap.getBoundingClientRect.bind(tiltWrap);
    tiltWrap.getBoundingClientRect = function () { tiltRects++; return realRect(); };
    await tiltMove(tiltRect.right - 2, tiltRect.bottom - 2);
    result.tiltBottomRight = tiltRead().map((v) => parseFloat(v));
    // Six more samples inside the same hover: they must reuse the measured rect.
    for (let i = 0; i < 6; i++) await tiltMove(tiltRect.left + 2, tiltRect.top + 2);
    result.tiltTopLeft = tiltRead().map((v) => parseFloat(v));
    delete tiltWrap.getBoundingClientRect;
    tiltWrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    result.tiltAfterLeave = tiltRead().map((v) => parseFloat(v));
  } else {
    result.tiltBottomRight = null;
    result.tiltTopLeft = null;
    result.tiltAfterLeave = null;
  }
  result.tiltRectsPerHover = tiltRects;
  result.tiltRectCached = !result.tiltWrapVisible || tiltRects <= 1;
  if (!result.tiltRectCached) {
    problems.push('the lean re-measures the art once per pointer event: ' + tiltRects);
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
  const angleMatrix = await tiltSettle(angleStage);
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
  // The band itself lives on the clipping layer, not on the stage — see the
  // tiltBandOnGlossLayer check above — so the gloss is read from `.tilt-gloss::after`.
  const glossAfter = tiltSheet.filter((r) => (r.selectorText || '') === '.tilt-gloss::after')
    .map((r) => (r.style ? r.style.cssText : '')).join(';');
  result.tiltGloss = /linear-gradient/.test(glossAfter);
  result.tiltGlossScalesWithAmp = /opacity[^;]*--tilt-mag/.test(glossAfter)
    && /opacity[^;]*--tilt-amp/.test(glossAfter);
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
  // Off refuses the sample in the handler, so nothing is published at all; the
  // frame is waited out anyway, so a fix that started publishing during a pending
  // Off frame would be caught rather than raced.
  await tiltFrame();
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
  await tiltFrame();
  await tiltFrame();
  result.tiltLeanBeforeLayout = tiltRead().map((v) => parseFloat(v));
  if (!(Math.abs(result.tiltLeanBeforeLayout[0]) > 0.5)) {
    problems.push('the layout-change check could not lean the sleeve first: ' +
      JSON.stringify(result.tiltLeanBeforeLayout) + ' tiltMode=' + JSON.stringify(tiltMode) +
      ' rect=' + JSON.stringify([leanRect.left, leanRect.top, leanRect.width, leanRect.height]));
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
  await tiltFrame();
  await tiltFrame();
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

  // --- 18. the position contract: hold, cap, monotonic paint --------------
  // Three rules the wipe depends on, each one a reported symptom:
  //
  //   * 'hold' — the bridge had no fresh sample (a browser after a site-side
  //     seek, SimpMusic between reports) and is only offering its parked
  //     projection. Obeying it stalled real-time sync and dragged the wipe back
  //     over letters already sung, so it must not move the playhead at all;
  //   * a large BACKWARD 'soft' report is the same parked number slipping
  //     through: at most SOFT_BACK_MAX_MS of it may be taken, and a forward one
  //     must still converge exactly;
  //   * a 'snap' is a landing, so it may move the wipe anywhere.
  //
  // The whole suite runs off the live globals; every one it writes is saved and
  // put back below, so the checks leave the app exactly as they found it.
  const savedSync = {
    isPlaying, playheadMs, renderMs, anchorPosMs, anchorWallMs,
    targetDriftMs, glideUntilMs, lastUserSeekAt,
  };
  try {
    // A seek an earlier check made must not veto these reports: the echo guard is
    // exactly what the bridge's reports would trip for the next 900ms.
    lastUserSeekAt = -Infinity;
    const put = (ms) => {
      isPlaying = true;
      playheadMs = ms;
      renderMs = ms;
      anchorPosMs = ms;
      anchorWallMs = performance.now();
      targetDriftMs = 0;
    };

    // A hold is not a correction.
    put(10000);
    window.syncPlayhead(70000, 'hold');
    result.holdLeavesThePlayhead = playheadMs === 10000 && renderMs === 10000
      && anchorPosMs === 10000;
    if (!result.holdLeavesThePlayhead) {
      problems.push('a hold moved the playhead (a parked position became a correction)');
    }

    // A long stretch of holds must leave the wipe running on its own clock. A held
    // projection is not the bridge going quiet — it is the bridge still reporting,
    // from a timeline the player has not refreshed — so it must not start a
    // countdown to parking the lyrics. Parked mid-line is precisely the "the lyrics
    // are basically paused and only a pause/unpause brings them back" report, and
    // the stretch covered below is 13 seconds of playback.
    isPlaying = true;
    playheadMs = 10000;
    renderMs = 10000;
    anchorPosMs = 10000;
    anchorWallMs = performance.now() - 13000;   // 13s of playback…
    targetDriftMs = 0;
    glideUntilMs = 0;
    window.syncPlayhead(22000, 'hold');         // …in which the bridge only held
    // The frames have to come from somewhere: a hold returns before the wake-up a
    // real correction triggers, and a paused overlay's loop parks itself.
    wakeRenderLoop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    result.holdsDoNotFreezeTheWipe = playheadMs >= 22000;
    if (!result.holdsDoNotFreezeTheWipe) {
      problems.push('a stretch of holds froze the wipe at ' + Math.round(playheadMs));
    }
    // …and the clock is the ONLY source of the position while playing. The freeze
    // behind the report was an `else` on this very assignment — a "quiet source"
    // branch that stopped advancing the wipe — so its shape is named here. The
    // check above is the real guard; this one says what defeated it.
    const tickText = tick.toString();
    result.tickAdvancesFromTheClock = /playheadMs\s*=\s*predictedPlayhead\(\)/.test(tickText)
      && !/else\s*\{\s*playheadMs\s*=\s*predictedPlayhead\(\)/.test(tickText);
    if (!result.tickAdvancesFromTheClock) {
      problems.push('tick() can skip advancing the wipe while playing');
    }

    // A backward soft report is capped, not obeyed: the anchor may not be pulled
    // further back than the cap. (The parked 4s-back number used to drag the
    // wipe — and the syllables it had passed — backwards every poll.)
    put(10000);
    window.syncPlayhead(9000, 'soft');
    result.softBackIsCapped = anchorPosMs >= 10000 - SOFT_BACK_MAX_MS - 1;
    if (!result.softBackIsCapped) {
      problems.push('a soft report 1000ms behind pulled the wipe back in full: '
        + Math.round(anchorPosMs));
    }
    // ...and it must not paint backwards either.
    result.softBackNeverRepaints = renderMs >= 10000;
    if (!result.softBackNeverRepaints) {
      problems.push('a backward soft report moved the painted playhead back');
    }

    // A forward soft report still converges exactly onto what the bridge said.
    put(10000);
    window.syncPlayhead(10500, 'soft');
    result.softForwardConverges = Math.abs(anchorPosMs - 10500) < 1;
    if (!result.softForwardConverges) {
      problems.push('a forward soft report no longer converges: ' + anchorPosMs);
    }

    // A snap is a landing: it may move the wipe anywhere, including backwards.
    put(20000);
    window.syncPlayhead(30000, 'snap');
    result.snapLands = Math.abs(playheadMs - 30000) < 1
      && Math.abs(renderMs - 30000) < 1;
    if (!result.snapLands) {
      problems.push('a snap did not land the wipe: ' + playheadMs + ' / ' + renderMs);
    }

    // A glide is a move the user made IN THE PLAYER, not drift, so the wipe must
    // ride it — backwards included. Held forward-only, a seek backwards pinned the
    // wipe where it was and the lyrics never followed the player: the "I moved the
    // progress bar and the lyrics did not update" report.
    put(300000);
    glideUntilMs = 0;
    window.syncPlayhead(295000, 'glide');
    await new Promise((resolve) => setTimeout(resolve, 450));
    result.glideCarriesTheWipeBackwards = Math.abs(renderMs - 295000) <= 1000;
    if (!result.glideCarriesTheWipeBackwards) {
      problems.push('a backward seek left the wipe at ' + Math.round(renderMs)
        + ' (the audio is at 295000)');
    }

    // The per-frame paint only advances while playing. This is what makes a
    // re-sweep impossible even if a small backward correction lands.
    const tickSrc = tick.toString();
    result.tickPaintIsMonotonic = /renderMs\s*=\s*Math\.max\(renderMs,\s*playheadMs\)/.test(tickSrc)
      || /if\s*\(\s*playheadMs\s*>\s*renderMs\s*\)\s*renderMs\s*=\s*playheadMs/.test(tickSrc);
    result.tickPaintsFromTheWipe = /renderProgress\(renderMs\s*\+\s*latencyOffsetMs\)/.test(tickSrc);
    if (!result.tickPaintIsMonotonic || !result.tickPaintsFromTheWipe) {
      problems.push('tick() no longer paints from the forward-only position');
    }
    // …and it behaves that way, not just reads that way: with the clock put five
    // seconds BEHIND the wipe, a real frame must leave the paint where it was.
    isPlaying = true;
    playheadMs = 20000;
    renderMs = 20000;
    anchorPosMs = 15000;
    anchorWallMs = performance.now();
    targetDriftMs = 0;
    wakeRenderLoop();
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    result.tickPaintNeverRewinds = renderMs >= 20000;
    if (!result.tickPaintNeverRewinds) {
      problems.push('a frame painted behind the wipe: ' + Math.round(renderMs));
    }
    // The frame loop survives a throwing frame instead of dying silently, which
    // is what used to leave the overlay frozen until a pause or a lyric click.
    result.frameLoopSurvivesAThrow = /reportRenderLoopError/.test(tickSrc)
      && typeof reportRenderLoopError === 'function';
    if (!result.frameLoopSurvivesAThrow) {
      problems.push('a thrown frame would kill the render loop again');
    }
  } catch (err) {
    problems.push('the position contract threw: ' + (err && err.message));
  } finally {
    isPlaying = savedSync.isPlaying;
    playheadMs = savedSync.playheadMs;
    renderMs = savedSync.renderMs;
    anchorPosMs = savedSync.anchorPosMs;
    anchorWallMs = savedSync.anchorWallMs;
    targetDriftMs = savedSync.targetDriftMs;
    glideUntilMs = savedSync.glideUntilMs;
    lastUserSeekAt = savedSync.lastUserSeekAt;
  }

  // --- 19. a long line cannot leave the column ------------------------------
  // The column clips sideways (`overflow-x: clip`), so a run wider than it is not
  // scrolled, it is CUT: the tail of the line is gone and no gesture brings it back.
  // Wrapping covers everything with a space in it; a long word, a token in a script
  // that writes no spaces, and a syllable that is simply too wide at this size have
  // nothing to break at — a word wraps between its own syllables, and a line whose
  // widest syllable still does not fit is scaled (`--line-fit`). Both are asserted
  // here, against the rendered glyphs rather than the numbers the fitting computed.
  const overflowFixture = [
    { startTimeMs: 0, endTimeMs: 3000, text: 'she lies down?' },
    { startTimeMs: 3000, endTimeMs: 6000, text: 'the world right round, and her' },
    // Long enough to be wider than the column at every viewport, including the
    // 1400px one, so the wrapping is exercised rather than merely available.
    { startTimeMs: 6000, endTimeMs: 12000,
      text: 'Supercalifragilisticexpialidocious'.repeat(3) },
    { startTimeMs: 12000, endTimeMs: 16000,
      text: 'きみのしらないものがたりをうたうよせかいがおわるまえに' },
    { startTimeMs: 16000, endTimeMs: 20000, text: 'a line with a translation layer',
      translation: 'a translation long enough to wrap rather than run off the side' },
    { startTimeMs: 20000, endTimeMs: 23000, text: 'Происходит' },
  ];
  // `content-visibility: auto` is the app's own optimisation for the lines off screen
  // and not what is being tested here — a skipped line has no glyph geometry to read.
  const forceLyricLayout = document.createElement('style');
  forceLyricLayout.textContent = '#lyrics-container > .line { content-visibility: visible !important; }';
  document.head.appendChild(forceLyricLayout);
  window.loadLyrics(overflowFixture, 'Overflow probe', 'Regression', 'LRCLIB',
                    0, 'overflow-probe', 0, null, true);

  const overflowScan = () => {
    const containerEl = document.getElementById('lyrics-container');
    const cRect = containerEl.getBoundingClientRect();
    const lineEls = [...containerEl.querySelectorAll(':scope > .line')];
    const column = lineEls.length ? lineEls[0].clientWidth : 0;
    const rows = lineEls.map((el, i) => {
      const lRect = el.getBoundingClientRect();
      const kids = [...el.querySelectorAll('.word-group, .syllable, .line-secondary')];
      const bounds = kids.reduce((acc, kid) => {
        const r = kid.getBoundingClientRect();
        return { left: Math.min(acc.left, r.left), right: Math.max(acc.right, r.right) };
      }, { left: Infinity, right: -Infinity });
      const syllables = [...el.querySelectorAll('.syllable')];
      const widthOf = (rect) => rect.width;
      return {
        i,
        text: (el.textContent || '').slice(0, 16),
        pastContent: kids.length ? Math.round(bounds.right - (lRect.left + column)) : 0,
        pastContainer: kids.length ? Math.round(bounds.right - cRect.right) : 0,
        height: Math.round(lRect.height),
        syllables: syllables.length,
        // What the line would be wide as ONE row: the sum of its own syllables. This is
        // the number the wrap has to beat, and the fixture asserts that it does.
        unbrokenWidth: Math.round(syllables.reduce((sum, s) => sum + widthOf(s.getBoundingClientRect()), 0)),
        fit: el.style.getPropertyValue('--line-fit') || '1',
        active: el.classList.contains('is-active'),
      };
    });
    return { rows, column };
  };

  const overflowProblems = [];
  const scanOverflow = (state) => {
    const idleScan = overflowScan();
    const idle = idleScan.rows;
    const column = idleScan.column;
    // A line at rest is compared against the COLUMN: nothing about it may reach the edge
    // of the text area it is set in, which is where the clipping starts. The line being
    // sung is the exception, and deliberately so — it is drawn at scale(1.025) from its
    // left edge, which is what the container's right inset is for — so it is held to the
    // window instead, below.
    const idlePast = idle.filter((row) => !row.active && row.pastContent > 1);
    if (idlePast.length) {
      overflowProblems.push(state + ': a line runs past the column: '
        + JSON.stringify(idlePast.map((r) => [r.i, r.pastContent, r.text])));
    }
    // …and the sung line against the WINDOW: the active line scales 1.025 and a sung
    // syllable pops about its own centre, so it is allowed the container's gutter, not
    // the column's edge.
    const target = idle.reduce((a, b) => (b.height > a.height ? b : a), idle[0] || { i: 0 }).i;
    activeLineIdx = target;
    lastActiveSig = '';
    resetAllLines();
    updateLineDepthOfField([target]);
    const lDom = lyricDom[target];
    const lastWord = lDom && lDom.words[lDom.words.length - 1];
    const lastSyl = lastWord && lastWord.syllables[lastWord.syllables.length - 1];
    if (lastSyl) setSyllableState(lastSyl, 'singing', lastSyl.numChars, 1, lastSyl.startTimeMs);
    const active = overflowScan().rows;
    const activePast = active.filter((row) => row.pastContainer > 0);
    if (activePast.length) {
      overflowProblems.push(state + ': a sung line leaves the window: '
        + JSON.stringify(activePast.map((r) => [r.i, r.pastContainer, r.text])));
    }
    return { idle, active: active[target] || null, target, column };
  };

  const savedOverflowFullscreen = isFullscreen;
  const savedOverflowFace = lyricFontName;
  setFullscreen(false);
  const overflowWindowed = scanOverflow('windowed');
  setFullscreen(true);
  const overflowFullscreen = scanOverflow('fullscreen');
  setFullscreen(false);
  // …and again in a different real face: the fitting is computed from font metrics, so a
  // family whose glyphs are wider than the default stack's is exactly what would break it.
  applyFont('serif');
  const overflowSerif = scanOverflow('serif');
  result.lyricOverflowFace = getComputedStyle(document.querySelector('#lyrics-container .line')).fontFamily;
  applyFont(savedOverflowFace);
  setFullscreen(savedOverflowFullscreen);

  // The fixture has to keep exercising the path: if the wrapping and the split stop
  // running, every line fits by itself and the checks above pass for free.
  const longWordLine = overflowWindowed.idle[2] || { syllables: 0, height: 0, unbrokenWidth: 0 };
  const cjkLine = overflowWindowed.idle[3] || { syllables: 0, height: 0, unbrokenWidth: 0 };
  const singleRowHeight = (overflowWindowed.idle[0] || {}).height || 0;
  const column = overflowWindowed.column || 1;
  result.overflowFixtureWraps = longWordLine.syllables > 1
    && longWordLine.unbrokenWidth > column
    && longWordLine.height > singleRowHeight + 2;
  if (!result.overflowFixtureWraps) {
    problems.push('the long word did not wrap between its syllables: '
      + JSON.stringify(longWordLine));
  }
  result.overflowFixtureSplitsSpaceLessText = cjkLine.syllables > 8;
  if (!result.overflowFixtureSplitsSpaceLessText) {
    problems.push('a space-less line was left as one unbreakable run: '
      + JSON.stringify(cjkLine));
  }
  result.lyricOverflowIdle = overflowWindowed.idle.map((r) => r.pastContent);
  result.lyricOverflowFullscreen = overflowFullscreen.idle.map((r) => r.pastContent);
  result.lyricOverflowSerif = overflowSerif.idle.map((r) => r.pastContent);
  result.lyricOverflowFixture = { column,
    unbroken: [longWordLine.unbrokenWidth, cjkLine.unbrokenWidth] };
  result.lyricOverflowActive = overflowFullscreen.active;
  problems.push(...overflowProblems);

  // Back to no lyrics: the checks that need lyrics loaded are the ones above, and the run
  // is replayed at five viewports in one page.
  window.loadLyrics([], '', '', '', 0, '', 0, null, true);
  activeLineIdx = -1;
  lastActiveSig = '';
  forceLyricLayout.remove();

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
