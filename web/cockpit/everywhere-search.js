/**
 * EverywhereSearch — plain-language search across airports, navaids, fixes,
 * airways, and CIFP procedures. Runs entirely offline.
 *
 * Tapping a result row opens a full-screen detail overlay with all available
 * data and a fixed action bar at the bottom.
 */
class EverywhereSearch {
    constructor(nasrDb, stratuxClient) {
        this._nasrDb = nasrDb;
        this._stratuxClient = stratuxClient;
        this._approachCharts = null;
        this._routeTable = null;
        this._airportPopup = null;
        this._cockpitMap = null;
        this._getActiveTrip = null;

        this._overlay = null;
        this._input = null;
        this._resultsList = null;
        this._detailOverlay = null;
        this._debounceTimer = null;
        this._lastQuery = '';

        this._RECENT_KEY = 'flypi_search_recent';
        this._RECENT_MAX = 10;
    }

    setApproachCharts(ac)   { this._approachCharts = ac; }
    setRouteTable(rt)       { this._routeTable = rt; }
    setAirportPopup(ap)     { this._airportPopup = ap; }
    setCockpitMap(cm)       { this._cockpitMap = cm; }
    setGetActiveTrip(fn)    { this._getActiveTrip = fn; }

    show() {
        if (!this._overlay) this._buildOverlay();
        this._overlay.style.display = 'flex';
        setTimeout(() => this._input?.focus(), 100);
        this._renderRecents();
    }

    hide() {
        this._hideDetail();
        if (this._overlay) this._overlay.style.display = 'none';
        if (this._input) this._input.value = '';
        this._lastQuery = '';
        clearTimeout(this._debounceTimer);
    }

    toggle() {
        if (this._overlay && this._overlay.style.display !== 'none') {
            this.hide();
        } else {
            this.show();
        }
    }

    // ── Search overlay ───────────────────────────────────────────────────────

    _buildOverlay() {
        const overlay = document.createElement('div');
        overlay.className = 'esearch-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99990;background:var(--bg-primary);display:none;flex-direction:column;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;padding:8px 10px;gap:8px;border-bottom:2px solid var(--border-strong);flex-shrink:0;';

        const input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Airport, navaid, fix, airway, or procedure…';
        input.autocomplete = 'off';
        input.autocorrect = 'off';
        input.autocapitalize = 'characters';
        input.spellcheck = false;
        input.style.cssText = 'flex:1;font-size:22px;font-weight:600;padding:10px 12px;border:2px solid var(--border-strong);border-radius:8px;background:var(--bg-surface);color:var(--text-primary);min-height:var(--touch-min,56px);outline:none;';
        input.addEventListener('input', () => this._onInput(input.value));
        input.addEventListener('focus', () => {
            if (!input.value.trim()) this._renderRecents();
        });
        this._input = input;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-close';
        closeBtn.innerHTML = '&#x2715;';
        wireTap(closeBtn, () => this.hide());

        header.appendChild(input);
        header.appendChild(closeBtn);
        overlay.appendChild(header);

        const list = document.createElement('div');
        list.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;';
        this._resultsList = list;
        overlay.appendChild(list);

        document.body.appendChild(overlay);
        this._overlay = overlay;
    }

    _onInput(value) {
        clearTimeout(this._debounceTimer);
        const q = value.trim();
        if (!q) { this._renderRecents(); return; }
        this._debounceTimer = setTimeout(() => this._runSearch(q), 150);
    }

    // ── Search execution ─────────────────────────────────────────────────────

    async _runSearch(query) {
        if (query === this._lastQuery) return;
        this._lastQuery = query;

        const q = query.toUpperCase();
        const procQuery = this._parseProcedureQuery(q);

        const [dbResults, procResults] = await Promise.all([
            this._nasrDb.searchAllExtended(query, 20).catch(() => ({ airports: [], navaids: [], fixes: [], airways: [] })),
            procQuery ? this._searchProcedures(procQuery) : [],
        ]);

        const ownPos = this._getOwnPos();
        const ranked = this._rankResults(dbResults, q, ownPos);
        const all = [...procResults, ...ranked];

        if (query !== this._lastQuery) return;
        this._renderResults(all, query);
    }

    _getOwnPos() {
        const sit = this._stratuxClient?.situation;
        if (sit?.lat && sit?.lon && sit.gps_fix_quality > 0) {
            return { lat: sit.lat, lon: sit.lon };
        }
        return null;
    }

    // ── Ranking ──────────────────────────────────────────────────────────────

    _rankResults({ airports = [], navaids = [], fixes = [], airways = [] }, q, ownPos) {
        const score = (entity, type) => {
            const id   = (entity.icao || entity.id || entity.name || '').toUpperCase();
            const name = (entity.name || '').toUpperCase();
            const city = (entity.city || '').toUpperCase();

            let tier;
            if (id === q || 'K' + q === id)                          tier = 0;
            else if (id.startsWith(q) || id.startsWith('K' + q))     tier = 1;
            else if (name.startsWith(q))                              tier = 2;
            else if (city && city.startsWith(q))                      tier = 3;
            else                                                       tier = 4;

            const typePri = type === 'APT' ? 0 : type === 'NAV' ? 1 : type === 'FIX' ? 2 : 3;
            let dist = 0;
            if (ownPos && entity.lat != null && entity.lon != null)
                dist = this._distNm(ownPos.lat, ownPos.lon, entity.lat, entity.lon) / 10000;

            return tier + typePri * 0.0001 + dist;
        };

        const rows = [
            ...airports.map(e => ({ entity: e, type: 'APT', score: score(e, 'APT') })),
            ...navaids.map(e =>  ({ entity: e, type: 'NAV', score: score(e, 'NAV') })),
            ...fixes.map(e =>    ({ entity: e, type: 'FIX', score: score(e, 'FIX') })),
            ...airways.map(e =>  ({ entity: e, type: 'AWY', score: score(e, 'AWY') })),
        ];
        rows.sort((a, b) => a.score - b.score);
        return rows.slice(0, 30);
    }

    _distNm(lat1, lon1, lat2, lon2) {
        const dlat = (lat2 - lat1) * 60;
        const dlon = (lon2 - lon1) * 60 * Math.cos(lat1 * Math.PI / 180);
        return Math.sqrt(dlat * dlat + dlon * dlon);
    }

    // ── Procedure search ─────────────────────────────────────────────────────

    _parseProcedureQuery(q) {
        const upper = q.trim().toUpperCase();
        const PROC_TYPES = 'ILS|RNAV|VOR|NDB|LDA|LOC|GLS|GPS|TACAN';
        const RWY = '(\\d{1,2}[LRC]?)';
        const ICAO = '([A-Z][A-Z0-9]{2,3})';

        let m = upper.match(new RegExp(`(?:${PROC_TYPES})(?:\\s+GPS)?(?:\\s+(?:RWY|RY))?\\s*${RWY}\\s+${ICAO}$`, 'i'));
        if (m) {
            const typeMatch = upper.match(new RegExp(PROC_TYPES, 'i'));
            return { icao: m[2], procType: typeMatch?.[0] || '', runway: m[1] };
        }

        m = upper.match(new RegExp(`^${ICAO}\\s+(?:${PROC_TYPES})(?:\\s+(?:RWY|RY))?\\s*${RWY}$`, 'i'));
        if (m) {
            const typeMatch = upper.match(new RegExp(PROC_TYPES, 'i'));
            return { icao: m[1], procType: typeMatch?.[0] || '', runway: m[2] };
        }

        m = upper.match(new RegExp(`^([RIVNL])(\\d{1,2}[LRC]?)\\s+${ICAO}$`, 'i'));
        if (m) {
            const typeMap = { I: 'ILS', R: 'RNAV', V: 'VOR', N: 'NDB', L: 'LDA' };
            return { icao: m[3], procType: typeMap[m[1].toUpperCase()] || '', runway: m[2] };
        }

        return null;
    }

    _searchProcedures({ icao, procType, runway }) {
        if (!this._approachCharts?._cifpBundle) return [];
        const bundle = this._approachCharts._cifpBundle[icao.toUpperCase()];
        if (!bundle?.procedures) return [];

        const rwNum = runway.replace(/[LRC]$/i, '').padStart(2, '0');
        const rwSuffix = runway.match(/[LRC]$/i)?.[0]?.toUpperCase() || '';

        const procs = bundle.procedures.map(p => ({
            proc_name: p.name || p.proc_name || '',
            proc_type: p.proc_type || 'APPROACH',
            transitions: p.transitions || [],
        }));

        return procs.filter(p => {
            const pn = p.proc_name.toUpperCase();
            return (pn.includes(rwNum) || pn.includes(parseInt(rwNum, 10).toString()))
                && (!procType || pn.includes(procType.toUpperCase()))
                && (!rwSuffix || pn.includes(rwSuffix));
        }).slice(0, 5).map(p => ({
            entity: { icao: icao.toUpperCase(), proc_name: p.proc_name, transitions: p.transitions, lat: null, lon: null },
            type: 'PROC',
            score: -1,
        }));
    }

    // ── Results list rendering ────────────────────────────────────────────────

    _renderResults(rows, query) {
        const list = this._resultsList;
        list.innerHTML = '';

        if (!rows.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:32px 16px;text-align:center;color:var(--text-label);font-size:16px;font-weight:600;';
            empty.textContent = 'No results for "' + query + '"';
            list.appendChild(empty);
            return;
        }

        for (const row of rows) list.appendChild(this._buildRow(row));
    }

    _renderRecents() {
        const recents = this._loadRecent();
        const list = this._resultsList;
        list.innerHTML = '';

        if (!recents.length) {
            const hint = document.createElement('div');
            hint.style.cssText = 'padding:32px 16px;text-align:center;color:var(--text-label);font-size:15px;font-weight:600;';
            hint.textContent = 'Search airports, navaids, fixes, airways, or procedures';
            list.appendChild(hint);
            return;
        }

        const hdr = document.createElement('div');
        hdr.style.cssText = 'padding:8px 16px 4px;font-size:12px;font-weight:700;color:var(--text-label);letter-spacing:0.08em;';
        hdr.textContent = 'RECENT';
        list.appendChild(hdr);

        const ownPos = this._getOwnPos();
        for (const r of recents) {
            const row = { entity: r, type: r.type || 'APT', score: 0 };
            if (ownPos && r.lat != null)
                row._dist = this._distNm(ownPos.lat, ownPos.lon, r.lat, r.lon);
            list.appendChild(this._buildRow(row));
        }
    }

    _buildRow({ entity, type, score, _dist }) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;padding:12px 14px;border-bottom:1px solid var(--border-light);gap:12px;min-height:64px;cursor:pointer;active-background:var(--bg-surface);';

        const badge = document.createElement('span');
        badge.textContent = type;
        badge.style.cssText = 'font-size:11px;font-weight:700;padding:3px 7px;border-radius:4px;background:var(--accent);color:var(--text-on-accent);letter-spacing:0.06em;flex-shrink:0;';

        const middle = document.createElement('div');
        middle.style.cssText = 'flex:1;min-width:0;';

        const ident = document.createElement('div');
        ident.textContent = entity.icao || entity.id || entity.proc_name || entity.name || '';
        ident.style.cssText = 'font-size:18px;font-weight:700;color:var(--text-primary);';

        const sub = document.createElement('div');
        const subParts = [];
        if (type !== 'PROC' && entity.name && entity.name !== ident.textContent) subParts.push(entity.name);
        if (entity.city) subParts.push(entity.city + (entity.state ? ', ' + entity.state : ''));
        sub.textContent = subParts.join(' · ');
        sub.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

        middle.appendChild(ident);
        if (sub.textContent) middle.appendChild(sub);

        const right = document.createElement('div');
        right.style.cssText = 'text-align:right;flex-shrink:0;';

        const ownPos = this._getOwnPos();
        const distVal = _dist != null ? _dist : (entity.lat != null && ownPos ? this._distNm(ownPos.lat, ownPos.lon, entity.lat, entity.lon) : null);
        if (distVal != null) {
            const dist = document.createElement('div');
            dist.textContent = Math.round(distVal) + ' nm';
            dist.style.cssText = 'font-size:14px;font-weight:700;color:var(--text-label);';
            right.appendChild(dist);
        }

        const chevron = document.createElement('div');
        chevron.textContent = '›';
        chevron.style.cssText = 'font-size:22px;font-weight:700;color:var(--accent);line-height:1;';
        right.appendChild(chevron);

        row.appendChild(badge);
        row.appendChild(middle);
        row.appendChild(right);

        wireTap(row, () => this._showDetail(entity, type));

        return row;
    }

    // ── Detail overlay ───────────────────────────────────────────────────────

    _showDetail(entity, type) {
        this._hideDetail();

        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99991;background:var(--bg-primary);display:flex;flex-direction:column;';

        // Header: back + badge + title on left, ✕ on right
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:2px solid var(--border-strong);flex-shrink:0;';

        const backBtn = document.createElement('button');
        backBtn.innerHTML = '&#x2190;';
        backBtn.style.cssText = 'min-width:var(--touch-min,56px);min-height:var(--touch-min,56px);font-size:26px;font-weight:700;background:transparent;border:none;color:var(--accent);flex-shrink:0;cursor:pointer;';
        wireTap(backBtn, () => this._hideDetail());

        const badge = document.createElement('span');
        badge.textContent = type;
        badge.style.cssText = 'font-size:12px;font-weight:700;padding:3px 8px;border-radius:4px;background:var(--accent);color:var(--text-on-accent);letter-spacing:0.06em;flex-shrink:0;';

        const title = document.createElement('div');
        title.style.cssText = 'flex:1;min-width:0;';

        const titleIdent = document.createElement('div');
        titleIdent.textContent = entity.icao || entity.id || entity.proc_name || entity.name || '';
        titleIdent.style.cssText = 'font-size:20px;font-weight:700;color:var(--text-primary);';

        const titleName = document.createElement('div');
        titleName.textContent = type === 'PROC' ? (entity.transitions?.join(', ') || '') : (entity.name || '');
        titleName.style.cssText = 'font-size:13px;font-weight:600;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

        title.appendChild(titleIdent);
        if (titleName.textContent) title.appendChild(titleName);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'btn-close';
        closeBtn.innerHTML = '&#x2715;';
        wireTap(closeBtn, () => this.hide());

        header.appendChild(backBtn);
        header.appendChild(badge);
        header.appendChild(title);
        header.appendChild(closeBtn);
        overlay.appendChild(header);

        // Scrollable body
        const body = document.createElement('div');
        body.style.cssText = 'flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 0 8px;';
        body.innerHTML = this._buildDetailHtml(entity, type);
        overlay.appendChild(body);

        // Fixed action bar
        const actionBar = document.createElement('div');
        actionBar.style.cssText = 'flex-shrink:0;display:flex;gap:10px;padding:12px 14px;border-top:2px solid var(--border-strong);background:var(--bg-surface);';
        for (const btn of this._buildDetailActions(entity, type)) actionBar.appendChild(btn);
        overlay.appendChild(actionBar);

        document.body.appendChild(overlay);
        this._detailOverlay = overlay;
    }

    _hideDetail() {
        if (this._detailOverlay) {
            this._detailOverlay.remove();
            this._detailOverlay = null;
        }
    }

    _buildDetailHtml(entity, type) {
        switch (type) {
            case 'APT':  return this._aptDetailHtml(entity);
            case 'NAV':  return this._navDetailHtml(entity);
            case 'FIX':  return this._fixDetailHtml(entity);
            case 'AWY':  return this._awyDetailHtml(entity);
            case 'PROC': return this._procDetailHtml(entity);
            default:     return '';
        }
    }

    _aptDetailHtml(apt) {
        const sec = (title, content) =>
            `<div style="padding:14px 16px 0;">
                <div style="font-size:11px;font-weight:700;color:var(--text-label);letter-spacing:0.08em;margin-bottom:6px;">${title}</div>
                ${content}
            </div>`;

        const fact = (label, value) => value != null && value !== ''
            ? `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border-light);">
                <span style="font-size:13px;font-weight:600;color:var(--text-label);">${label}</span>
                <span style="font-size:15px;font-weight:700;color:var(--text-primary);">${value}</span>
               </div>`
            : '';

        let html = '';

        // Overview
        const ownPos = this._getOwnPos();
        const distVal = (apt.lat != null && ownPos) ? Math.round(this._distNm(ownPos.lat, ownPos.lon, apt.lat, apt.lon)) : null;
        const bearing = (apt.lat != null && ownPos) ? Math.round(this._bearing(ownPos.lat, ownPos.lon, apt.lat, apt.lon)) : null;

        const overviewFacts = [
            fact('City / State', [apt.city, apt.state].filter(Boolean).join(', ')),
            fact('Status',       apt.tower ? 'TOWERED' : 'UNCONTROLLED'),
            fact('Elevation',    apt.elev_ft != null ? apt.elev_ft + ' ft MSL' : null),
            fact('TPA',          apt.tpa_ft  ? apt.tpa_ft + ' ft MSL' : null),
            fact('Fuel',         apt.fuel    || null),
            fact('Distance',     distVal != null ? `${distVal} nm  ${bearing}°` : null),
            fact('Coordinates',  apt.lat != null ? this._formatLatLon(apt.lat, apt.lon) : null),
        ].join('');
        if (overviewFacts) html += sec('OVERVIEW', overviewFacts);

        // Runways
        if (apt.runways?.length) {
            const rows = apt.runways.map(r =>
                `<tr>
                    <td style="padding:6px 8px 6px 0;font-size:15px;font-weight:700;color:var(--text-primary);">${r.id || '—'}</td>
                    <td style="padding:6px 8px;font-size:14px;font-weight:600;color:var(--text-secondary);">${r.length_ft ? r.length_ft.toLocaleString() + ' ft' : '—'}</td>
                    <td style="padding:6px 8px;font-size:14px;font-weight:600;color:var(--text-secondary);">${r.width_ft ? r.width_ft + ' ft wide' : ''}</td>
                    <td style="padding:6px 0 6px 8px;font-size:13px;font-weight:600;color:var(--text-label);">${r.surface || ''}</td>
                </tr>`
            ).join('');
            html += sec('RUNWAYS',
                `<table style="width:100%;border-collapse:collapse;">
                    <tr style="border-bottom:2px solid var(--border-strong);">
                        <th style="padding:4px 8px 4px 0;font-size:11px;font-weight:700;color:var(--text-label);text-align:left;">RWY</th>
                        <th style="padding:4px 8px;font-size:11px;font-weight:700;color:var(--text-label);text-align:left;">LENGTH</th>
                        <th style="padding:4px 8px;font-size:11px;font-weight:700;color:var(--text-label);text-align:left;">WIDTH</th>
                        <th style="padding:4px 0 4px 8px;font-size:11px;font-weight:700;color:var(--text-label);text-align:left;">SURFACE</th>
                    </tr>
                    ${rows}
                </table>`
            );
        }

        // Frequencies
        if (apt.frequencies?.length) {
            const freqRows = apt.frequencies.map(f => {
                const isPrimary = (!apt.tower && f.type === 'ctaf') || (apt.tower && f.type === 'twr');
                return `<tr>
                    <td style="padding:6px 8px 6px 0;font-size:13px;font-weight:700;color:var(--text-label);">${(f.type || '').toUpperCase()}${isPrimary ? ' ★' : ''}</td>
                    <td style="padding:6px 0;font-size:16px;font-weight:700;color:var(--text-primary);font-family:monospace;">${f.freq || '—'}</td>
                    ${f.name ? `<td style="padding:6px 0 6px 8px;font-size:12px;font-weight:600;color:var(--text-secondary);">${f.name}</td>` : '<td></td>'}
                </tr>`;
            }).join('');
            html += sec('FREQUENCIES',
                `<table style="width:100%;border-collapse:collapse;">${freqRows}</table>`
            );
        }

        return html || '<div style="padding:24px 16px;color:var(--text-label);font-weight:600;">No data available</div>';
    }

    _navDetailHtml(nav) {
        const fact = (label, value) => value != null && value !== ''
            ? `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border-light);">
                <span style="font-size:13px;font-weight:600;color:var(--text-label);">${label}</span>
                <span style="font-size:15px;font-weight:700;color:var(--text-primary);">${value}</span>
               </div>`
            : '';

        const ownPos = this._getOwnPos();
        const distVal = (nav.lat != null && ownPos) ? Math.round(this._distNm(ownPos.lat, ownPos.lon, nav.lat, nav.lon)) : null;
        const bearing = (nav.lat != null && ownPos) ? Math.round(this._bearing(ownPos.lat, ownPos.lon, nav.lat, nav.lon)) : null;

        const facts = [
            fact('Type',        nav.type?.toUpperCase() || null),
            fact('Frequency',   nav.freq || null),
            fact('Elevation',   nav.elev_ft != null ? nav.elev_ft + ' ft MSL' : null),
            fact('Distance',    distVal != null ? `${distVal} nm  ${bearing}°` : null),
            fact('Coordinates', nav.lat != null ? this._formatLatLon(nav.lat, nav.lon) : null),
        ].join('');

        return `<div style="padding:14px 16px 0;">${facts || '<div style="color:var(--text-label);font-weight:600;">No data available</div>'}</div>`;
    }

    _fixDetailHtml(fix) {
        const fact = (label, value) => value != null && value !== ''
            ? `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border-light);">
                <span style="font-size:13px;font-weight:600;color:var(--text-label);">${label}</span>
                <span style="font-size:15px;font-weight:700;color:var(--text-primary);">${value}</span>
               </div>`
            : '';

        const ownPos = this._getOwnPos();
        const distVal = (fix.lat != null && ownPos) ? Math.round(this._distNm(ownPos.lat, ownPos.lon, fix.lat, fix.lon)) : null;
        const bearing = (fix.lat != null && ownPos) ? Math.round(this._bearing(ownPos.lat, ownPos.lon, fix.lat, fix.lon)) : null;

        const facts = [
            fact('Type',        'Intersection Fix'),
            fact('Distance',    distVal != null ? `${distVal} nm  ${bearing}°` : null),
            fact('Coordinates', fix.lat != null ? this._formatLatLon(fix.lat, fix.lon) : null),
        ].join('');

        return `<div style="padding:14px 16px 0;">${facts}</div>`;
    }

    _awyDetailHtml(awy) {
        const wps = awy.waypoints || [];
        const wpRows = wps.map(w =>
            `<div style="padding:8px 0;border-bottom:1px solid var(--border-light);display:flex;gap:12px;align-items:baseline;">
                <span style="font-size:15px;font-weight:700;color:var(--text-primary);min-width:60px;">${w.id || w.name || ''}</span>
                <span style="font-size:13px;font-weight:600;color:var(--text-secondary);">${w.lat != null ? this._formatLatLon(w.lat, w.lon) : ''}</span>
            </div>`
        ).join('');

        return `<div style="padding:14px 16px 0;">
            <div style="font-size:11px;font-weight:700;color:var(--text-label);letter-spacing:0.08em;margin-bottom:6px;">WAYPOINTS (${wps.length})</div>
            ${wpRows || '<div style="color:var(--text-label);font-weight:600;">No waypoint data</div>'}
        </div>`;
    }

    _procDetailHtml(proc) {
        const transitions = proc.transitions || [];
        const transHtml = transitions.length
            ? transitions.map(t =>
                `<div style="padding:8px 0;border-bottom:1px solid var(--border-light);font-size:15px;font-weight:600;color:var(--text-primary);">${t}</div>`
              ).join('')
            : '<div style="color:var(--text-label);font-weight:600;">No transition data</div>';

        return `<div style="padding:14px 16px 0;">
            <div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--border-light);">
                <span style="font-size:13px;font-weight:600;color:var(--text-label);">AIRPORT</span>
                <span style="font-size:15px;font-weight:700;color:var(--text-primary);">${proc.icao || ''}</span>
            </div>
            <div style="margin-top:14px;">
                <div style="font-size:11px;font-weight:700;color:var(--text-label);letter-spacing:0.08em;margin-bottom:6px;">TRANSITIONS</div>
                ${transHtml}
            </div>
        </div>`;
    }

    // ── Detail action bar ────────────────────────────────────────────────────

    _buildDetailActions(entity, type) {
        const routeActive = this._isRouteActive();
        const wp = {
            icao: entity.icao || entity.id,
            id:   entity.icao || entity.id,
            lat:  entity.lat,
            lon:  entity.lon,
            name: entity.name || entity.id || entity.icao,
            type,
        };

        if (type === 'PROC') {
            return [this._makeActionBtn('LOAD PROCEDURE', true, () => {
                this._saveRecent({ ...entity, type: 'PROC' });
                this.hide();
                if (this._approachCharts) this._approachCharts.showForAirport(entity.icao);
            })];
        }

        if (type === 'AWY') {
            return [this._makeActionBtn('SHOW ON MAP', true, () => {
                this._saveRecent({ ...entity, type });
                this.hide();
                this._showOnMap(entity, type);
            })];
        }

        const btns = [];

        btns.push(this._makeActionBtn('SHOW ON MAP', false, () => {
            this._saveRecent({ ...entity, type });
            this.hide();
            this._showOnMap(entity, type);
        }));

        if (routeActive) {
            btns.push(this._makeActionBtn('ADD TO ROUTE', false, () => {
                this._saveRecent({ ...entity, type });
                this.hide();
                if (this._routeTable) this._routeTable.addWaypointSmart(wp);
            }));
            // DIRECT-TO: Stage 2 feature — not yet implemented
        }

        return btns;
    }

    _makeActionBtn(label, primary, handler) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = `flex:1;font-size:14px;font-weight:700;padding:10px 8px;min-height:var(--touch-preferred,64px);border-radius:8px;letter-spacing:0.04em;cursor:pointer;border:2px solid var(--accent);` +
            (primary
                ? 'background:var(--accent);color:var(--text-on-accent);'
                : 'background:transparent;color:var(--accent);');
        wireTap(btn, handler);
        return btn;
    }

    _showOnMap(entity, type) {
        if (!this._cockpitMap?.map || entity.lat == null) return;
        this._cockpitMap.map.setView([entity.lat, entity.lon], 11);
        if (type === 'APT' && this._airportPopup)
            setTimeout(() => this._airportPopup.show(entity), 300);
        else if (type === 'NAV' && this._airportPopup?.showNavaid)
            setTimeout(() => this._airportPopup.showNavaid(entity), 300);
    }

    // ── Formatters ───────────────────────────────────────────────────────────

    _formatLatLon(lat, lon) {
        const fmtDeg = (val, pos, neg) => {
            const d = Math.abs(val);
            const deg = Math.floor(d);
            const min = ((d - deg) * 60).toFixed(2);
            return `${val >= 0 ? pos : neg}${deg}° ${min}'`;
        };
        return `${fmtDeg(lat, 'N', 'S')}  ${fmtDeg(lon, 'E', 'W')}`;
    }

    _bearing(lat1, lon1, lat2, lon2) {
        const toRad = d => d * Math.PI / 180;
        const dLon = toRad(lon2 - lon1);
        const y = Math.sin(dLon) * Math.cos(toRad(lat2));
        const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
                  Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    // ── Recent searches ──────────────────────────────────────────────────────

    _loadRecent() {
        try { return JSON.parse(localStorage.getItem(this._RECENT_KEY) || '[]'); }
        catch { return []; }
    }

    _saveRecent(result) {
        const key = result.icao || result.id || result.name || result.proc_name;
        const recents = this._loadRecent().filter(r => (r.icao || r.id || r.name || r.proc_name) !== key);
        recents.unshift(result);
        try { localStorage.setItem(this._RECENT_KEY, JSON.stringify(recents.slice(0, this._RECENT_MAX))); }
        catch {}
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _isRouteActive() {
        const trip = this._getActiveTrip?.();
        return !!(trip?.waypoints?.length >= 2);
    }

}
