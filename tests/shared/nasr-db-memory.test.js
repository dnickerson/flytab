/**
 * NasrDB area queries from in-memory copies of the stores (perf, 2026-10-17).
 *
 * Profiled on main (v11.71, PR B harness): every map refresh scanned whole
 * stores through IndexedDB cursors -- airports 1,205 ms for 51 rows (all
 * 19,135, for the weather dots), airspace 633 ms, navaids 240, airways 207 --
 * 21 times a minute; the airport scan alone was the largest JS cost (3.5 s/min).
 * Each store is now read once (getAll) and the queries filter the array with
 * the same tests, limits, order and sort. tests/fixtures/nasr-db-cursor-reference.js
 * is the cursor version as it was on main, kept as the reference.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
globalThis.GeoUtils = new Function(read('web/shared/geo-utils.js') + '\nreturn GeoUtils;')();
const NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const CursorDB = new Function(read('tests/fixtures/nasr-db-cursor-reference.js') + '\nreturn NasrDB;')();

// Seeded data (mulberry32): the same every run.
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(1017);
const lat = () => 30 + R() * 12;            // 30..42 N
const lon = () => -90 + R() * 15;           // -90..-75
const poly = (n, c = [lat(), lon()], r = 0.1 + R() * 1.2) => Array.from({ length: n }, (_, i) => [c[0] + r * Math.sin(i * 2 * Math.PI / n), c[1] + r * Math.cos(i * 2 * Math.PI / n)]);
const id = (p, i) => `${p}${String(i).padStart(5, '0')}`;
const BUNDLE = {
    cycle_info: { effective_date: '2026-10-01' },
    airports: Array.from({ length: 2500 }, (_, i) => ({
        icao: (i % 3 ? 'K' : '') + id('A', i), name: `Field ${i}`, city: `City ${i % 97}`,
        lat: i % 211 === 0 ? null : lat(), lon: lon(), tower: R() < 0.15,
        runways: [{ id: '09/27', length_ft: 3000 + i }],
    })),
    airspace: Array.from({ length: 700 }, (_, i) => (i % 9 === 0
        ? { id: id('AS', i), class: 'D', points: poly(8).map(([a, b]) => ({ lat: a, lon: b })) }   // {lat,lon} points form
        : { id: id('AS', i), class: 'BCDE'[i % 4], boundary: poly(6 + (i % 30)) })),
    sua: Array.from({ length: 250 }, (_, i) => ({ id: id('S', i), type: 'MOA', boundary: i % 50 === 0 ? [] : poly(10) })),
    trsa: Array.from({ length: 20 }, (_, i) => ({ id: id('T', i), boundary: i % 4 === 0 ? [] : poly(36, undefined, 0.5) })),
    navaids: Array.from({ length: 400 }, (_, i) => ({ id: id('N', i), type: 'VOR', lat: lat(), lon: lon() })),
    fixes: Array.from({ length: 4000 }, (_, i) => ({ id: id('F', i), lat: lat(), lon: lon() })),
    airways: Array.from({ length: 150 }, (_, i) => ({
        name: id('V', i), [i % 5 ? 'waypoints' : 'fixes']: Array.from({ length: 6 }, () => ({ lat: lat(), lon: lon() })),
    })),
};
const QUERIES = [
    ['getAirportsInBounds', [500, 50, 3]], ['getAirspaceInBounds', [3000, 10, 1]], ['getSuaInBounds', [3000, 5]],
    ['getTrsaInBounds', [3000, 2]], ['getNavaidsinBounds', [200, 7]], ['getFixesInBounds', [500, 40]],
    ['getAirwaysInBounds', [100, 9]],
];
const boxes = () => {
    const b = [[29, -91, 43, -74], [35, -81, 35.5, -80], [50, 0, 51, 1], [36.2, -86.1, 36.21, -86.09]];
    for (let i = 0; i < 40; i++) { const s = lat(), w = lon(), h = R() * 3, wd = R() * 4; b.push([s, w, s + h, w + wd]); }
    return b;
};

async function fresh() {
    indexedDB = new IDBFactory();
    const db = new NasrDB();
    await db.importNasrBundle(JSON.parse(JSON.stringify(BUNDLE)));
    return db;
}

describe('NasrDB area queries from memory give the cursor version\'s results', () => {
    beforeEach(() => DiagLog.log.mockClear());

    it('every query, every limit, 44 boxes: identical rows in identical order', async () => {
        const db = await fresh();
        const ref = new CursorDB();                       // same IndexedDB (same factory, same DB name)
        let compared = 0;
        for (const box of boxes()) {
            for (const [m, limits] of QUERIES) {
                for (const lim of limits) {
                    const [a, b] = await Promise.all([db[m](...box, lim), ref[m](...box, lim)]);
                    expect(a, `${m}(${box}, ${lim})`).toEqual(b);
                    compared++;
                }
            }
        }
        expect(compared).toBe(44 * QUERIES.reduce((n, [, l]) => n + l.length, 0));   // 704
    }, 120_000);

    it('reads each store once, not once per query', async () => {
        const db = await fresh();
        const spy = vi.spyOn(db, '_getAll');
        for (const box of boxes().slice(0, 10)) for (const [m] of QUERIES) await db[m](...box);
        expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['airports', 'airspace', 'airways', 'fixes', 'navaids', 'sua', 'trsa']);
    });

    it('several first queries at once load a store once', async () => {
        const db = await fresh();
        const spy = vi.spyOn(db, '_getAll');
        await Promise.all(Array.from({ length: 6 }, () => db.getAirportsInBounds(29, -91, 43, -74)));
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a caller changing a returned row does not change later results', async () => {
        const db = await fresh();
        const [first] = await db.getAirportsInBounds(29, -91, 43, -74);
        first.name = 'CHANGED'; first.runways.push({ id: 'X' });
        const [again] = await db.getAirportsInBounds(29, -91, 43, -74);
        expect(again.icao).toBe(first.icao);
        expect(again.name).not.toBe('CHANGED');
        expect(again.runways).toHaveLength(1);
        const [sp] = await db.getAirspaceInBounds(29, -91, 43, -74);
        (sp.boundary || sp.points).length = 0;
        const [sp2] = await db.getAirspaceInBounds(29, -91, 43, -74);
        expect((sp2.boundary || sp2.points).length).toBeGreaterThan(0);
    });
});

describe('the copies follow the database', () => {
    it('a NASR import replaces them (the next query sees the new cycle)', async () => {
        const db = await fresh();
        expect((await db.getNavaidsinBounds(29, -91, 43, -74)).length).toBeGreaterThan(0);
        await db.importNasrBundle({ ...JSON.parse(JSON.stringify(BUNDLE)), navaids: [{ id: 'NEW', type: 'VOR', lat: 35, lon: -80 }] });
        expect((await db.getNavaidsinBounds(29, -91, 43, -74)).map((n) => n.id)).toEqual(['NEW']);
    });

    it('a load still running when an import starts does not keep the old data', async () => {
        const db = await fresh();
        const loading = db.getNavaidsinBounds(29, -91, 43, -74);         // started before the import
        await db.importNasrBundle({ ...JSON.parse(JSON.stringify(BUNDLE)), navaids: [{ id: 'NEW', type: 'VOR', lat: 35, lon: -80 }] });
        await loading;
        expect((await db.getNavaidsinBounds(29, -91, 43, -74)).map((n) => n.id)).toEqual(['NEW']);
    });

    it('a load that finishes after a write is not kept (the generation check)', async () => {
        const db = await fresh();
        let release;
        vi.spyOn(db, '_getAll').mockImplementationOnce(() => new Promise((r) => { release = () => r([{ id: 'OLD', type: 'VOR', lat: 35, lon: -80 }]); }));
        const loading = db.getNavaidsinBounds(29, -91, 43, -74);
        db._memInvalidate(['navaids']);                     // a write while the load runs
        release();
        expect((await loading).map((n) => n.id)).toEqual(['OLD']);          // that caller: its snapshot, as a cursor gave
        expect((await db.getNavaidsinBounds(29, -91, 43, -74)).map((n) => n.id)).not.toContain('OLD');
    });

    it('putAirport writes the record and the next area query has it', async () => {
        const db = await fresh();
        const [apt] = await db.getAirportsInBounds(29, -91, 43, -74);
        await db.putAirport({ ...apt, runways: [{ id: '18/36', length_ft: 4100 }] });
        expect((await db.getAirport(apt.icao)).runways[0].id).toBe('18/36');
        const again = (await db.getAirportsInBounds(29, -91, 43, -74)).find((a) => a.icao === apt.icao);
        expect(again.runways[0].id).toBe('18/36');
    });

    it('a failed load is not kept: the next query tries again', async () => {
        const db = await fresh();
        const real = db._getAll.bind(db);
        let fail = true;
        vi.spyOn(db, '_getAll').mockImplementation((s) => (fail ? Promise.reject(new Error('IDB busy')) : real(s)));
        await expect(db.getFixesInBounds(29, -91, 43, -74)).rejects.toThrow('IDB busy');
        fail = false;
        expect((await db.getFixesInBounds(29, -91, 43, -74)).length).toBeGreaterThan(0);
    });
});

describe('the direct airport writers use putAirport', () => {
    it('airport-popup.js and map.js no longer write the airports store themselves', () => {
        for (const f of ['web/cockpit/airport-popup.js', 'web/cockpit/map.js']) {
            const src = read(f);
            expect(src, f).not.toMatch(/objectStore\('airports'\)\.put/);
            expect(src, f).toMatch(/putAirport\(apt\)/);
        }
    });
});
