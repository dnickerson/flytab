// @ts-check
'use strict';

/**
 * @typedef Metar
 * @property {string}   station
 * @property {string}   observed_at      ISO timestamp
 * @property {boolean}  [wind_variable]
 * @property {number|null} wind_dir
 * @property {number|null} wind_speed
 * @property {number|null} [wind_gust]
 * @property {number|null} [visibility]
 * @property {number|null} [ceiling]
 * @property {number|null} [temp_c]
 * @property {number|null} [dewpoint_c]
 * @property {number|null} [altim_inHg]
 * @property {string}   [raw]
 *
 * @typedef WindAloft
 * @property {number} dir
 * @property {number} kt
 * @property {number} altFt
 *
 * @typedef Tfr
 * @property {string} id
 * @property {Array<{lat:number,lon:number}>} polygon
 * @property {number} [floorFt]
 * @property {number} [ceilingFt]
 * @property {string} [activeFrom]
 * @property {string} [activeTo]
 *
 * @typedef Sigmet
 * @property {string} id
 * @property {'convective'|'general'|'volcanic-ash'} type
 * @property {Array<{lat:number,lon:number}>} points
 * @property {string} [raw]
 *
 * @typedef Airmet
 * @property {string} id
 * @property {'TURB'|'ICING'|'IFR'|'MT_OBSC'|'FZLVL'} category
 * @property {Array<{lat:number,lon:number}>} points
 * @property {string} [raw]
 */

export {};
