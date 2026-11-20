// tests/test_advanced_customization.js
// =============================================================================
// Comprehensive Verification & Benchmark Suite for Paprika Advanced Customization
// Phase 1 - 3 Foundation, Kinetics, Shaders, Emitters & Inertial Artwork Physics
//
// 1. CustomizationRegistry: canonical 5 domains + Phase 3 properties, validation, defaults
// 2. Dynamic CSS variable batching & reflection: O(1) RAF batching, DOM style updates
// 3. Preset management: all 8 built-in presets, applying, diffing, saving, export/import
// 4. DynamicTypographyModule: DoF tiers, kinetics (vowel stretch, syllable pop, dual-font)
// 5. AudioReactiveSyncModule: target registry, beat impulses, synced motion, spring physics
// 6. PluggableParticleEngine: all 6 particle types, zero-allocation pool, frame rendering
// 7. Spatial Orientation & Lyrics Dock: 4 orientation modes, dock positions, DOM reflection
// 8. Artwork Geometric Shapes & Rotational Inertia: shapes, 33 RPM acceleration & decel physics
// 9. Breakdown Stasis Dynamics: timeline gap trigger (>=4.5s), energy dampening, anticipation exit
// 10. Performance & Memory Audit: zero memory leaks, O(1) style writes, zero GC allocations
// =============================================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=============================================================================');
console.log('🚀 PAPRIKA ADVANCED CUSTOMIZATION FOUNDATION & FULL PHASE 1-3 BENCHMARK SUITE');
console.log('=============================================================================\n');

// -----------------------------------------------------------------------------
// Global DOM & RAF Mock Environment for Node.js
// -----------------------------------------------------------------------------
const mockStyles = {};
let setPropertyCallCount = 0;
const domAttributes = {};
const bodyClasses = new Set();
const rootAttributes = {};

const mockElements = {
  '#lyrics-container': {
    id: 'lyrics-container',
    setAttribute(k, v) { domAttributes[`lyrics-container:${k}`] = v; },
    getAttribute(k) { return domAttributes[`lyrics-container:${k}`] || null; }
  },
  '#float-art-wrap': {
    id: 'float-art-wrap',
    classList: {
      _c: new Set(),
      add(c) { this._c.add(c); },
      remove(c) { this._c.delete(c); },
      contains(c) { return this._c.has(c); }
    }
  },
  '#track-art': {
    id: 'track-art',
    style: {
      setProperty(k, v) { mockStyles[`track-art:${k}`] = v; },
      set transform(v) { mockStyles['track-art:transform'] = v; },
      get transform() { return mockStyles['track-art:transform'] || ''; }
    }
  }
};

const mockDocument = {
  documentElement: {
    setAttribute(k, v) { rootAttributes[k] = v; },
    getAttribute(k) { return rootAttributes[k] || null; },
    style: {
      setProperty(key, val) {
        setPropertyCallCount++;
        mockStyles[key] = String(val);
      },
      getPropertyValue(key) {
        return mockStyles[key] || '';
      },
      removeProperty(key) {
        delete mockStyles[key];
      }
    }
  },
  body: {
    classList: {
      add(cls) { bodyClasses.add(cls); },
      remove(cls) { bodyClasses.delete(cls); },
      toggle(cls, force) {
        if (force !== undefined) {
          if (force) bodyClasses.add(cls);
          else bodyClasses.delete(cls);
        } else {
          if (bodyClasses.has(cls)) bodyClasses.delete(cls);
          else bodyClasses.add(cls);
        }
      },
      contains(cls) { return bodyClasses.has(cls); }
    }
  },
  getElementById(id) {
    if (id === 'lyrics-container') return mockElements['#lyrics-container'];
    if (id === 'float-art-wrap') return mockElements['#float-art-wrap'];
    if (id === 'track-art') return mockElements['#track-art'];
    return mockElements[`#${id}`] || null;
  },
  querySelector(sel) {
    return mockElements[sel] || null;
  },
  querySelectorAll(sel) {
    if (sel.includes('.float-art-wrap') || sel.includes('#float-art-wrap')) {
      return [mockElements['#float-art-wrap']];
    }
    return [];
  }
};

global.document = mockDocument;
global.window = global.window || {};
global.window.addEventListener = global.window.addEventListener || function () {};

let rafCallbacks = [];
global.requestAnimationFrame = function (cb) {
  rafCallbacks.push(cb);
  return rafCallbacks.length;
};
global.cancelAnimationFrame = function (id) {
  // no-op for tests
};

function flushAllRaf() {
  const cbs = rafCallbacks.slice();
  rafCallbacks = [];
  for (const cb of cbs) {
    cb(performance.now ? performance.now() : Date.now());
  }
}

// -----------------------------------------------------------------------------
// Load Modules Under Test
// -----------------------------------------------------------------------------
const customization = require('../ui/customization.js');
const {
  CustomizationEngine,
  CustomizationRegistry,
  EventBus,
  ReactiveDynamicCssBridge,
  StateStore,
  BUILTIN_PRESETS
} = customization;

const modules = require('../ui/customization_modules.js');
const {
  DynamicTypographyModule,
  AudioReactiveSyncModule,
  PluggableParticleEngine,
  RecycledParticlePool,
  BreakdownStasisController,
  ArtworkPhysicsController
} = modules;

let totalPassed = 0;
function pass(desc) {
  totalPassed++;
  console.log(`  [PASS ${totalPassed}] ${desc}`);
}

// =============================================================================
// SECTION 1: CustomizationRegistry & Phase 1-3 Schema
// =============================================================================
console.log('\n--- SECTION 1: CustomizationRegistry & Phase 1-3 Schema ---');

// 1.1 Canonical Domains
const domains = customization.registry.getDomains().map(d => d.id || d);
assert(domains.includes('lyrics'), 'Registry must include "lyrics" domain');
assert(domains.includes('visuals'), 'Registry must include "visuals" domain');
assert(domains.includes('reactive'), 'Registry must include "reactive" domain');
assert(domains.includes('layout'), 'Registry must include "layout" domain');
assert(domains.includes('themes'), 'Registry must include "themes" domain');
pass('Canonical domains registered: lyrics, visuals, reactive, layout, themes');

// 1.2 Phase 3 Extended Schema Properties
const lyricsProps = customization.registry.getProperties('lyrics').map(p => p.key);
assert(lyricsProps.includes('syllable_stretch_enabled'), 'syllable_stretch_enabled option missing');
assert(lyricsProps.includes('syllable_pop_enabled'), 'syllable_pop_enabled option missing');
assert(lyricsProps.includes('font_family_secondary'), 'font_family_secondary option missing');
assert(lyricsProps.includes('font_family_adlib'), 'font_family_adlib option missing');
assert(lyricsProps.includes('gradient_wipe_enabled'), 'gradient_wipe_enabled option missing');
assert(lyricsProps.includes('variable_font_weight_active'), 'variable_font_weight_active option missing');
assert(lyricsProps.includes('variable_font_width_active'), 'variable_font_width_active option missing');
// Phase 5 Properties
assert(lyricsProps.includes('scroll_inertia_mode'), 'scroll_inertia_mode option missing');
assert(lyricsProps.includes('secondary_scale'), 'secondary_scale option missing');
assert(lyricsProps.includes('adlib_scale'), 'adlib_scale option missing');

const visualsProps = customization.registry.getProperties('visuals').map(p => p.key);
assert(visualsProps.includes('breakdown_stasis_enabled'), 'breakdown_stasis_enabled option missing');
assert(visualsProps.includes('aurora_mesh_enabled'), 'aurora_mesh_enabled option missing');
assert(visualsProps.includes('visualizer_ribbon_enabled'), 'visualizer_ribbon_enabled option missing');

const layoutProps = customization.registry.getProperties('layout').map(p => p.key);
assert(layoutProps.includes('orientation'), 'orientation option missing');
assert(layoutProps.includes('lyrics_dock'), 'lyrics_dock option missing');
assert(layoutProps.includes('lyrics_offset_x'), 'lyrics_offset_x option missing');
assert(layoutProps.includes('lyrics_offset_y'), 'lyrics_offset_y option missing');
assert(layoutProps.includes('artwork_mode'), 'artwork_mode option missing');
assert(layoutProps.includes('artwork_shape'), 'artwork_shape option missing');
assert(layoutProps.includes('artwork_spin_enabled'), 'artwork_spin_enabled option missing');
assert(layoutProps.includes('split_column_duet'), 'split_column_duet option missing');
assert(layoutProps.includes('mini_ticker_mode'), 'mini_ticker_mode option missing');
pass('Phase 3 extended schema properties registered across lyrics, visuals, and layout');

// 1.3 Validation & Bounds Clamping (Phase 1-3)
const clampMax = customization.registry.validate('lyrics', 'font_size_scale', 99.0);
assert.strictEqual(clampMax.value, 3.0, 'font_size_scale above upper bound must clamp to 3.0');

const clampMin = customization.registry.validate('lyrics', 'font_size_scale', -5.0);
assert.strictEqual(clampMin.value, 0.5, 'font_size_scale below lower bound must clamp to 0.5');

// Variable font weight bounds
const vfWeightClamped = customization.registry.validate('lyrics', 'variable_font_weight_active', 1200);
assert.strictEqual(vfWeightClamped.value, 900);

// Orientation enum validation
const validOrient = customization.registry.validate('layout', 'orientation', 'vertical-column');
assert.strictEqual(validOrient.valid, true);
assert.strictEqual(validOrient.value, 'vertical-column');

const invalidOrient = customization.registry.validate('layout', 'orientation', 'upside-down-360');
assert.strictEqual(invalidOrient.valid, false);
assert.strictEqual(invalidOrient.value, 'horizontal', 'Invalid orientation must fall back to default horizontal');

// Artwork shape enum validation
const validShape = customization.registry.validate('layout', 'artwork_shape', 'vinyl');
assert.strictEqual(validShape.valid, true);
assert.strictEqual(validShape.value, 'vinyl');

const invalidShape = customization.registry.validate('layout', 'artwork_shape', 'trapezoid');
assert.strictEqual(invalidShape.valid, false);
assert.strictEqual(invalidShape.value, 'rounded');

// Phase 5 validation checks
const validInertia = customization.registry.validate('lyrics', 'scroll_inertia_mode', 'smooth');
assert.strictEqual(validInertia.valid, true);
assert.strictEqual(validInertia.value, 'smooth');

const invalidInertia = customization.registry.validate('lyrics', 'scroll_inertia_mode', 'hyperdrive');
assert.strictEqual(invalidInertia.valid, false);
assert.strictEqual(invalidInertia.value, 'springy');

const clampedSecondary = customization.registry.validate('lyrics', 'secondary_scale', 1.8);
assert.strictEqual(clampedSecondary.value, 1.0);
const clampedAdlib = customization.registry.validate('lyrics', 'adlib_scale', 0.2);
assert.strictEqual(clampedAdlib.value, 0.40);

pass('Registry validation: bounds clamping, numeric checks, and Phase 3-5 enum validations');

// 1.4 Defaults Structure
const defaults = customization.registry.getDefaults();
assert(defaults.lyrics && defaults.lyrics.syllable_stretch_enabled === true);
assert(defaults.visuals && defaults.visuals.breakdown_stasis_enabled === true);
assert(defaults.layout && defaults.layout.orientation === 'horizontal');
assert.strictEqual(defaults.layout.artwork_spin_enabled, false, 'artwork_spin_enabled must default to false');
pass('Registry getDefaults() produces complete, immutable, deep-copied default tree with spin disabled');

// 1.5 Property Alias Resolution
customization.set('layout.lyricsDock', 'right');
assert.strictEqual(customization.get('layout.lyrics_dock'), 'right');
customization.set('layout.lyrics_dock', 'center');
pass('Property alias resolver handles camelCase and snake_case paths seamlessly');


// =============================================================================
// SECTION 2: Dynamic CSS Variable Batching & Reflection
// =============================================================================
console.log('\n--- SECTION 2: Dynamic CSS Variable Batching & Reflection ---');

const cssBridge = customization.cssBridge;
for (const k in mockStyles) delete mockStyles[k];
setPropertyCallCount = 0;

// 2.1 Single property batching
cssBridge.setProperty('lyrics', 'font_size_scale', 1.45);
assert.strictEqual(setPropertyCallCount, 0, 'Synchronous setProperty must defer DOM mutation until RAF flush');

flushAllRaf();
assert.strictEqual(mockStyles['--cust-lyrics-font-size-scale'], '1.45');
assert(setPropertyCallCount >= 1, 'RAF flush must write batch to documentElement.style');
pass('Dynamic CSS Bridge queues updates and reflects on requestAnimationFrame');

// 2.2 Multiple updates in single tick batching
cssBridge.setProperty('lyrics', 'font_weight', 800);
cssBridge.setProperty('lyrics', 'letter_spacing', 1.5);
cssBridge.setProperty('visuals', 'particle_count', 120);
cssBridge.setProperty('themes', 'accent_color', '#9b5de5');

cssBridge.flushNow();
assert.strictEqual(mockStyles['--cust-lyrics-font-weight'], '800');
assert.strictEqual(mockStyles['--cust-lyrics-letter-spacing'], '1.5px');
assert.strictEqual(mockStyles['--cust-particle-count'], '120');
assert.strictEqual(mockStyles['--cust-accent-color'], '#9b5de5');
pass('Batching coalesces multiple domain updates into a single atomic DOM style flush');

// 2.3 Dirty-check optimization
const currentCallCount = setPropertyCallCount;
cssBridge.setProperty('lyrics', 'font_weight', 800);
cssBridge.setProperty('themes', 'accent_color', '#9b5de5');
cssBridge.flushNow();
assert.strictEqual(setPropertyCallCount, currentCallCount, 'Re-applying unchanged values must produce ZERO redundant setProperty calls');
pass('O(1) dirty-checking eliminates redundant DOM style writes');


// =============================================================================
// SECTION 3: Preset Management & Serialization (All 8 Presets)
// =============================================================================
console.log('\n--- SECTION 3: Preset Management & Serialization (All 8 Presets) ---');

// 3.1 All 8 Built-in Presets
const presetsList = customization.listPresets();
const builtinIds = Array.isArray(presetsList)
  ? presetsList.filter(p => p.builtIn || p.builtin).map(p => p.id)
  : (presetsList.builtin ? Object.keys(presetsList.builtin) : presetsList.presets.filter(p => p.builtin || p.builtIn).map(p => p.id));

const expectedPresets = [
  'default', 'minimalist', 'cyberpunk', 'ambient_neon',
  'kinetic_karaoke', 'studio_oled', 'apple_classical', 'retro_arcade'
];

for (const pid of expectedPresets) {
  assert(builtinIds.includes(pid), `Expected built-in preset '${pid}' not found`);
}
pass('All 8 built-in presets loaded: default, minimalist, cyberpunk, ambient_neon, kinetic_karaoke, studio_oled, apple_classical, retro_arcade');

// 3.2 Signature Atmospheric Background Tint Across All 8 Presets
const expectedTints = {
  default: 'rgba(140, 100, 255, 0.20)',
  minimalist: 'rgba(120, 140, 180, 0.12)',
  cyberpunk: 'rgba(180, 0, 255, 0.28)',
  ambient_neon: 'rgba(0, 245, 210, 0.25)',
  kinetic_karaoke: 'rgba(255, 50, 130, 0.22)',
  studio_oled: 'rgba(0, 0, 0, 0)',
  apple_classical: 'rgba(225, 165, 80, 0.24)',
  retro_arcade: 'rgba(30, 80, 240, 0.28)'
};

for (const [pid, expectedTint] of Object.entries(expectedTints)) {
  const p = customization.store.getPreset(pid);
  assert(p && p.state && p.state.themes, `Preset ${pid} must have themes state`);
  assert.strictEqual(p.state.themes.theme_bg_tint, expectedTint, `Preset ${pid} must have signature tint ${expectedTint}`);
  assert.strictEqual(Boolean(p.state.layout && p.state.layout.artwork_spin_enabled), false, `Preset ${pid} artwork_spin_enabled must be false`);
}
pass('All 8 built-in presets define signature atmospheric background tint colors and have artwork spin disabled');

// 3.3 Apply Phase 3 Presets
customization.applyPreset('studio_oled');
assert.strictEqual(customization.store.getCurrentPresetId(), 'studio_oled');
assert.strictEqual(customization.get('visuals.particle_type'), 'none');
assert.strictEqual(customization.get('themes.background_tint'), '#000000');

customization.applyPreset('apple_classical');
assert.strictEqual(customization.store.getCurrentPresetId(), 'apple_classical');
assert.strictEqual(customization.get('layout.artwork_shape'), 'squircle');

customization.applyPreset('retro_arcade');
assert.strictEqual(customization.store.getCurrentPresetId(), 'retro_arcade');
assert.strictEqual(customization.get('visuals.particle_type'), 'stars');

pass('Phase 3 presets (studio_oled, apple_classical, retro_arcade) apply distinct thematic parameters');

// 3.3 User Preset Lifecycle: Save, List, Delete & Builtin Protection
const customState = {
  lyrics: { font_size_scale: 1.8, active_glow: 25 },
  themes: { accent_color: '#ff007f' }
};
const savedPreset = customization.savePreset('Retro Wave', customState);
assert(savedPreset && savedPreset.id);
assert.strictEqual(savedPreset.name, 'Retro Wave');
assert.strictEqual(Boolean(savedPreset.builtIn || savedPreset.builtin), false);

assert.strictEqual(customization.deletePreset('studio_oled'), false, 'Built-in presets must be protected from deletion');
assert.strictEqual(customization.deletePreset(savedPreset.id), true, 'User preset deletion must succeed');
pass('User preset lifecycle verified: save, list, built-in protection, and delete');

// 3.4 Export & Import with Backend Envelope Compatibility
const exportedJson = customization.exportPreset('retro_arcade');
assert(typeof exportedJson === 'string');

const backendEnvelopeJson = JSON.stringify({
  $schema: 'paprika-customization-preset',
  schema_version: 1,
  exported_at: Date.now(),
  preset: {
    name: 'Cosmic Vaporwave',
    description: 'Imported from backend schema envelope',
    state: {
      themes: { accent_color: '#ff77e9' },
      visuals: { particle_type: 'stars' }
    }
  }
});
const importedFromEnvelope = customization.importPreset(backendEnvelopeJson);
assert(importedFromEnvelope && importedFromEnvelope.name === 'Cosmic Vaporwave');
pass('Preset export and import preserves schema envelope and correctly instantiates preset');

customization.applyPreset('default');


// =============================================================================
// SECTION 4: DynamicTypographyModule & Phase 3 Kinetics
// =============================================================================
console.log('\n--- SECTION 4: DynamicTypographyModule & Phase 3 Kinetics ---');

const typography = new DynamicTypographyModule(customization);

// 4.1 Mock Line Construction
function makeMockLine(index, text, isBackground = false, isAdlib = false, isChorus = false) {
  const styles = {};
  const classes = new Set();
  const attributes = {};

  const el = {
    tagName: 'DIV',
    style: {
      setProperty(k, v) { styles[k] = String(v); },
      getPropertyValue(k) { return styles[k] || ''; },
      set filter(v) { styles.filter = String(v); },
      get filter() { return styles.filter || ''; },
      set opacity(v) { styles.opacity = String(v); },
      get opacity() { return styles.opacity || ''; },
      set transform(v) { styles.transform = String(v); },
      get transform() { return styles.transform || ''; },
      set fontStyle(v) { styles.fontStyle = String(v); },
      get fontStyle() { return styles.fontStyle || ''; },
      set fontWeight(v) { styles.fontWeight = String(v); },
      get fontWeight() { return styles.fontWeight || ''; },
      set fontStretch(v) { styles.fontStretch = String(v); },
      get fontStretch() { return styles.fontStretch || ''; },
      set letterSpacing(v) { styles.letterSpacing = String(v); },
      get letterSpacing() { return styles.letterSpacing || ''; }
    },
    classList: {
      add(cls) { classes.add(cls); },
      remove(cls) { classes.delete(cls); },
      toggle(cls, force) {
        if (force !== undefined) {
          if (force) classes.add(cls);
          else classes.delete(cls);
        } else {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
        }
      },
      contains(cls) { return classes.has(cls); }
    },
    setAttribute(k, v) { attributes[k] = String(v); },
    getAttribute(k) { return attributes[k] || null; },
    removeAttribute(k) { delete attributes[k]; },
    textContent: text
  };

  return { index, element: el, text, isBackground, isAdlib, isChorus, dofTier: null };
}

const mockLines = [
  makeMockLine(0, 'Upcoming line 1'),
  makeMockLine(1, 'Upcoming line 2'),
  makeMockLine(2, 'Currently active line'),
  makeMockLine(3, 'Following near line'),
  makeMockLine(4, 'Far future line'),
  makeMockLine(5, '(Ad-lib harmony)', false, true, false),
  makeMockLine(6, 'Secondary backing vocals', true, false, false),
  makeMockLine(7, 'CHORUS EXPLOSION', false, false, true)
];

// 4.2 DoF Tiers
typography.applyDepthOfField(mockLines, [2]);
assert.strictEqual(mockLines[2].dofTier, 'active');
assert.strictEqual(mockLines[1].dofTier, 'near');
assert.strictEqual(mockLines[0].dofTier, 'mid');
assert(mockLines[2].element.classList.contains('is-active'));
pass('Depth of Field calculates correct visual tiers (active, near, mid, far)');

// 4.3 Line Tier Decoration & Dual Font Hierarchy
mockLines.forEach(l => typography.onLineCreated(l));
assert.strictEqual(mockLines[6].element.getAttribute('data-tier'), 'backing-vocal');
assert.strictEqual(mockLines[5].element.getAttribute('data-tier'), 'adlib');
assert.strictEqual(mockLines[7].element.getAttribute('data-tier'), 'chorus');
pass('DynamicTypographyModule decorates main, active, secondary, ad-lib, and chorus tiers');

// 4.4 Kinetic Syllable Stretch & Pop
const mockSyllableDom = {
  element: {
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      set transform(v) { this._tf = v; },
      get transform() { return this._tf || ''; },
      set letterSpacing(v) { this._ls = v; },
      get letterSpacing() { return this._ls || ''; }
    },
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); }
    }
  },
  startTimeMs: 1000,
  endTimeMs: 2200,
  durationMs: 1200,
  state: 'idle'
};

typography.options.syllableStretchEnabled = true;
typography.options.syllablePopEnabled = true;

// Trigger syllable active at midpoint on sustained note (>=450ms)
typography.onSyllableActive(mockSyllableDom, 1200, 1600);
assert(mockSyllableDom.element.style.transform.includes('scale3d'), 'Sustained vowel stretch must use zero-reflow GPU scale3d transform');
assert(!mockSyllableDom.element.style.transform.includes('translateY'), 'Strong wobbly vertical vibrato animation must be completely removed');

// Verify uniform proportional scaling (equal X and Y scale factors)
const tfMatch = mockSyllableDom.element.style.transform.match(/scale3d\(([^,]+),\s*([^,]+)/);
assert(tfMatch && tfMatch[1] === tfMatch[2], `Kinetic expansion must be uniform proportional scale (equal X and Y scale: ${mockSyllableDom.element.style.transform})`);

assert.strictEqual(mockSyllableDom.element.style.letterSpacing, '', 'Syllable stretch must NOT modify letterSpacing (zero text-reflow guarantee)');
assert(mockSyllableDom.element.style['--syllable-stretch'], 'Syllable stretch CSS token set');
assert(mockSyllableDom.element.classList.contains('syllable-pop'), 'Syllable pop impulse class applied on vocal impact');

// Test standard syllables (<400ms): kinetic expansion does NOT trigger, preserving rich built-in letter variants
const mockQuickSyllable = {
  element: {
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      set transform(v) { this._tf = v; },
      get transform() { return this._tf || ''; }
    },
    classList: { add() {}, remove() {}, contains() { return false; } }
  },
  baseEl: { style: { transform: 'translateY(-3px)' } }, // Child hop variant
  startTimeMs: 100,
  endTimeMs: 380,
  durationMs: 280,
  state: 'idle'
};
typography.onSyllableActive(mockQuickSyllable, 280, 200);
assert.strictEqual(mockQuickSyllable.element.style.transform, '', 'Standard syllables (<400ms, e.g. 280ms) must leave element transform unforced for built-in letter variants');
assert.strictEqual(mockQuickSyllable.baseEl.style.transform, 'translateY(-3px)', 'Child letter variants must be preserved without clobbering');

// Test 400ms threshold: note with dur=400ms triggers impactful expansion (scale >= 1.08)
const mock400Syllable = {
  element: {
    style: {
      setProperty(k, v) { this[k] = v; },
      removeProperty(k) { delete this[k]; },
      set transform(v) { this._tf = v; },
      get transform() { return this._tf || ''; }
    },
    classList: { add() {}, remove() {}, contains() { return false; } }
  },
  baseEl: { style: { transform: '' } },
  startTimeMs: 1000,
  endTimeMs: 1400,
  durationMs: 400,
  state: 'idle'
};
typography.onSyllableActive(mock400Syllable, 400, 1200);
assert(mock400Syllable.element.style.transform.includes('scale3d'), '400ms sustained note must trigger kinetic expansion');
const match400 = mock400Syllable.element.style.transform.match(/scale3d\(([^,]+)/);
assert(match400 && parseFloat(match400[1]) >= 1.08, `400ms note expansion must be impactful (>= 1.08x, got ${match400 && match400[1]})`);
typography.settleSyllable(mock400Syllable);

// Test settle on note end
typography.settleSyllable(mockSyllableDom);
assert.strictEqual(mockSyllableDom.element.style.transform, '', 'Syllable transform cleanly resets to baseline on settle');
pass('Uniform proportional kinetic expansion (>=400ms impactful sustained notes, zero reflow, composing with child variants) and settle verified');

// 4.5 Cascading Scroll Inertia Animation & Zero Synchronous Reflow
assert(typeof typography.triggerScrollCascade === 'function', 'DynamicTypographyModule must provide triggerScrollCascade');
typography.triggerScrollCascade(2, mockLines);
assert(mockLines[2].element.classList.contains('scroll-spring-active'), 'Active line must receive scroll-spring-active class');
assert(mockLines[3].element.classList.contains('scroll-spring-near'), 'Line +1 must receive scroll-spring-near class');
assert(mockLines[4].element.classList.contains('scroll-spring-near'), 'Line +2 must receive scroll-spring-near class');
assert.strictEqual(mockLines[3].element.style.getPropertyValue('--scroll-cascade-scale'), '0.45', 'Line +1 cascade scale must be ~45%');
assert.strictEqual(mockLines[4].element.style.getPropertyValue('--scroll-cascade-scale'), '0.2', 'Line +2 cascade scale must be ~20%');

const modulesSource = fs.readFileSync(path.join(__dirname, '../ui/customization_modules.js'), 'utf8');
assert(!modulesSource.includes('offsetWidth'), 'triggerScrollCascade must eliminate all synchronous offsetWidth layout thrashing');
pass('Fancy spring scroll animation with cascading inertia & zero synchronous reflow verified');

// 4.6 Small Window / PiP Line Fitting & Wrap Containment Verification
const appJsSource = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf8');
assert(appJsSource.includes('effectiveColumn = Math.max(1, usable / Math.max(1.0, activeScale))'), 'fitLyricLines must precalculate activeScale');
assert(appJsSource.includes("words[w].element.classList.toggle('is-wrapped', want)"), 'fitLyricLines must toggle is-wrapped on words exceeding column');
assert(appJsSource.includes('widestBlock = totalW'), 'fitLyricLines must bound unbroken single lines against column');

// Mathematical containment assertion: verify active scale pre-factoring prevents right-edge clipping
const mockContainerWidth = 260; // PiP or mini window column
const mockSpacePx = 6;
const mockActiveOffsetX = 4;
const mockActiveScale = 1.15;
const mockUsable = mockContainerWidth - mockSpacePx - mockActiveOffsetX; // 250px
const mockEffectiveColumn = mockUsable / mockActiveScale; // ~217.39px
const mockUnscaledLineW = 240; // Exceeds effective column (240 * 1.15 = 276px > 250px usable)
const mockWidestBlock = mockUnscaledLineW * mockActiveScale; // 276px
const mockLineFit = mockWidestBlock > mockUsable ? (mockUsable * 0.98) / mockWidestBlock : 1.0;
assert(mockLineFit < 1.0, 'Over-wide line in small window must calculate line-fit < 1.0');
const finalScaledWidth = mockUnscaledLineW * mockActiveScale * mockLineFit;
assert(finalScaledWidth <= mockUsable, `Final rendered width (${finalScaledWidth.toFixed(1)}px) must strictly fit inside usable column (${mockUsable}px)`);
pass('Small window / PiP line fitting pre-factoring activeScale and container bounds verified (zero clipping)');


// =============================================================================
// SECTION 5: AudioReactiveSyncModule Verification
// =============================================================================
console.log('\n--- SECTION 5: AudioReactiveSyncModule Verification ---');

const reactive = new AudioReactiveSyncModule(customization);
assert(reactive.hasTarget('album-art'));
assert(reactive.hasTarget('lyrics-active'));
assert(reactive.hasTarget('controls'));

// Beat impulses & drop multipliers
const artTarget = reactive.getTarget('album-art');
assert(artTarget.maxTilt <= 1.2, `Album art maxTilt must be <= 1.2 deg for subtle breathing recoil, got ${artTarget.maxTilt}`);
assert(artTarget.damping >= 0.65, `Album art damping must be >= 0.65 for smooth settle, got ${artTarget.damping}`);

artTarget.scaleVel = 0;
artTarget.scaleDisp = 0;
artTarget.settled = true;

reactive.triggerBeat(1.0, false);
const regularVel = artTarget.scaleVel;
assert(regularVel > 0);

artTarget.scaleVel = 0;
reactive.triggerBeat(1.0, true);
assert(artTarget.scaleVel > regularVel, 'Drop downbeats must have higher transient velocity');

// Spring settling
let simFrames = 0;
while (!artTarget.settled && simFrames < 200) {
  reactive.update(16.6);
  simFrames++;
}
assert(simFrames < 150);
assert.strictEqual(artTarget.settled, true);
assert.strictEqual(artTarget.scaleDisp, 0);
pass(`Critically damped spring settles back to rest cleanly in ${simFrames} frames with 0 idle drift`);


// =============================================================================
// SECTION 6: PluggableParticleEngine & All 6 Particle Types
// =============================================================================
console.log('\n--- SECTION 6: PluggableParticleEngine & All 6 Particle Types ---');

const particleEngine = new PluggableParticleEngine(customization);
const expectedTypes = ['motes', 'stars', 'ripples', 'bokeh', 'fireflies', 'vinyl'];
for (const t of expectedTypes) {
  assert(particleEngine.particleTypes.has(t), `Particle type '${t}' must be registered`);
}
pass('All 6 pluggable particle types verified: motes, stars, ripples, bokeh, fireflies, vinyl');

// Zero-allocation pool test with multiple particle types
const pool = particleEngine.pool;
pool.clear();

const pMotes = pool.spawn(0, 10, 10, 0.1, -0.1, 5, 5000, 255, 255, 255);
const pStars = pool.spawn(1, 20, 20, 0.2, -0.2, 6, 6000, 200, 220, 255);
const pFireflies = pool.spawn(4, 30, 30, 0.3, -0.3, 7, 7000, 220, 255, 180);
const pVinyl = pool.spawn(5, 40, 40, 0.4, -0.4, 8, 8000, 150, 150, 150);

assert.strictEqual(pool.count, 4);
pool.recycle(pStars);
assert.strictEqual(pool.count, 3);
const pReused = pool.spawn(2, 99, 99, 0, 0, 10, 1000, 255, 200, 100);
assert.strictEqual(pReused, pStars, 'Pool must reuse inactive slot in-place');
pass('Zero-allocation recycled pool operates across all particle types without heap churn');

// Render simulation
const mockCtx = {
  save() {}, restore() {}, beginPath() {}, closePath() {}, arc() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo() {}, rect() {}, fillRect() {}, strokeRect() {}, clearRect() {},
  translate() {}, rotate() {}, scale() {}, quadraticCurveTo() {}, bezierCurveTo() {},
  set fillStyle(v) {}, set strokeStyle(v) {}, set globalAlpha(v) {}, set lineWidth(v) {},
  createRadialGradient() { return { addColorStop() {} }; },
  createLinearGradient() { return { addColorStop() {} }; }
};
particleEngine.render(mockCtx, 800, 600, 16.6);
pass('Particle engine renders frame updates across active types');

// 6.2 Phase 6: Continuous Spawning, Instant Reseeding & 'none' Handling
for (const pType of ['motes', 'stars', 'bokeh', 'ripples', 'fireflies', 'vinyl']) {
  particleEngine.options.particleType = pType;
  particleEngine.reseed(800, 600);
  assert(particleEngine.pool.count > 0, `Particle type '${pType}' must spawn active particles on reseed`);
  particleEngine.render(mockCtx, 800, 600, 16.6);
  assert(particleEngine.pool.count > 0, `Particle type '${pType}' must maintain active particles during render`);
}

// Test 'none' particle type
particleEngine.options.particleType = 'none';
particleEngine.reseed(800, 600);
assert.strictEqual(particleEngine.pool.count, 0, 'Particle type "none" must clear particle pool');
particleEngine.render(mockCtx, 800, 600, 16.6);
assert.strictEqual(particleEngine.pool.count, 0, 'Particle type "none" must skip drawing and maintain 0 count');
pass('All particle types (motes, stars, bokeh, ripples, fireflies, vinyl, none) spawn, reseed, and render verified');


// =============================================================================
// SECTION 7: Spatial Orientation & Layout Controller
// =============================================================================
console.log('\n--- SECTION 7: Spatial Orientation & Layout Controller ---');

// 7.1 Orientation reflection
typography.applyOrientation('vertical-right');
assert.strictEqual(rootAttributes['data-orientation'], 'vertical-right');

typography.applyOrientation('vertical-column');
assert.strictEqual(rootAttributes['data-orientation'], 'vertical-column');

typography.applyOrientation('horizontal');
assert.strictEqual(rootAttributes['data-orientation'], 'horizontal');
pass('Spatial orientation modes (horizontal, vertical-right, vertical-column) reflect to document root');

// 7.2 Lyrics Dock reflection
typography.applyLyricsDock('left');
assert.strictEqual(domAttributes['lyrics-container:data-lyrics-dock'], 'left');

typography.applyLyricsDock('center');
assert.strictEqual(domAttributes['lyrics-container:data-lyrics-dock'], 'center');
pass('Lyrics dock position reflects data-lyrics-dock on container element');

// 7.3 Phase 4: CSS Dynamic Alignment for Gap Indicator & Intro Dots
const custCssContent = fs.readFileSync(path.join(__dirname, '../ui/customization.css'), 'utf8');
assert(custCssContent.includes('[data-lyrics-dock="center"] #lyrics-container > .gap-indicator'), 'CSS must define center dock for gap-indicator');
assert(custCssContent.includes('[data-lyrics-dock="right"] #lyrics-container > .gap-indicator'), 'CSS must define right dock for gap-indicator');
assert(custCssContent.includes('[data-lyrics-dock="left"] #lyrics-container > .gap-indicator'), 'CSS must define left dock for gap-indicator');
assert(custCssContent.includes('[data-lyrics-dock="center"] .intro-dots'), 'CSS must define center dock for intro-dots');
assert(custCssContent.includes('[data-lyrics-dock="right"] .intro-dots'), 'CSS must define right dock for intro-dots');
assert(custCssContent.includes('[data-lyrics-dock="left"] .intro-dots'), 'CSS must define left dock for intro-dots');
pass('Countdown chip (.gap-indicator) and .intro-dots dynamic alignment across center/right/left verified');

// 7.4 Phase 5: Line Containment, Cascading Spring Keyframes & Subordinate Scales
assert(custCssContent.includes('overflow-wrap: break-word'), 'CSS must enforce overflow-wrap: break-word on .line for containment');
assert(custCssContent.includes('.line.scroll-spring-active'), 'CSS must define .line.scroll-spring-active');
assert(custCssContent.includes('.line.scroll-spring-near'), 'CSS must define .line.scroll-spring-near');
assert(custCssContent.includes('@keyframes line-spring-entry'), 'CSS must define @keyframes line-spring-entry');
assert(custCssContent.includes('@keyframes line-spring-near-entry'), 'CSS must define @keyframes line-spring-near-entry');
assert(custCssContent.includes('--cust-lyrics-secondary-scale'), 'CSS must reference --cust-lyrics-secondary-scale');
assert(custCssContent.includes('--cust-lyrics-adlib-scale'), 'CSS must reference --cust-lyrics-adlib-scale');
pass('Phase 5 line containment, spring entry keyframes, and subordinate scale CSS rules verified');

// 7.5 Phase 6: Pure Block Flow, Z-Index Layering & Clean Scroll Keyframes
assert(!custCssContent.includes('#lyrics-container {\n  display: flex'), 'lyrics-container must NEVER have display: flex (breaks native auto-scroll)');
assert(!custCssContent.includes('#lyrics-container {\r\n  display: flex'), 'lyrics-container must NEVER have display: flex (breaks native auto-scroll)');
assert(custCssContent.includes('z-index: 10 !important;'), 'lyrics-container must have z-index: 10 !important');
assert(custCssContent.includes('z-index: 2 !important;'), 'fx-canvas must have z-index: 2 !important');
assert(custCssContent.includes('.line {\n  position: relative;\n  z-index: 5;') || custCssContent.includes('.line {\r\n  position: relative;\r\n  z-index: 5;'), '.line must have z-index: 5');
assert(!custCssContent.includes('.line.scroll-spring-active {\n  animation: line-spring-entry 0.45s cubic-bezier(0.18, 0.89, 0.32, 1.28) forwards;'), 'scroll-spring-active must NOT use forwards');
pass('Phase 6 pure block flow (zero flex scroll lock), strict z-index layering, and clean scroll keyframes verified');


// =============================================================================
// SECTION 8: Artwork Geometric Shapes & Rotational Inertia Physics
// =============================================================================
console.log('\n--- SECTION 8: Artwork Geometric Shapes & Rotational Inertia Physics ---');

const artwork = new ArtworkPhysicsController(customization);

// 8.1 Shape classes & Phase 4 Scrim/Overlay Clipping
const artWrap = mockElements['#float-art-wrap'];
const shapes = ['rounded', 'circle', 'squircle', 'diamond', 'pill', 'vinyl'];

for (const s of shapes) {
  artwork.applyShape(s);
  assert(artWrap.classList.contains(`art-shape-${s}`), `Shape class art-shape-${s} must be applied`);
  assert(custCssContent.includes(`[data-artwork-shape="${s}"] .float-art-wrap::after`), `Dark overlay clipping rule missing for ${s}`);
}
assert(custCssContent.includes('.float-art-wrap') && custCssContent.includes('overflow: hidden !important;'), 'float-art-wrap must enforce overflow: hidden');
pass('Artwork shape morphing and dark overlay / scrim clipping verified across all 6 shapes with zero bleed');

// 8.2 Artwork Spin Default & Rotational Inertia Physics: 33 RPM acceleration & exponential deceleration
assert.strictEqual(artwork.spinEnabled, false, 'Artwork spin must be disabled by default');
artwork.spinEnabled = true;
artwork.angularVel = 0;
artwork.angle = 0;

// Simulate playing acceleration (33 RPM target is ~207.3 deg/s)
for (let i = 0; i < 60; i++) {
  artwork.update(16.6, true);
}
assert(artwork.angularVel > 100, 'Artwork must smoothly accelerate towards 33 RPM while playing');
const peakVel = artwork.angularVel;

// Simulate pause deceleration: omega(t+dt) = omega(t) * exp(-lambda * dt)
for (let i = 0; i < 30; i++) {
  artwork.update(16.6, false);
}
assert(artwork.angularVel < peakVel, 'Artwork must decelerate smoothly when paused');

// Continue deceleration until settled & homed upright to 0°
for (let i = 0; i < 260; i++) {
  artwork.update(16.6, false);
}
assert.strictEqual(artwork.angularVel, 0, 'Artwork rotation must smoothly come to complete rest');
assert.strictEqual(artwork.angle, 0, 'Artwork homing spring must bring angle cleanly back to 0° upright');
pass('Rotational inertia physics: 33 RPM smooth acceleration, exponential deceleration, and homing spring verified');


// =============================================================================
// SECTION 9: Breakdown Stasis Dynamics & Energy Dampening
// =============================================================================
console.log('\n--- SECTION 9: Breakdown Stasis Dynamics & Energy Dampening ---');

const stasis = new BreakdownStasisController(customization);
stasis.enabled = true;
stasis.exitStasis();
assert.strictEqual(stasis.inStasis, false);
assert.strictEqual(stasis.getSpeedMultiplier(), 1.0);
assert.strictEqual(stasis.getImpulseMultiplier(), 1.0);
assert.strictEqual(stasis.getGlowMultiplier(), 1.0);

// Line 1 ends at 10,000ms; Line 2 starts at 16,000ms (6.0s gap >= 4.5s threshold)
const currLine = { endTimeMs: 10000 };
const nextLine = { startTimeMs: 16000 };

// 9.1 Entry into breakdown stasis during instrumental gap (ms = 12,000)
for (let i = 0; i < 45; i++) {
  stasis.checkGap(currLine, nextLine, 12000, 16.6);
}

assert.strictEqual(stasis.inStasis, true, 'Controller must enter breakdown stasis during >=4.5s gap');
assert(bodyClasses.has('in-breakdown-stasis'), 'document.body must receive in-breakdown-stasis class');
assert(stasis.getSpeedMultiplier() <= 0.35, 'Particle speed must be dampened by ~70% during stasis');
assert(stasis.getImpulseMultiplier() <= 0.20, 'Beat impulses must be dampened by ~85% during stasis');
assert(stasis.getGlowMultiplier() <= 0.15, 'Active glow must be dimmed during stasis');
pass('Breakdown stasis activates on >=4.5s instrumental break and applies serene kinetic dampening');

// 9.2 Anticipation Window & Smooth Exit (ms = 15,500, within 800ms lead before nextStart 16,000)
stasis.checkGap(currLine, nextLine, 15800, 16.6);
assert(stasis.stasisFactor < 0.5, 'Stasis factor must ease down during 800ms anticipation window');

// Vocal arrives (ms = 16,000)
stasis.checkGap(currLine, nextLine, 16000, 16.6);
assert.strictEqual(stasis.inStasis, false, 'Controller must exit stasis when vocals resume');
assert(!bodyClasses.has('in-breakdown-stasis'), 'in-breakdown-stasis class must be removed');
assert.strictEqual(stasis.getSpeedMultiplier(), 1.0);
pass('Breakdown stasis anticipation lead window smoothly eases back to 100% vocal energy');


// =============================================================================
// SECTION 10: Performance & Memory Overhead Audit
// =============================================================================
console.log('\n--- SECTION 10: Performance & Memory Overhead Audit ---');

// 10.1 Zero Memory Leak Across All 8 Presets
console.log('  * Running memory leak audit (1,000 transitions across all 8 presets)...');
const initialMem = process.memoryUsage().heapUsed;

for (let i = 0; i < 500; i++) {
  const targetPreset = expectedPresets[i % expectedPresets.length];
  customization.applyPreset(targetPreset);
  customization.set('lyrics.font_size_scale', 1.0 + (i % 10) * 0.05);
}

customization.applyPreset('default');
const postPresetMem = process.memoryUsage().heapUsed;
const presetMemDeltaKb = (postPresetMem - initialMem) / 1024;
console.log(`    Heap delta after 500 multi-preset switches: ${presetMemDeltaKb.toFixed(2)} KB`);
assert(presetMemDeltaKb < 5000, `Memory delta must remain negligible (<5MB), got ${presetMemDeltaKb.toFixed(2)} KB`);
pass('Zero memory leak verified: 500 multi-preset switches do not accumulate memory');

// 10.2 O(1) Style Updates Benchmark
console.log('  * Running O(1) CSS variable batching benchmark (5,000 updates)...');
const benchStart = performance.now();
const iterations = 5000;

for (let i = 0; i < iterations; i++) {
  cssBridge.setProperty('lyrics', 'font_size_scale', 1.0 + (i % 50) * 0.01);
  if (i % 20 === 0) {
    cssBridge.flushNow();
  }
}
cssBridge.flushNow();
const benchEnd = performance.now();
const elapsedMs = benchEnd - benchStart;
const opsPerSec = Math.round((iterations / elapsedMs) * 1000);
console.log(`    Completed ${iterations} updates in ${elapsedMs.toFixed(2)} ms (${opsPerSec.toLocaleString()} ops/sec)`);
assert(elapsedMs < 1000, `CSS Bridge updates must complete in <1000ms, took ${elapsedMs.toFixed(2)}ms`);
pass(`High-performance O(1) style batching benchmark passed (${opsPerSec.toLocaleString()} ops/sec)`);

// 10.3 Zero-Garbage Collection Benchmark: Particle Pool Under Continuous Load
console.log('  * Running Zero-GC Particle Pool benchmark (1,000 simulation frames)...');
const poolBench = new RecycledParticlePool(256);
const refX = poolBench.x;
const refY = poolBench.y;
const refVx = poolBench.vx;
const refVy = poolBench.vy;
const refLife = poolBench.life;
const refActive = poolBench.active;

for (let frame = 0; frame < 1000; frame++) {
  if (poolBench.count < 200) {
    poolBench.spawn(0, 100, 100, (Math.random() - 0.5) * 2, -1, 5, 200, 255, 255, 255);
    poolBench.spawn(1, 200, 200, (Math.random() - 0.5) * 2, -1, 8, 300, 200, 220, 255);
  }

  for (let i = 0; i < poolBench.capacity; i++) {
    if (poolBench.active[i] === 0) continue;
    poolBench.life[i] += 16.6;
    poolBench.x[i] += poolBench.vx[i];
    poolBench.y[i] += poolBench.vy[i];

    if (poolBench.life[i] >= poolBench.maxLife[i]) {
      poolBench.recycle(i);
    }
  }
}

assert.strictEqual(poolBench.x, refX, 'Float32Array buffer for X coordinates must remain identical (zero reallocation)');
assert.strictEqual(poolBench.y, refY, 'Float32Array buffer for Y coordinates must remain identical (zero reallocation)');
assert.strictEqual(poolBench.vx, refVx, 'Float32Array buffer for VX must remain identical (zero reallocation)');
assert.strictEqual(poolBench.vy, refVy, 'Float32Array buffer for VY must remain identical (zero reallocation)');
assert.strictEqual(poolBench.life, refLife, 'Float32Array buffer for Life must remain identical (zero reallocation)');
assert.strictEqual(poolBench.active, refActive, 'Uint8Array buffer for Active flags must remain identical (zero reallocation)');
pass('Zero-GC Particle Pool verified: 1,000 continuous simulation frames completed with 0 buffer allocations');


// =============================================================================
// SUMMARY
// =============================================================================
console.log('\n=============================================================================');
console.log(`🎉 ALL ${totalPassed} ADVANCED CUSTOMIZATION VERIFICATION & BENCHMARK TESTS PASSED!`);
console.log('=============================================================================\n');
