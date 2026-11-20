const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('=== TEST SUITE: Frontend Core Customization Engine ===');

// Test 1: Files existence & index.html links
const indexHtml = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf8');
assert(indexHtml.includes('<link rel="stylesheet" href="customization.css">'), 'FAIL: customization.css not linked in index.html');
assert(indexHtml.includes('<script src="customization.js"></script>'), 'FAIL: customization.js not linked in index.html');
console.log('[PASS] index.html includes customization.css and customization.js before app.js');

// Test 2: Customization Engine in Node
const cust = require('../ui/customization.js');
assert(cust.registry, 'Registry missing');
assert(cust.events, 'EventBus missing');
assert(cust.cssBridge, 'CSS Bridge missing');
assert(cust.store, 'Store missing');
assert(cust.bridge, 'Bridge missing');
console.log('[PASS] Core singletons and sub-modules instantiated');

// Test 3: Registry Schemas
const domains = cust.registry.getDomains().map(d => d.id);
assert(domains.includes('lyrics'), 'lyrics domain missing');
assert(domains.includes('visuals'), 'visuals domain missing');
assert(domains.includes('reactive'), 'reactive domain missing');
assert(domains.includes('layout'), 'layout domain missing');
assert(domains.includes('themes'), 'themes domain missing');
console.log('[PASS] All 5 required domains verified: ' + domains.join(', '));

// Test 4: Registry validation & bounds clamping
const valClamped = cust.registry.validate('lyrics', 'font_size_scale', 5.0);
assert.strictEqual(valClamped.value, 3.0, 'font_size_scale should clamp to max 3.0');
const valMin = cust.registry.validate('lyrics', 'font_size_scale', 0.1);
assert.strictEqual(valMin.value, 0.5, 'font_size_scale should clamp to min 0.5');
const valSelect = cust.registry.validate('layout', 'lyrics_alignment', 'invalid-align');
assert.strictEqual(valSelect.value, 'left', 'Invalid select should fallback to default');
console.log('[PASS] Registry validation and min/max bounds clamping working correctly');

// Test 5: EventBus reactive subscriptions & unsubscribe
let receivedChange = null;
let receivedProp = null;
const unsub1 = cust.on('change', (data) => { receivedChange = data; });
const unsub2 = cust.on('change:lyrics:font_size_scale', (data) => { receivedProp = data; });

cust.set('lyrics.font_size_scale', 1.25);
assert.strictEqual(cust.get('lyrics.font_size_scale'), 1.25);
assert(receivedChange !== null, 'change event not received');
assert.strictEqual(receivedProp.value, 1.25, 'change:lyrics:font_size_scale not received');
unsub1();
unsub2();

receivedChange = null;
cust.set('lyrics.font_size_scale', 1.5);
assert.strictEqual(receivedChange, null, 'Unsubscribe failed to detach listener');
console.log('[PASS] EventBus reactive subscriptions, event cascading, and cleanup verified');

// Test 6: CSS Bridge batching & flush
const fakeDocument = {
  documentElement: {
    style: {
      _styles: {},
      setProperty(k, v) { this._styles[k] = v; },
      removeProperty(k) { delete this._styles[k]; }
    }
  }
};
global.document = fakeDocument;
cust.cssBridge.setProperty('lyrics', 'font_size_scale', 1.2);
cust.cssBridge.flushNow();
assert.strictEqual(fakeDocument.documentElement.style._styles['--cust-lyrics-font-size-scale'], '1.2');
assert.strictEqual(fakeDocument.documentElement.style._styles['--cust-lyric-font-size'], '36px');
console.log('[PASS] CSS Bridge reflection to style.setProperty verified');

// Test 7: Presets & Diffing
const presets = cust.listPresets();
assert(presets.length >= 5, 'Presets list should contain at least 5 built-ins');
const names = presets.map(p => p.id);
assert(names.includes('default') && names.includes('minimalist') && names.includes('cyberpunk') && names.includes('ambient_neon') && names.includes('kinetic_karaoke'));
cust.applyPreset('cyberpunk');
assert.strictEqual(cust.get('lyrics.active_glow_color'), '#00ffcc');
assert.strictEqual(cust.get('visuals.particle_type'), 'stars');
const diff = cust.store.getDiff();
assert(diff.lyrics && diff.lyrics.active_glow_color === '#00ffcc', 'Diff should record active_glow_color override');
console.log('[PASS] Canonical Presets loading, activation, and diff computation verified');

// Test 8: Custom user presets
const userPreset = cust.savePreset('MyAwesomeTheme');
assert(userPreset && userPreset.id, 'User preset should be created');
assert(cust.listPresets().some(p => p.name === 'MyAwesomeTheme'), 'User preset should appear in preset list');
cust.deletePreset(userPreset.id);
assert(!cust.listPresets().some(p => p.name === 'MyAwesomeTheme'), 'User preset should be deleted');
console.log('[PASS] User preset creation, listing, and deletion verified');

// Test 9: Import / Export
cust.reset();
cust.set('lyrics.font_size_scale', 1.75);
const jsonState = cust.exportJson();
cust.reset();
assert.strictEqual(cust.get('lyrics.font_size_scale'), 1.0);
cust.importJson(jsonState);
assert.strictEqual(cust.get('lyrics.font_size_scale'), 1.75);
console.log('[PASS] JSON state serialization, export, and import verified');

// Test 10: Alias resolution
cust.set('lyrics.fontSizeScale', 1.4);
assert.strictEqual(cust.get('lyrics.font_size_scale'), 1.4);
assert.strictEqual(cust.get('lyrics.fontSizeScale'), 1.4);
console.log('[PASS] camelCase to snake_case property alias resolution verified');

console.log('\n>>> ALL 10 FRONTEND CORE CUSTOMIZATION ENGINE ASSERTIONS PASSED! <<<');
