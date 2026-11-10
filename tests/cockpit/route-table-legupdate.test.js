/**
 * route-table.js `_emitLegUpdate()` → `activeroute:legupdate` → power-tradeoff.js
 * (SDD Task 14).
 *
 * `_emitLegUpdate` published `fuelRemaining` straight off the engine poll payload
 * (`fuel_remaining_gal ?? fuel_gal ?? Gallons_Rem ?? Fuel_Remaining`). Every one of
 * those names resolves to the EDM's own totalizer — engine-panel.js flattens
 * `raw.data` over `raw`, and engine_monitor.py emits `Gallons_Rem` — so the event
 * carried a figure that beat both the tracked tank state and the pilot's own manual
 * override, and beat them HIGH.
 *
 * `PowerTradeoff` is mounted by app.js on every launch and opens when the pilot taps
 * ETE or DEST on the instrument strip. It computes `fuelAtDest = fuelRemaining -
 * fuelBurn` directly off this field, so the over-report landed on a pilot-reachable
 * panel in a reassuring colour.
 *
 * Contracts covered:
 *  1. `fuelRemaining` is the canonical read (manual override > tracked FuelTankState),
 *     never the raw EDM totalizer.
 *  2. A `capacity` source means nothing is tracked — published as null, so consumers
 *     render no-data rather than full tanks.
 *  3. Dry tracked tanks (0.0) stay a real reading, distinguishable from no-data.
 *  4. A stale tracked figure is still published but flagged `fuelRemainingStale`.
 *  5. PowerTradeoff, driven end to end through the REAL event, renders those states
 *     correctly — and a stale figure never renders in the plain (in-limits) style.
 *  6. Its FUEL@DEST colour bands come from config, not hardcoded 4/8/12.
 *
 * Nothing about the fuel chain is stubbed: the real FuelState, FuelTankState,
 * FuelEngine, the real aircraft-config.json / cockpit-config.json values and the real
 * PowerTradeoff DOM are used, and the event travels over the real `window` bus.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');

globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();
const PowerTradeoff = new Function(read('web/cockpit/power-tradeoff.js') + '\nreturn PowerTradeoff;')();

const AIRCRAFT = JSON.parse(read('web/aircraft-config.json'));
const COCKPIT  = JSON.parse(read('web/cockpit-config.json'));

/** Resolve a dotted path against an object, the way CockpitConfig does. */
function dotted(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

let pt = null;
let lastDetail = null;
let captureListener = null;

/**
 * Install the real fuel world.
 *   tankL === null  → FuelTankState loaded but never initialised (nothing tracked)
 *   staleMinutes>0  → age the last integrated sample past FuelTankState.STALE_MS
 *   edmGal          → the raw EDM totalizer on the engine poll payload
 */
function setupFuel({ tankL = null, tankR = null, manual = null,
                     staleMinutes = 0, edmGal = null, liveGph = null } = {}) {
    localStorage.clear();
    FuelTankState._state = null;
    FuelTankState._loaded = false;

    globalThis.Settings = { fuelManualOverride: manual, fuelMeasurement: null, get: () => null, set: () => {} };
    globalThis.CockpitConfig = {
        aircraft: (path) => dotted(AIRCRAFT, path),
        get: (path) => dotted(COCKPIT, path),
    };
    globalThis.FlyTabPlanning = {
        bearing: () => 0,
        windCorrectedMagHdg: () => 0,
        crossTrackDistanceNm: () => 0,
    };

    if (tankL === null) {
        FuelTankState._loaded = true;   // loaded, nothing ever initialised
    } else {
        FuelTankState.init(tankL, tankR, 'L');
        if (staleMinutes > 0) {
            FuelTankState._state.last_sample_at =
                new Date(Date.now() - staleMinutes * 60000).toISOString();
            FuelTankState._save();
        }
    }

    // The raw EDM totalizer the old code read. Present in every scenario so a
    // regression back to the EDM chain shows up as a wrong number, not a null.
    window.enginePanel = (edmGal == null && liveGph == null) ? undefined : {
        lastData: {
            ...(edmGal  != null ? { Gallons_Rem: edmGal, fuel_remaining_gal: edmGal } : {}),
            ...(liveGph != null ? { fuel_flow_gph: liveGph } : {}),
        },
    };
}

/** 120 nm single-leg route, KLKR → KFGX, active on the leg. */
function makeRoute() {
    const rt = Object.create(RouteTable.prototype);
    rt._waypoints = [
        { icao: 'KLKR', type: 'APT', lat: 34.72, lon: -80.78 },
        { icao: 'KFGX', type: 'APT', lat: 35.50, lon: -80.20,
          _legDist: 120, _segments: [{ phase: 'CRZ', gph: 9, ete_min: 60, tas: 120, gs: 120, dist: 120 }] },
    ];
    rt._activeIndex = 1;
    rt._flights = [];
    rt._destIcao = null;
    rt._cruisePower = null;
    rt._lastSituation = null;
    rt._editMode = false;
    rt._editBtn = null;
    rt._saveBtn = null;
    rt._updateSummary = () => {};
    rt._renderTable = () => {};
    return rt;
}

/** Fire one real _emitLegUpdate and return the captured detail. */
function emit(rt) {
    rt._computeEnroute();     // ends by calling _emitLegUpdate()
    return lastDetail;
}

/** FUEL@DEST cell text + class for the given power percentage, read off the
 *  REAL PowerTradeoff DOM after a real event. */
function fuelAtDestCell(pct) {
    const rows = [...pt._el.querySelectorAll('.pt-table tbody tr')];
    const row = rows.find(r => r.querySelector('.pt-pwr')?.textContent.includes(`${pct}%`));
    if (!row) return null;
    const cell = row.children[4];
    return { text: cell.textContent.trim(), cls: cell.className };
}

beforeEach(() => {
    lastDetail = null;
    captureListener = (e) => { lastDetail = e.detail; };
    window.addEventListener('activeroute:legupdate', captureListener);
});

afterEach(() => {
    window.removeEventListener('activeroute:legupdate', captureListener);
    if (pt) { pt.destroy(); pt = null; }
    delete globalThis.CockpitConfig;
    delete globalThis.FlyTabPlanning;
    delete globalThis.Settings;
    delete window.enginePanel;
});

// ── The event payload ──────────────────────────────────────────────────────

describe('_emitLegUpdate — fuelRemaining is the canonical read', () => {
    it('publishes the tracked tank total, not the raw EDM totalizer', () => {
        setupFuel({ tankL: 5, tankR: 5, edmGal: 30 });
        const d = emit(makeRoute());
        expect(d.fuelRemaining).toBeCloseTo(10, 5);
        expect(d.fuelRemainingSource).toBe('tank_state');
        expect(d.fuelRemainingStale).toBe(false);
    });

    it('publishes the manual override — it beats both tank state and the EDM', () => {
        setupFuel({ tankL: 5, tankR: 5, manual: 22, edmGal: 30 });
        const d = emit(makeRoute());
        expect(d.fuelRemaining).toBeCloseTo(22, 5);
        expect(d.fuelRemainingSource).toBe('manual');
    });

    it('publishes null when nothing is tracked — never the capacity fallback', () => {
        // getCurrentFuel() reports { gallons: 36, source: 'capacity' } here. Publishing
        // 36 would tell PowerTradeoff the tanks are full with no fuel data behind it.
        setupFuel({ tankL: null, edmGal: 30 });
        const d = emit(makeRoute());
        expect(d.fuelRemaining).toBeNull();
        expect(d.fuelRemainingSource).toBe('capacity');
    });

    it('publishes a real 0.0 for dry tracked tanks — not the same as no-data', () => {
        setupFuel({ tankL: 0, tankR: 0, edmGal: 30 });
        const d = emit(makeRoute());
        expect(d.fuelRemaining).toBe(0);
        expect(d.fuelRemainingSource).toBe('tank_state');
    });

    it('still publishes a stale tracked figure but flags it', () => {
        setupFuel({ tankL: 9, tankR: 9, staleMinutes: 90, edmGal: 30 });
        expect(FuelTankState.needsConfirmation()).toBe(true);
        const d = emit(makeRoute());
        expect(d.fuelRemaining).toBeCloseTo(18, 5);
        expect(d.fuelRemainingStale).toBe(true);
    });

    it('never flags a manual override stale — it is the pilot\'s own entry', () => {
        setupFuel({ tankL: 9, tankR: 9, staleMinutes: 90, manual: 22 });
        const d = emit(makeRoute());
        expect(d.fuelRemainingStale).toBe(false);
    });

    it('keeps liveGph on the EDM — flow rate is the one thing the EDM measures', () => {
        setupFuel({ tankL: 5, tankR: 5, edmGal: 30, liveGph: 7.4 });
        const d = emit(makeRoute());
        expect(d.liveGph).toBeCloseTo(7.4, 5);
    });
});

// ── End-to-end into the mounted consumer ───────────────────────────────────

describe('PowerTradeoff FUEL@DEST — driven by the real event', () => {
    /** Mount the real panel the way app.js does, then fire one real leg update. */
    function mountAndEmit(fuelWorld) {
        setupFuel(fuelWorld);
        pt = new PowerTradeoff();
        pt.init();
        pt.show();
        emit(makeRoute());
        return pt;
    }

    it('projects from the tracked total, not the EDM totalizer 20 gal above it', () => {
        // 10 gal tracked, EDM says 30. 120 nm at 65% (153 kt, 8.1 gph) burns 6.4 gal.
        mountAndEmit({ tankL: 5, tankR: 5, edmGal: 30 });
        const cell = fuelAtDestCell(65);
        expect(cell.text).toBe('3.6 gal');       // was 23.6 gal off the EDM
        expect(cell.cls).toBe('pt-red');         // <= fuelWarningGal
    });

    it('renders no-data when nothing is tracked — never a projection from full tanks', () => {
        mountAndEmit({ tankL: null, edmGal: 30 });
        expect(fuelAtDestCell(65).text).toBe('—');
    });

    it('projects from dry tracked tanks as a real (negative) reserve', () => {
        mountAndEmit({ tankL: 0, tankR: 0, edmGal: 30 });
        const cell = fuelAtDestCell(65);
        expect(cell.text).toBe('-6.4 gal');
        expect(cell.cls).toBe('pt-red');
    });

    it('follows a manual override immediately', () => {
        mountAndEmit({ tankL: 5, tankR: 5, manual: 22, edmGal: 30 });
        expect(fuelAtDestCell(65).text).toBe('15.6 gal');
    });

    it('marks a stale figure and never leaves it in the plain in-limits style', () => {
        // 30 gal tracked but unconfirmed: 30 - 6.4 = 23.6 gal, comfortably above every
        // band, so without the stale rule this row would render with no colour at all.
        mountAndEmit({ tankL: 15, tankR: 15, staleMinutes: 90, edmGal: 30 });
        const cell = fuelAtDestCell(65);
        expect(cell.text).toBe('23.6? gal');
        expect(cell.cls).toBe('pt-amber');
    });

    it('keeps the danger colour on a stale figure — staleness never softens a warning', () => {
        mountAndEmit({ tankL: 2, tankR: 2, staleMinutes: 90 });
        const cell = fuelAtDestCell(65);
        expect(cell.text).toBe('-2.4? gal');
        expect(cell.cls).toBe('pt-red');
    });
});

describe('PowerTradeoff FUEL@DEST — colour bands come from config', () => {
    /** Mount with an overridden cockpit-config block. */
    function mountWithThresholds(thresholds, fuelWorld) {
        setupFuel(fuelWorld);
        const base = globalThis.CockpitConfig.get;
        globalThis.CockpitConfig.get = (path) =>
            Object.prototype.hasOwnProperty.call(thresholds, path) ? thresholds[path] : base(path);
        pt = new PowerTradeoff();
        pt.init();
        pt.show();
        emit(makeRoute());
    }

    it('reads enginePage.fuelWarningGal / fuelCautionGal / fuelAdvisoryGal', () => {
        // 18 gal tracked → 11.6 at dest. Under the shipped 4/8/12 bands that is the
        // advisory band; raise the warning threshold and the same figure must go red.
        mountWithThresholds({ 'enginePage.fuelWarningGal': 15 }, { tankL: 9, tankR: 9 });
        expect(fuelAtDestCell(65)).toEqual({ text: '11.6 gal', cls: 'pt-red' });
    });

    it('widens the caution band when fuelCautionGal is raised', () => {
        mountWithThresholds({ 'enginePage.fuelCautionGal': 15 }, { tankL: 9, tankR: 9 });
        expect(fuelAtDestCell(65)).toEqual({ text: '11.6 gal', cls: 'pt-amber' });
    });

    it('drops the advisory band when fuelAdvisoryGal is lowered below the figure', () => {
        mountWithThresholds({ 'enginePage.fuelAdvisoryGal': 5 }, { tankL: 9, tankR: 9 });
        expect(fuelAtDestCell(65)).toEqual({ text: '11.6 gal', cls: '' });
    });

    it('treats the threshold itself as inside the band (<=, not <)', () => {
        // Exactly at the warning threshold must read danger, matching the engine page,
        // the route table REM column and the route-strip DEST badge. 10 gal aboard,
        // 120 nm at the 65% row (153 kt / 8.1 gph) — the same expression the panel
        // evaluates, so the comparison really is an equality.
        const exact = 10 - (120 / 153) * 8.1;
        mountWithThresholds({ 'enginePage.fuelWarningGal': exact }, { tankL: 5, tankR: 5 });
        expect(fuelAtDestCell(65).cls).toBe('pt-red');
    });

    it('ships with 12 as the advisory band — an app-wide config key, not a magic number', () => {
        expect(dotted(COCKPIT, 'enginePage.fuelAdvisoryGal')).toBe(12);
    });
});

// ── Structural pin: this is the DOM app.js actually builds ─────────────────

describe('structural — the panel under test is the one app.js mounts', () => {
    it('builds its own table DOM from init() and appends it to the document', () => {
        setupFuel({ tankL: 9, tankR: 9 });
        pt = new PowerTradeoff();
        pt.init();                       // exactly what app.js does at :859-860
        pt.show();
        emit(makeRoute());
        // The cells asserted above are read out of the live document, not a fixture.
        expect(document.body.contains(pt._el)).toBe(true);
        expect(document.querySelectorAll('.pt-panel .pt-table tbody tr').length).toBeGreaterThan(0);
        expect(document.querySelector('.pt-panel .pt-table thead').textContent).toContain('FUEL@DEST');
    });

    it('re-renders on a later leg update without being re-opened', () => {
        setupFuel({ tankL: 15, tankR: 15 });
        pt = new PowerTradeoff();
        pt.init();
        pt.show();
        const rt = makeRoute();
        emit(rt);
        expect(fuelAtDestCell(65).text).toBe('23.6 gal');
        // Pilot burns down to 10 gal; next 1 Hz _computeEnroute must move the panel.
        FuelTankState.init(5, 5, 'L');
        emit(rt);
        expect(fuelAtDestCell(65).text).toBe('3.6 gal');
    });
});
