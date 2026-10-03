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

    it('launch/landing tracking (GPS-driven) keeps going through frozen frames', async () => {
        bridge._stratuxClient.situation = { lat: 34.7, lon: -80.8, alt_msl: 600, ground_speed: 5 };
        bridge._hasLaunched = true;                       // was airborne, now rolled out
        await feed(frame({}, FROZEN));
        expect(bridge._hasLaunched).toBe(false);
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

    it('a frozen frame clears the delta reference', async () => {
        await feed(frame({ RPM: 2400, MP: 24.5 }));
        expect(bridge._prevSample).not.toBeNull();
        await feed(frame({}, FROZEN));
        expect(bridge._prevSample).toBeNull();
    });

    it('a clock stepping backwards is a hole too', async () => {
        airborne();
        await feed(frame({ RPM: 2400, MP: 24.5 }));
        now -= 60_000;
        await feed(frame({ RPM: 2400, MP: 18.0 }));
        expect(advisories).not.toContain('map_sudden_drop');
    });
});

describe('EngineMLBridge — repeated EDM rows (data_count unchanged)', () => {
    // serial_warning only appears after 5 s of silence; before that the Pi is
    // already resending its last row with the same data_count.
    const counted = (n, row) => ({ ...frame(row), data_count: n });

    it('a copy of the last row is not judged or fed to the ML plugin', async () => {
        await feed(counted(10, { RPM: 2400, Oil_Press: 15 }));
        now += 10_000;                                     // past the advisory rate limit
        await feed(counted(10, { RPM: 2400, Oil_Press: 15 }));
        await feed(counted(10, { RPM: 2400, Oil_Press: 15 }));
        expect(advisories).toEqual(['oil_pressure_critical']);
        expect(processSample).toHaveBeenCalledTimes(1);
    });

    it('a copy in between does not break the drop check across it', async () => {
        airborne();
        await feed(counted(10, { RPM: 2400, MP: 24.5 }));
        await feed(counted(10, { RPM: 2400, MP: 24.5 }));
        await feed(counted(11, { RPM: 2400, MP: 18.0 }));
        expect(advisories).toContain('map_sudden_drop');
    });

    it('a new row (Pi restarted, count back near 0) is judged', async () => {
        await feed(counted(500, {}));
        await feed(counted(1, { RPM: 2400, Oil_Press: 15 }));
        expect(advisories).toEqual(['oil_pressure_critical']);
    });

    it('frames without data_count (older Pi) are all judged', async () => {
        await feed(frame({}));
        await feed(frame({}));
        expect(processSample).toHaveBeenCalledTimes(2);
    });
});

describe('EngineMLBridge — delta reference and slow plugin calls', () => {
    function pendingPlugin() {
        const calls = [];
        processSample.mockImplementation(() => new Promise(res => calls.push(res)));
        return calls;
    }
    const OK = { phase: 'cruise', anomaly: false, score: 0 };

    it('the next sample compares against this one even while the plugin call is still out', async () => {
        airborne();
        pendingPlugin();
        bridge._onEngineData(frame({ RPM: 2400, MP: 24.5 })); now += 1000;   // not awaited
        await Promise.resolve();
        bridge._onEngineData(frame({ RPM: 2400, MP: 18.0 })); now += 1000;
        await Promise.resolve();
        expect(advisories).toContain('map_sudden_drop');
    });

    it('a call that finishes late does not undo a reset made meanwhile', async () => {
        const calls = pendingPlugin();
        const first = bridge._onEngineData(frame({ RPM: 2400, MP: 24.5 })); now += 1000;
        await Promise.resolve();
        await feed(frame({}, FROZEN));                     // resets the reference
        calls[0](OK);
        await first;
        expect(bridge._prevSample).toBeNull();
    });

    it('the emergency trigger uses the same reference: fires on a drop between samples, not across a hole', async () => {
        airborne();
        const trigger = vi.fn();
        window.emergencyGlide = { trigger };
        globalThis.EmergencyGlide = function () {};
        bridge._altHistory = [5000];
        processSample.mockResolvedValue({ phase: 'cruise', anomaly: true, score: 1 });

        await feed(frame({ RPM: 2400, MP: 24.5 }));
        now += 30_000;                                     // hole
        await feed(frame({ RPM: 2000, MP: 18.0 }));
        expect(trigger).not.toHaveBeenCalled();

        await feed(frame({ RPM: 2400, MP: 24.5 }));
        await feed(frame({ RPM: 2000, MP: 18.0 }));
        expect(trigger).toHaveBeenCalledTimes(1);
        delete window.emergencyGlide;
        delete globalThis.EmergencyGlide;
    });
});
