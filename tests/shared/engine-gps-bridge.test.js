/**
 * gps-source.js sets BOTH stratux.situation and fires 'stratux:situation'.
 * engine-gps-bridge.js fired the event only — property readers (track-log.js,
 * device-status.js, map.js) saw no position update while the engine-GPS
 * fallback was active, even though event-listener readers worked fine.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

global.DiagLog = { log: vi.fn() };
if (typeof global.CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(t, o) { super(t); this.detail = o?.detail; }
    };
}

const src = readFileSync('web/shared/engine-gps-bridge.js', 'utf8');
const EngineGpsBridge = new Function(`${src}\nreturn EngineGpsBridge;`)();

function makeStratux() {
    const target = new EventTarget();
    target.situation = null;
    target.stale = true;
    target._suppressGpsSituation = false;
    return target;
}

function makeEngine(data) {
    return { stale: false, lastData: data };
}

describe('EngineGpsBridge — sets stratux.situation, not just the event (Finding 11)', () => {
    let stratux, engine, bridge;

    beforeEach(() => {
        stratux = makeStratux();
        engine = makeEngine({ latitude: 35.1, longitude: -80.2, gps_altitude: 3500, ground_speed: 120, course: 270, pitch: 1, bank: 0, acc_vert: 1 });
        bridge = Object.create(EngineGpsBridge.prototype);
        bridge._stratux = stratux;
        bridge._engine = engine;
        bridge._active = false;
    });

    it('sets stratux.situation when injecting engine GPS', () => {
        bridge._tick();
        expect(stratux.situation).not.toBeNull();
        expect(stratux.situation.lat).toBe(35.1);
        expect(stratux.situation.lon).toBe(-80.2);
    });

    it('still fires the stratux:situation event with the same data', () => {
        const events = [];
        stratux.addEventListener('stratux:situation', (e) => events.push(e.detail));
        bridge._tick();
        expect(events).toHaveLength(1);
        expect(events[0].lat).toBe(35.1);
        expect(events[0]).toBe(stratux.situation); // same object, not a re-derived copy
    });

    it('does not touch stratux.situation when GpsSource is suppressing (internal GPS active)', () => {
        stratux._suppressGpsSituation = true;
        bridge._tick();
        expect(stratux.situation).toBeNull();
    });

    it('does not touch stratux.situation when Stratux is not actually stale', () => {
        stratux.stale = false;
        bridge._tick();
        expect(stratux.situation).toBeNull();
    });
});

describe('EngineGpsBridge — degrades stale situation instead of freezing it (Finding 2)', () => {
    let stratux, engine, bridge;

    beforeEach(() => {
        stratux = makeStratux();
        engine = makeEngine({ latitude: 35.1, longitude: -80.2, gps_altitude: 3500, ground_speed: 120, course: 270, pitch: 1, bank: 0, acc_vert: 1 });
        bridge = Object.create(EngineGpsBridge.prototype);
        bridge._stratux = stratux;
        bridge._engine = engine;
        bridge._active = false;
        bridge._staleTimer = null;
    });

    it('degrades gps_fix_quality to 0 and dispatches when _tick() detects deactivation', () => {
        // First tick: injects a fresh fix, bridge goes active.
        bridge._tick();
        expect(bridge._active).toBe(true);
        expect(stratux.situation.gps_fix_quality).toBe(1);

        // Second tick: engine data went stale, shouldInject flips false while
        // bridge is still marked active — the else-if branch must degrade.
        engine.stale = true;
        const events = [];
        stratux.addEventListener('stratux:situation', (e) => events.push(e.detail));
        bridge._tick();

        expect(bridge._active).toBe(false);
        expect(stratux.situation.gps_fix_quality).toBe(0);
        expect(events).toHaveLength(1);
        expect(events[0].gps_fix_quality).toBe(0);
        expect(events[0]).toBe(stratux.situation);
    });

    it('does not throw degrading when stratux.situation was never set', () => {
        // else-if(this._active) branch reached with no prior injection — should
        // be a no-op guard, not a crash on spreading null/undefined.
        bridge._active = true;
        bridge._stratux.stale = false; // shouldInject becomes false via this path too
        expect(() => bridge._tick()).not.toThrow();
        expect(stratux.situation).toBeNull();
    });

    it('degrades via the 15s watchdog when engine:data stops firing entirely', () => {
        vi.useFakeTimers();
        try {
            bridge._tick(); // injects fresh fix, arms the watchdog
            expect(bridge._active).toBe(true);
            expect(stratux.situation.gps_fix_quality).toBe(1);

            const events = [];
            stratux.addEventListener('stratux:situation', (e) => events.push(e.detail));

            vi.advanceTimersByTime(15000); // no further _tick() calls

            expect(bridge._active).toBe(false);
            expect(stratux.situation.gps_fix_quality).toBe(0);
            expect(events).toHaveLength(1);
            expect(events[0].gps_fix_quality).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('watchdog does not fire after stop() clears the timer', () => {
        vi.useFakeTimers();
        try {
            bridge._tick(); // injects fresh fix, arms the watchdog
            expect(bridge._active).toBe(true);

            bridge.stop(); // clears _staleTimer, matching gps-source.js's stop()

            vi.advanceTimersByTime(15000);

            // gps_fix_quality should remain at the last injected value (1), not degrade,
            // since the watchdog was cleared.
            expect(stratux.situation.gps_fix_quality).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
