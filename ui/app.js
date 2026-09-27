// Synchronized strictly with config.py DEFAULT_LATENCY_MS
const DEFAULT_LATENCY_MS = 600;

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
const playBtns = [
  document.getElementById('transport-play-btn'),
  document.getElementById('art-tp-play'),
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

function applyLayoutState() {
  document.body.classList.toggle('is-fullscreen', isFullscreen);
  document.body.classList.toggle('layout-compact', layoutMode === 'compact');
  // Split needs the room of fullscreen: windowed it stays selected but renders
  // as normal, so the float/header only change when it is actually active.
  const splitActive = layoutMode === 'split' && isFullscreen;
  document.body.classList.toggle('layout-split', splitActive);
  document.body.classList.remove('layout-split-suppressed');
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

// Mirrors fullscreen state onto the on-art buttons (active look).
function syncArtControls() {
  const layoutBtn = document.getElementById('art-btn-layout');
  if (layoutBtn) {
    // Compact is 'off', split 'on' — a second read of which layout is active.
    layoutBtn.classList.toggle('is-on', document.body.classList.contains('layout-split'));
  }
}

// =========================================================
// Always on top
// =========================================================
let alwaysOnTop = false; // default off; the saved value is read below

function applyAlwaysOnTop() {
  document.body.classList.toggle('is-ontop', alwaysOnTop);
  Settings.set('ontop', alwaysOnTop ? '1' : '0');
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_always_on_top) {
    window.pywebview.api.set_always_on_top(alwaysOnTop);
  }
  syncSettingsPanel();
}

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
  if (window.pywebview && window.pywebview.api && window.pywebview.api.toggle_fullscreen) {
    window.pywebview.api.toggle_fullscreen().then((state) => setFullscreen(!!state));
  } else {
    // Browser/dev fallback: no native window, just scale the layout.
    setFullscreen(!isFullscreen);
  }
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
  setValueText(document.querySelector('#qp-clickthrough .qp-state'), clickThrough ? 'On' : 'Off');
  setValueText(document.getElementById('qp-layout-state'),
    layoutMode === 'compact' ? 'Compact' : (isFullscreen ? 'Split' : 'Split (needs FS)'));
  setValueText(document.getElementById('qp-align-state'),
    lyricAlign.charAt(0).toUpperCase() + lyricAlign.slice(1));
  setValueText(document.getElementById('qp-fs-state'), isFullscreen ? 'On' : 'Off');
  setValueText(document.getElementById('qp-ontop-state'), alwaysOnTop ? 'On' : 'Off');
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
  if (reducedMotion) stopBeatEngine(); else startBeatEngine();
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
// Diagnostics
// Reported by the Python resolve/fetch pipeline, plus the live numbers only the
// UI knows. Previously the only way to learn why a track fell back to
// line-synced lyrics was to read stdout.
// =========================================================
let diagnostics = null;

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
    ['Cache', d.cache ? (d.cache === 'hit' ? 'Hit' : 'Miss') : '\u2014'],
    ['Timing', d.timing || '\u2014'],
    ['Album', d.album || '\u2014'],
    ['Metadata', d.metadata || '\u2014'],
    ['Lines', d.lines === undefined || d.lines === null ? '\u2014' : String(d.lines)],
    ['Syllables', d.syllables === undefined || d.syllables === null ? '\u2014' : String(d.syllables)],
    ['API key', d.api_key === undefined ? '\u2014' : (d.api_key ? 'Set' : 'Missing')],
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
    ['Track ID', d.track_id || '\u2014'],
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

// The settings page owns the whole window, so there is nothing to anchor it to
// and no click-outside to close it: it opens over everything and closes from its
// own button, Escape, or Ctrl+, again.
let settingsLastFocus = null;

function openSettings(open) {
  const panel = document.getElementById('quick-panel');
  if (!panel) return;
  panel.classList.toggle('open', open);
  panel.setAttribute('aria-hidden', open ? 'false' : 'true');
  document.body.classList.toggle('settings-open', open);
  const gear = document.getElementById('art-btn-settings');
  if (gear) gear.setAttribute('aria-expanded', open ? 'true' : 'false');

  // Focus management for the modal dialog: move focus in on open, restore it
  // on close, and keep Tab cycling inside the sheet while it is up (the dialog
  // is aria-modal, so focus escaping it would announce hidden content).
  if (open) {
    settingsLastFocus = document.activeElement;
    const target = panel.querySelector('.sp-close') || panel.querySelector('button');
    if (target) target.focus();
  } else {
    if (settingsLastFocus && document.contains(settingsLastFocus)) settingsLastFocus.focus();
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
  if (e.key === 'Escape') openSettings(false);
  if (e.key === 'F11') {
    e.preventDefault();
    toggleFullscreen();
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
  alwaysOnTop = Settings.get('ontop', '0') === '1';
} catch (e) {}
reducedMotion = motionPref === 'reduced';
applyZoom(lyricFontSize);
applyFont(lyricFontName);
applyLyricAlign();
applySecondaryVisibility();
applyMotionPreference();
applyLayoutState();
applyAlwaysOnTopWhenReady();
initFloatArt();

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

window.setCoverArt = function(url, isHiRes) {
  const backdrop = document.querySelector('.ambient-backdrop');
  if (isHiRes) updateHeaderArt(url);

  if (!backdrop) return;

  if (!url) {
    if (currentCoverLayer) {
      const el = currentCoverLayer;
      currentCoverLayer = null;
      el.classList.remove('active');
      setTimeout(() => el.remove(), 1600);
    }
    if (trackArtEl) trackArtEl.classList.remove('visible');
    return;
  }

  // The instant thumbnail also feeds the header art immediately.
  if (!isHiRes) updateHeaderArt(url);

  const layer = document.createElement('div');
  layer.className = 'cover-art-blur';
  layer.style.backgroundImage = `url("${url}")`;
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
    artFill.style.width = Math.max(0, Math.min(100, (ms / sideTotalMs) * 100)).toFixed(2) + '%';
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

window.setTrackDuration = function(ms) {
  sideTotalMs = (typeof ms === 'number' && ms > 0) ? ms : 0;
  const totalEl = document.getElementById('side-time-total');
  if (totalEl && sideTotalMs > 0) totalEl.textContent = formatTime(sideTotalMs).replace(/^0/, '');
  const artDurEl = document.getElementById('art-duration-display');
  if (artDurEl && sideTotalMs > 0) artDurEl.textContent = formatTimeShort(sideTotalMs);
};

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

  // Rotates across the whole line (not per word): with single-syllable words a
  // per-word index would hand every syllable the same variant.
  let sylIdx = 0;
  for (let wIdx = 0; wIdx < lDom.words.length; wIdx++) {
    const wDom = lDom.words[wIdx];
    for (let sIdx = 0; sIdx < wDom.syllables.length; sIdx++) {
      const sDom = wDom.syllables[sIdx];
      hydrateSyllable(sDom);
      // Chosen once per syllable per type, so the motion is stable for the
      // whole line instead of flickering between variants frame to frame.
      if (!sDom.variant) {
        sDom.variant = pickVariant(lDom, sDom, sylIdx);
        sDom.parity = sylIdx % 2;
      }
      sylIdx++;
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

// `f` returns the layer transform; `fc` (optional) returns a per-character one.
// Context: e (envelope), p (progress 0..1), t (ms), d (duration), k (char), n (chars)
// Flags: special = flashy, budget-limited per line; grows = changes glyph size
// (those trigger the line-parting nudge so neighbours make room).
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
    { id: 'lean',   f: c => ({ r: Math.sin(c.p * Math.PI) * 0.6 * c.e, y: -c.e * 0.9, x: (0.5 - c.p) * 0.8 * c.e }), special: true }
  ],

  // --- Rapid-fire syllables (short) --------------------------------------
  fast: [
    { id: 'tick',  f: c => { const b = 1 - Math.min(1, c.p * 2.2); return { y: -b * 1.1 * c.e, s: 1 + b * 0.02 * c.e }; } },
    { id: 'snap',  f: c => { const b = Math.exp(-c.p * 4.5); return { s: 1 + b * 0.024 * c.e, y: -b * 0.5 * c.e }; }, special: true, grows: true },
    // Rotation removed (snap-turn read as cartoonish); kept a soft x-nudge.
    { id: 'flick', f: c => { const b = Math.exp(-c.p * 4); return { x: -b * 1.0 * c.e }; }, special: true },
    { id: 'blip',  f: c => ({ y: Math.sin(Math.min(1, c.p * 1.4) * Math.PI) * -0.9 * c.e, s: 1 + Math.sin(c.p * Math.PI) * 0.012 * c.e }), grows: true },
    { id: 'skim',  f: c => ({ y: -c.e * 0.7 }) },
    { id: 'jitter',f: c => ({ y: Math.sin(c.t / 90) * 0.8 * c.e - c.e * 0.5, s: 1 + Math.sin(c.t / 90) * 0.008 * c.e }) }
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
    { id: 'float', f: c => ({ y: -c.e * 1.5 + Math.sin(c.p * Math.PI * 2) * 0.8 * c.e }) }
  ],

  // --- Backing vocals / harmonies (all low-profile by design) -------------
  backing: [
    { id: 'ghost', f: c => ({ y: Math.sin(c.t / 420) * 0.7 * c.e - c.e * 0.6, s: 1 + Math.sin(c.t / 420) * 0.006 * c.e }) },
    { id: 'echo',  f: c => ({ x: Math.sin(c.t / 560) * 1.0 * c.e, y: -c.e * 0.5 }) },
    { id: 'hum',   f: c => ({ s: 1 + Math.sin(c.p * Math.PI) * 0.032 * c.e }) },
    { id: 'veil',  f: c => ({ y: -c.e * 0.6, s: 1 - c.e * 0.012 }) }
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
    { id: 'chorusSwell', special: true, grows: true, f: c => ({ s: 1 + (0.3 + 0.7 * c.p) * 0.042 * c.e, y: -c.e * 1.5, x: Math.sin(c.p * Math.PI) * 0.9 * c.e }) }
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
      fc: c => ({ y: -c.e * 1.5 + Math.sin(c.p * Math.PI * 2 * 2.0 - c.k * 0.9) * c.e * 1.9 }) }
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
    { id: 'flicker', f: c => ({ s: 1 + Math.sin(Math.min(1, c.p * 2.4) * Math.PI) * 0.022 * c.e, y: -c.e * 0.6 }), special: true }
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
      if (sylDom.baseEl) sylDom.baseEl.style.transform = '';
      if (sylDom.highlightEl) sylDom.highlightEl.style.transform = '';
      if (sylDom.baseChars && sylDom.baseChars.length > 0) {
        for (let c = 0; c < sylDom.numChars; c++) {
          if (sylDom.baseChars[c]) sylDom.baseChars[c].style.transform = '';
          if (sylDom.highlightChars[c]) sylDom.highlightChars[c].style.transform = '';
        }
      }
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

    // The style dial scales every variant uniformly, so the pools never have to
    // know about it. Clamps keep "wild" energetic instead of seasick.
    const amp = motionScaleFactor();
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
      const layerTransform = buildTransform(variant.f(ctx));

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
      lineDiv.onclick = activateLine;
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
            setSyllableState(sDom, 'future', 0);
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

  const MIN_W = 320, MAX_W = 1400, MIN_H = 380, MAX_H = 1600;
  const lastDispatchedW = { current: 0 };
  const lastDispatchedH = { current: 0 };

  handles.forEach((handle) => {
    const dir = handle.dataset.dir || 'se';
    const east = dir.includes('e'), west = dir.includes('w');
    const south = dir.includes('s'), north = dir.includes('n');

    let dragging = false;
    let startX = 0, startY = 0, startW = 0, startH = 0, startWinX = 0, startWinY = 0;
    let pendingW = 0, pendingH = 0, pendingX = 0, pendingY = 0;
    let lastDispatch = 0, rafId = null;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      startX = e.screenX; startY = e.screenY;
      startW = window.innerWidth; startH = window.innerHeight;
      startWinX = window.screenX; startWinY = window.screenY;
      pendingW = startW; pendingH = startH;
      pendingX = startWinX; pendingY = startWinY;
      document.body.classList.add('resizing', 'resizing-' + dir);
      lastDispatchedW.current = startW;
      lastDispatchedH.current = startH;
      lastDispatch = 0;
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;

      if (east)  pendingW = Math.max(MIN_W, Math.min(MAX_W, Math.round(startW + dx)));
      if (west) {
        // Resizing from the west edge keeps the east edge fixed: grow moves the origin left.
        pendingW = Math.max(MIN_W, Math.min(MAX_W, Math.round(startW - dx)));
        pendingX = Math.round(startWinX + (startW - pendingW));
      }
      if (south) pendingH = Math.max(MIN_H, Math.min(MAX_H, Math.round(startH + dy)));
      if (north) {
        pendingH = Math.max(MIN_H, Math.min(MAX_H, Math.round(startH - dy)));
        pendingY = Math.round(startWinY + (startH - pendingH));
      }

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          const now = performance.now();
          const moved = Math.abs(pendingW - lastDispatchedW.current) >= 4 || Math.abs(pendingH - lastDispatchedH.current) >= 4;
          if (moved && now - lastDispatch >= 30 && window.pywebview && window.pywebview.api) {
            if (west || north) window.pywebview.api.move_window(pendingX, pendingY);
            window.pywebview.api.resize_window(pendingW, pendingH);
            lastDispatchedW.current = pendingW;
            lastDispatchedH.current = pendingH;
            lastDispatch = now;
          }
          rafId = null;
        });
      }
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing', 'resizing-e', 'resizing-w', 'resizing-s', 'resizing-n', 'resizing-se', 'resizing-sw', 'resizing-ne', 'resizing-nw');
      if (window.pywebview && window.pywebview.api) {
        if (west || north) window.pywebview.api.move_window(pendingX, pendingY);
        window.pywebview.api.resize_window(pendingW, pendingH);
        window.pywebview.api.save_window_size(pendingW, pendingH);
      }
    });
  });
})();
