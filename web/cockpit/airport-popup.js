/**
 * FlyTab — Airport Info Panel (v5)
 * Shows airport details in a right-side sliding panel with Info/Weather/Runway/Approach tabs.
 * Replaces the Leaflet popup for airports. Navaid popup remains as a small Leaflet popup.
 */

class AirportPopup {
    constructor(map, nasrDb) {
        this._map = map;
        this._nasr = nasrDb;
        this._popup = null;
        this._panel = null;
        this._panelOpen = false;
        this._ifrClearance = null;
        this._approachCharts = null;
        this._onDirectTo = null;
        this._fisbClient = null;
        this._vectorLayers = null;
        this._currentIcao = null;
        this._onFisbMetar = null;
        this._onInternetMetarBound = null;
        this._getRouteAirports = null;  // callback: () => { departure, destination }
    }

    /** Set callback that returns { departure, destination } waypoints from the active plan */
    setGetRouteAirports(fn) {
        this._getRouteAirports = fn;
    }

    /** Open panel showing departure airport (or search if no route loaded) */
    async showRouteAirports() {
        const airports = this._getRouteAirports?.() || {};
        if (airports.departure?.icao) {
            await this.showForAirport(airports.departure.icao);
        } else {
            // No route — open in search mode
            this._showSearchPanel();
        }
    }

    /**
     * Initialize the right-side panel DOM inside the given container (map-area).
     * Must be called after the map-area div exists.
     */
    initPanel(container) {
        if (this._panel) return;
        this._panel = document.createElement('div');
        this._panel.className = 'airport-panel';
        container.appendChild(this._panel);
    }

    /** Wire up FIS-B client for live weather updates */
    setFisbClient(fisbClient) {
        this._fisbClient = fisbClient;
    }

    /** Wire up vector layers so internet METARs are available in the popup */
    setVectorLayers(vectorLayers) {
        this._vectorLayers = vectorLayers;
    }

    /** Wire up IFR clearance module */
    setIfrClearance(ifrClearance) {
        this._ifrClearance = ifrClearance;
    }

    /** Wire up approach charts module */
    setApproachCharts(approachCharts) {
        this._approachCharts = approachCharts;
    }

    /** Set Direct-To callback */
    onDirectTo(callback) {
        this._onDirectTo = callback;
    }

    /**
     * Show airport info in the right-side sliding panel.
     * Auto-fetches weather from IndexedDB cache (seeded from plan or FIS-B).
     * @param {Object} airport — airport object from NASR bundle
     */
    async show(airport) {
        this._stopFisbListener();
        this._stopInternetMetarListener();
        this._currentIcao = airport.icao;

        // Look up cached weather — prefer FIS-B over plan data
        let wx = null;
        try {
            const cached = await this._nasr.getWeather(airport.icao);
            if (cached?.metar) wx = cached;
        } catch (_) {}

        // Internet METARs (pre-flight, online) — better than plan cache
        if (this._vectorLayers) {
            const im = this._vectorLayers._internetMetars?.get(airport.icao);
            if (im) {
                wx = {
                    metar: { raw: im.raw, decoded: im.decoded, fetched_at: new Date(im.received_at).toISOString() },
                    taf: wx?.taf || null,
                    source: 'internet',
                    fetched_at: new Date(im.received_at).toISOString(),
                };
            }
        }

        if (this._fisbClient) {
            const fisbMetar = this._fisbClient.getMetar(airport.icao);
            const fisbTaf = this._fisbClient.getTaf(airport.icao);
            if (fisbMetar) {
                wx = {
                    metar: { raw: fisbMetar.raw, decoded: fisbMetar.decoded, fetched_at: new Date(fisbMetar.received_at).toISOString() },
                    taf: fisbTaf ? { raw: fisbTaf.raw } : (wx?.taf || null),
                    source: 'fisb',
                    fetched_at: new Date(fisbMetar.received_at).toISOString(),
                };
            }
        }

        // Use sliding panel if available, else fall back to Leaflet popup
        if (this._panel) {
            this._showPanel(airport, wx);
        } else {
            this._showLeafletPopup(airport, wx);
        }

        this._startFisbListener(airport);
        this._startInternetMetarListener(airport);
        if (wx?.source === 'internet' && !wx.taf) this._fetchInternetTaf(airport.icao);
    }

    _showPanel(airport, wx) {
        if (!this._panel) return;

        this._panel.innerHTML = this._buildTopNavHtml(airport.icao) + this._buildPanelHtml(airport, wx);
        this._panel.classList.add('open');
        this._panelOpen = true;

        // Wire top-nav DEP / DEST / Search buttons
        this._wireTopNav();

        // Wire close button
        const closeBtn = this._panel.querySelector('.apt-panel-close');
        if (closeBtn) {
            wireTap(closeBtn, () => this.close());
        }

        // Wire action chips
        this._panel.querySelectorAll('.apt-chip[data-action]').forEach(chip => {
            const action = chip.dataset.action;
            wireTap(chip, () => {
                if (action === 'direct-to' && this._onDirectTo) {
                    this._onDirectTo(airport);
                    this.close();
                } else if (action === 'plates' && this._approachCharts) {
                    this._approachCharts.showForAirport(airport.icao);
                    this.close();
                } else if (action === 'add-route') {
                    // Add-to-route via route planner not yet implemented (Stage 2)
                    console.log('[FlyTab] Add to Route — Stage 2 feature');
                    this.close();
                } else if (action === 'craft' && this._ifrClearance) {
                    this._ifrClearance.show(null, airport, window.app?.stratuxClient?.situation);
                    this.close();
                }
            });
        });

        // Wire frequency rows
        this._panel.querySelectorAll('.freq-row[data-freq]').forEach(row => {
            wireTap(row, () => this._flashFrequency(row.dataset.freq));
        });

        // Wire phone rows
        this._panel.querySelectorAll('.ifr-phone, .airport-phone').forEach(phoneEl => {
            wireTap(phoneEl, () => {
                const phone = phoneEl.dataset.phone;
                navigator.clipboard?.writeText(phone);
                phoneEl.style.background = '#224433';
                setTimeout(() => phoneEl.style.background = '', 1000);
            });
        });

        // Wire tabs
        this._panel.querySelectorAll('.apt-tab[data-tab]').forEach(tab => {
            wireTap(tab, () => {
                // APPR tab: open the approach charts picker directly
                if (tab.dataset.tab === 'appr' && this._approachCharts) {
                    this._approachCharts.showForAirport(airport.icao);
                    this.close();
                    return;
                }
                this._panel.querySelectorAll('.apt-tab').forEach(t => t.classList.remove('active'));
                this._panel.querySelectorAll('.apt-tab-pane').forEach(p => p.classList.remove('active'));
                tab.classList.add('active');
                const pane = this._panel.querySelector(`.apt-tab-pane[data-pane="${tab.dataset.tab}"]`);
                if (pane) pane.classList.add('active');

                // Lazy-load panes on first activation
                if (tab.dataset.tab === 'diag') {
                    const platePaneEl = pane?.querySelector('.apt-plate-pane');
                    if (platePaneEl && !platePaneEl.dataset.loaded) {
                        platePaneEl.dataset.loaded = '1';
                        this._loadPlatePaneForType(platePaneEl, airport.icao, platePaneEl.dataset.plateType);
                    }
                }
                if (tab.dataset.tab === 'afd') {
                    const afdPaneEl = pane?.querySelector('.apt-afd-pane');
                    if (afdPaneEl && !afdPaneEl.dataset.loaded) {
                        afdPaneEl.dataset.loaded = '1';
                        this._loadAfdPane(afdPaneEl, airport.icao);
                    }
                }
            });
        });
    }

    _buildTopNavHtml(activeIcao) {
        const airports = this._getRouteAirports?.() || {};
        const dep  = airports.departure;
        const dest = airports.destination;

        const depLabel  = dep?.icao  || 'DEP';
        const destLabel = dest?.icao || 'DEST';

        const depActive  = activeIcao && dep?.icao  === activeIcao ? ' active' : '';
        const destActive = activeIcao && dest?.icao === activeIcao ? ' active' : '';

        // Only show DEP/DEST buttons when a route is loaded
        const routeBtns = (dep || dest) ? `
            <button class="apt-topnav-btn${depActive}"  data-topnav="dep">${depLabel}</button>
            <button class="apt-topnav-btn${destActive}" data-topnav="dest">${destLabel}</button>` : '';

        return `<div class="apt-top-nav">
            ${routeBtns}
            <span class="apt-topnav-spacer"></span>
            <button class="apt-topnav-btn" data-topnav="search">&#x1F50D;</button>
        </div>`;
    }

    _wireTopNav() {
        this._panel.querySelectorAll('.apt-topnav-btn[data-topnav]').forEach(btn => {
            wireTap(btn, async () => {
                const action = btn.dataset.topnav;
                const airports = this._getRouteAirports?.() || {};
                if (action === 'dep' && airports.departure?.icao) {
                    await this.showForAirport(airports.departure.icao);
                } else if (action === 'dest' && airports.destination?.icao) {
                    await this.showForAirport(airports.destination.icao);
                } else if (action === 'search') {
                    this._showSearchPanel();
                }
            });
        });
    }

    _showSearchPanel() {
        if (!this._panel) return;
        this._panel.innerHTML = `
            <div class="apt-top-nav">
                <span class="apt-topnav-spacer"></span>
                <button class="apt-topnav-btn" data-topnav="search-close">&#x2715;</button>
            </div>
            <div class="apt-search-box">
                <input class="apt-search-input" type="text" placeholder="ICAO or airport name…" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
            </div>
            <div class="apt-search-results"></div>`;
        this._panel.classList.add('open');
        this._panelOpen = true;

        const input   = this._panel.querySelector('.apt-search-input');
        const results = this._panel.querySelector('.apt-search-results');
        const closeBtn = this._panel.querySelector('[data-topnav="search-close"]');

        wireTap(closeBtn, () => this.close());

        let debounce = null;
        input.addEventListener('input', () => {
            clearTimeout(debounce);
            const q = input.value.trim();
            if (q.length < 2) { results.innerHTML = ''; return; }
            debounce = setTimeout(async () => {
                try {
                    await this._nasr.open();
                    const airports = await this._nasr.searchAirports(q.toUpperCase());
                    if (!airports?.length) {
                        results.innerHTML = '<div class="apt-search-empty">No airports found</div>';
                        return;
                    }
                    results.innerHTML = airports.slice(0, 12).map(a => `
                        <div class="apt-search-row" data-icao="${a.icao}">
                            <span class="apt-search-icao">${a.icao}</span>
                            <span class="apt-search-name">${a.name || ''}</span>
                        </div>`).join('');
                    results.querySelectorAll('.apt-search-row').forEach(row => {
                        wireTap(row, () => this.showForAirport(row.dataset.icao));
                    });
                } catch { results.innerHTML = '<div class="apt-search-empty">Search unavailable</div>'; }
            }, 250);
        });

        // Auto-focus (keyboard up) after a short delay
        setTimeout(() => input.focus(), 120);
    }

    _buildPanelHtml(apt, wx) {
        const towerStr = apt.tower ? 'TOWERED' : 'UNCONTROLLED';
        const elevStr = apt.elev_ft ? `${apt.elev_ft} ft` : '';
        const tpaStr = apt.tpa_ft ? ` · TPA ${apt.tpa_ft}` : '';

        // Weather VFR badge for header
        let catBadge = '';
        if (wx?.metar?.decoded?.flight_category) {
            const cat = wx.metar.decoded.flight_category;
            const catColors = { VFR: 'var(--cat-vfr)', MVFR: 'var(--cat-mvfr)', IFR: 'var(--cat-ifr)', LIFR: 'var(--cat-lifr)' };
            catBadge = `<span style="color:${catColors[cat] || '#aaa'};font-size:14px;font-weight:900;margin-left:6px;">● ${cat}</span>`;
        }

        // Distance and descent rate from current position
        let navInfoHtml = '';
        const sit = window.app?.stratuxClient?.situation;
        if (sit?.lat != null && sit?.lon != null && apt.lat != null && apt.lon != null) {
            const distNm = NasrDB.haversineNm(sit.lat, sit.lon, apt.lat, apt.lon);
            const distFmt = distNm < 10 ? distNm.toFixed(1) : Math.round(distNm);

            if (apt.elev_ft != null && sit.alt_msl != null && apt.type !== 'NAVAID') {
                const patternAbove = (typeof CockpitConfig !== 'undefined'
                    ? CockpitConfig.get('patternAltAboveFieldFt') : null) ?? 1000;
                const targetAlt = apt.elev_ft + patternAbove;
                const altDiff = sit.alt_msl - targetAlt;
                if (altDiff > 100 && distNm > 0.5 && sit.ground_speed > 10) {
                    const timeMin = (distNm / sit.ground_speed) * 60;
                    const descentFpm = Math.round(altDiff / timeMin);
                    navInfoHtml = `<div class="apt-panel-nav">${distFmt}nm · descend ${descentFpm} fpm → ${targetAlt.toLocaleString()} ft</div>`;
                } else {
                    navInfoHtml = `<div class="apt-panel-nav">${distFmt}nm</div>`;
                }
            } else {
                navInfoHtml = `<div class="apt-panel-nav">${distFmt}nm</div>`;
            }
        }

        return `
        <div class="apt-panel-header">
            <div>
                <div class="apt-panel-icao">${apt.icao}${catBadge}</div>
                <div class="apt-panel-name">${apt.name || ''}</div>
                <div class="apt-panel-meta">${apt.city || ''}${apt.state ? ', ' + apt.state : ''} · ${towerStr} · ${elevStr}${tpaStr}</div>
                ${navInfoHtml}
            </div>
            <button class="apt-panel-close btn-close" aria-label="Close">✕</button>
        </div>

        <div class="apt-action-chips">
            <button class="apt-chip" data-action="direct-to">D→ Direct</button>
            <button class="apt-chip" data-action="add-route">+ Route</button>
            <button class="apt-chip" data-action="plates">Plates</button>
        </div>

        <div class="apt-tabs">
            <button class="apt-tab active" data-tab="info">INFO</button>
            <button class="apt-tab" data-tab="wx">WX</button>
            <button class="apt-tab" data-tab="rwy">RWY</button>
            <button class="apt-tab" data-tab="diag">DIAG</button>
            <button class="apt-tab" data-tab="afd">A/FD</button>
        </div>

        <div class="apt-tab-content">
            <div class="apt-tab-pane active" data-pane="info">
                ${this._aptFactsHtml(apt)}
                ${this._frequenciesHtml(apt.frequencies || [], apt.tower)}
                ${this._fuelHtml(apt)}
                ${(CockpitConfig.get('ifr.showCdPhone') || CockpitConfig.get('ifr.showCraft')) ? this._ifrHtml(apt) : ''}
            </div>
            <div class="apt-tab-pane" data-pane="wx">
                ${wx ? this._weatherHtml(wx) : '<div style="padding:16px;color:var(--text-muted)">No weather data</div>'}
            </div>
            <div class="apt-tab-pane" data-pane="rwy">
                ${wx && apt.runways?.length ? this._bestRunwayHtml(apt.runways, wx) : ''}
                ${apt.runways?.length ? this._runwaysHtml(apt.runways) : '<div style="padding:16px;color:var(--text-muted)">No runway data</div>'}
            </div>
            <div class="apt-tab-pane" data-pane="diag">
                <div class="apt-plate-pane" data-plate-type="APD"></div>
            </div>
            <div class="apt-tab-pane" data-pane="afd">
                <div class="apt-afd-pane"></div>
            </div>
        </div>`;
    }

    _showLeafletPopup(airport, wx) {
        if (this._popup) this._map.closePopup(this._popup);

        const html = this._buildHtml(airport, wx);
        this._popup = L.popup({
            maxWidth: 340,
            minWidth: 280,
            className: 'airport-popup',
            closeButton: false,
            autoPan: true,
        })
            .setLatLng([airport.lat, airport.lon])
            .setContent(html);

        this._popup.on('add', () => this._bindActions(airport));
        this._popup.on('remove', () => { this._stopFisbListener(); this._stopInternetMetarListener(); });
        this._popup.openOn(this._map);
    }

    /** Listen for FIS-B METAR updates to live-refresh the open popup/panel */
    _startFisbListener(airport) {
        if (!this._fisbClient) return;
        this._onFisbMetar = (e) => {
            if (e.detail.icao !== airport.icao) return;
            const wx = {
                metar: { raw: e.detail.raw, decoded: e.detail.decoded, fetched_at: new Date(e.detail.received_at).toISOString() },
                source: 'fisb',
                fetched_at: new Date(e.detail.received_at).toISOString(),
            };
            // Update panel weather pane
            if (this._panel && this._panelOpen) {
                const wxPane = this._panel.querySelector('.apt-tab-pane[data-pane="wx"]');
                if (wxPane) {
                    wxPane.innerHTML = this._weatherHtml(wx);
                }
            }
            // Update legacy Leaflet popup
            if (this._popup) {
                const container = this._popup.getElement();
                if (container) {
                    const wxSection = container.querySelector('.popup-wx-section');
                    if (wxSection) wxSection.outerHTML = this._weatherHtml(wx);
                }
            }
        };
        this._fisbClient.addEventListener('fisb:metar', this._onFisbMetar);

        // Live TAF updates while popup is open
        this._onFisbTaf = (e) => {
            if (e.detail.icao !== airport.icao) return;
            const tafRaw = e.detail.raw;
            const pane = this._panel?.querySelector('.apt-tab-pane[data-pane="wx"]');
            if (pane) {
                const tafEl = pane.querySelector('.wx-taf');
                if (tafEl) {
                    tafEl.innerHTML = this._formatTaf(tafRaw);
                } else {
                    const metarEl = pane.querySelector('.wx-metar');
                    if (metarEl) {
                        metarEl.insertAdjacentHTML('afterend',
                            `<div class="popup-section-title" style="margin-top:10px">TAF</div>` +
                            `<div class="wx-metar wx-taf">${this._formatTaf(tafRaw)}</div>`);
                    }
                }
            }
        };
        this._fisbClient.addEventListener('fisb:taf', this._onFisbTaf);
    }

    _startInternetMetarListener(airport) {
        if (!this._vectorLayers) return;
        this._onInternetMetarBound = (icao, entry) => {
            if (icao !== airport.icao) return;
            if (this._fisbClient?.getMetar(icao)) return; // FIS-B takes priority
            const wx = {
                metar: { raw: entry.raw, decoded: entry.decoded, fetched_at: new Date(entry.received_at).toISOString() },
                source: 'internet',
                fetched_at: new Date(entry.received_at).toISOString(),
            };
            if (this._panel && this._panelOpen) {
                const wxPane = this._panel.querySelector('.apt-tab-pane[data-pane="wx"]');
                if (wxPane) wxPane.innerHTML = this._weatherHtml(wx);
            }
        };
        this._vectorLayers._onInternetMetar = this._onInternetMetarBound;
    }

    _stopInternetMetarListener() {
        if (this._vectorLayers && this._onInternetMetarBound) {
            this._vectorLayers._onInternetMetar = null;
            this._onInternetMetarBound = null;
        }
    }

    async _fetchInternetTaf(icao) {
        try {
            const url = `https://www.flywhere.app/api/weather?type=taf&ids=${icao}&format=json&hours=24`;
            const r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) return;
            const data = await r.json();
            const raw = (Array.isArray(data) ? data[0] : data)?.rawTAF || '';
            if (!raw || this._currentIcao !== icao) return;
            if (this._panel && this._panelOpen) {
                const wxPane = this._panel.querySelector('.apt-tab-pane[data-pane="wx"]');
                if (wxPane) {
                    const existing = wxPane.querySelector('.wx-metar');
                    if (existing && !wxPane.querySelector('.wx-taf')) {
                        existing.insertAdjacentHTML('afterend',
                            `<div class="popup-section-title" style="margin-top:10px">TAF</div><div class="wx-metar wx-taf">${this._formatTaf(raw)}</div>`);
                    }
                }
            }
        } catch { /* silent */ }
    }

    _stopFisbListener() {
        if (this._fisbClient) {
            if (this._onFisbMetar) {
                this._fisbClient.removeEventListener('fisb:metar', this._onFisbMetar);
                this._onFisbMetar = null;
            }
            if (this._onFisbTaf) {
                this._fisbClient.removeEventListener('fisb:taf', this._onFisbTaf);
                this._onFisbTaf = null;
            }
        }
        this._currentIcao = null;
    }

    /**
     * Look up an airport by ICAO and show popup.
     * @param {string} icao — airport identifier
     * @param {Array} [latlng] — optional [lat, lon] for popup position
     */
    async showForAirport(icao, latlng) {
        try {
            await this._nasr.open();
            const apt = await this._nasr.getAirport(icao);
            if (apt) {
                if (latlng) { apt.lat = latlng[0]; apt.lon = latlng[1]; }
                // Fetch runway data from AWC if missing from NASR bundle
                if (!apt.runways?.length) {
                    try {
                        const resp = await fetch(
                            `https://aviationweather.gov/api/data/airport?ids=${encodeURIComponent(icao)}&format=json`,
                            { signal: AbortSignal.timeout(5000) }
                        );
                        if (resp.ok) {
                            const data = await resp.json();
                            const awc = Array.isArray(data) ? data[0] : data;
                            if (awc?.runways?.length) {
                                apt.runways = awc.runways.map(r => {
                                    const [len, wid] = (r.dimension || '').split('x').map(Number);
                                    return { id: r.id, length_ft: len || 0, width_ft: wid || 0, surface: r.surface || '' };
                                });
                                // Cache on the NASR record
                                try {
                                    const db = await this._nasr.open();
                                    const tx = db.transaction('airports', 'readwrite');
                                    tx.objectStore('airports').put(apt);
                                } catch { /* non-critical */ }
                            }
                        }
                    } catch { /* offline */ }
                }
                this.show(apt);
            } else {
                // NASR not loaded yet (offline, first use) — show panel with stub so user knows why
                this._showOfflineStub(icao, latlng);
            }
        } catch (err) {
            console.warn('AirportPopup: lookup failed for', icao, err);
            this._showOfflineStub(icao, latlng);
        }
    }

    _showOfflineStub(icao, latlng) {
        if (!this._panel) return;
        const lat = latlng?.[0]?.toFixed(4) ?? '—';
        const lon = latlng?.[1]?.toFixed(4) ?? '—';
        this._panel.innerHTML = `
            <div class="apt-top-nav">
                <span class="apt-topnav-spacer"></span>
                <button class="apt-panel-close btn-close">✕</button>
            </div>
            <div style="padding:20px;color:var(--text-primary)">
                <div style="font-size:var(--text-xl);font-weight:700;margin-bottom:4px">${icao}</div>
                <div style="color:var(--text-muted);margin-bottom:16px">${lat}, ${lon}</div>
                <div style="color:var(--status-caution)">Airport data not available offline.</div>
                <div style="color:var(--text-secondary);margin-top:8px;font-size:var(--text-sm)">
                    Connect to the Pi to load NASR airport data.
                </div>
            </div>`;
        this._panel.classList.add('open');
        this._panelOpen = true;
        const closeBtn = this._panel.querySelector('.apt-panel-close');
        if (closeBtn) wireTap(closeBtn, () => this.close());
    }

    /**
     * Show popup for a navaid (VOR, NDB, VORTAC, etc.).
     * @param {Object} nav — navaid object from NASR bundle { id, name, type, lat, lon, freq }
     */
    showNavaid(nav) {
        if (this._popup) this._map.closePopup(this._popup);

        const typeColors = {
            'VOR': '#00ccaa', 'VORTAC': '#00ccaa', 'VOR/DME': '#00ccaa',
            'NDB': '#cc8800', 'NDB/DME': '#cc8800',
            'DME': '#8888ff', 'TACAN': '#8888ff',
        };
        const color = typeColors[(nav.type || '').toUpperCase()] || '#aaa';

        const html = `<div class="popup-header">
                <strong>${nav.id}</strong> — ${nav.name || ''}
                <div class="popup-subheader">${nav.type || 'NAVAID'}</div>
            </div>
            <div class="popup-section">
                <table class="popup-freq-table">
                    <tr class="freq-row" data-freq="${nav.freq || ''}">
                        <td style="color:${color}">${nav.type || 'FREQ'}</td>
                        <td class="freq-value">${nav.freq || '—'}</td>
                    </tr>
                </table>
            </div>
            <div class="popup-section" style="font-size:14px;color:#889">
                ${nav.lat?.toFixed(4) || '?'}°, ${nav.lon?.toFixed(4) || '?'}°
            </div>
            <div class="popup-actions">
                <button class="popup-btn" data-action="direct-to">D→</button>
                <button class="btn-close popup-btn popup-close-btn" data-action="close">✕</button>
            </div>`;

        this._popup = L.popup({
            maxWidth: 300,
            minWidth: 220,
            className: 'airport-popup',
            closeButton: false,
            autoPan: true,
        })
            .setLatLng([nav.lat, nav.lon])
            .setContent(html);

        this._popup.on('add', () => {
            const container = this._popup.getElement();
            if (!container) return;
            container.querySelectorAll('.freq-row').forEach(row => {
                wireTap(row, () => this._flashFrequency(row.dataset.freq));
            });
            container.querySelectorAll('.popup-btn').forEach(btn => {
                const action = btn.dataset.action;
                wireTap(btn, () => {
                    if (action === 'direct-to' && this._onDirectTo) {
                        this._onDirectTo({ icao: nav.id, name: nav.name, lat: nav.lat, lon: nav.lon });
                        this.close();
                    }
                    if (action === 'close') {
                        this.close();
                    }
                });
            });
        });
        this._popup.openOn(this._map);
    }

    /** Close any open popup or panel */
    close() {
        if (this._popup) {
            this._map.closePopup(this._popup);
            this._popup = null;
        }
        if (this._panel && this._panelOpen) {
            this._panel.classList.remove('open');
            this._panelOpen = false;
        }
        this._stopFisbListener();
        this._stopInternetMetarListener();
    }

    // ========== HTML Building ==========

    _buildHtml(apt, wx) {
        const sections = [];

        // Header
        sections.push(this._headerHtml(apt));

        // Runways + best runway
        if (apt.runways && apt.runways.length) {
            if (wx) sections.push(this._bestRunwayHtml(apt.runways, wx));
            sections.push(this._runwaysHtml(apt.runways));
        }

        // Frequencies
        if (apt.frequencies && apt.frequencies.length) {
            sections.push(this._frequenciesHtml(apt.frequencies, apt.tower));
        }

        // IFR section
        if (CockpitConfig.get('ifr.showCdPhone') || CockpitConfig.get('ifr.showCraft')) {
            sections.push(this._ifrHtml(apt));
        }

        // Weather
        if (wx) {
            sections.push(this._weatherHtml(wx));
        }

        // Action buttons
        sections.push(this._actionsHtml(apt));

        return sections.join('');
    }

    _headerHtml(apt) {
        const tpaStr = apt.tpa_ft ? `TPA ${apt.tpa_ft} MSL` : '';
        const towerStr = apt.tower ? 'TOWERED' : 'NON-TOWERED';
        const fuelStr = apt.fuel ? `Fuel: ${apt.fuel}` : '';
        const phoneStr = apt.phone
            ? `<br><span class="airport-phone" data-phone="${apt.phone}" style="cursor:pointer;color:#88ccff;">☎ ${apt.phone}</span>`
            : '';

        return `<div class="popup-header">
            <strong>${apt.icao}</strong> — ${apt.name || ''}
            <div class="popup-subheader">
                ${apt.city || ''}${apt.state ? ', ' + apt.state : ''}
                | ${towerStr} | Elev ${apt.elev_ft || '?'} ft
                ${tpaStr ? '| ' + tpaStr : ''}
                ${fuelStr ? '<br>' + fuelStr : ''}
                ${phoneStr}
            </div>
        </div>`;
    }

    /**
     * Load a plate (APD = airport diagram, MIN = airport info page) into a pane.
     * Shows the plate inline as an <img> (WebP converted) or <iframe> (PDF fallback).
     * Uses the approach charts module's plate index if available.
     */
    /**
     * Load the A/FD (Airport/Facility Directory) Chart Supplement page for an airport.
     * The pipeline downloads per-airport pages from the FAA Chart Supplement and stores
     * them as AFD_PAGE.webp in data/plates/{ICAO}/AFD_PAGE.webp via NanoHTTPD.
     */
    async _loadAfdPane(containerEl, icao) {
        containerEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">Loading A/FD…</div>';
        const PLATES_BASE = 'http://localhost:9090/plates';
        const strippedId = icao.replace(/^K/, '');
        const webpUrl = `${PLATES_BASE}/${icao.toUpperCase()}/AFD_PAGE.webp`;
        const webpUrlFaa = `${PLATES_BASE}/${strippedId.toUpperCase()}/AFD_PAGE.webp`;

        const thumb = document.createElement('img');
        thumb.alt = `${icao} A/FD`;
        thumb.style.cssText = 'width:100%;display:block;cursor:pointer;';

        thumb.onload = () => {
            containerEl.innerHTML = '';
            const hint = document.createElement('div');
            hint.style.cssText = 'padding:6px 12px;font-size:11px;color:var(--text-muted);text-align:center;';
            hint.textContent = 'Tap to open full screen';
            containerEl.appendChild(hint);
            containerEl.appendChild(thumb);

            // Tap thumbnail → open fullscreen overlay
            const open = () => this._openAfdFullscreen(webpUrl, icao);
            thumb.addEventListener('click', open);
            thumb.addEventListener('touchend', (e) => { e.preventDefault(); open(); }, { passive: false });
        };

        thumb.onerror = () => {
            // Small US airports stored under FAA id (X60) not K-prefixed app id (KX60)
            if (thumb.src.includes(`/${icao.toUpperCase()}/`) && strippedId !== icao) {
                thumb.src = webpUrlFaa;
                return;
            }
            containerEl.innerHTML = `
                <div style="padding:16px;color:var(--text-muted);font-size:13px">
                    <div style="font-weight:600;margin-bottom:8px;color:var(--text-primary)">${icao} — Chart Supplement</div>
                    <div>A/FD page not available for this airport.</div>
                    <div style="margin-top:8px;font-size:11px;color:var(--text-dim)">
                        Sync approach plates from the home server to download A/FD pages.
                    </div>
                </div>`;
        };

        thumb.src = webpUrl;
    }

    /** Open A/FD page as a full-screen overlay with close button top-right and pinch-zoom */
    _openAfdFullscreen(webpUrl, icao) {
        document.getElementById('afdFullscreenOverlay')?.remove();

        const overlay = document.createElement('div');
        overlay.id = 'afdFullscreenOverlay';
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            z-index: 9998;
            background: #111;
            display: flex; flex-direction: column;
            touch-action: none;
        `;

        // Header bar with title + close button top-right
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex; align-items: center;
            padding: 10px 12px;
            padding-top: max(10px, env(safe-area-inset-top));
            background: #1a1a2e;
            border-bottom: 1px solid #333;
            flex-shrink: 0;
            gap: 8px;
        `;
        header.innerHTML = `
            <span style="flex:1;font-size:15px;font-weight:700;color:#e8ecf0;">${icao} — Chart Supplement (A/FD)</span>
            <button id="afdCloseBtn" style="
                background:#cc2222;color:#fff;border:none;border-radius:6px;
                padding:6px 14px;font-size:15px;font-weight:700;
                min-width:44px;min-height:44px;cursor:pointer;
                touch-action:manipulation;flex-shrink:0;
            ">✕</button>`;

        const imgWrap = document.createElement('div');
        imgWrap.style.cssText = 'flex:1;overflow:hidden;position:relative;';

        const img = document.createElement('img');
        img.src = webpUrl;
        img.alt = `${icao} A/FD`;
        img.style.cssText = 'width:100%;display:block;';

        imgWrap.appendChild(img);
        overlay.appendChild(header);
        overlay.appendChild(imgWrap);
        document.body.appendChild(overlay);

        // Close button
        overlay.querySelector('#afdCloseBtn').addEventListener('click', () => overlay.remove());
        overlay.querySelector('#afdCloseBtn').addEventListener('touchend', (e) => {
            e.preventDefault();
            overlay.remove();
        }, { passive: false });

        // Block touches from reaching map underneath
        overlay.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        overlay.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });

        // Pinch-zoom on the full-screen image
        this._enablePinchZoom(img);
    }

    /**
     * Load a list of plates grouped by type (IAP / DP / STAR etc.) with tap-to-view.
     * Used for the IAP tab.
     */
    async _loadPlateListPane(containerEl, icao) {
        containerEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">Loading…</div>';
        const PLATES_BASE = 'http://localhost:9090/plates';

        try {
            let plateIndex = this._approachCharts?._plateIndex || null;
            if (!plateIndex) {
                const r = await fetch(`${PLATES_BASE}/plate_index.json`, {
                    cache: 'no-store', signal: AbortSignal.timeout(5000),
                });
                if (r.ok) {
                    plateIndex = await r.json();
                    if (this._approachCharts && !this._approachCharts._plateIndex) {
                        this._approachCharts._plateIndex = plateIndex;
                    }
                }
            }

            // Plate index uses FAA identifiers: real ICAO airports keep their K
            // prefix (KATL, KMCO) but small airports are indexed without it
            // (X60, 75J, 15J). The index key is also the on-disk directory name.
            const faaId = (plateIndex?.[icao] ? icao : (plateIndex?.[icao.replace(/^K/, '')] ? icao.replace(/^K/, '') : icao));
            const entry = plateIndex?.[faaId];
            const allPlates = entry?.plates || (Array.isArray(entry) ? entry : []);

            // Filter and group by type
            const WANTED_CODES = ['IAP', 'DP', 'STAR', 'ODP'];
            const CODE_LABELS = { IAP: 'Approaches', DP: 'Departures', STAR: 'Arrivals', ODP: 'ODP' };
            const plates = allPlates.filter(p => WANTED_CODES.includes(p.chart_code));

            if (!plates.length) {
                containerEl.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px">
                    No instrument procedures found for ${icao}.<br>
                    <span style="font-size:11px;color:var(--text-dim)">Sync approach plates from the home server to enable this tab.</span>
                </div>`;
                return;
            }

            // Group by chart_code
            const groups = {};
            for (const p of plates) {
                if (!groups[p.chart_code]) groups[p.chart_code] = [];
                groups[p.chart_code].push(p);
            }

            let html = '<div class="apt-plate-list">';
            for (const code of WANTED_CODES) {
                if (!groups[code]) continue;
                html += `<div class="apt-plate-group-header">${CODE_LABELS[code] || code}</div>`;
                for (const p of groups[code]) {
                    const name = p.chart_name || p.name || p.pdf_name;
                    html += `<button class="apt-plate-list-row" data-pdf="${p.pdf_name}" data-name="${name.replace(/"/g, '&quot;')}">${name}</button>`;
                }
            }
            html += '</div>';

            containerEl.innerHTML = html;

            // Wire plate rows to show viewer
            containerEl.querySelectorAll('.apt-plate-list-row').forEach(row => {
                wireTap(row, () => {
                    const file = row.dataset.pdf;
                    const name = row.dataset.name;
                    const webpUrl = `${PLATES_BASE}/${faaId}/${file.replace(/\.pdf$/i, '.webp')}`;
                    const pdfUrl  = `${PLATES_BASE}/${faaId}/${file}`;

                    containerEl.innerHTML = `
                        <div class="apt-plate-viewer">
                            <button class="apt-plate-back-btn">← Back</button>
                            <div class="apt-plate-title">${name}</div>
                            <div class="apt-plate-img-wrap">
                                <img class="apt-plate-img" src="${webpUrl}" alt="${name}"
                                     onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='block'">
                                <iframe class="apt-plate-iframe" src="${pdfUrl}" style="display:none" title="${name}"></iframe>
                            </div>
                        </div>`;

                    const img = containerEl.querySelector('.apt-plate-img');
                    if (img) this._enablePinchZoom(img);

                    const backBtn = containerEl.querySelector('.apt-plate-back-btn');
                    if (backBtn) {
                        backBtn.addEventListener('click', () => {
                            containerEl.dataset.loaded = '';
                            this._loadPlateListPane(containerEl, icao);
                        });
                    }
                });
            });

        } catch (err) {
            containerEl.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px">Error: ${err.message}</div>`;
        }
    }

    async _loadPlatePaneForType(containerEl, icao, plateType) {
        containerEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">Loading…</div>';

        const PLATES_BASE = 'http://localhost:9090/plates';

        try {
            // Ensure plate index is loaded — fetch directly if approach charts module hasn't loaded it yet
            let plateIndex = this._approachCharts?._plateIndex || null;
            if (!plateIndex) {
                try {
                    const r = await fetch(`${PLATES_BASE}/plate_index.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
                    if (r.ok) {
                        plateIndex = await r.json();
                        // Cache it in approach charts module for future use
                        if (this._approachCharts && !this._approachCharts._plateIndex) {
                            this._approachCharts._plateIndex = plateIndex;
                        }
                    }
                } catch { /* plate_index.json optional */ }
            }

            // Try to get plates from index — strip leading K for small airports
            // whose FAA identifier doesn't carry the K prefix (X60, 75J, etc.)
            let plate = null;
            let faaId = icao;
            if (plateIndex) {
                faaId = plateIndex[icao] ? icao : (plateIndex[icao.replace(/^K/, '')] ? icao.replace(/^K/, '') : icao);
                const entry = plateIndex[faaId];
                const plates = entry?.plates || (Array.isArray(entry) ? entry : []);
                // APD = airport diagram, MIN = minimums/airport info page
                plate = plates.find(p => {
                    const t = (p.type || p.chart_code || '').toUpperCase();
                    return t === plateType || t.includes(plateType);
                });
                // Fallback: match by name
                if (!plate) {
                    const nameMap = { APD: 'airport diagram', MIN: 'takeoff minimums' };
                    const needle = nameMap[plateType] || plateType.toLowerCase();
                    plate = plates.find(p => (p.name || p.chart_name || '').toLowerCase().includes(needle));
                }
            }

            if (!plate) {
                const typeLabel = plateType === 'APD' ? 'Airport Diagram' : 'Airport Information';
                const hint = plateType === 'APD'
                    ? 'Not all airports have FAA-published diagrams. Diagrams are typically published for towered and busier airports.'
                    : 'Sync approach plates from the home server to enable this tab.';
                containerEl.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px">
                    No ${typeLabel} available for ${icao}.<br>
                    <span style="font-size:11px;color:var(--text-dim)">${hint}</span>
                </div>`;
                return;
            }

            const file = plate.filename || plate.pdf_name;
            const icaoDir = faaId.toUpperCase();

            // Try WebP first (converted by plate pipeline), fallback to PDF in iframe
            const webpUrl = `${PLATES_BASE}/${icaoDir}/${file.replace(/\.pdf$/i, '.webp')}`;
            const pdfUrl  = `${PLATES_BASE}/${icaoDir}/${file}`;

            const name = plate.name || plate.chart_name || plateType;

            // Build viewer: image with pinch-zoom wrapper
            containerEl.innerHTML = `
                <div class="apt-plate-viewer">
                    <div class="apt-plate-title">${name}</div>
                    <div class="apt-plate-img-wrap">
                        <img class="apt-plate-img" src="${webpUrl}" alt="${name}"
                             onerror="this.onerror=null;this.src='${pdfUrl}';this.style.display='none';
                                      this.nextElementSibling.style.display='block'">
                        <iframe class="apt-plate-iframe" src="${pdfUrl}" style="display:none"
                                title="${name}"></iframe>
                    </div>
                </div>`;

            // Enable pinch-zoom on the image
            const img = containerEl.querySelector('.apt-plate-img');
            if (img) this._enablePinchZoom(img);

        } catch (err) {
            containerEl.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px">Error loading plate: ${err.message}</div>`;
        }
    }

    /** Basic pinch-to-zoom and pan for a plate image */
    _enablePinchZoom(el) {
        let scale = 1, lastScale = 1;
        let tx = 0, ty = 0, lastTx = 0, lastTy = 0;
        let initDist = null, initMid = null;
        let lastTap = 0;

        const applyTransform = () => {
            el.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
            el.style.transformOrigin = '0 0';
        };

        el.parentElement.style.cssText = 'overflow:hidden;position:relative;touch-action:none;cursor:grab';

        el.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                initDist = Math.hypot(dx, dy);
                initMid = { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
                lastScale = scale;
                lastTx = tx; lastTy = ty;
            } else if (e.touches.length === 1) {
                // Double-tap to reset
                const now = Date.now();
                if (now - lastTap < 300) { scale = 1; tx = 0; ty = 0; applyTransform(); }
                lastTap = now;
                initMid = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                lastTx = tx; lastTy = ty;
            }
        }, { passive: true });

        el.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 2 && initDist) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const dist = Math.hypot(dx, dy);
                scale = Math.max(0.5, Math.min(8, lastScale * dist / initDist));
                const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                tx = lastTx + (mx - initMid.x);
                ty = lastTy + (my - initMid.y);
                applyTransform();
            } else if (e.touches.length === 1 && scale > 1 && initMid) {
                tx = lastTx + (e.touches[0].clientX - initMid.x);
                ty = lastTy + (e.touches[0].clientY - initMid.y);
                applyTransform();
            }
        }, { passive: false });

        el.addEventListener('touchend', () => { initDist = null; initMid = null; }, { passive: true });
    }

    _runwaysHtml(runways) {
        const rows = runways.map(rwy =>
            `<tr>
                <td>${rwy.id}</td>
                <td>${rwy.length_ft || '?'} x ${rwy.width_ft || '?'}</td>
                <td>${rwy.surface || ''}</td>
            </tr>`
        ).join('');

        return `<div class="popup-section">
            <table class="popup-rwy-table">
                <tr><th>RWY</th><th>SIZE</th><th>SURF</th></tr>
                ${rows}
            </table>
        </div>`;
    }

    _aptFactsHtml(apt) {
        const facts = [];
        if (apt.elev_ft != null) facts.push({ label: 'ELEV', value: `${apt.elev_ft} ft` });
        if (apt.tpa_ft)          facts.push({ label: 'TPA',  value: `${apt.tpa_ft} ft` });
        if (apt.longest_rwy_ft)  facts.push({ label: 'RWY',  value: `${apt.longest_rwy_ft} ft` });
        // Runway directions (e.g. "34/16")
        if (apt.runways?.length) {
            const dirs = apt.runways.map(r => r.id || '').filter(Boolean).join(', ');
            if (dirs) facts.push({ label: 'DIR', value: dirs });
        }
        if (!facts.length) return '';
        const cells = facts.map(f =>
            `<div class="apt-fact"><div class="apt-fact-label">${f.label}</div><div class="apt-fact-value">${f.value}</div></div>`
        ).join('');
        return `<div class="popup-section apt-facts-row">${cells}</div>`;
    }

    _fuelHtml(apt) {
        if (!apt.fuel) return '';
        return `<div class="popup-section apt-facts-row"><div class="apt-fact"><div class="apt-fact-label">FUEL</div><div class="apt-fact-value">${apt.fuel}</div></div></div>`;
    }

    _frequenciesHtml(frequencies, isTowered) {
        // Sort by priority from config
        const categories = CockpitConfig.get('frequency_categories') || [];
        const priorityMap = {};
        for (const cat of categories) {
            priorityMap[cat.key] = cat.priority || 99;
        }

        const sorted = [...frequencies].sort((a, b) => {
            const pa = priorityMap[a.type] || 99;
            const pb = priorityMap[b.type] || 99;
            return pa - pb;
        });

        // For non-towered, promote CTAF
        if (!isTowered) {
            const ctafIdx = sorted.findIndex(f => f.type === 'ctaf');
            if (ctafIdx > 0) {
                const [ctaf] = sorted.splice(ctafIdx, 1);
                sorted.unshift(ctaf);
            }
        }

        const rows = sorted.map(freq => {
            const cat = categories.find(c => c.key === freq.type);
            const label = cat?.label || freq.type?.toUpperCase() || '';
            const color = cat?.color || '#aaa';
            const isPrimary = (!isTowered && freq.type === 'ctaf') || (isTowered && freq.type === 'twr');
            const star = isPrimary ? ' <span class="freq-primary">★</span>' : '';

            return `<tr class="freq-row" data-freq="${freq.freq}">
                <td style="color:${color}">${label}${star}</td>
                <td class="freq-value">${freq.freq}</td>
            </tr>`;
        }).join('');

        return `<div class="popup-section">
            <table class="popup-freq-table">
                ${rows}
            </table>
        </div>`;
    }

    _ifrHtml(apt) {
        const parts = [];
        parts.push('<div class="popup-section popup-ifr-section">');
        parts.push('<div class="popup-section-title">IFR CLEARANCE</div>');

        // CD phone number: prefer NASR data, fall back to config, then generic FSS
        const cdPhones = CockpitConfig.get('ifr.cdPhones') || {};
        const cdInfo = cdPhones[apt.icao];
        const phone = apt.cd_phone || cdInfo?.phone || CockpitConfig.get('ifr.defaultCdPhone') || '1-888-766-8267';
        const facility = apt.cd_facility || cdInfo?.facility || (apt.cd_phone ? '' : 'FSS');

        // Show CLR DEL freq if available
        const clrDel = (apt.frequencies || []).find(f => f.type === 'clr_del');
        if (clrDel) {
            parts.push(`<div class="ifr-freq">CLR DEL: <span class="freq-value">${clrDel.freq}</span></div>`);
        }

        parts.push(`<div class="ifr-phone" data-phone="${phone}">☎ ${phone} <span class="ifr-facility">(${facility})</span></div>`);
        parts.push('</div>');

        return parts.join('');
    }

    _weatherHtml(wx) {
        const metar = wx.metar;
        if (!metar) return '';
        const d = metar.decoded || {};
        const raw = metar.raw || '';

        // Flight category
        const catColors = { VFR: 'var(--cat-vfr)', MVFR: 'var(--cat-mvfr)', IFR: 'var(--cat-ifr)', LIFR: 'var(--cat-lifr)' };
        const catBg     = { VFR: '#00cc4418', MVFR: '#0088ff18', IFR: '#ff444418', LIFR: '#ff44ff18' };
        const cat = d.flight_category || '?';
        const catColor = catColors[cat] || '#aaa';
        const catBgColor = catBg[cat] || 'transparent';

        // Wind string
        let windStr = '';
        if (d.wind_variable) {
            windStr = `VRB @ ${d.wind_speed || 0}`;
            if (d.wind_gust) windStr += `G${d.wind_gust}`;
            windStr += ' kt';
        } else if (d.wind_dir != null) {
            windStr = `${String(d.wind_dir).padStart(3, '0')}° @ ${d.wind_speed || 0}`;
            if (d.wind_gust) windStr += `G${d.wind_gust}`;
            windStr += ' kt';
        }

        // Observation time and age
        let timeStr = '';
        let ageStr = '';
        let ageStale = false;
        // Use actual observation time for age — never fall back to fetched_at which
        // would show (0m ago) even for hour-old METARs fetched fresh from the internet.
        const obsTime = d.observed_at;
        if (obsTime) {
            const dt = new Date(obsTime);
            const day = dt.getUTCDate();
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const mon = months[dt.getUTCMonth()];
            const hh = String(dt.getUTCHours()).padStart(2, '0');
            const mm = String(dt.getUTCMinutes()).padStart(2, '0');
            timeStr = `${day} ${mon} ${hh}:${mm}Z`;

            const ageMin = Math.round((Date.now() - dt.getTime()) / 60000);
            if (ageMin < 60) ageStr = `(${ageMin}m ago)`;
            else ageStr = `(${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago)`;
            ageStale = ageMin > 75; // FAA METAR cycle is 60min; flag at 75min
        } else if (metar.fetched_at) {
            // No observation time — show fetch time but label it clearly
            timeStr = 'fetched ' + new Date(metar.fetched_at).toUTCString().slice(17, 22) + 'Z';
            ageStr = '';
        }

        // Temp / dewpoint / visibility / altimeter (field names differ by source — use fallbacks)
        const tempC  = d.temp_c ?? d.temperature_c ?? d.temperature ?? null;
        const dewC   = d.dewpoint_c ?? d.dewpoint ?? null;
        const visSm  = d.visibility_sm ?? d.visibility ?? null;
        const visPlus = d.visibility_plus ?? false;
        const altim  = d.altimeter ?? null;

        // Sky conditions — parse from raw (strip remarks first)
        const rawNoRmk = raw.replace(/\bRMK\b.*$/i, '').trim();
        const skyLayers = [];
        const skyRe = /\b(CLR|SKC|NSC|CAVOK|FEW|SCT|BKN|OVC|VV)(\d{3})?(CB|TCU)?\b/g;
        let skyMatch;
        let ceilingFound = false;
        while ((skyMatch = skyRe.exec(rawNoRmk)) !== null) {
            const cover = skyMatch[1];
            const altFt = skyMatch[2] ? parseInt(skyMatch[2], 10) * 100 : null;
            const mod   = skyMatch[3] || '';
            if (['CLR','SKC','NSC','CAVOK'].includes(cover)) {
                skyLayers.push({ cover, altFt: null, mod, isCeiling: false });
                break;
            }
            if (altFt == null) continue;
            const isCeiling = (cover === 'BKN' || cover === 'OVC' || cover === 'VV') && !ceilingFound;
            if (isCeiling) ceilingFound = true;
            skyLayers.push({ cover, altFt, mod, isCeiling });
        }

        // Sky row HTML
        let skyRowHtml = '';
        if (skyLayers.length) {
            if (skyLayers[0].altFt === null) {
                const lbl = skyLayers[0].cover === 'CAVOK' ? 'CAVOK' : 'CLEAR';
                skyRowHtml = `<div class="wx-row"><div class="wx-row-lbl">SKY</div><div class="wx-row-val">${lbl}</div></div>`;
            } else {
                const items = skyLayers.map(g => {
                    const altStr = g.altFt.toLocaleString() + ' ft';
                    const modStr = g.mod ? ` ${g.mod}` : '';
                    const ceil   = g.isCeiling ? ' <span class="wx-ceil-badge">CEIL</span>' : '';
                    return `<div class="wx-sky-item"><span class="wx-sky-cover">${g.cover}${modStr}</span><span class="wx-sky-alt">${altStr}</span>${ceil}</div>`;
                }).join('');
                skyRowHtml = `<div class="wx-row"><div class="wx-row-lbl">SKY</div><div class="wx-sky-stack">${items}</div></div>`;
            }
        }

        // Thunderstorm plain-language row — parses raw text so it works for all METAR sources
        const tstmLines = typeof FisbClient !== 'undefined' ? FisbClient.formatThunderstormActivity(raw) : [];
        const tstmRowHtml = tstmLines.length
            ? `<div class="wx-row"><div class="wx-row-lbl">TSTM</div><div class="wx-sky-stack">${
                tstmLines.map(l => `<div class="wx-tstm-line">${l}</div>`).join('')
            }</div></div>`
            : '';

        // Weather phenomena — parse from raw text (TS, RA, SN, FZRA, FG, etc.)
        const wxPhenomena = [];
        const wxGroupMatch = rawNoRmk.match(/\b([-+]?(VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)*(RA|DZ|SN|SG|IC|PL|GR|GS|UP|FG|BR|SA|DU|HZ|VA|PO|SQ|FC|SS|DS)+)\b/g);
        if (wxGroupMatch) {
            for (const code of wxGroupMatch) {
                const isTs  = /TS/.test(code);
                const isFz  = /FZ/.test(code);
                const isSev = /^\+/.test(code);
                const color = isTs ? 'var(--status-danger)' : isFz ? '#0099cc' : isSev ? 'var(--status-warning)' : 'var(--text-secondary)';
                wxPhenomena.push({ code, color });
            }
        }
        const phenomenaHtml = wxPhenomena.length
            ? `<div class="wx-phenomena">${wxPhenomena.map(p =>
                `<span class="wx-phenom" style="color:${p.color}">${p.code}</span>`).join('')}</div>`
            : '';

        // Labeled data rows
        const visRow = visSm != null
            ? `<div class="wx-row"><div class="wx-row-lbl">VIS</div><div class="wx-row-val">${visPlus ? '&gt;' : ''}${visSm} SM</div></div>`
            : '';
        const tdRow = tempC != null
            ? (() => {
                const tF = Math.round(tempC * 9 / 5 + 32);
                const dF = dewC != null ? Math.round(dewC * 9 / 5 + 32) : null;
                const f = `${tF}&deg; / ${dF != null ? dF : '&mdash;'}&deg;F`;
                return `<div class="wx-row"><div class="wx-row-lbl">T / DP</div><div class="wx-row-val">${f}</div></div>`;
            })()
            : '';
        const altRow = altim != null
            ? `<div class="wx-row"><div class="wx-row-lbl">ALT</div><div class="wx-row-val">${altim.toFixed(2)}&quot;</div></div>`
            : '';

        // Source label
        const source = wx.source === 'fisb' ? 'FIS-B' : wx.source === 'internet' ? 'INTERNET' : 'PLAN';

        // SPECI highlight
        const isSpeci = raw.startsWith('SPECI') || wx.is_speci;
        const speciClass = isSpeci ? ' wx-speci' : '';

        const tafHtml = wx.taf?.raw
            ? `<div class="popup-section-title" style="margin-top:10px">TAF</div><div class="wx-metar wx-taf">${this._formatTaf(wx.taf.raw)}</div>`
            : '';

        const windRow = windStr
            ? `<div class="wx-row"><div class="wx-row-lbl">WIND</div><div class="wx-row-val">${windStr}</div></div>`
            : '';

        return `<div class="popup-section popup-wx-section${speciClass}">
            <div class="wx-card-hdr" style="background:${catBgColor};border-left:4px solid ${catColor}">
                <span class="wx-cat-dot" style="color:${catColor}">&#9679;</span>
                <span class="wx-cat-name" style="color:${catColor}">${cat}</span>
                <div class="wx-hdr-right">
                    <span class="wx-source">${source}</span>
                    ${isSpeci ? '<span class="wx-speci-badge">SPECI</span>' : ''}
                </div>
            </div>
            <div class="wx-rows">
                ${windRow}
                ${skyRowHtml}
                ${tstmRowHtml}
                ${visRow}
                ${tdRow}
                ${altRow}
            </div>
            ${phenomenaHtml}
            <div class="wx-time">
                <span>${timeStr}</span>
                ${ageStr ? `<span class="wx-age${ageStale ? ' wx-age-stale' : ''}">${ageStr}${ageStale ? ' ⚠ STALE' : ''}</span>` : ''}
            </div>
            <div class="wx-metar"><span class="wx-metar-label">RAW</span>${raw}</div>
            ${tafHtml}
        </div>`;
    }

    _bestRunwayHtml(runways, wx) {
        const metar = wx?.metar;
        if (!metar?.decoded) return '';
        const d = metar.decoded;
        if (d.wind_variable || d.wind_dir == null || !d.wind_speed) return '';

        const windDir = d.wind_dir; // degrees true
        const windSpd = d.wind_speed;
        const gustSpd = d.wind_gust || windSpd;

        // Parse each runway end and compute wind components
        const ends = [];
        for (const rwy of runways) {
            // Runway ID like "08L/26R" or "08/26" or just "08L"
            const parts = (rwy.id || '').split('/');
            for (const part of parts) {
                const match = part.trim().match(/^(\d{1,2})(L|R|C)?$/i);
                if (!match) continue;
                const hdg = parseInt(match[1]) * 10; // "08" → 80°
                const suffix = (match[2] || '').toUpperCase();
                const label = String(match[1]).padStart(2, '0') + suffix;

                // Headwind = wind_speed * cos(wind_dir - runway_hdg)
                const diff = (windDir - hdg) * Math.PI / 180;
                const headwind = Math.round(windSpd * Math.cos(diff));
                const crosswind = Math.abs(Math.round(windSpd * Math.sin(diff)));
                const gustXwind = Math.abs(Math.round(gustSpd * Math.sin(diff)));

                ends.push({ label, hdg, headwind, crosswind, gustXwind, length: rwy.length_ft });
            }
        }

        if (ends.length === 0) return '';

        // Sort by headwind (most positive = best)
        ends.sort((a, b) => b.headwind - a.headwind);
        const best = ends[0];

        const rows = ends.slice(0, 4).map(e => {
            const isBest = e === best;
            const hwLabel = e.headwind >= 0 ? `${e.headwind} HW` : `${Math.abs(e.headwind)} TW`;
            const xwLabel = `${e.crosswind} XW`;
            const cls = isBest ? 'best-rwy' : '';
            return `<tr class="${cls}">
                <td>RWY ${e.label}</td>
                <td>${hwLabel}</td>
                <td>${xwLabel}</td>
            </tr>`;
        }).join('');

        return `<div class="popup-section popup-rwy-wind-section">
            <div class="popup-section-title">BEST RUNWAY</div>
            <table class="popup-rwy-wind-table">${rows}</table>
        </div>`;
    }

    _actionsHtml(apt) {
        return `<div class="popup-actions">
            <button class="popup-btn" data-action="plates">PLATES</button>
            <button class="popup-btn" data-action="direct-to">D→</button>
            <button class="btn-close popup-btn popup-close-btn" data-action="close">✕</button>
        </div>`;
    }

    // ========== Action Binding ==========

    _bindActions(airport) {
        const container = this._popup.getElement();
        if (!container) return;

        // Frequency tap → show large for 3 seconds
        container.querySelectorAll('.freq-row').forEach(row => {
            wireTap(row, () => this._flashFrequency(row.dataset.freq));
        });

        // Phone tap → copy (IFR CD phone and airport manager phone)
        container.querySelectorAll('.ifr-phone, .airport-phone').forEach(phoneEl => {
            wireTap(phoneEl, () => {
                const phone = phoneEl.dataset.phone;
                navigator.clipboard?.writeText(phone);
                phoneEl.style.background = '#224433';
                setTimeout(() => phoneEl.style.background = '', 1000);
            });
        });

        // Action buttons
        container.querySelectorAll('.popup-btn').forEach(btn => {
            const action = btn.dataset.action;
            wireTap(btn, () => {
                if (action === 'plates' && this._approachCharts) {
                    this._approachCharts.showForAirport(airport.icao);
                    this.close();
                }
                if (action === 'direct-to' && this._onDirectTo) {
                    this._onDirectTo(airport);
                    this.close();
                }
                if (action === 'craft' && this._ifrClearance) {
                    this._ifrClearance.show(null, airport, window.app?.stratuxClient?.situation);
                    this.close();
                }
                if (action === 'close') {
                    this.close();
                }
            });
        });
    }

    /** Format TAF raw text: insert a line break before each FM group */
    _formatTaf(raw) {
        return (raw || '').replace(/ (FM\d{6})/g, '<br>$1');
    }

    _flashFrequency(freq) {
        // Show frequency large on screen for 3 seconds
        let flash = document.getElementById('freq-flash');
        if (!flash) {
            flash = document.createElement('div');
            flash.id = 'freq-flash';
            flash.style.cssText = `
                position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
                font-size:48px; font-weight:bold; color:#00ffcc; background:#000c;
                padding:20px 40px; border-radius:12px; z-index:10000;
                pointer-events:none; transition:opacity 0.3s;
            `;
            document.body.appendChild(flash);
        }
        flash.textContent = freq;
        flash.style.opacity = '1';
        setTimeout(() => { flash.style.opacity = '0'; }, 3000);
    }
}
