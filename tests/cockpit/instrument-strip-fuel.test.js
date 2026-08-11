/**
 * Instrument Strip — FUEL field (SDD Task 17).
 *
 * This is the fuel figure the pilot actually reads in flight: the bottom strip
 * app.js mounts on every launch. It was never migrated to the canonical fuel
 * chain — it read the raw EDM totalizer first and fell through to
 * FuelState.getStartFuel(), i.e. full tank capacity, when nothing was tracked.
 *
 * Contracts covered:
 *  1. The FUEL value comes from FuelState.getCurrentFuel() — manual override >
 *     tracked FuelTankState — not from whatever raw EDM field happens to be on
 *     the engine poll payload.
 *  2. A `capacity` source means nothing is tracked. It is a planning default, not
 *     a measurement, and must render as no-data — never as full tanks.
 *  3. Dry tracked tanks (0.0 gal) are a real reading and must not render the same
 *     as no-data.
 *  4. A stale tracked figure (FuelTankState.needsConfirmation()) is still shown but
 *     marked unconfirmed, the same decision engine-page.js implements in Task 12.
 *
 * Everything below drives the REAL InstrumentStrip through its real init() DOM and
 * its real event wiring — no hand-built fixture markup. The structural test in the
 * last block pins that DOM to what app.js actually instantiates and mounts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// Real implementations — the point of these tests is the contract between
// instrument-strip.js and the canonical fuel modules, so nothing here is faked.
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const InstrumentStrip = new Function(read('web/cockpit/instrument-strip.js') + '\nreturn InstrumentStrip;')();

const CAPACITY_GAL = 36;   // web/aircraft-config.json performance.fuel_capacity_gal

let strip = null;
let engineClient = null;

/**
 * Build a real InstrumentStrip over a given fuel world.
 * `tankL: null` = FuelTankState loaded but never initialised (nothing tracked).
 */
function setup({ tankL = null, tankR = null, manual = null,
                 capacityGal = CAPACITY_GAL, staleMinutes = 0,
                 fields = null, noFuelState = false } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;

    globalThis.Settings = { fuelManualOverride: manual, fuelMeasurement: null };
    globalThis.CockpitConfig = {
        get: (k) => (k === 'instrumentStrip' ? { fields: fields || ['gs', 'alt', 'hdg', 'fuel', 'dest', 'ete'] } : null),
        aircraft: (path) => (path === 'performance.fuel_capacity_gal' ? capacityGal : undefined),
    };

    if (tankL === null) {
        FuelTankState._loaded = true;      // loaded, but nothing ever initialised
    } else {
        FuelTankState.init(tankL, tankR, 'L');
        if (staleMinutes > 0) {
            // Age the last integrated sample past FuelTankState.STALE_MS so
            // needsConfirmation() flips — the >45 min gap this field must flag.
            FuelTankState._state.last_sample_at =
                new Date(Date.now() - staleMinutes * 60000).toISOString();
            FuelTankState._save();
        }
    }

    if (noFuelState) globalThis.FuelState = undefined;

    // Real event plumbing: app.js passes the StratuxClient and the EngineClient,
    // both EventTargets, and mounts whatever init() returns.
    const stratux = new EventTarget();
    engineClient = new EventTarget();
    strip = new InstrumentStrip(stratux, engineClient);
    const el = strip.init();
    document.body.appendChild(el);
    return el;
}

/** Push one engine poll through the same event the Pi client fires, read the FUEL field back. */
function fuelField(engData = {}) {
    window.enginePanel = { lastData: engData, lastPollTime: Date.now() };
    engineClient.dispatchEvent(new CustomEvent('engine:data', { detail: engData }));
    const valueEl = strip._el.querySelector('.is-field[data-field="fuel"] .is-value');
    return {
        text: valueEl.textContent,
        className: valueEl.className,
        unconfirmed: valueEl.classList.contains('is-unconfirmed'),
    };
}

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
});

afterEach(() => {
    if (strip) strip.destroy();
    strip = null;
    engineClient = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    delete window.enginePanel;
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
});

describe('InstrumentStrip FUEL — canonical fuel source', () => {
    it('shows tracked tank state, not the EDM totalizer on the poll payload', () => {
        setup({ tankL: 5, tankR: 5 });
        // Measured before this migration: tracked 10.0 gal with the EDM reading 30
        // displayed 30.0 — 20 gal of fuel the aircraft does not have.
        const out = fuelField({ fuel_remaining_gal: 30, Gallons_Rem: 30, Fuel_Remaining: 30 });
        expect(out.text).toBe('10.0');
    });

    it('ignores every raw EDM fuel field name the old chain accepted', () => {
        setup({ tankL: 6, tankR: 6 });
        for (const key of ['fuel_remaining_gal', 'fuel_gal', 'Gallons_Rem', 'Fuel_Remaining']) {
            expect(fuelField({ [key]: 33 }).text).toBe('12.0');
        }
    });

    it('honours a manual override ahead of tracked tank state', () => {
        setup({ tankL: 5, tankR: 5, manual: 22 });
        expect(fuelField({ Fuel_Remaining: 30 }).text).toBe('22.0');
    });

    it('follows integrated burn rather than a number cached at first render', () => {
        setup({ tankL: 9, tankR: 9 });
        expect(fuelField({}).text).toBe('18.0');
        // onSample caps dt at MAX_SAMPLE_DT_MS (10 s), so burn 1.0 gal as ten
        // in-cap samples of 36 gph rather than one giant jump.
        const t0 = Date.now();
        for (let i = 1; i <= 10; i++) FuelTankState.onSample(36, t0 + i * 10000);
        expect(fuelField({}).text).toBe('17.0');
    });

    it('updates on fueltankstate:changed without an engine poll', () => {
        // FuelTankState fires 'fueltankstate:changed', not 'fuelstate:changed'. If the
        // strip listened only to the latter it would sit on a stale figure whenever the
        // engine client was disconnected and the pilot edited tanks.
        const el = setup({ tankL: 9, tankR: 9 });
        const value = () => el.querySelector('.is-field[data-field="fuel"] .is-value').textContent;
        expect(fuelField({}).text).toBe('18.0');
        FuelTankState.topOff('L', 4);       // fires fueltankstate:changed
        expect(value()).toBe('22.0');
    });

    it('updates on the fuel overlay fuelstate:changed event', () => {
        const el = setup({ tankL: 9, tankR: 9 });
        expect(fuelField({}).text).toBe('18.0');
        Settings.fuelManualOverride = 25;   // what the overlay SET button does
        window.dispatchEvent(new CustomEvent('fuelstate:changed'));
        expect(el.querySelector('.is-field[data-field="fuel"] .is-value').textContent).toBe('25.0');
    });
});

describe('InstrumentStrip FUEL — nothing tracked must not become full tanks', () => {
    it('shows the no-data placeholder, never capacity, when nothing is tracked', () => {
        setup({ tankL: null });
        // FuelState.getCurrentFuel() reports { gallons: 36, source: 'capacity' } here.
        const out = fuelField({ Fuel_Remaining: 30, fuel_flow: 9 });
        expect(out.text).toBe('—');
        expect(out.text).not.toBe(CAPACITY_GAL.toFixed(1));
    });

    it('does not show a differently configured capacity either', () => {
        setup({ tankL: null, capacityGal: 40 });
        const out = fuelField({});
        expect(out.text).toBe('—');
        expect(out.text).not.toBe('40.0');
    });

    it('shows the no-data placeholder when FuelState is unavailable', () => {
        setup({ tankL: 9, tankR: 9, noFuelState: true });
        expect(fuelField({ Fuel_Remaining: 30 }).text).toBe('—');
    });

    it('carries no unconfirmed marking in the no-data state', () => {
        setup({ tankL: null });
        const out = fuelField({});
        expect(out.className).toBe('is-value');
    });
});

describe('InstrumentStrip FUEL — dry tanks vs nothing tracked', () => {
    it('renders genuinely dry tracked tanks as a real zero', () => {
        setup({ tankL: 0, tankR: 0 });
        expect(fuelField({ Fuel_Remaining: 30 }).text).toBe('0.0');
    });

    it('does not render dry tanks the same as nothing tracked', () => {
        setup({ tankL: 0, tankR: 0 });
        const dry = fuelField({});
        strip.destroy(); document.body.innerHTML = '';
        setup({ tankL: null });
        const untracked = fuelField({});
        expect(dry.text).not.toBe(untracked.text);
    });
});

describe('InstrumentStrip FUEL — stale tracked state is marked, not silently shown', () => {
    // Same decision as engine-page.js (Task 12): keep the number — blanking discards
    // the pilot's last known-good quantity — but flag it, because a >45-minute-old
    // integrated figure reads HIGH by whatever was burned during the gap.
    it('still shows the figure but flags it unconfirmed when FuelTankState is stale', () => {
        setup({ tankL: 9, tankR: 9, staleMinutes: 60 });
        expect(FuelTankState.needsConfirmation()).toBe(true);
        const out = fuelField({});
        expect(out.text).toBe('18.0?');              // information kept
        expect(out.unconfirmed).toBe(true);          // but marked
        expect(out.className).toBe('is-value is-unconfirmed');
    });

    it('shows no unconfirmed marking for a fresh tracked state', () => {
        setup({ tankL: 9, tankR: 9 });
        expect(FuelTankState.needsConfirmation()).toBe(false);
        const out = fuelField({});
        expect(out.text).toBe('18.0');
        expect(out.unconfirmed).toBe(false);
        expect(out.className).toBe('is-value');
    });

    it('shows no unconfirmed marking for a manual override', () => {
        // A manual override is what the pilot just typed in, not a tracked-and-aged
        // figure. Staleness is a FuelTankState property only.
        setup({ tankL: 9, tankR: 9, manual: 22, staleMinutes: 60 });
        const out = fuelField({});
        expect(out.text).toBe('22.0');
        expect(out.unconfirmed).toBe(false);
    });

    it('clears the unconfirmed marking once the tank state is confirmed again', () => {
        setup({ tankL: 9, tankR: 9, staleMinutes: 60 });
        expect(fuelField({}).unconfirmed).toBe(true);
        FuelTankState.markConfirmed();               // pilot confirms
        expect(fuelField({}).unconfirmed).toBe(false);
        expect(fuelField({}).text).toBe('18.0');
    });
});

describe('InstrumentStrip FUEL — the DOM under test is the DOM app.js mounts', () => {
    // A Task 13 fixture hand-built #ns-* elements no mounted component ever creates,
    // letting 16 green tests certify a display that renders nothing. These assertions
    // pin the selectors above to the element InstrumentStrip.init() returns AND to the
    // way app.js instantiates and mounts it.
    it('init() returns the #is-container element with a FUEL field', () => {
        const el = setup({ tankL: 9, tankR: 9 });
        expect(el.id).toBe('is-container');
        const field = el.querySelector('.is-field[data-field="fuel"]');
        expect(field).not.toBeNull();
        expect(field.querySelector('.is-label').textContent).toBe('FUEL');
        expect(field.querySelector('.is-unit').textContent).toBe('gal');
        expect(field.querySelector('.is-value')).not.toBeNull();
    });

    it('renders the fuel field for the shipped cockpit-config field list', () => {
        // web/cockpit-config.json instrumentStrip.fields
        const cfg = JSON.parse(read('web/cockpit-config.json'));
        const shipped = cfg.instrumentStrip.fields;
        expect(shipped).toContain('fuel');
        setup({ tankL: 9, tankR: 9, fields: shipped });
        expect(fuelField({}).text).toBe('18.0');
    });

    it('app.js constructs InstrumentStrip and mounts what init() returns', () => {
        const src = read('web/app.js');
        expect(src).toContain('new InstrumentStrip(this.stratuxClient, this.engineClient)');
        expect(src).toContain('const stripEl = this.instrumentStrip.init()');
        expect(src).toContain('wrapper.appendChild(stripEl)');
    });
});
