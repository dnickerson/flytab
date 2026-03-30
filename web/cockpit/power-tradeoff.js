/**
 * FlyTab — Power Tradeoff Panel
 *
 * Bottom sheet showing live fuel/time comparison across power settings.
 * Tap ETE▲ or FUEL▲ on the instrument strip to open.
 *
 * Each row answers: "If I set power to X%, what is my ETE and fuel at destination?"
 * The current power setting row is highlighted.
 *
 * Data sources:
 *   - aircraft-config.json  performance.power_settings[]   (TAS + GPH per %pwr)
 *   - activeroute:legupdate event                          (live dist, wind, fuel, gs)
 */

class PowerTradeoff {
    constructor() {
        this._el       = null;
        this._backdrop = null;
        this._visible  = false;

        // Last received leg update data
        this._legData  = null;

        // Power settings from aircraft config (sorted ascending by pct)
        this._powerSettings = [];

        this._onLegUpdate = (e) => {
            this._legData = e.detail;
            if (this._visible) this._render();
        };
    }

    init() {
        // Load power settings
        const raw = CockpitConfig.aircraft('performance.power_settings') || [];
        this._powerSettings = [...raw].sort((a, b) => a.pct - b.pct);

        // Backdrop
        this._backdrop = document.createElement('div');
        this._backdrop.className = 'pt-backdrop';
        this._backdrop.addEventListener('click', () => this.hide());
        document.body.appendChild(this._backdrop);

        // Panel
        this._el = document.createElement('div');
        this._el.className = 'pt-panel';
        this._el.innerHTML = `
            <div class="pt-header">
                <span class="pt-title">⚡ Power Tradeoff</span>
                <button class="pt-close" aria-label="Close">✕</button>
            </div>
            <div class="pt-body"></div>
            <div class="pt-footer"></div>
        `;
        this._el.querySelector('.pt-close').addEventListener('click', () => this.hide());
        document.body.appendChild(this._el);

        // Listen for leg updates
        window.addEventListener('activeroute:legupdate', this._onLegUpdate);
    }

    destroy() {
        window.removeEventListener('activeroute:legupdate', this._onLegUpdate);
        this._backdrop?.remove();
        this._el?.remove();
    }

    show() {
        if (!this._el) return;
        this._visible = true;
        this._backdrop.classList.add('pt-visible');
        this._el.classList.add('pt-visible');
        this._render();
    }

    hide() {
        if (!this._el) return;
        this._visible = false;
        this._backdrop.classList.remove('pt-visible');
        this._el.classList.remove('pt-visible');
    }

    toggle() {
        this._visible ? this.hide() : this.show();
    }

    // ── Calculation ───────────────────────────────────────────────────────

    /**
     * Compute destination stats for a given power setting.
     * @param {object} ps         - power_settings entry { pct, tas_kt, gph, samples }
     * @param {object} legData    - activeroute:legupdate detail
     * @returns {{ eteMin, fuelAtDest, gsKt, valid: bool }}
     */
    _calcForPower(ps, legData) {
        const { destDistNm, activeWind, fuelRemaining } = legData;
        if (!destDistNm || destDistNm <= 0) return { valid: false };

        // Wind component along track (headwind negative, tailwind positive)
        // activeWind = { dir: degrees, spd: knots } — wind FROM direction
        // active waypoint bearing used as track approximation
        let windComp = 0;
        if (activeWind && activeWind.spd > 0 && legData.hdg != null) {
            // Component of wind along track: spd * cos(windDir - track)
            // Positive = tailwind
            const angleDiff = (activeWind.dir - legData.hdg) * Math.PI / 180;
            windComp = activeWind.spd * Math.cos(angleDiff);
        }

        const gsKt    = Math.max(60, ps.tas_kt + windComp);   // floor at 60kt
        const eteHrs  = destDistNm / gsKt;
        const eteMin  = eteHrs * 60;

        // For current power row: use live GPH from EDM if available
        const gph = (legData.livePctPower != null &&
                     Math.abs(legData.livePctPower - ps.pct) <= 5 &&
                     legData.liveGph > 0)
            ? legData.liveGph
            : ps.gph;

        const fuelBurn   = eteHrs * gph;
        const fuelAtDest = fuelRemaining != null ? fuelRemaining - fuelBurn : null;

        return { eteMin, fuelAtDest, gsKt: Math.round(gsKt), gph, valid: true };
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    _render() {
        const body   = this._el.querySelector('.pt-body');
        const footer = this._el.querySelector('.pt-footer');
        if (!body) return;

        if (!this._legData || !this._powerSettings.length) {
            body.innerHTML = '<div class="pt-no-data">No route active</div>';
            footer.textContent = '';
            return;
        }

        const d = this._legData;

        // Identify current power row (match live pct within ±5%)
        const livePct = d.livePctPower;

        // Build rows (highest power first — feels like a menu: fast at top)
        const settings = [...this._powerSettings].reverse();

        // Planned ETE for delta calculation
        const plannedEteMin = d.destEteMin;

        let minSamples = Infinity;
        let html = `
            <table class="pt-table">
                <thead>
                    <tr>
                        <th>PWR</th>
                        <th>GS</th>
                        <th>GPH</th>
                        <th>ETE</th>
                        <th>FUEL@DEST</th>
                        <th>△TIME</th>
                    </tr>
                </thead>
                <tbody>
        `;

        for (const ps of settings) {
            const calc = this._calcForPower(ps, d);
            if (!calc.valid) continue;

            const isCurrent = livePct != null && Math.abs(livePct - ps.pct) <= 5;
            const rowClass  = isCurrent ? 'pt-row-current' : '';

            // ETE
            const eteStr = PowerTradeoff._fmtTime(calc.eteMin);

            // Delta time vs planned
            let deltaStr = '—';
            let deltaClass = '';
            if (plannedEteMin != null) {
                const delta = calc.eteMin - plannedEteMin;
                if (Math.abs(delta) >= 0.5) {
                    const sign = delta > 0 ? '+' : '';
                    deltaStr  = sign + PowerTradeoff._fmtTime(Math.abs(delta));
                    deltaClass = delta > 5 ? 'pt-red' : delta > 2 ? 'pt-amber' : 'pt-green';
                } else {
                    deltaStr = 'on plan';
                    deltaClass = 'pt-green';
                }
            }

            // Fuel at destination
            let fuelStr = '—';
            let fuelClass = '';
            if (calc.fuelAtDest != null) {
                fuelStr = calc.fuelAtDest.toFixed(1) + ' gal';
                // Warn if low: <8 = caution, <4 = danger
                fuelClass = calc.fuelAtDest < 4  ? 'pt-red'
                          : calc.fuelAtDest < 8  ? 'pt-amber'
                          : calc.fuelAtDest < 12 ? 'pt-yellow'
                          : '';
            }

            if (ps.samples) minSamples = Math.min(minSamples, ps.samples);

            html += `
                <tr class="${rowClass}">
                    <td class="pt-pwr">${isCurrent ? '▶ ' : ''}${ps.pct}%</td>
                    <td>${calc.gsKt}kt</td>
                    <td>${calc.gph.toFixed(1)}</td>
                    <td>${eteStr}</td>
                    <td class="${fuelClass}">${fuelStr}</td>
                    <td class="${deltaClass}">${deltaStr}</td>
                </tr>
            `;
        }

        html += '</tbody></table>';
        body.innerHTML = html;

        // Footer: data confidence + dist remaining
        const distStr = d.destDistNm != null ? `${Math.round(d.destDistNm)}nm to dest` : '';
        const sampleStr = isFinite(minSamples) ? `Based on ${minSamples}+ actual flight data points` : '';
        footer.innerHTML = [distStr, sampleStr].filter(Boolean).join(' · ');
    }

    static _fmtTime(minutes) {
        if (minutes == null || minutes < 0) return '—';
        const h = Math.floor(minutes / 60);
        const m = Math.round(minutes % 60);
        return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
    }
}
