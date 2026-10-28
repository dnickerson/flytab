/**
 * Flight recorder vs. the app going to the background (A1, flight-safety plan).
 *
 * 2026-10-13: the recording ended at 12:11:52 EDT, 2 s after the pilot switched
 * to Settings mid-flight, ~10 min before landing. The hide handler stopped the
 * recording because the 2-minute data-gap timer was running: an ExpressVPN
 * dropout had cut both feeds 27 s earlier. A data gap is not the end of a flight.
 *
 * The handler exists for 4ef751b (v9.59): pilot shuts the engine down and turns
 * the screen off, Android throttles the 60 s countdown, and the flight never gets
 * its logbook entry. That case must keep working, but only on FRESH evidence
 * that the engine is off (or, with no engine monitor at all, that the aircraft
 * has stopped) -- never on stale data or a data gap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
global.CockpitConfig = { get: () => ({ rpmStopThreshold: 0, stopDelaySeconds: 60 }) };
const FlightRecorder = new Function(read('web/cockpit/flight-recorder.js') + '\nreturn FlightRecorder;')();

function setVisibility(state) {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * engine: { rpm, ageMs } or null for "no engine monitor this session" (lastData null).
 * gps:    { gs, ageMs } or null for no situation.
 */
function makeRecorder({ engine, gps, gapTimer = false }) {
    const now = Date.now();
    const engineClient = engine
        ? { lastData: { data: { RPM: engine.rpm } }, get dataAge() { return engine.ageMs; } }
        : { lastData: null, get dataAge() { return Infinity; } };
    const stratux = { situation: gps ? { ground_speed: gps.gs, timestamp: now - gps.ageMs, lat: 34.7, lon: -80.8, gps_fix_quality: 2 } : null };
    const rec = new FlightRecorder(engineClient, stratux, null);
    rec.init();
    rec._recording = true;                       // as if start() had run
    rec._flush = vi.fn(async () => {});
    rec.stop = vi.fn(async () => { rec._recording = false; });
    if (gapTimer) rec._gapTimer = setTimeout(() => {}, 120000);
    return rec;
}

describe('FlightRecorder — app goes to the background', () => {
    let rec;
    beforeEach(() => { vi.useFakeTimers(); setVisibility('visible'); });
    afterEach(() => { rec?.destroy?.(); setVisibility('visible'); vi.useRealTimers(); });

    it('replay of 10-13 12:11:50: data gap running, engine stale at cruise RPM -> keeps recording', () => {
        rec = makeRecorder({ engine: { rpm: 2400, ageMs: 27000 }, gps: { gs: 142, ageMs: 27000 }, gapTimer: true });
        setVisibility('hidden');
        expect(rec._flush).toHaveBeenCalled();          // buffered rows are saved
        expect(rec.stop).not.toHaveBeenCalled();
        expect(rec.recording).toBe(true);
    });

    it('app switch in cruise with fresh data -> keeps recording', () => {
        rec = makeRecorder({ engine: { rpm: 2400, ageMs: 500 }, gps: { gs: 142, ageMs: 200 } });
        setVisibility('hidden');
        expect(rec.stop).not.toHaveBeenCalled();
    });

    it('engine monitor link lost with its last reading 0 RPM (stale) -> keeps recording; resume decides', () => {
        rec = makeRecorder({ engine: { rpm: 0, ageMs: 30000 }, gps: { gs: 0, ageMs: 30000 } });
        rec._rpmZeroCount = 12;                        // countdown had started on the stale value
        setVisibility('hidden');
        expect(rec.stop).not.toHaveBeenCalled();
    });

    it('data gap alone (no other evidence) never ends the flight on hide', () => {
        rec = makeRecorder({ engine: { rpm: 2400, ageMs: 15000 }, gps: null, gapTimer: true });
        setVisibility('hidden');
        expect(rec.stop).not.toHaveBeenCalled();
    });

    it('4ef751b kept: engine shut down (fresh 0 RPM for 30 s) then screen off -> recording ends', () => {
        rec = makeRecorder({ engine: { rpm: 0, ageMs: 800 }, gps: { gs: 0, ageMs: 300 } });
        rec._rpmZeroCount = 30;
        setVisibility('hidden');
        expect(rec.stop).toHaveBeenCalledTimes(1);
    });

    it('0 RPM for 13 s at the mag check, then app switch -> keeps recording (no split flight)', () => {
        rec = makeRecorder({ engine: { rpm: 0, ageMs: 800 }, gps: { gs: 0, ageMs: 300 } });
        rec._rpmZeroCount = 13;
        setVisibility('hidden');
        expect(rec._flush).toHaveBeenCalled();
        expect(rec.stop).not.toHaveBeenCalled();
    });

    it('4ef751b kept for GPS-only recordings: no engine monitor, fresh GS < 10 kt -> ends', () => {
        rec = makeRecorder({ engine: null, gps: { gs: 3, ageMs: 400 } });
        setVisibility('hidden');
        expect(rec.stop).toHaveBeenCalledTimes(1);
    });

    it('GPS-only with a STALE slow ground speed -> keeps recording', () => {
        rec = makeRecorder({ engine: null, gps: { gs: 3, ageMs: 20000 } });
        setVisibility('hidden');
        expect(rec.stop).not.toHaveBeenCalled();
    });

    it('becoming visible, or hiding while not recording, does nothing', () => {
        rec = makeRecorder({ engine: { rpm: 0, ageMs: 100 }, gps: { gs: 0, ageMs: 100 } });
        setVisibility('visible');
        expect(rec.stop).not.toHaveBeenCalled();
        rec._recording = false;
        setVisibility('hidden');
        expect(rec.stop).not.toHaveBeenCalled();
        expect(rec._flush).not.toHaveBeenCalled();
    });
});
