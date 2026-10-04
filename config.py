import os
import sys
from pathlib import Path

# Base Paths
BASE_DIR = Path(__file__).resolve().parent


def _resolve_dirs(frozen: bool, meipass, module_dir: Path,
                  executable: str | None = None) -> tuple[Path, Path]:
    """
    `(resource_dir, data_dir)` for this launch.

    Two folders, because a frozen build has two: PyInstaller unpacks the bundled
    files into a temporary directory that is deleted when the app exits, so
    anything read-only and bundled (the UI) belongs there, while anything the
    app WRITES — the `.env`, the cache, the WebView2 profile, the local TTML
    library — has to live beside the executable or it would be lost on every
    launch — a profile that re-creates itself each run is exactly the bug the
    persistent WebView2 folder exists to fix, and a cache in `%TEMP%` is not a
    cache.

    Running from source both point at the project folder, so nothing about the
    development layout changes.
    """
    if frozen and meipass:
        exe_dir = Path(executable).resolve().parent if executable else module_dir
        return Path(meipass), exe_dir
    return module_dir, module_dir


_IS_FROZEN = bool(getattr(sys, "frozen", False))
RESOURCE_DIR, DATA_DIR = _resolve_dirs(
    _IS_FROZEN, getattr(sys, "_MEIPASS", None), BASE_DIR,
    getattr(sys, "executable", None),
)


def _unquote(value: str) -> str:
    """
    Removes ONE pair of matching wrapping quotes, and only one pair.

    ``strip('"').strip("'")`` removed every leading and trailing quote character
    of either kind, which mangled any value that legitimately contained one: a
    path like ``'C:/Users/O'Brien/lyrics'`` lost its apostrophe (and a value such
    as ``"it's"`` lost both). The quote that matters is the one pair the writer
    used to wrap the value, so that pair — and only that pair — is dropped.
    """
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


# Environment Loader (.env fallback)
#
# Called BEFORE any setting below reads os.environ: the settings that come from
# the environment include the two paths directly under this block, so loading
# the file afterwards silently ignored SPICY_TTML_DIR / SPICY_WEBVIEW_DIR there
# while honouring them everywhere else.
def _load_env():
    env_file = DATA_DIR / ".env"
    if not env_file.exists():
        return
    try:
        with open(env_file, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    # setdefault, not assignment: a real environment variable
                    # (exported in the shell, or set by the launcher) outranks
                    # the file.
                    os.environ.setdefault(k.strip(), _unquote(v.strip()))
    except Exception:
        pass


_load_env()

# The cache holds the user's listening history, so it is data, not a bundled
# resource. `.gitignore` names the file, not the folder, so the default beside
# the app is still the one the README documents.
CACHE_FILE = DATA_DIR / "spotify_cache.json"
UI_DIR = RESOURCE_DIR / "ui"
INDEX_HTML_PATH = UI_DIR / "index.html"
# The local TTML library: Apple-Music-style .ttml lyric files the user adds for
# songs the online lookup gets wrong. Kept beside the cache by default (the
# folder is git-ignored) and movable with SPICY_TTML_DIR for a shared or
# hand-curated collection.
TTML_DIR = Path(os.getenv("SPICY_TTML_DIR") or (DATA_DIR / "ttml"))
# The Edge WebView2 user-data folder, which is what makes the UI's settings
# (localStorage) survive a relaunch. pywebview's private_mode default is True,
# which hands WebView2 a throwaway temp profile, so every preference the user
# set was gone by the next launch. It lives beside the cache, the way the TTML
# library does, and is git-ignored: a WebView2 profile is tens of MB of cache,
# and deleting the folder is the honest "reset all my settings" button.
WEBVIEW_PROFILE_DIR = Path(os.getenv("SPICY_WEBVIEW_DIR") or (DATA_DIR / ".webview"))

# API Configuration
# NOTE: no default key is baked in. Supply one via .env (see README) or the env var.
SPICY_API_KEY = os.getenv("SPICY_API_KEY", "").strip()
BASE_URL = os.getenv("SPICY_BASE_URL", "https://api.spicylyrics.org")

# The application version — the single source of truth for it. It is reported in
# the in-app resolve report (Settings → Resolve report), so a bug report can name
# the build it came from, and it is what a release tag should match. Bump it when
# a user-visible behaviour changes.
#
# Not to be confused with PARSER_VERSION below: that one versions the CACHED
# PAYLOAD FORMAT and exists to invalidate caches, not to describe the release.
APP_VERSION = "0.1.0"

# Operational Constants
# Bumped to 10: LRCLIB fallback lines now carry musical word timing (BPM/
# density/stress model) and text-anchored reference alignment with offset
# re-anchoring. Old cached payloads only had line-level timing.
# Bumped to 11: repeated sections are matched to their OWN occurrence via
# track-wide offset consensus, so cached payloads that stacked duplicate
# chorus lines at one instant are no longer trustworthy.
PARSER_VERSION = 11
# Unified single source of truth for the per-track sync offset. A track whose
# lyrics came from the on-disk cache opens at DEFAULT_LATENCY_MS; a fresh fetch
# (a cache miss, so the pipeline is doing network work the cached path never
# does) opens at UNCACHED_LATENCY_MS instead. Both are only the starting value —
# the user's own nudge is stored per track and always wins.
DEFAULT_LATENCY_MS = 800
UNCACHED_LATENCY_MS = 1500


def default_latency_for(cache_state: str | None) -> int:
    """
    Starting sync offset for a track, from how its lyrics were obtained.

    Only a network cache miss opens at the wide default: those are the fetches
    whose timing the user tends to nudge. A cached payload and a local TTML file
    both land instantly and open at the tuned baseline.
    """
    return DEFAULT_LATENCY_MS if cache_state in ("hit", "local") else UNCACHED_LATENCY_MS


# Lyric cache freshness. README promises ~3 days; this is now actually enforced.
CACHE_TTL_SECONDS = int(os.getenv("SPICY_CACHE_TTL_SECONDS", str(3 * 24 * 60 * 60)))


def _as_bool(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


# Verbose resolver/lyrics diagnostics toggle.
DEBUG = _as_bool(os.getenv("SPICY_DEBUG"))

DEFAULT_WIDTH = 430
DEFAULT_HEIGHT = 680


def debug_log(*args):
    """Prints only when SPICY_DEBUG is enabled, keeping normal runs quiet."""
    if DEBUG:
        print("[debug]", *args)


def warn_missing_api_key():
    """Human-readable warning when the Spicy API key is absent."""
    if not SPICY_API_KEY:
        print(
            "[Config] SPICY_API_KEY is not set. Syllable-level lyrics from the Spicy "
            "Lyrics API will be unavailable and the app will fall back to LRCLIB.\n"
            "         Create a .env file with SPICY_API_KEY=\"your_key\" to enable it."
        )