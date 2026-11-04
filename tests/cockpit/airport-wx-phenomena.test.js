/**
 * WX tab present-weather chips (AirportPopup._weatherHtml): the intensity / proximity is part of the
 * chip - "−RA" (light, U+2212 for legibility), "+RA" (heavy), "VCSH" (in the vicinity) - read from the
 * METAR body (before RMK and any trend group: NOSIG / TEMPO / BECMG).
 *
 * Source of truth = the raw METAR. Decoders checked 2026-11-04: FisbClient.decodeMetar (FIS-B, and the
 * internet METARs in vector-map-layers.js) has NO present-weather field; WeatherClient (AWC JSON) keeps
 * AWC's wxString as decoded.weather, and AWC's wxString can include remark/trend text (MNMG below:
 * wxString "VCRA RA" for a body with only VCRA). The METARs here are real, from
 * https://aviationweather.gov/api/data/metar?bbox=...&format=json fetched 2026-11-04 ~22:55Z.
 * Before v12.65 the chip lost its sign ("-RA" showed "RA": \b cannot match before "-") and VCSH /
 * VCTS / TS showed nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const AirportPopup = new Function(readFileSync('web/cockpit/airport-popup.js', 'utf8') + '\nreturn AirportPopup;')();

const chips = (raw) => {
    const p = new AirportPopup({}, {});
    const d = document.createElement('div');
    d.innerHTML = p._weatherHtml({ metar: { raw, decoded: { flight_category: 'VFR' } }, source: 'internet' });
    return [...d.querySelectorAll('.wx-phenom')].map((e) => ({ text: e.textContent, cls: [...e.classList].filter((c) => c.startsWith('apt-wx-ph')).join(' ') }));
};
const texts = (raw) => chips(raw).map((c) => c.text);

beforeEach(() => { delete globalThis.FisbClient; });

describe('present weather with intensity / proximity (real METARs)', () => {
    it('KSUX light rain + mist: "−RA", "BR"', () => {
        expect(texts('METAR KSUX 042252Z 32013KT 4SM -RA BR SCT010 BKN014 OVC030 08/07 A2972 RMK AO2 RAE33B44 SLP069 P0001 T00780067'))
            .toEqual(['−RA', 'BR']);
    });
    it('KPIT light rain alone: "−RA" (remarks RAB.. not read)', () => {
        expect(texts('METAR KPIT 042251Z 21005KT 10SM -RA SCT048 OVC055 17/14 A2991 RMK AO2 SLP134 P0002 T01670144')).toEqual(['−RA']);
    });
    it('KAVL heavy rain: "+RA" in the caution colour, "BR"', () => {
        const c = chips('SPECI KAVL 042240Z 13003KT 4SM +RA BR FEW008 BKN014 OVC028 17/16 A2999 RMK AO2 P0012 T01720161');
        expect(c).toEqual([{ text: '+RA', cls: 'apt-wx-ph-sev' }, { text: 'BR', cls: 'apt-wx-ph' }]);
    });
    it('TAPA showers in the vicinity: "VCSH" (no precipitation code: shown since v12.65)', () => {
        expect(texts('METAR TAPA 042200Z 20004KT 140V260 9999 VCSH SCT018 28/25 Q1010 NOSIG')).toEqual(['VCSH']);
    });
    it('RPVK "VCSH" in the body; the remark CB/VCSH is not a second chip', () => {
        expect(texts('METAR RPVK 042200Z 24003KT 220V360 9999 VCSH FEW013CB SCT016 BKN070 26/24 Q1013 RMK A2991 CB/VCSH S,SE')).toEqual(['VCSH']);
    });
    it('MNMG "VCRA" only: the trend text after NOSIG (RA/W/NW) is not read (AWC wxString says "VCRA RA")', () => {
        expect(texts('METAR MNMG 042200Z 29004KT 8000 VCRA FEW020CB SCT070 30/26 Q1007 A2974 CB 4/C RA/W/NW NOSIG')).toEqual(['VCRA']);
    });
    it('thunderstorms: "+TSRA" / "VCTS" / "TS" in the danger colour; "-FZDZ" freezing colour with "−"', () => {
        expect(chips('METAR KXXX 042253Z 24015G25KT 2SM +TSRA BKN015CB 22/20 A2990')).toEqual([{ text: '+TSRA', cls: 'apt-wx-ph-ts' }]);
        expect(chips('METAR KXXX 042253Z 24015KT 10SM VCTS SCT040CB 22/20 A2990')).toEqual([{ text: 'VCTS', cls: 'apt-wx-ph-ts' }]);
        expect(chips('METAR KXXX 042253Z 24015KT 10SM TS SCT040CB 22/20 A2990')).toEqual([{ text: 'TS', cls: 'apt-wx-ph-ts' }]);
        expect(chips('METAR KXXX 042253Z 36005KT 3SM -FZDZ OVC008 M01/M02 A3010')).toEqual([{ text: '−FZDZ', cls: 'apt-wx-ph-fz' }]);
    });
    it('nothing that is not present weather: station, time, AUTO, wind, sky, CAVOK, remarks', () => {
        expect(texts('METAR KDDC 042252Z AUTO 24004KT 10SM CLR 18/04 A2987 RMK AO2 SLP107 T01780044')).toEqual([]);
        expect(texts('METAR LFPG 042230Z 24008KT CAVOK 12/08 Q1015 NOSIG')).toEqual([]);
        expect(texts('METAR KDDC 042252Z AUTO 24004KT 5SM HZ CLR 18/04 A2987 RMK AO2')).toEqual(['HZ']);
    });
    it('chip text is escaped and comes from a whitelist grammar (no markup from the raw text)', () => {
        const p = new AirportPopup({}, {});
        const d = document.createElement('div');
        d.innerHTML = p._weatherHtml({ metar: { raw: 'KXXX 042252Z 24004KT 5SM -RA<img src=x> CLR', decoded: {} }, source: 'fisb' });
        expect(d.querySelector('img')).toBeNull();
        expect([...d.querySelectorAll('.wx-phenom')].map((e) => e.textContent)).toEqual([]);
    });
});
