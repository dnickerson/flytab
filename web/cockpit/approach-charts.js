/**
 * FlyTab — Approach Charts (Georeferenced Plate Viewer)
 * Route-aware plate picker with ownship overlay + Leaflet map overlay mode.
 *
 * Architecture: Plates are stored locally on Android filesystem at
 * Documents/FlyTab/plates/ and served by NanoHTTPD at http://localhost:9090/plates/.
 * Pi is data relay only — no plate data from Pi.
 */

const PLATES_BASE = 'http://localhost:9090/plates';
const CIFP_BUNDLE_URL = 'http://localhost:9090/cifp/cifp_bundle.json';
const PLATES_FETCH_TIMEOUT = 3000; // 3s timeout for NanoHTTPD requests

/** Fetch with a timeout (AbortController). Rejects on timeout. */
function _fetchWithTimeout(url, opts = {}, timeoutMs = PLATES_FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

class ApproachCharts {
    constructor(container) {
        this._container = container;
        this._plateIndex = null;
        this._geoIndex = null;
        this._cifpBundle = null; // All CIFP approach procedures in memory
        this._routeAirports = [];
        this._currentPlate = null;
        this._ownshipPos = null;
        this._ownshipHeading = 0;

        this._pickerEl = null;
        this._viewerEl = null;
        this._canvasEl = null;
        this._imgEl = null;
        this._panContainer = null;
        this._mapBtn = null;
        this._plates = [];
        this._plateIdx = 0;
        this._loadPromise = null;
        this._pz = { scale: 1, tx: 0, ty: 0 }; // pan/zoom state
        this._pickerShownAt = 0; // timestamp guard against synthetic click ghost-taps

        // Map overlay
        this._leafletMap = null;
        this._mapOverlay = null;
        this._overlayBar = null;
        this._lastOverlayPlate = null; // Remember last plate for toggle
        this._plateToggleBtn = null;

        this._buildDOM();
    }

    // ========== Public API ==========

    setNasrDb(db) { this._nasrDb = db; }

    async loadIndex() {
        // Offline-first: try IndexedDB cache first for instant load
        if (this._nasrDb) {
            try {
                const [cachedPlates, cachedGeo] = await Promise.all([
                    this._nasrDb.getAppCache('plate_index'),
                    this._nasrDb.getAppCache('plate_geo_index'),
                ]);
                if (cachedPlates) {
                    this._plateIndex = cachedPlates;
                    console.log('[ApproachCharts] Plate index from cache:', Object.keys(cachedPlates).length, 'airports');
                }
                if (cachedGeo) this._geoIndex = cachedGeo;
            } catch { /* IDB not ready */ }
        }

        // Try CIFP bundle from IndexedDB cache
        if (this._nasrDb) {
            try {
                const cachedCifp = await this._nasrDb.getAppCache('cifp_bundle');
                if (cachedCifp) {
                    this._cifpBundle = cachedCifp;
                    console.log('[ApproachCharts] CIFP bundle from cache:', Object.keys(cachedCifp).length, 'airports');
                }
            } catch { /* IDB not ready */ }
        }

        // Background refresh from network (or foreground if no cache)
        const hadCache = !!this._plateIndex;
        await this._refreshIndex();
        if (!hadCache && !this._plateIndex) {
            console.warn('[ApproachCharts] No plate index available (offline, no cache)');
        }
    }

    async _refreshIndex() {
        // Try master plate_index.json first (has proper chart names + types)
        try {
            const resp = await _fetchWithTimeout(`${PLATES_BASE}/plate_index.json`);
            if (resp.ok) {
                const data = await resp.json();
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    this._plateIndex = data;
                    if (this._nasrDb) this._nasrDb.putAppCache('plate_index', data).catch(() => {});
                    console.log('[ApproachCharts] Master plate index loaded:', Object.keys(data).length, 'airports');
                }
            }
        } catch { /* master index optional */ }

        // Fall back to per-airport index.json if no master index
        if (!this._plateIndex && this._routeAirports.length > 0) {
            if (!this._plateIndex) this._plateIndex = {};
            await Promise.all(this._routeAirports.map(icao => this._fetchSingleAirportIndex(icao)));
        }

        // Load georef index from NanoHTTPD (saved during pre-flight plate download)
        try {
            const resp = await _fetchWithTimeout(`${PLATES_BASE}/plate_geo_index.json`);
            if (resp.ok) {
                const data = await resp.json();
                this._geoIndex = data;
                if (this._nasrDb) this._nasrDb.putAppCache('plate_geo_index', data).catch(() => {});
            }
        } catch { /* georef optional */ }

        // Load CIFP approach procedure bundle (14MB, all airports in one file)
        if (!this._cifpBundle) {
            try {
                const resp = await _fetchWithTimeout(CIFP_BUNDLE_URL, {}, 30000); // 30s for large file
                if (resp.ok) {
                    const data = await resp.json();
                    this._cifpBundle = data;
                    console.log('[ApproachCharts] CIFP bundle loaded:', Object.keys(data).length, 'airports');
                    if (this._nasrDb) this._nasrDb.putAppCache('cifp_bundle', data).catch(() => {});
                }
            } catch (err) {
                console.warn('[ApproachCharts] CIFP bundle not available:', err.message);
            }
        }
    }

    async ensureLoaded() {
        if (this._plateIndex) return;
        if (this._loadPromise) return this._loadPromise;
        this._loadPromise = this.loadIndex();
        return this._loadPromise;
    }

    setRouteAirports(icaoList) {
        this._routeAirports = icaoList || [];
    }

    setMap(leafletMap) {
        this._leafletMap = leafletMap;
        // Create plate toggle button on the map
        if (leafletMap) {
            this._plateToggleBtn = document.createElement('button');
            this._plateToggleBtn.className = 'plate-toggle-btn';
            this._plateToggleBtn.textContent = 'PLATE';
            this._plateToggleBtn.style.display = 'none';
            let touchFired = false;
            this._plateToggleBtn.addEventListener('touchstart', (e) => {
                e.stopPropagation();
                touchFired = true;
                this._togglePlateOverlay();
                setTimeout(() => { touchFired = false; }, 400);
            });
            this._plateToggleBtn.addEventListener('click', () => {
                if (!touchFired) this._togglePlateOverlay();
            });
            L.DomEvent.disableClickPropagation(this._plateToggleBtn);
            leafletMap.getContainer().appendChild(this._plateToggleBtn);
        }
    }

    async showForAirport(icao) {
        if (this._loadPromise) {
            this._showMessage('Loading plates…');
            await this._loadPromise;
        }
        // icao missing from index — try fetching per-airport from local filesystem
        if (!this._plateIndex?.[icao]) {
            this._showMessage('Loading plates…');
            await this._fetchSingleAirportIndex(icao);
        }
        if (!this._plateIndex?.[icao]) {
            // Last resort: build plate list from georef index (always present on device)
            const geoPlates = this._buildPlatesFromGeoIndex(icao);
            if (geoPlates) {
                if (!this._plateIndex) this._plateIndex = {};
                this._plateIndex[icao] = geoPlates;
                console.log(`[ApproachCharts] Built ${geoPlates.plates.length} plates for ${icao} from geo index`);
            }
        }
        if (!this._plateIndex?.[icao]) {
            this._showMessage(`No plates for ${icao} — download plates via Pre-Flight Refresh`);
            this._pickerShownAt = Date.now();
            this._pickerEl.style.display = 'flex';
            return;
        }

        this._viewerEl.style.display = 'none';
        this._buildPicker(icao);
        this._pickerShownAt = Date.now();
        this._pickerEl.style.display = 'flex';
    }

    async showForRoute() {
        if (this._loadPromise) {
            this._showMessage('Loading plates…');
            await this._loadPromise;
        }
        // No index loaded — fetch per-airport from local filesystem
        if (!this._plateIndex && this._routeAirports.length > 0) {
            this._showMessage('Loading plates…');
            await Promise.all(this._routeAirports.map(icao => this._fetchSingleAirportIndex(icao)));
        }
        this._viewerEl.style.display = 'none';
        this._buildPicker(null);
        this._pickerShownAt = Date.now();
        this._pickerEl.style.display = 'flex';
    }

    /** Fetch plate list for a single airport from local NanoHTTPD filesystem. */
    async _fetchSingleAirportIndex(icao) {
        try {
            const resp = await _fetchWithTimeout(`${PLATES_BASE}/${encodeURIComponent(icao)}/index.json`);
            if (resp.status === 404) {
                // No index.json — try NanoHTTPD directory listing (always works if plates are on device)
                await this._fetchPlateList(icao);
                return;
            }
            if (!resp.ok) return;
            let data = await resp.json();
            // index.json may be { plates: [...] } or a flat array of filenames.
            // Normalize flat array to { plates: [{filename, name}, ...] }
            if (Array.isArray(data)) {
                // The pipeline creates two copies of each plate:
                //   - Raw FAA code: "05853BARMY.PDF"  (uppercase .PDF — meaningless name)
                //   - Readable name: "BARMY_FIVE_(RNAV).pdf"  (lowercase .pdf — human readable)
                // Only show lowercase .pdf files so names are meaningful.
                const readable = data.filter(f => typeof f === 'string' && f.endsWith('.pdf'));
                // Fall back to all PDFs if no readable files found (edge case)
                const pdfs = readable.length > 0
                    ? readable
                    : data.filter(f => typeof f === 'string' && /\.pdf$/i.test(f));
                data = { plates: pdfs.map(f => {
                    if (typeof f !== 'string') return f;
                    const name = f.replace(/\.pdf$/, '').replace(/_/g, ' ');
                    const type = /rnav|ils|vor|ndb|lda|loc|gls|rwy/i.test(name) ? 'IAP'
                               : /sid|departure/i.test(name) ? 'SID'
                               : /star|arrival/i.test(name) ? 'STAR'
                               : /odp|obstacle/i.test(name) ? 'ODP' : 'IAP';
                    return { filename: f, name, type };
                }) };
            }
            if (data.plates?.length) {
                if (!this._plateIndex) this._plateIndex = {};
                this._plateIndex[icao] = data;
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn(`[ApproachCharts] Fetch timed out for ${icao} plates`);
            }
        }
    }

    /** Fetch plate list from NanoHTTPD directory listing when index.json is absent. */
    async _fetchPlateList(icao) {
        try {
            const resp = await _fetchWithTimeout(`${PLATES_BASE}/${encodeURIComponent(icao)}/list`);
            if (!resp.ok) return;
            const files = await resp.json();
            if (!Array.isArray(files) || files.length === 0) return;
            const plates = files.map(f => {
                const name = f.replace(/\.pdf$/, '').replace(/_/g, ' ');
                const type = /rnav|ils|vor|ndb|lda|loc|gls|rwy/i.test(name) ? 'IAP'
                           : /sid|departure/i.test(name) ? 'SID'
                           : /star|arrival/i.test(name) ? 'STAR'
                           : /odp|obstacle/i.test(name) ? 'ODP' : 'IAP';
                return { filename: f, name, type };
            });
            if (!this._plateIndex) this._plateIndex = {};
            this._plateIndex[icao] = { plates };
            console.log(`[ApproachCharts] Listed ${plates.length} plates for ${icao} from NanoHTTPD`);
        } catch (err) {
            if (err.name === 'AbortError') {
                console.warn(`[ApproachCharts] List timed out for ${icao}`);
            }
        }
    }

    /** Build a synthetic plate list from _geoIndex when no index.json is available.
     *  Prefers human-readable keys (e.g. RNAV_(GPS)_RWY_06) over raw FAA codes (05853R6). */
    _buildPlatesFromGeoIndex(icao) {
        if (!this._geoIndex) return null;
        const prefix = icao + '/';
        const plates = [];
        const seen = new Set(); // deduplicate by webp stem
        for (const key of Object.keys(this._geoIndex)) {
            if (!key.startsWith(prefix)) continue;
            const stem = key.slice(prefix.length);
            // Skip raw FAA code entries (start with digits e.g. "05853R6")
            // The georef index has duplicate entries — readable name preferred
            if (/^\d/.test(stem)) continue;
            const name = stem.replace(/_/g, ' ');
            const entry = this._geoIndex[key];
            const webpFile = entry?.webp ? entry.webp.split('/').pop() : null;
            if (webpFile && seen.has(webpFile)) continue;
            if (webpFile) seen.add(webpFile);
            const type = /rnav|ils|vor|ndb|lda|loc|gls|rwy/i.test(name) ? 'IAP'
                       : /sid|departure/i.test(name) ? 'SID'
                       : /star|arrival/i.test(name) ? 'STAR' : 'IAP';
            // Use readable stem as PDF filename (e.g. RNAV_(GPS)_RWY_06.pdf)
            plates.push({ filename: stem + '.pdf', name, type });
        }
        if (plates.length === 0) return null;
        return { plates };
    }

    updateOwnship(lat, lon, heading) {
        this._ownshipPos = { lat, lon };
        this._ownshipHeading = heading || 0;
        if (this._currentPlate && this._viewerEl.style.display !== 'none') {
            this._renderOwnship();
        }
    }

    hide() {
        if (this._pickerEl) this._pickerEl.style.display = 'none';
        if (this._viewerEl) this._viewerEl.style.display = 'none';
        this._currentPlate = null;
    }

    // ========== Map Overlay ==========

    showOnMap(idx) {
        if (idx === undefined) idx = this._plateIdx;
        if (idx < 0 || idx >= this._plates.length) return;

        const plate = this._plates[idx];
        const georef = this._findGeoref(plate);

        if (!georef || !georef.bounds || !georef.webp) {
            if (typeof app !== 'undefined') {
                const toast = app.showToast('No georef data for this plate');
                setTimeout(() => toast?.remove(), 3000);
            }
            return;
        }

        if (!this._leafletMap) return;

        // Remove existing overlay
        this.removeMapOverlay();

        const webpUrl = `${PLATES_BASE}/${georef.webp.split('/').map(encodeURIComponent).join('/')}`;
        const bounds = L.latLngBounds(georef.bounds);

        this._mapOverlay = L.imageOverlay(webpUrl, bounds, {
            opacity: 0.75,
            interactive: false,
            zIndex: 450,
        }).addTo(this._leafletMap);

        this._currentPlate = plate;
        this._plateIdx = idx;

        // Remember for toggle
        this._lastOverlayPlate = { idx, plate, georef };
        if (this._plateToggleBtn) this._plateToggleBtn.style.display = 'none';

        // Hide standalone viewer
        this._viewerEl.style.display = 'none';
        this._pickerEl.style.display = 'none';

        // Fit map to plate bounds with padding
        this._leafletMap.fitBounds(bounds, { padding: [20, 20] });

        // Show overlay control bar
        this._showOverlayBar(plate, georef);
    }

    removeMapOverlay() {
        if (this._mapOverlay) {
            this._leafletMap.removeLayer(this._mapOverlay);
            this._mapOverlay = null;
        }
        if (this._overlayBar) {
            this._overlayBar.remove();
            this._overlayBar = null;
        }
        // Show toggle button so user can re-display the plate
        if (this._lastOverlayPlate && this._plateToggleBtn) {
            this._plateToggleBtn.style.display = '';
        }
    }

    _togglePlateOverlay() {
        if (!this._lastOverlayPlate) return;
        const { idx, plate, georef } = this._lastOverlayPlate;
        // Re-add the overlay without re-fitting the map
        const webpUrl = `${PLATES_BASE}/${georef.webp.split('/').map(encodeURIComponent).join('/')}`;
        const bounds = L.latLngBounds(georef.bounds);

        this._mapOverlay = L.imageOverlay(webpUrl, bounds, {
            opacity: 0.75,
            interactive: false,
            zIndex: 450,
        }).addTo(this._leafletMap);

        this._currentPlate = plate;
        this._plateIdx = idx;
        if (this._plateToggleBtn) this._plateToggleBtn.style.display = 'none';
        this._showOverlayBar(plate, georef);
    }

    hasMapOverlay() {
        return !!this._mapOverlay;
    }

    // ========== DOM ==========

    _buildDOM() {
        // Plate picker overlay
        this._pickerEl = document.createElement('div');
        this._pickerEl.className = 'approach-picker';
        this._pickerEl.style.display = 'none';
        this._pickerEl.innerHTML = `
            <div class="approach-picker-header">
                <span>APPROACH CHARTS</span>
                <button class="btn-close approach-close-btn" data-action="close-picker">✕</button>
            </div>
            <div class="approach-picker-list"></div>
        `;
        wireTap(this._pickerEl.querySelector('[data-action="close-picker"]'), () => this.hide());

        // Plate viewer overlay
        this._viewerEl = document.createElement('div');
        this._viewerEl.className = 'approach-viewer';
        this._viewerEl.style.display = 'none';
        this._viewerEl.innerHTML = `
            <div class="approach-viewer-header">
                <button class="approach-nav-btn" data-action="prev">◀</button>
                <span class="approach-viewer-title"></span>
                <button class="approach-nav-btn" data-action="next">▶</button>
                <button class="approach-map-btn" data-action="show-on-map" title="Show on map">MAP</button>
                <button class="approach-load-btn" data-action="load-proc" title="Load procedure waypoints">LOAD</button>
                <button class="btn-close approach-close-btn" data-action="close-viewer">✕</button>
                <button class="approach-fullscreen-btn" data-action="fullscreen">⛶</button>
            </div>
            <div class="approach-viewer-body">
                <div class="plate-pan-container">
                    <img class="approach-plate-img" />
                    <canvas class="approach-ownship-canvas"></canvas>
                </div>
            </div>
        `;

        this._imgEl = this._viewerEl.querySelector('.approach-plate-img');
        this._canvasEl = this._viewerEl.querySelector('.approach-ownship-canvas');
        this._panContainer = this._viewerEl.querySelector('.plate-pan-container');
        this._mapBtn = this._viewerEl.querySelector('[data-action="show-on-map"]');

        // Viewer button handlers — use wireTap() for iPad reliability
        wireTap(this._viewerEl.querySelector('[data-action="close-viewer"]'), () => {
            this._viewerEl.style.display = 'none';
            this._pickerEl.style.display = 'flex';
        });
        wireTap(this._viewerEl.querySelector('[data-action="prev"]'), () => this._navigate(-1));
        wireTap(this._viewerEl.querySelector('[data-action="next"]'), () => this._navigate(1));
        wireTap(this._viewerEl.querySelector('[data-action="fullscreen"]'), () => {
            this._viewerEl.requestFullscreen?.();
        });
        wireTap(this._mapBtn, () => this.showOnMap());
        wireTap(this._viewerEl.querySelector('[data-action="load-proc"]'), () => {
            if (this._currentPlate) this._loadCurrentPlateProc(this._currentPlate);
        });

        // Touch swipe for plate navigation (only when not zoomed in)
        let touchStartX = 0;
        this._viewerEl.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
        }, { passive: true });
        this._viewerEl.addEventListener('touchend', (e) => {
            if (this._viewerEl.style.display === 'none') return; // close button was tapped
            if (this._pz.scale > 1.05) return; // don't navigate while zoomed
            if (this._procPickerEl?.parentNode) return; // don't swipe while picking procedure
            const dx = e.changedTouches[0].clientX - touchStartX;
            if (Math.abs(dx) > 50) {
                this._navigate(dx < 0 ? 1 : -1);
            }
        });

        // Pinch-to-zoom + pan
        this._setupPanZoom();

        this._container.appendChild(this._pickerEl);
        this._container.appendChild(this._viewerEl);
    }

    _setupPanZoom() {
        const body = this._viewerEl.querySelector('.approach-viewer-body');
        const container = this._panContainer;
        const pz = this._pz;

        let lastDist = 0;
        let pinching = false;
        let panStartX = 0, panStartY = 0, panBaseTx = 0, panBaseTy = 0;
        let lastTap = 0;

        const apply = () => {
            container.style.transform = `translate(${pz.tx}px, ${pz.ty}px) scale(${pz.scale})`;
            this._renderOwnship();
        };

        body.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                pinching = true;
                lastDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            } else if (e.touches.length === 1) {
                pinching = false;
                panStartX = e.touches[0].clientX;
                panStartY = e.touches[0].clientY;
                panBaseTx = pz.tx;
                panBaseTy = pz.ty;
            }
        }, { passive: true });

        body.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

                const newScale = Math.max(0.8, Math.min(8, pz.scale * (dist / lastDist)));
                const factor = newScale / pz.scale;

                // Scale around pinch midpoint — focal point stays fixed
                const rect = container.getBoundingClientRect();
                pz.tx += (midX - rect.left) * (1 - factor);
                pz.ty += (midY - rect.top) * (1 - factor);
                pz.scale = newScale;
                lastDist = dist;
                apply();
            } else if (e.touches.length === 1 && !pinching && pz.scale > 1.05) {
                pz.tx = panBaseTx + (e.touches[0].clientX - panStartX);
                pz.ty = panBaseTy + (e.touches[0].clientY - panStartY);
                apply();
            }
        }, { passive: true });

        body.addEventListener('touchend', (e) => {
            if (e.touches.length === 0) {
                pinching = false;
                // Snap back if over-pinched
                if (pz.scale < 1) {
                    pz.scale = 1; pz.tx = 0; pz.ty = 0;
                    apply();
                }
                // Double-tap to reset zoom
                const now = Date.now();
                if (now - lastTap < 350) {
                    pz.scale = 1; pz.tx = 0; pz.ty = 0;
                    apply();
                }
                lastTap = now;
            }
        });
    }

    _resetPanZoom() {
        this._pz.scale = 1;
        this._pz.tx = 0;
        this._pz.ty = 0;
        if (this._panContainer) {
            this._panContainer.style.transform = '';
        }
    }

    _buildPicker(focusIcao) {
        const listEl = this._pickerEl.querySelector('.approach-picker-list');
        this._plates = [];

        const seen = new Set();
        const airports = [];
        if (focusIcao && this._plateIndex?.[focusIcao]) {
            airports.push(focusIcao);
            seen.add(focusIcao);
        }
        for (const icao of this._routeAirports) {
            if (!seen.has(icao) && this._plateIndex?.[icao]) {
                airports.push(icao);
                seen.add(icao);
            }
        }

        if (airports.length === 0) {
            listEl.innerHTML = '<div class="approach-empty">No plates available for route airports</div>';
            return;
        }

        let html = '';
        for (const icao of airports) {
            const entry = this._plateIndex[icao];
            const plates = entry?.plates || (Array.isArray(entry) ? entry : []);
            if (plates.length === 0) continue;

            const sorted = [...plates].sort((a, b) => {
                const order = { IAP: 1, SID: 2, STAR: 3, DP: 4, ODP: 5, MIN: 6 };
                const ka = a.type || a.chart_code || '';
                const kb = b.type || b.chart_code || '';
                const typeOrder = (order[ka] || 8) - (order[kb] || 8);
                if (typeOrder !== 0) return typeOrder;
                // Within same type: MAP (georef) plates first
                const aGeo = !!this._findGeoref({ ...a, icao });
                const bGeo = !!this._findGeoref({ ...b, icao });
                return (aGeo ? 0 : 1) - (bGeo ? 0 : 1);
            });

            const aptName = entry?.name || '';
            html += `<div class="approach-airport-group">
                <div class="approach-airport-header"><span class="approach-chevron">\u25bc</span> ${icao} ${aptName}</div>`;

            for (const plate of sorted) {
                const idx = this._plates.length;
                this._plates.push({ ...plate, icao });
                const hasGeo = !!this._findGeoref({ ...plate, icao });
                const geoIcon = hasGeo ? ' <span class="approach-geo-badge">MAP</span>' : '';
                html += `<button class="approach-plate-item" data-idx="${idx}">${plate.name || plate.chart_name || plate.filename || '?'}${geoIcon}</button>`;
            }

            html += '</div>';
        }

        listEl.innerHTML = html;

        // Collapsible airport group headers — same iPad touch pattern
        listEl.querySelectorAll('.approach-airport-header').forEach(hdr => {
            let t0 = 0, x0 = 0, y0 = 0;
            hdr.addEventListener('touchstart', (e) => {
                t0 = Date.now();
                x0 = e.touches[0].clientX;
                y0 = e.touches[0].clientY;
            }, { passive: true });
            hdr.addEventListener('touchend', (e) => {
                const dx = Math.abs(e.changedTouches[0].clientX - x0);
                const dy = Math.abs(e.changedTouches[0].clientY - y0);
                if (dx < 20 && dy < 20 && (Date.now() - t0) < 500) {
                    e.preventDefault();
                    const group = hdr.closest('.approach-airport-group');
                    const collapsed = group.classList.toggle('collapsed');
                    hdr.querySelector('.approach-chevron').textContent = collapsed ? '\u25b6' : '\u25bc';
                }
            });
            hdr.addEventListener('click', () => {
                const group = hdr.closest('.approach-airport-group');
                const collapsed = group.classList.toggle('collapsed');
                hdr.querySelector('.approach-chevron').textContent = collapsed ? '\u25b6' : '\u25bc';
            });
        });

        // Direct per-button touch handlers — the MEMORY pattern for iPad Safari.
        // Delegation and click events are unreliable in scrollable containers on iOS.
        // Each button gets its own touchstart/touchend with x+y movement + time guard.
        listEl.querySelectorAll('.approach-plate-item').forEach(btn => {
            let t0 = 0, x0 = 0, y0 = 0;
            btn.addEventListener('touchstart', (e) => {
                t0 = Date.now();
                x0 = e.touches[0].clientX;
                y0 = e.touches[0].clientY;
            }, { passive: true });
            btn.addEventListener('touchend', (e) => {
                const dx = Math.abs(e.changedTouches[0].clientX - x0);
                const dy = Math.abs(e.changedTouches[0].clientY - y0);
                if (dx < 20 && dy < 20 && (Date.now() - t0) < 500) {
                    e.preventDefault();
                    this._showPlate(parseInt(btn.dataset.idx));
                }
            });
            // Fallback for non-touch (desktop) — guard against synthetic click ghost-tap
            btn.addEventListener('click', () => {
                if (Date.now() - this._pickerShownAt < 600) return;
                this._showPlate(parseInt(btn.dataset.idx));
            });
        });
    }

    _showPlate(idx) {
        if (idx < 0 || idx >= this._plates.length) return;

        this._resetPanZoom();
        this._plateIdx = idx;
        this._currentPlate = this._plates[idx];
        const plate = this._currentPlate;
        const file = plate.filename || plate.pdf_name;

        const body = this._viewerEl.querySelector('.approach-viewer-body');
        const prev = this._panContainer.querySelector('.approach-plate-pdf');
        if (prev) prev.remove();
        this._imgEl.style.display = 'none';

        // Check for WebP raster (georef plates) — enables pinch zoom
        const georef = this._findGeoref(plate);

        // All plates served from local NanoHTTPD at Documents/FlyTab/plates/
        const plateUrl = (f) => `${PLATES_BASE}/${plate.icao}/${encodeURIComponent(f)}`;

        if (georef?.webp) {
            // Use WebP raster — pinch zoom works via _setupPinchZoom
            // webp path in geoIndex is relative to plates dir (e.g. "KLKR/05853R6.webp")
            const webpUrl = `${PLATES_BASE}/${georef.webp.split('/').map(encodeURIComponent).join('/')}`;
            this._imgEl.style.display = '';
            this._imgEl.src = webpUrl;
            this._imgEl.style.transform = '';
            // If the webp file doesn't exist on device, fall back to PDF rendering
            this._imgEl.onerror = () => {
                this._imgEl.onerror = null;
                this._imgEl.style.display = 'none';
                if (file && file.toLowerCase().endsWith('.pdf')) {
                    this._renderPdf(plateUrl(file), body);
                }
            };
        } else if (file && file.toLowerCase().endsWith('.pdf')) {
            // Render PDF with PDF.js (works on iOS Safari; iframes don't)
            this._renderPdf(plateUrl(file), body);
        } else {
            this._imgEl.style.display = '';
            this._imgEl.src = plateUrl(file);
            this._imgEl.style.transform = '';
        }

        // MAP button: show only when georef + map available
        this._mapBtn.style.display = (georef && this._leafletMap) ? '' : 'none';

        // Update title
        const titleEl = this._viewerEl.querySelector('.approach-viewer-title');
        titleEl.textContent = `${plate.icao} — ${plate.name || plate.chart_name || file}  (${idx + 1}/${this._plates.length})`;

        this._pickerEl.style.display = 'none';
        this._viewerEl.style.display = 'flex';

        this._renderOwnship();
    }

    async _renderPdf(url, body) {
        // Remove any previous PDF canvas
        const prev = this._panContainer.querySelector('.approach-plate-pdf');
        if (prev) prev.remove();

        const pdfjs = window.pdfjsLib;
        if (!pdfjs) {
            const msg = document.createElement('div');
            msg.className = 'approach-plate-pdf';
            msg.style.cssText = 'color:var(--text-muted);padding:24px;text-align:center;';
            this._panContainer.appendChild(msg);
            msg.textContent = 'PDF renderer unavailable';
            return;
        }

        // Append inside _panContainer so the existing pan/zoom transform applies
        const container = document.createElement('div');
        container.className = 'approach-plate-pdf';
        this._panContainer.appendChild(container);

        try {
            const pdf = await pdfjs.getDocument(url).promise;
            for (let p = 1; p <= pdf.numPages; p++) {
                const page = await pdf.getPage(p);
                const scale = (window.devicePixelRatio || 2);
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement('canvas');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                container.appendChild(canvas);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            }
        } catch (err) {
            container.innerHTML = `<div style="color:var(--status-warning);padding:24px">Failed to load plate: ${err.message}</div>`;
        }
    }

    _navigate(direction) {
        const newIdx = this._plateIdx + direction;
        if (newIdx >= 0 && newIdx < this._plates.length) {
            this._showPlate(newIdx);
        }
    }

    _geoKey(plate) {
        // Try PDF filename stem first — webp files on Pi are named by stem
        // (e.g. KLKR/05853R6.webp), not by chart name.
        const file = plate.filename || plate.pdf_name || '';
        if (file) {
            const stem = file.replace(/\.pdf$/i, '');
            const stemKey = `${plate.icao}/${stem}`;
            if (this._geoIndex?.[stemKey]) return stemKey;
        }
        // Fall back to chart name (e.g. "KLKR/RNAV_(GPS)_RWY_06")
        const name = plate.name || plate.chart_name || '';
        if (name) {
            const nameKey = `${plate.icao}/${name.replace(/\s+/g, '_')}`;
            if (this._geoIndex?.[nameKey]) return nameKey;
        }
        // Last resort: filename stem even if not in georef index
        const stem = file.replace(/\.pdf$/i, '');
        return `${plate.icao}/${stem}`;
    }

    /**
     * Find the best georef entry for a plate — prefers entries whose webp file
     * actually exists on device. The pipeline sometimes creates two geoIndex entries
     * for the same plate (raw FAA code "05853R6" and readable name "RNAV_(GPS)_RWY_06")
     * but only writes one webp file (the raw-code one). This method finds the
     * raw-code sibling so WebP overlay works.
     */
    _findGeoref(plate) {
        if (!this._geoIndex) return null;
        const preferredKey = this._geoKey(plate);
        const georef = this._geoIndex[preferredKey];
        if (!georef) return null;

        // If this entry's webp uses a readable name (not a raw FAA code), the webp
        // file may not exist. Look for a sibling entry with the same bounds whose
        // webp name starts with digits (raw FAA code — those always have real files).
        const webpFile = georef.webp ? georef.webp.split('/').pop().replace(/\.webp$/i, '') : '';
        if (webpFile && /^\d/.test(webpFile)) return georef; // already a raw-code webp — good

        // webp is readable-name or missing. Scan for raw-code sibling with same bounds.
        const prefix = plate.icao + '/';
        for (const [key, entry] of Object.entries(this._geoIndex)) {
            if (!key.startsWith(prefix)) continue;
            const stem = key.slice(prefix.length);
            if (!/^\d/.test(stem)) continue; // only raw-code keys
            if (!entry.webp || !entry.bounds) continue;
            if (this._boundsApproxMatch(georef.bounds, entry.bounds)) {
                return entry; // raw-code entry with same bounds — its webp exists
            }
        }
        return georef; // fall back to original (onerror in _showPlate handles missing webp)
    }

    _boundsApproxMatch(b1, b2, tol = 0.02) {
        if (!b1 || !b2 || b1.length < 2 || b2.length < 2) return false;
        return Math.abs(b1[0][0] - b2[0][0]) < tol
            && Math.abs(b1[0][1] - b2[0][1]) < tol
            && Math.abs(b1[1][0] - b2[1][0]) < tol
            && Math.abs(b1[1][1] - b2[1][1]) < tol;
    }

    // ========== Map Overlay Bar ==========

    _showOverlayBar(plate, georef) {
        if (this._overlayBar) this._overlayBar.remove();

        const bar = document.createElement('div');
        bar.className = 'plate-overlay-bar';
        bar.innerHTML = `
            <span class="plate-overlay-name">${plate.icao} — ${plate.name || ''}</span>
            <input type="range" class="plate-opacity-slider" min="20" max="100" value="75" step="5">
            <button class="btn-close plate-overlay-close">✕</button>
        `;

        bar.querySelector('.plate-opacity-slider').addEventListener('input', (e) => {
            if (this._mapOverlay) {
                this._mapOverlay.setOpacity(parseInt(e.target.value) / 100);
            }
        });

        const closeBtn = bar.querySelector('.plate-overlay-close');
        let closeTouchFired = false;
        closeBtn.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            closeTouchFired = true;
            this.removeMapOverlay();
            setTimeout(() => { closeTouchFired = false; }, 400);
        });
        closeBtn.addEventListener('click', () => {
            if (!closeTouchFired) this.removeMapOverlay();
        });

        // Insert into the map container so it floats over the map
        const mapContainer = this._leafletMap.getContainer();
        mapContainer.appendChild(bar);
        this._overlayBar = bar;
    }

    // ========== Ownship Rendering (standalone viewer) ==========

    _renderOwnship() {
        if (!CockpitConfig.get('approachCharts.georefEnabled')) return;
        if (!this._currentPlate || !this._ownshipPos || !this._geoIndex) {
            this._canvasEl.style.display = 'none';
            return;
        }

        const geoKey = this._geoKey(this._currentPlate);
        const georef = this._geoIndex[geoKey];
        if (!georef || !georef.corners) {
            this._canvasEl.style.display = 'none';
            return;
        }

        if (!this._imgEl.naturalWidth) {
            this._imgEl.onload = () => this._renderOwnship();
            return;
        }

        const corners = georef.corners;
        const imgW = this._imgEl.naturalWidth;
        const imgH = this._imgEl.naturalHeight;
        const lat = this._ownshipPos.lat;
        const lon = this._ownshipPos.lon;

        const latFrac = (lat - corners.bottomLeft[0]) / (corners.topLeft[0] - corners.bottomLeft[0]);
        const lonFrac = (lon - corners.topLeft[1]) / (corners.topRight[1] - corners.topLeft[1]);

        if (latFrac < -0.1 || latFrac > 1.1 || lonFrac < -0.1 || lonFrac > 1.1) {
            this._canvasEl.style.display = 'none';
            return;
        }

        // Use offsetWidth/Height (unscaled display size) so ownship coords are
        // in the same space as the canvas, regardless of current zoom level.
        // The pan-container transform moves both image and canvas together.
        const dispW = this._imgEl.offsetWidth;
        const dispH = this._imgEl.offsetHeight;
        if (!dispW || !dispH) return;

        this._canvasEl.width = dispW;
        this._canvasEl.height = dispH;
        this._canvasEl.style.display = 'block';

        const drawX = lonFrac * dispW;
        const drawY = (1 - latFrac) * dispH;

        const ctx = this._canvasEl.getContext('2d');
        ctx.clearRect(0, 0, this._canvasEl.width, this._canvasEl.height);

        const size = CockpitConfig.get('approachCharts.ownshipIconSize') || 24;
        ctx.save();
        ctx.translate(drawX, drawY);
        ctx.rotate((this._ownshipHeading || 0) * Math.PI / 180);

        ctx.beginPath();
        ctx.moveTo(0, -size / 2);
        ctx.lineTo(size / 3, size / 2);
        ctx.lineTo(0, size / 3);
        ctx.lineTo(-size / 3, size / 2);
        ctx.closePath();

        ctx.fillStyle = '#00d4ff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    // ========== CIFP Procedure Loading ==========

    async _loadCurrentPlateProc(plate) {
        const icao = plate.icao;
        try {
            // Ensure CIFP bundle is loaded before checking
            if (!this._cifpBundle) {
                this._showToast('Loading CIFP data…');
                try {
                    const resp = await _fetchWithTimeout(CIFP_BUNDLE_URL, {}, 30000);
                    if (resp.ok) {
                        this._cifpBundle = await resp.json();
                        if (this._nasrDb) this._nasrDb.putAppCache('cifp_bundle', this._cifpBundle).catch(() => {});
                    }
                } catch { /* will fall through to error below */ }
            }
            const airportCifp = this._cifpBundle?.[icao];
            if (!airportCifp) {
                this._showToast('No procedures for ' + icao);
                return;
            }
            const rawProcs = airportCifp.procedures || [];
            // Bundle uses {name, transitions}; normalize to {proc_name, proc_type, transitions}
            const procs = rawProcs.map(p => ({
                proc_name: p.name || p.proc_name,
                proc_type: p.proc_type || 'APPROACH',
                transitions: p.transitions || [],
            }));
            if (procs.length === 0) {
                this._showToast('No procedures for ' + icao);
                return;
            }

            // Try to match the current plate to a specific procedure.
            // pdf_name like "05853R6.PDF" → proc_name "R06" or "R6"
            // chart_name like "RNAV (GPS) RWY 06" → extract "R06"
            const pdfName = (plate.pdf_name || plate.filename || '').replace(/\.\w+$/, '').toUpperCase();
            const chartName = (plate.name || plate.chart_name || '').toUpperCase();

            let matched = null;
            for (const p of procs) {
                const pn = p.proc_name.toUpperCase();
                // Direct match: pdf stem ends with proc name (e.g. "05853R6" contains "R6")
                if (pdfName.endsWith(pn)) { matched = p; break; }
                // Runway match: chart "RNAV (GPS) RWY 06" → "R06", proc "R06"
                const rwyMatch = chartName.match(/RWY\s*(\d+[LRCG]?)/);
                if (rwyMatch) {
                    const rwy = 'R' + rwyMatch[1];
                    if (pn === rwy) { matched = p; break; }
                }
                // ILS match: "ILS OR LOC RWY 06" → "I06" or "IL6"
                if (/^I/.test(pn) && rwyMatch) {
                    const rwyNum = rwyMatch[1];
                    if (pn.endsWith(rwyNum)) { matched = p; break; }
                }
            }

            if (matched && matched.transitions.length > 1) {
                // Jump straight to IAF/transition picker
                this._renderIafPicker(icao, matched);
            } else if (matched) {
                // Single or no transition — load directly
                this._loadProcedure(icao, matched.proc_name, matched.transitions[0] || '');
            } else {
                // Couldn't match plate to procedure — show full picker
                this._renderProcPicker(icao, procs);
            }
        } catch (err) {
            this._showToast('Failed to load procedures');
        }
    }

    async _showProcedurePicker(icao) {
        try {
            const airportCifp = this._cifpBundle?.[icao];
            if (!airportCifp) {
                this._showToast('No procedures — CIFP data not loaded');
                return;
            }
            const rawProcs = airportCifp.procedures || [];
            const procs = rawProcs.map(p => ({
                proc_name: p.name || p.proc_name,
                proc_type: p.proc_type || 'APPROACH',
                transitions: p.transitions || [],
            }));
            if (procs.length === 0) {
                this._showToast('No procedures for ' + icao);
                return;
            }
            this._renderProcPicker(icao, procs);
        } catch (err) {
            this._showToast('Failed to load procedures');
        }
    }

    _renderProcPicker(icao, procs) {
        // Remove existing picker
        if (this._procPickerEl) this._procPickerEl.remove();

        const el = document.createElement('div');
        el.className = 'cifp-proc-picker';

        // Group by type
        const groups = { APPROACH: [], SID: [], STAR: [] };
        for (const p of procs) {
            const g = groups[p.proc_type] || [];
            g.push(p);
            groups[p.proc_type] = g;
        }

        let html = `<div class="cifp-proc-header">
            <span>${icao} PROCEDURES</span>
            <button class="btn-close cifp-proc-close">✕</button>
        </div><div class="cifp-proc-list">`;

        for (const [type, list] of Object.entries(groups)) {
            if (list.length === 0) continue;
            html += `<div class="cifp-proc-group-label">${type}</div>`;
            for (const p of list) {
                const transText = p.transitions.length > 0
                    ? ` (${p.transitions.join(', ')})`
                    : '';
                html += `<div class="cifp-proc-item" data-proc="${p.proc_name}" data-type="${p.proc_type}">${p.proc_name}${transText}</div>`;
            }
        }
        html += '</div>';
        el.innerHTML = html;

        wireTap(el.querySelector('.cifp-proc-close'), () => el.remove());

        el.querySelectorAll('.cifp-proc-item').forEach(item => {
            wireTap(item, () => {
                const procName = item.dataset.proc;
                const proc = procs.find(p => p.proc_name === procName);
                if (proc && proc.transitions.length > 1) {
                    this._renderTransitionPicker(icao, proc, el);
                } else {
                    const transition = proc?.transitions[0] || '';
                    this._loadProcedure(icao, procName, transition);
                    el.remove();
                }
            });
        });

        this._procPickerEl = el;
        this._container.appendChild(el);
    }

    _renderIafPicker(icao, proc) {
        if (this._procPickerEl) this._procPickerEl.remove();
        const el = document.createElement('div');
        el.className = 'cifp-proc-picker';
        let html = `<div class="cifp-proc-header">
            <span>${proc.proc_name} — SELECT IAF</span>
            <button class="btn-close cifp-proc-close">\u2715</button>
        </div><div class="cifp-proc-list">`;
        for (const t of proc.transitions) {
            html += `<div class="cifp-proc-item" data-trans="${t}">${t}</div>`;
        }
        html += '</div>';
        el.innerHTML = html;
        wireTap(el.querySelector('.cifp-proc-close'), () => el.remove());
        el.querySelectorAll('.cifp-proc-item').forEach(item => {
            wireTap(item, () => {
                this._loadProcedure(icao, proc.proc_name, item.dataset.trans);
                el.remove();
            });
        });
        this._procPickerEl = el;
        this._container.appendChild(el);
    }

    _renderTransitionPicker(icao, proc, parentEl) {
        const listEl = parentEl.querySelector('.cifp-proc-list');
        listEl.innerHTML = `<div class="cifp-proc-group-label">${proc.proc_name} — SELECT TRANSITION</div>`;

        for (const t of proc.transitions) {
            const item = document.createElement('div');
            item.className = 'cifp-proc-item';
            item.textContent = t;
            wireTap(item, () => {
                this._loadProcedure(icao, proc.proc_name, t);
                parentEl.remove();
            });
            listEl.appendChild(item);
        }
    }

    async _loadProcedure(icao, procName, transition) {
        try {
            const airportCifp = this._cifpBundle?.[icao];
            const rawSteps = airportCifp?.details?.[procName];
            if (!rawSteps || rawSteps.length === 0) {
                this._showToast('No procedure detail for ' + procName);
                return;
            }

            // Build ordered sequence: transition steps first, then common segment
            const transSteps = rawSteps.filter(s => s.transition === transition);
            const commonSteps = rawSteps.filter(s => s.transition === '');
            const ordered = [...transSteps, ...commonSteps];

            // Deduplicate by fix_id (no lat/lon check — coordinates resolved from NASR below)
            const seen = new Set();
            const uniqueSteps = ordered.filter(s => {
                const id = (s.fix_id || '').trim();
                if (!id) return false;
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            });

            if (uniqueSteps.length === 0) {
                this._showToast('No waypoints in procedure');
                return;
            }

            // Resolve coordinates from NASR DB for each step.
            // CIFP bundle has null lat/lon — must look up by fix_id.
            const resolveCoords = async (id, section) => {
                if (!this._nasrDb) return null;
                try {
                    // RW## pattern: runway threshold — fix_section is null in bundle, detect by id
                    if (/^RW\d/.test(id) || section === 'PG') {
                        const r = await this._nasrDb.getAirport(icao);
                        if (r?.lat) return { lat: r.lat, lon: r.lon };
                        return null;
                    }
                    if (section === 'D') {
                        const r = await this._nasrDb.getNavaid(id);
                        if (r?.lat) return { lat: r.lat, lon: r.lon };
                    } else if (section === 'PA') {
                        const r = await this._nasrDb.getAirport(id);
                        if (r?.lat) return { lat: r.lat, lon: r.lon };
                    } else {
                        // PC, EA, unset — fix first, navaid fallback
                        let r = await this._nasrDb.getFix(id);
                        if (r?.lat) return { lat: r.lat, lon: r.lon };
                        r = await this._nasrDb.getNavaid(id);
                        if (r?.lat) return { lat: r.lat, lon: r.lon };
                    }
                } catch {}
                return null;
            };

            const resolved = await Promise.all(uniqueSteps.map(async s => {
                const id = (s.fix_id || '').trim();
                const coords = await resolveCoords(id, s.fix_section || '');
                if (!coords) return null;
                return { ...s, fix_id: id, lat: coords.lat, lon: coords.lon };
            }));
            const steps = resolved.filter(Boolean);

            if (steps.length === 0) {
                this._showToast('No waypoints with coordinates found in NASR');
                return;
            }

            // altitude1 is stored in tens-of-feet in ARINC 424 (e.g. 300 = 3000 ft, 52 = 520 ft)
            const toWp = s => ({
                icao: s.fix_id,
                name: s.fix_id,
                lat: s.lat,
                lon: s.lon,
                alt: s.altitude1 > 0 ? s.altitude1 * 10 : null,
                altLocked: s.altitude1 > 0,
            });

            // RW## = runway threshold fix. All fixes from IAF through RW## go
            // insertBefore the airport; everything after (MAP, missed approach) goes insertAfter.
            const rwIdx = steps.findIndex(s => /^RW\d/.test(s.fix_id));

            let insertBefore, insertAfter;

            if (rwIdx < 0) {
                insertBefore = steps.map(toWp);
                insertAfter = [];
            } else {
                insertBefore = steps.slice(0, rwIdx + 1).map(toWp);
                insertAfter  = steps.slice(rwIdx + 1).map(toWp);
            }

            // Airport waypoint for empty-route case.
            // Lock altitude to field elevation so it doesn't inherit cruise altitude.
            const rwStep = rwIdx >= 0 ? steps[rwIdx] : steps[steps.length - 1];
            let aptElev = null;
            if (this._nasrDb) {
                try {
                    const aptData = await this._nasrDb.getAirport(icao);
                    aptElev = aptData?.elev_ft ?? null;
                } catch {}
            }
            const airportWp = rwStep
                ? { icao, name: icao, lat: rwStep.lat, lon: rwStep.lon, type: 'APT',
                    elev_ft: aptElev, alt: aptElev ?? 0, altLocked: true }
                : null;

            document.dispatchEvent(new CustomEvent('cifp:load-procedure', {
                detail: { icao, procName, transition, insertBefore, insertAfter, airportWp },
            }));

            const labels = [...insertBefore.map(w => w.icao), icao, ...insertAfter.map(w => w.icao)];
            this._showToast(`Approach: ${labels.join(' → ')}`);
        } catch (err) {
            this._showToast('Failed to load procedure');
        }
    }

    _showToast(msg) {
        if (typeof app !== 'undefined' && app.showToast) {
            const toast = app.showToast(msg);
            setTimeout(() => toast?.remove(), 3000);
        }
    }

    _showMessage(msg) {
        this._pickerEl.querySelector('.approach-picker-list').innerHTML =
            `<div class="approach-empty">${msg}</div>`;
        this._pickerEl.style.display = 'flex';
    }
}
