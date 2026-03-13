/**
 * FlyPi — Nav Strip
 * Always-visible top bar showing: NEXT waypoint, DEST, GS, ALT.
 * Updates from Stratux situation data.
 */

class NavStrip {
    constructor(container, stratuxClient) {
        this.container = container;
        this.stratux = stratuxClient;
        this.activePlan = null;
        this.activeWpIndex = 0;
        this._el = null;
    }

    init() {
        this._el = document.createElement('div');
        this._el.className = 'nav-strip';
        this._el.innerHTML = `
            <div class="nav-strip-item" data-field="next">
                <span class="nav-strip-label">NEXT</span>
                <span class="nav-strip-value" id="ns-next">—</span>
                <span class="nav-strip-sub" id="ns-next-dist"></span>
                <span class="nav-strip-sub" id="ns-next-ete"></span>
            </div>
            <div class="nav-strip-sep" data-after="next"></div>
            <div class="nav-strip-item" data-field="dest">
                <span class="nav-strip-label">DEST</span>
                <span class="nav-strip-value" id="ns-dest">—</span>
                <span class="nav-strip-sub" id="ns-dest-dist"></span>
                <span class="nav-strip-sub" id="ns-dest-ete"></span>
            </div>
            <div class="nav-strip-sep" data-after="dest"></div>
            <div class="nav-strip-item" data-field="gs">
                <span class="nav-strip-label">GS</span>
                <span class="nav-strip-value instrument-value" id="ns-gs">—</span>
                <span class="nav-strip-sub">kt</span>
            </div>
            <div class="nav-strip-sep" data-after="gs"></div>
            <div class="nav-strip-item" data-field="alt">
                <span class="nav-strip-label">ALT</span>
                <span class="nav-strip-value instrument-value" id="ns-alt">—</span>
                <span class="nav-strip-sub">ft</span>
            </div>
            <div class="nav-strip-sep" data-after="alt"></div>
            <div class="nav-strip-item" data-field="vs">
                <span class="nav-strip-label">VS</span>
                <span class="nav-strip-value" id="ns-vs">—</span>
                <span class="nav-strip-sub">fpm</span>
            </div>
            <div class="nav-strip-sep" data-after="vs"></div>
            <div class="nav-strip-item" data-field="range">
                <span class="nav-strip-label">RANGE</span>
                <span class="nav-strip-value" id="ns-range">—</span>
                <span class="nav-strip-sub">nm</span>
            </div>
            <div class="nav-strip-sep" data-after="range"></div>
            <div class="nav-strip-item" data-field="fuel">
                <span class="nav-strip-label">FUEL</span>
                <span class="nav-strip-value" id="ns-fuel-rem">—</span>
                <span class="nav-strip-sub" id="ns-fuel-endur"></span>
            </div>
        `;
        this.container.appendChild(this._el);

        // Cache DOM refs for 1Hz hot-path updates
        this._dom = {
            gs: this._el.querySelector('#ns-gs'),
            alt: this._el.querySelector('#ns-alt'),
            vs: this._el.querySelector('#ns-vs'),
            next: this._el.querySelector('#ns-next'),
            nextDist: this._el.querySelector('#ns-next-dist'),
            nextEte: this._el.querySelector('#ns-next-ete'),
            dest: this._el.querySelector('#ns-dest'),
            destDist: this._el.querySelector('#ns-dest-dist'),
            destEte: this._el.querySelector('#ns-dest-ete'),
        };

        // Apply config-driven field visibility
        if (typeof CockpitConfig !== 'undefined') {
            const cfg = CockpitConfig.get('navStrip');
            if (cfg && Array.isArray(cfg.fields)) {
                const enabled = new Set(cfg.fields);
                for (const item of this._el.querySelectorAll('.nav-strip-item[data-field]')) {
                    const field = item.getAttribute('data-field');
                    if (!enabled.has(field)) {
                        item.style.display = 'none';
                        // Also hide the separator that follows this item
                        const sep = this._el.querySelector(`.nav-strip-sep[data-after="${field}"]`);
                        if (sep) sep.style.display = 'none';
                    }
                }
            }
        }

        this._onSituation = (e) => this._update(e.detail);
        this.stratux.addEventListener('stratux:situation', this._onSituation);

        // Blank values when Stratux disconnects
        this._onDisconnect = () => {
            this._dom.gs.textContent = '—';
            this._dom.alt.textContent = '—';
            this._dom.vs.textContent = '—';
        };
        this.stratux.addEventListener('stratux:disconnect', this._onDisconnect);
    }

    destroy() {
        if (this._onSituation) {
            this.stratux.removeEventListener('stratux:situation', this._onSituation);
        }
        if (this._onDisconnect) {
            this.stratux.removeEventListener('stratux:disconnect', this._onDisconnect);
        }
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    }

    setActivePlan(plan) {
        this.activePlan = plan;
        // Start at 1: waypoint 0 is departure (where you are), NEXT is the first waypoint to fly to
        this.activeWpIndex = plan?.waypoints?.length > 1 ? 1 : 0;
        this._updatePlanDisplay();
    }

    advanceWaypoint() {
        if (this.activePlan && this.activeWpIndex < this.activePlan.waypoints.length - 1) {
            this.activeWpIndex++;
            this._updatePlanDisplay();
        }
    }

    _update(sit) {
        if (!sit) return;

        // Zero out flight instruments if GPS fix is lost (quality=0 means no fix)
        const gpsOk = sit.gps_fix_quality > 0;
        const gs = gpsOk ? sit.ground_speed : null;
        const alt = gpsOk ? (sit.alt_msl || sit.alt_baro) : null;
        const vs = gpsOk ? sit.vertical_speed : null;

        this._dom.gs.textContent = gs != null ? Math.round(gs) : '—';
        this._dom.alt.textContent = alt != null ? Math.round(alt).toLocaleString() : '—';
        this._dom.vs.textContent = vs != null ? (vs > 0 ? '+' : '') + Math.round(vs) : '—';

        // Update distances to waypoints (use != null so lat=0 is valid)
        if (this.activePlan && sit.lat != null && sit.lon != null) {
            this._updateWpDistances(sit);
        }
    }

    _updatePlanDisplay() {
        if (!this.activePlan || !this.activePlan.waypoints) return;
        const wps = this.activePlan.waypoints;

        // Next waypoint
        const next = wps[this.activeWpIndex];
        this._dom.next.textContent = next ? (next.icao || next.name || '—') : '—';

        // Destination: use the plan's declared destination ICAO first (most reliable),
        // then fall back to the last waypoint with type='APT', then last waypoint.
        const destIdx = NavStrip._destIndex(this.activePlan, wps);
        const dest = destIdx >= 0 ? wps[destIdx] : null;
        this._dom.dest.textContent = dest ? (dest.icao || dest.name || '—') : '—';
    }

    /**
     * Find the index of the destination waypoint in the route.
     * Looks for the last waypoint with type='APT', which is set authoritatively
     * by _applyPlan via NASR lookup. Falls back to the last waypoint.
     */
    static _destIndex(plan, wps) {
        if (!wps.length) return -1;
        for (let i = wps.length - 1; i >= 0; i--) {
            if (wps[i].type === 'APT') return i;
        }
        return wps.length - 1;
    }

    _updateWpDistances(sit) {
        const wps = this.activePlan.waypoints;
        const gs = sit.ground_speed || 0;

        // Distance to next waypoint
        const next = wps[this.activeWpIndex];
        if (next && next.lat != null && next.lon != null) {
            const dist = CockpitMap._distNm(sit.lat, sit.lon, next.lat, next.lon);
            this._dom.nextDist.textContent = dist.toFixed(1) + ' nm';
            if (gs > 10) {
                const ete = dist / gs * 60;
                this._dom.nextEte.textContent = NavStrip._formatEte(ete);
            }

            // Auto-advance: if within 1 NM of next waypoint, advance
            if (dist < 1.0 && this.activeWpIndex < wps.length - 1) {
                this.advanceWaypoint();
            }
        }

        // Distance to destination airport (sum legs only up to dest, not through MAP fixes after it)
        const destLimitIdx = NavStrip._destIndex(this.activePlan, wps);
        let destDist = 0;
        const activeWp = wps[this.activeWpIndex];
        if (activeWp && activeWp.lat != null && activeWp.lon != null
                && this.activeWpIndex <= destLimitIdx) {
            destDist += CockpitMap._distNm(sit.lat, sit.lon, activeWp.lat, activeWp.lon);
            for (let i = this.activeWpIndex; i < destLimitIdx; i++) {
                const a = wps[i], b = wps[i + 1];
                if (a.lat != null && a.lon != null && b.lat != null && b.lon != null) {
                    destDist += CockpitMap._distNm(a.lat, a.lon, b.lat, b.lon);
                }
            }
        }
        this._dom.destDist.textContent = destDist.toFixed(0) + ' nm';
        if (gs > 10) {
            const ete = destDist / gs * 60;
            this._dom.destEte.textContent = NavStrip._formatEte(ete);
        }
    }

    static _formatEte(minutes) {
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
    }
}
