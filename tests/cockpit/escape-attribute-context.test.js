/**
 * Network text in an HTML ATTRIBUTE needs " and ' escaped too: escaping only & < >
 * let a MOS flight category of  VFR" onclick="alert(1)" x="  close the class
 * attribute and add an onclick (security review 2026-11-01). Category values used
 * in a class are also whitelisted (vfr / mvfr / ifr / lifr, else unknown), and the
 * TAF change kind to the classes the CSS defines (fm / becmg / tempo / prob).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const alt = new Function(read('web/shared/altitude-utils.js') + '\nreturn { parseAltFt, formatAlt, formatAdvisoryAltBand };')();
Object.assign(globalThis, alt);
const WxBriefing = new Function(read('web/cockpit/wx-briefing.js') + '\nreturn WxBriefing;')();
const FisbWeatherDisplay = new Function(read('web/cockpit/fisb-weather.js') + '\nreturn FisbWeatherDisplay;')();
const FlightUpload = new Function(read('web/cockpit/flight-upload.js') + '\nreturn FlightUpload;')();

const DQ = 'VFR" onclick="alert(1)" x="';
const SQ = "VFR' onclick='alert(1)' x='";
const PAYLOADS = [DQ, SQ];

/** No element in el carries an inline event handler attribute. */
function noHandlers(el) {
    for (const n of el.querySelectorAll('*')) {
        for (const a of n.attributes) expect(a.name.startsWith('on'), `${n.tagName} ${a.name}`).toBe(false);
    }
}
const future = () => new Date(Date.now() + 3 * 3600e3).toISOString();

beforeEach(() => { document.body.innerHTML = ''; });

describe('wx-briefing _escHtml', () => {
    it('escapes & < > " and \'', () => {
        const w = Object.create(WxBriefing.prototype);
        expect(w._escHtml(`<a href="x" title='y'>&`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
        expect(w._escHtml(null)).toBe('');
        expect(w._escHtml(12)).toBe('12');
    });

    it('category class whitelist', () => {
        expect(WxBriefing._catClass('VFR')).toBe('vfr');
        expect(WxBriefing._catClass('lifr')).toBe('lifr');
        for (const bad of [DQ, SQ, '', null, undefined, 'VFR ', 'X', 42]) expect(WxBriefing._catClass(bad)).toBe('unknown');
    });
});

describe('wx-briefing attribute sinks with quote payloads', () => {
    for (const payload of PAYLOADS) {
        it(`MOS detail table (${payload[3]})`, () => {
            const w = Object.create(WxBriefing.prototype);
            w._mosData = { stations: { KAAA: { periods: [{ valid_time: future(), flight_cat: payload, cig_label: payload,
                vis_label: payload, obv: payload, pop: payload, tp6: payload, mix_ht: payload, tmp: payload, dpt: payload }] } } };
            w._buildMosSummaryNote = () => '';
            const section = w._buildAirportDetail('KAAA');
            document.body.appendChild(section);
            noHandlers(section);
            const cat = section.querySelector('.wx-cat-badge');
            expect(cat.className).toBe('wx-cat-badge wx-cat-unknown');
            expect(cat.textContent).toBe(payload);
            expect(section.textContent).toContain(payload);
        });

        it(`MOS period grid (${payload[3]})`, () => {
            const w = Object.create(WxBriefing.prototype);
            w._mosData = { stations: { KAAA: { periods: [{ valid_time: future(), flight_cat: payload, wdr: 180, wsp: 10 }] } } };
            const panel = document.createElement('div');
            document.body.appendChild(panel);
            w._populateMosPanel(panel, 'KAAA');
            noHandlers(panel);
            const cat = panel.querySelector('.wx-mos-pg-cat');
            expect(cat.className).toBe('wx-mos-pg-cat wx-cat-unknown');
            expect(cat.textContent).toBe(payload);
        });

        it(`TAF row change kind (${payload[3]})`, () => {
            globalThis.WeatherClient = { getFlightCategory: () => 'VFR' };
            const w = Object.create(WxBriefing.prototype);
            const el = document.createElement('div');
            el.innerHTML = w._buildTafRow({ timeFrom: 1, timeTo: 2, fcstChange: payload, clouds: [] });
            document.body.appendChild(el);
            noHandlers(el);
            expect(el.querySelector('.wx-taf-row').className).toBe('wx-taf-row');
        });

        it(`planning-summary category badge (${payload[3]})`, () => {
            const w = Object.create(WxBriefing.prototype);
            const sec = document.createElement('div');
            document.body.appendChild(sec);
            w._section = () => sec;
            w._getStationList = () => ['KAAA', 'KBBB'];
            w._mosData = null;
            w._buildPlanningNarrative = () => null;
            w._worstCatForDay = () => payload;
            // the fallback grid reads _mosData.stations: give it stations but no best day
            w._mosData = { stations: { KAAA: {}, KBBB: {} } };
            w._findBestDay = () => null;
            w._renderPlanningSection();
            noHandlers(sec);
            const badges = sec.querySelectorAll('.wx-cat-badge');
            expect(badges.length).toBeGreaterThan(0);
            for (const b of badges) {
                expect(b.className).toBe('wx-cat-badge wx-cat-unknown');
                expect(b.textContent.trim()).toBe(payload);
            }
        });
    }

    it('a valid category keeps its class', () => {
        const w = Object.create(WxBriefing.prototype);
        w._mosData = { stations: { KAAA: { periods: [{ valid_time: future(), flight_cat: 'MVFR' }] } } };
        const panel = document.createElement('div');
        w._populateMosPanel(panel, 'KAAA');
        expect(panel.querySelector('.wx-mos-pg-cat').className).toBe('wx-mos-pg-cat wx-cat-mvfr');
    });

    it('a valid TAF change kind keeps its class', () => {
        globalThis.WeatherClient = { getFlightCategory: () => 'VFR' };
        const w = Object.create(WxBriefing.prototype);
        const el = document.createElement('div');
        el.innerHTML = w._buildTafRow({ timeFrom: 1, timeTo: 2, fcstChange: 'TEMPO', clouds: [] });
        expect(el.querySelector('.wx-taf-row').className).toBe('wx-taf-row wx-taf-tempo');
    });
});

describe('other attribute sinks on this branch', () => {
    for (const payload of PAYLOADS) {
        it(`fisb-weather AIRMET badge class (${payload[3]})`, () => {
            const el = document.createElement('div');
            el.innerHTML = FisbWeatherDisplay._renderAdvisoryRow({ type: 'airmet', advisory: { product: payload, hazard: 'TURB' } });
            document.body.appendChild(el);
            noHandlers(el);
            expect(el.querySelector('.adv-tap-badge').textContent).toBe(payload);
        });

        it(`flight-upload data-filename (${payload[3]})`, () => {
            globalThis.wireTap = (e, fn) => e.addEventListener('click', fn);
            localStorage.clear();
            const fu = new FlightUpload();
            const name = `X${payload}.csv`;
            fu._flights = [{ name, size_bytes: 1, modified_ms: 1 }];
            fu._render();
            noHandlers(fu._el);
            expect(fu._el.querySelector('.fu-upload-btn').dataset.filename).toBe(name);
        });
    }

    it('FisbWeatherDisplay._esc escapes both quote kinds', () => {
        expect(FisbWeatherDisplay._esc(`"'`)).toBe('&quot;&#39;');
    });
});
