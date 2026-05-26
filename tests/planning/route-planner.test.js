// Additional contract and integration tests for RoutePlanner.
// Covers field-name contracts and insertFuelStops trigger conditions —
// neither of which appear in tests/planning/planner/route-planner.test.js.

import { describe, it, expect } from 'vitest';
import { RoutePlanner } from '../../web/shared/planning/planner/route-planner.js';

// Fixture airports: KLKR (SC) → KCLW (FL), ~400 nm
const KLKR = { id: 'KLKR', icao: 'KLKR', lat: 35.18, lon: -81.09 };
const KCLW = { id: 'KCLW', icao: 'KCLW', lat: 27.97, lon: -82.75 };

// Short pair: ~60 nm
const KCLT = { id: 'KCLT', icao: 'KCLT', lat: 35.21, lon: -80.94 };
const KGSP = { id: 'KGSP', icao: 'KGSP', lat: 34.90, lon: -82.22 };

function makePlanner(nearestImpl) {
    return new RoutePlanner({
        aero: {
            nearestAirports: nearestImpl ?? (() => Promise.resolve([])),
            getAirport:   () => Promise.reject(new Error('not implemented')),
            getNavaid:    () => Promise.reject(new Error('not implemented')),
            getFix:       () => Promise.reject(new Error('not implemented')),
            getAirway:    () => Promise.reject(new Error('not implemented')),
            listAirspace: () => Promise.resolve([]),
            listAirways:  () => Promise.resolve([]),
        },
        plans:    { save: () => {}, load: () => null },
        profiles: { getActive: () => null },
        weather:  {},
        network:  {},
        clock:    {},
    });
}

function makePlan(wps, optionOverrides = {}) {
    return {
        departure:   wps[0].id,
        destination: wps[wps.length - 1].id,
        cruiseAltFt: 6000,
        waypoints:   wps,
        options: { maxLegHrs: 2.0, selfServeOnly: false, ...optionOverrides },
    };
}

// ── recomputeLegs field-name contract ─────────────────────────────────────
// Route-table reads leg.gsKt and leg.tasKt. A rename back to gs/tas would
// silently produce null values in the display without a type error.

describe('recomputeLegs — field-name contract', () => {
    it('top-level leg fields are gsKt and tasKt, not gs or tas', () => {
        const planner = makePlanner();
        const result  = planner.recomputeLegs(makePlan([KLKR, KCLW]), null, {});
        const leg     = result.legs[0];
        expect(leg.gsKt).toBeTypeOf('number');
        expect(leg.tasKt).toBeTypeOf('number');
        expect(leg.gs).toBeUndefined();
        expect(leg.tas).toBeUndefined();
    });
});

// ── insertFuelStops trigger conditions ────────────────────────────────────
// The fuel stop picker must fire when maxLegHrs is exceeded and must stay
// silent when the route fits. These conditions burned us twice in v7.72–v7.73.

describe('insertFuelStops — trigger conditions', () => {
    it('returns empty candidates when route fits within maxLegHrs', async () => {
        const planner  = makePlanner();
        const computed = planner.recomputeLegs(makePlan([KCLT, KGSP], { maxLegHrs: 10 }), null, {});
        const result   = await planner.insertFuelStops(computed);
        expect(result.fuelStopCandidates).toHaveLength(0);
    });

    it('returns candidates with correct afterFixId when route exceeds maxLegHrs', async () => {
        const fuelApt = { icao: 'KMID', name: 'Mid-Route', lat: 31.5, lon: -81.9,
                          hasFuel: true, hasSelfServeFuel: true };
        const planner  = makePlanner(() => Promise.resolve([fuelApt]));
        const computed = planner.recomputeLegs(makePlan([KLKR, KCLW], { maxLegHrs: 0.5 }), null, {});
        const result   = await planner.insertFuelStops(computed);

        expect(result.fuelStopCandidates.length).toBeGreaterThan(0);
        expect(result.fuelStopCandidates[0].afterFixId).toBe('KLKR');
        expect(result.fuelStopCandidates[0].options[0].icao).toBe('KMID');
    });

    it('does not crash and returns empty when maxLegHrs is absent', async () => {
        const planner  = makePlanner();
        const plan     = { ...makePlan([KLKR, KCLW]), options: {} };
        const computed = planner.recomputeLegs(plan, null, {});
        const result   = await planner.insertFuelStops(computed);
        expect(result.fuelStopCandidates).toHaveLength(0);
    });

    it('excludes airports without self-serve fuel when selfServeOnly is true', async () => {
        const fboOnly = { icao: 'KFBO', name: 'FBO Only', lat: 31.5, lon: -81.9,
                          hasFuel: true, hasSelfServeFuel: false };
        const planner  = makePlanner(() => Promise.resolve([fboOnly]));
        const computed = planner.recomputeLegs(
            makePlan([KLKR, KCLW], { maxLegHrs: 0.5, selfServeOnly: true }), null, {});
        const result   = await planner.insertFuelStops(computed);
        expect(result.fuelStopCandidates).toHaveLength(0);
    });

    it('cumHrsAtStop is always <= maxLegHrs for every candidate', async () => {
        const fuelApt  = { icao: 'KMID', name: 'Mid', lat: 31.5, lon: -81.9,
                           hasFuel: true, hasSelfServeFuel: true };
        const maxLegHrs = 1.0;
        const planner  = makePlanner(() => Promise.resolve([fuelApt]));
        const computed = planner.recomputeLegs(makePlan([KLKR, KCLW], { maxLegHrs }), null, {});
        const result   = await planner.insertFuelStops(computed);
        for (const c of result.fuelStopCandidates) {
            expect(c.cumHrsAtStop).toBeLessThanOrEqual(maxLegHrs);
        }
    });
});

// ── planVia ───────────────────────────────────────────────────────────────
// Tests use a minimal graph: three fixes in a triangle so we can verify
// sub-segment stitching without needing real NASR data.

describe('planVia', () => {
    // Fixture: three collinear fixes spaced ~60 nm apart
    // A ──V1──> B ──V1──> C
    const A = { id: 'A', lat: 35.0, lon: -82.0 };
    const B = { id: 'B', lat: 35.0, lon: -81.0 };  // ~53 nm east of A
    const C = { id: 'C', lat: 35.0, lon: -80.0 };  // ~53 nm east of B

    function makePlannerWithGraph() {
        // Build a planner whose aero adapter returns one airway: A-B-C on V1
        const airways = [{
            id: 'V1', type: 'V',
            fixIds: ['A', 'B', 'C'],
            waypoints: [
                { id: 'A', lat: A.lat, lon: A.lon },
                { id: 'B', lat: B.lat, lon: B.lon },
                { id: 'C', lat: C.lat, lon: C.lon },
            ],
            unusable_pairs: new Set(),
        }];
        return new RoutePlanner({
            aero: {
                nearestAirports: () => Promise.resolve([]),
                getAirport:      () => Promise.resolve(null),
                getNavaid:       () => Promise.resolve(null),
                getFix:          () => Promise.resolve(null),
                getAirway:       () => Promise.resolve(null),
                listAirspace:    () => Promise.resolve([]),
                listAirways:     () => Promise.resolve(airways),
            },
            plans:    { save: () => {}, load: () => null },
            profiles: { getActive: () => null },
            weather:  {},
            network:  {},
            clock:    {},
        });
    }

    it('two-pin case returns a plan with dep and dest', async () => {
        const planner = makePlannerWithGraph();
        const plan = await planner.planVia([A, C]);
        expect(plan.departure).toBe('A');
        expect(plan.destination).toBe('C');
        expect(plan.waypoints[0].id).toBe('A');
        expect(plan.waypoints[plan.waypoints.length - 1].id).toBe('C');
        expect(plan.legs.length).toBeGreaterThan(0);
        expect(plan.summary.totalDistNm).toBeGreaterThan(0);
    });

    it('three-pin case routes through via without duplicating the junction', async () => {
        const planner = makePlannerWithGraph();
        const plan = await planner.planVia([A, B, C]);
        const ids = plan.waypoints.map(w => w.id);
        // B must appear exactly once (junction dedup)
        expect(ids.filter(id => id === 'B').length).toBe(1);
        expect(ids[0]).toBe('A');
        expect(ids[ids.length - 1]).toBe('C');
    });

    it('throws DestinationUnreachableError when a sub-segment has no path', async () => {
        // Planner with empty airway graph — no connections
        const empty = new RoutePlanner({
            aero: {
                nearestAirports: () => Promise.resolve([]),
                getAirport:      () => Promise.resolve(null),
                getNavaid:       () => Promise.resolve(null),
                getFix:          () => Promise.resolve(null),
                getAirway:       () => Promise.resolve(null),
                listAirspace:    () => Promise.resolve([]),
                listAirways:     () => Promise.resolve([]),
            },
            plans:    { save: () => {}, load: () => null },
            profiles: { getActive: () => null },
            weather:  {},
            network:  {},
            clock:    {},
        });
        // No airways → even the DIRECT fallback in _aStar only fires when the two
        // nodes are already connected; with an empty graph the fallback edge won't
        // bridge truly isolated nodes unless we explicitly add it. To force the
        // DestinationUnreachableError, use two disconnected fixes far apart.
        const X = { id: 'X', lat: 10.0, lon: -10.0 };
        const Y = { id: 'Y', lat: 80.0, lon: 80.0 };
        await expect(empty.planVia([X, Y])).rejects.toThrow('No route from X to Y');
    });
});
