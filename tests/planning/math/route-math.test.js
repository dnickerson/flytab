import { describe, it, expect } from 'vitest';
import { haversine, bearing, intermediatePoint, crossTrackDistanceNm, alongTrackFraction, formatTime, windCorrectedMagHdg, iasToTas, groundSpeed, vfrAltitude } from '../../../web/shared/planning/math/route-math.js';

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

describe('windCorrectedMagHdg', () => {
    it('with no wind returns bearing minus mag var (CONUS approx)', () => {
        // At lat=34, lon=-81 (SC): magVar ≈ -6 + (-81+90)*-0.12 + (34-35)*0.05 = -6 + 9*-0.12 + (-0.05) = -6 -1.08 -0.05 ≈ -7.13
        // bearing 90° true → mag hdg ≈ 90 - (-7.13) = 97.13°
        const hdg = windCorrectedMagHdg(90, 34, -81, 150, 0, 0);
        expect(hdg).toBeCloseTo(97.1, 0);
    });
    it('direct headwind shifts heading toward track', () => {
        // 270° track, wind from 270° (direct headwind) → no WCA
        const hdg = windCorrectedMagHdg(270, 34, -81, 150, 270, 20);
        const hdgNoWind = windCorrectedMagHdg(270, 34, -81, 150, 0, 0);
        expect(Math.abs(hdg - hdgNoWind)).toBeLessThan(1);
    });
    it('90° crosswind produces WCA', () => {
        // 360° track, wind from 090° (right/easterly crosswind at 30 kt, tas 150)
        // Wind pushes aircraft west; pilot crab right (east). WCA = asin(30/150) ≈ 11.5°
        // Wind-corrected heading is larger than no-wind heading (crabbing right of 360°→wraps)
        const hdg = windCorrectedMagHdg(360, 34, -81, 150, 90, 30);
        const hdgNoWind = windCorrectedMagHdg(360, 34, -81, 150, 0, 0);
        expect(hdg - hdgNoWind).toBeCloseTo(11.5, 0);
    });
});

describe('iasToTas', () => {
    it('at sea level standard day, IAS ≈ TAS', () => {
        expect(iasToTas(100, 0, null)).toBeCloseTo(100, 0);
    });
    it('at 8000 ft standard day, TAS > IAS by ~12–13%', () => {
        // ISA density altitude formula: TAS ≈ IAS / sqrt(sigma), sigma=(T/T0)^4.2561
        // At 8000 ft ISA: sigma ≈ 0.786, TAS ≈ 148 / sqrt(0.786) ≈ 166.9 kt (~12.8% increase)
        const tas = iasToTas(148, 8000, null);
        expect(tas).toBeGreaterThan(155);
        expect(tas).toBeLessThan(175);
    });
    it('warmer OAT increases TAS', () => {
        const cold = iasToTas(148, 8000, -15);
        const warm = iasToTas(148, 8000, 15);
        expect(warm).toBeGreaterThan(cold);
    });
});

describe('groundSpeed', () => {
    it('direct headwind reduces GS by wind speed', () => {
        // tas=150, course=360, wind from 360 at 20kt
        expect(groundSpeed(150, 360, 360, 20)).toBeCloseTo(130, 0);
    });
    it('direct tailwind increases GS by wind speed', () => {
        // tas=150, course=360, wind from 180 at 20kt
        expect(groundSpeed(150, 360, 180, 20)).toBeCloseTo(170, 0);
    });
    it('crosswind reduces GS slightly', () => {
        // 90° crosswind reduces GS by crosswind²/2TAS approximately
        const gs = groundSpeed(150, 360, 90, 30);
        expect(gs).toBeLessThan(150);
        expect(gs).toBeGreaterThan(130);
    });
    it('calm wind returns TAS', () => {
        expect(groundSpeed(155, 270, 0, 0)).toBeCloseTo(155, 0);
    });
});

describe('vfrAltitude', () => {
    it('eastbound short route returns 3500 or 5500 ft', () => {
        // KLKR→KCLT bearing ~30° (eastbound), dist ~32nm → short → 3500 or 4000 base
        const alt = vfrAltitude(30, { lat: 34.73, lon: -81.21 }, { lat: 35.21, lon: -80.94 });
        expect([3500, 5500]).toContain(alt);
    });
    it('westbound medium route returns even+500', () => {
        // ~220° course, 200nm → 8000 base → 8500 westbound
        const alt = vfrAltitude(220, { lat: 35, lon: -80 }, { lat: 33, lon: -83 });
        expect(alt % 2000).toBe(500);
        expect(alt).toBeGreaterThanOrEqual(4500);
    });
    it('eastbound long route returns odd+500', () => {
        // ~090° course, ~737nm → 10000 base → 9500 eastbound
        // odd+500 pattern: 3500, 5500, 7500, 9500 — these all have alt%2000 === 1500
        const alt = vfrAltitude(90, { lat: 35, lon: -95 }, { lat: 35, lon: -80 });
        expect(alt % 2000).toBe(1500);
        const remainder = ((alt - 500) / 1000) % 2;
        expect(remainder).toBe(1); // odd thousand
    });
});
