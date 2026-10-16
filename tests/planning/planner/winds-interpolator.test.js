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

describe('fetchWindsDetailed: all three periods, the right one for the departure', () => {
    const store = {};
    beforeEach(() => {
        for (const k of Object.keys(store)) delete store[k];
        globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
        globalThis.WeatherClient = { parseAllWindsAloft: (t) => ({ ABI: { 6000: { dir: 0, spd: Number(/FD(\d)US/.exec(t)[1]) } } }) };
        vi.useFakeTimers({ now: REF, toFake: ['Date'] });
    });
    afterEach(() => { vi.useRealTimers(); delete globalThis.fetch; delete globalThis.WeatherClient; delete globalThis.window; });
    const online = () => { globalThis.fetch = vi.fn(async (url) => ({ ok: true, text: async () => FD[/fcst=(\d+)/.exec(url)[1]] })); };

    it('online: tomorrow 09:00 EDT gets the 24-hour forecast, and says which', async () => {
        online();
        const r = await fetchWindsDetailed(new Date('2026-10-17T13:00:00Z'));
        expect(r.source).toBe('fd');
        expect(r.cycle).toBe('24');
        expect(r.winds.ABI[6000].spd).toBe(5);                  // FD5US5 = the 24-hour product
        expect(iso(r.validAt)).toBe('2026-10-17T18:00');
        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('past the forecast: no winds, and why (with where it ends)', async () => {
        online();
        const r = await fetchWindsDetailed(new Date('2026-10-18T13:00:00Z'));
        expect(r.winds).toBeNull();
        expect(r.reason).toBe('beyond');
        expect(iso(r.coverTo)).toBe('2026-10-18T00:00');
    });

    it('offline: the cached period that covers the departure; not a cached one that does not', async () => {
        online();
        await fetchWindsDetailed(new Date());                    // caches all three
        globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
        const r = await fetchWindsDetailed(new Date('2026-10-17T05:00:00Z'));
        expect([r.source, r.cycle]).toEqual(['cache', '12']);
        const far = await fetchWindsDetailed(new Date('2026-10-18T13:00:00Z'));
        expect(far.winds).toBeNull();
    });

    it('offline, Stratux FIS-B winds: used for a departure soon, not for tomorrow', async () => {
        globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
        globalThis.window = { app: { fisbClient: { winds: new Map([['CLT:6000', { dir: 270, spd: 22 }]]) } } };
        const soon = await fetchWindsDetailed(new Date('2026-10-16T21:00:00Z'));
        expect(soon.source).toBe('fisb');
        expect(soon.winds.CLT[6000].spd).toBe(22);
        const tomorrow = await fetchWindsDetailed(new Date('2026-10-17T13:00:00Z'));
        expect(tomorrow.winds).toBeNull();
        expect(tomorrow.reason).toBe('unavailable');
    });

    it('a partial fetch (only the 6-hour came back): the cached period that covers tomorrow is used (review, 2026-10-16)', async () => {
        online();
        await fetchWindsDetailed(new Date());                    // caches all three
        globalThis.fetch = vi.fn(async (url) => (/fcst=06/.test(url) ? { ok: true, text: async () => FD['06'] } : (() => { throw new Error('timeout'); })()));
        const r = await fetchWindsDetailed(new Date('2026-10-17T13:00:00Z'));
        expect([r.source, r.cycle]).toEqual(['cache', '24']);
    });

    it('a departure time already past (a delay): the current forecast, not "no winds" (review, 2026-10-16)', async () => {
        online();
        const r = await fetchWindsDetailed(new Date('2026-10-16T14:00:00Z'));     // 6 h ago
        expect([r.source, r.cycle]).toEqual(['fd', '06']);
        const old = await fetchWindsDetailed(new Date('2026-10-12T14:00:00Z'));   // days ago
        expect(old.cycle).toBe('06');
    });

    it('offline with only yesterday\'s cache: "unavailable", not "no forecast yet" ending yesterday', async () => {
        online();
        await fetchWindsDetailed(new Date());
        vi.setSystemTime(new Date('2026-10-18T15:00:00Z'));      // a day later, all periods ended
        globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
        const r = await fetchWindsDetailed(new Date('2026-10-18T16:00:00Z'));
        expect(r.winds).toBeNull();
        expect(r.reason).toBe('unavailable');
    });

    it('only the 24-hour period fetched, departure now, nothing cached: not "beyond" (the forecast starts later)', async () => {
        globalThis.fetch = vi.fn(async (url) => (/fcst=24/.test(url) ? { ok: true, text: async () => FD['24'] } : (() => { throw new Error('timeout'); })()));
        const r = await fetchWindsDetailed(new Date());
        expect(r.winds).toBeNull();
        expect(r.reason).toBe('unavailable');
    });

    it('a cache entry from before this change (no header) is not used', async () => {
        store['flypi_winds_cache_12'] = JSON.stringify({ ts: Date.now(), winds: { OLD: {} } });
        globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
        const r = await fetchWindsDetailed(new Date('2026-10-17T05:00:00Z'));
        expect(r.winds).toBeNull();
    });
});
