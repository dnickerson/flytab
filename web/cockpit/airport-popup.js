/**
 * FlyPi — Airport Info Panel (v5)
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
            this._wireButton(closeBtn, () => this.close());
        }

        // Wire action chips
        this._panel.querySelectorAll('.apt-chip[data-action]').forEach(chip => {
            const action = chip.dataset.action;
            this._wireButton(chip, () => {
                if (action === 'direct-to' && this._onDirectTo) {
                    this._onDirectTo(airport);
                    this.close();
                } else if (action === 'plates' && this._approachCharts) {
                    this._approachCharts.showForAirport(airport.icao);
                    this.close();
                } else if (action === 'add-route' && typeof app !== 'undefined' && app.routeEditor) {
                    app.routeEditor._addWaypoint({ icao: airport.icao, name: airport.name, lat: airport.lat, lon: airport.lon, type: 'APT' });
                    app.routeEditor._applyRoute();
                    this.close();
                } else if (action === 'craft' && this._ifrClearance) {
                    this._ifrClearance.show(null, airport);
                    this.close();
                }
            });
        });

        // Wire frequency rows
        this._panel.querySelectorAll('.freq-row[data-freq]').forEach(row => {
            this._wireButton(row, () => this._flashFrequency(row.dataset.freq));
        });

        // Wire phone rows
        this._panel.querySelectorAll('.ifr-phone, .airport-phone').forEach(phoneEl => {
            this._wireButton(phoneEl, () => {
                const phone = phoneEl.dataset.phone;
                navigator.clipboard?.writeText(phone);
                phoneEl.style.background = '#224433';
                setTimeout(() => phoneEl.style.background = '', 1000);
            });
        });

        // Wire tabs
        this._panel.querySelectorAll('.apt-tab[data-tab]').forEach(tab => {
            this._wireButton(tab, () => {
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

                // Lazy-load plate panes on first activation
                if (tab.dataset.tab === 'diag' || tab.dataset.tab === 'aptinfo') {
                    const platePaneEl = pane?.querySelector('.apt-plate-pane');
                    if (platePaneEl && !platePaneEl.dataset.loaded) {
                        platePaneEl.dataset.loaded = '1';
                        this._loadPlatePaneForType(platePaneEl, airport.icao, platePaneEl.dataset.plateType);
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
            this._wireButton(btn, async () => {
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

        this._wireButton(closeBtn, () => this.close());

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
                        this._wireButton(row, () => this.showForAirport(row.dataset.icao));
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

        return `
        <div class="apt-panel-header">
            <div>
                <div class="apt-panel-icao">${apt.icao}${catBadge}</div>
                <div class="apt-panel-name">${apt.name || ''}</div>
                <div class="apt-panel-meta">${apt.city || ''}${apt.state ? ', ' + apt.state : ''} · ${towerStr} · ${elevStr}${tpaStr}</div>
            </div>
            <button class="apt-panel-close" aria-label="Close">✕</button>
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
            <button class="apt-tab" data-tab="appr">APPR</button>
            <button class="apt-tab" data-tab="diag">DIAG</button>
            <button class="apt-tab" data-tab="aptinfo">A/FD</button>
        </div>

        <div class="apt-tab-content">
            <div class="apt-tab-pane active" data-pane="info">
                ${this._aptFactsHtml(apt)}
                ${this._frequenciesHtml(apt.frequencies || [], apt.tower)}
                ${(CockpitConfig.get('ifr.showCdPhone') || CockpitConfig.get('ifr.showCraft')) ? this._ifrHtml(apt) : ''}
            </div>
            <div class="apt-tab-pane" data-pane="wx">
                ${wx ? this._weatherHtml(wx) : '<div style="padding:16px;color:var(--text-muted)">No weather data</div>'}
                ${wx && apt.runways?.length ? this._bestRunwayHtml(apt.runways, wx) : ''}
            </div>
            <div class="apt-tab-pane" data-pane="rwy">
                ${apt.runways?.length ? this._runwaysHtml(apt.runways) : '<div style="padding:16px;color:var(--text-muted)">No runway data</div>'}
            </div>
            <div class="apt-tab-pane" data-pane="appr"></div>
            <div class="apt-tab-pane" data-pane="diag">
                <div class="apt-plate-pane" data-plate-type="APD"></div>
            </div>
            <div class="apt-tab-pane" data-pane="aptinfo">
                <div class="apt-plate-pane" data-plate-type="MIN"></div>
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
        if (this._fisbClient && this._onFisbMetar) {
            this._fisbClient.removeEventListener('fisb:metar', this._onFisbMetar);
            this._onFisbMetar = null;
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
                <button class="apt-panel-close">&#x2715;</button>
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
        if (closeBtn) this._wireButton(closeBtn, () => this.close());
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
                <button class="btn-close popup-btn popup-close-btn" data-action="close">CLOSE</button>
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
                this._wireButton(row, () => this._flashFrequency(row.dataset.freq));
            });
            container.querySelectorAll('.popup-btn').forEach(btn => {
                const action = btn.dataset.action;
                this._wireButton(btn, () => {
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

        // Runways
        if (apt.runways && apt.runways.length) {
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

        // Weather + best runway
        if (wx) {
            sections.push(this._weatherHtml(wx));
            if (apt.runways?.length) {
                sections.push(this._bestRunwayHtml(apt.runways, wx));
            }
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
    async _loadPlatePaneForType(containerEl, icao, plateType) {
        containerEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px">Loading…</div>';

        try {
            // Try to get plates from approach charts module index
            let plate = null;
            if (this._approachCharts?._plateIndex) {
                const entry = this._approachCharts._plateIndex[icao];
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
                    : 'Download plates via Pre-Flight Refresh to enable this tab.';
                containerEl.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:13px">
                    No ${typeLabel} available for ${icao}.<br>
                    <span style="font-size:11px;color:var(--text-dim)">${hint}</span>
                </div>`;
                return;
            }

            const PLATES_BASE = 'http://localhost:9090/plates';
            const file = plate.filename || plate.pdf_name;
            const icaoDir = icao.toUpperCase();

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
        if (apt.tpa_ft)          facts.push({ label: 'TPA',  value: `${apt.tpa_ft} ft MSL` });
        if (apt.fuel)            facts.push({ label: 'FUEL', value: apt.fuel });
        if (!facts.length) return '';
        const cells = facts.map(f =>
            `<div class="apt-fact"><div class="apt-fact-label">${f.label}</div><div class="apt-fact-value">${f.value}</div></div>`
        ).join('');
        return `<div class="popup-section apt-facts-row">${cells}</div>`;
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
        const cat = d.flight_category || '?';
        const catColor = catColors[cat] || '#aaa';

        // Wind string
        let windStr = '';
        if (d.wind_dir != null) {
            windStr = `${String(d.wind_dir).padStart(3, '0')}° @ ${d.wind_speed || 0}`;
            if (d.wind_gust) windStr += `G${d.wind_gust}`;
            windStr += ' kt';
        }

        // Observation time and age
        let timeStr = '';
        let ageStr = '';
        const obsTime = d.observed_at || metar.fetched_at;
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
        }

        // Source label
        const source = wx.source === 'fisb' ? 'FIS-B' : wx.source === 'internet' ? 'INTERNET' : 'PLAN';

        // SPECI highlight
        const isSpeci = raw.startsWith('SPECI') || wx.is_speci;
        const speciClass = isSpeci ? ' wx-speci' : '';

        const tafHtml = wx.taf?.raw
            ? `<div class="popup-section-title" style="margin-top:10px">TAF</div><div class="wx-metar wx-taf">${this._formatTaf(wx.taf.raw)}</div>`
            : '';

        return `<div class="popup-section popup-wx-section${speciClass}">
            <div class="popup-section-title">WEATHER <span class="wx-source">${source}</span>${isSpeci ? ' <span class="wx-speci-badge">SPECI</span>' : ''}</div>
            <div>
                <span class="wx-cat" style="color:${catColor}">\u25CF ${cat}</span>
                <span class="wx-wind">${windStr}</span>
            </div>
            <div class="wx-time">${timeStr} <span class="wx-age">${ageStr}</span></div>
            <div class="wx-metar">${raw}</div>
            ${tafHtml}
        </div>`;
    }

    _bestRunwayHtml(runways, wx) {
        const metar = wx?.metar;
        if (!metar?.decoded) return '';
        const d = metar.decoded;
        if (d.wind_dir == null || !d.wind_speed) return '';

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
            <button class="popup-btn popup-close-btn" data-action="close">CLOSE</button>
        </div>`;
    }

    // ========== Action Binding ==========

    /**
     * Wire a button with click + touchstart for iPad/Leaflet reliability.
     * touchend is blocked by Leaflet's drag handler (preventDefault on touchstart
     * cancels the touch sequence before touchend fires). touchstart fires first.
     */
    _wireButton(el, action) {
        let touchFired = false;
        const fire = (e) => {
            e.stopPropagation();
            action();
        };
        el.addEventListener('touchstart', (e) => {
            e.preventDefault();
            touchFired = true;
            fire(e);
        }, { passive: false });
        el.addEventListener('click', (e) => {
            if (touchFired) { touchFired = false; return; }
            fire(e);
        });
    }

    _bindActions(airport) {
        const container = this._popup.getElement();
        if (!container) return;

        // Frequency tap → show large for 3 seconds
        container.querySelectorAll('.freq-row').forEach(row => {
            this._wireButton(row, () => this._flashFrequency(row.dataset.freq));
        });

        // Phone tap → copy (IFR CD phone and airport manager phone)
        container.querySelectorAll('.ifr-phone, .airport-phone').forEach(phoneEl => {
            this._wireButton(phoneEl, () => {
                const phone = phoneEl.dataset.phone;
                navigator.clipboard?.writeText(phone);
                phoneEl.style.background = '#224433';
                setTimeout(() => phoneEl.style.background = '', 1000);
            });
        });

        // Action buttons
        container.querySelectorAll('.popup-btn').forEach(btn => {
            const action = btn.dataset.action;
            this._wireButton(btn, () => {
                if (action === 'plates' && this._approachCharts) {
                    this._approachCharts.showForAirport(airport.icao);
                    this.close();
                }
                if (action === 'direct-to' && this._onDirectTo) {
                    this._onDirectTo(airport);
                    this.close();
                }
                if (action === 'craft' && this._ifrClearance) {
                    this._ifrClearance.show(null, airport);
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
