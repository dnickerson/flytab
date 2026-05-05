// @ts-check
'use strict';

/**
 * @typedef AircraftEquipment
 * @property {boolean} vAirways    true when GPS / nav radios can fly V airways (almost always true)
 * @property {boolean} tAirways    true ONLY when GPS supports T (RNAV) airways. Garmin GPS 175 = false.
 * @property {boolean} jAirways    true when capable of high-altitude Jet routes
 * @property {boolean} gpsApproach RNAV approaches supported (LPV/LNAV/VNAV)
 *
 * @typedef AircraftProfile
 * @property {string}  id
 * @property {string}  tailNumber
 * @property {string}  model              e.g., "RV-9A", "Cessna 172"
 * @property {number}  cruise_ktas
 * @property {number}  fuel_burn_gph
 * @property {number}  fuel_capacity_gal
 * @property {number}  reserve_gal
 * @property {AircraftEquipment} equipment
 */

export {};
