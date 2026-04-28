/**
 * FlyPi — FIS-B Weather Display Manager
 * Renders PIREPs, SIGMETs, AIRMETs on the map. Manages weather strip and alerts.
 */

class FisbWeatherDisplay {
    /** Escape HTML entities to prevent XSS from raw FIS-B text */
    static _esc(s) {
        if (!s) return '';
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Altitude levels to display and their colors
    static WIND_ALTS = [
        { ft: 3000,  label: '3k',  color: '#ffffff' },
        { ft: 6000,  label: '6k',  color: '#00ffcc' },
        { ft: 9000,  label: '9k',  color: '#ffee00' },
        { ft: 12000, label: '12k', color: '#ff8800' },
    ];

    constructor(fisbClient, map) {
        this._fisb = fisbClient;
        this._map = map;

        // Map layers
        this._pirepLayer = L.layerGroup();
        this._sigmetLayer = L.layerGroup();
        this._airmetLayer = L.layerGroup();
        this._windsLayer = L.layerGroup();
        this._notamLayer = L.layerGroup();
        this._pirepMarkers = [];   // { marker, received_at }
        this._sigmetPolygons = []; // { polygon, received_at, expires_at, type }
        this._airmetPolygons = []; // { polygon, received_at, expires_at }
        this._windMarkers = new Map(); // "station:alt" → marker
        this._notamMarkers = [];   // { marker, received_at, expires_at }
        // De-dup internet advisories by raw text to avoid FIS-B double-show
        this._seenAdvisoryKeys = new Set();

        // Alert state
        this._activeAlerts = new Map(); // key → DOM element
        this._alertContainer = null;
        // 30-min de-dup for toast notifications: key → expiry timestamp
        this._toastSeen = new Map();

        // Route airports for weather strip
        this._routeAirports = [];

        // Bind event handlers
        this._onPirep  = (e) => this._addPirep(e.detail);
        this._onSigmet = (e) => this._addSigmet(e.detail);
        this._onAirmet = (e) => this._addAirmet(e.detail);
        this._onCwa    = (e) => this._showCwaAlert(e.detail);
        this._onWinds  = ()  => this._refreshWindBarbs();
        this._onNotam  = (e) => this._addNotam(e.detail);
        this._maxAlerts = 8;

        // Purge timer
        this._purgeTimer = null;

        // Touch tap handler (Leaflet's tap plugin is disabled — bindPopup click unreliable on tablet)
        this._tapStart = null;
        this._onTapStart = (e) => {
            if (e.touches.length === 1)
                this._tapStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
            else
                this._tapStart = null;
        };
        this._onTapEnd = (e) => {
            if (!this._tapStart || e.changedTouches.length !== 1) { this._tapStart = null; return; }
            const ts = this._tapStart; this._tapStart = null;
            const dx = e.changedTouches[0].clientX - ts.x;
            const dy = e.changedTouches[0].clientY - ts.y;
            if (dx*dx + dy*dy > 400) return; // > 20px = pan, not tap
            this._handleAdvisoryTap(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
        };
    }

    // ========== Public API ==========

    /** Initialize layers and start listening */
    init() {
        // _pirepLayer starts hidden — layer panel checkbox initializes unchecked
        this._sigmetLayer.addTo(this._map);
        this._airmetLayer.addTo(this._map);
        // _windsLayer starts hidden — layer panel checkbox initializes unchecked

        // Build alert container
        this._alertContainer = document.createElement('div');
        this._alertContainer.className = 'fisb-alert-container';
        document.body.appendChild(this._alertContainer);

        this._notamLayer.addTo(this._map);

        this._fisb.addEventListener('fisb:pirep',  this._onPirep);
        this._fisb.addEventListener('fisb:sigmet', this._onSigmet);
        this._fisb.addEventListener('fisb:airmet', this._onAirmet);
        this._fisb.addEventListener('fisb:cwa',    this._onCwa);
        this._fisb.addEventListener('fisb:winds',  this._onWinds);
        this._fisb.addEventListener('fisb:notam',  this._onNotam);

        // Purge stale markers every 30 seconds
        this._purgeTimer = setInterval(() => this._purgeMarkers(), 30000);

        // Register touch handlers on map container for reliable SIGMET/AIRMET tap detection
        const container = this._map.getContainer();
        container.addEventListener('touchstart', this._onTapStart, { capture: false, passive: true });
        container.addEventListener('touchend',   this._onTapEnd,   { passive: true });
    }

    /** Set route airports (kept for API compatibility) */
    setRouteAirports(icaoList) {
        this._routeAirports = icaoList || [];
    }

    /** Clean up */
    destroy() {
        this._fisb.removeEventListener('fisb:pirep',  this._onPirep);
        this._fisb.removeEventListener('fisb:sigmet', this._onSigmet);
        this._fisb.removeEventListener('fisb:airmet', this._onAirmet);
        this._fisb.removeEventListener('fisb:cwa',    this._onCwa);
        this._fisb.removeEventListener('fisb:winds',  this._onWinds);
        this._fisb.removeEventListener('fisb:notam',  this._onNotam);
        if (this._purgeTimer) { clearInterval(this._purgeTimer); this._purgeTimer = null; }
        const container = this._map.getContainer();
        container.removeEventListener('touchstart', this._onTapStart, { capture: false });
        container.removeEventListener('touchend',   this._onTapEnd);
        this._pirepLayer.clearLayers();
        this._sigmetLayer.clearLayers();
        this._airmetLayer.clearLayers();
        this._windsLayer.clearLayers();
        this._notamLayer.clearLayers();
        if (this._map.hasLayer(this._pirepLayer)) this._map.removeLayer(this._pirepLayer);
        if (this._map.hasLayer(this._sigmetLayer)) this._map.removeLayer(this._sigmetLayer);
        if (this._map.hasLayer(this._airmetLayer)) this._map.removeLayer(this._airmetLayer);
        if (this._map.hasLayer(this._windsLayer)) this._map.removeLayer(this._windsLayer);
        if (this._map.hasLayer(this._notamLayer)) this._map.removeLayer(this._notamLayer);
        this._pirepMarkers = [];
        this._sigmetPolygons = [];
        this._airmetPolygons = [];
        this._windMarkers.clear();
        this._notamMarkers = [];
        this._seenAdvisoryKeys.clear();
        this._activeAlerts.clear();
        this._toastSeen.clear();
        if (this._alertContainer?.parentNode) this._alertContainer.parentNode.removeChild(this._alertContainer);
    }

    // ========== Winds Aloft ==========

    /** Rebuild all wind barb markers from current fisbClient.winds data. */
    _refreshWindBarbs() {
        this._windsLayer.clearLayers();
        this._windMarkers.clear();

        const winds = this._fisb.winds;
        if (!winds || winds.size === 0) return;

        // Group by station (lat/lon)
        const stations = new Map(); // station → { lat, lon, winds: [{ft, dir, spd, temp, color}] }
        for (const [key, w] of winds) {
            if (w.lat == null || w.lon == null) continue;
            const altDef = FisbWeatherDisplay.WIND_ALTS.find(a => a.ft === w.alt);
            if (!altDef) continue;

            if (!stations.has(w.station)) {
                stations.set(w.station, { lat: w.lat, lon: w.lon, winds: [] });
            }
            stations.get(w.station).winds.push({ ...w, color: altDef.color, label: altDef.label });
        }

        for (const [station, info] of stations) {
            const marker = this._buildWindMarker(station, info);
            if (marker) {
                marker.addTo(this._windsLayer);
                this._windMarkers.set(station, marker);
            }
        }
    }

    /** Build a Leaflet divIcon marker for all altitude wind layers at one station. */
    _buildWindMarker(station, info) {
        if (!info.winds.length) return null;

        // Sort altitudes low → high
        info.winds.sort((a, b) => a.ft - b.ft);

        // Build rows for each altitude
        const rows = info.winds.map(w => {
            const calm = w.spd < 3;
            const arrowStyle = calm ? '' :
                `display:inline-block;transform:rotate(${w.dir}deg);margin-right:2px;`;
            const arrow = calm ? '○' : '↑';
            const spd = calm ? 'calm' : `${w.spd}kt`;
            const temp = w.temp != null ? ` ${w.temp}°` : '';
            return `<div class="wb-row" style="color:${w.color}">` +
                   `<span style="${arrowStyle}">${arrow}</span>` +
                   `<span class="wb-alt">${w.label}</span>` +
                   `<span class="wb-spd">${spd}${temp}</span>` +
                   `</div>`;
        }).join('');

        const html = `<div class="wind-barb-icon">${rows}</div>`;
        const icon = L.divIcon({
            className: '',
            html,
            // No iconSize — let the div auto-size to its content so the
            // background always surrounds all rows regardless of text length.
            iconAnchor: [0, info.winds.length * 11],
        });

        const marker = L.marker([info.lat, info.lon], { icon, zIndexOffset: 100, interactive: true });

        // Popup with full wind table
        const tableRows = info.winds.map(w => {
            const dir = w.spd < 3 ? 'Calm' : `${w.dir}°`;
            const temp = w.temp != null ? `${w.temp}°C` : '—';
            return `<tr><td>${w.label}</td><td>${dir}</td><td>${w.spd}kt</td><td>${temp}</td></tr>`;
        }).join('');
        marker.bindPopup(
            `<div class="winds-popup"><b>${station}</b>` +
            `<table class="winds-table"><tr><th>Alt</th><th>Dir</th><th>Spd</th><th>Temp</th></tr>` +
            `${tableRows}</table></div>`,
            { maxWidth: 220 }
        );

        return marker;
    }

    /** Show/hide PIREP layer. */
    showPireps() { if (!this._map.hasLayer(this._pirepLayer)) this._pirepLayer.addTo(this._map); }
    hidePireps() { if (this._map.hasLayer(this._pirepLayer)) this._map.removeLayer(this._pirepLayer); }
    get pireipsVisible() { return this._map.hasLayer(this._pirepLayer); }

    /** Show/hide SIGMET layer. */
    showSigmets() { if (!this._map.hasLayer(this._sigmetLayer)) this._sigmetLayer.addTo(this._map); }
    hideSigmets() { if (this._map.hasLayer(this._sigmetLayer)) this._map.removeLayer(this._sigmetLayer); }
    get sigmetsVisible() { return this._map.hasLayer(this._sigmetLayer); }

    /** Show/hide AIRMET layer. */
    showAirmets() { if (!this._map.hasLayer(this._airmetLayer)) this._airmetLayer.addTo(this._map); }
    hideAirmets() { if (this._map.hasLayer(this._airmetLayer)) this._map.removeLayer(this._airmetLayer); }
    get airmetsVisible() { return this._map.hasLayer(this._airmetLayer); }

    /**
     * Inject internet-fetched advisories into the display.
     * Skips entries already shown via FIS-B (keyed on first 80 chars of raw text).
     * Safe to call repeatedly — deduplicates on the seen-keys set.
     */
    injectAdvisories(sigmets, airmets) {
        for (const s of (sigmets || [])) {
            const key = (s.raw || '').slice(0, 80);
            if (this._seenAdvisoryKeys.has(key)) continue;
            this._seenAdvisoryKeys.add(key);
            this._addSigmet(s);
        }
        for (const a of (airmets || [])) {
            const key = (a.raw || '').slice(0, 80);
            if (this._seenAdvisoryKeys.has(key)) continue;
            this._seenAdvisoryKeys.add(key);
            this._addAirmet(a);
        }
    }

    /**
     * Hit-test a screen tap against all visible SIGMET/AIRMET polygons using SVG isPointInFill/Stroke.
     * Opens the popup of the first polygon that contains the tap point.
     */
    _handleAdvisoryTap(clientX, clientY) {
        const allPolygons = [
            ...(this._map.hasLayer(this._sigmetLayer) ? this._sigmetPolygons : []),
            ...(this._map.hasLayer(this._airmetLayer) ? this._airmetPolygons : []),
        ];
        if (!allPolygons.length) return;

        for (const entry of allPolygons) {
            const svgPath = entry.polygon.getElement();
            if (!svgPath) continue;
            const svg = svgPath.ownerSVGElement;
            if (!svg) continue;
            try {
                const pt = svg.createSVGPoint();
                pt.x = clientX;
                pt.y = clientY;
                const local = pt.matrixTransform(svgPath.getScreenCTM().inverse());
                if (svgPath.isPointInFill(local) || svgPath.isPointInStroke(local)) {
                    entry.polygon.openPopup();
                    return;
                }
            } catch (_) { /* element not in DOM yet */ }
        }
    }

    /** Show/hide winds layer. */
    showWinds() { if (!this._map.hasLayer(this._windsLayer)) this._windsLayer.addTo(this._map); }
    hideWinds() { if (this._map.hasLayer(this._windsLayer)) this._map.removeLayer(this._windsLayer); }
    toggleWinds() {
        if (this._map.hasLayer(this._windsLayer)) { this._map.removeLayer(this._windsLayer); return false; }
        this._windsLayer.addTo(this._map); return true;
    }
    get windsVisible() { return this._map.hasLayer(this._windsLayer); }

    // ========== PIREP Markers ==========

    _addPirep(pirep) {
        if (pirep.lat == null || pirep.lon == null) return;

        // Icon based on type
        const isIcing = pirep.type === 'icing';
        const isTurb = pirep.type === 'turbulence';
        const isUrgent = pirep.is_urgent;

        let color, symbol;
        if (isTurb) {
            color = pirep.severity >= 3 ? '#ff4444' : '#ffaa00';
            symbol = '\u25B2'; // ▲
        } else if (isIcing) {
            color = pirep.severity >= 3 ? '#ff4444' : '#44aaff';
            symbol = '\u2744'; // ❄
        } else {
            color = '#aaaaaa';
            symbol = '\u25CF'; // ●
        }

        if (isUrgent) color = '#ff0000';

        const icon = L.divIcon({
            className: 'pirep-marker',
            html: `<span style="color:${color};font-size:${isUrgent ? 18 : 14}px;text-shadow:0 0 3px #000;">${symbol}</span>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
        });

        const marker = L.marker([pirep.lat, pirep.lon], { icon, zIndexOffset: 200 });

        // Popup with raw PIREP text
        const altStr = pirep.altitude ? `FL${Math.round(pirep.altitude / 100)}` : '';
        marker.bindPopup(`<div class="pirep-popup">
            <div class="pirep-header">${isUrgent ? 'URGENT ' : ''}PIREP ${altStr}</div>
            <div class="pirep-text">${FisbWeatherDisplay._esc(pirep.raw)}</div>
            <div class="pirep-age">Received ${new Date(pirep.received_at).toISOString().slice(11, 16)}Z</div>
        </div>`, { className: 'pirep-popup-container', maxWidth: 320 });

        marker.addTo(this._pirepLayer);
        this._pirepMarkers.push({ marker, received_at: pirep.received_at });

        // Alert if urgent and near route
        if (isUrgent) {
            this._showAlert(`UUA PIREP: ${pirep.raw.slice(0, 80)}...`, 'amber', 30000);
        }
    }

    // ========== SIGMET/AIRMET Polygons ==========

    _addSigmet(sigmet) {
        this._seenAdvisoryKeys.add((sigmet.raw || '').slice(0, 80));
        if (!sigmet.points || sigmet.points.length < 3) return;

        const isConvective = sigmet.type === 'convective';
        const style = {
            color: '#ff2222',
            weight: isConvective ? 2 : 1.5,
            fillColor: '#ff2222',
            fillOpacity: 0.12,
            dashArray: isConvective ? '8,4' : null,
        };

        const polygon = L.polygon(sigmet.points, style);
        polygon.bindPopup(`<div class="sigmet-popup">
            <div class="sigmet-header">${isConvective ? 'CONVECTIVE ' : ''}SIGMET</div>
            <div class="sigmet-text">${FisbWeatherDisplay._esc(sigmet.raw)}</div>
        </div>`, { minWidth: 480, maxWidth: 600, className: 'sigmet-popup-container' });

        polygon.addTo(this._sigmetLayer);
        this._sigmetPolygons.push({
            polygon, received_at: sigmet.received_at,
            expires_at: sigmet.expires_at, type: 'sigmet',
            rawKey: (sigmet.raw || '').slice(0, 80),
        });

    }

    _addAirmet(airmet) {
        this._seenAdvisoryKeys.add((airmet.raw || '').slice(0, 80));
        if (!airmet.points || airmet.points.length < 3) return;

        // Determine AIRMET type from raw text for color coding
        const raw = airmet.raw || '';
        const isZulu   = /\b(ICG|ICING|FRZLVL|FRZE?)\b/i.test(raw);
        const isTango  = /\b(TURB|LLW|LLWS|TURBC)\b/i.test(raw);
        const isSierra = /\b(IFR|MTN\s*OBS|CIG|VIS)\b/i.test(raw);

        let color, label;
        if (isZulu) {
            color = '#00ccff'; label = 'AIRMET ZULU (Icing)';
        } else if (isTango) {
            color = '#ffcc00'; label = 'AIRMET TANGO (Turbulence)';
        } else if (isSierra) {
            color = '#ff44cc'; label = 'AIRMET SIERRA (IFR/Mtn)';
        } else {
            color = '#ffaa00'; label = 'AIRMET';
        }

        const polygon = L.polygon(airmet.points, {
            color,
            weight: 1.5,
            fillColor: color,
            fillOpacity: 0.10,
        });

        polygon.bindPopup(`<div class="airmet-popup">
            <div class="airmet-header">${FisbWeatherDisplay._esc(label)}</div>
            <div class="airmet-text">${FisbWeatherDisplay._esc(raw)}</div>
        </div>`, { minWidth: 480, maxWidth: 600, className: 'airmet-popup-container' });

        polygon.addTo(this._airmetLayer);
        this._airmetPolygons.push({
            polygon, received_at: airmet.received_at,
            expires_at: airmet.expires_at,
            rawKey: (airmet.raw || '').slice(0, 80),
        });

    }

    // ========== Alerts ==========

    _showAlert(message, severity = 'blue', duration = 30000) {
        const key = message.slice(0, 40);
        // Don't duplicate same alert
        if (this._activeAlerts.has(key)) return;

        // Cap max simultaneous alerts — remove oldest if exceeded
        if (this._activeAlerts.size >= this._maxAlerts) {
            const oldest = this._activeAlerts.keys().next().value;
            const oldEl = this._activeAlerts.get(oldest);
            if (oldEl?.parentNode) oldEl.remove();
            this._activeAlerts.delete(oldest);
        }

        const banner = document.createElement('div');
        banner.className = `fisb-alert fisb-alert-${severity}`;
        banner.innerHTML = `<span class="fisb-alert-text">${FisbWeatherDisplay._esc(message)}</span>`;
        banner.addEventListener('click', () => {
            banner.remove();
            this._activeAlerts.delete(key);
        });

        this._alertContainer.appendChild(banner);
        this._activeAlerts.set(key, banner);

        if (duration) {
            setTimeout(() => {
                if (banner.parentNode) banner.remove();
                this._activeAlerts.delete(key);
            }, duration);
        }
    }

    _showCwaAlert(cwa) {
        this._showAlert(`CWA: ${cwa.raw.slice(0, 100)}`, 'amber', 30000);
    }

    /** Toast with 30-minute de-duplication. rawKey is the raw text used for dedup (key = first 40 chars). */
    _toastAlert(message, severity, duration, rawKey) {
        const key = (rawKey || message).slice(0, 40);
        const now = Date.now();
        const seenUntil = this._toastSeen.get(key);
        if (seenUntil && seenUntil > now) return;
        this._toastSeen.set(key, now + 30 * 60000);
        this._showAlert(message, severity, duration);
    }

    // ========== NOTAM Markers ==========

    _addNotam(notam) {
        const raw = notam.raw || '';
        const icaoStr = notam.icao ? `${notam.icao} ` : '';
        // Only toast when there is decoded human-readable text — skip binary-encoded
        // NOTAMs (product IDs 11/12) where raw is a JSON dump with no Text field.
        if (notam.plain?.trim()) {
            this._toastAlert(`\ud83d\udccb NOTAM: ${icaoStr}${raw.slice(0, 80)}`, 'amber', 20000, raw);
        }

        if (notam.lat == null || notam.lon == null) return;

        const icon = L.divIcon({
            className: 'notam-marker',
            html: `<span style="font-size:16px;text-shadow:0 0 3px #000;">\ud83d\udccb</span>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
        });

        const marker = L.marker([notam.lat, notam.lon], { icon, zIndexOffset: 150 });
        const icaoHeader = notam.icao ? `<b>${FisbWeatherDisplay._esc(notam.icao)}</b> — ` : '';
        marker.bindPopup(`<div class="notam-popup">
            <div class="notam-header">${icaoHeader}NOTAM</div>
            <div class="notam-text">${FisbWeatherDisplay._esc(raw)}</div>
            <div class="notam-age">Received ${new Date(notam.received_at).toISOString().slice(11, 16)}Z</div>
        </div>`, { maxWidth: 340 });

        marker.addTo(this._notamLayer);
        this._notamMarkers.push({ marker, received_at: notam.received_at, expires_at: notam.expires_at });
    }

    /** Show/hide NOTAM layer. */
    showNotams() { if (!this._map.hasLayer(this._notamLayer)) this._notamLayer.addTo(this._map); }
    hideNotams() { if (this._map.hasLayer(this._notamLayer)) this._map.removeLayer(this._notamLayer); }
    toggleNotams() {
        if (this._map.hasLayer(this._notamLayer)) { this._map.removeLayer(this._notamLayer); return false; }
        this._notamLayer.addTo(this._map); return true;
    }
    get notamsVisible() { return this._map.hasLayer(this._notamLayer); }

    // ========== Purge ==========

    _purgeMarkers() {
        const now = Date.now();

        // PIREPs older than 60 minutes
        this._pirepMarkers = this._pirepMarkers.filter(entry => {
            if (now - entry.received_at > 60 * 60000) {
                this._pirepLayer.removeLayer(entry.marker);
                return false;
            }
            return true;
        });

        // Expired SIGMETs
        this._sigmetPolygons = this._sigmetPolygons.filter(entry => {
            const expired = entry.expires_at && entry.expires_at < now;
            const tooOld = now - entry.received_at > 4 * 3600000;
            if (expired || tooOld) {
                this._sigmetLayer.removeLayer(entry.polygon);
                if (entry.rawKey) this._seenAdvisoryKeys.delete(entry.rawKey);
                return false;
            }
            return true;
        });

        // Expired AIRMETs
        this._airmetPolygons = this._airmetPolygons.filter(entry => {
            const expired = entry.expires_at && entry.expires_at < now;
            const tooOld = now - entry.received_at > 4 * 3600000;
            if (expired || tooOld) {
                this._airmetLayer.removeLayer(entry.polygon);
                if (entry.rawKey) this._seenAdvisoryKeys.delete(entry.rawKey);
                return false;
            }
            return true;
        });

        // Expired NOTAM markers
        this._notamMarkers = this._notamMarkers.filter(entry => {
            const expired = entry.expires_at && entry.expires_at < now;
            const tooOld = now - entry.received_at > 4 * 3600000;
            if (expired || tooOld) {
                this._notamLayer.removeLayer(entry.marker);
                return false;
            }
            return true;
        });

        // Purge stale toast-seen keys
        for (const [key, expiry] of this._toastSeen) {
            if (expiry < now) this._toastSeen.delete(key);
        }
    }
}
