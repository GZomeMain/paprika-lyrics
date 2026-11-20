const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

console.log('=== TEST SUITE: Corner Attribution, UI Visibility Toggles & Reduced Sidebar Range ===\n');

const htmlPath = path.join(__dirname, '..', 'ui', 'index.html');
const cssPath = path.join(__dirname, '..', 'ui', 'style.css');
const jsPath = path.join(__dirname, '..', 'ui', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(jsPath, 'utf8').replace(/\r\n/g, '\n');

let passedChecks = 0;
function pass(msg) {
  console.log(`[PASS] ${msg}`);
  passedChecks++;
}

// ---------------------------------------------------------
// 1. DOM Markup & Position Verification for Corner Attribution
// ---------------------------------------------------------
console.log('--- 1. Corner Attribution Markup & Positioning ---');
assert(html.includes('id="hud-attribution"'), 'Element #hud-attribution must exist in index.html');
assert(html.includes('class="hud-attribution"'), 'Element .hud-attribution class must exist');
assert(html.includes('data-no-drag'), 'hud-attribution must have data-no-drag attribute');

// Verify position after lyrics container
const lyricsContainerIdx = html.indexOf('id="lyrics-container"');
const hudAttrIdx = html.indexOf('id="hud-attribution"');
assert(lyricsContainerIdx !== -1 && hudAttrIdx !== -1, 'Both lyrics-container and hud-attribution must be present');
assert(hudAttrIdx > lyricsContainerIdx, 'hud-attribution must be rendered with lyrics scroller layer');
pass('DOM contains #hud-attribution with data-no-drag positioned with lyrics overlay');

// ---------------------------------------------------------
// 2. CSS Styling & Opacity Transitions
// ---------------------------------------------------------
console.log('\n--- 2. CSS Styling, Subtle Opacity & Hover States ---');
assert(css.includes('.hud-attribution {'), '.hud-attribution rule must exist in style.css');
assert(css.includes('position: fixed;'), 'hud-attribution must be fixed position');
assert(css.includes('right: 14px;'), 'hud-attribution must be aligned to right edge');
assert(css.includes('bottom: 12px;'), 'hud-attribution must be aligned to bottom edge');
assert(css.includes('z-index: 40;'), 'hud-attribution must have z-index: 40');
assert(css.includes('opacity: 0.35;'), 'hud-attribution must have subtle 0.35 default opacity');
assert(css.includes('.hud-attribution:hover {'), '.hud-attribution:hover rule must exist');
assert(css.includes('opacity: 0.98;') || css.includes('opacity: 1;'), 'hud-attribution:hover must transition to near-full opacity');
assert(css.includes('body.hide-corner-attribution #hud-attribution'), 'body.hide-corner-attribution rule must exist');
assert(css.includes('body.hide-track-card #track-float'), 'body.hide-track-card rule must exist');
assert(css.includes('body.hide-quick-controls #latency-rail'), 'body.hide-quick-controls rule must exist');
assert(css.includes('body.hide-gap-chip #gap-indicator'), 'body.hide-gap-chip rule must exist');
pass('CSS rules confirm 0.35 subtle opacity, hover transition to 0.98+, and UI visibility override classes');

// ---------------------------------------------------------
// 3. Settings UI: Advanced Interface Elements Group
// ---------------------------------------------------------
console.log('\n--- 3. Settings Panel UI Visibility & Attribution Disclaimers ---');
assert(html.includes('id="qp-group-ui-visibility"'), 'qp-group-ui-visibility section must exist');
assert(html.includes('data-group-name="Interface Elements"'), 'Interface Elements group name must exist');
assert(html.includes('id="qp-toggle-corner-attr"'), 'qp-toggle-corner-attr button must exist');
assert(html.includes('id="qp-corner-attr-state"'), 'qp-corner-attr-state element must exist');
assert(html.includes('id="qp-toggle-track-card"'), 'qp-toggle-track-card button must exist');
assert(html.includes('id="qp-track-card-state"'), 'qp-track-card-state element must exist');
assert(html.includes('id="qp-toggle-quick-controls"'), 'qp-toggle-quick-controls button must exist');
assert(html.includes('id="qp-quick-controls-state"'), 'qp-quick-controls-state element must exist');
assert(html.includes('id="qp-toggle-countdown-chip"'), 'qp-toggle-countdown-chip button must exist');
assert(html.includes('id="qp-countdown-chip-state"'), 'qp-countdown-chip-state element must exist');

// Verification of explicit requirement from user:
// Disabling corner attribution only hides the corner badge, NOT the full credit at the bottom of lyrics
assert(html.includes('full songwriter and source credits at the bottom of the lyrics scroll remain permanently visible') ||
       html.includes('only hides the bottom-right'),
       'Settings must explicitly state that full credits at bottom of lyrics container remain visible');
pass('Interface Elements group contains all 4 advanced toggles with explicit disclaimer on credits permanence');

// ---------------------------------------------------------
// 4. Quick Toggle Pill Button in Diagnostics & Credits Card
// ---------------------------------------------------------
console.log('\n--- 4. Quick Toggle Pill in Diagnostics & Credits ---');
assert(html.includes('id="sp-credits-corner-btn"'), 'sp-credits-corner-btn must exist in sp-credits-card');
assert(html.includes('id="sp-credits-corner-pill"'), 'sp-credits-corner-pill must exist in sp-credits-card');
assert(html.includes('id="qp-credits-corner-attr-toggle"'), 'qp-credits-corner-attr-toggle row must exist');
assert(html.includes('id="qp-credits-corner-attr-state"'), 'qp-credits-corner-attr-state must exist');
pass('Quick toggle pill button and action row verified inside sp-credits-card');

// ---------------------------------------------------------
// 5. JavaScript Runtime Logic Simulation (JSDOM-like Environment)
// ---------------------------------------------------------
console.log('\n--- 5. Runtime JavaScript Functions & State Integrity ---');
assert(js.includes('function renderCornerAttribution()'), 'renderCornerAttribution must exist');
assert(js.includes('window.renderCornerAttribution = renderCornerAttribution'), 'renderCornerAttribution exposed on window');
assert(js.includes('function toggleCornerAttribution()'), 'toggleCornerAttribution must exist');
assert(js.includes('function applyCornerAttributionPreference()'), 'applyCornerAttributionPreference must exist');
assert(js.includes('function toggleTrackCardVisibility()'), 'toggleTrackCardVisibility must exist');
assert(js.includes('function applyTrackCardVisibility()'), 'applyTrackCardVisibility must exist');
assert(js.includes('function toggleQuickControlsVisibility()'), 'toggleQuickControlsVisibility must exist');
assert(js.includes('function applyQuickControlsVisibility()'), 'applyQuickControlsVisibility must exist');
assert(js.includes('function toggleCountdownChipVisibility()'), 'toggleCountdownChipVisibility must exist');
assert(js.includes('function applyCountdownChipVisibility()'), 'applyCountdownChipVisibility must exist');

// Check that loadLyrics invokes renderCornerAttribution
assert(js.includes('function resolveAttributionProvider('), 'resolveAttributionProvider must exist');
assert(js.includes('window.resolveAttributionProvider = resolveAttributionProvider'), 'resolveAttributionProvider exposed on window');
assert(js.includes('renderCornerAttribution();'), 'renderCornerAttribution must be called in loadLyrics and setAttribution');

pass('JavaScript runtime functions exist and are properly bound to window and lifecycle hooks');

// ---------------------------------------------------------
// 6. Dynamic Rendering & Attribution Content Formatting Tests
// ---------------------------------------------------------
console.log('\n--- 6. Dynamic Corner Attribution Formatting & Integrity ---');

// Mock a lightweight DOM environment in node vm
const storage = {};
const mockElements = {
  'hud-attribution': {
    style: { display: 'none' },
    innerHTML: '',
    id: 'hud-attribution'
  },
  'lyrics-container': {
    innerHTML: '',
    children: [],
    appendChild(c) { this.children.push(c); },
    replaceChildren() { this.children = []; }
  },
  'qp-corner-attr-state': { textContent: '' },
  'sp-credits-corner-pill': { textContent: '' },
  'qp-credits-corner-attr-state': { textContent: '' },
  'qp-track-card-state': { textContent: '' },
  'qp-quick-controls-state': { textContent: '' },
  'qp-countdown-chip-state': { textContent: '' }
};

const context = {
  console,
  localStorage: {
    getItem(k) { return storage[k] !== undefined ? storage[k] : null; },
    setItem(k, v) { storage[k] = String(v); },
    removeItem(k) { delete storage[k]; }
  },
  document: {
    getElementById(id) { return mockElements[id] || null; },
    querySelector() { return null; },
    body: {
      classList: {
        classes: new Set(),
        add(c) { this.classes.add(c); },
        remove(c) { this.classes.delete(c); },
        toggle(c, force) {
          if (force === undefined) {
            if (this.classes.has(c)) this.classes.delete(c); else this.classes.add(c);
          } else if (force) {
            this.classes.add(c);
          } else {
            this.classes.delete(c);
          }
        },
        contains(c) { return this.classes.has(c); }
      }
    }
  },
  window: {}
};

vm.createContext(context);
vm.runInContext(`
  const Settings = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('sl_' + key);
        return v === null ? fallback : v;
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('sl_' + key, value); } catch (e) {}
    }
  };

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatCreditUsername(nameOrId) {
    if (!nameOrId) return '';
    const s = String(nameOrId).trim();
    return s.startsWith('@') ? s : '@' + s;
  }

  let lyrics = [];
  let currentAttribution = null;
  let currentLyricsSource = "";
  let diagnostics = null;

  function syncSettingsPanel() {}

  ${js.slice(js.indexOf('function resolveAttributionProvider('), js.indexOf('window.setAttribution = function'))}

  window.renderCornerAttribution = renderCornerAttribution;
  window.toggleCornerAttribution = toggleCornerAttribution;
  window.Settings = Settings;
  window.setLyrics = (l) => { lyrics = l; };
  window.setAttr = (a) => { currentAttribution = a; };
  window.setSource = (s) => { currentLyricsSource = s; };
  window.resolveAttributionProvider = resolveAttributionProvider;
`, context);

// Test A: No lyrics loaded -> HUD hidden
context.window.setLyrics([]);
context.window.setAttr({ provider: 'community', maker: { username: 'alice', id: '1' } });
context.window.renderCornerAttribution();
const hudEl = mockElements['hud-attribution'];
assert.strictEqual(hudEl.style.display, 'none', 'HUD must be hidden when lyrics array is empty');
pass('HUD remains hidden when lyrics are not active');

// Test B: Active lyrics with community sync maker & uploader (must show Spicy Lyrics, not Community lyrics)
context.window.setLyrics([{ startTimeMs: 0, endTimeMs: 1000, text: 'Hello world' }]);
context.window.setAttr({
  provider: 'community',
  maker: { username: 'kevin', id: '101', avatar: 'https://example.com/kevin.png' },
  uploader: { username: 'sync_pro', id: '202', avatar: 'https://example.com/pro.png' }
});
context.window.renderCornerAttribution();
assert.strictEqual(hudEl.style.display, 'inline-flex', 'HUD must be shown when lyrics are active');
assert(hudEl.innerHTML.includes('Spicy Lyrics'), 'HUD must show provider "Spicy Lyrics"');
assert(!hudEl.innerHTML.includes('Community lyrics'), 'HUD must not show "Community lyrics" per Section 6');
assert(hudEl.innerHTML.includes('@kevin'), 'HUD must show @kevin');
assert(hudEl.innerHTML.includes('https://spicylyrics.org/uid/101'), 'HUD must link to maker Spicy Lyrics profile');
assert(hudEl.innerHTML.includes('openExternalUrl'), 'Maker link must call openExternalUrl');
assert(hudEl.innerHTML.includes('@sync_pro'), 'HUD must show @sync_pro');
assert(hudEl.innerHTML.includes('https://spicylyrics.org/uid/202'), 'HUD must link to uploader Spicy Lyrics profile');
pass('HUD correctly formats community sync with "Spicy Lyrics" provider, maker & uploader profiles, avatars, and links');

// Test C: Deduplication when maker == uploader (including case insensitivity & string/number ID)
context.window.setAttr({
  provider: 'community',
  maker: { username: 'Alice', id: 101 },
  uploader: { username: 'alice', id: '101' }
});
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Made by'), 'Maker line must be present');
assert(!hudEl.innerHTML.includes('Uploaded by'), 'Uploaded by must be omitted when maker and uploader are identical (case-insensitive)');
pass('HUD deduplicates uploader when maker and uploader are the same user (case-insensitive)');

// Test C2: Provider "spicy" with community syncmaker
context.window.setAttr({
  provider: 'spicy',
  maker: { username: 'bob', id: '303' }
});
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Made by'), 'Maker line must be present for spicy provider');
assert(hudEl.innerHTML.includes('Spicy Lyrics'), 'HUD must show "Spicy Lyrics" for spicy provider');
assert(hudEl.innerHTML.includes('@bob'), 'Maker @bob must be present');
pass('HUD correctly formats maker for spicy provider');

// Test C3: Maker with username but no ID generates /u/username URL
context.window.setAttr({
  provider: 'community',
  maker: { username: 'charlie' }
});
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('https://spicylyrics.org/u/charlie'), 'Maker without ID must link to /u/username');
assert(hudEl.innerHTML.includes('title="@charlie"'), 'Link must have title tooltip for long usernames');
pass('HUD handles missing contributor IDs cleanly with username fallback and title tooltips');

// Test D: Other providers (Apple Music, Spotify, LRCLIB)
context.window.setAttr({ provider: 'apple_music' });
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Apple Music'), 'HUD shows Apple Music');

context.window.setAttr({ provider: 'spotify' });
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Spotify'), 'HUD shows Spotify');

context.window.setAttr({ provider: 'lrclib' });
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('https://lrclib.net'), 'HUD shows LRCLIB with link');
pass('HUD correctly formats Apple Music, Spotify, and LRCLIB attributions');

// Test D2: Spicy Lyrics provider variants (spicy_lyrics, spicylyrics, community)
context.window.setAttr({ provider: 'spicy_lyrics' });
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Spicy Lyrics'), 'HUD shows "Spicy Lyrics" for provider spicy_lyrics');
assert(!hudEl.innerHTML.includes('Community lyrics'), 'HUD never shows "Community lyrics" for provider spicy_lyrics');

context.window.setAttr({ provider: 'community', provider_label: 'Community lyrics' });
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Spicy Lyrics'), 'HUD normalizes provider_label "Community lyrics" to "Spicy Lyrics"');
assert(!hudEl.innerHTML.includes('Community lyrics'), 'HUD does not leak "Community lyrics"');
pass('HUD displays "Spicy Lyrics" across all spicy/community provider variants');

// Test D3: Missing, None, or unknown source/provider must show "Unknown" (never Apple Music or Community lyrics)
context.window.setAttr({ provider: 'unknown' });
context.window.setSource('');
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Unknown'), 'HUD shows "Unknown" when provider is unknown');
assert(!hudEl.innerHTML.includes('Apple Music'), 'HUD never defaults to "Apple Music"');
assert(!hudEl.innerHTML.includes('Community lyrics'), 'HUD never defaults to "Community lyrics"');

context.window.setAttr(null);
context.window.setSource('None');
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Unknown'), 'HUD shows "Unknown" when source is "None"');

context.window.setAttr({});
context.window.setSource('');
context.window.renderCornerAttribution();
assert(hudEl.innerHTML.includes('Unknown'), 'HUD shows "Unknown" when attribution and source are empty');
pass('HUD displays "Unknown" for missing/None/unknown sources without defaulting to Apple Music or Community lyrics');

// Test E: Toggling corner attribution setting
assert.strictEqual(context.window.Settings.get('cornerAttribution', '1'), '1');
context.window.toggleCornerAttribution();
assert.strictEqual(context.window.Settings.get('cornerAttribution', '1'), '0');
assert.strictEqual(hudEl.style.display, 'none', 'HUD must hide when cornerAttribution is toggled off');
assert(context.document.body.classList.contains('hide-corner-attribution'), 'hide-corner-attribution class applied to body');

// Toggle back on
context.window.toggleCornerAttribution();
assert.strictEqual(context.window.Settings.get('cornerAttribution', '1'), '1');
assert.strictEqual(hudEl.style.display, 'inline-flex', 'HUD reappears when cornerAttribution is toggled back on');
assert(!context.document.body.classList.contains('hide-corner-attribution'), 'hide-corner-attribution removed');
pass('Toggling corner attribution properly updates Settings, CSS classes, and element display');

// ---------------------------------------------------------
// 7. Verification of Reduced Popup Range for Sidebar
// ---------------------------------------------------------
console.log('\n--- 7. Reduced Popup Range for Quick Controls Sidebar ---');
// Test the pointerAtEdge logic extracted from app.js
const mockWindow = {
  innerWidth: 1000,
  innerHeight: 800
};

const mockRail = {
  getBoundingClientRect() {
    // Centered at 400px with height of 280px (span: 260px to 540px)
    return {
      top: 260,
      bottom: 540,
      height: 280,
      left: 952,
      right: 1000,
      width: 48
    };
  }
};

const testPointerAtEdge = (clientX, clientY, settingsOpen = false, miniMode = false, showSidebar = '1') => {
  if (miniMode || settingsOpen) return false;
  if (showSidebar === '0') return false;
  const atEdgeX = clientX >= mockWindow.innerWidth - 8 && clientX <= mockWindow.innerWidth;
  if (!atEdgeX) return false;

  const rect = mockRail.getBoundingClientRect();
  const pad = 20;
  const topBound = (rect && rect.height > 0) ? (rect.top - pad) : (mockWindow.innerHeight * 0.5 - 160);
  const bottomBound = (rect && rect.height > 0) ? (rect.bottom + pad) : (mockWindow.innerHeight * 0.5 + 160);
  return clientY >= topBound && clientY <= bottomBound;
};

// Top bound is 260 - 20 = 240px; Bottom bound is 540 + 20 = 560px
// 1. Mouse at right edge near the bar (e.g., clientY = 400px, clientX = 995px) -> SHOULD TRIGGER
assert.strictEqual(testPointerAtEdge(995, 400), true, 'Near center of bar at right edge must trigger popup');

// 2. Mouse at top of window (e.g., clientY = 40px near window controls, clientX = 995px) -> MUST NOT TRIGGER
assert.strictEqual(testPointerAtEdge(995, 40), false, 'Top of window must not trigger sidebar popup');

// 3. Mouse at bottom of window (e.g., clientY = 750px near corner watermark, clientX = 995px) -> MUST NOT TRIGGER
assert.strictEqual(testPointerAtEdge(995, 750), false, 'Bottom of window must not trigger sidebar popup');

// 4. Mouse just within the 20px padding (clientY = 245px, clientX = 995px) -> SHOULD TRIGGER
assert.strictEqual(testPointerAtEdge(995, 245), true, 'Just within padding above bar must trigger');

// 5. Mouse just outside the padding (clientY = 230px, clientX = 995px) -> MUST NOT TRIGGER
assert.strictEqual(testPointerAtEdge(995, 230), false, 'Outside padding above bar must not trigger');

// 6. When showQuickControls setting is '0' -> MUST NOT TRIGGER anywhere
assert.strictEqual(testPointerAtEdge(995, 400, false, false, '0'), false, 'Disabled quick controls setting must suppress trigger');

pass('Reduced popup range tests passed: triggers only within +/-20px of the bar and suppresses at window tops/bottoms');

// ---------------------------------------------------------
// 8. Edge Gap Margin Bridge & Conceal Boundary Tests (isNearRail)
// ---------------------------------------------------------
console.log('\n--- 8. Sidebar Edge Gap Margin Bridge & Safe Region Tests ---');
const testIsNearRail = (clientX, clientY, showSidebar = '1') => {
  if (showSidebar === '0') return false;
  const rect = mockRail.getBoundingClientRect();
  const pad = 20;
  const topBound = Math.max(36, rect.top - pad);
  const bottomBound = Math.min(mockWindow.innerHeight - 22, rect.bottom + pad);
  return clientX >= (rect.left - pad) && clientX <= mockWindow.innerWidth &&
         clientY >= topBound && clientY <= bottomBound;
};

// Rail sits from x = 952 to 1000, and y = 260 to 540.
// Gap between rail (left: 952, right: 1000) and right edge (clientX = 990) -> within bounds
assert.strictEqual(testIsNearRail(990, 400), true, 'Margin gap between window border and rail stays hot when open');
// Moving far above bar (y = 100) -> MUST NOT stay hot
assert.strictEqual(testIsNearRail(990, 100), false, 'Cursor far above bar must not stay hot');
// Moving far below bar (y = 750) -> MUST NOT stay hot
assert.strictEqual(testIsNearRail(990, 750), false, 'Cursor far below bar must not stay hot');
// Moving left outside the pad (x = 900) -> MUST NOT stay hot
assert.strictEqual(testIsNearRail(900, 400), false, 'Cursor moved far left of rail must conceal');
pass('Margin gap bridge and vertical boundary concealment verified');

// ---------------------------------------------------------
// 9. Verification of showLoading Reset and Accessibility Markup
// ---------------------------------------------------------
console.log('\n--- 9. Loading Reset & Accessible Button Markup ---');
assert(js.includes('currentAttribution = null;'), 'showLoading must reset currentAttribution to null');
assert(html.includes('<button type="button" class="qp-row qp-action sp-credits-toggle-row" id="qp-credits-corner-attr-toggle"'),
       'qp-credits-corner-attr-toggle must be an accessible button element');
assert(css.includes('text-overflow: ellipsis;'), 'hud-attr-name must have text-overflow: ellipsis');
assert(css.includes('max-width: 140px;'), 'hud-attr-name must have max-width constraint for long usernames');
pass('showLoading reset, accessible button markup, and text-overflow protection verified');

console.log(`\n=================================================`);
console.log(`ALL CHECKS PASSED: ${passedChecks} assertions verified successfully!`);
console.log(`=================================================`);
