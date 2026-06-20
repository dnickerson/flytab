/**
 * FlyTab — Engine Panel
 * Receives engine data via EngineClient WebSocket (1Hz push).
 * Displays RPM, EGT 1-4, CHT 1-4, fuel, oil, power.
 */

class EnginePanel {
    constructor(container, engineClient) {
        this.container = container;
        this._engineClient = engineClient || null;
        this._el = null;
        this._pollTimer = null;
        this._lastData = null;
        this._lastPollTime = 0;
        this._connected = false;
        this._disabled = false;
        this._dom = {};     // cached DOM refs
        this._maxRpm = 2700;
        this._egtDanger = 1650;
        this._chtDanger = 400;
    }

    init() {
        // Check if engine polling is disabled (e.g. at home without engine monitor)
        try {
            if (typeof CockpitConfig !== 'undefined' && CockpitConfig.get) {
                const ep = CockpitConfig.get('enginePolling');
                if (ep && ep.enabled === false) {
                    this._disabled = true;
                    console.log('Engine polling disabled by config');
                    return;
                }
            }
        } catch (_) { /* proceed with polling */ }

        // Load thresholds from config
        this._loadConfig();

        this._el = document.createElement('div');
        this._el.className = 'engine-panel';
        this._el.innerHTML = `
            <div class="engine-header">
                <span class="engine-title">ENGINE</span>
                <span class="engine-status" id="eng-status">DISCONNECTED</span>
            </div>
            <div class="engine-grid">
                <div class="engine-gauge">
                    <div class="gauge-label">RPM</div>
                    <div class="gauge-value instrument-value" id="eng-rpm">—</div>
                    <div class="gauge-bar"><div class="gauge-bar-fill" id="eng-rpm-bar"></div></div>
                </div>
                <div class="engine-gauge">
                    <div class="gauge-label">% PWR</div>
                    <div class="gauge-value" id="eng-pwr">—</div>
                    <div class="gauge-bar"><div class="gauge-bar-fill" id="eng-pwr-bar"></div></div>
                </div>
                <div class="engine-gauge">
                    <div class="gauge-label">FUEL</div>
                    <div class="gauge-value" id="eng-fuel">—</div>
                    <div class="gauge-sub" id="eng-fuel-endurance"></div>
                </div>
                <div class="engine-gauge">
                    <div class="gauge-label">GPH</div>
                    <div class="gauge-value" id="eng-gph">—</div>
                    <div class="gauge-sub" id="eng-rop-lop"></div>
                </div>
            </div>
            <div class="engine-bars-section">
                <div class="engine-bars-row">
                    <span class="bars-label">EGT</span>
                    <div class="engine-bars" id="eng-egt-bars"></div>
                </div>
                <div class="engine-bars-row">
                    <span class="bars-label">CHT</span>
                    <div class="engine-bars" id="eng-cht-bars"></div>
                </div>
            </div>
            <div class="engine-oil-row">
                <div class="engine-gauge-sm">
                    <span class="gauge-label-sm">OIL T</span>
                    <span class="gauge-value-sm" id="eng-oil-temp">—</span>
                </div>
                <div class="engine-gauge-sm">
                    <span class="gauge-label-sm">OIL P</span>
                    <span class="gauge-value-sm" id="eng-oil-press">—</span>
                </div>
            </div>
        `;
        this.container.appendChild(this._el);

        // Create EGT/CHT bar elements
        let egtHtml = '', chtHtml = '';
        for (let i = 1; i <= 4; i++) {
            egtHtml += `<div class="cyl-bar"><div class="cyl-bar-fill" id="eng-egt-${i}"></div><span class="cyl-num">${i}</span></div>`;
            chtHtml += `<div class="cyl-bar"><div class="cyl-bar-fill" id="eng-cht-${i}"></div><span class="cyl-num">${i}</span></div>`;
        }
        const egtBars = this._el.querySelector('#eng-egt-bars');
        const chtBars = this._el.querySelector('#eng-cht-bars');
        if (egtBars) egtBars.innerHTML = egtHtml;
        if (chtBars) chtBars.innerHTML = chtHtml;

        // Cache all DOM refs (these never change)
        this._dom = {
            status: this._el.querySelector('#eng-status'),
            rpm: this._el.querySelector('#eng-rpm'),
            rpmBar: this._el.querySelector('#eng-rpm-bar'),
            pwr: this._el.querySelector('#eng-pwr'),
            pwrBar: this._el.querySelector('#eng-pwr-bar'),
            fuel: this._el.querySelector('#eng-fuel'),
            fuelEndurance: this._el.querySelector('#eng-fuel-endurance'),
            gph: this._el.querySelector('#eng-gph'),
            ropLop: this._el.querySelector('#eng-rop-lop'),
            oilTemp: this._el.querySelector('#eng-oil-temp'),
            oilPress: this._el.querySelector('#eng-oil-press'),
        };
        for (let i = 1; i <= 4; i++) {
            this._dom[`egt${i}`] = this._el.querySelector(`#eng-egt-${i}`);
            this._dom[`cht${i}`] = this._el.querySelector(`#eng-cht-${i}`);
        }

        this._startListening();
    }

    _loadConfig() {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const ep = CockpitConfig.get('enginePage');
                if (ep) {
                    this._egtDanger = ep.egtDanger ?? this._egtDanger;
                    this._chtDanger = ep.chtDanger ?? this._chtDanger;
                }
                this._maxRpm = CockpitConfig.aircraft('performance.max_rpm') ?? this._maxRpm;
            }
        } catch (_) { /* use defaults */ }
    }

    destroy() {
        if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
        if (this._el && this._el.parentNode) {
            this._el.parentNode.removeChild(this._el);
            this._el = null;
        }
        this._dom = {};
    }

    _startListening() {
        if (!this._engineClient) return;

        this._engineClient.addEventListener('engine:data', (e) => {
            const raw = e.detail;
            // Flatten nested data if present (engine monitor compat)
            const data = raw.data ? { ...raw, ...raw.data } : raw;
            this._lastData = data;
            this._lastPollTime = Date.now();
            this._connected = true;
            this._render(data);
        });

        this._engineClient.addEventListener('engine:disconnect', () => {
            this._connected = false;
            this._lastPollTime = 0;
            // Keep lastData so pilot still sees last known values (not flashing dashes).
            // Show DISCONNECTED status but don't blank gauges on transient WiFi glitch.
            if (this._dom.status) {
                this._dom.status.textContent = 'DISCONNECTED';
                this._dom.status.className = 'engine-status disconnected';
            }
        });

        this._engineClient.addEventListener('engine:stale', (e) => {
            // Pi serial hang — WS open but no data for 5+ seconds
            if (e.detail.stale && this._dom.status) {
                this._dom.status.textContent = 'STALE';
                this._dom.status.className = 'engine-status disconnected';
            }
        });
    }

    _render(d) {
        if (this._dom.status) {
            this._dom.status.textContent = 'CONNECTED';
            this._dom.status.className = 'engine-status connected';
        }

        // Numeric sanitizer — Pi can send strings ("---") during init/error states
        const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

        // RPM
        const rpm = num(d.rpm ?? d.RPM ?? 0);
        if (this._dom.rpm) this._dom.rpm.textContent = Math.round(rpm);
        this._setBar(this._dom.rpmBar, rpm / this._maxRpm * 100);

        // Power
        const pwr = num(d.percent_power ?? d.pwr ?? 0);
        if (this._dom.pwr) this._dom.pwr.textContent = Math.round(pwr) + '%';
        this._setBar(this._dom.pwrBar, pwr);

        // Pi tracker: d.fuel.fuel_remaining; EDM resistive/computed fallback: d.Fuel_Remaining
        const fuel = num(d.fuel?.fuel_remaining ?? d.fuel_remaining_gal ?? d.fuel_gal ?? d.Gallons_Rem ?? d.Fuel_Remaining ?? 0);
        if (this._dom.fuel) this._dom.fuel.textContent = fuel.toFixed(1) + ' gal';
        const gph = num(d.fuel_flow_gph ?? d.gph ?? d.Fuel_Flow ?? 0);
        if (this._dom.gph) this._dom.gph.textContent = gph.toFixed(1);
        if (gph > 0 && fuel > 0) {
            const totalMin = Math.round((fuel / gph) * 60);
            const h = Math.floor(totalMin / 60);
            const m = totalMin % 60;
            if (this._dom.fuelEndurance) this._dom.fuelEndurance.textContent = `${h}:${String(m).padStart(2, '0')} endur`;
        }

        // ROP/LOP
        const ropLop = d.rop_lop ?? d.rop_lop_mode ?? d.mixture_mode ?? '';
        if (this._dom.ropLop) this._dom.ropLop.textContent = ropLop;

        // EGT bars (range ~1200-1700°F)
        for (let i = 1; i <= 4; i++) {
            const egt = num(d[`egt${i}`] ?? d[`EGT${i}`] ?? 0);
            const pct = Math.min(100, Math.max(0, (egt - 1000) / 700 * 100));
            const bar = this._dom[`egt${i}`];
            if (bar) {
                bar.style.height = pct + '%';
                bar.className = 'cyl-bar-fill' + (egt > this._egtDanger ? ' danger' : '');
                bar.title = Math.round(egt) + '\u00B0F';
            }
        }

        // CHT bars (range ~200-500°F)
        for (let i = 1; i <= 4; i++) {
            const cht = num(d[`cht${i}`] ?? d[`CHT${i}`] ?? 0);
            const pct = Math.min(100, Math.max(0, (cht - 100) / 400 * 100));
            const bar = this._dom[`cht${i}`];
            if (bar) {
                bar.style.height = pct + '%';
                bar.className = 'cyl-bar-fill' + (cht > this._chtDanger ? ' danger' : '');
                bar.title = Math.round(cht) + '\u00B0F';
            }
        }

        // Oil (EDM field names: Oil_Temp, Oil_Press)
        const oilT = num(d.oil_temp ?? d.oil_temp_f ?? d.Oil_Temp ?? 0);
        const oilP = num(d.oil_pressure ?? d.oil_press_psi ?? d.Oil_Press ?? 0);
        if (this._dom.oilTemp) this._dom.oilTemp.textContent = Math.round(oilT) + '°F';
        if (this._dom.oilPress) this._dom.oilPress.textContent = Math.round(oilP) + ' psi';
    }

    _setBar(el, pct) {
        if (el) el.style.width = Math.min(100, Math.max(0, pct)) + '%';
    }

    get lastData() { return this._lastData; }
    get lastPollTime() { return this._lastPollTime; }
    get connected() { return this._connected; }
    get disabled() { return this._disabled === true; }
}
