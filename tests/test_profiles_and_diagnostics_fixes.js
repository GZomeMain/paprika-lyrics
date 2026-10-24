const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Profiles & Diagnostics Polish Refinements ===');

const htmlPath = path.join(__dirname, '..', 'ui', 'index.html');
const cssPath = path.join(__dirname, '..', 'ui', 'style.css');
const jsPath = path.join(__dirname, '..', 'ui', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(jsPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Text Removal
assert(!html.includes('Variant C Tactile obsidian console'), 'Variant C text should be removed');
assert(!html.includes('sp-console-badge'), 'sp-console-badge should be removed');
console.log('[PASS] Text "Variant C Tactile obsidian console" successfully removed from index.html');

// 2. Random Green Button Replacement
assert(!css.includes('.sp-toggle-switch input:checked + .sp-toggle-slider {\n  background: #1db954;'), 'Green Spotify button should be replaced in toggle switch');
assert(css.includes('.sp-toggle-switch input:checked + .sp-toggle-slider {\n  background: linear-gradient(180deg, #321c45 0%, #1a0f26 100%);'), 'Toggle switch should have obsidian plum gradient');
assert(css.includes('.sp-toggle-slider::before'), 'Mechanical toggle slider before pseudo-element exists');
assert(css.includes('repeating-linear-gradient'), 'Knurled grip styling exists on toggle');
console.log('[PASS] Green toggle button replaced with theme-cohesive mechanical rocker switch');

// 3. Custom Dropdowns
assert(js.includes('function initCustomSelects()'), 'initCustomSelects function exists in app.js');
assert(js.includes('sp-custom-select-trigger'), 'Custom select trigger markup created in app.js');
assert(js.includes('sp-custom-select-menu'), 'Custom select menu markup created in app.js');
assert(css.includes('.sp-custom-select-trigger'), 'Custom select trigger styled in style.css');
assert(css.includes('.sp-custom-select-menu'), 'Custom select menu styled in style.css');
assert(css.includes('.sp-custom-select-option'), 'Custom select option styled in style.css');
console.log('[PASS] Custom tactile dropdown menu system implemented and styled');

// 4. Diagnostics Formatting
assert(html.includes('<div class="sp-group-head">\n                <h2 class="sp-group-title">Diagnostics</h2>\n              </div>') ||
       html.includes('<div class="sp-group-head">\r\n                <h2 class="sp-group-title">Diagnostics</h2>\r\n              </div>'),
       'Diagnostics title should be wrapped in sp-group-head');
assert(css.includes('#qp-panel-diag .sp-group-title') || css.includes('.sp-group[data-static] > .sp-group-title'),
       'Diagnostics title padding rule should exist in CSS');
console.log('[PASS] Diagnostics header formatting and padding fixed');

console.log('>>> ALL REFINEMENT TESTS PASSED! <<<');
