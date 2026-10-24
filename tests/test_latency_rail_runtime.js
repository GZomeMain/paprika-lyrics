const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

console.log('=== TEST SUITE: Latency Rail Runtime & Reset Verification ===');

// Setup mock browser environment
const domListeners = new Map();
const elements = new Map();

function createMockElement(id, tagName = 'div') {
  const el = {
    id,
    tagName: tagName.toUpperCase(),
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._classes.has(c)) this._classes.delete(c);
          else this._classes.add(c);
        } else if (force) {
          this._classes.add(c);
        } else {
          this._classes.delete(c);
        }
      },
      contains(c) { return this._classes.has(c); }
    },
    style: {
      setProperty: () => {},
      removeProperty: () => {},
      getPropertyValue: () => ''
    },
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    textContent: '',
    clientHeight: 100,
    clientWidth: 20,
    offsetWidth: 20,
    offsetHeight: 100,
    getBoundingClientRect() {
      return { top: 100, bottom: 200, left: 10, right: 30, height: 100, width: 20 };
    },
    closest(selector) {
      if (selector === '.sidebar-sync-slider-col') {
        return createMockElement('slider-col');
      }
      return null;
    },
    matches(selector) { return false; },
    querySelector(selector) { return null; },
    querySelectorAll(selector) { return []; },
    addEventListener(event, handler) {
      if (!this._events) this._events = {};
      if (!this._events[event]) this._events[event] = [];
      this._events[event].push(handler);
    },
    removeEventListener(event, handler) {
      if (!this._events || !this._events[event]) return;
      this._events[event] = this._events[event].filter(h => h !== handler);
    },
    dispatchEvent(event) {
      const type = event.type || event;
      if (this._events && this._events[type]) {
        this._events[type].forEach(h => h(event));
      }
    }
  };
  elements.set(id, el);
  return el;
}

// Ensure elements required by initLatencyRail exist
createMockElement('latency-rail');
createMockElement('sidebar-floating-tooltip');
createMockElement('latency-rail-minus');
createMockElement('latency-rail-plus');
createMockElement('latency-rail-arrow-up');
createMockElement('latency-rail-arrow-down');
createMockElement('sidebar-btn-rst');
createMockElement('latency-slider');
createMockElement('latency-slider-fill');
createMockElement('latency-slider-thumb');
createMockElement('latency-rail-value');
createMockElement('modal-latency-fader');
createMockElement('modal-fader-track');
createMockElement('modal-fader-knob');
createMockElement('modal-fader-fill');
createMockElement('sp-latency-channel');
createMockElement('sp-detent-indicator');
createMockElement('latency-display');
createMockElement('qp-latency');

const windowListeners = {};
const mockWindow = {
  innerWidth: 800,
  innerHeight: 600,
  addEventListener(event, handler) {
    if (!windowListeners[event]) windowListeners[event] = [];
    windowListeners[event].push(handler);
  },
  removeEventListener(event, handler) {
    if (!windowListeners[event]) return;
    windowListeners[event] = windowListeners[event].filter(h => h !== handler);
  },
  matchMedia: () => ({ matches: false }),
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (cb) => setTimeout(cb, 0)
};

const docElement = createMockElement('html', 'html');
docElement.style.setProperty = () => {};
docElement.style.getPropertyValue = () => '';

const mockDocument = {
  documentElement: docElement,
  body: createMockElement('body', 'body'),
  getElementById(id) {
    return elements.get(id) || null;
  },
  querySelector(sel) {
    if (sel.startsWith('#')) return elements.get(sel.slice(1)) || null;
    return null;
  },
  querySelectorAll() { return []; },
  createElement: (tag) => createMockElement('created-' + Math.random(), tag),
  addEventListener() {},
  removeEventListener() {}
};

// Create sandbox
const sandbox = {
  window: mockWindow,
  document: mockDocument,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  console,
  Math,
  parseInt,
  parseFloat,
  isNaN,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Date,
  Set,
  Map,
  JSON,
  performance: { now: () => Date.now() },
  localStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  }
};
sandbox.global = sandbox;
sandbox.window.window = mockWindow;
sandbox.window.document = mockDocument;
sandbox.window.performance = sandbox.performance;
sandbox.window.localStorage = sandbox.localStorage;

const code = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8');

// Run the script in VM context
console.log('1. Executing ui/app.js in VM...');
let errorOccurred = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
} catch (err) {
  errorOccurred = err;
}

assert.strictEqual(errorOccurred, null, `Script crashed on load: ${errorOccurred ? errorOccurred.stack : ''}`);
console.log('[PASS] ui/app.js executed without throwing any ReferenceError or TDZ crash!');

// 2. Verify window.renderLatencySlider is defined
assert.strictEqual(typeof sandbox.window.renderLatencySlider, 'function', 'window.renderLatencySlider must be a function');
console.log('[PASS] window.renderLatencySlider is properly registered on window');

// 3. Verify initial state (+800ms) is rendered
const valEl = elements.get('latency-rail-value');
assert.strictEqual(valEl.textContent, '+800ms', 'Default latency should display +800ms before reset');
console.log('[PASS] Default latency displays +800ms on startup');

// 4. Test clicking RST button
console.log('2. Testing RST button click...');
const rstBtn = elements.get('sidebar-btn-rst');
assert(rstBtn._events && rstBtn._events['click'], 'RST button must have click listener attached');
rstBtn.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });

function getLatencyOffset() {
  return vm.runInContext('latencyOffsetMs', sandbox);
}

assert.strictEqual(getLatencyOffset(), 0, 'latencyOffsetMs must be reset to 0 after clicking RST');
assert.strictEqual(valEl.textContent, '0ms', `latency readout must display 0ms after RST, got ${valEl.textContent}`);
console.log('[PASS] RST button successfully reset latency to 0ms');

// 5. Test + / - nudge buttons
console.log('3. Testing + / - nudge buttons...');
const plusBtn = elements.get('latency-rail-plus');
const minusBtn = elements.get('latency-rail-minus');
assert(plusBtn._events && plusBtn._events['pointerdown'], 'plus button must have pointerdown handler');
assert(minusBtn._events && minusBtn._events['pointerdown'], 'minus button must have pointerdown handler');

plusBtn.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, preventDefault() {} });
assert.strictEqual(getLatencyOffset(), 50, 'Latency should increase by +50ms');
assert.strictEqual(valEl.textContent, '+50ms', 'Readout should show +50ms');

minusBtn.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, preventDefault() {} });
assert.strictEqual(getLatencyOffset(), 0, 'Latency should decrease back to 0ms');
assert.strictEqual(valEl.textContent, '0ms', 'Readout should show 0ms');
console.log('[PASS] Plus and Minus nudge buttons adjust latency correctly');

// 6. Test fine arrow buttons (+10 / -10)
console.log('4. Testing fine arrow buttons (+10 / -10)...');
const arrowUp = elements.get('latency-rail-arrow-up');
const arrowDown = elements.get('latency-rail-arrow-down');
arrowUp.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, preventDefault() {} });
assert.strictEqual(getLatencyOffset(), 10, 'Latency should increase by +10ms');
assert.strictEqual(valEl.textContent, '+10ms', 'Readout should show +10ms');

arrowDown.dispatchEvent({ type: 'pointerdown', pointerType: 'mouse', button: 0, preventDefault() {} });
assert.strictEqual(getLatencyOffset(), 0, 'Latency should decrease by -10ms');
assert.strictEqual(valEl.textContent, '0ms', 'Readout should show 0ms');
console.log('[PASS] Arrow up and down fine buttons adjust latency correctly');

// 7. Test double click on slider to reset to 0
console.log('5. Testing double click on slider...');
sandbox.window.adjustLatency(350);
assert.strictEqual(getLatencyOffset(), 350);
const slider = elements.get('latency-slider');
assert(slider._events && slider._events['dblclick'], 'slider must have dblclick handler');
slider.dispatchEvent({ type: 'dblclick', preventDefault() {}, stopPropagation() {} });
assert.strictEqual(getLatencyOffset(), 0, 'Double clicking slider must reset latency to 0ms');
assert.strictEqual(valEl.textContent, '0ms');
console.log('[PASS] Double clicking slider successfully resets latency to 0ms');

// 8. Test double click on value display to reset to 0
console.log('6. Testing double click on value display...');
sandbox.window.adjustLatency(-200);
assert.strictEqual(getLatencyOffset(), -200);
assert.strictEqual(valEl.textContent, '-200ms');
valEl.dispatchEvent({ type: 'dblclick', preventDefault() {}, stopPropagation() {} });
assert.strictEqual(getLatencyOffset(), 0, 'Double clicking readout must reset latency to 0ms');
assert.strictEqual(valEl.textContent, '0ms');
console.log('[PASS] Double clicking value readout successfully resets latency to 0ms');

// 9. Test dragging slider with 0ms magnetic snap
console.log('7. Testing dragging slider and magnetic detent snap...');
// clientY = 150 is the exact center (0ms).
// clientY = 150.3 -> frac = 1 - 50.3/100 = 0.497 -> rawTarget = -18ms -> snaps to 0ms (< 35ms)
slider.dispatchEvent({
  type: 'pointerdown',
  pointerType: 'mouse',
  button: 0,
  clientY: 150.3,
  preventDefault() {},
  stopPropagation() {}
});
assert.strictEqual(getLatencyOffset(), 0, 'Dragging near center should magnetically snap to 0ms');
console.log('[PASS] Magnetic detent snap at 0ms functions during slider drag');

// Dragging higher up (clientY = 120 -> frac = 1 - (120-100)/100 = 0.8 -> target = -3000 + 0.8 * 6000 = +1800ms)
slider.dispatchEvent({
  type: 'pointerdown',
  pointerType: 'mouse',
  button: 0,
  clientY: 120,
  preventDefault() {},
  stopPropagation() {}
});
assert.strictEqual(getLatencyOffset(), 1800, 'Dragging to clientY 120 should yield +1800ms');
assert.strictEqual(valEl.textContent, '+1800ms');
console.log('[PASS] Slider drag correctly calculates and updates latency in real-time');

// Release drag
if (windowListeners['pointerup']) {
  windowListeners['pointerup'].forEach(h => h({ type: 'pointerup', preventDefault() {} }));
}

console.log('\n>>> ALL RUNTIME LATENCY RAIL & RESET TESTS PASSED! <<<');
