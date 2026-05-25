// tests/smoke/planning.spec.js
'use strict';
const { test, expect } = require('@playwright/test');
const { injectTestConfig } = require('./helpers.js');

const APP = '/web/index.html';

test.describe('route planning smoke @smoke @nasr', () => {
    test('route planner opens and cockpitContainer gets route-editing class', async ({ page }) => {
        await injectTestConfig(page);
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });

        // Wait for _initCockpit() to finish (routePlannerPanel is set near the end).
        // app.init() runs on DOMContentLoaded; poll until routePlannerPanel is ready.
        await page.waitForFunction(
            () => window.app?.routePlannerPanel != null,
            { timeout: 15_000 },
        );

        // Invoke openRoutePlanner() via the app instance
        await page.evaluate(() => window.app.openRoutePlanner());
        await page.waitForTimeout(500);

        // Visibility is tracked by CSS class on #cockpitContainer (app.js line 1100)
        const isOpen = await page.evaluate(
            () => document.getElementById('cockpitContainer')?.classList.contains('route-editing') ?? false,
        );
        expect(isOpen).toBe(true);
    });

    test('route planner closes and removes route-editing class', async ({ page }) => {
        await injectTestConfig(page);
        await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20_000 });

        await page.waitForFunction(
            () => window.app?.routePlannerPanel != null,
            { timeout: 15_000 },
        );

        // Open then close
        await page.evaluate(() => {
            window.app.openRoutePlanner();
        });
        await page.waitForTimeout(300);

        await page.evaluate(() => {
            window.app.closeRoutePlanner();
        });
        await page.waitForTimeout(300);

        const isOpen = await page.evaluate(
            () => document.getElementById('cockpitContainer')?.classList.contains('route-editing') ?? false,
        );
        expect(isOpen).toBe(false);
    });
});
