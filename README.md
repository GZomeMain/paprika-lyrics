# 🌶️ Paprika Lyrics (`paprika-lyrics`)

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
  - **A motion-variant engine (62 animations across 7 types):** each **word** draws a *stable* variant from a pool chosen by context — a word is one body of motion, so a split word never moves in two pieces — and the pools rotate per line so nothing repeats back-to-back. Every variant is deliberately restrained and **starts and ends at rest** — **no variant rotates more than 0.8°, moves further than 3.1 px, or changes size by more than 4%** at the default style — so the words read as emphasis rather than cartoon gymnastics.
    - `normal` (12): lift, hop, tilt, breathe, drift, bob, swell, lean, tide, knee, swaylo, swellSoft
    - `fast` (9, syllables ≤ 200 ms): tick, snap, flick, blip, skim, jitter, pat, skip, glide2
    - `hold` (10, notes ≥ 1 s): wave, ripple, bloom, ladder, swing, xwave, float, shimmer, surge, cradle
    - `backing` (6): ghost, echo, hum, veil, hush, runnel — harmonies drift out of phase with the lead
    - `chorus` (8): chorusLeap, chorusBeat, chorusSweep, chorusRipple, chorusTilt, chorusSwell, chorusArc, chorusRing
    - `chorusHold` (4): chorusChant, chorusWaveBig, chorusChime, chorusSway
    - `adlib` (13, short non-repeating asides): whisper, drop, slip, sigh, coo, dodge, peek, murmur, swaylet, flicker, wisp, nudge, settle
  - **Anticipation:** the word about to be sung leans in under a pixel as its timestamp approaches, so a line is alive *between* its words and not only on them. It eases in quadratically over ~0.5 s and never shows on a resting line. The lean is **handed over** to the word's own motion rather than dropped when the timestamp lands: the first sung frame carries the lean the word actually reached and releases it over the window it eased in, so the pop grows out of the lean continuously instead of snapping back by a percent the instant the playhead arrives. A word that never had time to lean — the first syllable of a song, or one arriving out of a seek — carries nothing and simply starts sung.
  - **One envelope drives everything:** the same rhythm-strength plan that breathes the backdrop and the sleeve also scales the words' motion amplitude (a narrow 0.9–1.15 band) and the whole-line gestures (`--line-breath`, 0.9–1.25) — so a driven chorus moves a little more than a quiet verse without a second motion model, and Beat sync Off is exactly stock.
  - **Spotlight budget:** each line earns roughly one flashy ("special") variant per ~7 syllables — longer lines can carry up to three, short ones stay restrained. Words beyond the budget rotate through their pool's quiet members, so restrained words still vary; choruses are exempt (every word of a hook lands).
  - **Chorus detection:** a lyric line performed two or more times is a hook — those lines get the chorus pools plus a live CSS special (a warm halo and a 2.4 s breathing cycle on the words), so the chorus visibly lands differently from the verses.
  - **Full-line parting:** when the active line contains a size-changing variant, the whole line breathes gently and its neighbours part vertically a few pixels (3 px, down from 6) — one composed motion instead of a grown word colliding into static text.
  - **Motion style:** Auto / Subtle / Lively / Wild scales every variant uniformly (with clamps), so the same song can read calm or explosive.
  - **Beat-synced light:** the **normal ambient background** — the same layers and colours this app always shows, not a separate glow element — breathes once per beat, and the **sleeve emits its own light**: a lamp behind the artwork, tinted with the cover's own accent, so a beat reads as something the art *does* rather than as a window-wide brightness flicker. Only opacity and transform animate, so the blurred backdrop is never re-blurred per frame. Every per-beat gesture rests at exactly its own resting value, so a paused track, a section the plan says is not driven, and switching the mode Off all settle rather than snap — the light simply stops swelling instead of going out at a section boundary. Bold deepens the lamp and only leans on the room's brightness (16 opacity points, was 30). Toggleable Subtle / Bold / Off in the panel, and respects reduced motion (which keeps the lamp's steady glow and drops the swell).
  - **Builds and drops:** the pulse is not equally hard throughout a driven section. The rhythm model also maps the track's intensity shape — onset density against the track's own median — so the pulse ramps up through a build (harder-to-start easing), hits full strength on a drop (immediate attack, longer tail), and relaxes afterwards. A flat track reports no builds and no drops; a verse-to-chorus jump deepens the pulse even without a climb. Diagnostics shows the strength range and per-track build/drop counts.
  - **Big moments:** a drop, or the first hook of a chorus, steps the scenery back — the blurred backdrop pushes in slightly, the vignette deepens and the room takes the **album's own accent colour** (the same `--art-accent` the sleeve's beat lamp is lit with, so a moment can never clash with what is playing), while the sleeve's light lifts. **Nothing about the type moves or tints:** it is the scene receding that brings the line forward, so a moment never fights the per-word animation. It is one veil whose opacity lives on a transition on the element itself — not on the state class — so entering *and* leaving a moment both ease (a drop attacks in 90 ms because it lands on the beat; everything else takes ~0.5 s), and its per-beat life comes from the beat's own clock rather than a second animation. Drops hold for the length of the drop; a hook eases in and holds two bars; a hook arriving inside a drop *is* that drop rather than a second moment. A track with no rhythm plan still gets hooks at a neutral depth, and the whole thing is **Subtle / Bold / Off** under Settings → Visuals — Off and reduced motion both leave the track completely stock. The Resolve report counts what fired, split by kind.
  - **Room air:** twenty-eight motes of the album's own colour drift through the room, each on its own slow ten-to-twenty-second cycle. It is the one effect that is *on in a silent passage too*, on purpose — a held note, an a cappella bar or a long intro otherwise reads as a frozen frame, and the drifting air is what keeps the surface alive without pretending to be the music. The beat only nudges the whole body of air on its own grid and at the same strength the pulse uses, and a drop puffs it outward while the hit is open; the drift itself never stops and never re-randomises — the field is laid out by a deterministic hash, so the room you see today is the room you see tomorrow. It sits above the grade and below the words, never takes a pointer event, and is **Subtle / Bold / Off** under Settings → Visuals, where Off, reduced motion and the mini player all leave the room completely still.
  - **Cover tilt:** the sleeve leans toward the pointer and eases back as it settles — up to about seven degrees in **Bold** (four in **Subtle**, on a 520px perspective) while it lifts a few percent toward you, with a soft gloss sliding across it as the pointer moves — and the blurred artwork behind it counter-moves up to 28px the other way. Light travelling across a surface is what makes the lean legible at a glance; a small rotation of a flat square is not. The room gains depth without a single lyric shifting. It runs on a **layer of its own** (a stage wrapping the sleeve and its lamp), because the beat already animates the artwork's transform and the backdrop's slow drift owns its own; a tilt written onto either would be overwritten by an animation. The control rows stay outside that stage deliberately — chrome that leans with the sleeve reads as broken, not as depth. **Subtle / Bold / Off** under Settings → Visuals, and reduced motion rests it outright.
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
  - **The room takes the album's colour.** The instant thumbnail is downscaled to 24×24 and its most saturated hue becomes `--art-accent` — one registered `<color>` that the beat lamp and the moment veil are both tinted with, cross-fading with the track so the light changes gradually rather than snapping to a new hue. Greys, blacks and blown-out whites contribute nothing (a colourless sleeve leaves the theme's own cool lamp on), and the sample is taken from the `data:` thumbnail the host already pushes, so no CDN's CORS headers can break it.

- **📷 Cinematic Depth of Field**
  - Active singing lines are kept in pin-sharp focus (`0px` blur).
  - Immediate neighbors receive a soft photographic blur (`1px`), while distant lines fade into an atmospheric opacity gradient without wasting GPU passes.
  - **Reserved top strip:** the floating track card is painted over the scroller, so the top of the list fades to nothing before it reaches the card. The card's bottom edge is measured (it moves with the title, the lyric font, fullscreen scaling and the art-hover parting) and the mask is sized from that, so no glyph ever shows through the card.
  - **The lyric viewport is the whole view:** scrolling is the auto-scroller's job, so the list shows no scrollbar (the 10px gutter it used to reserve is folded into the column's 32px right inset, so the type sits exactly where it did), and the active line's own `scale()` can no longer put a horizontal bar along the bottom edge. Wheel, trackpad and drag scrolling all still work.

- **🌀 Physics-Based Damped Spring Scrolling**
  - Replaced mechanical linear interpolation with a semi-implicit Euler spring solver (`k = 145, d = 23`).
  - Lyrics glide, carry inertia, and settle organically like native iOS.

- **⌨️ System-Wide Global Hotkeys & Ergonomics**
  - Adjust timing latency on the fly by ±50 ms with `Ctrl + [` and `Ctrl + ]`—even while in a full-screen game or browser.
  - Responsive font zooming from `18px` to `60px` using `Ctrl + Mouse Wheel` (saved to local storage).
  - Frameless window with native Windows 11 rounded corners (`DWMWA_WINDOW_CORNER_PREFERENCE`), moved by Windows' own modal window-move loop (`WM_NCLBUTTONDOWN` + `HTCAPTION`) so it snaps to screen edges and scales correctly per monitor — the same gesture, and the same DPI handling, as any other title-bar window.

- **⚡ Smart Fallbacks & Offline Storage**
  - Zero-auth Spotify track ID scraper with iTunes & Deezer fallbacks, plus LRCLIB search fallback when exact lookup misses.
  - Automatic fallback to LRCLIB with phonetic sub-syllable splitting for tracks without studio TTML.
  - **Musical word timing for line-synced fallbacks:** LRCLIB only timestamps whole lines, so word fills used to march at one robotic pace. A timing model now distributes each line's window over its syllables using the track's tempo (mean inter-onset interval), delivery density, an energy factor (pulse near the ~150 BPM sweet spot + sung-to-written ratio), and prosodic stress — content words hold the beat while glue words ('in the', 'a') rush past. Syllable runs from the Spicy API are matched to LRCLIB lines **by text** (sliding-window word match, not length), and the matched line's timestamp re-anchors the item to fix constant clock offsets between the two sources.
  - Thread-safe bounded LRU disk cache (`storage.py`) with a 3-day TTL, debounced writes, and atomic flushes to eliminate disk thrashing.
  - **Self-healing cache:** every cached payload is re-validated when it is read. A payload whose repeated lines share one timestamp — the fingerprint of a bad merge — is discarded and refetched instead of served, so a poisoned cache can never reach the screen even if it carries a parser version the current build accepts. Startup also sweeps out payloads from older parser versions, so the file cannot accumulate one dead generation per parser change (measured: a 10.8 MB cache reduced to 0.27 MB).
  - **Settings persist.** The UI's preferences (motion style, beat sync, big moments, room air, cover tilt, opacity, layout, font, card position, alignment, always-on-top, hover fade) are written to the Edge WebView2 profile in `.webview/` beside the app. Delete that folder to reset every preference at once; move it with `SPICY_WEBVIEW_DIR`.
  - **Works with any audio source.** Anything that broadcasts to Windows System Media Transport Controls is followed — Spotify, browsers, and local players like MusicBee, foobar2000 and Windows Media Player. Local files with poor tags are repaired before lookup: filename stems ("07 - Artist - Title.mp3"), track-number prefixes and underscore titles are cleaned, and the album name (when the player provides a real one) sharpens both the LRCLIB and Spotify-ID lookups. The Resolve report shows the album and whether metadata came from tags or a filename repair. (Apps that never broadcast to Windows media controls cannot be followed — Windows offers no alternative short of audio capture.)
- **VLC support (HTTP interface).** VLC 3.x does not broadcast to Windows media controls, so the overlay polls VLC's Lua HTTP interface instead. One-time setup in VLC: Tools → Preferences → Show settings: All → Interface → Main interfaces → check **Web**; then Main interfaces → Lua → set a **Lua HTTP password**. Then add to the overlay's `.env`:

  ```env
  VLC_HTTP_PASSWORD="your_lua_password"
  VLC_HTTP_HOST=127.0.0.1   # optional, default 127.0.0.1
  VLC_HTTP_PORT=8080        # optional, default 8080
  ```

  When no Windows media session is active the overlay polls VLC (~0.7 s while playing, 2 s idle) for the playing file's tags, position and length — untagged files are repaired from the filename exactly like the SMTC path — and the transport buttons/seek bar drive VLC via `pl_pause`/`pl_next`/`pl_previous`/`seek`. SMTC sessions always take priority when present.

- **📁 Local TTML library (bring your own lyric files)**
  - Some songs are simply wrong online: the commercial release is trimmed, the timings drift, or a live take is on every database as the studio version. Keep your own Apple-Music-style `.ttml` files and the overlay uses them — **a local file outranks both the network and the lyric cache**, because a file you placed is a decision, not a hit rate. Local files are also never written into the cache: the file stays the source of truth, so you can fix a line and hear the fix on the next play.
  - **Where they live:** `ttml/` next to the app by default (git-ignored, and it explains itself with its own `.gitignore`), or anywhere via `SPICY_TTML_DIR`. Subfolders are fine — a curated collection can keep its own structure. Manage everything from **Settings → Local lyrics**: *Import files…* (native picker, multi-select), *Rescan*, *Open folder*, per-file *Use here* / *Remove* (removes move to a `.trash` folder inside the library rather than deleting anything for good), and a *This song* card showing exactly which file is serving the playing track.
  - **Matching is conservative by design.** A file you bound by hand always wins. Otherwise a file is used automatically only when its **own metadata names the same title *and* artist** (compared accent-, case- and punctuation-insensitively, with feature credits and `&`/`and` handled), and when two files both claim the song the album, then the runtime, breaks the tie. Anything weaker — a file named after the song but carrying no artist tags, or a genuine tie — is offered in the panel as *"Looks like this song"* instead of being applied silently: a wrong match is worse than no match. Bindings are stored against title + artist, so a track keeps its file whether or not the player reports the album or duration that day.
  - **What it parses:** the Apple/AMLL dialect in full — `itunes:timing="Word"` (per-syllable spans, with the significant space inside a span, between spans, or in a space-only span) and `"Line"` (line windows distributed into musical word timing with the same model the LRCLIB fallback uses), inline `x-translation` / `x-roman` and `x-bg` background vocals (word-timed or not), Apple's header translations/transliterations linked by `itunes:key`, nested word spans that wrap syllables, and `amll:meta` / `ttm:title` / `ttm:agent` metadata. Namespaces are treated as advisory (matched by local name), a BOM is tolerated, and clock/offset/frame timestamps all parse. A file that will not parse is **kept and flagged** in the panel with the reason instead of being dropped or allowed to break playback.
  - **Diagnostics** reports the file and whether it was bound or auto-matched, and its cache row reads **Local file**. A local file opens at the tuned **+800 ms** baseline — there is no fetch latency to compensate for.

- **🌐 Translations, Transliteration & Letter Timing**
  - Optional translation/transliteration layer rendered beneath the active lyric, toggleable from the settings page or `T`.
  - Honors per-letter timing when the payload provides it, revealing each glyph on its own clock.

- **⚡ Rendering Scale**
  - Lyric lines split into per-glyph spans **lazily**: only lines near the viewport materialize, so a long song no longer builds tens of thousands of never-visible elements before the first frame.
  - Depth-of-field styling is applied per depth bucket and skipped when a line's depth has not changed, so moving the focus no longer restyles every line in the song.

- **🖥️ Desktop-Overlay Extras**
  - **Mini player (lyrics only):** the PiP icon on the hovered art shrinks this same window to a lyrics-only surface, `320×380` at the smallest and `900×1200` at the largest. It is a *mode* of the overlay rather than a second window, so the song, playhead and sync carry straight over — no second copy of the pipeline — and the remembered mini size is kept apart from the real one, so leaving mini restores the window you were working in. Fullscreen and mini are mutually exclusive by construction.
    - **It pins itself on top** (a lyrics strip that sinks behind the browser you just clicked is useless) and puts your always-on-top setting back on the way out — unless you changed it while mini, which is taken as your new preference.
    - **Its bar is hidden until you reach for it:** the buttons slide in when the pointer enters the top band and leave again when it drops away, so the mini window is lyrics and nothing else in use. The drag strip under them never moves, so a hidden bar is never an unmovable window — and `Esc` leaves mini outright.
  - **Card position:** the track card sits at the lyrics' left gutter by default; *Card position* in the settings cycles **Left → Center** for anyone who prefers the sleeve floating over the middle. The title and artist stay left-aligned with the art either way — centring wrapped text under a square sleeve shifts both lines on every re-wrap.
  - **Fade while hovered:** the overlay can go slightly see-through (Off / Light / Clear) while the pointer is over it, which is exactly when you are reading what is behind it; holding `Ctrl` keeps it fully solid. The fade is done with a natively layered window, so the web content, the artwork backdrop and the glass fade as one surface. It is forced opaque in fullscreen (a dimmed monitor is not transparency) and while click-through is on (there are no pointer events left to tell it the pointer has gone).
  - **Anchored resizing:** every edge and corner drag is handed to pywebview as a fix point, which applies position and size in a single `SetWindowPos`. Grabbing the west edge therefore holds the east edge still and a corner drag pins the opposite corner, instead of the window always growing from its top-left. Fullscreen disables the grips entirely, and the whole overlay is undraggable there (drag regions are removed from the DOM, because pywebview's drag is a JS walk-up over marked elements — CSS `app-region` never took part in it).
  - **Click-through mode** (`Ctrl + Shift + T`): the overlay ignores the mouse entirely so it can sit over a game or browser. It is refused unless that escape hotkey actually registered, so the window can never become mouse-proof with no way back.
  - **Instrumental break countdown:** long instrumental sections no longer look frozen. The glass chip (dots + countdown) sits as its **own row in the lyric flow** — between the just-sung line and the next one — so it reads as part of the song and never displaces or indents the upcoming lyric.
    - The three dots are a **continuous meter**: each fills across its third of the countdown, so the row visibly fills up and reaches the timer exactly as it reads 0:00. The value lifts to full white as it completes.
    - Enter/exit are row animations, not display flips: the row grows from zero height (pushing the upcoming lyric down rather than jumping it), and on completion the chip pops (+7%), shrinks and fades — finished just before the next line is sung. Pausing or seeking closes it smoothly. Reduced motion drops the animations but keeps the chip.
    - It only starts with real headroom left (>3.2 s of break), so a chip can never flash in for a moment and leave again.
  - **Diagnostics readout:** the settings page unfolds a resolve report — source, cache hit/miss, timing mode, line and syllable counts, sync offset, **the app version** and the parser version (the build you are on, and the cached-payload format it speaks), and whether an API key is configured. It also reports the **player** the overlay is following, what its **transport** can actually do (timeline live / no timeline from player, duration known / unknown) and the outcome of the **last command** sent to it — so a player that publishes nothing reads as a fact about that player instead of looking like a broken overlay.
  - **Honest transport:** the duration, playhead and seek bar follow what the player actually publishes. When a player publishes no track length, the duration reads `--:--`, the seek rails turn inert (a fraction of an unknown total would be a guess), and the elapsed time keeps counting on the overlay's own clock. A transport command that the player refuses is reported and a refused seek is rolled back, instead of leaving the UI showing a position playback never reached.
  - **Reduced motion:** honours the OS preference by default and is toggleable in the panel. Decorative motion (backdrop drift, room air, cover tilt, pulsing dots, word variants, type specials) stops; the lyric fill is always kept, because it carries information.
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
│  0. Local TTML (core/ttml_library.py) — wins if bound  │
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
   git clone https://github.com/GZomeMain/paprika-lyrics.git
   cd paprika-lyrics
   ```

2. **Install Dependencies**

   ```bash
   pip install -r requirements.txt
   ```

   *(or run the `pip install` command listed above)*

3. **Configure Environment Variables**

   No API key is bundled with the source. Copy the committed template and fill in your key:

   ```bash
   cp .env.example .env
   ```

   (On Windows: `copy .env.example .env`.) The two that matter:

   ```env
   SPICY_API_KEY="your_api_key_here"
   SPICY_BASE_URL="https://api.spicylyrics.org"
   ```

   Without a key, the app still works but falls back to line-synced LRCLIB lyrics instead of syllable-synced Spicy Lyrics.

   Every optional override — `SPICY_TTML_DIR`, `SPICY_WEBVIEW_DIR`, `SPICY_CACHE_TTL_SECONDS`, `SPICY_DEBUG` — is listed with its default in [`.env.example`](.env.example).

4. **Launch the Overlay**

   ```bash
   python paprika_app.py
   ```

5. **Start Listening**

   Open **SimpMusic** (or Spotify / any browser playing music) and play any track. The lyrics, background colors, and album cover will load automatically!

---

## 🧱 Building a Standalone `.exe`

No Python install is needed by the person running it.

```bash
pip install pyinstaller
python -m PyInstaller PaprikaLyrics.spec --noconfirm
```

The result is `dist/PaprikaLyrics/PaprikaLyrics.exe`, which must be kept together with
its `_internal/` folder — it is a **onedir** build, so the whole
`dist/PaprikaLyrics/` folder is what you copy or zip. A onefile build would re-unpack
itself into a temp directory on every launch (slower startup, and a second place
for state to hide), which is why the spec does not produce one.

**Where the exe keeps your data.** Everything the app *writes* lives in the folder
holding the executable, never inside the bundle:

```text
PaprikaLyrics/
├── PaprikaLyrics.exe      # the app
├── _internal/           # the bundled UI and libraries — do not edit
├── .env                 # create this beside the exe for your SPICY_API_KEY
├── .webview/            # WebView2 profile: your settings. Delete to reset them
├── ttml/                # your local .ttml lyric library
└── spotify_cache.json   # lyrics cache and per-track offsets
```

That split matters: a PyInstaller bundle is unpacked into a temporary folder that
is deleted when the app closes, so a profile or a cache resolved against it would
be rebuilt from nothing on every launch.

**Before you share a build:** it is unsigned, so Windows SmartScreen will warn on
first run ("More info" → "Run anyway"). If you want to reduce that, sign it with a
code-signing certificate; the spec deliberately disables UPX compression, which is
a common cause of false positives.

---

## 🎮 Controls & Shortcuts

| Action | Shortcut / Gesture | Description |
| --- | --- | --- |
| **Nudge Latency Later** | `Ctrl + [` | Moves lyrics **later** by 50 ms (works system-wide) |
| **Nudge Latency Earlier** | `Ctrl + ]` | Moves lyrics **earlier** by 50 ms (works system-wide) |
| **Zoom Font Size** | `Ctrl + Mouse Wheel` | Dynamically scales font between `18px` and `60px`. Works in fullscreen too — the windowed zoom becomes a ×1.7 multiplier there |
| **Move Window** | Click & Drag the top band of the window, or the track card | Repositions the overlay with a **native window move** — no hand cursor, no page-side drag loop. Windows' own caption move is tried first, because it brings Aero Snap, per-monitor DPI and drag-to-restore with it; that loop needs the mouse capture WebView2 is holding, so if it does not take over within a moment **the host moves the window itself**, following the pointer at the display's own scale. Either way the window keeps the grab offset, so a handover mid-drag continues instead of jumping. The surfaces are the top band, the track card (sleeve and title included) and the mini bar's handle; everything inside them that owns its own gesture — the seek row, the transport, the on-art buttons — opts out, so dragging the bar seeks instead of moving the window. The outermost pixels of each edge stay resize grips, and minimise/close stay clickable. **Fullscreen is a fixed surface**: the gesture is refused there, so the overlay cannot be torn off the monitor |
| **Resize Window** | Click & Drag any edge or corner | Resizes with the grabbed edge anchored — dragging the west edge holds the east edge still, a corner drag pins the opposite corner. Disabled in fullscreen, where the window already covers the monitor |
| **Jump to Lyric** | Click the **words** of a lyric line | Seeks playback in SimpMusic directly to that timestamp. Only the glyphs are a target: the leading and margin around a line are not, so the space under the track card never seeks by accident |
| **Settings page** | Gear icon on the hovered art, or `Ctrl + ,` | Opens a **full-window sheet**, not a dropdown — **four pages under one search field**. **Window** (opacity, fade, layout, fullscreen, always on top, click-through, card position), **Lyrics** (latency, translations, font, alignment, and the local `.ttml` library), **Visuals** (motion, motion style, beat sync, big moments, room air, cover tilt), and the collapsed **Diagnostics** report last. The page you last read is the page it opens on. The search field filters every page by row name *and* by the prose underneath it, marking the run that matched — `/` focuses it, `Esc` clears the query before it closes the sheet, and clearing brings back the page you were on. The resolve report is deliberately not searchable: it reports what the pipeline did rather than being a setting. Closes on the button, `Esc`, or a click on the dimmed area behind it |
| **Search settings** | The field above the tabs, or `/` | Finds a row by name from any page — and by the sentence that explains it, which is how you find *Latency* when the word you remember is "timing". Results keep their group heading, the matched run is marked in place, an empty result names what you typed, and clearing the field restores the page you were on |
| **Nudge Sync** | `−` / `+` in the settings page | Adjusts latency by 50 ms without opening the bottom bar |
| **Local lyrics** | "Local lyrics" group in the settings page | Your own `.ttml` files, managed in one place: *Import files…* opens the native picker and copies the selection into the library, *Rescan* re-reads the folder (for files dropped in directly), *Open folder* reveals it in Explorer. Each file shows its song, artist, timing mode, line count and its state — **Auto-matched**, **Bound here**, **Looks like this song** (a suggestion), **Off for this song** — or the reason it will not parse. Removed files are moved to a `.trash` folder inside the library |
| **Use a local file** | "Use here" on a file row | Binds that file to the **playing** song and reloads the lyrics immediately — no waiting for the next track. The binding is remembered against the song, so it comes back on the next launch |
| **Ignore a local file** | "Use online instead" on the current-song card | Falls back to the online sources for that song, and **stays** that way: the choice is remembered, so the auto-match cannot quietly take the song back. "Allow local file" reverses it without losing the file you had chosen |

| **Toggle Translations** | `T` key or "Translations" row | Shows/hides translation & transliteration beneath the active lyric |
| **Change Lyric Font** | "Font" row in the settings page | Switches between the Apple-style sans (default) and Barriecito (saved locally) |
| **Reduce Motion** | "Motion" row in the settings page | Toggles decorative motion (backdrop drift, dots, word motion, type specials) off and on (saved locally). The lyric fill always stays, since that carries information |
| **Motion Style** | "Motion style" row in the settings page | Cycles **Auto → Subtle → Lively → Wild** (saved locally). Scales every animation variant and type special uniformly, clamped so even Wild stays clean |
| **Latency** | Sync rail, settings page, or `Ctrl+[` / `Ctrl+]` | Per-track sync offset, saved per song. A track whose lyrics are already cached — or served from a **local `.ttml` file** — opens at **+800ms**; a fresh fetch (cache miss) opens at **+1500ms** instead, because the pipeline does network work the cached path never does. Both are starting values only — your own nudge is remembered and always wins |
| **Fullscreen** | "Fullscreen" row, `F11`, or the expand icon on the hovered art | Covers your monitor at **normal window state** — not a maximized window, so nothing can shrink it back to the work area behind your back — with the frame, the DWM border and the rounded corners switched off for the duration (a rounded surface over a whole monitor would show four desktop wedges). Lyrics, gap indicator and hover art all scale up, and the lyric column moves out to the card's own column there (16px outside the sleeve) instead of hugging the window edge, so the card reads as the head of the column it floats over; the windowed rect and window style are restored exactly on exit, and closing the app while fullscreen remembers the *windowed* size, not the monitor. `Esc` leaves fullscreen, and the pointer hides after two still seconds of its own accord — any movement brings it straight back, and it is never hidden while the settings sheet or a seek/resize is up. Always-on-top is left to your own setting. In fullscreen that slot becomes the **exit** button (withdrawing the corners) — the two never show at once |
| **Mini Player** | The PiP icon on the hovered art (windowed only), or `Esc` to leave | Shrinks this same window to a **lyrics-only** surface between `320×380` and `900×1200`: the track card, header, split panel and sync rail retire, and the window is pinned **always on top** so it floats over the work it is describing. Its bar stays hidden until the pointer reaches the top band, where settings / restore / close slide in — the window can be dragged from that band the whole time. Its size is remembered separately, so leaving mini restores the window you were working in, and your always-on-top preference comes back with it |
| **Layout Mode** | "Layout" row in the settings page, or the panels icon on the hovered art (both layouts) | Cycles **Compact → Split** (compact is the default; saved locally). In both the top bar disappears and art + title + artist float a bit lower, seamlessly. Split adds a large art panel with its own transport on the left — fullscreen only; picked while windowed, it activates on entering fullscreen |
| **Lyric Alignment** | "Alignment" row in the settings page | Cycles **Left → Center → Right**; the karaoke wipe's transform origin follows the alignment so the highlight always sweeps in from the anchored edge |
| **Hover Art** | Hover the artwork (fullscreen, or the split panel) | The picture dims uniformly (not a vignette) so the glyphs stay legible over a white sleeve, and the art grows into the player itself: prev/play/next with the seek row, plus layout / settings / fullscreen+mini (or the exit, in fullscreen) along the top — in both compact and split. In fullscreen the lyrics part downward while hovered. The row's play/pause is the art's only play control |
| **Track Card (compact)** | Always visible, left-aligned | The card is a column that scales with the window: the sleeve on top (full card width, square) with the player on it — transport and the seek row with its times, revealed on hover — then the title and artist under it. It sits at the lyrics' left gutter by default and can be centred (see *Card Position*). It is the window's drag region, so it can be moved from anywhere on it; the seek bar, the transport and the on-art buttons opt out individually. Hovering the windowed card lifts it a hair instead of growing it, so the lyrics never move for it |
| **Seek Bar (card + split)** | Click or drag the bar under the transport | The app draws **one** progress bar per mode: the compact card's on the cover, directly under the transport it belongs to, or the split panel's under its art. Elapsed sits left, total right, with a dot riding the playhead that snaps on a seek and sweeps continuously while playing. Seeking while paused never starts playback |
| **Latency Rail** | Hidden at the right edge; slide in from the right | A vertical liquid-glass sync slider (drag, click, or nudge with the small ± buttons — hold to repeat). Zero sits mid-track; the fill grows toward the thumb. The trigger is the rail's **own footprint** (its height, plus a small pad), not a band down the whole right edge, so brushing the right side of the window no longer throws the rail open |
| **Window Move / Resize** | Drag the top strip, or drag any edge/corner | The whole top edge moves the window; all eight edges and corners resize it, each anchored on the opposite edge |
| **Always on Top** | "Always on top" row in the settings page | Keeps the overlay above other windows. **Off by default**, and the saved value is applied at launch (the window is created non-topmost and the setting takes effect as soon as the bridge is ready). The **mini player forces it on** while it is up and restores your preference on exit — change it *while* mini and that becomes the preference that comes back |
| **Click-Through Mode** | "Click-through" row, or `Ctrl + Shift + T` anywhere | Makes the overlay ignore the mouse so it can sit over a game/browser; the hotkey turns it back off. Your chosen **Window opacity** keeps applying while click-through is on, so a click-through overlay can be a genuinely seamless translucent pane. Because a click-through window cannot be dragged at all, **`Ctrl + Shift + M` peeks**: it hands the mouse back for a few seconds so you can move or resize the overlay, then returns to ignoring it (press it again to end the peek early) |
| **Card Position** | "Card position" row in the settings page | Cycles **Left → Center** for the windowed track card (saved locally). Left, the default, lines the card up with the lyrics beneath it; Center floats it over the middle of the window |
| **Window Opacity** | "Window opacity" row in the settings page | Cycles **Off → 95% → 90% → 80% → 70% → 60%** (saved locally). The value applies the whole time the overlay is windowed — the mini player and click-through included — and the fade is native, so the web content, the artwork backdrop and the glass read as one translucent pane rather than the page dimming inside an opaque frame. Fullscreen always stays solid |
| **Fade While Hovered** | "Fade while hovered" row in the settings page | Cycles **Off → Light → Clear** (saved locally). The window dips a little below your **Window opacity** while the pointer is over it and returns the moment it leaves — never below the opacity you chose. **Hold `Ctrl`** (or open the settings sheet) to cancel just the dip without moving the pointer. It works with **click-through** on too: a click-through window receives no mouse messages, so the host reads the pointer against the window rectangle and the dip follows it — the mini player still gets out of the way of the game it is floating over |
| **Diagnostics** | "Resolve report" row in the settings page | Unfolds the resolve/timing report (source, cache, timing mode, counts, sync, parser, API key, the followed player and its transport, and the last command's outcome) |
| **Play / Pause** | Play/pause icon on the hovered art (or the split panel) | Toggles media playback in SimpMusic |

The window itself carries no outline: no stylesheet border and no DWM border in either state, so it reads as a surface over the desktop rather than a framed rectangle.

The header stays minimal on purpose: the track info and the minimise/close controls. In compact and split it fades out completely — the band it occupies still moves the window, and the window controls stay live.

All controls use crisp monochrome SVG icons rather than text/emoji glyphs, so nothing picks up Windows' blue emoji rendering.

Close the panel with `Esc`, or by clicking anywhere outside it.

---

## 📂 Project Structure

```text
paprika-lyrics/
├── config.py              # Central configuration (APP_VERSION, PARSER_VERSION=11, latency defaults 800/1500 ms, cache TTL)
├── storage.py             # Thread-safe bounded LRU disk cache with 3-day TTL (spotify_cache.json)
├── paprika_app.py           # Entry point, window lifecycle (fullscreen, mini player, clamped anchored resize), Win32 hotkeys
├── requirements.txt       # Python dependencies
├── PaprikaLyrics.spec       # PyInstaller build: bundles ui/, writes nothing into the bundle
├── .env.example           # Committed template for .env: the API key and every optional override
├── .github/workflows/     # CI: the Windows test suite on Python 3.10-3.13, plus the UI regression checks
├── .gitignore             # Ignores __pycache__, .env, the local listening cache (including .bak copies) and agent scratch dirs
├── ttml/                  # Local TTML lyric library (git-ignored; created on first import)
├── core/
│   ├── __init__.py
│   ├── beat.py            # Rhythm model: tempo + phase grid, occupancy trigger, pulse runs
│   ├── hotkeys.py         # Layout-aware Win32 RegisterHotKey daemon (sync, click-through)
│   ├── lyrics.py          # Parallel executor orchestrating Local TTML, LRCLIB & Spicy resolution + diagnostics
│   ├── metadata.py        # Regex cleaner stripping YouTube Music tags, video noise, and features
│   ├── native_window.py   # ctypes Win32 seam under an injectable user32/dwmapi (fullscreen repair, resize anchors)
│   ├── parser.py          # Payload/LRC parser: lead/background vocals, letters, the word-timing model
│   ├── resolver.py        # Multi-tiered track resolver (SpotifyScraper -> iTunes -> Deezer)
│   ├── smtc.py            # Windows GSMTC listener & live byte-stream album art extractor
│   ├── timeline.py        # Pure timeline normalization (units, origin, liveness) + monotonic playhead clock
│   ├── ttml.py            # Pure Apple/AMLL TTML parser (word & line timing, roles, translations, metadata)
│   └── ttml_library.py    # Local library: folder index, per-track bindings, conservative matching
├── tests/                 # unittest coverage for parser, TTML, storage, beat, timeline, transport, window API
├── tools/
│   ├── smtc_diagnose.py   # Read-only GSMTC diagnostic: sessions, raw timeline, explicit transport tests
│   ├── ui-preview-regression.js       # The UI invariant assertions (run headlessly by the runner below)
│   └── run-ui-preview-regression.mjs  # Dependency-free headless Chromium runner for those checks
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

- Open the settings page and click **Resolve report**. It reports the source, whether lyrics came from cache, the timing mode (`Syllable`, `Line`, or `None`), line and syllable counts, the current sync offset, the app version, the parser version, and whether an API key is present.
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

### 8. How do I use my own `.ttml` file for a song?

- Open **Settings → Local lyrics → Import files…** and pick the `.ttml` (or drop files straight into the `ttml/` folder and press **Rescan**). Copying is non-destructive: an existing name is never overwritten, and a file already inside the library is left alone.
- If the file's own metadata names the playing song's **title and artist**, it is used automatically. Otherwise play the song, find its row and press **Use here** — the binding is saved against that song, and the lyrics reload the moment you press it.
- Set `SPICY_TTML_DIR` in `.env` to keep the library somewhere else (a synced folder, a curated collection, another drive).

### 9. My local file exists but the app still shows online lyrics. Why?

- Check the **This song** card in **Settings → Local lyrics**: it names the file in use, or says *No local file*. If the file is listed as *Looks like this song*, its metadata did not match confidently — press **Use here** once and it will not have to guess again.
- A file may also be switched off on purpose: *Off for this song* means you pressed **Use online instead** at some point. **Allow local file** brings it back.
- If a row shows a warning instead of a song, the file did not parse; the reason (unbound prefix, no lyric lines, wrong root element…) is printed on the row, and the file is kept so you can fix it in place and press **Rescan**.
- A `.ttml` that matches the title but not the artist is **not** applied automatically, and two files claiming the same song with nothing to tell them apart are left for you to choose. Both are deliberate: silently picking the wrong file is worse than asking.

### 10. A player shows no song duration, and the seek bar does nothing. Why?

- The overlay only reports what the player publishes through Windows' media session (GSMTC), and it will not invent a length it was not given.
- Some players publish only their status and metadata. **SimpMusic on Windows publishes no timeline at all**: position, length, both seek bounds are zero and the last-update stamp is left at Windows' never-written sentinel (verified on this machine). Lyrics still scroll on the overlay's own clock, transport buttons still work, but the duration reads `--:--` and the seek rails are inert because there is no total to take a fraction of. That is an upstream gap in the player, not something the overlay can derive.
- To see exactly what a player publishes, run the read-only diagnostic with the project's Python (it never changes playback unless you pass `--toggle` / `--seek`): `python tools/smtc_diagnose.py --app SimpMusic --watch 8`. Compare it with a working player the same way.

### 11. The header feels cluttered — can I make it more minimal?

- The header is already down to the track info and the window controls, and in compact/split it fades out entirely.
- Turn on **Fade while hovered** (Settings → Window) for the quietest version of all: the overlay becomes see-through whenever you are looking past it.

---

## ✅ Manual Smoke Checklist

The Windows-only paths (GSMTC, global hotkeys, WebView2 window) can't be exercised in CI. After a change, verify:

- [ ] Launch: `python paprika_app.py` opens the frameless overlay with rounded corners and **no light outline** around it (check over a white desktop, where DWM's border used to show).
- [ ] Track change: title, artist, cover art, and lyrics all update; stale lyrics never appear for the previous track.
- [ ] Play/pause button toggles playback; the timer starts and stops.
- [ ] Playhead drift: during a 30s listen, lyrics stay in sync without visible jumps.
- [ ] Click-to-seek **forward**: target line becomes active and previous lines settle to "sung".
- [ ] Clicking the *blank* leading/space **around** a line (the band just under the track card) does **not** seek; clicking the line's words does.
- [ ] Drag the **west, north and NW** edges/corners: the opposite edge stays put (nothing snaps to the bottom-right corner).
- [ ] Fullscreen cannot be dragged by the card's details strip, and every resize grip is inert there.
- [ ] In fullscreen the art shows the exit button and no fullscreen/mini buttons; windowed it is the other way round.
- [ ] The PiP icon on the hovered art opens the lyrics-only mini window; its bar drags the window, the restore button brings back the previous size, and the window refuses to shrink below `320×380`.
- [ ] While mini, the window stays above other apps even with **Always on top** off, and leaves mini with that setting exactly as it was.
- [ ] In mini, the bar's buttons are invisible until the pointer reaches the top edge, and the window can still be dragged there while they are hidden. `Esc` leaves mini.
- [ ] Windowed, dragging the **top band** of the window moves it (including from just under the header line), minimise and close still click, and the outermost pixels of the top edge still resize.
- [ ] Drag the overlay by its top band to the left edge of the screen and to a corner: it snaps to the edge/corner the way a normal window does, and dragging it back off releases the snap. If a drag does **not** snap, the host's own move is driving it — say so, because snapping is the one thing only Windows' caption loop gives us.
- [ ] Hover the sleeve: the transport and the seek row with its times are on the cover, and no grab/hand cursor appears over the card, the top band or the mini bar.
- [ ] Drag the **track card by its sleeve**, and by its title text: the window moves in both cases.
- [ ] While playing, drag the card's **seek bar**: the playhead follows the pointer and the window does not move.
- [ ] Fullscreen cannot be dragged by that band either, and the grips stay inert there.
- [ ] Settings → **Card position: Center** moves the card over the middle and **Left** puts it back at the lyrics' gutter; the title/artist stay left-aligned with the art in both.
- [ ] Settings → **Window opacity: 80%**: the whole overlay (content, artwork backdrop and glass together) turns see-through and *stays* that way while windowed — move the pointer away, resize, restart the app: still 80%.
- [ ] Settings → **Fade while hovered: Light** with opacity at 80%: the window dips only while the pointer is over it, never below the 80% you chose, and holding `Ctrl` (or opening the settings sheet) cancels just the dip.
- [ ] Enter fullscreen at 80% opacity: it is fully solid; leave fullscreen: back to 80%.
- [ ] Click-through on with opacity at 80%: the overlay stays see-through **and** keeps ignoring the mouse, `Ctrl + Shift + M` makes it clickable for a few seconds (drag it somewhere), and it returns to click-through by itself.
- [ ] Fullscreen: the corners show no rounded wedges and no 1px border, an auto-hidden taskbar does not cut into it when the pointer hits the screen edge, `Esc` leaves it, and the pointer disappears after two seconds of stillness and comes back on the first move.
- [ ] Settings: every row's label starts on the same column as the group heading above it (they used to centre inside the row).
- [ ] Settings: the four tabs (Window / Lyrics / Visuals / Diagnostics) each open on their own rows, the last page read comes back when the sheet is reopened, and no label drifts off the column when you switch between them.
- [ ] Settings search: typing a row's name finds it from any page, typing a word that only appears in a hint finds that row with the word marked, `Esc` clears the query before it closes the sheet, and `/` jumps to the field.
- [ ] Fullscreen: the lyrics start on the card's column (level with the sleeve, just outside it), and leaving fullscreen returns them to the window edge without a jump.
- [ ] Click-through on with a hover dip set: move the pointer over the mini player and watch the window dim as it arrives and lighten as it leaves, with no click reaching the page.
- [ ] Close the app while fullscreen, then relaunch: it opens at the windowed size and position you had, not at monitor size.
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
- [ ] Watch a word land on a live line: the lean it held while waiting continues into the sung pop — no flicker, no one-frame shrink or drop as the playhead reaches it.
- [ ] On a song with a repeated hook, those lines breathe with a halo while live (Distract: check the chorus lines animate differently from the verses).
- [ ] Beat sync: the sleeve's light swells on each beat and settles between them, and Bold is visibly deeper than Subtle without the window flashing. A quiet section stops swelling instead of the light cutting out, and Beat sync Off fades the lamp away rather than popping it.
- [ ] Big moments: on a track with a real drop, the room steps back and takes the album's colour on the drop while the sleeve's light lifts — and the words neither move nor tint. Turning Big moments Off **mid-song** eases the grade back over ~0.5 s with no flash and no hard cut; a track with no drops only shows moments on its chorus hooks.
- [ ] With Big moments off, or reduced motion on, nothing about the scene changes for the whole track (compare against the same passage with it on).
- [ ] Room air: on a quiet ballad the motes drift continuously and lift a little on each beat, and on a track with a drop they puff outward while it is open. **Settings → Visuals → Room air: Off** leaves the room completely still, and the mini player shows no air at all.
- [ ] Cover tilt: moving the pointer across the sleeve leans it toward the pointer and the blurred room slides the other way, in both the windowed card and the fullscreen split panel; the control row does **not** lean. **Cover tilt: Off** makes the sleeve rigid again, and turning Motion to Reduced rests it.
- [ ] Play a warm album and a cool album back to back: the lamp and the moment grade cross-fade to each one's own colour within about a second of the track changing, and a greyscale sleeve leaves the theme's cool default in place.
- [ ] Scroll the lyrics with the wheel at 330×380 and 1400×900: no scrollbar appears on either axis, and a long active line is not clipped.
- [ ] Change any setting, close the app, reopen it: the setting is still there. Delete `.webview/` and reopen: every setting is back to its default.
- [ ] `Ctrl + Shift + T` toggles click-through (the hotkey must bind; otherwise the row reports Off and a notice is printed).
- [ ] With click-through on, the mouse passes through to the app underneath, and `Ctrl + Shift + T` restores mouse control.
- [ ] Settings → Local lyrics → **Import files…**: pick a `.ttml`; it appears in the list with its title/artist/timing/line count, and the status line reports what was added.
- [ ] With a matching song playing, the file is used on its own, the *This song* card names it, and the Resolve report's **Local TTML** row names it too (cache row reads `Local file`).
- [ ] For a song with no metadata match: press **Use here** on its row — the lyrics switch to the local file within a second, **without** changing track.
- [ ] Press **Use online instead**: online lyrics come back, and the choice survives a restart (the file is not silently re-adopted).
- [ ] Press **Remove** on a file: it asks for a second click, then the file leaves the list and appears in `ttml/.trash/` on disk.
- [ ] Import a real-world Apple Music export (word-timed, with `xml:lang` metadata): lyrics render syllable-accurately — no line-stepping, no wrapped-line drift.
- [ ] Import a broken `.ttml`: the row shows the parse error, nothing is applied for any song, and playback continues unaffected.
- [ ] Edit an imported file's line while it is playing, then press **Rescan** and replay: the edited line is what appears.
- [ ] Play a local file whose tags are missing (filename only): lyrics resolve, and the Resolve report's Metadata row shows `filename`.
- [ ] Play the same song from two different albums: the second triggers a lyric reload (album+duration in the track signature).
- [ ] Play from Spotify, then from a local player: session handover happens after ~4 s and lyrics follow the playing app.
- [ ] Long song (150+ lines): lyrics appear instantly after a track change, with no multi-second hitch before the first paint.

## 🤝 Acknowledgements

- [Spicy Lyrics API](https://api.spicylyrics.org) for providing rich Apple Music syllable-synced TTML payloads.
- [SimpMusic](https://github.com/brahmkshatriya/SimpMusic) for being an incredible open-source YouTube Music desktop client.
- [LRCLIB](https://lrclib.net/) for the open-source community lyrics database fallback.
- [pywebview](https://pywebview.flowrl.com/) for the cross-platform WebView2 window container.

## 📄 License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it; there is no warranty.

This app renders lyrics it does not own: the lyrics themselves belong to their
rights holders and are fetched at runtime from the sources listed above. Nothing
is bundled with the source.
