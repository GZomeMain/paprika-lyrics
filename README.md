<div align="center">

<img src="assets/icon.png" width="96" alt="Paprika Lyrics Icon">

# Paprika Lyrics

### Studio-accurate, syllable-by-syllable lyrics for whatever your PC is playing.

A lightweight, frameless Windows overlay powered by native media sessions (GSMTC). No audio capture or analysis required — works seamlessly with Spotify, YouTube Music, VLC, Foobar2000, SimpMusic, and more.

[![CI](https://github.com/GZomeMain/paprika-lyrics/actions/workflows/ci.yml/badge.svg)](https://github.com/GZomeMain/paprika-lyrics/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%20%E2%80%93%203.13-blue.svg)](https://www.python.org/)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6.svg)](#requirements)

[**⬇️ Download Releases (ZIP / EXE)**](https://github.com/GZomeMain/paprika-lyrics/releases/latest) · [Releases](#-downloads--releases) · [Features](#-features) · [Quick Start](#-quick-start) · [Controls](#️-controls--shortcuts) · [Architecture](#-architecture--under-the-hood-click-to-expand)

<br>

https://github.com/user-attachments/assets/daa4370a-36d6-488a-907b-60a2d2e28301

</div>

---

## ✨ Features

- **🎤 Syllable-Perfect Lyrics** — Apple Music / community TTML via Spicy Lyrics API, with automatic line-synced fallback from [LRCLIB](https://lrclib.net/).
- **🎵 Universal Player Support** — Reads Windows System Media Transport Controls (GSMTC). Works with Spotify, YouTube / browser tabs, Foobar2000, VLC, SimpMusic, and Groove.
- **🖼️ Reactive Album Atmosphere** — Artwork dynamically lights the canvas with real-time blur grades, chromatic accents, and particle motes.
- **🥁 Beat-Driven Dynamics** — Rhythmic estimation from lyric timeline powers smooth breathing effects, bass blooms, and card leans.
- **🪟 Fluent Windows Overlay** — Frameless, always-on-top, click-through mode, draggable edges, mini-player mode, and global hotkeys.
- **🔤 Custom Fonts & Local TTML** — Import your favorite TTML files or fonts; customize typography per language.
- **⚡ Zero Bloat & GPU Accelerated** — Pure CSS transforms and GPU particles. Automatically suspends rendering when audio pauses or reduced motion is preferred.

<div align="center">
  <br>

https://github.com/user-attachments/assets/966caaf1-7d9f-40b9-8aa6-39bd481f4a17

  <br>
</div>

---

## 📦 Downloads & Releases

Prebuilt binaries for 64-bit Windows are published under [**Releases**](https://github.com/GZomeMain/paprika-lyrics/releases/latest). Choose the package format that best suits your setup:

| Package | Format | Details | Download |
| :--- | :--- | :--- | :--- |
| **`PaprikaLyrics-windows-x64.zip`** | **Portable Folder Archive**<br>*(Recommended)* | • Fastest startup speed with no temp unpacking<br>• Includes all dependencies in `_internal/`<br>• Keeps `.env`, custom `fonts/`, and `ttml/` organized right beside the app | [**Download ZIP**](https://github.com/GZomeMain/paprika-lyrics/releases/latest) |
| **`PaprikaLyrics.exe`** | **Single Executable** | • Single standalone executable with zero installation<br>• Fully self-contained—double-click and run<br>• Extracts to temp on launch *(slightly slower first start)* | [**Download EXE**](https://github.com/GZomeMain/paprika-lyrics/releases/latest) |

> **Note on Windows SmartScreen:** Because releases are open-source and unsigned, Windows Defender SmartScreen may display a warning on initial launch (*"Windows protected your PC"*). Click **More info → Run anyway** to proceed.

---

## 🚀 Quick Start

### Option A: Prebuilt Binary (Recommended)
1. Grab `PaprikaLyrics-windows-x64.zip` (or the standalone `PaprikaLyrics.exe`) from [**Releases**](https://github.com/GZomeMain/paprika-lyrics/releases/latest).
2. Unpack the zip into a folder of your choice (or place `PaprikaLyrics.exe` anywhere).
3. Run `PaprikaLyrics.exe` and start playing any music on your PC!

### Option B: Run from Source
```bash
# Clone the repository
git clone https://github.com/GZomeMain/paprika-lyrics.git
cd paprika-lyrics

# Install dependencies
pip install -r requirements.txt

# Run
python paprika_app.py
```

> **Requirements:** Windows 10 (1809+) or Windows 11 (64-bit). Microsoft Edge WebView2 runtime is preinstalled on Windows 11 and modern Windows 10. Python 3.10 – 3.13 is only needed if running from source.

---

## ⌨️ Controls & Shortcuts

| Action | Shortcut / Gesture | Description |
| :--- | :--- | :--- |
| **Nudge Sync** | <kbd>Ctrl</kbd> + <kbd>[</kbd> / <kbd>Ctrl</kbd> + <kbd>]</kbd> | Global offset adjustment (±50 ms), saved per track |
| **Lyric Zoom** | <kbd>Ctrl</kbd> + <kbd>Scroll</kbd> | Dynamically scale font size |
| **Move / Resize** | Click-drag top strip / edges | Move anywhere or resize smoothly |
| **Settings** | <kbd>Ctrl</kbd> + <kbd>,</kbd> | Open configuration sheet (or click gear icon) |
| **Translations** | <kbd>T</kbd> | Toggle romanization & lyrics translations |
| **Click-Through** | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>T</kbd> | Make window transparent to mouse clicks |
| **Restore Focus** | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd> | Take mouse focus back from click-through |
| **Mini Player** | <kbd>Esc</kbd> / UI Button | Toggle compact floating mini-player mode |

---

<details>
<summary><b>⚙️ Settings & Customization (Click to expand)</b></summary>

<br>

<div align="center">
  <img src="docs/assets/overlay-settings.png" width="800" alt="Paprika Lyrics Settings Sheet">
</div>

- **Window:** Adjust opacity, blur levels, always-on-top, click-through, and layout.
- **Lyrics:** Manage TTML provider, local folder overrides, secondary languages, and font selections.
- **Visuals:** Configure motion profiles (**Off / Subtle / Bold**) for beat synchronization, room motes, and cover tilt.
- **Diagnostics:** Inspect active GSMTC media session, Spotify ID resolver logs, and cache statuses.

</details>

---

<details>
<summary><b>🛠️ Architecture & Under the Hood (Click to expand)</b></summary>

<br>

Paprika pairs a lightweight Python host process with a WebView2 hardware-accelerated frontend:

```
Windows Media Session (GSMTC)
         │  core/session.py (Polls active OS audio sessions)
         ▼
core/smtc.py  ────── Transport, Timeline, Metadata ──────┐
                                                         │
Lyric Resolver  core/resolver.py                         │
   Spotify ID Match → Spicy Lyrics API → LRCLIB          │
         │                                               │
         ├── core/ttml.py · core/ttml_library.py         │  Syllable Timeline Engine
         └── core/lyrics.py                              │
         ▼                                               ▼
core/beat.py (BPM & Pulse)    core/timeline.py     storage.py (Local Cache)
         │                                               │
         ▼                                               ▼
    ui/app.js  ────────── WebView2 Bridge ──────────  ui/style.css
         ▲
paprika_app.py (pywebview host, Win32 window handles, global hotkeys)
```

### Building Binaries Locally
```bash
pip install pyinstaller
python -m PyInstaller PaprikaLyrics.spec --noconfirm                 # Folder build (dist/PaprikaLyrics/)
PL_ONEFILE=1 python -m PyInstaller PaprikaLyrics.spec --noconfirm    # Single exe (dist-onefile/PaprikaLyrics.exe)
```

> **Automated GitHub Releases:** Tagging a commit (e.g. `git tag v0.2.2 && git push origin v0.2.2`) triggers GitHub Actions to automatically run tests, build both the `.zip` and `.exe` artifacts, and publish them to Releases. Suffix tags like `v0.2.2-rc1` publish as pre-releases.

</details>

---

## ❓ Troubleshooting

| Issue | Resolution |
| :--- | :--- |
| **Lyrics show line-by-line only** | Syllable-level TTML isn't available for this track; Paprika automatically falls back to line-synced LRCLIB. |
| **Lyrics slightly out of sync** | Tap <kbd>Ctrl</kbd> + <kbd>[</kbd> or <kbd>Ctrl</kbd> + <kbd>]</kbd> to adjust by 50ms intervals. Saved permanently per track. |
| **Cannot click or drag window** | Overlay is in click-through mode. Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd> or <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>T</kbd>. |
| **Timeline shows `--:--`** | The active media player has not published track duration to Windows. It will resolve as soon as playback starts. |
| **Full configuration reset** | Close the app and delete the local `.webview/` directory. |

---

## 🤝 Credits

- **[Spicy Lyrics API](https://developers.spicylyrics.org)** — Syllable-synced TTML payloads.
- **[LRCLIB](https://lrclib.net/)** — Open-source community lyrics database.
- **[pywebview](https://pywebview.flowrl.com/)** — Windows WebView2 container.

---

## 📄 License

Distributed under the [MIT License](LICENSE).
