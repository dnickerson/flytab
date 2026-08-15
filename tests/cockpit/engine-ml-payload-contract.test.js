/**
 * EngineMLBridge — payload field-name contract (#138)
 *
 * engine-ml.js has broken 3 separate times this way: it read a field name
 * from the engine payload / Stratux situation that was never actually
 * verified against the real wire format (`manifold_pressure`/`mp`/`MAP`
 * instead of the real `MP`; `altitude_ft`/`speed_kts` instead of the real
 * `gps_altitude`/`ground_speed`; `LocaltimeReceived`, which never existed
 * at all on Stratux's UATFrame). Each one shipped silently — the value
 * fell back to 0/undefined, no error was thrown, and nothing caught it
 * until a real flight showed a stuck phase.
 *
 * tests/fixtures/engine-messages.js already carries the *verified* Pi
 * wire shape (comment: "Exact engine monitor get_status() wire format —
 * verified from engine_monitor.py") and was sitting unused by this file.
 * This test feeds that fixture straight into _onEngineData and asserts the
 * values actually reaching the phase detector and the ML plugin match the
 * fixture's real numbers — not 0, not undefined. A future field-name
 * mismatch in this file fails this test immediately, without needing a
 * flight to surface it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

// Loaded the same way as tests/cockpit/engine-page-pi-contract.test.js —
// engine-ml.js is a classic <script> file (no module.exports), so it's
// compiled as a real script body via `new Function`, not require()/import
// (which would give it Node's isolated module scope and could hide the
// exact class of global-scope bug that broke this file once already —
// see tests/shared/phase-detector-browser-load.test.js).
const EngineMLBridge = new Function(read('web/cockpit/engine-ml.js') + '\nreturn EngineMLBridge;')();

let processSampleSpy;
let classifySpy;
let bridge;

// Situation object with NO alt_msl/ground_speed, simulating a Stratux gap —
// this is exactly the state that would let a dead d.altitude_ft/d.speed_kts
// fallback go unnoticed for months (sit.alt_msl covers the healthy-Stratux
// case; the fallback only ever matters when it's missing).
function situationWithoutStratuxAltitude() {
    return { lat: 34.7, lon: -80.8, alt_msl: undefined, ground_speed: undefined };
}

beforeEach(() => {
    processSampleSpy = vi.fn().mockResolvedValue({ phase: 'cruise', anomaly: false, score: 0 });
    globalThis.window.Capacitor = { Plugins: { EngineML: { processSample: processSampleSpy } } };
    globalThis.DiagLog = { log: vi.fn(), error: vi.fn() };

    bridge = new EngineMLBridge();
    bridge._initialized = true; // skip init()'s async plugin.initialize() round-trip
    bridge._stratuxClient = { situation: situationWithoutStratuxAltitude() };

    // Isolate field-extraction correctness from FSM correctness (already
    // covered by tests/phase-detection/) — spy on classify(), don't run the
    // real dwell-time state machine.
    classifySpy = vi.fn().mockReturnValue('cruise');
    bridge._phaseDetector = {
        classify: classifySpy,
        isPendingOrCommitted: () => false,
        getFieldElevationFt: () => null,
    };
});

afterEach(() => {
    delete globalThis.window.Capacitor;
    delete globalThis.DiagLog;
    vi.restoreAllMocks();
});

describe('EngineMLBridge — payload field-name contract', () => {
    it('reads manifold pressure (MP) from the real Pi payload, not a guessed field name', async () => {
        await bridge._onEngineData(ENGINE_FRAME);
        expect(classifySpy).toHaveBeenCalledWith(expect.objectContaining({ mp: 24.5 }));
        expect(processSampleSpy).toHaveBeenCalledWith(expect.objectContaining({ mp: 24.5 }));
    });

    it('falls back to the Pi-relayed gps_altitude / ground_speed when Stratux has no fix', async () => {
        await bridge._onEngineData(ENGINE_FRAME);
        expect(classifySpy).toHaveBeenCalledWith(expect.objectContaining({
            altitudeFt: 5000, // ENGINE_FRAME.gps_altitude
            speedKts: 150,    // ENGINE_FRAME.ground_speed
        }));
        expect(processSampleSpy).toHaveBeenCalledWith(expect.objectContaining({
            altitude: 5000,
            ground_speed: 150,
        }));
    });

    it('prefers live Stratux altitude/speed over the Pi-relayed fallback when both are present', async () => {
        bridge._stratuxClient.situation.alt_msl = 6200;
        bridge._stratuxClient.situation.ground_speed = 140;
        await bridge._onEngineData(ENGINE_FRAME);
        expect(classifySpy).toHaveBeenCalledWith(expect.objectContaining({ altitudeFt: 6200, speedKts: 140 }));
    });

    it('reads rpm and fuel flow correctly alongside mp (sanity check the fixture flattens as expected)', async () => {
        await bridge._onEngineData(ENGINE_FRAME);
        expect(classifySpy).toHaveBeenCalledWith(expect.objectContaining({ rpm: 2200, fuelFlow: 8.5 }));
    });

    it('never calls the phase detector with mp=0 on a real full-power sample', async () => {
        // Regression guard for #138: mp stuck at 0 silently blocked every
        // 'takeoff' transition regardless of real RPM/altitude/speed.
        await bridge._onEngineData({ ...ENGINE_FRAME, data: { ...ENGINE_FRAME.data, MP: 29.25, RPM: 2660 } });
        const call = classifySpy.mock.calls[0][0];
        expect(call.mp).not.toBe(0);
        expect(call.mp).toBe(29.25);
    });
});
