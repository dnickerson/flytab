/**
 * WX Briefing METARs/TAFs (Dana, 2026-11-07: "METAR and TAFs are not available
 * in the weather briefing"). The route bbox went out at full float precision
 * (34.36058515942029, ...); AWC answers a bbox with 7+ decimals with HTTP 400
 * (verified 2026-11-08: 6 decimals 200, 7 decimals 400, METAR and TAF), which
 * the flywhere proxy turns into a 502 without CORS -> "Failed to fetch" in the
 * WebView, and the briefing showed no METARs or TAFs for the route.
 * A TAF bbox with no TAF airport in it is AWC 204, no body: that is "no TAFs",
 * not a failure.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

global.wireTap = global.wireTap || ((el, fn) => el?.addEventListener?.('click', fn));
global.Settings = global.Settings || { workerBase: 'https://www.flywhere.app/api' };
global.WeatherClient = global.WeatherClient || { decodeMetar: () => ({}) };
const WxBriefing = new Function(`${readFileSync('web/cockpit/wx-briefing.js', 'utf8')}\nreturn WxBriefing;`)();

// SC76 -> KLKR, the route on the tablet when it failed (corridor 25 mi).
const ROUTE = [{ icao: 'SC76', lat: 34.80265, lon: -80.680066 }, { icao: 'KLKR', lat: 34.722904, lon: -80.85459 }];
function makeWx() {
    const wx = Object.create(WxBriefing.prototype);
    Object.assign(wx, { _routeCoords: ROUTE, _corridorMi: 25 });
    return wx;
}
const decimals = (v) => (String(v).split('.')[1] || '').length;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('route bbox sent to AWC', () => {
    it('has at most 4 decimals on every edge (AWC rejects 7+)', async () => {
        const box = await makeWx()._getRouteBbox(25 / 69);
        for (const k of ['s', 'n', 'w', 'e']) expect(decimals(box[k]), k).toBeLessThanOrEqual(4);
    });

    it('is rounded outward, so it still covers the whole buffered route', async () => {
        const buf = 25 / 69;
        const box = await makeWx()._getRouteBbox(buf);
        expect(box.s).toBeLessThanOrEqual(34.722904 - buf);
        expect(box.n).toBeGreaterThanOrEqual(34.80265 + buf);
        expect(box.w).toBeLessThanOrEqual(-80.85459 - buf);
        expect(box.e).toBeGreaterThanOrEqual(-80.680066 + buf);
        expect(box.n - box.s).toBeLessThan((34.80265 + buf) - (34.722904 - buf) + 0.0003);
    });

    it('the METAR and TAF URLs carry those short numbers', async () => {
        const urls = [];
        globalThis.fetch = vi.fn(async (u) => { urls.push(u); return { ok: true, status: 200, json: async () => [] }; });
        const wx = makeWx();
        const box = await wx._getRouteBbox(25 / 69);
        await wx._fetchMetarsByBbox(box);
        await wx._fetchTafsByBbox(box);
        for (const u of urls) {
            const bbox = new URL(u).searchParams.get('bbox').split(',');
            expect(bbox).toHaveLength(4);
            for (const v of bbox) expect(decimals(v), u).toBeLessThanOrEqual(4);
        }
    });
});

describe('TAF bbox with no TAF airport in it', () => {
    it('a 204 (no body) is no TAFs, not a failure', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } }));
        await expect(makeWx()._fetchTafsByBbox({ s: 34.3605, n: 35.165, w: -81.217, e: -80.3177 })).resolves.toEqual({});
    });

    it('a real failure still rejects (the briefing shows "TAFs unavailable")', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }));
        await expect(makeWx()._fetchTafsByBbox({ s: 34.3605, n: 35.165, w: -81.217, e: -80.3177 })).rejects.toThrow('502');
    });
});
