// @ts-check
'use strict';

/**
 * IdbAeroData — implements AeroDataSource by delegating to the existing NasrDb.
 *
 * NasrDb is loaded as a global by web/shared/nasr-db.js and is owned by app
 * (`app._nasrDb`). The adapter accepts a NasrDb instance at construction.
 */
export class IdbAeroData {
    constructor(nasrDb) { this._db = nasrDb; }

    async getAirport(icao) {
        const r = await this._db.getAirport(icao);
        if (!r) return null;
        return {
            icao: r.icao || icao,
            name: r.name,
            lat:  r.lat,
            lon:  r.lon,
            elevFt: r.elev_ft ?? r.elevation_ft,
            hasFuel: !!r.has_fuel,
            hasSelfServeFuel: !!r.has_self_serve_fuel,
            runways: r.runways || [],
        };
    }

    async getNavaid(id) {
        const r = await this._db.getNavaid(id);
        if (!r) return null;
        return { id: r.id, name: r.name, lat: r.lat, lon: r.lon, type: r.type, freq: r.freq };
    }

    async getFix(name) {
        const r = await this._db.getFix(name);
        if (!r) return null;
        return { id: r.id || name, lat: r.lat, lon: r.lon, type: r.type };
    }

    async getAirway(airwayId) {
        const r = await this._db.getAirway(airwayId);
        if (!r) return null;
        return {
            id:      r.id || airwayId,
            type:    r.type,
            fixIds:  r.fix_ids || r.fixIds || [],
            segments: r.segments || [],
        };
    }

    async listAirspace() {
        // NasrDb exposes a bounded query; for the lib-level full listing, call
        // a wide bounding box. Cockpit will rely on `getAirspaceInBounds` for
        // map-view performance; the lib uses listAirspace only for avoidance
        // selection from a chip list (small N).
        const records = await this._db.getAirspaceInBounds(-90, -180, 90, 180, 5000);
        return records.map(r => ({
            id: r.id,
            kind: r.kind,
            name: r.name,
            polygon: r.polygon || [],
            floorFt: r.floor_ft,
            ceilingFt: r.ceiling_ft,
        }));
    }

    async listAirways() {
        // NasrDb does not yet have a listAirways method; add it in this task,
        // following the same shape as listAirspace. See nasr-db.js:477 for
        // getAirway(name); listAirways iterates the 'airways' object store.
        if (typeof this._db.listAirways === 'function') {
            const records = await this._db.listAirways();
            return records.map(r => ({
                id: r.id || r.name,
                type: r.type,
                fixIds: r.fix_ids || r.fixIds || [],
                segments: r.segments || [],
            }));
        }
        return [];
    }
}
