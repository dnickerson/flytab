// @ts-check
'use strict';

/**
 * Mock implementations of all adapter interfaces for testing.
 */

/**
 * In-memory mock AeroDataSource.
 * @param {{airports?: {}, navaids?: {}, fixes?: {}, airways?: {}, airspaces?: []}} [opts]
 * @returns {import('../../../web/shared/planning/adapters/aero-data-source.js').AeroDataSource}
 */
export function makeAeroAdapter({ airports = {}, navaids = {}, fixes = {}, airways = {}, airspaces = [] } = {}) {
    return {
        async getAirport(icao) { return airports[icao] ?? null; },
        async getNavaid(id)    { return navaids[id]  ?? null; },
        async getFix(name)     { return fixes[name]  ?? null; },
        async getAirway(id)    { return airways[id]  ?? null; },
        async listAirspace()   { return airspaces; },
        async listAirways()    { return Object.values(airways); },
    };
}

/**
 * Mock WeatherSource that returns null/empty for all queries.
 */
export const NULL_WEATHER = {
    async getMetar() { return null; },
    async getWindAloft() { return null; },
    async listActiveTfrs() { return []; },
    async listSigmets() { return []; },
    async listAirmets() { return []; },
};

/**
 * Mock PlanStore that returns null/empty for all queries.
 */
export const NULL_PLANS = {
    async get() { return null; },
    async put() { return ''; },
    async list() { return []; },
    async delete() {},
};

/**
 * Mock ProfileStore that returns null/empty for all queries.
 */
export const NULL_PROFILES = {
    async get() { return null; },
    async put() { return ''; },
    async list() { return []; },
    async getActive() { return null; },
};

/**
 * Mock NetworkStatus that reports 'home' mode indefinitely.
 */
export const NULL_NETWORK = new (class extends EventTarget {
    get mode() { return 'home'; }
})();

/**
 * Mock Clock with a frozen timestamp (2024-01-01T00:00:00Z).
 */
export const FROZEN_CLOCK = { now: () => 1704067200000 };
