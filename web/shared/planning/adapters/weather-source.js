// @ts-check
'use strict';

/**
 * @interface WeatherSource
 * Read-only weather. Implementation may pull from FIS-B (in flight),
 * AWC via flywhere.app proxy (online), or a cache (offline).
 */
export class WeatherSource {
    /** @param {string} icao @returns {Promise<import('../types/weather.js').Metar|null>} */
    async getMetar(icao) { throw new Error('not implemented'); }
    /** @param {{lat:number,lon:number}} point @param {number} altFt
     *  @returns {Promise<import('../types/weather.js').WindAloft|null>} */
    async getWindAloft(point, altFt) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/weather.js').Tfr[]>} */
    async listActiveTfrs() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/weather.js').Sigmet[]>} */
    async listSigmets() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/weather.js').Airmet[]>} */
    async listAirmets() { throw new Error('not implemented'); }
}
