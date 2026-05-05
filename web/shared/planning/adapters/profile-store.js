// @ts-check
'use strict';

/**
 * @interface ProfileStore
 * Read-write store for AircraftProfile records.
 */
export class ProfileStore {
    /** @param {string} id @returns {Promise<import('../types/aircraft-profile.js').AircraftProfile|null>} */
    async get(id) { throw new Error('not implemented'); }
    /** @param {import('../types/aircraft-profile.js').AircraftProfile} profile @returns {Promise<string>} */
    async put(profile) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/aircraft-profile.js').AircraftProfile[]>} */
    async list() { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/aircraft-profile.js').AircraftProfile|null>} */
    async getActive() { throw new Error('not implemented'); }
}
