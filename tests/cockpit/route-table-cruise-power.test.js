/**
 * route-table.js — cruise-power override burn (_computeEnroute)
 *
 * Regression cover for the 2026-08-01 bug the owner found on the tablet:
 * selecting a cruise power in the route table made fuel look BETTER than
 * selecting nothing. All three override sites derived cruise burn from the
 * theoretical SFC formula `(pct/100) * max_hp * lop_sfc`, which at the
 * aircraft's own configured 65% yields 7.84 gph against a measured 8.1 and a
 * planned 8.4 — under-planned burn, i.e. over-stated fuel remaining.
 *
 * These tests are deliberately wired to the REAL `web/aircraft-config.json`
 * band table and the REAL `gphForPowerPct` from the planning library, not to
 * fixtures, so they fail if either the measured data or the lookup drifts.
 *
 * route-table.js is a classic (non-ESM) script, so it is loaded with the same
 * `new Function(src + 'return Class;')()` pattern the other cockpit tests use.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { gphForPowerPct } from '../../web/shared/planning/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../../web/cockpit/route-table.js'), 'utf8');
const RouteTable = new Function(src + '\nreturn RouteTable;')();

const REAL_PERF = JSON.parse(
    readFileSync(join(__dirname, '../../web/aircraft-config.json'), 'utf8')
).performance;

const START_FUEL = 36;

/** The planner's cruise numbers: 8.4 gph is the p85 of the 65% cruise band. */
const PLANNED_CRZ_GPH = 8.4;
const PLANNED_CRZ_TAS = 153;

/**
 * Install the globals _computeEnroute reads. `perfOverrides` is shallow-merged
 * onto the real performance block so a test can move `cruise_pwr_pct` without
 * forking the whole config.
 *
 * `FlyTabPlanning` gets the genuine `gphForPowerPct` — the point of the fix is
 * that route-table.js reaches the planning library's nearest-band lookup rather
 * than owning a copy of it.
 */
function installGlobals({ perfOverrides = {}, withPlanningLib = true } = {}) {
    const perf = { ...REAL_PERF, ...perfOverrides };
    globalThis.CockpitConfig = {
        aircraft(path) {
            const key = path.replace(/^performance\./, '');
            const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), perf);
            return v === undefined ? null : v;
        },
        get() { return null; },
    };
    globalThis.FlyTabPlanning = {
        bearing: () => 0,
        windCorrectedMagHdg: () => 0,
        crossTrackDistanceNm: () => 0,
        ...(withPlanningLib ? { gphForPowerPct } : {}),
    };
    globalThis.FuelState = {
        getCurrentFuel: () => ({ gallons: START_FUEL, source: 'tank_state', stale: false }),
        getStartFuel:   () => ({ gallons: START_FUEL, source: 'tic' }),
    };
    return perf;
}

afterEach(() => {
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete globalThis.FuelState;
});

function crz(distNm) {
    return {
        phase: 'CRZ', gph: PLANNED_CRZ_GPH, tas: PLANNED_CRZ_TAS, gs: PLANNED_CRZ_TAS,
        dist: distNm, ete_min: (distNm / PLANNED_CRZ_TAS) * 60,
        percent_power: 65, rpm: 2390, mp: 22.1,
    };
}
function clb(distNm) {
    return { phase: 'CLB', gph: 15, tas: 120, gs: 120, dist: distNm,
             ete_min: (distNm / 120) * 60, percent_power: 100, rpm: 2700, mp: 28 };
}
function des(distNm) {
    return { phase: 'DES', gph: 6.9, tas: 170, gs: 170, dist: distNm,
             ete_min: (distNm / 170) * 60, percent_power: 50, rpm: 2400, mp: 18 };
}

/** KLKR -> LOCAS -> GSO -> KFGX -> KLWA, shaped like the route the owner flew. */
function makeRoute() {
    return [
        { icao: 'KLKR',  type: 'APT', lat: 34.72, lon: -80.85 },
        { icao: 'LOCAS', type: 'FIX', lat: 35.20, lon: -80.40, _legDist: 276, _segments: [clb(115), crz(161)] },
        { icao: 'GSO',   type: 'VOR', lat: 36.05, lon: -79.94, _legDist: 322, _segments: [crz(322)] },
        { icao: 'KFGX',  type: 'APT', lat: 36.60, lon: -79.30, _legDist: 276, _segments: [crz(276)] },
        { icao: 'KLWA',  type: 'APT', lat: 37.10, lon: -78.80, _legDist: 253, _segments: [crz(138), des(115)] },
    ];
}

/** Same route with no _segments — exercises the seg-less fallback branch. */
function makeSeglessRoute() {
    return [
        { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.85 },
        { icao: 'GSO',  type: 'VOR', lat: 36.05, lon: -79.94, _legDist: 306 },
        { icao: 'KLWA', type: 'APT', lat: 37.10, lon: -78.80, _legDist: 306 },
    ];
}

function makeTable(waypoints, cruisePower) {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints   = waypoints;
    rt._activeIndex = 0;
    rt._flights     = [];
    rt._destIcao    = 'KLWA';
    rt._cruisePower = cruisePower;
    rt._lastSituation = null;
    rt._emitLegUpdate = () => {};
    return rt;
}

/** Run the route at `cruisePower` and report what actually happened. */
function run(cruisePower, opts = {}) {
    installGlobals(opts);
    const wps = makeRoute();
    makeTable(wps, cruisePower)._computeEnroute(0);
    // gph actually applied to a pure-CRZ segment (leg 2 is 100% cruise).
    const seg = wps[2]._segments[0];
    return {
        wps,
        finalRem:   wps[wps.length - 1]._fuelRem,
        appliedGph: seg._fuel / (seg._ete / 60),
        profile:    wps.map(w => [w._fuelRem, w._fuel, w._ete, w._tas, w._gs]),
    };
}

/** The formula the fix removed, for explicit anti-regression assertions. */
function sfcFormulaGph(pct) {
    return (pct / 100) * REAL_PERF.max_hp * REAL_PERF.lop_sfc;
}

const OTHER_POWERS = [42, 48, 55, 60, 70, 75];

// ── The bug: selecting the configured cruise power must change nothing ──────

describe('_computeEnroute — cruise power override at the CONFIGURED power', () => {
    it('is byte-for-byte identical to selecting nothing', () => {
        expect(REAL_PERF.cruise_pwr_pct).toBe(65);   // premise of the numbers below

        const base = run(null);
        const at65 = run(REAL_PERF.cruise_pwr_pct);

        // The whole table, not just the last cell: burn, ETE, TAS and GS too.
        expect(at65.profile).toEqual(base.profile);
        expect(at65.finalRem).toBe(base.finalRem);
        // Pre-fix this was 7.839 vs 8.400 — selecting 65% bought ~0.5 gal of
        // fuel that does not exist.
        expect(at65.appliedGph).toBeCloseTo(PLANNED_CRZ_GPH, 6);
        expect(at65.appliedGph).not.toBeCloseTo(sfcFormulaGph(65), 2);
    });

    it('follows performance.cruise_pwr_pct rather than a hardcoded 65', () => {
        // Reconfigure the aircraft to cruise at 70%: now 70% is the no-op and 65%
        // becomes an ordinary selection that must take its measured band value.
        const opts = { perfOverrides: { cruise_pwr_pct: 70 } };
        const base = run(null, opts);
        const at70 = run(70, opts);
        const at65 = run(65, opts);

        expect(at70.profile).toEqual(base.profile);
        expect(at70.appliedGph).toBeCloseTo(PLANNED_CRZ_GPH, 6);
        // 65 -> nearest band by pct_mid is the 61-65 band (pct_mid 63) -> 8.1
        expect(at65.appliedGph).toBeCloseTo(8.1, 6);
        expect(at65.profile).not.toEqual(base.profile);
    });
});

// ── Every other power uses MEASURED data, never the SFC formula ─────────────

describe('_computeEnroute — cruise power override at other powers', () => {
    it.each(OTHER_POWERS)('%i%% burns the measured band gph, not the SFC formula', (pct) => {
        const band = gphForPowerPct(REAL_PERF.power_settings, pct);
        expect(band).not.toBeNull();

        const r = run(pct);
        expect(r.appliedGph).toBeCloseTo(band, 6);
        // The removed formula and the band never coincide at these powers, so this
        // is a real discriminator rather than a tautology.
        expect(Math.abs(band - sfcFormulaGph(pct))).toBeGreaterThan(0.05);
        expect(r.appliedGph).not.toBeCloseTo(sfcFormulaGph(pct), 2);
    });

    it('pins the measured band values the planner depends on', () => {
        // These are MEASURED EDM figures. If this fails, aircraft-config.json was
        // edited — power_settings[].gph is data, not a tuning knob.
        const expected = { 42: 5.0, 48: 5.7, 53: 6.5, 55: 6.5, 58: 7.3, 60: 7.3,
                           63: 8.1, 65: 8.1, 68: 8.7, 70: 8.7, 73: 8.9, 75: 8.9 };
        for (const [pct, gph] of Object.entries(expected)) {
            expect(gphForPowerPct(REAL_PERF.power_settings, Number(pct))).toBeCloseTo(gph, 6);
        }
        // cruise_gph is the separate self-generated-row figure and stays at 9.0.
        expect(REAL_PERF.cruise_gph).toBe(9.0);
    });

    /**
     * ERROR DIRECTION. The failure mode that matters is planning LESS burn than
     * the engine really uses, so cruise burn must never fall below the measured
     * figure for the power the pilot selected.
     *
     * Note the floor at the CONFIGURED power is 8.4 (the planned p85), not the
     * 8.1 band median — that is requirement 1, and it is why the configured power
     * is a no-op rather than a band lookup.
     */
    it.each([null, ...OTHER_POWERS, 65])('never plans cruise burn below the measured figure (%s)', (pct) => {
        const r = run(pct);
        const floor = (pct == null || pct === REAL_PERF.cruise_pwr_pct)
            ? PLANNED_CRZ_GPH                                        // planned 8.4
            : gphForPowerPct(REAL_PERF.power_settings, pct);
        expect(r.appliedGph).toBeGreaterThanOrEqual(floor - 1e-9);
    });

    /**
     * The reported bug, stated precisely. The SFC formula was NOT uniformly
     * optimistic — it sat BELOW the measured band only in the 58-72% region,
     * which happens to be where this aircraft actually cruises. Those are the
     * settings that made fuel look better than doing nothing, and they are the
     * ones this fix has to raise.
     */
    it.each([60, 65, 70])('raises planned burn at %i%%, where the old formula under-planned', (pct) => {
        expect(sfcFormulaGph(pct)).toBeLessThan(gphForPowerPct(REAL_PERF.power_settings, pct));
        const applied = run(pct).appliedGph;
        expect(applied).toBeGreaterThan(sfcFormulaGph(pct));
    });

    it('makes cruise burn non-decreasing in selected power', () => {
        const burns = OTHER_POWERS.map(p => run(p).appliedGph);
        for (let i = 1; i < burns.length; i++) {
            expect(burns[i]).toBeGreaterThanOrEqual(burns[i - 1]);
        }
    });
});

// ── Seg-less legs (the third override site) ────────────────────────────────

describe('_computeEnroute — cruise power override on seg-less legs', () => {
    function seglessGph(cruisePower) {
        installGlobals();
        const wps = makeSeglessRoute();
        makeTable(wps, cruisePower)._computeEnroute(0);
        return wps[1]._fuel / (wps[1]._ete / 60);
    }

    it('leaves the config cruise gph alone at the configured power', () => {
        expect(seglessGph(null)).toBeCloseTo(REAL_PERF.cruise_gph, 6);   // 9.0
        expect(seglessGph(65)).toBeCloseTo(REAL_PERF.cruise_gph, 6);     // identical to default
    });

    it.each(OTHER_POWERS)('uses the measured band gph at %i%%', (pct) => {
        const band = gphForPowerPct(REAL_PERF.power_settings, pct);
        expect(seglessGph(pct)).toBeCloseTo(band, 6);
        expect(seglessGph(pct)).not.toBeCloseTo(sfcFormulaGph(pct), 2);
    });
});

// ── Degraded environments must not fall back to a lower number ─────────────

describe('_computeEnroute — cruise power override without band data', () => {
    /**
     * With no measured answer the override must not run AT ALL. Applying only
     * half of it — the TAS rescale, which shortens ETE — while leaving burn at the
     * planned figure shows less fuel used over the same distance. That is the same
     * error direction as the original bug, arriving by a different route.
     */
    it('ignores the override entirely when the planning library has not loaded', () => {
        // window.FlyTabPlanning is populated asynchronously by planning/index.js.
        const base = run(null);
        const r = run(75, { withPlanningLib: false });
        expect(r.appliedGph).toBeCloseTo(PLANNED_CRZ_GPH, 6);
        expect(r.profile).toEqual(base.profile);
        expect(r.finalRem).toBe(base.finalRem);
    });

    it('ignores the override entirely when power_settings is missing', () => {
        const base = run(null);
        const r = run(75, { perfOverrides: { power_settings: [] } });
        expect(r.appliedGph).toBeCloseTo(PLANNED_CRZ_GPH, 6);
        expect(r.profile).toEqual(base.profile);
    });
});
