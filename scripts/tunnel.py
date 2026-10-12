#!/usr/bin/env python3
"""Open a Gradio share tunnel (https://*.gradio.live) to the local OpenReader server.

Usage: .venv/bin/python scripts/tunnel.py [port]
Prints the public URL and keeps the tunnel alive until killed.
"""
import os
import secrets
import sys
import time

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

# The sandbox's NO_PROXY contains bracketed IPv6 literals that break httpx's
# URL parsing; a simple value is all the tunnel needs.
os.environ["NO_PROXY"] = "localhost,127.0.0.1"
os.environ["no_proxy"] = "localhost,127.0.0.1"

from gradio import networking

share_token = secrets.token_urlsafe(32)
url = networking.setup_tunnel(
    local_host="127.0.0.1",
    local_port=port,
    share_token=share_token,
    share_server_address=None,
    share_server_tls_certificate=None,
)
print(f"PUBLIC URL: {url}", flush=True)
with open("PUBLIC_URL.txt", "w") as f:
    f.write(url + "\n")
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    pass
