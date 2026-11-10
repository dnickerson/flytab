/**
 * Fuel tanks widget when engine data stops or freezes (final-review I3, M5).
 *
 * I3: no frames at all (Pi off, WiFi lost) fires EngineClient's engine:stale
 *     ({stale: true}) or engine:disconnect; GPH and endurance must drop to '--'
 *     instead of holding the last flow.
 * M5: a frozen frame (Pi resending its last row, EngineClient.edmCurrent false)
 *     must not present its Fuel_Left / Fuel_Right as current sender readouts.
 *
 * Real FuelTanksDisplay, FuelTankState, FuelEngine and EngineClient; the engine
 * client is an EventTarget like the real one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = vi.fn();
globalThis.FuelEngine    = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.EngineClient  = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelTanksDisplay   = new Function(read('web/cockpit/fuel-tanks.js') + '\nreturn FuelTanksDisplay;')();

let widget = null;
let client = null;

beforeEach(() => {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    globalThis.CockpitConfig = {
        aircraft: (p) => (p === 'performance.fuel_capacity_gal' ? 36
            : p === 'performance.fuel_sender_accurate_below_gal' ? 12 : undefined),
    };
    FuelTankState.init(10, 8, 'L');
    client = new EventTarget();
    window.engineClient = client;
    widget = new FuelTanksDisplay(document.body);
    widget.init();
});

afterEach(() => {
    try { widget && widget.destroy(); } catch (_) { /* */ }
    widget = null;
    delete window.engineClient;
    document.body.innerHTML = '';
});

const frame = (extra = {}) => new CustomEvent('engine:data', {
    detail: { serial_connected: true, data: { Fuel_Flow: 9.0, RPM: 2400, Fuel_Left: 5.2, Fuel_Right: 4.1, ...extra } },
});
const flow = () => widget._dom.flow.textContent;
const end = () => widget._dom.end.textContent;

describe('I3: no frames → GPH and endurance read --', () => {
    it('engine:stale {stale: true} clears the last flow', () => {
        client.dispatchEvent(frame());
        expect(flow()).toBe('9.0');
        expect(end()).toMatch(/^\d+:\d\d$/);     // ~18 gal / 9 gph (exact text: see report, FuelEngine.endurance)
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true, ageMs: 6000 } }));
        expect(flow()).toBe('--');
        expect(end()).toBe('--');
    });

    it('engine:disconnect clears the last flow', () => {
        client.dispatchEvent(frame());
        expect(flow()).toBe('9.0');
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        expect(flow()).toBe('--');
        expect(end()).toBe('--');
    });

    it('engine:stale {stale: false} (frames resumed) does not blank, and the next frame shows flow again', () => {
        client.dispatchEvent(frame());
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: false } }));
        expect(flow()).toBe('9.0');
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        client.dispatchEvent(frame({ Fuel_Flow: 8.0 }));
        expect(flow()).toBe('8.0');
    });

    it('destroy() removes the stale and disconnect listeners', () => {
        const spy = vi.spyOn(client, 'removeEventListener');
        client.dispatchEvent(frame());
        widget.destroy();
        const names = spy.mock.calls.map(c => c[0]);
        expect(names).toEqual(expect.arrayContaining(['engine:data', 'engine:stale', 'engine:disconnect']));
        widget = null;
    });
});

describe('M5: frozen frames do not update the s: sender readouts', () => {
    it('a current frame shows the senders; a frozen one shows s:—', () => {
        client.dispatchEvent(frame());
        expect(widget._dom.senderL.textContent).toBe('s:5.2');
        expect(widget._dom.senderR.textContent).toBe('s:4.1');
        client.dispatchEvent(new CustomEvent('engine:data', {
            detail: { serial_connected: true, serial_warning: 'No EDM data for 6s',
                      data: { Fuel_Flow: 9.0, Fuel_Left: 7.7, Fuel_Right: 6.6 } },
        }));
        expect(widget._dom.senderL.textContent).toBe('s:\u2014');
        expect(widget._dom.senderR.textContent).toBe('s:\u2014');
    });

    it('a frozen frame with only Fuel_Remaining does not show it either', () => {
        client.dispatchEvent(new CustomEvent('engine:data', {
            detail: { serial_connected: false, data: { Fuel_Flow: 9.0, Fuel_Remaining: 9.9 } },
        }));
        expect(widget._dom.senderL.textContent).not.toMatch(/9\.9|s:10/);
    });
});
