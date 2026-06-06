// @ts-check
'use strict';

import { haversine, intermediatePoint } from '../math/route-math.js';

// ---------------------------------------------------------------------------
// Static Class B data — Eastern US corridor
// ---------------------------------------------------------------------------

const CLASS_B_AIRPORTS = [
    { icao: 'KATL', name: 'Atlanta',              lat: 33.6407, lon: -84.4277, radiusNm: 40 },
    { icao: 'KCLT', name: 'Charlotte/Douglas',    lat: 35.2140, lon: -80.9431, radiusNm: 40 },
    { icao: 'KRDU', name: 'Raleigh-Durham',       lat: 35.8777, lon: -78.7875, radiusNm: 30 },
    { icao: 'KDCA', name: 'Reagan National',      lat: 38.8521, lon: -77.0377, radiusNm: 30 },
    { icao: 'KIAD', name: 'Dulles',               lat: 38.9445, lon: -77.4558, radiusNm: 35 },
    { icao: 'KBWI', name: 'Baltimore/Washington', lat: 39.1754, lon: -76.6683, radiusNm: 30 },
    { icao: 'KPHL', name: 'Philadelphia',         lat: 39.8719, lon: -75.2411, radiusNm: 35 },
    { icao: 'KEWR', name: 'Newark',               lat: 40.6895, lon: -74.1745, radiusNm: 30 },
    { icao: 'KJFK', name: 'JFK',                  lat: 40.6413, lon: -73.7781, radiusNm: 30 },
    { icao: 'KLGA', name: 'LaGuardia',            lat: 40.7773, lon: -73.8726, radiusNm: 22 },
    { icao: 'KBOS', name: 'Boston',               lat: 42.3656, lon: -71.0096, radiusNm: 30 },
];

const CLASS_B_T_ROUTES = {
    KATL: ['T228', 'T229'],
    KCLT: ['T200', 'T201', 'T202', 'T203'],
    KRDU: ['T289'],
    KDCA: [], KIAD: [], KBWI: [], KPHL: [],
    KEWR: [], KJFK: [], KLGA: [],
    KBOS: [],
};

const CLASS_B_AVOIDANCE = {
    KCLT: { label: 'East of Charlotte — LOCAS direct GSO',
            description: 'RNAV transition via LOCAS, avoids core Class B',
            fixes: ['LOCAS', 'GSO'] },
    KRDU: { label: 'South of Raleigh-Durham — direct RIC',
            description: 'Route south of the Class B via V225 or direct',
            fixes: ['RIC'] },
    KDCA: { label: 'East of DC SFRA — via ESN',
            description: 'Easton VOR (ESN), 39nm east of P-40. Standard GA routing.',
            fixes: ['RIC', 'ESN'] },
    KJFK: { label: 'Eastern Shore corridor — ESN to SBJ',
            description: 'Stay east of NYC Class B via Easton → Solberg',
            fixes: ['ESN', 'SBJ', 'PUT'] },
    KEWR: { label: 'Eastern Shore corridor — ESN to SBJ',
            description: 'Stay east of Newark Class B via Easton → Solberg',
            fixes: ['ESN', 'SBJ', 'PUT'] },
    KLGA: { label: 'Eastern Shore corridor — ESN to SBJ',
            description: 'Stay east of LaGuardia Class B via Easton → Solberg',
            fixes: ['ESN', 'SBJ', 'PUT'] },
    KPHL: { label: 'Route via SBJ south of Philadelphia',
            description: 'Solberg VOR keeps you south and east of PHL Class B',
            fixes: ['SBJ'] },
    KBWI: { label: 'Route via ESN east of Baltimore',
            description: 'Easton VOR routes you east of BWI Class B',
            fixes: ['ESN'] },
    KBOS: { label: 'Route via ORW south of Boston',
            description: 'Norwich VOR routes you south of BOS Class B',
            fixes: ['ORW', 'MHT'] },
};

// ---------------------------------------------------------------------------
// Geometry helpers (private to this module)
// ---------------------------------------------------------------------------

function gcIntersectsCircle(lat1, lon1, lat2, lon2, cLat, cLon, radiusNm) {
    for (let f = 0; f <= 1; f += 0.04) {
        const p = intermediatePoint(lat1, lon1, lat2, lon2, f);
        if (haversine(p.lat, p.lon, cLat, cLon) < radiusNm) return true;
    }
    return false;
}

function nearestFraction(lat1, lon1, lat2, lon2, fixLat, fixLon) {
    let best = 0, bestDist = Infinity;
    for (let f = 0; f <= 1; f += 0.01) {
        const p = intermediatePoint(lat1, lon1, lat2, lon2, f);
        const d = haversine(p.lat, p.lon, fixLat, fixLon);
        if (d < bestDist) { bestDist = d; best = f; }
    }
    return best;
}

function tRouteNearTerminal(waypoints, cLat, cLon, radiusNm) {
    return waypoints?.some(w => haversine(w.lat, w.lon, cLat, cLon) < radiusNm) ?? false;
}

// ---------------------------------------------------------------------------
// TerminalAnalyzer
// ---------------------------------------------------------------------------

export class TerminalAnalyzer {
    /**
     * @param {import('../adapters/aero-data-source.js').AeroDataSource} aero
     */
    constructor(aero) {
        this._aero = aero;
        /** @type {object[]|null} */
        this._airways = null;
        /** @type {Map<string,{lat:number,lon:number}>} */
        this._fixCoords = new Map();
    }

    async _ensureAirwaysLoaded() {
        if (this._airways !== null) return;
        const airways = await this._aero.listAirways();
        this._airways = airways;
        for (const awy of airways) {
            for (const w of (awy.waypoints ?? [])) {
                const id = w.name || w.id;
                if (id && w.lat != null && !this._fixCoords.has(id)) {
                    this._fixCoords.set(id, { lat: w.lat, lon: w.lon });
                }
            }
        }
    }

    /**
     * Detect Class B airspace intersections along the dep→dest great-circle.
     * @param {string} depId
     * @param {string} destId
     * @returns {Promise<{terminalAreas: object[], hasTerminalAreas: boolean}>}
     */
    async analyzeRoute(depId, destId) {
        const [dep, dest] = await Promise.all([
            this._aero.getAirport(depId),
            this._aero.getAirport(destId),
        ]);
        if (!dep)  throw new Error(`Departure ${depId} not found`);
        if (!dest) throw new Error(`Destination ${destId} not found`);

        await this._ensureAirwaysLoaded();

        const terminalAreas = [];

        for (const cb of CLASS_B_AIRPORTS) {
            if (cb.icao === depId || cb.icao === destId) continue;

            if (!gcIntersectsCircle(dep.lat, dep.lon, dest.lat, dest.lon, cb.lat, cb.lon, cb.radiusNm)) continue;

            // Only flag the Class B if the route actively approaches it — minimum route
            // distance to the Class B center must be less than both departure and destination
            // distances.  This prevents flagging CLT when departing from a satellite field
            // inside CLT's outer ring and flying AWAY from it.
            const depDist  = haversine(dep.lat,  dep.lon,  cb.lat, cb.lon);
            const destDist = haversine(dest.lat, dest.lon, cb.lat, cb.lon);
            const frac = nearestFraction(dep.lat, dep.lon, dest.lat, dest.lon, cb.lat, cb.lon);
            const gcPt = intermediatePoint(dep.lat, dep.lon, dest.lat, dest.lon, frac);
            const minDist  = haversine(gcPt.lat, gcPt.lon, cb.lat, cb.lon);
            if (minDist >= depDist || minDist >= destDist) continue;
            const distFromTrack = Math.round(minDist * 10) / 10;

            const options = this._buildOptions(cb, dep.lat, dep.lon, dest.lat, dest.lon);

            terminalAreas.push({
                icao:          cb.icao,
                name:          cb.name,
                lat:           cb.lat,
                lon:           cb.lon,
                radiusNm:      cb.radiusNm,
                distFromTrack,
                routeFraction: Math.round(frac * 100) / 100,
                options,
            });
        }

        terminalAreas.sort((a, b) => a.routeFraction - b.routeFraction);
        return { terminalAreas, hasTerminalAreas: terminalAreas.length > 0 };
    }

    _buildOptions(cb, depLat, depLon, destLat, destLon) {
        const options = [];
        const directDist = haversine(depLat, depLon, destLat, destLon);
        const airways = this._airways ?? [];

        // T-routes from static list
        const tRouteNames = CLASS_B_T_ROUTES[cb.icao] ?? [];
        for (const routeName of tRouteNames) {
            const record = airways.find(a => a.name === routeName);
            if (!record?.waypoints?.length) continue;
            if (!tRouteNearTerminal(record.waypoints, cb.lat, cb.lon, cb.radiusNm)) continue;

            const wpts       = record.waypoints;
            const entryFix   = wpts[0];
            const exitFix    = wpts[wpts.length - 1];
            const mea        = record.segments?.[0]?.mea_ft ?? null;
            const routeDist  = record.segments?.reduce((s, sg) => s + (sg.dist_nm ?? 0), 0) ?? 0;
            const entryDist  = haversine(depLat, depLon, entryFix.lat, entryFix.lon);
            const exitDist   = haversine(exitFix.lat, exitFix.lon, destLat, destLon);
            const detourNm   = Math.max(0, Math.round((entryDist + routeDist + exitDist - directDist) * 10) / 10);

            options.push({
                type:        'T_ROUTE',
                id:          routeName,
                label:       `${routeName} — through ${cb.name} Class B`,
                description: `Enter ${entryFix.name ?? entryFix.id} · exit ${exitFix.name ?? exitFix.id}`
                           + (mea ? ` · MEA ${mea.toLocaleString()}ft` : '')
                           + (detourNm > 0 ? ` · +${detourNm}nm` : ' · on track'),
                waypoints:   wpts.map(w => ({ id: w.name || w.id, lat: w.lat, lon: w.lon })),
                meaFt:       mea,
                detourNm,
                recommended: false,
            });
        }

        // Sort T-routes by detour; mark shortest as recommended
        options.sort((a, b) => a.detourNm - b.detourNm);
        if (options.length > 0) options[0].recommended = true;

        // Avoidance corridor
        const avoid = CLASS_B_AVOIDANCE[cb.icao];
        if (avoid) {
            let total = 0;
            let prev  = { lat: depLat, lon: depLon };
            const resolvedFixes = [];
            for (const fixId of avoid.fixes) {
                const c = this._fixCoords.get(fixId);
                if (c) {
                    total += haversine(prev.lat, prev.lon, c.lat, c.lon);
                    prev = c;
                    resolvedFixes.push({ id: fixId, lat: c.lat, lon: c.lon });
                }
            }
            total += haversine(prev.lat, prev.lon, destLat, destLon);
            const detourNm = Math.max(0, Math.round((total - directDist) * 10) / 10);

            options.push({
                type:        'AVOIDANCE',
                id:          `AVOID_${cb.icao}`,
                label:       avoid.label,
                description: avoid.description + (detourNm > 0 ? ` · +${detourNm}nm` : ''),
                waypoints:   resolvedFixes,
                detourNm,
                recommended: false,
            });
        }

        // ATC direct — always last, never recommended
        options.push({
            type:        'ATC_DIRECT',
            id:          `DIRECT_${cb.icao}`,
            label:       'File direct — let ATC amend',
            description: 'ATC will likely issue a preferred route on the ground. Re-check fuel and time after amendment.',
            waypoints:   [],
            detourNm:    0,
            recommended: false,
        });

        return options;
    }

    /**
     * Convert pilot selections into an ordered pin array for planVia().
     * Skips ATC_DIRECT selections. Returns null if all selections are ATC_DIRECT.
     *
     * @param {string} depId
     * @param {string} destId
     * @param {Map<string, {type:string, waypoints:Array<{id:string,lat:number,lon:number}>}>} selections
     * @returns {Promise<Array<{id:string,lat:number,lon:number}>|null>}
     */
    async resolveViaPins(depId, destId, selections) {
        const [dep, dest] = await Promise.all([
            this._aero.getAirport(depId),
            this._aero.getAirport(destId),
        ]);

        // Collect groups of waypoints from non-ATC_DIRECT selections, preserving
        // intra-group order. Each group is sorted by distance of its first fix from
        // departure so that groups from different terminal areas appear in dep→dest order.
        const groups = [];
        for (const [, option] of selections) {
            if (option.type === 'ATC_DIRECT') continue;
            const wpts = option.waypoints ?? [];
            if (wpts.length === 0) continue;
            const anchorDist = haversine(dep.lat, dep.lon, wpts[0].lat, wpts[0].lon);
            groups.push({ anchorDist, wpts });
        }

        if (groups.length === 0) return null;

        // Sort groups by distance of their first waypoint from departure
        groups.sort((a, b) => a.anchorDist - b.anchorDist);

        // Flatten groups into a single sequence
        const rawPins = groups.flatMap(g => g.wpts);

        // Deduplicate adjacent identical fix IDs
        const deduped = [rawPins[0]];
        for (let i = 1; i < rawPins.length; i++) {
            if (rawPins[i].id !== deduped[deduped.length - 1].id) {
                deduped.push(rawPins[i]);
            }
        }

        return [
            { id: depId,  lat: dep.lat,  lon: dep.lon  },
            ...deduped,
            { id: destId, lat: dest.lat, lon: dest.lon },
        ];
    }
}
