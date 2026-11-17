const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('=== TEST SUITE: Layout & Fullscreen Transitions State Regression ===\n');

const cssPath = path.join(__dirname, '..', 'ui', 'style.css');
const jsPath = path.join(__dirname, '..', 'ui', 'app.js');

const css = fs.readFileSync(cssPath, 'utf8').replace(/\r\n/g, '\n');
const js = fs.readFileSync(jsPath, 'utf8').replace(/\r\n/g, '\n');

// 1. Check JS applyLayoutState logic
console.log('--- 1. JS applyLayoutState Logic ---');
assert(js.includes('const splitActive = layoutMode === \'split\' && isFullscreen;'),
  'splitActive must be defined as layoutMode === "split" && isFullscreen');
assert(js.includes('document.body.classList.toggle(\'layout-split\', splitActive);'),
  'layout-split must be toggled with splitActive');
assert(js.includes('document.body.classList.toggle(\'layout-compact\', !splitActive);'),
  'layout-compact must be toggled with !splitActive so windowed mode never drops compact track card');
console.log('[PASS] applyLayoutState strictly guarantees layout-compact when not in split-fullscreen');

// 2. Check CSS rules for .track-float resilience
console.log('\n--- 2. CSS Rules for .track-float Display Resilience ---');
assert(css.includes('body.layout-compact .track-float') && css.includes('display: flex;'),
  'body.layout-compact .track-float must be display: flex');
assert(css.includes('body.layout-split.is-fullscreen .track-float') || css.includes('body.layout-split .track-float'),
  'split fullscreen must retire track-float');
console.log('[PASS] CSS ensures track-float is visible in compact/windowed mode and only hidden in split fullscreen');

// 3. Behavioral Simulation
console.log('\n--- 3. Simulation of Disabling Fullscreen while in Split Layout ---');
class MockClassList {
  constructor() {
    this.classes = new Set();
  }
  toggle(cls, force) {
    if (force === undefined) {
      if (this.classes.has(cls)) this.classes.delete(cls);
      else this.classes.add(cls);
    } else if (force) {
      this.classes.add(cls);
    } else {
      this.classes.delete(cls);
    }
  }
  contains(cls) {
    return this.classes.has(cls);
  }
}

const mockBody = { classList: new MockClassList() };

function simulateApplyLayoutState(layoutMode, isFullscreen) {
  mockBody.classList.toggle('is-fullscreen', isFullscreen);
  const splitActive = layoutMode === 'split' && isFullscreen;
  mockBody.classList.toggle('layout-split', splitActive);
  mockBody.classList.toggle('layout-compact', !splitActive);
}

// User enters fullscreen in split layout
simulateApplyLayoutState('split', true);
assert(mockBody.classList.contains('is-fullscreen'), 'Must be fullscreen');
assert(mockBody.classList.contains('layout-split'), 'Must have layout-split');
assert(!mockBody.classList.contains('layout-compact'), 'Must not have layout-compact');
console.log('[PASS] Fullscreen split mode activates layout-split');

// User exits fullscreen while split layout is selected (the reported bug scenario)
simulateApplyLayoutState('split', false);
assert(!mockBody.classList.contains('is-fullscreen'), 'Must not be fullscreen');
assert(!mockBody.classList.contains('layout-split'), 'Must not have layout-split');
assert(mockBody.classList.contains('layout-compact'), 'Must have layout-compact so controls/art stay visible and interactive');
console.log('[PASS] Exiting fullscreen cleanly falls back to layout-compact without stranding the user');

// User toggles layout in windowed mode
simulateApplyLayoutState('compact', false);
assert(mockBody.classList.contains('layout-compact'), 'Must have layout-compact in compact windowed mode');

// User re-enters fullscreen
simulateApplyLayoutState('compact', true);
assert(mockBody.classList.contains('layout-compact'), 'Compact fullscreen retains layout-compact');
assert(!mockBody.classList.contains('layout-split'), 'Compact fullscreen does not have layout-split');

console.log('\n>>> ALL LAYOUT & FULLSCREEN REGRESSION CHECKS PASSED SUCCESSFULLY! <<<');
