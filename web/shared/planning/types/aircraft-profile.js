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
 * @property {number}  [cruise_ias]             indicated airspeed at cruise power (kt)
 * @property {number}  fuel_burn_gph
 * @property {number}  fuel_capacity_gal
 * @property {number}  reserve_gal
 * @property {number}  [best_alt_ft]      optimal cruise altitude for TAS calcs (default 8000)
 * @property {number}  [climb_rate_fpm]   sea-level rate (default 700)
 * @property {number}  [service_ceiling_ft] (default 14000)
 * @property {number}  [taxi_burn_gal]    fuel burned during taxi/runup (default 1.5)
 * @property {number}  [max_hp]                 engine rated HP; enables SFC-based fuel burn
 * @property {number}  [alt_power_loss_pct_per_kft]  % power lost per 1000 ft (default 3.0)
 * @property {number}  [sfc_lop]                override LOP SFC, gal/HP/hr (default 0.067)
 * @property {number}  [sfc_rop]                override ROP SFC, gal/HP/hr (default 0.083)
 * @property {number}  [sfc_full_rich]          override full-rich SFC (default 0.093)
 * @property {AircraftEquipment} equipment
 */

export {};
