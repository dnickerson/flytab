import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(
    join(__dirname, '../../web/cockpit/route-planner-panel.js'),
    'utf8'
);

// Load non-ESM class into jsdom environment
globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = vi.fn();

const RoutePlannerPanel = new Function(panelSrc + '\nreturn RoutePlannerPanel;')();

function makePanel() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const panel = new RoutePlannerPanel(el, null, null);
    // Skip full DOM init; wire minimal state
    panel._depInput  = null;
    panel._destInput = null;
    panel._route     = [];
    panel._insertIndex = null;
    panel._altitude  = 5500;
    return panel;
}

// ── _buildLegsFromWaypoints ────────────────────────────────────────────────

describe('_buildLegsFromWaypoints', () => {
    it('returns one fewer leg than waypoints', () => {
        const panel = makePanel();
        const wps = [
            { icao: 'KLKR', lat: 34.72, lon: -80.78 },
            { icao: 'KCLT', lat: 35.21, lon: -80.94 },
            { icao: 'KGSO', lat: 36.10, lon: -79.94 },
        ];
        const legs = panel._buildLegsFromWaypoints(wps);
        expect(legs).toHaveLength(2);
    });

    it('carries airway from destination waypoint into the leg', () => {
        const panel = makePanel();
        const wps = [
            { icao: 'KLKR', lat: 34.72, lon: -80.78 },
            { icao: 'ENO',  lat: 35.00, lon: -81.50, airway: 'V213' },
            { icao: 'KGSO', lat: 36.10, lon: -79.94 },
        ];
        const legs = panel._buildLegsFromWaypoints(wps);
        expect(legs[0].airway).toBe('V213');
        expect(legs[1].airway).toBeUndefined();
    });

    it('produces no airway on leg when waypoint has no airway', () => {
        const panel = makePanel();
        const wps = [
            { icao: 'KLKR', lat: 34.72, lon: -80.78 },
            { icao: 'KCLT', lat: 35.21, lon: -80.94 },
        ];
        const legs = panel._buildLegsFromWaypoints(wps);
        expect(legs[0].airway).toBeUndefined();
    });

    it('returns empty array for fewer than 2 waypoints', () => {
        const panel = makePanel();
        expect(panel._buildLegsFromWaypoints([])).toEqual([]);
        expect(panel._buildLegsFromWaypoints([{ icao: 'KLKR' }])).toEqual([]);
    });
});

// ── _buildField15String ────────────────────────────────────────────────────

describe('_buildField15String', () => {
    it('collapses interior same-airway fixes', () => {
        const panel = makePanel();
        const route = [
            { id: 'KLKR', type: 'dep' },
            { id: 'V213', type: 'awy' },
            { id: 'HPW',  type: 'fix', airway: 'V213' },
            { id: 'V213', type: 'awy' },
            { id: 'ENO',  type: 'fix', airway: 'V213' },
            { id: 'V213', type: 'awy' },
            { id: 'KGSO', type: 'dest' },
        ];
        const str = panel._buildField15String(route);
        // Interior fix HPW should be collapsed; result should be KLKR V213 ENO V213 KGSO
        // or similar compact form — ENO is the last interior fix before dest, not collapsed
        expect(str).not.toContain('HPW');
        expect(str).toContain('V213');
    });

    it('returns all IDs for direct route with no airways', () => {
        const panel = makePanel();
        const route = [
            { id: 'KLKR', type: 'dep' },
            { id: 'KCLT', type: 'fix' },
            { id: 'KGSO', type: 'dest' },
        ];
        const str = panel._buildField15String(route);
        expect(str).toBe('KLKR KCLT KGSO');
    });

    it('handles single-segment airway correctly', () => {
        const panel = makePanel();
        const route = [
            { id: 'KLKR', type: 'dep' },
            { id: 'V213', type: 'awy' },
            { id: 'KGSO', type: 'dest', airway: 'V213' },
        ];
        const str = panel._buildField15String(route);
        expect(str).toBe('KLKR V213 KGSO');
    });
});

// ── _onClearTap with confirmation ─────────────────────────────────────────

describe('_onClearTap', () => {
    it('calls _confirm when there are fix pills', async () => {
        const panel = makePanel();
        panel._route = [
            { id: 'KLKR', type: 'dep' },
            { id: 'KCLT', type: 'fix' },
            { id: 'KGSO', type: 'dest' },
        ];
        panel._confirm = vi.fn(() => Promise.resolve(true));
        panel._render   = vi.fn();
        await panel._onClearTap();
        expect(panel._confirm).toHaveBeenCalled();
    });

    it('clears route when _confirm returns true', async () => {
        const panel = makePanel();
        panel._route = [
            { id: 'KLKR', type: 'dep' },
            { id: 'KCLT', type: 'fix' },
            { id: 'KGSO', type: 'dest' },
        ];
        panel._confirm = vi.fn(() => Promise.resolve(true));
        panel._render   = vi.fn();
        await panel._onClearTap();
        // After confirm, route should be reset to dep+dest only (or empty)
        const fixes = panel._route.filter(r => r.type === 'fix');
        expect(fixes).toHaveLength(0);
    });

    it('does not clear route when _confirm returns false', async () => {
        const panel = makePanel();
        panel._route = [
            { id: 'KLKR', type: 'dep' },
            { id: 'KCLT', type: 'fix' },
            { id: 'KGSO', type: 'dest' },
        ];
        panel._confirm = vi.fn(() => Promise.resolve(false));
        panel._render   = vi.fn();
        await panel._onClearTap();
        expect(panel._route).toHaveLength(3);
    });

    it('skips _confirm when route has no interior fixes', async () => {
        const panel = makePanel();
        panel._route = [
            { id: 'KLKR', type: 'dep' },
            { id: 'KGSO', type: 'dest' },
        ];
        panel._confirm = vi.fn(() => Promise.resolve(true));
        panel._render   = vi.fn();
        await panel._onClearTap();
        expect(panel._confirm).not.toHaveBeenCalled();
    });
});

// ── Close abort (_applyAborted) ───────────────────────────────────────────

describe('close abort (_applyAborted)', () => {
    it('sets _applyAborted when close() is called', () => {
        const panel = makePanel();
        panel._applyAborted = false;
        panel.close();
        expect(panel._applyAborted).toBe(true);
    });

    it('_doApply returns false immediately when _applyAborted is true', async () => {
        const panel = makePanel();
        panel._applyAborted = true;
        panel._pillsToWaypoints = vi.fn();
        panel._toast = vi.fn();
        const result = await panel._doApply();
        expect(result).toBe(false);
        expect(panel._pillsToWaypoints).not.toHaveBeenCalled();
    });

    it('_applyAborted is reset to false when open() is called', () => {
        const panel = makePanel();
        panel._applyAborted = true;
        panel._loadPlan = vi.fn();
        panel._render   = vi.fn();
        panel.open({});
        expect(panel._applyAborted).toBe(false);
    });
});

// ── _doApply dep/dest derivation (approach with missed-approach fixes) ─────
//
// Regression test for: loading an approach whose procedure has fixes after
// the runway threshold (missed-approach/MAP fixes) pushed the destination
// airport out of the last array slot. _doApply used to take dep/dest from
// wps[0]/wps[last] positionally, so plan.destination silently became the
// missed-approach fix instead of the airport — which cascaded into a false
// "Fuel Stop" split in the route table. See web/cockpit/route-table.js
// isFuelStop()/_buildFlights() for the downstream half of this bug.

describe('_doApply dep/dest derivation', () => {
    it('derives destination from the dest pill, not the last waypoint', async () => {
        const panel = makePanel();
        panel._applyAborted = false;
        panel._windsPromise = null;
        panel._planner = null; // force _buildLegsFromWaypoints fallback path
        panel._pctPower = 65;
        panel._altitude = 5500;

        // Route after insertApproach() spliced RNAV 06 fixes around the KLKR
        // dest pill: IAF/FAF/runway fixes go before it, missed-approach fixes
        // (here a single hold fix) go after it — so KLKR is no longer last.
        panel._route = [
            { id: 'KLKR',      type: 'dep'  },
            { id: 'CORON',     type: 'fix'  },
            { id: 'RW06',      type: 'fix'  },
            { id: 'KLKR',      type: 'dest' },
            { id: 'MISSEDFIX', type: 'fix'  },
        ];

        panel._pillsToWaypoints = vi.fn().mockResolvedValue([
            { id: 'KLKR',      icao: 'KLKR',      name: 'KLKR',      lat: 34.72, lon: -80.78, type: 'APT' },
            { id: 'CORON',     icao: 'CORON',     name: 'CORON',     lat: 34.80, lon: -80.85 },
            { id: 'RW06',      icao: 'RW06',      name: 'RW06',      lat: 34.72, lon: -80.78 },
            { id: 'KLKR',      icao: 'KLKR',      name: 'KLKR',      lat: 34.72, lon: -80.78, type: 'APT' },
            { id: 'MISSEDFIX', icao: 'MISSEDFIX', name: 'MISSEDFIX', lat: 34.90, lon: -80.90 },
        ]);
        panel._saveCurrentTrip = vi.fn().mockResolvedValue();

        globalThis.app = { applyRouteEdit: vi.fn().mockResolvedValue() };

        const result = await panel._doApply();

        expect(result).toBe(true);
        const appliedPlan = globalThis.app.applyRouteEdit.mock.calls[0][0];
        expect(appliedPlan.departure).toBe('KLKR');
        expect(appliedPlan.destination).toBe('KLKR');
        expect(appliedPlan.flight_plan.destination).toBe('KLKR');

        delete globalThis.app;
    });
});
