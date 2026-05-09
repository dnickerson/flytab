/**
 * FlyTab — Data & Maps Overlay  v4.5
 * ForeFlight-style inventory: shows server vs. tablet for each data category,
 * with per-section sync and Tailscale fallback discovery.
 *
 * Architecture: Capacitor WebView — no Service Worker, no SW cache API.
 * Tiles/NASR/plates are served from NanoHTTPD at localhost:9090 (on-device).
 * Pre-flight sync fetches from the home server (configured in cockpit-config.json).
 * Tailscale fallback: if local IP unreachable, tries homeServer.fallbackBase.
 */

class DataStatus {
    // ── Constants ─────────────────────────────────────────────────────────────
    static LOCAL_BASE  = 'http://localhost:9090';
    static CONCURRENCY = 6;
    static SEC_ZOOMS      = [5, 6, 7, 8, 9, 10, 11];
    static IFR_ZOOMS      = [4, 5, 6, 7, 8, 9, 10];
    static IFR_AREA_ZOOMS = [10, 11, 12];
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
    static TERRAIN_REGIONS = [
        { id: 'southeast',    states: ['FL','GA','SC','NC','TN','VA'] },
        { id: 'midatlantic',  states: ['VA','MD','DC','DE','NJ','NY'] },
        { id: 'northeast',    states: ['NY','CT','RI','MA','VT','NH','ME'] },
        { id: 'gulfcoast',    states: ['LA','MS','AL','TX'] },
        { id: 'southcentral', states: ['TX','OK','AR','LA','TN','KY'] },
        { id: 'midwest',      states: ['OH','IN','IL','MI','WI','MN','IA','MO','KY'] },
        { id: 'greatplains',  states: ['ND','SD','NE','KS','CO'] },
        { id: 'mountain',     states: ['MT','ID','WY','UT','CO','NV'] },
        { id: 'southwest',    states: ['CA','AZ','NM'] },
        { id: 'pacificnw',    states: ['WA','OR','CA'] },
        { id: 'alaska',       states: ['AK'] },
    ];

    constructor(parentEl) {
        this._parentEl = parentEl;
        this._el = null;
        this._visible = false;
        this._cacheRunning = false;
        this._cacheCancelled = false;
        this._resolvedBase = null;  // cached from _resolveHomeBase()
        this._resolvedVia  = null;
        this._serverManifest = null;
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

    // ── Server Discovery ─────────────────────────────────────────────────────

    /**
     * Try primary address first (local network), then Tailscale fallback.
     * Returns { base, via } where via is 'local' | 'tailscale' | null.
     */
    async _resolveHomeBase() {
        const bases = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.homeBases : [];
        const labels = ['local', 'tailscale'];

        for (let i = 0; i < bases.length; i++) {
            const base = bases[i];
            const via  = labels[i] || 'tailscale';
            try {
                const r = await fetch(`${base}/nasr/cycle_info.json`,
                    { cache: 'no-store', signal: AbortSignal.timeout(4000) });
                if (r.ok) {
                    // Reuse this response — avoid double-fetching in _refresh
                    const nasrCycleInfo = await r.json();
                    return { base, via, nasrCycleInfo };
                }
            } catch { /* try next */ }
        }
        return { base: null, via: null, nasrCycleInfo: null };
    }

    /** Returns the resolved or configured primary base URL. */
    _homeBase() {
        if (this._resolvedBase) return this._resolvedBase;
        return (typeof CockpitConfig !== 'undefined' && CockpitConfig.homeBase) || null;
    }

    /** Legacy helper for _wireCacheSection() — returns tileBase/plateBase/nasrBase URLs. */
    _homeServerUrls() {
        const hs  = (typeof CockpitConfig !== 'undefined' && CockpitConfig.raw?.homeServer) || {};
        const base = this._homeBase();
        return {
            tileBase:  hs.tileBase  || `${base}/tiles`,
            plateBase: hs.plateBase || `${base}/plates`,
            nasrBase:  hs.nasrBase  || `${base}/nasr`,
        };
    }

    // ── Refresh ──────────────────────────────────────────────────────────────

    async _refresh() {
        const body = this._el.querySelector('.data-status-body');
        body.innerHTML = '<div class="ds-loading">Checking data…</div>';

        const { base, via } = await this._resolveHomeBase();
        this._resolvedBase = base;
        this._resolvedVia  = via;

        const [serverManifest, mbtStatus] = await Promise.all([
            base ? this._probeServerManifest(base) : Promise.resolve(null),
            this._probeMbtiles(),
        ]);
        this._serverManifest = serverManifest;

        const deviceManifest = await this._readOrMigrateDeviceManifest();
        this._render(serverManifest, deviceManifest, mbtStatus);
    }

    // ── Probe Methods ─────────────────────────────────────────────────────────

    async _probeServerManifest(base) {
        try {
            const r = await fetch(`${base}/manifest.json`,
                { cache: 'no-store', signal: AbortSignal.timeout(5000) });
            return r.ok ? r.json() : null;
        } catch { return null; }
    }

    async _probeMbtiles() {
        try {
            const r = await fetch(`${DataStatus.LOCAL_BASE}/mbtiles/status`,
                { cache: 'no-store', signal: AbortSignal.timeout(2000) });
            return r.ok ? r.json() : [];
        } catch { return []; }
    }

    // ── Device Manifest (localStorage) ───────────────────────────────────────

    _readDeviceManifest() {
        try { return JSON.parse(localStorage.getItem('flytab_device_manifest')) || {}; }
        catch { return {}; }
    }

    _saveDeviceSection(section, data) {
        const m = this._readDeviceManifest();
        m[section] = data;
        localStorage.setItem('flytab_device_manifest', JSON.stringify(m));
    }

    async _readOrMigrateDeviceManifest() {
        const m = this._readDeviceManifest();
        if (Object.keys(m).length > 0) return m;
        // One-time migration from old per-dataset device probes
        const LOCAL = DataStatus.LOCAL_BASE;
        const [dNasr, dCifp, dPlates, dTerrain, mbt] = await Promise.all([
            fetch(`${LOCAL}/nasr/cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
                .then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${LOCAL}/cifp/cifp_cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
                .then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${LOCAL}/plates/plates_cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
                .then(r => r.ok ? r.json() : null).catch(() => null),
            fetch(`${LOCAL}/terrain/grid/status`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
                .then(r => r.ok ? r.json() : null).catch(() => null),
            this._probeMbtiles(),
        ]);
        const seeded = {};
        if (dNasr)    seeded.nasr    = { effective_date: dNasr.effective_date, bundle_version: dNasr.bundle_version };
        if (dCifp)    seeded.cifp    = { cycle_code: dCifp.cycle_code || dCifp.effective_date };
        if (dPlates)  seeded.plates  = {
            cycle_code: dPlates.cycle_code || dPlates.effective_date,
            synced_states: JSON.parse(localStorage.getItem('flypi_plates_synced_states') || '[]'),
        };
        if (dTerrain?.exists) seeded.terrain = { built_at: dTerrain.builtAt || null };
        for (const entry of mbt) {
            if (entry.exists) {
                seeded.tiles = seeded.tiles || {};
                seeded.tiles[entry.layer] = {};  // no version — forces update check on next sync
            }
        }
        if (Object.keys(seeded).length > 0) {
            localStorage.setItem('flytab_device_manifest', JSON.stringify(seeded));
        }
        return seeded;
    }

    // ── Render ────────────────────────────────────────────────────────────────

    _render(serverManifest, deviceManifest, mbtStatus) {
        const via  = this._resolvedVia;
        const base = this._resolvedBase;
        const body = this._el.querySelector('.data-status-body');
        const now  = new Date();
        const mbt  = mbtStatus || [];

        const sNasr    = serverManifest?.nasr    || null;
        const dNasr    = deviceManifest?.nasr    || null;
        const sCifp    = serverManifest?.cifp    || null;
        const dCifp    = deviceManifest?.cifp    || null;
        const sPlates  = serverManifest?.plates  || null;
        const dPlates  = deviceManifest?.plates  || null;
        const sTerrain = serverManifest?.terrain || null;
        const dTerrain = deviceManifest?.terrain || null;

        // ── Connection banner ────────────────────────────────────────────────
        let bannerColor, bannerText;
        if (via === 'local') {
            bannerColor = 'var(--status-ok)';
            bannerText  = '&#9679; Home server reachable (local network)';
        } else if (via === 'tailscale') {
            bannerColor = 'var(--status-ok)';
            bannerText  = '&#9679; Home server reachable (Tailscale)';
        } else {
            bannerColor = 'var(--status-danger)';
            bannerText  = '&#9675; Home server not reachable &mdash; connect to home Wi-Fi or Tailscale';
        }

        // ── NASR section ─────────────────────────────────────────────────────
        const nasrServerDate = sNasr?.effective_date || null;
        const nasrDevDate    = dNasr?.effective_date || null;
        let nasrServerLine, nasrDevLine, nasrBadge, nasrPrimary = '', nasrSecondary = '';

        if (!base) {
            nasrServerLine = '<span class="ds-muted">Server not reachable</span>';
        } else if (nasrServerDate) {
            const expStr = sNasr?.expiration_date ? ` &rarr; exp ${sNasr.expiration_date}` : '';
            nasrServerLine = `Cycle ${nasrServerDate}${expStr}`;
        } else {
            nasrServerLine = '<span class="ds-muted">Unavailable</span>';
        }

        if (nasrDevDate) {
            nasrDevLine = `Cycle ${nasrDevDate}`;
        } else {
            nasrDevLine = '<span class="ds-muted">Not on tablet</span>';
        }

        const nasrUpdateAvail = base && nasrServerDate && (
            nasrDevDate !== nasrServerDate ||
            (sNasr?.bundle_version != null && sNasr.bundle_version !== dNasr?.bundle_version)
        );

        if (!nasrDevDate) {
            nasrBadge = this._badge('NOT DOWNLOADED', 'gray');
            if (base && nasrServerDate) nasrPrimary = `<button class="ds-action-btn" id="dsNasrBtn">DOWNLOAD</button>`;
        } else if (nasrUpdateAvail) {
            nasrBadge = this._badge('UPDATE AVAILABLE', 'yellow');
            nasrPrimary   = `<button class="ds-action-btn ds-update" id="dsNasrBtn">SYNC</button>`;
            nasrSecondary = `<button class="ds-action-btn ds-secondary" id="dsNasrRedownloadBtn">RE-DOWNLOAD</button>`;
        } else {
            const expDate = sNasr?.expiration_date ? new Date(sNasr.expiration_date)
                          : dNasr?.expiration_date ? new Date(dNasr.expiration_date)
                          : null;
            nasrBadge     = expDate ? this._cycleStatus(expDate, now) : this._badge('ON DEVICE', 'green');
            nasrPrimary   = `<button class="ds-action-btn ds-secondary" id="dsNasrBtn">SYNC</button>`;
            nasrSecondary = `<button class="ds-action-btn ds-secondary" id="dsNasrRedownloadBtn">RE-DOWNLOAD</button>`;
        }

        // ── CIFP section ─────────────────────────────────────────────────────
        const cifpSCode = sCifp?.cycle_code || sCifp?.effective_date || null;
        const cifpDCode = dCifp?.cycle_code || dCifp?.effective_date || null;
        let cifpServerLine, cifpDevLine, cifpBadge, cifpPrimary = '', cifpSecondary = '';

        if (!base) {
            cifpServerLine = '<span class="ds-muted">Server not reachable</span>';
        } else if (cifpSCode) {
            cifpServerLine = `Cycle ${cifpSCode}`;
        } else {
            cifpServerLine = '<span class="ds-muted">Unavailable</span>';
        }

        if (cifpDCode) {
            cifpDevLine = `Cycle ${cifpDCode}`;
        } else {
            cifpDevLine = '<span class="ds-muted">Not on tablet</span>';
        }

        if (!cifpDCode) {
            cifpBadge = this._badge('NOT DOWNLOADED', 'gray');
            if (base && cifpSCode) cifpPrimary = `<button class="ds-action-btn" id="dsCifpBtn">DOWNLOAD</button>`;
        } else if (base && cifpSCode && cifpDCode !== cifpSCode) {
            cifpBadge     = this._badge('UPDATE AVAILABLE', 'yellow');
            cifpPrimary   = `<button class="ds-action-btn ds-update" id="dsCifpBtn">SYNC</button>`;
            cifpSecondary = `<button class="ds-action-btn ds-secondary" id="dsCifpRedownloadBtn">RE-DOWNLOAD</button>`;
        } else {
            const expDate = sNasr?.expiration_date ? new Date(sNasr.expiration_date) : null;
            cifpBadge     = expDate ? this._cycleStatus(expDate, now) : this._badge('CURRENT', 'green');
            cifpPrimary   = `<button class="ds-action-btn ds-secondary" id="dsCifpBtn">SYNC</button>`;
            cifpSecondary = `<button class="ds-action-btn ds-secondary" id="dsCifpRedownloadBtn">RE-DOWNLOAD</button>`;
        }

        // ── Plates section ───────────────────────────────────────────────────
        const serverStates    = (sPlates?.state_sizes || []).map(s => s.state);
        const syncedStates    = dPlates?.synced_states || [];
        const plateSCode      = sPlates?.cycle_code || null;
        const plateDCode      = dPlates?.cycle_code || null;
        let platesServerLine, platesDevLine, platesBadge, platesPrimary = '', platesSecondary = '';

        const adminUrl = base ? `${base}/admin-states.html` : null;
        const configureLink = adminUrl
            ? `<a href="${adminUrl}" target="_blank" style="font-size:11px;color:var(--accent);text-decoration:none;margin-left:8px">&#9881; Configure states</a>`
            : '';

        if (!base) {
            platesServerLine = '<span class="ds-muted">Server not reachable</span>';
        } else if (plateSCode) {
            platesServerLine = `Cycle ${plateSCode} &mdash; ${serverStates.length} states &mdash; IAP, DP, STAR, DIAG, A/FD${configureLink}`;
        } else {
            platesServerLine = `<span class="ds-muted">Unavailable</span>${configureLink}`;
        }

        // Per-state chips — server states drive the list; synced states removed from server shown dimmed.
        // serverHasPlates: only compare server vs device when server has a valid cycle with known states.
        // When plates are unavailable or server unreachable, show synced states as-is (can't determine diff).
        const serverHasPlates  = !!(base && plateSCode && serverStates.length > 0);
        const serverStateSet   = new Set(serverStates);
        const serverStateSizes = Object.fromEntries((sPlates?.state_sizes || []).map(s => [s.state, s.size_mb]));
        const cycleOkForStates = !plateSCode || plateDCode === plateSCode;
        const allDisplayStates = serverHasPlates
            ? [...serverStates, ...syncedStates.filter(s => !serverStateSet.has(s))]
            : syncedStates;
        const stateChips = allDisplayStates.map(st => {
            const onDevice = syncedStates.includes(st);
            const onServer = serverHasPlates ? serverStateSet.has(st) : true;
            const ok = serverHasPlates ? (onDevice && onServer && cycleOkForStates) : onDevice;
            const sizeTxt = serverStateSizes[st] ? ` ${serverStateSizes[st]}MB` : '';
            const cls = ok ? 'ds-state-ok' : 'ds-state-missing';
            const icon = ok ? '&#10003;' : '&#9675;';
            const note = (serverHasPlates && !onServer) ? ' <span class="ds-muted">(removed from server)</span>' : '';
            return `<span class="ds-state-chip ${cls}">${icon} ${st}${sizeTxt}${note}</span>`;
        }).join('');

        const platesIncludesNote = '<span class="ds-muted" style="font-size:10px">Includes: IAP &middot; DP &middot; STAR &middot; Airport Diagrams (DIAG) &middot; Airport Info (A/FD)</span>';

        if (!plateDCode && syncedStates.length === 0) {
            platesDevLine = stateChips || '<span class="ds-muted">Not on tablet</span>';
            platesBadge   = this._badge('NOT DOWNLOADED', 'gray');
            if (base && plateSCode) platesPrimary = `<button class="ds-action-btn" id="dsPlatesBtn">DOWNLOAD</button>`;
        } else {
            platesDevLine = stateChips + '<br>' + platesIncludesNote;
            const allSynced = !serverHasPlates || serverStates.every(s => syncedStates.includes(s));
            if (!allSynced || !cycleOkForStates) {
                platesBadge   = this._badge('UPDATE AVAILABLE', 'yellow');
                if (base) platesPrimary = `<button class="ds-action-btn ds-update" id="dsPlatesBtn">SYNC</button>`;
            } else {
                const expDate = sPlates?.expiration_date ? new Date(sPlates.expiration_date)
                              : sNasr?.expiration_date   ? new Date(sNasr.expiration_date) : null;
                platesBadge   = expDate ? this._cycleStatus(expDate, now) : this._badge('CURRENT', 'green');
                if (base) platesPrimary = `<button class="ds-action-btn ds-secondary" id="dsPlatesBtn">SYNC</button>`;
            }
            if (base) platesSecondary = `<button class="ds-action-btn ds-secondary" id="dsPlatesRedownloadBtn">RE-DOWNLOAD</button>`;
        }

        // ── MBTiles sections ──────────────────────────────────────────────────
        const mbtilesHtml = [
            { layer: 'sectional', label: 'Sectional Charts (z5–11)',               approxMb: 1800 },
            { layer: 'ifr-low',   label: 'IFR Low Enroute (z4–10, 512px retina)',  approxMb: 600  },
            { layer: 'ifr-area',  label: 'IFR Area Charts (z10–12)',               approxMb: 150  },
            { layer: 'tac',       label: 'Terminal Area Charts (z8–12) — VFR Flyways', approxMb: 250 },
        ].map(({ layer, label, approxMb }) => {
            const entry  = mbt.find(l => l.layer === layer);
            const sTile  = serverManifest?.tiles?.[layer] || null;
            const dTile  = deviceManifest?.tiles?.[layer] || null;
            const tileUpdateAvail = entry?.exists && sTile && dTile && (
                sTile.cycle_date !== dTile.cycle_date ||
                sTile.built_at   !== dTile.built_at
            );
            let serverLine, devLine, badge, action = '';

            serverLine = base
                ? `~${approxMb.toLocaleString()} MB available`
                : '<span class="ds-muted">Server not reachable</span>';

            if (entry?.exists) {
                devLine = `${(entry.size_mb || 0).toLocaleString()} MB on tablet`;
                if (tileUpdateAvail) {
                    badge  = this._badge('UPDATE AVAILABLE', 'yellow');
                    action = base ? `<button class="ds-action-btn ds-update ds-mbt-dl-btn" data-layer="${layer}">RE-DOWNLOAD</button>` : '';
                } else {
                    badge  = this._badge('ON DEVICE', 'green');
                    action = base ? `<button class="ds-action-btn ds-mbt-dl-btn" data-layer="${layer}">RE-DOWNLOAD</button>` : '';
                }
            } else {
                devLine = '<span class="ds-muted">Not downloaded</span>';
                badge   = this._badge('NOT DOWNLOADED', 'gray');
                if (base) action = `<button class="ds-action-btn ds-mbt-dl-btn" data-layer="${layer}">DOWNLOAD (~${approxMb.toLocaleString()} MB)</button>`;
            }

            return this._section(label, serverLine, devLine, badge, action);
        }).join('');

        // ── Need Sync? ────────────────────────────────────────────────────────
        const needsSync = !!base && (
            nasrUpdateAvail  ||
            (cifpSCode && cifpDCode !== cifpSCode) ||
            (serverHasPlates && (!cycleOkForStates || serverStates.some(s => !syncedStates.includes(s)))) ||
            !mbt.find(l => l.layer === 'sectional')?.exists ||
            !mbt.find(l => l.layer === 'ifr-low')?.exists
        );

        const ts = new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z';

        // ── Terrain section ───────────────────────────────────────────────────
        const terrainOnDevice    = dTerrain?.built_at != null;
        const terrainUpdateAvail = terrainOnDevice && sTerrain && sTerrain.built_at !== dTerrain.built_at;
        const terrainSizeMb      = sTerrain?.size_mb ?? null;
        const terrainDevBuilt    = dTerrain?.built_at?.slice(0, 10) ?? '?';

        const terrainServerLine = sTerrain
            ? `terrain.bin available${terrainSizeMb != null ? ` (${terrainSizeMb} MB)` : ''}`
            : base ? '<span class="ds-muted">Not available</span>' : '<span class="ds-muted">Server not reachable</span>';
        const terrainDevLine = terrainOnDevice
            ? `terrain.bin on device (built ${terrainDevBuilt})`
            : '<span class="ds-muted">Not synced</span>';
        const terrainBadge = !terrainOnDevice
            ? this._badge('NEEDED', 'gray')
            : terrainUpdateAvail
                ? this._badge('UPDATE AVAILABLE', 'yellow')
                : this._badge('ON DEVICE', 'green');
        let terrainPrimary = '', terrainSecondary = '';
        if (base && sTerrain) {
            if (!terrainOnDevice) {
                terrainPrimary = `<button class="ds-action-btn ds-terrain-sync-btn">DOWNLOAD</button>`;
            } else {
                terrainPrimary   = `<button class="ds-action-btn ${terrainUpdateAvail ? 'ds-update' : 'ds-secondary'} ds-terrain-sync-btn">SYNC</button>`;
                terrainSecondary = `<button class="ds-action-btn ds-secondary ds-terrain-redownload-btn">RE-DOWNLOAD</button>`;
            }
        }

        // Build Route Area card (promoted to main section)
        const bbox = (() => { try { return JSON.parse(localStorage.getItem('flypi_route_bbox') || 'null'); } catch { return null; } })();
        const routeAreaHtml = `
            <div class="ds-section-title">Route Area</div>
            <div class="ds-card">
                <div class="ds-card-detail" style="margin-bottom:8px;font-size:12px;color:var(--text-muted)">Cache map tiles and weather for the active route corridor.</div>
                ${bbox
                    ? `<div class="ds-cache-row">
                            <span class="ds-cache-info"><span class="ds-cache-name">${bbox.label}</span><span class="ds-cache-sub">+60 nm buffer</span></span>
                            <button class="ds-cache-btn" id="dsCacheRouteBtn">Cache Maps</button>
                       </div>`
                    : `<div class="ds-cache-row"><span class="ds-cache-info"><span class="ds-cache-name" style="color:var(--text-muted)">No flight plan loaded</span></span></div>`
                }
                <div class="ds-cache-actions" style="margin-top:8px">
                    <button class="ds-action-btn" id="dsCacheRouteWxBtn">⛅ Fetch Route Weather</button>
                </div>
            </div>`;

        body.innerHTML = `
            <div class="ds-banner" style="color:${bannerColor}">${bannerText}</div>
            <div class="ds-section-title">Aviation Data</div>
            ${this._section('NASR Aeronautical Data',  nasrServerLine,   nasrDevLine,   nasrBadge,   nasrPrimary,    nasrSecondary)}
            ${this._section('CIFP Procedures',          cifpServerLine,   cifpDevLine,   cifpBadge,   cifpPrimary,    cifpSecondary)}
            ${this._section('Terrain Elevation (SRTM)', terrainServerLine, terrainDevLine, terrainBadge, terrainPrimary, terrainSecondary)}
            ${this._section('Approach Plates',          platesServerLine, platesDevLine, platesBadge, platesPrimary,  platesSecondary, true)}
            <div class="ds-section-title">Offline Maps</div>
            ${mbtilesHtml}
            ${routeAreaHtml}
            <div class="ds-footer">Checked: ${ts}</div>
            <div class="ds-section-title" style="cursor:pointer;user-select:none" id="dsSuppToggle">
                Supplemental &amp; Advanced
                <span style="font-size:11px;font-weight:400;color:var(--text-muted)">&#9660;</span>
            </div>
            <div id="dsSuppContent" style="display:none">
                ${this._buildCacheSectionHtml(null, mbt)}
            </div>
            <div id="dsWeatherCacheSection"></div>
        `;

        // Load weather cache asynchronously and inject after main render
        this._renderWeatherCache(body.querySelector('#dsWeatherCacheSection'));

        this._needsSync = needsSync;
        this._wireDataSections();
        this._wireCacheSection();
    }

    /** Render cached pre-flight weather into the given container element. */
    async _renderWeatherCache(containerEl) {
        if (!containerEl) return;
        const nasrDb = window.app?._nasrDb;
        if (!nasrDb) return;

        try {
            await nasrDb.open();
            const entries = await nasrDb.getAllWeather();
            if (!entries || !entries.length) return;

            // Sort: departures/destinations first, then by age (newest first)
            const route = window.app?.cockpitMap?._routeWaypoints || [];
            const routeIcaos = new Set(route.map(w => w.icao).filter(Boolean));
            entries.sort((a, b) => {
                const aRoute = routeIcaos.has(a.icao) ? 0 : 1;
                const bRoute = routeIcaos.has(b.icao) ? 0 : 1;
                if (aRoute !== bRoute) return aRoute - bRoute;
                return (b.fetched_at || '') > (a.fetched_at || '') ? 1 : -1;
            });

            const CAT_COLORS = {
                VFR:  'var(--cat-vfr,  #22c55e)',
                MVFR: 'var(--cat-mvfr, #3b82f6)',
                IFR:  'var(--cat-ifr,  #ef4444)',
                LIFR: 'var(--cat-lifr, #a855f7)',
            };

            const now = Date.now();
            const rows = entries.map(e => {
                const cat     = e.metar?.decoded?.flight_category || '—';
                const color   = CAT_COLORS[cat] || '#888';
                const d       = e.metar?.decoded || {};
                const wDir    = d.wind_dir ?? d.wind?.direction ?? null;
                const wSpd    = d.wind_speed ?? d.wind?.speed ?? null;
                const wind    = wDir != null || wSpd != null
                    ? `${wDir != null ? String(wDir).padStart(3,'0') : '—'}/${Math.round(wSpd || 0)}kt`
                    : '';
                const visSm   = d.visibility_sm ?? d.visibility ?? null;
                const visPlus = d.visibility_plus ?? false;
                const vis     = visSm != null ? `${visPlus ? '>' : ''}${visSm}sm` : '';
                const ceilFt  = d.ceiling_ft ?? d.ceiling ?? null;
                const ceil    = ceilFt != null ? `${ceilFt}ft` : '';
                const summary = [wind, vis, ceil].filter(Boolean).join(' ');
                const ageMin  = e.fetched_at ? Math.round((now - new Date(e.fetched_at).getTime()) / 60000) : null;
                const ageStr  = ageMin !== null ? (ageMin < 60 ? `${ageMin}m` : `${Math.round(ageMin/60)}h`) : '';
                const stale   = ageMin !== null && ageMin > 90;

                return `<div class="ds-wx-row" data-icao="${e.icao}">
                    <span class="ds-wx-icao">${e.icao}</span>
                    <span class="ds-wx-cat" style="color:${color}">${cat}</span>
                    <span class="ds-wx-summary">${summary}</span>
                    <span class="ds-wx-age ${stale ? 'ds-wx-age-stale' : ''}">${ageStr}</span>
                </div>`;
            }).join('');

            const oldestAge = entries.reduce((max, e) => {
                const min = e.fetched_at ? Math.round((now - new Date(e.fetched_at).getTime()) / 60000) : 0;
                return Math.max(max, min);
            }, 0);
            const oldestStr = oldestAge < 60 ? `${oldestAge}m` : `${Math.round(oldestAge/60)}h`;

            containerEl.innerHTML = `
                <div class="ds-section-title">Weather Cache
                    <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:8px">${entries.length} airports · oldest ${oldestStr}</span>
                </div>
                <div class="ds-wx-list">${rows}</div>
                <div style="padding:6px 12px 10px">
                    <button class="ds-action-btn ds-secondary" id="dsWxClearBtn">Clear Cache</button>
                </div>`;

            // Wire airport rows → open airport popup WX tab
            containerEl.querySelectorAll('.ds-wx-row[data-icao]').forEach(row => {
                row.style.cursor = 'pointer';
                row.addEventListener('click', () => {
                    const icao = row.dataset.icao;
                    const ap = window.app?.airportPopup;
                    if (ap?.showForAirport) {
                        ap.showForAirport(icao);
                        // Switch to WX tab after popup opens
                        setTimeout(() => {
                            const wxTab = document.querySelector('.apt-tab[data-tab="wx"]');
                            if (wxTab) wxTab.click();
                        }, 300);
                        // Close Data Status
                        this.hide();
                    }
                });
            });

            // Wire clear button
            const clearBtn = containerEl.querySelector('#dsWxClearBtn');
            if (clearBtn) {
                clearBtn.addEventListener('click', async () => {
                    await nasrDb.clearOldWeather(0); // clear all
                    containerEl.innerHTML = `<div style="padding:10px 12px;color:var(--text-muted);font-size:13px">Weather cache cleared.</div>`;
                });
            }

        } catch (err) {
            console.warn('[DataStatus] Weather cache render failed:', err);
        }
    }

    /** Build a ForeFlight-style inventory section card. */
    _section(title, serverVal, deviceVal, badge, primaryBtn, secondaryBtn = '', multilineDevice = false) {
        const devClass = multilineDevice ? 'ds-row-value ds-row-multiline' : 'ds-row-value';
        return `<div class="ds-section-card">
            <div class="ds-section-head">
                <span class="ds-section-name">${title}</span>
                <span class="ds-section-badge">${badge}</span>
            </div>
            <div class="ds-inv-row">
                <span class="ds-inv-label">Server</span>
                <span class="ds-row-value">${serverVal}</span>
            </div>
            <div class="ds-inv-row">
                <span class="ds-inv-label">Tablet</span>
                <span class="${devClass}">${deviceVal}</span>
                ${(primaryBtn || secondaryBtn) ? `<span class="ds-inv-action">${primaryBtn}${secondaryBtn ? ` <span class="ds-sec-btn">${secondaryBtn}</span>` : ''}</span>` : ''}
            </div>
        </div>`;
    }

    // ── Section Action Wiring ─────────────────────────────────────────────────

    _wireDataSections() {
        const body = this._el.querySelector('.data-status-body');

        // Render sticky footer buttons (outside scroll area, always visible)
        const stickyFooter = this._el.querySelector('#dsStickyFooter');
        if (stickyFooter) {
            const needsSync = this._needsSync;
            stickyFooter.innerHTML = `
                <button class="ds-sync-btn" id="dsSyncAllBtn" ${!needsSync ? 'disabled' : ''}>
                    &#8645; ${needsSync ? 'Sync All Outdated' : 'All Data Current'}
                </button>
            `;
        }

        const progRow  = this._el.querySelector('.ds-progress-row');
        const progFill = this._el.querySelector('.ds-progress-fill');
        const progText = this._el.querySelector('.ds-progress-text');
        const cancelEl = this._el.querySelector('#dsCancelBtn');

        const showProg = (msg) => {
            progRow.classList.add('active');
            progFill.style.width = '0%';
            progText.textContent = msg;
            if (cancelEl) cancelEl.style.display = '';
        };
        const updateProg = (done, total) => {
            progFill.style.width = Math.round(done / total * 100) + '%';
            progText.textContent = `${done} / ${total}`;
        };
        const doneProg = (msg, color) => {
            progFill.style.width = '100%';
            progText.textContent = msg;
            if (progText) progText.style.color = color || '';
            if (cancelEl) cancelEl.style.display = 'none';
        };

        // Sync All button (in sticky footer)
        const syncAllBtn = stickyFooter ? stickyFooter.querySelector('#dsSyncAllBtn') : body.querySelector('#dsSyncAllBtn');
        if (syncAllBtn && !syncAllBtn.disabled) {
            wireTap(syncAllBtn, () => this._syncAll(syncAllBtn, showProg, updateProg, doneProg));
        }

        // Reload App Data button (in sticky footer)
        const reloadBtn = stickyFooter ? stickyFooter.querySelector('#dsReloadAppBtn') : body.querySelector('#dsReloadAppBtn');
        if (reloadBtn) {
            wireTap(reloadBtn, async () => {
                reloadBtn.disabled = true;
                reloadBtn.textContent = 'Reloading…';
                showProg('Reloading app data…', '');
                try {
                    const count = await DataStatus._reimportNasr();
                    // Android path swallows errors and returns undefined — preserve original UI message.
                    // Browser path returns the import count or throws.
                    if (typeof count === 'number') {
                        doneProg(`NASR imported: ${count.toLocaleString()} records`, 'var(--status-ok)');
                        await this._refresh();
                    } else {
                        doneProg('App data reloaded', 'var(--status-ok)');
                    }
                } catch (e) {
                    doneProg(`Reload failed: ${e.message}`, 'var(--status-danger)');
                }
                reloadBtn.disabled = false;
                reloadBtn.innerHTML = '&#8635; Reload App Data';
            });
        }

        // Per-section SYNC/DOWNLOAD buttons all trigger _syncAll (skips already-current items)
        for (const id of ['dsNasrBtn', 'dsCifpBtn', 'dsPlatesBtn']) {
            const btn = body.querySelector(`#${id}`);
            if (btn) wireTap(btn, () => this._syncAll(null, showProg, updateProg, doneProg));
        }

        // NASR RE-DOWNLOAD — force re-download by clearing local cycle stamp
        const nasrRedlBtn = body.querySelector('#dsNasrRedownloadBtn');
        if (nasrRedlBtn) {
            wireTap(nasrRedlBtn, async () => {
                await fetch(`${DataStatus.LOCAL_BASE}/nasr/cycle_info.json`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ _force: true }),
                }).catch(() => {});
                this._syncAll(null, showProg, updateProg, doneProg);
            });
        }

        // CIFP RE-DOWNLOAD — force re-download by clearing local cycle stamp
        const cifpRedlBtn = body.querySelector('#dsCifpRedownloadBtn');
        if (cifpRedlBtn) {
            wireTap(cifpRedlBtn, async () => {
                await fetch(`${DataStatus.LOCAL_BASE}/cifp/cifp_cycle_info.json`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ _force: true }),
                }).catch(() => {});
                this._syncAll(null, showProg, updateProg, doneProg);
            });
        }

        // Plates RE-DOWNLOAD — clear sync state then run full sync
        const platesRedlBtn = body.querySelector('#dsPlatesRedownloadBtn');
        if (platesRedlBtn) {
            wireTap(platesRedlBtn, () => {
                localStorage.removeItem('flypi_plates_synced_states');
                localStorage.removeItem('flypi_plates_cached_at');
                this._saveDeviceSection('plates', { cycle_code: null, synced_states: [] });
                this._syncAll(null, showProg, updateProg, doneProg);
            });
        }

        // MBTiles per-layer download buttons
        body.querySelectorAll('.ds-mbt-dl-btn').forEach(btn => {
            wireTap(btn, () => this._downloadMbtiles(btn.dataset.layer, btn, showProg, doneProg));
        });

        // Terrain SYNC button
        const terrainSyncBtn = body.querySelector('.ds-terrain-sync-btn');
        if (terrainSyncBtn) {
            wireTap(terrainSyncBtn, async () => {
                const homeBase = this._resolvedBase;
                if (!homeBase) return;
                const prevDone = body.querySelector('#dsSyncDoneBtn');
                if (prevDone) prevDone.remove();
                terrainSyncBtn.disabled = true;
                terrainSyncBtn.textContent = 'Syncing…';
                showProg('Starting terrain sync…');
                await this._syncTerrain(homeBase, showProg, updateProg, doneProg);
                terrainSyncBtn.disabled = false;
                terrainSyncBtn.textContent = 'SYNC';
                await this._refresh();
            });
        }

        // Terrain RE-DOWNLOAD — just re-runs full sync (PUT overwrites existing tiles)
        const terrainRedlBtn = body.querySelector('.ds-terrain-redownload-btn');
        if (terrainRedlBtn) {
            wireTap(terrainRedlBtn, async () => {
                const homeBase = this._resolvedBase;
                if (!homeBase) return;
                const prevDone = body.querySelector('#dsSyncDoneBtn');
                if (prevDone) prevDone.remove();
                terrainRedlBtn.disabled = true;
                terrainRedlBtn.textContent = 'Syncing…';
                showProg('Starting terrain re-download…');
                await this._syncTerrain(homeBase, showProg, updateProg, doneProg);
                terrainRedlBtn.disabled = false;
                terrainRedlBtn.textContent = 'RE-DOWNLOAD';
                await this._refresh();
            });
        }

        // Supplemental toggle
        const suppToggle = body.querySelector('#dsSuppToggle');
        const suppContent = body.querySelector('#dsSuppContent');
        if (suppToggle && suppContent) {
            wireTap(suppToggle, () => {
                const hidden = suppContent.style.display === 'none';
                suppContent.style.display = hidden ? '' : 'none';
            });
        }
    }

    // ── Cycle Status Helpers ──────────────────────────────────────────────────

    _cycleStatus(expDate, now) {
        if (!expDate) return this._badge('UNKNOWN', 'gray');
        const daysLeft = (expDate - now) / 86400000;
        if (daysLeft < 0) {
            return this._badge(`EXPIRED (${Math.abs(Math.round(daysLeft))}d ago)`, 'red');
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

    // ── Supplemental Tile Cache Section ───────────────────────────────────────

    _buildCacheSectionHtml(tileCount, mbtiles) {
        const mbt = mbtiles || [];
        const mbtSec = mbt.find(l => l.layer === 'sectional');
        const mbtIfr = mbt.find(l => l.layer === 'ifr-low');
        const bothPresent = mbtSec?.exists && mbtIfr?.exists;

        // Legacy supplemental tile cache — route area
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

        const suppNote = bothPresent
            ? `<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">MBTiles provides full coverage. Individual tile caching only needed for areas outside the packed region.</div>`
            : `<div style="font-size:12px;color:var(--status-caution);margin-bottom:8px">No MBTiles on device. Cache tiles by region to use maps offline.</div>`;

        return `
        <div class="ds-card">
            <div class="ds-card-title">Reload App Data</div>
            <div class="ds-card-detail" style="margin-bottom:10px;font-size:12px;color:var(--text-muted)">Re-imports NASR bundle from Pi into the app — use if the NASR badge shows ?? after a sync.</div>
            <button class="ds-action-btn" id="dsReloadAppBtn">&#8635; Reload App Data</button>
        </div>
        <div class="ds-card">
            <div class="ds-card-title">Individual Tile Cache</div>
            <div class="ds-card-detail" style="margin-bottom:8px">Load tiles from home server or import a ZIP package.</div>
            ${suppNote}
            <div class="ds-cache-actions">
                <button class="ds-action-btn" id="dsLoadServerBtn">Browse ZIPs on Server</button>
                <button class="ds-action-btn" id="dsImportZipBtn">Import ZIP from Files</button>
                <input type="file" id="dsZipInput" accept=".zip" style="display:none">
            </div>
            <div id="dsServerZips"></div>
        </div>
        <div class="ds-card">
            <div class="ds-card-title">CONUS Regions <span style="font-weight:400;font-size:13px;color:var(--text-muted)">(SEC + IFR tiles)</span></div>
            ${regionRows}
        </div>
        <div class="ds-section-title">Approach Plates — Manual</div>
        ${this._platesAgeCard()}
        <div class="ds-card">
            <div class="ds-card-title">Download by Airport</div>
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

        // Load from Home Server
        const loadBtn = body.querySelector('#dsLoadServerBtn');
        const serverZips = body.querySelector('#dsServerZips');
        if (loadBtn) {
            wireTap(loadBtn, async () => {
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
                            wireTap(btn, async () => {
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
                loadBtn.disabled = false; loadBtn.textContent = 'Browse ZIPs on Server';
            });
        }

        // Import ZIP from Files
        const zipInput = body.querySelector('#dsZipInput');
        const importBtn = body.querySelector('#dsImportZipBtn');
        if (importBtn && zipInput) {
            wireTap(importBtn, () => zipInput.click());
            zipInput.addEventListener('change', () => {
                if (zipInput.files[0]) { this._importZip(zipInput.files[0], showProg, updateProg, doneProg); zipInput.value = ''; }
            });
        }

        // Route cache button
        const routeBtn = body.querySelector('#dsCacheRouteBtn');
        if (routeBtn) {
            const bbox = (() => { try { return JSON.parse(localStorage.getItem('flypi_route_bbox') || 'null'); } catch { return null; } })();
            if (bbox) wireTap(routeBtn, () => this._cacheRegion(bbox, routeBtn, showProg, updateProg, doneProg));
        }

        // Route Weather button — triggers flywhere.app weather fetch for active plan
        const routeWxBtn = body.querySelector('#dsCacheRouteWxBtn');
        if (routeWxBtn) {
            wireTap(routeWxBtn, async () => {
                const app = window.app;
                if (!app) return;
                const plan = app.routeTable?._waypoints?.length
                    ? { departure: app.routeTable._waypoints[0]?.icao, destination: app.routeTable._waypoints[app.routeTable._waypoints.length - 1]?.icao }
                    : null;
                if (!plan?.departure && !plan?.destination) {
                    routeWxBtn.textContent = 'No route loaded';
                    setTimeout(() => { routeWxBtn.innerHTML = '⛅ Fetch Route Weather'; }, 2000);
                    return;
                }
                routeWxBtn.disabled = true;
                routeWxBtn.textContent = 'Fetching…';
                try {
                    // Trigger weather fetch via flywhere.app plan weather step if available,
                    // or notify user to use the Weather Briefing for now
                    await app.wxBriefing?.show?.();
                    routeWxBtn.innerHTML = '⛅ Fetch Route Weather';
                    this.hide();
                } catch {
                    routeWxBtn.innerHTML = '⛅ Fetch Route Weather';
                } finally {
                    routeWxBtn.disabled = false;
                }
            });
        }

        // Region buttons
        body.querySelectorAll('.ds-cache-btn[data-region]').forEach(btn => {
            const region = DataStatus.REGIONS.find(r => r.id === btn.dataset.region);
            if (!region) return;
            wireTap(btn, () => this._cacheRegion(region, btn, showProg, updateProg, doneProg));
        });

        // Approach Plates — Download from home server
        const platesStatus = body.querySelector('#dsPlatesStatus');
        const platesInput  = body.querySelector('#dsPlateIcaoInput');
        const dlPlatesBtn  = body.querySelector('#dsDownloadPlatesBtn');
        if (dlPlatesBtn && platesInput) {
            wireTap(dlPlatesBtn, async () => {
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
                        const idxResp = await fetch(`${urls.plateBase}/${icao}/index.json`, { signal: AbortSignal.timeout(5000) });
                        if (!idxResp.ok) { platesStatus.textContent = `No plates for ${icao}`; continue; }
                        const plateList = await idxResp.json();
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
                            } catch { /* skip */ }
                        }
                        updateProg(airports.indexOf(icao) + 1, airports.length);
                    }
                    try {
                        const geoResp = await fetch(`${urls.plateBase}/plate_geo_index.json`, { signal: AbortSignal.timeout(5000) });
                        if (geoResp.ok) {
                            await fetch(`${DataStatus.LOCAL_BASE}/plates/plate_geo_index.json`, { method: 'PUT', body: await geoResp.blob() });
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

        // Import plates ZIP
        const platesZipInput = body.querySelector('#dsPlatesZipInput');
        const importPlatesBtn = body.querySelector('#dsImportPlatesBtn');
        if (importPlatesBtn && platesZipInput) {
            wireTap(importPlatesBtn, () => platesZipInput.click());
            platesZipInput.addEventListener('change', () => {
                if (platesZipInput.files[0]) {
                    this._importPlatesZip(platesZipInput.files[0], showProg, updateProg, doneProg);
                    platesZipInput.value = '';
                }
            });
        }
    }

    // ── Tile Math ─────────────────────────────────────────────────────────────
    _lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
    _lat2tile(lat, z) {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }
    _buildTileUrls(region) {
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
        add('ifr-area',  DataStatus.IFR_AREA_ZOOMS);
        return urls;
    }

    async _cacheRegion(region, btn, showProg, updateProg, doneProg) {
        if (this._cacheRunning) return;
        this._cacheRunning = true; this._cacheCancelled = false;
        if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }

        // Ensure resolved base (Tailscale fallback if local IP unreachable)
        if (!this._resolvedBase) {
            const { base } = await this._resolveHomeBase();
            this._resolvedBase = base;
        }
        const homeBase = this._resolvedBase || this._homeServerUrls().tileBase.replace(/\/tiles\/?$/, '');
        const zipUrl = `${homeBase}/offline-maps/${region.id}.zip`;

        try {
            showProg(`Downloading ${region.id}.zip (${region.mb} MB)…`);
            const resp = await fetch(zipUrl, { signal: AbortSignal.timeout(300000) });
            if (!resp.ok) throw new Error(`ZIP not found (HTTP ${resp.status}) — run build_offline_zip.py ${region.id}`);
            const blob = await resp.blob();
            showProg(`Extracting ${(blob.size / 1024 / 1024).toFixed(0)} MB to device…`);
            const unzipResp = await fetch(`${DataStatus.LOCAL_BASE}/unzip`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/zip' },
                body: blob,
                signal: AbortSignal.timeout(300000),
            });
            if (!unzipResp.ok) throw new Error(`Extraction failed: ${await unzipResp.text()}`);
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
            const total = entries.length;
            updateProg(0, total);
            let done = 0, stored = 0;
            for (const { path, entry } of entries) {
                if (this._cacheCancelled) break;
                try {
                    const blob = await entry.async('blob');
                    const type = path.endsWith('.png') ? 'image/png' : 'image/webp';
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
                    const putResp = await fetch(`${DataStatus.LOCAL_BASE}/plates/${path}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': type },
                        body: blob
                    });
                    if (putResp.ok) stored++;
                } catch { /* skip */ }
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

    // ── Sync All ─────────────────────────────────────────────────────────────

    /**
     * Step-by-step sync: NASR → CIFP → Sectional → IFR Low → Plates.
     * Skips items that are already current. Replaces body with a step checklist
     * while running. No auto-dismiss — pilot sees results and closes manually.
     */
    async _syncAll(btn, showProg, updateProg, doneProg) {
        if (this._cacheRunning) return;
        this._cacheRunning = true;
        if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }

        // Always resolve base dynamically — ensures Tailscale fallback is used
        // if local IP is unreachable (e.g. tablet connected via Tailscale only).
        if (!this._resolvedBase) {
            const { base } = await this._resolveHomeBase();
            this._resolvedBase = base;
        }
        const homeBase = this._resolvedBase;
        const LOCAL    = DataStatus.LOCAL_BASE;

        const body = this._el.querySelector('.data-status-body');
        const stepIds    = ['nasr', 'cifp', 'sec', 'ifr', 'plates'];
        const stepLabels = {
            nasr:   'NASR Aeronautical Data',
            cifp:   'CIFP Procedures',
            sec:    'Sectional MBTiles',
            ifr:    'IFR Low MBTiles',
            plates: 'Approach Plates',
        };

        const renderSteps = (states) => {
            const icons  = { pending: '&#9675;', running: '&#8987;', ok: '&#10003;', skip: '&#8594;', fail: '&#10007;' };
            const colors = { pending: 'var(--text-muted)', running: 'var(--status-caution)', ok: 'var(--status-ok)', skip: 'var(--text-muted)', fail: 'var(--status-danger)' };
            return `<div style="padding:8px 0">` +
                stepIds.map(id => {
                    const s = states[id] || { status: 'pending', msg: '' };
                    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-light)">
                        <span style="font-size:18px;color:${colors[s.status]};width:20px;text-align:center">${icons[s.status]}</span>
                        <span style="flex:1">
                            <span style="font-weight:600">${stepLabels[id]}</span>
                            ${s.msg ? `<span style="color:var(--text-muted);font-size:13px;display:block">${s.msg}</span>` : ''}
                        </span>
                    </div>`;
                }).join('') +
                `</div><button class="ds-sync-btn" id="dsSyncDoneBtn" style="margin-top:12px">Done — Refresh</button>`;
        };

        const states = { nasr: { status: 'pending' }, cifp: { status: 'pending' }, sec: { status: 'pending' }, ifr: { status: 'pending' }, plates: { status: 'pending' } };
        const setStep   = (id, status, msg) => { states[id] = { status, msg }; body.innerHTML = renderSteps(states); this._wireDoneBtn(); };
        const failStep  = (id, err)         => setStep(id, 'fail', err?.message || String(err));

        body.innerHTML = renderSteps(states);
        this._wireDoneBtn();

        const fetchAndPut = async (serverPath, localPath, mime) => {
            const r = await fetch(`${homeBase}${serverPath}`, { signal: AbortSignal.timeout(30000) });
            if (!r.ok) throw new Error(`Server ${r.status}`);
            const blob = await r.blob();
            const put = await fetch(`${LOCAL}/${localPath}`, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob, signal: AbortSignal.timeout(30000) });
            if (!put.ok) throw new Error(`PUT failed ${put.status}`);
            return blob.size;
        };

        // ── NASR ─────────────────────────────────────────────────────────────
        setStep('nasr', 'running', 'Checking cycle…');
        try {
            const [serverResp, localResp] = await Promise.all([
                fetch(`${homeBase}/nasr/cycle_info.json`, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
                fetch(`${LOCAL}/nasr/cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) }).then(r => r.ok ? r.json() : null).catch(() => null),
            ]);
            if (!serverResp) throw new Error('Home server not reachable');
            const serverDate    = serverResp.effective_date;
            const localDate     = localResp?.effective_date;
            const serverSuaCnt  = serverResp.sua_count ?? null;
            const localSuaCnt   = localResp?.sua_count  ?? null;
            const suaUpToDate   = serverSuaCnt === null || (localSuaCnt !== null && serverSuaCnt === localSuaCnt);
            if (localDate === serverDate && suaUpToDate) {
                setStep('nasr', 'skip', `Current — cycle ${serverDate}`);
            } else {
                setStep('nasr', 'running', `Downloading NASR bundle${localDate ? ' (' + localDate + ' → ' + serverDate + ')' : ''}…`);
                // Use fetch-zip (Java download) — avoids loading 18MB blob into WebView memory
                // nasr.zip extracts to nasr/bundle.json + nasr/cycle_info.json + nasr/geo_context.json
                const nasrZipUrl = encodeURIComponent(`${homeBase}/nasr/nasr.zip`);
                const zipResp = await fetch(`${LOCAL}/fetch-zip?url=${nasrZipUrl}`, {
                    method: 'POST',
                    signal: AbortSignal.timeout(120000), // 2 min for zip download + extract
                });
                if (!zipResp.ok) {
                    const msg = await zipResp.text().catch(() => `HTTP ${zipResp.status}`);
                    throw new Error(`fetch-zip failed: ${msg}`);
                }
                setStep('nasr', 'ok', `Updated to cycle ${serverDate} — loading into app…`);
                // Force reimport into IndexedDB so the app reflects the new data immediately
                try { await DataStatus._reimportNasr(); }
                catch (e) { console.warn('[DataStatus] post-sync NASR reimport failed:', e?.message); }
                this._saveDeviceSection('nasr', {
                    effective_date: serverResp.effective_date,
                    bundle_version: serverResp.bundle_version,
                });
                setStep('nasr', 'ok', `Updated to cycle ${serverDate}`);
            }
        } catch (e) { failStep('nasr', e); }

        // ── CIFP ─────────────────────────────────────────────────────────────
        setStep('cifp', 'running', 'Checking cycle…');
        try {
            const [serverResp, localResp] = await Promise.all([
                fetch(`${homeBase}/cifp/cifp_cycle_info.json`, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
                fetch(`${LOCAL}/cifp/cifp_cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) }).then(r => r.ok ? r.json() : null).catch(() => null),
            ]);
            if (!serverResp) throw new Error('CIFP cycle info not available');
            const serverCode = serverResp.cycle_code || serverResp.effective_date;
            const localCode  = localResp?.cycle_code  || localResp?.effective_date;
            if (localCode && localCode === serverCode) {
                setStep('cifp', 'skip', `Current — cycle ${serverCode}`);
            } else {
                setStep('cifp', 'running', 'Downloading CIFP bundle…');
                // Use Java-side fetch-zip (same as NASR) to avoid loading 30 MB blob into WebView
                const cifpZipUrl = encodeURIComponent(`${homeBase}/cifp/cifp.zip`);
                const cifpResp = await fetch(`${LOCAL}/fetch-zip?url=${cifpZipUrl}`, {
                    method: 'POST',
                    signal: AbortSignal.timeout(120000),
                });
                if (!cifpResp.ok) {
                    const msg = await cifpResp.text().catch(() => `HTTP ${cifpResp.status}`);
                    throw new Error(`fetch-zip failed: ${msg}`);
                }
                this._saveDeviceSection('cifp', { cycle_code: serverCode });
                setStep('cifp', 'ok', `Updated to cycle ${serverCode}`);
            }
        } catch (e) { failStep('cifp', e); }

        // ── MBTiles ───────────────────────────────────────────────────────────
        let mbStatus = [];
        try {
            const r = await fetch(`${LOCAL}/mbtiles/status`, { cache: 'no-store', signal: AbortSignal.timeout(3000) });
            if (r.ok) mbStatus = await r.json();
        } catch { /* NanoHTTPD offline */ }

        for (const [stepId, layer, label] of [['sec', 'sectional', 'Sectional (~1.8 GB)'], ['ifr', 'ifr-low', 'IFR Low (~600 MB)'], ['ifr-area', 'ifr-area', 'IFR Area (~150 MB)']]) {
            const entry = mbStatus.find(s => s.layer === layer);
            if (entry?.exists) {
                setStep(stepId, 'skip', `On device — ${entry.size_mb.toLocaleString()} MB`);
                continue;
            }
            setStep(stepId, 'running', `Downloading ${label} — this may take 10–20 min…`);
            try {
                const mbUrl  = `${homeBase}/mbtiles/${layer}.mbtiles`;
                const resp   = await fetch(
                    `${LOCAL}/fetch-mbtiles?layer=${encodeURIComponent(layer)}&url=${encodeURIComponent(mbUrl)}`,
                    { method: 'POST', signal: AbortSignal.timeout(1800000) }
                );
                if (!resp.ok) throw new Error(await resp.text());
                const result = await resp.json();
                if (this._serverManifest?.tiles?.[layer]) {
                    const devTiles = this._readDeviceManifest().tiles || {};
                    this._saveDeviceSection('tiles', { ...devTiles, [layer]: this._serverManifest.tiles[layer] });
                }
                setStep(stepId, 'ok', `Downloaded — ${Math.round(result.bytes / (1024 * 1024)).toLocaleString()} MB`);
            } catch (e) { failStep(stepId, e); }
        }

        // ── Plates ───────────────────────────────────────────────────────────
        setStep('plates', 'running', 'Checking plate cycle…');
        try {
            const [serverCycle, localCycle] = await Promise.all([
                fetch(`${homeBase}/plates/plates_cycle_info.json`, { signal: AbortSignal.timeout(8000) }).then(r => r.ok ? r.json() : null),
                fetch(`${LOCAL}/plates/plates_cycle_info.json`, { cache: 'no-store', signal: AbortSignal.timeout(2000) }).then(r => r.ok ? r.json() : null).catch(() => null),
            ]);
            // Prefer state_sizes (has real MB values) over states string array
            const statesResp = serverCycle?.state_sizes
                ? serverCycle.state_sizes
                : (serverCycle?.states ? serverCycle.states.map(s => ({ state: s, size_mb: 0 })) : []);

            const serverDate = serverCycle?.effective_date;
            const localDate  = localCycle?.effective_date;
            const cycleMatch = localDate && localDate === serverDate;
            const syncedStates = this._readDeviceManifest().plates?.synced_states || [];
            const allStatesSynced = statesResp.length > 0 && statesResp.every(s => syncedStates.includes(s.state));
            const needsUpdate = !cycleMatch || !allStatesSynced;

            if (!needsUpdate) {
                setStep('plates', 'skip', `Current — cycle ${serverDate}`);
            } else if (!statesResp.length) {
                setStep('plates', 'skip', 'No plate states available on server');
            } else {
                const statesToSync = statesResp;
                const totalMb = statesToSync.reduce((s, r) => s + r.size_mb, 0);
                const stateList = statesToSync.map(s => s.state).join(', ');
                setStep('plates', 'running', `Downloading ${statesToSync.length} states (${stateList}) — ~${totalMb.toLocaleString()} MB…`);

                let done = 0;
                const newlySynced = [...syncedStates];
                for (const stateInfo of statesToSync) {
                    const st = stateInfo.state;
                    const mb = stateInfo.size_mb;
                    setStep('plates', 'running', `↓ ${st} (${mb} MB) — ${done}/${statesToSync.length} done…`);

                    // Tick elapsed time every 5s so pilot can see it's still working
                    const startTs = Date.now();
                    const ticker = setInterval(() => {
                        const elapsed = Math.round((Date.now() - startTs) / 1000);
                        setStep('plates', 'running', `↓ ${st} (${mb} MB) — ${elapsed}s — ${done}/${statesToSync.length} done…`);
                    }, 5000);

                    try {
                        // NanoHTTPD fetch-zip: download state zip from home server
                        // and extract directly into the tablet's local storage
                        const zipUrl = `${homeBase}/plates/state_zips/${st}.zip`;
                        const resp = await fetch(
                            `${LOCAL}/fetch-zip?url=${encodeURIComponent(zipUrl)}`,
                            { method: 'POST', signal: AbortSignal.timeout(600000) }
                        );
                        clearInterval(ticker);
                        if (!resp.ok) throw new Error(`${st}: ${await resp.text()}`);
                        const result = await resp.json();
                        done++;
                        if (!newlySynced.includes(st)) newlySynced.push(st);
                        setStep('plates', 'running', `✓ ${st} done (${result.extracted?.toLocaleString() ?? '?'} files) — ${done}/${statesToSync.length} complete`);
                    } catch (e) {
                        clearInterval(ticker);
                        setStep('plates', 'running', `✗ ${st} failed: ${e.message} — continuing…`);
                        done++;
                    }
                }
                if (serverCycle) {
                    await fetch(`${LOCAL}/plates/plates_cycle_info.json`, {
                        method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(serverCycle),
                    }).catch(() => {});
                }
                localStorage.setItem('flypi_plates_synced_states', JSON.stringify(newlySynced));
                localStorage.setItem('flypi_plates_cached_at', Date.now().toString());
                this._saveDeviceSection('plates', {
                    cycle_code: serverCycle.cycle_code || serverCycle.effective_date,
                    synced_states: newlySynced,
                });
                setStep('plates', 'ok', `${done} states downloaded — cycle ${serverDate}`);
            }
        } catch (e) { failStep('plates', e); }

        // ── Done ──────────────────────────────────────────────────────────────
        this._cacheRunning = false;
        if (btn) { btn.disabled = false; btn.innerHTML = '&#8645; Sync All Outdated'; }
        if (doneProg) doneProg('Sync complete', 'var(--status-ok)');
        this._wireDoneBtn();
    }

    /** Wire the "Done — Refresh" button that appears after _syncAll completes. */
    _wireDoneBtn() {
        const btn = this._el.querySelector('#dsSyncDoneBtn');
        if (btn) wireTap(btn, async () => {
            await window.app?._updateNasrBadge?.();
            this._refresh();
        });
    }

    /**
     * Force-reimport NASR bundle from NanoHTTPD into IndexedDB.
     * Used after a sync to make the app reflect updated data without a restart.
     */
    static async _reimportNasr() {
        const app = window.app;
        if (!app?._nasrDb) return;

        // Cockpit / Android wrapper: original NanoHTTPD-only path, byte-identical
        // to before. Never reach for the home server here — offline cockpit must
        // not block on a 60s fetch against an unreachable home base.
        const isNative = !!(window.Capacitor?.isNativePlatform?.());
        if (isNative) {
            try {
                const resp = await fetch('http://localhost:9090/nasr/bundle.json', {
                    signal: AbortSignal.timeout(60000), // 18MB JSON parse can be slow on tablet
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const bundle = await resp.json();
                await app._nasrDb.importNasrBundle(bundle);
                await app._updateNasrBadge?.();
                app.vectorLayers?._updateDynamicLayers?.();
            } catch (e) {
                console.warn('[DataStatus] NASR reimport failed:', e?.message);
            }
            return;
        }

        // Browser dev mode: NanoHTTPD is absent, pull bundle.json directly from
        // the configured home server. Throws on failure so the caller can surface
        // it. This path is unreachable on Android.
        const bases = (typeof CockpitConfig !== 'undefined') ? CockpitConfig.homeBases : [];
        if (!bases.length) throw new Error('No home server configured');

        let bundle = null;
        let lastErr = null;
        for (const base of bases) {
            try {
                const resp = await fetch(`${base}/nasr/bundle.json`, {
                    cache: 'no-store',
                    signal: AbortSignal.timeout(60000),
                });
                if (!resp.ok) { lastErr = new Error(`HTTP ${resp.status} from ${base}`); continue; }
                bundle = await resp.json();
                break;
            } catch (e) {
                lastErr = e;
            }
        }
        if (!bundle) throw lastErr || new Error('Home server bundle.json not reachable');

        const count = await app._nasrDb.importNasrBundle(bundle);
        await app._updateNasrBadge?.();
        app.vectorLayers?._updateDynamicLayers?.();
        return count;
    }

    /**
     * Download terrain.bin and terrain.json from the home server to NanoHTTPD.
     * Streams terrain.bin (~31 MB) with progress, then PUTs both files to device.
     */
    async _syncTerrain(homeBase, showProg, updateProg, doneProg) {
        const _download = async (url, label) => {
            const resp = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${label}`);
            const total = parseInt(resp.headers.get('Content-Length') || '0');
            const reader = resp.body.getReader();
            const chunks = [];
            let received = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                if (total) updateProg(received, total);
            }
            const buf = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
            let offset = 0;
            for (const c of chunks) { buf.set(c, offset); offset += c.length; }
            return buf;
        };

        try {
            // Download terrain.bin (~31 MB) with progress
            showProg('Downloading terrain grid (~31 MB)…');
            const binData = await _download(`${homeBase}/terrain/grid/terrain.bin`, 'terrain.bin');

            showProg('Saving terrain.bin to device…');
            const putBin = await fetch(`${DataStatus.LOCAL_BASE}/terrain/terrain.bin`, {
                method: 'PUT',
                body: binData,
                headers: { 'Content-Type': 'application/octet-stream' },
                signal: AbortSignal.timeout(60000),
            });
            if (!putBin.ok) throw new Error(`PUT terrain.bin failed: HTTP ${putBin.status}`);

            // Download and save terrain.json (tiny)
            showProg('Downloading terrain.json…');
            const jsonData = await _download(`${homeBase}/terrain/grid/terrain.json`, 'terrain.json');
            const putJson = await fetch(`${DataStatus.LOCAL_BASE}/terrain/terrain.json`, {
                method: 'PUT',
                body: jsonData,
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(10000),
            });
            if (!putJson.ok) throw new Error(`PUT terrain.json failed: HTTP ${putJson.status}`);

            // Reload the in-memory grid
            if (window.terrainGrid) {
                window.terrainGrid._loaded = false;
                window.terrainGrid._loading = false;
                window.terrainGrid.load();
            }

            if (this._serverManifest?.terrain) {
                this._saveDeviceSection('terrain', this._serverManifest.terrain);
            }
            doneProg('Terrain grid synced — reload app to activate', 'var(--status-ok)');
        } catch (err) {
            doneProg('Terrain sync failed: ' + err.message, 'var(--status-danger)');
        }
    }

    async _downloadMbtiles(layer, btn, showProg, doneProg) {
        if (this._cacheRunning) return;
        this._cacheRunning = true;
        btn.disabled = true;
        btn.textContent = 'Downloading…';

        const homeBase    = this._homeBase();
        const mbtilesUrl  = `${homeBase}/mbtiles/${layer}.mbtiles`;

        showProg(`Connecting to home server for ${layer}.mbtiles…`);

        let pollInterval = null;
        const startPoll = () => {
            pollInterval = setInterval(async () => {
                try {
                    const r = await fetch(`${DataStatus.LOCAL_BASE}/mbtiles/status`,
                        { cache: 'no-store', signal: AbortSignal.timeout(1000) });
                    if (!r.ok) return;
                    const status = await r.json();
                    const entry = status.find(s => s.layer === layer);
                    if (entry?.size_mb > 0) {
                        const el = document.querySelector('.ds-progress-text');
                        if (el) el.textContent = `Downloading ${layer}.mbtiles… ${entry.size_mb.toLocaleString()} MB received`;
                    }
                } catch { /* ignore poll errors */ }
            }, 3000);
        };
        startPoll();

        try {
            const resp = await fetch(
                `${DataStatus.LOCAL_BASE}/fetch-mbtiles?layer=${encodeURIComponent(layer)}&url=${encodeURIComponent(mbtilesUrl)}`,
                { method: 'POST', signal: AbortSignal.timeout(1800000) }
            );
            clearInterval(pollInterval);
            if (!resp.ok) throw new Error(await resp.text());
            const result = await resp.json();
            const mb = Math.round(result.bytes / (1024 * 1024));
            if (this._serverManifest?.tiles?.[layer]) {
                const devTiles = this._readDeviceManifest().tiles || {};
                this._saveDeviceSection('tiles', { ...devTiles, [layer]: this._serverManifest.tiles[layer] });
            }
            doneProg(`\u2713 ${layer}.mbtiles downloaded (${mb.toLocaleString()} MB)`, 'var(--status-ok)');
            setTimeout(() => this._refresh(), 1500);
        } catch (err) {
            clearInterval(pollInterval);
            doneProg(`Failed: ${err.message}`, 'var(--status-danger)');
        }

        this._cacheRunning = false;
        btn.disabled = false;
        btn.textContent = 'Re-download';
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

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
            <div class="ds-sticky-footer" id="dsStickyFooter"></div>
        `;
        wireTap(this._el.querySelector('.data-status-close'), () => this.hide());
        this._parentEl.appendChild(this._el);
    }
}
