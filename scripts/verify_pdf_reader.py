#!/usr/bin/env python3
"""Verify the OpenReader PDF reader in headless Chromium via CDP.
Usage: .venv/bin/python scripts/verify_pdf_reader.py
Saves /tmp/or-verify-library.png and /tmp/or-verify-pdf.png, prints console errors.
"""
import base64
import json
import subprocess
import sys
import time
import urllib.request

CHROME = "/opt/meta-chromium/chrome"
# Public tunnel URL (public->public avoids Chrome 152 local-network-access blocks)
APP = "https://da759f858002ab170c.gradio.live/"
DEBUG_PORT = 9223

proc = subprocess.Popen(
    [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
     "--remote-allow-origins=*",
     f"--remote-debugging-port={DEBUG_PORT}", "--window-size=1600,1000",
     APP],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(6)

try:
    import websocket

    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json"))
    page = next(t for t in targets if t["type"] == "page")
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)

    mid = 0
    def send(method, params=None):
        global mid
        mid += 1
        ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.recv())
            if msg.get("id") == mid:
                return msg.get("result", {})

    errors = []
    def drain():
        ws.settimeout(0.2)
        try:
            while True:
                msg = json.loads(ws.recv())
                m = msg.get("method", "")
                if m == "Runtime.exceptionThrown":
                    errors.append("EXC: " + str(msg["params"]["exceptionDetails"].get("text", ""))[:200])
                elif m == "Runtime.consoleAPICalled" and msg["params"]["type"] == "error":
                    errors.append("CONSOLE: " + " ".join(
                        a.get("value", "?") for a in msg["params"]["args"])[:200])
        except Exception:
            pass
        finally:
            ws.settimeout(30)

    send("Runtime.enable")
    send("Page.enable")
    time.sleep(5)  # page was loaded from the command-line URL
    drain()

    def shot(path):
        r = send("Page.captureScreenshot", {"format": "png"})
        open(path, "wb").write(base64.b64decode(r["data"]))
        print("saved", path)

    shot("/tmp/or-verify-library.png")

    # click the first PDF card
    clicked = send("Runtime.evaluate", {"expression": """
        (() => {
          const cards = Array.from(document.querySelectorAll('.card'));
          const pdf = cards.find(c => /pdf|📕/i.test(c.textContent));
          const el = pdf || cards[0];
          if (!el) return 'no-cards';
          el.click();
          return 'clicked:' + (el.querySelector('h3')||{}).textContent;
        })()
        """})["result"]["value"]
    print("card:", clicked)
    time.sleep(10)  # let PDF.js fetch + render first pages
    drain()

    info = send("Runtime.evaluate", {"expression": """
        (() => ({
          pdfReader: !!document.querySelector('#pdf-reader'),
          pages: document.querySelectorAll('.pdf-page').length,
          rendered: document.querySelectorAll('.pdf-page canvas').length,
          canvasesWithSize: Array.from(document.querySelectorAll('.pdf-page canvas'))
            .filter(c => c.width > 100).length,
          toc: (document.querySelector('#toc-items')||{}).textContent?.slice(0,60),
          infoTab: !!document.querySelector('#tab-info h3'),
          nbTab: !!document.querySelector('#tab-notebook'),
          title: (document.querySelector('.pdf-title')||{}).textContent
        }))()
        """})["result"]["value"]
    print("reader state:", json.dumps(info, indent=1)[:600])

    # scroll down to trigger lazy rendering of later pages
    send("Runtime.evaluate", {"expression": "document.querySelector('#pdf-scroll').scrollTop = 3000"})
    time.sleep(6)
    drain()
    shot("/tmp/or-verify-pdf.png")

    print("JS errors:", errors if errors else "none")
    ws.close()
finally:
    proc.terminate()
