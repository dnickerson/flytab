import { describe, it, expect } from 'vitest';
import { haversine, bearing, intermediatePoint, crossTrackDistanceNm, alongTrackFraction, formatTime } from '../../../web/shared/planning/math/route-math.js';

describe('haversine', () => {
    it('returns 0 for the same point', () => {
        expect(haversine(33, -85, 33, -85)).toBeCloseTo(0, 4);
    });
    it('agrees with a known reference (KLKR → KCLT ≈ 32.05 nm)', () => {
        // KLKR 34.7281,-81.2128  KCLT 35.214,-80.9431
        expect(haversine(34.7281, -81.2128, 35.214, -80.9431)).toBeCloseTo(32.05, 1);
    });
});

describe('bearing', () => {
    it('north is 0°', () => {
        expect(bearing(33, -85, 34, -85)).toBeCloseTo(0, 0);
    });
    it('east is ~90° (89.73° at latitude 33°)', () => {
        expect(bearing(33, -85, 33, -84)).toBeCloseTo(89.73, 1);
    });
});

describe('intermediatePoint', () => {
    it('fraction=0 returns start; fraction=1 returns end', () => {
        const p0 = intermediatePoint(33, -85, 35, -83, 0);
        const p1 = intermediatePoint(33, -85, 35, -83, 1);
        expect(p0.lat).toBeCloseTo(33); expect(p0.lon).toBeCloseTo(-85);
        expect(p1.lat).toBeCloseTo(35); expect(p1.lon).toBeCloseTo(-83);
    });
});

describe('crossTrackDistanceNm', () => {
    it('zero on the great-circle path', () => {
        // Point exactly between two points lies on the path
        const mid = intermediatePoint(33, -85, 35, -83, 0.5);
        expect(Math.abs(crossTrackDistanceNm(33, -85, 35, -83, mid.lat, mid.lon))).toBeLessThan(0.01);
    });
});

describe('alongTrackFraction', () => {
    it('returns 0.5 at the midpoint', () => {
        const mid = intermediatePoint(33, -85, 35, -83, 0.5);
        expect(alongTrackFraction(33, -85, 35, -83, mid.lat, mid.lon)).toBeCloseTo(0.5, 2);
    });
});

describe('formatTime', () => {
    it('1.5 hrs → "1:30"', () => { expect(formatTime(1.5)).toBe('1:30'); });
    it('0.25 hrs → "0:15"', () => { expect(formatTime(0.25)).toBe('0:15'); });
});
