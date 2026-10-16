/**
 * PR B, B0/B6: measure FlyTab's main-thread work per incoming Stratux message,
 * in desktop Chromium against tools/mock-stratux.py. Counts (calls per second)
 * compare fairly before/after a change; absolute timings are desktop, not the
 * tablet's.
 *
 *   python3 tools/mock-stratux.py --traffic 100 --situation-hz 10 --traffic-interval 1
 *   (cd web && python3 -m http.server 8124)
 *   NODE_PATH=node_modules node tools/perf-b0.e2e.js [--secs 60] [--zoom 12] [--out /tmp/b0.json]
 *
 * Sim mode is switched on through the user-override key (flypi_user_cockpit)
 * inside a fresh browser profile -- no repo file is edited. A three-waypoint
 * route along the mock's own-ship track is applied so the route table works.
 */
const { chromium } = require('playwright');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1]]]) : a), []));
const SECS = Number(args.secs) || 60;
const BASE = args.base || 'http://localhost:8124';
const OUT = args.out || null;
const ZOOM = args.zoom ? Number(args.zoom) : null;   // default: the app's own zoom

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({ simMode: true, simBridgeIp: 'localhost', simBridgePort: 5678 }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${BASE}/index.html`);

    // Wait for the cockpit (engine, map, route table, vector layers).
    await page.waitForFunction(() => window.app?.routeTable && window.app?.vectorLayers && window.app?.cockpitMap?.map, null, { timeout: 180_000 });

    // A route along the mock's own-ship track (35.0N, -80.0W, heading east).
    await page.evaluate(() => window.app.applyRouteEdit({
        name: 'B0', waypoints: [
            { icao: 'B0A', id: 'B0A', name: 'B0A', lat: 35.0, lon: -80.3 },
            { icao: 'B0B', id: 'B0B', name: 'B0B', lat: 35.0, lon: -79.5 },
            { icao: 'B0C', id: 'B0C', name: 'B0C', lat: 35.1, lon: -78.8 },
        ],
    }));
    await page.waitForTimeout(15_000);   // settle: connections up, traffic populated
    if (ZOOM != null) {
        // After the settle: the route's fit-to-bounds would otherwise undo it.
        await page.evaluate((z) => window.app.cockpitMap.map.setZoom(z, { animate: false }), ZOOM);
        await page.waitForTimeout(5_000);
        const z = await page.evaluate(() => window.app.cockpitMap.map.getZoom());
        if (Math.abs(z - ZOOM) > 0.01) throw new Error(`zoom ${ZOOM} did not hold (map is at ${z})`);
    }

    // Instrument: wrap the hot paths, count calls.
    const setup = await page.evaluate(() => {
        const c = window.__b0 = { setIcon: 0, moveend: 0, dynLayers: 0, updateLive: 0, situation: 0, traffic: 0, longTasks: 0, longTaskMs: 0 };
        const wrap = (obj, name, key) => {
            const orig = obj[name];
            obj[name] = function (...a) { c[key]++; return orig.apply(this, a); };
        };
        wrap(L.Marker.prototype, 'setIcon', 'setIcon');
        wrap(window.app.vectorLayers, '_updateDynamicLayers', 'dynLayers');
        wrap(window.app.routeTable, 'updateLive', 'updateLive');
        window.app.cockpitMap.map.on('moveend', () => c.moveend++);
        window.app.stratuxClient.addEventListener('stratux:situation', () => c.situation++);
        window.app.stratuxClient.addEventListener('stratux:traffic', () => c.traffic++);
        new PerformanceObserver((l) => { for (const e of l.getEntries()) { c.longTasks++; c.longTaskMs += e.duration; } })
            .observe({ type: 'longtask' });
        return {
            routeWaypoints: window.app.routeTable._waypoints?.length ?? null,
            trafficMarkers: window.app.cockpitMap.trafficMarkers?.size ?? null,
            autoPan: window.app.cockpitMap._autoPan,
            version: typeof FLYTAB_VERSION !== 'undefined' ? FLYTAB_VERSION : null,
        };
    });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const m0 = await metric();
    await page.waitForTimeout(SECS * 1000);
    const m1 = await metric();
    const c = await page.evaluate(() => ({ ...window.__b0, trafficMarkers: window.app.cockpitMap.trafficMarkers?.size ?? null }));

    const per = (n) => Math.round((n / SECS) * 10) / 10;
    const result = {
        version: setup.version, secs: SECS, zoom: await page.evaluate(() => window.app.cockpitMap.map.getZoom()), routeWaypoints: setup.routeWaypoints, autoPan: setup.autoPan,
        trafficMarkers: c.trafficMarkers,
        in_situation_per_s: per(c.situation),
        in_traffic_per_s: per(c.traffic),
        setIcon_per_s: per(c.setIcon),
        moveend_per_s: per(c.moveend),
        updateDynamicLayers_per_min: Math.round(c.dynLayers * 60 / SECS),
        routeTable_updateLive_per_s: per(c.updateLive),
        longTasks_per_min: Math.round(c.longTasks * 60 / SECS),
        longTask_ms_per_min: Math.round(c.longTaskMs * 60 / SECS),
        script_s_per_min: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 60 / SECS * 100) / 100,
        task_s_per_min: Math.round((m1.TaskDuration - m0.TaskDuration) * 60 / SECS * 100) / 100,
        layout_s_per_min: Math.round((m1.LayoutDuration - m0.LayoutDuration) * 60 / SECS * 100) / 100,
        style_s_per_min: Math.round((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 60 / SECS * 100) / 100,
        pageErrors: errors.slice(0, 5),
    };
    console.log(JSON.stringify(result, null, 2));
    if (OUT) require('fs').writeFileSync(OUT, JSON.stringify(result, null, 2));
    await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
