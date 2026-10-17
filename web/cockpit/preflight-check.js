/**
 * FlyTab — Pre-flight Data Readiness Check
 *
 * Runs 4 parallel checks on cockpit load (when active plan exists):
 *   1. Weather age — how old is the cached weather in the flight plan?
 *   2. NASR currency — is the aeronautical database current?
 *   3. Offline tile coverage — are route tiles available via NanoHTTPD tile server?
 *   4. Active flight plan — is there a departure/destination defined?
 *
 * Auto-triggers once per session. Dismissible. "Open Details" links to DataStatus.
 */

class PreflightCheck {
    constructor(db) {
        this.db = db;
        this._el = null;
        this._dismissed = false;
        this._buildDOM();
    }

    // ========== Public API ==========

    /** Auto-trigger: show once per session if active plan exists and not yet dismissed. */
    async autoTrigger() {
        if (this._dismissed) return;
        try {
            await this.db.open();
            const plan = this._getActivePlan();
            if (!plan) return; // no plan — nothing to check
            const results = await this._runChecks(plan);
            this._render(results);
            this._show();
        } catch (err) {
            console.warn('PreflightCheck: autoTrigger failed', err);
        }
    }

    /** Manual trigger: always show fresh results. */
    async show() {
        try {
            await this.db.open();
            const plan = this._getActivePlan();
            const results = await this._runChecks(plan);
            this._render(results);
            this._show();
        } catch (err) {
            console.warn('PreflightCheck: show failed', err);
        }
    }

    dismiss() {
        this._dismissed = true;
        if (this._el) this._el.classList.remove('pfc-visible');
    }

    /**
     * Read the pilot's currently active flight plan.
     *
     * Deliberately NOT this.db (NasrDB / the 'flypi' IDB database) — flypi's
     * flight_plans store is written only by NasrDB.saveFlightPlan(), which has
     * zero callers anywhere in the app. The live active plan lives in
     * localStorage['flypi_active_plan'], written by app.js's _applyPlan()
     * (every plan load, including flywhere.app cloud sync) and by
     * route-table.js's Save Route / Plan Picker flows — same key/shape
     * app.js, logbook.js, and plan-sync.js already read.
     *
     * _checkWeather() reads the Weather Cache (IndexedDB), not the plan, so a
     * locally-built route is checked the same as a flywhere.app one.
     */
    _getActivePlan() {
        try {
            return JSON.parse(localStorage.getItem('flypi_active_plan') || 'null');
        } catch (err) {
            console.warn('PreflightCheck: failed to parse flypi_active_plan', err);
            return null;
        }
    }

    // ========== Checks ==========

    async _runChecks(plan) {
        const [weather, nasr, tiles, flightPlan] = await Promise.all([
            this._checkWeather(plan),
            this._checkNasr(),
            this._checkTiles(plan),
            this._checkFlightPlan(plan),
        ]);
        const items = [flightPlan, weather, nasr, tiles];
        const hasFailure = items.some(i => i.status === 'fail');
        const hasCaution = items.some(i => i.status === 'warn');
        const verdict = hasFailure ? 'fail' : hasCaution ? 'warn' : 'ok';
        return { items, verdict, plan };
    }

    /** True only when NASR shows the airport has no weather station (see _checkWeather). */
    static async _hasNoWeatherStation(db, icao) {
        let apt = null;
        try {
            apt = await db.getAirport(icao)
                || (icao.length === 3 ? await db.getAirport(`K${icao}`) : null);
        } catch { return false; }
        const types = (apt?.frequencies || []).map(f => f.type);
        if (!types.length || apt.tower) return false;
        return !types.some(t => t === 'awos' || t === 'asos' || t === 'atis');
    }

    /**
     * Weather at the route's departure and destination, from the Weather Cache
     * (Data & Maps; filled by the moving map on WiFi and by FIS-B in flight).
     * It read only plan.weather_cache, which only flywhere.app plans carry, so
     * a route built on the tablet always said "Not cached" (Dana, 2026-10-17).
     * Age is from the METAR's observation time: under 1 h ok, under 3 h
     * caution, older fail; an airport with no METAR cached is a caution.
     * An airport that has no weather station (NASR lists its frequencies but
     * no AWOS/ASOS, ATIS or tower, e.g. K9A9) says "no weather station", not
     * "no METAR cached" (Dana, 2026-10-17). Military fields list no frequencies
     * in NASR, so an empty list proves nothing and keeps "no METAR cached".
     */
    async _checkWeather(plan) {
        if (!plan) return { label: 'Weather', status: 'fail', msg: 'No flight plan' };
        const fp = plan.flight_plan || {};
        const airports = [...new Set([fp.departure || plan.departure, fp.destination || plan.destination]
            .filter(Boolean).map(a => String(a).toUpperCase()))];
        if (!airports.length) return { label: 'Weather', status: 'warn', msg: 'No departure or destination' };
        const fmt = (min) => min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;
        let worst = 'ok';
        const parts = [];
        for (const icao of airports) {
            let e = null;
            try {
                e = await this.db.getWeather(icao)
                    || (icao.length === 4 && icao.startsWith('K') ? await this.db.getWeather(icao.slice(1)) : null);
            } catch { e = null; }
            const t = e?.metar ? Date.parse(e.metar.decoded?.observed_at || e.metar.fetched_at || e.fetched_at) : NaN;
            if (!Number.isFinite(t)) {
                parts.push(`${icao} ${await PreflightCheck._hasNoWeatherStation(this.db, icao) ? 'no weather station' : 'no METAR cached'}`);
                if (worst === 'ok') worst = 'warn';
                continue;
            }
            const min = Math.max(0, Math.round((Date.now() - t) / 60000));
            parts.push(`${icao} ${fmt(min)}`);
            if (min >= 180) worst = 'fail';
            else if (min >= 60 && worst === 'ok') worst = 'warn';
        }
        const tail = worst === 'ok' ? ' — FRESH' : worst === 'warn' ? ' — check before departure' : ' — STALE';
        return { label: 'Weather', status: worst, msg: parts.join(' · ') + tail };
    }

    /**
     * FAA data: NASR (loaded), CIFP, approach plates and A/FD (as synced), at
     * the 0901Z changeover (FaaCurrency). It checked NASR only (round 2 review).
     */
    async _checkNasr() {
        try {
            const cycle = await this.db.getCycleInfo();
            if (!cycle) return { label: 'FAA Data', status: 'fail', msg: 'NASR not loaded' };
            const products = FaaCurrency.products(FaaCurrency.deviceManifest(), cycle, Date.now());
            const failed = products.filter(p => p.state === 'expired' || p.state === 'unknown');
            if (failed.length) {
                return { label: 'FAA Data', status: 'fail',
                         msg: failed.map(p => p.state === 'expired' ? `${p.label} expired`
                                              : `${p.label} expiry not recorded — sync in Data Status`).join(' · ') };
            }
            const warn = products.filter(p => p.state === 'expiring' || p.state === 'stale');
            if (warn.length) {
                // Less than a day before the changeover: one "New FAA cycle at
                // 05:01 tomorrow" message instead of each product's "0d left".
                const now = Date.now();
                const newCycle = warn.map(p => FaaCurrency.newCycleMessage(p, now)).find(Boolean);
                const msgs = warn.filter(p => !FaaCurrency.newCycleMessage(p, now))
                    .map(p => p.state === 'stale' ? `${p.label} not current` : `${p.label} ${p.daysLeft}d left`);
                return { label: 'FAA Data', status: 'warn', msg: [newCycle, ...msgs].filter(Boolean).join(' · ') };
            }
            return { label: 'FAA Data', status: 'ok', msg: `Current — ${Math.min(...products.map(p => p.daysLeft))}d remaining` };
        } catch {
            return { label: 'FAA Data', status: 'warn', msg: 'Could not verify' };
        }
    }

    async _checkTiles(plan) {
        if (!plan?.flight_plan) return { label: 'Offline Maps', status: 'warn', msg: 'No route to check' };

        const dep  = plan.flight_plan.departure;
        const dest = plan.flight_plan.destination;
        if (!dep || !dest) return { label: 'Offline Maps', status: 'warn', msg: 'Set departure & destination first' };

        // Get airport coordinates from NASR for dep/dest
        const coords = [];
        for (const icao of [dep, dest, ...(plan.flight_plan.route || [])]) {
            try {
                const apt = await this.db.getAirport(icao);
                if (apt?.lat && apt?.lon) coords.push([apt.lat, apt.lon]);
            } catch { /* skip */ }
        }
        if (coords.length < 2) return { label: 'Offline Maps', status: 'warn', msg: 'Airport positions unavailable' };

        // Sample ~20 tiles along the route bounding box at z8
        const samples = this._routeTileSamples(coords, 8, 20);
        if (samples.length === 0) return { label: 'Offline Maps', status: 'warn', msg: 'Could not compute tile samples' };

        // Probe NanoHTTPD tile server on localhost:9090
        let hits = 0;
        try {
            const probes = samples.map(async ({ x, y, z }) => {
                try {
                    const resp = await fetch(
                        `http://localhost:9090/tiles/sectional/${z}/${x}/${y}.webp`,
                        { method: 'HEAD', signal: AbortSignal.timeout(2000) }
                    );
                    if (resp.ok) hits++;
                } catch { /* timeout or network error — tile missing */ }
            });
            await Promise.all(probes);
        } catch {
            return { label: 'Offline Maps', status: 'warn', msg: 'Tile server unavailable — check NanoHTTPD' };
        }

        const pct = Math.round((hits / samples.length) * 100);
        if (pct >= 90) return { label: 'Offline Maps', status: 'ok',   msg: `${pct}% tiles cached` };
        if (pct >= 50) return { label: 'Offline Maps', status: 'warn', msg: `${pct}% tiles cached — gaps possible` };
        return { label: 'Offline Maps', status: 'fail', msg: `${pct}% tiles cached — cache maps before flight` };
    }

    _checkFlightPlan(plan) {
        if (!plan) return { label: 'Flight Plan', status: 'fail', msg: 'No active plan' };
        const dep  = plan.flight_plan?.departure;
        const dest = plan.flight_plan?.destination;
        if (!dep || !dest) return { label: 'Flight Plan', status: 'warn', msg: 'Missing departure or destination' };
        return { label: 'Flight Plan', status: 'ok', msg: `${dep} \u2192 ${dest}` };
    }

    /**
     * Sample tile coordinates along the route bounding box at the given zoom.
     * Generates a grid of samples within the bounding box of all route points.
     */
    _routeTileSamples(coords, zoom, count) {
        if (coords.length === 0) return [];
        let minLat = Infinity, maxLat = -Infinity;
        let minLon = Infinity, maxLon = -Infinity;
        for (const [lat, lon] of coords) {
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
        }
        // Expand bounding box by ~30nm to cover corridor outside direct track
        const pad = 0.5;
        minLat -= pad; maxLat += pad;
        minLon -= pad; maxLon += pad;

        const toTile = (lat, lon, z) => {
            const n = Math.pow(2, z);
            const x = Math.floor((lon + 180) / 360 * n);
            const latRad = lat * Math.PI / 180;
            const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
            return { x, y, z };
        };

        const tl = toTile(maxLat, minLon, zoom);
        const br = toTile(minLat, maxLon, zoom);
        const xRange = Math.max(1, br.x - tl.x + 1);
        const yRange = Math.max(1, br.y - tl.y + 1);
        const total  = xRange * yRange;

        // If total tiles is small enough, sample all; otherwise stride
        const stride = Math.max(1, Math.ceil(Math.sqrt(total / count)));
        const samples = [];
        for (let xi = 0; xi < xRange; xi += stride) {
            for (let yi = 0; yi < yRange; yi += stride) {
                samples.push({ x: tl.x + xi, y: tl.y + yi, z: zoom });
                if (samples.length >= count) return samples;
            }
        }
        return samples;
    }

    // ========== UI ==========

    _show() {
        if (this._el) this._el.classList.add('pfc-visible');
    }

    _render(results) {
        const { items, verdict, plan } = results;

        const verdictText = verdict === 'ok'   ? 'GO \u2014 ALL CLEAR'
                          : verdict === 'warn'  ? 'CAUTION \u2014 REVIEW'
                          : 'NO-GO \u2014 ACTION REQUIRED';
        const verdictClass = `pfc-verdict pfc-verdict--${verdict}`;

        const icons = { ok: '\u25CF', warn: '\u25CF', fail: '\u25CF' };
        const rowsHtml = items.map(item => `
            <div class="pfc-item pfc-item--${item.status}">
                <span class="pfc-dot">${icons[item.status]}</span>
                <span class="pfc-label">${item.label}</span>
                <span class="pfc-msg">${item.msg}</span>
            </div>`).join('');

        const body = this._el.querySelector('.pfc-body');
        const verdictEl = this._el.querySelector('.pfc-verdict');
        if (body) body.innerHTML = rowsHtml;
        if (verdictEl) {
            verdictEl.textContent = verdictText;
            verdictEl.className = verdictClass;
        }
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'pfc-overlay';
        this._el.innerHTML = `
            <style>${PreflightCheck._css()}</style>
            <div class="pfc-panel">
                <div class="pfc-header">
                    <span class="pfc-title">PRE-FLIGHT CHECK</span>
                    <button class="pfc-close btn-close">\u2715</button>
                </div>
                <div class="pfc-body"></div>
                <div class="pfc-footer">
                    <div class="pfc-verdict pfc-verdict--ok">Checking\u2026</div>
                    <div class="pfc-actions">
                        <button class="pfc-btn pfc-btn-details">Details</button>
                        <button class="pfc-btn pfc-btn-dismiss">Dismiss</button>
                    </div>
                </div>
            </div>`;

        document.body.appendChild(this._el);

        wireTap(this._el.querySelector('.pfc-close'),      () => this.dismiss());
        wireTap(this._el.querySelector('.pfc-btn-dismiss'), () => this.dismiss());
        wireTap(this._el.querySelector('.pfc-btn-details'), () => {
            this.dismiss();
            // Open DataStatus if available
            if (window.app?.dataStatus) window.app.dataStatus.show();
        });
    }

    static _css() {
        return `
.pfc-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 8500;
    align-items: flex-start;
    justify-content: center;
    padding-top: calc(60px + env(safe-area-inset-top, 0px));
    background: rgba(0,0,0,0.55);
}
.pfc-overlay.pfc-visible {
    display: flex;
}
.pfc-panel {
    width: min(400px, 92vw);
    background: var(--bg-surface-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
}
.pfc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
}
.pfc-title {
    font-size:16px;
    font-weight: 800;
    letter-spacing: 0.8px;
    color: var(--text-secondary);
    text-transform: uppercase;
}
.pfc-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    cursor: pointer;
    padding: 4px 6px;
    line-height: 1;
}
.pfc-body {
    padding: 8px 0;
}
.pfc-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 7px 14px;
}
.pfc-dot {
    font-size:14px;
    flex-shrink: 0;
}
.pfc-item--ok   .pfc-dot { color: var(--status-ok); }
.pfc-item--warn .pfc-dot { color: var(--status-caution); }
.pfc-item--fail .pfc-dot { color: var(--status-danger); }
.pfc-label {
    font-size:16px;
    font-weight: 700;
    color: var(--text-primary);
    min-width: 90px;
    flex-shrink: 0;
}
.pfc-msg {
    font-size:16px;
    color: var(--text-secondary);
}
.pfc-item--warn .pfc-msg { color: var(--status-caution); }
.pfc-item--fail .pfc-msg { color: var(--status-danger); }
.pfc-footer {
    padding: 10px 14px;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
}
.pfc-verdict {
    font-size:16px;
    font-weight: 800;
    letter-spacing: 0.4px;
    flex: 1;
}
.pfc-verdict--ok   { color: var(--status-ok); }
.pfc-verdict--warn { color: var(--status-caution); }
.pfc-verdict--fail { color: var(--status-danger); }
.pfc-actions {
    display: flex;
    gap: 8px;
}
.pfc-btn {
    font-size:16px;
    font-weight: 700;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-primary);
}
.pfc-btn:active { opacity: 0.7; }
        `;
    }
}
