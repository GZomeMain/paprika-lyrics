<div align="center">

# 🎵 Paprika Lyrics

### A beautiful, syllable-accurate lyrics overlay for Windows — for almost any player.

[![CI](https://github.com/GZomeMain/paprika-lyrics/actions/workflows/ci.yml/badge.svg)](https://github.com/GZomeMain/paprika-lyrics/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%20%E2%80%93%203.13-blue.svg)](https://www.python.org/)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#-requirements)

[**⬇️ Download**](https://github.com/GZomeMain/paprika-lyrics/releases/latest) · [**Features**](#-features) · [**How it works**](#-how-it-works) · [**Setup**](#-quick-start) · [**🔑 API key**](#-add-your-spicy-lyrics-api-key)

</div>

---

## 🎬 Preview

> **📌 Add your demo here.** Drop screenshots or GIFs into [`docs/assets/`](docs/assets) and use the commented template below. A YouTube demo embeds just as easily.

<!--
Uncomment and point at your own files once they exist:

<p align="center">
  <img src="docs/assets/overlay-fullscreen.png" width="820" alt="Fullscreen overlay">
</p>

<p align="center">
  <img src="docs/assets/syllable-wipe.gif" width="820" alt="Word-by-word wipe">
</p>

[![Watch the demo](https://img.youtube.com/vi/VIDEO_ID/maxresdefault.jpg)](https://youtu.be/VIDEO_ID)
-->

---

## 🎵 What it does

Paprika Lyrics is a lightweight, GPU-accelerated desktop overlay that turns any song into **Apple Music-style, word-by-word synced lyrics** — floating on top of your desktop or filling the screen.

It follows **whatever your PC is playing** by reading the track straight from Windows' own media controls (GSMTC). That means it works with almost anything — Spotify, YouTube / YouTube Music in a browser, SimpMusic, VLC, Foobar2000, Groove, and any other player that reports its now-playing track to Windows. Not just one app.

**No audio is ever captured.** Paprika listens to the *media session*, not the music.

---

## ✨ Features

- **🎤 Syllable-perfect lyrics** — studio-accurate, word-by-word wipes from Apple Music / community TTML via the [Spicy Lyrics API](https://developers.spicylyrics.org).
- **🌍 Works with almost any player** — driven by the Windows media session (GSMTC), so anything that publishes now-playing just works.
- **🖼️ Album-art room** — the live cover becomes a blurred, colour-matched backdrop that lights the whole overlay.
- **💃 Living motion** — words lift, breathe and bloom as they land; spring physics, depth of field and a motion-variant engine keep lines alive without looking cartoonish.
- **🥁 Beat-synced light** — a rhythm model estimated from the lyrics pulses the room and the sleeve on the actual beat, builds, drops and hooks included.
- **🧩 Local lyrics** — bring your own `.ttml` files for songs the online lookup gets wrong.
- **🪶 Graceful fallback** — no syllable data? It drops to line-synced lyrics from [LRCLIB](https://lrclib.net/) and keeps going.
- **🪟 Built for Windows** — frameless overlay, always-on-top, mini player, click-through mode, native anchored resizing, and global hotkeys.
- **⚡ Light on resources** — a small Python host driving Edge WebView2 (Chromium); every animation is transform/opacity only.

---

## 🧱 How it works

```text
Player (Spotify · browser · SimpMusic · VLC · …)
        │  now-playing metadata + cover art
        ▼
Windows Media Session (GSMTC)          core/smtc.py
        │
        ▼
Lyrics pipeline                        core/lyrics.py
   0. Local .ttml file (if bound)
   1. On-disk cache
   2. Spotify track-ID resolve (spotify-scraper → iTunes → Deezer)
   3. Syllable TTML  ←———— Spicy Lyrics API
   4. Line-synced fallback  ← LRCLIB
        │  JSON payload
        ▼
Edge WebView2 overlay                  ui/ (style.css · app.js)
   syllable wipes · spring physics · beat light · depth of field
```

### Built with

| Layer | Technology |
| --- | --- |
| Host runtime | Python 3.10 – 3.13 |
| Overlay window | [pywebview](https://pywebview.flowrl.com/) + Edge WebView2 (Chromium) |
| Media session | [winsdk](https://pypi.org/project/winsdk/) (Windows Runtime / GSMTC) |
| Networking | [`requests`](https://requests.readthedocs.io/) |
| Windowing | `ctypes` Win32 / DWM (frameless window, global hotkeys, DPI) |
| Lyrics sources | [Spicy Lyrics API](https://developers.spicylyrics.org) · [LRCLIB](https://lrclib.net/) · local TTML |

---

## 📋 Requirements

- **Windows 10** (1809+) or **Windows 11**, 64-bit
- **Python 3.10 – 3.13** — only needed to run from source

---

## 🚀 Quick start

```bash
# 1. Get the code
git clone https://github.com/GZomeMain/paprika-lyrics.git
cd paprika-lyrics

# 2. Install dependencies
pip install -r requirements.txt

# 3. Add your Spicy Lyrics API key (see the section below)
copy .env.example .env

# 4. Run it
python paprika_app.py
```

Play any track in your player and the overlay picks it up automatically.

> **Recommended:** `pip install spotify-scraper` improves Spotify track-ID matching. It is optional and guarded — everything still works without it.

---

## 🔑 Add your Spicy Lyrics API key

The key unlocks **syllable-level** (word-by-word) lyrics. Without it the app still runs and falls back to line-synced lyrics — so this step is optional, but it is the whole point. 💫

**1. Get a key (~30 seconds)**

1. Open **[developers.spicylyrics.org](https://developers.spicylyrics.org)**.
2. Go to the **Dashboard** and **Create an application**.
3. Copy the **secret key** — it looks like `sl_sk_…` and is shown **only once**.

**2. Put it in the app**

Create a file named `.env` next to `paprika_app.py` (copy the committed [`.env.example`](.env.example)) and set:

```env
SPICY_API_KEY="sl_sk_your_key_here"
SPICY_BASE_URL="https://api.spicylyrics.org"
```

- A real environment variable (`SPICY_API_KEY`) always outranks the `.env` file.
- `.env` is **git-ignored** — never commit your key.
- Running the packaged `.exe`? Put `.env` beside the executable.

**3. Verify it worked**

Open **Settings → Resolve report**. It shows `API key: Set` once the key is picked up.

Every optional setting (`SPICY_TTML_DIR`, `SPICY_WEBVIEW_DIR`, `SPICY_CACHE_TTL_SECONDS`, `SPICY_DEBUG`) is documented with its default in [`.env.example`](.env.example).

---

## 🎮 Controls

| Action | Shortcut / Gesture |
| --- | --- |
| Nudge lyrics later / earlier | `Ctrl + [` / `Ctrl + ]` (system-wide, ±50 ms) |
| Zoom lyric size | `Ctrl + Mouse wheel` |
| Move / resize window | Drag the top strip, or any edge/corner |
| Open settings | `Ctrl + ,` (or the gear on the cover art) |
| Toggle translations | `T` |
| Click-through (ignore the mouse) | `Ctrl + Shift + T` |
| Peek (hand the mouse back) | `Ctrl + Shift + M` |
| Close panel / leave mini player | `Esc` |
| Play · pause · seek | On-cover transport and seek bars |

Sync offsets are saved **per song**, so a track only ever needs nudging once.

---

## 🗂️ Local lyrics (`.ttml`)

For tracks the online lookup gets wrong, keep your own Apple / AMLL `.ttml` files:

- Drop files into the `ttml/` folder (or **Settings → Local lyrics → Import files…**), then press **Rescan**.
- A file is applied automatically only when its own metadata names the **same title _and_ artist**; a hand-bound file always wins.
- Point the library somewhere else with `SPICY_TTML_DIR` in `.env`.

---

## 📦 Build a standalone `.exe`

No Python required by whoever runs it.

```bash
pip install pyinstaller
python -m PyInstaller PaprikaLyrics.spec --noconfirm
```

The result is `dist/PaprikaLyrics/` — a **onedir** build, so ship the whole folder. It is unsigned, so Windows SmartScreen warns on first run (*More info → Run anyway*). Everything the app **writes** (`.env`, `.webview/`, `ttml/`, `spotify_cache.json`) lives **beside** the executable, never inside the bundle.

---

## ❓ Troubleshooting

| Symptom | Fix |
| --- | --- |
| Lyrics are line-synced, not word-by-word | The track has no syllable sync, or your API key is missing. Check **Settings → Resolve report**. |
| Lyrics are slightly ahead / behind | Nudge with `Ctrl + [` / `Ctrl + ]` (saved per song), or use the latency rail. |
| Song shows `--:--` and the seek bar does nothing | Your player doesn't publish a timeline to Windows (SimpMusic does this). That's the player, not the overlay. |
| I can't click the overlay | It's in click-through mode — press `Ctrl + Shift + T`. |
| I want to reset all settings | Delete the `.webview/` folder. |

---

## 🙏 Credits

- **[Spicy Lyrics API](https://developers.spicylyrics.org)** — syllable-synced TTML payloads.
- **[LRCLIB](https://lrclib.net/)** — open, community lyric database (line-sync fallback).
- **[pywebview](https://pywebview.flowrl.com/)** — the WebView2 window container.
- **[SimpMusic](https://github.com/brahmkshatriya/SimpMusic)** — a great open-source YouTube Music client, and one of the players this overlay is tested against.

## 📄 License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship it. No warranty.
