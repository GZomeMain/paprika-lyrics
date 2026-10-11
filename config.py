import os
import sys
import threading
import time
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


def _fallback_data_dir() -> Path:
    """
    Per-user write target for a build that cannot write beside its executable.

    `%LOCALAPPDATA%` (then `%APPDATA%`, then the home directory) is where Windows
    wants a program's own mutable state, and it is writable by whoever launched
    the app. The folder is app-specific so the cache, the `.env` and the WebView2
    profile cannot collide with another program's data.
    """
    root = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA")
    if root:
        return Path(root) / "PaprikaLyrics"
    return Path.home() / ".paprika-lyrics"


def _is_writable(directory: Path) -> bool:
    """
    Whether a file can ACTUALLY be created in `directory`.

    A write, not `os.access`: on Windows a folder's read-only attribute does not
    stop a program writing into it, and `os.access(W_OK)` reports that attribute
    rather than the ACL — so it answers "writable" for `C:\\Program Files` to a
    standard user. Creating and deleting a probe file is the only check that
    matches what the cache, the `.env` and the WebView2 profile are about to do.
    """
    probe = directory / f".write-probe-{os.getpid()}-{time.monotonic_ns()}"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with open(probe, "w", encoding="utf-8") as f:
            f.write("")
        return True
    except Exception:
        return False
    finally:
        try:
            probe.unlink()
        except Exception:
            pass


def _writable_data_dir(preferred: Path, probe=_is_writable) -> tuple[Path, bool]:
    """
    `(data_dir, fell_back)`: where this launch may write, and whether the folder
    the app would prefer had to be abandoned.

    A frozen onedir build writes its cache, `.env`, WebView2 profile and TTML
    library beside the executable. That is the right answer for the portable zip
    and the wrong one for `C:\\Program Files`, where a standard user cannot create
    a file: the cache flush, the settings save and the persistent profile would
    all fail, and the portable build's whole promise is that settings survive a
    relaunch. When the preferred folder is not writable the per-user directory
    takes over, so the app degrades to "settings live in AppData" instead of
    "settings are silently lost on exit".

    `probe` is injected so the fallback is testable without a read-only volume.
    """
    try:
        if probe(preferred):
            return preferred, False
    except Exception:
        pass
    fallback = _fallback_data_dir()
    try:
        if probe(fallback):
            return fallback, True
    except Exception:
        pass
    # Nothing is writable (or the fallback could not even be checked). Keep the
    # preferred folder: the storage layer reports its own write failures, and a
    # silent relocation to a folder the user did not choose would be worse than
    # an error they can act on.
    return preferred, False


_IS_FROZEN = bool(getattr(sys, "frozen", False))
RESOURCE_DIR, _PREFERRED_DATA_DIR = _resolve_dirs(
    _IS_FROZEN, getattr(sys, "_MEIPASS", None), BASE_DIR,
    getattr(sys, "executable", None),
)
# The folder this launch actually writes to, and whether it had to move. Every
# write target below derives from DATA_DIR, so this single decision covers the
# cache, the `.env`, the log and the WebView2 profile.
DATA_DIR, DATA_DIR_IS_FALLBACK = _writable_data_dir(_PREFERRED_DATA_DIR)


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
# the environment include the paths directly under this block (SPICY_TTML_DIR,
# SPICY_FONT_DIR, SPICY_WEBVIEW_DIR), so loading the file afterwards silently
# ignored them there while honouring them everywhere else.
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
# The local font library: the .ttf/.otf/.woff/.woff2 faces the user imported for
# the lyrics or the interface. Files on disk, not blobs in the WebView's settings
# store — that store is quotad per origin and a font is megabytes, so storing
# them there is what forced a hard 8-font cap and could lose a large import
# silently. Beside the cache like the TTML library (git-ignored) and movable with
# SPICY_FONT_DIR for a hand-curated collection.
FONT_DIR = Path(os.getenv("SPICY_FONT_DIR") or (DATA_DIR / "fonts"))
# The Edge WebView2 user-data folder, which is what makes the UI's settings
# (localStorage) survive a relaunch. pywebview's private_mode default is True,
# which hands WebView2 a throwaway temp profile, so every preference the user
# set was gone by the next launch. It lives beside the cache, the way the TTML
# library does, and is git-ignored: a WebView2 profile is tens of MB of cache,
# and deleting the folder is the honest "reset all my settings" button.
WEBVIEW_PROFILE_DIR = Path(os.getenv("SPICY_WEBVIEW_DIR") or (DATA_DIR / ".webview"))

# API Configuration
# NOTE: no default key is baked in. Supply one via in-app Settings, .env, or the env var.
SPICY_API_KEY = ""


def get_spicy_api_key() -> str:
    """
    Returns the current Spicy Lyrics API key.
    Reads from os.environ first, then the SPICY_API_KEY module variable,
    and falls back to persistent storage (CACHE.get_setting).
    """
    key = os.getenv("SPICY_API_KEY", "").strip()
    if key:
        return key
    global SPICY_API_KEY
    if SPICY_API_KEY:
        return SPICY_API_KEY
    try:
        from storage import CACHE
        cached = CACHE.get_setting("spicy_api_key")
        if cached and isinstance(cached, str):
            k = cached.strip()
            if k:
                os.environ["SPICY_API_KEY"] = k
                SPICY_API_KEY = k
                return k
    except Exception:
        pass
    return ""


def set_spicy_api_key(key: str) -> dict:
    """
    Sets and persists the Spicy Lyrics API key.
    Updates in-memory state, environment variable, the .env file in DATA_DIR,
    and the persistent settings cache in CACHE.
    """
    global SPICY_API_KEY
    clean_key = (key or "").strip()
    SPICY_API_KEY = clean_key
    if clean_key:
        os.environ["SPICY_API_KEY"] = clean_key
    else:
        os.environ.pop("SPICY_API_KEY", None)

    # Persist in storage cache
    try:
        from storage import CACHE
        CACHE.set_setting("spicy_api_key", clean_key if clean_key else None)
    except Exception as exc:
        debug_log("Failed to save API key to cache:", exc)

    # Persist in DATA_DIR / ".env"
    env_file = DATA_DIR / ".env"
    try:
        lines = []
        key_found = False
        if env_file.exists():
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    stripped = line.strip()
                    if stripped.startswith("SPICY_API_KEY=") or stripped.startswith("SPICY_API_KEY ="):
                        key_found = True
                        if clean_key:
                            lines.append(f'SPICY_API_KEY="{clean_key}"\n')
                        else:
                            lines.append('SPICY_API_KEY=\n')
                    else:
                        lines.append(line)
        if not key_found:
            if lines and not lines[-1].endswith("\n"):
                lines.append("\n")
            if clean_key:
                lines.append(f'SPICY_API_KEY="{clean_key}"\n')
            else:
                lines.append('SPICY_API_KEY=\n')
            if not any("SPICY_BASE_URL" in l for l in lines):
                lines.append('SPICY_BASE_URL="https://api.spicylyrics.org"\n')

        tmp_file = env_file.with_suffix(".tmp")
        with open(tmp_file, "w", encoding="utf-8") as f:
            f.writelines(lines)
        os.replace(tmp_file, env_file)
    except Exception as exc:
        debug_log("Failed to write API key to .env:", exc)

    masked = ""
    if clean_key:
        if len(clean_key) > 8:
            prefix = clean_key[:6] if clean_key.startswith("sl_sk_") else clean_key[:3]
            suffix = clean_key[-4:]
            masked = f"{prefix}••••••••{suffix}"
        else:
            masked = "••••••••"

    return {
        "ok": True,
        "key_set": bool(clean_key),
        "masked": masked,
    }


SPICY_API_KEY = get_spicy_api_key()
BASE_URL = os.getenv("SPICY_BASE_URL", "https://api.spicylyrics.org")

# The application version — the single source of truth for it. It is reported in
# the in-app resolve report (Settings → Resolve report), so a bug report can name
# the build it came from, and it is what a release tag should match. Bump it when
# a user-visible behaviour changes.
#
# Not to be confused with PARSER_VERSION below: that one versions the CACHED
# PAYLOAD FORMAT and exists to invalidate caches, not to describe the release.
APP_VERSION = "0.2.0"

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


# The on-disk log. A windowed build — `pythonw`, or a frozen `console=False`
# exe — has no stdout, so everything the app would have printed is gone. That is
# how a machine without the WebView2 runtime got a double-click that did nothing
# and no explanation. The fatal-startup path writes here, where a user can find
# it and a bug report can quote it.
LOG_FILE = DATA_DIR / "logs" / "paprika.log"
_LOG_LOCK = threading.Lock()


def log_to_file(message: str) -> bool:
    """
    Appends one timestamped, version-stamped line to LOG_FILE. Never raises.

    Returns whether the line was written. Callers treat a log that cannot be
    written as a fact to report rather than an error to raise: this is the last
    line of defence when the app is already failing to start.
    """
    try:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with _LOG_LOCK:
            LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(f"{stamp} [{APP_VERSION}] {message}\n")
        return True
    except Exception:
        return False


def debug_log(*args):
    """Prints only when SPICY_DEBUG is enabled, keeping normal runs quiet."""
    if DEBUG:
        print("[debug]", *args)


def warn_missing_api_key():
    """Human-readable warning when the Spicy API key is absent."""
    if not get_spicy_api_key():
        print(
            "[Config] SPICY_API_KEY is not set. Syllable-level lyrics from the Spicy "
            "Lyrics API will be unavailable and the app will fall back to LRCLIB.\n"
            "         Set it in Settings (Ctrl + ,) or in a .env file to enable it."
        )