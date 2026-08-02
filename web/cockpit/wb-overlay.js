/**
 * WbOverlay — Weight & Balance cockpit panel.
 * Reads aircraft W&B profile from aircraft-config.json (weight_balance block).
 * Uses WbCalculator for computation, Chart.js for the CG envelope diagram.
 */
class WbOverlay {
    constructor(container) {
        this._container     = container;
        this._el            = null;
        this._chart         = null;
        this._profile       = null;
        this._inputs        = {};   // { stationName: <input element> }
        this._fuelInput     = null;
        this._envelopePoints = null; // cached once — envelope never changes at runtime
        // Set by _syncFuelFromState() from FuelState.getCurrentFuel().stale; consumed by
        // _renderResults(). Cleared the moment the pilot types in the fuel field — at that
        // point the number is his own entry, not an aged tracked figure.
        this._fuelStale     = false;
        // False until the pilot edits the fuel field himself. While false, every show()
        // re-reads the canonical source, so a prefill taken on the ramp does not silently
        // age across the flight; once true, his entry is never overwritten.
        this._fuelUserEdited = false;

        this._buildDOM();
    }

    show() {
        this._syncFuelFromState();
        // Make overlay visible BEFORE computing so Chart.js measures a real container
        this._el.classList.add('visible');
        this._compute();
        if (this._chart) this._chart.resize();
    }

    hide() {
        this._el.classList.remove('visible');
    }

    get visible() {
        return this._el.classList.contains('visible');
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _buildDOM() {
        this._profile = (typeof CockpitConfig !== 'undefined')
            ? CockpitConfig.aircraft('weight_balance')
            : null;

        const el = document.createElement('div');
        el.className = 'wb-overlay';
        this._el = el;

        // Header
        const header = document.createElement('div');
        header.className = 'wb-header';
        const title = document.createElement('div');
        title.className = 'wb-title';
        const tail = (typeof CockpitConfig !== 'undefined')
            ? (CockpitConfig.aircraft('tail') || 'W&B')
            : 'W&B';
        title.textContent = `W&B — ${tail}`;
        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-close';
        closeBtn.innerHTML = '&#x2715;';
        wireTap(closeBtn, () => this.hide());
        header.appendChild(title);
        header.appendChild(closeBtn);
        el.appendChild(header);

        if (!this._profile) {
            const body = document.createElement('div');
            body.className = 'wb-body';
            body.innerHTML = '<p style="color:var(--text-muted);padding:24px">No weight_balance data in aircraft-config.json.</p>';
            el.appendChild(body);
            this._container.appendChild(el);
            return;
        }

        const body = document.createElement('div');
        body.className = 'wb-body';

        // Station inputs
        const grid = document.createElement('div');
        grid.className = 'wb-stations';
        this._buildStationInputs(grid);
        body.appendChild(grid);

        // Results bar
        this._resultsEl = document.createElement('div');
        this._resultsEl.className = 'wb-results';
        body.appendChild(this._resultsEl);

        // Moment table
        this._tableEl = document.createElement('div');
        this._tableEl.className = 'wb-moment-table';
        body.appendChild(this._tableEl);

        // Chart
        const chartWrap = document.createElement('div');
        chartWrap.className = 'wb-chart-container';
        this._canvas = document.createElement('canvas');
        chartWrap.appendChild(this._canvas);
        body.appendChild(chartWrap);

        // Cache envelope polygon — derived from static config, never changes at runtime
        if (this._profile && typeof WbCalculator !== 'undefined') {
            this._envelopePoints = WbCalculator.getEnvelopePoints(
                this._profile.cg_envelope || this._profile.envelope
            );
        }

        el.appendChild(body);
        this._container.appendChild(el);
        // Do NOT call _compute() here — the overlay is display:none at construction;
        // Chart.js would measure a 0×0 container. Defer to show().
    }

    _buildStationInputs(grid) {
        const nonFuel = (this._profile.stations || []).filter(s => !s.fuel);
        const fuelStation = (this._profile.stations || []).find(s => s.fuel);

        nonFuel.forEach(station => {
            const card = this._makeStationCard(
                station.name,
                station.arm,
                'lb',
                station.max_weight ? `max ${station.max_weight}` : '',
                (input) => {
                    this._inputs[station.name] = input;
                    if (station.max_weight) input.max = station.max_weight;
                    input.value = '';
                    input.placeholder = '0';
                }
            );
            grid.appendChild(card);
        });

        if (fuelStation) {
            const maxGal = fuelStation.max_gal || 36;
            const card = this._makeStationCard(
                fuelStation.name,
                fuelStation.arm,
                'gal',
                `max ${maxGal}`,
                (input) => {
                    this._fuelInput = input;
                    input.max  = maxGal;
                    input.step = '0.1';  // decimal gallons (overrides the step="1" default)
                    input.value = '';
                    input.placeholder = '0';
                    // Registered inside setup(), so it fires BEFORE the _compute()
                    // listener _makeStationCard attaches afterwards — the re-render
                    // therefore already sees the updated flags. Programmatic
                    // `input.value = …` fires no 'input' event, so the pre-fill in
                    // _syncFuelFromState() never trips this.
                    input.addEventListener('input', () => {
                        this._fuelUserEdited = true;
                        this._fuelStale = false;
                    });
                }
            );
            grid.appendChild(card);
        }
    }

    _makeStationCard(name, arm, unit, hint, setup) {
        const card = document.createElement('div');
        card.className = 'wb-station';
        card.innerHTML = `
            <div class="wb-station-name">${name}</div>
            <div class="wb-station-input-row">
                <input type="number" class="wb-station-input" min="0" step="1" inputmode="decimal">
                <span class="wb-station-unit">${unit}</span>
            </div>
            <div class="wb-station-arm">${arm}" arm${hint ? ' · ' + hint : ''}</div>
        `;
        const input = card.querySelector('input');
        setup(input);
        input.addEventListener('input', () => this._compute());
        return card;
    }

    /**
     * Pre-fill the Fuel station from the canonical live-fuel chain.
     *
     * SOURCE, not the number, decides whether there is anything to pre-fill.
     * `FuelState.getCurrentFuel()` returns `{gallons, source, stale}` and its
     * `capacity` source means nothing is tracked at all — it is a planning default
     * worth a full 36 gal / 216 lb of fuel that may not be in the aircraft. This
     * used to read `FuelState.getStartFuel()`, which never consults FuelTankState:
     * measured on this branch, dry tracked tanks (0.0 gal) and a normally tracked
     * 18.0 gal BOTH pre-filled 36.0, and a tracked 10.0 gal with the EDM totalizer
     * reading 30 pre-filled 30.0. Same canonical read as engine-page.js,
     * instrument-strip.js and route-table.js, so the four cannot disagree about how
     * much fuel is aboard.
     *
     * Nothing is lost by dropping the old chain's `tic` branch: both writers of
     * `Settings.fuelMeasurement` (fuel-overlay.js `_applyMeasurement` and its
     * fuel-stop path) call `FuelTankState.init()` in the same block, so a saved tic
     * measurement always leaves a tracked tank state behind it.
     *
     * When nothing is tracked the field is left EMPTY rather than fabricated, and
     * _renderResults() then refuses to publish an envelope verdict — a blank fuel
     * field makes the total weight read LOW, which is the one direction a W&B
     * display must never err in.
     */
    _syncFuelFromState() {
        if (!this._fuelInput) return;
        // Only the pilot's own entry is protected. An untouched pre-fill is re-read on
        // every open so it tracks burn instead of freezing at the ramp figure.
        if (this._fuelUserEdited) return;
        try {
            const read = (typeof FuelState !== 'undefined')
                ? FuelState.getCurrentFuel()
                : { gallons: 0, source: 'none', stale: false };
            const tracked = (read.source === 'manual' || read.source === 'tank_state');
            if (!tracked) {
                this._fuelInput.value = '';
                this._fuelStale = false;
                return;
            }
            this._fuelInput.value = Math.round(read.gallons * 10) / 10;
            // Staleness predicate is owned by FuelState.getCurrentFuel() (SDD Task 14).
            // A stale tracked figure reads HIGH — the burn during the >45 min gap was
            // never subtracted — so the weight it produces is not a measurement.
            this._fuelStale = !!read.stale;
        } catch (_) {
            this._fuelInput.value = '';
            this._fuelStale = false;
        }
    }

    /** True once the fuel quantity is established — pre-filled from a tracked source or
     *  typed by the pilot. An aircraft with no fuel station has nothing to establish. */
    _fuelQuantityKnown() {
        if (!this._fuelInput) return true;
        return String(this._fuelInput.value).trim() !== '';
    }

    /**
     * How far this loading can be trusted, decided entirely by the fuel figure.
     *
     *   missing — nothing tracked, so the field is blank and `_getFuelGal()` is 0. The
     *             total weight then EXCLUDES fuel and reads LOW, and the CG sits off the
     *             fuel arm: a reassuring-but-wrong answer, the one direction a W&B panel
     *             must never err in.
     *   stale   — the pre-filled tracked figure is >45 min old (see _syncFuelFromState);
     *             it reads HIGH by the burn that was never subtracted.
     *
     * Either way the numbers are still SHOWN — blanking them would throw away the pilot's
     * only starting point — but they are marked, and no green verdict is issued off them.
     * STALE-NEVER-GREEN, the rule engine-page.js, instrument-strip.js and route-table.js
     * already apply to their fuel figures.
     *
     * Both are suppressed until there is a payload at all: an untouched empty form is not
     * a wrong answer, and the "Enter weights to compute" placeholder already covers it.
     *
     * Shared by _renderResults and _renderChart so the badge and the CG dot cannot
     * disagree about whether this loading has been confirmed.
     */
    _fuelConfidence() {
        const hasPayload = Object.values(this._inputs).some(inp => parseFloat(inp?.value) > 0)
            || this._getFuelGal() > 0;
        const fuelMissing = hasPayload && !this._fuelQuantityKnown();
        const fuelStale   = hasPayload && !fuelMissing && !!this._fuelStale;
        return {
            hasPayload,
            fuelMissing,
            fuelStale,
            unconfirmed: fuelMissing || fuelStale,
            notice: fuelMissing
                ? '⚠ FUEL NOT ENTERED — this weight excludes fuel. Enter gallons aboard.'
                : fuelStale
                    ? '⚠ FUEL QUANTITY UNCONFIRMED — tank tracking is over 45 min stale and reads high. Verify before using this weight.'
                    : null,
        };
    }

    _getStationWeights() {
        const nonFuel = (this._profile.stations || []).filter(s => !s.fuel);
        const weights = {};
        nonFuel.forEach((station, i) => {
            const input = this._inputs[station.name];
            weights[i] = parseFloat(input?.value) || 0;
        });
        return weights;
    }

    _getFuelGal() {
        return parseFloat(this._fuelInput?.value) || 0;
    }

    _compute() {
        if (!this._profile) return;
        if (typeof WbCalculator === 'undefined') return;
        const stationWeights = this._getStationWeights();
        const fuelGal = this._getFuelGal();
        const result = WbCalculator.calculate(this._profile, stationWeights, fuelGal);
        this._renderResults(result);
        this._renderTable(result);
        this._renderChart(result);
    }

    _renderResults(r) {
        const maxGross = this._profile.max_gross_weight || 0;
        const limits = this._getEnvelopeLimitsAt(r.totalWeight);
        const fwdStr = limits ? limits.fwdLimit.toFixed(2) : '--';
        const aftStr = limits ? limits.aftLimit.toFixed(2) : '--';

        // hasPayload suppresses the envelope badge in the empty-aircraft state: the empty
        // CG legitimately sits outside the operating envelope, so a verdict is only issued
        // once the pilot has entered at least one non-zero station weight or fuel.
        // unconfirmed/notice carry the fuel-confidence decision — see _fuelConfidence().
        const { hasPayload, fuelMissing, unconfirmed, notice } = this._fuelConfidence();
        const markCls = unconfirmed ? ' wb-unconfirmed' : '';

        // Out-of-envelope stays red even when the fuel figure is unconfirmed. Red is not a
        // reassuring colour, and the exceedance is real either way: on this airframe the
        // fuel arm (76.75") sits forward of the fwd limit, so adding the missing fuel can
        // only move the CG further forward, and it can only add weight — an out-of-envelope
        // verdict computed without fuel is a valid lower bound in both directions.
        // An IN result, by contrast, is not: with no fuel figure there is no verdict to
        // give, so say so rather than printing a green-adjacent "IN ENVELOPE".
        const badgeCls = r.inEnvelope
            ? (unconfirmed ? 'wb-envelope-unconfirmed' : 'in-envelope')
            : 'out-of-envelope';
        const badgeText = !r.inEnvelope
            ? 'OUT OF ENVELOPE' + (r.envelopeReason ? ' — ' + r.envelopeReason : '')
            : fuelMissing
                ? 'NO VERDICT — ENTER FUEL QUANTITY'
                : unconfirmed
                    ? 'IN ENVELOPE — UNCONFIRMED FUEL'
                    : 'IN ENVELOPE';

        this._resultsEl.innerHTML = `
            <div class="wb-result-item">
                <div class="wb-result-label">Total Weight</div>
                <div class="wb-result-value${r.overGross ? ' wb-over-gross' : ''}${markCls}">${r.totalWeight.toLocaleString()}${unconfirmed ? '?' : ''} <span class="wb-result-unit">lb</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">CG</div>
                <div class="wb-result-value${markCls}">${r.cg.toFixed(2)}${unconfirmed ? '?' : ''}<span class="wb-result-unit">"</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">Max Gross</div>
                <div class="wb-result-value wb-result-secondary">${maxGross.toLocaleString()} <span class="wb-result-unit">lb</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">CG Limits</div>
                <div class="wb-result-value wb-result-secondary">${fwdStr}–${aftStr}<span class="wb-result-unit">"</span></div>
            </div>
            ${notice ? `
            <div class="wb-fuel-notice">${notice}</div>` : ''}
            ${hasPayload ? `
            <div class="wb-envelope-badge ${badgeCls}">
                ${badgeText}
            </div>` : `
            <div class="wb-envelope-badge" style="background:var(--bg-surface);color:var(--text-muted);border:1px solid var(--border)">
                Enter weights to compute
            </div>`}
        `;
    }

    // Returns interpolated {fwdLimit, aftLimit} at weight, or null if weight is
    // outside the envelope range (caller shows "--" rather than misleading in-range values).
    _getEnvelopeLimitsAt(weight) {
        const envelope = this._profile.cg_envelope || this._profile.envelope;
        if (!envelope || !Array.isArray(envelope) || envelope.length < 1) return null;
        const sorted = [...envelope].sort((a, b) => a.weight - b.weight);
        if (weight < sorted[0].weight || weight > sorted[sorted.length - 1].weight) return null;
        let lower = sorted[0], upper = sorted[sorted.length - 1];
        for (let i = 0; i < sorted.length - 1; i++) {
            if (weight >= sorted[i].weight && weight <= sorted[i + 1].weight) {
                lower = sorted[i]; upper = sorted[i + 1]; break;
            }
        }
        const range = upper.weight - lower.weight;
        const t = range > 0 ? (weight - lower.weight) / range : 0;
        return {
            fwdLimit: lower.fwd_cg + t * (upper.fwd_cg - lower.fwd_cg),
            aftLimit: lower.aft_cg + t * (upper.aft_cg - lower.aft_cg),
        };
    }

    _renderTable(r) {
        const rows = r.stations.map(s => `
            <tr>
                <td>${s.name}${s.gallons != null ? ` (${s.gallons} gal)` : ''}</td>
                <td>${s.weight.toLocaleString()}</td>
                <td>${s.arm.toFixed(2)}</td>
                <td>${s.moment.toFixed(0)}</td>
            </tr>
        `).join('');

        this._tableEl.innerHTML = `
            <table>
                <thead><tr><th>Station</th><th>Weight (lb)</th><th>Arm (in)</th><th>Moment</th></tr></thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr>
                        <td>TOTAL</td>
                        <td>${r.totalWeight.toLocaleString()}</td>
                        <td>${r.cg.toFixed(2)}</td>
                        <td>${r.totalMoment.toFixed(0)}</td>
                    </tr>
                </tfoot>
            </table>
        `;
    }

    _renderChart(r) {
        if (!window.Chart) return;

        // Use cached envelope polygon — computed once at init, never changes at runtime
        const envelopePoints = this._envelopePoints || [];
        const currentPoint = [{ x: r.cg, y: r.totalWeight }];
        // Chart.js can't read CSS vars; use design-system light-theme values directly.
        // STALE-NEVER-GREEN applies to the CG dot too — a green dot inside the polygon is
        // the most reassuring thing on this panel, and it must not appear for a loading
        // whose fuel figure is missing or stale. Caution amber (--color-caution) instead;
        // out-of-envelope stays red, which is not a reassuring colour.
        const unconfirmed = this._fuelConfidence().unconfirmed;
        const pointColor = !r.inEnvelope ? '#cc2222' : (unconfirmed ? '#b87000' : '#1a8c35');

        if (this._chart) {
            // Envelope polygon is static — only update the moving CG point
            this._chart.data.datasets[1].data = currentPoint;
            this._chart.data.datasets[1].borderColor = pointColor;
            this._chart.data.datasets[1].backgroundColor = pointColor;
            this._chart.update();
            return;
        }

        this._chart = new Chart(this._canvas, {
            type: 'scatter',
            data: {
                datasets: [
                    {
                        label: 'CG Envelope',
                        data: envelopePoints,
                        borderColor: '#0066cc',
                        backgroundColor: 'rgba(0, 102, 204, 0.08)',
                        showLine: true,
                        fill: true,
                        pointRadius: 0,
                        borderWidth: 2,
                        tension: 0,
                    },
                    {
                        label: 'Loaded CG',
                        data: currentPoint,
                        borderColor: pointColor,
                        backgroundColor: pointColor,
                        pointRadius: 8,
                        pointHoverRadius: 10,
                        showLine: false,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `CG: ${ctx.parsed.x.toFixed(2)}", Wt: ${ctx.parsed.y.toLocaleString()} lb`,
                        },
                    },
                },
                scales: {
                    x: {
                        title: { display: true, text: 'CG (inches aft datum)', font: { size: 12 } },
                        ticks: { font: { size: 11 } },
                    },
                    y: {
                        title: { display: true, text: 'Weight (lb)', font: { size: 12 } },
                        ticks: { font: { size: 11 } },
                    },
                },
            },
        });
    }
}
