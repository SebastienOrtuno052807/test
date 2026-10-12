#!/usr/bin/env python3
"""Dev launcher: serve OpenReader and open it in your browser."""
import os
import sys
import threading
import webbrowser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn  # noqa: E402
from backend.app import app  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("OPENREADER_PORT", "8765"))
    url = f"http://127.0.0.1:{port}/"
    threading.Timer(1.2, lambda: webbrowser.open(url)).start()
    print(f"OpenReader running at {url}  (Ctrl+C to stop)")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
