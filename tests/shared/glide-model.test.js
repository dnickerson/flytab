/**
 * Engine-out glide model (web/shared/glide-model.js).
 *
 * The golden rows are the reference file's plan() output for KLKR 06/24
 * (docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md, "Golden cases"):
 * one 6,004 ft runway centred on the airport reference point, end A landing true 233,
 * end B 053, field elevation 486, default settings, one wind for glide and runway.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const { GlideModel } = new Function(readFileSync('web/shared/glide-model.js', 'utf8') + '\nreturn { GlideModel };')();

const FT_PER_NM = 6076.12;
const rad = (d) => d * Math.PI / 180;
const fromPolar = (brg, nm) => ({ x: nm * Math.sin(rad(brg)), y: nm * Math.cos(rad(brg)) });
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const S = () => JSON.parse(JSON.stringify(GlideModel.DEFAULTS));

const ELEV = 486, RWY_LEN = 6004, RWY_TRUE = 233;

/** KLKR as the reference builds it. */
function klkr({ onlyEnd = null } = {}) {
    const half = RWY_LEN / 2 / FT_PER_NM;
    const physA = fromPolar(RWY_TRUE, half);           // far (landing-direction) end of runway A
    const physB = fromPolar(RWY_TRUE + 180, half);
    const mk = (id, hdg, thr) => ({ id, thr, hdgTrue: hdg, rwyLenFt: RWY_LEN, mid: { x: 0, y: 0 }, rwy: { a: physA, b: physB } });
    const ends = [mk('A', RWY_TRUE, physB), mk('B', (RWY_TRUE + 180) % 360, physA)];
    return { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: onlyEnd ? ends.filter((e) => e.id === onlyEnd) : ends };
}

function input({ pos, alt, trk, vs = 0, gs = 140, wind = null, runwayWind, preferDirect = false, airport = klkr() }) {
    return {
        airport,
        ac: { pos, altMsl: alt, gs, trkTrue: trk, vs },
        glideWind: wind,
        runwayWind: runwayWind || (wind ? { kind: 'metar', from: wind.from, kt: wind.kt, gustKt: null } : { kind: 'none' }),
        preferDirect,
    };
}

// Inputs from the scratch generator that produced the table.
const CASES = {
    A: { pos: fromPolar(0, 5), alt: 4500, trk: 160, gs: 145, vs: 0, wind: { from: 250, kt: 14 } },
    B: { pos: fromPolar(180, 6), alt: 5500, trk: 0, gs: 145, vs: 0, wind: { from: 250, kt: 14 } },
    C: { pos: fromPolar(45, 3), alt: 2500, trk: 45, gs: 140, vs: 0, wind: null },
    D: { pos: fromPolar(270, 9), alt: 3500, trk: 90, gs: 140, vs: -500, wind: { from: 250, kt: 14 } },
    E: { pos: fromPolar(0, 15), alt: 3000, trk: 180, gs: 140, vs: 0, wind: { from: 360, kt: 20 } },
    F: { pos: fromPolar(45, 6), alt: 4000, trk: 225, gs: 140, vs: 0, wind: { from: 60, kt: 15 } },
};

// [case, preferDirect, kind, end, spare, needMsl, hdg, legNm, target, projected, turnNow]
const GOLDEN = [
    ['A', false, 'direct', 'both', 529, 686, 186, 4.69, 887, 763, 15],
    ['A', true, 'direct', 'both', 529, 686, 186, 4.69, 887, 763, 15],
    ['B', false, 'final', 'A', 200, 1406, 355, 6.41, 817, 777, 5],
    ['B', true, 'final', 'A', 200, 1406, 355, 6.41, 817, 777, 5],
    ['C', false, 'direct', 'both', -389, 686, 228, 2.51, 585, 735, 178],
    ['C', true, 'direct', 'both', -389, 686, 228, 2.51, 585, 735, 178],
    ['D', false, 'direct', 'both', -1886, 686, 96, 8.61, 448, 749, 2],
    ['D', true, 'direct', 'both', -1886, 686, 96, 8.61, 448, 749, 2],
    ['E', false, 'direct', 'both', -5052, 686, 178, 14.71, 233, 742, -2],
    ['E', true, 'direct', 'both', -5052, 686, 178, 14.71, 233, 742, -2],
    ['F', false, 'final', 'A', 78, 1051, 221, 5.35, 777, 756, -1],
    ['F', true, 'direct', 'both', 356, 686, 221, 5.51, 847, 756, -1],
];

describe('GlideModel', () => {
    describe('golden cases match the reference', () => {
        it.each(GOLDEN)('case %s preferDirect=%s -> %s %s', (c, pd, kind, end, spare, need, hdg, leg, target, projected, turn) => {
            const p = GlideModel.plan(input({ ...CASES[c], preferDirect: pd }), S());
            expect(p.kind).toBe(kind);
            expect(p.endId).toBe(end);
            expect(Math.abs(p.spare - spare)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.needMsl - need)).toBeLessThanOrEqual(1);
            expect(angDiff(p.hdgTrue, hdg)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.legNm - leg)).toBeLessThanOrEqual(0.01);
            expect(Math.abs(p.target - target)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.projected - projected)).toBeLessThanOrEqual(1);
            expect(Math.abs(p.turnNow - turn)).toBeLessThanOrEqual(1);
        });

        it('reports measured as the descent rate and a finite targetNow from the current ground speed', () => {
            const p = GlideModel.plan(input({ ...CASES.D }), S());          // vs -500
            expect(p.measured).toBe(500);
            expect(Number.isFinite(p.targetNow)).toBe(true);
            // the same height to lose over a faster current GS needs a higher rate
            const slow = GlideModel.plan(input({ ...CASES.D, gs: 70 }), S());
            const fast = GlideModel.plan(input({ ...CASES.D, gs: 140 }), S());
            expect(fast.targetNow).toBeGreaterThan(slow.targetNow);
            expect(GlideModel.plan(input({ ...CASES.D, vs: +300 }), S()).measured).toBe(0);
            expect(GlideModel.plan(input({ ...CASES.D, vs: NaN }), S()).measured).toBeNull();
        });
    });

    describe('tasAt / sinkAt exports', () => {
        it('TAS and sink rise by the density setting per 1,000 ft; plan().projected is sinkAt', () => {
            expect(GlideModel.tasAt(0, S())).toBeCloseTo(65, 9);
            expect(GlideModel.tasAt(10000, S())).toBeCloseTo(78, 9);          // 65 x 1.2
            expect(GlideModel.sinkAt(0, S())).toBeCloseTo(700, 9);
            expect(GlideModel.sinkAt(10000, S())).toBeCloseTo(840, 9);        // 700 x 78 / 65
            const custom = S();
            Object.assign(custom.aircraft, { glide_ias_kt: 80, glide_sink_fpm: 900, glide_density_pct_per_kft: 3 });
            expect(GlideModel.tasAt(5000, custom)).toBeCloseTo(80 * 1.15, 9);
            expect(GlideModel.sinkAt(5000, custom)).toBeCloseTo(900 * 1.15, 9);
            const p = GlideModel.plan(input({ pos: fromPolar(0, 5), alt: 4500, trk: 180, wind: null }), S());
            expect(p.projected).toBe(GlideModel.sinkAt(4500, S()));
        });

        it('missing / non-finite settings take the defaults, as in plan()', () => {
            expect(GlideModel.tasAt(10000, undefined)).toBeCloseTo(78, 9);
            expect(GlideModel.sinkAt(10000, { aircraft: { glide_sink_fpm: NaN } })).toBeCloseTo(840, 9);
        });
    });

    describe('every number comes from settings', () => {
        it('doubling glide_sink_fpm doubles projected and changes spare', () => {
            const base = GlideModel.plan(input(CASES.B), S());
            const s2 = S(); s2.aircraft.glide_sink_fpm *= 2;
            const dbl = GlideModel.plan(input(CASES.B), s2);
            expect(dbl.projected).toBeCloseTo(2 * base.projected, 6);
            expect(dbl.spare).not.toBeCloseTo(base.spare, 0);
        });

        it('marginFt 0 lowers needMsl by exactly 200 versus the default', () => {
            const base = GlideModel.plan(input(CASES.B), S());
            const s0 = S(); s0.pilot.marginFt = 0;
            const zero = GlideModel.plan(input(CASES.B), s0);
            expect(base.kind).toBe('final');
            expect(zero.kind).toBe('final');
            expect(base.needMsl - zero.needMsl).toBeCloseTo(200, 6);
            // plan B takes the margin from settings too
            const dBase = GlideModel.plan(input(CASES.E), S());
            const dZero = GlideModel.plan(input(CASES.E), s0);
            expect(dBase.kind).toBe('direct');
            expect(dBase.needMsl - dZero.needMsl).toBeCloseTo(200, 6);
        });

        it('noWindHeadwindKt sets the assumed headwind (gs = tas - it, tas with 0)', () => {
            const tas = 65 * (1 + 0.02 * 4.5);
            expect(GlideModel.triangle(180, tas, null, S()).gs).toBeCloseTo(tas - 10, 9);
            const s0 = S(); s0.pilot.noWindHeadwindKt = 0;
            const t = GlideModel.triangle(180, tas, null, s0);
            expect(t.gs).toBe(tas);
            expect(t.hdg).toBe(180);
            expect(t.wca).toBe(0);
        });

        it('best-glide speed and density come from the aircraft settings', () => {
            const s2 = S(); s2.aircraft.glide_ias_kt = 80; s2.aircraft.glide_density_pct_per_kft = 0;
            const p = GlideModel.plan(input({ ...CASES.D, alt: 3500 }), s2);
            // sink = 700 * tas/ias = 700 with no density change at any altitude
            expect(p.projected).toBeCloseTo(700, 6);
        });

        it('bank angle, final-point and line-up settings change the answer', () => {
            const base = GlideModel.plan(input(CASES.B), S());
            const sb = S(); sb.pilot.turnBankDeg = 45;
            expect(GlideModel.plan(input(CASES.B), sb).spare).not.toBeCloseTo(base.spare, 1);
            const sl = S(); sl.pilot.lineUpFtPerDeg = 3;
            expect(GlideModel.plan(input(CASES.B), sl).needMsl).toBeGreaterThan(base.needMsl);
            const sf = S(); sf.pilot.finalPointMinFt = 1500; sf.pilot.finalPointMaxFt = 1500;
            expect(GlideModel.plan(input(CASES.B), sf).needMsl).toBeGreaterThan(base.needMsl);
            const sh = S(); sh.pilot.planBHysteresisFt = 500;
            // case F final has 78 ft to spare: with preferDirect it needs hysteresis ft
            expect(GlideModel.plan(input({ ...CASES.F, preferDirect: true }), sh).kind).toBe('direct');
        });

        it('hysteresis: a final point with enough spare takes over from plan B', () => {
            const sh = S(); sh.pilot.planBHysteresisFt = 50;
            expect(GlideModel.plan(input({ ...CASES.F, preferDirect: true }), sh).kind).toBe('final');
            expect(GlideModel.plan(input({ ...CASES.F, preferDirect: true }), S()).kind).toBe('direct');
        });
    });

    describe('METAR runway wind with gusts', () => {
        // Aircraft far enough out that both ends are reachable, so the end choice is the wind's.
        const base = { pos: fromPolar(180, 6), alt: 6500, trk: 0, gs: 140, wind: { from: 250, kt: 14 } };

        it('a headwind component uses the gust: 18*cos(7 deg)', () => {
            const rw = { kind: 'metar', from: 240, kt: 12, gustKt: 18 };
            const p = GlideModel.plan(input({ ...base, runwayWind: rw }), S());
            expect(p.endId).toBe('A');
            expect(p.headRwy).toBeCloseTo(18 * Math.cos(rad(7)), 6);
            expect(p.tailwindKt).toBe(0);
            const steady = GlideModel.plan(input({ ...base, runwayWind: { ...rw, gustKt: null } }), S());
            expect(steady.headRwy).toBeCloseTo(12 * Math.cos(rad(7)), 6);
            expect(p.needMsl).toBeGreaterThan(steady.needMsl);       // gust headwind needs more height
        });

        it('a tailwind component uses the steady speed', () => {
            const only = { ...base, airport: klkr({ onlyEnd: 'A' }) };
            const rw = { kind: 'metar', from: 60, kt: 12, gustKt: 25 };   // tailwind on end A (233)
            const p = GlideModel.plan(input({ ...only, runwayWind: rw }), S());
            expect(p.endId).toBe('A');
            expect(p.headRwy).toBeCloseTo(-12 * Math.cos(rad(7)), 6);
            expect(p.tailwindKt).toBeCloseTo(12 * Math.cos(rad(7)), 6);
        });
    });

    describe('tailwind end choice', () => {
        it('only end A reachable under a tailwind: endId A and tailwindKt ~ 15*cos(7)', () => {
            const c = { pos: fromPolar(45, 4), alt: 4000, trk: 225, gs: 140, wind: { from: 250, kt: 14 } };
            const rw = { kind: 'metar', from: 60, kt: 15, gustKt: null };
            const p = GlideModel.plan(input({ ...c, runwayWind: rw }), S());
            // B alone must NOT be reachable, otherwise this would not be a "forced" tailwind landing
            const b = GlideModel.plan(input({ ...c, runwayWind: rw, airport: klkr({ onlyEnd: 'B' }) }), S());
            expect(b.kind).toBe('direct');
            expect(p.kind).toBe('final');
            expect(p.endId).toBe('A');
            expect(Math.abs(p.tailwindKt - 15 * Math.cos(rad(7)))).toBeLessThanOrEqual(0.5);
            expect(p.headRwy).toBeLessThan(0);
        });
    });

    describe('calm and VRB pick the least turn', () => {
        const c = { pos: fromPolar(180, 6), alt: 5500, trk: 0, gs: 140, wind: { from: 250, kt: 14 } };

        it('both choose the end needing the least turn from the current track', () => {
            const calm = GlideModel.plan(input({ ...c, runwayWind: { kind: 'calm' } }), S());
            const vrb = GlideModel.plan(input({ ...c, runwayWind: { kind: 'vrb' } }), S());
            // north-bound from south of the field: end B (053) needs ~60 deg, end A (233) ~135 deg
            expect(calm.kind).toBe('final');
            expect(vrb.kind).toBe('final');
            expect(calm.endId).toBe('B');
            expect(vrb.endId).toBe('B');
            expect(calm.headRwy).toBe(0);
            expect(vrb.headRwy).toBe(10);
            expect(calm.tailwindKt).toBe(0);
            expect(vrb.tailwindKt).toBe(0);
        });

        it('VRB needs more height than calm (a 10 kt headwind on final)', () => {
            const calm = GlideModel.plan(input({ ...c, runwayWind: { kind: 'calm' } }), S());
            const vrb = GlideModel.plan(input({ ...c, runwayWind: { kind: 'vrb' } }), S());
            expect(vrb.needMsl).toBeGreaterThan(calm.needMsl);
        });

        it('mirrors with the track: heading south-west picks end A', () => {
            const p = GlideModel.plan(input({ pos: fromPolar(0, 6), alt: 5500, trk: 180, gs: 140, wind: null, runwayWind: { kind: 'calm' } }), S());
            expect(p.endId).toBe('A');
        });
    });

    describe('runwayWind none', () => {
        it('with a glide wind it behaves exactly as the reference (end by headwind)', () => {
            const a = GlideModel.plan(input({ ...CASES.B }), S());
            const b = GlideModel.plan(input({ ...CASES.B, runwayWind: { kind: 'none' } }), S());
            expect(b.endId).toBe(a.endId);
            expect(b.needMsl).toBeCloseTo(a.needMsl, 9);
        });
        it('with no glide wind, headRwy is the assumed headwind', () => {
            const p = GlideModel.plan(input({ pos: fromPolar(180, 6), alt: 5500, trk: 0, wind: null, runwayWind: { kind: 'none' } }), S());
            expect(p.kind).toBe('final');
            expect(p.headRwy).toBe(10);
            const s0 = S(); s0.pilot.noWindHeadwindKt = 0;
            expect(GlideModel.plan(input({ pos: fromPolar(180, 6), alt: 5500, trk: 0, wind: null }), s0).headRwy).toBe(0);
        });
    });

    describe('missing-threshold fallback', () => {
        it('no runway ends -> kind ref, plan B to the reference point', () => {
            const airport = { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: [] };
            const p = GlideModel.plan(input({ pos: fromPolar(180, 6), alt: 5500, trk: 0, wind: null, airport }), S());
            expect(p.kind).toBe('ref');
            expect(p.endId).toBeNull();
            expect(p.pt).toEqual({ x: 0, y: 0 });
            expect(p.needMsl).toBe(ELEV + 200);
            expect(Number.isFinite(p.spare)).toBe(true);
            expect(p.legNm).toBeCloseTo(6, 1);
        });

        it('ends without usable coordinates are ignored', () => {
            const airport = { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: [{ id: 'A', thr: null, mid: null, hdgTrue: NaN, rwyLenFt: 0 }] };
            const p = GlideModel.plan(input({ pos: fromPolar(90, 4), alt: 4000, trk: 270, wind: null, airport }), S());
            expect(p.kind).toBe('ref');
            for (const v of [p.spare, p.hdgTrue, p.legNm, p.target, p.turnNow]) expect(Number.isFinite(v)).toBe(true);
        });
    });

    describe('plan B target', () => {
        it('goes to the nearest part of the runway, not its mid-point', () => {
            // 2 nm north of the field and too low for any final point: nearest runway point is the NE end
            const p = GlideModel.plan(input({ pos: fromPolar(0, 2), alt: 1500, trk: 180, wind: null }), S());
            expect(p.kind).toBe('direct');
            const half = RWY_LEN / 2 / FT_PER_NM;
            const ne = fromPolar(53, half);
            expect(Math.hypot(p.pt.x - ne.x, p.pt.y - ne.y)).toBeLessThan(0.05);
            expect(p.legNm).toBeLessThan(2);
        });

        it('runwayId names the runway: the chosen end\'s for final, the nearest segment\'s for plan B, null for ref', () => {
            // two runways: 05/23 (the golden one) and a 1 nm long 18/36 4 nm north of the field
            const base = klkr();
            base.ends.forEach((e) => { e.runwayId = '05/23'; });
            const n = fromPolar(0, 4), half = 0.5;
            const a = { x: n.x, y: n.y - half }, b = { x: n.x, y: n.y + half };
            const mk = (id, hdg, thr) => ({ id, runwayId: '18/36', thr, hdgTrue: hdg, rwyLenFt: FT_PER_NM, mid: n, rwy: { a, b } });
            const airport = { ...base, ends: [...base.ends, mk('36', 0, a), mk('18', 180, b)] };

            const fin = GlideModel.plan(input({ ...CASES.B, airport: klkr() }), S());
            expect(fin.kind).toBe('final');
            expect(fin.runwayId).toBeNull();                   // ends without runwayId -> null
            const fin2 = GlideModel.plan(input({ ...CASES.B, airport }), S());
            expect(fin2.kind).toBe('final');
            expect(fin2.runwayId).toBe('05/23');

            // too low for any final point: 1 nm north the nearest runway is 05/23; 4.6 nm north it is 18/36
            const d1 = GlideModel.plan(input({ pos: fromPolar(0, 1), alt: 600, trk: 180, wind: null, airport }), S());
            expect(d1.kind).toBe('direct');
            expect(d1.runwayId).toBe('05/23');
            const d2 = GlideModel.plan(input({ pos: fromPolar(0, 4.6), alt: 700, trk: 180, wind: null, airport }), S());
            expect(d2.kind).toBe('direct');
            expect(d2.runwayId).toBe('18/36');

            const ref = GlideModel.plan(input({ ...CASES.B, airport: { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: [] } }), S());
            expect(ref.kind).toBe('ref');
            expect(ref.runwayId).toBeNull();
        });
    });

    describe('aircraft over the field', () => {
        it('all output numbers are finite', () => {
            for (const alt of [900, 2500, 6000]) {
                for (const preferDirect of [false, true]) {
                    for (const wind of [null, { from: 250, kt: 14 }]) {
                        const p = GlideModel.plan(input({ pos: { x: 0, y: 0 }, alt, trk: 90, wind, preferDirect }), S());
                        for (const k of ['needMsl', 'spare', 'hdgTrue', 'legNm', 'tMin', 'target', 'projected', 'targetNow', 'turnNow', 'tailwindKt']) {
                            expect(Number.isFinite(p[k]), `${k} alt=${alt} pd=${preferDirect} wind=${!!wind}`).toBe(true);
                        }
                        expect(Number.isFinite(p.pt.x) && Number.isFinite(p.pt.y)).toBe(true);
                        expect(Number.isFinite(p.measured)).toBe(true);
                    }
                }
            }
        });
    });

    describe('southern-eastern hemisphere and far airport', () => {
        it('toLocal / fromLocal round-trip within 1e-6 at -33.9, 151.2', () => {
            const refLat = -33.9, refLon = 151.2;
            for (const [lat, lon] of [[-33.5, 151.9], [-34.4, 150.6], [-33.9, 151.2]]) {
                const l = GlideModel.toLocal(refLat, refLon, lat, lon);
                const back = GlideModel.fromLocal(refLat, refLon, l);
                expect(Math.abs(back.lat - lat)).toBeLessThan(1e-6);
                expect(Math.abs(back.lon - lon)).toBeLessThan(1e-6);
            }
            // north is +y, east is +x, one degree of latitude is 60 nm
            const n = GlideModel.toLocal(refLat, refLon, refLat + 1, refLon);
            expect(n.y).toBeCloseTo(60, 9);
            expect(n.x).toBeCloseTo(0, 9);
            expect(GlideModel.toLocal(refLat, refLon, refLat, refLon + 0.1).x).toBeGreaterThan(0);
        });

        it('round-trips across the antimeridian', () => {
            const l = GlideModel.toLocal(-17, 179.9, -17, -179.9);
            expect(l.x).toBeGreaterThan(0);
            expect(l.x).toBeLessThan(15);
            const back = GlideModel.fromLocal(-17, 179.9, l);
            expect(Math.abs(((back.lon - (-179.9) + 540) % 360) - 180)).toBeLessThan(1e-6);
        });

        it('an airport 80 nm away at 18,000 ft: direct, finite negative spare (bearing correct)', () => {
            // aircraft 80 nm south-west of the field, heading toward it
            const pos = fromPolar(225, 80);
            const p = GlideModel.plan(input({ pos, alt: 18000, trk: 45, wind: { from: 250, kt: 30 } }), S());
            expect(p.kind).toBe('direct');
            expect(Number.isFinite(p.spare)).toBe(true);
            expect(p.spare).toBeLessThan(0);
            expect(p.legNm).toBeGreaterThan(75);
            expect(angDiff(p.turnNow, 0)).toBeLessThan(10);
        });
    });
});
