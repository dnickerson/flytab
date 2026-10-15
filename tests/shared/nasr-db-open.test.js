/**
 * NasrDB.open() can't hang startup (A4, flight-safety plan).
 *
 * indexedDB.open() can stay pending forever: an upgrade blocked by a connection
 * that won't close fires 'blocked' and then nothing, and CLAUDE.md documents a
 * stuck IDB state where open() never answers until the app is force-stopped.
 * open() had no onblocked and no timeout, and app.js awaits NASR during init.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
const NasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const REAL_TIMEOUT = NasrDB.OPEN_TIMEOUT_MS;

/** Open 'flypi' at an older version and keep the connection, ignoring versionchange. */
function holdOldConnection() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(NasrDB.DB_NAME, NasrDB.DB_VERSION - 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

describe('NasrDB.open() never hangs (A4)', () => {
    beforeEach(() => {
        indexedDB = new IDBFactory();
        NasrDB.OPEN_TIMEOUT_MS = 200;
        DiagLog.log.mockClear();
    });
    afterEach(() => { NasrDB.OPEN_TIMEOUT_MS = REAL_TIMEOUT; vi.restoreAllMocks(); });

    it('has a startup-sized timeout by default', () => {
        expect(REAL_TIMEOUT).toBeGreaterThanOrEqual(5000);
        expect(REAL_TIMEOUT).toBeLessThanOrEqual(15000);
    });

    it('an upgrade blocked by a connection that never closes: logs it, rejects after the timeout', async () => {
        const old = await holdOldConnection();
        const db = new NasrDB();
        const t0 = Date.now();
        await expect(db.open()).rejects.toThrow(/timed out/i);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
        expect(DiagLog.log).toHaveBeenCalledWith('nasr', expect.stringMatching(/blocked/i));
        old.close();
    });

    it('once the blocker closes, the late open is kept: the next call works without a new request', async () => {
        const old = await holdOldConnection();
        const db = new NasrDB();
        await expect(db.open()).rejects.toThrow(/timed out/i);
        const spy = vi.spyOn(indexedDB, 'open');
        old.close();                                   // the pending upgrade can now finish
        await new Promise((r) => setTimeout(r, 100));
        const conn = await db.open();
        expect(conn.version).toBe(NasrDB.DB_VERSION);
        expect(spy).not.toHaveBeenCalled();
        expect(await db.getAirport('KJFK')).toBeNull();
    });

    it('an open request that never answers rejects after the timeout; a later call tries again', async () => {
        const db = new NasrDB();
        const realOpen = indexedDB.open.bind(indexedDB);
        const spy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => ({}));   // never fires any event
        await expect(db.open()).rejects.toThrow(/timed out/i);
        spy.mockImplementation(realOpen);
        const conn = await db.open();
        expect(conn.version).toBe(NasrDB.DB_VERSION);
        expect(spy).toHaveBeenCalledTimes(2);
    });

    it('callers at the same moment share one open request and one connection', async () => {
        const db = new NasrDB();
        const spy = vi.spyOn(indexedDB, 'open');
        const [a, b, c] = await Promise.all([db.open(), db.open(), db.open()]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it('a stuck open makes the data calls fail (not hang), so callers fall through', async () => {
        const db = new NasrDB();
        vi.spyOn(indexedDB, 'open').mockImplementation(() => ({}));
        await expect(db.getCycleInfo()).rejects.toThrow(/timed out/i);
        await expect(db.getAirport('KJFK')).rejects.toThrow(/timed out/i);
    });
});

describe('NasrDB.open() when indexedDB.open throws', () => {
    beforeEach(() => { indexedDB = new IDBFactory(); });
    afterEach(() => vi.restoreAllMocks());

    it('rejects at once, and the next call tries again', async () => {
        const db = new NasrDB();
        const realOpen = indexedDB.open.bind(indexedDB);
        const spy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw new DOMException('denied', 'SecurityError'); });
        await expect(db.open()).rejects.toThrow(/denied/);
        spy.mockImplementation(realOpen);
        expect((await db.open()).version).toBe(NasrDB.DB_VERSION);
    });
});
