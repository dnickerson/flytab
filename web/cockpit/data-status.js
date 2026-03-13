/**
 * FlyTab — Data & Maps Overlay
 * Shows NASR/CIFP/plates/tiles cycle status + tile cache management.
 *
 * Architecture: Capacitor WebView — no Service Worker, no SW cache API.
 * Tiles/NASR/plates are served from NanoHTTPD at localhost:9090 (on-device).
 * Pre-flight sync fetches from the home server (configured in cockpit-config.json).
 */

class DataStatus {
    // ── Constants ─────────────────────────────────────────────────────────────
    static LOCAL_BASE  = 'http://localhost:9090';
    static CONCURRENCY = 6;
    static SEC_ZOOMS   = [5, 6, 7, 8, 9, 10, 11];
    static IFR_ZOOMS   = [7, 8, 9, 10, 11];
    static REGIONS = [
        { id: 'southeast',    label: 'Southeast',     sub: 'FL GA SC NC TN(e) VA(s)', latMin: 24.0, latMax: 36.5, lonMin: -88.5, lonMax: -74.5, mb: 188 },
        { id: 'midatlantic',  label: 'Mid-Atlantic',  sub: 'VA MD DC DE NJ NY',       latMin: 36.5, latMax: 42.5, lonMin: -82.0, lonMax: -71.0, mb: 120 },
        { id: 'northeast',    label: 'Northeast',     sub: 'NY CT RI MA VT NH ME',    latMin: 41.0, latMax: 47.5, lonMin: -80.0, lonMax: -66.0, mb: 124 },
        { id: 'gulfcoast',    label: 'Gulf Coast',    sub: 'LA MS AL TX coast',       latMin: 25.0, latMax: 33.0, lonMin: -97.5, lonMax: -83.0, mb: 122 },
        { id: 'southcentral', label: 'South Central', sub: 'TX OK AR LA TN(w) KY(w)', latMin: 29.0, latMax: 37.0, lonMin: -97.5, lonMax: -88.5, mb: 120 },
        { id: 'midwest',      label: 'Midwest',       sub: 'OH IN IL MI WI MN IA MO KY(e)', latMin: 36.0, latMax: 49.5, lonMin: -98.0, lonMax: -80.0, mb: 346 },
        { id: 'greatplains',  label: 'Great Plains',  sub: 'ND SD NE KS CO east',    latMin: 36.0, latMax: 49.5, lonMin: -111.0, lonMax: -96.0, mb: 259 },
        { id: 'mountain',     label: 'Mountain',      sub: 'MT ID WY UT CO NV',      latMin: 36.0, latMax: 49.5, lonMin: -117.5, lonMax: -109.0, mb: 171 },
        { id: 'southwest',    label: 'Southwest',     sub: 'CA south AZ NM',         latMin: 31.0, latMax: 37.5, lonMin: -121.0, lonMax: -108.0, mb: 117 },
        { id: 'pacificnw',    label: 'Pacific NW',    sub: 'WA OR CA north',         latMin: 37.0, latMax: 49.5, lonMin: -125.5, lonMax: -116.0, mb: 150 },
        { id: 'alaska',       label: 'Alaska',        sub: 'AK',                     latMin: 54.0, latMax: 72.0, lonMin: -169.0, lonMax: -130.0, mb: 407 },
    ];

    constructor(parentEl) {
        this._parentEl = parentEl;
        this._el = null;
        this._visible = false;
        this._cacheRunning = false;
        this._cacheCancelled = false;
        this._buildDOM();
    }

    show() {
        this._el.classList.add('visible');
        this._visible = true;
        this._setMapControlsVisible(false);
        this._refresh();
    }

    hide() {
        this._el.classList.remove('visible');
        this._visible = false;
        this._setMapControlsVisible(true);
    }

    toggle() {
        this._visible ? this.hide() : this.show();
    }

    /** Derive home server URLs from CockpitConfig */
    _homeServerUrls() {
        const hs = (typeof CockpitConfig !== 'undefined' && CockpitConfig.raw?.homeServer) || {};
        return {
            tileBase: hs.tileBase || 'http://192.168.1.77:8090/tiles',
            plateBase: hs.plateBase || 'http://192.168.1.77:8090/plates',
            nasrBase: hs.nasrBase || 'http://192.168.1.77:8090/nasr',
        };
    }

    async _refresh() {
        const body = this._el.querySelector('.data-status-body');
        body.innerHTML = '<div class="ds-loading">Loading...</div>';

        const urls = this._homeServerUrls();
        const manifest = {};

        // Probe all data sources in parallel — local NanoHTTPD first, home server fallback
        const probes = await Promise.allSettled([
            this._probeNasr(urls),
            this._probeCifp(urls),
            this._probePlates(urls),
            this._probeTiles(urls),
        ]);

        if (probes[0].status === 'fulfilled') manifest.nasr_cycle = probes[0].value;
        if (probes[1].status === 'fulfilled') manifest.cifp_cycle = probes[1].value;
        if (probes[2].status === 'fulfilled') manifest.plates = probes[2].value;
        if (probes[3].status === 'fulfilled') manifest.tiles = probes[3].value;

        // If we got nothing at all, show error
        if (!manifest.nasr_cycle && !manifest.cifp_cycle && !manifest.plates && !manifest.tiles) {
            body.innerHTML = `<div class="ds-error">No data found<br><small>Ensure home server is running (start-home-server.sh) and tablet is on home WiFi</small></div>`;
            return;
        }

        this._render(manifest, null);
    }

    /** Probe NASR data — try local, then home server */
    async _probeNasr(urls) {
        // Try local NanoHTTPD
        try {
            const r = await fetch(`${DataStatus.LOCAL_BASE}/nasr/cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
            if (r.ok) return await r.json();
        } catch { /* not local */ }
        // Try home server
        try {
            const r = await fetch(`${urls.nasrBase}/cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (r.ok) { const d = await r.json(); d._source = 'server'; return d; }
        } catch { /* not available */ }
        // Try bundle.json cycle_info (larger file but has the data)
        try {
            const r = await fetch(`${urls.nasrBase}/bundle.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (r.ok) { const b = await r.json(); if (b.cycle_info) { b.cycle_info._source = 'server'; return b.cycle_info; } }
        } catch { /* not available */ }
        return null;
    }

    /** Probe CIFP data */
    async _probeCifp(urls) {
        const nasrBase = urls.nasrBase.replace(/\/nasr\/?$/, '');
        // Try local NanoHTTPD
        try {
            const r = await fetch(`${DataStatus.LOCAL_BASE}/cifp/cifp_cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
            if (r.ok) return await r.json();
        } catch { /* not local */ }
        // Try home server — CIFP data is in flypi/data/cifp/
        try {
            const r = await fetch(`${nasrBase}/cifp/cifp_cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (r.ok) { const d = await r.json(); d._source = 'server'; return d; }
        } catch { /* not available */ }
        return null;
    }

    /** Probe plates data */
    async _probePlates(urls) {
        // Try local NanoHTTPD — check for plate_geo_index.json as indicator
        try {
            const r = await fetch(`${DataStatus.LOCAL_BASE}/plates/plate_geo_index.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
            if (r.ok) {
                const geo = await r.json();
                const count = typeof geo === 'object' ? Object.keys(geo).length : 0;
                return { airports: count, georef_count: count, _source: 'local' };
            }
        } catch { /* not local */ }
        // Try home server
        try {
            const r = await fetch(`${urls.plateBase}/plate_geo_index.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            if (r.ok) {
                const geo = await r.json();
                const count = typeof geo === 'object' ? Object.keys(geo).length : 0;
                return { airports: count, georef_count: count, _source: 'server' };
            }
        } catch { /* not available */ }
        return null;
    }

    /** Probe tile availability */
    async _probeTiles(urls) {
        // Check local NanoHTTPD for cached tiles
        let localOk = false;
        try {
            const r = await fetch(`${DataStatus.LOCAL_BASE}/tiles/sectional/7/34/52.webp`, { method: 'HEAD', signal: AbortSignal.timeout(2000) });
            if (r.ok) localOk = true;
        } catch { /* no local tiles */ }

        // Check home server for tile availability
        let serverOk = false;
        try {
            const r = await fetch(`${urls.tileBase}/sectional/7/34/52.webp`, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
            if (r.ok) serverOk = true;
        } catch { /* not available */ }

        // Check for available ZIPs
        let zips = [];
        try {
            const homeBase = urls.tileBase.replace(/\/tiles\/?$/, '');
            const r = await fetch(`${homeBase}/offline-maps/index.json`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            if (r.ok) zips = await r.json();
        } catch { /* no zips */ }

        if (!localOk && !serverOk && !zips.length) return null;
        return { localCached: localOk, serverAvailable: serverOk, zips };
    }


    _render(m, tileCount) {
        const body = this._el.querySelector('.data-status-body');
        const now = new Date();
        const cards = [];

        // NASR Aeronautical Data
        const nasr = m.nasr_cycle;
        if (nasr) {
            const exp = nasr.expiration_date ? new Date(nasr.expiration_date) : null;
            const status = this._cycleStatus(exp, now);
            const src = nasr._source === 'server' ? ' (on server)' : ' (on device)';
            cards.push(this._card('NASR Aeronautical Data',
                `Cycle: ${nasr.effective_date || '?'} &rarr; ${nasr.expiration_date || '?'}${src}`,
                status));
        } else {
            cards.push(this._card('NASR Aeronautical Data', 'Not found', this._badge('MISSING', 'gray')));
        }

        // CIFP Procedures
        const cifp = m.cifp_cycle;
        if (cifp) {
            const code = cifp.cycle_code || '?';
            const src = cifp._source === 'server' ? ' (on server)' : ' (on device)';
            let cifpDetail = `Cycle: ${code}${src}`;
            let status;
            if (nasr?.effective_date && cifp.effective_date) {
                if (cifp.effective_date === nasr.effective_date) {
                    const nasrExp = new Date(nasr.expiration_date);
                    status = this._cycleStatus(nasrExp, now);
                } else {
                    status = this._badge('MISMATCHED', 'yellow');
                    cifpDetail += `<br><span style="font-size:14px;color:var(--status-caution)">CIFP: ${cifp.effective_date} &ne; NASR: ${nasr.effective_date}</span>`;
                }
            } else {
                status = this._badge('AVAILABLE', 'gray');
            }
            cards.push(this._card('CIFP Procedures', cifpDetail, status));
        } else {
            cards.push(this._card('CIFP Procedures', 'Not found', this._badge('MISSING', 'gray')));
        }

        // Approach Plates
        const plates = m.plates;
        if (plates) {
            const count = plates.airports || 0;
            const src = plates._source === 'local' ? 'on device' : 'on server';
            let detail = `${count.toLocaleString()} airports georeferenced (${src})`;
            if (plates.georef_count) detail = `${plates.georef_count.toLocaleString()} plates georeferenced (${src})`;
            cards.push(this._card('Approach Plates', detail, this._badge('AVAILABLE', 'green')));
        } else {
            cards.push(this._card('Approach Plates', 'Not found — download via section below', this._badge('MISSING', 'gray')));
        }

        // Sectional / IFR Tiles
        const tiles = m.tiles;
        if (tiles) {
            const parts = [];
            if (tiles.localCached) parts.push('Cached on device');
            if (tiles.serverAvailable) parts.push('Available on server');
            if (tiles.zips?.length) parts.push(`${tiles.zips.length} ZIP package${tiles.zips.length > 1 ? 's' : ''} ready`);
            cards.push(this._card('Sectional / IFR Tiles', parts.join(' &middot; ') || 'Available',
                tiles.localCached ? this._badge('CACHED', 'green') : this._badge('NOT CACHED', 'yellow')));
        } else {
            cards.push(this._card('Sectional / IFR Tiles', 'Not found on server or device', this._badge('MISSING', 'red')));
        }

        const ts = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';
        body.innerHTML = cards.join('') +
            `<div class="ds-footer">Checked: ${ts}</div>` +
            this._buildCacheSectionHtml(tileCount);
        this._wireCacheSection();
    }

    _cycleStatus(expDate, now) {
        if (!expDate) return this._badge('UNKNOWN', 'gray');
        const daysLeft = (expDate - now) / 86400000;
        if (daysLeft < 0) {
            const daysAgo = Math.abs(Math.round(daysLeft));
            return this._badge(`EXPIRED (${daysAgo}d ago)`, 'red');
        } else if (daysLeft <= 3) {
            return this._badge(`EXPIRING (${Math.round(daysLeft)}d)`, 'yellow');
        }
        return this._badge(`CURRENT (${Math.round(daysLeft)}d left)`, 'green');
    }

    _badge(text, color) {
        const colors = {
            green: 'var(--status-ok)',
            yellow: 'var(--status-caution)',
            red: 'var(--status-danger)',
            gray: 'var(--text-muted)',
        };
        return `<span class="ds-badge" style="color:${colors[color] || colors.gray}">&#9679; ${text}</span>`;
    }

    _card(title, detail, statusHtml) {
        return `
            <div class="ds-card">
                <div class="ds-card-title">${title}</div>
                <div class="ds-card-detail">${detail}</div>
                ${statusHtml ? `<div class="ds-card-status">${statusHtml}</div>` : ''}
            </div>`;
    }

    // ── Tile Cache Section ──────────────────────────────────────────────────

    _buildCacheSectionHtml(tileCount) {
        const countStr = tileCount != null ? `${tileCount.toLocaleString()} tiles cached` : 'Checking tile server…';
        const bbox = (() => { try { return JSON.parse(localStorage.getItem('flypi_route_bbox') || 'null'); } catch { return null; } })();
        const routeRow = bbox
            ? `<div class="ds-cache-row">
                    <span class="ds-cache-info"><span class="ds-cache-name">${bbox.label}</span><span class="ds-cache-sub">+60 nm buffer</span></span>
                    <button class="ds-cache-btn" id="dsCacheRouteBtn">Cache</button>
               </div>`
            : `<div class="ds-cache-row">
                    <span class="ds-cache-info"><span class="ds-cache-name" style="color:var(--text-muted)">No flight plan loaded</span></span>
               </div>`;

        const regionRows = DataStatus.REGIONS.map(r =>
            `<div class="ds-cache-row">
                <span class="ds-cache-info">
                    <span class="ds-cache-name">${r.label}</span>
                    <span class="ds-cache-sub">${r.sub}</span>
                    <span class="ds-cache-sub">SEC z5–11 + IFR z7–11 &middot; ~${r.mb} MB</span>
                </span>
                <button class="ds-cache-btn" data-region="${r.id}">Cache</button>
            </div>`
        ).join('');

        return `
        <div class="ds-section-title">Tile Cache</div>
        <div class="ds-card">
            <div class="ds-card-title">Local Tile Server</div>
            <div class="ds-card-detail" id="dsTileCountText">${countStr}</div>
            <div class="ds-cache-actions">
                <button class="ds-action-btn" id="dsLoadServerBtn">Load from Home Server</button>
                <button class="ds-action-btn" id="dsImportZipBtn">Import ZIP</button>
                <input type="file" id="dsZipInput" accept=".zip" style="display:none">
            </div>
            <div id="dsServerZips"></div>
        </div>
        <div class="ds-card">
            <div class="ds-card-title">Route Area</div>
            ${routeRow}
        </div>
        <div class="ds-card">
            <div class="ds-card-title">CONUS Regions <span style="font-weight:400;font-size:13px;color:var(--text-muted)">(SEC + IFR tiles only)</span></div>
            ${regionRows}
        </div>
        <div class="ds-section-title">Approach Plates</div>
        ${this._platesAgeCard()}
        <div class="ds-card">
            <div class="ds-card-title">Download Plates</div>
            <div class="ds-card-detail" style="margin-bottom:10px">Enter airport ICAOs to download plates from the home server.</div>
            <input class="ds-icao-input" id="dsPlateIcaoInput" type="text" placeholder="KMBT, KLKR, KSPA…" autocapitalize="characters" autocorrect="off" spellcheck="false">
            <div class="ds-cache-actions" style="margin-top:8px">
                <button class="ds-action-btn" id="dsDownloadPlatesBtn">Download &amp; Save</button>
                <button class="ds-action-btn" id="dsImportPlatesBtn">Import ZIP</button>
                <input type="file" id="dsPlatesZipInput" accept=".zip" style="display:none">
            </div>
            <div id="dsPlatesStatus" style="margin-top:8px;font-size:13px;color:var(--text-muted)"></div>
        </div>`;
    }

    _wireCacheSection() {
        const body = this._el.querySelector('.data-status-body');

        // Progress helpers
        const progRow  = this._el.querySelector('.ds-progress-row');
        const progFill = this._el.querySelector('.ds-progress-fill');
        const progText = this._el.querySelector('.ds-progress-text');
        const cancelEl = this._el.querySelector('#dsCancelBtn');

        const showProg = (msg) => {
            progRow.classList.add('active');
            progFill.style.width = '0%';
            progText.textContent = msg;
            cancelEl.style.display = '';
        };
        const updateProg = (done, total) => {
            progFill.style.width = Math.round(done / total * 100) + '%';
            progText.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} tiles`;
        };
        const doneProg = (msg, color) => {
            progFill.style.width = '100%';
            progText.textContent = msg;
            progText.style.color = color || '';
            cancelEl.style.display = 'none';
        };

        if (cancelEl) cancelEl.addEventListener('click', () => { this._cacheCancelled = true; });

        // Load from Home Server (pre-flight sync operation)
        const loadBtn = body.querySelector('#dsLoadServerBtn');
        const serverZips = body.querySelector('#dsServerZips');
        if (loadBtn) {
            this._wireTap(loadBtn, async () => {
                loadBtn.disabled = true; loadBtn.textContent = '…';
                serverZips.innerHTML = '';
                try {
                    const urls = this._homeServerUrls();
                    const r = await fetch(`${urls.tileBase.replace(/\/tiles\/?$/, '')}/offline-maps/index.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const pkgs = await r.json();
                    if (!pkgs.length) {
                        serverZips.innerHTML = '<div style="padding:6px 0;color:var(--text-muted);font-size:13px">No ZIPs on server — run build_offline_zip.py</div>';
                    } else {
                        pkgs.forEach(p => {
                            const row = document.createElement('div');
                            row.className = 'ds-cache-row';
                            row.style.marginTop = '6px';
                            row.innerHTML = `<span class="ds-cache-info"><span class="ds-cache-name">${p.id}</span><span class="ds-cache-sub">${p.size_mb} MB</span></span><button class="ds-cache-btn">Import</button>`;
                            const btn = row.querySelector('button');
                            this._wireTap(btn, async () => {
                                if (this._cacheRunning) return;
                                btn.disabled = true; btn.textContent = 'Downloading…';
                                showProg('Downloading ' + p.id + '.zip…');
                                try {
                                    const zipUrl = p.url.startsWith('http') ? p.url : (urls.tileBase.replace(/\/tiles\/?$/, '') + p.url);
                                    const resp = await fetch(zipUrl);
                                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                                    const blob = await resp.blob();
                                    await this._importZip(new File([blob], p.id + '.zip'), showProg, updateProg, doneProg);
                                } catch (err) { doneProg('Download failed: ' + err.message, 'var(--status-danger)'); }
                                btn.disabled = false; btn.textContent = 'Import';
                            });
                            serverZips.appendChild(row);
                        });
                    }
                } catch (err) {
                    serverZips.innerHTML = `<div style="padding:6px 0;color:var(--status-danger);font-size:13px">Not reachable: ${err.message}</div>`;
                }
                loadBtn.disabled = false; loadBtn.textContent = 'Load from Home Server';
            });
        }

        // Import ZIP from Files
        const zipInput = body.querySelector('#dsZipInput');
        const importBtn = body.querySelector('#dsImportZipBtn');
        if (importBtn && zipInput) {
            this._wireTap(importBtn, () => zipInput.click());
            zipInput.addEventListener('change', () => {
                if (zipInput.files[0]) { this._importZip(zipInput.files[0], showProg, updateProg, doneProg); zipInput.value = ''; }
            });
        }

        // Route cache button
        const routeBtn = body.querySelector('#dsCacheRouteBtn');
        if (routeBtn) {
            const bbox = (() => { try { return JSON.parse(localStorage.getItem('flypi_route_bbox') || 'null'); } catch { return null; } })();
            if (bbox) this._wireTap(routeBtn, () => this._cacheRegion(bbox, routeBtn, showProg, updateProg, doneProg));
        }

        // Region buttons
        body.querySelectorAll('.ds-cache-btn[data-region]').forEach(btn => {
            const region = DataStatus.REGIONS.find(r => r.id === btn.dataset.region);
            if (!region) return;
            this._wireTap(btn, () => this._cacheRegion(region, btn, showProg, updateProg, doneProg));
        });

        // Approach Plates — Download from home server (pre-flight sync)
        const platesStatus = body.querySelector('#dsPlatesStatus');
        const platesInput  = body.querySelector('#dsPlateIcaoInput');
        const dlPlatesBtn  = body.querySelector('#dsDownloadPlatesBtn');
        if (dlPlatesBtn && platesInput) {
            this._wireTap(dlPlatesBtn, async () => {
                const raw = platesInput.value.trim();
                if (!raw) { platesStatus.textContent = 'Enter at least one ICAO.'; return; }
                const icaos = raw.split(/[\s,]+/).filter(Boolean).map(s => s.toUpperCase()).join(',');
                dlPlatesBtn.disabled = true;
                platesStatus.textContent = 'Downloading plates…';
                showProg('Downloading plates…');
                try {
                    const urls = this._homeServerUrls();
                    const airports = icaos.split(',');
                    let downloaded = 0;
                    for (const icao of airports) {
                        // Fetch plate index for this airport from home server
                        const idxResp = await fetch(`${urls.plateBase}/${icao}/index.json`, { signal: AbortSignal.timeout(5000) });
                        if (!idxResp.ok) { platesStatus.textContent = `No plates for ${icao}`; continue; }
                        const plateList = await idxResp.json();
                        // Save the index.json to NanoHTTPD so approach-charts can find it
                        try {
                            await fetch(`${DataStatus.LOCAL_BASE}/plates/${icao}/index.json`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(plateList),
                            });
                        } catch { /* skip */ }
                        const files = Array.isArray(plateList) ? plateList : (plateList.files || []);
                        for (const file of files) {
                            const fname = typeof file === 'string' ? file : file.filename;
                            if (!fname) continue;
                            try {
                                const r = await fetch(`${urls.plateBase}/${icao}/${fname}`);
                                if (r.ok) {
                                    const blob = await r.blob();
                                    await fetch(`${DataStatus.LOCAL_BASE}/plates/${icao}/${fname}`, { method: 'PUT', body: blob });
                                    downloaded++;
                                }
                            } catch { /* skip failed plate */ }
                        }
                        updateProg(airports.indexOf(icao) + 1, airports.length);
                    }
                    // Also download the georef index for plate overlay support
                    try {
                        const geoResp = await fetch(`${urls.plateBase}/plate_geo_index.json`, { signal: AbortSignal.timeout(5000) });
                        if (geoResp.ok) {
                            const geoBlob = await geoResp.blob();
                            await fetch(`${DataStatus.LOCAL_BASE}/plates/plate_geo_index.json`, { method: 'PUT', body: geoBlob });
                        }
                    } catch { /* georef optional */ }
                    doneProg(`${downloaded} plates saved for ${airports.length} airports`);
                    platesStatus.textContent = '';
                } catch (err) {
                    doneProg('Plates download failed: ' + err.message, 'var(--status-danger)');
                    platesStatus.textContent = err.message;
                }
                dlPlatesBtn.disabled = false;
            });
        }

        // Approach Plates — Import ZIP from Files
        const platesZipInput = body.querySelector('#dsPlatesZipInput');
        const importPlatesBtn = body.querySelector('#dsImportPlatesBtn');
        if (importPlatesBtn && platesZipInput) {
            this._wireTap(importPlatesBtn, () => platesZipInput.click());
            platesZipInput.addEventListener('change', () => {
                if (platesZipInput.files[0]) {
                    this._importPlatesZip(platesZipInput.files[0], showProg, updateProg, doneProg);
                    platesZipInput.value = '';
                }
            });
        }
    }

    // ── Tile math ───────────────────────────────────────────────────────────
    _lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
    _lat2tile(lat, z) {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }
    _buildTileUrls(region) {
        // Returns sub-paths relative to tile base (e.g. /sectional/7/34/26.webp)
        const urls = [];
        const add = (prefix, zooms) => {
            for (const z of zooms) {
                const xMin = this._lon2tile(region.lonMin, z), xMax = this._lon2tile(region.lonMax, z);
                const yMin = this._lat2tile(region.latMax, z), yMax = this._lat2tile(region.latMin, z);
                for (let x = xMin; x <= xMax; x++)
                    for (let y = yMin; y <= yMax; y++)
                        urls.push(`/${prefix}/${z}/${x}/${y}.webp`);
            }
        };
        add('sectional', DataStatus.SEC_ZOOMS);
        add('ifr-low',   DataStatus.IFR_ZOOMS);
        return urls;
    }

    async _cacheRegion(region, btn, showProg, updateProg, doneProg) {
        if (this._cacheRunning) return;
        this._cacheRunning = true; this._cacheCancelled = false;
        if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }

        // ZIP strategy: download pre-built region ZIP from home server,
        // POST to NanoHTTPD /unzip for fast server-side extraction
        const urls = this._homeServerUrls();
        const homeBase = urls.tileBase.replace(/\/tiles\/?$/, '');
        const zipUrl = `${homeBase}/offline-maps/${region.id}.zip`;

        try {
            showProg(`Downloading ${region.id}.zip (${region.mb} MB)…`);

            const resp = await fetch(zipUrl, { signal: AbortSignal.timeout(300000) });
            if (!resp.ok) throw new Error(`ZIP not found (HTTP ${resp.status}) — run build_offline_zip.py ${region.id}`);

            const blob = await resp.blob();
            showProg(`Extracting ${(blob.size / 1024 / 1024).toFixed(0)} MB to device…`);

            // POST ZIP to NanoHTTPD /unzip — Java extracts directly to filesystem
            const unzipResp = await fetch(`${DataStatus.LOCAL_BASE}/unzip`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: blob,
                signal: AbortSignal.timeout(300000),
            });

            if (!unzipResp.ok) {
                const errText = await unzipResp.text();
                throw new Error(`Extraction failed: ${errText}`);
            }

            const result = await unzipResp.json();
            this._cacheRunning = false;
            doneProg(`\u2713 ${result.extracted.toLocaleString()} tiles extracted`, 'var(--status-ok)');
        } catch (err) {
            this._cacheRunning = false;
            doneProg(`Failed: ${err.message}`, 'var(--status-danger)');
        }
        if (btn) { btn.disabled = false; btn.textContent = 'Cache'; }
    }

    async _importZip(file, showProg, updateProg, doneProg) {
        if (this._cacheRunning) return;
        this._cacheRunning = true; this._cacheCancelled = false;
        showProg('Reading ZIP…');
        try {
            const zip = await JSZip.loadAsync(file);
            const entries = [];
            zip.forEach((path, entry) => {
                if (!entry.dir && (path.endsWith('.webp') || path.endsWith('.png')))
                    entries.push({ path, entry });
            });
            if (!entries.length) { doneProg('No tiles found in ZIP', 'var(--status-danger)'); this._cacheRunning = false; return; }

            // In Capacitor WebView, we write extracted tiles to local storage via NanoHTTPD PUT
            // For now, count extracted entries as a success metric
            const total = entries.length;
            updateProg(0, total);
            let done = 0, stored = 0;
            for (const { path, entry } of entries) {
                if (this._cacheCancelled) break;
                try {
                    const blob = await entry.async('blob');
                    const type = path.endsWith('.png') ? 'image/png' : 'image/webp';
                    // PUT tile to local NanoHTTPD for on-device storage
                    const putResp = await fetch(`${DataStatus.LOCAL_BASE}/tiles/${path}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': type },
                        body: blob
                    });
                    if (putResp.ok) stored++;
                } catch { /* skip */ }
                done++;
                if (done % 50 === 0 || done === total) updateProg(done, total);
            }
            this._cacheRunning = false;
            if (this._cacheCancelled) doneProg(`Cancelled — ${stored.toLocaleString()} tiles imported`, 'var(--status-caution)');
            else doneProg(`\u2713 ${stored.toLocaleString()} tiles imported`, 'var(--status-ok)');
        } catch (err) {
            this._cacheRunning = false;
            doneProg('ZIP error: ' + err.message, 'var(--status-danger)');
        }
    }

    _platesAgeCard() {
        const ts = parseInt(localStorage.getItem('flypi_plates_cached_at') || '0', 10);
        if (!ts) {
            return `<div class="ds-card">
                <div class="ds-card-title">Plate Cache Age</div>
                <div class="ds-card-detail">No plates cached yet.</div>
                <div class="ds-card-status">${this._badge('NOT CACHED', 'gray')}</div>
            </div>`;
        }
        const ageDays = (Date.now() - ts) / 86400000;
        const ageStr = ageDays < 1 ? 'today' : ageDays < 2 ? 'yesterday' : `${Math.floor(ageDays)}d ago`;
        const AIRAC = 28;
        let badge, note;
        if (ageDays > AIRAC) {
            const over = Math.floor(ageDays - AIRAC);
            badge = this._badge(`EXPIRED (${over}d past AIRAC cycle)`, 'red');
            note = 'Re-cache plates before flight — these may be outdated.';
        } else if (ageDays > AIRAC - 4) {
            badge = this._badge(`EXPIRING (${Math.floor(AIRAC - ageDays)}d left)`, 'yellow');
            note = 'Plates approaching end of AIRAC cycle — re-cache soon.';
        } else {
            badge = this._badge(`CURRENT (${Math.floor(AIRAC - ageDays)}d left)`, 'green');
            note = '';
        }
        return `<div class="ds-card">
            <div class="ds-card-title">Plate Cache Age</div>
            <div class="ds-card-detail">Cached ${ageStr}${note ? '<br><span style="color:var(--status-caution)">' + note + '</span>' : ''}</div>
            <div class="ds-card-status">${badge}</div>
        </div>`;
    }

    async _importPlatesZip(file, showProg, updateProg, doneProg) {
        if (this._cacheRunning) return;
        this._cacheRunning = true; this._cacheCancelled = false;
        showProg('Reading plates ZIP…');
        try {
            const zip = await JSZip.loadAsync(file);
            const entries = [];
            zip.forEach((path, entry) => {
                if (!entry.dir && (path.endsWith('.webp') || path.endsWith('.pdf') || path.endsWith('.png')))
                    entries.push({ path, entry });
            });
            if (!entries.length) { doneProg('No plate files found in ZIP', 'var(--status-danger)'); this._cacheRunning = false; return; }

            const total = entries.length;
            updateProg(0, total);
            let done = 0, stored = 0;

            for (const { path, entry } of entries) {
                if (this._cacheCancelled) break;
                try {
                    const blob = await entry.async('blob');
                    const ext = path.split('.').pop().toLowerCase();
                    const types = { pdf: 'application/pdf', webp: 'image/webp', png: 'image/png' };
                    const type = types[ext] || 'application/octet-stream';
                    // PUT plate file to local NanoHTTPD for on-device storage
                    const putResp = await fetch(`${DataStatus.LOCAL_BASE}/plates/${path}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': type },
                        body: blob
                    });
                    if (putResp.ok) stored++;
                } catch { /* skip bad entry */ }
                done++;
                if (done % 20 === 0 || done === total) updateProg(done, total);
            }
            this._cacheRunning = false;
            if (this._cacheCancelled) {
                doneProg(`Cancelled — ${stored.toLocaleString()} plates imported`, 'var(--status-caution)');
            } else {
                localStorage.setItem('flypi_plates_cached_at', Date.now().toString());
                doneProg(`\u2713 ${stored.toLocaleString()} plate files saved`, 'var(--status-ok)');
            }
        } catch (err) {
            this._cacheRunning = false;
            doneProg('ZIP error: ' + err.message, 'var(--status-danger)');
        }
    }

    /** Wire touchstart + click with debounce for tablet reliability */
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

    _setMapControlsVisible(visible) {
        const containers = document.querySelectorAll('.leaflet-control-container');
        containers.forEach(c => c.style.display = visible ? '' : 'none');
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'data-status-page';
        this._el.innerHTML = `
            <div class="data-status-header">
                <span class="data-status-title">Data &amp; Maps</span>
                <button class="btn-close data-status-close">&#x2715;</button>
            </div>
            <div class="ds-progress-row" id="dsProgressRow">
                <div class="ds-progress-bar"><div class="ds-progress-fill"></div></div>
                <div class="ds-progress-footer">
                    <span class="ds-progress-text"></span>
                    <button id="dsCancelBtn" style="display:none;background:none;border:none;color:var(--status-danger);font-size:13px;cursor:pointer;padding:4px 8px">Cancel</button>
                </div>
            </div>
            <div class="data-status-body"></div>
        `;
        this._wireTap(this._el.querySelector('.data-status-close'), () => this.hide());
        this._parentEl.appendChild(this._el);
    }
}
