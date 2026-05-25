// tests/fixtures/mock-home-server.js
'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');

const TILES_DIR  = path.join(__dirname, 'tiles');
const PLATES_DIR = path.join(__dirname, 'plates');

const CYCLE_INFO = JSON.stringify({
    effective_date: '2026-05-14', expiration_date: '2026-06-11',
    sua_count: 0, bundle_version: 4,
});

const NASR_BUNDLE = JSON.stringify({
    cycle_info: { effective_date: '2026-05-14', expiration_date: '2026-06-11',
                  bundle_version: 4, sua_count: 0 },
    airports: [
        { icao: 'KLKR', lat: 34.9, lon: -81.1, name: 'Lancaster', state: 'SC', elevation_ft: 573 },
        { icao: 'KCLT', lat: 35.2, lon: -80.9, name: 'Charlotte Douglas', state: 'NC', elevation_ft: 748 },
    ],
    navaids: [
        { id: 'MRB', lat: 39.4, lon: -77.9, type: 'VOR', freq: 117.0, name: 'Martinsburg' },
    ],
    airways: [
        { name: 'V143', waypoints: [{ id: 'MRB' }, { id: 'ETX' }] },
    ],
    airspace: [
        { id: 'CLT-C', type: 'C', lat: 35.21, lon: -80.95, floor: 0, ceiling: 4100,
          coords: [[35.3,-81.1],[35.3,-80.7],[35.1,-80.7],[35.1,-81.1],[35.3,-81.1]] },
    ],
    sua: [],
    fixes: [],
});

const MANIFEST = JSON.stringify({
    nasr:   { effective_date: '2026-05-14', expiration_date: '2026-06-11',
              bundle_version: 4, built_at: '2026-05-14T00:00:00Z' },
    cifp:   { cycle_code: '260514', effective_date: '2026-05-14',
              expiration_date: '2026-06-11', built_at: '2026-05-14T00:00:00Z' },
    plates: { cycle_code: '260514' },
});

const CIFP_BUNDLE  = JSON.stringify({ procedures: {}, cycle_code: '260514' });
const CIFP_CYCLE   = JSON.stringify({ cycle_code: '260514', effective_date: '2026-05-14',
                                      expiration_date: '2026-06-11' });
const PLATE_INDEX  = JSON.stringify({ KLKR: [{ icao: 'KLKR', chart_name: 'ILS OR LOC RWY 9', filename: 'klkr-ils-9.pdf', state: 'SC', cycle_code: '260514' }] });
const TERRAIN_STATUS = JSON.stringify({ exists: false, sizeMb: 0, builtAt: null });

function startMockHomeServer(port) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const p = req.url.split('?')[0];
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/json');

            // NASR
            if (p === '/nasr/cycle_info.json') return send(res, CYCLE_INFO);
            if (p === '/nasr/bundle.json')     return send(res, NASR_BUNDLE);
            // CIFP
            if (p === '/cifp/cifp_bundle.json')     return send(res, CIFP_BUNDLE);
            if (p === '/cifp/cifp_cycle_info.json') return send(res, CIFP_CYCLE);
            // Plates
            if (p === '/plates/plate_index.json') return send(res, PLATE_INDEX);
            // Manifest
            if (p === '/manifest.json') return send(res, MANIFEST);
            // Terrain
            if (p === '/terrain/grid/status') return send(res, TERRAIN_STATUS);

            // Tiles — serve real sample WebP files if present, else 404
            if (p.startsWith('/tiles/')) {
                const tilePath = path.join(TILES_DIR, p.replace('/tiles/', ''));
                if (fs.existsSync(tilePath)) {
                    res.setHeader('Content-Type', 'image/webp');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    return res.end(fs.readFileSync(tilePath));
                }
                res.writeHead(404); return res.end();
            }

            // Plates — serve real sample PDF files if present, else 404
            if (p.startsWith('/plates/') && p.endsWith('.pdf')) {
                const platePath = path.join(PLATES_DIR, path.basename(p));
                if (fs.existsSync(platePath)) {
                    res.setHeader('Content-Type', 'application/pdf');
                    return res.end(fs.readFileSync(platePath));
                }
                res.writeHead(404); return res.end();
            }

            res.writeHead(404); res.end();
        });

        server.on('error', reject);
        server.listen(port, () => resolve(server));
    });
}

function send(res, body) {
    res.end(body);
}

module.exports = { startMockHomeServer };
