import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
// _buildDOM() now wires pinch-to-zoom via attachPinchZoom (web/shared/pinch-zoom.js)
// as a bare identifier, same mechanism as the wireTap stub above -- see
// documents-panel.test.js for the fuller explanation of why the real
// implementation is loaded rather than a stub.
global.attachPinchZoom = new Function(read('web/shared/pinch-zoom.js') + '\nreturn attachPinchZoom;')();
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

function makeQuotaError() {
    const err = new Error('Quota exceeded');
    err.name = 'QuotaExceededError';
    return err;
}

describe('DocumentsPanel storage-quota handling', () => {
    it('shows a pilot-facing message instead of throwing when the document blob write fails', async () => {
        document.body.innerHTML = '';
        const nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue([]),
            saveDocument: vi.fn().mockRejectedValue(makeQuotaError()),
        };
        const panel = new DocumentsPanel(nasrDb);
        const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });

        await expect(panel._importFile(blob, 'big.pdf')).resolves.not.toThrow();
        expect(panel._el.textContent).toMatch(/storage full/i);
    });

    it('also catches quota failure on the search-index write — the more likely path (caught in plan review)', async () => {
        document.body.innerHTML = '';
        global.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
        global.lunr = vi.fn().mockReturnValue({ toJSON: () => ({}) });
        global.window.pdfjsLib = { getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [{ str: 'x' }] }) }) }) }) };
        const nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue([]),
            saveDocument: vi.fn().mockImplementation(async (doc) => { doc.id = 'id1'; return doc.id; }), // succeeds
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockRejectedValue(makeQuotaError()), // the index write fails
        };
        const panel = new DocumentsPanel(nasrDb);
        const blob = new Blob(['%PDF-1.4'], { type: 'application/pdf' });

        await expect(panel._importFile(blob, 'big.pdf')).resolves.not.toThrow();
        expect(panel._el.textContent).toMatch(/storage full/i);
    });
});

// Final whole-branch review, Fix 4: a NON-quota _indexDocument failure (e.g.
// a corrupt PDF PDF.js can't parse) previously left the saveDocument() record
// orphaned in the store forever, and the file-picker's change handler only
// console.error'd it with no pilot-facing message (unlike the share-intent
// path's equivalent failure, which already showed one).
describe('DocumentsPanel non-quota import failure handling', () => {
    it('rolls back the saved document record when indexing fails with a non-quota error', async () => {
        document.body.innerHTML = '';
        const savedDocs = [];
        const deletedIds = [];
        const nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue(savedDocs),
            saveDocument: vi.fn().mockImplementation(async (doc) => { doc.id = 'orphan-id'; savedDocs.push(doc); return doc.id; }),
            deleteDocument: vi.fn().mockImplementation(async (id) => { deletedIds.push(id); }),
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockResolvedValue(undefined),
        };
        global.window.pdfjsLib = { getDocument: () => ({ promise: Promise.reject(new Error('corrupt PDF -- unexpected EOF')) }) };
        const panel = new DocumentsPanel(nasrDb);
        const blob = new Blob(['not really a pdf'], { type: 'application/pdf' });

        await expect(panel._importFile(blob, 'corrupt.pdf')).rejects.toThrow('corrupt PDF');
        // The orphaned saveDocument() record must be rolled back, not left behind.
        expect(deletedIds).toEqual(['orphan-id']);
    });

    it('shows a pilot-facing message when the file-picker import fails for a non-quota reason', async () => {
        document.body.innerHTML = '';
        const nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue([]),
            saveDocument: vi.fn().mockImplementation(async (doc) => { doc.id = 'x1'; return doc.id; }),
            deleteDocument: vi.fn().mockResolvedValue(undefined),
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockResolvedValue(undefined),
        };
        global.window.pdfjsLib = { getDocument: () => ({ promise: Promise.reject(new Error('corrupt')) }) };
        const panel = new DocumentsPanel(nasrDb);

        const fileInput = panel._el.querySelector('.documents-file-input');
        const fakeFile = new File(['not a pdf'], 'bad.pdf', { type: 'application/pdf' });
        Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
        fileInput.dispatchEvent(new Event('change'));

        // Flush the whole pending microtask chain (saveDocument -> queued
        // indexing -> pdfjs rejection -> rollback -> catch -> _showMessage)
        // rather than guessing a tick count with chained Promise.resolve().
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(panel._el.textContent).toMatch(/could not import "bad\.pdf"/i);
        expect(fileInput.value).toBe(''); // finally block still resets the input so the pilot can retry
    });
});
