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


class WeakLocalFileMetadataTest(unittest.TestCase):
    """Local players often broadcast the filename stem instead of tags."""

    def test_strip_audio_extension(self):
        from core.metadata import strip_audio_extension
        self.assertEqual(strip_audio_extension("track.mp3"), "track")
        self.assertEqual(strip_audio_extension("song.FLAC"), "song")
        self.assertEqual(strip_audio_extension("no ext"), "no ext")

    def test_split_track_number_prefix(self):
        from core.metadata import split_track_number_prefix
        self.assertEqual(split_track_number_prefix("01 - Artist - Title"), (1, "Artist - Title"))
        self.assertEqual(split_track_number_prefix("12 Artist - Title"), (12, "Artist - Title"))
        self.assertEqual(split_track_number_prefix("Artist - Title"), (None, "Artist - Title"))

    def test_normalize_full_filename_pattern(self):
        # "07 - Daft Punk - One More Time.mp3" with empty artist from the player.
        from core.metadata import normalize_weak_title
        title, artist, source = normalize_weak_title("07 - Daft Punk - One More Time.mp3", "")
        self.assertEqual((title, artist, source), ("One More Time", "Daft Punk", "filename"))

    def test_normalize_underscores_and_no_artist(self):
        from core.metadata import normalize_weak_title
        title, artist, source = normalize_weak_title("nightcall_kavinsky", "")
        self.assertEqual(source, "filename")
        self.assertEqual(title, "nightcall")
        self.assertEqual(artist, "kavinsky")

    def test_good_metadata_is_untouched(self):
        from core.metadata import normalize_weak_title
        title, artist, source = normalize_weak_title("Disease", "Lady Gaga")
        self.assertEqual((title, artist, source), ("Disease", "Lady Gaga", "smtc"))

    def test_bracket_noise_in_stem_is_cleaned(self):
        from core.metadata import normalize_weak_title
        title, artist, _ = normalize_weak_title("Artist - Song (Official Audio).mp3", "Artist")
        self.assertEqual(title, "Song")


if __name__ == "__main__":
    unittest.main()
