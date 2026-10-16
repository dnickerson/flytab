/**
 * Route Planner (preview) -- route-planner-v2.js. Spec:
 * docs/superpowers/specs/2026-10-15-route-planner-redesign-design.md.
 * Real NASR records for T437 & co (tests/fixtures/route-check/nasr-subset.json).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = (el, fn) => el && el.addEventListener && el.addEventListener('click', fn);
globalThis.DiagLog = globalThis.DiagLog || { log: vi.fn() };
globalThis.RouteCheck = new Function(read('web/shared/route-check.js') + '\nreturn RouteCheck;')();
const RoutePlannerV2 = new Function(read('web/cockpit/route-planner-panel.js') + '\n' + read('web/cockpit/route-planner-v2.js') + '\nreturn RoutePlannerV2;')();
const nasr = JSON.parse(read('tests/fixtures/route-check/nasr-subset.json'));
const t437 = (name) => nasr.airways.find((a) => a.name === 'T437').waypoints.find((w) => w.name === name);
const [GREAT, BLOTS, BEFTY] = ['Great', 'Blots', 'Befty'].map(t437);

const nasrDb = {
    async getAirport(id) { const a = nasr.airports.find((x) => x.icao === id); return a ? { ...a, id: a.icao } : null; },
    async getNavaid(id) { return nasr.navaids.find((x) => x.id === id) || null; },
    async getFix(id) { return nasr.fixes.find((x) => x.id === id) || null; },
    async getAirway(name) { return nasr.airways.find((x) => x.name === name) || null; },
};
const show = (p) => p._route.map((r) => `${r.id}:${r.type}`).join(' ');

function make(route = []) {
    document.body.innerHTML = '<div id="pv"></div>';
    const p = new RoutePlannerV2(document.getElementById('pv'), nasrDb, null, null);
    p.init();
    p._route = route.map((r) => ({ ...r }));
    p._render();
    return p;
}
const type = async (p, text) => { p._inputEl.value = text; p._onTyping(); await p._commitTyped(); };

describe('Route Planner (preview): the route field', () => {
    beforeEach(() => { localStorage.clear(); globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn() }; });
    afterEach(() => vi.useRealTimers());

    it("typing the reroute goes in clearance order, before the destination", async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KAIK', type: 'dest' }]);
        await type(p, 'mitve T437 CAYCE ');
        expect(show(p)).toBe('KLKR:dep MITVE:fix T437:awy CAYCE:fix KAIK:dest');
    });

    it('on an empty route the first point is the departure and the next the destination', async () => {
        const p = make();
        await type(p, 'KLKR KAIK');
        expect(show(p)).toBe('KLKR:dep KAIK:dest');
    });

    it('typing after the destination makes a new destination', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KCDN', type: 'dest' }]);
        p._cursorAtEnd = true;
        await type(p, 'KAIK');
        expect(show(p)).toBe('KLKR:dep KCDN:airport KAIK:dest');
    });

    it('Insert after… puts the typed fixes there, in order', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._startInsert(1);
        await type(p, 'MITVE GREAT');
        expect(show(p)).toBe('KLKR:dep MITVE:fix GREAT:fix CAYCE:fix KAIK:dest');
    });

    it('the text cursor is never detached while bubbles are rebuilt (keeps the Android keyboard up)', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KAIK', type: 'dest' }]);
        p._inputEl.focus();
        const removed = vi.fn();
        new MutationObserver((ms) => { for (const m of ms) for (const n of m.removedNodes) if (n === p._inputEl) removed(); })
            .observe(p._bubblesEl, { childList: true });
        await type(p, 'MITVE T437 CAYCE');
        await new Promise((r) => setTimeout(r, 0));
        expect(removed).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(p._inputEl);
        // and it sits just before the destination bubble
        expect(p._inputEl.nextElementSibling.dataset.idx).toBe(String(p._destPillIndex()));
    });

    it('a problem fix from the sheet changes the route (Join T437 at GREAT)', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'MITVE', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const problems = await p._runChecks();
        expect(problems[0].code).toBe('entry-not-on-airway');
        await p._applyFix(problems[0].fixes[0]);
        expect(show(p)).toBe('KLKR:dep MITVE:fix GREAT:fix T437:awy CAYCE:fix KAIK:dest');
        // No red left; the default Routing (V-airways) leaves the amber T-route note.
        expect((await p._runChecks()).map((x) => `${x.severity}:${x.code}`)).toEqual(['amber:airway-type']);
    });
});

describe('Route Planner (preview): airways along the airway', () => {
    it('GREAT T437 CAYCE is expanded into the T437 fixes between them, in NASR order', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const wps = await p._pillsToWaypoints();
        expect(wps.map((w) => w.id)).toEqual(['KLKR', 'GREAT', 'BLOTS', 'BEFTY', 'CAYCE', 'KAIK']);
        expect(wps.slice(2, 5).every((w) => w.airway === 'T437')).toBe(true);
    });

    it('a Victor airway between two VORs is expanded with its fixes, VORs by identifier', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'SAV', type: 'fix' }, { id: 'V37', type: 'awy' }, { id: 'CAE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._coords.SAV = { lat: 32.146268, lon: -81.199106 };
        const ids = (await p._pillsToWaypoints()).map((w) => w.id);
        expect(ids[1]).toBe('SAV');
        expect(ids).toContain('ALD');
        expect(ids.indexOf('CAE')).toBe(ids.length - 2);
        expect(ids.length).toBeGreaterThan(5);
    });

    it('an airway leg whose entry is not on the airway stays straight (and is flagged)', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'MITVE', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const wps = await p._pillsToWaypoints();
        expect(wps.map((w) => w.id)).toEqual(['KLKR', 'MITVE', 'CAYCE', 'KAIK']);
    });
});

describe('Route Planner (preview): Apply', () => {
    beforeEach(() => { globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn() }; });

    it('red problems: Apply asks; "Fix it" does not apply, "Apply anyway" does', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'MITVE', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const applied = vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(p)), '_onApplyKeepOpenTap').mockResolvedValue(undefined);
        p._askApplyAnyway = vi.fn(async () => false);
        await p._onApplyKeepOpenTap();
        expect(p._askApplyAnyway).toHaveBeenCalled();
        expect(applied).not.toHaveBeenCalled();
        p._askApplyAnyway = vi.fn(async () => true);
        await p._onApplyKeepOpenTap();
        expect(applied).toHaveBeenCalledTimes(1);
        applied.mockRestore();
    });

    it('no red problems: Apply goes straight through', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const applied = vi.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(p)), '_onApplyKeepOpenTap').mockResolvedValue(undefined);
        p._askApplyAnyway = vi.fn(async () => true);
        await p._onApplyKeepOpenTap();
        expect(p._askApplyAnyway).not.toHaveBeenCalled();
        expect(applied).toHaveBeenCalledTimes(1);
        applied.mockRestore();
    });

    it('closing the "Apply anyway?" sheet with ✕ means Fix it (Apply does not hang)', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KAIK', type: 'dest' }]);
        const answer = p._askApplyAnyway([{ message: 'x', severity: 'red' }]);
        p._closeSheet();
        await expect(answer).resolves.toBe(false);
    });

    it('settings boxes write the same fields the Settings popup did, and save them', () => {
        const p = make();
        p._g.mode.value = 'any'; p._g.mode.dispatchEvent(new Event('change'));
        p._g.fuel.value = '2.5'; p._g.fuel.dispatchEvent(new Event('change'));
        p._g.alt.value = '7000'; p._g.alt.dispatchEvent(new Event('change'));
        expect([p._routingMode, p._maxLegHrs, p._cruiseAltFt, p._altitude]).toEqual(['any', 2.5, 7000, 7000]);
        const saved = JSON.parse(localStorage.getItem('flypi_planner_opts'));
        expect([saved.routingMode, saved.maxLegHrs, saved.cruiseAltFt]).toEqual(['any', 2.5, 7000]);
    });
});

describe('Route Planner (preview): fuel stops one at a time', () => {
    beforeEach(() => { globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn() }; });

    it('only the first suggestion is offered; the next is worked out again with the stop in', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'CAE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const shown = [];
        p._showFuelStopPicker = vi.fn(async (c) => { shown.push(c.afterFixId); return { icao: 'KCDN', name: 'Camden', lat: 34.28, lon: -80.56 }; });
        p._runChecks = vi.fn(async () => (p._problems = []));          // after the first stop: no longer over the limit
        await p._processFuelStopCandidates({ fuelStopCandidates: [
            { afterFixId: 'KLKR', cumHrsAtStop: 2, options: [] },
            { afterFixId: 'CAE', cumHrsAtStop: 4, options: [] },       // computed without the first stop: not offered
        ] });
        expect(shown).toEqual(['KLKR']);
        expect(show(p)).toBe('KLKR:dep KCDN:fuel CAE:fix KAIK:dest');
    });

    it('a stop after a fix in the middle of an airway: the airway is split there (land, refuel, rejoin)', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._computed = { waypoints: ['KLKR', 'GREAT', 'BLOTS', 'BEFTY', 'CAYCE', 'KAIK'].map((id) => ({ id, ...(id !== 'KLKR' && id !== 'GREAT' && id !== 'KAIK' ? { airway: 'T437' } : {}) })) };
        // an airport right by BLOTS (the T437 fix nearest it)
        p._showFuelStopPicker = vi.fn(async () => ({ icao: 'KCDN', name: 'x', lat: BLOTS.lat + 0.05, lon: BLOTS.lon + 0.05 }));
        p._runChecks = vi.fn(async () => (p._problems = []));
        await p._processFuelStopCandidates({ fuelStopCandidates: [{ afterFixId: 'BLOTS', cumHrsAtStop: 2, options: [] }] });
        expect(show(p)).toBe('KLKR:dep GREAT:fix T437:awy BLOTS:fix KCDN:fuel BLOTS:fix T437:awy CAYCE:fix KAIK:dest');
        // and the route check is happy with it
        const problems = await RouteCheck.run({ pills: p._route, computed: null, settings: { routingMode: 'any' }, aero: p._aero() });
        expect(problems).toEqual([]);
    });

    it('a stop after an airway entry: land there, then rejoin at the entry', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._showFuelStopPicker = vi.fn(async () => ({ icao: 'KCUB', name: 'x', lat: GREAT.lat - 0.02, lon: GREAT.lon }));
        p._runChecks = vi.fn(async () => (p._problems = []));
        await p._processFuelStopCandidates({ fuelStopCandidates: [{ afterFixId: 'GREAT', cumHrsAtStop: 2, options: [] }] });
        expect(show(p)).toBe('KLKR:dep GREAT:fix KCUB:fuel GREAT:fix T437:awy CAYCE:fix KAIK:dest');
    });

    it('an airport well off the airway: leave it -- entry, stop, exit direct (KLKR-KTMB: K2IS off V157)', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'SAV', type: 'fix' }, { id: 'V37', type: 'awy' }, { id: 'CAE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._showFuelStopPicker = vi.fn(async () => ({ icao: 'KCUB', name: 'x', lat: 33.0, lon: -80.5 }));   // ~40 nm east of ALD
        p._runChecks = vi.fn(async () => (p._problems = []));
        await p._processFuelStopCandidates({ fuelStopCandidates: [{ afterFixId: 'SAV', cumHrsAtStop: 2, options: [] }] });
        expect(show(p)).toBe('KLKR:dep SAV:fix KCUB:fuel CAE:fix KAIK:dest');
    });

    it('a stop far down a long airway leg: split at the airway fix nearest the airport, never back to the entry', async () => {
        // KLKR-KTMB put K2IS (150 nm down V157) after LAL and rejoined at LAL: +43 %.
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._computed = { waypoints: [{ id: 'KLKR' }, { id: 'GREAT' }, { id: 'CAYCE', airway: 'T437' }, { id: 'KAIK' }] };   // the leg as the engine sees it
        p._showFuelStopPicker = vi.fn(async () => ({ icao: 'KCUB', name: 'x', lat: BEFTY.lat, lon: BEFTY.lon + 0.1 }));
        p._runChecks = vi.fn(async () => (p._problems = []));
        await p._processFuelStopCandidates({ fuelStopCandidates: [{ afterFixId: 'GREAT', cumHrsAtStop: 2, options: [] }] });
        expect(show(p)).toBe('KLKR:dep GREAT:fix T437:awy BEFTY:fix KCUB:fuel BEFTY:fix T437:awy CAYCE:fix KAIK:dest');
    });
});
