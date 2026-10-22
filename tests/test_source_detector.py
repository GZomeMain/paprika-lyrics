import unittest
from core.source_detector import detect_source, SourceInfo

class SourceDetectorTest(unittest.TestCase):
    def test_spotify_desktop(self):
        info = detect_source("Spotify.exe")
        self.assertEqual(info.id, "spotify")
        self.assertEqual(info.group, "spotify")
        self.assertEqual(info.name, "Spotify")
        self.assertEqual(info.icon, "spotify")
        self.assertEqual(info.default_latency_ms, 0)
        self.assertFalse(info.is_browser)

    def test_spotify_store_app(self):
        info = detect_source("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify")
        self.assertEqual(info.id, "spotify")
        self.assertEqual(info.group, "spotify")

    def test_simpmusic(self):
        info = detect_source("com.brahmkshatriya.simpmusic")
        self.assertEqual(info.id, "simpmusic")
        self.assertEqual(info.group, "simpmusic")
        self.assertEqual(info.name, "SimpMusic")
        self.assertEqual(info.default_latency_ms, 120)

    def test_chrome_generic_and_youtube(self):
        info = detect_source("Google.Chrome.ABC123", title="Lo-Fi Beats")
        self.assertEqual(info.group, "browser")
        self.assertEqual(info.name, "Chrome Media")
        self.assertTrue(info.is_browser)
        self.assertEqual(info.default_latency_ms, 180)

        info_yt = detect_source("chrome.exe", title="Queen - Bohemian Rhapsody (Official Video) - YouTube")
        self.assertEqual(info_yt.group, "browser")
        self.assertEqual(info_yt.icon, "youtube")
        self.assertEqual(info_yt.name, "YouTube (Chrome)")

    def test_edge_and_firefox(self):
        info_edge = detect_source("msedge.exe", title="Song - YouTube")
        self.assertEqual(info_edge.icon, "youtube")
        self.assertEqual(info_edge.name, "YouTube (Edge)")

        info_ff = detect_source("firefox.exe")
        self.assertEqual(info_ff.group, "browser")
        self.assertEqual(info_ff.name, "Firefox Media")

    def test_vlc(self):
        info = detect_source("C:\\Program Files\\VideoLAN\\VLC\\vlc.exe")
        self.assertEqual(info.id, "vlc")
        self.assertEqual(info.group, "vlc")
        self.assertEqual(info.name, "VLC Media Player")

    def test_apple_music(self):
        info = detect_source("AppleInc.AppleMusicWin_nzyj5cxqqttg4!App")
        self.assertEqual(info.id, "apple_music")
        self.assertEqual(info.group, "apple_music")
        self.assertEqual(info.name, "Apple Music")

    def test_foobar(self):
        info = detect_source("foobar2000.exe")
        self.assertEqual(info.id, "foobar2000")
        self.assertEqual(info.group, "local")

    def test_generic_fallback(self):
        info = detect_source("MyCustomPlayer.exe")
        self.assertEqual(info.id, "generic")
        self.assertEqual(info.name, "Mycustomplayer")

        info_empty = detect_source("")
        self.assertEqual(info_empty.id, "generic")
        self.assertEqual(info_empty.name, "Media Player")

if __name__ == "__main__":
    unittest.main()
