/**
 * FlyPi — NEXRAD Radar Loop
 * Animated radar playback using FIS-B NEXRAD frame history from FisbNexrad.
 * Falls back to "NO FIS-B RADAR" when no data is available.
 */

class RadarLoop {
    constructor() {
        this._map = null;
        this._active = false;
        this._playing = false;
        this._frameIndex = 0;
        this._timer = null;

        // FIS-B NEXRAD renderer reference (set via setNexrad())
        this._nexrad = null;

        // Config
        this._speedMs = CockpitConfig.get('radar.playbackSpeedMs') || 500;
        this._autoLoop = CockpitConfig.get('radar.autoLoop') !== false;

        // Build control DOM (hidden until show())
        this._controlEl = this._buildControls();
        this._controlEl.style.display = 'none';
    }

    /** Wire the FisbNexrad renderer for frame data */
    setNexrad(nexrad) {
        if (this._nexrad?.setOnReady) this._nexrad.setOnReady(null); // cancel any pending callback
        this._nexrad = nexrad;
    }

    // ========== Public API ==========

    show(map) {
        if (this._active) return;
        this._map = map;
        this._active = true;

        // Enable the NEXRAD canvas overlay if not already active
        if (this._nexrad && !this._nexrad.isActive) {
            this._nexrad.addTo(map);
        }

        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (frames.length > 0) {
            // Suppress live draws while playing historical frames
            if (this._nexrad) this._nexrad.enterLoopMode();
            this._showControls();
            this._updateSourceBadge();
            this._updateFrameCount();
            this._goToFrame(frames.length - 1);
            this.play();
        } else {
            // No snapshots yet — show live NEXRAD blocks if any, "NO DATA" if none
            if (this._nexrad) this._nexrad.enterLoopMode();
            this._showControls();
            this._showNoData();
            if (this._nexrad?.hasData) {
                this._nexrad.drawLive();
            }
            // Self-heal: if frames arrive asynchronously (e.g. RainViewer finishes loading
            // after show() returns), start playback automatically.
            if (this._nexrad?.setOnReady) {
                this._nexrad.setOnReady(() => {
                    if (!this._active) return;
                    const f = this._nexrad.frameHistory;
                    if (f.length === 0) return;
                    this._updateFrameCount();
                    this._goToFrame(f.length - 1);
                    this.play();
                });
            }
        }
    }

    hide() {
        this.pause();
        this._hideControls();
        if (this._nexrad?.setOnReady) this._nexrad.setOnReady(null); // cancel pending self-heal
        // Resume live NEXRAD draws and restore current data
        if (this._nexrad) {
            this._nexrad.exitLoopMode(); // safe to call even if never entered
            if (this._nexrad.isActive) this._nexrad.drawLive();
        }
        this._frameIndex = 0;
        this._active = false;
        this._map = null;
    }

    toggle(map) {
        if (this._active) {
            this.hide();
        } else {
            this.show(map);
        }
        return this._active;
    }

    async refresh() {
        if (!this._active) return;
        try {
            await this._nexrad?.refresh?.();
        } catch { /* network error — leave current frames in place */ }
        this.pause();
        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (frames.length > 0) {
            this._updateFrameCount();
            // Clamp frameIndex so a rebuilt (shorter) frame array doesn't leave us out of range
            this._goToFrame(Math.min(this._frameIndex, frames.length - 1));
            this.play();
        } else {
            this._showNoData();
        }
        if (this._refreshBtn) {
            this._refreshBtn.style.color = 'var(--status-ok, #00c864)';
            setTimeout(() => { if (this._refreshBtn) this._refreshBtn.style.color = ''; }, 600);
        }
    }

    play() {
        if (!this._active || this._playing) return;
        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (frames.length === 0) return;

        this._playing = true;
        this._updatePlayBtn();
        this._tick();
    }

    pause() {
        this._playing = false;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._updatePlayBtn();
    }

    nextFrame() {
        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (!this._active || frames.length === 0) return;
        const next = (this._frameIndex + 1) % frames.length;
        this._goToFrame(next);
    }

    prevFrame() {
        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (!this._active || frames.length === 0) return;
        const prev = (this._frameIndex - 1 + frames.length) % frames.length;
        this._goToFrame(prev);
    }

    // ========== Frame Management ==========

    _goToFrame(index) {
        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (frames.length === 0) return;
        index = Math.max(0, Math.min(index, frames.length - 1));

        this._frameIndex = index;

        // Tell FisbNexrad to render this historical frame
        if (this._nexrad) {
            this._nexrad.drawFrame(index);
        }

        this._updateTimeDisplay();
        if (this._scrubber) {
            this._scrubber.max = frames.length - 1;
            this._scrubber.value = index;
        }
    }

    _tick() {
        if (!this._playing || !this._active) return;

        this._timer = setTimeout(() => {
            if (!this._playing) return;

            const frames = this._nexrad ? this._nexrad.frameHistory : [];
            const next = this._frameIndex + 1;
            if (next >= frames.length) {
                if (this._autoLoop) {
                    this._goToFrame(0);
                } else {
                    this.pause();
                    return;
                }
            } else {
                this._goToFrame(next);
            }

            this._tick();
        }, this._speedMs);
    }

    _updateFrameCount() {
        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (this._scrubber) {
            this._scrubber.max = Math.max(frames.length - 1, 0);
            this._scrubber.value = Math.min(this._frameIndex, frames.length - 1);
        }
    }

    _showNoData() {
        if (this._timeDisplay) {
            this._timeDisplay.textContent = 'NO RADAR DATA';
            this._timeDisplay.style.color = '#ff6666';
        }
        this._updateSourceBadge();
    }

    _updateSourceBadge() {
        if (!this._sourceBadge) return;
        const src = this._nexrad?.sourceType;
        if (src === 'fisb') {
            this._sourceBadge.textContent = 'FIS-B';
            this._sourceBadge.style.background = 'rgba(0, 200, 100, 0.2)';
            this._sourceBadge.style.color = '#00c864';
        } else if (src === 'inet') {
            this._sourceBadge.textContent = 'INET';
            this._sourceBadge.style.background = 'rgba(0, 150, 255, 0.2)';
            this._sourceBadge.style.color = '#00aaff';
        } else {
            this._sourceBadge.textContent = 'NO DATA';
            this._sourceBadge.style.background = 'rgba(255, 80, 80, 0.2)';
            this._sourceBadge.style.color = '#ff6666';
        }
    }

    // ========== Controls DOM ==========

    _buildControls() {
        const el = document.createElement('div');
        el.className = 'radar-loop-controls';
        el.innerHTML = `
            <div class="radar-controls-inner">
                <div class="radar-controls-row radar-transport">
                    <span class="radar-source-badge"></span>
                    <button class="radar-btn radar-prev" title="Previous frame">&laquo;</button>
                    <button class="radar-btn radar-play" title="Play/Pause">&#9654;</button>
                    <button class="radar-btn radar-next" title="Next frame">&raquo;</button>
                    <span class="radar-time-display">--:--Z</span>
                    <span class="radar-age-display"></span>
                    <span class="radar-frame-count"></span>
                    <button class="radar-btn radar-refresh" title="Refresh">&#8635;</button>
                </div>
                <div class="radar-controls-row radar-scrubber-row">
                    <input type="range" class="radar-scrubber" min="0" max="0" value="0" />
                </div>
            </div>
        `;

        // Style
        Object.assign(el.style, {
            position: 'absolute',
            bottom: '60px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: '1000',
            background: 'rgba(13, 17, 23, 0.92)',
            borderRadius: '8px',
            padding: '8px 12px',
            color: '#e0e0e0',
            fontFamily: '"JetBrains Mono", "SF Mono", monospace',
            fontSize: '13px',
            backdropFilter: 'blur(4px)',
            border: '1px solid rgba(255,255,255,0.1)',
            userSelect: 'none',
            pointerEvents: 'auto',
        });

        // Transport buttons
        const prevBtn = el.querySelector('.radar-prev');
        const playBtn = el.querySelector('.radar-play');
        const nextBtn = el.querySelector('.radar-next');
        const refreshBtn = el.querySelector('.radar-refresh');
        this._playBtn = playBtn;
        this._refreshBtn = refreshBtn;
        this._timeDisplay = el.querySelector('.radar-time-display');
        this._ageDisplay = el.querySelector('.radar-age-display');
        if (this._ageDisplay) {
            Object.assign(this._ageDisplay.style, {
                fontSize: '11px',
                fontWeight: '700',
                marginLeft: '6px',
                padding: '1px 4px',
                borderRadius: '3px',
            });
        }
        this._frameCountEl = el.querySelector('.radar-frame-count');
        this._sourceBadge = el.querySelector('.radar-source-badge');

        prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.prevFrame(); });
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._playing) { this.pause(); } else { this.play(); }
        });
        nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.nextFrame(); });
        refreshBtn.addEventListener('click', (e) => { e.stopPropagation(); this.refresh(); });

        // Touch support for iPad
        [prevBtn, playBtn, nextBtn, refreshBtn].forEach(btn => {
            btn.addEventListener('touchend', (e) => {
                e.preventDefault();
                e.stopPropagation();
                btn.click();
            }, { passive: false });
        });

        // Style all buttons
        el.querySelectorAll('.radar-btn').forEach(btn => {
            Object.assign(btn.style, {
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.2)',
                color: '#e0e0e0',
                borderRadius: '4px',
                padding: '4px 10px',
                cursor: 'pointer',
                fontSize: '14px',
                lineHeight: '1',
                touchAction: 'manipulation',
            });
        });

        // Source badge
        if (this._sourceBadge) {
            Object.assign(this._sourceBadge.style, {
                fontSize: '10px',
                fontWeight: '700',
                padding: '1px 5px',
                borderRadius: '3px',
                letterSpacing: '0.5px',
                marginRight: '4px',
            });
        }

        // Time display
        Object.assign(this._timeDisplay.style, {
            color: '#00d4ff',
            fontWeight: 'bold',
            marginLeft: '8px',
            fontSize: '15px',
        });

        // Frame count
        if (this._frameCountEl) {
            Object.assign(this._frameCountEl.style, {
                color: '#888',
                marginLeft: '8px',
                fontSize: '11px',
            });
        }

        // Scrubber
        this._scrubber = el.querySelector('.radar-scrubber');
        Object.assign(this._scrubber.style, {
            width: '100%',
            margin: '4px 0',
            accentColor: '#00d4ff',
        });
        this._scrubber.addEventListener('input', (e) => {
            e.stopPropagation();
            const idx = parseInt(this._scrubber.value, 10);
            this.pause();
            this._goToFrame(idx);
        });

        // Style rows
        el.querySelectorAll('.radar-controls-row').forEach(row => {
            Object.assign(row.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '4px',
            });
        });

        // Prevent map interaction through controls
        L.DomEvent.disableClickPropagation(el);
        L.DomEvent.disableScrollPropagation(el);

        return el;
    }

    _showControls() {
        if (!this._map) return;
        const container = this._map.getContainer();
        if (!this._controlEl.parentNode) {
            container.appendChild(this._controlEl);
        }
        this._controlEl.style.display = '';
    }

    _hideControls() {
        this._controlEl.style.display = 'none';
    }

    _updatePlayBtn() {
        if (!this._playBtn) return;
        this._playBtn.innerHTML = this._playing ? '&#9646;&#9646;' : '&#9654;';
        this._playBtn.title = this._playing ? 'Pause' : 'Play';
    }

    _updateTimeDisplay() {
        if (!this._timeDisplay) return;
        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (frames.length === 0) {
            this._showNoData();
            return;
        }

        const frame = frames[this._frameIndex];
        if (!frame) return;

        const dt = new Date(frame.time);
        const utcLabel = dt.toISOString().slice(11, 16) + 'Z';
        this._timeDisplay.textContent = utcLabel;
        this._timeDisplay.style.color = '#00d4ff';

        // Show frame position
        if (this._frameCountEl) {
            this._frameCountEl.textContent = `${this._frameIndex + 1}/${frames.length}`;
        }
        this._updateSourceBadge();

        if (this._ageDisplay && this._nexrad) {
            const ageMs = this._nexrad.getDataAgeMs();
            if (ageMs === null) {
                this._ageDisplay.textContent = '';
            } else {
                const ageMin = Math.round(ageMs / 60000);
                this._ageDisplay.textContent = `${ageMin}min`;
                this._ageDisplay.style.background =
                    ageMin < 5  ? 'rgba(0,200,100,0.25)'  :
                    ageMin < 10 ? 'rgba(255,170,0,0.25)'  :
                                  'rgba(255,51,0,0.25)';
                this._ageDisplay.style.color =
                    ageMin < 5  ? '#00c864' :
                    ageMin < 10 ? '#ffaa00' :
                                  '#ff3300';
            }
        }
    }
}
