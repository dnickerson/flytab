/**
 * Engine-out glide model (web/shared/glide-model.js).
 *
 * The golden rows are the reference file's plan-B ("direct") output for KLKR 06/24
 * (docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md, "Golden cases"):
 * one 6,004 ft runway centred on the airport reference point, end A landing true 233,
 * end B 053, field elevation 486, default settings, one wind for glide and runway.
 * Since the 2026-11-06 amendment (docs/superpowers/specs/2026-11-06-engine-out-glide-runway-target.md)
 * there is no final point any more: every golden case is 'direct'. A, C, D, E and F-planB are the old
 * table's plan-B rows unchanged; B is the reference's plan-B block (initialTurn / triangle of
 * 2026-10-31-engine-out-glide-reference.js) for case B, computed 2026-11-06.
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
        runwayWind: runwayWind || (wind && Number.isFinite(wind.from) ? { kind: 'metar', from: wind.from, kt: wind.kt, gustKt: null } : { kind: 'none' }),
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

// [case, preferDirect (ignored), kind, end, spare, needMsl, hdg, legNm, target, projected, turnNow]
const GOLDEN = [
    ['A', false, 'direct', 'both', 529, 686, 186, 4.69, 887, 763, 15],
    ['A', true, 'direct', 'both', 529, 686, 186, 4.69, 887, 763, 15],
    ['B', false, 'direct', 'both', 1248, 686, 345, 5.71, 1049, 777, -4],
    ['B', true, 'direct', 'both', 1248, 686, 345, 5.71, 1049, 777, -4],
    ['C', false, 'direct', 'both', -389, 686, 228, 2.51, 585, 735, 178],
    ['C', true, 'direct', 'both', -389, 686, 228, 2.51, 585, 735, 178],
    ['D', false, 'direct', 'both', -1886, 686, 96, 8.61, 448, 749, 2],
    ['D', true, 'direct', 'both', -1886, 686, 96, 8.61, 448, 749, 2],
    ['E', false, 'direct', 'both', -5052, 686, 178, 14.71, 233, 742, -2],
    ['E', true, 'direct', 'both', -5052, 686, 178, 14.71, 233, 742, -2],
    ['F', false, 'direct', 'both', 356, 686, 221, 5.51, 847, 756, -1],
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

        it('marginFt 0 lowers the direct needMsl by exactly 200 versus the default', () => {
            const s0 = S(); s0.pilot.marginFt = 0;
            for (const c of [CASES.B, CASES.E]) {
                const base = GlideModel.plan(input(c), S());
                const zero = GlideModel.plan(input(c), s0);
                expect(base.kind).toBe('direct');
                expect(zero.kind).toBe('direct');
                expect(base.needMsl - zero.needMsl).toBeCloseTo(200, 6);
                expect(zero.spare - base.spare).toBeCloseTo(200, 6);
            }
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

        it('the bank angle changes the answer', () => {
            const base = GlideModel.plan(input(CASES.B), S());
            const sb = S(); sb.pilot.turnBankDeg = 45;
            expect(GlideModel.plan(input(CASES.B), sb).spare).not.toBeCloseTo(base.spare, 1);
        });

        it('the five retired settings and preferDirect have no effect (spec 2026-11-06)', () => {
            const retired = S();
            Object.assign(retired.pilot, { lineUpFtPerDeg: 9, finalPointFraction: 1, finalPointMinFt: 4000,
                finalPointMaxFt: 5000, planBHysteresisFt: 900 });
            for (const c of Object.values(CASES)) {
                const base = GlideModel.plan(input(c), S());
                expect(GlideModel.plan(input(c), retired)).toEqual(base);
                expect(GlideModel.plan(input({ ...c, preferDirect: true }), S())).toEqual(base);
            }
        });
    });

    describe('glide wind shapes in the triangle (spec 2026-11-06 decision 2)', () => {
        const tas = 70;

        it('{ headKt }: that headwind on every course, no crab', () => {
            for (const course of [0, 90, 233, 359]) {
                const t = GlideModel.triangle(course, tas, { headKt: 4 }, S());
                expect(t.gs).toBe(66);
                expect(t.hdg).toBe(course);
                expect(t.wca).toBe(0);
            }
            expect(GlideModel.triangle(90, tas, { headKt: 0 }, S()).gs).toBe(70);       // calm surface wind
            // { headKt } is not the assumed headwind: noWindHeadwindKt does not apply
            const s30 = S(); s30.pilot.noWindHeadwindKt = 30;
            expect(GlideModel.triangle(90, tas, { headKt: 4 }, s30).gs).toBe(66);
            expect(GlideModel.triangle(90, tas, null, s30).gs).toBe(40);
        });

        it('vector wind: the gust replaces kt only on a course where the wind is a headwind', () => {
            const steady = { from: 360, kt: 10 }, gusty = { from: 360, kt: 10, gustKt: 20 };
            // course 000: straight headwind -> gust: gs = 70 - 20
            expect(GlideModel.triangle(0, tas, gusty, S()).gs).toBeCloseTo(50, 9);
            expect(GlideModel.triangle(0, tas, steady, S()).gs).toBeCloseTo(60, 9);
            // course 180: straight tailwind -> steady: gs = 70 + 10
            expect(GlideModel.triangle(180, tas, gusty, S()).gs).toBeCloseTo(80, 9);
            // course 045: headwind component -> the whole vector at 20 kt
            const t45 = GlideModel.triangle(45, tas, gusty, S());
            const wca = Math.asin(20 * Math.sin(rad(-45)) / tas);
            expect(t45.gs).toBeCloseTo(tas * Math.cos(wca) - 20 * Math.cos(rad(-45)), 9);
            // course 135: tailwind component -> the steady 10 kt, the same as without a gust
            expect(GlideModel.triangle(135, tas, gusty, S())).toEqual(GlideModel.triangle(135, tas, steady, S()));
            // a null gust is the steady wind
            expect(GlideModel.triangle(0, tas, { ...steady, gustKt: null }, S())).toEqual(GlideModel.triangle(0, tas, steady, S()));
        });

        it('null keeps the assumed noWindHeadwindKt; a malformed wind is treated as null', () => {
            expect(GlideModel.triangle(90, tas, null, S()).gs).toBe(60);
            expect(GlideModel.triangle(90, tas, { from: NaN, kt: 5 }, S()).gs).toBe(60);
            expect(GlideModel.triangle(90, tas, { headKt: NaN }, S()).gs).toBe(60);
        });

        it('plan(): a VRB surface wind as { headKt: 4 } needs less height than the assumed 10 kt', () => {
            const vrb = GlideModel.plan(input({ ...CASES.C, wind: { headKt: 4 }, runwayWind: { kind: 'vrb', kt: 4, gustKt: null } }), S());
            const none = GlideModel.plan(input({ ...CASES.C, wind: null }), S());
            expect(vrb.kind).toBe('direct');
            expect(vrb.spare).toBeGreaterThan(none.spare);
        });
    });

    // ---- Target choice (spec 2026-11-06 decisions 1 and 3, rulings) ----
    const half = RWY_LEN / 2 / FT_PER_NM;
    const thrA = klkr().ends[0].thr;                   // end A (landing 233) starts at the NE physical end
    /** On the extended centreline of end A, `nm` before its threshold (negative: past it), offset `latNm` to the right. */
    const onFinalA = (nm, latNm = 0) => {
        const back = fromPolar(53, nm), side = fromPolar(233 + 90, latNm);
        return { x: thrA.x + back.x + side.x, y: thrA.y + back.y + side.y };
    };
    const fin = (over = {}) => input({ pos: onFinalA(0.5), alt: 900, trk: 233, gs: 65, wind: null, runwayWind: { kind: 'none' }, ...over });

    describe('short final (kind final)', () => {
        it('lined up within 1 nm: straight glide to the runway end, no turn, no margin, wind triangle on the landing heading', () => {
            const p = GlideModel.plan(fin(), S());
            expect(p.kind).toBe('final');
            expect(p.endId).toBe('A');
            expect(p.pt).toEqual(thrA);
            expect(p.needMsl).toBe(ELEV);
            expect(p.legNm).toBeCloseTo(0.5, 9);
            const tas = 65 * (1 + 0.02 * 0.9), sink = 700 * tas / 65;
            const tMin = 0.5 * 60 / (tas - 10);                   // assumed 10 kt headwind, no initial turn
            expect(p.tMin).toBeCloseTo(tMin, 9);
            expect(p.spare).toBeCloseTo(900 - ELEV - sink * tMin, 9);
            expect(p.target).toBeCloseTo((900 - ELEV) / tMin, 9);
            expect(p.hdgTrue).toBeCloseTo(233, 9);
            expect(Math.abs(p.turnNow)).toBeLessThan(1e-6);
            expect(p.headRwy).toBe(10);
            expect(p.tailwindKt).toBe(0);
        });

        it('along-track gate: 0 < d <= 1.0 nm to the runway end', () => {
            expect(GlideModel.plan(fin({ pos: onFinalA(0.99) }), S()).kind).toBe('final');
            expect(GlideModel.plan(fin({ pos: onFinalA(1.01) }), S()).kind).toBe('direct');
            // past the end, off the paved runway's lateral gate
            expect(GlideModel.plan(fin({ pos: onFinalA(-0.2, 0.05) }), S()).kind).toBe('direct');
        });

        it('lateral gate: within 0.1 nm of the extended centreline', () => {
            expect(GlideModel.plan(fin({ pos: onFinalA(0.5, 0.09) }), S()).kind).toBe('final');
            expect(GlideModel.plan(fin({ pos: onFinalA(0.5, -0.09) }), S()).kind).toBe('final');
            expect(GlideModel.plan(fin({ pos: onFinalA(0.5, 0.11) }), S()).kind).toBe('direct');
            expect(GlideModel.plan(fin({ pos: onFinalA(0.5, -0.11) }), S()).kind).toBe('direct');
        });

        it('track gate: within 30 degrees of the landing heading', () => {
            expect(GlideModel.plan(fin({ trk: 233 + 29 }), S()).kind).toBe('final');
            expect(GlideModel.plan(fin({ trk: 233 - 29 }), S()).kind).toBe('final');
            expect(GlideModel.plan(fin({ trk: 233 + 31 }), S()).kind).toBe('direct');
            expect(GlideModel.plan(fin({ trk: 53 }), S()).kind).toBe('direct');        // the reciprocal
        });

        it('too low on final: CANNOT REACH numbers (spare < 0), still kind final', () => {
            const p = GlideModel.plan(fin({ pos: onFinalA(0.9), alt: ELEV + 50 }), S());
            expect(p.kind).toBe('final');
            expect(p.spare).toBeLessThan(0);
        });

        it('ruling 1: the physical end and that end\'s elevation, not the displaced threshold / field elevation', () => {
            // end A with a threshold displaced 300 ft down the runway and the end 25 ft below the field
            const ap = klkr();
            const disp = fromPolar(233, 300 / FT_PER_NM);
            ap.ends[0] = { ...ap.ends[0], phys: thrA, thr: { x: thrA.x + disp.x, y: thrA.y + disp.y }, elevFt: ELEV - 25 };
            const p = GlideModel.plan(fin({ airport: ap, pos: onFinalA(0.5) }), S());
            expect(p.kind).toBe('final');
            expect(p.pt).toEqual(thrA);
            expect(p.legNm).toBeCloseTo(0.5, 9);
            expect(p.needMsl).toBe(ELEV - 25);
            const tas = 65 * (1 + 0.02 * 0.9), sink = 700 * tas / 65, tMin = 0.5 * 60 / (tas - 10);
            expect(p.spare).toBeCloseTo(900 - (ELEV - 25) - sink * tMin, 9);
            // the along-track gate is measured to the physical end: 0.95 nm before it (1.0 nm + before the threshold)
            expect(GlideModel.plan(fin({ airport: ap, pos: onFinalA(0.99) }), S()).kind).toBe('final');
            expect(GlideModel.plan(fin({ airport: ap, pos: onFinalA(1.01) }), S()).kind).toBe('direct');
        });

        it('ruling 1 fallbacks: no physical end -> the threshold; no end elevation -> the field elevation', () => {
            const ap = klkr();
            ap.ends[0] = { ...ap.ends[0], phys: null, elevFt: null };
            const p = GlideModel.plan(fin({ airport: ap }), S());
            expect(p.kind).toBe('final');
            expect(p.pt).toEqual(ap.ends[0].thr);
            expect(p.needMsl).toBe(ELEV);
            const ap2 = klkr();
            ap2.ends[0] = { ...ap2.ends[0], elevFt: NaN };
            expect(GlideModel.plan(fin({ airport: ap2 }), S()).needMsl).toBe(ELEV);
        });

        it('the landing heading wind triangle uses the glide wind ({ headKt } and vector)', () => {
            const tas = 65 * (1 + 0.02 * 0.9);
            const vrb = GlideModel.plan(fin({ wind: { headKt: 4 } }), S());
            expect(vrb.tMin).toBeCloseTo(0.5 * 60 / (tas - 4), 9);
            const head = GlideModel.plan(fin({ wind: { from: 233, kt: 8, gustKt: 15 } }), S());
            expect(head.tMin).toBeCloseTo(0.5 * 60 / (tas - 15), 9);           // gust on a headwind
            const tail = GlideModel.plan(fin({ wind: { from: 53, kt: 8, gustKt: 15 } }), S());
            expect(tail.tMin).toBeCloseTo(0.5 * 60 / (tas + 8), 9);            // steady on a tailwind
        });
    });

    describe('final headwind (headRwy / tailwindKt) from the runway wind', () => {
        it('METAR: a headwind component uses the gust, a tailwind the steady speed', () => {
            const g = GlideModel.plan(fin({ runwayWind: { kind: 'metar', from: 240, kt: 12, gustKt: 18 } }), S());
            expect(g.kind).toBe('final');
            expect(g.headRwy).toBeCloseTo(18 * Math.cos(rad(7)), 6);
            expect(g.tailwindKt).toBe(0);
            const t = GlideModel.plan(fin({ runwayWind: { kind: 'metar', from: 60, kt: 12, gustKt: 25 } }), S());
            expect(t.headRwy).toBeCloseTo(-12 * Math.cos(rad(7)), 6);
            expect(t.tailwindKt).toBeCloseTo(12 * Math.cos(rad(7)), 6);
        });

        it('a malformed METAR runway wind falls back on the glide wind, never NaN', () => {
            const p = GlideModel.plan(fin({ wind: { headKt: 4 }, runwayWind: { kind: 'metar', from: undefined, kt: 5 } }), S());
            expect(p.headRwy).toBe(4);
        });

        it('VRB: max(kt, gust) as a headwind; VRB without a speed keeps noWindHeadwindKt; calm 0', () => {
            const h = (rw) => GlideModel.plan(fin({ runwayWind: rw }), S()).headRwy;
            expect(h({ kind: 'vrb', kt: 4, gustKt: null })).toBe(4);
            expect(h({ kind: 'vrb', kt: 6, gustKt: 15 })).toBe(15);
            expect(h({ kind: 'vrb' })).toBe(10);
            expect(h({ kind: 'calm' })).toBe(0);
        });

        it('runwayWind none: from the glide wind ({ headKt }, vector with gust), else the assumed headwind', () => {
            const h = (wind) => GlideModel.plan(fin({ wind, runwayWind: { kind: 'none' } }), S()).headRwy;
            expect(h(null)).toBe(10);
            expect(h({ headKt: 4 })).toBe(4);
            expect(h({ from: 240, kt: 12 })).toBeCloseTo(12 * Math.cos(rad(7)), 9);
            expect(h({ from: 240, kt: 12, gustKt: 18 })).toBeCloseTo(18 * Math.cos(rad(7)), 9);
            expect(h({ from: 60, kt: 12, gustKt: 18 })).toBeCloseTo(-12 * Math.cos(rad(7)), 9);
            const s0 = S(); s0.pilot.noWindHeadwindKt = 0;
            expect(GlideModel.plan(fin({ wind: null }), s0).headRwy).toBe(0);
        });

        it('every other kind: headRwy null, tailwindKt 0', () => {
            const rw = { kind: 'metar', from: 60, kt: 15, gustKt: null };
            for (const c of Object.values(CASES)) {
                const p = GlideModel.plan(input({ ...c, runwayWind: rw }), S());
                expect(p.kind).toBe('direct');
                expect(p.headRwy).toBeNull();
                expect(p.tailwindKt).toBe(0);
            }
        });
    });

    describe('over the runway (kind over) and the high pass (ruling 2)', () => {
        // a point on the runway centreline, `k` of the way from the 233 end's physical end... (rwy.a = the SW end)
        const onRwy = (k, latFt = 0) => {
            const a = fromPolar(RWY_TRUE, half), b = fromPolar(RWY_TRUE + 180, half);
            const side = fromPolar(RWY_TRUE + 90, latFt / FT_PER_NM);
            return { x: a.x + k * (b.x - a.x) + side.x, y: a.y + k * (b.y - a.y) + side.y };
        };

        it('low over the runway: OVER, spare = alt - elev, zero leg, no turn', () => {
            const p = GlideModel.plan(input({ pos: onRwy(0.3, 20), alt: ELEV + 40, trk: 233, gs: 50, vs: -300 }), S());
            expect(p.kind).toBe('over');
            expect(p.endId).toBe('both');
            expect(p.needMsl).toBe(ELEV);
            expect(p.spare).toBeCloseTo(40, 9);
            expect(p.legNm).toBe(0);
            expect(p.tMin).toBe(0);
            expect(p.target).toBe(0);
            expect(p.targetNow).toBe(0);
            expect(p.turnNow).toBe(0);
            expect(p.hdgTrue).toBe(233);
            expect(p.measured).toBe(300);
            expect(p.headRwy).toBeNull();
            expect(p.tailwindKt).toBe(0);
            // the rollout: at or below the field, any track
            expect(GlideModel.plan(input({ pos: onRwy(0.6), alt: ELEV - 5, trk: 240, gs: 30 }), S()).kind).toBe('over');
        });

        it('the over gate ends at alt - elev = marginFt; higher: direct with no turn and a zero leg', () => {
            expect(GlideModel.plan(input({ pos: onRwy(0.5), alt: ELEV + 200, trk: 90 }), S()).kind).toBe('over');
            const p = GlideModel.plan(input({ pos: onRwy(0.5), alt: ELEV + 1500, trk: 90, gs: 140 }), S());
            expect(p.kind).toBe('direct');
            expect(p.endId).toBe('both');
            expect(p.needMsl).toBe(ELEV + 200);
            expect(p.spare).toBeCloseTo(1500 - 200, 9);
            expect(p.legNm).toBe(0);
            expect(p.tMin).toBe(0);
            expect(p.target).toBe(0);
            expect(p.targetNow).toBe(0);
            expect(p.turnNow).toBe(0);
            expect(p.hdgTrue).toBe(90);
            // the margin setting moves the gate
            const s5 = S(); s5.pilot.marginFt = 500;
            expect(GlideModel.plan(input({ pos: onRwy(0.5), alt: ELEV + 400, trk: 90 }), s5).kind).toBe('over');
            expect(GlideModel.plan(input({ pos: onRwy(0.5), alt: ELEV + 400, trk: 90 }), S()).kind).toBe('direct');
        });

        it('lateral gate: max(width / 2, 50) + 150 ft from the centreline (100 ft wide when unknown)', () => {
            const at = (latFt, widthFt) => {
                const ap = klkr();
                if (widthFt !== undefined) ap.ends.forEach((e) => { e.widthFt = widthFt; });
                return GlideModel.plan(input({ pos: onRwy(0.5, latFt), alt: ELEV + 100, trk: 233, airport: ap }), S()).kind;
            };
            expect(at(195)).toBe('over');                // unknown width: 50 + 150 = 200 ft
            expect(at(-195)).toBe('over');
            expect(at(205)).toBe('direct');
            expect(at(205, 150)).toBe('over');           // 75 + 150 = 225 ft
            expect(at(230, 150)).toBe('direct');
            expect(at(195, 40)).toBe('over');            // narrow: max(20, 50) + 150 = 200 ft
            expect(at(205, 40)).toBe('direct');
        });

        it('along-runway gate: only strictly between the physical ends (0 < k < 1)', () => {
            expect(GlideModel.plan(input({ pos: onRwy(0.01), alt: ELEV + 100, trk: 233 }), S()).kind).toBe('over');
            expect(GlideModel.plan(input({ pos: onRwy(-0.02), alt: ELEV + 100, trk: 270 }), S()).kind).toBe('direct');
            expect(GlideModel.plan(input({ pos: onRwy(1.02), alt: ELEV + 100, trk: 270 }), S()).kind).toBe('direct');
        });

        it('precedence: over beats final (lined up over the runway)', () => {
            const p = GlideModel.plan(input({ pos: onRwy(0.95), alt: ELEV + 50, trk: 53 }), S());
            expect(p.kind).toBe('over');
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
            // 2 nm north of the field: nearest runway point is the NE end
            const p = GlideModel.plan(input({ pos: fromPolar(0, 2), alt: 1500, trk: 180, wind: null }), S());
            expect(p.kind).toBe('direct');
            const ne = fromPolar(53, half);
            expect(Math.hypot(p.pt.x - ne.x, p.pt.y - ne.y)).toBeLessThan(0.05);
            expect(p.legNm).toBeLessThan(2);
        });

        it('runwayId names the runway: the final end\'s, the nearest segment\'s for direct / over, null for ref', () => {
            // two runways: 05/23 (the golden one) and a 1 nm long 18/36 4 nm north of the field
            const base = klkr();
            base.ends.forEach((e) => { e.runwayId = '05/23'; });
            const n = fromPolar(0, 4), h = 0.5;
            const a = { x: n.x, y: n.y - h }, b = { x: n.x, y: n.y + h };
            const mk = (id, hdg, thr) => ({ id, runwayId: '18/36', thr, hdgTrue: hdg, rwyLenFt: FT_PER_NM, mid: n, rwy: { a, b } });
            const airport = { ...base, ends: [...base.ends, mk('36', 0, a), mk('18', 180, b)] };

            expect(GlideModel.plan(fin(), S()).runwayId).toBeNull();          // ends without runwayId -> null
            const f2 = GlideModel.plan(fin({ airport }), S());
            expect(f2.kind).toBe('final');
            expect(f2.endId).toBe('A');
            expect(f2.runwayId).toBe('05/23');
            const f3 = GlideModel.plan(input({ pos: { x: n.x, y: n.y - h - 0.5 }, alt: 1200, trk: 0, airport }), S());
            expect(f3.kind).toBe('final');
            expect(f3.endId).toBe('36');
            expect(f3.runwayId).toBe('18/36');

            // 1 nm north the nearest runway is 05/23; 4.6 nm north it is 18/36
            const d1 = GlideModel.plan(input({ pos: fromPolar(0, 1), alt: 600, trk: 180, wind: null, airport }), S());
            expect(d1.kind).toBe('direct');
            expect(d1.runwayId).toBe('05/23');
            const d2 = GlideModel.plan(input({ pos: fromPolar(0, 4.6), alt: 700, trk: 90, wind: null, airport }), S());
            expect(d2.kind).toBe('direct');
            expect(d2.runwayId).toBe('18/36');
            const o = GlideModel.plan(input({ pos: n, alt: 600, trk: 90, airport }), S());
            expect(o.kind).toBe('over');
            expect(o.runwayId).toBe('18/36');

            const ref = GlideModel.plan(input({ ...CASES.B, airport: { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: [] } }), S());
            expect(ref.kind).toBe('ref');
            expect(ref.runwayId).toBeNull();
        });
    });

    describe('every output number is finite in every kind', () => {
        it('over, final, direct (incl. the zero-leg high pass) and ref', () => {
            const keys = ['needMsl', 'spare', 'hdgTrue', 'legNm', 'tMin', 'target', 'projected', 'targetNow', 'turnNow', 'tailwindKt', 'measured'];
            const seen = new Set();
            const cases = [
                { pos: { x: 0, y: 0 }, alt: 600 },                  // over
                { pos: { x: 0, y: 0 }, alt: 900 },                  // high over -> direct, zero leg
                { pos: { x: 0, y: 0 }, alt: 6000 },
                { pos: onFinalA(0.5), alt: 900, trk: 233 },         // final
                { pos: onFinalA(0.001), alt: 490, trk: 233 },       // final, at the end
                { pos: fromPolar(0, 5), alt: 4500 },                // direct
                { pos: fromPolar(0, 5), alt: 4500, airport: { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: [] } },   // ref
            ];
            for (const c of cases) {
                for (const wind of [null, { from: 250, kt: 14 }, { from: 250, kt: 14, gustKt: 25 }, { headKt: 4 }]) {
                    const p = GlideModel.plan(input({ trk: 90, ...c, wind }), S());
                    seen.add(p.kind);
                    for (const k of keys) expect(Number.isFinite(p[k]), `${k} ${p.kind} ${JSON.stringify(c.pos)} ${JSON.stringify(wind)}`).toBe(true);
                    expect(Number.isFinite(p.pt.x) && Number.isFinite(p.pt.y)).toBe(true);
                    expect(p.headRwy === null || Number.isFinite(p.headRwy)).toBe(true);
                }
            }
            expect([...seen].sort()).toEqual(['direct', 'final', 'over', 'ref']);
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
