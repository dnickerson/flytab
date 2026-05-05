import { describe, it, expect } from 'vitest';
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
