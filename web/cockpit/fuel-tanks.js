/**
 * FlyTab — Synthetic Fuel Tank Gauges
 * Two vertical bar gauges (L/R) over the map top-left.
 * Driven by FuelTankState; subscribes to engine:data for flow integration.
 * Flight-safety critical display — raw EDM sender values kept visible as sanity check.
 */

class FuelTanksDisplay {
    constructor(container) {
        this._container = container;
        this._el = null;
        this._dom = {};
        this._onEngineData = null;
        this._onStateChanged = null;
        this._onConfirmPrompt = null;
        this._confirmTimer = null;
        this._timerInterval = null;
        this._lastGph = 0;
        this._tankCapacity = 18;   // per side, updated from config on init
        this._initSelectedTank = 'L';
    }

    init() {
        try {
            if (typeof CockpitConfig !== 'undefined') {
                const cap = CockpitConfig.aircraft('performance.fuel_capacity_gal');
                if (cap > 0) this._tankCapacity = cap / 2;
            }
        } catch (_) {}

        this._buildDOM();

        this._onEngineData = (e) => this._handleEngineData(e.detail);
        if (window.engineClient) {
            window.engineClient.addEventListener('engine:data', this._onEngineData);
        }

        this._onStateChanged = () => this._render();
        window.addEventListener('fueltankstate:changed', this._onStateChanged);

        this._onConfirmPrompt = (e) => this._showConfirmBanner(e.detail?.active_tank);
        window.addEventListener('fueltankstate:confirm_prompt', this._onConfirmPrompt);

        this._timerInterval = setInterval(() => this._updateTimers(), 10000);

        // If state exists but is stale, show recovery modal
        if (!FuelTankState.needsConfirmation()) {
            // State is valid — render silently
        } else if (FuelTankState.getState() !== null) {
            // State exists but needs confirmation (mid-flight restart)
            setTimeout(() => this._showRecoveryModal(), 800);
        }

        if (localStorage.getItem('flypi_fuel_widget_visible') === 'false') this.hide();

        this._render();
    }

    show() { if (this._el) { this._el.style.display = ''; try { localStorage.setItem('flypi_fuel_widget_visible', 'true');  } catch {} } }
    hide() { if (this._el) { this._el.style.display = 'none'; try { localStorage.setItem('flypi_fuel_widget_visible', 'false'); } catch {} } }

    destroy() {
        if (this._onEngineData && window.engineClient) {
            window.engineClient.removeEventListener('engine:data', this._onEngineData);
        }
        if (this._onStateChanged) window.removeEventListener('fueltankstate:changed', this._onStateChanged);
        if (this._onConfirmPrompt) window.removeEventListener('fueltankstate:confirm_prompt', this._onConfirmPrompt);
        if (this._timerInterval) clearInterval(this._timerInterval);
        if (this._confirmTimer) clearTimeout(this._confirmTimer);
        if (this._mouseMoveHandler) document.removeEventListener('mousemove', this._mouseMoveHandler);
        if (this._mouseUpHandler)   document.removeEventListener('mouseup',   this._mouseUpHandler);
        if (this._el) this._el.remove();
    }

    /* ------------------------------------------------------------------
     * Engine data handler
     * ----------------------------------------------------------------*/
    _handleEngineData(data) {
        if (!data) return;
        const gph = data.fuel_flow_gph ?? data.gph ?? data.Fuel_Flow ?? 0;
        this._lastGph = gph;
        if (gph > 0) {
            FuelTankState.onSample(gph, Date.now());
        }
        this._updateSenderDisplay(data);
        // Update endurance when GPH changes without a state change
        this._renderEndurance();
    }

    /* ------------------------------------------------------------------
     * DOM construction
     * ----------------------------------------------------------------*/
    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'fuel-tanks-widget';

        // Restore saved position before appending
        try {
            const pos = JSON.parse(localStorage.getItem('flypi_fuel_widget_pos') || 'null');
            if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
                this._el.style.left = pos.left + 'px';
                this._el.style.top  = pos.top  + 'px';
            }
        } catch {}

        this._el.innerHTML = /* html */`
            <div class="ftw-drag-handle"></div>
            <div class="ftw-gauges">
                <div class="ftw-tank" id="ftw-tank-l" data-label="L">
                    <div class="ftw-bar-wrap">
                        <div class="ftw-bar-fill" id="ftw-bar-l"></div>
                    </div>
                    <div class="ftw-gal" id="ftw-gal-l">--</div>
                    <div class="ftw-timer" id="ftw-timer-l"></div>
                    <button class="ftw-badge" id="ftw-badge-l">L</button>
                    <div class="ftw-sender" id="ftw-sender-l"></div>
                </div>
                <div class="ftw-center">
                    <div class="ftw-total-lbl">TOT</div>
                    <div class="ftw-total" id="ftw-total">--</div>
                    <div class="ftw-end" id="ftw-end">--</div>
                    <div class="ftw-imbal" id="ftw-imbal" style="display:none">⚠</div>
                </div>
                <div class="ftw-tank" id="ftw-tank-r" data-label="R">
                    <div class="ftw-bar-wrap">
                        <div class="ftw-bar-fill" id="ftw-bar-r"></div>
                    </div>
                    <div class="ftw-gal" id="ftw-gal-r">--</div>
                    <div class="ftw-timer" id="ftw-timer-r"></div>
                    <button class="ftw-badge" id="ftw-badge-r">R</button>
                    <div class="ftw-sender" id="ftw-sender-r"></div>
                </div>
            </div>

            <div class="ftw-init-panel" id="ftw-init-panel" style="display:none">
                <div class="ftw-init-title" id="ftw-init-title">PREFLIGHT FUEL</div>
                <div class="ftw-init-row">
                    <label class="ftw-init-lbl">L</label>
                    <input type="number" class="ftw-init-inp" id="ftw-init-l"
                           min="0" max="25" step="0.5" placeholder="gal">
                    <label class="ftw-init-lbl">R</label>
                    <input type="number" class="ftw-init-inp" id="ftw-init-r"
                           min="0" max="25" step="0.5" placeholder="gal">
                </div>
                <div class="ftw-sel-row" id="ftw-sel-row">
                    <button class="ftw-sel-btn ftw-sel-active" data-tank="L">L</button>
                    <button class="ftw-sel-btn" data-tank="BOTH">BOTH</button>
                    <button class="ftw-sel-btn" data-tank="R">R</button>
                </div>
                <div class="ftw-init-btns">
                    <button class="ftw-init-ok" id="ftw-init-ok">SET</button>
                    <button class="ftw-init-cancel" id="ftw-init-cancel">✕</button>
                </div>
            </div>

            <div class="ftw-confirm-banner" id="ftw-confirm-banner" style="display:none">
                <span class="ftw-confirm-msg" id="ftw-confirm-msg"></span>
                <button class="ftw-confirm-btn" id="ftw-confirm-yes">YES</button>
                <button class="ftw-confirm-btn ftw-confirm-switch" id="ftw-confirm-switch">SWITCH</button>
            </div>
        `;

        this._container.appendChild(this._el);

        this._dom = {
            tankL:         this._el.querySelector('#ftw-tank-l'),
            tankR:         this._el.querySelector('#ftw-tank-r'),
            barL:          this._el.querySelector('#ftw-bar-l'),
            barR:          this._el.querySelector('#ftw-bar-r'),
            galL:          this._el.querySelector('#ftw-gal-l'),
            galR:          this._el.querySelector('#ftw-gal-r'),
            timerL:        this._el.querySelector('#ftw-timer-l'),
            timerR:        this._el.querySelector('#ftw-timer-r'),
            badgeL:        this._el.querySelector('#ftw-badge-l'),
            badgeR:        this._el.querySelector('#ftw-badge-r'),
            senderL:       this._el.querySelector('#ftw-sender-l'),
            senderR:       this._el.querySelector('#ftw-sender-r'),
            total:         this._el.querySelector('#ftw-total'),
            end:           this._el.querySelector('#ftw-end'),
            imbal:         this._el.querySelector('#ftw-imbal'),
            initPanel:     this._el.querySelector('#ftw-init-panel'),
            initTitle:     this._el.querySelector('#ftw-init-title'),
            initL:         this._el.querySelector('#ftw-init-l'),
            initR:         this._el.querySelector('#ftw-init-r'),
            selRow:        this._el.querySelector('#ftw-sel-row'),
            initOk:        this._el.querySelector('#ftw-init-ok'),
            initCancel:    this._el.querySelector('#ftw-init-cancel'),
            confirmBanner: this._el.querySelector('#ftw-confirm-banner'),
            confirmMsg:    this._el.querySelector('#ftw-confirm-msg'),
            confirmYes:    this._el.querySelector('#ftw-confirm-yes'),
            confirmSwitch: this._el.querySelector('#ftw-confirm-switch'),
        };

        this._makeDraggable();

        this._wireTap(this._dom.badgeL, () => this._onBadgeTap('L'));
        this._wireTap(this._dom.badgeR, () => this._onBadgeTap('R'));

        this._dom.selRow.querySelectorAll('.ftw-sel-btn').forEach(btn => {
            this._wireTap(btn, () => {
                this._initSelectedTank = btn.dataset.tank;
                this._dom.selRow.querySelectorAll('.ftw-sel-btn').forEach(b =>
                    b.classList.toggle('ftw-sel-active', b.dataset.tank === this._initSelectedTank)
                );
            });
        });

        this._wireTap(this._dom.initOk, () => this._applyInit());
        this._wireTap(this._dom.initCancel, () => { this._dom.initPanel.style.display = 'none'; });
        this._wireTap(this._dom.confirmYes, () => this._dismissConfirm(false));
        this._wireTap(this._dom.confirmSwitch, () => this._dismissConfirm(true));
    }

    /* ------------------------------------------------------------------
     * Tank badge tap
     * ----------------------------------------------------------------*/
    _onBadgeTap(tank) {
        const state = FuelTankState.getState();
        if (!state || FuelTankState.needsConfirmation()) {
            this._openInitDialog();
            return;
        }
        if (state.active_tank === tank) {
            this._openInitDialog();
        } else {
            FuelTankState.switchTank(tank);
        }
    }

    /* ------------------------------------------------------------------
     * Init / preflight dialog
     * ----------------------------------------------------------------*/
    _openInitDialog() {
        const state = FuelTankState.getState();
        let leftVal = '', rightVal = '';
        let activeTank = 'L';

        if (state) {
            leftVal = state.left_gal.toFixed(1);
            rightVal = state.right_gal.toFixed(1);
            activeTank = state.active_tank;
        } else {
            try {
                const m = Settings.fuelMeasurement;
                if (m) {
                    leftVal = (m.left_gal ?? 0).toFixed(1);
                    rightVal = (m.right_gal ?? 0).toFixed(1);
                }
            } catch (_) {}
        }

        this._dom.initL.value = leftVal;
        this._dom.initR.value = rightVal;
        this._initSelectedTank = activeTank;
        this._dom.initTitle.textContent = 'PREFLIGHT FUEL';
        this._dom.initOk.textContent = 'SET';
        this._dom.selRow.querySelectorAll('.ftw-sel-btn').forEach(b =>
            b.classList.toggle('ftw-sel-active', b.dataset.tank === activeTank)
        );
        this._dom.initPanel.style.display = 'flex';
    }

    _applyInit() {
        const leftGal = parseFloat(this._dom.initL.value);
        const rightGal = parseFloat(this._dom.initR.value);
        if (isNaN(leftGal) || isNaN(rightGal) || leftGal < 0 || rightGal < 0) return;
        FuelTankState.init(leftGal, rightGal, this._initSelectedTank);
        this._dom.initPanel.style.display = 'none';
    }

    /* ------------------------------------------------------------------
     * Recovery modal (stale state on app restart)
     * ----------------------------------------------------------------*/
    _showRecoveryModal() {
        const state = FuelTankState.getState();
        if (!state) return;
        this._dom.initL.value = state.left_gal.toFixed(1);
        this._dom.initR.value = state.right_gal.toFixed(1);
        this._initSelectedTank = state.active_tank;
        this._dom.initTitle.textContent = 'CONFIRM FUEL STATE';
        this._dom.initOk.textContent = 'CONFIRM';
        this._dom.selRow.querySelectorAll('.ftw-sel-btn').forEach(b =>
            b.classList.toggle('ftw-sel-active', b.dataset.tank === state.active_tank)
        );
        this._dom.initPanel.style.display = 'flex';
    }

    /* ------------------------------------------------------------------
     * Periodic confirmation banner
     * ----------------------------------------------------------------*/
    _showConfirmBanner(activeTank) {
        const label = activeTank === 'L' ? 'LEFT' : activeTank === 'R' ? 'RIGHT' : 'BOTH';
        this._dom.confirmMsg.textContent = `Still on ${label} tank?`;
        this._dom.confirmBanner.style.display = 'flex';
        if (this._confirmTimer) clearTimeout(this._confirmTimer);
        this._confirmTimer = setTimeout(() => this._dismissConfirm(false), 60000);
    }

    _dismissConfirm(doSwitch) {
        if (this._confirmTimer) { clearTimeout(this._confirmTimer); this._confirmTimer = null; }
        this._dom.confirmBanner.style.display = 'none';
        if (doSwitch) {
            const state = FuelTankState.getState();
            if (state) {
                FuelTankState.switchTank(state.active_tank === 'L' ? 'R' : 'L');
            }
        } else {
            FuelTankState.markConfirmed();
        }
    }

    /* ------------------------------------------------------------------
     * Rendering
     * ----------------------------------------------------------------*/
    _render() {
        const state = FuelTankState.getState();
        if (!state || FuelTankState.needsConfirmation()) {
            this._renderEmpty();
            return;
        }

        let cautionGal = 8, warningGal = 4;
        try {
            if (typeof CockpitConfig !== 'undefined') {
                cautionGal = CockpitConfig.get('enginePage.fuelCautionGal') ?? 8;
                warningGal = CockpitConfig.get('enginePage.fuelWarningGal') ?? 4;
            }
        } catch (_) {}

        const cap = this._tankCapacity;

        const pctL = Math.min(1, Math.max(0, state.left_gal / cap));
        const pctR = Math.min(1, Math.max(0, state.right_gal / cap));
        this._dom.barL.style.height = (pctL * 100).toFixed(1) + '%';
        this._dom.barR.style.height = (pctR * 100).toFixed(1) + '%';

        const barCls = (gal) =>
            gal <= warningGal ? 'ftw-bar-fill ftw-bar-warn' :
            gal <= cautionGal ? 'ftw-bar-fill ftw-bar-caution' :
            'ftw-bar-fill';
        this._dom.barL.className = barCls(state.left_gal);
        this._dom.barR.className = barCls(state.right_gal);

        this._dom.galL.textContent = state.left_gal.toFixed(1);
        this._dom.galR.textContent = state.right_gal.toFixed(1);

        const activeL = state.active_tank === 'L' || state.active_tank === 'BOTH';
        const activeR = state.active_tank === 'R' || state.active_tank === 'BOTH';
        this._dom.tankL.classList.toggle('ftw-tank-active', activeL);
        this._dom.tankR.classList.toggle('ftw-tank-active', activeR);
        this._dom.badgeL.classList.toggle('ftw-badge-active', activeL);
        this._dom.badgeR.classList.toggle('ftw-badge-active', activeR);

        const total = state.left_gal + state.right_gal;
        this._dom.total.textContent = total.toFixed(1) + 'g';

        this._dom.imbal.style.display = state.imbalance ? '' : 'none';

        this._updateTimers();
        this._renderEndurance();
    }

    _renderEmpty() {
        this._dom.galL.textContent = '--';
        this._dom.galR.textContent = '--';
        this._dom.timerL.textContent = '';
        this._dom.timerR.textContent = '';
        this._dom.total.textContent = '--';
        this._dom.end.textContent = '--';
        this._dom.barL.style.height = '0%';
        this._dom.barR.style.height = '0%';
        this._dom.barL.className = 'ftw-bar-fill';
        this._dom.barR.className = 'ftw-bar-fill';
        this._dom.tankL.classList.remove('ftw-tank-active');
        this._dom.tankR.classList.remove('ftw-tank-active');
        this._dom.imbal.style.display = 'none';
    }

    _renderEndurance() {
        const state = FuelTankState.getState();
        if (!state || FuelTankState.needsConfirmation()) return;
        const total = state.left_gal + state.right_gal;
        if (this._lastGph > 0) {
            const { hours, minutes } = FuelEngine.endurance(total, this._lastGph);
            this._dom.end.textContent = `${hours}:${String(minutes).padStart(2, '0')}`;
        } else {
            this._dom.end.textContent = '--';
        }
    }

    _updateTimers() {
        const state = FuelTankState.getState();
        if (!state || !state.tank_switched_at) {
            this._dom.timerL.textContent = '';
            this._dom.timerR.textContent = '';
            return;
        }
        const elMin = Math.floor((Date.now() - new Date(state.tank_switched_at).getTime()) / 60000);
        const hrs = Math.floor(elMin / 60);
        const mins = elMin % 60;
        const label = hrs > 0 ? `${hrs}:${String(mins).padStart(2, '0')}` : `${mins}m`;
        const activeL = state.active_tank === 'L' || state.active_tank === 'BOTH';
        const activeR = state.active_tank === 'R' || state.active_tank === 'BOTH';
        this._dom.timerL.textContent = activeL ? label : '';
        this._dom.timerR.textContent = activeR ? label : '';
    }

    _updateSenderDisplay(data) {
        // Raw EDM sender values — secondary reference only, kept visible as sanity check
        const senderL = data.fuel_level_l ?? data.left_fuel ?? null;
        const senderR = data.fuel_level_r ?? data.right_fuel ?? null;
        if (senderL != null) {
            this._dom.senderL.textContent = 's:' + senderL.toFixed(1);
        } else if (senderL == null && senderR == null) {
            const total = FuelEngine.extractEdmFuel(data);
            if (total > 0) this._dom.senderL.textContent = `s:${total.toFixed(0)}`;
        }
        if (senderR != null) this._dom.senderR.textContent = 's:' + senderR.toFixed(1);
    }

    /* ------------------------------------------------------------------
     * Drag-to-reposition
     * ----------------------------------------------------------------*/
    _makeDraggable() {
        const handle = this._el.querySelector('.ftw-drag-handle');
        if (!handle) return;

        let active = false, startX, startY, startLeft, startTop;

        const begin = (clientX, clientY) => {
            active = true;
            startX = clientX;
            startY = clientY;
            const parent = this._el.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
            const rect = this._el.getBoundingClientRect();
            startLeft = rect.left - parent.left;
            startTop  = rect.top  - parent.top;
        };

        const move = (clientX, clientY) => {
            if (!active) return;
            const parent = this._el.offsetParent;
            const maxL = parent ? parent.clientWidth  - this._el.offsetWidth  : 9999;
            const maxT = parent ? parent.clientHeight - this._el.offsetHeight : 9999;
            const newL = Math.min(maxL, Math.max(0, startLeft + clientX - startX));
            const newT = Math.min(maxT, Math.max(0, startTop  + clientY - startY));
            this._el.style.left = newL + 'px';
            this._el.style.top  = newT + 'px';
        };

        const end = () => {
            if (!active) return;
            active = false;
            try {
                localStorage.setItem('flypi_fuel_widget_pos', JSON.stringify({
                    left: parseInt(this._el.style.left) || 0,
                    top:  parseInt(this._el.style.top)  || 0,
                }));
            } catch {}
        };

        // Touch
        handle.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            begin(e.touches[0].clientX, e.touches[0].clientY);
            e.preventDefault();
        }, { passive: false });
        handle.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            move(e.touches[0].clientX, e.touches[0].clientY);
            e.preventDefault();
        }, { passive: false });
        handle.addEventListener('touchend', end);

        // Mouse (desktop testing)
        handle.addEventListener('mousedown', (e) => { begin(e.clientX, e.clientY); e.preventDefault(); });
        this._mouseMoveHandler = (e) => move(e.clientX, e.clientY);
        this._mouseUpHandler   = end;
        document.addEventListener('mousemove', this._mouseMoveHandler);
        document.addEventListener('mouseup',   this._mouseUpHandler);
    }

    /* ------------------------------------------------------------------
     * Touch handling (same pattern as fuel-overlay)
     * ----------------------------------------------------------------*/
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
}
