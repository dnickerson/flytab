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
// _buildDOM() now wires pinch-to-zoom via attachPinchZoom (web/shared/pinch-zoom.js)
// as a bare identifier, same mechanism as the wireTap stub above -- load the real
// implementation (not a stub) so construction and the pan/zoom-wiring tests below
// exercise the actual reset/state semantics, not a hand-rolled approximation.
global.attachPinchZoom = new Function(read('web/shared/pinch-zoom.js') + '\nreturn attachPinchZoom;')();
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

    // Pinch-zoom refactor: _buildDOM() now wires attachPinchZoom onto the new
    // .documents-pan-container nested inside .documents-viewer. Confirms
    // construction doesn't throw (attachPinchZoom just calls addEventListener,
    // which jsdom supports) and that the panel starts in the identity
    // (unzoomed, unpanned) state.
    it('wires pinch-zoom onto a pan-container nested inside the viewer, at rest', () => {
        expect(panel._panContainer).toBeTruthy();
        expect(panel._viewerEl.contains(panel._panContainer)).toBe(true);
        expect(panel._panZoom.state).toEqual({ scale: 1, tx: 0, ty: 0 });
    });

    // Code-review Fix 1 (Critical): .documents-pan-container stacks every page
    // of the PDF, unlike .approach-viewer-body (this rule's original template)
    // which only ever shows one plate. Once the page stack is taller than the
    // viewer -- true of virtually any real multi-page document -- align-items:
    // center centers the WHOLE STACK, pushing page 1 far above the visible
    // area at rest instead of showing it (measured with a real headless-
    // Chromium layout during code review: page 1 landed ~2300px above the
    // viewport in a synthetic 6-page-document repro, fully off-screen).
    // jsdom does not compute real layout (getBoundingClientRect/offsetTop are
    // always zero here), so this can only guard the CSS source text against a
    // regression back to align-items:center -- it cannot re-verify the
    // geometry itself. Follows this repo's established pattern for scoped
    // style.css text assertions (tests/cockpit/wb-overlay-fuel.test.js).
    it('CSS regression guard: .documents-viewer top-aligns its content instead of centering it', () => {
        const css = read('web/style.css');
        const ruleStart = css.indexOf('.documents-viewer {');
        expect(ruleStart).toBeGreaterThan(-1);
        const ruleEnd = css.indexOf('\n}', ruleStart);
        // Strip /* ... */ comments before asserting -- the explanatory comment
        // on this rule (in style.css, not this file) discusses the bug in
        // prose and literally contains the substring "align-items:center" as
        // part of that explanation, which would otherwise false-fail the
        // not.toMatch() below against the comment text rather than the actual
        // declaration. Caught by running this test against its own first
        // draft.
        const rule = css.slice(ruleStart, ruleEnd).replace(/\/\*[\s\S]*?\*\//g, '');
        expect(rule).toMatch(/align-items:\s*flex-start/);
        expect(rule).not.toMatch(/align-items:\s*center/);
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

    // Code-review fix: deleteDocument() succeeding (the doc is really gone
    // from IndexedDB) used to be followed by an unguarded await on chained
    // search-index cleanup -- this repo's own CLAUDE.md documents a real IDB
    // transaction-hang failure mode as a known risk. If that chained step
    // rejected, _renderList() never ran (the whole async function rejected,
    // unawaited by the tap handler that calls it), so the deleted row stayed
    // on screen with no re-render and no pilot-facing error -- contradicting
    // the user manual's claim that deleting removes it from the list. The
    // fix decouples the list re-render from the index cleanup's outcome.
    // getAllDocuments/deleteDocument are made stateful here (unlike this
    // describe block's static beforeEach mocks) so the assertions below can
    // tell a real re-render from the pre-existing static mock just
    // happening to still list the "deleted" doc.
    it('regression guard: the row disappears once delete succeeds, even when chained search-index cleanup rejects', async () => {
        let docs = [{ id: 'd1', name: 'Sample POH.pdf', type: 'imported', sizeBytes: 1024, importedAt: '2026-09-17T00:00:00Z' }];
        nasrDb.getAllDocuments = vi.fn().mockImplementation(async () => docs);
        nasrDb.deleteDocument = vi.fn().mockImplementation(async (id) => { docs = docs.filter(d => d.id !== id); });
        nasrDb.getAppCache = vi.fn().mockRejectedValue(new Error('IDB transaction hang'));
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        panel.show();
        await Promise.resolve(); await Promise.resolve();
        expect(panel._listEl.textContent).toMatch(/Sample POH\.pdf/);

        await panel._deleteDocument({ id: 'd1', name: 'Sample POH.pdf' });

        expect(nasrDb.deleteDocument).toHaveBeenCalledWith('d1');
        expect(panel._listEl.textContent).not.toMatch(/Sample POH\.pdf/); // row must be gone from the DOM...
        expect(panel._listEl.querySelector('.documents-empty')).toBeTruthy(); // ...via a real re-render, not a stale mock
        expect(consoleErrorSpy).toHaveBeenCalledWith('DocumentsPanel: search-index cleanup failed after delete', expect.any(Error));
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
