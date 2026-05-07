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
        // US airports are stored with a leading 'K' in NASR (e.g. K44N, KLGA).
        // Pilots and ATC routinely use the bare form for FAA-internal
        // identifiers ('44N') and even for major airports ('LGA' instead of
        // 'KLGA'). Retry with K-prefix on miss. Only call this for
        // departure/destination — using it for interior airway fixes would
        // misidentify navaids that share an FAA ID with an airport (e.g.
        // MRB is the Martinsburg VOR, KMRB is the airport).
        let r = await this._db.getAirport(icao);
        if (!r && !icao.startsWith('K')) r = await this._db.getAirport('K' + icao);
        if (!r) return null;
        return this._normaliseAirport(r, icao);
    }

    /**
     * Like getAirport but does NOT retry with K-prefix. Used by parser when
     * resolving interior airway tokens — MRB on V143 is the navaid, not the
     * KMRB airport.
     */
    async getAirportLiteral(icao) {
        const r = await this._db.getAirport(icao);
        if (!r) return null;
        return this._normaliseAirport(r, icao);
    }

    _normaliseAirport(r, icao) {
        // NASR stores fuel types as a raw string (e.g. "100LL", "100LL MOGAS").
        // has_fuel / has_self_serve_fuel booleans are not in the pipeline output.
        const fuelStr = (r.fuel || r.fuel_types || '').toString().trim();
        return {
            icao: r.icao || icao,
            name: r.name,
            lat:  r.lat,
            lon:  r.lon,
            elevFt: r.elev_ft ?? r.elevation_ft,
            hasFuel: !!(r.has_fuel || fuelStr),
            hasSelfServeFuel: !!(r.has_self_serve_fuel),
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
        return this._normaliseAirway(r, airwayId);
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
        if (typeof this._db.listAirways !== 'function') return [];
        const records = await this._db.listAirways();
        return records.map(r => this._normaliseAirway(r));
    }

    async nearestAirports(lat, lon, radiusNm) {
        const records = await this._db.getAirportsNear(lat, lon, radiusNm);
        return records
            .map(r => this._normaliseAirport(r, r.icao))
            .filter(a => a.lat != null && a.lon != null);
    }

    /**
     * NASR bundle airway records carry their fix sequence as
     * `waypoints: [{seq, name, lat, lon, id?, type?}, ...]`. Navaid waypoints
     * have a short `id` (e.g. "CRG"); fix waypoints (REP-PT) have only `name`.
     * We extract the canonical identifier per waypoint and pass coords inline
     * so AirwayGraph can build edges without per-fix IDB round-trips.
     */
    _normaliseAirway(r, fallbackId) {
        // NASR airway-waypoint records use:
        //   - id="CLT", name="Charlotte"   (navaid waypoints — id is short, name is long)
        //   - id=null,  name="Locas"       (REP-PT/intersection — only the human name)
        // Normalize fix IDs to uppercase since FAA reporting always is, and
        // the planner's parser will uppercase pasted tokens before indexOf.
        const unusable_from_seqs = new Set(r.unusable_from_seqs || []);
        const wps = (r.waypoints || [])
            .map(w => ({
                id:  ((w.id || w.name) || '').toUpperCase(),
                lat: w.lat,
                lon: w.lon,
                seq: w.seq,
            }))
            .filter(w => w.id && Number.isFinite(w.lat) && Number.isFinite(w.lon));

        // Build set of "fromId|toId" strings for segments the FAA marks UNUSABLE (AWY4).
        // airway-graph.js will skip these edges so A* never routes through them.
        const unusable_pairs = new Set();
        for (let i = 0; i < wps.length - 1; i++) {
            if (unusable_from_seqs.has(wps[i].seq)) {
                unusable_pairs.add(`${wps[i].id}|${wps[i + 1].id}`);
            }
        }

        return {
            id:      r.name || r.id || fallbackId,
            type:    r.type,
            fixIds:  wps.map(w => w.id),
            waypoints: wps.map(({ id, lat, lon }) => ({ id, lat, lon })),
            segments: r.segments || [],
            unusable_pairs,
        };
    }
}
