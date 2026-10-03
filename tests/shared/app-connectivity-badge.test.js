// tests/shared/app-connectivity-badge.test.js
//
// The window 'offline' event must not force the network badge to OFFL.
// Android fires 'offline' when it decides the Stratux WiFi has no internet —
// exactly while FlyTab is connected to Stratux in flight. The badge must keep
// reflecting NetworkMode (FLT), not the browser's internet flag.
//
// Exercises the REAL _startConnectivityMonitor body extracted from web/app.js.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const startMonitor = new Function(extractMethod(appSrc, '_startConnectivityMonitor() {'));

describe('connectivity badge vs browser offline events', () => {
    let app, el;

    beforeEach(() => {
        vi.useFakeTimers();
        global.DiagLog = { log: vi.fn() };
        el = document.createElement('span');
        app = {
            dom: { statusSync: el },
            networkMode: { mode: 'flight', detect: vi.fn(async () => 'flight') },
            _updateVersionBadge: vi.fn(),
        };
        startMonitor.call(app);
    });

    afterEach(() => {
        clearInterval(app._connectivityInterval);
        vi.useRealTimers();
    });

    it('shows FLT on Stratux and keeps showing FLT after a browser offline event', async () => {
        await vi.advanceTimersByTimeAsync(0);
        expect(el.textContent).toBe('FLT');

        window.dispatchEvent(new Event('offline'));
        await vi.advanceTimersByTimeAsync(0);

        expect(el.textContent).toBe('FLT');
        expect(el.classList.contains('active')).toBe(true);
        expect(app._piConnected).toBe(true);
    });

    it('re-probes the network on an offline event and shows the result', async () => {
        await vi.advanceTimersByTimeAsync(0);
        app.networkMode.detect = vi.fn(async () => { app.networkMode.mode = 'offline'; return 'offline'; });

        window.dispatchEvent(new Event('offline'));
        await vi.advanceTimersByTimeAsync(0);

        expect(app.networkMode.detect).toHaveBeenCalled();
        expect(el.textContent).toBe('OFFL');
    });
});
