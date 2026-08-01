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

        // FUEL@DEST colour bands. Previously hardcoded as `<4` / `<8` / `<12`.
        // 4 and 8 are the same reserve thresholds every other fuel display uses —
        // they now come from the same config keys (enginePage.fuelWarningGal /
        // fuelCautionGal) so the panel cannot disagree with the engine page, the
        // route table's REM column or the route-strip DEST badge.
        //
        // 12 had no config counterpart anywhere in the app — an invented third band
        // unique to this panel. It is KEPT (dropping it would silently turn a set of
        // currently-flagged rows plain, i.e. more reassuring than before, which is the
        // wrong error direction) but is now a named, editable key rather than a magic
        // number: `enginePage.fuelAdvisoryGal`, default 12.
        //
        // The comparisons are `<=`, not `<`: every other fuel display in the app
        // treats the threshold itself as already in the band, and exactly 4.0 gal
        // should read danger on all of them, not danger on one and caution here.
        const cautionGal  = CockpitConfig.get('enginePage.fuelCautionGal')  ?? 8;
        const warnGal     = CockpitConfig.get('enginePage.fuelWarningGal')  ?? 4;
        const advisoryGal = CockpitConfig.get('enginePage.fuelAdvisoryGal') ?? 12;

        // `fuelRemaining` is the canonical live quantity published by route-table.js
        // `_emitLegUpdate` (manual override > tracked tank state; null when nothing is
        // tracked). `fuelRemainingStale` marks a tracked figure FuelTankState considers
        // unconfirmed — see the stale handling at the FUEL@DEST cell below.
        const fuelStale = !!d.fuelRemainingStale;

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
                fuelStr = calc.fuelAtDest.toFixed(1) + (fuelStale ? '? gal' : ' gal');
                fuelClass = calc.fuelAtDest <= warnGal     ? 'pt-red'
                          : calc.fuelAtDest <= cautionGal  ? 'pt-amber'
                          : calc.fuelAtDest <= advisoryGal ? 'pt-yellow'
                          : '';
                // STALE-NEVER-GREEN: the fuel quantity this row is projected from has
                // not been updated in 45+ min, so it reads HIGH by the whole unrecorded
                // burn. Never leave such a row in the plain (in-limits) style, whatever
                // the arithmetic says. Caution colour + trailing '?' — the same two
                // signals instrument-strip.js and the route table use.
                if (fuelStale && !fuelClass) fuelClass = 'pt-amber';
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
