/**
 * Fuel overlay — APPLY may not write canonical state from a stale reading either.
 *
 * Companion to fuel-overlay-fuelstop-guard.test.js, which closed the RECORD FUEL STOP
 * half of this defect. `_applyMeasurement()` was left ungated and does the same two
 * writes: `FuelState.saveMeasurement()` and `FuelTankState.init()`. `init()` re-stamps
 * `initialized_at`, and that timestamp is the ONLY thing app.js's fuel-stop Continue
 * gate (`refreshMeasureStatus` → `initialized_at >= overlayShownAt`) compares. Since
 * `show()` restores the DEPARTURE reading into the tic fields, a pilot at a fuel stop
 * could tap the larger APPLY TIC MEASUREMENT button over untouched sliders and be told
 * "Measured: 36.0 gal" with 19.0 gal in the tanks — 17 gal optimistic, verified in a
 * jsdom repro against the real modules with a 2.0 h / 8.5 gph integrated burn.
 *
 * The fix gives `show()` an opts argument. app.js's fuel-stop "Measure & Record Fuel"
 * button passes `{ requireFreshTics: true }`; the preflight doors (tab-bar.js MORE →
 * Fuel Entry, instrument-strip.js) pass nothing and keep the permissive behaviour that
 * the previous fix deliberately preserved.
 *
 * Contracts covered:
 *  1. Fuel-stop APPLY over an untouched restored reading is refused BEFORE any mutation —
 *     tank gallons, `initialized_at` and the saved measurement are all unchanged.
 *  2. The refusal is visible, and does not wedge the `_applying` re-entrancy latch.
 *  3. Fuel-stop APPLY of a reading the pilot actually entered writes normally.
 *  4. A reading that legitimately EQUALS the restored one is accepted once confirmed
 *     with a ± round trip — a correct action is never made impossible.
 *  5. Preflight APPLY of a restored, untouched reading still works (unchanged).
 *  6. The mode is per-show(), not sticky in either direction.
 *  7. Structural: app.js's fuel-stop call site passes the flag; the preflight call
 *     sites do not.
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
const APP_SRC          = read('web/app.js');

globalThis.Settings      = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.FuelEngine    = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState     = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
// Load the real EngineClient to provide baseUrl() static method
globalThis.EngineClient  = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
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

/** MORE → Fuel Entry / instrument strip. Zero-arg show(), past the tap-through guard. */
function openPreflight() {
    overlay.show();
    overlay._shownAt = 0;
    return overlay._dom;
}

/** app.js _showFuelStopOverlay's "Measure & Record Fuel" button. */
function openFuelStop() {
    overlay.show({ requireFreshTics: true });
    overlay._shownAt = 0;
    return overlay._dom;
}

const drag = (el, tic) => { el.value = String(tic); el.dispatchEvent(new window.Event('input')); };
const tap  = (id) => overlay._el.querySelector('#' + id)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/** APPLY is async (_resolveEdmFuel). Let its promise chain settle. */
const applyAndSettle = async () => { tap('fo-apply'); await new Promise(r => setTimeout(r, 20)); };

/** The canonical tank state every fuel display on this branch reads. */
function tank() {
    const s = FuelTankState.getState();
    return s && { total: +(s.left_gal + s.right_gal).toFixed(1), stampedAt: s.initialized_at };
}

const applyStatus   = () => overlay._dom.applyStatus.textContent;
const applyRejected = () => overlay._dom.applyStatus.className.includes('fo-add-status-error');

/** Preflight: measure and APPLY, leaving Settings.fuelMeasurement for show() to restore. */
async function departWith(tic) {
    const d = openPreflight();
    drag(d.leftSlider, tic);
    drag(d.rightSlider, tic);
    await applyAndSettle();
    return tank();
}

/**
 * Fly the leg for real: integrate the burn through FuelTankState.onSample(), the same
 * path engine samples drive in flight, so the figure at the stop is genuinely lower
 * than the restored departure reading rather than being poked in by the test.
 */
function flyFor(hours, gph) {
    let t = Date.now();
    FuelTankState._state.last_sample_at = new Date(t).toISOString();
    const steps = Math.round(hours * 3600 * 1000 / FuelTankState.MAX_SAMPLE_DT_MS);
    for (let i = 0; i < steps; i++) {
        t += FuelTankState.MAX_SAMPLE_DT_MS;
        if (i % 180 === 0) {                     // swap tanks ~every 30 min
            FuelTankState._state.active_tank =
                FuelTankState._state.active_tank === 'L' ? 'R' : 'L';
        }
        FuelTankState.onSample(gph, t);
    }
    return tank();
}

/* ------------------------------------------------------------------ tests */

describe('APPLY at an in-flight fuel stop — requires a reading taken this session', () => {
    it('refuses the restored departure reading, before any state mutation', async () => {
        const departure = await departWith(MAX_TIC);        // departed full: 36.0 gal
        expect(departure.total).toBe(36);

        const atStop = flyFor(2.0, 8.5);                    // 2.0 h at 8.5 gph
        expect(atStop.total).toBeLessThan(departure.total);
        const savedBefore = JSON.stringify(FuelState.getMeasurement?.() ?? Settings.fuelMeasurement);

        openFuelStop();
        // The trap: the sliders come back up already showing the departure value.
        expect(overlay._leftTic).toBe(MAX_TIC);
        expect(overlay._rightTic).toBe(MAX_TIC);

        await applyAndSettle();

        // Nothing written: not the gallons, and — critically — not the timestamp the
        // fuel-stop overlay's Continue gate compares against overlayShownAt.
        expect(tank().total).toBe(atStop.total);
        expect(tank().stampedAt).toBe(atStop.stampedAt);
        expect(JSON.stringify(FuelState.getMeasurement?.() ?? Settings.fuelMeasurement))
            .toBe(savedBefore);
        // Refused, not silently swallowed — and the overlay stays open so the pilot can
        // enter the reading rather than being dumped back with nothing changed.
        expect(applyRejected()).toBe(true);
        expect(applyStatus()).toMatch(/tic-mark reading/i);
        expect(overlay.visible).toBe(true);
    });

    it('does not wedge the _applying latch — a corrected reading applies straight after', async () => {
        await departWith(MAX_TIC);
        flyFor(2.0, 8.5);

        const d = openFuelStop();
        await applyAndSettle();                             // refused
        expect(overlay._applying).toBe(false);

        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        await applyAndSettle();                             // now accepted

        expect(tank().total).toBe(FuelEngine.createMeasurement(6, 6, overlay._coefficients).total_gal);
        expect(overlay.visible).toBe(false);                // APPLY closes the overlay
    });

    it('applies the pilot’s own reading, and writes THAT figure to tank state', async () => {
        const departure = await departWith(MAX_TIC);        // 36.0 gal
        flyFor(2.0, 8.5);

        const d = openFuelStop();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        await applyAndSettle();

        expect(applyRejected()).toBe(false);
        expect(tank().total).toBe(FuelEngine.createMeasurement(6, 6, overlay._coefficients).total_gal);
        expect(tank().total).not.toBe(36);
        expect(tank().stampedAt).not.toBe(departure.stampedAt);   // gate legitimately green
    });

    it('accepts a reading that legitimately equals the restored one, once confirmed', async () => {
        await departWith(8);
        flyFor(1.0, 8.5);

        openFuelStop();
        expect(overlay._leftTic).toBe(8);

        // The pilot re-reads the tanks after topping off and gets the same number. He
        // confirms with a + then − round trip — the value never changes, but it is his.
        tap('fo-left-plus'); tap('fo-left-minus');
        tap('fo-right-plus'); tap('fo-right-minus');
        expect(overlay._leftTic).toBe(8);
        expect(overlay._rightTic).toBe(8);

        await applyAndSettle();

        expect(applyRejected()).toBe(false);
        // Sum the per-tank gallons APPLY actually stores. createMeasurement().total_gal
        // rounds the raw sum while init() stores each tank already rounded to 0.1, so at
        // tic 8 the two disagree by 0.1 gal (31.1 vs 31.2) — a pre-existing quirk of the
        // write path, pinned here so this test tracks what is stored, not a guard effect.
        const m = FuelEngine.createMeasurement(8, 8, overlay._coefficients);
        expect(tank().total).toBe(+(m.left_gal + m.right_gal).toFixed(1));
    });

    it('accepts a − then + round trip at max tic, where + alone is clamped', async () => {
        // At MAX_TIC the + button cannot change the value, so the confirming gesture a
        // pilot who departed and returned full would use is − then +. Both directions
        // must satisfy the flag or a full-tank confirmation would be impossible.
        await departWith(MAX_TIC);
        flyFor(2.0, 8.5);

        openFuelStop();
        tap('fo-left-minus'); tap('fo-left-plus');
        tap('fo-right-minus'); tap('fo-right-plus');
        expect(overlay._leftTic).toBe(MAX_TIC);
        expect(overlay._rightTic).toBe(MAX_TIC);

        await applyAndSettle();

        expect(applyRejected()).toBe(false);
        expect(tank().total).toBe(36);
    });

    it('still refuses RECORD from the same untouched reading', async () => {
        const departure = await departWith(MAX_TIC);
        const atStop = flyFor(2.0, 8.5);

        openFuelStop();
        overlay._dom.addGal.value = '12';
        overlay._dom.addAirport.value = 'KMYL';
        tap('fo-add-record');

        expect(overlay._dom.addStatus.className).toContain('fo-add-status-error');
        expect(tank().total).toBe(atStop.total);
        expect(tank().stampedAt).toBe(departure.stampedAt);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops') || '[]')).toHaveLength(0);
    });
});

describe('preflight APPLY is unchanged', () => {
    it('re-applies a restored, untouched reading (MORE → Fuel Entry)', async () => {
        await departWith(8);
        const restored = tank().total;
        FuelTankState._state = null;                    // prove APPLY is what writes it
        FuelTankState._loaded = true;

        openPreflight();
        expect(overlay._leftTic).toBe(8);               // restored, untouched
        await applyAndSettle();

        expect(tank().total).toBe(restored);
        expect(overlay.visible).toBe(false);
        expect(applyStatus()).toBe('');                 // no refusal message
    });
});

describe('the strict mode is per-show(), not sticky', () => {
    it('a fuel-stop show() does not leave later preflight shows strict', async () => {
        await departWith(8);
        openFuelStop();
        overlay.hide();

        FuelTankState._state = null;
        FuelTankState._loaded = true;
        openPreflight();                                // zero-arg → permissive again
        await applyAndSettle();

        expect(tank()).not.toBe(null);
        expect(applyRejected()).toBe(false);
    });

    it('a preflight show() does not leave a later fuel-stop show permissive', async () => {
        await departWith(MAX_TIC);
        openPreflight();
        overlay.hide();

        const atStop = flyFor(2.0, 8.5);
        openFuelStop();                                 // strict again
        await applyAndSettle();

        expect(applyRejected()).toBe(true);
        expect(tank().total).toBe(atStop.total);
        expect(tank().stampedAt).toBe(atStop.stampedAt);
    });

    it('clears a previous refusal message on the next show()', async () => {
        await departWith(MAX_TIC);
        flyFor(2.0, 8.5);
        openFuelStop();
        await applyAndSettle();
        expect(applyStatus()).not.toBe('');

        openFuelStop();
        expect(applyStatus()).toBe('');
    });
});

describe('structural contract with app.js', () => {
    it('_applyMeasurement gates on _requireFreshTics && !_ticsTouchedSinceShow', () => {
        const applyBody = FUEL_OVERLAY_SRC.slice(
            FUEL_OVERLAY_SRC.indexOf('    _applyMeasurement() {'),
            FUEL_OVERLAY_SRC.indexOf('    async _resolveEdmFuel()'));
        expect(applyBody).toMatch(/this\._requireFreshTics && !this\._ticsTouchedSinceShow/);
        // Before the write path: the guard must sit above the async resolve that performs
        // saveMeasurement() / FuelTankState.init(), or state is mutated then "refused".
        expect(applyBody.indexOf('this._requireFreshTics'))
            .toBeLessThan(applyBody.indexOf('_resolveEdmFuel()'));
        // …and above the re-entrancy latch, so a refusal cannot wedge it.
        expect(applyBody.indexOf('this._requireFreshTics'))
            .toBeLessThan(applyBody.indexOf('this._applying = true'));
    });

    it('show() takes opts and sets the mode every time, defaulting to permissive', () => {
        const showBody = FUEL_OVERLAY_SRC.slice(
            FUEL_OVERLAY_SRC.indexOf('    show(opts'),
            FUEL_OVERLAY_SRC.indexOf('    hide() {'));
        expect(showBody).toMatch(/this\._requireFreshTics = !!\(opts && opts\.requireFreshTics\)/);
        expect(showBody).toMatch(/this\._ticsTouchedSinceShow = false/);
        // Zero-arg callers (tab-bar.js, instrument-strip.js) must land on permissive.
        expect(FUEL_OVERLAY_SRC).toMatch(/show\(opts = \{\}\)/);
    });

    it('app.js passes requireFreshTics from the fuel-stop measure button only', () => {
        // The one call site inside _showFuelStopOverlay.
        const fsoBody = APP_SRC.slice(
            APP_SRC.indexOf('#fso-measure-btn'),
            APP_SRC.indexOf('#fso-continue-btn'));
        expect(fsoBody).toMatch(/this\.fuelOverlay\.show\(\{\s*requireFreshTics:\s*true\s*\}\)/);

        // No other show() call in app.js — a second, unflagged fuel-stop door would
        // reopen the hole.
        const allShows = APP_SRC.match(/fuelOverlay\.show\(/g) || [];
        expect(allShows).toHaveLength(1);
    });

    it('the preflight call sites still open the overlay with no argument', () => {
        // Passing the flag here would break the deliberate re-confirmation flow.
        expect(read('web/cockpit/tab-bar.js')).toMatch(/c\.fuelOverlay\.show\(\)/);
        expect(read('web/cockpit/instrument-strip.js')).toMatch(/_fuelOverlay\?\.show\(\)/);
    });
});
