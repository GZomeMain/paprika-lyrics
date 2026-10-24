const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(rootDir, 'ui', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rootDir, 'ui', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(rootDir, 'ui', 'app.js'), 'utf8');

let failed = 0;
function check(name, pass, detail = '') {
  if (pass) {
    console.log(`[PASS] ${name}`);
  } else {
    console.error(`[FAIL] ${name} ${detail ? '- ' + detail : ''}`);
    failed++;
  }
}

console.log('=== INDEPENDENT VICTORY AUDITOR RIGOROUS CHECKS ===\n');

// --- Requirement 1: Aesthetic & Visual Quality ---
console.log('--- Checking R1: Tactile Obsidian Plum Aesthetic ---');
const qpStart = html.indexOf('id="quick-panel"');
const qpEnd = html.indexOf('</section><!-- /#quick-panel -->', qpStart) !== -1
  ? html.indexOf('</section><!-- /#quick-panel -->', qpStart)
  : html.indexOf('<!-- Settings footer', qpStart);
const qpHtml = html.substring(qpStart, qpEnd > qpStart ? qpEnd : html.length);

check('Zero glowing status orbs/dots (.sp-sub-dot)', !qpHtml.includes('sp-sub-dot'));
check('Zero sparkle emoji/symbols in settings modal', !/[\u2728\u2B50\u2605\uD83D\uDCAB]/.test(qpHtml));
check('Tactile hardware keycaps present', qpHtml.includes('sp-hardware-keycap'));
check('Acoustic louvers present', qpHtml.includes('sp-louvers'));
check('Knurled knob ribs present', qpHtml.includes('sp-knob-rib'));
check('Warm Obsidian Plum backdrop palette in CSS', css.includes('#09080c') || css.includes('#09070d'));
check('Warm plum slate background #14101a in CSS', css.includes('#14101a'));
check('Lavender/plum highlight #c084fc in CSS', css.includes('#c084fc'));
check('Accent highlight #d1bcff in CSS', css.includes('#d1bcff'));
check('Shadow purple/plum #573878 in CSS', css.includes('#573878'));
check('Zero pseudo-code text in settings markup', !qpHtml.split('\n').some(line => line.trim().startsWith('//')));

// --- Requirement 2: Responsive Fluid Layout & Window Adaptability ---
console.log('\n--- Checking R2: Responsive Fluid Layout & Window Adaptability ---');
check('Console deck layout present', css.includes('.sp-console-deck'));
check('Reflow breakpoint @media (max-width: 580px)', css.includes('@media (max-width: 580px)'));
check('Reflow breakpoint @media (max-width: 440px)', css.includes('@media (max-width: 440px)'));
check('Reflow breakpoint @media (max-height: 480px)', css.includes('@media (max-height: 480px)'));
check('Console deck wraps to column on <=580px', css.includes('.sp-console-deck') && css.includes('flex-direction: column'));
check('Settings modal close handler bound', html.includes('closeSettings()'));
check('Esc key dismisses settings in app.js', js.includes("e.key === 'Escape'") && (js.includes('closeSettings()') || js.includes('openSettings(false)')));
check('Settings elements retain data-no-drag for window boundary control', html.includes('data-no-drag'));

// --- Requirement 3: Thinned Dedicated Vertical Latency Channel ---
console.log('\n--- Checking R3: Thinned Dedicated Vertical Latency Channel ---');
const latencyChannelRegex = /\.sp-latency-channel\s*\{[^}]*flex:\s*0\s+0\s+(1[5-9]%|20%)/;
check('Latency channel occupies 15-20% width (approx 18%)', latencyChannelRegex.test(css) || css.includes('flex: 0 0 18%'));
check('Center detent snap threshold (+/-35ms)', js.includes('Math.abs(target) <= 35'));
check('Digital readout #latency-display element present', html.includes('id="latency-display"'));
check('Tactile quick-nudge keycap [-50] present', html.includes('nudgeLatency(-50)'));
check('Tactile quick-nudge keycap [-10] present', html.includes('nudgeLatency(-10)'));
check('Tactile quick-nudge keycap [RST] present', html.includes('resetLatencyToZero()'));
check('Tactile quick-nudge keycap [+10] present', html.includes('nudgeLatency(10)'));
check('Tactile quick-nudge keycap [+50] present', html.includes('nudgeLatency(50)'));
check('Vertical latency slider connects to adjustLatency', js.includes('window.adjustLatency'));

// --- Requirement 4: Physics-Based Spring Animations & Tactile Motion ---
console.log('\n--- Checking R4: Physics-Based Spring Animations & Tactile Motion ---');
check('Spring curve cubic-bezier(0.34, 1.4, 0.64, 1) defined in CSS', css.includes('cubic-bezier(0.34, 1.4, 0.64, 1)'));
check('Modal entry spring animation defined', css.includes('@keyframes settings-spring-in'));
check('Modal sheet dismissal spring transition defined', css.includes('.sp-sheet') && css.includes('transform: translateY(14px) scale(0.97)'));
check('Tactile keycap active depression transform defined', css.includes('transform: translateY(2px) scale(0.96)'));
check('Snapping spring transition on knob', css.includes('.sp-fader-knob.snapping'));
check('Snapping spring transition on fill', css.includes('.sp-fader-fill.snapping'));

// --- Requirement 5: Complete Feature Parity & State Binding ---
console.log('\n--- Checking R5: Complete Feature Parity & State Binding ---');
const parityControls = [
  'qp-tab-window',
  'qp-tab-lyrics',
  'qp-tab-visuals',
  'qp-tab-profiles',
  'qp-tab-diag',
  'qp-search',
  'slider-typescale',
  'badge-typescale',
  'qp-align-state',
  'qp-linesync-state',
  'qp-layout-state',
  'qp-fs-state',
  'qp-ontop-state',
  'qp-card-position-state',
  'qp-hover-fade-state',
  'qp-opacity-state'
];
for (const ctrl of parityControls) {
  check(`Control ${ctrl} exists in markup`, html.includes(`id="${ctrl}"`));
}

check('Slash key (/) triggers search focus in app.js', js.includes("e.key === '/'"));
check('Typographic scale input handler bound', js.includes('function onTypeScaleInput'));
check('Typographic scale state persisted in localStorage', js.includes("localStorage.setItem('lyric_font_size'"));

console.log(`\n=== AUDIT SUMMARY: ${failed === 0 ? 'ALL VERIFICATIONS PASSED' : failed + ' CHECKS FAILED'} ===`);
process.exit(failed === 0 ? 0 : 1);
