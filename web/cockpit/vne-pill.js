/**
 * VnePill — "VNE 161  VA 94" over "@ 8,000 · 40°F · 3H AGO" on the map, right side, just under the engine box
 * (cockpit/engine-overlay.js). Tapping it opens / closes the Vne / Va card (cockpit/vne-panel.js),
 * which it places just under itself. Design: docs/superpowers/specs/2026-11-13-vne-va-map-pill-design.md.
 *
 * Shows whatever the card last worked out (summary()), with the altitude and OAT those numbers
 * are for and how old the entries are ("@ 8,000 · 40°F · 3h ago" on a second line), since the
 * entries are manual, do not follow the aircraft and are kept between flights (Dana 2026-11-13,
 * option 1). The age is the oldest of the altimeter / altitude / OAT entries (KIAS does not count)
 * and counts on with the card's 15 s refresh; entries saved before it existed read "age ?". Never turns red: an old KIAS
 * entry would make a red pill misleading; the over-Vne warning lives in the card.
 *
 * Placement: the engine box is absolutely positioned at top 156 px (top-right) and grows a row
 * per field; it is rebuilt (a new element) on 'engineoverlay:fieldschanged'. The pill watches
 * its size with a ResizeObserver and sits 6 px under it; with no engine box on the right
 * (disabled, or placed top-left / bottom-right) the pill takes the box's 156 px slot.
 */
class VnePill {
    static TOP_PX = 156;   // engine-overlay.js top-right slot, under the map corner buttons
    static GAP_PX = 6;

    constructor(container, panel) {
        this._container = container;
        this._panel = panel;
        this._engineEl = null;
        this._ro = null;

        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'vne-pill';
        el.setAttribute('aria-label', 'Vne and Va. Tap to enter altimeter, altitude, OAT and KIAS.');
        // Laid out like an engine box row: LABEL value (styles in style.css .vne-pill).
        el.innerHTML = '<span class="vne-pill-label">Vne</span><b data-pill="vne">—</b>'
            + '<span class="vne-pill-label">Va</span><b data-pill="va">—</b>'
            + '<span class="vne-pill-alt" data-pill="alt"></span>';
        this._el = el;
        container.appendChild(el);

        wireTap(el, () => {
            this._panel.toggle();
            this.place();
        });

        this._onChange = () => this.render();
        panel.addEventListener('change', this._onChange);

        this._onFields = () => {
            const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : (f) => setTimeout(f, 0);
            raf(() => { this._watchEngine(); this.place(); });
        };
        this._onResize = () => this.place();
        if (typeof window !== 'undefined') {
            window.addEventListener('engineoverlay:fieldschanged', this._onFields);
            window.addEventListener('resize', this._onResize);
        }

        this._watchEngine();
        this.render();
        this.place();
    }

    render() {
        const s = this._panel.summary();
        const q = (k) => this._el.querySelector(`[data-pill="${k}"]`);
        q('vne').textContent = s.vneKias == null ? '—' : String(s.vneKias);
        q('va').textContent = s.vaKias == null ? '—' : String(s.vaKias);
        const parts = [];
        if (s.ok && Number.isFinite(s.altFt)) {
            parts.push(`@ ${Math.round(s.altFt).toLocaleString('en-US')}`);
            if (Number.isFinite(s.oatF)) parts.push(`${Math.round(s.oatF)}°F`);
            parts.push(VnePill.ageText(s.inputsAt));
        }
        q('alt').textContent = parts.join(' · ');
        q('alt').hidden = !q('alt').textContent;
        // The second line appears / goes with the entries, so the pill's height changes: move the
        // card with it (an open card would otherwise cover the age line or leave a gap).
        this.place();
    }

    /** How old the entries are: "just now", "12m ago", "3h ago", "5d ago"; "age ?" when unknown. */
    static ageText(at, now = Date.now()) {
        if (typeof at !== 'number' || !Number.isFinite(at)) return 'age ?';
        if (at - now > 60000) return 'age ?';             // clock moved back: the age is not known
        const min = Math.max(0, (now - at) / 60000);
        if (min < 1) return 'just now';
        if (min < 60) return `${Math.floor(min)}m ago`;
        if (min < 48 * 60) return `${Math.floor(min / 60)}h ago`;
        return `${Math.floor(min / 1440)}d ago`;
    }

    /** The engine box when it is on the right-hand top slot, else null. */
    _engineBox() {
        const box = this._container.querySelector('.engine-overlay');
        if (!box || !box.isConnected) return null;
        if (!box.style.right || !box.style.top) return null;   // top-left / bottom-right: not in our column
        return box.childElementCount > 0 ? box : null;
    }

    _watchEngine() {
        const box = this._engineBox();
        if (box === this._engineEl) return;
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        this._engineEl = box;
        if (box && typeof ResizeObserver === 'function') {
            this._ro = new ResizeObserver(() => this.place());
            this._ro.observe(box);
        }
    }

    /** Put the pill under the engine box (or in its slot) and the card under the pill. */
    place() {
        this._watchEngine();
        const box = this._engineEl;
        const top = box ? box.offsetTop + box.offsetHeight + VnePill.GAP_PX : VnePill.TOP_PX;
        this._el.style.top = `${Math.round(top)}px`;
        this._panel.setTop(top + this._el.offsetHeight + VnePill.GAP_PX);
    }

    destroy() {
        this._panel.removeEventListener('change', this._onChange);
        if (typeof window !== 'undefined') {
            window.removeEventListener('engineoverlay:fieldschanged', this._onFields);
            window.removeEventListener('resize', this._onResize);
        }
        if (this._ro) this._ro.disconnect();
        if (this._el.parentNode) this._el.parentNode.removeChild(this._el);
    }
}

if (typeof window !== 'undefined') window.VnePill = VnePill;
