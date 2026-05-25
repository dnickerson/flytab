// tests/smoke/visual-map.spec.js
'use strict';
const { test, expect } = require('@playwright/test');
const { injectTestConfig } = require('./helpers.js');

const APP = '/web/index.html';

test.describe('map tile rendering @visual @smoke @visual-map', () => {
    test.beforeEach(async ({ page }) => {
        await injectTestConfig(page);
    });

    test('VFR sectional tiles render at z8 around KLKR', async ({ page }) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Wait for app init then position map over KLKR at z8 (tile 8/70/101-102 in fixtures)
        await page.waitForFunction(() => window.app?.cockpitMap?.map != null, { timeout: 10_000 });
        await page.evaluate(() => {
            // Ensure sectional layer is active (default on startup, but be explicit)
            window.app.cockpitMap.switchBaseLayer('sectional');
            window.app.cockpitMap.map.setView([34.9, -81.1], 8);
        });
        // Allow tiles to load and render
        await page.waitForTimeout(3000);
        const mapEl = page.locator('#map, .leaflet-container').first();
        await expect(mapEl).toHaveScreenshot('sectional-z8-klkr.png', {
            maxDiffPixelRatio: 0.05,
        });
    });

    test('IFR low tiles render at z8 around KLKR', async ({ page }) => {
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        // Wait for app init then switch to IFR layer (ifr-low/8/70/101.webp in fixtures)
        await page.waitForFunction(() => window.app?.cockpitMap?.map != null, { timeout: 10_000 });
        await page.evaluate(() => {
            window.app.cockpitMap.switchBaseLayer('ifr');
            window.app.cockpitMap.map.setView([34.9, -81.1], 8);
        });
        // Allow tiles to load and render
        await page.waitForTimeout(3000);
        const mapEl = page.locator('#map, .leaflet-container').first();
        await expect(mapEl).toHaveScreenshot('ifr-z8-klkr.png', {
            maxDiffPixelRatio: 0.05,
        });
    });
});
