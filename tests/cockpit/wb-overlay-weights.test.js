/**
 * W&B station weights are kept until changed (Dana 2026-11-13): the Vne/Va map pill works Va
 * out from them, so they must survive an app restart. Fuel is never saved (it keeps coming
 * from the fuel tracker, see wb-overlay-fuel.test.js).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.Settings = new Function(read('web/shared/settings.js') + '\nreturn Settings;')();
globalThis.WbCalculator = new Function(read('web/shared/wb-calculator.js') + '\nreturn WbCalculator;')();
const WbOverlay = new Function(read('web/cockpit/wb-overlay.js') + '\nreturn WbOverlay;')();
const AC = JSON.parse(read('web/aircraft-config.json'));

const type = (input, value) => {
    input.value = String(value);
    input.dispatchEvent(new window.Event('input'));
};
const open = () => {
    document.body.innerHTML = '';
    const o = new WbOverlay(document.body);
    o.show();
    return o;
};

beforeEach(() => {
    localStorage.clear();
    globalThis.wireTap = () => {};
    globalThis.FuelState = { getCurrentFuel: () => ({ gallons: 36, source: 'capacity', stale: false }) };
    globalThis.CockpitConfig = {
        get: () => null,
        aircraft: (p) => (p === 'weight_balance' ? AC.weight_balance : (p === 'tail' ? 'N194JT' : undefined)),
    };
    window.Chart = class { constructor(c, cfg) { this.data = cfg.data; } update() {} resize() {} };
});

describe('W&B station weights are kept until changed', () => {
    it('pilot, passenger and baggage come back after a restart', () => {
        let o = open();
        type(o._inputs.Pilot, 190);
        type(o._inputs.Passenger, 170);
        type(o._inputs.Baggage, 20);
        o = open();
        expect(o._inputs.Pilot.value).toBe('190');
        expect(o._inputs.Passenger.value).toBe('170');
        expect(o._inputs.Baggage.value).toBe('20');
        expect(o._resultsEl.textContent).toContain('1,414');   // 1034 + 190 + 170 + 20, fuel untracked
    });

    it('clearing a field is saved too (solo after a passenger flight)', () => {
        let o = open();
        type(o._inputs.Passenger, 170);
        type(o._inputs.Passenger, '');
        o = open();
        expect(o._inputs.Passenger.value).toBe('');
        expect(Settings.wbStationWeights.Passenger).toBe('');
    });

    it('fuel is never saved', () => {
        const o = open();
        type(o._fuelInput, 20);
        type(o._inputs.Pilot, 190);
        expect(JSON.stringify(Settings.wbStationWeights)).not.toContain('20.');
        expect(Object.keys(Settings.wbStationWeights).sort()).toEqual(['Baggage', 'Passenger', 'Pilot']);
    });

    it('each edit fires wb:weightschanged', () => {
        const o = open();
        let n = 0;
        const h = () => { n++; };
        window.addEventListener('wb:weightschanged', h);
        type(o._inputs.Pilot, 190);
        type(o._inputs.Pilot, 195);
        window.removeEventListener('wb:weightschanged', h);
        expect(n).toBe(2);
    });

    it('corrupt or odd stored values open empty, never guessed', () => {
        for (const raw of ['{not json', '"x"', '[1]', '{"Pilot":"1e3","Passenger":"-5","Baggage":"abc"}',
            '{"Pilot":12345}', '{"Pilot":null}']) {
            localStorage.setItem('flypi_wb_station_weights', raw);
            const o = open();
            expect(o._inputs.Pilot.value, raw).toBe('');
            expect(o._inputs.Passenger.value, raw).toBe('');
            expect(o._inputs.Baggage.value, raw).toBe('');
        }
    });
});

describe('WbCalculator.savedWeightText', () => {
    it('accepts plain non-negative numbers only', () => {
        const s = { a: '190', b: 170.5, c: ' 20 ', d: '0', e: '190.25', f: '190.255', g: '', h: '-1', i: NaN };
        expect(WbCalculator.savedWeightText(s, 'a')).toBe('190');
        expect(WbCalculator.savedWeightText(s, 'b')).toBe('170.5');
        expect(WbCalculator.savedWeightText(s, 'c')).toBe('20');
        expect(WbCalculator.savedWeightText(s, 'd')).toBe('0');
        expect(WbCalculator.savedWeightText(s, 'e')).toBe('190.25');
        for (const k of ['f', 'g', 'h', 'i', 'missing']) expect(WbCalculator.savedWeightText(s, k)).toBe('');
        expect(WbCalculator.savedWeightText(null, 'a')).toBe('');
    });
});
