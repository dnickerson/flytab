/**
 * FlyTab — Position banner over the map.
 *
 * Shows PositionHealthMonitor's state (shared/position-health.js) in plain
 * words when own-ship can't be trusted: held or lost after a fix this session,
 * position coming from the engine monitor, or a VPN on (shown even on the
 * ground -- it breaks the Stratux link). Tap the text for the details panel;
 * DISMISS hides it for the current problem only. A new problem shows it again.
 *
 * Mounted in #mapContainer as a sibling of the Leaflet element, not inside it,
 * and every control uses wireIsolatedTap: no touch, pointer or click on the
 * banner reaches the map, and the synthetic click is cancelled, so a tap can't
 * open an airport popup underneath even when DISMISS makes the banner vanish.
 */
class PositionHealthBanner {
    /**
     * @param {HTMLElement} container  #mapContainer
     * @param {EventTarget} monitor    PositionHealthMonitor ('change' events, .state)
     * @param {{onOpenDetails?: Function}} [opts]
     */
    constructor(container, monitor, opts = {}) {
        this._container = container;
        this._monitor = monitor;
        this._onOpenDetails = opts.onOpenDetails || null;
        this._dismissed = null;          // { episodeId, rank } the pilot dismissed
        this._shownEpisode = null;       // last episodeId actually shown (for "restored")
        this._restoredUntil = 0;
        this._restoredText = '';
        this._restoredFor = null;        // lastEnded object already announced
        this._restoredTimer = null;

        const el = document.createElement('div');
        el.className = 'ph-banner';
        el.setAttribute('role', 'alert');
        el.style.display = 'none';
        el.innerHTML = `
            <div class="ph-banner-body">
                <div class="ph-banner-title"></div>
                <div class="ph-banner-detail"></div>
            </div>
            <button type="button" class="ph-banner-dismiss">DISMISS</button>`;
        this._el = el;
        this._titleEl = el.querySelector('.ph-banner-title');
        this._detailEl = el.querySelector('.ph-banner-detail');
        container.appendChild(el);

        const tap = (typeof wireIsolatedTap === 'function') ? wireIsolatedTap : (n, fn) => n.addEventListener('click', (e) => { e.stopPropagation(); fn(e); });
        // The whole banner is isolated (gaps between controls included); the
        // controls inside are isolated too, so each tap reaches only its own handler.
        tap(el, () => {});
        tap(el.querySelector('.ph-banner-body'), () => this._onOpenDetails?.());
        tap(el.querySelector('.ph-banner-dismiss'), () => this.dismiss());

        this._onChange = () => this.render();
        monitor.addEventListener('change', this._onChange);
        this._watchStickyValve();
        this.render();
    }

    /**
     * The sticky-valve warning can appear (or clear) while this banner is static,
     * with no monitor event. Watch for it so this banner always sits below it.
     */
    _watchStickyValve() {
        if (typeof MutationObserver === 'undefined') return;
        const reposition = () => { if (this._el.style.display !== 'none') this._placeBelowStickyValve(); };
        this._svStyleObs = new MutationObserver(reposition);
        let watched = null;
        const attach = () => {
            const sv = this._container.querySelector(':scope > .sv-banner--map');
            if (sv && sv !== watched) {
                watched = sv;
                this._svStyleObs.disconnect();
                this._svStyleObs.observe(sv, { attributes: true, attributeFilter: ['style', 'class'] });
            }
            reposition();
        };
        this._svChildObs = new MutationObserver(attach);
        this._svChildObs.observe(this._container, { childList: true });
        attach();
    }

    get element() { return this._el; }

    dismiss() {
        const st = this._monitor.state;
        const view = st && this._view(st);
        if (st?.episodeId != null) this._dismissed = { episodeId: st.episodeId, rank: PositionHealthBanner.rank(view?.severity) };
        this._restoredUntil = 0;
        this._el.style.display = 'none';
    }

    render() {
        const st = this._monitor.state;
        if (!st) return;
        const now = Date.now();

        // A problem that ended while it was on screen (and not dismissed): say so briefly.
        if (st.lastEnded && st.lastEnded !== this._restoredFor) {
            this._restoredFor = st.lastEnded;
            const ended = st.lastEnded;
            const wasShown = this._shownEpisode != null && (ended.id == null || ended.id === this._shownEpisode);
            if (wasShown && this._dismissed?.episodeId !== this._shownEpisode) {
                this._restoredText = `POSITION RESTORED · dropout ${ended.durationS} s`;
                this._restoredUntil = now + PositionHealthBanner.RESTORED_MS;
                clearTimeout(this._restoredTimer);
                this._restoredTimer = setTimeout(() => this.render(), PositionHealthBanner.RESTORED_MS);
            }
            this._shownEpisode = null;
        }

        const view = this._view(st);
        // Dismissed stays dismissed for this problem -- unless it gets WORSE
        // (amber -> red), which the pilot hasn't seen yet.
        const dismissed = this._dismissed && st.episodeId === this._dismissed.episodeId
            && PositionHealthBanner.rank(view?.severity) <= this._dismissed.rank;
        if (view && !dismissed) {
            this._shownEpisode = st.episodeId;
            this._paint(view.severity, view.title, st.cause.text);
            return;
        }
        if (!view && now < this._restoredUntil) {
            this._paint('ok', this._restoredText, '');
            return;
        }
        this._el.style.display = 'none';
    }

    /** What to show for a state, or null for nothing. */
    _view(st) {
        const code = st.cause?.code;
        if (!code || code === 'ok') return null;
        if (code === 'vpn') return { severity: 'danger', title: 'A VPN IS ON' };
        if (!st.hadFix) return null;          // startup, before any fix: the badge covers it
        if (code === 'engine-gps' && st.ownship === 'live') return { severity: 'caution', title: 'POSITION FROM ENGINE MONITOR' };
        if (code === 'device-gps' && st.ownship === 'live') return { severity: 'caution', title: "POSITION FROM TABLET'S GPS" };
        if (st.ownship === 'held') return { severity: 'caution', title: `POSITION HELD · ${st.holdRemainingS} s` };
        if (st.ownship === 'hidden' || st.ownship === 'none') return { severity: 'danger', title: 'POSITION LOST' };
        return null;
    }

    _paint(severity, title, detail) {
        this._el.className = `ph-banner ph-banner--${severity}`;
        this._titleEl.textContent = title;
        this._detailEl.textContent = detail;
        this._detailEl.style.display = detail ? '' : 'none';
        this._el.style.display = 'flex';
        this._placeBelowStickyValve();
    }

    /** Don't cover the sticky-valve warning if it's up: sit just below it. */
    _placeBelowStickyValve() {
        const sv = this._container.querySelector(':scope > .sv-banner--map');
        if (sv && sv.style.display !== 'none' && sv.offsetHeight) {
            this._el.style.top = `${sv.offsetTop + sv.offsetHeight + 8}px`;
        } else {
            this._el.style.top = '';
        }
    }

    destroy() {
        this._svStyleObs?.disconnect();
        this._svChildObs?.disconnect();
        clearTimeout(this._restoredTimer);
        this._monitor.removeEventListener('change', this._onChange);
        this._el.remove();
    }
}

PositionHealthBanner.RESTORED_MS = 5000;
PositionHealthBanner.rank = (severity) => ({ caution: 1, danger: 2 })[severity] || 0;
