import { describe, it, expect } from 'vitest';
import { parseRouteString, UnknownAirwayError, RoutingModeViolationError } from '../../../web/shared/planning/planner/parser.js';
import { makeAeroAdapter } from '../fixtures/mock-adapters.js';

const FIXES = {
    KLKR: { id: 'KLKR', lat: 34.7281, lon: -81.2128 },
    GSO:  { id: 'GSO',  lat: 36.0978, lon: -79.9373 },
    K44N: { id: 'K44N', lat: 38.9001, lon: -77.5234 },
    LRP:  { id: 'LRP',  lat: 40.1213, lon: -76.2945 },
    ABC:  { id: 'ABC',  lat: 35.0,    lon: -80.0 },
    DEF:  { id: 'DEF',  lat: 35.5,    lon: -79.5 },
};

const AIRWAYS = {
    V143: { id: 'V143', type: 'V', fixIds: ['KLKR', 'ABC', 'DEF', 'GSO'] },
    T1:   { id: 'T1',   type: 'T', fixIds: ['GSO',  'LRP',  'K44N'] },
};

const aero = makeAeroAdapter({ fixes: FIXES, airways: AIRWAYS });

describe('parseRouteString', () => {
    it('parses a 2-token direct route (DEP DEST)', async () => {
        const r = await parseRouteString('KLKR K44N', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['KLKR', 'K44N']);
    });

    it('expands an airway token into its interior fixes between entry and exit', async () => {
        const r = await parseRouteString('KLKR V143 GSO', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['KLKR', 'ABC', 'DEF', 'GSO']);
    });

    it('expands multiple airways correctly', async () => {
        const r = await parseRouteString('KLKR V143 GSO T1 K44N', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['KLKR', 'ABC', 'DEF', 'GSO', 'LRP', 'K44N']);
    });

    it('throws UnknownAirwayError for an unknown airway token', async () => {
        await expect(parseRouteString('KLKR V999 GSO', { aero })).rejects.toBeInstanceOf(UnknownAirwayError);
    });

    it('throws RoutingModeViolationError when a T-airway appears under v-airways mode', async () => {
        await expect(
            parseRouteString('KLKR V143 GSO T1 K44N', { aero, routingMode: 'v-airways' })
        ).rejects.toBeInstanceOf(RoutingModeViolationError);
    });

    it('treats a token already inside an airway as the entry point', async () => {
        // ABC is interior to V143; entry "ABC V143 GSO" should expand DEF only
        const r = await parseRouteString('ABC V143 GSO', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['ABC', 'DEF', 'GSO']);
    });

    it('reverses airway direction when entry comes after exit in fixIds', async () => {
        const r = await parseRouteString('GSO V143 KLKR', { aero });
        expect(r.waypoints.map(w => w.id)).toEqual(['GSO', 'DEF', 'ABC', 'KLKR']);
    });
});
