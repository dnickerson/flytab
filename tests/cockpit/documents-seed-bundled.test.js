import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
// jsdom (25.0.1, as pinned in this repo's package.json) does not implement
// URL.createObjectURL/revokeObjectURL -- see tests/cockpit/documents-import-search.test.js
// for the confirmed-by-direct-probe note. _seedBundledDocuments() funnels through
// _importFile -> _indexDocument(), which calls URL.createObjectURL the same way
// _openDocument() does; without this stub GREEN would fail on that call, not on
// anything this file actually asserts.
if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = () => 'blob:mock-url';
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {};
global.lunr = new Function(read('web/lib/lunr.min.js') + '\nreturn lunr;')();
// _buildDOM() now wires pinch-to-zoom via attachPinchZoom (web/shared/pinch-zoom.js)
// as a bare identifier, same mechanism as the lunr/wireTap stubs above -- see
// documents-panel.test.js for the fuller explanation of why the real
// implementation is loaded rather than a stub.
global.attachPinchZoom = new Function(read('web/shared/pinch-zoom.js') + '\nreturn attachPinchZoom;')();
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

describe('DocumentsPanel bundled-legend seeding', () => {
    let nasrDb, savedDocs;

    beforeEach(() => {
        document.body.innerHTML = '';
        savedDocs = [];
        nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue(savedDocs),
            saveDocument: vi.fn().mockImplementation(async (doc) => { doc.id = doc.id || `id-${savedDocs.length}`; savedDocs.push(doc); return doc.id; }),
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockResolvedValue(undefined),
        };
        global.window.pdfjsLib = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [{ str: 'legend' }] }) }) }) }) };
        // btoa of "%PDF-1.4" — the native plugin returns base64, not a Blob.
        global.window.Capacitor = { Plugins: { BundledAsset: {
            readAsset: vi.fn().mockResolvedValue({ ok: true, base64: btoa('%PDF-1.4') }),
        } } };
        // NOTE: DocumentsPanel is intentionally NOT constructed here. _buildDOM()
        // fires _seedBundledDocuments() itself, unawaited, as soon as the panel
        // exists (see documents.js) -- constructing it in this shared beforeEach,
        // before each test below sets up its own scenario (an existing doc already
        // in the store, or no native plugin), would let that construction-time
        // call already observe/act on the wrong (pre-scenario) state, racing the
        // scenario setup below. Each test constructs its own panel after its
        // scenario-specific setup instead, so the single (memoized -- see
        // _seedBundledDocuments's single-flight guard) seeding pass this triggers
        // sees the correct state from the start.
        // Confirmed by direct run: constructing here caused two of the three
        // tests below to fail on a real, reproducible race, not flakiness --
        // see task-6-report.md for the captured failure output.
    });

    it('seeds both bundled legends on first run when the store is empty', async () => {
        const panel = new DocumentsPanel(nasrDb);
        await panel._seedBundledDocuments();
        expect(savedDocs.length).toBe(2);
        expect(savedDocs.every(d => d.type === 'bundled')).toBe(true);
        expect(savedDocs.map(d => d.name)).toEqual(expect.arrayContaining([expect.stringContaining('VFR'), expect.stringContaining('IFR')]));
    });

    it('does not re-seed if a bundled legend is already present', async () => {
        savedDocs.push({ id: 'existing', name: 'VFR Chart Legend.pdf', type: 'bundled' });
        const panel = new DocumentsPanel(nasrDb);
        await panel._seedBundledDocuments();
        // Only the missing IFR one should get added, not a duplicate VFR.
        expect(savedDocs.filter(d => d.name.includes('VFR')).length).toBe(1);
    });

    it('fails open (no crash, no seeded docs) if the native plugin is unavailable or errors', async () => {
        global.window.Capacitor = undefined;
        const panel = new DocumentsPanel(nasrDb);
        await expect(panel._seedBundledDocuments()).resolves.not.toThrow();
        expect(savedDocs.length).toBe(0);
    });

    // Fix round 1: the existing.some() dedup check's own read was the one
    // step in this method not covered by any try/catch -- a rejection here
    // (this repo has a documented IDB transaction-hang failure mode) would
    // otherwise propagate out of the memoized promise and surface as an
    // unhandled rejection off the unawaited _buildDOM() call site, which
    // this method's own doc comment already promises never happens.
    it('fails open (no crash, no seeded docs) if getAllDocuments itself rejects', async () => {
        nasrDb.getAllDocuments = vi.fn().mockRejectedValue(new Error('IDB transaction hang'));
        const panel = new DocumentsPanel(nasrDb);
        await expect(panel._seedBundledDocuments()).resolves.not.toThrow();
        expect(savedDocs.length).toBe(0);
    });

    // Final whole-branch review, Fix 3: existing.some() alone re-seeds a
    // bundled legend the pilot deliberately deleted, because "currently
    // present" goes back to false after a delete even though "was ever
    // seeded" must stay true. This test needs the 'documents_bundled_seeded'
    // marker to actually persist across the two simulated app launches below,
    // so (unlike every test above, which relies on this file's shared
    // beforeEach stubbing getAppCache to always resolve null) it swaps in a
    // stateful cacheStore for just this test.
    it('does not re-seed a bundled legend after the pilot deletes it', async () => {
        const cacheStore = {};
        nasrDb.getAppCache = vi.fn().mockImplementation(async (key) => (key in cacheStore ? cacheStore[key] : null));
        nasrDb.putAppCache = vi.fn().mockImplementation(async (key, data) => { cacheStore[key] = data; });

        // First launch: both legends get seeded.
        const panel1 = new DocumentsPanel(nasrDb);
        await panel1._seedBundledDocuments();
        expect(savedDocs.length).toBe(2);

        // Pilot deletes the VFR legend to free space -- simulates what
        // NasrDB.deleteDocument does to the store (removes the row).
        const vfrIdx = savedDocs.findIndex(d => d.name.includes('VFR'));
        savedDocs.splice(vfrIdx, 1);
        expect(savedDocs.some(d => d.name.includes('VFR'))).toBe(false);

        // Second launch: seeding must NOT bring it back -- only the
        // persisted marker (not mere current presence) gates re-import.
        const panel2 = new DocumentsPanel(nasrDb);
        await panel2._seedBundledDocuments();
        expect(savedDocs.some(d => d.name.includes('VFR'))).toBe(false);
        expect(savedDocs.filter(d => d.name.includes('IFR')).length).toBe(1); // and no IFR duplicate either
    });
});
