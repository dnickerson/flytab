/**
 * WX Briefing NOTAMs when the NOTAM proxy could not fetch every location
 * (review 2026-10-19). The proxy now lists those in `failed` -- an FAA error,
 * or its 25 s deadline, which cuts the end of the list: the destination. A
 * partial answer was shown as a complete briefing and cached. And a failed
 * en-route fetch cleared every NOTAM TFR on the map (in flight, with no
 * internet, opening WX Briefing wiped them).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const WxBriefing = new Function(`${readFileSync('web/cockpit/wx-briefing.js', 'utf8')}\nreturn WxBriefing;`)();

function makeWx() {
    const wx = Object.create(WxBriefing.prototype);
    Object.assign(wx, {
        _notams: [], _enrouteNotams: [], _notamFetchError: null, _enrouteNotamFetchError: null,
        _notamFetchedAt: 0, _enrouteNotamFetchedAt: 0, _flightPlan: null,
        _renderNotamSection() {}, _renderAgeGroup() {},
        _getStationList: () => ['KLKR', 'KCAE', 'KTMB'],
        _getRouteBbox: async () => ({ n: 34.8, s: 25.6, e: -80.3, w: -81.2 }),
    });
    return wx;
}
const answer = (body) => { globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => body })); };

beforeEach(() => {
    localStorage.clear();
    globalThis.CockpitConfig = { notamBase: 'https://fitpc.example.ts.net' };
    globalThis.Settings = { workerBase: 'https://www.flywhere.app/api' };
});
afterEach(() => { delete globalThis.fetch; delete globalThis.CockpitConfig; delete globalThis.Settings; });

describe('airport NOTAMs: a partial answer is not a briefing', () => {
    it('the destination not fetched: the cached briefing stays, the error names it, no fresh time', async () => {
        const cached = [{ airport: 'KTMB', type: 'RWY', summary: 'RWY 9R/27L CLSD' }];
        localStorage.setItem('flytab_notam_cache', JSON.stringify({ fetched_at: 1, data: cached }));
        answer({ features: [], failed: ['KTMB'] });
        const wx = makeWx();
        await wx._fetchNotams();
        expect(wx._notamFetchError).toBe('NOTAMs not fetched for KTMB');
        expect(wx._notams).toEqual(cached);                                   // shown with "Refresh failed — showing cached data"
        expect(wx._notamFetchedAt).toBe(0);                                   // asked again next time
        expect(JSON.parse(localStorage.getItem('flytab_notam_cache')).data).toEqual(cached);
    });

    it('a complete answer (failed empty, or an older proxy without it) is used as before', async () => {
        for (const body of [{ features: [], failed: [] }, { features: [] }]) {
            localStorage.clear(); answer(body);
            const wx = makeWx();
            await wx._fetchNotams();
            expect(wx._notamFetchError).toBe(null);
            expect(wx._notamFetchedAt).toBeGreaterThan(0);
            expect(localStorage.getItem('flytab_notam_cache')).not.toBe(null);
        }
    });
});

describe('en-route NOTAMs', () => {
    it('a partial answer is an error; the TFRs on the map are not cleared', async () => {
        const tfrs = vi.fn(); document.addEventListener('notam:tfrs', tfrs);
        answer({ features: [], failed: ['ZZZ'] });
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        expect(wx._enrouteNotamFetchError).toBe('En-route NOTAMs not fetched for ZZZ');
        expect(tfrs).not.toHaveBeenCalled();
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });   // in flight
        await wx._fetchEnrouteNotams();
        expect(tfrs).not.toHaveBeenCalled();
        document.removeEventListener('notam:tfrs', tfrs);
    });

    it('a complete answer still sends the TFR shapes (none here) to the map', async () => {
        const tfrs = vi.fn(); document.addEventListener('notam:tfrs', tfrs);
        answer({ features: [], failed: [] });
        await makeWx()._fetchEnrouteNotams();
        expect(tfrs).toHaveBeenCalledTimes(1);
        document.removeEventListener('notam:tfrs', tfrs);
    });
});
