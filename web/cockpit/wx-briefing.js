/**
 * FlyPi — Weather Briefing Panel
 * Route weather timeline using NOAA GFS MOS (MAV short-range + MEX extended).
 *
 * Two display modes:
 *   7-DAY  — one column per day, worst flight category during prime flying hours.
 *            MEX data extends to day 8. Useful for "which day should I fly?"
 *   24H    — one column per 3h period, next 24h from MAV data.
 *            Detailed ceiling / vis / wind per period.
 *
 * Go/No-Go summary bar shows the planned day vs. alternatives at a glance.
 * Tap any airport row to expand full MOS detail table.
 */
class WxBriefing {
    constructor(db) {
        this._db          = db;
        this._el          = null;
        this._flightPlan  = null;
        this._mosData     = null;   // raw API response: { fetched_at, stations: { ICAO: {...} } }
        this._mode        = 'day'; // 'day' | 'hour'
        this._loading     = false;
        this._expandedIcao = null;
        this.visible      = false;
    }

    init() {
        this._buildPanel();
    }

    show() {
        if (!this._el) this.init();
        this._el.classList.add('visible');
        this.visible = true;
        // Load MOS from cached flight plan if not yet fetched
        if (!this._mosData && this._flightPlan?.weather_cache?.mos) {
            this._mosData = this._flightPlan.weather_cache.mos;
        }
        this._render();
    }

    hide() {
        this._el?.classList.remove('visible');
        this.visible = false;
    }

    setFlightPlan(plan) {
        this._flightPlan = plan;
        if (plan?.weather_cache?.mos) {
            this._mosData = plan.weather_cache.mos;
        }
        if (this.visible) this._render();
    }

    // ── Panel construction ────────────────────────────────────────────────────

    _buildPanel() {
        this._el = document.createElement('div');
        this._el.className = 'wx-briefing-page';
        this._el.innerHTML = `
            <div class="wx-briefing-header">
                <button class="wx-close-btn" aria-label="Close">✕</button>
                <span class="wx-briefing-title">⛅ Weather</span>
                <div class="wx-mode-toggle">
                    <button class="wx-mode-btn active" data-mode="day">7-DAY</button>
                    <button class="wx-mode-btn" data-mode="hour">24H</button>
                </div>
                <button class="wx-refresh-btn" title="Fetch fresh MOS data">↻</button>
            </div>
            <div class="wx-briefing-body">
                <div class="wx-briefing-content"></div>
            </div>
        `;

        this._el.querySelector('.wx-close-btn').addEventListener('click', () => this.hide());
        this._el.querySelector('.wx-refresh-btn').addEventListener('click', () => this._fetchMos());

        this._el.querySelectorAll('.wx-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._mode = btn.dataset.mode;
                this._el.querySelectorAll('.wx-mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._render();
            });
        });

        (document.getElementById('mainContent') || document.body).appendChild(this._el);
    }

    // ── Data fetching ─────────────────────────────────────────────────────────

    async _fetchMos() {
        const stations = this._getStationList();
        if (!stations.length) {
            this._showMessage('Load a flight plan to fetch MOS data.');
            return;
        }

        this._loading = true;
        this._render();

        try {
            const ids = stations.join(',');
            const base = Settings.workerBase || 'https://flywhere.app/api';
            const resp = await fetch(`${base}/mos?ids=${ids}`, { signal: AbortSignal.timeout(5000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._mosData = data;

            // Cache in flight plan for offline use
            if (this._flightPlan) {
                if (!this._flightPlan.weather_cache) this._flightPlan.weather_cache = {};
                this._flightPlan.weather_cache.mos = data;
                // Persist to Pi if sync available
                if (window.flightSync?.savePlan) {
                    window.flightSync.savePlan(this._flightPlan).catch(() => {});
                }
            }
        } catch (err) {
            console.error('MOS fetch failed:', err);
            this._showMessage(`Failed to fetch MOS: ${err.message}`);
        } finally {
            this._loading = false;
            this._render();
        }
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    _render() {
        const content = this._el?.querySelector('.wx-briefing-content');
        if (!content) return;
        content.innerHTML = '';

        if (this._loading) {
            content.innerHTML = '<div class="wx-loading">Fetching MOS data…</div>';
            return;
        }

        const stations = this._getStationList();
        if (!stations.length) {
            content.innerHTML = '<div class="wx-empty">No flight plan loaded.<br>Load a plan to see weather.</div>';
            return;
        }

        // Summary bar
        content.appendChild(this._buildSummaryBar(stations));

        if (!this._mosData) {
            const hint = document.createElement('div');
            hint.className = 'wx-empty';
            hint.innerHTML = 'No MOS data cached.<br>Tap ↻ to fetch (requires internet).';
            content.appendChild(hint);
            return;
        }

        // Age notice
        const fetched = this._mosData.fetched_at;
        if (fetched) {
            const ageMin = Math.round((Date.now() - new Date(fetched)) / 60000);
            const ageEl = document.createElement('div');
            ageEl.className = 'wx-age-notice';
            ageEl.textContent = `NWS forecast ${ageMin < 60 ? ageMin + 'm' : Math.round(ageMin / 60) + 'h'} old · Days 6-8 trend only`;
            content.appendChild(ageEl);
        }

        // Timeline grid
        if (this._mode === 'day') {
            content.appendChild(this._buildDayGrid(stations));
        } else {
            content.appendChild(this._buildHourGrid(stations));
        }

        // Expanded airport detail
        if (this._expandedIcao) {
            const detail = this._buildAirportDetail(this._expandedIcao);
            if (detail) content.appendChild(detail);
        }
    }

    _showMessage(msg) {
        const content = this._el?.querySelector('.wx-briefing-content');
        if (!content) return;
        const el = document.createElement('div');
        el.className = 'wx-empty';
        el.textContent = msg;
        content.appendChild(el);
    }

    // ── Summary bar ───────────────────────────────────────────────────────────

    _buildSummaryBar(stations) {
        const bar = document.createElement('div');
        bar.className = 'wx-summary-bar';

        const plan = this._flightPlan;
        const dep  = stations[0];
        const dest = stations[stations.length - 1];

        const routeLabel = dep !== dest ? `${dep} → ${dest}` : dep;
        bar.innerHTML = `<span class="wx-summary-route">${routeLabel}</span>`;

        if (!this._mosData) {
            bar.innerHTML += '<span class="wx-summary-status wx-status-unknown">No data</span>';
            return bar;
        }

        // Find best day for the route: all airports VFR during prime hours
        const bestDay = this._findBestDay(stations);
        if (bestDay) {
            const label = this._dayLabel(bestDay.date);
            const isCurrent = this._isSameDay(bestDay.date, new Date());
            bar.innerHTML += `<span class="wx-summary-status wx-status-vfr">${isCurrent ? 'Today' : label}: ${bestDay.worstCat}</span>`;
        }

        return bar;
    }

    // ── 7-Day grid ────────────────────────────────────────────────────────────

    _buildDayGrid(stations) {
        const wrapper = document.createElement('div');
        wrapper.className = 'wx-grid-wrapper';

        // Collect 7 days of UTC dates starting from today
        const days = [];
        const now = new Date();
        for (let d = 0; d < 7; d++) {
            const dt = new Date(now);
            dt.setUTCDate(now.getUTCDate() + d);
            dt.setUTCHours(0, 0, 0, 0);
            days.push(dt);
        }

        // Header row
        const grid = document.createElement('div');
        grid.className = 'wx-grid';
        grid.style.gridTemplateColumns = `80px repeat(${days.length}, 1fr)`;

        // Corner cell
        grid.appendChild(this._cell('', 'wx-grid-corner'));

        // Day headers
        for (const day of days) {
            const isToday = this._isSameDay(day, now);
            const h = this._cell(this._dayLabel(day, true), 'wx-grid-header' + (isToday ? ' wx-today' : ''));
            grid.appendChild(h);
        }

        // Airport rows
        for (const icao of stations) {
            const stationData = this._mosData?.stations?.[icao];
            const isExpanded = this._expandedIcao === icao;

            // Airport label cell
            const labelCell = document.createElement('div');
            labelCell.className = 'wx-grid-label' + (isExpanded ? ' wx-label-active' : '');
            labelCell.textContent = icao;
            labelCell.addEventListener('click', () => {
                this._expandedIcao = isExpanded ? null : icao;
                this._render();
            });
            grid.appendChild(labelCell);

            // Day cells
            for (const day of days) {
                const cat = this._worstCatForDay(stationData, day);
                const isToday = this._isSameDay(day, now);
                const cell = document.createElement('div');
                cell.className = `wx-grid-cell wx-cat-${(cat || 'unknown').toLowerCase()}${isToday ? ' wx-today-col' : ''}`;
                if (!stationData || stationData.error) {
                    cell.classList.add('wx-cat-unknown');
                    cell.textContent = '—';
                } else if (!cat) {
                    cell.textContent = '—';
                    cell.classList.add('wx-cat-unknown');
                } else {
                    cell.textContent = cat === 'MVFR' ? 'MVF' : cat;
                    // Check reliability (MEX days 4+)
                    const reliable = this._isDayReliable(stationData, day);
                    if (!reliable) cell.classList.add('wx-cell-mex');
                }
                // Click to jump to hour view for this day
                cell.addEventListener('click', () => {
                    this._expandedIcao = icao;
                    this._render();
                });
                grid.appendChild(cell);
            }
        }

        // T-storm row
        const tsRow = this._buildTstormRow(stations, days);
        if (tsRow) {
            for (const el of tsRow) grid.appendChild(el);
        }

        wrapper.appendChild(grid);
        return wrapper;
    }

    // ── 24H grid ──────────────────────────────────────────────────────────────

    _buildHourGrid(stations) {
        const wrapper = document.createElement('div');
        wrapper.className = 'wx-grid-wrapper';

        // Get the next 24h worth of periods from MAV data
        const now = new Date();
        const cutoff = new Date(now.getTime() + 27 * 3600000); // 27h window

        // Collect all unique valid times across stations
        const timesSet = new Set();
        for (const icao of stations) {
            const sd = this._mosData?.stations?.[icao];
            if (!sd?.periods) continue;
            for (const p of sd.periods) {
                if (!p.valid_time) continue;
                const vt = new Date(p.valid_time);
                if (vt >= now && vt <= cutoff) timesSet.add(p.valid_time);
            }
        }
        const times = [...timesSet].sort();

        if (!times.length) {
            const el = document.createElement('div');
            el.className = 'wx-empty';
            el.textContent = 'No 24h MOS periods available. Fetch fresh data.';
            wrapper.appendChild(el);
            return wrapper;
        }

        const grid = document.createElement('div');
        grid.className = 'wx-grid wx-grid-hour';
        grid.style.gridTemplateColumns = `80px repeat(${times.length}, 80px)`;

        // Corner
        grid.appendChild(this._cell('', 'wx-grid-corner'));

        // Time headers
        for (const vt of times) {
            const dt = new Date(vt);
            const h = dt.getUTCHours();
            const label = `${String(h).padStart(2, '0')}Z`;
            grid.appendChild(this._cell(label, 'wx-grid-header'));
        }

        // Airport rows
        for (const icao of stations) {
            const sd = this._mosData?.stations?.[icao];
            const isExpanded = this._expandedIcao === icao;

            const labelCell = document.createElement('div');
            labelCell.className = 'wx-grid-label' + (isExpanded ? ' wx-label-active' : '');
            labelCell.textContent = icao;
            labelCell.addEventListener('click', () => {
                this._expandedIcao = isExpanded ? null : icao;
                this._render();
            });
            grid.appendChild(labelCell);

            // Build period lookup for this station
            const periodMap = {};
            if (sd?.periods) {
                for (const p of sd.periods) {
                    if (p.valid_time) periodMap[p.valid_time] = p;
                }
            }

            for (const vt of times) {
                const p = periodMap[vt];
                const cell = document.createElement('div');
                const cat = p?.flight_cat;
                cell.className = `wx-grid-cell wx-cat-${(cat || 'unknown').toLowerCase()}`;

                if (!p || !cat) {
                    cell.textContent = '—';
                    cell.classList.add('wx-cat-unknown');
                } else {
                    const wind = (p.wdr != null && p.wsp != null)
                        ? `${String(Math.round(p.wdr / 10) * 10).padStart(3, '0')}/${p.wsp}`
                        : '';
                    const cig = p.cig_label ?? (p.cld === 'BK' ? 'BKN' : p.cld === 'OV' ? 'OVC' : null);
                    const vis = p.vis_label ?? null;
                    const tp = p.tp6 ?? p.tp12 ?? null;
                    const obv = (p.obv && p.obv !== 'N') ? p.obv : null;
                    const pop = p.pop != null && p.pop >= 20 ? p.pop : null;
                    cell.innerHTML = `
                        <span class="wx-cell-cat">${cat === 'MVFR' ? 'MVF' : cat}</span>
                        ${cig ? `<span class="wx-cell-detail">${cig}</span>` : ''}
                        ${vis ? `<span class="wx-cell-detail">${vis}</span>` : ''}
                        ${wind ? `<span class="wx-cell-detail">${wind}</span>` : ''}
                        ${obv ? `<span class="wx-cell-detail wx-cell-obv">${obv}</span>` : ''}
                        ${pop != null ? `<span class="wx-cell-detail wx-cell-pop">${pop}%</span>` : ''}
                        ${tp != null ? `<span class="wx-cell-tstorm">⛈${tp}%</span>` : ''}
                    `;
                }
                grid.appendChild(cell);
            }
        }

        wrapper.appendChild(grid);
        return wrapper;
    }

    // ── T-storm row (day grid) ────────────────────────────────────────────────

    _buildTstormRow(stations, days) {
        // Only show if any station has TP > 10%
        let hasAny = false;
        const maxByDay = days.map(day => {
            let max = 0;
            for (const icao of stations) {
                const sd = this._mosData?.stations?.[icao];
                if (!sd?.periods) continue;
                for (const p of sd.periods) {
                    if (!p.valid_time || !this._isSameDay(new Date(p.valid_time), day)) continue;
                    const tp = p.tp6 ?? p.tp12 ?? 0;
                    if (tp > max) max = tp;
                }
            }
            if (max >= 10) hasAny = true;
            return max;
        });

        if (!hasAny) return null;

        const cells = [];
        cells.push(this._cell('T-stm', 'wx-grid-label wx-tstorm-label'));

        for (let i = 0; i < days.length; i++) {
            const pct = maxByDay[i];
            const cell = document.createElement('div');
            cell.className = 'wx-grid-cell wx-tstorm-cell';
            if (pct >= 40) {
                cell.classList.add('wx-tstorm-high');
                cell.textContent = `⛈${pct}%`;
            } else if (pct >= 20) {
                cell.classList.add('wx-tstorm-med');
                cell.textContent = `⛈${pct}%`;
            } else if (pct >= 10) {
                cell.classList.add('wx-tstorm-low');
                cell.textContent = `${pct}%`;
            } else {
                cell.textContent = '';
            }
            cells.push(cell);
        }

        return cells;
    }

    // ── Airport detail table ──────────────────────────────────────────────────

    _buildAirportDetail(icao) {
        const sd = this._mosData?.stations?.[icao];
        if (!sd?.periods?.length) return null;

        const section = document.createElement('div');
        section.className = 'wx-detail-section';

        const title = document.createElement('div');
        title.className = 'wx-detail-title';
        title.innerHTML = `<strong>${icao}</strong> — MOS Detail
            <button class="wx-detail-close">✕</button>`;
        title.querySelector('.wx-detail-close').addEventListener('click', () => {
            this._expandedIcao = null;
            this._render();
        });
        section.appendChild(title);

        const table = document.createElement('table');
        table.className = 'wx-detail-table';

        const headers = ['Time', 'Local', 'Cat', 'Ceil', 'Vis', 'Wind', 'Type', 'Precip%', 'T-stm%', 'Mix Ht', 'Tmp', 'Dew'];
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const now = new Date();
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        let lastLocalDate = null;

        for (const p of sd.periods) {
            if (!p.valid_time) continue;
            const vt = new Date(p.valid_time);
            const isPast = vt < now;
            if (isPast) continue; // skip past periods

            // Day separator when local date changes
            const localDate = `${vt.getFullYear()}/${vt.getMonth()}/${vt.getDate()}`;
            if (lastLocalDate !== null && localDate !== lastLocalDate) {
                const sep = document.createElement('tr');
                sep.className = 'wx-day-separator';
                const dayName = dayNames[vt.getDay()];
                const mm = String(vt.getMonth() + 1).padStart(2, '0');
                const dd = String(vt.getDate()).padStart(2, '0');
                sep.innerHTML = `<td colspan="${headers.length}">${dayName} ${mm}/${dd}</td>`;
                tbody.appendChild(sep);
            }
            lastLocalDate = localDate;

            const row = document.createElement('tr');
            if (!p.reliable) row.classList.add('wx-row-mex');

            const timeLabel = `${String(vt.getUTCMonth() + 1).padStart(2, '0')}/${String(vt.getUTCDate()).padStart(2, '0')} ${String(vt.getUTCHours()).padStart(2, '0')}Z`;
            const localHH = String(vt.getHours()).padStart(2, '0');
            const localMM = String(vt.getMinutes()).padStart(2, '0');
            const localLabel = `${localHH}:${localMM}L`;
            const wdStr = p.wdr != null ? String(Math.round(p.wdr / 10) * 10).padStart(3, '0') : null;
            const wind = (wdStr != null && p.wsp != null)
                ? (p.wgst && p.wgst > p.wsp ? `${wdStr}/${p.wsp}G${p.wgst}kt` : `${wdStr}/${p.wsp}kt`)
                : '—';
            const tp = p.tp6 ?? p.tp12 ?? null;
            const pop = p.pop ?? null;
            const mixHt = p.mix_ht != null ? `${p.mix_ht.toLocaleString()}ft` : '—';

            row.innerHTML = `
                <td class="wx-dt">${timeLabel}</td>
                <td class="wx-dt wx-dt-local">${localLabel}</td>
                <td class="wx-cat-badge wx-cat-${(p.flight_cat || 'unknown').toLowerCase()}">${p.flight_cat || '—'}</td>
                <td>${p.cig_label ?? (p.cld === 'BK' ? 'BKN' : p.cld === 'OV' ? 'OVC' : '—')}</td>
                <td>${p.vis_label || '—'}</td>
                <td>${wind}</td>
                <td>${p.obv && p.obv !== 'N' ? p.obv : (p.typ || '—')}</td>
                <td class="${pop >= 50 ? 'wx-val-caution' : ''}">${pop !== null ? pop + '%' : '—'}</td>
                <td class="${tp >= 40 ? 'wx-val-danger' : tp >= 20 ? 'wx-val-caution' : ''}">${tp !== null ? tp + '%' : '—'}</td>
                <td class="wx-dt">${mixHt}</td>
                <td>${p.tmp != null ? p.tmp + '°' : '—'}</td>
                <td>${p.dpt != null ? p.dpt + '°' : '—'}</td>
            `;
            tbody.appendChild(row);
        }

        table.appendChild(tbody);
        section.appendChild(table);
        return section;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _getStationList() {
        const plan = this._flightPlan;
        if (!plan) return [];
        // Extract ICAO codes from waypoints (same structure used by approach charts)
        const wps = plan.waypoints || [];
        const icaos = wps.map(wp => wp.icao).filter(id => id && /^[A-Z]{3,4}$/.test(id));
        if (icaos.length) return icaos;
        // Fallback: departure/destination strings
        const list = [];
        if (plan.departure) list.push(plan.departure);
        if (plan.destination && plan.destination !== plan.departure) list.push(plan.destination);
        return list;
    }

    /**
     * Worst flight category for a station on a given UTC day,
     * considering only prime flying hours (15Z–03Z, ~11AM–11PM Eastern).
     */
    _worstCatForDay(stationData, day) {
        if (!stationData?.periods) return null;
        const order = ['LIFR', 'IFR', 'MVFR', 'VFR'];
        let worst = null;

        const dayStart = new Date(day);
        dayStart.setUTCHours(15, 0, 0, 0); // 15Z = ~11AM Eastern
        const dayEnd   = new Date(day);
        dayEnd.setUTCHours(27, 0, 0, 0);   // next day 03Z = ~11PM Eastern

        for (const p of stationData.periods) {
            if (!p.valid_time || !p.flight_cat) continue;
            const vt = new Date(p.valid_time);
            if (vt < dayStart || vt >= dayEnd) continue;
            if (!worst || order.indexOf(p.flight_cat) < order.indexOf(worst)) {
                worst = p.flight_cat;
            }
        }
        return worst;
    }

    _isDayReliable(stationData, day) {
        if (!stationData?.periods) return true;
        const dayStart = new Date(day);
        dayStart.setUTCHours(15, 0, 0, 0);
        for (const p of stationData.periods) {
            if (!p.valid_time) continue;
            if (new Date(p.valid_time) >= dayStart && !p.reliable) return false;
        }
        return true;
    }

    /** Max thunderstorm probability on a given day across all stations */
    _maxTstormForDay(stations, day) {
        let max = 0;
        const dayStart = new Date(day); dayStart.setUTCHours(15, 0, 0, 0);
        const dayEnd   = new Date(day); dayEnd.setUTCHours(27, 0, 0, 0);
        for (const icao of stations) {
            const sd = this._mosData?.stations?.[icao];
            if (!sd?.periods) continue;
            for (const p of sd.periods) {
                if (!p.valid_time) continue;
                const vt = new Date(p.valid_time);
                if (vt < dayStart || vt >= dayEnd) continue;
                const tp = p.tp6 ?? p.tp12 ?? 0;
                if (tp > max) max = tp;
            }
        }
        return max;
    }

    _findBestDay(stations) {
        const now = new Date();
        const order = ['LIFR', 'IFR', 'MVFR', 'VFR'];
        let bestDay = null;
        let bestCat = null;

        for (let d = 0; d < 7; d++) {
            const day = new Date(now);
            day.setUTCDate(now.getUTCDate() + d);
            day.setUTCHours(0, 0, 0, 0);

            let worstForRoute = 'VFR';
            for (const icao of stations) {
                const sd = this._mosData?.stations?.[icao];
                const cat = this._worstCatForDay(sd, day);
                if (!cat) continue;
                if (order.indexOf(cat) < order.indexOf(worstForRoute)) {
                    worstForRoute = cat;
                }
            }

            if (!bestCat || order.indexOf(worstForRoute) > order.indexOf(bestCat)) {
                bestCat = worstForRoute;
                bestDay = { date: day, worstCat: worstForRoute };
            }
            if (bestCat === 'VFR') break; // can't do better
        }
        return bestDay;
    }

    _isSameDay(a, b) {
        return a.getUTCFullYear() === b.getUTCFullYear() &&
               a.getUTCMonth()    === b.getUTCMonth()    &&
               a.getUTCDate()     === b.getUTCDate();
    }

    _dayLabel(date, short = false) {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const day  = days[date.getUTCDay()];
        const num  = date.getUTCDate();
        return short ? `${day}\n${num}` : `${day} ${date.getUTCMonth() + 1}/${num}`;
    }

    _cell(text, className) {
        const el = document.createElement('div');
        el.className = className || '';
        el.textContent = text;
        return el;
    }
}
