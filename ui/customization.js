/**
 * Paprika Advanced Customization Engine
 * ui/customization.js
 *
 * ⚠️ PRE-ALPHA / EXPERIMENTAL NOTICE:
 * This modular customization architecture is in active pre-alpha development
 * and experimental. APIs, preset contracts, and schemas are subject to change.
 *
 * Unified modular customization architecture:
 * - CustomizationRegistry: Canonical schema matching Python backend 1:1, types, defaults, validation & transformers
 * - EventBus: High-performance reactive pub/sub event bus with namespaced bubbling
 * - ReactiveDynamicCssBridge: High-performance O(1) batching via requestAnimationFrame for CSS custom properties
 * - StateStore: In-memory reactive state with preset management, deep diffing against defaults, import/export
 * - BridgeAdapter: Bi-directional bridge to pywebview.api with localStorage fallback & legacy migration
 *
 * Backwards compatible, zero idle overhead, resilient in both browser & Node test environments.
 */

(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Utility Helpers & Normalizers
  // ---------------------------------------------------------------------------

  function isObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
  }

  function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(deepClone);
    const copy = {};
    for (const key of Object.keys(obj)) {
      copy[key] = deepClone(obj[key]);
    }
    return copy;
  }

  function deepMerge(target, source) {
    if (!isObject(target) || !isObject(source)) return deepClone(source);
    const output = deepClone(target);
    for (const key of Object.keys(source)) {
      if (isObject(source[key]) && isObject(output[key])) {
        output[key] = deepMerge(output[key], source[key]);
      } else {
        output[key] = deepClone(source[key]);
      }
    }
    return output;
  }

  function toSnakeCase(str) {
    if (!str) return '';
    return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  }

  // Common aliases for developer friendliness across JS and Python
  const PROPERTY_ALIASES = {
    'lyrics.fontSize': 'lyrics.font_size_scale',
    'lyrics.fontSizeScale': 'lyrics.font_size_scale',
    'lyrics.fontFamily': 'lyrics.font_family',
    'lyrics.fontWeight': 'lyrics.font_weight',
    'lyrics.letterSpacing': 'lyrics.letter_spacing',
    'lyrics.activeScale': 'lyrics.active_scale',
    'lyrics.activeGlow': 'lyrics.active_glow',
    'lyrics.glowStrength': 'lyrics.active_glow',
    'lyrics.activeGlowColor': 'lyrics.active_glow_color',
    'lyrics.glowColor': 'lyrics.active_glow_color',
    'lyrics.activeColor': 'lyrics.active_glow_color',
    'lyrics.lineGap': 'lyrics.line_gap',
    'lyrics.inactiveOpacity': 'lyrics.inactive_opacity',
    'lyrics.secondaryOpacity': 'lyrics.secondary_opacity',
    'lyrics.adlibFontStyle': 'lyrics.adlib_font_style',
    'lyrics.bevelEffect': 'lyrics.bevel_effect',
    'lyrics.textShadow': 'lyrics.text_shadow',
    'lyrics.alignment': 'layout.lyrics_alignment',
    'lyrics.syllableStretchEnabled': 'lyrics.syllable_stretch_enabled',
    'lyrics.syllablePopEnabled': 'lyrics.syllable_pop_enabled',
    'lyrics.fontFamilySecondary': 'lyrics.font_family_secondary',
    'lyrics.fontFamilyAdlib': 'lyrics.font_family_adlib',
    'lyrics.gradientWipeEnabled': 'lyrics.gradient_wipe_enabled',
    'lyrics.variableFontWeightActive': 'lyrics.variable_font_weight_active',
    'lyrics.variableFontWidthActive': 'lyrics.variable_font_width_active',
    'lyrics.scrollInertiaMode': 'lyrics.scroll_inertia_mode',
    'lyrics.scroll_inertia_mode': 'lyrics.scroll_inertia_mode',
    'lyrics.secondaryScale': 'lyrics.secondary_scale',
    'lyrics.secondary_scale': 'lyrics.secondary_scale',
    'lyrics.adlibScale': 'lyrics.adlib_scale',
    'lyrics.adlib_scale': 'lyrics.adlib_scale',

    'visuals.particleType': 'visuals.particle_type',
    'visuals.particleCount': 'visuals.particle_count',
    'visuals.particleDensity': 'visuals.particle_count',
    'visuals.particleSpeed': 'visuals.particle_speed',
    'visuals.particleSize': 'visuals.particle_size',
    'visuals.particleColor': 'visuals.particle_color',
    'visuals.particleOpacity': 'visuals.particle_opacity',
    'visuals.backgroundBlur': 'visuals.background_blur',
    'visuals.backdropBlur': 'visuals.background_blur',
    'visuals.backgroundDim': 'visuals.background_dim',
    'visuals.backdropOpacity': 'visuals.background_dim',
    'visuals.breakdownStasisEnabled': 'visuals.breakdown_stasis_enabled',
    'visuals.auroraMeshEnabled': 'visuals.aurora_mesh_enabled',
    'visuals.visualizerRibbonEnabled': 'visuals.visualizer_ribbon_enabled',

    'reactive.beatSyncEnabled': 'reactive.beat_sync_enabled',
    'reactive.beatPulseEnabled': 'reactive.beat_sync_enabled',
    'reactive.pulseStrength': 'reactive.pulse_strength',
    'reactive.beatPulseIntensity': 'reactive.pulse_strength',
    'reactive.targetAlbumArt': 'reactive.target_album_art',
    'reactive.targetLyricsActive': 'reactive.target_lyrics_active',
    'reactive.targetControls': 'reactive.target_controls',
    'reactive.targetAmbientBloom': 'reactive.target_ambient_bloom',
    'reactive.targetParticles': 'reactive.target_particles',
    'reactive.responseAction': 'reactive.response_action',
    'reactive.springDamping': 'reactive.spring_damping',
    'reactive.syncMotionMode': 'reactive.sync_motion_mode',

    'layout.lyricsAlignment': 'layout.lyrics_alignment',
    'layout.containerPadding': 'layout.container_padding',
    'layout.windowPadding': 'layout.container_padding',
    'layout.sidebarAutoHide': 'layout.sidebar_auto_hide',
    'layout.showAlbumArt': 'layout.show_album_art',
    'layout.showProgressBar': 'layout.show_progress_bar',
    'layout.compactMode': 'layout.compact_mode',
    'layout.lyricsDock': 'layout.lyrics_dock',
    'layout.lyricsOffsetX': 'layout.lyrics_offset_x',
    'layout.lyricsOffsetY': 'layout.lyrics_offset_y',
    'layout.artworkMode': 'layout.artwork_mode',
    'layout.artworkShape': 'layout.artwork_shape',
    'layout.artworkSpinEnabled': 'layout.artwork_spin_enabled',
    'layout.splitColumnDuet': 'layout.split_column_duet',
    'layout.miniTickerMode': 'layout.mini_ticker_mode',

    'themes.accentColor': 'themes.accent_color',
    'themes.backgroundTint': 'themes.background_tint',
    'themes.glowTint': 'themes.glow_tint',
    'themes.colorMode': 'themes.color_mode',
    'themes.themeBgTint': 'themes.theme_bg_tint',
    'themes.theme_bg_tint': 'themes.theme_bg_tint'
  };

  function normalizePath(path) {
    if (!path) return '';
    if (PROPERTY_ALIASES[path]) return PROPERTY_ALIASES[path];

    const parts = path.split('.');
    if (parts.length === 2) {
      const snakeProp = toSnakeCase(parts[1]);
      const canonical = `${parts[0]}.${snakeProp}`;
      if (PROPERTY_ALIASES[canonical]) return PROPERTY_ALIASES[canonical];
      return canonical;
    }
    return path;
  }

  function getPath(obj, path) {
    if (!obj || !path) return obj;
    const norm = normalizePath(path);
    const parts = norm.split('.');
    let curr = obj;
    for (const part of parts) {
      if (curr === null || curr === undefined || !isObject(curr)) return undefined;
      curr = curr[part];
    }
    return curr;
  }

  function setPath(obj, path, value) {
    if (!obj || !path) return;
    const norm = normalizePath(path);
    const parts = norm.split('.');
    let curr = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!isObject(curr[part])) {
        curr[part] = {};
      }
      curr = curr[part];
    }
    curr[parts[parts.length - 1]] = value;
  }

  // ---------------------------------------------------------------------------
  // EventBus: Fast, leak-free reactive pub/sub
  // ---------------------------------------------------------------------------

  class EventBus {
    constructor() {
      this._handlers = new Map();
    }

    on(event, callback) {
      if (typeof callback !== 'function') return () => {};
      if (!this._handlers.has(event)) {
        this._handlers.set(event, new Set());
      }
      this._handlers.get(event).add(callback);
      return () => this.off(event, callback);
    }

    once(event, callback) {
      if (typeof callback !== 'function') return () => {};
      const wrapper = (data) => {
        this.off(event, wrapper);
        callback(data);
      };
      return this.on(event, wrapper);
    }

    off(event, callback) {
      if (!this._handlers.has(event)) return;
      if (!callback) {
        this._handlers.delete(event);
      } else {
        const set = this._handlers.get(event);
        set.delete(callback);
        if (set.size === 0) {
          this._handlers.delete(event);
        }
      }
    }

    emit(event, data) {
      if (!this._handlers.has(event)) return;
      const callbacks = Array.from(this._handlers.get(event));
      for (const cb of callbacks) {
        try {
          cb(data);
        } catch (err) {
          console.error(`[Customization EventBus] Error in handler for '${event}':`, err);
        }
      }
    }

    clear() {
      this._handlers.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // CustomizationRegistry: Canonical Schema & Validation Engine
  // ---------------------------------------------------------------------------

  class CustomizationRegistry {
    constructor() {
      this._domains = new Map();
      this._properties = new Map(); // key: `${domain}.${name}` -> spec
      this._initCanonicalSchemas();
    }

    registerDomain(domainId, meta = {}) {
      if (!domainId || typeof domainId !== 'string') {
        throw new Error('Domain ID must be a non-empty string');
      }
      this._domains.set(domainId, {
        id: domainId,
        label: meta.label || domainId,
        description: meta.description || '',
        order: meta.order || 100
      });
    }

    getDomain(domainId) {
      return this._domains.get(domainId) || null;
    }

    getDomains() {
      return Array.from(this._domains.values()).sort((a, b) => a.order - b.order);
    }

    registerProperty(domainId, propKey, definition) {
      if (!this._domains.has(domainId)) {
        this.registerDomain(domainId);
      }
      if (!propKey || typeof propKey !== 'string') {
        throw new Error('Property key must be a non-empty string');
      }

      const fullKey = `${domainId}.${propKey}`;
      const def = {
        domain: domainId,
        key: propKey,
        type: definition.type || 'string', // 'number', 'string', 'boolean', 'color', 'select'
        default: definition.default !== undefined ? definition.default : null,
        min: typeof definition.min === 'number' ? definition.min : null,
        max: typeof definition.max === 'number' ? definition.max : null,
        step: typeof definition.step === 'number' ? definition.step : null,
        unit: definition.unit || '',
        options: Array.isArray(definition.options) ? [...definition.options] : null,
        cssVar: definition.cssVar || null,
        cssTransform: typeof definition.cssTransform === 'function' ? definition.cssTransform : null,
        validator: typeof definition.validator === 'function' ? definition.validator : null,
        label: definition.label || propKey,
        description: definition.description || '',
        tags: Array.isArray(definition.tags) ? definition.tags : []
      };

      this._properties.set(fullKey, def);
      return def;
    }

    getProperty(domainId, propKey) {
      const rawPath = propKey ? `${domainId}.${propKey}` : domainId;
      const canonical = normalizePath(rawPath);
      return this._properties.get(canonical) || null;
    }

    getProperties(domainId) {
      const result = [];
      const prefix = `${domainId}.`;
      for (const [key, def] of this._properties.entries()) {
        if (key.startsWith(prefix)) {
          result.push(def);
        }
      }
      return result;
    }

    getAllProperties() {
      return Array.from(this._properties.values());
    }

    validate(domainId, propKey, rawValue) {
      const def = this.getProperty(domainId, propKey);
      if (!def) {
        return { valid: true, value: rawValue, error: null };
      }

      let val = rawValue;

      if (val === undefined || val === null) {
        return { valid: true, value: deepClone(def.default), error: null };
      }

      switch (def.type) {
        case 'number': {
          const num = Number(val);
          if (isNaN(num)) {
            return { valid: false, value: def.default, error: `Value for ${domainId}.${propKey} must be a number` };
          }
          let clamped = num;
          if (def.min !== null && clamped < def.min) clamped = def.min;
          if (def.max !== null && clamped > def.max) clamped = def.max;
          val = clamped;
          break;
        }

        case 'boolean': {
          val = Boolean(val);
          break;
        }

        case 'select': {
          if (def.options && def.options.length > 0) {
            const matches = def.options.some((opt) => {
              const optVal = isObject(opt) ? opt.value : opt;
              return optVal === val;
            });
            if (!matches) {
              return {
                valid: false,
                value: def.default,
                error: `Value '${val}' is not in allowed options for ${domainId}.${propKey}`
              };
            }
          }
          break;
        }

        case 'color': {
          if (typeof val !== 'string' || !val.trim()) {
            return { valid: false, value: def.default, error: `Invalid color format for ${domainId}.${propKey}` };
          }
          val = val.trim();
          break;
        }

        case 'string':
        default: {
          val = String(val);
          break;
        }
      }

      if (def.validator) {
        try {
          const res = def.validator(val, def);
          if (res === false || (isObject(res) && !res.valid)) {
            const msg = isObject(res) && res.error ? res.error : `Validation failed for ${domainId}.${propKey}`;
            return { valid: false, value: def.default, error: msg };
          }
        } catch (err) {
          return { valid: false, value: def.default, error: err.message };
        }
      }

      return { valid: true, value: val, error: null };
    }

    validateState(state) {
      if (!isObject(state)) return { valid: false, cleanState: this.getDefaults(), errors: { root: 'Invalid state' } };
      const clean = {};
      const errors = {};

      for (const domain of this._domains.values()) {
        clean[domain.id] = {};
        const domainData = state[domain.id] || {};

        const props = this.getProperties(domain.id);
        for (const def of props) {
          // Allow both snake_case and camelCase lookup in incoming state
          let raw = domainData[def.key];
          if (raw === undefined) {
            for (const [alias, target] of Object.entries(PROPERTY_ALIASES)) {
              if (target === `${domain.id}.${def.key}`) {
                const aliasKey = alias.split('.')[1];
                if (domainData[aliasKey] !== undefined) {
                  raw = domainData[aliasKey];
                  break;
                }
              }
            }
          }

          const res = this.validate(domain.id, def.key, raw);
          clean[domain.id][def.key] = res.value;
          if (!res.valid && res.error) {
            errors[`${domain.id}.${def.key}`] = res.error;
          }
        }
      }

      return {
        valid: Object.keys(errors).length === 0,
        cleanState: clean,
        errors
      };
    }

    getDefaults() {
      const defaults = {};
      for (const domain of this._domains.values()) {
        defaults[domain.id] = {};
        const props = this.getProperties(domain.id);
        for (const def of props) {
          defaults[domain.id][def.key] = deepClone(def.default);
        }
      }
      return defaults;
    }

    getDomainDefaults(domainId) {
      const defaults = {};
      const props = this.getProperties(domainId);
      for (const def of props) {
        defaults[def.key] = deepClone(def.default);
      }
      return defaults;
    }

    _initCanonicalSchemas() {
      // -----------------------------------------------------------------------
      // 1. Domain: lyrics (matches core/customization.py 1:1)
      // -----------------------------------------------------------------------
      this.registerDomain('lyrics', {
        label: 'Lyrics & Typography',
        description: 'Syllable typography, active line scaling, and dynamic text effects',
        order: 10
      });

      this.registerProperty('lyrics', 'font_family', {
        type: 'string',
        default: '',
        cssVar: '--cust-lyrics-font-family',
        label: 'Font Family',
        tags: ['typography', 'font']
      });
      this.registerProperty('lyrics', 'font_size_scale', {
        type: 'number',
        default: 1.0,
        min: 0.5,
        max: 3.0,
        step: 0.05,
        cssVar: '--cust-lyrics-font-size-scale',
        label: 'Font Size Scale',
        tags: ['typography', 'scale']
      });
      this.registerProperty('lyrics', 'font_weight', {
        type: 'number',
        default: 700,
        min: 100,
        max: 900,
        step: 100,
        cssVar: '--cust-lyrics-font-weight',
        label: 'Font Weight',
        tags: ['typography', 'font']
      });
      this.registerProperty('lyrics', 'letter_spacing', {
        type: 'number',
        default: 0.0,
        min: -5.0,
        max: 20.0,
        step: 0.1,
        unit: 'px',
        cssVar: '--cust-lyrics-letter-spacing',
        label: 'Letter Spacing',
        tags: ['typography']
      });
      this.registerProperty('lyrics', 'active_scale', {
        type: 'number',
        default: 1.08,
        min: 1.0,
        max: 2.0,
        step: 0.01,
        cssVar: '--cust-lyrics-active-scale',
        label: 'Active Line Scale',
        tags: ['typography', 'animation']
      });
      this.registerProperty('lyrics', 'active_glow', {
        type: 'number',
        default: 10.0,
        min: 0.0,
        max: 50.0,
        step: 0.5,
        unit: 'px',
        cssVar: '--cust-lyrics-active-glow',
        label: 'Active Bloom Radius',
        tags: ['typography', 'glow']
      });
      this.registerProperty('lyrics', 'active_glow_color', {
        type: 'color',
        default: 'rgba(255, 255, 255, 0.6)',
        cssVar: '--cust-lyrics-active-glow-color',
        label: 'Active Glow Color',
        tags: ['typography', 'color', 'glow']
      });
      this.registerProperty('lyrics', 'line_gap', {
        type: 'number',
        default: 18.0,
        min: 0.0,
        max: 100.0,
        step: 1.0,
        unit: 'px',
        cssVar: '--cust-lyrics-line-gap',
        label: 'Line Gap Spacing',
        tags: ['layout', 'spacing']
      });
      this.registerProperty('lyrics', 'inactive_opacity', {
        type: 'number',
        default: 0.35,
        min: 0.0,
        max: 1.0,
        step: 0.05,
        cssVar: '--cust-lyrics-inactive-opacity',
        label: 'Inactive Line Opacity',
        tags: ['typography']
      });
      this.registerProperty('lyrics', 'secondary_opacity', {
        type: 'number',
        default: 0.5,
        min: 0.0,
        max: 1.0,
        step: 0.05,
        cssVar: '--cust-lyrics-secondary-opacity',
        label: 'Secondary Vocals Opacity',
        tags: ['typography']
      });
      this.registerProperty('lyrics', 'adlib_font_style', {
        type: 'select',
        options: ['normal', 'italic', 'oblique'],
        default: 'italic',
        cssVar: '--cust-lyrics-adlib-style',
        label: 'Ad-lib Font Style',
        tags: ['typography']
      });
      this.registerProperty('lyrics', 'bevel_effect', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-lyrics-bevel',
        label: 'Embossed Bevel Effect',
        tags: ['typography', 'effects']
      });
      this.registerProperty('lyrics', 'text_shadow', {
        type: 'string',
        default: '',
        cssVar: '--cust-lyrics-text-shadow',
        label: 'Custom Text Shadow',
        tags: ['typography', 'effects']
      });
      this.registerProperty('lyrics', 'syllable_stretch_enabled', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-lyrics-syllable-stretch',
        label: 'Kinetic Syllable Stretch',
        tags: ['typography', 'animation']
      });
      this.registerProperty('lyrics', 'syllable_pop_enabled', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-lyrics-syllable-pop',
        label: 'Syllable Pop Transient',
        tags: ['typography', 'animation']
      });
      this.registerProperty('lyrics', 'font_family_secondary', {
        type: 'string',
        default: 'inherit',
        cssVar: '--cust-lyrics-font-family-secondary',
        label: 'Secondary Vocals Font Family',
        tags: ['typography', 'font']
      });
      this.registerProperty('lyrics', 'font_family_adlib', {
        type: 'string',
        default: 'inherit',
        cssVar: '--cust-lyrics-font-family-adlib',
        label: 'Ad-lib Font Family',
        tags: ['typography', 'font']
      });
      this.registerProperty('lyrics', 'gradient_wipe_enabled', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-lyrics-gradient-wipe',
        label: 'Dynamic Gradient Wipe',
        tags: ['typography', 'animation']
      });
      this.registerProperty('lyrics', 'variable_font_weight_active', {
        type: 'number',
        default: 780,
        min: 100,
        max: 900,
        step: 10,
        cssVar: '--cust-lyrics-vf-weight-active',
        label: 'Variable Font Weight (Active)',
        tags: ['typography', 'font']
      });
      this.registerProperty('lyrics', 'variable_font_width_active', {
        type: 'number',
        default: 115,
        min: 50,
        max: 200,
        step: 5,
        cssVar: '--cust-lyrics-vf-width-active',
        label: 'Variable Font Width (Active)',
        tags: ['typography', 'font']
      });
      this.registerProperty('lyrics', 'scroll_inertia_mode', {
        type: 'select',
        options: ['springy', 'smooth', 'subtle', 'off'],
        default: 'springy',
        cssVar: '--cust-scroll-inertia-mode',
        label: 'Scroll Inertia Animation Mode',
        tags: ['lyrics', 'motion', 'scroll']
      });
      this.registerProperty('lyrics', 'secondary_scale', {
        type: 'number',
        default: 0.75,
        min: 0.40,
        max: 1.00,
        step: 0.02,
        cssVar: '--cust-lyrics-secondary-scale',
        label: 'Secondary Lyrics Size Multiplier',
        tags: ['lyrics', 'typography', 'scale']
      });
      this.registerProperty('lyrics', 'adlib_scale', {
        type: 'number',
        default: 0.70,
        min: 0.40,
        max: 1.00,
        step: 0.02,
        cssVar: '--cust-lyrics-adlib-scale',
        label: 'Ad-lib & Harmony Size Multiplier',
        tags: ['lyrics', 'typography', 'scale']
      });

      // -----------------------------------------------------------------------
      // 2. Domain: visuals
      // -----------------------------------------------------------------------
      this.registerDomain('visuals', {
        label: 'Visual Effects',
        description: 'Background atmosphere, particle systems, and canvas shaders',
        order: 20
      });

      this.registerProperty('visuals', 'particle_type', {
        type: 'select',
        options: ['motes', 'stars', 'ripples', 'bokeh', 'fireflies', 'vinyl', 'none'],
        default: 'motes',
        cssVar: '--cust-particle-type',
        label: 'Particle Pattern',
        tags: ['particles']
      });
      this.registerProperty('visuals', 'particle_count', {
        type: 'number',
        default: 60,
        min: 0,
        max: 500,
        step: 5,
        cssVar: '--cust-particle-count',
        label: 'Particle Pool Count',
        tags: ['particles', 'performance']
      });
      this.registerProperty('visuals', 'particle_speed', {
        type: 'number',
        default: 1.0,
        min: 0.1,
        max: 5.0,
        step: 0.1,
        cssVar: '--cust-particle-speed',
        label: 'Particle Drift Speed',
        tags: ['particles']
      });
      this.registerProperty('visuals', 'particle_size', {
        type: 'number',
        default: 4.0,
        min: 1.0,
        max: 30.0,
        step: 0.5,
        unit: 'px',
        cssVar: '--cust-particle-size',
        label: 'Particle Base Radius',
        tags: ['particles']
      });
      this.registerProperty('visuals', 'particle_color', {
        type: 'color',
        default: 'rgba(255, 255, 255, 0.4)',
        cssVar: '--cust-particle-color',
        label: 'Particle Tint Color',
        tags: ['particles', 'color']
      });
      this.registerProperty('visuals', 'particle_opacity', {
        type: 'number',
        default: 0.6,
        min: 0.0,
        max: 1.0,
        step: 0.05,
        cssVar: '--cust-particle-opacity',
        label: 'Particle Canvas Opacity',
        tags: ['particles']
      });
      this.registerProperty('visuals', 'background_blur', {
        type: 'number',
        default: 20.0,
        min: 0.0,
        max: 100.0,
        step: 1.0,
        unit: 'px',
        cssVar: '--cust-bg-blur',
        label: 'Artwork Backdrop Blur',
        tags: ['background']
      });
      this.registerProperty('visuals', 'background_dim', {
        type: 'number',
        default: 0.4,
        min: 0.0,
        max: 1.0,
        step: 0.05,
        cssVar: '--cust-bg-dim',
        label: 'Backdrop Scrim Dimming',
        tags: ['background']
      });
      this.registerProperty('visuals', 'breakdown_stasis_enabled', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-visuals-breakdown-stasis',
        label: 'Breakdown Stasis Calm',
        tags: ['visuals', 'beat']
      });
      this.registerProperty('visuals', 'aurora_mesh_enabled', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-visuals-aurora-mesh',
        label: 'Ambient Aurora Mesh',
        tags: ['visuals', 'background']
      });
      this.registerProperty('visuals', 'visualizer_ribbon_enabled', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-visuals-visualizer-ribbon',
        label: 'Acoustic Visualizer Ribbon',
        tags: ['visuals', 'audio']
      });

      // -----------------------------------------------------------------------
      // 3. Domain: reactive
      // -----------------------------------------------------------------------
      this.registerDomain('reactive', {
        label: 'Audio Reactive Sync',
        description: 'Beat-synced pulses, spring physics, and coordinated element motion',
        order: 30
      });

      this.registerProperty('reactive', 'beat_sync_enabled', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-beat-sync-enabled',
        label: 'Beat Impulses Enabled',
        tags: ['audio', 'beat']
      });
      this.registerProperty('reactive', 'pulse_strength', {
        type: 'number',
        default: 1.0,
        min: 0.0,
        max: 3.0,
        step: 0.1,
        cssVar: '--cust-pulse-strength',
        label: 'Impulse Amplitude',
        tags: ['audio', 'motion']
      });
      this.registerProperty('reactive', 'target_album_art', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-reactive-target-art',
        label: 'Pulse Album Artwork',
        tags: ['targets']
      });
      this.registerProperty('reactive', 'target_lyrics_active', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-reactive-target-lyrics',
        label: 'Pulse Active Lyric',
        tags: ['targets']
      });
      this.registerProperty('reactive', 'target_controls', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-reactive-target-controls',
        label: 'Pulse Playback Controls',
        tags: ['targets']
      });
      this.registerProperty('reactive', 'target_ambient_bloom', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-reactive-target-bloom',
        label: 'Pulse Ambient Bloom',
        tags: ['targets']
      });
      this.registerProperty('reactive', 'target_particles', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-reactive-target-particles',
        label: 'Surge Particle Velocity',
        tags: ['targets']
      });
      this.registerProperty('reactive', 'response_action', {
        type: 'select',
        options: ['scale', 'tilt', 'glow', 'chromatic', 'all'],
        default: 'scale',
        cssVar: '--cust-reactive-action',
        label: 'Kinetic Response Action',
        tags: ['motion']
      });
      this.registerProperty('reactive', 'spring_damping', {
        type: 'number',
        default: 0.7,
        min: 0.1,
        max: 1.0,
        step: 0.05,
        cssVar: '--cust-spring-damping',
        label: 'Spring Oscillation Damping',
        tags: ['motion', 'physics']
      });
      this.registerProperty('reactive', 'sync_motion_mode', {
        type: 'select',
        options: ['synchronized', 'alternating', 'subtle', 'off'],
        default: 'synchronized',
        cssVar: '--cust-sync-motion-mode',
        label: 'Coordinated Motion Mode',
        tags: ['motion']
      });

      // -----------------------------------------------------------------------
      // 4. Domain: layout
      // -----------------------------------------------------------------------
      this.registerDomain('layout', {
        label: 'Interface & Layout',
        description: 'Lyrics alignment, container geometry, and UI component toggles',
        order: 40
      });

      this.registerProperty('layout', 'lyrics_alignment', {
        type: 'select',
        options: ['left', 'center', 'right'],
        default: 'left',
        cssVar: '--cust-lyrics-align',
        label: 'Horizontal Lyrics Alignment',
        tags: ['layout']
      });
      this.registerProperty('layout', 'container_padding', {
        type: 'number',
        default: 24,
        min: 0,
        max: 100,
        step: 2,
        unit: 'px',
        cssVar: '--cust-container-padding',
        label: 'Container Border Padding',
        tags: ['layout']
      });
      this.registerProperty('layout', 'sidebar_auto_hide', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-sidebar-auto-hide',
        label: 'Auto-hide Sidebar on Play',
        tags: ['layout']
      });
      this.registerProperty('layout', 'show_album_art', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-show-album-art',
        label: 'Display Album Artwork',
        tags: ['layout']
      });
      this.registerProperty('layout', 'show_progress_bar', {
        type: 'boolean',
        default: true,
        cssVar: '--cust-show-progress-bar',
        label: 'Display Progress Timeline',
        tags: ['layout']
      });
      this.registerProperty('layout', 'compact_mode', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-compact-mode',
        label: 'Compact Mode',
        tags: ['layout']
      });
      this.registerProperty('layout', 'orientation', {
        type: 'select',
        options: ['horizontal', 'vertical-right', 'vertical-left', 'vertical-column'],
        default: 'horizontal',
        cssVar: '--cust-layout-orientation',
        label: 'Layout Orientation',
        tags: ['layout']
      });
      this.registerProperty('layout', 'lyrics_dock', {
        type: 'select',
        options: ['center', 'left', 'right', 'top', 'bottom'],
        default: 'center',
        cssVar: '--cust-lyrics-dock',
        label: 'Lyrics Dock Position',
        tags: ['layout']
      });
      this.registerProperty('layout', 'lyrics_offset_x', {
        type: 'number',
        default: 0,
        min: -500,
        max: 500,
        step: 5,
        unit: 'px',
        cssVar: '--cust-lyrics-offset-x',
        label: 'Lyrics Offset X',
        tags: ['layout', 'geometry']
      });
      this.registerProperty('layout', 'lyrics_offset_y', {
        type: 'number',
        default: 0,
        min: -500,
        max: 500,
        step: 5,
        unit: 'px',
        cssVar: '--cust-lyrics-offset-y',
        label: 'Lyrics Offset Y',
        tags: ['layout', 'geometry']
      });
      this.registerProperty('layout', 'artwork_mode', {
        type: 'select',
        options: ['card', 'vinyl', 'silhouette', 'hidden'],
        default: 'card',
        cssVar: '--cust-artwork-mode',
        label: 'Artwork Mode',
        tags: ['layout', 'artwork']
      });
      this.registerProperty('layout', 'artwork_shape', {
        type: 'select',
        options: ['rounded', 'circle', 'squircle', 'diamond', 'pill', 'vinyl'],
        default: 'rounded',
        cssVar: '--cust-artwork-shape',
        label: 'Artwork Shape',
        tags: ['layout', 'artwork']
      });
      this.registerProperty('layout', 'artwork_spin_enabled', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-artwork-spin',
        label: 'Artwork Spin Rotation',
        tags: ['layout', 'artwork', 'animation']
      });
      this.registerProperty('layout', 'split_column_duet', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-split-column-duet',
        label: 'Split Column Duet',
        tags: ['layout']
      });
      this.registerProperty('layout', 'mini_ticker_mode', {
        type: 'boolean',
        default: false,
        cssVar: '--cust-mini-ticker-mode',
        label: 'Mini Ticker Mode',
        tags: ['layout']
      });

      // -----------------------------------------------------------------------
      // 5. Domain: themes
      // -----------------------------------------------------------------------
      this.registerDomain('themes', {
        label: 'Color & Themes',
        description: 'Accent palette, background tints, and dynamic artwork color matching',
        order: 50
      });

      this.registerProperty('themes', 'accent_color', {
        type: 'color',
        default: '#ff3366',
        cssVar: '--cust-accent-color',
        label: 'Primary Accent Color',
        tags: ['theme', 'color']
      });
      this.registerProperty('themes', 'background_tint', {
        type: 'color',
        default: '#0a0a0c',
        cssVar: '--cust-bg-tint',
        label: 'Deep Background Tint',
        tags: ['theme', 'color']
      });
      this.registerProperty('themes', 'glow_tint', {
        type: 'color',
        default: '#ff3366',
        cssVar: '--cust-glow-tint',
        label: 'Ambient Halo Glow Tint',
        tags: ['theme', 'color']
      });
      this.registerProperty('themes', 'color_mode', {
        type: 'select',
        options: ['artwork_adaptive', 'custom', 'monochrome', 'vibrant'],
        default: 'artwork_adaptive',
        cssVar: '--cust-color-mode',
        label: 'Theme Generation Mode',
        tags: ['theme']
      });
      this.registerProperty('themes', 'theme_bg_tint', {
        type: 'color',
        default: 'rgba(140, 100, 255, 0.20)',
        cssVar: '--cust-theme-bg-tint',
        label: 'Atmospheric Background Hue Tint',
        tags: ['theme', 'color', 'background']
      });
    }
  }

  // ---------------------------------------------------------------------------
  // ReactiveDynamicCssBridge: High-performance O(1) batching via RAF
  // ---------------------------------------------------------------------------

  class ReactiveDynamicCssBridge {
    constructor(registry, eventBus) {
      this._registry = registry;
      this._events = eventBus;
      this._appliedVars = new Map();
      this._pendingWrites = new Map();
      this._rafId = null;

      this._flushBound = this._flush.bind(this);
    }

    setVariable(cssVar, rawValue, unit = '') {
      if (!cssVar) return;
      let formatted = rawValue;
      if (typeof rawValue === 'number' && unit) {
        formatted = `${rawValue}${unit}`;
      } else if (rawValue === null || rawValue === undefined) {
        formatted = '';
      } else {
        formatted = String(rawValue);
      }

      if (this._appliedVars.get(cssVar) === formatted) {
        this._pendingWrites.delete(cssVar);
        return;
      }

      this._pendingWrites.set(cssVar, formatted);
      this._scheduleFlush();
    }

    setProperty(domainId, propKey, value) {
      const def = this._registry.getProperty(domainId, propKey);
      if (!def || !def.cssVar) return;

      let formattedValue = value;
      if (def.cssTransform) {
        try {
          formattedValue = def.cssTransform(value, def);
        } catch (e) {
          console.warn(`[DynamicCssBridge] Transform error for ${domainId}.${propKey}:`, e);
        }
      } else if (typeof value === 'number' && def.unit) {
        formattedValue = `${value}${def.unit}`;
      }

      this.setVariable(def.cssVar, formattedValue);

      // Also support legacy / variant css variable bridges if applicable
      if (def.cssVar === '--cust-lyrics-font-size-scale') {
        const basePx = Math.round(30 * (typeof value === 'number' ? value : 1.0));
        this.setVariable('--cust-lyric-font-size', `${basePx}px`);
        this.setVariable('--lyric-font-size', `${basePx}px`);
      }
      if (def.cssVar === '--cust-lyrics-font-weight') {
        this.setVariable('--cust-lyric-font-weight', String(value));
        this.setVariable('--lyric-font-weight', String(value));
      }
      if (def.cssVar === '--cust-lyrics-active-scale') {
        this.setVariable('--cust-lyric-active-scale', String(value));
      }
      if (def.cssVar === '--cust-lyrics-active-glow') {
        this.setVariable('--cust-lyric-glow-strength', String((Number(value) || 0) / 25.0));
      }
    }

    applyState(state) {
      if (!isObject(state)) return;
      for (const domainId of Object.keys(state)) {
        const domainState = state[domainId];
        if (!isObject(domainState)) continue;
        for (const propKey of Object.keys(domainState)) {
          this.setProperty(domainId, propKey, domainState[propKey]);
        }
      }
    }

    flushNow() {
      if (this._rafId !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(this._rafId);
        } else if (typeof clearTimeout === 'function') {
          clearTimeout(this._rafId);
        }
        this._rafId = null;
      }
      this._flush();
    }

    _scheduleFlush() {
      if (this._rafId !== null || this._pendingWrites.size === 0) return;

      if (typeof requestAnimationFrame === 'function') {
        this._rafId = requestAnimationFrame(this._flushBound);
      } else if (typeof setTimeout === 'function') {
        this._rafId = setTimeout(this._flushBound, 0);
      } else {
        this._flush();
      }
    }

    _flush() {
      this._rafId = null;
      if (this._pendingWrites.size === 0) return;

      const targetStyle = (typeof document !== 'undefined' && document.documentElement)
        ? document.documentElement.style
        : null;

      const committed = {};

      for (const [varName, val] of this._pendingWrites.entries()) {
        if (targetStyle && typeof targetStyle.setProperty === 'function') {
          if (val === '') {
            targetStyle.removeProperty(varName);
          } else {
            targetStyle.setProperty(varName, val);
          }
        }

        // Synchronize DOM attributes and helper classes
        if (typeof document !== 'undefined' && document.documentElement) {
          if (varName === '--cust-layout-orientation') {
            if (typeof document.documentElement.setAttribute === 'function') {
              document.documentElement.setAttribute('data-orientation', val || 'horizontal');
            }
          } else if (varName === '--cust-lyrics-dock') {
            if (typeof document.documentElement.setAttribute === 'function') {
              document.documentElement.setAttribute('data-lyrics-dock', val || 'center');
            }
            if (typeof document.getElementById === 'function') {
              const lyricsContainer = document.getElementById('lyrics-container');
              if (lyricsContainer && typeof lyricsContainer.setAttribute === 'function') {
                lyricsContainer.setAttribute('data-lyrics-dock', val || 'center');
              }
            }
          } else if (varName === '--cust-artwork-shape') {
            if (typeof document.documentElement.setAttribute === 'function') {
              document.documentElement.setAttribute('data-artwork-shape', val || 'rounded');
            }
            if (typeof document.querySelectorAll === 'function') {
              const artWraps = document.querySelectorAll('.cover-art-wrap, .cover-art, .float-art-wrap, .side-art-wrap');
              const shapes = ['rounded', 'circle', 'squircle', 'diamond', 'pill', 'vinyl'];
              artWraps.forEach(el => {
                if (el && el.classList) {
                  shapes.forEach(s => el.classList.remove('art-shape-' + s));
                  el.classList.add('art-shape-' + (val || 'rounded'));
                }
              });
            }
          } else if (varName === '--cust-artwork-spin') {
            const spin = val === 'true' || val === '1' || val === true;
            if (typeof document.documentElement.setAttribute === 'function') {
              document.documentElement.setAttribute('data-artwork-spin', spin ? 'true' : 'false');
            }
            if (document.body && document.body.classList) {
              document.body.classList.toggle('artwork-spin', spin);
            }
          } else if (varName === '--cust-mini-ticker-mode') {
            const mini = val === 'true' || val === '1' || val === true;
            if (document.body && document.body.classList) {
              document.body.classList.toggle('mini-ticker-mode', mini);
            }
          }
        }

        this._appliedVars.set(varName, val);
        committed[varName] = val;
      }

      this._pendingWrites.clear();

      if (this._events) {
        this._events.emit('css:flush', { vars: committed });
      }
    }

    getApplied(varName) {
      return this._appliedVars.get(varName);
    }

    getAllApplied() {
      const result = {};
      for (const [k, v] of this._appliedVars.entries()) {
        result[k] = v;
      }
      return result;
    }
  }

  // ---------------------------------------------------------------------------
  // Canonical Built-in Presets (Aligned with core/customization.py 1:1)
  // ---------------------------------------------------------------------------

  const BUILTIN_PRESETS = {
    default: {
      id: 'default',
      name: 'Default',
      description: 'Standard balanced Paprika visual styling and typography',
      builtIn: true,
      author: 'Paprika',
      state: {
        themes: {
          theme_bg_tint: 'rgba(140, 100, 255, 0.20)'
        }
      }
    },
    minimalist: {
      id: 'minimalist',
      name: 'Minimalist',
      description: 'Distraction-free, crisp typography with particles disabled and calm motion',
      builtIn: true,
      author: 'Paprika',
      state: {
        lyrics: {
          font_size_scale: 1.0,
          font_weight: 500,
          active_scale: 1.02,
          active_glow: 0.0,
          line_gap: 14.0
        },
        visuals: {
          particle_type: 'none',
          particle_count: 0,
          background_blur: 0.0,
          background_dim: 0.6
        },
        reactive: {
          pulse_strength: 0.2,
          response_action: 'scale',
          spring_damping: 0.9
        },
        layout: {
          lyrics_alignment: 'left',
          show_album_art: false
        },
        themes: {
          color_mode: 'monochrome',
          accent_color: '#ffffff',
          theme_bg_tint: 'rgba(120, 140, 180, 0.12)'
        }
      }
    },
    cyberpunk: {
      id: 'cyberpunk',
      name: 'Cyberpunk',
      description: 'Neon-drenched high contrast with chromatic bursts and energetic star particles',
      builtIn: true,
      author: 'Paprika',
      state: {
        lyrics: {
          font_size_scale: 1.15,
          font_weight: 800,
          active_scale: 1.15,
          active_glow: 25.0,
          active_glow_color: '#00ffcc',
          bevel_effect: true,
          letter_spacing: 1.5
        },
        visuals: {
          particle_type: 'stars',
          particle_count: 120,
          particle_speed: 2.0,
          particle_color: '#ff0055',
          particle_opacity: 0.85
        },
        reactive: {
          pulse_strength: 1.8,
          response_action: 'chromatic',
          target_controls: true,
          spring_damping: 0.5
        },
        themes: {
          accent_color: '#00ffcc',
          glow_tint: '#ff0055',
          background_tint: '#080812',
          color_mode: 'custom',
          theme_bg_tint: 'rgba(180, 0, 255, 0.28)'
        }
      }
    },
    ambient_neon: {
      id: 'ambient_neon',
      name: 'Ambient Neon',
      description: 'Lush, dreamy glow with floating bokeh particles and fluid spring dynamics',
      builtIn: true,
      author: 'Paprika',
      state: {
        lyrics: {
          font_size_scale: 1.05,
          font_weight: 600,
          active_scale: 1.1,
          active_glow: 20.0,
          active_glow_color: '#bd00ff',
          line_gap: 22.0
        },
        visuals: {
          particle_type: 'bokeh',
          particle_count: 45,
          particle_speed: 0.7,
          particle_size: 12.0,
          particle_color: 'rgba(189, 0, 255, 0.45)',
          background_blur: 35.0
        },
        reactive: {
          pulse_strength: 1.2,
          response_action: 'glow',
          spring_damping: 0.8
        },
        themes: {
          accent_color: '#bd00ff',
          glow_tint: '#7000ff',
          color_mode: 'artwork_adaptive',
          theme_bg_tint: 'rgba(0, 245, 210, 0.25)'
        }
      }
    },
    kinetic_karaoke: {
      id: 'kinetic_karaoke',
      name: 'Kinetic Karaoke',
      description: 'Energetic, punchy lyrics scaling and heavy beat synchronization for singing along',
      builtIn: true,
      author: 'Paprika',
      state: {
        lyrics: {
          font_size_scale: 1.25,
          font_weight: 800,
          active_scale: 1.25,
          active_glow: 15.0,
          active_glow_color: '#ffbb00',
          line_gap: 24.0
        },
        visuals: {
          particle_type: 'ripples',
          particle_count: 80,
          particle_speed: 1.4,
          particle_color: '#ffbb00'
        },
        reactive: {
          pulse_strength: 2.2,
          response_action: 'scale',
          target_album_art: true,
          target_lyrics_active: true,
          spring_damping: 0.6,
          sync_motion_mode: 'synchronized'
        },
        layout: {
          lyrics_alignment: 'center'
        },
        themes: {
          accent_color: '#ffbb00',
          glow_tint: '#ff5500',
          color_mode: 'vibrant',
          theme_bg_tint: 'rgba(255, 50, 130, 0.22)'
        }
      }
    },
    studio_oled: {
      id: 'studio_oled',
      name: 'Studio OLED',
      description: 'Ultra-pure dark backdrop, crisp monochrome typography, and zero particle distraction',
      builtIn: true,
      author: 'Paprika',
      state: {
        lyrics: {
          font_size_scale: 1.0,
          font_weight: 600,
          active_scale: 1.05,
          active_glow: 6.0,
          active_glow_color: 'rgba(255, 255, 255, 0.4)',
          variable_font_weight_active: 700,
          variable_font_width_active: 100,
          line_gap: 16.0
        },
        visuals: {
          particle_type: 'none',
          particle_count: 0,
          background_blur: 0.0,
          background_dim: 1.0,
          aurora_mesh_enabled: false
        },
        reactive: {
          pulse_strength: 0.4,
          response_action: 'scale',
          spring_damping: 0.85
        },
        layout: {
          artwork_mode: 'card',
          artwork_shape: 'squircle'
        },
        themes: {
          accent_color: '#ffffff',
          background_tint: '#000000',
          glow_tint: '#ffffff',
          color_mode: 'monochrome',
          theme_bg_tint: 'rgba(0, 0, 0, 0)'
        }
      }
    },
    apple_classical: {
      id: 'apple_classical',
      name: 'Apple Classical',
      description: 'Refined editorial typography, warm gold accents, and serene ambient dynamics',
      builtIn: true,
      author: 'Paprika',
      state: {
        lyrics: {
          font_size_scale: 1.05,
          font_weight: 500,
          active_scale: 1.04,
          active_glow: 8.0,
          active_glow_color: 'rgba(212, 175, 55, 0.5)',
          adlib_font_style: 'italic',
          variable_font_weight_active: 600,
          variable_font_width_active: 105,
          line_gap: 20.0
        },
        visuals: {
          particle_type: 'bokeh',
          particle_count: 30,
          particle_speed: 0.5,
          particle_size: 8.0,
          particle_color: 'rgba(212, 175, 55, 0.3)',
          background_blur: 40.0,
          aurora_mesh_enabled: true
        },
        reactive: {
          pulse_strength: 0.6,
          response_action: 'glow',
          spring_damping: 0.85,
          sync_motion_mode: 'subtle'
        },
        layout: {
          lyrics_alignment: 'center',
          artwork_shape: 'squircle',
          artwork_mode: 'card'
        },
        themes: {
          accent_color: '#d4af37',
          background_tint: '#12100e',
          glow_tint: '#e6ca65',
          color_mode: 'custom',
          theme_bg_tint: 'rgba(225, 165, 80, 0.24)'
        }
      }
    },
    retro_arcade: {
      id: 'retro_arcade',
      name: 'Retro Arcade',
      description: 'Nostalgic CRT raster glow, high-energy particle cascades, and spinning vinyl disc',
      builtIn: true,
      author: 'Paprika',
      state: {
        lyrics: {
          font_size_scale: 1.18,
          font_weight: 800,
          active_scale: 1.18,
          active_glow: 20.0,
          active_glow_color: '#00f0ff',
          bevel_effect: true,
          syllable_pop_enabled: true,
          variable_font_weight_active: 850,
          variable_font_width_active: 125,
          line_gap: 22.0
        },
        visuals: {
          particle_type: 'stars',
          particle_count: 140,
          particle_speed: 2.2,
          particle_color: '#00f0ff',
          aurora_mesh_enabled: true,
          visualizer_ribbon_enabled: true
        },
        reactive: {
          pulse_strength: 1.9,
          response_action: 'all',
          target_controls: true,
          spring_damping: 0.55,
          sync_motion_mode: 'synchronized'
        },
        layout: {
          artwork_shape: 'vinyl',
          artwork_mode: 'vinyl',
          artwork_spin_enabled: false
        },
        themes: {
          accent_color: '#ff007f',
          glow_tint: '#00f0ff',
          background_tint: '#0b001a',
          color_mode: 'vibrant',
          theme_bg_tint: 'rgba(30, 80, 240, 0.28)'
        }
      }
    }
  };

  // ---------------------------------------------------------------------------
  // StateStore: In-Memory Reactive State, Presets & Diffing
  // ---------------------------------------------------------------------------

  class StateStore {
    constructor(registry, eventBus, cssBridge) {
      this._registry = registry;
      this._events = eventBus;
      this._cssBridge = cssBridge;

      this._state = this._registry.getDefaults();
      this._userPresets = new Map();
      this._currentPresetId = 'default';
    }

    get(path) {
      if (!path) return deepClone(this._state);
      const norm = normalizePath(path);
      const val = getPath(this._state, norm);
      return deepClone(val);
    }

    set(path, rawValue, options = {}) {
      if (!path || typeof path !== 'string') return false;

      const norm = normalizePath(path);
      const parts = norm.split('.');
      if (parts.length < 2) {
        console.warn(`[Customization Store] Invalid path: ${path}`);
        return false;
      }

      const domainId = parts[0];
      const propKey = parts.slice(1).join('.');

      // Validation
      const validation = this._registry.validate(domainId, propKey, rawValue);
      const cleanValue = validation.value;
      const oldValue = getPath(this._state, norm);

      if (oldValue === cleanValue) return true;

      setPath(this._state, norm, cleanValue);

      if (this._cssBridge && !options.skipCss) {
        this._cssBridge.setProperty(domainId, propKey, cleanValue);
      }

      if (this._events && !options.silent) {
        const payload = {
          path: norm,
          originalPath: path,
          domain: domainId,
          property: propKey,
          value: cleanValue,
          oldValue,
          state: this.get()
        };
        this._events.emit(`change:${domainId}:${propKey}`, payload);
        this._events.emit(`change:${domainId}`, payload);
        this._events.emit('change', payload);

        // Also emit on alias if path had one
        if (path !== norm) {
          this._events.emit(`change:${path}`, payload);
        }
      }

      return true;
    }

    setBatch(updates, options = {}) {
      if (!isObject(updates)) return false;

      const changes = [];

      for (const domainId of Object.keys(updates)) {
        const domainData = updates[domainId];
        if (!isObject(domainData)) continue;

        for (const rawPropKey of Object.keys(domainData)) {
          const raw = domainData[rawPropKey];
          const norm = normalizePath(`${domainId}.${rawPropKey}`);
          const parts = norm.split('.');
          const canonicalDomain = parts[0];
          const canonicalProp = parts.slice(1).join('.');

          const validation = this._registry.validate(canonicalDomain, canonicalProp, raw);
          const cleanValue = validation.value;
          const oldValue = getPath(this._state, norm);

          if (oldValue !== cleanValue) {
            setPath(this._state, norm, cleanValue);
            if (this._cssBridge && !options.skipCss) {
              this._cssBridge.setProperty(canonicalDomain, canonicalProp, cleanValue);
            }
            changes.push({
              path: norm,
              domain: canonicalDomain,
              property: canonicalProp,
              value: cleanValue,
              oldValue
            });
          }
        }
      }

      if (changes.length > 0 && this._events && !options.silent) {
        this._events.emit('batch-change', { changes, state: this.get() });
        for (const change of changes) {
          const payload = { ...change, state: this.get() };
          this._events.emit(`change:${change.domain}:${change.property}`, payload);
          this._events.emit(`change:${change.domain}`, payload);
          this._events.emit('change', payload);
        }
      }

      return true;
    }

    reset(domainId = null) {
      if (domainId) {
        const defaults = this._registry.getDomainDefaults(domainId);
        this.setBatch({ [domainId]: defaults });
        if (this._events) {
          this._events.emit('reset', { domain: domainId });
        }
      } else {
        const defaults = this._registry.getDefaults();
        this._state = defaults;
        this._currentPresetId = 'default';
        if (this._cssBridge) {
          this._cssBridge.applyState(this._state);
        }
        if (this._events) {
          this._events.emit('reset', { domain: null });
          this._events.emit('change', { state: this.get() });
        }
      }
    }

    getDiff(baseState = null) {
      const base = baseState || this._registry.getDefaults();
      const diff = {};

      for (const domainId of Object.keys(this._state)) {
        const domainState = this._state[domainId];
        const baseDomain = base[domainId] || {};
        for (const propKey of Object.keys(domainState)) {
          const curr = domainState[propKey];
          const orig = baseDomain[propKey];
          if (curr !== orig) {
            if (!diff[domainId]) diff[domainId] = {};
            diff[domainId][propKey] = curr;
          }
        }
      }

      return diff;
    }

    // --- Preset Lifecycle ---

    listPresets() {
      const presets = [];

      for (const p of Object.values(BUILTIN_PRESETS)) {
        presets.push({
          id: p.id,
          name: p.name,
          description: p.description,
          builtIn: true,
          author: p.author || 'Paprika',
          active: this._currentPresetId === p.id
        });
      }

      for (const p of this._userPresets.values()) {
        presets.push({
          id: p.id,
          name: p.name,
          description: p.description || 'Custom preset',
          builtIn: false,
          author: p.author || 'user',
          active: this._currentPresetId === p.id,
          createdAt: p.createdAt
        });
      }

      return presets;
    }

    getPreset(presetId) {
      if (BUILTIN_PRESETS[presetId]) {
        return deepClone(BUILTIN_PRESETS[presetId]);
      }
      if (this._userPresets.has(presetId)) {
        return deepClone(this._userPresets.get(presetId));
      }
      return null;
    }

    applyPreset(presetIdOrObject) {
      let targetState = null;
      let presetId = null;

      if (typeof presetIdOrObject === 'string') {
        presetId = presetIdOrObject;
        const preset = this.getPreset(presetId);
        if (!preset) {
          console.warn(`[Customization Store] Preset not found: ${presetId}`);
          return false;
        }
        targetState = deepMerge(this._registry.getDefaults(), preset.state);
      } else if (isObject(presetIdOrObject)) {
        presetId = presetIdOrObject.id || 'custom';
        targetState = deepMerge(this._registry.getDefaults(), presetIdOrObject.state || presetIdOrObject);
      }

      if (!targetState) return false;

      const validated = this._registry.validateState(targetState);
      this._state = validated.cleanState;
      this._currentPresetId = presetId;

      if (this._cssBridge) {
        this._cssBridge.applyState(this._state);
      }

      if (this._events) {
        this._events.emit('preset:applied', {
          presetId,
          preset: this.getPreset(presetId),
          state: this.get()
        });
        this._events.emit('change', {
          reason: 'preset:applied',
          presetId,
          state: this.get()
        });
      }

      return true;
    }

    savePreset(name, optionalState = null) {
      if (!name || typeof name !== 'string') {
        throw new Error('Preset name must be a non-empty string');
      }

      const id = 'preset_' + name.toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '_' + Date.now().toString(36);
      const stateToSave = optionalState ? deepClone(optionalState) : this.get();

      const preset = {
        id,
        name: name.trim(),
        description: 'User created preset',
        builtIn: false,
        author: 'user',
        createdAt: new Date().toISOString(),
        state: stateToSave
      };

      this._userPresets.set(id, preset);

      if (this._events) {
        this._events.emit('preset:saved', { presetId: id, preset });
      }

      return preset;
    }

    deletePreset(presetId) {
      if (BUILTIN_PRESETS[presetId]) {
        console.warn(`[Customization Store] Cannot delete built-in preset '${presetId}'`);
        return false;
      }

      if (!this._userPresets.has(presetId)) {
        return false;
      }

      this._userPresets.delete(presetId);

      if (this._currentPresetId === presetId) {
        this._currentPresetId = 'default';
      }

      if (this._events) {
        this._events.emit('preset:deleted', { presetId });
      }

      return true;
    }

    exportPreset(presetId) {
      const preset = this.getPreset(presetId);
      if (!preset) return null;
      return JSON.stringify(preset, null, 2);
    }

    importPreset(jsonOrObj) {
      try {
        let obj = typeof jsonOrObj === 'string' ? JSON.parse(jsonOrObj) : jsonOrObj;
        if (obj && isObject(obj.preset)) {
          obj = obj.preset;
        }
        if (!isObject(obj) || !obj.name || !obj.state) {
          throw new Error('Invalid preset structure: requires name and state');
        }

        const id = obj.id || ('preset_' + Date.now().toString(36));
        const cleanState = this._registry.validateState(obj.state).cleanState;

        const preset = {
          id,
          name: String(obj.name).trim(),
          description: obj.description || 'Imported preset',
          builtIn: false,
          author: obj.author || 'user',
          createdAt: obj.createdAt || new Date().toISOString(),
          state: cleanState
        };

        this._userPresets.set(id, preset);

        if (this._events) {
          this._events.emit('preset:imported', { presetId: id, preset });
        }

        return preset;
      } catch (err) {
        console.error('[Customization Store] Failed to import preset:', err);
        return null;
      }
    }

    exportState() {
      return JSON.stringify(this._state, null, 2);
    }

    importState(jsonOrObj) {
      try {
        const obj = typeof jsonOrObj === 'string' ? JSON.parse(jsonOrObj) : jsonOrObj;
        const validated = this._registry.validateState(obj);
        this._state = validated.cleanState;

        if (this._cssBridge) {
          this._cssBridge.applyState(this._state);
        }

        if (this._events) {
          this._events.emit('change', { state: this.get(), reason: 'import' });
        }

        return true;
      } catch (err) {
        console.error('[Customization Store] Failed to import state:', err);
        return false;
      }
    }

    getCurrentPresetId() {
      return this._currentPresetId;
    }

    setUserPresets(presetsList) {
      if (!Array.isArray(presetsList)) return;
      this._userPresets.clear();
      for (const p of presetsList) {
        if (p && p.id && !p.builtIn && !p.builtin) {
          this._userPresets.set(p.id, p);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // BridgeAdapter: Interacts with pywebview.api & LocalStorage Fallback
  // ---------------------------------------------------------------------------

  const STORAGE_KEY_STATE = 'paprika_customization_state';
  const STORAGE_KEY_PRESETS = 'paprika_customization_presets';

  class BridgeAdapter {
    constructor(store, eventBus) {
      this._store = store;
      this._events = eventBus;
      this._saveTimer = null;
      this._debounceMs = 300;
      this._backendConnected = false;

      if (this._events) {
        this._events.on('change', () => this.scheduleSave());
      }
    }

    _getApi() {
      if (typeof window !== 'undefined' && window.pywebview && window.pywebview.api) {
        return window.pywebview.api;
      }
      return null;
    }

    async init() {
      const api = this._getApi();
      if (api && typeof api.customization_get_state === 'function') {
        this._backendConnected = true;
        await this._loadFromBackend(api);
      } else {
        this._loadFromLocalStorage();

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('pywebviewready', async () => {
            const readyApi = this._getApi();
            if (readyApi && typeof readyApi.customization_get_state === 'function') {
              this._backendConnected = true;
              await this._loadFromBackend(readyApi);
            }
          });
        }
      }
    }

    async _loadFromBackend(api) {
      try {
        const stateRes = await api.customization_get_state();
        if (stateRes && isObject(stateRes)) {
          const targetState = stateRes.state || stateRes;
          this._store.importState(targetState);
          if (stateRes.active_preset_id) {
            this._store._currentPresetId = stateRes.active_preset_id;
          }
        }

        if (typeof api.customization_list_presets === 'function') {
          const presetsRes = await api.customization_list_presets();
          if (presetsRes && isObject(presetsRes)) {
            const list = presetsRes.custom_presets || presetsRes.user_presets || presetsRes.user || presetsRes.presets || [];
            if (Array.isArray(list)) {
              this._store.setUserPresets(list);
            }
            if (presetsRes.active_preset_id) {
              this._store._currentPresetId = presetsRes.active_preset_id;
            }
          }
        }

        if (this._events) {
          this._events.emit('sync', { source: 'backend', state: this._store.get() });
        }
      } catch (err) {
        console.warn('[BridgeAdapter] Backend load failed, falling back to local storage:', err);
        this._loadFromLocalStorage();
      }
    }

    _loadFromLocalStorage() {
      if (typeof localStorage === 'undefined') return;

      try {
        const rawState = localStorage.getItem(STORAGE_KEY_STATE);
        if (rawState) {
          const parsed = JSON.parse(rawState);
          this._store.importState(parsed);
        } else {
          this._migrateLegacySettings();
        }

        const rawPresets = localStorage.getItem(STORAGE_KEY_PRESETS);
        if (rawPresets) {
          const parsedPresets = JSON.parse(rawPresets);
          if (Array.isArray(parsedPresets)) {
            this._store.setUserPresets(parsedPresets);
          }
        }
      } catch (err) {
        console.warn('[BridgeAdapter] Failed to read localStorage:', err);
      }
    }

    _migrateLegacySettings() {
      try {
        if (typeof localStorage === 'undefined') return;
        const legacyFontSize = localStorage.getItem('lyric_font_size');
        if (legacyFontSize) {
          const num = parseInt(legacyFontSize, 10);
          if (!isNaN(num) && num >= 14 && num <= 72) {
            const scale = num / 30.0;
            this._store.set('lyrics.font_size_scale', scale, { silent: true });
          }
        }
      } catch (e) {}
    }

    scheduleSave() {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
      }
      this._saveTimer = setTimeout(() => {
        this.saveNow();
      }, this._debounceMs);
    }

    async saveNow() {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }

      const state = this._store.get();

      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(STORAGE_KEY_STATE, JSON.stringify(state));
          const userPresets = Array.from(this._store._userPresets.values());
          localStorage.setItem(STORAGE_KEY_PRESETS, JSON.stringify(userPresets));
        } catch (e) {
          console.warn('[BridgeAdapter] LocalStorage write failed:', e);
        }
      }

      const api = this._getApi();
      if (api && typeof api.customization_save_state === 'function') {
        try {
          await api.customization_save_state(state);
        } catch (err) {
          console.error('[BridgeAdapter] Backend save_state error:', err);
        }
      }
    }

    async notifyPresetSaved(preset) {
      const api = this._getApi();
      if (api && typeof api.customization_save_preset === 'function') {
        try {
          await api.customization_save_preset(preset.name, preset.state);
        } catch (e) {
          console.error('[BridgeAdapter] Backend save_preset error:', e);
        }
      }
      this.saveNow();
    }

    async notifyPresetDeleted(presetId) {
      const api = this._getApi();
      if (api && typeof api.customization_delete_preset === 'function') {
        try {
          await api.customization_delete_preset(presetId);
        } catch (e) {
          console.error('[BridgeAdapter] Backend delete_preset error:', e);
        }
      }
      this.saveNow();
    }
  }

  // ---------------------------------------------------------------------------
  // Top-Level Unified Customization Facade
  // ---------------------------------------------------------------------------

  class CustomizationEngine {
    constructor() {
      this.registry = new CustomizationRegistry();
      this.events = new EventBus();
      this.cssBridge = new ReactiveDynamicCssBridge(this.registry, this.events);
      this.store = new StateStore(this.registry, this.events, this.cssBridge);
      this.bridge = new BridgeAdapter(this.store, this.events);
      this.isReady = false;

      this.cssBridge.applyState(this.store.get());
      this.cssBridge.flushNow();
    }

    async init() {
      if (this.isReady) return;
      await this.bridge.init();
      this.cssBridge.applyState(this.store.get());
      this.cssBridge.flushNow();
      this.isReady = true;
      this.events.emit('ready', { state: this.store.get() });
    }

    get(path) {
      return this.store.get(path);
    }

    set(path, val, options) {
      return this.store.set(path, val, options);
    }

    setBatch(updates, options) {
      return this.store.setBatch(updates, options);
    }

    on(event, cb) {
      return this.events.on(event, cb);
    }

    once(event, cb) {
      return this.events.once(event, cb);
    }

    off(event, cb) {
      return this.events.off(event, cb);
    }

    emit(event, data) {
      return this.events.emit(event, data);
    }

    applyPreset(presetId) {
      return this.store.applyPreset(presetId);
    }

    listPresets() {
      return this.store.listPresets();
    }

    savePreset(name, optionalState) {
      const preset = this.store.savePreset(name, optionalState);
      if (preset && this.bridge) {
        this.bridge.notifyPresetSaved(preset);
      }
      return preset;
    }

    deletePreset(presetId) {
      const deleted = this.store.deletePreset(presetId);
      if (deleted && this.bridge) {
        this.bridge.notifyPresetDeleted(presetId);
      }
      return deleted;
    }

    exportPreset(presetId) {
      return this.store.exportPreset(presetId);
    }

    importPreset(json) {
      const p = this.store.importPreset(json);
      if (p) this.bridge.scheduleSave();
      return p;
    }

    reset(domain) {
      return this.store.reset(domain);
    }

    exportJson() {
      return this.store.exportState();
    }

    importJson(json) {
      const ok = this.store.importState(json);
      if (ok) this.bridge.scheduleSave();
      return ok;
    }

    flushCss() {
      this.cssBridge.flushNow();
    }
  }

  const engine = new CustomizationEngine();

  // ---------------------------------------------------------------------------
  // Settings Console UI Controller
  // ---------------------------------------------------------------------------

  function colorToHex(colorStr) {
    if (!colorStr || typeof colorStr !== 'string') return '#ffffff';
    const trimmed = colorStr.trim();
    if (trimmed.startsWith('#')) {
      if (trimmed.length === 7) return trimmed;
      if (trimmed.length === 4) {
        return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
      }
      if (trimmed.length > 7) return trimmed.slice(0, 7);
    }
    const match = trimmed.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (match) {
      const r = parseInt(match[1], 10).toString(16).padStart(2, '0');
      const g = parseInt(match[2], 10).toString(16).padStart(2, '0');
      const b = parseInt(match[3], 10).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
    return '#ffffff';
  }

  function renderCustomizationPanel() {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    const panel = document.getElementById('qp-panel-customization');
    if (!panel) return;

    // 1. Presets & Themes Hub
    const select = document.getElementById('cust-preset-select');
    if (select) {
      const presets = engine.listPresets();
      const currentId = engine.store.getCurrentPresetId();
      select.innerHTML = '';
      for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (p.builtIn ? ' (Built-in)' : ' (Custom)');
        if (p.id === currentId) opt.selected = true;
        select.appendChild(opt);
      }
      select.value = currentId;

      const badge = document.getElementById('cust-preset-active-badge');
      if (badge) {
        const activePreset = engine.store.getPreset(currentId);
        const isBuiltIn = activePreset ? activePreset.builtIn : true;
        badge.textContent = isBuiltIn ? 'Built-in' : 'Custom';
        badge.classList.toggle('is-custom', !isBuiltIn);
      }

      const delBtn = document.getElementById('cust-btn-delete-preset');
      if (delBtn) {
        const activePreset = engine.store.getPreset(currentId);
        const canDelete = activePreset ? !activePreset.builtIn : false;
        delBtn.disabled = !canDelete;
      }
    }

    // 2. Dynamic Typography & Lyrics
    const activeScale = Number(engine.get('lyrics.active_scale')) || 1.08;
    const sliderScale = document.getElementById('slider-cust-active-scale');
    if (sliderScale) sliderScale.value = activeScale;
    const badgeScale = document.getElementById('badge-cust-active-scale');
    if (badgeScale) badgeScale.textContent = activeScale.toFixed(2) + 'x';

    const activeGlow = Number(engine.get('lyrics.active_glow')) || 10;
    const sliderGlow = document.getElementById('slider-cust-active-glow');
    if (sliderGlow) sliderGlow.value = activeGlow;
    const badgeGlow = document.getElementById('badge-cust-active-glow');
    if (badgeGlow) badgeGlow.textContent = Math.round(activeGlow) + 'px';

    const glowColor = engine.get('lyrics.active_glow_color') || '#ffffff';
    const colorPicker = document.getElementById('cust-active-glow-color');
    if (colorPicker) colorPicker.value = colorToHex(glowColor);

    const letterSpacing = Number(engine.get('lyrics.letter_spacing')) || 0.0;
    const sliderSpacing = document.getElementById('slider-cust-letter-spacing');
    if (sliderSpacing) sliderSpacing.value = letterSpacing;
    const badgeSpacing = document.getElementById('badge-cust-letter-spacing');
    if (badgeSpacing) badgeSpacing.textContent = letterSpacing.toFixed(1) + 'px';

    const fontWeight = Number(engine.get('lyrics.font_weight')) || 700;
    const sliderWeight = document.getElementById('slider-cust-font-weight');
    if (sliderWeight) sliderWeight.value = fontWeight;
    const badgeWeight = document.getElementById('badge-cust-font-weight');
    if (badgeWeight) badgeWeight.textContent = String(fontWeight);

    const secOpacity = Number(engine.get('lyrics.secondary_opacity')) || 0.5;
    const sliderSec = document.getElementById('slider-cust-secondary-opacity');
    if (sliderSec) sliderSec.value = secOpacity;
    const badgeSec = document.getElementById('badge-cust-secondary-opacity');
    if (badgeSec) badgeSec.textContent = Math.round(secOpacity * 100) + '%';

    const adlibStyle = engine.get('lyrics.adlib_font_style') || 'italic';
    const selectAdlib = document.getElementById('cust-adlib-style');
    if (selectAdlib) selectAdlib.value = adlibStyle;

    const secScale = Number(engine.get('lyrics.secondary_scale')) || 0.75;
    const sliderSecScale = document.getElementById('slider-cust-secondary-scale');
    if (sliderSecScale) sliderSecScale.value = Math.round(secScale * 100);
    const badgeSecScale = document.getElementById('badge-cust-secondary-scale');
    if (badgeSecScale) badgeSecScale.textContent = Math.round(secScale * 100) + '%';

    const adlibScale = Number(engine.get('lyrics.adlib_scale')) || 0.70;
    const sliderAdlibScale = document.getElementById('slider-cust-adlib-scale');
    if (sliderAdlibScale) sliderAdlibScale.value = Math.round(adlibScale * 100);
    const badgeAdlibScale = document.getElementById('badge-cust-adlib-scale');
    if (badgeAdlibScale) badgeAdlibScale.textContent = Math.round(adlibScale * 100) + '%';

    const scrollInertia = engine.get('lyrics.scroll_inertia_mode') || 'springy';
    const selectScrollInertia = document.getElementById('cust-scroll-inertia');
    if (selectScrollInertia) selectScrollInertia.value = scrollInertia;

    const bevelEffect = Boolean(engine.get('lyrics.bevel_effect'));
    const badgeBevel = document.getElementById('cust-bevel-state');
    if (badgeBevel) badgeBevel.textContent = bevelEffect ? 'On' : 'Off';

    // 3. Visuals & Particle Systems
    const particleType = engine.get('visuals.particle_type') || 'motes';
    const selectPartType = document.getElementById('cust-particle-type');
    if (selectPartType) selectPartType.value = particleType;

    const particleCount = Number(engine.get('visuals.particle_count')) || 60;
    const sliderPartDensity = document.getElementById('slider-cust-particle-density');
    if (sliderPartDensity) sliderPartDensity.value = particleCount;
    const badgePartDensity = document.getElementById('badge-cust-particle-density');
    if (badgePartDensity) badgePartDensity.textContent = String(particleCount);

    const particleSpeed = Number(engine.get('visuals.particle_speed')) || 1.0;
    const sliderPartSpeed = document.getElementById('slider-cust-particle-speed');
    if (sliderPartSpeed) sliderPartSpeed.value = particleSpeed;
    const badgePartSpeed = document.getElementById('badge-cust-particle-speed');
    if (badgePartSpeed) badgePartSpeed.textContent = particleSpeed.toFixed(1) + 'x';

    const particleOpacity = Number(engine.get('visuals.particle_opacity')) || 0.6;
    const sliderPartOpacity = document.getElementById('slider-cust-particle-opacity');
    if (sliderPartOpacity) sliderPartOpacity.value = particleOpacity;
    const badgePartOpacity = document.getElementById('badge-cust-particle-opacity');
    if (badgePartOpacity) badgePartOpacity.textContent = Math.round(particleOpacity * 100) + '%';

    // 4. Audio-Reactive & Beat-Sync Targets
    const beatSync = engine.get('reactive.beat_sync_enabled') !== false;
    const badgeBeatSync = document.getElementById('cust-beatsync-state');
    if (badgeBeatSync) badgeBeatSync.textContent = beatSync ? 'On' : 'Off';

    const pulseStrength = Number(engine.get('reactive.pulse_strength')) || 1.0;
    const sliderPulse = document.getElementById('slider-cust-pulse-strength');
    if (sliderPulse) sliderPulse.value = pulseStrength;
    const badgePulse = document.getElementById('badge-cust-pulse-strength');
    if (badgePulse) badgePulse.textContent = pulseStrength.toFixed(1) + 'x';

    const chkArt = document.getElementById('cust-target-art');
    if (chkArt) chkArt.checked = engine.get('reactive.target_album_art') !== false;

    const chkLyrics = document.getElementById('cust-target-lyrics');
    if (chkLyrics) chkLyrics.checked = engine.get('reactive.target_lyrics_active') !== false;

    const chkControls = document.getElementById('cust-target-controls');
    if (chkControls) chkControls.checked = Boolean(engine.get('reactive.target_controls'));

    const chkBloom = document.getElementById('cust-target-bloom');
    if (chkBloom) chkBloom.checked = engine.get('reactive.target_ambient_bloom') !== false;

    const chkParticles = document.getElementById('cust-target-particles');
    if (chkParticles) chkParticles.checked = engine.get('reactive.target_particles') !== false;

    const syncMode = engine.get('reactive.sync_motion_mode') || 'synchronized';
    const selectSyncMode = document.getElementById('cust-sync-motion-mode');
    if (selectSyncMode) selectSyncMode.value = syncMode;

    // 5. Extended Spatial Orientation & Artwork Layout
    const orientation = engine.get('layout.orientation') || 'horizontal';
    const selectOrient = document.getElementById('cust-orientation-select');
    if (selectOrient) selectOrient.value = orientation;

    const artShape = engine.get('layout.artwork_shape') || 'rounded';
    const selectShape = document.getElementById('cust-artwork-shape-select');
    if (selectShape) selectShape.value = artShape;

    const lyricsDock = engine.get('layout.lyrics_dock') || 'center';
    const selectDock = document.getElementById('cust-lyrics-dock-select');
    if (selectDock) selectDock.value = lyricsDock;

    const artSpin = Boolean(engine.get('layout.artwork_spin_enabled'));
    const badgeArtSpin = document.getElementById('cust-artwork-spin-state');
    if (badgeArtSpin) badgeArtSpin.textContent = artSpin ? 'On' : 'Off';

    const stretch = engine.get('lyrics.syllable_stretch_enabled') !== false;
    const badgeStretch = document.getElementById('cust-syllable-stretch-state');
    if (badgeStretch) badgeStretch.textContent = stretch ? 'On' : 'Off';

    const pop = engine.get('lyrics.syllable_pop_enabled') !== false;
    const badgePop = document.getElementById('cust-syllable-pop-state');
    if (badgePop) badgePop.textContent = pop ? 'On' : 'Off';

    const wipe = engine.get('lyrics.gradient_wipe_enabled') !== false;
    const badgeWipe = document.getElementById('cust-gradient-wipe-state');
    if (badgeWipe) badgeWipe.textContent = wipe ? 'On' : 'Off';

    const stasis = engine.get('visuals.breakdown_stasis_enabled') !== false;
    const badgeStasis = document.getElementById('cust-breakdown-stasis-state');
    if (badgeStasis) badgeStasis.textContent = stasis ? 'On' : 'Off';

    const aurora = engine.get('visuals.aurora_mesh_enabled') !== false;
    const badgeAurora = document.getElementById('cust-aurora-mesh-state');
    if (badgeAurora) badgeAurora.textContent = aurora ? 'On' : 'Off';
  }

  function onCustomizationPresetChange(presetId) {
    if (!presetId) return;
    engine.applyPreset(presetId);
    renderCustomizationPanel();
  }

  function openSavePresetDialog() {
    const row = document.getElementById('cust-inline-save-row');
    if (!row) return;
    row.hidden = false;
    const input = document.getElementById('cust-input-new-preset');
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  function cancelSavePreset() {
    const row = document.getElementById('cust-inline-save-row');
    if (row) row.hidden = true;
    const input = document.getElementById('cust-input-new-preset');
    if (input) input.value = '';
  }

  function onCustomPresetKeyDown(e) {
    if (e.key === 'Enter') {
      submitSavePreset();
    } else if (e.key === 'Escape') {
      cancelSavePreset();
    }
  }

  function submitSavePreset() {
    const input = document.getElementById('cust-input-new-preset');
    if (!input) return;
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    const preset = engine.savePreset(name);
    cancelSavePreset();
    if (preset && preset.id) {
      engine.applyPreset(preset.id);
    }
    renderCustomizationPanel();
  }

  function deleteCurrentPreset() {
    const currentId = engine.store.getCurrentPresetId();
    const preset = engine.store.getPreset(currentId);
    if (!preset || preset.builtIn) return;
    engine.deletePreset(currentId);
    engine.applyPreset('default');
    renderCustomizationPanel();
  }

  function resetCustomizationToDefault() {
    engine.reset();
    renderCustomizationPanel();
  }

  function exportCustomizationPreset() {
    const jsonStr = engine.exportJson();
    if (!jsonStr) return;
    const currentId = engine.store.getCurrentPresetId();
    if (typeof Blob !== 'undefined' && typeof document !== 'undefined') {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `paprika-preset-${currentId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  function importCustomizationPresetFile(event) {
    const file = event && event.target && event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target.result;
        const imported = engine.importPreset(text);
        if (imported && imported.id) {
          engine.applyPreset(imported.id);
        } else {
          engine.importJson(text);
        }
        renderCustomizationPanel();
      } catch (err) {
        console.error('[Customization UI] Import failed:', err);
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  }

  function onCustomizationSliderInput(path, rawVal, badgeId, unit = '', formatter = null) {
    const num = parseFloat(rawVal);
    if (badgeId && typeof document !== 'undefined') {
      const badge = document.getElementById(badgeId);
      if (badge) {
        badge.textContent = formatter ? formatter(rawVal) : (rawVal + (unit || ''));
      }
    }
    engine.set(path, num);
  }

  function onCustomizationSelectChange(path, val) {
    engine.set(path, val);
  }

  function onCustomizationColorChange(path, color) {
    engine.set(path, color);
  }

  function onCustomizationCheckboxChange(path, checked) {
    engine.set(path, Boolean(checked));
  }

  function toggleCustomizationBevel() {
    const curr = Boolean(engine.get('lyrics.bevel_effect'));
    const next = !curr;
    engine.set('lyrics.bevel_effect', next);
    const badge = document.getElementById('cust-bevel-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  function toggleCustomizationBeatSync() {
    const curr = engine.get('reactive.beat_sync_enabled') !== false;
    const next = !curr;
    engine.set('reactive.beat_sync_enabled', next);
    const badge = document.getElementById('cust-beatsync-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  function toggleCustomizationSyllableStretch() {
    const curr = engine.get('lyrics.syllable_stretch_enabled') !== false;
    const next = !curr;
    engine.set('lyrics.syllable_stretch_enabled', next);
    const badge = document.getElementById('cust-syllable-stretch-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  function toggleCustomizationSyllablePop() {
    const curr = engine.get('lyrics.syllable_pop_enabled') !== false;
    const next = !curr;
    engine.set('lyrics.syllable_pop_enabled', next);
    const badge = document.getElementById('cust-syllable-pop-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  function toggleCustomizationGradientWipe() {
    const curr = engine.get('lyrics.gradient_wipe_enabled') !== false;
    const next = !curr;
    engine.set('lyrics.gradient_wipe_enabled', next);
    const badge = document.getElementById('cust-gradient-wipe-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  function toggleCustomizationBreakdownStasis() {
    const curr = engine.get('visuals.breakdown_stasis_enabled') !== false;
    const next = !curr;
    engine.set('visuals.breakdown_stasis_enabled', next);
    const badge = document.getElementById('cust-breakdown-stasis-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  function toggleCustomizationAuroraMesh() {
    const curr = engine.get('visuals.aurora_mesh_enabled') !== false;
    const next = !curr;
    engine.set('visuals.aurora_mesh_enabled', next);
    const badge = document.getElementById('cust-aurora-mesh-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  function toggleCustomizationArtworkSpin() {
    const curr = Boolean(engine.get('layout.artwork_spin_enabled'));
    const next = !curr;
    engine.set('layout.artwork_spin_enabled', next);
    const badge = document.getElementById('cust-artwork-spin-state');
    if (badge) badge.textContent = next ? 'On' : 'Off';
  }

  engine.events.on('preset:applied', () => {
    if (typeof renderCustomizationPanel === 'function') renderCustomizationPanel();
  });

  if (typeof window !== 'undefined') {
    window.renderCustomizationPanel = renderCustomizationPanel;
    window.onCustomizationPresetChange = onCustomizationPresetChange;
    window.openSavePresetDialog = openSavePresetDialog;
    window.cancelSavePreset = cancelSavePreset;
    window.onCustomPresetKeyDown = onCustomPresetKeyDown;
    window.submitSavePreset = submitSavePreset;
    window.deleteCurrentPreset = deleteCurrentPreset;
    window.resetCustomizationToDefault = resetCustomizationToDefault;
    window.exportCustomizationPreset = exportCustomizationPreset;
    window.importCustomizationPresetFile = importCustomizationPresetFile;
    window.onCustomizationSliderInput = onCustomizationSliderInput;
    window.onCustomizationSelectChange = onCustomizationSelectChange;
    window.onCustomizationColorChange = onCustomizationColorChange;
    window.onCustomizationCheckboxChange = onCustomizationCheckboxChange;
    window.toggleCustomizationBevel = toggleCustomizationBevel;
    window.toggleCustomizationBeatSync = toggleCustomizationBeatSync;
    window.toggleCustomizationSyllableStretch = toggleCustomizationSyllableStretch;
    window.toggleCustomizationSyllablePop = toggleCustomizationSyllablePop;
    window.toggleCustomizationGradientWipe = toggleCustomizationGradientWipe;
    window.toggleCustomizationBreakdownStasis = toggleCustomizationBreakdownStasis;
    window.toggleCustomizationAuroraMesh = toggleCustomizationAuroraMesh;
    window.toggleCustomizationArtworkSpin = toggleCustomizationArtworkSpin;

    window.customization = engine;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        engine.init().then(() => {
          if (typeof renderCustomizationPanel === 'function') renderCustomizationPanel();
        });
      });
    } else {
      engine.init().then(() => {
        if (typeof renderCustomizationPanel === 'function') renderCustomizationPanel();
      });
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = engine;
    module.exports.CustomizationEngine = CustomizationEngine;
    module.exports.CustomizationRegistry = CustomizationRegistry;
    module.exports.EventBus = EventBus;
    module.exports.ReactiveDynamicCssBridge = ReactiveDynamicCssBridge;
    module.exports.StateStore = StateStore;
    module.exports.BridgeAdapter = BridgeAdapter;
    module.exports.BUILTIN_PRESETS = BUILTIN_PRESETS;
  }

  if (typeof global !== 'undefined' && typeof window === 'undefined') {
    global.customization = engine;
  }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
