/**
 * Acceptance for the engine-out runway target (docs/superpowers/specs/2026-11-06-engine-out-glide-runway-target.md):
 * the 2026-11-06 KLKR pattern and landing (tests/fixtures/glide/20261106_klkr_pattern.csv, see its README),
 * replayed through the real GlideInputs.airport() + GlideInputs.glideWindFor() + GlideModel.plan() with the
 * real KLKR NASR record (tests/fixtures/airport-panel/nasr-airports.json) and default settings (200 ft margin).
 * Surface wind VRB 4 kt, no winds aloft (below FIS-B's lowest level).
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
    const gw = GlideInputs.glideWindFor(NO_ALOFT, rwy, S);
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
        const gw = GlideInputs.glideWindFor(NO_ALOFT, VRB04, S);
        expect(gw).toEqual({ wind: { headKt: 4 }, label: 'METAR KLKR VRB/04 (8 min) · surface', assumed: false });
    });

    it('downwind 20:02:11-20:03:10: GLIDE OK (direct, spare >= 0) on every row', () => {
        for (const r of between('20:02:11', '20:03:10')) {
            const { plan } = planAt(r, VRB04);
            expect(plan.kind, r.t).toBe('direct');
            expect(plan.runwayId, r.t).toBe('06/24');
            expect(plan.spare, r.t).toBeGreaterThanOrEqual(0);
        }
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
        expect(gw).toEqual({ wind: null, label: 'NO CURRENT WINDS ALOFT · 10 kt headwind assumed', assumed: true });
        expect(plan.kind).toBe('direct');
        expect(plan.spare).toBeLessThan(0);
        // and it is the wind that decides: with VRB 04 the same row is GLIDE OK
        expect(planAt(r, VRB04).plan.spare).toBeGreaterThanOrEqual(0);
    });
});
