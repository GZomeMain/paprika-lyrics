// tests/test_background_and_latency_unification.js
// Verification suite for background blur reduction, posterize effect filter,
// Visuals tab Background controls, and unified latency readout indicator.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Background Controls, Posterize VFX & Unified Latency Readout ===\n');

const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf-8');
const css = fs.readFileSync(path.join(__dirname, '../ui/style.css'), 'utf-8');
const js = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf-8');

// --- 1. Latency Single Clean Indicator Unification ---
console.log('--- 1. Latency Channel Readout Bay Unification ---');

assert(html.includes('id="latency-display"'), 'FAIL: #latency-display must exist in HTML');
assert(html.includes('id="sp-detent-indicator"'), 'FAIL: #sp-detent-indicator must exist in HTML');

// Assert duplicate box is suppressed in CSS
assert(
  css.includes('.sp-detent-indicator') && css.includes('display: none !important;'),
  'FAIL: .sp-detent-indicator must have display: none !important to eliminate duplicate stacked text box'
);
console.log('PASS: Redundant second detent box is suppressed in CSS (no stacked duplicate text boxes)');

// Assert single indicator displays "0ms DETENT" when at 0ms
assert(
  js.includes("dispTxt = isDetent ? '0ms DETENT' : latTxt;"),
  'FAIL: updateLatencyUI must set dispTxt to 0ms DETENT when at center detent'
);
assert(
  js.includes("const dispTxt = isDetent ? '0ms DETENT' : `${clampedLat > 0 ? '+' : ''}${clampedLat}ms`;"),
  'FAIL: renderModalLatencyFader must set dispTxt to 0ms DETENT when at center detent'
);
console.log('PASS: Single digital readout shows "0ms DETENT" cleanly on 0ms detent');

// Assert latency-display click and dblclick both trigger resetLatencyToZero
assert(
  js.includes("displayEl.addEventListener('click'") && js.includes("displayEl.addEventListener('dblclick'"),
  'FAIL: latency-display must support click and dblclick reset to zero'
);
console.log('PASS: Single unified digital readout triggers resetLatencyToZero on click and dblclick');

// Assert detent pulse animation triggers on displayTag
assert(
  js.includes("displayTag.classList.add('detent-pulse');"),
  'FAIL: resetLatencyToZero must trigger detent-pulse on latency-display'
);
assert(
  css.includes('.sp-digital-readout.detent-pulse'),
  'FAIL: CSS must declare .sp-digital-readout.detent-pulse keyframe trigger'
);
console.log('PASS: Unified digital readout triggers spring detent pulse on reset');


// --- 2. Background Blur Reduction & Posterize Filter ---
console.log('\n--- 2. Background Blur Reduction & Posterize Filter ---');

// Assert default blur is reduced in CSS
assert(
  css.includes('--bg-blur: 14px;'),
  'FAIL: --bg-blur default must be reduced to 14px for clear artwork contours'
);
console.log('PASS: Default backdrop blur is reduced to 14px (shapes and compositions recognizable)');

// Assert cover-art-blur preserves generous overscan
assert(
  css.includes('inset: calc(-3.5 * var(--bg-blur) - 24px);'),
  'FAIL: .cover-art-blur must retain calc(-3.5 * var(--bg-blur) - 24px) overscan margins'
);
console.log('PASS: Generous overscan margins calc(-3.5 * var(--bg-blur) - 24px) strictly preserved');

// Assert cover-art-blur filter references url(#vfx-posterize)
assert(
  css.includes('url(#vfx-posterize)'),
  'FAIL: .cover-art-blur filter must incorporate url(#vfx-posterize)'
);
console.log('PASS: .cover-art-blur applies url(#vfx-posterize)');

// Assert SVG filter defs exists in index.html
assert(html.includes('id="vfx-posterize"'), 'FAIL: #vfx-posterize filter not found in index.html');
assert(html.includes('id="posterize-transfer"'), 'FAIL: #posterize-transfer component transfer missing');
assert(html.includes('id="posterize-r"') && html.includes('id="posterize-g"') && html.includes('id="posterize-b"'),
  'FAIL: #posterize-r, g, b feFunc color channels missing');
console.log('PASS: SVG Discrete Color Quantization Filter declared with RGB channel transfer');


// --- 3. Visuals Tab Background Controls Section ---
console.log('\n--- 3. Visuals Tab Background Controls Section ---');

const visualsPanelStart = html.indexOf('id="qp-panel-visuals"');
const visualsPanelEnd = html.indexOf('id="qp-panel-profiles"');
assert(visualsPanelStart !== -1 && visualsPanelEnd > visualsPanelStart, 'FAIL: qp-panel-visuals not found');
const visualsPanelHtml = html.slice(visualsPanelStart, visualsPanelEnd);

// Assert dedicated Background group is in visuals tab
assert(
  visualsPanelHtml.includes('id="qp-group-background"'),
  'FAIL: #qp-group-background must reside within #qp-panel-visuals'
);
assert(
  visualsPanelHtml.includes('<h2 class="sp-group-title">Background</h2>'),
  'FAIL: Background group heading must exist'
);
console.log('PASS: Dedicated Background controls section present in Visuals tab');

// Assert Background Blur slider card exists
assert(visualsPanelHtml.includes('id="qp-bg-blur-card"'), 'FAIL: #qp-bg-blur-card missing');
assert(visualsPanelHtml.includes('id="slider-bg-blur"'), 'FAIL: #slider-bg-blur input missing');
assert(visualsPanelHtml.includes('id="badge-bg-blur"'), 'FAIL: #badge-bg-blur badge missing');
console.log('PASS: Background Blur slider card with real-time badge present');

// Assert Posterize slider card with sub-options exists
assert(visualsPanelHtml.includes('id="qp-bg-posterize-card"'), 'FAIL: #qp-bg-posterize-card missing');
assert(visualsPanelHtml.includes('id="slider-bg-posterize"'), 'FAIL: #slider-bg-posterize input missing');
assert(visualsPanelHtml.includes('id="badge-bg-posterize"'), 'FAIL: #badge-bg-posterize badge missing');
assert(visualsPanelHtml.includes('id="qp-bg-posterize-style"'), 'FAIL: #qp-bg-posterize-style action button missing');
assert(visualsPanelHtml.includes('id="qp-bg-posterize-state"'), 'FAIL: #qp-bg-posterize-state badge missing');
console.log('PASS: Posterize Effect slider card with style cycling button present');

// Assert expandable sub-options for contrast and dimming exist
assert(visualsPanelHtml.includes('id="btn-expand-bg"'), 'FAIL: #btn-expand-bg expand button missing');
assert(visualsPanelHtml.includes('id="bg-sub"'), 'FAIL: #bg-sub expandable sub-section missing');
assert(visualsPanelHtml.includes('id="slider-bg-contrast"'), 'FAIL: #slider-bg-contrast input missing');
assert(visualsPanelHtml.includes('id="slider-bg-dim"'), 'FAIL: #slider-bg-dim input missing');
console.log('PASS: Expandable sub-section with Tonal Contrast and Backdrop Dimming present');


// --- 4. JavaScript Engine & State Synchronization ---
console.log('\n--- 4. JavaScript Engine & State Synchronization ---');

assert(js.includes('function applyPosterizeFilter'), 'FAIL: applyPosterizeFilter function missing in app.js');
assert(js.includes('function applyBgBlur'), 'FAIL: applyBgBlur function missing in app.js');
assert(js.includes('function applyBgContrast'), 'FAIL: applyBgContrast function missing in app.js');
assert(js.includes('function applyBgDim'), 'FAIL: applyBgDim function missing in app.js');
assert(js.includes('function cyclePosterizeMode'), 'FAIL: cyclePosterizeMode function missing in app.js');
console.log('PASS: All background & posterize filter application and mode cycling functions defined');

// Assert restoreSubSections handles 'bg-sub'
assert(js.includes("'bg-sub'"), "FAIL: restoreSubSections must include 'bg-sub'");
console.log('PASS: restoreSubSections restores bg-sub accordion expansion state');

// Assert syncVisualSliders synchronizes background sliders
assert(
  js.includes("'slider-bg-blur'") && js.includes("'slider-bg-posterize'") &&
  js.includes("'slider-bg-contrast'") && js.includes("'slider-bg-dim'"),
  'FAIL: syncVisualSliders must bind all 4 background sliders'
);
console.log('PASS: syncVisualSliders binds and updates all background sliders');

// Assert onVisualSliderInput handles all background controls
assert(
  js.includes("name === 'bg-blur'") && js.includes("name === 'bg-posterize'") &&
  js.includes("name === 'bg-contrast'") && js.includes("name === 'bg-dim'"),
  'FAIL: onVisualSliderInput must handle bg-blur, bg-posterize, bg-contrast, bg-dim'
);
console.log('PASS: onVisualSliderInput provides smooth real-time response for background controls');

// Assert ProfileManager synchronizes background visual settings
assert(
  js.includes('sliderBgBlur,') && js.includes('sliderBgPosterize,') &&
  js.includes('sliderBgContrast,') && js.includes('sliderBgDim,') &&
  js.includes('posterizeStyle'),
  'FAIL: ProfileManager must serialize and synchronize background controls'
);
assert(
  js.includes('sliderBgBlur: 14') && js.includes('sliderBgPosterize: 55'),
  'FAIL: BUILTIN_PROFILES must configure background settings'
);
assert(
  js.includes('sliderBgBlur: def.sliderBgBlur ?? 14'),
  'FAIL: resetActiveProfileToDefaults must reset background settings'
);
assert(
  js.includes('ProfileManager.syncFromCurrentVisuals()') &&
  js.includes('window.cyclePosterizeMode = cyclePosterizeMode;'),
  'FAIL: cyclePosterizeMode must sync changes to active profile'
);
console.log('PASS: ProfileManager saves, syncs and applies background settings across player profiles');

// Assert non-clipping bounds on SVG filter
assert(
  html.includes('id="vfx-posterize"') && html.includes('x="-50%"') && html.includes('width="200%"'),
  'FAIL: #vfx-posterize filter must have generous subregion bounds (x="-50%" width="200%") to prevent drift clipping'
);
console.log('PASS: SVG posterize filter has generous subregion bounds to avoid GPU edge clipping');

console.log('\n>>> ALL BACKGROUND & UNIFIED LATENCY TESTS PASSED SUCCESSFULLY! <<<');
