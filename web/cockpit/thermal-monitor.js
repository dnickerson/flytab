/**
 * FlyTab — Thermal Monitor
 * Polls Android thermal data every 30s via ThermalMonitor Capacitor plugin.
 * Displays surface temp in the status bar badge.
 * Shows cockpit warning only when actual surface temperature is dangerous.
 *
 * Lenovo Yoga Tab with Snapdragon 8 Elite (SM8750):
 *   CPU die: 50-90°C normal. Throttle at 95°C. Shutdown 125°C.
 *   Surface (front/back): 28-42°C normal indoor use.
 *   skin-msm-therm: virtual sensor, often 10-20°C above actual surface — IGNORE for warnings.
 *   getThermalHeadroom(): unreliable on this device (reports 1.2+ during normal operation).
 *
 * Warning thresholds based on actual surface temp:
 *   < 40°C = green (normal)
 *   40-45°C = yellow (warm, normal in direct sun)
 *   45-50°C = orange (hot, consider shade/screen dim)
 *   >= 50°C = red (too hot for safe handling, screen off)
 */

class ThermalMonitor {
    constructor() {
        this._badge = null;
        this._warningEl = null;
        this._timer = null;
        this._history = [];
        this._maxHistory = 120;      // 120 samples × 30s = 1 hour
        this._pollInterval = 30000;  // 30 seconds
        this._plugin = window.Capacitor?.Plugins?.ThermalMonitor;
        this._lastData = null;
    }

    start(badge) {
        this._badge = badge;
        if (!this._badge) return;

        this._badge.style.cursor = 'pointer';
        this._badge.addEventListener('click', () => this._showDetail());

        this._poll();
        this._timer = setInterval(() => this._poll(), this._pollInterval);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    get lastData() { return this._lastData; }
    get history() { return this._history; }

    async _poll() {
        let data;
        if (this._plugin) {
            try {
                data = await this._plugin.getThermal();
            } catch (e) {
                console.warn('[Thermal] plugin call failed:', e);
                return;
            }
        } else {
            this._badge.textContent = '--°';
            this._badge.style.color = 'var(--text-muted)';
            return;
        }

        this._lastData = data;
        this._history.push({
            t: Date.now(),
            cpuTemp: data.cpuTemp,
            surfaceTemp: data.surfaceTemp,
            skinTemp: data.skinTemp,
        });
        if (this._history.length > this._maxHistory) {
            this._history.shift();
        }

        this._updateBadge(data);
        this._updateWarning(data);
    }

    _updateBadge(data) {
        if (!this._badge) return;

        // Show surface temp in badge (what the pilot actually feels)
        const surface = data.surfaceTemp;
        const temp = surface >= 0 ? `${Math.round(surface)}°` : (data.cpuTemp >= 0 ? `${Math.round(data.cpuTemp)}°` : '--°');

        // Color based on actual surface temperature
        let color;
        if (surface >= 0) {
            if (surface < 40) color = 'var(--status-ok)';
            else if (surface < 45) color = 'var(--status-caution)';
            else if (surface < 50) color = 'var(--status-warning)';
            else color = 'var(--status-danger)';
        } else {
            // No surface sensor — fall back to CPU temp
            const t = data.cpuTemp;
            if (t < 0) color = 'var(--text-muted)';
            else if (t < 80) color = 'var(--status-ok)';
            else if (t < 90) color = 'var(--status-caution)';
            else if (t < 95) color = 'var(--status-warning)';
            else color = 'var(--status-danger)';
        }

        this._badge.textContent = temp;
        this._badge.style.color = color;
        this._badge.style.fontWeight = '700';

        // Flash for danger
        const hot = surface >= 50 || (surface < 0 && data.cpuTemp >= 95);
        this._badge.style.animation = hot ? 'thermal-flash 1s infinite' : '';
    }

    _updateWarning(data) {
        // Warning based on actual surface temp only
        const surface = data.surfaceTemp;
        const showWarning = surface >= 50;

        if (showWarning && !this._warningEl) {
            this._warningEl = document.createElement('div');
            this._warningEl.id = 'thermalWarning';
            this._warningEl.style.cssText = `
                position: fixed; top: 40px; left: 50%; transform: translateX(-50%);
                z-index: 9999; padding: 8px 20px; border-radius: 8px;
                background: var(--status-danger); color: var(--text-on-dark);
                font-size: 16px; font-weight: 700; letter-spacing: 0.5px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                animation: thermal-flash 1.5s infinite;
            `;
            this._warningEl.textContent = this._warningText(data);
            document.body.appendChild(this._warningEl);
        } else if (!showWarning && this._warningEl) {
            this._warningEl.remove();
            this._warningEl = null;
        } else if (showWarning && this._warningEl) {
            this._warningEl.textContent = this._warningText(data);
        }
    }

    _warningText(data) {
        const t = data.surfaceTemp >= 0 ? ` ${Math.round(data.surfaceTemp)}°C` : '';
        return `TABLET HOT${t} — SCREEN OFF OK`;
    }

    /** Show thermal detail popup when badge is tapped */
    _showDetail() {
        document.getElementById('thermalDetail')?.remove();

        const d = this._lastData;
        const overlay = document.createElement('div');
        overlay.id = 'thermalDetail';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            z-index: 10000; background: var(--bg-primary);
            display: flex; flex-direction: column; padding: 16px;
            overflow-y: auto;
        `;

        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;';

        const header = document.createElement('h2');
        header.style.cssText = 'color: var(--text-primary); margin: 0; font-size: 20px;';
        header.textContent = 'Thermal Status';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ep-close btn-close';
        closeBtn.textContent = '✕';
        closeBtn.onclick = () => overlay.remove();

        headerRow.appendChild(header);
        headerRow.appendChild(closeBtn);

        const rows = document.createElement('div');
        rows.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;';

        const addRow = (label, value, color) => {
            const lbl = document.createElement('div');
            lbl.style.cssText = 'color: var(--text-label); font-size: 14px;';
            lbl.textContent = label;
            const val = document.createElement('div');
            val.style.cssText = `color: ${color || 'var(--text-primary)'}; font-size: 18px; font-weight: 700; text-align: right;`;
            val.textContent = value;
            rows.appendChild(lbl);
            rows.appendChild(val);
        };

        if (d) {
            // Surface temp with color
            const sColor = d.surfaceTemp < 40 ? 'var(--status-ok)' :
                d.surfaceTemp < 45 ? 'var(--status-caution)' :
                d.surfaceTemp < 50 ? 'var(--status-warning)' : 'var(--status-danger)';
            addRow('Surface Temperature', d.surfaceTemp >= 0 ? `${d.surfaceTemp.toFixed(1)}°C` : 'N/A', sColor);
            addRow('CPU Temperature', d.cpuTemp >= 0 ? `${d.cpuTemp.toFixed(1)}°C` : 'N/A');
            addRow('CPU Shutdown', d.shutdownTemp > 0 ? `${d.shutdownTemp.toFixed(0)}°C` : 'N/A');
            if (d.shutdownTemp > 0 && d.cpuTemp > 0) {
                const margin = d.shutdownTemp - d.cpuTemp;
                const mColor = margin < 10 ? 'var(--status-danger)' :
                    margin < 20 ? 'var(--status-warning)' :
                    margin < 30 ? 'var(--status-caution)' : 'var(--status-ok)';
                addRow('CPU Margin', `${margin.toFixed(0)}°C`, mColor);
            }
            addRow('Skin (virtual)', d.skinTemp >= 0 ? `${d.skinTemp.toFixed(1)}°C` : 'N/A', 'var(--text-muted)');
            addRow('Thermal Status', d.status);
            addRow('Headroom (unreliable)', d.headroom >= 0 ? `${(d.headroom * 100).toFixed(0)}%` : 'N/A', 'var(--text-muted)');
        } else {
            addRow('Status', 'No data — plugin unavailable');
        }

        // Chart
        const chartTitle = document.createElement('h3');
        chartTitle.style.cssText = 'color: var(--text-label); margin: 0 0 8px; font-size: 16px;';
        chartTitle.textContent = 'Temperature History (last hour)';

        const canvas = document.createElement('canvas');
        canvas.width = 600;
        canvas.height = 200;
        canvas.style.cssText = 'width: 100%; height: 200px; flex-shrink: 0; background: var(--bg-surface-raised); border-radius: 8px;';

        overlay.appendChild(headerRow);
        overlay.appendChild(rows);
        overlay.appendChild(chartTitle);
        overlay.appendChild(canvas);
        document.body.appendChild(overlay);

        this._drawChart(canvas);
    }

    _drawChart(canvas) {
        if (this._history.length < 2) return;

        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const pad = { top: 20, right: 10, bottom: 25, left: 45 };
        const plotW = w - pad.left - pad.right;
        const plotH = h - pad.top - pad.bottom;

        ctx.clearRect(0, 0, w, h);

        // Collect all temps for range
        const allTemps = [];
        for (const pt of this._history) {
            if (pt.cpuTemp >= 0) allTemps.push(pt.cpuTemp);
            if (pt.surfaceTemp >= 0) allTemps.push(pt.surfaceTemp);
        }
        if (allTemps.length < 2) return;

        const minT = Math.floor(Math.min(...allTemps) / 5) * 5;
        const maxT = Math.ceil(Math.max(...allTemps) / 5) * 5 + 5;
        const tRange = maxT - minT || 1;

        const t0 = this._history[0].t;
        const t1 = this._history[this._history.length - 1].t;
        const tDur = t1 - t0 || 1;

        // Grid
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        ctx.font = '11px monospace';
        ctx.fillStyle = '#888';
        for (let t = minT; t <= maxT; t += 10) {
            const y = pad.top + plotH - ((t - minT) / tRange) * plotH;
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(pad.left + plotW, y);
            ctx.stroke();
            ctx.fillText(`${t}°`, 4, y + 4);
        }

        // CPU temp line (red)
        const drawLine = (pts, color, width) => {
            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            let first = true;
            for (const pt of pts) {
                const x = pad.left + ((pt.t - t0) / tDur) * plotW;
                const y = pad.top + plotH - ((pt.v - minT) / tRange) * plotH;
                if (first) { ctx.moveTo(x, y); first = false; }
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };

        drawLine(
            this._history.filter(p => p.cpuTemp >= 0).map(p => ({ t: p.t, v: p.cpuTemp })),
            '#ff6644', 2
        );
        drawLine(
            this._history.filter(p => p.surfaceTemp >= 0).map(p => ({ t: p.t, v: p.surfaceTemp })),
            '#44aaff', 2
        );

        // Legend
        ctx.fillStyle = '#ff6644';
        ctx.fillText('CPU', pad.left + 5, pad.top + 12);
        ctx.fillStyle = '#44aaff';
        ctx.fillText('Surface', pad.left + 40, pad.top + 12);

        // Time axis
        ctx.fillStyle = '#888';
        const mins = Math.round(tDur / 60000);
        ctx.fillText(`${mins}m ago`, pad.left, h - 4);
        ctx.fillText('now', pad.left + plotW - 20, h - 4);
    }
}
