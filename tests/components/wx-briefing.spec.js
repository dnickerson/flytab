// tests/components/wx-briefing.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/wx-briefing.html';

const NOTAMS = [
    { type: 'TFR',      airport: 'KLKR', text: 'TFR ACTIVE',         validFrom: null, validTo: null },
    { type: 'NAV',      airport: 'KLKR', text: 'VOR OUT OF SERVICE', validFrom: null, validTo: null },
    { type: 'OBST_LGT', airport: 'KLKR', text: 'TOWER LGT OTS',      validFrom: null, validTo: null },
];

test.describe('wx-briefing NOTAMs @notam', () => {
    test('injects NOTAMs and counts them', async ({ page }) => {
        await page.goto(HARNESS);
        const count = await page.evaluate(notams => {
            window.__harness.injectNotams(notams);
            return window.__harness.getNotamCount();
        }, NOTAMS);
        expect(count).toBe(3);
    });

    test('NOTAM section renders after injection', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(notams => window.__harness.injectNotams(notams), NOTAMS);
        // _renderNotamSection() populates #wx-notam-section with notam rows.
        // Verify the section exists and is non-empty after injection.
        const text = await page.locator('#wx-notam-section').textContent();
        expect(text.length).toBeGreaterThan(0);
    });

    test('tier-0 TFR is sorted before tier-3 OBST_LGT', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(notams => window.__harness.injectNotams(notams), NOTAMS);
        // _sortedNotams: TFR is tier 0, NAV is tier 1, OBST_LGT is tier 3.
        // TFR must appear first in the sorted output.
        const types = await page.evaluate(() => window.__harness.getSortedTypes());
        expect(types[0]).toBe('TFR');
    });
});
