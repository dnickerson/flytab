// @ts-check
'use strict';

import { describe, it, expect } from 'vitest';
import { AirwayGraph } from '../../../web/shared/planning/planner/airway-graph.js';
import { makeAeroAdapter } from '../fixtures/mock-adapters.js';
import { FIXES, AIRWAYS } from '../fixtures/synthetic-airway-graph.js';

const aero = makeAeroAdapter({ fixes: FIXES, airways: AIRWAYS });

describe('AirwayGraph routingMode', () => {
    it('routingMode "any" loads V and T edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'any' });
        await g.load();
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(true);
        expect(g.edges('A').some(e => e.airway === 'T1')).toBe(true);
    });

    it('routingMode "v-airways" loads only V edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(true);
        expect(g.edges('A').some(e => e.airway === 'T1')).toBe(false);
    });

    it('routingMode "t-airways" loads only T edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 't-airways' });
        await g.load();
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(false);
        expect(g.edges('A').some(e => e.airway === 'T1')).toBe(true);
    });

    it('routingMode "gps-direct" loads no airway edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'gps-direct' });
        await g.load();
        expect(g.edges('A')).toEqual([]);
        expect(g.edges('C')).toEqual([]);
    });

    it('routingMode "vors-direct" loads no airway edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'vors-direct' });
        await g.load();
        expect(g.edges('A')).toEqual([]);
    });

    it('edges include both directions', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        expect(g.edges('B').some(e => e.toId === 'A')).toBe(true);
        expect(g.edges('B').some(e => e.toId === 'C')).toBe(true);
    });
});

describe('AirwayGraph.clearDirectEdges', () => {
    it('removes only direct edges, keeps airway edges', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        g.addDirectEdge('A', 33.0, -85.0, 'C', 34.0, -84.0);
        // Direct edges should appear
        expect(g.edges('A').some(e => e.airway === 'DIRECT')).toBe(true);
        // Plus the V-airway edge to B from prior load
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(true);

        g.clearDirectEdges();
        // V-airway edges remain
        expect(g.edges('A').some(e => e.airway === 'V1')).toBe(true);
        expect(g.edges('B').some(e => e.airway === 'V1')).toBe(true);
        // No DIRECT edges anywhere
        expect(g.edges('A').some(e => e.airway === 'DIRECT')).toBe(false);
        expect(g.edges('C').some(e => e.airway === 'DIRECT')).toBe(false);
    });

    it('safe to call when no direct edges exist', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        // No direct edges added; clearing should be a no-op
        const beforeAEdges = g.edges('A').length;
        g.clearDirectEdges();
        expect(g.edges('A').length).toBe(beforeAEdges);
    });
});

describe('AirwayGraph.nearestFixes', () => {
    it('returns fixes within maxNm sorted by distance', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        // FIXES.A is (33.0, -85.0). FIXES.B is (33.5, -84.5) — about 41 nm.
        const near = g.nearestFixes(33.0, -85.0, 100, 3);
        expect(near.length).toBeGreaterThan(0);
        expect(near[0].id).toBe('A');           // distance 0
        expect(near[0].distNm).toBeCloseTo(0, 4);
        // results are sorted ascending
        for (let i = 1; i < near.length; i++) {
            expect(near[i].distNm).toBeGreaterThanOrEqual(near[i - 1].distNm);
        }
    });

    it('respects maxNm cap', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        const near = g.nearestFixes(33.0, -85.0, 1, 10);  // 1nm cap
        // Only FIXES.A itself (distance 0) is within 1nm
        expect(near.length).toBe(1);
        expect(near[0].id).toBe('A');
    });

    it('respects limit', async () => {
        const g = new AirwayGraph(aero, { routingMode: 'v-airways' });
        await g.load();
        const near = g.nearestFixes(33.0, -85.0, 1000, 2);
        expect(near.length).toBeLessThanOrEqual(2);
    });
});

describe('AirwayGraph inline waypoints', () => {
    it('builds edges from airway.waypoints when fixes/navaids stores are empty', async () => {
        // Mirrors the real NASR bundle shape: waypoint has id+lat+lon inline
        const inlineAero = makeAeroAdapter({
            fixes: {},
            airways: {
                V99: {
                    id: 'V99',
                    type: 'V',
                    fixIds: ['P', 'Q', 'R'],
                    waypoints: [
                        { id: 'P', lat: 33.0, lon: -85.0 },
                        { id: 'Q', lat: 33.5, lon: -84.5 },
                        { id: 'R', lat: 34.0, lon: -84.0 },
                    ],
                },
            },
        });
        const g = new AirwayGraph(inlineAero, { routingMode: 'v-airways' });
        await g.load();
        expect(g.edges('P').some(e => e.toId === 'Q' && e.airway === 'V99')).toBe(true);
        expect(g.edges('Q').some(e => e.toId === 'R' && e.airway === 'V99')).toBe(true);
        expect(g.coords['Q']).toEqual({ lat: 33.5, lon: -84.5 });
    });
});
