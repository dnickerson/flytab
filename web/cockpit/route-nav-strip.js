/**
 * FlyTab — Route Nav Strip
 * Thin bottom strip showing live enroute navigation data.
 * Active waypoint at top, fuel@dest from live engine data.
 * Replaces the collapsed route table as the primary in-flight nav display.
 */

class RouteNavStrip {
    constructor() {
        this._el = null;
        this._expanded = false;
        this._hasRoute = false;
        this._legData = null;
        this._onLegUpdate = null;
        this._onPlanChange = null;
    }

    init(containerEl) {
        this._el = document.createElement('div');
        this._el.className = 'rnav-strip';
        this._el.innerHTML = this._buildHtml();
        containerEl.appendChild(this._el);

        // Tap compact strip to expand/collapse
        const compact = this._el.querySelector('.rnav-compact');
        if (compact) {
            compact.addEventListener('click', () => this._toggleExpand());
        }

        // EDIT button
        const editBtn = this._el.querySelector('.rnav-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (typeof app !== 'undefined') app.openRoutePlanner(app._currentTrip);
            });
        }

        // Listen for route leg updates (1Hz from route-table)
        this._onLegUpdate = (e) => {
            this._legData = e.detail;
            this._update();
        };
        window.addEventListener('activeroute:legupdate', this._onLegUpdate);

        // Listen for route plan changes
        this._onPlanChange = (e) => {
            const plan = e.detail?.plan;
            this._hasRoute = !!(plan?.waypoints?.length > 1);
            this._el.classList.toggle('rnav-hidden', !this._hasRoute);
        };
        window.addEventListener('activeroute:plan', this._onPlanChange);

        // Initially hidden until a route is loaded
        this._el.classList.add('rnav-hidden');

        return this._el;
    }

    /** Show the strip (called when a route is loaded) */
    show() {
        this._hasRoute = true;
        this._el.classList.remove('rnav-hidden');
    }

    /** Hide the strip (called when route is cleared) */
    hide() {
        this._hasRoute = false;
        this._el.classList.add('rnav-hidden');
        this._expanded = false;
        this._el.classList.remove('rnav-expanded');
    }

    destroy() {
        if (this._onLegUpdate) window.removeEventListener('activeroute:legupdate', this._onLegUpdate);
        if (this._onPlanChange) window.removeEventListener('activeroute:plan', this._onPlanChange);
        if (this._el?.parentNode) this._el.parentNode.removeChild(this._el);
    }

    _buildHtml() {
        return `
            <div class="rnav-compact">
                <div class="rnav-row rnav-active-row">
                    <span class="rnav-wpt" data-field="wpt">---</span>
                    <span class="rnav-cell" data-field="hdg"><span class="rnav-lbl">CRS</span><span class="rnav-val">---</span></span>
                    <span class="rnav-cell" data-field="dist"><span class="rnav-lbl">DIST</span><span class="rnav-val">---</span></span>
                    <span class="rnav-cell" data-field="ete"><span class="rnav-lbl">ETE</span><span class="rnav-val">---</span></span>
                    <span class="rnav-cell" data-field="alt"><span class="rnav-lbl">ALT</span><span class="rnav-val">---</span></span>
                    <button class="rnav-edit-btn">EDIT</button>
                </div>
                <div class="rnav-row rnav-detail-row">
                    <span class="rnav-cell rnav-fuel-dest" data-field="fuel_dest"><span class="rnav-lbl">FUEL@DEST</span><span class="rnav-val">---</span></span>
                    <span class="rnav-cell" data-field="dev"><span class="rnav-lbl">DEV</span><span class="rnav-val">---</span></span>
                    <span class="rnav-cell" data-field="dest_dist"><span class="rnav-lbl">DEST</span><span class="rnav-val">---</span></span>
                    <span class="rnav-cell" data-field="dest_ete"><span class="rnav-lbl">ETA</span><span class="rnav-val">---</span></span>
                    <span class="rnav-cell rnav-next" data-field="next"><span class="rnav-lbl">NEXT</span><span class="rnav-val">---</span></span>
                </div>
            </div>
            <div class="rnav-upcoming"></div>
        `;
    }

    _toggleExpand() {
        this._expanded = !this._expanded;
        this._el.classList.toggle('rnav-expanded', this._expanded);
        if (this._expanded && this._legData) {
            this._renderUpcoming();
        }
    }

    _update() {
        const d = this._legData;
        if (!d) return;

        // Active waypoint identifier
        this._setVal('wpt', d.activeIcao || '---');

        // Heading (wind-corrected magnetic)
        this._setVal('hdg', d.hdg != null ? Math.round(d.hdg) + '°' : '---');

        // Distance to active waypoint
        const distNm = d.activeDistNm;
        this._setVal('dist', distNm != null ? (distNm < 10 ? distNm.toFixed(1) : Math.round(distNm)) + 'nm' : '---');

        // ETE to active waypoint (use live GS when available)
        let eteMin = d.activeEteMin;
        if (d.activeDistNm != null && d.liveGs > 10) {
            eteMin = (d.activeDistNm / d.liveGs) * 60;
        }
        this._setVal('ete', eteMin != null ? RouteNavStrip._fmtTime(eteMin) : '---');

        // Crossing altitude
        this._setVal('alt', d.activeAlt != null ? d.activeAlt.toLocaleString() : '---');

        // Fuel at destination — the key differentiator
        const fuelAtDest = this._calcFuelAtDest(d);
        const fuelEl = this._el.querySelector('[data-field="fuel_dest"] .rnav-val');
        if (fuelEl) {
            if (fuelAtDest != null) {
                fuelEl.textContent = fuelAtDest.toFixed(1) + ' gal';
                const cautionGal = (typeof CockpitConfig !== 'undefined') ? (CockpitConfig.get('enginePage.fuelCautionGal') ?? 8) : 8;
                const warnGal = (typeof CockpitConfig !== 'undefined') ? (CockpitConfig.get('enginePage.fuelWarningGal') ?? 4) : 4;
                fuelEl.className = 'rnav-val' +
                    (fuelAtDest <= warnGal ? ' rnav-red' : fuelAtDest <= cautionGal ? ' rnav-amber' : ' rnav-green');
            } else {
                fuelEl.textContent = '---';
                fuelEl.className = 'rnav-val';
            }
        }

        // Cross-track deviation
        const xtk = d.xtk;
        if (xtk != null) {
            const dir = xtk >= 0 ? 'R' : 'L';
            const absXtk = Math.abs(xtk);
            const devText = absXtk < 0.1 ? 'ON TRK' : (absXtk < 10 ? absXtk.toFixed(1) : Math.round(absXtk)) + dir;
            const devEl = this._el.querySelector('[data-field="dev"] .rnav-val');
            if (devEl) {
                devEl.textContent = devText;
                devEl.className = 'rnav-val' + (absXtk > 5 ? ' rnav-red' : absXtk > 2 ? ' rnav-amber' : '');
            }
        } else {
            this._setVal('dev', '---');
        }

        // Destination distance and ETE/ETA
        this._setVal('dest_dist', d.destDistNm != null ? Math.round(d.destDistNm) + 'nm' : '---');
        let destEte = d.destEteMin;
        if (d.destDistNm != null && d.liveGs > 10) {
            destEte = (d.destDistNm / d.liveGs) * 60;
        }
        if (destEte != null) {
            const eteStr = RouteNavStrip._fmtTime(destEte);
            if (d.destEta) {
                const etaStr = new Date(d.destEta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                this._setVal('dest_ete', `${eteStr} · ${etaStr}`);
            } else {
                this._setVal('dest_ete', eteStr);
            }
        } else {
            this._setVal('dest_ete', '---');
        }

        // Next waypoint
        if (d.nextIcao) {
            const nextDist = d.nextDistNm != null ? ' ' + Math.round(d.nextDistNm) + 'nm' : '';
            this._setVal('next', d.nextIcao + nextDist);
        } else {
            this._setVal('next', '---');
        }

        // Update upcoming list if expanded
        if (this._expanded) this._renderUpcoming();
    }

    /**
     * Calculate fuel remaining at destination using live engine data.
     * fuelAtDest = currentFuel - (destDist / liveGS * liveGPH)
     * Falls back to planned fuel remaining if engine data unavailable.
     */
    _calcFuelAtDest(d) {
        const currentFuel = d.fuelRemaining;
        if (currentFuel == null) return d.destFuelRem ?? null;

        const gph = d.liveGph ?? d.plannedGph;
        const gs = d.liveGs;
        const distNm = d.destDistNm;

        if (gph > 0 && gs > 10 && distNm != null) {
            const timeHrs = distNm / gs;
            return currentFuel - (timeHrs * gph);
        }

        // Fallback: use planned fuel remaining from route computation
        return d.destFuelRem ?? null;
    }

    _renderUpcoming() {
        const container = this._el.querySelector('.rnav-upcoming');
        if (!container || !this._legData?.upcoming) return;

        const rows = this._legData.upcoming.map(wp => {
            const alt = wp.alt != null ? wp.alt.toLocaleString() : '---';
            const dist = wp.dist != null ? Math.round(wp.dist) + 'nm' : '---';
            const ete = wp.ete != null ? RouteNavStrip._fmtTime(wp.ete) : '---';
            const fuel = wp.fuelRem != null ? wp.fuelRem.toFixed(1) : '---';
            return `<div class="rnav-row rnav-upcoming-row">
                <span class="rnav-wpt">${wp.icao}</span>
                <span class="rnav-ucell">${dist}</span>
                <span class="rnav-ucell">${ete}</span>
                <span class="rnav-ucell">${alt}</span>
                <span class="rnav-ucell">${fuel}gal</span>
            </div>`;
        });

        container.innerHTML = rows.join('');
    }

    _setVal(field, text) {
        const el = this._el.querySelector(`[data-field="${field}"] .rnav-val`);
        if (el) el.textContent = text;
    }

    static _fmtTime(minutes) {
        if (minutes == null || minutes < 0) return '---';
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
    }
}
