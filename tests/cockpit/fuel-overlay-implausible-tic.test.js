/**
 * The tic-mark polynomial can evaluate to physically impossible gallons for a
 * reading near max tic. The real aircraft-config.json already caps max_tic at
 * a capacity-correct 11 — this guard exists for when tic_polynomial config is
 * unavailable and FuelOverlay falls back to its constructor default (max_tic
 * 17, FuelEngine.DEFAULT_COEFFICIENTS), which the audit found reaches ~109 gal
 * at tic=17 for a 36gal aircraft (verified: hand-computed against the actual
 * default coefficients).
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

beforeEach(() => {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    delete window.enginePanel;

    // Deliberately no tic_polynomial — forces FuelOverlay's fallback
    // (_maxTic=17, FuelEngine.DEFAULT_COEFFICIENTS) so tic=17 reproduces the
    // audit's ~109gal scenario. performance.fuel_capacity_gal IS provided
    // (36, matching the real aircraft) so the new guard's cap is 18/side.
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => (p === 'performance.fuel_capacity_gal') ? AC.performance.fuel_capacity_gal : undefined,
    };
    realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    globalThis.wireTap = (el, fn) => { if (el) el.addEventListener('click', fn); };

    overlay = new FuelOverlay(document.body);
    overlay.show();
    overlay._shownAt = 0;
    overlay._ticsTouchedSinceShow = true;
});

afterEach(() => {
    overlay?._el?.remove();
    overlay = null;
    globalThis.fetch = realFetch;
});

const drag = (el, tic) => { el.value = String(tic); el.dispatchEvent(new window.Event('input')); };
const tap  = (id) => overlay._el.querySelector('#' + id)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const applyAndSettle = async () => { tap('fo-apply'); await new Promise(r => setTimeout(r, 20)); };

describe('FuelOverlay implausible tic-mark guard', () => {
    it('_applyMeasurement refuses a reading that implies more fuel than the tank holds', async () => {
        expect(overlay._maxTic).toBe(17); // confirms the fallback engaged, not the real 11-tic config
        drag(overlay._dom.leftSlider, 17); // ≈109 gal via the default polynomial, cap is 18/side

        await applyAndSettle();

        expect(overlay._dom.applyStatus.textContent).toMatch(/more than it can hold/i);
        expect(overlay._dom.applyStatus.className).toContain('fo-add-status-error');
        expect(overlay.visible).toBe(true); // refused, overlay stays open — nothing written
    });

    it('_recordFuelStop refuses the same implausible reading', () => {
        drag(overlay._dom.rightSlider, 17);
        overlay._dom.addGal.value = '10';

        tap('fo-add-record');

        expect(overlay._dom.addStatus.textContent).toMatch(/more than it can hold/i);
        expect(overlay._dom.addStatus.className).toContain('fo-add-status-error');
    });

    it('a plausible reading is not refused by the new guard', async () => {
        drag(overlay._dom.leftSlider, 8);
        drag(overlay._dom.rightSlider, 8);

        await applyAndSettle();

        expect(overlay._dom.applyStatus.textContent).not.toMatch(/more than it can hold/i);
    });

    it('re-validates the cap at write time — an edit made during the async EDM resolve cannot bypass the guard', async () => {
        // A plausible reading passes the tap-time guard and starts the async chain
        // (_resolveEdmFuel(), which the code's own comment notes "can take 3-5s").
        drag(overlay._dom.leftSlider, 8);
        tap('fo-apply');

        // Before that promise settles, the pilot edits the slider to an implausible
        // value — nothing disables the sliders during the wait.
        drag(overlay._dom.leftSlider, 17);
        await new Promise(r => setTimeout(r, 20));

        expect(overlay._dom.applyStatus.textContent).toMatch(/more than it can hold/i);
        expect(overlay._dom.applyStatus.className).toContain('fo-add-status-error');
        expect(overlay.visible).toBe(true); // refused, not hidden
        expect(FuelTankState.getState()).toBe(null); // nothing written
    });
});
