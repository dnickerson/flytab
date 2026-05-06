// @ts-check
'use strict';

/**
 * @typedef AirwaySegment
 * @property {string} fromId
 * @property {string} toId
 * @property {number} distNm
 * @property {number} [meaFt]    minimum enroute altitude
 *
 * @typedef Airway
 * @property {string} id          "V143"
 * @property {'V'|'T'|'J'|'Q'} type     V=Victor (low), T=RNAV, J=Jet (high), Q=RNAV-high
 * @property {string[]} fixIds    ordered list of fix ids that make up the airway
 * @property {AirwaySegment[]} [segments]   inter-fix segments with distances
 */

export {};
