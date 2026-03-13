/**
 * FlyPi — Weather API Client
 * Fetches METARs, TAFs, winds aloft, PIREPs, SIGMETs, NOTAMs, TFRs
 * from the Cloudflare Worker proxy. Decodes METAR and determines flight category.
 */

class WeatherClient {
    // Fetch directly from aviationweather.gov (supports CORS)
    static AWC_BASE = 'https://aviationweather.gov/api/data';

    constructor(db) {
        this.db = db;
    }

    /**
     * Fetch all weather for a route corridor.
     * @param {string[]} stations - ICAO identifiers along the route
     * @param {number} altitude - Cruise altitude in feet
     * @returns {object} Combined weather data
     */
    async fetchAllForRoute(stations, altitude) {
        const ids = stations.join(',');
        const [metars, tafs, winds, pireps, sigmets, mos] = await Promise.allSettled([
            this.fetchMetars(ids),
            this.fetchTafs(ids),
            this.fetchWindsAloft(stations[0], altitude),
            this.fetchPireps(ids),
            this.fetchSigmets(),
            this.fetchMos(ids),
        ]);

        const result = {
            fetched_at: new Date().toISOString(),
            metars: metars.status === 'fulfilled' ? metars.value : {},
            tafs: tafs.status === 'fulfilled' ? tafs.value : {},
            winds_aloft: winds.status === 'fulfilled' ? winds.value : {},
            pireps: pireps.status === 'fulfilled' ? pireps.value : [],
            sigmets: sigmets.status === 'fulfilled' ? sigmets.value : [],
            mos: mos.status === 'fulfilled' ? mos.value : null,
            tfrs: [],
            notams: [],
        };

        // Cache to IndexedDB
        for (const [icao, metar] of Object.entries(result.metars)) {
            await this.db.putWeather(icao, {
                metar: metar,
                taf: result.tafs[icao] || null,
                fetched_at: result.fetched_at,
            });
        }

        return result;
    }

    /**
     * Fetch METARs for comma-separated station IDs.
     */
    async fetchMetars(ids) {
        const url = `${WeatherClient.AWC_BASE}/metar?ids=${ids}&format=json`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`METAR fetch failed: ${resp.status}`);
        const data = await resp.json();

        // Parse into { ICAO: decoded } map
        const metars = {};
        const items = Array.isArray(data) ? data : (data.data || []);
        for (const item of items) {
            const icao = item.icaoId || item.station_id;
            if (!icao) continue;
            metars[icao] = {
                raw: item.rawOb || item.raw_text || '',
                decoded: WeatherClient.decodeMetar(item),
                fetched_at: new Date().toISOString(),
            };
        }
        return metars;
    }

    /**
     * Fetch TAFs for comma-separated station IDs.
     */
    async fetchTafs(ids) {
        const url = `${WeatherClient.AWC_BASE}/taf?ids=${ids}&format=json`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`TAF fetch failed: ${resp.status}`);
        const data = await resp.json();

        const tafs = {};
        const items = Array.isArray(data) ? data : (data.data || []);
        for (const item of items) {
            const icao = item.icaoId || item.station_id;
            if (!icao) continue;
            tafs[icao] = {
                raw: item.rawTAF || item.raw_text || '',
                fetched_at: new Date().toISOString(),
            };
        }
        return tafs;
    }

    /**
     * Fetch winds aloft data. Finds the nearest FD reporting station
     * to the given station/airport and returns winds at all altitudes.
     * @param {string} station - ICAO identifier (e.g., KLKR)
     * @param {number} altitude - Target cruise altitude (used for caching key)
     * @param {number} [lat] - Optional latitude for nearest-station matching
     * @param {number} [lon] - Optional longitude for nearest-station matching
     * @returns {object} Altitude-keyed wind data: { 3000: { dir, spd, temp }, ... }
     */
    async fetchWindsAloft(station, altitude, lat, lon) {
        const url = `${WeatherClient.AWC_BASE}/windtemp?region=all&level=low&fcst=06`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Winds aloft fetch failed: ${resp.status}`);
        const text = await resp.text();

        // Parse ALL stations from the FD text
        const allStations = WeatherClient.parseAllWindsAloft(text);
        if (Object.keys(allStations).length === 0) return {};

        // Try exact match first (strip K prefix for CONUS)
        const stationUpper = (station || '').toUpperCase();
        const fd3 = stationUpper.startsWith('K') ? stationUpper.slice(1) : stationUpper;
        if (allStations[fd3]) {
            return allStations[fd3];
        }

        // Find nearest FD station using coordinates
        let searchLat = lat;
        let searchLon = lon;
        if (searchLat == null && this.db) {
            const apt = await this.db.getAirport(stationUpper);
            if (apt) { searchLat = apt.lat; searchLon = apt.lon; }
        }

        if (searchLat != null && searchLon != null) {
            const nearest = WeatherClient.findNearestFdStation(allStations, searchLat, searchLon);
            if (nearest) {
                console.log(`Winds aloft: using FD station ${nearest} for ${stationUpper}`);
                return allStations[nearest];
            }
        }

        // Last resort: return first station with data
        const firstKey = Object.keys(allStations)[0];
        return allStations[firstKey] || {};
    }

    /**
     * Fetch PIREPs near route corridor.
     */
    async fetchPireps(ids) {
        const url = `${WeatherClient.AWC_BASE}/pirep?id=${ids}&format=json&age=3`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`PIREP fetch failed: ${resp.status}`);
        const data = await resp.json();
        return Array.isArray(data) ? data : (data.data || []);
    }

    /**
     * Fetch NOAA GFS MOS (MAV + MEX) for comma-separated station IDs.
     * Returns structured 8-day forecast per station via /api/mos Vercel route.
     */
    async fetchMos(ids) {
        const base = Settings.workerBase || 'https://flywhere.app/api';
        const resp = await fetch(`${base}/mos?ids=${ids}`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`MOS fetch failed: ${resp.status}`);
        return await resp.json();
    }

    /**
     * Fetch active SIGMETs/AIRMETs.
     */
    async fetchSigmets() {
        const url = `${WeatherClient.AWC_BASE}/airsigmet?format=json`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`SIGMET fetch failed: ${resp.status}`);
        const data = await resp.json();
        return Array.isArray(data) ? data : (data.data || []);
    }

    // ========== METAR Decoding ==========

    /**
     * Decode a METAR from aviationweather.gov JSON into structured format.
     */
    static decodeMetar(item) {
        const decoded = {
            station: item.icaoId || item.station_id || '',
            observed_at: item.reportTime || item.observation_time || '',
            wind_dir: null,
            wind_speed: null,
            wind_gust: null,
            visibility: null,
            ceiling: null,
            sky_condition: [],
            temperature: null,
            dewpoint: null,
            altimeter: null,
            flight_category: null,
            weather: [],
        };

        // Wind
        decoded.wind_dir = item.wdir ?? null;
        decoded.wind_speed = item.wspd ?? null;
        decoded.wind_gust = item.wgst ?? null;

        // Visibility (statute miles) — API returns "10+" for unlimited
        const rawVis = item.visib;
        decoded.visibility = (typeof rawVis === 'string' && rawVis.includes('+'))
            ? parseFloat(rawVis)
            : (rawVis ?? null);

        // Sky conditions — extract ceiling
        const clouds = item.clouds || [];
        decoded.sky_condition = clouds.map(c => ({
            cover: c.cover || '',
            base: c.base ?? null,
        }));

        // Ceiling is the lowest BKN or OVC layer
        for (const c of clouds) {
            const cover = (c.cover || '').toUpperCase();
            if (cover === 'BKN' || cover === 'OVC') {
                const base = c.base;
                if (base !== null && base !== undefined) {
                    if (decoded.ceiling === null || base < decoded.ceiling) {
                        decoded.ceiling = base;
                    }
                }
            }
        }

        // Temperature / Dewpoint
        decoded.temperature = item.temp ?? null;
        decoded.dewpoint = item.dewp ?? null;

        // Altimeter
        decoded.altimeter = item.altim ?? null;

        // Weather phenomena
        if (item.wxString) {
            decoded.weather = item.wxString.split(/\s+/).filter(Boolean);
        }

        // Flight category — use API-provided if available, else compute
        decoded.flight_category = item.fltCat || WeatherClient.getFlightCategory(
            decoded.ceiling, decoded.visibility
        );

        return decoded;
    }

    /**
     * Determine flight category from ceiling and visibility.
     * @param {number|null} ceiling - AGL feet (null = clear)
     * @param {number|null} visibility - Statute miles (null = unlimited)
     * @returns {string} VFR, MVFR, IFR, or LIFR
     */
    static getFlightCategory(ceiling, visibility) {
        // Default to VFR if no data
        const ceil = ceiling ?? 99999;
        const vis = visibility ?? 99;

        if (ceil < 500 || vis < 1) return 'LIFR';
        if (ceil < 1000 || vis < 3) return 'IFR';
        if (ceil <= 3000 || vis <= 5) return 'MVFR';
        return 'VFR';
    }

    /**
     * Parse ALL stations from FD winds aloft text.
     * Returns: { 'CLT': { 3000: {dir,spd,temp}, 6000: ... }, 'ATL': {...}, ... }
     */
    static parseAllWindsAloft(text) {
        const allStations = {};
        const lines = text.split('\n');

        // Standard FD low-level altitude columns
        const altLevels = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000];

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Skip headers
            if (/^(FD|FB|DATA|VALID|FT |0{3}$)/.test(trimmed)) continue;

            const parts = trimmed.split(/\s+/);
            if (parts.length < 2) continue;

            // Station ID is first token (2-3 letter code)
            const stationId = parts[0];
            if (!/^[A-Z]{2,3}$/.test(stationId)) continue;

            const winds = {};
            for (let i = 1; i < parts.length && i <= altLevels.length; i++) {
                const parsed = WeatherClient.parseWindGroup(parts[i]);
                if (parsed) {
                    winds[altLevels[i - 1]] = parsed;
                }
            }

            if (Object.keys(winds).length > 0) {
                allStations[stationId] = winds;
            }
        }

        return allStations;
    }

    /**
     * Find the nearest FD station to given coordinates.
     * Uses a built-in lookup of common FD station locations.
     */
    static findNearestFdStation(allStations, lat, lon) {
        const stationIds = Object.keys(allStations);
        let bestStation = null;
        let bestDist = Infinity;

        for (const id of stationIds) {
            const coords = WeatherClient.FD_STATIONS[id];
            if (!coords) continue;
            // Quick distance approximation (good enough for nearest-station)
            const dLat = coords[0] - lat;
            const dLon = (coords[1] - lon) * Math.cos(lat * Math.PI / 180);
            const dist = dLat * dLat + dLon * dLon;
            if (dist < bestDist) {
                bestDist = dist;
                bestStation = id;
            }
        }

        return bestStation;
    }

    /**
     * Parse a single wind group from FD format.
     * "2714" = 270° @ 14kt, "2714+06" = 270° @ 14kt, +6°C
     * "9900" = light and variable
     * DDff[±TT] where DD*10=direction, ff=speed
     */
    static parseWindGroup(group) {
        if (!group || group.length < 4) return null;
        if (isNaN(parseInt(group.substring(0, 4)))) return null;

        // "9900" means light and variable
        if (group.startsWith('9900')) {
            let temp = null;
            if (group.length >= 6) {
                temp = parseInt(group.substring(4));
            }
            return { dir: 0, spd: 0, temp, variable: true };
        }

        const dirCode = parseInt(group.substring(0, 2));
        let spd = parseInt(group.substring(2, 4));
        let dir = dirCode * 10;

        // Winds >= 100kt encoded by adding 50 to direction code
        // e.g., "7520" = (75-50)*10=250° @ (20+100)=120kt
        if (dirCode >= 51 && dirCode <= 86) {
            dir = (dirCode - 50) * 10;
            spd += 100;
        }

        let temp = null;
        if (group.length >= 6) {
            const tempPart = group.substring(4);
            // Handle both "+06", "-12", "06", "12" formats
            // Above 24000ft all temps negative; below they can be signed
            temp = parseInt(tempPart);
        }

        return { dir, spd, temp, variable: false };
    }

    /**
     * FD reporting station coordinates (lat, lon).
     * Common CONUS stations used in winds/temps aloft forecasts.
     */
    static FD_STATIONS = {
        ABQ: [35.04, -106.61], ACY: [39.46, -74.58], ALB: [42.75, -73.80],
        AMA: [35.22, -101.71], ATL: [33.64, -84.43], AUS: [30.19, -97.67],
        AVP: [41.34, -75.72], BDL: [41.94, -72.68], BGR: [44.81, -68.83],
        BHM: [33.56, -86.75], BIL: [45.81, -108.54], BIS: [46.77, -100.75],
        BNA: [36.12, -86.68], BOI: [43.56, -116.22], BOS: [42.36, -71.01],
        BRO: [25.91, -97.43], BUF: [42.94, -78.73], CAE: [33.94, -81.12],
        CHS: [32.90, -80.04], CLE: [41.41, -81.85], CLT: [35.21, -80.94],
        CRP: [27.77, -97.50], CVG: [39.05, -84.67], DAL: [32.85, -96.85],
        DAY: [39.90, -84.22], DCA: [38.85, -77.04], DDC: [37.76, -99.97],
        DEN: [39.86, -104.67], DFW: [32.90, -97.04], DSM: [41.53, -93.66],
        DTW: [42.21, -83.35], ELP: [31.81, -106.38], EWR: [40.69, -74.17],
        FAT: [36.78, -119.72], FLL: [26.07, -80.15], GEG: [47.62, -117.53],
        GRB: [44.49, -88.13], GSO: [36.10, -79.94], GYY: [41.62, -87.41],
        HOU: [29.65, -95.28], ICT: [37.65, -97.43], IND: [39.72, -86.29],
        JAX: [30.49, -81.69], JFK: [40.64, -73.78], LAS: [36.08, -115.15],
        LAX: [33.94, -118.41], LBB: [33.66, -101.82], LIT: [34.73, -92.22],
        MCI: [39.30, -94.71], MCO: [28.43, -81.31], MDW: [41.79, -87.75],
        MEM: [35.04, -89.98], MIA: [25.79, -80.29], MKE: [42.95, -87.90],
        MOB: [30.69, -88.24], MSP: [44.88, -93.22], MSY: [29.99, -90.26],
        OKC: [35.39, -97.60], OMA: [41.30, -95.89], ORD: [41.97, -87.91],
        PBI: [26.68, -80.10], PDX: [45.59, -122.59], PHL: [39.87, -75.24],
        PHX: [33.43, -112.01], PIT: [40.49, -80.23], PSP: [33.83, -116.51],
        PVD: [41.72, -71.43], RAP: [44.04, -103.05], RDU: [35.88, -78.79],
        RIC: [37.51, -77.32], RNO: [39.50, -119.77], ROA: [37.32, -79.97],
        SAT: [29.53, -98.47], SAV: [32.13, -81.20], SDF: [38.17, -85.74],
        SEA: [47.45, -122.31], SFO: [37.62, -122.38], SJU: [18.44, -66.00],
        SLC: [40.79, -111.98], STL: [38.75, -90.37], SYR: [43.11, -76.11],
        TLH: [30.40, -84.35], TPA: [27.98, -82.53], TUS: [32.12, -110.94],
        TYS: [35.81, -83.99], ABR: [45.45, -98.42], ABI: [32.41, -99.68],
        BFF: [41.87, -103.60], BIH: [37.37, -118.36], BLH: [33.62, -114.72],
        BAM: [40.57, -116.92], BCE: [38.57, -109.31], ALS: [37.44, -105.87],
    };

}
