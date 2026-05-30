/**
 * FlyTab — FIS-B Status Page
 * Full-screen overlay showing FIS-B reception health, tower list,
 * product freshness table, and route-aware weather coverage.
 * Reads from existing StratuxClient + FisbClient — no new connections.
 */

class FisbStatus {
    static PRODUCTS = [
        { key: 'METAR',    label: 'METAR / SPECI',     interval: 300,  store: 'metars',  type: 'map' },
        { key: 'TAF',      label: 'TAF',               interval: 720,  store: 'tafs',    type: 'map' },
        { key: 'SIGMET',   label: 'SIGMET',            interval: 300,  store: 'sigmets',  type: 'array' },
        { key: 'AIRMET',   label: 'AIRMET',            interval: 300,  store: 'airmets',  type: 'array' },
        { key: 'PIREP',    label: 'PIREP',             interval: 600,  store: 'pireps',   type: 'array' },
        { key: 'WINDS',    label: 'Winds Aloft',       interval: 720,  store: 'winds',    type: 'map' },
        { key: 'NOTAM',    label: 'NOTAM / TFR',       interval: 600,  store: 'notams',   type: 'array' },
        { key: 'NEXRAD_R', label: 'NEXRAD Regional',   interval: 150,  store: null,       type: 'nexrad' },
        { key: 'NEXRAD_N', label: 'NEXRAD CONUS',      interval: 300,  store: null,       type: 'nexrad' },
    ];

    constructor(stratuxClient, fisbClient) {
        this._stratux = stratuxClient;
        this._fisb = fisbClient;
        this._routeAirports = [];
        this._renderTimer = null;
        this._buildDOM();
    }

    show() {
        this._el.classList.add('visible');
        this._render();
        this._renderTimer = setInterval(() => this._render(), 5000);
    }

    hide() {
        this._el.classList.remove('visible');
        if (this._renderTimer) { clearInterval(this._renderTimer); this._renderTimer = null; }
    }

    toggle() {
        this._el.classList.contains('visible') ? this.hide() : this.show();
    }

    setRouteAirports(icaoList) {
        this._routeAirports = (icaoList || []).map(s => s.toUpperCase());
    }

    // ========== DOM ==========

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'fisb-status-page';
        this._el.innerHTML = `
            <div class="fisb-header">
                <span class="fisb-title">FIS-B STATUS</span>
                <button class="fisb-close">✕</button>
            </div>
            <div class="fisb-body">
                <div class="fisb-health-bar" id="fisbHealthBar"></div>
                <div class="fisb-route-section" id="fisbRouteSection"></div>
                <div class="fisb-section-label">PRODUCTS</div>
                <table class="fisb-product-table">
                    <thead>
                        <tr>
                            <th></th><th>PRODUCT</th><th>COUNT</th><th>AGE</th><th>STATIONS</th>
                        </tr>
                    </thead>
                    <tbody id="fisbProductBody"></tbody>
                </table>
                <div class="fisb-section-label">TOWERS</div>
                <div class="fisb-towers" id="fisbTowers"></div>
            </div>
        `;

        wireTap(this._el.querySelector('.fisb-close'), () => this.hide());
        // Block touch events from reaching map underneath
        this._el.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

        document.body.appendChild(this._el);
    }

    // ========== Render ==========

    _render() {
        this._renderHealthBar();
        this._renderRouteCoverage();
        this._renderProducts();
        this._renderTowers();
    }

    _renderHealthBar() {
        const s = this._stratux.deviceStatus || {};
        const towers = Object.keys(this._stratux.towerData || {}).length;
        const uatRate = s.UAT_messages_last_minute || 0;
        const uatPeak = s.UAT_messages_max || 0;
        const gps = s.GPS_satellites_locked || 0;
        const cpu = s.CPUTemp != null ? s.CPUTemp.toFixed(1) : '--';

        const totalProducts = (s.UAT_METAR_total || 0) + (s.UAT_TAF_total || 0) +
            (s.UAT_NEXRAD_total || 0) + (s.UAT_SIGMET_total || 0) +
            (s.UAT_PIREP_total || 0) + (s.UAT_NOTAM_total || 0);

        const cells = [
            { label: 'TOWERS',  value: towers, cls: towers >= 3 ? 'ok' : towers > 0 ? 'warn' : 'bad' },
            { label: 'UAT/MIN', value: uatRate, cls: uatRate > 50 ? 'ok' : uatRate > 0 ? 'warn' : 'bad' },
            { label: 'PEAK',    value: uatPeak, cls: '' },
            { label: 'PRODUCTS',value: totalProducts.toLocaleString(), cls: totalProducts > 0 ? 'ok' : 'bad' },
            { label: 'GPS',     value: gps > 0 ? `${gps} sat` : 'NO FIX', cls: gps >= 4 ? 'ok' : gps > 0 ? 'warn' : 'bad' },
            { label: 'CPU',     value: `${cpu}\u00b0C`, cls: parseFloat(cpu) > 70 ? 'bad' : parseFloat(cpu) > 55 ? 'warn' : 'ok' },
        ];

        const el = this._el.querySelector('#fisbHealthBar');
        el.innerHTML = cells.map(c =>
            `<div class="fisb-hcell">
                <div class="fisb-hcell-label">${c.label}</div>
                <div class="fisb-hcell-value ${c.cls}">${c.value}</div>
            </div>`
        ).join('');
    }

    _renderRouteCoverage() {
        const section = this._el.querySelector('#fisbRouteSection');
        if (!this._routeAirports.length) {
            section.innerHTML = '';
            return;
        }

        const metars = this._fisb.metars;
        const tafs = this._fisb.tafs;

        let rows = '';
        for (const icao of this._routeAirports) {
            const hasMetar = metars.has(icao);
            const hasTaf = tafs.has(icao);
            const metarAge = hasMetar ? this._ageStr(metars.get(icao).received_at) : '--';
            const tafAge = hasTaf ? this._ageStr(tafs.get(icao).received_at) : '--';

            let rowClass = '';
            if (!hasMetar && !hasTaf) rowClass = 'fisb-route-row missing';
            else if (!hasMetar || !hasTaf) rowClass = 'fisb-route-row partial';
            else rowClass = 'fisb-route-row';

            const dot = (has) => has
                ? '<span class="fisb-dot ok"></span>'
                : '<span class="fisb-dot bad"></span>';

            rows += `<tr class="${rowClass}">
                <td class="fisb-route-icao">${icao}</td>
                <td>${dot(hasMetar)} ${metarAge}</td>
                <td>${dot(hasTaf)} ${tafAge}</td>
            </tr>`;
        }

        section.innerHTML = `
            <div class="fisb-section-label">ROUTE WEATHER</div>
            <table class="fisb-route-table">
                <thead><tr><th>AIRPORT</th><th>METAR</th><th>TAF</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        `;
    }

    _renderProducts() {
        const tbody = this._el.querySelector('#fisbProductBody');
        const routeSet = new Set(this._routeAirports);

        let html = '';
        for (const p of FisbStatus.PRODUCTS) {
            const { count, newestAge, stations } = this._getProductStats(p);
            const status = this._statusClass(newestAge, p.interval, count);

            // Build station list — route airports bold and first
            let stationHtml = '';
            if (p.type === 'nexrad') {
                stationHtml = count > 0 ? `<span class="fisb-station-dim">${count} frames</span>` : '--';
            } else if (stations.length > 0) {
                const route = stations.filter(s => routeSet.has(s));
                const other = stations.filter(s => !routeSet.has(s));
                const sorted = [...route, ...other];
                stationHtml = sorted.map(s =>
                    routeSet.has(s)
                        ? `<span class="fisb-station route">${s}</span>`
                        : `<span class="fisb-station">${s}</span>`
                ).join(' ');
            } else {
                stationHtml = '<span class="fisb-station-dim">--</span>';
            }

            html += `<tr class="fisb-product-row ${status}">
                <td><span class="fisb-dot ${status}"></span></td>
                <td class="fisb-product-name">${p.label}</td>
                <td class="fisb-product-count">${count || '--'}</td>
                <td class="fisb-product-age">${count > 0 ? this._fmtAge(newestAge) : '--'}</td>
                <td class="fisb-product-stations">${stationHtml}</td>
            </tr>`;
        }
        tbody.innerHTML = html;
    }

    _renderTowers() {
        const container = this._el.querySelector('#fisbTowers');
        const entries = Object.entries(this._stratux.towerData || {});

        if (entries.length === 0) {
            container.innerHTML = '<div class="fisb-no-data">No towers in range</div>';
            return;
        }

        // Sort active towers first (≥ -100), then silent towers last.
        // -999 is Stratux's sentinel for "tower seen but no signal measured"; treat as 0 for sort.
        entries.sort((a, b) => {
            const sa = a[1].Signal_strength_last_minute ?? -999;
            const sb = b[1].Signal_strength_last_minute ?? -999;
            const sortA = sa <= -100 ? -9999 : sa;
            const sortB = sb <= -100 ? -9999 : sb;
            return sortB - sortA;
        });

        container.innerHTML = `<table class="fisb-tower-table">
            <thead><tr><th>LOCATION</th><th>SIGNAL</th><th>MSG/MIN</th></tr></thead>
            <tbody>${entries.map(([coords, t]) => {
                const rawSig = t.Signal_strength_last_minute;
                const noSignal = rawSig == null || rawSig <= -100; // -999 = Stratux sentinel
                const sig = noSignal ? '—' : rawSig.toFixed(0);
                const cls = noSignal ? 'bad' : rawSig >= -10 ? 'ok' : rawSig >= -15 ? 'warn' : 'bad';
                const lat = t.Lat != null ? t.Lat.toFixed(2) : '?';
                const lng = t.Lng != null ? t.Lng.toFixed(2) : '?';
                return `<tr>
                    <td>${lat}, ${lng}</td>
                    <td class="fisb-tower-sig ${cls}">${sig}${noSignal ? '' : ' dB'}</td>
                    <td>${t.Messages_last_minute || 0}</td>
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    // ========== Helpers ==========

    _getProductStats(product) {
        if (product.type === 'nexrad') {
            const count = this._fisb.nexradBlockCount || 0;
            const newestAt = this._fisb.nexradNewestAt || 0;
            const newestAge = newestAt > 0 ? (Date.now() - newestAt) / 1000 : Infinity;
            return { count, newestAge, stations: [] };
        }

        const store = this._fisb[product.store];
        if (!store) return { count: 0, newestAge: Infinity, stations: [] };

        if (product.type === 'map') {
            let newestAge = Infinity;
            const stations = [];
            store.forEach((entry, key) => {
                const age = (Date.now() - entry.received_at) / 1000;
                if (age < newestAge) newestAge = age;
                // For winds, key is "station:alt" — extract station
                const station = product.key === 'WINDS' ? key.split(':')[0] : key;
                if (!stations.includes(station)) stations.push(station);
            });
            return { count: store.size, newestAge, stations };
        }

        // Arrays (pireps, sigmets, airmets, notams)
        let newestAge = Infinity;
        const stations = [];
        for (const entry of store) {
            const age = (Date.now() - entry.received_at) / 1000;
            if (age < newestAge) newestAge = age;
            const loc = entry.icao || (entry.lat != null ? `${entry.lat.toFixed(1)},${entry.lon.toFixed(1)}` : '');
            if (loc && !stations.includes(loc)) stations.push(loc);
        }
        return { count: store.length, newestAge, stations };
    }

    _statusClass(ageSec, interval, count) {
        if (count === 0) return 'none';
        if (!isFinite(ageSec)) return 'bad';
        if (ageSec <= interval) return 'ok';
        if (ageSec <= interval * 2) return 'warn';
        return 'bad';
    }

    _ageStr(receivedAt) {
        if (!receivedAt) return '--';
        const sec = (Date.now() - receivedAt) / 1000;
        return this._fmtAge(sec);
    }

    _fmtAge(sec) {
        if (!isFinite(sec) || sec < 0) return '--';
        if (sec < 60) return `${Math.round(sec)}s`;
        if (sec < 3600) return `${Math.floor(sec / 60)}m`;
        return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
    }
}
