/**
 * An internet METAR refresh (VectorMapLayers.fetchInternetMetars) writes the METAR into the IndexedDB
 * weather cache. It used to write `taf: null` too, wiping a cached FIS-B or plan TAF - the airport
 * panel's WX tab then had no TAF for that airport. It now keeps the cached TAF (read-merge, like
 * FisbClient), unless that TAF is older than 30 h (the cache's prune age, the longest a TAF is valid).
 *
 * Real: VectorMapLayers.fetchInternetMetars, FisbClient (TAF frame -> cache record).
 * Stubbed: fetch (a real AWC METAR, via the flywhere proxy 2026-11-04), the NASR weather store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();
const VectorMapLayers = new Function(read('web/cockpit/vector-map-layers.js') + '\nreturn VectorMapLayers;')();
const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();

const NOW = Date.parse('2026-11-04T17:00:00Z');
const AWC_METAR = {
    icaoId: 'KCLT', obsTime: 1793807520, fltCat: 'MVFR',
    rawOb: 'METAR KCLT 041552Z 15004KT 10SM BKN015 BKN040 OVC250 21/17 A3013 RMK AO2 SLP212 T02060167',
    clouds: [{ cover: 'BKN', base: 1500 }, { cover: 'BKN', base: 4000 }, { cover: 'OVC', base: 25000 }],
    wdir: 150, wspd: 4, temp: 20.6, dewp: 16.7, altim: 1020.4, visib: '10+',
};
const stratuxMsg = (m) => { const x = m.split(' '); return { Type: x[0], Location: x[1], Time: x[2], Data: x.slice(3).join(' ') }; };

let store, nasr;

function layers() {
    const v = Object.create(VectorMapLayers.prototype);
    v._nasr = nasr;
    v._internetMetars = new Map();
    v._internetFetchedAt = 0;
    v._internetFetchBounds = null;
    v._aptPositions = new Map();
    v._fisbClient = null;
    v._onInternetMetar = null;
    v._onInternetMetarsFetched = null;
    return v;
}
async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    store = {};
    nasr = {
        getWeather: vi.fn(async (id) => (store[id] ? JSON.parse(JSON.stringify(store[id])) : null)),
        putWeather: vi.fn(async (id, wx) => { store[id] = { icao: id, ...wx, fetched_at: wx.fetched_at || new Date().toISOString() }; }),
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [AWC_METAR] }));
    globalThis.FisbClient = FisbClient;
    globalThis.AirportPopup = AirportPopup;     // the validity check VectorMapLayers uses
});

afterEach(() => {
    vi.useRealTimers();
    delete globalThis.FisbClient;
    delete globalThis.AirportPopup;
});

describe('internet METAR refresh keeps the cached TAF', () => {
    it('a cached FIS-B TAF survives an internet METAR refresh for that airport', async () => {
        const fisb = new FisbClient(new EventTarget(), nasr);
        await fisb._handleWeather(stratuxMsg('TAF KCLT 041120Z 0412/0518 09004KT P6SM BKN015 FM041800 15008KT P6SM BKN030'));
        await settle();
        expect(store.KCLT.taf.raw).toBe('KCLT 041120Z 0412/0518 09004KT P6SM BKN015 FM041800 15008KT P6SM BKN030');

        await layers().fetchInternetMetars(34, -82, 36, -80);
        await settle();
        expect(store.KCLT.metar.raw).toBe(AWC_METAR.rawOb);
        expect(store.KCLT.source).toBe('internet');
        expect(store.KCLT.fetched_at).toBe(new Date(NOW).toISOString());
        expect(store.KCLT.taf.raw).toBe('KCLT 041120Z 0412/0518 09004KT P6SM BKN015 FM041800 15008KT P6SM BKN030');
    });

    it('a plan TAF (no fetched_at of its own) survives too, aged from the record it came with', async () => {
        const planAt = new Date(NOW - 2 * 3600000).toISOString();
        store.KCLT = { icao: 'KCLT', metar: { raw: 'KCLT 041452Z OLD' }, taf: { raw: 'TAF KCLT 041120Z 0412/0518 X' }, fetched_at: planAt, source: 'plan' };
        await layers().fetchInternetMetars(34, -82, 36, -80);
        await settle();
        expect(store.KCLT.metar.raw).toBe(AWC_METAR.rawOb);
        expect(store.KCLT.taf.raw).toBe('TAF KCLT 041120Z 0412/0518 X');
        expect(store.KCLT.taf.fetched_at).toBe(planAt);     // its age carries on: METAR refreshes don't make it new
    });

    it('a cached TAF older than 30 h is not carried forward (no immortal TAF)', async () => {
        const old = new Date(NOW - 31 * 3600000).toISOString();
        store.KCLT = { icao: 'KCLT', taf: { raw: 'TAF KCLT 021120Z 0212/0318 X', fetched_at: old }, fetched_at: old, source: 'fisb' };
        await layers().fetchInternetMetars(34, -82, 36, -80);
        await settle();
        expect(store.KCLT.metar.raw).toBe(AWC_METAR.rawOb);
        expect(store.KCLT.taf).toBeNull();
    });

    it('no cached record: the METAR is written with taf null, as before', async () => {
        await layers().fetchInternetMetars(34, -82, 36, -80);
        await settle();
        expect(store.KCLT.metar.raw).toBe(AWC_METAR.rawOb);
        expect(store.KCLT.taf).toBeNull();
        expect(store.KCLT.source).toBe('internet');
    });

    it('a cache read that fails still writes the METAR', async () => {
        nasr.getWeather = vi.fn(async () => { throw new Error('idb'); });
        await layers().fetchInternetMetars(34, -82, 36, -80);
        await settle();
        expect(store.KCLT.metar.raw).toBe(AWC_METAR.rawOb);
    });
});

describe('an expired cached TAF is not kept, and never shown (reviewer scenario)', () => {
    it('plan TAF valid to 04 1200Z, fetched 04 0900Z; METAR refresh at 05 1000Z; proxy has no TAF -> no TAF', async () => {
        store.KXYZ = {
            icao: 'KXYZ', metar: { raw: 'KXYZ 040853Z 00000KT 10SM CLR', decoded: {} },
            taf: { raw: 'TAF KXYZ 031120Z 0312/0412 09004KT P6SM BKN015', fetched_at: '2026-11-04T09:00:00Z' },
            source: 'plan', fetched_at: '2026-11-04T09:00:00Z',
        };
        vi.setSystemTime(Date.parse('2026-11-05T10:00:00Z'));
        layers()._cacheInternetMetar('KXYZ', { raw: 'METAR KXYZ 050953Z 18005KT 10SM CLR', decoded: {} }, Date.now());
        await settle();
        expect(store.KXYZ.metar.raw).toBe('METAR KXYZ 050953Z 18005KT 10SM CLR');
        expect(store.KXYZ.taf).toBeNull();                      // expired 22 h ago: not carried forward

        // even had it been kept, the panel would not show it
        store.KXYZ.taf = { raw: 'TAF KXYZ 031120Z 0312/0412 09004KT P6SM BKN015', fetched_at: '2026-11-04T09:00:00Z' };
        globalThis.wireTap = wireTap;
        globalThis.NasrDB = { haversineNm: () => 5 };
        globalThis.CockpitConfig = { get: () => null };
        globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }));
        document.body.innerHTML = '';
        const p = new AirportPopup({ closePopup() {} }, { ...nasr, getRemarks: async () => [] });
        p.initPanel(document.body);
        await p.show({ icao: 'KXYZ', name: 'X', lat: 35, lon: -80, elev_ft: 700, runways: [], frequencies: [] });
        await settle();
        expect(document.querySelector('.wx-taf')).toBeNull();
        delete globalThis.NasrDB;
        delete globalThis.CockpitConfig;
    });

    it('a cached TAF with no validity group falls back to the 30 h fetch age', async () => {
        const t = 'TAF KXYZ 041120Z 09004KT P6SM';                // no validity group
        store.KXYZ = { icao: 'KXYZ', taf: { raw: t, fetched_at: new Date(NOW - 29 * 3600000).toISOString() }, fetched_at: new Date(NOW).toISOString() };
        layers()._cacheInternetMetar('KXYZ', { raw: 'METAR KXYZ 041653Z X', decoded: {} }, NOW);
        await settle();
        expect(store.KXYZ.taf.raw).toBe(t);
        vi.setSystemTime(NOW + 2 * 3600000);
        layers()._cacheInternetMetar('KXYZ', { raw: 'METAR KXYZ 041853Z X', decoded: {} }, Date.now());
        await settle();
        expect(store.KXYZ.taf).toBeNull();
    });
});
