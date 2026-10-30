/**
 * FlyTab — Radio frequency tool (map corner button "FREQ").
 *
 * A side panel, so the map stays visible:
 *  - the frequency a controller gives, typed without the leading "1"
 *    (FreqEntry: "3575" -> 135.750), ENTER keeps it;
 *  - the history (FreqHistory), newest first: the top one is "current" and
 *    shows on the map button; tap an older one to make it current again;
 *  - the Center frequency for this position and altitude, when a provider is
 *    set (setCenterProvider) and has one. NOT WIRED YET: no Center data source
 *    (ARTCC sector frequencies by altitude) exists; the section stays hidden.
 */
class FreqPanel {
    constructor(container, opts = {}) {
        this._container = container;
        this._getSituation = opts.getSituation || (() => null);
        this._centerProvider = null;
        this._digits = '';
        this._error = '';
        this.onCurrentChange = null;      // (mhz|null) -> map button text
        this._el = null;
        this._build();
    }

    get current() { return FreqHistory.list()[0]?.mhz ?? null; }
    get visible() { return !!this._el?.classList.contains('open'); }

    /** fn() -> { name, mhz, band } | null for the Center frequency here, or null */
    setCenterProvider(fn) { this._centerProvider = fn; if (this.visible) this._renderCenter(); }

    show() {
        this._digits = ''; this._error = '';
        this._render();
        this._el.classList.add('open');
        this._el.setAttribute('aria-hidden', 'false');
    }

    hide() {
        this._el.classList.remove('open');
        this._el.setAttribute('aria-hidden', 'true');
    }

    toggle() { if (this.visible) this.hide(); else this.show(); }

    _build() {
        const el = document.createElement('div');
        el.className = 'freq-panel';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Radio frequencies');
        el.setAttribute('aria-hidden', 'true');
        const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'CLR', '0', '⌫'];
        el.innerHTML = `
            <div class="freq-head">
                <div class="freq-title">RADIO</div>
                <button class="freq-close btn-close" aria-label="Close">✕</button>
            </div>
            <div class="freq-center" hidden></div>
            <div class="freq-entry">
                <div class="freq-display" aria-live="polite"><span class="freq-one">1</span><span class="freq-typed"></span></div>
                <div class="freq-error" aria-live="polite"></div>
                <div class="freq-keys">${keys.map((k) => `<button class="freq-key" data-key="${k}">${k}</button>`).join('')}</div>
                <button class="freq-enter">ENTER</button>
            </div>
            <div class="freq-hist-title">HISTORY</div>
            <div class="freq-hist"></div>`;
        this._container.appendChild(el);
        this._el = el;

        wireTap(el.querySelector('.freq-close'), () => this.hide());
        el.querySelectorAll('.freq-key').forEach((b) => wireTap(b, () => this._key(b.dataset.key)));
        wireTap(el.querySelector('.freq-enter'), () => this._enter());
        // Keep map gestures out of the panel
        if (typeof L !== 'undefined' && L.DomEvent) {
            L.DomEvent.disableClickPropagation(el);
            L.DomEvent.disableScrollPropagation(el);
        }
    }

    _key(k) {
        this._error = '';
        if (k === 'CLR') this._digits = '';
        else if (k === '⌫') this._digits = this._digits.slice(0, -1);
        else if (this._digits.length < FreqEntry.MAX_DIGITS) this._digits += k;
        this._renderEntry();
    }

    _enter() {
        const r = FreqEntry.parse(this._digits);
        if (!r.ok) { this._error = r.reason; this._renderEntry(); return; }
        this._keep(r.mhz, {});
        this._digits = '';
        this._render();
    }

    /** Make mhz the current frequency (top of the history), with where it was set. */
    _keep(mhz, extra) {
        const sit = this._getSituation();
        FreqHistory.add(mhz, {
            altFt: sit?.alt_msl ?? sit?.alt_baro,
            lat: sit?.lat, lon: sit?.lon,
            ...extra,
        });
        if (typeof DiagLog !== 'undefined') DiagLog.log('radio', `Frequency ${mhz}${extra.label ? ' (' + extra.label + ')' : ''}`);
        if (this.onCurrentChange) this.onCurrentChange(this.current);
    }

    _render() { this._renderCenter(); this._renderEntry(); this._renderHistory(); }

    _renderEntry() {
        const shown = FreqEntry.display(this._digits);
        this._el.querySelector('.freq-typed').textContent = shown.slice(1);
        this._el.querySelector('.freq-error').textContent = this._error;
        this._el.querySelector('.freq-enter').disabled = this._digits.length < 3;
    }

    _renderCenter() {
        const box = this._el.querySelector('.freq-center');
        let c = null;
        try { c = this._centerProvider?.() ?? null; } catch { c = null; }
        if (!c?.mhz) { box.hidden = true; box.innerHTML = ''; return; }
        box.hidden = false;
        box.innerHTML = `
            <div class="freq-center-lbl">${FreqPanel._esc(c.band || 'CENTER')}</div>
            <button class="freq-center-btn">
                <span class="freq-center-mhz">${FreqPanel._esc(c.mhz)}</span>
                <span class="freq-center-name">${FreqPanel._esc(c.name || '')}</span>
            </button>`;
        wireTap(box.querySelector('.freq-center-btn'), () => {
            this._keep(c.mhz, { label: c.name || 'Center' });
            this._renderHistory();
        });
    }

    _renderHistory() {
        const list = FreqHistory.list();
        const box = this._el.querySelector('.freq-hist');
        if (!list.length) {
            box.innerHTML = '<div class="freq-hist-empty">Frequencies you enter appear here.</div>';
            return;
        }
        box.innerHTML = list.map((e, i) => {
            const t = new Date(e.at);
            const when = Number.isNaN(t.getTime()) ? ''
                : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const alt = Number.isFinite(e.altFt) ? ` · ${Math.round(e.altFt).toLocaleString()} ft` : '';
            const lbl = e.label ? ` · ${FreqPanel._esc(e.label)}` : '';
            return `<div class="freq-row${i === 0 ? ' current' : ''}">
                <button class="freq-row-main" data-mhz="${e.mhz}">
                    <span class="freq-row-mhz">${e.mhz}</span>
                    <span class="freq-row-meta">${i === 0 ? 'CURRENT · ' : ''}${when}${alt}${lbl}</span>
                </button>
                <button class="freq-row-del" data-mhz="${e.mhz}" aria-label="Remove ${e.mhz}">✕</button>
            </div>`;
        }).join('');
        box.querySelectorAll('.freq-row-main').forEach((b) => wireTap(b, () => {
            const old = FreqHistory.list().find((e) => e.mhz === b.dataset.mhz);
            this._keep(b.dataset.mhz, old?.label ? { label: old.label } : {});
            this._renderHistory();
        }));
        box.querySelectorAll('.freq-row-del').forEach((b) => wireTap(b, () => {
            FreqHistory.remove(b.dataset.mhz);
            if (this.onCurrentChange) this.onCurrentChange(this.current);
            this._renderHistory();
        }));
    }

    static _esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

if (typeof window !== 'undefined') window.FreqPanel = FreqPanel;
