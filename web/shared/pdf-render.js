/**
 * FlyTab — Shared PDF page renderer.
 * Renders a PDF as stacked <canvas> elements. Extracted from
 * approach-charts.js's plate viewer so the Documents panel (documents.js)
 * doesn't duplicate PDF.js rendering logic. Zoom/pan and page-to-page
 * navigation between different documents are NOT this function's concern —
 * callers layer those on top, exactly as approach-charts.js already does.
 *
 * Lazy rendering (opt-in via `panState`): approach-charts.js's plates are
 * typically 1-2 pages and call this with no `panState`, getting the
 * original behavior — every page rasterized to a full-resolution canvas up
 * front, all kept in the DOM. documents.js reuses this same function for
 * arbitrary imported PDFs, and a real aircraft POH is commonly 100-150
 * pages; at ~16.8MB per full-res canvas backing store (devicePixelRatio
 * ~2.75 on this hardware), rendering every page eagerly before the panel is
 * interactive is a near-certain OOM crash, not just jank.
 *
 * When a caller passes `panState` (the live {scale,tx,ty} object returned as
 * attachPinchZoom(...).state — see pinch-zoom.js), only page 1 rasterizes up
 * front; every other page gets a lightweight <div> placeholder sized to
 * match page 1's rendered box (accurate for the near-universal case of a
 * document with uniform page size, e.g. any real POH — a mixed-page-size
 * document just gets an approximate placeholder height until its neighbors
 * actually render, not a crash). The caller must then invoke the returned
 * wrapper's `_lazyPdf.updateVisibility()` every time `panState` changes;
 * documents.js does this from attachPinchZoom's `onApply`, which fires
 * synchronously on every pan/zoom/page-jump transform change (see
 * pinch-zoom.js). Pages near the current scroll position get rasterized to
 * canvas; pages that scroll far away get torn back down to placeholders, so
 * peak memory stays bounded regardless of document length. onApply is a
 * deterministic tie to the exact code path that changes the visible
 * transform — deliberately not an IntersectionObserver, since this app pans
 * via JS-driven CSS transforms rather than native scrolling, and this
 * function's author had no way to verify IntersectionObserver's update
 * timing against that pattern on real hardware in this session. Call
 * `_lazyPdf.destroy()` before discarding the wrapper (e.g. before opening a
 * different document) to stop further background rendering.
 */
async function renderPdfToContainer(url, containerEl, { scale, cssClass, errorLabel = 'document', panState } = {}) {
    const pdfjs = window.pdfjsLib;
    const wrapper = document.createElement('div');
    if (cssClass) wrapper.className = cssClass;
    containerEl.appendChild(wrapper);
    if (!pdfjs) {
        wrapper.style.cssText = 'color:var(--text-muted);padding:24px;text-align:center;';
        wrapper.textContent = 'PDF renderer unavailable';
        return wrapper;
    }
    try {
        const pdf = await pdfjs.getDocument(url).promise;
        const effectiveScale = scale || (window.devicePixelRatio || 2);

        if (!panState) {
            // Eager path — unchanged behavior, used by approach-charts.js
            // (and any other caller that doesn't opt into lazy rendering).
            for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const viewport = page.getViewport({ scale: effectiveScale });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                wrapper.appendChild(canvas);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            }
            return wrapper;
        }

        // Lazy path. Page 1 renders eagerly so the panel is never blank.
        const page1 = await pdf.getPage(1);
        const viewport1 = page1.getViewport({ scale: effectiveScale });
        const canvas1 = document.createElement('canvas');
        canvas1.width = viewport1.width;
        canvas1.height = viewport1.height;
        wrapper.appendChild(canvas1);
        await page1.render({ canvasContext: canvas1.getContext('2d'), viewport: viewport1 }).promise;

        // Page 1's actual rendered CSS box (post max-width/max-height clamp —
        // see ".documents-pdf canvas" in style.css), measured rather than
        // recomputed from those CSS rules so this can't silently drift if
        // that CSS changes later. Used as every OTHER page's assumed size:
        // exact for a uniform-page-size document (the near-universal real
        // case — any real POH), approximate for a mixed-size one.
        const rect1 = canvas1.getBoundingClientRect();
        const pageW = rect1.width || canvas1.offsetWidth || 600;
        const pageH = rect1.height || canvas1.offsetHeight || 800;

        // 1-indexed throughout (index 0 unused) so page number == array index,
        // matching how documents.js already indexes wrapper.children[pageNum-1].
        const slot = new Array(pdf.numPages + 1).fill(null); // current DOM node per page (canvas or placeholder)
        const rendered = new Array(pdf.numPages + 1).fill(false);
        const pending = new Set(); // page numbers with a render currently in flight — de-dupes overlapping calls

        const makePlaceholder = () => {
            const div = document.createElement('div');
            div.className = 'pdf-lazy-placeholder';
            div.style.width = `${pageW}px`;
            div.style.height = `${pageH}px`;
            return div;
        };

        slot[1] = canvas1;
        rendered[1] = true;
        for (let p = 2; p <= pdf.numPages; p++) {
            const div = makePlaceholder();
            wrapper.appendChild(div);
            slot[p] = div;
        }

        let destroyed = false;

        // Renders page p into a detached canvas and only swaps it in on
        // success — a single bad page (corrupt page data, etc.) is not
        // supposed to be fatal to a document the pilot may already be
        // reading 50 pages into, unlike the eager path above where any
        // failure intentionally fails the whole view via the outer catch.
        // Leaving slot[p] as an (inert) placeholder on failure needs no
        // extra revert step precisely because nothing was attached yet.
        const renderPage = async (p) => {
            if (rendered[p] || pending.has(p) || destroyed) return;
            pending.add(p);
            try {
                const placeholder = slot[p];
                if (!placeholder || !placeholder.isConnected) return;
                const page = await pdf.getPage(p);
                const viewport = page.getViewport({ scale: effectiveScale });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
                if (destroyed || !placeholder.isConnected) return; // superseded while this was in flight
                placeholder.replaceWith(canvas);
                slot[p] = canvas;
                rendered[p] = true;
            } catch (err) {
                console.error(`pdf-render: failed to render page ${p}`, err);
            } finally {
                pending.delete(p);
            }
        };

        const teardownPage = (p) => {
            if (!rendered[p]) return; // never rendered, or already a placeholder
            const canvas = slot[p];
            if (!canvas || !canvas.isConnected) return;
            const placeholder = makePlaceholder();
            canvas.replaceWith(placeholder);
            slot[p] = placeholder;
            rendered[p] = false;
        };

        // Pages kept rasterized on each side of the current one. Each page
        // is already sized to roughly fill the viewport at scale 1 (see
        // pageH derivation above), so this fixed window comfortably covers
        // what's actually on screen across the app's zoom range
        // (pinch-zoom.js clamps scale to [0.8, 8]) without needing the
        // viewport's own pixel height here.
        const BUFFER = 2;

        const updateVisibility = () => {
            if (destroyed) return;
            const scrollTop = Math.max(0, -(panState.ty || 0));
            const current = Math.min(pdf.numPages, Math.max(1, Math.floor(scrollTop / pageH) + 1));
            const lo = Math.max(1, current - BUFFER);
            const hi = Math.min(pdf.numPages, current + BUFFER);
            for (let p = lo; p <= hi; p++) renderPage(p); // fire-and-forget; no-ops once rendered/in flight
            for (let p = 1; p <= pdf.numPages; p++) {
                if (p < lo || p > hi) teardownPage(p);
            }
        };

        wrapper._lazyPdf = {
            updateVisibility,
            destroy() { destroyed = true; },
        };
        updateVisibility(); // render the initial buffer around page 1 without waiting for a pan/zoom event
    } catch (err) {
        // textContent, not innerHTML — err.message can come from PDF.js
        // parsing an externally-shared/externally-sourced PDF and may embed
        // fragments of the file's own content; writing it into innerHTML is
        // an HTML-injection sink in a WebView origin holding the app's
        // IndexedDB/localStorage/Capacitor bridge. --color-danger-on-light
        // (not --status-warning, a bright fill color unreadable as
        // foreground text on this repo's light theme) matches how this same
        // feature already displays externally-sourced text elsewhere
        // (documents.js's delete button).
        wrapper.innerHTML = '';
        const msg = document.createElement('div');
        msg.style.cssText = 'color:var(--color-danger-on-light);padding:24px';
        msg.textContent = `Failed to load ${errorLabel}: ${err.message}`;
        wrapper.appendChild(msg);
    }
    return wrapper;
}
