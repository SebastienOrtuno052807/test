"""OpenReader desktop launcher.

Starts the OpenReader server on a free localhost port and opens it in a
native desktop window (pywebview). Falls back to the system browser if
pywebview isn't installed.
"""
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

# In a windowed (console=False) frozen build, stdout/stderr are None, which
# crashes uvicorn's logging setup. Redirect them to a log file instead.
if sys.stdout is None or sys.stderr is None:
    _log = open(Path.home() / "OpenReader.log", "a", buffering=1)
    if sys.stdout is None:
        sys.stdout = _log
    if sys.stderr is None:
        sys.stderr = _log

# make sure `backend` is importable whether running from source or frozen
if getattr(sys, "frozen", False):
    sys.path.insert(0, sys._MEIPASS)
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for_server(port: int, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=1)
            s.close()
            return True
        except OSError:
            time.sleep(0.2)
    return False


def main() -> None:
    port = int(os.environ.get("OPENREADER_PORT", free_port()))
    os.environ["OPENREADER_PORT"] = str(port)

    import uvicorn
    from backend.app import app

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True, name="openreader-server")
    thread.start()

    url = f"http://127.0.0.1:{port}/"
    if not wait_for_server(port):
        print("OpenReader server failed to start.", file=sys.stderr)
        sys.exit(1)

    try:
        import webview
    except ImportError:
        print("pywebview not installed; opening in your browser instead.")
        webbrowser.open(url)
        thread.join()  # run until Ctrl+C
        return

    webview.create_window(
        "OpenReader",
        url,
        width=1220,
        height=820,
        min_size=(940, 620),
    )
    webview.start()


if __name__ == "__main__":
    main()
