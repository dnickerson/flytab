/**
 * A/FD tab currency line (final review 2026-10-17): sync prunes only the airport
 * folders a state zip has, so an airport in a state no longer synced keeps its
 * last A/FD page. It showed under the sync's "expires ..." line as if current.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = globalThis.wireTap || ((el, fn) => el && el.addEventListener && el.addEventListener('click', fn));
globalThis.FaaCurrency = new Function(read('web/shared/faa-currency.js') + '\nreturn FaaCurrency;')();
const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();

function afdLine(icao, state) {
    const imgs = [];
    const real = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag, o) => {
        const el = real(tag, o);
        if (tag === 'img') imgs.push(el);
        return el;
    });
    const el = document.createElement('div');
    const p = Object.create(AirportPopup.prototype);
    p._loadAfdPane(el, icao, state);
    spy.mockRestore();
    imgs[0].onload();                                   // the page image loaded
    return el.querySelector('.approach-currency');
}

describe('A/FD tab currency line', () => {
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
    const dm = (synced) => localStorage.setItem('flytab_device_manifest', JSON.stringify({
        afd: { expiration_date: '2026-10-29', stale: false },
        plates: { cycle_code: '261001', expiration_date: '2026-10-29', synced_states: synced } }));

    it('an airport in a synced state: the sync\'s expiry', () => {
        vi.useFakeTimers({ now: new Date('2026-10-20T12:00:00Z') });
        dm(['NC', 'SC']);
        const l = afdLine('K9A9', 'NC');
        expect(l.textContent).toMatch(/expires 29 OCT 2026/);
        expect(l.classList.contains('is-bad')).toBe(false);
    });

    it('an airport in a state no longer synced: not current, red', () => {
        vi.useFakeTimers({ now: new Date('2026-10-20T12:00:00Z') });
        dm(['NC', 'SC']);
        const l = afdLine('KPBI', 'FL');
        expect(l.textContent).toBe('A/FD page not current — FL is not synced to this tablet');
        expect(l.classList.contains('is-bad')).toBe(true);
    });

    it('no state known or nothing synced yet: unchanged behaviour', () => {
        vi.useFakeTimers({ now: new Date('2026-10-20T12:00:00Z') });
        dm(['NC']);
        expect(afdLine('KXYZ', undefined).textContent).toMatch(/expires 29 OCT 2026/);
        dm([]);
        expect(afdLine('KPBI', 'FL').textContent).toMatch(/expires 29 OCT 2026/);
    });
});
