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
    FuelTankState._coveredMs = null;   // a real app restart loses it
    mount();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    at(Date.UTC(2026, 10, 10, 15, 0));
    localStorage.clear();
    Settings.fuelManualOverride = null;
    FuelTankState._state = null;
    FuelTankState._loaded = false;
    FuelTankState._coveredMs = null;   // a real app restart loses it
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

    it('the first frame after init is the engine start: nothing before it is integrated', () => {
        FuelTankState.init(18, 18, 'L');
        at(NOW + 20 * MIN);
        send(9, 2400, 0);
        let st = FuelTankState.getState();
        expect(st.left_gal + st.right_gal).toBe(36);
        send(9, 2400);                         // next frame integrates its 1 s
        st = FuelTankState.getState();
        expect(36 - (st.left_gal + st.right_gal)).toBeCloseTo(9 * 1 / 3600, 6);
        expect(st.dropped_burn_estimate_gal).toBe(0);
    });

    it('onSample called directly (no frame RPM) after init integrates at most the capped dt and books no gap', () => {
        FuelTankState.init(18, 18, 'L');
        at(NOW + 20 * MIN);
        FuelTankState.onSample(9, NOW);
        const st = FuelTankState.getState();
        expect(36 - (st.left_gal + st.right_gal)).toBeCloseTo(9 * 10 / 3600, 6);
        expect(st.dropped_burn_estimate_gal).toBe(0);
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
        FuelTankState._coveredMs = null;   // a real app restart loses it
        at(NOW + 30 * MIN);                    // app dead; plane lands and shuts down
        mount();
        run(3, 0, 0);
        expect(FuelTankState.isFlowLost()).toBe(true);
        expect(FuelTankState.getState().engine_stopped_at ?? null).toBeNull();
        at(NOW + 10 * MIN);
        run(1, 6, 1000);
        expect(dropped()).toBeGreaterThan(1);
    });

    it('a 30 s FF-0 stretch at cruise RPM with current frames is a sensor reading: nothing booked, not a stop (review minor 2)', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(30, 0, 2400);                      // sender reads 0, engine at cruise RPM
        expect(FuelTankState.getState().engine_stopped_at ?? null).toBeNull();
        run(1);
        expect(dropped()).toBe(0);
    });

    it('60 s FF 0 at 1200 RPM with current frames, then flow: 0 booked (review minor 2)', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(60, 0, 1200);
        const before = FuelTankState.getState();
        run(1, 6, 1300);
        const st = FuelTankState.getState();
        expect(st.dropped_burn_estimate_gal).toBe(0);
        expect(st.gap_burn_since_init_gal).toBe(0);
        // only the 1 s since the last current frame is integrated
        expect((before.left_gal + before.right_gal) - (st.left_gal + st.right_gal)).toBeCloseTo(6 / 3600, 6);
    });

    it('FF-0 stretch, then a real outage: only the outage (from the last current frame) is booked', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(40, 0, 1200);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        at(NOW + 2 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(9 * (2 * 60 + 1 - 10) / 3600, 4);
    });
});

describe('F1: engine start with the fuel-flow sender reading 0 at idle (seen in recorded flights)', () => {
    it('after a shutdown: start, FF 0 at idle, data lost 5 min, resumes in flight → booked from the start, not from the shutdown', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(5, 0, 0);                          // shutdown
        at(NOW + 40 * MIN);
        run(20, 0, 1000);                      // started; sender reads 0 at idle
        expect(FuelTankState.getState().engine_stopped_at).toBeNull();
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        at(NOW + 5 * MIN);
        run(1);
        // last current frame (FF 0 at idle) → resume: 5 min + 1 s (review minor 2:
        // the FF-0 frames themselves are a sensor reading, not a gap)
        expect(dropped()).toBeCloseTo(9 * (300 + 1 - 10) / 3600, 4);
    });

    it('after APPLY TIC: start, FF 0 at idle, data lost 5 min → booked from the start', () => {
        FuelTankState.init(18, 18, 'L');
        at(NOW + 20 * MIN);
        run(20, 0, 1000);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        at(NOW + 5 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(9 * (300 + 1 - 10) / 3600, 4);
    });

    it('after APPLY TIC: a normal start with flow books nothing and integrates from the start', () => {
        FuelTankState.init(18, 18, 'L');
        at(NOW + 20 * MIN);
        run(1, 6, 1000);
        const st = FuelTankState.getState();
        expect(st.dropped_burn_estimate_gal).toBe(0);
        expect(st.last_burn_at).toBeTruthy();
    });
});

describe('F1 ruling 2: init() keeps the engine-running knowledge', () => {
    it('recovery CONFIRM / widget SET during an in-flight outage, data back 5 min later: ~5 min booked', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(FuelTankState.isFlowLost()).toBe(true);
        at(NOW + 2 * MIN);
        FuelTankState.init(14, 15, 'L');       // what the recovery panel / SET call
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBe(0);
        at(NOW + 5 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(9 * (5 * 60 + 1 - 10) / 3600, 4);
        expect(FuelTankState.getState().gap_burn_since_init_gal).toBeCloseTo(9 * (5 * 60 + 1 - 10) / 3600, 4);
    });

    it('re-entry in flight with data flowing (engine running, no outage): the outage after it is booked from the re-entry', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        FuelTankState.init(14, 15, 'L');
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        at(NOW + 3 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(9 * (3 * 60 + 1 - 10) / 3600, 4);
    });

    it('APPLY TIC on the ground after a normal shutdown, start 20 min later: 0', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(5, 0, 0);
        at(NOW + 5 * MIN);
        FuelTankState.init(12, 12, 'L');
        at(NOW + 20 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });

    it('fresh install (no prior state): APPLY TIC, start 20 min later: 0', () => {
        expect(FuelTankState.getState()).toBeNull();
        FuelTankState.init(18, 18, 'L');
        expect(FuelTankState.getState().last_burn_at).toBeNull();
        at(NOW + 20 * MIN);
        run(30, 9, 2400);
        expect(dropped()).toBe(0);
    });

    it('prior state stale (> 45 min, no stop seen, e.g. Pi off before shutdown): APPLY TIC next day, start later: 0', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);                               // last frame burning, no stop seen
        at(NOW + 18 * 60 * MIN);               // next day
        FuelTankState.init(12, 12, 'L');
        expect(FuelTankState.getState().last_burn_at).toBeNull();
        at(NOW + 20 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });

    it('outage in flight, landed: data back with the engine stopped (UNCONFIRMED), APPLY TIC, start 20 min later: 0', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        at(NOW + 10 * MIN);
        run(5, 0, 0);
        expect(FuelTankState.isFlowLost()).toBe(true);
        at(NOW + 5 * MIN);
        FuelTankState.init(10, 10, 'L');       // pilot re-enters fuel, as the manual says
        expect(FuelTankState.isFlowLost()).toBe(false);
        at(NOW + 20 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });

    it('app closed in flight, reopened on the ground with the engine stopped, APPLY TIC, start later: 0', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        widget.destroy();
        FuelTankState._state = null;
        FuelTankState._loaded = false;
        FuelTankState._coveredMs = null;   // a real app restart loses it
        at(NOW + 20 * MIN);
        mount();
        run(3, 0, 0);
        FuelTankState.init(10, 10, 'L');
        at(NOW + 15 * MIN);
        run(30, 6, 1000);
        expect(dropped()).toBe(0);
    });
});

describe('review I1: data back after an outage with the engine stopped and residual flow', () => {
    it('outage in flight → RPM 0 with FF 0.7: not integrated, nothing booked at 0.7, still UNCONFIRMED', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        const before = FuelTankState.getState();
        at(NOW + 20 * MIN);
        run(5, 0.7, 0);
        const st = FuelTankState.getState();
        expect(FuelTankState.needsConfirmation()).toBe(true);
        expect(FuelTankState.isFlowLost()).toBe(true);
        expect(st.dropped_burn_estimate_gal).toBe(0);
        expect(st.left_gal + st.right_gal).toBe(before.left_gal + before.right_gal);
        expect(st.last_burn_at).toBe(before.last_burn_at);
        expect(st.engine_stopped_at ?? null).toBeNull();
    });

    it('then a restart without a tic books the outage like the FF-0 return case', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        at(NOW + 20 * MIN);
        run(5, 0.7, 0);
        at(NOW + 10 * MIN);
        run(1, 6, 1000);
        expect(dropped()).toBeGreaterThan(1);
        expect(FuelTankState.isFlowLost()).toBe(false);
    });

    it('app closed in flight, reopened on the ground with residual flow at RPM 0: not integrated, UNCONFIRMED', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        widget.destroy();
        FuelTankState._state = null;
        FuelTankState._loaded = false;
        FuelTankState._coveredMs = null;   // a real app restart loses it
        at(NOW + 30 * MIN);
        mount();
        run(3, 0.7, 0);
        expect(FuelTankState.isFlowLost()).toBe(true);
        expect(dropped()).toBe(0);
    });

    it('direct onSample at RPM 0 after a burning gap (no noteEngineStopped first): skipped, nothing booked', () => {
        FuelTankState.init(18, 18, 'L');
        const t0 = Date.now();
        FuelTankState.onSample(9, t0 + 1000, 2400);
        FuelTankState.onSample(0.7, t0 + 20 * MIN, 0);
        expect(FuelTankState.getState().dropped_burn_estimate_gal).toBe(0);
    });
});

describe('stuck fuel-flow sender: FF 0 with the engine running for more than 90 s', () => {
    it('60 s FF 0 at 1200 RPM: 0 booked, never UNCONFIRMED', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        for (let i = 0; i < 60; i++) { send(0, 1200); expect(FuelTankState.needsConfirmation()).toBe(false); }
        run(1, 6, 1300);
        expect(dropped()).toBe(0);
        expect(FuelTankState.needsConfirmation()).toBe(false);
    });

    it('120 s FF 0 at 2400 RPM: UNCONFIRMED at 90 s; flow returns → ~120 s booked at the resumed GPH; clears', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        for (let i = 1; i <= 120; i++) {
            send(0, 2400);
            expect(FuelTankState.isFlowLost()).toBe(i > 90);
        }
        expect(FuelTankState.needsConfirmation()).toBe(true);
        run(1, 8, 2400);
        expect(dropped()).toBeCloseTo(8 * (121 - 10) / 3600, 4);
        expect(FuelTankState.isFlowLost()).toBe(false);
        expect(FuelTankState.needsConfirmation()).toBe(false);
    });

    it('FF 0 with RPM 0 (engine stopped) never marks', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(200, 0, 0);
        expect(FuelTankState.isFlowLost()).toBe(false);
        expect(FuelTankState.needsConfirmation()).toBe(false);
    });

    it('after APPLY TIC: start with FF 0 at idle for 100 s → UNCONFIRMED; flow → booked from the start', () => {
        FuelTankState.init(18, 18, 'L');
        at(NOW + 20 * MIN);
        run(100, 0, 1000);
        expect(FuelTankState.isFlowLost()).toBe(true);
        run(1, 6, 1100);
        expect(dropped()).toBeCloseTo(6 * (100 - 10) / 3600, 4);
    });

    it('N3: app restart 30 s into a stuck stretch, 4.5 min more FF 0 → UNCONFIRMED once 90 s since the last burn; reason zero_flow', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(30, 0, 2400);
        restartApp();
        let flaggedAt = null;
        for (let i = 1; i <= 270; i++) {
            send(0, 2400);
            if (flaggedAt == null && FuelTankState.isFlowLost()) flaggedAt = 30 + i;
        }
        expect(flaggedAt).toBe(91);
        expect(FuelTankState.flowLostReason()).toBe('zero_flow');
        run(1, 8, 2400);
        expect(dropped()).toBeCloseTo(8 * (301 - 10) / 3600, 4);
        expect(FuelTankState.isFlowLost()).toBe(false);
        expect(FuelTankState.flowLostReason()).toBeNull();
    });

    it('cannot fire after a tic or a seen stop: 60 s FF 0 at idle after a start, after an app restart → not flagged', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(5, 0, 0);                          // seen stop
        at(NOW + 30 * MIN);
        FuelTankState.init(12, 12, 'L');       // tic
        at(NOW + 10 * MIN);
        run(30, 0, 1000);                      // start, FF 0 at idle
        restartApp();
        run(30, 0, 1000);
        expect(FuelTankState.isFlowLost()).toBe(false);
    });

    it('stuck-sender reason vs data-lost reason', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(FuelTankState.flowLostReason()).toBe('data');
        at(NOW + MIN);
        run(1);
        expect(FuelTankState.flowLostReason()).toBeNull();
        run(95, 0, 2400);
        expect(FuelTankState.flowLostReason()).toBe('zero_flow');
        FuelTankState.init(10, 10, 'L');
        expect(FuelTankState.flowLostReason()).toBeNull();
    });
});

describe('markFlowLost: running decided by RPM only (R3)', () => {
    it('outage starting during an FF-0 stretch at 1200 RPM → UNCONFIRMED at once, reason data', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(20, 0, 1200);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        expect(FuelTankState.isFlowLost()).toBe(true);
        expect(FuelTankState.flowLostReason()).toBe('data');
    });

    it('frozen frame after an FF-0 stretch at 1200 RPM → UNCONFIRMED at once', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(20, 0, 1200);
        at(NOW + 1000);
        client.dispatchEvent(new CustomEvent('engine:data', {
            detail: { serial_connected: true, serial_warning: 'No EDM data for 6s', data: { Fuel_Flow: 0, RPM: 1200 } },
        }));
        expect(FuelTankState.isFlowLost()).toBe(true);
    });

    it('outage with the last current frame at RPM 0 (residual flow or not) → not marked', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(5, 0.7, 0);
        client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        expect(FuelTankState.isFlowLost()).toBe(false);
    });

    it('unit: markFlowLost(now, 0, 1200) marks; (now, 0.7, 0) and (now, 9, 250) do not', () => {
        FuelTankState.init(18, 18, 'L');
        const t = Date.now();
        expect(FuelTankState.markFlowLost(t, 0.7, 0)).toBe(false);
        expect(FuelTankState.markFlowLost(t, 9, 250)).toBe(false);
        expect(FuelTankState.markFlowLost(t, 0, undefined)).toBe(false);
        expect(FuelTankState.markFlowLost(t, 0, 1200)).toBe(true);
    });
});

