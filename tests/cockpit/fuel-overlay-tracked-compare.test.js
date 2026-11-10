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
    FuelTankState._coveredMs = null;   // in memory only: a real app restart loses it
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

describe('D-180 figure from a frozen frame (M1)', () => {
    it('a fresh-polled but frozen frame (serial_warning / serial_connected false) is not a D-180 figure', () => {
        FuelTankState.init(8, 8, 'L');
        window.enginePanel = freshPanel({ Fuel_Remaining: 12.5, serial_warning: 'No EDM data for 6s' });
        const d = open();
        drag(d.leftSlider, 8);
        expect($('fo-edm-d180').style.display).toBe('none');
        tap('fo-apply');
        expect(history()[0].edm_gal).toBeNull();

        window.enginePanel = freshPanel({ Fuel_Remaining: 12.5, serial_connected: false });
        expect(overlay._resolveD180Fuel()).toBeNull();
        window.enginePanel = freshPanel({ Fuel_Remaining: 12.5, serial_connected: true });
        expect(overlay._resolveD180Fuel()).toBe(12.5);
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

    it('RECORD FUEL STOP saves tracked_gal, edm_gal and a history entry with fuel_stop_gal', () => {
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
        const h = history();
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ total_gal: 33.6, tracked_gal: 11, edm_gal: 10.2, fuel_stop_gal: 22 });
        // PR #214 finding 5: a fuel stop is graded against tracked + pumped (11 + 22 = 33),
        // not the pre-fuel tracked 11. edm_gal is the D-180 figure, not the reference.
        expect(h[0].variance_gal).toBe(0.6);
        expect(h[0].accuracy).toBe('excellent');
        expect(h[0].tracked_gal).toBe(11);
        // The history list marks it as a fuel stop.
        const row = overlay._dom.histBody.querySelector('tr');
        expect(row.classList.contains('fo-hist-row-stop')).toBe(true);
        expect(row.querySelector('.fo-hist-stop').textContent).toBe('FUEL STOP +22.0 gal');
    });

    it('a new record with tracked_gal: null shows -- as TRACKED and is not counted (no edm_gal fallback)', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            { measured_at: iso(0),  total_gal: 30.0, tracked_gal: 28.0, edm_gal: null },
            { measured_at: iso(60), total_gal: 25.0, tracked_gal: null, edm_gal: 12.5 },
        ]));
        open();
        const rows = [...overlay._dom.histBody.querySelectorAll('tr')]
            .map(tr => [...tr.querySelectorAll('td')].slice(1, 3).map(td => td.textContent));
        expect(rows).toEqual([['25.0', '--'], ['30.0', '28.0']]);
        expect($('fo-kf-used').textContent).toBe('-- gal');
        expect($('fo-kf-ratio').textContent).toBe('--');
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

describe('K-factor: actual used (tic + fuel stops) vs tracked used', () => {
    const setData = (hist, stops) => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify(hist));
        localStorage.setItem('flytab_fuel_stops', JSON.stringify(stops));
    };

    afterEach(() => { vi.useRealTimers(); });

    // The real APPLY → fly → RECORD FUEL STOP → fly → APPLY path, and every
    // excluded-leg rule, are in fuel-overlay-kfactor.test.js.
    const chain = (i, extra = {}) => ({ tracked_since: 'init' + i, tank_init_at: 'init' + (i + 1),
        tracked_stale: false, dropped_applied_since_init_gal: 0, ...extra });

    it('a legacy stop (no history entry) excludes only the pair it falls in', () => {
        const hist = [
            // Deliberately out of order: sorting by time is part of the contract.
            { measured_at: iso(60),  total_gal: 34.0, tracked_gal: 20.0, fuel_stop_gal: 15.0, ...chain(1) },
            { measured_at: iso(0),   total_gal: 33.6, tracked_gal: 30.0, ...chain(0) },
            { measured_at: iso(120), total_gal: 25.0, tracked_gal: 24.0, ...chain(2) },
            { measured_at: iso(180), total_gal: 22.0, tracked_gal: 21.8, ...chain(3) },
            { measured_at: iso(240), total_gal: 18.0, tracked_gal: 17.5, ...chain(4) },
        ];
        // (0→60)    stop entry: actual 33.6 − (34 − 15) = 14.6, tracked 33.6 − 20 = 13.6
        // (60→120)  plain:      actual 34 − 25 = 9.0,          tracked 34 − 24 = 10.0
        // (120→180) plain:      actual 3.0, tracked 3.2 — but a legacy stop at +150
        // (180→240) plain:      actual 4.0, tracked 4.5
        const matched = { airport: 'KMYL', gallons: 15.0, saved_at: new Date(Date.parse(iso(60)) + 2).toISOString() };
        const legacy  = { airport: 'KBOI', gallons: 10.0, saved_at: iso(150) };

        setData(hist, [matched, legacy]);
        open();
        expect($('fo-kf-filled').textContent).toBe('27.6 gal');
        expect($('fo-kf-used').textContent).toBe('28.1 gal');
        expect($('fo-kf-ratio').textContent).toBe('1.018');
        expect($('fo-kf-excluded').textContent).toBe('1 leg excluded: 1 recorded before this check');
        overlay.hide();

        setData(hist, [matched]);                        // no legacy stop: (120→180) counts
        open();
        expect($('fo-kf-filled').textContent).toBe('30.6 gal');
        expect($('fo-kf-used').textContent).toBe('31.3 gal');
        expect($('fo-kf-ratio').textContent).toBe('1.023');
        expect($('fo-kf-excluded').style.display).toBe('none');
    });

    it('tracked burn lower than actual says decrease the K-factor', () => {
        setData([
            { measured_at: iso(0),  total_gal: 35.0, tracked_gal: 35.0, ...chain(0) },
            { measured_at: iso(60), total_gal: 5.0,  tracked_gal: 8.0, ...chain(1) },  // actual 30, tracked 27
        ], []);
        open();
        expect($('fo-kf-ratio').textContent).toBe('0.900');
        expect($('fo-kf-guidance').textContent).toMatch(/decrease K-factor — tracked burn lower than actual/);
    });

    it('old history entries (edm_gal only, no tracking fields) are excluded, never NaN', () => {
        setData([
            { measured_at: iso(0),  total_gal: 33.6, edm_gal: 31.0 },
            { measured_at: iso(60), total_gal: 25.0, edm_gal: 22.0 },        // actual 8.6, tracked 11.6
            { measured_at: iso(90), total_gal: 24.0 },                        // neither figure
            { measured_at: iso(95), total_gal: 23.5, tracked_gal: 'x' },      // junk
        ], [{ airport: 'KMYL', gallons: 11.6, saved_at: iso(200) }]);
        open();
        expect($('fo-kf-filled').textContent).toBe('-- gal');
        expect($('fo-kf-used').textContent).toBe('-- gal');
        expect($('fo-kf-ratio').textContent).toBe('--');
        expect($('fo-kf-excluded').textContent).toBe('3 legs excluded: 3 recorded before this check');
        expect(overlay._el.querySelector('#fo-kfactor-panel').textContent).not.toMatch(/NaN/);
    });

    it('a tic that rose with no stop entry does not count; labels speak of tracked fuel flow', () => {
        setData([
            { measured_at: iso(0),  total_gal: 20.0, tracked_gal: 22.0, ...chain(0) },
            { measured_at: iso(60), total_gal: 30.0, tracked_gal: 12.0, ...chain(1) },    // actual −10: skipped
        ], []);
        open();
        expect($('fo-kf-used').textContent).toBe('-- gal');
        const txt = overlay._el.querySelector('#fo-kfactor-panel').textContent;
        expect(txt).not.toMatch(/EDM/);
        expect(txt).toMatch(/ACTUAL USED \(tic \+ fuel stops\)/);
        expect(txt).toMatch(/TRACKED USED \(fuel flow\)/);
        expect(txt).not.toMatch(/pulses per gallon/);
        expect(txt).toMatch(/if GALS USED reads higher than you expect, increase the K-factor/);
        expect(txt).toMatch(/FlightDEK-D180 Installation Guide, p\. 6-14/);
        expect($('fo-kf-excluded').textContent).toBe('1 leg excluded: 1 unusable reading');
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

describe('PR #214 finding 5: live TIC vs TRACKED with fuel-stop gallons entered', () => {
    it('grades against tracked + the gallons in FUEL ADDED, labelled', () => {
        FuelTankState.init(5, 6, 'L');                                 // 11.0 tracked
        const d = open();
        drag(d.leftSlider, 8);
        drag(d.rightSlider, 11);                                        // tic 33.6
        expect($('fo-edm-tracked-label').textContent).toBe('TRACKED');
        expect($('fo-edm-var').textContent).toBe('+22.6 gal');

        d.addGal.value = '22';
        d.addGal.dispatchEvent(new window.Event('input'));
        expect($('fo-edm-tracked-label').textContent).toBe('TRACKED + 22.0 ADDED');
        expect($('fo-edm-tracked').textContent).toBe('33.0 gal');
        expect($('fo-edm-var').textContent).toBe('+0.6 gal');
        expect($('fo-edm-grade').textContent).toBe('EXCELLENT');

        d.addGal.value = '';
        d.addGal.dispatchEvent(new window.Event('input'));
        expect($('fo-edm-tracked-label').textContent).toBe('TRACKED');
        expect($('fo-edm-tracked').textContent).toBe('11.0 gal');
    });

    it('an invalid gallons entry (0, negative, text) is ignored', () => {
        FuelTankState.init(5, 6, 'L');
        const d = open();
        drag(d.leftSlider, 8);
        for (const v of ['0', '-3', 'abc']) {
            d.addGal.value = v;
            d.addGal.dispatchEvent(new window.Event('input'));
            expect($('fo-edm-tracked-label').textContent).toBe('TRACKED');
        }
    });

    it('a stale tracked figure plus added gallons still says UNCONFIRMED', () => {
        FuelTankState.init(5, 6, 'L');
        FuelTankState.needsConfirmation = () => true;
        const d = open();
        drag(d.leftSlider, 8);
        d.addGal.value = '10';
        d.addGal.dispatchEvent(new window.Event('input'));
        expect($('fo-edm-tracked').textContent).toBe('21.0 gal (UNCONFIRMED)');
    });
});

describe('PR #214 finding 9: one createMeasurement call per record', () => {
    it('_createRecordedMeasurement calls FuelEngine.createMeasurement exactly once', () => {
        FuelTankState.init(5, 6, 'L');
        window.enginePanel = freshPanel({ Fuel_Remaining: 10.2 });
        const d = open();
        drag(d.leftSlider, 8);
        const spy = vi.spyOn(FuelEngine, 'createMeasurement');
        const m = overlay._createRecordedMeasurement();
        expect(spy).toHaveBeenCalledTimes(1);
        spy.mockRestore();
        expect(m.edm_gal).toBe(10.2);
        expect(m.tracked_gal).toBe(11);
    });
});

describe('PR #214 finding 10: D-180 figure is a data value (font-weight 900)', () => {
    it('the number sits in .fo-edm-d180-val, styled 900; the label stays 700/800', () => {
        FuelTankState.init(8, 8, 'L');
        window.enginePanel = freshPanel({ Fuel_Remaining: 12.5 });
        const d = open();
        drag(d.leftSlider, 8);
        const line = $('fo-edm-d180');
        expect(line.textContent).toBe('D-180: 12.5 gal');
        expect(line.querySelector('.fo-edm-d180-val').textContent).toBe('12.5 gal');
        const css = read('web/style.css');
        const rule = (sel) => {
            const m = css.match(new RegExp('\\n' + sel.replace(/[.-]/g, '\\$&') + '\\s*\\{([^}]*)\\}'));
            return m ? m[1] : '';
        };
        expect(rule('.fo-edm-d180-val')).toMatch(/font-weight:\s*900/);
        expect(rule('.fo-edm-d180-val')).toMatch(/font-family:\s*var\(--font-instrument\)/);
        expect(rule('.fo-edm-d180')).toMatch(/font-weight:\s*(700|800)/);
    });
});
