/**
 * FlyTab — Shared PDF page renderer.
 * Renders every page of a PDF as stacked <canvas> elements. Extracted from
 * approach-charts.js's plate viewer so the Documents panel (documents.js)
 * doesn't duplicate PDF.js rendering logic. Zoom/pan and page-to-page
 * navigation between different documents are NOT this function's concern —
 * callers layer those on top, exactly as approach-charts.js already does.
 */
async function renderPdfToContainer(url, containerEl, { scale, cssClass, errorLabel = 'document' } = {}) {
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
        for (let p = 1; p <= pdf.numPages; p++) {
            const page = await pdf.getPage(p);
            const effectiveScale = scale || (window.devicePixelRatio || 2);
            const viewport = page.getViewport({ scale: effectiveScale });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            wrapper.appendChild(canvas);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        }
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
