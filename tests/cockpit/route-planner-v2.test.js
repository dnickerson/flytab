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

    it('an airway leg across a gap is not expanded along the airway (stays straight, flagged)', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'URIVE', type: 'fix' }, { id: 'V157', type: 'awy' }, { id: 'FOGSO', type: 'fix' }, { id: 'KTMB', type: 'dest' }]);
        const v157 = nasr.airways.find((a) => a.name === 'V157').waypoints;
        for (const n of ['Urive', 'Fogso']) { const w = v157.find((x) => x.name === n); p._coords[n.toUpperCase()] = { lat: w.lat, lon: w.lon }; }
        p._coords.KTMB = { lat: 25.648, lon: -80.433 };
        const ids = (await p._pillsToWaypoints()).map((w) => w.id);
        expect(ids).toEqual(['KLKR', 'URIVE', 'FOGSO', 'KTMB']);
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
        const applied = p._doApply = vi.fn(async () => false);
        p._askApplyAnyway = vi.fn(async () => false);
        await p._onApplyKeepOpenTap();
        expect(p._askApplyAnyway).toHaveBeenCalled();
        expect(applied).not.toHaveBeenCalled();
        p._askApplyAnyway = vi.fn(async () => true);
        await p._onApplyKeepOpenTap();
        expect(applied).toHaveBeenCalledTimes(1);
    });

    it('no red problems: Apply goes straight through', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const applied = p._doApply = vi.fn(async () => false);
        p._askApplyAnyway = vi.fn(async () => true);
        await p._onApplyKeepOpenTap();
        expect(p._askApplyAnyway).not.toHaveBeenCalled();
        expect(applied).toHaveBeenCalledTimes(1);
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

describe('Route Planner (preview): search, clearance, procedures, flights (2026-10-16)', () => {
    beforeEach(() => { localStorage.clear(); globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn() }; });

    it('search: a name or city finds the identifier, nearest first; tapping it adds it before the destination', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KAIK', type: 'dest' }]);
        // "Camden" matches airports across the US; the one near us must come first.
        p._nasrDb = { ...nasrDb, _getAll: vi.fn(async () => [
            { icao: '71NJ', name: '76Ers Camden', city: 'Camden', state: 'NJ', lat: 39.9, lon: -75.1 },
            { icao: 'K61A', name: 'Camden Muni', city: 'Camden', state: 'AL', lat: 31.98, lon: -87.3 },
            { icao: 'KCDN', name: 'Woodward Fld', city: 'Camden', state: 'SC', lat: 34.28, lon: -80.56 },
            { icao: 'KLKR', name: 'Lancaster County', city: 'Lancaster', state: 'SC', lat: 34.72, lon: -80.85 },
        ]), searchAllExtended: vi.fn(async () => ({ airports: [], navaids: [], fixes: [] })) };
        p._searchRef = () => ({ lat: 34.72, lon: -80.85 });           // at KLKR
        p._searchInput.value = 'Camden';
        await p._runSearch();
        const rows = [...p._resultsEl.querySelectorAll('.rp2-result')];
        expect(rows.map((r) => r.querySelector('.rp2-result-id').textContent)).toEqual(['KCDN', 'K61A', '71NJ']);
        expect(rows[0].querySelector('.rp2-result-sub').textContent).toMatch(/Camden, SC · 3\d nm/);
        rows[0].click();
        await p._typing;
        expect(show(p)).toBe('KLKR:dep KCDN:airport KAIK:dest');
        expect(p._resultsEl.hidden).toBe(true);
    });

    it('search "Aiken": the airport named Aiken before a private strip that is only in Aiken (tablet data)', async () => {
        const p = make();
        p._nasrDb = { ...nasrDb, _getAll: vi.fn(async () => [
            { icao: '4SC7', name: 'Wexford Landing', city: 'Aiken', state: 'SC', lat: 33.6, lon: -81.7, has_paved_rwy: false },
            { icao: 'KAIK', name: 'Aiken Rgnl', city: 'Aiken', state: 'SC', lat: 33.649, lon: -81.685, has_paved_rwy: true },
            { icao: 'SC67', name: 'Polecat Aerodrome', city: 'Aiken', state: 'SC', lat: 33.5, lon: -81.6 },
        ]), searchAllExtended: vi.fn(async () => ({ airports: [], navaids: [], fixes: [] })) };
        p._searchRef = () => ({ lat: 34.72, lon: -80.85 });
        p._searchInput.value = 'Aiken';
        await p._runSearch();
        expect([...p._resultsEl.querySelectorAll('.rp2-result-id')].map((e) => e.textContent)[0]).toBe('KAIK');
    });

    it('search: an identifier match comes before name matches', async () => {
        const p = make();
        p._nasrDb = { ...nasrDb, _getAll: vi.fn(async () => [
            { icao: 'KCDN', name: 'Woodward Fld', city: 'Camden', state: 'SC', lat: 34.28, lon: -80.56 },
            { icao: 'XCDN', name: 'Cdn Field', city: 'Far', state: 'AK', lat: 61, lon: -150 },
        ]), searchAllExtended: vi.fn(async () => ({ airports: [], navaids: [], fixes: [] })) };
        p._searchRef = () => ({ lat: 61, lon: -150 });
        p._searchInput.value = 'CDN';
        await p._runSearch();
        expect([...p._resultsEl.querySelectorAll('.rp2-result-id')].map((e) => e.textContent)).toEqual(['KCDN', 'XCDN']);
    });

    it('clearance: the C field as the app fills it ("KAIK — AIKEN RGNL") gives KAIK', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KCDN', type: 'dest' }]);
        await p.loadClearance({ limit: 'KAIK — AIKEN RGNL', route: 'CAYCE' });
        expect(show(p)).toBe('KLKR:dep CAYCE:fix KAIK:dest');
    });

    it('clearance: C becomes the destination (AIK -> KAIK), R the route in order, DIRECT dropped', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KCDN', type: 'dest' }]);
        await p.loadClearance({ limit: 'AIK', route: 'MITVE T437 CAYCE DIRECT' });
        expect(show(p)).toBe('KLKR:dep MITVE:fix T437:awy CAYCE:fix KAIK:dest');
    });

    it('clearance "as filed": only the destination changes', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'KCDN', type: 'dest' }]);
        await p.loadClearance({ limit: 'KAIK', route: 'AS FILED' });
        expect(show(p)).toBe('KLKR:dep GREAT:fix KAIK:dest');
    });

    it('approach names: CIFP codes in plain words, code kept', () => {
        expect(RoutePlannerV2.procLabel('R07', 'APPROACH')).toBe('RNAV (GPS) 07 (R07)');
        expect(RoutePlannerV2.procLabel('I07', 'APPROACH')).toBe('ILS 07 (I07)');
        expect(RoutePlannerV2.procLabel('R25-Y', 'APPROACH')).toBe('RNAV (GPS) 25 Y (R25-Y)');
        expect(RoutePlannerV2.procLabel('VDM-A', 'APPROACH')).toBe('VDM-A');      // unknown form: as is
        expect(RoutePlannerV2.procLabel('CHATT6', 'STAR')).toBe('CHATT6');
    });

    it('destination bubble: approaches and arrivals listed; a transition loads the procedure', async () => {
        const loaded = [];
        globalThis.app.approachCharts = {
            proceduresFor: vi.fn(async () => ({ key: 'KAIK', loaded: true, procs: [
                { name: 'R07', type: 'APPROACH', transitions: ['HIBID', 'VIXLY'] },
                { name: 'CHATT6', type: 'SID', transitions: ['ALL'] },
            ] })),
            loadProcedure: vi.fn((...a) => loaded.push(a)),
        };
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KAIK', type: 'dest' }]);
        await p._openProcedures(1);
        const labels = () => [...p._sheetEl.querySelectorAll('.rp2-act')].map((b) => b.textContent);
        expect(labels()).toEqual(['RNAV (GPS) 07 (R07)']);                   // departures (SID) not offered
        p._sheetEl.querySelector('.rp2-act').click();
        await new Promise((r) => setTimeout(r, 0));
        expect(labels()).toEqual(['Via HIBID', 'Via VIXLY', 'Vectors (no transition)']);
        [...p._sheetEl.querySelectorAll('.rp2-act')][1].click();
        await new Promise((r) => setTimeout(r, 0));
        expect(loaded).toEqual([['KAIK', 'R07', 'VIXLY']]);
    });

    it('flights: one row per flight with landing time and fuel', () => {
        const c = {
            legs: [{ timeHrs: 1.0, eta: 3_600_000, fuelRemGal: 26 }, { timeHrs: 0.8, eta: 8_280_000, fuelRemGal: 18 }, { timeHrs: 0.5, eta: 11_880_000, fuelRemGal: 30 }],
            waypoints: [{ id: 'KLKR' }, { id: 'X' }, { id: 'KCRG', fuelStop: true }, { id: 'KTMB', isDest: true }],
        };
        expect(RoutePlannerV2.flightsOf(c)).toEqual([
            { from: 'KLKR', to: 'KCRG', hrs: 1.8, landMs: 8_280_000, landGal: 18 },
            { from: 'KCRG', to: 'KTMB', hrs: 0.5, landMs: 11_880_000, landGal: 30 },
        ]);
    });

    it('"Fuel stop near here…": avgas airports near that bubble; the chosen one goes there', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'CAE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._planner = { _adapters: { aero: { nearestAirports: vi.fn(async () => [
            { icao: 'KCUB', name: 'Columbia Owens', lat: 33.97, lon: -80.99, hasFuel: true },
            { icao: 'XJET', name: 'Jet-A only', lat: 33.86, lon: -81.05, hasFuel: false },
        ]) } } };
        p._compute = vi.fn(async () => null);
        let offered = null;
        p._showFuelStopPicker = vi.fn(async (cand) => { offered = cand.options.map((o) => o.icao); return cand.options[0]; });
        p._runChecks = vi.fn(async () => (p._problems = []));
        await p._fuelStopNear(1);
        expect(offered).toEqual(['KCUB']);
        expect(show(p)).toBe('KLKR:dep CAE:fix KCUB:fuel KAIK:dest');
    });

    it('a procedure loaded while the preview is open goes to the preview', () => {
        const src = read('web/app.js');
        expect(src).toMatch(/classList\.contains\('route-preview'\)\) \{\s*this\.routePlannerPreview\.insertApproach\(e\.detail\);/);
    });
});

describe('Route Planner (preview): Insert before/after (Dana, 2026-10-16)', () => {
    beforeEach(() => { globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn() }; });

    it('sheet buttons cancel the follow-on mouse events (else focus leaves the route field after Insert after…)', () => {
        const src = read('web/cockpit/route-planner-v2.js');
        const sheet = src.slice(src.indexOf('    _openSheet(title, rows) {'), src.indexOf('    _closeSheet() {'));
        expect(sheet).toMatch(/wireIsolatedTap/);
    });

    it('Insert after… puts the cursor there, focused, and says where the text goes', () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'CAE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._startInsert(2);
        expect(document.activeElement).toBe(p._inputEl);
        expect(p._inputEl.nextElementSibling.textContent).toBe('✓ Done');
        expect(p._inputEl.nextElementSibling.nextElementSibling.textContent).toBe('KAIK');
        expect(p._inputEl.placeholder).toBe('insert after CAE');
        p._insertIndex = null; p._render();
        expect(p._inputEl.placeholder).toBe('type');
    });
});

describe('Route Planner (preview): tapping a bubble centres the map (Dana, 2026-10-16)', () => {
    it('a point bubble: the map centres on it; an airway bubble: its segment is fitted', async () => {
        const showPoint = vi.fn(), showBounds = vi.fn();
        globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn(), cockpitMap: { showPoint, showBounds } };
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        await p._showOnMap(1);
        expect(showPoint).toHaveBeenCalledWith(GREAT.lat, GREAT.lon);
        await p._showOnMap(2);
        const [[a, b]] = showBounds.mock.calls;
        expect([a.lat, a.lon]).toEqual([GREAT.lat, GREAT.lon]);
        expect(b.lat).toBeCloseTo(33.857, 2);                        // CAYCE
    });

    it('tapping a bubble shows it on the map and opens its actions', () => {
        const src = read('web/cockpit/route-planner-v2.js');
        expect(src).toMatch(/wireTap\(b, async \(\) => \{ await this\._commitTyped\(\); this\._showOnMap\(idx\); this\._openBubbleSheet\(idx\); \}\);/);
    });
});


describe('Route Planner (preview): finishing an insert (Dana, 2026-10-16)', () => {
    beforeEach(() => { globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn() }; });
    const enter = (p) => p._inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    it('Done (Enter) adds what was typed at the insert point, then ends inserting and closes the keyboard', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'CAE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        p._startInsert(2);
        p._inputEl.value = 'BRADO MATEO';
        enter(p);
        await p._typing;
        expect(show(p)).toBe('KLKR:dep CAE:fix BRADO:fix MATEO:fix KAIK:dest');
        expect(p._insertIndex).toBeNull();
        expect(document.activeElement).not.toBe(p._inputEl);
        expect(p._inputEl.placeholder).toBe('type');
        expect(p._inputEl.nextElementSibling.textContent).toBe('KAIK');      // back before the destination
    });

    it('a ✓ Done button is shown while inserting, and does the same', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'CAE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        expect(p._bubblesEl.querySelector('.rp2-insert-done')).toBeNull();
        p._startInsert(2);
        const done = p._bubblesEl.querySelector('.rp2-insert-done');
        expect(done.textContent).toBe('✓ Done');
        p._inputEl.value = 'BRADO';
        done.click();
        await p._typing;
        expect(show(p)).toBe('KLKR:dep CAE:fix BRADO:fix KAIK:dest');
        expect(p._insertIndex).toBeNull();
        expect(p._bubblesEl.querySelector('.rp2-insert-done')).toBeNull();
    });

    it('a toolbar action (e.g. Apply) also ends inserting', () => {
        const src = read('web/cockpit/route-planner-v2.js');
        const tb = src.slice(src.indexOf("        tb.className = 'rp2-toolbar';"), src.indexOf("        inner.appendChild(tb);"));
        expect(tb).toMatch(/await this\._commitTyped\(\); this\._endInsert\(\);/);
    });
});

describe('Route Planner (preview): layout (Dana, 2026-10-16)', () => {
    it('the command buttons sit directly under the route field', () => {
        const p = make();
        const order = [...p._el.querySelector('.rp2-inner').children].map((e) => e.className.split(' ')[0]);
        expect(order.slice(0, 7)).toEqual(['rp2-hdr', 'rp2-search', 'rp2-field', 'rp2-toolbar', 'rp2-problem', 'rp2-grid', 'rp2-stats']);
    });
});

describe('Route Planner (preview): Apply feedback and stale airway tags (Dana, 2026-10-16)', () => {
    beforeEach(() => { localStorage.clear(); });

    it('a fuel stop ends an airway run: fixes after it are not tagged with the airway before it (BRADO was hidden)', () => {
        const q = make();
        q._loadPlan({
            departure: 'KLKR', destination: 'KTMB',
            waypoints: [{ icao: 'KLKR' }, { icao: 'CRG' }, { icao: 'KHEG', fuelStop: true }, { icao: 'BRADO' }, { icao: 'ORL' }, { icao: 'CAMBE' }, { icao: 'KTMB', isDest: true }],
            flight_plan: { destination: 'KTMB', route: ['KLKR', 'V37', 'CRG', 'KHEG', 'BRADO', 'ORL', 'V533', 'CAMBE', 'KTMB'] },
        });
        expect(show(q)).toBe('KLKR:dep V37:awy CRG:fix KHEG:fuel BRADO:fix ORL:fix V533:awy CAMBE:fix KTMB:dest');
        expect(q._route.find((r) => r.id === 'CRG').airway).toBe('V37');
        expect(q._route.find((r) => r.id === 'BRADO').airway).toBeUndefined();
        expect(q._route.find((r) => r.id === 'CAMBE').airway).toBe('V533');
        q._compactView = true;
        q._render();
        expect([...q._bubblesEl.querySelectorAll('.rp2-b')].map((b) => b.textContent)).toContain('BRADO');
    });

    it('stale tags from earlier edits are cleaned on every render, too', () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'V37', type: 'awy' }, { id: 'CRG', type: 'fix', airway: 'V37' }, { id: 'KHEG', type: 'fuel' }, { id: 'BRADO', type: 'fix', airway: 'V37' }, { id: 'KTMB', type: 'dest' }]);
        expect(p._route.find((r) => r.id === 'BRADO').airway).toBeUndefined();
    });

    it('Apply: says so, and shows the whole route on the map', async () => {
        const showPoints = vi.fn();
        globalThis.app = { closeRoutePlanner: vi.fn(), cockpitMap: { showPoints } };
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'GREAT', type: 'fix' }, { id: 'T437', type: 'awy' }, { id: 'CAYCE', type: 'fix' }, { id: 'KAIK', type: 'dest' }]);
        const toast = vi.spyOn(p, '_toast');
        p._routingMode = 't-airways';
        p._doApply = vi.fn(async () => { p._lastPlan = { waypoints: [{ lat: 34.7, lon: -80.8 }, { lat: 34.4, lon: -81.0 }, { lat: 33.6, lon: -81.7 }] }; return true; });
        await p._onApplyKeepOpenTap();
        expect(p._doApply).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls.map((c) => c[0]).join(' | ')).toMatch(/Route applied: KLKR → KAIK \(3 waypoints\)/);
        expect(showPoints).toHaveBeenCalledWith([{ lat: 34.7, lon: -80.8 }, { lat: 34.4, lon: -81.0 }, { lat: 33.6, lon: -81.7 }]);
    });
});

describe('Route Planner (preview): Replace… (Dana, 2026-10-16)', () => {
    beforeEach(() => { localStorage.clear(); globalThis.app = { showToast: vi.fn(() => ({ remove() {} })), closeRoutePlanner: vi.fn() }; });
    const R = () => [{ id: 'KLKR', type: 'dep' }, { id: 'V37', type: 'awy' }, { id: 'CRG', type: 'fix', airway: 'V37' }, { id: 'BRADO', type: 'fix', altFt: 6000 }, { id: 'ORL', type: 'fix' }, { id: 'KTMB', type: 'dest' }];
    const sheetLabels = () => [...document.querySelectorAll('.rp2-act')].map((b) => b.textContent);

    it('the bubble sheet offers Replace…', () => {
        const p = make(R());
        p._openBubbleSheet(3);
        expect(sheetLabels()).toContain('Replace…');
    });

    it('cursor goes in front of the old bubble, which is marked; the field says what it replaces', () => {
        const p = make(R());
        p._startReplace(3);
        expect(document.activeElement).toBe(p._inputEl);
        expect(p._inputEl.placeholder).toBe('replace BRADO');
        const old = p._bubblesEl.querySelector('.rp2-b[data-idx="3"]');
        expect(old.classList.contains('rp2-b-replacing')).toBe(true);
        expect(p._inputEl.nextElementSibling.textContent).toBe('✓ Done');
        expect(p._inputEl.nextElementSibling.nextElementSibling).toBe(old);
    });

    it('the first identifier takes the old one\'s place; more go after it, in order', async () => {
        const p = make(R());
        p._startReplace(3);
        await type(p, 'MATEO DORAL');
        expect(show(p)).toBe('KLKR:dep V37:awy CRG:fix MATEO:fix DORAL:fix ORL:fix KTMB:dest');
        expect(p._route[3].altFt).toBeUndefined();                     // a new fix: no altitude carried over
        expect(p._bubblesEl.querySelector('.rp2-b-replacing')).toBeNull();
        expect(p._inputEl.placeholder).toBe('insert after DORAL');
    });

    it('Done with nothing typed changes nothing', async () => {
        const p = make(R());
        p._startReplace(3);
        await p._finishTyping();
        expect(show(p)).toBe('KLKR:dep V37:awy CRG:fix BRADO:fix ORL:fix KTMB:dest');
        expect(p._route[3].altFt).toBe(6000);
        expect(p._bubblesEl.querySelector('.rp2-b-replacing')).toBeNull();
        expect(p._inputEl.placeholder).toBe('type');
    });

    it('departure and destination keep their role; replacing the destination ends there', async () => {
        const p = make(R());
        p._startReplace(5);
        expect(p._inputEl.placeholder).toBe('replace KTMB');
        await type(p, 'KMIA');
        expect(show(p)).toBe('KLKR:dep V37:awy CRG:fix BRADO:fix ORL:fix KMIA:dest');
        expect(p._insertIndex).toBeNull();
        p._startReplace(0);
        await type(p, 'KCDN');
        expect(show(p).startsWith('KCDN:dep V37:awy')).toBe(true);
    });

    it('an airway cannot replace the departure or destination', async () => {
        const p = make(R());
        p._startReplace(5);
        await type(p, 'V533');
        expect(show(p)).toBe('KLKR:dep V37:awy CRG:fix BRADO:fix ORL:fix KTMB:dest');
        expect(p._inputEl.placeholder).toBe('replace KTMB');          // still replacing
    });

    it('a fuel stop replaced by an airport is still a fuel stop', async () => {
        const p = make([{ id: 'KLKR', type: 'dep' }, { id: 'KCDN', type: 'fuel' }, { id: 'KTMB', type: 'dest' }]);
        p._startReplace(1);
        await type(p, 'KAIK');
        expect(show(p)).toBe('KLKR:dep KAIK:fuel KTMB:dest');
    });

    it('an airway bubble can be replaced by another airway', async () => {
        const p = make(R());
        p._startReplace(1);
        await type(p, 'T437');
        expect(show(p)).toBe('KLKR:dep T437:awy CRG:fix BRADO:fix ORL:fix KTMB:dest');
    });

    it('replacing is dropped if the route changes under it (e.g. Clear, or the bubble is removed)', async () => {
        const p = make(R());
        p._startReplace(3);
        p._removeAt(3);
        expect(p._replacing).toBeNull();
        await type(p, 'MATEO');
        expect(show(p)).toBe('KLKR:dep V37:awy CRG:fix MATEO:fix ORL:fix KTMB:dest');   // an ordinary insert there
    });
});
