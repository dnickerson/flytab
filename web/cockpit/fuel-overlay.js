/**
 * FlyTab — Fuel Overlay
 * Full-screen overlay for tic mark entry, tic vs tracked-fuel comparison, and fuel source management.
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
        this._shownAt = 0;
        this._applying = false;
        // Re-entrancy latch for _recordFuelStop(). That method is synchronous, so two
        // taps cannot overlap today; the latch is kept as a defensive guard in case an
        // await is ever reintroduced. A double tap is refused by the consumed-reading
        // guard (_ticsTouchedSinceShow) instead.
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

            <!-- B) TIC vs TRACKED COMPARISON (tracked = tablet FuelTankState) -->
            <div class="fo-edm-section" id="fo-edm-section" style="display:none;">
                <div class="fo-section-title">TIC vs TRACKED</div>
                <div class="fo-edm-row">
                    <div class="fo-edm-item">
                        <div class="fo-edm-label">TIC</div>
                        <div class="fo-edm-val" id="fo-edm-tic">--</div>
                    </div>
                    <div class="fo-edm-item">
                        <div class="fo-edm-label">TRACKED</div>
                        <div class="fo-edm-val" id="fo-edm-tracked">--</div>
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
                <div class="fo-edm-d180" id="fo-edm-d180" style="display:none;"></div>
            </div>

            <!-- C) ACTIVE FUEL SOURCE -->
            <div class="fo-section-title">ACTIVE FUEL SOURCE</div>
            <div class="fo-source-chain" id="fo-source-chain">
                <span class="fo-source-chip" data-src="manual">MANUAL</span>
                <span class="fo-source-sep">\u203A</span>
                <span class="fo-source-chip" data-src="tank_state">TRACKED</span>
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
                            <th>TRACKED (gal)</th>
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
                        <div class="fo-kfactor-label">ACTUAL USED (tic + fuel stops)</div>
                        <div class="fo-kfactor-val" id="fo-kf-filled">-- gal</div>
                    </div>
                    <div class="fo-kfactor-item">
                        <div class="fo-kfactor-label">TRACKED USED (fuel flow)</div>
                        <div class="fo-kfactor-val" id="fo-kf-used">-- gal</div>
                    </div>
                    <div class="fo-kfactor-item">
                        <div class="fo-kfactor-label">K-FACTOR RATIO</div>
                        <div class="fo-kfactor-val fo-kfactor-ratio" id="fo-kf-ratio">--</div>
                    </div>
                </div>
                <div class="fo-kfactor-guidance" id="fo-kf-guidance"></div>
                <div class="fo-kfactor-note">
                    Ratio = Tracked used ÷ Actual used, over the legs between tic measurements. Tracked burn
                    is integrated from the D-180 fuel-flow reading; the D-180 K-factor is pulses per gallon,
                    so New K-factor = Current K-factor × Ratio (tracked higher than actual → increase it).
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
            edmTracked: this._el.querySelector('#fo-edm-tracked'),
            edmD180: this._el.querySelector('#fo-edm-d180'),
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

        // Wire dropped-burn correction (applied on the tablet's FuelTankState only).
        wireTap(this._el.querySelector('#fo-dropped-burn-apply'), () => {
            this._applyDroppedBurnCorrection();
        });

        // Wire apply
        wireTap(this._el.querySelector('#fo-apply'), () => {
            this._applyMeasurement();
        });

        // Wire fuel-add record button
        wireTap(this._el.querySelector('#fo-add-record'), () => {
            this._recordFuelStop();
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

        this._updateDisplay();
        this._updateSourceDisplay();
        this._renderHistory();
        this._renderKFactor();
        this._el.style.display = 'flex';
        this._visible = true;
        this._shownAt = Date.now();
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

        // Tic vs tracked comparison
        this._updateTrackedComparison();
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
            } else {
                this._dom.droppedBurnRow.style.display = 'none';
            }
        } catch (_) { /* FuelTankState unavailable */ }
    }

    /**
     * The tablet's tracked fuel on board: FuelTankState left + right, rounded to
     * 0.1 gal like a measurement's total_gal. Null when nothing is tracked. A manual
     * override is deliberately NOT used here: it is a pilot entry, not a measurement.
     * `stale` reuses FuelState.getCurrentFuel()'s rule (FuelTankState.needsConfirmation()).
     * @returns {{gal: number, stale: boolean}|null}
     */
    _trackedTotal() {
        try {
            if (typeof FuelTankState === 'undefined') return null;
            const st = FuelTankState.getState();
            if (!st) return null;
            const gal = Math.round((st.left_gal + st.right_gal) * 10) / 10;
            if (!Number.isFinite(gal)) return null;
            let stale = false;
            try { stale = !!FuelTankState.needsConfirmation(); } catch (_) { stale = false; }
            return { gal, stale };
        } catch (_) { return null; }
    }

    /**
     * TIC | TRACKED | VARIANCE (TIC − TRACKED) | ACCURACY, plus a smaller
     * "D-180: <x> gal" line when the D-180's own fuel figure is fresh. Hidden when
     * there is no tracked tank state to compare with.
     */
    _updateTrackedComparison() {
        const tracked = this._trackedTotal();
        if (!tracked) {
            this._dom.edmSection.style.display = 'none';
            return;
        }
        this._dom.edmSection.style.display = '';
        const m = FuelEngine.createMeasurement(
            this._leftTic, this._rightTic, this._coefficients, tracked.gal
        );
        this._dom.edmTic.textContent = m.total_gal.toFixed(1) + ' gal';
        this._dom.edmTracked.textContent = tracked.gal.toFixed(1) + ' gal' +
            (tracked.stale ? ' (UNCONFIRMED)' : '');
        if (m.variance_gal != null) {
            this._dom.edmVar.textContent = (m.variance_gal > 0 ? '+' : '') + m.variance_gal.toFixed(1) + ' gal';
            const grade = m.accuracy || 'check';
            this._dom.edmGrade.textContent = grade.toUpperCase();
            this._dom.edmGrade.className = 'fo-edm-badge fo-grade-' + grade;
        } else {
            // Tracked 0.0 gal: createMeasurement() grades only against a positive figure.
            this._dom.edmVar.textContent = '--';
            this._dom.edmGrade.textContent = '--';
            this._dom.edmGrade.className = 'fo-edm-badge';
        }

        const d180 = this._resolveD180Fuel();
        if (d180 != null) {
            this._dom.edmD180.textContent = `D-180: ${d180.toFixed(1)} gal`;
            this._dom.edmD180.style.display = '';
        } else {
            this._dom.edmD180.textContent = '';
            this._dom.edmD180.style.display = 'none';
        }
    }

    _updateSourceDisplay() {
        const { gallons, source, stale } = FuelState.getCurrentFuel();
        const label = source === 'tank_state' ? 'TRACKED' : source.toUpperCase();
        this._dom.sourceDisplay.textContent =
            `${gallons.toFixed(1)} gal (${label})` + (stale ? ' \u00B7 UNCONFIRMED' : '');

        // Highlight active chip in priority chain
        const chips = this._dom.sourceChain.querySelectorAll('.fo-source-chip');
        chips.forEach(chip => {
            chip.classList.toggle('fo-source-active', chip.dataset.src === source);
        });
    }

    /**
     * Returns an error message if either tank's CURRENT tic-derived gallons
     * exceeds capacity, else null. A single shared check so _applyMeasurement()
     * and _recordFuelStop() can't drift apart. Both run it immediately before
     * their (synchronous) write, so it validates the value actually written.
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
        // Re-entrancy latch. APPLY is synchronous (no network wait), so this is
        // defensive: it refuses a re-entrant call made from inside the write path.
        if (this._applying) return;

        // Opened from the in-flight fuel-stop overlay: APPLY writes canonical
        // FuelTankState (init() → fresh initialized_at) exactly as RECORD does, and that
        // timestamp is the only thing app.js's Continue gate checks. show() restored the
        // DEPARTURE reading into the tic fields, so tapping this button without touching
        // a control would report "Measured: <departure gallons>" over tanks that have
        // since burned down — the same defect as the record path, on the larger button.
        // Refuse here, before any write, so FuelState,
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
        try {
            // Both figures are taken BEFORE FuelTankState.init() below overwrites the
            // tracked state with this tic reading.
            const m = this._createRecordedMeasurement();
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
            this.hide();
        } catch (err) {
            console.error('[FuelOverlay] applyMeasurement failed:', err);
        } finally {
            this._applying = false;
        }
    }

    /**
     * A measurement record for the current tic reading. tracked_gal is the tablet's
     * tracked total (null when nothing is tracked) and must be read before the tic
     * re-initialises FuelTankState; edm_gal is the D-180's own fuel figure when
     * fresh, else null. variance_gal / variance_pct / accuracy grade the tic
     * against tracked_gal, as the comparison block shows.
     */
    _createRecordedMeasurement() {
        const tracked = this._trackedTotal();
        const m = FuelEngine.createMeasurement(this._leftTic, this._rightTic, this._coefficients);
        if (tracked) {
            // createMeasurement() grades against its 4th argument but also stores that
            // argument as edm_gal; take only the grading from it.
            const graded = FuelEngine.createMeasurement(
                this._leftTic, this._rightTic, this._coefficients, tracked.gal);
            for (const k of ['variance_gal', 'variance_pct', 'accuracy']) {
                if (graded[k] !== undefined) m[k] = graded[k];
            }
        }
        m.tracked_gal = tracked ? tracked.gal : null;
        m.edm_gal = this._resolveD180Fuel();
        return m;
    }

    /**
     * The Dynon D-180's own fuel-remaining figure (data.Fuel_Remaining) from a fresh
     * engine panel (polled within FuelState.EDM_FRESHNESS_MS), else null. Synchronous:
     * no file-server or CSV lookup, so APPLY TIC never waits on the network.
     */
    _resolveD180Fuel() {
        try {
            const panel = window.enginePanel;
            if (panel && panel.lastData && panel.lastPollTime &&
                (Date.now() - panel.lastPollTime) < FuelState.EDM_FRESHNESS_MS) {
                const val = FuelEngine.extractEdmFuel(panel.lastData);
                if (val > 0) return val;
            }
        } catch (_) { /* no engine data */ }
        return null;
    }

    _recordFuelStop() {
        // Defensive re-entrancy latch (see the constructor). This method has no await,
        // so a second RECORD tap runs only after the first has finished; that tap is
        // refused by the consumed-reading guard (_ticsTouchedSinceShow, cleared below),
        // not by this latch.
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
            // The measurement record (tracked_gal, edm_gal) is taken before init()
            // re-initialises the tracked state. It also goes into flypi_fuel_history with
            // the pumped gallons (fuel_stop_gal), so the K-factor can count the leg that
            // ends at this stop: actual used = previous tic − (this tic − gallons pumped).
            const m = this._createRecordedMeasurement();
            const leftGal = FuelEngine.ticToGallons(this._leftTic, this._coefficients);
            const rightGal = FuelEngine.ticToGallons(this._rightTic, this._coefficients);
            const existingTank = (typeof FuelTankState !== 'undefined') ? FuelTankState.getState() : null;
            if (typeof FuelTankState !== 'undefined') {
                FuelTankState.init(leftGal, rightGal, existingTank?.active_tank ?? 'L');
            }
            FuelState.saveMeasurement(m);
            this._syncMeasurement({ ...m, fuel_stop_gal: gallons });
            const newTotal = m.total_gal;

            window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            this._updateSourceDisplay();
            this._renderHistory();
            this._renderKFactor();

            // The reading has been consumed. A second RECORD tap must be backed by its own
            // fresh measurement, not this one — otherwise a double tap (or a second stop
            // on the same ramp) re-writes these gallons and re-stamps initialized_at.
            this._ticsTouchedSinceShow = false;

            // Clear inputs and show success
            this._dom.addGal.value = '';
            this._dom.addPrice.value = '';
            if (this._dom.addGalL) this._dom.addGalL.value = '';
            if (this._dom.addGalR) this._dom.addGalR.value = '';

            this._setAddStatus(`Recorded: +${gallons.toFixed(1)} gal at ${airport || '—'} → ${newTotal.toFixed(1)} gal total`, 'ok');
        } catch (err) {
            this._setAddStatus(`Save failed: ${err.message}`, 'error');
        } finally {
            this._recording = false;
        }
    }

    /** Sane ceiling for a single dropped-burn correction: a full tank's worth,
     *  per side. Catches a decimal-point fat-finger (17 vs 1.7) that would
     *  otherwise floor an active tank at 0 with no confirmation prompt. */
    _droppedBurnMaxGal() {
        return (typeof FuelTankState !== 'undefined') ? FuelTankState.perSideCapGal(18) : 18;
    }

    /**
     * Apply a pilot-confirmed (or edited) dropped-burn correction to FlyTab's own
     * FuelTankState. The tablet is the only fuel record; nothing is sent to the Pi.
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
            this._setDroppedBurnStatus(`Applied ${gallons.toFixed(1)} gal correction`, 'ok');
        } finally {
            this._dom.droppedBurnApply.disabled = false;
            this._refreshDroppedBurnRow();
        }
    }

    _setDroppedBurnStatus(msg, type) { this._setStatus(this._dom.droppedBurnStatus, msg, type); }

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
            const ref = this._historyRefField(m);
            const trk = Number.isFinite(m[ref]) ? m[ref].toFixed(1) : '--';

            const stopGal = Number(m.fuel_stop_gal);
            const stopTag = (Number.isFinite(stopGal) && stopGal > 0)
                ? `<div class="fo-hist-stop">FUEL STOP +${stopGal.toFixed(1)} gal</div>` : '';

            const tr = document.createElement('tr');
            tr.dataset.origIdx = origIdx;
            if (stopTag) tr.classList.add('fo-hist-row-stop');
            tr.innerHTML = `
                <td>${dateStr}${stopTag}</td>
                <td>${tic}</td>
                <td>${trk}</td>
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
        const ref = this._historyRefField(m);
        const trkVal = Number.isFinite(m[ref]) ? m[ref].toFixed(1) : '';

        // Replace row with edit inputs
        tr.innerHTML = `
            <td colspan="2" class="fo-hist-edit-cell">
                <label class="fo-hist-edit-label">TIC</label>
                <input type="number" class="fo-hist-edit-input" id="fo-hist-tic-${origIdx}"
                       value="${ticVal}" min="0" max="100" step="0.1">
                <label class="fo-hist-edit-label">TRACKED</label>
                <input type="number" class="fo-hist-edit-input" id="fo-hist-tracked-${origIdx}"
                       value="${trkVal}" min="0" max="100" step="0.1">
            </td>
            <td colspan="2" class="fo-hist-actions">
                <button class="fo-hist-btn fo-hist-save">✔</button>
                <button class="fo-hist-btn fo-hist-cancel">✕</button>
            </td>`;

        wireTap(tr.querySelector('.fo-hist-save'), () => {
            const newTic = parseFloat(tr.querySelector(`#fo-hist-tic-${origIdx}`).value);
            const newTrk = parseFloat(tr.querySelector(`#fo-hist-tracked-${origIdx}`).value);
            if (!isNaN(newTic)) m.total_gal = newTic;
            if (!isNaN(newTrk)) m[ref] = newTrk;
            history[origIdx] = m;
            this._saveHistory(history);
            this._renderHistory();
            this._renderKFactor();
        });
        wireTap(tr.querySelector('.fo-hist-cancel'), () => {
            this._renderHistory();
        });
    }

    /** The comparison figure a history entry carries. Entries saved since the tablet
     *  became the fuel source always have a tracked_gal key (null when nothing was
     *  tracked); older entries have no such key and carry edm_gal (the engine-data
     *  fuel figure at the time). Told apart by key presence, so a new entry with
     *  tracked_gal: null never falls back to its D-180 edm_gal. */
    _historyRefField(m) {
        return (m && typeof m === 'object' && 'tracked_gal' in m) ? 'tracked_gal' : 'edm_gal';
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

    /**
     * K-factor check from consecutive history entries (prev, next), sorted by time:
     *   actual used  = prev.total_gal − (next.total_gal − next.fuel_stop_gal)
     *   tracked used = prev.total_gal − next's tracked figure (taken before next's tic)
     * fuel_stop_gal is 0 for an APPLY TIC entry. A pair counts only when both are
     * finite and positive and no LEGACY fuel stop (a flytab_fuel_stops record with no
     * matching history entry, i.e. recorded before stops were written to history)
     * lies between the two: its fill is unknown to the pair.
     * Ratio = Σtracked ÷ Σactual. The D-180 K-factor is pulses per gallon (FlightDEK-
     * D180 Installation Guide, EMS Configuration → Fuel Flow: "if your GALS USED
     * reads higher than you expect, increase the K-factor"), so
     * New K = Current K × Ratio.
     */
    _computeKFactor() {
        const toMs = (v) => {
            if (v == null || v === '') return null;
            const t = new Date(v).getTime();
            return Number.isFinite(t) ? t : null;
        };
        let history = [];
        try { history = JSON.parse(localStorage.getItem('flypi_fuel_history') || '[]'); } catch (_) { /* */ }
        if (!Array.isArray(history)) history = [];
        let stops = [];
        try { stops = JSON.parse(localStorage.getItem('flytab_fuel_stops') || '[]'); } catch (_) { /* */ }
        if (!Array.isArray(stops)) stops = [];

        const entries = history.filter(m => m && typeof m === 'object').map(m => {
            const stopGal = Number(m.fuel_stop_gal);
            return {
                ts: toMs(m.measured_at) ?? (Number.isFinite(m.ts) ? m.ts : 0),
                tic: m.total_gal,
                ref: m[this._historyRefField(m)],
                stopGal: Number.isFinite(stopGal) && stopGal > 0 ? stopGal : 0,
                isStop: m.fuel_stop_gal != null,
            };
        }).sort((a, b) => a.ts - b.ts);

        // A stop recorded with this version wrote a history entry in the same call
        // (timestamps milliseconds apart). Allow a few seconds for that match.
        const MATCH_MS = 5000;
        const stopEntryTimes = entries.filter(e => e.isStop).map(e => e.ts);
        const legacyStopTimes = [];
        for (const st of stops) {
            const t = toMs(st?.saved_at) ?? (st?.date ? toMs(`${st.date}T${st.time || '00:00'}`) : null);
            if (t == null) continue;
            if (!stopEntryTimes.some(e => Math.abs(e - t) <= MATCH_MS)) legacyStopTimes.push(t);
        }

        let actual = 0, tracked = 0, pairs = 0;
        for (let i = 1; i < entries.length; i++) {
            const prev = entries[i - 1];
            const next = entries[i];
            if (!Number.isFinite(prev.tic) || !Number.isFinite(next.tic) || !Number.isFinite(next.ref)) continue;
            const a = prev.tic - (next.tic - next.stopGal);
            const t = prev.tic - next.ref;
            if (!(a > 0) || !(t > 0)) continue;
            if (legacyStopTimes.some(st => st > prev.ts && st < next.ts)) continue;
            actual += a;
            tracked += t;
            pairs++;
        }
        return { actual, tracked, pairs };
    }

    _renderKFactor() {
        if (!this._dom.kfFilled) return;
        const { actual, tracked, pairs } = this._computeKFactor();

        this._dom.kfFilled.textContent = pairs > 0 ? actual.toFixed(1) + ' gal' : '-- gal';
        this._dom.kfUsed.textContent = pairs > 0 ? tracked.toFixed(1) + ' gal' : '-- gal';

        if (pairs > 0) {
            const ratio = tracked / actual;
            this._dom.kfRatio.textContent = ratio.toFixed(3);
            // Color-code: green near 1.0, yellow if off by 5%, red if off by 10%
            const dev = Math.abs(ratio - 1.0);
            this._dom.kfRatio.className = 'fo-kfactor-val fo-kfactor-ratio ' +
                (dev < 0.05 ? 'fo-kf-good' : dev < 0.10 ? 'fo-kf-warn' : 'fo-kf-bad');
            this._dom.kfGuidance.textContent =
                `New K-Factor = Current K-Factor × ${ratio.toFixed(3)}` +
                (ratio > 1.0 ? '  (increase K-factor — tracked burn higher than actual)'
                    : ratio < 1.0 ? '  (decrease K-factor — tracked burn lower than actual)'
                    : '  (K-factor accurate)');
        } else {
            this._dom.kfRatio.textContent = '--';
            this._dom.kfRatio.className = 'fo-kfactor-val fo-kfactor-ratio';
            this._dom.kfGuidance.textContent =
                'Record a tic measurement (APPLY TIC or RECORD FUEL STOP) at the start and end of a leg flown with fuel tracked to compute ratio.';
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
