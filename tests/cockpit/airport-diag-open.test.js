/**
 * DIAG tab: the airport diagram opens (reported 2026-10-15).
 *
 * The DIAG pane showed the diagram inline (pipeline WebP) with only pinch-zoom:
 * a tap did nothing, unlike the A/FD tab's "Tap to open full screen". With no
 * WebP it fell back to the PDF in an <iframe>, which Android's WebView can't
 * show. Now (reusing what exists):
 *  - a tap opens the approach-plate viewer (ApproachCharts) at that diagram,
 *    full screen, with its own WebP -> PDF.js rendering and pinch-zoom;
 *  - no WebP: the PDF is drawn inline by renderPdfToContainer (pdf-render.js).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
global.wireTap = wireTap;
const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();
const ApproachCharts = new Function(read('web/cockpit/approach-charts.js') + '\nreturn ApproachCharts;')();

// Same shape as the tablet's plate_index.json (checked 2026-10-15: KCLT key,
// chart_code / chart_name / pdf_name fields).
const INDEX = { KCLT: { name: 'Charlotte', plates: [
    { chart_code: 'IAP', chart_name: 'ILS OR LOC RWY 18', pdf_name: '00078IL18.PDF', cycle: '2609' },
    { chart_code: 'APD', chart_name: 'AIRPORT DIAGRAM', pdf_name: '00078AD.PDF', cycle: '2609' },
] } };

function tap(el) {
    const t = { clientX: 100, clientY: 100 };
    el.dispatchEvent(Object.assign(new Event('touchstart', { bubbles: true }), { touches: [t] }));
    el.dispatchEvent(Object.assign(new Event('touchend', { bubbles: true, cancelable: true }), { changedTouches: [t] }));
}

function popup(approachCharts) {
    const p = Object.create(AirportPopup.prototype);
    p._approachCharts = approachCharts;
    p.close = vi.fn();
    return p;
}

describe('DIAG pane', () => {
    let pane;
    beforeEach(() => {
        document.body.innerHTML = '<div class="apt-plate-pane" data-plate-type="APD"></div>';
        pane = document.querySelector('.apt-plate-pane');
        global.renderPdfToContainer = vi.fn(async (url, el) => { const w = document.createElement('div'); el.appendChild(w); return w; });
    });
    afterEach(() => { delete global.renderPdfToContainer; });

    it('shows the diagram WebP inline with a "Tap to open full screen" hint, and no <iframe>', async () => {
        const charts = { _plateIndex: INDEX, showPlateForAirport: vi.fn() };
        await popup(charts)._loadPlatePaneForType(pane, 'KCLT', 'APD');
        const img = pane.querySelector('img.apt-plate-img');
        expect(img.getAttribute('src')).toBe('http://localhost:9090/plates/KCLT/00078AD.webp');
        expect(pane.textContent).toMatch(/Tap to open full screen/);
        expect(pane.querySelector('iframe')).toBeNull();
    });

    it('a tap opens the approach-plate viewer at THIS diagram and closes the panel', async () => {
        const charts = { _plateIndex: INDEX, showPlateForAirport: vi.fn() };
        const p = popup(charts);
        await p._loadPlatePaneForType(pane, 'KCLT', 'APD');
        tap(pane.querySelector('.apt-plate-img-wrap'));
        expect(charts.showPlateForAirport).toHaveBeenCalledTimes(1);
        const [icao, match] = charts.showPlateForAirport.mock.calls[0];
        expect(icao).toBe('KCLT');
        expect(match({ pdf_name: '00078AD.PDF' })).toBe(true);
        expect(match({ pdf_name: '00078IL18.PDF' })).toBe(false);
        expect(p.close).toHaveBeenCalled();
    });

    it('no WebP: the PDF is drawn with renderPdfToContainer (not an iframe)', async () => {
        const charts = { _plateIndex: INDEX, showPlateForAirport: vi.fn() };
        await popup(charts)._loadPlatePaneForType(pane, 'KCLT', 'APD');
        pane.querySelector('img.apt-plate-img').dispatchEvent(new Event('error'));
        expect(renderPdfToContainer).toHaveBeenCalledTimes(1);
        expect(renderPdfToContainer.mock.calls[0][0]).toBe('http://localhost:9090/plates/KCLT/00078AD.PDF');
        expect(renderPdfToContainer.mock.calls[0][1]).toBe(pane.querySelector('.apt-plate-img-wrap'));
        expect(pane.querySelector('img.apt-plate-img')).toBeNull();
        expect(pane.querySelector('iframe')).toBeNull();
    });

    it('no approach-plate viewer available: no hint, a tap does nothing', async () => {
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => INDEX }));
        const p = popup(null);
        await p._loadPlatePaneForType(pane, 'KCLT', 'APD');
        expect(pane.textContent).not.toMatch(/Tap to open/);
        tap(pane.querySelector('.apt-plate-img-wrap'));
        expect(p.close).not.toHaveBeenCalled();
    });
});

describe('IAP tab: a plate with no WebP', () => {
    afterEach(() => { delete global.renderPdfToContainer; });

    it('is drawn with renderPdfToContainer, not a blank <iframe>', async () => {
        document.body.innerHTML = '<div class="apt-plate-list-pane"></div>';
        const pane = document.querySelector('.apt-plate-list-pane');
        global.renderPdfToContainer = vi.fn(async () => document.createElement('div'));
        const p = popup({ _plateIndex: INDEX, showPlateForAirport: vi.fn() });
        p._enablePinchZoom = vi.fn();
        await p._loadPlateListPane(pane, 'KCLT');
        const row = [...pane.querySelectorAll('.apt-plate-list-row')].find((r) => r.dataset.pdf === '00078IL18.PDF');
        tap(row);
        expect(pane.querySelector('iframe')).toBeNull();
        pane.querySelector('img.apt-plate-img').dispatchEvent(new Event('error'));
        expect(renderPdfToContainer).toHaveBeenCalledWith('http://localhost:9090/plates/KCLT/00078IL18.PDF', pane.querySelector('.apt-plate-img-wrap'), expect.any(Object));
        expect(pane.querySelector('img.apt-plate-img')).toBeNull();
    });
});

describe('ApproachCharts.showPlateForAirport', () => {
    function charts() {
        const c = Object.create(ApproachCharts.prototype);
        c.showForAirport = vi.fn(async () => {
            c._plates = [
                { icao: 'CLT', type: 'IAP', pdf_name: '00078IL18.PDF' },
                { icao: 'CLT', type: 'APD', pdf_name: '00078AD.PDF' },
            ];
        });
        c._showPlate = vi.fn();
        return c;
    }

    it('opens the airport list, then the matching plate in the viewer', async () => {
        const c = charts();
        await c.showPlateForAirport('KCLT', (p) => p.pdf_name === '00078AD.PDF');
        expect(c.showForAirport).toHaveBeenCalledWith('KCLT');
        expect(c._showPlate).toHaveBeenCalledWith(1);
    });

    it('no matching plate: stays on the airport plate list', async () => {
        const c = charts();
        await c.showPlateForAirport('KCLT', () => false);
        expect(c._showPlate).not.toHaveBeenCalled();
    });
});
