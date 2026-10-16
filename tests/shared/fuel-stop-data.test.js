/**
 * Fuel stops on the tablet never appeared (Dana, 2026-10-15/16). Verified on
 * the tablet with KLKR-KTMB: 8 airports with fuel within 40 nm of the 2 h
 * point, none offered, because the saved planner option selfServeOnly was
 * true and NASR carries no self-serve data (0 of 19,135 airports in the
 * 2026-10-01 bundle), with no control on any screen to turn it off. Also,
 * "has fuel" counted any fuel string, so 325 Jet-A/MOGAS-only airports could
 * be offered to a 100LL O-360.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { IdbAeroData } from '../../web/shared/planning-adapters/idb-aero.js';

describe('fuel stop data', () => {
    const aero = new IdbAeroData({});
    const rec = (fuel) => aero._normaliseAirport({ icao: 'KXXX', name: 'x', lat: 30, lon: -81, fuel }, 'KXXX');

    it('a fuel stop needs avgas: real NASR fuel codes', () => {
        for (const f of ['100LLA', '100LL', '100LLA+', '100LLA1+', '100LLA    A+', '100', '100LLMOGAS', '100  A']) expect(rec(f).hasFuel, f).toBe(true);
        for (const f of ['A', 'A++', 'A1+', 'MOGAS', '', null]) expect(rec(f).hasFuel, String(f)).toBe(false);
    });

    it('a saved "self-serve only" is not applied (NASR has no self-serve data)', () => {
        globalThis.wireTap = globalThis.wireTap || (() => {});
        globalThis.DiagLog = globalThis.DiagLog || { log: vi.fn() };
        const RoutePlannerPanel = new Function(readFileSync('web/cockpit/route-planner-panel.js', 'utf8') + '\nreturn RoutePlannerPanel;')();
        localStorage.setItem('flypi_planner_opts', JSON.stringify({ selfServeOnly: true, maxLegHrs: 2 }));
        const p = new RoutePlannerPanel(document.createElement('div'), null, null);
        p._loadOpts();
        expect(p._selfServeOnly).toBe(false);
        expect(p._maxLegHrs).toBe(2);
        localStorage.clear();
    });
});
