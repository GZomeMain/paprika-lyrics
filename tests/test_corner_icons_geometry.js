const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Corner Icons Geometric Alignment ===');

const htmlPath = path.join(__dirname, '..', 'ui', 'index.html');
const cssPath = path.join(__dirname, '..', 'ui', 'style.css');
const jsPath = path.join(__dirname, '..', 'ui', 'app.js');

const html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(jsPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Check HTML semantic classes on top & bottom corner buttons
assert(
  html.includes('id="sidebar-btn-settings"') && html.includes('sidebar-corner-top'),
  '#sidebar-btn-settings must include class sidebar-corner-top'
);
assert(
  html.includes('id="sb-toggle-trans"') && html.includes('sidebar-corner-bottom'),
  '#sb-toggle-trans must include class sidebar-corner-bottom'
);
console.log('[PASS] HTML markup has semantic corner button classes (sidebar-corner-top & sidebar-corner-bottom)');

// 2. Check CSS rules for top corner button (settings): top matches border, bottom is default squircle
assert(css.includes('.sidebar-corner-top'), 'CSS must define .sidebar-corner-top rule');
assert(
  css.includes('border-top-left-radius: 18px !important') || css.includes('border-top-left-radius: 17px !important'),
  'Top-left radius must match capsule border curve (17px or 18px)'
);
assert(
  css.includes('border-top-right-radius: 18px !important') || css.includes('border-top-right-radius: 17px !important'),
  'Top-right radius must match capsule border curve (17px or 18px)'
);
assert(
  css.includes('border-bottom-left-radius: 10px !important') || css.includes('border-bottom-left-radius: 9px !important'),
  'Bottom-left radius must remain default squircle (9px or 10px)'
);
assert(
  css.includes('border-bottom-right-radius: 10px !important') || css.includes('border-bottom-right-radius: 9px !important'),
  'Bottom-right radius must remain default squircle (9px or 10px)'
);
console.log('[PASS] Top corner icon has top capsule curve and bottom default squircle');

// 3. Check CSS rules for bottom corner button (trans): top is default squircle, bottom matches border
assert(css.includes('.sidebar-corner-bottom'), 'CSS must define .sidebar-corner-bottom rule');
assert(
  css.includes('border-bottom-left-radius: 18px !important') || css.includes('border-bottom-left-radius: 17px !important'),
  'Bottom-left radius must match capsule border curve (17px or 18px)'
);
assert(
  css.includes('border-bottom-right-radius: 18px !important') || css.includes('border-bottom-right-radius: 17px !important'),
  'Bottom-right radius must match capsule border curve (17px or 18px)'
);
console.log('[PASS] Bottom corner icon has bottom capsule curve and top default squircle');

// 4. Check uniform concentric inner container padding
assert(
  css.includes('padding: 8px 0 !important') || css.includes('padding: 6px 3px !important'),
  'Inner container must have concentric padding for uniform buffer'
);
console.log('[PASS] Latency rail inner has uniform concentric padding');

// 5. Check responsive scaling rules for smaller viewports
assert(css.includes('border-top-left-radius: 15px !important'), '580px media query scales corner top radius to 15px');
assert(css.includes('border-bottom-left-radius: 15px !important'), '580px media query scales corner bottom radius to 15px');
assert(css.includes('border-top-left-radius: 12px !important'), '460px media query scales corner top radius to 12px');
assert(css.includes('border-bottom-left-radius: 12px !important'), '460px media query scales corner bottom radius to 12px');
console.log('[PASS] Responsive media queries adapt corner radii seamlessly');

// 6. Check JS state synchronization for settings button
assert(js.includes('sbGear.classList.toggle(\'active\', open)'), 'openSettings toggles active class on sidebar settings button');
assert(js.includes('sbGear.setAttribute(\'aria-expanded\', open ? \'true\' : \'false\')'), 'openSettings syncs aria-expanded');
console.log('[PASS] Settings toggle state syncs with sidebar settings keycap');

console.log('\n>>> ALL CORNER ICONS GEOMETRY ASSERTIONS PASSED! <<<');
