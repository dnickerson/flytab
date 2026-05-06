// @ts-check
'use strict';

/**
 * @interface AeroDataSource
 * Read-only NASR / CIFP queries. Implementation may be IDB-backed (flytab),
 * Supabase-backed (flywhere), or in-memory (tests).
 */
export class AeroDataSource {
    /** @param {string} icao @returns {Promise<import('../types/airport.js').Airport|null>} */
    async getAirport(icao) { throw new Error('not implemented'); }
    /** @param {string} id   @returns {Promise<import('../types/navaid.js').Navaid|null>} */
    async getNavaid(id) { throw new Error('not implemented'); }
    /** @param {string} name @returns {Promise<import('../types/fix.js').Fix|null>} */
    async getFix(name) { throw new Error('not implemented'); }
    /** @param {string} airwayId @returns {Promise<import('../types/airway.js').Airway|null>} */
    async getAirway(airwayId) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/airspace.js').Airspace[]>} */
    async listAirspace() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/airway.js').Airway[]>} */
    async listAirways() { throw new Error('not implemented'); }
}
