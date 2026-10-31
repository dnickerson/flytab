/**
 * GlideInputs (web/cockpit/glide-inputs.js): app state -> engine-out glide model inputs.
 *
 * Data shapes are the real ones (verified 2026-10-31):
 *  - NASR airport record in the bundle/IndexedDB: elev_ft, fac_type, lat/lon, runways[] with
 *    length_ft, surface and per end (base_/recip_) id, lat, lon, thr_lat, thr_lon, true_hdg.
 *    Missing FAA data is an ABSENT key (or null), not 0.
 *  - FisbClient: metars Map(icao -> { raw, decoded, received_at }), decoded.observed_at ISO,
 *    wind_dir (null for VRB), wind_speed, wind_gust; getNearestWind -> { dir, spd, alt, lat, lon,
 *    station, received_at }.
 *  - Stratux situation: alt_msl (ft), alt_baro, ground_speed (kt), true_course, vertical_speed,
 *    gps_fix_quality, timestamp (ms epoch, Date.now() at receipt).
 *  - Route planner winds: { STN: { altFt: { dir, spd, variable? } } }.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
globalThis.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();

const NOW = Date.parse('2026-10-31T18:00:00Z');
const D = GlideModel.DEFAULTS;
const settings = (over = {}) => ({
    aircraft: { ...D.aircraft, ...(over.aircraft || {}) },
    pilot: { ...D.pilot, ...(over.pilot || {}) },
});

// KLKR exactly as the 2611 bundle has it (06 has a displaced threshold).
const KLKR_RWY = {
    id: '06/24', length_ft: 6004, width_ft: 101, surface: 'CONC-E',
    base_id: '06', base_lat: 34.71859708, base_lon: -80.8631085,
    base_thr_lat: 34.71874788, base_thr_lon: -80.86280972,
    base_elev_ft: 459.7, base_true_hdg: 59, base_displ_ft: 105, base_tch_ft: 41,
    recip_id: '24', recip_lat: 34.72721166, recip_lon: -80.84607163,
    recip_thr_lat: 34.72721166, recip_thr_lon: -80.84607163,
    recip_elev_ft: 485.7, recip_true_hdg: 239, recip_displ_ft: 0, recip_tch_ft: 39,
};
const KLKR = {
    icao: 'KLKR', name: 'Lancaster County-Mc Whirter Fld', lat: 34.722904, lon: -80.85459,
    elev_ft: 486, fac_type: 'AIRPORT', runways: [KLKR_RWY],
};
const rwy = (over) => ({ ...KLKR_RWY, ...over });
const apt = (runways, over = {}) => ({ ...KLKR, runways, ...over });

// ---------- airport() ----------
describe('GlideInputs.airport', () => {
    it('paved preferred, min length, heliport excluded', () => {
        const turf = rwy({ id: '09/27', surface: 'TURF-G', length_ft: 3500, base_id: '09', recip_id: '27' });
        const paved = rwy({ id: '06/24', surface: 'ASPH-G', length_ft: 3000 });
        const short = rwy({ id: '15/33', surface: 'ASPH', length_ft: 1200, base_id: '15', recip_id: '33' });

        // paved qualifies -> the turf runway (longer) is not a candidate
        let a = GlideInputs.airport(apt([turf, paved, short]), settings({ aircraft: { min_runway_ft: 2500 } }));
        expect(a.ends.map((e) => e.id)).toEqual(['06', '24']);
        expect(a.noSuitable).toBe(false);
        expect(a.excluded).toBe(null);

        // no paved runway long enough -> the turf runway is used
        a = GlideInputs.airport(apt([turf, paved, short]), settings({ aircraft: { min_runway_ft: 3200 } }));
        expect(a.ends.map((e) => e.id)).toEqual(['09', '27']);

        // nothing long enough -> no ends and noSuitable (the airport has runways)
        a = GlideInputs.airport(apt([turf, paved, short]), settings({ aircraft: { min_runway_ft: 9000 } }));
        expect(a.ends).toEqual([]);
        expect(a.noSuitable).toBe(true);

        // unset minimum -> no length filter (the 1,200 ft paved runway counts as paved)
        a = GlideInputs.airport(apt([turf, short]), settings());
        expect(a.ends.map((e) => e.id)).toEqual(['15', '33']);

        // a water runway is never a landplane target
        const water = rwy({ id: '18W/36W', surface: 'WATER', length_ft: 8000, base_id: '18W', recip_id: '36W' });
        a = GlideInputs.airport(apt([water]), settings());
        expect(a.ends).toEqual([]);
        expect(a.noSuitable).toBe(true);

        // heliport / seaplane base: excluded, no ends
        a = GlideInputs.airport(apt([paved], { fac_type: 'HELIPORT' }), settings());
        expect(a.excluded).toBe('heliport');
        expect(a.ends).toEqual([]);
        a = GlideInputs.airport(apt([paved], { fac_type: 'SEAPLANE BASE' }), settings());
        expect(a.excluded).toBe('seaplane');
    });

    it('helipads listed on an airport record are not runways', () => {
        const pad = rwy({ id: 'H1', surface: 'CONC', length_ft: 60, base_id: 'H1' });
        // a helipad does not become an end ...
        let a = GlideInputs.airport(apt([pad, KLKR_RWY]), settings());
        expect(a.ends.map((e) => e.id)).toEqual(['06', '24']);
        // ... and, being "paved", does not block the turf fallback
        const turf = rwy({ id: '09/27', surface: 'TURF', length_ft: 3500, base_id: '09', recip_id: '27' });
        a = GlideInputs.airport(apt([pad, turf]), settings());
        expect(a.ends.map((e) => e.id)).toEqual(['09', '27']);
        // only helipads: no ends, and not "no suitable runway"
        a = GlideInputs.airport(apt([pad, rwy({ id: 'H', surface: 'CONC' }), rwy({ id: 'H12' })]), settings());
        expect(a.ends).toEqual([]);
        expect(a.noSuitable).toBe(false);
    });

    it('builds model ends from the real KLKR record (threshold, heading, mid-runway, length)', () => {
        const a = GlideInputs.airport(KLKR, settings());
        expect(a.elevFt).toBe(486);
        expect(a.ref).toEqual({ x: 0, y: 0 });
        expect(a.refLatLon).toEqual({ lat: 34.722904, lon: -80.85459 });
        expect(a.ends).toHaveLength(2);
        const [e06, e24] = a.ends;
        expect(e06.id).toBe('06');
        expect(e06.hdgTrue).toBe(59);
        expect(e24.hdgTrue).toBe(239);
        // landing threshold is the displaced one, not the physical end
        const thr06 = GlideModel.toLocal(34.722904, -80.85459, 34.71874788, -80.86280972);
        expect(e06.thr.x).toBeCloseTo(thr06.x, 9);
        expect(e06.thr.y).toBeCloseTo(thr06.y, 9);
        // length and mid-point from the two physical ends
        expect(e06.rwyLenFt).toBeGreaterThan(5900);
        expect(e06.rwyLenFt).toBeLessThan(6100);
        const mid = GlideModel.toLocal(34.722904, -80.85459, (34.71859708 + 34.72721166) / 2, (-80.8631085 + -80.84607163) / 2);
        expect(e06.mid.x).toBeCloseTo(mid.x, 6);
        expect(e06.mid.y).toBeCloseTo(mid.y, 6);
        expect(e24.rwyLenFt).toBeCloseTo(e06.rwyLenFt, 6);
        // plan B needs the physical ends on every end
        expect(e06.rwy.a).toBeDefined();
        expect(e06.rwy.b).toBeDefined();
        const physBase = GlideModel.toLocal(34.722904, -80.85459, 34.71859708, -80.8631085);
        expect(e06.rwy.a.x).toBeCloseTo(physBase.x, 9);
        // the model accepts these ends (not filtered out) and picks one
        const p = GlideModel.plan({
            airport: a,
            ac: { pos: { x: -4, y: -3 }, altMsl: 4500, gs: 90, trkTrue: 50, vs: -700 },
            glideWind: null, runwayWind: { kind: 'none' }, preferDirect: false,
        }, settings());
        expect(p.kind).toBe('final');
        expect(['06', '24']).toContain(p.endId);
        expect(Number.isFinite(p.spare)).toBe(true);
    });

    it('partial and missing runway coordinates', () => {
        // one-ended runway (the FAA gave coordinates for the base end only, with its heading)
        const one = rwy({
            recip_lat: null, recip_lon: null, recip_thr_lat: null, recip_thr_lon: null, recip_true_hdg: 239,
        });
        let a = GlideInputs.airport(apt([one]), settings());
        expect(a.ends.map((e) => e.id)).toEqual(['06']);
        const e = a.ends[0];
        // length from the record, mid-point half of it along the landing heading from the physical end
        expect(e.rwyLenFt).toBe(6004);
        const physBase = GlideModel.toLocal(34.722904, -80.85459, 34.71859708, -80.8631085);
        const midDist = Math.hypot(e.mid.x - physBase.x, e.mid.y - physBase.y) * 6076.12;
        expect(midDist).toBeCloseTo(3002, 0);
        expect(Number.isFinite(e.rwy.b.x) && Number.isFinite(e.rwy.b.y)).toBe(true);

        // an end with only its physical coordinates uses them for the threshold
        const noThr = rwy({ base_thr_lat: undefined, base_thr_lon: undefined });
        delete noThr.base_thr_lat; delete noThr.base_thr_lon;
        a = GlideInputs.airport(apt([noThr]), settings());
        const phys = GlideModel.toLocal(34.722904, -80.85459, 34.71859708, -80.8631085);
        expect(a.ends[0].thr.x).toBeCloseTo(phys.x, 9);
        expect(a.ends).toHaveLength(2);

        // one end known, no heading anywhere: no way to orient it -> no end (never a made-up heading)
        const noHdg = rwy({
            recip_lat: null, recip_lon: null, recip_thr_lat: null, recip_thr_lon: null,
            base_true_hdg: null, recip_true_hdg: null,
        });
        a = GlideInputs.airport(apt([noHdg]), settings());
        expect(a.ends).toEqual([]);
        expect(a.noSuitable).toBe(false);

        // both ends known, headings absent (common in the bundle): derived from the two physical ends
        const noHdgBoth = rwy({ base_true_hdg: null, recip_true_hdg: null });
        delete noHdgBoth.base_true_hdg; delete noHdgBoth.recip_true_hdg;
        a = GlideInputs.airport(apt([noHdgBoth]), settings());
        expect(a.ends).toHaveLength(2);
        expect(a.ends[0].hdgTrue).toBeGreaterThan(55);
        expect(a.ends[0].hdgTrue).toBeLessThan(63);
        expect(a.ends[1].hdgTrue).toBeCloseTo((a.ends[0].hdgTrue + 180) % 360, 6);

        // no coordinates at all (keys absent, as the bundle has them) -> ends: []
        const bare = { id: '18/36', length_ft: 3435, width_ft: 60, surface: 'TURF', base_id: '18',
            base_elev_ft: 3433.0, base_displ_ft: 0, recip_id: '36', recip_elev_ft: 3435.0, recip_displ_ft: 0 };
        a = GlideInputs.airport(apt([bare]), settings());
        expect(a.ends).toEqual([]);
        expect(a.noSuitable).toBe(false);
        expect(a.refLatLon).toEqual({ lat: 34.722904, lon: -80.85459 });

        // non-finite coordinates are no coordinates
        const bad = rwy({ base_thr_lat: NaN, base_lat: 'x', recip_thr_lat: Infinity, recip_lat: undefined });
        a = GlideInputs.airport(apt([bad]), settings());
        expect(a.ends).toEqual([]);

        // no runways at all, and no elevation
        a = GlideInputs.airport({ icao: 'XXXX', lat: 40, lon: -100, fac_type: 'AIRPORT' }, settings());
        expect(a.ends).toEqual([]);
        expect(a.noSuitable).toBe(false);
        expect(a.elevFt).toBe(null);
    });

    it('southern / eastern hemisphere airport gets finite local coordinates', () => {
        const a = GlideInputs.airport({
            icao: 'YSSY', lat: -33.9461, lon: 151.1772, elev_ft: 21, fac_type: 'AIRPORT',
            runways: [{ id: '16R/34L', length_ft: 12999, surface: 'CONC',
                base_id: '16R', base_lat: -33.9399, base_lon: 151.1753, base_true_hdg: 168,
                recip_id: '34L', recip_lat: -33.9741, recip_lon: 151.1650, recip_true_hdg: 348 }],
        }, settings());
        expect(a.ends).toHaveLength(2);
        for (const e of a.ends) {
            for (const v of [e.thr.x, e.thr.y, e.mid.x, e.mid.y, e.rwyLenFt, e.hdgTrue]) expect(Number.isFinite(v)).toBe(true);
        }
    });
});

// ---------- aircraft() ----------
describe('GlideInputs.aircraft', () => {
    const REF = { lat: 34.722904, lon: -80.85459 };
    const sit = (over = {}) => ({
        lat: 34.80, lon: -80.95, alt_msl: 4500, alt_baro: 9999, ground_speed: 85, true_course: 123,
        vertical_speed: -700, gps_fix_quality: 1, timestamp: NOW - 1000, ...over,
    });

    it('returns the position relative to the reference with alt_msl, gs, track and vs', () => {
        const a = GlideInputs.aircraft(sit(), settings(), REF, NOW);
        const p = GlideModel.toLocal(REF.lat, REF.lon, 34.80, -80.95);
        expect(a.pos.x).toBeCloseTo(p.x, 9);
        expect(a.pos.y).toBeCloseTo(p.y, 9);
        expect(a).toMatchObject({ altMsl: 4500, gs: 85, trkTrue: 123, vs: -700 });
    });

    it('alt_msl used, alt_baro ignored', () => {
        expect(GlideInputs.aircraft(sit({ alt_msl: 3210, alt_baro: 5000 }), settings(), REF, NOW).altMsl).toBe(3210);
        // no GPS altitude -> no block, never the barometric altitude
        expect(GlideInputs.aircraft(sit({ alt_msl: null, alt_baro: 5000 }), settings(), REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ alt_msl: undefined }), settings(), REF, NOW)).toBe(null);
    });

    it('aircraft null without 3D fix, stale, or below showAboveGsKt', () => {
        const s = settings();
        expect(GlideInputs.aircraft(null, s, REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ gps_fix_quality: 0 }), s, REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ gps_fix_quality: 6 }), s, REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ gps_3d: false }), s, REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ lat: 0, lon: 0 }), s, REF, NOW)).toBe(null);
        // stale: older than 5000 ms (5000 exactly is still fresh)
        expect(GlideInputs.aircraft(sit({ timestamp: NOW - 5000 }), s, REF, NOW)).not.toBe(null);
        expect(GlideInputs.aircraft(sit({ timestamp: NOW - 5001 }), s, REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ timestamp: undefined }), s, REF, NOW)).toBe(null);
        // on the ground / taxiing: below showAboveGsKt (40), the threshold itself shows
        expect(GlideInputs.aircraft(sit({ ground_speed: 39.9 }), s, REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ ground_speed: 40 }), s, REF, NOW)).not.toBe(null);
        expect(GlideInputs.aircraft(sit({ ground_speed: 70 }), settings({ pilot: { showAboveGsKt: 75 } }), REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit({ ground_speed: undefined }), s, REF, NOW)).toBe(null);
        // missing track or reference
        expect(GlideInputs.aircraft(sit({ true_course: null }), s, REF, NOW)).toBe(null);
        expect(GlideInputs.aircraft(sit(), s, null, NOW)).toBe(null);
    });

    it('unknown vertical speed is null, not 0', () => {
        expect(GlideInputs.aircraft(sit({ vertical_speed: undefined }), settings(), REF, NOW).vs).toBe(null);
    });
});

// ---------- glideWind() ----------
describe('GlideInputs.glideWind', () => {
    const LAT = 34.72, LON = -80.85;
    const wind = (over = {}) => ({ dir: 250, spd: 14, temp: 5, station: 'CLT', alt: 6000, lat: 35.21, lon: -80.94,
        received_at: NOW - 10 * 60000, ...over });
    const setup = ({ fisb, planners } = {}) => {
        globalThis.window.app = {
            fisbClient: fisb ? { getNearestWind: () => fisb } : null,
            routePlannerPanel: planners?.panel || null,
            routePlannerPreview: planners?.preview || null,
        };
    };
    const NO_WINDS = (kt) => `NO CURRENT WINDS ALOFT · ${kt} kt headwind assumed`;
    beforeEach(() => {
        globalThis.window.FlyTabPlanning = undefined;
        globalThis.WeatherClient = undefined;
        globalThis.window.app = undefined;
    });

    it('uses the FIS-B wind when its station is near and recent, labelled with the level used', () => {
        setup({ fisb: wind() });
        const w = GlideInputs.glideWind(LAT, LON, 5500, settings(), NOW);
        expect(w.wind).toEqual({ from: 250, kt: 14 });
        expect(w.label).toBe('250/14 at 6,000 ft · FIS-B');
        // below the lowest reported level (3,000): the label names the level used
        setup({ fisb: wind({ alt: 3000, dir: 90, spd: 5 }) });
        const low = GlideInputs.glideWind(LAT, LON, 900, settings(), NOW);
        expect(low.label).toBe('090/05 at 3,000 ft · FIS-B');
    });

    it('FIS-B wind too far or too old → null with the NO CURRENT WINDS label', () => {
        // station 100+ nm away (Dallas)
        setup({ fisb: wind({ lat: 32.85, lon: -96.85 }) });
        expect(GlideInputs.glideWind(LAT, LON, 5500, settings(), NOW)).toEqual({ wind: null, label: NO_WINDS(10) });
        // older than windMaxAgeMin (360 min)
        setup({ fisb: wind({ received_at: NOW - 361 * 60000 }) });
        expect(GlideInputs.glideWind(LAT, LON, 5500, settings(), NOW)).toEqual({ wind: null, label: NO_WINDS(10) });
        // exactly at the limits is still good
        setup({ fisb: wind({ received_at: NOW - 360 * 60000 }) });
        expect(GlideInputs.glideWind(LAT, LON, 5500, settings(), NOW).wind).not.toBe(null);
        // the label quotes the configured assumed headwind
        setup({ fisb: wind({ received_at: NOW - 361 * 60000 }) });
        expect(GlideInputs.glideWind(LAT, LON, 5500, settings({ pilot: { noWindHeadwindKt: 15 } }), NOW).label).toBe(NO_WINDS(15));
        // no client, no wind, wind without a position
        setup({});
        expect(GlideInputs.glideWind(LAT, LON, 5500, settings(), NOW).wind).toBe(null);
        setup({ fisb: wind({ lat: null, lon: null }) });
        expect(GlideInputs.glideWind(LAT, LON, 5500, settings(), NOW).wind).toBe(null);
        setup({ fisb: wind({ dir: NaN }) });
        expect(GlideInputs.glideWind(LAT, LON, 5500, settings(), NOW).wind).toBe(null);
    });

    it('falls back to the route planner winds when recent and near; not when old, far, or variable', () => {
        const FD = { CLT: { 3000: { dir: 200, spd: 8 }, 6000: { dir: 240, spd: 16 }, 9000: { dir: 270, spd: 25, variable: false } } };
        globalThis.window.FlyTabPlanning = {
            findNearestFdStation: (winds) => Object.keys(winds)[0],
            getWindAtAlt: (sw, alt) => {
                const keys = Object.keys(sw).map(Number);
                let best = keys[0];
                for (const k of keys) if (Math.abs(k - alt) < Math.abs(best - alt)) best = k;
                return sw[best] ?? null;
            },
        };
        globalThis.WeatherClient = { FD_STATIONS: { CLT: [35.21, -80.94], DFW: [32.9, -97.04] } };
        const planner = (winds, at) => ({ _lastWinds: winds, _lastWindsAt: at });

        // FIS-B has nothing: the planner winds, at the level nearest to the altitude
        setup({ planners: { panel: planner(FD, NOW - 30 * 60000) } });
        let w = GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW);
        expect(w.wind).toEqual({ from: 240, kt: 16 });
        expect(w.label).toBe('240/16 at 6,000 ft · pre-flight winds');

        // a FIS-B wind that is usable wins over the planner
        setup({ fisb: wind(), planners: { panel: planner(FD, NOW) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toEqual({ from: 250, kt: 14 });

        // an unusable FIS-B wind falls through to the planner
        setup({ fisb: wind({ received_at: NOW - 400 * 60000 }), planners: { preview: planner(FD, NOW - 60000) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toEqual({ from: 240, kt: 16 });

        // planner winds older than windMaxAgeMin, never stamped, or null
        setup({ planners: { panel: planner(FD, NOW - 361 * 60000) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW)).toEqual({ wind: null, label: NO_WINDS(10) });
        setup({ planners: { panel: planner(FD, null) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toBe(null);
        setup({ planners: { panel: planner(null, NOW) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toBe(null);

        // the station is too far
        setup({ planners: { panel: planner({ DFW: { 6000: { dir: 180, spd: 10 } } }, NOW) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toBe(null);

        // a variable entry is no wind
        setup({ planners: { panel: planner({ CLT: { 6000: { dir: 0, spd: 0, variable: true } } }, NOW) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toBe(null);

        // the fresher of the two planners is used
        setup({ planners: { panel: planner({ CLT: { 6000: { dir: 100, spd: 1 } } }, NOW - 200 * 60000), preview: planner(FD, NOW - 10 * 60000) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toEqual({ from: 240, kt: 16 });

        // planning library not loaded yet
        globalThis.window.FlyTabPlanning = undefined;
        setup({ planners: { panel: planner(FD, NOW) } });
        expect(GlideInputs.glideWind(LAT, LON, 6200, settings(), NOW).wind).toBe(null);
    });
});

describe('GlideInputs.glideWind planner forecast validity window', () => {
    const LAT = 34.72, LON = -80.85;
    const FD = { CLT: { 6000: { dir: 240, spd: 16 } } };
    beforeEach(() => {
        globalThis.window.FlyTabPlanning = {
            findNearestFdStation: (w) => Object.keys(w)[0],
            getWindAtAlt: (sw) => sw[Object.keys(sw)[0]],
        };
        globalThis.WeatherClient = { FD_STATIONS: { CLT: [35.21, -80.94] } };
    });
    const withInfo = (info, at = NOW - 5 * 60000) => {
        globalThis.window.app = { routePlannerPreview: { _lastWinds: FD, _lastWindsAt: at, _windsInfo: info } };
    };
    it('inside useFrom <= now < useTo the winds are used; past useTo they are not, even if just loaded', () => {
        withInfo({ useFrom: new Date(NOW - 3600000), useTo: new Date(NOW + 3600000) });
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW).wind).toEqual({ from: 240, kt: 16 });
        // useTo is exclusive
        withInfo({ useFrom: new Date(NOW - 3600000), useTo: new Date(NOW) });
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW))
            .toEqual({ wind: null, label: 'NO CURRENT WINDS ALOFT · 10 kt headwind assumed' });
        withInfo({ useFrom: new Date(NOW - 7200000), useTo: new Date(NOW - 1) });
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW).wind).toBe(null);
        // before the window starts
        withInfo({ useFrom: new Date(NOW + 60000), useTo: new Date(NOW + 7200000) });
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW).wind).toBe(null);
    });
    it('a planner without a FOR USE window (legacy, or FIS-B sourced) keeps the age check only', () => {
        withInfo(undefined);
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW).wind).not.toBe(null);
        withInfo({ source: 'fisb' });
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW).wind).not.toBe(null);
        withInfo({ useFrom: 'x', useTo: 'y' });
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW).wind).not.toBe(null);
    });
    it('an expired planner does not hide a valid one', () => {
        globalThis.window.app = {
            routePlannerPanel: { _lastWinds: { CLT: { 6000: { dir: 100, spd: 1 } } }, _lastWindsAt: NOW - 1000 * 60,
                _windsInfo: { useFrom: new Date(NOW - 9e6), useTo: new Date(NOW - 1e6) } },
            routePlannerPreview: { _lastWinds: FD, _lastWindsAt: NOW - 120000, _windsInfo: undefined },
        };
        expect(GlideInputs.glideWind(LAT, LON, 6000, settings(), NOW).wind).toEqual({ from: 240, kt: 16 });
    });
});

// ---------- runwayWind() ----------
describe('GlideInputs.runwayWind', () => {
    const REF = { lat: 34.722904, lon: -80.85459 };
    const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
    const decoded = (minAgo, over = {}) => ({ observed_at: iso(minAgo), wind_dir: 240, wind_speed: 12, wind_gust: null, wind_variable: false, ...over });
    const entry = (minAgo, over) => ({ raw: 'x', decoded: decoded(minAgo, over), received_at: NOW - 60000, is_speci: false });

    const setup = ({ own = {}, others = {}, cache = null, coords = {} } = {}) => {
        const metars = new Map(Object.entries(others));
        for (const [k, v] of Object.entries(own)) metars.set(k, v);
        globalThis.window.app = {
            fisbClient: { metars, getMetar: (i) => metars.get(String(i).toUpperCase()) || null },
            _nasrDb: {
                getWeather: async (i) => (cache && cache[i]) || null,
                getAirport: async (i) => (coords[i] ? { icao: i, lat: coords[i][0], lon: coords[i][1] } : null),
            },
        };
    };
    beforeEach(() => { globalThis.window.app = undefined; GlideInputs._resetCaches(); });
    // the METAR-age test fakes the clock and sets a global: always restore, even when it fails
    afterEach(() => { vi.useRealTimers(); globalThis.FisbClient = undefined; });

    it('the airport METAR from FIS-B, with gusts', async () => {
        setup({ own: { KLKR: entry(18, { wind_dir: 240, wind_speed: 12, wind_gust: 18 }) } });
        const r = await GlideInputs.runwayWind('KLKR', REF, settings(), NOW);
        expect(r.wind).toEqual({ kind: 'metar', from: 240, kt: 12, gustKt: 18 });
        expect(r.label).toBe('METAR KLKR 240/12G18 (18 min)');
        const r2 = await GlideInputs.runwayWind('klkr', REF, settings(), NOW);
        expect(r2.wind.kind).toBe('metar');
    });

    it('calm, VRB and gusts map to their RunwayWind kinds', async () => {
        const kind = async (over) => {
            setup({ own: { KLKR: entry(10, over) } });
            return (await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind;
        };
        expect(await kind({ wind_dir: 0, wind_speed: 0 })).toEqual({ kind: 'calm' });
        expect(await kind({ wind_dir: null, wind_speed: 0 })).toEqual({ kind: 'calm' });
        expect(await kind({ wind_dir: null, wind_speed: 5, wind_variable: true })).toEqual({ kind: 'vrb' });
        expect(await kind({ wind_dir: undefined, wind_speed: 4 })).toEqual({ kind: 'vrb' });
        expect(await kind({ wind_dir: 300, wind_speed: 8, wind_gust: 15 })).toEqual({ kind: 'metar', from: 300, kt: 8, gustKt: 15 });
        expect(await kind({ wind_dir: 300, wind_speed: 8, wind_gust: undefined })).toEqual({ kind: 'metar', from: 300, kt: 8, gustKt: null });
        // unparseable -> none, never a malformed value
        expect(await kind({ wind_dir: 300, wind_speed: undefined })).toEqual({ kind: 'none' });
        expect(await kind({ wind_dir: 300, wind_speed: NaN })).toEqual({ kind: 'none' });
        expect(await kind({ wind_dir: 300, wind_speed: -3 })).toEqual({ kind: 'none' });
        expect(await kind({ wind_dir: 999, wind_speed: 8 })).toEqual({ kind: 'none' });
        expect(await kind({ wind_dir: NaN, wind_speed: 8 })).toEqual({ kind: 'none' });
        // a gust that is not a number is dropped
        expect((await kind({ wind_dir: 300, wind_speed: 8, wind_gust: NaN })).gustKt).toBe(null);
        // labels
        setup({ own: { KLKR: entry(5, { wind_dir: 0, wind_speed: 0 }) } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('METAR KLKR calm (5 min)');
        setup({ own: { KLKR: entry(5, { wind_dir: null, wind_speed: 5, wind_variable: true }) } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('METAR KLKR VRB/05 (5 min)');
    });

    it('METAR too old falls to nearest station, then to none', async () => {
        const near = entry(20, { wind_dir: 180, wind_speed: 9 });
        const farStn = entry(20, { wind_dir: 90, wind_speed: 30 });
        const coords = { KAAA: [34.80, -80.80], KBBB: [35.50, -81.00] };   // ~5 nm and ~45 nm from KLKR
        // own METAR 76 min old (limit 75) -> nearest station within 10 nm
        setup({ own: { KLKR: entry(76) }, others: { KAAA: near, KBBB: farStn }, coords });
        let r = await GlideInputs.runwayWind('KLKR', REF, settings(), NOW);
        expect(r.wind).toEqual({ kind: 'metar', from: 180, kt: 9, gustKt: null });
        expect(r.label).toBe('METAR KAAA 180/09 (20 min)');

        // exactly 75 min is still good
        setup({ own: { KLKR: entry(75) }, others: { KAAA: near }, coords });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind.from).toBe(240);

        // no own METAR; stale neighbours and far neighbours do not count
        setup({ others: { KAAA: entry(90, { wind_dir: 180, wind_speed: 9 }), KBBB: farStn }, coords });
        r = await GlideInputs.runwayWind('KLKR', REF, settings(), NOW);
        expect(r).toMatchObject({ wind: { kind: 'none' } });
        expect(r.label).toBe('');

        // the nearer of two usable stations wins; a station with no known position is skipped
        setup({ others: { KAAA: near, KCCC: entry(5, { wind_dir: 10, wind_speed: 3 }), KBBB: farStn },
            coords: { ...coords, KCCC: [34.76, -80.86] } });
        r = await GlideInputs.runwayWind('KLKR', REF, settings(), NOW);
        expect(r.wind.from).toBe(10);
        setup({ others: { KZZZ: near }, coords });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });

        // metarMaxStationNm is a setting
        setup({ others: { KBBB: farStn }, coords });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings({ pilot: { metarMaxStationNm: 60 } }), NOW)).wind.kind).toBe('metar');

        // a METAR without an observation time or a wind group cannot be judged -> not used
        setup({ own: { KLKR: { raw: 'x', decoded: { wind_dir: 240, wind_speed: 12 }, received_at: NOW } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        setup({ own: { KLKR: { raw: 'x', decoded: { observed_at: iso(5) }, received_at: NOW } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
    });

    it('else the airport panel cached METAR (weather cache) when FIS-B has none or an old one', async () => {
        const cache = { KLKR: { metar: { raw: 'x', decoded: decoded(30, { wind_dir: 120, wind_speed: 7 }), fetched_at: iso(30) } } };
        setup({ cache });
        let r = await GlideInputs.runwayWind('KLKR', REF, settings(), NOW);
        expect(r.wind).toEqual({ kind: 'metar', from: 120, kt: 7, gustKt: null });
        expect(r.label).toBe('METAR KLKR 120/07 (30 min)');
        // FIS-B METAR is older than the limit but the cache is fresh
        setup({ own: { KLKR: entry(100) }, cache });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind.from).toBe(120);
        // FIS-B is fresh: it is first
        setup({ own: { KLKR: entry(10) }, cache });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind.from).toBe(240);
        // an old cached METAR is no better
        setup({ cache: { KLKR: { metar: { decoded: decoded(200) } } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
    });

    it('AWC-decoded METAR (WeatherClient shape): wind_dir "VRB" with wind_variable is variable, not unparseable', async () => {
        // WeatherClient.decodeMetar: wind_dir from AWC wdir ('VRB' string), wind_variable from the raw text
        const awc = (over) => ({ station: 'KLKR', observed_at: iso(10), wind_variable: true, wind_dir: 'VRB', wind_speed: 5, wind_gust: null, ...over });
        const kind = async (d) => {
            setup({ own: { KLKR: { raw: 'x', decoded: d, received_at: NOW } } });
            return GlideInputs.runwayWind('KLKR', REF, settings(), NOW);
        };
        const r = await kind(awc());
        expect(r.wind).toEqual({ kind: 'vrb' });
        expect(r.label).toBe('METAR KLKR VRB/05 (10 min)');
        expect((await kind(awc({ wind_dir: 'vrb', wind_variable: false }))).wind).toEqual({ kind: 'vrb' });
        expect((await kind(awc({ wind_dir: 0, wind_variable: true }))).wind).toEqual({ kind: 'vrb' });
        expect((await kind(awc({ wind_dir: 'VRB', wind_speed: 0 }))).wind).toEqual({ kind: 'calm' });
        expect((await kind(awc({ wind_dir: 'abc', wind_variable: false }))).wind).toEqual({ kind: 'none' });
        // and from the weather cache
        setup({ cache: { KLKR: { metar: { decoded: awc(), fetched_at: iso(10) } } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'vrb' });
    });

    it('label formats: DDD/SS with padding, gust, calm, VRB/SS, none is empty', async () => {
        setup({ own: { KLKR: entry(3, { wind_dir: 60, wind_speed: 5 }) } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('METAR KLKR 060/05 (3 min)');
        setup({ own: { KLKR: entry(18, { wind_dir: 240, wind_speed: 12, wind_gust: 18 }) } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('METAR KLKR 240/12G18 (18 min)');
        setup({});
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('');
    });

    it('cached METAR age: the older of decoded.observed_at and the raw report time (err high)', async () => {
        // AWC reportTime is the top of the hour; the raw report says it was observed at 17:35Z (25 min before NOW=18:00Z)
        // FisbClient.decodeMetar resolves the day of month against the real clock: pin it to NOW
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        globalThis.FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();
        const hourTop = '2026-10-31T18:00:00.000Z';                    // understates the age: 0 min
        const raw = 'KLKR 311735Z 24012KT 10SM CLR 15/05 A3002';
        const wx = (over) => ({ KLKR: { metar: { raw, decoded: { observed_at: hourTop, wind_dir: 240, wind_speed: 12, wind_gust: null, ...over }, fetched_at: hourTop } } });
        setup({ cache: wx({}) });
        const r = await GlideInputs.runwayWind('KLKR', REF, settings(), NOW);
        expect(r.label).toBe('METAR KLKR 240/12 (25 min)');          // the raw time wins (older)
        // too old by the raw time even though decoded.observed_at looks fresh
        const old = 'KLKR 311630Z 24012KT 10SM CLR 15/05 A3002';       // 90 min before NOW
        setup({ cache: { KLKR: { metar: { raw: old, decoded: { observed_at: hourTop, wind_dir: 240, wind_speed: 12 } } } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        // decoded older than the raw time: decoded is used (older of the two)
        setup({ cache: wx({ observed_at: iso(60) }) });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('METAR KLKR 240/12 (60 min)');
        // no raw: decoded alone
        setup({ cache: { KLKR: { metar: { decoded: { observed_at: iso(7), wind_dir: 240, wind_speed: 12 } } } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('METAR KLKR 240/12 (7 min)');
    });

    it('an observation time more than 5 min in the future is unusable (unknown age), from either source', async () => {
        const future = (min) => new Date(NOW + min * 60000).toISOString();
        // decoded.observed_at = now + 2 h, no raw: not used
        setup({ cache: { KLKR: { metar: { decoded: { observed_at: future(120), wind_dir: 240, wind_speed: 12 } } } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        setup({ own: { KLKR: entry(-120) } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        // a FIS-B METAR with a future time does not stop the next source
        setup({ own: { KLKR: entry(-120) },
            cache: { KLKR: { metar: { decoded: { observed_at: iso(10), wind_dir: 120, wind_speed: 7 } } } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind.from).toBe(120);
        // within the tolerance it is taken as just observed
        setup({ own: { KLKR: entry(-4) } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).label).toBe('METAR KLKR 240/12 (0 min)');
        setup({ own: { KLKR: entry(-6) } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        // a raw report time ahead of now: FisbClient.decodeMetar rolls it back a month, so it reads as very old - not used
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        globalThis.FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();
        setup({ cache: { KLKR: { metar: { raw: 'KLKR 311935Z 24012KT 10SM CLR 15/05 A3002',
            decoded: { observed_at: iso(20), wind_dir: 240, wind_speed: 12 } } } } });
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
    });

    it('a station position miss is not cached (a later lookup can succeed)', async () => {
        let known = false;
        setup({ others: { KAAA: entry(20, { wind_dir: 180, wind_speed: 9 }) } });
        globalThis.window.app._nasrDb.getAirport = async () => (known ? { icao: 'KAAA', lat: 34.80, lon: -80.80 } : null);
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        known = true;
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind.kind).toBe('metar');
    });

    it('no client, no icao, a failing lookup → none, never throws', async () => {
        globalThis.window.app = undefined;
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        setup({});
        expect((await GlideInputs.runwayWind('', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
        expect((await GlideInputs.runwayWind(null, null, settings(), NOW)).wind).toEqual({ kind: 'none' });
        globalThis.window.app = {
            fisbClient: { metars: new Map(), getMetar: () => null },
            _nasrDb: { getWeather: async () => { throw new Error('idb'); }, getAirport: async () => { throw new Error('idb'); } },
        };
        expect((await GlideInputs.runwayWind('KLKR', REF, settings(), NOW)).wind).toEqual({ kind: 'none' });
    });
});

// ---------- validate() / settings() ----------
describe('GlideInputs.validate / settings', () => {
    it('non-finite values take the defaults; finite numeric strings are accepted', () => {
        const v = GlideInputs.validate({
            aircraft: { glide_ias_kt: '70', glide_sink_fpm: NaN, glide_density_pct_per_kft: null, min_runway_ft: '2500' },
            pilot: { turnBankDeg: 'abc', marginFt: '', onCourseDeg: 7, windMaxAgeMin: Infinity },
        });
        expect(v.aircraft.glide_ias_kt).toBe(70);
        expect(v.aircraft.glide_sink_fpm).toBe(D.aircraft.glide_sink_fpm);
        expect(v.aircraft.glide_density_pct_per_kft).toBe(D.aircraft.glide_density_pct_per_kft);
        expect(v.aircraft.min_runway_ft).toBe(2500);
        expect(v.pilot.turnBankDeg).toBe(D.pilot.turnBankDeg);
        expect(v.pilot.marginFt).toBe(D.pilot.marginFt);
        expect(v.pilot.onCourseDeg).toBe(7);
        expect(v.pilot.windMaxAgeMin).toBe(D.pilot.windMaxAgeMin);
        // every default key is present
        for (const k of Object.keys(D.pilot)) expect(Number.isFinite(v.pilot[k])).toBe(true);
        expect(GlideInputs.validate(undefined)).toEqual({ aircraft: { ...D.aircraft }, pilot: { ...D.pilot } });
        expect(GlideInputs.validate({ aircraft: { min_runway_ft: null } }).aircraft.min_runway_ft).toBe(null);
    });

    it('settings() reads aircraft performance and the engineOutGlide section, falling back to defaults', () => {
        globalThis.CockpitConfig = {
            aircraft: (p) => ({ 'performance.glide_ias_kt': 68, 'performance.min_runway_ft': 1500 })[p],
            get: (p) => (p === 'engineOutGlide' ? { marginFt: 250, onCourseDeg: 'x' } : undefined),
        };
        const s = GlideInputs.settings();
        expect(s.aircraft).toMatchObject({ glide_ias_kt: 68, glide_sink_fpm: 700, glide_density_pct_per_kft: 2, min_runway_ft: 1500 });
        expect(s.pilot).toMatchObject({ marginFt: 250, onCourseDeg: 5, turnBankDeg: 30 });
        globalThis.CockpitConfig = undefined;
        expect(GlideInputs.settings()).toEqual({ aircraft: { ...D.aircraft }, pilot: { ...D.pilot } });
    });
});
