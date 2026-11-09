/**
 * The fuel overlay compares the tic-mark reading with the tablet's own tracked
 * fuel (FuelTankState left + right), never with the Pi's tracker (data.fuel.*).
 * The Dynon D-180's own fuel computer (data.Fuel_Remaining) is an instrument
 * reading: it appears as a smaller "D-180: <x> gal" line when fresh and is saved
 * as edm_gal; tracked_gal is the tracked total just before the tic is applied.
 * The K-factor's FUEL USED is the tracked burn between consecutive measurements.
 *
 * Drives the real FuelOverlay through its own DOM. fetch is a spy that rejects,
 * so any network call shows up as a recorded call.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.Settings      = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.FuelEngine    = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState     = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
globalThis.EngineClient  = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelOverlay        = new Function(read('web/cockpit/fuel-overlay.js') + '\nreturn FuelOverlay;')();

const AC = JSON.parse(read('web/aircraft-config.json'));

let overlay = null;
let fetchSpy = null;
let realFetch = null;
let realNeeds = null;

const tap = (id) => overlay._el.querySelector('#' + id)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
function drag(el, tic) { el.value = String(tic); el.dispatchEvent(new window.Event('input')); }
function open() { overlay.show(); overlay._shownAt = 0; return overlay._dom; }
const $ = (id) => overlay._el.querySelector('#' + id);
const freshPanel = (lastData) => ({ lastData, lastPollTime: Date.now() });
const history = () => JSON.parse(localStorage.getItem('flypi_fuel_history') || '[]');
const iso = (min) => new Date(Date.UTC(2026, 10, 1, 12, 0) + min * 60000).toISOString();

beforeEach(() => {
    localStorage.clear();
    Settings.fuelMeasurement = null;
    Settings.fuelManualOverride = null;
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    realNeeds = FuelTankState.needsConfirmation;
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => {
            if (p === 'tic_polynomial') return AC.tic_polynomial;
            if (p === 'performance.fuel_capacity_gal') return AC.performance.fuel_capacity_gal;
            return undefined;
        },
    };
    window.engineClient = { ip: '192.168.1.50' };
    delete window.enginePanel;
    realFetch = globalThis.fetch;
    fetchSpy = vi.fn(() => Promise.reject(new Error('offline')));
    globalThis.fetch = fetchSpy;
    globalThis.wireTap = (el, fn) => { if (el) el.addEventListener('click', fn); };
    overlay = new FuelOverlay(document.body);
});

afterEach(() => {
    overlay?._el?.remove();
    overlay = null;
    globalThis.fetch = realFetch;
    FuelTankState.needsConfirmation = realNeeds;
    delete window.engineClient;
    delete window.enginePanel;
});

describe('comparison block: TIC vs TRACKED', () => {
    it('compares TIC with the tablet-tracked figure, not data.fuel.fuel_remaining', () => {
        FuelTankState.init(8, 8, 'L');                                  // 16.0 tracked
        window.enginePanel = freshPanel({ fuel: { fuel_remaining: 30 } }); // Pi tracker: ignored
        const d = open();
        drag(d.leftSlider, 8);                                           // 15.6
        drag(d.rightSlider, 11);                                         // 18.0 → 33.6

        expect(d.edmSection.style.display).toBe('');
        expect($('fo-edm-tic').textContent).toBe('33.6 gal');
        expect($('fo-edm-tracked').textContent).toBe('16.0 gal');
        expect($('fo-edm-var').textContent).toBe('+17.6 gal');
        expect($('fo-edm-grade').textContent).toBe('CHECK');
        expect($('fo-edm-d180').style.display).toBe('none');            // no Fuel_Remaining
        expect(overlay._el.querySelector('#fo-edm-section').textContent).not.toMatch(/EDM/);
    });

    it('is hidden when there is no tank state, even with a fresh D-180 figure', () => {
        window.enginePanel = freshPanel({ Fuel_Remaining: 25 });
        const d = open();
        drag(d.leftSlider, 8);
        expect(d.edmSection.style.display).toBe('none');
    });

    it('a manual override is not the TRACKED figure', () => {
        FuelTankState.init(8, 8, 'L');
        Settings.fuelManualOverride = 30;
        const d = open();
        drag(d.leftSlider, 8);
        expect($('fo-edm-tracked').textContent).toBe('16.0 gal');
    });

    it('marks a stale tracked figure (UNCONFIRMED)', () => {
        FuelTankState.init(8, 8, 'L');
        FuelTankState.needsConfirmation = () => true;
        const d = open();
        drag(d.leftSlider, 8);
        expect($('fo-edm-tracked').textContent).toBe('16.0 gal (UNCONFIRMED)');
    });

    it('shows the D-180 line only when Fuel_Remaining is fresh', () => {
        FuelTankState.init(8, 8, 'L');
        window.enginePanel = freshPanel({ Fuel_Remaining: 12.5, fuel: { fuel_remaining: 30 } });
        const d = open();
        drag(d.leftSlider, 8);
        expect($('fo-edm-d180').style.display).toBe('');
        expect($('fo-edm-d180').textContent).toBe('D-180: 12.5 gal');

        window.enginePanel.lastPollTime = Date.now() - FuelState.EDM_FRESHNESS_MS - 1000;
        drag(d.leftSlider, 7);
        expect($('fo-edm-d180').style.display).toBe('none');
    });
});

describe('measurement record', () => {
    it('saved measurement carries tracked_gal; edm_gal is the D-180 field or null', () => {
        FuelTankState.init(8, 8, 'L');                                  // 16.0 before the tic
        window.enginePanel = freshPanel({ Fuel_Remaining: 12.5, fuel: { fuel_remaining: 30 } });
        const d = open();
        drag(d.leftSlider, 8);
        drag(d.rightSlider, 11);
        tap('fo-apply');

        const h = history();
        expect(h).toHaveLength(1);
        expect(h[0].total_gal).toBe(33.6);
        expect(h[0].tracked_gal).toBe(16);
        expect(h[0].edm_gal).toBe(12.5);
        expect(Settings.fuelMeasurement.tracked_gal).toBe(16);
        expect(Settings.fuelMeasurement.edm_gal).toBe(12.5);
        // The tracker was re-initialised from the tic AFTER tracked_gal was taken.
        const st = FuelTankState.getState();
        expect(st.left_gal + st.right_gal).toBeCloseTo(33.6, 5);
    });

    it('edm_gal is null without a fresh D-180 figure; tracked_gal null without tank state', () => {
        window.enginePanel = freshPanel({ fuel: { fuel_remaining: 30 } });
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        tap('fo-apply');

        const h = history();
        expect(h).toHaveLength(1);
        expect(h[0].tracked_gal).toBeNull();
        expect(h[0].edm_gal).toBeNull();
    });

    it('RECORD FUEL STOP saves tracked_gal and edm_gal on the measurement, no history entry', () => {
        FuelTankState.init(5, 6, 'L');
        window.enginePanel = freshPanel({ Fuel_Remaining: 10.2 });
        const d = open();
        drag(d.leftSlider, 8);
        drag(d.rightSlider, 11);
        d.addGal.value = '22';
        tap('fo-add-record');

        expect(d.addStatus.className).toContain('fo-add-status-ok');
        expect(Settings.fuelMeasurement.tracked_gal).toBe(11);
        expect(Settings.fuelMeasurement.edm_gal).toBe(10.2);
        expect(history()).toHaveLength(0);
    });

    it('APPLY TIC with no fresh engine panel completes at once with zero fetches', () => {
        FuelTankState.init(8, 8, 'L');
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        tap('fo-apply');

        // Synchronous: no await between the tap and these assertions.
        expect(overlay.visible).toBe(false);
        expect(overlay._applying).toBe(false);
        expect(history()).toHaveLength(1);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('K-factor from tracked burn', () => {
    const setData = (hist, stops) => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify(hist));
        localStorage.setItem('flytab_fuel_stops', JSON.stringify(stops));
    };

    it('K-factor ratio from tracked burn between fills', () => {
        setData([
            // Deliberately out of order: sorting by time is part of the contract.
            { measured_at: iso(60),  total_gal: 20.0, tracked_gal: 15.0 },  // 33.6 − 15.0 = 18.6
            { measured_at: iso(0),   total_gal: 33.6, tracked_gal: 30.0 },
            // A fuel stop at +90 re-inits the tracker without a history entry: the
            // pair (+60, +120) mixes pre- and post-fill figures and must not count,
            // even though tic did not rise and the drop (20.0 − 14.0) is positive.
            { measured_at: iso(120), total_gal: 19.0, tracked_gal: 14.0 },
            { measured_at: iso(180), total_gal: 15.0, tracked_gal: 13.0 },  // 19.0 − 13.0 = 6.0
        ], [
            { airport: 'KMYL', gallons: 12.3, saved_at: iso(90) },
            { airport: 'KBOI', gallons: 12.3, saved_at: iso(200) },
        ]);
        open();
        expect($('fo-kf-filled').textContent).toBe('24.6 gal');
        expect($('fo-kf-used').textContent).toBe('24.6 gal');
        expect($('fo-kf-ratio').textContent).toBe('1.000');
    });

    it('old history entries with only edm_gal still render a number', () => {
        setData([
            { measured_at: iso(0),  total_gal: 33.6, edm_gal: 31.0 },
            { measured_at: iso(60), total_gal: 25.0, edm_gal: 22.0 },        // 33.6 − 22.0 = 11.6
            { measured_at: iso(90), total_gal: 24.0 },                        // neither figure
            { measured_at: iso(95), total_gal: 23.5, tracked_gal: 'x' },      // junk
        ], [{ airport: 'KMYL', gallons: 11.6, saved_at: iso(200) }]);
        open();
        expect($('fo-kf-used').textContent).toBe('11.6 gal');
        expect($('fo-kf-ratio').textContent).toBe('1.000');
        expect(overlay._el.querySelector('#fo-kfactor-panel').textContent).not.toMatch(/NaN/);
    });

    it('a tic that rose (refuel) does not count, and guidance speaks of tracked fuel flow', () => {
        setData([
            { measured_at: iso(0),  total_gal: 20.0, tracked_gal: 22.0 },
            { measured_at: iso(60), total_gal: 30.0, tracked_gal: 12.0 },    // tic rose: skipped
        ], [{ airport: 'KMYL', gallons: 10, saved_at: iso(200) }]);
        open();
        expect($('fo-kf-used').textContent).toBe('-- gal');
        expect(overlay._el.querySelector('#fo-kfactor-panel').textContent).not.toMatch(/EDM/);
        expect(overlay._el.querySelector('#fo-kfactor-panel').textContent).toMatch(/TRACKED/);
    });
});

describe('no Pi K-factor panel', () => {
    it('no /api/fuel/calibration request on show()', async () => {
        open();
        await new Promise(r => setTimeout(r, 20));
        expect(fetchSpy.mock.calls.filter(([u]) => /\/api\/fuel\/calibration/.test(String(u))))
            .toHaveLength(0);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect($('fo-kfactor-pi')).toBeNull();
        expect(overlay._el.textContent).not.toMatch(/PI K-FACTOR|APPLY TO PI/);
    });
});

describe('measurement history list', () => {
    it('column is TRACKED; rows show tracked_gal, else edm_gal', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            { measured_at: iso(0),  total_gal: 33.6, edm_gal: 31.0 },
            { measured_at: iso(60), total_gal: 25.0, tracked_gal: 24.0, edm_gal: 22.0 },
        ]));
        open();
        const headers = [...overlay._el.querySelectorAll('.fo-hist-table th')].map(t => t.textContent);
        expect(headers).toContain('TRACKED (gal)');
        expect(headers.join(' ')).not.toMatch(/EDM/);
        const rows = [...overlay._dom.histBody.querySelectorAll('tr')]
            .map(tr => [...tr.querySelectorAll('td')].slice(1, 3).map(td => td.textContent));
        expect(rows).toEqual([['25.0', '24.0'], ['33.6', '31.0']]);   // newest first
    });

    it('edit dialog edits tracked_gal when present, else edm_gal', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            { measured_at: iso(0),  total_gal: 33.6, edm_gal: 31.0 },
            { measured_at: iso(60), total_gal: 25.0, tracked_gal: 24.0, edm_gal: 22.0 },
        ]));
        open();
        const [newest] = overlay._dom.histBody.querySelectorAll('tr');

        newest.querySelector('.fo-hist-edit').dispatchEvent(new window.MouseEvent('click'));
        expect(newest.textContent).toMatch(/TRACKED/);
        expect(newest.querySelector('#fo-hist-tracked-1').value).toBe('24.0');
        newest.querySelector('#fo-hist-tracked-1').value = '23.5';
        newest.querySelector('.fo-hist-save').dispatchEvent(new window.MouseEvent('click'));
        expect(history()[1].tracked_gal).toBe(23.5);
        expect(history()[1].edm_gal).toBe(22.0);

        const oldRow = overlay._dom.histBody.querySelectorAll('tr')[1];
        oldRow.querySelector('.fo-hist-edit').dispatchEvent(new window.MouseEvent('click'));
        expect(oldRow.querySelector('#fo-hist-tracked-0').value).toBe('31.0');
        oldRow.querySelector('#fo-hist-tracked-0').value = '30.5';
        oldRow.querySelector('.fo-hist-save').dispatchEvent(new window.MouseEvent('click'));
        expect(history()[0].edm_gal).toBe(30.5);
        expect(history()[0].tracked_gal).toBeUndefined();
    });
});
