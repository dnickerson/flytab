// tests/smoke/helpers.js
'use strict';

// Minimal NASR bundle that the app can import quickly.
// Contains enough data for smoke tests (KLKR airport, MRB VOR, CLT Class C airspace).
const MINIMAL_NASR_BUNDLE = JSON.stringify({
    cycle_info: {
        effective_date: '2026-05-14', expiration_date: '2026-06-11',
        bundle_version: 4, sua_count: 0,
    },
    airports: [
        { icao: 'KLKR', lat: 34.9, lon: -81.1, name: 'Lancaster', state: 'SC', elevation_ft: 573 },
        { icao: 'KCLT', lat: 35.2, lon: -80.9, name: 'Charlotte Douglas', state: 'NC', elevation_ft: 748 },
        { icao: 'KJFK', lat: 40.6, lon: -73.8, name: 'John F Kennedy Intl', state: 'NY', elevation_ft: 13 },
    ],
    navaids: [
        { id: 'MRB', lat: 39.4, lon: -77.9, type: 'VOR', freq: 117.0, name: 'Martinsburg' },
    ],
    airways: [
        { name: 'V143', waypoints: [{ id: 'MRB' }, { id: 'ETX' }] },
    ],
    airspace: [
        { id: 'CLT-C', type: 'C', lat: 35.21, lon: -80.95, floor: 0, ceiling: 4100,
          coords: [[35.3, -81.1], [35.3, -80.7], [35.1, -80.7], [35.1, -81.1], [35.3, -81.1]] },
    ],
    sua: [],
    fixes: [],
});

const MINIMAL_CYCLE_INFO = JSON.stringify({
    effective_date: '2026-05-14', expiration_date: '2026-06-11',
    sua_count: 0, bundle_version: 4,
});

/**
 * Set up route intercepts for a smoke test page before page.goto().
 *
 * Intercepts:
 *   cockpit-config.json     -> test config pointing at local mock servers
 *   any /nasr/bundle.json   -> minimal NASR bundle (fast import, avoids ~18MB real bundle)
 *   any /nasr/cycle_info.json -> matching cycle info so import doesn't re-run unnecessarily
 *
 * Key cockpit-config fields (verified against web/shared/cockpit-config.js):
 *   homeServer.base  -> CockpitConfig.homeBase — used for NASR/CIFP bundle fallback
 *   simMode          -> StratuxClient uses X-Plane bridge instead of real Stratux
 *   simBridgeIp/Port -> X-Plane bridge address (only used when simMode: true)
 *
 * Engine WebSocket (EngineClient default: 192.168.10.1:8082):
 *   Chrome's Private Network Access policy blocks ws:// to private IPs from localhost,
 *   so routeWebSocket() cannot intercept it. Instead, the smoke project's launchOptions
 *   add --host-rules=MAP 192.168.10.1 127.0.0.1 so the real IP resolves to localhost,
 *   where fake-engine.js is listening on :8082 (started by global-setup.js).
 *   No per-test setup needed for engine — it works automatically.
 */
async function injectTestConfig(page) {
    const testConfig = {
        homeServer:      { base: 'http://localhost:8090' },
        simMode:         true,
        simBridgeIp:     '127.0.0.1',
        simBridgePort:   5678,
        // fake-engine HTTP runs on 8081 (port 8080 is reserved for the dev web server).
        // EngineClient reads this via CockpitConfig.raw.engineHttpPort so HTTP
        // fallback reaches fake-engine instead of the dev server.
        engineHttpPort:  8081,
    };

    // cockpit-config.json is fetched relative to the HTML page (/web/index.html),
    // resolving to http://localhost:3000/web/cockpit-config.json.
    await page.route('**/cockpit-config.json', route => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(testConfig),
        });
    });

    // Intercept NASR data endpoints to serve a minimal bundle instead of the real one.
    // The app tries localhost:9090 (NanoHTTPD) first, then CockpitConfig.homeBase (:8090).
    // Both sources are intercepted by the wildcard pattern.
    await page.route('**/nasr/bundle.json', route => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: MINIMAL_NASR_BUNDLE,
        });
    });
    await page.route('**/nasr/cycle_info.json', route => {
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: MINIMAL_CYCLE_INFO,
        });
    });
}

/**
 * Clear IndexedDB between tests to ensure clean import state.
 * Must be called AFTER page.goto() — the page must have an origin to access IDB.
 * In most smoke tests this is not needed (Playwright gives each test a fresh context).
 */
async function clearIdb(page) {
    await page.evaluate(async () => {
        const dbs = await indexedDB.databases?.() ?? [];
        await Promise.all(dbs.map(d => new Promise((res, rej) => {
            const req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = res;
            req.onerror   = rej;
        })));
    });
}

module.exports = { injectTestConfig, clearIdb };
