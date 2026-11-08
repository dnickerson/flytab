/**
 * Model winds aloft (2026-11-08): Open-Meteo pressure-level winds -> the FD
 * station shape { STATION: { altFt: { dir, spd, temp } } } on 3,000-14,000 ft.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { profileToAlts, parseResponse, buildUrl, windsAt, omTimeMs, MODELS, ALTS_FT } from '../../../web/shared/planning/planner/model-winds.js';

const M = 1 / 3.28084;                    // feet -> metres
const lvl = (ft, dir, spd, temp) => ({ hgtM: ft * M, dir, spd, temp });

describe('profileToAlts: pressure levels -> 1,000 ft steps', () => {
    it('interpolates u/v by height: half way between 270/10 and 090/10 is calm, not 180/10', () => {
        const out = profileToAlts([lvl(2000, 270, 10, 10), lvl(4000, 90, 10, 6)], 0);
        expect(out[3000].spd).toBe(0);
        expect(out[3000].temp).toBe(8);
    });

    it('same direction: speed and temperature linear in height', () => {
        const out = profileToAlts([lvl(2000, 270, 10, 10), lvl(6000, 270, 30, 2)], 0);
        expect(out[3000]).toEqual({ dir: 270, spd: 15, temp: 8 });
        expect(out[5000]).toEqual({ dir: 270, spd: 25, temp: 4 });
    });

    it('veering: 240/20 to 300/20 gives about 270 in the middle', () => {
        const out = profileToAlts([lvl(2000, 240, 20), lvl(4000, 300, 20)], 0);
        expect(out[3000].dir).toBe(270);
        expect(out[3000].spd).toBe(17);   // shorter vector: 20*cos(30deg) = 17.3
    });

    it('across north: 350/20 to 010/20 is 360 in the middle (averaging the numbers gives 180, the opposite wind)', () => {
        const out = profileToAlts([lvl(2000, 350, 20), lvl(4000, 10, 20)], 0);
        expect(out[3000].dir).toBe(360);
        expect(out[3000].spd).toBe(20);
    });

    it('wind from the north is 360, not 0 (0 is only calm)', () => {
        const out = profileToAlts([lvl(2000, 360, 12), lvl(4000, 360, 12)], 0);
        expect(out[3000]).toMatchObject({ dir: 360, spd: 12 });
    });

    it('nothing within 1,500 ft of the ground, and no extrapolation above or below the levels', () => {
        const out = profileToAlts([lvl(2000, 270, 10), lvl(9500, 270, 10)], 2000 * M);   // ground 2,000 ft
        expect(out[3000]).toBeUndefined();                  // 1,000 ft AGL
        expect(out[4000]).toBeDefined();                    // 2,000 ft AGL
        expect(out[10000]).toBeUndefined();                 // above the top level
    });

    it('levels below the ground are dropped (Open-Meteo fills them; DEN 950/850 hPa)', () => {
        // Ground 5,358 ft. The 1,800 ft level is under ground with a made-up 090/99:
        // 7,000 ft (1,642 ft AGL) lies between it and the first real level (8,000 ft),
        // so it must be left out, not blended with the made-up wind.
        const out = profileToAlts([lvl(1800, 90, 99), lvl(8000, 270, 10), lvl(10400, 270, 20)], 1633);
        expect(out[7000]).toBeUndefined();
        expect(out[9000]).toMatchObject({ dir: 270 });
        expect(out[9000].spd).toBeGreaterThanOrEqual(10);
        expect(out[9000].spd).toBeLessThanOrEqual(20);
        expect(out[6000]).toBeUndefined();                  // under 1,500 ft AGL
    });

    it('fewer than two usable levels: nothing', () => {
        expect(profileToAlts([lvl(3000, 270, 10)], 0)).toEqual({});
        expect(profileToAlts([lvl(3000, 270, null), lvl(6000, null, 10)], 0)).toEqual({});
    });
});

describe('parseResponse: a real RRFS answer (CLT, CAE, DEN; 2026-11-08 12Z-15Z)', () => {
    const json = JSON.parse(readFileSync('tests/fixtures/winds/openmeteo-rrfs-clt-cae-den-20261108.json', 'utf8'));
    const ids = ['CLT', 'CAE', 'DEN'];
    const p = parseResponse(json, ids);
    // What the app reads: windsAt expands the stored hour into { STATION: { altFt: {...} } }.
    const at12 = windsAt({ ...p, ids, model: 'RRFS', fetchedAt: 0 }, Date.UTC(2026, 10, 8, 12)).winds;

    it('four hours, three stations', () => {
        expect(p.hours.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(['12:00', '13:00', '14:00', '15:00']);
        expect(p.data[0]).toHaveLength(3);
    });

    it('CLT 12Z 6,000 ft: between the 850 hPa (296/19.6 at 1,512 m) and 800 hPa winds, from the WNW', () => {
        const w = at12.CLT[6000];
        expect(w.dir).toBeGreaterThanOrEqual(270);
        expect(w.dir).toBeLessThanOrEqual(320);
        expect(w.spd).toBeGreaterThan(5);
        expect(w.spd).toBeLessThan(40);
    });

    it('DEN (ground 1,633 m = 5,358 ft): nothing below 7,000 ft', () => {
        expect(Object.keys(at12.DEN).map(Number).sort((a, b) => a - b)[0]).toBe(7000);
    });

    it('CAE (ground 67 m): 3,000 ft is there', () => {
        expect(at12.CAE[3000]).toBeDefined();
    });

    it('a bare object for one location is read too; a count that does not match is refused', () => {
        expect(parseResponse(json[0], ['CLT']).data[0][0]).toEqual(p.data[0][0]);
        expect(parseResponse(json, ['CLT'])).toBeNull();
    });
});

describe('buildUrl / windsAt / omTimeMs', () => {
    const stations = { CLT: [35.21, -80.94], SJU: [18.44, -66.0] };

    it('RRFS leaves out San Juan (outside its grid); GFS keeps it', () => {
        expect(buildUrl(stations, MODELS[0], Date.UTC(2026, 10, 8, 12)).ids).toEqual(['CLT']);
        expect(buildUrl(stations, MODELS[1], Date.UTC(2026, 10, 8, 12)).ids).toEqual(['CLT', 'SJU']);
    });

    it('asks only for 950-600 hPa (cost scales with variables): 36 variables', () => {
        const q = new URL(buildUrl(stations, MODELS[0], Date.UTC(2026, 10, 8, 12)).url).searchParams;
        expect(q.get('hourly').split(',')).toHaveLength(36);
    });

    it('Open-Meteo times carry no zone: read as UTC', () => {
        expect(omTimeMs('2026-11-08T12:00')).toBe(Date.UTC(2026, 10, 8, 12));
    });

    it('windsAt: the nearest hour within 30 min; none further out', () => {
        const row = ALTS_FT.map((a) => (a === 6000 ? [270, 10, -2] : null));
        const f = { hours: [Date.UTC(2026, 10, 8, 12)], data: [[row]], ids: ['CLT'], model: 'RRFS', fetchedAt: 0 };
        expect(windsAt(f, Date.UTC(2026, 10, 8, 12, 29)).winds.CLT).toEqual({ 6000: { dir: 270, spd: 10, temp: -2 } });
        expect(windsAt(f, Date.UTC(2026, 10, 8, 12, 31))).toBeNull();
    });

    it('altitudes are 3,000-14,000 ft every 1,000 ft', () => {
        expect(ALTS_FT[0]).toBe(3000);
        expect(ALTS_FT.at(-1)).toBe(14000);
        expect(ALTS_FT).toHaveLength(12);
    });
});
