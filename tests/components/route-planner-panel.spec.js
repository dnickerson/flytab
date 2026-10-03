// tests/components/route-planner-panel.spec.js
const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/components/harnesses/route-planner-panel.html';

// A planned route with explicit Victor airway pills — mirrors what _resultToPills
// produces after A* routes KLKR → FLO → CRE via V311.
const PLANNED_ROUTE_WITH_AIRWAYS = [
    { id: 'KLKR', type: 'dep' },
    { id: 'V311', type: 'awy' },
    { id: 'FLO',  type: 'fix', airway: 'V311' },
    { id: 'V311', type: 'awy' },
    { id: 'CRE',  type: 'fix', airway: 'V311' },
    { id: 'KMHT', type: 'dest' },
];

// Minimal plan stub with two waypoints so open() has something to load.
const STUB_PLAN = {
    departure:   'KLKR',
    destination: 'KCLT',
    waypoints: [
        { icao: 'KLKR', lat: 34.9, lon: -81.1 },
        { icao: 'KCLT', lat: 35.2, lon: -80.9 },
    ],
};

test.describe('route-planner-panel @planner-ui', () => {
    test('init() builds panel DOM', async ({ page }) => {
        await page.goto(HARNESS);
        // init() calls _buildDOM() which creates .rpp-inner inside the mount element.
        const built = await page.evaluate(() => window.__harness.isBuilt());
        expect(built).toBe(true);
    });

    test('panel contains dep/dest inputs after init', async ({ page }) => {
        await page.goto(HARNESS);
        // _buildTopRow() creates two .rpp-icao-inp inputs (dep and dest).
        await expect(page.locator('#rp-mount .rpp-icao-inp').first()).toBeAttached();
    });

    test('close() clears the route array', async ({ page }) => {
        await page.goto(HARNESS);
        // open() with a plan loads waypoints into _route; close() must clear it.
        await page.evaluate(plan => window.__harness.open(plan), STUB_PLAN);
        const routeLen = await page.evaluate(() => window.__harness.close());
        expect(routeLen).toBe(0);
    });
});

// ── Victor airway retention: plan → save → close → reopen ─────────────────
//
// Regression test for the bug where A*-planned routes with Victor airways lost
// all airway pills when the route planner was closed and reopened.  The fix has
// two parts:
//   1. _doApply saves route: this._route.map(r=>r.id) which includes 'V311' etc.
//   2. _loadPlan rebuilds 'awy' pills from the saved array on reopen.
//   3. _inferAirwaysIntoRoute fills in airways even when the saved array had none.

test.describe('Victor airway retention @airway-retention', () => {

    // ── Test 1: explicit airway IDs survive the save→load round-trip ─────────
    test('V-airway pills survive close/reopen when route was saved with airway IDs', async ({ page }) => {
        await page.goto(HARNESS);

        // Step 1 — inject a planned route with Victor airway pills (mirrors _resultToPills).
        await page.evaluate(route => {
            window.__harness.setPlannedRoute(route);
        }, PLANNED_ROUTE_WITH_AIRWAYS);

        // Step 2 — verify the airway pills are visible in the panel now.
        await expect(page.locator('#rp-mount .rpp-pill-awy').first()).toBeVisible();

        // Step 3 — extract what _doApply would save to flight_plan.route.
        const savedPlan = await page.evaluate(() => window.__harness.getAppliedPlan(
            'KLKR', 'KMHT',
            [
                { icao: 'KLKR', lat: 34.9, lon: -79.9 },
                { icao: 'FLO',  lat: 34.2, lon: -79.7 },
                { icao: 'CRE',  lat: 33.8, lon: -78.7 },
                { icao: 'KMHT', lat: 42.9, lon: -71.4 },
            ]
        ));

        // The saved route must include the airway ID 'V311'.
        expect(savedPlan.flight_plan.route).toContain('V311');

        // Step 4 — close and reopen with the saved plan (simulates app.openRoutePlanner).
        await page.evaluate(plan => {
            window.__harness.close();
            return window.__harness.open(plan);   // async; returns Promise
        }, savedPlan);

        // Step 5 — wait for open() async operations (airway inference) to finish.
        await page.waitForFunction(() => {
            const route = window.__harness.getRoute();
            // open() is done when _route is non-empty again
            return route.length >= 2;
        }, { timeout: 5000 });

        // Step 6 — verify airway pills are still shown after reopen.
        await expect(page.locator('#rp-mount .rpp-pill-awy').first()).toBeVisible();

        // Verify the specific airway ID 'V311' appears in the route.
        const routeAfterReopen = await page.evaluate(() => window.__harness.getRoute());
        const awayPill = routeAfterReopen.find(p => p.type === 'awy');
        expect(awayPill).toBeDefined();
        expect(awayPill.id).toBe('V311');
    });

    // ── Test 2: inference fills airways when saved route has only fix IDs ─────
    test('airways inferred from NASR when saved route lacks airway tokens', async ({ page }) => {
        await page.goto(HARNESS);

        // Simulate an old-format saved plan whose route has no airway tokens —
        // e.g. saved before the airway-pill fix, or pasted without V-numbers.
        const oldFormatPlan = {
            departure:   'KLKR',
            destination: 'KMHT',
            waypoints: [
                { icao: 'KLKR', lat: 34.9, lon: -79.9 },
                { icao: 'FLO',  lat: 34.2, lon: -79.7 },
                { icao: 'CRE',  lat: 33.8, lon: -78.7 },
                { icao: 'KMHT', lat: 42.9, lon: -71.4 },
            ],
            flight_plan: {
                departure:   'KLKR',
                destination: 'KMHT',
                route: ['KLKR', 'FLO', 'CRE', 'KMHT'],   // no airway tokens
                legs:  [],
            },
        };

        // open() → _loadPlan → _inferAirwaysIntoRoute
        await page.evaluate(plan => window.__harness.open(plan), oldFormatPlan);

        // Wait for async inference to complete
        await page.waitForFunction(() => {
            const route = window.__harness.getRoute();
            // Either inference added an 'awy' pill, or open settled with fix-only route
            return route.length >= 2;
        }, { timeout: 5000 });

        // V311 should have been inferred because FLO→CRE is a consecutive pair on V311.
        const route = await page.evaluate(() => window.__harness.getRoute());
        const awayPill = route.find(p => p.type === 'awy');
        expect(awayPill).toBeDefined();
        expect(awayPill.id).toBe('V311');

        // The inferred airway pill should be visible in the DOM.
        await expect(page.locator('#rp-mount .rpp-pill-awy').first()).toBeVisible();
    });
});

// ── Approach insertion: departure == destination ─────────────────────────
//
// Regression test for KLKR → KLKR with the RNAV (GPS) RWY 24 approach loaded
// from the plate. insertApproach() anchored on the FIRST pill matching the
// airport — the departure — so the approach was spliced in ahead of the
// departure and the missed approach landed between departure and destination:
//   CTF LIGLE SAPSE WITUR RW24 KLKR(dep) CORON KLKR(dest)

// Fix sequence for KLKR RNAV (GPS) RWY 24 via the CTF transition, as loaded
// on-device. Coordinates are approximate — only pill order is under test.
const KLKR_RNAV24 = {
    icao: 'KLKR',
    procName: 'R24',
    transition: 'CTF',
    insertBefore: [
        { icao: 'CTF',   lat: 34.650, lon: -80.274, alt: null },
        { icao: 'LIGLE', lat: 34.766, lon: -80.613, alt: 2500 },
        { icao: 'SAPSE', lat: 34.848, lon: -80.665, alt: 2500 },
        { icao: 'WITUR', lat: 34.789, lon: -80.836, alt: 2100 },
        { icao: 'RW24',  lat: 34.728, lon: -80.853, alt: 500 },
    ],
    insertAfter: [
        { icao: 'CORON', lat: 34.700, lon: -80.900, alt: 2200 },
    ],
    airportWp: { icao: 'KLKR', lat: 34.728, lon: -80.853, type: 'APT' },
};

test.describe('approach insertion @planner-ui', () => {
    test('KLKR → KLKR: approach goes before the destination, not the departure', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.setPlannedRoute([
            { id: 'KLKR', type: 'dep' },
            { id: 'KLKR', type: 'dest' },
        ]));

        await page.evaluate(detail => window.__harness.insertApproach(detail), KLKR_RNAV24);

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(route.map(p => `${p.id}:${p.type}`)).toEqual([
            'KLKR:dep',
            'CTF:fix', 'LIGLE:fix', 'SAPSE:fix', 'WITUR:fix', 'RW24:fix',
            'KLKR:dest',
            'CORON:fix',
        ]);
    });

    test('KCLT → KLKR: approach and missed approach bracket the destination', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.setPlannedRoute([
            { id: 'KCLT', type: 'dep' },
            { id: 'KLKR', type: 'dest' },
        ]));

        await page.evaluate(detail => window.__harness.insertApproach(detail), KLKR_RNAV24);

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(route.map(p => `${p.id}:${p.type}`)).toEqual([
            'KCLT:dep',
            'CTF:fix', 'LIGLE:fix', 'SAPSE:fix', 'WITUR:fix', 'RW24:fix',
            'KLKR:dest',
            'CORON:fix',
        ]);
    });
});
