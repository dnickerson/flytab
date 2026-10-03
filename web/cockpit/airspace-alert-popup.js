/**
 * FlyTab — Airspace Alert Popup
 * Non-blocking banner shown as the aircraft approaches Class B/C/D/E
 * airspace, SUA, or a TRSA. Queues multiple simultaneous alerts rather
 * than stacking them on screen.
 */
class AirspaceAlertPopup {
    constructor() {
        this._el = null;
        this._queue = [];
        this._buildDOM();
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'airspace-alert-popup';
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="aap-header">
                <span class="aap-title"></span>
                <button class="aap-dismiss" aria-label="Dismiss">&times;</button>
            </div>
            <div class="aap-freq"></div>
            <div class="aap-advisory"></div>
        `;
        // wireTap, not addEventListener('click', ...): this popup is mounted
        // directly into the Leaflet map container, and other cockpit
        // components (vector-map-layers.js, fisb-weather.js) register
        // capture:true touchstart listeners on that same container that fire
        // before any click ever reaches this button -- see mount() and the
        // guards added to those two files for the other half of the fix.
        wireTap(this._el.querySelector('.aap-dismiss'), () => this._advance());
    }

    mount(container) {
        container.appendChild(this._el);
        // Stops Leaflet's own click handling from treating a tap that lands
        // on this popup as a map click (same pattern as approach-charts.js's
        // plate toggle button, the one other button appended directly into
        // the map container).
        L.DomEvent.disableClickPropagation(this._el);
    }

    show(record, kind) {
        this._queue.push({ record, kind });
        if (this._queue.length === 1) this._render();
    }

    _advance() {
        this._queue.shift();
        if (this._queue.length > 0) this._render();
        else this._el.style.display = 'none';
    }

    _render() {
        const { record, kind } = this._queue[0];
        const titleEl = this._el.querySelector('.aap-title');
        const freqEl = this._el.querySelector('.aap-freq');
        const advisoryEl = this._el.querySelector('.aap-advisory');
        const mandatoryCall = kind === 'airspace' && ['B', 'C', 'D'].includes(record.class);

        titleEl.textContent = kind === 'trsa'
            ? `Entering TRSA — ${record.name}`
            : mandatoryCall
                ? `Entering Class ${record.class} — ${record.name}`
                : `Approaching ${record.name}`;

        if (kind === 'trsa') {
            const freqs = Array.isArray(record.freqs) ? record.freqs : [];
            if (freqs.length > 0) {
                // Each entry is {freq, sector?} (build_trsa_records() in
                // flytab-pipeline) -- sector is the raw TWR3 sectorization
                // suffix (degree range, compass point, altitude split, or
                // combined -- no single fixed format) and must not be
                // discarded: the whole reason this field is a list of
                // objects instead of a list of strings is so a sectorized
                // TRSA (e.g. ILM: 118.25 for one arrival sector, 135.75 for
                // the other) can show which frequency covers which sector.
                // Joining/template-literal-ing an entry directly renders
                // "[object Object]" -- always pull .freq (and .sector) out.
                const freqStrs = freqs.map(f => f.sector ? `${f.freq} (${f.sector})` : f.freq);
                freqEl.textContent = freqs.length > 1
                    ? `${record.facility_name} ${freqStrs.join(' / ')}`
                    : `${record.facility_name} ${freqStrs[0]}`;
                freqEl.style.display = '';
            } else {
                freqEl.style.display = 'none';
            }
        } else if (record.controlling_freq) {
            // controlling_freq.freqs is always a list (_pick_freq() in
            // flytab-pipeline) -- an airport can publish more than one
            // frequency of the winning type (e.g. multiple APP frequencies).
            // There is no singular .freq field. Array.isArray guards against
            // an older bundle built before this pipeline fix, which shipped
            // controlling_freq.freq as a single string.
            const cfreqs = Array.isArray(record.controlling_freq.freqs) ? record.controlling_freq.freqs : [];
            if (cfreqs.length > 0) {
                freqEl.textContent = `${record.controlling_freq.facility_name} ${cfreqs.join(' / ')}`;
                freqEl.style.display = '';
            } else {
                freqEl.style.display = 'none';
            }
        } else {
            freqEl.style.display = 'none';
        }

        if (kind === 'trsa') {
            // Always show this for TRSA -- record.approximate is always
            // true per the pipeline's build_trsa_records(), but checking
            // it explicitly rather than hardcoding keeps this resilient if
            // that ever changes.
            advisoryEl.textContent = record.approximate
                ? 'Approximate boundary — verify on sectional chart'
                : '';
            advisoryEl.style.display = record.approximate ? '' : 'none';
        } else if (kind === 'sua') {
            advisoryEl.textContent = record.active_times
                ? `Active: ${record.active_times}`
                : 'Schedule unknown — verify NOTAMs before entry';
            advisoryEl.style.display = '';
        } else if (!record.controlling_freq) {
            // Class E surface areas frequently sit around non-towered
            // fields -- no controlling_freq there is a permanent, correct
            // absence (find_controlling_airport requires a towered field
            // inside the boundary), not a data-staleness problem. Only
            // B/C/D are essentially guaranteed to have a match when the
            // bundle is current, so "update the bundle" is only honest
            // advice for those classes.
            advisoryEl.textContent = record.class === 'E'
                ? 'No published frequency for this area'
                : 'No frequency data — update NASR bundle';
            advisoryEl.style.display = '';
        } else {
            advisoryEl.style.display = 'none';
        }

        // Position below the convective-alerts panel's actual current
        // height rather than trusting the fixed top:160px in style.css.
        // Both panels are position:absolute in the same map container with
        // the same z-index:950, and convective-alerts.js can stack multiple
        // rows (route alerts + up to 3 OAT signals) well past 104px tall --
        // a fixed offset lets this popup paint over it when both fire
        // together (e.g. near a Class B shelf during active convective
        // weather), which has no dismiss button of its own.
        const convPanel = this._el.parentNode?.querySelector('.conv-alerts-panel');
        const container = this._el.parentNode;
        const convBottom = (convPanel && container && convPanel.style.display !== 'none')
            ? convPanel.getBoundingClientRect().bottom - container.getBoundingClientRect().top
            : 0;
        this._el.style.top = `${Math.max(160, convBottom + 8)}px`;

        this._el.style.display = '';
    }

    dismiss() {
        this._queue = [];
        this._el.style.display = 'none';
    }
}
