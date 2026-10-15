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
    it('reverses the pills, updates DEP/DEST, applies, and says what it did', async () => {
        const p = panel([P('KLKR', 'dep'), P('KCDN', 'dest')]);
        p._depInput.value = 'KLKR';
        p._destInput.value = 'KCDN';
        p._doApply = vi.fn(async () => true);
        p._toast = vi.fn();
        await p._onReverseTap();
        expect(show(p._route)).toBe('KCDN:dep KLKR:dest');
        expect([p._depInput.value, p._destInput.value]).toEqual(['KCDN', 'KLKR']);
        expect(p._doApply).toHaveBeenCalledTimes(1);
        expect(p._toast.mock.calls[0][0]).toMatch(/KCDN.*KLKR/);
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
