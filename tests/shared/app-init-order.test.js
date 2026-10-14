/**
 * Engine monitoring, recording and the logbook must be wired before startup
 * waits on NASR (A4, flight-safety plan). A NASR import (18 MB parse, 98k
 * writes) or a stuck IndexedDB used to leave the tablet with no engine data,
 * engine alerts, sticky-valve check or flight recording until it finished, or
 * forever. Verified in a Chromium boot: before the change none of these existed
 * 30 s after load with IndexedDB stuck; after it, all exist within 5 s.
 * This guards the order in _initCockpit against a refactor moving them back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const src = readFileSync('web/app.js', 'utf8');
const body = src.slice(src.indexOf('async _initCockpit()'));
const nasrWait = body.indexOf('await this._ensureNasrData(');
const at = (needle) => {
    const i = body.indexOf(needle);
    expect(i, `${needle} not found in _initCockpit`).toBeGreaterThan(-1);
    return i;
};

describe('_initCockpit wires engine monitoring before the NASR wait (A4)', () => {
    it('finds the NASR wait', () => { expect(nasrWait).toBeGreaterThan(-1); });

    for (const needle of [
        'new EngineClient(', 'this.engineClient.connect()', 'new StickyValveMonitor(', 'new StickyValveBanner(',
        'new EngineGpsBridge(', 'new EnginePanel(', 'new EmergencyGlide(', 'new EngineMLBridge(',
        "addEventListener('flightsync:started'", 'new EngineOverlay(', 'new EnginePage(',
        'new FlightRecorder(', 'this.flightRecorder.init()', 'new Logbook(', 'this._recoverAfterRestart()',
    ]) {
        it(`${needle} comes before it`, () => { expect(at(needle)).toBeLessThan(nasrWait); });
    }

    it('keeps the order the modules depend on', () => {
        expect(at('new StickyValveMonitor(')).toBeLessThan(at('new EnginePage('));
        expect(at('new EnginePanel(')).toBeLessThan(at('new EnginePage('));
        expect(at('new EmergencyGlide(')).toBeLessThan(at('new EngineMLBridge('));
        expect(at('new EngineClient(')).toBeLessThan(at('new FuelTanksDisplay('));
        // The recovery may emit flightsync:stopped (close-out): the logbook must be listening.
        expect(at('new Logbook(')).toBeLessThan(at('this._recoverAfterRestart()'));
    });

    it('nothing awaits between the map and the engine wiring', () => {
        const between = body.slice(at('this.cockpitMap.init()'), at('this.flightRecorder.init()'));
        expect(between).not.toMatch(/\bawait\b/);
    });

    it('weather logging starts for a recording resumed before the FIS-B logger existed', () => {
        const init = at('this.fisbLogger.init()');
        const kick = at('if (this.flightRecorder?.recording) this.fisbLogger._onFlightStart()');
        expect(kick).toBeGreaterThan(init);
        expect(kick - init).toBeLessThan(400);
    });
});
