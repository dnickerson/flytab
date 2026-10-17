/**
 * Approach procedures (CIFP) must be the synced cycle's (2026-10-16 review).
 * The bundle cached in IndexedDB (cifp_bundle_v2) was used at every start and
 * never replaced: every later load ran only `if (!this._cifpBundle)`, and a
 * CIFP sync rewrote cifp/ on disk without touching the cache -- procedures for
 * the route and the plate viewer stayed on whichever cycle was first cached
 * while Data Status said "NASR + CIFP current".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = globalThis.wireTap || ((el, fn) => el && el.addEventListener && el.addEventListener('click', fn));
const ApproachCharts = new Function(read('web/cockpit/approach-charts.js') + '\nreturn ApproachCharts;')();

const OLD = { KRDU: { procedures: [{ name: 'R05L-OLD' }] } };
const NEW = { KRDU: { procedures: [{ name: 'R05L' }] } };

function harness({ cached, cachedCycle, diskCycle }) {
    const store = { cifp_bundle_v2: cached, cifp_bundle_v2_cycle: cachedCycle };
    const urls = [];
    globalThis.fetch = vi.fn(async (url) => {
        urls.push(String(url));
        if (/cifp_cycle_info\.json/.test(url)) {
            return diskCycle ? { ok: true, status: 200, json: async () => ({ cycle_code: diskCycle, effective_date: '2026-10-01', expiration_date: '2026-10-29' }) }
                : { ok: false, status: 404, json: async () => ({}) };
        }
        if (/cifp_bundle\.json/.test(url)) return { ok: true, status: 200, json: async () => NEW };
        return { ok: false, status: 404, json: async () => ({}) };
    });
    const c = Object.create(ApproachCharts.prototype);
    c._routeAirports = [];
    c._nasrDb = {
        getAppCache: vi.fn(async (k) => store[k] ?? null),
        putAppCache: vi.fn(async (k, v) => { store[k] = v; }),
    };
    return { c, store, urls };
}

describe('CIFP procedures: the synced cycle, not an old cache', () => {
    afterEach(() => { delete globalThis.fetch; });

    it('a cache of an older cycle is replaced from the tablet\'s files at start', async () => {
        const { c, store } = harness({ cached: OLD, cachedCycle: '260903', diskCycle: '261001' });
        await c.loadIndex();
        expect((await c.proceduresFor('KRDU')).procs[0].name).toBe('R05L');
        expect(store.cifp_bundle_v2).toBe(NEW);
        expect(store.cifp_bundle_v2_cycle).toBe('261001');
        expect(c.cifpCycle()?.cycle_code).toBe('261001');
    });

    it('a cache saved before cycles were recorded (today\'s tablets) is replaced too', async () => {
        const { c } = harness({ cached: OLD, cachedCycle: null, diskCycle: '261001' });
        await c.loadIndex();
        expect((await c.proceduresFor('KRDU')).procs[0].name).toBe('R05L');
    });

    it('a cache of the same cycle is used (no 14 MB reload)', async () => {
        const { c, urls } = harness({ cached: OLD, cachedCycle: '261001', diskCycle: '261001' });
        await c.loadIndex();
        expect((await c.proceduresFor('KRDU')).procs[0].name).toBe('R05L-OLD');
        expect(urls.some((u) => /cifp_bundle\.json/.test(u))).toBe(false);
    });

    it('after a sync the procedures (and plate index) are loaded again', async () => {
        const { c, store } = harness({ cached: OLD, cachedCycle: '261001', diskCycle: '261001' });
        await c.loadIndex();
        c._refreshIndex = vi.fn(async () => {});
        await c.reloadAfterSync();
        expect((await c.proceduresFor('KRDU')).procs[0].name).toBe('R05L');
        expect(store.cifp_bundle_v2).toBe(NEW);
        expect(c._refreshIndex).toHaveBeenCalled();
    });

    it('Data Status reloads them after the aeronautical and plates steps', () => {
        const src = read('web/cockpit/data-status.js');
        const sync = src.slice(src.indexOf('    async _syncAll('), src.indexOf('    _wireDoneBtn() {'));
        expect(sync).toMatch(/approachCharts\?\.reloadAfterSync\?\.\(\)/);
    });
});
