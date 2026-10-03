/**
 * FlyTab — Sticky valve warning banner.
 *
 * Shows StickyValveMonitor's latched alert (web/shared/sticky-valve.js) until
 * the pilot taps DISMISS. One instance sits over the map, one on the ENG page;
 * both read the same monitor, so dismissing either hides both.
 */

class StickyValveBanner {
    /**
     * @param {HTMLElement} container  where the banner goes
     * @param {StickyValveMonitor} monitor
     * @param {'map'|'inline'} [variant]  'map' floats over the map; 'inline' sits in the ENG page flow
     */
    constructor(container, monitor, variant = 'inline') {
        this._monitor = monitor;
        this._el = document.createElement('div');
        this._el.className = `sv-banner sv-banner--${variant}`;
        this._el.setAttribute('role', 'alert');
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="sv-banner-body">
                <div class="sv-banner-title">STICKY VALVE WARNING</div>
                <div class="sv-banner-detail"></div>
                <div class="sv-banner-hint">Possible sticking exhaust valve (Lycoming SB 388C). Check before flight.</div>
            </div>
            <button class="sv-banner-dismiss" type="button">DISMISS</button>`;
        this._detailEl = this._el.querySelector('.sv-banner-detail');
        container.appendChild(this._el);

        const btn = this._el.querySelector('.sv-banner-dismiss');
        if (typeof wireTap === 'function') wireTap(btn, () => monitor.dismiss());
        else btn.addEventListener('click', () => monitor.dismiss());

        this._onChange = () => this.render();
        monitor.addEventListener('change', this._onChange);
        this.render();
    }

    get element() { return this._el; }

    render() {
        const { visible, cylinders } = this._monitor.state;
        this._el.style.display = visible ? 'flex' : 'none';
        if (!visible) return;
        this._detailEl.innerHTML = cylinders
            .map(c => `<div class="sv-banner-cyl${c.recovered ? ' sv-banner-cyl--recovered' : ''}">${StickyValveMonitor.describe(c)}</div>`)
            .join('');
    }

    destroy() {
        this._monitor.removeEventListener('change', this._onChange);
        this._el.remove();
    }
}
