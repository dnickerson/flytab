/**
 * Restricted/MOA ceiling and floor labels at low zoom (Dana, 2026-10-18):
 * "at Z8 ... the text adds clutter to the screen and is not readable. Remove
 * the text when displaying at Z8 - Z4." Labels show from the zoom badge's Z9
 * (badge = Math.round(zoom)); the polygons, colours and tap popups stay at
 * every zoom from 6. Labels used to be created once with the polygon and
 * never removed on zooming out.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
