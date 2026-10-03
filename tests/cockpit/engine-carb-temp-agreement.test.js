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
            ? { enabled: true, position: 'top-right', fields: [{ key: 'carb_temp' }, { key: 'oil_temp' }, { key: 'oil_press' }, { key: 'cht_max' }, { key: 'egt_max' }] }
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
        const ovCls = mapHost.querySelectorAll('.engine-overlay-value')[0].className;
        const ep = levelOfClass(epCls, 'ep-val-danger', 'ep-val-caution');
        const ov = levelOfClass(ovCls, 'danger', 'caution');
        expect(ov).toBe(ep);
        expect(ep).toBe(EngineLimits.carbTempLevel(t));
    });
});

/** Render one frame on both displays; return [ENG page level, map level] for an ENG id / map card index. */
function both(row, epId, mapIdx) {
    const flat = { ...ENGINE_FRAME, ...(ENGINE_FRAME.data || {}), ...row };
    page.update(flat);
    overlay.update(flat);
    return [
        levelOfClass(page._el.querySelector('#' + epId).className, 'ep-val-danger', 'ep-val-caution'),
        levelOfClass(mapHost.querySelectorAll('.engine-overlay-value')[mapIdx].className, 'danger', 'caution'),
    ];
}

describe('oil, CHT and EGT: ENG page and map engine box agree', () => {
    it.each([150, 219, 220, 244, 245, 260])('oil temp %i°F', (t) => {
        const [ep, ov] = both({ Oil_Temp: t }, 'ep-oilt', 1);
        expect(ov).toBe(ep);
    });
    it.each([0, 25, 26, 55, 56, 80, 94, 95, 99, 100, 110])('oil pressure %i psi', (p) => {
        const [ep, ov] = both({ Oil_Press: p }, 'ep-oilp', 2);
        expect(ov).toBe(ep);
    });
    it.each([300, 379, 380, 434, 435, 470])('CHT %i°F (all cylinders equal, so max = each)', (c) => {
        const [ep, ov] = both({ CHT1: c, CHT2: c, CHT3: c, CHT4: c }, 'ep-cht-1', 3);
        expect(ov).toBe(ep);
    });
    it.each([1200, 1499, 1500, 1649, 1650, 1700])('EGT %i°F (all cylinders equal)', (e) => {
        const [ep, ov] = both({ EGT1: e, EGT2: e, EGT3: e, EGT4: e }, 'ep-egt-1', 4);
        expect(ov).toBe(ep);
    });
    it('both honor an enginePage override (CHT danger 400)', () => {
        const get = CockpitConfig.get;
        CockpitConfig.get = (p) => (p === 'enginePage' ? { chtCaution: 350, chtDanger: 400 } : get(p));
        page._loadConfig();
        const [ep, ov] = both({ CHT1: 410, CHT2: 410, CHT3: 410, CHT4: 410 }, 'ep-cht-1', 3);
        expect([ep, ov]).toEqual(['danger', 'danger']);
    });
});

describe('ENG page without engine-limits.js loaded', () => {
    it('still renders every value (uncolored) instead of throwing mid-update', () => {
        const saved = globalThis.EngineLimits;
        delete globalThis.EngineLimits;
        try {
            const host = document.createElement('div');
            document.body.appendChild(host);
            const p = new EnginePage(host);
            p.show();
            expect(() => p.update({ ...ENGINE_FRAME, ...(ENGINE_FRAME.data || {}), Carb_Temp: 20, CHT1: 500 })).not.toThrow();
            expect(p._el.querySelector('#ep-cht-1').textContent).toBe('500');
        } finally { globalThis.EngineLimits = saved; }
    });
});
