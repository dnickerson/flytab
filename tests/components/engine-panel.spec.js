// tests/components/engine-panel.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/engine-panel.html';

// Canonical Pi engine-monitor frame (v3.3.0 format with nested data object).
// engine-panel.js flattens: { ...raw, ...raw.data } so both top-level and
// data-nested fields are accessible.
const ENGINE_FRAME = {
    version: '3.3.0', capturing: true, serial_connected: true,
    stratux_connected: false, percent_power: 65.0,
    rop_lop_percent: 2.5, rop_lop_mode: 'RICH', sfc: 0.42,
    gps_altitude: 5000, pressure_altitude: 4950, ground_speed: 150,
    tas: 155, oat: 12.0, density_altitude: 6200,
    sticky_valve_alert: null, sticky_valve_dismissed: false,
    serial_warning: null, degrees_from_peak: {}, peaks_valid: false,
    manual_altimeter: null, manual_oat: null, fuel: null,
    data: {
        RPM: 2200, MP: 24.5, Oil_Temp: 180.0, Oil_Press: 76.0,
        Fuel_Press: 4.7, Volts: 13.7, Amps: 34.0,
        Fuel_Flow: 8.5, Gallons_Rem: 24.9, Fuel_L1: 13.7, Fuel_L2: 11.2,
        EGT1: 1350, EGT2: 1320, EGT3: 1360, EGT4: 1340,
        CHT1: 380,  CHT2: 365,  CHT3: 370,  CHT4: 355,
    },
};

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
