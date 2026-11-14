/**
 * Vne / Va card (web/cockpit/vne-panel.js): altimeter + altitude + OAT °F + KIAS entry,
 * Va from the saved W&B weights and the tracked fuel, persistence, warning state, no NaN on
 * screen, 'change' events for the pill, live-data hook. The math is covered by
 * tests/shared/airspeed-limits.test.js. Design: docs/superpowers/specs/2026-11-13-vne-va-map-pill-design.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = (el, fn) => el && el.addEventListener('click', fn);
globalThis.Settings = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.AirspeedLimits = new Function(read('web/shared/airspeed-limits.js') + '\nreturn AirspeedLimits;')();
globalThis.WbCalculator = new Function(read('web/shared/wb-calculator.js') + '\nreturn WbCalculator;')();
const VnePanel = new Function(read('web/cockpit/vne-panel.js') + '\nreturn VnePanel;')();
const AC = JSON.parse(read('web/aircraft-config.json'));

let panel;
let fuel;          // what FuelState.measuredGallons() returns
let vneKt;         // CockpitConfig performance.vne_kt
const $ = (sel) => panel._el.querySelector(sel);
const out = (name) => $(`[data-out="${name}"]`);
const input = (field) => $(`[data-field="${field}"] input`);
const type = (field, value) => {
    const el = input(field);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
};
const tap = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const stepBtn = (field, delta) => $(`[data-field="${field}"] [data-step="${delta}"]`);
const visibleText = () => [...panel._el.querySelectorAll('*')]
    .filter((e) => !e.closest('[hidden]') && e.children.length === 0)
    .map((e) => e.textContent).join(' ') + ' ' + [...panel._el.querySelectorAll('input')].map((i) => i.value).join(' ');
const enter8000 = () => { type('altimeter', '29.92'); type('alt', '8000'); type('oatF', '32'); };
const saveWeights = (w) => { Settings.wbStationWeights = w; };
const open = () => {
    if (panel) panel.destroy();
    document.body.innerHTML = '';
    panel = new VnePanel(document.body);
    panel.show();
};

beforeEach(() => {
    localStorage.clear();
    fuel = null;
    vneKt = undefined;
    globalThis.FuelState = { measuredGallons: () => fuel };
    globalThis.CockpitConfig = {
        aircraft: (p) => (p === 'weight_balance' ? AC.weight_balance : (p === 'performance.vne_kt' ? vneKt : undefined)),
    };
    panel = null;
    open();
});
afterEach(() => { panel?.destroy(); panel = null; });

describe('first open', () => {
    it('is hidden until show(); toggle and ✕ close it', () => {
        const p2 = new VnePanel(document.body);
        expect(p2.visible).toBe(false);
        p2.toggle();
        expect(p2.visible).toBe(true);
        tap(p2._el.querySelector('.btn-close'));
        expect(p2.visible).toBe(false);
        p2.destroy();
    });

    it('is a floating card, not a full-screen page; the four entries, no °C toggle, no KTAS', () => {
        expect(panel._el.classList.contains('vne-card')).toBe(true);
        expect([...panel._el.querySelectorAll('.vne-field')].map((f) => f.dataset.field))
            .toEqual(['kias', 'alt', 'altimeter', 'oatF']);
        expect(panel._el.querySelector('[data-unit]')).toBeNull();
        expect(panel._el.textContent).toContain('°F');
    });

    it('layout: KIAS and altitude first, then Vne/Va + badge, then altimeter/OAT, explanation last', () => {
        const order = [...panel._el.children].map((c) => c.className);
        expect([...$('.vne-inputs--speed').querySelectorAll('.vne-field')].map((f) => f.dataset.field)).toEqual(['kias', 'alt']);
        expect(order).toEqual(['vne-card-head', 'vne-inputs vne-inputs--speed', 'vne-result', 'vne-inputs', 'vne-explain']);
        const result = $('.vne-result');
        for (const k of ['vne', 'va', 'status', 'tas']) expect(result.contains(out(k)), k).toBe(true);
        const explain = $('.vne-explain');
        for (const k of ['governs', 'weight', 'da', 'pec', 'source']) expect(explain.contains(out(k)), k).toBe(true);
        expect(explain.querySelector('.vne-footnote')).not.toBeNull();
        expect(explain.querySelector('.vne-ref')).not.toBeNull();
    });

    it('with nothing entered: dashes and a prompt naming all three, no NaN', () => {
        expect(out('vne').textContent).toBe('—');
        expect(out('va').textContent).toBe('—');
        expect(out('governs').textContent).toBe('Enter altimeter, altitude and OAT');
        expect(out('weight').textContent).toBe('Enter weights in W&B for Va.');
        expect(visibleText()).not.toMatch(/NaN|undefined|Infinity|null/);
    });

    it('shows Vno/Vfe, the position-error label and the footnote', () => {
        const t = panel._el.textContent;
        expect(t).toContain('Vno 156 · Vfe 78 KIAS');
        expect(out('pec').textContent).toBe('IAS ≈ CAS. Position error not applied.');
        expect(t).toContain('Reference only. The POH and placards govern. Use OAT, not TAT. At 180 kt, ram rise reads 3–4 °C high, which makes the result conservative.');
    });
});

describe('Vne here', () => {
    it('8000 ft at 29.92, 32 °F: 161 KIAS, 182 KTAS governs; pressure/density alt shown', () => {
        enter8000();
        expect(out('vne').textContent).toBe('161');
        expect(out('governs').textContent).toBe('182 KTAS governs');
        expect(out('da').textContent).toMatch(/^Pressure alt 8,000 ft · Density alt [\d,]+ ft · ISA \+0\.8 °C$/);
    });

    it('sea level standard: 182 KIAS governs', () => {
        type('altimeter', '29.92'); type('alt', '0'); type('oatF', '59');
        expect(out('vne').textContent).toBe('182');
        expect(out('governs').textContent).toBe('182 KIAS governs');
    });

    it('the altimeter setting moves the answer (12,000 ft, 28.92 vs 30.92)', () => {
        type('alt', '12000'); type('oatF', '15');
        type('altimeter', '30.92');
        const hi = Number(out('vne').textContent);
        type('altimeter', '28.92');
        const lo = Number(out('vne').textContent);
        expect(lo).toBeLessThan(hi);
    });

    it('an altimeter typed without its decimal is rejected with its range', () => {
        type('alt', '8000'); type('oatF', '32'); type('altimeter', '3012');
        expect(out('vne').textContent).toBe('—');
        expect($('[data-err="altimeter"]').textContent).toBe('Out of range: 27.50 to 31.50 inHg');
        expect(out('governs').textContent).toBe('Check the highlighted entry');
    });

    it('a pressure altitude past 18,000 ft is rejected on the altitude field, not clamped', () => {
        type('altimeter', '28.50'); type('alt', '18000'); type('oatF', '0');
        expect(out('vne').textContent).toBe('—');
        expect($('[data-err="alt"]').textContent).toBe('Pressure altitude 19,180 ft is out of range: −1,000 to 18,000 ft');
    });

    it('an absurd altitude says out of range, not "Enter altitude"', () => {
        type('altimeter', '29.92'); type('alt', '150000'); type('oatF', '32');
        expect($('[data-err="alt"]').textContent).toBe('Out of range: pressure altitude −1,000 to 18,000 ft');
        expect(out('governs').textContent).toBe('Check the highlighted entry');
    });

    it('°F out of range gives the °F range', () => {
        type('altimeter', '29.92'); type('alt', '8000'); type('oatF', '130');
        expect($('[data-err="oatF"]').textContent).toBe('Out of range: −76 to +122 °F');
    });

    it('garbage in any field never puts NaN on screen', () => {
        for (const [a, h, o, k] of [['abc', '8000', '32', ''], ['29.92', '-', 'x', '1e9'], ['-', '-', '-', '-'],
            ['31.5', '18000', '122', '300'], ['27.5', '-1000', '-76', '1'], ['29.92', '8000', '999', '140']]) {
            type('altimeter', a); type('alt', h); type('oatF', o); type('kias', k);
            expect(visibleText(), `${a}/${h}/${o}/${k}`).not.toMatch(/NaN|undefined|Infinity/);
        }
    });

    it('a config vne_kt below 182 lowers the limit', () => {
        vneKt = 175;
        type('altimeter', '29.92'); type('alt', '0'); type('oatF', '59');
        expect(out('vne').textContent).toBe('175');
    });
});

describe('Va for weight', () => {
    it('saved W&B weights + tracked fuel: 1,534 lb → Va 94, weights listed', () => {
        saveWeights({ Pilot: '190', Passenger: '170', Baggage: '20' });
        fuel = { gallons: 20, stale: false };
        open();
        expect(out('va').textContent).toBe('94');
        expect(out('weight').textContent).toBe('Weight 1,534 lb · Pilot 190 · Passenger 170 · Baggage 20 · Fuel 20.0 gal');
    });

    it('untracked fuel is left out (lower Va) and said so', () => {
        saveWeights({ Pilot: '190', Passenger: '170', Baggage: '20' });
        fuel = null;
        open();
        expect(out('va').textContent).toBe('90');
        expect(out('weight').textContent).toBe('Weight 1,414 lb · Pilot 190 · Passenger 170 · Baggage 20 · fuel not counted (not tracked)');
    });

    it('stale fuel is left out too (it reads high)', () => {
        saveWeights({ Pilot: '190', Passenger: '170', Baggage: '20' });
        fuel = { gallons: 20, stale: true };
        open();
        expect(out('va').textContent).toBe('90');
        expect(out('weight').textContent).toContain('fuel not counted (tracking not current)');
    });

    it('a zero passenger is listed, so an old passenger weight would be visible', () => {
        saveWeights({ Pilot: '190', Passenger: '', Baggage: '' });
        fuel = { gallons: 0, stale: false };
        open();
        expect(out('va').textContent).toBe('84');   // 1,224 lb
        expect(out('weight').textContent).toBe('Weight 1,224 lb · Pilot 190 · Passenger 0 · Baggage 0 · Fuel 0.0 gal');
    });

    it('no pilot weight: no Va, even with fuel tracked', () => {
        saveWeights({ Pilot: '', Passenger: '170', Baggage: '' });
        fuel = { gallons: 30, stale: false };
        open();
        expect(out('va').textContent).toBe('—');
        expect(out('weight').textContent).toBe('Enter weights in W&B for Va.');
    });

    it('over gross: Va 102 with a warning in the weight line', () => {
        saveWeights({ Pilot: '400', Passenger: '400', Baggage: '50' });
        fuel = { gallons: 36, stale: false };
        open();
        expect(out('va').textContent).toBe('102');
        expect(out('weight').textContent).toMatch(/^⚠ Over gross \(1,800 lb\)\. Weight 2,100 lb/);
    });

    it('Va does not need altitude or OAT', () => {
        saveWeights({ Pilot: '190' });
        fuel = { gallons: 0, stale: false };
        open();
        expect(out('vne').textContent).toBe('—');
        expect(out('va').textContent).toBe('84');
    });

    it('W&B edits and fuel events update Va without reopening', () => {
        saveWeights({ Pilot: '190' });
        fuel = { gallons: 0, stale: false };
        open();
        expect(out('va').textContent).toBe('84');
        saveWeights({ Pilot: '190', Passenger: '170', Baggage: '20' });
        window.dispatchEvent(new CustomEvent('wb:weightschanged'));
        expect(out('va').textContent).toBe('90');
        fuel = { gallons: 20, stale: false };
        window.dispatchEvent(new CustomEvent('fueltankstate:changed'));
        expect(out('va').textContent).toBe('94');
    });

    it('a corrupt saved weight is ignored, not guessed', () => {
        localStorage.setItem('flypi_wb_station_weights', '{"Pilot":"1e3"}');
        open();
        expect(out('va').textContent).toBe('—');
    });
});

describe('KIAS', () => {
    beforeEach(() => enter8000());

    it('KIAS: TAS rounded up, margin, OK state with icon and text', () => {
        type('kias', '140');
        expect(out('tas').textContent).toBe('140 KIAS = 158 KTAS');
        expect(out('status').textContent).toBe('✓ WITHIN VNE · margin 21 kt');
        expect(out('status').classList.contains('vne-status--ok')).toBe(true);
    });

    it('exactly at Vne here warns; above it says by how much', () => {
        type('kias', '161');
        expect(out('status').textContent).toBe('⚠ AT VNE · margin 0 kt');
        expect($('.vne-result').classList.contains('vne-result--warn')).toBe(true);
        type('kias', '170');
        expect(out('status').textContent).toBe('⚠ OVER VNE by 9 kt');
        type('kias', '160');
        expect($('.vne-result').classList.contains('vne-result--warn')).toBe(false);
    });

    it('empty KIAS hides its lines; the clear button empties it; a bad one shows its error', () => {
        expect(out('tas').hidden).toBe(true);
        expect(out('status').hidden).toBe(true);
        type('kias', '140');
        tap($('[data-field="kias"] .vne-clear'));
        expect(input('kias').value).toBe('');
        expect(out('status').hidden).toBe(true);
        type('kias', '0');
        expect($('[data-err="kias"]').textContent).toBe('Out of range: 1 to 300 kt');
    });
});

describe('step buttons and ±', () => {
    it('altimeter ±0.01: empty starts at 29.92, two decimals, clamped at 31.50', () => {
        tap(stepBtn('altimeter', '0.01'));
        expect(input('altimeter').value).toBe('29.93');
        tap(stepBtn('altimeter', '-0.01'));
        tap(stepBtn('altimeter', '-0.01'));
        expect(input('altimeter').value).toBe('29.91');
        type('altimeter', '31.50');
        tap(stepBtn('altimeter', '0.01'));
        expect(input('altimeter').value).toBe('31.50');
    });

    it('altitude ±500, clamped at the ends', () => {
        tap(stepBtn('alt', '500'));
        expect(input('alt').value).toBe('500');
        type('alt', '17800');
        tap(stepBtn('alt', '500'));
        expect(input('alt').value).toBe('18000');
    });

    it('OAT °F ±1: empty starts from ISA at the entered altitude', () => {
        type('alt', '8000');
        tap(stepBtn('oatF', '1'));
        expect(input('oatF').value).toBe('31');   // ISA at 8,000 ft = 30.5 °F → 30, + 1
    });

    it('± flips the OAT sign', () => {
        type('oatF', '12');
        tap($('[data-field="oatF"] .vne-sign'));
        expect(input('oatF').value).toBe('-12');
    });
});

describe('persistence', () => {
    it('keeps the last entered values between sessions', () => {
        type('altimeter', '30.12'); type('alt', '8000'); type('oatF', '41'); type('kias', '140');
        open();
        expect(input('altimeter').value).toBe('30.12');
        expect(input('alt').value).toBe('8000');
        expect(input('oatF').value).toBe('41');
        expect(input('kias').value).toBe('140');
        expect(out('vne').textContent).not.toBe('—');
    });

    it('corrupt or wrong-shaped stored data opens empty without throwing', () => {
        for (const raw of ['{not json', '"a string"', '[1,2]', '{"alt":8000,"oat":"5","oatUnit":"C"}']) {
            localStorage.setItem('flypi_vne_inputs', raw);
            open();
            expect(input('alt').value).toBe('');
            expect(visibleText()).not.toMatch(/NaN|undefined|Infinity/);
        }
    });
});

describe('summary and change events (for the pill)', () => {
    it('summary gives Vne, Va and the altitude entered; change fires on edits', () => {
        saveWeights({ Pilot: '190', Passenger: '170', Baggage: '20' });
        fuel = { gallons: 20, stale: false };
        open();
        let n = 0;
        panel.addEventListener('change', () => { n++; });
        enter8000();
        expect(n).toBe(3);
        expect(panel.summary()).toEqual({ ok: true, vneKias: 161, vaKias: 94, altFt: 8000, overGross: false });
        type('alt', '');
        expect(panel.summary()).toEqual({ ok: false, vneKias: null, vaKias: 94, altFt: null, overGross: false });
    });

    it('destroy stops listening and removes the card', () => {
        panel.destroy();
        expect(document.querySelector('.vne-card')).toBeNull();
        let n = 0;
        panel.addEventListener('change', () => { n++; });
        window.dispatchEvent(new CustomEvent('wb:weightschanged'));
        expect(n).toBe(0);
        panel = null;
    });
});

describe('live data hook (no serial link yet)', () => {
    it('setInputs with a pressure altitude fills 29.92 and that altitude; not saved', () => {
        panel.setInputs({ pressureAltFt: 8000, oatC: 0, kias: 140 }, 'D-180');
        expect(input('altimeter').value).toBe('29.92');
        expect(input('alt').value).toBe('8000');
        expect(input('oatF').value).toBe('32');
        expect(out('vne').textContent).toBe('161');
        expect(out('source').textContent).toBe('Live: D-180');
        expect(localStorage.getItem('flypi_vne_inputs')).toBeNull();
        type('kias', '150');
        expect(out('source').textContent).toBe('Manual entry');
        expect(JSON.parse(localStorage.getItem('flypi_vne_inputs')).kias).toBe('150');
    });

    it('setInputs with altimeter + indicated altitude and °F', () => {
        panel.setInputs({ altimeterInHg: 30.1, indicatedAltFt: 6500, oatF: 41 }, 'D-180');
        expect(input('altimeter').value).toBe('30.10');
        expect(input('alt').value).toBe('6500');
        expect(input('oatF').value).toBe('41');
    });
});
