#!/bin/bash
# FlyTab — Home Server Startup Script
#
# Serves tiles, plates, and NASR data over HTTP for the FlyTab Android tablet.
# The tablet connects to http://<this-computer>:8090 to download map data.
# No HTTPS needed — Android doesn't require secure context for HTTP fetches.
#
# Data is served from the shared flypi/data directory.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$(cd "$SCRIPT_DIR/../data" && pwd)"
PORT=8090
HOST_IP="192.168.1.77"

# Verify data directory exists
if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: Data directory not found at $DATA_DIR"
    echo "       Expected flypi/data/ with tiles/, plates/, nasr/ subdirectories"
    exit 1
fi

# Check for required subdirectories
for sub in tiles plates nasr; do
    if [ ! -d "$DATA_DIR/$sub" ]; then
        echo "WARNING: $DATA_DIR/$sub not found — $sub requests will 404"
    fi
done

# Kill any existing server on this port
if lsof -ti:$PORT &>/dev/null; then
    echo "Stopping existing server on port $PORT..."
    kill $(lsof -ti:$PORT) 2>/dev/null || true
    sleep 1
fi

# Clean up on exit
trap "echo ''; echo 'Server stopped.'; exit 0" INT TERM EXIT

echo ""
echo "FlyTab Home Data Server"
echo "======================="
echo "  Serving: $DATA_DIR"
echo "  URL:     http://$HOST_IP:$PORT"
echo ""
echo "  Tiles:   http://$HOST_IP:$PORT/tiles/sectional/{z}/{x}/{y}.webp"
echo "  Plates:  http://$HOST_IP:$PORT/plates/{airport}/"
echo "  NASR:    http://$HOST_IP:$PORT/nasr/bundle.json"
echo ""
echo "  Configure in FlyTab: Settings → Home Network"
echo "  Press Ctrl+C to stop."
echo ""

# Python HTTP server with CORS headers
cd "$DATA_DIR"
exec python3 -c "
import http.server
import os

class CORSHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.webp': 'image/webp',
        '.json': 'application/json',
        '.gz': 'application/gzip',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
    }

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Cache-Control', 'public, max-age=86400')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def log_message(self, format, *args):
        # Compact logging: method + path + status
        msg = format % args
        if '200' in msg or '304' in msg:
            return  # Suppress successful tile fetches to reduce noise
        print(msg)

print(f'Listening on 0.0.0.0:$PORT ...')
server = http.server.ThreadingHTTPServer(('0.0.0.0', $PORT), CORSHandler)
server.serve_forever()
"
