# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the OpenReader Windows .exe.

Build on Windows with:  pyinstaller OpenReader.spec --noconfirm
(or just push a v* tag — .github/workflows/build-windows.yml does it for you)
"""
from pathlib import Path

ROOT = Path(SPECPATH)

a = Analysis(
    [str(ROOT / "desktop" / "main.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        (str(ROOT / "static"), "static"),
    ],
    hiddenimports=[
        "backend.app",
        "requests",
        "pypdf",
        "ebooklib",
        "ebooklib.epub",
        "bleach",
        "trafilatura",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="OpenReader",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "desktop" / "icon.ico"),
)
coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="OpenReader",
)
