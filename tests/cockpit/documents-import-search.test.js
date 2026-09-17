import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
// jsdom (25.0.1, as pinned in this repo's package.json) does not implement
// URL.createObjectURL/revokeObjectURL -- confirmed by direct probe against
// this project's vitest.config.js jsdom environment, not assumed. Real
// browser/WebView environments always have both. _indexDocument() calls
// URL.createObjectURL the same way the already-shipped _openDocument() does
// (web/cockpit/documents.js), so this stub -- like the wireTap stub above --
// replaces a browser API the app depends on but this test environment lacks;
// it does not change anything being asserted below.
if (typeof URL.createObjectURL !== 'function') URL.createObjectURL = () => 'blob:mock-url';
if (typeof URL.revokeObjectURL !== 'function') URL.revokeObjectURL = () => {};
global.lunr = new Function(read('web/lib/lunr.min.js') + '\nreturn lunr;')();
// _buildDOM() now wires pinch-to-zoom via attachPinchZoom (web/shared/pinch-zoom.js)
// as a bare identifier, same mechanism as the lunr/wireTap stubs above -- load the
// real implementation so _openDocument's reset()/state.ty pan-to-page assertions
// below exercise actual behavior, not a hand-rolled approximation.
global.attachPinchZoom = new Function(read('web/shared/pinch-zoom.js') + '\nreturn attachPinchZoom;')();
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

function mockPdfjs(pageTexts) {
    global.window.pdfjsLib = {
        getDocument: () => ({
            promise: Promise.resolve({
                numPages: pageTexts.length,
                getPage: (n) => Promise.resolve({
                    getTextContent: () => Promise.resolve({
                        items: pageTexts[n - 1].split(' ').map(str => ({ str })),
                    }),
                }),
            }),
        }),
    };
}

describe('DocumentsPanel import + search', () => {
    let nasrDb, panel, savedDocs, savedCache;

    beforeEach(() => {
        document.body.innerHTML = '';
        savedDocs = [];
        savedCache = null;
        nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue(savedDocs),
            saveDocument: vi.fn().mockImplementation(async (doc) => { doc.id = doc.id || 'new-doc-id'; savedDocs.push(doc); return doc.id; }),
            getAppCache: vi.fn().mockImplementation(async () => savedCache),
            putAppCache: vi.fn().mockImplementation(async (key, data) => { savedCache = data; }),
        };
        panel = new DocumentsPanel(nasrDb);
        mockPdfjs(['Cessna 172 checklist before landing', 'Emergency engine failure procedure']);
    });

    it('extracts text page-by-page and builds a searchable lunr index', async () => {
        const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
        await panel._importFile(blob, 'checklist.pdf');

        expect(nasrDb.saveDocument).toHaveBeenCalledWith(expect.objectContaining({ name: 'checklist.pdf', type: 'imported' }));
        expect(nasrDb.putAppCache).toHaveBeenCalledWith('documents_search_index', expect.objectContaining({
            lunrIndexJSON: expect.anything(),
            pages: expect.arrayContaining([
                expect.objectContaining({ docId: 'new-doc-id', pageNum: 1, text: expect.stringContaining('checklist') }),
                expect.objectContaining({ docId: 'new-doc-id', pageNum: 2, text: expect.stringContaining('Emergency') }),
            ]),
        }));
    });

    it('a search finds the right page and the index survives a lunr.Index.load round-trip', async () => {
        const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
        await panel._importFile(blob, 'checklist.pdf');

        const idx = lunr.Index.load(savedCache.lunrIndexJSON);
        const results = idx.search('emergency');
        expect(results.length).toBeGreaterThan(0);
        const hitPage = savedCache.pages.find(p => p.id === results[0].ref);
        expect(hitPage.pageNum).toBe(2);
    });

    it('regression guard: two concurrent imports do not clobber each other\'s index entries', async () => {
        // Reproduces the race caught in plan review: without serialization,
        // both imports read the same empty-cache snapshot before either
        // writes, so the second write silently drops the first import's pages.
        let idCounter = 0;
        nasrDb.saveDocument = vi.fn().mockImplementation(async (doc) => { doc.id = doc.id || `doc-${idCounter++}`; savedDocs.push(doc); return doc.id; });
        const blobA = new Blob(['%PDF-1.4 A'], { type: 'application/pdf' });
        const blobB = new Blob(['%PDF-1.4 B'], { type: 'application/pdf' });

        await Promise.all([
            panel._importFile(blobA, 'a.pdf'),
            panel._importFile(blobB, 'b.pdf'),
        ]);

        const docIds = new Set(savedCache.pages.map(p => p.docId));
        expect(docIds.size).toBe(2); // both documents' pages survived, not just the last writer's
    });

    // Final whole-branch review, Fix 2: tapping a search result used to
    // always open the document at page 1, even when the match was on a
    // later page. _applySearch's row handler must now pass the matching
    // page.pageNum through to _openDocument.
    it('opening a search result passes the matching page number to _openDocument', async () => {
        const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
        await panel._importFile(blob, 'checklist.pdf'); // 'Emergency...' text lands on page 2

        nasrDb.getDocument = vi.fn().mockResolvedValue({ id: 'new-doc-id', name: 'checklist.pdf' });
        let openedWith = null;
        panel._openDocument = async (doc, pageNum) => { openedWith = { docId: doc.id, pageNum }; };

        await panel._applySearch('emergency');
        const row = panel._listEl.querySelector('.documents-row');
        expect(row).toBeTruthy();
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve(); await Promise.resolve();

        expect(openedWith).toEqual({ docId: 'new-doc-id', pageNum: 2 });
    });

    it('a plain row tap (not from search) opens _openDocument with no page number', async () => {
        const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
        await panel._importFile(blob, 'checklist.pdf');

        let openedWith = 'not-called';
        panel._openDocument = async (doc, pageNum) => { openedWith = pageNum; };
        await panel._renderList();
        const row = panel._listEl.querySelector('.documents-row');
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve(); await Promise.resolve();

        expect(openedWith).toBeUndefined(); // opening from the plain list is always page 1 (no scroll)
    });

    // Fix 2, other half, updated for the pinch-zoom refactor: _openDocument
    // used to scroll to the requested page via wrapper.children[n].scrollIntoView(),
    // which relied on .documents-viewer being a native overflow-y:auto scroll
    // container. That container is now overflow:hidden with a JS-panned
    // .documents-pan-container (attachPinchZoom, panAlways:true) instead --
    // scrollIntoView has no scrollable ancestor left to act on. _openDocument
    // now pans directly: state.ty = -offsetTop. jsdom does not compute real
    // layout (offsetTop is always 0), so each canvas's offsetTop is stubbed
    // via defineProperty here -- the same technique the old test used to stub
    // scrollIntoView -- to give the assertion a real, non-trivial value to
    // check against.
    it('_openDocument pans to the given page when a pageNum is provided', async () => {
        const offsets = [0, 850, 1690]; // simulated offsetTop for pages 1, 2, 3
        global.renderPdfToContainer = vi.fn().mockImplementation(async (url, containerEl) => {
            const wrapper = document.createElement('div');
            for (const offsetTop of offsets) {
                const canvas = document.createElement('canvas');
                Object.defineProperty(canvas, 'offsetTop', { value: offsetTop, configurable: true });
                wrapper.appendChild(canvas);
            }
            containerEl.appendChild(wrapper);
            return wrapper;
        });

        const doc = { id: 'd1', name: 'checklist.pdf', blob: new Blob(['x'], { type: 'application/pdf' }) };
        await panel._openDocument(doc, 3);

        expect(panel._panZoom.state.ty).toBe(-1690); // page 3 -> children[2] -> offsetTop 1690
        expect(panel._panZoom.state.scale).toBe(1); // reset() ran before the pan
    });

    it('_openDocument does not pan when no pageNum is given', async () => {
        global.renderPdfToContainer = vi.fn().mockImplementation(async (url, containerEl) => {
            const wrapper = document.createElement('div');
            const canvas = document.createElement('canvas');
            Object.defineProperty(canvas, 'offsetTop', { value: 500, configurable: true });
            wrapper.appendChild(canvas);
            containerEl.appendChild(wrapper);
            return wrapper;
        });

        const doc = { id: 'd1', name: 'checklist.pdf', blob: new Blob(['x'], { type: 'application/pdf' }) };
        await panel._openDocument(doc);

        expect(panel._panZoom.state.ty).toBe(0); // reset() leaves ty at 0; no pageNum means no further pan
    });

    // New pan/zoom wiring: opening a document must not leak zoom/pan state
    // from whatever the pilot was previously looking at into the next
    // document -- otherwise a pilot who zoomed into a chart legend would land
    // on the next-opened POH already zoomed into an unrelated spot.
    it('_openDocument resets zoom/pan state before rendering a new document', async () => {
        global.renderPdfToContainer = vi.fn().mockImplementation(async (url, containerEl) => {
            const wrapper = document.createElement('div');
            const canvas = document.createElement('canvas');
            Object.defineProperty(canvas, 'offsetTop', { value: 0, configurable: true });
            wrapper.appendChild(canvas);
            containerEl.appendChild(wrapper);
            return wrapper;
        });
        // Simulate the pilot having zoomed/panned the previously open document.
        panel._panZoom.state.scale = 2.5;
        panel._panZoom.state.tx = 120;
        panel._panZoom.state.ty = 340;

        const doc = { id: 'd1', name: 'checklist.pdf', blob: new Blob(['x'], { type: 'application/pdf' }) };
        await panel._openDocument(doc);

        expect(panel._panZoom.state.scale).toBe(1);
        expect(panel._panZoom.state.tx).toBe(0);
        expect(panel._panZoom.state.ty).toBe(0);
    });

    // Final whole-branch review, Fix 7: fast typing can fire overlapping
    // _applySearch calls, each awaiting an IndexedDB read -- nothing
    // guaranteed an earlier query's results couldn't resolve AFTER a later
    // query's and overwrite them with stale results. Simulates that by
    // making the first search's getAppCache read hang until the second
    // search has already finished rendering.
    it('regression guard: a slow first search does not clobber a faster later search\'s results', async () => {
        mockPdfjs(['alpha content only']);
        await panel._importFile(new Blob(['%PDF-1.4 A'], { type: 'application/pdf' }), 'alpha.pdf');
        mockPdfjs(['bravo content only']);
        await panel._importFile(new Blob(['%PDF-1.4 B'], { type: 'application/pdf' }), 'bravo.pdf');

        let resolveFirst;
        let callCount = 0;
        nasrDb.getAppCache = vi.fn().mockImplementation(async () => {
            callCount++;
            if (callCount === 1) {
                // Hang the "alpha" search's read until manually released below.
                await new Promise((resolve) => { resolveFirst = resolve; });
            }
            return savedCache;
        });

        const firstSearch = panel._applySearch('alpha');   // starts, blocks on getAppCache
        const secondSearch = panel._applySearch('bravo');  // supersedes it
        await secondSearch;
        expect(panel._listEl.textContent).toMatch(/bravo\.pdf/);

        resolveFirst(); // now let the stale "alpha" search resume and try to render
        await firstSearch;

        // The stale first search must not have overwritten the newer second
        // search's results.
        expect(panel._listEl.textContent).toMatch(/bravo\.pdf/);
        expect(panel._listEl.textContent).not.toMatch(/alpha\.pdf/);
    });

    // Re-review follow-up on Fix 7: the empty-query early-return branch
    // bumps the generation counter but historically called the shared,
    // generation-unaware _renderList() unguarded -- so a pilot clearing the
    // search box (fires _applySearch('')) and immediately typing a new
    // query (fires _applySearch('abc')) could see the later, correctly-
    // filtered search results get silently overwritten by the earlier,
    // unfiltered full document list if that first getAllDocuments() read
    // resolved after the second search had already rendered. _renderList
    // now accepts an optional staleCheck, and _applySearch's empty-query
    // branch supplies one built from its own captured generation.
    it('regression guard: a slow empty-query render does not clobber a faster later search\'s results', async () => {
        mockPdfjs(['alpha content only']);
        await panel._importFile(new Blob(['%PDF-1.4 A'], { type: 'application/pdf' }), 'alpha.pdf');
        mockPdfjs(['bravo content only']);
        await panel._importFile(new Blob(['%PDF-1.4 B'], { type: 'application/pdf' }), 'bravo.pdf');

        let resolveGetAllDocuments;
        let callCount = 0;
        const realGetAllDocuments = nasrDb.getAllDocuments;
        nasrDb.getAllDocuments = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                // Hang the empty-query _renderList()'s read until manually released below.
                return new Promise((resolve) => { resolveGetAllDocuments = () => resolve(savedDocs); });
            }
            return realGetAllDocuments();
        });

        const emptyQuerySearch = panel._applySearch('');    // starts, blocks inside _renderList's getAllDocuments()
        const nonEmptySearch = panel._applySearch('bravo'); // supersedes it
        await nonEmptySearch;
        expect(panel._listEl.textContent).toMatch(/bravo\.pdf/);
        expect(panel._listEl.textContent).not.toMatch(/alpha\.pdf/);

        resolveGetAllDocuments(); // now let the stale empty-query render try to resume
        await emptyQuerySearch;

        // The stale empty-query render (the unfiltered full list, which
        // includes alpha.pdf) must not have overwritten the newer search's
        // filtered results.
        expect(panel._listEl.textContent).toMatch(/bravo\.pdf/);
        expect(panel._listEl.textContent).not.toMatch(/alpha\.pdf/);
    });
});
