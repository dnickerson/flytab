import { describe, it, expect } from 'vitest';

// ---- inline pure functions (no DOM deps) ----

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

function fitExponentialSlope(values) {
    const logVals = values.map(v => Math.log(Math.max(v, 0.001)));
    return Math.exp(fitLinearSlope(logVals)) - 1;
}

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
    return Math.min(Math.max((perimCount / total - 0.3) / 0.7, 0), 1);
}

function computeSolarHeatingMultiplier(date) {
    const h = date.getHours() + date.getMinutes() / 60;
    if (h < 9 || h > 22) return 0.2;
    if (h < 12) return 0.3 + ((h - 9) / 3) * 0.4;
    if (h < 15) return 0.7 + ((h - 12) / 3) * 0.3;
    if (h < 17) return 1.0;
    if (h < 20) return 1.0 - ((h - 17) / 3) * 0.5;
    return 0.3;
}

function computeCellInstabilityScore({ cape, cin, lcl, lfc, shear03, dewpoint, timeOfDay }) {
    let score = 0;
    if      (cape < 200)  score += 0.00;
    else if (cape < 500)  score += 0.10;
    else if (cape < 1000) score += 0.20;
    else if (cape < 1500) score += 0.35;
    else if (cape < 2500) score += 0.50;
    else                  score += 0.65;
    if      (cin < 10)  score += 0.20;
    else if (cin < 25)  score += 0.15;
    else if (cin < 50)  score += 0.10;
    else if (cin < 100) score += 0.02;
    const mult = computeSolarHeatingMultiplier(timeOfDay instanceof Date ? timeOfDay : new Date());
    score *= mult;
    if (dewpoint > 70) score += 0.10;
    else if (dewpoint > 65) score += 0.05;
    if (shear03 > 30) score += 0.05;
    return Math.min(score, 1.0);
}

// ---- tests ----

describe('fitLinearSlope', () => {
    it('returns positive slope for increasing series', () => {
        expect(fitLinearSlope([1, 2, 3, 4])).toBeGreaterThan(0);
    });
    it('returns ~1 for linear [0,1,2,3]', () => {
        expect(fitLinearSlope([0, 1, 2, 3])).toBeCloseTo(1, 5);
    });
    it('returns 0 for flat series', () => {
        expect(fitLinearSlope([5, 5, 5, 5])).toBe(0);
    });
    it('returns 0 for single value', () => {
        expect(fitLinearSlope([42])).toBe(0);
    });
});

describe('fitExponentialSlope', () => {
    it('returns positive rate for exponentially growing series', () => {
        expect(fitExponentialSlope([10, 20, 40, 80])).toBeGreaterThan(0.5);
    });
    it('returns near 0 for flat series', () => {
        expect(Math.abs(fitExponentialSlope([5, 5, 5, 5]))).toBeLessThan(0.05);
    });
    it('>50% growth rate for convective (100% per frame)', () => {
        expect(fitExponentialSlope([5, 10, 20, 40])).toBeGreaterThan(0.5);
    });
});

describe('computeEdgeIrregularity', () => {
    it('returns near 0 for a 10x10 square (compact, low irregularity)', () => {
        const cells = [];
        for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) cells.push({ gLat: r, gLon: c });
        expect(computeEdgeIrregularity({ cells })).toBeLessThan(0.15);
    });
    it('returns >0 for a line (high perimeter fraction)', () => {
        const cells = [{ gLat: 0, gLon: 0 }, { gLat: 0, gLon: 1 }, { gLat: 0, gLon: 2 }, { gLat: 0, gLon: 3 }];
        expect(computeEdgeIrregularity({ cells })).toBeGreaterThan(0);
    });
});

describe('computeSolarHeatingMultiplier', () => {
    it('returns maximum 1.0 at 16:00 local', () => {
        const d = new Date(); d.setHours(16, 0, 0, 0);
        expect(computeSolarHeatingMultiplier(d)).toBe(1.0);
    });
    it('returns minimum at night (02:00)', () => {
        const d = new Date(); d.setHours(2, 0, 0, 0);
        expect(computeSolarHeatingMultiplier(d)).toBe(0.2);
    });
    it('is lower at 09:00 than 15:00', () => {
        const d09 = new Date(); d09.setHours(9, 0, 0, 0);
        const d15 = new Date(); d15.setHours(15, 0, 0, 0);
        expect(computeSolarHeatingMultiplier(d09)).toBeLessThan(computeSolarHeatingMultiplier(d15));
    });
});

describe('computeCellInstabilityScore', () => {
    const peak = { timeOfDay: (() => { const d = new Date(); d.setHours(15,0,0,0); return d; })() };

    it('returns low score for stable, capped atmosphere at peak heating', () => {
        const score = computeCellInstabilityScore({ cape: 100, cin: 200, lcl: 9999, lfc: 9999, shear03: 0, dewpoint: 40, ...peak });
        expect(score).toBeLessThan(0.15);
    });

    it('returns high score for explosive instability at peak heating', () => {
        const score = computeCellInstabilityScore({ cape: 3000, cin: 5, lcl: 2000, lfc: 3000, shear03: 0, dewpoint: 72, ...peak });
        expect(score).toBeGreaterThan(0.7);
    });

    it('never exceeds 1.0', () => {
        const score = computeCellInstabilityScore({ cape: 5000, cin: 0, lcl: 1000, lfc: 1000, shear03: 50, dewpoint: 80, ...peak });
        expect(score).toBeLessThanOrEqual(1.0);
    });
});

// ---- NexradSectorAnalyzer helpers ----

function makeCluster(gLat, gLon, size, intensity) {
    const cells = [];
    for (let i = 0; i < size; i++) cells.push({ gLat: gLat + Math.floor(i / 4), gLon: gLon + (i % 4) });
    return { cells, maxIntensity: intensity, centroid: [gLat * 0.25, gLon * 0.25] };
}

// inline _analyzeCluster logic for unit testing
function runAnalysis(matched) {
    if (matched.length < 3) return { score: null, confidence: 'insufficient_data', signals: { framesAnalyzed: matched.length } };
    const areas    = matched.map(c => c.cells.length);
    const peakDbzs = matched.map(c => c.maxIntensity);
    const cents    = matched.map(c => c.centroid);
    const areaGrowthRate  = fitExponentialSlope(areas);
    const dbzGrowthRate   = fitLinearSlope(peakDbzs);
    const first = cents[0], last = cents[cents.length - 1];
    const motionDeg = Math.sqrt((last[0]-first[0])**2+(last[1]-first[1])**2) / matched.length;
    const areaVsMotionRatio = areaGrowthRate / (motionDeg + 0.01);
    const instabilityScore = 0.5;
    const timeOfDayFactor = 0.5;
    const rawScore =
        Math.min(Math.max((areaGrowthRate <= 0.05 ? 0 : areaGrowthRate >= 0.5 ? 1 : (areaGrowthRate - 0.05) / 0.45), 0), 1) * 0.35 +
        Math.min(Math.max((dbzGrowthRate <= 2 ? 0 : dbzGrowthRate >= 8 ? 1 : (dbzGrowthRate - 2) / 6), 0), 1) * 0.25 +
        0 * 0.10 +
        Math.min(Math.max(areaVsMotionRatio / 5, 0), 1) * 0.10 +
        instabilityScore * 0.15 +
        timeOfDayFactor * 0.05;
    return {
        score: Math.min(rawScore, 1.0),
        confidence: matched.length >= 5 ? 'high' : 'moderate',
        signals: { areaGrowthRate, dbzGrowthRate, framesAnalyzed: matched.length },
    };
}

describe('NexradSectorAnalyzer score model', () => {
    it('insufficient_data when < 3 matched frames', () => {
        const r = runAnalysis([makeCluster(100, -330, 5, 3), makeCluster(100, -330, 6, 3)]);
        expect(r.confidence).toBe('insufficient_data');
        expect(r.score).toBeNull();
    });

    it('low score for stationary stratiform (no growth)', () => {
        const matched = [5, 5, 5, 5, 5].map((size, i) => makeCluster(100 + i * 0.01, -330, size, 3));
        const r = runAnalysis(matched);
        expect(r.score).toBeLessThan(0.5);
    });

    it('high score for explosive convective growth', () => {
        const matched = [
            makeCluster(100, -330, 2, 3),
            makeCluster(100, -330, 4, 4),
            makeCluster(100, -330, 8, 5),
            makeCluster(100, -330, 16, 6),
            makeCluster(100, -330, 32, 7),
        ];
        const r = runAnalysis(matched);
        expect(r.score).toBeGreaterThan(0.5);
    });

    it('confidence is high with >= 5 matched frames', () => {
        const matched = Array(5).fill(0).map((_, i) => makeCluster(100, -330 + i * 0.001, 5, 3));
        const r = runAnalysis(matched);
        expect(r.confidence).toBe('high');
    });
});

function computeHazardBoundary(cluster, convectiveScore, ageMinutes, preflightCell) {
    let bufferNm = 20;
    if (convectiveScore > 0.80) bufferNm = 25;
    else if (convectiveScore > 0.60) bufferNm = 22;
    else if (convectiveScore > 0.30) bufferNm = 18;
    bufferNm += Math.min((ageMinutes || 0) * 0.5, 8);
    const cape = preflightCell?.cape ?? 1000;
    if (cape > 2500) bufferNm += 5;
    else if (cape > 1500) bufferNm += 3;
    const growthRate = cluster.signals?.areaGrowthRate ?? 0;
    if (growthRate > 1.0) bufferNm += 5;
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

describe('computeHazardBoundary', () => {
    it('confirmed convective has bufferNm >= 25', () => {
        const r = computeHazardBoundary({}, 0.9, 0, null);
        expect(r.bufferNm).toBeGreaterThanOrEqual(25);
    });
    it('adds up to 8nm for old data (16+ minutes)', () => {
        const young = computeHazardBoundary({}, 0.9, 0,  null);
        const old   = computeHazardBoundary({}, 0.9, 20, null);
        expect(old.bufferNm).toBeGreaterThan(young.bufferNm);
        expect(old.bufferNm - young.bufferNm).toBeLessThanOrEqual(8);
    });
    it('returns 4 rings in decreasing probability order', () => {
        const r = computeHazardBoundary({}, 0.5, 5, null);
        expect(r.rings).toHaveLength(4);
        expect(r.rings[0].probability).toBeGreaterThan(r.rings[3].probability);
    });
    it('rings are sorted by increasing radius', () => {
        const r = computeHazardBoundary({}, 0.5, 5, null);
        for (let i = 1; i < r.rings.length; i++) {
            expect(r.rings[i].radiusNm).toBeGreaterThan(r.rings[i-1].radiusNm);
        }
    });
});

// inline evaluateRouteAlerts dependencies
function nmBetween2(a, b) {
    const R = 3440.065;
    const dLat = (b.lat - a.lat) * Math.PI / 180;
    const dLon = (b.lon - a.lon) * Math.PI / 180;
    const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
function evalAlerts(results, aircraft) {
    if (!aircraft) return [];
    const alerts = [];
    const gs = aircraft.groundspeedKts || 120;
    for (const { cluster, analysis } of results) {
        if (!analysis.score || analysis.score < 0.30) continue;
        const distNm = nmBetween2(aircraft, { lat: cluster.centroid[0], lon: cluster.centroid[1] });
        const boundary = { bufferNm: analysis.score > 0.80 ? 25 : analysis.score > 0.60 ? 22 : 18 };
        const distToHazardNm = distNm - boundary.bufferNm;
        const minsToBoundary = distToHazardNm > 0 ? (distToHazardNm / gs) * 60 : 0;
        if (distToHazardNm < 0) alerts.push({ level: 4, message: 'INSIDE CONVECTIVE HAZARD ZONE — DEVIATE IMMEDIATELY', voice: true });
        else if (minsToBoundary < 5 && analysis.score > 0.60) alerts.push({ level: 3, message: `CONVECTIVE HAZARD ${Math.round(distToHazardNm)}NM — DEVIATE NOW`, voice: true });
        else if (minsToBoundary < 15 && analysis.score > 0.60) alerts.push({ level: 2, message: `Convective return ${Math.round(distNm)}NM — deviation recommended`, voice: false });
        else if (minsToBoundary < 30 && analysis.score > 0.30) alerts.push({ level: 1, message: `Possible convective ${Math.round(distNm)}NM — monitor`, voice: false });
    }
    return alerts.sort((a, b) => b.level - a.level);
}

describe('evaluateRouteAlerts', () => {
    const ac = { lat: 34.0, lon: -82.0, groundspeedKts: 150 };

    it('no alerts when no results above 0.30', () => {
        const results = [{ cluster: { centroid: [34.1, -82.1] }, analysis: { score: 0.1, confidence: 'moderate', signals: {} } }];
        expect(evalAlerts(results, ac)).toHaveLength(0);
    });

    it('level 4 alert when aircraft inside hazard boundary', () => {
        const results = [{ cluster: { centroid: [34.0, -82.0] }, analysis: { score: 0.9, confidence: 'high', signals: {} } }];
        const alerts = evalAlerts(results, ac);
        expect(alerts[0].level).toBe(4);
        expect(alerts[0].voice).toBe(true);
    });

    it('level 1 alert for distant ambiguous return', () => {
        const results = [{ cluster: { centroid: [33.3, -82.0] }, analysis: { score: 0.4, confidence: 'moderate', signals: {} } }];
        const alerts = evalAlerts(results, ac);
        expect(alerts.length).toBeGreaterThan(0);
        expect(alerts[0].level).toBeLessThan(4);
    });

    it('returns no alerts when aircraft is null', () => {
        const results = [{ cluster: { centroid: [34.0, -82.0] }, analysis: { score: 0.9, confidence: 'high', signals: {} } }];
        expect(evalAlerts(results, null)).toHaveLength(0);
    });
});
