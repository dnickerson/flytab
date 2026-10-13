/**
 * FlyTab — GPS / position detail panel (opened from the GPS badge or the
 * position banner). Replaces the old developer log panel: plain words, one row
 * per link in the chain, live while open, plus this tablet's dropout history.
 *
 *   own-ship        POSITION LIVE / HELD · n s / LOST / NO FIX YET
 *   Stratux GPS     solution · satellites · accuracy · uptime (+ restart note)
 *   Wi-Fi link      OK / LOST n s (+ last Android error)
 *   Engine monitor  OK / LOST
 *   VPN             Off / A VPN IS ON (+ OPEN VPN SETTINGS) / Unknown
 *
 * Sits in the page flow right under the status bar (not over the map). All
 * buttons use wireIsolatedTap.
 */
class PositionHealthPanel {
    /**
     * @param {HTMLElement} afterEl   the status bar; the panel is inserted after it
     * @param {EventTarget} monitor   PositionHealthMonitor (.state, .history, 'change')
     * @param {{onGpsSettings?: Function, onFullLog?: Function, openVpnSettings?: Function}} [actions]
     */
    constructor(afterEl, monitor, actions = {}) {
        this._monitor = monitor;
        this._actions = actions;
        this._visible = false;

        const el = document.createElement('div');
        el.id = 'gps-diag-panel';
        el.className = 'php';
        el.innerHTML = `
            <div class="php-head">
                <div class="php-status"></div>
                <div class="php-cause"></div>
            </div>
            <dl class="php-rows">
                <div class="php-row" data-row="gps"><dt>Stratux GPS</dt><dd><span class="php-val"></span><span class="php-note"></span></dd></div>
                <div class="php-row" data-row="link"><dt>Wi-Fi link tablet ↔ Stratux</dt><dd><span class="php-val"></span><span class="php-note"></span></dd></div>
                <div class="php-row" data-row="engine"><dt>Engine monitor link</dt><dd><span class="php-val"></span><span class="php-note"></span></dd></div>
                <div class="php-row" data-row="vpn"><dt>VPN</dt><dd><span class="php-val"></span><span class="php-note"></span></dd></div>
            </dl>
            <div class="php-history-title">Dropouts on this tablet (newest first)</div>
            <ul class="php-history"></ul>
            <div class="php-actions">
                <button type="button" class="php-btn php-btn--danger" data-act="vpn-settings" hidden>OPEN VPN SETTINGS</button>
                <button type="button" class="php-btn" data-act="use-stratux" hidden>USE STRATUX GPS</button>
                <button type="button" class="php-btn" data-act="reset-gps" hidden>RESET GPS SOURCE</button>
                <button type="button" class="php-btn" data-act="gps-settings">GPS SETTINGS</button>
                <button type="button" class="php-btn" data-act="full-log">FULL LOG</button>
                <button type="button" class="php-btn" data-act="close">CLOSE</button>
            </div>`;
        this._el = el;
        afterEl?.insertAdjacentElement('afterend', el);

        const tap = (typeof wireIsolatedTap === 'function') ? wireIsolatedTap : (n, fn) => n.addEventListener('click', fn);
        const act = (name, fn) => tap(el.querySelector(`[data-act="${name}"]`), fn);
        act('vpn-settings', () => this._actions.openVpnSettings?.());
        // GPS source shortcuts (as the old panel had): back to Stratux from a
        // configured Internal source, or out of an auto-mode device-GPS fallback.
        act('use-stratux', () => { this._actions.gpsSource?.setSource('stratux'); this.render(); });
        act('reset-gps', () => { this._actions.gpsSource?.setSource('auto'); this.render(); });
        act('gps-settings', () => this._actions.onGpsSettings?.());
        act('full-log', () => this._actions.onFullLog?.());
        act('close', () => this.hide());

        this._onChange = () => { if (this._visible) this.render(); };
        monitor.addEventListener('change', this._onChange);
    }

    get element() { return this._el; }
    get visible() { return this._visible; }

    // The panel is in the page flow, so opening/closing changes the map's height:
    // onToggle lets the app tell Leaflet to re-measure.
    show() { this._visible = true; this._el.classList.add('visible'); this.render(); this._actions.onToggle?.(true); }
    hide() { this._visible = false; this._el.classList.remove('visible'); this._actions.onToggle?.(false); }
    toggle() { this._visible ? this.hide() : this.show(); }

    render() {
        const st = this._monitor.state;
        if (!st) return;
        const q = (sel) => this._el.querySelector(sel);
        const row = (name, val, note, bad) => {
            const r = q(`[data-row="${name}"]`);
            r.querySelector('.php-val').textContent = val;
            const n = r.querySelector('.php-note');
            n.textContent = note || '';
            n.hidden = !note;
            r.classList.toggle('php-row--bad', !!bad);
        };

        const status = q('.php-status');
        status.textContent = PositionHealthPanel.statusText(st);
        status.className = `php-status php-status--${st.severity}`;
        q('.php-cause').textContent = st.cause.text;

        const g = st.stratux;
        const parts = [];
        if (g.solution) parts.push(g.solution);
        if (g.sats != null) parts.push(`${g.sats} satellites`);
        if (g.accuracyM != null) parts.push(`±${Math.round(g.accuracyM * 10) / 10} m`);
        if (g.uptimeS != null) parts.push(`up ${PositionHealthPanel.duration(g.uptimeS)}`);
        row('gps', parts.join(' · ') || (g.flowing ? (g.hasFix ? '3D fix' : 'No fix') : '—'),
            g.restartRecent ? `Stratux restarted at ${PositionHealthPanel.clock(g.restartAt)} — power interruption?` : '',
            g.flowing && !g.hasFix);

        const err = st.link.lastError;
        row('link', g.flowing ? 'OK' : `LOST ${g.lostS} s`,
            err ? `Last error ${PositionHealthPanel.clock(err.at)}: ${err.message}` : '', !g.flowing);

        const e = st.engine;
        row('engine', e.ok === true ? (e.bridgeActive ? 'OK — supplying position' : 'OK') : e.ok === false ? 'LOST' : '—', '', e.ok === false);

        const v = st.vpn.active;
        row('vpn', v === true ? 'A VPN IS ON' : v === false ? 'Off' : 'Unknown',
            v === true ? 'A VPN breaks the Stratux link. Turn it off.' : '', v === true);
        q('[data-act="vpn-settings"]').hidden = v !== true;
        const gs = this._actions.gpsSource;
        q('[data-act="use-stratux"]').hidden = gs?._configuredSource !== 'internal';
        q('[data-act="reset-gps"]').hidden = !(gs?._configuredSource === 'auto' && gs?._inFallback);

        const hist = this._monitor.history || [];
        q('.php-history').innerHTML = '';
        for (const ev of hist.slice(0, PositionHealthPanel.HISTORY_SHOWN)) {
            const li = document.createElement('li');
            li.textContent = [PositionHealthPanel.clock(ev.start), `${ev.durationS} s`, PositionHealthPanel.CAUSE_LABELS[ev.code] || ev.code, ev.error]
                .filter(Boolean).join(' · ');
            q('.php-history').appendChild(li);
        }
        if (!hist.length) {
            const li = document.createElement('li');
            li.textContent = 'None recorded';
            q('.php-history').appendChild(li);
        }
    }

    static statusText(st) {
        if (st.ownship === 'held') return `POSITION HELD · ${st.holdRemainingS} s`;
        if (st.ownship === 'hidden') return 'POSITION LOST';
        if (st.ownship === 'none') return 'NO FIX YET';
        return 'POSITION LIVE';
    }

    /** HH:MM:SS, 24 h, tablet local time. */
    static clock(ms) {
        if (ms == null) return '';
        const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    static duration(s) {
        if (s < 90) return `${s} s`;
        if (s < 5400) return `${Math.round(s / 60)} min`;
        return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
    }

    destroy() {
        this._monitor.removeEventListener('change', this._onChange);
        this._el.remove();
    }
}

PositionHealthPanel.HISTORY_SHOWN = 10;
PositionHealthPanel.CAUSE_LABELS = {
    'vpn': 'VPN on',
    'gps-nofix': 'Stratux GPS no fix',
    'engine-gps': 'Engine-monitor position',
    'link-tablet': 'Tablet Wi-Fi (Stratux and engine monitor both lost)',
    'link-stratux': 'At the Stratux (engine monitor still connected)',
    'link': 'No data from Stratux',
    'device-gps': "Tablet's own GPS in use",
};
