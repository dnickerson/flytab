/**
 * Vne / Va map pill (web/cockpit/vne-pill.js): what it shows, tap opens/closes the card,
 * placement under the engine box. jsdom has no layout, so offsetTop/offsetHeight are set by hand.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = (el, fn) => el && el.addEventListener('click', fn);
globalThis.Settings = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.AirspeedLimits = new Function(read('web/shared/airspeed-limits.js') + '\nreturn AirspeedLimits;')();
globalThis.WbCalculator = new Function(read('web/shared/wb-calculator.js') + '\nreturn WbCalculator;')();
const VnePanel = new Function(read('web/cockpit/vne-panel.js') + '\nreturn VnePanel;')();
const VnePill = new Function(read('web/cockpit/vne-pill.js') + '\nreturn VnePill;')();
const AC = JSON.parse(read('web/aircraft-config.json'));

let view, panel, pill;
const pillText = () => [...pill._el.children].map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim();
const tap = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const type = (field, value) => {
    const el = panel._el.querySelector(`[data-field="${field}"] input`);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
};
const layout = (el, top, height) => {
    Object.defineProperty(el, 'offsetTop', { configurable: true, get: () => top });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => height });
};
const engineBox = (rows, style = { top: '156px', right: '8px' }) => {
    const box = document.createElement('div');
    box.className = 'engine-overlay';
    Object.assign(box.style, style);
    for (let i = 0; i < rows; i++) box.appendChild(document.createElement('div'));
    view.appendChild(box);
    return box;
};
const build = () => {
    panel = new VnePanel(view);
    pill = new VnePill(view, panel);
    layout(pill._el, 0, 40);
};

beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="primaryView"></div>';
    view = document.getElementById('primaryView');
    globalThis.FuelState = { measuredGallons: () => ({ gallons: 20, stale: false }) };
    globalThis.CockpitConfig = { aircraft: (p) => (p === 'weight_balance' ? AC.weight_balance : undefined) };
});
afterEach(() => { pill?.destroy(); panel?.destroy(); pill = panel = null; });

describe('what the pill shows', () => {
    it('dashes before anything is entered', () => {
        build();
        expect(pillText()).toBe('Vne — Va —');
    });

    it('Vne, Va and the altitude they are for; follows card edits', () => {
        Settings.wbStationWeights = { Pilot: '190', Passenger: '170', Baggage: '20' };
        build();
        expect(pillText()).toBe('Vne — Va 94');
        type('altimeter', '29.92'); type('alt', '8000'); type('oatF', '32');
        expect(pillText()).toBe('Vne 161 Va 94 @ 8,000 · 32°F · just now');
        type('altimeter', '3012');
        expect(pillText()).toBe('Vne — Va 94');
    });

    describe('OAT and the age of the entries (Dana 2026-11-13, option 1)', () => {
        const T0 = Date.UTC(2026, 10, 13, 15, 0, 0);
        beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
        afterEach(() => { vi.useRealTimers(); });

        it('entries from an earlier flight show their OAT and how old they are (the review\'s 164-vs-154 case)', () => {
            // saved 3 h ago on a cold, high-pressure day; the pill must say so
            Settings.vneInputs = { altimeter: '30.40', alt: '8000', oatF: '20', kias: '', savedAt: T0 - 3 * 3600000 };
            build();
            expect(pillText()).toMatch(/^Vne \d+ Va — @ 8,000 · 20°F · 3h ago$/);
        });

        it('the age counts on with the card\'s refresh; a new entry resets it', () => {
            build();
            type('altimeter', '29.92'); type('alt', '8000'); type('oatF', '59');
            expect(pillText()).toContain('· 59°F · just now');
            vi.advanceTimersByTime(14 * 60000);                 // the 15 s refresh fires change
            expect(pillText()).toContain('· 14m ago');
            vi.advanceTimersByTime(2 * 3600000);
            expect(pillText()).toContain('· 2h ago');
            // the age is the OLDEST of altimeter / altitude / OAT: a new OAT alone leaves it at 2h
            type('oatF', '60');
            expect(pillText()).toContain('· 60°F · 2h ago');
            type('altimeter', '29.90'); type('alt', '8500');
            expect(pillText()).toContain('@ 8,500 · 60°F · just now');
        });

        it('typing KIAS, or a step that changes nothing, never makes old entries look fresh (review)', () => {
            Settings.vneInputs = { altimeter: '30.40', alt: '8000', oatF: '20', kias: '', at: { altimeter: T0 - 3 * 3600000, alt: T0 - 3 * 3600000, oatF: T0 - 3 * 3600000 } };
            build();
            type('kias', '150');
            expect(pillText()).toContain('· 3h ago');
            const btn = (field, sel) => panel._el.querySelector(`[data-field="${field}"] ${sel}`);
            const clearK = btn('kias', '.vne-clear');
            expect(clearK).not.toBeNull();
            tap(clearK);
            expect(pillText()).toContain('· 3h ago');
            // weights / fuel events re-work Va but leave the age alone
            window.dispatchEvent(new Event('wb:weightschanged'));
            window.dispatchEvent(new Event('fuelstate:changed'));
            expect(pillText()).toContain('· 3h ago');
            // the OAT's ± is a real change, but altimeter and altitude are still 3 h old: still 3h
            const sign = btn('oatF', '.vne-sign');
            expect(sign).not.toBeNull();
            tap(sign);
            expect(pillText()).toContain('· -20°F · 3h ago');
        });

        it('the card follows the pill when its second line appears or goes (review: it covered the age line)', () => {
            build();
            panel.toggle();                                     // card open
            let h = 40;
            Object.defineProperty(pill._el, 'offsetHeight', { configurable: true, get: () => h });
            pill.place();
            const before = panel._el.style.top;
            h = 60;                                             // the second line appears
            type('altimeter', '29.92'); type('alt', '8000'); type('oatF', '59');
            expect(panel._el.style.top).not.toBe(before);
            expect(parseInt(panel._el.style.top, 10)).toBe(parseInt(pill._el.style.top, 10) + 60 + 6);
        });

        it('the save carries each entry\'s time and a new panel reads it back', () => {
            build();
            type('altimeter', '29.92'); type('alt', '8000'); type('oatF', '59');
            expect(Settings.vneInputs.at).toEqual({ altimeter: T0, alt: T0, oatF: T0 });
            pill.destroy(); panel.destroy();
            vi.setSystemTime(T0 + 50 * 3600000);
            build();
            expect(pillText()).toContain('· 59°F · 2d ago');
        });

        it('a single savedAt (v13.18 test build) still reads; a bad or string time reads "age ?"', () => {
            Settings.vneInputs = { altimeter: '29.92', alt: '8000', oatF: '59', kias: '', savedAt: T0 - 20 * 60000 };
            build();
            expect(pillText()).toContain('· 20m ago');
            pill.destroy(); panel.destroy();
            Settings.vneInputs = { altimeter: '29.92', alt: '8000', oatF: '59', kias: '', at: { altimeter: '123', alt: NaN, oatF: T0 } };
            build();
            expect(pillText()).toContain('· age ?');
        });

        it('entries saved before the age existed (no savedAt) read "age ?"; a time in the future too', () => {
            Settings.vneInputs = { altimeter: '29.92', alt: '8000', oatF: '59', kias: '' };
            build();
            expect(pillText()).toContain('· 59°F · age ?');
            pill.destroy(); panel.destroy();
            Settings.vneInputs = { altimeter: '29.92', alt: '8000', oatF: '59', kias: '', savedAt: T0 + 3600000 };
            build();
            expect(pillText()).toContain('· age ?');
        });

        it('live-data entries (setInputs) are dated when pushed', () => {
            build();
            vi.setSystemTime(T0 + 7 * 60000);
            panel.setInputs({ pressureAltFt: 8000, oatF: 59 }, 'test feed');
            expect(pillText()).toContain('· 59°F · just now');
        });

        it('ageText boundaries', () => {
            const at = T0;
            expect(VnePill.ageText(at, at + 59 * 1000)).toBe('just now');
            expect(VnePill.ageText(at, at + 60 * 1000)).toBe('1m ago');
            expect(VnePill.ageText(at, at + 59 * 60000)).toBe('59m ago');
            expect(VnePill.ageText(at, at + 60 * 60000)).toBe('1h ago');
            expect(VnePill.ageText(at, at + 47.9 * 3600000)).toBe('47h ago');
            expect(VnePill.ageText(at, at + 48 * 3600000)).toBe('2d ago');
            expect(VnePill.ageText(null)).toBe('age ?');
            expect(VnePill.ageText(at, at - 5000)).toBe('just now');
            expect(VnePill.ageText(at + 2 * 60000, at)).toBe('age ?');   // clock moved back
        });
    });

    it('never turns red, even with KIAS over Vne', () => {
        build();
        type('altimeter', '29.92'); type('alt', '8000'); type('oatF', '32'); type('kias', '175');
        expect(panel._el.querySelector('[data-out="status"]').textContent).toBe('⚠ OVER VNE by 14 kt');
        expect(pill._el.className).toBe('vne-pill');
    });

    it('updates when W&B weights change', () => {
        build();
        Settings.wbStationWeights = { Pilot: '190' };
        window.dispatchEvent(new CustomEvent('wb:weightschanged'));
        expect(pillText()).toBe('Vne — Va 88');   // 1034 + 190 + 120 fuel = 1,344 lb → 88.1
    });
});

describe('tap', () => {
    it('opens the card, tap again closes it', () => {
        build();
        expect(panel.visible).toBe(false);
        tap(pill._el);
        expect(panel.visible).toBe(true);
        tap(pill._el);
        expect(panel.visible).toBe(false);
    });

    it('is laid out like an engine box row: label, value, label, value', () => {
        build();
        expect([...pill._el.children].map((c) => c.className || c.tagName))
            .toEqual(['vne-pill-label', 'B', 'vne-pill-label', 'B', 'vne-pill-alt']);
    });

    it('is a real button with a label', () => {
        build();
        expect(pill._el.tagName).toBe('BUTTON');
        expect(pill._el.getAttribute('aria-label')).toMatch(/Vne and Va/);
    });
});

describe('placement', () => {
    it('no engine box: the 156 px slot; the card goes under the pill', () => {
        build();
        pill.place();
        expect(pill._el.style.top).toBe('156px');
        expect(panel._el.style.top).toBe('202px');   // 156 + 40 + 6
    });

    it('under the engine box, 6 px below its last row', () => {
        const box = engineBox(2);
        layout(box, 156, 70);
        build();
        pill.place();
        expect(pill._el.style.top).toBe('232px');    // 156 + 70 + 6
        expect(panel._el.style.top).toBe('278px');
    });

    it('follows the engine box when its fields change (rebuilt element)', async () => {
        const old = engineBox(1);
        layout(old, 156, 34);
        build();
        pill.place();
        expect(pill._el.style.top).toBe('196px');
        old.remove();
        const box = engineBox(4);
        layout(box, 156, 140);
        window.dispatchEvent(new CustomEvent('engineoverlay:fieldschanged'));
        await new Promise((r) => setTimeout(r, 30));
        expect(pill._el.style.top).toBe('302px');
    });

    it('an engine box placed top-left or with no fields does not move the pill', () => {
        const left = engineBox(2, { top: '64px', left: '8px' });
        layout(left, 64, 70);
        build();
        pill.place();
        expect(pill._el.style.top).toBe('156px');
        left.remove();
        const empty = engineBox(0);
        layout(empty, 156, 0);
        pill.place();
        expect(pill._el.style.top).toBe('156px');
    });
});

describe('destroy', () => {
    it('removes the pill and stops following the card', () => {
        build();
        pill.destroy();
        expect(view.querySelector('.vne-pill')).toBeNull();
        type('altimeter', '29.92');   // must not throw
        pill = null;
    });
});
