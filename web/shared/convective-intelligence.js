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

// ========== Convective Discrimination Thresholds ==========

const CONVECTIVE_THRESHOLDS = {
    STRATIFORM:  { min: 0.00, max: 0.30, color: '#4488CC', label: 'Stratiform precipitation' },
    AMBIGUOUS:   { min: 0.30, max: 0.60, color: '#FFAA00', label: 'Possible convective — monitor' },
    LIKELY_CONV: { min: 0.60, max: 0.80, color: '#FF6600', label: 'Likely convective — deviate' },
    CONFIRMED:   { min: 0.80, max: 1.00, color: '#FF0000', label: 'Convective — immediate deviation' },
};

function getConvectiveCategory(score) {
    if (score >= 0.80) return 'CONFIRMED';
    if (score >= 0.60) return 'LIKELY_CONV';
    if (score >= 0.30) return 'AMBIGUOUS';
    return 'STRATIFORM';
}

// ========== NexradSectorAnalyzer ==========

/**
 * Wraps FisbNexrad frame history to perform multi-frame convective scoring.
 * Call analyze() after each new NEXRAD frame; result is an array of
 * { cluster, analysis } for all current clusters.
 */
class NexradSectorAnalyzer {
    /**
     * @param {FisbNexrad} fisbNexrad
     * @param {HRRRPreflightStore} preflightStore
     */
    constructor(fisbNexrad, preflightStore) {
        this._nexrad    = fisbNexrad;
        this._preflight = preflightStore;
    }

    /**
     * Run analysis against current frame history.
     * @returns {Array<{ cluster, analysis }>}
     */
    analyze() {
        const frames = this._nexrad.frameHistory;
        if (frames.length < 2) return [];

        const frameClusters = frames.map((_, i) => this._nexrad.clustersForFrame(i));
        const currentClusters = frameClusters[frameClusters.length - 1];

        return currentClusters.map(cluster => ({
            cluster,
            analysis: this._analyzeCluster(cluster, frameClusters),
        }));
    }

    _analyzeCluster(current, frameClusters) {
        const MATCH_DEG = 1.5;  // ~90nm max centroid drift between frames

        const matched = frameClusters.map(clusters => {
            let best = null, bestD = MATCH_DEG;
            for (const c of clusters) {
                const d = Math.sqrt(
                    (current.centroid[0] - c.centroid[0]) ** 2 +
                    (current.centroid[1] - c.centroid[1]) ** 2
                );
                if (d < bestD) { bestD = d; best = c; }
            }
            return best;
        }).filter(Boolean);

        if (matched.length < 3) {
            return { score: null, confidence: 'insufficient_data', signals: { framesAnalyzed: matched.length } };
        }

        const areas      = matched.map(c => c.cells.length);
        const peakDbzs   = matched.map(c => c.maxIntensity);
        const centroids  = matched.map(c => c.centroid);

        const areaGrowthRate   = fitExponentialSlope(areas);
        const dbzGrowthRate    = fitLinearSlope(peakDbzs);
        const edgeIrregularity = computeEdgeIrregularity(current);

        const first = centroids[0], last = centroids[centroids.length - 1];
        const motionDeg = Math.sqrt(
            (last[0] - first[0]) ** 2 + (last[1] - first[1]) ** 2
        ) / matched.length;
        const areaVsMotionRatio = areaGrowthRate / (motionDeg + 0.01);

        const preflightGrid = this._preflight?.getGrid() ?? null;
        const preflightCell = preflightGrid
            ? lookupNearestCell(preflightGrid, current.centroid[0], current.centroid[1])
            : null;
        const instabilityScore = preflightCell?.instabilityScore ?? 0.5;

        const timeOfDayFactor = computeSolarHeatingMultiplier(new Date());

        const rawScore =
            _normAreaGrowth(areaGrowthRate)    * 0.35 +
            _normDbzGrowth(dbzGrowthRate)      * 0.25 +
            edgeIrregularity                    * 0.10 +
            _normMotionRatio(areaVsMotionRatio) * 0.10 +
            instabilityScore                    * 0.15 +
            timeOfDayFactor                     * 0.05;

        return {
            score: Math.min(rawScore, 1.0),
            confidence: matched.length >= 5 ? 'high' : 'moderate',
            signals: {
                areaGrowthRate,
                dbzGrowthRate,
                edgeIrregularity,
                instabilityScore,
                framesAnalyzed: matched.length,
            },
        };
    }
}

// ========== Hazard Boundary Expansion ==========

/**
 * Compute probabilistic hazard boundary rings around a convective return.
 * @param {{ maxIntensity: number, signals?: object }} cluster
 * @param {number} convectiveScore  0–1
 * @param {number} ageMinutes       data age in minutes
 * @param {{ cape?: number }|null} preflightCell
 * @returns {{ bufferNm: number, rings: Array<{radiusNm, probability}> }}
 */
function computeHazardBoundary(cluster, convectiveScore, ageMinutes, preflightCell) {
    let bufferNm = 20;  // base 20nm minimum

    if      (convectiveScore > 0.80) bufferNm = 25;
    else if (convectiveScore > 0.60) bufferNm = 22;
    else if (convectiveScore > 0.30) bufferNm = 18;

    bufferNm += Math.min((ageMinutes || 0) * 0.5, 8);

    const cape = preflightCell?.cape ?? 1000;
    if      (cape > 2500) bufferNm += 5;
    else if (cape > 1500) bufferNm += 3;

    const growthRate = cluster.signals?.areaGrowthRate ?? 0;
    if (growthRate > 1.0) bufferNm += 5;  // explosive growth

    return {
        bufferNm,
        rings: [
            { radiusNm: bufferNm * 0.4, probability: 0.80 },
            { radiusNm: bufferNm * 0.7, probability: 0.60 },
            { radiusNm: bufferNm * 1.0, probability: 0.40 },
            { radiusNm: bufferNm * 1.3, probability: 0.20 },
        ],
    };
}
