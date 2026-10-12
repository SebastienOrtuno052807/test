#!/bin/bash
# Serve OpenReader publicly via a Gradio share tunnel (https://*.gradio.live).
# Usage: scripts/serve-public.sh
# Writes the public URL to PUBLIC_URL.txt when the tunnel is up.
# Note: the link is temporary — it lives only while this machine's server and
# tunnel processes are running. Re-run this script after a VM restart.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${OPENREADER_PORT:-8765}"

pkill -f "[u]vicorn backend.app:app" 2>/dev/null || true
pkill -f "[t]unnel.py" 2>/dev/null || true
pkill -f "[f]rpc_linux" 2>/dev/null || true
sleep 1

cd "$ROOT"
nohup .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port "$PORT" \
  > /tmp/openreader-server.log 2>&1 &
echo "server starting on 127.0.0.1:$PORT"
for i in $(seq 1 15); do
  curl -s -m 2 "http://127.0.0.1:$PORT/api/stats" > /dev/null 2>&1 && break
  sleep 1
done

nohup .venv/bin/python scripts/tunnel.py "$PORT" > /tmp/openreader-tunnel.log 2>&1 &
echo "tunnel starting..."

for i in $(seq 1 45); do
  if [ -s "$ROOT/PUBLIC_URL.txt" ]; then
    echo "PUBLIC URL: $(cat "$ROOT/PUBLIC_URL.txt")"
    exit 0
  fi
  sleep 2
done
echo "Tunnel did not come up. Check /tmp/openreader-tunnel.log"
tail -20 /tmp/openreader-tunnel.log
exit 1
