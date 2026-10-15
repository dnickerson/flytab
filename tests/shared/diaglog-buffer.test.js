/**
 * PR B / B5: DiagLog buffers in memory and saves at most every FLUSH_MS.
 *
 * Every DiagLog.log() used to read the whole log from localStorage, parse it,
 * append, stringify and write it back -- dozens of times a second while the
 * Stratux link retries (at home), and the 200-entry cap meant the 10-13
 * dropouts pushed the earlier flight's entries out. Now: in memory, saved every
 * few seconds (errors at once, so a crash right after one still has it), cap
 * raised. Same storage key (flypi_diag_log).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const src = readFileSync('web/app.js', 'utf8');
const start = src.indexOf('const DiagLog = (() => {');
const end = src.indexOf('})();', start) + '})();'.length;
const makeDiagLog = () => new Function(src.slice(start, end) + '\nreturn DiagLog;')();
const KEY = 'flypi_diag_log';
const stored = () => JSON.parse(localStorage.getItem(KEY) || '[]');

describe('DiagLog buffering (B5)', () => {
    beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
    afterEach(() => vi.useRealTimers());

    it('100 entries in a burst: at most one save during the burst, all saved after FLUSH_MS', () => {
        const D = makeDiagLog();
        const setItem = vi.spyOn(Storage.prototype, 'setItem');
        for (let i = 0; i < 100; i++) D.log('stratux', `msg ${i}`);
        expect(setItem.mock.calls.filter(([k]) => k === KEY).length).toBeLessThanOrEqual(1);
        expect(D.entries).toHaveLength(100);                 // readable at once
        vi.advanceTimersByTime(D.FLUSH_MS);
        expect(stored()).toHaveLength(100);
        setItem.mockRestore();
    });

    it('an error is saved at once', () => {
        const D = makeDiagLog();
        D.log('stratux', 'routine');
        D.log('error', 'something broke');
        expect(stored().map((e) => e.msg)).toEqual(['routine', 'something broke']);
    });

    it('keeps the newest MAX entries (raised from 200)', () => {
        const D = makeDiagLog();
        expect(D.MAX).toBeGreaterThanOrEqual(1000);
        for (let i = 0; i < D.MAX + 25; i++) D.log('x', `m${i}`);
        vi.advanceTimersByTime(D.FLUSH_MS);
        const s = stored();
        expect(s).toHaveLength(D.MAX);
        expect(s[0].msg).toBe('m25');
    });

    it('carries on from what an earlier run saved', () => {
        localStorage.setItem(KEY, JSON.stringify([{ t: '2026-10-14T16:00:00Z', cat: 'init', msg: 'old run' }]));
        const D = makeDiagLog();
        D.log('init', 'new run');
        vi.advanceTimersByTime(D.FLUSH_MS);
        expect(stored().map((e) => e.msg)).toEqual(['old run', 'new run']);
    });

    it('clear() empties memory and storage, and stays clear', () => {
        const D = makeDiagLog();
        D.log('x', 'a');
        D.clear();
        vi.advanceTimersByTime(D.FLUSH_MS);
        expect(D.entries).toEqual([]);
        expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('entry shape unchanged (t, cat, msg, optional d)', () => {
        const D = makeDiagLog();
        D.log('gps', 'fix', { q: 2 });
        D.log('gps', 'no data');
        expect(D.entries[0]).toEqual({ t: expect.any(String), cat: 'gps', msg: 'fix', d: { q: 2 } });
        expect('d' in D.entries[1]).toBe(false);
    });
});
