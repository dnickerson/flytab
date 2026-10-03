/**
 * EngineMLBridge — frozen EDM data.
 *
 * engine_monitor.py keeps resending its last parsed EDM row every second after
 * the EDM goes quiet, with serial_warning set (serial_connected false once the
 * port closes). The physics rules used to judge those frames, so an old low
 * oil-pressure reading repeated its "act now" advisory every 5 s, and the ML
 * window filled with copies of one sample. And after any hole in the data the
 * MAP/RPM drop checks compared against a sample from before it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');
const read = (p) => readFileSync(p, 'utf8');
globalThis.EngineClient = new Function(read('web/shared/engine-client.js') + '\nreturn EngineClient;')();
const EngineMLBridge = new Function(read('web/cockpit/engine-ml.js') + '\nreturn EngineMLBridge;')();

const frame = (row, top = {}) => ({ ...ENGINE_FRAME, ...top, data: { ...ENGINE_FRAME.data, ...row } });
const FROZEN = { serial_warning: 'No data from EDM for 6s' };

let bridge, advisories, now, processSample;
function onAdv(e) { advisories.push(e.detail.type); }

beforeEach(() => {
    globalThis.DiagLog = { log: vi.fn() };
    advisories = [];
    document.addEventListener('engineml:advisory', onAdv);
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    processSample = vi.fn().mockResolvedValue({ phase: 'cruise', anomaly: false, score: 0 });
    globalThis.window.Capacitor = { Plugins: { EngineML: { processSample } } };
    bridge = new EngineMLBridge();
    bridge._initialized = true;
    bridge._stratuxClient = { situation: { lat: 34.7, lon: -80.8, alt_msl: 3000, ground_speed: 120 } };
    bridge._phaseDetector = { classify: vi.fn().mockReturnValue('cruise'), isPendingOrCommitted: () => false, getFieldElevationFt: () => null };
});
afterEach(() => {
    document.removeEventListener('engineml:advisory', onAdv);
    delete globalThis.window.Capacitor;
    delete globalThis.DiagLog;
    vi.restoreAllMocks();
});

/** One sample, then advance the clock 1 s. */
async function feed(f) { await bridge._onEngineData(f); now += 1000; }

/** Airborne, so the MAP/RPM drop checks are live. */
function airborne() { bridge._hasLaunched = true; bridge._updateLaunchState = () => {}; }

describe('EngineMLBridge — frozen EDM frames', () => {
    it('a frozen frame with low oil pressure raises nothing; a current one does', async () => {
        await feed(frame({ RPM: 2400, Oil_Press: 15 }, FROZEN));
        expect(advisories).toEqual([]);
        await feed(frame({ RPM: 2400, Oil_Press: 15 }));
        expect(advisories).toEqual(['oil_pressure_critical']);
    });

    it('frames with the serial port closed are skipped too', async () => {
        await feed(frame({ RPM: 2400, CHT1: 460 }, { serial_connected: false }));
        expect(advisories).toEqual([]);
    });

    it('frozen frames are not fed to the ML plugin or the phase detector', async () => {
        await feed(frame({}, FROZEN));
        await feed(frame({}, FROZEN));
        expect(processSample).not.toHaveBeenCalled();
        expect(bridge._phaseDetector.classify).not.toHaveBeenCalled();
        await feed(frame({}));
        expect(processSample).toHaveBeenCalledTimes(1);
    });
});

describe('EngineMLBridge — delta checks across a data hole', () => {
    it('a MAP change made while the EDM was frozen is not a "sudden drop"', async () => {
        airborne();
        await feed(frame({ RPM: 2400, MP: 24.5 }));
        for (let i = 0; i < 20; i++) await feed(frame({ RPM: 2400, MP: 24.5 }, FROZEN));
        await feed(frame({ RPM: 2400, MP: 18.0 }));       // pilot reduced power meanwhile
        expect(advisories).not.toContain('map_sudden_drop');
    });

    it('nor is one made while no frames arrived at all (Pi stale / disconnected)', async () => {
        airborne();
        await feed(frame({ RPM: 2400, MP: 24.5 }));
        now += 30_000;
        await feed(frame({ RPM: 2000, MP: 18.0 }));
        expect(advisories).not.toContain('map_sudden_drop');
        expect(advisories).not.toContain('rpm_sudden_drop');
    });

    it('a real drop between consecutive current samples is still caught', async () => {
        airborne();
        await feed(frame({ RPM: 2400, MP: 24.5 }));
        await feed(frame({ RPM: 2000, MP: 18.0 }));
        expect(advisories).toEqual(expect.arrayContaining(['map_sudden_drop', 'rpm_sudden_drop']));
    });

    it('a 2 s HTTP-poll interval is not a hole', async () => {
        airborne();
        await feed(frame({ RPM: 2400, MP: 24.5 }));
        now += 1000;                                     // 2 s between samples
        await feed(frame({ RPM: 2400, MP: 18.0 }));
        expect(advisories).toContain('map_sudden_drop');
    });

    it("the emergency trigger's MAP/RPM memory is cleared by a frozen frame too", async () => {
        await feed(frame({ RPM: 2400, MP: 24.5 }));
        expect(bridge._prevMAP).toBe(24.5);
        await feed(frame({}, FROZEN));
        expect(bridge._prevMAP).toBeNull();
        expect(bridge._prevRPM).toBeNull();
        expect(bridge._prevSample).toBeNull();
    });
});
