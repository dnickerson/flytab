// tests/components/layer-panel.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/layer-panel.html';

test.describe('layer panel @map', () => {
    test('opens when triggered', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.open());
        // open() adds class 'open' to the .layer-panel element.
        await expect(page.locator('.layer-panel.open')).toBeVisible();
    });

    test('closes when close is called', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.open());
        await page.evaluate(() => window.__harness.close());
        // close() removes 'open' class — panel element still exists but is not open.
        await expect(page.locator('.layer-panel.open')).not.toBeVisible();
    });

    test('backdrop is shown on open and hidden on close', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.open());
        await expect(page.locator('.layer-panel-backdrop.open')).toBeVisible();
        await page.evaluate(() => window.__harness.close());
        await expect(page.locator('.layer-panel-backdrop.open')).not.toBeVisible();
    });
});
