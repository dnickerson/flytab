/**
 * Playwright smoke test — wx-briefing panel: NOTAMs, AIRMETs, MCDs
 * Run: node tools/test-wx-briefing.js
 *
 * Requires:
 *   http://localhost:8080  — FlyTab web server (bash start-home-server.sh or any static server)
 *   http://localhost:3001  — flywhere Next.js dev server (npm run dev)
 */

const { chromium } = require('playwright');

const APP_URL    = 'http://localhost:8080/web/';
const PROXY_BASE = 'http://localhost:3001/api';

// KLKR → KCLT — gives enough route corridor for en-route bbox NOTAMs
const FLIGHT_PLAN = {
  departure:   'KLKR',
  destination: 'KCLT',
  waypoints: [
    { icao: 'KLKR', lat: 34.7229, lon: -80.8546 },
    { icao: 'KCLT', lat: 35.2140, lon: -80.9431 },
  ],
};

const PASS = (msg) => console.log(`  ✓ ${msg}`);
const FAIL = (msg) => { console.error(`  ✗ ${msg}`); process.exitCode = 1; };
const HEAD = (msg) => console.log(`\n── ${msg} ──`);

async function waitForText(page, selector, timeout = 20000) {
  await page.waitForFunction(
    ({ sel }) => {
      const el = document.querySelector(sel);
      return el && el.innerText.trim().length > 0;
    },
    { sel: selector },
    { timeout }
  );
  return page.$eval(selector, el => el.innerText.trim());
}

(async () => {
  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page    = await ctx.newPage();

  // Track HTTP failures so we can identify mystery 404/503s
  const failedRequests = [];
  page.on('response', resp => {
    if (resp.status() >= 400) failedRequests.push(`${resp.status()} ${resp.url()}`);
  });

  // Capture console errors — filter expected infrastructure noise
  // (Stratux WS, Pi unreachable, engine monitor not on desk network)
  const IGNORED = [
    '192.168.',       // Stratux / Pi addresses
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_CONNECTION_REFUSED',
    'ws://192.168',
    'ws://stratux',
    ':8080/engine',   // engine monitor
    ':8090/',         // home server tiles when offline
  ];
  const errors = [];
  const warnings = [];
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED.some(p => text.includes(p))) return; // expected offline infra
    if (text.includes('503') && (text.includes('En-route NOTAM') || text.includes('/notams?south='))) {
      warnings.push(`En-route NOTAM 503 — FAA_NOTAM_CLIENT_ID/SECRET not set in .env.local`);
      return;
    }
    // Generic "Failed to load resource" messages are captured via page.on('response') below
    if (text.startsWith('Failed to load resource:')) return; // captured via page.on('response')
    if (text.includes('Checklist load failed')) return;      // checklist.json not served in test
    errors.push(text);
  });
  page.on('pageerror', err => {
    const text = err.message;
    if (IGNORED.some(p => text.includes(p))) return;
    if (text.includes('En-route NOTAM proxy 503')) {
      warnings.push('En-route NOTAM 503 — FAA credentials missing from local .env.local');
      return;
    }
    errors.push(text);
  });

  // ── 1. Seed localStorage before the app loads ─────────────────────────────
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ proxyBase, plan }) => {
    localStorage.setItem('flypi_worker_base', JSON.stringify(proxyBase));
    localStorage.setItem('flypi_active_plan', JSON.stringify(plan));
  }, { proxyBase: PROXY_BASE, plan: FLIGHT_PLAN });

  // ── 2. Reload so the app picks up the seeded plan ─────────────────────────
  await page.reload({ waitUntil: 'networkidle' });

  // Wait for FlyTab to initialize
  await page.waitForFunction(() => window.app?.wxBriefing, { timeout: 10000 });
  PASS('App initialized');

  // ── 3. Open the WX Briefing panel ─────────────────────────────────────────
  await page.evaluate(() => window.app.wxBriefing.show());
  await page.waitForSelector('.wx-briefing-page.visible', { timeout: 5000 });
  PASS('WX Briefing panel opened');

  // Screenshot — initial state (sections loading)
  await page.screenshot({ path: 'tools/wx-briefing-loading.png' });

  // ── 4. Wait for all three sections to finish loading ─────────────────────
  // "loading" spinners are replaced when fetches complete.
  // We wait until none of the target sections contain "Fetching" text.
  const LOAD_TIMEOUT = 45000;

  HEAD('Waiting for sections to load');

  // NOTAMs
  await page.waitForFunction(() => {
    const sec = document.querySelector('#wx-notam-section');
    if (!sec) return false;
    return !sec.innerText.includes('Fetching');
  }, { timeout: LOAD_TIMEOUT });
  PASS('NOTAM section loaded');

  // AIRMETs
  await page.waitForFunction(() => {
    const sec = document.querySelector('#wx-airmet-section');
    if (!sec) return false;
    return !sec.innerText.includes('Fetching');
  }, { timeout: LOAD_TIMEOUT });
  PASS('AIRMET section loaded');

  // MCDs
  await page.waitForFunction(() => {
    const sec = document.querySelector('#wx-mcd-section');
    if (!sec) return false;
    return !sec.innerText.includes('Fetching');
  }, { timeout: LOAD_TIMEOUT });
  PASS('MCD section loaded');

  // Screenshot — all sections loaded
  await page.screenshot({ path: 'tools/wx-briefing-loaded.png', fullPage: false });

  // ── 5. Inspect each section ───────────────────────────────────────────────
  HEAD('NOTAMs');
  const notamText = await page.$eval('#wx-notam-section', el => el.innerText);
  console.log('  Content preview:', notamText.slice(0, 300).replace(/\n/g, ' | '));

  if (notamText.includes('unavailable')) {
    FAIL('NOTAM section shows "unavailable" — fetch failed');
  } else if (notamText.includes('No active NOTAMs') && notamText.includes('No TFRs')) {
    console.log('  ⚠ Both airport and en-route sections empty (may be correct if no active NOTAMs)');
  } else {
    PASS('NOTAM section has content');
  }

  // Check airport group
  if (notamText.includes('AIRPORT')) {
    PASS('AIRPORT group header present');
  } else {
    FAIL('AIRPORT group header missing');
  }

  // Check en-route group
  if (notamText.includes('EN-ROUTE AIRSPACE')) {
    PASS('EN-ROUTE AIRSPACE group header present');
  } else {
    FAIL('EN-ROUTE AIRSPACE group header missing');
  }

  // Check badge is not loading
  const notamBadge = await page.$eval('#wx-notam-section .wx-rhs-badge', el => el.innerText.trim()).catch(() => '');
  if (notamBadge && !notamBadge.includes('Fetching')) {
    PASS(`NOTAM badge: "${notamBadge}"`);
  } else {
    FAIL(`NOTAM badge still shows loading: "${notamBadge}"`);
  }

  // Verify airport codes are ICAO (4-letter K prefix) not 3-letter FAA ids
  const notamCards = await page.$$eval('#wx-notam-section .wx-adv-info', els => els.map(el => el.innerText.trim()));
  for (const card of notamCards) {
    // Extract the airport label (first token before "·")
    const match = card.match(/^([A-Z]+)\s*·/);
    if (match) {
      const loc = match[1];
      if (loc.length === 3 && /^[A-Z]{3}$/.test(loc)) {
        FAIL(`Airport code "${loc}" is 3-letter FAA id, expected ICAO`);
      } else {
        PASS(`Airport code "${loc}" looks correct`);
      }
      break; // one check is enough
    }
  }

  // ── 6. AIRMETs ────────────────────────────────────────────────────────────
  HEAD('AIRMETs');
  const airmetText = await page.$eval('#wx-airmet-section', el => el.innerText);
  console.log('  Content preview:', airmetText.slice(0, 300).replace(/\n/g, ' | '));

  if (airmetText.includes('unavailable')) {
    FAIL('AIRMET section shows "unavailable" — fetch failed');
  } else if (airmetText.includes('None affecting route')) {
    console.log('  ⚠ No AIRMETs on route (may be correct)');
    PASS('AIRMET section rendered (no active advisories)');
  } else {
    PASS('AIRMET section has content');
  }

  const airmetBadge = await page.$eval('#wx-airmet-section .wx-rhs-badge', el => el.innerText.trim()).catch(() => '');
  PASS(`AIRMET badge: "${airmetBadge}"`);

  // ── 7. MCDs ───────────────────────────────────────────────────────────────
  HEAD('MCDs');
  const mcdText = await page.$eval('#wx-mcd-section', el => el.innerText);
  console.log('  Content preview:', mcdText.slice(0, 300).replace(/\n/g, ' | '));

  if (mcdText.includes('unavailable')) {
    FAIL('MCD section shows "unavailable" — fetch failed');
  } else if (mcdText.includes('None affecting route')) {
    console.log('  ⚠ No MCDs on route (may be correct)');
    PASS('MCD section rendered (no active discussions)');
  } else {
    PASS('MCD section has content');
  }

  const mcdBadge = await page.$eval('#wx-mcd-section .wx-rhs-badge', el => el.innerText.trim()).catch(() => '');
  PASS(`MCD badge: "${mcdBadge}"`);

  // ── 8. HTTP failures ─────────────────────────────────────────────────────
  HEAD('HTTP Failures');
  const IGNORED_URLS = ['192.168.', ':8080/engine', ':8090/', '192.168.'];
  const realHttpFails = failedRequests.filter(r => !IGNORED_URLS.some(p => r.includes(p)));
  if (realHttpFails.length === 0) {
    PASS('No unexpected HTTP failures');
  } else {
    realHttpFails.forEach(r => {
      if (r.includes('503') && r.includes('/notams?south=')) {
        console.log(`  ⚠ ${r}  ← en-route NOTAM: FAA creds not in .env.local`);
      } else {
        FAIL(`HTTP: ${r}`);
      }
    });
  }

  // ── 9. Summary of JS errors ───────────────────────────────────────────────
  HEAD('JS Errors');
  if (warnings.length) warnings.forEach(w => console.log(`  ⚠ ${w}`));
  if (errors.length === 0) {
    PASS('No unexpected console errors');
  } else {
    errors.forEach(e => FAIL(`JS error: ${e}`));
  }

  // Final screenshot
  await page.screenshot({ path: 'tools/wx-briefing-final.png', fullPage: false });
  console.log('\n  Screenshots saved to tools/wx-briefing-*.png');

  await browser.close();

  if (process.exitCode) {
    console.log('\nSome checks FAILED — see ✗ lines above');
  } else {
    console.log('\nAll checks PASSED');
  }
})();
