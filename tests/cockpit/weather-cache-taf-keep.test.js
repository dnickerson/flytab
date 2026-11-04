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
});

afterEach(() => {
    vi.useRealTimers();
    delete globalThis.FisbClient;
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
