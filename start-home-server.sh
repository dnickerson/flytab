#!/bin/bash
# FlyTab — Home Data Server
#
# Serves tiles, plates, NASR, and CIFP over HTTP for the FlyTab Android tablet.
# Also hosts admin-states.html for managing which states the pipeline builds plates for.
#
# Tablet connects to http://<this-computer>:8090
# Admin UI: http://<this-computer>:8090/admin-states.html

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$REPO_ROOT/data"
PORT=8090
HOST_IP="$(hostname -I | awk '{print $1}')"

if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: Data directory not found at $DATA_DIR"
    exit 1
fi

for sub in tiles plates nasr cifp; do
    if [ ! -d "$DATA_DIR/$sub" ]; then
        echo "WARNING: $DATA_DIR/$sub not found — $sub requests will 404"
    fi
done

if lsof -ti:$PORT &>/dev/null; then
    echo "Stopping existing server on port $PORT..."
    kill $(lsof -ti:$PORT) 2>/dev/null || true
    sleep 1
fi

trap "echo ''; echo 'Server stopped.'; exit 0" INT TERM EXIT

echo ""
echo "FlyTab Home Data Server"
echo "======================="
echo "  Data:    $DATA_DIR"
echo "  URL:     http://$HOST_IP:$PORT"
echo ""
echo "  NASR:    http://$HOST_IP:$PORT/nasr/bundle.json"
echo "  Tiles:   http://$HOST_IP:$PORT/tiles/sectional/{z}/{x}/{y}.webp"
echo "  Plates:  http://$HOST_IP:$PORT/plates/{icao}/"
echo "  CIFP:    http://$HOST_IP:$PORT/cifp/cifp_bundle.json"
echo ""
echo "  Admin:   http://$HOST_IP:$PORT/admin-states.html"
echo ""
echo "Press Ctrl+C to stop."
echo ""

exec python3 - "$DATA_DIR" "$SCRIPT_DIR/admin-states.html" "$PORT" << 'PYEOF'
import sys, http.server, os, json

DATA_DIR   = sys.argv[1]
ADMIN_HTML = sys.argv[2]
PORT       = int(sys.argv[3])

WRITABLE_FILES = {
    'plate_states_config.json',
}

class FlyTabHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.webp': 'image/webp',
        '.json': 'application/json',
        '.gz':   'application/gzip',
        '.pdf':  'application/pdf',
        '.png':  'image/png',
        '.html': 'text/html',
        '.mbtiles': 'application/x-sqlite3',
    }

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'public, max-age=3600')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        # Serve admin-states.html from the flytab/ directory
        if self.path == '/admin-states.html':
            try:
                with open(ADMIN_HTML, 'rb') as f:
                    data = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', len(data))
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(data)
            except Exception as e:
                self.send_error(404, str(e))
            return
        # Everything else served from data/
        super().do_GET()

    def do_PUT(self):
        # Allow writing specific config files back to data/
        filename = self.path.lstrip('/')
        if filename not in WRITABLE_FILES:
            self.send_error(403, f'PUT not allowed for {filename}')
            return
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length)
        # Validate JSON
        try:
            json.loads(body)
        except Exception as e:
            self.send_error(400, f'Invalid JSON: {e}')
            return
        dest = os.path.join(DATA_DIR, filename)
        try:
            with open(dest, 'wb') as f:
                f.write(body)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            print(f'[PUT] {filename} saved ({len(body)} bytes)')
        except Exception as e:
            self.send_error(500, str(e))

    def log_message(self, fmt, *args):
        msg = fmt % args
        # Suppress noisy tile 200s
        if '/tiles/' in self.path and '200' in msg:
            return
        print(msg)

os.chdir(DATA_DIR)
print(f'Listening on 0.0.0.0:{PORT} ...')
server = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), FlyTabHandler)
server.serve_forever()
PYEOF
