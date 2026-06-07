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
        this._airmetTangoLayer  = L.layerGroup(); // Turbulence
        this._airmetZuluLayer   = L.layerGroup(); // Icing / Freezing Level
        this._airmetSierraLayer = L.layerGroup(); // IFR / Mountain Obscuration
        this._airmetOtherLayer  = L.layerGroup(); // Unclassified
        this._windsLayer = L.layerGroup();
        this._notamLayer = L.layerGroup();
        this._cwaLayer    = L.layerGroup();
        this._cwaPolygons = [];  // { polygon, advisory, received_at }
        this._pirepMarkers = [];   // { marker, received_at }
        this._sigmetPolygons = []; // { polygon, received_at, expires_at, type }
        this._airmetPolygons = []; // { polygon, received_at, expires_at }
        this._windMarkers = new Map(); // "station:alt" → marker
        this._notamMarkers = [];   // { marker, received_at, expires_at }
        // De-dup internet advisories by raw text to avoid FIS-B double-show
        this._seenAdvisoryKeys = new Set();
        // Track keys of internet-sourced polygons so injectAdvisories can evict stale ones
        this._internetSigmetKeys = new Set();
        this._internetAirmetKeys = new Set();

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

        // Advisory toast + panel
        this._advisoryToast  = null;
        this._advisoryPanel  = null;
        this._advisoryPopup  = null;
        this._startupComplete  = false;
        this._startupToastTimer = null;

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
        // Desktop-only mouse click handler — only registered on non-touch devices so tablet is unaffected
        const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        this._onMapClick = isTouch ? null : (e) => {
            this._handleAdvisoryTap(e.clientX, e.clientY);
        };
    }

    // ========== Public API ==========

    /** Initialize layers and start listening */
    init() {
        // _pirepLayer starts hidden — layer panel checkbox initializes unchecked
        this._sigmetLayer.addTo(this._map);
        this._airmetTangoLayer.addTo(this._map);
        this._airmetZuluLayer.addTo(this._map);
        this._airmetSierraLayer.addTo(this._map);
        this._airmetOtherLayer.addTo(this._map);
        // _windsLayer starts hidden — layer panel checkbox initializes unchecked

        // Build alert container
        this._alertContainer = document.createElement('div');
        this._alertContainer.className = 'fisb-alert-container';
        document.body.appendChild(this._alertContainer);

        this._notamLayer.addTo(this._map);
        this._cwaLayer.addTo(this._map);

        this._fisb.addEventListener('fisb:pirep',  this._onPirep);
        this._fisb.addEventListener('fisb:sigmet', this._onSigmet);
        this._fisb.addEventListener('fisb:airmet', this._onAirmet);
        this._fisb.addEventListener('fisb:cwa',    this._onCwa);
        this._fisb.addEventListener('fisb:winds',  this._onWinds);
        this._fisb.addEventListener('fisb:notam',  this._onNotam);

        // Purge stale markers every 30 seconds
        this._purgeTimer = setInterval(() => this._purgeMarkers(), 30000);

        // Build advisory list panel (hidden until opened)
        this._buildAdvisoryPanel();

        // Register tap/click handlers on map container for SIGMET/AIRMET hit detection
        const container = this._map.getContainer();
        container.addEventListener('touchstart', this._onTapStart, { capture: true, passive: true });
        container.addEventListener('touchend',   this._onTapEnd,   { passive: true });
        if (this._onMapClick) container.addEventListener('click', this._onMapClick);
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
        container.removeEventListener('touchstart', this._onTapStart, { capture: true });
        container.removeEventListener('touchend',   this._onTapEnd);
        if (this._onMapClick) container.removeEventListener('click', this._onMapClick);
        this._pirepLayer.clearLayers();
        this._sigmetLayer.clearLayers();
        this._airmetTangoLayer.clearLayers();
        this._airmetZuluLayer.clearLayers();
        this._airmetSierraLayer.clearLayers();
        this._airmetOtherLayer.clearLayers();
        this._windsLayer.clearLayers();
        this._notamLayer.clearLayers();
        if (this._map.hasLayer(this._pirepLayer)) this._map.removeLayer(this._pirepLayer);
        if (this._map.hasLayer(this._sigmetLayer)) this._map.removeLayer(this._sigmetLayer);
        if (this._map.hasLayer(this._airmetTangoLayer))  this._map.removeLayer(this._airmetTangoLayer);
        if (this._map.hasLayer(this._airmetZuluLayer))   this._map.removeLayer(this._airmetZuluLayer);
        if (this._map.hasLayer(this._airmetSierraLayer)) this._map.removeLayer(this._airmetSierraLayer);
        if (this._map.hasLayer(this._airmetOtherLayer))  this._map.removeLayer(this._airmetOtherLayer);
        if (this._map.hasLayer(this._windsLayer)) this._map.removeLayer(this._windsLayer);
        if (this._map.hasLayer(this._notamLayer)) this._map.removeLayer(this._notamLayer);
        this._cwaLayer.clearLayers();
        if (this._map && this._cwaLayer) this._map.removeLayer(this._cwaLayer);
        this._cwaPolygons = [];
        this._pirepMarkers = [];
        this._sigmetPolygons = [];
        this._airmetPolygons = [];
        this._windMarkers.clear();
        this._notamMarkers = [];
        this._internetSigmetKeys.clear();
        this._internetAirmetKeys.clear();
        this._seenAdvisoryKeys.clear();
        this._activeAlerts.clear();
        this._toastSeen.clear();
        if (this._alertContainer?.parentNode) this._alertContainer.parentNode.removeChild(this._alertContainer);
        if (this._advisoryToast?.parentNode) this._advisoryToast.remove();
        if (this._advisoryPanel?.parentNode) this._advisoryPanel.remove();
        if (this._advisoryPopup) { this._map.closePopup(this._advisoryPopup); this._advisoryPopup = null; }
        clearTimeout(this._startupToastTimer);
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

    /** Show/hide all AIRMET type layers at once. */
    showAirmets() {
        this.showAirmetTango();
        this.showAirmetZulu();
        this.showAirmetSierra();
        this.showAirmetOther();
    }
    hideAirmets() {
        this.hideAirmetTango();
        this.hideAirmetZulu();
        this.hideAirmetSierra();
        this.hideAirmetOther();
    }

    /** Per-type AIRMET show/hide. */
    showAirmetTango()  { if (!this._map.hasLayer(this._airmetTangoLayer))  this._airmetTangoLayer.addTo(this._map); }
    hideAirmetTango()  { if (this._map.hasLayer(this._airmetTangoLayer))   this._map.removeLayer(this._airmetTangoLayer); }
    showAirmetZulu()   { if (!this._map.hasLayer(this._airmetZuluLayer))   this._airmetZuluLayer.addTo(this._map); }
    hideAirmetZulu()   { if (this._map.hasLayer(this._airmetZuluLayer))    this._map.removeLayer(this._airmetZuluLayer); }
    showAirmetSierra() { if (!this._map.hasLayer(this._airmetSierraLayer)) this._airmetSierraLayer.addTo(this._map); }
    hideAirmetSierra() { if (this._map.hasLayer(this._airmetSierraLayer))  this._map.removeLayer(this._airmetSierraLayer); }
    showAirmetOther()  { if (!this._map.hasLayer(this._airmetOtherLayer))  this._airmetOtherLayer.addTo(this._map); }
    hideAirmetOther()  { if (this._map.hasLayer(this._airmetOtherLayer))   this._map.removeLayer(this._airmetOtherLayer); }

    /**
     * Inject internet-fetched advisories into the display.
     * Skips entries already shown via FIS-B (keyed on first 80 chars of raw text).
     * Safe to call repeatedly — deduplicates on the seen-keys set.
     */
    injectAdvisories(sigmets, airmets) {
        // Build the full set of keys the internet is reporting right now
        const newSigKeys = new Set((sigmets || []).map(s => {
            const id = s.sigmetId || FisbWeatherDisplay._extractSigmetId(s.raw);
            return id ? `SIG:${id}` : FisbWeatherDisplay._normKey(s.raw);
        }));
        const newAirKeys = new Set((airmets || []).map(a => FisbWeatherDisplay._normKey(a.raw)));

        // Evict internet-sourced polygons no longer in the current batch.
        // This handles AWC going from 45 → 8 SIGMETs: the 37 dropped entries are
        // removed immediately rather than waiting for their expiry time.
        for (const key of this._internetSigmetKeys) {
            if (newSigKeys.has(key)) continue;
            const idx = this._sigmetPolygons.findIndex(e => e.rawKey === key);
            if (idx >= 0) {
                this._sigmetLayer.removeLayer(this._sigmetPolygons[idx].polygon);
                this._sigmetPolygons.splice(idx, 1);
                this._seenAdvisoryKeys.delete(key);
            }
        }
        this._internetSigmetKeys = newSigKeys;

        for (const key of this._internetAirmetKeys) {
            if (newAirKeys.has(key)) continue;
            const idx = this._airmetPolygons.findIndex(e => e.rawKey === key);
            if (idx >= 0) {
                this._airmetPolygons[idx].layer?.removeLayer(this._airmetPolygons[idx].polygon);
                this._airmetPolygons.splice(idx, 1);
                this._seenAdvisoryKeys.delete(key);
            }
        }
        this._internetAirmetKeys = newAirKeys;

        let newCount = 0;
        for (const s of (sigmets || [])) {
            if (this._addSigmet(s)) newCount++;
        }
        for (const a of (airmets || [])) {
            const key = FisbWeatherDisplay._normKey(a.raw);
            if (this._seenAdvisoryKeys.has(key)) continue;
            this._addAirmet(a);
            newCount++;
        }

        if (newCount > 0) {
            if (!this._startupComplete) {
                // Debounce startup toast — cache load + fresh fetch both call injectAdvisories
                // quickly; wait 3s for both to settle before showing one consolidated toast.
                clearTimeout(this._startupToastTimer);
                this._startupToastTimer = setTimeout(() => {
                    this._startupComplete = true;
                    this._showAdvisoryToast();
                }, 3000);
            } else {
                // Mid-session new advisory — show immediately
                this._showAdvisoryToast();
            }
        }
        this._updateAdvisoryBadge();
    }

    /**
     * Hit-test a screen tap against all visible SIGMET/AIRMET polygons using SVG isPointInFill/Stroke.
     * Collects every polygon that contains the tap point and opens a single consolidated popup.
     */
    _handleAdvisoryTap(clientX, clientY) {
        // LINE advisories (freezing-level contours) are skipped — they're map
        // overlays, not tappable weather areas.
        const allPolygons = [
            ...(this._map.hasLayer(this._sigmetLayer) ? this._sigmetPolygons : []),
            ...this._airmetPolygons.filter(e => !e.isLine && e.layer && this._map.hasLayer(e.layer)),
            ...(this._map.hasLayer(this._cwaLayer) ? this._cwaPolygons : []),
        ];
        if (!allPolygons.length) return;

        // Convert screen tap to geographic coordinates and use ray-casting.
        // SVG getScreenCTM() is unreliable on Android WebView when Leaflet applies
        // CSS pan transforms; geographic point-in-polygon on the advisory's own
        // coordinate data is simpler and has no DOM API dependencies.
        const rect = this._map.getContainer().getBoundingClientRect();
        const latlng = this._map.containerPointToLatLng(
            L.point(clientX - rect.left, clientY - rect.top)
        );

        const hits = [];
        for (const entry of allPolygons) {
            const pts = entry.advisory?.points;
            if (!pts || pts.length < 3) continue;
            if (FisbWeatherDisplay._pointInPolygon(latlng.lat, latlng.lng, pts)) {
                hits.push(entry);
            }
        }

        if (!hits.length) return;
        this._openAdvisoryPopup(hits, clientX, clientY);
    }

    // Ray-casting point-in-polygon for [lat, lon] coordinate arrays.
    static _pointInPolygon(lat, lon, points) {
        let inside = false;
        const n = points.length;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const [yi, xi] = points[i];
            const [yj, xj] = points[j];
            if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    _openAdvisoryPopup(hits, clientX, clientY) {
        hits.sort((a, b) => {
            const aIsSigmet = FisbWeatherDisplay._isSigmetType(a.type);
            const bIsSigmet = FisbWeatherDisplay._isSigmetType(b.type);
            if (aIsSigmet !== bIsSigmet) return aIsSigmet ? -1 : 1;
            // SIGMETs without a base sort to top of their group
            const av = parseAltFt(a.advisory?.base) ?? (aIsSigmet ? -1 : 0);
            const bv = parseAltFt(b.advisory?.base) ?? (bIsSigmet ? -1 : 0);
            return av - bv;
        });

        const rows = hits.map(entry => FisbWeatherDisplay._renderAdvisoryRow(entry)).join('');
        const html = `<div class="adv-tap-popup"><div class="adv-tap-title">Advisories at point</div>${rows}</div>`;

        if (!this._advisoryPopup) {
            this._advisoryPopup = L.popup({ className: 'advisory-tap-popup-container', maxWidth: 420 });
        }
        const container = this._map.getContainer();
        const rect = container.getBoundingClientRect();
        const latlng = this._map.containerPointToLatLng(
            L.point(clientX - rect.left, clientY - rect.top)
        );
        this._advisoryPopup.setLatLng(latlng).setContent(html).openOn(this._map);
        this._wireAdvisoryCloseBtn();
    }

    static _isSigmetType(t) { return t === 'sigmet' || t === 'convective'; }

    /**
     * Dedup key for a SIGMET/AIRMET raw text string.
     * AWC API prepends a WMO teletype header (e.g. "WSUS32 KKCI 151748\nBOST WS 151748\n")
     * that FIS-B broadcasts omit.  Skip to the first SIGMET/AIRMET keyword so both
     * sources produce the same 80-char key for the same physical advisory.
     * Used only for G-AIRMETs and FIS-B AIRMETs — SIGMETs prefer _sigmetKey().
     */
    static _normKey(raw) {
        const s = raw || '';
        const m = s.match(/\b(?:CONVECTIVE SIGMET|SIGMET|AIRMET)\b/i);
        if (!m || m.index === 0) return s.slice(0, 80);
        return s.slice(m.index, m.index + 80);
    }

    /**
     * Extract the stable SIGMET series ID from raw text ("84C", "TANGO 3").
     * Stable across reissuances — valid-until time in raw text changes every 55 min
     * for convective SIGMETs, but the series ID stays constant.
     */
    static _extractSigmetId(raw) {
        const s = raw || '';
        let m = s.match(/\bCONVECTIVE SIGMET\s+([A-Z0-9]+)/i);
        if (!m) m = s.match(/\bSIGMET\s+([A-Z]+\s+\d+)\b/i);   // "TANGO 3"
        if (!m) m = s.match(/\bSIGMET\s+([A-Z0-9]+)/i);         // "TANGO" fallback
        return m ? m[1].trim() : null;
    }

    static _fmtLocalHM(ts) {
        return ts
            ? new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + ' L'
            : '—';
    }

    static _renderAdvisoryRow(entry) {
        const adv = entry.advisory || {};
        const esc = FisbWeatherDisplay._esc;
        const until = FisbWeatherDisplay._fmtLocalHM(adv.expires_at);

        if (entry.type === 'cwa') {
            const preview = esc((adv.raw || '').slice(0, 80));
            const rcvd = FisbWeatherDisplay._fmtLocalHM(entry.received_at || adv.received_at);
            return `<div class="adv-tap-row">
                <span class="adv-tap-badge cwa">CWA</span>
                <div class="adv-tap-detail">
                    <div class="adv-tap-raw">${preview}</div>
                    <div class="adv-tap-valid">Rcvd ${esc(rcvd)}</div>
                </div>
            </div>`;
        }

        if (FisbWeatherDisplay._isSigmetType(entry.type)) {
            const badge = entry.type === 'convective' ? 'CONV SIGMET' : 'SIGMET';
            return `<div class="adv-tap-row sigmet-row">
                <span class="adv-tap-badge sigmet">${esc(badge)}</span>
                <div class="adv-tap-detail">
                    <div class="adv-tap-raw">${esc((adv.raw || '').slice(0, 120))}</div>
                    <div class="adv-tap-valid">Until ${esc(until)}</div>
                </div>
            </div>`;
        }

        const product = adv.product || adv.hazard || 'AIRMET';
        const altBand = formatAdvisoryAltBand(adv);
        const isFrzlvl = (adv.hazard || '').toUpperCase() === 'FRZLVL';
        // For FRZLVL the FZL is already in altBand; for other hazards it's
        // supplementary info — only show below FL180 since aircraft can't fly higher.
        const fzlBase = formatAlt(adv.fzlbase);
        const fzlTop  = formatAlt(adv.fzltop);
        const fzlBaseFt = parseAltFt(adv.fzlbase);
        const fzlStr  = (!isFrzlvl && fzlBase && fzlTop && fzlBaseFt != null && fzlBaseFt < 18000)
                      ? `FRZLVL ${fzlBase}–${fzlTop}`
                      : '';
        const sev = adv.severity || '';
        // For FRZLVL the band already says "FZL X" — suppress the redundant
        // "FRZLVL" hazard text in the description.
        const hazardText = isFrzlvl ? '' : (adv.due_to || adv.hazard || '');
        const descParts = [sev, hazardText, fzlStr].filter(Boolean);
        const sevClass = { LGT: 'sev-lgt', MDT: 'sev-mdt', SEV: 'sev-sev' }[sev] || '';

        return `<div class="adv-tap-row">
            <span class="adv-tap-badge ${esc(product.toLowerCase())}">${esc(product)}</span>
            <div class="adv-tap-detail">
                <div class="adv-tap-alt">${esc(altBand)}</div>
                <div class="adv-tap-desc"><span class="adv-tap-sev ${sevClass}">${esc(descParts.join(' · '))}</span></div>
                <div class="adv-tap-valid">Until ${esc(until)}</div>
            </div>
        </div>`;
    }

    /** Wire the popup's close button once. stopPropagation prevents Leaflet's
     *  tap detector on the map container from firing _onMapClick at the X's
     *  position (which would hit the airport/navaid under it). */
    _wireAdvisoryCloseBtn() {
        const wrapper = this._advisoryPopup.getElement();
        if (!wrapper || wrapper._advisoryCloseBtnWired) return;
        const closeBtn = wrapper.querySelector('.leaflet-popup-close-button');
        if (!closeBtn) return;
        wrapper._advisoryCloseBtnWired = true;
        closeBtn.addEventListener('touchend', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (typeof _wireTapLastTouchAt !== 'undefined') _wireTapLastTouchAt = Date.now();
            this._map.closePopup(this._advisoryPopup);
        }, { passive: false });
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

    // Returns true if a net-new polygon was added (not a replacement or skip).
    _addSigmet(sigmet) {
        // Build the dedup key from the stable series ID when available so reissuances
        // (new WMO timestamp, updated valid-until) replace the stale polygon rather
        // than stacking a duplicate alongside it.
        const id  = sigmet.sigmetId || FisbWeatherDisplay._extractSigmetId(sigmet.raw);
        const key = id ? `SIG:${id}` : FisbWeatherDisplay._normKey(sigmet.raw);

        const existingIdx = this._sigmetPolygons.findIndex(e => e.rawKey === key);
        if (existingIdx >= 0) {
            const existingRaw = this._sigmetPolygons[existingIdx].advisory?.raw;
            if (existingRaw === sigmet.raw) {
                return false; // identical rebroadcast — skip
            }
            // Reissuance: swap out stale polygon for updated one
            this._sigmetLayer.removeLayer(this._sigmetPolygons[existingIdx].polygon);
            this._sigmetPolygons.splice(existingIdx, 1);
            this._seenAdvisoryKeys.delete(key);
            // Fall through to add updated polygon (net count unchanged → return false below)
        } else if (this._seenAdvisoryKeys.has(key)) {
            return false; // key in seen-set but no polygon — shouldn't happen; skip
        }

        const isNew = existingIdx < 0; // true = genuinely new advisory (not a replacement)

        if (!sigmet.points || sigmet.points.length < 3) return false;
        this._seenAdvisoryKeys.add(key);

        const isConvective = sigmet.type === 'convective';
        const style = {
            color: '#ff2222',
            weight: isConvective ? 2 : 1.5,
            fillColor: '#ff2222',
            fillOpacity: 0.12,
            dashArray: isConvective ? '8,4' : null,
        };

        const polygon = L.polygon(sigmet.points, style);
        polygon.addTo(this._sigmetLayer);
        this._sigmetPolygons.push({
            polygon, received_at: sigmet.received_at,
            expires_at: sigmet.expires_at, type: sigmet.type || 'sigmet',
            rawKey: key,
            advisory: sigmet,
        });
        return isNew;
    }

    _addAirmet(airmet) {
        const key = FisbWeatherDisplay._normKey(airmet.raw);
        if (this._seenAdvisoryKeys.has(key)) return;
        this._seenAdvisoryKeys.add(key);
        // FZLVL G-AIRMETs are LINEs (freezing-level contours, often only 2 points
        // for short segments). Other AIRMETs are AREAs and need ≥ 3 points to form
        // a polygon.
        const isLine = airmet.geometryType === 'LINE';
        const minPoints = isLine ? 2 : 3;
        if (!airmet.points || airmet.points.length < minPoints) return;

        // Classify by hazard field first (G-AIRMET), then fall back to raw text (FIS-B/text AIRMET)
        const hazard = (airmet.hazard || '').toUpperCase();
        const raw = airmet.raw || '';
        const isTango  = hazard.startsWith('TURB') || hazard === 'LLW' || hazard === 'LLWS'
                      || /\b(TURB|LLW|LLWS|TURBC)\b/i.test(raw);
        const isZulu   = ['ICING', 'FRZLVL', 'ICE'].includes(hazard)
                      || /\b(ICG|ICING|FRZLVL|FRZE?)\b/i.test(raw);
        const isSierra = ['IFR', 'MTN OBSCN'].includes(hazard)
                      || /\b(IFR|MTN\s*OBS|CIG|VIS)\b/i.test(raw);

        let color, label, layer;
        if (isTango) {
            color = '#ffcc00'; label = 'AIRMET TANGO (Turbulence)'; layer = this._airmetTangoLayer;
        } else if (isZulu) {
            color = '#00ccff'; label = 'AIRMET ZULU (Icing)';       layer = this._airmetZuluLayer;
        } else if (isSierra) {
            color = '#ff44cc'; label = 'AIRMET SIERRA (IFR/Mtn)';   layer = this._airmetSierraLayer;
        } else {
            color = '#ffaa00'; label = 'AIRMET';                     layer = this._airmetOtherLayer;
        }

        const shape = isLine
            ? L.polyline(airmet.points, { color, weight: 2, opacity: 0.7, dashArray: '6,4' })
            : L.polygon(airmet.points, { color, weight: 1.5, fillColor: color, fillOpacity: 0.10 });

        shape.addTo(layer);

        this._airmetPolygons.push({
            polygon: shape, received_at: airmet.received_at,
            expires_at: airmet.expires_at,
            rawKey: key,
            advisory: airmet,
            layer,
            isLine,
        });
    }

    // ========== Advisory Toast & Panel ==========

    /** Show (or refresh) the consolidated red advisory toast. */
    _showAdvisoryToast() {
        const sigmetCount = this._sigmetPolygons.length;
        const airmetCount = this._airmetPolygons.length;
        if (sigmetCount === 0 && airmetCount === 0) return;

        // Dismiss any existing toast before creating a fresh one
        if (this._advisoryToast?.parentNode) this._advisoryToast.remove();

        const parts = [];
        if (sigmetCount > 0) parts.push(`${sigmetCount} SIGMET${sigmetCount !== 1 ? 'S' : ''}`);
        if (airmetCount > 0) parts.push(`${airmetCount} AIRMET${airmetCount !== 1 ? 'S' : ''}`);

        const toast = document.createElement('div');
        toast.className = 'wx-adv-toast';
        toast.innerHTML = `
            <div class="wx-adv-toast-icon">&#9888;</div>
            <div class="wx-adv-toast-body">
                <div class="wx-adv-toast-title">WEATHER ADVISORY</div>
                <div class="wx-adv-toast-sub">${parts.join(' &middot; ')} ACTIVE</div>
            </div>
            <button class="wx-adv-toast-view">VIEW</button>
            <button class="wx-adv-toast-close">&#x2715;</button>`;
        document.body.appendChild(toast);
        this._advisoryToast = toast;

        toast.querySelector('.wx-adv-toast-view').addEventListener('click', () => {
            this.openAdvisoryPanel();
            toast.remove();
            this._advisoryToast = null;
        });
        toast.querySelector('.wx-adv-toast-close').addEventListener('click', () => {
            toast.remove();
            this._advisoryToast = null;
        });

        // Auto-dismiss after 60 seconds
        setTimeout(() => {
            if (toast.parentNode) { toast.remove(); this._advisoryToast = null; }
        }, 60000);
    }

    /** Build the advisory list panel and attach to document body (initially hidden). */
    _buildAdvisoryPanel() {
        const panel = document.createElement('div');
        panel.className = 'wx-adv-panel';
        panel.innerHTML = `
            <div class="wx-adv-panel-header">
                <span class="wx-adv-panel-title">&#9888; ACTIVE SIGMETS</span>
                <span class="wx-adv-panel-count">0</span>
                <button class="wx-adv-panel-close">&#x2715;</button>
            </div>
            <div class="wx-adv-panel-scroll"></div>`;
        panel.querySelector('.wx-adv-panel-close').addEventListener('click', () => {
            panel.classList.remove('visible');
        });
        document.body.appendChild(panel);
        this._advisoryPanel = panel;

        // Wire the status-bar badge (may not exist yet if init runs early, so use delegation)
        const badge = document.getElementById('statusAdvisory');
        if (badge) badge.addEventListener('click', () => this.openAdvisoryPanel());
    }

    /** Update the status-bar WX badge with current advisory count. */
    _updateAdvisoryBadge() {
        const el = document.getElementById('statusAdvisory');
        if (!el) return;
        const count = this._sigmetPolygons.length + this._airmetPolygons.length + this._cwaPolygons.length;
        if (count === 0) {
            el.hidden = true;
        } else {
            el.textContent = `WX ${count}`;
            el.hidden = false;
        }
    }

    /** Open the advisory list panel and render current active advisories. */
    openAdvisoryPanel() {
        if (!this._advisoryPanel) return;
        this._renderAdvisoryPanel();
        this._advisoryPanel.classList.add('visible');
    }

    _renderAdvisoryPanel() {
        const now = Date.now();
        const active = (entries) => entries.filter(e => !e.expires_at || e.expires_at > now);

        const sigmets    = active(this._sigmetPolygons);
        const convective = sigmets.filter(e => e.type === 'convective');
        const nonConv    = sigmets.filter(e => e.type !== 'convective');
        const total      = sigmets.length;

        this._advisoryPanel.querySelector('.wx-adv-panel-count').textContent = total || '';

        const scroll = this._advisoryPanel.querySelector('.wx-adv-panel-scroll');

        const renderSection = (label, entries, rowClass, badge) => {
            if (!entries.length) return '';
            let html = `<div class="wx-adv-section-label">${label} (${entries.length})</div>`;
            for (const e of entries) {
                const detail = this._formatAdvisoryDetail(e.advisory?.raw || '');
                const until  = e.expires_at ? this._fmtUtcTime(e.expires_at) : '';
                html += `<div class="wx-adv-row ${rowClass}">
                    <span class="wx-adv-row-badge">${badge}</span>
                    <span class="wx-adv-row-detail">${FisbWeatherDisplay._esc(detail)}</span>
                    ${until ? `<span class="wx-adv-row-time">UNTIL ${until}</span>` : ''}
                </div>`;
            }
            return html;
        };

        let html = '';
        html += renderSection('CONVECTIVE SIGMET', convective, 'wx-adv-row-sigmet', 'CONV SIGMET');
        html += renderSection('SIGMET',            nonConv,    'wx-adv-row-sigmet', 'SIGMET');

        if (!html) html = '<p class="wx-adv-empty">No active SIGMETs · Tap AIRMET polygons on map for details</p>';
        scroll.innerHTML = html;
    }

    /** Strip G-AIRMET coordinate anchor and VALID timestamp; return human-readable detail. */
    _formatAdvisoryDetail(raw) {
        return (raw || '')
            .replace(/^G-AIRMET\s+\S+\s+\S+\s+\[[^\]]+\]:\s*/, '')
            .replace(/\s+VALID\s+\S+\s*$/, '')
            .trim() || raw;
    }

    _fmtUtcTime(ts) {
        const d = new Date(ts);
        return `${String(d.getUTCHours()).padStart(2,'0')}${String(d.getUTCMinutes()).padStart(2,'0')}Z`;
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

        if (!cwa.points || cwa.points.length < 3) return;

        const polygon = L.polygon(cwa.points, {
            color: '#ff6600',
            weight: 2,
            fillColor: '#ff6600',
            fillOpacity: 0.18,
        });
        polygon.bindPopup(
            `<div style="font-family:var(--font-ui);max-width:320px">
                <div style="font-weight:800;color:var(--text-secondary);margin-bottom:4px">CWA</div>
                <div style="font-size:0.85rem;color:var(--text-primary);white-space:pre-wrap">${FisbWeatherDisplay._esc(cwa.raw)}</div>
                <div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">Rcvd ${new Date(cwa.received_at).toISOString().slice(11, 16)}Z</div>
            </div>`,
            { minWidth: 300, maxWidth: 380, className: 'cwa-popup' }
        );
        polygon.addTo(this._cwaLayer);
        this._cwaPolygons.push({ polygon, advisory: cwa, received_at: cwa.received_at, type: 'cwa' });
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
                entry.layer?.removeLayer(entry.polygon);
                if (entry.rawKey) this._seenAdvisoryKeys.delete(entry.rawKey);
                return false;
            }
            return true;
        });

        // Expired CWAs (2-hour window)
        this._cwaPolygons = this._cwaPolygons.filter(entry => {
            if (now - entry.received_at > 2 * 3600000) {
                this._cwaLayer.removeLayer(entry.polygon);
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

        this._updateAdvisoryBadge();
    }
}
