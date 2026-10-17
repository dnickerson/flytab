/**
 * In-flight FAA currency (round 2 review, 2026-10-17): the status-bar badge,
 * startup banner and preflight check covered NASR only, with a "0d" badge all
 * of expiry day. Now all four products (NASR, CIFP, plates, A/FD), from the
 * tablet's own record, expiring at 0901Z.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.FaaCurrency = new Function(read('web/shared/faa-currency.js') + '\nreturn FaaCurrency;')();
globalThis.RouteCheck = globalThis.RouteCheck || {};
const FlyTabApp = new Function(read('web/app.js') + '\nreturn FlyTabApp;')();
const PreflightCheck = new Function(read('web/cockpit/preflight-check.js') + '\nreturn PreflightCheck;')();

const DEV = {
    nasr: { effective_date: '2026-10-29', expiration_date: '2026-11-26' },
    cifp: { cycle_code: '261029', expiration_date: '2026-11-26' },
    plates: { cycle_code: '261001', expiration_date: '2026-10-29', synced_states: ['NC'], failed_states: [] },
    afd: { expiration_date: '2026-12-24', stale: false },
};
const NASR_IDB = { effective_date: '2026-10-29', expiration_date: '2026-11-26' };

describe('status-bar badge: every FAA product', () => {
    beforeEach(() => { localStorage.setItem('flytab_device_manifest', JSON.stringify(DEV)); });
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

    it('NASR current, plates expired: the badge says so', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z') });
        const el = document.createElement('span');
        await FlyTabApp.prototype._updateNasrBadge.call({ dom: { statusNasr: el }, _nasrDb: { getCycleInfo: async () => NASR_IDB } });
        expect(el.textContent).toBe('PLATES EXP');
        expect(el.className).toMatch(/nasr-expired/);
    });

    it('expiry day before 0901Z: days, after: EXP (never "0d")', async () => {
        const el = document.createElement('span');
        const self = { dom: { statusNasr: el }, _nasrDb: { getCycleInfo: async () => ({ effective_date: '2026-10-01', expiration_date: '2026-10-29' }) } };
        localStorage.setItem('flytab_device_manifest', JSON.stringify({ ...DEV, plates: { ...DEV.plates, expiration_date: '2026-11-26' } }));
        vi.useFakeTimers({ now: new Date('2026-10-29T10:00:00Z') });
        await FlyTabApp.prototype._updateNasrBadge.call(self);
        expect(el.textContent).toBe('NASR EXP');
    });
});

describe('pre-flight check: plates and procedures too', () => {
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); delete globalThis.fetch; document.body.innerHTML = ''; });

    it('there is no startup banner any more: the pre-flight check covers FAA data (Dana, 2026-10-17)', () => {
        expect(FlyTabApp.prototype._checkDataReadiness).toBeUndefined();
        expect(readFileSync('web/app.js', 'utf8')).not.toMatch(/_checkDataReadiness|dataReadinessBanner/);
    });

    it('preflight FAA Data row fails on expired plates', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z') });
        localStorage.setItem('flytab_device_manifest', JSON.stringify(DEV));
        const r = await PreflightCheck.prototype._checkNasr.call({ db: { getCycleInfo: async () => NASR_IDB } });
        expect(r).toMatchObject({ label: 'FAA Data', status: 'fail' });
        expect(r.msg).toMatch(/PLATES/);
    });
});

describe('after the upgrade, before the first sync: "expiry not recorded", not "not synced"', () => {
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
    it('preflight wording', async () => {
        vi.useFakeTimers({ now: new Date('2026-10-17T15:00:00Z') });
        localStorage.setItem('flytab_device_manifest', JSON.stringify({ cifp: { cycle_code: '261001' }, plates: { cycle_code: '261001' } }));
        const r = await PreflightCheck.prototype._checkNasr.call({ db: { getCycleInfo: async () => ({ effective_date: '2026-10-01', expiration_date: '2026-10-29' }) } });
        expect(r.msg).toMatch(/CIFP expiry not recorded/);
        expect(r.msg).not.toMatch(/not synced/);
    });
});


describe('the day before a new cycle: the pre-flight FAA Data row says so', () => {
    const TZ0 = process.env.TZ;
    beforeEach(() => { process.env.TZ = 'America/New_York'; });
    afterEach(() => { if (TZ0 === undefined) delete process.env.TZ; else process.env.TZ = TZ0; });
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
    const rowAt = async (iso) => {
        vi.useFakeTimers({ now: new Date(iso) });
        localStorage.setItem('flytab_device_manifest', JSON.stringify({
            cifp: { expiration_date: '2026-10-29' }, plates: { expiration_date: '2026-10-29' }, afd: { expiration_date: '2026-12-24' } }));
        return PreflightCheck.prototype._checkNasr.call({ db: { getCycleInfo: async () => ({ effective_date: '2026-10-01', expiration_date: '2026-10-29' }) } });
    };
    it('one message with the local changeover time, instead of "0d left"', async () => {
        const r = await rowAt('2026-10-28T20:00:00Z');                       // 16:00 EDT, 13 h before
        expect(r.status).toBe('warn');
        expect(r.msg.match(/New FAA cycle at/g)).toHaveLength(1);
        expect(r.msg).toContain('New FAA cycle at 05:01 tomorrow (0901Z) — sync on home WiFi before flying');
        expect(r.msg).not.toMatch(/0d left/);
    });
    it('says "today" after local midnight on the cycle date (01:00 EDT, change at 05:01)', async () => {
        const r = await rowAt('2026-10-29T05:00:00Z');
        expect(r.msg).toContain('New FAA cycle at 05:01 today (0901Z) — sync on home WiFi before flying');
        expect(r.msg).not.toMatch(/tomorrow/);
    });
    it('more than a day ahead: days left as before', async () => {
        const r = await rowAt('2026-10-26T12:00:00Z');
        expect(r.msg).toMatch(/2d left/);
        expect(r.msg).not.toMatch(/New FAA cycle/);
    });
    it('changeoverLocal is the device\'s local time of 0901Z', () => {
        const d = new Date('2026-10-29T09:01:00Z');
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        expect(FaaCurrency.changeoverLocal('2026-10-29')).toBe(hhmm);
    });
});
