import unittest

from core.ttml import parse_time, parse_ttml


def _doc(body: str, head: str = "", root_attrs: str = "") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<tt xmlns="http://www.w3.org/ns/ttml" '
        'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" '
        'xmlns:itunes="http://itunes.apple.com/lyric-ttml-extensions" '
        'xmlns:amll="http://www.example.com/ns/amll" ' + root_attrs + '>'
        f'<head><metadata>{head}</metadata></head>'
        f'<body>{body}</body>'
        '</tt>'
    )


WORD_DOC = _doc(
    root_attrs='xml:lang="en" itunes:timing="Word"',
    head=(
        '<ttm:title>Ode To The Mets</ttm:title>'
        '<ttm:agent type="person" xml:id="v1"><ttm:name type="full">The Strokes</ttm:name></ttm:agent>'
        '<ttm:agent type="group" xml:id="v1000" />'
    ),
    body=(
        '<div itunes:song-part="Verse">'
        '<p begin="00:01.000" end="00:03.500" itunes:key="L1" ttm:agent="v1">'
        '<span begin="00:01.000" end="00:01.800">Gold </span>'
        '<span begin="00:01.800" end="00:02.600">jewelry </span>'
        '<span begin="00:02.600" end="00:03.500">shining</span>'
        '</p>'
        '</div>'
    ),
)


class ParseTimeTest(unittest.TestCase):
    """Every time-expression form the Apple/AMLL dialect and TTML1 allow."""

    def test_clock_times(self):
        self.assertEqual(parse_time("00:02:35.500"), 155_500)
        self.assertEqual(parse_time("00:02:35.5"), 155_500)
        self.assertEqual(parse_time("02:35.55"), 155_550)
        self.assertEqual(parse_time("02:35"), 155_000)
        self.assertEqual(parse_time("35.123"), 35_123)

    def test_bare_seconds_may_exceed_sixty(self):
        # With no colon the dialect treats the value as seconds outright.
        self.assertEqual(parse_time("95"), 95_000)
        self.assertEqual(parse_time("0.5"), 500)

    def test_offset_times(self):
        self.assertEqual(parse_time("15.8s"), 15_800)
        self.assertEqual(parse_time("500ms"), 500)
        self.assertEqual(parse_time("2m"), 120_000)
        self.assertEqual(parse_time("1h"), 3_600_000)

    def test_frames_use_the_document_frame_rate(self):
        self.assertEqual(parse_time("00:00:01:15"), 1_500)
        self.assertEqual(parse_time("00:00:01:15", frame_rate=60), 1_250)

    def test_invalid_and_negative_values(self):
        self.assertIsNone(parse_time("junk"))
        self.assertIsNone(parse_time(""))
        self.assertIsNone(parse_time(None))
        self.assertIsNone(parse_time("1:2:3:4:5"))
        self.assertEqual(parse_time("-5"), 0)


class WordTimedTest(unittest.TestCase):
    """`itunes:timing="Word"`: one span per syllable, spaces are significant."""

    def setUp(self):
        self.lines, self.meta = parse_ttml(WORD_DOC)

    def test_lines_and_words(self):
        self.assertEqual(len(self.lines), 1)
        line = self.lines[0]
        self.assertEqual(line["text"], "Gold jewelry shining")
        self.assertEqual([w["text"] for w in line["words"]], ["Gold", "jewelry", "shining"])
        self.assertFalse(line["isBackground"])

    def test_each_word_keeps_its_own_timing(self):
        words = self.lines[0]["words"]
        self.assertEqual((words[0]["startTimeMs"], words[0]["endTimeMs"]), (1000, 1800))
        self.assertEqual((words[2]["startTimeMs"], words[2]["endTimeMs"]), (2600, 3500))
        self.assertEqual([s["text"] for s in words[1]["syllables"]], ["jewelry"])

    def test_metadata_is_read(self):
        self.assertEqual(self.meta["title"], "Ode To The Mets")
        self.assertEqual(self.meta["artist"], "The Strokes")   # v1000 is not a performer credit
        self.assertEqual(self.meta["timing"], "Word")
        self.assertEqual(self.meta["lang"], "en")
        self.assertEqual(self.meta["error"], "")

    def test_separate_syllables_join_into_one_word(self):
        # 'ne' + 'ver ' is one word: the trailing space marks the boundary, and
        # the app's grouping heuristic reads exactly that.
        lines, _meta = parse_ttml(_doc(
            '<p begin="1.0" end="3.0"><span begin="1.0" end="2.0">ne</span>'
            '<span begin="2.0" end="3.0">ver </span></p>'))
        self.assertEqual([w["text"] for w in lines[0]["words"]], ["never"])
        self.assertEqual(len(lines[0]["words"][0]["syllables"]), 2)

    def test_space_only_span_and_text_node_both_separate_words(self):
        lines, _meta = parse_ttml(_doc(
            '<p begin="1.0" end="4.0">'
            '<span begin="1.0" end="2.0">one</span>'
            '<span begin="2.0" end="2.0"> </span>'
            '<span begin="2.0" end="3.0">two</span>'
            '<span begin="3.0" end="4.0">three</span></p>'))
        self.assertEqual([w["text"] for w in lines[0]["words"]], ["one", "two", "three"])

    def test_phrase_span_is_split_into_words_with_distributed_time(self):
        lines, _meta = parse_ttml(_doc(
            '<p begin="0.0" end="4.0"><span begin="0.0" end="4.0">And the moonlight baby</span></p>'))
        words = lines[0]["words"]
        self.assertEqual([w["text"] for w in words], ["And", "the", "moonlight", "baby"])
        self.assertEqual(words[0]["startTimeMs"], 0)
        self.assertAlmostEqual(words[-1]["endTimeMs"], 4000, delta=1)
        # Longer words take larger slices; time never runs backwards.
        self.assertGreater(words[2]["endTimeMs"] - words[2]["startTimeMs"],
                           words[3]["endTimeMs"] - words[3]["startTimeMs"])
        self.assertGreater(words[3]["endTimeMs"] - words[3]["startTimeMs"],
                           words[0]["endTimeMs"] - words[0]["startTimeMs"])

    def test_nested_word_span_becomes_one_word_of_many_syllables(self):
        lines, _meta = parse_ttml(_doc(
            '<p begin="1.0" end="3.0"><span begin="1.0" end="3.0">'
            '<span begin="1.0" end="1.5">beau</span><span begin="1.5" end="2.4">ti</span>'
            '<span begin="2.4" end="3.0">ful</span></span></p>'))
        words = lines[0]["words"]
        self.assertEqual([w["text"] for w in words], ["beautiful"])
        self.assertEqual(len(words[0]["syllables"]), 3)
        self.assertEqual(words[0]["syllables"][1]["startTimeMs"], 1500)


class RoleTest(unittest.TestCase):
    """Translations, transliterations and background vocals."""

    def test_inline_translation_is_not_sung(self):
        lines, _meta = parse_ttml(_doc(
            '<p begin="1.0" end="3.0"><span begin="1.0" end="3.0">Hello </span>'
            '<span ttm:role="x-translation" xml:lang="fr">Bonjour</span></p>'))
        self.assertEqual(lines[0]["text"], "Hello")
        self.assertEqual([w["text"] for w in lines[0]["words"]], ["Hello"])
        self.assertEqual(lines[0]["translation"], "Bonjour")

    def test_romanization_lands_in_transliteration(self):
        lines, _meta = parse_ttml(_doc(
            '<p begin="1.0" end="3.0"><span begin="1.0" end="3.0">\u4f60\u597d </span>'
            '<span ttm:role="x-roman" xml:lang="zh-Latn">nihao</span></p>'))
        self.assertEqual(lines[0]["transliteration"], "nihao")

    def test_background_vocals_become_their_own_line(self):
        lines, _meta = parse_ttml(_doc(
            '<p begin="1.0" end="4.0"><span begin="1.0" end="2.0">Lead </span>'
            '<span begin="2.0" end="4.0">line</span>'
            '<span ttm:role="x-bg" begin="2.4" end="4.0">'
            '<span begin="2.4" end="3.2">(on </span><span begin="3.2" end="4.0">ice)</span>'
            '</span></p>'))
        self.assertEqual(len(lines), 2)
        self.assertFalse(lines[0]["isBackground"])
        bg = lines[1]
        self.assertTrue(bg["isBackground"])
        self.assertEqual(bg["text"], "(on ice)")
        self.assertEqual(bg["startTimeMs"], 2400)
        self.assertEqual([w["text"] for w in bg["words"]], ["(on", "ice)"])

    def test_header_translation_is_linked_by_line_key(self):
        lines, meta = parse_ttml(_doc(
            head='<ttm:title>T</ttm:title>'
                 '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">'
                 '<translations><translation type="subtitle" xml:lang="de">'
                 '<text for="L1">Goldschmuck</text></translation></translations>'
                 '</iTunesMetadata>',
            body='<p begin="1.0" end="2.0" itunes:key="L1">'
                 '<span begin="1.0" end="2.0">Gold </span></p>'
                 '<p begin="3.0" end="4.0" itunes:key="L2">'
                 '<span begin="3.0" end="4.0">Jewelry</span></p>'))
        self.assertEqual(lines[0]["translation"], "Goldschmuck")
        self.assertEqual(lines[1]["translation"], "")
        self.assertEqual(meta["translation_lang"], "de")

    def test_amll_metadata_and_duration(self):
        lines, meta = parse_ttml(_doc(
            root_attrs='itunes:timing="Line"',
            head='<amll:meta key="musicName" value="Skinwalkers IV"/>'
                 '<amll:meta key="artists" value="The Strokes"/>'
                 '<amll:meta key="artists" value="Guest"/>'
                 '<amll:meta key="album" value="The New Abnormal"/>'
                 '<amll:meta key="spotifyId" value="abc123"/>',
            body='<p begin="00:01.000" end="00:04.000">Hello there friend</p>'))
        self.assertEqual(meta["title"], "Skinwalkers IV")
        self.assertEqual(meta["artist"], "The Strokes, Guest")
        self.assertEqual(meta["album"], "The New Abnormal")
        self.assertEqual(meta["spotify_id"], "abc123")
        self.assertEqual(meta["duration_ms"], 4000)      # derived from the last line
        self.assertEqual(len(lines), 1)


class LineTimedTest(unittest.TestCase):
    """Line-level files still wipe word by word, on modelled timings."""

    def test_declared_line_timing_distributes_word_times(self):
        lines, meta = parse_ttml(_doc(
            root_attrs='itunes:timing="Line"',
            body='<p begin="00:01.000" end="00:04.000">And the moonlight baby lets you know</p>'))
        self.assertEqual(meta["timing"], "Line")
        words = lines[0]["words"]
        self.assertEqual(len(words), 7)
        # Every word sits inside the line's own window, in order.
        previous = 0
        for word in words:
            self.assertGreaterEqual(round(word["startTimeMs"], 3), 1000)
            self.assertLessEqual(round(word["endTimeMs"], 3), 4000)
            self.assertGreaterEqual(word["startTimeMs"], previous)
            previous = word["startTimeMs"]
        self.assertEqual(words[0]["startTimeMs"], 1000)
        self.assertAlmostEqual(words[-1]["endTimeMs"], 4000, places=3)

    def test_timing_is_inferred_from_the_content(self):
        lines, meta = parse_ttml(_doc(
            body='<p begin="1.0" end="2.0"><span begin="1.0" end="1.5">One </span>'
                 '<span begin="1.5" end="2.0">two</span></p>'))
        self.assertEqual(meta["timing"], "Word")
        self.assertFalse(lines[0]["words"][0]["syllables"][0]["isExtended"])


class RobustnessTest(unittest.TestCase):
    """A bad file must explain itself instead of raising."""

    def test_empty_document(self):
        for text in ("", "   ", None):
            lines, meta = parse_ttml(text)
            self.assertEqual(lines, [])
            self.assertEqual(meta["error"], "empty file")

    def test_malformed_xml(self):
        lines, meta = parse_ttml("<tt><body><p>x</p>")
        self.assertEqual(lines, [])
        self.assertIn("not valid XML", meta["error"])

    def test_wrong_root_element(self):
        lines, meta = parse_ttml("<html><body><p>hi</p></body></html>")
        self.assertEqual(lines, [])
        self.assertIn("not a TTML document", meta["error"])

    def test_no_lyric_lines(self):
        lines, meta = parse_ttml("<tt><body></body></tt>")
        self.assertEqual(lines, [])
        self.assertEqual(meta["error"], "no lyric lines found")

    def test_namespace_less_document_still_parses(self):
        lines, meta = parse_ttml(
            '<tt><head><metadata><ttm:title xmlns:ttm="http://www.w3.org/ns/ttml#metadata">'
            'Plain</ttm:title></metadata></head><body>'
            '<p begin="2.0" end="4.0"><span begin="2.0" end="4.0">Plain</span></p></body></tt>')
        self.assertEqual(meta["error"], "")
        self.assertEqual(meta["title"], "Plain")
        self.assertEqual(lines[0]["startTimeMs"], 2000)

    def test_parts_without_their_own_end_still_get_a_window(self):
        lines, _meta = parse_ttml(_doc(
            body='<p begin="1.0" end="4.0"><span begin="1.0">one </span>'
                 '<span begin="2.0">two </span><span begin="3.0">three</span></p>'))
        words = lines[0]["words"]
        self.assertEqual([w["text"] for w in words], ["one", "two", "three"])
        for word in words:
            self.assertGreater(word["endTimeMs"], word["startTimeMs"])
            for syllable in word["syllables"]:
                self.assertGreater(syllable["endTimeMs"], syllable["startTimeMs"])

    def test_empty_lines_are_skipped(self):
        lines, _meta = parse_ttml(_doc(
            body='<p begin="1.0" end="2.0"></p>'
                 '<p begin="3.0" end="4.0"><span begin="3.0" end="4.0">Real </span></p>'))
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["text"], "Real")

    def test_lines_are_sorted_by_time(self):
        lines, _meta = parse_ttml(_doc(
            body='<p begin="5.0" end="6.0"><span begin="5.0" end="6.0">Later</span></p>'
                 '<p begin="1.0" end="2.0"><span begin="1.0" end="2.0">Earlier</span></p>'))
        self.assertEqual([line["text"] for line in lines], ["Earlier", "Later"])


if __name__ == "__main__":
    unittest.main()
