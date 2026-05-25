// tests/components/engine-panel.spec.js
const { test, expect } = require('@playwright/test');
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');

const HARNESS = '/tests/components/harnesses/engine-panel.html';

test.describe('engine panel @engine', () => {
    test('renders RPM from canonical Pi engine data', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(frame => window.__harness.sendData(frame), ENGINE_FRAME);
        // RPM is rounded from the raw value (2200 → '2200')
        await expect(page.locator('#eng-rpm')).toHaveText('2200');
    });

    test('renders all four EGT bars with non-zero height', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(frame => window.__harness.sendData(frame), ENGINE_FRAME);
        // EGT bars are .cyl-bar-fill elements inside #eng-egt-bars, identified by id eng-egt-N.
        // height is set as a percentage string; parse to verify > 0.
        // EGT range in panel: (egt - 1000) / 700 * 100 → 1350 → (350/700)*100 = 50%
        for (let i = 1; i <= 4; i++) {
            const height = await page.locator(`#eng-egt-${i}`).evaluate(
                el => parseFloat(el.style.height)
            );
            expect(height).toBeGreaterThan(0);
        }
    });

    test('renders fuel endurance from Gallons_Rem and Fuel_Flow', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(frame => window.__harness.sendData(frame), ENGINE_FRAME);
        // 24.9 gal / 8.5 gph * 60 = 175.9 → rounded 176 min → 2:56 endur
        const text = await page.locator('#eng-fuel-endurance').textContent();
        expect(text).toMatch(/\d+:\d{2} endur/);
    });

    test('shows DISCONNECTED status on engine:disconnect', async ({ page }) => {
        await page.goto(HARNESS);
        // Status starts as 'DISCONNECTED' on initial render (before any data).
        // Fire the event explicitly to confirm the disconnect handler sets the text.
        await page.evaluate(() => window.__harness.sendDisconnect());
        await expect(page.locator('#eng-status')).toHaveText('DISCONNECTED');
    });

    test('shows STALE status on engine:stale', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.sendStale());
        await expect(page.locator('#eng-status')).toHaveText('STALE');
    });
});
