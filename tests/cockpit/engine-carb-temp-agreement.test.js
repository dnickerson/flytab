/**
 * The map's engine box and the ENG page must color the same carb temp the same
 * way. They used to disagree (map: amber < 40°F, red < 32°F; ENG page: amber
 * 32-70°F, red 0-32°F). Both now call EngineLimits.carbTempLevel; this renders
 * the real ENG page and the real overlay side by side and compares.
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
const EngineOverlay = new Function(read('web/cockpit/engine-overlay.js') + '\nreturn EngineOverlay;')();

const levelOfClass = (cls, danger, caution) =>
    cls.includes(danger) ? 'danger' : cls.includes(caution) ? 'caution' : 'normal';

let page, overlay, mapHost;
beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = true;
    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null };
    globalThis.CockpitConfig = {
        get: (p) => (p === 'engineOverlay'
            ? { enabled: true, position: 'top-right', fields: [{ key: 'carb_temp', label: 'CARB TEMP', unit: '°F' }] }
            : null),
        aircraft: (path) => (path === 'performance.fuel_capacity_gal' ? 36 : undefined),
    };
    window.enginePanel = { connected: true };
    window.engineClient = { ip: '192.168.10.1' };
    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();
    mapHost = document.createElement('div');
    overlay = new EngineOverlay(mapHost);
});
afterEach(() => {
    overlay.destroy();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete window.enginePanel;
    delete window.engineClient;
    delete globalThis.fetch;
});

describe('carb temp: ENG page and map engine box agree', () => {
    it.each([-10, 0, 1, 20, 32, 33, 40, 55, 70, 71, 90, 118])('%i°F', (t) => {
        const frame = { ...ENGINE_FRAME, data: { ...(ENGINE_FRAME.data || {}), Carb_Temp: t } };
        const flat = frame.data ? { ...frame, ...frame.data } : frame;
        page.update(flat);
        overlay.update(flat);
        const epCls = page._el.querySelector('#ep-carb').className;
        const ovCls = mapHost.querySelector('.engine-overlay-value').className;
        const ep = levelOfClass(epCls, 'ep-val-danger', 'ep-val-caution');
        const ov = levelOfClass(ovCls, 'danger', 'caution');
        expect(ov).toBe(ep);
        expect(ep).toBe(EngineLimits.carbTempLevel(t));
    });
});
