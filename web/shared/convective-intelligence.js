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
    // AMBIGUOUS (0.30–0.60) keeps the 20nm base — lower confidence still warrants full buffer

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

// ========== Route Alert System ==========

/**
 * Evaluate which analysis results intersect the aircraft's projected track.
 * @param {{ waypoints: Array<{lat,lon}> }|null} route
 * @param {Array<{cluster, analysis}>} results
 * @param {{ lat, lon, groundspeedKts?: number }|null} aircraft
 * @returns {Array<{ level:1|2|3|4, message:string, voice:boolean, minutesToBoundary?:number }>}
 */
function evaluateRouteAlerts(results, aircraft) {
    if (!aircraft) return [];

    const alerts = [];
    const gs = aircraft.groundspeedKts || 120;

    for (const { cluster, analysis } of results) {
        if (!analysis.score || analysis.score < 0.30) continue;

        const [clLat, clLon] = cluster.centroid;
        const boundary = computeHazardBoundary(cluster, analysis.score, 0, null);

        const distNm = _nmBetween2(aircraft, { lat: clLat, lon: clLon });
        const distToHazardNm = distNm - boundary.bufferNm;
        const minsToBoundary = distToHazardNm > 0 ? (distToHazardNm / gs) * 60 : 0;

        if (distToHazardNm < 0) {
            alerts.push({
                level: 4,
                message: 'INSIDE CONVECTIVE HAZARD ZONE — DEVIATE IMMEDIATELY',
                voice: true,
                minutesToBoundary: 0,
            });
        } else if (minsToBoundary < 5 && analysis.score > 0.60) {
            alerts.push({
                level: 3,
                message: `CONVECTIVE HAZARD ${Math.round(distToHazardNm)}NM — DEVIATE NOW`,
                voice: true,
                minutesToBoundary: Math.round(minsToBoundary),
            });
        } else if (minsToBoundary < 15 && analysis.score > 0.60) {
            alerts.push({
                level: 2,
                message: `Convective return ${Math.round(distNm)}NM — deviation recommended`,
                voice: false,
                minutesToBoundary: Math.round(minsToBoundary),
            });
        } else if (minsToBoundary < 30 && analysis.score > 0.30) {
            alerts.push({
                level: 1,
                message: `Possible convective ${Math.round(distNm)}NM — monitor`,
                voice: false,
                minutesToBoundary: Math.round(minsToBoundary),
            });
        }
    }

    return alerts.sort((a, b) => b.level - a.level);
}

function _nmBetween2(a, b) {
    const R = 3440.065;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// ========== OAT Trend Monitor ==========

/**
 * 5-minute rolling OAT trend detector.
 * Wire to engine:data events: monitor.ingest(data.oat, Date.now())
 */
class OATTrendMonitor {
    constructor() {
        this._buffer    = [];
        this._maxMs     = 300000;     // 5-minute window
    }

    /**
     * Ingest a new OAT reading.
     * @param {number} oatC       - outside air temp in °C
     * @param {number} timestamp  - Date.now()
     */
    ingest(oatC, timestamp) {
        if (oatC == null || isNaN(oatC)) return;
        this._buffer.push({ oatC, timestamp });
        const cutoff = timestamp - this._maxMs;
        this._buffer = this._buffer.filter(r => r.timestamp >= cutoff);
    }

    /**
     * Analyze current buffer.
     * @returns {{ trendCPerMin, varianceC, signals } | null}
     *   null if insufficient data (< 30 readings)
     */
    analyze() {
        if (this._buffer.length < 30) return null;

        const temps  = this._buffer.map(r => r.oatC);
        const slope  = fitLinearSlope(temps);
        const trendCPerMin = slope * 60;

        const last60 = this._buffer.slice(-60).map(r => r.oatC);
        const varianceC = computeVariance(last60);

        return {
            trendCPerMin,
            varianceC,
            signals: {
                rapidWarming:        trendCPerMin > 0.3,
                convergenceBoundary: varianceC > 1.5,
                outflowBoundary:     trendCPerMin < -0.5,
            },
        };
    }

    reset() { this._buffer = []; }
}

// ========== Wind Convergence Detection ==========

/**
 * Compare GPS-derived winds to FIS-B winds aloft to detect convergence.
 * @param {{ ground_speed: number, true_course: number }|null} situation  - Stratux situation
 * @param {{ dir: number, spd: number }|null} forecastWind  - from fisbClient.getNearestWind()
 * @returns {{ speedDeltaKts: number, directionDeltaDeg: number, convergenceScore: number } | null}
 */
function detectWindConvergence(situation, forecastWind) {
    if (!situation || situation.ground_speed == null) return null;
    if (!forecastWind) return null;

    const gpsDir   = situation.true_course ?? 0;
    const gpsSpeed = situation.ground_speed ?? 0;

    const fDir   = forecastWind.dir  ?? 0;
    const fSpeed = forecastWind.spd  ?? 0;

    const speedDelta = Math.abs(gpsSpeed - fSpeed);

    let dirDelta = Math.abs(gpsDir - fDir) % 360;
    if (dirDelta > 180) dirDelta = 360 - dirDelta;

    const speedScore = Math.min(speedDelta / 30, 1);
    const dirScore   = Math.min(dirDelta   / 60, 1);
    const convergenceScore = (speedScore * 0.5 + dirScore * 0.5);

    return {
        speedDeltaKts:    speedDelta,
        directionDeltaDeg: dirDelta,
        convergenceScore,
    };
}

// ========== ConvectiveIntelligenceEngine ==========

/**
 * Top-level integration class.
 * Wire up once in app.js after all clients are ready.
 *
 * Usage:
 *   const engine = new ConvectiveIntelligenceEngine({ fisbNexrad, fisbClient, engineClient, stratuxClient, preflightStore });
 *   engine.init(display, alerts);
 *   engine.setActive(true);
 */
class ConvectiveIntelligenceEngine {
    constructor({ fisbNexrad, fisbClient, engineClient, stratuxClient, preflightStore }) {
        this._nexrad    = fisbNexrad;
        this._fisb      = fisbClient;
        this._engine    = engineClient;
        this._stratux   = stratuxClient;
        this._preflight = preflightStore;

        this._analyzer   = new NexradSectorAnalyzer(fisbNexrad, preflightStore);
        this._oatMonitor = new OATTrendMonitor();
        this._display    = null;
        this._alerts     = null;
        this._active     = false;
        this._lastAnalysis = [];
        this._route      = null;

        this._onNexrad     = () => this._runAnalysis();
        this._onEngineData = (e) => {
            const oat = e.detail?.oat;
            if (oat != null) this._oatMonitor.ingest(oat, Date.now());
        };
    }

    init(display, alerts) {
        this._display = display;
        this._alerts  = alerts;
    }

    setActive(on) {
        if (on === this._active) return;
        this._active = on;
        if (on) {
            this._fisb?.addEventListener('fisb:nexrad', this._onNexrad);
            this._engine?.addEventListener('engine:data', this._onEngineData);
        } else {
            this._fisb?.removeEventListener('fisb:nexrad', this._onNexrad);
            this._engine?.removeEventListener('engine:data', this._onEngineData);
        }
        this._display?.setActive(on);
        this._alerts?.setActive(on);
    }

    setRoute(route) { this._route = route; }

    async loadPreflight() {
        await this._preflight.load();
        const staleness = this._preflight.getStaleness();
        if (staleness === 'stale' || staleness === 'expired') {
            DiagLog.log('convective', `Preflight HRRR data is ${staleness}: ${this._preflight.getAgeLabel()}`);
        }
        return staleness;
    }

    async fetchPreflight(bbox) {
        return this._preflight.fetchAndStore(bbox);
    }

    get lastAnalysis() { return this._lastAnalysis; }
    get preflightStaleness() { return this._preflight.getStaleness(); }

    _runAnalysis() {
        const analysis = this._analyzer.analyze();
        this._lastAnalysis = analysis;

        const sit = this._stratux.situation;
        const aircraft = sit ? { lat: sit.lat, lon: sit.lon, groundspeedKts: sit.ground_speed } : null;

        if (this._display) {
            this._display.setAgeMs(this._nexrad.getDataAgeMs());
            this._display.update(analysis, aircraft);
        }

        if (this._alerts) {
            const routeAlerts = this._route && aircraft
                ? evaluateRouteAlerts(analysis, aircraft)
                : [];

            let convergenceSignal = null;
            if (aircraft) {
                const forecastWind = this._fisb.getNearestWind(
                    aircraft.lat, aircraft.lon,
                    sit?.alt_baro ?? 3000
                );
                if (forecastWind) convergenceSignal = detectWindConvergence(sit, forecastWind);
            }

            const oatResult = this._oatMonitor.analyze();

            if (convergenceSignal?.convergenceScore > 0.7) {
                routeAlerts.push({
                    level: 2,
                    message: `Wind deviation ${Math.round(convergenceSignal.speedDeltaKts)}kt/${Math.round(convergenceSignal.directionDeltaDeg)}° — possible convergence boundary`,
                    voice: false,
                });
            }

            this._alerts.showAlerts(routeAlerts, oatResult?.signals ?? null);
        }
    }
}
