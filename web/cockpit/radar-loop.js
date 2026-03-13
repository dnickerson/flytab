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
        this._nexrad = nexrad;
    }

    // ========== Public API ==========

    show(map) {
        if (this._active) return;
        this._map = map;
        this._active = true;

        // Enable the NEXRAD canvas overlay if not already active
        if (this._nexrad && !this._nexrad._active) {
            this._nexrad.addTo(map);
        }

        // Suppress live NEXRAD draws while loop is playing
        if (this._nexrad) this._nexrad.enterLoopMode();

        const frames = this._nexrad ? this._nexrad.frameHistory : [];
        if (frames.length === 0) {
            this._showNoData();
        }

        this._showControls();
        this._updateFrameCount();
        if (frames.length > 0) {
            this._goToFrame(frames.length - 1);
            this.play();
        }
    }

    hide() {
        this.pause();
        this._hideControls();
        // Resume live NEXRAD draws and restore current data
        if (this._nexrad) {
            this._nexrad.exitLoopMode();
            if (this._nexrad._active) this._nexrad._draw();
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
        if (index < 0 || index >= frames.length) return;

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
            this._timeDisplay.textContent = 'NO FIS-B RADAR';
            this._timeDisplay.style.color = '#ff6666';
        }
    }

    // ========== Controls DOM ==========

    _buildControls() {
        const el = document.createElement('div');
        el.className = 'radar-loop-controls';
        el.innerHTML = `
            <div class="radar-controls-inner">
                <div class="radar-controls-row radar-transport">
                    <button class="radar-btn radar-prev" title="Previous frame">&laquo;</button>
                    <button class="radar-btn radar-play" title="Play/Pause">&#9654;</button>
                    <button class="radar-btn radar-next" title="Next frame">&raquo;</button>
                    <span class="radar-time-display">--:--Z</span>
                    <span class="radar-frame-count"></span>
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
        this._playBtn = playBtn;
        this._timeDisplay = el.querySelector('.radar-time-display');
        this._frameCountEl = el.querySelector('.radar-frame-count');

        prevBtn.addEventListener('click', (e) => { e.stopPropagation(); this.prevFrame(); });
        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._playing) { this.pause(); } else { this.play(); }
        });
        nextBtn.addEventListener('click', (e) => { e.stopPropagation(); this.nextFrame(); });

        // Touch support for iPad
        [prevBtn, playBtn, nextBtn].forEach(btn => {
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
    }
}
