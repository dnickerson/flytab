/**
 * WX Briefing NOTAMs (Dana, 2026-10-19: fix the issues the NOTAM reviews found
 * on main). NOTAMs are now kept per station / ARTCC:
 * - a failed en-route refresh cleared every NOTAM TFR on the map (in flight,
 *   with no internet, opening WX Briefing wiped them); and a successful one
 *   cleared the airport TFRs too;
 * - "Refresh failed" stayed after a later refresh worked;
 * - the cached briefing was shown for another route;
 * - a partial answer (stations the FAA did not answer) looked complete;
 * - en-route failures were not shown;
 * - a new route showed the old route's NOTAMs for up to 15 min;
 * - the TFR popup put FAA text in as HTML.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const WxBriefing = new Function(`${read('web/cockpit/wx-briefing.js')}\nreturn WxBriefing;`)();

let stations = ['KLKR', 'KCAE', 'KTMB'];
function makeWx() {
    const wx = Object.create(WxBriefing.prototype);
    Object.assign(wx, {
        _notams: [], _enrouteNotams: [], _notamFetchError: null, _enrouteNotamFetchError: null,
        _notamStale: null, _notamMissing: null, _enrouteNotamStale: null, _enrouteNotamMissing: null,
        _notamFetchedAt: 0, _enrouteNotamFetchedAt: 0, _flightPlan: null, _notamSearch: '', visible: false,
        _renderNotamSection() {}, _renderAgeGroup() {},
        _getStationList: () => [...stations],
        _getRouteBbox: async () => ({ n: 34.8, s: 25.6, e: -80.3, w: -81.2 }),
        _nearestArtccs: () => ['KZJX', 'KZTL'],
    });
    return wx;
}
const feat = (location, text, extra = {}) => ({ properties: { coreNOTAMData: { notam: {
    number: `${location}-${text.length}`, location, type: 'N', text,
    effectiveStart: '2026-10-19T12:00:00Z', effectiveEnd: '2026-10-25T12:00:00Z', ...extra } } } });
const answer = (body) => { globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => body })); };
const offline = () => { globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }); };
const texts = (list) => (list || []).map((n) => n.raw || n.summary).join(' | ');
/** The NOTAM section's warning lines, from the real _renderNotamSection. */
function warnings(wx) {
    const sec = document.createElement('div');
    wx._section = () => sec;
    delete wx._renderNotamSection;
    wx._renderNotamSection();
    return [...sec.querySelectorAll('.wx-section-error')].map((e) => e.textContent);
}
const T0 = '2026-10-19T18:52:00Z';
const at = (iso) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
    vi.useFakeTimers({ now: new Date(T0), toFake: ['Date'] });
    localStorage.clear();
    stations = ['KLKR', 'KCAE', 'KTMB'];
    globalThis.CockpitConfig = { notamBase: 'https://fitpc.example.ts.net' };
    globalThis.Settings = { workerBase: 'https://www.flywhere.app/api' };
});
afterEach(() => { vi.useRealTimers(); delete globalThis.fetch; delete globalThis.CockpitConfig; delete globalThis.Settings; });

describe('airport NOTAMs, kept per station', () => {
    it('a complete answer: shown, saved per station, fresh for 15 min, no warnings', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD'), feat('TMB', 'RWY 9R/27L CLSD')], failed: [] });
        const wx = makeWx();
        await wx._fetchNotams();
        expect(texts(wx._notams)).toMatch(/RWY 06\/24 CLSD.*RWY 9R\/27L CLSD|RWY 9R\/27L CLSD.*RWY 06\/24 CLSD/);
        expect(wx._notamFetchedAt).toBe(Date.parse(T0));
        expect(Object.keys(JSON.parse(localStorage.getItem('flytab_notam_cache')).bins).sort()).toEqual(['KCAE', 'KLKR', 'KTMB']);
        expect(warnings(wx)).toEqual([]);
    });

    it('a station the FAA did not answer: its last downloaded NOTAMs, with their time; asked again next open', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD'), feat('TMB', 'RWY 9R/27L CLSD')], failed: [] });
        await makeWx()._fetchNotams();
        at('2026-10-19T20:10:00Z');
        answer({ features: [feat('LKR', 'TWY A CLSD')], failed: ['KTMB'] });
        const wx = makeWx();
        await wx._fetchNotams();
        expect(texts(wx._notams)).toMatch(/TWY A CLSD/);                       // fresh KLKR
        expect(texts(wx._notams)).not.toMatch(/RWY 06\/24/);                   // KLKR's old one replaced
        expect(texts(wx._notams)).toMatch(/RWY 9R\/27L CLSD/);                 // KTMB from 1852Z
        expect(wx._notamFetchedAt).toBe(0);
        expect(warnings(wx)).toContain('⚠ Not refreshed — showing NOTAMs downloaded earlier: KTMB 19 1852Z · tap ↻ to retry');
    });

    it('never downloaded for that station: says so', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD')], failed: ['KTMB'] });
        const wx = makeWx();
        await wx._fetchNotams();
        expect(warnings(wx)).toContain('⚠ KTMB: NOTAMs NOT AVAILABLE — never downloaded · tap ↻ to retry');
    });

    it('offline (in flight): every station\'s last NOTAMs and the airport TFRs are shown again', async () => {
        const tfr = '!FDC 6/0128 ZJX FL..AIRSPACE MAYPORT, FL..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 3NM RADIUS OF 302300N0812500W SFC-3000FT';
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD'), feat('TMB', tfr)], failed: [] });
        await makeWx()._fetchNotams();
        offline();
        const apt = vi.fn(); document.addEventListener('notam:tfrs-apt', apt);
        const wx = makeWx();
        await wx._fetchNotams();
        expect(texts(wx._notams)).toMatch(/RWY 06\/24 CLSD/);
        expect(warnings(wx)[0]).toMatch(/^⚠ Refresh failed — showing NOTAMs downloaded earlier: KLKR 19 1852Z, KCAE 19 1852Z, KTMB 19 1852Z/);
        expect(apt).toHaveBeenCalledTimes(2);                                 // the saved ones at once, again when it failed
        expect(apt.mock.calls.every((c) => c[0].detail.replace === true)).toBe(true);
        expect(apt.mock.calls[0][0].detail.shapes).toEqual(apt.mock.calls[1][0].detail.shapes);
        document.removeEventListener('notam:tfrs-apt', apt);
    });

    it('offline with nothing saved: the error, and the map\'s TFRs are left alone', async () => {
        offline();
        const apt = vi.fn(); document.addEventListener('notam:tfrs-apt', apt);
        const wx = makeWx();
        await wx._fetchNotams();
        expect(wx._notamFetchError).toBe('Failed to fetch');
        expect(apt).not.toHaveBeenCalled();
        document.removeEventListener('notam:tfrs-apt', apt);
    });

    it('another route\'s NOTAMs are not shown; a station both routes share is', async () => {
        answer({ features: [feat('AAA', 'RWY 1/19 CLSD'), feat('LKR', 'RWY 06/24 CLSD')], failed: [] });
        stations = ['KAAA', 'KLKR'];
        await makeWx()._fetchNotams();
        stations = ['KLKR', 'KCAE', 'KTMB']; offline();
        const wx = makeWx();
        await wx._fetchNotams();
        expect(texts(wx._notams)).toMatch(/RWY 06\/24 CLSD/);
        expect(texts(wx._notams)).not.toMatch(/RWY 1\/19/);
        expect(warnings(wx).join(' ')).toMatch(/KCAE, KTMB: NOTAMs NOT AVAILABLE — never downloaded/);
    });

    it('a saved NOTAM that has since expired is not shown', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD', { effectiveEnd: '2026-10-19T20:00:00Z' })], failed: [] });
        await makeWx()._fetchNotams();
        at('2026-10-19T21:00:00Z'); offline();
        const wx = makeWx();
        await wx._fetchNotams();
        expect(texts(wx._notams)).not.toMatch(/RWY 06\/24/);
    });

    it('a refresh that works clears an earlier "refresh failed"', async () => {
        const wx = makeWx(); offline();
        await wx._fetchNotams();
        expect(wx._notamFetchError).toBeTruthy();
        answer({ features: [], failed: [] });
        await wx._fetchNotams();
        expect(wx._notamFetchError).toBe(null);
        expect(warnings(wx)).toEqual([]);
    });

    it('every station failed: a failure (the saved NOTAMs are shown)', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD')], failed: [] });
        stations = ['KLKR']; await makeWx()._fetchNotams();
        answer({ features: [], failed: ['KLKR'] });
        const wx = makeWx();
        await wx._fetchNotams();
        expect(wx._notamFetchError).toMatch(/not fetched/);
        expect(texts(wx._notams)).toMatch(/RWY 06\/24 CLSD/);
    });

    it('station ids in warnings are text, not HTML', async () => {
        stations = ['KLKR', '<img src=x onerror=alert(1)>'];
        answer({ features: [], failed: ['<IMG SRC=X ONERROR=ALERT(1)>'] });
        const wx = makeWx(); stations = ['KLKR', '<IMG SRC=X ONERROR=ALERT(1)>'];
        await wx._fetchNotams();
        const sec = document.createElement('div'); wx._section = () => sec; delete wx._renderNotamSection; wx._renderNotamSection();
        expect(sec.querySelector('img')).toBe(null);
    });
});

describe('en-route NOTAMs, kept per ARTCC', () => {
    const TFR = '!FDC 6/0050 ZTL NC..AIRSPACE ASHEVILLE, NORTH CAROLINA..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 3NM RADIUS OF 352600N0823300W SFC-3000FT';

    it('failed with nothing saved: a warning; the map\'s TFRs are not cleared', async () => {
        offline();
        const enr = vi.fn(); document.addEventListener('notam:tfrs', enr);
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        expect(enr).not.toHaveBeenCalled();
        expect(warnings(wx)).toContain('⚠ En-route NOTAMs NOT AVAILABLE for ZJX, ZTL, ZZZ — never downloaded; TFRs and restrictions may be missing · tap ↻ to retry');
        document.removeEventListener('notam:tfrs', enr);
    });

    it('offline later: the saved en-route NOTAMs and TFRs come back (KZJX asked, ZJX in the NOTAMs)', async () => {
        answer({ features: [feat('ZTL', TFR)], failed: [] });
        const enr = vi.fn(); document.addEventListener('notam:tfrs', enr);
        await makeWx()._fetchEnrouteNotams();
        const first = enr.mock.calls[0][0].detail.shapes.length;
        offline();
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        expect(texts(wx._enrouteNotams)).toMatch(/ASHEVILLE/);
        expect(enr).toHaveBeenCalledTimes(3);                                 // fetched; saved at once; again when it failed
        expect(enr.mock.calls[1][0].detail.shapes.length).toBe(first);
        expect(enr.mock.calls[2][0].detail.shapes.length).toBe(first);
        expect(warnings(wx).join(' ')).toMatch(/⚠ En-route: refresh failed — showing NOTAMs downloaded earlier: ZJX 19 1852Z, ZTL 19 1852Z, ZZZ 19 1852Z/);
        document.removeEventListener('notam:tfrs', enr);
    });

    it('ZZZ not answered: shown from what was saved, asked again next open', async () => {
        answer({ features: [feat('ZTL', TFR)], failed: [] });
        await makeWx()._fetchEnrouteNotams();
        answer({ features: [], failed: ['ZZZ'] });
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        expect(wx._enrouteNotamFetchedAt).toBe(0);
        expect(warnings(wx)).toContain('⚠ En-route: not refreshed — showing NOTAMs downloaded earlier: ZZZ 19 1852Z · tap ↻ to retry');
    });

    it('no route: the en-route TFRs are cleared', async () => {
        const enr = vi.fn(); document.addEventListener('notam:tfrs', enr);
        const wx = makeWx(); wx._getRouteBbox = async () => null;
        await wx._fetchEnrouteNotams();
        expect(enr.mock.calls[0][0].detail).toEqual({ shapes: [], replace: true });
        document.removeEventListener('notam:tfrs', enr);
    });
});

describe('a new route', () => {
    it('gets its own NOTAMs at once, not the old route\'s for 15 min', () => {
        const wx = makeWx();
        delete wx._getStationList;                                            // the real one, from the plan
        wx._renderAll = () => {};
        wx._flightPlan = { waypoints: [{ icao: 'KLKR' }, { icao: 'KTMB' }] };
        wx._notamFetchedAt = wx._enrouteNotamFetchedAt = Date.now();
        wx.setFlightPlan({ waypoints: [{ icao: 'KLKR' }, { icao: 'KTMB' }] });   // same stations
        expect(wx._notamFetchedAt).toBe(Date.now());
        wx.setFlightPlan({ waypoints: [{ icao: 'KLKR' }, { icao: 'KAVL' }] });
        expect(wx._notamFetchedAt).toBe(0);
        expect(wx._enrouteNotamFetchedAt).toBe(0);
    });
});

describe('the map\'s NOTAM TFRs (map.js)', () => {
    new Function(read('web/lib/leaflet/leaflet.js')).call(globalThis);
    globalThis.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
    const ActiveRoute = new Function(read('web/shared/active-route.js') + '\nreturn ActiveRoute;')();
    const CockpitMap = new Function('ActiveRoute', read('web/cockpit/map.js') + '\nreturn CockpitMap;')(ActiveRoute);
    const shape = (raw, extra = {}) => ({ raw, summary: raw, lat: 35, lon: -82, radiusNm: 3, ...extra });
    const map = () => { const m = Object.create(CockpitMap.prototype); m._notamTfrGroup = L.layerGroup(); m._notamTfrShapes = new Map(); return m; };
    const fire = (m, type, detail) => m._handleNotamTfrs({ type, detail });
    const raws = (m) => [...m._notamTfrShapes.keys()].sort();

    it('an en-route refresh replaces the en-route TFRs only; the airport ones stay', () => {
        const m = map();
        fire(m, 'notam:tfrs-apt', { shapes: [shape('APT')] });
        fire(m, 'notam:tfrs', { shapes: [shape('ENR1')] });
        fire(m, 'notam:tfrs', { shapes: [shape('ENR2')] });
        expect(raws(m)).toEqual(['APT', 'ENR2']);
        expect(m._notamTfrGroup.getLayers()).toHaveLength(2);
    });

    it('a TFR both sources have stays until neither has it', () => {
        const m = map();
        fire(m, 'notam:tfrs-apt', { shapes: [shape('BOTH')] });
        fire(m, 'notam:tfrs', { shapes: [shape('BOTH')] });
        fire(m, 'notam:tfrs', { shapes: [] });
        expect(raws(m)).toEqual(['BOTH']);
        fire(m, 'notam:tfrs-apt', { shapes: [], replace: true });
        expect(raws(m)).toEqual([]);
    });

    it('the popup shows FAA text as text', () => {
        const m = map();
        fire(m, 'notam:tfrs', { shapes: [shape('X', { summary: '<img src=x onerror=alert(1)>' })] });
        const html = m._notamTfrShapes.get('X').layer.getPopup().getContent();
        expect(html).toMatch(/&lt;img src=x onerror=alert\(1\)&gt;/);
        expect(html).not.toMatch(/<img/);
    });
});

describe('review fixes (2026-10-19)', () => {
    it('a round trip (KLKR → KCAE → KLKR): each NOTAM once, and fresh when complete', async () => {
        stations = ['KLKR', 'KCAE', 'KLKR'];
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD')], failed: [] });
        const wx = makeWx();
        await wx._fetchNotams();
        expect(wx._notams.filter((n) => /RWY 06\/24/.test(n.raw || n.summary))).toHaveLength(1);
        expect(wx._notamFetchedAt).toBe(Date.parse(T0));
        expect(String(globalThis.fetch.mock.calls[0][0])).toMatch(/location=KLKR,KCAE$/);
    });

    it('airport refresh failed with nothing saved, en-route saved: both lines and the en-route NOTAMs show', async () => {
        const TFR = '!FDC 6/0050 ZTL NC..AIRSPACE ASHEVILLE, NORTH CAROLINA..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 3NM RADIUS OF 352600N0823300W SFC-3000FT';
        answer({ features: [feat('ZTL', TFR)], failed: [] });
        await makeWx()._fetchEnrouteNotams();
        offline();
        const wx = makeWx(); stations = ['KAVL', 'KGSP'];                    // a divert, never downloaded
        await wx._fetchEnrouteNotams();
        await wx._fetchNotams();
        const w = warnings(wx).join(' | ');
        expect(w).toMatch(/KAVL, KGSP: NOTAMs NOT AVAILABLE/);
        expect(w).toMatch(/En-route: refresh failed — showing NOTAMs downloaded earlier/);
        expect(texts(wx._enrouteNotams)).toMatch(/ASHEVILLE/);
    });

    it('two refreshes overlapping: the older answer does not overwrite the newer', async () => {
        let release; const slow = new Promise((res) => { release = res; });
        globalThis.fetch = vi.fn()
            .mockImplementationOnce(async () => { await slow; return { ok: true, json: async () => ({ features: [feat('LKR', 'OLD ROUTE')], failed: [] }) }; })
            .mockImplementationOnce(async () => ({ ok: true, json: async () => ({ features: [feat('AVL', 'NEW ROUTE')], failed: [] }) }));
        const wx = makeWx();
        const first = wx._fetchNotams();
        stations = ['KAVL'];
        await wx._fetchNotams();
        release(); await first;
        expect(texts(wx._notams)).toMatch(/NEW ROUTE/);
        expect(texts(wx._notams)).not.toMatch(/OLD ROUTE/);
    });

    it('startup / a route loaded: the saved NOTAMs and their TFRs come back without a download', async () => {
        const tfr = '!FDC 6/0128 ZJX FL..AIRSPACE MAYPORT, FL..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 3NM RADIUS OF 302300N0812500W SFC-3000FT';
        answer({ features: [feat('TMB', tfr)], failed: [] });
        await makeWx()._fetchNotams();
        globalThis.fetch = vi.fn(async () => { throw new Error('no network expected'); });
        const apt = vi.fn(); document.addEventListener('notam:tfrs-apt', apt);
        const wx = makeWx();
        await wx._restoreSavedNotams();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(apt).toHaveBeenCalledTimes(1);
        expect(texts(wx._notams)).toMatch(/MAYPORT/);
        document.removeEventListener('notam:tfrs-apt', apt);
    });

    it('while refreshing, the saved NOTAMs stay on screen ("Refreshing — showing …")', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD')], failed: [] });
        stations = ['KLKR']; await makeWx()._fetchNotams();
        let release; globalThis.fetch = vi.fn(() => new Promise((res) => { release = res; }));
        const wx = makeWx();
        await wx._restoreSavedNotams();
        const p = wx._fetchNotams();
        expect(texts(wx._notams)).toMatch(/RWY 06\/24/);
        expect(warnings(wx).join(' ')).toMatch(/Refreshing — showing NOTAMs downloaded earlier: KLKR/);
        release({ ok: true, json: async () => ({ features: [], failed: [] }) }); await p;
    });

    it('saved bins older than 7 days are not shown; the cache keeps within its size budget', () => {
        const wx = makeWx();
        const big = 'X'.repeat(1000);
        const bins = {};
        for (let i = 0; i < 150; i++) bins[`K${String(i).padStart(3, '0')}`] = { at: Date.now() - i * 1000, notams: Array.from({ length: 10 }, () => ({ airport: 'K', raw: big })) };
        wx._writeNotamCache('t', { v: 2, bins });
        const saved = localStorage.getItem('t');
        expect(saved.length).toBeLessThanOrEqual(WxBriefing.NOTAM_CACHE_MAX_CHARS);
        expect(JSON.parse(saved).bins.K000).toBeTruthy();                    // newest kept
        const old = { v: 2, bins: { KLKR: { at: Date.now() - 8 * 24 * 3600e3, notams: [{ airport: 'KLKR', raw: 'OLD' }] } } };
        expect(WxBriefing._mergeNotamBins(['KLKR'], old, new Set(), Date.now()).missing).toEqual(['KLKR']);
    });
});

describe('review 2 fixes (2026-10-19)', () => {
    it('the route changes while a refresh runs (panel closed): the old answer is dropped; the new route\'s saved NOTAMs show', async () => {
        stations = ['KAVL']; answer({ features: [feat('AVL', 'NEW ROUTE RWY CLSD')], failed: [] });
        await makeWx()._fetchNotams();                                        // KAVL saved earlier
        stations = ['KLKR'];
        let release; globalThis.fetch = vi.fn(() => new Promise((res) => { release = res; }));
        const wx = makeWx(); wx._renderAll = () => {};
        const old = wx._fetchNotams();                                        // the old route's refresh
        wx._getStationList = vi.fn().mockReturnValueOnce(['KLKR']).mockReturnValue(['KAVL']);
        stations = ['KAVL'];
        wx.setFlightPlan({});                                                 // a divert to KAVL
        await Promise.resolve(); await wx._restoreSavedNotams();
        release({ ok: true, json: async () => ({ features: [feat('LKR', 'OLD ROUTE')], failed: [] }) });
        await old;
        expect(texts(wx._notams)).toMatch(/NEW ROUTE/);
        expect(texts(wx._notams)).not.toMatch(/OLD ROUTE/);
        expect(wx._notamFetchedAt).toBe(0);                                   // the new route is still fetched on open
    });

    it('a route without stations overtaking a refresh does not leave it "busy"', async () => {
        let release; globalThis.fetch = vi.fn(() => new Promise((res) => { release = res; }));
        const wx = makeWx();
        const p = wx._fetchNotams();
        stations = [];
        await wx._fetchNotams();
        release({ ok: true, json: async () => ({ features: [], failed: [] }) }); await p;
        expect(wx._notamBusy).toBe(false);
    });

    it('a never-downloaded divert airport downloading: the saved en-route NOTAMs stay on screen', async () => {
        const TFR = '!FDC 6/0050 ZTL NC..AIRSPACE ASHEVILLE, NORTH CAROLINA..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 3NM RADIUS OF 352600N0823300W SFC-3000FT';
        answer({ features: [feat('ZTL', TFR)], failed: [] });
        const wx = makeWx();
        await wx._fetchEnrouteNotams();
        stations = ['KAVL'];
        let release; globalThis.fetch = vi.fn(() => new Promise((res) => { release = res; }));
        const p = wx._fetchNotams();
        expect(wx._notams).toEqual([]);                                       // not null: the section is not "Fetching…"
        expect(warnings(wx).join(' ')).toMatch(/Downloading airport NOTAMs…/);
        expect(texts(wx._enrouteNotams)).toMatch(/ASHEVILLE/);
        release({ ok: true, json: async () => ({ features: [], failed: [] }) }); await p;
    });

    it('a broken saved entry does not stop the refresh of a newly loaded route', async () => {
        localStorage.setItem('flytab_notam_cache', JSON.stringify({ v: 2, bins: { KAVL: { at: Date.now(), notams: null } } }));
        const wx = makeWx(); wx.visible = true; wx._renderAll = () => {};
        wx._fetchColdSections = vi.fn();
        stations = ['KLKR']; const before = stations; stations = ['KAVL'];
        wx._getStationList = vi.fn().mockReturnValueOnce(before).mockReturnValue(['KAVL']);
        wx.setFlightPlan({});
        await new Promise((r) => setTimeout(r, 0)); await Promise.resolve(); await Promise.resolve();
        expect(wx._fetchColdSections).toHaveBeenCalledTimes(1);
    });
});

describe('review 3 fixes (2026-10-19)', () => {
    it('en-route still downloading, airport fresh and empty: "Fetching…", not a green NONE', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD')], failed: [] });
        stations = ['KLKR']; await makeWx()._fetchNotams();                   // KLKR saved
        const wx = makeWx();
        await wx._restoreSavedNotams();
        let releaseEnr;
        globalThis.fetch = vi.fn((url) => String(url).includes('ZZZ')
            ? new Promise((res) => { releaseEnr = res; })
            : Promise.resolve({ ok: true, json: async () => ({ features: [], failed: [] }) }));
        const enr = wx._fetchEnrouteNotams();
        await wx._fetchNotams();                                              // KLKR now has none
        const sec = document.createElement('div'); wx._section = () => sec; delete wx._renderNotamSection; wx._renderNotamSection();
        expect(sec.textContent).toMatch(/Fetching…/);
        expect(sec.textContent).not.toMatch(/NONE|No active NOTAMs/);
        expect(sec.textContent).toMatch(/Downloading en-route NOTAMs…/);
        releaseEnr({ ok: true, json: async () => ({ features: [], failed: [] }) }); await enr;
        wx._renderNotamSection();
        expect(sec.textContent).toMatch(/NONE/);                               // both done, none in force
    });

    it('an older route\'s coordinate lookup finishing late does not replace the new route\'s', async () => {
        const wx = makeWx();
        delete wx._getStationList;
        let release; wx._db = { getAirport: (id) => (id === 'KLKR' ? new Promise((res) => { release = res; }) : Promise.resolve({ lat: 35, lon: -82 })) };
        wx._flightPlan = { waypoints: [{ icao: 'KLKR' }] };
        const old = wx._getRouteCoords();
        wx._flightPlan = { waypoints: [{ icao: 'KAVL', lat: 35.4, lon: -82.5 }] };
        wx._routeCoords = null;
        const now = await wx._getRouteCoords();
        release({ lat: 34.7, lon: -80.9 }); await old;
        expect(wx._routeCoords).toBe(now);
        expect(wx._routeCoords[0].icao).toBe('KAVL');
    });
});

describe('review 4 fixes (2026-10-19)', () => {
    const TFR = '!FDC 6/0050 ZTL NC..AIRSPACE ASHEVILLE, NORTH CAROLINA..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 3NM RADIUS OF 352600N0823300W SFC-3000FT';
    it('the saved en-route NOTAMs and TFRs show as soon as the download starts, not when it ends', async () => {
        answer({ features: [feat('ZTL', TFR)], failed: [] });
        await makeWx()._fetchEnrouteNotams();
        let release; globalThis.fetch = vi.fn(() => new Promise((res) => { release = res; }));
        const enr = vi.fn(); document.addEventListener('notam:tfrs', enr);
        const wx = makeWx();
        const p = wx._fetchEnrouteNotams();
        await Promise.resolve(); await Promise.resolve();
        expect(texts(wx._enrouteNotams)).toMatch(/ASHEVILLE/);
        expect(enr).toHaveBeenCalledTimes(1);
        expect(warnings(wx).join(' ')).toMatch(/En-route: refreshing — showing NOTAMs downloaded earlier/);
        release({ ok: true, json: async () => ({ features: [], failed: [] }) }); await p;
        document.removeEventListener('notam:tfrs', enr);
    });

    it('while the en-route route lookup runs: "Fetching…", not NONE', async () => {
        answer({ features: [], failed: [] });
        const wx = makeWx();
        let releaseBox; wx._getRouteBbox = () => new Promise((res) => { releaseBox = res; });
        const p = wx._fetchEnrouteNotams();
        await wx._fetchNotams();                                              // airport: none in force
        const sec = document.createElement('div'); wx._section = () => sec; delete wx._renderNotamSection; wx._renderNotamSection();
        expect(sec.textContent).toMatch(/Fetching…/);
        expect(sec.textContent).not.toMatch(/NONE/);
        releaseBox({ n: 34.8, s: 25.6, e: -80.3, w: -81.2 }); await p;
    });

    it('a failed airport refresh with en-route downloading: amber, not neutral', async () => {
        offline();
        const wx = makeWx(); wx._enrouteBusy = true; wx._enrouteNotams = [];
        await wx._fetchNotams();
        const sec = document.createElement('div'); wx._section = () => sec; delete wx._renderNotamSection; wx._renderNotamSection();
        expect(sec.querySelector('.wx-rhs-badge')?.className || '').toMatch(/warn/);
    });

    it('a corrupt entry inside a saved list is skipped', () => {
        const c = { v: 2, bins: { KLKR: { at: Date.now(), notams: [null, { airport: 'KLKR', raw: 'RWY CLSD' }] } } };
        expect(WxBriefing._mergeNotamBins(['KLKR'], c, new Set(), Date.now()).shown).toHaveLength(1);
    });
});

describe('the last three (2026-10-19)', () => {
    it('a retry after a failure shows "Fetching…", not the last attempt\'s error', async () => {
        offline();
        const wx = makeWx();
        await wx._fetchNotams();
        expect(wx._notamFetchError).toBe('Failed to fetch');
        let release; globalThis.fetch = vi.fn(() => new Promise((res) => { release = res; }));
        const p = wx._fetchNotams();                                          // the retry
        const sec = document.createElement('div'); wx._section = () => sec; delete wx._renderNotamSection; wx._renderNotamSection();
        expect(sec.textContent).toMatch(/Fetching…/);
        expect(sec.textContent).not.toMatch(/Failed to fetch/);
        release({ ok: true, json: async () => ({ features: [], failed: [] }) }); await p;
    });

    it('a station never downloaded is named at once, with the saved ones, not after the download', async () => {
        answer({ features: [feat('LKR', 'RWY 06/24 CLSD')], failed: [] });
        stations = ['KLKR']; await makeWx()._fetchNotams();                   // KLKR saved, KAVL never
        stations = ['KLKR', 'KAVL'];
        let release; globalThis.fetch = vi.fn(() => new Promise((res) => { release = res; }));
        const wx = makeWx();
        const p = wx._fetchNotams();
        expect(warnings(wx).join(' ')).toMatch(/KAVL: NOTAMs NOT AVAILABLE — never downloaded/);
        release({ ok: true, json: async () => ({ features: [], failed: [] }) }); await p;
    });

    it('the en-route route lookup failing: an error, not stuck "Downloading", and the map\'s TFRs are kept', async () => {
        const enr = vi.fn(); document.addEventListener('notam:tfrs', enr);
        const wx = makeWx(); wx._enrouteRequest = async () => { throw new Error('NASR busy'); };
        await wx._fetchEnrouteNotams();
        expect(wx._enrouteBusy).toBe(false);
        expect(wx._enrouteNotamFetchError).toBe('NASR busy');
        expect(enr).not.toHaveBeenCalled();
        expect(warnings(wx).join(' ')).not.toMatch(/Downloading en-route/);
        document.removeEventListener('notam:tfrs', enr);
    });
});
