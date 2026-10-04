import json
import shutil
import tempfile
import unittest
from pathlib import Path

import storage
from core.ttml_library import TtmlLibrary, binding_keys


def doc(title: str, artist: str, body: str = "", duration: str = "00:20.000") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">'
        f'<head><metadata><ttm:title>{title}</ttm:title>'
        f'<ttm:agent type="person" xml:id="v1"><ttm:name type="full">{artist}</ttm:name></ttm:agent>'
        '</metadata></head>'
        f'<body dur="{duration}">'
        + (body or '<p begin="00:01.000" end="00:03.000">'
                   '<span begin="00:01.000">Gold </span>'
                   '<span begin="00:02.000">jewelry</span></p>')
        + '</body></tt>'
    )


class LibraryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.cache = storage.CacheManager(filepath=self.tmp / "cache.json")
        self.lib = TtmlLibrary(directory=self.tmp / "ttml", cache=self.cache)
        self.outside = self.tmp / "downloads"
        self.outside.mkdir()

    def tearDown(self):
        try:
            self.cache.flush()
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def place(self, name: str, text: str) -> Path:
        path = self.outside / name
        path.write_text(text, encoding="utf-8")
        return path

    def add(self, name: str, text: str) -> Path:
        path = self.place(name, text)
        return path, self.lib.add_files([str(path)])


class ScanTest(LibraryTestCase):
    def test_missing_folder_is_an_empty_library_not_an_error(self):
        self.assertEqual(self.lib.scan(), {})
        self.assertEqual(self.lib.entries(), [])
        # Reading must not create the folder: an empty library appearing because
        # a song played would be a side effect of a read.
        self.assertFalse(self.lib.directory.exists())

    def test_add_files_copies_parses_and_indexes(self):
        _path, report = self.add("Ode To The Mets.ttml", doc("Ode To The Mets", "The Strokes"))
        self.assertEqual([a["name"] for a in report["added"]], ["Ode To The Mets.ttml"])
        self.assertEqual(report["failed"], [])

        entry = self.lib.entries()[0]
        self.assertEqual(entry["title"], "Ode To The Mets")
        self.assertEqual(entry["artist"], "The Strokes")
        self.assertEqual(entry["title_source"], "metadata")
        self.assertEqual(entry["timing"], "Word")
        self.assertEqual(entry["line_count"], 1)
        self.assertEqual(entry["syllables"], 2)
        self.assertEqual(entry["duration_ms"], 20_000)

    def test_a_name_clash_never_overwrites(self):
        self.add("Song.ttml", doc("One", "A"))
        _path, report = self.add("Song.ttml", doc("Two", "B"))
        self.assertEqual([a["name"] for a in report["added"]], ["Song (2).ttml"])
        titles = sorted(e["title"] for e in self.lib.entries())
        self.assertEqual(titles, ["One", "Two"])

    def test_a_file_inside_the_library_is_not_copied_onto_itself(self):
        self.lib.ensure_dir()
        inside = self.lib.directory / "Already.ttml"
        inside.write_text(doc("Already", "Someone"), encoding="utf-8")
        report = self.lib.add_files([str(inside)])
        self.assertEqual(report["skipped"], ["Already.ttml"])
        self.assertEqual(report["added"], [])

    def test_unsupported_and_unreadable_files_are_reported(self):
        txt = self.place("notes.txt", "not lyrics")
        broken = self.place("broken.ttml", "<tt><body><p>x</p>")
        report = self.lib.add_files([str(txt), str(broken), str(self.tmp / "nope.ttml")])
        reasons = {item["name"]: item["reason"] for item in report["failed"]}
        self.assertIn("not a .ttml file", reasons["notes.txt"])
        self.assertIn("not valid XML", reasons["broken.ttml"])
        self.assertIn("not a file", reasons["nope.ttml"])

    def test_an_unreadable_file_is_kept_and_flagged_not_silently_dropped(self):
        self.add("broken.ttml", "<tt><body></body></tt>")
        entry = self.lib.entries()[0]
        self.assertIn("no lyric lines found", entry["error"])
        self.assertEqual(self.lib.snapshot()["count"], 1)

    def test_scan_picks_up_files_dropped_straight_into_the_folder(self):
        self.lib.ensure_dir()
        (self.lib.directory / "Dropped.ttml").write_text(doc("Dropped", "Someone"), encoding="utf-8")
        self.assertEqual([e["name"] for e in self.lib.entries()], ["Dropped.ttml"])

    def test_scan_forgets_deleted_files(self):
        self.add("Gone.ttml", doc("Gone", "Someone"))
        self.assertEqual(self.lib.snapshot()["count"], 1)
        (self.lib.directory / "Gone.ttml").unlink()
        self.assertEqual(self.lib.entries(), [])

    def test_a_bom_does_not_break_the_file(self):
        path = self.place("Bom.ttml", doc("Bom Song", "Someone"))
        path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes())
        self.lib.add_files([str(path)])
        self.assertEqual(self.lib.entries()[0]["title"], "Bom Song")

    def test_title_falls_back_to_the_filename(self):
        self.add("Midnight City.ttml",
                 '<tt><body><p begin="1.0" end="2.0">Midnight City</p></body></tt>')
        entry = self.lib.entries()[0]
        self.assertEqual(entry["title"], "Midnight City")
        self.assertEqual(entry["title_source"], "filename")
        self.assertEqual(entry["artist"], "")

    def test_subfolders_are_indexed_with_a_relative_path(self):
        self.lib.ensure_dir()
        nested = self.lib.directory / "Album"
        nested.mkdir()
        (nested / "Track.ttml").write_text(doc("Track", "Someone"), encoding="utf-8")
        entry = self.lib.entries()[0]
        self.assertEqual(entry["file"], "Album/Track.ttml")

    def test_editing_a_file_is_noticed(self):
        self.add("Edit.ttml", doc("Edit", "Someone"))
        self.assertEqual(self.lib.resolve("Edit", "Someone")["name"], "Edit.ttml")

        (self.lib.directory / "Edit.ttml").write_text(
            doc("Edit", "Someone",
                body='<p begin="00:01.000" end="00:02.000">'
                     '<span begin="00:01.000">Changed </span></p>'),
            encoding="utf-8")
        lines = self.lib.resolve("Edit", "Someone")["lines"]
        self.assertEqual(lines[0]["text"], "Changed")


class MatchTest(LibraryTestCase):
    def setUp(self):
        super().setUp()
        self.add("Ode To The Mets.ttml", doc("Ode To The Mets", "The Strokes"))
        self.lib.scan()

    def test_exact_title_and_artist_are_applied_automatically(self):
        found = self.lib.resolve("Ode To The Mets", "The Strokes", "The New Abnormal", 200_000)
        self.assertEqual(found["kind"], "match")
        self.assertEqual(found["name"], "Ode To The Mets.ttml")
        self.assertEqual(len(found["lines"]), 1)

    def test_matching_ignores_case_accents_and_punctuation(self):
        self.add("Beyonce.ttml", doc("Don\u2019t Hurt Yourself", "Beyonc\u00e9"))
        self.lib.scan()
        found = self.lib.resolve("Don't Hurt Yourself", "Beyonce")
        self.assertIsNotNone(found)
        self.assertEqual(found["name"], "Beyonce.ttml")

    def test_a_different_artist_is_not_a_match(self):
        self.assertIsNone(self.lib.resolve("Ode To The Mets", "Some Cover Band"))

    def test_title_only_files_are_suggestions_not_matches(self):
        self.add("Ode To The Mets (live).ttml",
                 '<tt><body><p begin="1.0" end="2.0">Live version</p></body></tt>')
        self.lib.scan()
        self.assertIsNone(self.lib.resolve("Ode To The Mets (live)", "Nobody"))
        snapshot = self.lib.snapshot("Ode To The Mets (live)", "Nobody")
        self.assertIn("Ode To The Mets (live).ttml", snapshot["current"]["candidates"])

    def test_two_equally_good_files_are_left_to_the_user(self):
        self.add("Copy.ttml", doc("Ode To The Mets", "The Strokes"))
        self.lib.scan()
        # Two files claim the same song with nothing to choose between them:
        # silence beats a coin flip, and both are offered in the panel.
        self.assertIsNone(self.lib.resolve("Ode To The Mets", "The Strokes"))
        snapshot = self.lib.snapshot("Ode To The Mets", "The Strokes")
        self.assertEqual(sorted(snapshot["current"]["candidates"]),
                         ["Copy.ttml", "Ode To The Mets.ttml"])

    def test_album_and_duration_break_an_otherwise_ambiguous_pair(self):
        self.add("Live.ttml", doc("Ode To The Mets", "The Strokes", duration="00:30.000"))
        self.lib.scan()
        # Both files claim the song; the playing track's 20s runtime picks the
        # 20s file instead of leaving the pair unresolved.
        found = self.lib.resolve("Ode To The Mets", "The Strokes", None, 20_000)
        self.assertIsNotNone(found)
        self.assertEqual(found["name"], "Ode To The Mets.ttml")
        self.assertIsNone(self.lib.resolve("Ode To The Mets", "The Strokes", None, 200_000))

    def test_feature_credits_still_match(self):
        self.add("Duet.ttml", doc("Duet", "Artist A &amp; Artist B"))
        self.lib.scan()
        self.assertIsNotNone(self.lib.resolve("Duet", "Artist A"))
        self.assertIsNotNone(self.lib.resolve("Duet", "Artist A, Artist B"))

    def test_the_library_is_never_used_for_a_track_with_no_metadata(self):
        self.assertIsNone(self.lib.resolve("", ""))


class BindingTest(LibraryTestCase):
    def setUp(self):
        super().setUp()
        self.add("Ode To The Mets.ttml", doc("Ode To The Mets", "The Strokes"))
        self.lib.scan()
        self.track = ("Some Song", "Someone", "Some Album", 200_000)

    def test_binding_beats_matching(self):
        self.assertTrue(self.lib.set_binding("Ode To The Mets.ttml", *self.track)["ok"])
        found = self.lib.resolve(*self.track)
        self.assertEqual(found["kind"], "bound")
        self.assertEqual(found["name"], "Ode To The Mets.ttml")

    def test_a_binding_survives_a_changed_album_or_duration(self):
        self.lib.set_binding("Ode To The Mets.ttml", *self.track)
        # The same song, now reported with no album tag and a slightly longer
        # runtime: the identity ladder still finds the binding.
        self.assertIsNotNone(self.lib.resolve("Some Song", "Someone"))
        self.assertIsNotNone(self.lib.resolve("Some Song", "Someone", None, 260_000))

    def test_binding_an_unknown_file_is_refused(self):
        result = self.lib.set_binding("nope.ttml", *self.track)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "unknown file")

    def test_disabling_is_sticky_and_suppresses_matching(self):
        # A file whose own metadata matches the track would otherwise be picked
        # automatically; the explicit "online instead" must override that.
        track = ("Ode To The Mets", "The Strokes", "The New Abnormal", 200_000)
        self.assertEqual(self.lib.resolve(*track)["kind"], "match")

        self.assertTrue(self.lib.set_enabled(*track, enabled=False)["ok"])
        self.assertIsNone(self.lib.resolve(*track))
        self.assertEqual(self.lib.snapshot(*track)["current"]["kind"], "off")

        self.lib.set_enabled(*track, enabled=True)
        self.assertEqual(self.lib.resolve(*track)["kind"], "match")

    def test_disabling_keeps_the_chosen_file(self):
        track = ("Some Song", "Someone")
        self.lib.set_binding("Ode To The Mets.ttml", *track)
        self.lib.set_enabled(*track, enabled=False)
        self.assertIsNone(self.lib.resolve(*track))
        # Re-enabling restores the file the user picked, not a re-match.
        self.lib.set_enabled(*track, enabled=True)
        found = self.lib.resolve(*track)
        self.assertEqual((found["kind"], found["name"]), ("bound", "Ode To The Mets.ttml"))

    def test_enabling_a_track_with_nothing_bound_leaves_no_stale_marker(self):
        track = ("Nothing Bound", "Nobody")
        self.lib.set_enabled(*track, enabled=False)
        self.assertIn(binding_keys(*track)[0], self.lib.cache.ttml_bindings())
        self.lib.set_enabled(*track, enabled=True)
        self.assertNotIn(binding_keys(*track)[0], self.lib.cache.ttml_bindings())

    def test_bindings_persist_across_a_restart(self):
        self.lib.set_binding("Ode To The Mets.ttml", *self.track)
        self.cache.flush()

        reopened = TtmlLibrary(directory=self.lib.directory,
                               cache=storage.CacheManager(filepath=self.tmp / "cache.json"))
        found = reopened.resolve(*self.track)
        self.assertEqual(found["kind"], "bound")


class RemoveTest(LibraryTestCase):
    def test_removing_moves_the_file_to_trash(self):
        self.add("Gone.ttml", doc("Gone", "Someone"))
        self.lib.scan()
        result = self.lib.remove_file("Gone.ttml")
        self.assertTrue(result["ok"])
        self.assertEqual(self.lib.entries(), [])
        self.assertFalse((self.lib.directory / "Gone.ttml").exists())
        trashed = list((self.lib.directory / ".trash").iterdir())
        self.assertEqual(len(trashed), 1)
        self.assertTrue(trashed[0].name.endswith("Gone.ttml"))
        self.assertEqual(self.lib.snapshot()["trash"], 1)

    def test_removing_an_unknown_file_is_reported(self):
        self.assertFalse(self.lib.remove_file("nothing.ttml")["ok"])

    def test_removing_drops_the_bindings_that_pointed_at_it(self):
        self.add("Gone.ttml", doc("Gone", "Someone"))
        self.lib.set_binding("Gone.ttml", "Some Song", "Someone")
        self.lib.remove_file("Gone.ttml")
        self.assertIsNone(self.lib.resolve("Some Song", "Someone"))
        self.assertEqual(self.lib.cache.ttml_bindings(), {})

    def test_the_trash_folder_is_not_indexed(self):
        self.add("Gone.ttml", doc("Gone", "Someone"))
        self.lib.remove_file("Gone.ttml")
        self.assertEqual(self.lib.entries(), [])


class SnapshotTest(LibraryTestCase):
    def test_per_track_state_is_reported_for_the_panel(self):
        self.add("Ode To The Mets.ttml", doc("Ode To The Mets", "The Strokes"))
        self.lib.scan()
        entry = self.lib.entries()[0]
        self.assertEqual(entry["size"] > 0, True)

        snapshot = self.lib.snapshot("Ode To The Mets", "The Strokes", "The New Abnormal", 200_000)
        self.assertEqual(snapshot["count"], 1)
        self.assertEqual(snapshot["current"]["kind"], "match")
        self.assertEqual(snapshot["entries"][0]["state"], "match")

    def test_no_track_means_no_current_state(self):
        snapshot = self.lib.snapshot()
        self.assertIsNone(snapshot["current"])
        self.assertEqual(snapshot["dir"], str(self.lib.directory))

    def test_entry_state_never_leaks_into_the_index(self):
        self.add("Ode To The Mets.ttml", doc("Ode To The Mets", "The Strokes"))
        self.lib.snapshot("Ode To The Mets", "The Strokes")
        self.assertNotIn("state", self.lib.entries()[0])


class BindingKeyTest(unittest.TestCase):
    def test_the_ladder_runs_from_most_to_least_specific(self):
        keys = binding_keys("Song", "Artist", "Album", 200_000)
        self.assertEqual(keys[0], "song___artist___album___200s")
        self.assertIn("song___artist", keys)
        self.assertEqual(len(keys), len(set(keys)))

    def test_unknown_album_and_duration_collapse_to_one_key(self):
        self.assertEqual(binding_keys("Song", "Artist"), ["song___artist"])

    def test_an_untitled_track_has_no_key(self):
        # Not even a placeholder: two untitled streams must not share a binding.
        self.assertEqual(binding_keys("", ""), [])
        self.assertEqual(binding_keys("   ", "Artist"), [])


if __name__ == "__main__":
    unittest.main()
