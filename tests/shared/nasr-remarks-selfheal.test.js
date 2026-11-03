/**
 * FAA remarks self-heal (review I1, 2026-11-02).
 *
 * An older FlyTab (v12.56, DB v11) that imports a v12 bundle stores its cycle meta (bundle_version
 * 12, remarks_count) but no remarks. After v12.57+ is installed, app.js _ensureNasrData saw that
 * cycle as current and never imported again: remarks silently missing. Same after a failed remarks
 * write. Now NasrDB records each remarks import (meta nasr_remarks_import, which old code never
 * writes) and startup imports again while the loaded cycle has remarks but no good record - at most
 * NasrDB.REMARKS_MAX_ATTEMPTS times per bundle, so a persistent failure can't loop.
 *
 * Runs the real _ensureNasrData (cut out of web/app.js) against the real NasrDB on fake-indexeddb,
 * with the v11 code (tests/fixtures/nasr-db-cursor-reference.js) as the older FlyTab.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const DiagLog = { log: vi.fn() };
global.DiagLog = DiagLog;
const NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const V11DB = new Function(read('tests/fixtures/nasr-db-cursor-reference.js') + '\nreturn NasrDB;')();

const appSrc = read('web/app.js');
const start = appSrc.indexOf('    async _ensureNasrData(nasrDb) {');
const end = appSrc.indexOf('\n    // === Route Bbox', start);
const ensureNasrData = new Function('DiagLog', 'CockpitConfig',
    `return ({\n${appSrc.slice(start, end)}\n})._ensureNasrData;`)(DiagLog, { homeBases: [] });

const KLKR = [['A110-2', 'gen', 'DEER ON & INVOF ARPT.', null], ['A70-100LL', 'fuel', 'FOR FUEL AFT HRS CALL 803-285-1513', null]];
const CYCLE = { effective_date: '2026-10-29', expiration_date: '2026-11-26', bundle_version: 12, remarks_count: 1 };
const BUNDLE = {
    cycle_info: CYCLE,
    airports: [{ icao: 'KLKR', name: 'LANCASTER CO', lat: 34.72, lon: -80.85 }, { icao: 'KJFK', name: 'JFK', lat: 40.6, lon: -73.8 }],
    sua: [{ id: 'R-1', type: 'R', boundary: [] }],
    remarks: { KLKR },
};
const FILE_CYCLE = { ...CYCLE, sua_count: 1 };     // nasr/cycle_info.json on the tablet

let bundleFetches;
beforeEach(() => {
    indexedDB = new IDBFactory();
    DiagLog.log.mockClear();
    bundleFetches = 0;
    globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        if (u === 'http://localhost:9090/nasr/cycle_info.json') return { ok: true, json: async () => JSON.parse(JSON.stringify(FILE_CYCLE)) };
        if (u === 'http://localhost:9090/nasr/bundle.json') { bundleFetches++; return { ok: true, json: async () => JSON.parse(JSON.stringify(BUNDLE)) }; }
        return { ok: false, status: 404 };
    });
});
afterEach(() => { vi.restoreAllMocks(); delete globalThis.fetch; });

const app = () => ({ vectorLayers: null, _updateNasrBadge() {} });
/** One app start: a fresh NasrDB (as FlyTabApp makes) and the startup NASR check. */
async function appStart() {
    const db = new NasrDB();
    await ensureNasrData.call(app(), db);
    return db;
}
async function oldAppImports() {
    const old = new V11DB();
    await old.importNasrBundle(JSON.parse(JSON.stringify(BUNDLE)));
    (await old.open()).close();
}

describe('older FlyTab imported the v12 bundle first', () => {
    it('the next start of the new app imports again: remarks present; later starts do not import', async () => {
        await oldAppImports();
        let db = await appStart();
        expect(bundleFetches).toBe(1);
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);
        expect(DiagLog.log).toHaveBeenCalledWith('nasr', 'NASR current but its FAA remarks are not loaded — importing again');
        (await db.open()).close();
        db = await appStart();
        db = await appStart();
        expect(bundleFetches).toBe(1);
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);
    });

    it('a remarks write that always fails: imported at most twice for this bundle, never again (no loop)', async () => {
        await oldAppImports();
        vi.spyOn(NasrDB.prototype, '_writeRemarks').mockRejectedValue(new Error('QuotaExceededError'));
        for (let i = 0; i < 5; i++) (await (await appStart()).open()).close();
        expect(bundleFetches).toBe(NasrDB.REMARKS_MAX_ATTEMPTS);
        expect(NasrDB.REMARKS_MAX_ATTEMPTS).toBe(2);
        const db = new NasrDB();
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toMatchObject({ key: '2026-10-29|12', ok: false, attempts: 2 });
        expect((await db.getAirport('KLKR')).name).toBe('LANCASTER CO');   // NASR itself fine throughout
    });

    it('fails once, then works: the second start heals it', async () => {
        await oldAppImports();
        const spy = vi.spyOn(NasrDB.prototype, '_writeRemarks').mockRejectedValueOnce(new Error('transient'));
        await appStart();
        spy.mockRestore();
        const db = await appStart();
        expect(bundleFetches).toBe(2);
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);
        await appStart();
        expect(bundleFetches).toBe(2);
    });
});

describe('normal path (new app imports the bundle itself)', () => {
    it('first start imports once (stale), later starts do nothing', async () => {
        const db = await appStart();
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);
        (await db.open()).close();
        await appStart();
        expect(bundleFetches).toBe(1);
    });

    it('a bundle without remarks (remarks_count absent) never triggers the remarks re-import', async () => {
        const noRmk = { ...BUNDLE, cycle_info: { effective_date: '2026-10-29', bundle_version: 11 } };
        delete noRmk.remarks;
        FILE_CYCLE.bundle_version = 11; delete FILE_CYCLE.remarks_count;
        BUNDLE_SWAP.set(noRmk);
        try {
            await appStart(); await appStart(); await appStart();
            expect(bundleFetches).toBe(1);
        } finally { BUNDLE_SWAP.reset(); }
    });
});

// lets one test serve a different bundle / cycle file
const ORIG = { bundle: JSON.parse(JSON.stringify(BUNDLE)), file: { ...FILE_CYCLE } };
const BUNDLE_SWAP = {
    set(b) { for (const k of Object.keys(BUNDLE)) delete BUNDLE[k]; Object.assign(BUNDLE, b); },
    reset() {
        for (const k of Object.keys(BUNDLE)) delete BUNDLE[k]; Object.assign(BUNDLE, JSON.parse(JSON.stringify(ORIG.bundle)));
        for (const k of Object.keys(FILE_CYCLE)) delete FILE_CYCLE[k]; Object.assign(FILE_CYCLE, ORIG.file);
    },
};
