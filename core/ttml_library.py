"""
The local TTML library.

Owns one folder of `.ttml` files, an index of what is in it, and the per-track
bindings that say which file belongs to which song. The lyrics pipeline asks
this module one question — "is there a local file for this track?" — and the
settings UI asks it the rest (list, import, bind, remove).

Matching is deliberately conservative. A file the user explicitly bound always
wins; otherwise a file is applied automatically only when its own metadata names
the same song title AND artist. Anything weaker (a title-only guess from the
filename, or two files that both claim the song) is offered in the UI as a
suggestion instead of being applied silently, because the failure mode of a
wrong match is worse than the failure mode of no match.
"""

import os
import re
import shutil
import threading
import time
import unicodedata
from collections import OrderedDict
from pathlib import Path

from config import DATA_DIR, TTML_DIR, debug_log
from core.metadata import extract_clean_metadata, track_cache_key
from core.parser import count_syllables
from core.ttml import parse_ttml
from storage import CACHE

TTML_SUFFIXES = (".ttml", ".xml")
TRASH_DIR_NAME = ".trash"
# A binding map entry's "file" when the user asked for online lyrics for a song:
# the marker has to survive a restart, or the auto-match would quietly come back.
DISABLED = ""

_NORM_RE = re.compile(r"[^\w]+", re.UNICODE)
_PAREN_NOISE_RE = re.compile(
    r"[\(\[]\s*(?:official\s*(?:music\s*)?video|official\s*audio|lyrics?|"
    r"ttml|apple\s*music|remaster(?:ed)?(?:\s*\d{4})?|explicit|clean)\s*[\)\]]",
    re.IGNORECASE,
)


def _norm(text: str) -> str:
    """Case-, accent- and punctuation-insensitive form for matching.

    'Beyoncé' and 'beyonce' are the same song, and so are 'Don't' and 'Dont';
    normalizing that away is what lets a file's own metadata match the player's
    broadcast without the user binding anything.
    """
    if not text:
        return ""
    decomposed = unicodedata.normalize("NFKD", str(text))
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    stripped = stripped.replace("&", " and ")
    return " ".join(_NORM_RE.sub(" ", stripped.casefold()).split())


def filename_title(stem: str) -> str:
    """Best-effort song title from a filename stem ('Song [TTML]' -> 'Song')."""
    text = _PAREN_NOISE_RE.sub(" ", stem or "")
    text = re.sub(r"[_]+", " ", text)
    text = re.sub(r"\s*[-–—]\s*$", "", text)
    return " ".join(text.split()).strip(" -_.")


def binding_keys(title: str, artist: str, album: str | None = None,
                 duration_ms: float | None = None) -> list[str]:
    """
    The identity ladder a binding is looked up through, most specific first.

    A user binds a song while it is playing, so the key carries whatever the
    player happened to report that day — album tag present, duration off by a
    second, or nothing at all for a stream. Walking from the full key down to
    title+artist means a binding still applies when one of those moving parts
    changes.
    """
    c_title, primary_artist, _full = extract_clean_metadata(title or "", artist or "")
    if not c_title:
        # Untitled audio (a bare stream, a file with no tags) cannot be told
        # apart from any other, so it gets no binding identity at all rather
        # than a shared placeholder one.
        return []
    keys = []
    for album_value in (album, None):
        for duration in (duration_ms, None):
            key = track_cache_key(c_title, primary_artist, duration, album_value)
            if key and key not in keys:
                keys.append(key)
    return keys


class TtmlLibrary:
    """One folder of local TTML files, with an index and per-track bindings."""

    MAX_MEMO_ENTRIES = 8

    def __init__(self, directory: Path | str | None = None, cache=None):
        self.directory = Path(directory) if directory else Path(TTML_DIR)
        self.cache = cache if cache is not None else CACHE
        self._lock = threading.RLock()
        # Parsed payloads, keyed by relative path and validated by (mtime, size)
        # — a re-load of the same track (a binding change, a seek back into the
        # song) must not re-read and re-parse the file every time.
        self._memo: OrderedDict[str, tuple[float, int, list[dict]]] = OrderedDict()

    # ------------------------------------------------------------------ folder
    def ensure_dir(self) -> Path:
        """Creates the library folder on first use. Never raises."""
        try:
            if not self.directory.exists():
                self.directory.mkdir(parents=True, exist_ok=True)
            # The default folder lives beside the app (inside the project
            # checkout when run from source), so a user's own lyrics must never
            # turn up in `git status`.
            if DATA_DIR in self.directory.resolve().parents:
                marker = self.directory / ".gitignore"
                if not marker.exists():
                    marker.write_text("*\n!.gitignore\n", encoding="utf-8")
        except Exception as exc:
            debug_log("TTML library folder could not be created:", exc)
        return self.directory

    def _rel(self, path: Path) -> str:
        try:
            return path.relative_to(self.directory).as_posix()
        except ValueError:
            return path.name

    def _files(self) -> list[Path]:
        if not self.directory.exists():
            return []
        out = []
        for root, dirs, names in os.walk(self.directory):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in names:
                if name.startswith(".") or Path(name).suffix.lower() not in TTML_SUFFIXES:
                    continue
                out.append(Path(root) / name)
        out.sort(key=lambda p: p.name.casefold())
        return out

    # ------------------------------------------------------------------- index
    def _parse_file(self, path: Path) -> tuple[list[dict], dict]:
        try:
            # utf-8-sig: the dialect forbids a BOM, and WebView/editor output
            # sometimes carries one anyway; stripping it is free.
            text = path.read_text(encoding="utf-8-sig", errors="replace")
        except Exception as exc:
            return [], {"error": f"could not read file ({exc})", "title": "",
                        "artist": "", "album": "", "duration_ms": None,
                        "lang": "", "timing": "", "timing_declared": "",
                        "spotify_id": "", "apple_music_id": "", "agents": []}
        return parse_ttml(text, filename_hint=path.stem)

    def _describe(self, path: Path, rel: str, stat) -> dict:
        lines, meta = self._parse_file(path)
        title = (meta.get("title") or "").strip()
        title_source = "metadata" if title else ""
        if not title:
            title = filename_title(path.stem)
            title_source = "filename" if title else "none"
        entry = {
            "file": rel,
            "name": path.name,
            "size": int(stat.st_size),
            "mtime": float(stat.st_mtime),
            "title": title,
            "artist": (meta.get("artist") or "").strip(),
            "album": (meta.get("album") or "").strip(),
            "duration_ms": meta.get("duration_ms"),
            "timing": meta.get("timing") or "",
            "lang": meta.get("lang") or "",
            "spotify_id": meta.get("spotify_id") or "",
            "apple_music_id": meta.get("apple_music_id") or "",
            "title_source": title_source,
            "line_count": len(lines),
            "syllables": count_syllables(lines),
            "error": meta.get("error") or "",
        }
        return entry

    def scan(self, force: bool = False) -> dict:
        """
        Reconciles the index with the folder.

        Cheap by construction: a file whose size and mtime are unchanged is not
        re-parsed, so this can run on every track load without touching the
        disk more than a stat per file.
        """
        with self._lock:
            # NOTE: no ensure_dir() here. Scanning runs on every track load, and
            # creating a folder the user has not asked for yet (an empty library
            # appearing because they played a song) is a side effect the read
            # path has no business having. Mutations create it.
            index = dict(self.cache.get_ttml_files())
            seen = set()
            changed = False
            for path in self._files():
                rel = self._rel(path)
                seen.add(rel)
                try:
                    stat = path.stat()
                except OSError:
                    continue
                entry = index.get(rel)
                unchanged = (
                    isinstance(entry, dict)
                    and entry.get("size") == stat.st_size
                    and abs(float(entry.get("mtime") or 0) - stat.st_mtime) < 1e-6
                    and not force
                )
                if unchanged:
                    continue
                index[rel] = self._describe(path, rel, stat)
                self._memo.pop(rel, None)
                changed = True

            for rel in [r for r in index if r not in seen]:
                del index[rel]
                self._memo.pop(rel, None)
                changed = True

            # Always: a file can vanish without the index changing shape (it was
            # already removed by a mutation), and a binding to a file that no
            # longer exists must never survive a scan. Cheap — it walks a map of
            # the user's own choices and writes only when something is stale.
            self.cache.prune_ttml_bindings(seen)
            if changed:
                self.cache.set_ttml_files(index)
            return index

    def entries(self) -> list[dict]:
        index = self.scan()
        return sorted(index.values(), key=lambda e: (e.get("name") or "").casefold())

    def _payload(self, rel: str) -> list[dict]:
        """Parsed lines for one library file, memoized by (mtime, size)."""
        path = self.directory / rel
        try:
            stat = path.stat()
        except OSError:
            return []
        memo = self._memo.get(rel)
        if memo and memo[0] == stat.st_mtime and memo[1] == stat.st_size:
            self._memo.move_to_end(rel)
            return memo[2]
        lines, _meta = self._parse_file(path)
        self._memo[rel] = (stat.st_mtime, stat.st_size, lines)
        while len(self._memo) > self.MAX_MEMO_ENTRIES:
            self._memo.popitem(last=False)
        return lines

    # ------------------------------------------------------------------ tracks
    def key_for(self, title: str, artist: str, album: str | None = None,
                duration_ms: float | None = None) -> str:
        keys = binding_keys(title, artist, album, duration_ms)
        return keys[0] if keys else ""

    def lookup(self, title: str, artist: str, album: str | None = None,
               duration_ms: float | None = None, index: dict | None = None) -> dict | None:
        """
        The local file for a track, if any.

        Returns {"kind", "file", "name", "lines", "entry", "key"} where kind is
        "bound" (user chose it), "match" (metadata matched it) or "off" (the user
        asked for online lyrics for this song, which also suppresses matching).
        """
        with self._lock:
            index = self.scan() if index is None else index
            keys = binding_keys(title, artist, album, duration_ms)
            if not keys:
                return None
            bindings = self.cache.ttml_bindings()

            for key in keys:
                binding = bindings.get(key)
                if binding is None:
                    continue
                if not isinstance(binding, dict):
                    binding = {"file": str(binding), "enabled": True}
                if not binding.get("enabled", True):
                    return {"kind": "off", "file": "", "name": "", "lines": [],
                            "entry": None, "key": key}
                rel = binding.get("file") or ""
                entry = index.get(rel)
                if entry and not entry.get("error"):
                    lines = self._payload(rel)
                    if lines:
                        return {"kind": "bound", "file": rel, "name": entry.get("name", rel),
                                "lines": lines, "entry": entry, "key": key}
                # A binding whose file vanished or stopped parsing falls through:
                # the auto-match (or the online pipeline) still gets a turn.

            match = self._auto_match(index, title, artist, album, duration_ms)
            if match:
                return match
            return None

    def _auto_match(self, index: dict, title: str, artist: str, album: str | None,
                    duration_ms: float | None) -> dict | None:
        """
        Applies a file by metadata — but only when the evidence is unambiguous.

        Title AND artist must match textually, and when several files claim the
        same song the album and then the duration break the tie. Two plausible
        files with nothing to choose between them means no automatic answer:
        the UI offers them instead of picking one.
        """
        if not title or not artist:
            return None
        want_title = _norm(title)
        want_artist = _norm(artist)
        want_album = _norm(album or "")
        if not want_title or not want_artist:
            return None

        candidates = []
        for entry in index.values():
            if entry.get("error") or entry.get("title_source") != "metadata":
                continue
            if _norm(entry.get("title")) != want_title:
                continue
            if not _artist_matches(entry.get("artist"), artist):
                continue
            candidates.append(entry)

        if not candidates:
            return None
        if len(candidates) > 1:
            if want_album:
                album_hits = [e for e in candidates if _norm(e.get("album")) == want_album]
                if album_hits:
                    candidates = album_hits
            if len(candidates) > 1 and duration_ms:
                close = [e for e in candidates
                         if e.get("duration_ms")
                         and abs(float(e["duration_ms"]) - float(duration_ms)) <= 7000.0]
                if close:
                    candidates = close
        if len(candidates) != 1:
            return None

        entry = candidates[0]
        lines = self._payload(entry["file"])
        if not lines:
            return None
        return {"kind": "match", "file": entry["file"], "name": entry.get("name", ""),
                "lines": lines, "entry": entry, "key": ""}

    def resolve(self, title: str, artist: str, album: str | None = None,
                duration_ms: float | None = None) -> dict | None:
        """The local override for a track, or None to let the network pipeline run."""
        local = self.lookup(title, artist, album, duration_ms)
        if not local or local.get("kind") == "off" or not local.get("lines"):
            return None
        return local

    def suggestions(self, title: str, artist: str, index: dict | None = None) -> list[dict]:
        """
        Files that *might* be this song, weakest evidence included.

        Used by the settings panel to put the right file one click away for the
        tracks the auto-match is deliberately too strict to claim (a file whose
        metadata is missing, or named after the song without artist tags).
        """
        with self._lock:
            index = self.scan() if index is None else index
            want_title = _norm(title)
            if not want_title:
                return []
            out = []
            for entry in index.values():
                if entry.get("error"):
                    continue
                if _norm(entry.get("title")) != want_title:
                    continue
                if entry.get("title_source") == "metadata" and artist \
                        and not _artist_matches(entry.get("artist"), artist):
                    continue
                out.append(entry)
            return sorted(out, key=lambda e: e.get("name", "").casefold())

    # -------------------------------------------------------------- mutations
    def add_files(self, paths) -> dict:
        """
        Copies chosen files into the library. Non-destructive by design: a name
        clash never overwrites, and a file already inside the library is left
        alone rather than copied onto itself.
        """
        report = {"added": [], "skipped": [], "failed": []}
        with self._lock:
            self.ensure_dir()
            for raw in (paths or []):
                source = Path(str(raw))
                if not source.is_file():
                    report["failed"].append({"name": source.name or str(raw),
                                             "reason": "not a file"})
                    continue
                if source.suffix.lower() not in TTML_SUFFIXES:
                    report["failed"].append({"name": source.name,
                                             "reason": "not a .ttml file"})
                    continue
                try:
                    if source.resolve().parent == self.directory.resolve():
                        report["skipped"].append(source.name)
                        continue
                except OSError:
                    pass
                try:
                    target = self._unique_target(source.name)
                    shutil.copy2(source, target)
                except Exception as exc:
                    report["failed"].append({"name": source.name, "reason": str(exc)})
                    continue
                lines, meta = self._parse_file(target)
                if meta.get("error"):
                    # Kept, not deleted: the user can fix the file in place and
                    # the panel shows them exactly what is wrong with it.
                    report["failed"].append({"name": target.name,
                                             "reason": meta["error"]})
                else:
                    report["added"].append({"name": target.name, "lines": len(lines)})
            self.scan(force=True)
        return report

    def _unique_target(self, name: str) -> Path:
        candidate = self.directory / name
        if not candidate.exists():
            return candidate
        stem, suffix = candidate.stem, candidate.suffix
        for i in range(2, 1000):
            candidate = self.directory / f"{stem} ({i}){suffix}"
            if not candidate.exists():
                return candidate
        return self.directory / f"{stem}-{int(time.time())}{suffix}"

    def remove_file(self, rel: str) -> dict:
        """
        Removes a file from the library.

        The file is moved into `<library>/.trash` rather than deleted: removing
        it is a management action, not a statement that the user wants the
        lyrics gone from their disk for good.
        """
        with self._lock:
            index = self.scan()
            rel = str(rel or "")
            if rel not in index:
                return {"ok": False, "reason": "not in the library", "name": rel}
            path = self.directory / rel
            name = index[rel].get("name", rel)
            try:
                trash = self.directory / TRASH_DIR_NAME
                trash.mkdir(parents=True, exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                path.replace(trash / f"{stamp}-{path.name}")
            except Exception as exc:
                return {"ok": False, "reason": f"could not remove ({exc})", "name": name}
            self.cache.drop_ttml_file(rel)
            self._memo.pop(rel, None)
            self.scan(force=True)
            return {"ok": True, "name": name}

    def set_binding(self, rel: str, title: str, artist: str, album: str | None = None,
                    duration_ms: float | None = None, enabled: bool = True) -> dict:
        """
        Binds a file to a track.

        Written against the LEAST specific identity (title + artist) on purpose:
        a player reports the album and duration only sometimes, and a binding
        that evaporates because the album tag was missing on the next launch
        would look like the feature stopped working. The lookup still walks the
        specific keys first, so an older, more specific entry keeps precedence.
        """
        with self._lock:
            index = self.scan()
            if rel and (rel not in index):
                return {"ok": False, "reason": "unknown file"}
            keys = binding_keys(title, artist, album, duration_ms)
            if not keys or not keys[-1]:
                return {"ok": False, "reason": "no track"}
            key = keys[-1]
            self.cache.set_ttml_binding(key, rel or DISABLED, enabled)
            return {"ok": True, "key": key, "file": rel or DISABLED}

    def set_enabled(self, title: str, artist: str, album: str | None = None,
                    duration_ms: float | None = None, enabled: bool = True) -> dict:
        """
        Turns local lyrics for a track on or off without forgetting the file.

        Walks the identity ladder so the flag lands on whichever key the track's
        binding actually lives under; with nothing bound, the flag is written on
        the most specific key, which is also the one the lookup reads first.
        """
        with self._lock:
            keys = binding_keys(title, artist, album, duration_ms)
            if not keys or not keys[-1]:
                return {"ok": False, "reason": "no track"}
            bindings = self.cache.ttml_bindings()
            for key in keys:
                binding = bindings.get(key)
                if binding is None:
                    continue
                if not isinstance(binding, dict):
                    binding = {"file": str(binding), "enabled": True}
                file = binding.get("file") or DISABLED
                if enabled and not file:
                    # Nothing was ever bound here: the marker has done its job,
                    # and keeping a fileless entry would just be litter that
                    # shadows the auto-match forever.
                    self.cache.drop_ttml_binding(key)
                else:
                    self.cache.set_ttml_binding(key, file, enabled)
                return {"ok": True, "key": key, "enabled": bool(enabled)}
            if enabled:
                return {"ok": True, "key": keys[-1], "enabled": True}
            # Disabling with nothing bound still has to be remembered, or the
            # auto-match would take the song back on the next refresh.
            self.cache.set_ttml_binding(keys[-1], DISABLED, False)
            return {"ok": True, "key": keys[-1], "enabled": False}

    # ---------------------------------------------------------------- snapshot
    def snapshot(self, title: str = "", artist: str = "", album: str | None = None,
                 duration_ms: float | None = None) -> dict:
        """
        Everything the settings panel needs, in one round trip.

        Per-track state is computed here (not in JS) so the UI never re-derives
        the matching rules and cannot drift from the pipeline.
        """
        with self._lock:
            index = self.scan()
            entries = sorted(index.values(), key=lambda e: (e.get("name") or "").casefold())
            current = None
            if title:
                local = self.lookup(title, artist, album, duration_ms, index=index)
                candidates = []
                if not local:
                    candidates = self.suggestions(title, artist, index=index)
                current = {
                    "title": title,
                    "artist": artist,
                    "kind": (local or {}).get("kind") or "",
                    "file": (local or {}).get("file") or "",
                    "name": (local or {}).get("name") or "",
                    "candidates": [e.get("file") for e in candidates],
                }
            active_file = (current or {}).get("file") or ""
            for entry in entries:
                if entry.get("file") == active_file:
                    entry["state"] = current.get("kind") or ""
                elif entry.get("title_source") == "metadata" and title \
                        and _norm(entry.get("title")) == _norm(title) \
                        and _artist_matches(entry.get("artist"), artist):
                    entry["state"] = "candidate"
                else:
                    entry["state"] = ""
            return {
                "dir": str(self.directory),
                "count": len(entries),
                "entries": entries,
                "current": current,
                "trash": self._trash_count(),
            }

    def _trash_count(self) -> int:
        trash = self.directory / TRASH_DIR_NAME
        try:
            return sum(1 for p in trash.iterdir() if p.is_file())
        except OSError:
            return 0

    def reveal(self, rel: str = "") -> bool:
        """Opens the library (or selects one file in it) in the file manager."""
        try:
            self.ensure_dir()
            if rel:
                target = self.directory / rel
                if target.exists():
                    os.startfile(str(target))          # noqa: S606 - Windows shell
                    return True
            os.startfile(str(self.directory))          # noqa: S606 - Windows shell
            return True
        except Exception as exc:
            debug_log("Could not open the TTML library folder:", exc)
            return False


def _artist_parts(text: str) -> set[str]:
    """Individual credits inside a multi-artist string, normalized."""
    parts = re.split(r"[,/&]|\band\b|\sfeat\.?\s|\sft\.?\s", text or "",
                     flags=re.IGNORECASE)
    return {_norm(p) for p in parts if _norm(p)}


def _artist_matches(entry_artist: str, want_artist: str) -> bool:
    """
    True when a file's credited performer matches the artist the player reported.

    Compared as individual credits as well as whole strings, so a file crediting
    'Simon & Garfunkel' still matches a player reporting just 'Simon and
    Garfunkel' (or a primary artist on its own), while 'Artist A' never matches
    an unrelated 'Artist B' that merely appears in a feature credit.
    """
    if not entry_artist or not want_artist:
        return False
    if _norm(entry_artist) == _norm(want_artist):
        return True
    return bool(_artist_parts(entry_artist) & _artist_parts(want_artist))


TTML_LIBRARY = TtmlLibrary()
