/**
 * flight-recorder.js's per-row fuel_remaining field used `||` instead of `??`,
 * so an exact-zero reading (tank empty — a real, safety-relevant value) was
 * silently discarded in favor of a fallback field instead of being logged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();

function makeRecorder(fuelRemaining) {
    const rec = Object.create(FlightRecorder.prototype);
    rec._csvBuffer = [];
    rec._rowCount = 0;
    rec._gapTimer = null;
    rec._firstGps = null;
    rec._lastGps = null;
    rec._engine = {
        dataAge: 0,
        lastData: {
            data: { RPM: 2400, Fuel_Flow: 9.5, Fuel_Remaining: 99 }, // decoy fallback value
            fuel: { fuel_remaining: fuelRemaining },
        },
    };
    rec._stratux = { situation: null };
    return rec;
}

describe('FlightRecorder._recordRow fuel_remaining', () => {
    it('logs an exact-zero fuel_remaining instead of falling back', () => {
        const rec = makeRecorder(0);
        rec._recordRow();
        const cols = rec._csvBuffer[0].split(',');
        expect(cols[9]).toBe('0'); // column index 9 = Gallons Remaining, per CSV_HEADER
    });

    it('still falls back to Fuel_Remaining when fuel_remaining is genuinely absent', () => {
        const rec = makeRecorder(undefined);
        rec._recordRow();
        const cols = rec._csvBuffer[0].split(',');
        expect(cols[9]).toBe('99');
    });

    it('uses a real positive fuel_remaining over the fallback', () => {
        const rec = makeRecorder(12.5);
        rec._recordRow();
        const cols = rec._csvBuffer[0].split(',');
        expect(cols[9]).toBe('12.5');
    });
});
