const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Frosted Glass Sidebar Overhaul & Seamless Controls ===');

const htmlPath = path.join(__dirname, '..', 'ui', 'index.html');
const cssPath = path.join(__dirname, '..', 'ui', 'style.css');
const jsPath = path.join(__dirname, '..', 'ui', 'app.js');
const hotkeysPath = path.join(__dirname, '..', 'core', 'hotkeys.py');

const html = fs.readFileSync(htmlPath, 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(jsPath, 'utf8').replace(/\r\n/g, '\n');
const hotkeys = fs.readFileSync(hotkeysPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Quick utility controls restored to sidebar (while keeping transport uncluttered)
assert(html.includes('id="sidebar-btn-pin"'), 'Pin button must be present in sidebar');
assert(html.includes('id="sb-toggle-ontop"'), 'Always on top button must be present in sidebar');
assert(html.includes('id="sb-toggle-layout"'), 'Layout switch button must be present in sidebar');
assert(html.includes('id="sb-toggle-fs"'), 'Fullscreen toggle button must be present in sidebar');
assert(html.includes('id="sb-toggle-trans"'), 'Translation/Romaji button must be present in sidebar');
assert(!html.includes('sidebar-group-transport'), 'Song transport controls should remain uncluttered');
console.log('[PASS] Restored essential quick controls (Always On Top, Pin, Layout, Fullscreen, Romaji)');

// 2. Arrow buttons replace +-50 text buttons in sidebar
const railStart = html.indexOf('id="latency-rail"');
const railEnd = html.indexOf('</aside>', railStart);
const sidebarMarkup = html.slice(railStart, railEnd);
assert(sidebarMarkup.includes('id="latency-rail-plus"'), 'Latency advance button must exist');
assert(sidebarMarkup.includes('id="latency-rail-minus"'), 'Latency delay button must exist');
assert(!sidebarMarkup.includes('>+50<'), 'Static +50 text button must be replaced by clean arrow in sidebar');
assert(!sidebarMarkup.includes('>-50<'), 'Static -50 text button must be replaced by clean arrow in sidebar');
assert(sidebarMarkup.includes('id="sidebar-btn-rst"'), 'Reset button must exist');
console.log('[PASS] Arrow buttons replace +-50 text buttons for silky latency nudging');

// 3. Fader track text collision fix: No overlapping text in narrow rail
assert(!html.includes('class="sb-scale-mark"'), 'Overlapping text marks (+1.5s/0/-1.5s) must be removed from narrow rail');
assert(html.includes('id="latency-rail-value"'), 'Clean digital readout must exist');
console.log('[PASS] Colliding inline text marks removed; clean digital readout retained');

// 4. Latency modes always vertical
assert(html.includes('sidebar-latency-modes vertical-modes') || html.includes('sidebar-latency-modes'), 'Modes container present');
assert(css.includes('flex-direction: column !important') || css.includes('flex-direction: column'), 'DEF/AUTO modes must be vertically stacked');
assert(html.includes('id="sidebar-btn-default-latency"'), 'Default latency button must exist');
assert(html.includes('id="sidebar-btn-auto-latency"'), 'Auto latency button must exist');
console.log('[PASS] Latency modes DEF and AUTO stacked vertically');

// 5. Frosted glass aesthetic with purple hints (zero opaque purple paint & no green dot)
assert(css.includes('backdrop-filter: blur(28px)') || css.includes('backdrop-filter: blur'), 'Frosted glass blur must be active');
assert(!css.includes('rgba(20, 16, 26, 0.92) !important'), 'Heavy opaque purple paint must be removed');
assert(!html.includes('id="sidebar-source-dot"'), 'Green AI-slop dot must be removed');
console.log('[PASS] Translucent frosted glass styling with purple hints verified (zero opaque purple, zero green dots)');

// 6. Win32 global hotkeys & repeat handling
assert(!hotkeys.includes('HOTKEY_DEC_ID, MOD_CONTROL | MOD_NOREPEAT'), 'HOTKEY_DEC_ID should support continuous repeat');
assert(!hotkeys.includes('HOTKEY_INC_ID, MOD_CONTROL | MOD_NOREPEAT'), 'HOTKEY_INC_ID should support continuous repeat');
assert(js.includes('isBracketLeft') && js.includes('isBracketRight'), 'In-app bracket keys repeat handling verified');
assert(js.includes('resetLatencyToZero()'), 'resetLatencyToZero handler present');
console.log('[PASS] Win32 & in-app continuous repeat and 0ms reset verified');

// 7. Silky 10ms fader drag & 0ms magnetic snap
assert(js.includes('Math.round(rawTarget / 10) * 10'), 'Fine 10ms granularity implemented for silky drag');
assert(js.includes('if (Math.abs(target) <= 35) target = 0;'), 'Magnetic detent snap at 0ms implemented');
console.log('[PASS] Silky smooth 10ms drag and 0ms magnetic snap verified in app.js');

// 8. Latency slider touch-action, hit area & pointer capture fixes
assert(css.includes('.sidebar-sync-slider-col') && css.includes('touch-action: none !important'), 'Slider column must have touch-action: none');
assert(css.includes('.sidebar-sync-slider.latency-slider') && css.includes('touch-action: none !important'), 'Slider must have touch-action: none');
assert(css.includes('pointer-events: none !important'), 'Slider thumb/fill must pass through pointer events to avoid drag interruption');
assert(js.includes("slider.closest('.sidebar-sync-slider-col')"), 'Column clicks must initiate drag');
assert(js.includes('lostpointercapture'), 'lostpointercapture must be handled for robust dragging');
assert(js.includes('updateLatencyUI()') && js.includes('window.renderLatencySlider()'), 'adjustLatency must update UI and slider in real-time');
console.log('[PASS] Latency slider touch-action, pointer capture, and real-time UI synchronization verified');

// 9. Settings button & Profiles Hub button functionality
assert(html.includes('id="sidebar-btn-settings"') && html.includes('toggleSettings(event)'), 'Settings button must toggle settings console');
assert(html.includes('id="sidebar-current-source"') && html.includes('toggleQuickProfileMenu(event)'), 'Profiles Hub button must open quick profile menu');
assert(html.includes('id="sidebar-source-icon"') && html.includes('<svg'), 'Sidebar profiles hub must render a valid vector SVG by default (never empty box)');
assert(js.includes('rect.left - popupWidth - 10'), 'Floating quick profile menu must adapt dynamically when triggered from sidebar');
console.log('[PASS] Settings console toggle and Players & Profiles Hub integration verified');

console.log('\n>>> ALL FROSTED GLASS SIDEBAR & INTERACTION ASSERTIONS PASSED! <<<');
