/**
 * Route planner: REV (reverse the route) and DEP/DEST edits that count.
 *
 * Reported by Dana after a flight (2026-10-15): flew KLKR -> KCDN, then at
 * KCDN there was no way to reverse the route, and retyping DEP/DEST did not
 * update the route view. Reproduced in Chromium with touch taps: Apply runs on
 * touchend, before the field being typed in loses focus and commits, so Apply
 * sent KCDN -> KCDN; a second Apply tap sent KCDN -> KLKR. REV was lost when
 * route-editor.js was deleted (f536a5e); route-table.js's _reverseRoute had no
 * caller since.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = vi.fn((el, fn) => el && el.addEventListener && el.addEventListener('pointerup', fn));
globalThis.DiagLog = globalThis.DiagLog || { log: vi.fn() };
const RoutePlannerPanel = new Function(read('web/cockpit/route-planner-panel.js') + '\nreturn RoutePlannerPanel;')();

const P = (id, type, extra = {}) => ({ id, type, ...extra });
const show = (route) => route.map((r) => `${r.id}:${r.type}${r.airway ? '/' + r.airway : ''}${r.proc ? '!' : ''}`).join(' ');

function panel(route = []) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const p = new RoutePlannerPanel(el, null, null);
    p._depInput = document.createElement('input');
    p._destInput = document.createElement('input');
    p._route = route.map((r) => ({ ...r }));
    p._insertIndex = null;
    p._render = vi.fn();
    return p;
}

describe('RoutePlannerPanel.reversePills', () => {
    it('two airports: swapped', () => {
        expect(show(RoutePlannerPanel.reversePills([P('KLKR', 'dep'), P('KCDN', 'dest')]))).toBe('KCDN:dep KLKR:dest');
    });

    it('airways: each leg keeps its airway, tokens only where the airway changes', () => {
        // KLKR DIRECT CLT V37 AAA BBB SPA V54 XXX KCDN, tagged as _loadPlan tags it
        const route = [
            P('KLKR', 'dep'), P('DIRECT', 'direct'), P('CLT', 'fix'),
            P('V37', 'awy'), P('AAA', 'fix', { airway: 'V37' }), P('BBB', 'fix', { airway: 'V37' }), P('SPA', 'fix', { airway: 'V37' }),
            P('V54', 'awy'), P('XXX', 'fix', { airway: 'V54' }), P('KCDN', 'dest'),
        ];
        expect(show(RoutePlannerPanel.reversePills(route))).toBe(
            'KCDN:dep XXX:fix V54:awy SPA:fix/V54 V37:awy BBB:fix/V37 AAA:fix/V37 CLT:fix/V37 DIRECT:direct KLKR:dest');
    });

    it('an airway leg into the destination stays labelled', () => {
        const route = [P('KAAA', 'dep'), P('V1', 'awy'), P('FIX1', 'fix', { airway: 'V1' }), P('KBBB', 'dest')];
        // edge FIX1 -> KBBB is direct (dest untagged); KAAA -> FIX1 is V1
        expect(show(RoutePlannerPanel.reversePills(route))).toBe('KBBB:dep FIX1:fix V1:awy KAAA:dest/V1');
    });

    it('approach fixes for the old destination are dropped: missed approach after it, and marked ones before it', () => {
        const route = [
            P('KLKR', 'dep'), P('CLT', 'fix'),
            P('IAF1', 'fix', { proc: true, altFt: 3000 }), P('RW05', 'fix', { proc: true }),
            P('KCDN', 'dest'), P('MAP1', 'fix', { proc: true }), P('HOLD1', 'fix'),
        ];
        expect(show(RoutePlannerPanel.reversePills(route))).toBe('KCDN:dep CLT:fix KLKR:dest');
    });

    it('a fuel stop and a pilot altitude stay on their waypoint', () => {
        const route = [P('KLKR', 'dep'), P('KFUE', 'fuel'), P('CLT', 'fix', { altFt: 6500 }), P('KCDN', 'dest')];
        const out = RoutePlannerPanel.reversePills(route);
        expect(show(out)).toBe('KCDN:dep CLT:fix KFUE:fuel KLKR:dest');
        expect(out[1].altFt).toBe(6500);
    });

    it('fewer than two points: nothing to reverse', () => {
        expect(RoutePlannerPanel.reversePills([P('KCDN', 'dest')])).toBeNull();
        expect(RoutePlannerPanel.reversePills([])).toBeNull();
    });

    it('the input route is not modified', () => {
        const route = [P('KLKR', 'dep'), P('V1', 'awy'), P('FIX1', 'fix', { airway: 'V1' }), P('KCDN', 'dest')];
        const before = JSON.stringify(route);
        RoutePlannerPanel.reversePills(route);
        expect(JSON.stringify(route)).toBe(before);
    });
});

describe('REV in the planner', () => {
    it('UNDO after the planner was closed still puts the route back (review, 2026-10-16)', async () => {
        globalThis.app = { showToast: vi.fn(() => ({ remove() {} })) };
        const p = panel([P('KLKR', 'dep'), P('FIX1', 'fix'), P('KCDN', 'dest')]);
        p._depInput.value = 'KLKR';
        p._destInput.value = 'KCDN';
        const applied = [];
        p._doApply = vi.fn(async () => { if (p._applyAborted) return false; applied.push(show(p._route)); return true; });
        p._toast = vi.fn();
        await p._onReverseTap();
        p.close();                                                   // closed before UNDO
        const [, actions] = app.showToast.mock.calls[0];
        await actions[0].action();
        expect(applied).toEqual(['KCDN:dep FIX1:fix KLKR:dest', 'KLKR:dep FIX1:fix KCDN:dest']);
        expect(p._applyAborted).toBe(true);                          // still closed
    });


    it('reverses the pills, updates DEP/DEST, applies, and says what it did; UNDO puts it back', async () => {
        globalThis.app = { showToast: vi.fn(() => ({ remove() {} })) };
        const p = panel([P('KLKR', 'dep'), P('V1', 'awy'), P('FIX1', 'fix', { airway: 'V1' }), P('KCDN', 'dest')]);
        p._depInput.value = 'KLKR';
        p._destInput.value = 'KCDN';
        p._doApply = vi.fn(async () => true);
        p._toast = vi.fn();
        await p._onReverseTap();
        expect(show(p._route)).toBe('KCDN:dep FIX1:fix V1:awy KLKR:dest/V1');
        expect([p._depInput.value, p._destInput.value]).toEqual(['KCDN', 'KLKR']);
        expect(p._doApply).toHaveBeenCalledTimes(1);
        const [msg, actions] = app.showToast.mock.calls[0];
        expect(msg).toMatch(/KCDN.*KLKR/);
        await actions[0].action();                                   // UNDO
        expect(show(p._route)).toBe('KLKR:dep V1:awy FIX1:fix/V1 KCDN:dest');
        expect([p._depInput.value, p._destInput.value]).toEqual(['KLKR', 'KCDN']);
        expect(p._doApply).toHaveBeenCalledTimes(2);                 // re-applied
    });

    it('nothing to reverse: a message, no apply', async () => {
        const p = panel([P('KCDN', 'dest')]);
        p._doApply = vi.fn(async () => true);
        p._toast = vi.fn();
        await p._onReverseTap();
        expect(p._doApply).not.toHaveBeenCalled();
        expect(p._toast).toHaveBeenCalled();
    });

    it('insertApproach marks the procedure fixes it adds', () => {
        const p = panel([P('KLKR', 'dep'), P('KCDN', 'dest')]);
        p.insertApproach({
            icao: 'KCDN',
            insertBefore: [{ icao: 'IAF1', lat: 34.3, lon: -80.6, alt: 3000 }],
            insertAfter: [{ icao: 'MAP1', lat: 34.2, lon: -80.5 }],
            airportWp: null,
        });
        expect(show(p._route)).toBe('KLKR:dep IAF1:fix! KCDN:dest MAP1:fix!');
    });

    it('the procedure mark survives Apply and a reload of the applied plan', async () => {
        const p = panel([P('KLKR', 'dep'), P('IAF1', 'fix', { proc: true }), P('KCDN', 'dest')]);
        p._coords = { KLKR: { lat: 34.7, lon: -80.8 }, IAF1: { lat: 34.3, lon: -80.6 }, KCDN: { lat: 34.3, lon: -80.6 } };
        const wps = await p._pillsToWaypoints();
        expect(wps.map((w) => !!w.proc)).toEqual([false, true, false]);
        const q = panel();
        q._loadPlan({ departure: 'KLKR', destination: 'KCDN', waypoints: wps, flight_plan: { route: ['KLKR', 'IAF1', 'KCDN'], destination: 'KCDN' } });
        expect(show(q._route)).toBe('KLKR:dep IAF1:fix! KCDN:dest');
    });
});

describe('DEP/DEST typed but not yet committed', () => {
    const typed = (input, v) => { input.value = v; input.dispatchEvent(new Event('input')); };

    function wired(route) {
        const p = panel(route);
        p._wireFieldEdits();
        return p;
    }

    it('commit takes a field the pilot typed in, before the action runs', () => {
        const p = wired([P('KLKR', 'dep'), P('KCDN', 'dest')]);
        p._depInput.value = 'KLKR'; p._destInput.value = 'KCDN';
        typed(p._depInput, 'kcdn');
        typed(p._destInput, 'KLKR');
        p._commitFieldEdits();
        expect(show(p._route)).toBe('KCDN:dep KLKR:dest');
    });

    it('the change event that follows (field loses focus) changes nothing more', () => {
        const p = wired([P('KLKR', 'dep'), P('V1', 'awy'), P('FIX1', 'fix', { airway: 'V1' }), P('KCDN', 'dest', { altFt: 2000 })]);
        p._depInput.value = 'KLKR'; p._destInput.value = 'KCDN';
        typed(p._destInput, 'KXYZ');
        p._commitFieldEdits();
        const after = show(p._route);
        p._render.mockClear();
        p._destInput.dispatchEvent(new Event('change'));
        expect(show(p._route)).toBe(after);
        expect(p._render).not.toHaveBeenCalled();
    });

    it('a field the pilot did not touch is left alone (no stale text brought back)', () => {
        const p = wired([P('KLKR', 'dep'), P('KCDN', 'dest')]);
        p._depInput.value = 'KOLD'; p._destInput.value = 'KCDN';   // set by code, not typed
        p._commitFieldEdits();
        expect(show(p._route)).toBe('KLKR:dep KCDN:dest');
    });

    it('a change event without a commit still works as before (typing then tapping elsewhere)', () => {
        const p = wired([P('KLKR', 'dep'), P('KCDN', 'dest')]);
        typed(p._destInput, 'KXYZ');
        p._destInput.dispatchEvent(new Event('change'));
        expect(show(p._route)).toBe('KLKR:dep KXYZ:dest');
    });

    it('every toolbar button commits typed fields before its action', () => {
        const src = read('web/cockpit/route-planner-panel.js');
        const toolbar = src.slice(src.indexOf('    _buildToolbar() {'), src.indexOf('    async _onSaveTap() {'));
        expect(toolbar).toMatch(/wireTap\(btn, \(e\) => \{ this\._commitFieldEdits\(\); handler\(e\); \}\)/);
    });
});

describe('REV on the route table', () => {
    it('the handle has a REV button that reverses the active route through the app', () => {
        const src = read('web/cockpit/route-table.js');
        expect(src).toMatch(/<button class="route-table-edit-btn rt-rev-btn"[^>]*>REV<\/button>/);
        expect(src).toMatch(/wireTap\(this\._revBtn, \(\) => \{[^}]*app\.reverseActiveRoute\(\)/);
    });
});

// ── Critical review of the REV change (2026-10-15) ────────────────────────────
describe('REV review fixes', () => {
    const W = (icao, lat, lon, extra = {}) => ({ icao, name: icao, lat, lon, ...extra });
    let appStub;
    beforeEach(() => {
        appStub = {
            applyRouteEdit: vi.fn(async (plan) => { appStub._currentTrip = plan; }),
            showToast: vi.fn(() => ({ remove() {} })),
            _currentTrip: null,
        };
        globalThis.app = appStub;
        vi.spyOn(RoutePlannerPanel.prototype, '_saveCurrentTrip').mockResolvedValue(undefined);
    });

    const trip = () => ({
        departure: 'KLKR', destination: 'KCDN',
        waypoints: [W('KLKR', 34.72, -80.85), W('KCDN', 34.28, -80.56, { isDest: true })],
        flight_plan: { departure: 'KLKR', destination: 'KCDN', route: ['KLKR', 'KCDN'] },
    });

    it('H1: the route-table REV never touches the planner the pilot may have open', async () => {
        const p = panel([P('KAAA', 'dep'), P('KBBB', 'dest')]);       // what the pilot is looking at
        let release;
        appStub.applyRouteEdit = vi.fn(() => new Promise((r) => { release = r; }));
        const pending = p.reverseAndApply(trip());
        // the pilot opens the planner / Direct-To while REV is still applying
        await new Promise((r) => setTimeout(r, 0));
        p._route = [P('KXYZ', 'dep'), P('KQQQ', 'dest')];
        release();
        const r = await pending;
        expect(r).toEqual({ dep: 'KCDN', dest: 'KLKR' });
        const applied = appStub.applyRouteEdit.mock.calls[0][0];
        expect([applied.departure, applied.destination]).toEqual(['KCDN', 'KLKR']);
        expect(show(p._route)).toBe('KXYZ:dep KQQQ:dest');            // not emptied, not replaced
        expect(p._applyAborted).not.toBe(true);
    });

    it('H2: an en-route fix sharing its name with an approach fix survives a reload and REV', () => {
        const q = panel();
        q._loadPlan({
            departure: 'KA', destination: 'KB',
            waypoints: [W('KA', 35, -81), W('SPA', 35.1, -81.1, { airway: 'V1' }), W('SPA', 35.2, -81.2, { proc: true, altFt: 3000 }),
                        W('FAF', 35.3, -81.3, { proc: true }), W('KB', 35.4, -81.4, { isDest: true }), W('SPA', 35.1, -81.1, { proc: true })],
            flight_plan: { destination: 'KB', route: ['KA', 'V1', 'SPA', 'SPA', 'FAF', 'KB', 'SPA'] },
        });
        // The approach fixes are not on V1: the saved waypoints say so (they were tagged V1
        // by the reload carrying the airway forward, until 2026-10-16).
        expect(show(q._route)).toBe('KA:dep V1:awy SPA:fix/V1 SPA:fix! FAF:fix! KB:dest SPA:fix!');
        expect(q._route[2].altFt).toBeUndefined();                     // the approach's 3000 ft stays on the approach fix
        expect(q._route[3].altFt).toBe(3000);
        expect(show(RoutePlannerPanel.reversePills(q._route))).toBe('KB:dep SPA:fix V1:awy KA:dest/V1');
    });

    it('M1: REV offers UNDO, which restores the exact previous route', async () => {
        const before = trip();
        appStub._currentTrip = before;
        const p = panel();
        await p.reverseAndApply(before);
        const call = appStub.showToast.mock.calls.find(([, actions]) => Array.isArray(actions) && actions.length);
        expect(call[0]).toMatch(/KCDN.*KLKR/);
        expect(call[1][0].label).toBe('UNDO');
        appStub.applyRouteEdit.mockClear();
        await call[1][0].action();
        expect(appStub.applyRouteEdit).toHaveBeenCalledTimes(1);
        expect(appStub.applyRouteEdit.mock.calls[0][0]).toEqual(before);
    });

    it('M2: after Apply (and REV), the planner\'s plan is the applied route', async () => {
        const p = panel([P('KLKR', 'dep'), P('KCDN', 'dest')]);
        p._coords = { KLKR: { lat: 34.72, lon: -80.85 }, KCDN: { lat: 34.28, lon: -80.56 } };
        p._toast = vi.fn();
        await p._doApply();
        expect(p._lastPlan.waypoints.map((w) => w.id)).toEqual(['KLKR', 'KCDN']);
        await p._onReverseTap();
        expect(p._lastPlan.departure).toBe('KCDN');
        expect(p._lastPlan.waypoints.map((w) => w.id)).toEqual(['KCDN', 'KLKR']);
    });

    it('M3: a route-table edit keeps the approach mark', () => {
        const RouteTable = new Function(read('web/cockpit/route-table.js') + '\nreturn RouteTable;')();
        const t = Object.create(RouteTable.prototype);
        let emitted = null;
        t._onRouteChanged = (plan) => { emitted = plan; };
        t._waypoints = [W('KA', 35, -81), W('IAF1', 35.1, -81.1, { proc: true }), W('KB', 35.2, -81.2, { isDest: true })];
        t._flights = [];
        t._emitRouteChange();
        expect(emitted.waypoints.map((w) => !!w.proc)).toEqual([false, true, false]);
    });

    it('L1: the fuel-stop buttons commit typed DEP/DEST first', () => {
        const src = read('web/cockpit/route-planner-panel.js');
        const block = src.slice(src.indexOf("[2.0, 2.5, 3.0].forEach"), src.indexOf("legGroup.appendChild(legLbl)"));
        expect(block).toMatch(/wireTap\(btn, \(\) => \{\s*this\._commitFieldEdits\(\);/);
    });

    it('L4: route-table REV warnings (e.g. a waypoint not found) reach the pilot', async () => {
        const p = panel();
        const t = trip();
        t.waypoints[0] = { icao: 'ZZZZZ', name: 'ZZZZZ' };              // no coords, no NASR
        t.flight_plan.route = ['ZZZZZ', 'KCDN'];
        await p.reverseAndApply(t);
        expect(appStub.showToast.mock.calls.map((c) => c[0]).join(' | ')).toMatch(/ZZZZZ/);
    });

    it('L5: REV while another route change is still applying waits instead of racing', async () => {
        const appSrc = read('web/app.js');
        const s = appSrc.indexOf('    async reverseActiveRoute() {');
        const body = appSrc.slice(s, appSrc.indexOf('\n    }\n', s));
        expect(body).toMatch(/this\._applyingPlan|this\._pendingPlanEdit/);
    });
});
