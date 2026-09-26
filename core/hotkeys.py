import ctypes
from ctypes import wintypes
import threading

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

# Win32 Constants
MOD_CONTROL = 0x0002
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312
WM_QUIT = 0x0012

# Fallback Virtual-Key codes for '[' and ']' on US/standard keyboards
VK_OEM_4 = 0xDB  # '[' key
VK_OEM_6 = 0xDD  # ']' key


def _vk_for_char(ch: str) -> int | None:
    """
    Resolves the current keyboard layout's virtual-key code for a character.
    Non-US layouts place brackets on different physical keys, so hardcoding the
    OEM scan codes silently breaks the shortcut for those users.
    """
    try:
        user32.VkKeyScanW.restype = ctypes.c_short
        user32.VkKeyScanW.argtypes = [ctypes.c_wchar]
        scan = user32.VkKeyScanW(ch)
    except Exception:
        return None
    if scan is None or scan == -1:
        return None
    return scan & 0xFF

HOTKEY_DEC_ID = 1
HOTKEY_INC_ID = 2
HOTKEY_CLICKTHROUGH_ID = 3

MOD_SHIFT = 0x0004
VK_T = 0x54  # 'T' is on the same physical key on essentially every layout

class GlobalHotkeyManager:
    """
    Listens for system-wide shortcuts (Ctrl + [ , Ctrl + ] , Ctrl + Shift + T) using
    Windows user32 APIs. Runs on an independent daemon thread without blocking the
    GUI or event loops.

    Ctrl + Shift + T is the escape hatch for click-through mode: once the window
    ignores mouse input, a global shortcut is the only way back out.
    """

    def __init__(self, on_adjust_callback, on_toggle_click_through=None):
        self.on_adjust_callback = on_adjust_callback
        self.on_toggle_click_through = on_toggle_click_through
        # Set once the OS confirms the binding. Click-through is refused while
        # this is False, so the window can never become mouse-proof with no exit.
        self.click_through_bound = False
        # Whether Ctrl+[ / Ctrl+] bound globally. The UI reads this (via the
        # bridge) to decide whether it must also handle those keys itself:
        # RegisterHotKey does not consume the keystroke, so handling them in
        # both places applied every nudge twice while the overlay was focused.
        self.sync_bound = False
        self.thread: threading.Thread | None = None
        self.thread_id: int | None = None
        self._stop_event = threading.Event()
        # Set once the registrations above have been attempted, so start() can
        # guarantee the binding flags are meaningful before the UI reads them.
        self._ready = threading.Event()

    def start(self):
        self.thread = threading.Thread(target=self._message_pump, daemon=True)
        self.thread.start()
        # Give the registrations a moment to complete so callers (and the UI)
        # never see an unset binding state. Registration itself does not block.
        self._ready.wait(timeout=1.0)

    def stop(self):
        self._stop_event.set()
        if self.thread_id:
            user32.PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0)
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=0.6)

    def _message_pump(self):
        self.thread_id = kernel32.GetCurrentThreadId()

        # Register Ctrl + [ and Ctrl + ], preferring the active layout's mapping.
        vk_left = _vk_for_char('[')
        vk_right = _vk_for_char(']')
        if vk_left is None:
            vk_left = VK_OEM_4
        if vk_right is None:
            vk_right = VK_OEM_6

        ok1 = user32.RegisterHotKey(None, HOTKEY_DEC_ID, MOD_CONTROL | MOD_NOREPEAT, vk_left)
        ok2 = user32.RegisterHotKey(None, HOTKEY_INC_ID, MOD_CONTROL | MOD_NOREPEAT, vk_right)
        ok3 = user32.RegisterHotKey(
            None, HOTKEY_CLICKTHROUGH_ID, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, VK_T
        )
        self.click_through_bound = bool(ok3)
        self.sync_bound = bool(ok1 and ok2)
        self._ready.set()

        if not ok1 or not ok2:
            print("ℹ️ [Hotkeys] Notice: Sync shortcuts could not bind (already used by another app). In-window keys still active.")
        if not ok3:
            print("ℹ️ [Hotkeys] Ctrl+Shift+T is unavailable, so click-through mode stays disabled "
                  "(it would leave no way to hand the mouse back).")

        msg = wintypes.MSG()
        while not self._stop_event.is_set():
            # GetMessageW blocks efficiently until a message arrives
            res = user32.GetMessageW(ctypes.byref(msg), None, 0, 0)
            if res == 0 or res == -1:  # WM_QUIT or error
                break

            if msg.message == WM_HOTKEY:
                if msg.wParam == HOTKEY_DEC_ID:
                    self.on_adjust_callback(-50)
                elif msg.wParam == HOTKEY_INC_ID:
                    self.on_adjust_callback(50)
                elif msg.wParam == HOTKEY_CLICKTHROUGH_ID and self.on_toggle_click_through:
                    self.on_toggle_click_through()

        user32.UnregisterHotKey(None, HOTKEY_DEC_ID)
        user32.UnregisterHotKey(None, HOTKEY_INC_ID)
        user32.UnregisterHotKey(None, HOTKEY_CLICKTHROUGH_ID)