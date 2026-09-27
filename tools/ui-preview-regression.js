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
 * Asserts the invariants behind three fixed bugs:
 *   1. Art-button parity: compact and split carry the same two controls
 *      (layout, settings) — no fullscreen/close buttons on the art.
 *   2. Settings sheet fits inside the window at every size.
 *   3. Small-window density: rows compact via --sp-row-min-h below 420px.
 */
function run(label) {
  document.body.classList.add('layout-compact');
  document.getElementById('quick-panel').classList.add('open');
  const sheet = document.querySelector('.sp-sheet').getBoundingClientRect();
  const result = {
    label,
    viewport: window.innerWidth + 'x' + window.innerHeight,
    // 1. Button parity
    compactButtonCount: document.querySelectorAll('#art-controls .art-btn').length,
    sideButtonCount: document.querySelectorAll('.side-art-controls .art-btn').length,
    compactButtonIds: [...document.querySelectorAll('#art-controls .art-btn')].map(b => b.id),
    // 2. Sheet containment
    settingsFits:
      sheet.left >= -1 && sheet.right <= window.innerWidth + 1 &&
      sheet.top >= -1 && sheet.bottom <= window.innerHeight + 1,
    sheetH: Math.round(sheet.height),
    // 3. Density token
    rowMinH: getComputedStyle(document.querySelector('.sp-sheet'))
      .getPropertyValue('--sp-row-min-h').trim(),
    rowH: Math.round(document.querySelector('.qp-row').getBoundingClientRect().height),
  };
  document.getElementById('quick-panel').classList.remove('open');
  const problems = [];
  if (result.compactButtonCount !== result.sideButtonCount) problems.push('button parity broken');
  if (result.compactButtonIds.includes('art-btn-fs') || result.compactButtonIds.includes('art-btn-close'))
    problems.push('fullscreen/close crept back onto the art');
  if (!result.settingsFits) problems.push('settings sheet overflows');
  if (window.innerHeight <= 420 && parseInt(result.rowMinH) !== 28) problems.push('density query not applying');
  console[problems.length ? 'error' : 'log'](problems.length ? problems : 'PASS', result);
  return result;
}
