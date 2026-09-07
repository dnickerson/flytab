/**
 * FlyTab — Fuel Overlay
 * Full-screen overlay for tic mark entry, EDM comparison, and fuel source management.
 * Same pattern as EnginePage: show/hide with buildDOM, reads from FuelEngine + FuelState.
 */

class FuelOverlay {
    constructor(container) {
        this._container = container;
        this._el = null;
        this._visible = false;
        this._dom = {};
        this._leftTic = 0;
        this._rightTic = 0;
        this._maxTic = 17;
        this._ticStep = 0.5;
        this._coefficients = FuelEngine.DEFAULT_COEFFICIENTS;
        this._cachedCsvEdmFuel = 0;
        this._shownAt = 0;
        this._applying = false;
        // Re-entrancy guard for _recordFuelStop(), same rationale as _applying above:
        // the Pi sync it awaits (_syncFuelAddToEngine, up to 4000ms) is a real network
        // round trip, so a second RECORD tap before the first settles must be refused
        // rather than racing past the guard-clearing side effects that only run after
        // the await — otherwise a double tap can duplicate a fuel-stop entry and
        // double-add gallons to the Pi's authoritative fuel total.
        this._recording = false;
        // True once the pilot has moved a slider, typed in a tic field or tapped a
        // ± button since the current show(). show() restores the PREVIOUS
        // measurement into the tic fields, so a fuel stop recorded without touching
        // them would write the departure figure back as if it had just been measured.
        this._ticsTouchedSinceShow = false;
        // Which door the overlay was opened from. show() takes no argument from the
        // preflight call sites (MORE → Fuel Entry in tab-bar.js, the instrument-strip
        // fuel readout), where re-applying a restored reading is a legitimate
        // re-confirmation and must keep working. app.js's in-flight fuel-stop overlay
        // opens it with show({ requireFreshTics: true }): there the restored reading is
        // the DEPARTURE reading, and BOTH write paths into canonical FuelTankState —
        // _applyMeasurement() and _recordFuelStop() — must refuse it.
        this._requireFreshTics = false;
        // True when the last attempt to sync a dropped-burn correction to the Pi
        // failed (Pi unreachable, or a non-2xx response) — set/cleared only by
        // _syncDroppedBurnToPi(). Drives _refreshDroppedBurnRow() to keep the row
        // visible with a RETRY affordance even after the local correction already
        // landed, so a failed Pi sync isn't a dead end (see PR #143 review).
        this._piSyncFailed = false;
        // Mirrors _piSyncFailed but for the RECORD FUEL STOP path — set when
        // _syncFuelAddToEngine() fails after a fuel stop has already been recorded
        // locally (flytab_fuel_stops + FuelTankState). _lastFuelStopPending holds the
        // exact {gallons, airport, price} that failed to reach the Pi, so the RECORD
        // FUEL STOP button can dual-purpose as a Pi-only retry (same pattern as
        // _piSyncFailed / _retryPiDroppedBurnSync(), PR #143) instead of forcing the
        // pilot to re-enter a fresh tic reading — which would append a SECOND
        // flytab_fuel_stops entry and, since the Pi's fuel total is additive, could
        // double-add gallons if the original POST actually landed despite the
        // client-side failure (Finding 1, 2026-09 whole-branch audit). Only the most
        // recently failed fuel stop is tracked; if a second, distinct stop is recorded
        // successfully before an earlier failure is retried, the earlier failure's
        // tracking is intentionally superseded (single-slot, not a queue) — matches
        // the scope of the audit finding.
        this._fuelStopPiSyncFailed = false;
        this._lastFuelStopPending = null;
        this._buildDOM();
    }

    /* ------------------------------------------------------------------
     * DOM
     * ----------------------------------------------------------------*/
    _buildDOM() {
        // Load config
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const tp = CockpitConfig.get('tic_polynomial')
                    || CockpitConfig.aircraft('tic_polynomial');
                if (tp) {
                    this._maxTic = tp.max_tic || 17;
                    if (tp.coefficients) this._coefficients = tp.coefficients;
                }
            }
        } catch (_) { /* use defaults */ }

        this._el = document.createElement('div');
        this._el.className = 'fuel-overlay';
        this._el.style.display = 'none';

        this._el.innerHTML = /* html */`
        <div class="fo-container">
            <div class="fo-header">
                <div class="fo-title">FUEL MEASUREMENT</div>
                <button class="btn-close ep-close fo-close" id="fo-close">✕</button>
            </div>

            <!-- A) TIC MARK INPUT -->
            <div class="fo-section-title">TIC MARK INPUT</div>
            <div class="fo-tic-row">
                <div class="fo-tank">
                    <div class="fo-tank-label">LEFT TANK</div>
                    <input type="range" class="fo-slider" id="fo-left-slider"
                           min="0" max="${this._maxTic}" step="${this._ticStep}" value="0">
                    <div class="fo-fine-row">
                        <button class="fo-fine-btn" id="fo-left-minus">\u2212</button>
                        <input type="number" class="fo-tic-input" id="fo-left-input"
                               min="0" max="${this._maxTic}" step="${this._ticStep}" value="0">
                        <button class="fo-fine-btn" id="fo-left-plus">+</button>
                    </div>
                    <div class="fo-gal-display" id="fo-left-gal">0.0 gal</div>
                </div>
                <div class="fo-tank">
                    <div class="fo-tank-label">RIGHT TANK</div>
                    <input type="range" class="fo-slider" id="fo-right-slider"
                           min="0" max="${this._maxTic}" step="${this._ticStep}" value="0">
                    <div class="fo-fine-row">
                        <button class="fo-fine-btn" id="fo-right-minus">\u2212</button>
                        <input type="number" class="fo-tic-input" id="fo-right-input"
                               min="0" max="${this._maxTic}" step="${this._ticStep}" value="0">
                        <button class="fo-fine-btn" id="fo-right-plus">+</button>
                    </div>
                    <div class="fo-gal-display" id="fo-right-gal">0.0 gal</div>
                </div>
            </div>
            <div class="fo-total-row">
                TOTAL: <span id="fo-total-gal" class="fo-total-val">0.0</span> gal
            </div>
            <div class="fo-dropped-burn-row" id="fo-dropped-burn-row" style="display:none;">
                <div>Possible under-tracked burn during a comms gap: <span id="fo-dropped-burn-val">0.0</span> gal</div>
                <div class="fo-manual-row">
                    <input type="number" class="fo-manual-input" id="fo-dropped-burn-input"
                           min="0" max="${this._droppedBurnMaxGal()}" step="0.1" value="0"
                           aria-label="Correction amount, gallons">
                    <button class="fo-manual-btn fo-set-btn" id="fo-dropped-burn-apply">APPLY CORRECTION</button>
                </div>
                <div class="fo-add-status" id="fo-dropped-burn-status"></div>
            </div>

            <!-- B) EDM COMPARISON -->
            <div class="fo-edm-section" id="fo-edm-section" style="display:none;">
                <div class="fo-section-title">EDM COMPARISON</div>
                <div class="fo-edm-row">
                    <div class="fo-edm-item">
                        <div class="fo-edm-label">TIC</div>
                        <div class="fo-edm-val" id="fo-edm-tic">--</div>
                    </div>
                    <div class="fo-edm-item">
                        <div class="fo-edm-label">EDM</div>
                        <div class="fo-edm-val" id="fo-edm-edm">--</div>
                    </div>
                    <div class="fo-edm-item">
                        <div class="fo-edm-label">VARIANCE</div>
                        <div class="fo-edm-val" id="fo-edm-var">--</div>
                    </div>
                    <div class="fo-edm-item">
                        <div class="fo-edm-label">ACCURACY</div>
                        <div class="fo-edm-badge" id="fo-edm-grade">--</div>
                    </div>
                </div>
            </div>

            <!-- C) ACTIVE FUEL SOURCE -->
            <div class="fo-section-title">ACTIVE FUEL SOURCE</div>
            <div class="fo-source-chain" id="fo-source-chain">
                <span class="fo-source-chip" data-src="manual">MANUAL</span>
                <span class="fo-source-sep">\u203A</span>
                <span class="fo-source-chip" data-src="edm">EDM</span>
                <span class="fo-source-sep">\u203A</span>
                <span class="fo-source-chip" data-src="tic">TIC</span>
                <span class="fo-source-sep">\u203A</span>
                <span class="fo-source-chip" data-src="capacity">CAPACITY</span>
            </div>
            <div class="fo-source-display" id="fo-source-display">-- gal (--)</div>
            <div class="fo-manual-row">
                <input type="number" class="fo-manual-input" id="fo-manual-input"
                       placeholder="Manual gal" min="0" max="200" step="0.1">
                <button class="fo-manual-btn fo-set-btn" id="fo-manual-set">SET</button>
                <button class="fo-manual-btn fo-clear-btn" id="fo-manual-clear">CLEAR</button>
            </div>

            <!-- D) APPLY -->
            <button class="fo-apply-btn" id="fo-apply">APPLY TIC MEASUREMENT</button>
            <!-- Reuses .fo-add-status styling (hidden while empty) so a refused APPLY
                 explains itself instead of silently doing nothing. -->
            <div class="fo-add-status" id="fo-apply-status"></div>

            <!-- E) FUEL ADDED -->
            <div class="fo-section-title">FUEL ADDED</div>
            <div class="fo-add-fields">
                <div class="fo-add-row">
                    <input type="text" class="fo-add-input fo-add-airport" id="fo-add-airport"
                           placeholder="Airport (e.g. KPAO)" maxlength="10" autocomplete="off"
                           autocorrect="off" autocapitalize="characters" spellcheck="false">
                    <input type="date" class="fo-add-input" id="fo-add-date">
                    <input type="time" class="fo-add-input" id="fo-add-time">
                </div>
                <div class="fo-add-row">
                    <input type="number" class="fo-add-input" id="fo-add-gal"
                           placeholder="Total gal added" min="0" max="100" step="0.1">
                    <input type="number" class="fo-add-input" id="fo-add-price"
                           placeholder="$/gal (optional)" min="0" max="20" step="0.01">
                </div>
                <div class="fo-add-row">
                    <input type="number" class="fo-add-input" id="fo-add-gal-l"
                           placeholder="L tank gal (optional)" min="0" max="100" step="0.1">
                    <input type="number" class="fo-add-input" id="fo-add-gal-r"
                           placeholder="R tank gal (optional)" min="0" max="100" step="0.1">
                </div>
                <button class="fo-apply-btn fo-add-record-btn" id="fo-add-record">RECORD FUEL STOP</button>
                <div class="fo-add-status" id="fo-add-status"></div>
            </div>

            <!-- F) MEASUREMENT HISTORY -->
            <div class="fo-section-title">MEASUREMENT HISTORY</div>
            <div class="fo-hist-wrapper">
                <table class="fo-hist-table">
                    <thead>
                        <tr>
                            <th>DATE / TIME</th>
                            <th>TIC (gal)</th>
                            <th>EDM (gal)</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody id="fo-hist-body"></tbody>
                </table>
            </div>

            <!-- G) K-FACTOR CALCULATOR -->
            <div class="fo-section-title">K-FACTOR CALCULATOR</div>
            <div class="fo-kfactor-panel" id="fo-kfactor-panel">
                <div class="fo-kfactor-row">
                    <div class="fo-kfactor-item">
                        <div class="fo-kfactor-label">FUEL FILLED (actual)</div>
                        <div class="fo-kfactor-val" id="fo-kf-filled">-- gal</div>
                    </div>
                    <div class="fo-kfactor-item">
                        <div class="fo-kfactor-label">FUEL USED (EDM)</div>
                        <div class="fo-kfactor-val" id="fo-kf-used">-- gal</div>
                    </div>
                    <div class="fo-kfactor-item">
                        <div class="fo-kfactor-label">K-FACTOR RATIO</div>
                        <div class="fo-kfactor-val fo-kfactor-ratio" id="fo-kf-ratio">--</div>
                    </div>
                </div>
                <div class="fo-kfactor-guidance" id="fo-kf-guidance"></div>
                <div class="fo-kfactor-note">
                    Ratio = Filled ÷ Used (EDM). Multiply by current K-factor to correct fuel flow accuracy.
                </div>
            </div>

            <!-- H) PI K-FACTOR (LIVE) -->
            <div id="fo-kfactor-pi" style="display:none;">
                <div class="fo-section-title">PI K-FACTOR (LIVE)</div>
                <div class="fo-kfactor-panel">
                    <div class="fo-kfactor-row">
                        <div class="fo-kfactor-item">
                            <div class="fo-kfactor-label">CURRENT (PI)</div>
                            <div class="fo-kfactor-val" id="fo-kf-pi-current">--</div>
                        </div>
                        <div class="fo-kfactor-item">
                            <div class="fo-kfactor-label">SUGGESTED (PI)</div>
                            <div class="fo-kfactor-val" id="fo-kf-pi-suggested">--</div>
                        </div>
                    </div>
                    <div class="fo-kfactor-guidance" id="fo-kf-pi-recommendation"></div>
                    <button class="fo-manual-btn fo-set-btn" id="fo-kf-pi-apply" style="display:none;">APPLY TO PI</button>
                    <div class="fo-add-status" id="fo-kf-pi-status"></div>
                </div>
            </div>
        </div>`;

        this._container.appendChild(this._el);

        // Cache DOM refs
        this._dom = {
            leftSlider: this._el.querySelector('#fo-left-slider'),
            leftInput: this._el.querySelector('#fo-left-input'),
            leftGal: this._el.querySelector('#fo-left-gal'),
            rightSlider: this._el.querySelector('#fo-right-slider'),
            rightInput: this._el.querySelector('#fo-right-input'),
            rightGal: this._el.querySelector('#fo-right-gal'),
            totalGal: this._el.querySelector('#fo-total-gal'),
            droppedBurnRow: this._el.querySelector('#fo-dropped-burn-row'),
            droppedBurnVal: this._el.querySelector('#fo-dropped-burn-val'),
            droppedBurnInput: this._el.querySelector('#fo-dropped-burn-input'),
            droppedBurnApply: this._el.querySelector('#fo-dropped-burn-apply'),
            droppedBurnStatus: this._el.querySelector('#fo-dropped-burn-status'),
            edmSection: this._el.querySelector('#fo-edm-section'),
            edmTic: this._el.querySelector('#fo-edm-tic'),
            edmEdm: this._el.querySelector('#fo-edm-edm'),
            edmVar: this._el.querySelector('#fo-edm-var'),
            edmGrade: this._el.querySelector('#fo-edm-grade'),
            sourceChain: this._el.querySelector('#fo-source-chain'),
            sourceDisplay: this._el.querySelector('#fo-source-display'),
            manualInput: this._el.querySelector('#fo-manual-input'),
            // Fuel-add section
            addAirport: this._el.querySelector('#fo-add-airport'),
            addDate: this._el.querySelector('#fo-add-date'),
            addTime: this._el.querySelector('#fo-add-time'),
            addGal: this._el.querySelector('#fo-add-gal'),
            addGalL: this._el.querySelector('#fo-add-gal-l'),
            addGalR: this._el.querySelector('#fo-add-gal-r'),
            addPrice: this._el.querySelector('#fo-add-price'),
            addRecord: this._el.querySelector('#fo-add-record'),
            addStatus: this._el.querySelector('#fo-add-status'),
            applyStatus: this._el.querySelector('#fo-apply-status'),
            histBody:  this._el.querySelector('#fo-hist-body'),
            kfFilled:  this._el.querySelector('#fo-kf-filled'),
            kfUsed:    this._el.querySelector('#fo-kf-used'),
            kfRatio:   this._el.querySelector('#fo-kf-ratio'),
            kfGuidance: this._el.querySelector('#fo-kf-guidance'),
            kfPiSection: this._el.querySelector('#fo-kfactor-pi'),
            kfPiCurrent: this._el.querySelector('#fo-kf-pi-current'),
            kfPiSuggested: this._el.querySelector('#fo-kf-pi-suggested'),
            kfPiRecommendation: this._el.querySelector('#fo-kf-pi-recommendation'),
            kfPiApply: this._el.querySelector('#fo-kf-pi-apply'),
            kfPiStatus: this._el.querySelector('#fo-kf-pi-status'),
        };

        // Wire close
        wireTap(this._el.querySelector('#fo-close'), () => this.hide());

        // Wire left tank controls
        // Every one of these fires only on real pilot interaction, so each marks the
        // reading as entered during THIS session (see _ticsTouchedSinceShow). The ±
        // buttons mark even when the value is clamped or lands back where it started —
        // that is what lets a pilot confirm a reading that legitimately equals the
        // restored one.
        this._dom.leftSlider.addEventListener('input', (e) => {
            this._ticsTouchedSinceShow = true;
            this._leftTic = parseFloat(e.target.value);
            this._dom.leftInput.value = this._leftTic;
            this._updateDisplay();
        });
        this._dom.leftInput.addEventListener('input', (e) => {
            this._ticsTouchedSinceShow = true;
            const raw = parseFloat(e.target.value) || 0;
            this._leftTic = Math.min(this._maxTic, Math.max(0, Math.round(raw / this._ticStep) * this._ticStep));
            this._dom.leftSlider.value = this._leftTic;
            this._updateDisplay();
        });
        wireTap(this._el.querySelector('#fo-left-minus'), () => {
            this._ticsTouchedSinceShow = true;
            this._leftTic = Math.max(0, Math.round((this._leftTic - this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.leftSlider.value = this._leftTic;
            this._dom.leftInput.value = this._leftTic;
            this._updateDisplay();
        });
        wireTap(this._el.querySelector('#fo-left-plus'), () => {
            this._ticsTouchedSinceShow = true;
            this._leftTic = Math.min(this._maxTic, Math.round((this._leftTic + this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.leftSlider.value = this._leftTic;
            this._dom.leftInput.value = this._leftTic;
            this._updateDisplay();
        });

        // Wire right tank controls (same _ticsTouchedSinceShow contract as the left)
        this._dom.rightSlider.addEventListener('input', (e) => {
            this._ticsTouchedSinceShow = true;
            this._rightTic = parseFloat(e.target.value);
            this._dom.rightInput.value = this._rightTic;
            this._updateDisplay();
        });
        this._dom.rightInput.addEventListener('input', (e) => {
            this._ticsTouchedSinceShow = true;
            const raw = parseFloat(e.target.value) || 0;
            this._rightTic = Math.min(this._maxTic, Math.max(0, Math.round(raw / this._ticStep) * this._ticStep));
            this._dom.rightSlider.value = this._rightTic;
            this._updateDisplay();
        });
        wireTap(this._el.querySelector('#fo-right-minus'), () => {
            this._ticsTouchedSinceShow = true;
            this._rightTic = Math.max(0, Math.round((this._rightTic - this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.rightSlider.value = this._rightTic;
            this._dom.rightInput.value = this._rightTic;
            this._updateDisplay();
        });
        wireTap(this._el.querySelector('#fo-right-plus'), () => {
            this._ticsTouchedSinceShow = true;
            this._rightTic = Math.min(this._maxTic, Math.round((this._rightTic + this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.rightSlider.value = this._rightTic;
            this._dom.rightInput.value = this._rightTic;
            this._updateDisplay();
        });

        // Wire manual override
        wireTap(this._el.querySelector('#fo-manual-set'), () => {
            const val = parseFloat(this._dom.manualInput.value);
            if (val > 0) {
                FuelState.setManualOverride(val);
                this._updateSourceDisplay();
                window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            }
        });
        wireTap(this._el.querySelector('#fo-manual-clear'), () => {
            FuelState.clearManualOverride();
            this._dom.manualInput.value = '';
            this._updateSourceDisplay();
            window.dispatchEvent(new CustomEvent('fuelstate:changed'));
        });

        // Wire dropped-burn correction. When only a Pi sync is outstanding (local
        // side already applied but the Pi never got it), the button retries just
        // the Pi sync instead of re-touching FuelTankState — see _refreshDroppedBurnRow().
        wireTap(this._el.querySelector('#fo-dropped-burn-apply'), () => {
            if (this._piSyncFailed && !(FuelTankState.getState()?.dropped_burn_estimate_gal > 0.05)) {
                this._retryPiDroppedBurnSync();
            } else {
                this._applyDroppedBurnCorrection();
            }
        });

        // Wire apply
        wireTap(this._el.querySelector('#fo-apply'), () => {
            this._applyMeasurement();
        });

        // Wire fuel-add record button. Dual-purpose, same pattern as the dropped-burn
        // APPLY/RETRY button: when the last fuel stop's Pi sync failed and the pilot
        // has not entered a new gallons figure (addGal is empty — it's cleared after
        // every record attempt, success or failure), this tap retries ONLY the Pi
        // sync for the pending stop rather than recording a new one.
        wireTap(this._el.querySelector('#fo-add-record'), () => {
            const newGalEntered = parseFloat(this._dom.addGal.value) > 0;
            if (this._fuelStopPiSyncFailed && this._lastFuelStopPending && !newGalEntered) {
                this._retryFuelStopPiSync();
            } else {
                this._recordFuelStop();
            }
        });

        // Wire Pi K-factor apply button
        wireTap(this._el.querySelector('#fo-kf-pi-apply'), () => {
            this._applyPiKFactor();
        });
    }

    /* ------------------------------------------------------------------
     * Show / Hide
     * ----------------------------------------------------------------*/
    /**
     * @param {object}  [opts]
     * @param {boolean} [opts.requireFreshTics=false]
     *        Set by the in-flight fuel-stop path only (app.js _showFuelStopOverlay's
     *        "Measure & Record Fuel" button). When set, APPLY as well as RECORD refuse
     *        to write canonical FuelTankState from a reading the pilot did not enter or
     *        confirm during this session. Left unset by the preflight call sites
     *        (tab-bar.js MORE → Fuel Entry, instrument-strip.js), where re-applying the
     *        restored reading is the intended way to re-confirm it.
     */
    show(opts = {}) {
        // A restored reading is NOT a reading taken now. Recording a fuel stop needs a
        // measurement the pilot entered or confirmed during this session, so every
        // show() starts untouched — including the show() the fuel-stop overlay's
        // "Measure & Record Fuel" button triggers (app.js _showFuelStopOverlay).
        this._ticsTouchedSinceShow = false;
        this._requireFreshTics = !!(opts && opts.requireFreshTics);

        // Restore previous tic values
        const prev = Settings.fuelMeasurement;
        if (prev) {
            this._leftTic = prev.left_tic ?? 0;
            this._rightTic = prev.right_tic ?? 0;
        }
        this._dom.leftSlider.value = this._leftTic;
        this._dom.leftInput.value = this._leftTic;
        this._dom.rightSlider.value = this._rightTic;
        this._dom.rightInput.value = this._rightTic;

        // Restore manual override display
        const manual = Settings.fuelManualOverride;
        if (manual != null && manual > 0) {
            this._dom.manualInput.value = manual;
        }

        this._refreshDroppedBurnRow();

        // Auto-fill fuel-add date/time with current local time
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        this._dom.addDate.value =
            `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        this._dom.addTime.value =
            `${pad(now.getHours())}:${pad(now.getMinutes())}`;

        // Auto-fill airport from active plan destination (if available)
        if (!this._dom.addAirport.value) {
            try {
                const plan = window.app?.activePlan || window.app?.flightPlan;
                if (plan?.waypoints?.length) {
                    const dest = plan.waypoints[plan.waypoints.length - 1];
                    this._dom.addAirport.value = (dest.icao || dest.name || '').toUpperCase();
                }
            } catch (_) { /* no plan */ }
        }

        // Clear previous status
        this._dom.addStatus.textContent = '';
        if (this._dom.applyStatus) this._dom.applyStatus.textContent = '';

        // Unlike _ticsTouchedSinceShow, a pending failed fuel-stop Pi sync is NOT a
        // per-session thing — closing and reopening the overlay doesn't make the Pi's
        // fuel total any less wrong, so this persists across show()/hide() (mirrors
        // _piSyncFailed) and is re-surfaced here rather than reset.
        this._refreshFuelStopButton();
        if (this._fuelStopPiSyncFailed && this._lastFuelStopPending) {
            const { gallons, airport, reason } = this._lastFuelStopPending;
            this._setAddStatus(
                `Pi still doesn't have the +${gallons.toFixed(1)} gal fuel stop at ${airport || '—'} ` +
                `(${reason}). No new reading needed — tap RECORD FUEL STOP to retry sending it to the Pi.`,
                'error');
        }

        this._updateDisplay();
        this._updateSourceDisplay();
        this._renderHistory();
        this._renderKFactor();
        this._fetchPiCalibration();
        this._cachedCsvEdmFuel = 0;
        this._el.style.display = 'flex';
        this._visible = true;
        this._shownAt = Date.now();

        // Pre-fetch last flight CSV EDM value for comparison display
        this._resolveEdmFuel().then(val => {
            if (val > 0) {
                this._cachedCsvEdmFuel = val;
                this._updateDisplay();
            }
        });
    }

    hide() {
        this._el.style.display = 'none';
        this._visible = false;
    }

    get visible() { return this._visible; }

    /* ------------------------------------------------------------------
     * Display updates
     * ----------------------------------------------------------------*/
    _updateDisplay() {
        const leftGal = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
        const rightGal = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
        const total = leftGal + rightGal;
        const cap = (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;

        this._dom.leftGal.textContent = leftGal.toFixed(1) + ' gal';
        this._dom.leftGal.classList.toggle('fo-gal-implausible', leftGal > cap);
        this._dom.rightGal.textContent = rightGal.toFixed(1) + ' gal';
        this._dom.rightGal.classList.toggle('fo-gal-implausible', rightGal > cap);
        this._dom.totalGal.textContent = total.toFixed(1);

        // EDM comparison
        this._updateEdmComparison(total);
    }

    /**
     * Surface any dropped-burn estimate from FuelTankState (comms-gap tracking) and
     * pre-fill the correction input with it. Called on show() and again after
     * _applyDroppedBurnCorrection() so the row reflects what's actually left to
     * reconcile rather than the value it had when the overlay was opened.
     */
    _refreshDroppedBurnRow() {
        try {
            const tankState = (typeof FuelTankState !== 'undefined') ? FuelTankState.getState() : null;
            const dropped = tankState?.dropped_burn_estimate_gal ?? 0;
            const localPending = dropped > 0.05;

            if (localPending) {
                this._dom.droppedBurnVal.textContent = dropped.toFixed(2);
                this._dom.droppedBurnRow.style.display = '';
                this._dom.droppedBurnInput.disabled = false;
                // Don't clobber a value the pilot is actively editing.
                if (document.activeElement !== this._dom.droppedBurnInput) {
                    this._dom.droppedBurnInput.value = dropped.toFixed(1);
                }
                this._dom.droppedBurnApply.textContent = 'APPLY CORRECTION';
            } else if (this._piSyncFailed) {
                // Nothing left to apply locally, but the Pi never got its own
                // correction — keep the row up as a retry affordance rather than
                // silently dropping the pilot's confirmed correction (PR #143 review).
                this._dom.droppedBurnVal.textContent = '0.0';
                this._dom.droppedBurnRow.style.display = '';
                this._dom.droppedBurnInput.value = '0.0';
                this._dom.droppedBurnInput.disabled = true;
                this._dom.droppedBurnApply.textContent = 'RETRY PI SYNC';
            } else {
                this._dom.droppedBurnRow.style.display = 'none';
            }
        } catch (_) { /* FuelTankState unavailable */ }
    }

    _updateEdmComparison(ticTotal) {
        let edmFuel = 0;
        let isStale = false;
        try {
            const panel = window.enginePanel;
            // Freshness only controls the "(LAST)" label here — unlike _resolveEdmFuel()
            // (a one-shot resolution used when confirming a fuel-state entry, which must
            // stay strict), this is a passive preview and a momentarily-stale or
            // post-disconnect panel reading is still better than substituting a CSV
            // value from a different, earlier flight. Only fall through to the CSV
            // cache when the panel has never reported anything this session.
            const panelFresh = panel?.lastPollTime &&
                (Date.now() - panel.lastPollTime) < FuelState.EDM_FRESHNESS_MS;
            if (panel?.lastData) {
                edmFuel = FuelEngine.extractEdmFuel(panel.lastData);
                isStale = !panelFresh;
            }
            // Fallback: cached value from last flight CSV (loaded on show()) — only
            // when the panel has no reading at all.
            if (!edmFuel && this._cachedCsvEdmFuel > 0) {
                edmFuel = this._cachedCsvEdmFuel;
                isStale = true;
            }
        } catch (_) { /* no engine data */ }

        if (edmFuel > 0) {
            this._dom.edmSection.style.display = '';
            const m = FuelEngine.createMeasurement(
                this._leftTic, this._rightTic, this._coefficients, edmFuel
            );
            this._dom.edmTic.textContent = m.total_gal.toFixed(1) + ' gal';
            this._dom.edmEdm.textContent = edmFuel.toFixed(1) + (isStale ? ' (LAST)' : '') + ' gal';
            this._dom.edmVar.textContent = (m.variance_gal > 0 ? '+' : '') + m.variance_gal.toFixed(1) + ' gal';

            const grade = m.accuracy || 'check';
            this._dom.edmGrade.textContent = grade.toUpperCase();
            this._dom.edmGrade.className = 'fo-edm-badge fo-grade-' + grade;
        } else {
            this._dom.edmSection.style.display = 'none';
        }
    }

    _updateSourceDisplay() {
        const { gallons, source } = FuelState.getStartFuel();
        this._dom.sourceDisplay.textContent =
            `${gallons.toFixed(1)} gal (${source.toUpperCase()})`;

        // Highlight active chip in priority chain
        const chips = this._dom.sourceChain.querySelectorAll('.fo-source-chip');
        chips.forEach(chip => {
            chip.classList.toggle('fo-source-active', chip.dataset.src === source);
        });
    }

    /**
     * Returns an error message if either tank's CURRENT tic-derived gallons
     * exceeds capacity, else null. A single shared check so _applyMeasurement()
     * and _recordFuelStop() can't drift apart, and so it can be re-run at write
     * time (not just at tap time) — see _applyMeasurement()'s re-check comment.
     */
    _ticCapacityError() {
        const leftGal = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
        const rightGal = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
        const cap = (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;
        if (leftGal > cap || rightGal > cap) {
            return `Tic reading implies ${Math.max(leftGal, rightGal).toFixed(1)} gal in one tank, more than it can hold (${cap.toFixed(0)} gal)`;
        }
        return null;
    }

    /* ------------------------------------------------------------------
     * Apply measurement
     * ----------------------------------------------------------------*/
    _applyMeasurement() {
        // Guard against tap-through: ignore if overlay just opened (< 600ms ago)
        if (Date.now() - this._shownAt < 600) return;
        // Guard against double-tap during the async EDM resolve (can take 3-5s)
        if (this._applying) return;

        // Opened from the in-flight fuel-stop overlay: APPLY writes canonical
        // FuelTankState (init() → fresh initialized_at) exactly as RECORD does, and that
        // timestamp is the only thing app.js's Continue gate checks. show() restored the
        // DEPARTURE reading into the tic fields, so tapping this button without touching
        // a control would report "Measured: <departure gallons>" over tanks that have
        // since burned down — the same defect as the record path, on the larger button.
        // Refuse here, before the async resolve and before any write, so FuelState,
        // FuelTankState and initialized_at are all left byte-identical.
        // A reading that genuinely equals the restored one is confirmed the same way as
        // for RECORD: any ± nudge or slider touch sets the flag, so a + then − round trip
        // (or − then + at max tic, where + is clamped) counts and a correct entry is
        // never made impossible.
        // Preflight (MORE → Fuel Entry, instrument strip) leaves _requireFreshTics false,
        // so re-applying a restored reading there keeps working unchanged.
        if (this._requireFreshTics && !this._ticsTouchedSinceShow) {
            this._setApplyStatus(
                'Enter this stop’s tic-mark reading above (nudge ± to confirm an unchanged value) before applying',
                'error');
            return;
        }

        const capError = this._ticCapacityError();
        if (capError) {
            this._setApplyStatus(`${capError} — check the tic reading before applying`, 'error');
            return;
        }

        this._applying = true;

        // Resolve EDM fuel async, then complete measurement
        this._resolveEdmFuel().then(async edmFuel => {
            // Re-check: the pilot can edit the tic reading during the async EDM
            // resolve above (its own comment elsewhere notes this "can take
            // 3-5s"), and nothing disables the sliders meanwhile. The guard above
            // only validated the value at tap time — re-validate the CURRENT
            // value here, right before it's written, so an implausible edit made
            // mid-flight can't slip past the guard this re-check exists for
            // (2026-09 audit finding).
            const capErrorNow = this._ticCapacityError();
            if (capErrorNow) {
                this._setApplyStatus(`${capErrorNow} — check the tic reading before applying`, 'error');
                return;
            }
            const m = FuelEngine.createMeasurement(
                this._leftTic, this._rightTic, this._coefficients, edmFuel
            );
            FuelState.saveMeasurement(m);
            if (typeof FuelTankState !== 'undefined') {
                const existing = FuelTankState.getState();
                FuelTankState.init(m.left_gal, m.right_gal, existing?.active_tank ?? 'L');
                // Belt-and-suspenders: re-dispatch so the gauge widget re-renders even
                // if the synchronous dispatch inside init() was swallowed by the WebView.
                window.dispatchEvent(new CustomEvent('fueltankstate:changed'));
            }
            window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            this._updateSourceDisplay();
            this._syncMeasurement(m);
            this._renderHistory();
            // Sync authoritative tic measurement to Pi so both systems agree. Reported
            // to the pilot instead of swallowed — a failed sync here means the Pi's own
            // fuel total silently diverges from what FlyTab now shows (PR #143 audit).
            const synced = await this._syncFuelSetToEngine(m.total_gal, 'Preflight tic mark measurement');
            if (synced.ok) {
                this.hide();
            } else {
                this._setApplyStatus(synced.message, 'error');
            }
        }).catch(err => console.error('[FuelOverlay] applyMeasurement failed:', err))
          .finally(() => { this._applying = false; });
    }

    /**
     * Resolve the best available EDM fuel remaining value.
     * Priority: live engine panel → last row of most recent flight CSV.
     * Returns null if no value is available.
     */
    async _resolveEdmFuel() {
        // 1. Live engine panel (fresh within 10s)
        try {
            const panel = window.enginePanel;
            if (panel && panel.lastData && panel.lastPollTime) {
                if ((Date.now() - panel.lastPollTime) < FuelState.EDM_FRESHNESS_MS) {
                    const val = FuelEngine.extractEdmFuel(panel.lastData);
                    if (val > 0) return val;
                }
            }
        } catch (_) { /* */ }

        // 2. Last row of the most recent flight CSV from internal storage
        try {
            const listResp = await fetch('http://localhost:9090/flights/list',
                { signal: AbortSignal.timeout(3000) });
            if (!listResp.ok) return null;
            const files = await listResp.json();
            // files is [{name, size_bytes, modified_ms}, ...] sorted newest-first
            const flightFiles = files
                .map(f => (typeof f === 'string' ? f : f.name))
                .filter(name => /^\d{8}_/.test(name));
            if (!flightFiles.length) return null;

            const csvResp = await fetch(`http://localhost:9090/flights/${flightFiles[0]}`,
                { signal: AbortSignal.timeout(5000) });
            if (!csvResp.ok) return null;
            const text = await csvResp.text();

            // Find last non-empty data row (skip header)
            const lines = text.trim().split('\n');
            for (let i = lines.length - 1; i >= 1; i--) {
                const cols = lines[i].split(',');
                // Gallons Remaining is column index 9
                const gal = parseFloat(cols[9]);
                if (gal > 0) return gal;
            }
        } catch (_) { /* server unavailable or no flights */ }

        return null;
    }

    async _recordFuelStop() {
        // Re-entrancy guard, same rationale as _applyMeasurement()'s _applying latch:
        // the Pi sync below is a real await (up to 4000ms), and the guard-clearing
        // side effects (_ticsTouchedSinceShow, addGal/addPrice/addGalL/addGalR) only
        // run after it settles. Without this, a second RECORD tap before the first
        // settles would sail past every other guard and append a duplicate
        // flytab_fuel_stops entry, double-adding gallons to the Pi's authoritative total.
        if (this._recording) return;

        const gallons = parseFloat(this._dom.addGal.value);
        if (!gallons || gallons <= 0) {
            this._setAddStatus('Enter gallons added', 'error');
            return;
        }
        // Reject before any state mutation unless the pilot entered or confirmed the tic
        // reading during THIS overlay session. show() restores the previous measurement
        // into the tic fields, which after any preflight measurement — i.e. always, in
        // normal use — leaves them non-zero: a value check alone therefore cannot tell a
        // fresh reading from the departure reading, and recording would write the
        // departure gallons into FuelTankState with a fresh initialized_at, turning the
        // fuel-stop overlay's Continue gate green on a measurement that never happened.
        // A pilot whose true reading equals the restored one confirms it by nudging a ±
        // button (or the slider) — the handlers set the flag on any interaction, so a +
        // then − round trip counts, and a correct entry is never made impossible.
        if (!this._ticsTouchedSinceShow) {
            this._setAddStatus(
                'Enter this stop’s tic-mark reading above (tap + then − to confirm an unchanged value) before recording a fuel stop',
                'error');
            return;
        }
        // Second, narrower guard: the pilot did touch the controls but left both tanks at
        // 0. ticToGallons(0) evaluates to the polynomial's non-zero y-intercept (~2.24
        // gal), so checking computed gallons can't detect "no reading entered" — check the
        // raw tic inputs directly. A genuine 0/0 tic reading (both tanks at empty) is not
        // a plausible real-world fuel-stop scenario, so treating tic=0,0 as "not entered"
        // is an acceptable, intentional trade-off.
        if (this._leftTic === 0 && this._rightTic === 0) {
            this._setAddStatus('Enter a tic-mark reading above before recording a fuel stop', 'error');
            return;
        }
        const capError = this._ticCapacityError();
        if (capError) {
            this._setAddStatus(`${capError} — check the tic reading before recording`, 'error');
            return;
        }
        const airport = this._dom.addAirport.value.trim().toUpperCase();
        const date = this._dom.addDate.value;
        const time = this._dom.addTime.value;
        const priceRaw = parseFloat(this._dom.addPrice.value);
        const price = priceRaw > 0 ? priceRaw : null;

        this._recording = true;
        try {
            // Store fuel stop locally (Capacitor Filesystem in Phase 3)
            const stops = JSON.parse(localStorage.getItem('flytab_fuel_stops') || '[]');
            const record = { airport, date, time, gallons, price_per_gallon: price, saved_at: new Date().toISOString() };
            stops.push(record);
            localStorage.setItem('flytab_fuel_stops', JSON.stringify(stops));

            // Reset tracked fuel from the tic-mark reading already entered above (§A),
            // exactly like _applyMeasurement() does — a fuel stop is always grounded in
            // a fresh physical measurement, never computed from "previous + added."
            const leftGal = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
            const rightGal = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
            const existingTank = (typeof FuelTankState !== 'undefined') ? FuelTankState.getState() : null;
            if (typeof FuelTankState !== 'undefined') {
                FuelTankState.init(leftGal, rightGal, existingTank?.active_tank ?? 'L');
            }
            const m = FuelEngine.createMeasurement(this._leftTic, this._rightTic, this._coefficients);
            FuelState.saveMeasurement(m);
            const newTotal = m.total_gal;

            window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            this._updateSourceDisplay();

            // Sync fuel stop to Pi — reported instead of swallowed (see _syncFuelSetToEngine).
            const synced = await this._syncFuelAddToEngine(gallons, airport, price);

            // The reading has been consumed. A second RECORD tap must be backed by its own
            // fresh measurement, not this one — otherwise a double tap (or a second stop
            // on the same ramp) re-writes these gallons and re-stamps initialized_at.
            this._ticsTouchedSinceShow = false;

            // Clear inputs and show success
            this._dom.addGal.value = '';
            this._dom.addPrice.value = '';
            if (this._dom.addGalL) this._dom.addGalL.value = '';
            if (this._dom.addGalR) this._dom.addGalR.value = '';

            if (synced.ok) {
                // This record's own sync landed — but don't clobber tracking of a
                // DIFFERENT, still-unretried fuel stop's failure (single-slot, see
                // constructor comment): only clear if nothing else is pending.
                if (!this._lastFuelStopPending) this._fuelStopPiSyncFailed = false;
                this._setAddStatus(`Recorded: +${gallons.toFixed(1)} gal at ${airport || '—'} → ${newTotal.toFixed(1)} gal total`, 'ok');
            } else {
                // Local record already landed (flytab_fuel_stops + FuelTankState,
                // above) — track exactly this stop so RECORD FUEL STOP can retry ONLY
                // the Pi POST, never re-writing local state (Finding 1, 2026-09 audit).
                this._fuelStopPiSyncFailed = true;
                this._lastFuelStopPending = { gallons, airport, price, reason: synced.message };
                this._setAddStatus(
                    `Recorded: +${gallons.toFixed(1)} gal at ${airport || '—'} → ${newTotal.toFixed(1)} gal total. ` +
                    `Pi not yet updated (${synced.message}) No new reading needed — tap RECORD FUEL STOP again to resend this fuel stop to the Pi.`,
                    'error');
            }
            this._refreshFuelStopButton();
        } catch (err) {
            this._setAddStatus(`Save failed: ${err.message}`, 'error');
        } finally {
            this._recording = false;
        }
    }

    /** Toggle the RECORD FUEL STOP button's label between its two purposes —
     *  recording a new stop, or (when the last stop's Pi sync failed) retrying
     *  just that sync. Mirrors _refreshDroppedBurnRow()'s APPLY/RETRY toggle. */
    _refreshFuelStopButton() {
        if (!this._dom.addRecord) return;
        this._dom.addRecord.textContent =
            (this._fuelStopPiSyncFailed && this._lastFuelStopPending) ? 'RETRY PI SYNC' : 'RECORD FUEL STOP';
    }

    /**
     * Retry syncing the last-failed fuel stop to the Pi only — used when the local
     * record already landed (flytab_fuel_stops + FuelTankState) but the earlier
     * _syncFuelAddToEngine() call failed. Does NOT touch localStorage or
     * FuelTankState again: doing so would append a second flytab_fuel_stops entry,
     * and since the Pi's fuel total is additive, could double-add gallons if the
     * original POST actually landed despite the client-side failure (e.g. a slow
     * Pi that timed out at the JS side but still processed the request).
     */
    async _retryFuelStopPiSync() {
        if (!this._lastFuelStopPending || this._recording) return;
        this._recording = true;
        if (this._dom.addRecord) this._dom.addRecord.disabled = true;
        try {
            const { gallons, airport, price } = this._lastFuelStopPending;
            const synced = await this._syncFuelAddToEngine(gallons, airport, price);
            if (synced.ok) {
                this._fuelStopPiSyncFailed = false;
                this._lastFuelStopPending = null;
                this._setAddStatus(
                    `Pi sync succeeded — +${gallons.toFixed(1)} gal at ${airport || '—'} is now recorded on the Pi as well.`,
                    'ok');
            } else {
                this._lastFuelStopPending = { gallons, airport, price, reason: synced.message };
                this._setAddStatus(`Retry failed — ${synced.message} Tap RECORD FUEL STOP again to retry.`, 'error');
            }
        } finally {
            this._recording = false;
            if (this._dom.addRecord) this._dom.addRecord.disabled = false;
            this._refreshFuelStopButton();
        }
    }

    _engineBaseUrl() {
        return EngineClient.baseUrl();
    }

    /** Sane ceiling for a single dropped-burn correction: a full tank's worth,
     *  per side. Catches a decimal-point fat-finger (17 vs 1.7) that would
     *  otherwise floor an active tank at 0 with no confirmation prompt. */
    _droppedBurnMaxGal() {
        return (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;
    }

    /**
     * Apply a pilot-confirmed (or edited) dropped-burn correction to FlyTab's own
     * FuelTankState, then sync the Pi's independent FuelTracker separately.
     */
    async _applyDroppedBurnCorrection() {
        const gallons = parseFloat(this._dom.droppedBurnInput.value);
        if (!(gallons > 0)) {
            this._setDroppedBurnStatus('Enter a positive correction amount', 'error');
            return;
        }
        const maxGal = this._droppedBurnMaxGal();
        if (gallons > maxGal) {
            this._setDroppedBurnStatus(
                `${gallons.toFixed(1)} gal exceeds a full tank (${maxGal.toFixed(0)} gal) — check for a typo before applying`, 'error');
            return;
        }
        if (typeof FuelTankState !== 'undefined' && FuelTankState.needsConfirmation()) {
            this._setDroppedBurnStatus(
                'Tank state needs confirmation before applying a correction — confirm tank selection first', 'error');
            return;
        }
        if (typeof FuelTankState !== 'undefined' && FuelTankState.isDroppedBurnAmbiguous()) {
            this._setDroppedBurnStatus(
                'Cannot auto-apply — you switched tanks while this estimate was outstanding, so it can no longer be safely attributed to one tank. Record a fresh tic measurement or fuel stop to clear it.',
                'error');
            return;
        }
        this._dom.droppedBurnApply.disabled = true;
        try {
            // The precondition check above can't catch every refusal — an invalid
            // active_tank (legacy 'BOTH', corruption) flags requires_confirm as a
            // SIDE EFFECT of this call rather than before it, so the return value
            // is the only reliable signal that anything was actually applied.
            const applied = FuelTankState.applyDroppedBurn(gallons);
            if (!applied) {
                this._setDroppedBurnStatus(
                    'Could not apply — tank state needs confirmation. Confirm tank selection, then retry.', 'error');
                return;
            }
            await this._syncDroppedBurnToPi();
        } finally {
            this._dom.droppedBurnApply.disabled = false;
            this._refreshDroppedBurnRow();
        }
    }

    /** Retry syncing to the Pi only — used when the local correction already
     *  landed but the earlier Pi sync attempt failed. Does not touch FuelTankState
     *  again (that would double-subtract from the tank). */
    async _retryPiDroppedBurnSync() {
        this._dom.droppedBurnApply.disabled = true;
        try {
            await this._syncDroppedBurnToPi();
        } finally {
            this._dom.droppedBurnApply.disabled = false;
            this._refreshDroppedBurnRow();
        }
    }

    /**
     * Tell the Pi to apply ITS OWN tracked dropped_burn_estimate_gal (the server
     * ignores any amount from the client — see the /api/fuel/apply_dropped_burn
     * handler comment: FlyTab's estimate is a different quantity from a different
     * sample stream and must not be pushed onto the Pi's tracker). Unlike
     * _syncFuelSetToEngine()/_syncFuelAddToEngine(), failure here is reported to
     * the pilot instead of swallowed, and sets _piSyncFailed so the row stays up
     * as a retry affordance rather than silently going stale.
     */
    async _syncDroppedBurnToPi() {
        const base = this._engineBaseUrl();
        if (!base) {
            this._piSyncFailed = true;
            this._setDroppedBurnStatus(
                'Applied locally — Pi unreachable, engine-side total NOT corrected. Retry when back in range.', 'error');
            return;
        }
        try {
            const resp = await fetch(`${base}/api/fuel/apply_dropped_burn`, {
                method: 'POST',
                signal: AbortSignal.timeout(4000),
            });
            if (!resp.ok) throw new Error(`Pi returned ${resp.status}`);
            let result;
            try {
                result = await resp.json();
            } catch (parseErr) {
                // The Pi's endpoint ran (200 OK, and it applies under a single lock
                // acquisition — see engine_monitor.py's apply_own_dropped_burn()), so
                // the correction almost certainly landed. But we can't confirm the
                // amount, so this must NOT collapse into the same reassuring message
                // as a verified success (PR #143 review) — flag it and offer a retry.
                this._piSyncFailed = true;
                this._setDroppedBurnStatus(
                    'Pi accepted the correction but its response could not be read — verify the Pi\'s own fuel display, or retry.', 'error');
                return;
            }
            this._piSyncFailed = false;
            const appliedGal = result?.applied_gal;
            this._setDroppedBurnStatus(
                appliedGal != null
                    ? `Applied locally; Pi applied its own ${appliedGal.toFixed(1)} gal estimate`
                    : 'Applied to both trackers', 'ok');
        } catch (err) {
            this._piSyncFailed = true;
            this._setDroppedBurnStatus(
                `Applied locally — Pi sync failed (${err.message}). Retry when back in range.`, 'error');
        }
    }

    _setDroppedBurnStatus(msg, type) { this._setStatus(this._dom.droppedBurnStatus, msg, type); }

    /**
     * Push the pilot-confirmed tic measurement to the Pi as its new authoritative
     * fuel_remaining. Returns {ok, message} instead of swallowing the outcome — a
     * failed sync here leaves the Pi's own fuel total silently diverged from what
     * FlyTab now shows, the same risk fixed for the dropped-burn correction's Pi
     * sync in PR #143.
     * @returns {Promise<{ok: boolean, message: string}>}
     */
    async _syncFuelSetToEngine(gallons, reason = '') {
        const base = this._engineBaseUrl();
        if (!base) {
            return { ok: false, message: 'Measurement saved locally — Pi unreachable, engine-side total NOT updated. Retry when back in range.' };
        }
        try {
            const resp = await fetch(`${base}/api/fuel/set`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fuel_remaining: gallons, reason }),
                signal: AbortSignal.timeout(4000),
            });
            if (!resp.ok) throw new Error(`Pi returned ${resp.status}`);
            return { ok: true, message: '' };
        } catch (err) {
            return { ok: false, message: `Measurement saved locally — Pi sync failed (${err.message}). Retry when back in range.` };
        }
    }

    /**
     * Push a recorded fuel stop to the Pi's own fuel-addition log. Returns
     * {ok, message} — same rationale as _syncFuelSetToEngine().
     * @returns {Promise<{ok: boolean, message: string}>}
     */
    async _syncFuelAddToEngine(gallons, airport = '', price = null) {
        const base = this._engineBaseUrl();
        if (!base) {
            return { ok: false, message: 'Fuel stop saved locally — Pi unreachable, engine-side total NOT updated. Retry when back in range.' };
        }
        const body = { gallons };
        if (airport) body.airport = airport;
        if (price != null) body.price_per_gallon = price;
        try {
            const resp = await fetch(`${base}/api/fuel/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(4000),
            });
            if (!resp.ok) throw new Error(`Pi returned ${resp.status}`);
            return { ok: true, message: '' };
        } catch (err) {
            return { ok: false, message: `Fuel stop saved locally — Pi sync failed (${err.message}). Retry when back in range.` };
        }
    }

    _setAddStatus(msg, type) { this._setStatus(this._dom.addStatus, msg, type); }

    _setApplyStatus(msg, type) { this._setStatus(this._dom.applyStatus, msg, type); }

    /** Shared body for _setAddStatus()/_setApplyStatus()/_setDroppedBurnStatus() —
     *  each targets a different status element with the same textContent/className pattern. */
    _setStatus(el, msg, type) {
        if (!el) return;
        el.textContent = msg;
        el.className = 'fo-add-status fo-add-status-' + (type || 'ok');
    }

    _loadHistory() {
        try { return JSON.parse(localStorage.getItem('flypi_fuel_history') || '[]'); }
        catch (_) { return []; }
    }

    _saveHistory(history) {
        localStorage.setItem('flypi_fuel_history', JSON.stringify(history));
    }

    _renderHistory() {
        const body = this._dom.histBody;
        if (!body) return;

        const history = this._loadHistory();

        if (history.length === 0) {
            body.innerHTML = '<tr><td colspan="4" class="fo-hist-empty">No measurements recorded yet</td></tr>';
            return;
        }

        body.innerHTML = '';

        // Show newest first; map display index → original array index
        const slice = [...history].map((m, origIdx) => ({ m, origIdx }))
            .reverse().slice(0, 25);

        slice.forEach(({ m, origIdx }) => {
            const dt = m.measured_at ? new Date(m.measured_at) : (m.ts ? new Date(m.ts) : null);
            const dateStr = dt ? this._fmtDate(dt) : '--';
            const tic = m.total_gal != null ? m.total_gal.toFixed(1) : '--';
            const edm = m.edm_gal  != null ? m.edm_gal.toFixed(1)   : '--';

            const tr = document.createElement('tr');
            tr.dataset.origIdx = origIdx;
            tr.innerHTML = `
                <td>${dateStr}</td>
                <td>${tic}</td>
                <td>${edm}</td>
                <td class="fo-hist-actions">
                    <button class="fo-hist-btn fo-hist-edit" title="Edit">✎</button>
                    <button class="fo-hist-btn fo-hist-del" title="Delete">✕</button>
                </td>`;

            wireTap(tr.querySelector('.fo-hist-del'), () => {
                this._deleteHistoryEntry(origIdx);
            });
            wireTap(tr.querySelector('.fo-hist-edit'), () => {
                this._editHistoryRow(origIdx, tr);
            });

            body.appendChild(tr);
        });
    }

    _deleteHistoryEntry(origIdx) {
        const history = this._loadHistory();
        history.splice(origIdx, 1);
        this._saveHistory(history);
        this._renderHistory();
        this._renderKFactor();
    }

    _editHistoryRow(origIdx, tr) {
        const history = this._loadHistory();
        const m = history[origIdx];
        if (!m) return;

        const ticVal = m.total_gal != null ? m.total_gal.toFixed(1) : '';
        const edmVal = m.edm_gal  != null ? m.edm_gal.toFixed(1)   : '';

        // Replace row with edit inputs
        tr.innerHTML = `
            <td colspan="2" class="fo-hist-edit-cell">
                <label class="fo-hist-edit-label">TIC</label>
                <input type="number" class="fo-hist-edit-input" id="fo-hist-tic-${origIdx}"
                       value="${ticVal}" min="0" max="100" step="0.1">
                <label class="fo-hist-edit-label">EDM</label>
                <input type="number" class="fo-hist-edit-input" id="fo-hist-edm-${origIdx}"
                       value="${edmVal}" min="0" max="100" step="0.1">
            </td>
            <td colspan="2" class="fo-hist-actions">
                <button class="fo-hist-btn fo-hist-save">✔</button>
                <button class="fo-hist-btn fo-hist-cancel">✕</button>
            </td>`;

        wireTap(tr.querySelector('.fo-hist-save'), () => {
            const newTic = parseFloat(tr.querySelector(`#fo-hist-tic-${origIdx}`).value);
            const newEdm = parseFloat(tr.querySelector(`#fo-hist-edm-${origIdx}`).value);
            if (!isNaN(newTic)) m.total_gal = newTic;
            if (!isNaN(newEdm)) m.edm_gal = newEdm;
            history[origIdx] = m;
            this._saveHistory(history);
            this._renderHistory();
            this._renderKFactor();
        });
        wireTap(tr.querySelector('.fo-hist-cancel'), () => {
            this._renderHistory();
        });
    }

    _fmtDate(dt) {
        const mo  = dt.getMonth() + 1;
        const day = dt.getDate();
        const hr  = dt.getHours();
        const mn  = String(dt.getMinutes()).padStart(2, '0');
        const ampm = hr >= 12 ? 'p' : 'a';
        const hr12 = hr % 12 || 12;
        return `${mo}/${day} ${hr12}:${mn}${ampm}`;
    }

    _renderKFactor() {
        if (!this._dom.kfFilled) return;

        // Total fuel filled from recorded fuel stops
        let totalFilled = 0;
        try {
            const stops = JSON.parse(localStorage.getItem('flytab_fuel_stops') || '[]');
            totalFilled = stops.reduce((sum, s) => sum + (parseFloat(s.gallons) || 0), 0);
        } catch (_) { /* */ }

        // Total EDM-computed fuel used: sum of drops between consecutive measurements with edm_gal
        let totalUsed = 0;
        try {
            const history = JSON.parse(localStorage.getItem('flypi_fuel_history') || '[]');
            const edmEntries = history.filter(m => m.edm_gal > 0).map(m => ({
                ts: m.measured_at ? new Date(m.measured_at).getTime() : (m.ts || 0),
                edm: m.edm_gal,
                tic: m.total_gal || 0,
            })).sort((a, b) => a.ts - b.ts);

            for (let i = 1; i < edmEntries.length; i++) {
                const edmDrop = edmEntries[i - 1].edm - edmEntries[i].edm;
                const ticDrop = edmEntries[i - 1].tic - edmEntries[i].tic;
                // Require EDM decreased and tic didn't increase — filters out post-refuel
                // entries where tic increases (fuel added) but EDM still shows the stale
                // pre-refuel value, which would produce a false "fuel used" reading.
                // ticDrop === 0 is kept: the tic scale is quantized to 0.5 gal steps and
                // can legitimately read flat between two close measurements while EDM
                // shows real consumption.
                if (edmDrop > 0 && ticDrop >= 0) totalUsed += edmDrop;
            }
        } catch (_) { /* */ }

        if (totalFilled > 0) {
            this._dom.kfFilled.textContent = totalFilled.toFixed(1) + ' gal';
        } else {
            this._dom.kfFilled.textContent = '-- gal';
        }

        if (totalUsed > 0) {
            this._dom.kfUsed.textContent = totalUsed.toFixed(1) + ' gal';
        } else {
            this._dom.kfUsed.textContent = '-- gal';
        }

        if (totalFilled > 0 && totalUsed > 0) {
            const ratio = totalFilled / totalUsed;
            this._dom.kfRatio.textContent = ratio.toFixed(3);
            // Color-code: green near 1.0, yellow if off by 5%, red if off by 10%
            const dev = Math.abs(ratio - 1.0);
            this._dom.kfRatio.className = 'fo-kfactor-val fo-kfactor-ratio ' +
                (dev < 0.05 ? 'fo-kf-good' : dev < 0.10 ? 'fo-kf-warn' : 'fo-kf-bad');
            this._dom.kfGuidance.textContent =
                `New K-Factor = Current K-Factor × ${ratio.toFixed(3)}` +
                (ratio > 1.0 ? '  (increase K-factor — EDM reads low)' : ratio < 1.0 ? '  (decrease K-factor — EDM reads high)' : '  (K-factor accurate)');
        } else {
            this._dom.kfRatio.textContent = '--';
            this._dom.kfRatio.className = 'fo-kfactor-val fo-kfactor-ratio';
            this._dom.kfGuidance.textContent = totalFilled > 0
                ? 'Record more tic measurements with EDM data to compute ratio.'
                : 'Record fuel stops to compute ratio.';
        }
    }

    /** Best-effort read of the Pi's own K-factor calibration status. Passive
     *  display refresh, same non-blocking pattern as _resolveEdmFuel() in
     *  show() — on failure, leaves the panel hidden rather than showing stale
     *  or fabricated numbers. */
    async _fetchPiCalibration() {
        const base = this._engineBaseUrl();
        if (!base || !this._dom.kfPiSection) { if (this._dom.kfPiSection) this._dom.kfPiSection.style.display = 'none'; return; }
        try {
            const resp = await fetch(`${base}/api/fuel/calibration`, { signal: AbortSignal.timeout(4000) });
            if (!resp.ok) throw new Error(`Pi returned ${resp.status}`);
            const status = await resp.json();
            this._renderPiKFactor(status);
        } catch (_) {
            this._dom.kfPiSection.style.display = 'none';
        }
    }

    _renderPiKFactor(status) {
        this._piCalibration = status;
        this._dom.kfPiSection.style.display = '';
        this._dom.kfPiCurrent.textContent = status.current_k_factor != null ? String(status.current_k_factor) : '--';
        if (status.ready) {
            this._dom.kfPiSuggested.textContent = String(status.suggested_k_factor);
            this._dom.kfPiRecommendation.textContent = status.recommendation || '';
            this._dom.kfPiApply.style.display = '';
        } else {
            this._dom.kfPiSuggested.textContent = '--';
            this._dom.kfPiRecommendation.textContent = status.message || '';
            this._dom.kfPiApply.style.display = 'none';
        }
    }

    /** Record the Pi's own suggested K-factor as applied (POST — the Pi does
     *  not re-program the physical sensor; this is a log entry the pilot
     *  confirms after manually setting the new K-factor on the Dynon EMS). */
    async _applyPiKFactor() {
        if (!this._piCalibration?.ready) return;
        const newK = this._piCalibration.suggested_k_factor;
        const base = this._engineBaseUrl();
        if (!base) {
            this._setStatus(this._dom.kfPiStatus, 'Pi unreachable — cannot record applied K-factor', 'error');
            return;
        }
        this._dom.kfPiApply.disabled = true;
        try {
            const resp = await fetch(`${base}/api/fuel/calibration/applied`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_k_factor: newK }),
                signal: AbortSignal.timeout(4000),
            });
            const result = await resp.json().catch(() => ({}));
            if (resp.ok && result.success) {
                this._setStatus(this._dom.kfPiStatus, result.message || `K-factor ${newK} recorded as applied`, 'ok');
                await this._fetchPiCalibration();
            } else {
                this._setStatus(this._dom.kfPiStatus, result.error || `Pi returned ${resp.status}`, 'error');
            }
        } catch (err) {
            this._setStatus(this._dom.kfPiStatus, `Pi sync failed (${err.message})`, 'error');
        } finally {
            this._dom.kfPiApply.disabled = false;
        }
    }

    async _syncMeasurement(m) {
        // FlyTab: fuel measurements stored locally only (no server endpoint)
        try {
            const history = JSON.parse(localStorage.getItem('flypi_fuel_history') || '[]');
            history.push({ ...m, ts: Date.now() });
            // Keep last 100 measurements
            if (history.length > 100) history.splice(0, history.length - 100);
            localStorage.setItem('flypi_fuel_history', JSON.stringify(history));
        } catch (_) { /* storage full — no problem */ }
    }
}
