/**
 * Playwright test: tap Plan button and capture all console output + errors.
 */
const { chromium } = require('playwright');

const LANDSCAPE = { width: 1280, height: 800 };
const URL = 'http://localhost:9876/index.html';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: LANDSCAPE });

    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[pageerror] ${err.message}`));

    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Wait for app + open planner
    try {
        await page.waitForFunction(() => typeof app !== 'undefined' && app.openRoutePlanner, { timeout: 10000 });
    } catch (e) {
        console.log('App did not initialise:', e.message);
        console.log('Logs so far:\n' + logs.join('\n'));
        await browser.close(); process.exit(1);
    }

    await page.evaluate(() => app.openRoutePlanner(null));
    await page.waitForTimeout(500);

    // Fill DEP + DEST
    await page.evaluate(() => {
        const panel = document.querySelector('.rpp-inner');
        const inputs = panel ? panel.querySelectorAll('input[type=text], input:not([type])') : [];
        const dep  = [...inputs].find(i => i.placeholder === 'ICAO' || i.closest('.rpp-icao-field'));
        // Use the dep/dest inputs directly
        const depInput  = document.getElementById('rppDep')  || [...inputs][0];
        const destInput = document.getElementById('rppDest') || [...inputs][1];
        if (depInput)  { depInput.value  = 'KLKR'; depInput.dispatchEvent(new Event('input')); }
        if (destInput) { destInput.value = 'KGSO'; destInput.dispatchEvent(new Event('input')); }
    });
    await page.waitForTimeout(200);

    // Check planner state
    const plannerState = await page.evaluate(() => {
        const panel = window._rppInstance || (app?.routePlannerPanel);
        return {
            plannerNull: !panel?._planner,
            depVal: panel?._depInput?.value,
            destVal: panel?._destInput?.value,
            routePlannnerDefined: typeof RoutePlanner !== 'undefined',
        };
    });
    console.log('Planner state before tap:', JSON.stringify(plannerState, null, 2));

    // Tap Plan button
    const planBtn = page.locator('button', { hasText: 'Plan' });
    await planBtn.click();
    await page.waitForTimeout(3000); // wait for async plan()

    // Check what toast appeared
    const toastText = await page.evaluate(() => {
        const t = document.querySelector('.rpp-toast');
        return t ? t.textContent : null;
    });
    console.log('Toast after Plan tap:', toastText);

    // Check route state
    const routeState = await page.evaluate(() => {
        const panel = app?.routePlannerPanel;
        return {
            routeLength: panel?._route?.length,
            plannerReady: !!panel?._planner,
        };
    });
    console.log('Route state after Plan:', JSON.stringify(routeState));

    console.log('\n── Console logs ──');
    logs.forEach(l => console.log(l));

    await page.screenshot({ path: 'tools/pw-plan-result.png' });
    await browser.close();
    process.exit(0);
})();
