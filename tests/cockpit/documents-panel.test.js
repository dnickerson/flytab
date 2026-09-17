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
        nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue([
                { id: 'd1', name: 'Sample POH.pdf', type: 'imported', sizeBytes: 1024, importedAt: '2026-09-17T00:00:00Z' },
            ]),
            // Task 4 added search-index cleanup to _deleteDocument, which reads/writes
            // these via NasrDB.getAppCache/putAppCache -- stub them so the delete test
            // below (which doesn't itself exercise indexing) doesn't hit a real
            // "getAppCache is not a function" unhandled rejection off of this mock.
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockResolvedValue(undefined),
        };
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
        // Fix 6 (final whole-branch review): the delete button now confirms
        // before deleting, matching this repo's established confirm()
        // convention for irreversible actions (plan-sync.js). Stub it to
        // simulate the pilot tapping through -- jsdom's window.confirm is
        // not implemented and would otherwise make this assert on the wrong
        // (never-called) path.
        global.confirm = vi.fn(() => true);
        nasrDb.deleteDocument = vi.fn().mockResolvedValue(undefined);
        panel.show();
        await Promise.resolve(); await Promise.resolve();

        let opened = false;
        panel._openDocument = () => { opened = true; };
        const deleteBtn = panel._listEl.querySelector('.documents-row-delete');
        deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve(); await Promise.resolve();

        expect(global.confirm).toHaveBeenCalledWith('Delete "Sample POH.pdf"? This cannot be undone.');
        expect(nasrDb.deleteDocument).toHaveBeenCalledWith('d1');
        expect(opened).toBe(false); // stopPropagation must prevent the row's own open handler firing too
    });

    it('does not delete when the pilot cancels the confirmation', async () => {
        global.confirm = vi.fn(() => false);
        nasrDb.deleteDocument = vi.fn().mockResolvedValue(undefined);
        panel.show();
        await Promise.resolve(); await Promise.resolve();

        const deleteBtn = panel._listEl.querySelector('.documents-row-delete');
        deleteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve(); await Promise.resolve();

        expect(global.confirm).toHaveBeenCalled();
        expect(nasrDb.deleteDocument).not.toHaveBeenCalled();
    });
});

// Final whole-branch review, Fix 8: _checkPendingShare is called unawaited
// both from _buildDOM() and from a Capacitor 'resume' listener, but its own
// getPendingShare() call and atob(result.base64) were unguarded -- a
// bridge-level rejection or malformed base64 became a silent unhandled
// rejection with no pilot-visible symptom. These confirm the outer
// last-resort try/catch actually fires (not just "didn't throw," which
// would trivially pass even if the catch were missing entirely and nothing
// ever exercised it) by asserting the specific console.error it logs.
describe('DocumentsPanel _checkPendingShare error handling', () => {
    let consoleErrorSpy;

    beforeEach(() => {
        document.body.innerHTML = '';
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('does not throw when ShareReceiver.getPendingShare() itself rejects', async () => {
        const nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue([]),
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockResolvedValue(undefined),
        };
        global.window.Capacitor = { Plugins: { ShareReceiver: {
            getPendingShare: vi.fn().mockRejectedValue(new Error('bridge error')),
        } } };
        const panel = new DocumentsPanel(nasrDb);

        await expect(panel._checkPendingShare()).resolves.not.toThrow();
        expect(consoleErrorSpy).toHaveBeenCalledWith('DocumentsPanel: _checkPendingShare failed', expect.any(Error));
    });

    it('does not throw when the shared payload has malformed base64', async () => {
        const nasrDb = {
            getAllDocuments: vi.fn().mockResolvedValue([]),
            getAppCache: vi.fn().mockResolvedValue(null),
            putAppCache: vi.fn().mockResolvedValue(undefined),
        };
        global.window.Capacitor = { Plugins: { ShareReceiver: {
            // '*' is not in the base64 alphabet -- atob() throws InvalidCharacterError.
            getPendingShare: vi.fn().mockResolvedValue({ ok: true, base64: '***not valid base64***', name: 'bad.pdf' }),
        } } };
        const panel = new DocumentsPanel(nasrDb);

        await expect(panel._checkPendingShare()).resolves.not.toThrow();
        expect(consoleErrorSpy).toHaveBeenCalledWith('DocumentsPanel: _checkPendingShare failed', expect.anything());
    });
});
