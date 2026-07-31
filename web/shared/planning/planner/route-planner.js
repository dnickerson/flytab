// @ts-check
'use strict';

import { AirwayGraph } from './airway-graph.js';
import { parseRouteString } from './parser.js';
import { buildAvoidancePenalty } from './avoidance.js';
import { haversine, bearing, crossTrackDistanceNm, iasToTas, groundSpeed, vfrAltitude } from '../math/route-math.js';
import { decomposeLeg } from '../math/fuel-phases.js';
import { tasAtAltitude } from '../math/engine-data.js';
import { findNearestFdStation, getWindAtAlt } from './winds-interpolator.js';
import { PlanError, DestinationUnreachableError } from './route-planner-errors.js';

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
 */

const AIRWAY_RE = /^[VTJQ]\d+[A-Z]?$/;

/**
 * Last-resort profile, used only when no `profiles` adapter is wired up at all
 * (or when a caller passes no `profileOverride` to recomputeLegs()).
 *
 * This is deliberately a plain literal, not a config read: the planning library
 * is host-environment-agnostic and must not reach for `CockpitConfig` (a
 * classic-script global owned by the cockpit app). Per-aircraft data enters the
 * library through the `ProfileStore` adapter — see
 * `web/shared/planning-adapters/idb-profile.js`.
 *
 * KEEP IN SYNC, BY HAND, with `RV9A_DEFAULT` in `planning-adapters/idb-profile.js`
 * and with `web/aircraft-config.json` `performance.*`. There is no automatic
 * config→profile sync today (verified 2026-07-31). Fuel figures are measured,
 * not book values — cruise 8.1 gph is the `power_settings[]` band nearest
 * `cruise_pwr_pct` (65), climb 15 / descent 6.9 gph are the p85 of EDM fuel flow
 * across 53 `ml_phase`-labelled flight logs. p85 rather than median is
 * deliberate: under-estimating burn over-states fuel remaining.
 */
const RV9A_FALLBACK = {
    id: 'rv9a-default',
    tailNumber: '',
    model: 'RV-9A',
    cruise_ktas: 153,
    cruise_ias: 140,
    fuel_burn_gph: 8.1,
    fuel_capacity_gal: 36,
    reserve_gal: 10,       // must match aircraft-config.json performance.reserve_gal
    climb_rate_fpm: 1500,
    service_ceiling_ft: 17500,
    taxi_burn_gal: 0.33,
    max_hp: 180,           // Lycoming O-360-A1A
    alt_power_loss_pct_per_kft: 3.0,
    equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
    fuelPhases: {
        climb:   { gph: 15,  ias_kt: 120, rate_fpm: 1500, percent_power: 100,
                   mixture: 'FULL_RICH', rpm: 2700, mp: 28 },
        cruise:  { gph: 8.1, ias_kt: 140, percent_power: 65,
                   mixture: 'LOP', rpm: 2400, mp: 22 },
        // 6.9 = measured p85, NOT the old 4.0 book guess. 4.0 under-planned
        // descent burn by ~2.9 gph and therefore over-stated fuel remaining.
        descent: { gph: 6.9, ias_kt: 170, rate_fpm: 700, percent_power: 50,
                   mixture: 'LOP', rpm: 2400, mp: 14 },
    },
};

export class RoutePlanner {
    /**
     * @param {Adapters} adapters
     */
    constructor(adapters) {
        if (!adapters?.aero) throw new PlanError('aero adapter required');
        if (!adapters?.plans) throw new PlanError('plans adapter required');
        this._adapters = adapters;
        /** @type {Map<string, AirwayGraph>} */
        this._graphCache = new Map();
    }

    /**
     * Plan a route from departure to destination.
     * @param {object} opts
     * @param {string} opts.departure
     * @param {string} opts.destination
     * @param {string} [opts.routingMode]
     * @param {number} [opts.cruiseAltFt]
     * @param {number} [opts.reserveGal]
     * @param {number} [opts.maxLegHrs]
     * @param {boolean} [opts.selfServeOnly]
     * @param {Array<string|{id:string,polygon?:any,fixIds?:string[]}>} [opts.avoidance]
     * @param {Record<string,Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>>} [opts.winds]
     * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
     */
    async plan(opts) {
        const profile = (await this._adapters.profiles.getActive?.()) || RV9A_FALLBACK;
        const routingModeOrNull = opts.routingMode
            || (profile.equipment?.tAirways ? 'any' : 'v-airways');
        // Type assertion: we know this is always a valid RoutingMode
        const routingMode = /** @type {import('./airway-graph.js').RoutingMode} */ (routingModeOrNull);

        const dep = await this._adapters.aero.getAirport(opts.departure);
        const dest = await this._adapters.aero.getAirport(opts.destination);
        if (!dep) throw new PlanError(`Unknown departure: ${opts.departure}`);
        if (!dest) throw new PlanError(`Unknown destination: ${opts.destination}`);

        const graph = await this._getGraph(routingMode);
        graph.clearDirectEdges();

        // Fan out from DEP and DEST onto the airway network so A* has entry
        // points. Fan-out edges are DIRECT-typed and clearDirectEdges() removes
        // them on the next plan() call.
        const FANOUT_MAX_NM = 60;
        const FANOUT_LIMIT  = 5;
        for (const f of graph.nearestFixes(dep.lat, dep.lon, FANOUT_MAX_NM, FANOUT_LIMIT)) {
            const c = graph.coords[f.id];
            graph.addDirectEdge(dep.icao, dep.lat, dep.lon, f.id, c.lat, c.lon);
        }
        for (const f of graph.nearestFixes(dest.lat, dest.lon, FANOUT_MAX_NM, FANOUT_LIMIT)) {
            const c = graph.coords[f.id];
            graph.addDirectEdge(dest.icao, dest.lat, dest.lon, f.id, c.lat, c.lon);
        }

        // For direct-only modes (gps-direct / vors-direct) the airway graph is
        // empty, so fan-out adds nothing — we need an explicit DEP→DEST direct
        // edge or A* has no path at all.
        const directOnly = routingMode === 'gps-direct' || routingMode === 'vors-direct';
        if (directOnly) {
            graph.addDirectEdge(dep.icao, dep.lat, dep.lon, dest.icao, dest.lat, dest.lon);
        }

        // Normalize avoidance: accept both string[] and {id:string}[]
        // Airway IDs (V/T/J/Q + digits) go into the hard-exclusion set; everything
        // else is treated as a fix ID to skip during A* neighbour expansion.
        const avoidanceConstraints = [];
        const excludeFixIds   = new Set();
        const excludeAirways  = new Set();
        for (const a of (opts.avoidance || [])) {
            const id = typeof a === 'string' ? a : a.id;
            if (typeof a !== 'string' && a.polygon?.length) {
                avoidanceConstraints.push(/** @type {import('./avoidance.js').AvoidanceConstraint} */ (a));
            } else if (AIRWAY_RE.test(id)) {
                excludeAirways.add(id);
            } else {
                excludeFixIds.add(id);
            }
        }
        const penalty = buildAvoidancePenalty(avoidanceConstraints);
        const excl = { excludeFixIds, excludeAirways };
        // Try a tight corridor first; if no path, widen; if still nothing,
        // fall back to a single DEP→DEST direct edge.
        let path = this._aStar(graph, dep.icao, dest.icao, penalty, excl);
        if (!path && !directOnly) {
            path = this._aStar(graph, dep.icao, dest.icao, penalty, { corridorNm: 300, ...excl });
        }
        if (!path && !directOnly) {
            graph.addDirectEdge(dep.icao, dep.lat, dep.lon, dest.icao, dest.lat, dest.lon);
            path = this._aStar(graph, dep.icao, dest.icao, penalty, { corridorNm: Infinity, ...excl });
        }
        if (!path) throw new DestinationUnreachableError(`No route from ${opts.departure} to ${opts.destination}`);

        const waypoints = path.map(({ id, airway }) => {
            const c = graph.coords[id];
            return { id, lat: c.lat, lon: c.lon, ...(airway ? { airway } : {}) };
        });

        const flightPlan = {
            departure: opts.departure,
            destination: opts.destination,
            cruiseAltFt: opts.cruiseAltFt ?? 6000,
            reserveGal: opts.reserveGal ?? profile.reserve_gal ?? 10,
            waypoints,
            options: {
                routingMode,
                maxLegHrs: opts.maxLegHrs ?? 2.0,
                selfServeOnly: !!opts.selfServeOnly,
                avoidance: (opts.avoidance || []).map(a => typeof a === 'string' ? a : a.id),
            },
        };
        // Pass winds so _insertFuelStops sees wind-corrected ETE. Without this,
        // the fuel stop check uses calm-air time and misses routes that only
        // exceed the leg limit due to headwinds.
        const computed = this.recomputeLegs(flightPlan, profile, { winds: opts.winds });
        return this._insertFuelStops(computed, profile);
    }

    /**
     * Plan a route through an ordered sequence of required waypoints (pins).
     * Runs A* for each consecutive pin pair and merges the sub-paths.
     *
     * @param {Array<{id:string, lat:number, lon:number}>} pins
     *   Ordered waypoints — first is departure, last is destination.
     *   All must be pre-resolved (caller supplies lat/lon).
     * @param {object} [opts]  Same options as plan() except departure/destination.
     * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
     */
    async planVia(pins, opts = {}) {
        if (!pins || pins.length < 2) throw new PlanError('planVia requires at least 2 pins');

        const profile = (await this._adapters.profiles.getActive?.()) || RV9A_FALLBACK;
        const routingModeOrNull = opts.routingMode
            || (profile.equipment?.tAirways ? 'any' : 'v-airways');
        const routingMode = /** @type {import('./airway-graph.js').RoutingMode} */ (routingModeOrNull);

        const graph = await this._getGraph(routingMode);

        const excludeFixIds  = new Set();
        const excludeAirways = new Set();
        const avoidanceConstraints = [];
        for (const a of (opts.avoidance || [])) {
            const id = typeof a === 'string' ? a : a.id;
            if (typeof a !== 'string' && a.polygon?.length) {
                avoidanceConstraints.push(/** @type {import('./avoidance.js').AvoidanceConstraint} */ (a));
            } else if (AIRWAY_RE.test(id)) {
                excludeAirways.add(id);
            } else {
                excludeFixIds.add(id);
            }
        }
        const penalty = buildAvoidancePenalty(avoidanceConstraints);
        const excl = { excludeFixIds, excludeAirways };

        /** @type {Array<{id:string, lat:number, lon:number, airway?:string}>} */
        const mergedWaypoints = [];

        for (let i = 0; i < pins.length - 1; i++) {
            const a = pins[i];
            const b = pins[i + 1];

            graph.clearDirectEdges();

            // Inject pin coordinates so A* can start/end at non-airway points
            graph.coords[a.id] = graph.coords[a.id] || { lat: a.lat, lon: a.lon };
            graph.coords[b.id] = graph.coords[b.id] || { lat: b.lat, lon: b.lon };

            // Fan out from both pin endpoints onto the airway network
            for (const f of graph.nearestFixes(a.lat, a.lon, 60, 5)) {
                const c = graph.coords[f.id];
                graph.addDirectEdge(a.id, a.lat, a.lon, f.id, c.lat, c.lon);
            }
            for (const f of graph.nearestFixes(b.lat, b.lon, 60, 5)) {
                const c = graph.coords[f.id];
                graph.addDirectEdge(b.id, b.lat, b.lon, f.id, c.lat, c.lon);
            }

            // For direct-only modes the airway graph is empty — add an explicit
            // a→b direct edge or A* has no path.
            const directOnly = routingMode === 'gps-direct' || routingMode === 'vors-direct';
            if (directOnly) {
                graph.addDirectEdge(a.id, a.lat, a.lon, b.id, b.lat, b.lon);
            }

            let subPath = this._aStar(graph, a.id, b.id, penalty, excl);
            if (!subPath) {
                subPath = this._aStar(graph, a.id, b.id, penalty, { corridorNm: 300, ...excl });
            }
            if (!subPath) {
                subPath = this._aStar(graph, a.id, b.id, penalty, { corridorNm: Infinity, ...excl });
            }

            if (!subPath) {
                graph.clearDirectEdges();
                throw new DestinationUnreachableError(`No route from ${a.id} to ${b.id}`);
            }

            // Append segment — skip first node on i>0 to dedup the shared junction
            const startIdx = i === 0 ? 0 : 1;
            for (let j = startIdx; j < subPath.length; j++) {
                const node = subPath[j];
                const c = graph.coords[node.id];
                if (!c) continue;   // should never happen — coords injected above
                mergedWaypoints.push({
                    id:  node.id,
                    lat: c.lat,
                    lon: c.lon,
                    ...(node.airway ? { airway: node.airway } : {}),
                });
            }
        }

        graph.clearDirectEdges();

        const flightPlan = {
            departure:   pins[0].id,
            destination: pins[pins.length - 1].id,
            cruiseAltFt: opts.cruiseAltFt ?? 6000,
            reserveGal:  opts.reserveGal ?? profile.reserve_gal ?? 10,
            waypoints:   mergedWaypoints,
            options: {
                routingMode,
                maxLegHrs:    opts.maxLegHrs    ?? 2.0,
                selfServeOnly: !!opts.selfServeOnly,
                avoidance: (opts.avoidance || []).map(a => typeof a === 'string' ? a : a.id),
            },
        };

        const computed = this.recomputeLegs(flightPlan, profile, { winds: opts.winds });
        return this._insertFuelStops(computed, profile);
    }

    /**
     * Parse a route string. Returns a fully-expanded plan with all interior
     * airway fixes resolved.
     * @param {string} str
     * @param {object} [opts]
     * @param {string} [opts.routingMode]
     * @param {number} [opts.cruiseAltFt]
     * @param {number} [opts.reserveGal]
     * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
     */
    async parseRoute(str, opts = {}) {
        const profile = (await this._adapters.profiles.getActive?.()) || RV9A_FALLBACK;
        const routingModeOrNull = opts.routingMode
            || (profile.equipment?.tAirways ? 'any' : 'v-airways');
        // Type assertion: we know this is always a valid RoutingMode
        const routingMode = /** @type {import('./airway-graph.js').RoutingMode} */ (routingModeOrNull);
        const parsed = await parseRouteString(str, { aero: this._adapters.aero, routingMode });
        return this.recomputeLegs({
            departure: parsed.departure,
            destination: parsed.destination,
            cruiseAltFt: opts.cruiseAltFt ?? 6000,
            reserveGal: opts.reserveGal ?? profile.reserve_gal ?? 10,
            waypoints: parsed.waypoints,
            options: { routingMode, maxLegHrs: 2.0, selfServeOnly: false, avoidance: [] },
        }, profile);
    }

    /**
     * Recompute leg-level data without re-running A*.
     * @param {import('../types/flight-plan.js').FlightPlan} plan
     * @param {import('../types/aircraft-profile.js').AircraftProfile} [profileOverride]
     * @param {object} [opts]
     * @param {Date}   [opts.departureTime]    defaults to now
     * @param {number} [opts.pctPower]         cruise power percentage (default 65)
     * @param {number} [opts.cruiseAltFt]      override plan.cruiseAltFt
     * @param {Record<string,Record<number,{dir:number,spd:number,temp?:number,variable?:boolean}>>} [opts.winds]
     * @param {Record<string,[number,number]>} [opts.fdLocs]  FD station coords override (for testing)
     * @returns {import('../types/flight-plan.js').FlightPlan}
     */
    recomputeLegs(plan, profileOverride, opts = {}) {
        const profile = profileOverride || RV9A_FALLBACK;
        const wps = plan.waypoints;
        const legs = [];
        let fuelRem = profile.fuel_capacity_gal;
        const pctPower = (opts.pctPower ?? 65) / 100;
        let etaMs = (opts.departureTime instanceof Date ? opts.departureTime.getTime() : Date.now());

        // Resolve cruise altitude: opts override → plan field → VFR auto-select
        const dep  = wps[0];
        const dest = wps[wps.length - 1];
        let globalCruiseAltFt = opts.cruiseAltFt ?? plan.cruiseAltFt;
        if (!globalCruiseAltFt && dep && dest) {
            const magCourse = bearing(dep.lat, dep.lon, dest.lat, dest.lon);
            globalCruiseAltFt = vfrAltitude(magCourse, dep, dest);
        }
        globalCruiseAltFt = globalCruiseAltFt ?? 6000;
        let lastAltFt = globalCruiseAltFt;

        for (let i = 0; i < wps.length - 1; i++) {
            const a = wps[i];
            const b = wps[i + 1];

            // Per-leg altitude: use destination altFt if set, else carry forward the last
            // explicitly-set altitude (step-down/step-up persists until next override).
            const legAltFt = b.altFt ?? lastAltFt;
            lastAltFt = legAltFt;

            const distNm = haversine(a.lat, a.lon, b.lat, b.lon);
            const brgTrue = bearing(a.lat, a.lon, b.lat, b.lon);

            // Wind at leg midpoint
            let windDir = null, windSpd = null, oatC = null;
            if (opts.winds) {
                const midLat = (a.lat + b.lat) / 2;
                const midLon = (a.lon + b.lon) / 2;
                const station = findNearestFdStation(opts.winds, midLat, midLon, opts.fdLocs);
                const windEntry = station ? getWindAtAlt(opts.winds[station], legAltFt) : null;
                if (windEntry && !windEntry.variable) {
                    windDir = windEntry.dir;
                    windSpd = windEntry.spd;
                    oatC    = windEntry.temp ?? null;
                }
            }

            // TAS: use ISA model if cruise_ias available, else empirical tasAtAltitude
            const tas = profile.cruise_ias
                ? iasToTas(profile.cruise_ias, legAltFt, oatC)
                : tasAtAltitude(profile, legAltFt);

            // GS: wind-corrected or flat TAS
            const gs = (windDir !== null && windSpd !== null)
                ? groundSpeed(tas, brgTrue, windDir, windSpd)
                : tas;

            const decomp = decomposeLeg(profile, {
                distNm,
                altFt: legAltFt,
                departingFromGround: i === 0 || !!a.fuelStop,
                endingAtGround: i === wps.length - 2 || !!b.fuelStop,
                gsKt: gs,
                tasKt: tas,
                powerFrac: pctPower,
            });

            fuelRem -= decomp.totalFuelGal;
            etaMs   += decomp.totalTimeHrs * 3_600_000;

            // Build CLB/CRZ/DES segments so route-table can display per-phase rows
            const fp = profile.fuelPhases;
            const legSegs = [];
            const wdDir = windDir ?? 0;
            const wdSpd = windSpd ?? 0;
            if (decomp.phases.climb.timeHrs > 0) {
                const clbTas = fp?.climb?.ias_kt
                    ? iasToTas(fp.climb.ias_kt, legAltFt / 2, oatC)
                    : tas * 0.87;
                const clbGs = wdDir || wdSpd ? groundSpeed(clbTas, brgTrue, wdDir, wdSpd) : clbTas;
                const clbGph = decomp.phases.climb.timeHrs > 0
                    ? decomp.phases.climb.fuelGal / decomp.phases.climb.timeHrs : 0;
                legSegs.push({ phase: 'CLB', altFrom: 0, altTo: legAltFt,
                    dist: parseFloat(decomp.phases.climb.distNm.toFixed(1)),
                    tas: Math.round(clbTas), gs: Math.round(clbGs),
                    ete_min: decomp.phases.climb.timeHrs * 60,
                    gph: parseFloat(clbGph.toFixed(1)),
                    rpm: fp?.climb?.rpm, mp: fp?.climb?.mp,
                    percent_power: fp?.climb?.percent_power });
            }
            if (decomp.phases.cruise.timeHrs > 0) {
                const crzGph = decomp.phases.cruise.fuelGal / decomp.phases.cruise.timeHrs;
                legSegs.push({ phase: 'CRZ', altFrom: legAltFt, altTo: legAltFt,
                    dist: parseFloat(decomp.phases.cruise.distNm.toFixed(1)),
                    tas: Math.round(tas), gs: Math.round(gs),
                    ete_min: decomp.phases.cruise.timeHrs * 60,
                    gph: parseFloat(crzGph.toFixed(1)),
                    rpm: fp?.cruise?.rpm, mp: fp?.cruise?.mp,
                    percent_power: fp?.cruise?.percent_power ?? Math.round(pctPower * 100) });
            }
            if (decomp.phases.descent.timeHrs > 0) {
                const desTas = fp?.descent?.ias_kt
                    ? iasToTas(fp.descent.ias_kt, legAltFt / 2, oatC)
                    : tas * 0.95;
                const desGs = wdDir || wdSpd ? groundSpeed(desTas, brgTrue, wdDir, wdSpd) : desTas;
                const desGph = decomp.phases.descent.fuelGal / decomp.phases.descent.timeHrs;
                legSegs.push({ phase: 'DES', altFrom: legAltFt, altTo: 0,
                    dist: parseFloat(decomp.phases.descent.distNm.toFixed(1)),
                    tas: Math.round(desTas), gs: Math.round(desGs),
                    ete_min: decomp.phases.descent.timeHrs * 60,
                    gph: parseFloat(desGph.toFixed(1)),
                    rpm: fp?.descent?.rpm, mp: fp?.descent?.mp,
                    percent_power: fp?.descent?.percent_power });
            }

            legs.push({
                from: a.id,
                to:   b.id,
                distNm,
                bearingTrue: brgTrue,
                altFt:       legAltFt,
                tasKt:       Math.round(tas),
                gsKt:        Math.round(gs),
                windDir:     windDir ?? undefined,
                windSpd:     windSpd ?? undefined,
                windKt:      (windDir !== null && windSpd !== null)
                             ? Math.round(gs - tas)
                             : undefined,
                percentPwr:  Math.round(pctPower * 100),
                timeHrs:     decomp.totalTimeHrs,
                fuelGal:     decomp.totalFuelGal,
                fuelRemGal:  fuelRem,
                eta:         etaMs,
                airway:      b.airway || 'DIRECT',
                segments:    legSegs,
            });
        }

        const summary = {
            totalDistNm:  legs.reduce((s, l) => s + l.distNm, 0),
            totalEteHrs:  legs.reduce((s, l) => s + l.timeHrs, 0),
            totalFuelGal: legs.reduce((s, l) => s + l.fuelGal, 0),
            fuelRemGal:   fuelRem,
            fixCount:     wps.length,
        };
        return { ...plan, legs, summary };
    }

    /**
     * Post-process a computed plan to insert fuel-stop airports where the
     * cumulative leg time would exceed plan.options.maxLegHrs.
     * @param {import('../types/flight-plan.js').FlightPlan} plan
     * @param {import('../types/aircraft-profile.js').AircraftProfile} profile
     * @returns {Promise<import('../types/flight-plan.js').FlightPlan>}
     * @private
     */
    async _insertFuelStops(plan, profile) {
        const maxLegHrs = plan.options?.maxLegHrs;
        if (!maxLegHrs || maxLegHrs >= 10 || !plan.legs?.length) {
            return { ...plan, fuelStops: [], fuelStopCandidates: [] };
        }

        // No stops needed if total route time fits within one leg
        if ((plan.summary?.totalEteHrs ?? 0) <= maxLegHrs) {
            return { ...plan, fuelStops: [], fuelStopCandidates: [] };
        }

        const selfServeOnly = !!plan.options?.selfServeOnly;
        const fuelStopCandidates = [];
        let cumHrs = 0;

        for (let i = 0; i < plan.legs.length; i++) {
            const leg = plan.legs[i];
            const isLast = i === plan.legs.length - 1;
            const fromWp = plan.waypoints[i];
            const toWp   = plan.waypoints[i + 1];

            // Fire when this leg would push cumulative time past maxLegHrs.
            // Works for GPS Direct (single leg) and multi-leg routes.
            // Interpolate the stop position along the leg so we search near where
            // the pilot would actually need to land, not at the leg start waypoint.
            // Note: !isLast guard removed — GPS Direct has only one leg which IS
            // the last, but still needs a stop if it exceeds maxLegHrs.
            if (cumHrs + leg.timeHrs > maxLegHrs) {
                const hoursIntoLeg = Math.max(0, maxLegHrs - cumHrs);
                const fraction = leg.timeHrs > 0
                    ? Math.min(hoursIntoLeg / leg.timeHrs, 0.85) : 0.5;
                const stopLat = fromWp.lat + (toWp.lat - fromWp.lat) * fraction;
                const stopLon = fromWp.lon + (toWp.lon - fromWp.lon) * fraction;

                const nearby = (await this._adapters.aero.nearestAirports?.(stopLat, stopLon, 40)) || [];
                const options = nearby
                    .filter(a =>
                        a.hasFuel &&
                        (!selfServeOnly || a.hasSelfServeFuel) &&
                        a.icao !== plan.departure &&
                        a.icao !== plan.destination &&
                        a.icao !== fromWp.id
                    )
                    .map(a => ({
                        icao: a.icao,
                        name: a.name || a.icao,
                        lat: a.lat,
                        lon: a.lon,
                        hasSelfServeFuel: !!a.hasSelfServeFuel,
                        distNm: Math.round(haversine(stopLat, stopLon, a.lat, a.lon) * 10) / 10,
                    }))
                    .sort((x, y) => x.distNm - y.distNm)
                    .slice(0, 6);

                if (options.length > 0) {
                    fuelStopCandidates.push({
                        afterFixId: fromWp.id,
                        cumHrsAtStop: Math.round((cumHrs + hoursIntoLeg) * 100) / 100,
                        options,
                    });
                    // Remaining time on this leg continues accumulating toward next stop
                    cumHrs = leg.timeHrs - hoursIntoLeg;
                    continue;
                }
            }

            cumHrs += leg.timeHrs;
        }

        return { ...plan, fuelStops: [], fuelStopCandidates };
    }

    /**
     * Check whether fuel stops are required for a pre-computed plan.
     * Callers pass the result of recomputeLegs() with plan.options.maxLegHrs set.
     * @param {object} plan
     * @returns {Promise<object>} plan with fuelStopCandidates array
     */
    async insertFuelStops(plan) {
        return this._insertFuelStops(plan, null);
    }

    /**
     * Get or create the AirwayGraph for a routing mode.
     * @param {string} mode
     * @returns {Promise<AirwayGraph>}
     * @private
     */
    async _getGraph(mode) {
        const cached = this._graphCache.get(mode);
        if (cached) return cached;
        const g = new AirwayGraph(this._adapters.aero, { routingMode: /** @type {import('./airway-graph.js').RoutingMode} */ (mode) });
        await g.load();
        this._graphCache.set(mode, g);
        return g;
    }

    /**
     * Standard A* with cost = base distance + avoidance penalty.
     * @param {AirwayGraph} graph
     * @param {string} startId
     * @param {string} goalId
     * @param {(edge:{from:{lat:number,lon:number},to:{lat:number,lon:number}})=>number} penaltyFn
     * @returns {Array<{id:string, airway:(string|null)}> | null}
     * @private
     */
    _aStar(graph, startId, goalId, penaltyFn, opts = {}) {
        const start = graph.coords[startId];
        const goal  = graph.coords[goalId];
        if (!start || !goal) return null;

        // Hard-exclusion sets injected by plan() from the avoidance list.
        const excludeFixIds  = opts.excludeFixIds  || null;
        const excludeAirways = opts.excludeAirways || null;

        // Corridor prune: skip nodes whose perpendicular distance from the
        // dep→dest great-circle exceeds CORRIDOR_NM. Without this, A* on a
        // 5000-node airway graph wanders into far-off-track VOR junctions
        // (e.g. routing KLKR→KMIA via HPW in central Virginia).
        const CORRIDOR_NM = opts.corridorNm ?? 150;
        // Greedy bias on the heuristic — slightly inadmissible but explores
        // far fewer nodes. Set to 1.0 for exact A*.
        const HEURISTIC_BIAS = opts.heuristicBias ?? 1.15;

        const open = new Map();      // id → fScore
        /** @type {Map<string, {prev:string, airway:string}>} */
        const cameFrom = new Map();
        const gScore = new Map();
        gScore.set(startId, 0);

        /** @param {string} id @returns {number} */
        const h = (id) => {
            const c = graph.coords[id];
            return c ? haversine(c.lat, c.lon, goal.lat, goal.lon) * HEURISTIC_BIAS : Infinity;
        };

        /** @param {string} id @returns {boolean} */
        const inCorridor = (id) => {
            if (id === startId || id === goalId) return true;
            const c = graph.coords[id];
            if (!c) return false;
            const xt = Math.abs(crossTrackDistanceNm(start.lat, start.lon, goal.lat, goal.lon, c.lat, c.lon));
            return xt <= CORRIDOR_NM;
        };

        open.set(startId, h(startId));

        while (open.size) {
            // Pick lowest f-score
            let cur = null;
            let best = Infinity;
            for (const [id, f] of open) if (f < best) { best = f; cur = id; }
            if (cur === goalId) return this._reconstruct(cameFrom, cur);
            open.delete(cur);

            const curCoord = graph.coords[cur];
            for (const e of graph.edges(cur)) {
                const next = e.toId;
                if (!inCorridor(next)) continue;
                if (excludeFixIds?.has(next))   continue;   // avoid this fix node
                if (excludeAirways?.has(e.airway)) continue; // avoid this airway
                const nextCoord = graph.coords[next];
                if (!curCoord || !nextCoord) continue;
                const pen = penaltyFn({ from: curCoord, to: nextCoord });
                if (pen === Infinity) continue;
                const tentative = (gScore.get(cur) ?? Infinity) + e.distNm + pen;
                if (tentative < (gScore.get(next) ?? Infinity)) {
                    cameFrom.set(next, { prev: cur, airway: e.airway });
                    gScore.set(next, tentative);
                    open.set(next, tentative + h(next));
                }
            }
        }
        return null;
    }

    /**
     * Reconstruct the path from start to end. Each entry carries the airway
     * used to REACH that node from its predecessor. The first node's airway
     * is null (it's the departure).
     * @param {Map<string, {prev:string, airway:string}>} cameFrom
     * @param {string} end
     * @returns {Array<{id:string, airway:(string|null)}>}
     * @private
     */
    _reconstruct(cameFrom, end) {
        /** @type {Array<{id:string, airway:(string|null)}>} */
        const path = [{ id: end, airway: null }];
        while (cameFrom.has(path[0].id)) {
            const link = cameFrom.get(path[0].id);
            if (!link) break;
            // Airway used to reach this node — attach to the current head.
            path[0].airway = link.airway;
            path.unshift({ id: link.prev, airway: null });
        }
        return path;
    }
}
