/**
 * MagVar (web/shared/mag-var.js) — vendored World Magnetic Model 2025.
 * Checked against the official WMM2025 test values (NOAA/BGS), which cover
 * 2025.0-2029.5, altitudes 0-94 km, and both poles.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
const MagVar = new Function(read('web/shared/mag-var.js') + '\nreturn MagVar;')();

const rows = read('tests/fixtures/wmm2025-test-values.csv')
    .split('\n').filter(l => l && !l.startsWith('#'))
    .map(l => l.split(',').map(Number));

describe('MagVar — WMM2025 official test values', () => {
    it('has the full test table', () => {
        expect(rows.length).toBe(100);
    });

    it.each(rows)('year %s alt %s km lat %s lon %s → declination %s°', (year, altKm, lat, lon, decl) => {
        const d = MagVar.magneticField(lat, lon, altKm, year).declination;
        expect(Math.abs(d - decl)).toBeLessThanOrEqual(0.011);
    });
});

describe('MagVar.declination', () => {
    it('is east-positive: Seattle east, Maine and the Carolinas west', () => {
        expect(MagVar.declination(47.45, -122.31, 2026.75)).toBeGreaterThan(14);
        expect(MagVar.declination(44.81, -68.83, 2026.75)).toBeLessThan(-14);
        const klkr = MagVar.declination(34.72, -80.85, 2026.75);
        expect(klkr).toBeGreaterThan(-9);
        expect(klkr).toBeLessThan(-7);
    });

    it('accepts a Date', () => {
        const d = MagVar.declination(34.72, -80.85, new Date(Date.UTC(2026, 9, 3)));
        expect(d).toBeCloseTo(MagVar.declination(34.72, -80.85, 2026.75), 1);
    });
});
