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
        this._el.querySelector('.aap-dismiss').addEventListener('click', () => this._advance());
    }

    mount(container) {
        container.appendChild(this._el);
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
        const mandatoryCall = (kind === 'airspace' && ['B', 'C', 'D'].includes(record.class)) || kind === 'trsa';

        titleEl.textContent = kind === 'trsa'
            ? `Entering TRSA — ${record.name}`
            : mandatoryCall
                ? `Entering Class ${record.class} — ${record.name}`
                : `Approaching ${record.name}`;

        if (kind === 'trsa') {
            const freqs = Array.isArray(record.freqs) ? record.freqs : [];
            if (freqs.length > 0) {
                freqEl.textContent = freqs.length > 1
                    ? `${record.facility_name} ${freqs.join(' / ')} (sector — verify)`
                    : `${record.facility_name} ${freqs[0]}`;
                freqEl.style.display = '';
            } else {
                freqEl.style.display = 'none';
            }
        } else if (record.controlling_freq) {
            freqEl.textContent = `${record.controlling_freq.facility_name} ${record.controlling_freq.freq}`;
            freqEl.style.display = '';
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

        this._el.style.display = '';
    }

    dismiss() {
        this._queue = [];
        this._el.style.display = 'none';
    }
}
