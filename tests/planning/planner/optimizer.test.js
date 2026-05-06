import { describe, it, expect } from 'vitest';
import { Optimizer } from '../../../web/shared/planning/planner/optimizer.js';
import { makeAeroAdapter, NULL_WEATHER, NULL_PLANS, NULL_PROFILES, NULL_NETWORK, FROZEN_CLOCK } from '../fixtures/mock-adapters.js';

const aero = makeAeroAdapter({
    airports: {
        KA: { icao: 'KA', lat: 33.0, lon: -85.0 },
        KC: { icao: 'KC', lat: 34.0, lon: -84.0 },
    },
});
const adapters = {
    aero,
    weather: NULL_WEATHER,
    plans: NULL_PLANS,
    profiles: NULL_PROFILES,
    network: NULL_NETWORK,
    clock: FROZEN_CLOCK,
};

describe('Optimizer.bestAltitude()', () => {
    it('returns an altitude inside the search range', async () => {
        const opt = new Optimizer(adapters);
        const r = await opt.bestAltitude({
            departure: 'KA',
            destination: 'KC',
            routingMode: 'gps-direct',
        });
        expect(r.altFt).toBeGreaterThanOrEqual(2000);
        expect(r.altFt).toBeLessThanOrEqual(12000);
        expect(r.plan).toBeDefined();
    });
});

describe('Optimizer.leastFuel()', () => {
    it('returns a flight plan optimized for least fuel', async () => {
        const opt = new Optimizer(adapters);
        const plan = await opt.leastFuel({
            departure: 'KA',
            destination: 'KC',
            routingMode: 'gps-direct',
        });
        expect(plan).toBeDefined();
        expect(plan.waypoints).toBeDefined();
        expect(plan.summary).toBeDefined();
    });
});

describe('Optimizer.leastTime()', () => {
    it('returns a flight plan optimized for least time', async () => {
        const opt = new Optimizer(adapters);
        const plan = await opt.leastTime({
            departure: 'KA',
            destination: 'KC',
            routingMode: 'gps-direct',
        });
        expect(plan).toBeDefined();
        expect(plan.waypoints).toBeDefined();
        expect(plan.summary).toBeDefined();
    });
});
