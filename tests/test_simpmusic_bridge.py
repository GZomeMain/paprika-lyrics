import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from core.simpmusic_bridge import SimpMusicBridge, SIMPMUSIC_IPC_PORT, SIMPMUSIC_COMMAND_PORT


class FakeWindow:
    class _Native:
        Handle = 0x140000
    native = _Native()

    def __init__(self):
        self.js_calls = []

    def evaluate_js(self, script: str):
        self.js_calls.append(script)


class SimpMusicBridgeTest(unittest.TestCase):
    def setUp(self):
        self.shutdown_event = threading.Event()
        self.bridge = SimpMusicBridge(self.shutdown_event)
        self.fake_window = FakeWindow()
        self.bridge.set_window(self.fake_window, None)
        self.bridge.start()
        time.sleep(0.1)

    def tearDown(self):
        self.bridge.stop()
        self.shutdown_event.set()

    def test_ping_endpoint_reports_status_and_marks_connected(self):
        url = f"http://127.0.0.1:{SIMPMUSIC_IPC_PORT}/ping"
        with urlopen(url, timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(data.get("status"), "ok")
            self.assertEqual(data.get("app"), "PaprikaLyrics")
            self.assertIn("hwnd", data)
            self.assertIn("docked", data)
            self.assertTrue(self.bridge.is_connected)

    def test_window_dock_and_undock_flow(self):
        url = f"http://127.0.0.1:{SIMPMUSIC_IPC_PORT}/window"

        # 1. Dock action
        dock_payload = json.dumps({
            "action": "dock",
            "parentHwnd": 0x200000,
            "x": 0,
            "y": 0,
            "width": 800,
            "height": 600,
        }).encode("utf-8")
        req = Request(url, data=dock_payload, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)
            res_data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(res_data.get("status"), "ok")

        self.assertTrue(self.bridge.is_docked)
        self.assertEqual(self.bridge.parent_hwnd, 0x200000)

        # 2. Resize action
        resize_payload = json.dumps({
            "action": "resize",
            "x": 0,
            "y": 0,
            "width": 1024,
            "height": 768,
        }).encode("utf-8")
        req = Request(url, data=resize_payload, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)
            res_data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(res_data.get("status"), "ok")

        # 3. Undock action
        undock_payload = json.dumps({
            "action": "undock",
            "x": 100,
            "y": 100,
            "width": 900,
            "height": 600,
            "onTop": False,
        }).encode("utf-8")
        req = Request(url, data=undock_payload, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)
            res_data = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(res_data.get("status"), "ok")

        self.assertFalse(self.bridge.is_docked)
        self.assertIsNone(self.bridge.parent_hwnd)

    def test_sync_playhead_updates_ui(self):
        url = f"http://127.0.0.1:{SIMPMUSIC_IPC_PORT}/sync_playhead"
        payload = json.dumps({"positionMs": 45000, "isPlaying": True}).encode("utf-8")
        req = Request(url, data=payload, headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=2.0) as resp:
            self.assertEqual(resp.status, 200)

        # Verify JS push was called
        calls = "".join(self.fake_window.js_calls)
        self.assertIn("window.syncPlayhead(45000.0, 'soft')", calls)
        self.assertIn("window.setPlaybackState(true)", calls)

    def test_send_command_to_simpmusic_port(self):
        # Spin up a mock command receiver on port 28796
        received_commands = []

        class MockCmdHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                clen = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(clen).decode("utf-8")
                received_commands.append(json.loads(body))
                self.send_response(200)
                self.end_headers()

        mock_server = ThreadingHTTPServer(("127.0.0.1", SIMPMUSIC_COMMAND_PORT), MockCmdHandler)
        t = threading.Thread(target=mock_server.serve_forever, daemon=True)
        t.start()

        try:
            ok = self.bridge.send_command("toggle_playback")
            self.assertTrue(ok)
            ok_seek = self.bridge.send_command("seek", positionMs=32000)
            self.assertTrue(ok_seek)

            self.assertEqual(len(received_commands), 2)
            self.assertEqual(received_commands[0]["action"], "toggle_playback")
            self.assertEqual(received_commands[1]["action"], "seek")
            self.assertEqual(received_commands[1]["positionMs"], 32000)
        finally:
            mock_server.shutdown()
            mock_server.server_close()


if __name__ == "__main__":
    unittest.main()
