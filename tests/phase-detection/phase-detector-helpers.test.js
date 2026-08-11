import { describe, it, expect } from 'vitest';
import helpersModule from '../../web/shared/phase-detector-helpers.js';

const { haversineMeters, GpsDeltaWindow, RpmSlopeWindow, TrailingAltRate, FieldElevationEstimate } = helpersModule;

describe('haversineMeters', () => {
    it('computes ~111,195m for 1 degree of latitude', () => {
        const d = haversineMeters(0, 0, 1, 0);
        expect(d).toBeCloseTo(111195, -2); // within ~100m (matches Python's 1% tolerance)
    });

    it('returns 0 for the same point', () => {
        expect(haversineMeters(33.5, -85.2, 33.5, -85.2)).toBe(0);
    });
});

describe('GpsDeltaWindow', () => {
    it('reports near-zero delta for a stationary aircraft', () => {
        const win = new GpsDeltaWindow(7);
        let last = 0;
        for (let i = 0; i < 20; i++) {
            last = win.push(33.5, -85.2);
        }
        expect(last).toBeLessThan(1.0);
    });

    it('reports a growing delta once the aircraft starts moving', () => {
        const win = new GpsDeltaWindow(7);
        let lat = 33.5;
        let last = 0;
        for (let i = 0; i < 16; i++) {
            last = win.push(lat, -85.2);
            lat += 0.00008; // ~9m/sample drift, matching the Python fixture's synthetic case
        }
        expect(last).toBeGreaterThan(15.0);
    });
});

describe('RpmSlopeWindow', () => {
    it('returns Infinity until the trailing window is full', () => {
        const win = new RpmSlopeWindow(15);
        let last;
        for (let i = 0; i < 14; i++) last = win.push(800);
        expect(last).toBe(Infinity);
    });

    it('returns rpm[i] - rpm[i-window] once full, matching flattened RPM', () => {
        const win = new RpmSlopeWindow(3);
        win.push(800); win.push(900); win.push(1000);
        const slope = win.push(1000); // window now full: 1000 - 800 = 200
        expect(slope).toBe(200);
    });

    it('reports near-zero slope once RPM has flattened', () => {
        const win = new RpmSlopeWindow(3);
        for (const v of [800, 900, 1000, 1000, 1000, 1000]) win.push(v);
        const slope = win.push(1000);
        expect(slope).toBe(0);
    });
});

describe('TrailingAltRate', () => {
    it('returns null until enough history exists', () => {
        const rate = new TrailingAltRate(30);
        let last;
        for (let i = 0; i < 29; i++) last = rate.push(1000);
        expect(last).toBeNull();
    });

    it('reports ~0 fpm for constant altitude', () => {
        const rate = new TrailingAltRate(10);
        let last;
        for (let i = 0; i < 15; i++) last = rate.push(1000);
        expect(Math.abs(last)).toBeLessThan(5);
    });

    it('reports a positive climb rate for steadily increasing altitude', () => {
        const rate = new TrailingAltRate(10);
        let last;
        for (let i = 0; i < 15; i++) last = rate.push(1000 + i * 10); // 10 ft/s = 600 fpm
        expect(last).toBeGreaterThan(400);
    });
});

describe('FieldElevationEstimate', () => {
    it('locks onto the median ground altitude once lockSamples pre-flight samples accumulate', () => {
        const est = new FieldElevationEstimate(200, 20, 2000);
        let last;
        for (let i = 0; i < 250; i++) {
            last = est.push(620 + (i % 3), 2, 800, true); // stationary, low RPM, altitude ~620ft, not yet moved
        }
        expect(last).toBeCloseTo(621, 0);
    });

    it('locks early on first movement if fewer than lockSamples ground samples were seen (does not drift into a later stop at a different field)', () => {
        const est = new FieldElevationEstimate(200, 20, 2000);
        for (let i = 0; i < 30; i++) est.push(620, 2, 800, true); // only 30 pre-flight ground samples
        const lockedOnMove = est.push(620, 25, 1200, false); // movement detected — must lock now, not wait for 200
        expect(lockedOnMove).toBeCloseTo(620, 0);
        for (let i = 0; i < 50; i++) est.push(450, 2, 800, false); // later ground stop at a DIFFERENT field
        expect(est.push(450, 2, 800, false)).toBeCloseTo(lockedOnMove, 0);
    });

    it('stops updating once locked, even with more pre-flight-looking ground samples fed in', () => {
        const est = new FieldElevationEstimate(200, 20, 2000);
        for (let i = 0; i < 250; i++) est.push(620, 2, 800, true);
        const locked = est.push(620, 2, 800, true);
        for (let i = 0; i < 50; i++) est.push(450, 2, 800, true);
        expect(est.push(450, 2, 800, true)).toBeCloseTo(locked, 0);
    });
});
