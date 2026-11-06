/**
 * FlyTab - live engine-out glide block in the airport panel (web/cockpit/glide-panel.js).
 *
 * Mounted by AirportPopup._startGlide right under the panel's nav row while the ENGINE OUT button is on,
 * stopped by close() and by turning ENGINE OUT off.
 * Every GlidePanel.UPDATE_MS it runs GlideModel.plan() (web/shared/glide-model.js) on the inputs from
 * GlideInputs (web/cockpit/glide-inputs.js) and shows:
 *   the verdict with the height high / low (GLIDE OK / CANNOT REACH / RUNWAY POSITION NOT KNOWN /
 *   NO SUITABLE RUNWAY), then TO / HEADING (magnetic, with a turn cue) / DISTANCE / AIRSPEED /
 *   DESCENT (target, and the measured rate against it) / GLIDE PATH (signed spare) rows (_view),
 *   and the wind line; low over the runway just "OVER RWY xx" (no rows);
 * and on the map a line aircraft -> the planned point with a ring at it (none over the runway).
 *
 * Position and altitude come from StratuxClient.wsSituation (the Stratux WebSocket: true GPS MSL).
 * No block (and no line) without a 3D GPS fix, with a situation older than 5 s, for a heliport /
 * seaplane base, or when the airport has no elevation or position: GlideInputs decides. Then, with
 * opts.showStatus (ENGINE OUT turned on by a tap in this panel), one status line says why instead of
 * the block (GlidePanel.STATUS, never a number, never a verdict colour): no GPS / no GPS altitude from
 * the Stratux / waiting for a 3D GPS fix / not available for this airport / glide check unavailable.
 * Without it (the panel opened with ENGINE OUT already on) the host is just hidden until there are
 * numbers to show. stop() (ENGINE OUT off, panel closed) empties the host either way. There is no
 * ground-speed gate here (the pilot turns the block on / off with ENGINE OUT), so it shows on the
 * ground too: aircraft() gets the settings with showAboveGsKt 0 (GlidePanel.noGsGate). EmergencyGlide
 * still passes the configured showAboveGsKt.
 * Nothing here touches the network; the runway (METAR) wind is re-read from on-tablet data every
 * GlidePanel.WIND_REFRESH_MS. The glide legs use winds aloft, else that runway (surface) wind, else the
 * assumed headwind (GlideInputs.glideWindFor). Every model number comes from GlideInputs.settings().
 *
 * Spec: docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md ("The panel", "Rates"), amended by
 * docs/superpowers/specs/2026-11-06-engine-out-glide-runway-target.md (target choice, glide wind, verdicts).
 * Exposes the global GlidePanel.
 */
class GlidePanel {
    /**
     * @param {HTMLElement} containerEl  the element the block renders into (emptied while hidden)
     * @param {Object} airportRec        NASR airport record (icao, lat, lon, elev_ft, fac_type, runways)
     * @param {Object} [opts]
     * @param {boolean} [opts.showStatus=false]  with no numbers to show, show the status line saying why
     *        (true only when the pilot just tapped ENGINE OUT on); false: hide the host instead
     */
    constructor(containerEl, airportRec, opts = {}) {
        this._el = containerEl;
        this._showStatus = !!(opts && opts.showStatus);
        this._statusKey = null;        // the status line on screen (GlidePanel.STATUS key), null when none
        this._rec = airportRec || null;
        this._timer = null;
        this._windTimer = null;
        this._gen = 0;                 // bumped by start()/stop(): a late runway-wind result for an old run is dropped
        this._windBusy = false;
        this._rwy = { wind: { kind: 'none' }, label: '' };
        this._S = null;
        this._apt = null;
        this._layer = null;
        this._lines = null;
        this._vsSamples = [];          // { t: situation.timestamp, alt: alt_msl } for the MEASURED rate
    }

    start() {
        this.stop();
        const gen = ++this._gen;
        this._S = GlideInputs.settings();
        this._apt = GlideInputs.airport(this._rec, this._S);   // geometry once per start
        this._rwy = { wind: { kind: 'none' }, label: '' };
        this._vsSamples = [];
        this.render(Date.now());
        if (this._usable()) {                                   // an airport that can never have a block does not tick
            this._timer = setInterval(() => this._tick(), GlidePanel.UPDATE_MS);
            this._refreshWind(gen);
            this._windTimer = setInterval(() => this._refreshWind(gen), GlidePanel.WIND_REFRESH_MS);
        }
    }

    /**
     * The settings with showAboveGsKt 0: GlideInputs.aircraft() then gives a state at any ground speed
     * (its other checks - 3D fix, age, altitude, track - stay). The panel's own copy; S is not changed.
     */
    static noGsGate(S) {
        return { ...S, pilot: { ...(S && S.pilot), showAboveGsKt: 0 } };
    }

    stop() {
        this._gen++;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        if (this._windTimer) { clearInterval(this._windTimer); this._windTimer = null; }
        this._windBusy = false;
        this._hide();
    }

    _tick() {
        try { this.render(Date.now()); } catch (err) {
            // never leave frozen numbers on screen
            console.warn('GlidePanel: update failed', err);
            this._status('unavailable');
        }
    }

    /** The airport can have a block at all (not excluded, elevation and position known). */
    _usable() {
        const a = this._apt;
        return !!a && !a.excluded && Number.isFinite(a.elevFt) && !!a.refLatLon;
    }

    async _refreshWind(gen) {
        if (this._windBusy || gen !== this._gen) return;     // no overlapping reads
        this._windBusy = true;
        try {
            const icao = this._rec && (this._rec.icao || this._rec.id);
            const r = await GlideInputs.runwayWind(icao, this._apt.refLatLon, this._S, Date.now());
            if (gen !== this._gen) return;
            this._rwy = r && r.wind ? r : { wind: { kind: 'none' }, label: '' };
            this.render(Date.now());
        } catch (err) {
            if (gen === this._gen) {
                console.warn('GlidePanel: runway wind update failed', err);
                this._rwy = { wind: { kind: 'none' }, label: '' };
                this._status('unavailable');                    // never leave frozen numbers on screen
            }
        } finally {
            if (gen === this._gen) this._windBusy = false;
        }
    }

    /**
     * One update: compute the plan for `now` and draw the block and the map line; when there is no plan,
     * remove the line and show the status line saying why (returns null then).
     */
    render(now = Date.now()) {
        if (!this._apt) { this._S = GlideInputs.settings(); this._apt = GlideInputs.airport(this._rec, this._S); }
        if (!this._usable()) return this._status('airport');
        const S = this._S, apt = this._apt, ref = apt.refLatLon;
        // The last WebSocket situation only: its alt_msl is true GPS MSL, from one source. A GDL 90 situation
        // carries the height above the ellipsoid as alt_msl (Stratux's Ownship Geometric Altitude), so it is
        // never used here; with no fresh WebSocket situation there is no block (err high).
        const sc = (typeof window !== 'undefined' && window.app && window.app.stratuxClient) || null;
        const sit = sc ? sc.wsSituation : null;
        const gated = GlidePanel.noGsGate(S);
        const ac = GlideInputs.aircraft(sit, gated, ref, now);
        if (!ac) {
            this._vsSamples = [];
            let key = GlidePanel._statusFor(GlideInputs.aircraftStatus(sit, gated, now));
            // No fresh WebSocket situation, but the Stratux's own latest situation (GDL 90) is a fresh 3D fix:
            // own-ship is on the map, only the WebSocket's GPS MSL altitude is missing.
            if (key === 'nogps' && GlidePanel._stratuxFixWithoutWs(sc && sc.situation, now)) key = 'noalt';
            return this._status(key);
        }
        // MEASURED: the descent rate from GPS altitude. situation.vertical_speed is not used: Stratux never
        // fills GPSVerticalSpeed (WebSocket 0), GDL 90 sends none, the engine-GPS bridge sends 0.
        ac.vs = this._measuredVs(sit.timestamp, ac.altMsl);

        // Glide wind: winds aloft, else the runway (surface) wind, else none (the assumed headwind).
        const gw = GlideInputs.glideWindFor(GlideInputs.glideWind(sit.lat, sit.lon, ac.altMsl, S, now), this._rwy, S);
        const plan = GlideModel.plan({ airport: apt, ac, glideWind: gw.wind, runwayWind: this._rwy.wind }, S);
        const nums = [plan.spare, plan.needMsl, plan.hdgTrue, plan.legNm, plan.target, plan.projected,
            plan.targetNow, plan.turnNow];
        if (!nums.every(Number.isFinite) || !plan.pt || !Number.isFinite(plan.pt.x) || !Number.isFinite(plan.pt.y)) {
            return this._status('unavailable');
        }

        const view = this._view(plan, sit, gw);
        this._el.innerHTML = view.html;
        this._el.hidden = false;
        this._statusKey = null;
        this._drawMap(plan, sit, view.tone);
        return plan;
    }

    /**
     * Adds the situation (t ms, alt ft MSL) to the samples - a timestamp already sampled is not a new one,
     * a clock going backwards starts over - keeps those within VS_WINDOW_MS of the newest, and returns the
     * least-squares slope in ft/min (negative = descending), or null with fewer than VS_MIN_SAMPLES samples
     * or less than VS_MIN_SPAN_MS between the first and the last.
     */
    _measuredVs(t, alt) {
        const s = this._vsSamples;
        if (!Number.isFinite(t) || !Number.isFinite(alt)) return null;
        if (s.length && t < s[s.length - 1].t) s.length = 0;
        if (!s.length || t !== s[s.length - 1].t) s.push({ t, alt });
        const newest = s[s.length - 1].t;
        while (newest - s[0].t > GlidePanel.VS_WINDOW_MS) s.shift();
        if (s.length < GlidePanel.VS_MIN_SAMPLES || newest - s[0].t < GlidePanel.VS_MIN_SPAN_MS) return null;
        let tm = 0, am = 0;
        for (const p of s) { tm += p.t; am += p.alt; }
        tm /= s.length; am /= s.length;
        let num = 0, den = 0;
        for (const p of s) { num += (p.t - tm) * (p.alt - am); den += (p.t - tm) * (p.t - tm); }
        return den > 0 ? (num / den) * 60000 : null;            // ft/ms -> ft/min
    }

    // ---- Text -------------------------------------------------------------

    /**
     * The block's HTML for a plan (spec 2026-11-04 "Engine-out block", verdicts per spec 2026-11-06): the verdict
     * bar - GLIDE OK (green) when 'direct' / 'final' has spare >= 0, else CANNOT REACH (red); "OVER RWY 06/24"
     * (green, no grid) for 'over'; the 'ref' states unchanged - then a grid
     *   TO          RWY 06 + "on final" (final) / RWY 06/24 + "nearest part" (direct) / the ICAO (ref)
     *   HEADING     magnetic wind-corrected heading of the straight leg, 3 digits; turn cue under it
     *   DISTANCE    plan.legNm, one decimal
     *   AIRSPEED    the validated glide_ias_kt
     *   DESCENT     plan.target; under it "now M fpm · X shallower" / "· X too steep" / "· on target"
     *               (M = measured; X = |shown M - shown target|, the two rounded numbers on screen,
     *               never targetNow), "now —" without a measured rate
     *   GLIDE PATH  the signed spare (+N / −N ft)
     * and the wind line ("Glide:" amber only when the headwind is assumed; the tailwind line only on final).
     * N in the verdict and GLIDE PATH: spare floored when >= 0, shortfall ceiled.
     * `gw`: GlideInputs.glideWindFor() result { wind, label, assumed }.
     */
    _view(plan, sit, gw) {
        const S = this._S, apt = this._apt;
        const esc = GlidePanel._esc;
        const icao = esc((this._rec && (this._rec.icao || this._rec.id)) || '');
        const fmt = GlidePanel._fmtFt;
        const high = plan.spare >= 0;
        // never round the spare up / the shortfall down; `|| 0`: no "-0" for a spare of -0
        const nFt = (high ? Math.floor(plan.spare) : Math.ceil(-plan.spare)) || 0;
        const hiLo = `${fmt(nFt)} ft ${high ? 'high' : 'low'}`;

        let tone, verdict, sub = '', unknown = false;
        if (plan.kind === 'over') {
            tone = 'ok';
            verdict = plan.runwayId ? `✓ OVER RWY ${esc(plan.runwayId)}` : '✓ OVER RUNWAY';
        } else if (plan.kind === 'final' || plan.kind === 'direct') {
            tone = high ? 'ok' : 'danger';
            verdict = high ? `✓ GLIDE OK · ${hiLo}` : `✗ CANNOT REACH ${icao} · ${hiLo}`;
        } else {
            unknown = true;
            const state = apt.noSuitable ? 'NO SUITABLE RUNWAY · steer to the airport'
                : 'RUNWAY POSITION NOT KNOWN · steer to the airport';
            if (high) {
                tone = 'caution';
                verdict = `${state} · ${hiLo}`;
            } else {
                tone = 'danger';
                verdict = `✗ CANNOT REACH ${icao} · ${hiLo}`;
                sub = state;
            }
        }

        // Heading: magnetic = true - declination (MagVar: east positive), 3 digits, 360 for north.
        let hdgTxt;
        if (typeof MagVar !== 'undefined' && MagVar && typeof MagVar.declination === 'function') {
            const decl = MagVar.declination(sit.lat, sit.lon);
            hdgTxt = Number.isFinite(decl) ? GlidePanel._hdg3(plan.hdgTrue - decl) + '°'
                : GlidePanel._hdg3(plan.hdgTrue) + '°T';
        } else {
            hdgTxt = GlidePanel._hdg3(plan.hdgTrue) + '°T';
        }
        const t = plan.turnNow;
        const turnTxt = Math.abs(t) <= S.pilot.onCourseDeg ? '↑ on course'
            : (t > 0 ? `↱ turn right ${Math.round(t)}°` : `↰ turn left ${Math.round(-t)}°`);

        let to, toNote = '';
        if (plan.kind === 'final') {
            to = `RWY ${esc(plan.endId)}`;
            toNote = 'on final';
        } else if (plan.kind === 'direct') {
            to = plan.runwayId ? `RWY ${esc(plan.runwayId)}` : 'RUNWAY';
            toNote = 'nearest part';
        } else to = icao;

        const ias = `${fmt(S.aircraft.glide_ias_kt)} KIAS`;

        let nowHtml;
        if (Number.isFinite(plan.measured)) {
            // The difference of the two numbers ON SCREEN (the rounded DESCENT target above and the
            // rounded "now M"), so it always adds up; never targetNow.
            const shownM = Math.round(plan.measured), shownT = Math.round(plan.target);
            const d = shownM - shownT;
            nowHtml = d > 0
                ? `<span class="glide-now glide-now-steep">now ${fmt(shownM)} fpm · ${fmt(d)} too steep</span>`
                : d < 0 ? `<span class="glide-now">now ${fmt(shownM)} fpm · ${fmt(-d)} shallower</span>`
                    : `<span class="glide-now">now ${fmt(shownM)} fpm · on target</span>`;
        } else {
            nowHtml = '<span class="glide-now">now —</span>';
        }
        const pathTxt = `${high ? '+' : '−'}${fmt(nFt)} ft`;

        const row = (label, valueHtml) => `<div class="glide-lbl">${label}</div><div class="glide-cell">${valueHtml}</div>`;
        const grid = row('TO', `<span class="glide-val glide-to">${to}</span>${toNote ? `<span class="glide-note">${toNote}</span>` : ''}`)
            + row('HEADING', `<span class="glide-hdg">${hdgTxt}</span><span class="glide-turn">${turnTxt}</span>`)
            + row('DISTANCE', `<span class="glide-val glide-dist">${plan.legNm.toFixed(1)} nm</span>`)
            + row('AIRSPEED', `<span class="glide-val glide-ias">${ias}</span>`)
            + row('DESCENT', `<span class="glide-val glide-target">${fmt(plan.target)} fpm</span>${nowHtml}`)
            + row('GLIDE PATH', `<span class="glide-val glide-path${high ? '' : ' glide-neg'}">${pathTxt}</span>`);

        const rwyLabel = this._rwy && this._rwy.label ? esc(this._rwy.label) : '';
        let wind;
        if (gw.source === 'surface' && rwyLabel) {
            // The airport's METAR is both the runway wind and the glide wind: name it once.
            wind = `<span>Wind: ${rwyLabel} · runway and glide</span>`;
        } else {
            const glideLabel = `<span class="${gw.assumed ? 'glide-amber' : ''}">Glide: ${esc(gw.label)}</span>`;
            wind = (rwyLabel ? `<span>Runway: ${rwyLabel}</span> · ` : '') + glideLabel;
        }
        if (plan.kind === 'final' && plan.tailwindKt > 0) {
            wind += `<div class="glide-amber">RWY ${esc(plan.endId)}: ${Math.ceil(plan.tailwindKt)} kt TAILWIND</div>`;
        }

        const html = `<div class="glide-block glide-${tone}${unknown ? ' glide-unknown' : ''}">`
            + `<div class="glide-verdict">${verdict}</div>`
            + (sub ? `<div class="glide-sub">${sub}</div>` : '')
            + (plan.kind === 'over' ? '' : `<div class="glide-grid">${grid}</div>`)
            + `<div class="glide-wind">${wind}</div>`
            + '</div>';
        return { html, tone };
    }

    // ---- Map --------------------------------------------------------------

    /** The line aircraft -> plan.pt and a ring at it; none over the runway (kind 'over'). */
    _drawMap(plan, sit, tone) {
        if (plan.kind === 'over') { this._removeMap(); return; }
        const map = typeof window !== 'undefined' && window.app && window.app.cockpitMap
            ? window.app.cockpitMap.map : null;
        if (!map || typeof L === 'undefined') return;
        const ref = this._apt.refLatLon;
        const p = GlideModel.fromLocal(ref.lat, ref.lon, plan.pt);
        const ptLL = [p.lat, p.lon], acLL = [sit.lat, sit.lon];
        const color = GlidePanel._token(tone === 'ok' ? '--color-success'
            : tone === 'caution' ? '--color-caution' : '--color-danger');

        if (!this._layer) {
            this._layer = L.layerGroup().addTo(map);
            const base = { color, weight: 4, opacity: 1, interactive: false };
            this._lines = {
                leg: L.polyline([acLL, ptLL], base),
                ring: L.circleMarker(ptLL, { ...base, radius: 10, fill: false }),
            };
            this._layer.addLayer(this._lines.leg);
            this._layer.addLayer(this._lines.ring);
            return;
        }
        this._lines.leg.setLatLngs([acLL, ptLL]);
        this._lines.ring.setLatLng(ptLL);
        for (const k of ['leg', 'ring']) this._lines[k].setStyle({ color });
    }

    /**
     * No glide numbers can be shown: remove the map line and show one status line instead of the block
     * (GlidePanel.STATUS[key]; neutral colours, no numbers). The DOM is only rewritten when the reason changes.
     * Without showStatus the host is hidden instead (no block, no message). Returns null (no plan).
     */
    _status(key) {
        if (!this._showStatus) return this._hide();
        this._removeMap();
        const msg = GlidePanel.STATUS[key] || GlidePanel.STATUS.unavailable;
        if (this._el && (this._statusKey !== key || this._el.hidden || !this._el.querySelector('.glide-status'))) {
            this._el.innerHTML = `<div class="glide-status" role="status" data-reason="${GlidePanel._esc(key)}">`
                + `ENGINE OUT · ${GlidePanel._esc(msg)}</div>`;
            this._el.hidden = false;
        }
        this._statusKey = key;
        return null;
    }

    /** Empty and hide the host and remove the map line (stop(): ENGINE OUT off / panel closed). */
    _hide() {
        if (this._el) { this._el.innerHTML = ''; this._el.hidden = true; }
        this._statusKey = null;
        this._removeMap();
        return null;
    }

    _removeMap() {
        if (this._layer) {
            try { this._layer.remove(); } catch (_) { /* map gone */ }
            this._layer = null;
            this._lines = null;
        }
    }

    /**
     * A situation from the Stratux itself (no _source: not the engine-GPS bridge or device GPS), no older
     * than GlideInputs.SIT_MAX_AGE_MS, with a 3D fix - the GDL 90-only case when the WebSocket one is missing.
     */
    static _stratuxFixWithoutWs(s, now) {
        return !!s && !s._source && Number.isFinite(s.timestamp) && now - s.timestamp <= GlideInputs.SIT_MAX_AGE_MS
            && GpsFix.has3DFix(s);
    }

    /** GlideInputs.aircraftStatus() reason -> GlidePanel.STATUS key. */
    static _statusFor(reason) {
        if (reason === 'nogps' || reason === 'stale') return 'nogps';
        if (reason === 'nofix') return 'nofix';
        return 'unavailable';                // 'nodata', 'slow' (never with noGsGate), or 'ok' with a bad reference
    }

    // ---- Helpers ----------------------------------------------------------

    /** A design token's colour for Leaflet (SVG/canvas strokes take a colour string, not var()). */
    static _token(name) {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            if (v) return v;
        } catch (_) { /* no style */ }
        return 'currentColor';
    }

    static _hdg3(d) {
        const r = Math.round(((d % 360) + 360) % 360);
        return String(r === 0 ? 360 : r).padStart(3, '0');
    }

    static _fmtFt(n) { return Math.round(n).toLocaleString('en-US'); }

    static _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g,
            (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
}

/**
 * The status line shown, after "ENGINE OUT · ", while started with showStatus and no glide numbers to show:
 *   nogps       no Stratux WebSocket situation, or none for GlideInputs.SIT_MAX_AGE_MS
 *   noalt       as nogps, but the Stratux's GDL 90 situation is a fresh 3D fix (own-ship on the map; the
 *               glide check needs the WebSocket's GPS MSL altitude, GDL 90's is height above the ellipsoid)
 *   nofix       situations arriving, but no 3D GPS fix
 *   airport     heliport / seaplane base, or no field elevation / reference position
 *   unavailable the model gave a non-finite plan, the update failed, or the fix lacks altitude / track / speed
 */
GlidePanel.STATUS = Object.freeze({
    nogps: 'no GPS — needs the Stratux GPS over WiFi',
    noalt: 'no GPS altitude from the Stratux',
    nofix: 'waiting for a 3D GPS fix',
    airport: 'not available for this airport',
    unavailable: 'glide check unavailable',
});
/** Model update period while the panel is open (ms). */
GlidePanel.UPDATE_MS = 1000;
/** Runway (METAR) wind re-read period (ms); the reads never overlap. */
GlidePanel.WIND_REFRESH_MS = 60000;
/** MEASURED descent rate: least-squares slope of GPS altitude over this window (ms) ... */
GlidePanel.VS_WINDOW_MS = 10000;
/** ... valid only with at least this many samples ... */
GlidePanel.VS_MIN_SAMPLES = 3;
/** ... spanning at least this long (ms). */
GlidePanel.VS_MIN_SPAN_MS = 5000;

if (typeof window !== 'undefined') window.GlidePanel = GlidePanel;
