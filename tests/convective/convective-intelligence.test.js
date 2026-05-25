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
