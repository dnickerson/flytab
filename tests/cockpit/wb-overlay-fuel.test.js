/**
 * W&B overlay — fuel quantity source and confidence (SDD Task 15).
 *
 * The W&B panel pre-fills its Fuel station and then publishes a weight, a CG and an
 * IN/OUT ENVELOPE verdict off it. Before this change it read `FuelState.getStartFuel()`,
 * which never consults FuelTankState: measured on this branch, dry tracked tanks (0.0 gal)
 * and a normally tracked 18.0 gal BOTH pre-filled 36.0 gal — 216 lb of fuel that may not
 * be in the aircraft — and a tracked 10.0 gal with the EDM totalizer reading 30 pre-filled
 * 30.0.
 *
 * Contracts covered:
 *  1. The pre-fill comes from the canonical `FuelState.getCurrentFuel()` chain — the same
 *     read engine-page.js, instrument-strip.js and route-table.js use.
 *  2. A `capacity` source means nothing is tracked. The field is left EMPTY rather than
 *     fabricated at full tanks.
 *  3. Dry tracked tanks (0.0 gal) are a real reading and must not render as no-data.
 *  4. A blank fuel field makes the total weight read LOW — the one direction a W&B panel
 *     must never err in — so no in-envelope verdict is issued off it.
 *  5. A stale tracked figure is still shown but marked, and never renders in a reassuring
 *     colour (STALE-NEVER-GREEN) — badge, result values and the CG dot alike.
 *  6. The pilot's own entry is never overwritten and never marked stale.
 *
 * Everything below drives the REAL WbOverlay through the DOM its own _buildDOM() creates,
 * with the real WbCalculator and the real aircraft-config.json profile. The structural
 * block at the end pins that to the way app.js instantiates and mounts it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// Real implementations — the point is the contract between wb-overlay.js and the
// canonical fuel modules, so nothing on that path is faked.
globalThis.FuelEngine     = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState  = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState      = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
globalThis.WbCalculator   = new Function(read('web/shared/wb-calculator.js') + '\nreturn WbCalculator;')();
const WbOverlay = new Function(read('web/cockpit/wb-overlay.js') + '\nreturn WbOverlay;')();

const AC = JSON.parse(read('web/aircraft-config.json'));
const CAPACITY_GAL = AC.performance.fuel_capacity_gal;   // 36

let overlay = null;
let chartConfigs = [];

/**
 * Build the fuel world, then a real WbOverlay over the shipped aircraft profile.
 * `tankL: null` = FuelTankState loaded but never initialised (nothing tracked).
 */
function setup({ tankL = null, tankR = null, manual = null, measurement = null,
                 staleMinutes = 0, edmGal = null, rpm = 0, payload = {} } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    chartConfigs = [];

    globalThis.Settings = { fuelManualOverride: manual, fuelMeasurement: measurement };
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => {
            if (p === 'weight_balance') return AC.weight_balance;
            if (p === 'tail') return AC.tail || 'N194JT';
            if (p === 'performance.fuel_capacity_gal') return AC.performance.fuel_capacity_gal;
            return undefined;
        },
    };
    globalThis.wireTap = () => {};

    if (tankL === null) {
        FuelTankState._loaded = true;            // loaded, but nothing ever initialised
    } else {
        FuelTankState.init(tankL, tankR, 'L');
        if (staleMinutes > 0) {
            // Age the last integrated sample past FuelTankState.STALE_MS so
            // needsConfirmation() flips — the >45 min gap this panel must flag.
            FuelTankState._state.last_sample_at =
                new Date(Date.now() - staleMinutes * 60000).toISOString();
            FuelTankState._save();
        }
    }

    if (edmGal != null) {
        window.enginePanel = { lastData: { fuel_remaining_gal: edmGal, rpm }, lastPollTime: Date.now() };
    } else {
        delete window.enginePanel;
    }

    overlay = new WbOverlay(document.body);
    Object.entries(payload).forEach(([name, w]) => {
        if (overlay._inputs[name]) overlay._inputs[name].value = String(w);
    });
    overlay.show();
    return overlay;
}

/** Everything the pilot actually reads back off the panel. */
function rendered(o = overlay) {
    const items = [...o._el.querySelectorAll('.wb-result-item')].map(it => ({
        label: it.querySelector('.wb-result-label').textContent.trim(),
        el:    it.querySelector('.wb-result-value'),
    }));
    const pick = (label) => items.find(i => i.label === label)?.el;
    const badge = o._el.querySelector('.wb-envelope-badge');
    const notice = o._el.querySelector('.wb-fuel-notice');
    return {
        fuelValue:  o._fuelInput.value,
        weightText: pick('Total Weight').textContent.trim().replace(/\s+/g, ' '),
        weightCls:  pick('Total Weight').className,
        cgText:     pick('CG').textContent.trim(),
        cgCls:      pick('CG').className,
        badgeText:  badge ? badge.textContent.trim().replace(/\s+/g, ' ') : null,
        badgeCls:   badge ? badge.className : null,
        notice:     notice ? notice.textContent.trim() : null,
    };
}

/** Colour of the "Loaded CG" dot on the envelope chart. */
function cgDotColor() {
    const cfg = chartConfigs[chartConfigs.length - 1];
    return cfg.data.datasets[1].backgroundColor;
}

/** Simulate the pilot typing into a station field, including the real 'input' event. */
function type(input, value) {
    input.value = String(value);
    input.dispatchEvent(new window.Event('input'));
}

const SOLO = { Pilot: 200, Baggage: 30 };

beforeEach(() => {
    // Minimal Chart.js stand-in: records the config so the CG dot colour is assertable.
    window.Chart = class {
        constructor(canvas, config) { this.data = config.data; chartConfigs.push(config); }
        update() {}
        resize() {}
    };
});

afterEach(() => {
    if (overlay?._el) overlay._el.remove();
    overlay = null;
    document.body.innerHTML = '';
    delete window.Chart;
    delete window.enginePanel;
    delete globalThis.Settings;
    delete globalThis.CockpitConfig;
    delete globalThis.wireTap;
});

describe('WbOverlay fuel pre-fill — canonical source', () => {
    it('pre-fills the tracked tank total, not the EDM totalizer on the engine payload', () => {
        // Measured before this change: tracked 10.0 gal with the EDM reading 30 pre-filled
        // 30.0 — 120 lb of fuel the aircraft does not have.
        setup({ tankL: 5, tankR: 5, edmGal: 30, rpm: 2300, payload: SOLO });
        expect(rendered().fuelValue).toBe('10');
    });

    it('pre-fills the tracked total rather than full capacity', () => {
        // Measured before this change: a normally tracked 18.0 gal pre-filled 36.0.
        setup({ tankL: 9, tankR: 9, payload: SOLO });
        const r = rendered();
        expect(r.fuelValue).toBe('18');
        expect(r.fuelValue).not.toBe(String(CAPACITY_GAL));
    });

    it('honours a manual override ahead of tracked tank state', () => {
        setup({ tankL: 5, tankR: 5, manual: 22, payload: SOLO });
        expect(rendered().fuelValue).toBe('22');
    });

    it('follows integrated burn instead of freezing at the ramp figure', () => {
        // The pilot opens W&B on the ramp, closes it, and re-opens it after some burn.
        // An untouched pre-fill must re-read the canonical source, not sit on 18.0.
        setup({ tankL: 9, tankR: 9, payload: SOLO });
        expect(rendered().fuelValue).toBe('18');
        overlay.hide();
        // onSample caps dt at MAX_SAMPLE_DT_MS (10 s), so burn 1.0 gal as ten in-cap samples.
        const t0 = Date.now();
        for (let i = 1; i <= 10; i++) FuelTankState.onSample(36, t0 + i * 10000);
        overlay.show();
        expect(rendered().fuelValue).toBe('17');
    });
});

describe('WbOverlay fuel pre-fill — nothing tracked must not become full tanks', () => {
    it('leaves the fuel field empty, never capacity, when nothing is tracked', () => {
        setup({ tankL: null, payload: SOLO });
        // FuelState.getCurrentFuel() reports { gallons: 36, source: 'capacity' } here.
        const r = rendered();
        expect(r.fuelValue).toBe('');
        expect(r.fuelValue).not.toBe(String(CAPACITY_GAL));
    });

    it('leaves it empty when FuelState is unavailable entirely', () => {
        const saved = globalThis.FuelState;
        globalThis.FuelState = undefined;
        try {
            setup({ tankL: 9, tankR: 9, payload: SOLO });
            expect(rendered().fuelValue).toBe('');
        } finally {
            globalThis.FuelState = saved;
        }
    });

    it('renders genuinely dry tracked tanks as a real zero, not as no-data', () => {
        setup({ tankL: 0, tankR: 0, payload: SOLO });
        const dry = rendered();
        expect(dry.fuelValue).toBe('0');
        expect(dry.notice).toBeNull();
        expect(dry.badgeCls).toContain('in-envelope');

        overlay._el.remove(); document.body.innerHTML = '';
        setup({ tankL: null, payload: SOLO });
        expect(rendered().fuelValue).not.toBe(dry.fuelValue);
    });
});

describe('WbOverlay — a blank fuel field must not read as a lighter aeroplane', () => {
    // With no fuel entered the total weight EXCLUDES fuel and reads LOW, and the CG sits
    // off the fuel arm. That is the reassuring-but-wrong direction, so the panel must
    // refuse to issue an in-envelope verdict and must mark the figures it does show.
    it('issues no in-envelope verdict when the fuel quantity is unknown', () => {
        const r = setup({ tankL: null, payload: SOLO }) && rendered();
        expect(r.badgeText).toBe('NO VERDICT — ENTER FUEL QUANTITY');
        expect(r.badgeCls).not.toContain('in-envelope');
        expect(r.badgeCls).toContain('wb-envelope-unconfirmed');
    });

    it('names the missing fuel in a caution notice', () => {
        setup({ tankL: null, payload: SOLO });
        expect(rendered().notice).toContain('FUEL NOT ENTERED');
    });

    it('marks the fuel-less total weight and CG rather than presenting them as measured', () => {
        const r = setup({ tankL: null, payload: SOLO }) && rendered();
        expect(r.weightText).toBe('1,264? lb');       // 1034 empty + 200 pilot + 30 bag, no fuel
        expect(r.weightCls).toContain('wb-unconfirmed');
        expect(r.cgText).toBe('80.01?"');
        expect(r.cgCls).toContain('wb-unconfirmed');
    });

    it('does not colour the CG dot green with no fuel figure behind it', () => {
        setup({ tankL: null, payload: SOLO });
        expect(cgDotColor()).not.toBe('#1a8c35');
        expect(cgDotColor()).toBe('#b87000');          // --color-caution, light theme
    });

    it('leaves the empty-aircraft placeholder alone when nothing at all is entered', () => {
        setup({ tankL: null });
        const r = rendered();
        expect(r.badgeText).toBe('Enter weights to compute');
        expect(r.notice).toBeNull();
    });
});

describe('WbOverlay — stale tracked fuel is marked, never reassuring', () => {
    it('still pre-fills the figure but flags it unconfirmed', () => {
        setup({ tankL: 9, tankR: 9, staleMinutes: 60, payload: SOLO });
        expect(FuelTankState.needsConfirmation()).toBe(true);
        const r = rendered();
        expect(r.fuelValue).toBe('18');                        // information kept
        expect(r.notice).toContain('FUEL QUANTITY UNCONFIRMED');
        expect(r.weightText).toBe('1,372? lb');
        expect(r.weightCls).toContain('wb-unconfirmed');
        expect(r.cgCls).toContain('wb-unconfirmed');
    });

    it('never shows the green in-envelope badge off a stale figure', () => {
        const r = setup({ tankL: 9, tankR: 9, staleMinutes: 60, payload: SOLO }) && rendered();
        expect(r.badgeText).toBe('IN ENVELOPE — UNCONFIRMED FUEL');
        expect(r.badgeCls).toContain('wb-envelope-unconfirmed');
        expect(r.badgeCls).not.toContain('in-envelope');
    });

    it('never shows the green CG dot off a stale figure', () => {
        setup({ tankL: 9, tankR: 9, staleMinutes: 60, payload: SOLO });
        expect(cgDotColor()).not.toBe('#1a8c35');
        expect(cgDotColor()).toBe('#b87000');
    });

    it('keeps the danger colour when a stale loading is also out of envelope', () => {
        // Red is not a reassuring colour — an exceedance must not be softened to amber.
        setup({ tankL: 9, tankR: 9, staleMinutes: 60, payload: { Pilot: 400, Passenger: 400, Baggage: 50 } });
        const r = rendered();
        expect(r.badgeText).toContain('OUT OF ENVELOPE');
        expect(r.badgeCls).toContain('out-of-envelope');
        expect(cgDotColor()).toBe('#cc2222');
    });

    it('shows no marking for a fresh tracked state', () => {
        const r = setup({ tankL: 9, tankR: 9, payload: SOLO }) && rendered();
        expect(FuelTankState.needsConfirmation()).toBe(false);
        expect(r.notice).toBeNull();
        expect(r.badgeText).toBe('IN ENVELOPE');
        expect(r.badgeCls).toContain('in-envelope');
        expect(r.weightCls).not.toContain('wb-unconfirmed');
        expect(cgDotColor()).toBe('#1a8c35');
    });

    it('shows no marking for a manual override even while tank state is stale', () => {
        // A manual override is what the pilot just typed, not a tracked-and-aged figure.
        const r = setup({ tankL: 9, tankR: 9, manual: 22, staleMinutes: 60, payload: SOLO }) && rendered();
        expect(r.fuelValue).toBe('22');
        expect(r.notice).toBeNull();
        expect(r.badgeCls).toContain('in-envelope');
    });
});

describe("WbOverlay — the pilot's own entry wins and is not marked", () => {
    it('clears the unconfirmed marking as soon as the pilot types a fuel quantity', () => {
        setup({ tankL: 9, tankR: 9, staleMinutes: 60, payload: SOLO });
        expect(rendered().notice).toContain('FUEL QUANTITY UNCONFIRMED');
        type(overlay._fuelInput, 24);
        const r = rendered();
        expect(r.notice).toBeNull();
        expect(r.badgeCls).toContain('in-envelope');
        expect(r.weightCls).not.toContain('wb-unconfirmed');
    });

    it('does not overwrite a typed quantity when the overlay is re-opened', () => {
        setup({ tankL: 9, tankR: 9, payload: SOLO });
        type(overlay._fuelInput, 24);
        overlay.hide();
        overlay.show();
        expect(rendered().fuelValue).toBe('24');
    });

    it('lets the pilot supply the fuel figure the tracker does not have', () => {
        setup({ tankL: null, payload: SOLO });
        expect(rendered().badgeText).toBe('NO VERDICT — ENTER FUEL QUANTITY');
        type(overlay._fuelInput, 30);
        const r = rendered();
        expect(r.notice).toBeNull();
        expect(r.badgeText).toBe('IN ENVELOPE');
        expect(r.weightText).toBe('1,444 lb');          // 1264 + 30 gal * 6 lb/gal
    });

    it('treats a pilot-typed 0 as an answer, not as a missing quantity', () => {
        setup({ tankL: null, payload: SOLO });
        type(overlay._fuelInput, 0);
        const r = rendered();
        expect(r.notice).toBeNull();
        expect(r.badgeText).toBe('IN ENVELOPE');
    });
});

describe('WbOverlay — the DOM and CSS under test are what the app actually ships', () => {
    it('app.js constructs WbOverlay and mounts it on document.body', () => {
        const src = read('web/app.js');
        expect(src).toContain('new WbOverlay(document.body)');
    });

    it('uses the fuel weight constant from aircraft-config.json, not a literal', () => {
        // 36 gal at the configured 6 lb/gal = 216 lb of difference between a real and a
        // fabricated fuel figure. wb-calculator reads gal_to_lbs from the profile.
        const fuelStation = AC.weight_balance.stations.find(s => s.fuel);
        expect(fuelStation.gal_to_lbs).toBe(6);
        expect(read('web/cockpit/wb-overlay.js')).not.toMatch(/\*\s*6(\.0)?\s*;/);
    });

    it('every class the overlay emits is actually styled in style.css', () => {
        // Task 14 found .fuel-* rules keyed on --status-warn/--status-err, custom properties
        // that are never defined, so the warnings rendered identically to safe values.
        const css = read('web/style.css');
        for (const sel of ['.wb-fuel-notice', '.wb-envelope-badge.wb-envelope-unconfirmed',
                           '.wb-result-value.wb-unconfirmed']) {
            expect(css).toContain(sel + ' {');
        }
    });

    it('the custom properties those rules reference are defined', () => {
        const css = read('web/style.css');
        expect(css).toMatch(/--color-caution:\s*#/);
        expect(css).toMatch(/--color-danger:\s*#/);
        expect(css).toMatch(/--color-success:\s*#/);
    });

    it('an over-gross weight keeps the danger colour even when unconfirmed', () => {
        // Equal specificity — .wb-unconfirmed must be declared BEFORE .wb-over-gross so the
        // more severe colour wins the cascade.
        const css = read('web/style.css');
        expect(css.indexOf('.wb-result-value.wb-unconfirmed {'))
            .toBeLessThan(css.indexOf('.wb-result-value.wb-over-gross {'));
        const r = setup({ tankL: 9, tankR: 9, staleMinutes: 60,
                          payload: { Pilot: 400, Passenger: 400, Baggage: 50 } }) && rendered();
        expect(r.weightCls).toContain('wb-over-gross');
        expect(r.weightCls).toContain('wb-unconfirmed');
    });
});
