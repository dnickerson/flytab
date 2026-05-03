/**
 * Playwright Plan-button test using REAL NASR bundle.
 * Imports bundle.json into FlyTabDB, then runs the user's scenario:
 * KRCZ -> KLKR (the route they reported as "Plan does nothing")
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const URL = 'http://localhost:9876/index.html';
const VP  = { width: 1280, height: 800 };
const BUNDLE_PATH = '/home/dananickerson/fly-pipeline/data/nasr/bundle.json';

(async () => {
    const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8'));
    console.log(`Bundle loaded: ${bundle.airports.length} airports, ${bundle.airways.length} airways, ${bundle.suas?.length || 0} suas`);

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: VP });

    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[pageerror] ${err.stack || err.message}`));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && app.openRoutePlanner, { timeout: 10000 });

    // Inject bundle into the page so we can write it to IDB
    console.log('Seeding IDB with real bundle...');
    await page.evaluate(async (bundle) => {
        if (window.app?._nasrDb?.db) try { window.app._nasrDb.db.close(); } catch (_) {}

        await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('flypi');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });

        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('flypi', 8);
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                d.createObjectStore('airports',          { keyPath: 'icao' });
                d.createObjectStore('navaids',           { keyPath: 'id' });
                d.createObjectStore('airways',           { keyPath: 'name' });
                d.createObjectStore('sua',               { keyPath: 'id' });
                d.createObjectStore('fixes',             { keyPath: 'id' });
                d.createObjectStore('airspace',          { keyPath: 'id' });
                d.createObjectStore('aircraft_profiles', { keyPath: 'id' });
                d.createObjectStore('fuel_prices',       { keyPath: 'icao' });
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror   = (e) => reject(e.target.error);
        });

        // Bulk-write each store in chunks
        async function writeStore(name, items, keyName = null) {
            const CHUNK = 1000;
            for (let i = 0; i < items.length; i += CHUNK) {
                await new Promise((resolve, reject) => {
                    const tx = db.transaction(name, 'readwrite');
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                    const store = tx.objectStore(name);
                    for (const item of items.slice(i, i + CHUNK)) {
                        store.put(item);
                    }
                });
            }
        }

        await writeStore('airports', bundle.airports);
        if (bundle.navaids)  await writeStore('navaids',  bundle.navaids);
        await writeStore('airways',  bundle.airways);
        if (bundle.fixes)    await writeStore('fixes',    bundle.fixes);
        if (bundle.suas)     await writeStore('sua',      bundle.suas);
        if (bundle.airspace) await writeStore('airspace', bundle.airspace);

        db.close();
        return 'seeded';
    }, bundle);

    console.log('Reloading with seeded data...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && app.openRoutePlanner, { timeout: 10000 });
    await page.waitForTimeout(3000); // give planner time to warm graph

    const ready = await page.evaluate(() => {
        const p = app.routePlannerPanel;
        return {
            plannerReady: !!p?._planner,
            graphSize:    p?._planner?._airwayGraph ? Object.keys(p._planner._airwayGraph.graph).length : 0,
            suaCount:     p?._planner?._suas?.length,
        };
    });
    console.log('Planner state after warm:', ready);

    // Open panel + KRCZ -> KLKR + tap Plan
    await page.evaluate(() => app.openRoutePlanner(null));
    await page.waitForTimeout(400);

    await page.evaluate(() => {
        const p = app.routePlannerPanel;
        p._depInput.value  = 'KRCZ';
        p._destInput.value = 'KLKR';
    });

    console.log('\nTapping Plan...');
    await page.locator('button', { hasText: 'Plan' }).click();
    await page.waitForTimeout(8000);

    const result = await page.evaluate(() => {
        const p = app.routePlannerPanel;
        return {
            routeIds:   (p?._route || []).map(r => `${r.id}(${r.type})`),
            toast:      document.getElementById('rppToast')?.textContent,
            coords:     Object.keys(p?._coords || {}).length,
        };
    });

    console.log('\n── RESULT ──');
    console.log(JSON.stringify(result, null, 2));

    console.log('\n── LOGS (RoutePlanner / errors only) ──');
    logs.filter(l =>
        !l.includes('ERR_ADDRESS_UNREACHABLE') &&
        !l.includes('ERR_CONNECTION_REFUSED') &&
        !l.includes('WebSocket connection') &&
        !l.includes('[Advisory]') &&
        !l.includes('[ApproachCharts]') &&
        !l.includes('[GpsSource]') &&
        !l.includes('[TerrainGrid]') &&
        !l.includes('Tile base') &&
        !l.includes('Network mode') &&
        !l.includes('NASR DB empty') &&
        !l.includes('NASR import failed') &&
        !l.includes('EngineML') &&
        !l.includes('FlyTab v') &&
        !l.includes('Loaded from cache')
    ).forEach(l => console.log(l));

    await page.screenshot({ path: 'tools/pw-plan-real.png' });
    await browser.close();
    process.exit(0);
})();
