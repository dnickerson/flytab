/**
 * FlyTab - live engine-out glide block in the airport panel (web/cockpit/glide-panel.js).
 *
 * Mounted by AirportPopup._startGlide right under the panel header while the ENGINE OUT button is on,
 * stopped by close() and by turning ENGINE OUT off.
 * Every GlidePanel.UPDATE_MS it runs GlideModel.plan() (web/shared/glide-model.js) on the inputs from
 * GlideInputs (web/cockpit/glide-inputs.js) and shows:
 *   the verdict (GLIDE OK / FINAL POINT OUT OF REACH / CANNOT REACH / RUNWAY POSITION NOT KNOWN /
 *   NO SUITABLE RUNWAY), the magnetic heading to steer with a turn cue, where to fly and how high to be
 *   there, TARGET / PROJECTED / MEASURED descent rates, and the wind line;
 * and on the map a line aircraft -> final point, a ring at the point and a dashed final to the threshold.
 *
 * Position and altitude come from StratuxClient.wsSituation (the Stratux WebSocket: true GPS MSL).
 * No block (and no line) without a 3D GPS fix, with a situation older than 5 s, for a heliport /
 * seaplane base, or when the airport has no elevation or position: GlideInputs decides. Instead of
 * the block, while started, one status line says why (GlidePanel.STATUS, never a number, never a
 * verdict colour): no GPS / waiting for a 3D GPS fix / not available for this airport / glide check
 * unavailable. Only stop() (ENGINE OUT off, panel closed) empties the host. There is no
 * ground-speed gate here (the pilot turns the block on / off with ENGINE OUT), so it shows on the
 * ground too: aircraft() gets the settings with showAboveGsKt 0 (GlidePanel.noGsGate). EmergencyGlide
 * still passes the configured showAboveGsKt.
 * Nothing here touches the network; the runway (METAR) wind is re-read from on-tablet data every
 * GlidePanel.WIND_REFRESH_MS. Every model number comes from GlideInputs.settings().
 *
 * Spec: docs/superpowers/specs/2026-10-31-engine-out-glide-panel-design.md ("The panel", "Rates").
 * Exposes the global GlidePanel.
 */
class GlidePanel {
    /**
     * @param {HTMLElement} containerEl  the element the block renders into (emptied while hidden)
     * @param {Object} airportRec        NASR airport record (icao, lat, lon, elev_ft, fac_type, runways)
     */
    constructor(containerEl, airportRec) {
        this._el = containerEl;
        this._statusKey = null;        // the status line on screen (GlidePanel.STATUS key), null when none
        this._rec = airportRec || null;
        this._timer = null;
        this._windTimer = null;
        this._gen = 0;                 // bumped by start()/stop(): a late runway-wind result for an old run is dropped
        this._windBusy = false;
        this._preferDirect = false;    // plan-B hysteresis, kept between updates
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
        this._preferDirect = false;
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
        const sit = (typeof window !== 'undefined' && window.app && window.app.stratuxClient)
            ? window.app.stratuxClient.wsSituation : null;
        const gated = GlidePanel.noGsGate(S);
        const ac = GlideInputs.aircraft(sit, gated, ref, now);
        if (!ac) {
            this._vsSamples = [];
            return this._status(GlidePanel._statusFor(GlideInputs.aircraftStatus(sit, gated, now)));
        }
        // MEASURED: the descent rate from GPS altitude. situation.vertical_speed is not used: Stratux never
        // fills GPSVerticalSpeed (WebSocket 0), GDL 90 sends none, the engine-GPS bridge sends 0.
        ac.vs = this._measuredVs(sit.timestamp, ac.altMsl);

        const gw = GlideInputs.glideWind(sit.lat, sit.lon, ac.altMsl, S, now);
        const plan = GlideModel.plan({
            airport: apt, ac, glideWind: gw.wind, runwayWind: this._rwy.wind, preferDirect: this._preferDirect,
        }, S);
        const nums = [plan.spare, plan.needMsl, plan.hdgTrue, plan.legNm, plan.target, plan.projected,
            plan.targetNow, plan.turnNow];
        if (!nums.every(Number.isFinite) || !plan.pt || !Number.isFinite(plan.pt.x) || !Number.isFinite(plan.pt.y)) {
            return this._status('unavailable');
        }
        this._preferDirect = plan.kind !== 'final';

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

    _view(plan, sit, gw) {
        const S = this._S, apt = this._apt;
        const icao = GlidePanel._esc((this._rec && (this._rec.icao || this._rec.id)) || '');
        const fmt = GlidePanel._fmtFt;
        const spareTxt = (s) => `${fmt(Math.floor(s))} ft to spare`;       // never round the spare up
        const shortTxt = (s) => `${fmt(Math.ceil(-s))} ft short`;           // never round the shortfall down

        let tone, verdict, sub = '', unknown = false;
        if (plan.kind === 'final') {
            tone = 'ok';
            verdict = `✓ GLIDE OK · ${spareTxt(plan.spare)}`;
        } else if (plan.kind === 'direct') {
            if (plan.spare >= 0) {
                tone = 'caution';
                verdict = '⚠ FINAL POINT OUT OF REACH · TURN TO THE AIRPORT';
                sub = `${spareTxt(plan.spare)} over the runway`;
            } else {
                tone = 'danger';
                verdict = `✗ CANNOT REACH ${icao} · ${shortTxt(plan.spare)}`;
            }
        } else {
            unknown = true;
            const state = apt.noSuitable ? 'NO SUITABLE RUNWAY · steer to the airport'
                : 'RUNWAY POSITION NOT KNOWN · steer to the airport';
            if (plan.spare >= 0) {
                tone = 'caution';
                verdict = state;
                sub = `${spareTxt(plan.spare)} over the airport`;
            } else {
                tone = 'danger';
                verdict = `✗ CANNOT REACH ${icao} · ${shortTxt(plan.spare)}`;
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
            : (t > 0 ? `↱ right ${Math.round(t)}°` : `↰ left ${Math.round(-t)}°`);

        let dest;
        if (plan.kind === 'final') dest = `RWY ${GlidePanel._esc(plan.endId)} final point`;
        else if (plan.kind === 'direct') {
            dest = plan.runwayId ? `RWY ${GlidePanel._esc(plan.runwayId)} (nearest part)` : 'the runway (nearest part)';
        }
        else dest = icao;
        const flyTxt = `Fly ${hdgTxt} · ${plan.legNm.toFixed(1)} nm to ${dest}`;
        const beAtTxt = `Be at ${fmt(Math.ceil(plan.needMsl))} ft or higher there`;

        const cell = (label, val, target) => {
            if (!Number.isFinite(val)) {
                return `<div class="glide-rate"><span class="glide-rate-label">${label}</span>`
                    + '<span class="glide-rate-val">—</span></div>';
            }
            const over = Number.isFinite(target) ? val - target : 0;
            const steep = over > 0 ? `<span class="glide-steep">+${fmt(Math.ceil(over))} too steep</span>` : '';
            return `<div class="glide-rate${over > 0 ? ' glide-rate-steep' : ''}">`
                + `<span class="glide-rate-label">${label}</span>`
                + `<span class="glide-rate-val">${fmt(val)}<span class="glide-rate-unit"> fpm</span></span>${steep}</div>`;
        };
        const rates = cell('TARGET', plan.target, null)
            + cell('PROJECTED', plan.projected, plan.target)
            + cell('MEASURED', plan.measured, plan.targetNow);

        const rwyLabel = this._rwy && this._rwy.label ? GlidePanel._esc(this._rwy.label) : '';
        const glideLabel = `<span class="${gw.wind ? '' : 'glide-amber'}">Glide: ${GlidePanel._esc(gw.label)}</span>`;
        let wind = (rwyLabel ? `<span>Runway: ${rwyLabel}</span> · ` : '') + glideLabel;
        if (plan.kind === 'final' && plan.tailwindKt > 0) {
            wind += `<div class="glide-amber">RWY ${GlidePanel._esc(plan.endId)}: ${Math.ceil(plan.tailwindKt)} kt TAILWIND</div>`;
        }

        const html = `<div class="glide-block glide-${tone}${unknown ? ' glide-unknown' : ''}">`
            + `<div class="glide-verdict">${verdict}</div>`
            + (sub ? `<div class="glide-sub">${sub}</div>` : '')
            + `<div class="glide-steer"><span class="glide-hdg">${hdgTxt}</span><span class="glide-turn">${turnTxt}</span></div>`
            + `<div class="glide-line">${flyTxt}</div>`
            + `<div class="glide-line">${beAtTxt}</div>`
            + `<div class="glide-rates">${rates}</div>`
            + `<div class="glide-wind">${wind}</div>`
            + '</div>';
        return { html, tone };
    }

    // ---- Map --------------------------------------------------------------

    _drawMap(plan, sit, tone) {
        const map = typeof window !== 'undefined' && window.app && window.app.cockpitMap
            ? window.app.cockpitMap.map : null;
        if (!map || typeof L === 'undefined') return;
        const ref = this._apt.refLatLon;
        const p = GlideModel.fromLocal(ref.lat, ref.lon, plan.pt);
        const ptLL = [p.lat, p.lon], acLL = [sit.lat, sit.lon];
        let thrLL = null;
        if (plan.kind === 'final') {
            const end = this._apt.ends.find((e) => e.id === plan.endId);
            if (end && end.thr) { const t = GlideModel.fromLocal(ref.lat, ref.lon, end.thr); thrLL = [t.lat, t.lon]; }
        }
        const color = GlidePanel._token(tone === 'ok' ? '--color-success'
            : tone === 'caution' ? '--color-caution' : '--color-danger');

        if (!this._layer) {
            this._layer = L.layerGroup().addTo(map);
            const base = { color, weight: 4, opacity: 1, interactive: false };
            this._lines = {
                leg: L.polyline([acLL, ptLL], base),
                ring: L.circleMarker(ptLL, { ...base, radius: 10, fill: false }),
                final: L.polyline(thrLL ? [ptLL, thrLL] : [], { ...base, dashArray: '8 8' }),
            };
            this._layer.addLayer(this._lines.leg);
            this._layer.addLayer(this._lines.ring);
            this._layer.addLayer(this._lines.final);
            return;
        }
        this._lines.leg.setLatLngs([acLL, ptLL]);
        this._lines.ring.setLatLng(ptLL);
        this._lines.final.setLatLngs(thrLL ? [ptLL, thrLL] : []);
        for (const k of ['leg', 'ring', 'final']) this._lines[k].setStyle({ color });
    }

    /**
     * No glide numbers can be shown: remove the map line and show one status line instead of the block
     * (GlidePanel.STATUS[key]; neutral colours, no numbers). The DOM is only rewritten when the reason changes.
     * Returns null (no plan).
     */
    _status(key) {
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
 * The status line shown, after "ENGINE OUT · ", while started with no glide numbers to show:
 *   nogps       no Stratux WebSocket situation, or none for GlideInputs.SIT_MAX_AGE_MS
 *   nofix       situations arriving, but no 3D GPS fix
 *   airport     heliport / seaplane base, or no field elevation / reference position
 *   unavailable the model gave a non-finite plan, the update failed, or the fix lacks altitude / track / speed
 */
GlidePanel.STATUS = Object.freeze({
    nogps: 'no GPS — needs the Stratux GPS over WiFi',
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
