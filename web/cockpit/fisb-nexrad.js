/**
 * FlyPi — FIS-B NEXRAD Renderer
 * Renders NEXRAD radar blocks from FIS-B (/jsonio) on a Leaflet canvas overlay.
 * Each block has geographic coordinates and 0-15 intensity values from Stratux.
 */

class FisbNexrad {
    constructor(fisbClient) {
        this._fisb = fisbClient;
        this._map = null;
        this._canvas = null;
        this._ctx = null;
        this._active = false;

        // NEXRAD block store: "latN,lonW" → { latN, lonW, height, width, intensity[], radarType, scale, received_at }
        this._blocks = new Map();

        // Per-product freshness: tracks the most recent received_at for each product type
        this._newestAt = { regional: 0, conus: 0 };

        // Frame history for radar loop playback (ring buffer of snapshots)
        this._frameHistory = [];
        const intervalMin = CockpitConfig.get('radar.frameIntervalMinutes') || 10;
        const durationHr  = CockpitConfig.get('radar.loopDurationHours') || 2;
        this._cacheHours  = CockpitConfig.get('radar.cacheHours') || 3;
        this._snapIntervalMs = intervalMin * 60000;
        this._maxFrames = Math.max(2, Math.ceil(durationHr * 60 / intervalMin));

        // Config
        this._opacity = CockpitConfig.get('radar.opacity') || 0.5;

        this.sourceType = 'fisb';

        // Loop mode: when true, suppress live _draw() so RadarLoop playback isn't overwritten
        this._loopMode = false;
        this._latestDataTime = 0;

        // Whether we've already notified the map to switch from internet to FIS-B this session.
        // Reset on addTo() so the notification fires again after radar is re-enabled.
        this._notifiedMap = false;

        // Tracks whether we've fired the "loop ready" notification for this session.
        // Reset when radar is toggled so the switch fires again after re-enable.
        this._loopReadyFired = false;

        // Bind
        this._onNexrad = (e) => this._handleNexrad(e.detail);
        this._onMove = () => { if (!this._loopMode) this._draw(); };
        this._onResize = () => this._resizeCanvas();

        // Purge timer — start immediately so blocks accumulate before overlay is shown
        this._purgeTimer = setInterval(() => this._purgeOld(), 30000);

        // Start listening for NEXRAD frames immediately (before addTo) so that
        // blocks and frame history accumulate even before the overlay is drawn.
        this._fisb.addEventListener('fisb:nexrad', this._onNexrad);

        // CB building detection
        this._cbActive = false;
        this._cbOverlays = [];       // L.polygon[] on the map
        this._cbLabelMarkers = [];   // L.marker[] for CB↑ labels
        this._cbInetLayer = null;    // L.tileLayer ref (internet radar) for ground-mode sampling
        this._cbInetTimer = null;    // interval for periodic internet re-sampling
    }

    // Standard NEXRAD intensity → color map (0-7+)
    static COLORS = [
        null,                         // 0: no echo
        'rgba(0, 236, 0, 0.6)',       // 1: light
        'rgba(1, 144, 0, 0.6)',       // 2: light-moderate
        'rgba(255, 255, 0, 0.7)',     // 3: moderate
        'rgba(231, 192, 0, 0.7)',     // 4: moderate-heavy
        'rgba(255, 0, 0, 0.8)',       // 5: heavy
        'rgba(255, 0, 255, 0.8)',     // 6: very heavy
        'rgba(255, 255, 255, 0.9)',   // 7+: extreme
    ];

    /** Classify a stored block by FIS-B product. */
    static _productOf(block) {
        return (block.radarType === 64 || block.scale > 0) ? 'conus' : 'regional';
    }

    // ========== Public API ==========

    /** Add the NEXRAD overlay to a Leaflet map */
    addTo(map) {
        if (this._active) return; // already attached
        this._map = map;
        this._active = true;
        this._notifiedMap   = false; // reset so notification fires for this radar session
        this._loopReadyFired = false; // reset so loop-ready switch fires again

        // Re-register listener — remove first to prevent double-registration on re-enable
        this._fisb.removeEventListener('fisb:nexrad', this._onNexrad);
        this._fisb.addEventListener('fisb:nexrad', this._onNexrad);

        // Restart purge timer for this session
        if (this._purgeTimer) clearInterval(this._purgeTimer);
        this._purgeTimer = setInterval(() => this._purgeOld(), 30000);

        // Create canvas in Leaflet's overlay pane so it pans/zooms with the map
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        this._canvas.className = 'fisb-nexrad-canvas';
        map.getPanes().overlayPane.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');
        this._mainTarget = { map, canvas: this._canvas, ctx: this._ctx };

        // Size canvas
        this._resizeCanvas();
        map.on('resize', this._onResize);

        // Redraw on any map movement (including during panning)
        map.on('move zoom moveend zoomend', this._onMove);
    }

    /** Remove overlay from map */
    remove() {
        if (!this._active) return; // already detached
        this._active         = false;
        this._notifiedMap    = false;
        this._loopReadyFired = false;
        if (this._purgeTimer) { clearInterval(this._purgeTimer); this._purgeTimer = null; }
        this._fisb.removeEventListener('fisb:nexrad', this._onNexrad);
        if (this._canvas && this._canvas.parentNode) {
            this._canvas.parentNode.removeChild(this._canvas);
        }
        if (this._map) {
            this._map.off('move zoom moveend zoomend', this._onMove);
            this._map.off('resize', this._onResize);
        }
        this._blocks.clear();
        this._frameHistory = [];
        this._canvas = null;
        this._ctx = null;
        this._mainTarget = null;   // drop stale canvas/ctx ref so _draw()'s guard fires after teardown
        this._clearCbOverlays();
        this._stopInetSampling();
        this._map = null;
    }

    /** Toggle visibility */
    toggle(map) {
        if (this._active) {
            this.remove();
            return false;
        } else {
            this.addTo(map);
            return true;
        }
    }

    /** Whether the canvas overlay is currently attached to a map */
    get isActive() { return this._active; }

    /** Check if NEXRAD data is available */
    get hasData() { return this._blocks.size > 0; }

    /** Get frame history for radar loop playback */
    get frameHistory() { return this._frameHistory; }

    /** Get current block count */
    get blockCount() { return this._blocks.size; }

    getDataAgeMs(product) {
        if (product) {
            const t = this._newestAt[product];
            return t ? Date.now() - t : null;
        }
        return this._latestDataTime ? Date.now() - this._latestDataTime : null;
    }

    /** Draw the live (current) radar view — for use by RadarLoop when exiting loop mode */
    drawLive() { this._draw(); }

    // ========== NEXRAD Block Handling ==========

    _handleNexrad(msg) {
        if (!msg.NEXRAD?.length) return;

        const now = Date.now();
        const dataTime = msg.LocaltimeReceived
            ? new Date(msg.LocaltimeReceived).getTime() || now
            : now;
        this._latestDataTime = dataTime;
        const blocks = msg.NEXRAD;

        for (const block of blocks) {
            if (!block.Intensity || block.Intensity.length === 0) continue;

            const key = `${block.LatNorth},${block.LonWest}`;
            const stored = {
                latN: block.LatNorth,
                lonW: block.LonWest,
                height: block.Height,
                width: block.Width,
                intensity: block.Intensity,
                radarType: block.Radar_Type,   // 63 Regional | 64 CONUS
                scale: block.Scale,             // 0 | 1 | 2
                received_at: now,
            };
            this._blocks.set(key, stored);
            const p = FisbNexrad._productOf(stored);
            if (now > this._newestAt[p]) this._newestAt[p] = now;
        }

        // Snapshot for radar loop (throttled to every 2.5 minutes)
        const lastSnap = this._frameHistory.length > 0
            ? this._frameHistory[this._frameHistory.length - 1].time : 0;
        if (now - lastSnap >= this._snapIntervalMs) {
            this._takeSnapshot(now, dataTime);
            // Notify map to switch the loop source to FIS-B once we have enough frames to animate.
            // Two frames = minimum for visible animation. Fire once per radar session.
            if (!this._loopReadyFired && this._frameHistory.length >= 2 && this._map) {
                this._loopReadyFired = true;
                window.app?.cockpitMap?.onFisbNexradLoopReady?.();
            }
        }

        // Redraw live view — suppressed in loop mode so historical frames aren't overwritten
        if (this._active && !this._loopMode) this._draw();

        // CB building overlay — once we have a historical snapshot to compare against,
        // switch from internet sampling (if active) to FIS-B mode
        if (this._cbActive && this._frameHistory.length >= 1 && !this._loopMode) {
            this._stopInetSampling();
            this._updateCbFromFisb();
        }

        // Notify map to dim the internet tile once FIS-B has live data
        if (!this._notifiedMap && this._blocks.size > 0 && this._map) {
            this._notifiedMap = true;
            window.app?.cockpitMap?.onFisbNexradData?.();
        }
    }

    /** Take a snapshot of current NEXRAD state for radar loop */
    _takeSnapshot(time, dataTime) {
        const snapshot = new Map();
        for (const [key, block] of this._blocks) {
            snapshot.set(key, { ...block, intensity: block.intensity.slice() });
        }
        this._frameHistory.push({ time, dataTime: dataTime || time, blocks: snapshot });
        while (this._frameHistory.length > this._maxFrames) {
            this._frameHistory.shift();
        }
    }

    _purgeOld() {
        const cutoff = Date.now() - 15 * 60000; // 15 minutes
        for (const [key, block] of this._blocks) {
            if (block.received_at < cutoff) this._blocks.delete(key);
        }
        if (this._active) this._draw();
    }

    // ========== Canvas Rendering ==========

    _resizeCanvas() {
        if (!this._canvas || !this._map) return;
        const size = this._map.getSize();
        // Canvas in overlay pane must match map container size
        this._canvas.width = size.x * 2; // oversized to handle pan offset
        this._canvas.height = size.y * 2;
        if (!this._loopMode) this._draw();
    }

    /** Public: draw current blocks of one product to a target. */
    draw(target, product) {
        this._drawToTarget(target, product, this._blocks);
    }

    /** Draw a block map (live or snapshot) of one product onto a target's canvas. */
    _drawToTarget(target, product, blockMap) {
        const { map, canvas, ctx } = target;
        if (!ctx || !map) return;

        const topLeft = map.containerPointToLayerPoint([0, 0]);
        canvas.style.transform = `translate(${topLeft.x}px, ${topLeft.y}px)`;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (blockMap.size === 0) return;

        ctx.globalAlpha = this._opacity;
        const bounds = map.getBounds();
        const zoom = map.getZoom();

        for (const [, block] of blockMap) {
            if (FisbNexrad._productOf(block) !== product) continue;
            const blockS = block.latN - block.height;
            const blockE = block.lonW + block.width;
            if (block.latN < bounds.getSouth() || blockS > bounds.getNorth()) continue;
            if (blockE < bounds.getWest() || block.lonW > bounds.getEast()) continue;
            this._drawBlock(ctx, map, block, zoom);
        }
        ctx.globalAlpha = 1.0;
    }

    /** Draw the main-map live view — Regional product only. */
    _draw() {
        if (!this._active || !this._mainTarget) return;
        this._drawToTarget(this._mainTarget, 'regional', this._blocks);
    }

    /** Draw a single NEXRAD block */
    _drawBlock(ctx, map, block, zoom) {
        const intensity = block.intensity;
        if (!intensity || intensity.length === 0) return;

        // FIS-B NEXRAD blocks: 128 bins in a 32 (lon) x 4 (lat) grid,
        // ordered west-to-east then north-to-south (per Stratux nexrad.go).
        const totalBins = intensity.length;
        const cols = 32;
        const rows = Math.ceil(totalBins / cols);

        // Compute pixel coordinates once per block (2 projections instead of 2*128)
        const nw = map.latLngToContainerPoint([block.latN, block.lonW]);
        const se = map.latLngToContainerPoint([block.latN - block.height, block.lonW + block.width]);
        const pxPerCol = (se.x - nw.x) / cols;
        const pxPerRow = (se.y - nw.y) / rows;

        if (pxPerCol < 0.3 || pxPerRow < 0.3) return; // too small to render

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                if (idx >= totalBins) break;

                const level = intensity[idx];
                if (level === 0) continue; // no echo

                const color = FisbNexrad.COLORS[Math.min(level, 7)] || FisbNexrad.COLORS[7];
                if (!color) continue;

                const px = nw.x + c * pxPerCol;
                const py = nw.y + r * pxPerRow;

                ctx.fillStyle = color;
                ctx.fillRect(px, py, Math.max(pxPerCol, 1), Math.max(pxPerRow, 1));
            }
        }
    }

    /** Draw a specific historical frame of one product onto a target (radar loop). */
    drawFrame(target, product, frameIndex) {
        if (frameIndex < 0 || frameIndex >= this._frameHistory.length) return;
        const snap = this._frameHistory[frameIndex];
        if (!snap) return;
        this._drawToTarget(target, product, snap.blocks);
    }

    /** Enter loop mode (suppress live draws) */
    enterLoopMode() {
        this._loopMode = true;
        DiagLog.log('radar', `FisbNexrad.enterLoopMode: active=${this._active} hasCtx=${!!this._ctx}`);
        // Clear stale canvas so internet tile frames show through unobstructed
        if (this._ctx) this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    }

    /** Exit loop mode (resume live draws) */
    exitLoopMode() {
        DiagLog.log('radar', `FisbNexrad.exitLoopMode`);
        this._loopMode = false;
    }

    // ========== CB Building Detection ==========

    get cbBuildingActive() { return this._cbActive; }

    /**
     * Enable or disable the CB building overlay.
     * When on=true, uses FIS-B block history if available; falls back to internet tile sampling.
     */
    setCbBuilding(on) {
        if (on === this._cbActive) return;
        this._cbActive = on;
        if (on) {
            if (this._frameHistory.length >= 1 && this._blocks.size > 0) {
                this._updateCbFromFisb();
            } else if (this._cbInetLayer) {
                this._startInetSampling();
            }
        } else {
            this._clearCbOverlays();
            this._stopInetSampling();
        }
    }

    /**
     * Called by map.js when the internet radar tile layer is enabled (layer) or disabled (null).
     * When FIS-B has no data, internet tiles are sampled periodically for CB growth detection.
     */
    setCbInternetLayer(layer) {
        this._cbInetLayer = layer;
        if (!layer) {
            this._stopInetSampling();
        } else if (this._cbActive && this._blocks.size === 0) {
            this._startInetSampling();
        }
    }

    _startInetSampling() {
        if (this._cbInetTimer) return;
        this._sampleInternetTiles();
        this._cbInetTimer = setInterval(() => this._sampleInternetTiles(), 5 * 60 * 1000);
    }

    _stopInetSampling() {
        if (this._cbInetTimer) { clearInterval(this._cbInetTimer); this._cbInetTimer = null; }
    }

    /** Update CB overlays from FIS-B block data (current blocks vs most recent snapshot). */
    _updateCbFromFisb() {
        if (!this._cbActive || !this._map || this._loopMode) return;
        if (this._blocks.size === 0 || this._frameHistory.length < 1) return;

        const prev = this._clusterBlocks(this._frameHistory[this._frameHistory.length - 1].blocks);
        const curr = this._clusterBlocks(this._blocks);
        const lightGrid = this._buildLightGrid(this._blocks);
        this._renderCbOverlays(this._findBuildingCells(prev, curr), lightGrid);
    }

    /** Build a 0.25° grid of all FIS-B bins with level ≥ 1 (light echo and above). */
    _buildLightGrid(blockMap) {
        const GRID = 0.25;
        const gridCells = new Map();
        for (const [, block] of blockMap) {
            const cols = 32;
            const rows = Math.ceil(block.intensity.length / cols);
            const binH = block.height / rows;
            const binW = block.width / cols;
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const idx = r * cols + c;
                    if (idx >= block.intensity.length) break;
                    if (block.intensity[idx] < 1) continue;
                    const lat = block.latN - (r + 0.5) * binH;
                    const lon = block.lonW + (c + 0.5) * binW;
                    const key = `${Math.round(lat / GRID)},${Math.round(lon / GRID)}`;
                    if (!gridCells.has(key)) {
                        gridCells.set(key, {
                            gLat: Math.round(lat / GRID),
                            gLon: Math.round(lon / GRID),
                        });
                    }
                }
            }
        }
        return gridCells;
    }

    /**
     * BFS outward from a building cluster's core cells into adjacent light-echo (≥1) cells.
     * Returns extra corner points (for hull expansion) for all newly reached cells.
     */
    _expandToLightEchoes(cluster, lightGrid) {
        const GRID = 0.25;
        const coreSet = new Set(cluster.cells.map(c => `${c.gLat},${c.gLon}`));
        const expanded = new Set(coreSet);
        const frontier = [...coreSet];
        const extraPoints = [];

        while (frontier.length > 0) {
            const k = frontier.pop();
            const [gLat, gLon] = k.split(',').map(Number);
            for (let dl = -1; dl <= 1; dl++) {
                for (let dm = -1; dm <= 1; dm++) {
                    if (dl === 0 && dm === 0) continue;
                    const nk = `${gLat + dl},${gLon + dm}`;
                    if (!expanded.has(nk) && lightGrid.has(nk)) {
                        expanded.add(nk);
                        frontier.push(nk);
                        const nlat = (gLat + dl) * GRID;
                        const nlon = (gLon + dm) * GRID;
                        extraPoints.push(
                            [nlat + GRID / 2, nlon - GRID / 2],
                            [nlat + GRID / 2, nlon + GRID / 2],
                            [nlat - GRID / 2, nlon - GRID / 2],
                            [nlat - GRID / 2, nlon + GRID / 2],
                        );
                    }
                }
            }
        }
        return extraPoints;
    }

    /**
     * Sample two IEM NEXRAD products (10 min ago vs current) for the visible viewport
     * and compare for growing storm cells.  Both fetches happen in parallel so results
     * appear within a few seconds of enabling the toggle — no accumulation wait needed.
     */
    async _sampleInternetTiles() {
        if (!this._map || !this._cbInetLayer || this._blocks.size > 0) return;

        const zoom = Math.max(6, Math.min(Math.floor(this._map.getZoom()), 7));
        const bounds = this._map.getBounds();
        const x0 = FisbNexrad._lon2tile(bounds.getWest(), zoom);
        const x1 = FisbNexrad._lon2tile(bounds.getEast(), zoom);
        const y0 = FisbNexrad._lat2tile(bounds.getNorth(), zoom);
        const y1 = FisbNexrad._lat2tile(bounds.getSouth(), zoom);

        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 25) return;

        // Fetch 10-min-ago and current in parallel — instant growth comparison
        const [prevGrid, currGrid] = await Promise.all([
            this._sampleProduct('nexrad-n0q-m10m',   x0, x1, y0, y1, zoom),
            this._sampleProduct('nexrad-n0q-900913',  x0, x1, y0, y1, zoom),
        ]);

        if (prevGrid.size === 0 || currGrid.size === 0) return;

        // Split full-echo grids into core (≥3) for growth comparison and light (≥1) for hull expansion
        const prevCore = new Map([...prevGrid].filter(([, v]) => v.maxIntensity >= 3));
        const currCore = new Map([...currGrid].filter(([, v]) => v.maxIntensity >= 3));
        if (prevCore.size === 0 || currCore.size === 0) return;

        const prev = this._bfsClusters(prevCore);
        const curr = this._bfsClusters(currCore);
        this._renderCbOverlays(this._findBuildingCells(prev, curr), currGrid);
    }

    /** Fetch one IEM product for the given tile range and return an intensity grid. */
    async _sampleProduct(product, x0, x1, y0, y1, zoom) {
        const TSIZE = 256, STEP = 4, GRID = 0.25;
        const grid = new Map();

        const fetchTile = async (tx, ty) => {
            const url = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${product}/${zoom}/${tx}/${ty}.png`;
            const resp = await fetch(url, { mode: 'cors' });
            if (!resp.ok) return;
            const bmp = await createImageBitmap(await resp.blob());
            const oc = new OffscreenCanvas(TSIZE, TSIZE);
            const ctx2d = oc.getContext('2d');
            ctx2d.drawImage(bmp, 0, 0);
            const img = ctx2d.getImageData(0, 0, TSIZE, TSIZE);

            for (let py = 0; py < TSIZE; py += STEP) {
                for (let px = 0; px < TSIZE; px += STEP) {
                    const i = (py * TSIZE + px) * 4;
                    const level = FisbNexrad._rgbToNexradIntensity(
                        img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
                    if (level < 1) continue;
                    const lat = FisbNexrad._tile2lat(ty + py / TSIZE, zoom);
                    const lon = FisbNexrad._tile2lon(tx + px / TSIZE, zoom);
                    const gLat = Math.round(lat / GRID);
                    const gLon = Math.round(lon / GRID);
                    const key = `${gLat},${gLon}`;
                    const e = grid.get(key);
                    if (!e) grid.set(key, { gLat, gLon, sumIntensity: level, count: 1, maxIntensity: level });
                    else { e.sumIntensity += level; e.count++; e.maxIntensity = Math.max(e.maxIntensity, level); }
                }
            }
        };

        const tiles = [];
        for (let tx = x0; tx <= x1; tx++) {
            for (let ty = y0; ty <= y1; ty++) {
                tiles.push(fetchTile(tx, ty).catch(() => {}));
            }
        }
        await Promise.all(tiles);
        return grid;
    }

    /**
     * Cluster FIS-B intensity bins (≥ moderate) into connected components.
     * Bins are first snapped to a 0.25° grid then flood-filled (8-connectivity).
     */
    _clusterBlocks(blockMap) {
        const GRID = 0.25, MIN_LEVEL = 3;
        const gridCells = new Map();

        for (const [, block] of blockMap) {
            const cols = 32;
            const rows = Math.ceil(block.intensity.length / cols);
            const binH = block.height / rows;
            const binW = block.width / cols;

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const idx = r * cols + c;
                    if (idx >= block.intensity.length) break;
                    const level = block.intensity[idx];
                    if (level < MIN_LEVEL) continue;

                    const lat = block.latN - (r + 0.5) * binH;
                    const lon = block.lonW + (c + 0.5) * binW;
                    const gLat = Math.round(lat / GRID);
                    const gLon = Math.round(lon / GRID);
                    const key = `${gLat},${gLon}`;
                    const e = gridCells.get(key);
                    if (!e) {
                        gridCells.set(key, {
                            gLat, gLon, sumIntensity: level, count: 1, maxIntensity: level,
                            _corners: [
                                [block.latN - r * binH,       block.lonW + c * binW],
                                [block.latN - r * binH,       block.lonW + (c + 1) * binW],
                                [block.latN - (r + 1) * binH, block.lonW + c * binW],
                                [block.latN - (r + 1) * binH, block.lonW + (c + 1) * binW],
                            ],
                        });
                    } else {
                        e.sumIntensity += level; e.count++; e.maxIntensity = Math.max(e.maxIntensity, level);
                    }
                }
            }
        }

        return this._bfsClusters(gridCells, cell => cell._corners);
    }

    /**
     * BFS connected-component clustering over a 0.25° intensity grid.
     * cornersFn(cell) → [[lat,lon]…] — if omitted, uses the cell's 0.25° tile corners.
     */
    _bfsClusters(gridCells, cornersFn) {
        const GRID = 0.25;
        const visited = new Set();
        const clusters = [];
        const getCorners = cornersFn ?? ((cell) => {
            const lat = cell.gLat * GRID, lon = cell.gLon * GRID;
            return [
                [lat + GRID / 2, lon - GRID / 2], [lat + GRID / 2, lon + GRID / 2],
                [lat - GRID / 2, lon - GRID / 2], [lat - GRID / 2, lon + GRID / 2],
            ];
        });

        for (const key of gridCells.keys()) {
            if (visited.has(key)) continue;
            const cluster = { cells: [], totalIntensity: 0, totalCount: 0, maxIntensity: 0, points: [] };
            const queue = [key];
            visited.add(key);

            while (queue.length > 0) {
                const k = queue.shift();
                const cell = gridCells.get(k);
                if (!cell) continue;
                cluster.cells.push(cell);
                cluster.totalIntensity += cell.sumIntensity;
                cluster.totalCount += cell.count;
                cluster.maxIntensity = Math.max(cluster.maxIntensity, cell.maxIntensity);
                cluster.points.push(...getCorners(cell));

                for (let dl = -1; dl <= 1; dl++) {
                    for (let dm = -1; dm <= 1; dm++) {
                        if (dl === 0 && dm === 0) continue;
                        const nk = `${cell.gLat + dl},${cell.gLon + dm}`;
                        if (!visited.has(nk) && gridCells.has(nk)) {
                            visited.add(nk);
                            queue.push(nk);
                        }
                    }
                }
            }

            if (cluster.cells.length > 0) {
                let sL = 0, sM = 0;
                for (const c of cluster.cells) { sL += c.gLat; sM += c.gLon; }
                const n = cluster.cells.length;
                cluster.centroid = [sL / n * GRID, sM / n * GRID];
                clusters.push(cluster);
            }
        }
        return clusters;
    }

    clusterBlocks() { return this._clusterBlocks(this._blocks); }

    clustersForFrame(frameIndex) {
        if (frameIndex < 0 || frameIndex >= this._frameHistory.length) return [];
        return this._clusterBlocks(this._frameHistory[frameIndex].blocks);
    }

    /**
     * Compare two cluster sets and return cells that are growing.
     * A cell is "building" if: area grew ≥25%, intensity grew ≥25%, gained heavy pixels,
     * or is a new significant cluster not present in the previous frame.
     */
    _findBuildingCells(prevClusters, currClusters) {
        const MATCH_DEG = 1.5; // ~90 nm max centroid drift between frames
        const building = [];

        for (const curr of currClusters) {
            if (curr.cells.length < 2) continue; // ignore single-cell noise

            let bestPrev = null, bestDist = MATCH_DEG;
            for (const prev of prevClusters) {
                const dLat = curr.centroid[0] - prev.centroid[0];
                const dLon = curr.centroid[1] - prev.centroid[1];
                const dist = Math.sqrt(dLat * dLat + dLon * dLon);
                if (dist < bestDist) { bestDist = dist; bestPrev = prev; }
            }

            if (!bestPrev) {
                // New cluster — flag if large enough to be meaningful
                if (curr.cells.length >= 3 && curr.maxIntensity >= 3) {
                    building.push({ ...curr, growthRate: 1.0, gainedHighIntensity: curr.maxIntensity >= 5 });
                }
                continue;
            }

            const areaGrowth = (curr.cells.length - bestPrev.cells.length) / Math.max(bestPrev.cells.length, 1);
            const intGrowth  = (curr.totalIntensity - bestPrev.totalIntensity) / Math.max(bestPrev.totalIntensity, 1);
            const gainedHigh = curr.maxIntensity >= 5 && bestPrev.maxIntensity < 5;
            const growthRate = Math.max(areaGrowth, intGrowth);

            if (growthRate >= 0.25 || gainedHigh) {
                building.push({ ...curr, growthRate, gainedHighIntensity: gainedHigh });
            }
        }
        return building;
    }

    /** Draw dashed polygon outlines and CB↑ labels for all building cells. */
    _renderCbOverlays(building, lightGrid) {
        if (!this._map) return;
        this._clearCbOverlays();

        for (const cell of building) {
            if (cell.points.length < 4) continue;

            // Expand polygon to include surrounding light-echo (≥1) areas — the early green dots
            const lightPoints = lightGrid ? this._expandToLightEchoes(cell, lightGrid) : [];
            const hull = this._convexHull([...cell.points, ...lightPoints]);
            if (hull.length < 3) continue;

            // Cyan outline stands out against red/orange NEXRAD blobs and convective rings.
            // Label retains warm-color severity coding; polygon stroke is purely "find me on the map."
            const isRapid = cell.growthRate >= 0.5 || cell.gainedHighIntensity;
            const labelColor = isRapid ? '#ff4400' : '#ff9900';

            const poly = L.polygon(hull, {
                color: '#00e5ff', weight: 4, fillColor: '#00e5ff', fillOpacity: 0.08,
                dashArray: '8,5', interactive: false,
            }).addTo(this._map);
            this._cbOverlays.push(poly);

            const center = this._centroid(hull);
            const marker = L.marker(center, {
                icon: L.divIcon({
                    className:  'cb-build-label',
                    html:       `<div class="cb-build-text" style="color:${labelColor}">${isRapid ? 'CB↑↑' : 'CB↑'}</div>`,
                    iconSize:   [0, 0],
                    iconAnchor: [0, 8],
                }),
                interactive: false,
            }).addTo(this._map);
            this._cbLabelMarkers.push(marker);

            // Storm motion arrow — 15-min projected position at ~75% of mid-level wind
            const wind = this._fisb?.getNearestWind(center[0], center[1], 18000);
            if (wind && wind.speed > 5) {
                const stormDir = (wind.dir + 180) % 360;
                const distNm = wind.speed * 0.75 * (15 / 60);
                const tip = FisbClient._destPoint(center[0], center[1], stormDir, distNm);
                const arrow = L.polyline([[center[0], center[1]], [tip.lat, tip.lon]], {
                    color: '#00e5ff', weight: 3, opacity: 0.85, interactive: false,
                }).addTo(this._map);
                this._cbOverlays.push(arrow);
            }
        }
    }

    _clearCbOverlays() {
        for (const o of this._cbOverlays)     { if (this._map) this._map.removeLayer(o); }
        for (const m of this._cbLabelMarkers) { if (this._map) this._map.removeLayer(m); }
        this._cbOverlays = [];
        this._cbLabelMarkers = [];
    }

    /** Andrew's monotone chain convex hull. Points are [lat, lon]. */
    _convexHull(rawPoints) {
        if (rawPoints.length < 3) return rawPoints;
        const seen = new Set();
        const pts = rawPoints.filter(p => {
            const k = `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
            return seen.has(k) ? false : (seen.add(k), true);
        });
        if (pts.length < 3) return pts;
        pts.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

        const cross = (O, A, B) =>
            (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);

        const lower = [];
        for (const p of pts) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper = [];
        for (let i = pts.length - 1; i >= 0; i--) {
            const p = pts[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        lower.pop(); upper.pop();
        return lower.concat(upper);
    }

    _centroid(points) {
        let sL = 0, sM = 0;
        for (const p of points) { sL += p[0]; sM += p[1]; }
        return [sL / points.length, sM / points.length];
    }

    /**
     * Map an RGBA pixel from an IEM N0Q composite NEXRAD tile to intensity 0–7.
     * Color values match the NWS standard N0Q palette used by Iowa State Mesonet.
     * PNG tiles use an indexed palette — colors are exact, no compression artifacts.
     */
    static _rgbToNexradIntensity(r, g, b, a) {
        if (a < 30) return 0;                          // transparent — no echo
        if (r < 30 && g < 30 && b < 30) return 0;     // near-black — below noise floor

        // Magenta  (248,   0, 253): 65–70 dBZ → 7
        if (r > 200 && g < 30 && b > 200) return 7;
        // Purple   (152,  84, 198): 70–75 dBZ → 7
        if (b > 150 && r > 100 && r < 200 && g > 40 && g < 130) return 7;
        // White    (255, 255, 255): 75+ dBZ → 7 (rare extreme)
        if (r > 220 && g > 220 && b > 220) return 7;

        // Bright red (253,  0,  0): 50–55 dBZ → 5
        if (r > 230 && g < 20 && b < 20) return 5;
        // Dark red   (188–212, 0, 0): 55–65 dBZ → 6
        if (r > 160 && r <= 230 && g < 20 && b < 20) return 6;

        // Orange  (253, 149,  0): 45–50 dBZ → 4
        if (r > 220 && g > 100 && g < 180 && b < 20) return 4;
        // Amber   (229, 188,  0): 40–45 dBZ → 4
        if (r > 180 && g > 150 && g < 220 && b < 20) return 4;
        // Yellow  (253, 248,  2): 35–40 dBZ → 3
        if (r > 220 && g > 220 && b < 15) return 3;

        // Dark green   (  0, 142, 0): 30–35 dBZ → 3
        if (g > 100 && g < 170 && r < 20 && b < 20) return 3;
        // Medium green (  1, 197, 1): 25–30 dBZ → 2
        if (g >= 170 && g < 220 && r < 20 && b < 20) return 2;
        // Bright green (  2, 253, 2): 20–25 dBZ → 2
        if (g >= 220 && r < 20 && b < 20) return 2;

        // Cyan        (  4, 233, 231): 5–10 dBZ → 1
        if (g > 200 && b > 200 && r < 20) return 1;
        // Light blue  (  1, 159, 244): 10–15 dBZ → 1
        if (b > 210 && g > 120 && g < 200 && r < 20) return 1;
        // Blue        (  3,   0, 244): 15–20 dBZ → 1
        if (b > 210 && g < 30 && r < 20) return 1;

        return 0;
    }

    /** Web mercator tile coordinate helpers. */
    static _lon2tile(lon, z) {
        return Math.floor((lon + 180) / 360 * Math.pow(2, z));
    }
    static _lat2tile(lat, z) {
        const r = lat * Math.PI / 180;
        return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
    }
    static _tile2lat(yf, z) {
        const n = Math.PI - 2 * Math.PI * yf / Math.pow(2, z);
        return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    }
    static _tile2lon(xf, z) {
        return xf / Math.pow(2, z) * 360 - 180;
    }
}
