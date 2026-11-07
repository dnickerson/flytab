/**
 * Acceptance for the engine-out runway target (docs/superpowers/specs/2026-11-06-engine-out-glide-runway-target.md):
 * the 2026-11-06 KLKR pattern and landing (tests/fixtures/glide/20261106_klkr_pattern.csv, see its README),
 * replayed through the real GlideInputs.airport() + GlideInputs.glideWindFor() + GlideModel.plan() with the
 * real KLKR NASR record (tests/fixtures/airport-panel/nasr-airports.json) and default settings (200 ft margin).
 * Surface wind VRB 4 kt, no winds aloft (below FIS-B's lowest level). Since Dana's 2026-11-06 rule the surface wind
 * is used only in the lowest 1,000 ft above the field (surfaceWindMaxAglFt); above that the assumed 10 kt headwind
 * applies, weighted by the height share (GlideInputs.glideWindFor with the row's height above the field).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
globalThis.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();

const KLKR = JSON.parse(read('tests/fixtures/airport-panel/nasr-airports.json')).airports.KLKR;
const ROWS = read('tests/fixtures/glide/20261106_klkr_pattern.csv').trim().split('\n').slice(1).map((line) => {
    const [t, lat, lon, alt, gs, trk] = line.split(',');
    return { t, lat: +lat, lon: +lon, alt: +alt, gs: +gs, trk: +trk };
});
const S = GlideInputs.validate({});
const APT = GlideInputs.airport(KLKR, S);
const NO_ALOFT = { wind: null, label: `NO CURRENT WINDS ALOFT · ${S.pilot.noWindHeadwindKt} kt headwind assumed` };
const VRB04 = { wind: { kind: 'vrb', kt: 4, gustKt: null }, label: 'METAR KLKR VRB/04 (8 min)' };
const NONE = { wind: { kind: 'none' }, label: '' };

const sec = (t) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
/** The panel's inputs for one fixture row: position relative to the KLKR reference point (as GlideInputs.aircraft does). */
const planAt = (r, rwy) => {
    const gw = GlideInputs.glideWindFor(NO_ALOFT, rwy, S, r.alt - KLKR.elev_ft);
    const ac = { pos: GlideModel.toLocal(KLKR.lat, KLKR.lon, r.lat, r.lon), altMsl: r.alt, gs: r.gs, trkTrue: r.trk, vs: null };
    return { gw, plan: GlideModel.plan({ airport: APT, ac, glideWind: gw.wind, runwayWind: rwy.wind }, S) };
};
const between = (a, b) => ROWS.filter((r) => sec(r.t) >= sec(a) && sec(r.t) <= sec(b));
const nearest = (t) => ROWS.reduce((best, r) => (Math.abs(sec(r.t) - sec(t)) < Math.abs(sec(best.t) - sec(t)) ? r : best));
const finiteKeys = ['needMsl', 'spare', 'hdgTrue', 'legNm', 'tMin', 'target', 'projected', 'targetNow', 'turnNow', 'tailwindKt'];

describe('KLKR 2026-11-06 pattern, VRB 04, 200 ft margin', () => {
    it('the fixture and the record are what the spec describes', () => {
        expect(KLKR.runways).toHaveLength(1);
        expect(KLKR.runways[0]).toMatchObject({ id: '06/24', width_ft: 101, base_elev_ft: 459.7, base_displ_ft: 105 });
        expect(APT.ends.map((e) => e.id)).toEqual(['06', '24']);
        expect(between('20:02:11', '20:03:10').length).toBeGreaterThan(25);
        expect(nearest('20:04:51').t).toBe('20:04:51');
        expect(nearest('20:04:01').t).toBe('20:04:01');
    });

    it('the VRB 04 METAR becomes a 4 kt headwind on every course, labelled as the surface wind (not amber)', () => {
        // at or below 1,000 ft above the field: the METAR only
        const gw = GlideInputs.glideWindFor(NO_ALOFT, VRB04, S, 569);
        expect(gw).toEqual({ wind: { headKt: 4 }, label: 'METAR KLKR VRB/04 (8 min) · surface', assumed: false, source: 'surface',
            parts: [{ text: 'METAR KLKR VRB/04 (8 min) · surface', amber: false }] });
        // on the downwind (1,146 ft at 20:03:10): the assumed 10 kt above 1,000 ft (amber part), VRB 04 below
        const dw = GlideInputs.glideWindFor(NO_ALOFT, VRB04, S, 1146);
        expect(dw.wind).toEqual({ layers: [{ wind: null, w: 146 / 946 }, { wind: { headKt: 4 }, w: 800 / 946 }] });
        expect(dw.label).toBe('assumed 10 kt headwind above 1,000 ft · METAR KLKR VRB/04 (8 min) below');
        expect(dw.assumed).toBe(true);
    });

    it('downwind 20:02:11-20:03:08: GLIDE OK (direct, spare >= 0) on every row; 20:03:10 is right on the line', () => {
        for (const r of between('20:02:11', '20:03:08')) {
            const { plan } = planAt(r, VRB04);
            expect(plan.kind, r.t).toBe('direct');
            expect(plan.runwayId, r.t).toBe('06/24');
            expect(plan.spare, r.t).toBeGreaterThanOrEqual(0);
        }
        // 1,146 ft above the field: Dana's 1,000 ft rule (2026-11-06) puts 146 ft of the glide in the assumed
        // 10 kt layer, weighted over the height glided down to the 200 ft margin -> about -1 ft. Not tuned.
        const { plan } = planAt(nearest('20:03:10'), VRB04);
        expect(plan.kind).toBe('direct');
        expect(Math.abs(plan.spare)).toBeLessThan(5);
    });

    it('base at 20:04:01 (569 ft above the field, 0.8 nm): CANNOT REACH', () => {
        const { plan } = planAt(nearest('20:04:01'), VRB04);
        expect(plan.kind).toBe('direct');
        expect(plan.spare).toBeLessThan(0);
    });

    it('20:04:51 (33 ft above the field, lined up, before the pavement): GLIDE OK on final to RWY 06', () => {
        const r = nearest('20:04:51');
        const { plan } = planAt(r, VRB04);
        expect(plan.kind).toBe('final');
        expect(plan.endId).toBe('06');
        expect(plan.spare).toBeGreaterThanOrEqual(0);
        // to the 06 physical end at its own elevation (rulings)
        const phys06 = GlideModel.toLocal(KLKR.lat, KLKR.lon, 34.71859708, -80.8631085);
        expect(plan.pt.x).toBeCloseTo(phys06.x, 12);
        expect(plan.pt.y).toBeCloseTo(phys06.y, 12);
        expect(plan.needMsl).toBe(459.7);
        expect(plan.headRwy).toBe(4);
        expect(plan.tailwindKt).toBe(0);
    });

    it('rollout 20:04:55-20:05:30: OVER RWY 06/24 on every row, never a phantom turn', () => {
        const rows = between('20:04:55', '20:05:30');
        expect(rows.length).toBeGreaterThan(15);
        for (const r of rows) {
            const { plan } = planAt(r, VRB04);
            expect(plan.kind, r.t).toBe('over');
            expect(plan.runwayId, r.t).toBe('06/24');
            expect(plan.turnNow, r.t).toBe(0);
            expect(plan.legNm, r.t).toBe(0);
        }
    });

    it('every row 20:01:31-20:06:00 gives finite numbers', () => {
        for (const r of ROWS) {
            const { plan } = planAt(r, VRB04);
            for (const k of finiteKeys) expect(Number.isFinite(plan[k]), `${r.t} ${k}`).toBe(true);
        }
    });
});

describe('the same flight with no METAR and no winds aloft: the assumed 10 kt headwind', () => {
    it('the wind is assumed (amber label) and the last downwind row 20:03:10 is CANNOT REACH', () => {
        const r = nearest('20:03:10');
        const { gw, plan } = planAt(r, NONE);
        expect(gw).toEqual({ wind: null, label: 'NO CURRENT WINDS ALOFT · 10 kt headwind assumed', assumed: true, source: 'assumed',
            parts: [{ text: 'NO CURRENT WINDS ALOFT · 10 kt headwind assumed', amber: true }] });
        expect(plan.kind).toBe('direct');
        expect(plan.spare).toBeLessThan(0);
        // and it is the wind that decides: with VRB 04 below 1,000 ft the same row is about even (−75 -> ~−1 ft)
        expect(planAt(r, VRB04).plan.spare - plan.spare).toBeGreaterThan(60);
    });
});

describe('the critical review probes on the real KLKR record (VRB 04)', () => {
    const RW = KLKR.runways[0], FT = 6076.12;
    const A = GlideModel.toLocal(KLKR.lat, KLKR.lon, RW.base_lat, RW.base_lon);      // the 06 end
    const B = GlideModel.toLocal(KLKR.lat, KLKR.lon, RW.recip_lat, RW.recip_lon);    // the 24 end
    const LEN_FT = Math.hypot(B.x - A.x, B.y - A.y) * FT;
    const BRG = (Math.atan2(B.x - A.x, B.y - A.y) * 180 / Math.PI + 360) % 360;      // ~058
    /** k of the way from the 06 end to the 24 end, latFt to the right of the 06 direction. */
    const at = (k, latFt = 0) => {
        const r = (BRG + 90) * Math.PI / 180, l = latFt / FT;
        return { x: A.x + k * (B.x - A.x) + l * Math.sin(r), y: A.y + k * (B.y - A.y) + l * Math.cos(r) };
    };
    const P = (pos, agl, trk, gs) => GlideModel.plan({ airport: APT,
        ac: { pos, altMsl: KLKR.elev_ft + agl, gs, trkTrue: trk, vs: null },
        glideWind: GlideInputs.glideWindFor(NO_ALOFT, VRB04, S, agl).wind, runwayWind: VRB04.wind }, S);
    const zeroLeg = (p) => p.legNm === 0 && p.turnNow === 0;

    it('climbout over the 24 end (track 059, k 0.999) at 600 / 1,000 ft: a turn back to the 06 end, never better than off the end', () => {
        for (const agl of [600, 1000]) {
            const on = P(at(0.999), agl, 59, 80), off = P(at(1.001), agl, 59, 80);
            expect(on.kind).toBe('direct');
            expect(zeroLeg(on)).toBe(false);
            expect(Math.abs(on.turnNow)).toBeGreaterThan(170);
            expect(on.spare).toBeLessThanOrEqual(off.spare);
            expect(on.pt.x).toBeCloseTo(A.x, 12);                         // N1: the physical end behind (06)
            expect(on.pt.y).toBeCloseTo(A.y, 12);
        }
        expect(P(at(0.999), 600, 59, 80).spare).toBeLessThan(0);          // never GLIDE OK at 600 ft
    });

    it('N1: a straight glide along 06 from k 0.2 / 600, k 0.1 / 800, k 0 / 1,000 ft: the target is never ahead, no jump', () => {
        const kOf = (pt) => ((pt.x - A.x) * (B.x - A.x) + (pt.y - A.y) * (B.y - A.y)) / ((B.x - A.x) ** 2 + (B.y - A.y) ** 2);
        for (const [k0, h0] of [[0.2, 600], [0.1, 800], [0.001, 1000]]) {
            let prev = null;
            for (let k = k0, h = h0; k < 1 && h > 0; k += 200 / LEN_FT) {
                const p = P(at(k), h, BRG, 70);
                expect(kOf(p.pt), `${k0}/${h0} at k ${k.toFixed(3)}`).toBeLessThanOrEqual(k + 1e-9);
                if (prev) expect(Math.abs(p.spare - prev.spare), `${k0}/${h0} at k ${k.toFixed(3)}`).toBeLessThan(60);
                prev = p;
                const alt = KLKR.elev_ft + h;
                h -= 200 / ((GlideModel.tasAt(alt, S) - 4) * 101.269) * GlideModel.sinkAt(alt, S);
            }
        }
        // from k 0.2 / 600 ft: CANNOT REACH from the start (the old mid-point target read GLIDE OK +197 here)
        expect(P(at(0.2), 600, BRG, 70).spare).toBeLessThan(0);
    });

    it('crossing at right angles at 400 ft, 199 ft off the centreline: the turn back, not +200', () => {
        const p = P(at(0.5, 199), 400, 149, 90);
        expect(p.kind).toBe('direct');
        expect(zeroLeg(p)).toBe(false);
        expect(p.spare).toBeLessThan(0);
    });

    it('crossing at right angles at 150 ft: not over; over the last 100 ft heading out at 150 ft: not over', () => {
        expect(P(at(0.5), 150, 149, 70).kind).toBe('direct');
        const out = P(at(1 - 100 / LEN_FT), 150, 59, 70);
        expect(out.kind).toBe('direct');
        expect(zeroLeg(out)).toBe(false);
    });

    it('rollout at 40 kt lined up: over; taxi speed crossing: over', () => {
        expect(P(at(0.3), 3, 59, 40).kind).toBe('over');
        expect(P(at(0.5), 0, 149, 10).kind).toBe('over');
    });

    it('high pass lined up at 300 ft: zero leg with ~5,400 ft ahead, the turn back with ~2,400 ft ahead', () => {
        const ok = P(at(0.1), 300, 59, 80);
        expect(ok.kind).toBe('direct');
        expect(zeroLeg(ok)).toBe(true);
        expect(ok.spare).toBeCloseTo(100, 9);
        const short = P(at(0.6), 300, 59, 80);
        expect(zeroLeg(short)).toBe(false);
        expect(short.spare).toBeLessThan(0);
    });
});
