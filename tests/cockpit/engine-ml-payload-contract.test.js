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
 *
 * Covers every field the ML plugin input (processSample()) reads from the
 * engine payload: rpm, mp, fuel flow, altitude, ground speed, all 4 CHTs,
 * all 4 EGTs, oil temp/pressure, carb temp, fuel remaining. If you're
 * adding a new field read here, add a case below too — this file is the
 * up-to-date reference for which alias in each `??` chain is the real one.
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

    // The six checks below cover every remaining field the ML plugin input
    // reads from `d` (web/cockpit/engine-ml.js's processSample() call).
    // Real field name for each, verified against engine_monitor.py's
    // FIELD_NAMES / get_status(), noted alongside its plugin-input key:
    //   cht1..cht4      <- CHT1..CHT4    (real; 2nd alias in the fallback chain)
    //   egt1..egt4      <- EGT1..EGT4    (real; 2nd alias)
    //   oil_temp        <- Oil_Temp      (real; 3rd alias)
    //   oil_press       <- Oil_Press     (real; 3rd alias)
    //   carb_temp       <- Carb_Temp     (real; 2nd alias)
    //   fuel_remaining  <- Gallons_Rem   (real; 3rd alias)
    // None of these were broken when this test was added — they're asserted
    // here so a future edit to any of these fallback chains (or a Pi-side
    // rename) fails immediately instead of waiting for a flight to surface it.

    it('reads all four CHTs from the real CHT1..CHT4 fields', async () => {
        await bridge._onEngineData(ENGINE_FRAME);
        expect(processSampleSpy).toHaveBeenCalledWith(expect.objectContaining({
            cht1: 380, cht2: 365, cht3: 370, cht4: 355,
        }));
    });

    it('reads all four EGTs from the real EGT1..EGT4 fields', async () => {
        await bridge._onEngineData(ENGINE_FRAME);
        expect(processSampleSpy).toHaveBeenCalledWith(expect.objectContaining({
            egt1: 1350, egt2: 1320, egt3: 1360, egt4: 1340,
        }));
    });

    it('reads oil temp/pressure, carb temp, and fuel remaining from their real fields', async () => {
        await bridge._onEngineData(ENGINE_FRAME);
        expect(processSampleSpy).toHaveBeenCalledWith(expect.objectContaining({
            oil_temp: 180.0,       // Oil_Temp
            oil_press: 76.0,       // Oil_Press
            carb_temp: 45.0,       // Carb_Temp
            fuel_remaining: 24.9,  // Gallons_Rem
        }));
    });
});
