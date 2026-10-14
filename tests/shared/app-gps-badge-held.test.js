// tests/shared/app-gps-badge-held.test.js
//
// While the map holds own-ship dimmed at its last fix (position stopped
// arriving, GpsFix.HOLD_MS), the GPS status badge says so: "STX GPS STALE".
// Exercises the REAL _startDeviceStatusMonitor body extracted from web/app.js.
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
const startMonitor = new Function(extractMethod(appSrc, '_startDeviceStatusMonitor() {'));
global.GpsFix = new Function(readFileSync('web/shared/gps-fix.js', 'utf8') + '\nreturn GpsFix;')();
global.GPS_SOLUTION_LABELS = { 1: 'GPS', 2: 'DGPS', 6: 'EST' };

const FIX = { lat: 34.72, lon: -80.85, gps_fix_quality: 2, gps_sats: 10 };

describe('GPS badge during an own-ship hold', () => {
    let app, el;
    beforeEach(() => {
        vi.useFakeTimers();
        el = document.createElement('span');
        app = {
            dom: { statusGps: el },
            stratuxClient: { connected: true, stale: true, situation: FIX },
            gpsSource: { label: 'STX', source: 'stratux' },
            engineGpsBridge: { active: false },
            cockpitMap: { ownshipHeld: true },
        };
    });
    afterEach(() => { clearInterval(app._deviceStatusInterval); vi.useRealTimers(); });

    it('reads "STX GPS STALE" and is not green while held', () => {
        startMonitor.call(app);
        expect(el.textContent).toBe('STX GPS STALE');
        expect(el.classList.contains('active')).toBe(false);
    });

    it('back to the normal label once the hold ends', () => {
        app.cockpitMap.ownshipHeld = false;
        app.stratuxClient.stale = false;
        startMonitor.call(app);
        expect(el.textContent).toBe('STX DGPS 10sv');
        expect(el.classList.contains('active')).toBe(true);
    });

    it('engine GPS bridge active still reads "ENG GPS" (fresh positions, no hold)', () => {
        app.engineGpsBridge.active = true;
        startMonitor.call(app);
        expect(el.textContent).toBe('ENG GPS');
    });
});
