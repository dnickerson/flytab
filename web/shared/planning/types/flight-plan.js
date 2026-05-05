// @ts-check
'use strict';

/**
 * @typedef Waypoint
 * @property {string} id
 * @property {number} lat
 * @property {number} lon
 * @property {'APT'|'NAV'|'FIX'} [kind]
 * @property {number} [altFt]
 *
 * @typedef Leg
 * @property {string} from
 * @property {string} to
 * @property {number} distNm
 * @property {number} [bearingTrue]
 * @property {number} [bearingMag]
 * @property {string} [airway]            'V143' | 'DIRECT'
 * @property {'climb'|'cruise'|'descent'} [phase]
 * @property {number} [altFt]
 * @property {number} [tasKt]
 * @property {number} [gsKt]
 * @property {number} [windDir]
 * @property {number} [windKt]
 * @property {number} [rpm]
 * @property {number} [mp]
 * @property {number} [percentPwr]
 * @property {number} [timeHrs]
 * @property {number} [gphActual]
 * @property {number} [fuelGal]
 * @property {number} [fuelRemGal]
 *
 * @typedef PlanSummary
 * @property {number} totalDistNm
 * @property {number} totalEteHrs
 * @property {number} totalFuelGal
 * @property {number} fuelRemGal
 * @property {number} fixCount
 *
 * @typedef FlightPlan
 * @property {string}        [id]
 * @property {string}        departure
 * @property {string}        destination
 * @property {number}        [cruiseAltFt]
 * @property {number}        [reserveGal]
 * @property {Waypoint[]}    waypoints
 * @property {Leg[]}         [legs]
 * @property {PlanSummary}   [summary]
 * @property {{routingMode:string,maxLegHrs:number,selfServeOnly:boolean,avoidance:string[]}} [options]
 */

export {};
