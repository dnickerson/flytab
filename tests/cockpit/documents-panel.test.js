/**
 * Documents panel shell — Task 3 of the document-library-runtime plan.
 *
 * Covers the read-only list/view shell: DOM built once at construction and
 * appended to document.body, show()/hide() toggle the .visible class and
 * (re)render the list from NasrDB.getAllDocuments(), and deleting a row
 * calls NasrDB.deleteDocument() without also triggering the row's own
 * open handler (stopPropagation on the delete button).
 *
 * Import and search land in a later task — this only exercises the shell
 * against whatever getAllDocuments() returns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.wireTap = (el, handler) => { if (el) el.addEventListener('click', handler); };
const DocumentsPanel = new Function(read('web/cockpit/documents.js') + '\nreturn DocumentsPanel;')();

describe('DocumentsPanel shell', () => {
    let nasrDb, panel;

    beforeEach(() => {
        document.body.innerHTML = '';
        nasrDb = { getAllDocuments: vi.fn().mockResolvedValue([
            { id: 'd1', name: 'Sample POH.pdf', type: 'imported', sizeBytes: 1024, importedAt: '2026-09-17T00:00:00Z' },
        ]) };
        panel = new DocumentsPanel(nasrDb);
    });

    it('builds its DOM once at construction and appends to document.body', () => {
        expect(document.body.contains(panel._el)).toBe(true);
        expect(panel._el.className).toBe('documents-page');
    });

    it('show() adds the visible class and lists documents from the store', async () => {
        panel.show();
        expect(panel._el.classList.contains('visible')).toBe(true);
        await Promise.resolve(); // let the async _renderList settle
        await Promise.resolve();
        expect(nasrDb.getAllDocuments).toHaveBeenCalled();
        expect(panel._listEl.textContent).toMatch(/Sample POH\.pdf/);
    });

    it('hide() removes the visible class', () => {
        panel.show();
        panel.hide();
        expect(panel._el.classList.contains('visible')).toBe(false);
    });

    it('deleting a document removes it via NasrDB and does not also open it', async () => {
        nasrDb.deleteDocument = vi.fn().mockResolvedValue(undefined);
        panel.show();
        await Promise.resolve(); await Promise.resolve();

        let opened = false;
        panel._openDocument = () => { opened = true; };
        const deleteBtn = panel._listEl.querySelector('.documents-row-delete');
        deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve(); await Promise.resolve();

        expect(nasrDb.deleteDocument).toHaveBeenCalledWith('d1');
        expect(opened).toBe(false); // stopPropagation must prevent the row's own open handler firing too
    });
});
