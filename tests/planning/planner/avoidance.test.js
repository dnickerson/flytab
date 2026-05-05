import { describe, it, expect } from 'vitest';
import { buildAvoidancePenalty, segmentIntersectsPolygon } from '../../../web/shared/planning/planner/avoidance.js';

const SQUARE = [
    { lat: 33.0, lon: -85.0 },
    { lat: 33.0, lon: -84.0 },
    { lat: 34.0, lon: -84.0 },
    { lat: 34.0, lon: -85.0 },
];

describe('segmentIntersectsPolygon', () => {
    it('detects a segment crossing the square', () => {
        expect(segmentIntersectsPolygon(33.5, -85.5, 33.5, -83.5, SQUARE)).toBe(true);
    });
    it('returns false for a segment entirely outside', () => {
        expect(segmentIntersectsPolygon(35.0, -85.5, 35.0, -83.5, SQUARE)).toBe(false);
    });
});

describe('buildAvoidancePenalty', () => {
    it('returns Infinity for an edge crossing an avoided airspace', () => {
        const fn = buildAvoidancePenalty([{ id: 'NYB', polygon: SQUARE }], { hardBlock: true });
        const cost = fn({ from: { lat: 33.5, lon: -85.5 }, to: { lat: 33.5, lon: -83.5 } });
        expect(cost).toBe(Infinity);
    });
    it('returns 0 when no airspaces are avoided', () => {
        const fn = buildAvoidancePenalty([]);
        expect(fn({ from: { lat: 33, lon: -85 }, to: { lat: 34, lon: -84 } })).toBe(0);
    });
});
