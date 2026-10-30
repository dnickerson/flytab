/**
 * #190 fix round 1: the field elevation reaches the planner. Neither planner's
 * waypoints carried one, so after an approach RW24 -> KLKR planned DES 528 -> 0
 * in the app. _pillsToWaypoints (RoutePlannerPanel; RoutePlannerV2 reuses it via
 * super) now stamps elev_ft from NASR on airport pills -- dep, dest, airport,
 * fuel -- also when the coordinates come from the _coords cache (lat/lon only).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { RoutePlanner } from '../../web/shared/planning/planner/route-planner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
globalThis.wireTap = vi.fn();
globalThis.DiagLog = vi.fn();
const RoutePlannerPanel = new Function(
    readFileSync(join(__dirname, '../../web/cockpit/route-planner-panel.js'), 'utf8') + '\nreturn RoutePlannerPanel;')();

// NASR airport records carry an integer elev_ft (bundle: KLKR 486, KCLT 748).
const AIRPORTS = {
    KCLT: { icao: 'KCLT', lat: 35.213187, lon: -80.951379, elev_ft: 748 },
    KLKR: { icao: 'KLKR', lat: 34.722904, lon: -80.85459,  elev_ft: 486 },
};

function makePanel(route, coords) {
    const panel = new RoutePlannerPanel(document.createElement('div'), null, null);
    panel._route = route;
    panel._coords = coords;
    panel._toast = vi.fn();
    panel._nasrDb = {
        getAirport: vi.fn(async (id) => AIRPORTS[String(id).toUpperCase()] ?? null),
        getNavaid:  vi.fn(async () => null),
        getFix:     vi.fn(async () => null),
    };
    return panel;
}

// KCLT -> KLKR RNAV 24 via SAPSE, as insertApproach leaves the pills: the
// approach fixes and every airport's coordinates are in the _coords cache.
const APPROACH_ROUTE = () => [
    { id: 'KCLT', type: 'dep' },
    { id: 'SAPSE', type: 'fix', proc: 'APPROACH', altFt: 2500 },
    { id: 'WITUR', type: 'fix', proc: 'APPROACH', altFt: 2100 },
    { id: 'RW24',  type: 'fix', proc: 'APPROACH', altFt: 528 },
    { id: 'KLKR',  type: 'dest' },
];
const APPROACH_COORDS = () => ({
    KCLT:  { lat: 35.2140, lon: -80.9431 },
    SAPSE: { lat: 34.822697, lon: -80.656681 },
    WITUR: { lat: 34.769633, lon: -80.762056 },
    RW24:  { lat: 34.72721166, lon: -80.84607163 },
    KLKR:  { lat: 34.7229, lon: -80.8546 },
});

describe('_pillsToWaypoints: field elevation on airport pills', () => {
    it('dep and dest get elev_ft from NASR although their coordinates are cached; fixes do not', async () => {
        const panel = makePanel(APPROACH_ROUTE(), APPROACH_COORDS());
        const wps = await panel._pillsToWaypoints();
        const by = Object.fromEntries(wps.map(w => [w.id, w]));
        expect(by.KLKR.elev_ft).toBe(486);
        expect(by.KCLT.elev_ft).toBe(748);
        for (const id of ['SAPSE', 'WITUR', 'RW24']) expect(by[id]).not.toHaveProperty('elev_ft');
        // coordinates still the cached ones (the threshold-era airport point is not replaced)
        expect(by.KLKR.lat).toBe(34.7229);
        const asked = panel._nasrDb.getAirport.mock.calls.map(c => c[0]);
        expect(asked).not.toContain('SAPSE');
    });

    it('a bare id on an airport pill resolves through the K-prefixed record', async () => {
        const panel = makePanel([{ id: 'KCLT', type: 'dep' }, { id: 'LKR', type: 'dest' }],
            { KCLT: { lat: 35.2140, lon: -80.9431 }, LKR: { lat: 34.7229, lon: -80.8546 } });
        const wps = await panel._pillsToWaypoints();
        expect(wps[1].elev_ft).toBe(486);
    });

    it('fuel-stop and airport pills get it too; no NASR record or no elevation: none', async () => {
        const panel = makePanel([
            { id: 'KCLT', type: 'dep' }, { id: 'KLKR', type: 'fuel' }, { id: 'KXXX', type: 'airport' }, { id: 'KCLT', type: 'dest' },
        ], { KCLT: { lat: 35.2, lon: -80.9 }, KLKR: { lat: 34.7, lon: -80.8 }, KXXX: { lat: 34.0, lon: -81.0 } });
        const wps = await panel._pillsToWaypoints();
        expect(wps[1].elev_ft).toBe(486);
        expect(wps[1].fuelStop).toBe(true);
        expect(wps[2]).not.toHaveProperty('elev_ft');
    });
});

describe('KLKR RNAV 24 through the panel path ends at the field', () => {
    it('RW24 -> KLKR plans DES 528 -> 486 (was 528 -> 0)', async () => {
        const panel = makePanel(APPROACH_ROUTE(), APPROACH_COORDS());
        const wps = await panel._pillsToWaypoints();
        const planner = new RoutePlanner({ aero: {}, plans: {}, profiles: {}, weather: {}, network: {}, clock: {} });
        // the call _doApply / RoutePlannerV2._compute make
        const plan = planner.recomputeLegs({ waypoints: wps, destination: 'KLKR' }, null,
            { departureTime: new Date('2026-10-30T15:00:00Z') });
        const last = plan.legs.find(l => l.from === 'RW24' && l.to === 'KLKR');
        expect(last.segments.map(s => `${s.phase} ${s.altFrom}->${s.altTo}`)).toEqual(['DES 528->486']);
    });
});

describe('the elevation lookup cannot hang Plan / Apply', () => {
    afterEach(() => vi.useRealTimers());

    // CLAUDE.md: IDB can get into a state where requests never resolve. With the
    // coordinates cached, _pillsToWaypoints worked before the elevation lookup was
    // added; it must still return, with no elev_ft (descent to 0, as before).
    it('getAirport never resolves: returns after ELEV_LOOKUP_MS with cached coordinates, no elev_ft', async () => {
        vi.useFakeTimers();
        const panel = makePanel(APPROACH_ROUTE(), APPROACH_COORDS());
        panel._nasrDb.getAirport = vi.fn(() => new Promise(() => {}));   // hung IDB
        let wps = null;
        panel._pillsToWaypoints().then((w) => { wps = w; });
        await vi.advanceTimersByTimeAsync(900);
        expect(wps).toBeNull();                      // still waiting on the first airport
        await vi.advanceTimersByTimeAsync(1300);     // 2 airport pills x 1000 ms, < 2.2 s in all
        expect(wps).not.toBeNull();
        expect(wps.map(w => w.id)).toEqual(['KCLT', 'SAPSE', 'WITUR', 'RW24', 'KLKR']);
        expect(wps[4].lat).toBe(34.7229);
        for (const w of wps) expect(w).not.toHaveProperty('elev_ft');
        expect(RoutePlannerPanel.ELEV_LOOKUP_MS).toBe(1000);
    });

    it('a lookup that answers in time still gives the elevation', async () => {
        vi.useFakeTimers();
        const panel = makePanel(APPROACH_ROUTE(), APPROACH_COORDS());
        panel._nasrDb.getAirport = vi.fn((id) => new Promise((r) => setTimeout(() => r(AIRPORTS[id] ?? null), 500)));
        let wps = null;
        panel._pillsToWaypoints().then((w) => { wps = w; });
        await vi.advanceTimersByTimeAsync(1200);
        expect(wps[4].elev_ft).toBe(486);
    });
});
