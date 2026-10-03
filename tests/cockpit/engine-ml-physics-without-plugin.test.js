/**
 * EngineMLBridge — the Layer 1 physics rules (oil pressure, CHT, MAP drop,
 * RPM drop, fuel-flow collapse) must run whether or not the EngineML plugin
 * is up. _onEngineData used to return on its first line when !_initialized,
 * so a failed or missing plugin silently took every one of these checks
 * with it -- despite start()'s comment saying they run without the plugin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ENGINE_FRAME } = require('../fixtures/engine-messages.js');
const read = (p) => readFileSync(p, 'utf8');
const EngineMLBridge = new Function(read('web/cockpit/engine-ml.js') + '\nreturn EngineMLBridge;')();

/** The Pi frame with some EDM fields overridden. */
const frame = (row) => ({ ...ENGINE_FRAME, data: { ...ENGINE_FRAME.data, ...row } });
const LOW_OIL = frame({ RPM: 2400, Oil_Press: 15 });

let bridge, advisories;
beforeEach(() => {
    globalThis.DiagLog = { log: vi.fn() };
    advisories = [];
    document.addEventListener('engineml:advisory', onAdv);
});
afterEach(() => {
    document.removeEventListener('engineml:advisory', onAdv);
    delete globalThis.window.Capacitor;
    delete globalThis.DiagLog;
    vi.restoreAllMocks();
});
function onAdv(e) { advisories.push(e.detail); }

function makeBridge({ plugin = null, initialized = false } = {}) {
    if (plugin) globalThis.window.Capacitor = { Plugins: { EngineML: plugin } };
    else delete globalThis.window.Capacitor;
    const b = new EngineMLBridge();
    b._initialized = initialized;
    b._stratuxClient = { situation: { lat: 34.7, lon: -80.8, alt_msl: 3000, ground_speed: 120 } };
    b._phaseDetector = { classify: vi.fn().mockReturnValue('cruise'), isPendingOrCommitted: () => false, getFieldElevationFt: () => null };
    return b;
}

describe('EngineMLBridge physics rules', () => {
    it('run with no EngineML plugin at all (browser / plugin missing)', async () => {
        bridge = makeBridge();
        await bridge._onEngineData(LOW_OIL);
        expect(advisories.map(a => a.type)).toEqual(['oil_pressure_critical']);
    });

    it('run when the plugin is present but failed to initialize', async () => {
        const processSample = vi.fn();
        bridge = makeBridge({ plugin: { processSample }, initialized: false });
        await bridge._onEngineData(frame({ RPM: 2400, CHT2: 455 }));
        expect(advisories.map(a => a.type)).toEqual(['cht2_exceedance']);
        expect(processSample).not.toHaveBeenCalled();   // no ML without a working plugin
    });

    it('still run once (not twice) alongside ML when the plugin is up', async () => {
        const processSample = vi.fn().mockResolvedValue({ phase: 'cruise', anomaly: false, score: 0 });
        bridge = makeBridge({ plugin: { processSample }, initialized: true });
        await bridge._onEngineData(LOW_OIL);
        expect(advisories.map(a => a.type)).toEqual(['oil_pressure_critical']);
        expect(processSample).toHaveBeenCalledTimes(1);
    });

    it('without the plugin, the previous sample is kept so the airborne MAP-drop check works', async () => {
        bridge = makeBridge();
        bridge._hasLaunched = true;
        bridge._updateLaunchState = () => {};            // hold "airborne" for this check
        await bridge._onEngineData(frame({ RPM: 2400, MP: 24.5 }));
        await bridge._onEngineData(frame({ RPM: 2400, MP: 19.0 }));
        expect(advisories.map(a => a.type)).toContain('map_sudden_drop');
    });

    it('without the plugin, phase tracking still runs', async () => {
        bridge = makeBridge();
        await bridge._onEngineData(ENGINE_FRAME);
        expect(bridge._phaseDetector.classify).toHaveBeenCalledTimes(1);
        expect(bridge._flightPhase).toBe('cruise');
    });

    it('normal readings raise nothing', async () => {
        bridge = makeBridge();
        await bridge._onEngineData(ENGINE_FRAME);
        expect(advisories).toEqual([]);
    });
});

describe('EngineMLBridge.start', () => {
    it('logs a phase_spec.json load failure to DiagLog (the old DiagLog.error call did nothing)', async () => {
        bridge = makeBridge();
        window.loadPhaseSpec = vi.fn().mockRejectedValue(new Error('404'));
        bridge.start(new EventTarget(), null);
        await bridge._phaseDetectorReady;
        expect(DiagLog.log).toHaveBeenCalledWith('error', expect.stringContaining('phase_spec.json'));
        delete window.loadPhaseSpec;
    });
});
