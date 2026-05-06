// @ts-check
'use strict';

/**
 * @typedef {import('../types/airspace.js').Airspace} Airspace
 *
 * @typedef AvoidanceConstraint
 * @property {string}                              id
 * @property {Array<{lat:number,lon:number}>}     polygon
 * @property {number}                             [floorFt]
 * @property {number}                             [ceilingFt]
 *
 * @typedef PenaltyOpts
 * @property {boolean} [hardBlock=true]
 * @property {number}  [softCostNm=200]
 */

/**
 * Standard ray-cast point-in-polygon.
 * @param {number} lat
 * @param {number} lon
 * @param {Array<{lat:number,lon:number}>} poly
 * @returns {boolean}
 */
function pointInPolygon(lat, lon, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].lon, yi = poly[i].lat;
        const xj = poly[j].lon, yj = poly[j].lat;
        if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Check whether two 2D segments intersect (lon-lat, ignoring earth curvature for short legs).
 * @param {{lat:number,lon:number}} a1
 * @param {{lat:number,lon:number}} a2
 * @param {{lat:number,lon:number}} b1
 * @param {{lat:number,lon:number}} b2
 * @returns {boolean}
 */
function segmentsIntersect(a1, a2, b1, b2) {
    const d  = (a2.lon - a1.lon) * (b2.lat - b1.lat) - (a2.lat - a1.lat) * (b2.lon - b1.lon);
    if (d === 0) return false;
    const t  = ((b1.lon - a1.lon) * (b2.lat - b1.lat) - (b1.lat - a1.lat) * (b2.lon - b1.lon)) / d;
    const u  = ((b1.lon - a1.lon) * (a2.lat - a1.lat) - (b1.lat - a1.lat) * (a2.lon - a1.lon)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/**
 * True if any segment endpoint is inside or any segment side crosses the polygon perimeter.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @param {Array<{lat:number,lon:number}>} poly
 * @returns {boolean}
 */
export function segmentIntersectsPolygon(lat1, lon1, lat2, lon2, poly) {
    if (pointInPolygon(lat1, lon1, poly) || pointInPolygon(lat2, lon2, poly)) return true;
    const a1 = { lat: lat1, lon: lon1 }, a2 = { lat: lat2, lon: lon2 };
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        if (segmentsIntersect(a1, a2, poly[j], poly[i])) return true;
    }
    return false;
}

/**
 * Returns a penalty function suitable for A*'s edge-cost addend. Edge cost
 * = base distance + penalty(edge). A hard-block returns Infinity.
 *
 * @param {AvoidanceConstraint[]} constraints
 * @param {PenaltyOpts}           [opts]
 */
export function buildAvoidancePenalty(constraints, opts = {}) {
    const hardBlock = opts.hardBlock ?? true;
    const softCost  = opts.softCostNm ?? 200;
    if (!constraints.length) return () => 0;
    /**
     * @param {{from: {lat:number,lon:number}, to: {lat:number,lon:number}}} edge
     * @returns {number}
     */
    return ({ from, to }) => {
        for (const c of constraints) {
            if (segmentIntersectsPolygon(from.lat, from.lon, to.lat, to.lon, c.polygon)) {
                return hardBlock ? Infinity : softCost;
            }
        }
        return 0;
    };
}
