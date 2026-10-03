/**
 * FlyTab — Wind compass rose for the Airport Info popup's Wind tab.
 * Renders METAR or manually-entered wind against the airport's runway
 * headings so the pilot can visualize crosswind/headwind at a glance.
 */
class WindCompass {
    constructor() {
        this._container = null;
        this._runways = null;
        this._wx = null;
        this._manualMode = false;
        this._manualDir = null;
        this._manualSpeed = null;
        this._activeNumpad = null;
        this._activeNumpadField = null; // 'dir' | 'speed' | null
    }

    /** Entry point: render into `container`, given NASR runway records and the airport's wx object. */
    render(container, runways, wx) {
        this._container = container;
        this._runways = runways;
        this._wx = wx;
        this._draw();
    }

    /**
     * A newer METAR arrived (FIS-B or internet) while the popup is open.
     * Redraw in METAR mode; in Manual mode just keep it for the next switch
     * back, so the pilot's own entry and any open numpad aren't disturbed.
     */
    updateWx(wx) {
        this._wx = wx;
        if (this._container && !this._manualMode && !this._activeNumpad) this._draw();
    }

    /** METAR wind only, independent of manual mode -- used both for the METAR-mode display and to seed Manual mode. */
    static _metarWind(wx) {
        const d = wx?.metar?.decoded;
        if (!d || d.wind_variable || d.wind_dir == null || !d.wind_speed) return null;
        return { dir: d.wind_dir, speed: d.wind_speed, gust: d.wind_gust || null };
    }

    /** The wind actually driving the current display: manual entry if Manual mode is on and has values, else METAR. */
    _activeWind() {
        if (this._manualMode) {
            return (this._manualDir != null && this._manualSpeed)
                ? { dir: this._manualDir, speed: this._manualSpeed, gust: null }
                : null;
        }
        return WindCompass._metarWind(this._wx);
    }

    /**
     * What to say when there is no single wind to draw: calm and variable are
     * real reports, not missing data -- VRB12G22 is exactly when the pilot
     * needs this tab, so it must not read "no wind".
     */
    static _noWindText(wx, manualMode, manualSpeed) {
        if (manualMode) return manualSpeed === 0 ? 'CALM' : 'Enter wind direction and speed';
        const d = wx?.metar?.decoded;
        if (!d) return 'No METAR wind';
        if (d.wind_variable) {
            if (!d.wind_speed) return 'Wind variable';
            const gust = d.wind_gust ? `G${d.wind_gust}` : '';
            return `VRB ${d.wind_speed}${gust} kt \u2014 crosswind up to ${d.wind_gust || d.wind_speed} kt on any runway`;
        }
        if (d.wind_speed === 0) return 'CALM';
        return 'No METAR wind';
    }

    /** Source and age of the METAR driving METAR mode, flagged STALE past 75 min like the WX tab. */
    static _metarAgeHtml(wx) {
        const obs = wx?.metar?.decoded?.observed_at;
        if (!obs) return '';
        const dt = new Date(obs);
        if (isNaN(dt.getTime())) return '';
        const hh = String(dt.getUTCHours()).padStart(2, '0');
        const mm = String(dt.getUTCMinutes()).padStart(2, '0');
        const ageMin = Math.max(0, Math.round((Date.now() - dt.getTime()) / 60000));
        const age = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
        const stale = ageMin > 75;
        const src = wx.source ? `${String(wx.source).toUpperCase()} ` : '';
        return `<div class="wc-metar-age${stale ? ' wc-metar-stale' : ''}">${src}METAR ${hh}${mm}Z (${age})${stale ? ' \u26a0 STALE' : ''}</div>`;
    }

    static _fmtHeading(h) {
        return h == null ? '\u2014' : String(h).padStart(3, '0');
    }

    _draw() {
        const container = this._container;
        const runways = this._runways || [];

        if (!runways.length) {
            container.innerHTML = '<div class="wc-no-runways">No runway data</div>';
            return;
        }

        const ends = WindCompass.parseRunwayEnds(runways);
        if (!ends.length) {
            container.innerHTML = '<div class="wc-no-runways">Runway headings not available for this airport</div>';
            return;
        }
        const wind = this._activeWind();
        const enrichedEnds = wind
            ? WindCompass.computeWindComponents(ends, wind.dir, wind.speed, wind.gust)
            : ends.map(e => ({ ...e, headwind: null, crosswind: null, gustXwind: null, isBest: false }));

        const cx = 150, cy = 150, r = 110;
        container.innerHTML = `
            <div class="wc-mode-toggle">
                <button class="wc-mode-metar ${!this._manualMode ? 'active' : ''}">METAR</button>
                <button class="wc-mode-manual ${this._manualMode ? 'active' : ''}">MANUAL</button>
            </div>
            ${!this._manualMode ? WindCompass._metarAgeHtml(this._wx) : ''}
            ${!wind ? `<div class="wc-no-wind">${WindCompass._noWindText(this._wx, this._manualMode, this._manualSpeed)}</div>` : ''}
            ${this._buildSvgMarkup(runways, enrichedEnds, wind, cx, cy, r)}
            ${this._buildControlsMarkup(wind)}
        `;
        this._wireControls();
    }

    _buildSvgMarkup(runways, enrichedEnds, wind, cx, cy, r) {
        const ticks = [];
        for (let h = 0; h < 360; h += 30) {
            const outer = WindCompass.headingToXY(h, r, cx, cy);
            const inner = WindCompass.headingToXY(h, r - 8, cx, cy);
            const label = h === 0 ? 'N' : h === 90 ? 'E' : h === 180 ? 'S' : h === 270 ? 'W' : '';
            ticks.push(`<line class="wc-tick" x1="${inner.x}" y1="${inner.y}" x2="${outer.x}" y2="${outer.y}"/>`);
            if (label) {
                const lp = WindCompass.headingToXY(h, r + 14, cx, cy);
                ticks.push(`<text class="wc-tick-label" x="${lp.x}" y="${lp.y}" text-anchor="middle" dominant-baseline="middle">${label}</text>`);
            }
        }

        const runwayLines = runways.map(rwy => {
            const rwyEnds = WindCompass.parseRunwayEnds([rwy]);
            if (rwyEnds.length === 0) return '';
            const p1 = WindCompass.headingToXY(rwyEnds[0].hdg, r - 20, cx, cy);
            const p2 = rwyEnds.length > 1
                ? WindCompass.headingToXY(rwyEnds[1].hdg, r - 20, cx, cy)
                : { x: cx, y: cy };
            return `<line class="wc-runway-line" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>`;
        }).join('');

        const endLabels = enrichedEnds.map(end => {
            const pos = WindCompass.headingToXY(end.hdg, r - 34, cx, cy);
            const xwText = end.gustXwind > end.crosswind ? `${end.crosswind}G${end.gustXwind}XW` : `${end.crosswind}XW`;
            const hwText = end.headwind == null ? ''
                : (end.headwind >= 0 ? `${end.headwind}HW` : `${Math.abs(end.headwind)}TW`) + ` ${xwText}`;
            return `<g class="wc-end-label ${end.isBest ? 'wc-best' : ''}" transform="translate(${pos.x},${pos.y})">
                ${end.isBest ? '<circle class="wc-best-dot" cx="-22" cy="-4" r="4"/>' : ''}
                <text class="wc-end-id" text-anchor="middle">${end.label}</text>
                ${hwText ? `<text class="wc-end-wind" text-anchor="middle" dy="13">${hwText}</text>` : ''}
            </g>`;
        }).join('');

        // Arrow points FROM the rim (where the wind originates) IN toward
        // center -- the confirmed aviation convention: the arrowhead shows
        // where the wind is headed (at the aircraft), the tail shows where
        // it's coming from, anchored at the reported direction.
        // Long and bold on purpose: a first pass at 38px/3px-wide/light-blue
        // was structurally correct (the element existed) but nearly
        // invisible against the rose in an actual rendered screenshot --
        // this is the single piece of information the whole feature exists
        // to show, so it needs to visually dominate the diagram, not blend
        // into the tick marks.
        const windArrow = wind ? (() => {
            const tail = WindCompass.headingToXY(wind.dir, r, cx, cy);
            const tip = WindCompass.headingToXY(wind.dir, r * 0.4, cx, cy);
            return `<g class="wc-wind-arrow">
                <line x1="${tail.x}" y1="${tail.y}" x2="${tip.x}" y2="${tip.y}" marker-end="url(#wc-arrowhead)"/>
            </g>`;
        })() : '';

        return `<svg class="wc-rose" viewBox="0 0 300 300">
            <defs>
                <!-- userSpaceOnUse, not the SVG default markerUnits="strokeWidth" --
                     the default multiplies markerWidth/Height by stroke-width, so a
                     14-unit marker on a stroke-width:6 line rendered at 84 units and
                     swallowed the adjacent runway-end label. This keeps the arrowhead
                     a fixed, predictable size regardless of the line's stroke width. -->
                <marker id="wc-arrowhead" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" refX="6" refY="6" orient="auto">
                    <path class="wc-arrowhead-path" d="M0,0 L12,6 L0,12 z"/>
                </marker>
            </defs>
            <circle class="wc-rose-circle" cx="${cx}" cy="${cy}" r="${r}"/>
            ${ticks.join('')}
            ${runwayLines}
            ${windArrow}
            ${endLabels}
        </svg>`;
    }

    _buildControlsMarkup(wind) {
        // Only rendered in Manual mode: the fields are inert in METAR mode, and a
        // `hidden` attribute alone loses to .wc-manual-controls { display:flex }.
        if (!this._manualMode) return '';
        const dirDisplay = WindCompass._fmtHeading(this._manualDir);
        const spdDisplay = this._manualSpeed ?? '\u2014';

        return `
            <div class="wc-manual-controls">
                <div class="wc-field">
                    <span class="wc-field-label">DIR</span>
                    <button class="wc-dir-value" data-field="dir">${dirDisplay}</button>
                </div>
                <div class="wc-field">
                    <span class="wc-field-label">SPD</span>
                    <button class="wc-spd-value" data-field="speed">${spdDisplay}</button>
                </div>
            </div>
            <div class="wc-numpad-sheet" style="display:none">
                <div class="wc-numpad-value">—</div>
                <div class="wc-numpad-grid">
                    ${[7, 8, 9, 4, 5, 6, 1, 2, 3].map(d => `<button class="wc-np-key" data-digit="${d}">${d}</button>`).join('')}
                    <div></div>
                    <button class="wc-np-key" data-digit="0">0</button>
                    <button class="wc-np-back">⌫</button>
                </div>
                <button class="wc-numpad-done">DONE</button>
            </div>
        `;
    }

    // Every tap target here goes through wireTap (web/shared/tap-utils.js),
    // not a plain click listener. This isn't stylistic: plain click alone
    // relies on the browser's synthetic click after touchend, which this
    // codebase has already hit real bugs from (see CLAUDE.md's wireTap
    // double-fire note) especially across a DOM rebuild mid-interaction --
    // exactly what _draw() does on every mode-toggle and DONE tap. Every
    // other tappable element in airport-popup.js already goes through
    // wireTap; a plain click handler here was the one exception, not a
    // deliberate choice.
    _wireControls() {
        const container = this._container;

        wireTap(container.querySelector('.wc-mode-metar'), () => {
            this._manualMode = false;
            this._draw();
        });

        wireTap(container.querySelector('.wc-mode-manual'), () => {
            if (!this._manualMode) {
                const metarWind = WindCompass._metarWind(this._wx);
                if (this._manualDir == null && metarWind) this._manualDir = metarWind.dir;
                if (this._manualSpeed == null && metarWind) this._manualSpeed = metarWind.speed;
            }
            this._manualMode = true;
            this._draw();
        });

        container.querySelectorAll('[data-field]').forEach(btn => {
            wireTap(btn, () => this._openNumpad(btn.dataset.field));
        });

        const doneBtn = container.querySelector('.wc-numpad-done');
        if (doneBtn) wireTap(doneBtn, () => this._closeNumpad(true));

        const backBtn = container.querySelector('.wc-np-back');
        if (backBtn) wireTap(backBtn, () => {
            this._activeNumpad?.backspace();
            this._updateNumpadDisplay();
        });

        container.querySelectorAll('.wc-np-key[data-digit]').forEach(btn => {
            wireTap(btn, () => {
                this._activeNumpad?.press(btn.dataset.digit);
                this._updateNumpadDisplay();
            });
        });
    }

    _openNumpad(field) {
        this._activeNumpadField = field;
        this._activeNumpad = new WindNumpad(3);
        const sheet = this._container.querySelector('.wc-numpad-sheet');
        if (sheet) sheet.style.display = '';
        this._updateNumpadDisplay();
    }

    _updateNumpadDisplay() {
        const valueEl = this._container.querySelector('.wc-numpad-value');
        if (valueEl) valueEl.textContent = this._activeNumpad.digits || '—';
    }

    _closeNumpad(apply) {
        if (apply && this._activeNumpad) {
            const raw = this._activeNumpad.value;
            if (raw != null) {
                const isDir = this._activeNumpadField === 'dir';
                const value = isDir ? WindCompass.validHeading(raw) : WindCompass.validSpeed(raw);
                if (value == null) {
                    // Out of range (e.g. 370 typed for 270): keep the pad open
                    // rather than silently applying a wrapped value.
                    this._activeNumpad.clear();
                    const valueEl = this._container.querySelector('.wc-numpad-value');
                    if (valueEl) valueEl.textContent = isDir ? '001\u2013360' : '0\u2013150 kt';
                    return;
                }
                if (isDir) this._manualDir = value;
                else this._manualSpeed = value;
            }
        }
        this._activeNumpad = null;
        this._activeNumpadField = null;
        this._draw();
    }

    /**
     * Convert a compass heading (0=N, clockwise, degrees) to SVG (x,y) on a
     * circle of the given radius centered at (cx,cy). SVG y grows downward,
     * so this is a standard compass-to-screen rotation, not a math-angle one.
     */
    static headingToXY(headingDeg, radius, cx, cy) {
        const rad = (headingDeg % 360) * Math.PI / 180;
        return {
            x: cx + radius * Math.sin(rad),
            y: cy - radius * Math.cos(rad),
        };
    }

    /**
     * Parse NASR runway records into individual ends with headings.
     * A runway id like "08L/26R" is two ends (080°, 260°); "18" alone is
     * one. Same regex/heading math as airport-popup.js's old
     * _bestRunwayHtml, just without the wind-dependent part.
     */
    static parseRunwayEnds(runways) {
        const ends = [];
        for (const rwy of runways || []) {
            const parts = (rwy.id || '').split('/');
            for (const part of parts) {
                const match = part.trim().match(/^(\d{1,2})(L|R|C)?$/i);
                if (!match) continue;
                const hdg = parseInt(match[1], 10) * 10;
                const suffix = (match[2] || '').toUpperCase();
                const label = String(match[1]).padStart(2, '0') + suffix;
                ends.push({ label, hdg, length_ft: rwy.length_ft });
            }
        }
        return ends;
    }

    /**
     * Enrich parsed runway ends with headwind/crosswind/gust-crosswind for
     * a given wind, sorted best (highest headwind) first. Same trig as
     * airport-popup.js's old _bestRunwayHtml: headwind = speed*cos(diff),
     * crosswind = speed*sin(diff), diff = windDir - runwayHdg. A negative
     * headwind is a tailwind, not clamped to zero -- callers decide how to
     * label that.
     */
    static computeWindComponents(ends, windDir, windSpd, gustSpd) {
        const gust = gustSpd || windSpd;
        const enriched = ends.map(end => {
            const diff = (windDir - end.hdg) * Math.PI / 180;
            const headwind = Math.round(windSpd * Math.cos(diff));
            const crosswind = Math.abs(Math.round(windSpd * Math.sin(diff)));
            const gustXwind = Math.abs(Math.round(gust * Math.sin(diff)));
            return { ...end, headwind, crosswind, gustXwind };
        });
        // Sort on the unrounded components: rounding made 13 (15HW 3XW) tie
        // 14 (15HW 0XW) for a 140 wind and the list order picked 13. Ties then
        // go to the smaller crosswind.
        const raw = (e) => {
            const diff = (windDir - e.hdg) * Math.PI / 180;
            return { hw: windSpd * Math.cos(diff), xw: Math.abs(windSpd * Math.sin(diff)) };
        };
        enriched.sort((a, b) => {
            const ra = raw(a), rb = raw(b);
            return (rb.hw - ra.hw) || (ra.xw - rb.xw);
        });
        // A tailwind end is never "best" (e.g. a lone "18" with a north wind).
        enriched.forEach((end, i) => { end.isBest = i === 0 && end.headwind >= 0; });
        return enriched;
    }

    /**
     * A manually typed wind direction, or null if out of range. The numpad
     * only limits digit count, so 999 or 370 (a slip for 270) can arrive
     * here; reject them instead of wrapping to a plausible-looking wrong
     * heading. 0 is treated as 360 (wind from north).
     */
    static validHeading(n) {
        if (n == null || !Number.isFinite(n) || n < 0 || n > 360) return null;
        return n === 0 ? 360 : n;
    }

    /** A manually typed wind speed in knots, or null if out of range. */
    static validSpeed(n) {
        if (n == null || !Number.isFinite(n) || n < 0 || n > 150) return null;
        return n;
    }
}

/**
 * Digit-entry buffer backing the Wind tab's manual-override numpad, same
 * interaction as ifr-clearance.js's numpad sheet (tap digits, DONE to
 * confirm) but built self-contained here rather than sharing that file's
 * instance-coupled implementation -- see the Wind tab design notes.
 */
class WindNumpad {
    constructor(maxLen) {
        this.maxLen = maxLen;
        this.digits = '';
    }

    press(digit) {
        if (this.digits.length < this.maxLen) this.digits += digit;
    }

    backspace() {
        this.digits = this.digits.slice(0, -1);
    }

    clear() {
        this.digits = '';
    }

    get value() {
        return this.digits === '' ? null : parseInt(this.digits, 10);
    }
}
