// tests/shared/app-watchdog-onscreen.test.js
//
// A6: KeepAliveWebView tells Chromium the page is always visible (so it isn't
// frozen when hidden). Off screen, requestAnimationFrame still stops (no frames
// are drawn), so the rAF hang watchdog must judge by the REAL on-screen state
// (app._onScreen, from MainActivity), or it logs a false "JS hang" every few
// seconds -- seen on the tablet: 49 in 9 min with the screen off.
// Exercises the REAL _startWatchdog body from web/app.js.
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

const startWatchdog = new Function(extractMethod(readFileSync('web/app.js', 'utf8'), '_startWatchdog() {'));

describe('hang watchdog vs the real on-screen state', () => {
    let app, rafCbs;
    beforeEach(() => {
        vi.useFakeTimers();
        rafCbs = [];
        global.requestAnimationFrame = (cb) => { rafCbs.push(cb); return rafCbs.length; };
        global.DiagLog = { log: vi.fn() };
        document.body.innerHTML = '<span id="statusVersion"></span>';
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        app = { _onScreen: true };
    });
    afterEach(() => vi.useRealTimers());

    const frame = () => { const cbs = rafCbs; rafCbs = []; cbs.forEach((cb) => cb()); };

    it('on screen with frames: no hang', () => {
        startWatchdog.call(app);
        for (let i = 0; i < 10; i++) { vi.advanceTimersByTime(1000); frame(); }
        expect(DiagLog.log).not.toHaveBeenCalled();
    });

    it('on screen, frames stop: a real hang is still reported', () => {
        startWatchdog.call(app);
        frame();
        vi.advanceTimersByTime(12000);
        expect(DiagLog.log).toHaveBeenCalledWith('error', expect.stringMatching(/JS hang/));
        expect(document.getElementById('statusVersion').style.background).not.toBe('');
    });

    it('screen off (page still "visible" to Chromium), no frames: nothing logged, badge untouched', () => {
        startWatchdog.call(app);
        frame();
        app._onScreen = false;
        vi.advanceTimersByTime(60000);
        expect(DiagLog.log).not.toHaveBeenCalled();
        expect(document.getElementById('statusVersion').style.background).toBe('');
    });

    it('back on screen after a long time off: the stale frame time is not a hang', () => {
        startWatchdog.call(app);
        frame();
        app._onScreen = false;
        vi.advanceTimersByTime(120000);
        app._onScreen = true;
        window.dispatchEvent(Object.assign(new Event('flytab:screen'), { onScreen: true }));
        vi.advanceTimersByTime(1000);
        frame();
        vi.advanceTimersByTime(2500);
        expect(DiagLog.log).not.toHaveBeenCalled();
    });
});
