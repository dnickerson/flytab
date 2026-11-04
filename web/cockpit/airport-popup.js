/**
 * FlyTab — Airport Info Panel (v5)
 * Shows airport details in a right-side sliding panel with Info/Weather/Runway/Approach tabs.
 * Replaces the Leaflet popup for airports. Navaid popup remains as a small Leaflet popup.
 */

class AirportPopup {
    /** Text for HTML: FIS-B (unauthenticated radio) and internet weather / runway text. */
    static _esc(v) {
        return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    constructor(map, nasrDb) {
        this._map = map;
        this._nasr = nasrDb;
        this._popup = null;
        this._panel = null;
        this._panelOpen = false;
        this._ifrClearance = null;
        this._approachCharts = null;
        this._windCompass = null;
        this._onDirectTo = null;
        this._fisbClient = null;
        this._vectorLayers = null;
        this._currentIcao = null;
        this._onFisbMetar = null;
        this._onInternetMetarBound = null;
        this._getRouteAirports = null;  // callback: () => { departure, destination }
        this._glide = null;             // GlidePanel: live engine-out glide block (glide-panel.js)
        this._glideHost = null;         // the element the glide block renders into (right under the header)
        this._notes = null;             // AirportNoteEditor: the MY NOTES box at the bottom of INFO (airport-notes.js)
        this._notesScrollTimer = null;  // second "bring the notes into view" after the on-screen keyboard opens
        this._notesVv = null;           // visualViewport resize listener of the notes box (keyboard closed without blur)
    }

    /**
     * ENGINE OUT button (airport panel header): whether the engine-out glide block is shown.
     * One choice for every airport, kept across restarts in localStorage; ON unless the pilot turned it
     * off. The choice made in this session (_glideOnMem) wins over storage, so it holds even when
     * storage can't be read or written.
     */
    static GLIDE_PREF_KEY = 'flytab_engine_out_glide_on';
    static _glideOnMem = null;

    static glideOn() {
        // This session's choice first: a write that failed must not let an older stored value win.
        if (AirportPopup._glideOnMem !== null) return AirportPopup._glideOnMem;
        try {
            const v = localStorage.getItem(AirportPopup.GLIDE_PREF_KEY);
            if (v === 'false') return false;
            if (v === 'true') return true;
        } catch (_) { /* storage blocked: the default */ }
        return true;
    }

    static setGlideOn(on) {
        AirportPopup._glideOnMem = !!on;
        try { localStorage.setItem(AirportPopup.GLIDE_PREF_KEY, on ? 'true' : 'false'); } catch (_) { /* session only */ }
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
        this._stopNetworkListener();
        this._currentIcao = airport.icao;
        this._inetTafTried = false;

        // Look up cached weather — prefer FIS-B over plan data
        let wx = null;
        let cachedTaf = null, cachedTafAt = null;
        try {
            const cached = await this._nasr.getWeather(airport.icao);
            if (cached?.metar) wx = cached;
            cachedTaf = cached?.taf?.raw || null;     // a cached TAF counts even without a cached METAR
            cachedTafAt = cached?.taf?.fetched_at || cached?.fetched_at || null;
        } catch (_) {}

        // Internet METARs (pre-flight, online) — better than plan cache
        if (this._vectorLayers) {
            const im = this._vectorLayers._internetMetars?.get(airport.icao);
            if (im) {
                wx = {
                    metar: { raw: im.raw, decoded: im.decoded, fetched_at: new Date(im.received_at).toISOString() },
                    source: 'internet',
                    fetched_at: new Date(im.received_at).toISOString(),
                };
            }
        }

        if (this._fisbClient) {
            const fisbMetar = this._fisbClient.getMetar(airport.icao);
            if (fisbMetar) {
                wx = {
                    metar: { raw: fisbMetar.raw, decoded: fisbMetar.decoded, fetched_at: new Date(fisbMetar.received_at).toISOString() },
                    source: 'fisb',
                    fetched_at: new Date(fisbMetar.received_at).toISOString(),
                };
            }
        }

        // TAF: chosen on its own, whatever the METAR source. FIS-B first so it wins a tie with the cache;
        // the internet TAF (_fetchInternetTaf) replaces it later only if it was issued later (_tafNewer).
        // Reset after the await: a second show() that started meanwhile must not inherit this one's TAF.
        this._taf = null;
        const fisbTaf = this._fisbClient?.getTaf(airport.icao);
        this._offerTaf(fisbTaf?.raw, 'fisb', fisbTaf?.received_at ?? null);
        this._offerTaf(cachedTaf, 'cache', cachedTafAt);
        if (this._taf) {
            wx = wx ? { ...wx, taf: { raw: this._taf.raw } } : { metar: null, taf: { raw: this._taf.raw }, source: this._taf.src };
        } else if (wx) {
            wx = { ...wx, taf: null };
        }

        // Use sliding panel if available, else fall back to Leaflet popup
        if (this._panel) {
            this._showPanel(airport, wx);
        } else {
            this._showLeafletPopup(airport, wx);
        }

        this._startFisbListener(airport);
        this._startInternetMetarListener(airport);
        // Internet TAF on each open while the app may be online: on the ground it fills a missing TAF (or a
        // newer one replaces FIS-B's). Never in flight / offline (AirportPopup._mayFetchInternet).
        if (AirportPopup._mayFetchInternet()) this._fetchInternetTaf(airport.icao);
        // Opened offline (in flight, or before NetworkMode's first probe): ask once the app is online.
        this._startNetworkListener(airport);
    }

    /**
     * While the panel is open: when NetworkMode ('mode:changed', detail.mode) says the app may be online
     * and no internet TAF was asked for this airport yet, ask once. Removed by show() and close().
     */
    _startNetworkListener(airport) {
        const nm = (typeof window !== 'undefined') ? window.app?.networkMode : null;
        if (!nm || typeof nm.addEventListener !== 'function') return;
        const icao = airport.icao;
        this._onNetworkMode = (e) => {
            const mode = e?.detail?.mode;
            if (mode === 'flight' || mode === 'offline') return;
            if (this._inetTafTried || this._currentIcao !== icao) return;
            this._fetchInternetTaf(icao);
        };
        this._networkModeTarget = nm;
        nm.addEventListener('mode:changed', this._onNetworkMode);
    }

    _stopNetworkListener() {
        if (this._networkModeTarget && this._onNetworkMode) {
            try { this._networkModeTarget.removeEventListener('mode:changed', this._onNetworkMode); } catch (_) { /* gone */ }
        }
        this._networkModeTarget = null;
        this._onNetworkMode = null;
    }

    /**
     * Whether an internet request may be made now, from the app's NetworkMode (web/shared/network-mode.js,
     * re-probed every 15 s): not in 'flight' (Stratux reachable - its WiFi has no internet) or 'offline'.
     * The same rule as the FAA TFR download (app.js canFetch). navigator.onLine is not used: the WebView
     * reports false on Stratux WiFi and true on networks without internet. Mode unknown (no app / no
     * NetworkMode yet): allowed - the ground case; a failed request is silent.
     */
    static _mayFetchInternet() {
        const mode = (typeof window !== 'undefined') ? window.app?.networkMode?.mode : null;
        return mode !== 'flight' && mode !== 'offline';
    }

    /**
     * Offer a TAF for the open airport (raw text; src 'fisb' | 'cache' | 'internet'; fetchedAt: when it
     * was fetched, ISO or ms, for the 30 h fallback). Never taken when expired (_tafExpired); otherwise
     * taken when there is none yet or it is newer than the one shown (_tafNewer). Returns true when taken.
     */
    _offerTaf(raw, src, fetchedAt = null) {
        const text = typeof raw === 'string' ? raw.trim() : '';
        if (!text) return false;
        if (AirportPopup._tafExpired(text, Date.now(), fetchedAt)) return false;
        const cand = { raw: text, src, issued: AirportPopup._tafIssuedMs(text) };
        if (!AirportPopup._tafNewer(cand, this._taf || null)) return false;
        this._taf = cand;
        return true;
    }

    /**
     * Which TAF is newer: by ISSUE time, the report's DDHHMMZ group ("TAF KCLT 041535Z ..." from AWC,
     * "KCLT 041535Z ..." / "TAF AMD KCLT 041850Z ..." from FIS-B), not by when FlyTab got it - FIS-B
     * re-broadcasts the same TAF every few minutes and an internet fetch is always "now", so receive times
     * would just favour whichever arrived last. Same text, or the same issue time: keep the one shown.
     * A dated TAF beats an undated one; two undated ones: the later offer.
     */
    static _tafNewer(cand, cur) {
        if (!cur) return true;
        if (cand.raw === cur.raw) return false;
        if (cand.issued != null && cur.issued != null) return cand.issued > cur.issued;
        if (cand.issued != null) return true;
        if (cur.issued != null) return false;
        return true;
    }

    /**
     * Issue time (ms UTC) of a TAF from its first DDHHMMZ group, or null. The month is the latest one
     * that puts that time no more than 12 h after now (so "312340Z" read on the 1st is last month's 31st).
     */
    static _tafIssuedMs(raw, now = Date.now()) {
        const m = /(?:^|\s)(\d{2})(\d{2})(\d{2})Z(?=\s|$)/.exec(String(raw || ''));
        if (!m) return null;
        const dd = +m[1], hh = +m[2], mi = +m[3];
        if (dd < 1 || dd > 31 || hh > 23 || mi > 59) return null;
        const n = new Date(now);
        for (let back = 0; back <= 1; back++) {
            const t = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - back, dd, hh, mi);
            if (new Date(t).getUTCDate() !== dd) continue;      // no such day in that month (31 Nov)
            if (t <= now + 12 * 3600000) return t;
        }
        return null;
    }

    /**
     * End (ms UTC) of a TAF's validity: the first DDHH/DDHH group after its issue time (DDHHMMZ), the
     * start on or after the issue time (less 3 h), the end after the start - each in that month or the
     * next (3012/0112 ends on the 1st of the next month; hour 24 is midnight: 0318/0324 ends 04 0000Z).
     * Null when there is no issue time or validity group, or the period is not 1-36 h long.
     */
    static _tafValidEndMs(raw, now = Date.now()) {
        const s = String(raw || '');
        const im = /(?:^|\s)(\d{2})(\d{2})(\d{2})Z(?=\s|$)/.exec(s);
        if (!im) return null;
        const issued = AirportPopup._tafIssuedMs(s, now);
        if (issued == null) return null;
        const vm = /(?:^|\s)(\d{2})(\d{2})\/(\d{2})(\d{2})(?=\s|$)/.exec(s.slice(im.index + im[0].length));
        if (!vm) return null;
        const d1 = +vm[1], h1 = +vm[2], d2 = +vm[3], h2 = +vm[4];
        if (d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31 || h1 > 24 || h2 > 24) return null;
        // The first day-of-month dd, hour hh (24 = next midnight) at or after `from`, this month or the next.
        const onOrAfter = (from, dd, hh) => {
            const f = new Date(from);
            for (let k = 0; k <= 1; k++) {
                const day = Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + k, dd);
                if (new Date(day).getUTCDate() !== dd) continue;        // no such day in that month
                const t = day + hh * 3600000;
                if (t >= from) return t;
            }
            return null;
        };
        const start = onOrAfter(issued - 3 * 3600000, d1, h1);
        if (start == null) return null;
        const end = onOrAfter(start + 1, d2, h2);
        if (end == null || end - start > 36 * 3600000) return null;
        return end;
    }

    /**
     * A TAF that must not be shown: its validity has ended (_tafValidEndMs). When the validity can't be
     * read, the weather cache's rule: fetched more than TAF_MAX_AGE_MS ago (no fetchedAt: not expired).
     */
    static _tafExpired(raw, now = Date.now(), fetchedAt = null) {
        const end = AirportPopup._tafValidEndMs(raw, now);
        if (end != null) return end <= now;
        const at = typeof fetchedAt === 'number' ? fetchedAt : (fetchedAt ? Date.parse(fetchedAt) : NaN);
        return Number.isFinite(at) && now - at > AirportPopup.TAF_MAX_AGE_MS;
    }

    /** The open panel's WX tab shows this TAF: replaces the shown one, or adds a TAF section (METAR or not). */
    _putTafInPane(raw) {
        if (!this._panel || !this._panelOpen) return;
        const pane = this._panel.querySelector('.apt-tab-pane[data-pane="wx"]');
        if (!pane) return;
        const tafEl = pane.querySelector('.wx-taf');
        if (tafEl) { tafEl.innerHTML = this._formatTaf(raw); return; }
        const section = pane.querySelector('.popup-wx-section');
        if (section) { section.insertAdjacentHTML('beforeend', this._tafHtml(raw)); return; }
        const metars = pane.querySelectorAll('.wx-metar');
        if (metars.length) { metars[metars.length - 1].insertAdjacentHTML('afterend', this._tafHtml(raw)); return; }
        pane.innerHTML = this._wxPaneHtml({ metar: null, taf: { raw } });   // "No weather data" -> a TAF-only section
    }

    _showPanel(airport, wx) {
        if (!this._panel) return;
        this._stopGlide();
        this._closeNotes();

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
        // TFR row: a tap shows / hides its NOTAM text
        this._panel.querySelectorAll('button.apt-tfr[data-tfr]').forEach(btn => {
            wireTap(btn, () => {
                const box = [...this._panel.querySelectorAll('.apt-tfr-text')].find(d => d.dataset.tfr === btn.dataset.tfr);
                if (!box) return;
                box.hidden = !box.hidden;
                const arrow = btn.querySelector('.apt-tfr-arrow');
                if (arrow) arrow.textContent = box.hidden ? '▸' : '▾';
                btn.setAttribute('aria-expanded', String(!box.hidden));
            });
        });

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

        // Render the Wind tab. Fresh WindCompass instance every _showPanel
        // call (same as the rest of this panel's content) so a manual wind
        // override never survives into a later airport or a later open of
        // the same one -- it always starts back on live METAR.
        // Guarded: a throw here would skip the tab wiring below and leave
        // every tab of an otherwise-open popup dead.
        this._windCompass = null;
        const windPaneEl = this._panel.querySelector('.apt-wind-pane');
        if (windPaneEl && typeof WindCompass !== 'undefined') {
            try {
                this._windCompass = new WindCompass();
                this._windCompass.render(windPaneEl, (airport.runways || []).filter(Boolean), wx,
                    { lat: airport.lat, lon: airport.lon });
            } catch (err) {
                console.warn('AirportPopup: wind compass render failed', err);
                this._windCompass = null;
                windPaneEl.innerHTML = '<div class="wc-no-runways">Wind view unavailable</div>';
            }
        }

        // Wire tabs
        this._panel.querySelectorAll('.apt-tab[data-tab]').forEach(tab => {
            wireTap(tab, () => {
                // Any tab tap (leaving INFO, where the notes are, or re-tapping it) saves a pending note edit now.
                this._notes?.flush();
                this._scrollTabIntoView(tab);
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
                        this._loadAfdPane(afdPaneEl, airport.icao, airport.state);
                    }
                }
            });
        });

        // MY NOTES box at the bottom of INFO. Guarded: a notes error must never stop the airport panel from opening.
        try {
            this._openNotes(airport);
        } catch (err) {
            console.warn('AirportPopup: notes failed', err);
            this._notes = null;
        }

        // FAA REMARKS above MY NOTES, read from IndexedDB after the panel is up (show() and
        // showForAirport() both come here). Guarded like the notes.
        try {
            this._loadFaaRemarks(airport);
        } catch (err) {
            console.warn('AirportPopup: FAA remarks failed', err);
        }

        // ENGINE OUT button under the close button: turns the glide block (and its map line) on / off
        // for every airport. It works for an airport that can never have a block too (heliport, no
        // elevation): after the tap the block area says "not available for this airport".
        const glideBtn = this._panel.querySelector('.apt-glide-toggle');
        if (glideBtn) {
            wireTap(glideBtn, () => {
                const on = !AirportPopup.glideOn();
                AirportPopup.setGlideOn(on);
                this._showGlideButton(glideBtn, on);
                if (on) this._startGlide(airport, { showStatus: true }); else this._stopGlide();
            });
        }

        // Engine-out glide block right under the header, when ENGINE OUT is on (remembered): quiet - no
        // status line, the block just appears when there are glide numbers to show.
        if (AirportPopup.glideOn()) this._startGlide(airport);
    }

    /** The ENGINE OUT button's look and state for screen readers. */
    _showGlideButton(btn, on) {
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    /**
     * Mount and start the engine-out glide block right under the header. It shows itself whenever the
     * Stratux WebSocket has a fresh 3D fix (on the ground too) - GlidePanel / GlideInputs decide. Until
     * then, only with showStatus (the pilot just tapped ENGINE OUT on in this panel), GlidePanel shows
     * one status line saying why (no GPS, waiting for a 3D fix, ...); otherwise the host stays hidden.
     * A panel opened with ENGINE OUT already on (remembered) passes no showStatus.
     * Guarded: a glide error must never stop the airport panel from opening.
     */
    _startGlide(airport, { showStatus = false } = {}) {
        this._stopGlide();
        try {
            if (typeof GlidePanel === 'undefined' || !this._panel) return;
            const host = document.createElement('div');
            host.className = 'glide-host';
            const header = this._panel.querySelector('.apt-panel-header');
            if (header) header.after(host); else this._panel.prepend(host);
            this._glideHost = host;
            this._glide = new GlidePanel(host, airport, { showStatus });
            this._glide.start();
        } catch (err) {
            console.warn('AirportPopup: glide block failed', err);
            this._stopGlide();
        }
    }

    /**
     * Fill the MY NOTES box at the bottom of the INFO tab for this airport (AirportNotes /
     * AirportNoteEditor, airport-notes.js). An airport whose ID can't be a file name gets a short
     * "not available" line and no request is made. While the box has focus the panel is one scroll
     * column (class apt-notes-editing) and the notes are scrolled to its top, again once the on-screen
     * keyboard is up; on blur the normal layout comes back with the notes kept in view.
     */
    _openNotes(airport) {
        const pane = this._panel?.querySelector('.apt-notes-pane');
        if (!pane) return;
        const id = (typeof AirportNotes !== 'undefined') ? AirportNotes.normId(airport?.icao) : null;
        if (!id || typeof AirportNoteEditor === 'undefined') {
            pane.innerHTML = '<div class="apt-notes-na">Notes not available for this airport.</div>';
            return;
        }
        // Status line above the box: a "can't be read" message must not end up below the fold.
        pane.innerHTML = '<div class="apt-notes">'
            + '<div class="apt-notes-status" role="status" aria-live="polite"></div>'
            + '<textarea class="apt-notes-text" readonly spellcheck="true" autocapitalize="sentences" placeholder="Your notes for this airport — saved automatically"></textarea>'
            + '</div>';
        const ta = pane.querySelector('.apt-notes-text');
        ta.setAttribute('aria-label', `Notes for ${id}`);
        const section = pane.closest('.apt-my-notes') || pane;
        ta.addEventListener('focus', () => {
            this._enterNotesEditing(section);
            clearTimeout(this._notesScrollTimer);
            this._notesScrollTimer = setTimeout(() => {
                this._notesScrollTimer = null;
                if (document.activeElement === ta) this._scrollNotesIntoView(section, this._panel);
            }, AirportPopup.NOTES_KEYBOARD_MS);
        });
        ta.addEventListener('blur', () => {
            clearTimeout(this._notesScrollTimer);
            this._notesScrollTimer = null;
            this._leaveNotesEditing(section);
        });
        // The keyboard can close without a blur (Android back gesture): when the visual viewport grows
        // back, leave the editing layout (the box keeps its focus); when it shrinks again (the pilot
        // tapped the box: keyboard back), enter it again. Without visualViewport: focus / blur only.
        const vv = (typeof window !== 'undefined') ? window.visualViewport : null;
        if (vv && typeof vv.addEventListener === 'function') {
            const st = { vv, base: 0, shrunk: false, handler: null };
            st.handler = () => {
                try {
                    const h = vv.height;
                    if (!(h > 0)) return;
                    st.base = Math.max(st.base, h);
                    if (document.activeElement !== ta) { st.shrunk = false; return; }
                    if (h < st.base * AirportPopup.KEYBOARD_GONE_FRACTION) {
                        st.shrunk = true;
                        if (!this._panel?.classList.contains('apt-notes-editing')) this._enterNotesEditing(section);
                    } else if (st.shrunk) {
                        st.shrunk = false;
                        this._leaveNotesEditing(section);
                    }
                } catch (_) { /* layout only */ }
            };
            st.base = vv.height > 0 ? vv.height : 0;
            vv.addEventListener('resize', st.handler);
            this._notesVv = st;
        }
        const editor = new AirportNoteEditor(id, ta, pane.querySelector('.apt-notes-status'));
        this._notes = editor;
        editor.load().catch((err) => console.warn('AirportPopup: notes load failed', err));
    }

    // ========== FAA REMARKS (INFO tab, read-only, NASR bundle v12) ==========

    /** Group label per remark category (contract: bundle.remarks [el, c, text, rwy]). Unknown → General. */
    static REMARK_LABELS = {
        gen: 'General', ops: 'Operations', rwy: 'Runway', obst: 'Obstructions', ltg: 'Lighting',
        fuel: 'Fuel', svc: 'Services', contact: 'Contacts', admin: 'FAA admin',
    };
    /** Categories shown behind a tap (with a count), one toggle per category. */
    static REMARK_COLLAPSED = ['contact', 'admin'];

    /**
     * The remark tuples as display groups, in tuple order (the bundle sorts them): consecutive
     * remarks of one category and runway form a group; each collapsed category is one group.
     * A tuple without text is skipped. Returns [{ c, rwy, label, collapsed, texts: [string] }].
     */
    static _remarkGroups(list) {
        const LABELS = AirportPopup.REMARK_LABELS;
        const groups = [];
        for (const t of Array.isArray(list) ? list : []) {
            if (!Array.isArray(t)) continue;
            const text = typeof t[2] === 'string' ? t[2].trim() : '';
            if (!text) continue;
            const c = Object.prototype.hasOwnProperty.call(LABELS, t[1]) ? t[1] : 'gen';
            const collapsed = AirportPopup.REMARK_COLLAPSED.includes(c);
            const rwy = (!collapsed && typeof t[3] === 'string' && t[3].trim()) ? t[3].trim() : null;
            let g = collapsed ? groups.find((x) => x.c === c) : groups[groups.length - 1];
            if (!g || g.c !== c || g.rwy !== rwy) {
                // Runway remarks: "Runway 06". Another category tied to a runway end (an obstruction
                // clearance slope, say) names it too: without it the text often makes no sense.
                const label = c === 'rwy' ? (rwy ? `Runway ${rwy}` : 'Runway')
                    : (rwy ? `${LABELS[c]} · Runway ${rwy}` : LABELS[c]);
                g = { c, rwy, label, collapsed, texts: [] };
                groups.push(g);
            }
            g.texts.push(text);
        }
        return groups;
    }

    /**
     * Read this airport's FAA remarks (NasrDB.getRemarks) and fill the hidden .apt-faa-remarks box.
     * The answer is used only if that same box is still on screen for that airport: another airport,
     * the search panel or a reopen replaces the panel's HTML and the box with it.
     */
    _loadFaaRemarks(airport) {
        const box = this._panel?.querySelector('.apt-faa-remarks');
        const icao = airport?.icao;
        if (!box || !icao || typeof this._nasr?.getRemarks !== 'function') return;
        box.dataset.icao = icao;
        Promise.resolve()
            .then(() => this._nasr.getRemarks(icao))
            .then((list) => {
                if (!box.isConnected || box.dataset.icao !== icao) return;   // the panel moved on
                this._showFaaRemarksWhenNotesIdle(box, list);
            })
            .catch((err) => console.warn('AirportPopup: FAA remarks read failed', err));
    }

    /**
     * Fill the remarks box, but never while the MY NOTES box has focus: the remarks sit above it and
     * would push it (and the caret) down. Then it waits for the notes box's blur, which runs after
     * the notes' own blur handler (that one restores the normal layout and brings the notes into
     * view); the box is then filled with MY NOTES kept where it is on screen.
     */
    _showFaaRemarksWhenNotesIdle(box, list, keepNotesInPlace = false) {
        if (!box.isConnected) return;
        const ta = this._panel?.querySelector('.apt-notes-text');
        if (ta && (document.activeElement === ta || this._panel.classList.contains('apt-notes-editing'))) {
            ta.addEventListener('blur', () => this._showFaaRemarksWhenNotesIdle(box, list, true), { once: true });
            return;
        }
        this._fillFaaRemarks(box, list, keepNotesInPlace);
    }

    /** Remarks shown per group before a "More (n)" row (KADW has 63, KATL ~3,000 px of them). */
    static REMARKS_VISIBLE = 6;

    /**
     * Build the FAA REMARKS section: title, groups with a small label, Contacts and FAA admin behind
     * a tap that shows the count; in any group only the first REMARKS_VISIBLE remarks show, the rest
     * behind a "More (n)" tap. DOM built with textContent only: remark text (some has '<', '&')
     * never goes through innerHTML. Hidden when there is nothing to show. If the box goes in above
     * the visible part of the tab (or keepNotesInPlace: drawn when the notes box lost focus), the tab
     * content is scrolled by what the box grew, so MY NOTES / what the pilot was reading stays put.
     */
    _fillFaaRemarks(box, list, keepNotesInPlace = false) {
        const groups = AirportPopup._remarkGroups(list);
        const scroller = box.closest('.apt-tab-content');
        // Where the box goes in: a hidden box has no layout box (its rect is all 0), so measure the
        // section right after it (MY NOTES), which starts exactly there.
        let anchor = null, anchorTop = 0;
        try {
            const next = box.nextElementSibling;
            const at = box.hidden ? next : box;
            if (scroller && next && at
                    && (keepNotesInPlace || at.getBoundingClientRect().top <= scroller.getBoundingClientRect().top + 1)) {
                anchor = next;
                anchorTop = next.getBoundingClientRect().top;
            }
        } catch (_) { anchor = null; }

        const el = (tag, cls, text) => {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (text != null) e.textContent = text;
            return e;
        };
        const listOf = (texts) => {
            const ul = el('ul', 'apt-rmk-list');
            for (const t of texts) ul.appendChild(el('li', 'apt-rmk', t));
            return ul;
        };
        // A 56 px row that shows / hides `body` (Contacts, FAA admin, More).
        const toggleFor = (cls, label, body) => {
            const btn = el('button', cls);
            btn.type = 'button';
            btn.setAttribute('aria-expanded', 'false');
            btn.appendChild(el('span', 'apt-rmk-arrow', '▸'));
            btn.appendChild(el('span', 'apt-rmk-toggle-label', label));
            body.hidden = true;
            const toggle = () => {
                body.hidden = !body.hidden;
                btn.firstChild.textContent = body.hidden ? '▸' : '▾';
                btn.setAttribute('aria-expanded', String(!body.hidden));
            };
            if (typeof wireTap === 'function') wireTap(btn, toggle); else btn.addEventListener('click', toggle);
            return btn;
        };
        // The remarks of a group: the first REMARKS_VISIBLE, then "More (n)" over the rest.
        const items = (texts) => {
            const n = AirportPopup.REMARKS_VISIBLE;
            const out = [listOf(texts.slice(0, n))];
            if (texts.length > n) {
                const rest = listOf(texts.slice(n));
                rest.classList.add('apt-rmk-rest');
                out.push(toggleFor('apt-rmk-toggle apt-rmk-more', `More (${texts.length - n})`, rest), rest);
            }
            return out;
        };

        const nodes = [];
        if (groups.length) nodes.push(el('div', 'popup-section-title apt-rmk-title', 'FAA REMARKS'));
        for (const g of groups) {
            const wrap = el('div', 'apt-rmk-group');
            wrap.dataset.cat = g.c;
            if (!g.collapsed) {
                wrap.append(el('div', 'apt-rmk-label', g.label), ...items(g.texts));
            } else {
                const body = el('div', 'apt-rmk-body');
                body.append(...items(g.texts));
                wrap.append(toggleFor('apt-rmk-toggle', `${g.label} (${g.texts.length})`, body), body);
            }
            nodes.push(wrap);
        }
        box.replaceChildren(...nodes);
        box.hidden = groups.length === 0;

        if (anchor) {
            try {
                const delta = anchor.getBoundingClientRect().top - anchorTop;
                if (delta) scroller.scrollTop += delta;
            } catch (_) { /* layout only */ }
        }
    }

    /** How long after the notes box gets focus it is scrolled into view again (the keyboard is up by then). */
    static NOTES_KEYBOARD_MS = 400;
    /** The visual viewport back to at least this fraction of its largest height = the keyboard is gone. */
    static KEYBOARD_GONE_FRACTION = 0.9;

    /**
     * Notes being edited: the whole panel is one scroll column (header, glide block, tabs and INFO
     * scroll together), so a short window with the keyboard up still has room for the notes; they are
     * scrolled to the top of the panel.
     */
    _enterNotesEditing(section) {
        const panel = this._panel;
        if (!panel) return;
        panel.classList.add('apt-notes-editing');
        this._scrollNotesIntoView(section, panel);
    }

    /** Back to the normal layout (the panel itself never scrolls then), the notes kept in view in the tab content. */
    _leaveNotesEditing(section) {
        const panel = this._panel;
        if (!panel || !panel.classList.contains('apt-notes-editing')) return;
        panel.classList.remove('apt-notes-editing');
        panel.scrollTop = 0;
        this._scrollNotesIntoView(section, section.closest('.apt-tab-content'));
    }

    /**
     * Scroll `scroller` (the panel while the notes are being edited, else the tab content) so `el`
     * (the MY NOTES section) starts at its top. Sets scrollTop on that one element (not
     * scrollIntoView, which would also scroll the map area). Guarded: never throws.
     */
    _scrollNotesIntoView(el, scroller) {
        try {
            if (!scroller || !el?.isConnected) return;
            const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollTop += delta;
        } catch (_) { /* layout only */ }
    }

    /**
     * The tab row scrolls sideways when the tabs don't fit (large Android font
     * scale): bring a tapped tab fully into view. Guarded: never throws.
     */
    _scrollTabIntoView(tab) {
        try {
            const bar = tab?.parentElement;
            if (!bar) return;
            const b = bar.getBoundingClientRect();
            const t = tab.getBoundingClientRect();
            if (t.left < b.left) bar.scrollLeft -= (b.left - t.left);
            else if (t.right > b.right) bar.scrollLeft += (t.right - b.right);
        } catch (_) { /* layout only */ }
    }

    /** The notes box is going away: save what is pending. Guarded: never throws into the panel code. */
    _closeNotes() {
        clearTimeout(this._notesScrollTimer);
        this._notesScrollTimer = null;
        const st = this._notesVv;
        this._notesVv = null;
        if (st) {
            try { st.vv.removeEventListener('resize', st.handler); } catch (_) { /* gone */ }
        }
        if (this._panel) {
            this._panel.classList.remove('apt-notes-editing');
            this._panel.scrollTop = 0;
        }
        const ed = this._notes;
        this._notes = null;
        if (!ed) return;
        try {
            ed.detach().catch((err) => console.warn('AirportPopup: notes save failed', err));
        } catch (err) {
            console.warn('AirportPopup: notes detach failed', err);
        }
    }

    /** Stop the glide block (timer + map line). Guarded: never throws into the panel code. */
    _stopGlide() {
        const g = this._glide, host = this._glideHost;
        this._glide = null;
        this._glideHost = null;
        if (g) {
            try { g.stop(); } catch (err) { console.warn('AirportPopup: glide stop failed', err); }
        }
        if (host) host.remove();
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
        this._stopGlide();
        this._closeNotes();
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

    /**
     * TFRs this airport is in or within 5 nm of (tfr.faa.gov, FaaTfrClient).
     * 2026-10-29: inside the Charlotte / Rock Hill VIP TFR every tap opened an
     * airport (the nearest marker wins), so the TFR popup never did; here the
     * airport panel says it.
     */
    _tfrBlockHtml(apt) {
        const client = window.app?.faaTfr;
        if (!client || !Number.isFinite(apt?.lat) || !Number.isFinite(apt?.lon)) return '';
        let near = [];
        try { near = client.near(apt.lat, apt.lon, 5); } catch (_) { return ''; }
        if (!near.length) return '';
        const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const V = (typeof VectorMapLayers !== 'undefined') ? VectorMapLayers : null;
        const alt = (ft, ref) => (V ? V._fmtTfrAlt(ft, ref) : (Number.isFinite(ft) ? `${ft} ft` : '?'));
        const time = (iso) => (V ? V._fmtTfrTime(iso) : iso);
        // The same TFR issued for two Centers (6/3879 ZTL, 6/3884 ZJX on 2026-10-29):
        // same area, times and altitudes -> one row naming both.
        const rows = [];
        for (const e of near) {
            const a = e.area, p0 = a.polygon[0] || [];
            const key = [e.distanceNm === 0, e.status, a.start, a.end, a.lowerFt, a.lowerRef, a.upperFt, a.upperRef,
                a.polygon.length, (+p0[0]).toFixed(3), (+p0[1]).toFixed(3)].join('|');
            const same = rows.find((r) => r.key === key);
            if (same) same.ids.push(e.tfr.id); else rows.push({ key, ids: [e.tfr.id], ...e });
        }
        const html = rows.map(({ ids, tfr, area, status, distanceNm }) => {
            const where = distanceNm === 0 ? 'IN TFR' : `TFR ${distanceNm < 1 ? '<1' : Math.round(distanceNm)} nm`;
            const when = status === 'active' ? (area.end ? `until ${time(area.end)}` : 'active')
                : status === 'upcoming' ? `starts ${time(area.start)}`
                : status === 'ended' ? `ended ${time(area.end)} — check the NOTAM` : 'times not known';
            const tag = status === 'active' ? '<span class="apt-tfr-tag">ACTIVE</span>' : '';
            const head = `<span class="apt-tfr-head">⛔ ${esc(where)} ${esc(ids.join(' / '))}${tfr.legal ? ` · ${esc(tfr.legal)}` : ''}</span>${tag}`;
            const sub = `<span class="apt-tfr-sub">${esc(`${when} · ${alt(area.lowerFt, area.lowerRef)} – ${alt(area.upperFt, area.upperRef)}`)}</span>`;
            // The row is the button for the NOTAM text (no extra button to take room)
            return tfr.text
                ? `<button class="apt-tfr${status === 'active' ? ' is-active' : ''}" data-tfr="${esc(tfr.id)}" aria-expanded="false">
                    <span class="apt-tfr-line">${head}<span class="apt-tfr-arrow">▸</span></span>${sub}</button>
                <div class="apt-tfr-text" data-tfr="${esc(tfr.id)}" hidden>${esc(tfr.text)}</div>`
                : `<div class="apt-tfr${status === 'active' ? ' is-active' : ''}"><span class="apt-tfr-line">${head}</span>${sub}</div>`;
        });
        return `<div class="apt-tfrs">${html.join('')}</div>`;
    }

    _buildPanelHtml(apt, wx) {
        const towerStr = apt.tower ? 'TOWERED' : 'UNCONTROLLED';
        const elevStr = apt.elev_ft ? `${apt.elev_ft} ft` : '';
        const tpaStr = apt.tpa_ft ? ` · TPA ${apt.tpa_ft}` : '';
        const glideOn = AirportPopup.glideOn();

        // Weather VFR badge for header
        let catBadge = '';
        if (wx?.metar?.decoded?.flight_category) {
            const cat = wx.metar.decoded.flight_category;
            const catColors = { VFR: 'var(--cat-vfr)', MVFR: 'var(--cat-mvfr)', IFR: 'var(--cat-ifr)', LIFR: 'var(--cat-lifr)' };
            catBadge = `<span style="color:${catColors[cat] || '#aaa'};font-size:14px;font-weight:900;margin-left:6px;">● ${AirportPopup._esc(cat)}</span>`;
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
            <div class="apt-header-btns">
                <button class="apt-panel-close btn-close" aria-label="Close">✕</button>
                <button class="apt-glide-toggle${glideOn ? ' is-on' : ''}" aria-pressed="${glideOn}" aria-label="Engine-out glide"><span class="apt-glide-word">ENGINE</span> <span class="apt-glide-word">OUT</span></button>
            </div>
        </div>

        ${this._tfrBlockHtml(apt)}

        <div class="apt-action-chips">
            <button class="apt-chip" data-action="direct-to">D→ Direct</button>
            <button class="apt-chip" data-action="add-route">+ Route</button>
            <button class="apt-chip" data-action="plates">Plates</button>
        </div>

        <div class="apt-tabs">
            <button class="apt-tab active" data-tab="info">INFO</button>
            <button class="apt-tab" data-tab="wx">WX</button>
            <button class="apt-tab" data-tab="rwy">RWY</button>
            <button class="apt-tab" data-tab="wind">WIND</button>
            <button class="apt-tab" data-tab="diag">DIAG</button>
            <button class="apt-tab" data-tab="afd">A/FD</button>
        </div>

        <div class="apt-tab-content">
            <div class="apt-tab-pane active" data-pane="info">
                ${this._aptFactsHtml(apt)}
                ${this._frequenciesHtml(apt.frequencies || [], apt.tower)}
                ${this._fuelHtml(apt)}
                ${(CockpitConfig.get('ifr.showCdPhone') || CockpitConfig.get('ifr.showCraft')) ? this._ifrHtml(apt) : ''}
                <!-- FAA REMARKS (read-only): filled after the panel is up by _loadFaaRemarks; hidden
                     while empty. It sits between IFR CLEARANCE and MY NOTES. -->
                <div class="apt-faa-remarks" hidden></div>
                <div class="popup-section apt-my-notes">
                    <div class="popup-section-title apt-notes-title">MY NOTES</div>
                    <div class="apt-notes-pane"></div>
                </div>
            </div>
            <div class="apt-tab-pane" data-pane="wx">
                ${this._wxPaneHtml(wx) || AirportPopup.NO_WX_HTML}
            </div>
            <div class="apt-tab-pane" data-pane="rwy">
                ${apt.runways?.length ? this._runwaysHtml(apt.runways) : '<div style="padding:16px;color:var(--text-muted)">No runway data</div>'}
            </div>
            <div class="apt-tab-pane" data-pane="wind">
                <div class="apt-wind-pane"></div>
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
                taf: this._taf ? { raw: this._taf.raw } : null,     // a new METAR must not drop the TAF shown
                source: 'fisb',
                fetched_at: new Date(e.detail.received_at).toISOString(),
            };
            // Update panel weather pane
            if (this._panel && this._panelOpen) {
                const wxPane = this._panel.querySelector('.apt-tab-pane[data-pane="wx"]');
                if (wxPane) {
                    wxPane.innerHTML = this._wxPaneHtml(wx) || AirportPopup.NO_WX_HTML;
                }
                this._updateWindCompass(wx);
            }
            // Update legacy Leaflet popup
            if (this._popup) {
                const container = this._popup.getElement();
                if (container) {
                    const wxSection = container.querySelector('.popup-wx-section');
                    if (wxSection) wxSection.outerHTML = this._wxPaneHtml(wx);
                }
            }
        };
        this._fisbClient.addEventListener('fisb:metar', this._onFisbMetar);

        // Live TAF updates while popup is open: shown when newer than the TAF shown (_offerTaf), with or
        // without a METAR section.
        this._onFisbTaf = (e) => {
            if (e.detail.icao !== airport.icao) return;
            if (this._offerTaf(e.detail.raw, 'fisb', e.detail.received_at ?? null)) this._putTafInPane(this._taf.raw);
        };
        this._fisbClient.addEventListener('fisb:taf', this._onFisbTaf);
    }

    /** Keep the WIND tab on the same METAR the WX tab just refreshed to. */
    _updateWindCompass(wx) {
        try {
            this._windCompass?.updateWx(wx);
        } catch (err) {
            console.warn('AirportPopup: wind compass update failed', err);
        }
    }

    _startInternetMetarListener(airport) {
        if (!this._vectorLayers) return;
        this._onInternetMetarBound = (icao, entry) => {
            if (icao !== airport.icao) return;
            if (this._fisbClient?.getMetar(icao)) return; // FIS-B takes priority
            const wx = {
                metar: { raw: entry.raw, decoded: entry.decoded, fetched_at: new Date(entry.received_at).toISOString() },
                taf: this._taf ? { raw: this._taf.raw } : null,     // a new METAR must not drop the TAF shown
                source: 'internet',
                fetched_at: new Date(entry.received_at).toISOString(),
            };
            if (this._panel && this._panelOpen) {
                const wxPane = this._panel.querySelector('.apt-tab-pane[data-pane="wx"]');
                if (wxPane) wxPane.innerHTML = this._wxPaneHtml(wx) || AirportPopup.NO_WX_HTML;
                this._updateWindCompass(wx);
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

    /**
     * The airport's TAF from AWC through the flywhere proxy (Settings.workerBase; AWC itself sends no CORS
     * header). No `hours` parameter: AWC's TAF endpoint answers 400 "Unexpected query parameter provided"
     * to it (the proxy then 502), checked 2026-11-04. Reply: [{ icaoId, rawTAF: "TAF KCLT 041535Z ...", ... }],
     * [] when the airport has no TAF. Shown only when newer than the TAF shown (_offerTaf); any failure
     * (offline, in flight, 502) leaves the WX tab as it is.
     */
    async _fetchInternetTaf(icao) {
        this._inetTafTried = true;
        try {
            const base = (typeof Settings !== 'undefined' && Settings.workerBase)
                ? Settings.workerBase : 'https://www.flywhere.app/api';
            const url = `${base}/weather?type=taf&ids=${encodeURIComponent(icao)}&format=json`;
            const opts = { cache: 'no-store' };
            if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
                opts.signal = AbortSignal.timeout(10000);
            }
            const r = await fetch(url, opts);
            if (!r.ok) return;
            const data = await r.json();
            const raw = (Array.isArray(data) ? data[0] : data)?.rawTAF;
            if (typeof raw !== 'string' || !raw.trim()) return;
            this._cacheTaf(icao, raw.trim(), Date.now());          // kept for the flight (no internet in the air)
            if (this._currentIcao !== icao) return;
            if (this._offerTaf(raw, 'internet')) this._putTafInPane(this._taf.raw);
        } catch { /* offline: the WX tab keeps what it has */ }
    }

    /**
     * Keep a TAF fetched on the ground in the IndexedDB weather cache for that airport, so the panel still
     * has it in flight until it expires. Read-merge: the METAR and the rest of the record stay; a cached TAF
     * issued later (_tafNewer) stays too. An expired TAF is not written. Never throws.
     */
    _cacheTaf(icao, raw, now) {
        const nasr = this._nasr;
        if (!nasr || typeof nasr.getWeather !== 'function' || typeof nasr.putWeather !== 'function') return;
        if (AirportPopup._tafExpired(raw, now)) return;
        const at = new Date(now).toISOString();
        Promise.resolve()
            .then(() => nasr.getWeather(icao))
            .catch(() => null)
            .then((existing) => {
                const old = existing?.taf?.raw;
                const oldAt = existing?.taf?.fetched_at || existing?.fetched_at || null;
                if (old && !AirportPopup._tafExpired(old, now, oldAt)) {
                    const cand = { raw, issued: AirportPopup._tafIssuedMs(raw, now) };
                    const cur = { raw: old, issued: AirportPopup._tafIssuedMs(old, now) };
                    if (cand.raw === cur.raw || !AirportPopup._tafNewer(cand, cur)) return null;
                }
                const rec = { ...(existing || {}), taf: { raw, fetched_at: at }, fetched_at: at };
                delete rec.icao;
                if (!rec.source) rec.source = 'internet';
                return nasr.putWeather(icao, rec);
            })
            .catch(() => {});
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
                                // Cache on the NASR record (putAirport: the map's area queries see it too)
                                try { await this._nasr.putAirport(apt); } catch { /* non-critical */ }
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
        this._stopGlide();
        this._closeNotes();
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
        this._stopGlide();
        this._closeNotes();
        this._stopFisbListener();
        this._stopInternetMetarListener();
        this._stopNetworkListener();
    }

    // ========== HTML Building ==========

    _buildHtml(apt, wx) {
        const sections = [];

        // Header
        sections.push(this._headerHtml(apt));

        // Runways. The interactive Wind tab (compass rose + headwind/crosswind,
        // formerly this fallback's "best runway" text block) is only available
        // in the tabbed sliding-panel view (_buildPanelHtml) -- this flat
        // Leaflet-popup view has no tab structure to host it in.
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

        // Weather (a TAF shows without a METAR too)
        if (wx) {
            sections.push(this._wxPaneHtml(wx));
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
     * Shows the plate inline as an <img> (WebP converted), or the PDF drawn by renderPdfToContainer.
     * Uses the approach charts module's plate index if available.
     */
    /**
     * Load the A/FD (Airport/Facility Directory) Chart Supplement page for an airport.
     * The pipeline downloads per-airport pages from the FAA Chart Supplement and stores
     * them as AFD_PAGE.webp in data/plates/{ICAO}/AFD_PAGE.webp via NanoHTTPD.
     */
    async _loadAfdPane(containerEl, icao, state) {
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
            // Whether the A/FD pages on the tablet are current (FaaCurrency,
            // as recorded at sync): stale pages showed with no sign (round 2).
            if (typeof FaaCurrency !== 'undefined') {
                const dm = FaaCurrency.deviceManifest();
                const a = FaaCurrency.products(dm, null, Date.now()).find((x) => x.key === 'afd');
                const line = document.createElement('div');
                line.className = 'approach-currency';
                const note = dm.afd?.note;
                // A state the last sync did not update keeps its last pages (sync
                // prunes only the folders a zip has): not covered by the sync's
                // expiry (final review 2026-10-17). server_states: the states the
                // server had at that sync (synced_states keeps dropped ones).
                const pl = dm.plates || {};
                const st = String(state || '').toUpperCase();
                const why = !st ? null
                    : (pl.failed_states || []).includes(st) ? `${st} plates are the previous cycle's (last download failed)`
                    : (pl.server_states || []).length && !pl.server_states.includes(st) ? `${st} is no longer on the home server`
                    : (pl.synced_states || []).length && !pl.synced_states.includes(st) ? `${st} is not synced to this tablet`
                    : null;
                const orphan = !!why;
                line.textContent = orphan ? `A/FD page not current — ${why}`
                                 : a.state === 'stale' ? `A/FD page not current${note ? ` — ${note}` : ''}; sync when the home server has rebuilt it`
                                 : FaaCurrency.describe(a);
                line.classList.toggle('is-bad', orphan || a.state === 'stale' || a.state === 'expired' || a.state === 'unknown');
                containerEl.appendChild(line);
            }
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
            z-index: 99998;
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
                                <img class="apt-plate-img" src="${webpUrl}" alt="${name}">
                            </div>
                        </div>`;

                    const img = containerEl.querySelector('.apt-plate-img');
                    if (img) {
                        this._enablePinchZoom(img);
                        // No WebP: draw the PDF with the shared PDF.js renderer. A PDF
                        // in an <iframe> shows nothing in Android's WebView.
                        img.onerror = () => {
                            img.onerror = null;
                            const wrap = img.parentElement;
                            img.remove();
                            renderPdfToContainer(pdfUrl, wrap, { cssClass: 'apt-plate-pdf', errorLabel: 'plate' });
                        };
                    }

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

            // WebP first (converted by plate pipeline); PDF via renderPdfToContainer if missing
            const webpUrl = `${PLATES_BASE}/${icaoDir}/${file.replace(/\.pdf$/i, '.webp')}`;
            const pdfUrl  = `${PLATES_BASE}/${icaoDir}/${file}`;

            const name = plate.name || plate.chart_name || plateType;

            // Inline: the diagram image, tap to open it full screen in the
            // approach-plate viewer (ApproachCharts), which has pinch-zoom and its
            // own WebP -> PDF.js rendering -- as the A/FD tab opens full screen.
            // There used to be only inline pinch-zoom here and a tap did nothing.
            const canOpen = !!this._approachCharts?.showPlateForAirport;
            containerEl.innerHTML = `
                <div class="apt-plate-viewer">
                    <div class="apt-plate-title">${name}</div>
                    ${canOpen ? '<div class="apt-plate-hint">Tap to open full screen</div>' : ''}
                    <div class="apt-plate-img-wrap">
                        <img class="apt-plate-img" src="${webpUrl}" alt="${name}">
                    </div>
                </div>`;

            const wrap = containerEl.querySelector('.apt-plate-img-wrap');
            const img = wrap.querySelector('.apt-plate-img');
            // No WebP for this plate: draw the PDF with the shared PDF.js renderer.
            // The old fallback, a PDF in an <iframe>, shows nothing in Android's
            // WebView (it has no PDF viewer).
            // Except minimums: one FAA document per volume, whose first page is
            // another airport's -- say the page is missing (pre-merge review).
            img.onerror = () => {
                img.onerror = null;
                img.remove();
                if (plateType === 'MIN') {
                    const msg = document.createElement('div');
                    msg.style.cssText = 'padding:16px;background:var(--bg-primary);color:var(--text-primary);font-family:var(--font-ui);font-size:var(--text-md);font-weight:700;text-align:center;';
                    msg.textContent = `${icao}: this airport's minimums page is not on this tablet — sync plates in MORE → Data Status.`;
                    wrap.appendChild(msg);
                    return;
                }
                renderPdfToContainer(pdfUrl, wrap, { cssClass: 'apt-plate-pdf', errorLabel: 'airport diagram' });
            };
            if (canOpen) {
                wireTap(wrap, () => {
                    this._approachCharts.showPlateForAirport(icao, (p) => (p.filename || p.pdf_name) === file);
                    this.close();
                });
            }

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
                <td>${AirportPopup._esc(rwy.id)}</td>
                <td>${AirportPopup._esc(rwy.length_ft || '?')} x ${AirportPopup._esc(rwy.width_ft || '?')}</td>
                <td>${AirportPopup._esc(rwy.surface || '')}</td>
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
            if (dirs) facts.push({ label: 'DIR', value: AirportPopup._esc(dirs) });
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
            const color = cat?.color || 'var(--text-secondary)';
            const isPrimary = (!isTowered && freq.type === 'ctaf') || (isTowered && freq.type === 'twr');
            const star = isPrimary ? ' <span class="freq-primary">★</span>' : '';
            // 'sector' is the raw NASR sectorization suffix (degree range,
            // compass point, altitude split, etc.) -- currently only
            // 'trsa'-typed entries carry one (e.g. a sectorized TRSA
            // publishes one frequency per arrival quadrant), shown verbatim
            // next to the frequency so a pilot knows which one to call.
            const sectorSuffix = freq.sector ? ` <span class="freq-sector">(${freq.sector})</span>` : '';

            return `<tr class="freq-row" data-freq="${freq.freq}">
                <td style="color:${color}">${label}${star}</td>
                <td class="freq-value">${freq.freq}${sectorSuffix}</td>
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
                tstmLines.map(l => `<div class="wx-tstm-line">${AirportPopup._esc(l)}</div>`).join('')
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
                `<span class="wx-phenom" style="color:${p.color}">${AirportPopup._esc(p.code)}</span>`).join('')}</div>`
            : '';

        // Labeled data rows
        const visRow = visSm != null
            ? `<div class="wx-row"><div class="wx-row-lbl">VIS</div><div class="wx-row-val">${visPlus ? '&gt;' : ''}${AirportPopup._esc(visSm)} SM</div></div>`
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

        const tafHtml = wx.taf?.raw ? this._tafHtml(wx.taf.raw) : '';

        const windRow = windStr
            ? `<div class="wx-row"><div class="wx-row-lbl">WIND</div><div class="wx-row-val">${AirportPopup._esc(windStr)}</div></div>`
            : '';

        return `<div class="popup-section popup-wx-section${speciClass}">
            <div class="wx-card-hdr" style="background:${catBgColor};border-left:4px solid ${catColor}">
                <span class="wx-cat-dot" style="color:${catColor}">&#9679;</span>
                <span class="wx-cat-name" style="color:${catColor}">${AirportPopup._esc(cat)}</span>
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
            <div class="wx-metar"><span class="wx-metar-label">RAW</span>${AirportPopup._esc(raw)}</div>
            ${tafHtml}
        </div>`;
    }

    // _bestRunwayHtml was replaced by the interactive Wind tab (compass rose
    // + headwind/crosswind) -- see wind-compass.js. Its math (runway-end
    // parsing, headwind/crosswind trig, best-end selection) now lives there
    // as WindCompass.parseRunwayEnds/computeWindComponents.

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

    /** A TAF whose validity can't be read is not shown once fetched longer ago than this (the weather
     *  cache's prune age, the longest a TAF is valid). */
    static TAF_MAX_AGE_MS = 30 * 3600 * 1000;

    /** "No weather data" in the WX tab: no METAR and no TAF. */
    static NO_WX_HTML = '<div style="padding:16px;color:var(--text-muted)">No weather data</div>';

    /** The TAF title + text (escaped by _formatTaf). */
    _tafHtml(raw) {
        return `<div class="popup-section-title" style="margin-top:10px">TAF</div><div class="wx-metar wx-taf">${this._formatTaf(raw)}</div>`;
    }

    /**
     * WX tab content: the METAR card (with the TAF under it), or a TAF-only section when there is a TAF
     * but no METAR, or '' when there is neither.
     */
    _wxPaneHtml(wx) {
        if (!wx) return '';
        if (wx.metar) {
            const html = this._weatherHtml(wx);
            if (html) return html;
        }
        if (!wx.taf?.raw) return '';
        return `<div class="popup-section popup-wx-section popup-wx-taf-only">
            <div class="wx-time"><span>No METAR</span></div>
            ${this._tafHtml(wx.taf.raw)}
        </div>`;
    }

    /** TAF raw text as HTML: escaped first, then a line break before each FM group. */
    _formatTaf(raw) {
        return AirportPopup._esc(raw || '').replace(/ (FM\d{6})/g, '<br>$1');
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
