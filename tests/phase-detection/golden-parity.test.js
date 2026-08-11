import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import phaseDetectorModule from '../../web/shared/phase-detector.js';

const { PhaseDetector } = phaseDetectorModule;

const SPEC = JSON.parse(readFileSync(join(__dirname, '../../web/phase_spec.json'), 'utf8'));
const SIGNALS_CSV = readFileSync(join(__dirname, 'fixtures/20260710_KLKR-KLKR_parity.csv'), 'utf8');
const PYTHON_PHASES = JSON.parse(readFileSync(join(__dirname, 'fixtures/20260710_KLKR-KLKR_parity.json'), 'utf8')).phases;

const rows = parse(SIGNALS_CSV, { columns: true, cast: true });

describe('golden parity: JS PhaseDetector vs frozen Python detect_phases() output', () => {
    it('agrees with the Python detector on at least 85% of rows', () => {
        const det = new PhaseDetector(SPEC);
        let agree = 0;
        const jsPhases = [];
        for (const row of rows) {
            const phase = det.classify({
                rpm: row.RPM, mp: row.MP, fuelFlow: row['Fuel Flow'],
                lat: row.latitude, lon: row.longitude, altitudeFt: row.altitude_ft, speedKts: row.speed_kts,
            });
            jsPhases.push(phase);
        }
        for (let i = 0; i < rows.length; i++) {
            if (jsPhases[i] === PYTHON_PHASES[i]) agree++;
        }
        const agreement = agree / rows.length;
        // eslint-disable-next-line no-console
        console.log(`JS/Python phase agreement: ${(agreement * 100).toFixed(1)}% (${agree}/${rows.length})`);
        if (agreement < 0.85) {
            const mismatches = [];
            for (let i = 0; i < rows.length && mismatches.length < 20; i++) {
                if (jsPhases[i] !== PYTHON_PHASES[i]) {
                    mismatches.push(`  [${i}] js=${jsPhases[i]} python=${PYTHON_PHASES[i]}`);
                }
            }
            // eslint-disable-next-line no-console
            console.log(`First disagreements:\n${mismatches.join('\n')}`);
        }
        expect(agreement).toBeGreaterThanOrEqual(0.85);
    });
});
