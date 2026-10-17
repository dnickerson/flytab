/**
 * The tablet syncs only FAA data the home server's audit passed -- and only a
 * verdict that still describes it (pre-merge review, 2026-10-16). It used to
 * sync when the manifest couldn't be read, when there was no verdict, and on
 * any old "ok": a failed build or a crashed audit left yesterday's pass, admin
 * builds were never audited, and the expiry check was never consulted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = (el, fn) => { if (el) el._tap = fn; };
globalThis.CockpitConfig = { homeBases: ['http://home:8090'], homeBase: 'http://home:8090', raw: {} };
const DataStatus = new Function(read('web/cockpit/data-status.js') + '\nreturn DataStatus;')();

const ok = { ok: true, failures: [] };
const MANIFEST = () => ({
    nasr: { built_at: '2026-10-16T16:59:50Z' },
    cifp: { built_at: '2026-09-27T13:01:33Z' },
    plates: { built_at: '2026-10-17T01:32:38Z', cycle_code: '261001' },
    tiles: { sectional: { built_at: '2026-09-06T02:00:14Z', packed_at: '2026-09-06T02:45:44Z' } },
    audit: { ok: true, checked_at: '2026-10-17T02:00:00Z', for_date: '2026-10-16', cycle: '2610', valid_until: '2026-10-29',
             products: { plates: ok, cifp: ok, nasr: ok, charts: ok, afd: ok, expiry: ok } },
});
const P = (m, product, today = '2026-10-16') => DataStatus.auditProblem(m, product, today);

describe('audit gate', () => {
    it('a current passing verdict: synced', () => {
        for (const p of ['nasr', 'cifp', 'plates', 'charts:sectional']) expect(P(MANIFEST(), p)).toBe(null);
    });
    it('no manifest, no verdict, a pending build or a crashed audit: not synced', () => {
        expect(P(null, 'nasr')).toMatch(/could not be read/);
        const m = MANIFEST(); delete m.audit;
        expect(P(m, 'nasr')).toMatch(/not been checked/);
        expect(P({ ...MANIFEST(), audit: { ok: false, pending: true, error: 'home server build in progress (plates)' } }, 'plates')).toMatch(/building/);
        expect(P({ ...MANIFEST(), audit: { ok: false, error: 'audit crashed: JSONDecodeError' } }, 'nasr')).toMatch(/crashed/);
    });
    it('a verdict for an earlier cycle: not synced from its valid_until day', () => {
        expect(P(MANIFEST(), 'nasr', '2026-10-28')).toBe(null);
        expect(P(MANIFEST(), 'nasr', '2026-10-29')).toMatch(/2026-10-29/);
    });
    it('the product, or the expiry check, failed: not synced', () => {
        const m = MANIFEST(); m.audit.products.afd = { ok: false, failures: ['A/FD page images not rendered'] };
        expect(P(m, 'plates')).toMatch(/A\/FD page images not rendered/);     // A/FD travels in the plate zips
        expect(P(m, 'nasr')).toBe(null);
        const e = MANIFEST(); e.audit.products.expiry = { ok: false, failures: ['tac expired 2026-09-03'] };
        expect(P(e, 'nasr')).toMatch(/tac expired/);
        const n = MANIFEST(); delete n.audit.products.cifp;
        expect(P(n, 'cifp')).toMatch(/not been checked/);
    });
    it('built after its last check (an admin build, a script run by hand): not synced', () => {
        const m = MANIFEST(); m.plates.built_at = '2026-10-17T03:00:00Z';
        expect(P(m, 'plates')).toMatch(/built after/);
        expect(P(m, 'nasr')).toBe(null);
        const t = MANIFEST(); t.tiles.sectional.packed_at = '2026-10-17T05:00:00Z';
        expect(P(t, 'charts:sectional')).toMatch(/built after/);
    });
});

describe('sync reads the manifest itself', () => {
    afterEach(() => { delete globalThis.fetch; });

    it('manifest unreadable at sync time: nothing is downloaded', async () => {
        const calls = [];
        globalThis.fetch = vi.fn(async (url, opts = {}) => {
            calls.push(`${opts.method || 'GET'} ${url}`);
            if (String(url).includes('/mbtiles/status')) return { ok: true, json: async () => [] };
            return { ok: false, status: 503, json: async () => null, text: async () => '' };
        });
        document.body.innerHTML = '';
        localStorage.clear();
        const ds = new DataStatus(document.body);
        ds._serverManifest = MANIFEST();               // a stale snapshot from when the page opened
        ds._resolvedBase = 'http://home:8090';
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(calls.some((c) => c.includes('/fetch-zip') || c.includes('/fetch-mbtiles'))).toBe(false);
        expect(document.body.textContent).toMatch(/could not be read/);
    });
});
