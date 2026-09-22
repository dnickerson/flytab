/**
 * Code-review fix: renderPdfToContainer (web/shared/pdf-render.js) used to
 * rasterize every page of a PDF to a full-resolution canvas up front and
 * keep them all in the DOM simultaneously. Fine for approach-charts.js's
 * plates (typically 1 page), but documents.js reuses the same function for
 * arbitrary imported PDFs, and a real aircraft POH commonly runs 100-150
 * pages -- at ~16.8MB per full-res canvas backing store (devicePixelRatio
 * ~2.75 on this hardware), that was a near-certain OOM crash, not just
 * jank. These tests exercise the real function (not a mock, unlike
 * documents-import-search.test.js's DocumentsPanel tests, which stub
 * renderPdfToContainer out entirely) against a fake pdfjsLib, to verify the
 * lazy-render buffer actually bounds how many pages get rasterized.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(__dirname, '../../', p), 'utf8');
global.renderPdfToContainer = new Function(read('web/shared/pdf-render.js') + '\nreturn renderPdfToContainer;')();

// jsdom (25.0.1, as pinned in this repo's package.json) computes no real
// layout -- canvas.getBoundingClientRect()/offsetWidth/offsetHeight are
// always zero here (confirmed directly against this project's jsdom
// version before writing this file, not assumed -- same class of gap
// documents-import-search.test.js already notes for offsetTop). pdf-
// render.js's lazy path falls back to an assumed 600x800 page size in that
// case (see pageW/pageH in renderPdfToContainer) -- these tests rely on
// that documented fallback rather than fighting it with prototype patching.
const FALLBACK_PAGE_H = 800;

// A single macrotask tick drains the whole microtask queue first, no matter
// how many .then()/await links are chained -- sufficient to let
// renderPdfToContainer's fire-and-forget lazy renderPage() calls (pure
// promise chains, no timers involved) fully settle before asserting.
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// onRender(n) may return { reject: Error } to simulate page n failing to
// render; otherwise the page "renders" successfully.
function mockPdfjs(numPages, { onRender } = {}) {
    const renderCalls = [];
    global.window.pdfjsLib = {
        getDocument: () => ({
            promise: Promise.resolve({
                numPages,
                getPage: (n) => Promise.resolve({
                    getViewport: ({ scale }) => ({ width: 100 * scale, height: 130 * scale }),
                    render: () => {
                        renderCalls.push(n);
                        const result = onRender ? onRender(n) : undefined;
                        if (result && result.reject) return { promise: Promise.reject(result.reject) };
                        return { promise: Promise.resolve() };
                    },
                }),
            }),
        }),
    };
    return renderCalls;
}

describe('renderPdfToContainer', () => {
    let containerEl, consoleErrorSpy;

    beforeEach(() => {
        document.body.innerHTML = '';
        containerEl = document.createElement('div');
        document.body.appendChild(containerEl);
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        delete global.window.pdfjsLib;
    });

    it('eager path (no panState) renders every page up front, unchanged from before this fix -- approach-charts.js plates depend on this', async () => {
        const renderCalls = mockPdfjs(4);
        const wrapper = await renderPdfToContainer('blob:mock', containerEl, { cssClass: 'approach-plate-pdf' });

        expect(renderCalls).toEqual([1, 2, 3, 4]);
        expect(wrapper.children.length).toBe(4);
        for (const child of wrapper.children) expect(child.tagName).toBe('CANVAS');
        expect(wrapper._lazyPdf).toBeUndefined();
    });

    it('lazy path (panState provided) renders only page 1 and a small buffer up front for a long document', async () => {
        const renderCalls = mockPdfjs(150); // a real POH-sized document
        const panState = { scale: 1, tx: 0, ty: 0 };
        const wrapper = await renderPdfToContainer('blob:mock', containerEl, { cssClass: 'documents-pdf', panState });
        await flush();

        // Layout space is reserved for every page up front...
        expect(wrapper.children.length).toBe(150);
        // ...but this is the actual fix: only a handful are real canvases
        // with an allocated backing store. BUFFER=2 around page 1.
        expect(renderCalls.slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
        for (let i = 0; i < 3; i++) expect(wrapper.children[i].tagName).toBe('CANVAS');
        for (let i = 3; i < 150; i++) {
            expect(wrapper.children[i].tagName).toBe('DIV');
            expect(wrapper.children[i].className).toBe('pdf-lazy-placeholder');
        }
    });

    it('updateVisibility() re-centers the buffer as panState.ty changes and tears down pages that scroll out of range, including page 1', async () => {
        const renderCalls = mockPdfjs(150);
        const panState = { scale: 1, tx: 0, ty: 0 };
        const wrapper = await renderPdfToContainer('blob:mock', containerEl, { cssClass: 'documents-pdf', panState });
        await flush();
        renderCalls.length = 0; // only care about calls made by the scroll below

        panState.ty = -(8 * FALLBACK_PAGE_H); // scroll down to land on page 9
        wrapper._lazyPdf.updateVisibility();
        await flush();

        expect(renderCalls.slice().sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11]);
        for (const p of [7, 8, 9, 10, 11]) expect(wrapper.children[p - 1].tagName).toBe('CANVAS');
        // Pages that scrolled out of the buffer must go back to
        // placeholders -- including page 1, which is only special in that
        // it renders eagerly at setup, not that it's exempt from teardown.
        // Without this, memory would grow unbounded as the pilot keeps
        // scrolling through a long document -- the exact failure mode this
        // fix targets.
        for (const p of [1, 2, 3]) {
            expect(wrapper.children[p - 1].tagName).toBe('DIV');
            expect(wrapper.children[p - 1].className).toBe('pdf-lazy-placeholder');
        }
    });

    it('destroy() stops further background rendering', async () => {
        const renderCalls = mockPdfjs(150);
        const panState = { scale: 1, tx: 0, ty: 0 };
        const wrapper = await renderPdfToContainer('blob:mock', containerEl, { cssClass: 'documents-pdf', panState });
        await flush();
        renderCalls.length = 0;

        wrapper._lazyPdf.destroy();
        panState.ty = -(8 * FALLBACK_PAGE_H);
        wrapper._lazyPdf.updateVisibility();
        await flush();

        expect(renderCalls).toEqual([]); // destroyed -- must not render anything further
    });

    it('a single page failing to render is isolated: it stays a placeholder, other pages and the rest of the document are unaffected', async () => {
        mockPdfjs(150, { onRender: (n) => (n === 2 ? { reject: new Error('corrupt page 2') } : undefined) });
        const panState = { scale: 1, tx: 0, ty: 0 };
        const wrapper = await renderPdfToContainer('blob:mock', containerEl, { cssClass: 'documents-pdf', panState });
        await flush();

        // Page 1 and 3 (also in the initial buffer) rendered fine.
        expect(wrapper.children[0].tagName).toBe('CANVAS');
        expect(wrapper.children[2].tagName).toBe('CANVAS');
        // Page 2 failed -- left as an (inert) placeholder, not a crash and
        // not a "Failed to load document" wipe of the whole wrapper (that's
        // the eager path's/malformed-PDF's behavior, not appropriate here
        // since the pilot may already be reading a page the failure has
        // nothing to do with).
        expect(wrapper.children[1].tagName).toBe('DIV');
        expect(wrapper.children[1].className).toBe('pdf-lazy-placeholder');
        expect(wrapper._lazyPdf).toBeTruthy(); // whole-document lazy state is intact
        expect(consoleErrorSpy).toHaveBeenCalledWith('pdf-render: failed to render page 2', expect.any(Error));
    });

    it('a single page (numPages === 1) works under the lazy path with no placeholders needed', async () => {
        const renderCalls = mockPdfjs(1);
        const panState = { scale: 1, tx: 0, ty: 0 };
        const wrapper = await renderPdfToContainer('blob:mock', containerEl, { cssClass: 'documents-pdf', panState });
        await flush();

        expect(renderCalls).toEqual([1]);
        expect(wrapper.children.length).toBe(1);
        expect(wrapper.children[0].tagName).toBe('CANVAS');
    });
});
