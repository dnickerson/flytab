/**
 * FlyTab — Emergency Glide Calculator (Engine ML Scenario 6)
 * On joint physics + ML confirmation of serious power loss, computes
 * reachable airports within glide range and displays a ranked emergency
 * routing overlay with headings and descent profiles.
 *
 * Trigger (both required — dual-layer to prevent false alarms):
 *   1. Physics rules: MAP drop >5" OR RPM drop >300 OR oil_press <20 PSI
 *   2. ML anomaly: result.anomaly === true
 *
 * Tapping an airport opens a live approach guidance panel (1 Hz updates):
 *   - Heading and distance to threshold
 *   - Altitude profile: target MSL, ON PROFILE / HIGH / LOW status
 *   - Required vs actual vertical speed
 *   - Best runway based on wind (METAR or nearest METAR fallback)
 *   - CTAF / Tower frequencies
 */

class EmergencyGlide {
    constructor() {
        this._overlay = null;
        this._overlayBody = null;
        this._lastTriggerTime = 0;
        this._COOLDOWN_MS = 60_000;   // debounce: don't re-trigger within 60s
        this._eventLog = [];           // post-flight event log (in-memory)

        // Approach guidance state
        this._approachApt = null;
        this._approachTop3 = null;
        this._approachEvent = null;
        this._testMode = false;
        this._rankedAirports = [];
        this._approachInterval = null;
        this._approachWindInterval = null;
        this._approachWind = null;
        this._approachLine = null;
        this._glideRatio = 10.0;

        window.emergencyGlide = this;
    }

    /**
     * Called when both physics rules AND ML anomaly confirm power loss.
     * @param {Object}  [options.engineRaw]       — raw engine data frame
     * @param {Object}  [options.engineData]      — alias for engineRaw
     * @param {Object}  [options.mlResult]        — EngineML processSample result
     * @param {boolean} [options.testMode=false]  — simulation / test run (bypasses cooldown)
     */
    async trigger(options = {}) {
        const { engineRaw: engineRawOpt, engineData, mlResult, testMode = false } = options;
        const engineRaw = engineRawOpt ?? engineData;

        const now = Date.now();
        if (!testMode && now - this._lastTriggerTime < this._COOLDOWN_MS) return;
        if (!testMode) this._lastTriggerTime = now;

        console.warn('[EmergencyGlide] TRIGGERED — computing glide options', { testMode });

        const sit = window.app?.stratuxClient?.situation ?? window.stratuxClient?.situation;
        const lat = sit?.lat;
        const lon = sit?.lon;
        const altMsl = sit?.alt_msl ?? 0;

        if (!lat || !lon) {
            console.warn('[EmergencyGlide] No GPS position — cannot compute glide range');
            this._showNoGpsOverlay(testMode);
            return;
        }

        // Altitude AGL: MSL minus terrain elevation at current position
        const terrainElev = window.terrainGrid?.isLoaded
            ? window.terrainGrid.getElevationFt(lat, lon)
            : 0;
        const rawAltAgl = Math.max(altMsl - terrainElev, 0);
        // In test mode simulate configured altitude AGL so airports are visible during ground testing
        const testAltAgl = (() => {
            try { return CockpitConfig.aircraft('performance.test_alt_agl_ft') ?? 5000; }
            catch (_) { return 5000; }
        })();
        const altAgl = (testMode && rawAltAgl < 2000) ? testAltAgl : rawAltAgl;

        // Glide ratio from aircraft config (default 10.0 for RV-9A)
        const glideRatio = (() => {
            try {
                return (typeof CockpitConfig !== 'undefined')
                    ? (CockpitConfig.aircraft('performance.glide_ratio') ?? 10.0)
                    : 10.0;
            } catch (_) { return 10.0; }
        })();

        // Nominal glide range in nautical miles (1 NM = 6076.12 ft)
        const glideRangeNm = (altAgl * glideRatio) / 6076;

        // Wind-adjust glide radius (uses ground speed vs glide speed as proxy)
        const adjustedRangeNm = this._windAdjustRange(glideRangeNm, sit);

        // Query NASR airports within glide range
        let airports = [];
        if (window.app?._nasrDb) {
            try {
                airports = await window.app._nasrDb.getAirportsNear(lat, lon, adjustedRangeNm);
            } catch (err) {
                console.error('[EmergencyGlide] Airport query failed:', err);
            }
        }

        // Rank airports by suitability
        const ranked = this._rankAirports(airports, lat, lon, altAgl, sit);

        // Store for approach guidance
        this._rankedAirports = ranked;
        this._glideRatio = glideRatio;

        // Build event payload for dispatch and logging
        const event = {
            timestamp: new Date().toISOString(),
            lat, lon,
            alt_msl: Math.round(altMsl),
            alt_agl: Math.round(altAgl),
            terrain_elev_ft: Math.round(terrainElev),
            glide_ratio: glideRatio,
            glide_range_nm: parseFloat(glideRangeNm.toFixed(1)),
            adjusted_range_nm: parseFloat(adjustedRangeNm.toFixed(1)),
            ml_score: mlResult?.score ?? null,
            ml_phase: mlResult?.phase ?? null,
            airports_in_range: airports.length,
            test: testMode,
            top_options: ranked.slice(0, 3).map(a => ({
                icao: a.icao,
                name: a.name,
                dist_nm: a._distNm,
                hdg: a._hdg,
                longest_rwy_ft: a.longest_rwy_ft,
                has_paved_rwy: a.has_paved_rwy,
                required_descent_fpm: a._descentFpm,
                reachable: a._reachable,
            })),
        };

        // Persist to localStorage for post-flight review
        this._persistLog(event);
        this._eventLog.push(event);

        // Dispatch custom event with full ranked array
        document.dispatchEvent(new CustomEvent('engineml:emergency', {
            detail: { ...event, ranked },
        }));

        // Show full-screen overlay
        this._showOverlay(ranked.slice(0, 3), event, testMode);
    }

    // ── Glide range wind adjustment ────────────────────────────────────────────

    /**
     * Wind-adjust glide range using ground speed vs nominal glide speed.
     * A significant headwind reduces glide range; tailwind increases it.
     * Factor clamped to 0.6–1.3 to prevent unrealistic results.
     */
    _windAdjustRange(rangeNm, sit) {
        if (!sit?.ground_speed) return rangeNm;
        const GLIDE_SPEED_KT = 80; // nominal best-glide for RV-9A
        const factor = Math.min(1.3, Math.max(0.6, sit.ground_speed / GLIDE_SPEED_KT));
        return rangeNm * factor;
    }

    // ── Airport ranking ────────────────────────────────────────────────────────

    /**
     * Rank airports by emergency landing suitability.
     * Scoring: runway length (40 pts), paved surface (20 pts),
     *          wind alignment (15 pts), terrain clearance (15 pts), proximity (10 pts).
     */
    _rankAirports(airports, lat, lon, altAgl, sit) {
        const GLIDE_RATIO = 10.0;
        const GLIDE_SPEED_KT = 80;
        const PATTERN_BUFFER_FT = 500;

        return airports
            .filter(a => a.lat && a.lon && a.fac_type !== 'HELIPORT')
            .map(a => {
                const distNm = NasrDB.haversineNm(lat, lon, a.lat, a.lon);

                // True heading to airport (degrees 0-359)
                const hdg = this._bearingTo(lat, lon, a.lat, a.lon);

                // Altitude needed to reach airport: glide distance in ft plus pattern buffer
                const airportElevFt = a.elev_ft ?? 0;
                const altNeededFt = (distNm * 6076) / GLIDE_RATIO + airportElevFt + PATTERN_BUFFER_FT;

                // Clearance: how much altitude is left after arriving over airport
                const clearance = altAgl + terrainElevAt(lat, lon) - altNeededFt;

                // Check max terrain obstacle on direct path
                const maxTerrain = this._maxTerrainEnRoute(lat, lon, a.lat, a.lon);
                const obstacleMargin = altAgl - (maxTerrain - (window.terrainGrid?.isLoaded
                    ? window.terrainGrid.getElevationFt(lat, lon)
                    : 0)) - 500; // min 500ft over obstacles

                const reachable = clearance > 0 && obstacleMargin > 0;

                // Required descent rate (fpm)
                const timeToAirportMin = distNm / GLIDE_SPEED_KT * 60;
                const descentFpm = timeToAirportMin > 0
                    ? Math.round(altAgl / timeToAirportMin)
                    : 9999;

                // Composite score
                let score = 0;
                score += Math.min(40, ((a.longest_rwy_ft ?? 0) / 5000) * 40); // runway length
                if (a.has_paved_rwy) score += 20;                              // paved surface
                if (sit?.true_course && a.runways?.length) {
                    score += this._windAlignScore(sit.true_course, a.runways); // wind align
                }
                score += Math.min(15, Math.max(0, clearance / 500));          // terrain clearance
                score += Math.max(0, 10 - distNm);                            // proximity bonus

                return {
                    ...a,
                    _distNm: parseFloat(distNm.toFixed(1)),
                    _hdg: hdg,
                    _score: score,
                    _clearance: Math.round(clearance),
                    _descentFpm: descentFpm,
                    _reachable: reachable,
                };
            })
            .sort((a, b) => {
                // Reachable airports first; within tier sort by score descending
                if (a._reachable && !b._reachable) return -1;
                if (!a._reachable && b._reachable) return 1;
                return b._score - a._score;
            });
    }

    /**
     * Score runway wind alignment against current track (0-15 pts).
     * Uses true course as a proxy for wind direction; landing into wind is ideal.
     */
    _windAlignScore(trueCourse, runways) {
        let bestAngle = 180;
        for (const rwy of runways) {
            for (const part of (rwy.id || "").split("/")) {
                const match = part.trim().match(/^(\d{1,2})(L|R|C)?$/i);
                if (!match) continue;
                const rwyHdg = parseInt(match[1]) * 10;
                if (!rwyHdg) continue;
                const diff = ((trueCourse - rwyHdg + 360) % 360);
                const angle = diff > 180 ? 360 - diff : diff;
                if (angle < bestAngle) bestAngle = angle;
            }
        }
        return Math.max(0, 15 * (1 - bestAngle / 180));
    }

    /**
     * Sample max terrain elevation along a direct path (10 samples — fast, offline).
     */
    _maxTerrainEnRoute(lat1, lon1, lat2, lon2) {
        if (!window.terrainGrid?.isLoaded) return 0;
        let maxElev = 0;
        for (let i = 0; i <= 10; i++) {
            const t = i / 10;
            const elev = window.terrainGrid.getElevationFt(
                lat1 + (lat2 - lat1) * t,
                lon1 + (lon2 - lon1) * t,
            );
            if (elev > maxElev) maxElev = elev;
        }
        return maxElev;
    }

    // ── Navigation math ────────────────────────────────────────────────────────

    /** True bearing from (lat1,lon1) to (lat2,lon2), degrees 0-359. */
    _bearingTo(lat1, lon1, lat2, lon2) {
        const dLat = lat2 - lat1;
        const dLon = (lon2 - lon1) * Math.cos(lat1 * Math.PI / 180);
        return Math.round(((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360);
    }

    // ── Post-flight logging ────────────────────────────────────────────────────

    _persistLog(event) {
        try {
            const KEY = 'flypi_emergency_glide_log';
            const existing = JSON.parse(localStorage.getItem(KEY) || '[]');
            existing.push(event);
            if (existing.length > 20) existing.splice(0, existing.length - 20);
            localStorage.setItem(KEY, JSON.stringify(existing));
        } catch (_) {}
    }

    /** Returns copy of in-memory event log for logbook integration. */
    getEventLog() { return [...this._eventLog]; }

    // ── Overlay display ────────────────────────────────────────────────────────

    _showOverlay(top3, event, testMode = false) {
        this._dismissOverlay();

        // Store for approach guidance and back navigation
        this._approachTop3 = top3;
        this._approachEvent = event;
        this._testMode = testMode;

        const el = document.createElement('div');
        el.id = 'emergencyGlideOverlay';
        el.className = 'eg-overlay' + (testMode ? ' eg-overlay--test' : '');

        // Header
        const header = document.createElement('div');
        header.className = 'eg-header';
        header.innerHTML = `
            <div class="eg-title-row">
                <div class="eg-title">${testMode ? '⚠\uFE0E TEST \u2014 ENGINE ANOMALY SIMULATION' : '⚡ ENGINE ANOMALY CONFIRMED'}</div>
                ${testMode ? '<span class="eg-test-pill">TEST MODE</span>' : ''}
            </div>
            <div class="eg-subtitle">
                ${event.airports_in_range} airport${event.airports_in_range !== 1 ? 's' : ''}
                within ${event.adjusted_range_nm} nm glide range
                &nbsp;|&nbsp; ${event.alt_agl.toLocaleString()} ft AGL
            </div>`;
        el.appendChild(header);

        // Airport list body
        const body = document.createElement('div');
        body.className = 'eg-body';
        this._overlayBody = body;
        this._buildAirportItems(top3, body);
        el.appendChild(body);

        // Dismiss button
        const footer = document.createElement('div');
        footer.className = 'eg-footer';
        const btn = document.createElement('button');
        btn.className = 'eg-ack-btn';
        btn.textContent = 'ACKNOWLEDGE';
        btn.addEventListener('click', () => this._dismissOverlay(), { once: true });
        footer.appendChild(btn);
        el.appendChild(footer);

        document.body.appendChild(el);
        this._overlay = el;

        // Focus the ack button for accessibility
        setTimeout(() => btn.focus(), 50);
    }

    /**
     * Build tappable airport list items into body element.
     * Extracted so it can be called from both _showOverlay and back-navigation.
     */
    _buildAirportItems(top3, body) {
        body.innerHTML = '';

        if (top3.length === 0) {
            body.innerHTML = `<div class="eg-none">
                No airports within glide range.<br>
                Declare emergency — squawk 7700.
            </div>`;
            return;
        }

        top3.forEach((apt, idx) => {
            const item = document.createElement('div');
            item.className = `eg-item eg-item--tappable${idx === 0 ? ' eg-item--best' : ''}${!apt._reachable ? ' eg-item--marginal' : ''}`;

            const rwyLen = apt.longest_rwy_ft
                ? `${apt.longest_rwy_ft.toLocaleString()} ft`
                : '—';
            const surface = apt.has_paved_rwy ? 'paved' : 'grass';
            const descentStr = apt._descentFpm < 9000
                ? ` · ${apt._descentFpm.toLocaleString()} fpm`
                : '';
            const badgeHtml = idx === 0
                ? `<span class="eg-badge eg-badge--best">BEST OPTION</span>`
                : (!apt._reachable ? `<span class="eg-badge eg-badge--marginal">MARGINAL</span>` : '');

            item.innerHTML = `
                <div class="eg-rank">${idx + 1}</div>
                <div class="eg-apt">
                    <div class="eg-apt-id">
                        ${apt.icao}
                        <span class="eg-apt-name">${apt.name}</span>
                        ${badgeHtml}
                    </div>
                    <div class="eg-apt-detail">
                        ${apt._distNm} nm
                        &nbsp;·&nbsp; hdg ${String(apt._hdg).padStart(3, '0')}°
                        &nbsp;·&nbsp; ${rwyLen} ${surface}${descentStr}
                    </div>
                </div>
                <div class="eg-item-chevron">›</div>`;

            item.addEventListener('click', () => this._showApproachDetail(apt));
            body.appendChild(item);
        });

        // Tap hint
        const hint = document.createElement('div');
        hint.className = 'eg-tap-hint';
        hint.textContent = 'Tap airport for approach guidance';
        body.appendChild(hint);
    }

    _showNoGpsOverlay(testMode = false) {
        this._dismissOverlay();
        const el = document.createElement('div');
        el.id = 'emergencyGlideOverlay';
        el.className = 'eg-overlay' + (testMode ? ' eg-overlay--test' : '');
        el.innerHTML = `
            <div class="eg-header">
                <div class="eg-title">${testMode ? '⚠\uFE0E TEST \u2014 ENGINE ANOMALY SIMULATION' : '⚡ ENGINE ANOMALY CONFIRMED'}</div>
                <div class="eg-subtitle">No GPS — cannot compute glide range</div>
            </div>
            <div class="eg-body">
                <div class="eg-none">Declare emergency immediately.<br>Squawk 7700.</div>
            </div>
            <div class="eg-footer">
                <button class="eg-ack-btn" id="egAckBtn">ACKNOWLEDGE</button>
            </div>`;
        document.body.appendChild(el);
        el.querySelector('#egAckBtn').addEventListener('click',
            () => this._dismissOverlay(), { once: true });
        this._overlay = el;
    }

    _dismissOverlay() {
        this._stopApproachMonitor();
        if (this._overlay) {
            this._overlay.remove();
            this._overlay = null;
            this._overlayBody = null;
        }
    }

    // ── Approach Guidance Panel ────────────────────────────────────────────────

    /**
     * Show live approach guidance for the selected airport.
     * Replaces the airport list body with a 1 Hz updating panel.
     */
    _showApproachDetail(apt) {
        this._stopApproachMonitor();
        this._approachApt = apt;

        const body = this._overlayBody;
        if (!body) return;

        // Get DMMS best-glide speed from config
        const dmmsKt = (() => {
            try { return Math.round(CockpitConfig.dmmsKt) || 80; }
            catch (_) { return 80; }
        })();

        const freqHtml = this._buildFreqHtml(apt.frequencies, apt.tower);

        body.innerHTML = `
            <div class="eg-approach-panel">
                <div class="eg-approach-nav">
                    <button class="eg-back-btn" id="egApBack">← BACK</button>
                    <div class="eg-approach-apt-title">${apt.icao} — ${apt.name}</div>
                    <button class="eg-fly-btn" id="egApFly">FLY TO</button>
                </div>

                <div class="eg-approach-strip">
                    <div class="eg-ap-cell">
                        <div class="eg-approach-label">HDG</div>
                        <div class="eg-approach-value" id="eg-ap-hdg">—°</div>
                    </div>
                    <div class="eg-ap-cell">
                        <div class="eg-approach-label">DIST</div>
                        <div class="eg-approach-value" id="eg-ap-dist">— nm</div>
                    </div>
                    <div class="eg-ap-cell eg-ap-cell--speed">
                        <div class="eg-approach-label">BEST GLIDE</div>
                        <div class="eg-approach-value eg-ap-speed">${dmmsKt} kt</div>
                    </div>
                </div>

                <div class="eg-approach-status eg-approach-status--unknown" id="eg-ap-status">
                    WAITING FOR GPS
                </div>

                <div class="eg-approach-strip">
                    <div class="eg-ap-cell">
                        <div class="eg-approach-label">OVERHEAD TGT</div>
                        <div class="eg-approach-value eg-approach-value--sm" id="eg-ap-tgt-alt">—</div>
                    </div>
                    <div class="eg-ap-cell">
                        <div class="eg-approach-label">ALT MSL</div>
                        <div class="eg-approach-value eg-approach-value--sm" id="eg-ap-agl">—</div>
                    </div>
                    <div class="eg-ap-cell">
                        <div class="eg-approach-label">REQ V/S</div>
                        <div class="eg-approach-value eg-approach-value--sm" id="eg-ap-req-vs">—</div>
                    </div>
                </div>

                <div class="eg-approach-section eg-approach-rwy-row" id="eg-ap-rwy-section">
                    <span class="eg-approach-label">RWY </span>
                    <span class="eg-approach-rwy-val" id="eg-ap-rwy">CALCULATING…</span>
                    <div class="eg-approach-wind-src" id="eg-ap-wind-src"></div>
                </div>

                ${freqHtml}
            </div>`;

        body.querySelector('#egApBack').addEventListener('click', () => {
            this._stopApproachMonitor();
            if (!this._testMode) this._overlay.classList.remove('eg-overlay--approach-mode');
            this._buildAirportItems(this._approachTop3 || [], body);
        });

        body.querySelector('#egApFly').addEventListener('click', () => {
            this._setDestination(apt);
        });

        // Shrink overlay to floating panel so map is visible below (non-test mode only)
        if (!this._testMode) {
            this._overlay.classList.add('eg-overlay--approach-mode');
        }

        // Center map to show current position → airport flight path
        this._centerMapToApproach(apt);

        // Start live updates
        this._updateApproachPanel();
        this._approachInterval = setInterval(() => this._updateApproachPanel(), 1000);

        // Fetch wind immediately then every 30 s
        this._refreshApproachWind();
        this._approachWindInterval = setInterval(() => this._refreshApproachWind(), 30_000);
    }

    /** Draw glide-path line and fit the map so the route is centred in the
     *  visible area below the approach panel. */
    _centerMapToApproach(apt) {
        const sit = window.app?.stratuxClient?.situation ?? window.stratuxClient?.situation;
        if (!sit?.lat || !sit?.lon || !apt?.lat || !apt?.lon) return;
        try {
            const leafletMap = window.app?.cockpitMap?.map;
            if (!leafletMap || typeof L === 'undefined') return;

            // Draw dashed red glide-path line
            if (this._approachLine) this._approachLine.remove();
            this._approachLine = L.polyline(
                [[sit.lat, sit.lon], [apt.lat, apt.lon]],
                { color: '#ff3333', weight: 3, dashArray: '10 7', opacity: 0.95 }
            ).addTo(leafletMap);

            // Measure the actual rendered overlay height — more reliable than
            // computing a fraction of window.innerHeight.
            const overlayH = this._overlay
                ? Math.round(this._overlay.getBoundingClientRect().height)
                : Math.round(window.innerHeight * 0.52);

            // Tab bar at bottom is ~56px. Leave comfortable margin on all sides
            // so both the ownship and the destination have breathing room.
            leafletMap.fitBounds(
                L.latLngBounds([[sit.lat, sit.lon], [apt.lat, apt.lon]]),
                {
                    paddingTopLeft:     [60, overlayH + 40],
                    paddingBottomRight: [60, 70],
                    maxZoom: 11,
                    animate: true,
                }
            );
        } catch (_) {}
    }

    /** Update the glide-path line start point as GPS moves. */
    _updateApproachLine(lat, lon) {
        if (!this._approachLine || !this._approachApt) return;
        try {
            const latlngs = this._approachLine.getLatLngs();
            latlngs[0] = L.latLng(lat, lon);
            this._approachLine.setLatLngs(latlngs);
        } catch (_) {}
    }

    /** 1 Hz: update distance, heading, altitude status, vertical speed. */
    _updateApproachPanel() {
        const apt = this._approachApt;
        if (!apt || !this._overlay) return;

        const sit = window.app?.stratuxClient?.situation ?? window.stratuxClient?.situation;
        if (!sit?.lat || !sit?.lon) return;

        const distNm = NasrDB.haversineNm(sit.lat, sit.lon, apt.lat, apt.lon);
        const hdg = this._bearingTo(sit.lat, sit.lon, apt.lat, apt.lon);
        const altMsl = sit.alt_msl ?? 0;
        const vs = Math.round(sit.vertical_speed ?? 0);
        const gs = Math.max(sit.ground_speed ?? 0, 30); // floor to avoid div/0

        // Approach profile —
        // Target = altitude overhead the airport to fly a 2 nm emergency pattern
        // and cross the runway threshold at 500 ft AGL.
        const gr = this._glideRatio || 10.0;
        const ftPerNm = 6076 / gr;
        const aptElev = apt.elev_ft ?? 0;

        // Altitude needed overhead the airport to complete pattern → 500 ft threshold
        const PATTERN_NM = 2.0; // overhead→threshold via downwind/base/final
        const overheadAgl = 500 + PATTERN_NM * ftPerNm;
        const overheadMsl = Math.round(aptElev + overheadAgl);

        // Required altitude right now to arrive at overheadMsl over the airport
        const reqAltNow = overheadMsl + distNm * ftPerNm;
        const minAltNow = reqAltNow - 300;   // 300 ft low tolerance
        const maxAltNow = reqAltNow + 500;   // 500 ft high tolerance

        // Profile status
        let statusText, statusClass;
        if (altMsl > maxAltNow) {
            statusText = '▲ HIGH — S-TURNS OR SLIP';
            statusClass = 'eg-approach-status--high';
        } else if (altMsl < minAltNow) {
            statusText = '▼ LOW — FLY BEST GLIDE';
            statusClass = 'eg-approach-status--low';
        } else {
            statusText = '✓ ON PROFILE';
            statusClass = 'eg-approach-status--ok';
        }

        // Required V/S to arrive overhead at overheadMsl
        const altToLose = altMsl - overheadMsl;
        const timeMin = distNm / gs * 60;
        const reqVs = timeMin > 0 ? -Math.round(altToLose / timeMin) : 0;

        // Update DOM — targeted writes to avoid flicker
        const set = (id, text) => {
            const el = this._overlay?.querySelector(`#${id}`);
            if (el) el.textContent = text;
        };

        set('eg-ap-hdg',     String(hdg).padStart(3, '0') + '°');
        set('eg-ap-dist',    distNm.toFixed(1) + ' nm');
        set('eg-ap-tgt-alt', overheadMsl.toLocaleString() + ' ft');
        set('eg-ap-agl',     Math.round(altMsl).toLocaleString() + ' ft');
        set('eg-ap-req-vs',  (reqVs >= 0 ? '+' : '') + reqVs.toLocaleString() + ' fpm');

        // Keep route line start at current GPS position
        this._updateApproachLine(sit.lat, sit.lon);

        const statusEl = this._overlay?.querySelector('#eg-ap-status');
        if (statusEl) {
            statusEl.textContent = statusText;
            statusEl.className = `eg-approach-status ${statusClass}`;
        }
    }

    /**
     * Find nearest METAR with wind data.
     * 1. Try own airport METAR from FIS-B.
     * 2. Fall back to nearest ranked airport that has wind data.
     * Updates runway guidance display after fetching.
     */
    _refreshApproachWind() {
        const apt = this._approachApt;
        if (!apt) return;

        const fisb = window.app?.fisbClient;
        if (!fisb?.getMetar) {
            this._approachWind = null;
            this._renderRunwayGuidance();
            return;
        }

        let decoded = null, sourceName = null, sourceDist = 0;

        // Own airport METAR first
        const own = fisb.getMetar(apt.icao);
        if (own?.decoded?.wind_dir != null && own.decoded.wind_speed != null) {
            decoded = own.decoded;
            sourceName = apt.icao;
            sourceDist = 0;
        }

        // Nearest ranked airport with valid wind
        if (!decoded) {
            let bestDist = Infinity;
            for (const a of this._rankedAirports) {
                if (!a.lat || !a.lon) continue;
                const m = fisb.getMetar(a.icao);
                if (m?.decoded?.wind_dir == null || m.decoded.wind_speed == null) continue;
                const d = NasrDB.haversineNm(apt.lat, apt.lon, a.lat, a.lon);
                if (d < bestDist) {
                    bestDist = d;
                    decoded = m.decoded;
                    sourceName = a.icao;
                    sourceDist = parseFloat(d.toFixed(1));
                }
            }
        }

        this._approachWind = decoded ? { decoded, sourceName, sourceDist } : null;
        this._renderRunwayGuidance();
    }

    /** Update the runway + wind source display in the approach panel. */
    _renderRunwayGuidance() {
        const apt = this._approachApt;
        if (!apt || !this._overlay) return;

        const rwyEl = this._overlay.querySelector('#eg-ap-rwy');
        const srcEl = this._overlay.querySelector('#eg-ap-wind-src');
        if (!rwyEl) return;

        const wind = this._approachWind;
        if (!wind) {
            rwyEl.textContent = apt.runways?.length
                ? `${apt.runways.length} runway(s) — wind unknown`
                : 'No runway data';
            if (srcEl) srcEl.textContent = 'No METAR available';
            return;
        }

        const best = this._bestRunwayForWind(
            apt.runways || [],
            wind.decoded.wind_dir,
            wind.decoded.wind_speed,
        );

        if (!best) {
            rwyEl.textContent = 'No runway data';
            if (srcEl) srcEl.textContent = '';
            return;
        }

        const hwStr = best.headwind >= 0
            ? `HW ${best.headwind} kt`
            : `TW ${Math.abs(best.headwind)} kt`;
        const xwStr = `XW ${best.crosswind} kt`;
        const gustStr = wind.decoded.wind_gust
            ? ` (gust ${wind.decoded.wind_gust} kt)`
            : '';
        rwyEl.textContent = `RWY ${best.label} — ${hwStr}, ${xwStr}${gustStr}`;

        if (srcEl) {
            const src = wind.sourceDist > 0
                ? `Wind ${wind.decoded.wind_dir}°@${wind.decoded.wind_speed}kt — METAR ${wind.sourceName} (${wind.sourceDist} nm)`
                : `Wind ${wind.decoded.wind_dir}°@${wind.decoded.wind_speed}kt — METAR ${wind.sourceName}`;
            srcEl.textContent = src;
        }
    }

    /**
     * Select best runway end for given wind.
     * Returns { label, hdg, headwind, crosswind } or null.
     * Headwind formula mirrors airport-popup.js.
     */
    _bestRunwayForWind(runways, windDir, windSpd) {
        const ends = [];
        for (const rwy of runways) {
            for (const part of (rwy.id || '').split('/')) {
                const match = part.trim().match(/^(\d{1,2})(L|R|C)?$/i);
                if (!match) continue;
                const hdg = parseInt(match[1]) * 10;
                const suffix = (match[2] || '').toUpperCase();
                const label = String(match[1]).padStart(2, '0') + suffix;
                const diff = (windDir - hdg) * Math.PI / 180;
                const headwind = Math.round(windSpd * Math.cos(diff));
                const crosswind = Math.abs(Math.round(windSpd * Math.sin(diff)));
                ends.push({ label, hdg, headwind, crosswind });
            }
        }
        if (ends.length === 0) return null;
        ends.sort((a, b) => b.headwind - a.headwind);
        return ends[0];
    }

    /**
     * Build frequency display HTML for the approach panel.
     * Primary frequency (CTAF / TWR) shown in green.
     */
    _buildFreqHtml(frequencies, isTowered) {
        if (!frequencies?.length) return '';

        const sorted = [...frequencies].sort((a, b) => {
            const pri = (t) => {
                if (!isTowered && t === 'ctaf') return 0;
                if (isTowered && (t === 'twr' || t === 'tower')) return 0;
                if (t === 'atis') return 1;
                if (t === 'ground' || t === 'gnd') return 2;
                return 3;
            };
            return pri(a.type) - pri(b.type);
        });

        const rows = sorted.map(f => {
            const isPrimary = (!isTowered && f.type === 'ctaf') ||
                              (isTowered && (f.type === 'twr' || f.type === 'tower'));
            const label = f.type?.toUpperCase() || '';
            return `<div class="eg-approach-freq-row${isPrimary ? ' eg-approach-freq--primary' : ''}">
                <span class="eg-approach-freq-type">${label}</span>
                <span class="eg-approach-freq-val">${f.freq}</span>
            </div>`;
        }).join('');

        return `<div class="eg-approach-section eg-approach-freqs">
            <div class="eg-approach-label">FREQUENCIES</div>
            ${rows}
        </div>`;
    }

    /**
     * Set selected airport as active destination by loading a minimal flight plan.
     */
    _setDestination(apt) {
        const plan = {
            name: `→ ${apt.icao}`,
            waypoints: [{
                icao:    apt.icao,
                name:    apt.name,
                lat:     apt.lat,
                lon:     apt.lon,
                elev_ft: apt.elev_ft ?? null,
                type:    'APT',
            }],
            flight_plan: {
                departure:   null,
                destination: apt.icao,
                route:       [apt.icao],
                legs:        [],
                altitude:    null,
            },
        };
        window.app?.applyRouteEdit(plan);
        window.app?.showToast(`Route set to ${apt.icao}`);
    }

    /** Stop the approach monitor interval and clear related state. */
    _stopApproachMonitor() {
        clearInterval(this._approachInterval);
        clearInterval(this._approachWindInterval);
        this._approachInterval = null;
        this._approachWindInterval = null;
        this._approachApt = null;
        this._approachWind = null;
        if (this._approachLine) {
            try { this._approachLine.remove(); } catch (_) {}
            this._approachLine = null;
        }
    }
}

// ── Helper: terrain elevation at a point (safe wrapper) ─────────────────────
function terrainElevAt(lat, lon) {
    return window.terrainGrid?.isLoaded
        ? window.terrainGrid.getElevationFt(lat, lon)
        : 0;
}
