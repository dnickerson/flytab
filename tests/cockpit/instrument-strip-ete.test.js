/**
 * ETE flashed once a second on the tablet, stationary with a route loaded
 * (Dana, 2026-10-18, v11.78; Stratux ground speed 0.2-1.9 kt). Two writers:
 * the route table's leg update (1 Hz; below 10 kt the planned ETE) and the
 * older _updateRoute on every situation ('—' at 10 kt or less). While leg
 * updates are arriving, only they write ETE.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.ActiveRoute = new Function(read('web/shared/active-route.js') + '\nreturn ActiveRoute;')();
globalThis.CockpitMap = { _distNm: () => 120 };
const InstrumentStrip = new Function(read('web/cockpit/instrument-strip.js') + '\nreturn InstrumentStrip;')();

function strip() {
    const s = Object.create(InstrumentStrip.prototype);
    s._els = { ete: { textContent: '' }, dest: { textContent: '' }, hdg: { textContent: '' }, dist: { textContent: '' } };
    s._legData = null;
    ActiveRoute.setPlan({ waypoints: [{ lat: 34.7, lon: -80.8 }, { lat: 34.0, lon: -80.5 }, { lat: 33.0, lon: -80.0 }] });
    return s;
}
const leg = (s) => window.dispatchEvent(new CustomEvent('activeroute:legupdate', { detail: { destDistNm: 120, liveGs: 1.2, destEteMin: 55 } }));

describe('instrument strip ETE: one writer while leg updates arrive', () => {
    beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-18T18:30:00Z') }); });

    it('stationary (GS 0.2-1.9 kt): ETE stays the planned 55m, no flashing to —', () => {
        const s = strip();
        s._onLegUpdate = (e) => { s._legData = e.detail; s._legDataAt = Date.now(); s._updateLegFields(); };
        window.addEventListener('activeroute:legupdate', s._onLegUpdate);
        const seen = new Set();
        for (let t = 0; t < 10; t++) {                       // 10 s: leg update each second, situations at 5 Hz
            leg(s); seen.add(s._els.ete.textContent);
            for (const gs of [0.2, 1.9, 1.2, 1.5, 0.8]) {
                s._updateRoute({ lat: 34.89, lon: -80.84, ground_speed: gs });
                seen.add(s._els.ete.textContent);
                vi.advanceTimersByTime(200);
            }
        }
        window.removeEventListener('activeroute:legupdate', s._onLegUpdate);
        expect([...seen]).toEqual(['55m']);
    });

    it('the real listener records when leg data arrived', () => {
        const src = read('web/cockpit/instrument-strip.js');
        expect(src).toMatch(/this\._legData = e\.detail;\s*\n\s*this\._legDataAt = Date\.now\(\);/);
    });

    it('no leg updates (e.g. route table absent): the older path still writes ETE', () => {
        const s = strip();
        s._updateRoute({ lat: 34.89, lon: -80.84, ground_speed: 120 });
        expect(s._els.ete.textContent).not.toBe('');
        s._updateRoute({ lat: 34.89, lon: -80.84, ground_speed: 2 });
        expect(s._els.ete.textContent).toBe('—');
    });

    it('leg updates stopped more than 5 s ago: the older path takes over again', () => {
        const s = strip();
        s._legData = { destDistNm: 120, liveGs: 1, destEteMin: 55 }; s._legDataAt = Date.now();
        s._els.ete.textContent = '55m';
        vi.advanceTimersByTime(6000);
        s._updateRoute({ lat: 34.89, lon: -80.84, ground_speed: 2 });
        expect(s._els.ete.textContent).toBe('—');
    });
});
