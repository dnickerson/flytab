/**
 * Logbook falls back to the CSV name for dep/dest when the recorder didn't
 * resolve them. A2 made a second same-route flight that day YYYYMMDD_DEP-DEST_2.csv
 * so it can't overwrite the first; the old /(\w+)-(\w+)/ read "KLKR_2" as the
 * destination (\w matches "_" and digits).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

global.DiagLog = { log: vi.fn() };
const src = readFileSync('web/cockpit/logbook.js', 'utf8');
const cls = src.match(/^class (\w+)/m)[1];
const Cls = new Function(src + `\nreturn ${cls};`)();

describe('flight CSV name -> date / dep / dest', () => {
    it.each([
        ['20261013_KCDN-KLKR.csv', { date: '2026-10-13', dep: 'KCDN', dest: 'KLKR' }],
        ['20261013_KCDN-KLKR_2.csv', { date: '2026-10-13', dep: 'KCDN', dest: 'KLKR' }],
        ['20260607_KT73-KLKR.csv', { date: '2026-06-07', dep: 'KT73', dest: 'KLKR' }],
        ['20261013_1550Z.csv', null],                  // not renamed: no route in the name
        ['notes.csv', null],
        ['20261013_KCDN-KLKR', { date: '2026-10-13', dep: 'KCDN', dest: 'KLKR' }],   // no extension, as before
    ])('%s', (name, want) => {
        expect(Cls.parseFlightFilename(name)).toEqual(want);
    });
});
