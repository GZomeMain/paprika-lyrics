// tests/test_customization_modules.js
// Verification suite for Paprika Advanced Customization Modules:
// 1. DynamicTypographyModule (lyrics domain, DoF rendering, syllable/line styling)
// 2. AudioReactiveSyncModule (reactive domain, target registry, synced kinetic motion)
// 3. PluggableParticleEngine (visuals domain, recycled pool, pluggable particle types)
// 4. ui/app.js & ui/index.html integration & fallback integrity

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Advanced Customization Modules & App Integration ===\n');

// ---------------------------------------------------------------------------
// 1. Load Modules & Customization Core
// ---------------------------------------------------------------------------
const customizationCore = require('../ui/customization.js');
const modules = require('../ui/customization_modules.js');

const {
  DynamicTypographyModule,
  AudioReactiveSyncModule,
  PluggableParticleEngine,
  RecycledParticlePool
} = modules;

assert(typeof DynamicTypographyModule === 'function', 'DynamicTypographyModule should be a constructor function');
assert(typeof AudioReactiveSyncModule === 'function', 'AudioReactiveSyncModule should be a constructor function');
assert(typeof PluggableParticleEngine === 'function', 'PluggableParticleEngine should be a constructor function');
assert(typeof RecycledParticlePool === 'function', 'RecycledParticlePool should be a constructor function');

console.log('PASS: All customization module classes exported cleanly.');


// ---------------------------------------------------------------------------
// 2. Test DynamicTypographyModule
// ---------------------------------------------------------------------------
console.log('\n--- Test 2: DynamicTypographyModule ---');

const typo = new DynamicTypographyModule(customizationCore);
assert.strictEqual(typo.domain, 'lyrics', 'Typography module must manage domain "lyrics"');
assert(typo.options.activeScale >= 1.0, 'activeScale must be >= 1.0');
assert.strictEqual(typeof typo.options.activeOffsetX, 'number', 'activeOffsetX must be numeric');
assert.strictEqual(typeof typo.options.activeOffsetY, 'number', 'activeOffsetY must be numeric');

// Mock lines for DoF test
function createMockLine(idx) {
  const styles = {};
  const classes = new Set();
  const attrs = {};

  return {
    element: {
      style: {
        setProperty(k, v) { styles[k] = v; },
        getPropertyValue(k) { return styles[k] || ''; },
        set filter(v) { styles.filter = v; },
        get filter() { return styles.filter || ''; },
        set opacity(v) { styles.opacity = v; },
        get opacity() { return styles.opacity || ''; },
        set transform(v) { styles.transform = v; },
        get transform() { return styles.transform || ''; },
        set fontStyle(v) { styles.fontStyle = v; },
        get fontStyle() { return styles.fontStyle || ''; },
        set fontWeight(v) { styles.fontWeight = v; },
        get fontWeight() { return styles.fontWeight || ''; },
        set fontStretch(v) { styles.fontStretch = v; },
        get fontStretch() { return styles.fontStretch || ''; }
      },
      classList: {
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
      setAttribute(k, v) { attrs[k] = v; },
      getAttribute(k) { return attrs[k] || null; },
      removeAttribute(k) { delete attrs[k]; },
      tabIndex: -1
    },
    index: idx,
    dofTier: null,
    isBackground: false,
    isAdlib: false,
    isChorus: false
  };
}

const lines = [0, 1, 2, 3, 4].map(createMockLine);

// Test DoF when line 2 is active
typo.applyDepthOfField(lines, [2]);

assert.strictEqual(lines[2].dofTier, 'active', 'Line 2 must be tier "active"');
assert.strictEqual(lines[1].dofTier, 'near', 'Line 1 must be tier "near"');
assert.strictEqual(lines[3].dofTier, 'near', 'Line 3 must be tier "near"');
assert.strictEqual(lines[0].dofTier, 'mid', 'Line 0 must be tier "mid"');
assert.strictEqual(lines[4].dofTier, 'mid', 'Line 4 must be tier "mid"');

assert(lines[2].element.classList.contains('is-active'), 'Line 2 must have "is-active" class');
assert(!lines[1].element.classList.contains('is-active'), 'Line 1 must not have "is-active" class');
assert(lines[2].element.style.transform.includes('scale('), 'Active line must have scale transform');
assert.strictEqual(lines[2].element.style.opacity, '1', 'Active line must have opacity 1');

// Test Idle DoF (empty active indices)
typo.applyDepthOfField(lines, []);
assert.strictEqual(lines[2].dofTier, 'idle', 'Line 2 must become tier "idle" when nothing is singing');
assert(!lines[2].element.classList.contains('is-active'), 'Line 2 must remove "is-active" when idle');

// Test onLineCreated decoration
const bgLine = createMockLine(5);
bgLine.isBackground = true;
typo.onLineCreated(bgLine);
assert.strictEqual(bgLine.element.style.fontStyle, typo.options.backingVocalStyle, 'Backing vocal font style must match options');
assert.strictEqual(bgLine.element.getAttribute('data-tier'), 'backing-vocal', 'Backing vocal data-tier attribute set');

const adlibLine = createMockLine(6);
adlibLine.isAdlib = true;
typo.onLineCreated(adlibLine);
assert.strictEqual(adlibLine.element.getAttribute('data-tier'), 'adlib', 'Ad-lib data-tier attribute set');

const chorusLine = createMockLine(7);
chorusLine.isChorus = true;
typo.onLineCreated(chorusLine);
assert.strictEqual(chorusLine.element.getAttribute('data-tier'), 'chorus', 'Chorus data-tier attribute set');

console.log('PASS: DynamicTypographyModule DoF tiering, active scaling, and line decoration verified.');


// ---------------------------------------------------------------------------
// 3. Test AudioReactiveSyncModule
// ---------------------------------------------------------------------------
console.log('\n--- Test 3: AudioReactiveSyncModule ---');

const reactive = new AudioReactiveSyncModule(customizationCore);
assert.strictEqual(reactive.domain, 'reactive', 'AudioReactiveSyncModule must manage domain "reactive"');

// Target Registry verification
assert(reactive.hasTarget('album-art'), 'Default target "album-art" must be registered');
assert(reactive.hasTarget('lyrics-active'), 'Default target "lyrics-active" must be registered');
assert(reactive.hasTarget('controls'), 'Default target "controls" must be registered');
assert(reactive.hasTarget('ambient-bloom'), 'Default target "ambient-bloom" must be registered');
assert(reactive.hasTarget('particle-emitter'), 'Default target "particle-emitter" must be registered');

// Custom target subscription
const customTarget = reactive.subscribeTarget('custom-banner', '#banner', {
  impulseStrength: 1.5,
  actions: ['scale-pulse', 'glow-bloom'],
  maxScale: 0.1
});
assert.strictEqual(reactive.getTarget('custom-banner').impulseStrength, 1.5);
assert(reactive.hasTarget('custom-banner'));
reactive.unsubscribeTarget('custom-banner');
assert(!reactive.hasTarget('custom-banner'), 'Unsubscribe target must cleanly remove from registry');

// Test Beat Trigger & Physics Integration
const artTarget = reactive.getTarget('album-art');
const initialVel = artTarget.scaleVel;
reactive.triggerBeat(1.0, false);
assert(artTarget.scaleVel > initialVel, 'Beat transient must impart positive scale velocity');
assert.strictEqual(artTarget.settled, false, 'Target must be active (unsettled) following beat trigger');

// Physics step update simulation
let totalSteps = 0;
while (!artTarget.settled && totalSteps < 200) {
  reactive.update(16.6);
  totalSteps++;
}
assert(totalSteps < 150, `Spring must settle cleanly within 150 frames, took ${totalSteps}`);
assert.strictEqual(artTarget.settled, true, 'Target must settle to zero velocity and displacement');
assert.strictEqual(artTarget.scaleDisp, 0, 'Target displacement must rest at 0');

// Drop multiplier verification
reactive.triggerBeat(1.0, true);
const dropVel = artTarget.scaleVel;
artTarget.scaleVel = 0;
reactive.triggerBeat(1.0, false);
const regularVel = artTarget.scaleVel;
assert(dropVel > regularVel, 'Drop downbeats must have higher transient velocity than regular beats');

console.log('PASS: AudioReactiveSyncModule target registry, beat triggers, and spring physics verified.');


// ---------------------------------------------------------------------------
// 4. Test PluggableParticleEngine & Zero-Allocation Pool
// ---------------------------------------------------------------------------
console.log('\n--- Test 4: PluggableParticleEngine & Recycled Pool ---');

const particles = new PluggableParticleEngine(customizationCore);
assert.strictEqual(particles.domain, 'visuals', 'PluggableParticleEngine must manage domain "visuals"');

const pool = particles.pool;
assert.strictEqual(pool.count, 0, 'Pool initially empty');

// Spawn particles
const p0 = pool.spawn(0, 100, 150, 0.2, -0.3, 8.0, 15000, 200, 220, 255);
const p1 = pool.spawn(1, 200, 250, -0.1, -0.2, 10.0, 16000, 255, 255, 255);
assert.strictEqual(pool.count, 2, 'Pool count must be 2');
assert.strictEqual(pool.active[p0], 1);
assert.strictEqual(pool.x[p0], 100);
assert.strictEqual(pool.y[p0], 150);

// Recycle particle
pool.recycle(p0);
assert.strictEqual(pool.count, 1, 'Pool count must decrease on recycle');
assert.strictEqual(pool.active[p0], 0, 'Slot must be marked inactive');

// Spawning after recycle reuses inactive slot without allocation
const pReused = pool.spawn(2, 300, 350, 0, 0, 50, 1200, 255, 200, 180);
assert.strictEqual(pReused, p0, 'Pool must reuse inactive slot in-place');

// Test pluggable particle types
assert(particles.particleTypes.has('motes'), 'Built-in type "motes" registered');
assert(particles.particleTypes.has('stars'), 'Built-in type "stars" registered');
assert(particles.particleTypes.has('ripples'), 'Built-in type "ripples" registered');
assert(particles.particleTypes.has('bokeh'), 'Built-in type "bokeh" registered');

// Test custom type registration
let customDrawn = false;
particles.registerParticleType('custom-nebula', {
  draw: () => { customDrawn = true; },
  onBeat: (p, i, surge) => { p.beatVy[i] -= surge * 2; }
});
assert(particles.particleTypes.has('custom-nebula'), 'Custom particle type registered');

// Test acoustic ripple emission
const rippleIdx = particles.emitAcousticRipple(150, 150, 80, 255, 200, 150);
assert(rippleIdx >= 0, 'emitAcousticRipple must return valid particle index');
assert.strictEqual(pool.typeId[rippleIdx], particles.particleTypes.get('ripples').id);

console.log('PASS: PluggableParticleEngine zero-allocation recycling and pluggable architecture verified.');


// ---------------------------------------------------------------------------
// 5. Test Integration in ui/app.js & ui/index.html
// ---------------------------------------------------------------------------
console.log('\n--- Test 5: Integration Hooks in ui/app.js & ui/index.html ---');

const appJs = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf-8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf-8');

// Assert hooks in app.js
assert(appJs.includes('window.customizationModules.reactive.triggerBeat'), 'app.js must hook into triggerBeatTransient');
assert(appJs.includes('window.customizationModules.reactive.triggerSubBeat'), 'app.js must hook into triggerSubBeatTransient');
assert(appJs.includes('window.customizationModules.typography.applyDepthOfField'), 'app.js must hook into updateLineDepthOfField');
assert(appJs.includes('window.customizationModules.typography.onLineCreated'), 'app.js must hook into line creation');
assert(appJs.includes('window.customizationModules.visuals.attachToAirPipeline'), 'app.js must hook into AirParticlePipeline.init');
assert(appJs.includes('window.customizationModules.visuals.onBeatImpulse'), 'app.js must hook into AirParticlePipeline.onBeatImpulse');
assert(appJs.includes('window.customizationModules.visuals.render'), 'app.js must hook into AirParticlePipeline.updateAndRender');
assert(appJs.includes('window.customizationModules.reactive.update'), 'app.js must hook into tick() for physics');

console.log('PASS: All app.js hook call sites verified.');

// Assert script tags in index.html in correct order
const custJsIdx = indexHtml.indexOf('<script src="customization.js"></script>');
const modsJsIdx = indexHtml.indexOf('<script src="customization_modules.js"></script>');
const appJsIdx = indexHtml.indexOf('<script src="app.js"></script>');

assert(custJsIdx !== -1, 'customization.js script tag must be present in index.html');
assert(modsJsIdx !== -1, 'customization_modules.js script tag must be present in index.html');
assert(appJsIdx !== -1, 'app.js script tag must be present in index.html');

assert(custJsIdx < modsJsIdx, 'customization.js must precede customization_modules.js');
assert(modsJsIdx < appJsIdx, 'customization_modules.js must precede app.js');

console.log('PASS: index.html script tag inclusion and load ordering verified.');

console.log('\n=======================================================');
console.log('ALL CUSTOMIZATION MODULE SUITE TESTS PASSED (100% OK)');
console.log('=======================================================');
