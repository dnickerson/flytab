/**
 * FAA airport remarks in NasrDB (bundle v12, 2026-11-02).
 *
 * bundle.remarks = { ICAO: [[el, c, text, rwy], ...] } (contract: scratchpad remarks/contract.md).
 * DB_VERSION 11 -> 12 adds the 'airport_remarks' store (keyPath icao, records { icao, r }), not
 * one of the in-memory stores. importNasrBundle writes it in its OWN transaction after the main
 * one has committed: a failure there is logged, never fails or rolls back the import, and the
 * store is cleared so an older cycle's remarks are not shown. A bundle without remarks clears it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
const NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
// The v11 code as it was (the cursor reference copy): builds a real on-disk v11 database.
const V11DB = new Function(read('tests/fixtures/nasr-db-cursor-reference.js') + '\nreturn NasrDB;')();
const REAL = { chunk: NasrDB.REMARKS_CHUNK, timeout: NasrDB.REMARKS_TIMEOUT_MS };

// Real tuples, cycle 2026-10-29 (contract), in bundle order.
const SC76 = [
    ['A110-1', 'gen', 'FOR CD CTC CHARLOTTE APCH AT 704-359-0241.', null],
    ['E111', 'admin', 'PRVDD VFR/PR USE.', null],
];
const KLKR = [
    ['A110-1', 'gen', '25 FT DROP; 250 FT FM THR RWY 06.', null],
    ['A110-2', 'gen', 'DEER ON & INVOF ARPT.', null],
    ['A110-3', 'gen', 'GCO AVBL ON FREQ 121.725 TO CHARLOTTE APCH.', null],
    ['A110-4', 'gen', 'SMALL ACFT MUST BE ON A TIE DOWN.', null],
    ['A110-5', 'gen', 'FOR CD CTC CHARLOTTE APCH AT 704-359-0241.', null],
    ['A110-6', 'gen', 'ARL APPLICATORS NOT PMTD DUE TO PAVEMENT CONDS.', null],
    ['A81-APT', 'ltg', 'ACTVT REIL RWY 06 & 24; MIRL RWY 06/24 - CTAF. PAPI RWY 06 & 24 OPR CONSLY.', null],
    ['A70-FUEL-100LL', 'fuel', 'FOR FUEL AFT HRS CALL 803-285-1513', null],
];
const bundle = (extra = {}) => ({
    cycle_info: { effective_date: '2026-10-29', bundle_version: 12, remarks_count: 2 },
    airports: [
        { icao: 'SC76', name: 'UNITY AERODROME', lat: 34.8, lon: -80.7 },
        { icao: 'KLKR', name: 'LANCASTER CO', lat: 34.72, lon: -80.85 },
        { icao: 'KJFK', name: 'JFK', lat: 40.6, lon: -73.8 },
    ],
    navaids: [{ id: 'SPA', type: 'VOR', lat: 35, lon: -81.9 }],
    fixes: [{ id: 'FIXXX', lat: 35, lon: -80 }],
    sua: [{ id: 'R-6001A', type: 'R', boundary: [] }],
    remarks: { SC76, KLKR },
    ...extra,
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const logged = (re) => DiagLog.log.mock.calls.some(([cat, msg]) => cat === 'nasr' && re.test(msg));

beforeEach(() => {
    indexedDB = new IDBFactory();
    DiagLog.log.mockClear();
});
afterEach(() => {
    NasrDB.REMARKS_CHUNK = REAL.chunk;
    NasrDB.REMARKS_TIMEOUT_MS = REAL.timeout;
    vi.restoreAllMocks();
});

describe('schema: DB_VERSION 12 adds airport_remarks', () => {
    it('is 12, and airport_remarks is not an in-memory store', () => {
        expect(NasrDB.DB_VERSION).toBe(12);
        expect(NasrDB.MEMORY_STORES).not.toContain('airport_remarks');
    });

    it('upgrading a real v11 database keeps every store and its data, and adds the store', async () => {
        const old = new V11DB();
        await old.importNasrBundle(clone({ ...bundle(), remarks: undefined }));
        await old.saveFlightPlan({ id: 'fp1', route: 'KLKR SC76' });
        await old.setMeta('pilot', 'N194JT');
        const v11 = await old.open();
        expect(v11.version).toBe(11);
        const v11Stores = [...v11.objectStoreNames].sort();
        expect(v11Stores).not.toContain('airport_remarks');

        const db = new NasrDB();
        const conn = await db.open();          // versionchange closes the old connection
        expect(conn.version).toBe(12);
        expect([...conn.objectStoreNames].sort()).toEqual([...v11Stores, 'airport_remarks'].sort());
        expect((await db.getAirport('KLKR')).name).toBe('LANCASTER CO');
        expect(await db.getNavaid('SPA')).toMatchObject({ type: 'VOR' });
        expect(await db.getFix('FIXXX')).toMatchObject({ lat: 35 });
        expect((await db.getFlightPlan('fp1')).route).toBe('KLKR SC76');
        expect(await db.getMeta('pilot')).toBe('N194JT');
        expect((await db.getCycleInfo()).effective_date).toBe('2026-10-29');
        expect(await db.getRemarks('KLKR')).toEqual([]);          // store there, empty
    });
});

describe('importNasrBundle writes the remarks', () => {
    it('stores { icao, r } per airport; getRemarks gives the tuples in bundle order', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getRemarks('SC76')).toEqual(SC76);
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);
        expect(await db._get('airport_remarks', 'KLKR')).toEqual({ icao: 'KLKR', r: KLKR });
        expect(logged(/^FAA remarks: 2 airports written in \d+ ms$/)).toBe(true);
    });

    it('in a second transaction, opened only after the main one has committed', async () => {
        const db = new NasrDB();
        const conn = await db.open();
        const events = [];
        const orig = conn.transaction.bind(conn);
        vi.spyOn(conn, 'transaction').mockImplementation((names, mode) => {
            const tx = orig(names, mode);
            const key = [].concat(names).join(',');
            if (mode === 'readwrite') {
                events.push(`open ${key}`);
                tx.addEventListener('complete', () => events.push(`commit ${key}`));
            }
            return tx;
        });
        await db.importNasrBundle(clone(bundle()));
        const main = 'airports,navaids,airways,airspace,sua,trsa,fixes';
        expect(events.indexOf(`open ${main}`)).toBe(0);
        expect(events).toContain('open airport_remarks');
        expect(events.indexOf(`commit ${main}`)).toBeLessThan(events.indexOf('open airport_remarks'));
        expect(events.indexOf('commit airport_remarks')).toBeGreaterThan(events.indexOf('open airport_remarks'));
        // the main transaction never touches the remarks store
        expect(events.filter((e) => e.startsWith('open ') && e.includes('airport_remarks'))).toEqual(['open airport_remarks']);
    });

    it('chunked puts (REMARKS_CHUNK) still write every airport, in one transaction', async () => {
        NasrDB.REMARKS_CHUNK = 3;
        const remarks = {};
        for (let i = 0; i < 10; i++) remarks[`X${i}`] = [['A110-1', 'gen', `REMARK ${i}`, null]];
        const db = new NasrDB();
        const conn = await db.open();
        const spy = vi.spyOn(conn, 'transaction');
        await db.importNasrBundle(clone(bundle({ remarks })));
        expect(spy.mock.calls.filter(([n]) => [].concat(n).includes('airport_remarks'))).toHaveLength(1);
        for (let i = 0; i < 10; i++) expect(await db.getRemarks(`X${i}`)).toEqual([['A110-1', 'gen', `REMARK ${i}`, null]]);
        expect(await db.getRemarks('SC76')).toEqual([]);
    });

    it('a new import replaces the old remarks (clear, then put)', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));
        await db.importNasrBundle(clone(bundle({ remarks: { KLKR: KLKR.slice(0, 1) } })));
        expect(await db.getRemarks('KLKR')).toEqual(KLKR.slice(0, 1));
        expect(await db.getRemarks('SC76')).toEqual([]);
    });

    it('a bundle without remarks clears the store, without an error', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));
        DiagLog.log.mockClear();
        const b = clone(bundle());
        delete b.remarks;
        await expect(db.importNasrBundle(b)).resolves.toBeGreaterThan(0);
        expect(await db.getRemarks('SC76')).toEqual([]);
        expect(await db.getRemarks('KLKR')).toEqual([]);
        expect(logged(/^FAA remarks: none in this bundle — store cleared/)).toBe(true);
        expect((await db.getAirport('KLKR')).name).toBe('LANCASTER CO');
    });

    it('keeps the cycle meta, with remarks_count when the bundle has it', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getCycleInfo()).toEqual({ effective_date: '2026-10-29', bundle_version: 12, remarks_count: 2, sua_count: 1 });
    });

    it('malformed remarks are skipped field by field, never stored as-is', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle({
            remarks: {
                GOOD: [[1, 7, 'TEXT KEPT', 5], ['A1', 'gen', '', null], ['A2', 'gen', '   ', null], 'junk', ['A3', 'rwy', 'RWY TEXT', '06']],
                NOARR: 'x',
                EMPTY: [['A1', 'gen', null, null]],
            },
        })));
        expect(await db.getRemarks('GOOD')).toEqual([['', '', 'TEXT KEPT', null], ['A3', 'rwy', 'RWY TEXT', '06']]);
        expect(await db._get('airport_remarks', 'NOARR')).toBeNull();
        expect(await db._get('airport_remarks', 'EMPTY')).toBeNull();
        for (const bad of [[], 'str', 42, null]) {
            expect(NasrDB._remarkRecords(bad)).toEqual([]);
        }
    });
});

describe('a failed remarks write never fails or rolls back the import', () => {
    async function seeded() {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));         // remarks of the "old cycle" in the store
        DiagLog.log.mockClear();
        return db;
    }
    const newCycle = () => clone(bundle({
        cycle_info: { effective_date: '2026-11-26', bundle_version: 12 },
        airports: [{ icao: 'KLKR', name: 'LANCASTER CO NEW', lat: 34.72, lon: -80.85 }],
    }));
    async function expectImportKept(db, count) {
        expect(count).toBe(4);                                   // 1 airport, 1 navaid, 1 sua, 1 fix
        expect((await db.getAirport('KLKR')).name).toBe('LANCASTER CO NEW');
        expect(await db.getAirport('SC76')).toBeNull();
        expect((await db.getCycleInfo()).effective_date).toBe('2026-11-26');
        expect(await db.getMeta('nasr_last_import')).toBeTruthy();
        await new Promise((r) => setTimeout(r, 20));             // the not-awaited clear
        expect(await db.getRemarks('KLKR')).toEqual([]);         // old cycle's remarks not shown
        expect(await db.getRemarks('SC76')).toEqual([]);
        expect(logged(/^FAA remarks write failed after \d+ ms — .*; NASR import kept, remarks not shown$/)).toBe(true);
    }

    it('the write rejects', async () => {
        const db = await seeded();
        vi.spyOn(db, '_writeRemarks').mockRejectedValue(new Error('QuotaExceededError'));
        await expectImportKept(db, await db.importNasrBundle(newCycle()));
        expect(logged(/QuotaExceededError/)).toBe(true);
    });

    it('the write throws synchronously', async () => {
        const db = await seeded();
        vi.spyOn(db, '_writeRemarks').mockImplementation(() => { throw new Error('NotFoundError: no store'); });
        await expectImportKept(db, await db.importNasrBundle(newCycle()));
    });

    it('a put throws partway (real transaction): it aborts as a whole, nothing half-written', async () => {
        const db = await seeded();
        NasrDB.REMARKS_CHUNK = 1;
        const realPut = IDBObjectStore.prototype.put;
        let puts = 0;
        vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (v) {
            if (this.name === 'airport_remarks' && ++puts === 2) throw new DOMException('clone failed', 'DataCloneError');
            return realPut.call(this, v);
        });
        await expectImportKept(db, await db.importNasrBundle(newCycle()));
        expect(puts).toBe(2);
    });

    it('a write still running at REMARKS_TIMEOUT_MS: the import finishes, the write is left alone (not cleared)', async () => {
        const db = await seeded();
        NasrDB.REMARKS_TIMEOUT_MS = 30;
        vi.spyOn(db, '_writeRemarks').mockReturnValue(new Promise(() => {}));
        const clear = vi.spyOn(db, '_clear');
        const count = await db.importNasrBundle(newCycle());
        expect(count).toBe(4);
        expect((await db.getCycleInfo()).effective_date).toBe('2026-11-26');
        expect(logged(/^FAA remarks write not done after 0.03 s — import goes on, write left running$/)).toBe(true);
        expect(clear).not.toHaveBeenCalledWith('airport_remarks');
    });
});

describe('getRemarks', () => {
    it('upper-cases the ID; [] for an airport without remarks, an empty or odd ID', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getRemarks('sc76')).toEqual(SC76);
        expect(await db.getRemarks(' klkr ')).toEqual(KLKR);
        expect(await db.getRemarks('KJFK')).toEqual([]);
        expect(await db.getRemarks('')).toEqual([]);
        expect(await db.getRemarks(null)).toEqual([]);
        expect(await db.getRemarks(undefined)).toEqual([]);
    });

    it('[] when the store is missing or the read fails (never throws)', async () => {
        const db = new NasrDB();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(db, '_get').mockRejectedValue(new DOMException('One of the specified object stores was not found.', 'NotFoundError'));
        expect(await db.getRemarks('KLKR')).toEqual([]);
        db._get.mockResolvedValue({ icao: 'KLKR', r: 'not an array' });
        expect(await db.getRemarks('KLKR')).toEqual([]);
    });
});

describe('remarks import record (meta nasr_remarks_import) and remarksNeedImport', () => {
    const KEY = '2026-10-29|12';
    it('a good import records ok with the bundle key; then nothing to redo', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toEqual({ key: KEY, ok: true, attempts: 1, written: 2, expected: 2 });
        expect(await db.remarksNeedImport()).toBe(false);
    });

    it('cycle loaded by an older FlyTab (v11 code: remarks_count stored, no remarks, no record): needs an import', async () => {
        const old = new V11DB();
        await old.importNasrBundle(clone(bundle()));
        (await old.open()).close();
        const db = new NasrDB();
        expect((await db.getCycleInfo()).remarks_count).toBe(2);
        expect(await db.getRemarks('KLKR')).toEqual([]);
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toBeNull();
        expect(await db.remarksNeedImport()).toBe(true);
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);
        expect(await db.remarksNeedImport()).toBe(false);
    });

    it('no remarks_count (pre-v12 bundle or 0): never needs one', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle({ cycle_info: { effective_date: '2026-10-29', bundle_version: 11 }, remarks: undefined })));
        expect(await db.remarksNeedImport()).toBe(false);
        expect(await db.remarksNeedImport({ effective_date: 'x', bundle_version: 12, remarks_count: 0 })).toBe(false);
    });

    it('a failing remarks write: counted before the write; retried once (2 attempts per bundle), then no more', async () => {
        const db = new NasrDB();
        vi.spyOn(db, '_writeRemarks').mockRejectedValue(new Error('boom'));
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toMatchObject({ key: KEY, ok: false, attempts: 1 });
        expect(await db.remarksNeedImport()).toBe(true);
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toMatchObject({ key: KEY, ok: false, attempts: 2 });
        expect(await db.remarksNeedImport()).toBe(false);
        // a new bundle starts its own count
        await db.importNasrBundle(clone(bundle({ cycle_info: { effective_date: '2026-11-26', bundle_version: 12, remarks_count: 2 } })));
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toMatchObject({ key: '2026-11-26|12', attempts: 1 });
        expect(await db.remarksNeedImport()).toBe(true);
    });

    it('the attempt is on record before the write starts (a write that kills the app still counts)', async () => {
        const db = new NasrDB();
        let seen = null;
        vi.spyOn(db, '_writeRemarks').mockImplementation(async () => { seen = await db.getMeta(NasrDB.REMARKS_MARKER); return 2; });
        await db.importNasrBundle(clone(bundle()));
        expect(seen).toMatchObject({ key: KEY, ok: false, attempts: 1 });
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toMatchObject({ ok: true, written: 2 });
    });

    it('a write that finishes after the timeout is recorded ok when it does', async () => {
        const db = new NasrDB();
        NasrDB.REMARKS_TIMEOUT_MS = 20;
        let finish;
        vi.spyOn(db, '_writeRemarks').mockReturnValue(new Promise((r) => { finish = r; }));
        await db.importNasrBundle(clone(bundle()));
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toMatchObject({ ok: false, attempts: 1 });
        finish(2);
        await new Promise((r) => setTimeout(r, 30));
        expect(await db.getMeta(NasrDB.REMARKS_MARKER)).toMatchObject({ ok: true, written: 2 });
        expect(logged(/^FAA remarks: 2 airports written late/)).toBe(true);
    });

    it('a write that fails after the timeout: the store is cleared in a new transaction (old cycle remarks not kept)', async () => {
        const db = new NasrDB();
        await db.importNasrBundle(clone(bundle()));               // old remarks in the store
        NasrDB.REMARKS_TIMEOUT_MS = 20;
        let fail;
        vi.spyOn(db, '_writeRemarks').mockReturnValue(new Promise((_, rej) => { fail = rej; }));
        await db.importNasrBundle(clone(bundle({ cycle_info: { effective_date: '2026-11-26', bundle_version: 12, remarks_count: 2 } })));
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);        // write still "running": not cleared yet
        fail(new Error('TransactionInactiveError'));
        await new Promise((r) => setTimeout(r, 30));
        expect(await db.getRemarks('KLKR')).toEqual([]);
        expect(await db.getRemarks('SC76')).toEqual([]);
        expect(logged(/^FAA remarks write failed late — TransactionInactiveError; store cleared$/)).toBe(true);
        expect(await db.remarksNeedImport()).toBe(true);           // attempt 1 of the new bundle failed
    });
});

describe('a database newer than DB_VERSION (an older FlyTab installed over a newer one)', () => {
    it('VersionError: opened as it is (no version), logged, data readable', async () => {
        const db0 = new NasrDB();
        await db0.importNasrBundle(clone(bundle()));
        (await db0.open()).close();
        // a future build bumped it to 13 (added a store)
        await new Promise((res, rej) => {
            const r = indexedDB.open(NasrDB.DB_NAME, NasrDB.DB_VERSION + 1);
            r.onupgradeneeded = () => r.result.createObjectStore('future_store', { keyPath: 'id' });
            r.onsuccess = () => { r.result.close(); res(); };
            r.onerror = () => rej(r.error);
        });
        DiagLog.log.mockClear();
        const db = new NasrDB();
        const conn = await db.open();
        expect(conn.version).toBe(NasrDB.DB_VERSION + 1);
        expect(logged(/is newer than this FlyTab expects \(v12\).*opening it as it is/)).toBe(true);
        expect((await db.getAirport('KLKR')).name).toBe('LANCASTER CO');
        expect(await db.getRemarks('KLKR')).toEqual(KLKR);
        await db.importNasrBundle(clone(bundle()));                // imports still work
        expect(await db.getRemarks('SC76')).toEqual(SC76);
    });

    it('any other open error still rejects (no retry)', async () => {
        const db = new NasrDB();
        const spy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
            const req = {};
            setTimeout(() => req.onerror({ target: { error: new DOMException('disk', 'UnknownError') } }), 0);
            return req;
        });
        await expect(db.open()).rejects.toThrow(/IndexedDB open failed: .*disk/);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
