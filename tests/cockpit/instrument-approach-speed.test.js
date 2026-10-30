/**
 * Instrument approach speed (Dana, 2026-10-30): "Approaches are timed and flown
 * at 90 KIAS or 120 KIAS. This should be a configurable setting."
 *
 * aircraft performance `instrument_approach_ias_kt` (default 90) -- not the
 * existing approach_speed_kt, which is the landing/final speed and is synced
 * from the flywhere profile. Configuration -> Aircraft edits it; the planner
 * panel passes it as fuelPhases.approach.ias_kt.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { RoutePlanner } from '../../web/shared/planning/planner/route-planner.js';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = vi.fn();
globalThis.DiagLog = vi.fn();
const RoutePlannerPanel = new Function(read('web/cockpit/route-planner-panel.js') + '\nreturn RoutePlannerPanel;')();
const ConfigEditor = new Function(read('web/cockpit/config-editor.js') + '\nreturn ConfigEditor;')();
const CockpitConfigClass = new Function(read('web/shared/cockpit-config.js') + '\nreturn CockpitConfig;')();
const AIRCRAFT = JSON.parse(read('web/aircraft-config.json'));

afterEach(() => { delete globalThis.CockpitConfig; });

function useAircraft(perfOverride = {}) {
    const ac = JSON.parse(JSON.stringify(AIRCRAFT));
    Object.assign(ac.performance, perfOverride);
    globalThis.CockpitConfig = { aircraftRaw: ac, aircraft: () => null, get: () => null };
}

const KLKR_RNAV24 = () => ({
    route: [
        { id: 'KCLT', type: 'dep' },
        { id: 'SAPSE', type: 'fix', proc: 'APPROACH', altFt: 2500 },
        { id: 'WITUR', type: 'fix', proc: 'APPROACH', altFt: 2100 },
        { id: 'RW24',  type: 'fix', proc: 'APPROACH', altFt: 528 },
        { id: 'KLKR',  type: 'dest' },
    ],
    coords: {
        KCLT: { lat: 35.2140, lon: -80.9431 }, SAPSE: { lat: 34.822697, lon: -80.656681 },
        WITUR: { lat: 34.769633, lon: -80.762056 }, RW24: { lat: 34.72721166, lon: -80.84607163 },
        KLKR: { lat: 34.7229, lon: -80.8546 },
    },
});

async function planViaPanel() {
    const { route, coords } = KLKR_RNAV24();
    const panel = new RoutePlannerPanel(document.createElement('div'), null, null);
    panel._route = route; panel._coords = coords; panel._toast = vi.fn();
    const wps = await panel._pillsToWaypoints();
    const planner = new RoutePlanner({ aero: {}, plans: {}, profiles: {}, weather: {}, network: {}, clock: {} });
    // the call _doApply makes
    return planner.recomputeLegs({ waypoints: wps, destination: 'KLKR' }, panel._profileForPower(65),
        { departureTime: new Date('2026-10-30T15:00:00Z'), pctPower: 65 });
}

describe('instrument_approach_ias_kt setting', () => {
    it('aircraft-config.json and the built-in defaults carry 90; approach_speed_kt is untouched', () => {
        expect(AIRCRAFT.performance.instrument_approach_ias_kt).toBe(90);
        expect(AIRCRAFT.performance.approach_speed_kt).toBe(65);
        expect(CockpitConfigClass.AIRCRAFT_DEFAULTS.performance.instrument_approach_ias_kt).toBe(90);
    });

    it('Configuration -> Aircraft shows "Instrument Approach Speed (KIAS)" with 90', () => {
        const ed = new ConfigEditor(document.createElement('div'));
        ed._cockpitConfig = {};
        ed._aircraftConfig = JSON.parse(JSON.stringify(AIRCRAFT));
        ed._render();
        const input = ed._el.querySelector('#ce-aircraft-instrument_approach_ias_kt');
        expect(input).not.toBeNull();
        expect(input.value).toBe('90');
        expect(input.min).toBe('60');
        expect(input.max).toBe('160');
        expect(input.closest('.ce-field-row').textContent).toContain('Instrument Approach Speed (KIAS)');
    });

    it('the planner profile carries it as fuelPhases.approach.ias_kt (90 when the key is missing)', () => {
        useAircraft();
        expect(new RoutePlannerPanel(document.createElement('div'), null, null)._profileForPower(65).fuelPhases.approach.ias_kt).toBe(90);
        useAircraft({ instrument_approach_ias_kt: 120 });
        expect(new RoutePlannerPanel(document.createElement('div'), null, null)._profileForPower(65).fuelPhases.approach.ias_kt).toBe(120);
        useAircraft({ instrument_approach_ias_kt: undefined });
        expect(new RoutePlannerPanel(document.createElement('div'), null, null)._profileForPower(65).fuelPhases.approach.ias_kt).toBe(90);
    });

    it('validated: non-finite / zero / negative -> 90 (not en route); clamped to 60-160', () => {
        const ias = (v) => {
            useAircraft({ instrument_approach_ias_kt: v });
            return new RoutePlannerPanel(document.createElement('div'), null, null)._profileForPower(65).fuelPhases.approach.ias_kt;
        };
        for (const bad of [0, -5, NaN, Infinity, null, 'abc', '']) expect(ias(bad)).toBe(90);
        expect(ias(12)).toBe(60);       // a typo for 120 would otherwise plan a 12 kt approach
        expect(ias(200)).toBe(160);
        expect(ias(120)).toBe(120);
        expect(ias('120')).toBe(120);
    });

    it('setting 120 shortens the planned approach legs; the leg into the IAF is unchanged', async () => {
        useAircraft();
        const p90 = await planViaPanel();
        useAircraft({ instrument_approach_ias_kt: 120 });
        const p120 = await planViaPanel();
        const leg = (p, a, b) => p.legs.find(l => l.from === a && l.to === b);
        expect(leg(p120, 'WITUR', 'RW24').timeHrs).toBeLessThan(leg(p90, 'WITUR', 'RW24').timeHrs);
        expect(leg(p120, 'SAPSE', 'WITUR').timeHrs).toBeLessThan(leg(p90, 'SAPSE', 'WITUR').timeHrs);
        expect(leg(p120, 'KCLT', 'SAPSE')).toEqual(leg(p90, 'KCLT', 'SAPSE'));
    });
});
