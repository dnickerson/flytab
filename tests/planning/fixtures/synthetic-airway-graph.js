// @ts-check
'use strict';

/**
 * Synthetic airway graph for testing airway routing modes.
 *
 * 5 fixes arranged in a cross pattern:
 *        B
 *       / \
 *      /   \
 *     A --- D --- C
 *
 * - V1 airway: A → B → C (V-prefix, low altitude)
 * - T1 airway: A → D → C (T-prefix, RNAV)
 *
 * Tests can assert behavior for routing modes by checking which
 * airway edges are loaded into the graph.
 */

/** @typedef {import('../../../web/shared/planning/types/fix.js').Fix} Fix */
/** @typedef {import('../../../web/shared/planning/types/airway.js').Airway} Airway */

/** @type {Record<string, Fix>} */
export const FIXES = {
    A: { id: 'A', lat: 33.0, lon: -85.0 },
    B: { id: 'B', lat: 33.5, lon: -84.5 },
    C: { id: 'C', lat: 34.0, lon: -84.0 },
    D: { id: 'D', lat: 33.4, lon: -84.6 },
    E: { id: 'E', lat: 34.1, lon: -83.9 },
};

/** @type {Record<string, Airway>} */
export const AIRWAYS = {
    V1: { id: 'V1', type: 'V', fixIds: ['A', 'B', 'C'] },
    T1: { id: 'T1', type: 'T', fixIds: ['A', 'D', 'C'] },
};
