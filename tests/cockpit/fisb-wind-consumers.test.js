/**
 * FIS-B winds aloft consumers (PR #196 side effects).
 *
 * Until 4eda784 no Stratux WINDS frame parsed, so fisbClient.winds was always empty and every consumer below
 * ran for the first time once it did:
 *  1. route-table.js _applyFisbWinds: a waypoint with no plan wind took the nearest station's wind with no
 *     distance or age limit, and kept it when no FIS-B wind was there any more. Now: only a station within the
 *     pilot's windMaxStationNm and a report received within windMaxAgeMin (GlideInputs.settings(), the same
 *     limits the glide panel uses); otherwise an earlier FIS-B wind is cleared. Planner winds are never touched.
 *  2. fisb-weather.js wind barbs sorted on `a.ft`; wind entries carry `alt`.
 *  3. fisb-nexrad.js storm-motion arrow read `wind.speed`; wind entries carry `spd`. The FD direction is the
 *     direction the wind blows FROM; the arrow points the way the storm moves (dir + 180).
 *
 * Wind entries come from the real FisbClient parsing the real Stratux CAR WINDS frame (split as Stratux sends
 * it: Type, Location, Time, Data), as tests/shared/fisb-badge.test.js does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.DiagLog = { log: vi.fn() };
const FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();
const NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const GlideModel = new Function(read('web/shared/glide-model.js') + '\nreturn GlideModel;')();
const GlideInputs = new Function(read('web/cockpit/glide-inputs.js') + '\nreturn GlideInputs;')();
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();
const FisbWeatherDisplay = new Function(read('web/cockpit/fisb-weather.js') + '\nreturn FisbWeatherDisplay;')();
const FisbNexrad = new Function(read('web/cockpit/fisb-nexrad.js') + '\nreturn FisbNexrad;')();

const stratuxMsg = (m) => { const x = m.split(' '); return { Type: x[0], Location: x[1], Time: x[2], Data: x.slice(3).join(' ') }; };
const WINDS_CAR = "WINDS CAR 071800Z  FT 3000 6000      9000   12000       18000   24000   30000    34000  39000                         \n   2630 2845+15 2945+10 2842+05 2838-07 2729-17 284032 284243 304756\n";
const CAR = { lat: 46.87, lon: -68.02 };
const NOW = Date.parse('2026-10-07T18:30:00Z');
const MIN = 60000;

async function carClient() {
    const c = new FisbClient(new EventTarget(), { getAirport: async (id) => (id === 'KCAR' ? CAR : null), getNavaid: async () => null });
    await c._handleWeather(stratuxMsg(WINDS_CAR));
    await new Promise((r) => setTimeout(r, 0));      // station coords resolve asynchronously
    return c;
}

// ---------------------------------------------------------------------------------------------------------------
describe('route table: FIS-B winds only within the wind-trust limits', () => {
    const LIMITS = { windMaxStationNm: 50, windMaxAgeMin: 60 };   // not the defaults (100 nm / 360 min)
    let rt;

    function table(fisb, waypoints) {
        const t = Object.create(RouteTable.prototype);
        t._fisbClient = fisb;
        t._waypoints = waypoints;
        t._editMode = false;
        t._computeEnroute = vi.fn();
        t._renderTable = vi.fn();
        return t;
    }
    // ~1 nm from CAR, and ~60 nm north of it (beyond 50, within the 100 nm default)
    const nearWp = () => ({ icao: 'NEAR', lat: 46.88, lon: -68.02, alt: 6000, wind: null });
    const farWp = () => ({ icao: 'FAR', lat: 47.87, lon: -68.02, alt: 6000, wind: null });
    const dep = () => ({ icao: 'KCAR', lat: CAR.lat, lon: CAR.lon });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        globalThis.NasrDB = NasrDB;
        globalThis.GlideModel = GlideModel;
        globalThis.GlideInputs = GlideInputs;
        globalThis.CockpitConfig = { aircraft: () => undefined, get: (k) => (k === 'engineOutGlide' ? LIMITS : undefined) };
    });
    afterEach(() => {
        vi.useRealTimers();
        for (const k of ['NasrDB', 'GlideModel', 'GlideInputs', 'CockpitConfig']) delete globalThis[k];
    });

    it('a station within the limit, received just now: applied, ETE recomputed', async () => {
        rt = table(await carClient(), [dep(), nearWp()]);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toMatchObject({ dir: 280, spd: 45, _fisbApplied: true });
        expect(rt._waypoints[1]._wind).toBe(rt._waypoints[1].wind);
        expect(rt._computeEnroute).toHaveBeenCalledTimes(1);
        expect(rt._renderTable).toHaveBeenCalledTimes(1);
    });

    it('the nearest station is farther than windMaxStationNm: ignored', async () => {
        rt = table(await carClient(), [dep(), farWp()]);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toBeNull();
        expect(rt._computeEnroute).not.toHaveBeenCalled();
    });

    it('the report is older than windMaxAgeMin: ignored', async () => {
        const c = await carClient();
        vi.setSystemTime(NOW + 61 * MIN);
        rt = table(c, [dep(), nearWp()]);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toBeNull();
    });

    it('an applied FIS-B wind is cleared when it goes stale, and when there is no FIS-B wind at all', async () => {
        const c = await carClient();
        rt = table(c, [dep(), nearWp(), nearWp()]);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toMatchObject({ dir: 280, spd: 45 });
        vi.setSystemTime(NOW + 61 * MIN);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toBeNull();
        expect(rt._waypoints[1]._wind).toBeNull();
        expect(rt._computeEnroute).toHaveBeenCalledTimes(2);

        vi.setSystemTime(NOW);
        rt._applyFisbWinds();
        expect(rt._waypoints[2].wind).toMatchObject({ dir: 280, spd: 45 });
        c.winds.clear();                                  // getNearestWind -> null
        rt._applyFisbWinds();
        expect(rt._waypoints[2].wind).toBeNull();
    });

    it('a planner wind is never replaced or cleared', async () => {
        const c = await carClient();
        const planned = { dir: 100, spd: 20 };
        const far = { ...farWp(), wind: { dir: 200, spd: 15 } };
        rt = table(c, [dep(), { ...nearWp(), wind: planned }, far]);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toBe(planned);
        expect(rt._waypoints[1].wind).toEqual({ dir: 100, spd: 20 });
        expect(rt._waypoints[2].wind).toEqual({ dir: 200, spd: 15 });
        c.winds.clear();
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toBe(planned);
        expect(rt._waypoints[2].wind).toEqual({ dir: 200, spd: 15 });
        expect(rt._computeEnroute).not.toHaveBeenCalled();
    });

    it('the limits are read when applied: a later settings change takes effect', async () => {
        const c = await carClient();
        rt = table(c, [dep(), farWp()]);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toBeNull();
        globalThis.CockpitConfig = { aircraft: () => undefined, get: (k) => (k === 'engineOutGlide' ? { ...LIMITS, windMaxStationNm: 80 } : undefined) };
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toMatchObject({ dir: 280, spd: 45 });
    });

    it('no GlideInputs: GlideModel.DEFAULTS.pilot (100 nm); neither: no FIS-B wind is trusted', async () => {
        const c = await carClient();
        delete globalThis.GlideInputs;
        rt = table(c, [dep(), farWp()]);
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toMatchObject({ dir: 280, spd: 45 });   // 60 nm <= 100 nm default
        delete globalThis.GlideModel;
        rt._applyFisbWinds();
        expect(rt._waypoints[1].wind).toBeNull();
    });
});

// ---------------------------------------------------------------------------------------------------------------
describe('wind barbs: rows sorted low to high by alt', () => {
    let html;
    beforeEach(() => {
        html = null;
        const marker = { bindPopup() { return this; }, addTo() { return this; } };
        globalThis.L = { divIcon: (o) => { html = o.html; return o; }, marker: () => marker };
    });
    afterEach(() => { delete globalThis.L; });

    it('entries arriving 12k, 3k, 9k, 6k render 3k, 6k, 9k, 12k', async () => {
        const c = await carClient();
        const shuffled = new Map();
        for (const k of ['CAR:12000', 'CAR:3000', 'CAR:9000', 'CAR:6000']) shuffled.set(k, c.winds.get(k));
        const d = Object.create(FisbWeatherDisplay.prototype);
        d._fisb = { winds: shuffled };
        d._windsLayer = { clearLayers() {} };
        d._windMarkers = new Map();
        d._refreshWindBarbs();
        expect(d._windMarkers.has('CAR')).toBe(true);
        const labels = [...html.matchAll(/class="wb-alt">([^<]+)</g)].map((m) => m[1]);
        expect(labels).toEqual(['3k', '6k', '9k', '12k']);
    });
});

// ---------------------------------------------------------------------------------------------------------------
describe('CB building: storm-motion arrow from a real FIS-B wind entry', () => {
    let lines;
    beforeEach(() => {
        lines = [];
        const layer = (extra = {}) => ({ addTo() { return this; }, ...extra });
        globalThis.L = {
            polygon: () => layer(),
            marker: () => layer(),
            divIcon: (o) => o,
            polyline: (pts, opts) => { const l = layer({ pts, opts }); lines.push(l); return l; },
        };
        globalThis.FisbClient = FisbClient;
    });
    afterEach(() => { delete globalThis.L; delete globalThis.FisbClient; });

    it('CAR 18000 is 280/38: the arrow points 100 deg (downwind), 38 x 0.75 x 15 min = 7.1 nm', async () => {
        const c = await carClient();
        const n = Object.create(FisbNexrad.prototype);
        n._map = { removeLayer() {} };
        n._fisb = c;
        n._cbOverlays = [];
        n._cbLabelMarkers = [];
        const cell = {
            points: [[46.80, -68.10], [46.80, -67.94], [46.94, -67.94], [46.94, -68.10]],
            growthRate: 0.3, gainedHighIntensity: false,
        };
        n._renderCbOverlays([cell], null);
        expect(lines).toHaveLength(1);
        const [[lat0, lon0], [lat1, lon1]] = lines[0].pts;
        expect(n._cbOverlays).toContain(lines[0]);
        const brg = (Math.atan2((lon1 - lon0) * Math.cos(lat0 * Math.PI / 180), lat1 - lat0) * 180 / Math.PI + 360) % 360;
        expect(brg).toBeCloseTo(100, 0);
        expect(NasrDB.haversineNm(lat0, lon0, lat1, lon1)).toBeCloseTo(38 * 0.75 * 0.25, 1);
    });

    it('5 kt or less: no arrow', async () => {
        const n = Object.create(FisbNexrad.prototype);
        n._map = { removeLayer() {} };
        n._fisb = { getNearestWind: () => ({ dir: 280, spd: 5, alt: 18000, station: 'CAR' }) };
        n._cbOverlays = [];
        n._cbLabelMarkers = [];
        n._renderCbOverlays([{ points: [[46.80, -68.10], [46.80, -67.94], [46.94, -67.94], [46.94, -68.10]], growthRate: 0.3 }], null);
        expect(lines).toHaveLength(0);
    });
});
