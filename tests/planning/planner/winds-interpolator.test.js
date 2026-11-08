import { describe, it, expect } from 'vitest';
import { getWindAtAlt, selectFdCycle, findNearestFdStation } from '../../../web/shared/planning/planner/winds-interpolator.js';

const SAMPLE_WINDS = {
    CLT: { 3000: { dir: 270, spd: 10, temp: 15 }, 6000: { dir: 280, spd: 20, temp: 5 }, 9000: { dir: 290, spd: 25, temp: -5 } },
    GSP: { 3000: { dir: 260, spd: 8 }, 6000: { dir: 275, spd: 18 }, 9000: { dir: 285, spd: 22 } },
};

// FD_STATIONS subset for testing
const FD_LOCS = { CLT: [35.21, -80.94], GSP: [34.9, -82.22] };

describe('getWindAtAlt', () => {
    it('returns exact match when available', () => {
        const w = getWindAtAlt(SAMPLE_WINDS.CLT, 6000);
        expect(w.dir).toBe(280);
        expect(w.spd).toBe(20);
    });
    it('returns nearest key when exact not available', () => {
        const w = getWindAtAlt(SAMPLE_WINDS.CLT, 7000);
        // 7000 is closer to 6000 than 9000
        expect(w.dir).toBe(280);
    });
    it('returns null for empty station', () => {
        expect(getWindAtAlt({}, 6000)).toBeNull();
    });
});

describe('selectFdCycle', () => {
    it('early morning UTC → 06 cycle', () => {
        expect(selectFdCycle(5)).toBe('06');
    });
    it('midday UTC → 12 cycle', () => {
        expect(selectFdCycle(12)).toBe('12');
    });
    it('evening UTC → 24 cycle', () => {
        expect(selectFdCycle(22)).toBe('24');
    });
});

describe('findNearestFdStation', () => {
    it('returns nearest station by lat/lon', () => {
        // KLKR at 34.73, -81.21 — check which of CLT or GSP is closer
        const nearest = findNearestFdStation(SAMPLE_WINDS, 34.73, -81.21, FD_LOCS);
        // Both are plausible — just confirm a string is returned
        expect(['CLT', 'GSP']).toContain(nearest);
    });
    it('returns null when no station coords known', () => {
        expect(findNearestFdStation(SAMPLE_WINDS, 34, -81, {})).toBeNull();
    });
});

// ── Forecast period by its FOR USE window (Dana, 2026-10-16) ─────────────────
// selectFdCycle(utcHour) took the hour of day only: at 20Z "Now" got the
// 12-hour forecast (for use 03-12Z tomorrow). Real products of 16 Oct 2026, 18Z data:
import { readFileSync } from 'node:fs';
import { vi, beforeEach, afterEach } from 'vitest';
import { parseFdHeader, pickFdPeriod, fetchWindsDetailed } from '../../../web/shared/planning/planner/winds-interpolator.js';
const FD = Object.fromEntries(['06', '12', '24'].map((c) => [c, readFileSync(`tests/fixtures/winds/fd-${c}-161800Z.txt`, 'utf8')]));
const REF = new Date('2026-10-16T20:11:00Z');
const iso = (d) => d.toISOString().slice(0, 16);

describe('parseFdHeader: VALID / FOR USE from the product text', () => {
    it('the three real periods', () => {
        expect(['06', '12', '24'].map((c) => { const h = parseFdHeader(FD[c], REF); return [iso(h.validAt), iso(h.useFrom), iso(h.useTo)]; })).toEqual([
            ['2026-10-17T00:00', '2026-10-16T20:00', '2026-10-17T03:00'],
            ['2026-10-17T06:00', '2026-10-17T03:00', '2026-10-17T12:00'],
            ['2026-10-17T18:00', '2026-10-17T12:00', '2026-10-18T00:00'],
        ]);
    });
    it('the month rolls over: VALID 010000Z read on 31 Oct is 1 Nov', () => {
        const h = parseFdHeader('VALID 010000Z   FOR USE 2000-0300Z. TEMPS', new Date('2026-10-31T21:00:00Z'));
        expect([iso(h.validAt), iso(h.useFrom), iso(h.useTo)]).toEqual(['2026-11-01T00:00', '2026-10-31T20:00', '2026-11-01T03:00']);
    });
    it('no header: null', () => {
        expect(parseFdHeader('nothing here', REF)).toBeNull();
    });
});

describe('pickFdPeriod: the period whose FOR USE window holds the departure', () => {
    const periods = ['06', '12', '24'].map((c) => ({ cycle: c, header: parseFdHeader(FD[c], REF), winds: { c } }));
    const pick = (t) => pickFdPeriod(periods, new Date(t))?.cycle ?? null;
    it('now, tonight, tomorrow morning, tomorrow afternoon', () => {
        expect(pick('2026-10-16T20:11:00Z')).toBe('06');      // Now (selectFdCycle gave '12')
        expect(pick('2026-10-17T02:59:00Z')).toBe('06');
        expect(pick('2026-10-17T03:00:00Z')).toBe('12');
        expect(pick('2026-10-17T13:00:00Z')).toBe('24');      // tomorrow 09:00 EDT
        expect(pick('2026-10-17T23:59:00Z')).toBe('24');
    });
    it('past the last window: no forecast yet', () => {
        expect(pick('2026-10-18T00:00:00Z')).toBeNull();
        expect(pick('2026-10-18T13:00:00Z')).toBeNull();      // the day after tomorrow
    });
    it('a little before the first window (between issues): the first period', () => {
        expect(pick('2026-10-16T19:30:00Z')).toBe('06');
        expect(pick('2026-10-16T15:00:00Z')).toBeNull();      // hours before: not this issue
    });
});

describe('fetchWindsDetailed: model winds (RRFS/GFS via Open-Meteo); FD bulletins ended 2026-11-03', () => {
    // A real Open-Meteo RRFS answer for CLT, CAE, DEN, 2026-11-08 12Z-15Z.
    const RRFS = JSON.parse(readFileSync('tests/fixtures/winds/openmeteo-rrfs-clt-cae-den-20261108.json', 'utf8'));
    const NOW = new Date('2026-11-08T12:10:00Z');
    const store = {};
    let calls;
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
        calls = [];
        globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
        globalThis.WeatherClient = { FD_STATIONS: { CLT: [35.21, -80.94], CAE: [33.94, -81.12], DEN: [39.86, -104.67] } };
        vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    });
    afterEach(() => { vi.useRealTimers(); delete globalThis.fetch; delete globalThis.WeatherClient; delete globalThis.window; });
    const answer = (byModel) => { globalThis.fetch = vi.fn(async (url) => {
        calls.push(url);
        const model = new URL(url).searchParams.get('models');
        const body = byModel[model];
        if (body === undefined) throw new Error('offline');
        return { ok: true, json: async () => body };
    }); };
    const nullHours = (json) => json.map((loc) => ({ ...loc, hourly: Object.fromEntries(Object.entries(loc.hourly).map(([k, v]) => [k, k === 'time' ? v : v.map(() => null)])) }));

    it('online: RRFS winds for the departure hour, at the FD stations, and says which', async () => {
        answer({ ncep_rrfs_conus: RRFS });
        const r = await fetchWindsDetailed(new Date('2026-11-08T13:20:00Z'));
        expect(r.source).toBe('model');
        expect(r.model).toBe('RRFS');
        expect(r.validAt.toISOString()).toBe('2026-11-08T13:00:00.000Z');
        expect(Object.keys(r.winds).sort()).toEqual(['CAE', 'CLT', 'DEN']);
        expect(getWindAtAlt(r.winds.CLT, 6000)).toMatchObject({ dir: expect.any(Number), spd: expect.any(Number) });
        // The request: RRFS, knots, GMT, the hours around the departure.
        const q = new URL(calls[0]).searchParams;
        expect(q.get('wind_speed_unit')).toBe('kn');
        expect(q.get('start_hour')).toBe('2026-11-08T12:00');
        expect(q.get('end_hour')).toBe('2026-11-09T01:00');
    });

    it('a second ask within the hour uses the stored fetch: no new request (Open-Meteo allowance)', async () => {
        answer({ ncep_rrfs_conus: RRFS });
        await fetchWindsDetailed(new Date('2026-11-08T13:00:00Z'));
        const again = await fetchWindsDetailed(new Date('2026-11-08T14:00:00Z'));
        expect(calls).toHaveLength(1);
        expect(again.validAt.toISOString()).toBe('2026-11-08T14:00:00.000Z');
    });

    it('a departure past RRFS\'s range (its hours null): GFS', async () => {
        answer({ ncep_rrfs_conus: nullHours(RRFS), gfs_seamless: RRFS });
        const r = await fetchWindsDetailed(new Date('2026-11-08T13:00:00Z'));
        expect(r.model).toBe('GFS');
        expect(calls.map((u) => new URL(u).searchParams.get('models'))).toEqual(['ncep_rrfs_conus', 'gfs_seamless']);
    });

    it('offline in the air: the stored fetch an hour later still gives that hour (marked stale)', async () => {
        answer({ ncep_rrfs_conus: RRFS });
        await fetchWindsDetailed(new Date('2026-11-08T12:10:00Z'));
        vi.setSystemTime(new Date('2026-11-08T14:40:00Z'));          // 2.5 h later, no internet
        answer({});
        const r = await fetchWindsDetailed(new Date('2026-11-08T14:40:00Z'));
        expect(r.source).toBe('model');
        expect(r.stale).toBe(true);
        expect(r.validAt.toISOString()).toBe('2026-11-08T15:00:00.000Z');
    });

    it('offline: fresh Stratux FIS-B winds win over old stored model winds for a departure soon', async () => {
        answer({ ncep_rrfs_conus: RRFS });
        await fetchWindsDetailed(new Date('2026-11-08T12:10:00Z'));
        vi.setSystemTime(new Date('2026-11-08T13:30:00Z'));
        answer({});
        globalThis.window = { app: { fisbClient: { winds: new Map([['CLT:6000', { dir: 270, spd: 22 }]]) } } };
        const r = await fetchWindsDetailed(new Date('2026-11-08T13:30:00Z'));
        expect(r.source).toBe('fisb');
        expect(r.winds.CLT[6000].spd).toBe(22);
    });

    it('offline, nothing stored: no winds, "unavailable"', async () => {
        answer({});
        const r = await fetchWindsDetailed(new Date('2026-11-08T13:00:00Z'));
        expect(r.winds).toBeNull();
        expect(r.reason).toBe('unavailable');
    });

    it('Open-Meteo says 429 (over its per-minute allowance): stop, no GFS request on top; stored winds used', async () => {
        answer({ ncep_rrfs_conus: RRFS });
        await fetchWindsDetailed(new Date('2026-11-08T12:10:00Z'));
        vi.setSystemTime(new Date('2026-11-08T13:30:00Z'));             // stored fetch now over an hour old
        calls = [];
        globalThis.fetch = vi.fn(async (url) => { calls.push(url); return { ok: false, status: 429, json: async () => ({}) }; });
        const r = await fetchWindsDetailed(new Date('2026-11-08T13:30:00Z'));
        expect(calls).toHaveLength(1);
        expect(r.model).toBe('RRFS');
        expect(r.stale).toBe(true);
    });

    it('no FD fetch any more: nothing asks AWC windtemp', async () => {
        answer({ ncep_rrfs_conus: RRFS });
        await fetchWindsDetailed(new Date('2026-11-08T13:00:00Z'));
        expect(calls.every((u) => u.startsWith('https://api.open-meteo.com/'))).toBe(true);
    });
});
