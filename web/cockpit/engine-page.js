/**
 * FlyTab -- Engine Page (Full-Screen Instrumentation)
 * Full-screen overlay mirroring the capture_v5 engine_monitor.py layout.
 * Opens over the map when [ENG] button is tapped; closes with [X].
 *
 * Reads live data from EnginePanel.lastData (polled every 2 s at /api/engine/status).
 * Thresholds come from CockpitConfig.get('enginePage') when available.
 */

class EnginePage {
    constructor(container) {
        this.container = container;
        this._el = null;
        this._canvas = null;
        this._chtCanvas = null;
        this._visible = false;
        this._rafId = null;
        this._timeoutId = null;

        // EGT trend history: circular buffer of { ts, egt: [4], cht: [4] }
        this._trendHistory = [];
        this._trendHead = 0;
        this._trendLen = 0;
        this._trendMaxPts = 7200; // 2 h at 1 sample/s

        // Cached DOM elements (populated in _buildDom)
        this._dom = {};

        // Sticky-valve detection state
        this._engineStartTime = null;
        this._stickyStartTimes = [null, null, null, null];
        this._stickyAlert = null; // cylinder 1-4 or null
        this._stickyDismissed = false;

        // ATIS status error hold: _updateAtisStatus() runs every update() tick
        // (~1Hz) and would otherwise overwrite an error message before the
        // pilot can read it -- this timestamp holds the error on screen for a
        // few seconds before the normal override/no-override text resumes.
        this._atisErrorUntil = 0;

        // Previous EGT/CHT for trend arrows
        this._prevEgt = [0, 0, 0, 0];
        this._prevCht = [0, 0, 0, 0];

        // Config defaults (overridden by CockpitConfig.get('enginePage'))
        this._cfg = {
            egtCaution: 1500,
            egtDanger: 1650,
            chtCaution: 380,
            chtDanger: 435,
            oilTempCaution: 220,
            oilTempDanger: 245,
            oilPressLow: 25,         // red below — Lycoming minimum
            oilPressCautionLow: 55,  // yellow below — approaching minimum
            oilPressCautionHigh: 95, // yellow above — approaching redline
            oilPressDanger: 100,     // red above — Lycoming redline
            carbTempCaution: 40,    // icing range upper (degrees F)
            carbTempDanger: -15,    // icing range lower (degrees F)
            // Fallback only. The canonical capacity lives in aircraft-config.json
            // (performance.fuel_capacity_gal) and is read in _loadConfig(). 36 gal =
            // 2 x 18 gal tanks; the Pi's old 34 gal "usable capacity" is deprecated.
            fuelCapacity: 36,
            fuelCautionGal: 8,
            fuelWarningGal: 4,
            // Above this per-tank level the EDM senders on this airframe read a flat/
            // invalid value. Canonical value: aircraft-config.json
            // performance.fuel_sender_accurate_below_gal (read in _loadConfig()).
            senderAccurateBelowGal: 12,
            trendChartMinutes: 30,
            stickyValveWarmupMin: 10,
            stickyValveEgtRatio: 0.50,
            stickyValveMinEgt: 200,
            stickyValvePersistSec: 30,
        };

        this._buildDom();
    }

    /* ------------------------------------------------------------------
     * DOM construction
     * ----------------------------------------------------------------*/
    _buildDom() {
        this._el = document.createElement('div');
        this._el.className = 'engine-page-overlay';
        this._el.style.display = 'none';

        this._el.innerHTML = /* html */`
        <style>${EnginePage._css()}</style>

        <!-- Fixed header: status left, data-age badge, STOP + MAP buttons right -->
        <div class="ep-header" id="ep-header">
            <span class="ep-capture-status" id="ep-capture-status">● CHECKING…</span>
            <span class="ep-data-age ep-data-age--offline" id="ep-data-age">ENGINE MON. OFFLINE</span>
            <button class="ep-capture-stop" id="ep-capture-stop" disabled>STOP &amp; SAVE</button>
            <button class="btn-close ep-close" id="ep-close">✕</button>
        </div>

        <div class="ep-container">

            <!-- Pi contract mismatch banner (#113) -->
            <div class="ep-contract-banner" id="ep-contract-banner" style="display:none;">
                <div class="ep-contract-text">
                    PI OUT OF DATE — this build needs contract <span id="ep-contract-required">?</span>,
                    connected Pi (v<span id="ep-contract-pi-version">?</span>) reports <span id="ep-contract-pi-contract">?</span>.
                    Run <code>bash deploy-pi.sh</code>.
                </div>
            </div>

            <!-- Sticky valve warning banner -->
            <div class="ep-sticky-banner" id="ep-sticky-banner" style="display:none;">
                <div class="ep-sticky-text">
                    STICKY VALVE WARNING -- Cylinder <span id="ep-sticky-cyl">?</span>
                    EGT significantly below others (Lycoming SB 388C)
                </div>
                <button class="ep-sticky-dismiss" id="ep-sticky-dismiss">DISMISS</button>
            </div>

            <!-- Section 1: Primary gauges (7 columns) -->
            <div class="ep-section ep-primary-row">
                ${this._gaugeHtml('ep-rpm',   'RPM',       '----', '')}
                ${this._gaugeHtml('ep-map',   'MAP',       '--.-', 'inHg')}
                ${this._gaugeHtml('ep-ff',    'FUEL FLOW', '--.-', 'GPH')}
                ${this._gaugeHtml('ep-oilt',  'OIL TEMP',  '---',  '\u00B0F')}
                ${this._gaugeHtml('ep-oilp',  'OIL PRESS', '--',   'PSI')}
                ${this._gaugeHtml('ep-volts', 'VOLTS',     '--.-', '')}
                ${this._gaugeHtml('ep-carb',  'CARB TEMP', '---',  '\u00B0F')}
            </div>

            <!-- Section 2: Engine analysis (4 columns) -->
            <div class="ep-section-title">ENGINE ANALYSIS</div>
            <div class="ep-section ep-analysis-row">
                ${this._gaugeHtml('ep-pwr',    '% POWER',          '--',  '')}
                ${this._gaugeHtml('ep-mix',    'MIXTURE',          '---', '')}
                ${this._gaugeHtml('ep-dev',    'DEVIATION %',      '--',  '')}
                ${this._gaugeHtml('ep-bsfc',   'BSFC (lb/HP/hr)', '--',  '')}
            </div>

            <!-- Section 3: EGT per cylinder -->
            <div class="ep-section-title">EGT (\u00B0F)</div>
            <div class="ep-section ep-egt-row">
                ${this._tempGaugeHtml('ep-egt', 1)}
                ${this._tempGaugeHtml('ep-egt', 2)}
                ${this._tempGaugeHtml('ep-egt', 3)}
                ${this._tempGaugeHtml('ep-egt', 4)}
            </div>

            <!-- Section 4: CHT per cylinder -->
            <div class="ep-section-title">CHT (\u00B0F)</div>
            <div class="ep-section ep-cht-row">
                ${this._tempGaugeHtml('ep-cht', 1)}
                ${this._tempGaugeHtml('ep-cht', 2)}
                ${this._tempGaugeHtml('ep-cht', 3)}
                ${this._tempGaugeHtml('ep-cht', 4)}
            </div>

            <!-- Section 3b: EGT Trend chart -->
            <div class="ep-chart-header">
                <span class="ep-section-title">EGT TREND</span>
                <select class="ep-chart-select" id="ep-chart-dur">
                    <option value="5">5 min</option>
                    <option value="10">10 min</option>
                    <option value="15">15 min</option>
                    <option value="30" selected>30 min</option>
                    <option value="60">60 min</option>
                    <option value="120">120 min</option>
                </select>
            </div>
            <div class="ep-chart-wrap">
                <canvas id="ep-egt-canvas"></canvas>
            </div>

            <!-- Section 4b: CHT Trend chart -->
            <div class="ep-chart-header">
                <span class="ep-section-title">CHT TREND</span>
                <select class="ep-chart-select" id="ep-cht-chart-dur">
                    <option value="5">5 min</option>
                    <option value="10">10 min</option>
                    <option value="15">15 min</option>
                    <option value="30" selected>30 min</option>
                    <option value="60">60 min</option>
                    <option value="120">120 min</option>
                </select>
            </div>
            <div class="ep-chart-wrap">
                <canvas id="ep-cht-canvas"></canvas>
            </div>

            <!-- Section 5: Fuel -->
            <div class="ep-section-title">FUEL STATUS</div>
            <div class="ep-section ep-fuel-row">
                ${this._gaugeHtml('ep-fuel-rem',  'REMAINING',   '--.-', 'GAL')}
                ${this._gaugeHtml('ep-fuel-used', 'USED (FLIGHT)','--.-','GAL')}
                ${this._gaugeHtml('ep-fuel-end',  'ENDURANCE',   '-:--', 'H:MM')}
                ${this._gaugeHtml('ep-fuel-rng',  'RANGE',       '---',  'NM')}
            </div>
            <div class="ep-fuel-stale" id="ep-fuel-stale" style="display:none;">
                UNCONFIRMED &mdash; TANK STATE NOT UPDATED IN 45+ MIN. REMAINING MAY READ HIGH; CONFIRM FUEL.
            </div>
            <div class="ep-tank-source-note">LEFT/RIGHT below are raw EDM sender readings, not the tracked figure above.</div>
            <div class="ep-fuel-tanks">
                <div class="ep-tank">
                    <div class="ep-tank-label">LEFT (EDM SENDER)</div>
                    <div class="ep-tank-bar-wrap"><div class="ep-tank-bar" id="ep-tank-l"></div></div>
                    <div class="ep-tank-val" id="ep-tank-l-val">--.-</div>
                </div>
                <div class="ep-tank">
                    <div class="ep-tank-label">RIGHT (EDM SENDER)</div>
                    <div class="ep-tank-bar-wrap"><div class="ep-tank-bar" id="ep-tank-r"></div></div>
                    <div class="ep-tank-val" id="ep-tank-r-val">--.-</div>
                </div>
            </div>
            <div class="ep-fuel-bar-container">
                <div class="ep-fuel-bar" id="ep-fuel-bar"></div>
                <span class="ep-fuel-bar-label" id="ep-fuel-bar-label">--% (--/-- gal)</span>
            </div>

            <!-- TIC vs EDM variance row -->
            <div class="ep-tic-edm-row" id="ep-tic-edm-row" style="display:none;">
                <span class="ep-tic-edm-label">TIC vs EDM</span>
                <span class="ep-tic-edm-item">TIC: <span id="ep-tic-total">--</span></span>
                <span class="ep-tic-edm-item">EDM: <span id="ep-edm-total">--</span></span>
                <span class="ep-tic-edm-item">\u0394: <span id="ep-tic-var">--</span></span>
                <span class="ep-tic-edm-grade" id="ep-tic-grade">--</span>
            </div>

            <!-- Section 6: Efficiency -->
            <div class="ep-efficiency" id="ep-efficiency">-- GPH @ -- kts = -- nm/gal</div>

            <!-- Section 7: Flight data -->
            <div class="ep-section-title">FLIGHT DATA</div>
            <div class="ep-section ep-flight-row">
                ${this._gaugeHtml('ep-alt',  'ALT MSL',   '-----', 'ft')}
                ${this._gaugeHtml('ep-da',   'DENS ALT',  '-----', 'ft')}
                ${this._gaugeHtml('ep-oat',  'OAT',       '--',    '\u00B0C')}
                ${this._gaugeHtml('ep-gs',   'GND SPD',   '---',   'kts')}
                ${this._gaugeHtml('ep-tas',  'EST. TAS',  '---',   'kts')}
            </div>
            <div class="ep-tas-note">TAS is estimated from ground speed + density altitude (no wind correction) \u2014 not a pitot-derived airspeed.</div>

            <!-- Section 7.5: Cruise targets (recommended power/mixture for current density altitude) -->
            <div class="ep-section-title">CRUISE TARGETS</div>
            <div class="ep-section ep-target-row">
                ${this._gaugeHtml('ep-target-ff',   'TARGET FF',  '--.-', 'GPH')}
                ${this._gaugeHtml('ep-target-pwr',  'TARGET PWR', '--',   '%')}
                ${this._gaugeHtml('ep-target-mode', 'MODE',       '---',  '')}
            </div>

            <!-- Section 7.6: ATIS manual override for altimeter/OAT (feeds density alt + TAS calcs above) -->
            <div class="ep-section-title">ATIS OVERRIDE</div>
            <div class="ep-atis-panel">
                <div class="ep-atis-row">
                    <span class="ep-atis-label">ALTIMETER (inHg)</span>
                    <input type="number" class="ep-atis-input" id="ep-atis-alt-input" placeholder="29.92" min="27" max="32" step="0.01" inputmode="decimal">
                    <button class="ep-atis-btn ep-atis-set-btn" id="ep-atis-alt-set">SET</button>
                    <button class="ep-atis-btn ep-atis-clear-btn" id="ep-atis-alt-clear">CLEAR</button>
                </div>
                <div class="ep-atis-row">
                    <span class="ep-atis-label">OAT (°C)</span>
                    <input type="number" class="ep-atis-input" id="ep-atis-oat-input" placeholder="15" min="-40" max="50" step="1" inputmode="decimal">
                    <button class="ep-atis-btn ep-atis-set-btn" id="ep-atis-oat-set">SET</button>
                    <button class="ep-atis-btn ep-atis-clear-btn" id="ep-atis-oat-clear">CLEAR</button>
                </div>
                <div class="ep-atis-status" id="ep-atis-status">Using calculated OAT / altimeter</div>
            </div>

            <!-- Section 8: Recording indicator -->
            <div class="ep-rec-row" id="ep-rec-row" style="display:none;">
                <span class="ep-rec-dot"></span>
                <span class="ep-rec-label" id="ep-rec-label">REC 0 pts 0:00:00</span>
            </div>

        </div>`;

        this.container.appendChild(this._el);

        // Start background tick immediately so EGT/CHT trend history accumulates
        // even before the engine page is first opened.
        this._tick();

        // Wire close button — touchstart + click for Android touch reliability
        wireTap(this._el.querySelector('#ep-close'), () => this.hide());

        // Wire capture stop button
        wireTap(this._el.querySelector('#ep-capture-stop'), () => this._stopCapture());

        // Wire sticky-valve dismiss
        wireTap(this._el.querySelector('#ep-sticky-dismiss'), () => {
            this._stickyDismissed = true;
            this._el.querySelector('#ep-sticky-banner').style.display = 'none';
        });

        // Wire ATIS override controls
        // SET must never fall through to CLEAR semantics — an empty/unparseable
        // input is a no-op (with a status hint), not a null POST. See _setAtis,
        // which is also called directly by CLEAR with an explicit null and must
        // keep accepting that.
        const atisAltInput = this._el.querySelector('#ep-atis-alt-input');
        const atisOatInput = this._el.querySelector('#ep-atis-oat-input');
        const wireAtisSet = (btn, input, key) => {
            wireTap(btn, () => {
                if (input.value === '') {
                    this._atisStatusError('Enter a value first');
                    return;
                }
                this._setAtis(key, input.value);
            });
        };
        wireAtisSet(this._el.querySelector('#ep-atis-alt-set'), atisAltInput, 'altimeter');
        wireAtisSet(this._el.querySelector('#ep-atis-oat-set'), atisOatInput, 'oat');
        wireTap(this._el.querySelector('#ep-atis-alt-clear'), () => { atisAltInput.value = ''; this._setAtis('altimeter', null); });
        wireTap(this._el.querySelector('#ep-atis-oat-clear'), () => { atisOatInput.value = ''; this._setAtis('oat', null); });

        // Wire chart duration selectors
        this._el.querySelector('#ep-chart-dur').addEventListener('change', (e) => {
            this._cfg.trendChartMinutes = parseInt(e.target.value, 10) || 30;
            this._el.querySelector('#ep-cht-chart-dur').value = e.target.value;
            this._renderEgtChart();
            this._renderChtChart();
        });
        this._el.querySelector('#ep-cht-chart-dur').addEventListener('change', (e) => {
            this._cfg.trendChartMinutes = parseInt(e.target.value, 10) || 30;
            this._el.querySelector('#ep-chart-dur').value = e.target.value;
            this._renderEgtChart();
            this._renderChtChart();
        });

        // Canvas references
        this._canvas = this._el.querySelector('#ep-egt-canvas');
        this._chtCanvas = this._el.querySelector('#ep-cht-canvas');

        // Cache frequently-accessed DOM elements
        this._dom = {
            dataAge: this._el.querySelector('#ep-data-age'),
            mix: this._el.querySelector('#ep-mix'),
            fuelBar: this._el.querySelector('#ep-fuel-bar'),
            fuelRem: this._el.querySelector('#ep-fuel-rem'),
            fuelStale: this._el.querySelector('#ep-fuel-stale'),
            stickyBanner: this._el.querySelector('#ep-sticky-banner'),
            stickyCyl: this._el.querySelector('#ep-sticky-cyl'),
            contractBanner: this._el.querySelector('#ep-contract-banner'),
            contractRequired: this._el.querySelector('#ep-contract-required'),
            contractPiVersion: this._el.querySelector('#ep-contract-pi-version'),
            contractPiContract: this._el.querySelector('#ep-contract-pi-contract'),
            recRow: this._el.querySelector('#ep-rec-row'),
            captureStatus: this._el.querySelector('#ep-capture-status'),
            captureStop: this._el.querySelector('#ep-capture-stop'),
            egtChartDur: this._el.querySelector('#ep-chart-dur'),
            chtChartDur: this._el.querySelector('#ep-cht-chart-dur'),
            ticEdmRow: this._el.querySelector('#ep-tic-edm-row'),
            ticTotal: this._el.querySelector('#ep-tic-total'),
            edmTotal: this._el.querySelector('#ep-edm-total'),
            ticVar: this._el.querySelector('#ep-tic-var'),
            ticGrade: this._el.querySelector('#ep-tic-grade'),
            atisStatus: this._el.querySelector('#ep-atis-status'),
        };
        // Cache per-cylinder elements
        for (let i = 1; i <= 4; i++) {
            this._dom[`egtPeak${i}`] = this._el.querySelector(`#ep-egt-${i}-peak`);
            this._dom[`chtSpread${i}`] = this._el.querySelector(`#ep-cht-${i}-spread`);
        }
    }

    /* Helper: standard gauge cell */
    _gaugeHtml(id, label, placeholder, unit) {
        return `<div class="ep-gauge">
            <div class="ep-gauge-label">${label}</div>
            <div class="ep-gauge-value" id="${id}">${placeholder}</div>
            ${unit ? `<div class="ep-gauge-unit">${unit}</div>` : ''}
        </div>`;
    }

    /* Helper: temperature gauge with trend + peak delta */
    _tempGaugeHtml(prefix, num) {
        return `<div class="ep-temp-gauge">
            <div class="ep-gauge-label">${prefix === 'ep-egt' ? 'EGT' : 'CHT'} ${num}</div>
            <div class="ep-temp-value-row">
                <span class="ep-gauge-value" id="${prefix}-${num}">----</span>
                <span class="ep-trend-arrow" id="${prefix}-${num}-trend"></span>
            </div>
            ${prefix === 'ep-egt' ? `<div class="ep-peak-delta" id="${prefix}-${num}-peak">--</div>` : `<div class="ep-spread-val" id="${prefix}-${num}-spread"></div>`}
        </div>`;
    }

    /* ------------------------------------------------------------------
     * Show / Hide
     * ----------------------------------------------------------------*/
    show() {
        this._loadConfig();
        this._el.style.display = 'flex';
        this._visible = true;
        // Tick is already running from _buildDom(); no-op if already started.
        if (!this._rafId) this._tick();
    }

    hide() {
        // Only hide the display — keep the RAF loop running so the graph
        // continues accumulating data while the map page is shown.
        this._el.style.display = 'none';
        this._visible = false;
        // Notify tab bar so it can sync its active state back to map
        if (this.onClose) this.onClose();
    }

    get visible() { return this._visible; }

    /* ------------------------------------------------------------------
     * Config
     * ----------------------------------------------------------------*/
    _loadConfig() {
        try {
            if (typeof CockpitConfig !== 'undefined' && CockpitConfig.get) {
                const c = CockpitConfig.get('enginePage');
                if (c) Object.assign(this._cfg, c);
            }
        } catch (_) { /* ignore */ }

        // Aircraft-level values come from aircraft-config.json, the single source of
        // truth for the airframe (the aircraft page edits it). Applied AFTER the
        // enginePage block on purpose: a UI-preferences key must not be able to fork
        // the airframe's real fuel capacity. Falls back to the constructor defaults.
        try {
            if (typeof CockpitConfig !== 'undefined' && CockpitConfig.aircraft) {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) this._cfg.fuelCapacity = cap;
                const senderLimit = CockpitConfig.aircraft('performance.fuel_sender_accurate_below_gal');
                if (senderLimit > 0) this._cfg.senderAccurateBelowGal = senderLimit;
            }
        } catch (_) { /* keep fallbacks */ }

        // Sync both dropdowns to config
        const durStr = String(this._cfg.trendChartMinutes);
        if (this._dom.egtChartDur) this._dom.egtChartDur.value = durStr;
        if (this._dom.chtChartDur) this._dom.chtChartDur.value = durStr;
    }

    /* ------------------------------------------------------------------
     * Animation loop -- reads EnginePanel.lastData
     * ----------------------------------------------------------------*/
    _tick() {
        // Keep running even when hidden so graph data accumulates continuously.

        // Read from EnginePanel singleton
        let data = null;
        let pollTime = 0;
        try {
            const panel = window.enginePanel;
            if (panel) { data = panel.lastData; pollTime = panel.lastPollTime; }
        } catch (_) { /* */ }

        this._updateDataAge(data, pollTime);
        if (data) this.update(data);

        this._rafId = requestAnimationFrame(() => {
            // Throttle to ~1 Hz
            this._timeoutId = setTimeout(() => this._tick(), 1000);
        });
    }

    _updateDataAge(data, pollTime) {
        const el = this._dom.dataAge;
        const container = this._el.querySelector('.ep-container');
        if (!el) return;

        if (!data || pollTime === 0) {
            el.textContent = 'ENGINE MON. OFFLINE';
            el.className = 'ep-data-age ep-data-age--offline';
            if (container) container.classList.add('ep-stale');
            return;
        }

        if (container) container.classList.remove('ep-stale');
        const ageSec = Math.round((Date.now() - pollTime) / 1000);
        if (ageSec <= 5) {
            el.textContent = 'LIVE';
            el.className = 'ep-data-age ep-data-age--live';
        } else {
            el.textContent = `${ageSec}s ago`;
            el.className = 'ep-data-age ep-data-age--stale';
        }
    }

    /* ------------------------------------------------------------------
     * update(data) -- master render
     * ----------------------------------------------------------------*/
    update(data) {
        if (!data) return;
        const d = data;

        /* -- Normalize field names (API may use snake_case or PascalCase) -- */
        const rpm       = d.rpm       ?? d.RPM       ?? 0;
        const mp        = d.mp        ?? d.MP        ?? 0;
        const fuelFlow  = d.fuel_flow ?? d.Fuel_Flow ?? d.fuel_flow_gph ?? 0;
        const oilTemp   = d.oil_temp  ?? d.Oil_Temp  ?? d.oil_temp_f    ?? 0;
        const oilPress  = d.oil_press ?? d.Oil_Press ?? d.oil_press_psi ?? 0;
        const volts     = d.volts     ?? d.Volts     ?? 0;
        const carbTemp  = d.carb_temp ?? d.Carb_Temp ?? 0;

        const egt = [
            d.egt1 ?? d.EGT1 ?? 0,
            d.egt2 ?? d.EGT2 ?? 0,
            d.egt3 ?? d.EGT3 ?? 0,
            d.egt4 ?? d.EGT4 ?? 0,
        ];
        const cht = [
            d.cht1 ?? d.CHT1 ?? 0,
            d.cht2 ?? d.CHT2 ?? 0,
            d.cht3 ?? d.CHT3 ?? 0,
            d.cht4 ?? d.CHT4 ?? 0,
        ];

        const percentPower = d.percent_power ?? d.Final_Percent_Power ?? 0;
        const opCond       = d.operating_condition ?? d.Operating_Condition ?? '---';
        const ropLop       = d.rop_lop_percent ?? d.Percent ?? 0;
        const sfc          = d.sfc ?? d.SFC ?? 0;

        const altMsl    = d.altitude_ft ?? d.gps_altitude ?? 0;
        const densAlt   = d.density_altitude ?? 0;
        const oat       = d.oat ?? 0;
        const gs        = d.speed_kts ?? d.ground_speed ?? 0;

        // Canonical live fuel read (manual override > tracked tank state > capacity).
        // A `capacity` source means nothing is actually being tracked — it is a planning
        // default, not a measurement. Showing full tanks on a live instrument would tell
        // the pilot there is more fuel than is known to exist, so fall through to this
        // page's existing "no data" placeholders instead.
        const fuelRead = (typeof FuelState !== 'undefined')
            ? FuelState.getCurrentFuel()
            : { gallons: 0, source: 'none' };
        // The SOURCE, not the number, decides whether this panel has fuel data at all.
        // Gating on `gallonsRem > 0` conflated two different states: "nothing is being
        // tracked" and "the tanks are dry". Those must never render the same on a fuel
        // instrument, so every sink below gates on `fuelTracked` instead.
        const fuelTracked = (fuelRead.source === 'manual' || fuelRead.source === 'tank_state');
        const gallonsRem = fuelTracked ? fuelRead.gallons : 0;
        // DECISION (2026-07-31, Dana): a tracked figure that FuelTankState considers
        // stale (>45 min since the last integrated sample, i.e. needsConfirmation())
        // is still SHOWN, but explicitly marked unconfirmed. Rationale: blanking it
        // would throw away the pilot's last known-good quantity at exactly the moment
        // he most needs a starting point, while showing it unmarked would let a number
        // that has not been updated in 45+ minutes read as a live measurement. The
        // stale figure always reads HIGH (fuel burned during the gap is not
        // subtracted), so it must never be presented as a measurement.
        // The predicate itself lives on FuelState.getCurrentFuel() (SDD Task 14) so
        // this page, the instrument strip and the route table cannot disagree about
        // whether a figure is trustworthy; it is already false for `manual` (the
        // pilot's own entry) and `capacity` (nothing tracked).
        const fuelStale = !!fuelRead.stale;
        // The EDM's own totalizer (EDM field 12). Used ONLY by the TIC vs EDM
        // cross-check row below, whose whole purpose is to surface disagreement
        // between the tic-mark measurement and the EDM — it must stay an EDM read.
        const edmFuelRem = d.gallons_rem ?? d.fuel_remaining_gal ?? d.Gallons_Rem ?? d.Fuel_Remaining ?? d.fuel_remaining ?? 0;
        // engine_monitor.get_status() nests the Pi fuel tracker under `fuel`;
        // there is no top-level flight_fuel_used.
        const fuelUsed   = d.fuel?.flight_fuel_used ?? 0;
        const fuelL      = d.fuel_l1 ?? d.Fuel_L1 ?? d.Fuel_Left ?? d.edm_fuel_left ?? 0;
        const fuelR      = d.fuel_l2 ?? d.Fuel_L2 ?? d.Fuel_Right ?? d.edm_fuel_right ?? 0;

        /* ---- Section 1: Primary gauges ---- */
        this._setText('ep-rpm', Math.round(rpm));
        this._setText('ep-map', mp > 0 ? mp.toFixed(1) : '--.-');
        this._setText('ep-ff',  fuelFlow > 0 ? fuelFlow.toFixed(1) : '--.-');

        this._setTextColored('ep-oilt', Math.round(oilTemp),
            oilTemp >= this._cfg.oilTempDanger ? 'danger' :
            oilTemp >= this._cfg.oilTempCaution ? 'caution' : 'normal');

        this._setTextColored('ep-oilp', Math.round(oilPress),
            oilPress <= this._cfg.oilPressLow ? 'danger' :
            oilPress >= this._cfg.oilPressDanger ? 'danger' :
            oilPress <= this._cfg.oilPressCautionLow ? 'caution' :
            oilPress >= this._cfg.oilPressCautionHigh ? 'caution' : 'normal');

        this._setText('ep-volts', volts > 0 ? volts.toFixed(1) : '--.-');

        // Carb temp -- icing range roughly 20-70F (or -7 to 21 C), we use F thresholds
        const carbDanger  = carbTemp > 0 && carbTemp <= 32;   // at or below freezing
        const carbCaution = carbTemp > 32 && carbTemp <= 70;  // icing range
        this._setTextColored('ep-carb', Math.round(carbTemp),
            carbDanger ? 'danger' : carbCaution ? 'caution' : 'normal');

        /* ---- Section 2: Engine analysis ---- */
        this._setText('ep-pwr', percentPower > 0 ? Math.round(percentPower) + '%' : '--');

        if (this._dom.mix) {
            this._dom.mix.textContent = opCond;
            this._dom.mix.className = 'ep-gauge-value' +
                (opCond === 'RICH' ? ' ep-rich' :
                 opCond === 'LEAN' ? ' ep-lean' :
                 opCond === 'PEAK' ? ' ep-peak' : '');
        }

        this._setText('ep-dev', ropLop > 0 ? ropLop.toFixed ? ropLop.toFixed(1) : ropLop : '--');
        this._setText('ep-bsfc', sfc > 0 ? (typeof sfc === 'number' ? sfc.toFixed(2) : sfc) : '--');

        /* ---- Section 3: EGT ---- */
        for (let i = 0; i < 4; i++) {
            const val = egt[i];
            this._setTextColored(`ep-egt-${i + 1}`, val > 0 ? Math.round(val) : '----',
                val >= this._cfg.egtDanger ? 'danger' :
                val >= this._cfg.egtCaution ? 'caution' : 'normal');

            // Trend arrow
            const diff = val - this._prevEgt[i];
            this._setTrend(`ep-egt-${i + 1}-trend`, diff);

            // Peak delta (from data if available)
            const peakKey = `degrees_from_peak_${i + 1}`;
            const peakVal = d[peakKey] ?? (d.degrees_from_peak ? d.degrees_from_peak[i] : null);
            const peakEl = this._dom[`egtPeak${i + 1}`];
            if (peakEl) {
                if (peakVal != null && peakVal !== 0) {
                    const sign = peakVal > 0 ? '+' : '';
                    peakEl.textContent = sign + Math.round(peakVal) + '\u00B0';
                    peakEl.className = 'ep-peak-delta' +
                        (peakVal < -20 ? ' ep-lop' : peakVal > 0 ? ' ep-rop' : ' ep-at-peak');
                } else {
                    peakEl.textContent = '--';
                    peakEl.className = 'ep-peak-delta ep-no-peak';
                }
            }
        }
        this._prevEgt = [...egt];

        /* ---- Section 4: CHT ---- */
        const chtVals = cht.filter(v => v > 0);
        const chtSpread = chtVals.length >= 2 ? Math.max(...chtVals) - Math.min(...chtVals) : 0;
        for (let i = 0; i < 4; i++) {
            const val = cht[i];
            this._setTextColored(`ep-cht-${i + 1}`, val > 0 ? Math.round(val) : '---',
                val >= this._cfg.chtDanger ? 'danger' :
                val >= this._cfg.chtCaution ? 'caution' : 'normal');

            const diff = val - this._prevCht[i];
            this._setTrend(`ep-cht-${i + 1}-trend`, diff);

            const spreadEl = this._dom[`chtSpread${i + 1}`];
            if (spreadEl) {
                spreadEl.textContent = chtSpread > 0 ? `\u0394${chtSpread}\u00B0` : '';
            }
        }
        this._prevCht = [...cht];

        /* ---- Record trend history (circular buffer) ---- */
        const now = Date.now();
        const entry = { ts: now, egt: [...egt], cht: [...cht] };
        if (this._trendLen < this._trendMaxPts) {
            this._trendHistory.push(entry);
            this._trendLen++;
        } else {
            this._trendHistory[this._trendHead] = entry;
            this._trendHead = (this._trendHead + 1) % this._trendMaxPts;
        }

        /* ---- Section 5: Fuel ---- */
        this._setText('ep-fuel-rem', fuelTracked ? gallonsRem.toFixed(1) : '--.-');
        this._setText('ep-fuel-used', fuelUsed > 0 ? fuelUsed.toFixed(1) : '--.-');
        if (this._dom.fuelRem) {
            this._dom.fuelRem.className = 'ep-gauge-value' + (fuelStale ? ' ep-unconfirmed' : '');
        }
        if (this._dom.fuelStale) {
            this._dom.fuelStale.style.display = fuelStale ? '' : 'none';
        }

        if (fuelFlow > 0 && fuelTracked) {
            const endH = gallonsRem / fuelFlow;
            const h = Math.floor(endH);
            const m = Math.round((endH - h) * 60);
            this._setText('ep-fuel-end', `${h}:${String(m).padStart(2, '0')}`);
        } else {
            this._setText('ep-fuel-end', '-:--');
        }

        if (gs > 0 && fuelFlow > 0 && fuelTracked) {
            const nmpg = gs / fuelFlow;
            this._setText('ep-fuel-rng', Math.round(gallonsRem * nmpg));
        } else {
            this._setText('ep-fuel-rng', '---');
        }

        // Tank bars — these are RAW EDM SENDER readings, a different (and less
        // trustworthy) source than the tracked REMAINING figure above, so they are
        // labelled as such in the UI and can legitimately disagree with it. Same
        // suppression rule as fuel-tanks.js `_updateSenderDisplay`: above the
        // configured accurate-below level the sender reads a flat/invalid value and
        // must not be shown as if it were a real cross-check.
        const cap = this._cfg.fuelCapacity;
        const halfCap = cap / 2;
        const senderLimit = this._cfg.senderAccurateBelowGal;
        let trackedTanks = null;
        try {
            if (typeof FuelTankState !== 'undefined') trackedTanks = FuelTankState.getState();
        } catch (_) { trackedTanks = null; }
        const lSenderValid = !trackedTanks || trackedTanks.left_gal <= senderLimit;
        const rSenderValid = !trackedTanks || trackedTanks.right_gal <= senderLimit;
        this._setTankBar('ep-tank-l', fuelL, halfCap, !lSenderValid);
        this._setTankBar('ep-tank-r', fuelR, halfCap, !rSenderValid);
        this._setText('ep-tank-l-val', !lSenderValid ? '—'
            : (fuelL > 0 ? fuelL.toFixed(1) + ' gal' : '--.-'));
        this._setText('ep-tank-r-val', !rSenderValid ? '—'
            : (fuelR > 0 ? fuelR.toFixed(1) + ' gal' : '--.-'));

        // Fuel bar — driven by the same canonical read as REMAINING. With no tracked
        // state there is no percentage to draw: empty bar, placeholder label, and NO
        // caution/warning colour (an untracked panel is not a low-fuel condition).
        const fuelPct = (fuelTracked && cap > 0) ? Math.min(100, (gallonsRem / cap) * 100) : 0;
        if (this._dom.fuelBar) {
            this._dom.fuelBar.style.width = fuelPct + '%';
            this._dom.fuelBar.className = 'ep-fuel-bar' + (!fuelTracked ? '' :
                gallonsRem <= this._cfg.fuelWarningGal ? ' critical' :
                gallonsRem <= this._cfg.fuelCautionGal ? ' low' : '');
        }
        this._setText('ep-fuel-bar-label', fuelTracked
            ? `${Math.round(fuelPct)}% (${gallonsRem.toFixed(1)}/${cap} gal)`
            : `--% (--.-/${cap} gal)`);

        /* ---- TIC vs EDM variance ---- */
        this._updateTicEdm(edmFuelRem);

        /* ---- Section 6: Efficiency ---- */
        if (fuelFlow > 0 && gs > 40) {
            const nmpg = gs / fuelFlow;
            this._setText('ep-efficiency',
                `${fuelFlow.toFixed(1)} GPH @ ${Math.round(gs)} kts = ${nmpg.toFixed(1)} nm/gal`);
        } else {
            this._setText('ep-efficiency', '-- GPH @ -- kts = -- nm/gal');
        }

        /* ---- Section 7: Flight data ---- */
        this._setText('ep-alt', altMsl > 0 ? Math.round(altMsl) : '-----');
        this._setText('ep-da',  densAlt !== 0 ? Math.round(densAlt) : '-----');
        this._setText('ep-oat', oat !== 0 ? Math.round(oat) : '--');
        this._setText('ep-gs',  gs > 0 ? Math.round(gs) : '---');
        this._setText('ep-tas', d.tas ? Math.round(d.tas) : '---');

        /* ---- Section 7.5: Cruise targets ---- */
        this._setText('ep-target-ff',   d.target_fuel_flow ? d.target_fuel_flow.toFixed(1) : '--.-');
        this._setText('ep-target-pwr',  d.target_power || '--');
        this._setText('ep-target-mode', d.target_mode || '---');
        this._updateAtisStatus(d);

        /* ---- Section 8: Recording indicator ---- */
        this._updateRecording(d);

        /* ---- Section 9: Sticky valve check ---- */
        this._checkStickyValve(rpm, egt);

        /* ---- Section 10: Pi contract check (#113) ---- */
        this._checkPiContract(d);

        /* ---- Render trend charts ---- */
        this._renderEgtChart();
        this._renderChtChart();
    }

    /* ------------------------------------------------------------------
     * Sticky valve detection (mirrors capture_v5 logic)
     * ----------------------------------------------------------------*/
    _checkStickyValve(rpm, egt) {
        const now = Date.now() / 1000; // seconds

        // Detect engine start
        if (this._engineStartTime === null) {
            if (rpm > 500) {
                this._engineStartTime = now;
                this._stickyStartTimes = [null, null, null, null];
                this._stickyAlert = null;
                this._stickyDismissed = false;
            }
            return;
        }

        // Engine stopped?
        if (rpm < 300) {
            this._engineStartTime = null;
            this._stickyStartTimes = [null, null, null, null];
            return;
        }

        // Only during warmup
        const elapsed = (now - this._engineStartTime) / 60;
        if (elapsed > this._cfg.stickyValveWarmupMin) {
            this._showStickyBanner();
            return;
        }

        const avgAll = egt.reduce((a, b) => a + b, 0) / 4;
        if (avgAll < this._cfg.stickyValveMinEgt) {
            this._showStickyBanner();
            return;
        }

        for (let i = 0; i < 4; i++) {
            const others = egt.filter((_, j) => j !== i);
            const avgOthers = others.reduce((a, b) => a + b, 0) / 3;
            if (avgOthers < this._cfg.stickyValveMinEgt) continue;

            const ratio = avgOthers > 0 ? egt[i] / avgOthers : 1;
            if (ratio < this._cfg.stickyValveEgtRatio) {
                if (this._stickyStartTimes[i] === null) this._stickyStartTimes[i] = now;
                if (now - this._stickyStartTimes[i] >= this._cfg.stickyValvePersistSec) {
                    this._stickyAlert = i + 1;
                }
            } else {
                if (this._stickyAlert === i + 1) this._stickyAlert = null;
                this._stickyStartTimes[i] = null;
            }
        }

        this._showStickyBanner();
    }

    _showStickyBanner() {
        if (this._stickyAlert && !this._stickyDismissed) {
            this._dom.stickyCyl.textContent = this._stickyAlert;
            this._dom.stickyBanner.style.display = 'flex';
        } else {
            this._dom.stickyBanner.style.display = 'none';
        }
    }

    /**
     * Pi contract mismatch banner (#113). Gated on a LIVE connection, not just
     * whatever the last cached reading happened to report — same rule as
     * EngineClient.piContractOld, so this banner and the status-bar badge
     * never disagree about whether a warning is currently showing. Engine
     * data keeps displaying regardless; this only ever adds a banner, never
     * blocks anything.
     */
    _checkPiContract(d) {
        if (!this._dom.contractBanner) return;
        const connected = window.enginePanel?.connected === true;
        const contract = d.api_contract ?? 0;
        const isOld = connected && contract < EngineClient.MIN_PI_CONTRACT;
        if (isOld) {
            this._dom.contractRequired.textContent = EngineClient.MIN_PI_CONTRACT;
            this._dom.contractPiVersion.textContent = d.version ?? '?';
            this._dom.contractPiContract.textContent = contract;
            this._dom.contractBanner.style.display = 'flex';
        } else {
            this._dom.contractBanner.style.display = 'none';
        }
    }

    /* ------------------------------------------------------------------
     * TIC vs EDM variance display
     * ----------------------------------------------------------------*/
    _updateTicEdm(edmFuel) {
        const row = this._dom.ticEdmRow;
        if (!row) return;

        // Only show when we have both a saved tic measurement and live EDM data
        const measurement = typeof Settings !== 'undefined' ? Settings.fuelMeasurement : null;
        if (!measurement || !measurement.total_gal || edmFuel <= 0) {
            row.style.display = 'none';
            return;
        }

        row.style.display = 'flex';
        const ticTotal = measurement.total_gal;
        const variance = ticTotal - edmFuel;
        const variancePct = Math.abs(variance / edmFuel * 100);
        const grade = typeof FuelEngine !== 'undefined'
            ? FuelEngine.getAccuracyGrade(variancePct) : 'check';

        this._dom.ticTotal.textContent = ticTotal.toFixed(1);
        this._dom.edmTotal.textContent = edmFuel.toFixed(1);
        this._dom.ticVar.textContent = (variance > 0 ? '+' : '') + variance.toFixed(1);
        this._dom.ticGrade.textContent = grade.toUpperCase();
        this._dom.ticGrade.className = 'ep-tic-edm-grade ep-grade-' + grade;
    }

    /* ------------------------------------------------------------------
     * Trend history helpers (circular buffer)
     * ----------------------------------------------------------------*/
    _getTrendPoints(cutoffMs) {
        const pts = [];
        for (let i = 0; i < this._trendLen; i++) {
            const idx = (this._trendHead + i) % this._trendMaxPts;
            const p = this._trendHistory[idx];
            if (p.ts >= cutoffMs) pts.push(p);
        }
        return pts;
    }

    /* ------------------------------------------------------------------
     * Shared trend chart renderer
     * ----------------------------------------------------------------*/
    _renderTrendChart(canvas, dataKey, legendPrefix, minRangePad) {
        if (!canvas) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = rect.width;
        const h = rect.height;
        if (w === 0 || h === 0) return;

        canvas.width  = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width  = w + 'px';
        canvas.style.height = h + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);

        const windowMs = this._cfg.trendChartMinutes * 60 * 1000;
        const now = Date.now();
        const cutoff = now - windowMs;
        const pts = this._getTrendPoints(cutoff);
        if (pts.length < 2) {
            ctx.fillStyle = '#555';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Waiting for data...', w / 2, h / 2);
            return;
        }

        // Determine Y range
        let minY = Infinity, maxY = -Infinity;
        for (const p of pts) {
            const vals = p[dataKey];
            for (let i = 0; i < 4; i++) {
                if (vals[i] > 0) {
                    if (vals[i] < minY) minY = vals[i];
                    if (vals[i] > maxY) maxY = vals[i];
                }
            }
        }
        if (minY === Infinity) return;
        const range = Math.max(maxY - minY, minRangePad);
        minY = Math.floor((minY - range * 0.1) / 10) * 10;
        maxY = Math.ceil((maxY + range * 0.1) / 10) * 10;

        const padL = 44, padR = 8, padT = 8, padB = 20;
        const plotW = w - padL - padR;
        const plotH = h - padT - padB;

        // Grid lines
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        const ySteps = 5;
        for (let i = 0; i <= ySteps; i++) {
            const y = padT + (plotH * i / ySteps);
            ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
            const val = maxY - (maxY - minY) * (i / ySteps);
            ctx.fillStyle = '#888';
            ctx.font = '10px monospace';
            ctx.textAlign = 'right';
            ctx.fillText(Math.round(val), padL - 4, y + 3);
        }

        // Time labels
        ctx.fillStyle = '#888';
        ctx.font = '10px monospace';
        ctx.textAlign = 'center';
        const tSteps = 4;
        for (let i = 0; i <= tSteps; i++) {
            const t = cutoff + windowMs * (i / tSteps);
            const x = padL + plotW * (i / tSteps);
            const d = new Date(t);
            ctx.fillText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, x, h - 2);
        }

        // Line colors per cylinder
        const colors = ['#00d4ff', '#00ff88', '#ffaa00', '#ff4466'];

        for (let cyl = 0; cyl < 4; cyl++) {
            ctx.strokeStyle = colors[cyl];
            ctx.lineWidth = 2;
            ctx.beginPath();
            let started = false;
            for (const p of pts) {
                const v = p[dataKey][cyl];
                if (v <= 0) continue;
                const x = padL + plotW * ((p.ts - cutoff) / windowMs);
                const y = padT + plotH * (1 - (v - minY) / (maxY - minY));
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }

        // Legend
        for (let i = 0; i < 4; i++) {
            const lx = padL + 6 + i * 56;
            ctx.fillStyle = colors[i];
            ctx.fillRect(lx, padT + 2, 10, 3);
            ctx.fillStyle = '#ccc';
            ctx.font = '9px monospace';
            ctx.textAlign = 'left';
            ctx.fillText(`${legendPrefix}${i + 1}`, lx + 13, padT + 7);
        }
    }

    _renderEgtChart() { this._renderTrendChart(this._canvas, 'egt', 'EGT', 50); }
    _renderChtChart() { this._renderTrendChart(this._chtCanvas, 'cht', 'CHT', 30); }

    /* ------------------------------------------------------------------
     * Recording indicator
     * ----------------------------------------------------------------*/
    _updateRecording(data) {
        // --- Capture v5 status bar (always visible) ---
        const capturing = data.capturing === true;
        const pts = data.csv_points || 0;
        const elapsed = data.duration || '00:00'; // MM:SS from capture_v5

        if (this._dom.captureStatus) {
            if (capturing) {
                this._dom.captureStatus.textContent = `● REC  ${pts.toLocaleString()} pts  ${elapsed}`;
                this._dom.captureStatus.className = 'ep-capture-status ep-capture-active';
                if (this._dom.captureStop) this._dom.captureStop.disabled = false;
            } else {
                this._dom.captureStatus.textContent = '○ IDLE — not recording';
                this._dom.captureStatus.className = 'ep-capture-status ep-capture-idle';
                if (this._dom.captureStop) this._dom.captureStop.disabled = true;
            }
        }

        // Hide legacy PWA REC row (recording now handled by capture_v5 only)
        if (this._dom.recRow) this._dom.recRow.style.display = 'none';
    }

    async _stopCapture() {
        const btn = this._dom.captureStop;
        if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
        try {
            const base = this._engineBaseUrl();
            if (!base) throw new Error('Engine monitor IP unavailable');
            const resp = await fetch(`${base}/api/stop`, { method: 'POST', signal: AbortSignal.timeout(5000) });
            const data = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
            if (this._dom.captureStatus) {
                const fname = data.csv_filename || '';
                this._dom.captureStatus.textContent = `✓ Saved${fname ? ' → ' + fname : ''}`;
                this._dom.captureStatus.className = 'ep-capture-status ep-capture-saved';

                // Show "Save to Device" download button
                if (fname && window.flightRecorder) {
                    // FlyTab: flight recorder handles CSV on device
                } else if (fname && window.flightSync) {
                    const dlBtn = document.createElement('button');
                    dlBtn.className = 'ep-capture-stop';
                    dlBtn.textContent = '📥 Save to Device';
                    dlBtn.style.color = 'var(--status-ok)';
                    dlBtn.style.borderColor = 'var(--status-ok)';
                    this._dom.captureStatus.parentNode.insertBefore(dlBtn, this._dom.captureStop);
                    wireTap(dlBtn, () => {
                        window.flightSync.downloadToDevice(fname);
                        dlBtn.textContent = '✓ Saved';
                        dlBtn.disabled = true;
                    });
                }
            }
        } catch (err) {
            if (this._dom.captureStatus) {
                this._dom.captureStatus.textContent = `✗ Stop failed: ${err.message}`;
                this._dom.captureStatus.className = 'ep-capture-status ep-capture-idle';
            }
            if (btn) btn.disabled = false;
        }
        if (btn) btn.textContent = 'STOP & SAVE';
    }

    // Shared with fuel-overlay.js via EngineClient.baseUrl() (issue #128) —
    // do not reintroduce a per-file copy of this logic.
    _engineBaseUrl() {
        return EngineClient.baseUrl();
    }

    _atisStatusError(msg) {
        const statusEl = this._dom.atisStatus;
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.className = 'ep-atis-status ep-atis-status--error';
        // Hold this message through the next several update() ticks (~1Hz)
        // so it doesn't get overwritten before the pilot can read it.
        this._atisErrorUntil = Date.now() + 5000;
    }

    async _setAtis(key, rawVal) {
        const val = (rawVal === '' || rawVal === null || rawVal === undefined) ? null : parseFloat(rawVal);
        if (val !== null && Number.isNaN(val)) return;

        // Range-guard non-null values only — CLEAR (val === null) always proceeds.
        if (val !== null) {
            if (key === 'altimeter' && (val < 27.0 || val > 32.0)) {
                this._atisStatusError('Altimeter must be 27.0–32.0 inHg');
                return;
            }
            if (key === 'oat' && (val < -60 || val > 60)) {
                this._atisStatusError('OAT must be -60–60°C');
                return;
            }
        }

        const base = this._engineBaseUrl();
        if (!base) {
            this._atisStatusError('Engine monitor IP unavailable');
            return;
        }

        try {
            // No explicit Content-Type: setting one makes this a non-simple
            // cross-origin request, forcing a CORS preflight (OPTIONS /api/atis)
            // that engine_monitor.py has no handler for -- the preflight fails
            // and the POST never goes out. Without the header, fetch sends the
            // CORS-safelisted text/plain, which the Pi's json.loads(body) parses
            // fine (it never inspects Content-Type).
            const resp = await fetch(`${base}/api/atis`, {
                method: 'POST',
                body: JSON.stringify({ [key]: val }),
                signal: AbortSignal.timeout(5000),
            });
            if (!resp.ok) {
                this._atisStatusError(`✗ ATIS update failed: HTTP ${resp.status}`);
            }
            // On success, the next update() tick's _updateAtisStatus(d) call
            // overwrites this with the Pi's actual manual_altimeter/manual_oat
            // state -- no hand-crafted success message needed here.
        } catch (err) {
            this._atisStatusError(`✗ ATIS update failed: ${err.message}`);
        }
    }

    _updateAtisStatus(d) {
        // An error/hint message is being held on screen -- don't let this
        // tick's normal override/no-override text stomp it before the hold
        // window expires (see _atisStatusError).
        if (Date.now() < this._atisErrorUntil) return;

        const altInput = this._el.querySelector('#ep-atis-alt-input');
        const oatInput = this._el.querySelector('#ep-atis-oat-input');
        const statusEl = this._dom.atisStatus;
        if (!statusEl) return;

        const altOverride = d.manual_altimeter != null;
        const oatOverride = d.manual_oat != null;

        if (altInput && altInput.value === '' && altOverride) altInput.value = d.manual_altimeter;
        if (oatInput && oatInput.value === '' && oatOverride) oatInput.value = d.manual_oat;

        if (!altOverride && !oatOverride) {
            statusEl.textContent = 'Using calculated OAT / altimeter';
            statusEl.className = 'ep-atis-status';
        } else {
            const parts = [];
            if (altOverride) parts.push(`ALT ${d.manual_altimeter} inHg`);
            if (oatOverride) parts.push(`OAT ${d.manual_oat}°C`);
            statusEl.textContent = `ATIS OVERRIDE ACTIVE — ${parts.join(' / ')}`;
            statusEl.className = 'ep-atis-status ep-atis-status--active';
        }
    }

    /* ------------------------------------------------------------------
     * DOM helpers
     * ----------------------------------------------------------------*/
    _setText(id, val) {
        const el = this._el.querySelector('#' + id);
        if (el) el.textContent = val;
    }

    _setTextColored(id, val, level) {
        const el = this._el.querySelector('#' + id);
        if (!el) return;
        el.textContent = val;
        el.className = 'ep-gauge-value' +
            (level === 'danger'  ? ' ep-val-danger' :
             level === 'caution' ? ' ep-val-caution' : '');
    }

    _setTrend(id, diff) {
        const el = this._el.querySelector('#' + id);
        if (!el) return;
        if (Math.abs(diff) < 3) {
            el.textContent = '';
            el.className = 'ep-trend-arrow ep-trend-stable';
        } else if (diff > 0) {
            el.textContent = '\u2191';
            el.className = 'ep-trend-arrow ep-trend-up';
        } else {
            el.textContent = '\u2193';
            el.className = 'ep-trend-arrow ep-trend-down';
        }
    }

    _setTankBar(id, val, max, suppressed = false) {
        const el = this._el.querySelector('#' + id);
        if (!el) return;
        if (suppressed) {
            // Sender out of its accurate range — draw nothing rather than a bar the
            // pilot could read as a level (and never a red "critical" empty bar).
            el.style.height = '0%';
            el.className = 'ep-tank-bar';
            return;
        }
        const pct = max > 0 ? Math.min(100, Math.max(0, (val / max) * 100)) : 0;
        el.style.height = pct + '%';
        el.className = 'ep-tank-bar' +
            (pct <= 15 ? ' critical' : pct <= 30 ? ' low' : '');
    }

    /* ------------------------------------------------------------------
     * Styles
     * ----------------------------------------------------------------*/
    static _css() {
        return `
/* Engine page full-screen overlay */
.engine-page-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    background: var(--bg-primary);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
/* Header bar — flows naturally above scrollable container */
.ep-header {
    flex-shrink: 0;
    padding: calc(6px + env(safe-area-inset-top, 0px)) 10px 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-surface-raised);
    border-bottom: 1px solid var(--border);
}

.ep-container {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    width: 100%;
    max-width: 820px;
    margin: 0 auto;
    padding: 10px 10px 24px;
    position: relative;
}

/* MAP close button */
.ep-close {
    flex-shrink: 0;
    background: var(--bg-surface-raised);
    color: var(--status-danger);
    border: 2px solid var(--status-danger);
    border-radius: 6px;
    font-size:16px;
    font-weight: 900;
    padding: 4px 10px;
    height: 36px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
}
.ep-close:active { opacity: 0.6; }

/* Data age badge */
.ep-data-age {
    font-size:14px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.3px;
    white-space: nowrap;
    flex-shrink: 0;
}
.ep-data-age--live    { color: var(--status-ok); }
.ep-data-age--stale   { color: var(--status-caution); }
.ep-data-age--offline { color: var(--status-danger); background: rgba(255,60,60,0.15); }

/* Stale container: dim all gauge values */
.ep-stale .ep-gauge-value,
.ep-stale .ep-temp-value-row .ep-gauge-value {
    color: var(--text-muted) !important;
}
.ep-stale .ep-primary-row {
    outline: 1px solid var(--status-danger);
    border-radius: 6px;
}

/* Section titles */
.ep-section-title {
    color: var(--text-secondary);
    font-size:16px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 8px 0 4px;
}

/* Primary gauges row -- 7 columns */
.ep-primary-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 4px;
}

/* Analysis row -- 4 columns */
.ep-analysis-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
}

/* EGT / CHT rows -- 4 columns */
.ep-egt-row, .ep-cht-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
}

/* Fuel row -- 4 columns */
.ep-fuel-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
}

/* Flight data row -- 5 columns */
.ep-flight-row {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 4px;
}

/* Cruise targets row -- 3 columns */
.ep-target-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
}

/* ATIS override panel */
.ep-atis-panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 8px;
}
.ep-atis-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
}
.ep-atis-label {
    flex: 1;
    font-family: var(--font-ui);
    font-size: 16px;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
}
.ep-atis-input {
    width: 90px;
    height: var(--touch-min, 56px);
    text-align: center;
    font-size: 18px;
    font-weight: 900;
    font-family: var(--font-instrument);
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 2px solid var(--border-strong);
    border-radius: 6px;
}
.ep-atis-btn {
    height: var(--touch-min, 56px);
    padding: 0 14px;
    border-radius: 6px;
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 800;
    cursor: pointer;
    border: none;
}
.ep-atis-set-btn {
    background: var(--accent);
    color: var(--text-on-accent);
}
.ep-atis-clear-btn {
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 2px solid var(--border-strong);
}
.ep-atis-btn:active { opacity: 0.6; }
.ep-atis-status {
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 700;
    color: var(--text-muted);
    text-align: center;
    margin-top: 4px;
}
.ep-atis-status--active {
    color: var(--accent);
    font-weight: 800;
}
.ep-atis-status--error {
    /* Text on the panel's light --bg-surface fill -- use the light-safe
       equivalent, not the bright --color-danger fill token. */
    color: var(--color-danger-on-light);
    font-weight: 800;
}

.ep-tas-note {
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--text-muted);
    text-align: center;
}

/* Standard gauge cell */
.ep-gauge {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 2px;
    text-align: center;
}
.ep-gauge-label {
    font-size:16px;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
}
.ep-gauge-value {
    font-size: 22px;
    font-weight: 900;
    font-family: var(--font-instrument);
    color: var(--color-success);
    line-height: 1.15;
}
.ep-gauge-unit {
    font-size:16px;
    font-weight: 600;
    color: var(--text-muted);
}

/* Temperature gauge (EGT/CHT) */
.ep-temp-gauge {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 2px;
    text-align: center;
}
.ep-temp-value-row {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 2px;
}
.ep-trend-arrow {
    font-size: 16px;
    font-weight: 900;
}
.ep-trend-up   { color: var(--color-danger); }
.ep-trend-down { color: var(--color-success); }
.ep-trend-stable { color: var(--text-muted); }

/* Peak delta (EGT) */
.ep-peak-delta {
    font-size:16px;
    font-weight: 700;
    margin-top: 1px;
}
.ep-lop     { color: var(--color-info); }
.ep-rop     { color: var(--color-caution); }
.ep-at-peak { color: var(--color-success); }
.ep-no-peak { color: var(--text-muted); }

/* CHT spread */
.ep-spread-val {
    font-size:14px;
    color: var(--text-secondary);
    margin-top: 1px;
}

/* Value color states */
.ep-val-caution { color: var(--color-caution) !important; }
.ep-val-danger  { color: var(--color-danger) !important; }

/* Mixture mode badges */
.ep-rich { color: #f0883e !important; }
.ep-lean { color: var(--color-info) !important; }
.ep-peak { color: var(--color-caution) !important; }

/* Chart area */
.ep-chart-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 8px 0 4px;
}
.ep-chart-select {
    background: var(--bg-surface-raised);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
    font-size:14px;
    font-weight: 600;
}
.ep-chart-wrap {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    height: 200px;
    margin-bottom: 4px;
}
.ep-chart-wrap canvas {
    width: 100%;
    height: 100%;
}

/* Unconfirmed / stale tracked fuel state */
.ep-fuel-stale {
    background: var(--color-caution);
    color: #000;
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: 800;
    text-align: center;
    padding: 6px 8px;
    border-radius: 4px;
    margin: 4px 0;
}
/* --color-caution measures 1.51:1 on this light background — repointed at
   the on-light token, same fix as .fuel-yellow/.fuel-red in style.css. (#120) */
.ep-gauge-value.ep-unconfirmed {
    color: var(--color-caution-on-light) !important;
}
.ep-tank-source-note {
    font-family: var(--font-ui);
    font-size: 13px;
    font-weight: 700;
    color: var(--text-muted);
    text-align: center;
    margin-top: 4px;
}

/* Fuel tank bars */
.ep-fuel-tanks {
    display: flex;
    justify-content: center;
    gap: 24px;
    margin: 6px 0;
}
.ep-tank {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
}
.ep-tank-label {
    font-size:14px;
    font-weight: 700;
    color: var(--text-secondary);
    text-transform: uppercase;
}
.ep-tank-bar-wrap {
    width: 32px;
    height: 50px;
    background: var(--bg-surface-raised);
    border: 1px solid var(--border);
    border-radius: 3px;
    position: relative;
    overflow: hidden;
}
.ep-tank-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: linear-gradient(180deg, var(--color-success), #238636);
    transition: height 0.5s ease;
}
.ep-tank-bar.low      { background: linear-gradient(180deg, var(--color-caution), #9e6a03); }
.ep-tank-bar.critical { background: linear-gradient(180deg, var(--color-danger), #da3633); }
.ep-tank-val {
    font-size:14px;
    font-weight: 700;
    color: var(--text-primary);
    font-family: var(--font-instrument);
}

/* Fuel progress bar */
.ep-fuel-bar-container {
    background: var(--bg-surface-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    height: 20px;
    position: relative;
    margin: 4px 0;
}
.ep-fuel-bar {
    background: linear-gradient(90deg, #238636, var(--color-success));
    height: 100%;
    border-radius: 3px;
    transition: width 0.5s ease;
}
.ep-fuel-bar.low      { background: linear-gradient(90deg, #9e6a03, var(--color-caution)); }
.ep-fuel-bar.critical { background: linear-gradient(90deg, #da3633, var(--color-danger)); }
.ep-fuel-bar-label {
    position: absolute;
    left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    font-weight: 700;
    font-size:16px;
    color: var(--text-primary);
    text-shadow: 0 0 4px var(--bg-primary);
    white-space: nowrap;
}

/* Efficiency line */
.ep-efficiency {
    text-align: center;
    font-size:17px;
    font-weight: 600;
    color: var(--color-info);
    margin: 4px 0;
    font-family: var(--font-instrument);
}

/* Capture status text (lives in ep-header) */
.ep-capture-status {
    flex: 1;
    font-size:16px;
    font-weight: 700;
    font-family: var(--font-instrument);
    letter-spacing: 0.02em;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.ep-capture-active {
    color: var(--status-ok);
    animation: ep-blink 1.2s infinite;
}
.ep-capture-idle {
    color: var(--text-muted);
    animation: none;
}
.ep-capture-saved {
    color: var(--status-ok);
    animation: none;
}
/* STOP & SAVE button (in ep-header) */
.ep-capture-stop {
    flex-shrink: 0;
    padding: 4px 12px;
    font-size:16px;
    font-weight: 700;
    background: var(--bg-surface);
    color: var(--status-danger);
    border: 1px solid var(--status-danger);
    border-radius: 5px;
    height: 36px;
    cursor: pointer;
}
.ep-capture-stop:disabled {
    color: var(--text-muted);
    border-color: var(--border);
    cursor: default;
}

/* Recording indicator */
.ep-rec-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    padding: 4px 8px;
    background: var(--bg-surface-raised);
    border: 1px solid var(--border);
    border-radius: 5px;
}
.ep-rec-dot {
    width: 10px; height: 10px;
    background: var(--color-danger);
    border-radius: 50%;
    animation: ep-blink 1s infinite;
}
@keyframes ep-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.ep-rec-label {
    font-size:17px;
    font-weight: 700;
    color: var(--color-danger);
    font-family: var(--font-instrument);
}

/* Sticky valve banner */
.ep-sticky-banner {
    background: var(--color-caution);
    border: 2px solid var(--color-danger);
    border-radius: 5px;
    padding: 8px 10px;
    margin-bottom: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
}
.ep-sticky-text {
    font-size:16px;
    font-weight: 900;
    color: var(--color-danger);
}
.ep-sticky-dismiss {
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--text-primary);
    border-radius: 4px;
    padding: 4px 10px;
    font-size:14px;
    font-weight: 700;
    cursor: pointer;
    white-space: nowrap;
}

/* Pi contract mismatch banner (#113). NOTE: color:#000 here, not
   var(--color-danger) — .ep-sticky-text above uses --color-danger text on
   this same --color-caution fill and measures 2.24:1 (checked while building
   this banner, not part of this issue, flagged separately rather than fixed
   here). The documented Status badge pattern for a --color-caution fill is
   solid black text; this banner follows that instead of the sibling's. */
.ep-contract-banner {
    background: var(--color-caution);
    border-radius: 5px;
    padding: 8px 10px;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
}
.ep-contract-text {
    font-size: 16px;
    font-weight: 900;
    color: #000;
}
.ep-contract-text code {
    background: rgba(0, 0, 0, 0.15);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono, monospace);
}

/* Portrait tablet tweaks */
@media (max-width: 820px) {
    .ep-primary-row {
        grid-template-columns: repeat(4, 1fr);
    }
    .ep-gauge-value { font-size: 20px; }
}
@media (max-width: 520px) {
    .ep-primary-row {
        grid-template-columns: repeat(3, 1fr);
    }
}
`;
    }
}
