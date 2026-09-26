import unittest

from core.metadata import extract_clean_metadata


class CleanMetadataTest(unittest.TestCase):
    def test_strips_official_video_and_artist_prefix(self):
        title, primary, full = extract_clean_metadata(
            "Radiohead - Creep (Official Video)", "Radiohead - Topic"
        )
        self.assertEqual(title, "Creep")
        self.assertEqual(primary, "Radiohead")
        self.assertEqual(full, "Radiohead")

    def test_strips_bracketed_feature(self):
        title, _, _ = extract_clean_metadata("Song (feat. Drake)", "Artist")
        self.assertEqual(title, "Song")

    def test_strips_inline_feature(self):
        title, _, _ = extract_clean_metadata("Song feat. Drake", "Artist")
        self.assertEqual(title, "Song")

    def test_normalizes_full_width_brackets(self):
        title, _, _ = extract_clean_metadata("【MV】Title", "Artist")
        self.assertEqual(title, "Title")

    def test_handles_artist_dash_title_without_artist(self):
        title, primary, full = extract_clean_metadata("Some Artist - Some Song", "")
        self.assertEqual(title, "Some Song")
        self.assertEqual(primary, "Some Artist")

    def test_primary_artist_split_on_separators(self):
        _, primary, full = extract_clean_metadata("T", "Artist A & Artist B")
        self.assertEqual(primary, "Artist A")
        self.assertEqual(full, "Artist A & Artist B")


if __name__ == "__main__":
    unittest.main()
