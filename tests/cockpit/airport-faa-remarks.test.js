/**
 * FAA REMARKS in the airport panel's INFO tab (NASR bundle v12, 2026-11-02).
 *
 * The hidden .apt-faa-remarks box between IFR CLEARANCE and MY NOTES is filled after the panel is
 * up from NasrDB.getRemarks(icao): tuples [el, c, text, rwy] in bundle order, small group labels,
 * Contacts and FAA admin behind a tap that shows the count. Remark text is FAA data with '<' and
 * '&' in it: built with textContent only. A read that comes back after the panel moved to another
 * airport is dropped. The load never re-renders or moves the MY NOTES box while it has focus.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
globalThis.wireTap = wireTap;
const { AirportNotes, AirportNoteEditor } = new Function(
    read('web/cockpit/airport-notes.js') + '\nreturn { AirportNotes, AirportNoteEditor };')();
globalThis.AirportNotes = AirportNotes;
globalThis.AirportNoteEditor = AirportNoteEditor;
const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();

// Real tuples, cycle 2026-10-29 (contract), in bundle order.
const SC76_RMK = [
    ['A110-1', 'gen', 'FOR CD CTC CHARLOTTE APCH AT 704-359-0241.', null],
    ['E111', 'admin', 'PRVDD VFR/PR USE.', null],
];
const KLKR_RMK = [
    ['A110-1', 'gen', '25 FT DROP; 250 FT FM THR RWY 06.', null],
    ['A110-2', 'gen', 'DEER ON & INVOF ARPT.', null],
    ['A110-3', 'gen', 'GCO AVBL ON FREQ 121.725 TO CHARLOTTE APCH.', null],
    ['A110-4', 'gen', 'SMALL ACFT MUST BE ON A TIE DOWN.', null],
    ['A110-5', 'gen', 'FOR CD CTC CHARLOTTE APCH AT 704-359-0241.', null],
    ['A110-6', 'gen', 'ARL APPLICATORS NOT PMTD DUE TO PAVEMENT CONDS.', null],
    ['A81-APT', 'ltg', 'ACTVT REIL RWY 06 & 24; MIRL RWY 06/24 - CTAF. PAPI RWY 06 & 24 OPR CONSLY.', null],
    ['A70-FUEL-100LL', 'fuel', 'FOR FUEL AFT HRS CALL 803-285-1513', null],
];
const SC76 = { icao: 'SC76', name: 'UNITY AERODROME', city: 'LANCASTER', state: 'SC', lat: 34.8, lon: -80.7,
    elev_ft: 560, runways: [{ id: '03/21', length_ft: 2600, width_ft: 100, surface: 'TURF' }], frequencies: [] };
const KLKR = { icao: 'KLKR', name: 'LANCASTER CO', lat: 34.72, lon: -80.85, elev_ft: 486, runways: [], frequencies: [] };

let remarks, nasr;

function installFetch() {   // notes: no note for any airport (404)
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, text: async () => 'No note' }));
}
function newPopup(n = nasr) {
    const p = new AirportPopup({ closePopup() {} }, n);
    p.initPanel(document.body);
    return p;
}
async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}

const box = () => document.querySelector('.apt-faa-remarks');
const ta = () => document.querySelector('.apt-notes-text');
const infoPane = () => document.querySelector('.apt-tab-pane[data-pane="info"]');
/** What the pilot sees, group by group: [label, [texts], collapsed?]. */
function shown() {
    return [...box().querySelectorAll('.apt-rmk-group')].map((g) => {
        const body = g.querySelector(':scope > .apt-rmk-body');        // collapsed group (Contacts, FAA admin)
        const toggle = body ? g.querySelector(':scope > .apt-rmk-toggle') : null;
        const label = toggle ? toggle.querySelector('.apt-rmk-toggle-label').textContent : g.querySelector('.apt-rmk-label').textContent;
        const texts = [...g.querySelectorAll('.apt-rmk')].map((li) => li.textContent);
        return toggle ? [label, texts, body.hidden] : [label, texts];
    });
}

beforeEach(() => {
    document.body.innerHTML = '';
    AirportNotes._chains.clear();
    AirportNoteEditor._loops.clear();
    AirportNotes._unsaved.clear();
    installFetch();
    remarks = { SC76: SC76_RMK, KLKR: KLKR_RMK };
    nasr = {
        getWeather: async () => null,
        getRemarks: vi.fn(async (icao) => remarks[icao] || []),
    };
    globalThis.NasrDB = { haversineNm: () => 5 };
    globalThis.CockpitConfig = { get: (k) => (k === 'ifr.showCdPhone' ? true : null) };
    globalThis.window.app = { showToast: vi.fn() };
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.NasrDB;
    delete globalThis.CockpitConfig;
    delete window.__rmkXss;
});

describe('FAA REMARKS in INFO', () => {
    it('SC76: titled FAA REMARKS, between IFR CLEARANCE and MY NOTES; General shown, FAA admin collapsed with a count', async () => {
        newPopup()._showPanel(SC76, null);
        expect(box().hidden).toBe(true);                       // until the read is back
        await settle();
        expect(nasr.getRemarks).toHaveBeenCalledWith('SC76');
        const info = infoPane();
        expect(box().hidden).toBe(false);
        expect(info.querySelector('.popup-ifr-section').nextElementSibling).toBe(box());
        expect(box().nextElementSibling).toBe(info.querySelector('.apt-my-notes'));
        expect(box().querySelector('.apt-rmk-title').textContent).toBe('FAA REMARKS');
        expect(shown()).toEqual([
            ['General', ['FOR CD CTC CHARLOTTE APCH AT 704-359-0241.']],
            ['FAA admin (1)', ['PRVDD VFR/PR USE.'], true],
        ]);
    });

    it('a tap on the collapsed row shows its remarks, another tap hides them', async () => {
        newPopup()._showPanel(SC76, null);
        await settle();
        const btn = box().querySelector('.apt-rmk-toggle');
        const list = btn.nextElementSibling;
        expect(list.classList.contains('apt-rmk-body')).toBe(true);
        expect(btn.tagName).toBe('BUTTON');
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        expect(btn.querySelector('.apt-rmk-arrow').textContent).toBe('▸');
        btn.click();
        expect(list.hidden).toBe(false);
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        expect(btn.querySelector('.apt-rmk-arrow').textContent).toBe('▾');
        expect(btn.querySelector('.apt-rmk-toggle-label').textContent).toBe('FAA admin (1)');
        btn.click();
        expect(list.hidden).toBe(true);
        expect(btn.getAttribute('aria-expanded')).toBe('false');
    });

    it('KLKR: exact text, in bundle order, under General, Lighting, Fuel', async () => {
        newPopup()._showPanel(KLKR, null);
        await settle();
        expect(shown()).toEqual([
            ['General', KLKR_RMK.slice(0, 6).map((t) => t[2])],
            ['Lighting', ['ACTVT REIL RWY 06 & 24; MIRL RWY 06/24 - CTAF. PAPI RWY 06 & 24 OPR CONSLY.']],
            ['Fuel', ['FOR FUEL AFT HRS CALL 803-285-1513']],
        ]);
        expect(box().querySelector('.apt-rmk-toggle')).toBeNull();
        // the "&" is text, not an entity the pilot would see
        expect(box().textContent).toContain('DEER ON & INVOF ARPT.');
        expect(box().textContent).not.toContain('&amp;');
    });

    it('every category gets its label; runway groups name the runway; Contacts and FAA admin each one collapsed row', async () => {
        remarks.KTST = [
            ['A110-1', 'gen', 'G1', null],
            ['A17', 'ops', 'ATTENDED 0800-1700.', null],
            ['E147', 'ops', 'TPA 1500.', null],
            ['A42-06', 'rwy', 'RWY 06 MARKINGS FADED.', '06'],
            ['A33-06', 'rwy', 'RWY 06 SFC CRACKS.', '06'],
            ['A42-24', 'rwy', 'RWY 24 NSTD MARKINGS.', '24'],
            ['A57-18', 'obst', 'APCH RATIO 15:1 FM DSPLCD THR.', '18'],
            ['A52', 'obst', 'TREES N OF ARPT.', null],
            ['A81-BCN', 'ltg', 'BCN OTS.', null],
            ['A70', 'fuel', '100LL SELF SVC.', null],
            ['A75', 'svc', 'MINOR AIRFRAME.', null],
            ['A14', 'contact', 'JOHN DOE', null],
            ['A16', 'contact', '555-0100', null],
            ['A15', 'contact', '1 MAIN ST', null],
            ['E111', 'admin', 'PRVDD VFR/PR USE.', null],
        ];
        newPopup()._showPanel({ ...KLKR, icao: 'KTST' }, null);
        await settle();
        expect(shown()).toEqual([
            ['General', ['G1']],
            ['Operations', ['ATTENDED 0800-1700.', 'TPA 1500.']],
            ['Runway 06', ['RWY 06 MARKINGS FADED.', 'RWY 06 SFC CRACKS.']],
            ['Runway 24', ['RWY 24 NSTD MARKINGS.']],
            ['Obstructions · Runway 18', ['APCH RATIO 15:1 FM DSPLCD THR.']],
            ['Obstructions', ['TREES N OF ARPT.']],
            ['Lighting', ['BCN OTS.']],
            ['Fuel', ['100LL SELF SVC.']],
            ['Services', ['MINOR AIRFRAME.']],
            ['Contacts (3)', ['JOHN DOE', '555-0100', '1 MAIN ST'], true],
            ['FAA admin (1)', ['PRVDD VFR/PR USE.'], true],
        ]);
        expect(box().querySelectorAll('.apt-rmk-toggle')).toHaveLength(2);
        // runway tuple without a runway; unknown category -> General; text-less tuples skipped
        expect(AirportPopup._remarkGroups([['A30', 'rwy', 'X', null], ['Z', 'weird', 'Y', null], ['Q', 'gen', '  ', null], null, ['W', 'gen', 5, null]])
            .map((g) => [g.label, g.texts])).toEqual([['Runway', ['X']], ['General', ['Y']]]);
    });

    it('remark text is never HTML: an <img onerror> and quotes stay text', async () => {
        const evil = '<img src=x onerror="window.__rmkXss=1"> RWY "06" O\'HARE & <b>BOLD</b>';
        remarks.SC76 = [['A110-1', 'gen', evil, null], ['A30', 'rwy', 'R', '<i>06</i>'],
            ['A14', 'contact', '<script>window.__rmkXss=2</script>', null]];
        newPopup()._showPanel(SC76, null);
        await settle();
        expect(box().querySelector('img, script, b, i')).toBeNull();
        expect(box().querySelector('.apt-rmk').textContent).toBe(evil);
        expect([...box().querySelectorAll('.apt-rmk')].map((li) => li.textContent))
            .toEqual([evil, 'R', '<script>window.__rmkXss=2</script>']);
        expect(shown()[1][0]).toBe('Runway <i>06</i>');
        await new Promise((r) => setTimeout(r, 20));
        expect(window.__rmkXss).toBeUndefined();
        // the source does not build remarks with innerHTML / insertAdjacentHTML
        const src = read('web/cockpit/airport-popup.js');
        const body = src.slice(src.indexOf('_fillFaaRemarks(box, list, keepNotesInPlace = false) {'), src.indexOf('/** How long after the notes box gets focus'));
        expect(body.length).toBeGreaterThan(500);
        expect(body).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    });

    it('hidden and empty when the airport has no remarks, the read fails, or NasrDB has no getRemarks', async () => {
        remarks.SC76 = [];
        newPopup()._showPanel(SC76, null);
        await settle();
        expect(box().hidden).toBe(true);
        expect(box().childNodes.length).toBe(0);

        vi.spyOn(console, 'warn').mockImplementation(() => {});
        document.body.innerHTML = '';
        nasr.getRemarks = vi.fn(async () => { throw new Error('IDB stuck'); });
        newPopup()._showPanel(KLKR, null);
        await settle();
        expect(box().hidden).toBe(true);
        expect(document.querySelector('.airport-panel.open')).not.toBeNull();

        document.body.innerHTML = '';
        nasr.getRemarks = vi.fn(() => { throw new Error('sync throw'); });
        expect(() => newPopup()._showPanel(KLKR, null)).not.toThrow();
        await settle();
        expect(box().hidden).toBe(true);

        document.body.innerHTML = '';
        newPopup({ getWeather: async () => null })._showPanel(KLKR, null);
        await settle();
        expect(box().hidden).toBe(true);
        expect(document.querySelectorAll('.apt-tab').length).toBe(6);
    });
});

describe('long groups: the first 6, then "More (n)"', () => {
    const many = (c, n, rwy = null) => Array.from({ length: n }, (_, i) => [`E${i}`, c, `${c.toUpperCase()} REMARK ${i + 1}`, rwy]);

    it('a group of 9: 6 shown, a 56 px-class "More (3)" row over the other 3; a tap shows them, another hides them', async () => {
        remarks.KADW = many('gen', 9);
        newPopup()._showPanel({ ...KLKR, icao: 'KADW' }, null);
        await settle();
        const g = box().querySelector('.apt-rmk-group');
        const lists = g.querySelectorAll(':scope > .apt-rmk-list');
        expect(lists).toHaveLength(2);
        expect([...lists[0].children].map((li) => li.textContent)).toEqual(many('gen', 6).map((t) => t[2]));
        expect(lists[0].hidden).toBe(false);
        const more = g.querySelector(':scope > .apt-rmk-more');
        expect(more.tagName).toBe('BUTTON');
        expect(more.classList.contains('apt-rmk-toggle')).toBe(true);     // same row style (min-height --touch-min)
        expect(more.querySelector('.apt-rmk-toggle-label').textContent).toBe('More (3)');
        expect(more.nextElementSibling).toBe(lists[1]);
        expect(lists[1].hidden).toBe(true);
        expect([...lists[1].children].map((li) => li.textContent)).toEqual(['GEN REMARK 7', 'GEN REMARK 8', 'GEN REMARK 9']);
        more.click();
        expect(lists[1].hidden).toBe(false);
        expect(more.getAttribute('aria-expanded')).toBe('true');
        more.click();
        expect(lists[1].hidden).toBe(true);
    });

    it('exactly 6: no More row; every group is limited on its own, order kept', async () => {
        remarks.KATL = [...many('gen', 6), ...many('rwy', 8, '08L'), ...many('obst', 7, '26R')];
        newPopup()._showPanel({ ...KLKR, icao: 'KATL' }, null);
        await settle();
        const groups = [...box().querySelectorAll('.apt-rmk-group')];
        expect(groups.map((g) => g.querySelector('.apt-rmk-label').textContent)).toEqual(['General', 'Runway 08L', 'Obstructions · Runway 26R']);
        expect(groups.map((g) => g.querySelector('.apt-rmk-more')?.textContent ?? null)).toEqual([null, '▸More (2)', '▸More (1)']);
        // everything is still there, in bundle order
        expect([...box().querySelectorAll('.apt-rmk')].map((li) => li.textContent)).toEqual(remarks.KATL.map((t) => t[2]));
    });

    it('a collapsed group longer than 6: its own More row inside, hidden until Contacts is opened', async () => {
        remarks.SC76 = many('contact', 8);
        newPopup()._showPanel(SC76, null);
        await settle();
        const g = box().querySelector('.apt-rmk-group');
        const body = g.querySelector('.apt-rmk-body');
        expect(g.querySelector(':scope > .apt-rmk-toggle .apt-rmk-toggle-label').textContent).toBe('Contacts (8)');
        expect(body.hidden).toBe(true);
        const more = body.querySelector('.apt-rmk-more');
        expect(more.querySelector('.apt-rmk-toggle-label').textContent).toBe('More (2)');
        g.querySelector(':scope > .apt-rmk-toggle').click();
        expect(body.hidden).toBe(false);
        expect(body.querySelector('.apt-rmk-rest').hidden).toBe(true);
        more.click();
        expect(body.querySelector('.apt-rmk-rest').hidden).toBe(false);
    });
});

describe('category names are data, not code (hasOwnProperty guard)', () => {
    it("'__proto__', 'constructor', 'toString', 'hasOwnProperty' categories: shown as text under General", async () => {
        remarks.SC76 = [['X', '__proto__', 'PROTO CAT', '<i>06</i>'], ['Y', 'constructor', 'CTOR CAT', null],
            ['Z', 'toString', 'TOSTRING CAT', null], ['W', 'hasOwnProperty', 'HOP CAT', null]];
        newPopup()._showPanel(SC76, null);
        await settle();
        expect(shown()).toEqual([['General · Runway <i>06</i>', ['PROTO CAT']], ['General', ['CTOR CAT', 'TOSTRING CAT', 'HOP CAT']]]);
        expect(box().querySelector('i')).toBeNull();
        expect([...box().querySelectorAll('.apt-rmk-group')].map((g) => g.dataset.cat)).toEqual(['gen', 'gen']);
        expect(Object.prototype.toString.call(AirportPopup.REMARK_LABELS)).toBe('[object Object]');
        expect(({}).constructor).toBe(Object);                     // nothing was assigned through them
    });
});

describe('show() and showForAirport() both load the remarks', () => {
    it('show(airport)', async () => {
        const p = newPopup();
        await p.show(KLKR);
        await settle();
        expect(nasr.getRemarks).toHaveBeenCalledWith('KLKR');
        expect(shown()[0][0]).toBe('General');
    });

    it('showForAirport(icao) (NASR lookup)', async () => {
        nasr.open = async () => {};
        nasr.getAirport = async (icao) => (icao === 'SC76' ? { ...SC76 } : null);
        const p = newPopup();
        await p.showForAirport('SC76');
        await settle();
        expect(nasr.getRemarks).toHaveBeenCalledWith('SC76');
        expect(shown()).toHaveLength(2);
    });
});

describe('stale reads are dropped', () => {
    it('SC76 read comes back after the panel moved to KLKR: KLKR shows only its own remarks', async () => {
        const slow = deferred();
        nasr.getRemarks = vi.fn((icao) => (icao === 'SC76' ? slow.promise : Promise.resolve(KLKR_RMK)));
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        const sc76Box = box();
        p._showPanel(KLKR, null);
        await settle();
        slow.resolve(SC76_RMK);
        await settle();
        expect(box()).not.toBe(sc76Box);
        expect(box().dataset.icao).toBe('KLKR');
        expect(box().textContent).not.toContain('PRVDD');
        expect(shown().map((g) => g[0])).toEqual(['General', 'Lighting', 'Fuel']);
        expect(sc76Box.isConnected).toBe(false);
        expect(sc76Box.childNodes.length).toBe(0);              // nothing built into the old box either
    });

    it('a read that comes back after the search panel replaced the airport: nothing rendered', async () => {
        const slow = deferred();
        nasr.getRemarks = vi.fn(() => slow.promise);
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        const old = box();
        p._showSearchPanel();
        slow.resolve(SC76_RMK);
        await settle();
        expect(box()).toBeNull();
        expect(old.childNodes.length).toBe(0);
    });

    it('the same airport reopened while its first read is pending: only the new box is filled', async () => {
        const first = deferred();
        let n = 0;
        nasr.getRemarks = vi.fn(() => (++n === 1 ? first.promise : Promise.resolve(SC76_RMK)));
        const p = newPopup();
        p._showPanel(SC76, null);
        const old = box();
        p._showPanel(SC76, null);
        await settle();
        first.resolve(SC76_RMK);
        await settle();
        expect(old.childNodes.length).toBe(0);
        expect(box().querySelectorAll('.apt-rmk-group')).toHaveLength(2);
        expect(document.querySelectorAll('.apt-faa-remarks')).toHaveLength(1);
    });
});

describe('MY NOTES is untouched', () => {
    it('remarks arriving leave the notes box alone: same element, same text, same place (last in INFO)', async () => {
        const slow = deferred();
        nasr.getRemarks = vi.fn(() => slow.promise);
        newPopup()._showPanel(SC76, null);
        await settle();
        const el = ta();
        expect(el.readOnly).toBe(false);                         // note read done (404): editable
        el.value = 'Land 3, take off 21';
        slow.resolve(SC76_RMK);
        await settle();
        expect(ta()).toBe(el);
        expect(el.value).toBe('Land 3, take off 21');
        expect(infoPane().lastElementChild.classList.contains('apt-my-notes')).toBe(true);
        expect(box().contains(el)).toBe(false);
        expect(box().hidden).toBe(false);
    });

    it('notes box focused when the remarks arrive: nothing rendered until it loses focus, then filled', async () => {
        const slow = deferred();
        nasr.getRemarks = vi.fn(() => slow.promise);
        const p = newPopup();
        p._showPanel(SC76, null);
        await settle();
        const panel = document.querySelector('.airport-panel');
        const el = ta();
        el.focus();
        expect(panel.classList.contains('apt-notes-editing')).toBe(true);
        el.value = 'typing';
        slow.resolve(SC76_RMK);
        await settle();
        expect(box().hidden).toBe(true);                         // not while editing
        expect(box().childNodes.length).toBe(0);
        expect(document.activeElement).toBe(el);
        expect(panel.classList.contains('apt-notes-editing')).toBe(true);
        expect(el.value).toBe('typing');
        el.blur();
        expect(panel.classList.contains('apt-notes-editing')).toBe(false);
        expect(box().hidden).toBe(false);
        expect(shown()).toHaveLength(2);
        expect(ta()).toBe(el);
        expect(el.value).toBe('typing');
        // a second focus/blur does not build it twice
        el.focus(); el.blur();
        expect(box().querySelectorAll('.apt-rmk-group')).toHaveLength(2);
    });

    it('drawn on blur after waiting for the notes box: MY NOTES stays where it was, even with the box in view', async () => {
        const slow = deferred();
        nasr.getRemarks = vi.fn(() => slow.promise);
        newPopup()._showPanel(SC76, null);
        await settle();
        const content = document.querySelector('.apt-tab-content');
        const notes = document.querySelector('.apt-my-notes');
        // jsdom has no layout. MY NOTES (where the box goes in) is 155 px below the content's top, and
        // the content can scroll only 46 px (MY NOTES is the last thing in INFO): after blur it stays
        // in view, 109 px down, not at the top (the case seen in Chromium: 555 -> 1124 px). The box
        // then grows 569 px, and the scroll range with it.
        let grown = 0, st = 0;
        Object.defineProperty(content, 'scrollTop', { configurable: true, get: () => st, set: (v) => { st = Math.max(0, Math.min(v, 46 + grown)); } });
        content.getBoundingClientRect = () => ({ top: 400 });
        box().getBoundingClientRect = () => ({ top: 0 });
        notes.getBoundingClientRect = () => ({ top: 555 + grown - content.scrollTop });
        const origReplace = box().replaceChildren.bind(box());
        box().replaceChildren = (...n) => { origReplace(...n); grown = 569; };
        ta().focus();
        slow.resolve(SC76_RMK);
        await settle();
        expect(box().hidden).toBe(true);
        expect(content.scrollTop).toBe(0);
        ta().blur();
        // the notes' own blur handler scrolls as far as it can (46 px), then the box is drawn and the
        // content scrolled by what it grew: MY NOTES stays at 509, not pushed down to 1078
        expect(box().hidden).toBe(false);
        expect(content.scrollTop).toBe(46 + 569);
        expect(notes.getBoundingClientRect().top).toBe(509);
    });

    it('the pilot scrolled down to the notes before the remarks came: the tab content is scrolled by what the box grew', async () => {
        const slow = deferred();
        nasr.getRemarks = vi.fn(() => slow.promise);
        newPopup()._showPanel(SC76, null);
        await settle();
        const content = document.querySelector('.apt-tab-content');
        const notes = document.querySelector('.apt-my-notes');
        // jsdom has no layout. The hidden box has no rect of its own: where it goes in is MY NOTES'
        // top, 100 px above the content's top (scrolled past); the box then grows 140 px.
        let grown = 0;
        content.scrollTop = 600;
        content.getBoundingClientRect = () => ({ top: 400 });
        box().getBoundingClientRect = () => ({ top: 0 });
        notes.getBoundingClientRect = () => ({ top: 300 + grown - (content.scrollTop - 600) });
        const realFill = AirportPopup.prototype._fillFaaRemarks;
        const spy = vi.spyOn(AirportPopup.prototype, '_fillFaaRemarks').mockImplementation(function (b, l) {
            const origReplace = b.replaceChildren.bind(b);
            b.replaceChildren = (...n) => { origReplace(...n); grown = 140; };
            return realFill.call(this, b, l);
        });
        slow.resolve(SC76_RMK);
        await settle();
        expect(spy).toHaveBeenCalled();
        expect(content.scrollTop).toBe(740);
        expect(notes.getBoundingClientRect().top).toBe(300);    // the notes stayed where they were
    });

    it('where the box goes in is in view (top of INFO): no scroll change, even though a hidden box measures top 0', async () => {
        newPopup()._showPanel(KLKR, null);
        const content = document.querySelector('.apt-tab-content');
        let grown = 0;
        content.getBoundingClientRect = () => ({ top: 400 });
        box().getBoundingClientRect = () => ({ top: 0 });      // display:none: an all-zero rect
        document.querySelector('.apt-my-notes').getBoundingClientRect = () => ({ top: 900 + grown });
        const origReplace = box().replaceChildren.bind(box());
        box().replaceChildren = (...n) => { origReplace(...n); grown = 500; };
        await settle();
        expect(box().hidden).toBe(false);
        expect(content.scrollTop).toBe(0);
    });
});
