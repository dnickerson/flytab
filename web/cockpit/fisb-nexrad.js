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

        // NEXRAD block store: "latN,lonW" → { latN, lonW, height, width, intensity[], received_at }
        this._blocks = new Map();

        // Frame history for radar loop playback (ring buffer of snapshots)
        this._frameHistory = [];
        this._maxFrames = 24; // ~60 min at 2.5 min intervals

        // Config
        this._opacity = CockpitConfig.get('radar.opacity') || 0.5;

        this.sourceType = 'fisb';

        // Loop mode: when true, suppress live _draw() so RadarLoop playback isn't overwritten
        this._loopMode = false;

        // Whether we've already notified the map to switch from internet to FIS-B this session.
        // Reset on addTo() so the notification fires again after radar is re-enabled.
        this._notifiedMap = false;

        // Bind
        this._onNexrad = (e) => this._handleNexrad(e.detail);
        this._onMove = () => { if (!this._loopMode) this._draw(); };
        this._onResize = () => this._resizeCanvas();

        // Purge timer — start immediately so blocks accumulate before overlay is shown
        this._purgeTimer = setInterval(() => this._purgeOld(), 30000);

        // Start listening for NEXRAD frames immediately (before addTo) so that
        // blocks and frame history accumulate even before the overlay is drawn.
        this._fisb.addEventListener('fisb:nexrad', this._onNexrad);
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

    // ========== Public API ==========

    /** Add the NEXRAD overlay to a Leaflet map */
    addTo(map) {
        if (this._active) return; // already attached
        this._map = map;
        this._active = true;
        this._notifiedMap = false; // reset so notification fires for this radar session

        // Create canvas in Leaflet's overlay pane so it pans/zooms with the map
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        this._canvas.className = 'fisb-nexrad-canvas';
        map.getPanes().overlayPane.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');

        // Size canvas
        this._resizeCanvas();
        map.on('resize', this._onResize);

        // Redraw on any map movement (including during panning)
        map.on('move zoom moveend zoomend', this._onMove);
    }

    /** Remove overlay from map */
    remove() {
        if (!this._active) return; // already detached
        this._active = false;
        this._notifiedMap = false;
        if (this._purgeTimer) { clearInterval(this._purgeTimer); this._purgeTimer = null; }
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

    /** Draw the live (current) radar view — for use by RadarLoop when exiting loop mode */
    drawLive() { this._draw(); }

    // ========== NEXRAD Block Handling ==========

    _handleNexrad(msg) {
        if (!msg.NEXRADBlock) return;

        const now = Date.now();
        const blocks = Array.isArray(msg.NEXRADBlock) ? msg.NEXRADBlock : [msg.NEXRADBlock];

        for (const block of blocks) {
            if (!block.Intensity || block.Intensity.length === 0) continue;

            const key = `${block.LatNorth},${block.LonWest}`;
            this._blocks.set(key, {
                latN: block.LatNorth,
                lonW: block.LonWest,
                height: block.Height,
                width: block.Width,
                intensity: block.Intensity,
                received_at: now,
            });
        }

        // Snapshot for radar loop (throttled to every 2.5 minutes)
        const lastSnap = this._frameHistory.length > 0
            ? this._frameHistory[this._frameHistory.length - 1].time : 0;
        if (now - lastSnap >= 150000) { // 2.5 minutes
            this._takeSnapshot(now);
        }

        // Redraw
        if (this._active) this._draw();

        // Notify map to switch from internet → FIS-B on first blocks of each radar session
        if (!this._notifiedMap && this._blocks.size > 0 && this._map) {
            this._notifiedMap = true;
            window.app?.cockpitMap?.onFisbNexradData?.();
        }
    }

    /** Take a snapshot of current NEXRAD state for radar loop */
    _takeSnapshot(time) {
        // Deep copy current blocks (slice intensity arrays to prevent mutation)
        const snapshot = new Map();
        for (const [key, block] of this._blocks) {
            snapshot.set(key, { ...block, intensity: block.intensity.slice() });
        }
        this._frameHistory.push({ time, blocks: snapshot });

        // Trim to max frames
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

    /** Draw all NEXRAD blocks onto canvas */
    _draw() {
        if (!this._ctx || !this._map || !this._active) return;

        const ctx = this._ctx;
        const map = this._map;

        // Position canvas at the map's pixel origin so it aligns with panning
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        this._canvas.style.transform = `translate(${topLeft.x}px, ${topLeft.y}px)`;

        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);

        if (this._blocks.size === 0) return;

        // Apply configured opacity
        ctx.globalAlpha = this._opacity;

        const bounds = map.getBounds();
        const zoom = map.getZoom();

        for (const [, block] of this._blocks) {
            // Quick bounds check — skip blocks outside viewport
            const blockS = block.latN - block.height;
            const blockE = block.lonW + block.width;
            if (block.latN < bounds.getSouth() || blockS > bounds.getNorth()) continue;
            if (blockE < bounds.getWest() || block.lonW > bounds.getEast()) continue;

            this._drawBlock(ctx, map, block, zoom);
        }

        ctx.globalAlpha = 1.0;
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

    /** Draw a specific historical frame (for radar loop) */
    drawFrame(frameIndex) {
        if (!this._ctx || !this._map) return;
        if (frameIndex < 0 || frameIndex >= this._frameHistory.length) return;

        const ctx = this._ctx;
        const map = this._map;

        // Sync canvas position with map pane
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        this._canvas.style.transform = `translate(${topLeft.x}px, ${topLeft.y}px)`;

        ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
        ctx.globalAlpha = this._opacity;

        const snapshot = this._frameHistory[frameIndex];
        if (!snapshot) return;

        const bounds = map.getBounds();
        const zoom = map.getZoom();

        for (const [, block] of snapshot.blocks) {
            const blockS = block.latN - block.height;
            const blockE = block.lonW + block.width;
            if (block.latN < bounds.getSouth() || blockS > bounds.getNorth()) continue;
            if (blockE < bounds.getWest() || block.lonW > bounds.getEast()) continue;
            this._drawBlock(ctx, map, block, zoom);
        }

        ctx.globalAlpha = 1.0;
    }

    /** Enter loop mode (suppress live draws) */
    enterLoopMode() { this._loopMode = true; }

    /** Exit loop mode (resume live draws) */
    exitLoopMode() { this._loopMode = false; }
}
