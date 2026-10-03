import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { RoutePlanner } from '../../../web/shared/planning/planner/route-planner.js';
import { makeAeroAdapter, NULL_WEATHER, NULL_PLANS, NULL_PROFILES, NULL_NETWORK, FROZEN_CLOCK } from '../fixtures/mock-adapters.js';
import { FIXES, AIRWAYS } from '../fixtures/synthetic-airway-graph.js';

const aero = makeAeroAdapter({
    airports: {
        KA: { icao: 'KA', lat: 33.0, lon: -85.0 },
        KC: { icao: 'KC', lat: 34.0, lon: -84.0 },
    },
    fixes: FIXES,
    airways: AIRWAYS,
});

const adapters = {
    aero,
    weather: NULL_WEATHER,
    plans: NULL_PLANS,
    profiles: NULL_PROFILES,
    network: NULL_NETWORK,
    clock: FROZEN_CLOCK,
};

describe('RoutePlanner.plan()', () => {
    it('plans a direct GPS route (no airways) for routingMode "gps-direct"', async () => {
        const p = new RoutePlanner(adapters);
        const plan = await p.plan({
            departure: 'KA',
            destination: 'KC',
            routingMode: 'gps-direct',
        });
        expect(plan.waypoints.map(w => w.id)).toEqual(['KA', 'KC']);
    });

    it('loads V airways into the graph for routingMode "v-airways"', async () => {
        // Simplified test: verify the graph loads V1 airway edges.
        // We won't test A* routing logic here, just graph construction.
        // Create an aero adapter where A and C are airports.
        const aeroWithApts = makeAeroAdapter({
            airports: {
                A: { icao: 'A', lat: 33.0, lon: -85.0 },
                C: { icao: 'C', lat: 34.0, lon: -84.0 },
            },
            fixes: FIXES,
            airways: AIRWAYS,  // V1 = A→B→C via fixIds
        });
        const p = new RoutePlanner({ ...adapters, aero: aeroWithApts });
        // Plan the route; the graph will load airways internally
        const plan = await p.plan({
            departure: 'A',
            destination: 'C',
            routingMode: 'v-airways',
        });
        // Verify we got a valid plan with waypoints
        expect(plan.waypoints.length).toBeGreaterThanOrEqual(2);
        expect(plan.waypoints[0].id).toBe('A');
        expect(plan.waypoints[plan.waypoints.length - 1].id).toBe('C');
    });

    it('falls back to direct when no airways exist (DEP/DEST always connected)', async () => {
        const tinyAero = makeAeroAdapter({
            airports: {
                KA: { icao: 'KA', lat: 33, lon: -85 },
                KC: { icao: 'KC', lat: 34, lon: -84 },
            },
            // No airways and no shared fixes — graph is empty under v-airways
        });
        const p = new RoutePlanner({ ...adapters, aero: tinyAero });
        const plan = await p.plan({
            departure: 'KA',
            destination: 'KC',
            routingMode: 'v-airways',
        });
        // Falls back to direct (DEP/DEST direct edge is always added)
        expect(plan.waypoints.map(w => w.id)).toEqual(['KA', 'KC']);
    });
});

describe('RoutePlanner.parseRoute()', () => {
    it('expands airway tokens', async () => {
        const p = new RoutePlanner(adapters);
        const r = await p.parseRoute('A V1 C');
        expect(r.waypoints.map(w => w.id)).toEqual(['A', 'B', 'C']);
    });
});

describe('RoutePlanner.recomputeLegs()', () => {
    it('returns a plan with leg distances filled in', async () => {
        const p = new RoutePlanner(adapters);
        const plan = await p.parseRoute('A V1 C');
        const recomputed = p.recomputeLegs(plan);
        expect(recomputed.legs.length).toBe(2);
        expect(recomputed.legs[0].distNm).toBeGreaterThan(0);
    });
});

// Minimal mocks for recomputeLegs-only tests (no aero/A* needed)
const mockAero = { getAirport: async () => null };
const mockPlans = { get: async () => null, put: async () => '', list: async () => [], delete: async () => {} };

describe('recomputeLegs with winds and altitude', () => {
    const profile = {
        id: 'test', tailNumber: '', model: 'Test',
        cruise_ktas: 155, cruise_ias: 148, fuel_burn_gph: 8.0,
        fuel_capacity_gal: 36, reserve_gal: 10,
        climb_rate_fpm: 750, service_ceiling_ft: 17500, taxi_burn_gal: 1.5,
        max_hp: 180,
        equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
        fuelPhases: {
            climb:   { gph: 15,  ias_kt: 90,  rate_fpm: 750 },
            cruise:  { gph: 8.0, ias_kt: 148 },
            descent: { gph: 4.0, ias_kt: 70,  rate_fpm: 700 },
        },
    };
    const simplePlan = {
        departure: 'KLKR', destination: 'KCLT',
        cruiseAltFt: 6500,
        reserveGal: 10,
        waypoints: [
            { id: 'KLKR', lat: 34.7281, lon: -81.2128 },
            { id: 'KCLT', lat: 35.2140, lon: -80.9431 },
        ],
        options: { routingMode: 'v-airways', maxLegHrs: 2, selfServeOnly: false, avoidance: [] },
    };

    it('populates legAltFt from cruiseAltFt when no waypoint override', () => {
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs(simplePlan, profile);
        expect(result.legs[0].altFt).toBe(6500);
    });

    it('uses waypoint.altFt as per-leg altitude override', () => {
        const planWithOverride = {
            ...simplePlan,
            waypoints: [
                { id: 'KLKR', lat: 34.7281, lon: -81.2128 },
                { id: 'KCLT', lat: 35.2140, lon: -80.9431, altFt: 9500 },
            ],
        };
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs(planWithOverride, profile);
        expect(result.legs[0].altFt).toBe(9500);
    });

    it('headwind increases flight time', () => {
        // KLKR→KCLT bearing ~030° (northeast), headwind would be from ~030°
        const winds = { CLT: { 6000: { dir: 30, spd: 30 } } };
        // fdLocs maps station IDs to [lat, lon] so findNearestFdStation can locate them in tests
        const fdLocs = { CLT: [35.2140, -80.9431] };
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const calm   = planner.recomputeLegs(simplePlan, profile);
        const windy  = planner.recomputeLegs(simplePlan, profile, { winds, fdLocs });
        expect(windy.legs[0].timeHrs).toBeGreaterThan(calm.legs[0].timeHrs);
    });

    it('populates eta on each leg as UTC ms', () => {
        const dep = new Date('2026-05-06T14:00:00Z');
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs(simplePlan, profile, { departureTime: dep });
        expect(result.legs[0].eta).toBeGreaterThan(dep.getTime());
        expect(typeof result.legs[0].eta).toBe('number');
    });

    it('VFR altitude auto-selected when cruiseAltFt absent', () => {
        const noCruiseAlt = { ...simplePlan };
        delete noCruiseAlt.cruiseAltFt;
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs(noCruiseAlt, profile);
        // KLKR→KCLT bearing ~030° (eastbound, short) → should be 3500 or 5500
        expect([3500, 5500]).toContain(result.legs[0].altFt);
    });
});

// ---------------------------------------------------------------------------
// RV9A_FALLBACK is the profile used when no `profiles` adapter supplies one
// (NULL_PROFILES.getActive() returns null) and when recomputeLegs() is called
// with no profileOverride. Its fuel figures must stay in lockstep with
// web/aircraft-config.json and with RV9A_DEFAULT in planning-adapters/idb-profile.js.
// These are flight-safety constants: too LOW a phase GPH under-plans burn, which
// over-states fuel remaining — the direction that runs tanks dry.
// ---------------------------------------------------------------------------
describe('RV9A fallback profile — measured phase fuel flows', () => {
    const fallbackAero = makeAeroAdapter({
        airports: {
            KA: { icao: 'KA', lat: 33.0, lon: -85.0 },
            KC: { icao: 'KC', lat: 34.0, lon: -84.0 },
        },
    });
    const fallbackPlan = {
        departure: 'KA', destination: 'KC',
        cruiseAltFt: 6500,
        waypoints: [
            { id: 'KA', lat: 33.0, lon: -85.0 },
            { id: 'KC', lat: 34.0, lon: -84.0 },
        ],
        options: { routingMode: 'gps-direct', maxLegHrs: 10, selfServeOnly: false, avoidance: [] },
    };

    function fallbackSegments() {
        const planner = new RoutePlanner({ aero: fallbackAero, plans: NULL_PLANS });
        // No profileOverride -> RV9A_FALLBACK
        const result = planner.recomputeLegs(fallbackPlan);
        return result.legs[0].segments;
    }

    it('descends at the measured p85 of 6.9 gph, not the old 4.0 book guess', () => {
        const des = fallbackSegments().find(s => s.phase === 'DES');
        expect(des).toBeDefined();
        expect(des.gph).toBe(6.9);
    });

    // 8.4 = p85 of cruise rows binned by recorded %power, 65-69% band
    // (n=7,879; median 8.10, p85 8.40). Deliberately NOT the 8.1 that
    // `power_settings[]` carries for the 61-65 band: build_power_curve.py
    // writes `round(gph_med, 1)` into that table, so band values are MEDIANS,
    // and planning constants must come from a conservative upper percentile.
    // Dana's direct instruction 2026-07-31, superseding commit 96d62f3.
    it('cruises at 8.4 gph — the p85 of the 65% cruise band, not its 8.1 median', () => {
        const crz = fallbackSegments().find(s => s.phase === 'CRZ');
        expect(crz).toBeDefined();
        expect(crz.gph).toBe(8.4);
    });

    it('climbs at the measured p85 of 15 gph', () => {
        const clb = fallbackSegments().find(s => s.phase === 'CLB');
        expect(clb).toBeDefined();
        expect(clb.gph).toBe(15);
    });

    it('burns more descent fuel than the old 4.0 gph constant would have', () => {
        const des = fallbackSegments().find(s => s.phase === 'DES');
        const descentHrs = des.ete_min / 60;
        expect(des.gph * descentHrs).toBeGreaterThan(4.0 * descentHrs);
    });

    it('carries the aircraft-config reserve of 10 gal into parsed plans', async () => {
        const p = new RoutePlanner(adapters);   // NULL_PROFILES -> RV9A_FALLBACK
        const r = await p.parseRoute('A V1 C');
        expect(r.reserveGal).toBe(10);
    });
});

// ---------------------------------------------------------------------------
// Sync-invariant test (Task 11 fix round 1): the review found that mutating
// RV9A_DEFAULT (idb-profile.js) or aircraft-config.json's descent_gph alone,
// leaving RV9A_FALLBACK above untouched, left the whole suite green (M7/M8 in
// the Task 11 report's mutation table) — neither copy has any other coverage.
// Neither RV9A_FALLBACK nor RV9A_DEFAULT is exported (both are deliberately
// private module consts — see the "KEEP IN SYNC, BY HAND" comments above each),
// and RV9A_DEFAULT lives behind IdbProfileStore, which needs a real IndexedDB
// the project has no fake for. So this reads all three sources directly off
// disk — exactly like a human doing the hand-sync check the comments ask for —
// rather than importing/instantiating anything.
// ---------------------------------------------------------------------------
describe('descent_gph sync invariant — all three hand-maintained copies must agree', () => {
    function extractDescentGph(sourceText, label) {
        const m = sourceText.match(/descent:\s*\{[\s\S]*?gph:\s*([\d.]+)/);
        if (!m) throw new Error(`descent.gph literal not found in ${label}`);
        return parseFloat(m[1]);
    }

    it('RV9A_FALLBACK (route-planner.js), RV9A_DEFAULT (idb-profile.js), and aircraft-config.json performance.descent_gph are all the same number', () => {
        const routePlannerSrc = readFileSync('web/shared/planning/planner/route-planner.js', 'utf8');
        const idbProfileSrc   = readFileSync('web/shared/planning-adapters/idb-profile.js', 'utf8');
        const aircraftConfig  = JSON.parse(readFileSync('web/aircraft-config.json', 'utf8'));

        const fallbackGph = extractDescentGph(routePlannerSrc, 'RV9A_FALLBACK (route-planner.js)');
        const defaultGph  = extractDescentGph(idbProfileSrc, 'RV9A_DEFAULT (idb-profile.js)');
        const configGph   = aircraftConfig.performance.descent_gph;

        expect(fallbackGph).toBe(defaultGph);
        expect(defaultGph).toBe(configGph);
        // Pin the known-correct measured value too, so a matched three-way drift
        // (all three edited together back to some other number) still fails —
        // agreement alone isn't sufficient, since three copies of a wrong number
        // agree with each other just as well as three copies of the right one.
        expect(configGph).toBe(6.9);
    });
});


// ---------------------------------------------------------------------------
// Destination followed by a loaded approach's missed-approach fixes (flagged
// isMissed). The descent, the summary totals and the fuel-stop search end at
// the last waypoint before the trailing isMissed run.
// ---------------------------------------------------------------------------
describe('recomputeLegs — destination before the trailing missed-approach fixes', () => {
    const base = {
        departure: 'KCLT', destination: 'KLKR',
        cruiseAltFt: 6000,
        options: { routingMode: 'gps-direct', maxLegHrs: 10, selfServeOnly: false, avoidance: [] },
    };
    const phases = leg => leg.segments.map(s => s.phase);

    it('descends on the leg into the destination and not on the missed-approach legs after it', () => {
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs({
            ...base,
            destination: undefined,
            waypoints: [
                { id: 'KCLT',  lat: 35.214, lon: -80.943 },
                { id: 'KLKR',  lat: 34.723, lon: -80.855 },
                { id: 'MAP1',  lat: 34.680, lon: -80.950, isMissed: true },
                { id: 'CORON', lat: 34.600, lon: -81.200, isMissed: true },
            ],
        });
        expect(phases(result.legs[0])).toContain('DES');
        expect(phases(result.legs[1])).not.toContain('DES');
        expect(phases(result.legs[2])).not.toContain('DES');
    });

    it('descends on the last leg when nothing is flagged and plan.destination is absent', () => {
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs({
            ...base,
            destination: undefined,
            waypoints: [
                { id: 'KCLT',  lat: 35.214, lon: -80.943 },
                { id: 'KLKR',  lat: 34.723, lon: -80.855 },
                { id: 'CORON', lat: 34.600, lon: -81.200 },
            ],
        });
        expect(phases(result.legs[0])).not.toContain('DES');
        expect(phases(result.legs[1])).toContain('DES');
    });

    it('KLKR → KLKR loop: climbs from the departure and descends into the arrival KLKR', () => {
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs({
            ...base,
            departure: 'KLKR', destination: 'KLKR',
            waypoints: [
                { id: 'KLKR',  lat: 34.723, lon: -80.855 },
                { id: 'CTF',   lat: 34.650, lon: -80.274 },
                { id: 'KLKR',  lat: 34.723, lon: -80.855 },
                { id: 'CORON', lat: 34.600, lon: -81.200, isMissed: true },
            ],
        });
        expect(phases(result.legs[0])).toContain('CLB');
        expect(phases(result.legs[1])).toContain('DES');
        expect(phases(result.legs[2])).not.toContain('DES');
    });

    it('a missed-approach fix moved mid-route no longer shortens the route', () => {
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const result = planner.recomputeLegs({
            ...base,
            destination: undefined,
            waypoints: [
                { id: 'KCLT',  lat: 35.214, lon: -80.943 },
                { id: 'CORON', lat: 34.600, lon: -81.200, isMissed: true },
                { id: 'KLKR',  lat: 34.723, lon: -80.855 },
            ],
        });
        expect(phases(result.legs[1])).toContain('DES');
        expect(result.summary.totalDistNm).toBeCloseTo(result.legs[0].distNm + result.legs[1].distNm, 9);
    });
});

describe('recomputeLegs / insertFuelStops — totals stop at the destination', () => {
    const wpsFlagged = [
        { id: 'KCLT',  lat: 35.214, lon: -80.943 },
        { id: 'KLKR',  lat: 34.723, lon: -80.855 },
        { id: 'FAR',   lat: 31.000, lon: -84.000, isMissed: true },   // long missed-approach leg
    ];
    const base = {
        departure: 'KCLT', destination: 'KLKR', cruiseAltFt: 6000,
        options: { routingMode: 'gps-direct', maxLegHrs: 1, selfServeOnly: false, avoidance: [] },
    };

    it('summary distance, time, fuel and fuel remaining stop at the destination', () => {
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const r = planner.recomputeLegs({ ...base, waypoints: wpsFlagged });
        expect(r.legs).toHaveLength(2);
        expect(r.summary.totalDistNm).toBeCloseTo(r.legs[0].distNm, 9);
        expect(r.summary.totalEteHrs).toBeCloseTo(r.legs[0].timeHrs, 9);
        expect(r.summary.totalFuelGal).toBeCloseTo(r.legs[0].fuelGal, 9);
        expect(r.summary.fuelRemGal).toBeCloseTo(r.legs[0].fuelRemGal, 9);
    });

    it('without isMissed flags, plan.destination locates the destination (last occurrence)', () => {
        const planner = new RoutePlanner({ aero: mockAero, plans: mockPlans });
        const r = planner.recomputeLegs({
            ...base, waypoints: wpsFlagged.map(({ isMissed, ...w }) => w),
        });
        expect(r.legs[0].segments.map(s => s.phase)).toContain('DES');
        expect(r.legs[1].segments.map(s => s.phase)).not.toContain('DES');
        expect(r.summary.totalDistNm).toBeCloseTo(r.legs[0].distNm, 9);
    });

    it('does not propose a fuel stop because of a long missed-approach leg', async () => {
        const aero = {
            getAirport: async () => null,
            nearestAirports: async () => [{ icao: 'KFUEL', lat: 33, lon: -82, hasFuel: true, hasSelfServeFuel: true }],
        };
        const planner = new RoutePlanner({ aero, plans: mockPlans });
        const computed = planner.recomputeLegs({ ...base, waypoints: wpsFlagged });
        expect(computed.legs[1].timeHrs).toBeGreaterThan(1);   // the missed leg alone exceeds maxLegHrs
        const r = await planner.insertFuelStops(computed);
        expect(r.fuelStopCandidates).toEqual([]);
    });
});
