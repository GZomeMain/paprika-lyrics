# Room air and cover tilt — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two visual effects to the overlay's existing light language: a field of accent-tinted motes drifting through the room that the beat nudges and a drop puffs, and a sleeve that leans toward the pointer while the blurred room counter-moves behind it.

**Architecture:** Both effects are built on the primitives the previous visual pass established — `--art-accent` (a registered `<color>` read from the cover), `--beat-strength` / `--beat-ms` / `--beat-lead-ms` / `body.beat-live` / `body.beat-phase-drop` (published by the rhythm plan), and `--line-breath`/`--cover-zoom`-style custom-property transitions declared once on the root. Neither effect invents a second motion model: room air reads the beat plan's own amplitude, and cover tilt reads only the pointer. The strict rule the previous pass left behind is kept — **one property, one owner** — and it is the reason the tilt needs a stage of its own: `.track-art` and `.art-light` are already animated by the beat, and `.cover-art-blur` by its own 26s drift, so a tilt written onto any of them would fight an animation.

**Tech Stack:** Python 3.13 host (pywebview 6.2.1 → Edge WebView2), plain JS + CSS in `ui/`, `node --check` for syntax, `python -m unittest` for the host, and `tools/ui-preview-regression.js` run in a browser as the UI test suite.

## Execution status (2026-10-01)

All five tasks are implemented. The first pass shipped both effects at amplitudes that turned out to be below the threshold of noticing — 16 motes of 1.5–5px at 0.45 opacity, a 2.4° lean on a 760px perspective, a 12px counter-move — so a tuning pass followed, and the numbers below are the tuned ones. The audit that followed that pass found two real defects (a lean that survived a layout change and a window blur, because no `mouseleave` is dispatched for either) and two pieces of waste (28 motes still animating behind `opacity: 0` when the setting is Off, and a `filter: blur()` on every mote). All are fixed; the same pass retired a stale-seek bug the new gate assertion caught (an accepted seek left its rollback target armed, so a late refusal could drag the playhead back).

`node --check` is silent on both JS files, `python -m unittest discover -s tests` is **390 tests, OK** (one test added for the app version — see *Production pass* below), and the preview gate **PASSES with zero problems at 1400×900, 900×700, 800×600, 360×420 and 330×380**, including the unchanged `settingsHints === 4`, `settingsTabGroups.visuals === ['Motion']`, `settingsFits`, `settingsLabelAlignedWithTitle`, and the whole section-14 lamp regression.

Beyond the gate, the geometry and behaviour were probed directly, at 1400×900:

- The stage fills each art wrap (96×96 fullscreen compact, 460×460 split) with the artwork filling the stage once a cover loads and the lamp still spreading past it.
- A synthetic pointer move publishes ±0.988 and releases to 0 on `mouseleave`, and **also on a layout change and on window blur** (`applyLayoutState`, `applyMiniState`, `applyMotionPreference` and a `blur` listener all release it). Bold leans −7.48° measured against a 7.2° nominal (6° × the 1.2 Bold multiplier) with the lift at `scale 1.051` and the gloss at opacity 1; Subtle is 0.7× of that, and Off computes a rigid box with no gloss.
- With `beat-live` + `beat-phase-drop` at `--beat-strength: 0.9` the field runs `dust-kick` (0.5s, the plan's own beat grid) and lifts **−4.84px** as a whole, scaling to **1.081** while the drop is open and settling to `scale 1` with the lift intact afterwards.
- Room air: 28 motes, largest 6.94px, peak mote opacity 0.9, no `filter`, opacity 0.62 on, `display: none` off.

**Still unverified — needs a real Windows run with a track playing (the plan's own smoke items):**

- [ ] Whether the tuned air now reads at 28 motes / 0.62 / 2.5–7px on a quiet ballad, and whether Bold is the right depth. This is the one the tuning pass was aimed at and screenshots cannot settle it here.
- [ ] Whether `--dur-2` on the tilt feels like weight or like lag when dragging the pointer across the sleeve quickly; it is the single knob if it feels twitchy.
- [ ] The gloss at 0.34 white — whether it reads as light on the sleeve or as a smear on a bright cover.
- [ ] The backdrop's counter-move at 28px/20px — whether it reads as depth or is invisible under the blur.
- [ ] The drop puff's amplitude (0.09 scale under `--dust-surge`, riding `--beat-strength`) on a genuinely hard drop.

---

## Global Constraints

- **No Python-side changes at all.** `python -m unittest discover -s tests` must stay green at its current count (389 passing on this branch at plan time). Both effects are CSS/JS.
- **Do not commit, push, branch or stash.** The working tree already carries a large uncommitted visual/transport pass. Each task's last step is a **checkpoint** — read `git status --short` and `git diff --stat`, confirm only the files the task names changed, and move on. No `git add`, no `git commit`.
- **One property, one owner.** Before writing any rule, name the property and its owner:
  - `.ambient-backdrop`'s `opacity`/`transform` and `.track-art`/`.art-light`'s `transform`: the beat.
  - `.cover-art-blur`'s `transform`: the drift. `.cover-art-blur`'s `opacity`: the cross-fade.
  - `.moment-veil`'s `opacity`: a moment.
  - `.tilt-stage`'s `transform`: **cover tilt alone** (new element, created by this plan).
  - `.dust-field`'s `opacity` (the mode), `translate` (the beat's nudge) and `scale` (a drop's puff): **room air alone** (new element, created by this plan).
  - `.mote`'s `transform` and `opacity`: **room air's drift alone**.
  - `.cover-art-blur`'s `translate`: **cover tilt alone** (the standalone property composes with the drift's `transform` instead of replacing it).
- **Never animate a property another layer animates.** An animation on a property a second rule also declares leaves that rule unable to transition — the snap the previous pass removed from the veil and the lamp.
- **Animate `opacity` / `transform` / the standalone `translate` and `scale` properties only.** Never re-blur the backdrop per frame, never animate `filter`, `left`, `top`, `width` or `height` on a per-frame layer.
- **Do not rename or move these JS globals the host and the preview gate read through:** `setFullscreen`, `setMiniMode`, `setClickThrough`, `updateArtProgress`, `setTrackDuration`, `cycleLayout`, `applyWindowOpacity`, `windowAlphaTarget`, `refreshTtml`, `renderTtmlPanel`, `setSyllableState`, `setMiniBarRevealed`, `setBeatPhase`, `setTransportState`, `transportResult`, `cycleMoments`, `cycleBeatMode`, `cycleMotionStyle`, `momentHooks`, `momentStarts`, `dustLayout`, `tiltVector`, `cycleAmbient`, `cycleTilt`.
- **Do not change any existing settings row id, panel id or inline handler** (`qp-opacity`, `qp-latency`, `qp-ttml-*`, `qp-panel-*`, `qp-tab-*`, `qp-moments`, `qp-beat`, …). Two rows are **added** (Task 2, Task 4); nothing existing moves.
- **`Off`, reduced motion and the mini player leave the room completely stock.** No half-on state: room air is `display: none` under reduced motion and mini, and `--dust-op: 0` when the setting is Off; the tilt stage computes to an untransformed box in every one of those states.
- **Copy rule:** comments explain *why*, in the repo's own voice; sentence-case user copy; no TODO, placeholder or "TBD" text anywhere.
- **Gate parity.** `node --check ui/app.js` and `node --check tools/ui-preview-regression.js` must be silent, and `tools/ui-preview-regression.js` must PASS at 1400×900, 900×700, 800×600, 360×420 and 330×380. Two existing counts must stay exactly as they are: `settingsHints === 4` (extend the existing Visuals hint; do not add a new one) and `settingsTabGroups.visuals === ['Motion']` (add rows, not groups).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `ui/index.html` | Two new rows in the Visuals panel; the `.dust-field` element; the `.tilt-stage` wrapper inside each art wrap. |
| `ui/app.js` | `dustLayout` / `buildDustField` (the pure layout and the field), the room-air mode engine, `tiltVector` / `setTilt` / `resetTilt` (the pure maths and the publish), the tilt mode engine and the pointer listeners, the two boot restores, and the two `syncSettingsPanel` lines. |
| `ui/style.css` | `@property` registrations for `--dust-op`, `--tilt-x`, `--tilt-y`; the `:root` transitions; `.dust-field` + `.mote` + the drift/kick keyframes; `.tilt-stage` + the backdrop parallax; the reduced-motion and mini guards. |
| `tools/ui-preview-regression.js` | New section 16 (room air) and section 17 (cover tilt), plus docblock item 11. |
| `README.md` | Feature copy, the reduced-motion bullet, and the smoke checklist. |

No new runtime files. No Python files.

---

### Task 1: Room air — the field and its drift

The layout is a **pure function of the mote's index**, not `Math.random`. A field that reshuffles on every launch cannot be reasoned about, cannot be asserted, and will occasionally bunch every mote in one corner. `dustLayout(count)` is exported on `window` so the preview gate asserts the layout itself instead of whatever happened to be built.

**Files:**
- Modify: `ui/index.html` (one element, after `.moment-veil`)
- Modify: `ui/app.js` (a new block after `cycleBeatMode()`)
- Modify: `ui/style.css` (a new block after the `.moment-veil` rules)
- Modify: `tools/ui-preview-regression.js` (new section 16 + docblock item 11)

**Interfaces:**
- Produces: `window.dustLayout(count) -> Array<{x, y, size, delay, dur, drift}>` with `x`,`y` in `[0,1)` (viewport fractions), `size` in `[1.5,5)` px, `delay` in `(-24,0]` s, `dur` in `[16,30)` s, `drift` in `[0.4,1.8)` rem — deterministic for a given index.
- Produces: `buildDustField() -> Element | null` — creates the motes once and is idempotent.
- Produces: the DOM contract `#dust-field` containing `DUST_COUNT` (`16`) `<i class="mote">` children, each carrying the inline custom properties `--mx`, `--my`, `--ms`, `--md`, `--mt`, `--mw`.
- Produces: `DUST_COUNT = 16`.

- [ ] **Step 1: Add the field element to the markup**

In `ui/index.html`, immediately after the `.moment-veil` element (and after its closing comment), insert:

```html
    <!-- Room air: the motes of the album's own light that drift through the room.
         One layer above the veil and below the card and the lyrics, so air sits
         in front of the grade but behind everything readable. It never takes a
         pointer event: the card, the drag strip and the mini bar are grabbed
         through it. The motes are built once by app.js (buildDustField). -->
    <div class="dust-field" id="dust-field" aria-hidden="true"></div>
```

- [ ] **Step 2: Write the failing gate assertions**

In `tools/ui-preview-regression.js`, add a new section immediately before the `// restore the state the checks started from` comment (i.e. after section 15's `setTrackDuration(213000);`):

```js
  // --- 16. room air -------------------------------------------------------
  // The room has air in it, tinted with the album's own colour, and it must never
  // get in the way of a grab. The layout is asserted as a FUNCTION rather than by
  // reading back the elements it happened to build: a field that reshuffles on
  // every launch would pass an element count and fail its user.
  const dustField = document.getElementById('dust-field');
  result.dustPresent = !!dustField;
  if (!dustField) problems.push('no dust field');
  const motes = [...document.querySelectorAll('#dust-field .mote')];
  result.dustCount = motes.length;
  if (result.dustCount !== 16) {
    problems.push('the dust field holds ' + result.dustCount + ' motes, expected 16');
  }
  result.dustPointerEvents = motes.length > 0
    ? getComputedStyle(motes[0]).pointerEvents : null;
  result.dustFieldPointerEvents = dustField ? getComputedStyle(dustField).pointerEvents : null;
  if (result.dustFieldPointerEvents !== 'none' || result.dustPointerEvents !== 'none') {
    problems.push('the air takes pointer events: ' + result.dustFieldPointerEvents + '/' +
      result.dustPointerEvents);
  }

  const layoutA = dustLayout(16);
  const layoutB = dustLayout(16);
  result.dustLayoutDeterministic = JSON.stringify(layoutA) === JSON.stringify(layoutB);
  if (!result.dustLayoutDeterministic) problems.push('the dust layout is not deterministic');
  result.dustLayoutShape = layoutA.length;
  result.dustLayoutInRange = layoutA.every((m) =>
    m.x >= 0 && m.x < 1 && m.y >= 0 && m.y < 1 &&
    m.size >= 1.5 && m.size < 5 &&
    m.delay <= 0 && m.delay > -24 &&
    m.dur >= 16 && m.dur < 30 &&
    m.drift >= 0.4 && m.drift < 1.8);
  if (!result.dustLayoutInRange) {
    problems.push('a mote is outside its range: ' + JSON.stringify(layoutA.slice(0, 3)));
  }

  // The tint is checked BEHAVIOURALLY, like the lamp: getComputedStyle resolves
  // color-mix() into literal rgba(), so the honest question is whether the painted
  // dot follows --art-accent.
  const rootDust = document.documentElement;
  const savedAccentDust = rootDust.style.getPropertyValue('--art-accent');
  const readMote = () => (motes[0] ? getComputedStyle(motes[0]).backgroundImage : '');
  rootDust.style.setProperty('--art-accent', 'rgb(220 40 40)');
  const warmMote = readMote();
  rootDust.style.setProperty('--art-accent', 'rgb(40 90 220)');
  const coolMote = readMote();
  if (savedAccentDust) rootDust.style.setProperty('--art-accent', savedAccentDust);
  else rootDust.style.removeProperty('--art-accent');
  result.dustFollowsAccent = !!warmMote && warmMote !== coolMote;
  if (!result.dustFollowsAccent) problems.push('the motes do not follow the artwork accent');

  // The drift moves transform and opacity only. A keyframe that moved `left`/`top`
  // would run layout on every frame of a layer that is on for the whole song.
  const dustSheet = [...document.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules]; } catch (e) { return []; }
  });
  const driftKeyframes = dustSheet.filter((r) =>
    r.constructor.name === 'CSSKeyframesRule' && /mote-drift/.test(r.name));
  result.dustDriftKeyframes = driftKeyframes.length;
  result.dustDriftTransformOnly = driftKeyframes.length === 1 &&
    [...driftKeyframes[0].cssRules].every((k) =>
      !/\b(left|top|width|height|filter)\b/.test(k.style.cssText));
  if (!result.dustDriftTransformOnly) {
    problems.push('a mote-drift keyframe touches a layout or filter property');
  }
  result.dustTintDeclaration = dustSheet.some((r) =>
    r.selectorText === '.mote' && /--art-accent/.test(r.style ? r.style.cssText : ''));
  if (!result.dustTintDeclaration) problems.push('.mote does not read --art-accent');
```

- [ ] **Step 3: Run the gate and watch it fail**

Serve the repo (`python -m http.server 8479` from the repo root; 8471–8479 have been used historically, so check the port is free first), open `http://localhost:8479/ui/` in the preview tab, and run the gate.

The exact call for this host — `run` does not survive between separate `preview_evaluate` calls, so the gate must be loaded and invoked in one call:

```js
const src = await (await fetch('/tools/ui-preview-regression.js')).text();
window.run = new Function(src + '\nreturn run;')();
await window.run('1400x900');
```

Expected: FAIL with `no dust field`, `the dust field holds 0 motes, expected 16`, and `dustLayout is not defined`.

- [ ] **Step 4: Add the pure layout and the field builder**

In `ui/app.js`, immediately after `cycleBeatMode()`'s closing brace, insert:

```js
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
const DUST_COUNT = 16;

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
      size: 1.5 + dustHash(i, 3) * 3.5,
      delay: -dustHash(i, 4) * 24,
      dur: 16 + dustHash(i, 5) * 14,
      drift: 0.4 + dustHash(i, 6) * 1.4,
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
  if (!field || field.childElementCount) return field;
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
```

Then build it at boot: in the boot call list (the lines ending `initSettingsTabs();`), directly after `initFloatArt();`, add:

```js
buildDustField();
```

The field is in the DOM before this runs (the script tag is the last thing in the body), so this is the whole wiring for Task 1 — the motes exist and drift, still invisible at `--dust-op`'s registered initial value of `0` until Task 2 gives them a mode.

- [ ] **Step 5: Style the field and the drift**

In `ui/style.css`, immediately before the `/* Microscopic SVG Film Grain … */` comment (so: after the `body.moment-live` rule that sets `--lamp-moment`), insert:

```css
/* =========================================================
   Room air
   Motes of the album's own light drifting through the room. One layer, one
   opacity (the setting's level); one transform and one opacity per mote (the
   drift). The field itself owns `translate` (the beat's nudge) and `scale` (a
   drop's puff), so those two gestures never write the same property and a mote's
   own drift is never interrupted. Above the veil, below the card and the lyrics.
   Nothing here takes a pointer event.
   ========================================================= */
.dust-field {
  position: absolute;
  inset: 0;
  z-index: 3;
  overflow: hidden;
  pointer-events: none;
  /* Registered and transitioned on the root, so a mode change fades rather than
     snapping the whole field into existence. */
  opacity: var(--dust-op, 0);
}

.mote {
  position: absolute;
  left: var(--mx, 50%);
  top: var(--my, 50%);
  width: var(--ms, 3px);
  height: var(--ms, 3px);
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(closest-side,
    color-mix(in srgb, var(--art-accent) 60%, transparent),
    transparent 78%);
  filter: blur(0.6px);
  animation: mote-drift var(--mt, 22s) linear infinite;
  animation-delay: var(--md, 0s);
}

/* Transform and opacity only: the field is on for the whole song, so a keyframe
   that moved `left`/`top` would run layout on every frame of it. */
@keyframes mote-drift {
  0%   { transform: translate3d(0, 0, 0) scale(0.85); opacity: 0.22; }
  45%  { opacity: 0.55; }
  100% { transform: translate3d(var(--mw, 1rem), -2.4rem, 0) scale(1.05); opacity: 0.18; }
}
```

- [ ] **Step 6: Register `--dust-op` and give it a transition**

In the `@property --art-accent` block region of `ui/style.css`, directly after the `@property --art-accent { … }` rule, add:

```css
/* The room-air level: one number (the setting), read by one opacity. Registered
   so a mode change fades the whole field instead of flicking it on, and declared
   here before the :root transition that names it. */
@property --dust-op {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}
```

Then extend the existing `:root` transition rule so it reads:

```css
:root {
  transition: --art-accent 1.6s var(--ease-fluid),
              --dust-op var(--dur-4) var(--ease-fluid);
}
```

- [ ] **Step 7: Run the gate**

Reload the page and run the gate at 1400×900. Expected: PASS, with `dustCount: 16`, `dustLayoutDeterministic: true`, `dustLayoutInRange: true`, `dustFollowsAccent: true`, `dustDriftTransformOnly: true`.

Note: with `--dust-op`'s initial value of `0` and no engine yet (Task 2), the field is present but invisible — the section asserts structure and tint, not visibility.

- [ ] **Step 8: Checkpoint — do not commit**

```bash
git status --short
git diff --stat -- ui/index.html ui/app.js ui/style.css tools/ui-preview-regression.js
```

Expected: exactly those four files listed, and no others from this task.

---

### Task 2: Room air — the modes, the beat's nudge, and a drop's puff

Two existing hooks do all the work: `body.beat-live` (the plan says the track is driven) is already on the body while the pulse runs, `body.beat-phase-drop` is already on the body while the plan says a drop is open, and `--beat-strength` / `--beat-ms` / `--beat-lead-ms` are already published. Room air therefore needs no new per-frame work and no new reading of the beat plan.

**Files:**
- Modify: `ui/index.html` (the Visuals panel row + the existing hint's copy)
- Modify: `ui/app.js` (the mode engine; `syncSettingsPanel`; the boot block)
- Modify: `ui/style.css` (the kick keyframes, the drop rule, the mini/reduced-motion guards)
- Modify: `tools/ui-preview-regression.js` (extend section 16)

**Interfaces:**
- Consumes: `buildDustField()`, `DUST_COUNT` (Task 1).
- Consumes from the existing app: `body.beat-live`, `body.beat-phase-drop`, `--beat-strength`, `--beat-ms`, `--beat-lead-ms`, `Settings`, `setValueText`, `syncSettingsPanel`, `reducedMotion`, `miniMode`.
- Produces: `AMBIENT_MODES = ['on','bold','off']`, `AMBIENT_LABELS`, `AMBIENT_LEVEL = {on: 0.45, bold: 0.8}`, `ambientMode` (default `'on'`), `applyAmbientMode()`, `cycleAmbient()`.
- Produces: the DOM contract `#qp-ambient` / `#qp-ambient-state`, and the persisted key `ambientMode` under `sl_ambientMode`.
- Produces: `--dust-surge` (`1` while `body.beat-phase-drop`, otherwise absent → `0` through the keyframe's fallback).

- [ ] **Step 1: Write the failing gate assertions**

In `tools/ui-preview-regression.js`, append to section 16 (after the `dustTintDeclaration` check from Task 1):

```js
  // The mode is the whole intensity, and every "leave it stock" state has to be
  // exactly stock: Off is invisible, mini hides it, and reduced motion hides it.
  const savedAmbientMode = ambientMode;
  ambientMode = 'off';
  applyAmbientMode();
  result.dustOffOpacity = parseFloat(getComputedStyle(dustField).opacity);
  if (result.dustOffOpacity !== 0) {
    problems.push('the air is visible while Room air is Off: ' + result.dustOffOpacity);
  }
  ambientMode = 'on';
  applyAmbientMode();
  result.dustOnOpacity = parseFloat(getComputedStyle(dustField).opacity);
  if (!(result.dustOnOpacity > 0)) {
    problems.push('the air is invisible while Room air is on');
  }
  ambientMode = savedAmbientMode;
  applyAmbientMode();

  const wasMiniDust = body.classList.contains('mini');
  setMiniMode(true);
  result.dustMiniDisplay = getComputedStyle(dustField).display;
  if (result.dustMiniDisplay !== 'none') {
    problems.push('the mini player keeps the room air: ' + result.dustMiniDisplay);
  }
  setMiniMode(false);
  void wasMiniDust;

  // Reduced motion is asserted from the rule rather than by toggling the global
  // preference mid-run: the rule is what does the work, and toggling would restart
  // every engine for a check that is about CSS. `--dust-op` and the tilt numbers
  // are registered and transitioned on the root, but the gate's own `noAnim`
  // stylesheet suspends every transition, so these values settle immediately.
  const dustRules = dustSheet.filter((r) => r.selectorText && /dust-field/.test(r.selectorText));
  const dustText = dustRules.map((r) => r.selectorText + '{' + (r.style ? r.style.cssText : '') + '}').join('\n');
  result.dustReducedHidden = /\.reduce-motion[^{]*\.dust-field[^{]*\{[^}]*display:\s*none/.test(dustText);
  if (!result.dustReducedHidden) problems.push('reduced motion does not hide the room air');

  // The beat nudges the whole body of air on its own grid, and the drop puffs it —
  // both on properties the motes' drift does not use.
  result.dustBeatKick = /body\.beat-live[^{]*\.dust-field[^{]*\{[^}]*animation-name/.test(dustText);
  result.dustKickGrid = /animation-duration[^}]*--beat-ms/.test(dustText);
  if (!result.dustBeatKick) problems.push('the beat does not nudge the room air');
  if (!result.dustKickGrid) problems.push('the room air is not phase-locked to the beat grid');
  const kickKeyframes = dustSheet.filter((r) =>
    r.constructor.name === 'CSSKeyframesRule' && /dust-kick/.test(r.name));
  result.dustKickKeyframes = kickKeyframes.length;
  // The kick writes ONLY the field's own standalone properties: `translate` and
  // `scale`. Anything else — `transform` (a mote's own), `opacity` (the mode's),
  // or a layout property — is a bug the motes' drift or the setting would pay for.
  result.dustKickOwnProperties = kickKeyframes.length === 1 &&
    [...kickKeyframes[0].cssRules].every((k) => {
      const text = k.style.cssText;
      return !/\btransform\b|\bopacity\b/.test(text) &&
             !/\bleft\b|\btop\b|\bwidth\b|\bheight\b|\bfilter\b/.test(text);
    });
  if (!result.dustKickOwnProperties) {
    problems.push('a dust-kick keyframe writes a property another layer owns');
  }
  result.dustDropSurge = dustSheet.some((r) =>
    r.selectorText === 'body.beat-phase-drop' && /--dust-surge/.test(r.style ? r.style.cssText : ''));
  if (!result.dustDropSurge) problems.push('a drop does not puff the room air');

  // The row cycles the same three states as Beat sync and Big moments, and the
  // choice is written down.
  const ambientRow = document.getElementById('qp-ambient');
  const ambientState = document.getElementById('qp-ambient-state');
  result.ambientRow = !!ambientRow && !!ambientState;
  if (!result.ambientRow) problems.push('no Room air row');
  const ambientSeen = [];
  if (ambientRow && ambientState) {
    const startAmbient = ambientState.textContent.trim();
    for (let i = 0; i < 3; i++) {
      ambientRow.click();
      ambientSeen.push(ambientState.textContent.trim());
    }
    result.ambientRowCycles = ambientSeen;
    if (JSON.stringify(ambientSeen) !== JSON.stringify(['Bold', 'Off', 'Subtle'])) {
      problems.push('the Room air row cycles ' + ambientSeen.join(',') +
        ' (expected Bold,Off,Subtle from ' + startAmbient + ')');
    }
  }
  result.ambientPersisted = (() => {
    try { return localStorage.getItem('sl_ambientMode'); } catch (e) { return '(unavailable)'; }
  })();
```

- [ ] **Step 2: Run the gate and watch it fail**

Expected: FAIL with `no Room air row` and `the air is invisible while Room air is on`.

- [ ] **Step 3: Add the row and extend the hint**

In `ui/index.html`, in `#qp-panel-visuals`, insert directly after the `#qp-moments` button:

```html
              <button class="qp-row qp-action" id="qp-ambient" onclick="cycleAmbient()">
                <span class="qp-label">Room air</span>
                <span class="qp-state" id="qp-ambient-state">Subtle</span>
              </button>
```

Then extend the existing hint's copy (do **not** add a second hint — the gate counts them at exactly 4). Replace the current Visuals hint's text with:

```html
              <p class="sp-hint">Big moments step the scene back and take the album's own
                colour when a drop lands or a chorus hook arrives; the sleeve's light lifts and
                the words themselves never move or tint. Room air drifts motes of that same
                colour through the room, and a drop puffs them. Reduced motion, the mini player
                and this row being Off all leave the track untouched.</p>
```

- [ ] **Step 4: Add the mode engine**

In `ui/app.js`, directly after `buildDustField()` (Task 1), insert:

```js
// Same three states as Beat sync and Big moments, deliberately: one intensity
// system, not three. The level is one number read by one opacity, so Subtle and
// Bold differ by nothing but this.
const AMBIENT_MODES = ['on', 'bold', 'off'];
const AMBIENT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
const AMBIENT_LEVEL = { on: 0.45, bold: 0.8 };
let ambientMode = 'on';

// Off, reduced motion and the mini player have to be exactly stock; the CSS hides
// the field for the last two, so this only has to answer the setting. The number
// is published on the root because its transition is declared there.
function applyAmbientMode() {
  const level = ambientMode === 'off' ? 0 : (AMBIENT_LEVEL[ambientMode] || AMBIENT_LEVEL.on);
  document.documentElement.style.setProperty('--dust-op', String(level));
}

function cycleAmbient() {
  const idx = AMBIENT_MODES.indexOf(ambientMode);
  ambientMode = AMBIENT_MODES[(idx + 1) % AMBIENT_MODES.length];
  Settings.set('ambientMode', ambientMode);
  applyAmbientMode();
  syncSettingsPanel();
}
```

- [ ] **Step 5: Style the nudge, the puff and the stock states**

In `ui/style.css`, directly after the `mote-drift` keyframes from Task 1, insert:

```css
/* The beat nudges the WHOLE body of air, on the same grid and with the same
   amplitude the pulse uses. `translate` and `scale` are standalone properties, so
   this composes with each mote's own transform in the compositor instead of
   replacing it — the drift is never interrupted by the beat. */
body.beat-live .dust-field {
  animation-name: dust-kick;
  animation-duration: var(--beat-ms, 520ms);
  animation-timing-function: cubic-bezier(0.2, 0.9, 0.35, 1);
  animation-iteration-count: infinite;
  animation-delay: var(--beat-lead-ms, -90ms);
}

/* A drop puffs the air on each of its beats. The amplitude is a constant because
   the per-beat amplitude already scales with --beat-strength: a hard drop moves
   the air further without a second reading of the phase level. */
body.beat-phase-drop { --dust-surge: 1; }

@keyframes dust-kick {
  0%   { translate: 0 0; scale: 1; }
  16%  { translate: 0 calc(-3px * var(--beat-strength, 0.6));
         scale: calc(1 + 0.05 * var(--dust-surge, 0)); }
  100% { translate: 0 0; scale: 1; }
}

/* Off is --dust-op: 0; reduced motion and the mini player take the field out of
   the tree entirely, so there is no half-on state to explain. */
body.mini .dust-field,
.reduce-motion .dust-field {
  display: none;
}
```

- [ ] **Step 6: Wire `syncSettingsPanel` and the boot restore**

In `ui/app.js`, in `syncSettingsPanel()`, directly after the `qp-moments-state` line, add:

```js
  setValueText(document.getElementById('qp-ambient-state'), AMBIENT_LABELS[ambientMode] || 'Subtle');
```

In the boot preferences block (the `try`/`catch` that reads the saved preferences), directly after the `momentsMode` restore, add:

```js
  const savedAmbientMode = Settings.get('ambientMode', 'on');
  if (AMBIENT_MODES.includes(savedAmbientMode)) ambientMode = savedAmbientMode;
```

And in the boot call list, directly after the `buildDustField();` call added in Task 1, add:

```js
applyAmbientMode();
```

- [ ] **Step 7: Run the gate**

Expected: PASS with `dustOffOpacity: 0`, `dustOnOpacity: 0.45`, `dustMiniDisplay: "none"`, `dustReducedHidden: true`, `dustBeatKick: true`, `dustKickGrid: true`, `dustDropSurge: true`, `ambientRowCycles: ["Bold","Off","Subtle"]`, `ambientPersisted: "on"`.

- [ ] **Step 8: Look at it**

Play a track with a drop. The motes should drift continuously through quiet passages, lift a hair on each beat, and puff outward while a drop is open. Then set **Room air: Off** and confirm the room is completely still (the backdrop's own drift and the sleeve's lamp are untouched — those are other layers).

- [ ] **Step 9: Checkpoint — do not commit**

```bash
git status --short
git diff --stat -- ui/index.html ui/app.js ui/style.css tools/ui-preview-regression.js
```

---

### Task 3: Cover tilt — a stage of its own

This is the task that must not be skipped: **the tilt cannot be written onto the artwork.** `body.beat-live .track-art` already runs `art-beat-pulse` (animating `.track-art`'s `transform`) and `body.beat-live .art-light` runs `art-light-beat` (animating the lamp's `transform`), while `.cover-art-blur` runs its own 26s `cover-bloom-drift`. A tilt written onto any of those would be overwritten by an animation. So the sleeve and its lamp move into a new `.tilt-stage` element that owns nothing but the tilt, and the control rows stay outside it (chrome should not lean).

**Files:**
- Modify: `ui/index.html` (the `.tilt-stage` wrapper in both art wraps)
- Modify: `ui/style.css` (`@property` registrations, the `:root` transition, `.tilt-stage`, the backdrop parallax)
- Modify: `ui/app.js` (`tiltVector` only — the pure maths)
- Modify: `tools/ui-preview-regression.js` (new section 17)

**Interfaces:**
- Produces: the DOM contract `<div class="tilt-stage">` containing exactly one `.art-light` and one `.track-art`/`.side-art`, one per art wrap, with the `.art-controls` and `.art-player` rows as its **siblings**.
- Produces: `window.tiltVector(clientX, clientY, rect) -> { x, y }` with both in `[-1,1]`, `-1` at the left/top edge, `+1` at the right/bottom, `0` at the centre; a degenerate `rect` (zero width/height) returns `{ x: 0, y: 0 }` via the clamps rather than `NaN`.
- Produces: registered custom properties `--tilt-x` and `--tilt-y` (`syntax: '<number>'`, `inherits: true`, `initial-value: 0`), transitioned on `:root`, and the unregistered `--tilt-amp` multiplier set on the root by Task 4.

- [ ] **Step 1: Write the failing gate assertions**

In `tools/ui-preview-regression.js`, add a new section immediately after section 16:

```js
  // --- 17. cover tilt -----------------------------------------------------
  // The sleeve leans toward the pointer, and the room's blurred artwork
  // counter-moves. It has to lean on a layer of its OWN: the beat animates
  // .track-art's and .art-light's transforms, and the drift owns
  // .cover-art-blur's, so a tilt on either of those would be overwritten.
  setFullscreen(false);
  setMiniMode(false);
  const stages = [...document.querySelectorAll('.tilt-stage')];
  result.tiltStageCount = stages.length;
  if (result.tiltStageCount !== 2) {
    problems.push('expected one tilt stage per art wrap, found ' + result.tiltStageCount);
  }
  result.tiltStageHoldsArt = stages.length === 2 && stages.every((s) =>
    s.querySelectorAll('.art-light').length === 1 &&
    s.querySelectorAll('.track-art, .side-art').length === 1);
  if (!result.tiltStageHoldsArt) {
    problems.push('a tilt stage does not hold exactly one lamp and one artwork');
  }
  // The controls must NOT lean with the sleeve: chrome that tilts reads as broken.
  result.tiltChromeOutsideStage = stages.length === 2 && stages.every((s) =>
    !s.querySelector('.art-controls'));
  if (!result.tiltChromeOutsideStage) problems.push('the control row sits inside the tilt stage');
  result.tiltArtZ = stages.length === 2 ? stages.map((s) => {
    const art = s.querySelector('.track-art, .side-art');
    const lamp = s.querySelector('.art-light');
    return getComputedStyle(art).zIndex + '/' + getComputedStyle(lamp).zIndex;
  }) : [];
  result.tiltArtOverLamp = result.tiltArtZ.length === 2 &&
    result.tiltArtZ.every((pair) => pair === '1/0');
  if (!result.tiltArtOverLamp) {
    problems.push('the artwork no longer paints above its lamp: ' + result.tiltArtZ.join(' '));
  }

  result.tiltVectorEdges = [
    tiltVector(0, 0, { left: 0, top: 0, width: 100, height: 100 }),
    tiltVector(100, 100, { left: 0, top: 0, width: 100, height: 100 }),
    tiltVector(50, 50, { left: 0, top: 0, width: 100, height: 100 }),
  ];
  result.tiltVectorEdgesOk =
    result.tiltVectorEdges[0].x === -1 && result.tiltVectorEdges[0].y === -1 &&
    result.tiltVectorEdges[1].x === 1 && result.tiltVectorEdges[1].y === 1 &&
    result.tiltVectorEdges[2].x === 0 && result.tiltVectorEdges[2].y === 0;
  if (!result.tiltVectorEdgesOk) {
    problems.push('tiltVector is wrong at the edges: ' + JSON.stringify(result.tiltVectorEdges));
  }
  const clamped = tiltVector(-500, 900, { left: 0, top: 0, width: 100, height: 100 });
  result.tiltVectorClamped = clamped.x === -1 && clamped.y === 1;
  if (!result.tiltVectorClamped) {
    problems.push('tiltVector does not clamp: ' + JSON.stringify(clamped));
  }
  const degenerate = tiltVector(10, 10, { left: 0, top: 0, width: 0, height: 0 });
  result.tiltVectorDegenerate = Number.isFinite(degenerate.x) && Number.isFinite(degenerate.y);
  if (!result.tiltVectorDegenerate) problems.push('tiltVector returns NaN for a zero-size rect');

  const tiltSheet = [...document.styleSheets].flatMap((sheet) => {
    try { return [...sheet.cssRules]; } catch (e) { return []; }
  });
  result.tiltRegistered = ['--tilt-x', '--tilt-y'].every((name) =>
    tiltSheet.some((r) => r.constructor.name === 'CSSPropertyRule' && r.name === name &&
      r.syntax === '<number>'));
  if (!result.tiltRegistered) problems.push('--tilt-x/--tilt-y are not registered <number>s');
  result.tiltTransition = tiltSheet.some((r) =>
    r.selectorText === ':root' && /--tilt-x/.test(r.style ? r.style.cssText : ''));
  if (!result.tiltTransition) problems.push('the tilt does not ease with the track');
  result.tiltBackdropParallax = tiltSheet.some((r) => r.selectorText === '.cover-art-blur' &&
    /translate/.test(r.style ? r.style.cssText : '') && /--tilt-x/.test(r.style.cssText));
  if (!result.tiltBackdropParallax) problems.push('the room does not counter-move with the tilt');
  const stageRules = tiltSheet.filter((r) => r.selectorText &&
    /tilt-stage/.test(r.selectorText));
  const stageText = stageRules.map((r) => r.selectorText + '{' + (r.style ? r.style.cssText : '') + '}').join('\n');
  result.tiltStageOwnsTransform = /\{/.test(stageText) && /transform[^;]*--tilt-x/.test(stageText);
  if (!result.tiltStageOwnsTransform) problems.push('the tilt stage does not read --tilt-x');
  result.tiltReducedNeutral = /\.reduce-motion[^{]*\.tilt-stage[^{]*\{[^}]*transform:\s*none/.test(stageText) ||
    tiltSheet.some((r) => r.selectorText && /\.reduce-motion[^{]*\.tilt-stage/.test(r.selectorText) &&
      /transform:\s*none/.test(r.style ? r.style.cssText : ''));
  if (!result.tiltReducedNeutral) problems.push('reduced motion does not rest the tilt');
```

- [ ] **Step 2: Run the gate and watch it fail**

Expected: FAIL with `expected one tilt stage per art wrap, found 0`, `tiltVector is not defined`, and `--tilt-x/--tilt-y are not registered <number>s`.

- [ ] **Step 3: Add the stage to both art wraps**

In `ui/index.html`, in `.float-art-wrap`, wrap the lamp and the image:

```html
      <div class="float-art-wrap" id="float-art-wrap">
        <!-- The tilt stage: the sleeve and its lamp in one block, so the pointer
             tilt has a layer of its own. It has to be its own element — the beat
             animates .track-art's transform (art-beat-pulse) and the lamp's
             (art-light-beat), so a tilt written onto either would be overwritten.
             The control and transport rows are deliberately OUTSIDE it: chrome
             that leans with the sleeve reads as broken, not as depth. -->
        <div class="tilt-stage">
          <!-- The beat's lamp: the sleeve's own light, in the artwork's colour — see
               the long note in style.css. It sits behind the image at z-index 0 and
               spreads a third of its size past the art on every side, which is why
               neither this stage nor the wrapper may clip it. -->
          <div class="art-light" aria-hidden="true"></div>
          <img id="track-art" class="track-art" alt="" draggable="false">
        </div>
```

Keep the existing `.art-controls` and `.art-player` exactly where they are (now siblings of `.tilt-stage`).

Then the same in `.side-art-wrap`:

```html
      <div class="side-art-wrap">
        <div class="tilt-stage">
          <div class="art-light" aria-hidden="true"></div>
          <img id="side-art" class="side-art" alt="" draggable="false">
        </div>
```

- [ ] **Step 4: Register the tilt numbers and the root transition**

In `ui/style.css`, directly after the `@property --dust-op` rule from Task 2, add:

```css
/* The sleeve's lean, in -1..1 from the pointer. Registered as numbers so the lean
   EASES and releases through a transition on the root rather than snapping — the
   same mechanism --art-accent and --beat-strength already use. */
@property --tilt-x {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}

@property --tilt-y {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}
```

Then extend the `:root` transition rule (which Task 2 already extended once) to read:

```css
:root {
  transition: --art-accent 1.6s var(--ease-fluid),
              --dust-op var(--dur-4) var(--ease-fluid),
              --tilt-x var(--dur-2) var(--ease-out),
              --tilt-y var(--dur-2) var(--ease-out);
}
```

`--dur-2` rather than `--dur-3`: the value is published on every pointer move, so it must settle behind the pointer rather than trail it.

- [ ] **Step 5: Style the stage and the parallax**

In `ui/style.css`, directly after the `body.mini .dust-field, .reduce-motion .dust-field` rule from Task 2, add:

```css
/* =========================================================
   Cover tilt
   The sleeve leans toward the pointer; the room's blurred artwork counter-moves a
   little behind it. The tilt lives on a stage of its own because every other
   transform in this corner is spoken for (see the markup note). `--tilt-amp` is
   the setting's multiplier, so Off is the same code path at zero rather than a
   second set of rules.
   ========================================================= */
.tilt-stage {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  transform: perspective(760px)
             rotateX(calc(var(--tilt-y, 0) * -2.4deg * var(--tilt-amp, 1)))
             rotateY(calc(var(--tilt-x, 0) * 2.4deg * var(--tilt-amp, 1)));
  will-change: transform;
}

/* Reduced motion gets an untransformed box outright, whatever the numbers say. */
.reduce-motion .tilt-stage {
  transform: none;
  will-change: auto;
}

.reduce-motion .cover-art-blur {
  translate: none;
}
```

Then extend the existing `.cover-art-blur` rule in `ui/style.css` (the one carrying `inset: calc(-2 * var(--bg-blur))` and `transition: opacity 1.4s ease;`) by adding, immediately after its `z-index: 1;` declaration:

```css
  /* The room counter-moves against the sleeve's lean: a few pixels the opposite
     way is enough to read as the sleeve standing proud of the wall behind it.
     `translate` is a SEPARATE property from the drift's transform, so the 26s
     cover-bloom-drift keeps owning the transform untouched. */
  translate: calc(var(--tilt-x, 0) * -12px) calc(var(--tilt-y, 0) * -8px);
```

The existing `transition: opacity 1.4s ease;` and `will-change: opacity, transform;` declarations are left exactly as they are: the lean eases on the root (`:root`'s `--tilt-x` transition), so no transition on `translate` is needed or wanted.

- [ ] **Step 6: Add the pure tilt maths**

In `ui/app.js`, directly after `cycleAmbient()` from Task 2, insert:

```js
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
```

- [ ] **Step 7: Run the gate**

Expected: PASS with `tiltStageCount: 2`, `tiltStageHoldsArt: true`, `tiltChromeOutsideStage: true`, `tiltArtZ: ["1/0","1/0"]`, `tiltVectorEdgesOk: true`, `tiltVectorClamped: true`, `tiltVectorDegenerate: true`, `tiltRegistered: true`, `tiltTransition: true`, `tiltBackdropParallax: true`, `tiltStageOwnsTransform: true`, `tiltReducedNeutral: true`.

If `tiltArtZ` reports anything other than `1/0`, the `border-radius`/`z-index` chain inside the stage is wrong — `.float-art-wrap .track-art` and `.side-art` must keep `position: relative; z-index: 1`, and `.art-light` must keep `z-index: 0`.

- [ ] **Step 8: Confirm nothing regressed**

Run the gate at all five viewports and confirm section 14 still passes (`lampCount`, `lampZ`, `artOverLamp`, `lampFollowsAccent`) — the stage refactor must not have moved the lamp or the artwork's stacking level.

- [ ] **Step 9: Checkpoint — do not commit**

```bash
git status --short
git diff --stat -- ui/index.html ui/style.css ui/app.js tools/ui-preview-regression.js
```

---

### Task 4: Cover tilt — the pointer and the row

**Files:**
- Modify: `ui/index.html` (the Visuals panel row)
- Modify: `ui/app.js` (the mode + pointer engine; `syncSettingsPanel`; the boot restore; `applyMotionPreference`; `applyMiniState`)
- Modify: `tools/ui-preview-regression.js` (extend section 17)

**Interfaces:**
- Consumes: `tiltVector`, the `--tilt-x`/`--tilt-y`/`--tilt-amp` contract (Task 3), `Settings`, `setValueText`, `reducedMotion`, `miniMode`.
- Produces: `setTilt(x, y)`, `resetTilt()`, `applyTiltMode()`, `initArtTilt()`, `cycleTilt()`, `TILT_MODES = ['on','bold','off']`, `TILT_LABELS`, `TILT_AMP = {on: 0.7, bold: 1.2}`, `tiltMode` (default `'on'`).
- Produces: the DOM contract `#qp-tilt` / `#qp-tilt-state`, and the persisted key `tiltMode` under `sl_tiltMode`.

- [ ] **Step 1: Write the failing gate assertions**

In `tools/ui-preview-regression.js`, append to section 17 (after the `tiltReducedNeutral` check from Task 3):

```js
  // The pointer publishes the lean; leaving the art releases it. Both are driven
  // through a real event on the wrap, because that is what the app listens for.
  const tiltRoot = document.documentElement;
  const tiltWrap = document.getElementById('float-art-wrap');
  const tiltRect = tiltWrap ? tiltWrap.getBoundingClientRect() : null;
  const tiltRead = () => [
    tiltRoot.style.getPropertyValue('--tilt-x'),
    tiltRoot.style.getPropertyValue('--tilt-y'),
  ];
  result.tiltWrapVisible = !!tiltRect && tiltRect.width > 0 && tiltRect.height > 0;
  if (!result.tiltWrapVisible) problems.push('the compact art is not measurable for the tilt');
  const savedTiltMode = tiltMode;
  if (tiltMode === 'off') cycleTilt();
  if (tiltRect && tiltRect.width > 0) {
    tiltWrap.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: tiltRect.right - 2,
      clientY: tiltRect.bottom - 2,
    }));
    result.tiltBottomRight = tiltRead().map((v) => parseFloat(v));
    tiltWrap.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      clientX: tiltRect.left + 2,
      clientY: tiltRect.top + 2,
    }));
    result.tiltTopLeft = tiltRead().map((v) => parseFloat(v));
    tiltWrap.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    result.tiltAfterLeave = tiltRead().map((v) => parseFloat(v));
  } else {
    result.tiltBottomRight = null;
    result.tiltTopLeft = null;
    result.tiltAfterLeave = null;
  }
  result.tiltFollowsPointer =
    !!result.tiltBottomRight && !!result.tiltTopLeft &&
    result.tiltBottomRight[0] > 0.5 && result.tiltBottomRight[1] > 0.5 &&
    result.tiltTopLeft[0] < -0.5 && result.tiltTopLeft[1] < -0.5;
  if (!result.tiltFollowsPointer) {
    problems.push('the sleeve does not follow the pointer: ' +
      JSON.stringify([result.tiltTopLeft, result.tiltBottomRight]));
  }
  result.tiltLeaveResets =
    !!result.tiltAfterLeave &&
    Math.abs(result.tiltAfterLeave[0]) < 0.001 && Math.abs(result.tiltAfterLeave[1]) < 0.001;
  if (!result.tiltLeaveResets) {
    problems.push('leaving the art does not release the lean: ' + JSON.stringify(result.tiltAfterLeave));
  }

  // Off is the same code path at zero: the multiplier is 0 and a pointer move
  // publishes nothing.
  while (tiltMode !== 'off') cycleTilt();
  result.tiltAmpOff = tiltRoot.style.getPropertyValue('--tilt-amp');
  if (result.tiltAmpOff !== '0') problems.push('Cover tilt Off leaves an amplitude: ' + result.tiltAmpOff);
  resetTilt();
  if (tiltRect && tiltRect.width > 0) {
    tiltWrap.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: tiltRect.right - 2, clientY: tiltRect.bottom - 2,
    }));
  }
  result.tiltOffNeutral = tiltRead().every((v) => parseFloat(v) === 0);
  if (!result.tiltOffNeutral) problems.push('the sleeve leans while Cover tilt is Off');

  // ...and the row cycles the same three states as the rest of the family.
  const tiltRow = document.getElementById('qp-tilt');
  const tiltState = document.getElementById('qp-tilt-state');
  result.tiltRow = !!tiltRow && !!tiltState;
  if (!result.tiltRow) problems.push('no Cover tilt row');
  const tiltSeen = [];
  if (tiltRow && tiltState) {
    for (let i = 0; i < 3; i++) {
      tiltRow.click();
      tiltSeen.push(tiltState.textContent.trim());
    }
    result.tiltRowCycles = tiltSeen;
    if (JSON.stringify(tiltSeen) !== JSON.stringify(['Subtle', 'Bold', 'Off'])) {
      problems.push('the Cover tilt row cycles ' + tiltSeen.join(',') +
        ' (expected Subtle,Bold,Off from Off)');
    }
  }
  result.tiltPersisted = (() => {
    try { return localStorage.getItem('sl_tiltMode'); } catch (e) { return '(unavailable)'; }
  })();

  // leave the app in the state the checks started from
  tiltMode = savedTiltMode;
  applyTiltMode();
  resetTilt();
```

- [ ] **Step 2: Run the gate and watch it fail**

Expected: FAIL with `tiltVector`-independent failures — `no Cover tilt row` and `the sleeve does not follow the pointer: [null,null]`.

- [ ] **Step 3: Add the row**

In `ui/index.html`, in `#qp-panel-visuals`, insert directly after the `#qp-ambient` button from Task 2:

```html
              <button class="qp-row qp-action" id="qp-tilt" onclick="cycleTilt()">
                <span class="qp-label">Cover tilt</span>
                <span class="qp-state" id="qp-tilt-state">Subtle</span>
              </button>
```

- [ ] **Step 4: Add the mode and the pointer engine**

In `ui/app.js`, directly after `window.tiltVector = tiltVector;` from Task 3, insert:

```js
const TILT_MODES = ['on', 'bold', 'off'];
const TILT_LABELS = { on: 'Subtle', bold: 'Bold', off: 'Off' };
// A lean is read at a glance, so the two live states are close together: Bold is
// about the most a square of artwork can lean before it reads as falling over.
const TILT_AMP = { on: 0.7, bold: 1.2 };
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
  document.documentElement.style.setProperty('--tilt-amp', String(TILT_AMP[tiltMode] || 0));
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
```

- [ ] **Step 5: Release the lean on the two paths that remove the art**

In `ui/app.js`, in `applyMotionPreference()`, extend the reduced-motion branch so it reads:

```js
  document.documentElement.classList.toggle('reduce-motion', reducedMotion);
  if (reducedMotion) clearSwayTransforms();
  if (reducedMotion) resetTilt();
  if (reducedMotion) stopBeatEngine(); else startBeatEngine();
  if (reducedMotion) stopMomentEngine(); else startMomentEngine();
  syncSettingsPanel();
```

And in `applyMiniState()`, add `resetTilt();` alongside the other resets so a lean cannot survive into (or out of) mini:

```js
function applyMiniState() {
  document.body.classList.toggle('mini', miniMode);
  setMiniBarRevealed(false);   // every entry starts as pure lyrics
  resetTilt();                 // the card is going away; its lean goes with it
  syncWindowDrag();   // the mini bar is a drag surface too
  syncLyricsClearance();
  wakeRenderLoop();   // entering/leaving mini animates the scroller's padding
}
```

`resetTilt` is a top-level `function` declaration, so it is hoisted and callable from `applyMiniState`/`applyMotionPreference` even though they are defined earlier in the file.

- [ ] **Step 6: Wire `syncSettingsPanel` and the boot restore**

In `ui/app.js`, in `syncSettingsPanel()`, directly after the `qp-ambient-state` line from Task 2, add:

```js
  setValueText(document.getElementById('qp-tilt-state'), TILT_LABELS[tiltMode] || 'Subtle');
```

In the boot preferences block, directly after the `ambientMode` restore from Task 2, add:

```js
  const savedTiltMode = Settings.get('tiltMode', 'on');
  if (TILT_MODES.includes(savedTiltMode)) tiltMode = savedTiltMode;
```

And in the boot call list, directly after `applyAmbientMode();` from Task 2, add:

```js
applyTiltMode();
initArtTilt();
```

- [ ] **Step 7: Run the gate**

Expected: PASS with `tiltFollowsPointer: true`, `tiltTopLeft: [-1,-1]`, `tiltBottomRight: [1,1]`, `tiltAfterLeave: [0,0]`, `tiltAmpOff: "0"`, `tiltOffNeutral: true`, `tiltRowCycles: ["Subtle","Bold","Off"]`, `tiltPersisted: "off"`.

Note: the row-cycle assertion expects the sequence to *start* at Off because the preceding block walked the mode to Off; if you reorder the assertions, keep that invariant.

- [ ] **Step 8: Look at it**

Windowed, move the pointer across the sleeve: it should lean toward the pointer and settle as it stops, with the blurred room sliding the opposite way. Repeat in fullscreen split layout (the side panel's art). Set **Cover tilt: Off** and confirm the sleeve is rigid at every pointer position.

- [ ] **Step 9: Checkpoint — do not commit**

```bash
git status --short
git diff --stat -- ui/index.html ui/app.js tools/ui-preview-regression.js
```

---

### Task 5: The full pass, and the docs

**Files:**
- Modify: `README.md`
- Modify: `tools/ui-preview-regression.js` (docblock item 11)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Syntax-check both JS files**

```bash
node --check ui/app.js
node --check tools/ui-preview-regression.js
```

Expected: no output from either.

- [ ] **Step 2: Host tests (must be untouched)**

```bash
python -m unittest discover -s tests
```

Expected: `OK` at the current count (389). Any change in this number means a Python file was touched, which this plan forbids.

- [ ] **Step 3: Run the gate at all five viewports**

Serve the repo and, in one call per viewport:

```js
const src = await (await fetch('/tools/ui-preview-regression.js')).text();
window.run = new Function(src + '\nreturn run;')();
await window.run('1400x900');
```

Repeat for `900x700`, `800x600`, `360x420`, `330x380`.

Expected: PASS at all five, with the new keys present in every result. Pay particular attention to `settingsHints` (must stay `4`), `settingsTabGroups.visuals` (must stay `['Motion']`), `settingsFits` (must stay `true` — the sheet scrolls internally, so two more rows must not push it past the window), and `settingsLabelAlignedWithTitle`.

- [ ] **Step 4: Update the docblock**

In `tools/ui-preview-regression.js`, in the header comment's numbered list, directly after item 10, add:

```js
 *  11. Room air and cover tilt: the motes are laid out deterministically and are
 *      tinted with the album's colour, the air never takes a pointer event, and
 *      Off / reduced motion / the mini player leave the room stock; and the
 *      sleeve leans only because its own stage carries the tilt, with the beat's
 *      surfaces and the artwork's stacking order untouched.
```

- [ ] **Step 5: README — feature copy**

In `README.md`, in the visual/design feature list (beside the **Beat pulse** and **Reduced motion** bullets), add:

```markdown
  - **Room air:** a handful of motes of the album's own colour drift through the room — the app's only effect that is on in a silent passage too, which is what stops a calm verse reading as a frozen frame. The beat nudges the whole body of air on the same grid and at the same strength the pulse uses, and a drop puffs it outward while the hit is open. **Room air** in the settings cycles Subtle / Bold / Off, and Off, reduced motion and the mini player leave the room completely still.
  - **Cover tilt:** the sleeve leans a degree or two toward the pointer and eases back as it stops, while the blurred artwork behind it counter-moves a little — the room gains depth without a single lyric moving. It runs on a layer of its own, so the beat's pulse on the artwork and the backdrop's slow drift are untouched. **Cover tilt** cycles Subtle / Bold / Off, and reduced motion rests it.
```

- [ ] **Step 6: README — reduced motion bullet**

In `README.md`, extend the **Reduced motion** bullet so its list of what stops includes the two new effects. Replace:

```markdown
  - **Reduced motion:** honours the OS preference by default and is toggleable in the panel. Decorative motion (backdrop drift, pulsing dots, word variants, type specials) stops; the lyric fill is always kept, because it carries information.
```

with:

```markdown
  - **Reduced motion:** honours the OS preference by default and is toggleable in the panel. Decorative motion (backdrop drift, room air, cover tilt, pulsing dots, word variants, type specials) stops; the lyric fill is always kept, because it carries information.
```

- [ ] **Step 7: README — smoke checklist**

In `README.md`'s **Manual Smoke Checklist**, after the beat-pulse item, add:

```markdown
- [ ] Room air: on a quiet ballad the motes drift continuously and lift a little on each beat; on a track with a drop they puff outward while it is open. **Settings → Visuals → Room air: Off** leaves the room completely still, and the mini player shows no air at all.
- [ ] Cover tilt: moving the pointer across the sleeve leans it toward the pointer and the blurred room slides the other way, in both the windowed card and the fullscreen split panel; the control row does **not** lean. **Cover tilt: Off** makes the sleeve rigid again, and turning Motion to Reduced rests it.
```

- [ ] **Step 8: Verify the README gate keys still hold**

Re-run the gate once at 1400×900 and 330×380 to confirm nothing in the docs pass touched behaviour (it should not have — the docs pass edits only `README.md` and the gate's own comment).

- [ ] **Step 9: Checkpoint — do not commit**

```bash
git status --short
git diff --stat
```

Expected: the five files this plan names (`ui/index.html`, `ui/app.js`, `ui/style.css`, `tools/ui-preview-regression.js`, `README.md`) plus whatever the working tree already carried before this plan began. Nothing is committed.

---

## Ideas considered and parked

Four effects were proposed alongside these two and deliberately not planned. Each is recorded so a later pass does not have to rediscover the reasoning:

- **Sleeve ripple on a drop.** A ring of accent light expanding out of the artwork. Strong, but it needs a drop *arrival* (an attack edge), and `momentPlan` is the only arrival source — tying the ripple to it would make the effect disappear whenever **Big moments** is Off. Parked until an arrival can be read from the beat plan directly rather than from the moments engine.
- **Intensity-led grain and chroma.** Lifting `.noise-overlay`'s opacity with `--beat-strength` is nearly free, but a chroma bloom on the blurred backdrop means a `filter` change on the single most expensive layer in the app — the exact cost the beat pulse was designed to avoid. Parked as a trade, not a task.
- **Sleeve progress ring.** A `conic-gradient` ring on the artwork driven by a registered `--art-progress`. It is information rather than atmosphere, and the seek affordance already covers it; it belongs in a UI pass with the seek row, not in a lighting pass.
- **Active-line spotlight.** A soft accent pool behind the live line. The line element's `transform`, `opacity` and `filter` are all written inline per depth-of-field tier, so the pool would need a pseudo-element and a careful z-order review against the four existing line animations. Real, but it touches the lyric engine, which this plan deliberately does not.

## Material tradeoffs this plan cannot resolve

- **The air is on during a silent intro.** It is the point of the effect, but a listener who reads the room as "nothing is playing" loses that signal. `Room air: Off` is the answer, and it is one row away.
- **A pointer-driven lean cannot be seen by the preview gate's screenshot path on this host** (screenshots do not composite here), so the lean is verified behaviourally — the published numbers and the computed transform — plus a manual look on Windows.

---

## Production pass (2026-10-01)

The repository had never been prepared to be published. Two of these were defects rather than polish:

- **Agent scratch directories were not ignored.** `.superpowers/` — which includes a `brainstorm/` session directory holding a live credential file, `<TOKEN_PATH_REDACTED>` — was untracked but ready to be swept up by a `git add -A`. Both it and `.freebuff/` are now in `.gitignore`, and `tests/test_config_paths.py` asserts both stay ignored with no tracked files, because an ignore file is the only thing standing between a `git add -A` and a published credential. **`.freebuff/project-id` was already tracked** and `.gitignore` cannot untrack a file, so it was removed from the index with `git rm --cached` — the local file is untouched and the next commit takes it out of the published tree.
- **No `.env.example`.** The only description of the configuration surface was prose in the README's setup step, which is exactly the kind of copy that drifts. `.env.example` now documents the API key and all four optional overrides with their defaults, and the README points at it instead of restating it.
- **No CI.** `.github/workflows/ci.yml` runs the suite on `windows-latest` across Python 3.10–3.13 (the app is Windows-only, so a Linux runner would pass while the code that matters was never exercised), plus a `compileall` gate for modules no test imports, plus `node --check` on both JS files in a second job.
- **No version, and no license.** `config.py` now carries `APP_VERSION` as the single source of truth, separate from `PARSER_VERSION` (which versions the cached-payload format and moves on its own schedule). It is reported in the resolve report as an `App` row, next to `Parser`, so a pasted report names the build it came from; the gate asserts the row renders and a test asserts the dict carries it. The repository is now **MIT-licensed** (the owner's choice), the README carries a license section that also says plainly that the lyrics are fetched at runtime and not bundled, and the clone line reads `<the URL you got this from>` rather than a username that does not exist — it becomes a real URL, and the CI badge becomes possible, the day the repository is published.
- **The tilt runs at `--dur-2`, not `--dur-3`.** A longer ease looks heavier in a still frame but trails the pointer in motion, which reads as lag rather than weight. If it feels twitchy on the real machine, that one token is the single knob.
- **`--dust-surge` is a constant.** A harder drop puffs the air further only through `--beat-strength`; the phase's own level is not published as a variable, and adding a per-frame publish for one amplitude was not worth a new path through the render loop.
