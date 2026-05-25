/**
 * FlyTab — Convective Intelligence Engine
 * Scores NEXRAD returns for convective potential, computes hazard boundaries,
 * evaluates route alerts, monitors OAT trends, detects wind convergence.
 *
 * EXPERIMENTAL — NOT FOR NAVIGATION.
 * Decision-support only. Does not replace ATC advisories or pilot judgment.
 */

// ========== Math Utilities ==========

function fitLinearSlope(values) {
    const n = values.length;
    if (n < 2) return 0;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (i - xMean) * (values[i] - yMean);
        den += (i - xMean) ** 2;
    }
    return den === 0 ? 0 : num / den;
}

/** Returns fractional growth rate per step (e.g. 0.5 = 50% growth per frame) */
function fitExponentialSlope(values) {
    const logVals = values.map(v => Math.log(Math.max(v, 0.001)));
    return Math.exp(fitLinearSlope(logVals)) - 1;
}

function computeVariance(values) {
    const n = values.length;
    if (n < 2) return 0;
    const mean = values.reduce((s, v) => s + v, 0) / n;
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
}

/**
 * Perimeter-fraction irregularity of a cluster.
 * Smooth circle ≈ 0.0, highly irregular cauliflower ≈ 1.0
 * @param {{ cells: Array<{gLat,gLon}> }} cluster
 */
function computeEdgeIrregularity(cluster) {
    const total = cluster.cells.length;
    if (total < 2) return 0;
    const cellSet = new Set(cluster.cells.map(c => `${c.gLat},${c.gLon}`));
    let perimCount = 0;
    for (const cell of cluster.cells) {
        const isEdge = [
            `${cell.gLat+1},${cell.gLon}`, `${cell.gLat-1},${cell.gLon}`,
            `${cell.gLat},${cell.gLon+1}`, `${cell.gLat},${cell.gLon-1}`,
        ].some(k => !cellSet.has(k));
        if (isEdge) perimCount++;
    }
    // A circle of 10 cells has ~30% perimeter fraction. Map [0.3, 1.0] → [0, 1].
    return Math.min(Math.max((perimCount / total - 0.3) / 0.7, 0), 1);
}

/**
 * Solar heating multiplier by local (device) clock hour.
 * Returns 0.2 (night) to 1.0 (peak 15:00–17:00 local).
 */
function computeSolarHeatingMultiplier(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h < 9 || h > 22) return 0.2;
    if (h < 12) return 0.3 + ((h - 9) / 3) * 0.4;
    if (h < 15) return 0.7 + ((h - 12) / 3) * 0.3;
    if (h < 17) return 1.0;
    if (h < 20) return 1.0 - ((h - 17) / 3) * 0.5;
    return 0.3;
}

// ========== Score Normalization Helpers ==========

function _normAreaGrowth(rate) {
    if (rate <= 0.05) return 0;
    if (rate >= 0.50) return 1;
    return (rate - 0.05) / 0.45;
}

function _normDbzGrowth(rate) {
    if (rate <= 2) return 0;
    if (rate >= 8) return 1;
    return (rate - 2) / 6;
}

function _normMotionRatio(ratio) {
    return Math.min(Math.max(ratio / 5, 0), 1);
}

// ========== Instability Scoring (preflight HRRR grid) ==========

/**
 * Compute 0–1 instability score for a single HRRR grid cell.
 * Tuned for SE US airmass convection: lat 25–37, May–September.
 */
function computeCellInstabilityScore({ cape, cin, lcl, lfc, shear03, dewpoint, timeOfDay }) {
    let score = 0;

    // CAPE
    if      (cape < 200)  score += 0.00;
    else if (cape < 500)  score += 0.10;
    else if (cape < 1000) score += 0.20;
    else if (cape < 1500) score += 0.35;
    else if (cape < 2500) score += 0.50;
    else                  score += 0.65;

    // CIN (pass positive absolute value)
    if      (cin < 10)  score += 0.20;
    else if (cin < 25)  score += 0.15;
    else if (cin < 50)  score += 0.10;
    else if (cin < 100) score += 0.02;

    // Solar heating multiplier
    const mult = computeSolarHeatingMultiplier(timeOfDay instanceof Date ? timeOfDay : new Date());
    score *= mult;

    // Dewpoint (°F)
    if (dewpoint > 70) score += 0.10;
    else if (dewpoint > 65) score += 0.05;

    // Low-level shear (knots)
    if (shear03 > 30) score += 0.05;

    return Math.min(score, 1.0);
}

/**
 * Convert raw AWC griddata API response to an array of instability grid cells.
 * AWC griddata returns GeoJSON FeatureCollection or flat array — inspect response before calling.
 * @param {object} hrrrData - parsed JSON from AWC /api/data/griddata
 * @returns {Array<{lat,lon,instabilityScore,cape,cin,validTime}>}
 */
function computeInstabilityGrid(hrrrData) {
    const points = hrrrData.features ?? hrrrData.data ?? hrrrData ?? [];
    const now = new Date();
    return points.map(item => {
        const props = item.properties ?? item;
        const lat = item.geometry?.coordinates?.[1] ?? props.lat ?? 0;
        const lon = item.geometry?.coordinates?.[0] ?? props.lon ?? 0;
        return {
            lat, lon,
            instabilityScore: computeCellInstabilityScore({
                cape:     props.cape     ?? 0,
                cin:      Math.abs(props.cin ?? 0),
                lcl:      props.lcl      ?? 9999,
                lfc:      props.lfc      ?? 9999,
                shear03:  props.shear03  ?? 0,
                dewpoint: props.dwpf     ?? 50,
                timeOfDay: now,
            }),
            cape:      props.cape  ?? 0,
            cin:       props.cin   ?? 0,
            validTime: props.validTime ?? now.toISOString(),
        };
    });
}

/** Find cell in grid nearest to lat/lon */
function lookupNearestCell(grid, lat, lon) {
    let best = null, bestD = Infinity;
    for (const cell of grid) {
        const d = (cell.lat - lat) ** 2 + (cell.lon - lon) ** 2;
        if (d < bestD) { bestD = d; best = cell; }
    }
    return best;
}
