/**
 * ENG page: frozen EDM data must not read as LIVE.
 *
 * engine_monitor.py keeps resending its last parsed EDM row every second after
 * the EDM goes quiet, so the page's poll time stayed fresh and the header said
 * LIVE over frozen numbers. The Pi flags it itself (serial_warning after 5 s
 * without EDM data; serial_connected false when the port closes) --
 * EngineClient.edmCurrent. The page now shows EDM NO DATA and greys the values,
 * as it already did for an offline engine monitor.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');
const read = (p) => readFileSync(p, 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
globalThis.EngineLimits = new Function(read('web/shared/engine-limits.js') + '\nreturn EngineLimits;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

/** EnginePanel.lastData is the Pi status flattened ({...raw, ...raw.data}). */
const flat = (extra = {}) => ({ ...ENGINE_FRAME, ...(ENGINE_FRAME.data || {}), ...extra });

let page;
beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = true;
    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null };
    globalThis.CockpitConfig = { get: () => null, aircraft: (p) => (p === 'performance.fuel_capacity_gal' ? 36 : undefined) };
    window.engineClient = { ip: '192.168.10.1' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();
});
afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete window.enginePanel;
    delete window.engineClient;
    delete globalThis.fetch;
});

/** Run the page's real 1 Hz tick against a fake EnginePanel. */
function tickWith(lastData, pollTime = Date.now()) {
    window.enginePanel = { lastData, lastPollTime: pollTime, connected: true };
    clearTimeout(page._timeoutId);
    page._tick();
    clearTimeout(page._timeoutId);
}
const badge = () => page._el.querySelector('#ep-data-age');
const greyed = () => page._el.querySelector('.ep-container').classList.contains('ep-stale');

describe('ENG page — EDM data currency', () => {
    it('fresh EDM data: LIVE, values not greyed', () => {
        tickWith(flat({ serial_connected: true, serial_warning: null }));
        expect(badge().textContent).toBe('LIVE');
        expect(greyed()).toBe(false);
    });

    it('Pi up but EDM quiet (serial_warning): EDM NO DATA, values greyed -- not LIVE', () => {
        tickWith(flat({ serial_connected: true, serial_warning: 'No data received for 9 seconds', Carb_Temp: 75 }));
        expect(badge().textContent).toBe('EDM NO DATA');
        expect(badge().className).toContain('ep-data-age--offline');
        expect(greyed()).toBe(true);
        // The last value stays visible (greyed), as for an offline engine monitor.
        expect(page._el.querySelector('#ep-carb').textContent).toBe('75');
    });

    it('serial port closed (serial_connected false): EDM NO DATA', () => {
        tickWith(flat({ serial_connected: false }));
        expect(badge().textContent).toBe('EDM NO DATA');
        expect(greyed()).toBe(true);
    });

    it('recovers to LIVE when EDM data resumes', () => {
        tickWith(flat({ serial_warning: 'No data received for 9 seconds' }));
        tickWith(flat({ serial_warning: null }));
        expect(badge().textContent).toBe('LIVE');
        expect(greyed()).toBe(false);
    });

    it('no new Pi frame for >5 s: "Ns ago" and the values are greyed too', () => {
        tickWith(flat(), Date.now() - 9000);
        expect(badge().textContent).toBe('9s ago');
        expect(greyed()).toBe(true);
    });

    it('engine monitor offline is unchanged: ENGINE MON. OFFLINE, greyed', () => {
        tickWith(flat(), 0);
        expect(badge().textContent).toBe('ENGINE MON. OFFLINE');
        expect(greyed()).toBe(true);
    });
});

describe('EngineClient.edmCurrent', () => {
    it.each([
        [{ serial_connected: true, serial_warning: null }, true],
        [{}, true],                                             // older Pi without the fields
        [null, true],
        [{ serial_warning: 'Device reports ready but produced no data' }, false],
        [{ serial_connected: false }, false],
    ])('%j -> %s', (status, ok) => {
        expect(EngineClient.edmCurrent(status)).toBe(ok);
    });
});
