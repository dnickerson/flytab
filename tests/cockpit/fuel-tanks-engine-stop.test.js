/**
 * Fuel follow-up F1: no false dropped-burn estimate at engine start / restart.
 *
 * FuelTankState.onSample books any gap > MAX_SAMPLE_DT_MS (10 s) since the last
 * sample as dropped_burn_estimate_gal (the APPLY CORRECTION prompt). Before this
 * fix init() left last_sample_at = now as if it were a burning sample, so APPLY TIC
 * 20 min before engine start booked ~20 min of burn; a normal shutdown + restart
 * booked the whole engine-off time. A pilot who applied it understated fuel.
 *
 * Ruling: a gap is dropped burn only when the engine was running at the last
 * integrated sample and no engine stop was observed since. A stop is a CURRENT
 * frame with RPM <= FuelTankState.RUNNING_RPM_MIN (300), even with residual flow.
 * Stops seen after an unobserved stretch that began with the engine burning (data
 * loss, app restart) do not cancel that stretch.
 *
 * Real FuelTanksDisplay, FuelTankState, FuelState, FuelEngine and EngineClient.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = vi.fn();
globalThis.Settings      = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.FuelEngine    = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState     = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
globalThis.EngineClient  = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const FuelTanksDisplay   = new Function(read('web/cockpit/fuel-tanks.js') + '\nreturn FuelTanksDisplay;')();

let widget = null;
let client = null;
let NOW = 0;
const at = (ms) => { NOW = ms; vi.setSystemTime(NOW); };
const MIN = 60000;

function mount() {
    client = new EventTarget();
    window.engineClient = client;
    widget = new FuelTanksDisplay(document.body);
    widget.init();
}
function restartApp() {
    widget.destroy();
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    mount();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(Date.UTC(2026, 10, 10, 15, 0));
    localStorage.clear();
    Settings.fuelManualOverride = null;
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => (p === 'performance.fuel_capacity_gal' ? 36
            : p === 'performance.fuel_sender_accurate_below_gal' ? 12 : undefined),
    };
    mount();
});

afterEach(() => {
    try { widget && widget.destroy(); } catch (_) { /* */ }
    widget = null;
    delete window.engineClient;
    document.body.innerHTML = '';
    vi.useRealTimers();
});

/** A CURRENT engine frame (serial_connected, no serial_warning). */
const frame = (gph, rpm) => new CustomEvent('engine:data', {
    detail: { serial_connected: true, data: { Fuel_Flow: gph, RPM: rpm, Fuel_Left: 9, Fuel_Right: 9 } },
});
const send = (gph, rpm, stepMs = 1000) => { at(NOW + stepMs); client.dispatchEvent(frame(gph, rpm)); };
const run = (n, gph = 9, rpm = 2400) => { for (let i = 0; i < n; i++) send(gph, rpm); };
const dropped = () => FuelTankState.getState().dropped_burn_estimate_gal;

describe('F1: engine start after APPLY TIC', () => {
    it('APPLY TIC, engine started 20 min later (Pi on, RPM 0 frames before start): no estimate', () => {
        FuelTankState.init(18, 18, 'L');
        run(5, 0, 0);                          // master on, engine off
        at(NOW + 20 * MIN);
        run(30, 6, 1000);                      // start + warm-up
        expect(dropped()).toBe(0);
    });

    it('APPLY TIC, engine started 20 min later with no frames in between (Pi on at start): no estimate', () => {
        FuelTankState.init(18, 18, 'L');
        at(NOW + 20 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });

    it('the first sample after init integrates at most the capped dt', () => {
        FuelTankState.init(18, 18, 'L');
        at(NOW + 20 * MIN);
        send(9, 2400, 0);
        const st = FuelTankState.getState();
        expect(36 - (st.left_gal + st.right_gal)).toBeCloseTo(9 * 10 / 3600, 6);
    });
});

describe('F1: shutdown and restart', () => {
    it('normal shutdown (current RPM 0 frames), restart 40 min later: no estimate', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);                               // flight
        run(10, 0, 0);                         // shutdown
        expect(FuelTankState.getState().engine_stopped_at).toBeTruthy();
        at(NOW + 40 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
        expect(FuelTankState.getState().engine_stopped_at).toBeNull();   // cleared by a running sample
    });

    it('residual FF 0.7 with RPM 0 at shutdown is a stop (and does not clear it)', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(10, 0.7, 0);                       // residual flow, engine stopped
        expect(FuelTankState.getState().engine_stopped_at).toBeTruthy();
        at(NOW + 40 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });

    it('shutdown, app restarted on the ground, engine restarted 30 min later: no estimate', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(5, 0, 0);
        restartApp();
        at(NOW + 30 * MIN);
        run(3, 0, 0);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });

    it('taxi-in at FF 0 for 40 s before shutdown (seen in recorded flights) is still a stop', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(40, 0, 1100);                      // flow below the sender's range, engine running
        run(5, 0, 0);
        at(NOW + 40 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });
});

describe('F1: real gaps are still booked', () => {
    it('app restart mid-flight with a 3 min gap: booked', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        restartApp();
        at(NOW + 3 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(9 * (3 * 60 + 1 - 10) / 3600, 4);
    });

    it('data lost while running (engine:stale), resumes running 2 min later: booked', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(FuelTankState.isFlowLost()).toBe(true);
        at(NOW + 2 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(9 * (2 * 60 + 1 - 10) / 3600, 4);
        expect(FuelTankState.isFlowLost()).toBe(false);
    });

    it('data lost while running, comes back with the engine already stopped: the stop does not cancel the gap', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        at(NOW + 10 * MIN);
        run(5, 0, 0);                          // landed and shut down during the outage
        expect(FuelTankState.isFlowLost()).toBe(true);   // still UNCONFIRMED
        expect(FuelTankState.getState().engine_stopped_at ?? null).toBeNull();
        at(NOW + 20 * MIN);
        run(1, 6, 1000);
        expect(dropped()).toBeGreaterThan(1);  // booked on restart (over-estimate, pilot reviews it)
    });

    it('app killed in flight, restarted after landing with the engine stopped: gap marked and booked on restart', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        widget.destroy();
        FuelTankState._state = null;
        FuelTankState._loaded = false;
        at(NOW + 30 * MIN);                    // app dead; plane lands and shuts down
        mount();
        run(3, 0, 0);
        expect(FuelTankState.isFlowLost()).toBe(true);
        expect(FuelTankState.getState().engine_stopped_at ?? null).toBeNull();
        at(NOW + 10 * MIN);
        run(1, 6, 1000);
        expect(dropped()).toBeGreaterThan(1);
    });

    it('a short FF-0 dropout while running still books its gap (not taken as a stop)', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(30, 0, 2400);                      // sender reads 0, engine at cruise RPM
        expect(FuelTankState.getState().engine_stopped_at ?? null).toBeNull();
        run(1);
        expect(dropped()).toBeCloseTo(9 * (31 - 10) / 3600, 4);
    });
});
