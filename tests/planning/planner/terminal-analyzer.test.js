// @ts-check
'use strict';

import { describe, it, expect } from 'vitest';
import { TerminalAnalyzer } from '../../../web/shared/planning/planner/terminal-analyzer.js';
import { makeAeroAdapter } from '../fixtures/mock-adapters.js';

// Real-world airports used in tests
const KLKR = { icao: 'KLKR', lat: 35.18, lon: -81.09 };  // Chester Metro, SC — south of CLT
const KMHT = { icao: 'KMHT', lat: 42.93, lon: -71.44 };  // Manchester, NH — north of all Class B
const KSAV = { icao: 'KSAV', lat: 32.13, lon: -81.20 };  // Savannah, GA — no Class B in KLKR→KSAV
const KCLT = { icao: 'KCLT', lat: 35.21, lon: -80.94 };  // Charlotte Douglas (Class B itself)

// Minimal T200 airway fixture threading through CLT's Class B
const T200 = {
    name: 'T200',
    type: 'T',
    waypoints: [
        { seq: 10, name: 'SHIPP', id: 'SHIPP', lat: 35.05, lon: -81.20 },
        { seq: 20, name: 'CLT',   id: 'CLT',   lat: 35.21, lon: -80.94 },
        { seq: 30, name: 'KILNS', id: 'KILNS', lat: 35.37, lon: -80.68 },
    ],
    segments: [
        { from_seq: 10, to_seq: 20, dist_nm: 16, mea_ft: 3000 },
        { from_seq: 20, to_seq: 30, dist_nm: 16, mea_ft: 3000 },
    ],
};

function makeAero(airports = {}, airways = {}) {
    return makeAeroAdapter({ airports, airways });
}

describe('TerminalAnalyzer.analyzeRoute', () => {
    it('returns hasTerminalAreas:false when route does not cross any Class B', async () => {
        // KLKR → KSAV tracks south-southwest — nowhere near a Class B
        const aero = makeAero({ KLKR, KSAV });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KLKR', 'KSAV');
        expect(result.hasTerminalAreas).toBe(false);
        expect(result.terminalAreas).toHaveLength(0);
    });

    it('detects KCLT on a KLKR→KMHT route', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KLKR', 'KMHT');
        expect(result.hasTerminalAreas).toBe(true);
        const clt = result.terminalAreas.find(ta => ta.icao === 'KCLT');
        expect(clt).toBeDefined();
    });

    it('builds T_ROUTE, AVOIDANCE, and ATC_DIRECT options for KCLT', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        expect(clt.options.some(o => o.type === 'T_ROUTE')).toBe(true);
        expect(clt.options.some(o => o.type === 'AVOIDANCE')).toBe(true);
        expect(clt.options.some(o => o.type === 'ATC_DIRECT')).toBe(true);
    });

    it('T_ROUTE options are sorted by detour; first has recommended:true', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        const tRoutes = clt.options.filter(o => o.type === 'T_ROUTE');
        expect(tRoutes.length).toBeGreaterThan(0);
        expect(tRoutes[0].recommended).toBe(true);
        for (let i = 1; i < tRoutes.length; i++) {
            expect(tRoutes[i].recommended).toBe(false);
            expect(tRoutes[i].detourNm).toBeGreaterThanOrEqual(tRoutes[i - 1].detourNm);
        }
    });

    it('T_ROUTE waypoints array contains all fixes including interior', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        const t200 = clt.options.find(o => o.id === 'T200');
        expect(t200).toBeDefined();
        const ids = t200.waypoints.map(w => w.id);
        expect(ids).toContain('SHIPP');
        expect(ids).toContain('CLT');
        expect(ids).toContain('KILNS');
    });

    it('does not flag KCLT when it is the departure airport', async () => {
        const aero = makeAero({ KCLT, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KCLT', 'KMHT');
        expect(result.terminalAreas.find(ta => ta.icao === 'KCLT')).toBeUndefined();
    });

    it('does not flag KCLT when it is the destination airport', async () => {
        const aero = makeAero({ KLKR, KCLT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const result = await analyzer.analyzeRoute('KLKR', 'KCLT');
        expect(result.terminalAreas.find(ta => ta.icao === 'KCLT')).toBeUndefined();
    });

    it('throws when departure airport is not found in IDB', async () => {
        const aero = makeAero({ KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        await expect(analyzer.analyzeRoute('KLKR', 'KMHT'))
            .rejects.toThrow('KLKR not found');
    });

    it('throws when destination airport is not found in IDB', async () => {
        const aero = makeAero({ KLKR });
        const analyzer = new TerminalAnalyzer(aero);
        await expect(analyzer.analyzeRoute('KLKR', 'KMHT'))
            .rejects.toThrow('KMHT not found');
    });

    it('ATC_DIRECT is always the last option', async () => {
        const aero = makeAero({ KLKR, KMHT }, { T200 });
        const analyzer = new TerminalAnalyzer(aero);
        const { terminalAreas } = await analyzer.analyzeRoute('KLKR', 'KMHT');
        const clt = terminalAreas.find(ta => ta.icao === 'KCLT');
        expect(clt.options[clt.options.length - 1].type).toBe('ATC_DIRECT');
    });
});

describe('TerminalAnalyzer.resolveViaPins', () => {
    it('returns null when all selections are ATC_DIRECT', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', { type: 'ATC_DIRECT', waypoints: [] }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        expect(pins).toBeNull();
    });

    it('returns dep pin first and dest pin last', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', {
                type: 'T_ROUTE',
                waypoints: [{ id: 'SHIPP', lat: 35.05, lon: -81.20 }],
            }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        expect(pins[0].id).toBe('KLKR');
        expect(pins[0].lat).toBeCloseTo(35.18, 2);
        expect(pins[pins.length - 1].id).toBe('KMHT');
    });

    it('includes all T-route waypoints in order between dep and dest', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', {
                type: 'T_ROUTE',
                waypoints: [
                    { id: 'SHIPP', lat: 35.05, lon: -81.20 },
                    { id: 'CLT',   lat: 35.21, lon: -80.94 },
                    { id: 'KILNS', lat: 35.37, lon: -80.68 },
                ],
            }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        const ids = pins.map(p => p.id);
        expect(ids).toEqual(['KLKR', 'SHIPP', 'CLT', 'KILNS', 'KMHT']);
    });

    it('deduplicates adjacent identical pin IDs', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', {
                type: 'AVOIDANCE',
                waypoints: [
                    { id: 'ESN', lat: 38.80, lon: -76.07 },
                    { id: 'ESN', lat: 38.80, lon: -76.07 },
                ],
            }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        const esnPins = pins.filter(p => p.id === 'ESN');
        expect(esnPins).toHaveLength(1);
    });

    it('skips ATC_DIRECT selection but uses T_ROUTE from another terminal area', async () => {
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KCLT', { type: 'T_ROUTE',   waypoints: [{ id: 'SHIPP', lat: 35.05, lon: -81.20 }] }],
            ['KBWI', { type: 'ATC_DIRECT', waypoints: [] }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        expect(pins).not.toBeNull();
        const ids = pins.map(p => p.id);
        expect(ids).toContain('SHIPP');
        expect(ids).not.toContain('KBWI');
    });

    it('sorts via-pins in dep→dest along-track order', async () => {
        // ESN (BWI avoidance, lat≈38.8) should come after SHIPP (CLT T-route, lat≈35.05)
        const aero = makeAero({ KLKR, KMHT });
        const analyzer = new TerminalAnalyzer(aero);
        const selections = new Map([
            ['KBWI', { type: 'AVOIDANCE', waypoints: [{ id: 'ESN',   lat: 38.80, lon: -76.07 }] }],
            ['KCLT', { type: 'T_ROUTE',   waypoints: [{ id: 'SHIPP', lat: 35.05, lon: -81.20 }] }],
        ]);
        const pins = await analyzer.resolveViaPins('KLKR', 'KMHT', selections);
        const ids = pins.map(p => p.id);
        expect(ids.indexOf('SHIPP')).toBeLessThan(ids.indexOf('ESN'));
    });
});
