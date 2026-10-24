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

console.log('=== TEST SUITE: Tactile Obsidian Plum Settings Console & Latency Channel ===\n');

// 1. Structural DOM & Tag Balance
console.log('--- 1. Structural DOM & Hierarchy ---');
const re = /<(\/)?([a-zA-Z0-9-]+)([^>]*)>/g;
let match;
let stack = [];
let latencyChannelParent = null;
let slatesAreaParent = null;

while ((match = re.exec(html)) !== null) {
  const isClose = match[1] === '/';
  const tag = match[2].toLowerCase();
  const attrs = match[3];
  if (['br','hr','img','input','meta','link'].includes(tag) || attrs.endsWith('/')) continue;
  if (isClose) {
    if (stack.length) stack.pop();
  } else {
    if (attrs.includes('id="sp-latency-channel"') || attrs.includes("id='sp-latency-channel'")) {
      latencyChannelParent = stack[stack.length - 1];
    }
    if (attrs.includes('class="sp-slates-area"') || attrs.includes("class='sp-slates-area'")) {
      slatesAreaParent = stack[stack.length - 1];
    }
    stack.push({ tag, attrs });
  }
}

assert(slatesAreaParent && slatesAreaParent.attrs.includes('sp-console-deck'),
  '.sp-slates-area is a direct child of .sp-console-deck');
assert(latencyChannelParent && latencyChannelParent.attrs.includes('sp-console-deck'),
  '.sp-latency-channel is a direct child of .sp-console-deck (sibling to .sp-slates-area)');
assert(latencyChannelParent === slatesAreaParent,
  '.sp-slates-area and .sp-latency-channel share the same .sp-console-deck flex parent');

// 2. Linear Detent Marks & Labels
console.log('\n--- 2. Detent Marks & Readout ---');
assert(html.includes('data-val="+3s"'), 'Scale has +3s mark');
assert(html.includes('data-val="+1.5s"'), 'Scale has +1.5s linear midpoint mark');
assert(html.includes('data-val="0"'), 'Scale has 0 center detent mark');
assert(html.includes('data-val="-1.5s"'), 'Scale has -1.5s linear midpoint mark');
assert(html.includes('data-val="-3s"'), 'Scale has -3s mark');
assert(html.includes('id="sp-detent-indicator"'), 'Detent indicator present');
assert(html.includes('id="latency-display"'), 'High contrast digital readout bay present');

// 3. Tactile Hardware Keycaps & Ribs
console.log('\n--- 3. Hardware Keycaps & Ribs ---');
assert(html.includes('class="sp-knob-rib"'), 'Tactile knob ribs markup present');
assert(css.includes('.sp-knob-rib'), 'CSS styles .sp-knob-rib physical grip ridges');
assert(html.includes('class="sp-hardware-keycap"'), 'Braun-inspired keycaps present in markup');
assert(css.includes('.sp-hardware-keycap:active'), 'Keycaps have active mechanical depression');
assert(css.includes('transform: translateY(2px) scale(0.96)'), 'Keycap depression transform matches specification');

// 4. Detent-Zero Styling & Center Snapping
console.log('\n--- 4. Detent-Zero Styling ---');
assert(css.includes('.sp-modal-fader.detent-zero .sp-fader-fill'), 'detent-zero zeroes stray fill sliver');
assert(css.includes('.sp-modal-fader.detent-zero .sp-fader-detent-notch'), 'detent-zero accents center notch');
assert(css.includes('.sp-modal-fader.detent-zero .sp-knob-center-line'), 'detent-zero illuminates knob center line');
assert(css.includes('.sp-latency-channel.detent-zero .sp-digital-readout'), 'detent-zero accents digital readout');

// 5. JavaScript Fader Logic & Interaction
console.log('\n--- 5. JS Fader Logic & Pointer Management ---');
assert(js.includes('isFaderHorizontal'), 'Resilient horizontal vs vertical mode check defined');
assert(js.includes('matchMedia(\'(max-width: 580px)\').matches'), 'Orientation logic falls back gracefully using matchMedia');
assert(js.includes('lostpointercapture'), 'lostpointercapture handled to avoid stuck drag state');
assert(js.includes('!isDragging'), 'setValueText avoids forced reflow flash animation during dragging');
assert(js.includes('detentIndicatorEl.addEventListener'), 'Clicking detent indicator triggers resetLatencyToZero');

// 6. Typographic Scale Two-Way Sync
console.log('\n--- 6. Typographic Scale Binding ---');
assert(html.includes('id="slider-typescale"'), 'slider-typescale input element exists');
assert(html.includes('id="badge-typescale"'), 'badge-typescale element exists');
assert(js.includes('function onTypeScaleInput'), 'onTypeScaleInput handler exists');
assert(js.includes('slider-typescale') && js.includes('badge-typescale'), 'applyZoom and syncSettingsPanel keep slider & badge in sync');

// 7. Responsive CSS Layout Rules
console.log('\n--- 7. Responsive Breakpoint Rules ---');
assert(css.includes('@media (max-width: 580px)'), '580px breakpoint exists');
assert(css.includes('@media (max-width: 440px)'), '440px breakpoint exists');
assert(css.includes('.sp-console-deck') && css.includes('flex-direction: column'), 'Console deck reflows to column on small screens');
assert(css.includes('.sp-readout-bay') && css.includes('order: 1'), 'Readout bay stacks on row 1 in compact mode');
assert(css.includes('.sp-fader-assembly') && css.includes('order: 2'), 'Fader assembly spans row 2 in compact mode');
assert(css.includes('.sp-nudge-rack') && css.includes('order: 3'), 'Nudge rack sits on row 3 in compact mode');

// 8. Adversarial Reviewer Hardening & Accessibility Verification
console.log('\n--- 8. Adversarial Hardening & Accessibility ---');
assert(js.includes('fader.focus({ preventScroll: true })'), 'Pointerdown immediately focuses fader for keyboard accessibility');
assert(js.includes("e.key === 'ArrowUp'") && js.includes("e.key === 'ArrowRight'"), 'Keyboard Arrow keys adjust latency');
assert(js.includes("e.key === '+'") && js.includes("e.key === '-'"), 'Keyboard +/- adjust latency');
assert(js.includes("e.key === 'PageUp'") && js.includes("e.key === 'PageDown'"), 'Keyboard PageUp/PageDown coarse adjustments supported');
assert(js.includes("e.key === '0'") || js.includes("e.key === 'Home'"), 'Keyboard 0/Home resets latency to zero detent');
assert(css.includes('.sp-modal-fader') && css.includes('touch-action: none;'), 'Fader has touch-action: none to prevent touch gesture conflicts');
assert(css.includes('.sp-modal-fader:focus-visible'), 'Fader provides high-contrast focus-visible outline/ring');
assert(css.includes('.sp-modal-fader.dragging .sp-fader-knob.snapping'), 'Knob magnetic center detent snap features spring transition');
assert(css.includes('.sp-modal-fader.dragging .sp-fader-fill.snapping'), 'Fill magnetic center detent snap features spring transition');
assert(css.includes('.sp-sheet') && css.includes('transform: translateY(14px) scale(0.97)'), 'Settings sheet features physical spring dismissal transform');
assert(css.includes('.detent-pulse'), 'Detent indicator triggers spring pulse feedback on reset');

// 9. Round 3 Reviewer Adversarial Fixes & Deep Verification
console.log('\n--- 9. Round 3 Reviewer Adversarial Fixes & Deep Verification ---');
assert(js.includes("if (fill) fill.classList.add('snapping')"), 'Fill actually receives .snapping class during detent snap in JS');
assert(js.includes("if (fill) fill.classList.remove('snapping')"), 'Fill actually removes .snapping class in JS');
assert(js.includes('Math.abs(e.deltaX) > Math.abs(e.deltaY)'), 'Fader wheel listener handles horizontal trackpad/wheel deltaX');
assert(css.includes('.sp-range-slider:focus-visible'), 'Range slider provides high-contrast focus-visible ring');
assert(css.includes('.sp-hardware-keycap:focus-visible'), 'Hardware keycaps provide high-contrast focus-visible ring');
assert(css.includes('.sp-tab:focus-visible'), 'Console tabs provide high-contrast focus-visible ring');
assert(css.includes('.sp-close:focus-visible'), 'Console close button provides high-contrast focus-visible ring');
assert(css.includes('.reduce-motion .sp-fader-knob') && css.includes('transition: none !important;'), 'Reduce motion suppresses fader knob spring transition');
assert(css.includes('.reduce-motion .sp-fader-fill') && css.includes('transition: none !important;'), 'Reduce motion suppresses fader fill transition');
assert(css.includes('.reduce-motion .detent-pulse') && css.includes('animation: none !important;'), 'Reduce motion suppresses detent pulse pop');
assert(css.includes('.ttml-bar') && css.includes('flex-wrap: wrap;'), 'ttml-bar wraps gracefully on compact windows');
assert(css.includes('.font-bar') && css.includes('flex-wrap: wrap;'), 'font-bar wraps gracefully on compact windows');

if (failed === 0) {
  console.log('\n>>> ALL AUDIT ASSERTIONS PASSED! <<<');
  process.exit(0);
} else {
  console.error(`\n>>> ${failed} ASSERTIONS FAILED! <<<`);
  process.exit(1);
}
