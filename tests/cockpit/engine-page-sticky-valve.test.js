/**
 * ENG page: the sticky-valve warning comes from the shared monitor
 * (window.stickyValve, web/shared/sticky-valve.js), not the page's own check --
 * the page used to run its own copy, which only it could show.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');
const read = (p) => readFileSync(p, 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('click', fn));
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
globalThis.EngineLimits = new Function(read('web/shared/engine-limits.js') + '\nreturn EngineLimits;')();
globalThis.StickyValveMonitor = new Function(read('web/shared/sticky-valve.js') + '\nreturn StickyValveMonitor;')();
globalThis.StickyValveBanner = new Function(read('web/cockpit/sticky-valve-banner.js') + '\nreturn StickyValveBanner;')();
const EnginePage = new Function(read('web/cockpit/engine-page.js') + '\nreturn EnginePage;')();

const frame = (rpm, egt) => ({ data: { RPM: rpm, EGT1: egt[0], EGT2: egt[1], EGT3: egt[2], EGT4: egt[3] } });

let page, clock;
beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = true;
    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null };
    globalThis.CockpitConfig = { get: () => null, aircraft: (p) => (p === 'performance.fuel_capacity_gal' ? 36 : undefined) };
    window.engineClient = { ip: '192.168.10.1' };
    clock = 0;
    window.stickyValve = new StickyValveMonitor(null, { now: () => clock * 1000 });
    const host = document.createElement('div');
    document.body.appendChild(host);
    page = new EnginePage(host);
    page.show();
});
afterEach(() => {
    clearTimeout(page?._timeoutId);
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete window.enginePanel;
    delete window.engineClient;
    delete window.stickyValve;
    delete globalThis.fetch;
});

const banner = () => document.querySelector('#ep-sticky-slot .sv-banner');

describe('ENG page sticky-valve warning', () => {
    it('shows the shared monitor\'s alert in the ENG page', () => {
        expect(banner()).not.toBeNull();
        expect(banner().style.display).toBe('none');
        window.stickyValve.feed(frame(1000, [80, 80, 80, 80]));
        for (let t = 1; t <= 31; t++) { clock = t; window.stickyValve.feed(frame(1000, [1200, 1180, 300, 1190])); }
        expect(banner().style.display).toBe('flex');
        expect(banner().textContent).toContain('CYL 3');
    });

    it('the page no longer runs a check of its own on its 1 Hz tick', () => {
        expect(page._checkStickyValve).toBeUndefined();
        window.enginePanel = { lastData: { ...ENGINE_FRAME, ...(ENGINE_FRAME.data || {}) }, lastPollTime: Date.now(), connected: true };
        clearTimeout(page._timeoutId);
        page._tick();
        clearTimeout(page._timeoutId);
        expect(banner().style.display).toBe('none');
    });
});
