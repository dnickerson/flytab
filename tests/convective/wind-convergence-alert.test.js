/**
 * Review 2026-10-31: once FIS-B winds parsed, the wind-convergence alert (convective-intelligence.js) compared
 * GPS ground speed with the forecast wind speed and the course with the wind-from direction - meaningless. With
 * the real CAR winds and GS 140 it fired on 31 of 36 headings. Ruling: no convergence alert until a real
 * GPS-derived wind estimate (TAS / heading) exists. Real: ConvectiveIntelligenceEngine, FisbClient. Stubbed:
 * the NEXRAD analysis (no clusters), the alert sink, the Stratux situation.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.DiagLog = globalThis.DiagLog || { log: vi.fn() };
const FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();
const ConvectiveIntelligenceEngine = new Function(read('web/shared/convective-intelligence.js') + '\nreturn ConvectiveIntelligenceEngine;')();

// Real decoded WINDS report from Stratux's sample UAT logs, split as Stratux sends it (Type, Location, Time, Data).
const WINDS_CAR = "WINDS CAR 071800Z  FT 3000 6000      9000   12000       18000   24000   30000    34000  39000                         \n   2630 2845+15 2945+10 2842+05 2838-07 2729-17 284032 284243 304756\n";

describe('ConvectiveIntelligenceEngine: no wind-convergence alert from ground speed vs forecast wind', () => {
    it('real CAR winds, GS 140, all 36 headings: no convergence alert', async () => {
        const fisb = new FisbClient(new EventTarget(), { getAirport: async (id) => (id === 'KCAR' ? { lat: 46.87, lon: -68.02 } : null), getNavaid: async () => null });
        const x = WINDS_CAR.split(' ');
        await fisb._handleWeather({ Type: x[0], Location: x[1], Time: x[2], Data: x.slice(3).join(' ') });
        await new Promise((r) => setTimeout(r, 0));
        expect(fisb.getNearestWind(46.5, -68.5, 7500)).toMatchObject({ station: 'CAR', alt: 6000, dir: 280, spd: 45 });

        const stratux = { situation: null };
        const shown = [];
        const engine = new ConvectiveIntelligenceEngine({
            fisbNexrad: { frameHistory: [], getDataAgeMs: () => 0 }, fisbClient: fisb,
            engineClient: null, stratuxClient: stratux, preflightStore: null,
        });
        engine._analyzer = { analyze: () => [] };
        engine.init(null, { showAlerts: (alerts) => shown.push(alerts), setActive() {} });

        for (let trk = 0; trk < 360; trk += 10) {
            stratux.situation = { lat: 46.5, lon: -68.5, ground_speed: 140, true_course: trk, alt_baro: 7500, gps_fix_quality: 1, timestamp: Date.now() };
            engine._runAnalysis();
        }
        expect(shown).toHaveLength(36);
        const convergence = shown.flat().filter((a) => /convergence|Wind deviation/i.test(a?.message || ''));
        expect(convergence).toEqual([]);
    });
});
