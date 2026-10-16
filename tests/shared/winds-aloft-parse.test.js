// FD winds aloft: each group belongs to the altitude column it sits under.
// Stations high enough leave out the low columns; parsing by position put
// TRI's 6000 ft wind at 3000 ft, ALS's 12000 ft wind at 3000 ft (review,
// 2026-10-16). Real product: 16 Oct 2026, 18Z data.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const WeatherClient = new Function(readFileSync('web/shared/weather-client.js', 'utf8') + '\nreturn WeatherClient;')();
const text = readFileSync('tests/fixtures/winds/fd-06-161800Z.txt', 'utf8');
const all = WeatherClient.parseAllWindsAloft(text);
const w = (st, alt) => { const x = all[st]?.[alt]; return x ? [x.dir, x.spd, x.temp] : null; };

describe('parseAllWindsAloft: by column, not by position', () => {
    it('a station with every column (CAE): unchanged', () => {
        // CAE 2423 2819+13 2725+12 2430+07 2339-06 2347-18 244733 245243 235451
        expect(w('CAE', 3000)).toEqual([240, 23, null]);
        expect(w('CAE', 6000)).toEqual([280, 19, 13]);
        expect(w('CAE', 24000)).toEqual([230, 47, -18]);
    });

    it('TRI (Tri-Cities) has no 3000 ft column: its first group is 6000 ft', () => {
        // TRI      2725+10 2524+05 2437+00 2362-08 2367-19 246433 255943 236251
        expect(w('TRI', 3000)).toBeNull();
        expect(w('TRI', 6000)).toEqual([270, 25, 10]);
        expect(w('TRI', 9000)).toEqual([250, 24, 5]);
        expect(w('TRI', 12000)).toEqual([240, 37, 0]);
    });

    it('ALS (high field) starts at 12000 ft', () => {
        // ALS                      0906+02 0313-10 0212-23 050839 060648 030855
        expect(w('ALS', 3000)).toBeNull();
        expect(w('ALS', 9000)).toBeNull();
        expect(w('ALS', 12000)).toEqual([90, 6, 2]);
        expect(w('ALS', 24000)).toEqual([20, 12, -23]);
    });

    it('a group with no temperature is left-aligned in its column (AMA 6000, MBW 9000)', () => {
        // AMA      0122    0434+05 ...   MBW              2712    3015+03 ...
        expect(w('AMA', 6000)).toEqual([10, 22, null]);
        expect(w('AMA', 9000)).toEqual([40, 34, 5]);
        expect(w('MBW', 9000)).toEqual([270, 12, null]);
        expect(w('MBW', 12000)).toEqual([300, 15, 3]);
        expect(w('BIH', 6000)).toMatchObject([0, 0, null]);          // 9900: light and variable
    });

    it('every group in the three real products is placed', () => {
        for (const c of ['06', '12', '24']) {
            const t = readFileSync(`tests/fixtures/winds/fd-${c}-161800Z.txt`, 'utf8');
            const a = WeatherClient.parseAllWindsAloft(t);
            const rows = t.split(/\r?\n/).filter((l) => /^[A-Z]{2,3} /.test(l) && !/^FT /.test(l));
            const groups = rows.reduce((n, l) => n + l.trim().split(/\s+/).length - 1, 0);
            const placed = rows.reduce((n, l) => n + Object.keys(a[l.slice(0, 3).trim()] || {}).length, 0);
            expect([c, placed]).toEqual([c, groups]);
        }
    });

    it('temperatures above 24000 ft are negative (TEMPS NEG ABV 24000)', () => {
        expect(w('CAE', 30000)).toEqual([240, 47, -33]);
        expect(w('CAE', 39000)).toEqual([230, 54, -51]);
    });

    it('speeds of 100 kt and more (direction + 50) still decode', () => {
        // ACK ... 249332 248540 248351  -> 30000: 240° 93 kt; 34000: 240° 85; 39000: 240° 83
        expect(w('ACK', 30000)).toEqual([240, 93, -32]);
    });
});
