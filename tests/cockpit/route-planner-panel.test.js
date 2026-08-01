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

// ── _profileForPower — cruise burn at configured cruise power ──────────────
//
// This is the profile the pilot's route table is actually computed from:
// every `recomputeLegs(...)` call in this panel passes
// `_profileForPower(this._pctPower)`, and `recomputeLegs` resolves
// `profileOverride || RV9A_FALLBACK` — so RV9A_FALLBACK's 8.4 gph cruise
// NEVER reaches the route table. Whatever this function returns is what the
// FUEL / REM columns, the TOTAL footer and the DEST badge are built from.
//
// ERROR DIRECTION for everything below: too LOW a cruise gph under-plans burn
// and therefore OVER-states fuel remaining — the direction that runs tanks dry.
// `power_settings[].gph` is a MEDIAN (build_power_curve.py writes
// `round(gph_med, 1)`), so taking the band value at the configured cruise power
// planned the average day; 8.4 is the p85 of that same 65-69% distribution.

const realConfig = JSON.parse(
    readFileSync(join(__dirname, '../../web/aircraft-config.json'), 'utf8')
);

function withConfig(perfPatch = {}) {
    const cfg = structuredClone(realConfig);
    Object.assign(cfg.performance, perfPatch);
    globalThis.CockpitConfig = { aircraftRaw: cfg };
    return cfg.performance;
}

describe('_profileForPower — cruise gph at the configured cruise power', () => {
    beforeEach(() => { withConfig(); });

    it('returns 8.4 gph at 65%, not the 8.1 band median', () => {
        const perf = withConfig();
        expect(perf.cruise_pwr_pct).toBe(65);
        expect(perf.power_settings.find(s => s.pct === 65).gph).toBe(8.1);

        const p = makePanel()._profileForPower(65);
        expect(p.fuelPhases.cruise.gph).toBe(8.4);
        expect(p.fuel_burn_gph).toBe(8.4);
    });

    it('still takes rpm / mp / tas / %power from the measured band entry', () => {
        const band = realConfig.performance.power_settings.find(s => s.pct === 65);
        const p = makePanel()._profileForPower(65);
        expect(p.fuelPhases.cruise.rpm).toBe(band.rpm);
        expect(p.fuelPhases.cruise.mp).toBe(band.mp);
        expect(p.fuelPhases.cruise.percent_power).toBe(band.pct);
        expect(p.cruise_ktas).toBe(band.tas_kt);
    });

    // Only 65% has a decided p85. No other band may be silently invented.
    it.each([[55, 6.5], [60, 7.3], [70, 8.7], [75, 8.9]])(
        'keeps the measured band median at %i%% (%s gph)',
        (pct, gph) => {
            const p = makePanel()._profileForPower(pct);
            expect(p.fuelPhases.cruise.gph).toBe(gph);
            expect(p.fuel_burn_gph).toBe(gph);
        });

    // The trigger is `perf.cruise_pwr_pct`, not a hardcoded 65.
    it('follows cruise_pwr_pct if the aircraft is reconfigured to cruise at 70%', () => {
        withConfig({ cruise_pwr_pct: 70 });
        const panel = makePanel();
        expect(panel._profileForPower(70).fuelPhases.cruise.gph).toBe(8.7); // max(8.7, 8.4)
        expect(panel._profileForPower(65).fuelPhases.cruise.gph).toBe(8.1); // no longer configured cruise
    });

    // Math.max, not a replacement — the constant may only ever RAISE burn.
    it('never lowers a band value that already exceeds the planning constant', () => {
        const perf = withConfig();
        perf.power_settings.find(s => s.pct === 65).gph = 9.2;
        expect(makePanel()._profileForPower(65).fuelPhases.cruise.gph).toBe(9.2);
    });

    // Stale-default guard: the old fallback was 4, ~2.9 gph below the measured
    // descent p85 of 6.9 — dead while `descent_gph` is in the config, but it is
    // the same defect class as the cruise median this suite exists for.
    it('descent falls back to the measured p85 6.9 when descent_gph is missing', () => {
        withConfig({ descent_gph: undefined });
        const p = makePanel()._profileForPower(65);
        expect(p.fuelPhases.descent.gph).toBe(6.9);
    });
});

// ── _showFuelStopPicker — manual airport entry ────────────────────────────
//
// The suggestion list can simply not contain the field the pilot wants
// (better price, self-serve after hours, a field he knows). Before this, the
// modal had no input at all: accept a suggestion or Skip. These tests pin the
// contract the consumer depends on — _processFuelStopCandidates uses ONLY
// chosen.icao / chosen.lat / chosen.lon, so a manual stop that resolves
// without coordinates would be spliced into the route and then silently
// vanish during Apply.

describe('_showFuelStopPicker — manual airport entry', () => {
    const CANDIDATE = {
        afterFixId: 'KLKR',
        cumHrsAtStop: 3.5,
        options: [
            { icao: 'KAND', name: 'Anderson Rgnl', lat: 34.49, lon: -82.71,
              distNm: 8.2, hasSelfServeFuel: true },
        ],
    };

    const flush = () => new Promise(r => setTimeout(r, 0));

    function openPicker(nasrDb, coords = {}) {
        const panel = makePanel();
        panel._nasrDb = nasrDb;
        panel._coords = coords;
        panel._toast  = vi.fn();

        const promise = panel._showFuelStopPicker(CANDIDATE);
        // Track settlement without awaiting — several tests assert the picker
        // deliberately does NOT resolve.
        let settled = false, value;
        promise.then(v => { settled = true; value = v; });

        const overlay = document.body.lastElementChild;
        return {
            panel, overlay,
            input: overlay.querySelector('.rpp-fs-manual-input'),
            btn:   overlay.querySelector('.rpp-fs-manual-btn'),
            tapUse: () => overlay.querySelector('.rpp-fs-manual-btn')
                                 .dispatchEvent(new Event('pointerup')),
            pressEnter: () => overlay.querySelector('.rpp-fs-manual-input')
                                 .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })),
            isSettled: () => settled,
            getValue:  () => value,
        };
    }

    beforeEach(() => { document.body.innerHTML = ''; });

    it('renders a manual-entry input and USE button in the picker', () => {
        const { input, btn } = openPicker(null);
        expect(input).toBeTruthy();
        expect(btn).toBeTruthy();
        expect(btn.textContent.trim()).toBe('USE');
    });

    // The tablet lives in direct sunlight in the cockpit; the dark scheme this
    // modal used to carry was unreadable there. Guard against a revert.
    it('renders the panel on the light, sunlight-readable token scheme', () => {
        const { overlay } = openPicker(null);
        const html = overlay.innerHTML;
        expect(html).toContain('var(--bg-primary');      // panel surface
        expect(html).toContain('var(--text-primary');    // identifiers
        expect(html).toContain('var(--accent');          // self-serve tag
        // None of the old dark-scheme values may come back.
        expect(html).not.toMatch(/#1a2030|#2a3040|#243040|#8899aa|#4db8ff|#aabbd0/i);
        // Nothing the pilot reads may drop below weight 700.
        expect(html).not.toMatch(/font-weight:\s*[1-6]00/);
    });

    it('gives the manual input and USE button full cockpit touch targets', () => {
        const { input, btn } = openPicker(null);
        expect(input.getAttribute('style')).toContain('min-height:var(--touch-min,56px)');
        expect(btn.getAttribute('style')).toContain('min-height:var(--touch-min,56px)');
    });

    it('resolves a candidate-shaped object from a typed identifier', async () => {
        const db = { getAirport: vi.fn(async () => (
            { id: 'KFDW', name: 'Fairfield County', lat: 34.6847, lon: -80.8547 })) };
        const p = openPicker(db);
        p.input.value = 'KFDW';
        p.tapUse();
        await flush();

        expect(p.isSettled()).toBe(true);
        expect(p.getValue()).toEqual({
            icao: 'KFDW',
            name: 'Fairfield County',
            lat: 34.6847,
            lon: -80.8547,
            hasSelfServeFuel: false,
        });
        // Consumer contract: coords cached and the modal torn down.
        expect(p.panel._coords.KFDW).toEqual({ lat: 34.6847, lon: -80.8547 });
        expect(document.body.contains(p.overlay)).toBe(false);
    });

    it('uppercases and trims the typed identifier before lookup', async () => {
        const db = { getAirport: vi.fn(async () => (
            { name: 'Fairfield County', lat: 34.6847, lon: -80.8547 })) };
        const p = openPicker(db);
        p.input.value = '  kfdw  ';
        p.tapUse();
        await flush();

        expect(db.getAirport).toHaveBeenCalledWith('KFDW');
        expect(p.getValue().icao).toBe('KFDW');
    });

    it('resolves on Enter in the input, not just on the USE tap', async () => {
        const db = { getAirport: vi.fn(async () => (
            { name: 'Fairfield County', lat: 34.6847, lon: -80.8547 })) };
        const p = openPicker(db);
        p.input.value = 'kfdw';
        p.pressEnter();
        await flush();

        expect(db.getAirport).toHaveBeenCalledWith('KFDW');
        expect(p.isSettled()).toBe(true);
        expect(p.getValue().icao).toBe('KFDW');
    });

    it('keeps the modal open and does not resolve when the identifier is unknown', async () => {
        const db = { getAirport: vi.fn(async () => null) };
        const p = openPicker(db);
        p.input.value = 'ZZZZ';
        p.tapUse();
        await flush();
        await flush();

        expect(p.isSettled()).toBe(false);
        expect(document.body.contains(p.overlay)).toBe(true);
        expect(p.panel._toast).toHaveBeenCalledWith(
            expect.stringContaining('not found as an airport'), expect.any(Number));

        // …and the pilot can correct it in the still-open modal.
        db.getAirport.mockResolvedValueOnce({ name: 'Fairfield County', lat: 34.6847, lon: -80.8547 });
        p.input.value = 'KFDW';
        p.tapUse();
        await flush();
        expect(p.isSettled()).toBe(true);
        expect(p.getValue().icao).toBe('KFDW');
    });

    it('refuses to resolve while the navigation database is still loading', async () => {
        const p = openPicker(null);
        p.input.value = 'KFDW';
        p.tapUse();
        await flush();
        await flush();

        expect(p.isSettled()).toBe(false);
        expect(document.body.contains(p.overlay)).toBe(true);
        expect(p.panel._toast).toHaveBeenCalledWith(
            expect.stringContaining('Navigation database still loading'), expect.any(Number));
    });

    it('does not resolve on an empty identifier', async () => {
        const db = { getAirport: vi.fn(async () => null) };
        const p = openPicker(db);
        p.input.value = '   ';
        p.tapUse();
        await flush();

        expect(db.getAirport).not.toHaveBeenCalled();
        expect(p.isSettled()).toBe(false);
        expect(document.body.contains(p.overlay)).toBe(true);
    });

    it('measures distNm from the anchor fix when its coordinates are cached', async () => {
        globalThis.NasrDB = { haversineNm: vi.fn(() => 12.345) };
        try {
            const db = { getAirport: vi.fn(async () => (
                { name: 'Fairfield County', lat: 34.6847, lon: -80.8547 })) };
            const p = openPicker(db, { KLKR: { lat: 34.7235, lon: -80.8546 } });
            p.input.value = 'KFDW';
            p.tapUse();
            await flush();

            expect(globalThis.NasrDB.haversineNm)
                .toHaveBeenCalledWith(34.7235, -80.8546, 34.6847, -80.8547);
            expect(p.getValue().distNm).toBe(12.3);
        } finally {
            delete globalThis.NasrDB;
        }
    });

    it('omits distNm rather than inventing one when the anchor fix has no coords', async () => {
        // NasrDB IS available here — the ONLY thing missing is the anchor's
        // position, so a distance measured from a substituted origin (0,0 say)
        // would be a fabricated number on a fuel-stop decision.
        globalThis.NasrDB = { haversineNm: vi.fn(() => 999) };
        try {
            const db = { getAirport: vi.fn(async () => (
                { name: 'Fairfield County', lat: 34.6847, lon: -80.8547 })) };
            const p = openPicker(db);   // _coords empty — anchor KLKR unknown
            p.input.value = 'KFDW';
            p.tapUse();
            await flush();

            expect(globalThis.NasrDB.haversineNm).not.toHaveBeenCalled();
            expect('distNm' in p.getValue()).toBe(false);
        } finally {
            delete globalThis.NasrDB;
        }
    });

    it('leaves the Skip button working — Skip still resolves null', async () => {
        const p = openPicker(null);
        p.overlay.querySelector('.rpp-fs-skip').dispatchEvent(new Event('pointerup'));
        await flush();
        expect(p.isSettled()).toBe(true);
        expect(p.getValue()).toBe(null);
        expect(document.body.contains(p.overlay)).toBe(false);
    });
});

describe('_profileForPower drives the real planner — 516.4 nm leg from 36 gal', () => {
    // End-to-end: the panel's profile through the same RoutePlanner the panel
    // uses. Pins the actual number on the pilot's REM column, not just the
    // constant behind it.
    it('shows 7.428 gal remaining, ~0.93 gal LESS than the 8.1 band median would', async () => {
        withConfig();
        const { RoutePlanner } = await import('../../web/shared/planning/planner/route-planner.js');
        const planner = new RoutePlanner({ aero: {}, plans: {}, profiles: {} });
        // 516.4 nm due north — 3.106 h of cruise at 6,500 ft.
        const plan = {
            waypoints: [
                { id: 'DEP', icao: 'KDEP', lat: 34.0,       lon: -80.0 },
                { id: 'DST', icao: 'KDST', lat: 42.6008667105, lon: -80.0 },
            ],
            cruiseAltFt: 6500,
        };
        const opts = { cruiseAltFt: 6500, pctPower: 65,
                       departureTime: new Date('2026-07-31T15:00:00Z') };

        const profile = makePanel()._profileForPower(65);
        expect(profile.fuel_capacity_gal).toBe(36);
        const after = planner.recomputeLegs(plan, profile, opts);
        expect(after.legs[0].distNm).toBeCloseTo(516.4, 1);
        expect(after.summary.fuelRemGal).toBeCloseTo(7.428, 3);
        expect(after.legs[0].segments.find(s => s.phase === 'CRZ').gph).toBe(8.4);

        // The same leg on the raw band median, i.e. what the pilot saw before.
        const band = structuredClone(profile);
        band.fuel_burn_gph = 8.1;
        band.fuelPhases.cruise.gph = 8.1;
        const before = planner.recomputeLegs(plan, band, opts);
        expect(before.summary.fuelRemGal).toBeCloseTo(8.359, 3);

        // Direction of error: planned burn UP, fuel remaining DOWN. Never the reverse.
        expect(after.summary.totalFuelGal).toBeGreaterThan(before.summary.totalFuelGal);
        expect(after.summary.fuelRemGal).toBeLessThan(before.summary.fuelRemGal);
        expect(before.summary.fuelRemGal - after.summary.fuelRemGal).toBeCloseTo(0.932, 2);
    });
});
