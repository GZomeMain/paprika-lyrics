/**
 * Paprika Advanced Customization Modules
 * ui/customization_modules.js
 *
 * Implements high-performance, modular customization extensions:
 * 1. DynamicTypographyModule: Line & syllable-level typography, DoF rendering,
 *    backing vocals, ad-libs, chorus accents, kinetic syllable stretch & pop,
 *    variable font axes, and dual-font hierarchy.
 * 2. AudioReactiveSyncModule: Target registry for beat-reactive elements,
 *    spring physics, and multi-element synchronized kinetic motion.
 * 3. PluggableParticleEngine: Zero-allocation recycled particle pool,
 *    pluggable particle types (motes, stars, ripples, bokeh, fireflies, vinyl),
 *    and airPipeline bridge.
 * 4. BreakdownStasisController: Timeline gap monitoring (>=4.5s), ambient stasis
 *    dimming, particle/spring dampening, and smooth anticipation ramping.
 * 5. ArtworkPhysicsController: Realistic rotational inertia deceleration/acceleration
 *    (33 RPM) and dynamic geometric shape morphing.
 *
 * Designed for locked 60/120Hz performance with zero runtime garbage collection.
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helper Utilities
  // ---------------------------------------------------------------------------

  function isObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function safeQuery(targetOrSelector) {
    if (!targetOrSelector) return null;
    if (typeof targetOrSelector !== 'string') {
      return (targetOrSelector.nodeType === 1 || targetOrSelector.style) ? targetOrSelector : null;
    }
    if (typeof document === 'undefined') return null;
    return document.querySelector(targetOrSelector);
  }

  // Pseudo-random deterministic hash for organic particle variations
  function dustHash(index, seed) {
    const x = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453123;
    return x - Math.floor(x);
  }

  // ===========================================================================
  // 1. DynamicTypographyModule
  // ===========================================================================

  class DynamicTypographyModule {
    constructor(customization) {
      this.domain = 'lyrics';
      this.customization = customization || (typeof window !== 'undefined' ? window.customization : null);

      // Default typography options
      this.options = {
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        fontFamilySecondary: 'inherit',
        fontFamilyAdlib: 'inherit',
        fontSize: 30,
        fontWeight: 700,
        letterSpacing: '0.01em',
        lineHeight: 1.44,
        fontStretch: 'normal',
        bevelStroke: 'none',
        textShadow: 'none',

        // Active line dynamic kinetics & styling
        activeScale: 1.05,
        activeOffsetX: 2,
        activeOffsetY: 0,
        activeWeight: 800,
        activeColor: '#ffffff',
        activeGlow: 0.4,
        activeGlowColor: 'var(--art-accent, rgba(255, 255, 255, 0.5))',

        // Kinetic typography axes & effects
        syllableStretchEnabled: true,
        syllablePopEnabled: true,
        gradientWipeEnabled: true,
        variableFontWeightActive: 780,
        variableFontWidthActive: 115,

        // Secondary / Backing vocal tier
        secondaryOpacity: 0.65,
        secondaryScale: 0.75,
        secondaryFontSize: 20,
        backingVocalStyle: 'italic',

        // Ad-lib styling
        adlibStyle: 'italic',
        adlibScale: 0.70,
        adlibOpacity: 0.70,

        // Chorus styling
        chorusWeight: 800,
        chorusLetterSpacing: '-0.01em',
        chorusGlow: true,

        // Depth of field tier metrics
        idleOpacity: 0.35,
        idleScale: 0.965,
        nearOpacity: 0.45,
        nearScale: 0.98,
        nearBlur: 1,
        midOpacity: 0.22,
        midScale: 0.955,
        farOpacity: 0.10,
        farScale: 0.935,
        passedOpacity: 0.35,

        // Alignment, Dock & Spacing
        alignment: 'left',
        orientation: 'horizontal',
        lyricsDock: 'center',
        lyricsOffsetX: 0,
        lyricsOffsetY: 0,
        lineGap: 28,
        scrollInertiaMode: 'springy'
      };

      this._initialized = false;
      this._boundOnChange = this._handleCustomizationChange.bind(this);

      if (this.customization) {
        this.init(this.customization);
      }
    }

    init(customization) {
      this.customization = customization;
      if (!this.customization) return;

      this._registerSchema();
      this._syncFromCustomization();

      // Subscribe to reactive events from customization EventBus
      if (typeof this.customization.on === 'function') {
        this.customization.on('change:lyrics', this._boundOnChange);
        this.customization.on('change:layout', this._boundOnChange);
        this.customization.on('change', this._boundOnChange);
        this.customization.on('preset:applied', this._boundOnChange);
        this.customization.on('reset', this._boundOnChange);
      }

      this._initialized = true;
    }

    _registerSchema() {
      if (!this.customization || !this.customization.registry) return;
      const reg = this.customization.registry;

      const propsToRegister = [
        {
          key: 'syllable_stretch_enabled',
          def: {
            type: 'boolean',
            default: true,
            label: 'Elastic Vowel Stretch on Long Notes'
          }
        },
        {
          key: 'syllable_pop_enabled',
          def: {
            type: 'boolean',
            default: true,
            label: 'Singing Impact Pop Animation'
          }
        },
        {
          key: 'font_family_secondary',
          def: {
            type: 'string',
            default: 'inherit',
            cssVar: '--cust-font-secondary',
            label: 'Secondary Vocals Font Family'
          }
        },
        {
          key: 'font_family_adlib',
          def: {
            type: 'string',
            default: 'inherit',
            cssVar: '--cust-font-adlib',
            label: 'Ad-lib / Harmony Font Family'
          }
        },
        {
          key: 'gradient_wipe_enabled',
          def: {
            type: 'boolean',
            default: true,
            label: 'Dynamic Gradient Wipe'
          }
        },
        {
          key: 'variable_font_weight_active',
          def: {
            type: 'number',
            default: 780,
            min: 100,
            max: 900,
            step: 10,
            label: 'Active Variable Font Weight'
          }
        },
        {
          key: 'variable_font_width_active',
          def: {
            type: 'number',
            default: 115,
            min: 50,
            max: 200,
            step: 5,
            label: 'Active Variable Font Width'
          }
        },
        {
          key: 'activeOffsetX',
          def: {
            type: 'number',
            default: 2,
            min: -30,
            max: 30,
            step: 1,
            unit: 'px',
            cssVar: '--cust-lyric-active-offset-x',
            label: 'Active Line Offset X'
          }
        },
        {
          key: 'activeOffsetY',
          def: {
            type: 'number',
            default: 0,
            min: -30,
            max: 30,
            step: 1,
            unit: 'px',
            cssVar: '--cust-lyric-active-offset-y',
            label: 'Active Line Offset Y'
          }
        },
        {
          key: 'activeWeight',
          def: {
            type: 'number',
            default: 800,
            min: 100,
            max: 900,
            step: 100,
            cssVar: '--cust-lyric-active-weight',
            label: 'Active Font Weight'
          }
        },
        {
          key: 'fontStretch',
          def: {
            type: 'select',
            options: ['ultra-condensed', 'condensed', 'semi-condensed', 'normal', 'semi-expanded', 'expanded', 'ultra-expanded'],
            default: 'normal',
            cssVar: '--cust-lyric-font-stretch',
            label: 'Font Stretch / Width'
          }
        },
        {
          key: 'bevelStroke',
          def: {
            type: 'string',
            default: 'none',
            cssVar: '--cust-lyric-bevel-stroke',
            label: 'Bevel / Stroke Effect'
          }
        },
        {
          key: 'textShadow',
          def: {
            type: 'string',
            default: 'none',
            cssVar: '--cust-lyric-text-shadow',
            label: 'Custom Text Shadow'
          }
        },
        {
          key: 'backingVocalStyle',
          def: {
            type: 'select',
            options: ['normal', 'italic'],
            default: 'italic',
            cssVar: '--cust-lyric-backing-style',
            label: 'Backing Vocal Style'
          }
        },
        {
          key: 'backingVocalScale',
          def: {
            type: 'number',
            default: 0.92,
            min: 0.6,
            max: 1.2,
            step: 0.02,
            cssVar: '--cust-lyric-backing-scale',
            label: 'Backing Vocal Scale'
          }
        },
        {
          key: 'adlibStyle',
          def: {
            type: 'select',
            options: ['normal', 'italic', 'oblique'],
            default: 'italic',
            cssVar: '--cust-lyric-adlib-style',
            label: 'Ad-lib Style'
          }
        },
        {
          key: 'adlibScale',
          def: {
            type: 'number',
            default: 0.90,
            min: 0.6,
            max: 1.2,
            step: 0.02,
            cssVar: '--cust-lyric-adlib-scale',
            label: 'Ad-lib Scale'
          }
        },
        {
          key: 'chorusWeight',
          def: {
            type: 'number',
            default: 800,
            min: 100,
            max: 900,
            step: 100,
            cssVar: '--cust-lyric-chorus-weight',
            label: 'Chorus Font Weight'
          }
        },
        {
          key: 'chorusGlow',
          def: {
            type: 'boolean',
            default: true,
            label: 'Chorus Subtle Glow Accent'
          }
        },
        {
          key: 'scroll_inertia_mode',
          def: {
            type: 'select',
            options: ['springy', 'smooth', 'subtle', 'off'],
            default: 'springy',
            cssVar: '--cust-scroll-inertia-mode',
            label: 'Scroll Inertia Animation Mode'
          }
        },
        {
          key: 'secondary_scale',
          def: {
            type: 'number',
            default: 0.75,
            min: 0.40,
            max: 1.00,
            step: 0.02,
            cssVar: '--cust-lyrics-secondary-scale',
            label: 'Secondary Vocals Font Scale'
          }
        },
        {
          key: 'adlib_scale',
          def: {
            type: 'number',
            default: 0.70,
            min: 0.40,
            max: 1.00,
            step: 0.02,
            cssVar: '--cust-lyrics-adlib-scale',
            label: 'Ad-lib & Harmony Font Scale'
          }
        }
      ];

      for (const item of propsToRegister) {
        if (!reg.getProperty('lyrics', item.key)) {
          reg.registerProperty('lyrics', item.key, item.def);
        }
      }
    }

    _handleCustomizationChange() {
      this._syncFromCustomization();
    }

    _syncFromCustomization() {
      if (!this.customization) return;

      const lyricsState = (typeof this.customization.get === 'function')
        ? (this.customization.get('lyrics') || {})
        : {};
      const layoutState = (typeof this.customization.get === 'function')
        ? (this.customization.get('layout') || {})
        : {};

      const getVal = (camelKey, snakeKey, defVal, source = lyricsState) => {
        if (source[camelKey] !== undefined) return source[camelKey];
        if (source[snakeKey] !== undefined) return source[snakeKey];
        return defVal;
      };

      this.options.fontFamily = getVal('fontFamily', 'font_family', this.options.fontFamily);
      this.options.fontFamilySecondary = getVal('fontFamilySecondary', 'font_family_secondary', this.options.fontFamilySecondary);
      this.options.fontFamilyAdlib = getVal('fontFamilyAdlib', 'font_family_adlib', this.options.fontFamilyAdlib);
      this.options.fontWeight = Number(getVal('fontWeight', 'font_weight', this.options.fontWeight));
      this.options.fontSize = Number(getVal('fontSize', 'font_size', this.options.fontSize));

      const rawLetterSpacing = getVal('letterSpacing', 'letter_spacing', this.options.letterSpacing);
      this.options.letterSpacing = typeof rawLetterSpacing === 'number'
        ? `${rawLetterSpacing}em`
        : String(rawLetterSpacing);

      this.options.fontStretch = getVal('fontStretch', 'font_stretch', this.options.fontStretch);
      this.options.bevelStroke = getVal('bevelStroke', 'bevel_effect', this.options.bevelStroke);
      this.options.textShadow = getVal('textShadow', 'text_shadow', this.options.textShadow);

      this.options.activeScale = Number(getVal('activeScale', 'active_scale', this.options.activeScale));
      this.options.activeOffsetX = Number(getVal('activeOffsetX', 'active_offset_x', this.options.activeOffsetX));
      this.options.activeOffsetY = Number(getVal('activeOffsetY', 'active_offset_y', this.options.activeOffsetY));
      this.options.activeWeight = Number(getVal('activeWeight', 'active_weight', this.options.activeWeight));
      this.options.activeGlow = Number(getVal('glowStrength', 'active_glow', this.options.activeGlow));
      this.options.activeGlowColor = getVal('glowColor', 'active_glow_color', this.options.activeGlowColor);

      // Kinetic typography
      this.options.syllableStretchEnabled = Boolean(getVal('syllableStretchEnabled', 'syllable_stretch_enabled', this.options.syllableStretchEnabled));
      this.options.syllablePopEnabled = Boolean(getVal('syllablePopEnabled', 'syllable_pop_enabled', this.options.syllablePopEnabled));
      this.options.gradientWipeEnabled = Boolean(getVal('gradientWipeEnabled', 'gradient_wipe_enabled', this.options.gradientWipeEnabled));
      this.options.variableFontWeightActive = Number(getVal('variableFontWeightActive', 'variable_font_weight_active', this.options.variableFontWeightActive));
      this.options.variableFontWidthActive = Number(getVal('variableFontWidthActive', 'variable_font_width_active', this.options.variableFontWidthActive));

      // Tier styling
      this.options.secondaryOpacity = Number(getVal('secondaryOpacity', 'secondary_opacity', this.options.secondaryOpacity));
      this.options.secondaryScale = Number(getVal('secondaryScale', 'secondary_scale', getVal('backingVocalScale', 'backing_vocal_scale', this.options.secondaryScale)));
      this.options.backingVocalStyle = getVal('backingVocalStyle', 'backing_vocal_style', this.options.backingVocalStyle);

      this.options.adlibStyle = getVal('adlibStyle', 'adlib_font_style', this.options.adlibStyle);
      this.options.adlibScale = Number(getVal('adlibScale', 'adlib_scale', this.options.adlibScale));

      this.options.chorusWeight = Number(getVal('chorusWeight', 'chorus_weight', this.options.chorusWeight));
      this.options.chorusGlow = Boolean(getVal('chorusGlow', 'chorus_glow', this.options.chorusGlow));

      this.options.scrollInertiaMode = getVal('scrollInertiaMode', 'scroll_inertia_mode', this.options.scrollInertiaMode);

      this.options.alignment = getVal('alignment', 'lyrics_alignment', this.options.alignment);
      this.options.lineGap = Number(getVal('lineGap', 'line_gap', this.options.lineGap));

      // Layout & Spatial Orientation
      this.options.orientation = getVal('orientation', 'orientation', this.options.orientation, layoutState);
      this.options.lyricsDock = getVal('lyricsDock', 'lyrics_dock', this.options.lyricsDock, layoutState);
      this.options.lyricsOffsetX = Number(getVal('lyricsOffsetX', 'lyrics_offset_x', this.options.lyricsOffsetX, layoutState));
      this.options.lyricsOffsetY = Number(getVal('lyricsOffsetY', 'lyrics_offset_y', this.options.lyricsOffsetY, layoutState));

      const inactiveOp = getVal('inactiveOpacity', 'inactive_opacity', null);
      if (inactiveOp !== null) {
        this.options.idleOpacity = Number(inactiveOp);
        this.options.passedOpacity = Number(inactiveOp);
      }

      this.applyCssVariables();
      this.applyOrientation(this.options.orientation);
      this.applyLyricsDock(this.options.lyricsDock);
    }

    applyCssVariables(targetElement) {
      const el = targetElement || (typeof document !== 'undefined' ? document.documentElement : null);
      if (!el || !el.style) return;

      const style = el.style;
      if (this.options.fontFamily) style.setProperty('--cust-lyric-font-family', this.options.fontFamily);
      if (this.options.fontFamilySecondary && this.options.fontFamilySecondary !== 'inherit') {
        style.setProperty('--cust-font-secondary', this.options.fontFamilySecondary);
      }
      if (this.options.fontFamilyAdlib && this.options.fontFamilyAdlib !== 'inherit') {
        style.setProperty('--cust-font-adlib', this.options.fontFamilyAdlib);
      }
      style.setProperty('--cust-lyric-font-weight', String(this.options.fontWeight));
      style.setProperty('--cust-lyric-letter-spacing', this.options.letterSpacing);
      style.setProperty('--cust-lyric-font-stretch', this.options.fontStretch);
      style.setProperty('--cust-lyric-active-scale', String(this.options.activeScale));
      style.setProperty('--cust-lyric-active-offset-x', `${this.options.activeOffsetX}px`);
      style.setProperty('--cust-lyric-active-offset-y', `${this.options.activeOffsetY}px`);
      style.setProperty('--cust-lyric-active-weight', String(this.options.activeWeight));
      style.setProperty('--cust-lyric-glow-strength', String(this.options.activeGlow));
      style.setProperty('--cust-lyric-glow-color', this.options.activeGlowColor);
      style.setProperty('--cust-lyric-secondary-opacity', String(this.options.secondaryOpacity));
      style.setProperty('--cust-lyric-backing-scale', String(this.options.secondaryScale));
      style.setProperty('--cust-lyrics-secondary-scale', String(this.options.secondaryScale));
      style.setProperty('--cust-lyric-adlib-scale', String(this.options.adlibScale));
      style.setProperty('--cust-lyrics-adlib-scale', String(this.options.adlibScale));
      style.setProperty('--cust-lyric-adlib-style', this.options.adlibStyle);
      style.setProperty('--cust-lyric-chorus-weight', String(this.options.chorusWeight));
      style.setProperty('--cust-scroll-inertia-mode', this.options.scrollInertiaMode);

      // Variable font settings
      style.setProperty('--cust-variable-wght', String(this.options.variableFontWeightActive));
      style.setProperty('--cust-variable-wdth', String(this.options.variableFontWidthActive));

      // Lyrics offsets
      style.setProperty('--cust-lyrics-offset-x', `${this.options.lyricsOffsetX}px`);
      style.setProperty('--cust-lyrics-offset-y', `${this.options.lyricsOffsetY}px`);
    }

    applyOrientation(orientation) {
      if (typeof document === 'undefined') return;
      const root = document.documentElement;
      const body = document.body;
      const mode = orientation || 'horizontal';

      if (root && typeof root.setAttribute === 'function') root.setAttribute('data-orientation', mode);
      if (body && typeof body.setAttribute === 'function') body.setAttribute('data-orientation', mode);
    }

    applyLyricsDock(dock) {
      if (typeof document === 'undefined') return;
      const container = (typeof document.getElementById === 'function') ? document.getElementById('lyrics-container') : null;
      if (container && typeof container.setAttribute === 'function') {
        container.setAttribute('data-lyrics-dock', dock || 'center');
      }
    }

    /**
     * Kinetic Syllable Active Hook:
     * Handles uniform proportional kinetic expansion for sustained notes (>=400ms)
     * and smooth left-to-right wave progression across syllables in multi-syllable words,
     * composing seamlessly with child syllable letter variants without clobbering them,
     * and settling cleanly back to baseline via settleSyllable().
     */
    onSyllableActive(sylDom, duration, ms) {
      if (!sylDom || !sylDom.element) return;
      const el = sylDom.element;
      const dur = duration || sylDom.durationMs || 250;

      // Check if this syllable is part of a multi-syllable word group
      const wordEl = el.parentElement;
      const isMultiSyllableWord = wordEl && wordEl.classList &&
        (typeof wordEl.classList.contains === 'function' && wordEl.classList.contains('word-group')) &&
        wordEl.children && wordEl.children.length > 1;

      if (isMultiSyllableWord) {
        // Multi-syllable word: glide smoothly left-to-right across syllables
        if (el.style) el.style.transformOrigin = 'left center';
        if (el.classList && typeof el.classList.add === 'function') {
          el.classList.add('word-syllable-flow', 'is-active-syl');
        }
        // Smoothly transition prior sibling syllables in this word back to baseline
        const siblings = wordEl.children;
        for (let s = 0; s < siblings.length; s++) {
          if (siblings[s] !== el && siblings[s].classList && typeof siblings[s].classList.remove === 'function') {
            siblings[s].classList.remove('is-active-syl');
          }
        }
      }

      // 1. Kinetic Expansion for sustained/held notes (>=400ms)
      if (dur >= 400 && this.options.syllableStretchEnabled && typeof ms === 'number') {
        const sStart = sylDom.startTimeMs || 0;
        const sEnd = sylDom.endTimeMs || (sStart + dur);
        const progress = clamp((ms - sStart) / Math.max(1, sEnd - sStart), 0, 1);

        if (progress < 1.0) {
          sylDom._isStretching = true;

          // Impactful, proportional expansion (1.10x to 1.20x) based on note sustain length (>=400ms)
          const maxS = clamp(0.10 + ((dur - 400) / 1600) * 0.10, 0.10, 0.20);

          // Smooth vocal attack envelope using smoothstep S-curve (zero abrupt jerk at t=0)
          const attackDuration = Math.min(180, Math.max(100, dur * 0.22));
          const attackProgress = clamp((ms - sStart) / attackDuration, 0, 1);
          const attack = attackProgress * attackProgress * (3 - 2 * attackProgress);

          // Sustained vowel hold with gentle natural harmonic breath
          const breath = 0.96 + 0.04 * Math.sin(progress * Math.PI * 2);

          // Smooth ease out in the final 18% of the note
          const releaseProgress = progress > 0.82 ? clamp((1.0 - progress) / 0.18, 0, 1) : 1.0;
          const release = releaseProgress * releaseProgress * (3 - 2 * releaseProgress);

          const s = maxS * attack * breath * release;

          // UNIFORM proportional scale: scale3d(1 + s, 1 + s, 1)
          if (el.style) {
            el.style.display = 'inline-block';
            el.style.transformOrigin = isMultiSyllableWord ? 'left center' : 'center bottom';
            el.style.transition = 'none'; // frame-exact instantaneous tracking
            const scaleVal = (1 + s).toFixed(4);
            el.style.transform = `scale3d(${scaleVal}, ${scaleVal}, 1)`;
            if (typeof el.style.setProperty === 'function') {
              el.style.setProperty('--syllable-stretch', scaleVal);
            }
          }
        } else {
          // Reached end of note: settle smoothly
          this.settleSyllable(sylDom);
        }
      } else if (dur < 400 && sylDom._isStretching) {
        this.settleSyllable(sylDom);
      }

      // 2. Singing Impact Pop (Subtle optical swell, kept low profile for standalone syllables)
      if (this.options.syllablePopEnabled && sylDom.state !== 'singing' && !sylDom._popped && !isMultiSyllableWord) {
        sylDom._popped = true;
        if (el.classList && typeof el.classList.add === 'function') {
          el.classList.add('syllable-pop');
          setTimeout(() => {
            if (el.classList && typeof el.classList.remove === 'function') {
              el.classList.remove('syllable-pop');
            }
            sylDom._popped = false;
          }, 360);
        }
      }
    }

    /**
     * Smoothly settles a syllable back to baseline via critically damped spring ease.
     */
    settleSyllable(sylDom) {
      if (!sylDom || !sylDom.element) return;
      const el = sylDom.element;

      if (el.classList && typeof el.classList.remove === 'function') {
        el.classList.remove('is-active-syl');
      }

      if (!sylDom._isStretching) return;
      sylDom._isStretching = false;

      if (el.style) {
        el.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = '';
        if (typeof el.style.removeProperty === 'function') {
          el.style.removeProperty('--syllable-stretch');
        }
        setTimeout(() => {
          if (el && el.style) {
            el.style.transition = '';
            el.style.display = '';
            el.style.transformOrigin = '';
          }
        }, 360);
      }
    }

    /**
     * Applies fancy spring scroll animation with cascading inertia across the active
     * line and neighboring lines when active lyric cluster changes.
     */
    triggerScrollCascade(activeIdx, lyricDom) {
      if (!lyricDom || lyricDom.length === 0 || typeof activeIdx !== 'number' || activeIdx < 0) return;
      if (this.options.scrollInertiaMode === 'off') return;

      const intensity = this.options.scrollInertiaMode === 'subtle' ? 0.5 : (this.options.scrollInertiaMode === 'smooth' ? 0.75 : 1.0);

      // Active line: subtle inertia overshoot (6px -> -1.5px -> 0px)
      const activeLine = lyricDom[activeIdx];
      if (activeLine && activeLine.element) {
        const el = activeLine.element;
        if (el.classList && typeof el.classList.add === 'function') {
          el.classList.remove('scroll-spring-active', 'scroll-spring-near');
          el.classList.add('scroll-spring-active');
          if (el.style && typeof el.style.setProperty === 'function') {
            el.style.setProperty('--scroll-cascade-scale', String(intensity));
          }
          setTimeout(() => {
            if (el && el.classList && typeof el.classList.remove === 'function') {
              el.classList.remove('scroll-spring-active');
            }
          }, 450);
        }
      }

      // Cascading lesser spring inertia to line +1 (~45%)
      const nextLine1 = lyricDom[activeIdx + 1];
      if (nextLine1 && nextLine1.element) {
        const el = nextLine1.element;
        if (el.classList && typeof el.classList.add === 'function') {
          el.classList.remove('scroll-spring-active', 'scroll-spring-near');
          el.classList.add('scroll-spring-near');
          if (el.style && typeof el.style.setProperty === 'function') {
            el.style.setProperty('--scroll-cascade-scale', String(intensity * 0.45));
          }
          setTimeout(() => {
            if (el && el.classList && typeof el.classList.remove === 'function') {
              el.classList.remove('scroll-spring-near');
            }
          }, 400);
        }
      }

      // Cascading lesser spring inertia to line +2 (~20%)
      const nextLine2 = lyricDom[activeIdx + 2];
      if (nextLine2 && nextLine2.element) {
        const el = nextLine2.element;
        if (el.classList && typeof el.classList.add === 'function') {
          el.classList.remove('scroll-spring-active', 'scroll-spring-near');
          el.classList.add('scroll-spring-near');
          if (el.style && typeof el.style.setProperty === 'function') {
            el.style.setProperty('--scroll-cascade-scale', String(intensity * 0.20));
          }
          setTimeout(() => {
            if (el && el.classList && typeof el.classList.remove === 'function') {
              el.classList.remove('scroll-spring-near');
            }
          }, 350);
        }
      }
    }

    /**
     * Called when a lyric line DOM node is constructed in app.js.
     * Enriches the line with dynamic typography classes and CSS tokens without recreating DOM.
     */
    onLineCreated(lDom) {
      if (!lDom || !lDom.element) return;
      const el = lDom.element;

      if (lDom.isBackground) {
        if (el.style) {
          el.style.fontStyle = this.options.backingVocalStyle;
          el.style.opacity = String(this.options.secondaryOpacity);
          if (this.options.fontFamilySecondary && this.options.fontFamilySecondary !== 'inherit') {
            el.style.fontFamily = this.options.fontFamilySecondary;
          }
        }
        if (typeof el.setAttribute === 'function') el.setAttribute('data-tier', 'backing-vocal');
      }

      if (lDom.isAdlib) {
        if (el.style) {
          el.style.fontStyle = this.options.adlibStyle;
          if (this.options.fontFamilyAdlib && this.options.fontFamilyAdlib !== 'inherit') {
            el.style.fontFamily = this.options.fontFamilyAdlib;
          }
        }
        if (typeof el.setAttribute === 'function') el.setAttribute('data-tier', 'adlib');
      }

      if (lDom.isChorus) {
        if (el.style) el.style.fontWeight = String(this.options.chorusWeight);
        if (typeof el.setAttribute === 'function') el.setAttribute('data-tier', 'chorus');
      }

      if (this.options.fontStretch && this.options.fontStretch !== 'normal') {
        if (el.style) el.style.fontStretch = this.options.fontStretch;
      }
    }

    /**
     * Multi-Line Cinematic Depth of Field hook.
     * Intercepts updateLineDepthOfField(activeIndices) in app.js with configured dynamic options.
     */
    applyDepthOfField(lyricDom, activeIndices) {
      if (!lyricDom || lyricDom.length === 0) return false;

      const indices = Array.isArray(activeIndices)
        ? activeIndices
        : (typeof activeIndices === 'number' && activeIndices >= 0 ? [activeIndices] : []);

      const opts = this.options;
      const hasGlow = opts.activeGlow > 0.05;
      const activeTransform = `scale(${opts.activeScale}) translate(${opts.activeOffsetX}px, ${opts.activeOffsetY}px)`;

      for (let i = 0; i < lyricDom.length; i++) {
        const lDom = lyricDom[i];
        if (!lDom || !lDom.element) continue;

        const isActiveLine = indices.includes(i);
        if (lDom.element.classList && typeof lDom.element.classList.toggle === 'function') {
          lDom.element.classList.toggle('is-active', isActiveLine);
        }
        lDom.element.tabIndex = isActiveLine ? 0 : -1;

        if (typeof lDom.element.getAttribute === 'function') {
          if (lDom.element.getAttribute('aria-live') !== (isActiveLine ? 'polite' : null)) {
            if (isActiveLine && typeof lDom.element.setAttribute === 'function') {
              lDom.element.setAttribute('aria-live', 'polite');
            } else if (typeof lDom.element.removeAttribute === 'function') {
              lDom.element.removeAttribute('aria-live');
            }
          }
        }

        let tier = 'far';
        if (indices.length === 0) {
          tier = 'idle';
        } else if (isActiveLine) {
          tier = 'active';
        } else {
          let minDist = Infinity;
          for (let a = 0; a < indices.length; a++) {
            const d = Math.abs(i - indices[a]);
            if (d < minDist) minDist = d;
          }
          tier = minDist === 1 ? 'near' : (minDist === 2 ? 'mid' : 'far');
        }

        // Skip redundant restyling when tier did not change
        if (lDom.dofTier === tier) continue;
        lDom.dofTier = tier;

        const el = lDom.element;
        if (tier === 'idle') {
          el.style.filter = 'none';
          el.style.opacity = String(opts.idleOpacity);
          el.style.transform = `scale(${opts.idleScale})`;
          if (lDom.isBackground) el.style.opacity = String(opts.secondaryOpacity * opts.idleOpacity);
        } else if (tier === 'active') {
          if (hasGlow) {
            el.style.filter = `drop-shadow(0 0 ${opts.activeGlow * 12}px ${opts.activeGlowColor})`;
          } else {
            el.style.filter = 'none';
          }
          el.style.opacity = '1';
          el.style.transform = activeTransform;

          if (opts.bevelStroke && opts.bevelStroke !== 'none') {
            el.style.webkitTextStroke = opts.bevelStroke;
          }
          if (opts.textShadow && opts.textShadow !== 'none') {
            el.style.textShadow = opts.textShadow;
          }
          if (opts.activeWeight) {
            el.style.fontWeight = String(opts.activeWeight);
          }
          // Variable font settings
          if (opts.variableFontWeightActive && opts.variableFontWidthActive) {
            el.style.fontVariationSettings = `'wght' ${opts.variableFontWeightActive}, 'wdth' ${opts.variableFontWidthActive}`;
          }
        } else if (tier === 'near') {
          el.style.filter = opts.nearBlur > 0 ? `blur(${opts.nearBlur}px)` : 'none';
          el.style.opacity = String(opts.nearOpacity);
          el.style.transform = `scale(${opts.nearScale})`;
          if (lDom.isBackground) el.style.opacity = String(opts.secondaryOpacity * opts.nearOpacity);
        } else if (tier === 'mid') {
          el.style.filter = 'none';
          el.style.opacity = String(opts.midOpacity);
          el.style.transform = `scale(${opts.midScale})`;
          if (lDom.isBackground) el.style.opacity = String(opts.secondaryOpacity * opts.midOpacity);
        } else {
          el.style.filter = 'none';
          el.style.opacity = String(opts.farOpacity);
          el.style.transform = `scale(${opts.farScale})`;
          if (lDom.isBackground) el.style.opacity = String(opts.secondaryOpacity * opts.farOpacity);
        }
      }

      return true;
    }

    /**
     * Syllable-level styling hook without recreating DOM.
     */
    updateSyllableStyle(sylDom, state, fillPct) {
      if (!sylDom || !sylDom.element) return;
      if (this.options.letterSpacing) {
        sylDom.element.style.letterSpacing = this.options.letterSpacing;
      }
    }
  }


  // ===========================================================================
  // 2. AudioReactiveSyncModule
  // ===========================================================================

  class AudioReactiveSyncModule {
    constructor(customization) {
      this.domain = 'reactive';
      this.customization = customization || (typeof window !== 'undefined' ? window.customization : null);

      this.options = {
        enabled: true,
        sensitivity: 1.0,
        pulseStrength: 1.0,
        springDamping: 0.95,
        springStiffness: 0.18,
        syncMotionMode: 'synchronized', // 'synchronized' | 'alternating' | 'subtle' | 'off'
        responseAction: 'all', // 'all' | 'scale' | 'tilt' | 'glow' | 'chromatic'

        targetAlbumArt: true,
        targetLyricsActive: true,
        targetLyricsContainer: false,
        targetControls: true,
        targetAmbientBloom: true,
        targetParticleEmitter: true
      };

      // Target Registry Map: targetId -> TargetRecord
      this.targets = new Map();

      // Synced motion coordinator state
      this._beatIndex = 0;
      this._tiltPhase = 0;
      this._allSettled = true;
      this._activeLyricEl = null;

      this._boundOnChange = this._handleCustomizationChange.bind(this);

      this._initDefaultSubscriptions();

      if (this.customization) {
        this.init(this.customization);
      }
    }

    init(customization) {
      this.customization = customization;
      if (!this.customization) return;

      this._syncFromCustomization();

      if (typeof this.customization.on === 'function') {
        this.customization.on('change:reactive', this._boundOnChange);
        this.customization.on('change', this._boundOnChange);
        this.customization.on('preset:applied', this._boundOnChange);
        this.customization.on('reset', this._boundOnChange);
      }
    }

    _handleCustomizationChange() {
      this._syncFromCustomization();
    }

    _syncFromCustomization() {
      if (!this.customization) return;

      const rState = (typeof this.customization.get === 'function')
        ? (this.customization.get('reactive') || {})
        : {};

      const getVal = (camelKey, snakeKey, defVal) => {
        if (rState[camelKey] !== undefined) return rState[camelKey];
        if (rState[snakeKey] !== undefined) return rState[snakeKey];
        return defVal;
      };

      this.options.enabled = Boolean(getVal('beatPulseEnabled', 'beat_sync_enabled', this.options.enabled));
      this.options.pulseStrength = Number(getVal('beatPulseIntensity', 'pulse_strength', this.options.pulseStrength));
      this.options.springDamping = Number(getVal('springDamping', 'spring_damping', this.options.springDamping));
      this.options.syncMotionMode = getVal('syncMotionMode', 'sync_motion_mode', this.options.syncMotionMode);
      this.options.responseAction = getVal('responseAction', 'response_action', this.options.responseAction);

      this.options.targetAlbumArt = Boolean(getVal('targetAlbumArt', 'target_album_art', this.options.targetAlbumArt));
      this.options.targetLyricsActive = Boolean(getVal('targetLyricsActive', 'target_lyrics_active', this.options.targetLyricsActive));
      this.options.targetControls = Boolean(getVal('targetControls', 'target_controls', this.options.targetControls));
      this.options.targetAmbientBloom = Boolean(getVal('targetAmbientBloom', 'target_ambient_bloom', this.options.targetAmbientBloom));
      this.options.targetParticleEmitter = Boolean(getVal('targetParticleEmitter', 'target_particles', this.options.targetParticleEmitter));

      for (const target of this.targets.values()) {
        target.damping = this.options.springDamping;
      }
    }

    _initDefaultSubscriptions() {
      // 1. Album Art Target (targets wrapper with subtle breathing scale & chromatic surge)
      this.subscribeTarget('album-art', '#float-art-wrap, .float-art-wrap', {
        impulseStrength: 0.85,
        actions: ['scale-pulse', 'tilt-pulse', 'chromatic-surge'],
        maxScale: 0.022,
        maxTilt: 1.1,
        phase: 1
      });

      // 2. Active Lyric Line Target
      this.subscribeTarget('lyrics-active', null, {
        impulseStrength: 0.85,
        actions: ['scale-pulse', 'glow-bloom'],
        maxScale: 0.025,
        maxBloom: 8,
        phase: 1
      });

      // 3. Lyrics Container Target
      this.subscribeTarget('lyrics-container', '#lyrics-container', {
        impulseStrength: 0.40,
        actions: ['tilt-pulse'],
        maxTilt: 0.8,
        phase: 0.5
      });

      // 4. Playback Controls Target
      this.subscribeTarget('controls', '#art-controls, #art-player, .art-controls', {
        impulseStrength: 0.70,
        actions: ['scale-pulse', 'tilt-pulse'],
        maxScale: 0.015,
        maxTilt: 0.9,
        phase: -1 // counter-tilt for coordinated kinetic balance
      });

      // 5. Ambient Bloom Target
      this.subscribeTarget('ambient-bloom', '.ambient-backdrop, .cover-art-blur', {
        impulseStrength: 1.10,
        actions: ['glow-bloom', 'scale-pulse'],
        maxScale: 0.05,
        maxBloom: 1.4,
        phase: 0
      });

      // 6. Particle Emitter Target
      this.subscribeTarget('particle-emitter', '#fx-canvas', {
        impulseStrength: 1.0,
        actions: ['scale-pulse'],
        phase: 0
      });
    }

    subscribeTarget(id, elementOrSelector, options = {}) {
      const actions = Array.isArray(options.actions)
        ? [...options.actions]
        : (options.action ? [options.action] : ['scale-pulse', 'tilt-pulse']);

      const targetRecord = {
        id,
        selector: typeof elementOrSelector === 'string' ? elementOrSelector : null,
        element: (typeof elementOrSelector !== 'string') ? elementOrSelector : null,
        enabled: options.enabled !== undefined ? Boolean(options.enabled) : true,
        impulseStrength: options.impulseStrength !== undefined ? Number(options.impulseStrength) : 1.0,
        damping: options.springDamping !== undefined ? Number(options.springDamping) : this.options.springDamping,
        stiffness: options.springStiffness !== undefined ? Number(options.springStiffness) : 0.18,
        actions,
        maxScale: options.maxScale || 0.05,
        maxTilt: options.maxTilt || 3.0,
        maxBloom: options.maxBloom || 12,
        maxChroma: options.maxChroma || 1.8,
        phase: options.phase !== undefined ? options.phase : 1,

        scaleDisp: 0,
        scaleVel: 0,
        tiltDispX: 0,
        tiltVelX: 0,
        tiltDispY: 0,
        tiltVelY: 0,
        bloomDisp: 0,
        bloomVel: 0,
        chromaDisp: 0,
        chromaVel: 0,
        settled: true
      };

      this.targets.set(id, targetRecord);
      return targetRecord;
    }

    unsubscribeTarget(id) {
      return this.targets.delete(id);
    }

    getTarget(id) {
      return this.targets.get(id) || null;
    }

    hasTarget(id) {
      return this.targets.has(id);
    }

    setActiveLyricElement(el) {
      this._activeLyricEl = el;
      const target = this.targets.get('lyrics-active');
      if (target) {
        target.element = el;
      }
    }

    /**
     * Dispatches downbeat transient impulse to all subscribed targets.
     */
    triggerBeat(strength, isDrop = false) {
      if (!this.options.enabled) return;

      const baseMult = (isDrop ? 1.4 : 1.0) * this.options.pulseStrength * (strength || 1.0);
      this._beatIndex++;

      this._tiltPhase += 1.396;
      const swingX = Math.cos(this._tiltPhase);
      const swingY = Math.sin(this._tiltPhase * 0.8);

      const mode = this.options.syncMotionMode;
      const actionFilter = this.options.responseAction;

      for (const [id, target] of this.targets.entries()) {
        if (!target.enabled) continue;

        if (id === 'album-art' && !this.options.targetAlbumArt) continue;
        if (id === 'lyrics-active' && !this.options.targetLyricsActive) continue;
        if (id === 'controls' && !this.options.targetControls) continue;
        if (id === 'ambient-bloom' && !this.options.targetAmbientBloom) continue;
        if (id === 'particle-emitter' && !this.options.targetParticleEmitter) continue;

        const targetImpulse = baseMult * target.impulseStrength;

        // 1. Scale pulse (subtle, luxurious breathing recoil)
        if (target.actions.includes('scale-pulse') && (actionFilter === 'all' || actionFilter === 'scale')) {
          target.scaleVel += clamp(targetImpulse * 0.020, -0.06, 0.06);
        }

        // 2. Synced Tilt pulse (scaled down ~70% for elegant harmonic sway)
        if (target.actions.includes('tilt-pulse') && mode !== 'off' && (actionFilter === 'all' || actionFilter === 'tilt')) {
          let dirSign = target.phase;
          if (mode === 'alternating' && (id === 'controls' || id === 'lyrics-container')) {
            dirSign = -target.phase;
          }
          const tiltScale = mode === 'subtle' ? 0.35 : 1.0;

          target.tiltVelX += swingX * targetImpulse * 0.65 * dirSign * tiltScale;
          target.tiltVelY += swingY * targetImpulse * 0.55 * dirSign * tiltScale;
        }

        // 3. Bloom pulse
        if (target.actions.includes('glow-bloom') && (actionFilter === 'all' || actionFilter === 'glow')) {
          target.bloomVel += targetImpulse * 0.45;
        }

        // 4. Chromatic surge
        if (target.actions.includes('chromatic-surge') && (actionFilter === 'all' || actionFilter === 'chromatic')) {
          target.chromaVel += targetImpulse * 0.50;
        }

        target.settled = false;
        this._allSettled = false;
      }
    }

    triggerSubBeat(strength) {
      if (!this.options.enabled) return;
      this.triggerBeat(strength * 0.45, false);
    }

    /**
     * Physics simulation & style application tick.
     * Called on animation frame from app.js tick().
     */
    update(dt) {
      if (this._allSettled || !this.options.enabled) return;

      const dtSec = Math.min(0.045, (dt || 16.6) / 1000);
      if (dtSec <= 0) return;

      let anyActive = false;

      for (const target of this.targets.values()) {
        if (target.settled) continue;

        let el = target.element;
        if (!el && target.selector) {
          el = safeQuery(target.selector);
          if (el) target.element = el;
        }

        const k = 220;
        const dampingRatio = clamp(target.damping || 0.95, 0.2, 1.2);
        const c = 2 * dampingRatio * Math.sqrt(k);

        // Integrate Scale Spring
        const scaleAcc = -k * target.scaleDisp - c * target.scaleVel;
        target.scaleVel += scaleAcc * dtSec;
        target.scaleDisp += target.scaleVel * dtSec;

        // Integrate Tilt Springs
        const tiltAccX = -k * target.tiltDispX - c * target.tiltVelX;
        target.tiltVelX += tiltAccX * dtSec;
        target.tiltDispX += target.tiltVelX * dtSec;

        const tiltAccY = -k * target.tiltDispY - c * target.tiltVelY;
        target.tiltVelY += tiltAccY * dtSec;
        target.tiltDispY += target.tiltVelY * dtSec;

        // Integrate Bloom Spring
        const bloomAcc = -k * target.bloomDisp - c * target.bloomVel;
        target.bloomVel += bloomAcc * dtSec;
        target.bloomDisp += target.bloomVel * dtSec;

        // Clamp bounds
        target.scaleDisp = clamp(target.scaleDisp, -target.maxScale, target.maxScale);
        target.tiltDispX = clamp(target.tiltDispX, -target.maxTilt, target.maxTilt);
        target.tiltDispY = clamp(target.tiltDispY, -target.maxTilt, target.maxTilt);

        // Check for settling
        const isScaleSettled = Math.abs(target.scaleDisp) < 0.0005 && Math.abs(target.scaleVel) < 0.005;
        const isTiltSettled = Math.abs(target.tiltDispX) < 0.02 && Math.abs(target.tiltVelX) < 0.05 &&
                              Math.abs(target.tiltDispY) < 0.02 && Math.abs(target.tiltVelY) < 0.05;
        const isBloomSettled = Math.abs(target.bloomDisp) < 0.02 && Math.abs(target.bloomVel) < 0.05;

        if (isScaleSettled && isTiltSettled && isBloomSettled) {
          target.scaleDisp = 0;
          target.scaleVel = 0;
          target.tiltDispX = 0;
          target.tiltVelX = 0;
          target.tiltDispY = 0;
          target.tiltVelY = 0;
          target.bloomDisp = 0;
          target.bloomVel = 0;
          target.settled = true;

          if (el && el.style) {
            el.style.transform = '';
            el.style.filter = '';
          }
        } else {
          anyActive = true;

          if (el && el.style) {
            const hasScale = target.actions.includes('scale-pulse');
            const hasTilt = target.actions.includes('tilt-pulse');

            let tf = '';
            if (hasScale && Math.abs(target.scaleDisp) > 0.0001) {
              tf += `scale(${(1 + target.scaleDisp).toFixed(4)}) `;
            }
            if (hasTilt && (Math.abs(target.tiltDispX) > 0.02 || Math.abs(target.tiltDispY) > 0.02)) {
              tf += `perspective(800px) rotateX(${(-target.tiltDispY).toFixed(2)}deg) rotateY(${target.tiltDispX.toFixed(2)}deg) `;
            }

            if (tf) el.style.transform = tf.trim();

            if (target.actions.includes('glow-bloom') && target.bloomDisp > 0.05) {
              el.style.filter = `brightness(${(1 + target.bloomDisp * 0.25).toFixed(3)})`;
            }
          }
        }
      }

      if (!anyActive) {
        this._allSettled = true;
      }
    }
  }


  // ===========================================================================
  // 3. PluggableParticleEngine & Zero-Allocation Pool
  // ===========================================================================

  class RecycledParticlePool {
    constructor(capacity = 250) {
      this.capacity = capacity;
      this.count = 0;

      // Struct-of-Arrays (SoA) TypedArrays for zero-allocation performance
      this.x = new Float32Array(capacity);
      this.y = new Float32Array(capacity);
      this.z = new Float32Array(capacity);
      this.vx = new Float32Array(capacity);
      this.vy = new Float32Array(capacity);
      this.vz = new Float32Array(capacity);
      this.targetX = new Float32Array(capacity);
      this.targetY = new Float32Array(capacity);
      this.prevX = new Float32Array(capacity);
      this.prevY = new Float32Array(capacity);
      this.size = new Float32Array(capacity);
      this.rawSize = new Float32Array(capacity);
      this.meanSize = new Float32Array(capacity);
      this.life = new Float32Array(capacity);
      this.maxLife = new Float32Array(capacity);
      this.rot = new Float32Array(capacity);
      this.rotSpeed = new Float32Array(capacity);
      this.baseRotSpeed = new Float32Array(capacity);
      this.alpha = new Float32Array(capacity);
      this.bloom = new Float32Array(capacity);
      this.reactivity = new Float32Array(capacity);
      this.beatVx = new Float32Array(capacity);
      this.beatVy = new Float32Array(capacity);
      this.param1 = new Float32Array(capacity);
      this.param2 = new Float32Array(capacity);
      this.param3 = new Float32Array(capacity);
      this.twinkleFreq = new Float32Array(capacity);
      this.twinklePhase = new Float32Array(capacity);
      this.twinkleDepth = new Float32Array(capacity);

      // Integer tags & RGB
      this.typeId = new Uint8Array(capacity);
      this.twinkleType = new Uint8Array(capacity);
      this.active = new Uint8Array(capacity);
      this.r = new Uint8Array(capacity);
      this.g = new Uint8Array(capacity);
      this.b = new Uint8Array(capacity);
    }

    spawn(typeId, x, y, vx, vy, size, maxLife, r, g, b, param1 = 0, param2 = 0) {
      let idx = -1;
      for (let i = 0; i < this.capacity; i++) {
        if (this.active[i] === 0) {
          idx = i;
          break;
        }
      }

      if (idx === -1) {
        let maxAge = -1;
        idx = 0;
        for (let i = 0; i < this.capacity; i++) {
          if (this.life[i] > maxAge) {
            maxAge = this.life[i];
            idx = i;
          }
        }
      } else {
        this.count++;
      }

      this.active[idx] = 1;
      this.typeId[idx] = typeId;
      this.x[idx] = x;
      this.y[idx] = y;
      this.z[idx] = 600 + Math.random() * 400; // Z depth for cosmic warp
      this.targetX[idx] = x;
      this.targetY[idx] = y;
      this.prevX[idx] = x;
      this.prevY[idx] = y;
      this.vx[idx] = vx;
      this.vy[idx] = vy;
      this.vz[idx] = 0.5 + Math.random() * 1.2;
      this.beatVx[idx] = 0;
      this.beatVy[idx] = 0;
      this.size[idx] = size;
      this.rawSize[idx] = size;
      this.meanSize[idx] = size;
      this.life[idx] = 0;
      this.maxLife[idx] = maxLife;
      this.rot[idx] = Math.random() * Math.PI * 2;
      this.rotSpeed[idx] = (Math.random() - 0.5) * 0.003;
      this.baseRotSpeed[idx] = this.rotSpeed[idx];
      this.alpha[idx] = 1;
      this.bloom[idx] = 1;
      this.reactivity[idx] = 1;
      this.param1[idx] = param1;
      this.param2[idx] = param2;
      this.r[idx] = r;
      this.g[idx] = g;
      this.b[idx] = b;

      return idx;
    }

    recycle(idx) {
      if (idx < 0 || idx >= this.capacity) return;
      if (this.active[idx] === 1) {
        this.active[idx] = 0;
        this.count = Math.max(0, this.count - 1);
      }
    }

    clear() {
      this.active.fill(0);
      this.count = 0;
    }
  }

  class PluggableParticleEngine {
    constructor(customization) {
      this.domain = 'visuals';
      this.customization = customization || (typeof window !== 'undefined' ? window.customization : null);

      this.options = {
        particleType: 'motes', // 'motes' | 'stars' | 'ripples' | 'bokeh' | 'fireflies' | 'vinyl' | 'none'
        particleCount: 60,
        particleSpeed: 1.0,
        particleSize: 6.0,
        particleOpacity: 0.8,
        colorMode: 'ambient-sample'
      };

      this.pool = new RecycledParticlePool(250);
      this.particleTypes = new Map();
      this.attachedAirPipeline = null;
      this.activeLyricPos = { x: 0, y: 0, active: false };
      this._currentParticleType = null;

      this._boundOnChange = this._handleCustomizationChange.bind(this);

      this._registerBuiltInTypes();

      if (this.customization) {
        this.init(this.customization);
      }
    }

    init(customization) {
      this.customization = customization;
      if (!this.customization) return;

      this._syncFromCustomization(false);

      if (typeof this.customization.on === 'function') {
        this.customization.on('change:visuals', this._boundOnChange);
        this.customization.on('change', this._boundOnChange);
        this.customization.on('preset:applied', this._boundOnChange);
        this.customization.on('reset', this._boundOnChange);
      }
    }

    _handleCustomizationChange() {
      this._syncFromCustomization(true);
    }

    _syncFromCustomization(fromEvent = false) {
      if (!this.customization) return;

      const vState = (typeof this.customization.get === 'function')
        ? (this.customization.get('visuals') || {})
        : {};

      const getVal = (camelKey, snakeKey, defVal) => {
        if (vState[camelKey] !== undefined) return vState[camelKey];
        if (vState[snakeKey] !== undefined) return vState[snakeKey];
        return defVal;
      };

      const oldType = this.options.particleType;
      this.options.particleType = getVal('particleType', 'particle_type', this.options.particleType);
      this.options.particleCount = Number(getVal('particleCount', 'particle_count', this.options.particleCount));
      this.options.particleSpeed = Number(getVal('particleSpeed', 'particle_speed', this.options.particleSpeed));
      this.options.particleSize = Number(getVal('particleSize', 'particle_size', this.options.particleSize));
      this.options.particleOpacity = Number(getVal('particleOpacity', 'particle_opacity', this.options.particleOpacity));

      if (fromEvent || (this._currentParticleType !== null && this._currentParticleType !== this.options.particleType)) {
        this.reseed();
      }
      this._currentParticleType = this.options.particleType;
    }

    registerParticleType(name, typeDef) {
      if (!name || !typeDef) return;
      this.particleTypes.set(name, {
        id: this.particleTypes.size,
        name,
        init: typeDef.init || (() => {}),
        update: typeDef.update || (() => {}),
        draw: typeDef.draw || (() => {}),
        onBeat: typeDef.onBeat || (() => {})
      });

      if (this.customization && this.customization.registry) {
        const prop = this.customization.registry.getProperty('visuals', 'particle_type');
        if (prop && Array.isArray(prop.options) && !prop.options.includes(name)) {
          prop.options.push(name);
        }
      }
    }

    setActiveLyricPosition(x, y) {
      this.activeLyricPos.x = x;
      this.activeLyricPos.y = y;
      this.activeLyricPos.active = true;
    }

    _registerBuiltInTypes() {
      // 1. Motes: Ethereal atmospheric stardust
      this.registerParticleType('motes', {
        draw: (ctx, p, i) => {
          const x = p.x[i];
          const y = p.y[i];
          const r = p.size[i];
          const alpha = p.alpha[i];
          if (alpha <= 0.005 || r <= 0.1) return;

          const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
          grad.addColorStop(0, `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, ${(alpha * 0.95).toFixed(3)})`);
          grad.addColorStop(0.4, `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, ${(alpha * 0.45).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, 0)`);

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        },
        onBeat: (p, i, surge) => {
          p.beatVy[i] -= (0.2 + dustHash(i, 3) * 0.4) * surge * p.reactivity[i];
        }
      });

      // 2. Stars: Cosmic starfield with 3D Z-warp
      this.registerParticleType('stars', {
        draw: (ctx, p, i) => {
          const x = p.x[i];
          const y = p.y[i];
          const r = p.size[i];
          const rot = p.rot[i];
          const alpha = p.alpha[i];
          if (alpha <= 0.005 || r <= 0.5) return;

          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(rot);

          ctx.beginPath();
          ctx.moveTo(0, -r);
          ctx.quadraticCurveTo(0, 0, r * 0.25, 0);
          ctx.quadraticCurveTo(0, 0, 0, r);
          ctx.quadraticCurveTo(0, 0, -r * 0.25, 0);
          ctx.quadraticCurveTo(0, 0, 0, -r);
          ctx.closePath();

          ctx.fillStyle = `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, ${(alpha * 0.85).toFixed(3)})`;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(0, 0, Math.max(0.6, r * 0.15), 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 255, 255, ${(alpha * 0.95).toFixed(3)})`;
          ctx.fill();

          ctx.restore();
        },
        onBeat: (p, i, surge) => {
          p.rotSpeed[i] += (dustHash(i, 4) - 0.5) * 0.004 * surge;
          p.beatVy[i] -= (0.15 + dustHash(i, 5) * 0.3) * surge;
          p.vz[i] += surge * 2.5; // Cosmic warp acceleration along Z axis
        }
      });

      // 3. Ripples: Ethereal Concentric Acoustic Fluid Waves
      this.registerParticleType('ripples', {
        draw: (ctx, p, i) => {
          const x = p.x[i];
          const y = p.y[i];
          const progress = clamp(p.life[i] / p.maxLife[i], 0, 1);
          // Quadratic ease-out expansion: rapid initial propagation easing into gentle dissipation
          const easeOut = 1 - Math.pow(1 - progress, 2);
          const currentRadius = p.size[i] * (0.25 + easeOut * 1.85);

          // Delicate cubic fade-out envelope
          const envelope = Math.sin(progress * Math.PI) * Math.pow(1 - progress, 0.6);
          const alpha = p.alpha[i] * envelope * 0.45;
          if (alpha <= 0.003 || currentRadius <= 1) return;

          ctx.save();

          // Outer primary wave ring with soft feathered stroke
          ctx.lineWidth = Math.max(0.6, 1.8 * (1 - progress * 0.7));
          ctx.strokeStyle = `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, currentRadius, 0, Math.PI * 2);
          ctx.stroke();

          // Secondary harmonic trailing ring at ~72% radius
          const innerRadius = currentRadius * 0.72;
          const innerAlpha = alpha * 0.55;
          if (innerRadius > 1 && innerAlpha > 0.003) {
            ctx.lineWidth = Math.max(0.4, 1.2 * (1 - progress));
            ctx.strokeStyle = `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, ${innerAlpha.toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, innerRadius, 0, Math.PI * 2);
            ctx.stroke();
          }

          // Subtle center luminous acoustic glow
          const glowAlpha = alpha * 0.25 * (1 - progress);
          if (glowAlpha > 0.005) {
            const glowRadius = Math.max(2, currentRadius * 0.28);
            const grad = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
            grad.addColorStop(0, `rgba(255, 255, 255, ${glowAlpha.toFixed(3)})`);
            grad.addColorStop(1, `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, 0)`);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.restore();
        },
        onBeat: (p, i, surge) => {
          p.size[i] = Math.min(240, p.size[i] + surge * 18);
        }
      });

      // 4. Bokeh: Soft out-of-focus optical circles
      this.registerParticleType('bokeh', {
        draw: (ctx, p, i) => {
          const x = p.x[i];
          const y = p.y[i];
          const r = p.size[i] * 1.5;
          const alpha = p.alpha[i] * 0.45;
          if (alpha <= 0.005 || r <= 1) return;

          ctx.save();
          ctx.fillStyle = `rgba(${p.r[i]}, ${p.g[i]}, ${p.b[i]}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();

          ctx.lineWidth = 1.0;
          ctx.strokeStyle = `rgba(255, 255, 255, ${(alpha * 0.6).toFixed(3)})`;
          ctx.stroke();
          ctx.restore();
        },
        onBeat: (p, i, surge) => {
          p.beatVy[i] -= 0.1 * surge;
        }
      });

      // 5. Fireflies: Organic wandering drift gravitating toward active lyrics
      this.registerParticleType('fireflies', {
        draw: (ctx, p, i) => {
          const x = p.x[i];
          const y = p.y[i];
          const r = p.size[i] * 0.8;
          // Bio-luminescent breathing swell
          const pulse = 0.65 + 0.35 * Math.sin(p.life[i] * 0.005 + p.param1[i]);
          const alpha = p.alpha[i] * pulse;
          if (alpha <= 0.005 || r <= 0.2) return;

          const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 2.2);
          grad.addColorStop(0, `rgba(255, 250, 180, ${(alpha * 0.95).toFixed(3)})`);
          grad.addColorStop(0.35, `rgba(${p.r[i]}, ${p.g[i]}, 100, ${(alpha * 0.55).toFixed(3)})`);
          grad.addColorStop(1, `rgba(${p.r[i]}, ${p.g[i]}, 100, 0)`);

          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(x, y, r * 2.2, 0, Math.PI * 2);
          ctx.fill();
        },
        onBeat: (p, i, surge) => {
          // Fireflies scatter playfully on beat
          const angle = Math.random() * Math.PI * 2;
          p.beatVx[i] += Math.cos(angle) * 0.35 * surge;
          p.beatVy[i] += Math.sin(angle) * 0.35 * surge;
        }
      });

      // 6. Vinyl: Vintage analog record micro-streaks and dust
      this.registerParticleType('vinyl', {
        draw: (ctx, p, i) => {
          const x = p.x[i];
          const y = p.y[i];
          const alpha = p.alpha[i] * 0.7;
          if (alpha <= 0.005) return;

          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(p.rot[i]);

          ctx.fillStyle = `rgba(240, 240, 245, ${alpha.toFixed(3)})`;
          // Thin streak resembling micro-groove dust
          ctx.fillRect(-p.size[i] * 0.5, -0.5, p.size[i], 1.0);
          ctx.restore();
        },
        onBeat: (p, i, surge) => {
          p.rotSpeed[i] += (Math.random() - 0.5) * 0.008 * surge;
        }
      });
    }

    attachToAirPipeline(airPipeline) {
      this.attachedAirPipeline = airPipeline;
    }

    spawnParticle(width, height, randomizeLife = false) {
      const type = this.options.particleType;
      if (type === 'none') return -1;

      const typeDef = this.particleTypes.get(type);
      if (!typeDef) return -1;

      const w = width || (this.attachedAirPipeline ? this.attachedAirPipeline.width : (typeof window !== 'undefined' ? window.innerWidth : 800));
      const h = height || (this.attachedAirPipeline ? this.attachedAirPipeline.height : (typeof window !== 'undefined' ? window.innerHeight : 600));

      const sizeScale = Math.max(0.2, (this.options.particleSize || 6.0) / 6.0);
      let x, y, vx, vy, size, maxLife, r, g, b, param1 = 0, param2 = 0;

      switch (type) {
        case 'stars':
          x = Math.random() * w;
          y = Math.random() * h;
          vx = (Math.random() - 0.5) * 0.25;
          vy = (Math.random() - 0.5) * 0.25;
          size = (3.5 + Math.random() * 5.0) * sizeScale;
          maxLife = 5000 + Math.random() * 5000;
          r = 230 + Math.floor(Math.random() * 25);
          g = 240 + Math.floor(Math.random() * 15);
          b = 255;
          break;
        case 'ripples':
          if (this.activeLyricPos.active) {
            x = this.activeLyricPos.x + (Math.random() - 0.5) * 120;
            y = this.activeLyricPos.y + (Math.random() - 0.5) * 60;
          } else {
            x = Math.random() * w;
            y = Math.random() * h;
          }
          vx = 0;
          vy = 0;
          size = (35 + Math.random() * 55) * sizeScale;
          maxLife = 1800 + Math.random() * 1400;
          r = 180 + Math.floor(Math.random() * 75);
          g = 210 + Math.floor(Math.random() * 45);
          b = 255;
          break;
        case 'bokeh':
          x = Math.random() * w;
          y = Math.random() * h;
          vx = (Math.random() - 0.5) * 0.25;
          vy = -0.12 - Math.random() * 0.22;
          size = (15 + Math.random() * 25) * sizeScale;
          maxLife = 6000 + Math.random() * 4000;
          r = 190 + Math.floor(Math.random() * 65);
          g = 205 + Math.floor(Math.random() * 50);
          b = 255;
          break;
        case 'fireflies':
          x = Math.random() * w;
          y = Math.random() * h;
          vx = (Math.random() - 0.5) * 0.6;
          vy = (Math.random() - 0.5) * 0.6;
          size = (3.0 + Math.random() * 3.5) * sizeScale;
          maxLife = 4500 + Math.random() * 3500;
          r = 255;
          g = 230 + Math.floor(Math.random() * 25);
          b = 110 + Math.floor(Math.random() * 40);
          param1 = Math.random() * Math.PI * 2;
          break;
        case 'vinyl':
          x = Math.random() * w;
          y = Math.random() * h;
          vx = (Math.random() - 0.5) * 0.8;
          vy = (Math.random() - 0.5) * 0.4;
          size = (6.0 + Math.random() * 12.0) * sizeScale;
          maxLife = 1200 + Math.random() * 1600;
          r = 240;
          g = 240;
          b = 245;
          break;
        case 'motes':
        default:
          x = Math.random() * w;
          y = Math.random() * h;
          vx = (Math.random() - 0.5) * 0.35;
          vy = -0.2 - Math.random() * 0.35;
          size = (2.0 + Math.random() * 4.0) * sizeScale;
          maxLife = 4000 + Math.random() * 4000;
          r = 210 + Math.floor(Math.random() * 45);
          g = 225 + Math.floor(Math.random() * 30);
          b = 255;
          break;
      }

      const idx = this.pool.spawn(typeDef.id, x, y, vx, vy, size, maxLife, r, g, b, param1, param2);
      if (idx !== -1 && randomizeLife) {
        this.pool.life[idx] = Math.random() * maxLife * 0.85;
      }
      return idx;
    }

    reseed(width, height) {
      this.pool.clear();
      if (this.options.particleType === 'none') return;
      const targetCount = Math.min(this.options.particleCount || 60, this.pool.capacity);
      for (let i = 0; i < targetCount; i++) {
        this.spawnParticle(width, height, true);
      }
    }

    emitAcousticRipple(x, y, size = 60, r = 255, g = 255, b = 255) {
      const type = this.particleTypes.get('ripples');
      if (!type) return -1;
      return this.pool.spawn(type.id, x, y, 0, 0, size, 1400, r, g, b);
    }

    onBeatImpulse(surge) {
      if (this.options.particleType === 'none' || this.options.particleCount <= 0) return;

      const p = this.pool;
      for (let i = 0; i < p.capacity; i++) {
        if (p.active[i] === 0) continue;
        const typeName = this._getTypeNameById(p.typeId[i]);
        const typeDef = this.particleTypes.get(typeName);
        if (typeDef && typeof typeDef.onBeat === 'function') {
          typeDef.onBeat(p, i, surge);
        }
      }
    }

    _getTypeNameById(typeId) {
      for (const [name, def] of this.particleTypes.entries()) {
        if (def.id === typeId) return name;
      }
      return 'motes';
    }

    render(ctx, width, height, dt) {
      if (this.options.particleType === 'none' || !ctx) {
        if (this.pool.count > 0) this.pool.clear();
        return;
      }

      const p = this.pool;
      const clampedDt = Math.min(50, dt || 16.6);
      const acousticDrag = Math.exp(-clampedDt / 280);

      // Continuous spawning towards options.particleCount
      const targetCount = Math.min(this.options.particleCount || 60, p.capacity);
      if (p.count < targetCount) {
        const toSpawn = Math.min(2, targetCount - p.count);
        for (let s = 0; s < toSpawn; s++) {
          this.spawnParticle(width, height, false);
        }
      }

      // Fireflies gravitational center
      const hasLyricTarget = this.activeLyricPos.active;
      const targetX = this.activeLyricPos.x;
      const targetY = this.activeLyricPos.y;

      for (let i = 0; i < p.capacity; i++) {
        if (p.active[i] === 0) continue;

        p.life[i] += clampedDt;
        if (p.life[i] >= p.maxLife[i]) {
          p.recycle(i);
          if (p.count < targetCount) {
            this.spawnParticle(width, height, false);
          }
          continue;
        }

        // Screen boundary wrapping
        if (width > 0 && height > 0) {
          if (p.x[i] < -60) p.x[i] = width + 50;
          else if (p.x[i] > width + 60) p.x[i] = -50;
          if (p.y[i] < -60) p.y[i] = height + 50;
          else if (p.y[i] > height + 60) p.y[i] = -50;
        }

        // Velocity integration & drag decay
        p.beatVx[i] *= acousticDrag;
        p.beatVy[i] *= acousticDrag;

        const typeId = p.typeId[i];

        // Cosmic starfield Z-warp integration
        if (typeId === 1) { // stars
          p.z[i] -= p.vz[i] * clampedDt * 0.08;
          if (p.z[i] <= 10) {
            p.z[i] = 1000;
            p.x[i] = Math.random() * (width || 800);
            p.y[i] = Math.random() * (height || 600);
          }
          p.vz[i] = Math.max(0.5, p.vz[i] * 0.96);
        }

        // Fireflies gentle gravitation toward active lyric
        if (typeId === 4 && hasLyricTarget) {
          const dx = targetX - p.x[i];
          const dy = targetY - p.y[i];
          const dist = Math.hypot(dx, dy) || 1;
          if (dist > 30) {
            p.vx[i] += (dx / dist) * 0.012;
            p.vy[i] += (dy / dist) * 0.012;
          }
        }

        // Skip motes in pluggable pool if attached AirParticlePipeline handles them
        if (this.attachedAirPipeline && this.options.particleType === 'motes' && typeId === 0) {
          continue;
        }

        const effVx = (p.vx[i] + p.beatVx[i]) * this.options.particleSpeed;
        const effVy = (p.vy[i] + p.beatVy[i]) * this.options.particleSpeed;

        p.x[i] += effVx * clampedDt * 0.06;
        p.y[i] += effVy * clampedDt * 0.06;
        p.rot[i] += p.rotSpeed[i];

        // Opacity envelope
        const progress = p.life[i] / p.maxLife[i];
        let alpha = 1.0;
        if (progress < 0.2) alpha = Math.sin((progress / 0.2) * (Math.PI / 2));
        else if (progress > 0.8) alpha = Math.sin(((1.0 - progress) / 0.2) * (Math.PI / 2));
        p.alpha[i] = alpha * this.options.particleOpacity;

        const typeName = this._getTypeNameById(typeId);
        const typeDef = this.particleTypes.get(typeName);
        if (typeDef && typeof typeDef.draw === 'function') {
          typeDef.draw(ctx, p, i);
        }
      }
    }
  }


  // ===========================================================================
  // 4. BreakdownStasisController
  // ===========================================================================

  class BreakdownStasisController {
    constructor(customization) {
      this.customization = customization || (typeof window !== 'undefined' ? window.customization : null);
      this.enabled = true;
      this.inStasis = false;
      this.stasisFactor = 0.0; // 0.0 = full vocal energy, 1.0 = deep ambient stasis
      this.gapThresholdMs = 4500; // 4.5 seconds
      this.anticipationLeadMs = 1200; // 1.2s smooth lead time before next vocal phrase

      if (this.customization) {
        this._sync();
        if (typeof this.customization.on === 'function') {
          this.customization.on('change:visuals', () => this._sync());
          this.customization.on('change', () => this._sync());
        }
      }
    }

    _sync() {
      if (!this.customization) return;
      const v = typeof this.customization.get === 'function' ? this.customization.get('visuals') : {};
      if (v) {
        if (v.breakdownStasisEnabled !== undefined) this.enabled = Boolean(v.breakdownStasisEnabled);
        else if (v.breakdown_stasis_enabled !== undefined) this.enabled = Boolean(v.breakdown_stasis_enabled);
      }
    }

    /**
     * Checks timeline gap between current lyric line and next lyric line.
     * Activates ambient stasis dimming when gap >= 4.5s, ramping back up smoothly before arrival.
     */
    checkGap(currentLine, nextLine, ms, dt = 16.6) {
      if (!this.enabled || !currentLine || !nextLine) {
        this.exitStasis();
        return;
      }

      const lineEnd = currentLine.endTimeMs;
      const nextStart = nextLine.startTimeMs;
      const gap = nextStart - lineEnd;

      if (gap < this.gapThresholdMs) {
        this.exitStasis();
        return;
      }

      const dtSec = Math.min(0.05, dt / 1000);

      if (ms >= lineEnd && ms < (nextStart - this.anticipationLeadMs)) {
        // Deep instrumental breakdown stasis
        this.inStasis = true;
        this.stasisFactor = Math.min(1.0, this.stasisFactor + dtSec * 1.4);
        if (typeof document !== 'undefined' && document.body && document.body.classList && typeof document.body.classList.add === 'function') {
          document.body.classList.add('in-breakdown-stasis');
        }
      } else if (ms >= (nextStart - this.anticipationLeadMs) && ms < nextStart) {
        // Anticipation window: smoothly ease out of stasis via smooth S-curve
        const remainingMs = nextStart - ms;
        const linearP = clamp(remainingMs / this.anticipationLeadMs, 0, 1);
        const targetFactor = linearP * linearP * (3 - 2 * linearP);
        this.stasisFactor = targetFactor;
        if (targetFactor <= 0.05) {
          this.inStasis = false;
          if (typeof document !== 'undefined' && document.body && document.body.classList && typeof document.body.classList.remove === 'function') {
            document.body.classList.remove('in-breakdown-stasis');
          }
        }
      } else {
        this.exitStasis();
      }
    }

    exitStasis() {
      if (!this.inStasis && this.stasisFactor <= 0) return;
      this.inStasis = false;
      this.stasisFactor = 0;
      if (typeof document !== 'undefined' && document.body && document.body.classList && typeof document.body.classList.remove === 'function') {
        document.body.classList.remove('in-breakdown-stasis');
      }
    }

    getSpeedMultiplier() {
      // In stasis: dampen particle speed by up to 70%
      return 1.0 - (0.70 * this.stasisFactor);
    }

    getImpulseMultiplier() {
      // In stasis: dampen beat spring impulses to 0.15
      return 1.0 - (0.85 * this.stasisFactor);
    }

    getGlowMultiplier() {
      return 1.0 - (0.90 * this.stasisFactor);
    }
  }


  // ===========================================================================
  // 5. ArtworkPhysicsController
  // ===========================================================================

  class ArtworkPhysicsController {
    constructor(customization) {
      this.customization = customization || (typeof window !== 'undefined' ? window.customization : null);

      this.spinEnabled = false;
      this.shape = 'rounded';
      this.angle = 0;
      this.angularVel = 0; // in deg/s
      this.targetVel = 198; // ~33 RPM (33 * 360 / 60 = 198 deg/s)
      this.decelDecay = 1.8; // lambda for exponential deceleration
      this._homing = false;

      if (this.customization) {
        this._sync();
        if (typeof this.customization.on === 'function') {
          this.customization.on('change:layout', () => this._sync());
          this.customization.on('change', () => this._sync());
        }
      }
    }

    _sync() {
      if (!this.customization) return;
      const l = typeof this.customization.get === 'function' ? this.customization.get('layout') : {};
      if (l) {
        if (l.artworkSpinEnabled !== undefined) this.spinEnabled = Boolean(l.artworkSpinEnabled);
        else if (l.artwork_spin_enabled !== undefined) this.spinEnabled = Boolean(l.artwork_spin_enabled);
        else this.spinEnabled = false;

        const newShape = l.artworkShape || l.artwork_shape || 'rounded';
        if (newShape !== this.shape) {
          this.applyShape(newShape);
        }
      }
    }

    applyShape(shape) {
      this.shape = shape || 'rounded';
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;

      const artWrappers = document.querySelectorAll('#float-art-wrap, .float-art-wrap, .cover-art-wrap');
      const shapes = ['rounded', 'circle', 'squircle', 'diamond', 'pill', 'vinyl'];

      for (const el of artWrappers) {
        if (!el || !el.classList) continue;
        for (const s of shapes) {
          if (typeof el.classList.remove === 'function') el.classList.remove(`art-shape-${s}`);
        }
        if (typeof el.classList.add === 'function') el.classList.add(`art-shape-${this.shape}`);
      }
    }

    /**
     * Updates rotational inertia on each frame.
     * When playing and spinEnabled: accelerates smoothly to ~33 RPM.
     * When paused or spin disabled: decelerates and homes upright to 0° via a damped spring.
     * Once within 0.2° of upright, cleanly resets inline transform and removes --art-spin-angle.
     */
    update(dt, isPlaying = true) {
      const shouldSpin = Boolean(this.spinEnabled);

      // If spin is disabled, we are not homing, and at 0° rest: early return with zero DOM writes
      if (!shouldSpin && !this._homing && this.angle === 0 && this.angularVel === 0) return;

      const dtSec = Math.min(0.045, (dt || 16.6) / 1000);

      if (shouldSpin && isPlaying) {
        this._homing = false;
        // Accelerate smoothly towards 33 RPM (targetVel = 198 deg/s)
        this.angularVel += (this.targetVel - this.angularVel) * Math.min(1, dtSec * 2.5);
        this.angle = (this.angle + this.angularVel * dtSec) % 360;
        if (this.angle < 0) this.angle += 360;
      } else {
        // Playback is paused or spin is disabled:
        if (!this._homing) {
          this.angularVel *= Math.exp(-this.decelDecay * dtSec);
          this.angle = (this.angle + this.angularVel * dtSec) % 360;
          if (this.angle < 0) this.angle += 360;

          if (Math.abs(this.angularVel) < 20.0) {
            this._homing = true;
          }
        } else {
          // Homing spring: smoothly rotate the artwork back to 0° upright via shortest path
          let diff = this.angle % 360;
          if (diff > 180) diff -= 360;
          if (diff < -180) diff += 360;

          if (Math.abs(diff) <= 0.2 && Math.abs(this.angularVel) <= 0.8) {
            // Arrived at 0° upright rest: cleanly reset style.transform and remove --art-spin-angle
            this.angle = 0;
            this.angularVel = 0;
            this._homing = false;

            if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
              const art = document.querySelector('#track-art, .track-art, .float-art-wrap img');
              if (art && art.style) {
                if (typeof art.style.removeProperty === 'function') {
                  art.style.removeProperty('--art-spin-angle');
                }
                art.style.transform = '';
              }
            }
            return;
          }

          // Critically damped harmonic oscillator pulling diff towards 0°
          const k = 16.0;
          const c = 2 * Math.sqrt(k); // 8.0
          const springAcc = -k * diff - c * this.angularVel;
          this.angularVel += springAcc * dtSec;
          this.angle += this.angularVel * dtSec;
          if (this.angle < 0) this.angle = (this.angle % 360) + 360;
        }
      }

      // Apply rotation to artwork element
      if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        const art = document.querySelector('#track-art, .track-art, .float-art-wrap img');
        if (art && art.style) {
          if (typeof art.style.setProperty === 'function') {
            art.style.setProperty('--art-spin-angle', `${this.angle.toFixed(2)}deg`);
          }
          art.style.transform = `rotate(${this.angle.toFixed(2)}deg)`;
        }
      }
    }
  }


  // ===========================================================================
  // Module Instantiation & Global Exposure
  // ===========================================================================

  const typographyModule = new DynamicTypographyModule();
  const reactiveSyncModule = new AudioReactiveSyncModule();
  const pluggableParticleEngine = new PluggableParticleEngine();
  const breakdownStasis = new BreakdownStasisController();
  const artworkPhysics = new ArtworkPhysicsController();

  const customizationModules = {
    typography: typographyModule,
    reactive: reactiveSyncModule,
    visuals: pluggableParticleEngine,
    stasis: breakdownStasis,
    artwork: artworkPhysics,
    DynamicTypographyModule,
    AudioReactiveSyncModule,
    PluggableParticleEngine,
    RecycledParticlePool,
    BreakdownStasisController,
    ArtworkPhysicsController
  };

  // Expose on global window object
  if (typeof window !== 'undefined') {
    window.customizationModules = customizationModules;
    window.dynamicTypographyModule = typographyModule;
    window.audioReactiveSyncModule = reactiveSyncModule;
    window.pluggableParticleEngine = pluggableParticleEngine;
    window.breakdownStasis = breakdownStasis;
    window.artworkPhysics = artworkPhysics;

    const attachModules = () => {
      if (window.customization) {
        window.customization.modules = customizationModules;
        typographyModule.init(window.customization);
        reactiveSyncModule.init(window.customization);
        pluggableParticleEngine.init(window.customization);
        breakdownStasis._sync();
        artworkPhysics._sync();
      }
    };

    if (window.customization) {
      attachModules();
    } else {
      window.addEventListener('DOMContentLoaded', attachModules);
    }
  }

  // Export for CommonJS / Node testing environments
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = customizationModules;
    module.exports.DynamicTypographyModule = DynamicTypographyModule;
    module.exports.AudioReactiveSyncModule = AudioReactiveSyncModule;
    module.exports.PluggableParticleEngine = PluggableParticleEngine;
    module.exports.RecycledParticlePool = RecycledParticlePool;
    module.exports.BreakdownStasisController = BreakdownStasisController;
    module.exports.ArtworkPhysicsController = ArtworkPhysicsController;
  }

  if (typeof global !== 'undefined' && typeof window === 'undefined') {
    global.customizationModules = customizationModules;
  }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
