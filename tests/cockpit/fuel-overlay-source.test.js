/**
 * The ACTIVE FUEL SOURCE line and chip chain show the single fuel chain
 * (FuelState.getCurrentFuel): MANUAL > TRACKED > CAPACITY. A Pi/EDM figure is
 * never a source; an unconfirmed tracked figure is marked UNCONFIRMED.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
let realFetch = null;
let realNeeds = null;

beforeEach(() => {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    delete window.enginePanel;
    realNeeds = FuelTankState.needsConfirmation;
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => (p === 'performance.fuel_capacity_gal') ? AC.performance.fuel_capacity_gal : undefined,
    };
    realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    globalThis.wireTap = (el, fn) => { if (el) el.addEventListener('click', fn); };
    overlay = new FuelOverlay(document.body);
    overlay.show();
});

afterEach(() => {
    overlay?._el?.remove();
    overlay = null;
    globalThis.fetch = realFetch;
    FuelTankState.needsConfirmation = realNeeds;
});

const activeChips = () => [...overlay._el.querySelectorAll('.fo-source-chip.fo-source-active')]
    .map(c => c.dataset.src);

describe('FuelOverlay active fuel source', () => {
    it('chips are MANUAL > TRACKED > CAPACITY', () => {
        const chips = [...overlay._el.querySelectorAll('.fo-source-chip')];
        expect(chips.map(c => c.dataset.src)).toEqual(['manual', 'tank_state', 'capacity']);
        expect(chips.map(c => c.textContent)).toEqual(['MANUAL', 'TRACKED', 'CAPACITY']);
    });

    it('tracked tank state reads "(TRACKED)" and lights the tank_state chip', () => {
        FuelTankState.init(15.6, 18.0, 'L');
        overlay._updateSourceDisplay();
        expect(overlay._dom.sourceDisplay.textContent).toBe('33.6 gal (TRACKED)');
        expect(activeChips()).toEqual(['tank_state']);
    });

    it('a stale tracked figure carries "· UNCONFIRMED"', () => {
        FuelTankState.init(15.6, 18.0, 'L');
        FuelTankState.needsConfirmation = () => true;
        overlay._updateSourceDisplay();
        expect(overlay._dom.sourceDisplay.textContent).toBe('33.6 gal (TRACKED) · UNCONFIRMED');
        expect(activeChips()).toEqual(['tank_state']);
    });

    it('nothing tracked reads CAPACITY; a Pi figure does not change that', () => {
        window.enginePanel = { lastData: { fuel: { fuel_remaining: 16.9 } }, lastPollTime: Date.now() };
        overlay._updateSourceDisplay();
        expect(overlay._dom.sourceDisplay.textContent).toBe('36.0 gal (CAPACITY)');
        expect(activeChips()).toEqual(['capacity']);
    });

    it('manual override wins', () => {
        FuelTankState.init(15.6, 18.0, 'L');
        Settings.fuelManualOverride = 20;
        try {
            overlay._updateSourceDisplay();
            expect(overlay._dom.sourceDisplay.textContent).toBe('20.0 gal (MANUAL)');
            expect(activeChips()).toEqual(['manual']);
        } finally { Settings.fuelManualOverride = null; }
    });
});

describe('D-180 fuel figure freshness (used by the fuel overlay comparison)', () => {
    it('EDM_FRESHNESS_MS is a positive number', () => {
        expect(FuelState.EDM_FRESHNESS_MS).toBeGreaterThan(0);
    });

    it('_resolveD180Fuel returns a fresh D-180 Fuel_Remaining synchronously, without any fetch', () => {
        let fetched = 0;
        globalThis.fetch = () => { fetched++; return Promise.reject(new Error('no fetch expected')); };
        window.enginePanel = { lastData: { Fuel_Remaining: 16.9, fuel: { fuel_remaining: 30 } },
            lastPollTime: Date.now() };
        expect(overlay._resolveD180Fuel()).toBeCloseTo(16.9, 5);
        expect(fetched).toBe(0);
    });

    it('ignores the Pi tracker figure (data.fuel.*)', () => {
        window.enginePanel = { lastData: { fuel: { fuel_remaining: 16.9 } }, lastPollTime: Date.now() };
        expect(overlay._resolveD180Fuel()).toBeNull();
    });

    it('a stale panel reading is not used as live', () => {
        window.enginePanel = { lastData: { Fuel_Remaining: 16.9 },
            lastPollTime: Date.now() - FuelState.EDM_FRESHNESS_MS - 1000 };
        expect(overlay._resolveD180Fuel()).toBeNull();
    });
});
