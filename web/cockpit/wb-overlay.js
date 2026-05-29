/**
 * WbOverlay — Weight & Balance cockpit panel.
 * Reads aircraft W&B profile from aircraft-config.json (weight_balance block).
 * Uses WbCalculator for computation, Chart.js for the CG envelope diagram.
 */
class WbOverlay {
    constructor(container) {
        this._container = container;
        this._el       = null;
        this._chart    = null;
        this._profile  = null;
        this._inputs   = {};   // { stationName: <input element> }
        this._fuelInput = null;
        this._modal    = null;

        this._buildDOM();
    }

    show() {
        this._syncFuelFromState();
        this._compute();
        this._el.classList.add('visible');
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

        el.appendChild(body);
        this._container.appendChild(el);

        this._compute();
    }

    _buildStationInputs(grid) {
        const nonFuel = (this._profile.stations || []).filter(s => !s.fuel);
        const fuelStation = (this._profile.stations || []).find(s => s.fuel);

        nonFuel.forEach(station => {
            const card = this._makeStationCard(
                station.name,
                station.arm,
                'lb',
                '',
                (input) => {
                    this._inputs[station.name] = input;
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
                    input.value = '';
                    input.placeholder = '0';
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

    _syncFuelFromState() {
        if (!this._fuelInput) return;
        if (this._fuelInput.value) return;  // user already typed a value — keep it
        try {
            const fuel = FuelState.getStartFuel();
            if (fuel && fuel.gallons > 0) {
                this._fuelInput.value = Math.round(fuel.gallons * 10) / 10;
            }
        } catch (_) {}
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
        const stationWeights = this._getStationWeights();
        const fuelGal = this._getFuelGal();
        const result = WbCalculator.calculate(this._profile, stationWeights, fuelGal);
        this._renderResults(result);
        this._renderTable(result);
        this._renderChart(result);
    }

    _renderResults(r) {
        const maxGross = this._profile.max_gross_weight || 0;
        const { fwdLimit, aftLimit } = this._getEnvelopeLimitsAt(r.totalWeight);

        this._resultsEl.innerHTML = `
            <div class="wb-result-item">
                <div class="wb-result-label">Total Weight</div>
                <div class="wb-result-value${r.overGross ? ' wb-over-gross' : ''}">${r.totalWeight.toLocaleString()} <span class="wb-result-unit">lb</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">CG</div>
                <div class="wb-result-value">${r.cg.toFixed(2)}<span class="wb-result-unit">"</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">Max Gross</div>
                <div class="wb-result-value wb-result-secondary">${maxGross.toLocaleString()} <span class="wb-result-unit">lb</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">CG Limits</div>
                <div class="wb-result-value wb-result-secondary">${fwdLimit ? fwdLimit.toFixed(2) : '--'}–${aftLimit ? aftLimit.toFixed(2) : '--'}<span class="wb-result-unit">"</span></div>
            </div>
            <div class="wb-envelope-badge ${r.inEnvelope ? 'in-envelope' : 'out-of-envelope'}">
                ${r.inEnvelope ? '✅ IN ENVELOPE' : '❌ OUT OF ENVELOPE' + (r.envelopeReason ? ' — ' + r.envelopeReason : '')}
            </div>
        `;
    }

    _getEnvelopeLimitsAt(weight) {
        const envelope = this._profile.cg_envelope || this._profile.envelope;
        if (!envelope || !Array.isArray(envelope) || envelope.length < 1) return {};
        const sorted = [...envelope].sort((a, b) => a.weight - b.weight);
        const clamped = Math.max(sorted[0].weight, Math.min(sorted[sorted.length - 1].weight, weight));
        let lower = sorted[0], upper = sorted[sorted.length - 1];
        for (let i = 0; i < sorted.length - 1; i++) {
            if (clamped >= sorted[i].weight && clamped <= sorted[i + 1].weight) {
                lower = sorted[i]; upper = sorted[i + 1]; break;
            }
        }
        const range = upper.weight - lower.weight;
        const t = range > 0 ? (clamped - lower.weight) / range : 0;
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

        const envelopePoints = WbCalculator.getEnvelopePoints(
            this._profile.cg_envelope || this._profile.envelope
        );

        const currentPoint = [{ x: r.cg, y: r.totalWeight }];
        // Chart.js can't read CSS vars; use design-system light-theme values directly
        const pointColor = r.inEnvelope ? '#1a8c35' : '#cc2222';

        if (this._chart) {
            this._chart.data.datasets[0].data = envelopePoints;
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
