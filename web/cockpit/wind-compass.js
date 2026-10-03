/**
 * FlyTab — Wind compass rose for the Airport Info popup's Wind tab.
 * Renders METAR or manually-entered wind against the airport's runway
 * headings so the pilot can visualize crosswind/headwind at a glance.
 *
 * Everything is computed in TRUE degrees:
 *  - METAR wind direction is true.
 *  - Runway headings are true: the great-circle bearing between the runway's
 *    two threshold coordinates from the NASR bundle (base_lat/lon,
 *    recip_lat/lon). A runway without them falls back to its number x 10
 *    (magnetic) plus the local variation.
 *  - MANUAL wind is entered the way ATIS/AWOS/tower give it -- MAGNETIC -- and
 *    converted to true with the World Magnetic Model (shared/mag-var.js).
 * Comparing true METAR wind against magnetic runway numbers (the old approach)
 * is off by the local variation: ~8 deg in the Carolinas, ~15 deg in Maine.
 */
class WindCompass {
    constructor() {
        this._container = null;
        this._runways = null;
        this._wx = null;
        this._decl = null;              // magnetic declination at the airport, deg, east positive
        this._manualMode = false;
        this._manualDir = null;         // MAGNETIC, as typed
        this._manualSpeed = null;
        this._activeNumpad = null;
        this._activeNumpadField = null; // 'dir' | 'speed' | null
    }

    /**
     * Entry point: render into `container`, given NASR runway records, the
     * airport's wx object, and the airport's position ({lat, lon}) for the
     * magnetic variation.
     */
    render(container, runways, wx, site) {
        this._container = container;
        this._runways = runways;
        this._wx = wx;
        this._decl = WindCompass.declinationAt(site);
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

    /** Magnetic declination (deg, east positive) at {lat, lon}, or null if unknown. */
    static declinationAt(site) {
        if (!site || !Number.isFinite(site.lat) || !Number.isFinite(site.lon)) return null;
        if (typeof MagVar === 'undefined') return null;
        try {
            const d = MagVar.declination(site.lat, site.lon);
            return Number.isFinite(d) ? d : null;
        } catch (_) {
            return null;
        }
    }

    /** METAR wind only (TRUE), independent of manual mode. */
    static _metarWind(wx) {
        const d = wx?.metar?.decoded;
        if (!d || d.wind_variable || d.wind_dir == null || !d.wind_speed) return null;
        return { dir: d.wind_dir, speed: d.wind_speed, gust: d.wind_gust || null };
    }

    /**
     * The wind driving the display, direction in TRUE degrees: the manual
     * (magnetic) entry converted to true in Manual mode, else the METAR.
     */
    _activeWind() {
        if (this._manualMode) {
            if (this._manualDir == null || !this._manualSpeed) return null;
            const dir = this._decl != null ? WindCompass.norm360(this._manualDir + this._decl) : this._manualDir;
            return { dir, speed: this._manualSpeed, gust: null };
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
            return `VRB ${d.wind_speed}${gust} kt — crosswind up to ${d.wind_gust || d.wind_speed} kt on any runway`;
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
        return `<div class="wc-metar-age${stale ? ' wc-metar-stale' : ''}">${src}METAR ${hh}${mm}Z (${age})${stale ? ' ⚠ STALE' : ''}</div>`;
    }

    static _fmtHeading(h) {
        if (h == null) return '—';
        const r = Math.round(h);
        return String(r === 0 ? 360 : r).padStart(3, '0');
    }

    static norm360(h) {
        return ((h % 360) + 360) % 360;
    }

    /** "8.0°W" / "15.1°E" for a declination (east positive). */
    static _fmtVariation(decl) {
        return `${Math.abs(decl).toFixed(1)}°${decl < 0 ? 'W' : 'E'}`;
    }

    /** The line naming the wind being drawn, in true and (when known) magnetic. */
    _windLineHtml(wind) {
        if (!wind) return '';
        const spd = `${wind.speed}${wind.gust ? `G${wind.gust}` : ''} KT`;
        const t = `${WindCompass._fmtHeading(wind.dir)}°T`;
        const src = this._manualMode ? 'MANUAL' : 'METAR';
        // Magnetic first, like the runway numbers and ATIS; true in brackets.
        const dir = this._decl != null
            ? `${WindCompass._fmtHeading(this._toDisplay(wind.dir))}°M (${t})`
            : t;
        // Two unbreakable halves, so a narrow pane wraps between direction and speed.
        return `<div class="wc-wind-line"><span class="wc-nowrap">${src} ${dir}</span> <span class="wc-nowrap">· ${spd}</span></div>`;
    }

    _sourceNoteHtml(ends) {
        const notes = [];
        if (this._decl != null) notes.push(`VAR ${WindCompass._fmtVariation(this._decl)}`);
        if (ends.some(e => e.approx)) {
            notes.push('Some runway headings estimated from runway numbers');
        } else if (this._decl == null && ends.some(e => e.fromNumber)) {
            notes.push('Runway headings from runway numbers — variation unknown');
        }
        return notes.length ? `<div class="wc-source-note">${notes.join(' · ')}</div>` : '';
    }

    _draw() {
        const container = this._container;
        const runways = this._runways || [];

        if (!runways.length) {
            container.innerHTML = '<div class="wc-no-runways">No runway data</div>';
            return;
        }

        const ends = WindCompass.parseRunwayEnds(runways, this._decl);
        if (!ends.length) {
            container.innerHTML = '<div class="wc-no-runways">Runway headings not available for this airport</div>';
            return;
        }
        const wind = this._activeWind();
        const enrichedEnds = wind
            ? WindCompass.computeWindComponents(ends, wind.dir, wind.speed, wind.gust)
            : ends.map(e => ({ ...e, headwind: null, crosswind: null, gustXwind: null, xwSide: '', isBest: false }));

        container.innerHTML = `
            <div class="wc-mode-toggle">
                <button class="wc-mode-metar ${!this._manualMode ? 'active' : ''}">METAR</button>
                <button class="wc-mode-manual ${this._manualMode ? 'active' : ''}">MANUAL</button>
            </div>
            ${!this._manualMode ? WindCompass._metarAgeHtml(this._wx) : ''}
            ${wind
                ? this._windLineHtml(wind)
                : `<div class="wc-no-wind">${WindCompass._noWindText(this._wx, this._manualMode, this._manualSpeed)}</div>`}
            ${this._buildSvgMarkup(runways, enrichedEnds, wind)}
            ${wind ? WindCompass._componentsTableHtml(enrichedEnds) : ''}
            ${this._sourceNoteHtml(ends)}
            ${this._buildControlsMarkup()}
        `;
        this._wireControls();
    }

    /**
     * Rose geometry (SVG user units; viewBox 0 0 300 300). Runway lines stop
     * at RWY_R, runway-end ids sit just outside them at LABEL_R, and the wind
     * arrow's tail starts at ARROW_TAIL_R -- inside the labels, so an arrow
     * blowing straight down a runway never covers that runway's number.
     */
    static get GEOM() {
        const r = 118;
        return { cx: 150, cy: 150, r, RWY_R: r - 36, LABEL_R: r - 18, ARROW_TAIL_R: r * 0.62, ARROW_TIP_R: r * 0.14 };
    }

    /**
     * The rose is drawn in MAGNETIC degrees -- runway numbers are magnetic, so
     * runway 06 sits near 060 and an ATIS wind points where it says. The
     * components are computed in true (both wind and runways), which gives the
     * same numbers; only the drawing is rotated by the variation.
     */
    _toDisplay(trueHdg) {
        return this._decl != null ? WindCompass.norm360(trueHdg - this._decl) : trueHdg;
    }

    _buildSvgMarkup(runways, enrichedEnds, wind) {
        const { cx, cy, r, RWY_R, ARROW_TAIL_R, ARROW_TIP_R } = WindCompass.GEOM;
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

        // One line per runway, between its two ends' headings (through the centre).
        const runwayLines = runways.map(rwy => {
            const rwyEnds = WindCompass.parseRunwayEnds([rwy], this._decl);
            if (rwyEnds.length === 0) return '';
            const p1 = WindCompass.headingToXY(this._toDisplay(rwyEnds[0].hdg), RWY_R, cx, cy);
            const p2 = rwyEnds.length > 1
                ? WindCompass.headingToXY(this._toDisplay(rwyEnds[1].hdg), RWY_R, cx, cy)
                : { x: cx, y: cy };
            return `<line class="wc-runway-line" x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"/>`;
        }).join('');

        const endLabels = WindCompass.layoutEndLabels(
            enrichedEnds.map(e => ({ ...e, hdg: this._toDisplay(e.hdg) }))).map(l => `
            <g class="wc-end-label ${l.isBest ? 'wc-best' : ''}">
                ${l.isBest ? (() => {
                    const w = 13 * l.text.length + 14, h = 28;
                    return `<rect class="wc-best-dot" x="${l.x - w / 2}" y="${l.y - h / 2}" width="${w}" height="${h}" rx="6"/>`;
                })() : ''}
                <text class="wc-end-id" x="${l.x}" y="${l.y}" text-anchor="middle" dominant-baseline="central">${l.text}</text>
            </g>`).join('');

        // Arrow points FROM the wind direction (tail) IN toward the centre (head).
        const windArrow = wind ? (() => {
            const tail = WindCompass.headingToXY(this._toDisplay(wind.dir), ARROW_TAIL_R, cx, cy);
            const tip = WindCompass.headingToXY(this._toDisplay(wind.dir), ARROW_TIP_R, cx, cy);
            return `<g class="wc-wind-arrow">
                <line x1="${tail.x}" y1="${tail.y}" x2="${tip.x}" y2="${tip.y}" marker-end="url(#wc-arrowhead)"/>
            </g>`;
        })() : '';

        return `<svg class="wc-rose" viewBox="0 0 300 300">
            <defs>
                <!-- userSpaceOnUse, not the SVG default markerUnits="strokeWidth" --
                     the default multiplies markerWidth/Height by stroke-width, so the
                     arrowhead would scale with the line. -->
                <marker id="wc-arrowhead" markerUnits="userSpaceOnUse" markerWidth="16" markerHeight="16" refX="8" refY="8" orient="auto">
                    <path class="wc-arrowhead-path" d="M0,0 L16,8 L0,16 z"/>
                </marker>
            </defs>
            <circle class="wc-rose-circle" cx="${cx}" cy="${cy}" r="${r}"/>
            <text class="wc-frame-label" x="8" y="16">${this._decl != null ? 'MAG' : 'TRUE'}</text>
            ${ticks.join('')}
            ${runwayLines}
            ${windArrow}
            ${endLabels}
        </svg>`;
    }

    /**
     * Place runway-end ids around the rose without overlap.
     *  - Parallel ends (headings within 4 deg) share one label: 26L + 26R -> "26L/R".
     *  - A label that would still sit closer than MIN_GAP units to one already
     *    placed is pulled inward a step (twice at most) so near-parallels like
     *    13/14 stay readable.
     * Returns [{ text, x, y, isBest }].
     */
    static layoutEndLabels(ends) {
        const { cx, cy, LABEL_R } = WindCompass.GEOM;
        const MIN_GAP = 34, STEP = 30;
        const groups = [];
        for (const e of ends) {
            const g = groups.find(gr => Math.abs(((e.hdg - gr.hdg + 540) % 360) - 180) < 4);
            if (g) g.ends.push(e); else groups.push({ hdg: e.hdg, ends: [e] });
        }
        const placed = [];
        for (const g of groups) {
            const text = WindCompass._mergeLabels(g.ends.map(e => e.label));
            let pos = null;
            for (let k = 0; k < 3; k++) {
                pos = WindCompass.headingToXY(g.hdg, LABEL_R - k * STEP, cx, cy);
                if (!placed.some(p => Math.hypot(p.x - pos.x, p.y - pos.y) < MIN_GAP)) break;
            }
            placed.push({ text, x: pos.x, y: pos.y, isBest: g.ends.some(e => e.isBest) });
        }
        return placed;
    }

    /** ["26L","26R"] -> "26L/R"; ["26L","26C","26R"] -> "26L/C/R"; unrelated ids joined by a space. */
    static _mergeLabels(labels) {
        if (labels.length === 1) return labels[0];
        const parts = labels.map(l => l.match(/^(\d+)([A-Z]*)$/));
        if (parts.every(p => p && p[1] === parts[0][1])) {
            return parts[0][1] + parts.map(p => p[2]).join('/');
        }
        return labels.join(' ');
    }

    /** Head/tail and crosswind per runway end, best first, at a readable size. */
    static _componentsTableHtml(ends) {
        const rows = ends.map(e => {
            const head = e.headwind >= 0
                ? `<span class="wc-hw">${e.headwind} HW</span>`
                : `<span class="wc-tw">${Math.abs(e.headwind)} TW</span>`;
            const xw = e.gustXwind > e.crosswind ? `${e.crosswind}G${e.gustXwind}` : `${e.crosswind}`;
            const side = e.xwSide ? ` ${e.xwSide}` : '';
            return `<tr class="${e.isBest ? 'wc-best-row' : ''}">
                <td class="wc-col-rwy">${e.isBest ? '▶ ' : ''}${e.label}</td>
                <td class="wc-col-head">${head}</td>
                <td class="wc-col-xw">${xw}${side}</td>
            </tr>`;
        }).join('');
        return `<table class="wc-table">
            <thead><tr><th>RWY</th><th>HEAD</th><th>CROSS</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    }

    _buildControlsMarkup() {
        // Only rendered in Manual mode: the fields are inert in METAR mode, and a
        // `hidden` attribute alone loses to .wc-manual-controls { display:flex }.
        if (!this._manualMode) return '';
        const dirDisplay = WindCompass._fmtHeading(this._manualDir);
        const spdDisplay = this._manualSpeed ?? '—';
        const dirLabel = this._decl != null ? 'DIR °M' : 'DIR';

        return `
            <div class="wc-manual-controls">
                <div class="wc-field">
                    <span class="wc-field-label">${dirLabel}</span>
                    <button class="wc-dir-value" data-field="dir">${dirDisplay}</button>
                </div>
                <div class="wc-field">
                    <span class="wc-field-label">SPD KT</span>
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
    // not a plain click listener: _draw() rebuilds the DOM on every mode
    // toggle and DONE tap, and the synthetic click after a touchend on a
    // replaced element is exactly what CLAUDE.md's wireTap note is about.
    _wireControls() {
        const container = this._container;

        wireTap(container.querySelector('.wc-mode-metar'), () => {
            this._manualMode = false;
            this._draw();
        });

        wireTap(container.querySelector('.wc-mode-manual'), () => {
            if (!this._manualMode) {
                // Seed from the METAR, converted to magnetic to match what's typed.
                const metarWind = WindCompass._metarWind(this._wx);
                if (this._manualDir == null && metarWind) {
                    const mag = this._decl != null ? WindCompass.norm360(metarWind.dir - this._decl) : metarWind.dir;
                    this._manualDir = WindCompass.validHeading(Math.round(mag));
                }
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
                    if (valueEl) valueEl.textContent = isDir ? '001–360' : '0–150 kt';
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

    /** Initial great-circle bearing (deg true, 0-360) from point 1 to point 2. */
    static bearingDeg(lat1, lon1, lat2, lon2) {
        const toRad = Math.PI / 180;
        const p1 = lat1 * toRad, p2 = lat2 * toRad, dl = (lon2 - lon1) * toRad;
        const y = Math.sin(dl) * Math.cos(p2);
        const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
        return WindCompass.norm360(Math.atan2(y, x) / toRad);
    }

    /** "6" -> "06", "26L" -> "26L", "N" -> "N". */
    static _endLabel(id) {
        const s = String(id || '').trim().toUpperCase();
        const m = s.match(/^(\d{1,2})([A-Z]*)$/);
        return m ? m[1].padStart(2, '0') + m[2] : s;
    }

    /**
     * Parse NASR runway records into individual ends with TRUE headings.
     *  - With both threshold coordinates (NASR bundle v2+): heading = bearing
     *    base -> reciprocal threshold, labels from base_id/recip_id. This also
     *    covers ids with no number (N/S, NE/SW).
     *  - Otherwise from the id: "08L/26R" is two ends, "18" one; heading =
     *    number x 10 (magnetic), plus the declination when known (approx: true).
     *    Without a declination the end is fromNumber: true and the heading is
     *    the bare number x 10.
     * @param {object[]} runways
     * @param {number|null} [declination] deg, east positive
     * @returns {{label:string, hdg:number, length_ft:number, approx?:boolean, fromNumber?:boolean}[]}
     */
    static parseRunwayEnds(runways, declination = null) {
        const ends = [];
        for (const rwy of runways || []) {
            if (!rwy) continue;
            const hasCoords = [rwy.base_lat, rwy.base_lon, rwy.recip_lat, rwy.recip_lon].every(Number.isFinite)
                && (rwy.base_lat !== rwy.recip_lat || rwy.base_lon !== rwy.recip_lon);
            if (hasCoords && rwy.base_id && rwy.recip_id) {
                const h = WindCompass.bearingDeg(rwy.base_lat, rwy.base_lon, rwy.recip_lat, rwy.recip_lon);
                ends.push({ label: WindCompass._endLabel(rwy.base_id), hdg: Math.round(h * 10) / 10, length_ft: rwy.length_ft });
                ends.push({ label: WindCompass._endLabel(rwy.recip_id), hdg: Math.round(WindCompass.norm360(h + 180) * 10) / 10, length_ft: rwy.length_ft });
                continue;
            }
            for (const part of (rwy.id || '').split('/')) {
                const match = part.trim().match(/^(\d{1,2})(L|R|C|W)?$/i);
                if (!match) continue;
                const mag = parseInt(match[1], 10) * 10;
                const label = match[1].padStart(2, '0') + (match[2] || '').toUpperCase();
                if (declination != null) {
                    ends.push({ label, hdg: Math.round(WindCompass.norm360(mag + declination) * 10) / 10, length_ft: rwy.length_ft, approx: true });
                } else {
                    ends.push({ label, hdg: mag, length_ft: rwy.length_ft, fromNumber: true });
                }
            }
        }
        return ends;
    }

    /**
     * Enrich runway ends with headwind/crosswind/gust-crosswind for a wind
     * (direction and runway headings both TRUE), sorted best first.
     * headwind = speed*cos(diff), crosswind = |speed*sin(diff)|, diff = windDir
     * - runwayHdg; xwSide 'R' when the wind comes from the right of the runway
     * heading, 'L' from the left. A negative headwind is a tailwind.
     */
    static computeWindComponents(ends, windDir, windSpd, gustSpd) {
        const gust = gustSpd || windSpd;
        const raw = (e) => {
            const diff = (windDir - e.hdg) * Math.PI / 180;
            return { hw: windSpd * Math.cos(diff), xw: windSpd * Math.sin(diff), gx: gust * Math.sin(diff) };
        };
        const enriched = ends.map(end => {
            const c = raw(end);
            const crosswind = Math.abs(Math.round(c.xw));
            return {
                ...end,
                headwind: Math.round(c.hw),
                crosswind,
                gustXwind: Math.abs(Math.round(c.gx)),
                xwSide: Math.max(crosswind, Math.abs(Math.round(c.gx))) === 0 ? '' : (c.xw > 0 ? 'R' : 'L'),
            };
        });
        // Sort on the unrounded components: rounding made 13 (15HW 3XW) tie
        // 14 (15HW 0XW) for a 140 wind and the list order picked 13. Ties then
        // go to the smaller crosswind.
        enriched.sort((a, b) => {
            const ra = raw(a), rb = raw(b);
            return (rb.hw - ra.hw) || (Math.abs(ra.xw) - Math.abs(rb.xw));
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
