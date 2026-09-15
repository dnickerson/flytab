/**
 * FlyTab — Geometry utilities shared across map/planning features.
 * Classic script (not an ES module) — attaches to window.GeoUtils.
 */
const GeoUtils = {
    /**
     * Ray-casting point-in-polygon test.
     * boundary is [[lat, lon], ...] or [{lat, lon}, ...]
     */
    pointInPolygon(lat, lon, boundary) {
        let inside = false;
        const n = boundary.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const pi = boundary[i], pj = boundary[j];
            const yi = Array.isArray(pi) ? pi[0] : pi.lat;
            const xi = Array.isArray(pi) ? pi[1] : pi.lon;
            const yj = Array.isArray(pj) ? pj[0] : pj.lat;
            const xj = Array.isArray(pj) ? pj[1] : pj.lon;
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    },

    /**
     * Does the line segment from (lat1,lon1) to (lat2,lon2) pass through
     * boundary at any point? Samples nSamples interior points plus both
     * endpoints, since a straight-line polygon-edge intersection test is
     * unnecessary complexity for airspace-shelf-sized polygons at typical
     * aircraft speeds — sampling is sufficient and much simpler.
     */
    segmentIntersectsPolygon(lat1, lon1, lat2, lon2, boundary, nSamples = 8) {
        for (let k = 0; k <= nSamples; k++) {
            const t = k / nSamples;
            const lat = lat1 + t * (lat2 - lat1);
            const lon = lon1 + t * (lon2 - lon1);
            if (GeoUtils.pointInPolygon(lat, lon, boundary)) return true;
        }
        return false;
    },
};
