// UI-driven Playwright test for the route planner panel.
// Drives the actual DOM: opens the panel, types DEP/DEST, clicks Plan,
// verifies pills appear with airway names, screenshots the result.
//
// Run with: node tools/test-planner-ui.js
//
// Requires: static server on :8080, home server on :8090.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE      = process.env.BASE_URL || 'http://localhost:8080/';
const PLAN_FROM = process.env.PLAN_FROM || 'KLKR';
const PLAN_TO   = process.env.PLAN_TO   || 'KMIA';
const SHOTS_DIR = path.resolve('./tools/ui-shots');

fs.mkdirSync(SHOTS_DIR, { recursive: true });

const log = (label, val) =>
    console.log(`[${label}]`, typeof val === 'string' ? val : JSON.stringify(val, null, 2));

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        permissions: ['geolocation', 'clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120_000);

    // Force the dev cockpit to reach the local home server regardless of
    // what's checked into cockpit-config.json.
    await ctx.addInitScript(() => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({
            homeServer: { base: 'http://localhost:8090' },
        }));
    });

    const errors = [];
    const allConsole = [];
    page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
    page.on('console', (msg) => {
        const t = msg.text();
        if (msg.type() === 'error') errors.push('console: ' + t);
        // Capture lib/panel diagnostics — drops Stratux/WS noise.
        if (/RoutePlanner|FlyTabPlanning|Planning|plan\(\)|airway/i.test(t)) allConsole.push(t);
    });

    log('nav', BASE);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // Wait for full app + planner init.
    await page.waitForFunction(
        () => !!window.app?._planningAdapters && !!window.app?.routePlannerPanel?._planner,
        { timeout: 90_000 },
    );
    log('init', 'app + planner ready');

    // Cold viewport screenshot — should show map full-width.
    await page.screenshot({ path: path.join(SHOTS_DIR, '01-cold.png'), fullPage: false });

    // -------- 1. Open the panel via the EDIT button on the route table --------
    // Tries the real button first; falls back to programmatic open if the
    // route table handle isn't visible (e.g., no current trip).
    const opened = await page.evaluate(async () => {
        const editBtn = document.querySelector('.route-table-edit-btn');
        if (editBtn && editBtn.offsetParent !== null) {
            editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return 'edit-button';
        }
        window.app.openRoutePlanner(null);
        return 'programmatic';
    });
    log('open panel via', opened);

    // The panel becomes visible when #cockpitContainer gets .route-editing
    await page.waitForFunction(
        () => document.getElementById('cockpitContainer')?.classList.contains('route-editing'),
        { timeout: 5_000 },
    );

    await page.screenshot({ path: path.join(SHOTS_DIR, '02-panel-open.png'), fullPage: false });
    log('panel', 'open + visible');

    // -------- 2. Type DEP and DEST --------
    const depInput  = page.locator('.rpp-dep-row .rpp-icao-field').nth(0).locator('input');
    const destInput = page.locator('.rpp-dep-row .rpp-icao-field').nth(1).locator('input');

    await depInput.fill(PLAN_FROM);
    await depInput.press('Tab');   // commit via change event
    await destInput.fill(PLAN_TO);
    await destInput.press('Tab');

    log('typed', `${PLAN_FROM} → ${PLAN_TO}`);

    // -------- 3. Click Plan --------
    const planBtn = page.locator('.rpp-toolbar .rpp-tbtn', { hasText: /^Plan$/ });
    await planBtn.click();
    log('clicked', 'Plan');

    // Wait up to 20s; capture state regardless of whether pills appeared.
    let timedOut = false;
    try {
        await page.waitForFunction(
            () => document.querySelectorAll('.rpp-pill').length >= 5,
            { timeout: 20_000 },
        );
    } catch (e) {
        timedOut = true;
        log('plan-wait', 'timed out, capturing current state');
    }

    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS_DIR, '03-after-plan.png'), fullPage: false });

    if (timedOut) {
        const state = await page.evaluate(() => {
            const panel = document.getElementById('routePlannerPanel');
            const toast = document.getElementById('rppToast');
            return {
                pillCount: document.querySelectorAll('.rpp-pill').length,
                pillTexts: Array.from(document.querySelectorAll('.rpp-pill')).map(p => p.textContent.trim().slice(0, 30)),
                toastText: toast?.textContent || null,
                routeStr:  document.querySelector('.rpp-route-str')?.textContent || null,
                depValue:  document.querySelectorAll('.rpp-dep-row .rpp-icao-field input')[0]?.value,
                destValue: document.querySelectorAll('.rpp-dep-row .rpp-icao-field input')[1]?.value,
                planner:   {
                    exists: !!window.app?.routePlannerPanel?._planner,
                    routeArrayLen: window.app?.routePlannerPanel?._route?.length,
                },
            };
        });
        log('panel state', state);
        if (allConsole.length) log('relevant console', allConsole);
        await browser.close();
        process.exit(2);
    }

    // -------- 4. Read pills and verify --------
    const pills = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.rpp-pill')).map(el => {
            const idx = parseInt(el.dataset.idx, 10);
            const item = window.app?.routePlannerPanel?._route?.[idx];
            return {
                id:   item?.id ?? '?',
                type: item?.type ?? '?',
                klass: el.className.replace('rpp-pill ', ''),
            };
        })
    );
    log('pill count', pills.length);
    log('first 5 pills', pills.slice(0, 5));
    log('last 3 pills', pills.slice(-3));

    // -------- 5. Tap-target audit (manual eye-check via screenshot) --------
    const sizes = await page.evaluate(() => {
        const boxes = (sel) => Array.from(document.querySelectorAll(sel))
            .map(e => e.getBoundingClientRect())
            .map(r => ({ w: Math.round(r.width), h: Math.round(r.height) }));
        return {
            depFieldHeight:    boxes('.rpp-dep-row .rpp-icao-field')[0]?.h,
            planButton:        boxes('.rpp-toolbar .rpp-tbtn')[1],
            applyButton:       boxes('.rpp-tbtn-apply')[0],
            firstPill:         boxes('.rpp-pill')[0],
            pillHandle:        boxes('.rpp-pill .rpp-pill-handle')[0],
        };
    });
    log('hit-target sizes (px)', sizes);

    // -------- 5b. Paste the wxbrief route via the panel's _onPasteTap path --------
    const pasteResult = await page.evaluate(async () => {
        const panel = window.app?.routePlannerPanel;
        const wxbrief = 'KLKR LOCAS V409 GANTS V103 GSO V143 LRP V39 SAX V249 HELON V167 SPECL 44N';
        // Stub the clipboard read so _onPasteTap picks up our string
        const origReadText = navigator.clipboard.readText;
        navigator.clipboard.readText = async () => wxbrief;
        try {
            // Bypass the confirm prompt by clearing _route first
            panel._route = [];
            await panel._onPasteTap();
        } finally {
            navigator.clipboard.readText = origReadText;
        }
        return {
            pillCount: panel._route.length,
            airwayPills: panel._route.filter(p => p.type === 'awy').map(p => p.id),
            dep: panel._route[0]?.id,
            dest: panel._route[panel._route.length - 1]?.id,
        };
    });
    log('paste wxbrief result', pasteResult);

    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(SHOTS_DIR, '03b-after-paste.png'), fullPage: false });

    // -------- 5c. Apply (keep open) — should update _currentTrip but leave panel visible --------
    const applyKeepBtn = page.locator('.rpp-tbtn-apply', { hasText: /^Apply$/ });
    await applyKeepBtn.click();
    await page.waitForTimeout(500);

    const afterApplyKeep = await page.evaluate(() => ({
        panelStillOpen: document.getElementById('cockpitContainer')?.classList.contains('route-editing'),
        pillCountAfter: document.querySelectorAll('.rpp-pill').length,
        tripWaypointCount: window.app?._currentTrip?.waypoints?.length ?? 0,
        tripDep: window.app?._currentTrip?.departure,
        tripDest: window.app?._currentTrip?.destination,
    }));
    log('after Apply (keep-open)', afterApplyKeep);

    if (!afterApplyKeep.panelStillOpen) {
        log('FAIL', 'Apply (keep-open) closed the panel — should stay open');
    }

    // -------- 6. Apply & Close --------
    const applyBtn = page.locator('.rpp-tbtn-apply', { hasText: /Apply & Close/ });
    await applyBtn.click();

    await page.waitForFunction(
        () => !document.getElementById('cockpitContainer')?.classList.contains('route-editing'),
        { timeout: 5_000 },
    );

    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS_DIR, '04-after-apply.png'), fullPage: false });
    log('panel', 'closed via Apply & Close');

    // -------- 7. Sanity report --------
    const tripPlan = await page.evaluate(() => {
        const t = window.app?._currentTrip;
        if (!t) return null;
        return {
            departure:   t.departure,
            destination: t.destination,
            waypointCount: (t.waypoints || []).length,
            airwaysOnLegs: [...new Set((t.legs || []).map(l => l.airway))].filter(Boolean),
        };
    });
    log('current trip after Apply', tripPlan);

    if (errors.length) {
        console.log('\n--- non-Stratux page/console errors ---');
        for (const e of errors) {
            // Filter out the expected Stratux / engine-client noise
            if (/192\.168\.10\.1|engine-client|Stratux|wss?:\/\/|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_REFUSED/.test(e)) continue;
            console.log(' !', e);
        }
    }

    console.log(`\nScreenshots written to ${SHOTS_DIR}/`);

    await browser.close();
    process.exit(0);
})();
