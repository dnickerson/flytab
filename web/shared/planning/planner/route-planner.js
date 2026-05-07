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

const RV9A_FALLBACK = {
    id: 'rv9a-default',
    tailNumber: '',
    model: 'RV-9A',
    cruise_ktas: 155,
    cruise_ias: 148,       // 155 KTAS at 8000 ft ISA ≈ 148 KIAS
    fuel_burn_gph: 8.0,
    fuel_capacity_gal: 36,
    reserve_gal: 10,
    climb_rate_fpm: 750,
    service_ceiling_ft: 17500,
    taxi_burn_gal: 1.5,
    max_hp: 180,           // Lycoming O-360-A1A
    alt_power_loss_pct_per_kft: 3.0,
    equipment: { vAirways: true, tAirways: false, jAirways: false, gpsApproach: true },
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
        const AIRWAY_RE = /^[VTJQ]\d+[A-Z]?$/;
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
        return this.recomputeLegs(flightPlan, profile);
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

        for (let i = 0; i < wps.length - 1; i++) {
            const a = wps[i];
            const b = wps[i + 1];

            // Per-leg altitude: use destination waypoint altFt override, else global cruise
            const legAltFt = b.altFt ?? globalCruiseAltFt;

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
                departingFromGround: i === 0,
                endingAtGround: i === wps.length - 2,
                gsKt: gs,
                tasKt: tas,
            });

            fuelRem -= decomp.totalFuelGal;
            etaMs   += decomp.totalTimeHrs * 3_600_000;

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
