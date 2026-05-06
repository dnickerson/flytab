import { chromium } from 'playwright';

const wxbrief = process.env.PASTE || '';
const FROM = process.env.PLAN_FROM || 'KLKR';
const TO   = process.env.PLAN_TO   || 'KBOS';

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(() => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({ homeServer: { base: 'http://localhost:8090' } }));
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180_000);
    await page.goto('http://localhost:8080/');
    await page.waitForFunction(() => !!window.app?._planningAdapters && !!window.app?.routePlannerPanel?._planner);

    const result = await page.evaluate(async ({ from, to }) => {
        const planner = window.app.routePlannerPanel._planner;
        const r = await planner.plan({ departure: from, destination: to, cruiseAltFt: 6000, routingMode: 'v-airways' });
        return r.legs.map(l => ({ from: l.from, to: l.to, airway: l.airway, distNm: Math.round(l.distNm) }));
    }, { from: FROM, to: TO });
    console.log(JSON.stringify(result, null, 2));

    // Also probe HPW and ENO directly
    const hpw = await page.evaluate(async () => {
        const aero = window.app._planningAdapters.aero;
        const all = await aero.listAirways();
        const hpwAirways = all.filter(a => (a.fixIds || []).includes('HPW'));
        const enoAirways = all.filter(a => (a.fixIds || []).includes('ENO'));
        const shared = hpwAirways.filter(a => (a.fixIds || []).includes('ENO'));
        return {
            hpwOnAirways: hpwAirways.map(a => a.id),
            enoOnAirways: enoAirways.map(a => a.id),
            sharedAirways: shared.map(a => a.id),
            // Also print the great-circle distance
        };
    });
    console.log('HPW/ENO airway membership:', JSON.stringify(hpw, null, 2));

    await browser.close();
})();
