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
globalThis.FaaCurrency = new Function(read('web/shared/faa-currency.js') + '\nreturn FaaCurrency;')();
const DataStatus = new Function(read('web/cockpit/data-status.js') + '\nreturn DataStatus;')();

const SERVER = {
    nasr: { effective_date: '2026-10-01', expiration_date: '2026-10-29', bundle_version: 11, sua_count: 1236 },
    cifp: { cycle_code: '261001', effective_date: '2026-10-01', expiration_date: '2026-10-29' },
    plates: { cycle_code: '261001', effective_date: '2026-10-01', expiration_date: '2026-10-29', built_at: '2026-10-17T00:00:00Z',
              state_sizes: [{ state: 'NC', size_mb: 1 }, { state: 'GA', size_mb: 1 }] },
    tiles: {},
    // A passing verdict that still holds (valid_until far ahead: the tests run on any date).
    audit: { ok: true, checked_at: '2026-10-17T02:00:00Z', cycle: '2610', valid_until: '2099-01-01', products: {
        plates: { ok: true, failures: [] }, cifp: { ok: true, failures: [] }, nasr: { ok: true, failures: [] },
        charts: { ok: true, failures: [] }, afd: { ok: true, failures: [] }, expiry: { ok: true, failures: [] } } },
};

function setup({ failState = null } = {}) {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
        url = String(url);
        calls.push(`${opts.method || 'GET'} ${url}`);
        const J = (o, ok = true, status = 200) => ({ ok, status, json: async () => o, text: async () => JSON.stringify(o), blob: async () => ({ size: 1 }) });
        if (url.startsWith('http://home:8090/nasr/cycle_info.json') && globalThis.__homeNasr) return J(globalThis.__homeNasr);
        if (url.endsWith('/nasr/cycle_info.json')) return J({ effective_date: '2026-10-01', expiration_date: '2026-10-29', sua_count: 1236, bundle_version: 11 });
        if (url === 'http://localhost:9090/nasr/bundle.json') return J({ cycle_info: {} });
        if (url.endsWith('/cifp/cifp_cycle_info.json')) return J({ cycle_code: '261001', effective_date: '2026-10-01', expiration_date: '2026-10-29' });
        // Charts on the tablet and nothing newer on the server: those steps skip.
        if (url.includes('/mbtiles/status')) return J(['sectional', 'ifr-low', 'ifr-area', 'tac'].map((layer) => ({ layer, exists: true, size_mb: 1 })));
        if (url.startsWith('http://home:8090/plates/plates_cycle_info.json')) return J({ effective_date: '2026-10-01', expiration_date: '2026-10-29', cycle_code: '261001', state_sizes: SERVER.plates.state_sizes });
        if (url.startsWith('http://localhost:9090/plates/plates_cycle_info.json')) return opts.method === 'PUT' ? J({}) : J({ effective_date: '2026-09-03' });
        // The sync reads the manifest itself: serve the test's (ds._serverManifest).
        if (url === 'http://home:8090/manifest.json') return J(ds._serverManifest);
        if (url.includes('/verify')) return J(globalThis.__verify || { count: 3, checked: 3, matched: 3, rejected: 0, changed: { count: 0, examples: [] }, missing: { count: 0, examples: [] }, extra: { count: 0, examples: [] } });
        if (url.includes('/fetch-zip')) {
            if (failState && decodeURIComponent(url).includes(`${failState}.zip`)) return { ok: false, status: 500, text: async () => 'fetch-zip failed: Connection reset' };
            return J({ extracted: globalThis.__extracted ?? 10, bytes: 1, pruned: 3 });
        }
        return J(null, false, 404);
    });
    document.body.innerHTML = '';
    localStorage.clear();
    let ds = null;
    ds = new DataStatus(document.body);
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
    const audit = (products) => ({ ok: false, cycle: '2610', checked_at: '2026-10-17T02:00:00Z', valid_until: '2099-01-01', products: {
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

    it('CIFP failed the audit: no CIFP download; NASR is still checked (gated on its own)', async () => {
        const { ds, calls } = setup();
        ds._serverManifest.audit = audit({ cifp: { ok: false, failures: ['FAA CIFP header says cycle \'2609\''] } });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(calls.some((c) => /cifp\.zip|\/cifp\/cifp_cycle_info/.test(c) && c.includes('home:8090'))).toBe(false);
        expect(calls.some((c) => c.includes('home:8090/nasr/cycle_info.json'))).toBe(true);
        expect(document.body.textContent).toMatch(/CIFP data failed its FAA check/);
    });

    it('audit passed: syncs (no verdict at all: see data-sync-audit-gate.test.js -- not synced)', async () => {
        const { ds, calls } = setup();
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

describe('pre-merge review: no false "done"', () => {
    afterEach(() => { delete globalThis.fetch; delete globalThis.__verify; delete globalThis.__extracted; });

    it('a zip with no files is a failed state, not a synced one', async () => {
        globalThis.__extracted = 0;
        const { ds } = setup();
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(ds._readDeviceManifest().plates.cycle_code).toBe('260903');
        expect(document.body.textContent).toMatch(/no files/);
    });

    it('a step failed: the file check is skipped (it would only report what did not sync), and the end is not green', async () => {
        const { ds, calls } = setup({ failState: 'GA' });
        let done = null;
        await ds._syncAll(null, () => {}, () => {}, (msg, color) => { done = { msg, color }; });
        expect(calls.some((c) => c.includes('/verify'))).toBe(false);
        expect(document.body.textContent).toMatch(/Skipped/);
        expect(done.color).not.toBe('var(--status-ok)');
        expect(done.msg).toMatch(/problem|fail/i);
    });

    it('differences point to RE-DOWNLOAD (SYNC skips data whose cycle already matches)', async () => {
        globalThis.__verify = { count: 3, checked: 3, matched: 2, rejected: 0, changed: { count: 1, examples: ['nasr/bundle.json'] },
            missing: { count: 0, examples: [] }, extra: { count: 0, examples: [] } };
        const { ds } = setup();
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(document.body.textContent).toMatch(/RE-DOWNLOAD/);
        expect(document.body.textContent).not.toMatch(/SYNC again/);
    });

    it('a list with no files checked is not "all match"', async () => {
        globalThis.__verify = { count: 0, checked: 0, matched: 0, rejected: 0, changed: { count: 0, examples: [] },
            missing: { count: 0, examples: [] }, extra: { count: 0, examples: [] } };
        const { ds } = setup();
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(document.body.textContent).not.toMatch(/All 0 files match/);
        expect(document.body.textContent).toMatch(/no files/);
    });
});

describe('round 2 review: chart downloads and server reads', () => {
    afterEach(() => { delete globalThis.fetch; });

    it('a single chart layer download goes through the audit gate', async () => {
        const { ds, calls } = setup();
        ds._serverManifest.tiles = { sectional: { cycle_date: '2026-10-29', built_at: '2026-10-29T13:00:00Z' } };
        ds._serverManifest.audit.pending_products = ['charts:sectional'];
        let done = null;
        const btn = document.createElement('button');
        await ds._downloadMbtiles('sectional', btn, () => {}, (msg, color) => { done = { msg, color }; });
        expect(calls.some((c) => c.includes('/fetch-mbtiles'))).toBe(false);
        expect(done.msg).toMatch(/building/);
        expect(done.color).toBe('var(--status-danger)');
    });

    it('same edition and build but repacked on the server: update', () => {
        const { ds } = setup();
        const S = { cycle_date: '2026-09-03', built_at: '2026-09-06T02:00:00Z', packed_at: '2026-09-06T02:45:44Z' };
        expect(ds._tileUpdateAvail(S, { ...S })).toBe(false);
        expect(ds._tileUpdateAvail({ ...S, packed_at: '2026-10-29T14:00:00Z' }, S)).toBe(true);
    });

    it('a manifest that is not JSON reads as unavailable (Sync must not stay stuck)', async () => {
        globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
        const ds = new DataStatus(document.body);
        await expect(ds._probeServerManifest('http://home:8090')).resolves.toBe(null);
    });

    it('cycle info from the home server is read uncached', async () => {
        const { ds, calls } = setup();
        const seen = [];
        const f = globalThis.fetch;
        globalThis.fetch = vi.fn((url, opts = {}) => { seen.push([String(url), opts.cache]); return f(url, opts); });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        for (const [u, c] of seen.filter(([u]) => /home:8090\/(nasr\/cycle_info|cifp\/cifp_cycle_info|plates\/plates_cycle_info|manifest)\.json/.test(u))) {
            expect([u, c]).toEqual([u, 'no-store']);
        }
    });
});


describe('the tablet records what it holds, with expiry, for offline currency', () => {
    afterEach(() => { delete globalThis.fetch; });

    it('after a sync: each product\'s cycle and expiration; A/FD with its own', async () => {
        const { ds } = setup();
        ds._serverManifest.audit.products.afd = { ok: true, failures: [], valid_until: '2026-10-29T09:01:00Z' };
        await ds._syncAll(null, () => {}, () => {}, () => {});
        const m = ds._readDeviceManifest();
        expect(m.nasr.expiration_date).toBe('2026-10-29');
        expect(m.cifp).toMatchObject({ cycle_code: '261001', expiration_date: '2026-10-29' });
        expect(m.plates).toMatchObject({ cycle_code: '261001', expiration_date: '2026-10-29', failed_states: [] });
        expect(m.afd).toMatchObject({ expiration_date: '2026-10-29', stale: false });
    });

    it('a failed state is recorded; A/FD failing its check is recorded stale', async () => {
        const { ds } = setup({ failState: 'GA' });
        ds._serverManifest.audit.products.afd = { ok: false, failures: ['A/FD page images not rendered: 3'] };
        await ds._syncAll(null, () => {}, () => {}, () => {});
        const m = ds._readDeviceManifest();
        expect(m.plates.failed_states).toEqual(['GA']);
        expect(m.plates.cycle_code).toBe('260903');
        expect(m.afd.stale).toBe(true);
    });

    it('already current: the expiry is still recorded (tablets synced before this version)', async () => {
        const { ds } = setup();
        localStorage.setItem('flytab_device_manifest', JSON.stringify({
            nasr: { effective_date: '2026-10-01', bundle_version: 11 }, cifp: { cycle_code: '261001' }, tiles: {},
            plates: { cycle_code: '261001', built_at: '2026-10-17T00:00:00Z', synced_states: ['NC', 'GA'] } }));
        globalThis.fetch = ((f) => vi.fn((url, o) => String(url).startsWith('http://localhost:9090/plates/plates_cycle_info.json') && !(o && o.method)
            ? Promise.resolve({ ok: true, json: async () => ({ effective_date: '2026-10-01' }) }) : f(url, o)))(globalThis.fetch);
        await ds._syncAll(null, () => {}, () => {}, () => {});
        const m = ds._readDeviceManifest();
        expect(m.nasr.expiration_date).toBe('2026-10-29');
        expect(m.cifp.expiration_date).toBe('2026-10-29');
        expect(m.plates.expiration_date).toBe('2026-10-29');
        expect(m.afd).toBeTruthy();
    });
});

describe('Data Status offline: the tablet\'s own expiry', () => {
    afterEach(() => { vi.useRealTimers(); delete globalThis.fetch; });

    const DEV = {
        nasr: { effective_date: '2026-10-01', expiration_date: '2026-10-29', bundle_version: 11 },
        cifp: { cycle_code: '261001', expiration_date: '2026-10-29' },
        plates: { cycle_code: '261001', expiration_date: '2026-10-29', synced_states: ['NC'], failed_states: ['GA'] },
        afd: { expiration_date: '2026-10-29', stale: false }, tiles: {},
    };

    it('in flight after expiry: EXPIRED, the failed state shown, no "All Data Current"', () => {
        vi.useFakeTimers({ now: new Date('2026-10-30T15:00:00Z') });
        const { ds } = setup();
        document.body.innerHTML = '<div><div class="data-status-body"></div><div id="dsStickyFooter"></div></div>';
        ds._el = document.body;
        ds._render(null, JSON.parse(JSON.stringify(DEV)), []);
        const t = document.body.textContent.replace(/\s+/g, ' ');
        expect((t.match(/EXPIRED/g) || []).length).toBeGreaterThanOrEqual(2);       // aero and plates
        expect(t).not.toMatch(/● CURRENT|ON DEVICE/);
        expect(t).toMatch(/GA.*previous cycle/);
        expect(t).not.toMatch(/All Data Current/);
        expect(t).toMatch(/expired/i);
    });

    it('expiry is at the 0901Z changeover', () => {
        vi.useFakeTimers({ now: new Date('2026-10-29T08:00:00Z') });
        const { ds } = setup();
        document.body.innerHTML = '<div><div class="data-status-body"></div><div id="dsStickyFooter"></div></div>';
        ds._el = document.body;
        const dev = JSON.parse(JSON.stringify(DEV)); dev.plates.failed_states = [];
        ds._render(null, dev, []);
        expect(document.body.textContent).not.toMatch(/EXPIRED/);
    });
});

describe('the verdict is re-read before each step of a long sync', () => {
    afterEach(() => { delete globalThis.fetch; });
    it('a build starting after the aero step: plates are not taken', async () => {
        const { ds, calls } = setup();
        let reads = 0;
        const f = globalThis.fetch;
        globalThis.fetch = vi.fn((url, o) => {
            if (String(url) === 'http://home:8090/manifest.json') {
                reads++;
                if (reads > 1) ds._serverManifest.audit.pending_products = ['plates'];
            }
            return f(url, o);
        });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(reads).toBeGreaterThan(1);
        expect(calls.some((c) => c.includes('/fetch-zip') && c.includes('state_zips'))).toBe(false);
        expect(document.body.textContent).toMatch(/building new PLATES/);
    });
});

describe('Data Status days agree with the status-bar badge', () => {
    it('whole days left, rounded down (11.9 days is 11d, as the badge says)', () => {
        const { ds } = setup();
        const exp = new Date('2026-10-29T09:01:00Z');
        expect(ds._cycleStatus(exp, new Date('2026-10-17T12:00:00Z'))).toMatch(/CURRENT \(11d left\)/);
        expect(ds._cycleStatus(exp, new Date('2026-10-26T12:00:00Z'))).toMatch(/EXPIRING \(2d\)/);
        expect(ds._cycleStatus(exp, new Date('2026-10-29T09:02:00Z'))).toMatch(/EXPIRED/);
    });
    it('chart layers expire at the 0901Z changeover too', () => {
        expect(read('web/cockpit/data-status.js')).toMatch(/FaaCurrency\.expiresAt\(dTile\.expiration_date\)/);
    });
});


describe('final review 2026-10-17: NASR is current only once the app has loaded it', () => {
    afterEach(() => { delete globalThis.fetch; delete window.app; delete window.Capacitor; delete globalThis.__homeNasr; });
    const NEW = { effective_date: '2026-10-29', expiration_date: '2026-11-26', sua_count: 1236, bundle_version: 11 };
    const native = (nasrDb) => { window.Capacitor = { isNativePlatform: () => true }; window.app = { _nasrDb: nasrDb }; };

    it('new NASR downloaded but the import into the app fails: the step fails and NASR is not recorded current', async () => {
        const { ds } = setup();
        globalThis.__homeNasr = NEW;
        native({ importNasrBundle: async () => { throw new Error('IDB blocked'); }, getCycleInfo: async () => null });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(document.body.textContent).toMatch(/NASR downloaded but not loaded into the app \(IDB blocked\)/);
        expect(ds._readDeviceManifest().nasr.effective_date).toBe('2026-10-01');       // still the old cycle
    });

    it('NASR files current but the app still holds the old cycle: it is loaded, then recorded', async () => {
        const { ds } = setup();
        const imported = [];
        native({ importNasrBundle: async (b) => { imported.push(b); return 1; },
                 getCycleInfo: async () => ({ effective_date: '2026-09-03', bundle_version: 11 }) });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(imported).toHaveLength(1);
        expect(ds._readDeviceManifest().nasr.expiration_date).toBe('2026-10-29');
    });

    it('NASR files current and loaded: no reimport', async () => {
        const { ds } = setup();
        const imported = [];
        native({ importNasrBundle: async (b) => { imported.push(b); return 1; },
                 getCycleInfo: async () => ({ effective_date: '2026-10-01', bundle_version: 11 }) });
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(imported).toHaveLength(0);
    });

    it('Force reimport reports a failed import instead of "App data reloaded"', async () => {
        setup();
        native({ importNasrBundle: async () => { throw new Error('quota'); } });
        await expect(DataStatus._reimportNasr()).rejects.toThrow('quota');
    });
});

describe('final review 2026-10-17: NASR refused by the audit does not skip CIFP', () => {
    afterEach(() => { delete globalThis.fetch; });
    it('NASR failed its check: CIFP is still checked and recorded; the step fails naming NASR', async () => {
        const { ds, calls } = setup();
        ds._serverManifest.audit.products.nasr = { ok: false, failures: ['SUA count 0'] };
        ds._serverManifest.audit.ok = false;
        await ds._syncAll(null, () => {}, () => {}, () => {});
        expect(calls.some((c) => c.includes('home:8090/cifp/cifp_cycle_info.json'))).toBe(true);
        expect(ds._readDeviceManifest().cifp.expiration_date).toBe('2026-10-29');
        expect(document.body.textContent).toMatch(/NASR not synced: .*SUA count 0.*CIFP current/);
    });
});

describe('final review 2026-10-17: Data Status footer and state names', () => {
    afterEach(() => { vi.useRealTimers(); delete globalThis.fetch; });
    const DEV = {
        nasr: { effective_date: '2026-10-01', expiration_date: '2026-10-29', bundle_version: 11 },
        cifp: { cycle_code: '261001' },                                      // expiry never recorded
        plates: { cycle_code: '261001', expiration_date: '2026-10-29', synced_states: ['NC'] },
        afd: { expiration_date: '2026-10-29', stale: false }, tiles: {},
    };
    const render = (ds, dev, server = null) => {
        document.body.innerHTML = '<div><div class="data-status-body"></div><div id="dsStickyFooter"></div></div>';
        ds._el = document.body;
        ds._render(server, JSON.parse(JSON.stringify(dev)), []);
    };

    it('an expiry not recorded is not "All Data Current"; Sync stays enabled to record it', () => {
        vi.useFakeTimers({ now: new Date('2026-10-20T15:00:00Z') });
        const { ds } = setup();
        localStorage.setItem('flytab_device_manifest', JSON.stringify(DEV));
        ds._resolvedBase = null;                                         // away from home: nothing "outdated" to compare
        render(ds, DEV);
        const btn = document.querySelector('#dsSyncAllBtn');
        expect(btn.textContent).toMatch(/FAA data expiry unknown: CIFP — sync on home WiFi/);
        expect(btn.disabled).toBe(false);
    });

    it('state names from the server are text, not HTML', () => {
        vi.useFakeTimers({ now: new Date('2026-10-20T15:00:00Z') });
        const { ds } = setup();
        const server = JSON.parse(JSON.stringify(SERVER));
        server.plates.state_sizes = [{ state: '<img src=x onerror="window.__pwned=1">', size_mb: 1 }];
        const dev = { ...DEV, plates: { ...DEV.plates, failed_states: ['<b id="evil">GA</b>'] } };
        render(ds, dev, server);
        expect(document.querySelector('.data-status-body img')).toBeNull();
        expect(document.getElementById('evil')).toBeNull();
        expect(document.body.textContent).toMatch(/<img src=x/);
    });
});
