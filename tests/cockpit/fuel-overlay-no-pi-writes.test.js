/**
 * The tablet's FuelTankState is the only fuel record. APPLY TIC, RECORD FUEL STOP
 * and APPLY CORRECTION must write to FlyTab only: no request to the Pi's
 * /api/fuel/set|add|apply_dropped_burn, no RETRY PI SYNC state, no Pi wording.
 *
 * Drives the real FuelOverlay through its own DOM. window.enginePanel carries a
 * fresh reading and fetch is stubbed, so nothing here depends on a network call.
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

// ANY request to the Pi's /api/fuel* endpoints (writes, reads, calibration) fails:
// the overlay no longer talks to the Pi about fuel at all.
const piFuelCalls = () => fetchSpy.mock.calls.filter(([u]) => /\/api\/fuel/.test(String(u)));
const tap = (id) => overlay._el.querySelector('#' + id)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const settle = () => new Promise(r => setTimeout(r, 30));
function drag(el, tic) { el.value = String(tic); el.dispatchEvent(new window.Event('input')); }
function open(opts) { overlay.show(opts); overlay._shownAt = 0; return overlay._dom; }

beforeEach(() => {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    FuelTankState._coveredMs = null;   // in memory only: a real app restart loses it
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => {
            if (p === 'tic_polynomial') return AC.tic_polynomial;
            if (p === 'performance.fuel_capacity_gal') return AC.performance.fuel_capacity_gal;
            return undefined;
        },
    };
    window.engineClient = { ip: '192.168.1.50' };
    window.enginePanel = { lastData: { fuel: { fuel_remaining: 20 } }, lastPollTime: Date.now() };
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
    delete window.engineClient;
    delete window.enginePanel;
});

describe('fuel overlay writes nothing to the Pi', () => {
    it('APPLY TIC writes no /api/fuel request and hides the overlay with no error', async () => {
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        tap('fo-apply');
        await settle();

        expect(piFuelCalls()).toHaveLength(0);
        expect(overlay.visible).toBe(false);
        expect(errSpy).not.toHaveBeenCalled();
        const st = FuelTankState.getState();
        const m = FuelEngine.createMeasurement(6, 6, overlay._coefficients);
        expect(st.left_gal + st.right_gal).toBeCloseTo(m.total_gal, 5);
        expect(overlay._dom.applyStatus.className).not.toContain('error');
        errSpy.mockRestore();
    });

    it('RECORD FUEL STOP with no Pi: recorded, no error, no RETRY PI SYNC label', async () => {
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        d.addGal.value = '12';
        d.addAirport.value = 'KMYL';

        tap('fo-add-record');
        await settle();

        expect(piFuelCalls()).toHaveLength(0);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops'))).toHaveLength(1);
        expect(d.addStatus.className).toContain('fo-add-status-ok');
        expect(d.addStatus.textContent).toMatch(/Recorded: \+12\.0 gal at KMYL/);
        expect(d.addStatus.textContent).not.toMatch(/pi/i);
        expect(d.addRecord.textContent).toBe('RECORD FUEL STOP');
        expect(d.addRecord.disabled).toBe(false);
    });

    it('APPLY CORRECTION applies on the tablet only', async () => {
        FuelTankState.init(10, 12, 'L');
        FuelTankState._state.dropped_burn_estimate_gal = 2.14;
        FuelTankState._save();
        const applySpy = vi.spyOn(FuelTankState, 'applyDroppedBurn');
        const d = open();
        expect(d.droppedBurnRow.style.display).toBe('');
        d.droppedBurnInput.value = '2.14';

        tap('fo-dropped-burn-apply');
        await settle();

        expect(applySpy).toHaveBeenCalledWith(2.14);
        expect(piFuelCalls()).toHaveLength(0);
        expect(d.droppedBurnRow.style.display).toBe('none');
        expect(d.droppedBurnApply.textContent).toBe('APPLY CORRECTION');
        expect(d.droppedBurnStatus.textContent).not.toMatch(/pi/i);
    });

    it('no Pi-sync message on a later show()', async () => {
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        d.addGal.value = '12';
        tap('fo-add-record');
        await settle();
        overlay.hide();

        const d2 = open();

        expect(d2.addStatus.textContent).toBe('');
        expect(d2.addRecord.textContent).toBe('RECORD FUEL STOP');
        expect(piFuelCalls()).toHaveLength(0);
        for (const k of ['_piSyncFailed', '_fuelStopPiSyncFailed', '_lastFuelStopPending']) {
            expect(overlay[k]).toBeUndefined();
        }
    });
});
