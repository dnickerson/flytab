/**
 * Playwright layout test for RoutePlannerPanel.
 * Opens the app, triggers openRoutePlanner(), screenshots portrait and landscape.
 */
const { chromium } = require('playwright');
const path = require('path');

const PORTRAIT  = { width: 800,  height: 1280 }; // tablet portrait
const LANDSCAPE = { width: 1280, height: 800  }; // tablet landscape
const URL = 'http://localhost:9876/index.html';

async function shot(page, name) {
    const file = path.join(__dirname, `pw-${name}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  Screenshot: ${file}`);
}

async function openPlanner(page) {
    // Wait for app to init then call openRoutePlanner
    await page.waitForFunction(() => typeof app !== 'undefined' && app.openRoutePlanner, { timeout: 10000 });
    await page.evaluate(() => {
        app.openRoutePlanner(null);
    });
    await page.waitForTimeout(400); // let CSS transition settle
}

async function checkLayout(page, orientation) {
    return page.evaluate(() => {
        const cc  = document.getElementById('cockpitContainer');
        const rpp = document.getElementById('routePlannerPanel');
        const map = document.getElementById('mapContainer');
        if (!cc || !rpp || !map) return { error: 'elements missing' };

        const ccR  = cc.getBoundingClientRect();
        const rppR = rpp.getBoundingClientRect();
        const mapR = map.getBoundingClientRect();
        const inner = rpp.querySelector('.rpp-inner');
        const innerR = inner ? inner.getBoundingClientRect() : null;

        // Find Apply button
        const applyBtn = [...rpp.querySelectorAll('button')].find(b => b.textContent.includes('Apply'));

        return {
            cc:       { w: Math.round(ccR.width),  h: Math.round(ccR.height) },
            map:      { x: Math.round(mapR.left),  y: Math.round(mapR.top),  w: Math.round(mapR.width),  h: Math.round(mapR.height) },
            panel:    { x: Math.round(rppR.left), y: Math.round(rppR.top), w: Math.round(rppR.width), h: Math.round(rppR.height) },
            inner:    innerR ? { h: Math.round(innerR.height), scroll: inner.scrollHeight } : null,
            landscape: cc.classList.contains('landscape'),
            routeEditing: cc.classList.contains('route-editing'),
            applyVisible: applyBtn ? (() => {
                const r = applyBtn.getBoundingClientRect();
                return r.top >= 0 && r.bottom <= window.innerHeight;
            })() : 'no-btn',
            applyRect: applyBtn ? (() => {
                const r = applyBtn.getBoundingClientRect();
                return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
            })() : null,
        };
    });
}

(async () => {
    const browser = await chromium.launch({ headless: true });

    for (const [name, vp] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]]) {
        console.log(`\n── ${name.toUpperCase()} (${vp.width}×${vp.height}) ──`);
        const page = await browser.newPage({ viewport: vp });

        // Suppress console errors from missing backend services
        page.on('console', msg => {
            if (msg.type() === 'error') return;
            // console.log('  browser:', msg.text());
        });
        page.on('pageerror', () => {});

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

        try {
            await openPlanner(page);
        } catch (e) {
            console.log(`  Could not open planner: ${e.message}`);
            await shot(page, `${name}-error`);
            await page.close();
            continue;
        }

        const layout = await checkLayout(page, name);
        console.log('  Layout:', JSON.stringify(layout, null, 2));
        await shot(page, name);
        await page.close();
    }

    await browser.close();
    process.exit(0);
})();
