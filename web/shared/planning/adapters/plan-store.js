// @ts-check
'use strict';

/**
 * @interface PlanStore
 * Read-write store for FlightPlan records.
 */
export class PlanStore {
    /** @param {string} id @returns {Promise<import('../types/flight-plan.js').FlightPlan|null>} */
    async get(id) { throw new Error('not implemented'); }
    /** @param {import('../types/flight-plan.js').FlightPlan} plan @returns {Promise<string>} */
    async put(plan) { throw new Error('not implemented'); }
    /** @returns {Promise<import('../types/flight-plan.js').FlightPlan[]>} */
    async list() { throw new Error('not implemented'); }
    /** @param {string} id @returns {Promise<void>} */
    async delete(id) { throw new Error('not implemented'); }
}
