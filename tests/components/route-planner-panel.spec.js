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

    test('approach anchors on a mid-route fuel-stop pill when the airport is not the destination', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.setPlannedRoute([
            { id: 'KCLT', type: 'dep' },
            { id: 'KLKR', type: 'fuel' },
            { id: 'KMHT', type: 'dest' },
        ]));

        await page.evaluate(detail => window.__harness.insertApproach(detail), KLKR_RNAV24);

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(route.map(p => `${p.id}:${p.type}`)).toEqual([
            'KCLT:dep',
            'CTF:fix', 'LIGLE:fix', 'SAPSE:fix', 'WITUR:fix', 'RW24:fix',
            'KLKR:fuel',
            'CORON:fix',
            'KMHT:dest',
        ]);
    });

    test('a VOR pill sharing the airport bare id (GSO vs KGSO) is not used as the anchor', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(() => window.__harness.setPlannedRoute([
            { id: 'KCLT', type: 'dep' },
            { id: 'GSO',  type: 'fix' },
            { id: 'KMHT', type: 'dest' },
        ]));

        await page.evaluate(detail => window.__harness.insertApproach(detail), {
            icao: 'KGSO',
            insertBefore: [
                { icao: 'IAF1', lat: 36.20, lon: -79.70, alt: 3000 },
                { icao: 'RW05', lat: 36.09, lon: -79.94, alt: 950 },
            ],
            insertAfter: [{ icao: 'MAP1', lat: 36.15, lon: -79.85, alt: 3000 }],
            airportWp: { icao: 'KGSO', lat: 36.10, lon: -79.94, type: 'APT' },
        });

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(route.map(p => `${p.id}:${p.type}`)).toEqual([
            'KCLT:dep',
            'GSO:fix',
            'IAF1:fix', 'RW05:fix', 'MAP1:fix',
            'KMHT:dest',
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

// ── Destination identity once missed-approach fixes follow the dest pill ──
//
// insertApproach() places missed-approach fixes AFTER the dest pill, so the
// destination is no longer the last pill/waypoint. Reload, the DEST input,
// trip auto-save and the stats/fuel-stop helpers must find it by type, not
// position — otherwise CORON (the missed-approach hold) becomes the destination.

const KLKR_LOOP_IDS = ['KLKR', 'CTF', 'LIGLE', 'SAPSE', 'WITUR', 'RW24', 'KLKR', 'CORON'];
const KLKR_LOOP_PILLS = [
    { id: 'KLKR',  type: 'dep' },
    { id: 'CTF',   type: 'fix' }, { id: 'LIGLE', type: 'fix' }, { id: 'SAPSE', type: 'fix' },
    { id: 'WITUR', type: 'fix' }, { id: 'RW24',  type: 'fix' },
    { id: 'KLKR',  type: 'dest' },
    { id: 'CORON', type: 'fix' },
];
const KLKR_LOOP_WPS = [
    { icao: 'KLKR',  lat: 34.723, lon: -80.855 },
    { icao: 'CTF',   lat: 34.650, lon: -80.274 },
    { icao: 'LIGLE', lat: 34.766, lon: -80.613 },
    { icao: 'SAPSE', lat: 34.848, lon: -80.665 },
    { icao: 'WITUR', lat: 34.789, lon: -80.836 },
    { icao: 'RW24',  lat: 34.728, lon: -80.853 },
    { icao: 'KLKR',  lat: 34.723, lon: -80.855 },
    { icao: 'CORON', lat: 34.700, lon: -80.900 },
];
const typed = route => route.map(p => `${p.id}:${p.type}`);

test.describe('destination with a loaded missed approach @planner-ui', () => {
    test('reopening a saved KLKR → KLKR plan keeps KLKR as the destination, not CORON', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(plan => window.__harness.open(plan), {
            departure: 'KLKR', destination: 'KLKR',
            waypoints: KLKR_LOOP_WPS,
            flight_plan: { departure: 'KLKR', destination: 'KLKR', route: KLKR_LOOP_IDS, legs: [] },
        });

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(typed(route)).toEqual(typed(KLKR_LOOP_PILLS));
        expect(await page.evaluate(() => window.__harness.inputs())).toEqual({ dep: 'KLKR', dest: 'KLKR' });
    });

    test('reopening a plan saved without a destination field still treats the last id as the destination', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(plan => window.__harness.open(plan), {
            waypoints: [{ icao: 'KLKR', lat: 34.72, lon: -80.85 }, { icao: 'KCLT', lat: 35.21, lon: -80.94 }],
            flight_plan: { route: ['KLKR', 'KCLT'], legs: [] },
        });

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(typed(route)).toEqual(['KLKR:dep', 'KCLT:dest']);
    });

    test('typing a new DEST replaces the destination pill, not the trailing missed-approach fix', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(pills => window.__harness.setPlannedRoute(pills), KLKR_LOOP_PILLS);

        await page.evaluate(() => window.__harness.setDest('KCLT'));

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(route.filter(p => p.type === 'dest').map(p => p.id)).toEqual(['KCLT']);
        expect(route[6]).toEqual({ id: 'KCLT', type: 'dest' });
        expect(route[7]).toEqual({ id: 'CORON', type: 'fix' });
    });

    // KCLT → KLKR with a missed-approach hold placed well away from KLKR, so a
    // direct distance measured to the hold differs visibly from one to KLKR.
    const KCLT_KLKR_PILLS = [
        { id: 'KCLT', type: 'dep' }, { id: 'RW24', type: 'fix' },
        { id: 'KLKR', type: 'dest' }, { id: 'HOLD1', type: 'fix' },
    ];
    const KCLT_KLKR_WPS = [
        { icao: 'KCLT',  lat: 35.214, lon: -80.943 },
        { icao: 'RW24',  lat: 34.728, lon: -80.853 },
        { icao: 'KLKR',  lat: 34.723, lon: -80.855 },
        { icao: 'HOLD1', lat: 34.400, lon: -81.400 },
    ];

    test('stats bar measures the direct-distance delta to the destination, not the missed-approach hold', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(pills => window.__harness.setPlannedRoute(pills), KCLT_KLKR_PILLS);

        const text = await page.evaluate(wps => window.__harness.updateStats({
            waypoints: wps, legs: [], summary: { totalDistNm: 100 },
        }), KCLT_KLKR_WPS);

        const [toDest, toHold] = await page.evaluate(([a, d, h]) => [
            Math.round(100 - NasrDB.haversineNm(a.lat, a.lon, d.lat, d.lon)),
            Math.round(100 - NasrDB.haversineNm(a.lat, a.lon, h.lat, h.lon)),
        ], [KCLT_KLKR_WPS[0], KCLT_KLKR_WPS[2], KCLT_KLKR_WPS[3]]);
        expect(toDest).not.toBe(toHold);
        expect(text).toContain(`+${toDest} nm`);
    });

    test('fuel-stop recheck plans to the destination, not the missed-approach hold', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(pills => window.__harness.setPlannedRoute(pills), KCLT_KLKR_PILLS);
        await page.evaluate(wps => window.__harness.setCoords(Object.fromEntries(
            wps.map(w => [w.icao, { lat: w.lat, lon: w.lon }]))), KCLT_KLKR_WPS);

        const planned = await page.evaluate(() => window.__harness.recheckFuelStops());
        expect(planned).toEqual({ departure: 'KCLT', destination: 'KLKR' });
    });

    test('reopening does not tag missed-approach fixes with the enroute airway', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(plan => window.__harness.open(plan), {
            departure: 'KCLT', destination: 'KLKR',
            waypoints: [],
            flight_plan: {
                departure: 'KCLT', destination: 'KLKR',
                route: ['KCLT', 'V311', 'FLO', 'KLKR', 'CORON'],
                legs: [],
            },
        });

        const route = await page.evaluate(() => window.__harness.getRouteWithAirways());
        expect(route.find(p => p.id === 'FLO').airway).toBe('V311');
        expect(route.find(p => p.id === 'CORON')).toEqual({ id: 'CORON', type: 'fix', airway: null });
    });

    test('Add inserts a new fix before the destination, not between it and the missed approach', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(pills => window.__harness.setPlannedRoute(pills), KLKR_LOOP_PILLS);

        await page.evaluate(() => window.__harness.addFix('FLO'));

        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(typed(route).slice(-3)).toEqual(['FLO:fix', 'KLKR:dest', 'CORON:fix']);
    });

    test('auto-saved trip is KLKR → KLKR, keeps the missed approach, and reopens with KLKR as destination', async ({ page }) => {
        await page.goto(HARNESS);
        await page.evaluate(pills => window.__harness.setPlannedRoute(pills), KLKR_LOOP_PILLS);

        const trip = await page.evaluate(wps => window.__harness.saveTrip({ waypoints: wps, legs: [] }), KLKR_LOOP_WPS);
        expect(trip.dep).toBe('KLKR');
        expect(trip.dest).toBe('KLKR');
        expect(trip.name).toMatch(/^KLKR → KLKR · /);
        expect(trip.legs).toHaveLength(1);
        expect(trip.legs[0].flight_plan.destination).toBe('KLKR');
        expect(trip.legs[0].flight_plan.route).toEqual(KLKR_LOOP_IDS);

        // Round trip: the saved leg must reopen with the same dest pill.
        await page.evaluate(leg => window.__harness.open(leg), trip.legs[0]);
        const route = await page.evaluate(() => window.__harness.getRoute());
        expect(typed(route)).toEqual(typed(KLKR_LOOP_PILLS));
    });
});
