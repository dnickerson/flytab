/**
 * FlyTab — PlanSync
 * Fetches flight plans from flywhere.app and loads them into the cockpit.
 * When online: shows a picker of recent plans from the Supabase backend.
 * When offline: loads the last plan from localStorage.
 *
 * Config (cockpit-config.json):
 *   flywhere.apiUrl  — defaults to "https://flywhere.app"
 *   flywhere.apiKey  — x-api-key for tablet authentication
 */

class PlanSync {
    constructor() {
        this._el = null;
        this._visible = false;
        this._apiUrl = 'https://flywhere.app';
        this._apiKey = '';
        this._loadCfg();
        this._buildDOM();
    }

    _loadCfg() {
        if (typeof CockpitConfig === 'undefined') return;
        const cfg = CockpitConfig.get('flywhere') || {};
        if (cfg.apiUrl) this._apiUrl = cfg.apiUrl;
        if (cfg.apiKey) this._apiKey = cfg.apiKey;
    }

    // ── DOM ──────────────────────────────────────────────────────────────────

    _buildDOM() {
        this._activeTab = 'cloud';  // 'cloud' | 'device'

        this._el = document.createElement('div');
        this._el.className = 'ps-overlay';
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="ps-container">
                <div class="ps-header">
                    <span class="ps-title">FLIGHT PLANS</span>
                    <button class="btn-close ep-close ps-close">✕</button>
                </div>
                <div class="ps-tabs">
                    <button class="ps-tab ps-tab-active" data-tab="cloud">CLOUD</button>
                    <button class="ps-tab" data-tab="device">DEVICE</button>
                </div>
                <div class="ps-body" id="ps-body">
                    <div class="ps-spinner">Loading…</div>
                </div>
            </div>
        `;

        const closeBtn = this._el.querySelector('.ps-close');
        closeBtn.addEventListener('touchstart', (e) => { e.stopPropagation(); this.hide(); }, { passive: true });
        closeBtn.addEventListener('click', () => this.hide());

        this._el.querySelectorAll('.ps-tab').forEach(tab => {
            tab.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
        });

        document.body.appendChild(this._el);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    _switchTab(tab) {
        this._activeTab = tab;
        this._el.querySelectorAll('.ps-tab').forEach(t => {
            t.classList.toggle('ps-tab-active', t.dataset.tab === tab);
        });
        const body = document.getElementById('ps-body');
        if (tab === 'cloud') {
            this._fetchAndRender();
        } else {
            this._renderDeviceTab(body);
        }
    }

    show() {
        this._el.style.display = 'flex';
        this._visible = true;
        this._switchTab(this._activeTab || 'cloud');
    }

    showDeviceTab() {
        this._el.style.display = 'flex';
        this._visible = true;
        this._switchTab('device');
    }

    hide() {
        this._el.style.display = 'none';
        this._visible = false;
    }

    // ── Fetch + Render ───────────────────────────────────────────────────────

    async _fetchAndRender() {
        const body = document.getElementById('ps-body');
        body.innerHTML = '<div class="ps-spinner">Loading…</div>';

        // Try online fetch first
        if (this._apiKey) {
            try {
                const resp = await fetch(`${this._apiUrl}/api/plans?limit=15`, {
                    headers: { 'x-api-key': this._apiKey },
                    signal: AbortSignal.timeout(6000),
                });
                if (resp.ok) {
                    const { plans } = await resp.json();
                    if (plans?.length) {
                        this._renderList(body, plans);
                        return;
                    }
                    this._renderEmpty(body, 'No plans found on flywhere.app.');
                    return;
                }
                if (resp.status === 401) {
                    this._renderError(body, 'API key not authorized. Check cockpit-config.json flywhere.apiKey.');
                    return;
                }
            } catch (err) {
                console.log('[PlanSync] Network error:', err.message);
                body.innerHTML = `<div class="ps-error">Network error: ${err.message}</div>`;
                return;
            }
        } else {
            console.log('[PlanSync] No API key configured — using localStorage only.');
            body.innerHTML = '<div class="ps-error">No API key set in cockpit-config.json (flywhere.apiKey)</div>';
            return;
        }

        // Offline fallback: reload last plan from localStorage
        this._renderOffline(body);
    }

    _renderList(body, plans) {
        let html = '<div class="ps-list">';
        for (const p of plans) {
            const dep = p.departure_icao || '?';
            const dest = p.destination_icao || '?';
            const dateStr = p.updated_at ? new Date(p.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            const label = p.name || `${dep} → ${dest}`;
            html += `
                <div class="ps-row" data-id="${p.id}">
                    <span class="ps-row-route">${label}</span>
                    <span class="ps-row-date">${dateStr}</span>
                    <button class="ps-brief-btn" data-id="${p.id}" title="Download preflight brief">⬇ Brief</button>
                </div>`;
        }
        html += '</div>';

        body.innerHTML = html;

        // Cache list items for offline if we just fetched them
        try { localStorage.setItem('ps_last_list', JSON.stringify(plans)); } catch {}

        body.querySelectorAll('.ps-row').forEach(row => {
            row.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            // Click on the row itself (not the brief button) loads the plan
            row.addEventListener('click', (e) => {
                if (e.target.closest('.ps-brief-btn')) return;
                this._loadPlan(row.dataset.id);
            });
        });

        body.querySelectorAll('.ps-brief-btn').forEach(btn => {
            btn.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._downloadBrief(btn.dataset.id, btn);
            });
        });
    }

    _renderOffline(body) {
        // Try cached plan list first
        let plans = null;
        try { plans = JSON.parse(localStorage.getItem('ps_last_list') || 'null'); } catch {}

        const raw = localStorage.getItem('flypi_active_plan');

        if (!plans?.length && !raw) {
            this._renderEmpty(body, 'No network and no cached plan found.');
            return;
        }

        let html = '<div class="ps-offline-notice">OFFLINE — showing cached plans</div><div class="ps-list">';

        if (plans?.length) {
            for (const p of plans) {
                const dep = p.departure_icao || '?';
                const dest = p.destination_icao || '?';
                const dateStr = p.updated_at ? new Date(p.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                const label = p.name || `${dep} → ${dest}`;
                html += `<div class="ps-row" data-id="${p.id}">
                    <span class="ps-row-route">${label}</span>
                    <span class="ps-row-date">${dateStr}</span>
                </div>`;
            }
        } else if (raw) {
            // Last active plan only
            html += `<div class="ps-row ps-row-active" data-id="__local">
                <span class="ps-row-route">Last loaded plan</span>
                <span class="ps-row-date">cached</span>
            </div>`;
        }
        html += '</div>';

        body.innerHTML = html;

        body.querySelectorAll('.ps-row').forEach(row => {
            row.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            row.addEventListener('click', () => this._loadPlan(row.dataset.id));
        });
    }

    async _renderDeviceTab(body) {
        body.innerHTML = '<div class="ps-spinner">Loading…</div>';
        let trips = [];
        try {
            if (typeof TripStore !== 'undefined') trips = await TripStore.list();
        } catch (err) {
            body.innerHTML = `<div class="ps-error">Could not read saved plans: ${err.message}</div>`;
            return;
        }

        // Fix 4: guard against stale async continuation if user switched tabs
        if (this._activeTab !== 'device') return;

        if (!trips.length) {
            body.innerHTML = '<div class="ps-empty">No saved plans yet.<br>Use the Save button in the route planner, or "Save Plan" from the menu.</div>';
            return;
        }

        const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        let html = '<div class="ps-list">';
        for (const t of trips) {
            const dateStr = t.created_at ? new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
            const badge   = t.legs?.length > 1 ? `<span class="ps-legs-badge">${t.legs.length} legs</span>` : '';
            html += `
                <div class="ps-row" data-trip-id="${esc(t.id)}">
                    <div class="ps-row-main">
                        <span class="ps-row-route">${esc(t.name)}</span>
                        ${badge}
                    </div>
                    <div class="ps-row-sub">
                        <span class="ps-row-date">${dateStr}</span>
                        <button class="ps-row-delete" data-trip-id="${esc(t.id)}" title="Delete">✕</button>
                    </div>
                </div>`;
        }
        html += '</div>';
        body.innerHTML = html;

        body.querySelectorAll('.ps-row').forEach(row => {
            row.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            row.addEventListener('click', (e) => {
                if (e.target.closest('.ps-row-delete')) return;
                const id = row.dataset.tripId;
                const trip = trips.find(t => t.id === id);
                if (trip) this._showTripBottomSheet(trip);
            });
        });

        body.querySelectorAll('.ps-row-delete').forEach(btn => {
            btn.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = btn.dataset.tripId;
                if (!confirm('Delete this saved plan?')) return;
                await TripStore.delete(id).catch(() => {});
                this._renderDeviceTab(body);
            });
        });
    }

    _showTripBottomSheet(trip) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:20000;display:flex;align-items:flex-end;justify-content:center';

        const esc = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

        const legs = trip.legs || [];

        // Fix 2: guard against empty legs list before rendering buttons
        if (!legs.length) {
            overlay.innerHTML = `
                <div class="ps-sheet">
                    <div class="ps-sheet-title">${esc(trip.name)}</div>
                    <div class="ps-sheet-empty">No legs stored in this plan.</div>
                    <button class="ps-sheet-btn ps-sheet-cancel" data-action="cancel">Close</button>
                </div>`;
            overlay.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
            overlay.addEventListener('click', (e) => {
                if (e.target.closest('[data-action="cancel"]')) overlay.remove();
            });
            document.body.appendChild(overlay);
            return;
        }

        let buttonsHtml = '';
        if (legs.length <= 1) {
            buttonsHtml = `
                <button class="ps-sheet-btn" data-action="load" data-leg-idx="0">Load as-is</button>
                <button class="ps-sheet-btn" data-action="replan" data-leg-idx="0">Replan with current winds</button>`;
        } else {
            buttonsHtml = legs.map((leg, i) =>
                `<button class="ps-sheet-btn" data-action="load" data-leg-idx="${i}">Load Leg ${i + 1}: ${esc(leg.dep)} → ${esc(leg.dest)}</button>`
            ).join('');
        }

        overlay.innerHTML = `
            <div class="ps-sheet">
                <div class="ps-sheet-title">${esc(trip.name)}</div>
                ${buttonsHtml}
                <button class="ps-sheet-btn ps-sheet-cancel" data-action="cancel">Cancel</button>
            </div>`;

        overlay.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
        overlay.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            overlay.remove();

            const action = btn.dataset.action;
            if (action === 'cancel') return;

            const legIdx = Number(btn.dataset.legIdx ?? 0);
            const leg = trip.legs?.[legIdx];
            if (!leg) return;

            const planToLoad = {
                departure:   leg.dep,
                destination: leg.dest,
                waypoints:   leg.waypoints,
                flight_plan: leg.flight_plan,
            };

            // Fix 3: wrap async operations in try/catch
            try {
                this.hide();
                await window.app?.applyRouteEdit(planToLoad);

                // Pass full trip to CLR page so leg toggle works for all legs
                if (window.app?.ifrClearance) {
                    window.app.ifrClearance._flightPlan = trip;
                }

                if (action === 'replan') {
                    window.app?.routePlannerPanel?.open(planToLoad);
                    setTimeout(() => window.app?.routePlannerPanel?._onRecomputeTap(), 100);
                }

                // Fix 1: escape trip.name to prevent XSS
                window.app?.showToast?.(`Loaded: ${esc(trip.name)}`);
            } catch (err) {
                console.error('[PlanSync] load trip failed:', err);
                window.app?.showToast?.('Failed to load plan');
            }
        });

        document.body.appendChild(overlay);
    }

    _renderEmpty(body, msg) {
        body.innerHTML = `<div class="ps-empty">${msg}</div>`;
    }

    _renderError(body, msg) {
        body.innerHTML = `<div class="ps-error">${msg}</div>`;
    }

    // ── Plan Loading ─────────────────────────────────────────────────────────

    async _loadPlan(id) {
        const body = document.getElementById('ps-body');
        body.innerHTML = '<div class="ps-spinner">Loading plan…</div>';

        if (id === '__local') {
            try {
                const raw = localStorage.getItem('flypi_active_plan');
                if (raw) {
                    const plan = JSON.parse(raw);
                    this.hide();
                    await window.app?.applyRouteEdit(plan);
                    window.app?.showToast('Plan loaded from local cache.');
                    return;
                }
            } catch {}
            this._renderError(body, 'Could not read local plan.');
            return;
        }

        try {
            const resp = await fetch(`${this._apiUrl}/api/plans/${id}`, {
                headers: { 'x-api-key': this._apiKey },
                signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) {
                this._renderError(body, `Server error: ${resp.status}`);
                return;
            }
            const { plan } = await resp.json();
            const normalized = PlanSync._normalizePlan(plan);
            this.hide();
            await window.app?.applyRouteEdit(normalized);
            // Cache for offline
            try { localStorage.setItem('flypi_active_plan', JSON.stringify(normalized)); } catch {}
            window.app?.showToast(`Plan loaded: ${normalized.name || ''}`);
        } catch (err) {
            this._renderError(body, `Failed to load: ${err.message}`);
        }
    }

    // ── Preflight Brief ───────────────────────────────────────────────────────

    /**
     * Download the preflight brief for a plan from the server and cache it
     * in localStorage (preflight_brief_<id>). Updates the button state inline.
     */
    async _downloadBrief(id, btn) {
        if (!this._apiKey) {
            window.app?.showToast('API key required to download brief.');
            return;
        }

        const originalText = btn.textContent;
        btn.textContent = '…';
        btn.disabled = true;

        try {
            // First try to get existing brief-package from server
            let bundle = null;
            let stale = false;

            const pkgResp = await fetch(`${this._apiUrl}/api/plans/${id}/brief-package`, {
                headers: { 'x-api-key': this._apiKey },
                signal: AbortSignal.timeout(8000),
            });

            if (pkgResp.ok) {
                const pkg = await pkgResp.json();
                if (pkg.bundle) {
                    bundle = pkg.bundle;
                    stale = pkg.stale === true;
                }
            }

            // If no bundle or stale, generate a fresh one via POST
            if (!bundle || stale) {
                btn.textContent = '⏳';
                const genResp = await fetch(`${this._apiUrl}/api/plans/${id}/brief`, {
                    method: 'POST',
                    headers: { 'x-api-key': this._apiKey, 'Content-Type': 'application/json' },
                    signal: AbortSignal.timeout(60000), // Claude call can take up to ~30s
                });
                if (!genResp.ok) {
                    throw new Error(`Server ${genResp.status}`);
                }
                const { bundle: freshBundle } = await genResp.json();
                bundle = freshBundle;
            }

            // Cache locally for offline use
            try { localStorage.setItem(`preflight_brief_${id}`, JSON.stringify(bundle)); } catch {}

            btn.textContent = '✓ Brief';
            btn.disabled = false;
            window.app?.showToast('Brief downloaded — tap ✓ Brief to view.');

            // Re-wire the button to open the brief
            btn.onclick = (e) => {
                e.stopPropagation();
                this.openBrief(id);
            };

        } catch (err) {
            console.error('[PlanSync] brief download error:', err.message);
            btn.textContent = originalText;
            btn.disabled = false;
            window.app?.showToast(`Brief failed: ${err.message}`);
        }
    }

    /**
     * Open the preflight brief overlay for a plan.
     * Loads bundle from localStorage (cached by _downloadBrief).
     */
    openBrief(id) {
        let bundle = null;
        try { bundle = JSON.parse(localStorage.getItem(`preflight_brief_${id}`) || 'null'); } catch {}

        if (!bundle) {
            window.app?.showToast('No brief downloaded for this plan.');
            return;
        }

        if (window.preflightBrief) {
            this.hide();
            window.preflightBrief.show(bundle);
        } else {
            window.app?.showToast('Preflight brief viewer not available.');
        }
    }

    // ── Deep Link API ────────────────────────────────────────────────────────

    /**
     * Fetch a single plan by ID from the flywhere.app API and return a
     * normalized plan object suitable for applyRouteEdit(). Returns null on failure.
     */
    async fetchPlanById(planId) {
        try {
            const resp = await fetch(`${this._apiUrl}/api/plans/${planId}`, {
                headers: { 'x-api-key': this._apiKey },
                signal: AbortSignal.timeout(8000),
            });
            if (!resp.ok) return null;
            const { plan } = await resp.json();
            return PlanSync._normalizePlan(plan);
        } catch (err) {
            console.warn('[PlanSync] fetchPlanById error:', err.message);
            return null;
        }
    }

    // ── Plan Format Normalization ─────────────────────────────────────────────

    /**
     * Convert a flywhere.app Supabase plan record → _applyPlan() format.
     * The Supabase record stores route data in workflow_data.route, which has:
     *   route    — string[]  (ICAO waypoints)
     *   legs     — any[]     (performance legs with segments)
     *   altitude — number
     */
    static _normalizePlan(dbPlan) {
        const wd = dbPlan.workflow_data || {};
        const routeStep = wd.route || {};
        const aircraft = wd.aircraft?.aircraft || null;

        const dep  = routeStep.departure   || dbPlan.departure_icao   || null;
        const dest = routeStep.destination || dbPlan.destination_icao || null;

        const fp = {
            departure:   dep,
            destination: dest,
            route:       routeStep.route       || [],
            legs:        routeStep.legs        || [],
            altitude:    routeStep.altitude    || null,
        };

        // Build waypoints from resolvedWaypoints (has lat/lon) if available,
        // otherwise fall back to ICAO-only route array for NASR resolution.
        let waypoints = null;
        if (routeStep.resolvedWaypoints?.length >= 2) {
            waypoints = routeStep.resolvedWaypoints.map((rw, i) => {
                const leg = i > 0 ? (fp.legs[i - 1] || {}) : {};
                const cruiseSeg = (leg.segments || []).find(s => s.phase === 'CRZ')
                               || leg.segments?.[leg.segments.length - 1];
                return {
                    icao:   rw.id,
                    name:   rw.name || rw.id,
                    lat:    rw.lat,
                    lon:    rw.lon,
                    elev_ft: rw.elev_ft ?? null,
                    type:   rw.id === dep || rw.id === dest ? 'APT'
                          : rw.type === 'airport' ? 'APT' : (rw.type?.toUpperCase() || undefined),
                    alt:    leg.altitude || fp.altitude || null,
                    gs:     leg.gs  || null,
                    tas:    leg.tas || null,
                    gph:    cruiseSeg?.gph || null,
                    wind:   (leg.windDir != null && leg.windSpd != null)
                            ? { dir: leg.windDir, spd: leg.windSpd } : null,
                    _segments: leg.segments || [],
                };
            });
        }

        return {
            id:          dbPlan.id,
            name:        dbPlan.name || `${dep} → ${dest}`,
            created_at:  dbPlan.created_at || new Date().toISOString(),
            waypoints:   waypoints,   // pre-resolved, or null → applyRouteEdit will use flight_plan.route
            flight_plan: fp,
            aircraft:    aircraft,
        };
    }
}
