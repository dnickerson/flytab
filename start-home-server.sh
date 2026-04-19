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
REPO_ROOT="$SCRIPT_DIR"
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
echo "  Terrain: http://$HOST_IP:$PORT/terrain/status"
echo "  Admin:   http://$HOST_IP:$PORT/admin-states.html"
echo ""
echo "Press Ctrl+C to stop."
echo ""

exec python3 - "$DATA_DIR" "$SCRIPT_DIR/admin-states.html" "$PORT" << 'PYEOF'
import sys, http.server, os, json, struct, math, urllib.parse

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
        '.hgt':  'application/octet-stream',
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

        # ── Terrain endpoints ────────────────────────────────────────────────
        path_only = self.path.split('?')[0]
        if path_only == '/terrain/status':
            self._handle_terrain_status()
            return
        if path_only == '/terrain/tiles-index':
            self._handle_terrain_tiles_index()
            return
        if path_only.startswith('/terrain/tiles/') and path_only.endswith('.hgt'):
            self._handle_terrain_tile(path_only)
            return
        if path_only == '/terrain/profile':
            self._handle_terrain_profile(self.path)
            return
        if path_only == '/terrain/zips/index.json':
            self._handle_terrain_zips_index()
            return
        if path_only.startswith('/terrain/zips/') and path_only.endswith('.zip'):
            self._handle_terrain_zip(path_only)
            return
        if path_only == '/terrain/grid/terrain.json':
            self._handle_terrain_grid_json()
            return
        if path_only == '/terrain/grid/terrain.bin':
            self._handle_terrain_grid_bin()
            return
        if path_only == '/terrain/grid/status':
            self._handle_terrain_grid_status()
            return

        # /cifp/cifp.zip — on-the-fly zip of bundle + cycle_info for fetch-zip download
        if path_only == '/cifp/cifp.zip':
            self._handle_cifp_zip()
            return

        # Everything else served from data/
        super().do_GET()

    # ── Terrain helpers ──────────────────────────────────────────────────────

    def _terrain_dir(self):
        return os.path.join(DATA_DIR, 'terrain', 'srtm')

    def _send_json(self, obj, cache=False):
        data = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        if not cache:
            self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(data)

    def _handle_terrain_status(self):
        tdir = self._terrain_dir()
        tile_count = 0
        total_size = 0
        if os.path.isdir(tdir):
            for fn in os.listdir(tdir):
                if fn.upper().endswith('.HGT'):
                    tile_count += 1
                    total_size += os.path.getsize(os.path.join(tdir, fn))
        self._send_json({
            'tileCount':    tile_count,
            'totalSizeMb':  round(total_size / (1024 * 1024), 1),
            'hasTerrain':   tile_count > 0,
        })

    def _handle_terrain_tiles_index(self):
        tdir = self._terrain_dir()
        names = []
        if os.path.isdir(tdir):
            for fn in os.listdir(tdir):
                if fn.upper().endswith('.HGT'):
                    names.append(os.path.splitext(fn)[0])
        names.sort()
        self._send_json(names)

    def _handle_terrain_tile(self, path):
        # /terrain/tiles/N35W082.hgt
        tile_name = path.rsplit('/', 1)[-1]
        if '..' in tile_name:
            self.send_error(403, 'Forbidden')
            return
        tdir = self._terrain_dir()
        fpath = None
        if os.path.isdir(tdir):
            for fn in os.listdir(tdir):
                if fn.upper() == tile_name.upper():
                    fpath = os.path.join(tdir, fn)
                    break
        if not fpath or not os.path.isfile(fpath):
            self.send_error(404, 'Tile not found: ' + tile_name)
            return
        size = os.path.getsize(fpath)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'public, max-age=86400')
        self.end_headers()
        with open(fpath, 'rb') as f:
            self.wfile.write(f.read())

    def _haversine_nm(self, lat1, lon1, lat2, lon2):
        R = 3440.065  # Earth radius in NM
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2) ** 2
             + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
             * math.sin(dlon / 2) ** 2)
        return 2 * R * math.asin(math.sqrt(max(0, min(1, a))))

    def _srtm_elev(self, lat, lon, tile_cache):
        tile_lat = int(math.floor(lat))
        tile_lon = int(math.floor(lon))
        ns = 'N' if tile_lat >= 0 else 'S'
        ew = 'W' if tile_lon < 0 else 'E'
        fname = f'{ns}{abs(tile_lat):02d}{ew}{abs(tile_lon):03d}.hgt'
        key = (tile_lat, tile_lon)

        if key not in tile_cache:
            tdir = self._terrain_dir()
            fpath = None
            if os.path.isdir(tdir):
                for fn in os.listdir(tdir):
                    if fn.upper() == fname.upper():
                        fpath = os.path.join(tdir, fn)
                        break
            if fpath and os.path.isfile(fpath):
                try:
                    with open(fpath, 'rb') as f:
                        tile_cache[key] = f.read()
                except Exception:
                    tile_cache[key] = None
            else:
                tile_cache[key] = None

        buf = tile_cache[key]
        if buf is None:
            return 0.0

        row = round((tile_lat + 1 - lat) * 3600)
        col = round((lon - tile_lon) * 3600)
        row = max(0, min(3600, row))
        col = max(0, min(3600, col))
        offset = (row * 3601 + col) * 2
        if offset + 2 > len(buf):
            return 0.0
        elev_m = struct.unpack('>h', buf[offset:offset + 2])[0]
        if elev_m == -32768:
            return 0.0
        return elev_m * 3.28084

    def _handle_terrain_profile(self, full_path):
        qs = full_path.split('?', 1)[1] if '?' in full_path else ''
        params = urllib.parse.parse_qs(qs)
        pts_str = params.get('points', [''])[0]

        points = []
        for pair in pts_str.split('|'):
            parts = pair.split(',')
            if len(parts) == 2:
                try:
                    points.append((float(parts[0]), float(parts[1])))
                except ValueError:
                    pass

        if len(points) < 2:
            self._send_json({'profile': []})
            return

        STEP_NM = 2.0
        profile = []
        cum_dist = 0.0
        tile_cache = {}

        for i in range(len(points) - 1):
            lat1, lon1 = points[i]
            lat2, lon2 = points[i + 1]
            seg_dist = self._haversine_nm(lat1, lon1, lat2, lon2)
            if seg_dist < 0.001:
                continue
            steps = max(1, int(math.ceil(seg_dist / STEP_NM)))
            for s in range(steps):
                frac = s / steps
                lat = lat1 + frac * (lat2 - lat1)
                lon = lon1 + frac * (lon2 - lon1)
                dist = cum_dist + frac * seg_dist
                elev = self._srtm_elev(lat, lon, tile_cache)
                profile.append({'dist_nm': round(dist, 2), 'elev_ft': round(elev)})
            cum_dist += seg_dist

        # Final point
        lat2, lon2 = points[-1]
        elev = self._srtm_elev(lat2, lon2, tile_cache)
        profile.append({'dist_nm': round(cum_dist, 2), 'elev_ft': round(elev)})

        self._send_json({'profile': profile})

    def _handle_terrain_zips_index(self):
        idx_path = os.path.join(DATA_DIR, 'terrain', 'zips', 'terrain-index.json')
        if not os.path.isfile(idx_path):
            self.send_error(404, 'terrain-index.json not found')
            return
        with open(idx_path, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(data)

    def _handle_terrain_zip(self, path):
        filename = path.rsplit('/', 1)[-1]
        if '..' in filename or not filename.endswith('.zip'):
            self.send_error(403, 'Forbidden')
            return
        fpath = os.path.join(DATA_DIR, 'terrain', 'zips', filename)
        if not os.path.isfile(fpath):
            self.send_error(404, 'ZIP not found: ' + filename)
            return
        size = os.path.getsize(fpath)
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        CHUNK = 1024 * 1024  # 1 MB
        with open(fpath, 'rb') as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _handle_terrain_grid_status(self):
        json_path = os.path.join(DATA_DIR, 'terrain', 'terrain.json')
        bin_path  = os.path.join(DATA_DIR, 'terrain', 'terrain.bin')
        exists    = os.path.isfile(bin_path) and os.path.isfile(json_path)
        size_mb   = 0.0
        built_at  = None
        if exists:
            size_mb = os.path.getsize(bin_path) / (1024 * 1024)
            try:
                with open(json_path) as f:
                    meta = json.load(f)
                built_at = meta.get('builtAt')
            except Exception:
                pass
        self._send_json({'exists': exists, 'sizeMb': round(size_mb, 1), 'builtAt': built_at})

    def _handle_terrain_grid_json(self):
        fpath = os.path.join(DATA_DIR, 'terrain', 'terrain.json')
        if not os.path.isfile(fpath):
            self.send_error(404, 'terrain.json not found')
            return
        with open(fpath, 'rb') as f:
            data = f.read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(data)

    def _handle_terrain_grid_bin(self):
        fpath = os.path.join(DATA_DIR, 'terrain', 'terrain.bin')
        if not os.path.isfile(fpath):
            self.send_error(404, 'terrain.bin not found')
            return
        size = os.path.getsize(fpath)
        self.send_response(200)
        self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Length', str(size))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        CHUNK = 32 * 1024  # 32 KB
        with open(fpath, 'rb') as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                self.wfile.write(chunk)

    def _handle_cifp_zip(self):
        import io, zipfile as zf
        bundle_path = os.path.join(DATA_DIR, 'cifp', 'cifp_bundle.json')
        cycle_path  = os.path.join(DATA_DIR, 'cifp', 'cifp_cycle_info.json')
        if not os.path.isfile(bundle_path):
            self.send_error(404, 'cifp_bundle.json not found')
            return
        buf = io.BytesIO()
        with zf.ZipFile(buf, 'w', zf.ZIP_DEFLATED) as z:
            z.write(bundle_path,  'cifp/cifp_bundle.json')
            if os.path.isfile(cycle_path):
                z.write(cycle_path, 'cifp/cifp_cycle_info.json')
        data = buf.getvalue()
        self.send_response(200)
        self.send_header('Content-Type', 'application/zip')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(data)

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
