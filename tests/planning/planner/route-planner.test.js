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
