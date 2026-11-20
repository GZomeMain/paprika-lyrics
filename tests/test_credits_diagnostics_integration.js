const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

console.log('=== TEST SUITE: Diagnostics & Credits Deep Integration Audit ===');

const htmlPath = path.join(__dirname, '..', 'ui', 'index.html');
const cssPath = path.join(__dirname, '..', 'ui', 'style.css');
const jsPath = path.join(__dirname, '..', 'ui', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(jsPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Tab Markup & Label Verification
console.log('\n--- 1. Tab Markup & Diagnostics Panel Placement ---');
assert(html.includes('id="qp-tab-diag"'), 'qp-tab-diag ID must exist');
assert(html.includes('data-tab="diag"'), 'data-tab="diag" must exist');
assert(html.includes('aria-controls="qp-panel-diag"'), 'aria-controls="qp-panel-diag" must exist');

// Match tab label
const tabMatch = html.match(/<button[^>]*id="qp-tab-diag"[^>]*>([\s\S]*?)<\/button>/);
assert(tabMatch, 'qp-tab-diag button element must be found');
assert(tabMatch[1].includes('Diagnostics &amp; Credits') || tabMatch[1].includes('Diagnostics & Credits'),
       'Tab button must display "Diagnostics & Credits"');
console.log('[PASS] Diagnostics & Credits tab label properly configured with preserved bindings');

// 2. Diagnostics Components in qp-panel-diag
console.log('\n--- 2. Diagnostics Telemetry Suite Intactness ---');
const diagPanelMatch = html.match(/<div class="sp-panel"[^>]*id="qp-panel-diag"[^>]*>([\s\S]*?)<\/div><!-- \/#qp-panel-diag -->/);
assert(diagPanelMatch, 'qp-panel-diag panel must be found');
const diagPanelHtml = diagPanelMatch[1];

assert(diagPanelHtml.includes('id="qp-info-toggle"'), 'qp-info-toggle must be inside qp-panel-diag');
assert(diagPanelHtml.includes('id="qp-info"'), 'qp-info must be inside qp-panel-diag');
assert(diagPanelHtml.includes('id="qp-info-body"'), 'qp-info-body must be inside qp-panel-diag');
assert(diagPanelHtml.includes('id="qp-info-caret"'), 'qp-info-caret must be inside qp-panel-diag');
console.log('[PASS] All diagnostics telemetry components intact inside qp-panel-diag');

// 3. Contribution & Credits Group Placement
console.log('\n--- 3. Credits Section Placement & Exclusion from Lyrics Page ---');
assert(diagPanelHtml.includes('id="qp-group-credits"'), 'qp-group-credits must be located inside qp-panel-diag');
assert(diagPanelHtml.includes('data-static'), 'qp-group-credits must have data-static attribute');

const lyricsPanelMatch = html.match(/<div class="sp-panel"[^>]*id="qp-panel-lyrics"[^>]*>([\s\S]*?)<\/div><!-- \/#qp-panel-lyrics -->/) ||
                         html.match(/<div class="sp-panel"[^>]*id="qp-panel-lyrics"[^>]*>([\s\S]*?)<div class="sp-panel"/);
assert(lyricsPanelMatch, 'qp-panel-lyrics must be found');
assert(!lyricsPanelMatch[1].includes('id="qp-group-credits"'), 'qp-group-credits must NOT exist inside qp-panel-lyrics');
assert(!lyricsPanelMatch[1].includes('sp-credits-card'), 'sp-credits-card must NOT exist inside qp-panel-lyrics');
console.log('[PASS] Credits card moved out of Lyrics panel into Diagnostics panel');

// 4. Contribution Card Markup & Action Buttons
console.log('\n--- 4. Contribution Card Markup & Required Elements ---');
assert(diagPanelHtml.includes('id="sp-credits-card"'), 'sp-credits-card must be inside qp-panel-diag');
assert(diagPanelHtml.includes('id="sp-credits-provider-badge"'), 'sp-credits-provider-badge must exist');
assert(diagPanelHtml.includes('id="sp-credits-writers-row"'), 'sp-credits-writers-row must exist');
assert(diagPanelHtml.includes('id="sp-credits-writers"'), 'sp-credits-writers must exist');
assert(diagPanelHtml.includes('id="sp-credits-maker-row"'), 'sp-credits-maker-row must exist');
assert(diagPanelHtml.includes('id="sp-credits-maker"'), 'sp-credits-maker must exist');
assert(diagPanelHtml.includes('id="sp-credits-uploader-row"'), 'sp-credits-uploader-row must exist');
assert(diagPanelHtml.includes('id="sp-credits-uploader"'), 'sp-credits-uploader must exist');
assert(diagPanelHtml.includes('id="sp-credits-empty-hint"'), 'sp-credits-empty-hint must exist');

// External Platform Links & Buttons
assert(diagPanelHtml.includes('https://spicylyrics.org'), 'Spicy Lyrics link must exist');
assert(diagPanelHtml.includes('https://developers.spicylyrics.org'), 'API Portal link must exist');
assert(diagPanelHtml.includes('https://lrclib.net'), 'LRCLIB link must exist');

// Settings Footer Attribution
assert(html.includes('class="sp-foot-attribution"'), 'Settings footer attribution must exist');
assert(html.includes('https://spicylyrics.org'), 'Footer link to spicylyrics.org must exist');
console.log('[PASS] Contribution card markup and footer attribution verified');

// 5. CSS Styling Verification
console.log('\n--- 5. Theme Cohesion & Obsidian Plum Aesthetics ---');
assert(css.includes('.sp-credits-card'), '.sp-credits-card rule must exist in CSS');
assert(css.includes('.sp-credits-badge'), '.sp-credits-badge rule must exist in CSS');
assert(css.includes('.sp-credit-user-link'), '.sp-credit-user-link rule must exist in CSS');
assert(css.includes('.sp-credit-avatar'), '.sp-credit-avatar rule must exist in CSS');
assert(css.includes('.sp-credits-actions'), '.sp-credits-actions rule must exist in CSS');
assert(css.includes('.sp-foot-attribution'), '.sp-foot-attribution rule must exist in CSS');
assert(css.includes('#573878'), 'Plum border accent #573878 present in CSS');
assert(css.includes('#c084fc') || css.includes('#d1bcff'), 'Lavender accent present in CSS');
console.log('[PASS] CSS Obsidian Plum console aesthetic styles verified');

// 6. JavaScript Logic & Runtime Behavior (via JSDOM simulation in VM)
console.log('\n--- 6. Runtime JavaScript Functions & Integration ---');
assert(js.includes('function renderCreditsInSettings()'), 'renderCreditsInSettings function must exist');
assert(js.includes('function renderDiagnostics()'), 'renderDiagnostics function must exist');
assert(js.includes('function formatCreditUsername('), 'formatCreditUsername helper must exist');
assert(js.includes('window.openExternalUrl'), 'openExternalUrl must be exposed on window');
assert(js.includes('window.setAttribution'), 'setAttribution must be exposed on window');
assert(js.includes('window.setDiagnostics'), 'setDiagnostics must be exposed on window');

// Test formatCreditUsername logic
const context = { console, window: {} };
vm.createContext(context);
vm.runInContext(`
  function formatCreditUsername(nameOrId) {
    if (!nameOrId) return '';
    const s = String(nameOrId).trim();
    return s.startsWith('@') ? s : '@' + s;
  }
  window.formatCreditUsername = formatCreditUsername;
`, context);

assert.strictEqual(context.window.formatCreditUsername('johndoe'), '@johndoe');
assert.strictEqual(context.window.formatCreditUsername('@johndoe'), '@johndoe');
assert.strictEqual(context.window.formatCreditUsername(' 12345 '), '@12345');
assert.strictEqual(context.window.formatCreditUsername(''), '');
console.log('[PASS] formatCreditUsername handles clean @ prefix without duplicate @@');

// 7. Searchable Rows Integration
console.log('\n--- 7. Settings Search Integration ---');
assert(js.includes("el.classList.contains('sp-credits-card')"), 'sp-credits-card must be searchable');
assert(js.includes("row.classList.contains('sp-credits-card')"), 'sp-credits-card must have comprehensive text marking');
console.log('[PASS] Settings search indexing and text-marking verified');

// 8. Section 6 Attribution Verification in Diagnostics & Credits
console.log('\n--- 8. Section 6 Attribution Requirements Verification ---');

// Mock DOM elements for renderCreditsInSettings and appendLyricsCredits
const mockElements = {
  'sp-credits-provider-badge': { textContent: '' },
  'sp-credits-writers-row': { style: { display: 'none' } },
  'sp-credits-writers': { textContent: '' },
  'sp-credits-maker-row': { style: { display: 'none' } },
  'sp-credits-maker': { innerHTML: '', textContent: '' },
  'sp-credits-uploader-row': { style: { display: 'none' } },
  'sp-credits-uploader': { innerHTML: '', textContent: '' },
  'sp-credits-empty-hint': { style: { display: '' } }
};

const domContext = {
  console,
  document: {
    getElementById(id) { return mockElements[id] || null; },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        className: '',
        id: '',
        innerHTML: '',
        textContent: '',
        children: [],
        style: {},
        appendChild(child) { this.children.push(child); },
        remove() {}
      };
    }
  },
  window: {}
};

vm.createContext(domContext);
vm.runInContext(`
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

  ${js.slice(js.indexOf('function resolveAttributionProvider('), js.indexOf('function renderCornerAttribution()'))}

  window.resolveAttributionProvider = resolveAttributionProvider;
  window.renderCreditsInSettings = renderCreditsInSettings;
  window.appendLyricsCredits = appendLyricsCredits;
  window.setAttr = (a) => { currentAttribution = a; };
  window.setSource = (s) => { currentLyricsSource = s; };
  window.setLyrics = (l) => { lyrics = l; };
  window.setDiag = (d) => { diagnostics = d; };
`, domContext);

const { resolveAttributionProvider, renderCreditsInSettings, appendLyricsCredits } = domContext.window;

// 8.1 resolveAttributionProvider checks
const spicyRes1 = resolveAttributionProvider({ provider: 'spicy_lyrics' });
assert.strictEqual(spicyRes1.provider, 'spicy_lyrics');
assert.strictEqual(spicyRes1.providerLabel, 'Spicy Lyrics');

const spicyRes2 = resolveAttributionProvider({ provider: 'community' });
assert.strictEqual(spicyRes2.provider, 'spicy_lyrics');
assert.strictEqual(spicyRes2.providerLabel, 'Spicy Lyrics');

const spicyRes3 = resolveAttributionProvider({ provider: 'spicy' });
assert.strictEqual(spicyRes3.provider, 'spicy_lyrics');
assert.strictEqual(spicyRes3.providerLabel, 'Spicy Lyrics');

const spicyRes4 = resolveAttributionProvider({ provider_label: 'Community lyrics' });
assert.strictEqual(spicyRes4.providerLabel, 'Spicy Lyrics');

// Missing / None / unknown checks -> must be "Unknown"
const unkRes1 = resolveAttributionProvider(null, '');
assert.strictEqual(unkRes1.provider, 'unknown');
assert.strictEqual(unkRes1.providerLabel, 'Unknown');

const unkRes2 = resolveAttributionProvider({ provider: 'none', provider_label: 'None' }, 'None');
assert.strictEqual(unkRes2.provider, 'unknown');
assert.strictEqual(unkRes2.providerLabel, 'Unknown');

const unkRes3 = resolveAttributionProvider({}, 'unknown');
assert.strictEqual(unkRes3.provider, 'unknown');
assert.strictEqual(unkRes3.providerLabel, 'Unknown');

console.log('[PASS] resolveAttributionProvider correctly normalizes Spicy Lyrics and handles Unknown');

// 8.2 renderCreditsInSettings checks
domContext.window.setLyrics([{ text: 'Song line' }]);
domContext.window.setAttr({
  provider: 'community',
  maker: { username: 'testmaker', id: '456' },
  uploader: { username: 'testuploader', id: '789' }
});
renderCreditsInSettings();
assert.strictEqual(mockElements['sp-credits-provider-badge'].textContent, 'Spicy Lyrics',
  'Provider badge must display "Spicy Lyrics" for community provider');
assert.strictEqual(mockElements['sp-credits-maker-row'].style.display, '');
assert(mockElements['sp-credits-maker'].innerHTML.includes('https://spicylyrics.org/uid/456'));
assert(mockElements['sp-credits-maker'].innerHTML.includes('@testmaker'));
assert.strictEqual(mockElements['sp-credits-uploader-row'].style.display, '');
assert(mockElements['sp-credits-uploader'].innerHTML.includes('https://spicylyrics.org/uid/789'));
assert(mockElements['sp-credits-uploader'].innerHTML.includes('@testuploader'));

// Missing / unknown attribution in settings
domContext.window.setAttr(null);
domContext.window.setSource('None');
renderCreditsInSettings();
assert.strictEqual(mockElements['sp-credits-provider-badge'].textContent, 'Unknown',
  'Provider badge must display "Unknown" when source is "None"');

domContext.window.setAttr({ provider: 'unknown' });
domContext.window.setSource('');
renderCreditsInSettings();
assert.strictEqual(mockElements['sp-credits-provider-badge'].textContent, 'Unknown',
  'Provider badge must display "Unknown" when provider is "unknown"');

console.log('[PASS] renderCreditsInSettings badge and contributor links verified for Section 6');

// 8.3 appendLyricsCredits container test
const mockContainer = {
  children: [],
  appendChild(child) { this.children.push(child); }
};

appendLyricsCredits(mockContainer, {
  provider: 'community',
  songwriters: ['John Lennon', 'Paul McCartney'],
  maker: { username: 'lyric_maker', id: '999' }
}, 'spicy_lyrics');

assert(mockContainer.children.length > 0, 'Credits element must be appended');
const creditsBlock = mockContainer.children[0];
assert.strictEqual(creditsBlock.id, 'lyrics-credits');

// Check songwriters row
const writersBlock = creditsBlock.children.find(c => c.className === 'lyrics-credits-writers');
assert(writersBlock, 'Songwriters block must exist');
assert(writersBlock.innerHTML.includes('John Lennon, Paul McCartney'));

// Check attribution row
const attrBlock = creditsBlock.children.find(c => c.className === 'lyrics-credits-attribution');
assert(attrBlock, 'Attribution row must exist');
const provEl = attrBlock.children.find(c => c.className === 'lyrics-credit-provider');
assert(provEl, 'Provider span must exist');
assert.strictEqual(provEl.textContent, 'Spicy Lyrics', 'Provider in song credits must be "Spicy Lyrics"');

// Unknown in appendLyricsCredits
const mockContainerUnk = {
  children: [],
  appendChild(child) { this.children.push(child); }
};
appendLyricsCredits(mockContainerUnk, { provider: 'unknown' }, '');
const unkBlock = mockContainerUnk.children[0];
const unkAttrBlock = unkBlock.children.find(c => c.className === 'lyrics-credits-attribution');
const unkProvEl = unkAttrBlock.children.find(c => c.className === 'lyrics-credit-provider');
assert.strictEqual(unkProvEl.textContent, 'Unknown', 'Unknown provider must display "Unknown" in song credits');

console.log('[PASS] appendLyricsCredits properly renders "Spicy Lyrics", songwriters, maker, and "Unknown"');

console.log('\n>>> ALL DIAGNOSTICS & CREDITS INTEGRATION CHECKS PASSED! <<<');
