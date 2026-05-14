/**
 * FlyPi — Weather Briefing Panel
 * Route weather timeline using NOAA GFS MOS (MAV short-range + MEX extended).
 *
 * Two display modes:
 *   7-DAY  — one column per day, worst flight category during prime flying hours.
 *            MEX data extends to day 8. Useful for "which day should I fly?"
 *   24H    — one column per 3h period, next 24h from MAV data.
 *            Detailed ceiling / vis / wind per period.
 *
 * Go/No-Go summary bar shows the planned day vs. alternatives at a glance.
 * Tap any airport row to expand full MOS detail table.
 */
class WxBriefing {
    constructor(db, config = {}) {
        this._db           = db;
        this._config       = config;
        this._el           = null;
        this._flightPlan   = null;
        this._mosData      = null;
        this._mode         = 'day';
        this._loading      = false;
        this._expandedIcao = null;
        this.visible       = false;

        this._metarData    = null;
        this._tafData      = null;
        this._airmets      = null;
        this._afds         = null;
        this._notams         = null;
        this._enrouteNotams  = null;

        this._metarFetchedAt       = 0;
        this._airmetFetchedAt      = 0;
        this._afdFetchedAt         = 0;
        this._notamFetchedAt       = 0;
        this._enrouteNotamFetchedAt = 0;

        this._routeCoords  = null;

        const savedCorridor = parseInt(localStorage.getItem('flytab_wx_corridor'));
        this._corridorMi    = [10, 25, 50].includes(savedCorridor) ? savedCorridor : 25;
        this._notamFetchError = null;
        this._enrouteNotamFetchError = null;
        this._lightsExpanded = false;
    }

    init() {
        this._buildPanel();
    }

    show() {
        if (!this._el) this.init();
        this._el.classList.add('visible');
        this.visible = true;

        if (!this._mosData && this._flightPlan?.weather_cache?.mos) {
            this._mosData = this._normalizeMos(this._flightPlan.weather_cache.mos);
        }

        this._renderAll();
        this._fetchColdSections();
    }

    hide() {
        this._el?.classList.remove('visible');
        this.visible = false;
    }

    setFlightPlan(plan) {
        this._flightPlan = plan;
        if (plan?.weather_cache?.mos) this._mosData = this._normalizeMos(plan.weather_cache.mos);
        this._routeCoords = null;
        if (this.visible) this._renderAll();
    }

    _fetchColdSections() {
        const now = Date.now();
        const TTL15 = 15 * 60000;
        const TTL60 = 60 * 60000;

        const fetches = [];
        if (now - this._metarFetchedAt  > TTL15) fetches.push(this._fetchMetarTaf());
        if (now - this._airmetFetchedAt > TTL15) fetches.push(this._fetchAirmets());
        if (now - this._afdFetchedAt    > TTL60) fetches.push(this._fetchAfds());
        if (now - this._notamFetchedAt        > TTL15) fetches.push(this._fetchNotams());
        if (now - this._enrouteNotamFetchedAt > TTL15) fetches.push(this._fetchEnrouteNotams());

        if (fetches.length) Promise.allSettled(fetches);
    }

    _refreshAll() {
        this._notamFetchError = null;
        this._enrouteNotamFetchError = null;
        this._metarFetchedAt = this._airmetFetchedAt = this._afdFetchedAt =
            this._notamFetchedAt = this._enrouteNotamFetchedAt = 0;
        this._fetchMos();
        this._fetchColdSections();
    }


    _renderAll() {
        if (!this._el) return;
        this._renderSummaryBar();
        this._renderAgeGroup();
        this._renderMos();
        this._renderMetarSection();
        this._renderAirmetSection();
        this._renderAfdSection();
        this._renderNotamSection();
        this._renderPlanningSection();
    }

    _section(id) {
        return this._el?.querySelector(`#${id}`);
    }

    _setSection(id, html) {
        const el = this._section(id);
        if (el) el.innerHTML = html;
    }

    _loadingHtml(label) {
        return `<div class="wx-section-loading">Fetching ${label}…</div>`;
    }

    _errorHtml(label) {
        return `<div class="wx-section-error">⚠ ${label} unavailable — tap ↻ to retry</div>`;
    }

    _renderAgeGroup() {
        const el = this._section('wx-age-group');
        if (!el) return;
        const now = Date.now();
        const age = (ts) => {
            if (!ts) return null;
            const m = Math.round((now - ts) / 60000);
            return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
        };
        const tag = (label, ts, ttl) => {
            const a = age(ts);
            const stale = !a || (now - ts) > ttl;
            return `<span class="wx-age-tag${stale ? ' wx-age-stale' : ''}">
                <span class="wx-age-dot"></span>
                <b>${label}</b>${a ? ' ' + a : ' —'}
            </span>`;
        };
        el.innerHTML =
            tag('MOS', this._mosData ? new Date(this._mosData.fetched_at).getTime() : 0, 60 * 60000) +
            tag('METARs', this._metarFetchedAt, 15 * 60000) +
            tag('AIRMETs', this._airmetFetchedAt, 15 * 60000) +
            tag('NOTAMs', this._notamFetchedAt, 15 * 60000);
    }

    _isWarm(ts, ttlMinutes) {
        return ts > 0 && (Date.now() - ts) < ttlMinutes * 60000;
    }

    _renderSummaryBar() {
        const bar = this._el?.querySelector('#wx-summary-bar');
        if (!bar) return;
        const stations = this._getStationList();
        const dep  = stations[0]  || '—';
        const dest = stations[stations.length - 1] || '—';
        const route = dep !== dest ? `${dep} → ${dest}` : dep;

        let badgeHtml = '';
        if (this._mosData) {
            const best = this._findBestDay(stations);
            if (best) {
                const label = this._isSameDay(best.date, new Date())
                    ? 'Today'
                    : this._dayLabel(best.date);
                const cls = (best.worstCat || 'unknown').toLowerCase();
                badgeHtml = `<span class="wx-summary-badge ${cls}">${label}: ${best.worstCat}</span>`;
            }
        }

        bar.innerHTML = `<span class="wx-summary-route">${route}</span>${badgeHtml}`;
    }

    _renderMos() {
        const sec = this._section('wx-mos-section');
        if (!sec) return;
        sec.innerHTML = '';

        const allStations = this._getStationList();
        // Filter to only stations that have MOS data
        const stations = this._mosData
            ? allStations.filter(id => {
                const stData = this._mosData.stations?.[id] || this._mosData[id];
                return stData != null;
            })
            : allStations;
        if (!stations.length) {
            sec.innerHTML = '<div class="wx-section-empty">No flight plan loaded.</div>';
            return;
        }

        if (this._loading) {
            sec.innerHTML = this._loadingHtml('MOS');
            return;
        }

        if (!this._mosData) {
            sec.innerHTML = '<div class="wx-section-empty">No MOS cached. Tap ↻ to fetch.</div>';
            return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'wx-mos-wrap';

        if (this._mode === 'day') {
            wrap.appendChild(this._buildDayGrid(stations));
            const best = this._findBestDay(stations);
            if (best) {
                const note = document.createElement('div');
                note.className = 'wx-mos-note';
                note.textContent = `Best: ${this._dayLabel(best.date)} (${best.worstCat}) · Days 6–8 trend only`;
                wrap.appendChild(note);
            }
        } else {
            wrap.appendChild(this._buildHourGrid(stations));
        }

        if (this._mosData.fetched_at) {
            const ageMin = Math.round((Date.now() - new Date(this._mosData.fetched_at)) / 60000);
            const ageEl = document.createElement('div');
            ageEl.className = 'wx-mos-note';
            ageEl.textContent = `MOS ${ageMin < 60 ? ageMin + 'm' : Math.round(ageMin / 60) + 'h'} old`;
            wrap.appendChild(ageEl);
        }

        sec.appendChild(wrap);
    }
    _renderMetarSection() {
        const sec = this._section('wx-metar-section');
        if (!sec) return;

        sec.innerHTML = '';

        // Corridor chip row — render before early returns so it persists during loading
        const chips = document.createElement('div');
        chips.className = 'wx-corridor-chips';
        for (const mi of [10, 25, 50]) {
            const btn = document.createElement('button');
            btn.className = 'wx-corridor-chip' + (this._corridorMi === mi ? ' active' : '');
            btn.textContent = `${mi} mi`;
            btn.addEventListener('click', () => {
                if (this._corridorMi === mi) return;
                this._corridorMi = mi;
                localStorage.setItem('flytab_wx_corridor', String(mi));
                this._metarFetchedAt = 0;
                this._metarData = null;
                this._renderAirmetSection();
                this._fetchMetarTaf();
            });
            chips.appendChild(btn);
        }
        sec.appendChild(chips);

        if (this._metarData === null) {
            sec.insertAdjacentHTML('beforeend', this._loadingHtml('METARs & TAFs'));
            return;
        }
        if (this._metarData._error) {
            sec.insertAdjacentHTML('beforeend', this._errorHtml('METARs & TAFs'));
            return;
        }

        const stations = this._getStationList();
        const allIcaos = Object.keys(this._metarData).filter(k => k !== '_error');
        const routeIndexMap = new Map(stations.map((id, i) => [id, i]));
        const coords = this._routeCoords || [];

        const sorted = [...allIcaos].sort((a, b) => {
            const aIdx = routeIndexMap.has(a) ? routeIndexMap.get(a) : Infinity;
            const bIdx = routeIndexMap.has(b) ? routeIndexMap.get(b) : Infinity;
            const aOnRoute = aIdx < Infinity, bOnRoute = bIdx < Infinity;
            if (aOnRoute !== bOnRoute) return aOnRoute ? -1 : 1;
            if (aOnRoute) return aIdx - bIdx;   // both on-route: preserve dep→dest order
            if (!coords.length) return 0;
            const distA = this._distToNearestCoord(this._metarData[a]?.lat, this._metarData[a]?.lon, coords);
            const distB = this._distToNearestCoord(this._metarData[b]?.lat, this._metarData[b]?.lon, coords);
            return distA - distB;
        });

        const count = allIcaos.length;

        // Section header
        const hdrDiv = document.createElement('div');
        hdrDiv.className = 'wx-section-hdr';
        hdrDiv.innerHTML = `
            <span class="wx-section-hdr-title">METARs &amp; TAFs</span>
            <span class="wx-section-hdr-sub">${count} STATION${count !== 1 ? 'S' : ''}</span>
        `;
        sec.appendChild(hdrDiv);

        for (const icao of sorted) {
            const m = this._metarData[icao];
            if (!m) continue;
            sec.appendChild(this._buildStationCard(icao, m, routeIndexMap.has(icao)));
        }
    }
    _renderAirmetSection() {
        const sec = this._section('wx-airmet-section');
        if (!sec) return;

        if (this._airmets === null) {
            sec.innerHTML = this._buildRhsHeader('G-AIRMETs', null, 'Fetching…').outerHTML;
            return;
        }

        const filtered = this._filterAdvisoriesForRoute(this._airmets);
        const hdr = this._buildRhsHeader('G-AIRMETs', filtered.length > 0 ? 'warn' : 'ok',
            filtered.length > 0 ? `${filtered.length} ON ROUTE` : 'NONE ON ROUTE');

        sec.innerHTML = '';
        sec.appendChild(hdr);

        const body = document.createElement('div');
        body.className = 'wx-rhs-body open';

        if (!filtered.length) {
            body.innerHTML = '<div class="wx-section-empty">No active G-AIRMETs in route corridor.</div>';
        } else {
            const TYPE_ORDER = { ZULU: 0, TANGO: 1, SIERRA: 2 };
            const sorted = filtered.slice().sort((a, b) => {
                const pa = TYPE_ORDER[a.product] ?? 9;
                const pb = TYPE_ORDER[b.product] ?? 9;
                if (pa !== pb) return pa - pb;
                return (parseAltFt(a.base) ?? 0) - (parseAltFt(b.base) ?? 0);
            });
            for (const adv of sorted) {
                body.appendChild(this._buildGairmetCard(adv));
            }
        }

        sec.appendChild(body);
    }

    _buildGairmetCard(adv) {
        const product  = adv.product  || 'AIRMET';
        const typeClass = product.toLowerCase();
        const isFrzlvl = (adv.hazard || '').toUpperCase() === 'FRZLVL';
        // For FRZLVL the band already conveys it ("FZL X") — drop redundant text.
        const hazard   = isFrzlvl ? 'Freezing level' : (adv.due_to || adv.hazard || 'Advisory');
        const altBand  = formatAdvisoryAltBand(adv);
        const statesStr = adv.states?.length ? adv.states.join(' · ') : '';
        const fzlBase  = formatAlt(adv.fzlbase);
        const fzlTop   = formatAlt(adv.fzltop);
        const fzlBaseFt = parseAltFt(adv.fzlbase);
        const fzlStr   = (!isFrzlvl && fzlBase && fzlTop && fzlBaseFt != null && fzlBaseFt < 18000)
                       ? `FRZLVL ${fzlBase}–${fzlTop}`
                       : '';
        const sevClass = { LGT: 'sev-lgt', MDT: 'sev-mdt', SEV: 'sev-sev' }[adv.severity] || '';
        const sevStr   = adv.severity ? `<span class="wx-adv-sev ${sevClass}">${adv.severity}</span>` : '';
        const metaParts = [sevStr, fzlStr].filter(Boolean);
        const validUntil = adv.expires_at
            ? new Date(adv.expires_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + ' L'
            : '—';

        const card = document.createElement('div');
        card.className = 'wx-adv-card';
        card.innerHTML = `
            <div class="wx-adv-hdr">
                <span class="wx-adv-type ${typeClass}">${product}</span>
                <div class="wx-adv-info">
                    <div class="wx-adv-hazard">${this._escHtml(hazard)}</div>
                    <div class="wx-adv-alt">${this._escHtml(altBand)}</div>
                    ${statesStr ? `<div class="wx-adv-states">${this._escHtml(statesStr)}</div>` : ''}
                </div>
            </div>
            <div class="wx-adv-foot">
                <span class="wx-adv-meta-left">${metaParts.join(' · ')}</span>
                <span class="wx-adv-valid-time">Until ${this._escHtml(validUntil)}</span>
            </div>`;
        return card;
    }
    _renderAfdSection() {
        const sec = this._section('wx-afd-section');
        if (!sec) return;

        if (this._afds === null) {
            sec.innerHTML = this._buildRhsHeader('Fcst Discussions', null, 'Fetching…').outerHTML;
            return;
        }

        const count = this._afds.length;
        const hdr = this._buildRhsHeader('Fcst Discussions', 'info',
            count > 0 ? `${count} OFFICE${count > 1 ? 'S' : ''}` : 'NONE');

        sec.innerHTML = '';
        sec.appendChild(hdr);

        const body = document.createElement('div');
        body.className = 'wx-rhs-body open';

        if (!this._afds.length) {
            body.innerHTML = '<div class="wx-section-empty">No AFDs fetched — requires internet.</div>';
        } else {
            for (const afd of this._afds) {
                const issued = afd.issued
                    ? new Date(afd.issued).toLocaleString([], {weekday:'short',hour:'2-digit',minute:'2-digit'}) + ' L'
                    : '—';
                body.appendChild(this._buildAdvCard(
                    afd.office, 'afd',
                    afd.name || afd.office,
                    `Issued ${issued}`,
                    this._extractAviationSection(afd.text),
                    '',
                    true
                ));
            }
        }

        sec.appendChild(body);
    }
    _renderNotamSection() {
        const sec = this._section('wx-notam-section');
        if (!sec) return;

        const airportLoading = this._notams === null;
        const enrouteLoading = this._enrouteNotams === null;
        const loading = airportLoading || enrouteLoading;

        const filteredApt = airportLoading  ? [] : this._filterByFlightWindow(this._notams);
        const filteredEnr = enrouteLoading  ? [] : this._filterByFlightWindow(this._enrouteNotams);
        const allNotams = [...filteredApt, ...filteredEnr];
        const critical = allNotams.filter(n => ['RWY', 'NAVAID', 'TFR', 'RESTR'].includes(n.type));
        const fetchErr = !loading && this._notamFetchError && !allNotams.length;
        const fetchErrWithCache = !loading && this._notamFetchError && allNotams.length > 0;
        const anyErr = fetchErr || fetchErrWithCache || (!loading && this._enrouteNotamFetchError);
        const badgeClass = loading ? null : (fetchErr ? 'warn' : anyErr ? 'warn' : critical.length > 0 ? 'warn' : allNotams.length > 0 ? 'info' : 'ok');
        const badgeText  = loading
            ? 'Fetching…'
            : (anyErr && !allNotams.length)
            ? 'UNAVAIL'
            : (critical.length > 0 ? `${critical.length} CRITICAL` : allNotams.length > 0 ? `${allNotams.length} ACTIVE` : 'NONE');

        const hdr = this._buildRhsHeader('NOTAMs', badgeClass, badgeText);
        sec.innerHTML = '';
        sec.appendChild(hdr);

        const body = document.createElement('div');
        body.className = 'wx-rhs-body open';

        if (fetchErr) {
            body.insertAdjacentHTML('beforeend',
                `<div class="wx-section-error">⚠ ${this._escHtml(this._notamFetchError)} · tap ↻ to retry</div>`);
            sec.appendChild(body);
            return;
        }

        if (fetchErrWithCache) {
            body.insertAdjacentHTML('beforeend',
                `<div class="wx-section-error">⚠ Refresh failed — showing cached airport NOTAMs · tap ↻ to retry</div>`);
        }

        // ── Airport NOTAMs ────────────────────────────────────────────────────
        const aptGrpHdr = document.createElement('div');
        aptGrpHdr.className = 'wx-notam-group-hdr';
        aptGrpHdr.textContent = 'AIRPORT';
        body.appendChild(aptGrpHdr);

        if (airportLoading) {
            body.insertAdjacentHTML('beforeend', '<div class="wx-section-loading">Fetching airport NOTAMs…</div>');
        } else {
            const priorityNotams = filteredApt.filter(n => n.type !== 'OBST_LGT');
            const lightNotams    = filteredApt.filter(n => n.type === 'OBST_LGT');

            if (!priorityNotams.length && !lightNotams.length) {
                body.insertAdjacentHTML('beforeend', '<div class="wx-section-empty">No active NOTAMs for route airports.</div>');
            }

            for (const notam of priorityNotams) {
                const typeClass = (notam.type === 'RWY' || notam.type === 'NAVAID') ? 'rwy' : notam.type.toLowerCase();
                const validStr = notam.validTo
                    ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L</b>`
                    : '';
                body.appendChild(this._buildAdvCard(notam.type, typeClass, `${notam.airport} · ${notam.summary}`, notam.airport, notam.raw, validStr));
            }

            if (lightNotams.length > 0) {
                const count = lightNotams.length;
                const toggle = document.createElement('div');
                toggle.className = 'wx-notam-lights-toggle';
                toggle.innerHTML = `<span>${count} obstacle light outage${count > 1 ? 's' : ''}</span><span>${this._lightsExpanded ? '▼' : '▶'}</span>`;

                const lightsBody = document.createElement('div');
                lightsBody.style.display = this._lightsExpanded ? 'block' : 'none';
                for (const notam of lightNotams) {
                    const validStr = notam.validTo
                        ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L</b>`
                        : '';
                    lightsBody.appendChild(this._buildAdvCard('OBST', 'obst', `${notam.airport} · ${notam.summary}`, notam.airport, notam.raw, validStr));
                }

                wireTap(toggle, () => {
                    this._lightsExpanded = !this._lightsExpanded;
                    lightsBody.style.display = this._lightsExpanded ? 'block' : 'none';
                    toggle.querySelector('span:last-child').textContent = this._lightsExpanded ? '▼' : '▶';
                });

                body.appendChild(toggle);
                body.appendChild(lightsBody);
            }
        }

        // ── En-Route Airspace NOTAMs ──────────────────────────────────────────
        const enrGrpHdr = document.createElement('div');
        enrGrpHdr.className = 'wx-notam-group-hdr';
        enrGrpHdr.textContent = 'EN-ROUTE AIRSPACE';
        body.appendChild(enrGrpHdr);

        if (enrouteLoading) {
            body.insertAdjacentHTML('beforeend', '<div class="wx-section-loading">Fetching en-route NOTAMs…</div>');
        } else if (this._enrouteNotamFetchError) {
            body.insertAdjacentHTML('beforeend',
                `<div class="wx-section-error">⚠ ${this._escHtml(this._enrouteNotamFetchError)} · tap ↻ to retry</div>`);
        } else if (!filteredEnr.length) {
            body.insertAdjacentHTML('beforeend', '<div class="wx-section-empty">No TFRs, MOAs, or restricted areas on route.</div>');
        } else {
            for (const notam of filteredEnr) {
                const typeClass = { TFR: 'rwy', RESTR: 'restr', MOA: 'moa', WARN: 'warn',
                    ATCAA: 'atcaa', UAS: 'uas', LASER: 'laser' }[notam.type] || 'sua';
                const validStr = notam.validTo
                    ? `Valid to <b>${new Date(notam.validTo).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} L</b>`
                    : '';
                body.appendChild(this._buildAdvCard(notam.type, typeClass, `${notam.airport} · ${notam.summary}`, notam.airport, notam.raw, validStr));
            }
        }

        sec.appendChild(body);
    }

    // ── Panel construction ────────────────────────────────────────────────────

    _buildPanel() {
        this._el = document.createElement('div');
        this._el.className = 'wx-briefing-page';
        this._el.innerHTML = `
            <div class="wx-briefing-header">
                <span class="wx-briefing-title">⛅ WX BRIEFING</span>
                <div class="wx-age-group" id="wx-age-group"></div>
                <div class="wx-mode-toggle">
                    <button class="wx-mode-btn active" data-mode="day">7-DAY</button>
                    <button class="wx-mode-btn" data-mode="hour">24H</button>
                </div>
                <button class="wx-refresh-btn" title="Refresh all weather">↻</button>
                <button class="wx-close-btn" aria-label="Close">✕</button>
            </div>
            <div class="wx-briefing-body">
                <div class="wx-left">
                    <div class="wx-summary-bar" id="wx-summary-bar">
                        <span class="wx-summary-route">—</span>
                    </div>
                    <div id="wx-mos-section"></div>
                    <div id="wx-metar-section"></div>
                </div>
                <div class="wx-right">
                    <div id="wx-airmet-section"></div>
                    <div id="wx-afd-section"></div>
                    <div id="wx-notam-section"></div>
                    <div id="wx-planning-section"></div>
                </div>
            </div>
        `;

        this._el.querySelector('.wx-close-btn').addEventListener('click', () => this.hide());
        this._el.querySelector('.wx-refresh-btn').addEventListener('click', () => this._refreshAll());

        this._el.querySelectorAll('.wx-mode-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this._mode = btn.dataset.mode;
                this._el.querySelectorAll('.wx-mode-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._renderMos();
            });
        });

        (document.getElementById('mainContent') || document.body).appendChild(this._el);
    }

    // ── Data fetching ─────────────────────────────────────────────────────────

    async _fetchMos() {
        const baseStations = this._getStationList();
        let stations = baseStations;
        try {
            const corridorApts = await this._getCorridorAirports(20);
            if (corridorApts.length) {
                const baseSet = new Set(baseStations);
                const extra = corridorApts.map(a => a.icao).filter(id => !baseSet.has(id));
                stations = [...baseStations, ...extra];
            }
        } catch (_) {}
        if (!stations.length) {
            return;
        }

        this._loading = true;
        this._renderMos();

        try {
            const ids = stations.join(',');
            const base = Settings.workerBase || 'https://www.flywhere.app/api';
            const resp = await fetch(`${base}/mos?ids=${ids}`, { signal: AbortSignal.timeout(45000) });
            if (!resp.ok) throw new Error(`Server error ${resp.status}`);
            const data = await resp.json();
            this._mosData = this._normalizeMos(data);

            // Cache in flight plan for offline use
            if (this._flightPlan) {
                if (!this._flightPlan.weather_cache) this._flightPlan.weather_cache = {};
                this._flightPlan.weather_cache.mos = this._mosData;
                // Persist to Pi if sync available
                if (window.flightSync?.savePlan) {
                    window.flightSync.savePlan(this._flightPlan).catch(() => {});
                }
            }
        } catch (err) {
            console.error('MOS fetch failed:', err);
        } finally {
            this._loading = false;
            this._renderSummaryBar();
            this._renderAgeGroup();
            this._renderMos();
            this._renderPlanningSection();
        }
    }

    // ── 7-Day grid ────────────────────────────────────────────────────────────

    _buildDayGrid(stations) {
        const wrapper = document.createElement('div');
        wrapper.className = 'wx-grid-wrapper';

        // Collect 7 days of UTC dates starting from today
        const days = [];
        const now = new Date();
        for (let d = 0; d < 7; d++) {
            const dt = new Date(now);
            dt.setUTCDate(now.getUTCDate() + d);
            dt.setUTCHours(0, 0, 0, 0);
            days.push(dt);
        }

        // Header row
        const grid = document.createElement('div');
        grid.className = 'wx-grid';
        grid.style.gridTemplateColumns = `80px repeat(${days.length}, 1fr)`;

        // Corner cell
        grid.appendChild(this._cell('', 'wx-grid-corner'));

        // Day headers
        for (const day of days) {
            const isToday = this._isSameDay(day, now);
            const h = this._cell(this._dayLabel(day, true), 'wx-grid-header' + (isToday ? ' wx-today' : ''));
            grid.appendChild(h);
        }

        // Airport rows
        for (const icao of stations) {
            const stationData = this._mosData?.stations?.[icao];
            const isExpanded = this._expandedIcao === icao;

            // Airport label cell
            const labelCell = document.createElement('div');
            labelCell.className = 'wx-grid-label' + (isExpanded ? ' wx-label-active' : '');
            labelCell.textContent = icao;
            labelCell.addEventListener('click', () => {
                this._expandedIcao = isExpanded ? null : icao;
                this._renderMos();
            });
            grid.appendChild(labelCell);

            // Day cells
            for (const day of days) {
                const cat = this._worstCatForDay(stationData, day);
                const isToday = this._isSameDay(day, now);
                const cell = document.createElement('div');
                cell.className = `wx-grid-cell wx-cat-${(cat || 'unknown').toLowerCase()}${isToday ? ' wx-today-col' : ''}`;
                if (!stationData || stationData.error) {
                    cell.classList.add('wx-cat-unknown');
                    cell.textContent = '—';
                } else if (!cat) {
                    cell.textContent = '—';
                    cell.classList.add('wx-cat-unknown');
                } else {
                    cell.textContent = cat === 'MVFR' ? 'MVF' : cat;
                    // Check reliability (MEX days 4+)
                    const reliable = this._isDayReliable(stationData, day);
                    if (!reliable) cell.classList.add('wx-cell-mex');
                }
                // Click to jump to hour view for this day
                cell.addEventListener('click', () => {
                    this._expandedIcao = icao;
                    this._renderMos();
                });
                grid.appendChild(cell);
            }
        }

        // T-storm row
        const tsRow = this._buildTstormRow(stations, days);
        if (tsRow) {
            for (const el of tsRow) grid.appendChild(el);
        }

        wrapper.appendChild(grid);
        return wrapper;
    }

    // ── 24H grid ──────────────────────────────────────────────────────────────

    _buildHourGrid(stations) {
        const wrapper = document.createElement('div');
        wrapper.className = 'wx-grid-wrapper';

        // Get the next 24h worth of periods from MAV data
        const now = new Date();
        const cutoff = new Date(now.getTime() + 27 * 3600000); // 27h window

        // Collect all unique valid times across stations
        const timesSet = new Set();
        for (const icao of stations) {
            const sd = this._mosData?.stations?.[icao];
            if (!sd?.periods) continue;
            for (const p of sd.periods) {
                if (!p.valid_time) continue;
                const vt = new Date(p.valid_time);
                if (vt >= now && vt <= cutoff) timesSet.add(p.valid_time);
            }
        }
        const times = [...timesSet].sort();

        if (!times.length) {
            const el = document.createElement('div');
            el.className = 'wx-empty';
            el.textContent = 'No 24h MOS periods available. Fetch fresh data.';
            wrapper.appendChild(el);
            return wrapper;
        }

        const grid = document.createElement('div');
        grid.className = 'wx-grid wx-grid-hour';
        grid.style.gridTemplateColumns = `80px repeat(${times.length}, 80px)`;

        // Corner
        grid.appendChild(this._cell('', 'wx-grid-corner'));

        // Time headers
        for (const vt of times) {
            const dt = new Date(vt);
            const h = dt.getUTCHours();
            const label = `${String(h).padStart(2, '0')}Z`;
            grid.appendChild(this._cell(label, 'wx-grid-header'));
        }

        // Airport rows
        for (const icao of stations) {
            const sd = this._mosData?.stations?.[icao];
            const isExpanded = this._expandedIcao === icao;

            const labelCell = document.createElement('div');
            labelCell.className = 'wx-grid-label' + (isExpanded ? ' wx-label-active' : '');
            labelCell.textContent = icao;
            labelCell.addEventListener('click', () => {
                this._expandedIcao = isExpanded ? null : icao;
                this._renderMos();
            });
            grid.appendChild(labelCell);

            // Build period lookup for this station
            const periodMap = {};
            if (sd?.periods) {
                for (const p of sd.periods) {
                    if (p.valid_time) periodMap[p.valid_time] = p;
                }
            }

            for (const vt of times) {
                const p = periodMap[vt];
                const cell = document.createElement('div');
                const cat = p?.flight_cat;
                cell.className = `wx-grid-cell wx-cat-${(cat || 'unknown').toLowerCase()}`;

                if (!p || !cat) {
                    cell.textContent = '—';
                    cell.classList.add('wx-cat-unknown');
                } else {
                    const wind = (p.wdr != null && p.wsp != null)
                        ? `${String(Math.round(p.wdr / 10) * 10).padStart(3, '0')}/${p.wsp}`
                        : '';
                    const cig = p.cig_label ?? (p.cld === 'BK' ? 'BKN' : p.cld === 'OV' ? 'OVC' : null);
                    const vis = p.vis_label ?? null;
                    const tp = p.tp6 ?? p.tp12 ?? null;
                    const obv = (p.obv && p.obv !== 'N') ? p.obv : null;
                    const pop = p.pop != null && p.pop >= 20 ? p.pop : null;
                    cell.innerHTML = `
                        <span class="wx-cell-cat">${cat === 'MVFR' ? 'MVF' : cat}</span>
                        ${cig ? `<span class="wx-cell-detail">${cig}</span>` : ''}
                        ${vis ? `<span class="wx-cell-detail">${vis}</span>` : ''}
                        ${wind ? `<span class="wx-cell-detail">${wind}</span>` : ''}
                        ${obv ? `<span class="wx-cell-detail wx-cell-obv">${obv}</span>` : ''}
                        ${pop != null ? `<span class="wx-cell-detail wx-cell-pop">${pop}%</span>` : ''}
                        ${tp != null ? `<span class="wx-cell-tstorm">⛈${tp}%</span>` : ''}
                    `;
                }
                grid.appendChild(cell);
            }
        }

        wrapper.appendChild(grid);
        return wrapper;
    }

    // ── T-storm row (day grid) ────────────────────────────────────────────────

    _buildTstormRow(stations, days) {
        // Only show if any station has TP > 10%
        let hasAny = false;
        const maxByDay = days.map(day => {
            let max = 0;
            for (const icao of stations) {
                const sd = this._mosData?.stations?.[icao];
                if (!sd?.periods) continue;
                for (const p of sd.periods) {
                    if (!p.valid_time || !this._isSameDay(new Date(p.valid_time), day)) continue;
                    const tp = p.tp6 ?? p.tp12 ?? 0;
                    if (tp > max) max = tp;
                }
            }
            if (max >= 10) hasAny = true;
            return max;
        });

        if (!hasAny) return null;

        const cells = [];
        cells.push(this._cell('T-stm', 'wx-grid-label wx-tstorm-label'));

        for (let i = 0; i < days.length; i++) {
            const pct = maxByDay[i];
            const cell = document.createElement('div');
            cell.className = 'wx-grid-cell wx-tstorm-cell';
            if (pct >= 40) {
                cell.classList.add('wx-tstorm-high');
                cell.textContent = `⛈${pct}%`;
            } else if (pct >= 20) {
                cell.classList.add('wx-tstorm-med');
                cell.textContent = `⛈${pct}%`;
            } else if (pct >= 10) {
                cell.classList.add('wx-tstorm-low');
                cell.textContent = `${pct}%`;
            } else {
                cell.textContent = '';
            }
            cells.push(cell);
        }

        return cells;
    }

    // ── Airport detail table ──────────────────────────────────────────────────

    _buildAirportDetail(icao) {
        const sd = this._mosData?.stations?.[icao];
        if (!sd?.periods?.length) return null;

        const section = document.createElement('div');
        section.className = 'wx-detail-section';

        const title = document.createElement('div');
        title.className = 'wx-detail-title';
        title.innerHTML = `<strong>${icao}</strong> — MOS Detail
            <button class="wx-detail-close">✕</button>`;
        title.querySelector('.wx-detail-close').addEventListener('click', () => {
            this._expandedIcao = null;
            this._renderMos();
        });
        section.appendChild(title);

        const table = document.createElement('table');
        table.className = 'wx-detail-table';

        const headers = ['Time', 'Local', 'Cat', 'Ceil', 'Vis', 'Wind', 'Type', 'Precip%', 'T-stm%', 'Mix Ht', 'Tmp', 'Dew'];
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const now = new Date();
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        let lastLocalDate = null;

        for (const p of sd.periods) {
            if (!p.valid_time) continue;
            const vt = new Date(p.valid_time);
            const isPast = vt < now;
            if (isPast) continue; // skip past periods

            // Day separator when local date changes
            const localDate = `${vt.getFullYear()}/${vt.getMonth()}/${vt.getDate()}`;
            if (lastLocalDate !== null && localDate !== lastLocalDate) {
                const sep = document.createElement('tr');
                sep.className = 'wx-day-separator';
                const dayName = dayNames[vt.getDay()];
                const mm = String(vt.getMonth() + 1).padStart(2, '0');
                const dd = String(vt.getDate()).padStart(2, '0');
                sep.innerHTML = `<td colspan="${headers.length}">${dayName} ${mm}/${dd}</td>`;
                tbody.appendChild(sep);
            }
            lastLocalDate = localDate;

            const row = document.createElement('tr');
            if (!p.reliable) row.classList.add('wx-row-mex');

            const timeLabel = `${String(vt.getUTCMonth() + 1).padStart(2, '0')}/${String(vt.getUTCDate()).padStart(2, '0')} ${String(vt.getUTCHours()).padStart(2, '0')}Z`;
            const localHH = String(vt.getHours()).padStart(2, '0');
            const localMM = String(vt.getMinutes()).padStart(2, '0');
            const localLabel = `${localHH}:${localMM}L`;
            const wdStr = p.wdr != null ? String(Math.round(p.wdr / 10) * 10).padStart(3, '0') : null;
            const wind = (wdStr != null && p.wsp != null)
                ? (p.wgst && p.wgst > p.wsp ? `${wdStr}/${p.wsp}G${p.wgst}kt` : `${wdStr}/${p.wsp}kt`)
                : '—';
            const tp = p.tp6 ?? p.tp12 ?? null;
            const pop = p.pop ?? null;
            const mixHt = p.mix_ht != null ? `${p.mix_ht.toLocaleString()}ft` : '—';

            row.innerHTML = `
                <td class="wx-dt">${timeLabel}</td>
                <td class="wx-dt wx-dt-local">${localLabel}</td>
                <td class="wx-cat-badge wx-cat-${(p.flight_cat || 'unknown').toLowerCase()}">${p.flight_cat || '—'}</td>
                <td>${p.cig_label ?? (p.cld === 'BK' ? 'BKN' : p.cld === 'OV' ? 'OVC' : '—')}</td>
                <td>${p.vis_label || '—'}</td>
                <td>${wind}</td>
                <td>${p.obv && p.obv !== 'N' ? p.obv : (p.typ || '—')}</td>
                <td class="${pop >= 50 ? 'wx-val-caution' : ''}">${pop !== null ? pop + '%' : '—'}</td>
                <td class="${tp >= 40 ? 'wx-val-danger' : tp >= 20 ? 'wx-val-caution' : ''}">${tp !== null ? tp + '%' : '—'}</td>
                <td class="wx-dt">${mixHt}</td>
                <td>${p.tmp != null ? p.tmp + '°' : '—'}</td>
                <td>${p.dpt != null ? p.dpt + '°' : '—'}</td>
            `;
            tbody.appendChild(row);
        }

        table.appendChild(tbody);
        section.appendChild(table);

        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        const noteText = this._buildMosSummaryNote(icao, today);
        if (noteText) {
            const noteEl = document.createElement('div');
            noteEl.className = 'wx-hourly-note';
            noteEl.textContent = noteText;
            section.appendChild(noteEl);
        }

        return section;
    }

    _buildMosSummaryNote(icao, day) {
        const sd = this._mosData?.stations?.[icao];
        if (!sd?.periods) return '';

        const dayStart = new Date(day); dayStart.setUTCHours(0, 0, 0, 0);
        const dayEnd   = new Date(day); dayEnd.setUTCHours(24, 0, 0, 0);
        const order = ['LIFR', 'IFR', 'MVFR', 'VFR'];

        const periods = sd.periods
            .filter(p => p.valid_time && p.flight_cat)
            .map(p => ({ vt: new Date(p.valid_time), cat: p.flight_cat }))
            .filter(p => p.vt >= dayStart && p.vt < dayEnd)
            .sort((a, b) => a.vt - b.vt);

        if (!periods.length) return '';
        if (periods.every(p => p.cat === 'VFR')) return 'VFR all day ✓';

        const fmtH = d => d.toLocaleTimeString([], { hour: 'numeric', hour12: true });

        const blocks = [];
        let i = 0;
        while (i < periods.length) {
            if (periods[i].cat === 'VFR') { i++; continue; }
            let j = i;
            let worst = periods[i].cat;
            while (j < periods.length && periods[j].cat !== 'VFR') {
                if (order.indexOf(periods[j].cat) < order.indexOf(worst)) worst = periods[j].cat;
                j++;
            }
            const clearsAfter = j < periods.length;
            blocks.push({ start: periods[i].vt, end: periods[j - 1].vt, cat: worst, clearsAfter });
            i = j;
        }

        if (!blocks.length) return 'VFR all day ✓';

        return blocks.map(b =>
            `${b.cat} ${fmtH(b.start)}–${fmtH(b.end)}${b.clearsAfter ? ', then VFR' : ''}`
        ).join(' · ');
    }

    _findFirstVfrTime(icao, day) {
        const sd = this._mosData?.stations?.[icao];
        if (!sd?.periods) return null;

        const dayStart = new Date(day); dayStart.setUTCHours(0, 0, 0, 0);
        const dayEnd   = new Date(day); dayEnd.setUTCHours(24, 0, 0, 0);

        const periods = sd.periods
            .filter(p => p.valid_time && p.flight_cat)
            .map(p => ({ vt: new Date(p.valid_time), cat: p.flight_cat }))
            .filter(p => p.vt >= dayStart && p.vt < dayEnd)
            .sort((a, b) => a.vt - b.vt);

        if (!periods.length) return null;
        if (periods[0].cat === 'VFR') return periods[0].vt;

        for (let i = 1; i < periods.length; i++) {
            if (periods[i].cat === 'VFR' && periods[i - 1].cat !== 'VFR') return periods[i].vt;
        }
        return null;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _normalizeMos(data) {
        if (!data) return data;
        if (data.stations && typeof data.stations === 'object') return data;
        const { fetched_at, ...rest } = data;
        return { fetched_at, stations: rest };
    }

    _getStationList() {
        const plan = this._flightPlan;
        if (!plan) return [];
        const dep  = plan.flight_plan?.departure  || plan.departure;
        const dest = plan.flight_plan?.destination || plan.destination;
        // Extract ICAO codes from waypoints (same structure used by approach charts)
        const wps = plan.waypoints || [];
        const icaos = wps.map(wp => wp.icao).filter(id => id && /^[A-Z]{3,4}$/.test(id));
        if (icaos.length) {
            // Guard: if waypoints were stored destination-first (e.g. reversed route
            // saved in an older session), the sort would put destination at the top.
            // Detect by checking whether the known departure appears last.
            if (dep && icaos[0] !== dep && icaos[icaos.length - 1] === dep) {
                icaos.reverse();
            }
            // Ensure destination appears last — flight plans often store only
            // intermediate waypoints, leaving the destination out of plan.waypoints.
            if (dest && dest !== dep && !icaos.includes(dest)) icaos.push(dest);
            return icaos;
        }
        // Fallback: departure/destination strings
        const list = [];
        if (dep) list.push(dep);
        if (dest && dest !== dep) list.push(dest);
        return list;
    }

    _getFlightWindow() {
        const plan = this._flightPlan;
        if (!plan) return null;
        const proposed = plan.filed_plan?.proposed_departure;
        const etdMs = proposed ? Math.max(new Date(proposed).getTime(), Date.now()) : Date.now();
        const legs = plan.flight_plan?.legs || [];
        const eteTotalMin = legs.reduce((s, l) => s + (l.ete_min || 0), 0);
        const etaMs = etdMs + (eteTotalMin > 0 ? eteTotalMin : 240) * 60000;
        return { etd: etdMs, eta: etaMs };
    }

    _filterByFlightWindow(notams) {
        const win = this._getFlightWindow();
        if (!win) return notams;
        return notams.filter(n => {
            const from = n.validFrom ? new Date(n.validFrom).getTime() : 0;
            const to   = n.validTo   ? (new Date(n.validTo).getTime() || Infinity) : Infinity;
            return from <= win.eta && to >= win.etd;
        });
    }

    /**
     * Worst flight category for a station on a given UTC day,
     * considering only prime flying hours (15Z–03Z, ~11AM–11PM Eastern).
     */
    _worstCatForDay(stationData, day) {
        if (!stationData?.periods) return null;
        const order = ['LIFR', 'IFR', 'MVFR', 'VFR'];
        let worst = null;

        const dayStart = new Date(day);
        dayStart.setUTCHours(15, 0, 0, 0); // 15Z = ~11AM Eastern
        const dayEnd   = new Date(day);
        dayEnd.setUTCHours(27, 0, 0, 0);   // next day 03Z = ~11PM Eastern

        for (const p of stationData.periods) {
            if (!p.valid_time || !p.flight_cat) continue;
            const vt = new Date(p.valid_time);
            if (vt < dayStart || vt >= dayEnd) continue;
            if (!worst || order.indexOf(p.flight_cat) < order.indexOf(worst)) {
                worst = p.flight_cat;
            }
        }
        return worst;
    }

    _isDayReliable(stationData, day) {
        if (!stationData?.periods) return true;
        const dayStart = new Date(day);
        dayStart.setUTCHours(15, 0, 0, 0);
        for (const p of stationData.periods) {
            if (!p.valid_time) continue;
            if (new Date(p.valid_time) >= dayStart && !p.reliable) return false;
        }
        return true;
    }

    /** Max thunderstorm probability on a given day across all stations */
    _maxTstormForDay(stations, day) {
        let max = 0;
        const dayStart = new Date(day); dayStart.setUTCHours(15, 0, 0, 0);
        const dayEnd   = new Date(day); dayEnd.setUTCHours(27, 0, 0, 0);
        for (const icao of stations) {
            const sd = this._mosData?.stations?.[icao];
            if (!sd?.periods) continue;
            for (const p of sd.periods) {
                if (!p.valid_time) continue;
                const vt = new Date(p.valid_time);
                if (vt < dayStart || vt >= dayEnd) continue;
                const tp = p.tp6 ?? p.tp12 ?? 0;
                if (tp > max) max = tp;
            }
        }
        return max;
    }

    _findBestDay(stations) {
        const now = new Date();
        const order = ['LIFR', 'IFR', 'MVFR', 'VFR'];
        let bestDay = null;
        let bestCat = null;

        for (let d = 0; d < 7; d++) {
            const day = new Date(now);
            day.setUTCDate(now.getUTCDate() + d);
            day.setUTCHours(0, 0, 0, 0);

            let worstForRoute = 'VFR';
            for (const icao of stations) {
                const sd = this._mosData?.stations?.[icao];
                const cat = this._worstCatForDay(sd, day);
                if (!cat) continue;
                if (order.indexOf(cat) < order.indexOf(worstForRoute)) {
                    worstForRoute = cat;
                }
            }

            if (!bestCat || order.indexOf(worstForRoute) > order.indexOf(bestCat)) {
                bestCat = worstForRoute;
                bestDay = { date: day, worstCat: worstForRoute };
            }
            if (bestCat === 'VFR') break; // can't do better
        }
        return bestDay;
    }

    _isSameDay(a, b) {
        return a.getUTCFullYear() === b.getUTCFullYear() &&
               a.getUTCMonth()    === b.getUTCMonth()    &&
               a.getUTCDate()     === b.getUTCDate();
    }

    _dayLabel(date, short = false) {
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const day  = days[date.getUTCDay()];
        const num  = date.getUTCDate();
        return short ? `${day}\n${num}` : `${day} ${date.getUTCMonth() + 1}/${num}`;
    }

    _cell(text, className) {
        const el = document.createElement('div');
        el.className = className || '';
        el.textContent = text;
        return el;
    }

    // ── METAR / TAF fetch ─────────────────────────────────────────────────────

    async _getRouteCoords() {
        if (this._routeCoords) return this._routeCoords;
        const coords = [];

        // Use coords already on the flight plan waypoints first — plan normalization
        // resolves lat/lon for all waypoints, so this avoids any DB access entirely.
        if (this._flightPlan?.waypoints) {
            for (const wp of this._flightPlan.waypoints) {
                if (wp.lat && wp.lon) {
                    if (wp.icao && coords.find(c => c.icao === wp.icao)) continue;
                    coords.push({ icao: wp.icao || '', lat: wp.lat, lon: wp.lon });
                }
            }
        }

        // Fallback: look up coordinates from NASR DB (only needed for bare ICAO plans)
        if (!coords.length) {
            for (const icao of this._getStationList()) {
                try {
                    const apt = await this._db.getAirport(icao);
                    if (apt?.lat && apt?.lon) coords.push({ icao, lat: apt.lat, lon: apt.lon });
                } catch (_) {}
            }
        }

        // Ensure the destination is always in the route line so corridor filter
        // doesn't exclude it when it's absent from plan.waypoints.
        const dest = this._flightPlan?.flight_plan?.destination || this._flightPlan?.destination;
        if (dest && !coords.find(c => c.icao === dest)) {
            try {
                const apt = await this._db.getAirport(dest);
                if (apt?.lat && apt?.lon) coords.push({ icao: dest, lat: apt.lat, lon: apt.lon });
            } catch (_) {}
        }

        this._routeCoords = coords;
        return coords;
    }

    async _getCorridorAirports(radiusNm = 20) {
        const coords = await this._getRouteCoords();
        if (!coords.length) return [];
        const seen = new Set();
        const airports = [];
        for (const c of coords) {
            try {
                // Race against a 4s timeout to guard against IDB-blocked state
                const nearby = await Promise.race([
                    this._db.getAirportsNear(c.lat, c.lon, radiusNm),
                    new Promise(resolve => setTimeout(() => resolve([]), 4000)),
                ]);
                for (const apt of (nearby || [])) {
                    const icao = apt.icao;    // keyPath in NASR DB is 'icao'
                    if (!icao || seen.has(icao)) continue;
                    seen.add(icao);
                    airports.push({ icao, lat: apt.lat, lon: apt.lon });
                }
            } catch (_) {}
        }
        return airports;
    }

    async _getRouteBbox(bufferDeg = 0.15) {
        const coords = await this._getRouteCoords();
        if (!coords.length) return null;
        const lats = coords.map(c => c.lat);
        const lons = coords.map(c => c.lon);
        return {
            s: Math.min(...lats) - bufferDeg,
            n: Math.max(...lats) + bufferDeg,
            w: Math.min(...lons) - bufferDeg,
            e: Math.max(...lons) + bufferDeg,
        };
    }

    async _fetchMetarTaf() {
        const stations = this._getStationList();
        if (!stations.length) return;

        this._metarData = null; this._tafData = null;
        this._renderMetarSection();

        try {
            // Bbox covers all METAR stations in the route corridor without requiring
            // NASR DB or knowing which airports are METAR reporters.
            const bbox = await this._getRouteBbox(this._corridorMi / 69);

            let metarPromise, tafPromise;
            if (bbox) {
                metarPromise = this._fetchMetarsByBbox(bbox);
                tafPromise   = this._fetchTafsByBbox(bbox);
            } else {
                // No route coords — fall back to by-ID, skipping navaid fixes
                const ids = stations.filter(id => /^K[A-Z]{3}$/.test(id));
                metarPromise = ids.length ? this._fetchMetarsForIds(ids) : Promise.resolve({});
                tafPromise   = ids.length ? this._fetchTafsStructured(ids) : Promise.resolve({});
            }

            const [metarRes, tafRes] = await Promise.allSettled([metarPromise, tafPromise]);
            const metars = metarRes.status === 'fulfilled' ? metarRes.value : {};
            this._tafData = tafRes.status === 'fulfilled' ? tafRes.value : {};

            // Trim to stations within 30nm of any route waypoint so bbox doesn't
            // flood the panel with off-route airports.
            const coords = this._routeCoords || [];
            if (coords.length) {
                for (const icao of Object.keys(metars)) {
                    const m = metars[icao];
                    if (m?.lat && m?.lon && this._distToNearestCoord(m.lat, m.lon, coords) > this._corridorMi)
                        delete metars[icao];
                }
            }
            this._metarData = metars;
            this._metarFetchedAt = Date.now();
        } catch (err) {
            console.error('METAR/TAF fetch failed:', err);
            this._metarData = { _error: true };
        }

        this._renderAgeGroup();
        this._renderMetarSection();
    }

    async _fetchMetarsForIds(ids) {
        if (!ids.length) return {};
        const base = Settings.workerBase || 'https://www.flywhere.app/api';
        const batches = [];
        for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
        const out = {};
        for (const batch of batches) {
            const url = `${base}/weather?type=metar&ids=${batch.join(',')}&format=json&hoursBeforeNow=2`;
            try {
                const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (!resp.ok) continue;
                const items = await resp.json();
                for (const item of (Array.isArray(items) ? items : [])) {
                    const icao = item.icaoId || item.station_id;
                    if (!icao || out[icao]) continue;
                    out[icao] = {
                        raw: item.rawOb || '',
                        decoded: WeatherClient.decodeMetar(item),
                        reportTime: item.reportTime,
                        lat: item.lat,
                        lon: item.lon,
                    };
                }
            } catch (_) {}
        }
        return out;
    }

    async _fetchMetarsByBbox(bbox) {
        const base = Settings.workerBase || 'https://www.flywhere.app/api';
        const url = `${base}/weather?type=metar&bbox=${bbox.s},${bbox.w},${bbox.n},${bbox.e}&format=json&hoursBeforeNow=2`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`METAR bbox failed: ${resp.status}`);
        const items = await resp.json();
        const out = {};
        for (const item of (Array.isArray(items) ? items : [])) {
            const icao = item.icaoId || item.station_id;
            if (!icao) continue;
            if (!out[icao] || new Date(item.reportTime) > new Date(out[icao].reportTime)) {
                out[icao] = { raw: item.rawOb || '', decoded: WeatherClient.decodeMetar(item), reportTime: item.reportTime, lat: item.lat, lon: item.lon };
            }
        }
        return out;
    }

    async _fetchTafsByBbox(bbox) {
        const base = Settings.workerBase || 'https://www.flywhere.app/api';
        const url = `${base}/weather?type=taf&bbox=${bbox.s},${bbox.w},${bbox.n},${bbox.e}&format=json`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`TAF bbox failed: ${resp.status}`);
        const items = await resp.json();
        const out = {};
        for (const item of (Array.isArray(items) ? items : [])) {
            const icao = item.icaoId;
            if (!icao) continue;
            out[icao] = {
                raw: item.rawTAF || '',
                issued: item.issueTime || null,
                valid_from: item.validTimeFrom || null,
                valid_to: item.validTimeTo || null,
                fcsts: item.fcsts || [],
            };
        }
        return out;
    }

    async _fetchMetarsById(ids) {
        const base = Settings.workerBase || 'https://www.flywhere.app/api';
        const url = `${base}/weather?type=metar&ids=${ids.join(',')}&format=json&hoursBeforeNow=2`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!resp.ok) throw new Error(`METAR ids failed: ${resp.status}`);
        const items = await resp.json();
        const out = {};
        for (const item of (Array.isArray(items) ? items : [])) {
            const icao = item.icaoId || item.station_id;
            if (!icao || out[icao]) continue;
            out[icao] = { raw: item.rawOb || '', decoded: WeatherClient.decodeMetar(item), reportTime: item.reportTime, lat: item.lat, lon: item.lon };
        }
        return out;
    }

    async _fetchTafsStructured(ids) {
        if (!ids.length) return {};
        const base = Settings.workerBase || 'https://www.flywhere.app/api';
        const batches = [];
        for (let i = 0; i < ids.length; i += 50) batches.push(ids.slice(i, i + 50));
        const results = await Promise.all(batches.map(async batch => {
            const url = `${base}/weather?type=taf&ids=${batch.join(',')}&format=json`;
            try {
                const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
                if (!resp.ok) return {};
                const items = await resp.json();
                const out = {};
                for (const item of (Array.isArray(items) ? items : [])) {
                    const icao = item.icaoId;
                    if (!icao) continue;
                    out[icao] = {
                        raw: item.rawTAF || '',
                        issued: item.issueTime || null,
                        valid_from: item.validTimeFrom || null,
                        valid_to: item.validTimeTo || null,
                        fcsts: item.fcsts || [],
                    };
                }
                return out;
            } catch (_) { return {}; }
        }));
        return Object.assign({}, ...results);
    }

    // ── Station card rendering ────────────────────────────────────────────────

    _buildStationCard(icao, metar, isOnRoute) {
        const d = metar.decoded || {};
        const cat = (d.flight_category || 'unknown').toLowerCase();
        const obsTime = metar.reportTime
            ? new Date(metar.reportTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' L'
            : '—';

        const card = document.createElement('div');
        card.className = 'wx-station-card';

        let proxLabel;
        if (isOnRoute) {
            const stations = this._getStationList();
            const idx = stations.indexOf(icao);
            if (idx === 0) proxLabel = 'DEPARTURE';
            else if (idx === stations.length - 1) proxLabel = 'DEST';
            else proxLabel = 'EN ROUTE';
        } else {
            proxLabel = this._distLabelToRoute(metar.lat, metar.lon);
        }

        card.innerHTML = `
            <div class="wx-card-hdr">
                <span class="wx-card-icao">${icao}</span>
                <span class="wx-card-prox${proxLabel === 'DEPARTURE' ? ' departure' : proxLabel === 'DEST' ? ' dest' : isOnRoute ? ' on-route' : ''}">${proxLabel}</span>
                <span class="wx-card-obs">${obsTime}</span>
                <span class="wx-card-cat ${cat}">${d.flight_category || '—'}</span>
                <span class="wx-card-chevron">›</span>
            </div>
            <div class="wx-card-body"></div>
        `;

        const hdr = card.querySelector('.wx-card-hdr');
        const body = card.querySelector('.wx-card-body');

        if (isOnRoute) {
            hdr.querySelector('.wx-card-chevron').classList.add('open');
            body.classList.add('open');
            this._populateStationCardBody(body, icao, metar);
        }

        hdr.addEventListener('click', () => {
            const chevron = hdr.querySelector('.wx-card-chevron');
            chevron.classList.toggle('open');
            body.classList.toggle('open');
            if (body.classList.contains('open') && !body.innerHTML.trim()) {
                this._populateStationCardBody(body, icao, metar);
            }
        });

        return card;
    }

    _populateStationCardBody(body, icao, metar) {
        const d = metar.decoded || {};
        const windDir = d.wind_variable ? 'VRB' : (d.wind_dir != null ? `${String(d.wind_dir).padStart(3, '0')}°` : null);
        const wind = windDir != null
            ? `${windDir} / ${d.wind_speed ?? '—'}kt${d.wind_gust ? ` G${d.wind_gust}` : ''}`
            : 'Calm';
        const vis  = d.visibility != null ? `${d.visibility} SM` : '—';
        const ceil = d.ceiling != null
            ? `${d.sky_condition?.find(s => s.base === d.ceiling)?.cover || 'BKN'} ${d.ceiling}ft`
            : 'CLR';
        const ceilClass = d.ceiling != null && d.ceiling < 1000 ? 'bad' : (d.ceiling != null && d.ceiling <= 3000 ? 'warn' : '');
        const visClass  = d.visibility != null && d.visibility < 3 ? 'bad' : (d.visibility != null && d.visibility <= 5 ? 'warn' : '');
        const temp = (d.temperature != null && d.dewpoint != null)
            ? `${d.temperature}° / ${d.dewpoint}°` : '—';
        const alt  = d.altimeter != null
            ? (d.altimeter > 500 ? (d.altimeter / 33.8639).toFixed(2) : d.altimeter.toFixed(2))
            : '—';

        let bodyHtml = `
            <div class="wx-metar-raw">${this._escHtml(metar.raw || '—')}</div>
            <div class="wx-decoded-grid">
                <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Wind</div><div class="wx-decoded-val">${wind}</div></div>
                <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Visibility</div><div class="wx-decoded-val ${visClass}">${vis}</div></div>
                <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Ceiling</div><div class="wx-decoded-val ${ceilClass}">${ceil}</div></div>
                <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Temp / Dew</div><div class="wx-decoded-val">${temp}</div></div>
                <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Altimeter</div><div class="wx-decoded-val">${alt}"</div></div>
                <div class="wx-decoded-cell"><div class="wx-decoded-lbl">Observed</div><div class="wx-decoded-val" style="font-size:11px">${metar.reportTime ? new Date(metar.reportTime).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) + ' L' : '—'}</div></div>
            </div>
        `;

        const taf = this._tafData?.[icao];
        if (taf?.fcsts?.length) {
            const issued = taf.issued ? new Date(taf.issued).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) + ' L' : '—';
            const vFrom  = taf.valid_from ? new Date(taf.valid_from * 1000).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'}) : '—';
            const vTo    = taf.valid_to   ? new Date(taf.valid_to   * 1000).toLocaleDateString([], {weekday:'short',month:'short',day:'numeric'}) : '—';
            bodyHtml += `<div class="wx-taf-hdr">TAF</div>`;
            bodyHtml += `<div class="wx-taf-issued">Issued ${issued} · Valid ${vFrom} → ${vTo}</div>`;
            for (const f of taf.fcsts) {
                bodyHtml += this._buildTafRow(f);
            }
        } else if (taf) {
            bodyHtml += `<div class="wx-taf-no">TAF: no structured forecast periods</div>`;
        } else {
            bodyHtml += `<div class="wx-taf-no">No TAF available</div>`;
        }

        body.innerHTML = bodyHtml;
    }

    _tafPeriodCat(fcst) {
        const clouds = fcst.clouds || [];
        const ceilLayer = clouds.find(c => c.cover === 'BKN' || c.cover === 'OVC' || c.cover === 'VV');
        const ceiling = ceilLayer ? ceilLayer.base : (fcst.vertVis != null ? fcst.vertVis : null);
        const rawVis = fcst.visib;
        const vis = (typeof rawVis === 'string' && rawVis.includes('+'))
            ? parseFloat(rawVis) : (rawVis != null ? parseFloat(rawVis) : null);
        return WeatherClient.getFlightCategory(ceiling, vis);
    }

    _buildTafRow(f) {
        const tf = new Date(f.timeFrom * 1000);
        const tt = new Date(f.timeTo   * 1000);
        const timeStr = `${tf.toLocaleDateString([], {weekday:'short'})} ${tf.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}–${tt.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})} L`;

        // Period change type — distinguishes FM (change at time), BECMG (transition),
        // TEMPO (intermittent), PROB30/40 (probability). Empty = initial period.
        let change = '';
        let changeKind = '';
        if (f.fcstChange === 'PROB' && f.probability) {
            change = `PROB${f.probability}`;
            changeKind = 'prob';
        } else if (f.fcstChange) {
            change = f.fcstChange;
            changeKind = f.fcstChange.toLowerCase();
        }

        const cat = this._tafPeriodCat(f);
        const catClass = cat.toLowerCase();

        // Vertical visibility (VVxxx) replaces the cloud layer when ceiling is indefinite.
        const clouds = f.clouds || [];
        const ceilLayer = clouds.find(c => c.cover === 'BKN' || c.cover === 'OVC');
        let ceilStr;
        if (f.vertVis != null) {
            ceilStr = `VV${String(Math.round(f.vertVis / 100)).padStart(3, '0')}`;
        } else if (ceilLayer) {
            ceilStr = `${ceilLayer.cover}${String(Math.round(ceilLayer.base / 100)).padStart(3, '0')}`;
        } else if (clouds[0]?.cover === 'SKC' || clouds[0]?.cover === 'CLR') {
            ceilStr = 'SKC';
        } else if (clouds[0]) {
            ceilStr = `${clouds[0].cover}${String(Math.round(clouds[0].base / 100)).padStart(3, '0')}`;
        } else {
            ceilStr = '—';
        }

        const windStr = (f.wdir != null && f.wspd != null)
            ? `${String(f.wdir).padStart(3, '0')}/${f.wspd}${f.wgst ? 'G' + f.wgst : ''}kt`
            : '—';
        const visStr = f.visib != null ? `${f.visib}SM` : '—';
        const wxStr = f.wxString || '';
        const shearStr = (f.wshearHgt != null && f.wshearDir != null && f.wshearSpd != null)
            ? `WS${String(Math.round(f.wshearHgt / 100)).padStart(3, '0')}/${String(f.wshearDir).padStart(3, '0')}${f.wshearSpd}kt`
            : '';

        const extras = [wxStr, shearStr].filter(Boolean).join(' · ');

        return `
            <div class="wx-taf-row${changeKind ? ' wx-taf-' + changeKind : ''}">
                <span class="wx-taf-change">${this._escHtml(change)}</span>
                <span class="wx-taf-time">${this._escHtml(timeStr)}</span>
                <span class="wx-taf-cat wx-cat-${catClass}">${cat}</span>
                <span class="wx-taf-wind">${this._escHtml(windStr)}</span>
                <span class="wx-taf-ceil">${this._escHtml(ceilStr)}</span>
                <span class="wx-taf-vis">${this._escHtml(visStr)}</span>
                <span class="wx-taf-extras">${this._escHtml(extras)}</span>
            </div>`;
    }

    // ── Distance helpers ──────────────────────────────────────────────────────

    /**
     * Distance in nautical miles from (lat, lon) to the nearest point on the
     * route line — perpendicular distance to the closest segment between
     * consecutive waypoints, not just to the nearest waypoint. The latter is
     * what the prior implementation did, which made stations in the middle of
     * a long route (e.g. KIAD on a KLKR→KMHT leg) appear hundreds of NM away
     * and get trimmed out, so only stations near the endpoints showed.
     */
    _distToNearestCoord(lat, lon, coords) {
        if (lat == null || lon == null || !coords.length) return 9999;
        const cosLat = Math.cos(lat * Math.PI / 180);
        const px = lon * cosLat, py = lat;
        if (coords.length === 1) {
            const c = coords[0];
            return Math.hypot(py - c.lat, px - c.lon * cosLat) * 60;
        }
        let min = Infinity;
        for (let i = 0; i < coords.length - 1; i++) {
            const a = coords[i], b = coords[i + 1];
            const ax = a.lon * cosLat, ay = a.lat;
            const bx = b.lon * cosLat, by = b.lat;
            const dx = bx - ax, dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            let d;
            if (lenSq === 0) {
                d = Math.hypot(px - ax, py - ay);
            } else {
                let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
                t = Math.max(0, Math.min(1, t));
                const cx = ax + t * dx, cy = ay + t * dy;
                d = Math.hypot(px - cx, py - cy);
            }
            if (d < min) min = d;
        }
        return min * 60;
    }

    _distLabelToRoute(lat, lon) {
        const coords = this._routeCoords || [];
        if (!lat || !lon || !coords.length) return '—';
        const nm = Math.round(this._distToNearestCoord(lat, lon, coords));
        return `${nm} NM`;
    }

    // ── AIRMET fetch & helpers ────────────────────────────────────────────────

    async _fetchAirmets() {
        this._airmets = null;
        this._renderAirmetSection();
        try {
            const client = new WeatherClient(this._db);
            const { airmets } = await client.fetchAndCacheAdvisories();
            for (const adv of (airmets || [])) {
                adv.states = this._statesForPoints(adv.points || []);
            }
            this._airmets = airmets;
            this._airmetFetchedAt = Date.now();
        } catch (err) {
            console.error('AIRMET fetch failed:', err);
            this._airmets = [];
        }
        this._renderAgeGroup();
        this._renderAirmetSection();
        this._renderPlanningSection();
    }

    _filterAdvisoriesForRoute(advisories) {
        const bufferDeg = this._corridorMi / 69;
        const coords = this._routeCoords || [];
        if (!coords.length || !advisories?.length) return advisories || [];

        const routeLats = coords.map(c => c.lat);
        const routeLons = coords.map(c => c.lon);
        const bbox = {
            s: Math.min(...routeLats) - bufferDeg,
            n: Math.max(...routeLats) + bufferDeg,
            w: Math.min(...routeLons) - bufferDeg,
            e: Math.max(...routeLons) + bufferDeg,
        };

        return advisories.filter(adv => {
            const pts = adv.points || [];
            if (!pts.length) return true;
            const advLats = pts.map(p => p[0]);
            const advLons = pts.map(p => p[1]);
            if (Math.max(...advLats) < bbox.s || Math.min(...advLats) > bbox.n) return false;
            if (Math.max(...advLons) < bbox.w || Math.min(...advLons) > bbox.e) return false;
            for (const c of coords) {
                if (this._pointInPolygon(c.lat, c.lon, pts)) return true;
            }
            return false;
        });
    }

    _pointInPolygon(lat, lon, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i][0], yi = polygon[i][1];
            const xj = polygon[j][0], yj = polygon[j][1];
            if (((yi > lon) !== (yj > lon)) && (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    _statesForPoints(points) {
        if (!points.length) return [];
        const lats = points.map(p => p[0]);
        const lons = points.map(p => p[1]);
        const cLat = lats.reduce((s, v) => s + v, 0) / lats.length;
        const cLon = lons.reduce((s, v) => s + v, 0) / lons.length;
        // Sample centroid + midpoints toward bbox edges to catch multi-state advisories
        const samples = [
            [cLat, cLon],
            [(Math.min(...lats) + cLat) / 2, cLon],
            [(Math.max(...lats) + cLat) / 2, cLon],
            [cLat, (Math.min(...lons) + cLon) / 2],
            [cLat, (Math.max(...lons) + cLon) / 2],
        ];
        // [abbr, minLat, maxLat, minLon, maxLon]
        const STATES = [
            ['AL',30.1,35.0,-88.5,-84.9],['AR',33.0,36.5,-94.6,-89.6],
            ['AZ',31.3,37.0,-114.8,-109.0],['CA',32.5,42.0,-124.5,-114.1],
            ['CO',37.0,41.0,-109.1,-102.0],['CT',41.0,42.1,-73.7,-71.8],
            ['DE',38.4,39.8,-75.8,-75.0],['FL',24.4,31.0,-87.6,-80.0],
            ['GA',30.3,35.0,-85.6,-80.8],['IA',40.4,43.5,-96.6,-90.1],
            ['ID',42.0,49.0,-117.2,-111.0],['IL',36.9,42.5,-91.5,-87.0],
            ['IN',37.8,41.8,-88.1,-84.8],['KS',37.0,40.0,-102.1,-94.6],
            ['KY',36.5,39.1,-89.6,-81.9],['LA',29.0,33.0,-94.0,-89.0],
            ['MA',41.2,42.9,-73.5,-69.9],['MD',37.9,39.7,-79.5,-75.0],
            ['ME',43.1,47.5,-71.1,-67.0],['MI',41.7,47.5,-90.4,-82.4],
            ['MN',43.5,49.4,-97.2,-89.5],['MO',36.0,40.6,-95.8,-89.1],
            ['MS',30.2,35.0,-91.7,-88.1],['MT',44.4,49.0,-116.0,-104.0],
            ['NC',33.8,36.6,-84.3,-75.5],['ND',45.9,49.0,-104.1,-96.6],
            ['NE',40.0,43.0,-104.1,-95.3],['NH',42.7,45.3,-72.6,-70.6],
            ['NJ',38.9,41.4,-75.6,-73.9],['NM',31.3,37.0,-109.1,-103.0],
            ['NV',35.0,42.0,-120.0,-114.0],['NY',40.5,45.0,-79.8,-71.9],
            ['OH',38.4,42.3,-84.8,-80.5],['OK',33.6,37.0,-103.0,-94.4],
            ['OR',42.0,46.2,-124.6,-116.5],['PA',39.7,42.3,-80.5,-74.7],
            ['RI',41.1,42.0,-71.9,-71.1],['SC',32.0,35.2,-83.4,-78.6],
            ['SD',42.5,45.9,-104.1,-96.4],['TN',35.0,36.7,-90.3,-81.6],
            ['TX',25.8,36.5,-106.6,-93.5],['UT',37.0,42.0,-114.1,-109.0],
            ['VA',36.5,39.5,-83.7,-75.2],['VT',42.7,45.0,-73.4,-71.5],
            ['WA',45.5,49.0,-124.8,-116.9],['WI',42.5,47.1,-92.9,-86.2],
            ['WV',37.2,40.6,-82.6,-77.7],['WY',41.0,45.0,-111.1,-104.1],
        ];
        const found = new Set();
        for (const [sLat, sLon] of samples) {
            for (const [abbr, s, n, w, e] of STATES) {
                if (sLat >= s && sLat <= n && sLon >= w && sLon <= e) found.add(abbr);
            }
        }
        return [...found].sort();
    }

    _buildRhsHeader(title, badgeClass, badgeText) {
        const hdr = document.createElement('div');
        hdr.className = 'wx-rhs-hdr';
        const badge = badgeClass
            ? `<span class="wx-rhs-badge ${badgeClass}">${badgeText}</span>`
            : `<span class="wx-rhs-badge">${badgeText}</span>`;
        hdr.innerHTML = `
            <span class="wx-rhs-title">${title}</span>
            ${badge}
            <span class="wx-rhs-chevron open">›</span>
        `;
        hdr.addEventListener('click', () => {
            const chevron = hdr.querySelector('.wx-rhs-chevron');
            chevron.classList.toggle('open');
            const body = hdr.nextElementSibling;
            if (body) body.classList.toggle('open');
        });
        return hdr;
    }

    _extractAviationSection(text) {
        if (!text) return text;
        // Find .AVIATION section header (case-insensitive)
        const match = text.match(/\.AVIATION\b[^\n]*/i);
        if (!match) return text;
        const start = text.indexOf(match[0]);
        // Find end: next section header starting with . on its own line, or end of text
        const rest = text.slice(start + match[0].length);
        const nextSection = rest.match(/\n\.[A-Z]{2}/);
        const end = nextSection ? rest.indexOf(nextSection[0]) : rest.length;
        return (match[0] + rest.slice(0, end)).trim();
    }

    _buildAdvCard(typeLabel, typeClass, hazard, meta, text, validHtml = '', expanded = false) {
        const card = document.createElement('div');
        card.className = 'wx-adv-card';
        card.innerHTML = `
            <div class="wx-adv-hdr">
                <span class="wx-adv-type ${typeClass}">${typeLabel}</span>
                <div class="wx-adv-info">
                    <div class="wx-adv-hazard">${this._escHtml(hazard)}</div>
                    <div class="wx-adv-meta">${this._escHtml(meta)}</div>
                </div>
                <span class="wx-adv-chevron${expanded ? ' open' : ''}">›</span>
            </div>
            <div class="wx-adv-body${expanded ? ' open' : ''}">
                <div class="wx-adv-text">${this._escHtml(text)}</div>
                ${validHtml ? `<div class="wx-adv-valid">${validHtml}</div>` : ''}
            </div>
        `;
        card.querySelector('.wx-adv-hdr').addEventListener('click', () => {
            const chevron = card.querySelector('.wx-adv-chevron');
            chevron.classList.toggle('open');
            card.querySelector('.wx-adv-body').classList.toggle('open');
        });
        return card;
    }

    _escHtml(str) {
        return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── NOTAM fetch & helpers ─────────────────────────────────────────────────

    async _fetchNotams() {
        this._notams = null;
        this._renderNotamSection();

        const stations = this._getStationList();
        if (!stations.length) { this._notams = []; this._renderNotamSection(); return; }

        try {
            const base = CockpitConfig.notamBase || Settings.workerBase || 'https://www.flywhere.app/api';
            const url  = `${base}/notams?location=${stations.join(',')}`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) {
                let errMsg = `NOTAM fetch failed (${resp.status})`;
                try { const d = await resp.json(); if (d.error) errMsg = d.error; } catch (_) {}
                throw new Error(errMsg);
            }
            const data = await resp.json();
            const features = data.features || [];

            const notams = [];
            const seen = new Set();
            for (const feature of features) {
                const n = feature.properties?.coreNOTAMData?.notam || {};
                const num = n.number || '';
                if (seen.has(num)) continue;
                seen.add(num);
                // n.location is the 3-letter FAA id (e.g. LKR); map back to ICAO
                const nLoc = (n.location || '').toUpperCase();
                const loc = stations.find(s => s === nLoc || s === 'K' + nLoc) || stations[0];
                notams.push(this._parseNotam(feature, loc));
            }

            const order = ['RWY', 'NAVAID', 'OBST', 'TWY', 'AD', 'SVC', 'OBST_LGT'];
            notams.sort((a, b) => {
                const ai = order.indexOf(a.type);
                const bi = order.indexOf(b.type);
                if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
                const aRoute = stations.indexOf(a.airport);
                const bRoute = stations.indexOf(b.airport);
                if (aRoute !== bRoute) return aRoute - bRoute;
                return 0;
            });

            this._notams = notams;
            this._notamFetchedAt = Date.now();
            try {
                localStorage.setItem('flytab_notam_cache', JSON.stringify({ fetched_at: Date.now(), data: notams }));
            } catch (_) {}
        } catch (err) {
            console.error('NOTAM fetch failed:', err);
            this._notamFetchError = err.message;
            try {
                const raw = localStorage.getItem('flytab_notam_cache');
                if (raw) { const c = JSON.parse(raw); this._notams = c.data || []; }
                else this._notams = [];
            } catch (_) { this._notams = []; }
        }

        this._renderAgeGroup();
        this._renderNotamSection();
    }

    async _fetchEnrouteNotams() {
        this._enrouteNotams = null;
        this._renderNotamSection();

        const bbox = await this._getRouteBbox(0);
        if (!bbox) {
            this._enrouteNotams = [];
            document.dispatchEvent(new CustomEvent('notam:tfrs', { detail: { shapes: [] } }));
            this._renderNotamSection();
            return;
        }

        // Pick the 2 nearest ARTCCs to the route center + national ZZZ
        const centerLat = (bbox.n + bbox.s) / 2;
        const centerLon = (bbox.e + bbox.w) / 2;
        const artccs = this._nearestArtccs(centerLat, centerLon, 2);
        const locations = [...artccs, 'ZZZ'].join(',');

        try {
            const base = CockpitConfig.notamBase || Settings.workerBase || 'https://www.flywhere.app/api';
            const resp = await fetch(`${base}/notams?location=${locations}`, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) {
                let errMsg = `En-route NOTAM fetch failed (${resp.status})`;
                try { const d = await resp.json(); if (d.error) errMsg = d.error; } catch (_) {}
                throw new Error(errMsg);
            }
            const data = await resp.json();
            const features = data.features || [];

            const seen = new Set();
            const notams = [];
            for (const feature of features) {
                const n = feature.properties?.coreNOTAMData?.notam || {};
                const num = n.number || n.id || '';
                if (seen.has(num)) continue;
                seen.add(num);

                // Skip cancellations — they remove a restriction, not add one
                if (n.type === 'C' || /\bNOTAMC\b/.test(n.text || '')) continue;

                // n.text is the plain prose field; simpleText can include ICAO-format headers
                const translations = feature.properties?.coreNOTAMData?.notamTranslation || [];
                const localFmt = translations.find(t => t.type === 'LOCAL_FORMAT');
                const raw = n.text || localFmt?.simpleText || '';

                if (!this._isEnrouteRelevant(raw)) continue;

                notams.push({
                    airport: n.location || '',
                    type: this._classifyEnrouteNotam(raw),
                    summary: this._summarizeEnrouteNotam(raw),
                    raw,
                    validFrom: n.effectiveStart || null,
                    validTo:   n.effectiveEnd   || null,
                    isEnroute: true,
                });
            }

            const PRIORITY = { TFR: 0, RESTR: 1, MOA: 2, WARN: 3, ATCAA: 4, UAS: 5, LASER: 6 };
            notams.sort((a, b) => {
                const ap = PRIORITY[a.type] ?? 9;
                const bp = PRIORITY[b.type] ?? 9;
                return ap !== bp ? ap - bp : a.airport.localeCompare(b.airport);
            });

            this._enrouteNotams = notams;
            this._enrouteNotamFetchedAt = Date.now();

            // Dispatch parsed TFR shapes to map layer
            const tfrShapes = notams
                .filter(n => n.type === 'TFR')
                .map(n => {
                    const geo = this._parseTfrGeometry(n.raw);
                    if (!geo) return null;
                    return { raw: n.raw, summary: n.summary, validFrom: n.validFrom, validTo: n.validTo, ...geo };
                })
                .filter(Boolean);
            document.dispatchEvent(new CustomEvent('notam:tfrs', { detail: { shapes: tfrShapes } }));
        } catch (err) {
            console.error('En-route NOTAM fetch failed:', err);
            this._enrouteNotamFetchError = err.message;
            this._enrouteNotams = [];
            document.dispatchEvent(new CustomEvent('notam:tfrs', { detail: { shapes: [] } }));
        }

        this._renderNotamSection();
    }

    _nearestArtccs(lat, lon, count = 2) {
        const table = [
            { id: 'KZAB', lat: 34.0, lon: -106.5 }, { id: 'KZAU', lat: 41.8, lon: -88.3  },
            { id: 'KZBW', lat: 42.8, lon: -71.7  }, { id: 'KZDC', lat: 38.9, lon: -77.5  },
            { id: 'KZDV', lat: 39.9, lon: -104.7 }, { id: 'KZFW', lat: 32.8, lon: -97.2  },
            { id: 'KZHU', lat: 30.1, lon: -95.4  }, { id: 'KZID', lat: 39.7, lon: -86.3  },
            { id: 'KZJX', lat: 30.5, lon: -82.2  }, { id: 'KZKC', lat: 38.9, lon: -94.7  },
            { id: 'KZLA', lat: 34.0, lon: -117.0 }, { id: 'KZLC', lat: 40.8, lon: -111.9 },
            { id: 'KZMA', lat: 25.8, lon: -80.3  }, { id: 'KZME', lat: 32.3, lon: -90.1  },
            { id: 'KZMP', lat: 44.9, lon: -93.2  }, { id: 'KZNY', lat: 40.6, lon: -73.8  },
            { id: 'KZOA', lat: 37.6, lon: -121.9 }, { id: 'KZOB', lat: 41.1, lon: -82.0  },
            { id: 'KZSE', lat: 47.5, lon: -122.3 }, { id: 'KZTL', lat: 33.6, lon: -84.6  },
        ];
        const cosLat = Math.cos(lat * Math.PI / 180);
        return table
            .map(a => ({ id: a.id, d: (a.lat - lat) ** 2 + ((a.lon - lon) * cosLat) ** 2 }))
            .sort((a, b) => a.d - b.d)
            .slice(0, count)
            .map(a => a.id);
    }

    _parseTfrGeometry(raw) {
        // Polygon: DDMM(N|S)/DDDMM(W|E) coordinate pairs (same pattern as fisb-client.js)
        const points = [];
        const polyPat = /(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/g;
        let m;
        while ((m = polyPat.exec(raw)) !== null) {
            let lat = parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
            if (m[3] === 'S') lat = -lat;
            let lon = parseInt(m[4], 10) + parseInt(m[5], 10) / 60;
            if (m[6] === 'W') lon = -lon;
            points.push([lat, lon]);
        }
        if (points.length >= 3) return { points };

        // Circle: "WITHIN n NM OF DDMM(N|S) DDDMM(W|E)" or "n-NM RADIUS OF ..."
        const circleMatch =
            raw.match(/WITHIN\s+(\d+(?:\.\d+)?)\s*NM\s+OF\s+(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i) ||
            raw.match(/(\d+(?:\.\d+)?)-NM\s+RADIUS.*?(\d{2})(\d{2})(N|S)\s*[\/]?\s*(\d{2,3})(\d{2})(W|E)/i);
        if (circleMatch) {
            const radiusNm = parseFloat(circleMatch[1]);
            let lat = parseInt(circleMatch[2], 10) + parseInt(circleMatch[3], 10) / 60;
            if (circleMatch[4] === 'S') lat = -lat;
            let lon = parseInt(circleMatch[5], 10) + parseInt(circleMatch[6], 10) / 60;
            if (circleMatch[7] === 'W') lon = -lon;
            return { lat, lon, radiusNm };
        }

        return null;
    }

    _isEnrouteRelevant(raw) {
        const r = raw.toUpperCase();
        return /\bTFR\b|TEMPORARY FLIGHT RESTRICTION/.test(r) ||
               /\bUAS\b|\bDRONE\b/.test(r) ||
               /\bLASER\b/.test(r) ||
               / P-\d+|\bPROHIBITED AREA\b/.test(r) ||
               / R-\d+|\bRESTRICTED AREA\b/.test(r) ||
               /\bMOA\b/.test(r) ||
               /\bWARNING AREA\b| W-\d+/.test(r) ||
               /\bATCAA\b/.test(r);
    }

    _classifyEnrouteNotam(raw) {
        const r = raw.toUpperCase();
        if (/\bTFR\b|TEMPORARY FLIGHT RESTRICTION/.test(r)) return 'TFR';
        if (/ P-\d+|\bPROHIBITED AREA\b/.test(r)) return 'RESTR';
        if (/ R-\d+|\bRESTRICTED AREA\b/.test(r)) return 'RESTR';
        if (/\bMOA\b/.test(r)) return 'MOA';
        if (/\bWARNING AREA\b| W-\d+/.test(r)) return 'WARN';
        if (/\bATCAA\b/.test(r)) return 'ATCAA';
        if (/\bUAS\b|\bDRONE\b/.test(r)) return 'UAS';
        if (/\bLASER\b/.test(r)) return 'LASER';
        return 'SUA';
    }

    _summarizeEnrouteNotam(raw) {
        // Strip leading "XX.." state prefix (e.g. "GA..AIRSPACE" → "AIRSPACE")
        return (raw || '').trim()
            .replace(/^[A-Z]{2}\.\./i, '')
            .replace(/\s+/g, ' ')
            .slice(0, 120);
    }

    _parseNotam(feature, airport) {
        const n = feature.properties?.coreNOTAMData?.notam || {};
        const translations = feature.properties?.coreNOTAMData?.notamTranslation || [];
        const localFmt = translations.find(t => t.type === 'LOCAL_FORMAT');
        const raw = localFmt?.simpleText || localFmt?.domestic_message || n.text || '';
        const type = this._classifyByQcode(n.selectionCode) || this._classifyNotam(raw);
        const summary = this._summarizeNotam(raw);
        return { airport, type, summary, raw, validFrom: n.effectiveStart || null, validTo: n.effectiveEnd || null };
    }

    _classifyByQcode(q) {
        if (!q) return null;
        q = q.toUpperCase();
        if (q.startsWith('QMR')) return 'RWY';
        if (q.startsWith('QNV') || q.startsWith('QPI')) return 'NAVAID';
        if (q.startsWith('QOL')) return 'OBST_LGT';
        if (q.startsWith('QOB')) return 'OBST';
        if (q.startsWith('QTW')) return 'TWY';
        if (q.startsWith('QFA') || q.startsWith('QAP')) return 'AD';
        return null;
    }

    _classifyNotam(raw) {
        const r = raw.toUpperCase();
        if (/\bRWY\b/.test(r)) return 'RWY';
        if (/\bNAVAID\b|ILS|VOR|NDB|LOC\b|PAPI|VASI/.test(r)) return 'NAVAID';
        if (/\bOBST\b|CRANE|TOWER|ANTENNA/.test(r)) return 'OBST';
        if (/\bTWY\b/.test(r)) return 'TWY';
        if (/\bAD\b|\bAPRON\b|\bRAMP\b/.test(r)) return 'AD';
        return 'SVC';
    }

    _summarizeNotam(raw) {
        // First line is "!TYPE NUM ICAO SUBJECT AIRPORT_NAME, STATE." — skip it
        const lines = raw.trim().split('\n').map(l => l.trim()).filter(Boolean);
        const content = lines.length > 1 ? lines.slice(1).join(' ') : lines[0] || '';
        return content.slice(0, 120);
    }

    // ── Planning Summary section ──────────────────────────────────────────────

    _buildPlanningNarrative(stations, day) {
        if (!this._mosData) return null;

        const dep  = stations[0];
        const dest = stations[stations.length - 1];
        const mids = stations.slice(1, -1).slice(0, 2);
        const key  = [dep, ...mids, dest];

        const fmtH = d => d.toLocaleTimeString([], { hour: 'numeric', hour12: true });
        const fmtDay = d => {
            const now = new Date();
            if (this._isSameDay(d, now)) return 'Today';
            const tomorrow = new Date(now); tomorrow.setUTCDate(now.getUTCDate() + 1);
            if (this._isSameDay(d, tomorrow)) return 'Tomorrow';
            return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        };

        const rows = [];
        let latestClearTime = null;

        for (const icao of key) {
            const sd = this._mosData.stations?.[icao];
            if (!sd) { rows.push({ icao, text: 'No MOS data', ok: null }); continue; }

            const worst = this._worstCatForDay(sd, day);
            if (!worst) { rows.push({ icao, text: 'No forecast', ok: null }); continue; }

            if (worst === 'VFR') {
                rows.push({ icao, text: 'VFR all day', ok: true });
            } else {
                const note  = this._buildMosSummaryNote(icao, day);
                const clear = this._findFirstVfrTime(icao, day);
                if (clear && (!latestClearTime || clear > latestClearTime)) latestClearTime = clear;
                const suffix = clear ? ` Clears ${fmtH(clear)}.` : ' No clear period.';
                const ok = worst === 'MVFR' ? 'warn' : false;
                rows.push({ icao, text: (note || worst) + suffix, ok });
            }
        }

        const warnings = [];
        if (this._airmets?.length) {
            const filtered = this._filterAdvisoriesForRoute(this._airmets);
            if (filtered.length) warnings.push(`${filtered.length} AIRMET${filtered.length > 1 ? 's' : ''} on route`);
        }

        const allVfr = rows.every(r => r.ok === true);
        let rec;
        if (allVfr) {
            rec = `${fmtDay(day)}: Route looks clear. Depart at your convenience.`;
        } else if (latestClearTime) {
            rec = `${fmtDay(day)}: Plan departure after ${fmtH(latestClearTime)} for VFR along the full route.`;
        } else {
            rec = `${fmtDay(day)}: IMC forecast along the route. Consider filing IFR or alternate date.`;
        }

        return { rows, warnings, rec, dayLabel: fmtDay(day) };
    }

    _renderPlanningSection() {
        const sec = this._section('wx-planning-section');
        if (!sec) return;

        const stations = this._getStationList();
        if (!stations.length) { sec.innerHTML = ''; return; }

        const dep  = stations[0];
        const dest = stations[stations.length - 1];
        const mid  = stations.slice(1, -1);

        const hdr = document.createElement('div');
        hdr.className = 'wx-rhs-hdr wx-planning-hdr';
        hdr.innerHTML = `
            <span class="wx-rhs-title wx-planning-title">PLANNING SUMMARY</span>
            <span class="wx-rhs-chevron open">›</span>
        `;
        const body = document.createElement('div');
        body.className = 'wx-rhs-body open';
        hdr.addEventListener('click', () => {
            hdr.querySelector('.wx-rhs-chevron')?.classList.toggle('open');
            body.classList.toggle('open');
        });

        const inner = document.createElement('div');
        inner.className = 'wx-planning-body';

        let routeStr = `${dep} → ${dest}`;
        if (mid.length) routeStr += ` via ${mid.join(', ')}`;
        let html = `<div class="wx-planning-route">${routeStr}</div>`;

        // Use best flying day if MOS available, else today
        const today = new Date(); today.setUTCHours(0, 0, 0, 0);
        const bestDay = this._mosData ? this._findBestDay(stations) : null;
        const targetDay = bestDay ? bestDay.date : today;

        const narrative = this._buildPlanningNarrative(stations, targetDay);

        if (narrative) {
            for (const row of narrative.rows) {
                const isOk   = row.ok === true;
                const isWarn = row.ok === 'warn';
                const isBad  = row.ok === false;
                const icon   = isOk ? '✅' : (isWarn ? '⚠' : (isBad ? '🚫' : ''));
                const cls    = isOk ? 'wx-planning-leg ok' : isWarn ? 'wx-planning-leg warn' : isBad ? 'wx-planning-leg bad' : 'wx-planning-leg';
                html += `<div class="${cls}">
                    <span class="wx-planning-icao">${row.icao}</span>
                    <span class="wx-planning-text">${icon ? icon + ' ' : ''}${this._escHtml(row.text)}</span>
                </div>`;
            }

            if (narrative.warnings.length) {
                html += `<div class="wx-planning-warn">⚠ ${narrative.warnings.join(' · ')}</div>`;
            }

            html += `<div class="wx-planning-rec">${this._escHtml(narrative.rec)}</div>`;
        } else {
            // MOS not yet loaded — show badge grid as fallback
            const now = new Date();
            const tomorrow = new Date(now); tomorrow.setUTCDate(now.getUTCDate() + 1);
            const fmtCat = cat => cat
                ? `<span class="wx-cat-badge wx-cat-${cat.toLowerCase()}">&nbsp;${cat}&nbsp;</span>`
                : '<span style="color:#888">—</span>';
            for (const icao of [dep, ...mid.slice(0, 2), dest]) {
                const sd = this._mosData?.stations?.[icao];
                if (!sd) continue;
                const todayCat = this._worstCatForDay(sd, now);
                const tmrwCat  = this._worstCatForDay(sd, tomorrow);
                if (!todayCat && !tmrwCat) continue;
                html += `<div class="wx-planning-row">
                    <b>${icao}</b> &nbsp;
                    Today: ${fmtCat(todayCat)} &nbsp;
                    Tomorrow: ${fmtCat(tmrwCat)}
                </div>`;
            }
            html += `<div class="wx-planning-row" style="color:#888;font-style:italic">Fetching forecast…</div>`;
        }

        inner.innerHTML = html;
        body.appendChild(inner);
        sec.innerHTML = '';
        sec.appendChild(hdr);
        sec.appendChild(body);
    }

    // ── AFD fetch ─────────────────────────────────────────────────────────────

    async _fetchAfds() {
        this._afds = null;
        this._renderAfdSection();
        try {
            const coords = await this._getRouteCoords();
            const keyCoords = coords;

            // Map cwa → { cwa: 'KXXX', name: 'Office Name NWS', airports: [] }
            const officeMap = new Map();
            for (const c of keyCoords) {
                try {
                    const ptResp = await fetch(`https://api.weather.gov/points/${c.lat.toFixed(4)},${c.lon.toFixed(4)}`,
                        { signal: AbortSignal.timeout(8000) });
                    if (!ptResp.ok) continue;
                    const pt = await ptResp.json();
                    const cwa = pt?.properties?.cwa;
                    if (!cwa) continue;
                    if (!officeMap.has(cwa)) {
                        // Fetch actual NWS office name (e.g. "Greenville-Spartanburg NWS")
                        let officeName = cwa;
                        try {
                            const offResp = await fetch(`https://api.weather.gov/offices/${cwa}`,
                                { signal: AbortSignal.timeout(6000) });
                            if (offResp.ok) {
                                const offData = await offResp.json();
                                // "National Weather Service Greenville-Spartanburg SC" → "Greenville-Spartanburg"
                                officeName = (offData.name || '')
                                    .replace(/^National Weather Service\s*/i, '')
                                    .replace(/\s+[A-Z]{2}$/, '');
                            }
                        } catch (_) {}
                        officeMap.set(cwa, {
                            cwa: `K${cwa}`,
                            name: officeName ? `${officeName} NWS` : cwa,
                            airports: [],
                        });
                    }
                    if (c.icao) officeMap.get(cwa).airports.push(c.icao);
                } catch (_) {}
            }

            if (!officeMap.size) throw new Error('No NWS offices found for route');

            const afds = [];
            for (const ep of officeMap.values()) {
                const displayName = ep.name +
                    (ep.airports.length ? ` — covers ${ep.airports.join('/')}` : '');
                try {
                    const pResp = await fetch(`https://api.weather.gov/products?type=AFD&office=${ep.cwa}&limit=1`,
                        { signal: AbortSignal.timeout(8000) });
                    if (!pResp.ok) continue;
                    const pData = await pResp.json();
                    const items = pData['@graph'] || [];
                    if (!items.length) continue;
                    const item = items[0];
                    const tResp = await fetch(item['@id'], { signal: AbortSignal.timeout(8000) });
                    if (!tResp.ok) continue;
                    const tData = await tResp.json();
                    afds.push({
                        office: ep.cwa,
                        name: displayName,
                        issued: item.issuanceTime || null,
                        text: tData.productText || item.productText || '',
                    });
                } catch (_) {}
            }

            this._afds = afds;
            this._afdFetchedAt = Date.now();
            try {
                localStorage.setItem('flytab_afd_cache', JSON.stringify({ fetched_at: Date.now(), data: afds }));
            } catch (_) {}
        } catch (err) {
            console.error('AFD fetch failed:', err);
            try {
                const raw = localStorage.getItem('flytab_afd_cache');
                if (raw) {
                    const cache = JSON.parse(raw);
                    if (Date.now() - cache.fetched_at < 4 * 3600000) {
                        this._afds = cache.data || [];
                    } else { this._afds = []; }
                } else { this._afds = []; }
            } catch (_) { this._afds = []; }
        }
        this._renderAfdSection();
    }
}
