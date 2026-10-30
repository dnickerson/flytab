/**
 * Radio frequency tool panel: keypad with the leading "1" assumed, ENTER keeps
 * the frequency (current = top of the history, shown on the map button), tap a
 * history row to make it current again, the Center frequency when provided.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
global.DiagLog = { log: vi.fn() };
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
global.wireTap = wireTap;
const { FreqEntry, FreqHistory } = new Function(read('web/shared/freq-entry.js') + '\nreturn { FreqEntry, FreqHistory };')();
global.FreqEntry = FreqEntry; global.FreqHistory = FreqHistory;
const FreqPanel = new Function(read('web/cockpit/freq-panel.js') + '\nreturn FreqPanel;')();

const tap = (el) => el.click();
function make(sit = { alt_msl: 5500, lat: 34.89, lon: -80.84 }) {
    document.body.innerHTML = '<div class="map-area"></div>';
    const p = new FreqPanel(document.querySelector('.map-area'), { getSituation: () => sit });
    p.onCurrentChange = vi.fn();
    return p;
}
const key = (p, k) => tap(p._el.querySelector(`.freq-key[data-key="${k}"]`));
const typeDigits = (p, s) => [...s].forEach((k) => key(p, k));

describe('FreqPanel', () => {
    beforeEach(() => { localStorage.clear(); vi.useRealTimers(); });

    it('typing 3575 shows 1 + 35.75; ENTER keeps 135.750 as current, with altitude', () => {
        const p = make(); p.show();
        typeDigits(p, '3575');
        expect(p._el.querySelector('.freq-display').textContent).toBe('135.75');
        tap(p._el.querySelector('.freq-enter'));
        expect(p.current).toBe('135.750');
        expect(p.onCurrentChange).toHaveBeenLastCalledWith('135.750');
        expect(FreqHistory.list()[0]).toMatchObject({ mhz: '135.750', altFt: 5500 });
        expect(p._el.querySelector('.freq-display').textContent).toBe('1');    // cleared for the next one
        expect(p._el.querySelector('.freq-row.current .freq-row-mhz').textContent).toBe('135.750');
    });

    it('an invalid frequency is refused with the reason; nothing kept', () => {
        const p = make(); p.show();
        typeDigits(p, '3730');
        tap(p._el.querySelector('.freq-enter'));
        expect(p._el.querySelector('.freq-error').textContent).toBe('Not a COM frequency (118.000–136.975)');
        expect(FreqHistory.list()).toEqual([]);
    });

    it('ENTER is disabled until there is a decimal digit; CLR and ⌫ edit', () => {
        const p = make(); p.show();
        typeDigits(p, '35');
        expect(p._el.querySelector('.freq-enter').disabled).toBe(true);
        typeDigits(p, '7');
        expect(p._el.querySelector('.freq-enter').disabled).toBe(false);
        key(p, '⌫');
        expect(p._el.querySelector('.freq-display').textContent).toBe('135');
        key(p, 'CLR');
        expect(p._el.querySelector('.freq-display').textContent).toBe('1');
    });

    it('tapping an older history row makes it current again; ✕ removes one', () => {
        const p = make(); p.show();
        typeDigits(p, '3575'); tap(p._el.querySelector('.freq-enter'));
        typeDigits(p, '21725'); tap(p._el.querySelector('.freq-enter'));
        expect(p.current).toBe('121.725');
        tap(p._el.querySelector('.freq-row-main[data-mhz="135.750"]'));
        expect(p.current).toBe('135.750');
        tap(p._el.querySelector('.freq-row-del[data-mhz="135.750"]'));
        expect(p.current).toBe('121.725');
        expect(p.onCurrentChange).toHaveBeenLastCalledWith('121.725');
    });

    it('Center frequency: shown when the provider has one; a tap makes it current, labelled', () => {
        const p = make();
        p.setCenterProvider(() => ({ name: 'Atlanta Center', mhz: '135.325', band: 'CENTER · LOW (below FL180)' }));
        p.show();
        expect(p._el.querySelector('.freq-center').hidden).toBe(false);
        expect(p._el.querySelector('.freq-center-mhz').textContent).toBe('135.325');
        tap(p._el.querySelector('.freq-center-btn'));
        expect(FreqHistory.list()[0]).toMatchObject({ mhz: '135.325', label: 'Atlanta Center' });
    });

    it('no provider, or nothing here: the Center section stays hidden; text is escaped', () => {
        const p = make(); p.show();
        expect(p._el.querySelector('.freq-center').hidden).toBe(true);
        p.setCenterProvider(() => ({ name: '<img src=x>', mhz: '135.325' }));
        expect(p._el.querySelector('.freq-center-name').innerHTML).toBe('&lt;img src=x&gt;');
    });
});
