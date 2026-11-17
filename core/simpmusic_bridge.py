"""SimpMusic Direct IPC Bridge for Paprika Lyrics.

Provides high-speed, local bidirectional synchronization between SimpMusic (JVM)
and Paprika Lyrics (Python / WebView2).
- SimpMusic -> Paprika: Track transitions, album art, duration, playhead timeline (syncPlayhead)
- Paprika -> SimpMusic: Transport commands (seek, toggle_playback, next, previous)
- Window management: Dock into parent HWND, undock to floating overlay, toggle mini player, toggle fullscreen
"""
from __future__ import annotations

import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

from config import default_latency_for, debug_log
from core.beat import build_beat_plan
from core.lyrics import fetch_lyrics
from core.native_window import dock_to_parent, undock_from_parent, resize_docked, hwnd_for
from storage import CACHE

SIMPMUSIC_IPC_PORT = 28795
SIMPMUSIC_COMMAND_PORT = 28796


class SimpMusicBridge:
    """Manages the HTTP IPC server connecting SimpMusic directly to Paprika Lyrics."""

    def __init__(self, shutdown_signal: threading.Event):
        self.shutdown_signal = shutdown_signal
        self.window = None
        self.window_api = None
        self.server = None
        self.server_thread = None
        self.is_connected = False
        self.last_track_sig = None
        self.request_generation = 0
        self.is_docked = False
        self.parent_hwnd = None
        self._lock = threading.Lock()

    def set_window(self, window, window_api):
        self.window = window
        self.window_api = window_api

    def _push_js(self, script: str):
        if not self.window:
            return
        try:
            self.window.evaluate_js(script)
        except Exception as exc:
            debug_log("[SimpMusicBridge] evaluate_js failed:", exc)

    def start(self):
        """Starts the local HTTP server on port 28795."""
        bridge_self = self

        class RequestHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass  # Silence normal access logs

            def _send_json(self, status_code: int, data: dict):
                body = json.dumps(data).encode("utf-8")
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(body)

            def do_OPTIONS(self):
                self.send_response(200)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.end_headers()

            def do_GET(self):
                if self.path == "/ping":
                    bridge_self.is_connected = True
                    hwnd = hwnd_for(bridge_self.window) if bridge_self.window else 0
                    is_mini = getattr(bridge_self.window_api, "_mini", False) if bridge_self.window_api else False
                    is_fs = getattr(bridge_self.window_api, "_fullscreen", False) if bridge_self.window_api else False
                    self._send_json(200, {
                        "status": "ok",
                        "app": "PaprikaLyrics",
                        "hwnd": hwnd,
                        "mini": is_mini,
                        "fullscreen": is_fs,
                        "docked": bridge_self.is_docked,
                    })
                else:
                    self._send_json(404, {"error": "Not Found"})

            def do_POST(self):
                content_length = int(self.headers.get("Content-Length", 0))
                raw_body = self.rfile.read(content_length) if content_length > 0 else b"{}"
                try:
                    data = json.loads(raw_body.decode("utf-8")) if raw_body else {}
                except Exception:
                    data = {}

                if self.path == "/sync_track":
                    bridge_self.handle_sync_track(data)
                    self._send_json(200, {"status": "ok"})
                elif self.path == "/sync_playhead":
                    bridge_self.handle_sync_playhead(data)
                    self._send_json(200, {"status": "ok"})
                elif self.path == "/window":
                    res = bridge_self.handle_window_action(data)
                    self._send_json(200, {"status": "ok", "result": res})
                elif self.path == "/shutdown":
                    bridge_self.shutdown_signal.set()
                    if bridge_self.window:
                        bridge_self.window.destroy()
                    self._send_json(200, {"status": "ok"})
                else:
                    self._send_json(404, {"error": "Not Found"})

        try:
            self.server = ThreadingHTTPServer(("127.0.0.1", SIMPMUSIC_IPC_PORT), RequestHandler)
            self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
            self.server_thread.start()
            debug_log(f"[SimpMusicBridge] Server listening on http://127.0.0.1:{SIMPMUSIC_IPC_PORT}")
        except Exception as exc:
            debug_log(f"[SimpMusicBridge] Failed to bind port {SIMPMUSIC_IPC_PORT}:", exc)

    def stop(self):
        if self.server:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass
            self.server = None

    def handle_sync_track(self, data: dict):
        title = data.get("title", "").strip()
        artist = data.get("artist", "").strip()
        album = data.get("album", "").strip()
        duration_ms = int(data.get("durationMs", 0) or 0)
        artwork_url = data.get("artworkUrl")
        position_ms = float(data.get("positionMs", 0.0) or 0.0)
        is_playing = bool(data.get("isPlaying", False))

        if not title and not artist:
            return

        self.is_connected = True
        track_sig = f"{title}:{artist}:{duration_ms}"

        with self._lock:
            if track_sig != self.last_track_sig:
                self.last_track_sig = track_sig
                self.request_generation += 1
                gen = self.request_generation

                # Update UI immediately with spinner, cover art & duration
                self._push_js(f"window.showLoading({json.dumps(title)}, {json.dumps(artist)});\n")
                if artwork_url:
                    self._push_js(f"window.setCoverArt({json.dumps(artwork_url)}, false);\n")
                if duration_ms > 0:
                    self._push_js(f"window.setTrackDuration({duration_ms});\n")
                self._push_js(f"window.setPlaybackState({str(is_playing).lower()});\n")

                def _async_resolve():
                    debug_log(f"[SimpMusicBridge] Fetching lyrics for '{title}' - '{artist}'...")
                    try:
                        lines, source, track_id, diagnostics = fetch_lyrics(
                            title, artist, duration_ms, album, "SimpMusic"
                        )
                    except Exception as exc:
                        debug_log("[SimpMusicBridge] fetch_lyrics error:", exc)
                        lines, source, track_id, diagnostics = [], "None", track_sig, {}

                    if gen != self.request_generation or self.shutdown_signal.is_set():
                        return

                    track_key = track_id or track_sig
                    stored_offset = CACHE.get_latency(track_key, None)
                    saved_offset = (
                        stored_offset if stored_offset is not None
                        else default_latency_for(diagnostics.get("cache"))
                    )

                    try:
                        beat_plan = build_beat_plan(lines)
                    except Exception:
                        beat_plan = None

                    lines_json = json.dumps(lines)
                    attr_dict = diagnostics.get("attribution") or {}
                    attr_json = json.dumps(attr_dict)

                    self._push_js(
                        f"window.loadLyrics("
                        f"{lines_json}, "
                        f"{json.dumps(title)}, "
                        f"{json.dumps(artist)}, "
                        f"{json.dumps(source)}, "
                        f"{position_ms}, "
                        f"{json.dumps(track_key)}, "
                        f"{saved_offset}, "
                        f"{json.dumps(beat_plan)}, "
                        f"{json.dumps(stored_offset is None)});\n"
                    )
                    self._push_js(f"window.setAttribution({attr_json});\n")
                    self._push_js(f"window.setDiagnostics({json.dumps(diagnostics)});\n")
                    self._push_js(f"window.setPlaybackState({str(is_playing).lower()});\n")
                    self._push_js(f"window.syncPlayhead({position_ms}, 'snap');\n")

                threading.Thread(target=_async_resolve, daemon=True).start()
            else:
                self._push_js(f"window.setPlaybackState({str(is_playing).lower()});\n")
                self._push_js(f"window.syncPlayhead({position_ms}, 'snap');\n")

    def handle_sync_playhead(self, data: dict):
        self.is_connected = True
        position_ms = float(data.get("positionMs", 0.0) or 0.0)
        is_playing = bool(data.get("isPlaying", False))
        self._push_js(f"window.setPlaybackState({str(is_playing).lower()});\n")
        self._push_js(f"window.syncPlayhead({position_ms}, 'soft');\n")

    def handle_window_action(self, data: dict) -> bool:
        action = data.get("action", "")
        self.is_connected = True
        if action == "dock":
            parent_hwnd = int(data.get("parentHwnd", 0))
            x = int(data.get("x", 0))
            y = int(data.get("y", 0))
            w = int(data.get("width", 800))
            h = int(data.get("height", 600))
            if parent_hwnd and self.window:
                ok = dock_to_parent(self.window, parent_hwnd, x, y, w, h)
                if ok:
                    self.is_docked = True
                    self.parent_hwnd = parent_hwnd
                return ok
        elif action == "resize":
            x = int(data.get("x", 0))
            y = int(data.get("y", 0))
            w = int(data.get("width", 800))
            h = int(data.get("height", 600))
            if self.is_docked and self.window:
                return resize_docked(self.window, x, y, w, h)
            elif self.window_api:
                self.window_api.resize_window(w, h)
                return True
        elif action == "undock":
            x = int(data.get("x", 100))
            y = int(data.get("y", 100))
            w = int(data.get("width", 900))
            h = int(data.get("height", 600))
            ontop = bool(data.get("onTop", False))
            if self.window:
                ok = undock_from_parent(self.window, x, y, w, h, ontop)
                if ok:
                    self.is_docked = False
                    self.parent_hwnd = None
                return ok
        elif action == "mini":
            if self.window_api:
                cur_mini = getattr(self.window_api, "_mini", False)
                return self.window_api.set_mini_mode(not cur_mini)
        elif action == "fullscreen":
            if self.window_api:
                return self.window_api.toggle_fullscreen()
        elif action == "settings":
            self._push_js("toggleSettings();\n")
            return True
        elif action == "show":
            if self.window:
                self.window.show()
                return True
        elif action == "hide":
            if self.window:
                self.window.hide()
                return True
        return False

    def send_command(self, action: str, **params) -> bool:
        """Sends player actions back to SimpMusic via port 28796."""
        try:
            payload = {"action": action, **params}
            body = json.dumps(payload).encode("utf-8")
            req = Request(
                f"http://127.0.0.1:{SIMPMUSIC_COMMAND_PORT}/command",
                data=body,
                headers={"Content-Type": "application/json"},
            )
            with urlopen(req, timeout=1.0) as resp:
                return resp.status == 200
        except Exception as exc:
            debug_log("[SimpMusicBridge] send_command failed:", exc)
            return False
