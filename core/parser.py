import math
import re

# Lyric-line timing constants (LRCLIB enrichment + reference alignment).
# A syllable's sung length is stretched toward the local musical pulse, but a
# word never borrows more than this much silence from the syllable after it.
MAX_WORD_END_BORROW_MS = 700.0
# Line-synced sources only mark when a line STARTS; anything sung before the
# next line begins is fair game for distributing word timings, but capping at
# 8s keeps a trailing instrumental from smearing the last line's words.
MAX_LINE_TAIL_MS = 8000.0
# How far the word fill is allowed to run past the final syllable's start
# before the line is considered done. Singing does not stop instantly, so a
# little overhang reads naturally; half a beat is enough.
LINE_TAIL_FACTOR = 1.6

COMMON_CONTRACTIONS = (
    "'re", "'ve", "'ll", "'d", "'m", "'s", "n't", "d've", "'cause", "'em", "'bout", "'til",
    "’re", "’ve", "’ll", "’d", "’m", "’s", "n’t", "’cause", "’em"
)

COMMON_SPLIT_WORDS = {
    "special", "weirdo", "surprised", "woman", "women", "beautiful", "feather",
    "living", "loving", "sliding", "gravity", "broken", "calling", "crawling",
    "waiting", "hoping", "fading", "healing", "shining", "burning", "running",
    "whisper", "shadow", "silence", "trouble", "secret", "future", "reason",
    "listen", "remember", "forget", "forgive", "forever", "never", "always",
    "almost", "together", "tonight", "believing", "deliver", "surrender",
    "everybody", "somebody", "nobody", "something", "anything", "nothing",
    "someone", "anyone", "everyone", "somewhere", "anywhere", "nowhere"
}


def clean_syllable_text(txt: str) -> str:
    return (txt or "").strip().rstrip("-")


def build_word(sylls: list[dict]) -> dict:
    """
    Assembles a word dict from syllable dicts (each carrying a raw "raw" field).
    Syllables whose source text ended with a hyphen and are followed by another
    syllable in the same word are stutter fragments, so the hyphen is restored
    for display: my- + my- + myself -> 'my-my-myself' instead of 'mymyself'.
    """
    parts = []
    for i, syl in enumerate(sylls):
        t = syl["text"]
        raw = (syl.get("raw") or "").rstrip()
        if i < len(sylls) - 1 and raw.endswith("-") and not t.endswith("-"):
            # Written onto the syllable itself, not just the word text: the UI
            # renders and times per-syllable glyphs, so the hyphen must live there.
            t = t + "-"
            syl["text"] = t
        parts.append(t)
    return {
        "syllables": sylls,
        "startTimeMs": sylls[0]["startTimeMs"],
        "endTimeMs": sylls[-1]["endTimeMs"],
        "text": "".join(parts),
    }


def _extract_letters(raw_syllable: dict, is_seconds: bool) -> list[dict] | None:
    """
    Pulls optional per-letter timing off a syllable when the payload provides it.
    Accepts a flat Letters/Chars list or a nested LetterGroup. Returns None when
    the source has no letter-level data, so callers can fall back to syllable fill.
    """
    if not isinstance(raw_syllable, dict):
        return None

    letters = raw_syllable.get("Letters") or raw_syllable.get("letters")
    if not isinstance(letters, list):
        group = (
            raw_syllable.get("LetterGroup") or raw_syllable.get("letterGroup") or
            raw_syllable.get("Chars") or raw_syllable.get("chars")
        )
        if isinstance(group, dict):
            letters = group.get("Letters") or group.get("letters") or []
        elif isinstance(group, list):
            letters = group
        else:
            letters = []

    scale = 1000.0 if is_seconds else 1.0
    out = []
    for item in letters:
        if not isinstance(item, dict):
            continue
        txt = item.get("Text") or item.get("text") or item.get("Char") or item.get("char") or ""
        st = float(item.get("StartTime") or item.get("startTime") or 0) * scale
        et = float(item.get("EndTime") or item.get("endTime") or 0) * scale
        if et <= st:
            et = st + 80.0
        out.append({"text": txt, "startTimeMs": st, "endTimeMs": et})

    return out or None


def _extract_text_fields(track_obj: dict) -> tuple[str | None, str | None]:
    """Extracts optional translation and transliteration strings from a lyric object."""
    if not isinstance(track_obj, dict):
        return None, None

    def pick(*keys):
        for key in keys:
            value = track_obj.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    translation = pick("Translation", "translation", "TranslatedText", "translatedText", "Translated")
    transliteration = pick(
        "Transliteration", "transliteration", "RomanizedText", "romanizedText",
        "Romanized", "Romanization", "Romaji", "romaji",
    )
    return translation, transliteration


def is_backing_vocal_text(text: str) -> bool:
    """Checks if a lyric line is enclosed in parentheses (standard or Asian full-width)."""
    t = (text or "").strip()
    return (t.startswith("(") and t.endswith(")")) or (t.startswith("（") and t.endswith("）"))


def count_syllables(lines: list[dict]) -> int:
    """Counts timed syllables across a payload; 0 means line-level timing only.

    Lives here (rather than beside the fetch pipeline) because every source of
    lines needs it: the API payload, the LRCLIB fallback and local TTML files.
    """
    total = 0
    for line in lines or []:
        if not isinstance(line, dict):
            continue
        for word in (line.get("words") or []):
            if not isinstance(word, dict):
                continue
            total += len(word.get("syllables") or [])
    return total


def align_syllables_to_reference(syllables: list[dict], ref_text: str, offset_ms: float = 0.0) -> list[dict]:
    """
    Groups raw syllables into words using the line's plain text as the guide.

    offset_ms shifts the whole line to a matched LRCLIB timestamp (see
    _lrclib_reference_plan): the API's local item clock can disagree with the
    global
    lyric timeline by a constant offset, and word timing is only as good as the
    line's absolute position. A word that ends early is stretched to the next
    syllable's start (capped), so the fill holds on the word instead of
    blinking out during the tiny gap between syllables.
    """
    tokens = ref_text.split()
    if not tokens:
        return []

    def shifted(ms: float) -> float:
        return ms + offset_ms

    words = []
    w_idx = 0
    curr_sylls = []
    accum_str = ""

    for i, s in enumerate(syllables):
        c_txt = clean_syllable_text(s["rawText"])
        if not c_txt:
            continue

        s_obj = {
            "text": c_txt,
            "raw": s["rawText"],
            "startTimeMs": shifted(s["startTimeMs"]),
            "endTimeMs": shifted(s["endTimeMs"]),
            "isExtended": (s["endTimeMs"] - s["startTimeMs"]) >= 550.0,
            "letters": s.get("letters"),
        }
        curr_sylls.append(s_obj)

        norm_s = re.sub(r"[^\w']", "", c_txt).lower()
        accum_str += norm_s

        target_token = tokens[w_idx] if w_idx < len(tokens) else ""
        norm_target = re.sub(r"[^\w']", "", target_token).lower()

        is_word_end = False
        if norm_target:
            if accum_str == norm_target or len(accum_str) >= len(norm_target):
                is_word_end = True
        else:
            is_word_end = True

        # The API's explicit word-boundary flag outranks every heuristic below:
        # a syllable marked IsPartOfWord continues the current word, and one
        # marked false ends it — even when the reference text disagrees (a
        # length-only match once glued 'Mayo and went' into a single word).
        if s.get("isPartOfWord") is not None:
            is_word_end = not s["isPartOfWord"]

        if s["rawText"].endswith(" ") or s["rawText"].endswith("\t"):
            is_word_end = True

        if is_word_end:
            # Stretch the word's tail to where the next syllable actually
            # starts (within reason). The raw syllable end often stops a
            # few hundred ms short of the next onset, which would make the
            # word's fill finish early and sit idle mid-line.
            nxt = None
            for j in range(i + 1, len(syllables)):
                if clean_syllable_text(syllables[j]["rawText"]):
                    nxt = syllables[j]
                    break
            if nxt is not None:
                nxt_start = shifted(nxt["startTimeMs"])
                last_end = shifted(s["endTimeMs"])
                if nxt_start > last_end:
                    s_obj["endTimeMs"] = min(nxt_start, last_end + MAX_WORD_END_BORROW_MS)
                    s_obj["isExtended"] = (s_obj["endTimeMs"] - s_obj["startTimeMs"]) >= 550.0
            words.append(build_word(curr_sylls))
            curr_sylls = []
            accum_str = ""
            if w_idx < len(tokens):
                w_idx += 1

    for item in curr_sylls:
        words.append(build_word([item]))

    return words


def _syllable_vowels(txt: str) -> int:
    """Counts vowel groups in a syllable: the crude but effective proxy for
    how much singing time a syllable needs ("a" ~1, "ou" ~1 long, "ea" ~1)."""
    return len(re.findall(r"[aeiouy]+", txt.lower()))


def _match_tokens(txt: str) -> list[tuple[str, str]]:
    """
    Splits a syllable or lyric fragment into (normalized, raw) word tokens.
    Normalization drops punctuation (including apostrophes) so a word matches
    across sources that spell it differently — the API's "Screamin'" vs
    LRCLIB's "Screamin", a typographic "don’t" vs "don't", "Ah-ah-ah" vs
    three separate "Ah" syllables. Hyphenated runs also split into separate
    tokens, which is how the API represents them.
    """
    tokens: list[tuple[str, str]] = []
    for piece in re.split(r"[^\w']+", txt or ""):
        piece = piece.strip("'")
        norm = re.sub(r"[^\w]", "", piece.lower())
        if norm:
            tokens.append((norm, piece))
    return tokens


def _flatten_lrclib(lrc_lines: list[dict]) -> list[tuple[str, str, int]]:
    """
    Flattens the LRC stream once: (normalized word, raw token, owning line).
    Raw tokens are kept so returned text preserves the source's case and
    punctuation; matching runs on the normalized form only. Punctuation-only
    tokens are skipped so word indices stay aligned.
    """
    entries: list[tuple[str, str, int]] = []
    for li, line in enumerate(lrc_lines):
        for norm, raw in _match_tokens(line.get("text") or ""):
            entries.append((norm, raw, li))
    return entries


def _match_lrclib_run(syl_words: list[str], occurrences: list[tuple[str, str, int]]) -> tuple[int, int] | None:
    """
    Longest exact word-run match of `syl_words` anywhere in the flattened LRC
    stream. Returns (matched word count, start index) or None. Sliding-window
    matching survives repeated choruses (every occurrence matches) and can
    never glue unrelated words the way length-only matching did.
    """
    n, m = len(syl_words), len(occurrences)
    if n == 0 or m == 0:
        return None
    best: tuple[int, int] | None = None
    for start in range(m):
        if occurrences[start][0] != syl_words[0]:
            continue
        i, j = 0, start
        while i < n and j < m and syl_words[i] == occurrences[j][0]:
            i += 1
            j += 1
        if best is None or i > best[0]:
            best = (i, start)
            if i == n:
                break  # full match; cannot do better
    return best if best and best[0] > 0 else None


def _find_lrclib_runs(syl_words: list[str], occurrences: list[tuple[str, str, int]],
                      claimed: set[int] | None = None) -> list[tuple[int, int]]:
    """
    All exact word-run matches of `syl_words` in the flattened LRC stream,
    as (matched word count, start index) pairs, longest first. When `claimed`
    is given, only runs free of claimed word positions are returned.
    """
    n, m = len(syl_words), len(occurrences)
    if n == 0 or m == 0:
        return []
    runs: list[tuple[int, int]] = []
    for start in range(m):
        if occurrences[start][0] != syl_words[0]:
            continue
        i, j = 0, start
        while i < n and j < m and syl_words[i] == occurrences[j][0]:
            i += 1
            j += 1
        if i == 0:
            continue
        if claimed is not None and any(k in claimed for k in range(start, start + i)):
            continue
        runs.append((i, start))
    runs.sort(key=lambda r: -r[0])
    return runs


# Matches whose re-anchoring offset deviates further than this from the
# track's dominant offset are rejected: a chorus "(Ah)" prefix matching into
# a different section, or a stray ad-lib coincidence, always disagrees with
# what the whole rest of the song agrees on.
LRCLIB_OFFSET_TOLERANCE_MS = 150.0


def _lrclib_reference_plan(
    pending: list[dict],
    occurrences: list[tuple[str, str, int]],
    lrc_lines: list[dict],
) -> None:
    """
    Decides, for each flat-syllable item lacking its own text, whether an
    LRCLIB match may re-anchor it. Mutates each pending dict in place,
    setting `reference_text` and `reference_offset_ms` (""/0.0 to keep the
    API's own timing).

    Three-stage consensus keeps repeated sections from collapsing (Lady Gaga
    'Disease' stacked four chorus lines at one instant) and stray ad-libs from
    teleporting (a 3-syllable "Ah-ah-ah" once matched a "ah ah ah" LRC line
    and dragged its anchor 5 seconds away):

    1. Candidate runs need >= 2 words and must cover most of the item's sung
       words (ratio gate) — a lone "ah" can never anchor into a longer line.
    2. The track's DOMINANT re-anchoring offset is computed from all
       candidates (histogram over 100ms buckets, weighted by run length);
       outliers beyond +/-150ms are rejected outright. When the API clock is
       offset, every honest match agrees on the correction; coincidences do
       not.
    3. Survivors claim their word positions, each taking the free occurrence
       whose offset best matches the dominant one — so repeated choruses map
       onto their own performances in song order, and an item whose text is
       exhausted in the LRC (11 staggered "Ah-ah" ad-libs, one LRC line)
       keeps its own correctly staggered timing instead of borrowing a used
       occurrence.

    When NO consistent offset exists (the matches disagree wildly), no item
    is re-anchored at all: the offset business only makes sense when the two
    sources share a common clock, and forcing per-item anchors in that case
    is what scattered chorus lines across the timeline in the first place.
    """
    for item in pending:
        syl_words = item["syl_words"]
        item["reference_text"] = ""
        item["reference_offset_ms"] = 0.0
        item["candidates"] = []
        n = len(syl_words)
        if n < 2:
            continue  # single-word items: too weak to anchor safely
        min_run = max(2, math.ceil(0.6 * n))
        for matched, start_idx in _find_lrclib_runs(syl_words, occurrences):
            if matched < min_run or not (0.4 <= matched / n <= 1.4):
                continue
            first_line = occurrences[start_idx][2]
            raw_start = lrc_lines[first_line].get("startTimeMs")
            if raw_start is None:
                continue
            # EVERY occurrence is a candidate, not just the first: a repeated
            # chorus legitimately matches its own performance further down the
            # LRC, and keeping only the first match here is what forced both
            # performances onto the first chorus's timestamp. The consensus in
            # stage 2 then separates the honest candidates (which all agree on
            # one clock offset) from coincidences.
            item["candidates"].append((matched, float(raw_start)))

    # Dominant offset: 100ms buckets, weighted by matched word count.
    buckets: dict[int, tuple[int, float]] = {}  # bucket -> (weight, offset sum)
    for item in pending:
        for matched, raw_start in item["candidates"]:
            off = raw_start - item["s_time"]
            b = int(round(off / 100.0))
            w, s = buckets.get(b, (0, 0.0))
            buckets[b] = (w + matched, s + off * matched)
    if not buckets:
        return
    best_b = max(buckets, key=lambda b: buckets[b][0])
    dominant = buckets[best_b][1] / buckets[best_b][0]

    # Consistency gate: the dominant bucket must actually speak for the
    # items. Scoring is per ITEM, not per candidate: repeated text legitimately
    # supplies a second candidate at another occurrence, so counting those as
    # disagreement would veto exactly the repeated choruses this plan exists to
    # fix. An item whose best candidate sits within tolerance of the dominant
    # offset is honest; one whose every candidate is far from it is a
    # coincidence (a stray ad-lib). (Weight = the item's longest match, so one
    # long line cannot be outvoted by many weak ones, but a broad disagreement
    # still vetoes.)
    total_weight = 0
    agreeing = 0
    for item in pending:
        best_w = 0
        agree_w = 0
        for matched, raw_start in item["candidates"]:
            best_w = max(best_w, matched)
            if abs((raw_start - item["s_time"]) - dominant) <= LRCLIB_OFFSET_TOLERANCE_MS:
                agree_w = max(agree_w, matched)
        total_weight += best_w
        agreeing += agree_w
    if total_weight <= 0 or agreeing < 0.6 * total_weight:
        return  # no trustworthy common offset: keep everyone's native times

    claimed: set[int] = set()
    for item in pending:  # song order (pending is built in order)
        if not item["candidates"]:
            continue
        n = len(item["syl_words"])
        min_run = max(2, math.ceil(0.6 * n))
        best = None  # (matched, -|off - dominant|, start_idx)
        for matched, start_idx in _find_lrclib_runs(item["syl_words"], occurrences, claimed):
            if matched < min_run or not (0.4 <= matched / n <= 1.4):
                continue
            first_line = occurrences[start_idx][2]
            raw_start = lrc_lines[first_line].get("startTimeMs")
            if raw_start is None:
                continue
            off = float(raw_start) - item["s_time"]
            if abs(off - dominant) > LRCLIB_OFFSET_TOLERANCE_MS:
                continue
            score = (matched, -abs(off - dominant), start_idx)
            if best is None or score > best:
                best = score
        if not best:
            continue  # nothing trustworthy: keep the API's own timing
        matched, _neg, start_idx = best
        for k in range(start_idx, start_idx + matched):
            claimed.add(k)
        first_line = occurrences[start_idx][2]
        item["reference_text"] = " ".join(
            occurrences[k][1] for k in range(start_idx, start_idx + matched))
        item["reference_offset_ms"] = float(lrc_lines[first_line].get("startTimeMs")) - item["s_time"]


def merge_lrclib_text(syllables: list[dict], lrc_lines: list[dict]) -> tuple[str, float | None]:
    """
    Stateless single-item match: finds the LRCLIB words matching these
    syllables and returns (text, matched_start_ms), or ("", None).

    The returned timestamp is the matched line's own start — the honest global
    position of the syllables. NOTE: this is the single-item primitive only.
    The parse pipeline uses _lrclib_reference_plan instead, because repeated
    choruses occur at several timestamps and only the track-wide consensus
    plan can give each performance its own occurrence.
    """
    if not lrc_lines:
        return "", None
    occurrences = _flatten_lrclib(lrc_lines)
    syl_words = [w for s in syllables
                 for w, _raw in _match_tokens(clean_syllable_text(s["rawText"]))]
    best = _match_lrclib_run(syl_words, occurrences)
    if not best:
        return "", None
    matched, start_idx = best
    first_line = occurrences[start_idx][2]
    text = " ".join(occurrences[k][1] for k in range(start_idx, start_idx + matched))
    matched_start = lrc_lines[first_line].get("startTimeMs")
    return text, (float(matched_start) if matched_start is not None else None)


def _lrclib_line_metrics(line: dict) -> tuple[float, float, float, int] | None:
    """
    Per-line musical metrics for the timing model: (mean inter-onset interval,
    syllables per second, energy 0.5–1.15, syllable count). Energy rises when
    the line's pulse sits near the 150-BPM sweet spot and when nearly every
    word in the text is actually sung (dense, drum-like delivery); it drops
    for sparse lines that are mostly long held notes.
    """
    sylls = [s for w in (line.get("words") or []) for s in (w.get("syllables") or [])]
    if len(sylls) < 2:
        return None
    span_ms = (line.get("endTimeMs") or 0) - (line.get("startTimeMs") or 0)
    if span_ms <= 0:
        return None

    intervals = [
        b["startTimeMs"] - a["startTimeMs"]
        for a, b in zip(sylls, sylls[1:])
        if 80.0 <= b["startTimeMs"] - a["startTimeMs"] <= 2500.0
    ]
    if not intervals:
        return None
    mean_ioi = sum(intervals) / len(intervals)
    density = len(sylls) / (span_ms / 1000.0)

    # Tempo score: peaks when the mean onset interval matches the musical
    # middle of our 187–800ms window (~400ms ≈ 150 BPM), decaying either side.
    tempo_score = max(0.0, 1.0 - abs(math.log2(max(mean_ioi, 1.0) / 400.0)))
    # Vocal ratio: sung syllables per written word. ~1.0–1.6 is ordinary
    # singing; a line whose text has many more words than sung syllables is
    # probably spammy metadata, not melody.
    written = max(1, len((line.get("text") or "").split()))
    vocal_ratio = min(1.0, len(sylls) / written)
    energy = max(0.5, min(1.15, 0.45 + 0.30 * tempo_score + 0.35 * vocal_ratio))
    return mean_ioi, density, energy, len(sylls)


def _lrclib_track_metrics(lines: list[dict]) -> tuple[float, float, float]:
    """
    Track-level (mean IoI, density, energy), taken from the lyric-densest
    line that produced metrics — the busiest line carries the beat; quiet
    bridges would drag the estimate toward held notes and silence.
    """
    best = None
    for line in lines:
        m = _lrclib_line_metrics(line)
        if m and (best is None or m[3] > best[3]):
            best = m
    if best is None:
        return 400.0, 2.5, 1.0
    return best[0], best[1], best[2]


def _lrclib_syllable_is_stressed(sylls: list[dict], i: int) -> bool:
    """
    Prosodic stress heuristic for timing distribution. Strong beats attract
    longer sung vowels, so multi-vowel syllables (diphthongs, '-y' endings)
    and monosyllabic content words take the beat; grammatical glue ('a',
    'the', 'of') is rushed. Word-final syllables of multi-syllable words are
    also lightly favoured — English stresses the root, but releases the tail.
    """
    txt = clean_syllable_text(sylls[i].get("rawText") or sylls[i].get("text") or "")
    low = re.sub(r"[^\w']", "", txt).lower()
    if not low:
        return False
    FUNCTION_WORDS = {
        "a", "an", "the", "of", "to", "in", "on", "at", "it", "is", "as",
        "and", "or", "but", "so", "my", "me", "i", "you", "your",
    }
    if low in FUNCTION_WORDS:
        return False
    if _syllable_vowels(low) >= 2:
        return True
    # Word-final release: the syllable ends a word (trailing space in the raw
    # stream) and is not the line's very first syllable.
    if i > 0 and (txt.endswith(" ") or txt.endswith("\t")):
        return True
    return False


def enrich_lrclib_word_timings(lines: list[dict]) -> None:
    """
    Turns line-synced LRCLIB timings into singable word timings (in place).

    LRC marks only when each LINE starts; without this, word fills would just
    divide the line evenly and every word would scroll at the same robotic
    pace. The model distributes each line's singing window over its syllables:

      1. Tempo: the track's mean inter-onset interval M (from real timestamps,
         80–2500ms band) sets the natural pulse of one sung syllable.
      2. Density: the busiest line's syllables-per-second D scales that pulse —
        a rapid-fire delivery compresses every syllable toward M*D, a sparse
        ballad stretches it.
      3. Energy: a 0.5–1.15 factor blends the tempo score (pulse near the
         ~150-BPM sweet spot) with the sung-to-written ratio, so drum-like
         dense lines get punchy syllables and airy lines get long, lazy ones.
      4. Stress: metrically strong syllables (multi-vowel, content words,
         word-final releases) get M·D·energy each; grammatical glue gets the
         remainder, so 'extraordinary' eats the beat while 'in the' rushes by.

    Everything is normalized to the line's actual window (capped so a long
    instrumental tail never smears the last words), keeping the total honest.
    """
    if not lines:
        return
    g_ioi, g_density, g_energy = _lrclib_track_metrics(lines)

    for line in lines:
        words = line.get("words") or []
        sylls = [s for w in words for s in (w.get("syllables") or [])]
        if len(sylls) < 2:
            continue

        start = float(line.get("startTimeMs") or 0)
        # Line's own pulse, falling back to the track's.
        m = _lrclib_line_metrics(line)
        line_ioi, line_density, line_energy = (m[0], m[1], m[2]) if m else (g_ioi, g_density, g_energy)

        # Singing window: from the first onset to the line's end, but a word
        # never sings into a long instrumental tail — cap the window at what
        # n syllables of this line's own pulse could plausibly occupy.
        raw_end = float(line.get("endTimeMs") or 0)
        cap = max(1200.0, len(sylls) * line_ioi * LINE_TAIL_FACTOR)
        window = min(raw_end - start, cap, MAX_LINE_TAIL_MS)
        if window <= 0:
            continue

        stressed = [i for i in range(len(sylls)) if _lrclib_syllable_is_stressed(sylls, i)]
        k = max(0.75, min(1.6, line_density * line_energy))

        # Weight model: stressed syllables weigh 1.35·k, weak ones 1.0.
        # Normalizing keeps the total pinned to the real window; the cap
        # below stops a stress-heavy line from starving its glue words.
        stress_w = 1.35 * k
        ns = len(stressed)
        nw = len(sylls) - ns
        total_weight = ns * stress_w + nw
        if total_weight <= 0:
            continue
        base = window / total_weight
        stressed_dur = stress_w * base
        if ns and stressed_dur > 0.9 * window / ns:
            stressed_dur = 0.9 * window / ns
            base = (window - ns * stressed_dur) / max(1, nw)

        durations = []
        for i in range(len(sylls)):
            durations.append(stressed_dur if i in stressed else max(120.0, base))

        # Write back, keeping the last syllable's end at the window's edge.
        cur = sylls[0]["startTimeMs"]
        for i, s in enumerate(sylls):
            s["startTimeMs"] = cur
            cur += durations[i]
            s["endTimeMs"] = cur
            s["isExtended"] = (durations[i] >= 550.0)
        sylls[-1]["endTimeMs"] = max(sylls[-1]["endTimeMs"], start + window)
        line["endTimeMs"] = max(raw_end, sylls[-1]["endTimeMs"])
        # Word envelopes must track their rewritten syllables, or any consumer
        # reading word-level times sees the old full-line span.
        for w in words:
            ws = w.get("syllables") or []
            if ws:
                w["startTimeMs"] = ws[0]["startTimeMs"]
                w["endTimeMs"] = ws[-1]["endTimeMs"]


def fallback_segment_syllables(syllables: list[dict]) -> list[dict]:
    if not syllables:
        return []

    words = []
    curr_group = []

    for i, s in enumerate(syllables):
        raw = s["rawText"]
        txt = clean_syllable_text(raw)
        s_obj = {
            "text": txt,
            "raw": raw,
            "startTimeMs": s["startTimeMs"],
            "endTimeMs": s["endTimeMs"],
            "isExtended": (s["endTimeMs"] - s["startTimeMs"]) >= 550.0,
            "letters": s.get("letters"),
        }
        curr_group.append(s_obj)

        is_boundary = False
        if raw.endswith(" ") or raw.endswith("\t"):
            is_boundary = True
        elif i == len(syllables) - 1:
            is_boundary = True
        elif s.get("isPartOfWord") is not None:
            # Explicit API flag again: mid-word syllables never start a new word.
            is_boundary = not s["isPartOfWord"]
        else:
            next_s = syllables[i + 1]
            next_raw = next_s["rawText"].strip().lower()
            accum = "".join(item["text"] for item in curr_group).lower()
            combined = accum + next_raw

            if raw.endswith("-"):
                is_boundary = False
            elif any(next_raw.startswith(c) for c in COMMON_CONTRACTIONS):
                is_boundary = False
            elif combined in COMMON_SPLIT_WORDS:
                is_boundary = False
            elif (next_s["startTimeMs"] - s["endTimeMs"]) > 220.0:
                is_boundary = True
            elif re.search(r"[.,!?;:]$", txt):
                is_boundary = True
            else:
                is_boundary = True

        if is_boundary:
            words.append(build_word(curr_group))
            curr_group = []

    return words


def detect_is_seconds(content: list[dict]) -> bool:
    max_ts = 0.0
    durations = []

    for item in content:
        # External API data: every level is treated as untrusted. A single
        # non-dict element used to raise out of here and, via the SMTC loop,
        # strand the track on its loading spinner.
        if not isinstance(item, dict):
            continue
        lead = item.get("Lead") or item.get("lead")
        if not isinstance(lead, dict):
            lead = {}
        sylls = (
            lead.get("Syllables") or lead.get("syllables") or
            item.get("Syllables") or item.get("syllables") or
            lead.get("Words") or lead.get("words") or
            item.get("Words") or item.get("words") or []
        )
        if not isinstance(sylls, list):
            sylls = []
        for s in sylls:
            if not isinstance(s, dict):
                continue
            st = float(s.get("StartTime") or s.get("startTime") or 0)
            et = float(s.get("EndTime") or s.get("endTime") or st)
            max_ts = max(max_ts, st, et)
            if et > st:
                durations.append(et - st)

        i_st = float(item.get("StartTime") or item.get("startTime") or lead.get("StartTime") or lead.get("startTime") or 0)
        i_et = float(item.get("EndTime") or item.get("endTime") or lead.get("EndTime") or lead.get("endTime") or i_st)
        max_ts = max(max_ts, i_st, i_et)
        if i_et > i_st:
            durations.append(i_et - i_st)

    # The syllable DURATION is the real tell, and it is scale-invariant: a sung
    # syllable lasts a fraction of a second, whether the timestamp says 0.42 or
    # 420. The old pre-check (`max_ts > 1800 => milliseconds`) also assumed a
    # maximum track length of 30 minutes, which silently misread hour-long DJ
    # sets and ambient mixes as millisecond timestamps and compressed them into
    # about two seconds of screen time.
    if durations:
        median_dur = sorted(durations)[len(durations) // 2]
        return median_dur < 15.0

    # No measurable durations (sparse payload): fall back to the total span. A
    # seconds-denominated span over a whole song is comfortably above 5 seconds
    # only for very short audio, so anything beyond 5 total seconds is ms.
    return 0 < max_ts < 5000.0


def _extract_vocal_tracks(item: dict) -> list[tuple[dict, bool]]:
    """
    Extracts both Lead and Background vocal streams from an API item
    so backing lyrics (like 'It's gonna feel so good') are never dropped.
    """
    tracks = []
    lead = item.get("Lead") or item.get("lead")
    if lead and isinstance(lead, dict):
        tracks.append((lead, False))
    elif not lead:
        tracks.append((item, False))

    bg = (
        item.get("Background") or item.get("background") or
        item.get("Backgrounds") or item.get("backgrounds") or
        (lead.get("Background") if isinstance(lead, dict) else None) or
        (lead.get("background") if isinstance(lead, dict) else None)
    )
    if bg:
        if isinstance(bg, list):
            for b_item in bg:
                if isinstance(b_item, dict):
                    tracks.append((b_item, True))
        elif isinstance(bg, dict):
            tracks.append((bg, True))

    return tracks


def parse_spicy_body(body: dict, lrclib_lines: list[dict] = None) -> tuple[list[dict], int]:
    if not isinstance(body, dict):
        return [], 0

    content = body.get("Content") or body.get("content") or []
    body_lines = body.get("Lines") or body.get("lines") or []
    if not content and body_lines:
        content = body_lines

    if not isinstance(content, list) or not content:
        return [], 0

    is_seconds = detect_is_seconds(content)
    total_syllables_found = 0
    parsed_lines = []

    # Flattened LRCLIB word stream, shared across all items.
    lrclib_occurrences = _flatten_lrclib(lrclib_lines) if lrclib_lines else []
    # Path-2 items are buffered here and resolved by a two-pass consensus
    # plan BEFORE any line dict is built: every item proposes its best LRC
    # match, the dominant re-anchoring offset is agreed on track-wide, then
    # each item claims a free occurrence consistent with that offset.
    pending_path2: list[dict] = []

    for item in content:
        if not isinstance(item, dict):
            continue
        vocal_tracks = _extract_vocal_tracks(item)
        fallback_item_start = float(item.get("StartTime") or item.get("startTime") or 0) * (1000.0 if is_seconds else 1.0)
        fallback_item_end = float(item.get("EndTime") or item.get("endTime") or 0) * (1000.0 if is_seconds else 1.0)

        for track_obj, is_bg_default in vocal_tracks:
            raw_words_native = track_obj.get("Words") or track_obj.get("words")
            raw_syllables = track_obj.get("Syllables") or track_obj.get("syllables") or []

            raw_s = track_obj.get("StartTime") or track_obj.get("startTime")
            if (raw_s is None or float(raw_s) == 0) and isinstance(raw_syllables, list):
                first_syl = next((s for s in raw_syllables if isinstance(s, dict)), None)
                if first_syl is not None:
                    raw_s = first_syl.get("StartTime") or first_syl.get("startTime")
            if raw_s is None:
                s_time = fallback_item_start
            else:
                s_time = float(raw_s) * (1000.0 if is_seconds else 1.0)

            is_bg = is_bg_default or bool(
                track_obj.get("IsBackground") or track_obj.get("isBackground") or
                track_obj.get("OppositeAlign") or track_obj.get("oppositeAlign")
            )

            # Translation/transliteration are lead-vocal metadata; background echoes ignore them.
            translation, transliteration = (None, None) if is_bg else _extract_text_fields(track_obj)

            # Path 1: Native Words structure
            if raw_words_native and isinstance(raw_words_native, list) and len(raw_words_native) > 0:
                words = []
                for w in raw_words_native:
                    if not isinstance(w, dict):
                        continue
                    w_sylls = w.get("Syllables") or w.get("syllables") or []
                    if not isinstance(w_sylls, list):
                        w_sylls = []
                    clean_s_list = []
                    if w_sylls:
                        for s in w_sylls:
                            if not isinstance(s, dict):
                                continue
                            st = float(s.get("StartTime") or s.get("startTime") or 0) * (1000.0 if is_seconds else 1.0)
                            et = float(s.get("EndTime") or s.get("endTime") or 0) * (1000.0 if is_seconds else 1.0)
                            if et <= st:
                                et = st + 350.0
                            clean_s_list.append({
                                "text": clean_syllable_text(s.get("Text") or s.get("text") or s.get("word") or ""),
                                "raw": (s.get("Text") or s.get("text") or s.get("word") or ""),
                                "startTimeMs": st,
                                "endTimeMs": et,
                                "isExtended": (et - st) >= 550.0,
                                "letters": _extract_letters(s, is_seconds),
                            })
                            total_syllables_found += 1
                    else:
                        st = float(w.get("StartTime") or w.get("startTime") or 0) * (1000.0 if is_seconds else 1.0)
                        et = float(w.get("EndTime") or w.get("endTime") or 0) * (1000.0 if is_seconds else 1.0)
                        if et <= st:
                            et = st + 350.0
                        clean_s_list.append({
                            "text": clean_syllable_text(w.get("Text") or w.get("text") or w.get("word") or ""),
                            "raw": (w.get("Text") or w.get("text") or w.get("word") or ""),
                            "startTimeMs": st,
                            "endTimeMs": et,
                            "isExtended": (et - st) >= 550.0,
                            "letters": _extract_letters(w, is_seconds),
                        })
                        total_syllables_found += 1

                    words.append(build_word(clean_s_list))

                e_time = words[-1]["endTimeMs"] if words else s_time + 4000.0
                line_plain = " ".join(w["text"] for w in words)
                parsed_lines.append({
                    "startTimeMs": s_time,
                    "endTimeMs": e_time,
                    "text": line_plain,
                    "words": words,
                    "isBackground": is_bg or is_backing_vocal_text(line_plain),
                    "translation": translation,
                    "transliteration": transliteration,
                })
                continue

            # Path 2: Flat Syllables
            clean_syllables = []
            has_trailing_spaces = False
            if raw_syllables and isinstance(raw_syllables, list):
                for s in raw_syllables:
                    if not isinstance(s, dict):
                        continue
                    txt = s.get("Text") or s.get("text") or ""
                    if txt.endswith(" ") or txt.endswith("\t"):
                        has_trailing_spaces = True
                    s_start = float(s.get("StartTime") or s.get("startTime") or 0) * (1000.0 if is_seconds else 1.0)
                    s_end = float(s.get("EndTime") or s.get("endTime") or 0) * (1000.0 if is_seconds else 1.0)
                    if s_end <= s_start:
                        s_end = s_start + 350.0

                    clean_syllables.append({
                        "rawText": txt,
                        "startTimeMs": s_start,
                        "endTimeMs": s_end,
                        "letters": _extract_letters(s, is_seconds),
                        # Explicit word-boundary signal from the API; None when absent.
                        "isPartOfWord": (
                            bool(s["IsPartOfWord"]) if "IsPartOfWord" in s else
                            bool(s["isPartOfWord"]) if "isPartOfWord" in s else
                            None
                        ),
                    })
                    total_syllables_found += 1

            reference_text = (
                track_obj.get("Text") or track_obj.get("text") or ""
            ).strip()
            has_own_text = bool(reference_text)

            # Buffered: the consensus plan (below) decides re-anchoring for
            # ALL items before any of them builds words — per-item greedy
            # matching cannot distinguish a clock offset from a different
            # performance of the same words.
            pending_path2.append({
                "track_obj": track_obj,
                "clean_syllables": clean_syllables,
                "has_trailing_spaces": has_trailing_spaces,
                "own_text": reference_text,
                "has_own_text": has_own_text,
                "s_time": s_time,
                "is_bg": is_bg,
                "translation": translation,
                "transliteration": transliteration,
                "reference_text": "",
                "reference_offset_ms": 0.0,
                "syl_words": [
                    w for s in clean_syllables
                    for w, _raw in _match_tokens(clean_syllable_text(s["rawText"]))
                ],
            })

    if lrclib_occurrences and pending_path2:
        _lrclib_reference_plan(pending_path2, lrclib_occurrences, lrclib_lines)

    for item in pending_path2:
        clean_syllables = item["clean_syllables"]
        s_time = item["s_time"]
        # An item that carried its OWN reference text keeps it verbatim —
        # LRC-matched text is only for items that had none, and the plan has
        # already decided their re-anchoring.
        reference_text = item["own_text"] or item["reference_text"]
        reference_offset_ms = 0.0 if item["has_own_text"] else item["reference_offset_ms"]

        # The offset shift is applied to the RAW SYLLABLES up front so
        # every downstream path (reference alignment, trailing-space
        # segmentation, line end) sees the re-anchored clock. Shifting
        # only s_time afterwards left the trailing-space path's word
        # times on the item-local clock while the line reported the
        # global one — its end times ran 10s+ past every neighbour.
        if reference_offset_ms:
            s_time += reference_offset_ms
            for s in clean_syllables:
                s["startTimeMs"] += reference_offset_ms
                s["endTimeMs"] += reference_offset_ms
                # Letter timings ride the same clock; leaving them on the
                # item-local clock made per-letter reveal drift by the offset.
                for letter in (s.get("letters") or []):
                    letter["startTimeMs"] += reference_offset_ms
                    letter["endTimeMs"] += reference_offset_ms

        if item["has_trailing_spaces"]:
            words = fallback_segment_syllables(clean_syllables)
        elif reference_text:
            words = align_syllables_to_reference(clean_syllables, reference_text)
            if not words:
                words = fallback_segment_syllables(clean_syllables)
        else:
            words = fallback_segment_syllables(clean_syllables)

        e_time = clean_syllables[-1]["endTimeMs"] if clean_syllables else s_time + 4000.0
        if e_time <= s_time:
            e_time = s_time + 4000.0

        line_plain_text = reference_text if reference_text else " ".join(w["text"] for w in words)

        parsed_lines.append({
            "startTimeMs": s_time,
            "endTimeMs": e_time,
            "text": line_plain_text,
            "words": words,
            "isBackground": item["is_bg"] or is_backing_vocal_text(line_plain_text),
            "translation": item["translation"],
            "transliteration": item["transliteration"],
        })

    parsed_lines.sort(key=lambda x: x["startTimeMs"])
    return parsed_lines, total_syllables_found


def parse_lrc(lrc_text: str) -> list[dict]:
    pattern = re.compile(r'\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)')
    parsed = []
    for line in lrc_text.strip().split('\n'):
        match = pattern.match(line.strip())
        if match:
            m, s, ms_str, text = match.groups()
            ms = int(m) * 60000 + int(s) * 1000 + int(ms_str) * (10 if len(ms_str) == 2 else 1)
            clean_txt = text.strip()
            if clean_txt and not clean_txt.startswith("Chorus") and not clean_txt.startswith("Verse"):
                parsed.append((ms, clean_txt))

    result = []
    for i in range(len(parsed)):
        start, text = parsed[i]
        end = parsed[i + 1][0] if i + 1 < len(parsed) else start + 4500
        # One syllable per written word: enrich_lrclib_word_timings then
        # redistributes the line's window over them musically. The UI uses
        # these directly when present instead of its naive even split.
        tokens = text.split()
        words = [{
            "text": tok,
            "startTimeMs": start,
            "endTimeMs": end,
            "syllables": [{
                "text": tok,
                "startTimeMs": start,
                "endTimeMs": end,
                "isExtended": (end - start) >= 550.0,
            }],
        } for tok in tokens]
        result.append({
            "startTimeMs": start,
            "endTimeMs": end,
            "text": text,
            "words": words,
            "isBackground": is_backing_vocal_text(text)
        })

    enrich_lrclib_word_timings(result)
    return result