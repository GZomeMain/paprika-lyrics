import unittest
from types import SimpleNamespace

from core.media_meta import (
    MediaMeta,
    album_for_search,
    build_track_signature,
    media_meta_from_smtc,
)


class MediaMetaFromSmtcTest(unittest.TestCase):
    def test_reads_all_fields(self):
        info = SimpleNamespace(
            title="Disease", artist="Lady Gaga", albumTitle="MAYHEM",
            subtitle="", trackNumber=2,
        )
        meta = media_meta_from_smtc(info, duration_ms=201000.0)
        self.assertEqual(meta.raw_title, "Disease")
        self.assertEqual(meta.raw_artist, "Lady Gaga")
        self.assertEqual(meta.album, "MAYHEM")
        self.assertEqual(meta.track_number, 2)
        self.assertEqual(meta.duration_ms, 201000.0)
        self.assertEqual(meta.metadata_source, "smtc")

    def test_tolerates_missing_attributes(self):
        meta = media_meta_from_smtc(SimpleNamespace(title="T", artist="A"))
        self.assertEqual(meta.album, "")
        self.assertIsNone(meta.track_number)

    def test_none_info_gives_empty_meta(self):
        meta = media_meta_from_smtc(None)
        self.assertEqual(meta.raw_title, "")
        self.assertEqual(meta.raw_artist, "")
        self.assertEqual(meta.metadata_source, "partial")


class TrackSignatureTest(unittest.TestCase):
    def test_signature_includes_album_and_duration(self):
        meta = MediaMeta(raw_title="Song", raw_artist="Artist",
                         album="Album", duration_ms=200000.0)
        sig = build_track_signature(meta, "AppId")
        self.assertEqual(sig, "AppId:::Song:::Artist:::Album:::200000")

    def test_signature_omits_missing_duration(self):
        meta = MediaMeta(raw_title="Song", raw_artist="Artist")
        sig = build_track_signature(meta, "App")
        self.assertEqual(sig, "App:::Song:::Artist::::::0")


class AlbumForSearchTest(unittest.TestCase):
    def test_cleans_bracket_noise_from_album(self):
        meta = MediaMeta(raw_title="T", raw_artist="A", album="MAYHEM (Deluxe Edition)")
        self.assertEqual(album_for_search(meta), "MAYHEM")

    def test_empty_album_stays_empty(self):
        self.assertEqual(album_for_search(MediaMeta(raw_title="T", raw_artist="A")), "")

    def test_metadata_noise_album_is_dropped(self):
        # Some players broadcast "YouTube Search" or the playlist name as album.
        meta = MediaMeta(raw_title="T", raw_artist="A", album="Various Artists")
        self.assertEqual(album_for_search(meta), "")


if __name__ == "__main__":
    unittest.main()
