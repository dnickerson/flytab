/**
 * Restricted/MOA activation by NOTAM (Dana, 2026-10-19: "The only thing I
 * don't know works is if a MOA is activated by a NOTAM"). It never was: the
 * fetch went to flywhere.app/api/notams (503, no credentials), the R-pattern
 * wanted "R-2904A" (the FAA writes R2904A) and names were compared with the
 * state left on. The fixture is real FAA data from 2026-10-19 (NMS NOTAMs via
 * the NOTAM proxy, NASR SUA areas and ARTCC boundaries) -- public, no flight
 * data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.GeoUtils = new Function(read('web/shared/geo-utils.js') + '\nreturn GeoUtils;')();
const FIX = JSON.parse(read('tests/fixtures/sua-notams/sua-notams-2026-10-19.json'));
const load = () => new Function(read('web/cockpit/sua-notams.js') + '\nreturn SuaNotams;')();
const SuaNotams = load();

/** A NasrDB over the fixture, with the real bounds tests. */
const nasr = {
    getSuaInBounds: async (s, w, n, e) => FIX.sua.filter((r) => GeoUtils.polygonOverlapsBox(r.boundary, s, w, n, e)).map((r) => ({ ...r })),
    getAirspaceInBounds: async (s, w, n, e) => FIX.artcc.filter((r) => GeoUtils.polygonOverlapsBox(r.boundary, s, w, n, e) || (s <= -89 && n >= 89)).map((r) => ({ ...r })),
};
const sua = (id) => FIX.sua.find((r) => r.id === id);
// The proxy: one request, the locations it was asked for.
function proxy() {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        calls.push(String(url));
        const locs = new URL(String(url)).searchParams.get('location').split(',');
        return { ok: true, json: async () => ({ features: FIX.features.filter((f) => locs.includes(f.properties.coreNOTAMData.notam.location)) }) };
    });
    return calls;
}
const MOODY_VIEW = { south: 30.6, west: -83.6, north: 31.4, east: -82.6 };   // Valdosta, GA
const at = (iso) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-19T19:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    localStorage.clear();
    globalThis.CockpitConfig = { notamBase: 'https://fitpc.example.ts.net' };
    globalThis.Settings = { workerBase: 'https://www.flywhere.app/api' };
});
afterEach(() => { vi.useRealTimers(); delete globalThis.fetch; delete globalThis.CockpitConfig; delete globalThis.Settings; });

describe('reading the FAA\'s !SUA NOTAMs', () => {
    it('MOODY 2 NORTH MOA (ZJX 10/004, 18:10Z-01:20Z) is active at 19:00Z', async () => {
        const calls = proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatch(/^https:\/\/fitpc\.example\.ts\.net\/notams\?location=/);   // the NOTAM proxy, not flywhere
        expect(new URL(calls[0]).searchParams.get('location').split(',')).toContain('ZJX');
        const n = s.getNotam(sua('MMOODY2N'));
        expect(n?.number).toBe('10/004');
        expect(n.text).toMatch(/MOODY 2 NORTH MOA ACT 500FT-7999FT/);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
        expect(s.hasActiveNotam(sua('MMOODY3'))).toBe(false);                // no NOTAM for MOODY 3
    });

    it('restricted and warning areas match by NASR id: R2904A, W470F (no hyphen in the NOTAM)', async () => {
        proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [{ south: 29.5, west: -86.5, north: 30.2, east: -81.8 }]);
        expect(s.hasActiveNotam(sua('R2904A'))).toBe(true);
        expect(s.hasActiveNotam(sua('W470F'))).toBe(true);
    });

    it('a MOA in another ARTCC (JUNIPER C, ZLC, Oregon)', async () => {
        proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [{ south: 42.5, west: -121.5, north: 43.5, east: -119.5 }]);
        const j = FIX.features.find((f) => /JUNIPER C MOA/.test(f.properties.coreNOTAMData.notam.text)).properties.coreNOTAMData.notam;
        at(new Date(Date.parse(j.effectiveStart) + 60000).toISOString());
        expect(s.hasActiveNotam(sua('MJUNIPERC'))).toBe(true);
    });

    it('active only between the NOTAM\'s start and end; the next one is "upcoming"', async () => {
        proxy(); const s = new SuaNotams();
        at('2026-10-19T17:00:00Z');
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(false);               // starts 18:10Z
        expect(s.getUpcoming(sua('MMOODY2N'))?.start).toBe(Date.parse('2026-10-19T18:10:00Z'));
        at('2026-10-19T18:10:00Z');
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
        at('2026-10-20T01:20:00Z');
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(false);               // ended at 01:20Z
        expect(s.getUpcoming(sua('MMOODY2N'))?.number).toBe('10/059');        // 20 Oct 19:00Z
    });

    it('not SUA: refueling tracks, TFRs, the high-speed area -- no match, no error', () => {
        const odd = FIX.features.filter((f) => /AR602|HIGH SPEED|TEMPORARY FLIGHT/.test(f.properties.coreNOTAMData.notam.text));
        expect(odd.length).toBeGreaterThanOrEqual(2);
        for (const f of odd) {
            const a = SuaNotams.parseActivation(f);
            expect(a == null || /^AR|HIGH SPEED/.test(a.designator)).toBe(true);
        }
    });

    it('a cancellation is not an activation; the DOM and INTL copies count once', async () => {
        expect(SuaNotams.parseActivation({ properties: { coreNOTAMData: { notam: { type: 'C', text: '!SUAE 10/099 ZJX AIRSPACE R2904A ACT SFC-1700FT', effectiveStart: '2026-10-19T12:00:00Z' } } } })).toBe(null);
        proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [{ south: 29.5, west: -86.5, north: 30.2, east: -85.5 }]);
        expect(s._acts.get('W470F').filter((a) => a.start <= Date.now() && Date.now() < a.end)).toHaveLength(1);   // 10/053 and A2951/26
    });
});

describe('downloaded on the ground, used in flight', () => {
    it('kept: a new start (FlyTab restarted, no internet) still knows; it turns on at its time', async () => {
        proxy(); at('2026-10-19T17:00:00Z');
        await new SuaNotams().refresh(nasr, [MOODY_VIEW]);
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });   // in the air
        const s = new SuaNotams();
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(false);
        at('2026-10-19T18:30:00Z');
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
        await s.refresh(nasr, [MOODY_VIEW]);                                  // fails quietly, keeps it
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
    });

    it('when it was checked: 0 before any download, the download time after; 0 where never downloaded', async () => {
        proxy(); const s = new SuaNotams();
        expect(s.checkedAt(sua('MMOODY2N'))).toBe(0);
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(s.checkedAt(sua('MMOODY2N'))).toBe(Date.parse('2026-10-19T19:00:00Z'));
        expect(s.checkedAt(sua('MJUNIPERC'))).toBe(0);                        // Oregon: never fetched
    });

    it('a NOTAM cancelled since: the next download drops it', async () => {
        const calls = proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
        const keep = FIX.features.splice(0);
        try {
            at('2026-10-19T19:20:00Z');                                       // past the 15 min staleness
            await s.refresh(nasr, [MOODY_VIEW]);
            expect(calls).toHaveLength(2);
            expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(false);
        } finally { FIX.features.push(...keep); }
    });

    it('not refetched within 15 min, nor checked more than every 20 s; a failure waits a minute', async () => {
        const calls = proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        at('2026-10-19T19:00:10Z'); await s.refresh(nasr, [MOODY_VIEW]);
        at('2026-10-19T19:10:00Z'); await s.refresh(nasr, [MOODY_VIEW]);
        expect(calls).toHaveLength(1);
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        at('2026-10-19T19:16:00Z'); await s.refresh(nasr, [MOODY_VIEW]);
        at('2026-10-19T19:16:30Z'); await s.refresh(nasr, [MOODY_VIEW]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('tells the map when it changed, and again at the next start/end', async () => {
        proxy(); at('2026-10-19T17:00:00Z');
        const seen = vi.fn(); document.addEventListener('sua-notams:changed', seen);
        const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(seen).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(70 * 60000 + 2000);                            // 18:10Z
        expect(seen.mock.calls.length).toBeGreaterThanOrEqual(2);
        document.removeEventListener('sua-notams:changed', seen);
    });
});

describe('ARTCCs from boxes', () => {
    it('NASR ARTCC boundaries are rings run together: a box, western hemisphere only', async () => {
        const s = new SuaNotams();
        await s._loadArtccs(nasr);
        const zoa = s._artccBoxes.find((a) => a.id === 'ZOA');
        expect(zoa.east).toBeLessThan(0);                                     // not 165 (past the date line)
        expect(s._artccsFor({ south: 31, west: -82.8, north: 31.1, east: -82.7 })).toContain('ZJX');
        expect(s._artccsFor({ south: 31, west: -82.8, north: 31.1, east: -82.7 })).not.toContain('ZSE');
    });
});
