# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for Paprika Lyrics.

Build (from the repository root):

    python -m PyInstaller PaprikaLyrics.spec --noconfirm

The result is `dist/PaprikaLyrics/PaprikaLyrics.exe` plus its support folder.

Two decisions worth stating, because both are easy to get wrong:

**onedir, not onefile.** A onefile build unpacks the whole bundle into a temp
directory on every launch, which makes startup noticeably slower and makes the
extracted folder a second place for state to be mistaken for a resource. It also
gives antivirus more to be suspicious of. A onedir build starts faster and keeps
the bundle inspectable, which matters for an unsigned executable.

**The UI is bundled; everything writable is not.** `ui/` is read-only content and
is added as data, and `config.py` reads it from `sys._MEIPASS`. The cache, the
`.env`, the WebView2 profile and the local TTML library are deliberately NOT
bundled — `config.DATA_DIR` puts them beside the executable, because a profile or
a cache unpacked into `%TEMP%` would be recreated from nothing on every launch.

`webview` ships its own platform helpers as data files (the WebView2 loader DLL
and the .NET bridge), so those are collected explicitly rather than hoped for.

**Two shapes, one spec.** Set `PL_ONEFILE=1` and the same analysis produces a
single self-contained executable instead of the folder; the release attaches
both. The trade-off is real and worth stating once: a onefile launch unpacks
the whole bundle into a temp directory every time, so it starts slower, and an
unsigned self-extracting exe attracts more antivirus attention. The switch
lives here rather than in a second spec so that the icon, the excludes, the
hidden imports and the collected data files cannot drift apart between them.
"""

import os

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

datas = [
    # The whole overlay: index.html, app.js, style.css and any assets beside them.
    ("ui", "ui"),
]

# pywebview's WinForms/WebView2 backend needs its native loader and its managed
# assemblies at runtime; neither is importable as a Python module, so PyInstaller
# cannot find them by following imports.
datas += collect_data_files("webview")
binaries = collect_dynamic_libs("webview")

a = Analysis(
    ["paprika_app.py"],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=[
        # Loaded through pywebview's own indirection, not imported by name here.
        "webview.platforms.winforms",
        "webview.platforms.edgechromium",
        # winsdk's generated submodules are resolved at runtime by name.
        "winsdk.windows.media.control",
        "winsdk.windows.storage.streams",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Tk/Qt/notebook are not used by this app; excluding them keeps the build
    # from pulling in tens of megabytes of unrelated GUI toolkits that pywebview
    # can optionally use.
    excludes=[
        "tkinter", "test", "unittest",
        "PyQt5", "PyQt6", "PySide2", "PySide6", "gtk", "gi",
        "matplotlib", "numpy", "PIL", "pandas", "notebook", "IPython",
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

ONEFILE = os.environ.get("PL_ONEFILE", "").strip().lower() in ("1", "true", "yes")

# Both shapes take the same options, from one place, so a change here reaches
# the folder build and the single file together.
COMMON = dict(
    name="PaprikaLyrics",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX-packed binaries are a false-positive magnet for AV.
    console=False,      # A console window would sit behind the overlay.
    disable_windowed_traceback=False,
    icon="assets/icon.ico",
)

if ONEFILE:
    # The archive and every collected file ride inside the exe itself.
    exe = EXE(pyz, a.scripts, a.binaries, a.datas, [], **COMMON)
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        **COMMON,
    )

    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name="PaprikaLyrics",
    )