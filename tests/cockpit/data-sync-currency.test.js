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
        if (url.includes('/verify')) return J(globalThis.__verify || { count: 3, checked: 3, matched: 3, rejected: 0, changed: { count: 0, examples: [] }, missing: { count: 0, examples: [] }, extra: { count: 0, examples: [] } });
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

describe('the home server\'s FAA currency audit gates the sync', () => {
    afterEach(() => { delete globalThis.fetch; });
    const audit = (products) => ({ ok: false, cycle: '2610', products: {
        plates: { ok: true, failures: [] }, cifp: { ok: true, failures: [] }, nasr: { ok: true, failures: [] },
        charts: { ok: true, failures: [] }, afd: { ok: true, failures: [] }, expiry: { ok: true, failures: [] }, ...products } });

    it('plates failed the audit: no plate download, current plates kept, the step says why', async () => {
        const { ds, calls } = setup();
        ds._serverManifest.audit = audit({ plates: { ok: false, failures: ['current FAA charts in no state zip: 1269'] } });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(calls.some((c) => c.includes('/fetch-zip') && c.includes('plates'))).toBe(false);
        expect(ds._readDeviceManifest().plates.cycle_code).toBe('260903');
        expect(document.body.textContent).toMatch(/failed its FAA check.*in no state zip/);
    });

    it('CIFP failed the audit: no aeronautical download', async () => {
        const { ds, calls } = setup();
        ds._serverManifest.audit = audit({ cifp: { ok: false, failures: ['FAA CIFP header says cycle \'2609\''] } });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(calls.some((c) => /cifp\.zip|nasr\.zip|\/nasr\/cycle_info/.test(c) && c.includes('home:8090'))).toBe(false);
        expect(document.body.textContent).toMatch(/failed its FAA check/);
    });

    it('audit passed (or a server without one): syncs as before', async () => {
        const { ds, calls } = setup();
        ds._serverManifest.audit = { ok: true, products: {} };
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(calls.some((c) => c.includes('/fetch-zip'))).toBe(true);
    });
});


describe('after a sync, the tablet checks its files against the home server', () => {
    afterEach(() => { delete globalThis.fetch; delete globalThis.__verify; });

    it('asks the tablet\'s server to verify against the home server\'s checksums.json; all match: ok', async () => {
        const { ds, calls } = setup();
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(calls.some((c) => c.startsWith('POST http://localhost:9090/verify?url=') && decodeURIComponent(c).includes('http://home:8090/checksums.json'))).toBe(true);
        expect(document.body.textContent).toMatch(/All 3 files match the home server/);
    });

    it('differences: the step fails with counts and examples', async () => {
        globalThis.__verify = { count: 17406, checked: 17406, matched: 14815, rejected: 0,
            changed: { count: 2461, examples: ['plates/14A/10308R14.PDF'] }, missing: { count: 130, examples: ['plates/KTMB/00257FROGZ.PDF'] },
            extra: { count: 4060, examples: ['plates/KPBI/00449AD.PDF'] } };
        const { ds } = setup();
        await ds._syncAll(null, () => {}, () => {}, () => {});
        const t = document.body.textContent.replace(/\s+/g, ' ');
        expect(t).toMatch(/2,461 differ/);
        expect(t).toMatch(/130 missing/);
        expect(t).toMatch(/14A\/10308R14\.PDF/);
        expect(t).toMatch(/4,060 old files/);
    });
});

describe('sync step messages are text', () => {
    afterEach(() => { delete globalThis.fetch; });
    it('a failure message from the home server cannot add HTML', async () => {
        const { ds } = setup();
        ds._serverManifest.audit = { ok: false, products: { plates: { ok: false, failures: ['<img src=x onerror=alert(1)>'] } } };
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(document.querySelector('img')).toBeNull();
        expect(document.body.textContent).toMatch(/<img src=x onerror=alert\(1\)>/);
    });
});
