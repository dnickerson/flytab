/**
 * Engine Page — FUEL STATUS section (SDD Task 12).
 *
 * Covers three contracts:
 *  1. REMAINING / ENDURANCE / RANGE come from the canonical live fuel read
 *     (FuelState.getCurrentFuel) rather than whatever raw EDM field happens to
 *     be populated on the engine poll payload.
 *  2. USED (FLIGHT) reads the Pi fuel tracker's nested field (`data.fuel.flight_fuel_used`),
 *     which is where engine_monitor.get_status() actually puts it — there is no
 *     top-level `flight_fuel_used`.
 *  3. The fuel-bar caution/warning colouring honours the real cockpit-config schema
 *     keys (`enginePage.fuelCautionGal` / `fuelWarningGal`).
 *
 * Fuel-safety rule for this page: it must never present MORE fuel than is known to
 * exist. When the canonical read has no tracked tank state it reports full tank
 * capacity (`source: 'capacity'`) — that is a planning-side default, not a live
 * measurement, so this live-instrument page shows its "no data" placeholders instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));

// Real implementations — the point of these tests is the contract between
// engine-page.js and the canonical fuel modules, so nothing here is faked.
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

const CAPACITY_GAL = 36;   // web/aircraft-config.json performance.fuel_capacity_gal

let page = null;

function setup({ tankL = null, tankR = null, manual = null, measurement = null,
                 enginePageCfg = null } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;

    globalThis.Settings = { fuelManualOverride: manual, fuelMeasurement: measurement };
    globalThis.CockpitConfig = {
        get: (k) => (k === 'enginePage' ? enginePageCfg : null),
        aircraft: (path) => (path === 'performance.fuel_capacity_gal' ? CAPACITY_GAL : undefined),
    };

    if (tankL === null) {
        FuelTankState._loaded = true;      // loaded, but nothing ever initialised
    } else {
        FuelTankState.init(tankL, tankR, 'L');
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();                            // show() is what applies CockpitConfig
    return page;
}

/** Drive one engine-data sample through and read back the FUEL STATUS fields. */
function fuelFields(data) {
    page.update(data);
    const t = (id) => page._el.querySelector('#' + id).textContent;
    return {
        remaining: t('ep-fuel-rem'),
        used: t('ep-fuel-used'),
        endurance: t('ep-fuel-end'),
        range: t('ep-fuel-rng'),
        barLabel: t('ep-fuel-bar-label'),
        barClass: page._dom.fuelBar.className,
        ticRowShown: page._dom.ticEdmRow.style.display !== 'none',
        edmTotal: page._dom.edmTotal.textContent,
    };
}

beforeEach(() => {
    // Stop the 1 Hz self-scheduling render loop: the callback is never invoked.
    vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
    page = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
});

describe('EnginePage FUEL STATUS — canonical remaining fuel', () => {
    it('shows tracked tank state, not the EDM totalizer field on the poll payload', () => {
        setup({ tankL: 10, tankR: 8 });
        // Fuel_Remaining is the EDM's own field-12 totalizer; it must not win.
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 0 });
        expect(out.remaining).toBe('18.0');
    });

    it('derives ENDURANCE and RANGE from the canonical remaining figure', () => {
        setup({ tankL: 9, tankR: 9 });
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 9, speed_kts: 135 });
        expect(out.endurance).toBe('2:00');   // 18 gal / 9 gph
        expect(out.range).toBe('270');        // 18 gal * 15 nm/gal
    });

    it('honours a manual fuel override ahead of tank state and EDM', () => {
        setup({ tankL: 10, tankR: 8, manual: 22 });
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 0 });
        expect(out.remaining).toBe('22.0');
    });

    it('never presents full tank capacity as a live reading when nothing is tracked', () => {
        setup({ tankL: null });
        // FuelState.getCurrentFuel() reports { gallons: 36, source: 'capacity' } here.
        // Showing 36.0 on the live gauge would tell the pilot there is more fuel than
        // is actually known — the unacceptable error direction.
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 9, speed_kts: 135 });
        expect(out.remaining).toBe('--.-');
        expect(out.endurance).toBe('-:--');
        expect(out.range).toBe('---');
        expect(out.remaining).not.toBe(String(CAPACITY_GAL.toFixed(1)));
    });
});

describe('EnginePage FUEL STATUS — USED (FLIGHT)', () => {
    it('reads the Pi fuel tracker nested field', () => {
        setup({ tankL: 10, tankR: 8 });
        const out = fuelFields({ fuel: { flight_fuel_used: 4.3 }, fuel_flow: 0 });
        expect(out.used).toBe('4.3');
    });

    it('falls back to the placeholder when the tracker block is absent', () => {
        setup({ tankL: 10, tankR: 8 });
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.used).toBe('--.-');
    });
});

describe('EnginePage FUEL STATUS — configured caution/warning thresholds', () => {
    const cfg = { fuelCautionGal: 15, fuelWarningGal: 7 };

    it('marks the bar low at the configured caution threshold', () => {
        setup({ tankL: 6, tankR: 6, enginePageCfg: cfg });   // 12 gal: below 15, above 7
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar low');
    });

    it('marks the bar critical at the configured warning threshold', () => {
        setup({ tankL: 3, tankR: 3, enginePageCfg: cfg });   // 6 gal: at/below 7
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar critical');
    });

    it('leaves the bar unstyled above the configured caution threshold', () => {
        setup({ tankL: 9, tankR: 9, enginePageCfg: cfg });   // 18 gal: above 15
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar');
    });

    it('uses the built-in defaults when no enginePage config block exists', () => {
        setup({ tankL: 3, tankR: 3 });                        // 6 gal vs default caution 8
        const out = fuelFields({ fuel_flow: 0 });
        expect(out.barClass).toBe('ep-fuel-bar low');
    });
});

describe('EnginePage TIC vs EDM row — still compares against the EDM, not tank state', () => {
    it('shows the EDM totalizer figure in the EDM column', () => {
        // Tank state is 18.0; the EDM reports 30.0. The row exists to expose that
        // disagreement, so it must keep reading the EDM value.
        setup({ tankL: 10, tankR: 8, measurement: { total_gal: 29.0 } });
        const out = fuelFields({ Fuel_Remaining: 30, fuel_flow: 0 });
        expect(out.ticRowShown).toBe(true);
        expect(out.edmTotal).toBe('30.0');
    });

    it('hides the row when the EDM reports no fuel figure', () => {
        setup({ tankL: 10, tankR: 8, measurement: { total_gal: 29.0 } });
        const out = fuelFields({ Fuel_Remaining: 0, fuel_flow: 0 });
        expect(out.ticRowShown).toBe(false);
    });
});
