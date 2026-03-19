/**
 * FlyPi — Device Status Panel
 * Shows connection state of Stratux, GPS, engine monitor, FastAPI.
 */

class DeviceStatus {
    constructor(container, stratuxClient, enginePanel) {
        this.container = container;
        this.stratux = stratuxClient;
        this.engine = enginePanel;
        this._el = null;
        this._updateTimer = null;
    }

    init() {
        this._el = document.createElement('div');
        this._el.className = 'device-status';
        this._el.innerHTML = `
            <h3 class="card-title">System Status</h3>
            <div class="status-grid">
                <div class="status-row">
                    <span class="status-dot" id="ds-stratux-dot"></span>
                    <span class="status-name">Stratux</span>
                    <span class="status-detail" id="ds-stratux-detail">—</span>
                </div>
                <div class="status-row">
                    <span class="status-dot" id="ds-gps-dot"></span>
                    <span class="status-name">GPS</span>
                    <span class="status-detail" id="ds-gps-detail">—</span>
                </div>
                <div class="status-row">
                    <span class="status-dot" id="ds-traffic-dot"></span>
                    <span class="status-name">Traffic</span>
                    <span class="status-detail" id="ds-traffic-detail">—</span>
                </div>
                <div class="status-row">
                    <span class="status-dot" id="ds-ahrs-dot"></span>
                    <span class="status-name">AHRS</span>
                    <span class="status-detail" id="ds-ahrs-detail">—</span>
                </div>
                <div class="status-row">
                    <span class="status-dot" id="ds-engine-dot"></span>
                    <span class="status-name">Engine Monitor</span>
                    <span class="status-detail" id="ds-engine-detail">—</span>
                </div>
                <div class="status-row">
                    <span class="status-dot" id="ds-pi-dot"></span>
                    <span class="status-name">Stratux HTTP</span>
                    <span class="status-detail" id="ds-pi-detail">—</span>
                </div>
            </div>
        `;
        this.container.appendChild(this._el);

        this._updateTimer = setInterval(() => this._update(), 2000);
        this._update();
    }

    destroy() {
        if (this._updateTimer) { clearInterval(this._updateTimer); this._updateTimer = null; }
    }

    _update() {
        if (!this._el) return;

        // Stratux
        this._setDot('ds-stratux-dot', this.stratux.connected);
        if (this.stratux.deviceStatus) {
            const ds = this.stratux.deviceStatus;
            this._setText('ds-stratux-detail',
                `${ds.Version || '?'} | CPU ${ds.CPUTemp ? ds.CPUTemp.toFixed(0) + '°C' : '?'}`);
        } else {
            this._setText('ds-stratux-detail', this.stratux.connected ? 'Connected' : 'Disconnected');
        }

        // GPS — healthy only if fix quality > 0 AND situation data is not stale
        const sit = this.stratux.situation;
        const gpsFix = sit && sit.gps_fix_quality > 0 && !this.stratux.stale;
        this._setDot('ds-gps-dot', gpsFix);
        if (sit) {
            this._setText('ds-gps-detail',
                `Fix: ${sit.gps_fix_quality} | Sats: ${sit.gps_sats || 0}/${sit.gps_sats_seen || 0}`);
        } else {
            this._setText('ds-gps-detail', 'No data');
        }

        // Traffic
        const tCount = this.stratux.traffic.size;
        this._setDot('ds-traffic-dot', tCount > 0);
        this._setText('ds-traffic-detail', `${tCount} target${tCount !== 1 ? 's' : ''} tracking`);

        // AHRS
        const ahrsOk = sit && sit.pitch != null;
        this._setDot('ds-ahrs-dot', ahrsOk);
        if (sit && ahrsOk) {
            this._setText('ds-ahrs-detail',
                `P: ${sit.pitch?.toFixed(1) || '?'}° R: ${sit.roll?.toFixed(1) || '?'}° G: ${sit.g_load?.toFixed(1) || '?'}`);
        }

        // Engine
        this._setDot('ds-engine-dot', this.engine.connected);
        if (this.engine.connected && this.engine.lastData) {
            const ed = this.engine.lastData;
            this._setText('ds-engine-detail',
                `RPM ${Math.round(ed.rpm || ed.RPM || 0)} | ${Math.round(ed.percent_power || ed.pwr || 0)}% pwr`);
        } else {
            this._setText('ds-engine-detail', 'Disconnected');
        }

        // FastAPI
        this._checkPi();
    }

    async _checkPi() {
        try {
            const r = await fetch('http://192.168.10.1/getStatus', {
                cache: 'no-store',
                signal: AbortSignal.timeout(3000),
            });
            if (r.ok) {
                const d = await r.json();
                this._setDot('ds-pi-dot', true);
                this._setText('ds-pi-detail', `${d.Version || '?'} | CPU ${d.CPUTemp ? d.CPUTemp.toFixed(0) + '°C' : '?'}`);
            } else {
                this._setDot('ds-pi-dot', false);
                this._setText('ds-pi-detail', 'Error');
            }
        } catch {
            this._setDot('ds-pi-dot', false);
            this._setText('ds-pi-detail', 'Unreachable');
        }
    }

    _setText(id, text) {
        const el = this._el.querySelector('#' + id);
        if (el) el.textContent = text;
    }

    _setDot(id, ok) {
        const el = this._el.querySelector('#' + id);
        if (el) el.className = 'status-dot ' + (ok ? 'dot-ok' : 'dot-off');
    }
}
