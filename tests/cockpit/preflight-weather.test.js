/**
 * Pre-flight Weather row reads the Weather Cache (Dana, 2026-10-17: "the
 * weather is actually cached, you can see it in the data and maps page").
 * It read only a plan's weather_cache, which only flywhere.app plans carry, so
 * a route built on the tablet always said "Not cached" while the per-airport
 * cache (moving map on WiFi, FIS-B in flight) had minutes-old METARs.
 * The cache is also pruned: entries older than 12 h are deleted at start and hourly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.FaaCurrency = new Function(read('web/shared/faa-currency.js') + '\nreturn FaaCurrency;')();
const PreflightCheck = new Function(read('web/cockpit/preflight-check.js') + '\nreturn PreflightCheck;')();
globalThis.RouteCheck = globalThis.RouteCheck || {};
const FlyTabApp = new Function(read('web/app.js') + '\nreturn FlyTabApp;')();

const NOW = Date.parse('2026-10-17T17:30:00Z');
const metar = (minAgo) => ({ metar: { raw: 'x', decoded: { observed_at: new Date(NOW - minAgo * 60000).toISOString() },
                                      fetched_at: new Date(NOW - 2 * 60000).toISOString() } });
const plan = { departure: 'KLKR', destination: 'KCLT', flight_plan: { departure: 'KLKR', destination: 'KCLT' } };
const check = (cache, p = plan) => PreflightCheck.prototype._checkWeather.call(
    { db: { getWeather: async (icao) => cache[icao] || null } }, p);

describe('pre-flight Weather row: the route airports\' cached METARs', () => {
    afterEach(() => vi.useRealTimers());

    it('fresh METARs at departure and destination: ok, with their ages', async () => {
        vi.useFakeTimers({ now: NOW });
        const r = await check({ KLKR: metar(15), KCLT: metar(40) });
        expect(r).toMatchObject({ label: 'Weather', status: 'ok' });
        expect(r.msg).toMatch(/KLKR 15m/);
        expect(r.msg).toMatch(/KCLT 40m/);
    });

    it('age is from the observation time, not when it was received', async () => {
        vi.useFakeTimers({ now: NOW });
        const r = await check({ KLKR: metar(75), KCLT: metar(10) });     // received 2 min ago, observed 75 min ago
        expect(r.status).toBe('warn');
        expect(r.msg).toMatch(/KLKR 1h15m/);
    });

    it('older than 3 h: fail', async () => {
        vi.useFakeTimers({ now: NOW });
        const r = await check({ KLKR: metar(200), KCLT: metar(5) });
        expect(r.status).toBe('fail');
        expect(r.msg).toMatch(/KLKR 3h20m/);
    });

    it('an airport without a cached METAR (no weather station): caution naming it', async () => {
        vi.useFakeTimers({ now: NOW });
        const r = await check({ KLKR: metar(5) }, { departure: 'KLKR', destination: 'K9A9', flight_plan: { departure: 'KLKR', destination: 'K9A9' } });
        expect(r.status).toBe('warn');
        expect(r.msg).toMatch(/K9A9 no METAR cached/);
    });

    it('a cache keyed without the K (9A9) is found', async () => {
        vi.useFakeTimers({ now: NOW });
        const r = await check({ KLKR: metar(5), '9A9': metar(8) }, { flight_plan: { departure: 'KLKR', destination: 'K9A9' } });
        expect(r.status).toBe('ok');
    });

    it('no flight plan: fail as before', async () => {
        expect(await check({}, null)).toMatchObject({ status: 'fail', msg: 'No flight plan' });
    });
});

describe('weather cache pruning', () => {
    it('deletes entries older than 12 h', async () => {
        const clearOldWeather = vi.fn(async () => 3);
        await FlyTabApp.prototype._pruneWeatherCache.call({ _nasrDb: { clearOldWeather } });
        expect(clearOldWeather).toHaveBeenCalledWith(12 * 3600 * 1000);
    });
    it('runs at start and every hour', () => {
        const src = read('web/app.js');
        expect(src).toMatch(/this\._pruneWeatherCache\(\)/);
        expect(src).toMatch(/setInterval\(\(\) => this\._pruneWeatherCache\(\), 60 \* 60 \* 1000\)/);
    });
});
