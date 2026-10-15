// tests/shared/app-thermal-wakelock.test.js
//
// A5: a hot tablet (surface >= 50 °C) used to release the screen wake lock
// whatever was happening, so in flight the screen would go dark after the
// screen timeout (10 min on the tablet) and Android would pause FlyTab: no
// engine alerts, no recording. Now heat releases it only when no flight is
// being recorded; a flight starting re-takes it. Exercises the REAL method
// bodies from web/app.js against a fake navigator.wakeLock.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

function extractMethod(source, signature) {
    const start = source.indexOf(signature);
    if (start < 0) throw new Error(`method not found: ${signature}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error('unbalanced braces');
}

const appSrc = readFileSync('web/app.js', 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const methods = {
    _acquireWakeLock: new AsyncFunction(extractMethod(appSrc, 'async _acquireWakeLock() {')),
    _releaseWakeLock: new Function(extractMethod(appSrc, '_releaseWakeLock() {')),
    _initThermalMonitor: new Function(extractMethod(appSrc, '_initThermalMonitor() {')),
    _applyThermalWakeLock: new Function(extractMethod(appSrc, '_applyThermalWakeLock() {')),
};
const ThermalMonitorClass = new Function(readFileSync('web/cockpit/thermal-monitor.js', 'utf8') + '\nreturn ThermalMonitor;')();

/** navigator.wakeLock stand-in: counts locks actually held. */
function fakeWakeLock() {
    const held = new Set();
    let pending = [];
    const api = {
        held,
        deferRequests: false,
        resolvePending() { const p = pending; pending = []; p.forEach((f) => f()); },
        request: vi.fn(() => {
            const make = () => {
                const s = { type: 'screen', released: false, release: vi.fn(async () => { s.released = true; held.delete(s); }) };
                held.add(s);
                return s;
            };
            if (api.deferRequests) return new Promise((res) => pending.push(() => res(make())));
            return Promise.resolve(make());
        }),
    };
    return api;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('screen wake lock vs a hot tablet (A5)', () => {
    let app, wl;
    beforeEach(() => {
        wl = fakeWakeLock();
        Object.defineProperty(navigator, 'wakeLock', { value: wl, configurable: true });
        global.DiagLog = { log: vi.fn() };
        global.ThermalMonitor = class extends ThermalMonitorClass { start() {} };
        document.body.innerHTML = '<span id="statusThermal"></span>';
        app = Object.assign({ flightRecorder: { recording: false } }, methods);
    });

    // The real poll path: plugin reading -> lastData -> badge -> warning (+ app's wrapper).
    const heat = (surfaceTemp) => {
        const tm = app.thermalMonitor;
        tm._badge = document.getElementById('statusThermal');
        tm._plugin = { getThermal: async () => ({ surfaceTemp, cpuTemp: 60, skinTemp: surfaceTemp, headroom: -1, statusCode: 0 }) };
        return tm._poll();
    };

    it('on the ground, hot: the screen may time out; cooled: kept on again', async () => {
        await app._acquireWakeLock();
        app._initThermalMonitor();
        await heat(52); await flush();
        expect(wl.held.size).toBe(0);
        await heat(44); await flush();
        expect(wl.held.size).toBe(1);
    });

    it('in flight, hot: the screen stays on', async () => {
        await app._acquireWakeLock();
        app._initThermalMonitor();
        app.flightRecorder.recording = true;
        await heat(55); await flush();
        expect(wl.held.size).toBe(1);
        expect(DiagLog.log).not.toHaveBeenCalledWith('thermal', expect.stringMatching(/released/i));
    });

    it('hot on the ground, then the engine starts: the screen lock is taken again', async () => {
        await app._acquireWakeLock();
        app._initThermalMonitor();
        await heat(52); await flush();
        expect(wl.held.size).toBe(0);
        app.flightRecorder.recording = true;
        window.dispatchEvent(new CustomEvent('flightsync:started'));
        await flush();
        expect(wl.held.size).toBe(1);
    });

    it('still hot when the flight ends: released again after shutdown', async () => {
        await app._acquireWakeLock();
        app._initThermalMonitor();
        app.flightRecorder.recording = true;
        await heat(52); await flush();
        expect(wl.held.size).toBe(1);
        app.flightRecorder.recording = false;
        window.dispatchEvent(new CustomEvent('flightsync:stopped'));
        await flush();
        expect(wl.held.size).toBe(0);
    });

    it('the warning says to shade the tablet in flight, and screen-off OK only on the ground', async () => {
        app._initThermalMonitor();
        await heat(52);
        expect(document.getElementById('thermalWarning').textContent).toMatch(/SCREEN OFF OK/);
        app.flightRecorder.recording = true;
        window.dispatchEvent(new CustomEvent('flightsync:started'));
        await flush();
        const text = document.getElementById('thermalWarning').textContent;
        expect(text).toMatch(/52°C/);
        expect(text).toMatch(/SHADE/);
        expect(text).not.toMatch(/SCREEN OFF/);
        app.thermalMonitor._warningEl?.remove();
    });

    it('two overlapping requests leave one lock, which a release really releases', async () => {
        wl.deferRequests = true;
        const a = app._acquireWakeLock();
        const b = app._acquireWakeLock();
        wl.resolvePending();
        await a; await b;
        expect(wl.held.size).toBe(1);
        app._releaseWakeLock();
        await flush();
        expect(wl.held.size).toBe(0);
    });

    it('a release while a request is still pending wins', async () => {
        wl.deferRequests = true;
        const a = app._acquireWakeLock();
        app._releaseWakeLock();
        wl.resolvePending();
        await a; await flush();
        expect(wl.held.size).toBe(0);
    });

    it('no flight recorder yet (startup): treated as on the ground', async () => {
        app.flightRecorder = undefined;
        await app._acquireWakeLock();
        app._initThermalMonitor();
        await heat(52); await flush();
        expect(wl.held.size).toBe(0);
    });

    // PR A review #11: the page never looks hidden (KeepAliveWebView), so the
    // lock is also taken back on the real return to screen.
    it('back on screen: the lock is taken again unless heat released it', async () => {
        const initBody = extractMethod(appSrc, '    async init() {');
        const listener = initBody.slice(initBody.indexOf("window.addEventListener('flytab:screen'"));
        expect(listener).toMatch(/e\.onScreen && !this\._thermalWakeLockReleased\) this\._acquireWakeLock\(\)/);
    });
});
