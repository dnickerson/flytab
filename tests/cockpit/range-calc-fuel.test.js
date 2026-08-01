/**
 * RangeCalc — nav-strip RANGE / FUEL / ENDURANCE and the map range ring (SDD Task 13).
 *
 * Contract under test: the fuel quantity driving this display comes from the canonical
 * live read (`FuelState.getCurrentFuel()`), not from whatever raw field happens to be on
 * the engine poll payload.
 *
 * Why it mattered: the previous chain was
 *     engData.fuel_remaining_gal || engData.fuel_gal || engData.Gallons_Rem || 0
 * and engine_monitor.py emits NONE of those three names. Its EDM parser produces
 * `Fuel_Remaining` (field 12) and its fuel tracker is nested at `fuel.fuel_remaining`.
 * So the chain always resolved to 0 and the nav strip was permanently "—" with no range
 * ring, on every flight.
 *
 * Fuel-safety rule for this display: it must never show MORE range/endurance than is
 * known to exist. `getCurrentFuel()` falls back to FULL TANK CAPACITY when nothing is
 * tracked (`source: 'capacity'`) — a planning default, not a measurement. Rendering that
 * on a live nav strip would paint a full-tank range ring on the map with no fuel data
 * behind it, so the untracked case stays on the existing "—" placeholders.
 *
 * GPH deliberately still comes from live engine data — see the plan's Non-goals section
 * (the live-GPH-override capability is preserved). Only the gallons source changed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// Real implementations — the whole point is the contract between range-calc.js and
// the canonical fuel modules, so none of the fuel path is faked.
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const RangeCalc = new Function(read('web/cockpit/range-calc.js') + '\nreturn RangeCalc;')();

const CAPACITY_GAL = 36;   // web/aircraft-config.json performance.fuel_capacity_gal

let calc = null;
let ringCalls = [];
let mapLayers = [];

/**
 * @param tankL/tankR  tracked tank state; tankL === null means nothing ever tracked
 * @param manual       Settings.fuelManualOverride
 * @param staleMinutes ages the tracked state past FuelTankState.STALE_MS
 * @param showRing     arm the range-ring toggle (the RNG map control)
 */
function setup({ tankL = null, tankR = null, manual = null, capacityGal = CAPACITY_GAL,
                 staleMinutes = 0, showRing = false, situation = null } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    ringCalls = [];
    mapLayers = [];

    globalThis.Settings = { fuelManualOverride: manual };
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (path) => (path === 'performance.fuel_capacity_gal' ? capacityGal : undefined),
    };
    globalThis.CockpitMap = {
        // Flat-earth-enough stand-in; only used by the route-fuel path.
        _distNm: (a, b, c, d) => Math.hypot(c - a, d - b) * 60,
    };
    globalThis.L = {
        circle: (latlng, opts) => {
            ringCalls.push({ latlng, opts });
            const layer = { latlng, opts };
            return { addTo: (m) => { m._layers.push(layer); return layer; } };
        },
    };

    if (tankL === null) {
        FuelTankState._loaded = true;      // loaded, but nothing ever initialised
    } else {
        FuelTankState.init(tankL, tankR, 'L');
        if (staleMinutes > 0) {
            FuelTankState._state.last_sample_at =
                new Date(Date.now() - staleMinutes * 60000).toISOString();
            FuelTankState._save();
        }
    }

    document.body.innerHTML = `
        <span id="ns-range">—</span>
        <span id="ns-fuel-rem">—</span>
        <span id="ns-fuel-endur"></span>`;

    const map = { _layers: mapLayers, removeLayer: (l) => {
        const i = mapLayers.indexOf(l); if (i >= 0) mapLayers.splice(i, 1);
    } };
    const enginePanel = { lastData: null };
    const stratux = { situation };
    calc = new RangeCalc(stratux, enginePanel, { map });
    calc._showRangeRing = showRing;
    return { enginePanel, stratux };
}

/** Drive one 2s update cycle and read back what the pilot sees. */
function navStrip(engData, situation) {
    calc.enginePanel.lastData = engData;
    if (situation !== undefined) calc.stratux.situation = situation;
    calc._update();
    const t = (id) => document.getElementById(id).textContent;
    return {
        range: t('ns-range'),
        fuel: t('ns-fuel-rem'),
        endurance: t('ns-fuel-endur'),
        fuelClass: document.getElementById('ns-fuel-rem').className,
        ringDrawn: mapLayers.length > 0,
        ringRadiusNm: ringCalls.length ? ringCalls[ringCalls.length - 1].opts.radius / 1852 : null,
    };
}

// The real engine_monitor payload shape: EDM field 12 is `Fuel_Remaining`, the Pi fuel
// tracker is nested under `fuel`, burn rate is `Fuel_Flow`. None of the three names the
// old fallback chain looked for exist anywhere in it.
const REAL_ENGINE_PAYLOAD = {
    Fuel_Remaining: 30, Fuel_Left: 15, Fuel_Right: 15,
    Fuel_Flow: 9, RPM: 2400, MP: 23,
    fuel: { fuel_remaining: 30, flight_fuel_used: 4.3 },
};
const SIT = { lat: 39.0, lon: -77.0, ground_speed: 135 };

afterEach(() => {
    if (calc) calc.destroy();
    calc = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete globalThis.CockpitMap;
    delete globalThis.L;
});

describe('RangeCalc — canonical fuel source', () => {
    it('shows tracked tank state, not the EDM totalizer on the poll payload', () => {
        setup({ tankL: 10, tankR: 8 });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.fuel).toBe('18.0');            // tracked 10 + 8
        expect(out.fuel).not.toBe('30.0');        // NOT the EDM's Fuel_Remaining
    });

    it('renders real values from the real engine payload shape instead of a permanent dash', () => {
        // Regression for the always-blank display: with the old chain every field of
        // REAL_ENGINE_PAYLOAD missed, fuelRemaining was 0 and all three fields were "—".
        setup({ tankL: 9, tankR: 9 });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.fuel).not.toBe('—');
        expect(out.range).not.toBe('—');
        expect(out.endurance).not.toBe('');
    });

    it('derives ENDURANCE and RANGE from the canonical figure and the live burn rate', () => {
        setup({ tankL: 9, tankR: 9 });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.endurance).toBe('2:00');       // 18 gal / 9 gph
        expect(out.range).toBe('270');            // 2.0 h * 135 kt
    });

    it('honours a manual fuel override ahead of tank state', () => {
        setup({ tankL: 10, tankR: 8, manual: 12 });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.fuel).toBe('12.0');
        expect(out.endurance).toBe('1:20');       // 12 gal / 9 gph
    });

    it('keeps GPH sourced from live engine data, not from any fuel module', () => {
        // Same 18 gal tracked, different live burn rate -> different endurance.
        setup({ tankL: 9, tankR: 9 });
        const slow = navStrip({ ...REAL_ENGINE_PAYLOAD, Fuel_Flow: 6 }, SIT);
        expect(slow.endurance).toBe('3:00');      // 18 / 6
        const fast = navStrip({ ...REAL_ENGINE_PAYLOAD, Fuel_Flow: 12 }, SIT);
        expect(fast.endurance).toBe('1:30');      // 18 / 12
    });

    it('blanks the display when the engine reports no burn rate', () => {
        setup({ tankL: 9, tankR: 9 });
        const out = navStrip({ ...REAL_ENGINE_PAYLOAD, Fuel_Flow: 0 }, SIT);
        expect(out.range).toBe('—');
        expect(out.fuel).toBe('—');
        expect(out.endurance).toBe('');
    });
});

describe('RangeCalc — nothing tracked must not become a full-tank range', () => {
    it('shows dashes, not full capacity, when getCurrentFuel falls back to capacity', () => {
        setup({ tankL: null });
        // FuelState.getCurrentFuel() reports { gallons: 36, source: 'capacity' } here.
        expect(FuelState.getCurrentFuel()).toEqual({ gallons: CAPACITY_GAL, source: 'capacity' });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.fuel).toBe('—');
        expect(out.range).toBe('—');
        expect(out.endurance).toBe('');
    });

    it('never paints a range figure derived from untracked capacity', () => {
        setup({ tankL: null });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        // 36 gal / 9 gph * 135 kt = 540 nm of range the aircraft may not have.
        expect(out.range).not.toBe('540');
        expect(out.fuel).not.toBe(CAPACITY_GAL.toFixed(1));
        expect(out.endurance).not.toBe('4:00');
    });

    it('draws no range ring on the map when nothing is tracked', () => {
        setup({ tankL: null, showRing: true });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.ringDrawn).toBe(false);
    });

    it('scales the untracked-capacity guard with a different configured capacity', () => {
        // Proves the guard keys on the `capacity` SOURCE, not on a 36-gallon literal.
        setup({ tankL: null, capacityGal: 50 });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.fuel).toBe('—');
        expect(out.range).not.toBe('750');
    });
});

describe('RangeCalc — range ring', () => {
    // NOTE: `_addRangeRingControl()` is never called from init() or anywhere in app.js,
    // so `_showRangeRing` is permanently false in the shipped app and no ring is drawn.
    // These tests set the flag directly to lock the ring's *sizing* contract to the
    // canonical fuel figure for whenever that control gets wired up.
    it('draws a ring sized by the canonical fuel, not the EDM totalizer', () => {
        setup({ tankL: 9, tankR: 9, showRing: true });
        const out = navStrip(REAL_ENGINE_PAYLOAD, SIT);
        expect(out.ringDrawn).toBe(true);
        expect(out.ringRadiusNm).toBeCloseTo(270, 3);   // 18 gal, not 30
    });

    it('draws no ring while the RNG control is off', () => {
        setup({ tankL: 9, tankR: 9, showRing: false });
        expect(navStrip(REAL_ENGINE_PAYLOAD, SIT).ringDrawn).toBe(false);
    });
});

describe('RangeCalc — fuel colour coding runs off the canonical figure', () => {
    // No plan is set, so this exercises _colorFuelIndicator's total-endurance bands.
    it('greens above 90 minutes of endurance', () => {
        setup({ tankL: 9, tankR: 9 });                       // 18 gal / 9 gph = 120 min
        expect(navStrip(REAL_ENGINE_PAYLOAD, SIT).fuelClass).toBe('nav-strip-value fuel-green');
    });

    it('yellows between 45 and 90 minutes', () => {
        setup({ tankL: 5, tankR: 4 });                       // 9 gal / 9 gph = 60 min
        expect(navStrip(REAL_ENGINE_PAYLOAD, SIT).fuelClass).toBe('nav-strip-value fuel-yellow');
    });

    it('reds below 45 minutes', () => {
        setup({ tankL: 3, tankR: 2 });                       // 5 gal / 9 gph = 33 min
        expect(navStrip(REAL_ENGINE_PAYLOAD, SIT).fuelClass).toBe('nav-strip-value fuel-red');
    });

    it('does not colour an untracked capacity fallback green', () => {
        setup({ tankL: null });
        expect(navStrip(REAL_ENGINE_PAYLOAD, SIT).fuelClass).not.toBe('nav-strip-value fuel-green');
    });
});
