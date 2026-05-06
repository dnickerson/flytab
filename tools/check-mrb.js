import { chromium } from 'playwright';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('flypi_user_cockpit', JSON.stringify({ homeServer: { base: 'http://localhost:8090' } }));
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180_000);
  await page.goto('http://localhost:8080/');
  await page.waitForFunction(() => !!window.app?.routePlannerPanel?._planner);
  const r = await page.evaluate(async () => {
    const planner = window.app.routePlannerPanel._planner;
    const result = await planner.parseRoute('KLKR LOCAS V409 GANTS V103 GSO V143 LRP V39 SAX V249 HELON V167 SPECL 44N');
    const mrb = result.waypoints.find(w => w.id === 'MRB');
    const expectedNavaidLat = 39.40;
    const expectedAirportLat = 39.40;
    return mrb ? { id: mrb.id, lat: mrb.lat, lon: mrb.lon, kind: mrb.kind } : null;
  });
  console.log('MRB resolves to:', JSON.stringify(r));
  await browser.close();
})();
