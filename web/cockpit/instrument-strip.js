/**
 * FlyPi v5 — Instrument Strip
 * Bottom bar showing numeric flight instruments: GS, ALT, VS, FUEL, Dist, ETE.
 * Config-driven field list via cockpit-config.json instrumentStrip.fields.
 */

class InstrumentStrip {
    constructor(stratuxClient, engineClient) {
        this._stratux = stratuxClient;
        this._engine = engineClient || null;
        this._el = null;
        this._activePlan = null;
        this._activeWpIndex = 0;
        this._onSituation = null;

        // Default fields if no config
        this._fields = ['gs', 'alt', 'vs', 'fuel', 'dist', 'ete'];
        this._fuelOverlay = null;
    }

    /** Wire the fuel field tap to open the fuel overlay. */
    setFuelOverlay(overlay) {
        this._fuelOverlay = overlay;
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
                this._set('vs', '—');
                this._set('dist', '—');
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
    }

    setActivePlan(plan) {
        this._activePlan = plan;
        this._activeWpIndex = 0;
    }

    _makeField(field) {
        const div = document.createElement('div');
        div.className = 'is-field';
        div.dataset.field = field;

        const configs = {
            gs:   { label: 'GS',   unit: 'kt'  },
            alt:  { label: 'ALT',  unit: 'ft'  },
            vs:   { label: 'VS',   unit: 'fpm' },
            fuel: { label: 'FUEL', unit: 'gal' },
            dist: { label: 'DIST', unit: 'nm'  },
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

        div.appendChild(labelEl);
        div.appendChild(valueEl);
        div.appendChild(unitEl);

        // Cache reference for fast updates — no getElementById needed
        this._els[field] = valueEl;

        // FUEL field is a tap target that opens the fuel entry overlay
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

        return div;
    }

    _update(sit) {
        if (!sit) return;

        const gpsOk = sit.gps_fix_quality > 0;
        const gs = gpsOk ? sit.ground_speed : null;
        const alt = gpsOk ? (sit.alt_msl || sit.alt_baro) : null;
        const vs = gpsOk ? sit.vertical_speed : null;

        this._set('gs', gs != null ? Math.round(gs) : '—');
        this._set('alt', alt != null ? Math.round(alt).toLocaleString() : '—');
        this._set('vs', vs != null ? (vs > 0 ? '+' : '') + Math.round(vs) : '—');

        this._updateFuel();

        // Route distances
        if (this._activePlan && sit.lat && sit.lon && gpsOk) {
            this._updateRoute(sit);
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
        const wps = this._activePlan?.waypoints;
        if (!wps || wps.length === 0) return;

        const gs = sit.ground_speed || 0;

        // Auto-advance waypoint
        const next = wps[this._activeWpIndex];
        if (next && next.lat != null) {
            const distToNext = CockpitMap._distNm(sit.lat, sit.lon, next.lat, next.lon);
            if (distToNext < 1.0 && this._activeWpIndex < wps.length - 1) {
                this._activeWpIndex++;
            }
        }

        // Total remaining distance (ownship → next → ... → dest)
        let totalDist = 0;
        if (this._activeWpIndex < wps.length && wps[this._activeWpIndex].lat != null) {
            totalDist += CockpitMap._distNm(
                sit.lat, sit.lon,
                wps[this._activeWpIndex].lat, wps[this._activeWpIndex].lon
            );
            for (let i = this._activeWpIndex; i < wps.length - 1; i++) {
                if (wps[i].lat != null && wps[i + 1].lat != null) {
                    totalDist += CockpitMap._distNm(
                        wps[i].lat, wps[i].lon,
                        wps[i + 1].lat, wps[i + 1].lon
                    );
                }
            }
        }

        this._set('dist', totalDist.toFixed(0));

        if (gs > 10 && totalDist > 0) {
            const eteMin = totalDist / gs * 60;
            this._set('ete', NavStrip._formatEte(eteMin));
        } else {
            this._set('ete', '—');
        }
    }

    _set(field, value) {
        const el = this._els[field];
        if (el) el.textContent = value;
    }
}
