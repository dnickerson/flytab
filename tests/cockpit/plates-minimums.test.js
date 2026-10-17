/**
 * Takeoff / alternate minimums (Dana, 2026-10-16: "The takeoff minimums does
 * not display the KTMB minimums"). The FAA publishes them as one document per
 * volume -- SE3TO.PDF, 49 pages, every SE-3 airport. The full-screen viewer drew
 * that PDF (no georef entry), starting at page 1: another airport. The
 * pipeline's image for the plate is this airport's own page(s); show it. If it
 * is missing, say so -- drawing the PDF would show another airport (review).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('plate viewer and picker show the charts\' cycle and expiry (round 2 review)', () => {
    const FaaCurrency = new Function(readFileSync('web/shared/faa-currency.js', 'utf8') + '\nreturn FaaCurrency;')();
    beforeEach(() => { globalThis.FaaCurrency = FaaCurrency; });
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

    const INDEX = { KTMB: { state: 'FL', cycle: '2610', plates: [{ chart_code: 'IAP', chart_name: 'ILS RWY 9R', pdf_name: '05349IL9R.PDF', cycle: '2610' }] },
                    KATL: { state: 'GA', cycle: '2611', plates: [{ chart_code: 'IAP', chart_name: 'ILS RWY 8L', pdf_name: '00026IL8L.PDF', cycle: '2611' }] } };
    const dev = (exp, failed = []) => localStorage.setItem('flytab_device_manifest',
        JSON.stringify({ plates: { cycle_code: '261001', expiration_date: exp, failed_states: failed } }));

    function shown(icao, now) {
        vi.useFakeTimers({ now: new Date(now) });
        const c = viewer([{ ...INDEX[icao].plates[0], icao }]);
        c._plateIndex = INDEX;
        c._viewerEl.innerHTML = '<div class="approach-viewer-header"><div class="approach-viewer-title"></div></div><div class="approach-viewer-body"></div>';
        c._showPlate(0);
        return c._viewerEl.querySelector('.approach-currency');
    }

    it('current: cycle and expiry, not red', () => {
        dev('2026-10-29');
        const el = shown('KTMB', '2026-10-20T12:00:00Z');
        expect(el.textContent).toMatch(/Cycle 2610.*expires 29 OCT 2026/);
        expect(el.classList.contains('is-bad')).toBe(false);
    });
    it('expired: red EXPIRED', () => {
        dev('2026-10-29');
        const el = shown('KTMB', '2026-10-29T09:02:00Z');
        expect(el.textContent).toMatch(/EXPIRED/);
        expect(el.classList.contains('is-bad')).toBe(true);
    });
    it('an airport in a state whose sync failed: previous cycle, red', () => {
        dev('2026-11-26', ['GA']);
        const el = shown('KATL', '2026-10-30T12:00:00Z');
        expect(el.textContent).toMatch(/GA.*not updated.*previous cycle/i);
        expect(el.classList.contains('is-bad')).toBe(true);
    });
    it('the picker shows it under each airport', () => {
        dev('2026-10-29');
        vi.useFakeTimers({ now: new Date('2026-10-30T12:00:00Z') });
        const c = viewer([]);
        c._plateIndex = INDEX;
        c._routeAirports = [];
        c._findGeoref = () => null;
        c._pickerEl.innerHTML = '<div class="approach-picker-list"></div>';
        c._buildPicker('KTMB');
        const el = c._pickerEl.querySelector('.approach-currency');
        expect(el.textContent).toMatch(/EXPIRED/);
    });
});

describe('A/FD tab shows whether its page is current (round 2 review)', () => {
    afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
    it('stale A/FD (failed its check at sync): red "not current" line', async () => {
        const AirportPopup = new Function(readFileSync('web/cockpit/airport-popup.js', 'utf8') + '\nreturn AirportPopup;')();
        globalThis.FaaCurrency = new Function(readFileSync('web/shared/faa-currency.js', 'utf8') + '\nreturn FaaCurrency;')();
        localStorage.setItem('flytab_device_manifest', JSON.stringify({ afd: { expiration_date: '2026-10-29', stale: true, note: 'A/FD pages not current (x)' } }));
        vi.useFakeTimers({ now: new Date('2026-10-20T12:00:00Z') });
        const pane = document.createElement('div');
        const p = Object.create(AirportPopup.prototype);
        let created;
        const origCreate = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tag) => { const el = origCreate(tag); if (tag === 'img') created = el; return el; });
        await p._loadAfdPane(pane, 'KTMB');
        created.onload();
        const line = pane.querySelector('.approach-currency');
        expect(line.textContent).toMatch(/not current/i);
        expect(line.classList.contains('is-bad')).toBe(true);
        document.createElement.mockRestore();
    });
    it('current A/FD: edition expiry shown, not red', async () => {
        const AirportPopup = new Function(readFileSync('web/cockpit/airport-popup.js', 'utf8') + '\nreturn AirportPopup;')();
        globalThis.FaaCurrency = new Function(readFileSync('web/shared/faa-currency.js', 'utf8') + '\nreturn FaaCurrency;')();
        localStorage.setItem('flytab_device_manifest', JSON.stringify({ afd: { expiration_date: '2026-10-29', stale: false } }));
        vi.useFakeTimers({ now: new Date('2026-10-20T12:00:00Z') });
        const pane = document.createElement('div');
        const p = Object.create(AirportPopup.prototype);
        let created;
        const origCreate = document.createElement.bind(document);
        vi.spyOn(document, 'createElement').mockImplementation((tag) => { const el = origCreate(tag); if (tag === 'img') created = el; return el; });
        await p._loadAfdPane(pane, 'KTMB');
        created.onload();
        const line = pane.querySelector('.approach-currency');
        expect(line.textContent).toMatch(/expires 29 OCT 2026/);
        expect(line.classList.contains('is-bad')).toBe(false);
        document.createElement.mockRestore();
    });
});
