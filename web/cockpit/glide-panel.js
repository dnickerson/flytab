/**
 * FlyTab - live engine-out glide block in the airport panel (web/cockpit/glide-panel.js).
 *
 * Mounted by AirportPopup._showPanel near the top of the panel, stopped by close().
 * Every GlidePanel.UPDATE_MS it runs GlideModel.plan() (web/shared/glide-model.js) on the inputs from
 * GlideInputs (web/cockpit/glide-inputs.js) and shows:
 *   the verdict (GLIDE OK / FINAL POINT OUT OF REACH / CANNOT REACH / RUNWAY POSITION NOT KNOWN /
 *   NO SUITABLE RUNWAY), the magnetic heading to steer with a turn cue, where to fly and how high to be
 *   there, TARGET / PROJECTED / MEASURED descent rates, and the wind line;
 * and on the map a line aircraft -> final point, a ring at the point and a dashed final to the threshold.
 *
 * No block (and no line) on the ground, without a 3D GPS fix, with a situation older than 5 s, for a
 * heliport / seaplane base, or when the airport has no elevation or position: GlideInputs decides.
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
    }

    start() {
        this.stop();
        const gen = ++this._gen;
        this._S = GlideInputs.settings();
        this._apt = GlideInputs.airport(this._rec, this._S);   // geometry once per start
        this._preferDirect = false;
        this._rwy = { wind: { kind: 'none' }, label: '' };
        this.render(Date.now());
        this._timer = setInterval(() => this._tick(), GlidePanel.UPDATE_MS);
        if (this._usable()) {
            this._refreshWind(gen);
            this._windTimer = setInterval(() => this._refreshWind(gen), GlidePanel.WIND_REFRESH_MS);
        }
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
            this._hide();
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
            if (gen === this._gen) this._rwy = { wind: { kind: 'none' }, label: '' };
        } finally {
            if (gen === this._gen) this._windBusy = false;
        }
    }

    /** One update: compute the plan for `now` and draw the block and the map line, or hide both. */
    render(now = Date.now()) {
        if (!this._apt) { this._S = GlideInputs.settings(); this._apt = GlideInputs.airport(this._rec, this._S); }
        if (!this._usable()) return this._hide();
        const S = this._S, apt = this._apt, ref = apt.refLatLon;
        const sit = (typeof window !== 'undefined' && window.app && window.app.stratuxClient)
            ? window.app.stratuxClient.situation : null;
        const ac = GlideInputs.aircraft(sit, S, ref, now);
        if (!ac) return this._hide();

        const gw = GlideInputs.glideWind(sit.lat, sit.lon, ac.altMsl, S, now);
        const plan = GlideModel.plan({
            airport: apt, ac, glideWind: gw.wind, runwayWind: this._rwy.wind, preferDirect: this._preferDirect,
        }, S);
        const nums = [plan.spare, plan.needMsl, plan.hdgTrue, plan.legNm, plan.target, plan.projected,
            plan.targetNow, plan.turnNow];
        if (!nums.every(Number.isFinite) || !plan.pt || !Number.isFinite(plan.pt.x) || !Number.isFinite(plan.pt.y)) {
            return this._hide();
        }
        this._preferDirect = plan.kind !== 'final';

        const view = this._view(plan, sit, gw);
        this._el.innerHTML = view.html;
        this._el.hidden = false;
        this._drawMap(plan, sit, view.tone);
        return plan;
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
        else if (plan.kind === 'direct') dest = `RWY ${GlidePanel._esc(this._runwayAt(plan.pt))} (nearest part)`;
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

    /** The runway (id "06/24") whose centreline segment is nearest to a local point (plan B's target). */
    _runwayAt(pt) {
        let best = null, bestD = Infinity;
        for (const e of this._apt.ends) {
            if (!e.rwy || !e.rwy.a || !e.rwy.b) continue;
            const a = e.rwy.a, b = e.rwy.b, ux = b.x - a.x, uy = b.y - a.y, len2 = ux * ux + uy * uy;
            const k = len2 > 0 ? Math.max(0, Math.min(1, ((pt.x - a.x) * ux + (pt.y - a.y) * uy) / len2)) : 0;
            const d = Math.hypot(pt.x - (a.x + k * ux), pt.y - (a.y + k * uy));
            if (d < bestD) { bestD = d; best = e; }
        }
        return best ? (best.runwayId || best.id) : '';
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

    _hide() {
        if (this._el) { this._el.innerHTML = ''; this._el.hidden = true; }
        if (this._layer) {
            try { this._layer.remove(); } catch (_) { /* map gone */ }
            this._layer = null;
            this._lines = null;
        }
        return null;
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

/** Model update period while the panel is open (ms). */
GlidePanel.UPDATE_MS = 1000;
/** Runway (METAR) wind re-read period (ms); the reads never overlap. */
GlidePanel.WIND_REFRESH_MS = 60000;

if (typeof window !== 'undefined') window.GlidePanel = GlidePanel;
