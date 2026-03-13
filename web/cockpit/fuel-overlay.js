/**
 * FlyPi — Fuel Overlay
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
                <button class="ep-close fo-close" id="fo-close">MAP</button>
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
                           placeholder="Gallons added" min="0" max="100" step="0.1">
                    <input type="number" class="fo-add-input" id="fo-add-price"
                           placeholder="$/gal (optional)" min="0" max="20" step="0.01">
                </div>
                <button class="fo-apply-btn fo-add-record-btn" id="fo-add-record">RECORD FUEL STOP</button>
                <div class="fo-add-status" id="fo-add-status"></div>
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
            addPrice: this._el.querySelector('#fo-add-price'),
            addRecord: this._el.querySelector('#fo-add-record'),
            addStatus: this._el.querySelector('#fo-add-status'),
        };

        // Wire close
        this._wireTap(this._el.querySelector('#fo-close'), () => this.hide());

        // Wire left tank controls
        this._dom.leftSlider.addEventListener('input', (e) => {
            this._leftTic = parseFloat(e.target.value);
            this._dom.leftInput.value = this._leftTic;
            this._updateDisplay();
        });
        this._dom.leftInput.addEventListener('input', (e) => {
            const raw = parseFloat(e.target.value) || 0;
            this._leftTic = Math.min(this._maxTic, Math.max(0, Math.round(raw / this._ticStep) * this._ticStep));
            this._dom.leftSlider.value = this._leftTic;
            this._updateDisplay();
        });
        this._wireTap(this._el.querySelector('#fo-left-minus'), () => {
            this._leftTic = Math.max(0, Math.round((this._leftTic - this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.leftSlider.value = this._leftTic;
            this._dom.leftInput.value = this._leftTic;
            this._updateDisplay();
        });
        this._wireTap(this._el.querySelector('#fo-left-plus'), () => {
            this._leftTic = Math.min(this._maxTic, Math.round((this._leftTic + this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.leftSlider.value = this._leftTic;
            this._dom.leftInput.value = this._leftTic;
            this._updateDisplay();
        });

        // Wire right tank controls
        this._dom.rightSlider.addEventListener('input', (e) => {
            this._rightTic = parseFloat(e.target.value);
            this._dom.rightInput.value = this._rightTic;
            this._updateDisplay();
        });
        this._dom.rightInput.addEventListener('input', (e) => {
            const raw = parseFloat(e.target.value) || 0;
            this._rightTic = Math.min(this._maxTic, Math.max(0, Math.round(raw / this._ticStep) * this._ticStep));
            this._dom.rightSlider.value = this._rightTic;
            this._updateDisplay();
        });
        this._wireTap(this._el.querySelector('#fo-right-minus'), () => {
            this._rightTic = Math.max(0, Math.round((this._rightTic - this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.rightSlider.value = this._rightTic;
            this._dom.rightInput.value = this._rightTic;
            this._updateDisplay();
        });
        this._wireTap(this._el.querySelector('#fo-right-plus'), () => {
            this._rightTic = Math.min(this._maxTic, Math.round((this._rightTic + this._ticStep) / this._ticStep) * this._ticStep);
            this._dom.rightSlider.value = this._rightTic;
            this._dom.rightInput.value = this._rightTic;
            this._updateDisplay();
        });

        // Wire manual override
        this._wireTap(this._el.querySelector('#fo-manual-set'), () => {
            const val = parseFloat(this._dom.manualInput.value);
            if (val > 0) {
                FuelState.setManualOverride(val);
                this._updateSourceDisplay();
                window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            }
        });
        this._wireTap(this._el.querySelector('#fo-manual-clear'), () => {
            FuelState.clearManualOverride();
            this._dom.manualInput.value = '';
            this._updateSourceDisplay();
            window.dispatchEvent(new CustomEvent('fuelstate:changed'));
        });

        // Wire apply
        this._wireTap(this._el.querySelector('#fo-apply'), () => {
            this._applyMeasurement();
        });

        // Wire fuel-add record button
        this._wireTap(this._el.querySelector('#fo-add-record'), () => {
            this._recordFuelStop();
        });
    }

    /* ------------------------------------------------------------------
     * Show / Hide
     * ----------------------------------------------------------------*/
    show() {
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

        this._updateDisplay();
        this._updateSourceDisplay();
        this._el.style.display = 'flex';
        this._visible = true;
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

        this._dom.leftGal.textContent = leftGal.toFixed(1) + ' gal';
        this._dom.rightGal.textContent = rightGal.toFixed(1) + ' gal';
        this._dom.totalGal.textContent = total.toFixed(1);

        // EDM comparison
        this._updateEdmComparison(total);
    }

    _updateEdmComparison(ticTotal) {
        let edmFuel = 0;
        try {
            const panel = window.enginePanel;
            if (panel && panel.lastData && panel.lastPollTime) {
                const age = Date.now() - panel.lastPollTime;
                if (age < FuelState.EDM_FRESHNESS_MS) {
                    edmFuel = FuelEngine.extractEdmFuel(panel.lastData);
                }
            }
        } catch (_) { /* no engine data */ }

        if (edmFuel > 0) {
            this._dom.edmSection.style.display = '';
            const m = FuelEngine.createMeasurement(
                this._leftTic, this._rightTic, this._coefficients, edmFuel
            );
            this._dom.edmTic.textContent = m.total_gal.toFixed(1) + ' gal';
            this._dom.edmEdm.textContent = edmFuel.toFixed(1) + ' gal';
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

    /* ------------------------------------------------------------------
     * Apply measurement
     * ----------------------------------------------------------------*/
    _applyMeasurement() {
        let edmFuel = null;
        try {
            const panel = window.enginePanel;
            if (panel && panel.lastData && panel.lastPollTime) {
                const age = Date.now() - panel.lastPollTime;
                if (age < FuelState.EDM_FRESHNESS_MS) {
                    const val = FuelEngine.extractEdmFuel(panel.lastData);
                    if (val > 0) edmFuel = val;
                }
            }
        } catch (_) { /* */ }

        const m = FuelEngine.createMeasurement(
            this._leftTic, this._rightTic, this._coefficients, edmFuel
        );

        FuelState.saveMeasurement(m);
        window.dispatchEvent(new CustomEvent('fuelstate:changed'));
        this._updateSourceDisplay();

        // Fire-and-forget sync to flywhere.app
        this._syncMeasurement(m);

        this.hide();
    }

    _recordFuelStop() {
        const gallons = parseFloat(this._dom.addGal.value);
        if (!gallons || gallons <= 0) {
            this._setAddStatus('Enter gallons added', 'error');
            return;
        }
        const airport = this._dom.addAirport.value.trim().toUpperCase();
        const date = this._dom.addDate.value;
        const time = this._dom.addTime.value;
        const priceRaw = parseFloat(this._dom.addPrice.value);
        const price = priceRaw > 0 ? priceRaw : null;

        try {
            // Store fuel stop locally (Capacitor Filesystem in Phase 3)
            const stops = JSON.parse(localStorage.getItem('flytab_fuel_stops') || '[]');
            const record = { airport, date, time, gallons, price_per_gallon: price, saved_at: new Date().toISOString() };
            stops.push(record);
            localStorage.setItem('flytab_fuel_stops', JSON.stringify(stops));

            // Update current fuel total: previous fuel + gallons added
            const { gallons: currentFuel } = FuelState.getStartFuel();
            const newTotal = currentFuel + gallons;
            FuelState.saveMeasurement({ total_gal: newTotal, source: 'tic' });
            window.dispatchEvent(new CustomEvent('fuelstate:changed'));
            this._updateSourceDisplay();

            // Clear inputs and show success
            this._dom.addGal.value = '';
            this._dom.addPrice.value = '';
            this._setAddStatus(`Recorded: +${gallons.toFixed(1)} gal at ${airport || '—'} → ${newTotal.toFixed(1)} gal total`, 'ok');
        } catch (err) {
            this._setAddStatus(`Save failed: ${err.message}`, 'error');
        }
    }

    _setAddStatus(msg, type) {
        const el = this._dom.addStatus;
        el.textContent = msg;
        el.className = 'fo-add-status fo-add-status-' + (type || 'ok');
    }

    /** Wire touchstart + click with debounce for iPad reliability */
    _wireTap(el, handler) {
        if (!el) return;
        let touchFired = false;
        el.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            touchFired = true;
            handler(e);
            setTimeout(() => { touchFired = false; }, 400);
        });
        el.addEventListener('click', (e) => {
            if (!touchFired) handler(e);
        });
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
