// Synchronized strictly with config.py DEFAULT_LATENCY_MS
const DEFAULT_LATENCY_MS = 800;

let isPlaying = false;
let renderLoopActive = false;
let playheadMs = 0;
// The position the WIPE is painted from. While playing it only ever moves
// forward: a soft correction that lands behind the fade, or a stale player
// number that slips through, must not re-sweep letters already sung. A real
// backward move arrives as a glide/snap (see window.syncPlayhead): a snap resets
// it outright, and a glide — a move the user made in the player, whose whole
// travel is meant to be seen — carries it in either direction until it lands.
let renderMs = 0;
let latencyOffsetMs = DEFAULT_LATENCY_MS;
let currentTrackOffsetIsDefault = true;
let lastTick = performance.now();
let lyrics = [];
let lyricDom = [];
let currentTrackKey = "";

let targetDriftMs = 0;

// A seek the bridge measured and asked the UI to travel to (see syncPlayhead):
// while this window is open the wipe eases from where it was to the new position
// instead of cutting to it, the drift decays on a shorter tau so the travel
// finishes inside the window, and the two transient lyric effects a sweep would
// otherwise trip — the break countdown and a moment's grade — are held off.
// Zero means no glide is in flight.
let glideUntilMs = 0;

function syncGlideInFlight() {
  return glideUntilMs > 0 && performance.now() < glideUntilMs;
}

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

// A soft report that is behind the wipe by more than this is not drift the eye
// can follow — it is a parked or stale player number (the bridge labels it
// 'hold'; see window.syncPlayhead). Absorbing a large backward report in full
// rewound the wipe over letters it had already sung, which is the "lyrics loop
// on a few letters" report. Only this much of a backward soft report is taken.
const SOFT_BACK_MAX_MS = 90;
// There is deliberately no "the source has gone quiet, so park the lyrics" guard
// here. There was one: 12s with nothing but holds froze the wipe at its last
// position, on the theory that a silent source must not run the lyrics off the
// end of the song. In practice a held projection is not silence at all — it is
// the bridge still reporting while the player has not refreshed its timeline,
// which is routine for a browser — so the freeze landed mid-song and only a
// play/pause edge (which re-anchors) brought the lyrics back: the "the lyrics
// are basically paused, and pausing/unpausing fixes it" report. Running on this
// side's own 1x clock is what the bridge's 'hold' mode is documented to expect,
// and a track's own length bounds it.

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
  },
  remove(key) {
    try { localStorage.removeItem('sl_' + key); } catch (e) {}
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

// Auto latency (opt-in). Declared up here with the other state that
// syncSettingsPanel() reads at boot: the panel runs before the settings
// functions further down are reached, so this must not live below them (the
// same reason motionStyle sits above the variant engine).
let autoLatency = Settings.get('autoLatency', 'off');
let lastAutoLatencyMs = 0;
// Built-in starting offset for fresh tracks (host DEFAULT/UNCACHED baseline).
// On by default so existing installs behave exactly as before; turning it off
// opens fresh tracks at true 0ms unless auto latency fires or the user nudges.
// Saved per-track nudges always win either way.
let useDefaultLatency = Settings.get('useDefaultLatency', 'off') === 'on';
// The track an auto offset opened on. A later Ctrl+[/] nudge on that same track
// is the residual error of the auto estimate for this player, so it teaches the
// per-player bias (see window.adjustLatency). Cleared on every load.
let lastAutoTrackKey = "";
// Wall-clock stamp of the track change whose lyrics are still being fetched.
// showLoading sets it; loadLyrics consumes it.
let lyricLoadStartedAt = 0;
// Below the floor the number is fetch jitter, not lateness; above the ceiling it
// is a stall or a cold cache that says nothing about sync, and compensating for
// it would park the lyrics seconds off.
const AUTO_LATENCY_MIN_MS = 100;
const AUTO_LATENCY_MAX_MS = 8000;

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
// Font selection (configurable, no CSS editing required)
// One table per job: the id is what gets stored, the label is what the settings
// row shows, and the stack is what the stylesheet is handed — so choosing a
// different face, or adding one, is a single entry. Beyond the two families the
// stylesheet downloads, everything listed is a face Windows and macOS already
// ship, so a machine that is offline still renders something deliberate.
// =========================================================
const LYRIC_FONTS = [
  // The sans stack is the default: readable at every tempo, with real
  // multi-script glyph coverage.
  { id: 'apple', label: 'System', weight: '700',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif" },
  // A sung line in a serif is a different mood entirely, and the sweep distances
  // are remeasured on every change, so nothing about the motion is hard-coded.
  { id: 'serif', label: 'Serif', weight: '700',
    stack: "Georgia, Cambria, 'Times New Roman', Times, serif" },
  { id: 'rounded', label: 'Rounded', weight: '700',
    stack: "'Trebuchet MS', 'Segoe UI', Verdana, system-ui, sans-serif" },
  // Barriecito is naturally thick at weight 400, and its CJK/Cyrillic/Arabic
  // fall back to a mismatched system font mid-line — the option, not the default.
  { id: 'barriecito', label: 'Barriecito', weight: '400',
    stack: "'Barriecito', cursive, sans-serif" },
];
const UI_FONTS = [
  { id: 'inter', label: 'Inter',
    stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif" },
  { id: 'system', label: 'System',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif" },
  { id: 'serif', label: 'Serif',
    stack: "Georgia, Cambria, 'Times New Roman', Times, serif" },
  { id: 'mono', label: 'Mono',
    stack: "'Cascadia Mono', Consolas, 'SF Mono', ui-monospace, monospace" },
];

function fontById(table, id, fallback) {
  return table.find((f) => f.id === id) || table.find((f) => f.id === fallback) || table[0];
}

// =========================================================
// Fonts (Settings -> Fonts)
//
// One list of faces, and the faces live in a folder on disk that the host owns
// (core/font_library.py) — not as base64 blobs inside this window's settings
// store. That store is quotad per origin and a font is megabytes, which is why
// the version that kept them here had to cap imports at eight files and could
// lose a large one silently by the next launch. A folder has no cap, so the list
// is simply what is in it; each face's bytes are fetched once, registered with
// the FontFace API for as long as the window is open, and never persisted here.
//
// A FACE is the unit, not a table. The lyric and interface tables are separate
// (they need their own ids and weights), so one imported file is registered into
// both and shows as one row — and the stock 'System' face, which is two ids in
// two tables with one stack, is one row rather than two identical ones.
// =========================================================
const BUILTIN_FACES = [
  { id: 'system', label: 'System', lyricId: 'apple', uiId: 'system' },
  { id: 'serif', label: 'Serif', lyricId: 'serif', uiId: 'serif' },
  { id: 'rounded', label: 'Rounded', lyricId: 'rounded' },
  { id: 'barriecito', label: 'Barriecito', lyricId: 'barriecito' },
  { id: 'mono', label: 'Mono', uiId: 'mono' },
  { id: 'inter', label: 'Inter', uiId: 'inter' },
];
const DEFAULT_LYRIC_FACE = 'system';
const DEFAULT_UI_FACE = 'inter';

let fontLibrary = null;        // the host's last snapshot; null before the first reply
let fontsReady = false;        // whether the folder has been read at all yet
let fontBusy = false;
let fontStatusText = "";
let fontRemoveArmed = "";
let fontListSig = "";          // what the list currently shows, so a sync that
                               // changes nothing does not rebuild it
const fontFaceState = new Map();     // family id -> 'ready' | 'failed'
const fontFacePromises = new Map();  // family id -> in-flight registration

function fontBridge(name, ...args) {
  const api = window.pywebview && window.pywebview.api;
  if (!api || typeof api[name] !== 'function') return Promise.resolve(null);
  try { return Promise.resolve(api[name](...args)); }
  catch (err) { return Promise.reject(err); }
}

function customStackFor(id) {
  return `'${String(id).replace(/'/g, "")}', 'Segoe UI', system-ui, sans-serif`;
}

function fontEntries() {
  return (fontLibrary && Array.isArray(fontLibrary.entries) ? fontLibrary.entries : []);
}

// A face's own name: what its file calls the family, plus what the file says it is
// beyond that. Only the family travels for a plain regular face, because "Georgia
// Regular" is noise — but Georgia's bold, italic and bold-italic files all report
// the family "Georgia" too, and without the rest of the name the list shows the
// same row four times with only the file name underneath to tell them apart.
function faceDisplayName(entry) {
  const family = String((entry && entry.label) || "");
  const sub = String((entry && entry.subfamily) || "").trim();
  if (!sub) return family;
  const lowered = sub.toLowerCase();
  if (lowered === "regular" || lowered === "normal" || lowered === "book") return family;
  if (lowered === family.toLowerCase()) return family;
  return family ? family + " " + sub : sub;
}

// Every face the overlay can draw in: the stock ones, then the folder.
function fontCatalog() {
  const faces = BUILTIN_FACES.map((face) => ({
    id: face.id, label: face.label, builtin: true,
    // The table ids travel with the face: they are how its stack and weight are
    // looked up, and a face that lost them would silently draw in the default.
    lyricId: face.lyricId, uiId: face.uiId,
    roles: { lyrics: !!face.lyricId, interface: !!face.uiId },
  }));
  for (const entry of fontEntries()) {
    faces.push({ id: entry.id, label: faceDisplayName(entry), builtin: false,
                 file: entry.file, entry,
                 roles: { lyrics: true, interface: true } });
  }
  return faces;
}

function faceById(id) {
  if (!id) return null;
  return fontCatalog().find((f) => f.id === id) || null;
}

function fontEntry(id) {
  return fontEntries().find((e) => e.id === id) || null;
}

// The stack a face is drawn with for one job. Built-ins come from the tables
// (they are also what the rest of the overlay reads), imports from their own id,
// with a real face after them so a font missing a glyph still reads.
function faceStack(face, role) {
  if (!face) return '';
  if (!face.builtin) return customStackFor(face.id);
  const tableId = role === 'lyrics' ? face.lyricId : face.uiId;
  const table = role === 'lyrics' ? LYRIC_FONTS : UI_FONTS;
  const found = table.find((f) => f.id === tableId);
  return found ? found.stack : '';
}

// Fetches and registers one folder font. Once per face per window: the bytes are
// megabytes, they are not cached anywhere local, and a row preview asks for the
// same one the row's buttons will apply.
function ensureFontFace(id) {
  if (fontFaceState.get(id) === 'ready') return Promise.resolve(true);
  const pending = fontFacePromises.get(id);
  if (pending) return pending;
  const entry = fontEntry(id);
  if (!entry) return Promise.resolve(false);
  const promise = fontBridge('font_data', entry.file).then((dataUrl) => {
    if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) throw new Error('no font data');
    const weight = String(entry.weight || 400);
    const face = new FontFace(id, `url(${dataUrl})`,
      { weight, style: entry.style === 'italic' ? 'italic' : 'normal' });
    return face.load().then(() => {
      document.fonts.add(face);
      // The tables are how the rest of the overlay asks for a face, so an import
      // joins them the moment it is registered — with the weight the file itself
      // declares, so a regular face is drawn rather than synthesized bold.
      if (!LYRIC_FONTS.some((f) => f.id === id)) {
        LYRIC_FONTS.push({ id, label: faceDisplayName(entry), weight,
                           stack: customStackFor(id), custom: true });
      }
      if (!UI_FONTS.some((f) => f.id === id)) {
        UI_FONTS.push({ id, label: faceDisplayName(entry),
                        stack: customStackFor(id), custom: true });
      }
      fontFaceState.set(id, 'ready');
      return true;
    });
  }).catch(() => {
    fontFaceState.set(id, 'failed');
    return false;
  });
  fontFacePromises.set(id, promise);
  return promise;
}

// Drops a face from the tables and the document, so the family a removed file
// had been registered under cannot keep answering after its bytes are gone.
function unregisterFace(id) {
  for (const table of [LYRIC_FONTS, UI_FONTS]) {
    const i = table.findIndex((f) => f.id === id);
    if (i >= 0) table.splice(i, 1);
  }
  try {
    for (const face of document.fonts) {
      if (face && face.family === id) document.fonts.delete(face);
    }
  } catch (e) {}
  fontFaceState.delete(id);
  fontFacePromises.delete(id);
}

function setFontStatus(text) {
  fontStatusText = text || "";
  const el = document.getElementById('qp-font-status');
  if (el && el.textContent !== fontStatusText) el.textContent = fontStatusText;
  // The list header is part of the same sentence ("3 fonts in your folder"), so
  // a new status and a stale header must not be able to sit together.
  renderFontPanel();
}

function applyFontSnapshot(snapshot, status) {
  if (!snapshot || typeof snapshot !== 'object') return;
  fontLibrary = snapshot;
  if (status) fontStatusText = status;
  fontListSig = "";      // the folder changed: the next render rebuilds for real
  renderFontPanel();
}

// Reads the folder. A missing bridge (this page opened in a plain browser) is not
// an error: the sheet then shows the stock faces and the import rows say so.
function refreshFonts() {
  return fontBridge('font_list')
    .then((snapshot) => { applyFontSnapshot(snapshot, ""); })
    .catch(() => {})
    .then(() => { fontsReady = true; renderFontPanel(); });
}

// A one-time handover of the fonts the previous version kept as data URLs inside
// this window's settings, so "my imported font is gone" is not the experience of
// updating. The old key is cleared only once the host confirms it wrote them.
function adoptLegacyFonts() {
  let raw = null;
  try { raw = Settings.get('customFonts', null); } catch (e) { raw = null; }
  if (!raw) return Promise.resolve();
  let parsed = [];
  try { parsed = JSON.parse(raw) || []; } catch (e) { parsed = []; }
  const entries = (Array.isArray(parsed) ? parsed : [])
    .filter((f) => f && typeof f.dataUrl === 'string' && f.dataUrl.indexOf('data:') === 0)
    .map((f) => ({ name: String(f.label || f.id || 'font'),
                   legacyId: String(f.id || ''),
                   dataUrl: f.dataUrl }));
  if (!entries.length) { Settings.remove('customFonts'); return Promise.resolve(); }
  return fontBridge('font_adopt', entries).then((snapshot) => {
    if (!snapshot) return;          // no host: leave the old key where it is
    Settings.remove('customFonts');
    applyFontSnapshot(snapshot, snapshot.status);
  }).catch(() => {});
}

// One mutation path, so busy state, the returned snapshot and the status line
// are handled in exactly one place.
function fontRun(name, args, busyLabel) {
  if (fontBusy) return Promise.resolve();
  fontBusy = true;
  fontListSig = "";
  renderFontPanel();
  if (busyLabel) setFontStatus(busyLabel);
  return fontBridge(name, ...args)
    .then((snapshot) => { applyFontSnapshot(snapshot, snapshot && snapshot.status); })
    .catch((err) => {
      setFontStatus('That did not work: ' + (err && err.message ? err.message : err));
    })
    .then(() => { fontBusy = false; renderFontPanel(); });
}

function importFonts() {
  // The native picker blocks until the user chooses; the row says so rather than
  // looking frozen.
  return fontRun('font_import', [], 'Waiting for the file picker…');
}

function revealFonts() {
  fontBridge('font_reveal', "").catch(() => {});
}

// Applies a face to one job, registering its bytes first when it is an import.
function chooseFace(face, role) {
  if (!face) return Promise.resolve();
  const apply = role === 'lyrics' ? applyFont : applyUiFont;
  if (face.builtin || fontFaceState.get(face.id) === 'ready') {
    apply(face.id);
    return Promise.resolve();
  }
  return ensureFontFace(face.id).then((ok) => {
    if (ok) apply(face.id);
    else setFontStatus('Could not load ' + face.label + ' — the file may not be a readable font.');
  });
}

function removeFace(face) {
  if (!face || face.builtin) return Promise.resolve();
  // Two-step confirm instead of a modal: the sheet is already a full-window
  // dialog and a native confirm() inside the webview would freeze it.
  if (fontRemoveArmed !== face.id) {
    fontRemoveArmed = face.id;
    renderFontPanel();
    setFontStatus('Click Remove again to move '
      + ((face.entry && face.entry.name) || face.label) + ' to the font folder’s .trash.');
    return Promise.resolve();
  }
  fontRemoveArmed = "";
  const id = face.id;
  return fontRun('font_remove', [face.file]).then(() => {
    unregisterFace(id);
    // Whatever was drawing with it falls back to a stock face rather than keeping
    // a family whose bytes are gone.
    if (lyricFontName === id) applyFont(DEFAULT_LYRIC_FACE);
    if (uiFontName === id) applyUiFont(DEFAULT_UI_FACE);
    renderFontPanel();
  });
}

function formatFontSize(bytes) {
  const kb = Math.max(1, Math.round((Number(bytes) || 0) / 1024));
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB';
}

// Draws the face's own name in the face itself, once its bytes are here. The
// preview IS the choice: a font list that cannot show you the font is a list of
// file names. A file that will not load says so on its row instead of quietly
// standing in for a face it is not.
function applyFacePreview(face, nameEl, subEl) {
  const stack = faceStack(face, 'lyrics') || faceStack(face, 'interface');
  if (face.builtin) {
    nameEl.style.fontFamily = stack;
    return;
  }
  const failed = () => {
    nameEl.classList.add('is-unreadable');
    subEl.textContent = 'Could not be read as a font';
  };
  if (fontFaceState.get(face.id) === 'failed') { failed(); return; }
  ensureFontFace(face.id).then((ok) => {
    if (!ok) { failed(); return; }
    nameEl.style.fontFamily = stack;
  });
}

function fontRow(face) {
  const row = document.createElement('div');
  row.className = 'font-row';
  row.dataset.face = face.id;

  const main = document.createElement('div');
  main.className = 'font-row-main';
  const name = document.createElement('div');
  name.className = 'font-row-name';
  name.textContent = face.label;
  name.title = face.builtin ? face.label + ' — built in'
                             : ((face.entry && face.entry.name) || face.label);
  const sub = document.createElement('div');
  sub.className = 'font-row-sub';
  sub.textContent = face.builtin ? 'Built in'
    : [face.entry && face.entry.name, formatFontSize(face.entry && face.entry.size)]
        .filter(Boolean).join(' · ');
  main.appendChild(name);
  main.appendChild(sub);
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'font-row-actions';
  // A face is only offered the jobs it can hold: a dead button on the Interface
  // row of a lyrics-only face would read as a broken feature.
  ['lyrics', 'interface'].forEach((role) => {
    if (!face.roles[role]) return;
    const active = (role === 'lyrics' ? lyricFontName : uiFontName) === face.id;
    const button = document.createElement('button');
    button.className = 'font-act';
    button.dataset.action = role;
    button.textContent = role === 'lyrics' ? 'Lyrics' : 'Interface';
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.title = (active ? 'In use for the ' : 'Use for the ') + role;
    button.disabled = fontBusy;
    button.onclick = () => chooseFace(face, role);
    actions.appendChild(button);
  });

  if (!face.builtin) {
    const remove = document.createElement('button');
    const armed = fontRemoveArmed === face.id;
    remove.className = 'font-act font-act-danger';
    remove.dataset.action = 'remove';
    remove.textContent = armed ? 'Confirm' : 'Remove';
    remove.title = 'Move this file to the font folder’s .trash';
    remove.disabled = fontBusy;
    remove.onclick = () => removeFace(face);
    actions.appendChild(remove);
  }

  row.appendChild(actions);
  applyFacePreview(face, name, sub);
  return row;
}

function renderFontPanel() {
  const listEl = document.getElementById('qp-font-list');
  const statusEl = document.getElementById('qp-font-status');
  if (!listEl) return;
  if (statusEl && statusEl.textContent !== fontStatusText) statusEl.textContent = fontStatusText;

  const faces = fontCatalog();
  const imports = faces.filter((f) => !f.builtin);
  const signature = JSON.stringify([fontBusy, fontRemoveArmed, fontStatusText,
    lyricFontName, uiFontName,
    faces.map((f) => [f.id, f.label, f.builtin ? 1 : 0])]);
  if (signature === fontListSig) return;
  fontListSig = signature;

  listEl.replaceChildren();
  const head = document.createElement('div');
  head.className = 'font-list-head';
  head.textContent = imports.length
    ? imports.length + (imports.length === 1 ? ' font' : ' fonts') + ' in your font folder'
    : 'No imported fonts yet — Add font… copies one into your font folder.';
  if (fontLibrary && fontLibrary.dir) head.title = fontLibrary.dir;
  listEl.appendChild(head);
  faces.forEach((face) => listEl.appendChild(fontRow(face)));
}


let lyricFontName = 'system';
let savedLineSync = null;
try {
  const _ls = Settings.get('lineSync', null);
  if (_ls) savedLineSync = _ls;
} catch (e) {}
let uiFontName = 'inter';

function applyFont(name) {
  const face = faceById(name);
  if (face && face.roles.lyrics && (face.builtin || fontFaceState.get(face.id) === 'ready')) {
    paintLyricFace(face);
    return;
  }
  if (face && face.roles.lyrics) {
    // An imported face: the family can only be handed to the stylesheet once its
    // bytes are registered, so the paint lands a moment later — and takes a stock
    // face if the file will not load.
    ensureFontFace(face.id).then((ok) => applyFont(ok ? face.id : DEFAULT_LYRIC_FACE));
    return;
  }
  // Until the folder has been read an unknown name may just be a font the host
  // has not reported yet. Falling back then would overwrite the user's saved
  // choice with the default on every launch.
  if (!fontsReady) return;
  if (name !== DEFAULT_LYRIC_FACE) applyFont(DEFAULT_LYRIC_FACE);
}

function paintLyricFace(face) {
  const font = fontById(LYRIC_FONTS, face.builtin ? face.lyricId : face.id, 'apple');
  lyricFontName = face.id;
  document.documentElement.style.setProperty('--lyric-font-family', font.stack);
  document.documentElement.style.setProperty('--lyric-font-weight', font.weight);
  Settings.set('font', lyricFontName);
  // Glyph widths change with the family, so the sweep distances must be remeasured —
  // and with them whether a line still fits the column.
  rebuildLineMotion();
  fitLyricLines();
  // The card's title/artist metrics move the clearance the lyrics must keep.
  syncLyricsClearance();
  syncSettingsPanel();
}

function cycleFont() {
  const faces = fontCatalog().filter((f) => f.roles.lyrics);
  const idx = faces.findIndex((f) => f.id === lyricFontName);
  chooseFace(faces[(idx + 1) % faces.length], 'lyrics');
}

// The interface font is its own choice: someone who wants a serif verse does not
// necessarily want a serif settings sheet, and the chrome is read at a distance.
function applyUiFont(name) {
  const face = faceById(name);
  if (face && face.roles.interface && (face.builtin || fontFaceState.get(face.id) === 'ready')) {
    paintUiFace(face);
    return;
  }
  if (face && face.roles.interface) {
    ensureFontFace(face.id).then((ok) => applyUiFont(ok ? face.id : DEFAULT_UI_FACE));
    return;
  }
  if (!fontsReady) return;
  if (name !== DEFAULT_UI_FACE) applyUiFont(DEFAULT_UI_FACE);
}

function paintUiFace(face) {
  const font = fontById(UI_FONTS, face.builtin ? face.uiId : face.id, 'inter');
  uiFontName = face.id;
  document.documentElement.style.setProperty('--ui-font', font.stack);
  Settings.set('uiFont', uiFontName);
  syncSettingsPanel();
}

// =========================================================
// Line-sync mode (Settings -> Lyrics -> Line-by-line)
// For tracks whose timing came from LRCLIB (line starts only, no true
// syllables), the per-word wipe is synthesized from a timing model — a
// guess, however musical. Line-by-line instead lights the whole active line
// at once and dims what passed: honest about what the source actually knows.
// Auto (default) keeps the wipe for syllable-synced tracks and switches to
// line lighting for line-timed ones; On/Off force it either way.
const LINESYNC_MODES = ['auto', 'on', 'off'];
let lineSyncMode = 'auto';
let lineSyncActive = false;

function trackIsLineTimed() {
  if (!lyrics || lyrics.length === 0) return false;
  let timed = 0;
  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i];
    if (!line.words || line.words.length === 0) continue;
    // A real syllable-synced line staggers its words across the line span;
    // a synthesized one clusters every word start at (or near) the line start.
    let staggered = false;
    for (let w = 1; w < line.words.length; w++) {
      const prev = line.words[w - 1];
      const cur = line.words[w];
      if (cur.startTimeMs > prev.startTimeMs + 120) { staggered = true; break; }
    }
    if (staggered) timed++;
  }
  // A track counts as line-timed when fewer than a quarter of its worded
  // lines carry real stagger — tolerant of the odd spoken intro over true sync.
  const worded = lyrics.filter((l) => l.words && l.words.length > 1).length;
  if (worded === 0) return true;
  return (timed / worded) < 0.25;
}

function resolveLineSync() {
  const want = lineSyncMode === 'on' || (lineSyncMode === 'auto' && trackIsLineTimed());
  if (want === lineSyncActive) return;
  lineSyncActive = want;
  document.body.classList.toggle('line-sync', want);
  // Re-derive every visible state under the new mode; the next tick keeps it.
  lastActiveSig = "";
  if (lyrics.length > 0) renderProgress((isPlaying ? predictedPlayhead() : playheadMs) + latencyOffsetMs);
  syncSettingsPanel();
}

function applyLineSyncMode(mode) {
  if (!LINESYNC_MODES.includes(mode)) mode = 'auto';
  lineSyncMode = mode;
  Settings.set('lineSync', mode);
  resolveLineSync();
  // The preference changed even when the derived lighting did not (e.g. Off
  // to Auto on a syllable-synced track): resolveLineSync returns early then
  // without repainting the panel, so the row would keep showing the old mode.
  syncSettingsPanel();
}

function cycleLineSync() {
  applyLineSyncMode(LINESYNC_MODES[(LINESYNC_MODES.indexOf(lineSyncMode) + 1) % LINESYNC_MODES.length]);
}

function cycleUiFont() {
  const faces = fontCatalog().filter((f) => f.roles.interface);
  const idx = faces.findIndex((f) => f.id === uiFontName);
  chooseFace(faces[(idx + 1) % faces.length], 'interface');
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
  // Fullscreen multiplies the lyric size (1.7x) and the layouts move the column, so what
  // fitted a moment ago may not fit now — and a line that was shrunk may not need to be.
  fitLyricLines();
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
  if (window.airPipeline) window.airPipeline.resize();
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
  fitLyricLines();    // mini has its own gutters, and therefore its own column width
  if (window.airPipeline) window.airPipeline.resize();
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
// Auto latency (opt-in)
// =========================================================
// Some players never tell Windows where playback is, so the overlay has no clock
// but its own. For the SMTC case the resolve report reads "no timeline from
// player"; the bridge then hands `loadLyrics` an initial elapsed of 0, and
// because `loadLyrics` re-anchors the playhead at that moment, the whole fetch
// happens outside the song's clock. Every render is fed
// `playheadMs + latencyOffsetMs`.
//
// The fetch duration alone is NOT the correction: the song kept playing while
// the lyrics were loading AND while Windows noticed the track change (the
// bridge polls ~0.6s idle, plus the handover quiet period when apps contend),
// minus the part of the fetch that ran before the audio actually started. So
// the estimate is fetch time + a fixed detection pad (one poll beat), plus a
// per-player learned trim:
//
//   raw = fetchMs + AUTO_DETECT_PAD_MS + trim(player)
//
// `trim` starts at 0 and learns from the user's own Ctrl+[/] nudges: nudging a
// track that opened on an auto offset says the estimate was off by that much
// for this player, so the bias absorbs half the nudge (a half-step, not a full
// jump, so one rough nudge cannot swing the next song). It is stored beside the
// toggle in localStorage, keyed by player app id, and it only ever moves the
// auto suggestion — never a value the user chose.
//
// Derived per load and never saved as the track offset — it is a measurement,
// not a preference the user expressed — and it may only replace the host's
// DEFAULT offset for a track, never one the user nudged (see
// `offsetIsDefault`). With a live timeline it does nothing at all: the 1 Hz
// position pushes already correct the clock, and a load-time offset would
// fight them.
const AUTO_DETECT_PAD_MS = 600;
const AUTO_TRIM_KEY_PREFIX = 'autoLatencyTrim_';
const AUTO_TRIM_MAX_MS = 2000;

function autoLatencyEligible() {
  return autoLatency === 'on'
    && !!transportState
    && transportState.timeline === false;
}

// The player we are following, or "" when unknown. The bridge pushes it with
// the transport state; without it all players would share one trim and teach
// each other their errors.
function autoLatencyPlayer() {
  return (transportState && transportState.app) ? String(transportState.app) : "";
}

function autoTrimKey(player) {
  return AUTO_TRIM_KEY_PREFIX + (player || 'unknown');
}

function getAutoTrim(player) {
  const raw = parseFloat(Settings.get(autoTrimKey(player), '0'));
  if (isNaN(raw)) return 0;
  return Math.max(-AUTO_TRIM_MAX_MS, Math.min(AUTO_TRIM_MAX_MS, raw));
}

function setAutoTrim(player, value) {
  Settings.set(autoTrimKey(player),
    String(Math.max(-AUTO_TRIM_MAX_MS, Math.min(AUTO_TRIM_MAX_MS, Math.round(value)))));
}

// Rounded to the stepper's 50ms grid, so the value Settings shows is the value
// being used: a derived offset the UI cannot display is worse than no offset.
function snapAutoLatency(ms) {
  return Math.round(Math.max(0, Math.min(AUTO_LATENCY_MAX_MS, ms)) / 50) * 50;
}

// The measured fetch duration plus detection pad and learned player trim, as an
// offset for this load — or null when it must not apply. Always consumes the
// stamp, so a reload of the same track (which never went through showLoading)
// cannot reuse a stale start.
function takeAutoLatency(offsetIsDefault) {
  const startedAt = lyricLoadStartedAt;
  lyricLoadStartedAt = 0;
  if (!startedAt || !offsetIsDefault || !autoLatencyEligible()) return null;
  const loadMs = performance.now() - startedAt;
  if (loadMs < AUTO_LATENCY_MIN_MS || loadMs > AUTO_LATENCY_MAX_MS) return null;
  const raw = loadMs + AUTO_DETECT_PAD_MS + getAutoTrim(autoLatencyPlayer());
  return snapAutoLatency(raw);
}

function cycleAutoLatency() {
  autoLatency = autoLatency === 'on' ? 'off' : 'on';
  Settings.set('autoLatency', autoLatency);
  if (autoLatency === 'off') { lastAutoLatencyMs = 0; lastAutoTrackKey = ""; }
  syncSettingsPanel();
}

function cycleDefaultLatency() {
  useDefaultLatency = !useDefaultLatency;
  Settings.set('useDefaultLatency', useDefaultLatency ? 'on' : 'off');
  syncSettingsPanel();
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
  setValueText(document.querySelector('#qp-font .qp-state'), (faceById(lyricFontName) || { label: 'System' }).label);
  setValueText(document.querySelector('#qp-ui-font .qp-state'), (faceById(uiFontName) || { label: 'Inter' }).label);
  setValueText(document.getElementById('qp-linesync-state'), lineSyncMode.charAt(0).toUpperCase() + lineSyncMode.slice(1));
  renderFontPanel();
  setValueText(document.querySelector('#qp-motion .qp-state'), reducedMotion ? 'Reduced' : 'Full');
  setValueText(document.getElementById('qp-motion-style-state'), motionStyle.charAt(0).toUpperCase() + motionStyle.slice(1));
  setValueText(document.getElementById('qp-beat-state'), EFFECT_LEVEL_LABELS[beatLevel] || 'Subtle');
  setValueText(document.getElementById('qp-moments-state'), EFFECT_LEVEL_LABELS[momentLevel] || 'Subtle');
  setValueText(document.getElementById('qp-ambient-state'), EFFECT_LEVEL_LABELS[ambientLevel] || 'Subtle');
  setValueText(document.getElementById('qp-tilt-state'), EFFECT_LEVEL_LABELS[tiltLevel] || 'Subtle');
  syncSegmentedControls();
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
  // Off, or On plus the offset the last track-load derived, so a silently
  // applied offset is never invisible to the user it is meant to help.
  setValueText(document.getElementById('qp-auto-latency-state'),
    autoLatency !== 'on' ? 'Off'
      : (lastAutoLatencyMs ? `On \u00b7 ${lastAutoLatencyMs > 0 ? '+' : ''}${lastAutoLatencyMs}ms` : 'On'));
  setValueText(document.getElementById('qp-default-latency-state'), useDefaultLatency ? 'On' : 'Off');
  setValueText(document.getElementById('qp-opacity-state'), OPACITY_LABELS[opacityIndex] || 'Off');
  updateLatencyUI();
  renderDiagnostics();
  syncSettingsGroupSummaries();
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
// =========================================================
// 5-Level Visual Effects Engine & Audio-DSP Clock Timing Architecture
// =========================================================
const EFFECT_LEVEL_LABELS = ['Off', 'Minimal', 'Subtle', 'Vivid', 'Apex'];
const BEAT_LEVEL_SCALES = [0, 0.40, 0.75, 1.05, 1.40];
const CHROMA_LEVEL_SCALES = [0, 0.45, 0.90, 1.50, 2.30];
const AMBIENT_LEVEL_COUNTS = [0, 14, 28, 48, 80];
const AMBIENT_LEVEL_OPACITIES = [0, 0.35, 0.62, 0.88, 1.0];
const MOMENT_LEVEL_DEPTHS = [0, 0.35, 0.65, 1.0, 1.45];
const TILT_LEVEL_AMPS = [0, 0.35, 0.70, 1.20, 1.70];

let beatLevel = 2;
let chromaLevel = 2;
let ambientLevel = 2;
let momentLevel = 2;
let tiltLevel = 2;

// Backward-compatible string mode mappings
function getLegacyMode(lvl) {
  if (lvl === 0) return 'off';
  if (lvl >= 3) return 'bold';
  return 'on';
}

function parseLevelSetting(val, fallback = 2) {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number') return Math.max(0, Math.min(4, Math.round(val)));
  if (val === 'off' || val === '0') return 0;
  if (val === 'min' || val === '1') return 1;
  if (val === 'on' || val === 'subtle' || val === '2') return 2;
  if (val === 'bold' || val === 'vivid' || val === '3') return 3;
  if (val === 'apex' || val === '4') return 4;
  const num = parseInt(val, 10);
  return isNaN(num) ? fallback : Math.max(0, Math.min(4, num));
}

let beatMode = 'on';
const BEAT_MODES = ['on', 'bold', 'off'];
const BEAT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };

const MOMENT_MODES = ['on', 'bold', 'off'];
const MOMENT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
const MOMENT_DEPTH = { on: 0.6, bold: 1 };
let momentsMode = 'on';

const AMBIENT_MODES = ['on', 'bold', 'off'];
const AMBIENT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
const AMBIENT_LEVEL = { on: 0.62, bold: 1, off: 0 };
let ambientMode = 'on';

const TILT_MODES = ['on', 'bold', 'off'];
const TILT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
const TILT_AMP = { on: 0.7, bold: 1.2, off: 0 };
let tiltMode = 'on';

let sliderBeat = parseInt(Settings.get('sliderBeat', '45'), 10);
if (isNaN(sliderBeat)) sliderBeat = 45;
let sliderChroma = parseInt(Settings.get('sliderChroma', '30'), 10);
if (isNaN(sliderChroma)) sliderChroma = 30;
let sliderArt = parseInt(Settings.get('sliderArt', '40'), 10);
if (isNaN(sliderArt)) sliderArt = 40;
let sliderParticles = parseInt(Settings.get('sliderParticles', '28'), 10);
if (isNaN(sliderParticles)) sliderParticles = 28;
let sliderParticleOpacity = parseInt(Settings.get('sliderParticleOpacity', '80'), 10);
if (isNaN(sliderParticleOpacity)) sliderParticleOpacity = 80;
let sliderParticleSize = parseInt(Settings.get('sliderParticleSize', '70'), 10);
if (isNaN(sliderParticleSize)) sliderParticleSize = 70;
let sliderMoments = parseInt(Settings.get('sliderMoments', '35'), 10);
if (isNaN(sliderMoments)) sliderMoments = 35;
let sliderTilt = parseInt(Settings.get('sliderTilt', '50'), 10);
if (isNaN(sliderTilt)) sliderTilt = 50;

function toggleSubSection(id) {
  const section = document.getElementById(id);
  const btn = document.querySelector(`[aria-controls="${id}"]`);
  if (!section) return;
  const isHidden = section.hidden;
  section.hidden = !isHidden;
  if (btn) {
    btn.setAttribute('aria-expanded', String(isHidden));
    btn.classList.toggle('sp-expanded', isHidden);
  }
  Settings.set(`expand_${id}`, isHidden ? '1' : '0');
}
window.toggleSubSection = toggleSubSection;

function restoreSubSections() {
  ['beat-sub', 'air-sub'].forEach(id => {
    const isExpanded = Settings.get(`expand_${id}`, '0') === '1';
    const section = document.getElementById(id);
    const btn = document.querySelector(`[aria-controls="${id}"]`);
    if (section && btn && isExpanded) {
      section.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      btn.classList.add('sp-expanded');
    }
  });
}
window.restoreSubSections = restoreSubSections;

function syncVisualSliders() {
  const sliders = [
    { id: 'slider-beat', badge: 'badge-beat', val: sliderBeat, unit: '%' },
    { id: 'slider-chroma', badge: 'badge-chroma', val: sliderChroma, unit: '%' },
    { id: 'slider-art', badge: 'badge-art', val: sliderArt, unit: '%' },
    { id: 'slider-particles', badge: 'badge-particles', val: sliderParticles, unit: ' motes' },
    { id: 'slider-particle-opacity', badge: 'badge-particle-opacity', val: sliderParticleOpacity, unit: '%' },
    { id: 'slider-particle-size', badge: 'badge-particle-size', val: sliderParticleSize, unit: '%' },
    { id: 'slider-moments', badge: 'badge-moments', val: sliderMoments, unit: '%' },
    { id: 'slider-tilt', badge: 'badge-tilt', val: sliderTilt, unit: '%' }
  ];
  for (const s of sliders) {
    const el = document.getElementById(s.id);
    if (el) el.value = s.val;
    const b = document.getElementById(s.badge);
    if (b) b.textContent = s.val === 0 ? 'Off' : `${s.val}${s.unit}`;
  }
  document.documentElement.style.setProperty('--art-slider-scale', (sliderArt / 100).toFixed(2));
  document.documentElement.style.setProperty('--tilt-amp', String((sliderTilt / 100) * 1.2));
  restoreSubSections();
}
window.syncVisualSliders = syncVisualSliders;

function onVisualSliderInput(name, value) {
  const val = Math.max(0, parseInt(value, 10) || 0);
  if (name === 'beat') {
    sliderBeat = val;
    beatLevel = val === 0 ? 0 : (val < 25 ? 1 : (val < 60 ? 2 : (val < 85 ? 3 : 4)));
    const b = document.getElementById('badge-beat');
    if (b) b.textContent = val === 0 ? 'Off' : `${val}%`;
  } else if (name === 'chroma') {
    sliderChroma = val;
    chromaLevel = val === 0 ? 0 : 2;
    if (val === 0) setChromaOffset(0);
    const b = document.getElementById('badge-chroma');
    if (b) b.textContent = val === 0 ? 'Off' : `${val}%`;
  } else if (name === 'art') {
    sliderArt = val;
    document.documentElement.style.setProperty('--art-slider-scale', (val / 100).toFixed(2));
    const b = document.getElementById('badge-art');
    if (b) b.textContent = val === 0 ? 'Off' : `${val}%`;
  } else if (name === 'particles') {
    sliderParticles = val;
    ambientLevel = val === 0 ? 0 : 2;
    if (window.airPipeline) {
      if (val === 0) {
        if (window.airPipeline.ctx && window.airPipeline.canvas) {
          window.airPipeline.ctx.clearRect(0, 0, window.airPipeline.canvas.width, window.airPipeline.canvas.height);
        }
        window.airPipeline.pool.clear();
      } else if (window.airPipeline.pool.count === 0) {
        window.airPipeline.seedParticles();
      }
    }
    const b = document.getElementById('badge-particles');
    if (b) b.textContent = val === 0 ? 'Off' : `${val} motes`;
  } else if (name === 'particle-opacity') {
    sliderParticleOpacity = val;
    const b = document.getElementById('badge-particle-opacity');
    if (b) b.textContent = `${val}%`;
  } else if (name === 'particle-size') {
    sliderParticleSize = val;
    const b = document.getElementById('badge-particle-size');
    if (b) b.textContent = `${val}%`;
  } else if (name === 'moments') {
    sliderMoments = val;
    momentLevel = val === 0 ? 0 : 2;
    if (val === 0) releaseMomentGrade();
    const b = document.getElementById('badge-moments');
    if (b) b.textContent = val === 0 ? 'Off' : `${val}%`;
  } else if (name === 'tilt') {
    sliderTilt = val;
    tiltLevel = val === 0 ? 0 : 2;
    document.documentElement.style.setProperty('--tilt-amp', String((val / 100) * 1.2));
    if (val === 0) resetTilt();
    const b = document.getElementById('badge-tilt');
    if (b) b.textContent = val === 0 ? 'Off' : `${val}%`;
  }
}

function onVisualSliderChange(name, value) {
  onVisualSliderInput(name, value);
  const val = Math.max(0, parseInt(value, 10) || 0);
  if (name === 'beat') {
    Settings.set('sliderBeat', val);
    Settings.set('beatLevel', beatLevel);
    startBeatEngine();
  } else if (name === 'chroma') {
    Settings.set('sliderChroma', val);
    Settings.set('chromaLevel', chromaLevel);
  } else if (name === 'art') {
    Settings.set('sliderArt', val);
  } else if (name === 'particles') {
    Settings.set('sliderParticles', val);
    Settings.set('ambientLevel', ambientLevel);
  } else if (name === 'particle-opacity') {
    Settings.set('sliderParticleOpacity', val);
  } else if (name === 'particle-size') {
    Settings.set('sliderParticleSize', val);
  } else if (name === 'moments') {
    Settings.set('sliderMoments', val);
    Settings.set('momentLevel', momentLevel);
    startMomentEngine();
  } else if (name === 'tilt') {
    Settings.set('sliderTilt', val);
    Settings.set('tiltLevel', tiltLevel);
    if (val === 0) resetTilt();
  }
  if (window.ProfileManager) window.ProfileManager.syncFromCurrentVisuals();
  syncSettingsPanel();
  wakeRenderLoop();
}
window.onVisualSliderInput = onVisualSliderInput;
window.onVisualSliderChange = onVisualSliderChange;

function syncSegmentedControls() {
  syncVisualSliders();
}
window.syncSegmentedControls = syncSegmentedControls;

function setEffectLevel(name, level) {
  level = Math.max(0, Math.min(4, parseInt(level, 10) || 0));
  const lvlToPct = [0, 25, 45, 75, 100];
  const lvlToMotes = [0, 14, 28, 48, 80];
  if (name === 'beat') {
    beatLevel = level;
    sliderBeat = lvlToPct[level];
    Settings.set('sliderBeat', sliderBeat);
    Settings.set('beatLevel', level);
    startBeatEngine();
  } else if (name === 'chroma') {
    chromaLevel = level;
    sliderChroma = lvlToPct[level];
    Settings.set('sliderChroma', sliderChroma);
    Settings.set('chromaLevel', level);
    if (chromaLevel === 0) setChromaOffset(0);
  } else if (name === 'ambient') {
    ambientLevel = level;
    sliderParticles = lvlToMotes[level];
    Settings.set('sliderParticles', sliderParticles);
    Settings.set('ambientLevel', level);
    applyAmbientMode();
  } else if (name === 'moments') {
    momentLevel = level;
    sliderMoments = lvlToPct[level];
    Settings.set('sliderMoments', sliderMoments);
    Settings.set('momentLevel', level);
    startMomentEngine();
  } else if (name === 'tilt') {
    tiltLevel = level;
    sliderTilt = lvlToPct[level];
    Settings.set('sliderTilt', sliderTilt);
    Settings.set('tiltLevel', level);
    applyTiltMode();
    if (tiltLevel === 0) resetTilt();
  }
  syncVisualSliders();
  if (window.ProfileManager) window.ProfileManager.syncFromCurrentVisuals();
  syncSettingsPanel();
  renderDiagnostics();
  wakeRenderLoop();
  if (lyrics && lyrics.length > 0) renderProgress(playheadMs + latencyOffsetMs);
}
window.setEffectLevel = setEffectLevel;

function cycleBeatMode() {
  setEffectLevel('beat', (beatLevel + 1) % 5);
}

function cycleChromaMode() {
  setEffectLevel('chroma', (chromaLevel + 1) % 5);
}

function cycleMoments() {
  setEffectLevel('moments', (momentLevel + 1) % 5);
}

function cycleAmbient() {
  setEffectLevel('ambient', (ambientLevel + 1) % 5);
}

function cycleTilt() {
  setEffectLevel('tilt', (tiltLevel + 1) % 5);
}

// =========================================================
// Beat Engine & Audio-DSP-Clock Synchronization
// =========================================================
let beatPlan = null;      // {bpm, periodMs, phaseMs, runs, phases, stats}
let beatPlanIndex = 0;    // cursor; the playhead usually walks forward
let beatPhaseIndex = 0;   // cursor for the build/drop spans
let beatPhase = null;     // 'build' | 'drop' | null, the shape the pulse is in
let beatBpm = 0;
const BEAT_LEAD_FRAC = 0.16;

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

function setBeatPhase(kind) {
  if (kind === beatPhase) return;
  beatPhase = kind;
  document.body.classList.toggle('beat-phase-build', kind === 'build');
  document.body.classList.toggle('beat-phase-drop', kind === 'drop');
}

function alignBeatToGrid(ms) {
  if (!beatPlan || !beatPlan.periodMs) return;
  const period = beatPlan.periodMs;
  const lead = period * BEAT_LEAD_FRAC;
  const nextBeat = beatPlan.phaseMs + Math.ceil((ms - beatPlan.phaseMs) / period) * period;
  const residue = (((nextBeat - ms - lead) % period) + period) % period;
  const delay = residue === 0 ? 0 : residue - period;
  document.body.style.setProperty('--beat-lead-ms', `${delay.toFixed(0)}ms`);
}

function stopBeatEngine() {
  beatPlanIndex = 0;
  beatPhaseIndex = 0;
  setBeatPhase(null);
  const body = document.body;
  body.classList.remove('beat-on', 'beat-bold', 'beat-live');
  body.style.removeProperty('--beat-strength');
  if (window.audioDspClock) window.audioDspClock.reset();
}

function startBeatEngine() {
  stopBeatEngine();
  if (beatLevel === 0 || reducedMotion || !beatPlan) return;
  const body = document.body;
  body.style.setProperty('--beat-ms', `${beatPlan.periodMs.toFixed(0)}ms`);
  body.classList.add(beatLevel >= 3 ? 'beat-bold' : 'beat-on');
  if (window.audioDspClock) window.audioDspClock.reset();
}

function pulseCoverage() {
  if (!beatPlan || !beatPlan.runs.length) return 0;
  const active = beatPlan.runs.reduce((sum, run) => sum + (run[1] - run[0]), 0);
  const span = beatPlan.runs[beatPlan.runs.length - 1][1] || 1;
  return Math.round((active / span) * 100);
}

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
  if (sliderBeat === 0 || beatLevel === 0 || reducedMotion || !beatPlan || !isPlaying) {
    if (body.classList.contains('beat-live')) body.classList.remove('beat-live');
    return;
  }

  const run = beatRunAt(ms);
  const beatMinGate = 0.46 * (1.1 - (sliderBeat / 100) * 0.3);
  const live = body.classList.contains('beat-live');
  if (run && run[2] >= beatMinGate) {
    const scale = (sliderBeat / 100) * 0.95;
    body.style.setProperty('--beat-strength', (run[2] * scale).toFixed(2));
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
// Critically Damped Spring Physics & Dynamic Chromatic Aberration
// =========================================================
let beatSpringPos = 0;
let beatSpringVel = 0;
let subSpringPos = 0;
let subSpringVel = 0;
let chromaAmount = 0;
let chromaOffsetCache = 0;

function setChromaOffset(px) {
  const rounded = Math.round(px * 20) / 20;
  if (rounded === chromaOffsetCache) return;
  chromaOffsetCache = rounded;

  const r = document.getElementById('chroma-r');
  const b = document.getElementById('chroma-b');
  // Target only the artwork elements (never the ambient light or text behind the art)
  const targets = [
    document.getElementById('track-art'),
    document.getElementById('side-art')
  ];
  if (rounded > 0.05) {
    if (r) r.setAttribute('dx', (-rounded).toFixed(2));
    if (b) b.setAttribute('dx', (rounded).toFixed(2));
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (target && !target.classList.contains('chroma-active')) {
        target.classList.add('chroma-active');
      }
    }
  } else {
    if (r) r.setAttribute('dx', '0');
    if (b) b.setAttribute('dx', '0');
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (target && target.classList.contains('chroma-active')) {
        target.classList.remove('chroma-active');
      }
    }
  }
}

function updateBeatSprings(dt) {
  const clampedDt = Math.min(0.045, (dt || 16.6) / 1000);
  if (clampedDt <= 0) return true;

  // Primary transient spring: critically damped
  const k = 230;
  const c = 26;
  const acc = -k * beatSpringPos - c * beatSpringVel;
  beatSpringVel += acc * clampedDt;
  beatSpringPos += beatSpringVel * clampedDt;

  // Secondary micro-pulse spring (faster snappy decay)
  const subK = 340;
  const subC = 34;
  const subAcc = -subK * subSpringPos - subC * subSpringVel;
  subSpringVel += subAcc * clampedDt;
  subSpringPos += subSpringVel * clampedDt;

  // Smooth exponential decay for chromatic displacement
  if (chromaAmount > 0.03) {
    chromaAmount -= chromaAmount * Math.min(1, clampedDt * 16);
    setChromaOffset(chromaAmount);
  } else if (chromaAmount > 0) {
    chromaAmount = 0;
    setChromaOffset(0);
  }

  // Publish spring scale and lamp glow to CSS variables
  const scaleMult = (sliderBeat / 100) * 0.9;
  const artScale = (sliderArt / 100);
  const currentScale = 1 + (beatSpringPos * 0.020 + subSpringPos * 0.006) * scaleMult * artScale;
  const lampSpring = (beatSpringPos * 0.25 + subSpringPos * 0.08) * scaleMult * artScale;

  const root = document.documentElement;
  root.style.setProperty('--beat-scale', currentScale.toFixed(4));
  root.style.setProperty('--lamp-beat-spring', lampSpring.toFixed(3));

  const settled = Math.abs(beatSpringPos) < 0.001 && Math.abs(beatSpringVel) < 0.004 &&
                  Math.abs(subSpringPos) < 0.001 && Math.abs(subSpringVel) < 0.004;
  if (settled) {
    beatSpringPos = 0;
    beatSpringVel = 0;
    subSpringPos = 0;
    subSpringVel = 0;
  }
  return settled;
}

function triggerBeatTransient(strength, isDrop) {
  if (sliderBeat === 0 || beatLevel === 0 || reducedMotion) return;
  const dropMult = isDrop ? 1.35 : 1.0;
  beatSpringVel = Math.min(1.8, beatSpringVel + (1.15 * strength * dropMult));

  if (sliderChroma > 0) {
    const chromaScale = (sliderChroma / 100);
    // Subtle, optical transient lens refraction on the cover art (capped at 1.2px)
    chromaAmount = Math.min(1.2, 0.85 * strength * dropMult * chromaScale);
    setChromaOffset(chromaAmount);
  }

  if (window.airPipeline && sliderParticles > 0) {
    const surge = (isDrop ? 2.2 : 0.9) * strength;
    window.airPipeline.onBeatImpulse(surge);
  }
}

function triggerSubBeatTransient(strength) {
  if (sliderBeat === 0 || beatLevel === 0 || reducedMotion) return;
  subSpringVel = Math.min(0.9, subSpringVel + (0.55 * strength));
  if (window.airPipeline && sliderParticles > 0 && sliderBeat >= 35) {
    window.airPipeline.onSubBeatImpulse(strength * 0.4);
  }
}

// =========================================================
// Audio-DSP-Clock Engine
// Jitter rejection filter + lookahead transient dispatch
// =========================================================
class AudioDspClockEngine {
  constructor() {
    this.lastMs = 0;
    this.jitterSamples = new Float32Array(8);
    this.jitterIdx = 0;
    this.avgJitter = 0;
    this.lastBeatGridIndex = -1;
    this.lastSubBeatGridIndex = -1;
  }

  reset() {
    this.lastMs = 0;
    this.jitterSamples.fill(0);
    this.jitterIdx = 0;
    this.avgJitter = 0;
    this.lastBeatGridIndex = -1;
    this.lastSubBeatGridIndex = -1;
  }

  recordJitter(sampleMs, wallDelta) {
    if (this.lastMs > 0 && wallDelta > 0) {
      const audioDelta = sampleMs - this.lastMs;
      const jitter = Math.abs(audioDelta - wallDelta);
      this.jitterSamples[this.jitterIdx] = jitter;
      this.jitterIdx = (this.jitterIdx + 1) & 7;
      let sum = 0;
      for (let i = 0; i < 8; i++) sum += this.jitterSamples[i];
      this.avgJitter = sum / 8;
    }
    this.lastMs = sampleMs;
  }

  process(ms, delta) {
    if (!beatPlan || sliderBeat === 0 || beatLevel === 0 || reducedMotion || !isPlaying) return;
    const run = beatRunAt(ms);
    if (!run) return;

    // Gate calm / no-beat parts: only fire pulses during genuine rhythm sections
    const beatMinGate = 0.46 * (1.1 - (sliderBeat / 100) * 0.3);
    if (run[2] < beatMinGate) return;

    const period = beatPlan.periodMs;
    if (period <= 0) return;

    const phaseOffset = beatPlan.phaseMs;
    const beatGridIdx = Math.floor((ms - phaseOffset) / period);
    const subGridIdx = Math.floor(((ms - phaseOffset) * 2) / period);

    const lookaheadMs = Math.max(8, Math.min(24, (delta || 16.6) * 0.75 + this.avgJitter * 0.5));
    const nextBeatMs = phaseOffset + (beatGridIdx + 1) * period;
    const timeToNextBeat = nextBeatMs - ms;

    if (beatGridIdx > this.lastBeatGridIndex && (timeToNextBeat <= lookaheadMs || ms >= phaseOffset + beatGridIdx * period)) {
      this.lastBeatGridIndex = beatGridIdx;
      const strength = run[2] * (sliderBeat / 100) * 0.90;
      const isDrop = beatPhaseAt(ms) === 'drop';
      triggerBeatTransient(strength, isDrop);
    }

    if (subGridIdx > this.lastSubBeatGridIndex && subGridIdx !== beatGridIdx * 2 && sliderBeat >= 35) {
      this.lastSubBeatGridIndex = subGridIdx;
      const strength = run[2] * (sliderBeat / 100) * 0.45;
      triggerSubBeatTransient(strength);
    }
  }
}

const audioDspClock = new AudioDspClockEngine();
window.audioDspClock = audioDspClock;

// =========================================================
// Song moments: Climax Moments & Dynamic Color Grading
// =========================================================
let momentPlan = null;     // the merged arrivals for the current track
let momentIndex = 0;       // cursor; the playhead usually walks forward
let momentLast = null;     // the moment the grade is currently on, or null
let momentsFired = { total: 0, drop: 0, hook: 0 };

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

function releaseMomentGrade() {
  const body = document.body;
  body.classList.remove('moment-live', 'moment-attack');
  body.style.removeProperty('--moment-strength');
  momentLast = null;
}

function stopMomentEngine() {
  momentPlan = null;
  momentIndex = 0;
  momentsFired = { total: 0, drop: 0, hook: 0 };
  releaseMomentGrade();
}

function startMomentEngine() {
  stopMomentEngine();
  if (sliderMoments === 0 || momentLevel === 0 || reducedMotion || miniMode) return;
  if (!lyrics || !lyrics.length) return;
  momentPlan = momentStarts(lyrics, beatPlan);
}

function updateMoment(ms) {
  const body = document.body;
  if (sliderMoments === 0 || momentLevel === 0 || reducedMotion || miniMode || !isPlaying || syncGlideInFlight()) {
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
    if (moment.kind === 'drop') {
      if (window.airPipeline && sliderParticles > 0) window.airPipeline.onBeatImpulse(1.8);
      if (sliderChroma > 0 && !reducedMotion) {
        const chromaScale = (sliderChroma / 100);
        chromaAmount = Math.min(1.2, chromaAmount + 0.60 * chromaScale);
        setChromaOffset(chromaAmount);
      }
    }
  }
  const depth = (sliderMoments / 100) * 0.70;
  body.style.setProperty('--moment-strength', (moment.strength * depth).toFixed(2));
  body.classList.toggle('moment-attack', moment.kind === 'drop');
  body.classList.add('moment-live');
}

// =========================================================
// Room air: GPU Particle Simulation Canvas
// Zero-allocation TypedArray pooling, fluid velocity trails, curl noise
// =========================================================
const DUST_COUNT = 28;

function dustHash(i, salt) {
  let h = Math.imul(i + 1, 2654435761) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

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

function parseCssColor(str, fallback = { r: 185, g: 205, b: 255 }) {
  if (!str || typeof str !== 'string') return fallback;
  str = str.trim();
  if (str.startsWith('#')) {
    const hex = str.slice(1);
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
      };
    }
    if (hex.length >= 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
  }
  const match = str.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (match) {
    return {
      r: Math.round(parseFloat(match[1])),
      g: Math.round(parseFloat(match[2])),
      b: Math.round(parseFloat(match[3])),
    };
  }
  return fallback;
}

class AirParticlePool {
  constructor(capacity = 120) {
    this.capacity = capacity;
    this.count = 0;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.prevX = new Float32Array(capacity);
    this.prevY = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.beatVx = new Float32Array(capacity);
    this.beatVy = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.rawSize = new Float32Array(capacity);
    this.meanSize = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.colorIdx = new Uint8Array(capacity);
    this.shapeType = new Uint8Array(capacity);
    this.shapeParam = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.rotSpeed = new Float32Array(capacity);
    this.baseRotSpeed = new Float32Array(capacity);
    this.bloom = new Float32Array(capacity);
    this.reactivity = new Float32Array(capacity);
    this.twinkleType = new Uint8Array(capacity);
    this.twinkleFreq = new Float32Array(capacity);
    this.twinklePhase = new Float32Array(capacity);
    this.twinkleDepth = new Float32Array(capacity);
    this.r = new Uint8Array(capacity);
    this.g = new Uint8Array(capacity);
    this.b = new Uint8Array(capacity);
  }

  spawn(x, y, vx, vy, rawSize, meanSize, maxLife, colorIdx, seed, r, g, b, shapeType = 0, shapeParam = 0.5, rot = 0, rotSpeed = 0, bloom = 1.0, reactivity = 1.0, twinkleType = 0, twinkleFreq = 2.0, twinklePhase = 0, twinkleDepth = 0.8) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.beatVx[i] = 0;
    this.beatVy[i] = 0;
    this.rawSize[i] = rawSize;
    this.meanSize[i] = meanSize;
    this.size[i] = rawSize;
    this.alpha[i] = 0;
    this.life[i] = 0;
    this.maxLife[i] = maxLife;
    this.colorIdx[i] = colorIdx;
    this.seed[i] = seed;
    this.shapeType[i] = shapeType;
    this.shapeParam[i] = shapeParam;
    this.rot[i] = rot;
    this.rotSpeed[i] = rotSpeed;
    this.baseRotSpeed[i] = rotSpeed;
    this.bloom[i] = bloom;
    this.reactivity[i] = reactivity;
    this.twinkleType[i] = twinkleType;
    this.twinkleFreq[i] = twinkleFreq;
    this.twinklePhase[i] = twinklePhase;
    this.twinkleDepth[i] = twinkleDepth;
    this.r[i] = r;
    this.g[i] = g;
    this.b[i] = b;
    return i;
  }

  clear() {
    this.count = 0;
  }
}

// --- Procedural Air Particle Geometries (Clean, Cool Celestial & Botanical) ---
// 0: Soft Stardust Mote (ethereal cosmic dust point with luminous pinpoint core)
// 1: Ethereal Floral Blossom (delicate sakura/plum bloom with organic curved petals, stamen beads & starlight heart)
// 2: Diamond Crystal Star (tapered 4-point radiant celestial starlight glint)
// 3: 8-Point Celestial Cross Star (major cardinal diffraction rays with diagonal micro-glints)

function drawAirBokehOrb(ctx, x, y, size, r, g, b, alpha, bloom) {
  // Refined cosmic stardust mote: clean, elegant pinpoint star with soft luminous corona
  const rad = size * 1.35 * bloom;
  const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.45})`);
  grad.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${alpha * 0.20})`);
  grad.addColorStop(0.70, `rgba(${r}, ${g}, ${b}, ${alpha * 0.05})`);
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fill();

  // Crisp starlight pinpoint core
  const coreRad = Math.max(0.9, size * 0.28);
  const coreGrad = ctx.createRadialGradient(x, y, 0, x, y, coreRad);
  coreGrad.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1.0, alpha * 0.95)})`);
  coreGrad.addColorStop(0.5, `rgba(255, 255, 255, ${alpha * 0.65})`);
  coreGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(x, y, coreRad, 0, Math.PI * 2);
  ctx.fill();
}

function drawAirEtherealFlower(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  // Soft ethereal floral ambient aura
  const haloRad = size * 1.65 * bloom;
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloRad);
  halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.38})`);
  halo.addColorStop(0.50, `rgba(${r}, ${g}, ${b}, ${alpha * 0.12})`);
  halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, haloRad, 0, Math.PI * 2);
  ctx.fill();

  const petalCount = shapeParam > 0.40 ? 5 : 4; // Organic 5-petal sakura or 4-petal delicate blossom
  const petalLen = size * 0.92;
  const petalWidth = size * (petalCount === 5 ? 0.42 : 0.46);

  for (let k = 0; k < petalCount; k++) {
    const angle = (k * Math.PI * 2) / petalCount;
    ctx.save();
    ctx.rotate(angle);

    // Each petal: graceful organic curve with subtle delicate sakura notch at apex
    ctx.beginPath();
    ctx.moveTo(0, 0);

    // Left flank curves outward
    ctx.bezierCurveTo(
      -petalWidth * 0.70, petalLen * 0.32,
      -petalWidth * 0.95, petalLen * 0.70,
      -petalWidth * 0.20, petalLen
    );

    // Subtle gentle sakura notch / indent at petal apex
    ctx.quadraticCurveTo(0, petalLen * 0.90, petalWidth * 0.20, petalLen);

    // Right flank curves back to origin
    ctx.bezierCurveTo(
      petalWidth * 0.95, petalLen * 0.70,
      petalWidth * 0.70, petalLen * 0.32,
      0, 0
    );
    ctx.closePath();

    // Petal gradient: rich tone at heart fading into translucent porcelain white at petal tip
    const petalGrad = ctx.createLinearGradient(0, 0, 0, petalLen);
    petalGrad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.76})`);
    petalGrad.addColorStop(0.55, `rgba(${Math.min(255, r + 40)}, ${Math.min(255, g + 40)}, ${Math.min(255, b + 40)}, ${alpha * 0.60})`);
    petalGrad.addColorStop(0.92, `rgba(255, 255, 255, ${alpha * 0.82})`);
    petalGrad.addColorStop(1, `rgba(255, 255, 255, ${alpha * 0.65})`);
    ctx.fillStyle = petalGrad;
    ctx.fill();

    // Delicate translucent petal contour rim
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.40})`;
    ctx.lineWidth = Math.max(0.6, size * 0.04);
    ctx.stroke();

    // Subtle translucent inner petal vein
    ctx.beginPath();
    ctx.moveTo(0, petalLen * 0.14);
    ctx.lineTo(0, petalLen * 0.66);
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.30})`;
    ctx.lineWidth = Math.max(0.5, size * 0.03);
    ctx.stroke();

    ctx.restore();
  }

  // Golden / warm stamen pollen points encircling the core
  const stamenCount = petalCount;
  const stamenDist = size * 0.26;
  const stamenRad = Math.max(0.7, size * 0.075);
  ctx.fillStyle = `rgba(255, 238, 185, ${Math.min(1.0, alpha * 0.92)})`;
  for (let s = 0; s < stamenCount; s++) {
    const sa = (s * Math.PI * 2) / stamenCount + (Math.PI / stamenCount);
    ctx.beginPath();
    ctx.arc(Math.cos(sa) * stamenDist, Math.sin(sa) * stamenDist, stamenRad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Luminous white starlight core
  const coreRad = Math.max(1.1, size * 0.18);
  const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreRad * 1.8);
  coreGrad.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1.0, alpha * 0.98)})`);
  coreGrad.addColorStop(0.5, `rgba(255, 248, 225, ${alpha * 0.72})`);
  coreGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(0, 0, coreRad * 1.8, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawAirDiamondStar(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  // Soft celestial aura
  const haloRad = size * 1.8 * bloom;
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloRad);
  halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.50})`);
  halo.addColorStop(0.40, `rgba(${r}, ${g}, ${b}, ${alpha * 0.18})`);
  halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, haloRad, 0, Math.PI * 2);
  ctx.fill();

  const rayLen = size * (1.35 + shapeParam * 0.45);
  const rayWidth = Math.max(0.8, size * (0.16 + shapeParam * 0.14));

  // Diamond ray fill with luminous gradient
  const starGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, rayLen);
  starGrad.addColorStop(0, `rgba(255, 255, 255, ${Math.min(1.0, alpha * 0.98)})`);
  starGrad.addColorStop(0.40, `rgba(255, 255, 255, ${alpha * 0.85})`);
  starGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${alpha * 0.20})`);
  ctx.fillStyle = starGrad;

  // Vertical ray
  ctx.beginPath();
  ctx.moveTo(0, -rayLen);
  ctx.quadraticCurveTo(0, 0, rayWidth, 0);
  ctx.quadraticCurveTo(0, 0, 0, rayLen);
  ctx.quadraticCurveTo(0, 0, -rayWidth, 0);
  ctx.quadraticCurveTo(0, 0, 0, -rayLen);
  ctx.closePath();
  ctx.fill();

  // Horizontal ray
  ctx.beginPath();
  ctx.moveTo(-rayLen, 0);
  ctx.quadraticCurveTo(0, 0, 0, rayWidth);
  ctx.quadraticCurveTo(0, 0, rayLen, 0);
  ctx.quadraticCurveTo(0, 0, 0, -rayWidth);
  ctx.quadraticCurveTo(0, 0, -rayLen, 0);
  ctx.closePath();
  ctx.fill();

  // Pure white crystal core
  const centerRad = Math.max(1.1, size * 0.24);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, centerRad, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawAirCelestialSparkle(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  // Ethereal starlight aura
  const haloRad = size * 1.9 * bloom;
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, haloRad);
  halo.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.52})`);
  halo.addColorStop(0.35, `rgba(${r}, ${g}, ${b}, ${alpha * 0.20})`);
  halo.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, haloRad, 0, Math.PI * 2);
  ctx.fill();

  // Primary 4 cardinal rays
  const mainLen = size * (1.4 + shapeParam * 0.5);
  const mainWidth = Math.max(0.7, size * 0.15);
  ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1.0, alpha * 0.95)})`;

  // Vertical
  ctx.beginPath();
  ctx.moveTo(0, -mainLen);
  ctx.quadraticCurveTo(0, 0, mainWidth, 0);
  ctx.quadraticCurveTo(0, 0, 0, mainLen);
  ctx.quadraticCurveTo(0, 0, -mainWidth, 0);
  ctx.closePath();
  ctx.fill();

  // Horizontal
  ctx.beginPath();
  ctx.moveTo(-mainLen, 0);
  ctx.quadraticCurveTo(0, 0, 0, mainWidth);
  ctx.quadraticCurveTo(0, 0, mainLen, 0);
  ctx.quadraticCurveTo(0, 0, 0, -mainWidth);
  ctx.closePath();
  ctx.fill();

  // 4 diagonal secondary micro-rays (38% length)
  const diagLen = mainLen * 0.40;
  const diagWidth = Math.max(0.5, mainWidth * 0.65);
  ctx.save();
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.72})`;

  ctx.beginPath();
  ctx.moveTo(0, -diagLen);
  ctx.quadraticCurveTo(0, 0, diagWidth, 0);
  ctx.quadraticCurveTo(0, 0, 0, diagLen);
  ctx.quadraticCurveTo(0, 0, -diagWidth, 0);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-diagLen, 0);
  ctx.quadraticCurveTo(0, 0, 0, diagWidth);
  ctx.quadraticCurveTo(0, 0, diagLen, 0);
  ctx.quadraticCurveTo(0, 0, 0, -diagWidth);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  // Diamond center glint
  const coreRad = Math.max(1.2, size * 0.22);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(0, 0, coreRad, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// Aliases for legacy/backward compatibility:
function drawAirBulbousCross(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam) {
  drawAirEtherealFlower(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam);
}
function drawAirPrismRing(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam) {
  drawAirCelestialSparkle(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam);
}
function drawAirBulbousSpore(ctx, x, y, size, angle, r, g, b, alpha, bloom, shapeParam) {
  drawAirDiamondStar(ctx, x, y, size, angle, r, g, b, alpha, bloom, shapeParam);
}
function drawAirNebulaCloud(ctx, x, y, size, rot, r, g, b, alpha, bloom, shapeParam) {
  drawAirBokehOrb(ctx, x, y, size, r, g, b, alpha, bloom);
}

class AirParticlePipeline {
  constructor() {
    this.canvas = null;
    this.ctx = null;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.pool = new AirParticlePool(120);
    this.lastSpawn = 0;
    this.colorA = { r: 185, g: 205, b: 255 };
    this.colorB = { r: 220, g: 235, b: 255 };
    this.setupDone = false;
    this.resizeObserver = null;
  }

  init() {
    this.canvas = document.getElementById('fx-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d', { alpha: true });
    this.resize();
    window.addEventListener('resize', () => this.resize(), { passive: true });

    if (window.ResizeObserver && !this.resizeObserver) {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          if (cr.width > 0 && cr.height > 0) {
            this.handleResize(cr.width, cr.height);
          }
        }
      });
      this.resizeObserver.observe(this.canvas);
    }

    this.updateColors();
    this.seedParticles();
    this.setupDone = true;
  }

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    this.handleResize(w, h);
  }

  handleResize(newW, newH) {
    if (!this.canvas || newW <= 0 || newH <= 0) return;
    const oldW = this.width;
    const oldH = this.height;

    this.width = newW;
    this.height = newH;
    this.dpr = Math.min(2.0, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(newW * this.dpr);
    this.canvas.height = Math.round(newH * this.dpr);

    const p = this.pool;
    if (oldW > 0 && oldH > 0 && p.count > 0 && (Math.abs(oldW - newW) > 2 || Math.abs(oldH - newH) > 2)) {
      const scaleX = newW / oldW;
      const scaleY = newH / oldH;
      for (let i = 0; i < p.count; i++) {
        p.x[i] *= scaleX;
        p.y[i] *= scaleY;
        p.prevX[i] *= scaleX;
        p.prevY[i] *= scaleY;
      }
    } else if (p.count === 0 && sliderParticles > 0) {
      this.seedParticles();
    }
  }

  computeParticleColor(yPos, seedIndex) {
    const isTop = yPos < (this.height * 0.52 + (dustHash(seedIndex, 7) - 0.5) * (this.height * 0.2));
    const base = isTop ? this.colorA : this.colorB;

    const jitter = (dustHash(seedIndex, 8) - 0.5) * 32;
    const highlight = dustHash(seedIndex, 9) > 0.82;

    let r, g, b;
    if (highlight) {
      r = Math.min(255, Math.max(160, Math.round(base.r * 0.6 + 255 * 0.4 + jitter * 0.5)));
      g = Math.min(255, Math.max(160, Math.round(base.g * 0.6 + 255 * 0.4 + jitter * 0.5)));
      b = Math.min(255, Math.max(160, Math.round(base.b * 0.6 + 255 * 0.4 + jitter * 0.5)));
    } else {
      r = Math.min(255, Math.max(10, Math.round(base.r + jitter * 1.15)));
      g = Math.min(255, Math.max(10, Math.round(base.g + jitter * 0.95)));
      b = Math.min(255, Math.max(10, Math.round(base.b + jitter * 1.25)));
    }
    return { r, g, b };
  }

  updateColors() {
    const root = document.documentElement;
    const c1 = root.style.getPropertyValue('--mote-a').trim() ||
               root.style.getPropertyValue('--art-accent').trim() || '#b9cdff';
    const c2 = root.style.getPropertyValue('--mote-b').trim() ||
               root.style.getPropertyValue('--art-accent').trim() || '#e0ecff';
    this.colorA = parseCssColor(c1, { r: 185, g: 205, b: 255 });
    this.colorB = parseCssColor(c2, { r: 220, g: 235, b: 255 });

    const p = this.pool;
    for (let i = 0; i < p.count; i++) {
      const c = this.computeParticleColor(p.y[i], i);
      p.r[i] = c.r;
      p.g[i] = c.g;
      p.b[i] = c.b;
    }
  }

  seedParticles() {
    this.pool.clear();
    const targetCount = sliderParticles > 0 ? sliderParticles : 0;
    if (targetCount <= 0 || this.width <= 0 || this.height <= 0) return;

    for (let i = 0; i < targetCount; i++) {
      // Distribute evenly across the FULL window height and width
      const x = (dustHash(i, 1) * 0.96 + 0.02) * this.width;
      const y = (dustHash(i, 2) * 0.96 + 0.02) * this.height;

      const hashVal = dustHash(i, 11);
      let shapeType = 0;
      let rawSize = 8;
      let meanSize = 8;
      let reactivity = 1.0;

      if (hashVal < 0.32) {
        shapeType = 0; // Ethereal Stardust Mote
        meanSize = 6.5;
        rawSize = 4.0 + dustHash(i, 3) * 5.0;
        reactivity = 0.40 + dustHash(i, 17) * 0.30;
      } else if (hashVal < 0.60) {
        shapeType = 2; // Diamond Crystal Sparkle Star
        meanSize = 9.5;
        rawSize = 6.0 + dustHash(i, 3) * 7.5;
        reactivity = 0.80 + dustHash(i, 17) * 0.65;
      } else if (hashVal < 0.82) {
        shapeType = 3; // 8-Point Celestial Cross Star
        meanSize = 10.5;
        rawSize = 6.5 + dustHash(i, 3) * 8.0;
        reactivity = 0.75 + dustHash(i, 17) * 0.60;
      } else {
        shapeType = 1; // Ethereal Floral Blossom
        meanSize = 12.5;
        rawSize = 8.5 + dustHash(i, 3) * 8.0;
        reactivity = 0.60 + dustHash(i, 17) * 0.50;
      }

      const shapeParam = dustHash(i, 18);
      const maxLife = 16000 + dustHash(i, 5) * 18000;
      const life = dustHash(i, 4) * maxLife;
      const colorIdx = i % 2;
      const seed = dustHash(i, 6) * 100;
      const col = this.computeParticleColor(y, i);
      const rot = dustHash(i, 12) * Math.PI * 2;

      // Significantly reduced rotation speeds: mostly meditative drift, high speeds rare & strictly capped
      const speedTier = dustHash(i, 13);
      let rotSpeed = 0;
      if (speedTier < 0.65) {
        rotSpeed = (dustHash(i, 19) - 0.5) * 0.0018; // Serene drift
      } else if (speedTier < 0.90) {
        rotSpeed = (dustHash(i, 19) - 0.5) * 0.0036; // Gentle turn
      } else {
        rotSpeed = (dustHash(i, 19) - 0.5) * 0.0060; // Moderate turn (capped)
      }

      const bloom = 0.85 + dustHash(i, 14) * 0.5;
      const vx = (dustHash(i, 15) - 0.5) * 0.20;
      const vy = -0.05 - dustHash(i, 16) * 0.18;

      // Twinkling animation distribution
      const twVal = dustHash(i, 20);
      let twinkleType = 0;
      if (twVal < 0.40) twinkleType = 1; // Glint sparkle twinkle
      else if (twVal < 0.70) twinkleType = 2; // Breathing swell
      else twinkleType = 0; // Steady ambient

      const twinkleFreq = 1.6 + dustHash(i, 21) * 2.2;
      const twinklePhase = dustHash(i, 22) * Math.PI * 2;
      const twinkleDepth = 0.6 + dustHash(i, 23) * 0.6;

      const idx = this.pool.spawn(
        x, y, vx, vy, rawSize, meanSize, maxLife, colorIdx, seed, col.r, col.g, col.b,
        shapeType, shapeParam, rot, rotSpeed, bloom, reactivity,
        twinkleType, twinkleFreq, twinklePhase, twinkleDepth
      );
      if (idx >= 0) {
        this.pool.life[idx] = life;
      }
    }
  }

  spawnParticle(i, respawnAnywhere = false) {
    const p = this.pool;
    p.life[i] = 0;
    p.maxLife[i] = 16000 + Math.random() * 18000;
    p.beatVx[i] = 0;
    p.beatVy[i] = 0;

    if (respawnAnywhere) {
      // Re-seed smoothly anywhere across the room so particles never cluster!
      p.x[i] = Math.random() * this.width;
      p.y[i] = Math.random() * this.height;
    } else {
      const edge = Math.random();
      if (edge < 0.5) {
        p.x[i] = Math.random() * this.width;
        p.y[i] = this.height + 15;
      } else if (edge < 0.75) {
        p.x[i] = Math.random() < 0.5 ? -15 : this.width + 15;
        p.y[i] = Math.random() * this.height;
      } else {
        p.x[i] = Math.random() * this.width;
        p.y[i] = Math.random() * (this.height * 0.7);
      }
    }

    p.prevX[i] = p.x[i];
    p.prevY[i] = p.y[i];

    const hashVal = Math.random();
    let rawSize = 8;
    let meanSize = 8;
    if (hashVal < 0.32) {
      p.shapeType[i] = 0; // Ethereal Stardust Mote
      meanSize = 6.5;
      rawSize = 4.0 + Math.random() * 5.0;
      p.reactivity[i] = 0.40 + Math.random() * 0.30;
    } else if (hashVal < 0.60) {
      p.shapeType[i] = 2; // Diamond Crystal Sparkle Star
      meanSize = 9.5;
      rawSize = 6.0 + Math.random() * 7.5;
      p.reactivity[i] = 0.80 + Math.random() * 0.65;
    } else if (hashVal < 0.82) {
      p.shapeType[i] = 3; // 8-Point Celestial Cross Star
      meanSize = 10.5;
      rawSize = 6.5 + Math.random() * 8.0;
      p.reactivity[i] = 0.75 + Math.random() * 0.60;
    } else {
      p.shapeType[i] = 1; // Ethereal Floral Blossom
      meanSize = 12.5;
      rawSize = 8.5 + Math.random() * 8.0;
      p.reactivity[i] = 0.60 + Math.random() * 0.50;
    }

    p.rawSize[i] = rawSize;
    p.meanSize[i] = meanSize;
    p.size[i] = rawSize;

    p.shapeParam[i] = Math.random();
    p.vx[i] = (Math.random() - 0.5) * 0.20;
    p.vy[i] = -0.05 - Math.random() * 0.18;
    p.rot[i] = Math.random() * Math.PI * 2;

    const speedTier = Math.random();
    if (speedTier < 0.65) {
      p.rotSpeed[i] = (Math.random() - 0.5) * 0.0018;
    } else if (speedTier < 0.90) {
      p.rotSpeed[i] = (Math.random() - 0.5) * 0.0036;
    } else {
      p.rotSpeed[i] = (Math.random() - 0.5) * 0.0060;
    }
    p.baseRotSpeed[i] = p.rotSpeed[i];

    p.bloom[i] = 0.85 + Math.random() * 0.5;
    p.seed[i] = Math.random() * 100;

    const twVal = Math.random();
    if (twVal < 0.40) p.twinkleType[i] = 1;
    else if (twVal < 0.70) p.twinkleType[i] = 2;
    else p.twinkleType[i] = 0;

    p.twinkleFreq[i] = 1.6 + Math.random() * 2.2;
    p.twinklePhase[i] = Math.random() * Math.PI * 2;
    p.twinkleDepth[i] = 0.6 + Math.random() * 0.6;

    const col = this.computeParticleColor(p.y[i], i);
    p.r[i] = col.r;
    p.g[i] = col.g;
    p.b[i] = col.b;
  }

  onBeatImpulse(surge) {
    if (sliderParticles === 0 || ambientLevel === 0 || reducedMotion) return;
    const p = this.pool;
    const mult = surge * (sliderParticles >= 40 ? 1.1 : 0.85);
    const halfW = this.width * 0.5;
    const halfH = this.height * 0.5;

    for (let i = 0; i < p.count; i++) {
      const react = p.reactivity[i];
      if (react <= 0.05) continue; // Inertial particle maintains serene drift

      const hash1 = dustHash(i, 7);
      const hash2 = dustHash(i, 8);
      const hash3 = dustHash(i, 9);

      // Varied response patterns: upward lift, lateral draft, radial expansion, swirl
      const behavior = i % 4;
      let impulseX = 0;
      let impulseY = 0;

      if (behavior === 0) {
        // Gentle acoustic vertical lift
        impulseY = -(0.22 + hash1 * 0.38) * mult * react;
        impulseX = (hash2 - 0.5) * 0.22 * mult * react;
      } else if (behavior === 1) {
        // Lateral acoustic draft with subtle loft
        impulseX = (hash2 > 0.5 ? 1 : -1) * (0.16 + hash1 * 0.32) * mult * react;
        impulseY = -(0.06 + hash3 * 0.16) * mult * react;
      } else if (behavior === 2) {
        // Radial expansion wave from room center
        const dx = p.x[i] - halfW;
        const dy = p.y[i] - halfH;
        const dist = Math.hypot(dx, dy) || 1;
        const push = (0.14 + hash1 * 0.28) * mult * react;
        impulseX = (dx / dist) * push;
        impulseY = (dy / dist) * push - 0.10 * mult * react;
      } else {
        // Swirl / acoustic eddy lift
        const swirlAngle = Math.atan2(p.y[i] - halfH, p.x[i] - halfW) + Math.PI * 0.5;
        const push = (0.12 + hash1 * 0.24) * mult * react;
        impulseX = Math.cos(swirlAngle) * push;
        impulseY = Math.sin(swirlAngle) * push - 0.12 * mult * react;
      }

      // Smoothly accumulate into beat momentum buffers (smoothly decayed each frame)
      p.beatVx[i] += impulseX;
      p.beatVy[i] += impulseY;

      // Micro rotation nudge with strict cap to prevent rapid spinning
      const rotKick = (hash3 - 0.5) * 0.0014 * mult * react;
      p.rotSpeed[i] = Math.max(-0.007, Math.min(0.007, p.rotSpeed[i] + rotKick));
    }
  }

  onSubBeatImpulse(strength) {
    if (sliderParticles === 0 || ambientLevel === 0 || reducedMotion) return;
    const p = this.pool;
    for (let i = 0; i < p.count; i++) {
      const react = p.reactivity[i];
      p.beatVy[i] -= (0.04 + dustHash(i, 10) * 0.08) * strength * react;
    }
  }

  updateAndRender(dt, now) {
    if (sliderParticles === 0 || ambientLevel === 0 || reducedMotion || miniMode) {
      if (this.ctx && this.pool.count > 0) {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.pool.clear();
      }
      return;
    }

    if (!this.setupDone) this.init();
    if (!this.ctx) return;

    const curW = this.canvas.clientWidth || window.innerWidth;
    const curH = this.canvas.clientHeight || window.innerHeight;
    if (curW > 0 && curH > 0 && (Math.abs(curW - this.width) > 2 || Math.abs(curH - this.height) > 2)) {
      this.handleResize(curW, curH);
    }
    if (this.width <= 0 || this.height <= 0) return;

    const ctx = this.ctx;
    const p = this.pool;
    const targetCount = sliderParticles;
    const clampedDt = Math.min(50, dt || 16.6);

    // Smoothly spawn towards targetCount across the whole view
    if (p.count < targetCount && (now - this.lastSpawn > 80)) {
      this.lastSpawn = now;
      const i = p.count;
      this.spawnParticle(i, true);
      p.count++;
    }

    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'lighter';

    // Exponential acoustic air drag (~280ms relaxation) for silky smooth beat transition
    const acousticDrag = Math.exp(-clampedDt / 280);

    const activeCount = Math.min(p.count, targetCount);
    for (let i = 0; i < activeCount; i++) {
      p.life[i] += clampedDt;

      // When life expires, smoothly respawn at a new position anywhere across the screen
      if (p.life[i] >= p.maxLife[i]) {
        this.spawnParticle(i, true);
      } else if (p.y[i] < -35) {
        p.y[i] = this.height + 15;
        p.x[i] = Math.random() * this.width;
        p.prevX[i] = p.x[i];
        p.prevY[i] = p.y[i];
      } else if (p.y[i] > this.height + 35) {
        p.y[i] = -15;
        p.x[i] = Math.random() * this.width;
        p.prevX[i] = p.x[i];
        p.prevY[i] = p.y[i];
      } else if (p.x[i] < -35) {
        p.x[i] = this.width + 15;
        p.prevX[i] = p.x[i];
      } else if (p.x[i] > this.width + 35) {
        p.x[i] = -15;
        p.prevX[i] = p.x[i];
      }

      p.prevX[i] = p.x[i];
      p.prevY[i] = p.y[i];

      // Smooth decay of beat-induced velocity momentum
      p.beatVx[i] *= acousticDrag;
      p.beatVy[i] *= acousticDrag;

      const seed = p.seed[i];
      const t = p.life[i] * 0.001;
      const curlX = Math.sin(t * 0.7 + seed) * 0.35 + Math.cos(t * 1.3 + seed * 2) * 0.15;
      const curlY = Math.cos(t * 0.6 + seed * 1.5) * 0.22 - 0.14;

      p.vx[i] = p.vx[i] * 0.95 + curlX * 0.05;
      p.vy[i] = p.vy[i] * 0.95 + curlY * 0.05;

      // Effective velocity combines base atmospheric curl and smooth beat impulse
      const effVx = p.vx[i] + p.beatVx[i];
      const effVy = p.vy[i] + p.beatVy[i];

      p.x[i] += effVx * clampedDt * 0.06;
      p.y[i] += effVy * clampedDt * 0.06;

      // Continuous damping of rotation speed back towards base serene speed
      p.rotSpeed[i] = p.rotSpeed[i] * 0.95 + p.baseRotSpeed[i] * 0.05;
      p.rot[i] += p.rotSpeed[i];

      // Lifecycle opacity curve: smooth sine entrance and fadeout
      const progress = p.life[i] / p.maxLife[i];
      let alpha = 1.0;
      if (progress < 0.20) {
        alpha = Math.sin((progress / 0.20) * (Math.PI / 2));
      } else if (progress > 0.80) {
        alpha = Math.sin(((1.0 - progress) / 0.20) * (Math.PI / 2));
      }

      // Dynamic particle animations (Twinkling, Breathing, Ambient micro-shimmer)
      let scaleMult = 1.0;
      let bloomMult = 1.0;
      const twType = p.twinkleType[i];

      if (twType === 1) {
        // Sparkling glint twinkle: sharp periodic flare in brightness, size, and bloom
        const twCycle = Math.sin(t * p.twinkleFreq[i] + p.twinklePhase[i]);
        const glint = Math.pow(Math.max(0, twCycle), 6);
        const depth = p.twinkleDepth[i];
        alpha *= (0.42 + 0.38 * Math.sin(t * 1.1 + seed) + glint * 1.3 * depth);
        scaleMult = 1.0 + glint * 0.38 * depth;
        bloomMult = 1.0 + glint * 0.85 * depth;
      } else if (twType === 2) {
        // Breathing swell: smooth rhythmic expansion and contraction
        const breath = Math.sin(t * 0.85 + seed);
        alpha *= (0.76 + breath * 0.24);
        scaleMult = 1.0 + breath * 0.12;
      } else {
        // Steady ambient with subtle organic shimmer
        const shimmer = 0.88 + Math.sin(t * 1.6 + seed) * 0.12;
        alpha *= shimmer;
      }

      alpha = Math.min(1.0, Math.max(0, alpha));

      const levelMult = Math.min(1.0, 0.45 + (sliderParticles / 80) * 0.55);
      alpha *= levelMult;

      // Master particle opacity from settings sub-option
      const opacityFactor = Math.max(0.10, Math.min(1.0, (sliderParticleOpacity || 80) / 100));
      alpha *= opacityFactor;

      if (p.shapeType[i] === 0) {
        alpha *= 0.65;
      }

      p.alpha[i] = alpha;

      const r = p.r[i], g = p.g[i], b = p.b[i];

      // Compute effective size based on sliderParticleSize (0% = uniform meanSize, 100% = full rawSize variation)
      const varFactor = Math.max(0, Math.min(1.0, (sliderParticleSize !== undefined ? sliderParticleSize : 70) / 100));
      const baseEffectiveSize = p.meanSize[i] * (1.0 - varFactor) + p.rawSize[i] * varFactor;
      const size = baseEffectiveSize * scaleMult;

      const bloom = p.bloom[i] * bloomMult;
      const shape = p.shapeType[i];
      const param = p.shapeParam[i];

      if (shape === 0) {
        drawAirBokehOrb(ctx, p.x[i], p.y[i], size, r, g, b, alpha, bloom);
      } else if (shape === 1) {
        drawAirEtherealFlower(ctx, p.x[i], p.y[i], size, p.rot[i], r, g, b, alpha, bloom, param);
      } else if (shape === 2) {
        drawAirDiamondStar(ctx, p.x[i], p.y[i], size, p.rot[i], r, g, b, alpha, bloom, param);
      } else if (shape === 3) {
        drawAirCelestialSparkle(ctx, p.x[i], p.y[i], size, p.rot[i], r, g, b, alpha, bloom, param);
      } else {
        drawAirDiamondStar(ctx, p.x[i], p.y[i], size, p.rot[i], r, g, b, alpha, bloom, param);
      }
    }

    ctx.restore();
  }
}

const airPipeline = new AirParticlePipeline();
window.airPipeline = airPipeline;

function buildDustField() {
  if (window.airPipeline) window.airPipeline.init();
  const field = document.getElementById('dust-field');
  if (!field) return field;
  if (field.childElementCount) field.textContent = '';
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
  applyMoteTints();
  return field;
}

function moteTintIndex(mote) {
  const seam = mote.y + (dustHash(Math.round(mote.y * 1000), 7) - 0.5) * 0.3;
  return seam < 0.5 ? 0 : 1;
}

let moteTintCache = ['', '', 0];
function applyMoteTints() {
  if (window.airPipeline) window.airPipeline.updateColors();
  const field = document.getElementById('dust-field');
  if (!field) return;
  const root = document.documentElement;
  const tints = [
    root.style.getPropertyValue('--mote-a').trim(),
    root.style.getPropertyValue('--mote-b').trim(),
  ];
  if (tints[0] === moteTintCache[0] && tints[1] === moteTintCache[1] &&
      field.childElementCount === moteTintCache[2]) return;
  moteTintCache = [tints[0], tints[1], field.childElementCount];
  for (const el of field.children) {
    const my = parseFloat(el.style.getPropertyValue('--my')) / 100;
    const idx = moteTintIndex({ y: my });
    const tint = tints[idx];
    if (tint) el.style.setProperty('--mote-c', tint);
    else el.style.removeProperty('--mote-c');
  }
}

function applyAmbientMode() {
  document.body.classList.toggle('ambient-off', ambientLevel === 0);
  const op = AMBIENT_LEVEL_OPACITIES[ambientLevel] || 0;
  document.documentElement.style.setProperty('--dust-op', String(op));
  document.documentElement.style.setProperty('--fx-canvas-op', String(op));
  if (window.airPipeline) {
    window.airPipeline.resize();
    window.airPipeline.seedParticles();
  }
}

// =========================================================
// Cover tilt
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

function setTilt(x, y) {
  const root = document.documentElement;
  root.style.setProperty('--tilt-x', x.toFixed(3));
  root.style.setProperty('--tilt-y', y.toFixed(3));
}

function resetTilt() {
  pendingTilt = null;
  tiltRects.clear();
  setTilt(0, 0);
}

let pendingTilt = null;
let tiltFrame = 0;
function scheduleTilt(x, y) {
  pendingTilt = { x: x, y: y };
  if (tiltFrame) return;
  tiltFrame = requestAnimationFrame(() => {
    tiltFrame = 0;
    const v = pendingTilt;
    pendingTilt = null;
    if (v) setTilt(v.x, v.y);
  });
}

const tiltRects = new Map();
function tiltRectFor(wrap) {
  let rect = tiltRects.get(wrap);
  if (!rect || !rect.width) {
    rect = wrap.getBoundingClientRect();
    tiltRects.set(wrap, rect);
  }
  return rect;
}

function applyTiltMode() {
  document.documentElement.style.setProperty('--tilt-amp', String(TILT_LEVEL_AMPS[tiltLevel] || 0));
}

function initArtTilt() {
  const wraps = [document.getElementById('float-art-wrap'), document.querySelector('.side-art-wrap')];
  for (const wrap of wraps) {
    if (!wrap) continue;
    wrap.addEventListener('mouseenter', () => { tiltRects.delete(wrap); tiltRectFor(wrap); });
    wrap.addEventListener('mousemove', (event) => {
      if (tiltLevel === 0 || reducedMotion || miniMode) return;
      const v = tiltVector(event.clientX, event.clientY, tiltRectFor(wrap));
      scheduleTilt(v.x, v.y);
    });
    wrap.addEventListener('mouseleave', resetTilt);
  }
  window.addEventListener('resize', () => tiltRects.clear());
  window.addEventListener('scroll', () => tiltRects.clear(), true);
  window.addEventListener('blur', resetTilt);
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

// Why the syllable-synced lookup was skipped, when it was. The Python resolver
// reports exactly one of these, and the row is left out entirely when Spicy
// supplied the lyrics, so a healthy report is not padded with an empty line.
// 'no-track-id' is the interesting one: an API key is set but no Spotify id
// could be resolved, which means every track is quietly falling back to LRCLIB.
const RESOLVE_LABELS = {
  'no-key': 'Spicy skipped \u00b7 no API key',
  'no-track-id': 'no Spotify track id found',
  'no-lyrics': 'Spicy has no lyrics for this track'
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
    // Rendered only when the resolver reported one: see RESOLVE_LABELS.
    ...(d.resolve ? [['Resolution', RESOLVE_LABELS[d.resolve] || d.resolve]] : []),
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
  // The Local lyrics group counts this snapshot while it is closed, and this is
  // the one funnel every library change comes through.
  syncSettingsGroupSummaries();
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

// =========================================================
// Spicy Lyrics API Key Settings Controller
// =========================================================
let spicyKeyVisible = false;
let spicyKeyBusy = false;

function refreshSpicyApiKey() {
  if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.get_spicy_api_key) {
    return Promise.resolve();
  }
  return window.pywebview.api.get_spicy_api_key()
    .then((res) => {
      applySpicyKeyState(res);
    })
    .catch(() => {});
}

function applySpicyKeyState(res) {
  const badge = document.getElementById('spicy-key-badge');
  const status = document.getElementById('spicy-key-status');
  const input = document.getElementById('spicy-key-input');
  if (!badge || !status || !input) return;

  const isSet = Boolean(res && res.set);
  badge.classList.remove('is-connected', 'is-warning', 'is-error');
  if (isSet) {
    badge.classList.add('is-connected');
    badge.textContent = 'Configured';
    status.textContent = res.masked ? res.masked : 'Syllable sync active';
    if (!input.dataset.editing && res.key) {
      input.value = res.key;
    }
  } else {
    badge.textContent = 'Not configured';
    status.textContent = 'Using LRCLIB line fallback';
    if (!input.dataset.editing) {
      input.value = '';
    }
  }
  // The group's closed row reads this badge, so it has to follow it.
  syncSettingsGroupSummaries();
}

function saveSpicyApiKey() {
  const input = document.getElementById('spicy-key-input');
  if (!input || spicyKeyBusy) return;

  const keyVal = input.value.trim();
  spicyKeyBusy = true;
  setSpicyFeedback('Saving key…', 'is-info');

  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_spicy_api_key) {
    window.pywebview.api.set_spicy_api_key(keyVal)
      .then((res) => {
        spicyKeyBusy = false;
        input.dataset.editing = '';
        if (res && res.verified) {
          setSpicyFeedback(res.status || 'Key saved & verified!', 'is-success');
        } else if (res && res.key_set) {
          setSpicyFeedback(res.status || 'Key saved.', 'is-warning');
        } else {
          setSpicyFeedback(res.status || 'Key cleared.', 'is-info');
        }
        refreshSpicyApiKey();
      })
      .catch((err) => {
        spicyKeyBusy = false;
        setSpicyFeedback('Failed to save key: ' + (err && err.message ? err.message : err), 'is-error');
      });
  } else {
    spicyKeyBusy = false;
    setSpicyFeedback('Native bridge unavailable in browser mode.', 'is-error');
  }
}

function clearSpicyApiKey() {
  const input = document.getElementById('spicy-key-input');
  if (input) {
    input.value = '';
    input.dataset.editing = '';
  }
  saveSpicyApiKey();
}

function toggleSpicyKeyVisibility() {
  const input = document.getElementById('spicy-key-input');
  if (!input) return;
  spicyKeyVisible = !spicyKeyVisible;
  input.type = spicyKeyVisible ? 'text' : 'password';
}

function setSpicyFeedback(text, modifier) {
  const fb = document.getElementById('spicy-key-feedback');
  if (!fb) return;
  fb.className = 'spicy-key-feedback visible' + (modifier ? ' ' + modifier : '');
  fb.textContent = text;
  if (!modifier || modifier === 'is-success' || modifier === 'is-info') {
    setTimeout(() => {
      if (fb.textContent === text) {
        fb.classList.remove('visible');
      }
    }, 4500);
  }
}

function initSpicyKeySettings() {
  const saveBtn = document.getElementById('spicy-key-save');
  const clearBtn = document.getElementById('spicy-key-clear');
  const toggleBtn = document.getElementById('spicy-key-toggle');
  const input = document.getElementById('spicy-key-input');

  if (saveBtn) saveBtn.addEventListener('click', saveSpicyApiKey);
  if (clearBtn) clearBtn.addEventListener('click', clearSpicyApiKey);
  if (toggleBtn) toggleBtn.addEventListener('click', toggleSpicyKeyVisibility);
  if (input) {
    input.addEventListener('input', () => { input.dataset.editing = 'true'; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveSpicyApiKey();
      }
    });
  }
}

// The settings page owns the whole window, so there is nothing to anchor it to
// and no click-outside to close it: it opens over everything and closes from its
// own button, Escape, or Ctrl+, again.
let settingsLastFocus = null;

// The sheet is four pages, and the last one read is where it opens next time —
// the set-once work (the TTML library) should not need finding again. The saved
// value is validated against the markup rather than trusted, the way motionStyle
// is, so a stale key from an older build cannot hide every page.
// =========================================================
// Collapsible settings groups
// Every page opens as a stack of summary rows you can scan, and each one
// expands in place. The rows are NOT moved into a wrapper: the settings search
// lifts rows in and out of the group node, so a group's children have to stay
// exactly where they are. Collapsing is therefore a class on the group (see
// .sp-group.collapsed in the stylesheet).
// =========================================================
const SP_GROUP_SUMMARY = {
  window: () => settingsGroupStateText('qp-layout-state'),
  sync: () => settingsGroupStateText('qp-latency'),
  lyrics: () => settingsGroupStateText('qp-linesync-state'),
  fonts: () => settingsGroupStateText('qp-font-state'),
  'spicy-lyrics-api': () => settingsGroupStateText('spicy-key-badge'),
  // The library's status line is transient by design, so the row counts what
  // the panel would list instead.
  'local-lyrics': () => {
    const entries = ttmlSnapshot && Array.isArray(ttmlSnapshot.entries)
      ? ttmlSnapshot.entries.length : 0;
    return entries ? entries + (entries === 1 ? ' file' : ' files') : '';
  },
  motion: () => `${EFFECT_LEVEL_LABELS[beatLevel] || 'Subtle'} \u00b7 ${settingsGroupStateText('qp-motion-style-state')}`,
};

function settingsGroupStateText(id) {
  const el = document.getElementById(id);
  return el ? (el.textContent || '').trim() : '';
}

function settingsGroupSlug(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function settingsGroupNode(slug) {
  return document.querySelector('#qp-body .sp-group[data-group="' + slug + '"]');
}

function settingsGroupOpen(slug) {
  return Settings.get('spGroup_' + slug, '1') === '1';
}

function applySettingsGroup(slug, open, persist) {
  const group = settingsGroupNode(slug);
  if (!group) return;
  group.classList.toggle('collapsed', !open);
  const toggle = group.querySelector('.sp-group-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  // Restoring a group at boot must not rewrite the state it is restoring.
  if (persist) Settings.set('spGroup_' + slug, open ? '1' : '0');
}

function toggleSettingsGroup(slug) {
  const group = settingsGroupNode(slug);
  if (group) applySettingsGroup(slug, group.classList.contains('collapsed'), true);
}

// A closed group still says where it stands, using the state the panel sync
// already keeps, so closing a group hides controls and not information.
function syncSettingsGroupSummaries() {
  for (const [slug, read] of Object.entries(SP_GROUP_SUMMARY)) {
    const out = document.getElementById('sp-group-sum-' + slug);
    if (!out) continue;
    const text = read() || '';
    if (out.textContent !== text) out.textContent = text;
  }
}

// Built from the sheet's own markup at boot, so a group added to any page is a
// dropdown without new markup to keep in step.
function initSettingsGroups() {
  for (const group of document.querySelectorAll('#qp-body .sp-panel .sp-group')) {
    const title = group.querySelector('.sp-group-title');
    if (!title || group.dataset.group) continue;
    // A group that says so in the markup stays open, with no toggle at all. The
    // Diagnostics page is the case: its one row already carries the disclosure
    // (Resolve report → Show / Hide), so a dropdown on the heading would open
    // onto a single row that has a chevron of its own. Declared in the markup
    // (data-static) because which group that is is a fact about the page, not a
    // rule the script should hold.
    if (group.hasAttribute('data-static')) continue;
    const name = title.textContent.trim();
    const slug = settingsGroupSlug(name);
    if (!slug) continue;
    group.dataset.group = slug;
    group.dataset.groupName = name;
    if (!group.id) group.id = 'sp-group-' + slug;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sp-group-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', group.id);
    const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    caret.setAttribute('class', 'sp-group-caret');
    caret.setAttribute('viewBox', '0 0 24 24');
    caret.setAttribute('fill', 'none');
    caret.setAttribute('stroke', 'currentColor');
    caret.setAttribute('stroke-width', '2.4');
    caret.setAttribute('stroke-linecap', 'round');
    caret.setAttribute('stroke-linejoin', 'round');
    caret.setAttribute('aria-hidden', 'true');
    const stem = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stem.setAttribute('d', 'M9 5l7 7-7 7');
    caret.appendChild(stem);
    const label = document.createElement('span');
    label.className = 'sp-group-name';
    label.textContent = name;
    const sum = document.createElement('span');
    sum.className = 'sp-group-sum';
    sum.id = 'sp-group-sum-' + slug;
    toggle.appendChild(caret);
    toggle.appendChild(label);
    toggle.appendChild(sum);
    // The title keeps its place as the group's first child; only its text moves
    // into the toggle, so the search still reads a heading off the group.
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsGroup(slug);
    });
    title.textContent = '';
    title.appendChild(toggle);
    // Closed unless this group was opened before: the sheet opening short is
    // the point of the change.
    applySettingsGroup(slug, settingsGroupOpen(slug), false);
  }
  syncSettingsGroupSummaries();
}

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
  if (want === 'profiles' && window.ProfileManager) {
    window.ProfileManager.renderProfilesPanel();
  }
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
        el.classList.contains('ttml-list') || el.classList.contains('sp-hint') ||
        el.classList.contains('sp-slider-card') || el.classList.contains('spicy-key-card') ||
        el.classList.contains('font-bar') || el.classList.contains('font-list') ||
        el.classList.contains('profile-select-row') || el.classList.contains('profile-settings-card') ||
        el.classList.contains('source-mapping-list'));
      // The heading is named by the group itself, not by reading the title's
      // text: the title now carries a toggle whose summary the heading must not
      // pick up ("Sync+600ms").
      const name = group.dataset.groupName || (title ? title.textContent.trim() : '');
      if (rows.length) out.push({ title: name, group, rows });
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
    refreshSpicyApiKey();
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
  // Render Studio, then the mini player — a lyrics-only window has no other way
  // out but its own bar.
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

// ...and it re-wraps the lyrics themselves, so a narrower column may now need a line fitted
// that did not before (or may let one back to its full size). The text re-wraps by itself
// while the window is being dragged, so this only has to settle afterwards: a trailing
// debounce, not a pass per frame.
let lyricFitTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(lyricFitTimer);
  lyricFitTimer = setTimeout(() => {
    lyricFitTimer = 0;
    fitLyricLines();
  }, 140);
});

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
  // A bigger lyric size can push a word past the column; a smaller one can let a fitted
  // line back to its full size.
  fitLyricLines();
}

// Initialize persisted preferences.
const osPrefersReducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
let motionPref = 'full';
try {
  const savedFont = Settings.get('font', null);
  if (savedFont) lyricFontName = savedFont;
  const savedUiFont = Settings.get('uiFont', null);
  if (savedUiFont) uiFontName = savedUiFont;
  showSecondary = Settings.get('secondary', '1') !== '0';
  motionPref = Settings.get('motion', osPrefersReducedMotion ? 'reduced' : 'full');
  const savedLayout = Settings.get('layout', 'compact');
  layoutMode = LAYOUTS.includes(savedLayout) ? savedLayout : 'compact';
  const savedAlign = Settings.get('align', 'left');
  if (LYRIC_ALIGNS.includes(savedAlign)) lyricAlign = savedAlign;
  const savedMotionStyle = Settings.get('motionStyle', 'auto');
  if (MOTION_STYLES.includes(savedMotionStyle)) motionStyle = savedMotionStyle;
  const savedBeatLevel = Settings.get('beatLevel', null);
  beatLevel = parseLevelSetting(savedBeatLevel !== null ? savedBeatLevel : Settings.get('beatMode', 'on'));
  beatMode = getLegacyMode(beatLevel);

  const savedChromaLevel = Settings.get('chromaLevel', null);
  chromaLevel = parseLevelSetting(savedChromaLevel !== null ? savedChromaLevel : 2);

  const savedMomentsLevel = Settings.get('momentLevel', null);
  momentLevel = parseLevelSetting(savedMomentsLevel !== null ? savedMomentsLevel : Settings.get('momentsMode', 'on'));
  momentsMode = getLegacyMode(momentLevel);

  const savedAmbientLevel = Settings.get('ambientLevel', null);
  ambientLevel = parseLevelSetting(savedAmbientLevel !== null ? savedAmbientLevel : Settings.get('ambientMode', 'on'));
  ambientMode = getLegacyMode(ambientLevel);

  const savedTiltLevel = Settings.get('tiltLevel', null);
  tiltLevel = parseLevelSetting(savedTiltLevel !== null ? savedTiltLevel : Settings.get('tiltMode', 'on'));
  tiltMode = getLegacyMode(tiltLevel);
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
// The font folder is read before the saved faces are applied: an imported face can
// only be registered once the library has told us its file exists. The legacy
// handover runs between the two, so a font carried over can be applied in the same
// pass.
refreshFonts().then(() => adoptLegacyFonts()).then(() => { applyFont(lyricFontName); applyUiFont(uiFontName); });
if (savedLineSync) lineSyncMode = LINESYNC_MODES.includes(savedLineSync) ? savedLineSync : 'auto';
applyZoom(lyricFontSize);
// A custom face is registered after its bytes arrive, and its metrics are what the fit is
// measured in: refit once the browser has the real font rather than the fallback's.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => fitLyricLines()).catch(() => {});
}
applyFont(lyricFontName);
applyUiFont(uiFontName);
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
initSettingsGroups();
initSettingsSearch();
initSpicyKeySettings();
if (window.ProfileManager) ProfileManager.init();
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
  let totalR = 0, totalG = 0, totalB = 0, totalCount = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    totalR += r; totalG += g; totalB += b; totalCount++;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const chroma = max - min;
    if (chroma < 20) continue;                  // grey: allow gentle hues
    if (max < 24) continue;                     // black: nothing to light with
    if (min > 235) continue;                    // blown out: white, not colour
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
  if (best >= 0) {
    const s = sum[best];
    return clampAccentToLight({
      r: Math.round(s[0] / s[3]),
      g: Math.round(s[1] / s[3]),
      b: Math.round(s[2] / s[3]),
    });
  }
  // Low-chroma / pale artwork fallback (e.g. Radiohead OK Computer)
  if (totalCount > 0) {
    return clampAccentToLight({
      r: Math.round(totalR / totalCount),
      g: Math.round(totalG / totalCount),
      b: Math.round(totalB / totalCount),
    });
  }
  return null;
}

// The winner has to read as a LIGHT on a near-black UI: a dark, muddy album
// colour would paint a smudge instead of a glow. Clamping saturation and
// lightness in HSL is the smallest way to say that without a colour-space
// dependency — hue, which is the part that carries the artwork, is untouched.
function clampAccentToLight(rgb) {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  // If the artwork is mostly black or very dark (e.g. Kanye West Donda),
  // do not force it into a 60% lightness bright white halo!
  if (l < 0.12) {
    document.documentElement.style.setProperty('--art-glow', '0.06');
    return { r: 24, g: 28, b: 36 };
  }
  const d = max - min;
  let h = 0, s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const S = Math.min(0.72, Math.max(0.38, s));
  const L = Math.min(0.70, Math.max(0.44, l));
  document.documentElement.style.setProperty('--art-glow', '0.35');
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

// The air takes TWO tints, one per vertical half of the cover, so motes share
// the hue of the artwork region they float in front of rather than one accent
// everywhere (reported: "they're only orange"). Same buckets as extractAccent,
// but the winner is read per half and NOT clamped to the light band: the mote
// dial in CSS does its own lightness work against the gradient behind it.
function extractPalette(pixels) {
  if (!pixels || !pixels.length) return null;
  const HUE_BUCKETS = 12;
  const rows = ACCENT_GRID;
  const picks = [];
  for (let half = 0; half < 2; half++) {
    const weight = new Array(HUE_BUCKETS).fill(0);
    const sum = Array.from({ length: HUE_BUCKETS }, () => [0, 0, 0, 0]);
    let halfR = 0, halfG = 0, halfB = 0, halfCount = 0;
    for (let y = half * rows / 2; y < (half + 1) * rows / 2; y++) {
      for (let x = 0; x < rows; x++) {
        const i = (y * rows + x) * 4;
        if (i + 3 >= pixels.length) continue;
        if (pixels[i + 3] < 128) continue;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        halfR += r; halfG += g; halfB += b; halfCount++;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const chroma = max - min;
        if (chroma < 20 || max < 24 || min > 235) continue;
        let hue;
        if (max === r) hue = ((g - b) / chroma + 6) % 6;
        else if (max === g) hue = (b - r) / chroma + 2;
        else hue = (r - g) / chroma + 4;
        const bucket = Math.floor((hue * 60) / (360 / HUE_BUCKETS)) % HUE_BUCKETS;
        weight[bucket] += chroma;
        const s = sum[bucket];
        s[0] += r; s[1] += g; s[2] += b; s[3] += 1;
      }
    }
    let best = -1;
    for (let i = 0; i < HUE_BUCKETS; i++) {
      if (weight[i] > 0 && (best < 0 || weight[i] > weight[best])) best = i;
    }
    if (best >= 0) {
      const s = sum[best];
      picks.push({
        r: Math.round(s[0] / s[3]),
        g: Math.round(s[1] / s[3]),
        b: Math.round(s[2] / s[3]),
      });
    } else if (halfCount > 0) {
      picks.push({
        r: Math.round(halfR / halfCount),
        g: Math.round(halfG / halfCount),
        b: Math.round(halfB / halfCount),
      });
    } else {
      picks.push(null);
    }
  }
  return picks;
}
window.extractPalette = extractPalette;

// The mote tints must read AGAINST the blurred artwork behind them (reported:
// "lighter or a bit darker than the gradient colour of the area"). A darker
// region wants a lighter mote and a bright region a darker one, so each tint is
// pushed away from its region's own luminance by the same amount every time —
// decided HERE, once per track, rather than per mote in CSS.
function offsetTintAgainstRegion(rgb, regionLuma) {
  const f = (v) => v / 255;
  const l = 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
  // Toward white when the region is dark, toward black when it is bright; the
  // 0.16 step is a hint of contrast, not a new colour.
  const step = regionLuma < 0.45 ? 0.16 : -0.12;
  const mix = (v) => Math.round(255 * Math.min(1, Math.max(0, f(v) + step)));
  return `rgb(${mix(rgb.r)} ${mix(rgb.g)} ${mix(rgb.b)})`;
}
window.offsetTintAgainstRegion = offsetTintAgainstRegion;

// Average luminance of one vertical half of the artwork grid, 0..1, for the
// region contrast above.
function halfRegionLuma(pixels, half) {
  let total = 0, count = 0;
  for (let y = half * ACCENT_GRID / 2; y < (half + 1) * ACCENT_GRID / 2; y++) {
    for (let x = 0; x < ACCENT_GRID; x++) {
      const i = (y * ACCENT_GRID + x) * 4;
      if (i + 3 >= pixels.length) continue;
      total += (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]) / 255;
      count += 1;
    }
  }
  return count ? total / count : 0;
}
window.halfRegionLuma = halfRegionLuma;

// Downscale the thumbnail, read it back, publish. Every failure path is a no-op
// that leaves the accent where it was: a cover the canvas refuses is a reason to
// keep the current light, never a reason to throw inside a track change.
function applyCoverAccent(url) {
  if (typeof url !== 'string' || !url) return;
  if (!accentCanvas) {
    accentCanvas = document.createElement('canvas');
    accentCanvas.width = ACCENT_GRID;
    accentCanvas.height = ACCENT_GRID;
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    let rgb = null;
    let tints = null;
    try {
      const ctx = accentCanvas.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, ACCENT_GRID, ACCENT_GRID);
      ctx.drawImage(image, 0, 0, ACCENT_GRID, ACCENT_GRID);
      const pixels = ctx.getImageData(0, 0, ACCENT_GRID, ACCENT_GRID).data;
      rgb = extractAccent(pixels);
      // The air's two region tints ride the same read: one canvas scan per
      // track change, no second image decode.
      const palette = extractPalette(pixels);
      if (palette && palette.some(Boolean)) {
        tints = palette.map((pick, half) => (
          pick ? offsetTintAgainstRegion(pick, halfRegionLuma(pixels, half)) : null));
      }
    } catch (e) { rgb = null; }
    if (!rgb) return;
    document.documentElement.style.setProperty('--art-accent', `rgb(${rgb.r} ${rgb.g} ${rgb.b})`);
    const root = document.documentElement;
    if (tints && tints[0]) root.style.setProperty('--mote-a', tints[0]); else root.style.removeProperty('--mote-a');
    if (tints && tints[1]) root.style.setProperty('--mote-b', tints[1]); else root.style.removeProperty('--mote-b');
    applyMoteTints();
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
    // The air's palette goes too — its tints describe a cover that isn't there.
    const root = document.documentElement;
    root.style.removeProperty('--art-accent');
    root.style.removeProperty('--mote-a');
    root.style.removeProperty('--mote-b');
    applyMoteTints();
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
  // copy the accent is read from.
  if (!isHiRes) {
    updateHeaderArt(url);
    applyCoverAccent(url);
  } else {
    applyCoverAccent(url);
  }

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

// ---------- Revamped Quick Controls & Source Sidebar ----------
function initLatencyRail() {
  const rail = document.getElementById('latency-rail');
  if (!rail) return;
  const card = rail.querySelector('.latency-rail-inner');
  const REVEAL_PAD_X = 32, REVEAL_PAD_Y = 32;

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
  window.sidebarPinned = false;

  const reveal = () => {
    clearTimeout(hideTimer);
    document.body.classList.add('latency-rail-hot');
    if (window.ProfileManager && typeof window.ProfileManager.renderSidebar === 'function') {
      window.ProfileManager.renderSidebar();
    }
  };
  const conceal = () => {
    if (window.sidebarPinned) return;
    clearTimeout(hideTimer);
    // Smooth, snappy physics-based exit delay (110ms) quicker than before
    hideTimer = setTimeout(() => document.body.classList.remove('latency-rail-hot'), 110);
  };
  const pointerInZone = (e) => {
    const z = triggerZone();
    return (!!z && e.clientX >= z.left && e.clientY >= z.top && e.clientY <= z.bottom) || e.clientX >= window.innerWidth - 18;
  };

  window.addEventListener('mousemove', (e) => {
    if (pointerInZone(e) || rail.matches(':hover')) reveal();
    else conceal();
  }, { passive: true });
  rail.addEventListener('mouseenter', reveal);
  rail.addEventListener('mouseleave', conceal);

  window.revealSidebar = reveal;
  window.concealSidebar = () => {
    window.sidebarPinned = false;
    rail.classList.remove('pinned');
    const btn = document.getElementById('sidebar-btn-pin');
    if (btn) btn.classList.remove('active');
    document.body.classList.remove('latency-rail-hot');
  };
  window.toggleSidebarPin = () => {
    window.sidebarPinned = !window.sidebarPinned;
    rail.classList.toggle('pinned', window.sidebarPinned);
    const btn = document.getElementById('sidebar-btn-pin');
    if (btn) btn.classList.toggle('active', window.sidebarPinned);
    if (window.sidebarPinned) {
      reveal();
      if (window.showProfileToast) window.showProfileToast('Sidebar pinned open');
    } else {
      if (window.showProfileToast) window.showProfileToast('Sidebar unpinned');
    }
  };

  const minus = document.getElementById('latency-rail-minus');
  const plus = document.getElementById('latency-rail-plus');
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

  // ---- Horizontal sync slider (−3000..+3000 ms, zero at the middle) ----
  const slider = document.getElementById('latency-slider');
  if (!slider) return;
  const LAT_MIN = -3000, LAT_MAX = 3000;

  window.renderLatencySlider = function() {
    const w = slider.clientWidth;
    if (!w) return;
    const frac = Math.max(0, Math.min(1, (latencyOffsetMs - LAT_MIN) / (LAT_MAX - LAT_MIN))); // 0..1, left→right
    const thumbX = frac * w;
    const zeroX = w / 2;
    const left = Math.min(thumbX, zeroX);
    const width = Math.max(2, Math.abs(zeroX - thumbX));
    const fill = document.getElementById('latency-slider-fill');
    const thumb = document.getElementById('latency-slider-thumb');
    if (fill) { fill.style.left = left + 'px'; fill.style.width = width + 'px'; }
    if (thumb) thumb.style.left = thumbX + 'px';
    slider.classList.toggle('zero', Math.abs(latencyOffsetMs) < 25);
  };

  const setFromEvent = (e) => {
    const rect = slider.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
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

function togglePlayback() {
  if (window.pywebview && window.pywebview.api) {
    window.pywebview.api.toggle_playback();
  }
}
const toggleSimpMusicPlay = togglePlayback;

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
  // The total is `setTrackDuration`'s to write, and only its: a tick that painted
  // the length here would let a render that never consulted the host put a number
  // on screen — and the two writers could disagree about the format.
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
  if (window.ProfileManager && state) {
    window.ProfileManager.onSourceDetected(state.source, state);
  }
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
    renderMs = back.ms;
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
  // The user's own seek is 1:1 with the pointer: the wipe may land on it, and it
  // resets the forward-only paint.
  renderMs = targetMs;
  targetDriftMs = 0;
  anchorPosMs = targetMs;
  anchorWallMs = performance.now();
  // The user's own seek is 1:1 with the pointer and lands outright, so no glide
  // of ours may still be travelling when it does.
  glideUntilMs = 0;
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

  let springSettled = false;
  try {
    if (isPlaying) {
      // Decay any pending drift correction, then read the position off the wall clock.
      const gliding = syncGlideInFlight();
      let landingGlide = false;
      if (glideUntilMs > 0 && !gliding) {
        // A gliding seek's travel window has closed: land whatever is left, so the
        // wipe ends exactly where the bridge said it is rather than trailing it by
        // the tail of an exponential that never quite reaches zero.
        anchorPosMs += targetDriftMs;
        targetDriftMs = 0;
        glideUntilMs = 0;
        // This frame is the tail of that same travel, so it may paint backwards
        // exactly as the frames inside the window did.
        landingGlide = true;
      }
      if (Math.abs(targetDriftMs) > 1) {
        // Time-based exponential decay (tau ≈ 250 ms), so the ease completes in
        // about a second whatever the display's refresh rate. The old per-frame
        // 12% decay finished in 2–6 frames — a yank, not an ease — and its depth
        // silently depended on 60 vs 144 Hz. A glide uses a shorter tau: its whole
        // travel is meant to be over inside SYNC_GLIDE_MS, and anything still
        // outstanding when that window closes is landed outright above.
        const tau = gliding ? SYNC_GLIDE_TAU_MS : 250;
        targetDriftMs -= targetDriftMs * Math.min(1, delta / tau);
      } else {
        targetDriftMs = 0;
      }

      playheadMs = predictedPlayhead();
      // The wipe only ever moves forward while playing: a soft correction that
      // lands behind the fade, or a stale player number that slips through, must
      // not re-sweep letters already sung. A snap, a seek and a track load each
      // reset it outright (see syncPlayhead / applySeek / loadLyrics).
      //
      // A glide is the one exception, and it has to be: it is a move the user made
      // in the player, which the bridge measured and bounded, and its whole travel
      // is meant to be seen. Held forward-only, a seek BACKWARDS left the wipe
      // pinned where it was and the lyrics never followed the player at all — the
      // "I moved the progress bar and the lyrics did not update" report. So while
      // a glide is in flight the wipe rides the eased position in either
      // direction, and the frame that lands it paints the landed position.
      if (gliding || landingGlide) renderMs = playheadMs;
      else if (playheadMs > renderMs) renderMs = playheadMs;
      updateTimer(playheadMs);
      if (lyrics.length > 0) {
        renderProgress(renderMs + latencyOffsetMs);
      }
      if (window.audioDspClock) {
        window.audioDspClock.recordJitter(renderMs, delta);
        window.audioDspClock.process(renderMs, delta);
      }
    }

    springSettled = updateSpringScroll(delta);
    const beatSpringSettled = updateBeatSprings(delta);
    if (window.airPipeline) window.airPipeline.updateAndRender(delta, now);
    springSettled = springSettled && beatSpringSettled;
  } catch (err) {
    // One thrown frame used to kill the whole animation loop: the rAF chain was
    // never re-scheduled and renderLoopActive stayed true, so every later
    // wakeRenderLoop() became a no-op and the overlay only ever came back on a
    // direct repaint (pausing, clicking a lyric, a seek) — which is exactly the
    // "it fixes when I pause or click" report. A bad frame must never cost the
    // user their lyrics: say so once, keep the loop alive.
    reportRenderLoopError(err);
  }

  // Idle parking: when playback is stopped AND the spring has settled, nothing
  // below this point can change until an event (play, seek, media sync) wakes
  // the loop again — so stop scheduling frames instead of burning 60-144 Hz on
  // a static overlay. `lastTick = now` above means the wake-up frame sees a
  // sane delta. Any state-changing path calls wakeRenderLoop(). A frame that
  // threw leaves `springSettled` false, so the loop keeps running and heals.
  if (!isPlaying && springSettled) {
    renderLoopActive = false;
    return;
  }
  requestAnimationFrame(tick);
}

// Reports the first failing frame (and only the first of each kind), so a broken
// frame is visible without spamming the log 60 times a second.
let renderLoopErrorLogged = '';
function reportRenderLoopError(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  if (msg === renderLoopErrorLogged) return;
  renderLoopErrorLogged = msg;
  console.error('[paprika] render frame failed; the loop was kept alive:', err);
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
  renderMs = 0;
  targetDriftMs = 0;
  anchorPosMs = 0;
  anchorWallMs = performance.now();
  // Start of the window auto-latency measures: this is the track change, so the
  // interval to loadLyrics is the time the audio plays before the lyrics (and
  // the song's clock) exist on screen.
  lyricLoadStartedAt = performance.now();
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

// Scripts that write no spaces between words: one character is one syllable, and a token in
// one of them can be split there. Latin and every other spaced script is left alone.
const SPACELESS_SCRIPT = /[\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

function splitWordSyllables(token) {
  const clean = token.replace(/[^a-zA-Z]/g, '');
  if (clean.length <= 3) {
    // A space-less token has to be given its syllable boundaries, or it is one unbreakable
    // run: too long for the column and it can only be scaled down (unreadably so) instead
    // of wrapping onto the next row at its own characters, which is how it is read anyway.
    return SPACELESS_SCRIPT.test(token) ? Array.from(token) : [token];
  }

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
  const MIN_MOMENT_SEP_MS = 22000;
  let lastMomentEnd = -99999;

  for (const phase of phases) {
    if (phase[2] !== 'drop') continue;
    const strength = Math.max(0, Math.min(1, phase[3] || 0));
    // Only genuine musical drops with high conviction
    if (strength < 0.55) continue;
    const startMs = phase[0];
    if (startMs - lastMomentEnd < MIN_MOMENT_SEP_MS) continue;
    const holdMs = Math.min(MOMENT_MAX_HOLD_MS, Math.max(2500, phase[1] - startMs));
    out.push({ ms: startMs, endMs: startMs + holdMs, kind: 'drop', strength });
    lastMomentEnd = startMs + holdMs;
  }

  const hookLines = lines || [];
  for (const index of momentHooks(hookLines)) {
    const line = hookLines[index];
    const startMs = line.startTimeMs || 0;
    if (out.some((m) => Math.abs(startMs - m.ms) < MIN_MOMENT_SEP_MS || (startMs >= m.ms && startMs <= m.endMs))) continue;
    const hookStrength = momentStrengthAt(plan, startMs);
    if (hookStrength < 0.60) continue;
    const holdMs = plan
      ? Math.min(MOMENT_MAX_HOLD_MS, Math.max(2000, 2 * plan.periodMs))
      : MOMENT_HOOK_HOLD_MS;
    out.push({ ms: startMs, endMs: startMs + holdMs, kind: 'hook', strength: hookStrength });
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
  if (beatLevel === 0 || reducedMotion || !beatPlan) { sectionDrive = 1; return; }
  const run = beatRunAt(ms);
  const scale = BEAT_LEVEL_SCALES[beatLevel] || 0.75;
  sectionDrive = run ? 0.9 + Math.max(0, Math.min(1, run[2])) * 0.25 * scale : 1;
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

  // A gliding seek sweeps the playhead across lyrics nobody is hearing, so a
  // break the sweep passes through is not a break anyone is waiting out: keep
  // the countdown out of it (and take down one that is already showing).
  if (syncGlideInFlight()) {
    if (gapChip) closeGapChip();
    return;
  }

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

// =========================================================
// Fitting a line to the column
//
// The lyric column CLIPS sideways (`#lyrics-container` is `overflow-x: clip`), so a run the
// column cannot hold simply loses its tail with no way to reach it — "a word or two goes
// beyond the screen". Wrapping already covers every run with a space in it. What is left
// cannot be broken by any CSS: the syllables are `inline-block`s inside an `inline-flex`
// word, so a long word and a line-synced line in a script that writes no spaces at all
// (Japanese, Chinese) are each ONE run.
//
// Two remedies, one per thing that overflows:
//
//   * a WORD wider than the whole column wraps between its syllables at full size, as a
//     block of its own (`.is-wrapped`, see .word-group in style.css), and
//   * a single SYLLABLE wider than the row it is on — which no break can help — is scaled,
//     through `--line-fit`, a ratio multiplied into the shared lyric size for that line
//     only (see .line in style.css), so the translation and backing-vocal layers follow it
//     and a zoom, a fullscreen multiplier or a font change keeps composing on top.
//
// Both are decided from canvas metrics: the DOM lays an inline-block syllable out by its own
// advance width, which is what `measureText` returns for it, so no line has to be laid out
// to be fitted — the half of a 400-line song that `content-visibility: auto` is deliberately
// skipping stays skipped. The translation layer is not measured: it is real text with
// `overflow-wrap: anywhere`, so it breaks rather than overflowing whatever the script.
const LYRIC_FIT_HEADROOM = 0.93;   // slack for the active line's 1.025 scale and a sung syllable's pop
const LYRIC_FIT_MIN = 0.05;        // a floor only so a pathological line cannot reach 0
let lyricFitCanvas = null;         // one canvas, reused: allocating one per pass is the whole cost

// The width of each word (the sum of its syllables) and of the widest single syllable, in px
// at the size the line would have unfitted.
function lyricFitMetrics(ctx, lDom, sizePx, italic, spacingEm) {
  // `letterSpacing` on a canvas context is Chromium 99+; where it is missing the spacing
  // is added by hand, so the estimate is never the smaller of the two.
  const spaced = 'letterSpacing' in ctx;
  ctx.font = `${italic ? 'italic ' : ''}${ctx.lyricWeight} ${sizePx}px ${ctx.lyricFamily}`;
  if (spaced) ctx.letterSpacing = (spacingEm * sizePx) + 'px';

  const words = [];
  let widest = 0;
  for (const word of (lDom && lDom.words) || []) {
    let total = 0;
    for (const syl of word.syllables) {
      const text = syl.text || '';
      if (!text) continue;
      const width = ctx.measureText(text).width
        + (spaced ? 0 : spacingEm * sizePx * Array.from(text).length);
      total += width;
      if (width > widest) widest = width;
    }
    words.push(total);
  }
  return { words, widest };
}

// Fits every line to the column it is in. Idempotent and cheap: no line is laid out, and a
// line that already fits is never written to (a song must not change size line by line).
function fitLyricLines() {
  const container = document.getElementById('lyrics-container');
  if (!container || !lyricDom || !lyricDom.length) return;
  const sample = lyricDom.find((l) => l && l.element && l.element.parentElement === container);
  if (!sample) return;

  // The column and the type it is measured in: one style read and one width read for the
  // whole pass, not one per line.
  const info = getComputedStyle(sample.element);
  const baseSize = parseFloat(info.fontSize) / (sample.fit || 1);
  const column = sample.element.clientWidth;
  if (!baseSize || !isFinite(baseSize) || !column) return;   // folded away: nothing to fit to

  const ctx = lyricFitCanvas || (lyricFitCanvas = document.createElement('canvas').getContext('2d'));
  ctx.lyricFamily = info.fontFamily;
  ctx.lyricWeight = info.fontWeight;
  const spacingEm = 0.01;   // .line's letter-spacing, in em
  ctx.font = `${info.fontWeight} ${baseSize}px ${info.fontFamily}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = (spacingEm * baseSize) + 'px';
  const spacePx = ctx.measureText(' ').width || baseSize * 0.25;
  // The widths depend on the type, never on the column, so they are cached per line and
  // reused for every resize: dragging a window edge would otherwise re-measure a whole
  // song on each frame (24ms for 400 lines, measured), to answer a question whose answer
  // only changes when the COLUMN changed.
  const typeKey = `${baseSize}|${info.fontFamily}|${info.fontWeight}`;
  for (const lDom of lyricDom) {
    if (!lDom || !lDom.element) continue;
    const sizePx = baseSize * (lDom.isBackground ? 0.72 : 1);
    const lineKey = typeKey + (lDom.isBackground ? '|italic' : '');
    if (lDom.fitKey !== lineKey) {
      lDom.fitMetrics = lyricFitMetrics(ctx, lDom, sizePx, lDom.isBackground, spacingEm);
      lDom.fitKey = lineKey;
    }
    const metrics = lDom.fitMetrics;
    // A word wider than the whole column gets its own block and wraps between syllables.
    // Toggled rather than rebuilt, and only when the answer changes, so a resize that
    // changes nothing writes nothing: `word.element` holds the syllables the wipe and the
    // motion work on, and moving them would rebuild what this is protecting.
    const words = lDom.words || [];
    for (let w = 0; w < words.length; w++) {
      const want = metrics.words[w] > column;
      if (want !== !!words[w].wrapped) {
        words[w].wrapped = want;
        words[w].element.classList.toggle('is-wrapped', want);
      }
    }
    // A syllable can also be pushed past the column by the space in front of it: the space
    // box is preserved, it hangs at the end of the row it lands on, and the word after it
    // is then laid out from there — so a word that only fits when it STARTS the row does
    // not fit at all (measured at 330x380: a 269px word in a 270px column, laid out 9px
    // over the edge). One space of slack is what that costs, and a line whose widest
    // syllable is within a space of the column is fitted for it.
    const usable = Math.max(1, column - spacePx);
    const widest = metrics.widest;
    const fit = widest > usable ? (usable * LYRIC_FIT_HEADROOM) / widest : 1;
    const current = lDom.fit || 1;
    if (fit < 1) {
      // Only write when the ratio moves: a resize that changed nothing else must not
      // rewrite hundreds of inline styles.
      const wanted = Math.max(LYRIC_FIT_MIN, fit);
      if (Math.abs(current - wanted) > 0.001) {
        lDom.element.style.setProperty('--line-fit', wanted.toFixed(4));
        lDom.fit = wanted;
      }
    } else if (current !== 1) {
      lDom.element.style.removeProperty('--line-fit');
      lDom.fit = 1;
    }
  }
}

window.loadLyrics = function(data, title, artist, sourceName, initialElapsedMs, trackKey, savedLatencyOffset, plan, offsetIsDefault) {
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
    currentTrackOffsetIsDefault = !!offsetIsDefault;
    latencyOffsetMs = (typeof savedLatencyOffset === 'number' && !isNaN(savedLatencyOffset)) ? savedLatencyOffset : DEFAULT_LATENCY_MS;
    // Latency precedence:
    // 1. Saved per-track nudge: always wins if track was nudged explicitly
    // 2. Active profile baseline latency: applies if no per-track nudge exists
    // 3. True 0ms if default latency is off and profile is 0ms
    if (!offsetIsDefault) {
      // Saved per-track nudge: always wins, switch or no switch.
    } else {
      const profLatency = (window.ProfileManager && typeof window.ProfileManager.getActiveProfileLatency === 'function')
        ? window.ProfileManager.getActiveProfileLatency()
        : null;
      if (typeof profLatency === 'number') {
        latencyOffsetMs = profLatency;
      } else if (!useDefaultLatency) {
        latencyOffsetMs = 0;
      }
    }
    // Auto latency runs last, so it can only ever replace the host's DEFAULT for
    // this track — never an offset the user chose, and never with a live
    // timeline to correct against. See takeAutoLatency.
    lastAutoLatencyMs = 0;
    lastAutoTrackKey = "";
    const autoOffset = takeAutoLatency(offsetIsDefault);
    if (typeof autoOffset === 'number') {
      latencyOffsetMs = autoOffset;
      lastAutoLatencyMs = autoOffset;
      // Remember which track opened on the auto value: a later manual nudge on
      // this same track is the measured residual for this player, and teaches
      // the trim (see window.adjustLatency). Any other track's nudge is just a
      // preference and must not move it.
      lastAutoTrackKey = currentTrackKey || "";
    }
    if (window.renderLatencySlider) window.renderLatencySlider();
    syncSettingsPanel();

    playheadMs = typeof initialElapsedMs === 'number' ? initialElapsedMs : 0;
    // A new track is a landing: the wipe may start anywhere.
    renderMs = playheadMs;
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
        renderMs = targetSeekMs;
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
    // A new track must paint at its own elapsed and scroll to its own line even
    // while paused: the render loop exits when playback stops, and without this
    // the fresh lyrics sit at the inherited playhead of the PREVIOUS song — off
    // screen, unsynced — until the user clicks a line (which forces a hydrated
    // render at the click position). Seeding the active window before painting
    // keeps the paused render one-shot: this paints once, then sleeps again.
    updateLineDepthOfField([0]);
    renderProgress(playheadMs + latencyOffsetMs);
    if (activeLineIdx >= 0 && lyricDom[activeLineIdx]) {
      scrollToActiveCluster([activeLineIdx]);
      updateLineDepthOfField();
    } else {
      scrollToActiveCluster([0]);
    }
    // Every line is fitted to the column before the first paint: a line whose widest
    // word does not fit would otherwise be clipped for the user who is looking at it.
    fitLyricLines();
    fadeInView();
    // A fresh payload may change what the track's timing actually is;
    // re-resolve the line lighting under the (persisted) preference now
    // that the lines exist and the first paint has landed.
    resolveLineSync();
  } catch (err) {
    console.error("Error in loadLyrics:", err);
  }
};

window.setPlaybackState = function(playing) {
  const wasPlaying = isPlaying;
  wakeRenderLoop();   // paused->playing resumes the loop; the reverse closes the chip
  const now = performance.now();

  if (playing && !isPlaying) {
    // Resuming: re-anchor from wherever the highlight currently sits.
    anchorPosMs = playheadMs;
    anchorWallMs = now;
    targetDriftMs = 0;
  } else if (!playing && isPlaying) {
    // Pausing: freeze at the wall-clock position before we stop advancing, and
    // collapse any correction that was still easing in — a paused overlay has no
    // sweep left to hide it in, so a pending drift would sit there visibly wrong.
    // Freeze at whichever of the two is further along, so the painted position
    // never steps backwards because a capped correction was still pending.
    playheadMs = Math.max(predictedPlayhead(), renderMs);
    targetDriftMs = 0;
    anchorPosMs = playheadMs;
    anchorWallMs = now;
  }

  if (playing !== isPlaying) {
    // A play/pause edge is a landing the bridge also snaps: the wipe may move on it.
    renderMs = playheadMs;
  }

  isPlaying = playing;
  // The bridge pushes this AFTER loadLyrics on a track change, so a song that
  // starts playing arrives while the loop still believes the previous track's
  // paused state. A freshly resumed transport must paint at the seeded
  // playhead now — not sit frozen until the next heartbeat or click — and a
  // freshly paused one must not keep advancing on the old anchor.
  if (isPlaying && !wasPlaying && lyrics.length > 0) {
    renderProgress(playheadMs + latencyOffsetMs);
  }
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

// Wall-clock instant of the last user-initiated seek, and how long position
// reports are distrusted afterwards. Only the UI's OWN optimistic move needs
// this: the bridge suppresses the player's post-seek echo itself (it knows when
// it sent the seek and when the player agreed), but a report it read in the
// meantime can still arrive here, and obeying it would snap the lyrics back to
// where the seek came from.
const SEEK_GUARD_MS = 900;
let lastUserSeekAt = -Infinity;

// A position report this close to where the lyrics already are is sub-frame
// noise: taking it would micro-slew the wipe for nothing. Past SYNC_SNAP_MS the
// correction is a move rather than drift, and the lyrics land on it instead of
// gliding through the song to reach it.
const SYNC_IGNORE_MS = 50;
const SYNC_SNAP_MS = 1200;

// How long a 'glide' takes, and the decay it uses to get there. The bridge sends
// 'glide' for a move it measured as a seek inside the song: the audio is already
// at the new position, so this is the wipe catching up, and the whole of it is
// meant to be over in about a third of a second. A shorter tau than the soft
// path's is what makes that true — the ease is ~97% done by then rather than
// 63% — and whatever is left when the window closes is landed outright in tick().
const SYNC_GLIDE_MS = 320;
const SYNC_GLIDE_TAU_MS = 90;

// Position report from the bridge. `mode` says how to take it, because only the
// bridge sees the sequence of the player's samples:
//
//   * 'snap' — playback moved somewhere the lyrics must land on now: a track
//     change, a player skip, a play/pause edge, the first reading of a track, or
//     a move too large for the eye to follow;
//   * 'glide' — a real move inside the song (a seek the user made in the player)
//     that the wipe should travel to, so it reads as catching up with the audio
//     rather than as a hard cut;
//   * 'soft' — ordinary drift it measured, absorbed as a decaying correction;
//   * 'hold' — the clock had no FRESH sample and is reporting its leashed
//     projection (core.timeline.Reading.held). It is an estimate, not a
//     correction: obeying it dragged the wipe back to a parked number on every
//     poll, which stalled real-time sync on players that publish rarely or
//     blank their timeline (a browser after a site-side seek, SimpMusic) and
//     re-swept the syllables it had already passed. On a hold the UI simply
//     keeps projecting; the next real sample corrects it.
//
// This side used to guess the classification from a threshold, and every guess it
// got wrong reset the lyrics mid-song (a stale snapshot read as a big jump
// backwards repeated the current line until the next click).
window.syncPlayhead = function(ms, mode) {
  if (typeof ms !== 'number' || isNaN(ms)) return;

  const now = performance.now();

  // A held number is an estimate, never a correction: obeying it dragged the wipe
  // back to a parked projection on every poll (the "loops on a few letters"
  // report). The wipe keeps its own 1x projection instead — and a hold is no
  // reason to stop that clock either, which is why there is no park on this side:
  // a held source is a live one, just with no fresh timeline to report yet.
  if (mode === 'hold') return;

  if (now - lastUserSeekAt < SEEK_GUARD_MS) return;   // pre-seek echo: ignore

  const predicted = isPlaying ? predictedPlayhead() : playheadMs;
  const diff = ms - predicted;

  // Progression or seek in player: if diff is significant (> 600ms) or mode is snap,
  // immediately land on the new playhead without stalling or waiting for pause/unpause!
  const isProgression = mode === 'snap' || Math.abs(diff) > 600;

  if (isProgression) {
    glideUntilMs = 0;
    targetDriftMs = 0;
    playheadMs = ms;
    renderMs = ms;        // snap / seek landing updates renderMs immediately!
    anchorPosMs = ms;
    anchorWallMs = now;
    if (window.audioDspClock) window.audioDspClock.reset();
    lastDisplayedSecond = -1;
    lastSideFillSecond = -1;
    lastArtFillSecond = -1;
    updateTimer(ms);
    lastActiveSig = "";
    if (lyrics.length > 0) renderProgress(ms + latencyOffsetMs);
    wakeRenderLoop();
    return;
  }

  const glide = mode === 'glide';
  if (!glide && Math.abs(diff) < SYNC_IGNORE_MS) return;

  wakeRenderLoop();

  if (isPlaying) {
    const cur = predictedPlayhead();
    anchorPosMs = ms;
    anchorWallMs = now;
    targetDriftMs = cur - ms;
    if (glide) glideUntilMs = now + SYNC_GLIDE_MS;
    return;
  }

  glideUntilMs = 0;
  targetDriftMs = 0;
  playheadMs = ms;
  renderMs = ms;
  if (window.audioDspClock) window.audioDspClock.reset();
  lastDisplayedSecond = -1;
  lastSideFillSecond = -1;
  lastArtFillSecond = -1;
  updateTimer(ms);
  lastActiveSig = "";
  if (lyrics.length > 0) renderProgress(ms + latencyOffsetMs);
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
    // Guarded: a stale activeLineIdx (a rebuilt list, a resize) used to throw
    // here and take the whole render loop down with it.
    const activeLineDom = lyricDom[activeLineIdx];
    const activeEl = activeLineDom && activeLineDom.element;
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
  currentTrackOffsetIsDefault = false;

  latencyOffsetMs = Math.max(-3000, Math.min(3000, latencyOffsetMs + deltaMs));
  // A nudge on a track that opened on the auto offset is the residual error of
  // the auto estimate for this player — fold half of it into the per-player
  // trim so the next song on the same player opens closer. Half, not all: a
  // single rough keypress should improve the estimate, not swing it. Nudges on
  // any other track are personal preference and leave the trim alone.
  if (lastAutoTrackKey && currentTrackKey
      && currentTrackKey === lastAutoTrackKey
      && autoLatencyEligible()) {
    const player = autoLatencyPlayer();
    setAutoTrim(player, getAutoTrim(player) + deltaMs / 2);
  }
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


// =========================================================
// Profile System & Source Realization Architecture
// =========================================================

const SOURCE_ICONS = {
  spotify: '<svg viewBox="0 0 24 24" width="13" height="13" fill="#1db954"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>',
  simpmusic: '<svg viewBox="0 0 24 24" width="13" height="13" fill="#ff4081"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
  youtube: '<svg viewBox="0 0 24 24" width="13" height="13" fill="#ff0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
  browser: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  vlc: '<svg viewBox="0 0 24 24" width="13" height="13" fill="#ff8800"><path d="M13.2 2.1a1.4 1.4 0 0 0-2.4 0l-2.1 4.2h6.6zm-2.7 5.4-2.1 4.2h7.2l-2.1-4.2zm-2.7 5.4-2.7 5.4h12.4l-2.7-5.4zm-3.3 6.6-1.5 3c-.3.6.1 1.5.9 1.5h16.2c.8 0 1.2-.9.9-1.5l-1.5-3z"/></svg>',
  apple: '<svg viewBox="0 0 24 24" width="13" height="13" fill="#fc3c44"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.84c.64-.78 1.08-1.87.96-2.96-.93.04-2.07.62-2.73 1.4-.58.67-1.09 1.77-.96 2.84 1.04.08 2.1-.5 2.73-1.28z"/></svg>',
  generic: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
};

const CANONICAL_SOURCES = [
  { id: 'spotify', name: 'Spotify', icon: 'spotify', dot: '#1db954' },
  { id: 'simpmusic', name: 'SimpMusic', icon: 'simpmusic', dot: '#ff4081' },
  { id: 'youtube', name: 'YouTube / Browser', icon: 'youtube', dot: '#ff0000' },
  { id: 'vlc', name: 'VLC Media Player', icon: 'vlc', dot: '#ff8800' },
  { id: 'apple_music', name: 'Apple Music', icon: 'apple', dot: '#fc3c44' },
  { id: 'generic', name: 'Other Players', icon: 'generic', dot: '#00d2ff' }
];

const BUILTIN_PROFILES = {
  default: {
    id: "default",
    name: "Default",
    isBuiltin: true,
    latencyOffsetMs: 0,
    layout: "compact",
    lyricFont: "Inter",
    uiFont: "Inter",
    beatLevel: 2,
    chromaLevel: 2,
    momentLevel: 2,
    ambientLevel: 2,
    tiltLevel: 2,
    sliderBeat: 45,
    sliderChroma: 30,
    sliderArt: 40,
    sliderParticles: 28,
    sliderParticleOpacity: 80,
    sliderParticleSize: 70,
    sliderMoments: 35,
    sliderTilt: 50
  },
  vivid: {
    id: "vivid",
    name: "Vivid",
    isBuiltin: true,
    latencyOffsetMs: 0,
    layout: "compact",
    lyricFont: "Inter",
    uiFont: "Inter",
    beatLevel: 4,
    chromaLevel: 3,
    momentLevel: 3,
    ambientLevel: 3,
    tiltLevel: 3,
    sliderBeat: 85,
    sliderChroma: 60,
    sliderArt: 50,
    sliderParticles: 48,
    sliderParticleOpacity: 90,
    sliderParticleSize: 85,
    sliderMoments: 65,
    sliderTilt: 75
  },
  minimal: {
    id: "minimal",
    name: "Minimal",
    isBuiltin: true,
    latencyOffsetMs: 0,
    layout: "compact",
    lyricFont: "Inter",
    uiFont: "Inter",
    beatLevel: 1,
    chromaLevel: 0,
    momentLevel: 0,
    ambientLevel: 0,
    tiltLevel: 0,
    sliderBeat: 20,
    sliderChroma: 0,
    sliderArt: 30,
    sliderParticles: 0,
    sliderParticleOpacity: 0,
    sliderParticleSize: 50,
    sliderMoments: 0,
    sliderTilt: 0
  },
  youtube: {
    id: "youtube",
    name: "YouTube & Web",
    isBuiltin: true,
    latencyOffsetMs: 180,
    layout: "compact",
    lyricFont: "Inter",
    uiFont: "Inter",
    beatLevel: 2,
    chromaLevel: 2,
    momentLevel: 2,
    ambientLevel: 2,
    tiltLevel: 2,
    sliderBeat: 45,
    sliderChroma: 30,
    sliderArt: 40,
    sliderParticles: 28,
    sliderParticleOpacity: 80,
    sliderParticleSize: 70,
    sliderMoments: 35,
    sliderTilt: 50
  },
  split: {
    id: "split",
    name: "Split Mode",
    isBuiltin: true,
    latencyOffsetMs: 0,
    layout: "split",
    lyricFont: "Inter",
    uiFont: "Inter",
    beatLevel: 2,
    chromaLevel: 2,
    momentLevel: 2,
    ambientLevel: 2,
    tiltLevel: 2,
    sliderBeat: 45,
    sliderChroma: 30,
    sliderArt: 40,
    sliderParticles: 28,
    sliderParticleOpacity: 80,
    sliderParticleSize: 70,
    sliderMoments: 35,
    sliderTilt: 50
  }
};

const DEFAULT_SOURCE_MAP = {
  "spotify": "default",
  "simpmusic": "default",
  "youtube": "youtube",
  "browser": "youtube",
  "vlc": "default",
  "apple_music": "default",
  "generic": "default"
};

const ProfileManager = {
  profiles: {},
  activeProfileId: 'default',
  sourceMap: Object.assign({}, DEFAULT_SOURCE_MAP),
  autoSwitch: true,
  currentSource: null,
  availableSources: [],
  lockedSourceKey: null,
  lastAutoSwitchedSourceId: null,
  _saveTimer: null,

  init() {
    const storedProfiles = Settings.get('profiles_data', null);
    if (!storedProfiles) {
      this.profiles = JSON.parse(JSON.stringify(BUILTIN_PROFILES));
      const def = this.profiles.default;
      def.sliderBeat = parseInt(Settings.get('sliderBeat', '45'), 10);
      def.sliderChroma = parseInt(Settings.get('sliderChroma', '30'), 10);
      def.sliderArt = parseInt(Settings.get('sliderArt', '40'), 10);
      def.sliderParticles = parseInt(Settings.get('sliderParticles', '28'), 10);
      def.sliderParticleOpacity = parseInt(Settings.get('sliderParticleOpacity', '80'), 10);
      def.sliderParticleSize = parseInt(Settings.get('sliderParticleSize', '70'), 10);
      def.sliderMoments = parseInt(Settings.get('sliderMoments', '35'), 10);
      def.sliderTilt = parseInt(Settings.get('sliderTilt', '50'), 10);
      def.beatLevel = parseLevelSetting(Settings.get('beatLevel', 2));
      def.chromaLevel = parseLevelSetting(Settings.get('chromaLevel', 2));
      def.momentLevel = parseLevelSetting(Settings.get('momentLevel', 2));
      def.ambientLevel = parseLevelSetting(Settings.get('ambientLevel', 2));
      def.tiltLevel = parseLevelSetting(Settings.get('tiltLevel', 2));
      def.layout = Settings.get('layout', 'compact');
      this.save();
    } else {
      try {
        this.profiles = JSON.parse(storedProfiles);
        for (const [k, v] of Object.entries(BUILTIN_PROFILES)) {
          if (!this.profiles[k]) {
            this.profiles[k] = JSON.parse(JSON.stringify(v));
          }
        }
      } catch (e) {
        this.profiles = JSON.parse(JSON.stringify(BUILTIN_PROFILES));
      }
    }

    const savedActive = Settings.get('activeProfileId', 'default');
    this.activeProfileId = this.profiles[savedActive] ? savedActive : 'default';

    const storedMap = Settings.get('profile_source_map', null);
    if (storedMap) {
      try {
        this.sourceMap = Object.assign({}, DEFAULT_SOURCE_MAP, JSON.parse(storedMap));
      } catch (e) {
        this.sourceMap = Object.assign({}, DEFAULT_SOURCE_MAP);
      }
    } else {
      this.sourceMap = Object.assign({}, DEFAULT_SOURCE_MAP);
    }

    this.autoSwitch = Settings.get('autoSwitchSources', '1') === '1';

    const syncFromBackend = () => {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.get_profiles) {
        api.get_profiles().then((data) => {
          if (data && typeof data === 'object' && Object.keys(data).length > 0) {
            if (data.profiles) this.profiles = Object.assign({}, this.profiles, data.profiles);
            if (data.sourceMap) this.sourceMap = Object.assign({}, this.sourceMap, data.sourceMap);
            if (data.activeProfileId && this.profiles[data.activeProfileId]) this.activeProfileId = data.activeProfileId;
            if (typeof data.autoSwitch === 'boolean') this.autoSwitch = data.autoSwitch;
            this.renderPills();
            this.renderProfilesPanel();
          }
        }).catch(() => {});
      }
    };

    if (window.pywebview && window.pywebview.api) {
      syncFromBackend();
    } else {
      window.addEventListener('pywebviewready', syncFromBackend);
    }

    this.renderPills();
  },

  getActiveProfile() {
    return this.profiles[this.activeProfileId] || this.profiles.default || BUILTIN_PROFILES.default;
  },

  getActiveProfileLatency() {
    const prof = this.getActiveProfile();
    return typeof prof.latencyOffsetMs === 'number' ? prof.latencyOffsetMs : 0;
  },

  updateActiveProfile(updates) {
    const active = this.getActiveProfile();
    Object.assign(active, updates);
    this.save();
    this.renderPills();
  },

  syncFromCurrentVisuals() {
    this.updateActiveProfile({
      sliderBeat,
      beatLevel,
      sliderChroma,
      chromaLevel,
      sliderArt,
      sliderParticles,
      ambientLevel,
      sliderParticleOpacity,
      sliderParticleSize,
      sliderMoments,
      momentLevel,
      sliderTilt,
      tiltLevel
    });
  },

  applyProfile(id, notify = false, reason = '') {
    if (!this.profiles[id]) id = 'default';
    this.activeProfileId = id;
    const p = this.profiles[id];

    sliderBeat = p.sliderBeat ?? 45;
    beatLevel = p.beatLevel ?? 2;
    sliderChroma = p.sliderChroma ?? 30;
    chromaLevel = p.chromaLevel ?? 2;
    sliderArt = p.sliderArt ?? 40;
    sliderParticles = p.sliderParticles ?? 28;
    ambientLevel = p.ambientLevel ?? 2;
    sliderParticleOpacity = p.sliderParticleOpacity ?? 80;
    sliderParticleSize = p.sliderParticleSize ?? 70;
    sliderMoments = p.sliderMoments ?? 35;
    momentLevel = p.momentLevel ?? 2;
    sliderTilt = p.sliderTilt ?? 50;
    tiltLevel = p.tiltLevel ?? 2;

    Settings.set('sliderBeat', sliderBeat);
    Settings.set('beatLevel', beatLevel);
    Settings.set('sliderChroma', sliderChroma);
    Settings.set('chromaLevel', chromaLevel);
    Settings.set('sliderArt', sliderArt);
    Settings.set('sliderParticles', sliderParticles);
    Settings.set('ambientLevel', ambientLevel);
    Settings.set('sliderParticleOpacity', sliderParticleOpacity);
    Settings.set('sliderParticleSize', sliderParticleSize);
    Settings.set('sliderMoments', sliderMoments);
    Settings.set('momentLevel', momentLevel);
    Settings.set('sliderTilt', sliderTilt);
    Settings.set('tiltLevel', tiltLevel);

    if (p.layout && LAYOUTS.includes(p.layout)) {
      layoutMode = p.layout;
      applyLayoutState();
    }

    if (p.lyricFont && typeof applyFont === 'function') applyFont(p.lyricFont);
    if (p.uiFont && typeof applyUiFont === 'function') applyUiFont(p.uiFont);

    if (currentTrackOffsetIsDefault) {
      latencyOffsetMs = typeof p.latencyOffsetMs === 'number' ? p.latencyOffsetMs : 0;
      updateLatencyUI();
      if (lyrics.length > 0) {
        renderProgress((isPlaying ? predictedPlayhead() : playheadMs) + latencyOffsetMs);
      }
    }

    if (window.syncVisualSliders) window.syncVisualSliders();
    startBeatEngine();
    startMomentEngine();
    applyAmbientMode();
    applyTiltMode();
    document.documentElement.style.setProperty('--art-slider-scale', (sliderArt / 100).toFixed(2));
    document.documentElement.style.setProperty('--tilt-amp', String((sliderTilt / 100) * 1.2));

    this.save();
    this.renderPills();
    this.renderProfilesPanel();
    syncSettingsPanel();
    wakeRenderLoop();

    if (notify) {
      showProfileToast(`Profile: ${p.name}${reason ? ' • ' + reason : ''}`);
    }
  },

  onSourceDetected(source, state) {
    if (state) {
      if (Array.isArray(state.available_sources)) {
        this.availableSources = state.available_sources;
      }
      this.lockedSourceKey = state.locked_source_key || null;
    }
    if (source && typeof source === 'object') {
      this.currentSource = source;
    }
    this.renderPills();

    const popup = document.getElementById('quick-profile-popup');
    if (popup && !popup.hidden) {
      this.renderQuickSourcesList();
    }
    if (document.body.classList.contains('settings-open')) {
      this.renderLockDropdown();
    }

    // Check auto-switching
    if (this.autoSwitch && !this.lockedSourceKey && source && source.id) {
      const targetProfileId = this.sourceMap[source.id] || this.sourceMap[source.group] || this.sourceMap['generic'];
      if (targetProfileId && targetProfileId !== this.activeProfileId && this.profiles[targetProfileId]) {
        if (this.lastAutoSwitchedSourceId !== source.id) {
          this.lastAutoSwitchedSourceId = source.id;
          this.applyProfile(targetProfileId, true, `Auto-switched for ${source.name}`);
        }
      } else {
        this.lastAutoSwitchedSourceId = source.id;
      }
    }
  },

  switchAndLockSource(sourceKey, sourceName) {
    this.lockedSourceKey = sourceKey;
    const api = window.pywebview && window.pywebview.api;
    if (api && api.lock_source) {
      api.lock_source(sourceKey);
    }
    const matched = this.availableSources.find(s => s.key === sourceKey || s.app_id === sourceKey);
    if (matched && matched.source) {
      this.currentSource = matched.source;
      if (this.autoSwitch) {
        const targetProf = this.sourceMap[matched.source.id] || this.sourceMap[matched.source.group] || this.sourceMap['generic'];
        if (targetProf && this.profiles[targetProf] && targetProf !== this.activeProfileId) {
          this.applyProfile(targetProf, false);
        }
      }
    }
    this.renderPills();
    this.renderQuickSourcesList();
    this.renderLockDropdown();
    showProfileToast(`Locked to ${sourceName || 'player'} (keeps playing even if others play)`);
  },

  unlockSource() {
    this.lockedSourceKey = null;
    const api = window.pywebview && window.pywebview.api;
    if (api && api.unlock_source) {
      api.unlock_source();
    }
    this.renderPills();
    this.renderQuickSourcesList();
    this.renderLockDropdown();
    showProfileToast('Auto-following active music player');
  },

  createProfile(name) {
    name = (name || '').trim();
    if (!name) return;
    const newId = 'profile_' + Date.now().toString(36);
    const active = this.getActiveProfile();
    const newProfile = Object.assign({}, active, {
      id: newId,
      name: name,
      isBuiltin: false
    });
    this.profiles[newId] = newProfile;
    this.applyProfile(newId, true, 'Created profile');
    showProfileToast(`Created & activated profile "${name}"`);
    this.renderQuickProfileList();
    this.renderProfilesPanel();
  },

  deleteProfile(id) {
    const p = this.profiles[id];
    if (!p) return;
    if (p.isBuiltin) {
      showProfileToast('Built-in profiles cannot be deleted');
      return;
    }
    delete this.profiles[id];

    for (const src of Object.keys(this.sourceMap)) {
      if (this.sourceMap[src] === id) {
        this.sourceMap[src] = 'default';
      }
    }

    if (this.activeProfileId === id) {
      this.applyProfile('default', true, 'Fallback after deletion');
    } else {
      this.save();
      this.renderQuickProfileList();
      this.renderProfilesPanel();
    }
    showProfileToast(`Deleted profile "${p.name}"`);
  },

  setSourceMapping(sourceId, profileId) {
    this.sourceMap[sourceId] = profileId;
    if (sourceId === 'youtube') {
      this.sourceMap['browser'] = profileId;
    }
    this.save();
    const pName = this.profiles[profileId] ? this.profiles[profileId].name : profileId;
    const sObj = CANONICAL_SOURCES.find(s => s.id === sourceId);
    showProfileToast(`Mapped ${sObj ? sObj.name : sourceId} → ${pName}`);
  },

  save() {
    Settings.set('profiles_data', JSON.stringify(this.profiles));
    Settings.set('activeProfileId', this.activeProfileId);
    Settings.set('profile_source_map', JSON.stringify(this.sourceMap));
    Settings.set('autoSwitchSources', this.autoSwitch ? '1' : '0');

    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.save_profiles) {
        api.save_profiles({
          activeProfileId: this.activeProfileId,
          autoSwitch: this.autoSwitch,
          profiles: this.profiles,
          sourceMap: this.sourceMap
        }).catch(() => {});
      }
    }, 500);
  },

  renderSidebar() {
    const src = this.currentSource || {
      id: 'generic',
      name: 'Media Player',
      icon: 'generic'
    };
    const iconSvg = SOURCE_ICONS[src.icon] || SOURCE_ICONS[src.id] || SOURCE_ICONS.generic;
    const iconEl = document.getElementById('sidebar-source-icon');
    const nameEl = document.getElementById('sidebar-source-name');
    const trackEl = document.getElementById('sidebar-source-track');
    const lockBadge = document.getElementById('sidebar-source-lock-badge');
    const lockBtn = document.getElementById('sidebar-lock-btn');
    const lockIcon = document.getElementById('sidebar-lock-icon');
    const autoFollowBtn = document.getElementById('sidebar-btn-auto-follow');

    if (iconEl) iconEl.innerHTML = iconSvg;
    if (nameEl) nameEl.textContent = src.name || 'Media Player';
    if (trackEl) {
      trackEl.textContent = (currentTrackMeta && currentTrackMeta.title)
        ? `${currentTrackMeta.title}${currentTrackMeta.artist ? ' • ' + currentTrackMeta.artist : ''}`
        : (isPlaying ? 'Playing audio' : 'Waiting for track...');
    }

    const isLocked = !!this.lockedSourceKey;
    if (lockBadge) lockBadge.hidden = !isLocked;
    if (lockBtn) lockBtn.classList.toggle('active', isLocked);
    if (lockIcon) lockIcon.textContent = isLocked ? '🔒' : '🔓';
    if (autoFollowBtn) autoFollowBtn.classList.toggle('active', !isLocked);

    // Multi-source switch chips if multiple players detected
    const multiContainer = document.getElementById('sidebar-multi-sources');
    const multiList = document.getElementById('sidebar-other-sources-list');
    if (multiContainer && multiList) {
      const others = (this.availableSources || []).filter(s => {
        const sId = (s.source && s.source.id) || s.app_id;
        return sId !== src.id && s.key !== src.raw_app_id;
      });
      if (others.length > 0) {
        multiContainer.hidden = false;
        multiList.innerHTML = '';
        others.forEach(o => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'sidebar-source-chip';
          const oInfo = o.source || {};
          const oIcon = SOURCE_ICONS[oInfo.icon] || SOURCE_ICONS[oInfo.id] || SOURCE_ICONS.generic;
          chip.innerHTML = `<span>${oIcon}</span><span>${oInfo.name || o.app_id}</span>`;
          chip.onclick = (e) => {
            e.stopPropagation();
            this.switchAndLockSource(o.key, oInfo.name || o.app_id);
          };
          multiList.appendChild(chip);
        });
      } else {
        multiContainer.hidden = true;
      }
    }

    // Profiles Grid in sidebar
    const profilesList = document.getElementById('sidebar-profiles-list');
    if (profilesList) {
      profilesList.innerHTML = '';
      Object.values(this.profiles).forEach(p => {
        const chip = document.createElement('div');
        chip.className = `sidebar-profile-chip ${p.id === this.activeProfileId ? 'active' : ''}`;
        chip.onclick = (e) => {
          e.stopPropagation();
          this.applyProfile(p.id, true);
        };

        const label = document.createElement('span');
        label.textContent = p.name;
        chip.appendChild(label);

        if (!p.isBuiltin) {
          const del = document.createElement('span');
          del.className = 'sb-chip-del';
          del.innerHTML = '&times;';
          del.title = `Delete "${p.name}"`;
          del.onclick = (e) => {
            e.stopPropagation();
            this.deleteProfile(p.id);
          };
          chip.appendChild(del);
        }

        profilesList.appendChild(chip);
      });
    }

    // Transport play button in sidebar
    const playBtn = document.getElementById('sidebar-btn-play');
    if (playBtn) {
      playBtn.innerHTML = isPlaying
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }

    // Quick Toggles in sidebar
    const tTrans = document.getElementById('sb-toggle-trans');
    if (tTrans) {
      tTrans.classList.toggle('active', !!showSecondary);
      const s = document.getElementById('sb-trans-state');
      if (s) s.textContent = showSecondary ? 'Romaji On' : 'Romaji Off';
    }

    const tLayout = document.getElementById('sb-toggle-layout');
    if (tLayout) {
      const isSplit = layoutMode === 'split';
      tLayout.classList.toggle('active', isSplit);
      const s = document.getElementById('sb-layout-state');
      if (s) s.textContent = isSplit ? 'Split' : 'Compact';
    }

    const tTop = document.getElementById('sb-toggle-ontop');
    if (tTop) {
      tTop.classList.toggle('active', !!alwaysOnTop);
      const s = document.getElementById('sb-ontop-state');
      if (s) s.textContent = alwaysOnTop ? 'Top On' : 'Top Off';
    }

    const tFs = document.getElementById('sb-toggle-fs');
    if (tFs) {
      tFs.classList.toggle('active', !!isFullscreen);
      const s = document.getElementById('sb-fs-state');
      if (s) s.textContent = isFullscreen ? 'FS On' : 'Window';
    }

    // Latency readout
    const valEl = document.getElementById('latency-rail-value');
    if (valEl) {
      valEl.textContent = `${latencyOffsetMs > 0 ? '+' : ''}${latencyOffsetMs}ms`;
    }
    if (window.renderLatencySlider) window.renderLatencySlider();
  },

  renderPills() {
    const active = this.getActiveProfile();
    const src = this.currentSource || {
      id: 'generic',
      name: 'Media Player',
      icon: 'generic'
    };

    const iconSvg = SOURCE_ICONS[src.icon] || SOURCE_ICONS[src.id] || SOURCE_ICONS.generic;
    let dotColor = '#1db954';
    if (src.id === 'simpmusic') dotColor = '#ff4081';
    else if (src.id === 'youtube') dotColor = '#ff0000';
    else if (src.id === 'vlc') dotColor = '#ff8800';
    else if (src.id === 'apple_music') dotColor = '#fc3c44';
    else if (src.id === 'browser') dotColor = '#3b82f6';
    else if (src.id === 'generic') dotColor = '#888888';

    const isLocked = !!this.lockedSourceKey;

    // 1. Float Pill
    const pill = document.getElementById('source-pill');
    if (pill) {
      const iconEl = document.getElementById('source-pill-icon');
      const srcEl = document.getElementById('source-pill-source');
      const profEl = document.getElementById('source-pill-profile');
      const lockEl = document.getElementById('source-pill-lock');
      const dotEl = pill.querySelector('.source-pill-dot');
      if (iconEl) iconEl.innerHTML = iconSvg;
      if (srcEl) srcEl.textContent = src.name || 'Media Player';
      if (profEl) profEl.textContent = active.name;
      if (lockEl) lockEl.hidden = !isLocked;
      if (dotEl) {
        dotEl.style.background = isLocked ? '#ffb703' : dotColor;
        dotEl.style.boxShadow = `0 0 6px ${isLocked ? '#ffb703' : dotColor}99`;
      }
    }

    // 2. Side Panel Pill
    const sidePill = document.getElementById('side-source-pill');
    if (sidePill) {
      const sideIconEl = document.getElementById('side-source-pill-icon');
      const sideSrcEl = document.getElementById('side-source-pill-source');
      const sideProfEl = document.getElementById('side-source-pill-profile');
      const sideLockEl = document.getElementById('side-source-pill-lock');
      const sideDotEl = sidePill.querySelector('.source-pill-dot');
      if (sideIconEl) sideIconEl.innerHTML = iconSvg;
      if (sideSrcEl) sideSrcEl.textContent = src.name || 'Media Player';
      if (sideProfEl) sideProfEl.textContent = active.name;
      if (sideLockEl) sideLockEl.hidden = !isLocked;
      if (sideDotEl) {
        sideDotEl.style.background = isLocked ? '#ffb703' : dotColor;
        sideDotEl.style.boxShadow = `0 0 6px ${isLocked ? '#ffb703' : dotColor}99`;
      }
    }
  },

  renderQuickSourcesList() {
    const container = document.getElementById('quick-sources-list');
    if (!container) return;
    container.innerHTML = '';

    const autoBtn = document.getElementById('qp-btn-auto-source');
    if (autoBtn) {
      autoBtn.classList.toggle('active', !this.lockedSourceKey);
    }

    const list = (this.availableSources && this.availableSources.length > 0)
      ? this.availableSources
      : (this.currentSource ? [{
          key: this.currentSource.raw_app_id || this.currentSource.id,
          app_id: this.currentSource.raw_app_id || this.currentSource.id,
          title: (currentTrackMeta && currentTrackMeta.title) || 'Active Track',
          artist: (currentTrackMeta && currentTrackMeta.artist) || '',
          playing: isPlaying,
          source: this.currentSource,
          is_current: true,
          is_locked: !!this.lockedSourceKey
        }] : []);

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qp-source-card';
      empty.style.opacity = '0.6';
      empty.style.cursor = 'default';
      empty.innerHTML = `
        <div class="qp-source-left">
          <span class="qp-source-icon">${SOURCE_ICONS.generic}</span>
          <div class="qp-source-meta">
            <span class="qp-source-name">No active player detected</span>
            <span class="qp-source-track">Play audio in Spotify, YouTube, etc.</span>
          </div>
        </div>
      `;
      container.appendChild(empty);
      return;
    }

    list.forEach((s) => {
      const card = document.createElement('div');
      const sInfo = s.source || {};
      const sId = sInfo.id || 'generic';
      const sIcon = SOURCE_ICONS[sInfo.icon] || SOURCE_ICONS[sId] || SOURCE_ICONS.generic;
      const sName = sInfo.name || s.app_id || 'Media Player';
      const isLocked = this.lockedSourceKey && (this.lockedSourceKey === s.key || this.lockedSourceKey === s.app_id || this.lockedSourceKey === sId);
      const isCur = s.is_current || (this.currentSource && this.currentSource.id === sId);

      card.className = `qp-source-card ${isCur ? 'current' : ''} ${isLocked ? 'locked' : ''}`;
      card.onclick = (e) => {
        e.stopPropagation();
        this.switchAndLockSource(s.key, sName);
      };

      card.innerHTML = `
        <div class="qp-source-left">
          <span class="qp-source-icon">${sIcon}</span>
          <div class="qp-source-meta">
            <span class="qp-source-name">${sName}</span>
            <span class="qp-source-track">${s.title ? (s.title + (s.artist ? ' • ' + s.artist : '')) : (s.playing ? 'Playing' : 'Ready')}</span>
          </div>
        </div>
        <div class="qp-source-status-badge">
          ${isLocked ? '<span>🔒 Locked</span>' : (isCur ? '<span>Active</span>' : (s.playing ? '<span>▶ Playing</span>' : '<span>Switch</span>'))}
        </div>
      `;
      container.appendChild(card);
    });
  },

  renderQuickProfileList() {
    const list = document.getElementById('quick-profile-list');
    if (!list) return;
    list.innerHTML = '';
    const activeId = this.activeProfileId;

    Object.values(this.profiles).forEach((prof) => {
      const row = document.createElement('div');
      row.className = `qp-popup-item ${prof.id === activeId ? 'active' : ''}`;
      row.onclick = (e) => {
        e.stopPropagation();
        this.applyProfile(prof.id, true);
        closeQuickProfileMenu();
      };

      const nameSpan = document.createElement('span');
      nameSpan.textContent = prof.name;
      nameSpan.style.flex = '1';

      row.appendChild(nameSpan);

      if (prof.id === activeId) {
        const check = document.createElement('span');
        check.className = 'qp-popup-item-check';
        check.textContent = '✓';
        row.appendChild(check);
      }

      if (!prof.isBuiltin) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'qp-profile-del-btn';
        delBtn.innerHTML = '&times;';
        delBtn.title = `Delete "${prof.name}"`;
        delBtn.onclick = (e) => {
          e.stopPropagation();
          deleteProfileById(prof.id, e);
        };
        row.appendChild(delBtn);
      }

      list.appendChild(row);
    });
  },

  renderLockDropdown() {
    const select = document.getElementById('profile-source-lock-select');
    if (!select) return;
    select.innerHTML = '<option value="">Auto-Follow (Active Player)</option>';

    const sources = this.availableSources || [];
    sources.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.key;
      const sName = (s.source && s.source.name) || s.app_id || 'Player';
      opt.textContent = `${sName}${s.title ? ': ' + s.title : ''}${s.playing ? ' (Playing)' : ''}`;
      if (this.lockedSourceKey && (this.lockedSourceKey === s.key || this.lockedSourceKey === s.app_id)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    if (this.lockedSourceKey && !sources.some(s => s.key === this.lockedSourceKey || s.app_id === this.lockedSourceKey)) {
      const opt = document.createElement('option');
      opt.value = this.lockedSourceKey;
      opt.textContent = `Locked: ${this.lockedSourceKey}`;
      opt.selected = true;
      select.appendChild(opt);
    }
  },

  renderProfilesPanel() {
    const select = document.getElementById('profile-select');
    if (!select) return;

    select.innerHTML = '';
    Object.values(this.profiles).forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + (p.isBuiltin ? ' (Built-in)' : '');
      if (p.id === this.activeProfileId) opt.selected = true;
      select.appendChild(opt);
    });

    const active = this.getActiveProfile();

    const delBtn = document.getElementById('btn-delete-profile');
    if (delBtn) {
      delBtn.disabled = !!active.isBuiltin;
      delBtn.style.opacity = active.isBuiltin ? '0.4' : '1';
      delBtn.style.cursor = active.isBuiltin ? 'not-allowed' : 'pointer';
    }

    const latDisplay = document.getElementById('profile-latency-display');
    if (latDisplay) {
      const lat = active.latencyOffsetMs || 0;
      latDisplay.textContent = `${lat > 0 ? '+' : ''}${lat}ms`;
    }

    const layoutCtrl = document.getElementById('profile-layout-control');
    if (layoutCtrl) {
      const btns = layoutCtrl.querySelectorAll('.seg-btn');
      btns.forEach((b) => {
        const isLayout = b.dataset.layout === (active.layout || 'compact');
        b.classList.toggle('active', isLayout);
      });
    }

    const autoToggle = document.getElementById('profile-autoswitch-toggle');
    if (autoToggle) {
      autoToggle.checked = !!this.autoSwitch;
    }

    this.renderLockDropdown();

    const mappingList = document.getElementById('source-mapping-list');
    if (mappingList) {
      mappingList.innerHTML = '';
      CANONICAL_SOURCES.forEach((src) => {
        const row = document.createElement('div');
        row.className = 'source-mapping-row';

        const info = document.createElement('div');
        info.className = 'source-mapping-info';
        info.innerHTML = `
          <span class="source-pill-dot" style="background: ${src.dot}; box-shadow: 0 0 6px ${src.dot}99;"></span>
          <span class="source-mapping-icon">${SOURCE_ICONS[src.icon] || SOURCE_ICONS.generic}</span>
          <span class="source-mapping-name">${src.name}</span>
        `;

        const sel = document.createElement('select');
        sel.className = 'source-mapping-select';
        sel.onchange = (e) => {
          this.setSourceMapping(src.id, e.target.value);
        };

        const currentMappedProfile = this.sourceMap[src.id] || 'default';
        Object.values(this.profiles).forEach((p) => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          if (p.id === currentMappedProfile) opt.selected = true;
          sel.appendChild(opt);
        });

        row.appendChild(info);
        row.appendChild(sel);
        mappingList.appendChild(row);
      });
    }
  }
};

window.ProfileManager = ProfileManager;

// Global UI Event Bridges
window.toggleQuickProfileMenu = function(e) {
  if (e) e.stopPropagation();
  const popup = document.getElementById('quick-profile-popup');
  if (!popup) return;
  const isOpening = popup.hidden;
  if (isOpening) {
    const target = (e && e.currentTarget) || document.getElementById('source-pill');
    if (target) {
      const rect = target.getBoundingClientRect();
      const popupWidth = 270;
      let left = rect.left;
      let top = rect.bottom + 8;
      if (left + popupWidth > window.innerWidth - 12) {
        left = Math.max(12, window.innerWidth - popupWidth - 12);
      }
      popup.style.left = `${Math.max(12, left)}px`;
      popup.style.top = `${Math.max(12, top)}px`;
    }
    const addRow = document.getElementById('qp-inline-add-row');
    if (addRow) addRow.hidden = true;
    ProfileManager.renderQuickSourcesList();
    ProfileManager.renderQuickProfileList();
    popup.hidden = false;
  } else {
    popup.hidden = true;
  }
};

window.closeQuickProfileMenu = function() {
  const popup = document.getElementById('quick-profile-popup');
  if (popup) popup.hidden = true;
};

window.openProfilesSettings = function() {
  closeQuickProfileMenu();
  openSettings(true);
  openSettingsTab('profiles');
};

window.deleteProfileById = function(id, e) {
  if (e) e.stopPropagation();
  ProfileManager.deleteProfile(id);
};

window.toggleQuickAddProfileInput = function(e) {
  if (e) e.stopPropagation();
  const row = document.getElementById('qp-inline-add-row');
  if (!row) return;
  row.hidden = !row.hidden;
  if (!row.hidden) {
    const input = document.getElementById('qp-input-new-profile');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
};

window.onQuickAddKeyDown = function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitQuickAddProfile(e);
  } else if (e.key === 'Escape') {
    const row = document.getElementById('qp-inline-add-row');
    if (row) row.hidden = true;
  }
};

window.submitQuickAddProfile = function(e) {
  if (e) e.stopPropagation();
  const input = document.getElementById('qp-input-new-profile');
  if (!input) return;
  const val = input.value.trim();
  if (val) {
    ProfileManager.createProfile(val);
    input.value = '';
    const row = document.getElementById('qp-inline-add-row');
    if (row) row.hidden = true;
  }
};

window.promptNewProfile = function() {
  const input = document.getElementById('settings-new-profile-input');
  if (input) {
    input.focus();
    input.select();
  }
};

window.submitSettingsAddProfile = function() {
  const input = document.getElementById('settings-new-profile-input');
  if (!input) return;
  const val = input.value.trim();
  if (val) {
    ProfileManager.createProfile(val);
    input.value = '';
  }
};

window.onSettingsAddKeyDown = function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitSettingsAddProfile();
  }
};

window.duplicateCurrentProfile = function() {
  const active = ProfileManager.getActiveProfile();
  ProfileManager.createProfile(`${active.name} (Copy)`);
};

window.deleteCurrentProfile = function() {
  const active = ProfileManager.getActiveProfile();
  if (active.isBuiltin) {
    showProfileToast('Built-in profiles cannot be deleted');
    return;
  }
  ProfileManager.deleteProfile(active.id);
};

window.resetActiveProfileToDefaults = function() {
  const active = ProfileManager.getActiveProfile();
  if (BUILTIN_PROFILES[active.id]) {
    ProfileManager.profiles[active.id] = JSON.parse(JSON.stringify(BUILTIN_PROFILES[active.id]));
    ProfileManager.applyProfile(active.id, true, 'Reset to factory defaults');
  } else {
    const def = BUILTIN_PROFILES.default;
    Object.assign(ProfileManager.profiles[active.id], {
      latencyOffsetMs: def.latencyOffsetMs,
      layout: def.layout,
      beatLevel: def.beatLevel,
      chromaLevel: def.chromaLevel,
      momentLevel: def.momentLevel,
      ambientLevel: def.ambientLevel,
      tiltLevel: def.tiltLevel,
      sliderBeat: def.sliderBeat,
      sliderChroma: def.sliderChroma,
      sliderArt: def.sliderArt,
      sliderParticles: def.sliderParticles,
      sliderParticleOpacity: def.sliderParticleOpacity,
      sliderParticleSize: def.sliderParticleSize,
      sliderMoments: def.sliderMoments,
      sliderTilt: def.sliderTilt
    });
    ProfileManager.applyProfile(active.id, true, 'Reset values to defaults');
  }
};

window.onProfileDropdownChange = function(val) {
  ProfileManager.applyProfile(val, true);
};

window.onSourceLockSelectChange = function(val) {
  if (!val) {
    ProfileManager.unlockSource();
  } else {
    const s = ProfileManager.availableSources.find(src => src.key === val || src.app_id === val);
    const sName = (s && s.source && s.source.name) || val;
    ProfileManager.switchAndLockSource(val, sName);
  }
};

window.unlockSource = function(e) {
  if (e) e.stopPropagation();
  ProfileManager.unlockSource();
};

window.adjustProfileLatency = function(delta) {
  const prof = ProfileManager.getActiveProfile();
  const current = prof.latencyOffsetMs || 0;
  const next = Math.max(-2000, Math.min(2000, current + delta));
  ProfileManager.updateActiveProfile({ latencyOffsetMs: next });
  ProfileManager.renderProfilesPanel();
  if (currentTrackOffsetIsDefault) {
    latencyOffsetMs = next;
    updateLatencyUI();
    if (lyrics.length > 0) renderProgress((isPlaying ? predictedPlayhead() : playheadMs) + latencyOffsetMs);
  }
};

window.setProfileLayout = function(layout) {
  ProfileManager.updateActiveProfile({ layout });
  layoutMode = layout;
  applyLayoutState();
  syncSettingsPanel();
  ProfileManager.renderProfilesPanel();
};

window.toggleAutoSwitch = function(enabled) {
  ProfileManager.autoSwitch = !!enabled;
  ProfileManager.save();
  showProfileToast(enabled ? 'Auto-switching enabled' : 'Auto-switching disabled');
};

let toastTimer = null;
window.showProfileToast = function(msg, duration = 2400) {
  const toast = document.getElementById('profile-toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toastTimer = null;
  }, duration);
};

document.addEventListener('click', (e) => {
  const popup = document.getElementById('quick-profile-popup');
  if (popup && !popup.hidden && !popup.contains(e.target) && !e.target.closest('.source-pill')) {
    popup.hidden = true;
  }
});

// Sidebar Bridge Helpers
window.toggleCurrentSourceLock = function(e) {
  if (e) e.stopPropagation();
  if (ProfileManager.lockedSourceKey) {
    ProfileManager.unlockSource();
  } else {
    const cur = ProfileManager.currentSource;
    const key = (cur && cur.raw_app_id) || (cur && cur.id) || 'media';
    ProfileManager.switchAndLockSource(key, (cur && cur.name) || 'Current Player');
  }
};

window.toggleSidebarAddProfile = function(e) {
  if (e) e.stopPropagation();
  const row = document.getElementById('sidebar-inline-add');
  if (!row) return;
  row.hidden = !row.hidden;
  if (!row.hidden) {
    const input = document.getElementById('sidebar-new-profile-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
};

window.onSidebarAddKeyDown = function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitSidebarAddProfile(e);
  } else if (e.key === 'Escape') {
    const row = document.getElementById('sidebar-inline-add');
    if (row) row.hidden = true;
  }
};

window.submitSidebarAddProfile = function(e) {
  if (e) e.stopPropagation();
  const input = document.getElementById('sidebar-new-profile-input');
  if (!input) return;
  const val = input.value.trim();
  if (val) {
    ProfileManager.createProfile(val);
    input.value = '';
    const row = document.getElementById('sidebar-inline-add');
    if (row) row.hidden = true;
  }
};
