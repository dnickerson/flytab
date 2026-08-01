// tests/shared/fuel-state.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const fuelStateSrc = readFileSync('web/shared/fuel-state.js', 'utf8');

function freshFuelState({ tankState = null, manualOverride = null, capacity = 36,
                         needsConfirmation = false } = {}) {
    global.window = global.window || {};
    global.Settings = {
        fuelManualOverride: manualOverride,
        fuelMeasurement: null,
    };
    global.CockpitConfig = { aircraft: (key) => key === 'performance.fuel_capacity_gal' ? capacity : null };
    global.FuelTankState = {
        getState: () => tankState,
        needsConfirmation: () => (typeof needsConfirmation === 'function'
            ? needsConfirmation()
            : needsConfirmation),
    };
    global.FuelEngine = { extractEdmFuel: () => 0 };
    return new Function(`${fuelStateSrc}\nreturn FuelState;`)();
}

describe('FuelState.getCurrentFuel()', () => {
    it('returns manual override when set, highest priority', () => {
        const FuelState = freshFuelState({
            manualOverride: 22,
            tankState: { left_gal: 5, right_gal: 5 },
        });
        const result = FuelState.getCurrentFuel();
        expect(result).toEqual({ gallons: 22, source: 'manual', stale: false });
    });

    it('falls back to FuelTankState total when no override', () => {
        const FuelState = freshFuelState({
            tankState: { left_gal: 8.5, right_gal: 7.2 },
        });
        const result = FuelState.getCurrentFuel();
        expect(result.gallons).toBeCloseTo(15.7, 5);
        expect(result.source).toBe('tank_state');
        expect(result.stale).toBe(false);
    });

    it('falls back to capacity when neither override nor tank state exist', () => {
        const FuelState = freshFuelState({ capacity: 36 });
        const result = FuelState.getCurrentFuel();
        expect(result).toEqual({ gallons: 36, source: 'capacity', stale: false });
    });
});

// The staleness predicate is owned here (SDD Task 14) so engine-page.js,
// instrument-strip.js, route-table.js and the activeroute:legupdate payload
// cannot disagree about whether a figure can be trusted.
describe('FuelState.getCurrentFuel() — staleness', () => {
    it('marks a tracked figure stale when FuelTankState needs confirmation', () => {
        const FuelState = freshFuelState({
            tankState: { left_gal: 9, right_gal: 9 },
            needsConfirmation: true,
        });
        const result = FuelState.getCurrentFuel();
        expect(result.gallons).toBeCloseTo(18, 5);
        expect(result.source).toBe('tank_state');
        expect(result.stale).toBe(true);
    });

    it('never marks a manual override stale — it is the pilot\'s own entry', () => {
        const FuelState = freshFuelState({
            manualOverride: 22,
            tankState: { left_gal: 9, right_gal: 9 },
            needsConfirmation: true,
        });
        expect(FuelState.getCurrentFuel().stale).toBe(false);
    });

    it('never marks the capacity fallback stale — nothing is tracked behind it', () => {
        const FuelState = freshFuelState({ capacity: 36, needsConfirmation: true });
        const result = FuelState.getCurrentFuel();
        expect(result.source).toBe('capacity');
        expect(result.stale).toBe(false);
    });

    it('keeps the tracked reading when needsConfirmation() throws — never downgrades to capacity', () => {
        // A throw out of the staleness probe must not fall through to the capacity
        // fallback: that would silently replace a real 10 gal reading with full tanks.
        const FuelState = freshFuelState({
            tankState: { left_gal: 5, right_gal: 5 },
            needsConfirmation: () => { throw new Error('boom'); },
        });
        const result = FuelState.getCurrentFuel();
        expect(result.gallons).toBeCloseTo(10, 5);
        expect(result.source).toBe('tank_state');
        expect(result.stale).toBe(false);
    });
});

describe('FuelState capacity fallback', () => {
    it('matches fuel-tanks.js\'s own fallback derivation when config is unavailable', () => {
        global.window = global.window || {};
        global.Settings = { fuelManualOverride: null, fuelMeasurement: null };
        global.CockpitConfig = undefined; // simulate unavailable config
        global.FuelTankState = { getState: () => null };
        global.FuelEngine = { extractEdmFuel: () => 0 };
        const FuelState = new Function(`${fuelStateSrc}\nreturn FuelState;`)();
        // fuel-tanks.js's own hardcoded fallback is 18/side = 36 total — must match, not the old 50
        expect(FuelState.getCurrentFuel().gallons).toBe(36);
    });
});
