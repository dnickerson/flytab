/**
 * FlyTab — Shared PDF page renderer.
 * Renders every page of a PDF as stacked <canvas> elements. Extracted from
 * approach-charts.js's plate viewer so the Documents panel (documents.js)
 * doesn't duplicate PDF.js rendering logic. Zoom/pan and page-to-page
 * navigation between different documents are NOT this function's concern —
 * callers layer those on top, exactly as approach-charts.js already does.
 */
async function renderPdfToContainer(url, containerEl, { scale, cssClass } = {}) {
    const pdfjs = window.pdfjsLib;
    const wrapper = document.createElement('div');
    if (cssClass) wrapper.className = cssClass;
    containerEl.appendChild(wrapper);
    if (!pdfjs) {
        wrapper.innerHTML = '<div class="pdf-render-error">PDF renderer unavailable</div>';
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
        wrapper.innerHTML = `<div class="pdf-render-error">Failed to load document: ${err.message}</div>`;
    }
    return wrapper;
}
