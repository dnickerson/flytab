/**
 * Engine Page — flight-data port (TAS, Cruise Targets, ATIS override)
 *
 * Covers the fields ported from the Pi's now-deleted embedded dashboard into
 * FlyTab's ENG page: EST. TAS, CRUISE TARGETS, and ATIS OVERRIDE. All three
 * fields already existed on the wire (engine_monitor.py get_status()) — this
 * only tests the new render/interaction code in engine-page.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');

const flatten = (frame) => (frame.data ? { ...frame, ...frame.data } : frame);
const FRAME = flatten(ENGINE_FRAME);

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));

// Browser globals that engine-client.js requires
global.WebSocket = class {
    constructor() {}
    close() {}
};
global.fetch = vi.fn().mockRejectedValue(new Error('no network'));

// Load the real EngineClient to provide baseUrl() static method
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

let page = null;

function setup() {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = true;

    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null };
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (path) => (path === 'performance.fuel_capacity_gal' ? 36 : undefined),
    };
    window.enginePanel = { connected: true };
    window.engineClient = { ip: '192.168.10.1' };

    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();
    return page;
}

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
});

afterEach(() => {
    page = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete window.enginePanel;
    delete window.engineClient;
    delete globalThis.fetch;
});

describe('EnginePage — EST. TAS', () => {
    it('renders tas rounded to the nearest knot', () => {
        setup();
        page.update({ ...FRAME, tas: 154.6 });
        expect(page._el.querySelector('#ep-tas').textContent).toBe('155');
    });

    it('shows placeholder when tas is 0', () => {
        setup();
        page.update({ ...FRAME, tas: 0 });
        expect(page._el.querySelector('#ep-tas').textContent).toBe('---');
    });
});

describe('EnginePage — Cruise Targets', () => {
    it('renders target fuel flow, power, and mode', () => {
        setup();
        page.update({ ...FRAME, target_fuel_flow: 9.2, target_power: 65, target_mode: 'LEAN' });
        expect(page._el.querySelector('#ep-target-ff').textContent).toBe('9.2');
        expect(page._el.querySelector('#ep-target-pwr').textContent).toBe('65');
        expect(page._el.querySelector('#ep-target-mode').textContent).toBe('LEAN');
    });

    it('shows placeholders when target fields are zero/empty', () => {
        setup();
        page.update({ ...FRAME, target_fuel_flow: 0, target_power: 0, target_mode: '' });
        expect(page._el.querySelector('#ep-target-ff').textContent).toBe('--.-');
        expect(page._el.querySelector('#ep-target-pwr').textContent).toBe('--');
        expect(page._el.querySelector('#ep-target-mode').textContent).toBe('---');
    });
});

describe('EnginePage — ATIS override', () => {
    it('shows "using calculated" when no override is active', () => {
        setup();
        page.update({ ...FRAME, manual_altimeter: null, manual_oat: null });
        expect(page._el.querySelector('#ep-atis-status').textContent).toBe('Using calculated OAT / altimeter');
    });

    it('shows active-override text and pre-fills empty inputs', () => {
        setup();
        page.update({ ...FRAME, manual_altimeter: 29.92, manual_oat: 15 });
        expect(page._el.querySelector('#ep-atis-status').textContent).toContain('ATIS OVERRIDE ACTIVE');
        expect(page._el.querySelector('#ep-atis-status').textContent).toContain('ALT 29.92 inHg');
        expect(page._el.querySelector('#ep-atis-status').textContent).toContain('OAT 15°C');
        expect(page._el.querySelector('#ep-atis-alt-input').value).toBe('29.92');
        expect(page._el.querySelector('#ep-atis-oat-input').value).toBe('15');
    });

    it('does not clobber an in-progress pilot edit', () => {
        setup();
        const input = page._el.querySelector('#ep-atis-alt-input');
        input.value = '30.01';
        page.update({ ...FRAME, manual_altimeter: 29.92 });
        expect(input.value).toBe('30.01');
    });

    it('SET posts only the altimeter key', async () => {
        setup();
        await page._setAtis('altimeter', '29.85');
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'http://192.168.10.1:8080/api/atis',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ altimeter: 29.85 }),
            })
        );
    });

    it('CLEAR posts null for the given key', async () => {
        setup();
        await page._setAtis('oat', null);
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'http://192.168.10.1:8080/api/atis',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ oat: null }),
            })
        );
    });

    it('tapping SET with a populated input fires the wired fetch', async () => {
        setup();
        const input = page._el.querySelector('#ep-atis-alt-input');
        const btn = page._el.querySelector('#ep-atis-alt-set');
        input.value = '29.85';
        btn.dispatchEvent(new Event('pointerup'));
        await Promise.resolve();
        await Promise.resolve();
        expect(globalThis.fetch).toHaveBeenCalledWith(
            'http://192.168.10.1:8080/api/atis',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ altimeter: 29.85 }),
            })
        );
    });

    it('tapping SET with an empty input does not fetch (no-ops instead of clearing)', async () => {
        setup();
        const input = page._el.querySelector('#ep-atis-oat-input');
        const btn = page._el.querySelector('#ep-atis-oat-set');
        input.value = '';
        btn.dispatchEvent(new Event('pointerup'));
        await Promise.resolve();
        await Promise.resolve();
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('holds an error message through subsequent update() ticks until the hold window expires', async () => {
        setup();
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        try {
            // An out-of-range SET writes an error via _atisStatusError, which
            // starts a 5s hold window.
            await page._setAtis('altimeter', '99.0');
            expect(page._el.querySelector('#ep-atis-status').textContent)
                .toBe('Altimeter must be 27.0–32.0 inHg');

            // A telemetry tick 1s later must not stomp the error.
            nowSpy.mockReturnValue(1_001_000);
            page.update({ ...FRAME, manual_altimeter: null, manual_oat: null });
            expect(page._el.querySelector('#ep-atis-status').textContent)
                .toBe('Altimeter must be 27.0–32.0 inHg');

            // Once the hold window has elapsed, normal status text resumes.
            nowSpy.mockReturnValue(1_006_000);
            page.update({ ...FRAME, manual_altimeter: null, manual_oat: null });
            expect(page._el.querySelector('#ep-atis-status').textContent)
                .toBe('Using calculated OAT / altimeter');
        } finally {
            nowSpy.mockRestore();
        }
    });

    it('_engineBaseUrl returns null, not a guessed IP, when engineClient is unavailable', () => {
        setup();
        delete window.engineClient;
        expect(page._engineBaseUrl()).toBeNull();
    });

    it('_setAtis shows a clear error and does not fetch when the IP is unavailable', async () => {
        setup();
        delete window.engineClient;
        await page._setAtis('altimeter', '29.85');
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(page._el.querySelector('#ep-atis-status').textContent).toBe('Engine monitor IP unavailable');
    });
});
