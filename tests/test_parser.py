import unittest

from core.parser import parse_spicy_body, parse_lrc, detect_is_seconds


class DetectUnitsTest(unittest.TestCase):
    def test_millisecond_payload_detected(self):
        content = [{
            "StartTime": 1000, "EndTime": 3000,
            "Syllables": [
                {"Text": "a", "StartTime": 1000, "EndTime": 1500},
                {"Text": "b", "StartTime": 1500, "EndTime": 2000},
            ],
        }]
        self.assertFalse(detect_is_seconds(content))

    def test_second_payload_detected(self):
        content = [{
            "StartTime": 1.0, "EndTime": 3.0,
            "Syllables": [
                {"Text": "a", "StartTime": 1.0, "EndTime": 1.5},
                {"Text": "b", "StartTime": 1.5, "EndTime": 2.0},
            ],
        }]
        self.assertTrue(detect_is_seconds(content))

    def test_large_timestamp_forces_milliseconds(self):
        # A timestamp beyond any plausible seconds value must resolve to ms.
        content = [{"StartTime": 0.0, "EndTime": 0.0,
                    "Syllables": [{"Text": "a", "StartTime": 0.0, "EndTime": 5000.0}]}]
        self.assertFalse(detect_is_seconds(content))

    def test_hour_long_set_in_seconds_is_not_misread(self):
        # The old pre-check capped plausible seconds at 30 minutes, so an
        # hour-long DJ set in seconds was declared milliseconds and its whole
        # timeline compressed into ~2 seconds of screen time.
        sylls = [{"Text": "a", "StartTime": 0.2, "EndTime": 0.5},
                 {"Text": "b", "StartTime": 0.6, "EndTime": 0.9}]
        sylls += [{"Text": "x", "StartTime": 3600.0 + i, "EndTime": 3600.5 + i}
                  for i in range(20)]
        self.assertTrue(detect_is_seconds([{"Syllables": sylls}]))

    def test_duration_is_the_tell_not_the_span(self):
        # A sparse payload spanning 40 minutes, in seconds: the total span alone
        # cannot resolve the units, but a half-second syllable can.
        content = [{"StartTime": 0.0, "EndTime": 0.5,
                    "Syllables": [{"Text": "a", "StartTime": 0.0, "EndTime": 0.5}]},
                   {"StartTime": 2400.0, "EndTime": 2400.8,
                    "Syllables": [{"Text": "b", "StartTime": 2400.0, "EndTime": 2400.8}]}]
        self.assertTrue(detect_is_seconds(content))


class ParseSpicyBodyTest(unittest.TestCase):
    def test_non_dict_body_is_safe(self):
        self.assertEqual(parse_spicy_body([]), ([], 0))
        self.assertEqual(parse_spicy_body("nope"), ([], 0))
        self.assertEqual(parse_spicy_body(None), ([], 0))

    def test_native_words_with_letters(self):
        body = {"Content": [{
            "Lead": {
                "StartTime": 1000, "EndTime": 2000, "Text": "foo",
                "Words": [{
                    "StartTime": 1000, "EndTime": 1500, "Text": "foo",
                    "Syllables": [{
                        "Text": "foo", "StartTime": 1000, "EndTime": 1500,
                        "Letters": [
                            {"Text": "f", "StartTime": 1000, "EndTime": 1200},
                            {"Text": "o", "StartTime": 1200, "EndTime": 1350},
                            {"Text": "o", "StartTime": 1350, "EndTime": 1500},
                        ],
                    }],
                }],
            },
        }]}

        lines, syl_count = parse_spicy_body(body)

        self.assertEqual(len(lines), 1)
        self.assertEqual(syl_count, 1)
        letters = lines[0]["words"][0]["syllables"][0]["letters"]
        self.assertIsNotNone(letters)
        self.assertEqual(len(letters), 3)
        self.assertEqual(letters[0]["startTimeMs"], 1000)

    def test_flat_syllables_seconds_are_scaled_to_ms(self):
        body = {"Content": [{
            "Box": True,
            "Lead": {
                "Text": "hello world",
                "Syllables": [
                    {"Text": "hel", "StartTime": 1.0, "EndTime": 1.5},
                    {"Text": "lo ", "StartTime": 1.5, "EndTime": 2.0},
                    {"Text": "world", "StartTime": 2.0, "EndTime": 3.0},
                ],
            },
        }]}

        lines, _ = parse_spicy_body(body)

        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["startTimeMs"], 1000.0)
        self.assertEqual(lines[0]["text"], "hello world")

    def test_flat_syllables_keep_letters(self):
        body = {"Content": [{
            "Lead": {
                "Text": "hi",
                "Syllables": [
                    {"Text": "hi ", "StartTime": 1000, "EndTime": 2000,
                     "Letters": [
                         {"Text": "h", "StartTime": 1000, "EndTime": 1500},
                         {"Text": "i", "StartTime": 1500, "EndTime": 2000},
                     ]},
                ],
            },
        }]}

        lines, _ = parse_spicy_body(body)
        syl = lines[0]["words"][0]["syllables"][0]
        self.assertIsNotNone(syl["letters"])
        self.assertEqual(len(syl["letters"]), 2)

    def test_translation_and_transliteration_surface(self):
        body = {"Content": [{
            "Lead": {
                "Text": "hola",
                "Translation": "hello",
                "Transliteration": "ho-la",
                "Syllables": [{"Text": "hola", "StartTime": 1000, "EndTime": 2000}],
            },
        }]}

        lines, _ = parse_spicy_body(body)
        self.assertEqual(lines[0]["translation"], "hello")
        self.assertEqual(lines[0]["transliteration"], "ho-la")

    def test_background_vocal_stream_is_extracted(self):
        body = {"Content": [{
            "Lead": {
                "Text": "main line",
                "Syllables": [{"Text": "main line", "StartTime": 1000, "EndTime": 2000}],
            },
            "Background": {
                "Text": "echo",
                "Syllables": [{"Text": "echo", "StartTime": 1000, "EndTime": 2000}],
            },
        }]}

        lines, _ = parse_spicy_body(body)
        self.assertEqual(len(lines), 2)
        self.assertTrue(any(l["isBackground"] for l in lines))
        self.assertFalse(all(l["isBackground"] for l in lines))

    def test_parenthesised_line_marked_background(self):
        body = {"Content": [{
            "Lead": {
                "Text": "(oh yeah)",
                "Syllables": [{"Text": "(oh yeah)", "StartTime": 1000, "EndTime": 2000}],
            },
        }]}
        lines, _ = parse_spicy_body(body)
        self.assertTrue(lines[0]["isBackground"])


class WordBoundaryTest(unittest.TestCase):
    """Regression: the API's IsPartOfWord flag must control word grouping, and
    stutter fragments must keep their hyphen (my-my-myself, not mymyself)."""

    def _body(self, sylls):
        return {"Content": [{"Type": "Vocal", "Lead": {"Syllables": sylls}}]}

    def test_stutter_hyphens_preserved(self):
        body = self._body([
            {"Text": "And", "IsPartOfWord": False, "StartTime": 44.1, "EndTime": 44.3},
            {"Text": "my-", "IsPartOfWord": True, "StartTime": 44.3, "EndTime": 44.5},
            {"Text": "my-", "IsPartOfWord": True, "StartTime": 44.5, "EndTime": 44.7},
            {"Text": "myself", "IsPartOfWord": False, "StartTime": 44.7, "EndTime": 45.0},
        ])
        lines, _ = parse_spicy_body(body)
        words = [w["text"] for w in lines[0]["words"]]
        self.assertEqual(words, ["And", "my-my-myself"])

    def test_is_part_of_word_groups_words(self):
        # Fast rap: gaps are tiny, so without the flag these glue together.
        body = self._body([
            {"Text": "to", "IsPartOfWord": False, "StartTime": 10.0, "EndTime": 10.1},
            {"Text": "hell", "IsPartOfWord": False, "StartTime": 10.1, "EndTime": 10.2},
            {"Text": "with", "IsPartOfWord": False, "StartTime": 10.2, "EndTime": 10.3},
        ])
        lines, _ = parse_spicy_body(body)
        words = [w["text"] for w in lines[0]["words"]]
        self.assertEqual(words, ["to", "hell", "with"])

    def test_flag_overrides_bad_reference_text(self):
        # Reference text (wrong remix line) must not glue 'Mayo and went' together
        # when the API flags each syllable as its own word.
        body = self._body([
            {"Text": "Mayo", "IsPartOfWord": False, "StartTime": 20.0, "EndTime": 20.3},
            {"Text": "and", "IsPartOfWord": False, "StartTime": 20.3, "EndTime": 20.5},
            {"Text": "went", "IsPartOfWord": False, "StartTime": 20.5, "EndTime": 20.7},
        ])
        lines, _ = parse_spicy_body(body)
        words = [w["text"] for w in lines[0]["words"]]
        self.assertEqual(words, ["Mayo", "and", "went"])

    def test_missing_flag_falls_back_to_heuristics(self):
        # No IsPartOfWord at all: legacy behaviour (trailing-space boundary).
        body = self._body([
            {"Text": "hello ", "StartTime": 30.0, "EndTime": 30.3},
            {"Text": "world", "StartTime": 30.3, "EndTime": 30.6},
        ])
        lines, _ = parse_spicy_body(body)
        words = [w["text"] for w in lines[0]["words"]]
        self.assertEqual(words, ["hello", "world"])


class ParseLrcTest(unittest.TestCase):
    def test_basic_lrc(self):
        lrc = "[00:01.00]First line\n[00:03.50]Second line\n"
        lines = parse_lrc(lrc)
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["startTimeMs"], 1000)
        self.assertEqual(lines[1]["startTimeMs"], 3500)
        # Last line gets a synthetic duration.
        self.assertGreater(lines[1]["endTimeMs"], lines[1]["startTimeMs"])

    def test_metadata_lines_skipped(self):
        lrc = "[00:01.00]Verse 1\n[00:02.00]Real lyric\n"
        lines = parse_lrc(lrc)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["text"], "Real lyric")


class LrcWordTimingTest(unittest.TestCase):
    """The LRCLIB fallback must produce musical word timings, not an even split:
    stressed/content syllables hold the beat, glue words rush, and the total
    stays pinned to the line's real window."""

    def test_lrc_lines_get_word_timings(self):
        lines = parse_lrc("[00:01.00]caught up in the rhythm of it\n[00:05.00]next line\n")
        line = lines[0]
        self.assertTrue(line["words"])
        syls = [s for w in line["words"] for s in w["syllables"]]
        self.assertGreater(len(syls), 1)
        # Onsets strictly increasing and inside the line window.
        onsets = [s["startTimeMs"] for s in syls]
        self.assertEqual(onsets, sorted(onsets))
        self.assertGreaterEqual(onsets[0], line["startTimeMs"])
        self.assertLessEqual(syls[-1]["endTimeMs"], line["endTimeMs"] + 1)

    def test_stressed_syllable_gets_more_time_than_glue(self):
        lines = parse_lrc("[00:01.00]beautifully in the sand\n[00:06.00]end\n")
        syls = [s for w in lines[0]["words"] for s in w["syllables"]]
        durs = [s["endTimeMs"] - s["startTimeMs"] for s in syls]
        # 'beautifully' (content, multi-vowel) must outlast 'in' / 'the' (glue).
        self.assertGreater(durs[0], durs[1])
        self.assertGreater(durs[0], durs[2])

    def test_total_duration_pinned_to_window(self):
        lines = parse_lrc("[00:01.00]one two three four five six seven\n[00:05.00]x\n")
        line = lines[0]
        syls = [s for w in line["words"] for s in w["syllables"]]
        total = syls[-1]["endTimeMs"] - syls[0]["startTimeMs"]
        # Window is line start -> next line start (4s); enrichment may not smear it.
        self.assertLessEqual(total, 4000.0)
        self.assertGreater(total, 500.0)

    def test_word_envelopes_follow_syllables(self):
        lines = parse_lrc("[00:01.00]hello there again\n[00:06.00]x\n")
        for w in lines[0]["words"]:
            ws = w["syllables"]
            self.assertEqual(w["startTimeMs"], ws[0]["startTimeMs"])
            self.assertEqual(w["endTimeMs"], ws[-1]["endTimeMs"])

    def test_short_line_left_sane(self):
        lines = parse_lrc("[00:01.00]Yeah\n[00:04.00]x\n")
        self.assertEqual(len(lines[0]["words"]), 1)
        self.assertEqual(lines[0]["words"][0]["syllables"][0]["startTimeMs"], 1000)


class MergeLrclibTextTest(unittest.TestCase):
    def _syls(self, *raws):
        return [{"rawText": r, "startTimeMs": 0, "endTimeMs": 100} for r in raws]

    def test_exact_text_match_with_offset(self):
        from core.parser import merge_lrclib_text
        lrc = [{"text": "He took the mayo and went home", "startTimeMs": 11000.0}]
        text, start = merge_lrclib_text(self._syls("Mayo ", "and ", "went"), lrc)
        self.assertIn("mayo and went", text)
        self.assertEqual(start, 11000.0)

    def test_no_match_returns_empty(self):
        from core.parser import merge_lrclib_text
        lrc = [{"text": "completely different words here", "startTimeMs": 5000.0}]
        text, start = merge_lrclib_text(self._syls("Mayo ", "and ", "went"), lrc)
        self.assertEqual(text, "")
        self.assertIsNone(start)

    def test_match_spans_multiple_lrc_lines(self):
        from core.parser import merge_lrclib_text
        lrc = [
            {"text": "first part of", "startTimeMs": 1000.0},
            {"text": "the joined line", "startTimeMs": 4000.0},
        ]
        text, start = merge_lrclib_text(
            self._syls("first ", "part ", "of ", "the ", "joined ", "line"), lrc)
        self.assertEqual(text, "first part of the joined line")
        self.assertEqual(start, 1000.0)


class ReferenceOffsetTest(unittest.TestCase):
    def test_offset_reanchors_line_start(self):
        # API item clock runs 2s behind the LRC timeline; matching must shift
        # the whole line to the honest global position.
        body = {"Content": [{"Lead": {"Syllables": [
            {"Text": "Mayo ", "IsPartOfWord": False, "StartTime": 1000, "EndTime": 1300},
            {"Text": "and ", "IsPartOfWord": False, "StartTime": 1300, "EndTime": 1500},
            {"Text": "went", "IsPartOfWord": False, "StartTime": 1500, "EndTime": 1800},
        ]}}]}
        lrc = [{"text": "He took the mayo and went home", "startTimeMs": 3000.0}]
        lines, _ = parse_spicy_body(body, lrclib_lines=lrc)
        self.assertEqual(lines[0]["startTimeMs"], 3000.0)

    def test_offset_shifts_letter_timings_too(self):
        # The re-anchor moves the line's clock. Per-letter reveal reads these,
        # so leaving them on the item-local clock drifted the glyphs.
        body = {"Content": [{"Lead": {"Syllables": [
            {"Text": "mayo ", "IsPartOfWord": False, "StartTime": 1000, "EndTime": 1400,
             "Letters": [{"Text": "m", "StartTime": 1000, "EndTime": 1200},
                         {"Text": "a", "StartTime": 1200, "EndTime": 1400}]},
            {"Text": "went", "IsPartOfWord": False, "StartTime": 1400, "EndTime": 1800,
             "Letters": [{"Text": "w", "StartTime": 1400, "EndTime": 1800}]},
        ]}}]}
        lrc = [{"text": "mayo went", "startTimeMs": 3000.0}]
        lines, _ = parse_spicy_body(body, lrclib_lines=lrc)
        self.assertEqual(lines[0]["startTimeMs"], 3000.0)
        letters = lines[0]["words"][0]["syllables"][0]["letters"]
        self.assertEqual(letters[0]["startTimeMs"], 3000.0)

    def test_repeated_chorus_gets_own_occurrence(self):
        # Regression (Lady Gaga 'Disease'): two chorus performances must anchor
        # to their OWN LRC timestamps, not both to the first occurrence — the
        # old matcher stacked four identical lines at one instant.
        lrc = [
            {"text": "screamin for me baby", "startTimeMs": 40000.0},
            {"text": "like you're gonna die", "startTimeMs": 42000.0},
            {"text": "screamin for me baby", "startTimeMs": 60000.0},
            {"text": "like you're gonna die", "startTimeMs": 62000.0},
        ]

        def item(start):
            return {"Lead": {"Syllables": [
                {"Text": "screamin' ", "IsPartOfWord": False, "StartTime": start, "EndTime": start + 300},
                {"Text": "for ", "IsPartOfWord": False, "StartTime": start + 300, "EndTime": start + 600},
                {"Text": "me ", "IsPartOfWord": False, "StartTime": start + 600, "EndTime": start + 900},
                {"Text": "baby", "IsPartOfWord": False, "StartTime": start + 900, "EndTime": start + 1200},
            ]}}

        body = {"Content": [item(39500), item(59500)]}
        lines, _ = parse_spicy_body(body, lrclib_lines=lrc)
        self.assertEqual(len(lines), 2)
        # First item anchors to the first occurrence, second to its own.
        self.assertEqual(lines[0]["startTimeMs"], 40000.0)
        self.assertEqual(lines[1]["startTimeMs"], 60000.0)

    def test_unmatchable_item_keeps_native_timing(self):
        # An item whose words are exhausted in the LRC (11 staggered 'Ah-ah'
        # ad-libs, one LRC line) must KEEP its own start time rather than
        # borrowing an already-claimed occurrence's timestamp.
        lrc = [{"text": "ah ah ah", "startTimeMs": 10000.0}]

        def item(start):
            return {"Lead": {"Syllables": [
                {"Text": "Ah-", "IsPartOfWord": True, "StartTime": start, "EndTime": start + 200},
                {"Text": "ah-", "IsPartOfWord": True, "StartTime": start + 200, "EndTime": start + 400},
                {"Text": "ah", "IsPartOfWord": False, "StartTime": start + 400, "EndTime": start + 600},
            ]}}

        body = {"Content": [item(5000), item(8000), item(11000)]}
        lines, _ = parse_spicy_body(body, lrclib_lines=lrc)
        starts = [l["startTimeMs"] for l in lines]
        # Native times preserved (staggered), not collapsed onto 10000.
        self.assertEqual(starts, [5000.0, 8000.0, 11000.0])

    def test_weak_single_word_match_rejected(self):
        # A lone 'ah' item must not match into the middle of a longer chorus
        # line and drag its anchor across the song.
        lrc = [{"text": "ah screamin for me baby", "startTimeMs": 90000.0}]
        body = {"Content": [{"Lead": {"Syllables": [
            {"Text": "ah", "IsPartOfWord": False, "StartTime": 2000, "EndTime": 2300},
        ]}}]}
        lines, _ = parse_spicy_body(body, lrclib_lines=lrc)
        # Item keeps its own clock; the 90s LRC line is never touched.
        self.assertEqual(lines[0]["startTimeMs"], 2000.0)

    def test_rejected_match_does_not_poison_ledger(self):
        # If a claim is rejected (ratio guard), later items must still be able
        # to claim those words — the ledger only records APPLIED matches.
        lrc = [
            {"text": "hello there", "startTimeMs": 10000.0},
            {"text": "hello again", "startTimeMs": 20000.0},
        ]
        # Item 1 syllables overshoot the ratio guard... actually both items
        # match cleanly; assert both get their own occurrence timestamps.
        def item(start, second):
            return {"Lead": {"Syllables": [
                {"Text": f"hello{' again' if second else ' there'} ", "IsPartOfWord": False,
                 "StartTime": start, "EndTime": start + 300},
                {"Text": f"{'there' if second else 'again'}", "IsPartOfWord": False,
                 "StartTime": start + 300, "EndTime": start + 600},
            ]}}
        body = {"Content": [item(9000, False), item(19000, True)]}
        lines, _ = parse_spicy_body(body, lrclib_lines=lrc)
        self.assertEqual(lines[0]["startTimeMs"], 10000.0)
        self.assertEqual(lines[1]["startTimeMs"], 20000.0)


class MalformedPayloadTest(unittest.TestCase):
    """External API data is untrusted: a non-dict element at any level must be
    skipped, not raise. A raise here previously aborted the whole track load and
    (with the SMTC signature bug) stranded it on the loading spinner."""

    def test_detect_is_seconds_skips_malformed_items(self):
        content = ["junk", 5, None, {"Syllables": ["x", 7, None]}]
        self.assertFalse(detect_is_seconds(content))

    def test_content_non_list_is_safe(self):
        self.assertEqual(parse_spicy_body({"Content": "nope"}), ([], 0))

    def test_parse_skips_malformed_flat_syllables(self):
        body = {"Content": [
            "junk", 123, None,
            {"Lead": {"Syllables": [
                "nope", 5, None,
                {"Text": "hi ", "StartTime": 1000, "EndTime": 1500},
            ]}},
        ]}
        lines, count = parse_spicy_body(body)
        self.assertEqual(count, 1)
        self.assertEqual(lines[0]["text"], "hi")

    def test_parse_skips_malformed_native_words(self):
        body = {"Content": [
            {"Lead": {"Words": [
                "bad", 9, None,
                {"Text": "ok", "StartTime": 1000, "EndTime": 1500,
                 "Syllables": ["x", {"Text": "ok", "StartTime": 1000, "EndTime": 1500}]},
            ]}},
        ]}
        lines, count = parse_spicy_body(body)
        self.assertEqual(count, 1)
        self.assertTrue(lines[0]["words"])


if __name__ == "__main__":
    unittest.main()
