/**
 * Tapping the map shows the airspace there (Dana, 2026-10-18): "touching an
 * area of the class B does not show a popup with the altitudes" (it had no
 * popup at all), while a MOA did (a Leaflet bindPopup). Where they overlap
 * (a MOA under a Class B shelf) the two would race, so there is one popup on
 * the tap path listing every area at the spot, lowest floor first (Dana's
 * choice): Class B/C/D, Restricted/MOA with NOTAM status, TRSA with frequency.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
new Function(read('web/lib/leaflet/leaflet.js')).call(globalThis);
globalThis.GeoUtils = new Function(read('web/shared/geo-utils.js') + '\nreturn GeoUtils;')();
globalThis.CockpitConfig = { get: () => ({}) };
const VectorMapLayers = new Function(read('web/cockpit/vector-map-layers.js') + '\nreturn VectorMapLayers;')();

const box = (la, lo, d) => [[la - d, lo - d], [la - d, lo + d], [la + d, lo + d], [la + d, lo - d]];
// Real NASR shapes (bundle 2026-10): names "Charlotte Class B", floors/ceilings in feet MSL.
const SPACES = [
    { id: 'CLT-B-SFC', name: 'Charlotte Class B', class: 'B', lower_ft: 0, upper_ft: 10000, boundary: box(35.21, -80.94, 0.08) },
    { id: 'CLT-B-60', name: 'Charlotte Class B', class: 'B', lower_ft: 6000, upper_ft: 10000, boundary: box(35.21, -80.94, 0.5) },
    { id: 'X-E5', name: 'Monroe Class E5', class: 'E5', lower_ft: 700, upper_ft: -9998, boundary: box(35.0, -80.6, 0.6) },
];
const SUAS = [{ id: 'BULL', name: 'BULLDOG A MOA', type: 'MOA', lower_ft: 500, upper_ft: 10000, boundary: box(35.4, -81.2, 0.2) }];
const TRSAS = [{ id: 'MYR', name: 'Myrtle Beach TRSA', freqs: [{ freq: '119.85', sector: '180-359' }, { freq: '127.1', sector: '360-179' }],
                 lower_ft: 0, upper_ft: 4000, approximate: true, radius_nm: 20, boundary: box(33.68, -78.93, 0.3) }];

async function layers() {
    // jsdom cannot render Leaflet's SVG: layers stay off a real map; this map
    // says which layer groups are shown (as the layer panel toggles them).
    const shown = new Set();
    const map = { hasLayer: (l) => shown.has(l), removeLayer: (l) => shown.delete(l), latLngToContainerPoint: () => L.point(0, 0) };
    const v = Object.create(VectorMapLayers.prototype);
    v._map = map;
    v._airspaceLayer = L.layerGroup(); v._airspacePolygons = new Map();
    v._suaLayer = L.layerGroup(); v._suaPolygons = new Map();
    v._trsaLayer = L.layerGroup(); v._trsaPolygons = new Map();
    [v._airspaceLayer, v._suaLayer, v._trsaLayer].forEach((l) => shown.add(l));
    v._nasr = { getAirspaceInBounds: async () => SPACES.map((a) => ({ ...a })), getSuaInBounds: async () => SUAS.map((a) => ({ ...a })),
                getTrsaInBounds: async () => TRSAS.map((a) => ({ ...a })) };
    await v._updateAirspace(32, -82, 37, -77, 9, {}); await v._updateSua(32, -82, 37, -77, 9); await v._updateTrsa(32, -82, 37, -77, 9);
    return v;
}
const names = (areas) => areas.map((a) => a.rec.id);
// The text a pilot reads: each leaf element's text, space-separated.
const words = (el) => { const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = []; while (w.nextNode()) { const t = w.currentNode.textContent.trim(); if (t) out.push(t); } return out.join(' '); };

describe('the airspace at a tap', () => {
    beforeEach(() => { document.body.innerHTML = ''; delete window.SuaNotams; });

    it('inside the Class B surface area: listed, lowest floor first', async () => {
        const v = await layers();
        expect(names(v._areasAt(35.21, -80.94))).toEqual(['CLT-B-SFC', 'CLT-B-60']);   // test rings overlap; lowest floor first
    });

    it('a MOA under the Class B shelf: both, lowest floor first', async () => {
        const v = await layers();
        expect(names(v._areasAt(35.4, -81.2))).toEqual(['BULL', 'CLT-B-60']);
    });

    it('Class E is drawn but not listed; outside everything: nothing', async () => {
        const v = await layers();
        expect(names(v._areasAt(34.6, -80.2))).toEqual([]);              // only the E5
        expect(v._showAirspacePopup(L.latLng(34.6, -80.2))).toBe(false);
    });

    it('a layer switched off is not listed', async () => {
        const v = await layers();
        v._map.removeLayer(v._suaLayer);
        expect(names(v._areasAt(35.4, -81.2))).toEqual(['CLT-B-60']);
    });

    it('the popup: names, kinds and altitudes; MOA NOTAM status; TRSA frequencies and sectors', async () => {
        const v = await layers();
        window.SuaNotams = { getNotam: (s) => (s.id === 'BULL' ? { text: 'BULLDOG A MOA ACT 0500-10000' } : null), hasActiveNotam: () => true };
        const el = document.createElement('div');
        el.innerHTML = v._airspacePopupHtml(v._areasAt(35.4, -81.2));
        const rows = [...el.querySelectorAll('.as-pop-row')].map(words);
        expect(rows[0]).toMatch(/^BULLDOG A MOA MOA 10,000 ft – 500 ft ⚠ ACTIVE per NOTAM BULLDOG A MOA ACT/);
        expect(rows[1]).toBe('Charlotte CLASS B 10,000 ft – 6,000 ft');
        el.innerHTML = v._airspacePopupHtml(v._areasAt(33.68, -78.93));
        expect(words(el)).toMatch(/Myrtle Beach TRSA TRSA 119\.85 \(180-359\) \/ 127\.1 \(360-179\) 4,000 ft – SFC Approximate boundary — 20 nm radius/);
        expect(VectorMapLayers._fmtAltFt(-9998)).toBe('UNL');
        expect(VectorMapLayers._fmtAltFt(0, true)).toBe('SFC');
    });

    it('text from NASR and NOTAMs cannot add HTML', async () => {
        const v = await layers();
        window.SuaNotams = { getNotam: () => ({ text: '<img src=x onerror=alert(1)>' }) };
        const evil = [{ kind: 'sua', rec: { id: 'x', name: '<b>x</b>', type: '<i>R</i>', lower_ft: 0, upper_ft: 100 } },
                      { kind: 'class', rec: { id: 'y', name: '<script>', class: 'B', lower_ft: 0, upper_ft: 100 } }];
        const el = document.createElement('div'); el.innerHTML = v._airspacePopupHtml(evil);
        expect(el.querySelector('img, b, i, script')).toBeNull();
    });

    it('opens one Leaflet popup at the tap, with the tap-friendly class', async () => {
        const v = await layers();
        const calls = []; const real = L.popup;
        L.popup = (opts) => { const p = { opts, setLatLng(ll) { this.ll = ll; return this; }, setContent(h) { this.html = h; return this; }, openOn(m) { calls.push(this); this.map = m; return this; } }; return p; };
        try { expect(v._showAirspacePopup(L.latLng(35.4, -81.2))).toBe(true); } finally { L.popup = real; }
        expect(calls).toHaveLength(1);
        expect(calls[0].opts.className).toBe('as-popup-container');
        expect(calls[0].map).toBe(v._map);
        const el = document.createElement('div'); el.innerHTML = calls[0].html;
        expect(el.querySelectorAll('.as-pop-row')).toHaveLength(2);
    });

    it('the polygons no longer carry their own Leaflet popups or take clicks (they raced the tap)', async () => {
        const v = await layers();
        for (const m of [v._airspacePolygons, v._suaPolygons, v._trsaPolygons]) {
            for (const [k, p] of m) if (p._flyArea) { expect(p.options.interactive, k).toBe(false); expect(p.getPopup(), k).toBeFalsy(); }
        }
    });
});

describe('what a tap opens, in order: aviation marker, then traffic, then airspace', () => {
    const ctx = async () => { const v = await layers(); v._findNearestMarker = () => null; v._showAirspacePopup = vi.fn(() => true); return v; };
    it('nothing else hit: the airspace popup', async () => {
        const v = await ctx(); v._onTrafficTap = () => false;
        v._onMapClick({ latlng: L.latLng(35.4, -81.2) });
        expect(v._showAirspacePopup).toHaveBeenCalled();
    });
    it('a traffic target hit: traffic only', async () => {
        const v = await ctx(); v._onTrafficTap = () => true;
        v._onMapClick({ latlng: L.latLng(35.4, -81.2) });
        expect(v._showAirspacePopup).not.toHaveBeenCalled();
    });
    it('an airport hit: the airport only', async () => {
        const v = await ctx(); v._onAirportClick = vi.fn();
        v._findNearestMarker = () => ({ type: 'airport', data: { icao: 'KCLT' } });
        v._onMapClick({ latlng: L.latLng(35.21, -80.94) });
        expect(v._onAirportClick).toHaveBeenCalled();
        expect(v._showAirspacePopup).not.toHaveBeenCalled();
    });
    it('the app passes the traffic hit through (it was dropped)', () => {
        expect(read('web/app.js')).toMatch(/this\.vectorLayers\._onTrafficTap = \(containerPt\) => this\.cockpitMap\._onTrafficTap\(containerPt\);/);
    });
});

describe('full review fixes (2026-10-18)', () => {
    beforeEach(() => { document.body.innerHTML = ''; delete window.SuaNotams; delete window.app; globalThis._wireTapLastTouchAt = 0; });

    it('1. the tap popup survives the synthetic click that follows the tap (real Leaflet map, preclick)', () => {
        const div = document.createElement('div'); div.style.width = '800px'; div.style.height = '600px'; document.body.appendChild(div);
        const map = L.map(div, { center: [35.2, -80.9], zoom: 9 });
        const v = Object.create(VectorMapLayers.prototype); v._map = map;
        v._areasAt = () => [{ kind: 'class', rec: { id: 'CLT', name: 'Charlotte Class B', class: 'B', lower_ft: 0, upper_ft: 10000 } }];
        expect(v._showAirspacePopup(L.latLng(35.2, -80.9))).toBe(true);
        map.fire('preclick', { latlng: L.latLng(35.2, -80.9) });              // what Leaflet fires for the synthetic click
        expect(map.hasLayer(v._tapPopup)).toBe(true);
        expect(document.querySelector('.as-popup-container')).not.toBeNull();
        // the next real tap closes it, without opening another
        v._findNearestMarker = () => null; v._onTrafficTap = () => false;
        const spy = vi.spyOn(v, '_showAirspacePopup');
        v._onMapClick({ latlng: L.latLng(35.0, -80.0) });
        expect(document.querySelector('.as-popup-container')).toBeNull();
        expect(spy).not.toHaveBeenCalled();
        map.remove();
    });

    it('2. a tap on a UI button inside the map (auto-pan, D→) does not open the airspace popup', async () => {
        const v = await layers(); v._findNearestMarker = () => null; v._onTrafficTap = () => false;
        v._showAirspacePopup = vi.fn(() => true);
        globalThis._wireTapLastTouchAt = Date.now();
        v._onMapClick({ latlng: L.latLng(35.4, -81.2) });
        expect(v._showAirspacePopup).not.toHaveBeenCalled();
        globalThis._wireTapLastTouchAt = Date.now() - 1000;
        v._onMapClick({ latlng: L.latLng(35.4, -81.2) });
        expect(v._showAirspacePopup).toHaveBeenCalled();
    });

    it('3. NASR "unlimited" -1 (121 SUA, e.g. R-2505) is UNL, in the popup and the map label', async () => {
        expect(VectorMapLayers._fmtAltFt(-1)).toBe('UNL');
        const v = await layers();
        const el = document.createElement('div');
        el.innerHTML = v._airspacePopupHtml([{ kind: 'sua', rec: { id: 'R-2505', name: 'R-2505', type: 'R', lower_ft: 0, upper_ft: -1 } }]);
        expect(el.querySelector('.as-pop-alt').textContent).toBe('UNL – SFC');
        const sua = { id: 'R-2505', name: 'R-2505', type: 'R', lower_ft: 0, upper_ft: -1, boundary: box(34, -117, 0.2) };
        v._addSuaLabel(sua, false, []);
        expect(v._suaPolygons.get('R-2505_lbl').options.icon.options.html).toMatch(/^UNL<br>/);
    });

    it('4. while the route table is being edited, no airspace popup', async () => {
        const v = await layers(); v._findNearestMarker = () => null; v._onTrafficTap = () => false; v._showAirspacePopup = vi.fn(() => true);
        window.app = { routeTable: { isEditing: () => true } };
        v._onMapClick({ latlng: L.latLng(35.4, -81.2) });
        expect(v._showAirspacePopup).not.toHaveBeenCalled();
    });

    it('6. "Seattle-Tacoma ... Class D1" reads without the suffix', async () => {
        const v = await layers(); const el = document.createElement('div');
        el.innerHTML = v._airspacePopupHtml([{ kind: 'class', rec: { id: 'd1', name: 'Seattle-Tacoma International Airport Class D1', class: 'D', lower_ft: 0, upper_ft: 2500 } }]);
        expect(el.querySelector('.as-pop-name').textContent).toBe('Seattle-Tacoma International Airport');
    });

    it('7. a long NOTAM ends with …; no NOTAM says they are fetched on the ground', async () => {
        const v = await layers(); const el = document.createElement('div');
        window.SuaNotams = { getNotam: () => ({ text: 'X'.repeat(200) }) };
        el.innerHTML = v._airspacePopupHtml([{ kind: 'sua', rec: { id: 'm', name: 'M', type: 'MOA', lower_ft: 500, upper_ft: 10000 } }]);
        expect(el.querySelector('.as-pop-notam-text').textContent).toBe('X'.repeat(120) + '…');
        window.SuaNotams = { getNotam: () => null };
        el.innerHTML = v._airspacePopupHtml([{ kind: 'sua', rec: { id: 'm', name: 'M', type: 'MOA', lower_ft: 500, upper_ft: 10000 } }]);
        expect(el.querySelector('.as-pop-notam').textContent).toBe('No activating NOTAM found (NOTAMs are fetched on the ground)');
    });

    it('9. a TRSA map label is text, not HTML', async () => {
        const v = Object.create(VectorMapLayers.prototype);
        v._map = { hasLayer: () => true }; v._trsaLayer = L.layerGroup(); v._trsaPolygons = new Map();
        v._nasr = { getTrsaInBounds: async () => [{ id: 'T', name: 'T', freqs: [{ freq: '119.1', sector: '<img src=x>' }], boundary: box(33.7, -78.9, 0.3) }] };
        await v._updateTrsa(32, -82, 37, -77, 10);
        expect(v._trsaPolygons.get('T_lbl').options.icon.options.html).not.toMatch(/<img/);
    });
});
