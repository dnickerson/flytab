/**
 * FAA data sync: never record data as current that isn't (2026-10-16 review).
 * A state whose plate zip failed stayed in synced_states, the new cycle and
 * built_at were stamped anyway and plates_cycle_info.json rewritten -- the next
 * sync skipped ("Current"), the badge said CURRENT, and the failed state's
 * airports were listed from the new index while their files were the old cycle's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
globalThis.wireTap = (el, fn) => { if (el) el._tap = fn; };
globalThis.CockpitConfig = { homeBases: ['http://home:8090'], homeBase: 'http://home:8090', raw: {} };
const DataStatus = new Function(read('web/cockpit/data-status.js') + '\nreturn DataStatus;')();

const SERVER = {
    nasr: { effective_date: '2026-10-01', expiration_date: '2026-10-29', bundle_version: 11, sua_count: 1236 },
    cifp: { cycle_code: '261001', effective_date: '2026-10-01', expiration_date: '2026-10-29' },
    plates: { cycle_code: '261001', effective_date: '2026-10-01', expiration_date: '2026-10-29', built_at: '2026-10-17T00:00:00Z',
              state_sizes: [{ state: 'NC', size_mb: 1 }, { state: 'GA', size_mb: 1 }] },
    tiles: {},
};

function setup({ failState = null } = {}) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
        url = String(url);
        calls.push(`${opts.method || 'GET'} ${url}`);
        const J = (o, ok = true, status = 200) => ({ ok, status, json: async () => o, text: async () => JSON.stringify(o), blob: async () => ({ size: 1 }) });
        if (url.endsWith('/nasr/cycle_info.json')) return J({ effective_date: '2026-10-01', sua_count: 1236, bundle_version: 11 });
        if (url.endsWith('/cifp/cifp_cycle_info.json')) return J({ cycle_code: '261001' });
        if (url.includes('/mbtiles/status')) return J([]);
        if (url.startsWith('http://home:8090/plates/plates_cycle_info.json')) return J({ effective_date: '2026-10-01', expiration_date: '2026-10-29', cycle_code: '261001', state_sizes: SERVER.plates.state_sizes });
        if (url.startsWith('http://localhost:9090/plates/plates_cycle_info.json')) return opts.method === 'PUT' ? J({}) : J({ effective_date: '2026-09-03' });
        if (url.includes('/fetch-zip')) {
            if (failState && decodeURIComponent(url).includes(`${failState}.zip`)) return { ok: false, status: 500, text: async () => 'fetch-zip failed: Connection reset' };
            return J({ extracted: 10, bytes: 1, pruned: 3 });
        }
        return J(null, false, 404);
    });
    document.body.innerHTML = '';
    localStorage.clear();
    const ds = new DataStatus(document.body);
    ds._serverManifest = JSON.parse(JSON.stringify(SERVER));
    ds._resolvedBase = 'http://home:8090';
    localStorage.setItem('flytab_device_manifest', JSON.stringify({
        nasr: { effective_date: '2026-10-01', bundle_version: 11 }, cifp: { cycle_code: '261001' }, tiles: {},
        plates: { cycle_code: '260903', built_at: '2026-09-05T00:00:00Z', synced_states: ['NC', 'GA'] },
    }));
    return { ds, calls };
}

describe('plate sync: a failed state is not recorded as current', () => {
    afterEach(() => { delete globalThis.fetch; });

    it('GA fails: GA is not synced, the new cycle is not stamped, the step fails naming GA', async () => {
        const { ds, calls } = setup({ failState: 'GA' });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        const plates = ds._readDeviceManifest().plates;
        expect(plates.synced_states).toEqual(['NC']);
        expect(plates.cycle_code).toBe('260903');                       // not the new cycle
        expect(plates.built_at).toBe('2026-09-05T00:00:00Z');
        expect(calls.some((c) => c.startsWith('PUT http://localhost:9090/plates/plates_cycle_info.json'))).toBe(false);
        const text = document.body.textContent.replace(/\s+/g, ' ');
        expect(text).toMatch(/GA/);
        expect(text).toMatch(/failed/i);
    });

    it('all states succeed: new cycle and built_at stamped, cycle info written', async () => {
        const { ds, calls } = setup();
        await ds._syncAll(null, () => {}, () => {}, () => {});
        const plates = ds._readDeviceManifest().plates;
        expect(plates.cycle_code).toBe('261001');
        expect(plates.built_at).toBe('2026-10-17T00:00:00Z');
        expect(plates.synced_states.sort()).toEqual(['GA', 'NC']);
        expect(calls.some((c) => c.startsWith('PUT http://localhost:9090/plates/plates_cycle_info.json'))).toBe(true);
    });
});

describe('charts: an update when the tablet doesn\'t know its edition, or the server rebuilt it', () => {
    const S = { cycle_date: '2026-09-03', expiration_date: '2026-10-29', built_at: '2026-09-06T02:00:00Z' };
    it('no record on the tablet (TAC from March was never replaced): update', () => {
        const { ds } = setup();
        expect(ds._tileUpdateAvail(S, null)).toBe(true);
        expect(ds._tileUpdateAvail(S, undefined)).toBe(true);
    });
    it('same edition and build: no update; other cycle or a rebuild of the same cycle: update', () => {
        const { ds } = setup();
        expect(ds._tileUpdateAvail(S, { ...S })).toBe(false);
        expect(ds._tileUpdateAvail(S, { ...S, cycle_date: '2026-07-09' })).toBe(true);
        expect(ds._tileUpdateAvail(S, { ...S, built_at: '2026-09-05T00:00:00Z' })).toBe(true);
        expect(ds._tileUpdateAvail(null, { ...S })).toBe(false);          // nothing on the server
    });
});
