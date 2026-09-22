import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const PDF_RENDER_SRC = readFileSync('web/shared/pdf-render.js', 'utf8');
const APPROACH_CHARTS_SRC = readFileSync('web/cockpit/approach-charts.js', 'utf8');
const INDEX_HTML = readFileSync('web/index.html', 'utf8');

describe('shared PDF renderer extraction', () => {
    it('defines the shared renderPdfToContainer function', () => {
        expect(PDF_RENDER_SRC).toMatch(/function renderPdfToContainer\s*\(/);
        expect(PDF_RENDER_SRC).toMatch(/pdfjs\.getDocument/);
        expect(PDF_RENDER_SRC).toMatch(/page\.render\(/);
    });

    it('approach-charts.js delegates to the shared renderer instead of duplicating PDF.js calls', () => {
        const methodStart = APPROACH_CHARTS_SRC.indexOf('async _renderPdf(');
        const methodBody = APPROACH_CHARTS_SRC.slice(methodStart, methodStart + 600);
        expect(methodBody).toMatch(/renderPdfToContainer\s*\(/);
        // The duplicated per-page loop should be gone from this file now.
        expect(methodBody).not.toMatch(/pdf\.getPage\(/);
    });

    it('index.html loads pdf-render.js after pdf.js and before approach-charts.js', () => {
        const pdfJsIdx = INDEX_HTML.indexOf('lib/pdfjs/pdf.js');
        const rendererIdx = INDEX_HTML.indexOf('shared/pdf-render.js');
        const approachChartsIdx = INDEX_HTML.indexOf('cockpit/approach-charts.js');
        expect(rendererIdx).toBeGreaterThan(pdfJsIdx);
        expect(rendererIdx).toBeLessThan(approachChartsIdx);
    });
});
