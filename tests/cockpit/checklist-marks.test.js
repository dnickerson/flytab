/**
 * Checklist capture buttons: run-up start / end and magneto LEFT / RIGHT / BOTH
 * marks that go into the flight recording (FlightRecorder.markEvent).
 * Uses the real checklist.json and the real checklist.js / tap-utils.js.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const tapUtils = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap, wireIsolatedTap, lastTouchAt: () => _wireTapLastTouchAt };')();
global.wireTap = tapUtils.wireTap;
global.wireIsolatedTap = tapUtils.wireIsolatedTap;   // the real checklist.json's first list has the VPN item
global.VpnStatus = new Function(read('web/shared/vpn-status.js') + '\nreturn VpnStatus;')();
const Checklist = new Function(read('web/cockpit/checklist.js') + '\nreturn Checklist;')();
const DATA = JSON.parse(read('web/checklist.json'));

function find(type, sectionName, listName) {
    const g = DATA.groups.find((x) => x.type === type);
    const s = sectionName ? g.sections.find((x) => x.name === sectionName) : g.sections[0];
    return s.checklists.find((c) => c.name === listName);
}

describe('checklist.json capture properties', () => {
    it('Normal > Runup: 50% Power = runup_start, Magneto = mags, Engine Idle = runup_end; no other item captures', () => {
        const items = find('normal', 'VFR', 'Runup').items;
        const caps = Object.fromEntries(items.filter((i) => i.capture).map((i) => [i.title, i.capture]));
        expect(caps).toEqual({ '50% Power': 'runup_start', 'Magneto': 'mags', 'Engine Idle': 'runup_end' });
    });

    it('Abnormal > In Flight Mag Check: only "Mags" captures, as mags', () => {
        const items = find('abnormal', null, 'In Flight Mag Check').items;
        expect(items.filter((i) => i.capture).map((i) => [i.title, i.capture])).toEqual([['Mags', 'mags']]);
    });

    it('capture appears nowhere else, and only with known values', () => {
        let n = 0;
        for (const g of DATA.groups) for (const s of g.sections) for (const c of s.checklists) for (const i of c.items) {
            if ('capture' in i) { n++; expect(['runup_start', 'runup_end', 'mags']).toContain(i.capture); }
        }
        expect(n).toBe(4);
    });
});

describe('Checklist capture buttons', () => {
    let cl, recorder, toast, marked;

    const touch = (type, x = 10, y = 10) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        const pt = [{ clientX: x, clientY: y }];
        e.touches = type === 'touchend' ? [] : pt; e.changedTouches = pt;
        return e;
    };
    const tap = (el) => { el.dispatchEvent(touch('touchstart')); el.dispatchEvent(touch('touchend')); };

    async function build() {
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => DATA }));
        cl = new Checklist(document.body);
        await vi.waitFor(() => expect(cl._data).not.toBeNull());
    }
    /** Select a checklist by group/section/list name and render it. */
    function open(type, sectionName, listName) {
        cl._selectGroup(type);
        const g = DATA.groups.find((x) => x.type === type);
        cl._activeSection = Math.max(0, g.sections.findIndex((s) => s.name === sectionName));
        cl._activeChecklist = g.sections[cl._activeSection].checklists.findIndex((c) => c.name === listName);
        cl._renderItems();
    }
    const btn = (code) => cl._bodyEl.querySelector(`.checklist-capture-btn[data-capture="${code}"]`);
    const row = (title) => [...cl._bodyEl.querySelectorAll('.checklist-item')]
        .find((el) => el.querySelector('.checklist-item-title').textContent === title);

    beforeEach(() => {
        document.body.innerHTML = '';
        localStorage.clear();
        marked = [];
        let mag = null;
        recorder = {
            markEvent: vi.fn((code) => {
                marked.push(code);
                if (recorder.saveResult.saved && code.startsWith('mag_')) mag = code;
                return recorder.saveResult;
            }),
            currentMag: () => mag,
            saveResult: { saved: true, at: '2026-10-30T20:57:14.000Z' },
        };
        window.flightRecorder = recorder;
        toast = vi.fn();
        window.app = { showToast: toast };
    });
    afterEach(() => { cl?.hide(); delete window.flightRecorder; delete window.app; delete global.fetch; });

    it('Runup: RUN-UP START on 50% Power, LEFT/RIGHT/BOTH on Magneto, RUN-UP END on Engine Idle', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        expect(row('50% Power').querySelector('[data-capture="runup_start"]').textContent).toBe('RUN-UP START');
        expect(row('Engine Idle').querySelector('[data-capture="runup_end"]').textContent).toBe('RUN-UP END');
        const mags = [...row('Magneto').querySelectorAll('.checklist-capture-btn')];
        expect(mags.map((b) => [b.dataset.capture, b.textContent])).toEqual([
            ['mag_L', 'LEFT'], ['mag_R', 'RIGHT'], ['mag_BOTH', 'BOTH'],
        ]);
        // other items have none
        expect(row('Prop').querySelector('.checklist-capture-btn')).toBeNull();
        expect(row('Controls').querySelector('.checklist-capture-btn')).toBeNull();
    });

    it('In Flight Mag Check: the Mags item has the three mag buttons', async () => {
        await build();
        open('abnormal', 'Engine', 'In Flight Mag Check');
        const mags = [...row('Mags').querySelectorAll('.checklist-capture-btn')].map((b) => b.dataset.capture);
        expect(mags).toEqual(['mag_L', 'mag_R', 'mag_BOTH']);
        expect(row('Power').querySelector('.checklist-capture-btn')).toBeNull();
    });

    it('tapping LEFT calls markEvent("mag_L") and does NOT check the item or open its note', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        const before = JSON.stringify(cl._checked);
        const notesBefore = [...cl._openNotes];
        tap(btn('mag_L'));
        expect(recorder.markEvent).toHaveBeenCalledTimes(1);
        expect(recorder.markEvent).toHaveBeenCalledWith('mag_L');
        expect(JSON.stringify(cl._checked)).toBe(before);
        expect([...cl._openNotes]).toEqual(notesBefore);
        expect(row('Magneto').classList.contains('checked')).toBe(false);
        // the synthetic click that follows a touch is swallowed by wireTap's guard
        btn('mag_L').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(recorder.markEvent).toHaveBeenCalledTimes(1);
    });

    it('a mouse click (no touch) also marks, once, without toggling the item', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        await new Promise((r) => setTimeout(r, 400));          // outside wireTap's 350 ms window
        btn('mag_R').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(marked).toEqual(['mag_R']);
        expect(Object.values(cl._checked).some(Boolean)).toBe(false);
    });

    it('a touch on a capture button never reaches the row (no toggle) on any of the buttons', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        for (const code of ['runup_start', 'mag_L', 'mag_R', 'mag_BOTH', 'runup_end']) tap(btn(code));
        expect(marked).toEqual(['runup_start', 'mag_L', 'mag_R', 'mag_BOTH', 'runup_end']);
        expect(Object.values(cl._checked).some(Boolean)).toBe(false);
        expect(cl._bodyEl.querySelectorAll('.checklist-item.checked')).toHaveLength(0);
    });

    it('tapping the item itself still checks it (the row works as before)', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        tap(row('Magneto').querySelector('.checklist-item-main'));
        expect(row('Magneto').classList.contains('checked')).toBe(true);
    });

    it('highlight follows FlightRecorder.currentMag(), not localStorage', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        const active = () => [...cl._bodyEl.querySelectorAll('.checklist-capture-btn.active')].map((b) => b.dataset.capture);
        expect(active()).toEqual([]);
        tap(btn('mag_L'));
        expect(active()).toEqual(['mag_L']);
        expect(btn('mag_L').getAttribute('aria-pressed')).toBe('true');
        expect(btn('mag_R').getAttribute('aria-pressed')).toBe('false');
        tap(btn('mag_BOTH'));
        expect(active()).toEqual(['mag_BOTH']);
        // nothing about it was stored on the tablet
        expect(Object.keys(localStorage).some((k) => /mag/i.test(k) || /mag_/.test(localStorage.getItem(k) || ''))).toBe(false);
        // a re-render (reset, other list and back) shows the recorder's state
        open('abnormal', 'Engine', 'In Flight Mag Check');
        expect(active()).toEqual(['mag_BOTH']);
        // a recording that ended elsewhere: the highlight goes with it
        recorder.currentMag = () => null;
        open('normal', 'VFR', 'Runup');
        expect(active()).toEqual([]);
    });

    it('run-up start/end buttons are never highlighted', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        tap(btn('runup_start'));
        expect(btn('runup_start').classList.contains('active')).toBe(false);
    });

    it('saved: toast names the mark and the time in Z', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        const cases = [
            ['mag_L', 'LEFT mag marked 20:57:14Z'], ['mag_R', 'RIGHT mag marked 20:57:14Z'], ['mag_BOTH', 'BOTH mag marked 20:57:14Z'],
            ['runup_start', 'RUN-UP START marked 20:57:14Z'], ['runup_end', 'RUN-UP END marked 20:57:14Z'],
        ];
        for (const [code, msg] of cases) { toast.mockClear(); tap(btn(code)); expect(toast).toHaveBeenCalledWith(msg); }
    });

    it('not recording: toast "Not recording — mark not saved", and no highlight', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        recorder.saveResult = { saved: false, at: '2026-10-30T20:57:14.000Z', reason: 'not_recording' };
        tap(btn('mag_L'));
        expect(toast).toHaveBeenCalledWith('Not recording — mark not saved');
        expect(btn('mag_L').classList.contains('active')).toBe(false);
    });

    it('no fresh data: its own toast', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        recorder.saveResult = { saved: false, at: '2026-10-30T20:57:14.000Z', reason: 'no_data' };
        tap(btn('mag_L'));
        expect(toast).toHaveBeenCalledWith('No engine or GPS data — mark not saved');
    });

    it('recording started before marks existed: its own toast', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        recorder.saveResult = { saved: false, at: '2026-10-30T20:57:14.000Z', reason: 'old_recording' };
        tap(btn('runup_start'));
        expect(toast).toHaveBeenCalledWith('This recording started before marks existed — mark not saved');
    });

    it('no recorder at all (browser/dev): "Not recording" toast, no throw', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        delete window.flightRecorder;
        expect(() => tap(btn('mag_L'))).not.toThrow();
        expect(toast).toHaveBeenCalledWith('Not recording — mark not saved');
    });

    it('the toast is removed after Checklist.TOAST_MS, and shows above the open checklist', async () => {
        await build();
        open('normal', 'VFR', 'Runup');
        const el = document.createElement('div');
        document.body.appendChild(el);
        window.app.showToast = vi.fn(() => el);
        vi.useFakeTimers();
        try {
            tap(btn('mag_L'));
            expect(el.isConnected).toBe(true);
            vi.advanceTimersByTime(Checklist.TOAST_MS + 1);
            expect(el.isConnected).toBe(false);
        } finally { vi.useRealTimers(); }
        // .toast is z-index 700, the checklist page 800: without this rule the toast is hidden behind it
        expect(read('web/style.css')).toMatch(/body:has\(\.checklist-page\.visible\) > \.toast \{ z-index: 900; \}/);
    });

    it('buttons are touch-sized and token-styled in style.css', () => {
        const css = read('web/style.css');
        const block = css.slice(css.indexOf('.checklist-capture-btn {'));
        const rule = block.slice(0, block.indexOf('}'));
        expect(rule).toMatch(/min-height:\s*var\(--touch-min, 56px\)/);
        expect(rule).toMatch(/font-weight:\s*(7|8|9)00/);
        expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(rule).not.toMatch(/font-size:\s*\d+px/);
    });
});

describe('Checklist highlight follows the recording start/stop', () => {
    it('refreshes on flightsync:started and flightsync:stopped', async () => {
        document.body.innerHTML = '';
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => DATA }));
        let mag = 'mag_R';
        window.flightRecorder = { currentMag: () => mag, markEvent: vi.fn() };
        const cl = new Checklist(document.body);
        await vi.waitFor(() => expect(cl._data).not.toBeNull());
        cl._selectGroup('normal');
        cl._activeSection = 0;
        cl._activeChecklist = find('normal', 'VFR', 'Runup') ? DATA.groups[0].sections[0].checklists.findIndex((c) => c.name === 'Runup') : 0;
        cl._renderItems();
        const active = () => [...cl._bodyEl.querySelectorAll('.checklist-capture-btn.active')].map((b) => b.dataset.capture);
        expect(active()).toEqual(['mag_R']);
        mag = null;                                     // recording ended
        window.dispatchEvent(new CustomEvent('flightsync:stopped'));
        expect(active()).toEqual([]);
        mag = 'mag_L';                                  // resumed recording
        window.dispatchEvent(new CustomEvent('flightsync:started'));
        expect(active()).toEqual(['mag_L']);
        delete window.flightRecorder; delete global.fetch;
    });
});
