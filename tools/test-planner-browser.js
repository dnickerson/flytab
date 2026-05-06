// Headless Playwright check that the planning lib loads, NASR imports, and
// AirwayGraph builds non-zero edges from the live bundle on the home server.
//
// Run with: node tools/test-planner-browser.js
//
// Requires: the static server on localhost:8080 (worktree's web/) and the
// home server on localhost:8090 (NASR bundle).

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:8080/';
const PLAN_FROM = process.env.PLAN_FROM || 'KLKR';
const PLAN_TO   = process.env.PLAN_TO   || 'KCLT';

const log = (label, val) => console.log(`[${label}]`, typeof val === 'string' ? val : JSON.stringify(val, null, 2));

(async () => {
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
        viewport: { width: 1200, height: 800 },
        // Permissions needed for some flytab features
        permissions: ['geolocation'],
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120_000);  // NASR import + IDB writes can take ~60-90s

    // Force the test to use the local home server on localhost:8090 regardless
    // of what's in cockpit-config.json. Production config may point at a LAN
    // address that's not reachable from the test machine.
    await ctx.addInitScript(() => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({
            homeServer: { base: 'http://localhost:8090' },
        }));
    });

    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    log('nav', BASE);
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    // 1. Planning lib loaded
    await page.waitForFunction(() => !!window.FlyTabPlanning?.RoutePlanner, { timeout: 20_000 });
    log('lib', 'window.FlyTabPlanning ready');

    // 2. App constructed AND fully initialized — wait for _planningAdapters
    //    which is set late in init() (after NASR import + adapters built).
    await page.waitForFunction(
        () => !!window.app?._planningAdapters && !!window.app?.routePlannerPanel?._planner,
        { timeout: 90_000 },
    );
    log('app', 'init complete; _planningAdapters and routePlannerPanel._planner ready');

    // 3. NasrDb populated. The data-status reload path imports on first load if
    //    stale; for a fresh browser profile, we have to wait for the import (or
    //    trigger it). Probe airway store size.
    const airwayCount = await page.evaluate(async () => {
        // Trigger a reimport directly so we don't depend on whatever the panel
        // was about to do.
        if (typeof DataStatus?._reimportNasr === 'function') {
            try { await DataStatus._reimportNasr(); } catch (_) {}
        }
        // Then count the airway store.
        const db = window.app?._nasrDb;
        if (!db || typeof db.listAirways !== 'function') return -1;
        const all = await db.listAirways();
        return all.length;
    });
    log('nasrDb.listAirways count', airwayCount);

    if (airwayCount <= 0) {
        log('FAIL', 'No airways in IDB. NASR import failed or store is wrong.');
        console.log('--- console errors ---');
        consoleErrors.forEach(e => console.log(e));
        console.log('--- page errors ---');
        pageErrors.forEach(e => console.log(e));
        await browser.close();
        process.exit(2);
    }

    // 4. Build the v-airways graph and count edges
    const graphStats = await page.evaluate(async () => {
        const adapters = window.app?._planningAdapters;
        if (!adapters) return { error: 'app._planningAdapters not set' };
        const planner = window.app?.routePlannerPanel?._planner;
        if (!planner) return { error: 'routePlannerPanel._planner not set yet' };
        const graph = await planner._getGraph('v-airways');
        const fromKeys = Object.keys(graph._adj);
        let edgeCount = 0;
        for (const k of fromKeys) edgeCount += graph._adj[k].length;
        const sampleFix = fromKeys[Math.floor(fromKeys.length / 2)];
        return {
            fromNodes: fromKeys.length,
            edges: edgeCount,
            coordsSize: Object.keys(graph.coords).length,
            sampleEdges: graph._adj[sampleFix]?.slice(0, 3),
            sampleFix,
        };
    });
    log('AirwayGraph[v-airways]', graphStats);

    if (graphStats.error || graphStats.edges === 0) {
        log('FAIL', 'Airway graph has zero edges (the original bug).');
        console.log('--- console errors ---');
        consoleErrors.forEach(e => console.log(e));
        await browser.close();
        process.exit(3);
    }

    // 5. Run a plan
    const planResult = await page.evaluate(async ({ from, to }) => {
        const planner = window.app?.routePlannerPanel?._planner;
        try {
            const r = await planner.plan({
                departure: from,
                destination: to,
                cruiseAltFt: 6000,
                routingMode: 'v-airways',
            });

            // Build the wxbrief-style route string by interleaving fix and
            // airway tokens. Each leg's airway is the airway used to ENTER
            // leg.to from leg.from. Collapse consecutive identical airways
            // (matches how ATC writes routes).
            const tokens = [r.waypoints[0].id];
            let lastAirway = null;
            for (const leg of (r.legs || [])) {
                if (leg.airway && leg.airway !== 'DIRECT' && leg.airway !== lastAirway) {
                    tokens.push(leg.airway);
                    lastAirway = leg.airway;
                } else if (leg.airway === 'DIRECT' || leg.airway !== lastAirway) {
                    lastAirway = leg.airway;
                }
                tokens.push(leg.to);
            }

            // Compact wxbrief view: only show fixes that are airway entry/exit
            // (the previous or next leg's airway is different from the current).
            const compactTokens = [r.waypoints[0].id];
            for (let i = 0; i < (r.legs || []).length; i++) {
                const leg  = r.legs[i];
                const next = r.legs[i + 1];
                const showFix = (i === r.legs.length - 1)               // last leg → always show
                              || (!next)                                  // safety
                              || (leg.airway !== next.airway);            // airway changes
                if (leg.airway && leg.airway !== 'DIRECT' && leg.airway !== compactTokens[compactTokens.length - 1]) {
                    compactTokens.push(leg.airway);
                }
                if (showFix) compactTokens.push(leg.to);
            }

            return {
                ok: true,
                waypointCount: r.waypoints.length,
                legCount: r.legs?.length ?? 0,
                airways: [...new Set((r.legs || []).map(l => l.airway))].filter(Boolean),
                fullRoute:    tokens.join(' '),
                compactRoute: compactTokens.join(' '),
                totalDistNm: r.summary?.totalDistNm,
                totalEteHrs: r.summary?.totalEteHrs,
            };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }, { from: PLAN_FROM, to: PLAN_TO });
    log(`plan ${PLAN_FROM}→${PLAN_TO}`, planResult);

    // 6. Paste expansion against the actual 1800wxbrief reference for KLKR→44N.
    //    parseRoute must walk each airway and emit every interior fix.
    const wxBriefStr = 'KLKR LOCAS V409 GANTS V103 GSO V143 LRP V39 SAX V249 HELON V167 SPECL 44N';
    const parseResult = await page.evaluate(async (str) => {
        const planner = window.app?.routePlannerPanel?._planner;
        try {
            const r = await planner.parseRoute(str);
            // Group expanded waypoints by the airway tag attached during parse.
            const groups = [];
            for (const w of r.waypoints) {
                const aw = w.airway || null;
                const last = groups[groups.length - 1];
                if (last && last.airway === aw) last.fixes.push(w.id);
                else groups.push({ airway: aw, fixes: [w.id] });
            }
            return {
                ok: true,
                input: str,
                totalFixes: r.waypoints.length,
                groups,
            };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }, wxBriefStr);
    log('parseRoute (wxbrief KLKR→44N expansion)', parseResult);

    console.log('\n--- console errors ---');
    consoleErrors.forEach(e => console.log('!', e));
    console.log('\n--- page errors ---');
    pageErrors.forEach(e => console.log('!', e));

    await browser.close();
    process.exit(0);
})();
