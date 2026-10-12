# OpenReader — Windows desktop app

## The easy way (recommended)

Push a `v*` tag (or run the workflow manually) on GitHub:
**.github/workflows/build-windows.yml** builds `OpenReader.exe` on a real
Windows runner and uploads it as the `OpenReader-windows` artifact.
Download it, unzip, run `OpenReader.exe` — no Python needed.
Your data lives in `%USERPROFILE%\OpenReader`.

A Windows build needs a Windows machine (a Linux box can't emit a real
`.exe`), which is why CI does it.

## Build it yourself on Windows

1. Install Python 3.12 from python.org
2. `pip install -r requirements.txt pywebview pyinstaller`
3. `pyinstaller OpenReader.spec --noconfirm`
4. Run `dist\OpenReader\OpenReader.exe`

The window is powered by Edge WebView2, which ships with Windows 10/11.
