/**
 * Shared degrade-and-dispatch logic pulled out of gps-source.js and
 * engine-gps-bridge.js, which had hand-copied the same 15s staleness
 * watchdog shape (issue #129).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

if (typeof global.CustomEvent === 'undefined') {
    global.CustomEvent = class CustomEvent extends Event {
        constructor(t, o) { super(t); this.detail = o?.detail; }
    };
}

const src = readFileSync('web/shared/gps-staleness.js', 'utf8');
const { degradeGpsSituation, GPS_STALE_TIMEOUT_MS } = new Function(
    `${src}\nreturn { degradeGpsSituation, GPS_STALE_TIMEOUT_MS };`
)();

function makeTarget(initialSituation) {
    const target = new EventTarget();
    target.situation = initialSituation;
    return target;
}

describe('GPS_STALE_TIMEOUT_MS', () => {
    it('is 15000 — the 15s watchdog both gps-source.js and engine-gps-bridge.js document', () => {
        expect(GPS_STALE_TIMEOUT_MS).toBe(15000);
    });
});

describe('degradeGpsSituation', () => {
    it('is a no-op when there is no prior situation', () => {
        const target = makeTarget(null);
        const events = [];
        target.addEventListener('stratux:situation', e => events.push(e.detail));
        degradeGpsSituation(target);
        expect(target.situation).toBeNull();
        expect(events).toHaveLength(0);
    });

    it('sets gps_fix_quality to 0, preserves other fields, and dispatches stratux:situation', () => {
        const target = makeTarget({ lat: 35.1, lon: -80.2, gps_fix_quality: 1 });
        const events = [];
        target.addEventListener('stratux:situation', e => events.push(e.detail));
        degradeGpsSituation(target);
        expect(target.situation.gps_fix_quality).toBe(0);
        expect(target.situation.lat).toBe(35.1);
        expect(target.situation.lon).toBe(-80.2);
        expect(events).toHaveLength(1);
        expect(events[0]).toBe(target.situation);
    });
});
