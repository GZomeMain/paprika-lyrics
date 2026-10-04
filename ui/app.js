// Synchronized strictly with config.py DEFAULT_LATENCY_MS
const DEFAULT_LATENCY_MS = 800;

let isPlaying = false;
let renderLoopActive = false;
let playheadMs = 0;
let latencyOffsetMs = DEFAULT_LATENCY_MS;
let lastTick = performance.now();
let lyrics = [];
let lyricDom = [];
let currentTrackKey = "";

let targetDriftMs = 0;

// Wall-clock anchored playhead. The position is derived from an anchor plus a
// decaying drift correction, so an irregular/stalled animation frame can never
// teleport the wipe forward (which read as stutter + "finishes the word too fast").
let anchorPosMs = 0;
let anchorWallMs = 0;

// Words separated by a short breath are joined so the wipe keeps gliding instead
// of parking at 100% while it waits for the next syllable to begin.
const MAX_GAP_BRIDGE_MS = 700;

function predictedPlayhead() {
  return anchorPosMs + (performance.now() - anchorWallMs) + targetDriftMs;
}

// Motion style + chorus detection state live up here because syncSettingsPanel()
// runs at boot, before the variant engine further down is initialized.
const MOTION_STYLES = ['auto', 'subtle', 'lively', 'wild'];
let motionStyle = 'auto';
let chorusCount = 0;

// =========================================================
// Persistent settings (single helpers)
// =========================================================
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

// =========================================================
// Global hotkey binding state
// Ctrl+[ / Ctrl+] are registered system-wide by the Python host AND handled
// below in-window. RegisterHotKey does not consume the keystroke, so when the
// overlay was focused both fired and every nudge applied twice. The host now
// reports which shortcuts actually bound; when the global sync hotkey is live
// we leave the keys to it, and only fall back to in-window handling when the
// registration failed (another app owns the shortcut).
// =========================================================
let globalHotkeysBound = false;

function refreshHotkeyBinding() {
  const api = window.pywebview && window.pywebview.api;
  if (!api || !api.get_hotkey_binding) return;
  Promise.resolve(api.get_hotkey_binding())
    .then((binding) => { globalHotkeysBound = !!(binding && binding.sync); })
    .catch(() => {});
}
refreshHotkeyBinding();
window.addEventListener('pywebviewready', refreshHotkeyBinding);
// Safety net for the rare case where the bridge injects late.
setTimeout(refreshHotkeyBinding, 1200);

// =========================================================
// View cross-fade
// A track change used to hard-replace the whole lyric tree behind a spinner.
// The old view now fades out and the new one fades in, so a song change reads
// as a transition instead of a flash.
// =========================================================
const VIEW_FADE_MS = 260;
let viewFadeTimer = null;
let viewFadeSafety = null;

function cancelViewFade() {
  if (viewFadeTimer) {
    clearTimeout(viewFadeTimer);
    viewFadeTimer = null;
  }
  if (viewFadeSafety) {
    clearTimeout(viewFadeSafety);
    viewFadeSafety = null;
  }
}

function setViewOpacity(value) {
  if (container) container.style.opacity = value;
}

function fadeOutView(onHidden) {
  cancelViewFade();
  setViewOpacity('0');
  viewFadeTimer = setTimeout(() => {
    viewFadeTimer = null;
    onHidden();
  }, VIEW_FADE_MS);
}

function fadeInView() {
  // Cancels a pending fade-out so a fast (cached) swap can never be wiped by it.
  cancelViewFade();
  setViewOpacity('0');
  if (!container) return;
  requestAnimationFrame(() => requestAnimationFrame(() => setViewOpacity('1')));
  // Safety net: an un-composited webview can throttle rAF, which would leave the
  // lyrics stuck at opacity 0. Force the end state either way.
  viewFadeSafety = setTimeout(() => {
    viewFadeSafety = null;
    setViewOpacity('1');
  }, 140);
}

// =========================================================
// Apple-Style Damped Spring Physics Solver
// =========================================================
let currentScrollY = 0;
let targetScrollY = 0;
let scrollVelocity = 0;
const SPRING_K = 145; // Stiffness
const SPRING_D = 23;  // Damping
const SPRING_M = 1.0; // Mass

let activeLineIdx = -1;
let lastActiveSig = "";
let lastPartingLine = -1; // line currently carrying has-growing (so it clears when active moves on)
let userScrolledRecently = false;
let userScrollTimer = null;
let lastDisplayedSecond = -1;
let lastRenderEnd = 0;
let latencySaveTimer = null;

const container = document.getElementById('lyrics-container');
// One play glyph per mode, each with its own transport row: the card's on-art
// row and the split panel's art row.
const playBtns = [
  document.getElementById('art-tp-play'),
  document.getElementById('side-tp-play'),
].filter(Boolean);
// NOTE: the old #latency-bar / #latency-label elements were removed from the
// DOM when the latency rail and settings page replaced them; the guarded
// lookups that used to sit here went with them.

// =========================================================
// Lyric font selection (configurable, no CSS editing required)
// =========================================================
const FONT_STACKS = {
  apple: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
  barriecito: "'Barriecito', cursive, sans-serif"
};
// The sans stack is the default: it is readable at every tempo and has real
// multi-script glyph coverage. Barriecito is a decorative display face whose
// CJK/Cyrillic/Arabic fall back to a mismatched system font mid-line, so it is
// the option, not the default. An existing saved preference still wins.
let lyricFontName = 'apple';
function applyFont(name) {
  lyricFontName = FONT_STACKS[name] ? name : 'apple';
  document.documentElement.style.setProperty('--lyric-font-family', FONT_STACKS[lyricFontName]);
  // Barriecito is naturally thick at weight 400; the sans needs 700.
  document.documentElement.style.setProperty('--lyric-font-weight', lyricFontName === 'barriecito' ? '400' : '700');
  Settings.set('font', lyricFontName);
  // Glyph widths change with the family, so the sweep distances must be remeasured.
  rebuildLineMotion();
  // The card's title/artist metrics move the clearance the lyrics must keep.
  syncLyricsClearance();
  syncSettingsPanel();
}

function cycleFont() {
  applyFont(lyricFontName === 'barriecito' ? 'apple' : 'barriecito');
}

// =========================================================
// Top clearance for the lyric scroller
// The floating track card is painted over the lyrics, so the mask that fades
// the top of the list has to end below the card — otherwise glyphs scroll up
// through it and the lyrics look like they are bleeding into the header. The
// card's height depends on the title (it wraps), the lyric font, fullscreen
// scaling and the art-hover parting, so measure its real bottom rather than
// hard-coding a distance that only suits one window size.
// =========================================================
const BASE_FADE_TOP = 70;        // matches the stylesheet's default --lyrics-fade-top
const FADE_CLEARANCE_MARGIN = 12;

function syncLyricsClearance() {
  if (!container) return;
  const floatEl = document.getElementById('track-float');
  if (!floatEl || getComputedStyle(floatEl).display === 'none') {
    // No card over the lyrics (split layout): the stylesheet default is right.
    container.style.removeProperty('--lyrics-fade-top');
    return;
  }
  const cardBottom = floatEl.getBoundingClientRect().bottom;
  const listTop = container.getBoundingClientRect().top;
  const fade = Math.max(BASE_FADE_TOP, Math.ceil(cardBottom - listTop) + FADE_CLEARANCE_MARGIN);
  container.style.setProperty('--lyrics-fade-top', `${fade}px`);
}

// =========================================================
// Fullscreen & layout modes
// layout: 'compact' | 'split'. Split needs the room of fullscreen; if selected
// while windowed it is remembered but only applies once fullscreen.
// Compact is the default and only other windowed layout.
// =========================================================
const LAYOUTS = ['compact', 'split'];
let isFullscreen = false;
let layoutMode = 'compact';

// ---------------------------------------------------------
// Window dragging
//
// One handler, one rule: a mousedown inside a [data-drag] surface moves the
// window, unless something on the way up is [data-no-drag] — the seek bar, the
// transport, the on-art buttons. The gesture itself is native
// (core.native_window.begin_drag): the operating system's own window move, with
// Aero Snap and per-monitor DPI, which nothing in the page can shadow.
//
// pywebview's own drag is deliberately not used. It moved the window from
// JavaScript — a body-level walk-up over `.pywebview-drag-region` ancestors plus
// a bridge message per mousemove — so the stylesheet's
// `-webkit-app-region: no-drag` never participated: a mousedown on the card's
// seek bar dragged the card away instead of seeking, and while fullscreen the
// overlay could still be torn off the monitor. No element carries that class any
// more (tools/ui-preview-regression.js asserts it stays that way).
// ---------------------------------------------------------
let dragSurfacesEnabled = true;

function syncWindowDrag() {
  // A fullscreen surface is fixed: the gesture is refused wholesale.
  dragSurfacesEnabled = !isFullscreen;
}

function initWindowDrag() {
  // Capture phase: a control that stops propagation on mousedown must not be
  // able to leave the window glued in place.
  document.addEventListener('mousedown', (event) => {
    if (event.button !== 0 || !dragSurfacesEnabled) return;
    // A double-click is a click, not a drag. Windows turns a caption double-click
    // into a maximise, which an overlay never wants.
    if (event.detail > 1) return;
    const target = event.target;
    if (!target || !target.closest) return;
    if (target.closest('[data-no-drag]')) return;
    if (!target.closest('[data-drag]')) return;
    const api = window.pywebview && window.pywebview.api;
    if (api && api.begin_drag) api.begin_drag();
  }, true);
}

function applyLayoutState() {
  document.body.classList.toggle('is-fullscreen', isFullscreen);
  document.body.classList.toggle('layout-compact', layoutMode === 'compact');
  // Split needs the room of fullscreen: windowed it stays selected but renders
  // as normal, so the float/header only change when it is actually active.
  const splitActive = layoutMode === 'split' && isFullscreen;
  document.body.classList.toggle('layout-split', splitActive);
  document.body.classList.remove('layout-split-suppressed');
  // Switching layout takes one art wrap out of the rendering tree and puts the
  // other in, which fires no mouseleave for the one that left: the on-art layout
  // button sits ON the sleeve, so leaning it and then clicking that button is two
  // clicks. The lean is released here, exactly as applyMiniState releases it.
  resetTilt();
  // A fullscreen overlay is a fixed surface: the move gesture is refused while
  // it is up.
  syncWindowDrag();
  Settings.set('layout', layoutMode);
  Settings.set('fullscreen', isFullscreen ? '1' : '0');
  syncArtControls();
  syncLyricsClearance();
  // The active-line anchor point moves with the layout; recentre on the current line.
  if (activeLineIdx >= 0 && lyricDom[activeLineIdx]) {
    scrollToActiveCluster([activeLineIdx]);
  }
  syncSettingsPanel();
}

function cycleLayout() {
  const idx = LAYOUTS.indexOf(layoutMode);
  layoutMode = LAYOUTS[(idx + 1) % LAYOUTS.length];
  applyLayoutState();
}

function setFullscreen(on) {
  wakeRenderLoop();   // layout transitions animate the scroller
  isFullscreen = !!on;
  applyLayoutState();
  syncArtControls();
  // The mode decides the alpha, and this is where the mode changes: fullscreen is
  // the one state that refuses transparency, so re-deriving here restores the
  // user's opacity the moment they leave it.
  applyWindowOpacity();
  scheduleCursorHide();
}

// =========================================================
// Floating track info (compact & split): lyrics part downwards while the art
// is hovered so the grown art never covers the title of the playing track.
// =========================================================
let artHoverTimer = null;

function initFloatArt() {
  const wrap = document.getElementById('float-art-wrap');
  if (!wrap) return;
  wrap.addEventListener('mouseenter', () => {
    clearTimeout(artHoverTimer);
    document.body.classList.add('art-hover');
    syncLyricsClearance();
  });
  wrap.addEventListener('mouseleave', () => {
    // Small delay so a stray mouse jitter doesn't yo-yo the lyrics.
    clearTimeout(artHoverTimer);
    artHoverTimer = setTimeout(() => {
      document.body.classList.remove('art-hover');
      syncLyricsClearance();
    }, 120);
  });
  // The art grows over a transition, so re-measure once the card has settled.
  wrap.addEventListener('transitionend', syncLyricsClearance);
}

// Mirrors fullscreen state onto the on-art buttons: the active look, and which
// of the window-mode controls exist at all. `data-when` in the markup is the one
// declaration of that (the exit button is fullscreen-only, the fullscreen and
// mini buttons are windowed-only), so the compact row and the split panel's row
// cannot drift apart.
function syncArtControls() {
  // Compact is 'off', split 'on' — a second read of which layout is active.
  const splitActive = document.body.classList.contains('layout-split');
  const layoutBtn = document.getElementById('art-btn-layout');
  if (layoutBtn) layoutBtn.classList.toggle('is-on', splitActive);
  const sideLayoutBtn = document.getElementById('side-btn-layout');
  if (sideLayoutBtn) sideLayoutBtn.classList.toggle('is-on', splitActive);

  document.querySelectorAll('.art-controls .art-btn[data-when]').forEach((btn) => {
    const wantsFullscreen = btn.dataset.when === 'fullscreen';
    btn.classList.toggle('is-hidden', wantsFullscreen !== isFullscreen);
  });
}

// =========================================================
// Always on top
// =========================================================
let alwaysOnTop = false; // default off; the saved value is read below

// A user action: it is the preference, so it is persisted and pushed to the host.
function applyAlwaysOnTop() {
  Settings.set('ontop', alwaysOnTop ? '1' : '0');
  syncAlwaysOnTopUI();
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_always_on_top) {
    window.pywebview.api.set_always_on_top(alwaysOnTop);
  }
}

function syncAlwaysOnTopUI() {
  document.body.classList.toggle('is-ontop', alwaysOnTop);
  syncSettingsPanel();
}

// The host changes always-on-top on its own: the mini player pins the window on
// top — a lyrics strip that sinks behind the browser the user just clicked is
// useless — and restores the user's preference on the way out. Mirroring the
// result into the UI keeps the settings row honest, and it is deliberately not
// written to storage or pushed back to the host: a forced pin must never
// overwrite the preference it is standing in for.
window.setAlwaysOnTop = function (on) {
  alwaysOnTop = !!on;
  syncAlwaysOnTopUI();
};

// The bridge is injected after the page loads, so the first apply has to wait
// for it — otherwise the saved setting would not take effect until toggled.
function applyAlwaysOnTopWhenReady() {
  if (window.pywebview && window.pywebview.api) {
    applyAlwaysOnTop();
    return;
  }
  window.addEventListener('pywebviewready', () => applyAlwaysOnTop());
}

function toggleAlwaysOnTop() {
  alwaysOnTop = !alwaysOnTop;
  applyAlwaysOnTop();
}

function toggleFullscreen() {
  // The two are mutually exclusive modes of one window: fullscreen covers the
  // whole monitor, so it is always entered from the normal windowed state.
  if (miniMode && !isFullscreen) setMiniMode(false);
  if (window.pywebview && window.pywebview.api && window.pywebview.api.toggle_fullscreen) {
    window.pywebview.api.toggle_fullscreen().then((state) => setFullscreen(!!state));
  } else {
    // Browser/dev fallback: no native window, just scale the layout.
    setFullscreen(!isFullscreen);
  }
}

// =========================================================
// Mini player (lyrics only)
// A windowed mode of this same surface rather than a second window: the overlay
// exists to show one source's lyrics, and a separate window would need its own
// copy of the whole sync pipeline (track pushes, playhead, latency) to show the
// same song. So mini is a body class plus a resize, and the host owns the
// geometry — the size to restore, and the 320x380..900x1200 range it will not
// leave. The state it answers with is the source of truth, not what we asked for.
// =========================================================
let miniMode = false;

function applyMiniState() {
  document.body.classList.toggle('mini', miniMode);
  setMiniBarRevealed(false);   // every entry starts as pure lyrics
  resetTilt();                 // the card is going away; its lean goes with it
  syncWindowDrag();   // the mini bar is a drag surface too
  syncLyricsClearance();
  wakeRenderLoop();   // entering/leaving mini animates the scroller's padding
}

function setMiniMode(on) {
  const wants = !!on;
  if (wants === miniMode) return;
  miniMode = wants;
  applyMiniState();
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_mini_mode) {
    Promise.resolve(api.set_mini_mode(wants)).then((state) => {
      if (typeof state === 'boolean' && state !== miniMode) {
        miniMode = state;
        applyMiniState();
      }
    }).catch(() => {});
  }
}

function toggleMiniMode() {
  setMiniMode(!miniMode);
}

// The mini bar hides itself. A lyrics-only window should be lyrics and nothing
// else, so the buttons slide in only when the pointer reaches the top band, and
// away again when it drops below it. The drag surface behind them stays live the
// whole time: hidden chrome must never mean an unmovable window.
const MINI_BAR_REVEAL_PX = 64;

function setMiniBarRevealed(on) {
  document.body.classList.toggle('bar-revealed', !!on);
}

// =========================================================
// Card position (windowed compact layout)
// The card sits at the window's left gutter by default, level with the lyrics
// under it, and can be centred for anyone who prefers the sleeve floating over
// the middle. Either way the title and artist stay left-aligned inside the card:
// centring wrapped text beneath a square sleeve makes both lines shift on every
// re-wrap, which is the flaw in the reference look this started from.
// =========================================================
const CARD_POSITIONS = ['left', 'center'];
let cardPosition = 'left';

function applyCardPosition() {
  document.body.classList.toggle('card-center', cardPosition === 'center');
  Settings.set('cardPosition', cardPosition);
  syncLyricsClearance();
  syncSettingsPanel();
}

function cycleCardPosition() {
  const idx = CARD_POSITIONS.indexOf(cardPosition);
  cardPosition = CARD_POSITIONS[(idx + 1) % CARD_POSITIONS.length];
  applyCardPosition();
}

// =========================================================
// Window transparency
// One value in two parts. The BASE opacity is what the user picked and applies
// the whole time the overlay is windowed — the mini player and click-through
// included, because a see-through overlay you can click through is the point of
// both. The hover dip takes it a little further down while the pointer is over
// the overlay, and stands down the moment the pointer leaves or Ctrl is held.
//
// Fullscreen is the one mode that refuses transparency: there the overlay covers
// the monitor the user is looking at, and dimming the screen is not
// transparency, it is a bug. Click-through is the other edge: it takes the
// pointer events away from this page, so the one fact the dip needs has to come
// from the host's own probe instead (see setHoverFadeInside) — the dip still
// applies, it is just observed on the other side of the bridge.
//
// The host owns the mechanism (core.native_window.set_window_alpha makes the
// window a layered one, so content, artwork and glass fade as one surface); the
// policy lives here, because every input that decides it — the setting, the
// pointer, Ctrl, click-through, fullscreen — is in this file.
// =========================================================
const OPACITY_LEVELS = [1, 0.95, 0.9, 0.8, 0.7, 0.6];
const OPACITY_LABELS = ['Off', '95%', '90%', '80%', '70%', '60%'];
const HOVER_FADE_LEVELS = ['off', 'light', 'clear'];
const HOVER_FADE_LABELS = { off: 'Off', light: 'Light', clear: 'Clear' };
const HOVER_FADE_ALPHA = { light: 0.86, clear: 0.7 };
let opacityIndex = 0;        // index into OPACITY_LEVELS; 0 is fully opaque
let hoverFade = 'off';
let hoverFadeInside = false;
let hoverFadeCtrl = false;
let appliedAlpha = 1;        // what the host was last asked for

function windowOpacityValue() {
  return OPACITY_LEVELS[opacityIndex] || 1;
}

function windowAlphaTarget() {
  if (isFullscreen) return 1;
  const base = windowOpacityValue();
  // The settings sheet is text being read: the pointer being over it is not a
  // reason to dim the thing being read.
  if (document.body.classList.contains('settings-open')) return base;
  // hoverFadeInside is fed by this page's own pointer events, or — while
  // click-through takes them away — pushed by the host's pointer probe. Either
  // way it is the same fact about the pointer, so the dip needs no click-through
  // special case of its own.
  if (hoverFade === 'off' || !hoverFadeInside || hoverFadeCtrl) return base;
  return Math.min(base, HOVER_FADE_ALPHA[hoverFade] || base);
}

function applyWindowOpacity() {
  const target = windowAlphaTarget();
  if (Math.abs(target - appliedAlpha) < 0.001) return;
  appliedAlpha = target;
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_window_alpha) api.set_window_alpha(target);
}

function cycleWindowOpacity() {
  opacityIndex = (opacityIndex + 1) % OPACITY_LEVELS.length;
  Settings.set('opacity', String(opacityIndex));
  // The pointer is on the row that was just clicked, so the window changes under
  // it immediately — which is the whole point of a transparency setting.
  applyWindowOpacity();
  syncSettingsPanel();
}

function cycleHoverFade() {
  const idx = HOVER_FADE_LEVELS.indexOf(hoverFade);
  hoverFade = HOVER_FADE_LEVELS[(idx + 1) % HOVER_FADE_LEVELS.length];
  Settings.set('hoverFade', hoverFade);
  // The host only polls the pointer when there is a dip to feed, so it is told
  // which way the setting just went.
  pushHoverFadeSetting();
  applyWindowOpacity();
  syncSettingsPanel();
}

// The host's answer to a question this page cannot ask while click-through is on:
// with WS_EX_TRANSPARENT the window receives no mouse messages, so the host reads
// the pointer against the window rect and pushes it here (paprika_app._hover_probe).
window.setHoverFadeInside = function (inside) {
  hoverFadeInside = !!inside;
  applyWindowOpacity();
};

// The host needs to know whether a dip is switched on before it polls for one.
function pushHoverFadeSetting() {
  const api = window.pywebview && window.pywebview.api;
  if (api && api.set_hover_fade) api.set_hover_fade(hoverFade !== 'off');
}

// The bridge is injected after the page loads, so the first report has to wait for
// it — otherwise a saved dip would not be polled for until it was toggled.
function pushHoverFadeSettingWhenReady() {
  if (window.pywebview && window.pywebview.api) {
    pushHoverFadeSetting();
    return;
  }
  window.addEventListener('pywebviewready', () => pushHoverFadeSetting());
}

// Whether the effect is on and whether the pointer is inside are two different
// questions, and only the second one changes hundreds of times a session. The
// listeners below feed it, and each one re-evaluates the derived state instead of
// pushing alpha per event (applyWindowOpacity returns early when nothing changed).
function initHoverFade() {
  const doc = document.documentElement;
  doc.addEventListener('mouseenter', () => {
    hoverFadeInside = true;
    applyWindowOpacity();
  });
  doc.addEventListener('mouseleave', () => {
    hoverFadeInside = false;
    hoverFadeCtrl = false;   // a lost pointer has no modifier state
    applyWindowOpacity();
  });
  // A webview whose mouseleave never arrived (the pointer can leave while the
  // page keeps its focus) also loses the window's focus.
  window.addEventListener('blur', () => {
    hoverFadeInside = false;
    hoverFadeCtrl = false;
    applyWindowOpacity();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control') { hoverFadeCtrl = true; applyWindowOpacity(); }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control') { hoverFadeCtrl = false; applyWindowOpacity(); }
  });
  // Ctrl can also be pressed or released while another window holds the keyboard
  // focus, so the modifier is read off the move as well: a pointer over the
  // overlay IS the inside signal, and the state cannot get stuck either way.
  document.addEventListener('mousemove', (e) => {
    const ctrl = !!e.ctrlKey;
    if (!hoverFadeInside || ctrl !== hoverFadeCtrl) {
      hoverFadeInside = true;
      hoverFadeCtrl = ctrl;
      applyWindowOpacity();
    }
  });
}

// The mini bar's own pointer listener, kept separate from the fade's: this one
// reads the pointer's height and only ever matters while mini is on.
function initPointerChrome() {
  document.addEventListener('mousemove', (e) => {
    if (miniMode) setMiniBarRevealed(e.clientY <= MINI_BAR_REVEAL_PX);
  });
  document.addEventListener('mouseleave', () => setMiniBarRevealed(false));
  window.addEventListener('blur', () => setMiniBarRevealed(false));
}

// A fullscreen overlay is something you look at, so the pointer stops being
// useful once it holds still — after two seconds it hides, and the first
// movement brings it straight back. That is what every fullscreen player does,
// and it is the difference between "a big window" and a surface meant to be
// watched. Windowed it stays visible: there the pointer is how the app is used.
const CURSOR_IDLE_MS = 2000;
let cursorIdleTimer = null;

function scheduleCursorHide() {
  clearTimeout(cursorIdleTimer);
  // Any movement shows the pointer again immediately: hiding a parked cursor is
  // an idle timeout, and a timeout that only ever turns the cursor off is a
  // pointer the user cannot get back without leaving fullscreen.
  document.body.classList.remove('cursor-hidden');
  // Never hide it while something is being read or dragged with it — the
  // settings sheet, a seek and a resize all want the pointer on screen.
  if (!isFullscreen || document.body.classList.contains('settings-open') ||
      document.body.classList.contains('seeking') ||
      document.body.classList.contains('resizing')) {
    return;
  }
  cursorIdleTimer = setTimeout(() => document.body.classList.add('cursor-hidden'), CURSOR_IDLE_MS);
}

function initCursorIdle() {
  document.addEventListener('mousemove', scheduleCursorHide, { passive: true });
  document.addEventListener('mouseleave', () => {
    clearTimeout(cursorIdleTimer);
    document.body.classList.remove('cursor-hidden');
  });
  window.addEventListener('blur', () => document.body.classList.remove('cursor-hidden'));
}

// =========================================================
// Translations / transliteration (spec: subordinate metadata layer)
// =========================================================
let showSecondary = true;

function applySecondaryVisibility() {
  if (container) container.classList.toggle('hide-secondary', !showSecondary);
  syncSettingsPanel();
}

function toggleTranslations() {
  showSecondary = !showSecondary;
  Settings.set('secondary', showSecondary ? '1' : '0');
  applySecondaryVisibility();
}

// =========================================================
// Quick settings panel: the one collapsed entry point for
// sync, bottom bar, translations, and font.
// =========================================================
function nudgeLatency(deltaMs) {
  window.adjustLatency(deltaMs);
}

// Writes text only when it actually changed, and pulses it once — so a setting
// that flips gives visible feedback instead of silently swapping a word.
function setValueText(el, text) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  el.classList.remove('value-flash');
  void el.offsetWidth; // restart the animation if it is already running
  el.classList.add('value-flash');
}

function updateLatencyUI() {
  const txt = `${latencyOffsetMs > 0 ? '+' : ''}${latencyOffsetMs}ms`;
  setValueText(document.getElementById('qp-latency'), txt);
  setValueText(document.getElementById('latency-rail-value'), txt);
  if (window.renderLatencySlider) window.renderLatencySlider();
}

function syncSettingsPanel() {
  setValueText(document.querySelector('#qp-trans .qp-state'), showSecondary ? 'On' : 'Off');
  setValueText(document.querySelector('#qp-font .qp-state'), lyricFontName === 'barriecito' ? 'Barriecito' : 'Apple');
  setValueText(document.querySelector('#qp-motion .qp-state'), reducedMotion ? 'Reduced' : 'Full');
  setValueText(document.getElementById('qp-motion-style-state'), motionStyle.charAt(0).toUpperCase() + motionStyle.slice(1));
  setValueText(document.getElementById('qp-beat-state'), BEAT_LABELS[beatMode] || 'Subtle');
  setValueText(document.getElementById('qp-moments-state'), MOMENT_LABELS[momentsMode] || 'Subtle');
  setValueText(document.getElementById('qp-ambient-state'), AMBIENT_LABELS[ambientMode] || 'Subtle');
  setValueText(document.getElementById('qp-tilt-state'), TILT_LABELS[tiltMode] || 'Subtle');
  setValueText(document.querySelector('#qp-clickthrough .qp-state'), clickThrough ? 'On' : 'Off');
  setValueText(document.getElementById('qp-layout-state'),
    layoutMode === 'compact' ? 'Compact' : (isFullscreen ? 'Split' : 'Split (needs FS)'));
  setValueText(document.getElementById('qp-align-state'),
    lyricAlign.charAt(0).toUpperCase() + lyricAlign.slice(1));
  setValueText(document.getElementById('qp-fs-state'), isFullscreen ? 'On' : 'Off');
  setValueText(document.getElementById('qp-ontop-state'), alwaysOnTop ? 'On' : 'Off');
  setValueText(document.getElementById('qp-card-position-state'),
    cardPosition === 'center' ? 'Center' : 'Left');
  setValueText(document.getElementById('qp-hover-fade-state'), HOVER_FADE_LABELS[hoverFade] || 'Off');
  setValueText(document.getElementById('qp-opacity-state'), OPACITY_LABELS[opacityIndex] || 'Off');
  updateLatencyUI();
  renderDiagnostics();
}

// =========================================================
// Motion preference
// Reduced motion honours the OS setting by default and is also a manual toggle.
// It drops decorative movement (orbs, dots, word sway/pop) but always keeps the
// lyric fill, which carries information rather than decoration.
// =========================================================
let reducedMotion = false;

function clearSwayTransforms() {
  for (let i = 0; i < lyricDom.length; i++) {
    const lDom = lyricDom[i];
    if (!lDom) continue;
    for (let w = 0; w < lDom.words.length; w++) {
      const wDom = lDom.words[w];
      for (let s = 0; s < wDom.syllables.length; s++) {
        const sDom = wDom.syllables[s];
        if (sDom.baseEl) sDom.baseEl.style.transform = '';
        if (sDom.highlightEl) sDom.highlightEl.style.transform = '';
        for (let c = 0; c < sDom.baseChars.length; c++) {
          if (sDom.baseChars[c]) sDom.baseChars[c].style.transform = '';
          if (sDom.highlightChars[c]) sDom.highlightChars[c].style.transform = '';
        }
      }
    }
  }
}

function applyMotionPreference() {
  document.documentElement.classList.toggle('reduce-motion', reducedMotion);
  if (reducedMotion) clearSwayTransforms();
  if (reducedMotion) resetTilt();
  if (reducedMotion) stopBeatEngine(); else startBeatEngine();
  if (reducedMotion) stopMomentEngine(); else startMomentEngine();
  syncSettingsPanel();
}

function toggleMotion() {
  reducedMotion = !reducedMotion;
  Settings.set('motion', reducedMotion ? 'reduced' : 'full');
  applyMotionPreference();
}

// Motion style scales every variant: subtle dials the whole engine down, wild
// pushes the chorus and hold variants much harder.
function cycleMotionStyle() {
  const idx = MOTION_STYLES.indexOf(motionStyle);
  motionStyle = MOTION_STYLES[(idx + 1) % MOTION_STYLES.length];
  Settings.set('motionStyle', motionStyle);
  clearSwayTransforms();
  syncSettingsPanel();
  renderDiagnostics();
  wakeRenderLoop();
  if (lyrics.length > 0) renderProgress(playheadMs + latencyOffsetMs);
}

// =========================================================
// Beat-Synced Background Pulse
// The rhythm model lives in Python (core/beat.py) and arrives as a plan of runs
// — [startMs, endMs, strength] — marking where the track is actually driven.
// It is built there for three reasons: that side can see the onset stream before
// this side rewrites syllable durations, it is unit-testable in Python, and the
// decision is more involved than a render loop should carry. What is left here is
// small: land the pulse ON the beat, scale it to the current strength, and rest
// wherever the plan says the track is not driven.
//
// The pulse drives the NORMAL background — the ambient backdrop that is always
// present, same layers and colours, no separate glow element — with the album art
// breathing along with it. Modes: Subtle (default) / Bold / Off.
// =========================================================
let beatMode = 'on';
const BEAT_MODES = ['on', 'bold', 'off'];
const BEAT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
let beatPlan = null;      // {bpm, periodMs, phaseMs, runs, phases, stats}
let beatPlanIndex = 0;    // cursor; the playhead usually walks forward
let beatPhaseIndex = 0;   // same trick for the build/drop spans
let beatPhase = null;     // 'build' | 'drop' | null, the shape the pulse is in
let beatBpm = 0;
// The swell takes ~16% of the cycle to reach its peak; leading the pulse by that
// fraction lands the peak on the beat instead of dragging behind it.
const BEAT_LEAD_FRAC = 0.16;

// The pulse run containing `ms`, or null where the plan rests.
// A cursor rather than a binary search: a plan holds tens of runs and the
// playhead normally moves forward, so this is O(1) in practice even on a seek.
function beatRunAt(ms) {
  const runs = beatPlan && beatPlan.runs;
  if (!runs || runs.length === 0) return null;
  let i = Math.min(beatPlanIndex, runs.length - 1);
  while (i > 0 && ms < runs[i][0]) i--;
  while (i < runs.length - 1 && ms > runs[i][1]) i++;
  beatPlanIndex = i;
  const run = runs[i];
  return (ms >= run[0] && ms <= run[1]) ? run : null;
}

// Which shape the pulse is in at `ms`: 'build', 'drop', or null for the steady
// stretches. Sourced from the macro envelope in core/beat.py, where the intensity
// actually ramps and lands — this side only labels it so the animation timing can
// follow along.
function beatPhaseAt(ms) {
  const phases = beatPlan && beatPlan.phases;
  if (!phases || phases.length === 0) return null;
  let i = Math.min(beatPhaseIndex, phases.length - 1);
  while (i > 0 && ms < phases[i][0]) i--;
  while (i < phases.length - 1 && ms > phases[i][1]) i++;
  beatPhaseIndex = i;
  const span = phases[i];
  return (ms >= span[0] && ms <= span[1]) ? span[2] : null;
}

// Kept as a class flip rather than a style write: the phase only changes a
// handful of times per track, and the CSS rules attached to it are what shape
// the attack. Amplitudes come from --beat-strength and are untouched here.
function setBeatPhase(kind) {
  if (kind === beatPhase) return;
  beatPhase = kind;
  document.body.classList.toggle('beat-phase-build', kind === 'build');
  document.body.classList.toggle('beat-phase-drop', kind === 'drop');
}

// Phase-locks the CSS animation to the tracked grid so the swell peaks on the
// next real beat rather than wherever the class happened to be toggled.
// animation-delay is negative, which is what lets the cycle start early enough to
// peak ON the beat instead of trailing it.
function alignBeatToGrid(ms) {
  const period = beatPlan.periodMs;
  const lead = period * BEAT_LEAD_FRAC;
  const nextBeat = beatPlan.phaseMs + Math.ceil((ms - beatPlan.phaseMs) / period) * period;
  const residue = (((nextBeat - ms - lead) % period) + period) % period;
  const delay = residue === 0 ? 0 : residue - period;
  document.body.style.setProperty('--beat-lead-ms', `${delay.toFixed(0)}ms`);
}

function stopBeatEngine() {
  // The plan index is a cursor into the old track's runs; a new track must not
  // inherit it.
  beatPlanIndex = 0;
  beatPhaseIndex = 0;
  setBeatPhase(null);
  const body = document.body;
  body.classList.remove('beat-on', 'beat-bold', 'beat-live');
  body.style.removeProperty('--beat-strength');
}

function startBeatEngine() {
  stopBeatEngine();
  if (beatMode === 'off' || reducedMotion || !beatPlan) return;
  const body = document.body;
  // The period is the tracked one, and it is NOT randomised: an earlier build
  // walked it by +/-8% every few beats to sound less robotic, which is exactly
  // what would pull the pulse off the grid it is now locked to. The pulse still
  // breathes, because its strength follows the music.
  body.style.setProperty('--beat-ms', `${beatPlan.periodMs.toFixed(0)}ms`);
  body.classList.add(beatMode === 'bold' ? 'beat-bold' : 'beat-on');
}

// Gating hook, called every frame from renderProgress with the live playhead.
// The body class carries the MODE (on/bold); 'beat-live' is what actually runs
// the pulse, and it is only on while the plan says the track is driven.
// Share of the track the plan says to pulse through, for the diagnostics row.
function pulseCoverage() {
  if (!beatPlan || !beatPlan.runs.length) return 0;
  const active = beatPlan.runs.reduce((sum, run) => sum + (run[1] - run[0]), 0);
  const span = beatPlan.runs[beatPlan.runs.length - 1][1] || 1;
  return Math.round((active / span) * 100);
}

// The strength band the plan actually uses, for the diagnostics row.
function pulseRange() {
  if (!beatPlan || !beatPlan.runs.length) return '\u2014';
  let lo = 1, hi = 0;
  for (const run of beatPlan.runs) {
    if (run[2] < lo) lo = run[2];
    if (run[2] > hi) hi = run[2];
  }
  return `${lo.toFixed(1)}\u2013${hi.toFixed(1)}`;
}

function updateBeatLive(ms) {
  const body = document.body;
  if (beatMode === 'off' || reducedMotion || !beatPlan || !isPlaying) {
    // Paused or unplanned: park the pulse without tearing down the mode class,
    // so resuming does not need a re-render to come back.
    if (body.classList.contains('beat-live')) body.classList.remove('beat-live');
    return;
  }

  const run = beatRunAt(ms);
  const live = body.classList.contains('beat-live');
  if (run) {
    // Strength is published before the class, so the animation starts at the
    // right depth instead of snapping to it a frame later.
    body.style.setProperty('--beat-strength', run[2].toFixed(2));
    if (!live) {
      alignBeatToGrid(ms);
      body.classList.add('beat-live');
    }
    setBeatPhase(beatPhaseAt(ms));
  } else if (live) {
    body.classList.remove('beat-live');
    setBeatPhase(null);
  }
}

// =========================================================
// Song moments: the envelope
// A drop attacks on the phase start and holds to its end; a hook eases in and
// holds two bars. --moment-strength is the whole intensity, read by the grade,
// the sleeve's halo and the line's bloom, so Subtle and Bold differ by this
// number alone (MOMENT_DEPTH) rather than by three sets of amplitudes.
// =========================================================
const MOMENT_MODES = ['on', 'bold', 'off'];
const MOMENT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
// Subtle deliberately whispers: a full-window grade reads far stronger than its
// number suggests, which is the same lesson the pulse's amplitudes encode.
const MOMENT_DEPTH = { on: 0.6, bold: 1 };
let momentsMode = 'on';
let momentPlan = null;     // the merged arrivals for the current track
let momentIndex = 0;       // cursor; the playhead usually walks forward
let momentLast = null;     // the moment the grade is currently on, or null
let momentsFired = { total: 0, drop: 0, hook: 0 };

// The moment containing `ms`, walked with the same forward cursor the beat
// engine uses — a track holds tens of moments and the playhead moves forward.
function momentAt(ms) {
  const list = momentPlan;
  if (!list || !list.length) return null;
  let i = Math.min(momentIndex, list.length - 1);
  while (i > 0 && ms < list[i].ms) i--;
  while (i < list.length - 1 && ms > list[i].endMs) i++;
  momentIndex = i;
  const moment = list[i];
  return (ms >= moment.ms && ms <= moment.endMs) ? moment : null;
}

// The grade comes down the same way wherever it can: between moments, while
// paused, while minimized, and while the setting is off. One place, so the inline
// number cannot be left behind by one of those paths for a later rule to read.
function releaseMomentGrade() {
  const body = document.body;
  body.classList.remove('moment-live', 'moment-attack');
  body.style.removeProperty('--moment-strength');
  momentLast = null;
}

function stopMomentEngine() {
  // The cursor points into the old track's moments; a new track must not inherit
  // it. The counters are per track too — the report says what THIS track did.
  momentPlan = null;
  momentIndex = 0;
  momentsFired = { total: 0, drop: 0, hook: 0 };
  releaseMomentGrade();
}

function startMomentEngine() {
  stopMomentEngine();
  if (momentsMode === 'off' || reducedMotion || miniMode) return;
  if (!lyrics || !lyrics.length) return;
  momentPlan = momentStarts(lyrics, beatPlan);
}

function updateMoment(ms) {
  const body = document.body;
  if (momentsMode === 'off' || reducedMotion || miniMode || !isPlaying) {
    // Paused, minimized or off: park the grade without tearing the plan down, so
    // resuming does not need a re-render to come back.
    if (body.classList.contains('moment-live')) releaseMomentGrade();
    return;
  }
  const moment = momentAt(ms);
  if (!moment) {
    if (body.classList.contains('moment-live')) releaseMomentGrade();
    return;
  }
  if (moment !== momentLast) {
    momentLast = moment;
    momentsFired.total += 1;
    momentsFired[moment.kind] += 1;
  }
  // The number is published before the class, so the grade starts at the right
  // depth instead of snapping to it a frame later — the same ordering, and the
  // same reason, as the beat engine's strength write.
  const depth = MOMENT_DEPTH[momentsMode] || MOMENT_DEPTH.on;
  body.style.setProperty('--moment-strength', (moment.strength * depth).toFixed(2));
  body.classList.toggle('moment-attack', moment.kind === 'drop');
  body.classList.add('moment-live');
}

// The same three states as Beat sync, deliberately: two intensity systems that
// share subtleties (and the same "a full-window effect reads stronger than its
// number" lesson) should read as one family rather than two inventions.
function cycleMoments() {
  const idx = MOMENT_MODES.indexOf(momentsMode);
  momentsMode = MOMENT_MODES[(idx + 1) % MOMENT_MODES.length];
  Settings.set('momentsMode', momentsMode);
  startMomentEngine();
  syncSettingsPanel();
  renderDiagnostics();
  // startMomentEngine clears the grade, so re-gate it now instead of waiting for
  // the next animation frame — otherwise a mode flip blanks it for a frame.
  wakeRenderLoop();
  if (lyrics.length > 0) renderProgress(playheadMs + latencyOffsetMs);
}

function cycleBeatMode() {
  const idx = BEAT_MODES.indexOf(beatMode);
  beatMode = BEAT_MODES[(idx + 1) % BEAT_MODES.length];
  Settings.set('beatMode', beatMode);
  startBeatEngine();
  syncSettingsPanel();
  renderDiagnostics();
  // startBeatEngine clears 'beat-live' (it carries the pulse), so re-gate it
  // now instead of waiting for the next animation frame — otherwise a mode
  // flip blanks the pulse for a frame.
  wakeRenderLoop();
  if (lyrics.length > 0) renderProgress(playheadMs + latencyOffsetMs);
}

// =========================================================
// Room air
// The room has air in it: a handful of motes of the album's own light drifting
// through the backdrop. This is the app's only effect that is on in a SILENT
// passage too, on purpose — it is what stops a calm verse reading as a frozen
// frame. The beat only nudges it and a drop only puffs it; the air is already
// moving before either happens.
//
// The layout is a pure function of the mote's index rather than Math.random: a
// field that reshuffles on every launch cannot be reasoned about, and the preview
// gate asserts this layout instead of whatever happened to be built. The hash is
// a 32-bit finaliser so every value lands in [0,1) with no floating-point drift.
// =========================================================
// Sixteen motes across a whole window is one per 80,000 square pixels, which is
// sparse enough to read as a rendering fault rather than as air — the first pass
// shipped at that density and was invisible in Bold. Twenty-eight is the count at
// which the room looks inhabited without looking like snowfall.
const DUST_COUNT = 28;

function dustHash(i, salt) {
  let h = Math.imul(i + 1, 2654435761) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// x/y are viewport fractions, size px, delay/dur seconds, drift a horizontal
// wander in rem. The delay is negative on purpose: the field starts already
// mid-flight instead of all sixteen motes appearing together on the first frame.
function dustLayout(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: dustHash(i, 1),
      y: dustHash(i, 2),
      size: 2.5 + dustHash(i, 3) * 4.5,
      delay: -dustHash(i, 4) * 16,
      dur: 10 + dustHash(i, 5) * 10,
      drift: 0.6 + dustHash(i, 6) * 2.0,
    });
  }
  return out;
}
window.dustLayout = dustLayout;

// Built once and never rebuilt: there is nothing per-track about air, and a field
// that re-created itself on a track change would be a visible rebuild for no
// reason.
function buildDustField() {
  const field = document.getElementById('dust-field');
  if (!field) return field;
  if (field.childElementCount) {
    // Already built. Drop whatever is in there before rebuilding: the count and
    // the layout can both change (a mode or a size change that re-runs this),
    // and appending a second field onto the first stacked two mote sets — twice
    // the nodes, twice the compositing, and a "count" that no longer means
    // anything.
    field.textContent = '';
  }
  for (const mote of dustLayout(DUST_COUNT)) {
    const el = document.createElement('i');
    el.className = 'mote';
    el.style.setProperty('--mx', `${(mote.x * 100).toFixed(2)}%`);
    el.style.setProperty('--my', `${(mote.y * 100).toFixed(2)}%`);
    el.style.setProperty('--ms', `${mote.size.toFixed(2)}px`);
    el.style.setProperty('--md', `${mote.delay.toFixed(2)}s`);
    el.style.setProperty('--mt', `${mote.dur.toFixed(2)}s`);
    el.style.setProperty('--mw', `${mote.drift.toFixed(2)}rem`);
    field.appendChild(el);
  }
  return field;
}

// Same three states as Beat sync and Big moments, deliberately: one intensity
// system, not three. The level is one number read by one opacity, so Subtle and
// Bold differ by nothing but this.
const AMBIENT_MODES = ['on', 'bold', 'off'];
const AMBIENT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
// Every mode has a level, Off included: a table with a hole in it is what forces
// a `||` fallback at the read site, and a fallback is how a wrong state silently
// reads as a right one.
const AMBIENT_LEVEL = { on: 0.62, bold: 1, off: 0 };
let ambientMode = 'on';

// Off, reduced motion and the mini player have to be exactly stock. The CSS takes
// the field out of the tree for all three, so the class is what makes Off stock
// (the level below only keeps the number honest).
function applyAmbientMode() {
  document.body.classList.toggle('ambient-off', ambientMode === 'off');
  document.documentElement.style.setProperty('--dust-op', String(AMBIENT_LEVEL[ambientMode]));
}

function cycleAmbient() {
  const idx = AMBIENT_MODES.indexOf(ambientMode);
  ambientMode = AMBIENT_MODES[(idx + 1) % AMBIENT_MODES.length];
  Settings.set('ambientMode', ambientMode);
  applyAmbientMode();
  syncSettingsPanel();
}

// =========================================================
// Cover tilt
// Where the pointer sits inside the art, normalised to -1..1: -1 at the left/top
// edge, +1 at the right/bottom, 0 in the middle. Pure, so the preview gate can
// assert the maths without depending on a layout, and clamped so a stale rect can
// never hand the stage a rotation it cannot come back from.
// =========================================================
function tiltVector(clientX, clientY, rect) {
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  const halfW = ((rect && rect.width) ? rect.width : 1) / 2;
  const halfH = ((rect && rect.height) ? rect.height : 1) / 2;
  return {
    x: clamp((clientX - (rect.left + halfW)) / halfW),
    y: clamp((clientY - (rect.top + halfH)) / halfH),
  };
}
window.tiltVector = tiltVector;

const TILT_MODES = ['on', 'bold', 'off'];
const TILT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
// A lean is read at a glance, so the two live states are close together: Bold is
// about the most a square of artwork can lean before it reads as falling over.
const TILT_AMP = { on: 0.7, bold: 1.2, off: 0 };
let tiltMode = 'on';

// The number is published on the ROOT, where its registered transition lives, so
// the lean eases and releases instead of snapping to the pointer.
function setTilt(x, y) {
  const root = document.documentElement;
  root.style.setProperty('--tilt-x', x.toFixed(3));
  root.style.setProperty('--tilt-y', y.toFixed(3));
}

function resetTilt() { setTilt(0, 0); }

// Deliberately NOT a registered property: a mode change is a deliberate act and
// Off should be immediate, while the pointer's own value is the thing that eases.
function applyTiltMode() {
  document.documentElement.style.setProperty('--tilt-amp', String(TILT_AMP[tiltMode]));
}

// One listener per art wrap. Only one is on screen in a given layout (split hides
// the float, compact hides the side panel), so a single pair of numbers on the
// root is enough — and it is what lets the backdrop, which is not inside either
// wrap, counter-move with the same lean.
function initArtTilt() {
  const wraps = [document.getElementById('float-art-wrap'), document.querySelector('.side-art-wrap')];
  for (const wrap of wraps) {
    if (!wrap) continue;
    wrap.addEventListener('mousemove', (event) => {
      if (tiltMode === 'off' || reducedMotion || miniMode) return;
      const v = tiltVector(event.clientX, event.clientY, wrap.getBoundingClientRect());
      setTilt(v.x, v.y);
    });
    wrap.addEventListener('mouseleave', resetTilt);
  }
  // The pointer leaves the sleeve without a mouseleave when the window loses
  // focus — Chromium does not synthesise one for a subtree that is still laid out
  // — so Alt-Tab with the pointer parked on the card used to leave it leaning for
  // as long as you were away. Same reset, same reason, as the mini bar's own
  // blur handler in initPointerChrome.
  window.addEventListener('blur', resetTilt);
}

function cycleTilt() {
  const idx = TILT_MODES.indexOf(tiltMode);
  tiltMode = TILT_MODES[(idx + 1) % TILT_MODES.length];
  Settings.set('tiltMode', tiltMode);
  applyTiltMode();
  // Off has to release a lean that is already on screen, not just stop accepting
  // new ones: --tilt-amp alone would freeze the sleeve where the pointer left it.
  if (tiltMode === 'off') resetTilt();
  syncSettingsPanel();
}

// =========================================================
// Diagnostics
// Reported by the Python resolve/fetch pipeline, plus the live numbers only the
// UI knows. Previously the only way to learn why a track fell back to
// line-synced lyrics was to read stdout.
// =========================================================
let diagnostics = null;

// What the player told us about its transport (see window.setTransportState),
// and the outcome of the last command we sent (see window.transportResult).
// Declared beside the diagnostics they are rendered into, above every reader.
let transportState = null;
let transportNotice = "";

window.setDiagnostics = function(diag) {
  diagnostics = (diag && typeof diag === 'object') ? diag : null;
  renderDiagnostics();
};

function renderDiagnostics() {
  const box = document.getElementById('qp-info-body');
  if (!box) return;

  const d = diagnostics || {};
  const syncTxt = `${latencyOffsetMs > 0 ? '+' : ''}${latencyOffsetMs}ms`;
  const rows = [
    ['Source', d.source || '\u2014'],
    ['Cache', d.cache ? (d.cache === 'hit' ? 'Hit' : (d.cache === 'local' ? 'Local file' : 'Miss')) : '\u2014'],
    ['Local TTML', d.ttml ? (d.ttml + (d.ttml_match ? ' \u00b7 ' + d.ttml_match : '')) : '\u2014'],
    ['Timing', d.timing || '\u2014'],
    ['Album', d.album || '\u2014'],
    ['Metadata', d.metadata || '\u2014'],
    ['Lines', d.lines === undefined || d.lines === null ? '\u2014' : String(d.lines)],
    ['Syllables', d.syllables === undefined || d.syllables === null ? '\u2014' : String(d.syllables)],
    ['API key', d.api_key === undefined ? '\u2014' : (d.api_key ? 'Set' : 'Missing')],
    // What the player itself reports about its transport. "no timeline from
    // player" means the playhead and the duration cannot come from GSMTC — the
    // lyrics still scroll on the local clock, and a seek cannot be confirmed.
    ['Player', (transportState && transportState.app) ? transportState.app : '\u2014'],
    ['Transport', transportSummary()],
    ['Last command', transportNotice || '\u2014'],
    ['Sync', syncTxt],
    ['Motion', `${motionStyle} \u00b7 ${chorusCount} chorus`],
    ['Beat sync', beatBpm > 0 && beatMode !== 'off' ? `${beatBpm} BPM \u00b7 ${BEAT_LABELS[beatMode]}` : 'Off'],
    // Where the pulse is allowed to run, and how much of the track that is.
    // "no plan" means the track gave too little rhythmic evidence to pulse at
    // all, which is a result, not a failure.
    ['Beat plan', beatPlan
      ? `${beatPlan.runs.length} run(s) \u00b7 ${pulseCoverage()}% of track \u00b7 coherence ${beatPlan.stats.coherence}`
      : 'no rhythmic evidence'],
    // The macro envelope: how deep the pulse swings (the strength range) and how
    // many times the track builds into a hit. Purely for verifying the shape.
    ['Beat shape', beatPlan && beatPlan.runs.length
      ? `${pulseRange()} \u00b7 ${(beatPlan.stats.builds || 0)} build(s) \u00b7 ${(beatPlan.stats.drops || 0)} drop(s)`
      : '\u2014'],
    // Moments are a per-track result, like the beat plan: a track that never
    // dropped says so instead of leaving the effect looking broken.
    ['Moments', momentsMode === 'off' ? 'Off'
      : (momentsFired.total
        ? `${momentsFired.total} fired \u00b7 ${momentsFired.drop} drop(s) \u00b7 ${momentsFired.hook} hook(s)`
        : 'none yet')],
    ['Track ID', d.track_id || '\u2014'],
    // Which build produced this report, and which cached-payload format it
    // speaks: the two numbers a bug report needs. Both come from config.py.
    ['App', d.app_version ? `v${d.app_version}` : '\u2014'],
    ['Parser', d.parser_version === undefined || d.parser_version === null ? '\u2014' : `v${d.parser_version}`]
  ];

  box.textContent = '';
  for (let i = 0; i < rows.length; i++) {
    const row = document.createElement('div');
    row.className = 'qp-info-row';

    const keyEl = document.createElement('span');
    keyEl.className = 'qp-info-key';
    keyEl.textContent = rows[i][0];

    const valEl = document.createElement('span');
    valEl.className = 'qp-info-val';
    valEl.textContent = rows[i][1];

    row.appendChild(keyEl);
    row.appendChild(valEl);
    box.appendChild(row);
  }
}

function toggleDiagnostics() {
  const info = document.getElementById('qp-info');
  const caret = document.getElementById('qp-info-caret');
  const toggle = document.getElementById('qp-info-toggle');
  if (!info) return;

  const open = !info.classList.contains('open');
  info.classList.toggle('open', open);
  if (caret) caret.textContent = open ? 'Hide' : 'Show';
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) renderDiagnostics();
}

// =========================================================
// Click-through
// Lets the overlay sit over a game or browser by ignoring mouse input. Turning
// it back off then needs a route that does not use the mouse, so the app
// refuses to enable it unless the global hotkey actually bound.
// =========================================================
let clickThrough = false;

window.setClickThrough = function(enabled) {
  clickThrough = !!enabled;
  // The pointer state has a different authority in each mode: this page's own
  // events while the window can be clicked, the host's probe while it cannot.
  // Drop the cached answer so neither mode starts out holding the other's, then
  // re-derive: the base applies until the new authority reports otherwise.
  hoverFadeInside = false;
  hoverFadeCtrl = false;
  applyWindowOpacity();
  syncSettingsPanel();
  // While click-through is on, the window cannot receive clicks — an open
  // settings panel would sit there forever, and the user's only way back is
  // Ctrl+Shift+T. Close it so re-enabling mouse input lands on a clean UI.
  if (clickThrough) openSettings(false);
};

function toggleClickThrough() {
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.set_click_through) return;
  // Close the menu BEFORE enabling: the click that toggles must not be the one
  // the window then ignores, and a panel open under WS_EX_TRANSPARENT can never
  // be closed by mouse again.
  if (!clickThrough) openSettings(false);
  window.pywebview.api.set_click_through(!clickThrough).then((state) => {
    if (typeof state === 'boolean') window.setClickThrough(state);
  }).catch(() => {});
}

// =========================================================
// Local TTML library panel
// The user's own .ttml files, shown and managed here. Nothing about matching is
// re-derived on this side: the Python library returns a snapshot that already
// says which file is bound to the playing song, which one auto-matched it, and
// which files merely look like candidates — so the panel cannot disagree with
// the pipeline about what is being used.
// =========================================================
let ttmlSnapshot = null;
let ttmlBusy = false;
let ttmlRemoveArmed = "";   // file awaiting a second click to confirm removal
let ttmlStatusTimer = null;
let ttmlStatusText = "";

// The track the panel acts on: the one the card is showing. Album and duration
// are what the resolver reported for it, which is what the library keys on.
let currentTrackMeta = { title: "", artist: "" };

function ttmlTrackArgs() {
  const album = (diagnostics && diagnostics.album) || "";
  return [
    currentTrackMeta.title || "",
    currentTrackMeta.artist || "",
    album,
    sideTotalMs > 0 ? Math.round(sideTotalMs) : 0,
  ];
}

function ttmlBridge(name, ...args) {
  const api = window.pywebview && window.pywebview.api;
  if (!api || typeof api[name] !== "function") return Promise.reject(new Error("bridge"));
  return Promise.resolve(api[name](...args));
}

function setTtmlStatus(text) {
  ttmlStatusText = text || "";
  const el = document.getElementById('qp-ttml-status');
  if (el) el.textContent = ttmlStatusText;
  clearTimeout(ttmlStatusTimer);
  if (ttmlStatusText) {
    // Transient by design: a status line that never clears reads as a stuck
    // error the next time the panel opens.
    ttmlStatusTimer = setTimeout(() => {
      ttmlStatusText = "";
      const again = document.getElementById('qp-ttml-status');
      if (again) again.textContent = "";
    }, 6500);
  }
}

function setTtmlBusy(busy) {
  ttmlBusy = !!busy;
  ['qp-ttml-import', 'qp-ttml-rescan', 'qp-ttml-reveal'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = ttmlBusy;
  });
}

function refreshTtml() {
  if (!window.pywebview || !window.pywebview.api) return Promise.resolve();
  return ttmlBridge('ttml_list', ...ttmlTrackArgs())
    .then((snapshot) => { applyTtmlSnapshot(snapshot); })
    .catch(() => { /* no bridge yet (dev in a browser): panel stays empty */ });
}

function applyTtmlSnapshot(snapshot, status) {
  ttmlSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;
  renderTtmlPanel();
  if (status !== undefined) setTtmlStatus(status);
}

// One mutation path for every action, so busy state, errors and the returned
// snapshot are handled in exactly one place.
function ttmlRun(name, args, busyLabel) {
  if (ttmlBusy) return Promise.resolve();
  setTtmlBusy(true);
  if (busyLabel) setTtmlStatus(busyLabel);
  return ttmlBridge(name, ...args)
    .then((snapshot) => { applyTtmlSnapshot(snapshot, (snapshot && snapshot.status) || ""); })
    .catch((err) => { setTtmlStatus('That did not work: ' + (err && err.message ? err.message : err)); })
    .then(() => { setTtmlBusy(false); });
}

function importTtml() {
  // The native picker blocks until the user chooses; the panel says so rather
  // than looking frozen.
  return ttmlRun('ttml_import', ttmlTrackArgs(), 'Waiting for the file picker…');
}

function rescanTtml() {
  return ttmlRun('ttml_rescan', ttmlTrackArgs());
}

function revealTtml(file) {
  return ttmlBridge('ttml_reveal', file || "").catch(() => {});
}

function bindTtml(file) {
  if (!currentTrackMeta.title) {
    setTtmlStatus('Play a song first — a file is bound to the track it belongs to.');
    return Promise.resolve();
  }
  return ttmlRun('ttml_bind', [file, ...ttmlTrackArgs()]);
}

function setTtmlEnabled(enabled) {
  if (!currentTrackMeta.title) return Promise.resolve();
  return ttmlRun('ttml_set_enabled', [!!enabled, ...ttmlTrackArgs()]);
}

function removeTtml(file) {
  // Two-step confirm instead of a modal: the sheet is already a full-window
  // dialog, and a native confirm() inside the webview would freeze it.
  if (ttmlRemoveArmed !== file) {
    ttmlRemoveArmed = file;
    renderTtmlPanel();
    setTtmlStatus('Click Remove again to move ' + file + ' to the .trash folder.');
    return Promise.resolve();
  }
  ttmlRemoveArmed = "";
  return ttmlRun('ttml_remove', [file, ...ttmlTrackArgs()]);
}

function ttmlFileRow(entry) {
  const row = document.createElement('div');
  row.className = 'ttml-row';
  row.dataset.file = entry.file;

  const main = document.createElement('div');
  main.className = 'ttml-row-main';

  const title = document.createElement('div');
  title.className = 'ttml-row-title';
  title.textContent = entry.title || entry.name;
  title.title = entry.title || entry.name;

  // The file name leads: it is the one thing the user manages on disk, and the
  // rest of the line degrades gracefully when the row is narrow.
  const sub = document.createElement('div');
  sub.className = 'ttml-row-sub';
  if (entry.error) {
    sub.textContent = '\u26a0 ' + entry.name + ' \u00b7 ' + entry.error;
  } else {
    const bits = [entry.name];
    if (entry.artist) bits.push(entry.artist);
    if (entry.timing) bits.push(entry.timing + ' timing');
    bits.push(String(entry.line_count || 0) + ' lines');
    sub.textContent = bits.join(' \u00b7 ');
  }
  main.appendChild(title);
  main.appendChild(sub);
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'ttml-row-actions';

  if (entry.state === 'bound') {
    actions.appendChild(ttmlChip('Bound here', 'is-active'));
  } else if (entry.state === 'match') {
    actions.appendChild(ttmlChip('Auto-matched', 'is-active'));
  } else if (entry.state === 'off') {
    actions.appendChild(ttmlChip('Off for this song', 'is-warn'));
  } else if (entry.state === 'candidate') {
    actions.appendChild(ttmlChip('Looks like this song', 'is-warn'));
  }

  if (!entry.error && currentTrackMeta.title) {
    const use = document.createElement('button');
    use.className = 'ttml-act';
    use.dataset.action = 'use';
    use.textContent = entry.state === 'bound' ? 'Using' : 'Use here';
    use.disabled = entry.state === 'bound' || ttmlBusy;
    use.title = 'Use this file for “' + currentTrackMeta.title + '”';
    actions.appendChild(use);
  }

  const remove = document.createElement('button');
  remove.className = 'ttml-act ttml-act-danger';
  remove.dataset.action = 'remove';
  remove.textContent = ttmlRemoveArmed === entry.file ? 'Confirm' : 'Remove';
  remove.disabled = ttmlBusy;
  remove.title = 'Move to the .trash folder inside the library';
  actions.appendChild(remove);

  row.appendChild(actions);
  return row;
}

function ttmlChip(text, modifier) {
  const chip = document.createElement('span');
  chip.className = 'ttml-chip' + (modifier ? ' ' + modifier : '');
  chip.textContent = text;
  return chip;
}

function renderTtmlPanel() {
  const currentEl = document.getElementById('qp-ttml-current');
  const listEl = document.getElementById('qp-ttml-list');
  if (!currentEl || !listEl) return;

  const snap = ttmlSnapshot || {};
  const entries = Array.isArray(snap.entries) ? snap.entries : [];
  const current = snap.current || null;

  // ---- current track -----------------------------------------------------
  currentEl.replaceChildren();
  const stateText = { bound: 'Bound to this song', match: 'Auto-matched', off: 'Local lyrics off' };
  const head = document.createElement('div');
  head.className = 'ttml-current-row';
  const label = document.createElement('div');
  label.className = 'ttml-current-label';
  label.textContent = 'This song';
  label.style.flex = '1 1 auto';
  head.appendChild(label);

  if (current && current.kind && stateText[current.kind]) {
    head.appendChild(ttmlChip(stateText[current.kind],
      current.kind === 'off' ? 'is-warn' : 'is-active'));
  }
  if (current && (current.kind === 'bound' || current.kind === 'match' || current.kind === 'off')) {
    const toggle = document.createElement('button');
    toggle.className = 'ttml-act';
    toggle.textContent = current.kind === 'off' ? 'Allow local file' : 'Use online instead';
    toggle.disabled = ttmlBusy;
    toggle.onclick = () => setTtmlEnabled(current.kind === 'off');
    head.appendChild(toggle);
  }
  currentEl.appendChild(head);

  const value = document.createElement('div');
  value.className = 'ttml-current-value';
  if (!current) {
    value.textContent = 'No track playing';
    value.style.opacity = '0.6';
  } else if (current.kind === 'bound') {
    value.textContent = 'Using ' + (current.name || current.file);
  } else if (current.kind === 'match') {
    value.textContent = 'Using ' + (current.name || current.file) + ' (matched by title and artist)';
  } else if (current.kind === 'off') {
    value.textContent = 'Online lyrics for \u201c' + current.title + '\u201d';
  } else if (current.candidates && current.candidates.length) {
    value.textContent = current.candidates.length + ' file(s) look like \u201c' + current.title + '\u201d';
  } else {
    value.textContent = 'No local file for \u201c' + current.title + '\u201d';
  }
  currentEl.appendChild(value);

  // ---- library -----------------------------------------------------------
  listEl.replaceChildren();
  if (!ttmlSnapshot) {
    const empty = document.createElement('div');
    empty.className = 'ttml-empty';
    empty.textContent = 'Library unavailable.';
    listEl.appendChild(empty);
    return;
  }
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'ttml-empty';
    empty.textContent = 'No local files yet. Import a .ttml export for a song the online lookup gets wrong.';
    listEl.appendChild(empty);
  } else {
    entries.forEach((entry) => listEl.appendChild(ttmlFileRow(entry)));
  }

  if (snap.trash > 0 && !ttmlStatusText) {
    setTtmlStatus(snap.trash + ' removed file(s) are in the library\u2019s .trash folder.');
  }
}

// Delegated from the list, so file names never end up inside an inline handler
// (they are user data: quotes and angle brackets included).
document.addEventListener('click', (e) => {
  const button = e.target && e.target.closest ? e.target.closest('.ttml-row-actions button') : null;
  if (!button) return;
  const row = button.closest('.ttml-row');
  if (!row || !row.dataset.file) return;
  e.stopPropagation();
  const action = button.dataset.action;
  if (action === 'use') bindTtml(row.dataset.file);
  else if (action === 'remove') removeTtml(row.dataset.file);
});

// The settings page owns the whole window, so there is nothing to anchor it to
// and no click-outside to close it: it opens over everything and closes from its
// own button, Escape, or Ctrl+, again.
let settingsLastFocus = null;

// The sheet is four pages, and the last one read is where it opens next time —
// the set-once work (the TTML library) should not need finding again. The saved
// value is validated against the markup rather than trusted, the way motionStyle
// is, so a stale key from an older build cannot hide every page.
let settingsTab = 'window';

function openSettingsTab(id) {
  const strip = document.getElementById('qp-tabs');
  if (!strip) return;
  const tabs = [...strip.querySelectorAll('.sp-tab')];
  const known = tabs.map((t) => t.dataset.tab);
  const want = known.includes(id) ? id : known[0];
  for (const tab of tabs) {
    const on = tab.dataset.tab === want;
    // One tab stop and one selection: the strip is a real tablist, so the arrow
    // keys own focus inside it and Tab leaves the strip entirely.
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    const panel = document.getElementById('qp-panel-' + tab.dataset.tab);
    if (panel) panel.hidden = !on;
  }
  settingsTab = want;
  Settings.set('settingsTab', want);
}

// Arrow keys move between tabs, Home/End jump to the ends — the ARIA tabs
// pattern, so the strip behaves the way the control it claims to be does.
function initSettingsTabs() {
  const strip = document.getElementById('qp-tabs');
  if (!strip) return;
  const tabs = [...strip.querySelectorAll('.sp-tab')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => openSettingsTab(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      const last = tabs.length - 1;
      let next = null;
      if (e.key === 'ArrowRight') next = i === last ? 0 : i + 1;
      else if (e.key === 'ArrowLeft') next = i === 0 ? last : i - 1;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = last;
      if (next === null) return;
      e.preventDefault();
      openSettingsTab(tabs[next].dataset.tab);
      tabs[next].focus();
    });
  });
}

// =========================================================
// Settings search
// Four pages make a row reachable if you know its page; this makes it reachable
// by name. The results are CLONES of the live rows rendered under their own group
// heading, so filtering can never write a state value back into the sheet, and a
// query that matched a hint shows that hint — the reason a row is on screen is
// readable instead of guessed at.
//
// The resolve report is deliberately outside this: it reports what the pipeline
// did, it is not a setting, and a query naming a lyric source should not drag
// four report lines into the results.
// =========================================================
function settingsRowText(row) {
  return (row.textContent || '').toLowerCase();
}

// The rows a query can reach: the sheet's own rows, hints and TTML list, group by
// group so every result keeps the heading it came from.
function settingsSearchableRows() {
  const out = [];
  for (const panel of document.querySelectorAll('#qp-body .sp-panel')) {
    for (const group of panel.querySelectorAll('.sp-group')) {
      const title = group.querySelector('.sp-group-title');
      const rows = [...group.children].filter((el) =>
        el.classList.contains('qp-row') || el.classList.contains('ttml-bar') ||
        el.classList.contains('ttml-status') || el.classList.contains('ttml-current') ||
        el.classList.contains('ttml-list') || el.classList.contains('sp-hint'));
      if (rows.length) out.push({ title: title ? title.textContent.trim() : '', group, rows });
    }
  }
  return out;
}

// Wraps the matched run by walking text nodes. A hint carries <code> and <kbd>,
// and rebuilding markup would either flatten that or invent structure, so the
// highlight is added to the text it is actually in.
function markSettingsText(root, query) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const at = text.toLowerCase().indexOf(query);
    if (at < 0 || !node.parentNode) continue;
    const mark = document.createElement('span');
    mark.className = 'qp-mark';
    mark.textContent = text.slice(at, at + query.length);
    const after = node.splitText(at + query.length);
    node.nodeValue = text.slice(0, at);
    node.parentNode.insertBefore(mark, after);
  }
}

// Where the rows live when no query is up, plus the order they were in when the
// first one left. Restoring the group's child list wholesale is the way back: a
// row-by-row put-back would have to reason about siblings that moved with it.
let settingsSearchHomes = [];

// The results ARE the rows, moved into a result list rather than copied into one.
// A copy would put a second copy of every id in the document, would keep showing
// the state the row had when the copy was taken — so acting on a result looked
// like it did nothing — and would drop the handlers the TTML rows are wired with,
// because cloneNode carries markup and attributes but not an assigned onclick.
// The mark therefore has to be lifted again as a row goes home: it is the same
// node that serves as the row on its own page afterwards.
function restoreSettingsSearchRows() {
  for (const { group, order } of settingsSearchHomes) {
    for (const row of order) {
      for (const mark of row.querySelectorAll('.qp-mark')) {
        mark.replaceWith(document.createTextNode(mark.textContent));
      }
      row.normalize();
      group.appendChild(row);
    }
  }
  settingsSearchHomes = [];
}

function runSettingsSearch(raw) {
  const query = (raw || '').trim().toLowerCase();
  const body = document.getElementById('qp-body');
  const empty = document.getElementById('qp-empty');
  const strip = document.getElementById('qp-tabs');
  const searchRow = document.querySelector('.sp-search');
  if (!body || !strip) return;

  // Rows first, sections second: the rows are inside the sections while a query
  // is up, so dropping the sections first would drop the rows with them.
  restoreSettingsSearchRows();
  for (const el of body.querySelectorAll('.sp-result')) el.remove();
  if (empty) empty.hidden = true;
  if (searchRow) searchRow.classList.toggle('has-query', query.length > 0);

  if (!query) {
    // Back to the page that was up: the strip is the sheet's map again.
    strip.hidden = false;
    openSettingsTab(settingsTab);
    return;
  }
  strip.hidden = true;
  for (const panel of body.querySelectorAll('.sp-panel')) panel.hidden = true;

  let matches = 0;
  for (const { title, group, rows } of settingsSearchableRows()) {
    const hits = rows.filter((row) => settingsRowText(row).includes(query));
    if (!hits.length) continue;
    matches += hits.length;
    settingsSearchHomes.push({ group, order: [...group.children] });
    const section = document.createElement('section');
    section.className = 'sp-group sp-result';
    const heading = document.createElement('h2');
    heading.className = 'sp-group-title';
    heading.textContent = title;
    section.appendChild(heading);
    for (const row of hits) {
      // The mark goes where the match actually is: a label when the row has one
      // and the label is what matched, otherwise anywhere in the row — a hint
      // that matched through its prose shows ITS sentence marked, and the file
      // list shows the file the query named.
      const label = row.querySelector('.qp-label');
      if (label && settingsRowText(label).includes(query)) markSettingsText(label, query);
      else markSettingsText(row, query);
      section.appendChild(row);
    }
    body.appendChild(section);
  }

  if (!matches && empty) {
    empty.textContent = '';
    const lead = document.createElement('p');
    lead.textContent = `No settings match \u201c${raw.trim()}\u201d.`;
    const tail = document.createElement('p');
    tail.textContent = 'Local .ttml files live under Lyrics.';
    empty.appendChild(lead);
    empty.appendChild(tail);
    empty.hidden = false;
  }
}

function initSettingsSearch() {
  const search = document.getElementById('qp-search');
  const clear = document.getElementById('qp-search-clear');
  if (!search) return;
  search.addEventListener('input', () => runSettingsSearch(search.value));
  search.addEventListener('keydown', (e) => {
    // Escape backs out of the query first: the query is a layer INSIDE the sheet,
    // so a stray Escape should clear the search before it closes the whole thing.
    if (e.key === 'Escape' && search.value) {
      e.stopPropagation();
      search.value = '';
      runSettingsSearch('');
    }
    if (e.key === 'ArrowDown') {
      const first = document.querySelector('#qp-body .sp-result .qp-row, #qp-body .sp-result .ttml-act');
      if (first) { e.preventDefault(); first.focus(); }
    }
  });
  if (clear) {
    clear.addEventListener('click', () => {
      search.value = '';
      runSettingsSearch('');
      search.focus();
    });
  }
}

function openSettings(open) {
  const panel = document.getElementById('quick-panel');
  if (!panel) return;
  // On close, focus leaves the sheet BEFORE aria-hidden flips: the browser
  // refuses aria-hidden on a subtree that still holds focus, so flipping first
  // would leave the sheet announced to assistive tech on its way out. Back to
  // the opener when it is still on screen, else the header gear, else the page
  // root (mini mode hides the gear).
  if (!open && panel.contains(document.activeElement)) {
    const gear = document.getElementById('art-btn-settings');
    const opener = (settingsLastFocus && document.contains(settingsLastFocus) &&
                    !panel.contains(settingsLastFocus) &&
                    settingsLastFocus.offsetParent !== null) ? settingsLastFocus :
                   (gear && gear.offsetParent !== null) ? gear : null;
    // body.focus() is a no-op — the page root cannot take focus, so "fall back
    // to it" would leave focus inside the sheet for aria-hidden to block. blur()
    // is what actually lands focus on the page root when there is nothing to
    // restore to (mini mode hides the gear and the sheet was opened from nowhere).
    if (opener) opener.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  document.body.classList.toggle('settings-open', open);
  // The sheet is exempt from the hover dip, so opening or closing it can change
  // how see-through the window should be right now.
  applyWindowOpacity();
  const gear = document.getElementById('art-btn-settings');
  if (gear) gear.setAttribute('aria-expanded', open ? 'true' : 'false');

  // Focus management for the modal dialog: move focus in on open, restore it
  // on close, and keep Tab cycling inside the sheet while it is up (the dialog
  // is aria-modal, so focus escaping it would announce hidden content).
  if (open) {
    settingsLastFocus = document.activeElement;
    // The library is re-read on every open: files can be dropped into the
    // folder, edited, or deleted between visits. Any armed removal is disarmed
    // with it, so a panel opened tomorrow does not greet the user with a
    // "Confirm" button they never pressed this session.
    ttmlRemoveArmed = "";
    refreshTtml();
    // Re-applied on open, not only at boot: the page shown is read from the same
    // key every time, so a sheet reopened after a search is the page it was on.
    const search = document.getElementById('qp-search');
    if (search) search.value = '';
    runSettingsSearch('');
    openSettingsTab(settingsTab);
    // Focus lands on the close button, which is where a dialog's focus belongs.
    // This can be synchronous only because the sheet's visibility flips with the
    // class rather than fading in behind it (see .settings-page in style.css): a
    // hidden subtree silently refuses focus, and a frame's wait would leave the
    // keyboard on the page behind the dialog until the next frame arrives — a
    // wait that never happens while the window is occluded and the page is not
    // being composited.
    const target = panel.querySelector('.sp-close');
    if (target) target.focus();
  } else {
    // The hop above already put focus back when the sheet held it; this only
    // covers focus that escaped the sheet some other way while it was open.
    if (settingsLastFocus && document.contains(settingsLastFocus) &&
        document.activeElement === document.body) {
      settingsLastFocus.focus({ preventScroll: true });
    }
    settingsLastFocus = null;
  }
}

// Tab trap: cycles keyboard focus between the sheet's first and last focusable
// elements while the dialog is open.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || !document.body.classList.contains('settings-open')) return;
  const panel = document.getElementById('quick-panel');
  if (!panel) return;
  const focusables = [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
});

window.closeSettings = function() { openSettings(false); };

// Clicking the dimmed area behind the sheet closes it, the way any full-window
// sheet behaves. Clicks that land on the sheet itself must not.
document.addEventListener('click', (e) => {
  const panel = document.getElementById('quick-panel');
  if (panel && e.target === panel) openSettings(false);
});

function toggleSettings(e) {
  if (e) e.stopPropagation();
  const panel = document.getElementById('quick-panel');
  if (!panel) return;
  openSettings(!panel.classList.contains('open'));
}

document.addEventListener('keydown', (e) => {
  // Escape backs out of whatever is on top: the settings sheet first, then the
  // mini player — a lyrics-only window has no other way out but its own bar.
  if (e.key === 'Escape') {
    // Escape backs out of whatever is on top, in the order a native player
    // would: the settings sheet, then the mini player, then fullscreen itself.
    if (document.body.classList.contains('settings-open')) openSettings(false);
    else if (miniMode) setMiniMode(false);
    else if (isFullscreen) toggleFullscreen();
  }
  if (e.key === 'F11') {
    e.preventDefault();
    toggleFullscreen();
  }
  // `/` is the search field's own shortcut while the sheet is up: the sheet has
  // no scroll position or text selection worth protecting, and this is the
  // fastest way back to a row whose name you have and whose page you do not.
  if (e.key === '/' && document.body.classList.contains('settings-open')) {
    const field = document.getElementById('qp-search');
    if (field && document.activeElement !== field) {
      e.preventDefault();
      field.focus();
    }
  }
});

// If the user leaves fullscreen through the OS (e.g. Esc on some shells),
// the window size change is the source of truth — resync the layout state.
window.addEventListener('resize', () => {
  if (window.pywebview && window.pywebview.api) return; // native path reports its own state
  // Browser/dev fallback heuristic only.
  const fsLike = window.innerWidth === window.screen.width && window.innerHeight === window.screen.height;
  if (fsLike !== isFullscreen) setFullscreen(fsLike);
});

// A resize can re-wrap the track title, which changes how far the lyrics must
// stay clear of the floating card.
window.addEventListener('resize', syncLyricsClearance);

// =========================================================
// Ctrl + Wheel Zoom (18px - 60px) with persistence
// =========================================================
let lyricFontSize = 30;
try {
  const saved = localStorage.getItem('lyric_font_size');
  if (saved) lyricFontSize = parseFloat(saved);
} catch (e) {}

// =========================================================
// Lyric alignment: left / center / right, persisted.
// =========================================================
const LYRIC_ALIGNS = ['left', 'center', 'right'];
let lyricAlign = 'left';

function applyLyricAlign() {
  document.body.classList.remove('align-left', 'align-center', 'align-right');
  document.body.classList.add('align-' + lyricAlign);
  Settings.set('align', lyricAlign);
  const st = document.getElementById('qp-align-state');
  if (st) st.textContent = lyricAlign.charAt(0).toUpperCase() + lyricAlign.slice(1);
  // Width measurements were taken for the previous alignment box; rebuild.
  wakeRenderLoop();
  if (lyricDom && lyricDom.length) {
    resetAllLines();
    renderProgress(playheadMs + latencyOffsetMs);
  }
}

function cycleLyricAlign() {
  const idx = LYRIC_ALIGNS.indexOf(lyricAlign);
  lyricAlign = LYRIC_ALIGNS[(idx + 1) % LYRIC_ALIGNS.length];
  applyLyricAlign();
}

function applyZoom(size) {
  wakeRenderLoop();   // glyph metrics change -> the scroller re-anchors
  // Fullscreen applies a CSS multiplier on top of the user's zoom, so zoom
  // keeps working inside fullscreen too.
  lyricFontSize = Math.max(18, Math.min(60, size));
  document.documentElement.style.setProperty('--lyric-zoom', `${lyricFontSize}px`);
  try {
    localStorage.setItem('lyric_font_size', lyricFontSize);
  } catch (e) {}
}

// Initialize persisted preferences.
const osPrefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
let motionPref = 'full';
try {
  const savedFont = Settings.get('font', null);
  if (savedFont) lyricFontName = savedFont;
  showSecondary = Settings.get('secondary', '1') !== '0';
  motionPref = Settings.get('motion', osPrefersReducedMotion ? 'reduced' : 'full');
  const savedLayout = Settings.get('layout', 'compact');
  layoutMode = LAYOUTS.includes(savedLayout) ? savedLayout : 'compact';
  const savedAlign = Settings.get('align', 'left');
  if (LYRIC_ALIGNS.includes(savedAlign)) lyricAlign = savedAlign;
  const savedMotionStyle = Settings.get('motionStyle', 'auto');
  if (MOTION_STYLES.includes(savedMotionStyle)) motionStyle = savedMotionStyle;
  const savedBeatMode = Settings.get('beatMode', 'on');
  if (BEAT_MODES.includes(savedBeatMode)) beatMode = savedBeatMode;
  const savedMomentsMode = Settings.get('momentsMode', 'on');
  if (MOMENT_MODES.includes(savedMomentsMode)) momentsMode = savedMomentsMode;
  const savedAmbientMode = Settings.get('ambientMode', 'on');
  if (AMBIENT_MODES.includes(savedAmbientMode)) ambientMode = savedAmbientMode;
  const savedTiltMode = Settings.get('tiltMode', 'on');
  if (TILT_MODES.includes(savedTiltMode)) tiltMode = savedTiltMode;
  alwaysOnTop = Settings.get('ontop', '0') === '1';
  const savedCardPosition = Settings.get('cardPosition', 'left');
  if (CARD_POSITIONS.includes(savedCardPosition)) cardPosition = savedCardPosition;
  const savedHoverFade = Settings.get('hoverFade', 'off');
  if (HOVER_FADE_LEVELS.includes(savedHoverFade)) hoverFade = savedHoverFade;
  const savedOpacity = parseInt(Settings.get('opacity', '0'), 10);
  if (Number.isInteger(savedOpacity) && savedOpacity >= 0 && savedOpacity < OPACITY_LEVELS.length) {
    opacityIndex = savedOpacity;
  }
} catch (e) {}
reducedMotion = motionPref === 'reduced';
applyZoom(lyricFontSize);
applyFont(lyricFontName);
applyLyricAlign();
applySecondaryVisibility();
applyMotionPreference();
applyLayoutState();
applyCardPosition();
applyAlwaysOnTopWhenReady();
initFloatArt();
buildDustField();
applyAmbientMode();
applyTiltMode();
initHoverFade();
initPointerChrome();
initWindowDrag();
initArtTilt();
initCursorIdle();
pushHoverFadeSettingWhenReady();
initSettingsTabs();
initSettingsSearch();
openSettingsTab(Settings.get('settingsTab', 'window'));

window.addEventListener('wheel', (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 2 : -2;
    applyZoom(lyricFontSize + delta);
  }
}, { passive: false });

// =========================================================
// Dynamic cover-art backdrop (two-layer cross-fade) + header thumbnail.
// The low-res GSMTC thumbnail arrives instantly; a hi-res version is resolved
// in a background task and upgrades both without blocking the lyrics.
// =========================================================
let currentCoverLayer = null;
const trackArtEl = document.getElementById('track-art');

const sideArtEl = document.getElementById('side-art');

let headerArtToken = 0;

function updateHeaderArt(url) {
  if (!trackArtEl || !url) return;
  // Preload off-DOM so a slow hi-res fetch never flashes a broken/empty image.
  // The token makes the newest request win: two tracks resolving close together
  // could otherwise commit whichever image happened to finish loading last,
  // showing the previous song's cover on the new song.
  const token = ++headerArtToken;
  const probe = new Image();
  probe.onload = () => {
    if (token !== headerArtToken) return;
    trackArtEl.src = url;
    trackArtEl.classList.add('visible');
    if (sideArtEl) {
      sideArtEl.src = url;
      sideArtEl.classList.add('visible');
    }
  };
  probe.onerror = () => {};
  probe.src = url;
}

// =========================================================
// The artwork's own colour
// One accent, taken from the cover, that every light in the app is tinted with:
// the beat lamp around the sleeve and the moment veil over the room. It is read
// from the LOW-RES data: thumbnail the host pushes first — a data: URL can never
// taint a canvas, so this needs no CORS handling and cannot break on a CDN that
// forgot an Access-Control-Allow-Origin header.
//
// A 24x24 downscale is plenty: the accent is the colour of the artwork's LIGHT,
// not a pixel-accurate sample. Pixels with no hue to give (greys, near-blacks,
// blown-out whites) are dropped rather than averaged in, because averaging them
// is what turns a cover's colour into mud. The winner is then clamped to a band
// that always reads as light on a dark UI. A cover with nothing to give returns
// null and the theme's own lamp stays on — a result, not a failure.
// =========================================================
const ACCENT_GRID = 24;
let accentCanvas = null;

function extractAccent(pixels) {
  if (!pixels || !pixels.length) return null;
  const HUE_BUCKETS = 12;                       // 30 degrees each
  const weight = new Array(HUE_BUCKETS).fill(0);
  const sum = Array.from({ length: HUE_BUCKETS }, () => [0, 0, 0, 0]);
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < 32) continue;                  // grey: no hue to contribute
    if (max < 32) continue;                     // black: nothing to light with
    if (min > 224) continue;                    // blown out: white, not colour
    let hue;
    if (max === r) hue = ((g - b) / chroma + 6) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    const bucket = Math.floor((hue * 60) / (360 / HUE_BUCKETS)) % HUE_BUCKETS;
    weight[bucket] += chroma;                   // saturated pixels speak loudest
    const s = sum[bucket];
    s[0] += r; s[1] += g; s[2] += b; s[3] += 1;
  }
  let best = -1;
  for (let i = 0; i < HUE_BUCKETS; i++) {
    if (weight[i] > 0 && (best < 0 || weight[i] > weight[best])) best = i;
  }
  if (best < 0) return null;
  const s = sum[best];
  return clampAccentToLight({
    r: Math.round(s[0] / s[3]),
    g: Math.round(s[1] / s[3]),
    b: Math.round(s[2] / s[3]),
  });
}

// The winner has to read as a LIGHT on a near-black UI: a dark, muddy album
// colour would paint a smudge instead of a glow. Clamping saturation and
// lightness in HSL is the smallest way to say that without a colour-space
// dependency — hue, which is the part that carries the artwork, is untouched.
function clampAccentToLight(rgb) {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0, s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const S = Math.min(0.72, Math.max(0.38, s));
  const L = Math.min(0.78, Math.max(0.60, l));
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = L < 0.5 ? L * (1 + S) : L + S - L * S;
  const p = 2 * L - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

window.extractAccent = extractAccent;

// Downscale the thumbnail, read it back, publish. Every failure path is a no-op
// that leaves the accent where it was: a cover the canvas refuses is a reason to
// keep the current light, never a reason to throw inside a track change.
function applyCoverAccent(url) {
  if (typeof url !== 'string' || !url.startsWith('data:image')) return;
  if (!accentCanvas) {
    accentCanvas = document.createElement('canvas');
    accentCanvas.width = ACCENT_GRID;
    accentCanvas.height = ACCENT_GRID;
  }
  const image = new Image();
  image.onload = () => {
    let rgb = null;
    try {
      const ctx = accentCanvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, ACCENT_GRID, ACCENT_GRID);
      ctx.drawImage(image, 0, 0, ACCENT_GRID, ACCENT_GRID);
      rgb = extractAccent(ctx.getImageData(0, 0, ACCENT_GRID, ACCENT_GRID).data);
    } catch (e) { rgb = null; }
    if (!rgb) return;
    document.documentElement.style.setProperty('--art-accent', `rgb(${rgb.r} ${rgb.g} ${rgb.b})`);
  };
  image.src = url;
}

window.applyCoverAccent = applyCoverAccent;

window.setCoverArt = function(url, isHiRes) {
  const backdrop = document.querySelector('.ambient-backdrop');
  if (isHiRes) updateHeaderArt(url);

  if (!backdrop) return;

  if (!url) {
    // No artwork at all: the theme's own lamp, not the last track's colour.
    document.documentElement.style.removeProperty('--art-accent');
    if (currentCoverLayer) {
      const el = currentCoverLayer;
      currentCoverLayer = null;
      el.classList.remove('active');
      setTimeout(() => el.remove(), 1600);
    }
    if (trackArtEl) trackArtEl.classList.remove('visible');
    return;
  }

  // The instant thumbnail also feeds the header art immediately, and it is the
  // copy the accent is read from: it is a data: URL, so the canvas can never be
  // tainted by it.
  if (!isHiRes) { updateHeaderArt(url); applyCoverAccent(url); }

  const layer = document.createElement('div');
  layer.className = 'cover-art-blur';
  // JSON.stringify, not bare interpolation: the URL comes from a third-party
  // artwork lookup (iTunes/Deezer), and a quote or a paren in it would break out
  // of the url("...") and let whatever follows be read as more CSS. Quoting it
  // escapes the string instead of ending it.
  layer.style.backgroundImage = `url(${JSON.stringify(url)})`;
  backdrop.insertBefore(layer, backdrop.firstChild);

  // Double rAF so the initial (0 opacity) frame paints before we fade in.
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('active')));

  const previous = currentCoverLayer;
  currentCoverLayer = layer;
  if (previous) {
    previous.classList.remove('active');
    setTimeout(() => previous.remove(), 1600);
  }
};

// ---------- Latency rail: hidden at the right edge, slides in on approach ----------
function initLatencyRail() {
  const rail = document.getElementById('latency-rail');
  if (!rail) return;
  const card = rail.querySelector('.latency-rail-inner');
  // The trigger is the rail's own footprint, not the whole right edge: a bare
  // band down the side fired the rail whenever the mouse crossed the window,
  // which is most of the time. The card is vertically centred and only moves on
  // the X axis, so its height and centre are readable while it is still parked
  // off-screen.
  const REVEAL_PAD_X = 14, REVEAL_PAD_Y = 18;
  // The trigger rect is cached: reading it on every mousemove forced a layout
  // over the blur layers roughly a hundred times a second. The card is parked
  // off-screen and vertically centred while hidden, so it only changes on a
  // resize (or after the slide transition settles).
  let zoneCache = null;
  const triggerZone = () => {
    if (zoneCache) return zoneCache;
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const centre = r.top + r.height / 2;
    zoneCache = {
      left: window.innerWidth - (r.width + REVEAL_PAD_X),
      top: centre - r.height / 2 - REVEAL_PAD_Y,
      bottom: centre + r.height / 2 + REVEAL_PAD_Y
    };
    return zoneCache;
  };
  window.addEventListener('resize', () => { zoneCache = null; });
  rail.addEventListener('transitionend', () => { zoneCache = null; });

  let hideTimer = null;
  const reveal = () => {
    clearTimeout(hideTimer);
    document.body.classList.add('latency-rail-hot');
  };
  const conceal = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.body.classList.remove('latency-rail-hot'), 350);
  };
  const pointerInZone = (e) => {
    const z = triggerZone();
    return !!z && e.clientX >= z.left && e.clientY >= z.top && e.clientY <= z.bottom;
  };
  window.addEventListener('mousemove', (e) => {
    // Once the rail is out, hovering it keeps it out even if the pointer wanders
    // off the zone, so a slider drag cannot pull the rail away mid-gesture.
    if (pointerInZone(e) || rail.matches(':hover')) reveal();
    else conceal();
  }, { passive: true });
  rail.addEventListener('mouseenter', reveal);
  rail.addEventListener('mouseleave', conceal);

  const minus = document.getElementById('latency-rail-minus');
  const plus = document.getElementById('latency-rail-plus');
  // Hold-to-repeat for fast nudging.
  const bindHold = (el, delta) => {
    if (!el) return;
    let repeat = null;
    const stop = () => { clearTimeout(repeat); repeat = null; };
    el.addEventListener('mousedown', () => {
      window.adjustLatency(delta);
      repeat = setTimeout(function tick() {
        window.adjustLatency(delta);
        repeat = setTimeout(tick, 90);
      }, 420);
    });
    ['mouseup', 'mouseleave'].forEach(ev => el.addEventListener(ev, stop));
  };
  bindHold(minus, -50);
  bindHold(plus, 50);

  // ---- Vertical sync slider (−3000..+3000 ms, zero at the middle) ----
  const slider = document.getElementById('latency-slider');
  if (!slider) return;
  const LAT_MIN = -3000, LAT_MAX = 3000;

  // Render the current latencyOffsetMs as thumb + fill. The fill always
  // starts at the zero mark and extends toward the thumb, so the middle of
  // the track reads as "in sync".
  window.renderLatencySlider = function() {
    const h = slider.clientHeight;
    if (!h) return;
    const frac = (latencyOffsetMs - LAT_MIN) / (LAT_MAX - LAT_MIN); // 0..1, bottom→top
    const thumbY = (1 - frac) * h;
    const zeroY = h / 2;
    const top = Math.min(thumbY, zeroY);
    const height = Math.max(2, Math.abs(zeroY - thumbY));
    const fill = document.getElementById('latency-slider-fill');
    const thumb = document.getElementById('latency-slider-thumb');
    if (fill) { fill.style.top = top + 'px'; fill.style.height = height + 'px'; }
    if (thumb) thumb.style.top = thumbY + 'px';
    slider.classList.toggle('zero', Math.abs(latencyOffsetMs) < 25);
  };

  const setFromEvent = (e) => {
    const rect = slider.getBoundingClientRect();
    const frac = 1 - Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)));
    // Snap to the 50ms grid so drag and the +/- buttons land on the same steps.
    const target = Math.round((LAT_MIN + frac * (LAT_MAX - LAT_MIN)) / 50) * 50;
    window.adjustLatency(target - latencyOffsetMs);
  };

  let dragging = false;
  const onMove = (e) => { if (dragging) { e.preventDefault(); setFromEvent(e); } };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    slider.classList.remove('dragging');
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  slider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    slider.classList.add('dragging');
    setFromEvent(e);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  // The slider repaints from updateLatencyUI (called on every latency change);
  // here only the first paint + resize (height-dependent) are needed.
  window.renderLatencySlider();
  window.addEventListener('resize', () => window.renderLatencySlider());
}
initLatencyRail();

syncSettingsPanel();

if (container) {
  container.addEventListener('wheel', () => {
    userScrolledRecently = true;
    scrollVelocity = 0;
    clearTimeout(userScrollTimer);
    userScrollTimer = setTimeout(() => {
      userScrolledRecently = false;
    }, 2400);
  }, { passive: true });
}

function toggleSimpMusicPlay() {
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.toggle_playback();
  }
}

function skipNext() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.skip_next) {
    window.pywebview.api.skip_next();
  }
}

function skipPrevious() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.skip_previous) {
    window.pywebview.api.skip_previous();
  }
}

// (The old #latency-bar slider block was removed with the element.)

function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// The on-art row prints M:SS — the reference shows "0:01" / "3:33", so minutes
// there are unpadded while the split panel keeps its padded MM:SS.
function formatTimeShort(ms) {
  return formatTime(ms).replace(/^0/, '');
}

function updateTimer(ms) {
  const second = Math.max(0, Math.floor(ms / 1000));
  if (second !== lastDisplayedSecond) {
    lastDisplayedSecond = second;
    updateArtProgress(ms);
    updateSideTransport(ms);
  }
}

// On-art transport — the only progress row left: elapsed / fill / duration.
function updateArtProgress(ms) {
  // One clock read per call, so every throttled fill advances on the same
  // second. `second` used to be declared inside each `if` block while the last
  // line read it from outside them — a ReferenceError thrown on every tick,
  // which killed loadLyrics mid-render (empty lyric view) and the render loop.
  const second = Math.floor(ms / 1000);
  const artFill = document.getElementById('art-progress-fill');
  if (artFill && sideTotalMs > 0 && second !== lastArtFillSecond) {
    lastArtFillSecond = second;
    const pct = Math.max(0, Math.min(100, (ms / sideTotalMs) * 100));
    artFill.style.width = pct.toFixed(2) + '%';
    // The playhead dot rides this same 1 Hz tick: its 1 s linear `left`
    // transition (see .art-thumb) is what turns those steps into one
    // continuous sweep, so nothing has to run per frame.
    const thumb = document.getElementById('art-thumb');
    if (thumb) thumb.style.left = pct.toFixed(2) + '%';
  }
  const artDurEl = document.getElementById('art-duration-display');
  if (artDurEl && sideTotalMs > 0) artDurEl.textContent = formatTimeShort(sideTotalMs);
  const artNowEl = document.getElementById('art-timer-display');
  if (artNowEl) artNowEl.textContent = formatTimeShort(ms);
}

// Split-layout transport + on-art transport state.
let sideTotalMs = 0;
let lastSideFillSecond = -1;
let lastArtFillSecond = -1;

// The position to restore if the player refuses a seek.
let seekRollback = null;

// `ms` is null/absent when the player publishes no duration. That is a fact, not
// a zero: the labels clear and the seek bar turns inert instead of keeping the
// previous track's length on screen (which is what made the duration look
// "wrong" for players like SimpMusic) or inviting a seek that cannot be mapped
// to a fraction.
window.setTrackDuration = function(ms) {
  const known = typeof ms === 'number' && isFinite(ms) && ms > 0;
  sideTotalMs = known ? ms : 0;

  const totalEl = document.getElementById('side-time-total');
  if (totalEl) totalEl.textContent = known ? formatTime(sideTotalMs).replace(/^0/, '') : '--:--';
  const artDurEl = document.getElementById('art-duration-display');
  if (artDurEl) artDurEl.textContent = known ? formatTimeShort(sideTotalMs) : '--:--';
  document.body.classList.toggle('duration-unknown', !known);

  // Both fills are throttled to one update per displayed second; a new total has
  // to invalidate that memory so the bar is repainted for this track.
  lastSideFillSecond = -1;
  lastArtFillSecond = -1;
  if (!known) {
    const artFill = document.getElementById('art-progress-fill');
    if (artFill) artFill.style.width = '0%';
    const thumb = document.getElementById('art-thumb');
    if (thumb) thumb.style.left = '0%';
    const sideFill = document.getElementById('side-progress-fill');
    if (sideFill) sideFill.style.width = '0%';
  }
};

// The player's transport capabilities, pushed by the bridge whenever they change
// (source app, whether it publishes a timeline at all, whether it knows the
// track length). Shown in the resolve report so a dead timeline reads as a fact
// about the player rather than as the overlay being broken.
window.setTransportState = function(state) {
  transportState = (state && typeof state === 'object') ? state : null;
  renderDiagnostics();
};

// The outcome of a transport command we sent. A failure is surfaced instead of
// being swallowed, and a refused seek is rolled back rather than leaving the
// playhead where the player never went.
window.transportResult = function(result) {
  const r = (result && typeof result === 'object') ? result : {};
  const action = r.action || 'transport';
  const ok = r.ok !== false;
  const detail = r.detail || '';

  if (ok) {
    transportNotice = `${action}: accepted`
      + (r.verified === false ? ' (unverified \u2014 player publishes no timeline)' : '');
  } else {
    transportNotice = `${action}: refused${detail ? ' \u2014 ' + detail : ''}`;
    console.warn('[transport] command failed:', action, detail);
  }

  // A seek that was ACCEPTED retires its rollback target. Leaving it armed meant
  // a late or duplicate refusal arriving after the seek had already landed yanked
  // the playhead back to where it came from — the player's word about a seek that
  // is over cannot be allowed to move the overlay.
  if (ok && action === 'seek') seekRollback = null;

  if (!ok && action === 'seek' && seekRollback) {
    const back = seekRollback;
    seekRollback = null;
    playheadMs = back.ms;
    targetDriftMs = 0;
    anchorPosMs = back.ms;
    anchorWallMs = performance.now();
    // Drop the pre-seek echo guard: the seek never happened, so the player's
    // real position is the truth from now on.
    lastUserSeekAt = -Infinity;
    lastDisplayedSecond = -1;
    lastSideFillSecond = -1;
    lastArtFillSecond = -1;
    resetAllLines();
    lastActiveSig = "";
    updateTimer(back.ms);
    renderProgress(playheadMs + latencyOffsetMs);
  }

  renderDiagnostics();
};

function transportSummary() {
  if (!transportState) return '\u2014';
  const parts = [];
  if (transportState.timeline) parts.push('timeline live');
  else parts.push('no timeline from player');
  parts.push(transportState.duration ? 'duration known' : 'duration unknown');
  return parts.join(' \u00b7 ');
}

function updateSideTransport(ms) {
  if (!document.body.classList.contains('layout-split')) return;
  const nowEl = document.getElementById('side-time-now');
  if (nowEl) nowEl.textContent = formatTime(ms).replace(/^0/, '');
  if (sideTotalMs > 0) {
    const fill = document.getElementById('side-progress-fill');
    if (fill) {
      const pct = Math.max(0, Math.min(100, (ms / sideTotalMs) * 100));
      // 1 Hz updates are enough; avoid restyling every frame.
      const second = Math.floor(ms / 1000);
      if (second !== lastSideFillSecond) {
        lastSideFillSecond = second;
        fill.style.width = pct.toFixed(2) + '%';
      }
    }
  }
}

// Click-to-seek (and drag-to-seek) shared by the vertical rail, the on-art
// progress bar and the split-panel progress bar. The vertical rail fills
// bottom→top, so its fraction is measured from the bottom edge.
function seekFromFraction(el, evt, vertical) {
  if (!el || sideTotalMs <= 0) return;
  const rect = el.getBoundingClientRect();
  const frac = vertical
    ? (rect.bottom - evt.clientY) / Math.max(1, rect.height)
    : (evt.clientX - rect.left) / Math.max(1, rect.width);
  applySeek(Math.max(0, Math.min(1, frac)) * sideTotalMs);
}

function applySeek(targetMs) {
  wakeRenderLoop();
  // A seek is 1:1 with the pointer, so the playhead dot must land rather than
  // glide after it. The class is dropped again once the new position is applied.
  const artProgress = document.getElementById('art-progress');
  if (artProgress) {
    artProgress.classList.add('no-thumb-slide');
    setTimeout(() => artProgress.classList.remove('no-thumb-slide'), 80);
  }
  // Remembered for window.transportResult: if the player refuses the seek, the
  // UI goes back to where playback actually is.
  seekRollback = { ms: isPlaying ? predictedPlayhead() : playheadMs };
  playheadMs = targetMs;
  targetDriftMs = 0;
  anchorPosMs = targetMs;
  anchorWallMs = performance.now();
  // Open the guard window against pre-seek position echoes (see syncPlayhead).
  lastUserSeekAt = performance.now();
  userScrolledRecently = false;
  resetAllLines();
  lastActiveSig = "";
  // Force every throttled display (on-art + side fills) to refresh now.
  lastDisplayedSecond = -1;
  lastSideFillSecond = -1;
  lastArtFillSecond = -1;
  updateTimer(targetMs);
  renderProgress(playheadMs + latencyOffsetMs);
  if (window.pywebview && window.pywebview.api && window.pywebview.api.seek_position) {
    window.pywebview.api.seek_position(targetMs);
  }
}

function initSeekBars() {
  const attach = (el, vertical) => {
    if (!el) return;
    let dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      seekFromFraction(el, e, vertical);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('seeking');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    el.addEventListener('mousedown', (e) => {
      dragging = true;
      document.body.classList.add('seeking');
      seekFromFraction(el, e, vertical);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  };
  attach(document.getElementById('art-progress'), false);
  attach(document.querySelector('.side-progress-track'), false);
}
initSeekBars();

function updateSpringScroll(deltaMs) {
  if (!container) return true;
  if (userScrolledRecently) {
    currentScrollY = container.scrollTop;
    scrollVelocity = 0;
    return false;   // manual scrolling: keep the loop alive until it ends
  }

  const dt = Math.min(deltaMs / 1000, 0.045);
  const displacement = currentScrollY - targetScrollY;
  const springForce = -SPRING_K * displacement;
  const dampingForce = -SPRING_D * scrollVelocity;
  const acceleration = (springForce + dampingForce) / SPRING_M;

  scrollVelocity += acceleration * dt;
  currentScrollY += scrollVelocity * dt;

  const settled = Math.abs(displacement) < 0.25 && Math.abs(scrollVelocity) < 0.4;
  if (settled) {
    currentScrollY = targetScrollY;
    scrollVelocity = 0;
  }

  container.scrollTop = currentScrollY;
  return settled;
}

function scrollToActiveCluster(indices) {
  if (!indices || indices.length === 0 || !lyricDom || lyricDom.length === 0 || !container) return;
  const firstLine = lyricDom[indices[0]];
  const lastLine = lyricDom[indices[indices.length - 1]];
  if (!firstLine || !lastLine || !firstLine.element || !lastLine.element) return;

  const clusterTop = firstLine.element.offsetTop;
  const clusterBottom = lastLine.element.offsetTop + lastLine.element.clientHeight;
  const clusterCenter = (clusterTop + clusterBottom) / 2;

  targetScrollY = Math.max(0, clusterCenter - (container.clientHeight / 2));
}

// Multi-Line Cinematic Depth of Field (Optimized for locked 60/120Hz)
function updateLineDepthOfField(activeIndices) {
  if (!lyricDom || lyricDom.length === 0) return;

  const indices = Array.isArray(activeIndices)
    ? activeIndices
    : (typeof activeIndices === 'number' && activeIndices >= 0 ? [activeIndices] : []);

  for (let i = 0; i < lyricDom.length; i++) {
    const lDom = lyricDom[i];
    if (!lDom || !lDom.element) continue;

    // Marks the live line so the per-word pop and bloom only apply there.
    const isActiveLine = indices.includes(i);
    lDom.element.classList.toggle('is-active', isActiveLine);
    // Roving tabindex: exactly the active line(s) are reachable by Tab, so the
    // song does not become hundreds of stops for keyboard users.
    lDom.element.tabIndex = isActiveLine ? 0 : -1;
    // Screen readers: announce the active line as it changes. aria-live is
    // only set on the active line(s) — putting it on the container would
    // re-announce the entire song every time the highlight moved.
    if (lDom.element.getAttribute('aria-live') !== (indices.includes(i) ? 'polite' : null)) {
      if (indices.includes(i)) lDom.element.setAttribute('aria-live', 'polite');
      else lDom.element.removeAttribute('aria-live');
    }

    let tier = 'far';
    if (indices.length === 0) {
      tier = 'idle';
    } else if (indices.includes(i)) {
      tier = 'active';
    } else {
      let minDist = Infinity;
      for (let a = 0; a < indices.length; a++) {
        const d = Math.abs(i - indices[a]);
        if (d < minDist) minDist = d;
      }
      tier = minDist === 1 ? 'near' : (minDist === 2 ? 'mid' : 'far');
    }

    // A 200-line song has thousands of styled elements. Only rewrite the lines
    // whose depth bucket actually changed instead of restyling every line each
    // time the active cluster moves.
    if (lDom.dofTier === tier) continue;
    lDom.dofTier = tier;

    if (tier === 'idle') {
      lDom.element.style.filter = 'none';
      lDom.element.style.opacity = '0.35';
      lDom.element.style.transform = 'scale(0.965)';
    } else if (tier === 'active') {
      lDom.element.style.filter = 'none';
      lDom.element.style.opacity = '1';
      lDom.element.style.transform = 'scale(1.025) translateX(2px)';
    } else if (tier === 'near') {
      // Soft immediate neighbor (1px blur is fast and light)
      lDom.element.style.filter = 'blur(1px)';
      lDom.element.style.opacity = '0.45';
      lDom.element.style.transform = 'scale(0.98)';
    } else if (tier === 'mid') {
      // Distant lines: use opacity instead of heavy blur filters to save GPU passes
      lDom.element.style.filter = 'none';
      lDom.element.style.opacity = '0.22';
      lDom.element.style.transform = 'scale(0.955)';
    } else {
      lDom.element.style.filter = 'none';
      lDom.element.style.opacity = '0.10';
      lDom.element.style.transform = 'scale(0.935)';
    }
  }
}

function tick() {
  const now = performance.now();
  const delta = now - lastTick;
  lastTick = now;

  if (isPlaying) {
    // Decay any pending drift correction, then read the position off the wall clock.
    if (Math.abs(targetDriftMs) > 1) {
      // Time-based exponential decay (tau ≈ 250 ms), so the ease completes in
      // about a second whatever the display's refresh rate. The old per-frame
      // 12% decay finished in 2–6 frames — a yank, not an ease — and its depth
      // silently depended on 60 vs 144 Hz.
      targetDriftMs -= targetDriftMs * Math.min(1, delta / 250);
    } else {
      targetDriftMs = 0;
    }

    playheadMs = predictedPlayhead();
    updateTimer(playheadMs);
    if (lyrics.length > 0) {
      renderProgress(playheadMs + latencyOffsetMs);
    }
  }

  const springSettled = updateSpringScroll(delta);

  // Idle parking: when playback is stopped AND the spring has settled, nothing
  // below this point can change until an event (play, seek, media sync) wakes
  // the loop again — so stop scheduling frames instead of burning 60-144 Hz on
  // a static overlay. `lastTick = now` above means the wake-up frame sees a
  // sane delta. Any state-changing path calls wakeRenderLoop().
  if (!isPlaying && springSettled) {
    renderLoopActive = false;
    return;
  }
  requestAnimationFrame(tick);
}

// Idempotent: safe to call from any event path, as often as it likes.
function wakeRenderLoop() {
  if (renderLoopActive) return;
  renderLoopActive = true;
  lastTick = performance.now();
  requestAnimationFrame(tick);
}

// The loop starts active; wakeRenderLoop() keeps every later wake-up correct.
renderLoopActive = true;
requestAnimationFrame(tick);

window.showLoading = function(title, artist) {
  wakeRenderLoop();
  const titleEl = document.getElementById('title');
  const artistEl = document.getElementById('artist');

  if (titleEl) titleEl.textContent = title;
  if (artistEl) artistEl.textContent = artist;
  const sideTitleEl = document.getElementById('side-title');
  if (sideTitleEl) sideTitleEl.textContent = title;
  const sideArtistEl = document.getElementById('side-artist');
  if (sideArtistEl) sideArtistEl.textContent = artist;

  playheadMs = 0;
  targetDriftMs = 0;
  anchorPosMs = 0;
  anchorWallMs = performance.now();
  lastDisplayedSecond = -1;
  // Fresh track: clear per-second throttle state so the on-art/side fills
  // always repaint, even if the new track starts at the same second.
  lastSideFillSecond = -1;
  updateTimer(0);

  activeLineIdx = -1;
  lastActiveSig = "";
  lastRenderEnd = 0;
  lyrics = [];
  lyricDom = [];
  userScrolledRecently = false;
  scrollVelocity = 0;

  currentScrollY = 0;
  targetScrollY = 0;
  hideGapIndicator();

  if (container) {
    container.scrollTop = 0;
    // Let the outgoing song's words fade before the loading state fades in.
    // fadeInView() also cancels this, so a cache-fast swap can never be wiped.
    fadeOutView(() => {
      container.replaceChildren();
      const box = document.createElement('div');
      box.className = 'loading-box';
      const spinner = document.createElement('div');
      spinner.className = 'loading-spinner';
      const msg = document.createElement('div');
      msg.textContent = 'Loading synchronized lyrics...';
      box.appendChild(spinner);
      box.appendChild(msg);
      container.appendChild(box);
      fadeInView();
    });
  }
};

function splitWordSyllables(token) {
  const clean = token.replace(/[^a-zA-Z]/g, '');
  if (clean.length <= 3) return [token];

  const parts = [];
  const matches = [...token.matchAll(/[^aeiouy]*[aeiouy]+(?:[^aeiouy]+(?=$|[^aeiouy]))?/gi)];

  if (matches.length <= 1) return [token];

  let lastIdx = 0;
  for (let i = 0; i < matches.length - 1; i++) {
    const endIdx = matches[i].index + matches[i][0].length;
    parts.push(token.slice(lastIdx, endIdx));
    lastIdx = endIdx;
  }
  parts.push(token.slice(lastIdx));
  return parts.filter(p => p.length > 0);
}

function prepareLineFallbackWords(line) {
  if (line.words && line.words.length > 0) {
    return line.words;
  }
  const rawTokens = (line.text || "").split(/\s+/).filter(t => t.length > 0);
  const totalDuration = Math.max(1200, (line.endTimeMs - line.startTimeMs));

  const weights = rawTokens.map(w => {
    const vowels = (w.match(/[aeiouy]/gi) || []).length;
    return Math.max(1, (w.length * 0.5) + (vowels * 1.5));
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

  let curStart = line.startTimeMs;
  const words = [];

  rawTokens.forEach((token, idx) => {
    const wordDuration = (weights[idx] / totalWeight) * totalDuration;
    const wordEnd = curStart + wordDuration;

    const subSyllables = splitWordSyllables(token);
    const subDuration = wordDuration / subSyllables.length;
    let sStart = curStart;

    const syllables = subSyllables.map(sText => {
      const sEnd = sStart + subDuration;
      const sObj = {
        text: sText,
        startTimeMs: sStart,
        endTimeMs: sEnd,
        isExtended: subDuration >= 550
      };
      sStart = sEnd;
      return sObj;
    });

    words.push({
      startTimeMs: curStart,
      endTimeMs: wordEnd,
      text: token,
      syllables: syllables
    });
    curStart = wordEnd;
  });

  return words;
}

// =========================================================
// Per-letter reveal (used only when the payload supplies letter timing)
// =========================================================
function setCharFill(sylDom, idx, frac) {
  const hc = sylDom.highlightChars[idx];
  if (!hc) return;
  const safe = Number.isFinite(frac) ? frac : 0;
  const f = Math.max(0, Math.min(1, safe));
  if (f >= 1) {
    if (hc.classList.contains('letter-fill')) {
      hc.classList.remove('letter-fill');
      hc.style.removeProperty('--lfill');
    }
    return;
  }
  hc.classList.add('letter-fill');
  hc.style.setProperty('--lfill', `${(f * 100).toFixed(2)}%`);
}

// =========================================================
// Continuous line sweep
// The previous wipe was a linear ramp restarted at every word, so the leading
// edge jumped back to the left of each word and its speed changed instantly.
// Instead we model ONE continuous position along the line and derive every
// syllable's fill from it, interpolated with a monotone cubic spline so speed
// eases through each word boundary instead of snapping.
// =========================================================
function buildLineMotion(lDom) {
  if (!lDom || !lDom.words) {
    if (lDom) lDom.motion = null;
    return;
  }

  const items = [];
  for (let wIdx = 0; wIdx < lDom.words.length; wIdx++) {
    const wDom = lDom.words[wIdx];
    for (let sIdx = 0; sIdx < wDom.syllables.length; sIdx++) {
      const sDom = wDom.syllables[sIdx];
      let width = 0;
      try { width = sDom.element.getBoundingClientRect().width || 0; } catch (e) { width = 0; }
      if (!(width > 0)) width = Math.max(1, sDom.numChars || 1) * 8; // layout fallback
      items.push({ sDom: sDom, width: width });
    }
  }
  if (items.length === 0) { lDom.motion = null; return; }

  // Key points: (start, d0) then (end, d1) per syllable. Contiguous syllables
  // collapse to a single point; a real gap parks the edge until the next start.
  const ts = [];
  const ds = [];
  const push = (t, d) => {
    const lastT = ts.length ? ts[ts.length - 1] : -Infinity;
    const lastD = ds.length ? ds[ds.length - 1] : -Infinity;
    if (t <= lastT + 1e-3) {
      if (d <= lastD + 1e-3) return;   // duplicate boundary
      t = lastT + 1e-3;                // same instant, further along the line
    }
    ts.push(t);
    ds.push(d);
  };

  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const sDom = items[i].sDom;
    const w = items[i].width;
    sDom.motionD0 = acc;
    sDom.motionW = w;
    push(sDom.startTimeMs, acc);
    acc += w;
    push(sDom.endTimeMs, acc);
  }

  const n = ts.length;
  if (n < 2) { lDom.motion = null; return; }

  // Fritsch-Carlson monotone cubic tangents: continuous velocity, no overshoot.
  const delta = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) delta[i] = (ds[i + 1] - ds[i]) / (ts[i + 1] - ts[i]);
  const m = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) { m[i] = 0; continue; }
    m[i] = (delta[i - 1] + delta[i]) / 2;
    const a = m[i] / delta[i - 1];
    const b = m[i] / delta[i];
    const s = a * a + b * b;
    if (s > 9) m[i] = (3 / Math.sqrt(s)) * a * delta[i - 1];
  }

  lDom.motion = { ts: ts, ds: ds, m: m, n: n, total: acc };
}

function lineDistanceAt(motion, ms) {
  const ts = motion.ts, ds = motion.ds, m = motion.m, n = motion.n;
  if (ms <= ts[0]) return ds[0];
  if (ms >= ts[n - 1]) return ds[n - 1];

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= ms) lo = mid; else hi = mid;
  }

  const h = ts[hi] - ts[lo];
  const t = h > 0 ? (ms - ts[lo]) / h : 0;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ds[lo]
       + (t3 - 2 * t2 + t) * h * m[lo]
       + (-2 * t3 + 3 * t2) * ds[hi]
       + (t3 - t2) * h * m[hi];
}

function rebuildLineMotion() {
  // Only materialized lines have measurable glyph widths; the rest measure
  // themselves the first time they enter the render window.
  for (let i = 0; i < lyricDom.length; i++) {
    const lDom = lyricDom[i];
    if (lDom && lDom.hydrated) buildLineMotion(lDom);
  }
}

// =========================================================
// Lazy glyph hydration
// Splitting every syllable into per-character spans up front meant a long song
// built tens of thousands of never-visible elements before the first frame.
// A line now splits itself the first time it enters the render window, so the
// initial build cost no longer scales with song length.
// =========================================================
function hydrateSyllable(sylDom) {
  if (!sylDom || sylDom.hydrated || !sylDom.text) return;
  sylDom.hydrated = true;

  const chars = Array.from(sylDom.text);
  const baseChars = [];
  const highlightChars = [];

  for (let i = 0; i < chars.length; i++) {
    const bChar = document.createElement('span');
    bChar.className = 'char-glyph';
    bChar.textContent = chars[i];
    baseChars.push(bChar);

    const hChar = document.createElement('span');
    hChar.className = 'char-glyph';
    hChar.textContent = chars[i];
    highlightChars.push(hChar);
  }

  sylDom.baseEl.replaceChildren(...baseChars);
  sylDom.highlightEl.replaceChildren(...highlightChars);
  sylDom.baseChars = baseChars;
  sylDom.highlightChars = highlightChars;
  sylDom.numChars = chars.length;

  // Letter timing is only trusted when it lines up 1:1 with the rendered glyphs.
  const rawLetters = sylDom.pendingLetters;
  if (rawLetters && rawLetters.length === chars.length) {
    sylDom.hasLetters = true;
    sylDom.letters = rawLetters;
    sylDom.element.classList.add('has-letters');
  }
}

function hydrateLine(lDom) {
  if (!lDom || lDom.hydrated) return;
  lDom.hydrated = true;

  // One motion per WORD, chosen from the word's index in the line. Rotating per
  // syllable instead meant a split word moved in two pieces — 'some' lifting
  // while 'thing' hopped — which read as a joint flexing rather than as one
  // word. The syllables still get their own parity, so the variants that work
  // in particles (char waves, alternating leans) keep their half-beat offset.
  for (let wIdx = 0; wIdx < lDom.words.length; wIdx++) {
    const wDom = lDom.words[wIdx];
    let wordVariant = null;
    for (let sIdx = 0; sIdx < wDom.syllables.length; sIdx++) {
      const sDom = wDom.syllables[sIdx];
      hydrateSyllable(sDom);
      // Chosen once per syllable per type, so the motion is stable for the
      // whole line instead of flickering between variants frame to frame.
      if (!sDom.variant) {
        if (!wordVariant) wordVariant = pickVariant(lDom, sDom, wIdx);
        sDom.variant = wordVariant;
        // Alternating across the line, not within the word: the parity variants
        // (dodge, skip, swaylet, chorusTilt) are what stop neighbours of a run
        // leaning the same way, and a line of one-syllable words would then
        // alternate on every word instead of never.
        sDom.parity = (wIdx + sIdx) % 2;
      }
    }
  }

  buildLineMotion(lDom);
}

// Chorus detection: a line whose words repeat elsewhere in the song is almost
// always a hook. Runs once per track, before hydration, so the pools are right.
function detectChorusSections(lines) {
  const counts = new Map();
  const norm = (l) => (l.words || []).map(w => (w.text || '').trim().toLowerCase()).join(' ')
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

  for (let i = 0; i < lines.length; i++) {
    const key = norm(lines[i]);
    if (key.length < 8) continue; // too short to be a reliable repeat ("oh", "yeah")
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  let chorusLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const key = norm(line);
    const repeats = counts.get(key) || 0;
    // Two or more performances of the same lyric = a chorus/hook.
    line.isChorus = key.length >= 8 && repeats >= 2;
    const wordCount = (line.words || []).length;
    // A short, quick line that never repeats reads as an ad-lib. Repeats are
    // hooks (a chorus), and long one-word lines are held notes — never asides.
    line.isAdlib = !line.isChorus && !line.isBackground && wordCount <= 2 &&
      repeats < 2 && (line.endTimeMs - line.startTimeMs) <= 2000;
    if (line.isChorus) chorusLines++;
  }
  return chorusLines;
}

// =========================================================
// Song moments: where they are
// Two things in this app already know when something happens — the rhythm plan
// knows where a drop lands and how hard (its phases carry the level the pulse
// reaches), and the chorus detector above knows which lines are hooks. Neither is
// a moment on its own: a hook is a FLAG on a repeated line, so one chorus can
// carry eight of them, and firing per flag would fire eight times at the same
// arrival. This layer turns both into arrivals, and it is pure: the lines and the
// plan go in, the moments come out.
// =========================================================
const MOMENT_HOOK_GAP_MS = 3500;    // a silence this long ends a hook block
const MOMENT_HOOK_HOLD_MS = 4000;   // no plan to read a length from
const MOMENT_MAX_HOLD_MS = 8000;    // no moment outstays this, whatever the plan says
const MOMENT_NEUTRAL_STRENGTH = 0.7;

// The index of every chorus line that STARTS a hook block. A block is continuous:
// two or more non-chorus lines between two hooks, or a silence longer than gapMs,
// means the first block ended and a new one began. Adjacent chorus lines therefore
// never re-fire — a hook is an arrival, not a flag.
function momentHooks(lines, gapMs = MOMENT_HOOK_GAP_MS) {
  const out = [];
  let prev = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].isChorus) continue;
    const separate = prev < 0 || (i - prev) >= 3 ||
      ((lines[i].startTimeMs || 0) - (lines[prev].endTimeMs || 0)) > gapMs;
    if (separate) out.push(i);
    prev = i;
  }
  return out;
}

// The run strength at `ms`, so a hook grades with the music around it; a track
// with no plan gets the neutral grade, which is a result rather than a fallback.
function momentStrengthAt(plan, ms) {
  const runs = plan && plan.runs;
  if (!runs) return MOMENT_NEUTRAL_STRENGTH;
  for (const [start, end, level] of runs) {
    if (ms < start) break;
    if (ms <= end) return Math.max(0, Math.min(1, level));
  }
  return MOMENT_NEUTRAL_STRENGTH;
}

// Every moment in the track, in order. Drops come straight from the plan's phase
// spans; hooks come from the line indices above, and a hook that arrives while a
// drop is open IS the drop — one arrival, one moment.
function momentStarts(lines, plan) {
  const out = [];
  const phases = (plan && plan.phases) || [];
  for (const phase of phases) {
    if (phase[2] !== 'drop') continue;
    const startMs = phase[0];
    const holdMs = Math.min(MOMENT_MAX_HOLD_MS, Math.max(0, phase[1] - startMs));
    out.push({ ms: startMs, endMs: startMs + holdMs, kind: 'drop',
               strength: Math.max(0, Math.min(1, phase[3] || 0)) });
  }
  const hookLines = lines || [];
  for (const index of momentHooks(hookLines)) {
    const line = hookLines[index];
    const startMs = line.startTimeMs || 0;
    if (out.some((m) => startMs >= m.ms && startMs <= m.endMs)) continue;
    const holdMs = plan
      ? Math.min(MOMENT_MAX_HOLD_MS, Math.max(1000, 2 * plan.periodMs))
      : MOMENT_HOOK_HOLD_MS;
    out.push({ ms: startMs, endMs: startMs + holdMs, kind: 'hook',
               strength: momentStrengthAt(plan, startMs) });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

// =========================================================
// Motion Variant Engine
// Every syllable animation is one "variant" with a stable id per line. Six
// contexts (types) each have their own pool, so a fast rap run, a long held
// note, a backing vocal and a chorus hook never move the same way. Pools are
// walked with a rotating index, so a line never repeats one motion twice in a
// row; the style setting scales the whole thing (subtle → wild).
//
// Only transforms are written per frame — the compositor handles them — while
// the glow work stays in CSS classes.
// =========================================================
function motionScaleFactor() {
  switch (motionStyle) {
    case 'subtle': return 0.55;
    case 'lively': return 1.5;
    case 'wild': return 2.1;
    default: return 1.0; // auto
  }
}

// The macro envelope of the song, as a multiplier on every motion. The backdrop
// already breathes with this number (--beat-strength, from the rhythm plan in
// core/beat.py); scaling the words by it too is what makes a driven chorus move
// more than a quiet verse WITHOUT a second motion model — the words and the
// background are then visibly one system. The band is deliberately narrow
// (0.9 - 1.15): it colours the movement rather than changing it, and a resting
// stretch or Beat sync Off is exactly 1.
let sectionDrive = 1;

function updateSectionDrive(ms) {
  if (beatMode === 'off' || reducedMotion || !beatPlan) { sectionDrive = 1; return; }
  const run = beatRunAt(ms);
  sectionDrive = run ? 0.9 + Math.max(0, Math.min(1, run[2])) * 0.25 : 1;
}

// Anticipation: the word about to be sung leans in as its timestamp approaches,
// so a line is alive BETWEEN its words and not only on them. Under a pixel of
// travel and one percent of scale at full strength, eased in quadratically, so
// nothing is visible until the word is genuinely close. This is the one motion
// that runs on an unsung syllable, and it stays on the transformed layers.
const ANTICIPATION_MS = 480;
// The lean's shape — a sub-pixel lift and one percent of scale — lives in one
// place, so the waiting word and the handoff into the sung word cannot drift.
const ANTICIPATION_LIFT_PX = 0.9;
const ANTICIPATION_GROWTH = 0.012;

function leanTransform(b, amp) {
  if (!(b > 0)) return '';
  return `translate3d(0, ${(-ANTICIPATION_LIFT_PX * b * amp).toFixed(2)}px, 0) ` +
         `scale(${(1 + ANTICIPATION_GROWTH * b * amp).toFixed(3)})`;
}

const leanAmp = () => Math.min(1, motionScaleFactor() * sectionDrive);

// How far in the word has leaned by now, 0..1: quadratic, and only inside the
// last ANTICIPATION_MS before its timestamp.
function anticipationBias(sylDom, ms) {
  const start = sylDom.startTimeMs;
  if (!(start > 0) || typeof ms !== 'number') return 0;
  const lead = start - ms;
  if (lead <= 0 || lead > ANTICIPATION_MS) return 0;
  return (1 - lead / ANTICIPATION_MS) ** 2;
}

function anticipationFor(sylDom, ms) {
  return leanTransform(anticipationBias(sylDom, ms), leanAmp());
}

// The lean is handed over to the sung motion, not dropped at the door. A waiting
// syllable has leaned in as far as it goes on the last frame before its
// timestamp, but the singing branch starts at rest — so without the handoff the
// first sung frame threw the lean away and EVERY word snapped about 1% smaller
// and 1px down the instant the playhead reached it, then grew back out of it.
//
// So the sung motion carries the lean the word actually reached (measured, not
// assumed — a word that never had time to lean, e.g. the first syllable of a
// song or one arriving out of a seek, carries none) and releases it over the
// window it eased in. The release is monotonic and finished inside the syllable,
// so neither the sung frame nor the passed frame that clears the layers has
// anything left to drop.
function leanRelease(sylDom, ms, dur) {
  if (!(sylDom.leanCarry > 0) || typeof ms !== 'number') return '';
  const window = Math.min(ANTICIPATION_MS, dur * 0.9);
  const released = 1 - Math.max(0, ms - sylDom.startTimeMs) / window;
  return leanTransform(sylDom.leanCarry * Math.max(0, Math.min(1, released)), leanAmp());
}

// `f` returns the layer transform; `fc` (optional) returns a per-character one.
// Context: e (envelope), p (progress 0..1), t (ms), d (duration), k (char), n (chars)
// Flags: special = flashy, budget-limited per line; grows = changes glyph size
// (those trigger the line-parting nudge so neighbours make room).
//
// House rules for a variant, so a wider pool still reads as ONE system:
//   * amplitudes stay in the band the originals established — a lift of 1-2px,
//     a scale of 1-4%, a rotation of well under a degree;
//   * the motion starts and ends at rest (b = sin(p*PI), or an exponential that
//     decays to nothing), so entering and leaving a syllable never snaps;
//   * only transforms are written, never layout;
//   * it is scaled by c.e, so a quick syllable stays crisp and a held one moves.
const MOTION_VARIANTS = {
  // --- Ordinary sung words ------------------------------------------------
  normal: [
    { id: 'lift',   f: c => ({ y: Math.sin(c.t / 270) * 0.9 * c.e - c.e * 1.1, r: Math.sin(c.t / 270) * 0.45 * c.e }) },
    { id: 'hop',    f: c => { const b = Math.sin(Math.min(1, c.p * 1.7) * Math.PI); return { y: -b * 1.4 * c.e - c.e * 0.4, s: 1 + b * 0.018 * c.e }; }, special: true, grows: true },
    { id: 'tilt',   f: c => ({ r: Math.sin(c.t / 300) * 0.7 * c.e, y: -c.e * 0.7, s: 1 + Math.sin(c.t / 300) * 0.008 * c.e }) },
    { id: 'breathe',f: c => ({ s: 1 + Math.sin(c.p * Math.PI) * 0.035 * c.e, y: -c.e * 0.9 }), grows: true },
    { id: 'drift',  f: c => ({ x: Math.sin(c.t / 340) * 1.2 * c.e, y: -c.e * 0.7 }) },
    { id: 'bob',    f: c => ({ y: Math.sin(c.t / 230) * 1.0 * c.e - c.e * 0.9 }) },
    { id: 'swell',  f: c => ({ s: 1 + (0.35 + 0.65 * c.p) * 0.028 * c.e, y: -c.e * 1.0 }), special: true, grows: true },
    // Was a jump + rotate to a tilted resting angle — read as cartoony. Now a
    // gentle glide: the drift eases out as the syllable progresses, rotation
    // is a soft sine ripple instead of a swing to a new angle.
    { id: 'lean',   f: c => ({ r: Math.sin(c.p * Math.PI) * 0.6 * c.e, y: -c.e * 0.9, x: (0.5 - c.p) * 0.8 * c.e }), special: true },
    // --- Round two: more places for a word to go without moving further. ----
    // A lean-in that settles back out on the same arc as the wipe, so the
    // horizontal and the vertical halves of the motion agree.
    { id: 'tide',   f: c => ({ x: Math.sin(c.p * Math.PI) * 0.9 * c.e, y: -Math.sin(c.p * Math.PI) * 0.8 * c.e }) },
    // Settles INTO the word: most of the travel happens in the first third and
    // the tail is still, which reads as weight rather than as a bounce.
    { id: 'knee',   f: c => { const b = Math.exp(-c.p * 3.2); return { y: -(1 - b) * 1.1 * c.e, s: 1 - b * 0.01 * c.e }; } },
    // Slow drift with a per-syllable phase offset, so two adjacent syllables of
    // one word never ride the same sine — the drift is what moves, not the word.
    { id: 'swaylo', f: c => ({ y: Math.sin(c.t / 310 + c.parity * 1.6) * 0.9 * c.e - c.e * 0.5, s: 1 + Math.sin(c.t / 310) * 0.006 * c.e }) },
    // A size change the whole line makes room for, at the same growth as
    // 'breathe' — deliberately not 'special', so both budget and pool walk can
    // still reach it late in a long line.
    { id: 'swellSoft', grows: true, f: c => ({ s: 1 + Math.sin(Math.min(1, c.p * 1.3) * Math.PI) * 0.03 * c.e, y: -Math.sin(c.p * Math.PI) * 0.7 * c.e }) }
  ],

  // --- Rapid-fire syllables (short) --------------------------------------
  fast: [
    { id: 'tick',  f: c => { const b = 1 - Math.min(1, c.p * 2.2); return { y: -b * 1.1 * c.e, s: 1 + b * 0.02 * c.e }; } },
    { id: 'snap',  f: c => { const b = Math.exp(-c.p * 4.5); return { s: 1 + b * 0.024 * c.e, y: -b * 0.5 * c.e }; }, special: true, grows: true },
    // Rotation removed (snap-turn read as cartoonish); kept a soft x-nudge.
    { id: 'flick', f: c => { const b = Math.exp(-c.p * 4); return { x: -b * 1.0 * c.e }; }, special: true },
    { id: 'blip',  f: c => ({ y: Math.sin(Math.min(1, c.p * 1.4) * Math.PI) * -0.9 * c.e, s: 1 + Math.sin(c.p * Math.PI) * 0.012 * c.e }), grows: true },
    { id: 'skim',  f: c => ({ y: -c.e * 0.7 }) },
    { id: 'jitter',f: c => ({ y: Math.sin(c.t / 90) * 0.8 * c.e - c.e * 0.5, s: 1 + Math.sin(c.t / 90) * 0.008 * c.e }) },
    // --- Round two: short syllables get a tap, never a hop. ------------------
    { id: 'pat',   f: c => { const b = Math.exp(-c.p * 3.6); return { y: -b * 0.9 * c.e, s: 1 + b * 0.014 * c.e }; } },
    // Alternating sideways skip: neighbours of a run lean opposite ways, which
    // reads as a pattern instead of noise.
    { id: 'skip',  f: c => { const b = Math.sin(Math.min(1, c.p * 2) * Math.PI); return { y: -b * 1.0 * c.e, x: (c.parity ? 1 : -1) * b * 0.5 * c.e }; } },
    { id: 'glide2',f: c => ({ x: Math.sin(c.t / 150) * 0.7 * c.e, y: -c.e * 0.5 }) }
  ],

  // --- Held notes ---------------------------------------------------------
  hold: [
    { id: 'wave',  chars: true, special: true, grows: true,
      f: c => ({ y: -c.e * 1.5, s: 1 + c.e * 0.012 }),
      fc: c => ({ y: -c.e * 1.1 + Math.sin(c.p * Math.PI * 2 * 1.6 - c.k * 0.7) * c.e * 1.2 }) },
    { id: 'ripple',chars: true, special: true, grows: true,
      f: c => ({ y: -c.e * 1.0 }),
      fc: c => { const wave = Math.sin((c.p * 2 - 0.5) * Math.PI - c.k * 0.9); return { s: 1 + wave * 0.022 * c.e, y: -wave * 0.6 * c.e }; } },
    { id: 'bloom', special: true, grows: true, f: c => ({ s: 1 + Math.sin(c.p * Math.PI) * 0.04 * c.e, y: -c.e * 1.3 }) },
    { id: 'ladder',chars: true, special: true,
      f: c => ({}),
      fc: c => { const local = Math.max(0, Math.min(1, (c.p - c.k / Math.max(1, c.n) * 0.55) * 3)); return { y: -local * 1.8 * c.e, s: 1 + local * 0.018 * c.e }; } },
    { id: 'swing', f: c => ({ r: Math.sin(c.p * Math.PI * 2 * 0.85) * 0.8 * c.e, y: -c.e * 1.2, x: Math.sin(c.p * Math.PI * 2 * 0.85) * 0.7 * c.e }) },
    { id: 'xwave', chars: true, special: true,
      f: c => ({}),
      fc: c => ({ x: Math.sin(c.p * Math.PI * 2 * 1.3 - c.k * 0.8) * 1.3 * c.e }) },
    { id: 'float', f: c => ({ y: -c.e * 1.5 + Math.sin(c.p * Math.PI * 2) * 0.8 * c.e }) },
    // --- Round two: what a long note does while it is being held. ------------
    // A shimmer travelling across the characters: the word holds one shape while
    // the light moves through it, which is a size change small enough that the
    // line does not have to part for it (no `grows`).
    { id: 'shimmer', chars: true,
      f: c => ({ y: -Math.sin(c.p * Math.PI) * 1.2 * c.e }),
      fc: c => ({ s: 1 + Math.sin(c.p * Math.PI * 2 * 1.2 - c.k * 0.55) * 0.014 * c.e }) },
    // One long build to the top and a shorter settle: the shape of a note being
    // pushed rather than a note arriving.
    { id: 'surge', grows: true, f: c => { const b = Math.sin(Math.min(1, c.p * 1.35) * Math.PI); return { y: -b * 1.9 * c.e, s: 1 + b * 0.016 * c.e }; } },
    // Cradle: the characters take turns rising, the way a hand rocks a word.
    { id: 'cradle', chars: true,
      f: c => ({ y: -Math.sin(c.p * Math.PI) * 1.3 * c.e }),
      fc: c => ({ y: -Math.abs(Math.sin(c.p * Math.PI - c.k * 0.7)) * 0.9 * c.e }) }
  ],

  // --- Backing vocals / harmonies (all low-profile by design) -------------
  backing: [
    { id: 'ghost', f: c => ({ y: Math.sin(c.t / 420) * 0.7 * c.e - c.e * 0.6, s: 1 + Math.sin(c.t / 420) * 0.006 * c.e }) },
    { id: 'echo',  f: c => ({ x: Math.sin(c.t / 560) * 1.0 * c.e, y: -c.e * 0.5 }) },
    { id: 'hum',   f: c => ({ s: 1 + Math.sin(c.p * Math.PI) * 0.032 * c.e }) },
    { id: 'veil',  f: c => ({ y: -c.e * 0.6, s: 1 - c.e * 0.012 }) },
    // --- Round two: harmonies stay quieter than the lead in every variant. ---
    // Sinks a hair instead of rising: a second voice sitting just under the
    // first rather than competing with it.
    { id: 'hush',  f: c => ({ y: -c.e * 0.45, s: 1 - Math.sin(c.p * Math.PI) * 0.018 * c.e }) },
    { id: 'runnel',f: c => ({ x: Math.sin(c.p * Math.PI) * 1.1 * c.e, y: -c.e * 0.4, s: 1 + c.e * 0.008 }) }
  ],

  // --- Chorus hooks (the special ones) -----------------------------------
  chorus: [
    { id: 'chorusLeap', special: true, grows: true, f: c => { const b = Math.sin(Math.min(1, c.p * 1.5) * Math.PI); return { y: -b * 2.0 * c.e, s: 1 + b * 0.03 * c.e, r: Math.sin(c.p * Math.PI) * 0.5 * c.e }; } },
    { id: 'chorusBeat', special: true, grows: true, f: c => { const beat = Math.sin(c.t / 240); return { s: 1 + beat * 0.016 * c.e, y: -Math.abs(beat) * 1.1 * c.e }; } },
    { id: 'chorusSweep', chars: true, special: true,
      f: c => ({ y: -c.e * 1.5 }),
      fc: c => { const local = Math.max(0, Math.min(1, (c.p - c.k / Math.max(1, c.n) * 0.6) * 2.6)); return { y: -local * 2.6 * c.e, s: 1 + local * 0.03 * c.e }; } },
    { id: 'chorusRipple', chars: true, special: true, grows: true,
      f: c => ({ s: 1 + c.e * 0.012 }),
      fc: c => { const wave = Math.sin((c.p * 2.2 - 0.6) * Math.PI - c.k * 0.85); return { s: 1 + wave * 0.035 * c.e, y: -wave * 0.9 * c.e }; } },
    // Chorus tilt: static lean reduced (±2.1deg was a hard angle), now a
    // slight lean that eases through the syllable.
    { id: 'chorusTilt', special: true, f: c => ({ r: (c.parity ? 0.6 : -0.6) * c.e * (0.6 + 0.4 * Math.sin(c.p * Math.PI)), y: -c.e * 1.6, s: 1 + c.e * 0.018 }) },
    { id: 'chorusSwell', special: true, grows: true, f: c => ({ s: 1 + (0.3 + 0.7 * c.p) * 0.042 * c.e, y: -c.e * 1.5, x: Math.sin(c.p * Math.PI) * 0.9 * c.e }) },
    // --- Round two: hooks land harder, in the same band. ---------------------
    // An arc: rise through the word and come back down before the next one, so
    // a hook word reads as a shape rather than as a sustained elevation.
    { id: 'chorusArc', special: true, grows: true, f: c => { const b = Math.sin(c.p * Math.PI); return { y: -b * 1.8 * c.e, s: 1 + b * 0.022 * c.e, x: (c.parity ? 1 : -1) * b * 0.4 * c.e }; } },
    // The characters ring in sequence, like a word being struck left to right.
    { id: 'chorusRing', chars: true, special: true,
      f: c => ({ y: -c.e * 1.4 }),
      fc: c => { const local = Math.max(0, Math.min(1, c.p * 1.6 - c.k * 0.25)); return { y: -Math.sin(local * Math.PI) * 1.4 * c.e, s: 1 + c.e * 0.01 }; } }
  ],

  // --- Chorus + long held note -------------------------------------------
  // 'chorusRise' (per-character staircase that also rotated alternating
  // characters) and 'chorusSpin' (±2.6deg spin) were removed outright: on a
  // held note they read as cartoon letter gymnastics rather than emphasis.
  // What remains lifts the whole word as one body, letting the character
  // offsets ride a gentle wave instead of jumping.
  chorusHold: [
    { id: 'chorusChant', chars: true, special: true,
      f: c => ({ y: -c.e * 1.5 }),
      fc: c => ({ y: -c.e * 1.1, s: 1 + c.e * 0.012 }) },
    { id: 'chorusWaveBig', chars: true, special: true, grows: true,
      f: c => ({ y: -c.e * 1.5 }),
      fc: c => ({ y: -c.e * 1.5 + Math.sin(c.p * Math.PI * 2 * 2.0 - c.k * 0.9) * c.e * 1.9 }) },
    // --- Round two: the pool had only two motions, so a chorus of held hooks
    // (which repeats) repeated itself. Both new ones hold the word as one body
    // and let the characters carry the variation.
    { id: 'chorusChime', chars: true, special: true,
      f: c => ({ y: -c.e * 1.5 }),
      fc: c => ({ s: 1 + Math.sin(c.p * Math.PI * 2 * 1.5 - c.k * 0.75) * 0.02 * c.e, y: -c.e * 0.4 }) },
    { id: 'chorusSway', special: true, f: c => ({ x: Math.sin(c.p * Math.PI * 2) * 0.9 * c.e, y: -c.e * 1.4, s: 1 + Math.sin(c.p * Math.PI) * 0.012 * c.e }) }
  ],

  // --- Short ad-libs (a word or two) -------------------------------------
  // The small italic asides used to share only three motions; the pool is now
  // wide enough that a backing-track run of ad-libs never repeats back to
  // back. All stay low-profile (they're asides, not hooks) with one gentle
  // spotlight. Several lean on per-character offsets via c.parity instead of
  // full char-splitting, so they stay cheap on these often-frequent lines.
  adlib: [
    { id: 'whisper', f: c => ({ y: -c.e * 0.7, s: 1 + c.e * 0.02 }) },
    { id: 'drop',    f: c => ({ s: 1 - c.e * 0.035, y: c.e * 0.6 }) },
    { id: 'slip',    special: true, f: c => ({ x: (0.5 - c.p) * 1.5 * c.e }) },
    { id: 'sigh',    f: c => ({ y: (0.4 + c.p * 0.9) * c.e - c.e * 0.3, s: 1 - c.p * 0.02 * c.e }) },
    { id: 'coo',     f: c => ({ y: -Math.sin(c.p * Math.PI) * 1.6 * c.e, s: 1 + Math.sin(c.p * Math.PI) * 0.018 * c.e }) },
    { id: 'dodge',   f: c => ({ x: (c.parity ? 1 : -1) * Math.sin(c.p * Math.PI) * 1.2 * c.e }) },
    { id: 'peek',    f: c => ({ y: -(1 - Math.min(1, c.p * 2)) * 1.4 * c.e, s: 1 + (1 - Math.min(1, c.p * 2)) * 0.015 * c.e }) },
    { id: 'murmur',  f: c => ({ y: Math.sin(c.t / 180) * 0.7 * c.e - c.e * 0.5, x: Math.cos(c.t / 260) * 0.6 * c.e }) },
    { id: 'swaylet', f: c => ({ r: (c.parity ? 1 : -1) * Math.sin(c.p * Math.PI) * 0.5 * c.e, y: -c.e * 0.6 }) },
    { id: 'flicker', f: c => ({ s: 1 + Math.sin(Math.min(1, c.p * 2.4) * Math.PI) * 0.022 * c.e, y: -c.e * 0.6 }), special: true },
    // --- Round two: the pool that needs the most variety. Ad-libs arrive in
    // runs (a backing track fires one every line or two), so a repeat is what
    // gives the whole section the same shake.
    { id: 'wisp',   f: c => ({ y: -c.e * 0.5, s: 1 + c.e * 0.012, x: Math.sin(c.p * Math.PI) * 0.7 * c.e }) },
    { id: 'nudge',  f: c => ({ x: (c.parity ? -1 : 1) * Math.sin(Math.min(1, c.p * 1.6) * Math.PI) * 0.9 * c.e }) },
    { id: 'settle', f: c => { const b = Math.exp(-c.p * 2.6); return { s: 1 - b * 0.018 * c.e, y: -Math.sin(c.p * Math.PI) * 0.5 * c.e }; } }
  ]
};

// Which pool applies to a syllable, based on its own timing and its line.
function variantPoolFor(sylDom, lDom) {
  const dur = sylDom.durationMs || 250;
  const chorus = !!(lDom && lDom.isChorus);
  if (lDom && lDom.isBackground) return MOTION_VARIANTS.backing;
  if (chorus && dur >= 1000) return MOTION_VARIANTS.chorusHold;
  if (chorus) return MOTION_VARIANTS.chorus;
  if (dur >= 1000) return MOTION_VARIANTS.hold;
  if (dur <= 200) return MOTION_VARIANTS.fast;
  if (lDom && lDom.isAdlib) return MOTION_VARIANTS.adlib;
  return MOTION_VARIANTS.normal;
}

// Stable per-syllable pick with a per-line budget on flashy variants. Each
// line gets roughly one spotlight (scales with line length), so "special"
// motions stay special instead of hammering every word; everything else gets a
// low-profile member of the same pool. Budget accounting is deterministic per
// line, so a line animates identically on every playthrough.
const QUIET_FALLBACKS = {
  normal: 'lift', fast: 'tick', hold: 'float',
  chorus: 'chorusBeat', chorusHold: 'chorusChant', adlib: 'coo', backing: 'ghost'
};

function pickVariant(lDom, sylDom, sIdx) {
  const pool = variantPoolFor(sylDom, lDom);
  if (!pool || pool.length === 0) return null;
  const poolName = pool === MOTION_VARIANTS.normal ? 'normal'
    : pool === MOTION_VARIANTS.fast ? 'fast'
    : pool === MOTION_VARIANTS.hold ? 'hold'
    : pool === MOTION_VARIANTS.backing ? 'backing'
    : pool === MOTION_VARIANTS.chorus ? 'chorus'
    : pool === MOTION_VARIANTS.chorusHold ? 'chorusHold'
    : 'adlib';

  const lineIdx = lDom.index || 0;
  // Rotating walk so neighbours never share a variant.
  let idx = (sIdx + lineIdx * 3) % pool.length;
  let v = pool[idx];

  // Budget: one spotlight per ~6 syllables, minimum 1, never more than 2 —
  // computed from THIS line's syllable count (the dynamic limit).
  // Dynamic limit: a line earns roughly one spotlight per ~7 syllables, so
  // longer lines can carry up to 3 flashy moments while short ones stay
  // restrained — the specials read as special instead of wallpaper.
  const lineSylCount = lDom.words.reduce((a, w) => a + w.syllables.length, 0);
  const budget = Math.min(3, Math.max(1, Math.round(lineSylCount / 7)));
  const specialsBefore = lDom.specialsUsed || 0;

  if (v.special && specialsBefore >= budget && !lDom.isChorus) {
    // Spotlight budget spent: rotate through the pool's quiet (non-special)
    // members instead of repeating one fallback, so restrained words still
    // vary across the line. Choruses are exempt — the whole point of a hook
    // is that every word lands.
    const quietPool = pool.filter(x => !x.special);
    if (quietPool.length > 0) {
      const startIdx = Math.max(0, quietPool.findIndex(x => x.id === QUIET_FALLBACKS[poolName]));
      v = quietPool[(startIdx + (lDom.quietCursor || 0)) % quietPool.length];
      lDom.quietCursor = (lDom.quietCursor || 0) + 1;
    }
  } else if (v.special && specialsBefore < budget) {
    lDom.specialsUsed = specialsBefore + 1;
  }

  return v;
}

// =========================================================
// Traveling Sine Wave Vibrato Engine
// =========================================================
function setSyllableState(sylDom, state, fillPct, progress = null, ms = null) {
  if (sylDom.state !== state) {
    sylDom.element.className = `syllable ${state}${sylDom.hasLetters ? ' has-letters' : ''}`;
    sylDom.state = state;
    if (state !== 'singing') {
      // Per-frame sway lives on the text layers; clear it on state change.
      sylDom.anticipation = '';
      // Only a waiting frame may set the lean, so a state that is not waiting
      // holds none — otherwise a later entry into the sung state (a timestamp
      // correction, a jump back into a line) could re-invent a lean the word
      // does not have and snap with it.
      sylDom.leanBias = 0;
      sylDom.leanCarry = 0;
      if (sylDom.baseEl) sylDom.baseEl.style.transform = '';
      if (sylDom.highlightEl) sylDom.highlightEl.style.transform = '';
      if (sylDom.baseChars && sylDom.baseChars.length > 0) {
        for (let c = 0; c < sylDom.numChars; c++) {
          if (sylDom.baseChars[c]) sylDom.baseChars[c].style.transform = '';
          if (sylDom.highlightChars[c]) sylDom.highlightChars[c].style.transform = '';
        }
      }
    } else {
      // Entering the sung motion: keep the lean the waiting frames reached and
      // let the sung frames release it (see leanRelease). Spent either way —
      // this is a handoff between two states, not a value that lives on.
      sylDom.leanCarry = sylDom.leanBias || 0;
      sylDom.leanBias = 0;
    }
  }

  if (fillPct !== null) {
    // --fill is a unitless 0..1 fraction; the CSS mask does the padding math.
    const fill = Math.max(0, Math.min(1, fillPct / 100));
    // Skip redundant writes: each one invalidates the mask and forces a repaint.
    if (sylDom.fill !== fill) {
      sylDom.highlightEl.style.setProperty('--fill', fill.toFixed(4));
      sylDom.fill = fill;
    }
  }

  // Per-letter timing: drive each glyph's own mask instead of the syllable-wide fill.
  if (sylDom.hasLetters) {
    if (state === 'passed') {
      for (let c = 0; c < sylDom.numChars; c++) setCharFill(sylDom, c, 1);
    } else if (state === 'future') {
      for (let c = 0; c < sylDom.numChars; c++) setCharFill(sylDom, c, 0);
    } else if (state === 'singing' && typeof ms === 'number') {
      for (let c = 0; c < sylDom.numChars; c++) {
        const L = sylDom.letters[c];
        let f;
        if (!L || !Number.isFinite(L.startTimeMs) || !Number.isFinite(L.endTimeMs)) {
          f = (fillPct || 0) / 100;
        } else if (ms >= L.endTimeMs) {
          f = 1;
        } else if (ms <= L.startTimeMs) {
          f = 0;
        } else {
          f = (ms - L.startTimeMs) / (L.endTimeMs - L.startTimeMs);
        }
        setCharFill(sylDom, c, f);
      }
    }
  }

  // The lead-in to the word. Written every frame rather than on the state
  // change, because a waiting syllable's state does not change while it waits;
  // the cached string keeps a still syllable from touching the DOM at all.
  if (state === 'future' && !reducedMotion) {
    const bias = anticipationBias(sylDom, ms);
    sylDom.leanBias = bias; // what the sung frame takes over from
    const lead = leanTransform(bias, leanAmp());
    if (lead !== sylDom.anticipation) {
      sylDom.anticipation = lead;
      if (sylDom.baseEl) sylDom.baseEl.style.transform = lead;
      if (sylDom.highlightEl) sylDom.highlightEl.style.transform = lead;
    }
  }

  if (state === 'singing' && !reducedMotion) {
    const envelope = progress !== null ? Math.sin(progress * Math.PI) : 1.0;
    const dur = sylDom.durationMs || (sylDom.isExtended ? 900 : 250);
    const t = (typeof ms === 'number') ? ms : performance.now();
    const p = progress !== null ? progress : 0.5;

    // Amplitude is tied to duration so quick syllables stay crisp instead of
    // jittering, and faded by `envelope` so a variant eases in and out instead
    // of snapping on at full strength when the timestamp hits.
    const ctx = {
      e: envelope * Math.min(1, dur / 520),
      e0: envelope,
      p: p,
      t: t,
      d: dur,
      k: 0,
      n: sylDom.numChars || 1,
      parity: sylDom.parity || 0
    };

    // The style dial scales every variant uniformly, and the section drive
    // nudges it with the song's envelope, so the pools never have to know about
    // either. Clamps keep "wild" energetic instead of seasick.
    const amp = motionScaleFactor() * sectionDrive;
    const scaleOf = (s) => Math.max(0.82, Math.min(1.38, 1 + (s - 1) * amp)).toFixed(3);
    const xy = (v, limit) => Math.max(-limit, Math.min(limit, v * amp)).toFixed(2);
    const rotOf = (r) => Math.max(-9, Math.min(9, r * amp)).toFixed(3);

    const buildTransform = (o) => {
      const parts = [];
      if (o.x || o.y) parts.push(`translate3d(${xy(o.x || 0, 12)}px, ${xy(o.y || 0, 14)}px, 0)`);
      if (o.r) parts.push(`rotate(${rotOf(o.r)}deg)`);
      if (o.s) parts.push(`scale(${scaleOf(o.s)})`);
      return parts.length ? parts.join(' ') : '';
    };

    const variant = sylDom.variant;
    if (variant) {
      // Composed OUTSIDE the variant, so the lean keeps lifting the word
      // straight up in the page's frame however the variant is rotating it.
      const lean = leanRelease(sylDom, ms, dur);
      const motion = buildTransform(variant.f(ctx));
      const layerTransform = lean && motion ? lean + ' ' + motion : (lean || motion);

      // Applied to both text layers so base and highlight stay in lockstep.
      if (sylDom.baseEl) sylDom.baseEl.style.transform = layerTransform;
      if (sylDom.highlightEl) sylDom.highlightEl.style.transform = layerTransform;

      // Character-level variants (long holds, chorus ripples) ride on top.
      if (variant.fc && sylDom.numChars > 1) {
        for (let c = 0; c < sylDom.numChars; c++) {
          ctx.k = c;
          const transformStr = buildTransform(variant.fc(ctx));
          if (sylDom.baseChars[c]) sylDom.baseChars[c].style.transform = transformStr;
          if (sylDom.highlightChars[c]) sylDom.highlightChars[c].style.transform = transformStr;
        }
        ctx.k = 0;
      }
    }
  }
}

// =========================================================
// Instrumental break countdown
// Long instrumental sections used to look like a frozen app: nothing was being
// sung and nothing on screen moved. A quiet countdown fills those breaks.
// =========================================================
const GAP_MIN_MS = 3200;
// How early the arrival is played. The value reads 0:00 for its final second, so
// this has to stay inside that second or the pop would fire before the countdown
// said so. It is 700 rather than 0 so the pop (460 ms) and the row collapse are
// both finished by the time the next line is actually sung, and so a dropped
// frame cannot miss the window entirely.
const GAP_ARRIVE_MS = 700;
// Keep in sync with .gap-exit in style.css — the pop and the shrink are one
// animation there, and this is how long it runs before the element is detached.
const GAP_EXIT_MS = 460;
let lastGapSecond = -1;
let gapChip = null;      // the live chip; see the re-insert note in ensureGapChip
let gapSpanMs = 0;       // remaining ms when it appeared, minus the arrival window
let gapSpanIdx = -1;     // the next line the span was measured against
let gapArrived = false;  // the pop has run; only the shrink is left

function formatCountdown(ms) {
  // Whole seconds remaining. Was a ceil, which meant the countdown stalled at
  // 0:01 and was torn down before it ever reached 0:00 — the value never
  // "arrived" at the line it was counting to.
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const GAP_CHIP_HTML = '<span class="gap-dot"></span><span class="gap-dot"></span>' +
  '<span class="gap-dot"></span><span class="gap-value">0:00</span>';

function hideGapIndicator() {
  // Instant teardown, for the paths that are about to replace the whole lyric
  // flow anyway — animating a chip out of a container being wiped is pointless.
  lastGapSecond = -1;
  gapChip = null;
  gapSpanMs = 0;
  gapSpanIdx = -1;
  gapArrived = false;
  // Every chip, not just the first: nothing should be able to leave one behind.
  document.querySelectorAll('.gap-indicator').forEach(el => el.remove());
  document.body.classList.remove('gap-active');
}

// Inserts the chip into the lyric flow, opening the row it occupies rather than
// dropping into it, and without disturbing a chip that is already in place.
function ensureGapChip(nextLineElement) {
  // Adopt whatever chip is already in the tree rather than building another one:
  // at most one chip can ever be mounted. A single frame of jitter that flipped
  // the show condition off and back on used to leave two chips stacked in the
  // flow, then three — each one mid-exit and overlapping the next.
  let el = (gapChip && gapChip.isConnected) ? gapChip : document.getElementById('gap-indicator');
  const revived = !!el && el !== gapChip;
  const fresh = !el;
  if (fresh) {
    el = document.createElement('div');
    el.id = 'gap-indicator';
    el.className = 'gap-indicator';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = GAP_CHIP_HTML;
    gapChip = el;
  } else if (revived) {
    // Was on its way out but the gap is still live: pull it back instead of
    // stacking a second chip beside it. Dropping the exit classes restores the
    // enter animation, so it fades back in rather than snapping.
    gapChip = el;
    el.classList.remove('leaving', 'arrived', 'sizing');
    el.style.height = '';
  }

  // Only move the element when it is not already sitting in the right place.
  // Re-inserting a node that has not moved restarts its CSS animations, which is
  // why the old dots visibly stuttered once a second: the whole chip was being
  // re-inserted on every tick of the countdown.
  const parent = nextLineElement ? nextLineElement.parentNode : null;
  if (parent === container && el.nextElementSibling !== nextLineElement) {
    container.insertBefore(el, nextLineElement);
  } else if (!el.isConnected) {
    container.appendChild(el);
  }
  if (!el.classList.contains('visible')) el.classList.add('visible');

  if (fresh || revived) {
    if (container) document.body.classList.add('gap-active');
    // Measure at its natural height, then hand the row its growth: 0 -> measured.
    // The transition is suppressed for the collapse to zero, because `auto` is
    // not an interpolable height: left to transition it would sit at full height
    // for half the duration and only then snap, which is the jump we are
    // removing. The 0 -> measured step is two lengths, so it animates cleanly.
    el.style.height = 'auto';
    const natural = el.offsetHeight;
    el.classList.add('sizing');
    el.style.transition = 'none';
    el.style.height = '0px';
    el.offsetHeight; // commit the zero-height frame before growing
    el.style.transition = '';
    // Back to natural sizing once it is open, so a fullscreen toggle resizing
    // the dots cannot clip against a stale pixel height.
    el.addEventListener('transitionend', function onGrow(event) {
      if (event.propertyName !== 'height') return;
      el.removeEventListener('transitionend', onGrow);
      if (!el.classList.contains('arrived') && !el.classList.contains('leaving')) {
        el.style.height = '';
        el.classList.remove('sizing');
      }
    });
    requestAnimationFrame(() => {
      if (el.isConnected && el.style.height === '0px') {
        el.style.height = `${natural}px`;
      }
    });
  }
  return el;
}

// Smooth exit for the cases that are NOT the countdown finishing: a pause, a
// seek, or a different gap. Shrinks the row back to nothing so the line below
// slides up instead of jumping.
function closeGapChip() {
  const el = gapChip;
  gapChip = null;
  gapSpanMs = 0;
  gapSpanIdx = -1;
  const arrived = gapArrived;
  gapArrived = false;
  lastGapSecond = -1;
  document.body.classList.remove('gap-active');
  if (!el || !el.isConnected) return;
  if (arrived) {
    // The pop-and-shrink is already running on its own timing; just outlive it.
    setTimeout(() => el.remove(), GAP_EXIT_MS);
    return;
  }
  el.classList.remove('sizing');
  el.classList.add('leaving', 'sizing');
  el.style.height = '0px';
  setTimeout(() => el.remove(), GAP_EXIT_MS);
}

function updateGapIndicator(ms) {
  if (!container) return;

  let nextIdx = -1;
  let singing = false;
  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    // Same activity window renderProgress uses, so the countdown can never
    // appear on top of a line that is currently being sung.
    if (ms >= line.startTimeMs - 160 && ms < line.endTimeMs + 260) singing = true;
    if (nextIdx === -1 && line.startTimeMs > ms) nextIdx = i;
    // Lines are ordered, so nothing after this point can be singing or next.
    if (nextIdx !== -1 && line.startTimeMs - 160 > ms) break;
  }

  const remaining = nextIdx >= 0 ? (lyrics[nextIdx].startTimeMs - ms) : Infinity;

  // Worth showing? That is a question about the LENGTH of the break, not about
  // how much is left in it. Testing `remaining` instead meant the chip was torn
  // down with 3.2 s still to go, so its countdown stopped at 0:03, the meter
  // never filled, and the last few seconds of every break went uncounted. The
  // break itself is measured from the end of the previous line's activity
  // window, which is where the silence actually starts.
  const gapStartMs = nextIdx > 0 ? lyrics[nextIdx - 1].endTimeMs + 260 : 0;
  const gapLengthMs = nextIdx > 0 ? lyrics[nextIdx].startTimeMs - gapStartMs : 0;

  // Two different questions, answered differently on purpose:
  //
  //   * may it START? Only with real headroom left, or a chip mounts for the
  //     last few hundred ms of a break and leaves again before its own enter
  //     animation has finished;
  //   * does it STAY? For as long as the break does. Once it is up, its
  //     countdown always runs to the end and plays the arrival.

  // Only meaningful between two lines: the intro has its own dots, and a pause
  // should not be advertised while the transport is stopped.
  const showing = isPlaying && !singing && nextIdx > 0 && gapLengthMs > GAP_MIN_MS
    && (!!gapChip || remaining > GAP_MIN_MS);

  if (!showing) {
    if (gapChip) closeGapChip();
    return;
  }

  // A gap that skipped to a different next line (a seek) restarts its own meter.
  if (gapChip && gapSpanIdx !== nextIdx) closeGapChip();

  const nextDom = lyricDom[nextIdx];
  const el = ensureGapChip(nextDom && nextDom.element);
  if (!el) return;

  if (gapSpanIdx !== nextIdx || gapSpanMs <= 0) {
    gapSpanIdx = nextIdx;
    gapSpanMs = Math.max(1, remaining - GAP_ARRIVE_MS);
    gapArrived = false;
  }

  // Fill spans exactly the chip's own lifetime, so the meter reads full at the
  // same moment the value reads 0:00 and the line begins.
  const progress = Math.min(1, Math.max(0, 1 - (remaining - GAP_ARRIVE_MS) / gapSpanMs));
  el.style.setProperty('--gap-progress', progress.toFixed(3));

  const second = Math.floor(remaining / 1000);
  if (second !== lastGapSecond) {
    lastGapSecond = second;
    const value = el.querySelector('.gap-value');
    if (value) value.textContent = formatCountdown(remaining);
  }

  // Full meter on the final second: grow a touch, then shrink out of sight. The
  // line does not start for another ~260 ms, so the exit is driven from here
  // rather than waiting to be told the gap is over.
  if (!gapArrived && progress >= 1) {
    gapArrived = true;
    // Collapse the row on the same clock as the pop, so the line below slides up
    // while the chip shrinks instead of waiting for the element to be detached.
    el.classList.add('arrived', 'sizing');
    el.style.height = '0px';
  }
}

function resetLineToFuture(lDom) {
  if (!lDom) return;
  lDom.isPassed = false;
  for (let wIdx = 0; wIdx < lDom.words.length; wIdx++) {
    const wDom = lDom.words[wIdx];
    for (let sIdx = 0; sIdx < wDom.syllables.length; sIdx++) {
      setSyllableState(wDom.syllables[sIdx], 'future', 0);
    }
  }
}

// Used on hard playhead jumps / seeks so no stale "sung" styling survives.
function resetAllLines() {
  for (let i = 0; i < lyricDom.length; i++) resetLineToFuture(lyricDom[i]);
  lastRenderEnd = 0;
  lastActiveSig = "";
}

window.loadLyrics = function(data, title, artist, sourceName, initialElapsedMs, trackKey, savedLatencyOffset, plan) {
  wakeRenderLoop();
  try {
    const titleEl = document.getElementById('title');
    const artistEl = document.getElementById('artist');

    if (titleEl) titleEl.textContent = title;
    if (artistEl) artistEl.textContent = artist;
    const sideTitleEl = document.getElementById('side-title');
    if (sideTitleEl) sideTitleEl.textContent = title;
    const sideArtistEl = document.getElementById('side-artist');
    if (sideArtistEl) sideArtistEl.textContent = artist;

    currentTrackKey = trackKey || "";
    // What the local-TTML panel acts on: the library keys bindings on the
    // title/artist/album/duration the resolver sees, so keep them here.
    currentTrackMeta = { title: title || "", artist: artist || "" };
    if (document.body.classList.contains('settings-open')) refreshTtml();
    latencyOffsetMs = (typeof savedLatencyOffset === 'number' && !isNaN(savedLatencyOffset)) ? savedLatencyOffset : DEFAULT_LATENCY_MS;
    if (window.renderLatencySlider) window.renderLatencySlider();
    syncSettingsPanel();

    playheadMs = typeof initialElapsedMs === 'number' ? initialElapsedMs : 0;
    targetDriftMs = 0;
    anchorPosMs = playheadMs;
    anchorWallMs = performance.now();
    lastDisplayedSecond = -1;
    updateTimer(playheadMs);

    activeLineIdx = -1;
    lastActiveSig = "";
    lastRenderEnd = 0;
    userScrolledRecently = false;
    scrollVelocity = 0;
  // Fresh track: clear per-second throttle state so the on-art/side fills
  // always repaint, even if the new track starts at the same second.
  lastSideFillSecond = -1;
  lyrics = [];
  lyricDom = [];
  hideGapIndicator();

    if (!container) return;
    cancelViewFade();
    container.replaceChildren();

    if (!data || data.length === 0) {
      const box = document.createElement('div');
      box.className = 'lyrics-empty';
      const icon = document.createElement('div');
      icon.className = 'lyrics-empty-icon';
      const msg = document.createElement('div');
      msg.className = 'lyrics-empty-text';
      msg.textContent = 'No lyrics available for this track';
      const hint = document.createElement('div');
      hint.className = 'lyrics-empty-hint';
      hint.textContent = 'The resolver could not find a synced source.';
      box.appendChild(icon);
      box.appendChild(msg);
      box.appendChild(hint);
      container.appendChild(box);
      fadeInView();
      return;
    }

    lyrics = data.map(line => {
      line.words = prepareLineFallbackWords(line);

      // Connect words across natural pauses so the wipe glides continuously without teleporting
      const allSyllables = [];
      line.words.forEach(w => w.syllables.forEach(s => allSyllables.push(s)));
      for (let k = 0; k < allSyllables.length - 1; k++) {
        const cur = allSyllables[k];
        const next = allSyllables[k + 1];
        const gap = next.startTimeMs - cur.endTimeMs;
        if (gap > 0 && gap <= MAX_GAP_BRIDGE_MS) {
          cur.endTimeMs = next.startTimeMs; // Seamlessly hand off to the next word
        }
      }

      return line;
    });

    // Structure pass: hooks (repeated lines) get their own animation pool, and
    // one/two-word asides are treated as ad-libs.
    const chorusLineCount = detectChorusSections(lyrics);

    const dotsEl = document.createElement('div');
    dotsEl.className = 'intro-dots';
    dotsEl.id = 'intro-dots';
    dotsEl.appendChild(document.createElement('span')).className = 'dot';
    dotsEl.appendChild(document.createElement('span')).className = 'dot';
    dotsEl.appendChild(document.createElement('span')).className = 'dot';
    container.appendChild(dotsEl);

    lyricDom = lyrics.map((line, lIdx) => {
      const lineDiv = document.createElement('div');
      lineDiv.className = 'line'
        + (line.isBackground ? ' backing-vocal' : '')
        + (line.isChorus ? ' is-chorus' : '')
        + (line.isAdlib ? ' is-adlib' : '');
      lineDiv.id = `line-${lIdx}`;
      // Keyboard seeking: lines are focusable buttons for assistive tech, but
      // only the active line is a tab stop (roving tabindex). Giving every line
      // tabIndex=0 made a 150-line song 150 tab stops between the header and the
      // transport. updateLineDepthOfField sets the active line back to 0.
      lineDiv.tabIndex = -1;
      lineDiv.setAttribute('role', 'button');
      const activateLine = (e) => {
        e.stopPropagation();
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        const targetSeekMs = Math.max(0, line.startTimeMs - latencyOffsetMs);
        playheadMs = targetSeekMs;
        targetDriftMs = 0;
        anchorPosMs = targetSeekMs;
        anchorWallMs = performance.now();
        // Open the guard window: bridge readings for the next ~900 ms are
        // pre-seek echoes of the old position, not corrections.
        lastUserSeekAt = performance.now();
        userScrolledRecently = false;
        resetAllLines();
        activeLineIdx = lIdx;
        lastActiveSig = String(lIdx);
        updateLineDepthOfField([lIdx]);
        scrollToActiveCluster([lIdx]);
        if (window.pywebview && window.pywebview.api) {
          window.pywebview.api.seek_position(targetSeekMs);
        }
      };
      // Only the words are a seek target. A line is a full-width block with
      // generous leading plus a 28px margin, so most of its box has no glyphs on
      // it — and seeking from a click in that empty band is what made the space
      // right below the track-details strip feel like it belonged to the lyrics
      // (the card's leading sat over the first line's blank top). Anything that
      // is not inside a word group, or the translation line, is not a seek.
      lineDiv.onclick = (e) => {
        const target = e.target;
        const onWord = !!(target && target.closest && target.closest('.word-group, .line-secondary'));
        if (!onWord) return;
        activateLine.call(lineDiv, e);
      };
      lineDiv.onkeydown = activateLine;

      const wordsDom = line.words.map((w, wIdx) => {
        const wordSpan = document.createElement('span');
        wordSpan.className = 'word-group';
        wordSpan.id = `w-${lIdx}-${wIdx}`;

        const syllablesDom = w.syllables.map((s, sIdx) => {
          const sylSpan = document.createElement('span');
          sylSpan.className = 'syllable future';
          sylSpan.id = `s-${lIdx}-${wIdx}-${sIdx}`;

          const baseSpan = document.createElement('span');
          baseSpan.className = 'syllable-base';
          baseSpan.textContent = s.text;

          const highlightSpan = document.createElement('span');
          highlightSpan.className = 'syllable-highlight';
          highlightSpan.textContent = s.text;

          sylSpan.appendChild(baseSpan);
          sylSpan.appendChild(highlightSpan);
          wordSpan.appendChild(sylSpan);

          // Glyphs are NOT split here: most lines are never on screen, and a long
          // song would otherwise build tens of thousands of spans up front. Each
          // line splits itself the first time it enters the render window.
          const rawLetters = Array.isArray(s.letters) ? s.letters : null;

          return {
            element: sylSpan,
            baseEl: baseSpan,
            highlightEl: highlightSpan,
            baseChars: [],
            highlightChars: [],
            numChars: Array.from(s.text).length,
            state: 'future',
            fill: 0,
            isExtended: s.isExtended,
            durationMs: Math.max(150, (s.endTimeMs - s.startTimeMs) || 0),
            startTimeMs: s.startTimeMs,
            endTimeMs: s.endTimeMs,
            motionD0: 0,
            motionW: 0,
            hasLetters: false,
            hydrated: false,
            letters: null,
            pendingLetters: rawLetters,
            text: s.text
          };
        });

        lineDiv.appendChild(wordSpan);

        if (wIdx < line.words.length - 1) {
          const spaceSpan = document.createElement('span');
          spaceSpan.className = 'word-space';
          spaceSpan.textContent = ' ';
          lineDiv.appendChild(spaceSpan);
        }

        return {
          element: wordSpan,
          syllables: syllablesDom
        };
      });

      // Subordinate translation / transliteration layer (hidden when toggled off).
      const secondaryText = line.translation || line.transliteration || "";
      if (secondaryText && !line.isBackground) {
        const sec = document.createElement('div');
        sec.className = 'line-secondary';
        sec.textContent = secondaryText;
        lineDiv.appendChild(sec);
      }

      container.appendChild(lineDiv);

      return {
        element: lineDiv,
        index: lIdx,
        isActive: false,
        isPassed: false,
        isChorus: !!line.isChorus,
        isAdlib: !!line.isAdlib,
        isBackground: !!line.isBackground,
        specialsUsed: 0,
        hydrated: false,
        dofTier: null,
        words: wordsDom
      };
    });

    // Reported in Diagnostics so the pools can be verified per track.
    chorusCount = chorusLineCount;

    // Beat-synced pulse: adopt the rhythm plan resolved on the Python side
    // (core/beat.py) and (re)start the engine. A track with too little
    // rhythmic evidence to justify a pulse arrives as null and stays silent.
    beatPlan = (plan && Array.isArray(plan.runs) && plan.runs.length > 0) ? plan : null;
    beatBpm = beatPlan ? beatPlan.bpm : 0;
    startBeatEngine();
    // The moments are derived here, where both inputs exist: the rhythm plan and
    // the freshly flagged chorus lines. A track change therefore rebuilds them in
    // the same move that rebuilds the pulse.
    startMomentEngine();

    applySecondaryVisibility();
    // The card now shows this track's title/artist, so its height may have changed.
    syncLyricsClearance();
    updateLineDepthOfField([0]);
    scrollToActiveCluster([0]);
    // renderProgress materializes (and measures) its own window, then paints it.
    renderProgress(playheadMs + latencyOffsetMs);
    fadeInView();
  } catch (err) {
    console.error("Error in loadLyrics:", err);
  }
};

window.setPlaybackState = function(playing) {
  wakeRenderLoop();   // paused->playing resumes the loop; the reverse closes the chip
  const now = performance.now();

  if (playing && !isPlaying) {
    // Resuming: re-anchor from wherever the highlight currently sits.
    anchorPosMs = playheadMs;
    anchorWallMs = now;
    targetDriftMs = 0;
  } else if (!playing && isPlaying) {
    // Pausing: freeze at the wall-clock position before we stop advancing.
    playheadMs = predictedPlayhead();
  }

  isPlaying = playing;
  // A paused transport stops the render loop, and the countdown chip is only ever
  // taken down from inside it — so pausing mid-break used to leave a chip sitting
  // there with its count frozen. Close it on the pause transition instead; the
  // exit animation is CSS, so it still plays with the loop idle.
  if (!isPlaying && gapChip) closeGapChip();
  // Icon swap is CSS-driven (two SVGs); never render emoji glyphs, which Windows
  // paints with its blue emoji presentation instead of our theme colour.
  playBtns.forEach(b => b.classList.toggle('is-playing', isPlaying));
  // The beat pulse follows playback: a paused track should not keep glowing.
  document.body.classList.toggle('beat-paused', !isPlaying);
  lastTick = now;
};

// Wall-clock instant of the last user-initiated seek, and how long the bridge's
// position readings are distrusted afterwards. Windows takes a few hundred ms to
// dispatch a seek into the player, during which the reported position is still
// the PRE-seek one — obeying it snapped the lyrics back to where they came from
// before jumping to the target.
const SEEK_GUARD_MS = 900;
let lastUserSeekAt = -Infinity;

window.syncPlayhead = function(ms) {
  if (typeof ms !== 'number' || isNaN(ms)) return;
  wakeRenderLoop();   // a paused overlay must still obey external corrections

  const now = performance.now();
  if (now - lastUserSeekAt < SEEK_GUARD_MS) return;   // pre-seek echo: ignore

  const predicted = isPlaying ? predictedPlayhead() : playheadMs;
  if (ms <= 0 && predicted > 2000) return;

  const diff = ms - predicted;

  if (Math.abs(diff) > 900) {
    // Hard correction (seek / large drift): re-anchor and clear stale lyric states.
    anchorPosMs = ms;
    anchorWallMs = now;
    targetDriftMs = 0;
    playheadMs = ms;
    updateTimer(playheadMs);
    resetAllLines();
    renderProgress(playheadMs + latencyOffsetMs);
  } else if (Math.abs(diff) > 75) {
    // Small correction: re-anchor to the reported position, but ease the
    // *display* into it. The anchor absorbs the full correction now (the
    // trajectory is fixed and never reverts) and a cancelling drift term decays,
    // so the wipe glides across the gap instead of stepping. Folding the diff
    // into the decaying drift alone — the old behaviour — applied the
    // correction and then took it back, so any steady offset (a stale SMTC
    // snapshot, a brief buffering stall) re-triggered on every one-second
    // heartbeat and the lyric stuttered, visibly slowing, once per second.
    anchorPosMs += diff;
    anchorWallMs = now;
    targetDriftMs = -diff;
    if (!isPlaying) {
      // Paused there is no advancing wipe to ease: land directly.
      targetDriftMs = 0;
      playheadMs = anchorPosMs;
      updateTimer(playheadMs);
    }
  }
};

function renderProgress(ms) {
  if (!lyrics || lyrics.length === 0 || !lyricDom || lyricDom.length === 0) return;

  updateGapIndicator(ms);
  // Art pulse runs only inside the plan's driven runs (see core/beat.py).
  updateBeatLive(ms);
  // Moments read the same plan and the same playhead, so they belong on the same
  // frame as the pulse rather than on a timer of their own.
  updateMoment(ms);
  // Same plan, same frame: the words' amplitude follows the section envelope.
  updateSectionDrive(ms);

  const introDots = document.getElementById('intro-dots');
  const isIntro = (lyrics.length > 0 && ms < lyrics[0].startTimeMs);

  if (isIntro) {
    if (introDots) introDots.style.display = 'flex';
    if (lastActiveSig !== "-1") {
      lastActiveSig = "-1";
      activeLineIdx = -1;
      updateLineDepthOfField([]);
      scrollToActiveCluster([0]);
    }
    lastRenderEnd = 0;
    return;
  } else {
    if (introDots) introDots.style.display = 'none';
  }

  const currentActiveIndices = [];
  const leadActiveIndices = [];
  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    if (ms >= line.startTimeMs - 160 && ms < line.endTimeMs + 260) {
      currentActiveIndices.push(i);
      if (!line.isBackground) leadActiveIndices.push(i);
    }
  }

  if (currentActiveIndices.length > 0) {
    const sig = currentActiveIndices.join(',');
    if (sig !== lastActiveSig) {
      lastActiveSig = sig;
      activeLineIdx = currentActiveIndices[0];
      updateLineDepthOfField(currentActiveIndices);
      // Background vocals never steal the scroll anchor while a lead line is active.
      scrollToActiveCluster(leadActiveIndices.length > 0 ? leadActiveIndices : currentActiveIndices);
    }
    // Size-changing variants (hop/swell/bloom/leap…) read better with room.
    // Instead of shoving neighbours sideways, the WHOLE line joins in: the
    // active line gets a gentle breathing cycle and its neighbours part
    // vertically a few pixels — CSS keyframes on the standalone translate
    // property, so the depth-of-field inline transform stays untouched.
    // Only applied when the active line actually contains a growing variant,
    // so plain lines never move their neighbours.
    const prev = lyricDom[activeLineIdx - 1];
    const next = lyricDom[activeLineIdx + 1];
    const growsSomewhere = (l) => l && l.words.some(w => w.syllables.some(s => s.variant && s.variant.grows));
    const wantPart = growsSomewhere(lyricDom[activeLineIdx]);
    const activeEl = lyricDom[activeLineIdx].element;
    if (activeEl) activeEl.classList.toggle('has-growing', wantPart);
    if (prev && prev.element) prev.element.classList.toggle('part-up', wantPart);
    if (next && next.element) next.element.classList.toggle('part-down', wantPart);
    // When the active line changes, the previous active line's classes must
    // clear — otherwise a line that grew earlier keeps breathing forever.
    if (lastPartingLine !== -1 && lastPartingLine !== activeLineIdx) {
      const old = lyricDom[lastPartingLine];
      if (old && old.element) old.element.classList.remove('has-growing');
    }
    lastPartingLine = activeLineIdx;
  } else {
    // No active line: clear any stray parting classes from a previous line.
    for (let i = 0; i < lyricDom.length; i++) {
      const el = lyricDom[i] && lyricDom[i].element;
      if (el && (el.classList.contains('part-up') || el.classList.contains('part-down') || el.classList.contains('has-growing'))) {
        el.classList.remove('part-up', 'part-down', 'has-growing');
      }
    }
    lastPartingLine = -1;
  }

  const renderStart = Math.max(0, (activeLineIdx >= 0 ? activeLineIdx - 2 : 0));
  // Before the first active line the window stays small on purpose: materializing
  // every line up front would undo the lazy glyph splitting.
  const renderEnd = activeLineIdx >= 0
    ? Math.min(lyrics.length, activeLineIdx + 4)
    : Math.min(lyrics.length, 6);

  // Materialize the window. Splitting + width measurement happens once per line.
  for (let lIdx = renderStart; lIdx < renderEnd; lIdx++) {
    hydrateLine(lyricDom[lIdx]);
  }

  // Backward seek / rewind: lines past the new window must revert to unsung.
  const resetStop = Math.min(lastRenderEnd - 1, lyrics.length - 1);
  for (let lIdx = renderEnd; lIdx <= resetStop; lIdx++) {
    const lDom = lyricDom[lIdx];
    if (lDom && lDom.isPassed) resetLineToFuture(lDom);
  }

  for (let lIdx = 0; lIdx < renderStart; lIdx++) {
    const lDom = lyricDom[lIdx];
    if (!lDom.isPassed) {
      for (let wIdx = 0; wIdx < lDom.words.length; wIdx++) {
        const wDom = lDom.words[wIdx];
        for (let sIdx = 0; sIdx < wDom.syllables.length; sIdx++) {
          setSyllableState(wDom.syllables[sIdx], 'passed', 100);
        }
      }
      lDom.isPassed = true;
    }
  }

  for (let lIdx = renderStart; lIdx < renderEnd; lIdx++) {
    const line = lyrics[lIdx];
    const lDom = lyricDom[lIdx];
    if (!lDom) continue;

    const isLineActive = currentActiveIndices.includes(lIdx);

    if (isLineActive) {
      lDom.isPassed = false;
      // One continuous leading-edge position feeds every syllable on the line.
      const p = lDom.motion ? lineDistanceAt(lDom.motion, ms) : null;

      for (let wIdx = 0; wIdx < line.words.length; wIdx++) {
        const w = line.words[wIdx];
        const wDom = lDom.words[wIdx];
        for (let sIdx = 0; sIdx < w.syllables.length; sIdx++) {
          const s = w.syllables[sIdx];
          const sDom = wDom.syllables[sIdx];

          const sStart = s.startTimeMs;
          let fillPct;
          if (p !== null && sDom.motionW > 0) {
            fillPct = ((p - sDom.motionD0) / sDom.motionW) * 100;
          } else {
            // Fallback when layout widths were unavailable.
            const sEnd = (s.endTimeMs && s.endTimeMs > sStart) ? s.endTimeMs : sStart + 350;
            fillPct = ((ms - sStart) / (sEnd - sStart)) * 100;
          }
          const fill = Math.max(0, Math.min(100, fillPct));

          if (ms < sStart) {
            // ms is what lets the word lean in just before it is sung.
            setSyllableState(sDom, 'future', 0, null, ms);
          } else if (fill >= 100) {
            setSyllableState(sDom, 'passed', 100);
          } else {
            setSyllableState(sDom, 'singing', fill, fill / 100, ms);
          }
        }
      }
    } else if (ms >= line.endTimeMs) {
      if (!lDom.isPassed) {
        for (let wIdx = 0; wIdx < lDom.words.length; wIdx++) {
          const wDom = lDom.words[wIdx];
          for (let sIdx = 0; sIdx < wDom.syllables.length; sIdx++) {
            setSyllableState(wDom.syllables[sIdx], 'passed', 100);
          }
        }
        lDom.isPassed = true;
      }
    } else {
      lDom.isPassed = false;
      for (let wIdx = 0; wIdx < lDom.words.length; wIdx++) {
        const wDom = lDom.words[wIdx];
        for (let sIdx = 0; sIdx < wDom.syllables.length; sIdx++) {
          setSyllableState(wDom.syllables[sIdx], 'future', 0);
        }
      }
    }
  }

  lastRenderEnd = renderEnd;
}

window.adjustLatency = function(deltaMs) {
  if (typeof deltaMs !== 'number' || isNaN(deltaMs)) return;

  latencyOffsetMs = Math.max(-3000, Math.min(3000, latencyOffsetMs + deltaMs));
  if (window.renderLatencySlider) window.renderLatencySlider();
  syncSettingsPanel();

  clearTimeout(latencySaveTimer);
  if (currentTrackKey && window.pywebview && window.pywebview.api) {
    latencySaveTimer = setTimeout(() => {
      window.pywebview.api.save_latency(currentTrackKey, latencyOffsetMs);
    }, 300);
  }

  if (lyrics.length > 0) {
    renderProgress(playheadMs + latencyOffsetMs);
  }
};

window.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (typing) return; // don't hijack keys while a form control has focus
  if (e.ctrlKey && (e.key === '[' || e.code === 'BracketLeft')) {
    e.preventDefault();
    if (!globalHotkeysBound) window.adjustLatency(-50);
  } else if (e.ctrlKey && (e.key === ']' || e.code === 'BracketRight')) {
    e.preventDefault();
    if (!globalHotkeysBound) window.adjustLatency(50);
  } else if (e.ctrlKey && e.key === ',') {
    e.preventDefault();
    toggleSettings();
  } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    toggleTranslations();
  }
});

(function initResizeHandles() {
  const handles = document.querySelectorAll('.resize-handle');
  if (!handles.length) return;

  // Mirrors WindowApi's clamps, including the much smaller one the lyrics-only
  // mini player runs in. Both sides clamp so the window comes to rest exactly
  // where the pointer stopped instead of drifting on every dispatch.
  const NORMAL_BOUNDS = { minW: 320, maxW: 1400, minH: 380, maxH: 1600 };
  const MINI_BOUNDS = { minW: 320, maxW: 900, minH: 380, maxH: 1200 };

  handles.forEach((handle) => {
    const dir = handle.dataset.dir || 'se';

    let dragging = false;
    let startX = 0, startY = 0, startW = 0, startH = 0;
    let pendingW = 0, pendingH = 0;
    let lastW = 0, lastH = 0, lastDispatch = 0, rafId = null;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.screenX; startY = e.screenY;
      startW = window.innerWidth; startH = window.innerHeight;
      pendingW = startW; pendingH = startH;
      lastW = startW; lastH = startH;
      lastDispatch = 0;
      document.body.classList.add('resizing', 'resizing-' + dir);
    });

    // The size is the only thing computed here. Which edge stays put is the
    // host's job: pywebview's resize takes a fix point and applies position and
    // size in a single SetWindowPos. Dispatching a move plus a resize from here
    // used to mean two async calls per frame, and because the resize ran with
    // the default fix point the window always grew from its top-left corner —
    // grabbing any edge but the bottom-right resized as if that corner were
    // anchored.
    const dispatch = () => {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.resize_window) api.resize_window(pendingW, pendingH, dir);
    };

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      const b = miniMode ? MINI_BOUNDS : NORMAL_BOUNDS;

      if (dir.includes('e')) pendingW = Math.max(b.minW, Math.min(b.maxW, Math.round(startW + dx)));
      if (dir.includes('w')) pendingW = Math.max(b.minW, Math.min(b.maxW, Math.round(startW - dx)));
      if (dir.includes('s')) pendingH = Math.max(b.minH, Math.min(b.maxH, Math.round(startH + dy)));
      if (dir.includes('n')) pendingH = Math.max(b.minH, Math.min(b.maxH, Math.round(startH - dy)));

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          const now = performance.now();
          const changed = Math.abs(pendingW - lastW) >= 4 || Math.abs(pendingH - lastH) >= 4;
          if (!changed || now - lastDispatch < 30) return;
          lastW = pendingW; lastH = pendingH; lastDispatch = now;
          dispatch();
        });
      }
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing', 'resizing-e', 'resizing-w', 'resizing-s', 'resizing-n', 'resizing-se', 'resizing-sw', 'resizing-ne', 'resizing-nw');
      dispatch();
      const api = window.pywebview && window.pywebview.api;
      if (api && api.save_window_size) api.save_window_size(pendingW, pendingH);
    });
  });
})();
