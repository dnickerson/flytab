/**
 * The FIS-B badge stayed red the whole 10-27 KTBR-KLKR flight while FlyTab
 * received FIS-B every minute (12,177 METARs, 10,646 NEXRAD frames in its
 * weather log). It went by the Stratux /getStatus counters alone, and a reply
 * was never aged: one from the ground (UAT 0) could stand for the whole flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
const FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();

const NOW = Date.parse('2026-10-27T21:20:00Z');
// /getTowers: (lat,lng) -> ADSBTower (Stratux main/gen_gdl90.go @150f2828)
const inFlight = { '(34.5,-80.9)': { Lat: 34.5, Lng: -80.9, Messages_last_minute: 412 } };
const onGround = { '(34.5,-80.9)': { Lat: 34.5, Lng: -80.9, Messages_last_minute: 0 } };

describe('FisbClient.isReceiving (FIS-B badge)', () => {
    const at = (o) => FisbClient.isReceiving({ now: NOW, lastRxAt: 0, connected: true, towers: null, towersAt: 0, ...o });

    it('replay of 10-27: FIS-B arriving, towers last read on the ground -> green', () => {
        expect(at({ lastRxAt: NOW - 20_000, towers: onGround, towersAt: NOW - 50 * 60_000 })).toBe(true);
    });

    it('nothing from FlyTab for 2 min and only an old tower list -> red', () => {
        expect(at({ lastRxAt: NOW - 121_000, towers: inFlight, towersAt: NOW - 31_000 })).toBe(false);
    });

    it('fresh tower list with a ground station heard -> green', () => {
        expect(at({ towers: inFlight, towersAt: NOW - 5_000 })).toBe(true);
    });

    it('a tower once heard, nothing in the last minute (home, on the ground) -> red', () => {
        expect(at({ towers: onGround, towersAt: NOW - 5_000 })).toBe(false);
        expect(at({ towers: {}, towersAt: NOW - 5_000 })).toBe(false);
    });

    it('978 traffic alone (UAT messages, no tower uplink) -> red', () => {
        // Review 2026-10-29: /getStatus UAT_messages_last_minute counts aircraft too.
        expect(at({ status: { UAT_messages_last_minute: 90 }, statusAt: NOW - 5_000, towers: onGround, towersAt: NOW - 5_000 })).toBe(false);
    });

    it('Stratux link down: its tower list counts no more; FIS-B FlyTab just received still does', () => {
        expect(at({ connected: false, towers: inFlight, towersAt: NOW - 5_000 })).toBe(false);
        expect(at({ connected: false, lastRxAt: NOW - 5_000 })).toBe(true);
    });

    it('never received anything -> red; a clock step backwards does not count as fresh', () => {
        expect(at({})).toBe(false);
        expect(at({ lastRxAt: NOW + 60_000 })).toBe(false);
    });
});

describe('FisbClient notes when FIS-B arrives', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => vi.useRealTimers());
    const client = () => new FisbClient(new EventTarget(), null);

    it('a weather report, a NEXRAD frame and another FIS-B frame each set lastRxAt', async () => {
        let c = client();
        expect(c.lastRxAt).toBe(0);
        await c._handleWeather({ Type: 'METAR', Location: 'KTBR', Data: 'METAR KTBR 272055Z 24008KT 10SM CLR 24/09 A3005' });
        expect(c.lastRxAt).toBe(NOW);

        c = client();
        c._handleNexrad({ NEXRAD: [] });
        expect(c.lastRxAt).toBe(NOW);

        c = client();
        c._handleFisbFrame({ Product_id: 413, FISB_data: [] });
        expect(c.lastRxAt).toBe(NOW);
    });

    it('an empty weather message is not reception', async () => {
        const c = client();
        await c._handleWeather({});
        expect(c.lastRxAt).toBe(0);
    });
});

describe('StratuxClient /getStatus poll: aged and diagnosed', () => {
    let StratuxClient;
    beforeEach(() => {
        vi.useFakeTimers(); vi.setSystemTime(NOW);
        global.CockpitConfig = { raw: {} };
        global.Settings = { stratuxIp: '192.168.10.1', ownshipModeS: '000000' };
        DiagLog.log.mockClear();
        StratuxClient = new Function(read('web/shared/stratux-client.js') + '\nreturn StratuxClient;')();
    });
    afterEach(() => { vi.useRealTimers(); delete global.fetch; });

    it('a good reply records when it came; failing is logged once, and answering again', async () => {
        let mode = 'ok';
        global.fetch = vi.fn(async () => {
            if (mode === 'down') throw new TypeError('Failed to fetch');
            return { ok: true, status: 200, json: async () => inFlight };
        });
        const c = new StratuxClient();
        c._pollStatus();
        await vi.advanceTimersByTimeAsync(0);
        expect(c.deviceStatus).toEqual(inFlight);
        expect(c.deviceStatusAt).toBe(NOW);

        mode = 'down';
        await vi.advanceTimersByTimeAsync(30_000);              // three failed polls
        expect(c.deviceStatusAt).toBe(NOW);                     // the old reply keeps its time
        const failing = DiagLog.log.mock.calls.filter(([, m]) => /getStatus failing/.test(m));
        expect(failing).toHaveLength(1);
        expect(failing[0][1]).toContain('Failed to fetch');

        mode = 'ok';
        await vi.advanceTimersByTimeAsync(10_000);
        expect(DiagLog.log.mock.calls.filter(([, m]) => /getStatus answering again/.test(m))).toHaveLength(1);
        expect(c.deviceStatusAt).toBe(NOW + 40_000);
        clearInterval(c._statusTimer);
    });

    it('an HTTP error is a failure too, and keeps the last good reply', async () => {
        global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
        const c = new StratuxClient();
        c._pollStatus();
        await vi.advanceTimersByTimeAsync(0);
        expect(c.deviceStatus).toBeNull();
        expect(c.deviceStatusAt).toBe(0);
        expect(DiagLog.log).toHaveBeenCalledWith('stratux', 'getStatus failing: HTTP 503');
        clearInterval(c._statusTimer);
    });
});

describe('FisbClient.parseWindAloft (FD wind groups)', () => {
    // Review R23 (2026-10-31): only the bare '9900' was light and variable; at 6,000 ft and up
    // the group carries a temperature ('9900+05', '990045') and decoded as 490/100 kt.
    it('light and variable, with or without a temperature group -> null', () => {
        expect(FisbClient.parseWindAloft('9900')).toBeNull();
        expect(FisbClient.parseWindAloft('9900+05')).toBeNull();
        expect(FisbClient.parseWindAloft('9900-12')).toBeNull();
        expect(FisbClient.parseWindAloft('990045')).toBeNull();
    });

    it('ordinary groups decode unchanged', () => {
        expect(FisbClient.parseWindAloft('2714')).toEqual({ dir: 270, spd: 14, temp: null });
        expect(FisbClient.parseWindAloft('2819+13')).toEqual({ dir: 280, spd: 19, temp: 13 });
    });

    it('100 kt and over (direction + 50) still decodes: 7315-20 -> 230/115', () => {
        expect(FisbClient.parseWindAloft('7315-20')).toEqual({ dir: 230, spd: 115, temp: -20 });
    });

    it('empty or junk -> null', () => {
        expect(FisbClient.parseWindAloft('')).toBeNull();
        expect(FisbClient.parseWindAloft(null)).toBeNull();
        expect(FisbClient.parseWindAloft('ABCD')).toBeNull();
    });
});

describe('FisbClient winds: a light-and-variable report replaces the old wind (review R28)', () => {
    const COORDS = { KCLT: { lat: 35.21, lon: -80.94 }, KCAE: { lat: 33.94, lon: -81.12 } };
    const client = () => new FisbClient(new EventTarget(), { getAirport: async (id) => COORDS[id] || null, getNavaid: async () => null });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const frame = (rows) => ['FD1 WINDS 311800 DATA BASED ON 311200Z', 'STN  3000  6000', ...rows].join('\n');
    const near = (c, alt) => { const w = c.getNearestWind(35.2, -80.9, alt); return w && [w.station, w.dir, w.spd]; };

    it('CLT 2714 at 3000, then CLT 9900 at 3000: CLT\'s old 270/14 is gone; the next station answers', async () => {
        const c = client();
        c._handleWinds(frame(['CLT  2714  2819+13', 'CAE  0910  1015+10']), Date.now());
        await flush();
        expect(near(c, 3000)).toEqual(['CLT', 270, 14]);
        expect(near(c, 6000)).toEqual(['CLT', 280, 19]);

        c._handleWinds(frame(['CLT  9900  9900+05']), Date.now());
        await flush();
        expect(c.winds.has('CLT:3000')).toBe(false);
        expect(c.winds.has('CLT:6000')).toBe(false);
        expect(near(c, 3000)).toEqual(['CAE', 90, 10]);
        expect(near(c, 6000)).toEqual(['CAE', 100, 15]);
    });

    it('only station light and variable -> no wind at all; a junk group leaves the old wind alone', async () => {
        const c = client();
        c._handleWinds(frame(['CLT  2714  2819+13']), Date.now());
        await flush();
        c._handleWinds(frame(['CLT  9900  XXXX']), Date.now());
        await flush();
        expect(c.getNearestWind(35.2, -80.9, 3000)).toBeNull();
        expect(near(c, 6000)).toEqual(['CLT', 280, 19]);   // unparseable, not light and variable: unchanged
    });
});

/**
 * Stratux text reports (b3nn0/stratux main/gen_gdl90.go registerADSBTextMessageReceived) are split on spaces:
 * Type = x[0], Location = x[1], Time = x[2], Data = x[3:] joined with spaces. The station and the DDHHMMZ time
 * are NOT in Data. The frames below are real decoded reports from Stratux's sample UAT logs (its uatparse),
 * split exactly as Stratux sends them. Before the fix: winds stored 0, getNearestWind null; METARs had no
 * observation time.
 */
const stratuxMsg = (m) => { const x = m.split(' '); return { Type: x[0], Location: x[1], Time: x[2], Data: x.slice(3).join(' ') }; };
const WINDS_CAR = "WINDS CAR 071800Z  FT 3000 6000      9000   12000       18000   24000   30000    34000  39000                         \n   2630 2845+15 2945+10 2842+05 2838-07 2729-17 284032 284243 304756\n";
// TRI is a high station: the 3000 column is absent from BOTH the FT header and the data row.
const WINDS_TRI = "WINDS TRI 071800Z  FT      6000      9000   12000       18000   24000   30000    34000  39000                         \n        1205+15 1106+09 0809+03 1110-07 1308-17 161034 211544 071055\n";
const METAR_KARR = "METAR KARR 062152Z 21012KT 7SM CLR 33/19 A3001 RMK AO2 SLP155 \n    T03280189=\n";

describe('FisbClient winds: the Stratux WINDS frame (station = Location, report time = Time)', () => {
    const COORDS = { KCAR: { lat: 46.87, lon: -68.02 }, KTRI: { lat: 36.48, lon: -82.41 } };
    const client = () => new FisbClient(new EventTarget(), { getAirport: async (id) => COORDS[id] || null, getNavaid: async () => null });
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const w = (c, key) => { const e = c.winds.get(key); return e ? [e.dir, e.spd, e.temp] : null; };

    it('CAR, every level: each group under its altitude', async () => {
        const c = client();
        await c._handleWeather(stratuxMsg(WINDS_CAR));
        await flush();
        expect([...c.winds.keys()].filter((k) => k.startsWith('CAR:'))).toHaveLength(9);
        expect(w(c, 'CAR:3000')).toEqual([260, 30, null]);
        expect(w(c, 'CAR:6000')).toEqual([280, 45, 15]);
        expect(w(c, 'CAR:9000')).toEqual([290, 45, 10]);
        expect(w(c, 'CAR:12000')).toEqual([280, 42, 5]);
        expect(w(c, 'CAR:39000').slice(0, 2)).toEqual([300, 47]);
        const e = c.winds.get('CAR:6000');
        expect(e.station).toBe('CAR');
        expect(e.alt).toBe(6000);
        expect(e.issued).toBe('071800Z');
        expect(e.received_at).toBe(c.lastRxAt);       // receipt time, unchanged semantics
    });

    it('TRI, no 3000 column: 6000 is 120/05, not shifted to 3000', async () => {
        const c = client();
        await c._handleWeather(stratuxMsg(WINDS_TRI));
        await flush();
        expect(c.winds.has('TRI:3000')).toBe(false);
        expect(w(c, 'TRI:6000')).toEqual([120, 5, 15]);
        expect(w(c, 'TRI:9000')).toEqual([110, 6, 9]);
        expect(w(c, 'TRI:12000')).toEqual([80, 9, 3]);
        expect(w(c, 'TRI:39000').slice(0, 2)).toEqual([70, 10]);
    });

    it('a data row with fewer groups than the header is aligned from the right', async () => {
        const c = client();
        c._handleWinds(' FT 3000 6000 9000\n 1205+15 1106+09\n', Date.now(), 'TRI', '071800Z');
        await flush();
        expect(c.winds.has('TRI:3000')).toBe(false);
        expect(w(c, 'TRI:6000')).toEqual([120, 5, 15]);
        expect(w(c, 'TRI:9000')).toEqual([110, 6, 9]);
        // more groups than altitudes cannot be placed: nothing stored
        c._handleWinds(' FT 6000 9000\n 2630 2845+15 2945+10\n', Date.now(), 'CAR', '071800Z');
        expect([...c.winds.keys()].some((k) => k.startsWith('CAR:'))).toBe(false);
    });

    it('getNearestWind returns them, with the station position from NASR', async () => {
        const c = client();
        await c._handleWeather(stratuxMsg(WINDS_CAR));
        await c._handleWeather(stratuxMsg(WINDS_TRI));
        await flush();
        const near = c.getNearestWind(36.5, -82.4, 6000);
        expect(near).toMatchObject({ station: 'TRI', alt: 6000, dir: 120, spd: 5, lat: 36.48, lon: -82.41, issued: '071800Z' });
        expect(c.getNearestWind(46.9, -68.0, 3000)).toMatchObject({ station: 'CAR', alt: 3000, dir: 260, spd: 30 });
        // no TRI 3000: the nearest station that has 3000 answers
        expect(c.getNearestWind(36.5, -82.4, 3000)).toMatchObject({ station: 'CAR', alt: 3000 });
    });

    it('a later light-and-variable group (9900) deletes that station:alt entry', async () => {
        const c = client();
        await c._handleWeather(stratuxMsg(WINDS_CAR));
        await flush();
        const lv = WINDS_CAR.replace('   2630 2845+15', '   9900 9900+15');
        await c._handleWeather(stratuxMsg(lv));
        await flush();
        expect(c.winds.has('CAR:3000')).toBe(false);
        expect(c.winds.has('CAR:6000')).toBe(false);
        expect(w(c, 'CAR:9000')).toEqual([290, 45, 10]);
    });

    it('no station (no Location) and no header: nothing stored, nothing thrown', async () => {
        const c = client();
        c._handleWinds(' FT 3000 6000\n 2630 2845+15\n', Date.now(), '', '');
        c._handleWinds(' 2630 2845+15\n', Date.now(), 'CAR', '071800Z');
        expect(c.winds.size).toBe(0);
    });
});

describe('FisbClient METAR: the Stratux METAR frame (station and time are separate fields)', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-10-06T22:00:00Z')); });
    afterEach(() => vi.useRealTimers());

    it('the report is rebuilt as "KARR 062152Z ...": icao, observed_at and wind decoded', async () => {
        const c = new FisbClient(new EventTarget(), null);
        await c._handleWeather(stratuxMsg(METAR_KARR));
        const e = c.getMetar('KARR');
        expect(e).not.toBeNull();
        expect(e.raw.startsWith('KARR 062152Z 21012KT 7SM CLR')).toBe(true);
        expect(e.decoded.icao).toBe('KARR');
        expect(e.decoded.observed_at).toBe('2026-10-06T21:52:00.000Z');
        expect([e.decoded.wind_dir, e.decoded.wind_speed]).toEqual([210, 12]);
    });

    it('Data that already carries the station is left alone; no usable time adds the station only', () => {
        expect(FisbClient.metarText('METAR KTBR 272055Z 24008KT', 'KTBR', '272055Z')).toBe('METAR KTBR 272055Z 24008KT');
        expect(FisbClient.metarText('KTBR 272055Z 24008KT', 'KTBR', '')).toBe('KTBR 272055Z 24008KT');
        expect(FisbClient.metarText('24008KT 10SM', 'KTBR', '')).toBe('KTBR 24008KT 10SM');
        expect(FisbClient.metarText('24008KT 10SM', '', '272055Z')).toBe('24008KT 10SM');
        expect(FisbClient.decodeMetar(FisbClient.metarText('24008KT 10SM', 'KTBR', '')).observed_at).toBeUndefined();
    });
});
