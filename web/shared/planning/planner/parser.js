// @ts-check
'use strict';

import { PlanError } from './route-planner-errors.js';

/**
 * Thrown when a waypoint identifier (airport, navaid, or fix) cannot be resolved.
 */
export class UnknownWaypointError extends PlanError {
    /**
     * @param {string} id
     */
    constructor(id) {
        super(`Unknown waypoint: ${id}`);
        this.name = 'UnknownWaypointError';
        this.waypointId = id;
    }
}

/**
 * Thrown when an airway identifier does not exist in the aero data source.
 */
export class UnknownAirwayError extends PlanError {
    /**
     * @param {string} id
     */
    constructor(id) {
        super(`Unknown airway: ${id}`);
        this.name = 'UnknownAirwayError';
        this.airwayId = id;
    }
}

/**
 * Thrown when an identifier matches multiple navaids/fixes (disambiguation needed).
 */
export class AmbiguousIdentifierError extends PlanError {
    /**
     * @param {string} id
     * @param {Array<any>} matches
     */
    constructor(id, matches) {
        super(`Ambiguous: ${id}`);
        this.name = 'AmbiguousIdentifierError';
        this.id = id;
        this.matches = matches;
    }
}

/**
 * Thrown when an airway type violates the routing mode constraint.
 */
export class RoutingModeViolationError extends PlanError {
    /**
     * @param {string} airwayId
     * @param {string} mode
     */
    constructor(airwayId, mode) {
        super(`Airway ${airwayId} not allowed under routingMode "${mode}"`);
        this.name = 'RoutingModeViolationError';
        this.airwayId = airwayId;
        this.mode = mode;
    }
}

/**
 * Regex for validating airway tokens (V/T/J/Q followed by digits, optional letter).
 * Examples: V143, T44, J500, Q2A
 */
const AIRWAY_RE = /^[VTJQ]\d+[A-Z]?$/;

/**
 * Check if a token looks like an airway identifier.
 * @param {string} tok
 * @returns {boolean}
 */
function isAirwayToken(tok) {
    return AIRWAY_RE.test(tok);
}

/**
 * Check if an airway type (V/T/J/Q) is allowed under the specified routing mode.
 * @param {string} type - Single letter: V, T, J, or Q
 * @param {string} mode - Routing mode: 'any', 'v-airways', 't-airways', 'gps-direct', 'vors-direct'
 * @returns {boolean}
 */
function airwayTypeAllowed(type, mode) {
    if (mode === 'any') return true;
    if (mode === 'v-airways') return type === 'V';
    if (mode === 't-airways') return type === 'T';
    // gps-direct and vors-direct don't allow pasted airways
    return false;
}

/**
 * Resolve a fix/navaid/airport identifier to a waypoint with coordinates.
 * Tries airport → navaid → fix in order; throws UnknownWaypointError if none found.
 *
 * @param {import('../adapters/aero-data-source.js').AeroDataSource} aero
 * @param {string} id
 * @returns {Promise<import('../types/flight-plan.js').Waypoint>}
 */
async function resolveIdentifier(aero, id) {
    const apt = await aero.getAirport(id);
    if (apt) {
        /** @type {import('../types/flight-plan.js').Waypoint} */
        const wp = { id, lat: apt.lat, lon: apt.lon, kind: 'APT' };
        return wp;
    }

    const nav = await aero.getNavaid(id);
    if (nav) {
        /** @type {import('../types/flight-plan.js').Waypoint} */
        const wp = { id, lat: nav.lat, lon: nav.lon, kind: 'NAV' };
        return wp;
    }

    const fix = await aero.getFix(id);
    if (fix) {
        /** @type {import('../types/flight-plan.js').Waypoint} */
        const wp = { id, lat: fix.lat, lon: fix.lon, kind: 'FIX' };
        return wp;
    }

    throw new UnknownWaypointError(id);
}

/**
 * Parse a route string into a fully-expanded waypoint sequence. Airway tokens
 * are replaced by the slice of their fix list lying between the prior and
 * next non-airway tokens (inclusive of those endpoints — but the endpoints
 * are added by their own resolve calls; airway expansion only contributes
 * the strictly-interior fixes).
 *
 * @param {string} str - Route string (e.g., "KLKR V143 GSO T1 K44N")
 * @param {{aero: import('../adapters/aero-data-source.js').AeroDataSource, routingMode?: string}} opts
 * @returns {Promise<{departure: string, destination: string, waypoints: import('../types/flight-plan.js').Waypoint[]}>}
 */
export async function parseRouteString(str, opts) {
    /** @type {{aero: import('../adapters/aero-data-source.js').AeroDataSource, routingMode?: string}} */
    const safeOpts = opts;
    const aero = opts.aero;
    const mode = opts.routingMode || 'any';

    // Tokenize the input
    const tokens = str.trim().split(/\s+/).filter(Boolean).map(t => t.toUpperCase());

    if (tokens.length < 2) {
        throw new PlanError('Need at least 2 tokens (departure + destination)');
    }

    /** @type {import('../types/flight-plan.js').Waypoint[]} */
    const waypoints = [];
    let i = 0;

    while (i < tokens.length) {
        const tok = tokens[i];

        if (isAirwayToken(tok)) {
            // Look up the airway
            const airway = await aero.getAirway(tok);
            if (!airway) {
                throw new UnknownAirwayError(tok);
            }

            // Check routing mode constraint
            if (!airwayTypeAllowed(airway.type, mode)) {
                throw new RoutingModeViolationError(tok, mode);
            }

            // Need entry (= last waypoint added) and exit (= next non-airway token)
            const entry = waypoints[waypoints.length - 1];
            if (!entry) {
                throw new PlanError(`Airway ${tok} cannot be the first token`);
            }

            const exitTok = tokens[i + 1];
            if (!exitTok || isAirwayToken(exitTok)) {
                throw new PlanError(`Airway ${tok} must be followed by a fix token`);
            }

            // Find entry and exit indices in the airway's fix list
            const entryIdx = airway.fixIds.indexOf(entry.id);
            const exitIdx = airway.fixIds.indexOf(exitTok);

            if (entryIdx < 0) {
                throw new PlanError(`Entry fix ${entry.id} not on airway ${tok}`);
            }
            if (exitIdx < 0) {
                throw new PlanError(`Exit fix ${exitTok} not on airway ${tok}`);
            }

            // Walk the airway from entryIdx → exitIdx (forward or reverse) and add interior fixes.
            // Tag each interior fix with the airway it came from.
            const step = exitIdx > entryIdx ? 1 : -1;
            for (let k = entryIdx + step; k !== exitIdx; k += step) {
                const interior = await resolveIdentifier(aero, airway.fixIds[k]);
                interior.airway = airway.id;
                waypoints.push(interior);
            }

            // Don't advance past the airway token — let the next iteration consume the exit token
            i++;
            continue;
        }

        // Non-airway token: resolve it as a waypoint
        const wp = await resolveIdentifier(aero, tok);
        waypoints.push(wp);
        i++;
    }

    if (waypoints.length < 2) {
        throw new PlanError('Parsed route has fewer than 2 waypoints');
    }

    return {
        departure: waypoints[0].id,
        destination: waypoints[waypoints.length - 1].id,
        waypoints,
    };
}
