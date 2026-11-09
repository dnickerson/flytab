import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// Real modules, not stubs: EngineClient.edmCurrent decides whether a frame may
// burn fuel, and FuelTankState.onSample is the sink we spy on.
globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = vi.fn();
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
const FuelTanksDisplay = new Function(read('web/cockpit/fuel-tanks.js') + '\nreturn FuelTanksDisplay;')();

let widget = null;

function mockConfig() {
    globalThis.CockpitConfig = {
        aircraft: (path) => {
            if (path === 'performance.fuel_capacity_gal') return 36;
            if (path === 'performance.fuel_sender_accurate_below_gal') return 12;
            return undefined;
        },
    };
}

function makeWidget() {
    FuelTankState._state = null;
    FuelTankState._loaded = true;
    mockConfig();
    const host = document.createElement('div');
    document.body.appendChild(host);
    widget = new FuelTanksDisplay(host);
    widget.init();
    return widget;
}

beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
afterEach(() => {
    try { widget && widget.destroy(); } catch (_) { /* partial DOM */ }
    widget = null;
    document.body.innerHTML = '';
});

describe('FuelTanksDisplay burn gate (only current EMS data burns fuel)', () => {
    it('burns from a current frame', () => {
        const w = makeWidget();
        const onSample = vi.spyOn(FuelTankState, 'onSample').mockImplementation(() => {});
        w._handleEngineData({ Fuel_Flow: 9.5 });
        expect(onSample).toHaveBeenCalledTimes(1);
        expect(onSample).toHaveBeenCalledWith(9.5, expect.any(Number));
    });

    it('does not burn from a frozen frame (serial_warning)', () => {
        const w = makeWidget();
        const onSample = vi.spyOn(FuelTankState, 'onSample').mockImplementation(() => {});
        w._handleEngineData({ Fuel_Flow: 9.5, serial_warning: 'no EDM data 30 s' });
        expect(onSample).not.toHaveBeenCalled();
    });

    it('does not burn when serial_connected is false', () => {
        const w = makeWidget();
        const onSample = vi.spyOn(FuelTankState, 'onSample').mockImplementation(() => {});
        w._handleEngineData({ Fuel_Flow: 9.5, serial_connected: false });
        expect(onSample).not.toHaveBeenCalled();
    });

    it('still updates the sender display from a frozen frame', () => {
        const w = makeWidget();
        vi.spyOn(FuelTankState, 'onSample').mockImplementation(() => {});
        const updateSender = vi.spyOn(w, '_updateSenderDisplay');
        w._handleEngineData({ Fuel_Flow: 9.5, serial_warning: 'no EDM data 30 s' });
        expect(updateSender).toHaveBeenCalledTimes(1);
    });
});
