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

    /** METAR wind only, independent of manual mode -- used both for the METAR-mode display and to seed Manual mode. */
    static _metarWind(wx) {
        const d = wx?.metar?.decoded;
        if (!d || d.wind_variable || d.wind_dir == null || !d.wind_speed) return null;
        return { dir: d.wind_dir, speed: d.wind_speed, gust: d.wind_gust || null };
    }

    /** The wind actually driving the current display: manual entry if Manual mode is on and has values, else METAR. */
    _activeWind() {
        if (this._manualMode) {
            return (this._manualDir != null && this._manualSpeed != null)
                ? { dir: this._manualDir, speed: this._manualSpeed, gust: null }
                : null;
        }
        return WindCompass._metarWind(this._wx);
    }

    _draw() {
        const container = this._container;
        const runways = this._runways || [];

        if (!runways.length) {
            container.innerHTML = '<div class="wc-no-runways">No runway data</div>';
            return;
        }

        const ends = WindCompass.parseRunwayEnds(runways);
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
            ${!wind ? '<div class="wc-no-wind">No wind reported</div>' : ''}
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
            const hwText = end.headwind == null ? ''
                : (end.headwind >= 0 ? `${end.headwind}HW` : `${Math.abs(end.headwind)}TW`) + ` ${end.crosswind}XW`;
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
        const dirDisplay = this._manualMode ? (this._manualDir ?? '—') : (wind ? wind.dir : '—');
        const spdDisplay = this._manualMode ? (this._manualSpeed ?? '—') : (wind ? wind.speed : '—');

        return `
            <div class="wc-manual-controls" ${this._manualMode ? '' : 'hidden'}>
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

        wireTap(container.querySelector('.wc-numpad-done'), () => this._closeNumpad(true));

        wireTap(container.querySelector('.wc-np-back'), () => {
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
                if (this._activeNumpadField === 'dir') this._manualDir = WindCompass.clampHeading(raw);
                else this._manualSpeed = raw;
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
        enriched.sort((a, b) => b.headwind - a.headwind);
        enriched.forEach((end, i) => { end.isBest = i === 0; });
        return enriched;
    }

    /**
     * Normalize a heading to [0, 360). A numpad only enforces digit count,
     * not range -- 999 is a valid 3-digit entry -- so this is a separate,
     * explicit clamp applied to whatever the numpad produced for the
     * direction field specifically (wind speed has no such wraparound).
     */
    static clampHeading(n) {
        if (n == null) return null;
        const wrapped = n % 360;
        return wrapped < 0 ? wrapped + 360 : wrapped;
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
