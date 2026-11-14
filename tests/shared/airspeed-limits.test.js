/**
 * TAS-limited Vne math (web/shared/airspeed-limits.js).
 *
 * The RV-9A's Vne (210 mph = 182.5 kt, used as 182) applies to BOTH indicated and true
 * airspeed, whichever comes first (Van's Section 15 rev 10/09/2023; Van's Airspeed Indicator
 * Markings chart Rev 1, Dec 2023). The vectors below are Dana's spec of 2026-11-12, unrounded,
 * tolerance ±0.1 kt.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const AL = new Function(readFileSync('web/shared/airspeed-limits.js', 'utf8') + '\nreturn AirspeedLimits;')();

const near = (got, want, tol = 0.1) => expect(Math.abs(got - want)).toBeLessThanOrEqual(tol);

describe('test vectors (spec 2026-11-12)', () => {
    it.each([
        [0, 15, 182.00],
        [0, -20, 182.00],
        [8000, 0, 161.51],
        [8000, -1, 161.81],
        [12000, 20, 144.38],
        [14000, -13, 147.44],
        [5000, 30, 162.10],
    ])('VneIAS(%i ft, %i °C) = %f', (h, oat, want) => {
        near(AL.vneIas(h, oat), want);
    });

    it('CAS→TAS(140 KIAS, 8000 ft, 0 °C) = 157.86 KTAS', () => {
        near(AL.casToTas(140, 8000, 0), 157.86);
    });

    it('TAS→CAS(160 KTAS, 8000 ft, ISA) = 142.13 KIAS', () => {
        near(AL.tasToCas(160, 8000, AL.isaTempC(8000)), 142.13);
    });

    it('round trip TAS→CAS(CAS→TAS(x)) = x within 0.01 kt', () => {
        for (const cas of [50, 78, 102, 140, 156, 182, 200]) {
            for (const [h, oat] of [[-1000, 30], [0, 15], [8000, -1], [18000, -40], [12000, 20]]) {
                const back = AL.tasToCas(AL.casToTas(cas, h, oat), h, oat);
                expect(Math.abs(back - cas)).toBeLessThanOrEqual(0.01);
            }
        }
    });

    it('the IAS cap governs at sea level standard and cold; the TAS limit uncapped is higher there', () => {
        expect(AL.vneIas(0, 15)).toBe(182);
        expect(AL.tasToCas(182, 0, -20)).toBeGreaterThan(182);
        expect(AL.vneIas(0, -20)).toBe(182);
    });
});

describe('atmosphere', () => {
    it('ISA at sea level and 8000 ft', () => {
        expect(AL.pressurePa(0)).toBe(101325);
        near(AL.isaTempC(0), 15, 1e-9);
        near(AL.isaTempC(8000), -0.8496, 1e-6);
    });

    it('density altitude equals pressure altitude at ISA, rises when hot', () => {
        near(AL.densityAltitudeFt(8000, AL.isaTempC(8000)), 8000, 5);
        near(AL.densityAltitudeFt(0, 15), 0, 5);
        expect(AL.densityAltitudeFt(5000, 30)).toBeGreaterThan(7500);
    });
});

describe('°F / °C', () => {
    it('converts both ways', () => {
        near(AL.fToC(32), 0, 1e-9);
        near(AL.fToC(-40), -40, 1e-9);
        near(AL.fToC(212), 100, 1e-9);
        near(AL.cToF(15), 59, 1e-9);
        near(AL.cToF(AL.fToC(41)), 41, 1e-9);
    });

    it('non-finite in, NaN out (the panel never shows it)', () => {
        expect(Number.isNaN(AL.fToC(NaN))).toBe(true);
        expect(Number.isNaN(AL.cToF(undefined))).toBe(true);
    });
});

describe('parseNumber', () => {
    it.each([
        ['8000', 8000], [' 8,000 ', 8000], ['-500', -500], ['−500', -500], ['+12', 12],
        ['12.5', 12.5], ['.5', 0.5], ['12.', 12],
    ])('%j → %d', (s, want) => expect(AL.parseNumber(s)).toBe(want));

    it.each([[''], ['   '], ['-'], ['abc'], ['8k'], ['1e5'], ['12-3'], [null], [undefined], ['1.2.3']])(
        '%j → null', (s) => expect(AL.parseNumber(s)).toBeNull());

    it('accepts finite numbers, rejects non-finite', () => {
        expect(AL.parseNumber(7)).toBe(7);
        expect(AL.parseNumber(NaN)).toBeNull();
        expect(AL.parseNumber(Infinity)).toBeNull();
    });
});

describe('validation and clamping', () => {
    it('altitude: missing / range / ok; the bounds themselves are valid', () => {
        expect(AL.checkAltitude(null)).toBe('missing');
        expect(AL.checkAltitude(-1001)).toBe('range');
        expect(AL.checkAltitude(18001)).toBe('range');
        expect(AL.checkAltitude(-1000)).toBeNull();
        expect(AL.checkAltitude(18000)).toBeNull();
    });

    it('OAT: −60 to +50 °C', () => {
        expect(AL.checkOat(null)).toBe('missing');
        expect(AL.checkOat(-60.1)).toBe('range');
        expect(AL.checkOat(50.1)).toBe('range');
        expect(AL.checkOat(-60)).toBeNull();
        expect(AL.checkOat(50)).toBeNull();
    });

    it('speed: optional; 1 to 300 kt when given', () => {
        expect(AL.checkSpeed(null)).toBe('missing');
        expect(AL.checkSpeed(0)).toBe('range');
        expect(AL.checkSpeed(-5)).toBe('range');
        expect(AL.checkSpeed(301)).toBe('range');
        expect(AL.checkSpeed(1)).toBeNull();
        expect(AL.checkSpeed(300)).toBeNull();
    });

    it('stepAltitude clamps to −1,000 … 18,000 (the step buttons)', () => {
        expect(AL.stepAltitude(17800, 500)).toBe(18000);
        expect(AL.stepAltitude(18000, 500)).toBe(18000);
        expect(AL.stepAltitude(-800, -500)).toBe(-1000);
        expect(AL.stepAltitude(8000, -500)).toBe(7500);
        expect(AL.stepAltitude(null, 500)).toBe(500);
        // A typed value already out of range steps back into range, not further out
        expect(AL.stepAltitude(25000, -500)).toBe(18000);
    });
});

describe('evaluate (what the panel shows)', () => {
    it('rounds Vne here DOWN and names the governing limit', () => {
        const r = AL.evaluate({ pressureAltFt: 8000, oatC: 0 });
        expect(r.ok).toBe(true);
        expect(r.vneKias).toBe(161);           // 161.51 floored
        expect(r.vneRawKias).toBeCloseTo(161.51, 1);
        expect(r.governs).toBe('KTAS');
        expect(r.limitKt).toBe(182);
    });

    it('IAS cap governs at sea level: exactly 182, never 181 from float noise', () => {
        const r = AL.evaluate({ pressureAltFt: 0, oatC: 15 });
        expect(r.vneKias).toBe(182);
        expect(r.governs).toBe('KIAS');
        const cold = AL.evaluate({ pressureAltFt: 0, oatC: -20 });
        expect(cold.vneKias).toBe(182);
        expect(cold.governs).toBe('KIAS');
    });

    it('never shows a Vne above the formula at any grid point', () => {
        for (let h = -1000; h <= 18000; h += 250) {
            for (let t = -60; t <= 50; t += 2.5) {
                const r = AL.evaluate({ pressureAltFt: h, oatC: t });
                expect(r.vneKias).toBeLessThanOrEqual(AL.vneIas(h, t) + 1e-6);
                expect(r.vneKias).toBeGreaterThanOrEqual(Math.floor(AL.vneIas(h, t)) - 1);
            }
        }
    });

    it('KIAS entered: TAS rounded UP, margin against the floored Vne', () => {
        const r = AL.evaluate({ pressureAltFt: 8000, oatC: 0, kias: 140 });
        expect(r.tasKt).toBe(158);             // 157.86 → 158
        expect(r.marginKt).toBe(21);           // 161 − 140
        expect(r.status).toBe('ok');
    });

    it('warning threshold: below / exactly at / above Vne here', () => {
        const below = AL.evaluate({ pressureAltFt: 8000, oatC: 0, kias: 160 });
        expect(below.status).toBe('ok');
        expect(below.marginKt).toBe(1);

        const at = AL.evaluate({ pressureAltFt: 8000, oatC: 0, kias: 161 });
        expect(at.status).toBe('at');
        expect(at.marginKt).toBe(0);

        // 161.5 is below the unrounded 161.51 but above the shown 161: warn (conservative)
        const atRaw = AL.evaluate({ pressureAltFt: 8000, oatC: 0, kias: 161.5 });
        expect(atRaw.status).toBe('over');
        expect(atRaw.marginKt).toBe(-1);

        const over = AL.evaluate({ pressureAltFt: 8000, oatC: 0, kias: 170 });
        expect(over.status).toBe('over');
        expect(over.marginKt).toBe(-9);
    });

    it('KTAS entered: equivalent KIAS rounded DOWN', () => {
        const r = AL.evaluate({ pressureAltFt: 8000, oatC: AL.isaTempC(8000), ktas: 160 });
        expect(r.equivKias).toBe(142);         // 142.13 → 142
    });

    it('density altitude rounded UP to 10 ft; ISA deviation to 0.1 °C', () => {
        const r = AL.evaluate({ pressureAltFt: 8000, oatC: 0 });
        expect(r.densityAltFt % 10).toBe(0);
        expect(r.densityAltFt).toBeGreaterThanOrEqual(AL.densityAltitudeFt(8000, 0));
        expect(r.densityAltFt - AL.densityAltitudeFt(8000, 0)).toBeLessThan(10);
        expect(r.isaDevC).toBe(0.8);           // 0 − (−0.8496)
    });

    it('invalid or missing inputs give ok:false with reasons and no numbers', () => {
        const r = AL.evaluate({ pressureAltFt: null, oatC: NaN });
        expect(r.ok).toBe(false);
        expect(r.errors).toEqual({ alt: 'missing', oat: 'missing' });
        expect(r.vneKias).toBeNull();
        expect(r.densityAltFt).toBeNull();

        const out = AL.evaluate({ pressureAltFt: 25000, oatC: 0 });
        expect(out.ok).toBe(false);
        expect(out.errors.alt).toBe('range');   // rejected, never clamped to 18,000
        expect(out.vneKias).toBeNull();
    });

    it('a bad optional speed does not hide Vne; it reports its own error', () => {
        const r = AL.evaluate({ pressureAltFt: 8000, oatC: 0, kias: -3, ktas: 999 });
        expect(r.ok).toBe(true);
        expect(r.vneKias).toBe(161);
        expect(r.errors).toEqual({ kias: 'range', ktas: 'range' });
        expect(r.tasKt).toBeNull();
        expect(r.status).toBeNull();
        expect(r.equivKias).toBeNull();
    });

    it('no field of any result is NaN or Infinity', () => {
        const cases = [
            {}, { pressureAltFt: 8000 }, { oatC: 0 }, { pressureAltFt: 'x', oatC: 'y' },
            { pressureAltFt: 18000, oatC: 50, kias: 300, ktas: 300 },
            { pressureAltFt: -1000, oatC: -60, kias: 1, ktas: 1 },
        ];
        for (const c of cases) {
            const r = AL.evaluate(c);
            for (const [k, v] of Object.entries(r)) {
                if (typeof v === 'number') expect(Number.isFinite(v), `${k}=${v}`).toBe(true);
            }
        }
    });
});

describe('aircraft limit and position error hooks', () => {
    it('a config Vne below 182 lowers both limits; one above 182 or invalid is ignored', () => {
        const low = AL.evaluate({ pressureAltFt: 0, oatC: 15 }, { vneKt: 175 });
        expect(low.vneKias).toBe(175);
        expect(low.limitKt).toBe(175);
        const high = AL.evaluate({ pressureAltFt: 0, oatC: 15 }, { vneKt: 210 });
        expect(high.vneKias).toBe(182);
        // A numeric string still lowers it (a stored string must not silently restore 182)
        expect(AL.evaluate({ pressureAltFt: 0, oatC: 15 }, { vneKt: '175' }).vneKias).toBe(175);
        for (const bad of [null, undefined, 0, -10, NaN, '182', 'abc', '', 182.5]) {
            expect(AL.evaluate({ pressureAltFt: 0, oatC: 15 }, { vneKt: bad }).vneKias).toBe(182);
        }
    });

    it('position error defaults to zero', () => {
        expect(AL.DEFAULT_PEC_KT).toBe(0);
        const r = AL.evaluate({ pressureAltFt: 8000, oatC: 0 });
        expect(r.pecKt).toBe(0);
    });

    it('a position error (CAS = IAS + pec) moves the TAS-limited Vne in KIAS but not the 182 KIAS cap', () => {
        const r = AL.evaluate({ pressureAltFt: 8000, oatC: 0 }, { pecKt: 3 });
        expect(r.vneRawKias).toBeCloseTo(161.51 - 3, 1);
        expect(r.vneKias).toBe(158);
        const sl = AL.evaluate({ pressureAltFt: 0, oatC: 15 }, { pecKt: -3 });
        expect(sl.vneKias).toBe(182);          // indicated cap stays 182 KIAS
        const tas = AL.evaluate({ pressureAltFt: 8000, oatC: 0, kias: 137 }, { pecKt: 3 });
        expect(tas.tasKt).toBe(158);           // CAS 140 → 157.86
    });

    it('the static reference limits are the RV-9A indicated values', () => {
        expect(AL.LIMITS).toMatchObject({ vneTasKt: 182, vneIasKt: 182, vnoKias: 156, vaKias: 102, vfeKias: 78 });
        expect(Object.isFrozen(AL.LIMITS)).toBe(true);
    });
});

describe('pressure altitude from the altimeter (2026-11-13)', () => {
    // Expected values: an altimeter set to A reads h where the static pressure is
    // (A / 29.92) x the standard pressure at h; the pressure altitude is the standard altitude
    // of that pressure. By definition 29.92 gives back the indicated altitude.
    it.each([
        [0, 29.92, 0],
        [0, 30.92, -912.61],
        [0, 28.92, 937.65],
        [8000, 29.92, 8000],
        [8000, 30.42, 7565.93],
        [18000, 28.50, 19173.55],
        [18000, 30.92, 17200.34],
    ])('%d ft indicated at %f inHg → %f ft pressure altitude', (ind, setting, want) => {
        near(AL.pressureAltitudeFt(ind, setting), want, 0.05);
    });

    it('29.92 gives back the indicated altitude (the definition of pressure altitude)', () => {
        for (const h of [-1000, 0, 5000, 12000, 18000]) near(AL.pressureAltitudeFt(h, AL.STD_ALTIMETER_INHG), h, 1e-6);
    });

    it('sea level standard through the altimeter path is still 182, IAS governs', () => {
        const r = AL.evaluate({ indicatedAltFt: 0, altimeterInHg: 29.92, oatF: 59 });
        expect(r.vneKias).toBe(182);
        expect(r.governs).toBe('KIAS');
    });

    it('checkAltimeter: 27.50 to 31.50 inHg; "3012" without a decimal is out of range', () => {
        expect(AL.checkAltimeter(29.92)).toBeNull();
        expect(AL.checkAltimeter(27.5)).toBeNull();
        expect(AL.checkAltimeter(31.5)).toBeNull();
        expect(AL.checkAltimeter(27.49)).toBe('range');
        expect(AL.checkAltimeter(3012)).toBe('range');
        expect(AL.checkAltimeter(null)).toBe('missing');
    });

    it('evaluate with altimeter + indicated altitude and °F: 8000 ft, 29.92, 32 °F → Vne 161', () => {
        const r = AL.evaluate({ indicatedAltFt: '8000', altimeterInHg: '29.92', oatF: '32' });
        expect(r.ok).toBe(true);
        expect(r.vneKias).toBe(161);
        expect(r.governs).toBe('KTAS');
        expect(r.pressureAltFt).toBe(8000);
        near(r.vneRawKias, AL.vneIas(AL.pressureAltitudeFt(8000, 29.92), 0), 1e-9);
    });

    it('a lower altimeter setting raises the pressure altitude and lowers Vne', () => {
        const hi = AL.evaluate({ indicatedAltFt: 10000, altimeterInHg: 30.50, oatF: 20 });
        const lo = AL.evaluate({ indicatedAltFt: 10000, altimeterInHg: 29.50, oatF: 20 });
        expect(lo.pressureAltFt).toBeGreaterThan(hi.pressureAltFt);
        expect(lo.vneRawKias).toBeLessThan(hi.vneRawKias);
    });

    it('an altimeter typed without its decimal is rejected, no Vne', () => {
        const r = AL.evaluate({ indicatedAltFt: 8000, altimeterInHg: '3012', oatF: 32 });
        expect(r.ok).toBe(false);
        expect(r.errors.altimeter).toBe('range');
        expect(r.errors.alt).toBeUndefined();
        expect(r.vneKias).toBeNull();
        expect(r.pressureAltFt).toBeNull();
    });

    it('a missing altimeter or altitude is reported as missing', () => {
        expect(AL.evaluate({ indicatedAltFt: 8000, altimeterInHg: '', oatF: 32 }).errors.altimeter).toBe('missing');
        expect(AL.evaluate({ indicatedAltFt: '', altimeterInHg: 29.92, oatF: 32 }).errors.alt).toBe('missing');
    });

    it('a pressure altitude pushed past 18,000 ft by a low setting is rejected, not clamped', () => {
        const r = AL.evaluate({ indicatedAltFt: 18000, altimeterInHg: 28.50, oatF: 0 });
        expect(r.ok).toBe(false);
        expect(r.errors.alt).toBe('range');
        expect(r.pressureAltFt).toBe(19180);   // 19,173.55 rounded UP; shown so the pilot sees why
        expect(r.vneKias).toBeNull();
    });

    it('an absurd altitude (extra zero, 150000) is out of range, not missing', () => {
        const r = AL.evaluate({ indicatedAltFt: 150000, altimeterInHg: 29.92, oatF: 32 });
        expect(r.errors.alt).toBe('range');
        expect(r.pressureAltFt).toBeNull();
        expect(r.ok).toBe(false);
    });

    it('°F range is −76 to +122 (−60 to +50 °C), inclusive', () => {
        const base = { indicatedAltFt: 5000, altimeterInHg: 29.92 };
        expect(AL.evaluate({ ...base, oatF: -76 }).ok).toBe(true);
        expect(AL.evaluate({ ...base, oatF: 122 }).ok).toBe(true);
        expect(AL.evaluate({ ...base, oatF: -77 }).errors.oat).toBe('range');
        expect(AL.evaluate({ ...base, oatF: 123 }).errors.oat).toBe('range');
    });

    it('no NaN anywhere for garbage altimeter / altitude / °F', () => {
        for (const [a, s, f] of [['x', '29.92', '32'], ['8000', '-', '32'], ['8000', '29.92', '1e3'],
            [null, null, null], ['18000', '27.5', '-76'], ['-1000', '31.5', '122']]) {
            const r = AL.evaluate({ indicatedAltFt: a, altimeterInHg: s, oatF: f, kias: 140, weightLb: 1500 });
            for (const [k, v] of Object.entries(r)) {
                if (typeof v === 'number') expect(Number.isFinite(v), `${a}/${s}/${f} ${k}`).toBe(true);
            }
        }
    });
});

describe('Va for weight (2026-11-13)', () => {
    it.each([
        [1800, 102],
        [1600, 96],    // 96.17
        [1450, 91],    // 91.55
        [1200, 83],    // 83.28
    ])('%d lb → Va %d KIAS (rounded down)', (w, want) => {
        expect(AL.vaForWeight(w)).toEqual({ kias: want, overGross: false });
    });

    it('over gross: Va stays 102 and is flagged', () => {
        expect(AL.vaForWeight(1900)).toEqual({ kias: 102, overGross: true });
    });

    it('no usable weight → null', () => {
        for (const w of [0, -5, NaN, null, undefined, '', 'abc', Infinity]) expect(AL.vaForWeight(w)).toBeNull();
    });

    it('a typed weight string works; a different gross weight is honoured', () => {
        expect(AL.vaForWeight('1450').kias).toBe(91);
        expect(AL.vaForWeight(1450, { grossLb: 1450 }).kias).toBe(102);
    });

    it('position error: scaled on CAS, then taken back off (pec 2 at 1,450 lb → 91)', () => {
        expect(AL.vaForWeight(1450, { pecKt: 2 }).kias).toBe(91);   // 104·√(1450/1800) − 2 = 91.34
        expect(AL.vaForWeight(1800, { pecKt: 2 }).kias).toBe(102);
    });

    it('evaluate fills vaKias from weightLb even with no altitude or OAT', () => {
        const r = AL.evaluate({ weightLb: 1450 });
        expect(r.ok).toBe(false);
        expect(r.vaKias).toBe(91);
        expect(r.overGross).toBe(false);
        expect(AL.evaluate({}).vaKias).toBeNull();
    });
});
