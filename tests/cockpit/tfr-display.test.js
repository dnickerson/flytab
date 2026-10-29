/**
 * TFR display. 2026-10-29: the Charlotte / Rock Hill VIP TFR (FDC 6/3091, KLKR
 * inside its 30 nm rings, SFC-17,999 ft) was not on the map: the NOTAM text
 * parser read none of its "30NM RADIUS OF 351247N0805705W" circles (seconds in
 * the coordinates) and joined its coordinates into a line. Now the FAA's own TFR
 * data (tfr.faa.gov, through the NOTAM proxy) draws the exact areas; the text
 * parser, the fallback, reads every area.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
const WxBriefing = new Function(`${read('web/cockpit/wx-briefing.js')}\nreturn WxBriefing;`)();
const FaaTfrClient = new Function(`${read('web/shared/faa-tfr.js')}\nreturn FaaTfrClient;`)();
const VectorMapLayers = new Function(`${read('web/cockpit/vector-map-layers.js')}\nreturn VectorMapLayers;`)();
const CHARLOTTE = read('tests/fixtures/tfr/notam_6_3091.txt');

const wx = Object.create(WxBriefing.prototype);
const nm = (a, b) => {
    const R = 3440.065, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
};
const KLKR = [34.722904, -80.854590];

describe('NOTAM text parser (fallback): every area of a TFR', () => {
    it('Charlotte / Rock Hill: six circles like the FAA areas A-F (30/10 nm); KLKR inside the four 30 nm ones', () => {
        const g = wx._parseTfrGeometries(CHARLOTTE);
        const circles = g.filter((s) => s.radiusNm != null);
        expect(circles.map((c) => c.radiusNm)).toEqual([30, 10, 30, 10, 30, 30]);
        expect(circles[0].lat).toBeCloseTo(35 + 12 / 60 + 47 / 3600, 5);
        expect(circles[0].lon).toBeCloseTo(-(80 + 57 / 60 + 5 / 3600), 5);
        expect(circles[2].lat).toBeCloseTo(34 + 55 / 60 + 53 / 3600, 5);
        const inside = circles.filter((c) => nm([c.lat, c.lon], KLKR) <= c.radiusNm).map((c) => c.radiusNm);
        expect(inside).toEqual([30, 30, 30, 30]);
        expect(g.some((s) => s.points)).toBe(false);          // no line through the centres any more
    });

    it('a 1 nm circle written with seconds (Atlanta, cached 10-27) is a circle, not "no shape"', () => {
        const g = wx._parseTfrGeometries('PART 1 OF 2 AIRSPACE GA..AIRSPACE ATLANTA, GA..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 1NM RADIUS OF 334549N0842342W (RMG122043.4) SFC-3000FT AGL.');
        expect(g).toHaveLength(1);
        expect(g[0].radiusNm).toBe(1);
        expect(g[0].lat).toBeCloseTo(33.7636, 3);
    });

    it('a polygon to POINT OF ORIGIN (Myrtle Beach) stays one polygon of its four corners', () => {
        const g = wx._parseTfrGeometries('SC..AIRSPACE MYRTLE BEACH, SC..TEMPORARY FLIGHT RESTRICTIONS. WI AN AREA DEFINED AS 334903N0791434W TO 333545N0791532W TO 333408N0785413W TO 340356N0785511W TO POINT OF ORIGIN SFC-1000FT AGL.');
        expect(g).toHaveLength(1);
        expect(g[0].points).toHaveLength(4);
    });

    it('older wording without "WI AN AREA DEFINED AS" still parses as before', () => {
        const g = wx._parseTfrGeometries('WITHIN A 3NM RADIUS OF 3512N08057W SFC-3000FT');
        expect(g).toHaveLength(1);
        expect(g[0].radiusNm).toBe(3);
        expect(wx._parseTfrGeometry('WITHIN A 3NM RADIUS OF 3512N08057W SFC-3000FT').radiusNm).toBe(3);
    });

    it('one map shape per area, each with its own key', () => {
        const shapes = wx._tfrShapesOf([{ type: 'TFR', raw: CHARLOTTE, summary: 'CHARLOTTE', validFrom: null, validTo: null }]);
        expect(shapes).toHaveLength(6);
        expect(new Set(shapes.map((s) => s.key)).size).toBe(6);
    });
});

describe('FaaTfrClient (tfr.faa.gov through the NOTAM proxy)', () => {
    const area = (o = {}) => ({ name: 'Area A', polygon: [[35, -81], [35.5, -81], [35.5, -80.5]], lowerFt: 0, lowerRef: 'AGL',
        upperFt: 17999, upperRef: 'MSL', start: '2026-10-29T18:15:00Z', end: '2026-10-29T20:30:00Z', ...o });
    const body = (tfrs) => ({ source: 'tfr.faa.gov', fetchedAt: '2026-10-29T18:27:35Z', failed: [], tfrs });
    beforeEach(() => { localStorage.clear(); DiagLog.log.mockClear(); });

    it('downloads for a box around us and the route, keeps it for the flight', async () => {
        global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => body([{ id: '6/3091', legal: 'VIP', detail: true, areas: [area()] }]) }));
        const c = new FaaTfrClient({ baseUrl: () => 'https://fitpc.example/', points: () => [[34.72, -80.85], [28.55, -81.33]] });
        const updated = vi.fn(); c.addEventListener('faatfr:updated', updated);
        expect(await c.refresh()).toBe(true);
        const url = fetch.mock.calls[0][0];
        expect(url).toMatch(/^https:\/\/fitpc\.example\/tfrs\?bbox=-?\d+\.\d{3},\d+\.\d{3},-?\d+\.\d{3},\d+\.\d{3}$/);
        const [w, s, e, n] = url.split('bbox=')[1].split(',').map(Number);
        expect(w).toBeLessThan(-81.33); expect(e).toBeGreaterThan(-80.85); expect(s).toBeLessThan(28.55); expect(n).toBeGreaterThan(34.72);
        expect(updated).toHaveBeenCalled();
        // the next start (in the air) reads it back
        expect(new FaaTfrClient().data.tfrs[0].id).toBe('6/3091');
    });

    it('area status: active, upcoming, no times; ended areas drop off', () => {
        localStorage.setItem(FaaTfrClient.CACHE_KEY, JSON.stringify(body([{ id: '6/3091', detail: true, areas: [
            area({ name: 'A' }),
            area({ name: 'C', start: '2026-10-29T19:00:00Z', end: '2026-10-29T23:00:00Z' }),
            area({ name: 'old', start: '2026-10-28T10:00:00Z', end: '2026-10-28T12:00:00Z' }),
            area({ name: 'X', start: null, end: null }),
        ] }])));
        const c = new FaaTfrClient();
        const at = c.areas(Date.parse('2026-10-29T18:30:00Z')).map((a) => [a.area.name, a.status]);
        expect(at).toEqual([['A', 'active'], ['C', 'upcoming'], ['X', 'unknown']]);
    });

    it('a failed download keeps what was downloaded; in flight nothing is asked', async () => {
        localStorage.setItem(FaaTfrClient.CACHE_KEY, JSON.stringify(body([{ id: '6/3091', areas: [area()] }])));
        global.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: 'FAA down', tfrs: [] }) }));
        const c = new FaaTfrClient({ baseUrl: () => 'https://fitpc.example', points: () => [[34.7, -80.8]] });
        expect(await c.refresh()).toBe(false);
        expect(c.data.tfrs).toHaveLength(1);
        expect(c.lastError).toBe('FAA down');
        const air = new FaaTfrClient({ baseUrl: () => 'https://fitpc.example', points: () => [[34.7, -80.8]], canFetch: () => false });
        global.fetch = vi.fn();
        expect(await air.refresh()).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('what comes off the network is checked: bad polygons and fields dropped', () => {
        const t = FaaTfrClient._clean({ id: '6/1', areas: [{ polygon: [[95, 0], [1, 1]] }, area({ name: '<b>x</b>', lowerFt: 'SFC' })] });
        expect(t.areas).toHaveLength(1);
        expect(t.areas[0].lowerFt).toBeNull();
        expect(FaaTfrClient._clean({ id: 5, areas: [] })).toBeNull();
    });

    it('isCurrent: within 24 h of the download', () => {
        localStorage.setItem(FaaTfrClient.CACHE_KEY, JSON.stringify(body([{ id: '6/3091', areas: [area()] }])));
        const c = new FaaTfrClient();
        expect(c.isCurrent(Date.parse('2026-10-29T20:00:00Z'))).toBe(true);
        expect(c.isCurrent(Date.parse('2026-10-31T20:00:00Z'))).toBe(false);
    });

    it('bboxFor: at most 30 degrees each way', () => {
        const b = FaaTfrClient.bboxFor([[25, -125], [48, -67]], 150);
        expect(b[2] - b[0]).toBeLessThanOrEqual(30.0001);
        expect(b[3] - b[1]).toBeLessThanOrEqual(30.0001);
        expect(FaaTfrClient.bboxFor([], 150)).toBeNull();
    });
});

describe('Airspace popup TFR row', () => {
    it('names the TFR, says ACTIVE NOW, altitudes and times; the text is escaped', () => {
        const html = VectorMapLayers.prototype._airspacePopupHtml.call({}, [{ kind: 'tfr', rec: {
            name: 'Area A', lowerFt: 0, lowerRef: 'AGL', upperFt: 17999, upperRef: 'MSL',
            start: '2026-10-29T18:15:00Z', end: '2026-10-29T20:30:00Z', status: 'active', fetchedAt: '2026-10-29T18:27:35Z',
            tfr: { id: '6/3091', legal: 'VIP', name: '261029 Charlotte / Rock Hill <VIP>', detail: true },
        } }]);
        expect(html).toContain('TFR 6/3091 · VIP');
        expect(html).toContain('ACTIVE NOW');
        expect(html).toContain('SFC – 17,999 ft MSL');
        expect(html).toContain('(1815Z)');
        expect(html).toContain('(2030Z)');
        expect(html).toContain('&lt;VIP&gt;');
        expect(html).toContain('tfr.faa.gov');
    });

    it('an upcoming area says when it starts; no FAA details says read the NOTAM', () => {
        const html = VectorMapLayers.prototype._airspacePopupHtml.call({}, [{ kind: 'tfr', rec: {
            name: '', lowerFt: null, upperFt: null, start: null, end: null, status: 'unknown', fetchedAt: null,
            tfr: { id: '4/3634', detail: false },
        } }]);
        expect(html).toContain('TIMES NOT KNOWN');
        expect(html).toContain('read the NOTAM');
    });

    it('TFRs come first in the list at a spot', () => {
        const vl = Object.create(VectorMapLayers.prototype);
        vl._map = { hasLayer: () => false };
        vl.extraAreasAt = () => [{ kind: 'tfr', rec: { tfr: { id: '6/3091' } } }];
        expect(vl._areasAt(34.72, -80.85).map((a) => a.kind)).toEqual(['tfr']);
    });
});

describe('TFR NOTAM text in the airspace popup', () => {
    const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
    const area = (name, text = 'FDC 6/3879 ZTL NC..SC..AIRSPACE CHARLOTTE, NC..ROCK HILL, SC..TEMPORARY FLIGHT RESTRICTIONS <SFC>.') => ({ kind: 'tfr', rec: {
        name, lowerFt: 0, lowerRef: 'AGL', upperFt: 17999, upperRef: 'MSL', start: null, end: '2026-10-30T01:15:00Z',
        status: 'active', fetchedAt: '2026-10-29T19:43:06Z', tfr: { id: '6/3879', legal: 'VIP', detail: true, text },
    } });

    it('one NOTAM TEXT button per TFR, its text hidden until tapped; escaped', () => {
        const html = VectorMapLayers.prototype._airspacePopupHtml.call({}, [area('Area A'), area('Area C')]);
        expect(html.match(/as-pop-tfr-textbtn/g)).toHaveLength(1);
        const d = document.createElement('div'); d.innerHTML = html;
        expect(d.querySelector('.as-pop-tfr-text').hidden).toBe(true);
        expect(d.querySelector('.as-pop-tfr-text').innerHTML).toContain('&lt;SFC&gt;');
    });

    it('a tap opens the full text and a second tap closes it; the popup re-lays out', () => {
        global.wireTap = wireTap;
        const el = document.createElement('div');
        el.innerHTML = VectorMapLayers.prototype._airspacePopupHtml.call({}, [area('Area A')]);
        const popup = { getElement: () => el, update: vi.fn() };
        VectorMapLayers._wireTfrText(popup);
        const btn = el.querySelector('.as-pop-tfr-textbtn'), box = el.querySelector('.as-pop-tfr-text');
        btn.click();
        expect(box.hidden).toBe(false);
        expect(btn.textContent).toBe('NOTAM TEXT ▾');
        expect(popup.update).toHaveBeenCalled();
        btn.click();
        expect(box.hidden).toBe(true);
        delete global.wireTap;
    });

    it('no text from the FAA: no button', () => {
        const html = VectorMapLayers.prototype._airspacePopupHtml.call({}, [area('Area A', '')]);
        expect(html).not.toContain('as-pop-tfr-textbtn');
    });
});

describe('TFRs in the airport panel (a tap inside a TFR opens the nearest airport)', () => {
    const AirportPopup = new Function(`${read('web/cockpit/airport-popup.js')}\nreturn AirportPopup;`)();
    // The FAA's real areas for 6/3091 (fixture): A = Charlotte 30 nm (KLKR just inside), B = its 10 nm.
    const xml = read('tests/fixtures/tfr/detail_6_3091.xml');
    const ring = (name) => {
        const g = xml.split('<TFRAreaGroup>').find((p) => p.includes(`<txtName>${name}</txtName>`));
        const merged = g.split('<abdMergedArea>')[1].split('</abdMergedArea>')[0];
        const ll = (v) => { const x = parseFloat(v); return /[SW]$/.test(v) ? -x : x; };
        return [...merged.matchAll(/<geoLat>([^<]+)<\/geoLat>\s*<geoLong>([^<]+)<\/geoLong>/g)].map((m) => [ll(m[1]), ll(m[2])]);
    };
    const A = ring('Area A'), B = ring('Area B');
    const NOW = Date.parse('2026-10-29T19:00:00Z');
    function client() {
        localStorage.setItem(FaaTfrClient.CACHE_KEY, JSON.stringify({ fetchedAt: '2026-10-29T18:27:35Z', tfrs: [{
            id: '6/3091', legal: 'VIP', detail: true, text: 'FDC 6/3091 ... PROHIBITED: WI AN AREA DEFINED AS 30NM RADIUS ...',
            areas: [
                { name: 'Area A', polygon: A, lowerFt: 0, lowerRef: 'AGL', upperFt: 17999, upperRef: 'MSL', start: '2026-10-29T18:15:00Z', end: '2026-10-29T20:30:00Z' },
                { name: 'Area B', polygon: B, lowerFt: 0, lowerRef: 'AGL', upperFt: 17999, upperRef: 'MSL', start: '2026-10-29T18:15:00Z', end: '2026-10-29T20:30:00Z' },
            ] }] }));
        return new FaaTfrClient();
    }

    it('distanceNm: 0 inside, else to the nearest edge', () => {
        expect(FaaTfrClient.distanceNm(35.2131, -80.9514, B)).toBe(0);            // Charlotte centre
        const d = FaaTfrClient.distanceNm(34.40, -80.95, A);                       // ~19 nm south of the 30 nm ring
        expect(d).toBeGreaterThan(17); expect(d).toBeLessThan(21);
    });

    it('KLKR: in 6/3091 (Area A, the 30 nm ring), one entry per TFR', () => {
        const n = client().near(34.722904, -80.854590, 5, NOW);
        expect(n.map((e) => [e.tfr.id, e.area.name, e.status, e.distanceNm])).toEqual([['6/3091', 'Area A', 'active', 0]]);
    });

    it('an airport outside but within 5 nm gets "TFR n nm"; farther, nothing', () => {
        const c = client();
        const out = c.near(34.66, -80.86, 5, NOW);                                  // ~3.5 nm outside the ring
        expect(out).toHaveLength(1); expect(out[0].distanceNm).toBeGreaterThan(2); expect(out[0].distanceNm).toBeLessThan(5);
        expect(c.near(34.40, -80.95, 5, NOW)).toEqual([]);
    });

    it('the airport panel shows the TFR first, with altitudes, times and the NOTAM text behind a button', () => {
        const ap = Object.create(AirportPopup.prototype);
        global.window.app = { faaTfr: client() };
        global.VectorMapLayers = VectorMapLayers;
        const html = ap._tfrBlockHtml({ icao: 'KLKR', lat: 34.722904, lon: -80.854590 });
        expect(html).toContain('IN TFR 6/3091 · VIP');
        expect(html).toContain('SFC – 17,999 ft MSL');
        expect(html).toContain('(2030Z)');
        expect(html).toContain('apt-tfr-textbtn');
        const d = document.createElement('div'); d.innerHTML = html;
        expect(d.querySelector('.apt-tfr-text').hidden).toBe(true);
        delete global.window.app; delete global.VectorMapLayers;
    });

    it('no TFR data, or none near: no block', () => {
        const ap = Object.create(AirportPopup.prototype);
        expect(ap._tfrBlockHtml({ lat: 34.7, lon: -80.8 })).toBe('');
        localStorage.clear();
        global.window.app = { faaTfr: new FaaTfrClient() };
        expect(ap._tfrBlockHtml({ lat: 34.7, lon: -80.8 })).toBe('');
        delete global.window.app;
    });
});
