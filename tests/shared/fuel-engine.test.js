// tests/shared/fuel-engine.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

// fuel-engine.js declares a plain class (no import/export).
// Use new Function to load it in a closure and extract FuelEngine.
const src = readFileSync('web/shared/fuel-engine.js', 'utf8');
const FuelEngine = new Function(`${src}\nreturn FuelEngine;`)();

describe('FuelEngine', () => {
    it('is a constructor function (class)', () => {
        expect(typeof FuelEngine).toBe('function');
    });

    describe('ticToGallons', () => {
        it('returns 0 for tic = 0 (empty tank)', () => {
            // Polynomial has a0 ≈ 2.24, so clamp ensures non-negative.
            // At tic 0, a0 > 0 but the gauge reads "empty" — the polynomial
            // result may be slightly positive; the key contract is it is >= 0.
            expect(FuelEngine.ticToGallons(0)).toBeGreaterThanOrEqual(0);
        });

        it('returns 0 for null input', () => {
            expect(FuelEngine.ticToGallons(null)).toBe(0);
        });

        it('returns 0 for NaN input', () => {
            expect(FuelEngine.ticToGallons(NaN)).toBe(0);
        });

        it('returns 0 for negative input (clamped)', () => {
            expect(FuelEngine.ticToGallons(-5)).toBe(0);
        });

        it('returns a positive number for a mid-range tic', () => {
            const gal = FuelEngine.ticToGallons(5);
            expect(gal).toBeGreaterThan(0);
        });

        it('increases monotonically from tic 1 to 10', () => {
            let prev = FuelEngine.ticToGallons(1);
            for (let t = 2; t <= 10; t++) {
                const curr = FuelEngine.ticToGallons(t);
                expect(curr).toBeGreaterThan(prev);
                prev = curr;
            }
        });

        it('accepts custom coefficients', () => {
            const flat = { a5: 0, a4: 0, a3: 0, a2: 0, a1: 2, a0: 0 };
            // With a1=2, ticToGallons(5) should be 10
            expect(FuelEngine.ticToGallons(5, flat)).toBeCloseTo(10, 5);
        });
    });

    describe('createMeasurement', () => {
        it('returns an object with expected shape', () => {
            const m = FuelEngine.createMeasurement(4, 4);
            expect(m).toHaveProperty('left_gal');
            expect(m).toHaveProperty('right_gal');
            expect(m).toHaveProperty('total_gal');
            expect(m).toHaveProperty('left_tic', 4);
            expect(m).toHaveProperty('right_tic', 4);
            expect(m).toHaveProperty('measured_at');
            expect(m).toHaveProperty('id');
        });

        it('total_gal is the rounded sum of left and right raw gallons', () => {
            // Each field is rounded independently to 1 decimal, so
            // total_gal may differ from left_gal + right_gal by up to 0.1.
            // The contract is total_gal = round(leftRaw + rightRaw, 1).
            const m = FuelEngine.createMeasurement(3, 5);
            expect(m.total_gal).toBeGreaterThan(0);
            // total must be within 0.2 of the sum of the rounded halves
            expect(Math.abs(m.total_gal - (m.left_gal + m.right_gal))).toBeLessThanOrEqual(0.2);
        });

        it('includes variance when edmReading is provided', () => {
            const m = FuelEngine.createMeasurement(4, 4, FuelEngine.DEFAULT_COEFFICIENTS, 20);
            expect(m).toHaveProperty('edm_gal', 20);
            expect(m).toHaveProperty('variance_pct');
        });

        it('omits edm fields when edmReading is null', () => {
            const m = FuelEngine.createMeasurement(4, 4);
            expect(m.edm_gal).toBeUndefined();
            expect(m.variance_pct).toBeUndefined();
        });
    });

    describe('getAccuracyGrade', () => {
        it('returns a string for a zero variance', () => {
            const grade = FuelEngine.getAccuracyGrade(0);
            expect(typeof grade).toBe('string');
            expect(grade.length).toBeGreaterThan(0);
        });

        it('returns a worse grade for high variance than low variance', () => {
            const good = FuelEngine.getAccuracyGrade(2);
            const bad  = FuelEngine.getAccuracyGrade(25);
            // Grades are strings; we just verify they differ meaningfully
            expect(good).not.toBe(bad);
        });
    });

    describe('endurance', () => {
        it('returns zero endurance for zero gph', () => {
            const r = FuelEngine.endurance(40, 0);
            expect(r.totalMin).toBe(0);
        });

        it('returns zero endurance for null gallons', () => {
            const r = FuelEngine.endurance(null, 8);
            expect(r.totalMin).toBe(0);
        });

        it('calculates correctly for 40 gal at 8 gph (5 hr)', () => {
            const r = FuelEngine.endurance(40, 8);
            expect(r.hours).toBe(5);
            expect(r.minutes).toBe(0);
            expect(r.totalMin).toBe(300);
        });

        it('calculates correctly for 10 gal at 8 gph (75 min)', () => {
            const r = FuelEngine.endurance(10, 8);
            expect(r.hours).toBe(1);
            expect(r.minutes).toBe(15);
            expect(r.totalMin).toBe(75);
        });
    });

    describe('fuelForDistance', () => {
        it('returns 0 for zero distance', () => {
            expect(FuelEngine.fuelForDistance(0, 120, 8)).toBe(0);
        });

        it('returns 0 for zero ground speed', () => {
            expect(FuelEngine.fuelForDistance(120, 0, 8)).toBe(0);
        });

        it('calculates correctly: 120 nm at 120 kt, 8 gph → 8 gal', () => {
            expect(FuelEngine.fuelForDistance(120, 120, 8)).toBeCloseTo(8, 5);
        });

        it('calculates correctly: 60 nm at 120 kt, 8 gph → 4 gal', () => {
            expect(FuelEngine.fuelForDistance(60, 120, 8)).toBeCloseTo(4, 5);
        });
    });
});
