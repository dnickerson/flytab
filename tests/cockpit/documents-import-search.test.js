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
});
