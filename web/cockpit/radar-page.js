/**
 * FlyTab — CONUS Radar Page
 * Full-screen dedicated FIS-B CONUS NEXRAD view: own Leaflet map, ownship icon,
 * SE-wide default zoom, pan/zoom + recenter, product/age badge.
 * Reuses the shared FisbNexrad data layer (renders product 'conus' to its own target).
 *
 * Independent of the main CockpitMap: owns its own L.map instance, its own overlay
 * canvas, and its own ownship marker. Does NOT touch the main map, the route editor,
 * or the main map's tap handlers.
 */
class RadarPage {
    constructor(fisbNexrad, stratuxClient) {
        this._fisb = fisbNexrad;
        this._stratux = stratuxClient;
        this._visible = false;
        this._map = null;
        this._canvas = null;
        this._ctx = null;
        this._target = null;
        this._ownship = null;
        this._ownPos = null;
        this._badge = null;
        this._ageTimer = null;
        this._defaultZoom = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get)
            ? (CockpitConfig.get('radar.conusDefaultZoom') || 6) : 6;

        this._looping = false;
        this._loopIdx = 0;
        this._loopTimer = null;
        this._speedMs = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('radar.playbackSpeedMs')) || 500;

        this._onSituation = (e) => this._updateOwnship(e.detail);
        this._onNexrad = () => {
            if (!this._visible) return;
            if (!this._looping) this._drawConus();   // live view only when not looping
            this._updateBadge();
        };
        this._buildDom();
    }

    _buildDom() {
        this._el = document.createElement('div');
        this._el.className = 'radar-page';
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="radar-page-header">
                <span class="radar-page-title">CONUS Radar</span>
                <span class="radar-badge radar-page-badge"></span>
                <button class="radar-page-export">Export</button>
                <button class="radar-page-close" aria-label="Close">&#x2715;</button>
            </div>
            <div class="radar-page-map">
                <button class="radar-page-recenter">Recenter on me</button>
                <div class="radar-page-loop">
                    <button class="radar-page-loop-btn" aria-label="Play/pause loop">&#x25B6;</button>
                    <span class="radar-page-loop-time"></span>
                    <input type="range" class="radar-page-loop-scrubber" min="0" max="0" value="0" aria-label="Radar frame">
                </div>
            </div>`;
        document.body.appendChild(this._el);
        this._mapEl = this._el.querySelector('.radar-page-map');
        this._badge = this._el.querySelector('.radar-page-badge');
        this._el.querySelector('.radar-page-export').addEventListener('click', (e) => this._onExport(e.target));
        this._el.querySelector('.radar-page-close').addEventListener('click', () => this.hide());
        this._el.querySelector('.radar-page-recenter').addEventListener('click', () => this._recenter());
        this._el.querySelector('.radar-page-loop-btn').addEventListener('click', () => this._toggleLoop());
        this._el.querySelector('.radar-page-loop-scrubber').addEventListener('input', (e) => this._scrubTo(+e.target.value));
    }

    _ensureMap() {
        if (this._map) return;
        const tileBase = 'http://localhost:9090/tiles';
        this._map = L.map(this._mapEl, { zoomControl: true, attributionControl: false });
        L.tileLayer(`${tileBase}/sectional/{z}/{x}/{y}.webp`, { minZoom: 4, maxZoom: 14 }).addTo(this._map);
        this._map.setView([35.0, -80.0], this._defaultZoom); // initial; recentre on first fix

        // Overlay canvas lives in the map's overlay pane so it pans/zooms with the map.
        // Oversized (2x container) to cover the pan-offset translate the FisbNexrad
        // renderer applies — matches the main-map convention in fisb-nexrad.js.
        this._canvas = document.createElement('canvas');
        this._canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        this._canvas.className = 'fisb-nexrad-canvas';
        this._map.getPanes().overlayPane.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');
        this._target = { map: this._map, canvas: this._canvas, ctx: this._ctx };

        const size = () => {
            const s = this._map.getSize();
            this._canvas.width = s.x * 2;
            this._canvas.height = s.y * 2;
        };
        size();
        // While looping/scrubbing, a map nudge must re-draw the CURRENT historical frame,
        // not the live composite — otherwise panning wipes the frame the pilot is reading.
        const redraw = () => { if (this._looping) this._showFrame(this._loopIdx); else this._drawConus(); };
        this._map.on('resize', () => { size(); redraw(); });
        this._map.on('move zoom moveend zoomend', redraw);
    }

    _drawConus() { if (this._target) this._fisb.draw(this._target, 'conus'); }

    _updateOwnship(sit) {
        if (!sit || sit.lat == null || sit.lon == null) return;
        this._ownPos = { lat: sit.lat, lon: sit.lon, course: sit.true_course || 0 };
        if (!this._visible || !this._map) return;
        const pos = [sit.lat, sit.lon];
        if (!this._ownship) {
            const icon = L.divIcon({
                className: 'ownship-icon',
                html: CockpitMap._ownshipSvg(this._ownPos.course),
                iconSize: [48, 48],
                iconAnchor: [24, 24],
            });
            this._ownship = L.marker(pos, { icon, zIndexOffset: 1000 }).addTo(this._map);
        } else {
            this._ownship.setLatLng(pos);
            const g = this._ownship.getElement()?.querySelector('svg g');
            if (g) g.setAttribute('transform', `rotate(${this._ownPos.course}, 24, 24)`);
        }
    }

    _recenter() {
        if (this._ownPos && this._map) this._map.setView([this._ownPos.lat, this._ownPos.lon], this._defaultZoom);
    }

    _updateBadge() {
        const ageMs = this._fisb.getDataAgeMs('conus');
        this._badge.textContent = ageMs == null
            ? 'FIS-B · CONUS · no data'
            : `FIS-B · CONUS · ${Math.round(ageMs / 60000)} min`;
    }

    /** Export cached frames to NDJSON with brief button feedback (cockpit needs confirmation). */
    async _onExport(btn) {
        const orig = btn.textContent;
        btn.textContent = 'Saving…'; btn.disabled = true;
        let r;
        try { r = await this._fisb.exportFrames(); } catch { r = { ok: false }; }
        btn.textContent = r.ok ? (r.frames ? `Saved ${r.frames}` : 'No frames') : 'Failed';
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    }

    _frames() { return this._fisb.frameHistory || []; }

    _toggleLoop() {
        if (this._looping) { this._pauseLoop(); return; }
        const n = this._frames().length;
        if (n < 2) return;               // need ≥2 frames to animate
        this._looping = true;
        this._updateLoopBtn();
        this._loopTick();
    }

    _pauseLoop() {
        this._looping = false;
        if (this._loopTimer) { clearTimeout(this._loopTimer); this._loopTimer = null; }
        this._updateLoopBtn();
    }

    _loopTick() {
        const n = this._frames().length;
        if (n === 0) { this._pauseLoop(); return; }
        this._showFrame(this._loopIdx);
        this._loopIdx = (this._loopIdx + 1) % n;
        this._loopTimer = setTimeout(() => { if (this._looping) this._loopTick(); }, this._speedMs);
    }

    _scrubTo(i) {
        this._pauseLoop();
        this._loopIdx = i;
        this._showFrame(i);
    }

    /** Draw one historical CONUS frame to the page canvas + sync the controls. */
    _showFrame(i) {
        const frames = this._frames();
        if (i < 0 || i >= frames.length) return;
        this._fisb.drawFrame(this._target, 'conus', i);
        const scr = this._el.querySelector('.radar-page-loop-scrubber');
        if (scr) { scr.max = String(frames.length - 1); scr.value = String(i); }
        const t = this._el.querySelector('.radar-page-loop-time');
        if (t) {
            const f = frames[i];
            const d = new Date(f.dataTime || f.time);
            t.textContent = isNaN(d) ? '' : d.toISOString().slice(11, 16) + 'Z';
        }
    }

    _updateLoopBtn() {
        const b = this._el.querySelector('.radar-page-loop-btn');
        if (b) b.textContent = this._looping ? '⏸' : '▶';
    }

    /** Refresh the scrubber range/label from current frame count without drawing. */
    _refreshScrubber() {
        const frames = this._frames();
        const scr = this._el.querySelector('.radar-page-loop-scrubber');
        if (scr) scr.max = String(Math.max(0, frames.length - 1));
    }

    isVisible() { return this._visible; }

    show() {
        if (this._visible) return;   // idempotent — avoid double listeners / orphaned badge timer
        this._visible = true;
        this._el.style.display = 'flex';
        this._ensureMap();
        // Start in LIVE mode — pilot presses play to animate.
        this._looping = false;
        this._loopIdx = 0;
        this._updateLoopBtn();
        setTimeout(() => {
            if (!this._visible) return;   // hide() fired before this microtask
            this._map.invalidateSize();
            this._recenter();
            this._drawConus();
            this._refreshScrubber();
        }, 0);
        this._stratux.addEventListener('stratux:situation', this._onSituation);
        this._stratux.addEventListener('stratux:nexrad', this._onNexrad);
        if (this._ownPos) {
            this._updateOwnship({ lat: this._ownPos.lat, lon: this._ownPos.lon, true_course: this._ownPos.course });
        }
        this._updateBadge();
        this._ageTimer = setInterval(() => this._updateBadge(), 30000);
    }

    hide() {
        this._visible = false;
        this._pauseLoop();
        this._el.style.display = 'none';
        this._stratux.removeEventListener('stratux:situation', this._onSituation);
        this._stratux.removeEventListener('stratux:nexrad', this._onNexrad);
        if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
    }
}
