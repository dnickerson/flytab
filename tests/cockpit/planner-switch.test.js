/**
 * Replacing the current Route Planner with the new one, steps 1-2
 * (docs/superpowers/plans/2026-10-16-route-planner-replacement.md):
 *   1. the new planner stands alone (its own route engine without the current planner)
 *   2. one switch, cockpit-config `routePlanner: "legacy" | "new"` (default legacy), and
 *      every entry point goes through it: EDIT / new route (openRoutePlanner), Direct-To,
 *      Load procedure, plan sync's Replan, the route table's REV.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = (el, fn) => el && el.addEventListener && el.addEventListener('click', fn);
globalThis.DiagLog = globalThis.DiagLog || { log: vi.fn() };
globalThis.RouteCheck = new Function(read('web/shared/route-check.js') + '\nreturn RouteCheck;')();
const { RoutePlannerPanel, RoutePlannerV2 } = new Function(read('web/cockpit/route-planner-panel.js') + '\n'
    + read('web/cockpit/route-planner-v2.js') + '\nreturn { RoutePlannerPanel, RoutePlannerV2 };')();
const FlyTabApp = new Function(read('web/app.js') + '\nreturn FlyTabApp;')();

const nasrDb = { async getAirport() { return null; }, async getNavaid() { return null; }, async getFix() { return null; } };

describe('step 1: the new planner stands alone', () => {
    class FakeEngine { constructor(a) { this.adapters = a; } }
    class FakeTerminal { constructor(a) { this.aero = a; } }
    beforeEach(() => { document.body.innerHTML = '<div id="pv"></div>'; window.FlyTabPlanning = { RoutePlanner: FakeEngine, TerminalAnalyzer: FakeTerminal }; });
    afterEach(() => { delete window.FlyTabPlanning; });

    it('without the current planner it builds its own route engine', () => {
        const p = new RoutePlannerV2(document.getElementById('pv'), nasrDb, { aero: { a: 1 } }, null);
        p.init();
        expect(p._planner).toBeInstanceOf(FakeEngine);
    });

    it('beside the current planner it uses that one\'s engine (not a second)', () => {
        const main = { _planner: { main: 1 }, _terminalAnalyzer: { main: 2 }, _getAirwayPairCache: vi.fn(async () => new Map()) };
        const p = new RoutePlannerV2(document.getElementById('pv'), nasrDb, { aero: {} }, main);
        p.init();
        expect(p._planner).toBe(main._planner);
    });

    it('no T-route wizard in the new planner until step 3, with or without the current planner', () => {
        // terminalRouting is shared (flypi_planner_opts): borrowing the current
        // planner's analyzer opened the old wizard here (review 2026-10-17).
        const main = { _planner: { main: 1 }, _terminalAnalyzer: { main: 2 }, _getAirwayPairCache: vi.fn(async () => new Map()) };
        const beside = new RoutePlannerV2(document.getElementById('pv'), nasrDb, { aero: {} }, main);
        beside.init();
        expect(beside._terminalAnalyzer).toBeNull();
        const alone = new RoutePlannerV2(document.getElementById('pv'), nasrDb, { aero: { a: 1 } }, null);
        alone.init();
        expect(alone._terminalAnalyzer).toBeNull();
    });

    it('a NASR import mid-session rebuilds the engine it uses (the current planner\'s)', () => {
        const main = { _planner: { main: 1 }, _checkPlannerVersion: vi.fn(), _getAirwayPairCache: vi.fn(async () => new Map()) };
        const p = new RoutePlannerV2(document.getElementById('pv'), nasrDb, { aero: {} }, main);
        p._checkPlannerVersion();
        expect(main._checkPlannerVersion).toHaveBeenCalledTimes(1);
        const alone = new RoutePlannerV2(document.getElementById('pv'), nasrDb, { aero: { a: 1 } }, null);
        alone.init();
        const first = alone._planner;
        localStorage.setItem('flypi_nasr_version', 'v2');          // a NASR import after the planner started
        alone._checkPlannerVersion();
        expect(alone._planner).toBeInstanceOf(FakeEngine);
        expect(alone._planner).not.toBe(first);                     // its own engine rebuilt
        localStorage.removeItem('flypi_nasr_version');
    });

    it('the app builds it whether or not the current planner exists', () => {
        const src = read('web/app.js');
        expect(src).not.toMatch(/typeof RoutePlannerV2 !== 'undefined' && this\.routePlannerPanel\)/);
        expect(src).toMatch(/new RoutePlannerV2\([\s\S]{0,200}this\.routePlannerPanel \|\| null/);
    });
});

describe('a route-table edit keeps the kind of procedure on its fixes', () => {
    it('proc is passed through, not flattened to true', () => {
        const src = read('web/cockpit/route-table.js');
        const emit = src.slice(src.indexOf('    _emitRouteChange() {'), src.indexOf('    _emitRouteChange() {') + 1500);
        expect(emit).toMatch(/if \(wp\.proc\) out\.proc = wp\.proc;/);
    });
});

describe('step 1: the route table\'s REV uses the planner it is asked on', () => {
    it('the headless helper is the same class, with START FUEL', () => {
        document.body.innerHTML = '<div id="pv"></div>';
        const p = new RoutePlannerV2(document.getElementById('pv'), nasrDb, { aero: {} }, { _planner: {}, _getAirwayPairCache: async () => new Map() });
        p._startFuelGal = 22;
        const h = p._headless();
        expect(h).toBeInstanceOf(RoutePlannerV2);
        expect(h._startFuelGal).toBe(22);
        const b = new RoutePlannerPanel(document.createElement('div'), nasrDb, { aero: {} });
        expect(b._headless().constructor).toBe(RoutePlannerPanel);
    });
});

describe('step 2: one switch for every entry point', () => {
    let cfg;
    const container = () => document.getElementById('cockpitContainer');
    const mk = () => {
        document.body.innerHTML = '<div id="cockpitContainer"></div>';
        const a = Object.create(FlyTabApp.prototype);
        a.routePlannerPanel = { open: vi.fn(async () => {}), close: vi.fn(), setDirectTo: vi.fn(), insertApproach: vi.fn(), reverseAndApply: vi.fn(async () => ({ dep: 'B', dest: 'A' })), _onRecomputeTap: vi.fn(async () => {}) };
        a.routePlannerPreview = { open: vi.fn(async () => {}), close: vi.fn(), setDirectTo: vi.fn(), insertApproach: vi.fn(), reverseAndApply: vi.fn(async () => ({ dep: 'B', dest: 'A' })) };
        a._updateOrientation = vi.fn();
        a.cockpitMap = { map: { invalidateSize: vi.fn() }, releaseFollowHold: vi.fn() };
        a.approachCharts = { hide: vi.fn() };
        a.showToast = vi.fn();
        a._currentTrip = { waypoints: [{ icao: 'A' }, { icao: 'B' }] };
        return a;
    };
    beforeEach(() => { cfg = {}; globalThis.CockpitConfig = { get: (k) => cfg[k] }; });
    afterEach(() => { delete globalThis.CockpitConfig; });

    it('default (not set) and "legacy": the current planner; "new": the new one', () => {
        const a = mk();
        expect(a.routePlannerMode()).toBe('legacy');
        expect(a.activeRoutePlanner()).toBe(a.routePlannerPanel);
        cfg.routePlanner = 'legacy';
        expect(a.activeRoutePlanner()).toBe(a.routePlannerPanel);
        cfg.routePlanner = 'new';
        expect(a.routePlannerMode()).toBe('new');
        expect(a.activeRoutePlanner()).toBe(a.routePlannerPreview);
    });

    it('"new" without the new planner built, or "legacy" without the current one: whichever exists', () => {
        const a = mk();
        cfg.routePlanner = 'new';
        a.routePlannerPreview = null;
        expect(a.activeRoutePlanner()).toBe(a.routePlannerPanel);
        const b = mk();
        b.routePlannerPanel = null;
        expect(b.activeRoutePlanner()).toBe(b.routePlannerPreview);
    });

    it('EDIT / new route (openRoutePlanner) opens the planner chosen', async () => {
        const a = mk();
        await a.openRoutePlanner(null);
        expect(a.routePlannerPanel.open).toHaveBeenCalled();
        expect(container().classList.contains('route-preview')).toBe(false);
        a.closeRoutePlanner();
        cfg.routePlanner = 'new';
        await a.openRoutePlanner(null);
        expect(a.routePlannerPreview.open).toHaveBeenCalled();
        expect(container().classList.contains('route-preview')).toBe(true);
    });

    it('Direct-To: legacy as before (straight after open); new waits for the open, then sets it', async () => {
        const a = mk();
        a._directTo({ icao: 'KCDN' });
        expect(a.routePlannerPanel.setDirectTo).toHaveBeenCalledWith({ icao: 'KCDN' });
        cfg.routePlanner = 'new';
        let opened = false;
        a.routePlannerPreview.open = vi.fn(async () => { await Promise.resolve(); opened = true; });
        a.routePlannerPreview.setDirectTo = vi.fn(() => expect(opened).toBe(true));
        await a._directTo({ icao: 'KAIK' });
        expect(a.routePlannerPreview.setDirectTo).toHaveBeenCalledWith({ icao: 'KAIK' });
    });

    it('Load procedure: into the planner on screen; none open: opens the one chosen, then inserts', async () => {
        const a = mk();
        cfg.routePlanner = 'new';
        await a._loadProcedureIntoPlanner({ icao: 'KAIK' });
        expect(a.routePlannerPreview.open).toHaveBeenCalled();
        expect(a.routePlannerPreview.insertApproach).toHaveBeenCalledWith({ icao: 'KAIK' });
        expect(a.approachCharts.hide).toHaveBeenCalled();
        // the current planner is the one open: it gets it (whatever the switch says)
        a.closeRoutePlanner();
        cfg.routePlanner = 'legacy';
        a.openRoutePlanner(null);
        cfg.routePlanner = 'new';
        await a._loadProcedureIntoPlanner({ icao: 'KCDN' });
        expect(a.routePlannerPanel.insertApproach).toHaveBeenCalledWith({ icao: 'KCDN' });
    });

    it('route table REV goes through the planner chosen', async () => {
        const a = mk();
        await a.reverseActiveRoute();
        expect(a.routePlannerPanel.reverseAndApply).toHaveBeenCalled();
        cfg.routePlanner = 'new';
        await a.reverseActiveRoute();
        expect(a.routePlannerPreview.reverseAndApply).toHaveBeenCalled();
    });

    it('plan sync Replan: legacy as before (hidden recompute); new opens the planner with the plan (current winds, checks)', async () => {
        const a = mk();
        const plan = { flight_plan: { route: ['A', 'B'] } };
        await a.replanWithCurrentWinds(plan);
        expect(a.routePlannerPanel.open).toHaveBeenCalledWith(plan);
        expect(a.routePlannerPanel._onRecomputeTap).toHaveBeenCalled();
        cfg.routePlanner = 'new';
        await a.replanWithCurrentWinds(plan);
        expect(a.routePlannerPreview.open).toHaveBeenCalledWith(plan);
        expect(container().classList.contains('route-preview')).toBe(true);
        expect(read('web/cockpit/plan-sync.js')).toMatch(/replanWithCurrentWinds/);
    });

    it('the planner on screen: whichever is open, or none', () => {
        const a = mk();
        expect(a.openRoutePlannerInstance()).toBeNull();
        a.openRoutePlanner(null);
        expect(a.openRoutePlannerInstance()).toBe(a.routePlannerPanel);
        a.closeRoutePlanner();
        a.openRoutePlannerPreview(null);
        expect(a.openRoutePlannerInstance()).toBe(a.routePlannerPreview);
    });

    it('the #74 check reads the planner on screen', () => {
        const src = read('web/app.js');
        const i = src.indexOf('#74 state check');
        expect(src.slice(i - 900, i)).toMatch(/openRoutePlannerInstance\(\)/);
    });

    it('cockpit-config.json sets it to legacy (nothing changes until it is switched)', () => {
        expect(JSON.parse(read('web/cockpit-config.json')).routePlanner).toBe('legacy');
    });
});
