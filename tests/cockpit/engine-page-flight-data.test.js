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

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

globalThis.EngineClient = { MIN_PI_CONTRACT: 2 };

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
});
