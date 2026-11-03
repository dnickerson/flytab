/**
 * Engine-out glide settings (Task 3): defaults from the config files, range validation in
 * GlideInputs.validate, and the Configuration page showing + saving every glide field.
 *
 * Aircraft values persist via flypi_user_aircraft (performance block), pilot values via
 * flypi_user_cockpit (engineOutGlide section). They must reach the model as NUMBERS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = vi.fn();
globalThis.DiagLog = vi.fn();
const GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
globalThis.GlideModel = GlideModel;
const GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();
const ConfigEditor = new Function(read('web/cockpit/config-editor.js') + '\nreturn ConfigEditor;')();
const CockpitConfig = new Function(read('web/shared/cockpit-config.js') + '\nreturn CockpitConfig;')();
const AIRCRAFT = JSON.parse(read('web/aircraft-config.json'));
const COCKPIT = JSON.parse(read('web/cockpit-config.json'));

const D = GlideModel.DEFAULTS;
const AC_KEYS = ['glide_ias_kt', 'glide_sink_fpm', 'glide_density_pct_per_kft'];
const PILOT_KEYS = Object.keys(D.pilot);
// showAboveGsKt has no Configuration field any more (the airport panel's ENGINE OUT button shows / hides
// the glide block); the key and its 25 kt default stay for EmergencyGlide.
const EDITOR_PILOT_KEYS = PILOT_KEYS.filter((k) => k !== 'showAboveGsKt');

function serveBundles() {
    globalThis.fetch = vi.fn((url) => Promise.resolve({
        ok: true,
        json: async () => JSON.parse(JSON.stringify(String(url).includes('cockpit') ? COCKPIT : AIRCRAFT)),
    }));
}

beforeEach(() => { localStorage.clear(); globalThis.CockpitConfig = CockpitConfig; serveBundles(); });
afterEach(() => { delete globalThis.CockpitConfig; delete globalThis.fetch; });

describe('defaults come from config files', () => {
    it('aircraft-config.json carries 65 / 700 / 2 and no glide_ratio', () => {
        expect(AIRCRAFT.performance.glide_ias_kt).toBe(65);
        expect(AIRCRAFT.performance.glide_sink_fpm).toBe(700);
        expect(AIRCRAFT.performance.glide_density_pct_per_kft).toBe(2);
        expect('glide_ratio' in AIRCRAFT.performance).toBe(false);
    });

    it('cockpit-config.json engineOutGlide holds the pilot defaults, equal to the model defaults', () => {
        expect(COCKPIT.engineOutGlide).toEqual(D.pilot);
        expect(COCKPIT.engineOutGlide).toMatchObject({
            turnBankDeg: 30, marginFt: 200, lineUpFtPerDeg: 1.5, finalPointFraction: 0.25,
            finalPointMinFt: 500, finalPointMaxFt: 1000, noWindHeadwindKt: 10, planBHysteresisFt: 100,
            onCourseDeg: 5, windMaxStationNm: 100, metarMaxAgeMin: 75, metarMaxStationNm: 10,
            windMaxAgeMin: 360, showAboveGsKt: 25,
        });
    });

    it('built-in fallbacks (no config files loaded) give the same values', () => {
        for (const k of AC_KEYS) expect(CockpitConfig.aircraft('performance.' + k)).toBe(D.aircraft[k]);
        expect(CockpitConfig.get('engineOutGlide')).toEqual(D.pilot);
    });

    it('GlideInputs.settings() after load() resolves to the defaults, as numbers', async () => {
        await CockpitConfig.load();
        CockpitConfig._loaded = false;
        const s = GlideInputs.settings();
        for (const k of AC_KEYS) expect(s.aircraft[k]).toBe(D.aircraft[k]);
        expect(s.aircraft.min_runway_ft).toBe(1500);          // existing setting, unchanged
        expect(s.pilot).toEqual(D.pilot);
    });
});

describe('invalid settings fall back on the safe side', () => {
    const v = (over) => GlideInputs.validate({ aircraft: over.aircraft || {}, pilot: over.pilot || {} });

    // Review R27 (2026-10-31, supersedes R26's plain clamp): a finite value outside its range becomes the MORE
    // CONSERVATIVE of the nearest edge and the default. Where a higher value is safer (sink, margin, line-up,
    // assumed headwind) too high -> the max, too low -> the default; where lower is safer (wind and METAR
    // distance/age limits) too low -> the min, too high -> the default; every other key -> the default.
    // R29: glide speed is NOT 'lower is safer' (a slow glide turns in less height): default both ways.
    it('out of range -> the more conservative of the edge and the default', () => {
        const s = (grp, k, val) => v({ [grp]: { [k]: val } })[grp][k];
        expect(s('aircraft', 'glide_sink_fpm', 0)).toBe(700);
        expect(s('aircraft', 'glide_sink_fpm', 3500)).toBe(3000);
        expect(s('pilot', 'marginFt', -50)).toBe(200);
        expect(s('pilot', 'marginFt', 2500)).toBe(2000);
        expect(s('pilot', 'noWindHeadwindKt', 60)).toBe(50);
        expect(s('aircraft', 'glide_ias_kt', 10)).toBe(65);
        expect(s('aircraft', 'glide_ias_kt', 300)).toBe(65);
        expect(s('pilot', 'windMaxStationNm', 600)).toBe(100);
        expect(s('pilot', 'metarMaxAgeMin', 5)).toBe(10);
        expect(s('pilot', 'turnBankDeg', 90)).toBe(30);
        expect(s('pilot', 'showAboveGsKt', 500)).toBe(25);
    });

    it('R29 regression: a glide-speed typo (6 kt) must not make plan B reachable over the runway', () => {
        // 5,000 ft runway 18/36, calm, sink 700, 30 deg bank; aircraft over mid-runway at 500 ft AGL heading away
        // (east). At 30 kt the turn back costs so little height that plan B shows spare (the corner the reviewer
        // found: raising "6" to the 30 kt edge); with the default 65 kt it is out of reach.
        const FT_PER_NM = 6076.12, ELEV = 486, half = 2500 / FT_PER_NM;
        const a = { x: 0, y: -half }, b = { x: 0, y: half }, mid = { x: 0, y: 0 };
        const airport = { elevFt: ELEV, ref: { x: 0, y: 0 }, ends: [
            { id: '36', runwayId: '18/36', thr: a, hdgTrue: 0, rwyLenFt: 5000, mid, rwy: { a, b } },
            { id: '18', runwayId: '18/36', thr: b, hdgTrue: 180, rwyLenFt: 5000, mid, rwy: { a, b } },
        ] };
        const plan = (s) => GlideModel.plan({ airport, ac: { pos: { x: 0, y: 0 }, altMsl: ELEV + 500, gs: 70, trkTrue: 90, vs: 0 },
            glideWind: null, runwayWind: { kind: 'calm' }, preferDirect: false }, s);
        const S = (aircraft) => GlideInputs.validate({ aircraft, pilot: {} });
        expect(S({}).aircraft).toMatchObject({ glide_ias_kt: 65, glide_sink_fpm: 700 });
        expect(S({}).pilot.turnBankDeg).toBe(30);
        const byDefault = plan(S({}));
        expect(byDefault.spare).toBeLessThan(0);                                   // not reachable
        expect(plan(S({ glide_ias_kt: 30 })).spare).toBeGreaterThan(0);           // the corner, at the 30 kt edge
        const typo = plan(S({ glide_ias_kt: 6 }));
        expect(typo.spare).toBe(byDefault.spare);
        expect(typo.kind).toBe(byDefault.kind);
    });

    it('min 1200 > max 1000 -> BOTH defaults (500 / 1000)', () => {
        const s = v({ pilot: { finalPointMinFt: 1200, finalPointMaxFt: 1000 } });
        expect(s.pilot.finalPointMinFt).toBe(500);
        expect(s.pilot.finalPointMaxFt).toBe(1000);
        const t = v({ pilot: { finalPointMinFt: 1200, finalPointMaxFt: 1500 } });   // valid pair kept
        expect(t.pilot.finalPointMinFt).toBe(1200);
        expect(t.pilot.finalPointMaxFt).toBe(1500);
    });

    it('finalPointMaxFt is capped at 5000 (the Configuration input max): 5000 kept, 5001 -> default', () => {
        expect(v({ pilot: { finalPointMaxFt: 5000 } }).pilot.finalPointMaxFt).toBe(5000);
        expect(v({ pilot: { finalPointMaxFt: 5001 } }).pilot.finalPointMaxFt).toBe(1000);
        // min <= max pair rule still applies inside the cap
        const s = v({ pilot: { finalPointMinFt: 600, finalPointMaxFt: 550 } });
        expect([s.pilot.finalPointMinFt, s.pilot.finalPointMaxFt]).toEqual([500, 1000]);
        // ... and after the out-of-range rule: min 6000 -> default 500, max 400 < 500 -> both defaults
        const t = v({ pilot: { finalPointMinFt: 6000, finalPointMaxFt: 400 } });
        expect([t.pilot.finalPointMinFt, t.pilot.finalPointMaxFt]).toEqual([500, 1000]);
    });

    it('every range edge: in-range kept; just outside -> the edge on the safe side, else the default', () => {
        // [lo, hi, group, safer]: 'higher' -> above = hi, below = default; 'lower' -> below = lo, above = default;
        // none -> default both ways
        const ranges = {
            glide_ias_kt: [30, 200, 'aircraft'], glide_sink_fpm: [100, 3000, 'aircraft', 'higher'],
            glide_density_pct_per_kft: [0, 5, 'aircraft'],
            turnBankDeg: [10, 60], marginFt: [0, 2000, 'pilot', 'higher'], lineUpFtPerDeg: [0, 10, 'pilot', 'higher'],
            finalPointFraction: [0, 1], finalPointMinFt: [0, 5000], noWindHeadwindKt: [0, 50, 'pilot', 'higher'],
            planBHysteresisFt: [0, 1000], onCourseDeg: [1, 30], windMaxStationNm: [1, 500, 'pilot', 'lower'],
            windMaxAgeMin: [10, 1440, 'pilot', 'lower'], metarMaxAgeMin: [10, 240, 'pilot', 'lower'],
            metarMaxStationNm: [0, 100, 'pilot', 'lower'], showAboveGsKt: [0, 200],
        };
        for (const [k, [lo, hi, grp = 'pilot', safer]] of Object.entries(ranges)) {
            const def = D[grp][k];
            const below = safer === 'lower' ? lo : def;
            const above = safer === 'higher' ? hi : def;
            // an edge that equals the default proves nothing, so also check a clearly-inside value.
            // glide_sink_fpm's low edge (100 fpm) is flatter than 20:1 with any allowed glide speed
            // (30 kt x 101.269 / 100 = 30:1): the glide-ratio rule then resets speed AND sink to the defaults.
            expect(v({ [grp]: { [k]: lo } })[grp][k], k + ' lo').toBe(k === 'glide_sink_fpm' ? def : lo);
            // finalPointMinFt is paired with finalPointMaxFt (max >= min), so give the max room at the top edge;
            // glide_ias_kt 200 needs a sink that keeps the glide at or under 20:1 (200 x 101.269 / 1100 = 18.4:1)
            const room = k === 'finalPointMinFt' ? { finalPointMaxFt: 5000 }
                : k === 'glide_ias_kt' ? { glide_sink_fpm: 1100 } : {};
            expect(v({ [grp]: { [k]: hi, ...room } })[grp][k], k + ' hi').toBe(hi);
            expect(v({ [grp]: { [k]: lo - 0.5 } })[grp][k], k + ' below').toBe(below);
            expect(v({ [grp]: { [k]: hi + 0.5, ...room } })[grp][k], k + ' above').toBe(above);
            expect(v({ [grp]: { [k]: lo - 1e6 } })[grp][k], k + ' far below').toBe(below);
            expect(v({ [grp]: { [k]: hi + 1e6, ...room } })[grp][k], k + ' far above').toBe(above);
        }
    });

    it('non-finite, null, blank and junk values -> defaults; numeric strings accepted as numbers', () => {
        const s = v({
            aircraft: { glide_ias_kt: NaN, glide_sink_fpm: null, glide_density_pct_per_kft: 'abc' },
            pilot: { turnBankDeg: Infinity, marginFt: '', onCourseDeg: undefined, noWindHeadwindKt: '15' },
        });
        expect(s.aircraft).toMatchObject({ glide_ias_kt: 65, glide_sink_fpm: 700, glide_density_pct_per_kft: 2 });
        expect(s.pilot.turnBankDeg).toBe(30);
        expect(s.pilot.marginFt).toBe(200);
        expect(s.pilot.onCourseDeg).toBe(5);
        expect(s.pilot.noWindHeadwindKt).toBe(15);
        expect(typeof s.pilot.noWindHeadwindKt).toBe('number');
        for (const k of AC_KEYS) expect(typeof s.aircraft[k]).toBe('number');
        for (const k of PILOT_KEYS) expect(typeof s.pilot[k]).toBe('number');
    });

    it('min_runway_ft stays a finite number or null', () => {
        expect(v({ aircraft: { min_runway_ft: 1500 } }).aircraft.min_runway_ft).toBe(1500);
        expect(v({ aircraft: {} }).aircraft.min_runway_ft).toBe(null);
        expect(v({ aircraft: { min_runway_ft: 'x' } }).aircraft.min_runway_ft).toBe(null);
    });
});

describe('Configuration shows every glide field and saves it', () => {
    async function openEditor() {
        await CockpitConfig.load();
        const ed = new ConfigEditor(document.createElement('div'));
        await ed._load();
        return ed;
    }
    const field = (ed, section, key) => ed._el.querySelector(`#ce-${section}-${key}`);

    it('renders the three aircraft fields (with the brief labels) and every pilot key but showAboveGsKt; glide_ratio is gone', async () => {
        const ed = await openEditor();
        const labelOf = (el) => el.closest('.ce-field-row').textContent;
        expect(field(ed, 'aircraft', 'glide_ias_kt').value).toBe('65');
        expect(labelOf(field(ed, 'aircraft', 'glide_ias_kt'))).toContain('Best-Glide Speed (KIAS)');
        expect(field(ed, 'aircraft', 'glide_sink_fpm').value).toBe('700');
        expect(labelOf(field(ed, 'aircraft', 'glide_sink_fpm'))).toContain('Glide Sink Rate (fpm, sea level, windmilling, gross)');
        expect(field(ed, 'aircraft', 'glide_density_pct_per_kft').value).toBe('2');
        expect(labelOf(field(ed, 'aircraft', 'glide_density_pct_per_kft'))).toContain('Glide TAS/Sink Increase (% per 1,000 ft)');
        expect(field(ed, 'aircraft', 'glide_ratio')).toBeNull();
        expect(ed._el.querySelector('.ds-card-title')).not.toBeNull();
        expect([...ed._el.querySelectorAll('.ds-card-title')].map((e) => e.textContent)).toContain('Engine-Out Glide');
        for (const k of EDITOR_PILOT_KEYS) {
            const el = field(ed, 'engineOutGlide', k);
            expect(el, k).not.toBeNull();
            expect(el.value, k).toBe(String(D.pilot[k]));
            expect(el.closest('.ce-field-row').textContent.trim().length, k).toBeGreaterThan(8);
        }
        expect(field(ed, 'engineOutGlide', 'showAboveGsKt')).toBeNull();
        expect(ed._el.textContent).not.toContain('Show Glide Block Above Ground Speed');
    });

    it('a showAboveGsKt saved before the field was removed survives a save (EmergencyGlide still reads it)', async () => {
        localStorage.setItem('flypi_user_cockpit', JSON.stringify({ engineOutGlide: { showAboveGsKt: 40 } }));
        const ed = await openEditor();
        field(ed, 'engineOutGlide', 'turnBankDeg').value = '25';
        await ed._save();
        const ck = JSON.parse(localStorage.getItem('flypi_user_cockpit'));
        expect(ck.engineOutGlide.showAboveGsKt).toBe(40);
        expect(GlideInputs.settings().pilot.showAboveGsKt).toBe(40);
    });

    it('pilot bank 25 and aircraft sink 650 save as NUMBERS to the right keys and reach settings()', async () => {
        const ed = await openEditor();
        field(ed, 'engineOutGlide', 'turnBankDeg').value = '25';
        field(ed, 'aircraft', 'glide_sink_fpm').value = '650';
        await ed._save();

        expect(CockpitConfig.get('engineOutGlide').turnBankDeg).toBe(25);
        const ac = JSON.parse(localStorage.getItem('flypi_user_aircraft'));
        expect(ac.performance.glide_sink_fpm).toBe(650);
        expect(typeof ac.performance.glide_sink_fpm).toBe('number');
        const ck = JSON.parse(localStorage.getItem('flypi_user_cockpit'));
        expect(ck.engineOutGlide.turnBankDeg).toBe(25);
        expect(typeof ck.engineOutGlide.turnBankDeg).toBe('number');
        // only what changed is stored (#112): untouched glide defaults are not frozen into storage
        expect(Object.keys(ck.engineOutGlide)).toEqual(['turnBankDeg']);
        expect(ac.performance.glide_ias_kt).toBeUndefined();

        const s = GlideInputs.settings();
        expect(s.pilot.turnBankDeg).toBe(25);
        expect(s.aircraft.glide_sink_fpm).toBe(650);
    });

    it('whatever is in storage after a save, every stored glide value is a number', async () => {
        const ed = await openEditor();
        for (const k of AC_KEYS) field(ed, 'aircraft', k).value = String(D.aircraft[k] + 1);
        for (const k of EDITOR_PILOT_KEYS) field(ed, 'engineOutGlide', k).value = String(D.pilot[k] + 1);
        await ed._save();
        const ac = JSON.parse(localStorage.getItem('flypi_user_aircraft')).performance;
        const ck = JSON.parse(localStorage.getItem('flypi_user_cockpit')).engineOutGlide;
        for (const k of AC_KEYS) expect(ac[k], k).toBe(D.aircraft[k] + 1);
        for (const k of EDITOR_PILOT_KEYS) expect(ck[k], k).toBe(D.pilot[k] + 1);
    });

    it('a cleared field saves null and settings() falls back to the default', async () => {
        const ed = await openEditor();
        field(ed, 'engineOutGlide', 'marginFt').value = '';
        field(ed, 'aircraft', 'glide_ias_kt').value = '';
        await ed._save();
        const s = GlideInputs.settings();
        expect(s.pilot.marginFt).toBe(200);
        expect(s.aircraft.glide_ias_kt).toBe(65);
    });
});
