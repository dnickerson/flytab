/**
 * VnePanel — the Vne / Va card that floats over the map, opened by tapping the Vne pill
 * (cockpit/vne-pill.js). Dana's design of 2026-11-13:
 * docs/superpowers/specs/2026-11-13-vne-va-map-pill-design.md.
 *
 * Vne: the RV-9A's 182 kt applies to IAS and TAS, so at altitude the true-airspeed limit comes
 * first. The pilot enters what the cockpit shows: altimeter setting (inHg), altitude (as
 * indicated), OAT (°F) and, optionally, KIAS. AirspeedLimits.evaluate() works out the pressure
 * altitude and the Vne as an indicated speed, rounding conservatively.
 *
 * Layout (Dana 2026-11-13): KIAS and altitude first (they change most), then Vne / Va and the
 * WITHIN / AT / OVER badge right under them, then altimeter and OAT, then the explanation lines.
 *
 * Va: 102 KIAS at 1,800 lb, scaled by sqrt(weight / gross) and never above 102. The weight is
 * the W&B empty weight plus the saved W&B station weights (Settings.wbStationWeights, kept
 * until changed) plus the tracked fuel. Untracked or stale fuel is LEFT OUT: a lighter weight
 * gives a lower Va, the safe direction (a stale tracked figure reads high). No pilot weight
 * saved → no Va. The card lists the weights it used so an old passenger weight is visible.
 *
 * State: this._state holds the fields AS TYPED (strings): { altimeter, alt, oatF, kias }.
 * Manual edits are saved to Settings 'vne_inputs' (flypi_vne_inputs). Values pushed through
 * setInputs() (the live-data hook) are shown with their source and NOT saved; the next manual
 * edit switches back to "Manual entry" and saves everything.
 *
 * Fires 'change' after every render (entries, W&B weights, fuel events, and every 15 s for
 * fuel burn); the pill redraws from summary().
 *
 * Live-data hook: setInputs({ pressureAltFt | altimeterInHg + indicatedAltFt, oatF | oatC, kias },
 * sourceLabel). Nothing calls it yet. A pressure altitude is entered as that altitude at
 * 29.92 (1 ft high: the conservative side). Do NOT feed it the Pi's engine_monitor `oat`: that
 * is a standard-atmosphere value, not a measured OAT.
 */
class VnePanel extends EventTarget {
    static REFRESH_MS = 15000;
    static FIELDS = ['altimeter', 'alt', 'oatF', 'kias'];

    constructor(container) {
        super();
        this._container = container;
        this._el = null;
        this._source = 'manual';
        this._state = VnePanel._loadState();
        this._last = null;
        this._buildDOM();
        this._onExternal = () => this.refresh();
        if (typeof window !== 'undefined') {
            for (const ev of ['wb:weightschanged', 'fuelstate:changed', 'fueltankstate:changed']) {
                window.addEventListener(ev, this._onExternal);
            }
        }
        this._timer = setInterval(() => this.refresh(), VnePanel.REFRESH_MS);
        this._render();
    }

    show() {
        this._el.classList.add('visible');
        this._render();   // weights, fuel or the aircraft config may have changed
    }

    hide() {
        this._el.classList.remove('visible');
    }

    toggle() {
        if (this.visible) this.hide(); else this.show();
    }

    get visible() {
        return this._el.classList.contains('visible');
    }

    /** Top of the card in px (the pill puts it just under itself). */
    setTop(px) {
        if (!Number.isFinite(px)) return;
        this._el.style.top = `${Math.round(px)}px`;
        this._el.style.maxHeight = `calc(100% - ${Math.round(px) + 8}px)`;   // scroll inside, above the map's bottom
    }

    /** What the pill shows: { ok, vneKias, vaKias, altFt, overGross }. */
    summary() {
        const r = this._last || {};
        const alt = AirspeedLimits.parseNumber(this._state.alt);
        return {
            ok: !!r.ok,
            vneKias: r.ok ? r.vneKias : null,
            vaKias: r.vaKias ?? null,
            altFt: r.ok ? alt : null,
            overGross: !!r.overGross,
        };
    }

    /** Recompute (weights / fuel may have moved) and redraw. */
    refresh() {
        this._render();
    }

    destroy() {
        clearInterval(this._timer);
        if (typeof window !== 'undefined') {
            for (const ev of ['wb:weightschanged', 'fuelstate:changed', 'fueltankstate:changed']) {
                window.removeEventListener(ev, this._onExternal);
            }
        }
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
    }

    /** Live-data hook: fill any of the inputs from a feed. Finite numbers only; others are ignored. */
    setInputs(values = {}, source = 'live') {
        const fin = (v) => typeof v === 'number' && Number.isFinite(v);
        if (fin(values.pressureAltFt)) {
            this._state.altimeter = AirspeedLimits.STD_ALTIMETER_INHG.toFixed(2);
            this._state.alt = VnePanel._fmtEntry(values.pressureAltFt, 'alt');
        } else {
            if (fin(values.altimeterInHg)) this._state.altimeter = VnePanel._fmtEntry(values.altimeterInHg, 'altimeter');
            if (fin(values.indicatedAltFt)) this._state.alt = VnePanel._fmtEntry(values.indicatedAltFt, 'alt');
        }
        if (fin(values.oatF)) this._state.oatF = VnePanel._fmtEntry(values.oatF, 'oatF');
        else if (fin(values.oatC)) this._state.oatF = VnePanel._fmtEntry(AirspeedLimits.cToF(values.oatC), 'oatF');
        if (fin(values.kias)) this._state.kias = VnePanel._fmtEntry(values.kias, 'kias');
        this._source = String(source || 'live');
        this._syncInputs();
        this._render();
    }

    // ── Weight for Va ────────────────────────────────────────────────────────────

    /**
     * The weight Va is worked out from, and what went into it:
     * { weightLb | null, grossLb, stations: [{ name, lb }], fuelGal | null, fuelCounted,
     *   fuelReason: 'tracked' | 'stale' | 'untracked', reason: null | 'no-profile' | 'no-pilot' }.
     */
    static weightNow() {
        const out = { weightLb: null, grossLb: AirspeedLimits.VA_GROSS_LB, stations: [], fuelGal: null,
            fuelCounted: false, fuelReason: 'untracked', reason: null };
        let profile = null;
        try {
            profile = (typeof CockpitConfig !== 'undefined' && CockpitConfig.aircraft)
                ? CockpitConfig.aircraft('weight_balance') : null;
        } catch (_) { profile = null; }
        if (!profile || typeof WbCalculator === 'undefined') { out.reason = 'no-profile'; return out; }
        if (profile.max_gross_weight > 0) out.grossLb = profile.max_gross_weight;

        let saved = null;
        try { saved = (typeof Settings !== 'undefined') ? Settings.wbStationWeights : null; } catch (_) { saved = null; }
        const nonFuel = (profile.stations || []).filter(s => !s.fuel);
        const byIndex = {};
        nonFuel.forEach((s, i) => {
            const lb = parseFloat(WbCalculator.savedWeightText(saved, s.name)) || 0;
            byIndex[i] = lb;
            out.stations.push({ name: s.name, lb });
        });

        let m = null;
        try { m = (typeof FuelState !== 'undefined' && FuelState.measuredGallons) ? FuelState.measuredGallons() : null; } catch (_) { m = null; }
        if (m) {
            out.fuelGal = m.gallons;
            out.fuelCounted = !m.stale;
            out.fuelReason = m.stale ? 'stale' : 'tracked';
        }

        const pilot = out.stations.find(s => /pilot/i.test(s.name)) || out.stations[0];
        if (!pilot || !(pilot.lb > 0)) { out.reason = 'no-pilot'; return out; }
        out.weightLb = WbCalculator.calculate(profile, byIndex, out.fuelCounted ? out.fuelGal : 0).totalWeight;
        return out;
    }

    // ── Persistence ───────────────────────────────────────────────────────────────

    static _emptyState() {
        return { altimeter: '', alt: '', oatF: '', kias: '' };
    }

    static _loadState() {
        const s = VnePanel._emptyState();
        let saved = null;
        try {
            saved = (typeof Settings !== 'undefined') ? Settings.vneInputs : null;
        } catch (_) { saved = null; }
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return s;
        for (const k of VnePanel.FIELDS) {
            if (typeof saved[k] === 'string') s[k] = saved[k].slice(0, 12);
        }
        return s;
    }

    _save() {
        try {
            if (typeof Settings !== 'undefined') Settings.vneInputs = { ...this._state };
        } catch (_) { /* storage full / blocked: the card still works this session */ }
    }

    // ── DOM ───────────────────────────────────────────────────────────────────────

    _buildDOM() {
        const el = document.createElement('div');
        el.className = 'vne-card';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Vne and Va');
        this._el = el;

        const L = AirspeedLimits.LIMITS;
        const AL = AirspeedLimits;
        el.innerHTML = `
            <div class="vne-card-head">
                <div class="vne-title">Vne · Va</div>
                <button class="btn-close vne-close" aria-label="Close">&#x2715;</button>
            </div>
            <section class="vne-inputs vne-inputs--speed">
                ${VnePanel._fieldHTML('kias', 'KIAS', 'optional', 1, '1', 'clear')}
                ${VnePanel._fieldHTML('alt', 'Altitude', 'ft, as indicated', 500, '500', 'sign')}
            </section>
            <section class="vne-result" aria-live="polite">
                <div class="vne-primary-row">
                    <div class="vne-primary">
                        <span class="vne-primary-label">Vne here</span>
                        <span class="vne-primary-value" data-out="vne">—</span>
                        <span class="vne-primary-unit">KIAS</span>
                    </div>
                    <div class="vne-primary">
                        <span class="vne-primary-label">Va</span>
                        <span class="vne-primary-value" data-out="va">—</span>
                        <span class="vne-primary-unit">KIAS</span>
                    </div>
                </div>
                <div class="vne-status" data-out="status" role="status" hidden></div>
                <div class="vne-line" data-out="tas" hidden></div>
            </section>
            <section class="vne-inputs">
                ${VnePanel._fieldHTML('altimeter', 'Altimeter', 'inHg', 0.01, '.01', null)}
                ${VnePanel._fieldHTML('oatF', 'OAT', '°F', 1, '1', 'sign')}
            </section>
            <section class="vne-explain">
                <div class="vne-governs" data-out="governs"></div>
                <div class="vne-secondary" data-out="weight"></div>
                <div class="vne-secondary" data-out="da" hidden></div>
                <div class="vne-ref">Vno ${L.vnoKias} · Vfe ${L.vfeKias} KIAS <span class="vne-ref-note">(indicated limits)</span></div>
                <div class="vne-note" data-out="pec"></div>
                <div class="vne-note" data-out="source"></div>
                <p class="vne-footnote">Reference only. The POH and placards govern. Use OAT, not TAT. At 180 kt, ram rise reads 3–4 °C high, which makes the result conservative. Va is ${L.vaKias} KIAS at ${AL.VA_GROSS_LB.toLocaleString('en-US')} lb, reduced with the square root of weight.</p>
            </section>
        `;

        wireTap(el.querySelector('.vne-close'), () => this.hide());

        for (const field of el.querySelectorAll('.vne-field')) {
            const name = field.dataset.field;
            const inp = field.querySelector('input');
            inp.addEventListener('input', () => {
                this._state[name] = inp.value.slice(0, 12);
                this._edited();
            });
            for (const btn of field.querySelectorAll('[data-step]')) {
                wireTap(btn, () => this._step(name, Number(btn.dataset.step)));
            }
            const sign = field.querySelector('.vne-sign');
            if (sign) wireTap(sign, () => this._flipSign(name));
            const clear = field.querySelector('.vne-clear');
            if (clear) wireTap(clear, () => { this._state[name] = ''; this._edited(); });
        }

        this._container.appendChild(el);
        this._syncInputs();
    }

    /** extra: 'sign' (±), 'clear' (✕) or null (an empty cell, so the rows line up). */
    static _fieldHTML(name, label, hint, step, stepLabel, extra) {
        const extraHTML = extra === 'sign' ? '<button class="vne-sign" aria-label="change sign">±</button>'
            : extra === 'clear' ? '<button class="vne-clear" aria-label="clear">✕</button>'
                : '<span class="vne-spacer" aria-hidden="true"></span>';
        return `
            <div class="vne-field" data-field="${name}">
                <label class="vne-field-label" for="vne-in-${name}">${label} <span class="vne-field-hint">${hint}</span></label>
                <div class="vne-field-row">
                    <button class="vne-step" data-step="-${step}" aria-label="minus ${stepLabel}">−${stepLabel}</button>
                    <input id="vne-in-${name}" class="vne-input" type="text" inputmode="decimal"
                           enterkeyhint="done" autocomplete="off" spellcheck="false" maxlength="12">
                    <button class="vne-step" data-step="${step}" aria-label="plus ${stepLabel}">+${stepLabel}</button>
                    ${extraHTML}
                </div>
                <div class="vne-field-error" data-err="${name}"></div>
            </div>`;
    }

    _syncInputs() {
        for (const name of VnePanel.FIELDS) {
            const inp = this._el.querySelector(`[data-field="${name}"] input`);
            if (inp && inp.value !== this._state[name]) inp.value = this._state[name];
        }
    }

    // ── Actions ───────────────────────────────────────────────────────────────────

    _edited() {
        this._source = 'manual';
        this._syncInputs();
        this._save();
        this._render();
    }

    _step(name, delta) {
        const AL = AirspeedLimits;
        const cur = AL.parseNumber(this._state[name]);
        let next;
        if (name === 'altimeter') {
            next = AL.stepValue(cur, delta, AL.ALTIMETER_MIN_INHG, AL.ALTIMETER_MAX_INHG, AL.STD_ALTIMETER_INHG);
        } else if (name === 'alt') {
            next = AL.stepAltitude(cur, delta);
        } else if (name === 'oatF') {
            const alt = AL.parseNumber(this._state.alt);
            const startC = AL.checkAltitude(alt) ? 15 : AL.isaTempC(alt);
            next = AL.stepValue(cur, delta, AL.cToF(AL.OAT_MIN_C), AL.cToF(AL.OAT_MAX_C), Math.round(AL.cToF(startC)));
        } else {
            next = AL.stepValue(cur, delta, AL.SPEED_MIN_KT, AL.SPEED_MAX_KT, 150);
        }
        this._state[name] = VnePanel._fmtEntry(next, name);
        this._edited();
    }

    _flipSign(name) {
        const v = this._state[name].trim();
        this._state[name] = /^[-−]/.test(v) ? v.slice(1) : `-${v.replace(/^\+/, '')}`;
        this._edited();
    }

    // ── Render ────────────────────────────────────────────────────────────────────

    /** An entry as text: altimeter to 0.01, the rest to 0.1 (whole numbers without a decimal). */
    static _fmtEntry(n, name) {
        if (name === 'altimeter') return (Math.round(n * 100) / 100).toFixed(2);
        const r = Math.round(n * 10) / 10;
        return Object.is(r, -0) ? '0' : String(r);
    }

    static _fmtInt(n) {
        return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—';
    }

    _vneConfigKt() {
        try {
            return (typeof CockpitConfig !== 'undefined' && CockpitConfig.aircraft)
                ? CockpitConfig.aircraft('performance.vne_kt') : undefined;
        } catch (_) { return undefined; }
    }

    _render() {
        const AL = AirspeedLimits;
        const st = this._state;
        const kias = AL.parseNumber(st.kias);
        const w = VnePanel.weightNow();

        const r = AL.evaluate(
            { altimeterInHg: AL.parseNumber(st.altimeter), indicatedAltFt: AL.parseNumber(st.alt),
              oatF: AL.parseNumber(st.oatF), kias, weightLb: w.weightLb },
            { vneKt: this._vneConfigKt(), pecKt: AL.DEFAULT_PEC_KT, grossLb: w.grossLb },
        );
        this._last = r;

        const q = (sel) => this._el.querySelector(sel);
        const show = (node, text) => { node.textContent = text; node.hidden = false; };
        const hide = (node) => { node.textContent = ''; node.hidden = true; };
        const S = VnePanel._fmtSigned;

        // Field errors (range only; a missing value is prompted for in the result card)
        const rangeMsg = {
            altimeter: `Out of range: ${AL.ALTIMETER_MIN_INHG.toFixed(2)} to ${AL.ALTIMETER_MAX_INHG.toFixed(2)} inHg`,
            alt: r.pressureAltFt === null
                ? `Out of range: pressure altitude ${S(AL.ALT_MIN_FT)} to ${AL.ALT_MAX_FT.toLocaleString('en-US')} ft`
                : `Pressure altitude ${S(r.pressureAltFt)} ft is out of range: ${S(AL.ALT_MIN_FT)} to ${AL.ALT_MAX_FT.toLocaleString('en-US')} ft`,
            oatF: `Out of range: ${S(AL.cToF(AL.OAT_MIN_C))} to ${S(AL.cToF(AL.OAT_MAX_C), true)} °F`,
            kias: `Out of range: ${AL.SPEED_MIN_KT} to ${AL.SPEED_MAX_KT} kt`,
        };
        const errKey = { altimeter: 'altimeter', alt: 'alt', oatF: 'oat', kias: 'kias' };
        for (const name of VnePanel.FIELDS) {
            const bad = r.errors[errKey[name]] === 'range';
            q(`[data-err="${name}"]`).textContent = bad ? rangeMsg[name] : '';
            q(`[data-field="${name}"]`).classList.toggle('vne-field--error', bad);
        }

        // Va and the weight behind it
        q('[data-out="va"]').textContent = r.vaKias === null ? '—' : String(r.vaKias);
        q('[data-out="weight"]').textContent = VnePanel._weightText(w, r);

        const card = q('.vne-result');
        const statusEl = q('[data-out="status"]');
        const tasEl = q('[data-out="tas"]');
        const daEl = q('[data-out="da"]');

        if (!r.ok) {
            q('[data-out="vne"]').textContent = '—';
            const what = [];
            if (r.errors.altimeter === 'missing') what.push('altimeter');
            if (r.errors.alt === 'missing') what.push('altitude');
            if (r.errors.oat === 'missing') what.push('OAT');
            q('[data-out="governs"]').textContent = what.length
                ? `Enter ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : what[0]}`
                : 'Check the highlighted entry';
            hide(statusEl); hide(tasEl); hide(daEl);
            card.classList.remove('vne-result--warn');
        } else {
            q('[data-out="vne"]').textContent = String(r.vneKias);
            q('[data-out="governs"]').textContent = `${r.limitKt} ${r.governs} governs`;
            show(daEl, `Pressure alt ${S(r.pressureAltFt)} ft · Density alt ${S(r.densityAltFt)} ft · ISA ${S(r.isaDevC, true)} °C`);

            if (r.status) {
                show(tasEl, `${VnePanel._fmtEntry(kias, 'kias')} KIAS = ${r.tasKt} KTAS`);
                const warn = r.status !== 'ok';
                statusEl.textContent = r.status === 'over'
                    ? `⚠ OVER VNE by ${-r.marginKt} kt`
                    : r.status === 'at'
                        ? `⚠ AT VNE · margin ${r.marginKt} kt`
                        : `✓ WITHIN VNE · margin ${r.marginKt} kt`;
                statusEl.hidden = false;
                statusEl.classList.toggle('vne-status--warn', warn);
                statusEl.classList.toggle('vne-status--ok', !warn);
                card.classList.toggle('vne-result--warn', warn);
            } else {
                hide(tasEl); hide(statusEl);
                card.classList.remove('vne-result--warn');
            }
        }

        q('[data-out="pec"]').textContent = r.pecKt === 0
            ? 'IAS ≈ CAS. Position error not applied.'
            : `Position error ${S(r.pecKt, true)} kt applied (CAS = IAS + correction).`;
        q('[data-out="source"]').textContent = this._source === 'manual' ? 'Manual entry' : `Live: ${this._source}`;

        this.dispatchEvent(new Event('change'));
    }

    /** "Weight 1,523 lb · Pilot 190 · Passenger 170 · Baggage 20 · Fuel 21.4 gal" and its caveats. */
    static _weightText(w, r) {
        if (w.reason === 'no-profile') return 'No W&B profile in aircraft-config.json — no Va.';
        if (w.reason === 'no-pilot') return 'Enter weights in W&B for Va.';
        const parts = [`Weight ${VnePanel._fmtInt(w.weightLb)} lb`];
        for (const s of w.stations) parts.push(`${s.name} ${VnePanel._fmtInt(s.lb)}`);
        if (w.fuelCounted) parts.push(`Fuel ${(Math.round(w.fuelGal * 10) / 10).toFixed(1)} gal`);
        else parts.push(w.fuelReason === 'stale' ? 'fuel not counted (tracking not current)' : 'fuel not counted (not tracked)');
        let text = parts.join(' · ');
        if (r.overGross) text = `⚠ Over gross (${VnePanel._fmtInt(w.grossLb)} lb). ${text}`;
        return text;
    }

    /** −1,000 / +0.8 style: a real minus sign; plus only when asked. */
    static _fmtSigned(n, plus = false) {
        if (!Number.isFinite(n)) return '—';
        const abs = Math.abs(n);
        const body = Number.isInteger(abs) ? abs.toLocaleString('en-US') : String(Math.round(abs * 10) / 10);
        if (n < 0) return `−${body}`;
        return plus && n > 0 ? `+${body}` : body;
    }
}

if (typeof window !== 'undefined') window.VnePanel = VnePanel;
