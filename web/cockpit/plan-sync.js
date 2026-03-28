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
        this._el = document.createElement('div');
        this._el.className = 'ps-overlay';
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="ps-container">
                <div class="ps-header">
                    <span class="ps-title">LOAD FLIGHT PLAN</span>
                    <button class="ep-close ps-close">✕</button>
                </div>
                <div class="ps-body" id="ps-body">
                    <div class="ps-spinner">Loading…</div>
                </div>
            </div>
        `;

        const closeBtn = this._el.querySelector('.ps-close');
        closeBtn.addEventListener('touchstart', (e) => { e.stopPropagation(); this.hide(); }, { passive: true });
        closeBtn.addEventListener('click', () => this.hide());

        document.body.appendChild(this._el);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    show() {
        this._el.style.display = 'flex';
        this._visible = true;
        this._fetchAndRender();
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
                // Offline or timeout — fall through to localStorage
                console.log('[PlanSync] Network unavailable, using localStorage:', err.message);
            }
        } else {
            console.log('[PlanSync] No API key configured — using localStorage only.');
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

        const fp = {
            departure:   routeStep.departure   || dbPlan.departure_icao   || null,
            destination: routeStep.destination || dbPlan.destination_icao || null,
            route:       routeStep.route       || [],
            legs:        routeStep.legs        || [],
            altitude:    routeStep.altitude    || null,
        };

        return {
            id:         dbPlan.id,
            name:       dbPlan.name || `${fp.departure} → ${fp.destination}`,
            created_at: dbPlan.created_at || new Date().toISOString(),
            flight_plan: fp,
            aircraft:    aircraft,
        };
    }
}
