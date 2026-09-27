/**
 * UI preview regression checks — paste into the browser devtools console
 * (or evaluate via the preview tooling) while serving ui/ over HTTP:
 *
 *   python -m http.server 8471 --directory ui
 *
 * Then at each viewport size (resize the preview, run `run('label')`):
 *
 *   run('1400x900'); run('900x700'); run('800x600'); run('360x420'); run('330x380')
 *
 * Asserts the invariants behind the fixed chrome bugs:
 *   1. Windowed art controls are layout / settings / fullscreen / mini; in
 *      fullscreen the exit replaces the windowed pair. The compact row and the
 *      split panel's row must agree on which ids are visible in a given state.
 *   2. A fullscreen window carries no drag region at all, and no resize grips.
 *   3. The lyrics-only mini player hides the card/header/split panel and shows
 *      its own bar, whose buttons sit outside the drag region.
 *   4. The settings sheet is centred, inside the window, and the density token
 *      still compacts below 420px of height.
 *   5. The on-art progress bar publishes a playhead position for its dot.
 *
 * Requires the page globals from app.js (`setFullscreen`, `updateArtProgress`,
 * `setTrackDuration`), so run it against the served app, not a blank page.
 */
async function run(label) {
  const body = document.body;
  const isVisible = (el) => !!el && getComputedStyle(el).display !== 'none';
  // Ids differ only by the row prefix (art-btn- / side-btn-), so compare roles.
  const ids = (root) => [...document.querySelectorAll(root + ' .art-btn')]
    .filter(isVisible).map((b) => b.id.replace(/^(art-btn|side-btn)-/, '')).sort();
  const problems = [];
  const result = { label, viewport: window.innerWidth + 'x' + window.innerHeight };

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

  // --- 2. no drag regions while fullscreen ------------------------------
  result.fullscreenDragRegions = document.querySelectorAll('.pywebview-drag-region').length;
  if (result.fullscreenDragRegions !== 0) problems.push('fullscreen still has drag regions');
  result.fullscreenResizeGrips = [...document.querySelectorAll('.resize-handle')]
    .filter((h) => getComputedStyle(h).display !== 'none').length;
  if (result.fullscreenResizeGrips !== 0) problems.push('fullscreen still has resize grips');

  setFullscreen(false);
  result.windowedDragRegions = document.querySelectorAll('.pywebview-drag-region').length;
  if (result.windowedDragRegions === 0) problems.push('windowed lost every drag region');

  // --- 3. mini player ---------------------------------------------------
  body.classList.add('mini');
  result.miniHidesCard = !isVisible(document.getElementById('track-float'));
  result.miniHidesHeader = !isVisible(document.getElementById('app-header'));
  result.miniBarVisible = isVisible(document.getElementById('mini-bar'));
  const miniDrag = document.querySelector('.mini-drag');
  result.miniBarDragIsSiblingOfButtons =
    !!miniDrag && !miniDrag.querySelector('button') &&
    !document.querySelector('.mini-bar button')?.closest('.pywebview-drag-region');
  if (!result.miniHidesCard || !result.miniHidesHeader || !result.miniBarVisible) {
    problems.push('mini player chrome is wrong');
  }
  if (!result.miniBarDragIsSiblingOfButtons) problems.push('mini bar buttons sit inside the drag region');
  body.classList.remove('mini');

  // --- 4. settings sheet ------------------------------------------------
  // The entry animation starts the sheet at scale(0.98) + 10px down, and a
  // throttled preview can freeze it on that frame — measuring the rect then
  // reports a sheet that is 11px small and 10px low. Suspend the animation for
  // the measurement so the geometry read is the settled one.
  panel.classList.add('open');
  const sheetEl = document.querySelector('.sp-sheet');
  const settle = () => {
    const r = sheetEl.getBoundingClientRect();
    return {
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: r.width, height: r.height,
    };
  };
  sheetEl.style.animation = 'none';
  const sheet = settle();
  result.settingsFits =
    sheet.left >= -1 && sheet.right <= window.innerWidth + 1 &&
    sheet.top >= -1 && sheet.bottom <= window.innerHeight + 1;
  result.sheetCentered = Math.abs((sheet.top + sheet.bottom) / 2 - window.innerHeight / 2) <= 2;
  result.sheetW = Math.round(sheet.width);
  result.sheetH = Math.round(sheet.height);
  result.rowMinH = getComputedStyle(sheetEl)
    .getPropertyValue('--sp-row-min-h').trim();
  sheetEl.style.animation = '';
  if (!result.settingsFits) problems.push('settings sheet overflows');
  if (!result.sheetCentered) problems.push('settings sheet is not centred');
  if (window.innerHeight <= 420 && parseInt(result.rowMinH) !== 28) problems.push('density query not applying');
  panel.classList.remove('open');

  // --- 5. on-art playhead dot -------------------------------------------
  const before = document.getElementById('art-thumb').style.left;
  window.setTrackDuration(180_000);   // the dot only rides a known duration
  updateArtProgress(60_000);
  const after = document.getElementById('art-thumb').style.left;
  result.thumbLeft = after;
  if (before === after) problems.push('playhead dot never moved');

  // restore the state the checks started from
  setFullscreen(wasFullscreen);
  if (wasMini) setMiniMode(true);

  console[problems.length ? 'error' : 'log'](problems.length ? problems : 'PASS', result);
  return result;
}
