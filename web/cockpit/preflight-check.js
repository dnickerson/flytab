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
            const plan = await this.db.getActiveFlightPlan();
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
            const plan = await this.db.getActiveFlightPlan();
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

    _checkWeather(plan) {
        if (!plan) return { label: 'Weather', status: 'fail', msg: 'No flight plan' };
        const fetchedAt = plan.weather_cache?.fetched_at;
        if (!fetchedAt) return { label: 'Weather', status: 'fail', msg: 'Not fetched' };
        const ageMin = (Date.now() - new Date(fetchedAt).getTime()) / 60000;
        if (ageMin < 60)  return { label: 'Weather', status: 'ok',   msg: `${Math.round(ageMin)}m old — FRESH` };
        if (ageMin < 180) return { label: 'Weather', status: 'warn', msg: `${Math.round(ageMin)}m old — AGING` };
        const ageHr = (ageMin / 60).toFixed(1);
        return { label: 'Weather', status: 'fail', msg: `${ageHr}h old — STALE` };
    }

    async _checkNasr() {
        try {
            const cycle = await this.db.getCycleInfo();
            if (!cycle) return { label: 'NASR Data', status: 'fail', msg: 'Not loaded' };
            const exp = cycle.expiration_date ? new Date(cycle.expiration_date) : null;
            if (!exp) return { label: 'NASR Data', status: 'warn', msg: `Cycle ${cycle.effective_date || '?'} — no expiry` };
            const daysLeft = (exp - Date.now()) / 86400000;
            if (daysLeft < 0)  return { label: 'NASR Data', status: 'fail', msg: `Expired ${Math.abs(Math.round(daysLeft))}d ago` };
            if (daysLeft <= 3) return { label: 'NASR Data', status: 'warn', msg: `Expires in ${Math.round(daysLeft)}d` };
            return { label: 'NASR Data', status: 'ok', msg: `Current — ${Math.round(daysLeft)}d remaining` };
        } catch {
            return { label: 'NASR Data', status: 'warn', msg: 'Could not verify' };
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
