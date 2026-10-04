import unittest
from types import SimpleNamespace

from core.vlc_meta import (
    VlcState,
    auth_header,
    build_command_url,
    build_status_url,
    parse_status,
)


def _status(**overrides):
    base = {
        "state": "playing",
        "length": 200,
        "time": 70,
        "information": {
            "category": {
                "meta": {
                    "title": "Disease",
                    "artist": "Lady Gaga",
                    "album": "MAYHEM",
                    "filename": "07 - Disease.mp3",
                }
            }
        },
    }
    base.update(overrides)
    return base


class ParseStatusTest(unittest.TestCase):
    def test_full_payload(self):
        s = parse_status(_status())
        self.assertTrue(s.playing)
        self.assertEqual(s.title, "Disease")
        self.assertEqual(s.artist, "Lady Gaga")
        self.assertEqual(s.album, "MAYHEM")
        self.assertEqual(s.length_ms, 200000.0)
        self.assertEqual(s.position_ms, 70000.0)

    def test_garbage_and_none_are_safe(self):
        self.assertEqual(parse_status(None), VlcState())
        self.assertEqual(parse_status("junk"), VlcState())
        self.assertEqual(parse_status([1, 2]), VlcState())
        # Malformed sub-objects must not raise either.
        self.assertEqual(parse_status({"information": {"category": "junk"}}), VlcState(playing=False))

    def test_untagged_file_repairs_from_filename(self):
        s = parse_status({
            "state": "playing",
            "information": {"category": {"meta": {"filename": "07 - Daft Punk - One More Time.mp3"}}},
        })
        self.assertEqual(s.title, "One More Time")
        self.assertEqual(s.artist, "Daft Punk")

    def test_paused_state(self):
        s = parse_status({"state": "paused"})
        self.assertFalse(s.playing)

    def test_alternate_meta_key_capitalisation(self):
        s = parse_status({
            "state": "playing",
            "information": {"category": {"meta": {"Title": "T", "Artist": "A"}}},
        })
        self.assertEqual(s.title, "T")
        self.assertEqual(s.artist, "A")


class UrlBuilderTest(unittest.TestCase):
    def test_status_url(self):
        self.assertEqual(
            build_status_url("127.0.0.1", 8080),
            "http://127.0.0.1:8080/requests/status.json",
        )
        self.assertEqual(
            build_status_url("http://localhost"),
            "http://localhost:8080/requests/status.json",
        )

    def test_auth_header_is_basic_with_empty_user(self):
        import base64
        self.assertEqual(
            auth_header("pw"),
            "Basic " + base64.b64encode(b":pw").decode("ascii"),
        )

    def test_command_url(self):
        base = "http://127.0.0.1:8080/requests/status.json"
        self.assertEqual(
            build_command_url(base, "pl_next"),
            base + "?command=pl_next",
        )
        self.assertEqual(
            build_command_url(base, "seek", val="10"),
            base + "?command=seek&val=10",
        )
        # Values are percent-encoded.
        self.assertNotIn(" ", build_command_url(base, "seek", val="1 2"))


if __name__ == "__main__":
    unittest.main()
