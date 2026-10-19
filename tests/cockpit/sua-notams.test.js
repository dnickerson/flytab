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
// Every ARTCC has dozens of NOTAMs (fewest on 10-19: ZAU, 21); the fixture
// keeps only the SUA ones, so each ARTCC asked for also gets one route NOTAM.
const filler = (z) => ({ properties: { coreNOTAMData: { notam: { number: `F-${z}`, location: z, classification: 'FDC',
    text: `ROUTE ${z}. V70 MEA 3000.`, effectiveStart: '2026-01-01T00:00:00Z', effectiveEnd: '2027-01-01T00:00:00Z' } } } });
// The proxy: one request, the locations it was asked for.
function proxy() {
    const calls = [];
    globalThis.fetch = vi.fn(async (url) => {
        calls.push(String(url));
        const locs = new URL(String(url)).searchParams.get('location').split(',');
        return { ok: true, json: async () => ({ features: [...locs.map(filler), ...FIX.features.filter((f) => locs.includes(f.properties.coreNOTAMData.notam.location))] }) };
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

describe('review fixes (2026-10-19)', () => {
    it('the proxy skipped an ARTCC (FAA error, still 200): that ARTCC keeps its activations and is not "downloaded"', async () => {
        proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
        const t1 = s.checkedAt(sua('MMOODY2N'));
        // 20 min later the proxy answers 200 with nothing for ZJX
        globalThis.fetch = vi.fn(async (url) => {
            const locs = new URL(String(url)).searchParams.get('location').split(',').filter((z) => z !== 'ZJX');
            return { ok: true, json: async () => ({ features: [...locs.map(filler), ...FIX.features.filter((f) => locs.includes(f.properties.coreNOTAMData.notam.location))] }) };
        });
        at('2026-10-19T19:20:00Z');
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
        expect(s.checkedAt(sua('MMOODY2N'))).toBe(t1);                       // not stamped 19:20
        expect(s._lastError).toMatch(/ZJX/);
        // nothing at all back: a failure
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
        at('2026-10-19T19:40:00Z');
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
        expect(s.checkedAt(sua('MMOODY2N'))).toBe(t1);
    });

    it('NASR not imported yet when the map starts: tries again once it is (no latch)', async () => {
        const calls = proxy(); const s = new SuaNotams();
        const empty = { getSuaInBounds: async () => [], getAirspaceInBounds: async () => [] };
        await s.refresh(empty, [MOODY_VIEW]);
        expect(calls).toHaveLength(0);
        at('2026-10-19T19:00:30Z');
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(calls).toHaveLength(1);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
    });

    it('designators: several areas in one NOTAM, split polygons, HIGH/LOW, sub-areas, odd MOA names', async () => {
        const s = new SuaNotams();
        const rows = [
            { id: 'R4401A', type: 'R', name: 'R-4401A CAMP SHELBY, MS' }, { id: 'R4401B', type: 'R', name: 'R-4401B CAMP SHELBY, MS' },
            { id: 'R4401C', type: 'R', name: 'R-4401C CAMP SHELBY, MS' }, { id: 'R4804A', type: 'R', name: 'R-4804A TWIN PEAKS, NV' },
            { id: 'R4804A_2', type: 'R', name: 'R-4804A TWIN PEAKS, NV' }, { id: 'R3202HIGH', type: 'R', name: 'R-3202 HIGH, SAYLOR CREEK, ID' },
            { id: 'R3202LOW', type: 'R', name: 'R-3202 LOW, SAYLOR CREEK, ID' }, { id: 'W161AN', type: 'W', name: 'W-161A NORTH, SC' },
            { id: 'W161AS', type: 'W', name: 'W-161A SOUTH, SC' }, { id: 'MSNAKEL', type: 'MOA', name: 'SNAKE LOW MOA GULFPORT, MS' },
            { id: 'MPOWDER1CL', type: 'MOA', name: 'POWDER RIVER 1C LOW MOA. MT' }, { id: 'MHUNTERH', type: 'MOA', name: 'HUNTER HIGH MOA, CA' },
            { id: 'MHUNTERLA', type: 'MOA', name: 'HUNTER LOW A MOA, CA' }, { id: 'MMOODY2N', type: 'MOA', name: 'MOODY 2 NORTH MOA, GA' },
            { id: 'NOAKRIDGE', type: 'A', name: 'OAK RIDGE NSA, TN' },
        ];
        await s._buildIndex({ getSuaInBounds: async () => rows });
        const m = (d) => s._match(d).sort();
        expect(m('R4401A/B')).toEqual(['R4401A', 'R4401B']);
        expect(m('R4401A B C')).toEqual(['R4401A', 'R4401B', 'R4401C']);
        expect(m('R4804A')).toEqual(['R4804A', 'R4804A_2']);
        expect(m('R3202 HIGH')).toEqual(['R3202HIGH']);
        expect(m('R3202HIGH')).toEqual(['R3202HIGH']);
        expect(m('R3202')).toEqual(['R3202HIGH', 'R3202LOW']);
        expect(m('W161A')).toEqual(['W161AN', 'W161AS']);
        expect(m('W161AN')).toEqual(['W161AN']);
        expect(m('SNAKE LOW MOA')).toEqual(['MSNAKEL']);
        expect(m('POWDER RIVER 1C LOW MOA')).toEqual(['MPOWDER1CL']);
        expect(m('HUNTER HIGH MOA AND HUNTER LOW A MOA')).toEqual(['MHUNTERH', 'MHUNTERLA']);
        expect(m('LGT OUT/NIGHT VISION GOGGLE TRAINING MOODY 2 NORTH MOA')).toEqual(['MMOODY2N']);
        expect(m('MOODY 2 MOA')).toEqual([]);
        expect(m('AR602')).toEqual([]);
        expect(SuaNotams.matchable(rows.at(-1))).toBe(false);                // an NSA
        expect(s.checkedAt({ ...rows.at(-1), boundary: [[36, -84]] })).toBe(0);
    });

    it('a wrapped NOTAM line still parses; a wrapped TFR is still not SUA', () => {
        const f = (text) => ({ properties: { coreNOTAMData: { notam: { text, effectiveStart: '2026-10-19T12:00:00Z', effectiveEnd: '2026-10-19T23:59:00Z', location: 'ZJX' } } } });
        expect(SuaNotams.parseActivation(f('!SUAE 10/050 ZJX AIRSPACE\nR2904A ACT\nSFC-1700FT'))?.designator).toBe('R2904A');
        expect(SuaNotams.parseActivation(f('FL..MAYPORT, FL..TEMPORARY\nFLIGHT RESTRICTIONS. WI AN AREA ... AIRSPACE R2904A ACT'))).toBe(null);
    });

    it('a PERM activation (no end) survives a restart; the clock set back does not block a refetch', async () => {
        const s = new SuaNotams();
        s._acts.set('R2904A', [{ number: '1', start: 0, end: Infinity, text: 'x', artcc: 'ZJX' }]); s._save();
        const t = new SuaNotams();
        expect(t._acts.get('R2904A')[0].end).toBe(Infinity);
        expect(t.hasActiveNotam({ id: 'R2904A' })).toBe(true);
        const calls = proxy(); const u = new SuaNotams();
        u._fetchedAt.set('ZJX', Date.parse('2026-10-20T19:00:00Z')); u._fetchedAt.set('ZTL', Date.parse('2026-10-20T19:00:00Z'));
        u._fetchedAt.set('ZMA', Date.parse('2026-10-20T19:00:00Z'));          // a day ahead of the clock
        await u.refresh(nasr, [MOODY_VIEW]);
        expect(calls).toHaveLength(1);
    });

    it('overlapping activations: "until" the later end', () => {
        const s = new SuaNotams();
        s._acts.set('X', [{ start: 0, end: Date.parse('2026-10-19T20:00:00Z') }, { start: 0, end: Date.parse('2026-10-20T01:20:00Z') }]);
        expect(s.getNotam({ id: 'X' }).end).toBe(Date.parse('2026-10-20T01:20:00Z'));
    });
});

describe('re-review fixes (2026-10-19)', () => {
    it('the proxy lists the ARTCCs the FAA did not answer: only those keep their old state', async () => {
        proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        const t1 = s.checkedAt(sua('MMOODY2N'));
        globalThis.fetch = vi.fn(async (url) => {
            const locs = new URL(String(url)).searchParams.get('location').split(',');
            // ZJX failed upstream; ZTL came back with nothing (a domestic ARTCC never has none)
            return { ok: true, json: async () => ({ failed: ['ZJX'], features: locs.filter((z) => z !== 'ZJX' && z !== 'ZTL').map(filler) }) };
        });
        at('2026-10-19T19:20:00Z');
        await s.refresh(nasr, [MOODY_VIEW]);
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);                // ZJX kept
        expect(s._fetchedAt.get('ZJX')).toBe(t1);
        expect(s._fetchedAt.get('ZTL')).toBe(t1);                            // not counted as downloaded
        expect(s._fetchedAt.get('ZMA')).toBe(Date.parse('2026-10-19T19:20:00Z'));
    });

    it('an ARTCC that came back empty (older proxy) is asked again after 15 min, not every minute', async () => {
        const calls = proxy(); const s = new SuaNotams();
        globalThis.fetch = vi.fn(async (url) => {
            calls.push(String(url));
            const locs = new URL(String(url)).searchParams.get('location').split(',').filter((z) => z !== 'ZWY');
            return { ok: true, json: async () => ({ features: locs.map(filler) }) };
        });
        const EAST = { south: 33.5, west: -79.5, north: 34.5, east: -78 };   // Myrtle Beach: ZWY's box is in range
        await s.refresh(nasr, [EAST]);
        const asked = (u) => new URL(u).searchParams.get('location').split(',');
        expect(asked(calls[0])).toContain('ZWY');                             // New York Oceanic's box reaches the coast
        for (const t of ['19:01:10', '19:02:20', '19:05:00', '19:10:00']) { at(`2026-10-19T${t}Z`); await s.refresh(nasr, [EAST]); }
        expect(calls.filter((u) => asked(u).includes('ZWY'))).toHaveLength(1);
        at('2026-10-19T19:16:00Z'); await s.refresh(nasr, [EAST]);
        expect(calls.filter((u) => asked(u).includes('ZWY'))).toHaveLength(2);
    });

    it('the clock set back: the 20 s check does not stall', async () => {
        const calls = proxy(); const s = new SuaNotams();
        at('2026-10-20T19:00:00Z'); await s.refresh(nasr, [MOODY_VIEW]);     // a day fast
        at('2026-10-19T19:00:00Z'); await s.refresh(nasr, [MOODY_VIEW]);     // corrected
        expect(calls).toHaveLength(2);
    });

    it('direction words and combined names', async () => {
        const s = new SuaNotams();
        const rows = [['W161AN', 'W', 'W-161A NORTH, SC'], ['W161AS', 'W', 'W-161A SOUTH, SC'], ['R2301E', 'R', 'R-2301E, AZ'], ['R2301W', 'R', 'R-2301W, AZ'],
            ['W497A', 'W', 'W-497A, FL'], ['W497B', 'W', 'W-497B, FL'], ['MBULLDOGA', 'MOA', 'BULLDOG A MOA, GA'], ['MBULLDOGB', 'MOA', 'BULLDOG B MOA, GA'],
            ['MGAMECOCKC', 'MOA', 'GAMECOCK C MOA, SC'], ['MGAMECOCKD', 'MOA', 'GAMECOCK D MOA, SC'], ['MMOODY2N', 'MOA', 'MOODY 2 NORTH MOA, GA'],
            ['MMOODY2S', 'MOA', 'MOODY 2 SOUTH MOA, GA']].map(([id, type, name]) => ({ id, type, name }));
        await s._buildIndex({ getSuaInBounds: async () => rows });
        const m = (d) => s._match(d).sort();
        expect(m('W161A NORTH')).toEqual(['W161AN']);
        expect(m('R2301 WEST')).toEqual(['R2301W']);
        expect(m('W497A AND B')).toEqual(['W497A', 'W497B']);
        expect(m('LGT OUT/NIGHT VISION GOGGLE TRAINING BULLDOG A AND B MOA')).toEqual(['MBULLDOGA', 'MBULLDOGB']);
        expect(m('GAMECOCK C/D MOA')).toEqual(['MGAMECOCKC', 'MGAMECOCKD']);
        expect(m('MOODY 2 NORTH AND SOUTH MOA')).toEqual(['MMOODY2N', 'MMOODY2S']);
        expect(m('BULLDOG C AND D MOA')).toEqual([]);                        // names NASR does not have: nothing invented
    });
});

describe('review 3 fixes (2026-10-19)', () => {
    const NY = { south: 33.5, west: -79.5, north: 34.5, east: -78 };        // Myrtle Beach: ZWY (oceanic) is asked too
    const answer = (fn) => { globalThis.fetch = vi.fn(async (url) => {
        const locs = new URL(String(url)).searchParams.get('location').split(',');
        return { ok: true, json: async () => fn(locs) };
    }); };

    it('no ARTCC answering with nothing counts as downloaded -- oceanic ZWY too (it had 21, ZAK 69, live 10-19)', async () => {
        const asked = [];
        answer((locs) => { asked.push(locs); return { failed: [], features: locs.filter((z) => z !== 'ZWY' && z !== 'ZJX').map(filler) }; });
        const s = new SuaNotams();
        await s.refresh(nasr, [NY]);
        expect(asked[0]).toContain('ZWY');
        expect(s._fetchedAt.has('ZWY')).toBe(false);
        expect(s._fetchedAt.has('ZJX')).toBe(false);
    });

    it('ZAP (not an NMS location: never a NOTAM list back) is not asked for', async () => {
        const s = new SuaNotams();
        await s._loadArtccs(nasr);
        expect(s._artccBoxes.map((a) => a.id)).not.toContain('ZAP');
        expect(s._artccBoxes.map((a) => a.id)).toContain('ZAK');
    });

    it('an FAA error is asked again after a minute; an empty domestic answer after 15', async () => {
        const asked = [];
        answer((locs) => { asked.push(locs); return { failed: ['ZJX'], features: locs.filter((z) => z !== 'ZJX' && z !== 'ZTL').map(filler) }; });
        const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        at('2026-10-19T19:01:30Z'); await s.refresh(nasr, [MOODY_VIEW]);
        expect(asked.at(-1)).toEqual(['ZJX']);                               // ZTL waits
        at('2026-10-19T19:16:00Z'); await s.refresh(nasr, [MOODY_VIEW]);
        expect(asked.at(-1)).toContain('ZTL');
    });

    it('NASR wiped mid-session: a fetch does not clear what is kept', async () => {
        proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        const wiped = { getSuaInBounds: async () => [], getAirspaceInBounds: nasr.getAirspaceInBounds };
        at('2026-10-19T19:20:00Z');
        const calls = globalThis.fetch.mock.calls.length;
        await s.refresh(wiped, [MOODY_VIEW]);
        expect(globalThis.fetch.mock.calls.length).toBe(calls);               // the FAA is not asked
        expect(s.hasActiveNotam(sua('MMOODY2N'))).toBe(true);
    });

    it('ranges and AND lists', async () => {
        const s = new SuaNotams();
        const rows = ['R4401A', 'R4401B', 'R4401C', 'R4401D', 'R4401E', 'W161AN', 'W161AS', 'R3202HIGH', 'R3202LOW']
            .map((id) => ({ id, type: id[0], name: id })).concat([{ id: 'MRESERVE', type: 'MOA', name: 'RESERVE MOA, NM' }, { id: 'MDOME', type: 'MOA', name: 'DOME MOA, AZ' }]);
        await s._buildIndex({ getSuaInBounds: async () => rows });
        const m = (d) => s._match(d).sort();
        expect(m('R4401A-E')).toEqual(['R4401A', 'R4401B', 'R4401C', 'R4401D', 'R4401E']);
        expect(m('R4401A THRU C')).toEqual(['R4401A', 'R4401B', 'R4401C']);
        expect(m('R4401A THRU R4401E')).toEqual(['R4401A', 'R4401B', 'R4401C', 'R4401D', 'R4401E']);
        expect(m('R4401A-R4401C')).toEqual(['R4401A', 'R4401B', 'R4401C']);
        expect(m('W161A NORTH AND SOUTH')).toEqual(['W161AN', 'W161AS']);
        expect(m('R3202 HIGH AND LOW')).toEqual(['R3202HIGH', 'R3202LOW']);
        expect(m('RESERVE AND DOME MOA')).toEqual(['MDOME', 'MRESERVE']);
        expect(m('R4401A')).toEqual(['R4401A']);
    });
});

describe('review 5 fixes (2026-10-19)', () => {
    const CONUS = { south: 25, west: -124, north: 49, east: -67 };
    const asked = (calls) => calls.map((u) => new URL(u).searchParams.get('location').split(','));

    it('many ARTCCs: at most 6 per request, the view\'s first', async () => {
        const calls = proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW, CONUS]);
        const reqs = asked(calls);
        expect(reqs.length).toBeGreaterThan(2);
        expect(reqs.every((r) => r.length <= SuaNotams.PER_REQUEST)).toBe(true);
        const all = reqs.flat();
        expect(new Set(all).size).toBe(all.length);                          // each once
        expect(reqs[0]).toEqual(expect.arrayContaining(['ZJX', 'ZMA', 'ZTL']));   // the view's
        expect(all).not.toContain('ZAP');
    });

    it('a request that fails (offline) stops the rest; they are asked on the next try', async () => {
        const calls = []; globalThis.fetch = vi.fn(async (u) => { calls.push(String(u)); throw new TypeError('Failed to fetch'); });
        const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW, CONUS]);
        expect(calls).toHaveLength(1);
    });

    it('a second pan within 20 s fetches the new region at once', async () => {
        const calls = proxy(); const s = new SuaNotams();
        await s.refresh(nasr, [MOODY_VIEW]);
        at('2026-10-19T19:00:05Z');
        await s.refresh(nasr, [{ south: 42.5, west: -121.5, north: 43.5, east: -119.5 }]);   // Oregon
        expect(asked(calls).at(-1)).toContain('ZSE');
    });
});
