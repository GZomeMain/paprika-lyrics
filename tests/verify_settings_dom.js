const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(rootDir, 'ui', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rootDir, 'ui', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(rootDir, 'ui', 'app.js'), 'utf8');

let failed = 0;
function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    failed++;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log('--- 1. DOM ID & Markup Verification ---');
const requiredIds = [
  'quick-panel',
  'qp-search',
  'qp-search-clear',
  'qp-tabs',
  'qp-tab-window',
  'qp-tab-lyrics',
  'qp-tab-visuals',
  'qp-tab-profiles',
  'qp-tab-diag',
  'qp-body',
  'qp-panel-window',
  'qp-panel-lyrics',
  'qp-panel-visuals',
  'qp-panel-profiles',
  'qp-panel-diag',
  'slider-typescale',
  'badge-typescale',
  'sp-latency-channel',
  'latency-display',
  'sp-detent-indicator',
  'modal-latency-fader',
  'modal-fader-track',
  'modal-fader-fill',
  'modal-fader-knob',
  'qp-latency'
];

for (const id of requiredIds) {
  assert(html.includes(`id="${id}"`), `DOM contains element with id="${id}"`);
}

console.log('\n--- 2. Tactile Elements & Buttons Verification ---');
assert(html.includes('class="sp-console-deck"'), 'Deck wrapper .sp-console-deck is present');
assert(html.includes('class="sp-slates-area"'), 'Slates area .sp-slates-area is present');
assert(html.includes('class="sp-louvers"'), 'Acoustic louvers are present');
assert(html.includes('nudgeLatency(-50)'), 'Quick-nudge button -50ms is present');
assert(html.includes('nudgeLatency(-10)'), 'Quick-nudge button -10ms is present');
assert(html.includes('resetLatencyToZero()'), 'Quick-nudge button RST (reset to 0) is present');
assert(html.includes('nudgeLatency(10)'), 'Quick-nudge button +10ms is present');
assert(html.includes('nudgeLatency(50)'), 'Quick-nudge button +50ms is present');
assert(html.includes('onTypeScaleInput(this.value)'), 'Lyric typographic scale slider has onTypeScaleInput handler');
assert(!html.includes('sp-sub-dot'), 'Glowing status dot .sp-sub-dot has been completely removed');

console.log('\n--- 3. JavaScript Handler & Logic Verification ---');
assert(js.includes('window.nudgeLatency = nudgeLatency;'), 'nudgeLatency exposed on window');
assert(js.includes('function resetLatencyToZero()'), 'resetLatencyToZero defined');
assert(js.includes('window.resetLatencyToZero = resetLatencyToZero;'), 'resetLatencyToZero exposed on window');
assert(js.includes('function onTypeScaleInput(val)'), 'onTypeScaleInput defined');
assert(js.includes('window.onTypeScaleInput = onTypeScaleInput;'), 'onTypeScaleInput exposed on window');
assert(js.includes('function initModalLatencyFader()'), 'initModalLatencyFader defined');
assert(js.includes('window.renderModalLatencyFader'), 'window.renderModalLatencyFader implemented');
assert(js.includes('Math.abs(target) <= 35'), 'Magnetic center detent snapping threshold defined');
assert(js.includes('document.getElementById(\'latency-display\')'), 'latency-display updated in app.js');

console.log('\n--- 4. CSS Obsidian Plum Theme & Motion Verification ---');
assert(css.includes('#09080c') || css.includes('#09070d'), 'Backdrop obsidian shade present in CSS');
assert(css.includes('#14101a'), 'Warm plum slate background #14101a present in CSS');
assert(css.includes('#c084fc'), 'Lavender/plum highlight #c084fc present in CSS');
assert(css.includes('#d1bcff'), 'Accent highlight #d1bcff present in CSS');
assert(css.includes('#573878'), 'Shadow purple/plum #573878 present in CSS');
assert(css.includes('cubic-bezier(0.34, 1.4, 0.64, 1)'), 'Spring curve cubic-bezier(0.34, 1.4, 0.64, 1) present in CSS');
assert(css.includes('.sp-latency-channel'), '.sp-latency-channel rules present in CSS');
assert(css.includes('@media (max-width: 580px)'), 'Compact breakpoint @media (max-width: 580px) present in CSS');
assert(css.includes('@media (max-width: 440px)'), 'Ultra-compact breakpoint @media (max-width: 440px) present in CSS');
assert(css.includes('transform: translateY(2px) scale(0.96)'), 'Tactile keycap active depression present in CSS');

if (failed === 0) {
  console.log('\nALL CHECKS PASSED SUCCESSFULLY!');
  process.exit(0);
} else {
  console.error(`\n${failed} CHECKS FAILED!`);
  process.exit(1);
}
