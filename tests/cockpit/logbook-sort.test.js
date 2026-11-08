/**
 * The logbook list is newest first. It sorted on the date alone, so a day with
 * several entries came out in IndexedDB order: on 10/27/2026 the KORL>KTBR and
 * KTBR>KLKR legs sat between the KTBR run-ups. Within a day it now goes by the
 * out time, newest first: recorded entries store "18:09Z", ForeFlight imports
 * "21:26", and entries with no out time go last in their day.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

global.DiagLog = { log: vi.fn() };
const src = readFileSync('web/cockpit/logbook.js', 'utf8');
const cls = src.match(/^class (\w+)/m)[1];
const Cls = new Function(src + `\nreturn ${cls};`)();

const e = (id, date, time_out, created_at) => ({ id, date, time_out, created_at });
const sorted = (list) => [...list].sort(Cls.compareNewestFirst).map((x) => x.id);

describe('logbook order: newest date, then newest out time', () => {
    it('puts 10/27 in time order (stored order was 18:09, 12:21, 20:46, 15:24, 15:00)', () => {
        const day = [
            e('runup-1809', '2026-10-27', '18:09Z'),
            e('KORL-KTBR', '2026-10-27', '12:21Z'),
            e('KTBR-KLKR', '2026-10-27', '20:46Z'),
            e('runup-1524', '2026-10-27', '15:24Z'),
            e('runup-1500', '2026-10-27', '15:00Z'),
        ];
        expect(sorted(day)).toEqual(['KTBR-KLKR', 'runup-1809', 'runup-1524', 'runup-1500', 'KORL-KTBR']);
    });

    it('still puts the date first: an early flight today is above a late one yesterday', () => {
        expect(sorted([e('yday', '2026-11-06', '23:50Z'), e('today', '2026-11-07', '00:10Z')])).toEqual(['today', 'yday']);
    });

    it('reads ForeFlight times without the Z, and a one-digit hour', () => {
        expect(sorted([e('a', '2026-01-30', '9:41'), e('b', '2026-01-30', '21:26'), e('c', '2026-01-30', '19:41')]))
            .toEqual(['b', 'c', 'a']);
    });

    it('puts entries with no out time last in their day, newest created first', () => {
        const list = [
            e('none-old', '2026-02-01', '', '2026-02-01T10:00:00Z'),
            e('timed', '2026-02-01', '08:00'),
            e('none-new', '2026-02-01', null, '2026-02-01T12:00:00Z'),
            e('undef', '2026-02-01', undefined),
        ];
        expect(sorted(list)).toEqual(['timed', 'none-new', 'none-old', 'undef']);
    });

    it('falls back to created_at when an entry has no date, as before', () => {
        expect(sorted([e('dated', '2026-03-01', '10:00'), e('nodate', undefined, undefined, '2026-03-05T09:00:00Z')]))
            .toEqual(['nodate', 'dated']);
    });

    it('reads a typed out time without the colon ("1809", "1809Z", "809")', () => {
        expect(sorted([e('noon', '2026-02-02', '12:00'), e('typed', '2026-02-02', '1809'), e('typedZ', '2026-02-02', '1700Z'), e('early', '2026-02-02', '809')]))
            .toEqual(['typed', 'typedZ', 'noon', 'early']);
    });

    it('an entry with no date sorts by the day and time of created_at, not above the whole day', () => {
        expect(sorted([e('nodate-0900', undefined, undefined, '2026-03-05T09:00:00Z'), e('dated-2000', '2026-03-05', '20:00Z')]))
            .toEqual(['dated-2000', 'nodate-0900']);
    });

    it('keeps the stored order for entries that tie completely (stable sort)', () => {
        expect(sorted([e('x', '2026-02-26', ''), e('y', '2026-02-26', ''), e('z', '2026-02-26', '')])).toEqual(['x', 'y', 'z']);
    });
});

describe('getEntries uses that order', () => {
    it('sorts what it reads, before applying the limit', async () => {
        const rows = [e('runup', '2026-10-27', '18:09Z'), e('early', '2026-10-27', '12:21Z'), e('late', '2026-10-27', '20:46Z')];
        const fakeDb = {
            transaction: () => ({ objectStore: () => ({ getAll: () => {
                const req = {};
                queueMicrotask(() => { req.result = rows; req.onsuccess(); });
                return req;
            } }) }),
            close: () => {},
        };
        const lb = Object.create(Cls.prototype);
        lb._openIdb = async () => fakeDb;
        expect((await lb.getEntries()).map((x) => x.id)).toEqual(['late', 'runup', 'early']);
        expect((await lb.getEntries({ limit: 1 })).map((x) => x.id)).toEqual(['late']);
    });
});
