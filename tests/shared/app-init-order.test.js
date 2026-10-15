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

    // PR A review #7: since the block runs before NASR, one subsystem failing must
    // not stop the rest (airport data, popup, route table...).
    it('each engine/recording subsystem is started through _guard', () => {
        const block = body.slice(at('// ---- Engine monitoring, flight recording and logbook'), at('// ---- end of engine / recording / logbook ----'));
        for (const name of ['Engine client', 'Sticky-valve check', 'Engine GPS bridge', 'Engine panel', 'Emergency glide',
            'Engine ML', 'Engine overlay', 'ENG page', 'Flight recorder', 'Logbook']) {
            expect(block).toContain(`this._guard('${name}', () => {`);
        }
        // Every constructor in the block is inside one of them: cut out each guarded
        // region (from "this._guard(" to its matching close) and nothing is left.
        let rest = block;
        for (let i; (i = rest.indexOf('this._guard(')) >= 0;) {
            const open = rest.indexOf('{', i);
            let d = 0, j = open;
            for (; j < rest.length; j++) { if (rest[j] === '{') d++; else if (rest[j] === '}' && --d === 0) break; }
            rest = rest.slice(0, i) + rest.slice(j + 1);
        }
        expect(rest).not.toMatch(/\bnew [A-Z]\w+\(/);
        expect(block.match(/\bnew [A-Z]\w+\(/g).length).toBeGreaterThanOrEqual(10);
    });

    // PR A review #10: they must run even if _initCockpit stalls on NASR.
    it('the hang watchdog and pause detector start before _initCockpit', () => {
        const init = src.slice(src.indexOf('    async init() {'), src.indexOf('    async _initCockpit() {'));
        expect(init.indexOf('this._startWatchdog()')).toBeGreaterThan(-1);
        expect(init.indexOf('this._startWatchdog()')).toBeLessThan(init.indexOf('await this._initCockpit()'));
        expect(init.indexOf('this._startPauseDetector()')).toBeLessThan(init.indexOf('await this._initCockpit()'));
    });
});

describe('_guard', () => {
    const extract = (sig) => {
        const start = src.indexOf(sig), open = src.indexOf('{', start);
        let d = 0;
        for (let i = open; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(open + 1, i); }
    };
    const guard = new Function('name', 'fn', extract('    _guard(name, fn) {'));

    it('a subsystem that throws is logged and the caller carries on', () => {
        globalThis.DiagLog = { log: (...a) => (globalThis.__logged = a) };
        const spy = console.error; console.error = () => {};
        expect(guard('Logbook', () => { throw new Error('boom'); })).toBeUndefined();
        console.error = spy;
        expect(globalThis.__logged).toEqual(['error', 'Logbook failed to start: boom']);
        expect(guard('Engine client', () => 42)).toBe(42);
    });
});
