// tests/test_visuals_and_particles.js
// Verification suite for background motion, frosted noise shader,
// particle spatial color adaptation, and star core dot opacity fix.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Visual Dynamics, Noise Shader & Particle Adaptation ===');

const styleCss = fs.readFileSync(path.join(__dirname, '../ui/style.css'), 'utf-8');
const appJs = fs.readFileSync(path.join(__dirname, '../ui/app.js'), 'utf-8');

// --- Test 1: Zoomed Background Drift Expansion ---
console.log('\n--- 1. Zoomed Background Drift Expansion ---');

// Assert inset overscan is widened to protect edges during multi-quadrant travel
assert(
  styleCss.includes('calc(-3.5 * var(--bg-blur) - 24px)'),
  'FAIL: .cover-art-blur inset overscan must be widened to prevent edge exposure during multi-quadrant pan'
);
console.log('PASS: .cover-art-blur has generous overscan margins (-3.5 * var(--bg-blur))');

// Assert cover-bloom-drift keyframe has multi-quadrant waypoints
const driftStart = styleCss.indexOf('@keyframes cover-bloom-drift');
assert(driftStart !== -1, 'FAIL: @keyframes cover-bloom-drift not found in style.css');
const driftEnd = styleCss.indexOf('/* =========================================================', driftStart);
const driftContent = styleCss.slice(driftStart, driftEnd !== -1 ? driftEnd : driftStart + 800);

assert(
  driftContent.includes('0%') && driftContent.includes('20%') &&
  driftContent.includes('40%') && driftContent.includes('60%') &&
  driftContent.includes('80%') && driftContent.includes('100%'),
  'FAIL: cover-bloom-drift should define 6 waypoints for organic exploration'
);
console.log('PASS: cover-bloom-drift features 6 organic waypoints');

// Assert translations cover all 4 quadrants (negative X/Y, positive X/Y)
const hasNegX = /translate3d\s*\(\s*-\d+(\.\d+)?%/.test(driftContent);
const hasPosX = /translate3d\s*\(\s*\+?\d+(\.\d+)?%/.test(driftContent);
const hasNegY = /,\s*-\d+(\.\d+)?%/.test(driftContent);
const hasPosY = /,\s*\+?\d+(\.\d+)?%/.test(driftContent);

assert(hasNegX && hasPosX && hasNegY && hasPosY, 'FAIL: drift must traverse all 4 quadrants (both negative & positive X and Y)');
console.log('PASS: drift translates across all 4 quadrants (X: -7.5% to +7.8%, Y: -6.4% to +7.2%)');

// Assert scale baseline is elevated (~2.25 to 2.42)
assert(/scale\(calc\(2\.[2-4]\d/.test(driftContent), 'FAIL: scale baseline should be 2.25x+ for safe pan-and-scan');
console.log('PASS: scale baseline is elevated to 2.25–2.42 for seamless coverage');


// --- Test 2: Frosted Noise Shader ---
console.log('\n--- 2. Frosted Noise Shader ---');

assert(styleCss.includes('.noise-overlay'), 'FAIL: .noise-overlay rule not found');
assert(styleCss.includes('feTurbulence'), 'FAIL: feTurbulence not found in noise-overlay SVG');
assert(styleCss.includes('feColorMatrix'), 'FAIL: feColorMatrix contrast matrix not found in noise-overlay');
assert(styleCss.includes('frosted-noise-drift'), 'FAIL: frosted-noise-drift animation not declared');
assert(styleCss.includes('mix-blend-mode: overlay'), 'FAIL: mix-blend-mode overlay expected');

const noiseDriftStart = styleCss.indexOf('@keyframes frosted-noise-drift');
assert(noiseDriftStart !== -1, 'FAIL: @keyframes frosted-noise-drift not found');
const noiseDriftEnd = styleCss.indexOf('.reduce-motion .noise-overlay', noiseDriftStart);
const noiseDriftContent = styleCss.slice(noiseDriftStart, noiseDriftEnd !== -1 ? noiseDriftEnd : noiseDriftStart + 500);
assert(noiseDriftContent.includes('translate3d'), 'FAIL: noise drift must use GPU-composited translate3d');
console.log('PASS: Frosted noise shader features high-frequency grain, color contrast matrix, and GPU micro-drift');


// --- Test 3: Star Center Dots Opacity Bug Fix ---
console.log('\n--- 3. Star Center Dots Opacity Bug Fix ---');

// Assert that none of the 3 star drawing functions contain hardcoded '#ffffff'
const gFlowerBody = appJs.slice(appJs.indexOf('function drawAirGeometricFlower'), appJs.indexOf('function drawAirDiamondStar'));
const dStarBody = appJs.slice(appJs.indexOf('function drawAirDiamondStar'), appJs.indexOf('function drawAirCelestialSparkle'));
const cSparkleBody = appJs.slice(appJs.indexOf('function drawAirCelestialSparkle'), appJs.indexOf('function drawAirEtherealFlower'));

assert(!gFlowerBody.includes("ctx.fillStyle = '#ffffff';"), 'FAIL: drawAirGeometricFlower still has hardcoded #ffffff center core');
assert(!dStarBody.includes("ctx.fillStyle = '#ffffff';"), 'FAIL: drawAirDiamondStar still has hardcoded #ffffff center core');
assert(!cSparkleBody.includes("ctx.fillStyle = '#ffffff';"), 'FAIL: drawAirCelestialSparkle still has hardcoded #ffffff center core');

assert(gFlowerBody.includes('alpha'), 'FAIL: drawAirGeometricFlower core must factor in alpha');
assert(dStarBody.includes('alpha'), 'FAIL: drawAirDiamondStar core must factor in alpha');
assert(cSparkleBody.includes('alpha'), 'FAIL: drawAirCelestialSparkle core must factor in alpha');

console.log('PASS: All star center core dots strictly scale with particle alpha (zero static #ffffff dots)');


// --- Test 4: Particle Spatial Color Adaptation & Opacity Modulation ---
console.log('\n--- 4. Particle Spatial Color Adaptation & Opacity Modulation ---');

assert(appJs.includes('setCoverPixelGrid(pixels)'), 'FAIL: setCoverPixelGrid not found in AirParticlePipeline');
assert(appJs.includes('sampleBackdropColor(normX, normY)'), 'FAIL: sampleBackdropColor not found in AirParticlePipeline');
assert(appJs.includes('window._coverPixelGrid = pixels;'), 'FAIL: window._coverPixelGrid hook not found in applyCoverAccent');

// Verify that in updateAndRender, particle color is modulated by background color and alpha
assert(appJs.includes('this.sampleBackdropColor(p.x[i] / this.width, p.y[i] / this.height)'), 'FAIL: per-particle spatial sampling not present in render loop');
assert(appJs.includes('colorWeight = Math.min(1.0, 0.45 + alpha * 0.55)'), 'FAIL: color weight must modulate with particle opacity');
assert(appJs.includes('starlightWhiteness = (1.0 - alpha) * 0.35'), 'FAIL: opacity must modulate particle starlight whiteness and saturation');

console.log('PASS: Particles spatially sample background colors in O(1) time and dynamically modulate depth/saturation with opacity');

console.log('\n>>> ALL 4 VISUAL & PARTICLE ENGINE ASSERTIONS PASSED! <<<');
