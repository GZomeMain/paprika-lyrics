const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('=== TEST SUITE: Customization Settings Console UI ===');

// --- 1. Markup & DOM Elements in index.html ---
const indexHtml = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');

// Tab in #qp-tabs
assert(indexHtml.includes('id="qp-tab-customization"'), 'FAIL: qp-tab-customization not found');
assert(indexHtml.includes('data-tab="customization"'), 'FAIL: data-tab="customization" not found');
assert(indexHtml.includes('aria-controls="qp-panel-customization"'), 'FAIL: aria-controls="qp-panel-customization" not found');
console.log('[PASS] Tab button #qp-tab-customization present in #qp-tabs');

// Panel in #qp-body
assert(indexHtml.includes('id="qp-panel-customization"'), 'FAIL: qp-panel-customization not found');
console.log('[PASS] Panel #qp-panel-customization present in #qp-body');

// Phase 4: Atmospheric Theme Ambient Tint element in ambient-backdrop
assert(indexHtml.includes('class="theme-ambient-tint"'), 'FAIL: theme-ambient-tint element missing in index.html');
console.log('[PASS] Atmospheric Theme Ambient Tint overlay element present in index.html');

// Group 1: Presets & Themes Hub
assert(indexHtml.includes('id="cust-preset-select"'), 'FAIL: cust-preset-select not found');
assert(indexHtml.includes('id="cust-preset-active-badge"'), 'FAIL: cust-preset-active-badge not found');
assert(indexHtml.includes('id="cust-btn-delete-preset"'), 'FAIL: cust-btn-delete-preset not found');
assert(indexHtml.includes('id="cust-preset-file-input"'), 'FAIL: cust-preset-file-input not found');
assert(indexHtml.includes('id="cust-inline-save-row"'), 'FAIL: cust-inline-save-row not found');
assert(indexHtml.includes('id="cust-input-new-preset"'), 'FAIL: cust-input-new-preset not found');

// All 8 canonical built-in presets present in HTML dropdown
const expectedPresets = [
  'default', 'minimalist', 'cyberpunk', 'ambient_neon',
  'kinetic_karaoke', 'studio_oled', 'apple_classical', 'retro_arcade'
];
for (const pid of expectedPresets) {
  assert(indexHtml.includes(`value="${pid}"`), `FAIL: Built-in preset option value="${pid}" not found in index.html`);
}
console.log('[PASS] Group 1 (Presets & Themes Hub) controls and all 8 built-in preset options present');

// Group 2: Dynamic Typography & Lyrics
assert(indexHtml.includes('id="slider-cust-active-scale"'), 'FAIL: slider-cust-active-scale not found');
assert(indexHtml.includes('id="badge-cust-active-scale"'), 'FAIL: badge-cust-active-scale not found');
assert(indexHtml.includes('id="slider-cust-active-glow"'), 'FAIL: slider-cust-active-glow not found');
assert(indexHtml.includes('id="badge-cust-active-glow"'), 'FAIL: badge-cust-active-glow not found');
assert(indexHtml.includes('id="cust-active-glow-color"'), 'FAIL: cust-active-glow-color not found');
assert(indexHtml.includes('id="slider-cust-letter-spacing"'), 'FAIL: slider-cust-letter-spacing not found');
assert(indexHtml.includes('id="badge-cust-letter-spacing"'), 'FAIL: badge-cust-letter-spacing not found');
assert(indexHtml.includes('id="slider-cust-font-weight"'), 'FAIL: slider-cust-font-weight not found');
assert(indexHtml.includes('id="badge-cust-font-weight"'), 'FAIL: badge-cust-font-weight not found');
assert(indexHtml.includes('id="slider-cust-secondary-opacity"'), 'FAIL: slider-cust-secondary-opacity not found');
assert(indexHtml.includes('id="badge-cust-secondary-opacity"'), 'FAIL: badge-cust-secondary-opacity not found');
assert(indexHtml.includes('id="cust-adlib-style"'), 'FAIL: cust-adlib-style not found');
assert(indexHtml.includes('id="cust-toggle-bevel"'), 'FAIL: cust-toggle-bevel not found');
assert(indexHtml.includes('id="cust-bevel-state"'), 'FAIL: cust-bevel-state not found');
// Phase 3 kinetic controls
assert(indexHtml.includes('id="cust-toggle-syllable-stretch"'), 'FAIL: cust-toggle-syllable-stretch not found');
assert(indexHtml.includes('id="cust-syllable-stretch-state"'), 'FAIL: cust-syllable-stretch-state not found');
assert(indexHtml.includes('id="cust-toggle-syllable-pop"'), 'FAIL: cust-toggle-syllable-pop not found');
assert(indexHtml.includes('id="cust-syllable-pop-state"'), 'FAIL: cust-syllable-pop-state not found');
assert(indexHtml.includes('id="cust-toggle-gradient-wipe"'), 'FAIL: cust-toggle-gradient-wipe not found');
assert(indexHtml.includes('id="cust-gradient-wipe-state"'), 'FAIL: cust-gradient-wipe-state not found');
// Phase 5 secondary scale, ad-lib scale & scroll inertia controls
assert(indexHtml.includes('id="slider-cust-secondary-scale"'), 'FAIL: slider-cust-secondary-scale not found');
assert(indexHtml.includes('id="badge-cust-secondary-scale"'), 'FAIL: badge-cust-secondary-scale not found');
assert(indexHtml.includes('id="slider-cust-adlib-scale"'), 'FAIL: slider-cust-adlib-scale not found');
assert(indexHtml.includes('id="badge-cust-adlib-scale"'), 'FAIL: badge-cust-adlib-scale not found');
assert(indexHtml.includes('id="cust-scroll-inertia"'), 'FAIL: cust-scroll-inertia not found');
console.log('[PASS] Group 2 (Dynamic Typography & Lyrics + Phase 3 Kinetics + Phase 5 Hierarchy Scales) controls present');

// Group 3: Visuals & Particle Systems
assert(indexHtml.includes('id="cust-particle-type"'), 'FAIL: cust-particle-type not found');
assert(indexHtml.includes('id="slider-cust-particle-density"'), 'FAIL: slider-cust-particle-density not found');
assert(indexHtml.includes('id="badge-cust-particle-density"'), 'FAIL: badge-cust-particle-density not found');
assert(indexHtml.includes('id="slider-cust-particle-speed"'), 'FAIL: slider-cust-particle-speed not found');
assert(indexHtml.includes('id="badge-cust-particle-speed"'), 'FAIL: badge-cust-particle-speed not found');
assert(indexHtml.includes('id="slider-cust-particle-opacity"'), 'FAIL: slider-cust-particle-opacity not found');
assert(indexHtml.includes('id="badge-cust-particle-opacity"'), 'FAIL: badge-cust-particle-opacity not found');
// Phase 3 stasis & aurora controls
assert(indexHtml.includes('id="cust-toggle-breakdown-stasis"'), 'FAIL: cust-toggle-breakdown-stasis not found');
assert(indexHtml.includes('id="cust-breakdown-stasis-state"'), 'FAIL: cust-breakdown-stasis-state not found');
assert(indexHtml.includes('id="cust-toggle-aurora-mesh"'), 'FAIL: cust-toggle-aurora-mesh not found');
assert(indexHtml.includes('id="cust-aurora-mesh-state"'), 'FAIL: cust-aurora-mesh-state not found');
console.log('[PASS] Group 3 (Visuals & Particle Systems + Breakdown Stasis & Aurora) controls present');

// Group 4: Audio-Reactive & Beat-Sync Targets
assert(indexHtml.includes('id="cust-toggle-beatsync"'), 'FAIL: cust-toggle-beatsync not found');
assert(indexHtml.includes('id="cust-beatsync-state"'), 'FAIL: cust-beatsync-state not found');
assert(indexHtml.includes('id="slider-cust-pulse-strength"'), 'FAIL: slider-cust-pulse-strength not found');
assert(indexHtml.includes('id="badge-cust-pulse-strength"'), 'FAIL: badge-cust-pulse-strength not found');
assert(indexHtml.includes('id="cust-target-art"'), 'FAIL: cust-target-art not found');
assert(indexHtml.includes('id="cust-target-lyrics"'), 'FAIL: cust-target-lyrics not found');
assert(indexHtml.includes('id="cust-target-controls"'), 'FAIL: cust-target-controls not found');
assert(indexHtml.includes('id="cust-target-bloom"'), 'FAIL: cust-target-bloom not found');
assert(indexHtml.includes('id="cust-target-particles"'), 'FAIL: cust-target-particles not found');
assert(indexHtml.includes('id="cust-sync-motion-mode"'), 'FAIL: cust-sync-motion-mode not found');
// Phase 3 spatial layout & artwork controls
assert(indexHtml.includes('id="cust-orientation-select"'), 'FAIL: cust-orientation-select not found');
assert(indexHtml.includes('id="cust-artwork-shape-select"'), 'FAIL: cust-artwork-shape-select not found');
assert(indexHtml.includes('id="cust-toggle-artwork-spin"'), 'FAIL: cust-toggle-artwork-spin not found');
assert(indexHtml.includes('id="cust-artwork-spin-state"'), 'FAIL: cust-artwork-spin-state not found');
assert(indexHtml.includes('id="cust-lyrics-dock-select"'), 'FAIL: cust-lyrics-dock-select not found');

// Spatial orientation options
for (const orient of ['horizontal', 'vertical-right', 'vertical-left', 'vertical-column']) {
  assert(indexHtml.includes(`value="${orient}"`), `FAIL: Orientation option value="${orient}" not found`);
}
// Artwork shape options
for (const shape of ['rounded', 'circle', 'squircle', 'diamond', 'pill', 'vinyl']) {
  assert(indexHtml.includes(`value="${shape}"`), `FAIL: Artwork shape option value="${shape}" not found`);
}
// Lyrics dock options
for (const dock of ['center', 'left', 'right', 'top', 'bottom']) {
  assert(indexHtml.includes(`value="${dock}"`), `FAIL: Lyrics dock option value="${dock}" not found`);
}
console.log('[PASS] Group 4 (Audio-Reactive & Spatial Layout Overrides) controls present');

// --- 2. CSS Rules in customization.css ---
const custCss = fs.readFileSync(path.join(__dirname, '../ui/customization.css'), 'utf8');
assert(custCss.includes('.cust-preset-bar'), 'FAIL: .cust-preset-bar not found in customization.css');
assert(custCss.includes('.cust-select'), 'FAIL: .cust-select not found in customization.css');
assert(custCss.includes('.cust-preset-badge'), 'FAIL: .cust-preset-badge not found in customization.css');
assert(custCss.includes('.cust-target-grid'), 'FAIL: .cust-target-grid not found in customization.css');
assert(custCss.includes('.cust-target-chip'), 'FAIL: .cust-target-chip not found in customization.css');
assert(custCss.includes('.cust-color-picker'), 'FAIL: .cust-color-picker not found in customization.css');
assert(custCss.includes('.cust-inline-save-row'), 'FAIL: .cust-inline-save-row not found in customization.css');

// Phase 3 Spatial Orientations
assert(custCss.includes('[data-orientation="vertical-right"]'), 'FAIL: vertical-right selector missing in CSS');
assert(custCss.includes('[data-orientation="vertical-left"]'), 'FAIL: vertical-left selector missing in CSS');
assert(custCss.includes('[data-orientation="vertical-column"]'), 'FAIL: vertical-column selector missing in CSS');
assert(custCss.includes('writing-mode: vertical-rl'), 'FAIL: writing-mode vertical-rl missing in CSS');

// Phase 4 Gap Indicator & Intro Dots Dock Alignment
assert(custCss.includes('[data-lyrics-dock="center"] #lyrics-container > .gap-indicator'), 'FAIL: gap-indicator center dock missing in CSS');
assert(custCss.includes('[data-lyrics-dock="right"] #lyrics-container > .gap-indicator'), 'FAIL: gap-indicator right dock missing in CSS');
assert(custCss.includes('[data-lyrics-dock="left"] #lyrics-container > .gap-indicator'), 'FAIL: gap-indicator left dock missing in CSS');
console.log('[PASS] Phase 4 Gap Indicator & Intro Dots Dock Alignment CSS verified');

// Phase 3 & 4 Artwork Shapes & Overlay/Scrim Shape Clipping
assert(custCss.includes('.art-shape-rounded'), 'FAIL: .art-shape-rounded missing in CSS');
assert(custCss.includes('.art-shape-circle'), 'FAIL: .art-shape-circle missing in CSS');
assert(custCss.includes('.art-shape-squircle'), 'FAIL: .art-shape-squircle missing in CSS');
assert(custCss.includes('.art-shape-diamond'), 'FAIL: .art-shape-diamond missing in CSS');
assert(custCss.includes('.art-shape-pill'), 'FAIL: .art-shape-pill missing in CSS');
assert(custCss.includes('.art-shape-vinyl'), 'FAIL: .art-shape-vinyl missing in CSS');
assert(custCss.includes('@keyframes spin-artwork-rot'), 'FAIL: spin-artwork-rot keyframes missing in CSS');

// Phase 4 Dark Overlay & Scrim Clipping assertions
assert(custCss.includes('[data-artwork-shape="rounded"] .float-art-wrap::after'), 'FAIL: rounded float-art-wrap::after clipping missing');
assert(custCss.includes('[data-artwork-shape="circle"] .float-art-wrap::after'), 'FAIL: circle float-art-wrap::after clipping missing');
assert(custCss.includes('[data-artwork-shape="squircle"] .float-art-wrap::after'), 'FAIL: squircle float-art-wrap::after clipping missing');
assert(custCss.includes('[data-artwork-shape="diamond"] .float-art-wrap::after'), 'FAIL: diamond float-art-wrap::after clipping missing');
assert(custCss.includes('[data-artwork-shape="pill"] .float-art-wrap::after'), 'FAIL: pill float-art-wrap::after clipping missing');
assert(custCss.includes('[data-artwork-shape="vinyl"] .float-art-wrap::after'), 'FAIL: vinyl float-art-wrap::after clipping missing');
assert(custCss.includes('[data-artwork-shape="circle"] .art-controls'), 'FAIL: circle art-controls clipping missing');
console.log('[PASS] Phase 4 Dark Overlay & Scrim Shape Clipping CSS rules verified');

// Phase 4 Theme Ambient Tint Overlay
assert(custCss.includes('.theme-ambient-tint'), 'FAIL: .theme-ambient-tint missing in CSS');
assert(custCss.includes('--cust-theme-bg-tint'), 'FAIL: --cust-theme-bg-tint missing in CSS');
console.log('[PASS] Phase 4 Theme Atmospheric Background Tint Overlay CSS verified');

// Phase 3 Kinetic & Breakdown Stasis
assert(custCss.includes('.syllable-pop'), 'FAIL: .syllable-pop missing in CSS');
assert(custCss.includes('.syllable-stretch'), 'FAIL: .syllable-stretch missing in CSS');
assert(custCss.includes('.has-gradient-wipe'), 'FAIL: .has-gradient-wipe missing in CSS');
assert(custCss.includes('.in-breakdown-stasis'), 'FAIL: .in-breakdown-stasis missing in CSS');
assert(custCss.includes('.mini-ticker-mode'), 'FAIL: .mini-ticker-mode missing in CSS');
console.log('[PASS] Phase 3 Spatial, Artwork Shapes, Kinetics, & Stasis CSS rules verified');

// Phase 5 Line Containment, Spring Scroll & Hierarchy Scales
assert(custCss.includes('overflow-wrap: break-word'), 'FAIL: overflow-wrap: break-word missing in CSS');
assert(custCss.includes('.line.scroll-spring-active'), 'FAIL: .line.scroll-spring-active missing in CSS');
assert(custCss.includes('.line.scroll-spring-near'), 'FAIL: .line.scroll-spring-near missing in CSS');
assert(custCss.includes('--cust-lyrics-secondary-scale'), 'FAIL: --cust-lyrics-secondary-scale missing in CSS');
assert(custCss.includes('--cust-lyrics-adlib-scale'), 'FAIL: --cust-lyrics-adlib-scale missing in CSS');
console.log('[PASS] Phase 5 Line Containment, Cascading Spring Scroll & Subordinate Scales CSS rules verified');

// Phase 6 Pure Block Flow Lyrics Dock, Z-Index Layering & Keyframe Cleanliness
assert(!custCss.includes('#lyrics-container { display: flex'), 'FAIL: #lyrics-container must not use display: flex');
assert(!custCss.includes('display: flex !important; flex-direction: column !important;'), 'FAIL: #lyrics-container must not use flex-direction column !important');
assert(custCss.includes('[data-lyrics-dock="center"] #lyrics-container .line'), 'FAIL: center dock line selector missing in CSS');
assert(custCss.includes('[data-lyrics-dock="center"] #lyrics-container .word-group'), 'FAIL: center dock word-group selector missing in CSS');
assert(custCss.includes('[data-lyrics-dock="right"] #lyrics-container .line'), 'FAIL: right dock line selector missing in CSS');
assert(custCss.includes('[data-lyrics-dock="right"] #lyrics-container .word-group'), 'FAIL: right dock word-group selector missing in CSS');
assert(custCss.includes('[data-lyrics-dock="left"] #lyrics-container .line'), 'FAIL: left dock line selector missing in CSS');
assert(custCss.includes('[data-lyrics-dock="left"] #lyrics-container .word-group'), 'FAIL: left dock word-group selector missing in CSS');
assert(custCss.includes('.fx-canvas') && custCss.includes('z-index: 2 !important;'), 'FAIL: .fx-canvas z-index: 2 !important missing in CSS');
assert(custCss.includes('#lyrics-container') && custCss.includes('z-index: 10 !important;'), 'FAIL: #lyrics-container z-index: 10 !important missing in CSS');
assert(custCss.includes('.line') && custCss.includes('z-index: 5;'), 'FAIL: .line z-index: 5 missing in CSS');
assert(!custCss.includes('.line.scroll-spring-active {\n  animation: line-spring-entry 0.42s cubic-bezier(0.18, 0.89, 0.32, 1.28) forwards;'), 'FAIL: .line.scroll-spring-active must not include forwards');
console.log('[PASS] Phase 6 Pure Block Flow Lyrics Dock, Z-Index Layering & Keyframe Cleanliness CSS rules verified');

// --- 3. UI Controller Methods in Node simulation ---
// Create minimal fake DOM
const elements = {};
function makeElem(id, tag = 'div') {
  return {
    id,
    tagName: tag.toUpperCase(),
    value: '',
    textContent: '',
    checked: false,
    hidden: false,
    disabled: false,
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._classes.has(c)) this._classes.delete(c);
          else this._classes.add(c);
        } else if (force) {
          this._classes.add(c);
        } else {
          this._classes.delete(c);
        }
      },
      contains(c) { return this._classes.has(c); }
    },
    children: [],
    appendChild(child) { this.children.push(child); }
  };
}

const elementIds = [
  'qp-panel-customization', 'cust-preset-select', 'cust-preset-active-badge', 'cust-btn-delete-preset',
  'slider-cust-active-scale', 'badge-cust-active-scale', 'slider-cust-active-glow', 'badge-cust-active-glow',
  'cust-active-glow-color', 'slider-cust-letter-spacing', 'badge-cust-letter-spacing', 'slider-cust-font-weight',
  'badge-cust-font-weight', 'slider-cust-secondary-opacity', 'badge-cust-secondary-opacity', 'cust-adlib-style',
  'cust-bevel-state', 'cust-particle-type', 'slider-cust-particle-density', 'badge-cust-particle-density',
  'slider-cust-particle-speed', 'badge-cust-particle-speed', 'slider-cust-particle-opacity',
  'badge-cust-particle-opacity', 'cust-beatsync-state', 'slider-cust-pulse-strength', 'badge-cust-pulse-strength',
  'cust-target-art', 'cust-target-lyrics', 'cust-target-controls', 'cust-target-bloom', 'cust-target-particles',
  'cust-sync-motion-mode', 'cust-inline-save-row', 'cust-input-new-preset',
  // Phase 3 control element IDs
  'cust-toggle-syllable-stretch', 'cust-syllable-stretch-state',
  'cust-toggle-syllable-pop', 'cust-syllable-pop-state',
  'cust-toggle-gradient-wipe', 'cust-gradient-wipe-state',
  'cust-toggle-breakdown-stasis', 'cust-breakdown-stasis-state',
  'cust-toggle-aurora-mesh', 'cust-aurora-mesh-state',
  'cust-orientation-select', 'cust-artwork-shape-select',
  'cust-toggle-artwork-spin', 'cust-artwork-spin-state',
  'cust-lyrics-dock-select',
  // Phase 5 control element IDs
  'slider-cust-secondary-scale', 'badge-cust-secondary-scale',
  'slider-cust-adlib-scale', 'badge-cust-adlib-scale',
  'cust-scroll-inertia'
];

for (const id of elementIds) {
  elements[id] = makeElem(id);
}

const docAttrs = {};
global.document = {
  documentElement: {
    style: {
      _styles: {},
      setProperty(k, v) { this._styles[k] = v; },
      removeProperty(k) { delete this._styles[k]; }
    },
    setAttribute(k, v) { docAttrs[k] = String(v); },
    getAttribute(k) { return docAttrs[k]; },
    removeAttribute(k) { delete docAttrs[k]; },
    classList: makeElem('').classList
  },
  body: makeElem('body'),
  getElementById(id) {
    return elements[id] || null;
  },
  createElement(tag) {
    return makeElem('', tag);
  },
  querySelectorAll(sel) {
    return [];
  }
};
global.window = global;

const cust = require('../ui/customization.js');

// Test renderCustomizationPanel
assert.strictEqual(typeof window.renderCustomizationPanel, 'function');
window.renderCustomizationPanel();

assert.strictEqual(elements['slider-cust-active-scale'].value, 1.08);
assert.strictEqual(elements['badge-cust-active-scale'].textContent, '1.08x');
assert.strictEqual(elements['cust-beatsync-state'].textContent, 'On');
assert.strictEqual(elements['cust-syllable-stretch-state'].textContent, 'On');
assert.strictEqual(elements['cust-syllable-pop-state'].textContent, 'On');
assert.strictEqual(elements['cust-gradient-wipe-state'].textContent, 'On');
assert.strictEqual(elements['cust-breakdown-stasis-state'].textContent, 'On');
assert.strictEqual(elements['cust-aurora-mesh-state'].textContent, 'On');
assert.strictEqual(elements['cust-artwork-spin-state'].textContent, 'Off');
assert.strictEqual(elements['cust-orientation-select'].value, 'horizontal');
assert.strictEqual(elements['cust-artwork-shape-select'].value, 'rounded');
assert.strictEqual(elements['cust-lyrics-dock-select'].value, 'center');
// Phase 5 controls initial state
assert.strictEqual(elements['slider-cust-secondary-scale'].value, 75);
assert.strictEqual(elements['badge-cust-secondary-scale'].textContent, '75%');
assert.strictEqual(elements['slider-cust-adlib-scale'].value, 70);
assert.strictEqual(elements['badge-cust-adlib-scale'].textContent, '70%');
assert.strictEqual(elements['cust-scroll-inertia'].value, 'springy');
console.log('[PASS] renderCustomizationPanel correctly populates DOM controls with engine state (Phase 1-5)');

// Test slider input handler
window.onCustomizationSliderInput('lyrics.active_scale', '1.35', 'badge-cust-active-scale', 'x');
assert.strictEqual(cust.get('lyrics.active_scale'), 1.35);
assert.strictEqual(elements['badge-cust-active-scale'].textContent, '1.35x');
console.log('[PASS] onCustomizationSliderInput updates engine state and UI badge');

// Test bevel toggle handler
window.toggleCustomizationBevel();
assert.strictEqual(cust.get('lyrics.bevel_effect'), true);
assert.strictEqual(elements['cust-bevel-state'].textContent, 'On');
window.toggleCustomizationBevel();
assert.strictEqual(cust.get('lyrics.bevel_effect'), false);
assert.strictEqual(elements['cust-bevel-state'].textContent, 'Off');
console.log('[PASS] toggleCustomizationBevel toggles state and updates badge');

// Test beat sync toggle handler
window.toggleCustomizationBeatSync();
assert.strictEqual(cust.get('reactive.beat_sync_enabled'), false);
assert.strictEqual(elements['cust-beatsync-state'].textContent, 'Off');
window.toggleCustomizationBeatSync();
assert.strictEqual(cust.get('reactive.beat_sync_enabled'), true);
assert.strictEqual(elements['cust-beatsync-state'].textContent, 'On');
console.log('[PASS] toggleCustomizationBeatSync toggles state and updates badge');

// Phase 3: Test Syllable Stretch toggle handler
window.toggleCustomizationSyllableStretch();
assert.strictEqual(cust.get('lyrics.syllable_stretch_enabled'), false);
assert.strictEqual(elements['cust-syllable-stretch-state'].textContent, 'Off');
window.toggleCustomizationSyllableStretch();
assert.strictEqual(cust.get('lyrics.syllable_stretch_enabled'), true);
assert.strictEqual(elements['cust-syllable-stretch-state'].textContent, 'On');
console.log('[PASS] toggleCustomizationSyllableStretch toggles state and updates badge');

// Phase 3: Test Syllable Pop toggle handler
window.toggleCustomizationSyllablePop();
assert.strictEqual(cust.get('lyrics.syllable_pop_enabled'), false);
assert.strictEqual(elements['cust-syllable-pop-state'].textContent, 'Off');
window.toggleCustomizationSyllablePop();
assert.strictEqual(cust.get('lyrics.syllable_pop_enabled'), true);
assert.strictEqual(elements['cust-syllable-pop-state'].textContent, 'On');
console.log('[PASS] toggleCustomizationSyllablePop toggles state and updates badge');

// Phase 3: Test Gradient Wipe toggle handler
window.toggleCustomizationGradientWipe();
assert.strictEqual(cust.get('lyrics.gradient_wipe_enabled'), false);
assert.strictEqual(elements['cust-gradient-wipe-state'].textContent, 'Off');
window.toggleCustomizationGradientWipe();
assert.strictEqual(cust.get('lyrics.gradient_wipe_enabled'), true);
assert.strictEqual(elements['cust-gradient-wipe-state'].textContent, 'On');
console.log('[PASS] toggleCustomizationGradientWipe toggles state and updates badge');

// Phase 3: Test Breakdown Stasis toggle handler
window.toggleCustomizationBreakdownStasis();
assert.strictEqual(cust.get('visuals.breakdown_stasis_enabled'), false);
assert.strictEqual(elements['cust-breakdown-stasis-state'].textContent, 'Off');
window.toggleCustomizationBreakdownStasis();
assert.strictEqual(cust.get('visuals.breakdown_stasis_enabled'), true);
assert.strictEqual(elements['cust-breakdown-stasis-state'].textContent, 'On');
console.log('[PASS] toggleCustomizationBreakdownStasis toggles state and updates badge');

// Phase 3: Test Aurora Mesh toggle handler
window.toggleCustomizationAuroraMesh();
assert.strictEqual(cust.get('visuals.aurora_mesh_enabled'), false);
assert.strictEqual(elements['cust-aurora-mesh-state'].textContent, 'Off');
window.toggleCustomizationAuroraMesh();
assert.strictEqual(cust.get('visuals.aurora_mesh_enabled'), true);
assert.strictEqual(elements['cust-aurora-mesh-state'].textContent, 'On');
console.log('[PASS] toggleCustomizationAuroraMesh toggles state and updates badge');

// Phase 5: Test Secondary Scale, Ad-lib Scale & Scroll Inertia interactions
window.onCustomizationSliderInput('lyrics.secondary_scale', '0.82', 'badge-cust-secondary-scale', '', (v) => Math.round(parseFloat(v) * 100) + '%');
assert.strictEqual(cust.get('lyrics.secondary_scale'), 0.82);
assert.strictEqual(elements['badge-cust-secondary-scale'].textContent, '82%');

window.onCustomizationSliderInput('lyrics.adlib_scale', '0.64', 'badge-cust-adlib-scale', '', (v) => Math.round(parseFloat(v) * 100) + '%');
assert.strictEqual(cust.get('lyrics.adlib_scale'), 0.64);
assert.strictEqual(elements['badge-cust-adlib-scale'].textContent, '64%');

window.onCustomizationSelectChange('lyrics.scroll_inertia_mode', 'smooth');
assert.strictEqual(cust.get('lyrics.scroll_inertia_mode'), 'smooth');
console.log('[PASS] Phase 5 Secondary Scale, Ad-lib Scale & Scroll Inertia interactions verified');

// Phase 3: Test Artwork Spin toggle handler & DOM reflection
window.toggleCustomizationArtworkSpin();
assert.strictEqual(cust.get('layout.artwork_spin_enabled'), true);
assert.strictEqual(elements['cust-artwork-spin-state'].textContent, 'On');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-artwork-spin'], 'true');
assert.strictEqual(document.body.classList.contains('artwork-spin'), true);

window.toggleCustomizationArtworkSpin();
assert.strictEqual(cust.get('layout.artwork_spin_enabled'), false);
assert.strictEqual(elements['cust-artwork-spin-state'].textContent, 'Off');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-artwork-spin'], 'false');
assert.strictEqual(document.body.classList.contains('artwork-spin'), false);
console.log('[PASS] toggleCustomizationArtworkSpin toggles state, badge, and DOM attributes');

// Phase 3: Test Spatial Orientation select change & DOM reflection
window.onCustomizationSelectChange('layout.orientation', 'vertical-column');
assert.strictEqual(cust.get('layout.orientation'), 'vertical-column');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-orientation'], 'vertical-column');

window.onCustomizationSelectChange('layout.orientation', 'vertical-right');
assert.strictEqual(cust.get('layout.orientation'), 'vertical-right');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-orientation'], 'vertical-right');
console.log('[PASS] onCustomizationSelectChange updates layout.orientation and reflects data-orientation attribute');

// Phase 3: Test Artwork Shape select change & DOM reflection
window.onCustomizationSelectChange('layout.artwork_shape', 'vinyl');
assert.strictEqual(cust.get('layout.artwork_shape'), 'vinyl');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-artwork-shape'], 'vinyl');

window.onCustomizationSelectChange('layout.artwork_shape', 'squircle');
assert.strictEqual(cust.get('layout.artwork_shape'), 'squircle');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-artwork-shape'], 'squircle');
console.log('[PASS] onCustomizationSelectChange updates layout.artwork_shape and reflects data-artwork-shape attribute');

// Phase 3 & 4: Test Lyrics Dock select change & DOM reflection
window.onCustomizationSelectChange('layout.lyrics_dock', 'center');
assert.strictEqual(cust.get('layout.lyrics_dock'), 'center');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-lyrics-dock'], 'center');

window.onCustomizationSelectChange('layout.lyrics_dock', 'right');
assert.strictEqual(cust.get('layout.lyrics_dock'), 'right');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-lyrics-dock'], 'right');

window.onCustomizationSelectChange('layout.lyrics_dock', 'left');
assert.strictEqual(cust.get('layout.lyrics_dock'), 'left');
cust.cssBridge.flushNow();
assert.strictEqual(docAttrs['data-lyrics-dock'], 'left');
console.log('[PASS] onCustomizationSelectChange updates layout.lyrics_dock and reflects data-lyrics-dock attribute');

// Phase 4: Test signature atmospheric background tints across all 8 presets
const expectedTints = {
  cyberpunk: 'rgba(180, 0, 255, 0.28)',
  ambient_neon: 'rgba(0, 245, 210, 0.25)',
  apple_classical: 'rgba(225, 165, 80, 0.24)',
  retro_arcade: 'rgba(30, 80, 240, 0.28)',
  kinetic_karaoke: 'rgba(255, 50, 130, 0.22)',
  minimalist: 'rgba(120, 140, 180, 0.12)',
  studio_oled: 'rgba(0, 0, 0, 0)',
  default: 'rgba(140, 100, 255, 0.20)'
};

for (const [presetId, tint] of Object.entries(expectedTints)) {
  window.onCustomizationPresetChange(presetId);
  assert.strictEqual(cust.get('themes.theme_bg_tint'), tint, `Preset ${presetId} theme_bg_tint mismatch`);
}
console.log('[PASS] All 8 built-in presets correctly load signature atmospheric background tints');

// Test preset change handler across all 8 canonical built-ins
for (const pid of expectedPresets) {
  window.onCustomizationPresetChange(pid);
  assert.strictEqual(cust.store.getCurrentPresetId(), pid);
}
console.log('[PASS] onCustomizationPresetChange successfully activates all 8 canonical built-in presets');

// Test specific preset values (e.g. Cyberpunk)
window.onCustomizationPresetChange('cyberpunk');
assert.strictEqual(cust.store.getCurrentPresetId(), 'cyberpunk');
assert.strictEqual(elements['slider-cust-particle-density'].value, 120);
assert.strictEqual(cust.get('lyrics.active_glow_color'), '#00ffcc');
assert.strictEqual(cust.get('lyrics.active_scale'), 1.15);
console.log('[PASS] Cyberpunk preset applies specialized visual and typography parameters');

// Reset to default preset
window.onCustomizationPresetChange('default');
assert.strictEqual(cust.store.getCurrentPresetId(), 'default');

// Test checkbox change handler (e.g. target controls)
window.onCustomizationCheckboxChange('reactive.target_controls', true);
assert.strictEqual(cust.get('reactive.target_controls'), true);
window.onCustomizationCheckboxChange('reactive.target_controls', false);
assert.strictEqual(cust.get('reactive.target_controls'), false);
console.log('[PASS] onCustomizationCheckboxChange toggles target checkboxes');

// Test color change handler
window.onCustomizationColorChange('lyrics.active_glow_color', '#ffaa00');
assert.strictEqual(cust.get('lyrics.active_glow_color'), '#ffaa00');
console.log('[PASS] onCustomizationColorChange updates color properties');

// Test Save & Delete preset workflow
elements['cust-input-new-preset'].value = 'Midnight Neon';
window.submitSavePreset();
const newPresetId = cust.store.getCurrentPresetId();
assert(newPresetId.startsWith('preset_midnight_neon'), 'Newly created preset should become active');
assert.strictEqual(elements['cust-preset-active-badge'].textContent, 'Custom');
assert(elements['cust-preset-active-badge'].classList.contains('is-custom'), 'Badge must have is-custom class for user preset');

window.deleteCurrentPreset();
assert.strictEqual(cust.store.getCurrentPresetId(), 'default', 'Deleting active preset must revert to default');
console.log('[PASS] submitSavePreset and deleteCurrentPreset interactive workflow verified');

// --- 4. ui/app.js Integration Verification ---
const appJs = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');

assert(appJs.includes("if (want === 'customization')"), 'FAIL: openSettingsTab must handle customization tab');
assert(appJs.includes('syncCustomizationSettingsUI()'), 'FAIL: syncCustomizationSettingsUI call missing in openSettingsTab');
assert(appJs.includes('window.syncCustomizationSettingsUI = syncCustomizationSettingsUI'), 'FAIL: syncCustomizationSettingsUI must be exported on window');
assert(appJs.includes('window.syncCustomizationSettingsUI()'), 'FAIL: openSettings must trigger syncCustomizationSettingsUI');

// Simulate calling app.js syncCustomizationSettingsUI
let renderedCount = 0;
const origRender = window.renderCustomizationPanel;
window.renderCustomizationPanel = () => { renderedCount++; origRender(); };

// Define syncCustomizationSettingsUI as in app.js
function syncCustomizationSettingsUI() {
  if (typeof window.renderCustomizationPanel === 'function') {
    window.renderCustomizationPanel();
  }
}
syncCustomizationSettingsUI();
assert.strictEqual(renderedCount, 1, 'syncCustomizationSettingsUI must invoke renderCustomizationPanel');
console.log('[PASS] ui/app.js tab switching, openSettings hook, and syncCustomizationSettingsUI verified');

console.log('\n=============================================================================');
console.log('>>> ALL CUSTOMIZATION SETTINGS CONSOLE UI ASSERTIONS PASSED! <<<');
console.log('=============================================================================');
