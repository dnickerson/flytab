/**
 * PR #215 review: one explicit engine-state model in FuelTankState (state.engine:
 * state off|running|unknown, covered_at, zero_flow_since, pending_gap_ms, with the
 * top-level flow_lost_at / flow_lost_reason). Requirements 1-6 of the ruling, and
 * the reviewer's scenario harness (S1-S8b, X1-X9, N1-N8, R1-R4) ported with the
 * values the model produces pinned (each noted against the v13.7 value it replaced
 * where it changed on purpose).
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

const gal = () => { const s = FuelTankState.getState(); return s.left_gal + s.right_gal; };
const stale = () => client.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true } }));
const lost = () => FuelTankState.isFlowLost();
const reason = () => FuelTankState.flowLostReason();
const eng = () => FuelTankState.getState().engine;
const firstLost = (n, gph, rpm) => {
    let a = null;
    for (let i = 1; i <= n; i++) { send(gph, rpm); if (a === null && lost()) a = i; }
    return a;
};
const gphGal = (gph, sec) => gph * sec / 3600;

describe('requirement 1: re-entry after a LONG outage', () => {
    it('Pi drops in cruise, CONFIRM at minute 50, data back 20 min later → the 20 min after the re-entry is booked', () => {
        FuelTankState.init(18, 18, 'L');
        run(600);
        stale();
        at(NOW + 50 * MIN);
        expect(FuelTankState.needsConfirmation()).toBe(true);   // 45-min stale too
        FuelTankState.init(14, 14, 'L');                       // recovery CONFIRM
        expect(lost()).toBe(true);                             // outage still on
        at(NOW + 20 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(gphGal(9, 20 * 60 + 1 - 10), 4);
        expect(lost()).toBe(false);
    });

    it('an outage older than OUTAGE_RUNNING_MAX_MS (8 h) is not carried by a re-entry', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        stale();
        at(NOW + 9 * 60 * MIN);
        FuelTankState.init(14, 14, 'L');
        expect(lost()).toBe(false);
        expect(eng().state).toBe('unknown');
        at(NOW + 20 * MIN);
        run(30, 7, 1100);
        expect(dropped()).toBe(0);
    });
});

describe('requirement 2: init() during an ongoing outage with the engine running', () => {
    it('flow lost (UNCONFIRMED) stays until a current running frame with flow arrives', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        client.dispatchEvent(new CustomEvent('engine:disconnect'));
        at(NOW + 2 * MIN);
        FuelTankState.init(15, 15, 'L');
        expect(FuelTankState.needsConfirmation()).toBe(true);
        expect(eng().state).toBe('running');
        at(NOW + 3 * MIN);
        run(1);
        expect(FuelTankState.needsConfirmation()).toBe(false);
        expect(dropped()).toBeCloseTo(gphGal(9, 3 * 60 + 1 - 10), 4);
    });

    it('after an observed stop: cleared', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        stale();
        at(NOW + 10 * MIN);
        run(5, 0, 0);
        FuelTankState.init(10, 10, 'L');
        expect(lost()).toBe(false);
        expect(eng().state).toBe('off');
    });

    it('no prior state: nothing lost; 45-min stale with no flow lost: cleared, unknown', () => {
        FuelTankState.init(18, 18, 'L');
        expect(lost()).toBe(false);
        run(60);
        restartApp();
        at(NOW + 50 * MIN);
        FuelTankState.init(12, 12, 'L');
        expect(lost()).toBe(false);
        expect(eng().state).toBe('unknown');
    });
});

describe('requirement 3: markConfirmed never moves the gap / stuck-sender reference', () => {
    it('X3: markConfirmed mid-outage → the whole 7-min outage is booked (v13.7: 5 min)', () => {
        FuelTankState.init(18, 18, 'L');
        run(600);
        stale();
        at(NOW + 2 * MIN);
        FuelTankState.markConfirmed();
        at(NOW + 5 * MIN);
        run(5);
        expect(dropped()).toBeCloseTo(gphGal(9, 7 * 60 + 1 - 10), 4);
    });

    it('markConfirmed in an FF-0 stretch does not restart the 90 s count', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        run(60, 0, 2400);
        FuelTankState.markConfirmed();
        expect(firstLost(40, 0, 2400)).toBe(31);              // 91 s after the stretch began
        expect(reason()).toBe('zero_flow');
    });
});

describe('requirement 4: stuck-sender timing from the start of the FF-0 stretch', () => {
    it('measured from zero_flow_since, not from last_sample_at (a markConfirmed / tic in between does not matter)', () => {
        FuelTankState.init(18, 18, 'L');
        run(60);
        expect(firstLost(120, 0, 2400)).toBe(91);
        expect(eng().zero_flow_since).toBeTruthy();
    });

    it('after an app restart with a real gap, counting starts at the first FF-0 frame: an idle descent is not a stuck sender until 90 s observed', () => {
        FuelTankState.init(18, 18, 'L');
        run(600);
        widget.destroy();
        FuelTankState._state = null;
        FuelTankState._loaded = false;
        at(NOW + 30 * 1000);                                   // app dead 30 s
        mount();
        // frame 1 is t0; more than 90 s observed from it is frame 92 (t0 + 91 s)
        for (let i = 1; i <= 91; i++) { send(0, 1400); expect(reason()).not.toBe('zero_flow'); }
        expect(reason()).toBe('data');                         // the unobserved 30 s
        send(0, 1400);
        expect(reason()).toBe('zero_flow');
    });

    it('the stretch start is persisted: an app restart with no gap keeps counting (N3)', () => {
        FuelTankState.init(18, 18, 'L');
        run(300);
        run(30, 0, 2400);
        restartApp();
        expect(firstLost(270, 0, 2400)).toBe(61);
    });
});

describe('requirement 5: reason updates', () => {
    it("'zero_flow' becomes 'data' when engine data then stops (stale, disconnect, frozen)", () => {
        for (const stop of ['stale', 'disconnect', 'frozen']) {
            FuelTankState.init(18, 18, 'L');
            run(60);
            run(95, 0, 2400);
            expect(reason()).toBe('zero_flow');
            if (stop === 'stale') stale();
            else if (stop === 'disconnect') client.dispatchEvent(new CustomEvent('engine:disconnect'));
            else client.dispatchEvent(new CustomEvent('engine:data', { detail: { serial_connected: true,
                serial_warning: 'No EDM data for 6s', data: { Fuel_Flow: 0, RPM: 2400 } } }));
            expect(reason()).toBe('data');
            run(1);                                            // reset for the next kind
        }
    });

    it("data back at FF 0: 'data' until 90 s of FF 0 observed from the return, then 'zero_flow'", () => {
        FuelTankState.init(18, 18, 'L');
        run(300);
        stale();
        at(NOW + 3 * MIN);
        expect(firstLost(91, 0, 2400)).toBe(1);               // frames t0 .. t0 + 90 s
        expect(reason()).toBe('data');
        send(0, 2400);                                         // t0 + 91 s: > 90 s observed
        expect(reason()).toBe('zero_flow');
        run(1);
        expect(reason()).toBeNull();
    });
});

describe('requirement 6: migration of state stored before the engine model', () => {
    const store = (extra) => {
        const t = new Date(NOW).toISOString();
        localStorage.setItem('flytab_tank_state', JSON.stringify({
            left_gal: 10, right_gal: 10, active_tank: 'L', tank_switched_at: t, last_sample_at: t,
            requires_confirm: false, initialized_at: t, imbalance: false,
            dropped_burn_estimate_gal: 0, dropped_burn_ambiguous: false, burned_since_init_gal: 0,
            dropped_applied_since_init_gal: 0, flow_lost_at: null, gap_burn_since_init_gal: 0, ...extra,
        }));
        FuelTankState._state = null;
        FuelTankState._loaded = false;
    };

    it('engine_stopped_at → off; the old fields are dropped; same storage key', () => {
        store({ last_burn_at: new Date(NOW).toISOString(), engine_stopped_at: new Date(NOW).toISOString(), stop_seen_at: new Date(NOW).toISOString() });
        expect(eng().state).toBe('off');
        const raw = JSON.parse(localStorage.getItem('flytab_tank_state'));
        expect('engine_stopped_at' in raw).toBe(false);
        expect('stop_seen_at' in raw).toBe(false);
        expect(raw.engine.state).toBe('off');
    });

    it('flow_lost_at → running (the outage is still booked)', () => {
        store({ last_burn_at: new Date(NOW).toISOString(), flow_lost_at: new Date(NOW).toISOString() });
        expect(eng().state).toBe('running');
        expect(reason()).toBe('data');
        at(NOW + 5 * MIN);
        run(1);
        expect(dropped()).toBeCloseTo(gphGal(9, 5 * 60 + 1 - 10), 4);
    });

    it('last_burn_at within RECENT_BURN_MS → running: a gap is booked', () => {
        store({ last_burn_at: new Date(NOW).toISOString() });
        expect(eng().state).toBe('running');
        at(NOW + 3 * MIN);
        run(1);
        expect(dropped()).toBeGreaterThan(0.4);
    });

    it('older last_burn_at (or none) → unknown: the first sample books nothing', () => {
        store({ last_burn_at: new Date(NOW - 10 * MIN).toISOString() });
        expect(eng().state).toBe('unknown');
        at(NOW + 3 * MIN);
        run(5);
        expect(dropped()).toBe(0);
    });
});

/*
 * Reviewer's scenario harness (scratchpad harness/s2.test.js), ported. Values are
 * what the engine model produces; where one changed from v13.7 on purpose it says
 * so (all such changes book less engine-off time or follow a ruling).
 */
describe('scenario harness', () => {
    const tic = () => FuelTankState.init(18, 18, 'L');
    const S = (name, fn, exp) => it(name, () => {
        fn();
        const s = FuelTankState.getState();
        expect(s.dropped_burn_estimate_gal).toBeCloseTo(exp.dropped, 3);
        if ('lost' in exp) expect(lost()).toBe(exp.lost);
        if ('reason' in exp) expect(reason()).toBe(exp.reason);
        if ('total' in exp) expect(gal()).toBeCloseTo(exp.total, 3);
    });

    S('S1 tic 20 min before start', () => { tic(); at(NOW + 20 * MIN); run(60, 7, 1100); run(60, 9, 2400); }, { dropped: 0, lost: false });
    S('S1b tic + 20 min RPM 0 frames + start', () => { tic(); for (let i = 0; i < 1200; i++) send(0, 0); run(60, 7, 1100); }, { dropped: 0, lost: false });
    S('S2 shutdown + restart 40 min', () => { tic(); run(600); run(30, 0, 0); at(NOW + 40 * MIN); run(60, 7, 1100); }, { dropped: 0, lost: false });
    S('S2b shutdown seen, app restart, restart 40 min', () => { tic(); run(600); run(3, 0.7, 0); restartApp(); at(NOW + 40 * MIN); run(60, 7, 1100); }, { dropped: 0, lost: false });
    S('S3 in-flight app restart, 3 min', () => { tic(); run(600); restartApp(); at(NOW + 3 * MIN); run(5); }, { dropped: 0.4275, lost: false });
    S('S4 data loss 5 min', () => { tic(); run(600); stale(); at(NOW + 5 * MIN); run(5); }, { dropped: 0.7275, lost: false });
    S('S5 CONFIRM during the outage, data back 5 min later', () => { tic(); run(600); stale(); at(NOW + 2 * MIN); FuelTankState.init(15, 15, 'L'); at(NOW + 5 * MIN); run(5); }, { dropped: 0.7275, lost: false, total: 29.965 });
    S('S6 residual 0.7 at RPM 0, restart 30 min', () => { tic(); run(600); run(30, 0.7, 0); at(NOW + 30 * MIN); run(30, 7, 1100); }, { dropped: 0, lost: false, total: 34.440 });
    S('S7 taxi FF 0 then 5 min outage', () => { tic(); run(300); run(20, 0, 1200); stale(); at(NOW + 5 * MIN); run(5, 6, 1200); }, { dropped: 0.485, lost: false });
    S('S8 next-day tic after an unseen shutdown', () => { tic(); run(600); restartApp(); at(NOW + 16 * 60 * MIN); tic(); at(NOW + 10 * MIN); run(60, 7, 1100); }, { dropped: 0, lost: false });
    S('S8b next day, RPM 0 frames before the tic', () => { tic(); run(600); restartApp(); at(NOW + 16 * 60 * MIN); run(10, 0, 0); tic(); at(NOW + 10 * MIN); run(60, 7, 1100); }, { dropped: 0, lost: false });
    S('X1 20 min outage, data back stopped with residual 0.7', () => { tic(); run(600); stale(); at(NOW + 20 * MIN); run(10, 0.7, 0); }, { dropped: 0, lost: true, reason: 'data', total: 34.502 });
    S('X1b same, FF 0', () => { tic(); run(600); stale(); at(NOW + 20 * MIN); run(10, 0, 0); }, { dropped: 0, lost: true, reason: 'data' });
    S('X2 start with 30 s FF 0 at idle', () => { tic(); at(NOW + 10 * MIN); run(30, 0, 1000); run(10, 4, 1000); }, { dropped: 0, lost: false });
    S('X3 markConfirmed mid-outage (v13.7: 0.728)', () => { tic(); run(600); stale(); at(NOW + 2 * MIN); FuelTankState.markConfirmed(); at(NOW + 5 * MIN); run(5); }, { dropped: 1.0275, lost: false });
    S('X4 quick turn, unseen shutdown, tic, start 20 min later (known limit, unchanged)', () => { tic(); run(600); restartApp(); at(NOW + 20 * MIN); tic(); at(NOW + 20 * MIN); run(60, 7, 1100); }, { dropped: 2.316, lost: false });
    S('X5 CONFIRM in flight with data, next frame', () => { tic(); run(600); FuelTankState.init(15, 15, 'L'); send(9, 2400); }, { dropped: 0, lost: false });
    S('X7 outage + landing (residual), restart 20 min (v13.7: 4.669 incl. engine-off time)', () => { tic(); run(600); stale(); at(NOW + 20 * MIN); run(10, 0.7, 0); at(NOW + 20 * MIN); run(30, 7, 1100); }, { dropped: 2.316, lost: false });
    S('X8 outage + landing (FF 0), restart 20 min (v13.7: 4.669)', () => { tic(); run(600); stale(); at(NOW + 20 * MIN); run(10, 0, 0); at(NOW + 20 * MIN); run(30, 7, 1100); }, { dropped: 2.316, lost: false });
    S('X9 outage, tic 20 min later, start 20 min later (known limit, unchanged)', () => { tic(); run(600); stale(); at(NOW + 20 * MIN); FuelTankState.init(10, 10, 'L'); at(NOW + 20 * MIN); run(30, 7, 1100); }, { dropped: 2.316, lost: false });
    S('N1 60 s FF 0 at 1200, then flow', () => { tic(); run(300); expect(firstLost(60, 0, 1200)).toBeNull(); run(10, 6, 1200); }, { dropped: 0, lost: false });
    S('N2 120 s FF 0 at 2400, then 8 gph', () => { tic(); run(300); expect(firstLost(120, 0, 2400)).toBe(91); send(8, 2400); }, { dropped: 0.2467, lost: false });
    S('N3 restart in a stuck stretch, then flow', () => { tic(); run(300); run(30, 0, 2400); restartApp(); expect(firstLost(270, 0, 2400)).toBe(61); send(8, 2400); }, { dropped: 0.6467, lost: false });
    S('N3b restart in a 40 s FF-0 taxi, then flow (v13.7: 0.052)', () => { tic(); run(300); run(20, 0, 1200); restartApp(); run(20, 0, 1200); run(5, 6, 1200); }, { dropped: 0, lost: false });
    S('N4 outage, RPM 0 frames, restart 20 min (v13.7: 4.766)', () => { tic(); run(600); stale(); at(NOW + 20 * MIN); run(60, 0, 0); expect(lost()).toBe(true); at(NOW + 20 * MIN); run(30, 7, 1100); }, { dropped: 2.316, lost: false });
    S('N4b outage, residual at RPM 0, restart 20 min (v13.7: 4.766)', () => { tic(); run(600); stale(); at(NOW + 20 * MIN); run(60, 0.7, 0); expect(lost()).toBe(true); at(NOW + 20 * MIN); run(30, 7, 1100); }, { dropped: 2.316, lost: false });
    S('N5 stuck 200 s, shutdown, restart 30 min (v13.7: 3.988 incl. engine-off time)', () => { tic(); run(300); run(200, 0, 2400); run(60, 0, 0); expect(reason()).toBe('zero_flow'); at(NOW + 30 * MIN); run(30, 7, 1100); }, { dropped: 0.3694, lost: false });
    S('N6 5 min outage, 30 s FF 0 running, then flow', () => { tic(); run(600); stale(); at(NOW + 5 * MIN); run(30, 0, 2400); run(5); }, { dropped: 0.8025, lost: false });
    S('N7 tic, start, 60 s FF 0 at idle', () => { tic(); at(NOW + 10 * MIN); run(60, 0, 1000); run(10, 4, 1000); }, { dropped: 0, lost: false });
    S('N8 dead sender from the start', () => { tic(); at(NOW + 10 * MIN); expect(firstLost(600, 0, 2400)).toBe(92); }, { dropped: 0, lost: true, reason: 'zero_flow' });
    S('R1 stop, tic, start FF 0, restart, 60 s total', () => { tic(); run(60); run(5, 0, 0); at(NOW + 30 * MIN); FuelTankState.init(12, 12, 'L'); at(NOW + 10 * MIN); run(30, 0, 1000); restartApp(); expect(firstLost(30, 0, 1000)).toBeNull(); }, { dropped: 0, lost: false });
    S('R1b same, 120 s total', () => { tic(); run(60); run(5, 0, 0); at(NOW + 30 * MIN); FuelTankState.init(12, 12, 'L'); at(NOW + 10 * MIN); run(30, 0, 1000); restartApp(); expect(firstLost(90, 0, 1000)).toBe(62); }, { dropped: 0, lost: true, reason: 'zero_flow' });
    S("R2 unseen shutdown, start FF 0 idle 20 min later (v13.7 reason: 'zero_flow')", () => { tic(); run(600); restartApp(); at(NOW + 20 * MIN); expect(firstLost(5, 0, 1000)).toBe(1); }, { dropped: 0, lost: true, reason: 'data' });
    S('R3 outage beginning in an FF-0 stretch, back at FF 0, then flow', () => { tic(); run(300); run(5, 0, 2400); stale(); expect(reason()).toBe('data'); at(NOW + 3 * MIN); expect(firstLost(5, 0, 2400)).toBe(1); run(3); }, { dropped: 0.44, lost: false });
});

/*
 * init(…, source): APPLY TIC ('tic') and RECORD FUEL STOP ('fuel_stop') are ground
 * measurements; widget SET / recovery CONFIRM ('reentry') are in-flight re-entries.
 * A missing / unknown source gets the in-flight re-entry rules.
 */
describe('init source: ground measurements do not carry an outage', () => {
    const outageThenLand = () => { FuelTankState.init(18, 18, 'L'); run(600); stale(); };

    it('P1: Pi off before shutdown (stale), APPLY TIC 4 h later, Pi on 10 min later at RPM 0, start → 0, no UNCONFIRMED', () => {
        outageThenLand();
        at(NOW + 4 * 60 * MIN);
        FuelTankState.init(18, 18, 'L', 'tic');
        expect(FuelTankState.needsConfirmation()).toBe(false);
        at(NOW + 10 * MIN);
        run(600, 0, 0);
        expect(lost()).toBe(false);
        run(30, 7, 1100);
        expect(dropped()).toBe(0);
    });

    it('P1b: same, tic then start 20 min later with no frames before', () => {
        outageThenLand();
        at(NOW + 4 * 60 * MIN);
        FuelTankState.init(18, 18, 'L', 'tic');
        at(NOW + 20 * MIN);
        run(30, 7, 1100);
        expect(dropped()).toBe(0);
        expect(lost()).toBe(false);
    });

    it('P1c: same, Pi on (RPM 0) before the tic', () => {
        outageThenLand();
        at(NOW + 4 * 60 * MIN);
        run(10, 0, 0);
        FuelTankState.init(18, 18, 'L', 'tic');
        expect(lost()).toBe(false);
        at(NOW + 10 * MIN);
        run(30, 7, 1100);
        expect(dropped()).toBe(0);
    });

    it('X9b: outage, landing, APPLY TIC 20 min later (Pi off), Pi on 5 min later at RPM 0, start → 0, no UNCONFIRMED after the tic', () => {
        outageThenLand();
        at(NOW + 20 * MIN);
        FuelTankState.init(10, 10, 'L', 'tic');
        expect(FuelTankState.needsConfirmation()).toBe(false);
        at(NOW + 5 * MIN);
        run(600, 0, 0);
        expect(lost()).toBe(false);
        run(30, 7, 1100);
        expect(dropped()).toBe(0);
    });

    it('RECORD FUEL STOP never carries, even right after an outage began', () => {
        outageThenLand();
        at(NOW + 2 * MIN);
        FuelTankState.init(18, 18, 'L', 'fuel_stop');
        expect(lost()).toBe(false);
        expect(eng().state).toBe('unknown');
        at(NOW + 10 * MIN);
        run(30, 7, 1100);
        expect(dropped()).toBe(0);
    });

    it('APPLY TIC within 45 min of the last frame after an unseen shutdown with no outage (app closed) still carries: the documented known limit (X4)', () => {
        FuelTankState.init(18, 18, 'L');
        run(600);
        restartApp();
        at(NOW + 20 * MIN);
        FuelTankState.init(18, 18, 'L', 'tic');
        expect(eng().state).toBe('running');
        at(NOW + 20 * MIN);
        run(60, 7, 1100);
        expect(dropped()).toBeCloseTo(2.316, 3);
    });

    it("an APPLY TIC more than 45 min after the last frame does not carry", () => {
        FuelTankState.init(18, 18, 'L');
        run(600);
        restartApp();
        at(NOW + 50 * MIN);
        FuelTankState.init(18, 18, 'L', 'tic');
        expect(eng().state).toBe('unknown');
    });

    it("widget SET / recovery CONFIRM ('reentry') keep the in-flight carry (F1, F2)", () => {
        outageThenLand();
        at(NOW + 50 * MIN);
        FuelTankState.init(15, 15, 'L', 'reentry');
        expect(lost()).toBe(true);
        at(NOW + 20 * MIN);
        run(3);
        expect(dropped()).toBeCloseTo(gphGal(9, 20 * 60 + 1 - 10), 4);
    });

    it('missing or unknown source → in-flight re-entry rules (a caller that forgets it cannot lose real burn)', () => {
        for (const src of [undefined, 'bogus']) {
            outageThenLand();
            at(NOW + 50 * MIN);
            FuelTankState.init(15, 15, 'L', src);
            expect(lost()).toBe(true);
            run(1);
        }
    });

    it('callers pass their source: APPLY TIC → tic, RECORD FUEL STOP → fuel_stop, widget SET / CONFIRM → reentry', () => {
        const ov = read('web/cockpit/fuel-overlay.js');
        expect(ov).toMatch(/FuelTankState\.init\(m\.left_gal, m\.right_gal, existing\?\.active_tank \?\? 'L', 'tic'\)/);
        expect(ov).toMatch(/FuelTankState\.init\(leftGal, rightGal, existingTank\?\.active_tank \?\? 'L', 'fuel_stop'\)/);
        expect(read('web/cockpit/fuel-tanks.js')).toMatch(/FuelTankState\.init\(leftGal, rightGal, this\._initSelectedTank, 'reentry'\)/);
    });
});

