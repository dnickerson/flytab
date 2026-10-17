/**
 * Takeoff / alternate minimums (Dana, 2026-10-16: "The takeoff minimums does
 * not display the KTMB minimums"). The FAA publishes them as one document per
 * volume -- SE3TO.PDF, 49 pages, every SE-3 airport. The full-screen viewer drew
 * that PDF (no georef entry), starting at page 1: another airport. The
 * pipeline's image for the plate is this airport's own page(s); show it. If it
 * is missing, say so -- drawing the PDF would show another airport (review).
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

    it('no image on the tablet: a message, never the volume PDF (its page 1 is another airport)', () => {
        const c = viewer([{ icao: 'KTMB', chart_code: 'MIN', chart_name: 'ALTERNATE MINIMUMS', pdf_name: 'SE3ALT.PDF' }]);
        c._showPlate(0);
        c._imgEl.onerror();
        expect(c._renderPdf).not.toHaveBeenCalled();
        expect(c._imgEl.style.display).toBe('none');
        expect(c._panContainer.textContent).toMatch(/KTMB.*minimums.*not on this tablet.*Data Status/i);
    });

    it('other plates without a georef entry are still drawn from the PDF', () => {
        const c = viewer([{ icao: 'KTMB', chart_code: 'STAR', chart_name: 'FROGZ FIVE (RNAV)', pdf_name: '00257FROGZ.PDF' }]);
        c._showPlate(0);
        expect(c._renderPdf).toHaveBeenCalledWith('http://localhost:9090/plates/KTMB/00257FROGZ.PDF', expect.anything());
    });
});

describe('airport popup minimums pane: no image, no volume PDF', () => {
    it('shows a message instead of drawing the regional document from page 1', async () => {
        const { wireTap } = new Function(readFileSync('web/shared/tap-utils.js', 'utf8') + '\nreturn { wireTap };')();
        globalThis.wireTap = wireTap;
        const AirportPopup = new Function(readFileSync('web/cockpit/airport-popup.js', 'utf8') + '\nreturn AirportPopup;')();
        globalThis.renderPdfToContainer = vi.fn(async () => document.createElement('div'));
        document.body.innerHTML = '<div class="apt-plate-pane"></div>';
        const pane = document.querySelector('.apt-plate-pane');
        const p = Object.create(AirportPopup.prototype);
        p._approachCharts = { _plateIndex: { KTMB: { plates: [{ chart_code: 'MIN', chart_name: 'TAKEOFF MINIMUMS', pdf_name: 'SE3TO.PDF' }] } },
                              showPlateForAirport: vi.fn() };
        p.close = vi.fn();
        await p._loadPlatePaneForType(pane, 'KTMB', 'MIN');
        expect(pane.querySelector('img.apt-plate-img').getAttribute('src')).toBe('http://localhost:9090/plates/KTMB/SE3TO.webp');
        pane.querySelector('img.apt-plate-img').dispatchEvent(new Event('error'));
        expect(renderPdfToContainer).not.toHaveBeenCalled();
        expect(pane.textContent).toMatch(/minimums page is not on this tablet/);
        delete globalThis.renderPdfToContainer;
    });
});
