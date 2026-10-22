"""
The local font library.

Owns one folder of font files (`.ttf` / `.otf` / `.woff` / `.woff2`), the CSS
family name each one is registered under, and the bytes the overlay loads when a
face is applied or previewed. The settings sheet asks this module for the list;
the overlay asks it for one file's bytes.

Fonts live here as FILES rather than as base64 blobs inside the WebView's
settings store, which is where the first version kept them. That store is quotad
per origin and a font is megabytes — base64 inflates it by a third — so the
import had to be capped at eight files to stay under the limit, a large file
could fail to save silently, and what the cap was protecting against was a font
that was simply gone by the next launch. A folder has no cap to enforce, the
`.trash` folder keeps a removal reversible, and "what fonts do I have?" is answered by
the disk instead of by a browser store.
"""

import base64
import hashlib
import os
import re
import shutil
import struct
import threading
import time
from collections import OrderedDict
from pathlib import Path

from config import DATA_DIR, FONT_DIR, debug_log

FONT_SUFFIXES = (".ttf", ".otf", ".woff", ".woff2")
MIME_TYPES = {
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}
TRASH_DIR_NAME = ".trash"
# The CSS family every library font is registered under. The prefix is
# load-bearing: the older, store-based importer wrote ids of the same shape
# ('custom-honk') into the user's saved settings, and a name derived the same way
# is what keeps their chosen face after the move to files.
FAMILY_PREFIX = "custom-"
# A font that reports no weight of its own is registered at 400: the outlines
# are then drawn as designed rather than synthesized bold, which is what a
# hard-coded 700 did to every import.
DEFAULT_WEIGHT = 400
# Signatures a real font file starts with: TrueType, CFF/OpenType, the Apple
# 'true' flavour, a TrueType collection, and WOFF / WOFF2.
FONT_SIGNATURES = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf", b"wOFF", b"wOF2")

_ILLEGAL_FILENAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_SLUG_RE = re.compile(r"[^a-z0-9]+")
# Style words a font file carries instead of a family name, so a label taken
# from the file name does not read "Honk Regular VariableFont MORF,SHLN".
_NOISE_WORDS = {
    "regular", "italic", "oblique", "bold", "light", "medium", "semibold",
    "extrabold", "ultrabold", "black", "thin", "hairline", "book", "roman",
    "variablefont", "variable", "vf", "wght", "opsz", "slnt", "wdth", "static",
}


def slug(text: str) -> str:
    """
    A CSS-identifier-safe form of a name.

    Deliberately ASCII-only and lower-cased the same way the overlay's older
    importer lower-cased it (`toLowerCase`), so a family id derived here is
    byte-identical to the one that importer stored for the same file name.
    """
    cleaned = _SLUG_RE.sub("-", str(text or "").lower()).strip("-")
    return cleaned or "font"


def label_from_filename(stem: str) -> str:
    """
    A readable face name for a file whose own name table could not be read.

    Only a fallback: the name table is what turns
    `Honk-Regular-VariableFont_MORF,SHLN.ttf` into `Honk`. This drops the style
    words a file name usually ends with so the row still reads like a typeface
    rather than like a download.
    """
    text = _ILLEGAL_FILENAME_RE.sub(" ", str(stem or ""))
    # Commas separate the axis tags in the names most downloads carry
    # ('..._MORF,SHLN'), so they read as separators here too.
    text = re.sub(r"[_\-,;]+", " ", text)
    text = re.sub(r"[\(\[].*?[\)\]]", " ", text)
    words = [w for w in text.split() if w]
    while len(words) > 1 and words[-1].casefold().strip(",") in _NOISE_WORDS:
        words.pop()
    if not words:
        return str(stem or "Font").strip() or "Font"
    return " ".join(words)[:48].strip(" ,-") or "Font"


def _sfnt_tables(data: bytes, offset: int = 0) -> dict[bytes, tuple[int, int]]:
    """`tag -> (offset, length)` from an sfnt table directory."""
    if len(data) < offset + 12:
        return {}
    count = struct.unpack_from(">H", data, offset + 4)[0]
    tables: dict[bytes, tuple[int, int]] = {}
    for i in range(count):
        record = offset + 12 + i * 16
        if len(data) < record + 16:
            break
        tag, _checksum, table_offset, length = struct.unpack_from(">4sIII", data, record)
        tables[tag] = (table_offset, length)
    return tables


def _woff_tables(data: bytes) -> dict[bytes, tuple[int, int, int]]:
    """`tag -> (offset, compressed length, real length)` from a WOFF directory."""
    if len(data) < 44 or data[:4] != b"wOFF":
        return {}
    count = struct.unpack_from(">H", data, 12)[0]
    tables: dict[bytes, tuple[int, int, int]] = {}
    for i in range(count):
        record = 44 + i * 20
        if len(data) < record + 20:
            break
        tag, offset, comp_length, orig_length, _checksum = struct.unpack_from(
            ">4sIIII", data, record)
        tables[tag] = (offset, comp_length, orig_length)
    return tables


def _name_strings(name_table: bytes) -> dict[int, str]:
    """
    The name records a font wants to be called by, keyed by name ID.

    Only the handful of IDs that matter here are kept: 1/16 (family) and 2/17
    (subfamily), plus 6 (PostScript name) as a last resort for a file with a
    malformed family record. Windows/Unicode records win over legacy Mac ones,
    and an English/Western record wins over a localized one, so the same font
    answers with the same name on every machine.
    """
    if len(name_table) < 6:
        return {}
    _format, count, string_offset = struct.unpack_from(">HHH", name_table, 0)
    wanted = (1, 2, 6, 16, 17)
    best: dict[int, tuple[int, int]] = {}
    out: dict[int, str] = {}
    for i in range(count):
        record = 6 + i * 12
        if len(name_table) < record + 12:
            break
        platform, _encoding, language, name_id, length, offset = struct.unpack_from(
            ">6H", name_table, record)
        if name_id not in wanted:
            continue
        start = string_offset + offset
        raw = name_table[start:start + length]
        if len(raw) < length:
            continue
        if platform in (0, 3):          # Unicode / Windows: UTF-16BE
            text = raw.decode("utf-16-be", "ignore")
        elif platform == 1:             # Macintosh Roman
            text = raw.decode("mac-roman", "ignore")
        else:
            continue
        text = text.replace("\x00", "").strip()
        if not text:
            continue
        rank = (2 if platform == 3 else 1,
                1 if language in (0, 0x409) else 0)
        if name_id in out and rank < best.get(name_id, (-1, -1)):
            continue
        out[name_id] = text
        best[name_id] = rank
    return out


def read_font_meta(data: bytes) -> dict:
    """
    Family, subfamily, weight and slant from a font file's own tables.

    Everything here is best-effort and total: a truncated, encrypted or
    WOFF2 (Brotli-compressed directory) file answers with an empty family and
    the default weight, and the caller falls back to the file name. The point is
    that a row in the settings list says what the file calls itself — `Honk`,
    not `Honk Regular VariableFont MORF,SHLN` — and that the overlay registers
    the face at the weight it was drawn at.
    """
    meta = {"family": "", "subfamily": "", "weight": 0, "italic": False}
    try:
        if data[:4] == b"wOF2":
            # WOFF2 compresses its table directory with Brotli, which is not in
            # the standard library; the file name is the honest fallback.
            return meta
        if data[:4] == b"wOFF":
            woff = _woff_tables(data)

            def table(tag: bytes) -> bytes:
                entry = woff.get(tag)
                if not entry:
                    return b""
                offset, comp_length, orig_length = entry
                if comp_length != orig_length:
                    return b""      # deflated: only the stored tables are read
                return data[offset:offset + comp_length]
        else:
            sfnt = _sfnt_tables(data)

            def table(tag: bytes) -> bytes:
                entry = sfnt.get(tag)
                if not entry:
                    return b""
                offset, length = entry
                return data[offset:offset + length]

        names = _name_strings(table(b"name"))
        meta["family"] = names.get(16) or names.get(1) or ""
        meta["subfamily"] = names.get(17) or names.get(2) or ""

        os2 = table(b"OS/2")
        if len(os2) >= 6:
            weight = struct.unpack_from(">H", os2, 4)[0]
            if 1 <= weight <= 1000:
                meta["weight"] = weight
            # fsSelection: bit 0 is ITALIC. Only read from a long enough table,
            # and only as a confirmation — the subfamily name is checked too.
            if len(os2) >= 64:
                meta["italic"] = bool(struct.unpack_from(">H", os2, 62)[0] & 0x01)
        head = table(b"head")
        if len(head) >= 46:
            # macStyle: bit 1 is italic. Set by fonts whose OS/2 table is older
            # than the slant it was drawn with.
            meta["italic"] = meta["italic"] or bool(
                struct.unpack_from(">H", head, 44)[0] & 0x02)
        subfamily = (meta["subfamily"] or "").casefold()
        if "italic" in subfamily or "oblique" in subfamily:
            meta["italic"] = True
    except Exception as exc:      # a malformed file must not take the list down
        debug_log("Font metadata could not be read:", exc)
    return meta


def _suffix_from_mime(header: str) -> str:
    """The extension a data URL's own media type implies, or ''."""
    mime = (header or "").partition(":")[2].partition(";")[0].strip().lower()
    for suffix, known in MIME_TYPES.items():
        if mime == known:
            return suffix
    return ""


class FontLibrary:
    """One folder of font files, plus the family name each file is known by."""

    MAX_MEMO_ENTRIES = 128

    def __init__(self, directory: Path | str | None = None):
        self.directory = Path(directory) if directory else Path(FONT_DIR)
        self._lock = threading.RLock()
        # Metadata per relative path, validated by (mtime, size): the settings
        # sheet rebuilds its list on every panel sync, and re-reading a folder of
        # font files each time would be a disk read per row per paint.
        self._memo: OrderedDict[str, tuple[float, int, dict]] = OrderedDict()

    # ------------------------------------------------------------------ folder
    def ensure_dir(self) -> Path:
        """Creates the folder on first use. Never raises."""
        try:
            if not self.directory.exists():
                self.directory.mkdir(parents=True, exist_ok=True)
            # The default folder lives beside the app (inside the project
            # checkout when run from source), so a user's own fonts must never
            # turn up in `git status`.
            # Both sides are canonicalised first: DATA_DIR can arrive spelled
            # any way the environment holds it — the CI runner's TEMP is the 8.3
            # short form (`C:\Users\RUNNER~1\...`) — while `resolve()` expands
            # the folder it is compared against, so an unresolved DATA_DIR named
            # the same folder and still never matched.
            if Path(DATA_DIR).resolve() in self.directory.resolve().parents:
                marker = self.directory / ".gitignore"
                if not marker.exists():
                    marker.write_text("*\n!.gitignore\n", encoding="utf-8")
        except Exception as exc:
            debug_log("Font library folder could not be created:", exc)
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
                if name.startswith(".") or Path(name).suffix.lower() not in FONT_SUFFIXES:
                    continue
                out.append(Path(root) / name)
        out.sort(key=lambda p: p.name.casefold())
        return out

    def _library_digests(self, sizes=None) -> dict[str, str]:
        """
        Maps the SHA-256 of each live file to the name it is kept under.

        The live files only: `_files` skips `.trash`, so a face the user removed
        on purpose can be imported again. Given `sizes`, only files of those
        lengths are hashed — equal bytes have equal length, so a length nothing
        being imported shares cannot hold a duplicate of it.
        """
        out = {}
        for path in self._files():
            try:
                if sizes is not None and path.stat().st_size not in sizes:
                    continue
                out[_file_digest(path)] = path.name
            except OSError:
                continue
        return out

    def _safe_path(self, rel: str) -> Path | None:
        """The file `rel` names, or None unless it is a file inside the folder."""
        rel = str(rel or "").replace("\\", "/").lstrip("/")
        if not rel or ".." in Path(rel).parts:
            return None
        target = self.directory / rel
        try:
            if not target.is_file():
                return None
            target.resolve().relative_to(self.directory.resolve())
        except Exception:
            return None
        return target

    # ------------------------------------------------------------------- index
    def family_ids(self, rels: list[str]) -> dict[str, str]:
        """
        The CSS family each file is registered under.

        Derived from the file name rather than from its position, because the
        overlay stores this string as the user's chosen font: a name that moved
        when another font was added would silently reset their lyrics. Two files
        whose stems collide (`Air.ttf` beside `Air.otf`) fold the extension into
        the name instead of sharing one family.
        """
        by_stem: dict[str, list[str]] = {}
        for rel in rels:
            by_stem.setdefault(Path(rel).stem.lower(), []).append(rel)
        ids = {}
        for rel in rels:
            stem = Path(rel).stem
            shared = len(by_stem[stem.lower()]) > 1
            ids[rel] = FAMILY_PREFIX + slug(rel if shared else stem)
        return ids

    def _describe(self, path: Path, rel: str, family_id: str, stat) -> dict:
        memo = self._memo.get(rel)
        if memo and memo[0] == stat.st_mtime and memo[1] == stat.st_size:
            self._memo.move_to_end(rel)
            meta = memo[2]
        else:
            try:
                meta = read_font_meta(path.read_bytes())
            except Exception as exc:
                debug_log("Font file could not be read:", rel, exc)
                meta = {"family": "", "subfamily": "", "weight": 0, "italic": False}
            self._memo[rel] = (stat.st_mtime, stat.st_size, meta)
            while len(self._memo) > self.MAX_MEMO_ENTRIES:
                self._memo.popitem(last=False)
        return {
            "file": rel,
            "name": path.name,
            "label": meta["family"] or label_from_filename(path.stem),
            "id": family_id,
            "size": int(stat.st_size),
            "suffix": path.suffix.lower(),
            "weight": int(meta["weight"] or DEFAULT_WEIGHT),
            "style": "italic" if meta["italic"] else "normal",
            "family": meta["family"],
            # What the file calls itself beyond its family. It travels because the
            # family alone is not a name: four real Georgia files (regular, bold,
            # italic, bold italic) all report "Georgia", so the list would show one
            # row four times and leave the file name to tell them apart.
            "subfamily": meta["subfamily"],
        }

    def entries(self) -> list[dict]:
        with self._lock:
            paths = self._files()
            ids = self.family_ids([self._rel(p) for p in paths])
            out = []
            for path in paths:
                rel = self._rel(path)
                try:
                    stat = path.stat()
                except OSError:
                    continue
                out.append(self._describe(path, rel, ids[rel], stat))
            return sorted(out, key=lambda e: (e["label"].casefold(), e["name"].casefold()))

    def data(self, rel: str) -> str:
        """A data URL for one file, or '' when it cannot be read."""
        path = self._safe_path(rel)
        if path is None:
            return ""
        try:
            raw = path.read_bytes()
        except Exception as exc:
            debug_log("Font file could not be read for the overlay:", rel, exc)
            return ""
        mime = MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")
        return "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode("ascii"))

    # -------------------------------------------------------------- mutations
    def add_files(self, paths) -> dict:
        """
        Copies chosen files into the library.

        Non-destructive, like the lyric library: a name clash never overwrites,
        and a file already inside the folder is left where it is rather than
        copied onto itself. There is deliberately no cap on how many are kept —
        the folder is the limit — and nothing here re-encodes the file, so what
        the user imported is what the overlay loads.

        A face is its bytes, so the same bytes never enter twice: a second copy
        of a font already here is skipped under the name that holds it, instead
        of becoming a second row drawing the same face under the same label.
        """
        report = {"added": [], "skipped": [], "failed": []}
        with self._lock:
            self.ensure_dir()
            paths = list(paths or [])
            wanted = set()
            for raw in paths:
                try:
                    wanted.add(Path(str(raw)).stat().st_size)
                except Exception:
                    # Only a filter: a path that cannot be measured here is not
                    # hashed against, and is reported for what it is below.
                    pass
            known = self._library_digests(wanted)
            for raw in paths:
                source = Path(str(raw))
                if not source.is_file():
                    report["failed"].append({"name": source.name or str(raw),
                                             "reason": "not a file"})
                    continue
                if source.suffix.lower() not in FONT_SUFFIXES:
                    report["failed"].append({"name": source.name,
                                             "reason": "not a .ttf, .otf, .woff or .woff2 file"})
                    continue
                try:
                    if source.resolve().parent == self.directory.resolve():
                        report["skipped"].append(source.name)
                        continue
                except OSError:
                    pass
                try:
                    digest = _file_digest(source)
                except Exception as exc:
                    report["failed"].append({"name": source.name, "reason": str(exc)})
                    continue
                owner = known.get(digest)
                if owner:
                    report["skipped"].append(owner)
                    continue
                try:
                    target = self._unique_target(_safe_name(source.name))
                    shutil.copy2(source, target)
                except Exception as exc:
                    report["failed"].append({"name": source.name, "reason": str(exc)})
                    continue
                # Recorded as soon as the copy is here, so picking the same file
                # twice in one multi-select answers like importing it twice would.
                known[digest] = target.name
                # Kept either way, so a file the user can fix in place does not
                # have to be imported again — but a copy that is not a font is
                # reported now rather than discovered as an unruly row.
                try:
                    signature = target.read_bytes()[:4]
                except Exception:
                    signature = b""
                if signature[:4] not in FONT_SIGNATURES:
                    report["failed"].append({"name": target.name,
                                             "reason": "not a font file"})
                else:
                    report["added"].append({"name": target.name})
        return report

    def adopt(self, entries) -> dict:
        """
        Writes fonts the older, store-based importer kept as data URLs.

        This runs once, when the overlay finds those blobs in its settings and
        hands them over.        The stored family id is preserved by naming the file
        after it, because that id is also the value the user's chosen font is
        saved under: deriving a fresh name here would quietly reset their lyrics
        to the default face. Bytes already in the folder are skipped under the
        name holding them, so a rerun — or a crash halfway through the handover —
        cannot leave one face stored twice under two legacy ids.
        """
        report = {"added": [], "skipped": [], "failed": []}
        with self._lock:
            self.ensure_dir()
            for item in (entries or []):
                if not isinstance(item, dict):
                    continue
                data_url = str(item.get("dataUrl") or "")
                header, _comma, payload = data_url.partition(",")
                try:
                    raw = base64.b64decode(payload, validate=False) if payload else b""
                except Exception:
                    raw = b""
                if not raw:
                    report["failed"].append({"name": str(item.get("name") or "font"),
                                             "reason": "no font data"})
                    continue
                owner = self._library_digests({len(raw)}).get(hashlib.sha256(raw).hexdigest())
                if owner:
                    report["skipped"].append(owner)
                    continue
                stem = str(item.get("legacyId") or "").strip()
                if stem.startswith(FAMILY_PREFIX):
                    stem = stem[len(FAMILY_PREFIX):]
                if not stem:
                    stem = Path(str(item.get("name") or "font")).stem
                suffix = Path(str(item.get("name") or "")).suffix.lower()
                if suffix not in FONT_SUFFIXES:
                    suffix = _suffix_from_mime(header) or ".ttf"
                name = _safe_name(stem) + suffix
                target = self.directory / name
                if target.exists():
                    # The same stored font is already here (the handover ran
                    # once before): skipped, not overwritten and not doubled.
                    report["skipped"].append(name)
                    continue
                try:
                    target.write_bytes(raw)
                except Exception as exc:
                    report["failed"].append({"name": str(item.get("name") or stem),
                                             "reason": str(exc)})
                    continue
                report["added"].append({"name": target.name})
            self._memo.clear()
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
        Removes a font from the library.

        Moved into `<folder>/.trash` rather than deleted: removing a face is a
        management action, not a statement that the user wants the file gone
        from their disk for good.
        """
        with self._lock:
            path = self._safe_path(rel)
            if path is None:
                return {"ok": False, "reason": "not in the library", "name": str(rel or "")}
            name = path.name
            try:
                trash = self.directory / TRASH_DIR_NAME
                trash.mkdir(parents=True, exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                path.replace(trash / f"{stamp}-{name}")
            except Exception as exc:
                return {"ok": False, "reason": f"could not remove ({exc})", "name": name}
            self._memo.pop(str(rel), None)
            return {"ok": True, "name": name}

    def reveal(self, rel: str = "") -> bool:
        """Opens the folder (or selects one file in it) in the file manager."""
        try:
            self.ensure_dir()
            if rel:
                target = self._safe_path(rel)
                if target is not None:
                    try:
                        import subprocess
                        subprocess.run(["explorer.exe", f"/select,{target.resolve()}"], check=False)
                        return True
                    except Exception:
                        pass
            os.startfile(str(self.directory))      # noqa: S606 - Windows shell
            return True
        except Exception as exc:
            debug_log("Could not open the font folder:", exc)
            return False

    # ---------------------------------------------------------------- snapshot
    def snapshot(self) -> dict:
        """
        Everything the settings list needs, in one round trip.

        The bytes are NOT in here: a folder of fonts is megabytes and the sheet
        only ever needs one face at a time (see `data`).
        """
        with self._lock:
            entries = self.entries()
            return {
                "dir": str(self.directory),
                "count": len(entries),
                "entries": entries,
                "trash": self._trash_count(),
            }

    def _trash_count(self) -> int:
        trash = self.directory / TRASH_DIR_NAME
        try:
            return sum(1 for p in trash.iterdir() if p.is_file())
        except OSError:
            return 0


def _file_digest(path: Path) -> str:
    """The SHA-256 of a file, read in blocks so a large font is not held twice."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_name(name: str) -> str:
    """A file name that is safe to create on Windows, never empty."""
    cleaned = _ILLEGAL_FILENAME_RE.sub("-", str(name or "")).strip(" .")
    return cleaned or "font"


FONT_LIBRARY = FontLibrary()
