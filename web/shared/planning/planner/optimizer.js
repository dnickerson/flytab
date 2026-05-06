// @ts-check
'use strict';

import { RoutePlanner } from './route-planner.js';

const ALT_CANDIDATES_FT = [2000, 4000, 6000, 8000, 10000, 12000];

/**
 * @typedef {import('../adapters/aero-data-source.js').AeroDataSource} AeroDataSource
 * @typedef {import('../adapters/weather-source.js').WeatherSource}    WeatherSource
 * @typedef {import('../adapters/plan-store.js').PlanStore}            PlanStore
 * @typedef {import('../adapters/profile-store.js').ProfileStore}      ProfileStore
 * @typedef {import('../adapters/network-status.js').NetworkStatus}    NetworkStatus
 * @typedef {import('../adapters/clock.js').Clock}                     Clock
 *
 * @typedef Adapters
 * @property {AeroDataSource} aero
 * @property {WeatherSource}  weather
 * @property {PlanStore}      plans
 * @property {ProfileStore}   profiles
 * @property {NetworkStatus}  network
 * @property {Clock}          clock
 *
 * @typedef OptimizationResult
 * @property {number} altFt
 * @property {number} [fuel]
 * @property {number} [time]
 * @property {import('../types/flight-plan.js').FlightPlan} plan
 */

export class Optimizer {
    /**
     * @param {Adapters} adapters
     */
    constructor(adapters) {
        this._planner = new RoutePlanner(adapters);
    }

    /**
     * Return whichever altitude minimises total fuel for the route.
     * @param {object} opts
     * @param {string} opts.departure
     * @param {string} opts.destination
     * @param {string} [opts.routingMode]
     * @param {number} [opts.reserveGal]
     * @param {number} [opts.maxLegHrs]
     * @param {boolean} [opts.selfServeOnly]
     * @param {Array} [opts.avoidance]
     * @returns {Promise<OptimizationResult>}
     */
    async bestAltitude(opts) {
        let best = null;
        for (const altFt of ALT_CANDIDATES_FT) {
            const plan = await this._planner.plan({ ...opts, cruiseAltFt: altFt });
            const fuel = plan.summary?.totalFuelGal ?? Infinity;
            if (!best || fuel < best.fuel) best = { altFt, fuel, plan };
        }
        return best;
    }

    /**
     * Return a flight plan optimized for least fuel.
     * @param {object} opts
     * @param {string} opts.departure
     * @param {string} opts.destination
     * @param {string} [opts.routingMode]
     * @param {number} [opts.reserveGal]
     * @param {number} [opts.maxLegHrs]
     * @param {boolean} [opts.selfServeOnly]
     * @param {Array} [opts.avoidance]
     * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
     */
    async leastFuel(opts) {
        return (await this.bestAltitude(opts)).plan;
    }

    /**
     * Return a flight plan optimized for least time.
     * @param {object} opts
     * @param {string} opts.departure
     * @param {string} opts.destination
     * @param {string} [opts.routingMode]
     * @param {number} [opts.reserveGal]
     * @param {number} [opts.maxLegHrs]
     * @param {boolean} [opts.selfServeOnly]
     * @param {Array} [opts.avoidance]
     * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
     */
    async leastTime(opts) {
        let best = null;
        for (const altFt of ALT_CANDIDATES_FT) {
            const plan = await this._planner.plan({ ...opts, cruiseAltFt: altFt });
            const time = plan.summary?.totalEteHrs ?? Infinity;
            if (!best || time < best.time) best = { altFt, time, plan };
        }
        return best.plan;
    }
}
