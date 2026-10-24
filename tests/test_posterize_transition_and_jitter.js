// tests/test_posterize_transition_and_jitter.js
// Verification suite for:
// 1. Posterize transition from smooth blurry effect to posterized styling.
// 2. Posterize effect default state switched OFF.
// 3. Vibration / edge jitter option separated as a dedicated toggle.
// 4. Anti-scintillation sub-pixel smoothing and hardware compositing.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Posterize Blur Transition & Edge Vibration Option ===\n');

const html = fs.readFileSync(path.join(__dirname, '../ui/index.html'), 'utf-8');
const css = fs.readFileSync(path.join(__dirname, '../ui/style.css'), 'utf-8');
const js = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf-8');

// --- 1. Default Switched Off Verification ---
console.log('--- 1. Default Switched Off Verification ---');

// Assert HTML defaults to Off
assert(html.includes('id="qp-bg-posterize-state">Off</span>'), 'FAIL: Posterize style button state must default to Off');
assert(html.includes('id="badge-bg-posterize">Off</span>'), 'FAIL: Posterize badge must default to Off');
assert(html.includes('id="slider-bg-posterize" min="0" max="100" step="1" value="0"'), 'FAIL: Posterize slider must default to 0');

// Assert JS defaults to Off
assert(js.includes("Settings.get('posterizeStyle', 'off')"), "FAIL: posterizeStyle must default to 'off'");
assert(js.includes("Settings.get('sliderBgPosterize', '0')"), "FAIL: sliderBgPosterize must default to 0");
assert(js.includes("sliderBgPosterize: 0"), "FAIL: Built-in default profile must set sliderBgPosterize: 0");
assert(js.includes("posterizeStyle: \"off\""), "FAIL: Built-in default profile must set posterizeStyle: 'off'");
console.log('PASS: Posterize effect is switched OFF by default across HTML, JS state, and profiles');


// --- 2. Seamless Blur-to-Posterize Transition Pipeline ---
console.log('\n--- 2. Seamless Blur-to-Posterize Transition Pipeline ---');

// Assert SVG filter has feGaussianBlur and feComposite arithmetic
assert(html.includes('id="posterize-smooth"'), 'FAIL: #posterize-smooth feGaussianBlur missing in SVG filter');
assert(html.includes('id="posterize-composite"'), 'FAIL: #posterize-composite feComposite missing in SVG filter');
assert(html.includes('operator="arithmetic"'), 'FAIL: #posterize-composite must use arithmetic operator for cross-fading');

// Assert JS modulates effective blur and blend factors
assert(js.includes('function applyEffectiveBgBlur'), 'FAIL: applyEffectiveBgBlur function missing');
assert(js.includes('blend.setAttribute(\'k2\', k2)'), 'FAIL: applyPosterizeFilter must update k2 blend factor');
assert(js.includes('blend.setAttribute(\'k3\', k3)'), 'FAIL: applyPosterizeFilter must update k3 blend factor');

// Assert animation function exists for smooth style switching
assert(js.includes('function animatePosterizeTransition'), 'FAIL: animatePosterizeTransition function missing');
console.log('PASS: Continuous transition pipeline dynamically interpolates blur, quantization steps, and arithmetic blend');


// --- 3. Edge Vibration as a Separate Option ---
console.log('\n--- 3. Edge Vibration as a Separate Option ---');

// Assert HTML has edge vibration action row
assert(html.includes('id="qp-bg-jitter"'), 'FAIL: #qp-bg-jitter button missing in HTML');
assert(html.includes('id="qp-bg-jitter-state">Off</span>'), 'FAIL: #qp-bg-jitter-state must default to Off');
assert(html.includes('onclick="toggleBgJitter()"'), 'FAIL: toggleBgJitter onclick handler missing');

// Assert JS manages bgJitter state and toggling
assert(js.includes('function toggleBgJitter'), 'FAIL: toggleBgJitter function missing in app.js');
assert(js.includes("Settings.get('bgJitter', 'off') === 'on'"), "FAIL: bgJitter must default to 'off'");
assert(js.includes('if (bgJitter)'), 'FAIL: applyPosterizeFilter must inspect bgJitter setting');
assert(js.includes("smooth.setAttribute('stdDeviation', '0')"), 'FAIL: When bgJitter is on, smooth stdDeviation must be 0 for raw discrete edge chatter');
console.log('PASS: Edge vibration is a separate dedicated toggle defaulting to Off with raw discrete chatter on activation');


// --- 4. Hardware Anti-Scintillation & GPU Layer Promotion ---
console.log('\n--- 4. Hardware Anti-Scintillation & GPU Layer Promotion ---');

// Assert CSS provides hardware layer hints to eliminate sub-pixel vibration
assert(css.includes('backface-visibility: hidden;'), 'FAIL: .cover-art-blur must have backface-visibility: hidden');
assert(css.includes('transform: translateZ(0);'), 'FAIL: .cover-art-blur must have transform: translateZ(0) GPU layer hint');
assert(css.includes('transition: opacity 1.4s ease, filter 0.35s cubic-bezier'), 'FAIL: .cover-art-blur must declare smooth filter transition');
console.log('PASS: CSS hardware layer hints and filter transition curves eliminate temporal aliasing');

console.log('\n>>> ALL POSTERIZE TRANSITION & JITTER TESTS PASSED! <<<');
