/**
 * FlyPi — FIS-B Weather Client
 * Higher-level weather manager that listens to StratuxClient events,
 * maintains in-memory weather store, decodes METARs, fires typed events.
 * Writes to IndexedDB via NasrDB.putWeather() for airport popup lookups.
 */

class FisbClient extends EventTarget {
    constructor(stratuxClient, nasrDb) {
        super();
        this._stratux = stratuxClient;
        this._nasr = nasrDb;

        // In-memory weather stores
        this.metars = new Map();    // icao → { raw, decoded, received_at, is_speci }
        this.tafs = new Map();      // icao → { raw, received_at }
        this.pireps = [];           // [{ raw, lat, lon, type, severity, received_at }]
        this.sigmets = [];          // [{ raw, type, points, received_at, expires_at }]
        this.airmets = [];          // [{ raw, type, points, received_at, expires_at }]
        this.winds = new Map();     // "station:alt" → { dir, spd, temp, received_at }
        this.cwas = [];             // [{ raw, received_at }]

        // Counts for status display
        this.metarCount = 0;
        this.tafCount = 0;
        this.pirepCount = 0;
        this.sigmetCount = 0;

        // NEXRAD blocks forwarded to FisbNexrad
        this._nexradBlocks = new Map(); // "lat,lon" → { ...block, received_at }

        // Purge timer
        this._purgeTimer = null;

        // Cache for FD station → { lat, lon } lookups
        this._stationCoords = new Map();

        // Bind listeners
        this._onWeather = (e) => this._handleWeather(e.detail);
        this._onNexrad = (e) => this._handleNexrad(e.detail);
        this._onFisbFrame = (e) => this._handleFisbFrame(e.detail);
    }

    start() {
        this._stratux.addEventListener('stratux:weather', this._onWeather);
        this._stratux.addEventListener('stratux:nexrad', this._onNexrad);
        this._stratux.addEventListener('stratux:fisb-frame', this._onFisbFrame);
        this._purgeTimer = setInterval(() => this._purgeStale(), 30000);
    }

    stop() {
        this._stratux.removeEventListener('stratux:weather', this._onWeather);
        this._stratux.removeEventListener('stratux:nexrad', this._onNexrad);
        this._stratux.removeEventListener('stratux:fisb-frame', this._onFisbFrame);
        if (this._purgeTimer) { clearInterval(this._purgeTimer); this._purgeTimer = null; }
    }

    /** Get METAR for an airport (from in-memory store) */
    getMetar(icao) {
        return this.metars.get(icao?.toUpperCase()) || null;
    }

    /** Get TAF for an airport */
    getTaf(icao) {
        return this.tafs.get(icao?.toUpperCase()) || null;
    }

    /** Get winds aloft nearest to a lat/lon at a given altitude */
    getNearestWind(lat, lon, altFt) {
        // Round altitude to nearest reporting level
        const levels = [3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000];
        let bestAlt = levels[0];
        let minDiff = Math.abs(altFt - levels[0]);
        for (const lvl of levels) {
            const d = Math.abs(altFt - lvl);
            if (d < minDiff) { minDiff = d; bestAlt = lvl; }
        }

        // Find nearest station at that altitude
        let bestWind = null;
        let bestDist = Infinity;
        for (const [key, wind] of this.winds) {
            if (wind.alt !== bestAlt) continue;
            if (wind.lat == null || wind.lon == null) continue;
            const dist = this._distNm(lat, lon, wind.lat, wind.lon);
            if (dist < bestDist) {
                bestDist = dist;
                bestWind = wind;
            }
        }
        return bestWind;
    }

    // ========== Weather Message Handling ==========

    _handleWeather(msg) {
        if (!msg || !msg.Type || !msg.Data) return;

        const type = msg.Type.toUpperCase();
        const data = msg.Data;
        const location = msg.Location || '';
        const now = Date.now();

        if (type === 'METAR' || type === 'SPECI') {
            this._handleMetar(data, location, now, type === 'SPECI');
        } else if (type === 'TAF') {
            this._handleTaf(data, location, now);
        } else if (type === 'PIREP' || type === 'UA' || type === 'UUA') {
            this._handlePirep(data, location, now, type === 'UUA');
        } else if (type === 'SIGMET' || type === 'CONVECTIVE SIGMET') {
            this._handleSigmet(data, location, now, type);
        } else if (type === 'AIRMET') {
            this._handleAirmet(data, location, now);
        } else if (type === 'WINDS' || type === 'FD') {
            this._handleWinds(data, now);
        } else if (type === 'CWA') {
            this._handleCwa(data, now);
        }
    }

    _handleMetar(raw, location, now, isSpeci) {
        // Extract ICAO from METAR text: "METAR KJFK 241856Z ..." or "KJFK 241856Z ..."
        const icao = this._extractMetarIcao(raw) || location.toUpperCase();
        if (!icao || icao.length < 3) return;

        const decoded = FisbClient.decodeMetar(raw);
        const entry = { raw, decoded, received_at: now, is_speci: isSpeci };

        this.metars.set(icao, entry);
        this.metarCount = this.metars.size;

        // Write to IndexedDB for airport popup (read-modify-write to preserve TAF)
        if (this._nasr) {
            this._nasr.getWeather(icao).then(existing => {
                const wx = existing || {};
                wx.metar = { raw, decoded, fetched_at: new Date(now).toISOString() };
                wx.source = 'fisb';
                wx.fetched_at = new Date(now).toISOString();
                return this._nasr.putWeather(icao, wx);
            }).catch(() => {});
        }

        this.dispatchEvent(new CustomEvent('fisb:metar', { detail: { icao, ...entry } }));
    }

    _handleTaf(raw, location, now) {
        const icao = this._extractTafIcao(raw) || location.toUpperCase();
        if (!icao || icao.length < 3) return;

        const entry = { raw, received_at: now };
        this.tafs.set(icao, entry);
        this.tafCount = this.tafs.size;

        // Update IndexedDB (read-modify-write to preserve METAR)
        if (this._nasr) {
            this._nasr.getWeather(icao).then(existing => {
                const wx = existing || {};
                wx.taf = { raw, fetched_at: new Date(now).toISOString() };
                wx.source = 'fisb';
                wx.fetched_at = new Date(now).toISOString();
                return this._nasr.putWeather(icao, wx);
            }).catch(() => {});
        }

        this.dispatchEvent(new CustomEvent('fisb:taf', { detail: { icao, ...entry } }));
    }

    _handlePirep(raw, location, now, isUrgent) {
        const parsed = FisbClient.parsePirep(raw);
        const entry = {
            raw,
            lat: parsed.lat,
            lon: parsed.lon,
            type: parsed.type,       // 'turbulence', 'icing', 'other'
            severity: parsed.severity, // 1-5
            altitude: parsed.altitude,
            is_urgent: isUrgent,
            received_at: now,
        };

        this.pireps.push(entry);
        this.pirepCount = this.pireps.length;

        this.dispatchEvent(new CustomEvent('fisb:pirep', { detail: entry }));
    }

    _handleSigmet(raw, location, now, type) {
        const points = this._extractPolygonPoints(raw);
        const entry = {
            raw,
            type: type.toUpperCase().includes('CONVECTIVE') ? 'convective' : 'sigmet',
            points,
            location,
            received_at: now,
            expires_at: this._extractExpiry(raw, now),
        };

        // Replace existing SIGMET with same identifier if any
        const id = this._extractSigmetId(raw);
        if (id) {
            const idx = this.sigmets.findIndex(s => this._extractSigmetId(s.raw) === id);
            if (idx >= 0) this.sigmets[idx] = entry;
            else this.sigmets.push(entry);
        } else {
            this.sigmets.push(entry);
        }
        this.sigmetCount = this.sigmets.length;

        this.dispatchEvent(new CustomEvent('fisb:sigmet', { detail: entry }));
    }

    _handleAirmet(raw, location, now) {
        const points = this._extractPolygonPoints(raw);
        const entry = {
            raw,
            type: 'airmet',
            points,
            location,
            received_at: now,
            expires_at: this._extractExpiry(raw, now),
        };

        this.airmets.push(entry);
        this.dispatchEvent(new CustomEvent('fisb:airmet', { detail: entry }));
    }

    _handleWinds(raw, now) {
        // FD format: "FD1 WINDS 241800 DATA BASED ON 241200Z VALID 241800Z
        //   STN  3000  6000  9000  12000 ...
        //   CLT  2408  2615+03  2720-01 ..."
        const lines = raw.split('\n');
        let altitudes = null;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Header line with altitude labels
            if (/^\s*(STN|FT)\s+\d{4}/.test(trimmed) || /^\d{4}\s+\d{4}/.test(trimmed)) {
                // Parse altitude headers
                const parts = trimmed.split(/\s+/);
                altitudes = parts.slice(1).map(a => parseInt(a, 10)).filter(a => !isNaN(a));
                continue;
            }

            // Data line: "CLT  2408  2615+03  ..."
            const match = trimmed.match(/^([A-Z]{3})\s+(.+)/);
            if (!match || !altitudes) continue;

            const station = match[1];
            const windParts = match[2].split(/\s+/);

            for (let i = 0; i < windParts.length && i < altitudes.length; i++) {
                const wind = FisbClient.parseWindAloft(windParts[i]);
                if (!wind) continue;
                wind.station = station;
                wind.alt = altitudes[i];
                wind.received_at = now;
                this.winds.set(`${station}:${altitudes[i]}`, wind);
            }

            // Resolve station lat/lon from NASR (airport or navaid lookup)
            this._resolveStationCoords(station);
        }

        this.dispatchEvent(new CustomEvent('fisb:winds', { detail: { count: this.winds.size } }));
    }

    _handleCwa(raw, now) {
        const entry = { raw, received_at: now };
        this.cwas.push(entry);
        this.dispatchEvent(new CustomEvent('fisb:cwa', { detail: entry }));
    }

    // ========== NEXRAD Handling ==========

    _handleNexrad(msg) {
        // Forward to FisbNexrad renderer via event
        this.dispatchEvent(new CustomEvent('fisb:nexrad', { detail: msg }));
    }

    // ========== FIS-B Frame Handling ==========

    _handleFisbFrame(msg) {
        // Graphical SIGMETs from /jsonio may include Points arrays
        if (msg.Points && msg.Points.length > 0) {
            const points = msg.Points.map(p => [p.Lat, p.Lon]);
            const pid = msg.Product_id;
            // Product IDs 8-13 are graphical AIRMETs/SIGMETs
            if (pid >= 8 && pid <= 13) {
                const entry = {
                    raw: msg.Text || JSON.stringify(msg),
                    type: pid <= 10 ? 'airmet' : 'sigmet',
                    points,
                    received_at: Date.now(),
                    expires_at: Date.now() + 3600000,
                };
                if (entry.type === 'sigmet') {
                    this.sigmets.push(entry);
                    this.sigmetCount = this.sigmets.length;
                    this.dispatchEvent(new CustomEvent('fisb:sigmet', { detail: entry }));
                } else {
                    this.airmets.push(entry);
                    this.dispatchEvent(new CustomEvent('fisb:airmet', { detail: entry }));
                }
            }
        }
    }

    // ========== Purge Stale Data ==========

    _purgeStale() {
        const now = Date.now();

        // METARs older than 90 minutes
        for (const [icao, m] of this.metars) {
            if (now - m.received_at > 90 * 60000) this.metars.delete(icao);
        }
        this.metarCount = this.metars.size;

        // TAFs older than 6 hours
        for (const [icao, t] of this.tafs) {
            if (now - t.received_at > 6 * 3600000) this.tafs.delete(icao);
        }
        this.tafCount = this.tafs.size;

        // PIREPs older than 60 minutes
        this.pireps = this.pireps.filter(p => now - p.received_at < 60 * 60000);
        this.pirepCount = this.pireps.length;

        // SIGMETs: remove expired
        this.sigmets = this.sigmets.filter(s =>
            (s.expires_at && s.expires_at > now) || (now - s.received_at < 4 * 3600000)
        );
        this.sigmetCount = this.sigmets.length;

        // AIRMETs: remove expired
        this.airmets = this.airmets.filter(a =>
            (a.expires_at && a.expires_at > now) || (now - a.received_at < 4 * 3600000)
        );

        // Winds older than 6 hours
        for (const [key, w] of this.winds) {
            if (now - w.received_at > 6 * 3600000) this.winds.delete(key);
        }

        // CWAs older than 2 hours
        this.cwas = this.cwas.filter(c => now - c.received_at < 2 * 3600000);
    }

    // ========== METAR Decoding ==========

    /** Decode raw METAR text into structured data */
    static decodeMetar(raw) {
        if (!raw) return {};
        // Strip METAR/SPECI prefix
        let text = raw.replace(/^(METAR|SPECI)\s+/i, '').trim();

        const result = {};

        // ICAO
        const icaoMatch = text.match(/^([A-Z]{4})\s/);
        if (icaoMatch) result.icao = icaoMatch[1];

        // Observation time: DDHHMMz
        const timeMatch = text.match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
        if (timeMatch) {
            const now = new Date();
            const day = parseInt(timeMatch[1], 10);
            const hour = parseInt(timeMatch[2], 10);
            const min = parseInt(timeMatch[3], 10);
            const obs = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hour, min));
            // Handle month rollover
            if (obs > now) obs.setUTCMonth(obs.getUTCMonth() - 1);
            result.observed_at = obs.toISOString();
        }

        // Wind: dddssKT or dddssGggKT or VRB
        const windMatch = text.match(/\b(VRB|\d{3})(\d{2,3})(G(\d{2,3}))?KT\b/);
        if (windMatch) {
            result.wind_dir = windMatch[1] === 'VRB' ? null : parseInt(windMatch[1], 10);
            result.wind_speed = parseInt(windMatch[2], 10);
            if (windMatch[4]) result.wind_gust = parseInt(windMatch[4], 10);
            result.wind_variable = windMatch[1] === 'VRB';
        }

        // Visibility: handles P6SM, 1 1/2SM, 1/2SM, 10SM
        const pVisMatch = text.match(/\bP(\d+)SM\b/);
        const mixedVisMatch = text.match(/\b(\d+)\s+(\d+)\/(\d+)SM\b/);
        const fracVisMatch = text.match(/\b(\d+)\/(\d+)SM\b/);
        const intVisMatch = text.match(/\b(\d+)SM\b/);
        if (pVisMatch) {
            result.visibility_sm = parseInt(pVisMatch[1], 10); // P6SM → 6 (means >6)
        } else if (mixedVisMatch) {
            result.visibility_sm = parseInt(mixedVisMatch[1], 10) +
                parseInt(mixedVisMatch[2], 10) / parseInt(mixedVisMatch[3], 10); // 1 1/2SM → 1.5
        } else if (fracVisMatch) {
            result.visibility_sm = parseInt(fracVisMatch[1], 10) / parseInt(fracVisMatch[2], 10); // 1/2SM → 0.5
        } else if (intVisMatch) {
            result.visibility_sm = parseInt(intVisMatch[1], 10);
        }

        // Ceiling (lowest BKN or OVC)
        const ceilingPattern = /\b(BKN|OVC|VV)(\d{3})\b/g;
        let cMatch;
        let lowestCeiling = Infinity;
        while ((cMatch = ceilingPattern.exec(text)) !== null) {
            const ht = parseInt(cMatch[2], 10) * 100;
            if (ht < lowestCeiling) lowestCeiling = ht;
        }
        if (lowestCeiling < Infinity) result.ceiling_ft = lowestCeiling;

        // Temperature/Dewpoint
        const tempMatch = text.match(/\b(M?\d{2})\/(M?\d{2})\b/);
        if (tempMatch) {
            result.temp_c = parseInt(tempMatch[1].replace('M', '-'), 10);
            result.dewpoint_c = parseInt(tempMatch[2].replace('M', '-'), 10);
        }

        // Altimeter
        const altMatch = text.match(/\bA(\d{4})\b/);
        if (altMatch) result.altimeter = parseInt(altMatch[1], 10) / 100;

        // Flight category
        const vis = result.visibility_sm ?? 10;
        const ceil = result.ceiling_ft ?? 99999;
        if (vis >= 5 && ceil >= 3000) result.flight_category = 'VFR';
        else if (vis >= 3 && ceil >= 1000) result.flight_category = 'MVFR';
        else if (vis >= 1 && ceil >= 500) result.flight_category = 'IFR';
        else result.flight_category = 'LIFR';

        return result;
    }

    // ========== PIREP Parsing ==========

    static parsePirep(raw) {
        const result = { lat: null, lon: null, type: 'other', severity: 1, altitude: null };
        if (!raw) return result;

        // Try to extract direct lat/lon: /OV dddmm(N|S)dddmm(W|E) or numeric coords
        const coordMatch = raw.match(/\/OV\s+(\d{4})(N|S)(\d{5})(W|E)/);
        if (coordMatch) {
            let lat = parseInt(coordMatch[1].slice(0, 2), 10) + parseInt(coordMatch[1].slice(2), 10) / 60;
            if (coordMatch[2] === 'S') lat = -lat;
            let lon = parseInt(coordMatch[3].slice(0, 3), 10) + parseInt(coordMatch[3].slice(3), 10) / 60;
            if (coordMatch[4] === 'W') lon = -lon;
            result.lat = lat;
            result.lon = lon;
        }

        // Altitude: /FL###
        const altMatch = raw.match(/\/FL(\d{3})/);
        if (altMatch) result.altitude = parseInt(altMatch[1], 10) * 100;

        // Turbulence
        const turbMatch = raw.match(/\/TB\s+(NEG|LGT|MOD|SVR|EXTRM)/i);
        if (turbMatch) {
            result.type = 'turbulence';
            const levels = { NEG: 0, LGT: 1, MOD: 2, SVR: 3, EXTRM: 4 };
            result.severity = levels[turbMatch[1].toUpperCase()] ?? 1;
        }

        // Icing
        const iceMatch = raw.match(/\/IC\s+(NEG|TRC|LGT|MOD|SVR|HVY)/i);
        if (iceMatch) {
            result.type = 'icing';
            const levels = { NEG: 0, TRC: 1, LGT: 1, MOD: 2, SVR: 3, HVY: 4 };
            result.severity = levels[iceMatch[1].toUpperCase()] ?? 1;
        }

        return result;
    }

    // ========== Wind Aloft Parsing ==========

    static parseWindAloft(code) {
        if (!code || code === '9900') return null; // light and variable
        // Format: ddss or ddss+TT or ddss-TT (dd=direction/10, ss=speed)
        const match = code.match(/^(\d{2})(\d{2})([+-]?\d{1,2})?$/);
        if (!match) return null;
        let dir = parseInt(match[1], 10) * 10;
        let spd = parseInt(match[2], 10);
        // Speed > 100kt encoded with dir+50
        if (dir > 360) {
            dir -= 500;
            spd += 100;
        }
        const temp = match[3] ? parseInt(match[3], 10) : null;
        return { dir, spd, temp };
    }

    // ========== Station Coordinate Resolution ==========

    /** Look up FD wind station coords from NASR DB and apply to all wind entries for that station */
    async _resolveStationCoords(station) {
        if (this._stationCoords.has(station)) {
            const coords = this._stationCoords.get(station);
            if (coords) this._applyStationCoords(station, coords);
            return;
        }
        if (!this._nasr) return;

        // FD station codes are typically 3-letter identifiers matching airports or navaids
        // Try airport first (K + station for US), then navaid
        try {
            let found = await this._nasr.getAirport('K' + station);
            if (!found) found = await this._nasr.getAirport(station);
            if (!found) found = await this._nasr.getNavaid(station);
            if (found && found.lat != null && found.lon != null) {
                const coords = { lat: found.lat, lon: found.lon };
                this._stationCoords.set(station, coords);
                this._applyStationCoords(station, coords);
            } else {
                this._stationCoords.set(station, null); // cache miss to avoid re-querying
            }
        } catch {
            this._stationCoords.set(station, null);
        }
    }

    /** Apply resolved coords to all wind entries for a station */
    _applyStationCoords(station, coords) {
        for (const [key, wind] of this.winds) {
            if (wind.station === station) {
                wind.lat = coords.lat;
                wind.lon = coords.lon;
            }
        }
    }

    // ========== Helpers ==========

    _extractMetarIcao(raw) {
        const m = raw.match(/(?:METAR|SPECI)\s+([A-Z][A-Z0-9]{2,4})\b/i)
               || raw.match(/^([A-Z][A-Z0-9]{2,4})\s+\d{6}Z/);
        return m ? m[1].toUpperCase() : null;
    }

    _extractTafIcao(raw) {
        const m = raw.match(/TAF\s+(?:AMD\s+)?([A-Z][A-Z0-9]{2,4})\b/i)
               || raw.match(/^([A-Z][A-Z0-9]{2,4})\s+\d{6}Z/);
        return m ? m[1].toUpperCase() : null;
    }

    _extractPolygonPoints(raw) {
        // Look for coordinate patterns in SIGMET/AIRMET text
        // Pattern: FROM ddmmN/dddmmW TO ... or N/W lat/lon pairs
        const points = [];
        const pattern = /(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/g;
        let m;
        while ((m = pattern.exec(raw)) !== null) {
            let lat = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
            if (m[3] === 'S') lat = -lat;
            let lon = parseInt(m[4], 10) + parseInt(m[5], 10) / 60;
            if (m[6] === 'W') lon = -lon;
            points.push([lat, lon]);
        }
        return points;
    }

    _extractExpiry(raw, now) {
        // Look for VALID UNTIL ddHHMMZ pattern
        const m = raw.match(/(?:VALID\s+UNTIL|UNTIL)\s+(\d{2})(\d{2})(\d{2})Z/i);
        if (!m) return now + 4 * 3600000; // default 4 hours
        const d = new Date();
        d.setUTCDate(parseInt(m[1], 10));
        d.setUTCHours(parseInt(m[2], 10));
        d.setUTCMinutes(parseInt(m[3], 10));
        d.setUTCSeconds(0);
        if (d.getTime() < now) d.setUTCMonth(d.getUTCMonth() + 1);
        return d.getTime();
    }

    _extractSigmetId(raw) {
        const m = raw.match(/(?:SIGMET|WS)\s+([A-Z0-9]+)/i);
        return m ? m[1] : null;
    }

    _distNm(lat1, lon1, lat2, lon2) {
        const R = 3440.065;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }
}
