import base64
import math
import shutil
import struct
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from core import font_library
from core.font_library import (DEFAULT_WEIGHT, FontLibrary, label_from_filename,
                               read_font_meta, slug)


def _name_table(records) -> bytes:
    """A `name` table from (platform, language, name ID, text) records."""
    strings = b""
    entries = b""
    for platform, language, name_id, text in records:
        raw = text.encode("utf-16-be") if platform in (0, 3) else text.encode("mac-roman")
        entries += struct.pack(">6H", platform, 1 if platform in (0, 3) else 0,
                               language, name_id, len(raw), len(strings))
        strings += raw
    return struct.pack(">HHH", 0, len(records), 6 + 12 * len(records)) + entries + strings


def _os2(weight: int, italic: bool = False) -> bytes:
    table = bytearray(78)
    struct.pack_into(">H", table, 0, 4)
    struct.pack_into(">H", table, 4, weight)
    struct.pack_into(">H", table, 62, 1 if italic else 0)
    return bytes(table)


def _sfnt(tables, flavor: bytes = b"\x00\x01\x00\x00") -> bytes:
    """A structurally valid sfnt file for the given tables."""
    count = len(tables)
    entry_selector = int(math.log2(count)) if count else 0
    search_range = (2 ** entry_selector) * 16 if count else 0
    header = struct.pack(">4sHHHH", flavor, count, search_range, entry_selector,
                         count * 16 - search_range)
    offset = 12 + count * 16
    records = b""
    body = b""
    for tag, data in sorted(tables.items()):
        records += struct.pack(">4sIII", tag, 0, offset, len(data))
        padded = data + b"\x00" * ((4 - len(data) % 4) % 4)
        body += padded
        offset += len(padded)
    return header + records + body


def build_font(family="Testface", subfamily="Regular", weight=400, italic=False,
               flavor=b"\x00\x01\x00\x00", records=None) -> bytes:
    """A font file carrying just enough for its own name and weight to be read."""
    names = records if records is not None else [
        (3, 0x409, 1, family), (3, 0x409, 2, subfamily),
        (3, 0x409, 16, family), (3, 0x409, 17, subfamily),
    ]
    return _sfnt({b"name": _name_table(names), b"OS/2": _os2(weight, italic)}, flavor)


def build_woff(family="Woffface", weight=700) -> bytes:
    """The same font in WOFF form, with its tables stored uncompressed."""
    tables = {b"name": _name_table([(3, 0x409, 1, family)]), b"OS/2": _os2(weight)}
    directory = b""
    body = b""
    offset = 44 + 20 * len(tables)
    for tag, data in sorted(tables.items()):
        directory += struct.pack(">4sIIII", tag, offset, len(data), len(data), 0)
        padded = data + b"\x00" * ((4 - len(data) % 4) % 4)
        body += padded
        offset += len(padded)
    header = struct.pack(">4sIIHHIHHIIIII", b"wOFF", 0x00010000, 0, len(tables), 0,
                         offset, 1, 0, 0, 0, 0, 0, 0)
    return header + directory + body


class ReadFontMetaTests(unittest.TestCase):
    """A font is listed by the name it calls itself, not by its file name."""

    def test_family_and_weight_come_from_the_font(self):
        meta = read_font_meta(build_font("Honk", "Regular", weight=400))
        self.assertEqual(meta["family"], "Honk")
        self.assertEqual(meta["subfamily"], "Regular")
        self.assertEqual(meta["weight"], 400)
        self.assertFalse(meta["italic"])

    def test_weight_survives_as_the_font_declares_it(self):
        # The imported face used to be hard-coded to 700, which drew a Regular
        # face as synthesized bold. The file's own weight is what it is drawn at.
        self.assertEqual(read_font_meta(build_font(weight=300))["weight"], 300)
        self.assertEqual(read_font_meta(build_font(weight=700))["weight"], 700)

    def test_an_italic_face_is_reported(self):
        self.assertTrue(read_font_meta(build_font("Slant", "Bold Italic", italic=True))["italic"])
        self.assertTrue(read_font_meta(build_font("Slant", "Italic"))["italic"])

    def test_windows_records_win_over_legacy_mac_ones(self):
        meta = read_font_meta(build_font(records=[
            (1, 0, 1, "Mac Name"), (3, 0x409, 1, "Windows Name"),
        ]))
        self.assertEqual(meta["family"], "Windows Name")

    def test_the_english_record_wins_over_a_localized_one(self):
        meta = read_font_meta(build_font(records=[
            (3, 0x40C, 1, "Nom Français"), (3, 0x409, 1, "English Name"),
        ]))
        self.assertEqual(meta["family"], "English Name")

    def test_a_woff_face_is_read_too(self):
        meta = read_font_meta(build_woff("Woffface", weight=700))
        self.assertEqual(meta["family"], "Woffface")
        self.assertEqual(meta["weight"], 700)

    def test_a_woff2_directory_is_not_guessed_at(self):
        # WOFF2 compresses its table directory with Brotli, which is not in the
        # standard library: the file name is the honest answer.
        meta = read_font_meta(b"wOF2" + b"\x00" * 200)
        self.assertEqual(meta["family"], "")
        self.assertEqual(meta["weight"], 0)

    def test_junk_and_unreadable_files_answer_instead_of_raising(self):
        for data in (b"", b"not a font", b"\x00\x01\x00\x00", build_font()[:40],
                     b"OTTO" + b"\xff" * 64):
            meta = read_font_meta(data)
            self.assertEqual(meta["family"], "")
            self.assertEqual(meta["weight"], 0)

    def test_a_file_cut_off_after_its_name_table_still_reports_its_name(self):
        # Glyph data is never read, so a partially downloaded file still lists
        # under the name it declares — and says nothing it cannot support.
        meta = read_font_meta(build_font("Partial")[:-8])
        self.assertEqual(meta["family"], "Partial")


class LabelFallbackTests(unittest.TestCase):
    """Only used when a file's own name table cannot be read."""

    def test_style_words_and_odd_punctuation_are_dropped(self):
        self.assertEqual(label_from_filename("Honk-Regular-VariableFont_MORF,SHLN"),
                         "Honk Regular VariableFont MORF SHLN")
        self.assertEqual(label_from_filename("Inter_18pt-SemiBold"), "Inter 18pt")
        self.assertEqual(label_from_filename("Café-Noir-Regular"), "Café Noir")

    def test_a_name_that_is_all_style_words_still_reads(self):
        self.assertEqual(label_from_filename("Regular"), "Regular")
        self.assertEqual(label_from_filename(""), "Font")


class LibraryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = FontLibrary(directory=self.tmp / "fonts")
        self.outside = self.tmp / "downloads"
        self.outside.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def place(self, name: str, data: bytes = None) -> Path:
        path = self.outside / name
        path.write_bytes(data if data is not None else build_font(Path(name).stem))
        return path


class FolderTests(LibraryTestCase):
    def test_reading_an_absent_folder_does_not_create_it(self):
        # The list runs on every settings sync; an empty folder appearing because
        # the sheet was opened would be a side effect of reading.
        self.assertEqual(self.lib.entries(), [])
        self.assertFalse(self.lib.directory.exists())

    def test_the_folder_ignores_itself_inside_the_app(self):
        # The default folder lives inside the project checkout, where a user's
        # own fonts must never turn up in `git status`.
        with mock.patch.object(font_library, "DATA_DIR", self.tmp):
            lib = FontLibrary(directory=self.tmp / "fonts")
            lib.ensure_dir()
            self.assertTrue((lib.directory / ".gitignore").is_file())

    def test_a_folder_outside_the_app_is_left_alone(self):
        self.lib.ensure_dir()
        self.assertFalse((self.lib.directory / ".gitignore").exists())

    def test_only_font_files_are_listed(self):
        self.lib.ensure_dir()
        (self.lib.directory / "notes.txt").write_text("hi", encoding="utf-8")
        (self.lib.directory / "face.ttf").write_bytes(build_font("Listed"))
        (self.lib.directory / ".hidden.ttf").write_bytes(build_font("Hidden"))
        names = [e["label"] for e in self.lib.entries()]
        self.assertEqual(names, ["Listed"])

    def test_a_files_own_subfamily_travels_with_its_entry(self):
        # A family's bold and italic files all report the family "Georgia", so four
        # real faces would list as four identical rows unless what the file calls
        # itself beyond the family travels with it.
        self.lib.ensure_dir()
        (self.lib.directory / "georgia-bold.ttf").write_bytes(
            build_font("Georgia", "Bold", weight=700))
        (self.lib.directory / "georgia-italic.ttf").write_bytes(
            build_font("Georgia", "Italic", weight=400, italic=True))
        entries = {e["name"]: e for e in self.lib.entries()}
        self.assertEqual((entries["georgia-bold.ttf"]["label"],
                          entries["georgia-bold.ttf"]["subfamily"],
                          entries["georgia-bold.ttf"]["weight"]),
                         ("Georgia", "Bold", 700))
        self.assertEqual(entries["georgia-italic.ttf"]["subfamily"], "Italic")
        self.assertEqual(entries["georgia-italic.ttf"]["style"], "italic")

    def test_a_file_with_no_readable_name_falls_back_to_its_file_name(self):
        self.lib.ensure_dir()
        (self.lib.directory / "Mystery-Face-Regular.woff2").write_bytes(b"wOF2" + b"\x00" * 64)
        entry = self.lib.entries()[0]
        self.assertEqual(entry["label"], "Mystery Face")
        self.assertEqual(entry["weight"], DEFAULT_WEIGHT)


class FamilyIdTests(LibraryTestCase):
    def test_ids_come_from_the_file_name_and_are_stable(self):
        self.lib.ensure_dir()
        (self.lib.directory / "Honk-Regular.ttf").write_bytes(build_font("Honk"))
        ids = [e["id"] for e in self.lib.entries()]
        self.assertEqual(ids, ["custom-honk-regular"])
        # A second file must not renumber the first: the overlay has this string
        # saved as the user's chosen font.
        (self.lib.directory / "Aardvark.ttf").write_bytes(build_font("Aardvark"))
        self.assertIn("custom-honk-regular", [e["id"] for e in self.lib.entries()])

    def test_two_files_sharing_a_stem_do_not_share_one_family(self):
        self.lib.ensure_dir()
        (self.lib.directory / "Air.ttf").write_bytes(build_font("Air"))
        (self.lib.directory / "Air.otf").write_bytes(build_font("Air Display"))
        ids = sorted(e["id"] for e in self.lib.entries())
        self.assertEqual(ids, ["custom-air-otf", "custom-air-ttf"])

    def test_ids_match_the_ones_the_store_based_importer_derived(self):
        # The old importer slugged the file's label through JavaScript's
        # /[^a-z0-9]+/ — a name derived the same way is what keeps a font that
        # was imported before this change applied to the lyrics.
        self.assertEqual(slug("Honk Regular VariableFont MORF,"), "honk-regular-variablefont-morf")
        self.assertEqual(slug("Café Noir"), "caf-noir")
        self.assertEqual(slug("!!!"), "font")


class AddFilesTests(LibraryTestCase):
    def test_import_copies_the_files_in(self):
        report = self.lib.add_files([self.place("one.ttf", build_font("One")),
                                     self.place("two.otf", build_font("Two", flavor=b"OTTO")),
                                     self.place("three.woff", build_woff("Three")),
                                     self.place("four.woff2", b"wOF2" + b"\x00" * 64)])
        self.assertEqual([item["name"] for item in report["added"]],
                         ["one.ttf", "two.otf", "three.woff", "four.woff2"])
        self.assertEqual(report["failed"], [])
        self.assertEqual([e["name"] for e in self.lib.entries()],
                         ["four.woff2", "one.ttf", "three.woff", "two.otf"])

    def test_there_is_no_count_limit(self):
        paths = [self.place(f"face-{i:02d}.ttf", build_font(f"Face {i}")) for i in range(14)]
        report = self.lib.add_files(paths)
        self.assertEqual(len(report["added"]), 14)
        self.assertEqual(self.lib.snapshot()["count"], 14)

    def test_a_name_clash_never_overwrites(self):
        first = self.place("face.ttf", build_font("First"))
        self.lib.add_files([first])
        second = self.place("face.ttf", build_font("Second"))
        self.lib.add_files([second])
        labels = sorted(e["label"] for e in self.lib.entries())
        self.assertEqual(labels, ["First", "Second"])
        # Different bytes are not the same face: the second file keeps a slot of its
        # own under a numbered name instead of being refused as one already held.
        self.assertEqual(sorted(e["name"] for e in self.lib.entries()),
                         ["face (2).ttf", "face.ttf"])

    def test_a_file_already_in_the_folder_is_left_alone(self):
        self.lib.add_files([self.place("face.ttf")])
        inside = str(self.lib.directory / "face.ttf")
        report = self.lib.add_files([inside])
        self.assertEqual(report["skipped"], ["face.ttf"])
        self.assertEqual(report["added"], [])
        self.assertEqual(self.lib.snapshot()["count"], 1)

    def test_a_file_that_is_not_a_font_is_reported_and_kept(self):
        report = self.lib.add_files([self.place("lyrics.txt", b"hello")])
        self.assertEqual(report["added"], [])
        self.assertIn("not a .ttf", report["failed"][0]["reason"])
        self.assertEqual(self.lib.snapshot()["count"], 0)

    def test_a_mis_named_file_is_reported(self):
        # Kept, so the user can fix the file where it is — but the import says
        # what it found instead of adding a row that cannot be read.
        path = self.outside / "movie.ttf"
        path.write_bytes(b"\x00\x00\x00\x00 not a font")
        report = self.lib.add_files([path])
        self.assertEqual(report["failed"][0]["reason"], "not a font file")
        self.assertEqual(report["added"], [])
        # Kept where it is: the user can fix it in place rather than import it again.

    def test_a_missing_path_is_reported(self):
        report = self.lib.add_files([str(self.outside / "ghost.ttf")])
        self.assertEqual(report["failed"][0]["reason"], "not a file")

    def test_the_same_face_is_not_imported_twice(self):
        # Measured on the shipped library: importing a font again from where it was
        # downloaded added a second row ("georgia (2).ttf") holding the same face
        # under the same label. With no cap and a multi-select picker, choosing the
        # same file twice is an ordinary way to end up with a library of duplicates.
        body = build_font("Georgia")
        self.lib.add_files([self.place("georgia.ttf", body)])
        again = self.lib.add_files([self.place("Georgia-copy.ttf", body)])
        self.assertEqual(again["added"], [])
        self.assertEqual(again["skipped"], ["georgia.ttf"])
        self.assertEqual([e["name"] for e in self.lib.entries()], ["georgia.ttf"])

    def test_two_identical_files_in_one_import_land_once(self):
        body = build_font("Georgia")
        report = self.lib.add_files([self.place("one.ttf", body),
                                     self.place("two.ttf", body)])
        self.assertEqual([item["name"] for item in report["added"]], ["one.ttf"])
        self.assertEqual(report["skipped"], ["one.ttf"])
        self.assertEqual(self.lib.snapshot()["count"], 1)

    def test_a_removed_face_can_be_imported_again(self):
        # The digest list is the folder's live files, never its .trash: a face the
        # user removed on purpose has to be importable again, which is exactly what
        # hashing the trash would refuse for a reason they cannot see.
        body = build_font("Georgia")
        self.lib.add_files([self.place("georgia.ttf", body)])
        self.lib.remove_file("georgia.ttf")
        report = self.lib.add_files([self.place("download.ttf", body)])
        self.assertEqual([item["name"] for item in report["added"]], ["download.ttf"])


class DataTests(LibraryTestCase):
    def test_the_bytes_come_back_as_a_data_url(self):
        raw = build_font("Bytes")
        self.lib.add_files([self.place("bytes.ttf", raw)])
        url = self.lib.data("bytes.ttf")
        header, _comma, payload = url.partition(",")
        self.assertEqual(header, "data:font/ttf;base64")
        self.assertEqual(base64.b64decode(payload), raw)

    def test_the_media_type_follows_the_extension(self):
        self.lib.add_files([self.place("a.woff", build_woff()),
                            self.place("b.woff2", b"wOF2" + b"\x00" * 64)])
        self.assertTrue(self.lib.data("a.woff").startswith("data:font/woff;base64,"))
        self.assertTrue(self.lib.data("b.woff2").startswith("data:font/woff2;base64,"))

    def test_an_unknown_or_escaping_path_returns_nothing(self):
        (self.tmp / "secret.ttf").write_bytes(build_font("Secret"))
        self.lib.add_files([self.place("face.ttf")])
        self.assertEqual(self.lib.data(""), "")
        self.assertEqual(self.lib.data("ghost.ttf"), "")
        self.assertEqual(self.lib.data("../secret.ttf"), "")
        self.assertEqual(self.lib.data("..\\secret.ttf"), "")


class RemoveTests(LibraryTestCase):
    def test_removing_moves_the_file_to_trash(self):
        self.lib.add_files([self.place("face.ttf")])
        result = self.lib.remove_file("face.ttf")
        self.assertTrue(result["ok"])
        self.assertFalse((self.lib.directory / "face.ttf").exists())
        trashed = list((self.lib.directory / ".trash").iterdir())
        self.assertEqual(len(trashed), 1)
        self.assertTrue(trashed[0].name.endswith("face.ttf"))
        self.assertEqual(self.lib.snapshot()["count"], 0)
        self.assertEqual(self.lib.snapshot()["trash"], 1)

    def test_removing_something_that_is_not_there_is_reported(self):
        result = self.lib.remove_file("ghost.ttf")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "not in the library")

    def test_a_removed_file_can_be_brought_back(self):
        # The .trash move is the whole point: this is a management action, not a
        # delete.
        self.lib.add_files([self.place("face.ttf")])
        self.lib.remove_file("face.ttf")
        trashed = next((self.lib.directory / ".trash").iterdir())
        shutil.copy2(trashed, self.outside / "again.ttf")
        report = self.lib.add_files([self.outside / "again.ttf"])
        self.assertEqual(len(report["added"]), 1)
        self.assertEqual(self.lib.snapshot()["count"], 1)


class AdoptTests(LibraryTestCase):
    """The one-time handover from the store-based importer."""

    def test_a_stored_font_is_written_under_its_stored_id(self):
        raw = build_font("Honk")
        report = self.lib.adopt([{
            "legacyId": "custom-honk-regular",
            "name": "Honk Regular",
            "dataUrl": "data:font/ttf;base64," + base64.b64encode(raw).decode("ascii"),
        }])
        self.assertEqual([item["name"] for item in report["added"]], ["honk-regular.ttf"])
        entry = self.lib.entries()[0]
        # The id the old importer stored is the id the library derives, so the
        # user's saved choice still names a face.
        self.assertEqual(entry["id"], "custom-honk-regular")
        self.assertEqual(entry["label"], "Honk")
        self.assertEqual(self.lib.data(entry["file"]).partition(",")[2],
                         base64.b64encode(raw).decode("ascii"))

    def test_the_extension_comes_from_the_stored_media_type(self):
        raw = build_woff()
        self.lib.adopt([{"legacyId": "custom-woffy", "name": "Woffy", "weight": "700",
                         "dataUrl": "data:font/woff;base64,"
                                    + base64.b64encode(raw).decode("ascii")}])
        self.assertEqual([e["name"] for e in self.lib.entries()], ["woffy.woff"])

    def test_adopting_the_same_font_twice_is_skipped(self):
        entry = {"legacyId": "custom-twice", "name": "Twice",
                 "dataUrl": "data:font/ttf;base64," + base64.b64encode(build_font("Twice")).decode()}
        self.lib.adopt([entry])
        report = self.lib.adopt([entry])
        self.assertEqual(report["skipped"], ["twice.ttf"])
        self.assertEqual(self.lib.snapshot()["count"], 1)

    def test_adopt_does_not_double_a_face_under_another_name(self):
        # The handover normally runs once, but a crash halfway through it must not
        # leave the same face in the folder twice under two legacy names.
        raw = build_font("Twice")
        encoded = base64.b64encode(raw).decode("ascii")
        self.lib.adopt([{"legacyId": "custom-twice", "name": "Twice",
                         "dataUrl": "data:font/ttf;base64," + encoded}])
        report = self.lib.adopt([{"legacyId": "custom-twice-2", "name": "Twice again",
                                  "dataUrl": "data:font/ttf;base64," + encoded}])
        self.assertEqual(report["added"], [])
        self.assertEqual(report["skipped"], ["twice.ttf"])
        self.assertEqual(self.lib.snapshot()["count"], 1)

    def test_an_entry_with_no_usable_data_is_reported(self):
        report = self.lib.adopt([{"legacyId": "custom-empty", "dataUrl": "data:font/ttf;base64,"},
                                 "not a dict", {}])
        self.assertEqual(report["added"], [])
        self.assertEqual(len(report["failed"]), 2)


class SnapshotTests(LibraryTestCase):
    def test_the_snapshot_carries_what_the_list_renders(self):
        self.lib.add_files([self.place("face.ttf", build_font("Snapshot", weight=700))])
        snapshot = self.lib.snapshot()
        self.assertEqual(snapshot["dir"], str(self.lib.directory))
        self.assertEqual(snapshot["count"], 1)
        entry = snapshot["entries"][0]
        self.assertEqual(entry["label"], "Snapshot")
        self.assertEqual(entry["weight"], 700)
        self.assertEqual(entry["style"], "normal")
        self.assertEqual(entry["suffix"], ".ttf")
        self.assertGreater(entry["size"], 0)
        # The bytes are deliberately absent: a folder of fonts is megabytes and
        # the sheet asks for one face at a time.
        self.assertNotIn("dataUrl", entry)

    def test_a_file_replaced_on_disk_is_re_read(self):
        self.lib.add_files([self.place("face.ttf", build_font("Before"))])
        self.assertEqual(self.lib.entries()[0]["label"], "Before")
        target = self.lib.directory / "face.ttf"
        target.write_bytes(build_font("After"))
        self.assertEqual(self.lib.entries()[0]["label"], "After")


if __name__ == "__main__":
    unittest.main()
