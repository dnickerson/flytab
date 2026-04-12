/**
 * FlyPi v5 — Instrument Strip
 * Bottom bar: GS, ALT, HDG, FUEL▲, DEST, ETE▲ when route active.
 * Without route: GS, ALT, FUEL, DIST, ETE (config-driven fallback).
 * Config-driven field list via cockpit-config.json instrumentStrip.fields.
 */

class InstrumentStrip {
    constructor(stratuxClient, engineClient) {
        this._stratux = stratuxClient;
        this._engine = engineClient || null;
        this._el = null;
        this._activePlan = null;
        this._onSituation = null;
        this._onRouteAdvance = null;
        this._onLegUpdate = null;

        // Default fields if no config
        this._fields = ['gs', 'alt', 'hdg', 'fuel', 'dest', 'ete'];
        this._fuelOverlay = null;
        this._powerTradeoff = null;

        // Last leg update from route-table
        this._legData = null;
    }

    /** Wire the fuel field tap to open the fuel overlay. */
    setFuelOverlay(overlay) {
        this._fuelOverlay = overlay;
    }

    /** Wire the power tradeoff panel (tapping ETE▲ / FUEL▲ opens it). */
    setPowerTradeoff(panel) {
        this._powerTradeoff = panel;
    }

    init() {
        // Load field config
        if (typeof CockpitConfig !== 'undefined') {
            const cfg = CockpitConfig.get('instrumentStrip');
            if (cfg?.fields) this._fields = cfg.fields;
        }

        this._el = document.createElement('div');
        this._el.id = 'is-container';
        this._el.style.cssText = 'display:flex;width:100%;height:100%;';

        // Build fields and cache element references to avoid repeated getElementById calls
        this._els = {};
        for (const field of this._fields) {
            this._el.appendChild(this._makeField(field));
        }

        // Listen to stratux situation
        if (this._stratux) {
            this._onSituation = (e) => this._update(e.detail);
            this._stratux.addEventListener('stratux:situation', this._onSituation);

            // Blank values when Stratux disconnects — but not if internal GPS is active
            this._onDisconnect = () => {
                if (this._stratux._suppressGpsSituation) return;
                this._set('gs', '—');
                this._set('alt', '—');
                this._set('hdg', '—');
                this._set('dest', '—');
                this._set('ete', '—');
            };
            this._stratux.addEventListener('stratux:disconnect', this._onDisconnect);
        }

        // Fuel updates from engine data stream — update FUEL field whenever the Pi sends new data
        this._onEngineData = () => this._updateFuel();
        if (this._engine) this._engine.addEventListener('engine:data', this._onEngineData);

        // Fuel updates from manual fuel overlay changes
        this._onFuelChanged = () => this._updateFuel();
        window.addEventListener('fuelstate:changed', this._onFuelChanged);

        // Route leg updates from RouteTable — HDG, destination ETE/fuel deltas
        this._onLegUpdate = (e) => {
            this._legData = e.detail;
            this._updateLegFields();
        };
        window.addEventListener('activeroute:legupdate', this._onLegUpdate);

        // When route nav strip is active, hide fields it now owns (HDG, DEST, ETE)
        // to avoid duplication. Show them again when no route is loaded.
        this._routeNavFields = ['hdg', 'dest', 'ete'];
        this._onPlanForStrip = (e) => {
            const hasRoute = !!(e.detail?.plan?.waypoints?.length > 1);
            this._setRouteFieldsVisible(!hasRoute);
        };
        window.addEventListener('activeroute:plan', this._onPlanForStrip);

        return this._el;
    }

    destroy() {
        if (this._stratux && this._onSituation) {
            this._stratux.removeEventListener('stratux:situation', this._onSituation);
        }
        if (this._stratux && this._onDisconnect) {
            this._stratux.removeEventListener('stratux:disconnect', this._onDisconnect);
        }
        if (this._engine && this._onEngineData) {
            this._engine.removeEventListener('engine:data', this._onEngineData);
        }
        if (this._onFuelChanged) {
            window.removeEventListener('fuelstate:changed', this._onFuelChanged);
        }
        if (this._onLegUpdate) {
            window.removeEventListener('activeroute:legupdate', this._onLegUpdate);
        }
    }

    /** Hide/show route-dependent fields (HDG, DEST, ETE) when route nav strip takes over */
    _setRouteFieldsVisible(visible) {
        for (const field of this._routeNavFields) {
            const el = this._el.querySelector(`[data-field="${field}"]`);
            if (el) el.style.display = visible ? '' : 'none';
        }
    }

    setActivePlan(plan) {
        // ActiveRoute is the single source of truth — keep local reference only
        // for the _updateRoute hot path (avoids a getter call every GPS tick).
        this._activePlan = plan;
        // Index is owned by ActiveRoute; listen for advances so we stay in sync.
        if (!this._onRouteAdvance) {
            this._onRouteAdvance = () => { /* index read from ActiveRoute on next tick */ };
            window.addEventListener('activeroute:advance', this._onRouteAdvance);
            window.addEventListener('activeroute:plan', this._onRouteAdvance);
        }
    }

    _makeField(field) {
        const div = document.createElement('div');
        div.className = 'is-field';
        div.dataset.field = field;

        const configs = {
            gs:   { label: 'GS',   unit: 'kt'  },
            alt:  { label: 'ALT',  unit: 'ft'  },
            vs:   { label: 'VS',   unit: 'fpm' },
            hdg:  { label: 'HDG',  unit: '°'   },
            fuel: { label: 'FUEL', unit: 'gal' },
            dist: { label: 'DIST', unit: 'nm'  },
            dest: { label: 'DEST', unit: 'nm'  },
            ete:  { label: 'ETE',  unit: ''    },
        };

        const cfg = configs[field] || { label: field.toUpperCase(), unit: '' };

        const labelEl = document.createElement('span');
        labelEl.className = 'is-label';
        labelEl.textContent = cfg.label;

        const valueEl = document.createElement('span');
        valueEl.className = 'is-value';
        valueEl.textContent = '—';

        const unitEl = document.createElement('span');
        unitEl.className = 'is-unit';
        unitEl.textContent = cfg.unit;

        // Delta sub-label for ETE and DEST fields (shows ±delta vs plan)
        let deltaEl = null;
        if (field === 'ete' || field === 'dest' || field === 'fuel') {
            deltaEl = document.createElement('span');
            deltaEl.className = 'is-delta';
            deltaEl.textContent = '';
            div.appendChild(deltaEl);
        }

        div.appendChild(labelEl);
        div.appendChild(valueEl);
        div.appendChild(unitEl);
        if (deltaEl) div.appendChild(deltaEl);

        // Cache references for fast updates
        this._els[field] = valueEl;
        if (deltaEl) this._els[`${field}_delta`] = deltaEl;

        // FUEL field — tap opens fuel overlay
        if (field === 'fuel') {
            div.classList.add('is-field-tap');
            let touchFired = false;
            div.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                touchFired = true;
                this._fuelOverlay?.show();
            }, { passive: true });
            div.addEventListener('click', () => {
                if (!touchFired) this._fuelOverlay?.show();
                touchFired = false;
            });
        }

        // ETE / DEST — tap opens power tradeoff panel
        if (field === 'ete' || field === 'dest') {
            div.classList.add('is-field-tap');
            let touchFired = false;
            div.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                touchFired = true;
                this._powerTradeoff?.toggle();
            }, { passive: true });
            div.addEventListener('click', () => {
                if (!touchFired) this._powerTradeoff?.toggle();
                touchFired = false;
            });
        }

        return div;
    }

    _update(sit) {
        if (!sit) return;

        const gpsOk = sit.gps_fix_quality > 0;
        const gs  = gpsOk ? sit.ground_speed : null;
        const alt = gpsOk ? (sit.alt_msl || sit.alt_baro) : null;

        this._set('gs',  gs  != null ? Math.round(gs)  : '—');
        this._set('alt', alt != null ? Math.round(alt).toLocaleString() : '—');

        this._updateFuel();

        // Legacy dist/ete fields (when no leg data available)
        if (this._activePlan && sit.lat && sit.lon && gpsOk) {
            this._updateRoute(sit);
        }
    }

    /**
     * Update HDG, DEST, ETE and their delta sub-labels from the latest leg update.
     * Called on every activeroute:legupdate event (~1 Hz in flight).
     */
    _updateLegFields() {
        const d = this._legData;
        if (!d) return;

        // HDG — wind-corrected magnetic heading
        const hdg = d.hdg != null ? Math.round(d.hdg) : null;
        this._set('hdg', hdg != null ? hdg : '—');

        // DEST — distance to destination
        const destNm = d.destDistNm != null ? Math.round(d.destDistNm) : null;
        this._set('dest', destNm != null ? destNm : '—');

        // ETE — live time to destination using current GS
        let eteMin = null;
        if (d.destDistNm && d.liveGs > 10) {
            eteMin = (d.destDistNm / d.liveGs) * 60;
            this._set('ete', InstrumentStrip._formatEte(eteMin));
        } else if (d.destEteMin != null) {
            eteMin = d.destEteMin;
            this._set('ete', InstrumentStrip._formatEte(eteMin));
        }

        // ETE delta vs plan
        const eteDeltaEl = this._els['ete_delta'];
        if (eteDeltaEl && eteMin != null && d.destEteMin != null) {
            const delta = eteMin - d.destEteMin;
            if (Math.abs(delta) >= 1) {
                const sign = delta > 0 ? '+' : '';
                eteDeltaEl.textContent = sign + InstrumentStrip._formatEte(Math.abs(delta));
                eteDeltaEl.className = 'is-delta ' + (delta > 5 ? 'is-delta-red' : delta > 2 ? 'is-delta-amber' : 'is-delta-green');
            } else {
                eteDeltaEl.textContent = '';
            }
        }

        // DEST delta (show how much dist remains vs nothing — just clear for now)
        const destDeltaEl = this._els['dest_delta'];
        if (destDeltaEl) destDeltaEl.textContent = '';

        // FUEL delta — actual vs planned burn rate
        const fuelDeltaEl = this._els['fuel_delta'];
        if (fuelDeltaEl && d.liveGph != null && d.plannedGph != null) {
            const delta = d.liveGph - d.plannedGph;
            if (Math.abs(delta) >= 0.3) {
                const sign = delta > 0 ? '+' : '';
                fuelDeltaEl.textContent = `${sign}${delta.toFixed(1)}`;
                fuelDeltaEl.className = 'is-delta ' + (delta > 0.5 ? 'is-delta-red' : delta > 0.2 ? 'is-delta-amber' : 'is-delta-green');
            } else {
                fuelDeltaEl.textContent = '';
            }
        }
    }

    _updateFuel() {
        // 1. Live EDM data from engine monitor (most current — during flight)
        const engData = window.enginePanel?.lastData;
        const remaining = engData?.fuel_remaining_gal ?? engData?.fuel_gal ?? engData?.Gallons_Rem ?? engData?.Fuel_Remaining ?? null;
        if (remaining != null && remaining > 0) {
            this._set('fuel', remaining.toFixed(1));
            return;
        }
        // 2. Manual override (pilot explicitly set a value via fuel overlay SET button)
        const manual = typeof Settings !== 'undefined' ? (Settings.fuelManualOverride || 0) : 0;
        if (manual > 0) {
            this._set('fuel', manual.toFixed(1));
            return;
        }
        // 3. Last known from completed flight CSV — more recent than a pre-flight tic measurement
        const stored = parseFloat(localStorage.getItem('flypi_last_known_fuel') || '0');
        if (stored > 0) {
            this._set('fuel', stored.toFixed(1));
            return;
        }
        // 4. FuelState tic/capacity fallback
        if (typeof FuelState !== 'undefined') {
            const fs = FuelState.getStartFuel();
            if (fs && fs.gallons > 0) {
                this._set('fuel', fs.gallons.toFixed(1));
            }
        }
    }

    _updateRoute(sit) {
        const wps = ActiveRoute.getWaypoints();
        if (!wps.length) return;

        const gs = sit.ground_speed || 0;
        const idx = ActiveRoute.getIndex();

        // Auto-advance: delegate to ActiveRoute so RouteTable stays in sync
        const next = wps[idx];
        if (next && next.lat != null) {
            const distToNext = CockpitMap._distNm(sit.lat, sit.lon, next.lat, next.lon);
            if (distToNext < 1.0) ActiveRoute.advance();
        }

        // Total remaining distance: ownship → active WP → ... → dest
        // Only count up to the destination airport, not MAP fixes beyond it.
        const destIdx = ActiveRoute.getDestIndex();
        const limitIdx = destIdx >= 0 ? destIdx : wps.length - 1;
        let totalDist = 0;
        const activeIdx = ActiveRoute.getIndex(); // re-read in case advance() fired
        if (activeIdx <= limitIdx && wps[activeIdx]?.lat != null) {
            totalDist += CockpitMap._distNm(sit.lat, sit.lon, wps[activeIdx].lat, wps[activeIdx].lon);
            for (let i = activeIdx; i < limitIdx; i++) {
                if (wps[i].lat != null && wps[i + 1]?.lat != null) {
                    totalDist += CockpitMap._distNm(wps[i].lat, wps[i].lon, wps[i + 1].lat, wps[i + 1].lon);
                }
            }
        }

        this._set('dist', totalDist.toFixed(0));
        if (gs > 10 && totalDist > 0) {
            this._set('ete', InstrumentStrip._formatEte(totalDist / gs * 60));
        } else {
            this._set('ete', '—');
        }
    }

    static _formatEte(minutes) {
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
    }

    _set(field, value) {
        const el = this._els[field];
        if (el) el.textContent = value;
    }
}
