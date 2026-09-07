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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    // The flight-CSV EDM lookup (_resolveEdmFuel(), localhost:9090) stays offline —
    // these guard tests don't exercise EDM resolution and rely on it resolving to
    // null. The Pi fuel-sync endpoints (fuel-overlay.js's _syncFuelSetToEngine /
    // _syncFuelAddToEngine) are mocked reachable-and-successful instead: since
    // Pi-sync outcome is now surfaced (rather than swallowed — see
    // fuel-overlay-set-add-sync.test.js for the outcome-reporting contract itself),
    // a real "offline" mock here would make every guard-accepted reading also
    // report a Pi-sync failure, which is not what these tests are checking.
    window.engineClient = { ip: '192.168.1.50' };
    realFetch = globalThis.fetch;
    globalThis.fetch = (url) => (typeof url === 'string' && url.includes('localhost:9090'))
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, status: 200 });
    globalThis.wireTap = (el, fn) => { if (el) el.addEventListener('click', fn); };

    overlay = new FuelOverlay(document.body);
});

afterEach(() => {
    overlay?._el?.remove();
    overlay = null;
    globalThis.fetch = realFetch;
    delete window.engineClient;
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

/** Fill in the gallons-purchased field, tap RECORD FUEL STOP, and let its promise
 *  chain settle (_recordFuelStop() is async — it awaits the Pi sync outcome
 *  before writing status). */
async function recordStop(gallons = 12) {
    overlay._dom.addGal.value = String(gallons);
    overlay._dom.addAirport.value = 'KMYL';
    tap('fo-add-record');
    await new Promise(r => setTimeout(r, 20));
}

/* ------------------------------------------------------------------ tests */

describe('fuel stop record — requires a reading entered this session', () => {
    it('refuses the restored departure reading when no tic control was touched', async () => {
        const departure = departWith(MAX_TIC);       // departed full: 36.0 gal
        expect(departure.total).toBe(36);

        open();
        // This is the trap: the sliders come back up already showing the departure value.
        expect(overlay._leftTic).toBe(MAX_TIC);
        expect(overlay._rightTic).toBe(MAX_TIC);

        await recordStop(12);

        expect(rejected()).toBe(true);
        expect(status()).toMatch(/tic-mark reading/i);
        // Nothing mutated: neither the gallons nor — critically — the timestamp the
        // fuel-stop overlay's Continue gate compares against overlayShownAt.
        expect(tank().total).toBe(36);
        expect(tank().stampedAt).toBe(departure.stampedAt);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops') || '[]')).toHaveLength(0);
    });

    it('records the pilot’s own reading, and writes THAT figure to tank state', async () => {
        departWith(MAX_TIC);                          // departed 36.0 gal
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);

        await recordStop(12);

        expect(rejected()).toBe(false);
        expect(status()).toMatch(/Recorded:/);
        // 26.0 gal, not the 36.0 gal he departed with.
        expect(tank().total).toBe(26);
        expect(tank().total).not.toBe(36);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops'))).toHaveLength(1);
    });

    it('accepts a reading that legitimately equals the restored one, once confirmed', async () => {
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

        await recordStop(8);

        expect(rejected()).toBe(false);
        // Same figure, correctly recorded. Not bit-identical to `before` only because
        // _applyMeasurement() inits from the per-tank gallons createMeasurement() has
        // already rounded to 0.1, while _recordFuelStop() inits from raw ticToGallons —
        // a pre-existing 0.1 gal difference between the two write paths, not a guard
        // effect. Pin both: the exact raw figure, and that it is the departure figure.
        expect(tank().total).toBe(+(FuelEngine.ticToGallons(8, overlay._coefficients) * 2).toFixed(1));
        expect(Math.abs(tank().total - before)).toBeLessThan(0.15);
    });

    it('counts the number field as entering the reading', async () => {
        departWith(MAX_TIC);
        const d = open();
        type(d.leftInput, 5);
        type(d.rightInput, 5);

        await recordStop(10);

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
        it(`accepts a reading entered with the ${label} alone`, async () => {
            departWith(8);
            const d = open();
            touch(d);

            await recordStop(10);

            expect(rejected()).toBe(false);
            expect(status()).toMatch(/Recorded:/);
            expect(tank().total).toBe(
                +(FuelEngine.ticToGallons(overlay._leftTic, overlay._coefficients)
                + FuelEngine.ticToGallons(overlay._rightTic, overlay._coefficients)).toFixed(1));
        });
    });

    it('starts every show() untouched — a reading entered before a hide does not carry over', async () => {
        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);
        overlay.hide();

        open();                                        // second session, nothing touched
        await recordStop(12);

        expect(rejected()).toBe(true);
        expect(tank().total).toBe(36);                 // still the departure figure
    });

    it('consumes the reading — a second RECORD tap needs its own measurement', async () => {
        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);

        await recordStop(12);
        expect(rejected()).toBe(false);
        const afterFirst = tank();

        await recordStop(12);                          // double tap / second pump
        expect(rejected()).toBe(true);
        expect(tank().stampedAt).toBe(afterFirst.stampedAt);
        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops'))).toHaveLength(1);
    });

    it('refuses a second RECORD tap fired before the first Pi sync settles (double-tap race)', async () => {
        // Regression test for the async-conversion race: _recordFuelStop() now awaits
        // a real network round trip (_syncFuelAddToEngine, up to 4000ms) before clearing
        // _ticsTouchedSinceShow and the add* fields. Without a re-entrancy guard set
        // BEFORE that await, a second tap fired while the Pi is slow to respond would
        // sail past every guard — addGal.value unchanged, _ticsTouchedSinceShow still
        // true — and append a second flytab_fuel_stops entry plus a second
        // /api/fuel/add call, double-adding gallons to the Pi's authoritative total.
        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 6);
        drag(d.rightSlider, 6);

        // Simulate a slow Pi: /api/fuel/add doesn't resolve for 50ms.
        globalThis.fetch = vi.fn((url) => (typeof url === 'string' && url.includes('localhost:9090'))
            ? Promise.reject(new Error('offline'))
            : new Promise(resolve => setTimeout(() => resolve({ ok: true, status: 200 }), 50)));

        overlay._dom.addGal.value = '12';
        overlay._dom.addAirport.value = 'KMYL';
        // Fire two taps back-to-back, with no await between them — the async function
        // only yields at the fetch await, so the second tap's guard check runs
        // synchronously against the flag the first tap already set.
        tap('fo-add-record');
        tap('fo-add-record');

        await new Promise(r => setTimeout(r, 80));

        expect(JSON.parse(localStorage.getItem('flytab_fuel_stops'))).toHaveLength(1);
        const addCalls = globalThis.fetch.mock.calls
            .filter(([url]) => typeof url === 'string' && url.includes('/api/fuel/add'));
        expect(addCalls).toHaveLength(1);
        expect(overlay._recording).toBe(false);   // latch cleared, not wedged
    });

    it('still refuses 0/0 after the controls were touched — ticToGallons(0) is not zero', async () => {
        // The reason a computed-gallons check cannot stand in for this guard.
        expect(FuelEngine.ticToGallons(0, overlay._coefficients)).toBeGreaterThan(2);

        departWith(MAX_TIC);
        const d = open();
        drag(d.leftSlider, 0);
        drag(d.rightSlider, 0);

        await recordStop(12);

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
            // show(opts = {}) since the APPLY guard — see fuel-overlay-apply-guard.test.js.
            FUEL_OVERLAY_SRC.indexOf('    show(opts'),
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
