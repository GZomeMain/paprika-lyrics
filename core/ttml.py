"""
Apple-Music-style TTML lyric parsing.

Pure functions only: this module reads no files, touches no cache and makes no
network calls. `core.ttml_library` owns the library folder, the index and the
per-track bindings; this file turns ONE TTML document into the same
line/word/syllable shape the rest of the app already renders (the shape
`parse_spicy_body` and `parse_lrc` produce), so a local file feeds the existing
UI, beat engine and diagnostics with no special cases.

The dialect handled here is the one Apple Music ships and the AMLL TTML database
standardises (which is what people actually collect):

* `itunes:timing="Word"` (or inferred from timed `<span>`s) — every syllable is
  its own timed span, spaces between words are significant text.
* `itunes:timing="Line"` — only `<p>` carries timing; word times are modelled by
  the same musical distribution the LRCLIB path uses.
* `<span ttm:role="x-translation">`, `x-roman` and `x-bg` (background vocals,
  optionally word-timed).
* Apple's header-style translations/transliterations in `<iTunesMetadata>`,
  linked to lines by `<p itunes:key="L7">`.
* Namespaces are treated as advisory: every element and attribute is matched on
  its local name, so prefixed, default-namespaced, renamed-namespace and
  namespace-less exports all parse.
"""

import re
import xml.etree.ElementTree as ET

from core.parser import (
    enrich_lrclib_word_timings,
    fallback_segment_syllables,
    is_backing_vocal_text,
)

ROLE_TRANSLATION = "x-translation"
ROLE_ROMAN = "x-roman"
ROLE_BG = "x-bg"

# Roles that are not part of the sung line itself: auxiliary text and background
# vocals. Everything else a span can carry is the lead vocal.
NON_VOCAL_ROLES = (ROLE_TRANSLATION, ROLE_ROMAN, ROLE_BG)

DEFAULT_FRAME_RATE = 30.0
# Guard against a misread timestamp becoming a line 40 minutes long. Apple's own
# stamps are clock times, so anything past this is a parse artifact, not a lyric.
MAX_SANE_MS = 6 * 60 * 60 * 1000.0

# TTML1 offset-time suffixes. Order matters: 'ms' must win over 'm'/'s'.
_OFFSET_RE = re.compile(r"^([+-]?\d+(?:\.\d+)?)(h|ms|m|s|f|t)$", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")


def _local(tag) -> str:
    """Local name of a namespaced ElementTree tag: '{uri}p' -> 'p'."""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1].split(":")[-1].lower()


def _attrs(el) -> dict:
    """
    Attributes keyed by local name.

    TTML files in the wild declare the metadata namespace with different
    prefixes (or none at all), so matching on 'role' rather than on
    '{http://www.w3.org/ns/ttml#metadata}role' is what makes one parser work for
    Apple exports, AMLL files and hand-written ones alike.
    """
    out = {}
    for key, value in (getattr(el, "attrib", None) or {}).items():
        out.setdefault(_local(key), value)
    return out


def _norm_ws(text: str) -> str:
    return _WS_RE.sub(" ", text or "").strip()


def _plain_text(el, skip_roles=()) -> str:
    """
    Concatenated text of an element, skipping any subtree whose span carries one
    of `skip_roles`. Used to read a line's own words without swallowing its
    translation or background-vocal spans.
    """
    if el is None:
        return ""
    parts = [el.text or ""]
    for child in list(el):
        a = _attrs(child)
        if _local(child.tag) == "span" and (a.get("role") or "").lower() in skip_roles:
            parts.append(child.tail or "")
            continue
        parts.append(_plain_text(child, skip_roles))
        parts.append(child.tail or "")
    return "".join(parts)


def parse_time(value, frame_rate: float = DEFAULT_FRAME_RATE) -> float | None:
    """
    TTML time expression -> milliseconds, or None when it is not one.

    Accepts the forms the apple/AMLL dialect allows — clock times with optional
    hours (`00:02:35.5`, `02:35.55`), bare seconds (`35.123`, `95`), offset times
    (`15.8s`, `500ms`, `2m`) — plus the TTML1 frame form (`00:02:35:15`) that
    submission tools emit. Decimal precision follows the dialect: `15.1` is
    tenths (100 ms), `15.12` hundredths (120 ms), `15.123` milliseconds.
    """
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None

    m = _OFFSET_RE.match(raw)
    if m:
        amount = float(m.group(1))
        unit = m.group(2).lower()
        rate = 1000.0 / frame_rate if frame_rate else 1000.0 / DEFAULT_FRAME_RATE
        scale = {
            "h": 3_600_000.0,
            "m": 60_000.0,
            "s": 1000.0,
            "ms": 1.0,
            "f": rate,
            "t": rate,
        }[unit]
        return _clamp(amount * scale)

    parts = raw.split(":")
    if len(parts) == 1:
        try:
            # No colon: seconds, and the dialect explicitly allows >60 ('95').
            return _clamp(float(raw) * 1000.0)
        except ValueError:
            return None

    if len(parts) in (2, 3):
        try:
            values = [float(p) for p in parts]
        except ValueError:
            return None
        total = 0.0
        for value_part in values:      # MM:SS or HH:MM:SS
            total = total * 60.0 + value_part
        return _clamp(total * 1000.0)

    if len(parts) == 4:
        try:
            hours, minutes, seconds, frames = (float(p) for p in parts)
        except ValueError:
            return None
        rate = frame_rate if frame_rate else DEFAULT_FRAME_RATE
        return _clamp((hours * 3600.0 + minutes * 60.0 + seconds) * 1000.0
                      + frames * (1000.0 / rate))

    return None


def _clamp(ms: float) -> float:
    if ms < 0:
        return 0.0
    return ms if ms <= MAX_SANE_MS else MAX_SANE_MS


def _has_time(span, frame_rate) -> bool:
    a = _attrs(span)
    return parse_time(a.get("begin"), frame_rate) is not None or \
        parse_time(a.get("end"), frame_rate) is not None


def _add_space(leaf) -> None:
    """Marks a leaf as word-final. The app's word grouping reads exactly this."""
    if leaf is not None and not leaf["text"].endswith((" ", "\t")):
        leaf["text"] += " "


def _walk_spans(el, role, default_begin, default_end, frame_rate, leaves,
                group=None, groups=None) -> None:
    """
    Depth-first collection of the timed text runs under one element.

    A span with timed children is a GROUP — a word wrapping its syllables, or an
    `x-bg` block wrapping its own words — not a syllable itself: its children are
    collected with its time range and role as the default, and tagged with the
    group id so the syllables know they belong to one word. Every leaf carries
    the range it should sing over, the role it inherits, and its group.
    """
    groups = groups if groups is not None else [0]
    for child in list(el):
        if _local(child.tag) != "span":
            continue
        a = _attrs(child)
        child_role = (a.get("role") or role or "").lower()
        own_begin = parse_time(a.get("begin"), frame_rate)
        own_end = parse_time(a.get("end"), frame_rate)
        begin = own_begin if own_begin is not None else default_begin
        end = own_end if own_end is not None else default_end

        before = len(leaves)
        timed_children = [g for g in list(child)
                          if _local(g.tag) == "span" and _has_time(g, frame_rate)]
        if timed_children:
            groups[0] += 1
            _walk_spans(child, child_role, begin, end, frame_rate, leaves,
                        group=groups[0], groups=groups)
        else:
            text = "".join(child.itertext())
            if text.strip():
                leaves.append({
                    "text": _norm_ws_keep_trailing(text),
                    "begin": begin,
                    "end": end,
                    "timed": own_begin is not None or own_end is not None,
                    "role": child_role,
                    "group": group,
                })
            elif leaves:
                # A dedicated space-only span ("<span> </span>"): the separator
                # is load-bearing for word grouping.
                _add_space(leaves[-1])

        # "The space exists as an independent text node between two spans."
        if len(leaves) > before and child.tail and not child.tail.strip():
            _add_space(leaves[-1])


def _norm_ws_keep_trailing(text: str) -> str:
    """Collapses interior/leading whitespace but preserves a trailing space."""
    raw = (text or "").replace("\t", " ")
    if not raw.strip():
        return ""
    trailing = " " if raw.endswith(" ") or raw.endswith("\n") else ""
    return _WS_RE.sub(" ", raw).strip() + trailing


def _split_leaf(leaf) -> list[dict]:
    """
    Splits one span's text into word-sized pieces.

    Most TTML spans are already one word or one syllable, but a span holding a
    whole phrase is common in hand-made and line-timed files; splitting it keeps
    the word-level wipe honest instead of one word blinking over half a line.
    Time is distributed by character weight, and the trailing space stays on the
    last piece so word grouping still sees the boundary.
    """
    text = leaf["text"]
    tokens = text.split()
    if len(tokens) <= 1:
        return [leaf]

    begin = leaf["begin"]
    end = leaf["end"]
    if begin is None or end is None or end <= begin:
        return [dict(leaf, text=tokens[0] + (" " if text.endswith(" ") else ""))] + [
            dict(leaf, text=t + " ") for t in tokens[1:-1]
        ] + [dict(leaf, text=tokens[-1] + (" " if text.endswith(" ") else ""))]

    weights = [max(1, len(t)) for t in tokens]
    total = float(sum(weights))
    out = []
    cursor = begin
    for i, token in enumerate(tokens):
        duration = (end - begin) * weights[i] / total
        suffix = " " if (i < len(tokens) - 1 or text.endswith(" ")) else ""
        out.append(dict(leaf, text=token + suffix,
                        begin=cursor, end=cursor + duration))
        cursor += duration
    return out


def _syllables_from_leaves(leaves, line_begin, line_end) -> list[dict]:
    """
    Leaves -> syllable dicts in the shape `fallback_segment_syllables` groups.

    A missing or collapsed end is stretched to the next syllable's onset (the
    same courtesy the API parser extends to sloppy payloads), so no syllable has
    a zero-length window for the renderer to divide by.
    """
    pieces = []
    for seq, leaf in enumerate(leaves):
        for piece in _split_leaf(leaf):
            piece["seq"] = seq
            pieces.append(piece)

    syllables = []
    for i, leaf in enumerate(pieces):
        begin = leaf["begin"]
        end = leaf["end"]
        text = leaf["text"]
        if begin is None:
            begin = line_begin
        if begin is None:
            begin = 0.0
        if end is None or end <= begin:
            nxt = None
            for candidate in pieces[i + 1:]:
                if candidate["begin"] is not None and candidate["begin"] > begin:
                    nxt = candidate["begin"]
                    break
            end = nxt if nxt is not None else max(
                begin + 100.0, line_end if line_end and line_end > begin else begin + 100.0)
        if line_end is not None and end > line_end + 0.5:
            end = line_end
        if end <= begin:
            end = begin + 100.0
        syllables.append({
            "rawText": text,
            "startTimeMs": float(begin),
            "endTimeMs": float(end),
            "letters": None,
            "isPartOfWord": _part_of_word(leaf, pieces, i),
        })
    return syllables


def _part_of_word(piece, pieces, index) -> bool | None:
    """
    Whether a syllable continues the word the previous one started.

    Only a nested span states this outright: everything inside it is one word
    (a syllable-split 'beau'+'ti'+'ful' is 'beautiful' no matter how long the
    gaps between its syllables are), except pieces a single span already split
    by its own internal spaces — those are separate words by definition. At the
    top level the answer stays None so the shared grouping heuristics (trailing
    spaces, gaps, known split words) keep deciding, which is what makes files
    that mark syllables without spaces behave.
    """
    following = pieces[index + 1] if index + 1 < len(pieces) else None
    if following is not None and following.get("seq") == piece.get("seq"):
        return False
    if piece.get("group") is None:
        return None
    for later in pieces[index + 1:]:
        if later.get("group") == piece["group"]:
            return True
    return False


def _words_for(syllables, text_fallback: str) -> list[dict]:
    words = fallback_segment_syllables(syllables)
    if words:
        return words
    return fallback_segment_syllables([
        {"rawText": token + " ", "startTimeMs": 0.0, "endTimeMs": 100.0,
         "letters": None, "isPartOfWord": None}
        for token in text_fallback.split()
    ])


def _aux_maps(head) -> dict:
    """
    Apple's header-style auxiliary tracks: `<translations><translation
    xml:lang><text for="L7">…` keyed by the lyric line's `itunes:key`.

    Only the first track of each kind is used: the overlay shows one secondary
    line, so picking the first declared translation is both deterministic and
    what the reference files mean by listing one.
    """
    maps = {"translation": {}, "transliteration": {}, "translation_lang": "",
            "transliteration_lang": ""}
    if head is None:
        return maps

    for container in head.iter():
        name = _local(container.tag)
        if name == "translations":
            key = "translation"
        elif name == "transliterations":
            key = "transliteration"
        else:
            continue
        for track in list(container):
            if _local(track.tag) not in (key,):
                continue
            entries = {}
            for text_el in track.iter():
                if _local(text_el.tag) != "text":
                    continue
                line_key = _attrs(text_el).get("for")
                value = _norm_ws("".join(text_el.itertext()))
                if line_key and value:
                    entries.setdefault(line_key.strip().upper(), value)
            if entries and not maps[key]:
                maps[key] = entries
                maps[key + "_lang"] = _attrs(track).get("lang", "")
    return maps


def _extract_meta(root, head, body, meta: dict) -> None:
    """Fills the song metadata used for matching a file to a playing track."""
    root_attrs = _attrs(root)
    meta["lang"] = root_attrs.get("lang", "")
    meta["timing_declared"] = (root_attrs.get("timing") or "").capitalize()

    amll = {}
    agents = []
    legacy = {}
    if head is not None:
        for el in head.iter():
            name = _local(el.tag)
            if name == "meta":
                a = _attrs(el)
                key = (a.get("key") or "").strip()
                value = (a.get("value") or "").strip()
                if key and value:
                    amll.setdefault(key.lower(), []).append(value)
            elif name == "title":
                # <ttm:title> — the standard song title tag.
                if not meta.get("title"):
                    meta["title"] = _norm_ws("".join(el.itertext()))
            elif name == "agent":
                agent = {"id": _attrs(el).get("id", ""),
                         "type": _attrs(el).get("type", ""),
                         "name": ""}
                for child in el.iter():
                    if _local(child.tag) == "name":
                        agent["name"] = _norm_ws("".join(child.itertext()))
                        break
                agents.append(agent)
            elif name in ("songname", "songtitle", "artistname", "albumname"):
                legacy.setdefault(name, _norm_ws("".join(el.itertext())))

    meta["agents"] = [a for a in agents if a["name"]]
    meta["spotify_id"] = (amll.get("spotifyid") or [""])[0]
    meta["apple_music_id"] = (amll.get("applemusicid") or [""])[0]

    meta["title"] = meta.get("title") or (amll.get("musicname") or [""])[0] \
        or legacy.get("songname", "") or legacy.get("songtitle", "")
    meta["artist"] = ", ".join(amll.get("artists") or []) or _agent_artist(agents) \
        or legacy.get("artistname", "")
    meta["album"] = (amll.get("album") or [""])[0] or legacy.get("albumname", "")

    duration = parse_time(_attrs(body).get("dur")) if body is not None else None
    if duration is None:
        duration = parse_time(root_attrs.get("dur"))
    meta["duration_ms"] = duration


def _agent_artist(agents: list[dict]) -> str:
    """
    The performer name(s) from `<ttm:agent>`.

    Conventions worth honouring: `v1000` is the background/choir agent, and
    grouped agents describe the credited performers. Lead performers (`v1`,
    `v2`, …) are joined the way a player would credit them.
    """
    names, seen = [], set()
    for agent in agents:
        if not agent["name"] or agent["id"].lower() == "v1000":
            continue
        if agent["name"] in seen:
            continue
        seen.add(agent["name"])
        names.append(agent["name"])
    return ", ".join(names)


def _empty_meta() -> dict:
    return {
        "title": "", "artist": "", "album": "", "duration_ms": None,
        "lang": "", "timing": "", "timing_declared": "",
        "spotify_id": "", "apple_music_id": "", "agents": [],
        "error": "",
    }


def parse_ttml(text: str, filename_hint: str = "") -> tuple[list[dict], dict]:
    """
    Parses one TTML document.

    Returns `(lines, meta)`. `lines` is empty on any failure, and `meta["error"]`
    explains why — the caller (the library) surfaces that in the UI instead of
    silently ignoring a file the user just added. Line-mode documents come back
    with musically distributed word timing, so even a line-timed file wipes
    word by word rather than stepping line by line.
    """
    meta = _empty_meta()
    if filename_hint:
        meta["filename_hint"] = filename_hint

    if not text or not text.strip():
        meta["error"] = "empty file"
        return [], meta

    try:
        root = ET.fromstring(text)
    except ET.ParseError as exc:
        meta["error"] = f"not valid XML ({exc})"
        return [], meta
    except Exception as exc:                                    # pragma: no cover
        meta["error"] = f"unreadable XML ({exc})"
        return [], meta

    if _local(root.tag) != "tt":
        meta["error"] = f"not a TTML document (root <{_local(root.tag) or '?'}>)"
        return [], meta

    frame_rate = 0.0
    try:
        frame_rate = float(_attrs(root).get("framerate") or DEFAULT_FRAME_RATE)
    except (TypeError, ValueError):
        frame_rate = DEFAULT_FRAME_RATE
    if frame_rate <= 0:
        frame_rate = DEFAULT_FRAME_RATE

    head = body = None
    for el in list(root):
        name = _local(el.tag)
        if name == "head" and head is None:
            head = el
        elif name == "body" and body is None:
            body = el

    _extract_meta(root, head, body, meta)
    aux = _aux_maps(head)
    meta["translation_lang"] = aux["translation_lang"]
    meta["transliteration_lang"] = aux["transliteration_lang"]

    # A file that declares itself line-timed is taken at its word: the dialect
    # says inner span timestamps are then noise, and honouring the declaration is
    # what keeps a Line export from rendering as a ragged word wipe.
    forced_line = meta["timing_declared"].lower() == "line"

    lines: list[dict] = []
    word_timed = False
    containers = body if body is not None else root
    for p in containers.iter():
        if _local(p.tag) != "p":
            continue
        p_attrs = _attrs(p)
        p_begin = parse_time(p_attrs.get("begin"), frame_rate)
        p_end = parse_time(p_attrs.get("end"), frame_rate)
        line_key = (p_attrs.get("key") or "").strip().upper()

        leaves: list[dict] = []
        _walk_spans(p, "", p_begin, p_end, frame_rate, leaves)

        if any(leaf["timed"] for leaf in leaves):
            word_timed = True

        lead = [lf for lf in leaves if lf["role"] not in NON_VOCAL_ROLES]
        bg = [lf for lf in leaves if lf["role"] == ROLE_BG]
        inline_translation = " / ".join(
            _norm_ws(lf["text"]) for lf in leaves
            if lf["role"] == ROLE_TRANSLATION and _norm_ws(lf["text"]))
        inline_roman = " / ".join(
            _norm_ws(lf["text"]) for lf in leaves
            if lf["role"] == ROLE_ROMAN and _norm_ws(lf["text"]))

        line_text = _norm_ws(_plain_text(p, NON_VOCAL_ROLES))
        if not line_text and not lead and not bg:
            continue   # an empty <p>: a spacer, not a lyric

        span_begin = min([lf["begin"] for lf in leaves if lf["begin"] is not None],
                         default=None)
        span_end = max([lf["end"] for lf in leaves if lf["end"] is not None],
                       default=None)
        begin = p_begin if p_begin is not None else span_begin
        end = p_end if p_end is not None else span_end
        if begin is None:
            continue
        if end is None or end <= begin:
            end = max(begin + 400.0, span_end or 0.0)

        if lead:
            syllables = _syllables_from_leaves(lead, begin, end)
            words = _words_for(syllables, line_text)
        else:
            # Line-timed (or text-only): one syllable per written word, then the
            # musical distribution model rewrites the times within the window.
            words = _words_for(_syllables_from_leaves(
                [{"text": token + " ", "begin": begin, "end": end,
                  "timed": False, "role": ""} for token in line_text.split()],
                begin, end), line_text)

        if not words and not line_text:
            continue

        lines.append({
            "startTimeMs": float(begin),
            "endTimeMs": float(end),
            "text": line_text or " ".join(w["text"] for w in words),
            "words": words,
            "isBackground": is_backing_vocal_text(line_text),
            "translation": inline_translation or aux["translation"].get(line_key, ""),
            "transliteration": inline_roman or aux["transliteration"].get(line_key, ""),
        })

        if bg:
            bg_begin = min([lf["begin"] for lf in bg if lf["begin"] is not None],
                           default=begin)
            bg_end = max([lf["end"] for lf in bg if lf["end"] is not None],
                         default=end)
            if bg_end is None or bg_end <= bg_begin:
                bg_end = bg_begin + 400.0
            bg_syllables = _syllables_from_leaves(bg, bg_begin, bg_end)
            bg_text = _norm_ws(" ".join(lf["text"] for lf in bg))
            bg_words = _words_for(bg_syllables, bg_text)
            if bg_words:
                lines.append({
                    "startTimeMs": float(bg_begin),
                    "endTimeMs": float(bg_end),
                    "text": bg_text,
                    "words": bg_words,
                    "isBackground": True,
                    "translation": "",
                    "transliteration": "",
                })

    if not lines:
        meta["error"] = meta["error"] or "no lyric lines found"
        meta["timing"] = ""
        return [], meta

    lines.sort(key=lambda line: (line["startTimeMs"], line["isBackground"]))

    if meta["duration_ms"] is None:
        # No <body dur>: the last timed line is a serviceable track length, and
        # the library uses it to break ties between same-named files.
        meta["duration_ms"] = max(line["endTimeMs"] for line in lines)

    word_timed = word_timed and not forced_line
    if not word_timed:
        # Declared or inferred line timing: distribute each line's window over
        # its words the way the LRCLIB path does, so a line-timed file still
        # wipes word by word instead of stepping line by line.
        try:
            enrich_lrclib_word_timings(lines)
        except Exception:                                        # pragma: no cover
            pass

    meta["timing"] = "Word" if word_timed else "Line"
    return lines, meta
