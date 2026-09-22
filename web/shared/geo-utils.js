/**
 * FlyTab — Geometry utilities shared across map/planning features.
 * Classic script (not an ES module) — declared as a top-level `const`, so it
 * is available as a global identifier (`GeoUtils`) to any other classic
 * script loaded after it, the same way other shared modules are consumed
 * in this repo. This does NOT attach a `GeoUtils` property to `window`
 * (only `var`/bare assignment does that at the top level of a script).
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

    /**
     * Does this polygon overlap an axis-aligned lat/lon box at all?
     * Three cases, in order of cost: (1) a polygon vertex falls inside the
     * box: (2) the box's own center falls inside the polygon -- catches a
     * polygon much larger than the box, fully containing it; (3) neither of
     * those, but a polygon edge still clips through the box (e.g. a large
     * polygon's edge crosses a corner or side of the box without any vertex
     * of either shape landing inside the other) -- checked by sampling the
     * box's own 4 edges against the polygon via segmentIntersectsPolygon,
     * since by the Jordan curve theorem any nonzero-area overlap between
     * the box and polygon interiors must cross the box's perimeter too.
     */
    polygonOverlapsBox(boundary, south, west, north, east) {
        if (!boundary || boundary.length < 3) return false;
        const vertexInBounds = boundary.some(pt => {
            const lat = Array.isArray(pt) ? pt[0] : pt.lat;
            const lon = Array.isArray(pt) ? pt[1] : pt.lon;
            return lat >= south && lat <= north && lon >= west && lon <= east;
        });
        if (vertexInBounds) return true;
        const centerInPolygon = GeoUtils.pointInPolygon((south + north) / 2, (west + east) / 2, boundary);
        if (centerInPolygon) return true;
        return GeoUtils.segmentIntersectsPolygon(south, west, south, east, boundary)
            || GeoUtils.segmentIntersectsPolygon(south, east, north, east, boundary)
            || GeoUtils.segmentIntersectsPolygon(north, east, north, west, boundary)
            || GeoUtils.segmentIntersectsPolygon(north, west, south, west, boundary);
    },
};
