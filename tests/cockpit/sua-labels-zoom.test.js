/**
 * Restricted/MOA ceiling and floor labels at low zoom (Dana, 2026-10-18):
 * "at Z8 ... the text adds clutter to the screen and is not readable. Remove
 * the text when displaying at Z8 - Z4." Labels show from the zoom badge's Z9
 * (badge = Math.round(zoom)); the polygons, colours and tap popups stay at
 * every zoom from 6. Labels used to be created once with the polygon and
 * never removed on zooming out.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(p, 'utf8');
new Function(read('web/lib/leaflet/leaflet.js')).call(globalThis);
globalThis.CockpitConfig = { get: () => ({}) };
const VectorMapLayers = new Function(read('web/cockpit/vector-map-layers.js') + '\nreturn VectorMapLayers;')();

const box = (la, lo, d = 0.3) => [[la - d, lo - d], [la - d, lo + d], [la + d, lo + d], [la + d, lo - d]];
const AREAS = [
    { id: 'R-5314A', name: 'R-5314A', type: 'R', lower_ft: 0, upper_ft: 18000, boundary: box(35.2, -79.2) },
    { id: 'BULL', name: 'BULLDOG A MOA', type: 'MOA', lower_ft: 500, upper_ft: 10000, boundary: box(33.4, -80.4) },
];

function layers() {
    const v = Object.create(VectorMapLayers.prototype);
    v._suaLayer = L.layerGroup();
    v._map = { hasLayer: () => true };
    v._suaPolygons = new Map();
    v._nasr = { getSuaInBounds: async () => AREAS.map((a) => ({ ...a })) };
    return v;
}
const labels = (v) => [...v._suaPolygons.keys()].filter((k) => k.endsWith('_lbl')).sort();
const polys = (v) => [...v._suaPolygons.keys()].filter((k) => !k.endsWith('_lbl')).sort();
const at = (v, z) => v._updateSua(32, -82, 37, -77, z);

describe('SUA altitude labels: none at Z8 and below', () => {
    beforeEach(() => { delete window.SuaNotams; });

    for (const z of [6, 7, 7.5, 8, 8.25]) {
        it(`zoom ${z} (badge Z${Math.round(z)}): polygons, no labels`, async () => {
            const v = layers(); await at(v, z);
            expect(polys(v)).toEqual(['BULL', 'R-5314A']);
            expect(labels(v)).toEqual([]);
            expect(v._suaLayer.getLayers()).toHaveLength(2);
        });
    }

    for (const z of [8.5, 9, 12]) {
        it(`zoom ${z} (badge Z${Math.round(z)}): polygons and their labels`, async () => {
            const v = layers(); await at(v, z);
            expect(labels(v)).toEqual(['BULL_lbl', 'R-5314A_lbl']);
            const html = v._suaPolygons.get('R-5314A_lbl').options.icon.options.html;
            expect(html).toMatch(/^180<br><span class="as-alt-floor">SFC<\/span>$/);
        });
    }

    it('zooming out from Z10 to Z8 removes the labels; back in to Z9 brings them back', async () => {
        const v = layers();
        await at(v, 10); expect(labels(v)).toHaveLength(2);
        await at(v, 8); expect(labels(v)).toEqual([]);
        expect(v._suaLayer.getLayers()).toHaveLength(2);
        await at(v, 9); expect(labels(v)).toHaveLength(2);
        expect(v._suaLayer.getLayers()).toHaveLength(4);
    });

    it('below Z6 nothing, as before', async () => {
        const v = layers(); await at(v, 10); await at(v, 5);
        expect(v._suaPolygons.size).toBe(0);
    });
});

describe('Class B/C/D altitude and TRSA frequency labels: same rule (Dana, 2026-10-18)', () => {
    const SPACES = [
        { id: 'CLT-B1', name: 'CHARLOTTE Class B', class: 'B', lower_ft: 0, upper_ft: 10000, boundary: box(35.21, -80.94, 0.1) },
        { id: 'CAE-C', name: 'COLUMBIA Class C', class: 'C', lower_ft: 0, upper_ft: 4200, boundary: box(33.94, -81.12, 0.1) },
        { id: 'X-E', name: 'E', class: 'E', lower_ft: 700, upper_ft: 18000, boundary: box(34.5, -80.5, 0.2) },
    ];
    const TRSAS = [{ id: 'MYR', name: 'MYRTLE BEACH TRSA', freqs: [{ freq: '119.85' }], boundary: box(33.68, -78.93, 0.3) }];
    function both() {
        const v = Object.create(VectorMapLayers.prototype);
        v._map = { hasLayer: () => true };
        v._airspaceLayer = L.layerGroup(); v._airspacePolygons = new Map();
        v._trsaLayer = L.layerGroup(); v._trsaPolygons = new Map();
        v._nasr = { getAirspaceInBounds: async () => SPACES.map((a) => ({ ...a })), getTrsaInBounds: async () => TRSAS.map((a) => ({ ...a })) };
        return v;
    }
    const run = async (v, z) => { await v._updateAirspace(32, -82, 37, -77, z, {}); await v._updateTrsa(32, -82, 37, -77, z); };
    const lbl = (m, suffix) => [...m.keys()].filter((k) => k.endsWith(suffix)).sort();

    it('Z8 and out: the areas, no labels', async () => {
        for (const z of [6, 7, 8, 8.25]) {
            const v = both(); await run(v, z);
            expect(lbl(v._airspacePolygons, '_alt'), `z${z}`).toEqual([]);
            expect(lbl(v._trsaPolygons, '_lbl'), `z${z}`).toEqual([]);
            expect(v._airspaceLayer.getLayers()).toHaveLength(3);
            expect(v._trsaLayer.getLayers()).toHaveLength(1);
        }
    });

    it('Z9 in: B and C altitude labels (not E), the TRSA frequency', async () => {
        const v = both(); await run(v, 9);
        expect(lbl(v._airspacePolygons, '_alt')).toEqual(['CAE-C_alt', 'CLT-B1_alt']);
        expect(v._airspacePolygons.get('CLT-B1_alt').options.icon.options.html).toBe('100<br><span class="as-alt-floor">SFC</span>');
        expect(v._trsaPolygons.get('MYR_lbl').options.icon.options.html).toBe('119.85');
    });

    it('zooming out removes them, zooming back in restores them', async () => {
        const v = both();
        await run(v, 10); expect(lbl(v._airspacePolygons, '_alt')).toHaveLength(2);
        await run(v, 8);
        expect(lbl(v._airspacePolygons, '_alt')).toEqual([]); expect(lbl(v._trsaPolygons, '_lbl')).toEqual([]);
        expect(v._airspaceLayer.getLayers()).toHaveLength(3); expect(v._trsaLayer.getLayers()).toHaveLength(1);
        await run(v, 9);
        expect(lbl(v._airspacePolygons, '_alt')).toHaveLength(2); expect(lbl(v._trsaPolygons, '_lbl')).toHaveLength(1);
        expect(v._airspaceLayer.getLayers()).toHaveLength(5);
    });
});

describe('Class B shelf label when the surface ring is off screen (review 2026-10-18)', () => {
    const SFC = { id: 'CLT-SFC', name: 'Charlotte Class B', class: 'B', lower_ft: 0, upper_ft: 10000, boundary: box(35.21, -80.94, 0.08) };
    // a shelf ring east of the airport
    const SHELF = { id: 'CLT-60', name: 'Charlotte Class B', class: 'B', lower_ft: 6000, upper_ft: 10000,
                    boundary: [[35.0, -80.70], [35.0, -80.40], [35.45, -80.40], [35.45, -80.70]] };
    function v1(sets) {
        const v = Object.create(VectorMapLayers.prototype);
        v._map = { hasLayer: () => true };
        v._airspaceLayer = L.layerGroup(); v._airspacePolygons = new Map();
        let i = 0;
        v._nasr = { getAirspaceInBounds: async () => sets[Math.min(i++, sets.length - 1)].map((a) => ({ ...a })) };
        return v;
    }
    const ll = (r) => r.boundary.map(([a, b]) => [a, b]);
    it('placed relative to the airport (surface ring), not to the shelf itself', async () => {
        const v = v1([[SFC, SHELF], [SHELF], [SHELF]]);
        await v._updateAirspace(32, -82, 37, -77, 9, {});              // airport in view: centre remembered
        await v._updateAirspace(32, -82, 37, -77, 8, {});              // zoom out: labels go
        await v._updateAirspace(35.0, -80.7, 35.45, -80.4, 12, {});    // in on the shelf only
        const pos = v._airspacePolygons.get('CLT-60_alt').getLatLng();
        const want = VectorMapLayers._shelfLabelPosition(ll(SHELF), VectorMapLayers._polygonCentroid(ll(SFC)));
        expect([pos.lat, pos.lng]).toEqual([want[0], want[1]]);
        const wrong = VectorMapLayers._shelfLabelPosition(ll(SHELF), VectorMapLayers._polygonCentroid(ll(SHELF)));
        expect([pos.lat, pos.lng]).not.toEqual([wrong[0], wrong[1]]);
    });
});

describe('NOTAM activation on the map (2026-10-19)', () => {
    beforeEach(() => { delete window.SuaNotams; });

    it('an area turning active: filled, and its label rebuilt with the ACT badge (kept after a hide/show)', async () => {
        let active = false;
        window.SuaNotams = { refresh: vi.fn(async () => {}), hasActiveNotam: (s) => active && s.id === 'BULL' };
        const v = layers(); await at(v, 10);
        expect(v._suaPolygons.get('BULL_lbl').options.icon.options.html).not.toMatch(/sua-act-badge/);
        active = true; await at(v, 10);
        expect(v._suaPolygons.get('BULL')._suaActive).toBe(true);
        expect(v._suaPolygons.get('BULL').options.fillOpacity).toBe(VectorMapLayers.SUA_ACTIVE_OVERRIDES.fillOpacity);
        expect(v._suaPolygons.get('BULL_lbl').options.icon.options.html).toMatch(/sua-act-badge">ACT</);   // in the icon, not only the DOM
        active = false; await at(v, 10);
        expect(v._suaPolygons.get('BULL_lbl').options.icon.options.html).not.toMatch(/sua-act-badge/);
    });

    it('asks for the ARTCCs of the view, of the areas in it (they reach past it) and of the route', async () => {
        const refresh = vi.fn(async () => {});
        window.SuaNotams = { refresh, hasActiveNotam: () => false };
        globalThis.ActiveRoute = { getWaypoints: () => [{ lat: 34.72, lon: -80.85 }, { lat: 28.5, lon: -81.3 }] };
        try {
            const v = layers(); await v._updateSua(33.3, -80.5, 33.5, -80.3, 10);   // a view inside BULLDOG A
            const [, boxes] = refresh.mock.calls[0];
            expect(boxes[0]).toEqual({ south: 33.3, west: -80.5, north: 33.5, east: -80.3 });
            expect(boxes).toContainEqual({ south: 33.1, west: -80.7, north: 35.5, east: -78.9 });   // both areas' corners
            expect(boxes).toContainEqual({ south: 28.5, west: -81.3, north: 34.72, east: -80.85 });
        } finally { delete globalThis.ActiveRoute; }
    });
});
