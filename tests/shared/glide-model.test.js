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

        it('gust: the triangle is solved with the steady and the gust speed, the LOWER ground speed (and its heading) wins', () => {
            const tasG = 70;
            for (const course of [0, 30, 60, 90, 120, 150, 180, 210, 270, 330]) {
                const st = GlideModel.triangle(course, tasG, { from: 360, kt: 10 }, S());
                const gu = GlideModel.triangle(course, tasG, { from: 360, kt: 25 }, S());
                const both = GlideModel.triangle(course, tasG, { from: 360, kt: 10, gustKt: 25 }, S());
                const lower = st.gs <= gu.gs ? st : gu;
                expect(both, `course ${course}`).toEqual(lower);
            }
            // a pure crosswind: the gust crab costs ground speed, so the gust solution is used
            const x = GlideModel.triangle(90, tasG, { from: 360, kt: 10, gustKt: 25 }, S());
            expect(x.gs).toBeCloseTo(tasG * Math.cos(Math.asin(25 / tasG)), 9);
            expect(x.gs).toBeLessThan(GlideModel.triangle(90, tasG, { from: 360, kt: 10 }, S()).gs);
        });

        it('noTail (a surface METAR wind): a tailwind component counts as 0, a headwind counts in full', () => {
            const tasN = 70;
            expect(GlideModel.triangle(180, tasN, { from: 360, kt: 15, noTail: true }, S()).gs).toBeCloseTo(70, 9);
            expect(GlideModel.triangle(180, tasN, { from: 360, kt: 15 }, S()).gs).toBeCloseTo(85, 9);
            expect(GlideModel.triangle(0, tasN, { from: 360, kt: 15, noTail: true }, S()).gs).toBeCloseTo(55, 9);
            // quartering tail: only the crab remains
            const q = GlideModel.triangle(135, tasN, { from: 360, kt: 15, noTail: true }, S());
            const wca = Math.asin(15 * Math.sin(rad(360 - 135)) / tasN);
            expect(q.gs).toBeCloseTo(tasN * Math.cos(wca), 9);
            // with a gust too: never above the still-air speed on a tail course
            expect(GlideModel.triangle(180, tasN, { from: 360, kt: 10, gustKt: 25, noTail: true }, S()).gs).toBeCloseTo(70, 9);
        });

        it('plan(): a surface METAR tailwind (noTail) on the glide leg gives exactly the calm answer', () => {
            // 3 nm SE of the field, tracking toward the runway (323), wind from 143 = a straight tailwind
            const o = { pos: fromPolar(143, 3), alt: 2500, trk: 323, gs: 80 };
            const tail = GlideModel.plan(input({ ...o, wind: { from: 143, kt: 15, gustKt: null, noTail: true },
                runwayWind: { kind: 'metar', from: 143, kt: 15, gustKt: null } }), S());
            const calm = GlideModel.plan(input({ ...o, wind: { headKt: 0 }, runwayWind: { kind: 'calm' } }), S());
            const aloft = GlideModel.plan(input({ ...o, wind: { from: 143, kt: 15 }, runwayWind: { kind: 'none' } }), S());
            expect(tail.kind).toBe('direct');
            expect(tail.spare).toBeCloseTo(calm.spare, 6);
            expect(aloft.spare).toBeGreaterThan(calm.spare + 20);          // a wind aloft tailwind does count
        });

        it('{ layers }: ground speed = sum of w x each layer\'s own triangle; heading from the heavier layer', () => {
            const tasL = 70;
            const up = { from: 270, kt: 20 }, low = { headKt: 4 };
            for (const course of [0, 90, 180, 270]) {
                const tu = GlideModel.triangle(course, tasL, up, S()), tl = GlideModel.triangle(course, tasL, low, S());
                const t = GlideModel.triangle(course, tasL, { layers: [{ wind: up, w: 0.3 }, { wind: low, w: 0.7 }] }, S());
                expect(t.gs).toBeCloseTo(0.3 * tu.gs + 0.7 * tl.gs, 9);
                expect(t.hdg).toBe(tl.hdg);                                         // the lower layer weighs more
                const t2 = GlideModel.triangle(course, tasL, { layers: [{ wind: up, w: 0.7 }, { wind: low, w: 0.3 }] }, S());
                expect(t2.hdg).toBe(tu.hdg);
                expect(t2.gs).toBeCloseTo(0.7 * tu.gs + 0.3 * tl.gs, 9);
            }
            // each layer keeps its own rules: null = the assumed headwind, noTail, the lower gust
            const t = GlideModel.triangle(180, tasL, { layers: [{ wind: null, w: 0.5 }, { wind: { from: 360, kt: 10, gustKt: 20, noTail: true }, w: 0.5 }] }, S());
            expect(t.gs).toBeCloseTo(0.5 * (tasL - 10) + 0.5 * tasL, 9);
            // a weight-0 layer is ignored; all weights 0 -> the assumed headwind
            expect(GlideModel.triangle(0, tasL, { layers: [{ wind: up, w: 0 }, { wind: low, w: 1 }] }, S())).toEqual(GlideModel.triangle(0, tasL, low, S()));
            expect(GlideModel.triangle(0, tasL, { layers: [] }, S()).gs).toBe(60);
        });

        it('plan() with { layers }: between the two single-wind answers; finite; the final headwind fallback is the weighted mean', () => {
            const o = { pos: fromPolar(143, 3), alt: 2500, trk: 323, gs: 80, runwayWind: { kind: 'none' } };
            const a = GlideModel.plan(input({ ...o, wind: null }), S());
            const b = GlideModel.plan(input({ ...o, wind: { headKt: 4 } }), S());
            const m = GlideModel.plan(input({ ...o, wind: { layers: [{ wind: null, w: 0.4 }, { wind: { headKt: 4 }, w: 0.6 }] } }), S());
            expect(m.spare).toBeGreaterThan(a.spare);
            expect(m.spare).toBeLessThan(b.spare);
            const f = GlideModel.plan(fin({ wind: { layers: [{ wind: null, w: 0.4 }, { wind: { headKt: 4 }, w: 0.6 }] }, runwayWind: { kind: 'none' } }), S());
            expect(f.headRwy).toBeCloseTo(0.4 * 10 + 0.6 * 4, 9);
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

        it('ground speed on final comes from the RUNWAY wind: max(tas - headRwy, 20)', () => {
            const tas = 65 * (1 + 0.02 * 0.9);
            // a 20 kt tailwind aloft and a calm METAR: gs = tas (not tas + 20)
            const calm = GlideModel.plan(fin({ wind: { from: 53, kt: 20 }, runwayWind: { kind: 'calm' } }), S());
            expect(calm.kind).toBe('final');
            expect(calm.tMin).toBeCloseTo(0.5 * 60 / tas, 9);
            // a METAR headwind of 12G18 straight down 233: gs = tas - 18 whatever the glide wind
            const head = GlideModel.plan(fin({ wind: { from: 53, kt: 20 }, runwayWind: { kind: 'metar', from: 233, kt: 12, gustKt: 18 } }), S());
            expect(head.tMin).toBeCloseTo(0.5 * 60 / (tas - 18), 9);
            // VRB 6: a 6 kt headwind
            const vrb = GlideModel.plan(fin({ wind: null, runwayWind: { kind: 'vrb', kt: 6, gustKt: null } }), S());
            expect(vrb.tMin).toBeCloseTo(0.5 * 60 / (tas - 6), 9);
            // floor: a 60 kt headwind -> 20 kt
            const floor = GlideModel.plan(fin({ runwayWind: { kind: 'metar', from: 233, kt: 60, gustKt: null } }), S());
            expect(floor.tMin).toBeCloseTo(0.5 * 60 / 20, 9);
            // the heading still crabs for the glide wind
            expect(GlideModel.plan(fin({ wind: { from: 323, kt: 15 }, runwayWind: { kind: 'calm' } }), S()).hdgTrue).not.toBeCloseTo(233, 0);
        });

        it('no runway wind: the final ground speed falls back on the glide wind ({ headKt } and vector, err high)', () => {
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

    describe('over the runway footprint (rulings after the critical review)', () => {
        // a point on the runway centreline, `k` of the way from the SW physical end (rwy.a) to the NE one (rwy.b);
        // latFt to the right of 053. Runway 6,004 ft, directions 053 (toward b) and 233 (toward a).
        const onRwy = (k, latFt = 0) => {
            const a = fromPolar(RWY_TRUE, half), b = fromPolar(RWY_TRUE + 180, half);
            const side = fromPolar(RWY_TRUE + 90 + 180, latFt / FT_PER_NM);
            return { x: a.x + k * (b.x - a.x) + side.x, y: a.y + k * (b.y - a.y) + side.y };
        };
        /** needAheadFt with no wind (float at TAS), written from the spec: glide distance from the height + 1,000 ft. */
        const needAheadFt = (alt, heightFt) => heightFt / GlideModel.sinkAt(alt, S()) * GlideModel.tasAt(alt, S()) * 101.269 + 1000;
        /** The turn back: the same aircraft planned to the runway mid-point (the reference point here) - a 'ref' plan. */
        const toMid = (o) => GlideModel.plan(input({ ...o, airport: { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: [] } }), S());
        /** The same aircraft planned to point `pt` (a 'ref' plan there: the flown turn + glide, need = field + margin). */
        const toPt = (o, pt) => GlideModel.plan(input({ ...o, airport: { elevFt: ELEV, ref: pt, ends: [] } }), S());
        const SW = fromPolar(RWY_TRUE, half), NE = fromPolar(RWY_TRUE + 180, half);
        /** How far along 053 (as a fraction from the SW end) a point lies. */
        const kOf = (pt) => ((pt.x - SW.x) * (NE.x - SW.x) + (pt.y - SW.y) * (NE.y - SW.y)) / ((NE.x - SW.x) ** 2 + (NE.y - SW.y) ** 2);
        const zeroLeg = (p) => p.legNm === 0 && p.turnNow === 0 && p.tMin === 0;
        const P = (o) => GlideModel.plan(input(o), S());

        it('low, lined up, room ahead: OVER, spare = alt - elev, zero leg, no turn', () => {
            const p = P({ pos: onRwy(0.3, 20), alt: ELEV + 40, trk: 233, gs: 50, vs: -300 });
            expect(p.kind).toBe('over');
            expect(p.endId).toBe('both');
            expect(p.needMsl).toBe(ELEV);
            expect(p.spare).toBeCloseTo(40, 9);
            expect(zeroLeg(p)).toBe(true);
            expect(p.target).toBe(0);
            expect(p.targetNow).toBe(0);
            expect(p.hdgTrue).toBe(233);
            expect(p.measured).toBe(300);
            expect(p.headRwy).toBeNull();
            expect(p.tailwindKt).toBe(0);
        });

        it('rollout at 40 kt lined up with plenty of runway ahead: OVER (either direction)', () => {
            expect(P({ pos: onRwy(0.3), alt: ELEV + 3, trk: 53, gs: 40 }).kind).toBe('over');
            expect(P({ pos: onRwy(0.7), alt: ELEV - 5, trk: 233, gs: 40 }).kind).toBe('over');
        });

        it('taxi speed (gs < showAboveGsKt, default 25): OVER at any track; above it, crossing is not', () => {
            expect(P({ pos: onRwy(0.5), alt: ELEV, trk: 143, gs: 10 }).kind).toBe('over');
            expect(P({ pos: onRwy(0.99), alt: ELEV, trk: 53, gs: 24 }).kind).toBe('over');     // even at the very end
            const fast = P({ pos: onRwy(0.5), alt: ELEV, trk: 143, gs: 30 });
            expect(fast.kind).toBe('direct');
            // showAboveGsKt is read from the pilot settings
            const s35 = S(); s35.pilot.showAboveGsKt = 35;
            expect(GlideModel.plan(input({ pos: onRwy(0.5), alt: ELEV, trk: 143, gs: 30 }), s35).kind).toBe('over');
            // no ground speed known: never taxi
            expect(P({ pos: onRwy(0.5), alt: ELEV + 10, trk: 143, gs: NaN }).kind).toBe('direct');
        });

        it('crossing at right angles at 150 ft (not taxi speed): NOT over - the turn back to the mid-point', () => {
            const o = { pos: onRwy(0.3), alt: ELEV + 150, trk: 143, gs: 70 };
            const p = P(o);
            expect(p.kind).toBe('direct');
            expect(p.endId).toBe('both');
            expect(zeroLeg(p)).toBe(false);
            expect(p.needMsl).toBe(ELEV + 200);
            const mid = toMid(o);
            expect(Math.hypot(p.pt.x, p.pt.y)).toBeLessThan(1e-12);       // the runway mid-point (here the reference point)
            expect(p.spare).toBeCloseTo(mid.spare, 9);
            expect(p.legNm).toBeCloseTo(mid.legNm, 9);
            expect(p.turnNow).toBeCloseTo(mid.turnNow, 9);
        });

        it('over the last 100 ft heading out at 150 ft: NOT over - the turn back', () => {
            const p = P({ pos: onRwy(1 - 100 / RWY_LEN), alt: ELEV + 150, trk: 53, gs: 70 });
            expect(p.kind).toBe('direct');
            expect(zeroLeg(p)).toBe(false);
            expect(p.spare).toBeLessThan(0);
        });

        it('lined up = within 30 degrees of either direction', () => {
            const at = (trk) => P({ pos: onRwy(0.5), alt: ELEV + 50, trk, gs: 60 }).kind;
            for (const t of [53, 53 + 29, 53 - 29, 233, 233 + 29, 233 - 29]) expect(at(t), `trk ${t}`).toBe('over');
            for (const t of [53 + 31, 53 - 31, 233 + 31, 233 - 31, 143, 323]) expect(at(t), `trk ${t}`).toBe('direct');
        });

        it('the room ahead: aheadFt >= glide distance from the height + ROLLOUT_FT 1,000 ft', () => {
            const alt = ELEV + 150;
            const need = needAheadFt(alt, 150);                   // ~2,410 ft; wind null: float at TAS, no headwind credit
            expect(need).toBeGreaterThan(2300);
            expect(need).toBeLessThan(2500);
            const kOk = 1 - (need + 20) / RWY_LEN, kShort = 1 - (need - 20) / RWY_LEN;
            expect(P({ pos: onRwy(kOk), alt, trk: 53, gs: 60 }).kind).toBe('over');
            expect(P({ pos: onRwy(kShort), alt, trk: 53, gs: 60 }).kind).toBe('direct');
            // the assumed 10 kt headwind does not shorten the float; a tailwind lengthens it
            const tw = { from: 233, kt: 20 };                       // a 20 kt tailwind along 053
            const needTw = 150 / GlideModel.sinkAt(alt, S()) * (GlideModel.tasAt(alt, S()) + 20) * 101.269 + 1000;
            const kTw = 1 - (needTw - 20) / RWY_LEN;
            expect(P({ pos: onRwy(kTw), alt, trk: 53, gs: 60 }).kind).toBe('over');
            expect(P({ pos: onRwy(kTw), alt, trk: 53, gs: 60, wind: tw, runwayWind: { kind: 'none' } }).kind).toBe('direct');
            expect(P({ pos: onRwy(1 - (needTw + 20) / RWY_LEN), alt, trk: 53, gs: 60, wind: tw, runwayWind: { kind: 'none' } }).kind).toBe('over');
            // a surface tailwind with noTail still lengthens the float (never helps the verdict)
            expect(P({ pos: onRwy(kTw), alt, trk: 53, gs: 60, wind: { ...tw, noTail: true }, runwayWind: { kind: 'none' } }).kind).toBe('direct');
            // a headwind does not shorten it
            expect(P({ pos: onRwy(kShort), alt, trk: 53, gs: 60, wind: { from: 53, kt: 20 }, runwayWind: { kind: 'none' } }).kind).toBe('direct');
            expect(P({ pos: onRwy(kShort), alt, trk: 53, gs: 60, wind: { headKt: 15 } }).kind).toBe('direct');
        });

        it('the height is above the elevation of the end ahead (its NASR elevation when known)', () => {
            const ap = klkr();
            const physNE = fromPolar(RWY_TRUE + 180, half), physSW = fromPolar(RWY_TRUE, half);
            ap.ends[0] = { ...ap.ends[0], phys: physNE, elevFt: ELEV - 100 };    // end A lands 233 from the NE end
            ap.ends[1] = { ...ap.ends[1], phys: physSW, elevFt: ELEV };
            ap.ends.forEach((e) => { e.rwy = { a: physSW, b: physNE }; });
            const alt = ELEV + 150;
            // heading 053 the end ahead is the NE one, 100 ft lower: 250 ft to float down, not 150
            const need250 = needAheadFt(alt, 250);
            const k = 1 - (need250 - 20) / RWY_LEN;
            const p = GlideModel.plan(input({ pos: onRwy(k), alt, trk: 53, gs: 60, airport: ap }), S());
            expect(p.kind).toBe('direct');
            expect(GlideModel.plan(input({ pos: onRwy(k), alt, trk: 53, gs: 60 }), S()).kind).toBe('over');   // field elevation
            expect(GlideModel.plan(input({ pos: onRwy(1 - (need250 + 20) / RWY_LEN), alt, trk: 53, gs: 60, airport: ap }), S()).kind).toBe('over');
        });

        it('high pass, lined up, enough runway ahead: zero leg, spare = alt - elev - marginFt; not enough: the turn back', () => {
            const alt = ELEV + 300, need = needAheadFt(alt, 300);
            const ok = P({ pos: onRwy(1 - (need + 50) / RWY_LEN), alt, trk: 53, gs: 80 });
            expect(ok.kind).toBe('direct');
            expect(zeroLeg(ok)).toBe(true);
            expect(ok.needMsl).toBe(ELEV + 200);
            expect(ok.spare).toBeCloseTo(100, 9);
            expect(ok.hdgTrue).toBe(53);
            const o = { pos: onRwy(1 - (need - 50) / RWY_LEN), alt, trk: 53, gs: 80 };
            const short = P(o);
            expect(short.kind).toBe('direct');
            expect(zeroLeg(short)).toBe(false);
            // N1: the turn back goes to the physical end BEHIND the aircraft (the SW end, tracking 053)
            expect(short.pt).toEqual(SW);
            expect(short.spare).toBeCloseTo(toPt(o, SW).spare, 9);
            expect(short.spare).toBeLessThan(100);
            // the margin setting moves the over / high-pass line
            const s5 = S(); s5.pilot.marginFt = 500;
            expect(GlideModel.plan(input({ pos: onRwy(0.05), alt: ELEV + 400, trk: 53 }), s5).kind).toBe('over');
            expect(GlideModel.plan(input({ pos: onRwy(0.05), alt: ELEV + 200, trk: 53 }), S()).kind).toBe('over');
            expect(zeroLeg(GlideModel.plan(input({ pos: onRwy(0.05), alt: ELEV + 400, trk: 53 }), S()))).toBe(true);
        });

        it('review probe - climbout over the departure end (track 053, k 0.999): no zero leg, never better than off the end', () => {
            for (const agl of [600, 1000]) {
                const on = P({ pos: onRwy(0.999), alt: ELEV + agl, trk: 53, gs: 80 });
                const off = P({ pos: onRwy(1.001), alt: ELEV + agl, trk: 53, gs: 80 });
                expect(on.kind).toBe('direct');
                expect(zeroLeg(on), `${agl}`).toBe(false);
                expect(Math.abs(on.turnNow)).toBeGreaterThan(170);           // the turn back
                expect(Math.abs(off.turnNow)).toBeGreaterThan(170);
                expect(on.spare).toBeLessThanOrEqual(off.spare);            // never better than off the end
                // N1: lined up without room ahead -> the end behind (the whole runway back); accepted to read lower
                // than one second later off the end
                expect(on.pt).toEqual(SW);
                if (agl === 600) { expect(on.spare).toBeLessThan(0); expect(off.spare).toBeLessThan(0); }   // never GLIDE OK
            }
        });

        describe('re-review ruling N1: the turn back is always behind', () => {
            /** A straight glide along 053 from (k0, h0 above the field), stepping 200 ft at the model's glide rate. */
            const path = (k0, h0) => {
                const out = [];
                for (let k = k0, h = h0; k < 1 && h > 0; k += 200 / RWY_LEN) {
                    const alt = ELEV + h;
                    const o = { pos: onRwy(k), alt, trk: 53, gs: 70 };
                    out.push({ k, h, p: P(o), o });
                    h -= 200 / ((GlideModel.tasAt(alt, S()) - 10) * 101.269) * GlideModel.sinkAt(alt, S());
                }
                return out;
            };
            const STARTS = [[0.2, 600], [0.1, 800], [0.001, 1000]];

            it('the target is never ahead of the aircraft along the runway direction', () => {
                for (const [k0, h0] of STARTS) {
                    const steps = path(k0, h0);
                    expect(steps.length).toBeGreaterThan(20);
                    for (const { k, h, p } of steps) {
                        expect(kOf(p.pt), `k0 ${k0} h0 ${h0}: k ${k.toFixed(3)} h ${h.toFixed(0)}`).toBeLessThanOrEqual(k + 1e-9);
                    }
                }
            });

            it('no green -> red flip from a target ahead: GLIDE OK only as a turn back, spare never jumps', () => {
                for (const [k0, h0] of STARTS) {
                    const steps = path(k0, h0);
                    for (let i = 0; i < steps.length; i++) {
                        const { p, k } = steps[i];
                        if (p.spare >= 0 && p.legNm > 0) expect(kOf(p.pt)).toBeLessThan(k);     // green = turn back
                        if (i > 0) {
                            const d = p.spare - steps[i - 1].p.spare;
                            expect(Math.abs(d), `k0 ${k0}: step ${i}`).toBeLessThan(60);        // the old mid-point jumped ~550 ft
                            expect(d, `k0 ${k0}: step ${i}`).toBeLessThan(15);                   // gliding away only loses
                        }
                    }
                }
                // from k 0.2 / 600 ft it is CANNOT REACH from the start (never green then red)
                expect(path(0.2, 600).every(({ p }) => p.spare < 0)).toBe(true);
            });

            it('crossing (not lined up): still the mid-point', () => {
                const p = P({ pos: onRwy(0.2), alt: ELEV + 600, trk: 143, gs: 70 });
                expect(Math.hypot(p.pt.x, p.pt.y)).toBeLessThan(1e-12);
            });
        });

        it('review probe - crossing at right angles at 400 ft, 199 ft off the centreline: the turn back, not +200', () => {
            const ap = klkr(); ap.ends.forEach((e) => { e.widthFt = 101; });   // gate 200.5 ft
            const o = { pos: onRwy(0.5, 199), alt: ELEV + 400, trk: 143, gs: 90, airport: ap };
            const p = GlideModel.plan(input(o), S());
            expect(p.kind).toBe('direct');
            expect(zeroLeg(p)).toBe(false);
            expect(p.spare).not.toBeCloseTo(200, 0);
            expect(p.spare).toBeLessThan(0);
            expect(p.spare).toBeCloseTo(toMid(o).spare, 9);
        });

        it('lateral gate: max(width / 2, 50) + 150 ft from the centreline (100 ft wide when unknown)', () => {
            const kindAt = (latFt, widthFt) => {
                const ap = klkr();
                if (widthFt !== undefined) ap.ends.forEach((e) => { e.widthFt = widthFt; });
                return GlideModel.plan(input({ pos: onRwy(0.5, latFt), alt: ELEV + 100, trk: 233, airport: ap }), S()).kind;
            };
            expect(kindAt(195)).toBe('over');            // unknown width: 50 + 150 = 200 ft
            expect(kindAt(-195)).toBe('over');
            expect(kindAt(205)).toBe('direct');
            expect(kindAt(205, 150)).toBe('over');       // 75 + 150 = 225 ft
            expect(kindAt(230, 150)).toBe('direct');
            expect(kindAt(195, 40)).toBe('over');        // narrow: max(20, 50) + 150 = 200 ft
            expect(kindAt(205, 40)).toBe('direct');
        });

        it('along-runway gate: only strictly between the physical ends (0 < k < 1); off the end: the nearest point', () => {
            expect(P({ pos: onRwy(0.01), alt: ELEV + 100, trk: 53 }).kind).toBe('over');
            const before = P({ pos: onRwy(-0.02), alt: ELEV + 100, trk: 270 });
            expect(before.kind).toBe('direct');
            expect(before.pt.x).toBeCloseTo(fromPolar(RWY_TRUE, half).x, 9);
            const beyond = P({ pos: onRwy(1.02), alt: ELEV + 100, trk: 270 });
            expect(beyond.kind).toBe('direct');
            expect(beyond.pt.x).toBeCloseTo(fromPolar(RWY_TRUE + 180, half).x, 9);
        });

        it('precedence: low and lined up near the start of the runway is over, not final', () => {
            expect(P({ pos: onRwy(0.02), alt: ELEV + 50, trk: 53, gs: 60 }).kind).toBe('over');
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
            const o = GlideModel.plan(input({ pos: n, alt: 600, trk: 0, airport }), S());    // lined up on 18/36
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
                { pos: { x: 0, y: 0 }, alt: 600, trk: 233 },        // over (lined up, room ahead)
                { pos: fromPolar(53, half * 0.9), alt: 790, trk: 233 },   // high pass, zero leg
                { pos: { x: 0, y: 0 }, alt: 600 },                  // crossing low -> turn back to the mid-point
                { pos: { x: 0, y: 0 }, alt: 900 },
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
