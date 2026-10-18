/**
 * Direct-To from the present position (map D→; Dana, 2026-10-18):
 *  - D→ opens a panel: the route's waypoints (next first) and an identifier box
 *    (airport / navaid / fix from NASR, offline);
 *  - a route waypoint becomes the next one; a point off the route is inserted as
 *    the next waypoint and the route continues after it;
 *  - the leg starts at the present position (ActiveRoute leg origin): the route
 *    table passes the waypoint on that leg and the map draws it as a fixed course;
 *  - no GPS fix: nothing changes; no route: a two-point route from "PPOS".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = global.DiagLog || { log: vi.fn() };
globalThis.wireTap = (el, fn) => el && el.addEventListener && el.addEventListener('click', fn);
globalThis.FuelEngine = new Function(read('web/shared/fuel-engine.js') + '\nreturn FuelEngine;')();
globalThis.FuelTankState = new Function(read('web/shared/fuel-tank-state.js') + '\nreturn FuelTankState;')();
globalThis.FuelState = new Function(read('web/shared/fuel-state.js') + '\nreturn FuelState;')();
globalThis.GpsFix = new Function(read('web/shared/gps-fix.js') + '\nreturn GpsFix;')();
const ActiveRoute = new Function(read('web/shared/active-route.js') + '\nreturn ActiveRoute;')();
globalThis.ActiveRoute = ActiveRoute;
const RealNasrDB = new Function(read('web/shared/nasr-db.js') + '\nreturn NasrDB;')();
const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();
const CockpitMap = new Function(read('web/cockpit/map.js') + '\nreturn CockpitMap;')();
const DirectToPanel = new Function(read('web/cockpit/direct-to-panel.js') + '\nreturn DirectToPanel;')();
const FlyTabApp = new Function(read('web/app.js') + '\nreturn FlyTabApp;')();
const AIRCRAFT = JSON.parse(read('web/aircraft-config.json'));
const COCKPIT = JSON.parse(read('web/cockpit-config.json'));
const dotted = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);

const R = 3440.065, rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
const bearing = (a, b, c, d) => { const p1 = rad(a), p2 = rad(c), dl = rad(d - b); return (deg(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl))) + 360) % 360; };
const dest = ([la, lo], brg, nm) => { const d = nm / R, t = rad(brg), p1 = rad(la), l1 = rad(lo); const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t)); return [deg(p2), deg(l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2)))]; };
const DEP = [34.72, -80.85];
const W = (id, [lat, lon], type) => ({ icao: id, name: id, lat, lon, ...(type ? { type } : {}) });
const SOUTH = () => [W('KLKR', DEP, 'APT'), W('W1', dest(DEP, 180, 20)), W('W2', dest(DEP, 180, 40)), W('KDST', dest(DEP, 180, 60), 'APT')];

function table(wps) {
    const rt = Object.create(RouteTable.prototype);
    Object.assign(rt, { _waypoints: wps, _activeIndex: 1, _flights: [], _destIcao: null, _cruisePower: null, _lastSituation: null,
        _editMode: false, _undoStack: [], _updateSummary() {}, _renderTable() {}, _updateTableCells: () => true, _computeEnroute() {},
        _buildMissingSegments() {}, _refreshCloudForecast() {}, _onRouteChanged: vi.fn() });
    ActiveRoute.setPlan({ waypoints: rt._waypoints });
    rt._activeIndex = ActiveRoute.getIndex();
    rt._onActiveRouteAdvance = (e) => {        // as loadPlan wires it
        const n = e.detail.index;
        if (n !== rt._activeIndex) { rt._waypoints.forEach((w, i) => { w.passed = i < n; w.active = i === n; }); rt._activeIndex = n; }
    };
    window.addEventListener('activeroute:advance', rt._onActiveRouteAdvance);
    return rt;
}
const fly = (rt, start, hdg, kt, secs) => { let p = start; for (let s = 0; s < secs; s++) { p = dest(p, hdg, kt / 3600); rt.updateLive({ lat: p[0], lon: p[1], true_course: hdg, ground_speed: kt }); } return p; };

let tables = [];
beforeEach(() => {
    globalThis.NasrDB = RealNasrDB;
    globalThis.FlyTabPlanning = { bearing };
    FuelTankState._state = null; FuelTankState._loaded = true;
    globalThis.Settings = { fuelManualOverride: null, fuelMeasurement: null, get: () => null, set: () => {} };
    globalThis.CockpitConfig = { aircraft: (p) => dotted(AIRCRAFT, p), get: (p) => dotted(COCKPIT, p) };
    ActiveRoute.setPlan(null);
    document.body.innerHTML = '';
});
afterEach(() => {
    for (const t of tables) window.removeEventListener('activeroute:advance', t._onActiveRouteAdvance);
    tables = [];
});
const mk = (wps = SOUTH()) => { const t = table(wps); tables.push(t); return t; };

describe('ActiveRoute.directTo', () => {
    it('sets the index and the leg origin, and tells subscribers', () => {
        const wps = SOUTH(); ActiveRoute.setPlan({ waypoints: wps });
        const seen = []; const h = (e) => seen.push(e.detail); window.addEventListener('activeroute:advance', h);
        expect(ActiveRoute.directTo(2, { lat: 34.5, lon: -80.6 })).toBe(true);
        window.removeEventListener('activeroute:advance', h);
        expect(ActiveRoute.getIndex()).toBe(2);
        expect(ActiveRoute.getLegOrigin()).toEqual({ lat: 34.5, lon: -80.6 });
        expect(seen[0]).toMatchObject({ index: 2, origin: { lat: 34.5, lon: -80.6 } });
    });
    it('a normal advance, setIndex or a new plan ends it', () => {
        const wps = SOUTH();
        for (const end of [() => ActiveRoute.advance(), () => ActiveRoute.setIndex(3), () => ActiveRoute.setPlan({ waypoints: wps })]) {
            ActiveRoute.setPlan({ waypoints: wps }); ActiveRoute.directTo(2, { lat: 34, lon: -80 });
            end();
            expect(ActiveRoute.getLegOrigin()).toBeNull();
        }
    });
    it('refuses without a plan, a valid index or a position', () => {
        expect(ActiveRoute.directTo(1, { lat: 34, lon: -80 })).toBe(false);
        ActiveRoute.setPlan({ waypoints: SOUTH() });
        expect(ActiveRoute.directTo(9, { lat: 34, lon: -80 })).toBe(false);
        expect(ActiveRoute.directTo(1, { lat: NaN, lon: -80 })).toBe(false);
        expect(ActiveRoute.getLegOrigin()).toBeNull();
    });
});

describe('the route table', () => {
    it('direct to a waypoint ahead: it is next, those before it passed', () => {
        const rt = mk(); const pos = { lat: 34.6, lon: -80.7 };
        expect(rt.directTo(rt._waypoints[2], pos)).toBe(true);
        expect(rt._activeIndex).toBe(2);
        expect(rt._waypoints.map((w) => !!w.passed)).toEqual([true, true, false, false]);
        expect(ActiveRoute.getLegOrigin()).toEqual(pos);
        expect(rt._waypoints).toHaveLength(4);                       // nothing inserted
    });

    it('direct to a point off the route: inserted next, the route continues to the old next', () => {
        const rt = mk();
        const off = W('KCDN', dest(DEP, 150, 15), 'APT');
        expect(rt.directTo(off, { lat: 34.6, lon: -80.8 })).toBe(true);
        expect(rt._waypoints.map((w) => w.icao)).toEqual(['KLKR', 'KCDN', 'W1', 'W2', 'KDST']);
        expect(rt._activeIndex).toBe(1);
        expect(rt._onRouteChanged).toHaveBeenCalled();                // saved like any edit
        expect(rt._undoStack).toHaveLength(1);                        // undo state kept, as for any edit
        expect(rt._waypoints[1].is_fuel_stop).toBe(false);            // no fuel-stop prompt in flight
    });

    it('the waypoint is passed on the Direct-To leg, not the old one', () => {
        // 5 nm south of W1 (beyond W1's old abeam line), direct back to W1, flying north
        const rt = mk(); const start = dest([rt._waypoints[1].lat, rt._waypoints[1].lon], 180, 5);
        rt.directTo(rt._waypoints[1], { lat: start[0], lon: start[1] });
        fly(rt, start, 0, 120, 90);                                   // 3 nm: still 2 nm short
        expect(rt._activeIndex).toBe(1);
        fly(rt, dest(start, 0, 3), 0, 120, 70);                       // through W1
        expect(rt._activeIndex).toBe(2);
        expect(ActiveRoute.getLegOrigin()).toBeNull();                // normal legs again
    });

    it('with the old leg the same position would have passed W1 at once (the reason for the origin)', () => {
        const rt = mk(); const start = dest([rt._waypoints[1].lat, rt._waypoints[1].lon], 180, 5);
        rt.updateLive({ lat: start[0], lon: start[1], true_course: 0, ground_speed: 120 });
        expect(rt._activeIndex).toBe(2);
    });

    it('after an undo (a new array) the old Direct-To leg is not used', () => {
        const rt = mk();
        rt.directTo(W('KCDN', dest(DEP, 150, 15), 'APT'), { lat: 34.6, lon: -80.8 });
        rt._waypoints = JSON.parse(JSON.stringify(rt._waypoints));   // what _popUndo does
        expect(rt._directOrigin()).toBeNull();
    });
});

describe('the map draws the Direct-To leg as a fixed course', () => {
    const fakeLayer = () => ({ latlngs: null, setLatLngs(l) { this.latlngs = l; }, setStyle() {} });
    it('from the Direct-To origin, not from own-ship; normal legs from own-ship', () => {
        const wps = SOUTH(); ActiveRoute.setPlan({ waypoints: wps });
        const c = Object.create(CockpitMap.prototype);
        Object.assign(c, { _routeWaypoints: wps, _legLines: [fakeLayer(), fakeLayer(), fakeLayer()], _activeLegLine: fakeLayer(), _activeWpIdx: 0 });
        ActiveRoute.directTo(2, { lat: 34.6, lon: -80.7 });
        CockpitMap.prototype._updateActiveLeg.call(c, [34.5, -80.8]);
        expect(c._activeLegLine.latlngs).toEqual([[34.6, -80.7], [wps[2].lat, wps[2].lon]]);
        ActiveRoute.advance();
        CockpitMap.prototype._updateActiveLeg.call(c, [34.5, -80.8]);
        expect(c._activeLegLine.latlngs[0]).toEqual([34.5, -80.8]);
    });
    it('ownPosition: the live fix only', () => {
        const c = Object.create(CockpitMap.prototype);
        c.ownshipMarker = { getLatLng: () => ({ lat: 34.7, lng: -80.8 }) };
        c._ownshipVisible = true; c._held = false;
        expect(c.ownPosition()).toEqual({ lat: 34.7, lon: -80.8 });
        c._held = true; expect(c.ownPosition()).toBeNull();
        c._held = false; c._ownshipVisible = false; expect(c.ownPosition()).toBeNull();
    });
    it('the D→ button opens the panel (no longer a placeholder)', () => {
        const src = read('web/cockpit/map.js');
        expect(src).not.toMatch(/Direct-To — Stage 2 feature/);
        expect(src).toMatch(/if \(this\.onDirectToTap\) this\.onDirectToTap\(\)/);
        expect(read('web/app.js')).toMatch(/this\.cockpitMap\.onDirectToTap = \(\) => this\.directToPanel\.open\(\)/);
        expect(read('web/index.html')).toMatch(/cockpit\/direct-to-panel\.js/);
    });
});

describe('the D→ panel', () => {
    const nasr = {
        getAirport: async (id) => ({ KCDN: { icao: 'KCDN', name: 'Woodward Fld', lat: 34.28, lon: -80.56 } })[id] || null,
        getNavaid: async (id) => (id === 'CAE' ? { id: 'CAE', name: 'Columbia', lat: 33.86, lon: -81.05 } : null),
        getFix: async (id) => (id === 'GREAT' ? { id: 'GREAT', lat: 34.1, lon: -80.9 } : null),
    };
    const app = (rt, pos = { lat: 34.6, lon: -80.85 }) => ({ routeTable: rt, cockpitMap: { ownPosition: () => pos }, directTo: vi.fn(async () => ({ ok: true })) });

    it('lists the next waypoint first, then those ahead, then those passed', () => {
        const rt = mk(); rt.directTo(rt._waypoints[2], { lat: 34.5, lon: -80.8 });
        const p = new DirectToPanel(app(rt), nasr); p.open();
        const ids = [...document.querySelectorAll('.dto-row-id')].map((e) => e.textContent);
        expect(ids).toEqual(['W2', 'KDST', 'W1', 'KLKR']);
        expect(document.querySelector('.dto-row.is-next .dto-row-dist').textContent).toMatch(/^NEXT · \d+ nm$/);
        expect(document.querySelectorAll('.dto-row.is-passed')).toHaveLength(2);
    });

    it('tapping a row flies direct to that route waypoint and closes', async () => {
        const rt = mk(); const a = app(rt); const p = new DirectToPanel(a, nasr); p.open();
        document.querySelectorAll('.dto-row')[1].click();
        await vi.waitFor(() => expect(a.directTo).toHaveBeenCalledWith(rt._waypoints[2]));
        await vi.waitFor(() => expect(p.isOpen()).toBe(false));
    });

    it('an identifier: airport (also without K), navaid or fix; one on the route is that waypoint', async () => {
        expect(await DirectToPanel.lookup(nasr, 'CDN')).toMatchObject({ icao: 'KCDN', type: 'APT', lat: 34.28 });
        expect(await DirectToPanel.lookup(nasr, 'CAE')).toMatchObject({ icao: 'CAE', lat: 33.86 });
        expect((await DirectToPanel.lookup(nasr, 'GREAT')).type).toBeUndefined();
        expect(await DirectToPanel.lookup(nasr, 'ZZZZZ')).toBeNull();
        const rt = mk(); const a = app(rt); const p = new DirectToPanel(a, nasr); p.open();
        document.querySelector('.dto-input').value = 'w2';
        document.querySelector('.dto-go').click();
        await vi.waitFor(() => expect(a.directTo).toHaveBeenCalledWith(rt._waypoints[2]));
    });

    it('an identifier not found: says so, nothing changes', async () => {
        const rt = mk(); const a = app(rt); const p = new DirectToPanel(a, nasr); p.open();
        document.querySelector('.dto-input').value = 'ZZZZZ';
        document.querySelector('.dto-go').click();
        await vi.waitFor(() => expect(document.querySelector('.dto-msg').textContent).toMatch(/ZZZZZ not found/));
        expect(a.directTo).not.toHaveBeenCalled();
    });

    it('no GPS fix: says so on opening, and a tap changes nothing', async () => {
        const rt = mk(); const a = app(rt, null); const p = new DirectToPanel(a, nasr); p.open();
        expect(document.querySelector('.dto-msg').textContent).toBe('No GPS position — direct-to needs a fix');
        document.querySelectorAll('.dto-row')[0].click();
        await new Promise((r) => setTimeout(r, 0));
        expect(a.directTo).not.toHaveBeenCalled();
    });

    it('route ids and names are text, not HTML', () => {
        const rt = mk([W('KLKR', DEP, 'APT'), { icao: '<img src=x>', name: '<b>x</b>', lat: 34, lon: -80.5 }]);
        const p = new DirectToPanel(app(rt), nasr); p.open();
        expect(document.querySelector('.dto-list img')).toBeNull();
        expect(document.querySelector('.dto-list b')).toBeNull();
    });
});

describe('app.directTo', () => {
    const appWith = (rt, pos) => { const a = Object.create(FlyTabApp.prototype); a.routeTable = rt; a.cockpitMap = { ownPosition: () => pos }; return a; };

    it('no GPS fix: refused, the route is unchanged', async () => {
        const rt = mk(); const a = appWith(rt, null);
        expect(await a.directTo(rt._waypoints[2])).toEqual({ ok: false, msg: 'No GPS position — direct-to needs a fix' });
        expect(rt._activeIndex).toBe(1);
    });

    it('no route: a two-point route from the present position, then direct to the target', async () => {
        const rt = Object.create(RouteTable.prototype); rt._waypoints = []; tables.push(rt);
        const a = appWith(rt, { lat: 34.6, lon: -80.85 });
        a.applyRouteEdit = vi.fn(async (plan) => {                    // as _applyPlan -> routeTable.loadPlan
            const t = mk(plan.waypoints.map((w) => ({ ...w })));
            Object.assign(rt, t, { _waypoints: t._waypoints });
            ActiveRoute.setPlan({ waypoints: rt._waypoints });
            rt._activeIndex = 1;
        });
        const r = await a.directTo({ icao: 'KCDN', name: 'Woodward Fld', type: 'APT', lat: 34.28, lon: -80.56 });
        expect(r.ok).toBe(true);
        const plan = a.applyRouteEdit.mock.calls[0][0];
        expect(plan.waypoints.map((w) => w.icao)).toEqual(['PPOS', 'KCDN']);
        expect(plan.waypoints[0]).toMatchObject({ lat: 34.6, lon: -80.85 });
        expect(ActiveRoute.getIndex()).toBe(1);
        expect(ActiveRoute.getLegOrigin()).toEqual({ lat: 34.6, lon: -80.85 });
    });
});
