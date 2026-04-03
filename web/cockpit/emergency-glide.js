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
 * Computation completes within 2-3 seconds. Entirely on-device, no internet.
 */

class EmergencyGlide {
    constructor() {
        this._overlay = null;
        this._lastTriggerTime = 0;
        this._COOLDOWN_MS = 60_000;   // debounce: don't re-trigger within 60s
        this._eventLog = [];           // post-flight event log (in-memory)

        window.emergencyGlide = this;
    }

    /**
     * Called when both physics rules AND ML anomaly confirm power loss.
     * @param {Object} options
     * @param {Object} options.engineRaw  — raw engine data frame
     * @param {Object} [options.sit]      — stratuxClient.situation (falls back to live)
     * @param {Object} options.mlResult   — EngineML processSample result
     * @param {boolean} [options.testMode] — if true, bypass cooldown and show test banner
     */
    async trigger(options = {}) {
        const { engineRaw, sit: sitArg, mlResult, testMode = false } = options;
        const sit = sitArg ?? window.app?.stratuxClient?.situation;

        const now = Date.now();
        if (!testMode && now - this._lastTriggerTime < this._COOLDOWN_MS) return;
        this._lastTriggerTime = now;

        console.warn('[EmergencyGlide] TRIGGERED — computing glide options');

        const lat = sit?.lat;
        const lon = sit?.lon;
        const altMsl = sit?.alt_msl ?? 0;

        if (!lat || !lon) {
            console.warn('[EmergencyGlide] No GPS position — cannot compute glide range');
            this._showNoGpsOverlay();
            return;
        }

        // Altitude AGL: MSL minus terrain elevation at current position
        const terrainElev = window.terrainGrid?.isLoaded
            ? window.terrainGrid.getElevationFt(lat, lon)
            : 0;
        const altAgl = Math.max(altMsl - terrainElev, 0);

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

                // Magnetic heading to airport (true, degrees 0-359)
                const dLat = a.lat - lat;
                const dLon = (a.lon - lon) * Math.cos(lat * Math.PI / 180);
                const hdg = Math.round(((Math.atan2(dLon, dLat) * 180 / Math.PI) + 360) % 360);

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

        const el = document.createElement('div');
        el.id = 'emergencyGlideOverlay';
        el.className = testMode ? 'eg-overlay eg-overlay--test' : 'eg-overlay';

        // Header
        const header = document.createElement('div');
        header.className = 'eg-header';
        if (testMode) header.style.background = 'var(--status-caution)';
        header.innerHTML = `
            <div class="eg-title">⚡ ENGINE ANOMALY CONFIRMED</div>
            ${testMode ? '<div class="eg-subtitle eg-subtitle--test">⚠️ TEST MODE — SIMULATION</div>' : ''}
            <div class="eg-subtitle">
                ${event.airports_in_range} airport${event.airports_in_range !== 1 ? 's' : ''}
                within ${event.adjusted_range_nm} nm glide range
                &nbsp;|&nbsp; ${event.alt_agl.toLocaleString()} ft AGL
            </div>`;
        el.appendChild(header);

        // Airport list
        const body = document.createElement('div');
        body.className = 'eg-body';

        if (top3.length === 0) {
            body.innerHTML = `<div class="eg-none">
                No airports within glide range.<br>
                Declare emergency — squawk 7700.
            </div>`;
        } else {
            top3.forEach((apt, idx) => {
                const item = document.createElement('div');
                item.className = `eg-item${idx === 0 ? ' eg-item--best' : ''}${!apt._reachable ? ' eg-item--marginal' : ''}`;

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
                    </div>`;
                body.appendChild(item);
            });
        }

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
    }

    _showNoGpsOverlay() {
        this._dismissOverlay();
        const el = document.createElement('div');
        el.id = 'emergencyGlideOverlay';
        el.className = 'eg-overlay';
        el.innerHTML = `
            <div class="eg-header">
                <div class="eg-title">⚡ ENGINE ANOMALY CONFIRMED</div>
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
        if (this._overlay) {
            this._overlay.remove();
            this._overlay = null;
        }
    }
}

// ── Helper: terrain elevation at a point (safe wrapper) ─────────────────────
function terrainElevAt(lat, lon) {
    return window.terrainGrid?.isLoaded
        ? window.terrainGrid.getElevationFt(lat, lon)
        : 0;
}
