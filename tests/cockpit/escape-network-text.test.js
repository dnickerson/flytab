/**
 * FIS-B is an unauthenticated radio broadcast, and METAR/TAF/MOS/runway data also
 * arrive over the network: their text must reach the screen as text, never as HTML.
 * Each sink fixed here gets a report carrying <img src=x onerror=...>; the test
 * renders the produced HTML into the DOM and checks no <img> element appears and the
 * text is shown literally. Formatting added by FlyTab (TAF FM line breaks) is kept.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();
const FisbWeatherDisplay = new Function(read('web/cockpit/fisb-weather.js') + '\nreturn FisbWeatherDisplay;')();
const VectorMapLayers = new Function(read('web/cockpit/vector-map-layers.js') + '\nreturn VectorMapLayers;')();
const WxBriefing = new Function(read('web/cockpit/wx-briefing.js') + '\nreturn WxBriefing;')();
const FlightUpload = new Function(read('web/cockpit/flight-upload.js') + '\nreturn FlightUpload;')();

const alt = new Function(read('web/shared/altitude-utils.js') + '\nreturn { parseAltFt, formatAlt, formatAdvisoryAltBand };')();
Object.assign(globalThis, alt);

const EVIL = '<img src=x onerror=alert(1)>';

/** Render html into a fresh element; return it. */
function render(html) {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
}
function expectInert(el) {
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain(EVIL);
}

beforeEach(() => {
    document.body.innerHTML = '';
    delete globalThis.FisbClient;
});

describe('airport-popup', () => {
    const popup = () => Object.create(AirportPopup.prototype);

    it('_formatTaf escapes the TAF and still breaks lines before FM groups', () => {
        const el = render(popup()._formatTaf(`TAF KAAA 011130Z ${EVIL} FM011500 18010KT P6SM FM012000 VRB03KT`));
        expectInert(el);
        expect(el.querySelectorAll('br')).toHaveLength(2);
        expect(el.innerHTML).toContain('<br>FM011500');
    });

    it('_weatherHtml: METAR raw, flight category, visibility and TAF render as text', () => {
        const wx = {
            source: 'fisb',
            metar: {
                raw: `KAAA 011153Z 18010KT 10SM ${EVIL} SCT050 RMK ${EVIL}`,
                decoded: { flight_category: EVIL, visibility_sm: EVIL, wind_dir: EVIL, wind_speed: 10 },
            },
            taf: { raw: `TAF KAAA ${EVIL} FM011500 18010KT` },
        };
        const el = render(popup()._weatherHtml(wx));
        expect(el.querySelector('img')).toBeNull();
        expect(el.querySelector('.wx-metar').textContent).toContain(EVIL);
        expect(el.querySelector('.wx-taf').textContent).toContain(EVIL);
        expect(el.querySelector('.wx-cat-name').textContent).toBe(EVIL);
    });

    it('_buildPanelHtml header category badge renders as text', () => {
        globalThis.NasrDB = { haversineNm: () => 1 };
        globalThis.CockpitConfig = { get: () => null };
        const p = popup();
        p._tfrBlockHtml = () => '';
        const el = render(p._buildPanelHtml({ icao: 'KAAA', runways: [] }, {
            metar: { raw: 'KAAA', decoded: { flight_category: EVIL } },
        }));
        expect(el.querySelector('img')).toBeNull();
        expect(el.querySelector('.apt-panel-icao').textContent).toContain(EVIL);
    });

    it('live FIS-B TAF and METAR updates render as text', () => {
        const p = popup();
        const fisb = new EventTarget();
        p._fisbClient = fisb;
        p._panelOpen = true;
        p._panel = render('<div class="apt-tab-pane" data-pane="wx"><div class="wx-metar">old</div></div>');
        p._updateWindCompass = () => {};
        p._startFisbListener({ icao: 'KAAA' });

        fisb.dispatchEvent(Object.assign(new Event('fisb:taf'), { detail: { icao: 'KAAA', raw: `TAF KAAA ${EVIL} FM011500 X` } }));
        expect(p._panel.querySelector('img')).toBeNull();
        expect(p._panel.querySelector('.wx-taf').textContent).toContain(EVIL);
        expect(p._panel.querySelector('.wx-taf br')).not.toBeNull();

        fisb.dispatchEvent(Object.assign(new Event('fisb:metar'), {
            detail: { icao: 'KAAA', raw: `KAAA 011153Z ${EVIL}`, decoded: {}, received_at: Date.now() },
        }));
        expect(p._panel.querySelector('img')).toBeNull();
        expect(p._panel.querySelector('.wx-metar').textContent).toContain(EVIL);
    });

    it('runway rows (AWC runway data is cached into NASR) render as text', () => {
        const el = render(popup()._runwaysHtml([{ id: EVIL, length_ft: 3000, width_ft: 75, surface: EVIL }]));
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain(EVIL);
        const facts = render(popup()._aptFactsHtml({ runways: [{ id: EVIL }] }));
        expect(facts.querySelector('img')).toBeNull();
    });
});

describe('fisb-weather', () => {
    function leafletStub() {
        const popups = [];
        globalThis.L = {
            divIcon: (o) => o,
            marker: () => ({
                bindPopup(html) { popups.push(html); return this; },
                addTo() { return this; },
            }),
        };
        return popups;
    }

    it('PIREP popup renders the PIREP as text', () => {
        const popups = leafletStub();
        const d = Object.create(FisbWeatherDisplay.prototype);
        d._pirepLayer = {};
        d._pirepMarkers = [];
        d._showAlert = vi.fn();
        d._addPirep({ lat: 35, lon: -80, type: 'turbulence', severity: 2, raw: `UA /OV CLT ${EVIL}`, received_at: Date.now() });
        expectInert(render(popups[0]));
    });

    it('winds-aloft popup station name renders as text', () => {
        const popups = leafletStub();
        const d = Object.create(FisbWeatherDisplay.prototype);
        d._buildWindMarker(EVIL, { lat: 35, lon: -80, winds: [{ alt: 3000, dir: 180, spd: 10, temp: 5, label: '3k', color: '#fff' }] });
        expectInert(render(popups[0]));
    });

    it('SIGMET / AIRMET / CWA tap rows render the report as text', () => {
        for (const type of ['sigmet', 'cwa', 'airmet']) {
            const html = FisbWeatherDisplay._renderAdvisoryRow({ type, advisory: { raw: `${EVIL}`, due_to: EVIL, hazard: 'TURB' } });
            expect(render(html).querySelector('img')).toBeNull();
        }
    });
});

describe('vector-map-layers thunderstorm (CB) popup', () => {
    it('METAR remarks, station and direction render as text', () => {
        const v = Object.create(VectorMapLayers.prototype);
        const el = render(v._buildCbPopupHtml({
            icao: EVIL, type: 'TS', reason: { keyword: EVIL, directions: [EVIL] },
            raw: `KAAA 011153Z 18010KT RMK ${EVIL}`, observed_at: null,
        }));
        expect(el.querySelector('img')).toBeNull();
        expect(el.querySelector('.cb-popup-raw').textContent).toContain(EVIL);
    });
});

describe('wx-briefing', () => {
    it('station card decoded METAR fields render as text', () => {
        const w = Object.create(WxBriefing.prototype);
        w._tafData = {};
        const body = document.createElement('div');
        document.body.appendChild(body);
        w._populateStationCardBody(body, 'KAAA', {
            raw: `KAAA ${EVIL}`,
            decoded: { wind_dir: EVIL, wind_speed: EVIL, visibility: EVIL, ceiling: EVIL, temperature: EVIL, dewpoint: EVIL },
        });
        expect(body.querySelector('img')).toBeNull();
        expect(body.textContent).toContain(EVIL);
    });

    it('MOS period grid renders its labels as text', () => {
        const w = Object.create(WxBriefing.prototype);
        const vt = new Date(Date.now() + 3 * 3600e3).toISOString();
        w._mosData = { stations: { KAAA: { periods: [{ valid_time: vt, flight_cat: EVIL, cig_label: EVIL, vis_label: EVIL, wdr: 180, wsp: 10, tmp: EVIL, dpt: EVIL }] } } };
        const panel = document.createElement('div');
        document.body.appendChild(panel);
        w._populateMosPanel(panel, 'KAAA');
        expect(panel.querySelector('img')).toBeNull();
        expect(panel.textContent).toContain(EVIL);
    });
});

describe('flight-upload', () => {
    it('a flight file name renders as text in the list (also in the button data attribute)', () => {
        globalThis.wireTap = (el, fn) => el.addEventListener('click', fn);
        localStorage.clear();
        const fu = new FlightUpload();
        const name = `20260101_${EVIL}".csv`;
        fu._flights = [{ name, size_bytes: 1, modified_ms: 1 }];
        fu._render();
        const list = fu._el.querySelector('.fu-list');
        expect(list.querySelector('img')).toBeNull();
        expect(list.querySelector('.fu-filename').textContent).toBe(name);
        expect(list.querySelector('.fu-upload-btn').dataset.filename).toBe(name);
    });
});

describe('app.showToast', () => {
    function extractMethod(source, signature) {
        const start = source.indexOf(signature);
        const open = source.indexOf('{', start);
        let depth = 0;
        for (let i = open; i < source.length; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
        }
        throw new Error('unbalanced');
    }
    const showToast = new Function('message', 'actions = []',
        extractMethod(read('web/app.js'), 'showToast(message, actions = []) {'));

    it('shows the message as text (SFTP server error strings reach it)', () => {
        const t = showToast.call({}, `Upload failed: ${EVIL}`);
        expect(t.querySelector('img')).toBeNull();
        expect(t.querySelector('span').textContent).toBe(`Upload failed: ${EVIL}`);
        expect(t.querySelector('[data-action="dismiss"]')).not.toBeNull();
    });

    it('still wires action buttons', () => {
        const fn = vi.fn();
        const t = showToast.call({}, 'x', [{ label: 'Undo', action: fn }]);
        t.querySelector('[data-action="0"]').click();
        expect(fn).toHaveBeenCalled();
        expect(t.querySelector('[data-action="0"]').textContent).toBe('Undo');
    });
});
