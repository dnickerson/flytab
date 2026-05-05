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
