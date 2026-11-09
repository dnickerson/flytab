/**
 * flight-recorder.js's Gallons Remaining column is the tablet's tracked total
 * (FuelState.getCurrentFuel; tank_state or manual), empty for the capacity default.
 * An exact-zero total (tank empty) must still be logged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();

function makeRecorder(piFuelRemaining) {
    const rec = Object.create(FlightRecorder.prototype);
    rec._csvBuffer = [];
    rec._rowCount = 0;
    rec._gapTimer = null;
    rec._firstGps = null;
    rec._lastGps = null;
    rec._engine = {
        dataAge: 0,
        lastData: {
            data: { RPM: 2400, Fuel_Flow: 9.5, Fuel_Remaining: 99 }, // EMS decoy: must not be used
            fuel: { fuel_remaining: piFuelRemaining },               // Pi tracker decoy
        },
    };
    rec._stratux = { situation: null };
    return rec;
}

function cell(gal, source) {
    globalThis.FuelState = { getCurrentFuel: () => ({ gallons: gal, source, stale: false }) };
    const rec = makeRecorder(30);
    rec._recordRow();
    return rec._csvBuffer[0].split(',')[9]; // column 9 = Gallons Remaining, per CSV_HEADER
}

afterEach(() => { delete globalThis.FuelState; });

describe('FlightRecorder._recordRow Gallons Remaining', () => {
    it('Gallons Remaining column is the tablet-tracked total', () => {
        expect(cell(21.4, 'tank_state')).toBe('21.4');
    });

    it('logs an exact-zero tracked total (tank empty is a real value)', () => {
        expect(cell(0, 'tank_state')).toBe('0');
    });

    it('logs the pilot manual figure', () => {
        expect(cell(15, 'manual')).toBe('15');
    });

    it('is empty (not 36) when only the capacity default is known', () => {
        expect(cell(36, 'capacity')).toBe('');
    });

    it('is empty when FuelState is unavailable, never the Pi or EMS figure', () => {
        delete globalThis.FuelState;
        const rec = makeRecorder(30);
        rec._recordRow();
        expect(rec._csvBuffer[0].split(',')[9]).toBe('');
    });
});
