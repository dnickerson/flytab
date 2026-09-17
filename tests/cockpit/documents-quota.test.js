import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
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
