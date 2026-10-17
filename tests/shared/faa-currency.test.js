/**
 * FAA data currency on the tablet, offline (round 2 review, 2026-10-17): in
 * flight nothing said plates, procedures or A/FD had expired -- Data Status
 * showed CURRENT, the badge covered NASR only and read "0d" all expiry day.
 * FaaCurrency judges each product from what the tablet recorded at sync,
 * expiring at the 0901Z changeover.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const FaaCurrency = new Function(readFileSync('web/shared/faa-currency.js', 'utf8') + '\nreturn FaaCurrency;')();
const at = (iso) => Date.parse(iso);

describe('FaaCurrency', () => {
    it('expires at 0901Z on the expiration date, not midnight', () => {
        expect(FaaCurrency.expiresAt('2026-10-29')).toBe(at('2026-10-29T09:01:00Z'));
        expect(FaaCurrency.status('2026-10-29', at('2026-10-29T09:00:00Z')).state).toBe('expiring');
        expect(FaaCurrency.status('2026-10-29', at('2026-10-29T09:01:00Z')).state).toBe('expired');
    });
    it('days left never reads -0 or 0 once expired', () => {
        const s = FaaCurrency.status('2026-10-29', at('2026-10-29T12:00:00Z'));
        expect(s.state).toBe('expired');
        expect(Object.is(s.daysLeft, -0)).toBe(false);
        expect(FaaCurrency.status('2026-10-29', at('2026-10-21T09:00:00Z'))).toMatchObject({ state: 'current', daysLeft: 8 });
        expect(FaaCurrency.status('2026-10-29', at('2026-10-25T09:00:00Z'))).toMatchObject({ state: 'expiring', daysLeft: 4 });
        expect(FaaCurrency.status(null, at('2026-10-25T09:00:00Z')).state).toBe('unknown');
    });
    it('products from the tablet\'s own record (works offline)', () => {
        const dev = { plates: { cycle_code: '261001', expiration_date: '2026-10-29', failed_states: ['GA'] },
                      cifp: { cycle_code: '261001', expiration_date: '2026-10-29' },
                      afd: { edition: '03SEP2026', expiration_date: '2026-10-29', stale: false } };
        const p = FaaCurrency.products(dev, { effective_date: '2026-10-29', expiration_date: '2026-11-26' }, at('2026-10-30T12:00:00Z'));
        expect(p.map((x) => [x.key, x.state])).toEqual([['nasr', 'current'], ['cifp', 'expired'], ['plates', 'expired'], ['afd', 'expired']]);
        expect(p.find((x) => x.key === 'plates').failedStates).toEqual(['GA']);
    });
    it('the worst product drives the badge', () => {
        const dev = { plates: { expiration_date: '2026-10-29' }, cifp: { expiration_date: '2026-11-26' }, afd: { expiration_date: '2026-12-24' } };
        const b = FaaCurrency.badge(FaaCurrency.products(dev, { expiration_date: '2026-11-26' }, at('2026-10-30T00:00:00Z')));
        expect(b).toEqual({ text: 'PLATES EXP', cls: 'nasr-expired' });
        const ok = FaaCurrency.badge(FaaCurrency.products({ plates: { expiration_date: '2026-11-26' }, cifp: { expiration_date: '2026-11-26' }, afd: { expiration_date: '2026-12-24' } },
            { expiration_date: '2026-11-26' }, at('2026-11-10T00:00:00Z')));
        expect(ok).toEqual({ text: 'FAA 16d', cls: 'nasr-fresh' });
    });
    it('A/FD marked not current at sync, or never synced, is not "current"', () => {
        const p = FaaCurrency.products({ afd: { expiration_date: '2026-12-24', stale: true } }, null, at('2026-11-01T00:00:00Z'));
        expect(p.find((x) => x.key === 'afd').state).toBe('stale');
        expect(p.find((x) => x.key === 'plates').state).toBe('unknown');
        expect(p.find((x) => x.key === 'nasr').state).toBe('unknown');
    });
});
