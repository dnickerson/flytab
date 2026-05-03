/**
 * Playwright Plan-button test with mocked IDB containing airports + airways.
 * Pre-populates FlyTabDB with realistic airway graph data so the planner can
 * actually attempt A* search.
 */
const { chromium } = require('playwright');

const URL = 'http://localhost:9876/index.html';
const VP = { width: 1280, height: 800 };

// Minimal but realistic test data: 2 airports + 1 V-airway connecting via 2 fixes
const TEST_AIRPORTS = [
    { icao: 'KLKR', lat: 34.7233, lon: -80.8567, name: 'Lancaster County' },
    { icao: 'KGSO', lat: 36.0978, lon: -79.9373, name: 'Piedmont Triad' },
    { icao: 'KMHT', lat: 42.9326, lon: -71.4357, name: 'Manchester' },
];

// V143: GSO ↔ RDU ↔ ISO  (rough — purpose is graph connectivity)
const TEST_AIRWAYS = [
    {
        name: 'V143',
        type: 'V',
        waypoints: [
            { name: 'GSO', seq: 10, lat: 36.0455, lon: -79.9711, id: 'GSO', type: 'VORTAC' },
            { name: 'RDU', seq: 20, lat: 35.8722, lon: -78.7836, id: 'RDU', type: 'VORTAC' },
            { name: 'ISO', seq: 30, lat: 35.6325, lon: -77.6086, id: 'ISO', type: 'VORTAC' },
        ],
        segments: [
            { from_seq: 10, to_seq: 20, dist_nm: 65, mea_ft: 3000 },
            { from_seq: 20, to_seq: 30, dist_nm: 70, mea_ft: 3000 },
        ],
    },
    {
        name: 'V155',
        type: 'V',
        waypoints: [
            { name: 'CLT', seq: 10, lat: 35.1909, lon: -80.9460, id: 'CLT', type: 'VORTAC' },
            { name: 'GSO', seq: 20, lat: 36.0455, lon: -79.9711, id: 'GSO', type: 'VORTAC' },
        ],
        segments: [
            { from_seq: 10, to_seq: 20, dist_nm: 80, mea_ft: 3000 },
        ],
    },
];

async function seedIdb(page) {
    await page.evaluate(async ({ apts, awys }) => {
        // Close any cached DB connection from app initialization first
        if (window.app?._nasrDb?.db) try { window.app._nasrDb.db.close(); } catch(_){}

        // Wipe and recreate
        await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('flypi');
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
        });

        // Open with the schema version the app uses (8) and create all stores
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('flypi', 8);
            req.onupgradeneeded = (e) => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('airports'))   d.createObjectStore('airports',   { keyPath: 'icao' });
                if (!d.objectStoreNames.contains('navaids'))    d.createObjectStore('navaids',    { keyPath: 'id' });
                if (!d.objectStoreNames.contains('airways'))    d.createObjectStore('airways',    { keyPath: 'name' });
                if (!d.objectStoreNames.contains('sua'))        d.createObjectStore('sua',        { keyPath: 'id' });
                if (!d.objectStoreNames.contains('fixes'))      d.createObjectStore('fixes',      { keyPath: 'id' });
                if (!d.objectStoreNames.contains('airspace'))   d.createObjectStore('airspace',   { keyPath: 'id' });
                if (!d.objectStoreNames.contains('aircraft_profiles')) d.createObjectStore('aircraft_profiles', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('fuel_prices'))       d.createObjectStore('fuel_prices', { keyPath: 'icao' });
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });

        // Write airports + airways
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['airports', 'airways'], 'readwrite');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            for (const a of apts) tx.objectStore('airports').put(a);
            for (const a of awys) tx.objectStore('airways').put(a);
        });
        db.close();
        return 'ok';
    }, { apts: TEST_AIRPORTS, awys: TEST_AIRWAYS });
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: VP });

    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[pageerror] ${err.stack || err.message}`));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForFunction(() => typeof app !== 'undefined' && app.openRoutePlanner, { timeout: 10000 });

    console.log('Seeding IDB with test airports + airways...');
    await seedIdb(page);

    // Reload so RoutePlanner reopens the freshly-seeded DB
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof app !== 'undefined' && app.openRoutePlanner, { timeout: 10000 });
    await page.waitForTimeout(1500); // let _startBuildPlanner finish

    const plannerReady = await page.evaluate(() => !!app.routePlannerPanel?._planner);
    console.log('Planner ready after seed+reload:', plannerReady);

    // Open panel + fill DEP/DEST + tap Plan
    await page.evaluate(() => app.openRoutePlanner(null));
    await page.waitForTimeout(400);

    await page.evaluate(() => {
        const panel = app.routePlannerPanel;
        panel._depInput.value  = 'KLKR';
        panel._destInput.value = 'KGSO';
    });

    // Tap Plan
    await page.locator('button', { hasText: 'Plan' }).click();
    await page.waitForTimeout(4000);

    // Read state
    const state = await page.evaluate(() => {
        const p = app.routePlannerPanel;
        return {
            routeLength: p?._route?.length,
            routeIds: (p?._route || []).map(r => `${r.id}(${r.type})`),
            toast: document.getElementById('rppToast')?.textContent,
        };
    });
    console.log('After Plan tap:', JSON.stringify(state, null, 2));
    console.log('\n── Console logs (filtered) ──');
    logs.filter(l => !l.includes('ERR_ADDRESS_UNREACHABLE')
                  && !l.includes('ERR_CONNECTION_REFUSED')
                  && !l.includes('WebSocket connection'))
        .forEach(l => console.log(l));

    await page.screenshot({ path: 'tools/pw-plan-mocked.png' });
    await browser.close();
    process.exit(0);
})();
