/**
 * WX Briefing NOTAMs when the NOTAM proxy could not fetch every location
 * (reviews 2026-10-19). The proxy lists those in `failed` -- an FAA error, or
 * its 25 s deadline, which cuts the end of the list: the destination.
 * - A partial answer was shown and cached as a complete briefing. Now what
 *   came back is shown with a warning naming what is missing, it is not
 *   cached, and it is asked again next time.
 * - The cached briefing (shown when a refresh fails) was not tied to the
 *   route: another route's NOTAMs could be shown. Now only the same stations'.
 * - En-route failures showed no warning, and cleared every NOTAM TFR on the
 *   map (in flight, with no internet, opening WX Briefing wiped them).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const WxBriefing = new Function(`${readFileSync('web/cockpit/wx-briefing.js', 'utf8')}\nreturn WxBriefing;`)();

const STATIONS = ['KLKR', 'KCAE', 'KTMB'];
function makeWx() {
    const wx = Object.create(WxBriefing.prototype);
    Object.assign(wx, {
        _notams: [], _enrouteNotams: [], _notamFetchError: null, _enrouteNotamFetchError: null,
        _notamPartial: null, _enrouteNotamPartial: null, _notamCachedAt: null,
        _notamFetchedAt: 0, _enrouteNotamFetchedAt: 0, _flightPlan: null, _notamSearch: '',
        _renderNotamSection() {}, _renderAgeGroup() {},
        _getStationList: () => [...STATIONS],
        _getRouteBbox: async () => ({ n: 34.8, s: 25.6, e: -80.3, w: -81.2 }),
    });
    return wx;
}
const answer = (body) => { globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => body })); };
// A real NMS GeoJSON feature: a runway closure at KLKR (FAA location LKR).
const RWY = { properties: { coreNOTAMData: { notam: { number: '10/001', location: 'LKR', type: 'N', classification: 'DOM',
    text: 'RWY 06/24 CLSD', effectiveStart: '2026-10-19T12:00:00Z', effectiveEnd: '2026-10-20T12:00:00Z' } } } };
/** The NOTAM section's warning lines, rendered by the real _renderNotamSection. */
function warnings(wx) {
    const sec = document.createElement('div');
    wx._section = () => sec;
    delete wx._renderNotamSection;
    wx._sortedNotams = () => [...(wx._notams || []), ...(wx._enrouteNotams || [])];
    wx._renderNotamSection();
    return [...sec.querySelectorAll('.wx-section-error')].map((e) => e.textContent);
}

beforeEach(() => {
    localStorage.clear();
    globalThis.CockpitConfig = { notamBase: 'https://fitpc.example.ts.net' };
    globalThis.Settings = { workerBase: 'https://www.flywhere.app/api' };
});
afterEach(() => { delete globalThis.fetch; delete globalThis.CockpitConfig; delete globalThis.Settings; });

describe('airport NOTAMs', () => {
    it('the destination not fetched: what came back is shown, with a warning; not cached; asked again', async () => {
        answer({ features: [RWY], failed: ['KTMB'] });
        const wx = makeWx();
        await wx._fetchNotams();
        expect(wx._notams.map((n) => n.raw || n.summary).join(' ')).toMatch(/RWY 06\/24 CLSD/);
        expect(wx._notamPartial).toEqual(['KTMB']);
        expect(wx._notamFetchedAt).toBe(0);
        expect(localStorage.getItem('flytab_notam_cache')).toBe(null);
        expect(warnings(wx)).toContain('⚠ Not fetched: KTMB — their NOTAMs are missing · tap ↻ to retry');
    });

    it('a complete answer (failed empty, or an older proxy without it) is the briefing, cached with its stations', async () => {
        for (const body of [{ features: [RWY], failed: [] }, { features: [RWY] }]) {
            localStorage.clear(); answer(body);
            const wx = makeWx(); wx._notamFetchError = 'old error';
            await wx._fetchNotams();
            expect(wx._notamFetchError).toBe(null);                          // a stale error does not linger
            expect(wx._notamPartial).toBe(null);
            expect(wx._notamFetchedAt).toBeGreaterThan(0);
            expect(JSON.parse(localStorage.getItem('flytab_notam_cache')).stations).toEqual(STATIONS);
            expect(warnings(wx)).toEqual([]);
        }
    });

    it('a failed refresh shows the cached briefing only for the same stations, with its time', async () => {
        const cached = [{ airport: 'KTMB', type: 'RWY', summary: 'RWY 9R/27L CLSD' }];
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        localStorage.setItem('flytab_notam_cache', JSON.stringify({ fetched_at: Date.parse('2026-10-19T18:52:00Z'), stations: STATIONS, data: cached }));
        const wx = makeWx();
        await wx._fetchNotams();
        expect(wx._notams).toEqual(cached);
        expect(warnings(wx)).toContain('⚠ Refresh failed — showing NOTAMs downloaded 19 1852Z · tap ↻ to retry');
        // another route's briefing, or one saved before the stations were kept: not shown
        for (const c of [{ stations: ['KAAA', 'KBBB'], data: cached }, { data: cached }]) {
            localStorage.setItem('flytab_notam_cache', JSON.stringify({ fetched_at: 1, ...c }));
            const w = makeWx();
            await w._fetchNotams();
            expect(w._notams).toEqual([]);
        }
    });
});

describe('en-route NOTAMs', () => {
    it('failed: a warning, and the TFRs on the map are not cleared', async () => {
        const tfrs = vi.fn(); document.addEventListener('notam:tfrs', tfrs);
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });   // in flight
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        expect(tfrs).not.toHaveBeenCalled();
        expect(warnings(wx)).toContain('⚠ En-route NOTAMs not fetched — TFRs and en-route restrictions may be missing · tap ↻ to retry');
        document.removeEventListener('notam:tfrs', tfrs);
    });

    it('partial: shown with a warning; its TFRs are added to the map, not replacing them; asked again', async () => {
        const replace = vi.fn(), add = vi.fn();
        document.addEventListener('notam:tfrs', replace); document.addEventListener('notam:tfrs-apt', add);
        answer({ features: [], failed: ['ZZZ'] });
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        expect(replace).not.toHaveBeenCalled();
        expect(add).toHaveBeenCalledTimes(1);
        expect(wx._enrouteNotamFetchedAt).toBe(0);
        expect(warnings(wx)).toContain('⚠ En-route NOTAMs not fetched for ZZZ — TFRs may be missing · tap ↻ to retry');
        document.removeEventListener('notam:tfrs', replace); document.removeEventListener('notam:tfrs-apt', add);
    });

    it('complete: the map\'s NOTAM TFRs are replaced as before', async () => {
        const replace = vi.fn(); document.addEventListener('notam:tfrs', replace);
        answer({ features: [], failed: [] });
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        expect(replace).toHaveBeenCalledTimes(1);
        expect(wx._enrouteNotamFetchedAt).toBeGreaterThan(0);
        document.removeEventListener('notam:tfrs', replace);
    });
});
