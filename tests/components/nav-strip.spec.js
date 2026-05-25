// tests/components/nav-strip.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/nav-strip.html';

// Normalized situation object as emitted by StratuxClient._handleSituation
// (snake_case, altitude already in feet).
const SIT = {
    lat: 34.9,
    lon: -81.1,
    alt_msl: 5000.0,
    alt_baro: 4950.0,
    ground_speed: 150.0,
    true_course: 90.0,
    vertical_speed: 0.0,
    gps_fix_quality: 2,
    gps_sats: 9,
    timestamp: Date.now(),
};

test.describe('nav-strip @stratux', () => {
    test('displays ground speed from situation data', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(sit => window.__harness.sendSituation(sit), SIT);
        const gs = await page.locator('#ns-gs').textContent();
        // GS is rendered as Math.round(ground_speed) with no locale formatting.
        expect(Number(gs)).toBeCloseTo(150, 0);
    });

    test('displays altitude from situation data', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(sit => window.__harness.sendSituation(sit), SIT);
        const alt = await page.locator('#ns-alt').textContent();
        // ALT is rendered as Math.round(alt_msl).toLocaleString() — strip locale
        // grouping separators (e.g. "5,000") before numeric comparison.
        const altNum = Number(alt.replace(/,/g, ''));
        expect(altNum).toBeCloseTo(5000, -2);
    });
});
