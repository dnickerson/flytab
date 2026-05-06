// @ts-check
'use strict';

import { haversine } from '../math/route-math.js';

/**
 * @typedef {import('../adapters/aero-data-source.js').AeroDataSource} AeroDataSource
 * @typedef {'gps-direct'|'vors-direct'|'v-airways'|'t-airways'|'any'} RoutingMode
 *
 * @typedef Edge
 * @property {string} toId
 * @property {number} distNm
 * @property {number} [meaFt]
 * @property {string} airway     'V143' | 'T-airway-id' | 'DIRECT'
 */

const TYPES_BY_MODE = {
    'any':         null,             // null = no filter
    'v-airways':   new Set(['V']),
    't-airways':   new Set(['T']),
    'gps-direct':  new Set(),        // empty = no airway edges
    'vors-direct': new Set(),
};

/**
 * Airway graph for A* routing.
 *
 * Loads airways from an AeroDataSource, filtering by routingMode so only
 * permitted airway types contribute edges. Supports five routing modes:
 * - 'any'        — all airway types (V, T, J, Q)
 * - 'v-airways'  — Victor (low-altitude) only
 * - 't-airways'  — RNAV only
 * - 'gps-direct' — no airways (direct-only planning)
 * - 'vors-direct'— no airways (VORs as anchor points, not airway hops)
 */
export class AirwayGraph {
    /**
     * @param {AeroDataSource} aero
     * @param {{routingMode?: RoutingMode}} [opts]
     */
    constructor(aero, opts = {}) {
        this._aero        = aero;
        this._routingMode = opts.routingMode || 'any';
        /** @type {Record<string, {lat:number,lon:number}>} */
        this.coords = {};
        /** @type {Record<string, Edge[]>} */
        this._adj = {};
        this._loaded = false;
    }

    /** Build the adjacency from the configured AeroDataSource. */
    async load() {
        if (this._loaded) return;
        const allowed = TYPES_BY_MODE[this._routingMode];

        // GPS-Direct / VORs-Direct: skip the airway list entirely; coords come
        // from per-fix lookups during plan().
        if (allowed && allowed.size === 0) {
            this._loaded = true;
            return;
        }

        const airways = await this._aero.listAirways();
        for (const a of airways) {
            if (allowed && !allowed.has(a.type)) continue;
            const ids = a.fixIds || [];
            // Inline waypoint coords from the airway record itself (faster, and
            // necessary for fix waypoints not stored in the fixes/navaids IDB
            // stores). Falls back to per-fix adapter lookups when absent.
            const inline = {};
            for (const w of (a.waypoints || [])) {
                if (w.id && Number.isFinite(w.lat) && Number.isFinite(w.lon)) {
                    inline[w.id] = { id: w.id, lat: w.lat, lon: w.lon };
                }
            }
            const lookup = async (id) =>
                inline[id]
                || await this._aero.getFix(id)
                || await this._aero.getNavaid(id);

            for (let i = 0; i < ids.length - 1; i++) {
                const fa = await lookup(ids[i]);
                const fb = await lookup(ids[i + 1]);
                if (!fa || !fb) continue;
                this.coords[fa.id] = { lat: fa.lat, lon: fa.lon };
                this.coords[fb.id] = { lat: fb.lat, lon: fb.lon };
                const d = haversine(fa.lat, fa.lon, fb.lat, fb.lon);
                this._addEdge(fa.id, { toId: fb.id, distNm: d, airway: a.id });
                this._addEdge(fb.id, { toId: fa.id, distNm: d, airway: a.id });
            }
        }
        this._loaded = true;
    }

    /**
     * Get all outbound edges from a fix.
     * @param {string} fixId
     * @returns {Edge[]}
     */
    edges(fixId) {
        return this._adj[fixId] || [];
    }

    /**
     * Add a temporary direct edge (e.g. for DEP/DEST onto the graph).
     * @param {string} fromId
     * @param {number} fromLat
     * @param {number} fromLon
     * @param {string} toId
     * @param {number} toLat
     * @param {number} toLon
     */
    addDirectEdge(fromId, fromLat, fromLon, toId, toLat, toLon) {
        this.coords[fromId] = this.coords[fromId] || { lat: fromLat, lon: fromLon };
        this.coords[toId]   = this.coords[toId]   || { lat: toLat,   lon: toLon   };
        const d = haversine(fromLat, fromLon, toLat, toLon);
        this._addEdge(fromId, { toId, distNm: d, airway: 'DIRECT' });
        this._addEdge(toId,   { toId: fromId, distNm: d, airway: 'DIRECT' });
    }

    /**
     * Remove all DIRECT edges previously added via addDirectEdge.
     * Used by RoutePlanner.plan() to keep the cached graph clean across
     * successive plans with different DEP/DEST.
     */
    clearDirectEdges() {
        for (const fromId of Object.keys(this._adj)) {
            this._adj[fromId] = this._adj[fromId].filter(e => e.airway !== 'DIRECT');
            if (this._adj[fromId].length === 0) delete this._adj[fromId];
        }
    }

    /**
     * Add an edge to the adjacency list, avoiding duplicates.
     * @param {string} fromId
     * @param {Edge} edge
     * @private
     */
    _addEdge(fromId, edge) {
        const list = this._adj[fromId] || (this._adj[fromId] = []);
        if (!list.find(e => e.toId === edge.toId && e.airway === edge.airway)) list.push(edge);
    }
}
