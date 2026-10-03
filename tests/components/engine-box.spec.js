// tests/components/engine-box.spec.js
// Layer panel "Map Engine Box" picker -> the engine cards on the map (EngineOverlay).
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/engine-box.html';

async function setup(page) {
    await page.goto(HARNESS);
    await page.evaluate(() => { window.__harness.open(); window.__harness.data(); });
    await page.click('.lp-accordion-header[data-acc="lp-acc-engine"]');
}
const toggle = (page, key) => page.click(`input[data-engine-field="${key}"] + .lp-toggle-track`);

test.describe('Map Engine Box picker @map', () => {
    test('starts with CARB TEMP on, showing the Pi value', async ({ page }) => {
        await setup(page);
        await expect(page.locator('input[data-engine-field="carb_temp"]')).toBeChecked();
        expect(await page.evaluate(() => window.__harness.cards())).toEqual([['CARB TEMP', '72°F']]);
    });

    test('turning values on adds cards immediately, in catalog order, with real values', async ({ page }) => {
        await setup(page);
        await toggle(page, 'cht_max');
        await toggle(page, 'rpm');
        await toggle(page, 'mp');
        expect(await page.evaluate(() => window.__harness.cards())).toEqual([
            ['CARB TEMP', '72°F'], ['RPM', '2420'], ['MP', '23.4"'], ['CHT MAX', '362°F'],
        ]);
        expect(await page.evaluate(() => window.__harness.saved())).toEqual(['carb_temp', 'rpm', 'mp', 'cht_max']);
    });

    test('turning CARB TEMP off removes its card', async ({ page }) => {
        await setup(page);
        await toggle(page, 'rpm');
        await toggle(page, 'carb_temp');
        expect(await page.evaluate(() => window.__harness.cards())).toEqual([['RPM', '2420']]);
    });

    test('at 6 values the rest are disabled until one is turned off', async ({ page }) => {
        await setup(page);
        for (const k of ['rpm', 'mp', 'fuel_flow', 'percent_power', 'oil_temp']) await toggle(page, k);
        await expect(page.locator('input[data-engine-field="volts"]')).toBeDisabled();
        expect((await page.evaluate(() => window.__harness.cards())).length).toBe(6);
        await toggle(page, 'rpm');
        await expect(page.locator('input[data-engine-field="volts"]')).toBeEnabled();
    });
});
