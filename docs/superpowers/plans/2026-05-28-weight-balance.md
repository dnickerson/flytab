# Weight & Balance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Weight & Balance overlay to FlyTab's MORE drawer that lets the pilot enter station weights, pre-populates fuel from the fuel state, computes CG and envelope status, and draws the CG envelope diagram using Chart.js.

**Architecture:** A new `WbOverlay` class (vanilla JS, follows the `FuelOverlay` pattern — fixed full-screen panel, `show()`/`hide()` methods, appended to `document.body`) reads the W&B aircraft profile from `aircraft-config.json`, accepts per-station weight inputs, calls the existing `WbCalculator.calculate()` (already in `web/shared/wb-calculator.js`), and renders results + a Chart.js scatter envelope chart. Aircraft-specific W&B data (empty weight, stations, envelope) is added to `aircraft-config.json`. A "⚖️ Weight & Balance" row is inserted into the MORE drawer's Pre/Post flight section.

**Tech Stack:** Vanilla JS, CSS, Chart.js (already loaded), `FuelState.getStartFuel()` for fuel pre-population. No new dependencies.

---

## File Map

| File | Change |
|------|--------|
| `web/aircraft-config.json` | Add `weight_balance` block (empty weight, stations, CG envelope) |
| `web/cockpit/wb-overlay.js` | **New** — `WbOverlay` class, full W&B UI |
| `web/style.css` | Add `.wb-overlay` and child CSS rules |
| `web/index.html` | Add `<script src="./cockpit/wb-overlay.js">` after `fuel-overlay.js` |
| `web/app.js` | Instantiate `WbOverlay`, add to TabBar comps |
| `web/cockpit/tab-bar.js` | Add W&B to MORE drawer rows; add `c.wbOverlay?.hide()` to close-all block |
| `docs/user-manual.md` | Document W&B in MORE → Pre/Post flight section |

---

## Task 1: Aircraft W&B Config

**Files:**
- Modify: `web/aircraft-config.json`

### Overview
Add the `weight_balance` section to `aircraft-config.json` for RV-9A N194JT. These values are from the existing aircraft profile in the flywhere database for this specific aircraft. **Verify all values against the actual POH before flying.**

The `WbCalculator.calculate()` signature is:
```
calculate(profile, stationWeights, fuelGallons)
  profile.empty_weight  — lbs
  profile.empty_cg      — inches aft of datum
  profile.max_gross_weight — lbs
  profile.stations[]    — { name, arm, fuel?, gal_to_lbs? }
  profile.cg_envelope[] — { weight, fwd_cg, aft_cg }
```
Non-fuel stations are keyed by their 0-based index among non-fuel stations only.

- [ ] **Step 1.1 — Add `weight_balance` block to `web/aircraft-config.json`**

Open `web/aircraft-config.json` and add the following top-level key after `"performance"`:

```json
  "weight_balance": {
    "empty_weight": 1034,
    "empty_cg": 76.34,
    "max_gross_weight": 1800,
    "stations": [
      { "name": "Pilot",     "arm": 92.7,  "max_weight": 400 },
      { "name": "Passenger", "arm": 92.7,  "max_weight": 400 },
      { "name": "Baggage",   "arm": 122.0, "max_weight": 50  },
      { "name": "Fuel",      "arm": 76.75, "fuel": true, "gal_to_lbs": 6, "max_gal": 36 }
    ],
    "cg_envelope": [
      { "weight": 1034, "fwd_cg": 77.95, "aft_cg": 84.84 },
      { "weight": 1750, "fwd_cg": 77.95, "aft_cg": 84.84 }
    ]
  }
```

The `Fuel` station has `"fuel": true` so `WbCalculator` handles it via `fuelGallons` parameter, not `stationWeights`.

- [ ] **Step 1.2 — Verify JSON is valid**

```bash
cd /home/dananickerson/flytab
node -e "JSON.parse(require('fs').readFileSync('web/aircraft-config.json','utf8')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 1.3 — Commit**

```bash
git add web/aircraft-config.json
git commit -m "feat(wb): add weight_balance config to aircraft-config.json (RV-9A N194JT)"
```

---

## Task 2: CSS

**Files:**
- Modify: `web/style.css`

### Overview
The overlay uses the same full-screen fixed pattern as `FuelOverlay`. The inner layout has a header, a two-column station grid, a results bar, and a Chart.js canvas.

- [ ] **Step 2.1 — Add W&B overlay CSS to `web/style.css`**

Append the following block near the bottom of `web/style.css`, before the `body.compact-strips` block:

```css
/* ========== Weight & Balance Overlay ========== */

.wb-overlay {
    position: fixed;
    inset: 0;
    bottom: var(--tab-bar-height);
    z-index: 9000;
    background: var(--bg-primary);
    display: none;
    flex-direction: column;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
}

.wb-overlay.visible {
    display: flex;
}

.wb-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 2px solid var(--border-strong);
    flex-shrink: 0;
    background: var(--bg-surface);
}

.wb-title {
    font-size: 18px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-primary);
    letter-spacing: 0.5px;
}

.wb-body {
    flex: 1;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 600px;
    width: 100%;
    margin: 0 auto;
}

.wb-stations {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
}

.wb-station {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.wb-station-name {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.5px;
}

.wb-station-input-row {
    display: flex;
    align-items: center;
    gap: 8px;
}

.wb-station-input {
    flex: 1;
    font-size: 26px;
    font-weight: 700;
    color: var(--text-primary);
    background: transparent;
    border: none;
    border-bottom: 2px solid var(--border-strong);
    padding: 4px 0;
    width: 100%;
    min-height: 48px;
    text-align: right;
    outline: none;
    -webkit-appearance: none;
}

.wb-station-unit {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
    min-width: 28px;
}

.wb-station-arm {
    font-size: 12px;
    color: var(--text-muted);
}

.wb-results {
    background: var(--bg-surface);
    border: 2px solid var(--border-strong);
    border-radius: 10px;
    padding: 14px 16px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
}

.wb-result-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
}

.wb-result-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.5px;
}

.wb-result-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    font-family: var(--font-instrument, monospace);
}

.wb-result-value.wb-over-gross {
    color: var(--warn-red, #e53e3e);
}

.wb-envelope-badge {
    grid-column: 1 / -1;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 16px;
    font-weight: 700;
    text-align: center;
    letter-spacing: 0.5px;
}

.wb-envelope-badge.in-envelope {
    background: rgba(56, 161, 105, 0.15);
    color: #276749;
    border: 2px solid rgba(56, 161, 105, 0.4);
}

.wb-envelope-badge.out-of-envelope {
    background: rgba(229, 62, 62, 0.15);
    color: #c53030;
    border: 2px solid rgba(229, 62, 62, 0.4);
}

.wb-chart-container {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    position: relative;
    height: 240px;
}

.wb-chart-container canvas {
    max-height: 100%;
}

.wb-moment-table {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
}

.wb-moment-table table {
    width: 100%;
    border-collapse: collapse;
    font-size: 15px;
}

.wb-moment-table th {
    padding: 8px 12px;
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
}

.wb-moment-table th:not(:first-child) {
    text-align: right;
}

.wb-moment-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-light);
    color: var(--text-primary);
    font-family: var(--font-instrument, monospace);
}

.wb-moment-table td:not(:first-child) {
    text-align: right;
}

.wb-moment-table tr:last-child td {
    border-bottom: none;
    font-weight: 700;
    background: var(--bg-primary);
}
```

- [ ] **Step 2.2 — Commit**

```bash
git add web/style.css
git commit -m "style: add weight-balance overlay CSS"
```

---

## Task 3: WbOverlay Component

**Files:**
- Create: `web/cockpit/wb-overlay.js`

### Overview
`WbOverlay` follows the `FuelOverlay` pattern: constructor appends to `document.body`, `show()`/`hide()` toggle the `visible` class, `WbCalculator.calculate()` recomputes on every input change. Chart.js is already loaded as a global (`window.Chart`). Aircraft profile comes from `CockpitConfig.aircraft('weight_balance')` (reads `aircraft-config.json`).

The station inputs are indexed across **non-fuel stations only** for `stationWeights`. Fuel station is handled separately.

- [ ] **Step 3.1 — Create `web/cockpit/wb-overlay.js`**

```javascript
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

        // Non-fuel stations
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

        // Fuel station
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
        const overGross = r.overGross;
        const { fwdLimit, aftLimit } = this._getEnvelopeLimitsAt(r.totalWeight);

        this._resultsEl.innerHTML = `
            <div class="wb-result-item">
                <div class="wb-result-label">Total Weight</div>
                <div class="wb-result-value${overGross ? ' wb-over-gross' : ''}">${r.totalWeight.toLocaleString()} <span style="font-size:14px;font-weight:600">lb</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">CG</div>
                <div class="wb-result-value">${r.cg.toFixed(2)}<span style="font-size:14px;font-weight:600">"</span></div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">Max Gross</div>
                <div class="wb-result-value" style="font-size:18px">${maxGross.toLocaleString()} lb</div>
            </div>
            <div class="wb-result-item">
                <div class="wb-result-label">CG Limits</div>
                <div class="wb-result-value" style="font-size:16px">${fwdLimit ? fwdLimit.toFixed(2) : '--'}–${aftLimit ? aftLimit.toFixed(2) : '--'}"</div>
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
        const pointColor = r.inEnvelope ? '#38a169' : '#e53e3e';

        if (this._chart) {
            // Update existing chart datasets
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
                        borderColor: 'rgba(0, 130, 200, 0.8)',
                        backgroundColor: 'rgba(0, 130, 200, 0.08)',
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
```

- [ ] **Step 3.2 — Commit**

```bash
git add web/cockpit/wb-overlay.js
git commit -m "feat(wb): WbOverlay cockpit panel — station inputs, CG calc, envelope chart"
```

---

## Task 4: Wire into App

**Files:**
- Modify: `web/index.html` (add `<script>` tag)
- Modify: `web/app.js` (instantiate + pass to TabBar)

### Overview
`WbOverlay` is instantiated alongside other overlays in `app.js` and passed into `TabBar`'s components map. The `close-all` block in `_selectTab` must also hide it.

- [ ] **Step 4.1 — Add script tag to `web/index.html`**

In `web/index.html`, find the line:
```html
<script src="./cockpit/fuel-overlay.js"></script>
```

Add the new script tag immediately after it:
```html
<script src="./cockpit/fuel-overlay.js"></script>
<script src="./cockpit/wb-overlay.js"></script>
```

- [ ] **Step 4.2 — Instantiate WbOverlay in `web/app.js`**

In `web/app.js`, find the block that constructs `FuelOverlay` (~line 575):
```javascript
if (typeof FuelOverlay !== 'undefined') {
    this.fuelOverlay = new FuelOverlay(document.body);
    this.cockpitMap.setFuelOverlay(this.fuelOverlay);
}
```

Add the following immediately after it:
```javascript
if (typeof WbOverlay !== 'undefined') {
    this.wbOverlay = new WbOverlay(document.body);
}
```

- [ ] **Step 4.3 — Add `wbOverlay` to TabBar comps**

Find the `new TabBar({...})` call (~line 897). Add `wbOverlay: this.wbOverlay` after `layerPanel: this.layerPanel`:

```javascript
this.tabBar = new TabBar({
    enginePage: this.enginePage,
    checklist: this.checklist,
    logbook: this.logbook,
    approachCharts: this.approachCharts,
    fuelOverlay: this.fuelOverlay,
    dataStatus: this.dataStatus,
    fisbStatus: this.fisbStatus,
    configEditor: this.configEditor,
    ifrClearance: this.ifrClearance,
    wxBriefing: this.wxBriefing,
    trackLog: this.trackLog,
    airportPopup: this.airportPopup,
    stratuxIp: Settings.stratuxIp || '192.168.10.1',
    planSync: this.planSync,
    radarLoop: this.radarLoop,
    flightUpload: this.flightUpload,
    routeTable: this.routeTable,
    layerPanel: this.layerPanel,
    everywhereSearch: this.everywhereSearch,
    wbOverlay: this.wbOverlay,
});
```

- [ ] **Step 4.4 — Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat(wb): instantiate WbOverlay and wire into TabBar comps"
```

---

## Task 5: MORE Drawer Entry + Close-All Hook

**Files:**
- Modify: `web/cockpit/tab-bar.js`

### Overview
Add "⚖️ Weight & Balance" to the MORE drawer's "Pre / Post flight" section after "Weather Briefing". Add `c.wbOverlay?.hide()` to the close-all prologue in `_selectTab` so navigating to another tab closes the overlay.

- [ ] **Step 5.1 — Add W&B to MORE drawer rows**

In `web/cockpit/tab-bar.js`, in `_buildMoreDrawer()`, find the "Weather Briefing" entry:

```javascript
{ icon: '⛅', label: 'Weather Briefing', action: () => {
    if (c.wxBriefing?.show) c.wxBriefing.show();
    this._hideRadarControls();
    this._closeMoreDrawer();
}},
```

Add the W&B row immediately after it:

```javascript
{ icon: '⚖️', label: 'Weight & Balance', action: () => {
    if (c.wbOverlay?.show) c.wbOverlay.show();
    this._hideRadarControls();
    this._closeMoreDrawer();
}},
```

- [ ] **Step 5.2 — Add `wbOverlay?.hide()` to the close-all prologue**

In `_selectTab()`, find the close-all block:

```javascript
if (c.fuelOverlay?.hide) c.fuelOverlay.hide();
```

Add the following line immediately after it:

```javascript
if (c.wbOverlay?.hide) c.wbOverlay.hide();
```

- [ ] **Step 5.3 — Commit**

```bash
git add web/cockpit/tab-bar.js
git commit -m "feat(wb): add Weight & Balance to MORE drawer, wire close-all"
```

---

## Task 6: Build, Version Bump, and User Manual

**Files:**
- Modify: `web/app.js` (version bump)
- Modify: `docs/user-manual.md`

- [ ] **Step 6.1 — Increment `FLYTAB_VERSION`**

In `web/app.js` line 6, change `v9.25` → `v9.26`.

- [ ] **Step 6.2 — Build**

```bash
bash build.sh
```

Expected: `BUILD SUCCESSFUL`, APK `flytab-debug-v9.26.apk`.

- [ ] **Step 6.3 — Update user manual**

In `docs/user-manual.md`, find the MORE drawer section under Pre/Post flight items. After the Weather Briefing row, add:

```
| **Weight & Balance** | Enter station weights and fuel; shows total weight, CG, and envelope status with a CG diagram |
```

- [ ] **Step 6.4 — Commit**

```bash
git add web/app.js docs/user-manual.md
git commit -m "chore: bump v9.26, document W&B in user manual"
```

---

## Smoke Test Checklist

Install `flytab-debug-v9.26.apk` on the Yoga Tab Plus and verify:

1. **MORE → Weight & Balance** opens a full-screen panel
2. **Fuel field pre-populated** from fuel state (if fuel data is set); otherwise shows 0
3. **Enter pilot weight** (e.g. 180): total weight and CG update immediately
4. **CG envelope diagram** shows the envelope polygon and a dot for the current loading
5. **Moment table** shows all stations with correct arm and moment values
6. **Over-gross indicator**: set very high weights → "OUT OF ENVELOPE" badge turns red
7. **✕ button** closes the overlay
8. **Tapping any other tab** also closes the overlay
9. **No JS console errors** — especially no `WbCalculator is not defined` or Chart.js errors

---

## Notes

- **Verify W&B data against POH before flying.** The values in Task 1 come from the aircraft's profile in the flywhere database and are believed correct for N194JT, but must be confirmed against the actual Vans RV-9A POH for this specific aircraft.
- The fuel arm in `aircraft-config.json` (`76.75"`) is the combined left+right tank moment arm. If the tanks have meaningfully different arms, split them into two fuel stations.
- `WbCalculator.estimateLandingWeight()` (already in `wb-calculator.js`) is available for a future enhancement showing projected landing CG after planned fuel burn from the route.
