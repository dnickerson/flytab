// tests/components/route-planner-panel.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/route-planner-panel.html';

// Minimal plan stub with two waypoints so open() has something to load.
const STUB_PLAN = {
    departure:   'KLKR',
    destination: 'KCLT',
    waypoints: [
        { icao: 'KLKR', lat: 34.9, lon: -81.1 },
        { icao: 'KCLT', lat: 35.2, lon: -80.9 },
    ],
};

test.describe('route-planner-panel @planner-ui', () => {
    test('init() builds panel DOM', async ({ page }) => {
        await page.goto(HARNESS);
        // init() calls _buildDOM() which creates .rpp-inner inside the mount element.
        const built = await page.evaluate(() => window.__harness.isBuilt());
        expect(built).toBe(true);
    });

    test('panel contains dep/dest inputs after init', async ({ page }) => {
        await page.goto(HARNESS);
        // _buildTopRow() creates two .rpp-icao-inp inputs (dep and dest).
        await expect(page.locator('#rp-mount .rpp-icao-inp').first()).toBeAttached();
    });

    test('close() clears the route array', async ({ page }) => {
        await page.goto(HARNESS);
        // open() with a plan loads waypoints into _route; close() must clear it.
        await page.evaluate(plan => window.__harness.open(plan), STUB_PLAN);
        const routeLen = await page.evaluate(() => window.__harness.close());
        expect(routeLen).toBe(0);
    });
});
