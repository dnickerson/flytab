/**
 * Fuel overlay — a fuel stop may only be recorded from a reading taken NOW.
 *
 * fuel-overlay.js `show()` restores the previous measurement into the tic fields,
 * which is genuinely useful preflight. But the fuel-stop overlay (app.js
 * `_showFuelStopOverlay`) opens this same overlay from its "Measure & Record Fuel"
 * button, and `_recordFuelStop()` writes the tic reading straight into the canonical
 * `FuelTankState` — stamping a fresh `initialized_at`, which is exactly what the
 * fuel-stop overlay's Continue gate checks. Before this change the only guard was
 * `_leftTic === 0 && _rightTic === 0`, which after any preflight measurement — i.e.
 * always, in normal use — cannot fire. A pilot who departed full and took a partial
 * top-up could tap RECORD without touching a slider and have the app report
 * "Measured: 36.0 gal" with 26.0 gal in the tanks.
 *
 * Contracts covered:
 *  1. Restored-but-untouched tics are refused, before any state mutation, and
 *     `initialized_at` is NOT re-stamped (so the Continue gate stays red).
 *  2. A reading the pilot actually entered records normally.
 *  3. A reading that legitimately EQUALS the restored one is accepted once confirmed
 *     with a ± nudge — a correct action is never made impossible.
 *  4. Slider, number field and ± button all count as entering the reading.
 *  5. Each show() starts untouched; each successful record consumes the reading.
 *  6. The pre-existing 0/0 guard is intact — ticToGallons(0) is a non-zero ~2.24 gal,
 *     so computed gallons can never stand in for "nothing entered".
 *  7. The preflight APPLY path is unaffected by all of the above.
 *
 * Everything below drives the REAL FuelOverlay through the DOM its own _buildDOM()
 * creates, with the real FuelEngine / FuelState / FuelTankState / Settings and the
 * real shipped aircraft profile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

const FUEL_OVERLAY_SRC = read('web/cockpit/fuel-overlay.js');

globalThis.Settings      = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.FuelEngine    = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState     = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const FuelOverlay        = new Function(FUEL_OVERLAY_SRC + '\nreturn FuelOverlay;')();

const AC = JSON.parse(read('web/aircraft-config.json'));
const MAX_TIC = AC.tic_polynomial.max_tic;               // 11 = full tank

let overlay = null;
let realFetch = null;

beforeEach(() => {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    delete window.enginePanel;

    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => {
            if (p === 'tic_polynomial') return AC.tic_polynomial;
            if (p === 'performance.fuel_capacity_gal') return AC.performance.fuel_capacity_gal;
            return undefined;
        },
    };
    // Every network call the overlay makes is best-effort (Pi sync, flight-CSV EDM
    // lookup). Offline is the fuel-stop reality and keeps _resolveEdmFuel() at null.
    realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('offline'));
    globalThis.wireTap = (el, fn) => { if (el) el.addEventListener('click', fn); };

    overlay = new FuelOverlay(document.body);
});

afterEach(() => {
    overlay?._el?.remove();
    overlay = null;
    globalThis.fetch = realFetch;
});

/* ---------------------------------------------------------------- helpers */

/** Open the overlay the way the pilot does, past the 600ms tap-through guard. */
function open() {
    overlay.show();
    overlay._shownAt = 0;
    return overlay._dom;
}

/** Pilot drags a slider. Fires the same 'input' event the browser does. */
function drag(el, tic) {
    el.value = String(tic);
    el.dispatchEvent(new window.Event('input'));
}

/** Pilot types into the fine-entry number field. */
function type(el, tic) {
    el.value = String(tic);
    el.dispatchEvent(new window.Event('input'));
}

const tap = (id) => overlay._el.querySelector('#' + id)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/** The canonical tank state every fuel display on this branch reads. */
function tank() {
    const s = FuelTankState.getState();
    return s && { total: +(s.left_gal + s.right_gal).toFixed(1), stampedAt: s.initialized_at };
}

const status = () => overlay._dom.addStatus.textContent;
const rejected = () => overlay._dom.addStatus.className.includes('fo-add-status-error');

/** Depart with a measured reading, exactly as _applyMeasurement() would leave things. */
function departWith(tic) {
    open();
    drag(overlay._dom.leftSlider, tic);
    drag(overlay._dom.rightSlider, tic);
    const m = FuelEngine.createMeasurement(tic, tic, overlay._coefficients);
    FuelState.saveMeasurement(m);
    FuelTankState.init(m.left_gal, m.right_gal, 'L');
    overlay.hide();
    return tank();
}

/** Fill in the gallons-purchased field and tap RECORD FUEL STOP. */
function recordStop(gallons = 12) {
    overlay._dom.addGal.value = String(gallons);
    overlay._dom.addAirport.value = 'KMYL';
    tap('fo-add-record');
}

/* ------------------------------------------------------------------ tests */

describe('fuel stop record — requires a reading entered this session', () => {
    it('refuses the restored departure reading when no tic control was touched', () => {
        const departure = departWith(MAX_TIC);       // departed full: 36.0 gal
        expect(departure.total).toBe(36);

        open();
        // This is the trap: the sliders come back up already showing the departure value.
        expect(overlay._leftTic).toBe(MAX_TIC);
        expect(overlay._rightTic).toBe(MAX_TIC);

        recordStop(12);

        expect(rejected()).toBe(true);
        expect(status()).toMatch(/tic-mark reading/i);
        // Nothing mutated: neither the gallons nor — critically — the timestamp the
        // fuel-stop overlay's Continue gate compares against overlayShownAt.
        expect(tank().total).toBe(36);
        expect(tank().stampedAt).toBe(departure.stampedAt);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops') || '[]')).toHaveLength(0);
    });

    it('records the pilot’s own reading, and writes THAT figure to tank state', () => {
        departWith(MAX_TIC);                          // departed 36.0 gal
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);

        recordStop(12);

        expect(rejected()).toBe(false);
        expect(status()).toMatch(/Recorded:/);
        // 26.0 gal, not the 36.0 gal he departed with.
        expect(tank().total).toBe(26);
        expect(tank().total).not.toBe(36);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops'))).toHaveLength(1);
    });

    it('accepts a reading that legitimately equals the restored one, once confirmed', () => {
        departWith(8);
        const before = tank().total;
        open();
        expect(overlay._leftTic).toBe(8);

        // The pilot re-reads the tanks and gets the same number. He confirms with a
        // + then − round trip — the value never changes, but the reading is his.
        tap('fo-left-plus'); tap('fo-left-minus');
        tap('fo-right-plus'); tap('fo-right-minus');
        expect(overlay._leftTic).toBe(8);
        expect(overlay._rightTic).toBe(8);

        recordStop(8);

        expect(rejected()).toBe(false);
        // Same figure, correctly recorded. Not bit-identical to `before` only because
        // _applyMeasurement() inits from the per-tank gallons createMeasurement() has
        // already rounded to 0.1, while _recordFuelStop() inits from raw ticToGallons —
        // a pre-existing 0.1 gal difference between the two write paths, not a guard
        // effect. Pin both: the exact raw figure, and that it is the departure figure.
        expect(tank().total).toBe(+(FuelEngine.ticToGallons(8, overlay._coefficients) * 2).toFixed(1));
        expect(Math.abs(tank().total - before)).toBeLessThan(0.15);
    });

    it('counts the number field as entering the reading', () => {
        departWith(MAX_TIC);
        const d = open();
        type(d.leftInput, 5);
        type(d.rightInput, 5);

        recordStop(10);

        expect(rejected()).toBe(false);
        expect(tank().total).toBe(FuelEngine.createMeasurement(5, 5, overlay._coefficients).total_gal);
    });

    // Each of the eight tic controls must mark the reading on its own. Touching one is
    // all a pilot may do — e.g. only the right tank moved since he last measured — and
    // any single handler that forgets to mark would refuse a reading he really entered.
    const CONTROLS = [
        ['left slider',       (d) => drag(d.leftSlider, 6)],
        ['right slider',      (d) => drag(d.rightSlider, 6)],
        ['left number field', (d) => type(d.leftInput, 6)],
        ['right number field',(d) => type(d.rightInput, 6)],
        ['left −  button',    () => tap('fo-left-minus')],
        ['left +  button',    () => tap('fo-left-plus')],
        ['right − button',    () => tap('fo-right-minus')],
        ['right + button',    () => tap('fo-right-plus')],
    ];
    CONTROLS.forEach(([label, touch]) => {
        it(`accepts a reading entered with the ${label} alone`, () => {
            departWith(8);
            const d = open();
            touch(d);

            recordStop(10);

            expect(rejected()).toBe(false);
            expect(status()).toMatch(/Recorded:/);
            expect(tank().total).toBe(
                +(FuelEngine.ticToGallons(overlay._leftTic, overlay._coefficients)
                + FuelEngine.ticToGallons(overlay._rightTic, overlay._coefficients)).toFixed(1));
        });
    });

    it('starts every show() untouched — a reading entered before a hide does not carry over', () => {
        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        overlay.hide();

        open();                                        // second session, nothing touched
        recordStop(12);

        expect(rejected()).toBe(true);
        expect(tank().total).toBe(36);                 // still the departure figure
    });

    it('consumes the reading — a second RECORD tap needs its own measurement', () => {
        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);

        recordStop(12);
        expect(rejected()).toBe(false);
        const afterFirst = tank();

        recordStop(12);                                // double tap / second pump
        expect(rejected()).toBe(true);
        expect(tank().stampedAt).toBe(afterFirst.stampedAt);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops'))).toHaveLength(1);
    });

    it('still refuses 0/0 after the controls were touched — ticToGallons(0) is not zero', () => {
        // The reason a computed-gallons check cannot stand in for this guard.
        expect(FuelEngine.ticToGallons(0, overlay._coefficients)).toBeGreaterThan(2);

        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 0);
        drag(d.rightSlider, 0);

        recordStop(12);

        expect(rejected()).toBe(true);
        expect(tank().total).toBe(36);                 // 4.5 gal of intercept never written
    });

    it('still refuses when gallons added is missing, before any tic check', () => {
        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);

        overlay._dom.addGal.value = '';
        tap('fo-add-record');

        expect(rejected()).toBe(true);
        expect(status()).toMatch(/gallons/i);
        expect(tank().total).toBe(36);
    });
});

describe('preflight flow is unaffected', () => {
    it('APPLY still re-applies a restored reading with no tic interaction', async () => {
        departWith(8);
        const restored = tank().total;
        FuelTankState._state = null;                   // prove APPLY is what writes it
        FuelTankState._loaded = true;

        open();
        expect(overlay._leftTic).toBe(8);              // restored, untouched
        tap('fo-apply');
        await new Promise(r => setTimeout(r, 20));     // _resolveEdmFuel() is async

        expect(tank().total).toBe(restored);
        expect(overlay.visible).toBe(false);           // APPLY closes the overlay
    });
});

describe('structural contract with app.js', () => {
    it('gates _recordFuelStop on _ticsTouchedSinceShow, and show() resets it', () => {
        // _recordFuelStop must consult the flag, not only the tic values: app.js's
        // Continue gate has no other way to tell a fresh reading from a restored one.
        const recordBody = FUEL_OVERLAY_SRC.slice(
            FUEL_OVERLAY_SRC.indexOf('_recordFuelStop()'),
            FUEL_OVERLAY_SRC.indexOf('_engineBaseUrl()'));
        expect(recordBody).toMatch(/!this\._ticsTouchedSinceShow/);
        expect(recordBody).toMatch(/this\._leftTic === 0 && this\._rightTic === 0/);

        const showBody = FUEL_OVERLAY_SRC.slice(
            FUEL_OVERLAY_SRC.indexOf('    show() {'),
            FUEL_OVERLAY_SRC.indexOf('    hide() {'));
        expect(showBody).toMatch(/this\._ticsTouchedSinceShow = false/);
    });

    it('marks the reading entered from every tic control the pilot can reach', () => {
        // All eight handlers — two sliders, two number fields, four ± buttons.
        const buildBody = FUEL_OVERLAY_SRC.slice(
            FUEL_OVERLAY_SRC.indexOf('// Wire left tank controls'),
            FUEL_OVERLAY_SRC.indexOf('// Wire manual override'));
        const marks = buildBody.match(/this\._ticsTouchedSinceShow = true/g) || [];
        expect(marks).toHaveLength(8);
    });
});
