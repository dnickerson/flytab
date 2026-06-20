#!/bin/bash
# Serve web/ on the local network for browser testing.
# Open http://<this-machine>:8080 after starting.

set -e

PORT=${1:-8080}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$SCRIPT_DIR/web"
HOST_IP="$(hostname -I | awk '{print $1}')"

if lsof -ti:"$PORT" &>/dev/null; then
    echo "Stopping existing server on port $PORT..."
    kill "$(lsof -ti:"$PORT")" 2>/dev/null || true
    sleep 1
fi

trap "echo ''; echo 'Dev server stopped.'; exit 0" INT TERM EXIT

echo ""
echo "FlyTab Dev Server"
echo "================="
echo "  Serving: $WEB_DIR"
echo "  Local:   http://localhost:$PORT"
echo "  Network: http://$HOST_IP:$PORT"
echo ""
echo "Press Ctrl+C to stop."
echo ""

cd "$WEB_DIR"
exec python3 -m http.server "$PORT"
