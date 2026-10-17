/**
 * Takeoff / alternate minimums (Dana, 2026-10-16: "The takeoff minimums does
 * not display the KTMB minimums"). The FAA publishes them as one document per
 * volume -- SE3TO.PDF, 49 pages, every SE-3 airport. The full-screen viewer drew
 * that PDF (no georef entry), starting at page 1: another airport. The
 * pipeline's image for the plate is this airport's own page(s); show it, and
 * draw the PDF only when the image is missing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

globalThis.wireTap = globalThis.wireTap || ((el, fn) => el && el.addEventListener && el.addEventListener('click', fn));
const ApproachCharts = new Function(readFileSync('web/cockpit/approach-charts.js', 'utf8') + '\nreturn ApproachCharts;')();

function viewer(plates) {
    const c = Object.create(ApproachCharts.prototype);
    c._plates = plates;
    c._geoIndex = {};
    c._viewerEl = document.createElement('div');
    c._viewerEl.innerHTML = '<div class="approach-viewer-title"></div><div class="approach-viewer-body"></div>';
    c._panContainer = document.createElement('div');
    c._imgEl = document.createElement('img');
    c._panContainer.appendChild(c._imgEl);
    c._mapBtn = document.createElement('button');
    c._pickerEl = document.createElement('div');
    c._resetPanZoom = vi.fn();
    c._renderOwnship = vi.fn();
    c._renderPdf = vi.fn();
    return c;
}

describe('minimums: the airport\'s own page', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('shows the airport\'s minimums image, not the whole volume PDF', () => {
        const c = viewer([{ icao: 'KTMB', chart_code: 'MIN', chart_name: 'TAKEOFF MINIMUMS', pdf_name: 'SE3TO.PDF' }]);
        c._showPlate(0);
        expect(c._imgEl.src).toBe('http://localhost:9090/plates/KTMB/SE3TO.webp');
        expect(c._imgEl.style.display).toBe('');
        expect(c._renderPdf).not.toHaveBeenCalled();
    });

    it('no image on the tablet: the PDF is drawn instead', () => {
        const c = viewer([{ icao: 'KTMB', chart_code: 'MIN', chart_name: 'ALTERNATE MINIMUMS', pdf_name: 'SE3ALT.PDF' }]);
        c._showPlate(0);
        c._imgEl.onerror();
        expect(c._renderPdf).toHaveBeenCalledWith('http://localhost:9090/plates/KTMB/SE3ALT.PDF', expect.anything());
        expect(c._imgEl.style.display).toBe('none');
    });

    it('other plates without a georef entry are still drawn from the PDF', () => {
        const c = viewer([{ icao: 'KTMB', chart_code: 'STAR', chart_name: 'FROGZ FIVE (RNAV)', pdf_name: '00257FROGZ.PDF' }]);
        c._showPlate(0);
        expect(c._renderPdf).toHaveBeenCalledWith('http://localhost:9090/plates/KTMB/00257FROGZ.PDF', expect.anything());
    });
});
