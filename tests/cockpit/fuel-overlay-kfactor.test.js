/**
 * K-factor calculator: which legs count (final-review I1/I2, Rulings 15/16).
 *
 * A leg (prev measurement → next measurement) counts only when:
 *  - next carries the tracking fields (tracked_since …); older entries are excluded,
 *  - next.tracked_since is the FuelTankState init that prev's APPLY TIC / RECORD FUEL
 *    STOP created (no widget SET or recovery CONFIRM re-init in between),
 *  - next's tracked figure was not stale (UNCONFIRMED),
 *  - tracked burn (flow only: applied dropped-burn corrections are added back) is
 *    within 25 % of actual burn.
 * Excluded legs are counted and named in the panel. The New K-Factor guidance is
 * shown only once Σactual ≥ 30 gal.
 *
 * Drives the real FuelOverlay through its DOM and the real FuelTankState; burn is
 * integrated by FuelTankState.onSample on a fake clock.
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
let NOW = 0;

const $ = (id) => overlay._el.querySelector('#' + id);
const tap = (id) => $(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
function drag(el, tic) { el.value = String(tic); el.dispatchEvent(new window.Event('input')); }
function open() { overlay.show(); overlay._shownAt = 0; return overlay._dom; }
const history = () => JSON.parse(localStorage.getItem('flypi_fuel_history') || '[]');
const at = (ms) => { NOW = ms; vi.setSystemTime(NOW); };

/** Burn `gal` gallons through FuelTankState.onSample at `gph`, one sample per 10 s. */
function fly(gal, gph = 10) {
    const steps = Math.round(gal / (gph * 10 / 3600));
    for (let i = 0; i < steps; i++) { at(NOW + 10000); FuelTankState.onSample(gph, NOW); }
}
function applyTic(l, r) {
    at(NOW + 1000);
    const d = open();
    drag(d.leftSlider, l); drag(d.rightSlider, r);
    tap('fo-apply');
}
function recordStop(l, r, gallons) {
    at(NOW + 1000);
    const d = open();
    drag(d.leftSlider, l); drag(d.rightSlider, r);
    d.addGal.value = String(gallons);
    tap('fo-add-record');
    expect(d.addStatus.className).toContain('fo-add-status-ok');
    overlay.hide();
}
function panel() {
    open();
    return {
        filled: $('fo-kf-filled').textContent,
        used: $('fo-kf-used').textContent,
        ratio: $('fo-kf-ratio').textContent,
        guidance: $('fo-kf-guidance').textContent,
        excluded: $('fo-kf-excluded').textContent,
        excludedShown: $('fo-kf-excluded').style.display !== 'none',
    };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(Date.UTC(2026, 10, 1, 15, 0));
    localStorage.clear();
    Settings.fuelMeasurement = null;
    Settings.fuelManualOverride = null;
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => {
            if (p === 'tic_polynomial') return AC.tic_polynomial;
            if (p === 'performance.fuel_capacity_gal') return AC.performance.fuel_capacity_gal;
            return undefined;
        },
    };
    window.engineClient = { ip: '192.168.1.50' };
    delete window.enginePanel;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')));
    globalThis.wireTap = (el, fn) => { if (el) el.addEventListener('click', fn); };
    overlay = new FuelOverlay(document.body);
});

afterEach(() => {
    overlay?._el?.remove();
    overlay = null;
    vi.useRealTimers();
    delete window.engineClient;
});

describe('measurement record carries the tracking fields', () => {
    it('tracked_since / tank_init_at / tracked_stale / dropped_applied_since_init_gal', () => {
        FuelTankState.init(18, 18, 'L');
        const firstInit = FuelTankState.getState().initialized_at;
        applyTic(11, 11);
        const h0 = history()[0];
        expect(h0.tracked_since).toBe(firstInit);
        expect(h0.tracked_stale).toBe(false);
        expect(h0.dropped_applied_since_init_gal).toBe(0);
        // The init this APPLY created, read after FuelTankState.init().
        expect(h0.tank_init_at).toBe(FuelTankState.getState().initialized_at);
        expect(h0.tank_init_at).not.toBe(firstInit);
    });

    it('nothing tracked: tracked_since null, tracked_stale null', () => {
        applyTic(6, 6);
        const h0 = history()[0];
        expect(h0.tracked_gal).toBeNull();
        expect(h0.tracked_since).toBeNull();
        expect(h0.tracked_stale).toBeNull();
        expect(h0.tank_init_at).toBe(FuelTankState.getState().initialized_at);
    });
});

describe('clean legs count', () => {
    it('APPLY → fly → RECORD FUEL STOP → fly → APPLY: both legs, Σactual ≥ 30 shows the guidance', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);            // 36.0
        fly(17.0);                   // tracked 19.0
        recordStop(10, 10, 14.2);    // 34.1 after 14.2 pumped: actual 16.1, tracked 17.0
        fly(15.0);                   // tracked 19.1
        applyTic(4, 4);              // 19.8: actual 14.3, tracked 15.0

        const p = panel();
        expect(p.filled).toBe('30.4 gal');
        expect(p.used).toBe('32.0 gal');
        expect(p.ratio).toBe('1.053');
        expect(p.guidance).toMatch(/New K-Factor = Current K-Factor × 1\.053\s+\(increase K-factor/);
        expect(p.excludedShown).toBe(false);
    });
});

describe('I2: no guidance below 30 gal of actual burn', () => {
    it('16.1 gal: ratio shown, guidance replaced by "needs more data (16.1 of 30 gal)"', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);
        fly(17.0);
        recordStop(10, 10, 14.2);

        const p = panel();
        expect(p.ratio).toBe('1.056');
        expect(p.guidance).not.toMatch(/New K-Factor/);
        expect(p.guidance).not.toMatch(/increase|decrease/);
        expect(p.guidance).toMatch(/needs more data \(16\.1 of 30 gal\)/i);
    });

    it('exactly 30.0 gal shows the guidance', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            { measured_at: '2026-11-01T12:00:00Z', total_gal: 35.0, tracked_gal: 30.0, tracked_since: 'i0', tank_init_at: 'i1', tracked_stale: false, dropped_applied_since_init_gal: 0 },
            { measured_at: '2026-11-01T13:00:00Z', total_gal: 20.0, tracked_gal: 21.0, tracked_since: 'i1', tank_init_at: 'i2', tracked_stale: false, dropped_applied_since_init_gal: 0 },
            { measured_at: '2026-11-01T14:00:00Z', total_gal: 5.0,  tracked_gal: 6.0,  tracked_since: 'i2', tank_init_at: 'i3', tracked_stale: false, dropped_applied_since_init_gal: 0 },
        ]));
        const p = panel();
        expect(p.filled).toBe('30.0 gal');
        expect(p.used).toBe('28.0 gal');
        expect(p.guidance).toMatch(/New K-Factor = Current K-Factor × 0\.933\s+\(decrease K-factor/);
    });
});

describe('I1: garbage legs are excluded and counted', () => {
    it('partial top-off recorded with APPLY TIC (not RECORD FUEL STOP): outlier gate', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(8, 8);              // 31.1
        fly(16.0);                   // tracked 15.2
        // ~8 gal pumped, but the pilot taps APPLY TIC instead of RECORD FUEL STOP.
        applyTic(5.5, 5.5);          // 24.4: actual 6.7, tracked 15.9 → ratio 2.37

        const p = panel();
        expect(p.filled).toBe('-- gal');
        expect(p.ratio).toBe('--');
        expect(p.excludedShown).toBe(true);
        expect(p.excluded).toBe('1 leg excluded: 1 more than 25% off');
    });

    it('tracker re-init between measurements (widget SET / recovery CONFIRM): excluded even when the ratio looks plausible', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);            // 36.0
        fly(10.0);                   // tracked 26.0
        at(NOW + 1000);
        FuelTankState.init(13, 13, 'L');   // what fuel-tanks.js SET and recovery CONFIRM call
        fly(0.5);                    // tracked 25.5
        applyTic(5.5, 5.5);          // 24.4: actual 11.6, tracked 10.5 → 0.905 (inside the gate)

        const p = panel();
        expect(p.ratio).toBe('--');
        expect(p.excluded).toBe('1 leg excluded: 1 tracker reset');
    });

    it('stale (UNCONFIRMED) tracked figure at the end reading: excluded, record says tracked_stale', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);            // 36.0
        fly(10.0);                   // tracked 26.0
        at(NOW + 50 * 60000);        // 50 min without a sample → needsConfirmation()
        applyTic(6, 6);              // 26.0: actual 10.0, tracked 10.0

        expect(history()[1].tracked_stale).toBe(true);
        const p = panel();
        expect(p.ratio).toBe('--');
        expect(p.excluded).toBe('1 leg excluded: 1 unconfirmed');
    });

    it('an applied dropped-burn correction is not counted as flow burn', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);            // 36.0
        fly(10.0);                   // 26.0
        at(NOW + 180000);            // 3-min comms gap
        FuelTankState.onSample(10, NOW);   // 10 s burned + ~0.47 gal dropped estimate
        expect(FuelTankState.applyDroppedBurn(0.47)).toBe(true);   // tracked 25.5
        applyTic(6, 6);              // 26.0: actual 10.0

        expect(history()[1].tracked_gal).toBe(25.5);
        expect(history()[1].dropped_applied_since_init_gal).toBeCloseTo(0.47, 6);
        const p = panel();
        expect(p.used).toBe('10.0 gal');   // 36.0 − 25.5 − 0.47, not 10.5
        expect(p.filled).toBe('10.0 gal');
    });

    it('an outstanding (unapplied) dropped-burn estimate does not exclude the leg', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);
        fly(10.0);
        at(NOW + 180000);
        FuelTankState.onSample(10, NOW);
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBeGreaterThan(0.4);
        applyTic(6, 6);              // tracked 26.0, actual 10.0

        const p = panel();
        // Tracked used is the flow burn (PR #214 finding 3): 10.0 + the 10 s sample
        // after the gap (0.028), not the rounded tank total's 36.0 − 26.0.
        expect(p.used).toBe('10.0 gal');
        expect(p.ratio).toBe('1.003');
        expect(p.excludedShown).toBe(false);
    });

    it('legacy entries (no tracked_since key) are excluded and counted', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            { measured_at: '2026-10-01T12:00:00Z', total_gal: 33.6, edm_gal: 31.0 },
            { measured_at: '2026-10-01T13:00:00Z', total_gal: 25.0, edm_gal: 22.0 },
            { measured_at: '2026-10-01T14:00:00Z', total_gal: 20.0, tracked_gal: 19.5 },
        ]));
        const p = panel();
        expect(p.filled).toBe('-- gal');
        expect(p.ratio).toBe('--');
        expect(p.excluded).toBe('2 legs excluded: 2 recorded before this check');
    });

    it('the first new-format entry after a legacy one is an older-record leg, not a reset', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            { measured_at: '2026-10-01T12:00:00Z', total_gal: 33.6, tracked_gal: 31.0 },
            { measured_at: '2026-10-01T13:00:00Z', total_gal: 25.0, tracked_gal: 24.0, tracked_since: 'i1', tank_init_at: 'i2', tracked_stale: false, dropped_applied_since_init_gal: 0 },
        ]));
        expect(panel().excluded).toBe('1 leg excluded: 1 recorded before this check');
    });

    it('counts several kinds together; good legs still count', () => {
        const e = (min, tic, trk, since, init, extra = {}) => ({
            measured_at: new Date(Date.UTC(2026, 10, 1, 12, 0) + min * 60000).toISOString(),
            total_gal: tic, tracked_gal: trk, tracked_since: since, tank_init_at: init,
            tracked_stale: false, dropped_applied_since_init_gal: 0, ...extra,
        });
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            e(0,   36.0, 30.0, 'a', 'b'),
            e(60,  26.0, 25.5, 'b', 'c'),                          // good: 10.0 / 10.5
            e(120, 20.0, 15.0, 'x', 'd'),                          // reset
            e(180, 14.0, 14.5, 'd', 'f', { tracked_stale: true }), // unconfirmed
            e(240, 10.0, 6.0,  'f', 'g'),                          // 4.0 vs 8.0 → outlier
            e(300, 12.0, 9.0,  'g', 'h'),                          // tic rose, no stop → unusable
        ]));
        const p = panel();
        expect(p.filled).toBe('10.0 gal');
        expect(p.used).toBe('10.5 gal');
        expect(p.excluded).toBe(
            '4 legs excluded: 1 tracker reset, 1 unconfirmed, 1 more than 25% off, 1 unusable reading');
    });
});

/* ---- PR #214 review findings 3, 4, 2 (history read), 9 ---------------------- */

describe('finding 3: tracked leg burn is the flow burn, even when a tank clamped at 0', () => {
    it('the record carries flow_burn_since_init_gal (burned − dropped applied, before the re-init)', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);
        fly(10.0);
        at(NOW + 180000);
        FuelTankState.onSample(10, NOW);                       // + dropped estimate
        expect(FuelTankState.applyDroppedBurn(0.47)).toBe(true);
        applyTic(6, 6);
        const h1 = history()[1];
        expect(h1.flow_burn_since_init_gal).toBeCloseTo(10.0 + 10 * 10 / 3600, 6);
        // nothing tracked → null
        localStorage.clear(); FuelTankState._state = null; FuelTankState._loaded = true;
        applyTic(6, 6);
        expect(history()[0].flow_burn_since_init_gal).toBeNull();
    });

    it('tank L clamped at 0 mid-leg: the full 19.0 gal of flow counts, not 36 − 18', () => {
        FuelTankState.init(18, 18, 'L');
        applyTic(11, 11);            // 36.0 (18.0 / 18.0)
        fly(19.0);                   // L floors at 0 after 18.0; 19.0 gal of flow integrated
        expect(FuelTankState.getState().left_gal).toBe(0);
        applyTic(0, 11);             // 2.2 + 18.0 = 20.2 → actual 15.8
        const p = panel();
        expect(p.filled).toBe('15.8 gal');
        expect(p.used).toBe('19.0 gal');
        expect(p.ratio).toBe('1.203');
    });

    it('uses the recorded flow burn over the tic difference when present', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            { measured_at: '2026-11-01T12:00:00Z', total_gal: 36.0, tracked_gal: 30.0, tracked_since: 'i0', tank_init_at: 'i1', tracked_stale: false, dropped_applied_since_init_gal: 0, flow_burn_since_init_gal: 6 },
            // tic difference would say 36 − 18 = 18; the flow burn says 20.
            { measured_at: '2026-11-01T13:00:00Z', total_gal: 19.0, tracked_gal: 18.0, tracked_since: 'i1', tank_init_at: 'i2', tracked_stale: false, dropped_applied_since_init_gal: 0, flow_burn_since_init_gal: 20 },
        ]));
        const p = panel();
        expect(p.filled).toBe('17.0 gal');
        expect(p.used).toBe('20.0 gal');
    });
});

describe('finding 4: outlier gate relative to the median with ≥ 3 candidate legs', () => {
    const e = (min, tic, trk, i) => ({
        measured_at: new Date(Date.UTC(2026, 10, 1, 12, 0) + min * 60000).toISOString(),
        total_gal: tic, tracked_gal: trk, tracked_since: 'i' + i, tank_init_at: 'i' + (i + 1),
        tracked_stale: false, dropped_applied_since_init_gal: 0,
    });

    it('three legs at ~1.30: counted, ratio 1.300 and the guidance (Σactual 30 gal)', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            e(0, 40, 40, 0),
            e(60, 30, 27, 1),        // actual 10, tracked 13
            e(120, 20, 17, 2),       // actual 10, tracked 13
            e(180, 10, 7, 3),        // actual 10, tracked 13
        ]));
        const p = panel();
        expect(p.filled).toBe('30.0 gal');
        expect(p.used).toBe('39.0 gal');
        expect(p.ratio).toBe('1.300');
        expect(p.guidance).toMatch(/New K-Factor = Current K-Factor × 1\.300\s+\(increase K-factor/);
        expect(p.excludedShown).toBe(false);
    });

    it('two consistent legs at 1.30: excluded by the absolute gate, as before', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            e(0, 40, 40, 0), e(60, 30, 27, 1), e(120, 20, 17, 2),
        ]));
        const p = panel();
        expect(p.ratio).toBe('--');
        expect(p.excluded).toBe('2 legs excluded: 2 more than 25% off');
    });

    it('one garbage leg among four normal ones: only the garbage leg is excluded', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            e(0, 50, 50, 0),
            e(60, 40, 39.8, 1),      // 10 / 10.2
            e(120, 30, 30.1, 2),     // 10 / 9.9
            e(180, 25, 15, 3),       // 5 / 15  → 3.0: garbage
            e(240, 15, 14.8, 4),     // 10 / 10.2
            e(300, 5, 5.1, 5),       // 10 / 9.9
        ]));
        const p = panel();
        expect(p.filled).toBe('40.0 gal');
        expect(p.used).toBe('40.2 gal');
        expect(p.excluded).toBe('1 leg excluded: 1 more than 25% off');
    });
});

describe('finding 2: K-factor reads history through _loadHistory()', () => {
    it('_computeKFactor uses the shared loader', () => {
        const spy = vi.spyOn(FuelOverlay.prototype, '_loadHistory');
        overlay._computeKFactor();
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('finding 3: a hand-edited TRACKED figure reaches the K-factor', () => {
    const rec = (min, tic, trk, i, flow) => ({
        measured_at: new Date(Date.UTC(2026, 10, 1, 12, 0) + min * 60000).toISOString(),
        total_gal: tic, tracked_gal: trk, tracked_since: 'i' + i, tank_init_at: 'i' + (i + 1),
        tracked_stale: false, dropped_applied_since_init_gal: 0, flow_burn_since_init_gal: flow,
    });
    const editNewest = (val) => {
        const tr = overlay._dom.histBody.querySelector('tr');
        tr.querySelector('.fo-hist-edit').dispatchEvent(new window.MouseEvent('click'));
        tr.querySelector('input[id^="fo-hist-tracked-"]').value = val;
        tr.querySelector('.fo-hist-save').dispatchEvent(new window.MouseEvent('click'));
    };

    it('editing TRACKED drops the recorded flow burn; saving it unchanged keeps it', () => {
        localStorage.setItem('flypi_fuel_history', JSON.stringify([
            rec(0, 36.0, 30.0, 0, 5), rec(60, 26.0, 25.0, 1, 10.4),
        ]));
        open();
        editNewest('25.0');                                  // unchanged
        expect(history()[1].flow_burn_since_init_gal).toBe(10.4);
        expect($('fo-kf-used').textContent).toBe('10.4 gal');
        editNewest('25.5');                                  // corrected
        expect(history()[1].flow_burn_since_init_gal).toBeUndefined();
        expect($('fo-kf-used').textContent).toBe('10.5 gal');   // 36.0 − 25.5
    });
});
