/**
 * FlyTab — Convective Display Layer
 * Renders probabilistic hazard rings, classification badges, and beam height
 * annotations on the Leaflet map for convective intelligence analysis results.
 *
 * EXPERIMENTAL — NOT FOR NAVIGATION.
 */

class ConvectiveDisplay {
    /**
     * @param {L.Map} map
     */
    constructor(map) {
        this._map    = map;
        this._rings  = [];
        this._badges = [];
        this._beamAnnotations = [];
        this._active = false;
        this._ageMs  = null;
    }

    setActive(on) {
        this._active = on;
        if (!on) this._clear();
    }

    setAgeMs(ageMs) { this._ageMs = ageMs; }

    /**
     * Re-render all convective returns on the map.
     * @param {Array<{cluster, analysis}>} results  from NexradSectorAnalyzer.analyze()
     * @param {{ lat, lon }|null} aircraft
     */
    update(results, aircraft) {
        this._clear();
        if (!this._active || !this._map) return;

        const ageMinutes = this._ageMs != null ? this._ageMs / 60000 : 0;

        for (const { cluster, analysis } of results) {
            if (analysis.score === null) continue;

            const category = getConvectiveCategory(analysis.score);
            if (category === 'STRATIFORM') continue;

            const [lat, lon] = cluster.centroid;
            const boundary = computeHazardBoundary(cluster, analysis.score, ageMinutes, null);

            this._renderRings(lat, lon, boundary, category);
            this._renderBadge(lat, lon, category, analysis.score);

            if (aircraft) {
                const site = findNearestNexradSite({ lat, lon });
                const { warning } = getBeamHeightWarning({ lat, lon }, aircraft, site);
                if (warning) this._renderBeamAnnotation(lat, lon, warning);
            }
        }
    }

    _renderRings(lat, lon, boundary, category) {
        const COLOR = {
            AMBIGUOUS:   '#FFAA00',
            LIKELY_CONV: '#FF6600',
            CONFIRMED:   '#FF0000',
        };
        const color = COLOR[category] || '#FFAA00';
        const isDashed = category !== 'CONFIRMED';

        for (const ring of boundary.rings) {
            const circle = L.circle([lat, lon], {
                radius:      ring.radiusNm * 1852,
                color,
                weight:      1.5,
                fillColor:   color,
                fillOpacity: ring.probability * 0.07,
                dashArray:   isDashed ? '6,4' : null,
                interactive: false,
            }).addTo(this._map);
            this._rings.push(circle);
        }
    }

    _renderBadge(lat, lon, category, score) {
        const BADGE = { AMBIGUOUS: '?CONV', LIKELY_CONV: 'CONV', CONFIRMED: '⚠CONV' };
        const COLOR = { AMBIGUOUS: '#FFAA00', LIKELY_CONV: '#FF6600', CONFIRMED: '#FF0000' };
        const text  = BADGE[category] || '?CONV';
        const color = COLOR[category] || '#FFAA00';

        const badge = L.marker([lat, lon], {
            icon: L.divIcon({
                className:  'conv-badge',
                html:       `<div class="conv-badge-text" style="color:${color};background:rgba(0,0,0,0.55);padding:1px 4px;border-radius:3px;font-size:11px;font-weight:700;white-space:nowrap">${text}</div>`,
                iconSize:   [0, 0],
                iconAnchor: [-2, 8],
            }),
            interactive: false,
        }).addTo(this._map);
        this._badges.push(badge);
    }

    _renderBeamAnnotation(lat, lon, warning) {
        const annot = L.marker([lat + 0.15, lon], {
            icon: L.divIcon({
                className: 'beam-ht-annotation',
                html: `<div style="color:#FF9900;background:rgba(0,0,0,0.55);padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600;white-space:nowrap">⚡ ${warning}</div>`,
                iconSize: [0, 0],
            }),
            interactive: false,
        }).addTo(this._map);
        this._beamAnnotations.push(annot);
    }

    _clear() {
        for (const r of this._rings)            { if (this._map) this._map.removeLayer(r); }
        for (const b of this._badges)           { if (this._map) this._map.removeLayer(b); }
        for (const a of this._beamAnnotations)  { if (this._map) this._map.removeLayer(a); }
        this._rings = []; this._badges = []; this._beamAnnotations = [];
    }
}
