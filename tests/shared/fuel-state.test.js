// tests/shared/fuel-state.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const fuelStateSrc = readFileSync('web/shared/fuel-state.js', 'utf8');

function freshFuelState({ tankState = null, manualOverride = null, capacity = 36 } = {}) {
    global.window = global.window || {};
    global.Settings = {
        fuelManualOverride: manualOverride,
        fuelMeasurement: null,
    };
    global.CockpitConfig = { aircraft: (key) => key === 'performance.fuel_capacity_gal' ? capacity : null };
    global.FuelTankState = { getState: () => tankState };
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
        expect(result).toEqual({ gallons: 22, source: 'manual' });
    });

    it('falls back to FuelTankState total when no override', () => {
        const FuelState = freshFuelState({
            tankState: { left_gal: 8.5, right_gal: 7.2 },
        });
        const result = FuelState.getCurrentFuel();
        expect(result.gallons).toBeCloseTo(15.7, 5);
        expect(result.source).toBe('tank_state');
    });

    it('falls back to capacity when neither override nor tank state exist', () => {
        const FuelState = freshFuelState({ capacity: 36 });
        const result = FuelState.getCurrentFuel();
        expect(result).toEqual({ gallons: 36, source: 'capacity' });
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
