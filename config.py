import os
from pathlib import Path

# Base Paths
BASE_DIR = Path(__file__).resolve().parent
CACHE_FILE = BASE_DIR / "spotify_cache.json"
UI_DIR = BASE_DIR / "ui"
INDEX_HTML_PATH = UI_DIR / "index.html"

# Environment Loader (.env fallback)
def _load_env():
    env_file = BASE_DIR / ".env"
    if env_file.exists():
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except Exception:
            pass

_load_env()

# API Configuration
# NOTE: no default key is baked in. Supply one via .env (see README) or the env var.
SPICY_API_KEY = os.getenv("SPICY_API_KEY", "").strip()
BASE_URL = os.getenv("SPICY_BASE_URL", "https://api.spicylyrics.org")

# Operational Constants
# Bumped to 10: LRCLIB fallback lines now carry musical word timing (BPM/
# density/stress model) and text-anchored reference alignment with offset
# re-anchoring. Old cached payloads only had line-level timing.
# Bumped to 11: repeated sections are matched to their OWN occurrence via
# track-wide offset consensus, so cached payloads that stacked duplicate
# chorus lines at one instant are no longer trustworthy.
PARSER_VERSION = 11
DEFAULT_LATENCY_MS = 600  # Unified single source of truth

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