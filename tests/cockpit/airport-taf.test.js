/**
 * Airport panel WX tab: the TAF, from FIS-B and from the internet.
 *
 * Internet: AWC's TAF endpoint through the flywhere proxy (Settings.workerBase). AWC now answers
 * `hours=24` with 400 "Unexpected query parameter provided" (proxy: 502), so the request has no
 * `hours`. FIS-B: FisbClient.getTaf() and the live 'fisb:taf' event. A TAF shows whatever the METAR
 * source, and without a METAR; with two TAFs the later-ISSUED one (its DDHHMMZ group) is shown.
 *
 * Real: AirportPopup, FisbClient (the TAF frames go through its _handleWeather), wireTap.
 * Stubbed: fetch, the NASR store, Settings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
const { wireTap } = new Function(read('web/shared/tap-utils.js') + '\nreturn { wireTap };')();
const FisbClient = new Function(read('web/shared/fisb-client.js') + '\nreturn FisbClient;')();
const AirportPopup = new Function(read('web/cockpit/airport-popup.js') + '\nreturn AirportPopup;')();

const NOW = Date.parse('2026-11-04T17:00:00Z');

/** Real AWC reply (via https://www.flywhere.app/api/weather?type=taf&ids=KCLT&format=json, 2026-11-04), trimmed to the fields used. */
const AWC_RAW = 'TAF KCLT 041535Z 0416/0518 11005KT P6SM SCT005 BKN012 FM042000 17010G18KT P6SM SCT025 BKN050 FM050000 16008KT P6SM VCSH BKN035 PROB30 0502/0508 3SM SHRA SCT005 BKN015 FM050900 16006KT P6SM SCT007 BKN015';
const AWC_REPLY = [{
    icaoId: 'KCLT', bulletinTime: '2026-11-04T15:35:00.000Z', issueTime: '2026-11-04T15:35:00.000Z',
    validTimeFrom: 1793808000, validTimeTo: 1793901600, rawTAF: AWC_RAW, mostRecent: 1, name: 'Charlotte/Douglas Intl, NC, US',
}];

/** A Stratux TAF frame as it arrives (Type, Location, Time, Data split on spaces). */
const stratuxMsg = (m) => { const x = m.split(' '); return { Type: x[0], Location: x[1], Time: x[2], Data: x.slice(3).join(' ') }; };
const FISB_OLDER = 'TAF KCLT 041120Z 0412/0518 09004KT P6SM BKN015 FM041800 15008KT P6SM BKN030';     // before AWC's 1535Z
const FISB_NEWER = 'TAF.AMD KCLT 041650Z 0417/0518 18012G22KT P6SM BKN025 FM050000 16008KT P6SM BKN035'; // after it

const METAR_DECODED = { flight_category: 'MVFR', wind_dir: 110, wind_speed: 5, visibility_sm: 10 };
const KCLT = { icao: 'KCLT', name: 'CHARLOTTE/DOUGLAS INTL', lat: 35.214, lon: -80.943, elev_ft: 748, runways: [], frequencies: [] };

let fisb, nasrWx, vectorLayers;

async function fisbWith(...frames) {
    const c = new FisbClient(new EventTarget(), null);
    for (const f of frames) await c._handleWeather(stratuxMsg(f));
    return c;
}
function newPopup() {
    const p = new AirportPopup({ closePopup() {} }, { getWeather: async (id) => nasrWx[id] || null, getRemarks: async () => [] });
    p.initPanel(document.body);
    if (fisb) p.setFisbClient(fisb);
    if (vectorLayers) p.setVectorLayers(vectorLayers);
    return p;
}
async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i++) await Promise.resolve();
}
const okReply = (body) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
const wxPane = () => document.querySelector('.apt-tab-pane[data-pane="wx"]');
/** The TAF as the pilot reads it: each <br> (before an FM group) read back as the space it replaced. */
const tafText = () => {
    const el = wxPane().querySelector('.wx-taf');
    return el ? [...el.childNodes].map((n) => (n.nodeName === 'BR' ? ' ' : n.textContent)).join('') : null;
};
const metarText = () => { const el = wxPane().querySelector('.wx-metar:not(.wx-taf)'); return el ? el.textContent : null; };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    document.body.innerHTML = '';
    globalThis.wireTap = wireTap;
    globalThis.NasrDB = { haversineNm: () => 5 };
    globalThis.CockpitConfig = { get: () => null };
    globalThis.Settings = { workerBase: 'https://proxy.test/api' };
    globalThis.fetch = okReply([]);
    fisb = null;
    nasrWx = {};
    vectorLayers = null;
});

afterEach(() => {
    vi.useRealTimers();
    for (const k of ['NasrDB', 'CockpitConfig', 'Settings']) delete globalThis[k];
});

describe('internet TAF request', () => {
    it('no hours parameter, built from Settings.workerBase, the airport id encoded', async () => {
        const p = newPopup();
        await p.show({ ...KCLT, icao: 'K&?X' });
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        const url = fetch.mock.calls[0][0];
        expect(url).toBe('https://proxy.test/api/weather?type=taf&ids=K%26%3FX&format=json');
        expect(url).not.toMatch(/hours/);
        expect(url).not.toMatch(/aviationweather\.gov/);
    });

    it('without Settings it falls back to the flywhere proxy', async () => {
        delete globalThis.Settings;
        await newPopup().show(KCLT);
        await settle();
        expect(fetch.mock.calls[0][0]).toBe('https://www.flywhere.app/api/weather?type=taf&ids=KCLT&format=json');
    });

    it('a real AWC TAF reply renders in the WX tab, escaped, with FM line breaks (METAR from the plan cache)', async () => {
        nasrWx.KCLT = { metar: { raw: 'KCLT 041652Z 11005KT 10SM BKN012 17/14 A3012', decoded: METAR_DECODED }, source: 'plan' };
        globalThis.fetch = okReply(AWC_REPLY);
        await newPopup().show(KCLT);
        await settle();
        expect(tafText()).toBe(AWC_RAW);
        expect(wxPane().querySelectorAll('.wx-taf br')).toHaveLength(3);      // FM042000, FM050000, FM050900
        expect(metarText()).toContain('KCLT 041652Z');
        expect(wxPane().querySelectorAll('.wx-taf')).toHaveLength(1);
    });

    it('a 502 from the proxy (AWC rejected the request) leaves the tab without a TAF and throws nothing', async () => {
        nasrWx.KCLT = { metar: { raw: 'KCLT 041652Z 11005KT', decoded: METAR_DECODED }, source: 'plan' };
        globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: 'Upstream weather service error' }) }));
        const warn = vi.spyOn(console, 'warn');
        const p = newPopup();
        await expect(p.show(KCLT)).resolves.toBeUndefined();
        await settle();
        expect(tafText()).toBeNull();
        expect(metarText()).toContain('KCLT 041652Z');
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('offline (fetch rejects): no TAF, no error', async () => {
        globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
        await newPopup().show(KCLT);
        await settle();
        expect(wxPane().textContent).toContain('No weather data');
        expect(wxPane().querySelector('.wx-taf')).toBeNull();
    });

    it('an internet TAF with no METAR at all gets its own TAF section', async () => {
        globalThis.fetch = okReply(AWC_REPLY);
        await newPopup().show(KCLT);
        await settle();
        expect(tafText()).toBe(AWC_RAW);
        expect(wxPane().textContent).not.toContain('No weather data');
        expect(wxPane().textContent).toContain('No METAR');
    });

    it('an airport with no TAF ([] from AWC) keeps "No weather data"', async () => {
        await newPopup().show(KCLT);
        await settle();
        expect(wxPane().textContent).toContain('No weather data');
    });

    it('a reply that comes back after the panel closed is dropped', async () => {
        let resolve;
        globalThis.fetch = vi.fn(() => new Promise((r) => { resolve = r; }));
        const p = newPopup();
        await p.show(KCLT);
        p.close();
        resolve({ ok: true, status: 200, json: async () => AWC_REPLY });
        await settle();
        expect(p._taf).toBeNull();
        expect(tafText()).toBeNull();
    });
});

describe('internet TAF only when the app may be online (app.networkMode.mode)', () => {
    afterEach(() => { globalThis.window.app = undefined; });
    const withMode = (mode) => { globalThis.window.app = { networkMode: { mode } }; };

    for (const mode of ['flight', 'offline']) {
        it(`mode "${mode}" (Stratux WiFi / no network): no request; a FIS-B TAF still shows`, async () => {
            withMode(mode);
            fisb = await fisbWith(FISB_OLDER);
            await newPopup().show(KCLT);
            await settle();
            expect(fetch).not.toHaveBeenCalled();
            expect(tafText()).toContain('KCLT 041120Z');
        });
    }

    for (const mode of ['home', 'internet']) {
        it(`mode "${mode}": the internet TAF is requested`, async () => {
            withMode(mode);
            globalThis.fetch = okReply(AWC_REPLY);
            await newPopup().show(KCLT);
            await settle();
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(tafText()).toBe(AWC_RAW);
        });
    }

    it('mode unknown (no app / no networkMode / no mode yet): requested (the ground case)', async () => {
        for (const app of [undefined, {}, { networkMode: {} }, { networkMode: { mode: null } }]) {
            globalThis.window.app = app;
            globalThis.fetch = okReply([]);
            await newPopup().show(KCLT);
            await settle();
            expect(fetch).toHaveBeenCalledTimes(1);
        }
    });

    it('the mode is read at each open: flight -> home on the ground requests again', async () => {
        withMode('flight');
        const p = newPopup();
        await p.show(KCLT);
        await settle();
        expect(fetch).not.toHaveBeenCalled();
        globalThis.window.app.networkMode.mode = 'home';
        await p.show(KCLT);
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('FIS-B TAF', () => {
    it('shown with an internet METAR (the FIS-B TAF is no longer tied to a FIS-B METAR)', async () => {
        fisb = await fisbWith(FISB_NEWER);
        vectorLayers = { _internetMetars: new Map([['KCLT', { raw: 'KCLT 041652Z 11005KT 10SM', decoded: METAR_DECODED, received_at: NOW }]]) };
        await newPopup().show(KCLT);
        expect(tafText()).toBe('TAF AMD KCLT 041650Z 0417/0518 18012G22KT P6SM BKN025 FM050000 16008KT P6SM BKN035');
        expect(metarText()).toContain('KCLT 041652Z');
        expect(wxPane().querySelector('.wx-source').textContent).toBe('INTERNET');
    });

    it('shown with no METAR at all', async () => {
        fisb = await fisbWith(FISB_OLDER);
        await newPopup().show(KCLT);
        expect(tafText()).toBe('KCLT 041120Z 0412/0518 09004KT P6SM BKN015 FM041800 15008KT P6SM BKN030');
        expect(wxPane().textContent).toContain('No METAR');
        expect(wxPane().textContent).not.toContain('No weather data');
    });

    it('a FIS-B TAF in the IndexedDB cache with no METAR there is shown', async () => {
        nasrWx.KCLT = { taf: { raw: 'KCLT 041120Z 0412/0518 09004KT P6SM BKN015' }, source: 'fisb' };
        await newPopup().show(KCLT);
        expect(tafText()).toBe('KCLT 041120Z 0412/0518 09004KT P6SM BKN015');
    });

    it('with a FIS-B TAF the internet is still asked (a newer one may exist)', async () => {
        fisb = await fisbWith(FISB_OLDER);
        await newPopup().show(KCLT);
        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
    });
});

describe('FIS-B and internet TAF: the later-issued one is shown', () => {
    it('internet issued later (1535Z) than FIS-B (1120Z): the internet TAF replaces it', async () => {
        fisb = await fisbWith(FISB_OLDER);
        globalThis.fetch = okReply(AWC_REPLY);
        await newPopup().show(KCLT);
        expect(tafText()).toContain('041120Z');
        await settle();
        expect(tafText()).toBe(AWC_RAW);
        expect(wxPane().querySelectorAll('.wx-taf')).toHaveLength(1);
    });

    it('FIS-B amended later (1650Z) than the internet one (1535Z): FIS-B stays', async () => {
        fisb = await fisbWith(FISB_NEWER);
        globalThis.fetch = okReply(AWC_REPLY);
        await newPopup().show(KCLT);
        await settle();
        expect(tafText()).toContain('TAF AMD KCLT 041650Z');
    });

    it('a re-broadcast of the TAF already shown (same issue time) changes nothing', async () => {
        fisb = await fisbWith('TAF KCLT 041535Z 0416/0518 11005KT P6SM SCT005 BKN012');
        globalThis.fetch = okReply(AWC_REPLY);
        await newPopup().show(KCLT);
        await settle();
        expect(tafText()).toBe('KCLT 041535Z 0416/0518 11005KT P6SM SCT005 BKN012');   // the FIS-B text, first offered
    });

    it('issue time: the DDHHMMZ group, month inferred (the 31st read on the 1st is last month)', () => {
        expect(AirportPopup._tafIssuedMs(AWC_RAW, NOW)).toBe(Date.parse('2026-11-04T15:35:00Z'));
        expect(AirportPopup._tafIssuedMs('TAF AMD KCLT 041650Z 0417/0518', NOW)).toBe(Date.parse('2026-11-04T16:50:00Z'));
        expect(AirportPopup._tafIssuedMs('KCLT 312340Z 0100/0206 X', Date.parse('2026-11-01T00:30:00Z'))).toBe(Date.parse('2026-10-31T23:40:00Z'));
        expect(AirportPopup._tafIssuedMs('KCLT 302340Z 0100/0206 X', Date.parse('2026-12-01T00:30:00Z'))).toBe(Date.parse('2026-11-30T23:40:00Z'));
        expect(AirportPopup._tafIssuedMs('TAF KCLT 0416/0518 FM042000 X', NOW)).toBeNull();
    });
});

describe('live fisb:taf while the panel is open', () => {
    it('with a METAR section: the TAF is added under the METAR, a newer one replaces it', async () => {
        fisb = await fisbWith();
        nasrWx.KCLT = { metar: { raw: 'KCLT 041652Z 11005KT', decoded: METAR_DECODED }, source: 'plan' };
        await newPopup().show(KCLT);
        expect(tafText()).toBeNull();
        await fisb._handleWeather(stratuxMsg(FISB_OLDER));
        expect(tafText()).toContain('KCLT 041120Z');
        expect(wxPane().querySelector('.popup-wx-section .wx-taf')).not.toBeNull();
        await fisb._handleWeather(stratuxMsg(FISB_NEWER));
        expect(tafText()).toContain('TAF AMD KCLT 041650Z');
        expect(wxPane().querySelectorAll('.wx-taf')).toHaveLength(1);
        expect(metarText()).toContain('KCLT 041652Z');
    });

    it('with no METAR section ("No weather data"): a TAF section is created', async () => {
        fisb = await fisbWith();
        await newPopup().show(KCLT);
        expect(wxPane().textContent).toContain('No weather data');
        await fisb._handleWeather(stratuxMsg(FISB_OLDER));
        expect(tafText()).toContain('KCLT 041120Z');
        expect(wxPane().textContent).not.toContain('No weather data');
    });

    it('an older FIS-B TAF does not replace a newer internet one; another airport\'s TAF is ignored', async () => {
        fisb = await fisbWith();
        globalThis.fetch = okReply(AWC_REPLY);
        await newPopup().show(KCLT);
        await settle();
        expect(tafText()).toBe(AWC_RAW);
        await fisb._handleWeather(stratuxMsg(FISB_OLDER));
        expect(tafText()).toBe(AWC_RAW);
        await fisb._handleWeather(stratuxMsg('TAF KGSO 041700Z 0418/0518 20008KT P6SM SKC'));
        expect(tafText()).toBe(AWC_RAW);
    });

    it('a new FIS-B METAR redraws the WX tab and keeps the TAF', async () => {
        fisb = await fisbWith(FISB_OLDER);
        await newPopup().show(KCLT);
        await fisb._handleWeather({ Type: 'METAR', Location: 'KCLT', Time: '041656Z', Data: '12006KT 10SM BKN014 17/14 A3011' });
        expect(metarText()).toContain('KCLT 041656Z');
        expect(tafText()).toContain('KCLT 041120Z');
    });

    it('FIS-B TAF text stays escaped', async () => {
        fisb = await fisbWith();
        await newPopup().show(KCLT);
        await fisb._handleWeather({ Type: 'TAF', Location: 'KCLT', Time: '041700Z', Data: '0418/0518 <img src=x onerror=alert(1)> FM042200 X' });
        expect(wxPane().querySelector('img')).toBeNull();
        expect(tafText()).toContain('<img src=x onerror=alert(1)>');
    });
});
