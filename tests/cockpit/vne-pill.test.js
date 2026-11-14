/**
 * Vne / Va map pill (web/cockpit/vne-pill.js): what it shows, tap opens/closes the card,
 * placement under the engine box. jsdom has no layout, so offsetTop/offsetHeight are set by hand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
        expect(pillText()).toBe('Vne 161 Va 94 @ 8,000');
        type('altimeter', '3012');
        expect(pillText()).toBe('Vne — Va 94');
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
