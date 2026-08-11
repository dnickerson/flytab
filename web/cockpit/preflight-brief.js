/**
 * FlyTab — PreflightBrief
 * Full-screen overlay displaying the cached preflight brief bundle.
 * Shows a large GO / CAUTION / NO-GO verdict badge, tabbed detail sections,
 * and a staleness indicator when the brief is > 4 hours old.
 *
 * Public API:
 *   show(bundle)  — display overlay with bundle
 *   hide()        — close overlay
 *
 * Wire-up: window.preflightBrief = new PreflightBrief()
 */

class PreflightBrief {
    constructor() {
        this._el = null;
        this._visible = false;
        this._bundle = null;
        this._activeTab = 'summary';
        this._buildDOM();
    }

    // ── DOM ───────────────────────────────────────────────────────────────────

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'pfb-overlay';
        this._el.style.display = 'none';
        this._el.innerHTML = `
            <div class="pfb-container">
                <div class="pfb-header">
                    <span class="pfb-title">PREFLIGHT BRIEF</span>
                    <button class="btn-close ep-close pfb-close">MAP</button>
                </div>
                <div class="pfb-verdict-row" id="pfb-verdict-row">
                    <span class="pfb-verdict-badge" id="pfb-verdict-badge">—</span>
                    <span class="pfb-stale-notice" id="pfb-stale-notice" style="display:none">⚠ BRIEF STALE — REFRESH BEFORE FLIGHT</span>
                    <span class="pfb-generated-at" id="pfb-generated-at"></span>
                </div>
                <div class="pfb-tabs" id="pfb-tabs">
                    <button class="pfb-tab pfb-tab-active" data-tab="summary">Summary</button>
                    <button class="pfb-tab" data-tab="weather">Weather</button>
                    <button class="pfb-tab" data-tab="notams">NOTAMs</button>
                    <button class="pfb-tab" data-tab="airspace">Airspace</button>
                    <button class="pfb-tab" data-tab="winds">Winds</button>
                    <button class="pfb-tab" data-tab="advisories">Advisories</button>
                </div>
                <div class="pfb-body" id="pfb-body"></div>
            </div>
        `;

        // Close button
        const closeBtn = this._el.querySelector('.pfb-close');
        closeBtn.addEventListener('touchstart', (e) => { e.stopPropagation(); this.hide(); }, { passive: true });
        closeBtn.addEventListener('click', () => this.hide());

        // Tab buttons
        const tabBar = this._el.querySelector('#pfb-tabs');
        tabBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.pfb-tab');
            if (!btn) return;
            this._switchTab(btn.dataset.tab);
        });
        tabBar.addEventListener('touchstart', (e) => {
            const btn = e.target.closest('.pfb-tab');
            if (!btn) return;
            e.stopPropagation();
            this._switchTab(btn.dataset.tab);
        }, { passive: true });

        this._injectStyles();
        document.body.appendChild(this._el);
    }

    _injectStyles() {
        if (document.getElementById('pfb-styles')) return;
        const style = document.createElement('style');
        style.id = 'pfb-styles';
        style.textContent = `
            .pfb-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                z-index: 2200;
                background: var(--bg-primary);
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            .pfb-container {
                display: flex;
                flex-direction: column;
                height: 100%;
                max-height: 100%;
            }
            .pfb-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                background: var(--bg-surface);
                border-bottom: 1px solid var(--border);
                flex-shrink: 0;
            }
            .pfb-title {
                font-size: var(--text-lg, 18px);
                font-weight: 700;
                color: var(--text-primary);
                letter-spacing: 0.08em;
            }
            .pfb-verdict-row {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 14px 16px;
                background: var(--bg-surface);
                border-bottom: 2px solid var(--border-strong);
                flex-shrink: 0;
                flex-wrap: wrap;
            }
            .pfb-verdict-badge {
                font-size: 28px;
                font-weight: 900;
                letter-spacing: 0.12em;
                padding: 6px 20px;
                border-radius: 6px;
                border: 2px solid currentColor;
                min-width: 110px;
                text-align: center;
            }
            .pfb-verdict-go    { color: var(--status-ok);      border-color: var(--status-ok); }
            .pfb-verdict-caution { color: var(--status-caution); border-color: var(--status-caution); }
            .pfb-verdict-nogo  { color: var(--status-danger);   border-color: var(--status-danger); }
            .pfb-stale-notice {
                font-size: var(--text-sm, 16px);
                font-weight: 700;
                color: var(--status-warning);
                letter-spacing: 0.04em;
            }
            .pfb-generated-at {
                font-size: var(--text-xs, 14px);
                color: var(--text-muted);
                margin-left: auto;
            }
            .pfb-tabs {
                display: flex;
                gap: 0;
                background: var(--bg-surface);
                border-bottom: 1px solid var(--border);
                overflow-x: auto;
                flex-shrink: 0;
            }
            .pfb-tab {
                padding: 10px 14px;
                font-size: var(--text-sm, 16px);
                font-weight: 600;
                color: var(--text-label);
                background: transparent;
                border: none;
                border-bottom: 3px solid transparent;
                cursor: pointer;
                white-space: nowrap;
                min-height: var(--touch-min, 48px);
            }
            .pfb-tab-active {
                color: var(--accent);
                border-bottom-color: var(--accent);
            }
            .pfb-body {
                flex: 1;
                overflow-y: auto;
                padding: 16px;
                -webkit-overflow-scrolling: touch;
            }
            .pfb-section-label {
                font-size: var(--text-xs, 14px);
                color: var(--text-muted);
                letter-spacing: 0.1em;
                text-transform: uppercase;
                margin: 18px 0 6px;
            }
            .pfb-section-label:first-child { margin-top: 0; }
            .pfb-summary-text {
                font-size: var(--text-base, 17px);
                color: var(--text-secondary);
                line-height: 1.55;
                margin-bottom: 16px;
            }
            .pfb-item {
                background: var(--bg-surface-raised);
                border-radius: 6px;
                padding: 12px 14px;
                margin-bottom: 10px;
                border-left: 4px solid var(--border);
            }
            .pfb-item-info     { border-left-color: var(--accent); }
            .pfb-item-caution  { border-left-color: var(--status-caution); }
            .pfb-item-warning  { border-left-color: var(--status-warning); }
            .pfb-item-blocking { border-left-color: var(--status-danger); }
            .pfb-item-title {
                font-size: var(--text-base, 17px);
                font-weight: 700;
                color: var(--text-primary);
                margin-bottom: 4px;
            }
            .pfb-item-detail {
                font-size: var(--text-sm, 16px);
                color: var(--text-secondary);
                line-height: 1.45;
            }
            .pfb-item-cat {
                font-size: var(--text-xs, 14px);
                color: var(--text-muted);
                margin-bottom: 4px;
                letter-spacing: 0.06em;
            }
            .pfb-go-window {
                background: var(--bg-surface);
                border: 1px solid var(--border-strong);
                border-radius: 6px;
                padding: 10px 14px;
                margin-bottom: 10px;
                font-size: var(--text-sm, 16px);
                color: var(--text-secondary);
            }
            .pfb-go-window strong { color: var(--status-ok); }
            .pfb-metar-block {
                background: var(--bg-surface-raised);
                border-radius: 6px;
                padding: 10px 14px;
                margin-bottom: 10px;
                font-family: var(--font-mono, monospace);
                font-size: var(--text-sm, 16px);
                color: var(--text-secondary);
                white-space: pre-wrap;
                word-break: break-all;
            }
            .pfb-metar-icao {
                color: var(--accent);
                font-weight: 700;
                font-size: var(--text-base, 17px);
                margin-bottom: 4px;
            }
            .pfb-flight-cat {
                display: inline-block;
                padding: 1px 8px;
                border-radius: 4px;
                font-size: var(--text-xs, 14px);
                font-weight: 700;
                margin-left: 8px;
                vertical-align: middle;
            }
            .pfb-cat-vfr  { background: var(--cat-vfr);  color: #000; }
            .pfb-cat-mvfr { background: var(--cat-mvfr); color: #000; }
            .pfb-cat-ifr  { background: var(--cat-ifr);  color: #fff; }
            .pfb-cat-lifr { background: var(--cat-lifr); color: #fff; }
            .pfb-notam-entry {
                background: var(--bg-surface-raised);
                border-radius: 6px;
                padding: 10px 14px;
                margin-bottom: 8px;
            }
            .pfb-notam-header {
                font-size: var(--text-xs, 14px);
                color: var(--text-muted);
                margin-bottom: 4px;
            }
            .pfb-notam-text {
                font-size: var(--text-sm, 16px);
                color: var(--text-secondary);
                white-space: pre-wrap;
                word-break: break-all;
                font-family: var(--font-mono, monospace);
            }
            .pfb-winds-block {
                background: var(--bg-surface-raised);
                border-radius: 6px;
                padding: 12px 14px;
                font-family: var(--font-mono, monospace);
                font-size: var(--text-sm, 16px);
                color: var(--text-secondary);
                white-space: pre-wrap;
                word-break: break-all;
            }
            .pfb-empty {
                color: var(--text-muted);
                font-size: var(--text-sm, 16px);
                font-style: italic;
                padding: 12px 0;
            }
        `;
        document.head.appendChild(style);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    show(bundle) {
        this._bundle = bundle;
        this._activeTab = 'summary';
        this._render();
        this._el.style.display = 'flex';
        this._visible = true;
    }

    hide() {
        this._el.style.display = 'none';
        this._visible = false;
    }

    // ── Rendering ──────────────────────────────────────────────────────────────

    _render() {
        if (!this._bundle) return;
        const b = this._bundle;

        // Verdict badge
        const badge = this._el.querySelector('#pfb-verdict-badge');
        badge.textContent = b.verdict ?? '—';
        badge.className = 'pfb-verdict-badge';
        if (b.verdict === 'GO')      badge.classList.add('pfb-verdict-go');
        else if (b.verdict === 'NO-GO') badge.classList.add('pfb-verdict-nogo');
        else                            badge.classList.add('pfb-verdict-caution');

        // Staleness
        const staleEl = this._el.querySelector('#pfb-stale-notice');
        const genEl   = this._el.querySelector('#pfb-generated-at');
        const STALE_MS = 4 * 60 * 60 * 1000;
        if (b.generated_at) {
            const ageMs = Date.now() - new Date(b.generated_at).getTime();
            staleEl.style.display = ageMs > STALE_MS ? '' : 'none';
            genEl.textContent = 'Briefed ' + _relativeTime(b.generated_at);
        } else {
            staleEl.style.display = 'none';
            genEl.textContent = '';
        }

        // Mark active tab
        this._el.querySelectorAll('.pfb-tab').forEach(btn => {
            btn.classList.toggle('pfb-tab-active', btn.dataset.tab === this._activeTab);
        });

        // Render tab content
        this._renderTab(this._activeTab);
    }

    _switchTab(tab) {
        this._activeTab = tab;
        this._el.querySelectorAll('.pfb-tab').forEach(btn => {
            btn.classList.toggle('pfb-tab-active', btn.dataset.tab === tab);
        });
        this._renderTab(tab);
    }

    _renderTab(tab) {
        const body = this._el.querySelector('#pfb-body');
        const b = this._bundle;
        if (!b) { body.innerHTML = ''; return; }

        switch (tab) {
            case 'summary':    body.innerHTML = this._renderSummary(b); break;
            case 'weather':    body.innerHTML = this._renderWeather(b); break;
            case 'notams':     body.innerHTML = this._renderNotams(b); break;
            case 'airspace':   body.innerHTML = this._renderAirspace(b); break;
            case 'winds':      body.innerHTML = this._renderWinds(b); break;
            case 'advisories': body.innerHTML = this._renderAdvisories(b); break;
            default:           body.innerHTML = '';
        }
    }

    _renderSummary(b) {
        const ai = b.ai_summary ?? {};
        let html = '';

        // AI summary text
        if (ai.summary) {
            html += `<div class="pfb-summary-text">${_esc(ai.summary)}</div>`;
        }

        // Go window
        if (ai.go_window) {
            html += `<div class="pfb-go-window"><strong>Best window:</strong> ${_esc(ai.go_window)}</div>`;
        }

        // Alternate recommendation
        if (ai.alternate_recommendation) {
            html += `<div class="pfb-go-window"><strong>Alternate:</strong> ${_esc(ai.alternate_recommendation)}</div>`;
        }

        // All items
        if (ai.items?.length) {
            html += '<div class="pfb-section-label">Findings</div>';
            for (const item of ai.items) {
                html += _renderItem(item);
            }
        } else {
            html += '<div class="pfb-empty">No significant findings.</div>';
        }

        return html;
    }

    _renderWeather(b) {
        const raw = b.raw ?? {};
        let html = '';

        // Flight categories
        const fc = raw.flight_category ?? {};
        if (fc.dep || fc.dest) {
            html += '<div class="pfb-section-label">Flight Categories</div>';
            if (fc.dep) html += `<div class="pfb-metar-block"><span class="pfb-metar-icao">DEP${_catBadge(fc.dep)}</span></div>`;
            if (fc.dest) html += `<div class="pfb-metar-block"><span class="pfb-metar-icao">DEST${_catBadge(fc.dest)}</span></div>`;
        }

        // METARs
        const metars = raw.metars ?? [];
        if (metars.length) {
            html += '<div class="pfb-section-label">METARs</div>';
            for (const m of metars) {
                const raw_text = m.rawOb ?? m.raw_text ?? JSON.stringify(m);
                html += `<div class="pfb-metar-block"><span class="pfb-metar-icao">${_esc(m.stationId ?? m.station_id ?? '?')}</span>\n${_esc(raw_text)}</div>`;
            }
        }

        // TAFs
        const tafs = raw.tafs ?? [];
        if (tafs.length) {
            html += '<div class="pfb-section-label">TAFs</div>';
            for (const t of tafs) {
                const raw_text = t.rawTAF ?? t.raw_text ?? JSON.stringify(t);
                html += `<div class="pfb-metar-block"><span class="pfb-metar-icao">${_esc(t.stationId ?? t.station_id ?? '?')}</span>\n${_esc(raw_text)}</div>`;
            }
        }

        if (!metars.length && !tafs.length) {
            html += '<div class="pfb-empty">No METAR/TAF data.</div>';
        }

        return html;
    }

    _renderNotams(b) {
        const raw = b.raw ?? {};
        const notams = raw.notams ?? {};
        let html = '';

        const sections = [
            { label: 'Departure', items: notams.departure ?? [] },
            { label: 'Destination', items: notams.destination ?? [] },
            { label: 'Enroute', items: notams.enroute ?? [] },
            { label: 'FDC', items: notams.fdc ?? [] },
        ];

        for (const sec of sections) {
            if (!sec.items.length) continue;
            html += `<div class="pfb-section-label">${sec.label} (${sec.items.length})</div>`;
            for (const n of sec.items) {
                html += `<div class="pfb-notam-entry">
                    <div class="pfb-notam-header">${_esc(n.number || n.id || '')} · ${_esc(n.location || '')} · ${_esc(n.effectiveStart || '')}${n.effectiveEnd ? ' – ' + _esc(n.effectiveEnd) : ''}</div>
                    <div class="pfb-notam-text">${_esc(n.plain || n.text || '')}</div>
                </div>`;
            }
        }

        const tfrs = raw.tfrs ?? [];
        if (tfrs.length) {
            html += `<div class="pfb-section-label">TFRs (${tfrs.length})</div>`;
            for (const t of tfrs) {
                html += `<div class="pfb-notam-entry">
                    <div class="pfb-notam-header">${_esc(t.number || t.id || '')} · ${_esc(t.effectiveStart || '')}</div>
                    <div class="pfb-notam-text">${_esc(t.plain || t.text || '')}</div>
                </div>`;
            }
        }

        if (!html) {
            html = '<div class="pfb-empty">No NOTAMs or TFRs.</div>';
        }

        return html;
    }

    _renderAirspace(b) {
        const ai = b.ai_summary ?? {};
        const raw = b.raw ?? {};
        let html = '';

        // Airspace items from AI
        const airspaceItems = (ai.items ?? []).filter(i => i.category === 'AIRSPACE' || i.category === 'TFR');
        if (airspaceItems.length) {
            html += '<div class="pfb-section-label">Airspace Advisories</div>';
            for (const item of airspaceItems) {
                html += _renderItem(item);
            }
        }

        // G-AIRMETs
        const gairmets = raw.gairmets ?? [];
        if (gairmets.length) {
            html += `<div class="pfb-section-label">G-AIRMETs (${gairmets.length})</div>`;
            for (const g of gairmets.slice(0, 20)) {
                const hazard = g.hazard ?? g.airSigmetType ?? 'AIRMET';
                const text = g.rawAirSigmet ?? g.alphaChar ?? JSON.stringify(g).slice(0, 200);
                html += `<div class="pfb-item pfb-item-caution">
                    <div class="pfb-item-cat">${_esc(hazard)}</div>
                    <div class="pfb-item-detail">${_esc(text)}</div>
                </div>`;
            }
        }

        if (!html) {
            html = '<div class="pfb-empty">No airspace advisories.</div>';
        }

        return html;
    }

    _renderWinds(b) {
        const raw = b.raw ?? {};
        let html = '';

        // Wind items from AI
        const ai = b.ai_summary ?? {};
        const windItems = (ai.items ?? []).filter(i => i.category === 'WINDS');
        if (windItems.length) {
            html += '<div class="pfb-section-label">Winds Assessment</div>';
            for (const item of windItems) {
                html += _renderItem(item);
            }
        }

        const winds = raw.winds_aloft ?? '';
        if (winds) {
            html += '<div class="pfb-section-label">Winds Aloft Forecast</div>';
            html += `<div class="pfb-winds-block">${_esc(winds.slice(0, 3000))}</div>`;
        } else {
            html += '<div class="pfb-empty">Winds aloft data unavailable.</div>';
        }

        return html;
    }

    _renderAdvisories(b) {
        const raw = b.raw ?? {};
        const ai = b.ai_summary ?? {};
        let html = '';

        // AIRMETs + SIGMETs from AI items
        const advisoryItems = (ai.items ?? []).filter(i =>
            i.category === 'WEATHER' || i.category === 'CONVECTIVE' || i.category === 'OTHER'
        );
        if (advisoryItems.length) {
            html += '<div class="pfb-section-label">AI Advisory Items</div>';
            for (const item of advisoryItems) {
                html += _renderItem(item);
            }
        }

        // SIGMETs
        const sigmets = raw.sigmets ?? [];
        if (sigmets.length) {
            html += `<div class="pfb-section-label">SIGMETs (${sigmets.length})</div>`;
            for (const s of sigmets.slice(0, 10)) {
                const text = s.rawAirSigmet ?? JSON.stringify(s).slice(0, 300);
                html += `<div class="pfb-item pfb-item-warning">
                    <div class="pfb-item-detail">${_esc(text)}</div>
                </div>`;
            }
        }

        // AIRMETs
        const airmets = raw.airmets ?? [];
        if (airmets.length) {
            html += `<div class="pfb-section-label">AIRMETs (${airmets.length})</div>`;
            for (const a of airmets.slice(0, 20)) {
                const text = a.rawAirSigmet ?? JSON.stringify(a).slice(0, 300);
                html += `<div class="pfb-item pfb-item-caution">
                    <div class="pfb-item-detail">${_esc(text)}</div>
                </div>`;
            }
        }

        // Convective outlook
        const convective = raw.convective_outlook ?? '';
        if (convective) {
            html += '<div class="pfb-section-label">Convective Outlook</div>';
            html += `<div class="pfb-winds-block">${_esc(convective.slice(0, 2000))}</div>`;
        }

        if (!html) {
            html = '<div class="pfb-empty">No advisories.</div>';
        }

        return html;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _renderItem(item) {
    const sevClass = {
        INFO: 'pfb-item-info',
        CAUTION: 'pfb-item-caution',
        WARNING: 'pfb-item-warning',
        BLOCKING: 'pfb-item-blocking',
    }[item.severity] || 'pfb-item-info';

    return `<div class="pfb-item ${sevClass}">
        <div class="pfb-item-cat">${_esc(item.category)} · ${_esc(item.severity)}</div>
        <div class="pfb-item-title">${_esc(item.title)}</div>
        <div class="pfb-item-detail">${_esc(item.detail)}</div>
    </div>`;
}

function _catBadge(cat) {
    if (!cat) return '';
    const cls = { VFR: 'pfb-cat-vfr', MVFR: 'pfb-cat-mvfr', IFR: 'pfb-cat-ifr', LIFR: 'pfb-cat-lifr' }[cat] || '';
    return ` <span class="pfb-flight-cat ${cls}">${_esc(cat)}</span>`;
}

function _relativeTime(isoStr) {
    if (!isoStr) return '';
    const ageMs = Date.now() - new Date(isoStr).getTime();
    const mins = Math.round(ageMs / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${hrs}h ${rem}m ago` : `${hrs}h ago`;
}
