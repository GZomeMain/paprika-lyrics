# 🌶️ Spicy Lyrics Overlay (`simp2spicy`)

A high-performance, GPU-accelerated Windows desktop overlay that brings **Apple Music-style syllable-synced karaoke lyrics** to [SimpMusic](https://github.com/brahmkshatriya/SimpMusic) (and any Windows media player broadcasting to GSMTC).

Powered by a lightweight Python 3 host running **Edge WebView2 (Chromium)**, the overlay delivers studio-accurate syllable wipes, dynamic liquid glass backgrounds, spring physics scrolling, and cinematic depth of field—all with minimal CPU and GPU overhead.

---

## ✨ Features

- **🎤 Apple Music-Style Syllable Synchronization**
  - Studio-accurate phoneme and syllable timing via the Spicy Lyrics API (Apple Music TTML).
  - Continuous, fluid wipe with feathered light beams and zero teleportation between words.
  - Multi-line cluster support: overlapping lead and background vocals stay in sharp focus simultaneously.
  - Undulating letter-by-letter vocal vibrato wave on long held notes (≥ 850 ms).
  - **Living word motion:** every sung word eases up in size and blooms as it lands — so ordinary lines never sit static. Words relax back as their line recedes.
  - **A motion-variant engine (43 animations across 7 types):** each syllable draws a *stable* variant from a pool chosen by context, and the pools rotate per line so nothing repeats back-to-back. Every variant is deliberately restrained — **no variant rotates more than 0.8°, moves further than 3.4 px, or changes size by more than 4.2%** at the default style — so the words read as emphasis rather than cartoon gymnastics. The two worst offenders (`chorusRise`, a per-letter staircase that also rotated alternating letters, and `chorusSpin`, a ±2.6° spin) were removed outright, and per-letter pools now ride a gentle wave instead of jumping.
    - `normal` (8): lift, hop, tilt, breathe, drift, bob, swell, lean
    - `fast` (6, syllables ≤ 200 ms): tick, snap, flick, blip, skim, jitter
    - `hold` (7, notes ≥ 1 s): wave, ripple, bloom, ladder, swing, xwave, float
    - `backing` (4): ghost, echo, hum, veil — harmonies drift out of phase with the lead
    - `chorus` (6): chorusLeap, chorusBeat, chorusSweep, chorusRipple, chorusTilt, chorusSwell
    - `chorusHold` (2): chorusChant, chorusWaveBig
    - `adlib` (10, short non-repeating asides): whisper, drop, slip, sigh, coo, dodge, peek, murmur, swaylet, flicker
  - **Spotlight budget:** each line earns roughly one flashy ("special") variant per ~7 syllables — longer lines can carry up to three, short ones stay restrained. Words beyond the budget rotate through their pool's quiet members, so restrained words still vary; choruses are exempt (every word of a hook lands).
  - **Chorus detection:** a lyric line performed two or more times is a hook — those lines get the chorus pools plus a live CSS special (a warm halo and a 2.4 s breathing cycle on the words), so the chorus visibly lands differently from the verses.
  - **Full-line parting:** when the active line contains a size-changing variant, the whole line breathes gently and its neighbours part vertically a few pixels (3 px, down from 6) — one composed motion instead of a grown word colliding into static text.
  - **Motion style:** Auto / Subtle / Lively / Wild scales every variant uniformly (with clamps), so the same song can read calm or explosive.
  - **Beat-synced background pulse:** the **normal ambient background** — the same layers and colours this app always shows, not a separate glow element — swells once per beat, with the album art breathing along with it. Only opacity animates, so the blurred backdrop is never re-blurred per frame. Toggleable Subtle / Bold / Off in the panel, rests while playback is paused, and respects reduced motion.
  - **Builds and drops:** the pulse is not equally hard throughout a driven section. The rhythm model also maps the track's intensity shape — onset density against the track's own median — so the pulse ramps up through a build (harder-to-start easing), hits full strength on a drop (immediate attack, longer tail), and relaxes afterwards. A flat track reports no builds and no drops; a verse-to-chorus jump deepens the pulse even without a climb. Diagnostics shows the strength range and per-track build/drop counts.
  - **Where it pulses is a rhythm model, not a chorus flag** (`core/beat.py`, unit-tested):
    - A tempo is estimated from the syllable-onset interval histogram (folded into the musical 70–180 BPM band), then a **phase** is searched for, so the pulse sits where the onsets actually land instead of on an arbitrary clock. The phase is used only for *alignment* — grid coherence measures at ~0.30-0.35, i.e. chance, on every track tested, because a sung syllable leads or lags the beat by tens of milliseconds. Vocals are not drums, so coherence never decides *whether* to pulse.
    - Each grid slot is scored by whether an onset lands on it, rolled over a window of recent slots (**occupancy**). Measured across a 60-track corpus this is the one feature that separates driven delivery (0.92) from calm delivery (0.27, median 0.57), and it is what makes an a cappella bar, a held note or a long instrumental gap go dark. A short instrumental break (~≤8 s) between two driven sections is bridged at reduced depth instead — the pulse survives the quiet middle of a drop rather than dying at it — while long breaks, intros and outros stay dark.
    - **Percussiveness** attenuates slots built from long syllables, so a legato ballad shimmers where a rap verse pulses.
    - **Hysteresis plus a minimum run** (start above 0.50 occupancy, keep above 0.34, for 3 consecutive slots) means the pulse cannot strobe on a section boundary, and it can rest in a verse and return for the chorus.
    - The plan is emitted as `[startMs, endMs, strength]` runs (median ~0.8 KB) and the UI only lands the animation on the beat and scales it by `--beat-strength`, so **calm passages shimmer and driven ones pulse** instead of switching between flat on and off. A track with too little rhythmic evidence carries no plan and stays silent.
    - Deliberately **ignores chorus and line structure**: a chorus with no rhythmic drive stays dark, which is the over-triggering this replaced. The previous ±8% period drift is gone too — it would pull the pulse off the grid it is now locked to; the pulse breathes through strength instead.
    - Verified on a real track (*Disease*, 99 BPM): the pulse rests over the intro (0–2 s), the first verse (14–23 s) and the breakdown (82–90 s), and builds 0.4 → 0.6 → 0.8 → 1.0 into each chorus. Backdrop amplitude is now 6 opacity points at full strength (was 26) and 2.4 at the floor.
  - **One continuous sweep:** the highlight is a single leading edge travelling the whole line (monotone cubic interpolated), so it never restarts or teleports between words and its speed eases through each boundary instead of snapping.

- **🎨 Dynamic Liquid Aura & Film Grain**
  - Album art appears beside the title/artist in the header and simultaneously **is** the backdrop: the whole cover, drawn nearly 1:1 to the window and blurred hard (blur scales with window size, ~26–54 px), so the artwork stays recognisable — you see where it is light and dark — instead of collapsing into a smooth gradient. A gradient scrim keeps lyric contrast steady on both pale and dark covers.
  - Two-stage loading: the instant Windows Media thumbnail paints the header and backdrop immediately, while a hi-res 1000x1000 version (iTunes/Deezer) resolves in a background task — lyrics never wait on artwork, and the backdrop upgrades in place when ready.
  - The backdrop drifts continuously (26 s cycle, scale + translate). Its amplitude stays inside the blur overscan, so no bare edge can ever be exposed at any window size.
  - Integrated SVG film grain (`feTurbulence`) to eliminate 8-bit digital color banding on dark displays.

- **📷 Cinematic Depth of Field**
  - Active singing lines are kept in pin-sharp focus (`0px` blur).
  - Immediate neighbors receive a soft photographic blur (`1px`), while distant lines fade into an atmospheric opacity gradient without wasting GPU passes.
  - **Reserved top strip:** the floating track card is painted over the scroller, so the top of the list fades to nothing before it reaches the card. The card's bottom edge is measured (it moves with the title, the lyric font, fullscreen scaling and the art-hover parting) and the mask is sized from that, so no glyph ever shows through the card.

- **🌀 Physics-Based Damped Spring Scrolling**
  - Replaced mechanical linear interpolation with a semi-implicit Euler spring solver (`k = 145, d = 23`).
  - Lyrics glide, carry inertia, and settle organically like native iOS.

- **⌨️ System-Wide Global Hotkeys & Ergonomics**
  - Adjust timing latency on the fly by ±50 ms with `Ctrl + [` and `Ctrl + ]`—even while in a full-screen game or browser.
  - Responsive font zooming from `18px` to `60px` using `Ctrl + Mouse Wheel` (saved to local storage).
  - Frameless, drag-to-move window with native Windows 11 rounded corners (`DWMWA_WINDOW_CORNER_PREFERENCE`).

- **⚡ Smart Fallbacks & Offline Storage**
  - Zero-auth Spotify track ID scraper with iTunes & Deezer fallbacks, plus LRCLIB search fallback when exact lookup misses.
  - Automatic fallback to LRCLIB with phonetic sub-syllable splitting for tracks without studio TTML.
  - **Musical word timing for line-synced fallbacks:** LRCLIB only timestamps whole lines, so word fills used to march at one robotic pace. A timing model now distributes each line's window over its syllables using the track's tempo (mean inter-onset interval), delivery density, an energy factor (pulse near the ~150 BPM sweet spot + sung-to-written ratio), and prosodic stress — content words hold the beat while glue words ('in the', 'a') rush past. Syllable runs from the Spicy API are matched to LRCLIB lines **by text** (sliding-window word match, not length), and the matched line's timestamp re-anchors the item to fix constant clock offsets between the two sources.
  - Thread-safe bounded LRU disk cache (`storage.py`) with a 3-day TTL, debounced writes, and atomic flushes to eliminate disk thrashing.
  - **Self-healing cache:** every cached payload is re-validated when it is read. A payload whose repeated lines share one timestamp — the fingerprint of a bad merge — is discarded and refetched instead of served, so a poisoned cache can never reach the screen even if it carries a parser version the current build accepts. Startup also sweeps out payloads from older parser versions, so the file cannot accumulate one dead generation per parser change (measured: a 10.8 MB cache reduced to 0.27 MB).
  - **Works with any audio source.** Anything that broadcasts to Windows System Media Transport Controls is followed — Spotify, browsers, and local players like MusicBee, foobar2000 and Windows Media Player. Local files with poor tags are repaired before lookup: filename stems ("07 - Artist - Title.mp3"), track-number prefixes and underscore titles are cleaned, and the album name (when the player provides a real one) sharpens both the LRCLIB and Spotify-ID lookups. The Resolve report shows the album and whether metadata came from tags or a filename repair. (Apps that never broadcast to Windows media controls cannot be followed — Windows offers no alternative short of audio capture.)
- **VLC support (HTTP interface).** VLC 3.x does not broadcast to Windows media controls, so the overlay polls VLC's Lua HTTP interface instead. One-time setup in VLC: Tools → Preferences → Show settings: All → Interface → Main interfaces → check **Web**; then Main interfaces → Lua → set a **Lua HTTP password**. Then add to the overlay's `.env`:

  ```env
  VLC_HTTP_PASSWORD="your_lua_password"
  VLC_HTTP_HOST=127.0.0.1   # optional, default 127.0.0.1
  VLC_HTTP_PORT=8080        # optional, default 8080
  ```

  When no Windows media session is active the overlay polls VLC (~0.7 s while playing, 2 s idle) for the playing file's tags, position and length — untagged files are repaired from the filename exactly like the SMTC path — and the transport buttons/seek bar drive VLC via `pl_pause`/`pl_next`/`pl_previous`/`seek`. SMTC sessions always take priority when present.

- **🌐 Translations, Transliteration & Letter Timing**
  - Optional translation/transliteration layer rendered beneath the active lyric, toggleable from the settings page or `T`.
  - Honors per-letter timing when the payload provides it, revealing each glyph on its own clock.

- **⚡ Rendering Scale**
  - Lyric lines split into per-glyph spans **lazily**: only lines near the viewport materialize, so a long song no longer builds tens of thousands of never-visible elements before the first frame.
  - Depth-of-field styling is applied per depth bucket and skipped when a line's depth has not changed, so moving the focus no longer restyles every line in the song.

- **🖥️ Desktop-Overlay Extras**
  - **Mini player (lyrics only):** the PiP icon on the hovered art shrinks this same window to a lyrics-only surface, `320×380` at the smallest and `900×1200` at the largest. It is a *mode* of the overlay rather than a second window, so the song, playhead and sync carry straight over — no second copy of the pipeline — and the remembered mini size is kept apart from the real one, so leaving mini restores the window you were working in. Fullscreen and mini are mutually exclusive by construction.
  - **Anchored resizing:** every edge and corner drag is handed to pywebview as a fix point, which applies position and size in a single `SetWindowPos`. Grabbing the west edge therefore holds the east edge still and a corner drag pins the opposite corner, instead of the window always growing from its top-left. Fullscreen disables the grips entirely, and the whole overlay is undraggable there (drag regions are removed from the DOM, because pywebview's drag is a JS walk-up over marked elements — CSS `app-region` never took part in it).
  - **Click-through mode** (`Ctrl + Shift + T`): the overlay ignores the mouse entirely so it can sit over a game or browser. It is refused unless that escape hotkey actually registered, so the window can never become mouse-proof with no way back.
  - **Instrumental break countdown:** long instrumental sections no longer look frozen. The glass chip (dots + countdown) sits as its **own row in the lyric flow** — between the just-sung line and the next one — so it reads as part of the song and never displaces or indents the upcoming lyric.
    - The three dots are a **continuous meter**: each fills across its third of the countdown, so the row visibly fills up and reaches the timer exactly as it reads 0:00. The value lifts to full white as it completes.
    - Enter/exit are row animations, not display flips: the row grows from zero height (pushing the upcoming lyric down rather than jumping it), and on completion the chip pops (+7%), shrinks and fades — finished just before the next line is sung. Pausing or seeking closes it smoothly. Reduced motion drops the animations but keeps the chip.
    - It only starts with real headroom left (>3.2 s of break), so a chip can never flash in for a moment and leave again.
  - **Diagnostics readout:** the settings page unfolds a resolve report — source, cache hit/miss, timing mode, line and syllable counts, sync offset, parser version, and whether an API key is configured.
  - **Reduced motion:** honours the OS preference by default and is toggleable in the panel. Decorative motion (backdrop drift, pulsing dots, word variants, type specials) stops; the lyric fill is always kept, because it carries information.
  - **Track-change cross-fade:** a song change eases the outgoing words out and the new ones in instead of hard-replacing the tree behind a spinner.

- **🎛️ One Design System**
  - **A single glass material:** the settings page, the latency rail and the countdown chip all resolve to the same `--glass-*` tokens (blur, border, sheen, shadow), so every floating surface reads as one substance. The settings page is the same glass laid over a near-black wash (`rgba(3,3,5,0.90)` plus two faint colour pools for the blur to refract), so it reads as black tinted glass rather than a translucent panel — and the lyrics stay dimly visible behind it.
  - **A shared motion scale:** four duration tokens (`0.14s` press → `0.5s` layout) and three easings replace the dozens of one-off timings. Verified: the window controls, on-art options, latency buttons and panel steppers now report *identical* colour and transition values.
  - **One icon material:** every control is a borderless glyph on a soft hover surface, with a shared focus ring for keyboard users, and a deliberate icon-size hierarchy (28px transport → 18px on-art → 14px chrome → 12px steppers). On-art glyphs carry one shared 2.15px stroke weight, set in CSS rather than per-SVG, because they sit on a photograph and a thin stroke washed out over a light sleeve.
  - **Photograph-aware chrome:** hovering the art darkens the whole picture by one constant amount (a uniform scrim, not a vignette) so the glyphs hold their contrast on a white cover as well as a black one, and an invisible hotspot as wide as the card is about to grow keeps the control row reachable — otherwise reaching for a control left the art before it expanded, and the click fell through to the lyric line behind it.
  - **Feedback instead of silence:** a changed setting pulses its value once, seek bars lift and glow on hover, and the settings panel reveals with a staggered row cascade.

---

## 🏗️ Architecture & How It Works

```text
┌────────────────────────────────────────────────────────┐
│             SimpMusic / YouTube Music                  │
└──────────────────────────┬─────────────────────────────┘
                           │ Broadcasts audio metadata & cover stream
                           ▼
┌────────────────────────────────────────────────────────┐
│           core/smtc.py (Windows GSMTC)                 │
│  • Reads Song Title & Artist                            │
│  • Streams Live Album Art as Base64                    │
│  • Handles Play/Pause/Seek Commands                    │
└──────────────────────────┬─────────────────────────────┘
                           │ Passes metadata
                           ▼
┌────────────────────────────────────────────────────────┐
│           core/lyrics.py & core/resolver.py            │
│  1. Cache Check (storage.py)                           │
│  2. Spotify ID Resolution:                             │
│     spotify-scraper ──► iTunes API ──► Deezer API      │
│  3. Syllable TTML Fetch (Spicy Lyrics API)             │
│  4. Line-Sync Fallback (LRCLIB API)                    │
└──────────────────────────┬─────────────────────────────┘
                           │ Dispatches JSON payload
                           ▼
┌────────────────────────────────────────────────────────┐
│       Frontend Overlay (Edge WebView2 / Chromium)      │
│  • style.css: Liquid Aura Mesh, configurable fonts      │
│  • app.js: Spring Physics, Depth of Field, Syllable    │
│            Wave, Progressive Letter Mask                │
└────────────────────────────────────────────────────────┘
```

---

## 📦 Prerequisites & Dependencies

### System Requirements

- **Operating System**: Windows 10 (version 1809+) or Windows 11 (64-bit).
- **Runtime**: [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (pre-installed on most modern Windows systems).
- **Python**: Python 3.10, 3.11, 3.12, or 3.13.

### Python Libraries

Install all required libraries using `pip`:

```bash
pip install pywebview winsdk requests spotify-scraper
```

| Package | Purpose |
| --- | --- |
| **pywebview** | Lightweight frameless desktop window hosting Edge WebView2 |
| **winsdk** | Windows Runtime (WinRT) bindings to read GSMTC & cover streams |
| **requests** | HTTP client for Spicy Lyrics, iTunes, Deezer, and LRCLIB APIs |
| **spotify-scraper** | Zero-auth scraper to resolve Spotify IDs without developer tokens |

---

## 🚀 Installation & Setup

1. **Clone or Download the Repository**

   ```bash
   git clone https://github.com/your-username/simp2spicy.git
   cd simp2spicy
   ```

2. **Install Dependencies**

   ```bash
   pip install -r requirements.txt
   ```

   *(or run the `pip install` command listed above)*

3. **Configure Environment Variables**

   No API key is bundled with the source. Create a `.env` file in the root directory:

   ```env
   SPICY_API_KEY="your_api_key_here"
   SPICY_BASE_URL="https://api.spicylyrics.org"
   ```

   Without a key, the app still works but falls back to line-synced LRCLIB lyrics instead of syllable-synced Spicy Lyrics.

   Optional tuning variables:

   ```env
   SPICY_CACHE_TTL_SECONDS=259200   # lyric cache lifetime (default 3 days)
   SPICY_DEBUG=1                    # verbose resolver/lyrics diagnostics
   ```

4. **Launch the Overlay**

   ```bash
   python spicy_app.py
   ```

5. **Start Listening**

   Open **SimpMusic** (or Spotify / any browser playing music) and play any track. The lyrics, background colors, and album cover will load automatically!

---

## 🎮 Controls & Shortcuts

| Action | Shortcut / Gesture | Description |
| --- | --- | --- |
| **Nudge Latency Later** | `Ctrl + [` | Moves lyrics **later** by 50 ms (works system-wide) |
| **Nudge Latency Earlier** | `Ctrl + ]` | Moves lyrics **earlier** by 50 ms (works system-wide) |
| **Zoom Font Size** | `Ctrl + Mouse Wheel` | Dynamically scales font between `18px` and `60px`. Works in fullscreen too — the windowed zoom becomes a ×1.7 multiplier there |
| **Move Window** | Click & Drag Header, the top strip, or the track card's details | Smoothly repositions the overlay across your monitors. **Fullscreen is a fixed surface**: every drag region is disabled there, so the window cannot be dragged out of place |
| **Resize Window** | Click & Drag any edge or corner | Resizes with the grabbed edge anchored — dragging the west edge holds the east edge still, a corner drag pins the opposite corner. Disabled in fullscreen, where the window already covers the monitor |
| **Jump to Lyric** | Click the **words** of a lyric line | Seeks playback in SimpMusic directly to that timestamp. Only the glyphs are a target: the leading and margin around a line are not, so the space under the track card never seeks by accident |
| **Settings page** | Gear icon on the hovered art, or `Ctrl + ,` | Opens a **full-window sheet**, not a dropdown: group headings, room to label and explain each option, and one close button. Sections: Sync, Lyrics, Motion, Window, Diagnostics. Closes on the button, `Esc`, or a click on the dimmed area behind it |
| **Nudge Sync** | `−` / `+` in the settings page | Adjusts latency by 50 ms without opening the bottom bar |

| **Toggle Translations** | `T` key or "Translations" row | Shows/hides translation & transliteration beneath the active lyric |
| **Change Lyric Font** | "Font" row in the settings page | Switches between the Apple-style sans (default) and Barriecito (saved locally) |
| **Reduce Motion** | "Motion" row in the settings page | Toggles decorative motion (backdrop drift, dots, word motion, type specials) off and on (saved locally). The lyric fill always stays, since that carries information |
| **Motion Style** | "Motion style" row in the settings page | Cycles **Auto → Subtle → Lively → Wild** (saved locally). Scales every animation variant and type special uniformly, clamped so even Wild stays clean |
| **Fullscreen** | "Fullscreen" row, `F11`, or the expand icon on the hovered art | Expands to the whole screen; lyrics, gap indicator and hover art all scale up. Windowed geometry is restored on exit. In fullscreen that slot becomes the **exit** button (withdrawing the corners) — the two never show at once |
| **Mini Player** | The PiP icon on the hovered art (windowed only) | Shrinks this same window to a **lyrics-only** surface between `320×380` and `900×1200`: the track card, header, split panel and sync rail retire and a slim bar takes over, carrying the drag handle plus settings / restore / close. Its size is remembered separately, so leaving mini restores the window you were working in |
| **Layout Mode** | "Layout" row in the settings page, or the panels icon on the hovered art (both layouts) | Cycles **Compact → Split** (compact is the default; saved locally). In both the top bar disappears and art + title + artist float a bit lower, seamlessly. Split adds a large art panel with its own transport on the left — fullscreen only; picked while windowed, it activates on entering fullscreen |
| **Lyric Alignment** | "Alignment" row in the settings page | Cycles **Left → Center → Right**; the karaoke wipe's transform origin follows the alignment so the highlight always sweeps in from the anchored edge |
| **Hover Art (compact/split)** | Hover the floating artwork | The whole picture dims uniformly (not a vignette) so the glyphs stay legible over a white sleeve, and the art grows into the player itself: prev/play/next with a thin progress rail and a white playhead dot, plus layout / settings / fullscreen+mini (or the exit, in fullscreen) along the top — in both compact and split. The lyrics part downward while hovered. The row's play/pause is the art's only play control |
| **Seek Bar (on-art only)** | Hover the artwork | The app draws **one** progress bar: the on-art one. Click or drag it to seek — elapsed sits left, total right, with a dot riding the playhead that snaps on a seek and sweeps continuously while playing. Seeking while paused never starts playback. The resting card carries no bar at all (just art, title, artist), so two bars are never on screen at once |
| **Latency Rail** | Hidden at the right edge; slide in from the right | A vertical liquid-glass sync slider (drag, click, or nudge with the small ± buttons — hold to repeat). Zero sits mid-track; the fill grows toward the thumb. The trigger is the rail's **own footprint** (its height, plus a small pad), not a band down the whole right edge, so brushing the right side of the window no longer throws the rail open |
| **Window Move / Resize** | Drag the top strip, or drag any edge/corner | The whole top edge moves the window; all eight edges and corners resize it, each anchored on the opposite edge |
| **Always on Top** | "Always on top" row in the settings page | Keeps the overlay above other windows. **Off by default**, and the saved value is applied at launch (the window is created non-topmost and the setting takes effect as soon as the bridge is ready) |
| **Click-Through Mode** | "Click-through" row, or `Ctrl + Shift + T` anywhere | Makes the overlay ignore the mouse so it can sit over a game/browser; the hotkey turns it back off |
| **Diagnostics** | "Resolve report" row in the settings page | Unfolds the resolve/timing report (source, cache, timing mode, counts, sync, parser, API key) |
| **Play / Pause** | Play/pause icon in the bottom bar | Toggles media playback in SimpMusic |

The header stays minimal on purpose: track info, a single sliders button, and the window controls.

All controls use crisp monochrome SVG icons rather than text/emoji glyphs, so nothing picks up Windows' blue emoji rendering.

Close the panel with `Esc`, or by clicking anywhere outside it.

---

## 📂 Project Structure

```text
simp2spicy/
├── config.py              # Central configuration (PARSER_VERSION=11, DEFAULT_LATENCY_MS=600, cache TTL)
├── storage.py             # Thread-safe bounded LRU disk cache with 3-day TTL (spotify_cache.json)
├── spicy_app.py           # Entry point, window lifecycle (fullscreen, mini player, clamped anchored resize), Win32 hotkeys
├── requirements.txt       # Python dependencies
├── .gitignore             # Ignores __pycache__, .env, and the local listening cache (including .bak copies)
├── core/
│   ├── __init__.py
│   ├── beat.py            # Rhythm model: tempo + phase grid, occupancy trigger, pulse runs
│   ├── hotkeys.py         # Layout-aware Win32 RegisterHotKey daemon (sync, click-through)
│   ├── lyrics.py          # Parallel executor orchestrating LRCLIB & Spicy resolution + diagnostics
│   ├── metadata.py        # Regex cleaner stripping YouTube Music tags, video noise, and features
│   ├── native_window.py   # ctypes Win32 seam under an injectable user32/dwmapi (fullscreen repair, resize anchors)
│   ├── parser.py          # Apple Music TTML/LRC parser: lead/background vocals, letters, translations
│   ├── resolver.py        # Multi-tiered track resolver (SpotifyScraper -> iTunes -> Deezer)
│   └── smtc.py            # Windows GSMTC listener & live byte-stream album art extractor
├── tests/                 # unittest coverage for parser, metadata, storage, beat, window API, and diagnostics
├── tools/
│   └── ui-preview-regression.js  # Paste-in devtools assertions for the UI invariants (every viewport size)
└── ui/
    ├── index.html         # Overlay DOM structure, ambient liquid mesh, and noise filter
    ├── style.css          # Configurable font, liquid background, letter masks, depth-of-field
    └── app.js             # Spring physics, cluster focus, per-letter reveal, syllable wave
```

---

## ❓ Troubleshooting & FAQ

### 1. Why do some songs show LRCLIB instead of SPICY in the bottom badge?

- If a track has no synced lyrics on Apple Music / Spicy Lyrics, or if Spotify track ID resolution cannot find a match, the app safely falls back to LRCLIB (line-synced).
- Make sure `spotify-scraper` is installed (`pip install spotify-scraper`) to maximize match rates.

### 2. A track shows a countdown between lines instead of words. Is something broken?

- No. That marker fills a genuine instrumental break: nothing is being sung and the next line is more than ~3.2s away.
- It appears only while the transport is playing, never on top of a line that is actually being sung, and it hides during the intro (which has its own dots).

### 3. How do I make the overlay ignore the mouse so I can play a game fullscreen under it?

- Use the **Click-through** row in the settings page, or press `Ctrl + Shift + T` (works even while the overlay is unfocused).
- To turn it off, press `Ctrl + Shift + T` again — clicks cannot reach the window while it is on, so mouse access alone would strand you.
- If another app already owns that hotkey, the app prints a notice and refuses to enable click-through rather than risk trapping the mouse.

### 4. How do I find out why a track fell back to line-synced lyrics?

- Open the settings page and click **Resolve report**. It reports the source, whether lyrics came from cache, the timing mode (`Syllable`, `Line`, or `None`), line and syllable counts, the current sync offset, the parser version, and whether an API key is present.
- `SPICY_DEBUG=1` in `.env` prints the same resolve tiers to stdout in more detail.

### 5. The lyrics are slightly ahead or behind the music. How do I fix it?

- YouTube Music streams over variable buffer sizes depending on your audio drivers and sample rate.
- Use the **Sync slider** at the bottom or press `Ctrl + [` / `Ctrl + ]` to adjust the offset in 50 ms increments.
- Offsets are automatically saved per-song in `spotify_cache.json`.

### 6. How do I change the lyric font?

- The Apple-style sans is the default. To use the decorative Barriecito face, open the settings page (the gear on the hovered art, or `Ctrl + ,`) and click the **Font** row (or edit `FONT_STACKS` in `ui/app.js`).
- The choice is saved to local storage, so it survives restarts — no CSS editing required.

### 7. Where are translations and transliterations?

- When the Spicy Lyrics payload includes translation or transliteration data, it appears as a smaller line beneath the active lyric.
- Press **`T`**, or use the **Translations** row in the settings page, to toggle it on and off.

### 8. The header feels cluttered — can I make it more minimal?

- The header already only shows track info, one sliders button, and the window controls.
- Hide the bottom bar from the settings page for an even quieter view; sync adjustment stays available in the panel.

---

## ✅ Manual Smoke Checklist

The Windows-only paths (GSMTC, global hotkeys, WebView2 window) can't be exercised in CI. After a change, verify:

- [ ] Launch: `python spicy_app.py` opens the frameless overlay with rounded corners.
- [ ] Track change: title, artist, cover art, and lyrics all update; stale lyrics never appear for the previous track.
- [ ] Play/pause button toggles playback; the timer starts and stops.
- [ ] Playhead drift: during a 30s listen, lyrics stay in sync without visible jumps.
- [ ] Click-to-seek **forward**: target line becomes active and previous lines settle to "sung".
- [ ] Clicking the *blank* leading/space **around** a line (the band just under the track card) does **not** seek; clicking the line's words does.
- [ ] Drag the **west, north and NW** edges/corners: the opposite edge stays put (nothing snaps to the bottom-right corner).
- [ ] Fullscreen cannot be dragged by the card's details strip, and every resize grip is inert there.
- [ ] In fullscreen the art shows the exit button and no fullscreen/mini buttons; windowed it is the other way round.
- [ ] The PiP icon on the hovered art opens the lyrics-only mini window; its bar drags the window, the restore button brings back the previous size, and the window refuses to shrink below `320×380`.
- [ ] The lyric list shows a slim scrollbar that fades up on hover, and the playhead dot on the on-art progress bar sweeps rather than stepping once a second.
- [ ] The settings sheet is centred, shorter than the window, and scrolls internally instead of stretching edge to edge.
- [ ] Click-to-seek **backward**: no later line stays fully highlighted (this was the stale-state bug).
- [ ] Manual scroll: wheel scrolling pauses auto-follow, and auto-follow resumes ~2.4s later.
- [ ] `Ctrl + [` / `Ctrl + ]` nudge latency by 50ms, even with the overlay unfocused.
- [ ] `Ctrl + Mouse Wheel` zooms the lyric font between 18px and 60px, and the value survives restart.
- [ ] `Ctrl + ,` (or the gear on the hovered art) opens the settings page; `Esc`, its close button, and a click on the dimmed area behind it close it.
- [ ] Icons render as crisp monochrome SVG (no blue emoji play/pause glyph).
- [ ] `T` toggles the translation/transliteration layer.
- [ ] The settings page's Font row switches fonts, and the choice survives restart.
- [ ] The `−` / `+` steppers adjust sync by 50 ms and the readout updates.
- [ ] Latency offset persists per track across restarts.
- [ ] Track change cross-fades: the outgoing words fade out and the new lyrics fade in (no flash of an empty view).  - [ ] Instrumental break: a long instrumental section shows the dots + countdown, it never appears while a line is being sung, and when the countdown completes the chip pops, shrinks and fades before the next line starts.
  - [ ] Beat pulse: on a track with a short instrumental break (~4–8 s) the pulse eases through the break at reduced depth instead of going dark; on a track with a 30 s+ break the pulse stops during it.
- [ ] Diagnostics row unfolds and reports source, cache, timing mode, counts, sync, and API key state.
- [ ] Settings panel reveals with a staggered row cascade, and changing any setting pulses that row's value once.  - [ ] Hover the compact float's art: it grows into a player — transport buttons and a seekable progress bar with elapsed/total times appear on the art, and clicking the bar seeks. The resting card (art + title/artist) still looks like the first reference: compact, no transport visible until hover.
  - [ ] On-art player matches the hover state of the second reference: transport centered near the art's bottom with play/pause reflecting real playback state, progress bar seekable, times updating each second, and a subtle scrim keeping white glyphs legible over bright covers.
  - [ ] Hovering a seek bar (on-art or split) brightens it; hovering the window controls shows the same hover surface as the on-art icons.
- [ ] Motion row switches to "Reduced", the backdrop drift and dots stop, word motion disappears, and the wipe keeps working.
- [ ] Motion style cycles Auto → Subtle → Lively → Wild; the Diagnostics row shows the active style and the detected chorus-line count.
- [ ] On a song with a repeated hook, those lines breathe with a halo while live (Distract: check the chorus lines animate differently from the verses).
- [ ] `Ctrl + Shift + T` toggles click-through (the hotkey must bind; otherwise the row reports Off and a notice is printed).
- [ ] With click-through on, the mouse passes through to the app underneath, and `Ctrl + Shift + T` restores mouse control.
- [ ] Play a local file whose tags are missing (filename only): lyrics resolve, and the Resolve report's Metadata row shows `filename`.
- [ ] Play the same song from two different albums: the second triggers a lyric reload (album+duration in the track signature).
- [ ] Play from Spotify, then from a local player: session handover happens after ~4 s and lyrics follow the playing app.
- [ ] Long song (150+ lines): lyrics appear instantly after a track change, with no multi-second hitch before the first paint.

## 🤝 Acknowledgements

- [Spicy Lyrics API](https://api.spicylyrics.org) for providing rich Apple Music syllable-synced TTML payloads.
- [SimpMusic](https://github.com/brahmkshatriya/SimpMusic) for being an incredible open-source YouTube Music desktop client.
- [LRCLIB](https://lrclib.net/) for the open-source community lyrics database fallback.
- [pywebview](https://pywebview.flowrl.com/) for the cross-platform WebView2 window container.
