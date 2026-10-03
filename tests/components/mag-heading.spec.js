// tests/components/mag-heading.spec.js
// The route table's HDG comes from the planning library (an ES module) using the
// World Magnetic Model in mag-var.js (a classic script). Unit tests inject MagVar
// via globalThis, which hides the real-browser case: a classic script's top-level
// const is NOT on window, so the module must resolve the global binding itself.
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/mag-heading.html';

test.describe('magnetic heading in the browser @planner-ui', () => {
    test('planning module reaches the WMM loaded as a classic script', async ({ page }) => {
        await page.goto(HARNESS);
        await page.waitForFunction(() => window.__harness);
        const r = await page.evaluate(() => window.__harness);
        expect(r.magVarOnWindow).toBe('undefined');      // the trap this test exists for
        expect(r.klkr).toBeGreaterThan(97);               // 090 true + ~8 W = ~098 M
        expect(r.klkr).toBeLessThan(99);
        expect(r.sea).toBeGreaterThan(74);                // 090 true - ~15 E = ~075 M
        expect(r.sea).toBeLessThan(77);
    });
});
