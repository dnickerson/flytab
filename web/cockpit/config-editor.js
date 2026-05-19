/**
 * FlyPi — Config Editor Overlay
 * Editable view of cockpit-config.json and aircraft-config.json.
 */

class ConfigEditor {
    constructor(parentEl) {
        this._parentEl = parentEl;
        this._el = null;
        this._visible = false;
        this._cockpitConfig = null;
        this._aircraftConfig = null;
        this._dirty = false;
        this._buildDOM();
    }

    show() {
        this._el.classList.add('visible');
        this._visible = true;
        this._setMapControlsVisible(false);
        this._load();
    }

    hide() {
        if (this._dirty) {
            this._dirty = false;
        }
        this._el.classList.remove('visible');
        this._visible = false;
        this._setMapControlsVisible(true);
    }

    toggle() {
        this._visible ? this.hide() : this.show();
    }

    async _load() {
        const body = this._el.querySelector('.config-editor-body');
        body.innerHTML = '<div class="ds-loading">Loading configuration...</div>';

        try {
            // FlyTab: load from bundled local files, not Pi server
            const [cockpitResp, aircraftResp] = await Promise.all([
                fetch('cockpit-config.json', { signal: AbortSignal.timeout(3000) }),
                fetch('aircraft-config.json', { signal: AbortSignal.timeout(3000) }),
            ]);
            this._cockpitConfig = cockpitResp.ok ? await cockpitResp.json() : {};
            this._aircraftConfig = aircraftResp.ok ? await aircraftResp.json() : {};

            // Merge user-saved overrides from localStorage on top of bundled defaults
            // so the editor shows the user's actual saved settings, not just bundled values.
            this._cockpitConfig = CockpitConfig._mergeUserOverrides(this._cockpitConfig, 'flypi_user_cockpit');
            this._aircraftConfig = CockpitConfig._mergeUserOverrides(this._aircraftConfig, 'flypi_user_aircraft');

            this._render();
        } catch (err) {
            body.innerHTML = `<div class="ds-error">Failed to load config: ${err.message}</div>`;
        }
    }

    _render() {
        const body = this._el.querySelector('.config-editor-body');
        const sections = [];

        sections.push(`<div class="ce-update-bar">
            <button class="ce-update-btn">&#11015; Download &amp; Install Update</button>
            <span class="ce-update-status"></span>
        </div>`);

        // Cockpit config sections
        sections.push(this._sectionHeader('Cockpit Configuration'));
        sections.push(this._renderSection('map', 'Map Settings', this._cockpitConfig.map || {}, {
            'defaultBaseLayer': { type: 'select', options: ['vector', 'sectional', 'osm'], label: 'Base Layer' },
            'defaultZoom': { type: 'number', label: 'Default Zoom', min: 4, max: 14 },
        }));

        sections.push(this._renderOverlays(this._cockpitConfig.map?.overlays || {}));

        sections.push(this._renderSection('enginePage', 'Engine Page', this._cockpitConfig.enginePage || {}, {
            'trendChartMinutes': { type: 'number', label: 'Trend Chart (min)', min: 5, max: 120 },
            'fuelCautionGal': { type: 'number', label: 'Fuel Caution (gal)', min: 0, max: 50, step: 0.5 },
            'fuelWarningGal': { type: 'number', label: 'Fuel Warning (gal)', min: 0, max: 50, step: 0.5 },
            'egtChartEnabled': { type: 'bool', label: 'EGT Chart' },
            'showBsfc': { type: 'bool', label: 'Show BSFC' },
            'showPeakDelta': { type: 'bool', label: 'Show Peak Delta' },
        }));

        sections.push(this._renderSection('flightRecording', 'Flight Recording', this._cockpitConfig.flightRecording || {}, {
            'autoRecord': { type: 'bool', label: 'Auto Record' },
            'rpmStartThreshold': { type: 'number', label: 'RPM Start Threshold', min: 0, max: 2000 },
            'rpmStopThreshold': { type: 'number', label: 'RPM Stop Threshold', min: 0, max: 1000 },
            'stopDelaySeconds': { type: 'number', label: 'Stop Delay (sec)', min: 10, max: 300 },
            'autoSyncWhenOnline': { type: 'bool', label: 'Auto Sync Online' },
        }));

        sections.push(this._renderSection('radar', 'Radar', this._cockpitConfig.radar || {}, {
            'loopDurationHours': { type: 'number', label: 'Loop Duration (hr)', min: 1, max: 6 },
            'frameIntervalMinutes': { type: 'number', label: 'Frame Interval (min)', min: 5, max: 30 },
            'playbackSpeedMs': { type: 'number', label: 'Playback Speed (ms)', min: 100, max: 2000, step: 50 },
            'opacity': { type: 'number', label: 'Opacity', min: 0, max: 1, step: 0.1 },
            'autoLoop': { type: 'bool', label: 'Auto Loop' },
        }));

        sections.push(this._renderSection('approachCharts', 'Approach Charts', this._cockpitConfig.approachCharts || {}, {
            'georefEnabled': { type: 'bool', label: 'Georef Overlay' },
            'ownshipIconSize': { type: 'number', label: 'Ownship Icon Size', min: 12, max: 48 },
            'autoRotateTrackUp': { type: 'bool', label: 'Auto Rotate Track Up' },
            'preloadRoutePlates': { type: 'bool', label: 'Preload Route Plates' },
        }));

        sections.push(this._renderSection('takeoffAlerts', 'Takeoff Alerts', this._cockpitConfig.takeoffAlerts || {}, {
            'showDmms': { type: 'bool', label: 'Show DMMS' },
            'dmmsDisplayUntilAglFt': { type: 'number', label: 'DMMS Until AGL (ft)', min: 500, max: 3000, step: 100 },
            'dmmsFlashWhenBelow': { type: 'bool', label: 'Flash When Below' },
        }));

        sections.push(this._renderSection('ifr', 'IFR', this._cockpitConfig.ifr || {}, {
            'showCdPhone':    { type: 'bool', label: 'Show CD Phone' },
            'defaultCdPhone': { type: 'text', label: 'Default CD Phone', wide: true },
            'showCraft':      { type: 'bool', label: 'Show CRAFT' },
        }));

        sections.push(this._renderSection('traffic', 'Traffic', this._cockpitConfig.traffic || {}, {
            'maxAboveAlt':    { type: 'number', label: 'Max Above (ft)', min: 500, max: 10000, step: 500 },
            'maxBelowAlt':    { type: 'number', label: 'Max Below (ft)', min: 500, max: 10000, step: 500 },
            'showCallsign':   { type: 'bool', label: 'Show Callsign' },
        }));

        sections.push(this._renderSection('logbook', 'Logbook', this._cockpitConfig.logbook || {}, {
            'autoCreate': { type: 'bool', label: 'Auto Create' },
            'defaultConditions': { type: 'select', options: ['VFR', 'IFR'], label: 'Default Conditions' },
            'trackHobbs': { type: 'bool', label: 'Track Hobbs' },
        }));

        // Connection settings (from localStorage, not cockpit-config.json)
        sections.push(this._sectionHeader('Connection'));
        const hs = this._cockpitConfig.homeServer || {};
        const hsBase = hs.base || (hs.nasrBase ? hs.nasrBase.replace(/\/nasr\/?$/, '').replace(/\/$/, '') : '') || (hs.tileBase ? hs.tileBase.replace(/\/tiles\/?$/, '').replace(/\/$/, '') : '');
        sections.push(`<div class="ds-card">
            <div class="ds-card-title">Home Network</div>
            <div class="ce-fields">
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-home-base">Home Server</label>
                    <input type="text" id="ce-home-base" class="ce-input" style="width:250px"
                        placeholder="http://192.168.1.x:8090"
                        value="${hsBase}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-home-fallback">Tailscale Fallback</label>
                    <input type="text" id="ce-home-fallback" class="ce-input" style="width:250px"
                        placeholder="http://100.x.x.x:8090"
                        value="${hs.fallbackBase || ''}">
                </div>
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    Tiles, plates, and NASR paths are appended automatically.
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-notam-base">NOTAM Server</label>
                    <input type="text" id="ce-notam-base" class="ce-input" style="width:250px"
                        placeholder="https://hostname.ts.net"
                        value="${this._cockpitConfig.notamBase || ''}">
                </div>
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    FitPC NOTAM proxy URL (Tailscale Funnel). Leave blank to use flywhere.app.
                </div>
            </div>
        </div>`);
        sections.push(`<div class="ds-card">
            <div class="ds-card-title">Stratux</div>
            <div class="ce-fields">
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-stratux-ip">Stratux IP</label>
                    <input type="text" id="ce-stratux-ip" class="ce-input" style="width:150px"
                        value="${typeof Settings !== 'undefined' ? Settings.stratuxIp : '192.168.10.1'}">
                </div>
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    Pi IP for live GPS/traffic/engine data (default: 192.168.10.1)
                </div>
            </div>
        </div>`);
        const fu = this._cockpitConfig.flightUpload || {};
        sections.push(`<div class="ds-card">
            <div class="ds-card-title">Flight Upload (SFTP)</div>
            <div class="ce-fields">
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-host">Host</label>
                    <input type="text" id="ce-fu-host" class="ce-input" style="width:220px"
                        placeholder="192.168.1.81 or hostname.ts.net"
                        value="${fu.host || ''}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-port">Port</label>
                    <input type="number" id="ce-fu-port" class="ce-input" style="width:80px"
                        min="1" max="65535" value="${fu.port || 22}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-user">Username</label>
                    <input type="text" id="ce-fu-user" class="ce-input" style="width:150px"
                        value="${fu.username || ''}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-path">Remote Path</label>
                    <input type="text" id="ce-fu-path" class="ce-input" style="width:220px"
                        placeholder="~/flights"
                        value="${fu.remotePath || '~/flights'}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label">SSH Key</label>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span id="ce-fu-key-status" style="color:var(--text-secondary,#a0b8d0);font-size:14px;">checking…</span>
                        <button id="ce-fu-import-btn" class="ce-key-btn" style="display:none;">Import Key</button>
                        <button id="ce-fu-clear-btn" class="ce-key-btn" style="display:none;">Clear Key</button>
                    </div>
                </div>
                <div id="ce-fu-key-import-row" style="display:none;" class="ce-field-row">
                    <label class="ce-label"></label>
                    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                        <input type="text" id="ce-fu-key-path" class="ce-input" style="width:200px"
                               placeholder="Documents/id_rsa">
                        <button id="ce-fu-key-do-import" class="ce-key-btn">Import</button>
                        <button id="ce-fu-key-cancel" class="ce-key-btn ce-key-btn--cancel">Cancel</button>
                        <span id="ce-fu-key-error" style="color:var(--status-danger,#c0392b);font-size:13px;width:100%;display:none;"></span>
                    </div>
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-fu-apk">APK Remote Path</label>
                    <input type="text" id="ce-fu-apk" class="ce-input" style="width:220px"
                        placeholder="~/flytab/flytab-latest.apk"
                        value="${fu.apkRemotePath || ''}">
                </div>
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    Password is stored encrypted on device. Use More → Flight Upload to manage it.
                </div>
            </div>
        </div>`);

        const currentGps = typeof Settings !== 'undefined' ? (Settings.get('gps_source') || 'auto') : 'auto';
        sections.push(`<div class="ds-card">
            <div class="ds-card-title">GPS Source</div>
            <div class="ce-fields">
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-gps-source">Position Source</label>
                    <select id="ce-gps-source" class="ce-select">
                        <option value="auto"     ${currentGps === 'auto'     ? 'selected' : ''}>Auto (Stratux, device fallback)</option>
                        <option value="stratux"  ${currentGps === 'stratux'  ? 'selected' : ''}>Stratux only</option>
                        <option value="internal" ${currentGps === 'internal' ? 'selected' : ''}>Device GPS only</option>
                    </select>
                </div>
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    Auto: uses Stratux GPS when connected, falls back to device GPS if Stratux is unavailable.
                </div>
            </div>
        </div>`);

        // Aircraft config
        sections.push(this._sectionHeader('Aircraft Configuration'));
        const perf = this._aircraftConfig.performance || {};
        sections.push(this._renderSection('aircraft', 'Aircraft', {
            tail: this._aircraftConfig.tail || '',
            type: this._aircraftConfig.type || '',
            ...perf,
        }, {
            'tail': { type: 'text', label: 'Tail Number' },
            'type': { type: 'text', label: 'Aircraft Type' },
            'cruise_speed_kt': { type: 'number', label: 'Cruise TAS (kt)', min: 50, max: 300 },
            'fuel_capacity_gal': { type: 'number', label: 'Fuel Capacity (gal)', min: 10, max: 200, step: 0.5 },
            'cruise_gph': { type: 'number', label: 'Fuel Burn (gph)', min: 1, max: 50, step: 0.1 },
            'vs0_kt': { type: 'number', label: 'Vs0 (kt)', min: 20, max: 100 },
            'vs1_kt': { type: 'number', label: 'Vs1 (kt)', min: 20, max: 100 },
            'vfe_kt': { type: 'number', label: 'Vfe (kt)', min: 40, max: 200 },
            'vno_kt': { type: 'number', label: 'Vno (kt)', min: 50, max: 250 },
            'vne_kt': { type: 'number', label: 'Vne (kt)', min: 80, max: 400 },
            'dmms_factor':      { type: 'number', label: 'DMMS Factor', min: 1.0, max: 2.0, step: 0.001 },
            'glide_ratio':      { type: 'number', label: 'Glide Ratio', min: 5, max: 30, step: 0.5 },
            'test_alt_agl_ft':  { type: 'number', label: 'Test Alt AGL (ft)', min: 1000, max: 20000, step: 500 },
        }));

        // Save button
        sections.push(`<div class="ce-actions">
            <button class="ce-save-btn">SAVE CONFIGURATION</button>
            <button class="ce-reload-btn">RELOAD</button>
        </div>`);

        body.innerHTML = sections.join('');

        // Bind save/reload — touchstart + click for iPad
        wireTap(body.querySelector('.ce-save-btn'), () => this._save());
        wireTap(body.querySelector('.ce-reload-btn'), () => this._load());
        wireTap(body.querySelector('.ce-update-btn'), () => this._downloadAndInstall());

        // SSH key management
        if (typeof Capacitor !== 'undefined' && Capacitor.Plugins?.Sftp) {
            Capacitor.Plugins.Sftp.getKeyStatus()
                .then(({hasKey}) => this._updateKeyStatus(hasKey))
                .catch(() => this._updateKeyStatus(false));
        }
        wireTap(body.querySelector('#ce-fu-import-btn'), () => {
            body.querySelector('#ce-fu-key-import-row').style.display = '';
            body.querySelector('#ce-fu-key-path').value = '';
            const errEl = body.querySelector('#ce-fu-key-error');
            errEl.textContent = '';
            errEl.style.display = 'none';
        });
        wireTap(body.querySelector('#ce-fu-key-cancel'), () => {
            body.querySelector('#ce-fu-key-import-row').style.display = 'none';
        });
        wireTap(body.querySelector('#ce-fu-key-do-import'), async () => {
            const pathEl = body.querySelector('#ce-fu-key-path');
            const errEl = body.querySelector('#ce-fu-key-error');
            const keyPath = pathEl.value.trim();
            if (!keyPath) { pathEl.focus(); return; }
            try {
                const result = await Capacitor.Plugins.Sftp.importKey({ keyPath });
                if (result.ok) {
                    body.querySelector('#ce-fu-key-import-row').style.display = 'none';
                    this._updateKeyStatus(true);
                } else {
                    errEl.textContent = result.error || 'Import failed';
                    errEl.style.display = '';
                }
            } catch (e) {
                errEl.textContent = 'Import failed';
                errEl.style.display = '';
            }
        });
        wireTap(body.querySelector('#ce-fu-clear-btn'), async () => {
            await Capacitor.Plugins.Sftp.clearKey();
            this._updateKeyStatus(false);
        });

        // Track changes
        body.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('change', () => { this._dirty = true; });
        });
    }

    _sectionHeader(title) {
        return `<div class="ce-section-header">${title}</div>`;
    }

    _renderSection(sectionKey, title, data, fields) {
        let rows = '';
        for (const [key, cfg] of Object.entries(fields)) {
            const val = data[key];
            rows += this._renderField(sectionKey, key, cfg, val);
        }
        return `<div class="ds-card">
            <div class="ds-card-title">${title}</div>
            <div class="ce-fields">${rows}</div>
        </div>`;
    }

    _renderOverlays(overlays) {
        let rows = '';
        for (const [name, settings] of Object.entries(overlays)) {
            const label = name.charAt(0).toUpperCase() + name.slice(1);
            rows += `<div class="ce-field-row">
                <label class="ce-label">${label}</label>
                <div class="ce-overlay-group">
                    <label class="ce-toggle-label">
                        <input type="checkbox" data-section="overlays" data-key="${name}.enabled" ${settings.enabled ? 'checked' : ''}>
                        On
                    </label>
                    <label class="ce-mini-label">minZoom
                        <input type="number" data-section="overlays" data-key="${name}.minZoom" value="${settings.minZoom || 7}" min="1" max="18" class="ce-input-sm">
                    </label>
                    ${settings.labelsMinZoom != null ? `<label class="ce-mini-label">labels
                        <input type="number" data-section="overlays" data-key="${name}.labelsMinZoom" value="${settings.labelsMinZoom}" min="1" max="18" class="ce-input-sm">
                    </label>` : ''}
                </div>
            </div>`;
        }
        return `<div class="ds-card">
            <div class="ds-card-title">Map Overlays</div>
            <div class="ce-fields">${rows}</div>
        </div>`;
    }

    _renderField(section, key, cfg, value) {
        const id = `ce-${section}-${key}`;
        let input;

        if (cfg.type === 'bool') {
            input = `<input type="checkbox" id="${id}" data-section="${section}" data-key="${key}" ${value ? 'checked' : ''}>`;
        } else if (cfg.type === 'select') {
            const opts = cfg.options.map(o => `<option value="${o}" ${o === value ? 'selected' : ''}>${o}</option>`).join('');
            input = `<select id="${id}" data-section="${section}" data-key="${key}" class="ce-select">${opts}</select>`;
        } else if (cfg.type === 'number') {
            const step = cfg.step || 1;
            input = `<input type="number" id="${id}" data-section="${section}" data-key="${key}" value="${value ?? ''}" min="${cfg.min ?? ''}" max="${cfg.max ?? ''}" step="${step}" class="ce-input">`;
        } else {
            const widthClass = cfg.wide ? 'ce-input ce-input--wide' : 'ce-input';
            input = `<input type="text" id="${id}" data-section="${section}" data-key="${key}" value="${value ?? ''}" class="${widthClass}">`;
        }

        return `<div class="ce-field-row">
            <label class="ce-label" for="${id}">${cfg.label}</label>
            ${input}
        </div>`;
    }

    async _save() {
        const body = this._el.querySelector('.config-editor-body');
        const saveBtn = body.querySelector('.ce-save-btn');
        saveBtn.textContent = 'Saving...';
        saveBtn.disabled = true;

        try {
            // Save connection settings to localStorage
            const stratuxIpEl = body.querySelector('#ce-stratux-ip');
            if (stratuxIpEl && typeof Settings !== 'undefined') {
                const newIp = stratuxIpEl.value.trim();
                if (newIp && newIp !== Settings.stratuxIp) {
                    Settings.stratuxIp = newIp;
                    // Reconnect Stratux with new IP
                    if (typeof app !== 'undefined' && app.stratuxClient) {
                        app.stratuxClient.disconnect();
                        app.stratuxClient.connect();
                    }
                }
            }

            // Flight Upload settings
            const fuHost = body.querySelector('#ce-fu-host');
            const fuPort = body.querySelector('#ce-fu-port');
            const fuUser = body.querySelector('#ce-fu-user');
            const fuPath = body.querySelector('#ce-fu-path');
            const fuApk  = body.querySelector('#ce-fu-apk');
            if (fuHost) {
                if (!this._cockpitConfig.flightUpload) this._cockpitConfig.flightUpload = {};
                this._cockpitConfig.flightUpload.host = fuHost.value.trim();
                this._cockpitConfig.flightUpload.port = parseInt(fuPort?.value || '22', 10) || 22;
                this._cockpitConfig.flightUpload.username = fuUser?.value.trim() || '';
                this._cockpitConfig.flightUpload.remotePath = fuPath?.value.trim() || '~/flights';
                this._cockpitConfig.flightUpload.apkRemotePath = fuApk?.value.trim() || '';
            }

            // Save GPS source
            const gpsEl = body.querySelector('#ce-gps-source');
            if (gpsEl && typeof app !== 'undefined' && app.gpsSource) {
                app.gpsSource.setSource(gpsEl.value);
            }

            // Collect home server base URL — paths are derived automatically
            const baseEl     = body.querySelector('#ce-home-base');
            const fallbackEl = body.querySelector('#ce-home-fallback');
            this._cockpitConfig.homeServer = {};
            if (baseEl) this._cockpitConfig.homeServer.base = baseEl.value.trim().replace(/\/$/, '');
            if (fallbackEl) {
                const fb = fallbackEl.value.trim();
                if (fb) this._cockpitConfig.homeServer.fallbackBase = fb;
            }
            const notamBaseEl = body.querySelector('#ce-notam-base');
            if (notamBaseEl) this._cockpitConfig.notamBase = notamBaseEl.value.trim().replace(/\/$/, '');

            // Collect cockpit config values
            this._collectValues('cockpit');
            this._collectValues('aircraft');

            // FlyTab: save user overrides to localStorage (bundled files are read-only).
            // Uses dedicated keys so _fetchJson's offline cache doesn't overwrite user edits.
            try {
                localStorage.setItem('flypi_user_cockpit', JSON.stringify(this._cockpitConfig));
                localStorage.setItem('flypi_user_aircraft', JSON.stringify(this._aircraftConfig));
                // Update in-memory config immediately
                if (typeof CockpitConfig !== 'undefined') {
                    CockpitConfig._config = this._cockpitConfig;
                    CockpitConfig._aircraft = this._aircraftConfig;
                }
            } catch (e) {
                throw new Error('Failed to save to local storage: ' + e.message);
            }

            if (true) {
                this._dirty = false;
                saveBtn.textContent = 'SAVED';
                saveBtn.style.background = 'var(--status-ok)';
                setTimeout(() => {
                    saveBtn.textContent = 'SAVE CONFIGURATION';
                    saveBtn.style.background = '';
                    saveBtn.disabled = false;
                }, 2000);
                if (typeof app !== 'undefined' && app.showToast) {
                    app.showToast('Configuration saved');
                }
            } else {
                throw new Error('Save failed');
            }
        } catch (err) {
            saveBtn.textContent = 'SAVE FAILED';
            saveBtn.style.background = 'var(--status-danger)';
            setTimeout(() => {
                saveBtn.textContent = 'SAVE CONFIGURATION';
                saveBtn.style.background = '';
                saveBtn.disabled = false;
            }, 2000);
        }
    }

    _collectValues(target) {
        const body = this._el.querySelector('.config-editor-body');

        if (target === 'cockpit') {
            // Collect standard section fields
            const sections = ['map', 'enginePage', 'flightRecording', 'radar', 'approachCharts', 'takeoffAlerts', 'ifr', 'logbook', 'traffic'];
            for (const section of sections) {
                if (!this._cockpitConfig[section]) this._cockpitConfig[section] = {};
                body.querySelectorAll(`[data-section="${section}"]`).forEach(el => {
                    const key = el.dataset.key;
                    const val = this._getInputValue(el);
                    this._cockpitConfig[section][key] = val;
                });
            }

            // Collect overlay fields (nested: overlays.fixes.minZoom)
            if (!this._cockpitConfig.map) this._cockpitConfig.map = {};
            if (!this._cockpitConfig.map.overlays) this._cockpitConfig.map.overlays = {};
            body.querySelectorAll('[data-section="overlays"]').forEach(el => {
                const parts = el.dataset.key.split('.');
                const layerName = parts[0];
                const prop = parts[1];
                if (!this._cockpitConfig.map.overlays[layerName]) {
                    this._cockpitConfig.map.overlays[layerName] = {};
                }
                this._cockpitConfig.map.overlays[layerName][prop] = this._getInputValue(el);
            });
        }

        if (target === 'aircraft') {
            body.querySelectorAll('[data-section="aircraft"]').forEach(el => {
                const key = el.dataset.key;
                const val = this._getInputValue(el);
                if (key === 'tail' || key === 'type') {
                    this._aircraftConfig[key] = val;
                } else {
                    if (!this._aircraftConfig.performance) this._aircraftConfig.performance = {};
                    this._aircraftConfig.performance[key] = val;
                }
            });
            // Stamp edit time for bidirectional sync
            this._aircraftConfig.updated_at = new Date().toISOString();
        }
    }

    _getInputValue(el) {
        if (el.type === 'checkbox') return el.checked;
        if (el.type === 'number') {
            const v = parseFloat(el.value);
            return isNaN(v) ? null : v;
        }
        return el.value;
    }

    _setMapControlsVisible(visible) {
        document.querySelectorAll('.leaflet-control-container')
            .forEach(c => c.style.display = visible ? '' : 'none');
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'config-editor-page';
        this._el.innerHTML = `
            <div class="config-editor-header">
                <span class="config-editor-title">Configuration</span>
                <button class="btn-close config-editor-close">✕</button>
            </div>
            <div class="ce-search-wrap">
                <input type="search" class="ce-search-input" placeholder="Search settings…" autocomplete="off">
            </div>
            <div class="config-editor-body"></div>
        `;
        wireTap(this._el.querySelector('.config-editor-close'), () => this.hide());

        // Live search — filter cards and section headers
        const searchEl = this._el.querySelector('.ce-search-input');
        searchEl.addEventListener('input', () => this._applySearch(searchEl.value));

        this._parentEl.appendChild(this._el);
    }

    async _getOrPromptPassword() {
        try {
            const stored = await Capacitor.Plugins.Sftp.getPassword();
            if (stored.password) return stored.password;
        } catch (_) {}

        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.style.cssText = [
                'position:fixed', 'inset:0', 'z-index:300000',
                'background:rgba(0,0,0,0.75)',
                'display:flex', 'align-items:center', 'justify-content:center',
                'font-family:-apple-system,system-ui,sans-serif'
            ].join(';');
            modal.innerHTML = `
                <div style="background:#1a2540;border-radius:12px;padding:24px;max-width:340px;width:90%;">
                    <div style="color:#e8ecf0;font-size:17px;font-weight:600;margin-bottom:16px;">SFTP Password</div>
                    <input type="password" id="_ce-pw" placeholder="Password" autocomplete="current-password"
                        style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
                               border:1px solid #3a4a6a;background:#0e1628;color:#e8ecf0;
                               font-size:16px;margin-bottom:12px;">
                    <label style="display:flex;align-items:center;gap:8px;color:#a0b0c8;font-size:14px;margin-bottom:20px;cursor:pointer;">
                        <input type="checkbox" id="_ce-save" checked style="width:18px;height:18px;">
                        Save password on device (encrypted)
                    </label>
                    <div style="display:flex;gap:12px;">
                        <button id="_ce-cancel" style="flex:1;padding:12px;border:none;border-radius:8px;
                                background:#2a3a5c;color:#e8ecf0;font-size:16px;cursor:pointer;touch-action:manipulation;">
                            Cancel
                        </button>
                        <button id="_ce-ok" style="flex:1;padding:12px;border:none;border-radius:8px;
                                background:#1e5caa;color:#fff;font-size:16px;font-weight:600;cursor:pointer;touch-action:manipulation;">
                            OK
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            const pwEl  = modal.querySelector('#_ce-pw');
            const saveEl = modal.querySelector('#_ce-save');
            setTimeout(() => pwEl.focus(), 100);

            const doOk = async () => {
                const pw = pwEl.value;
                if (!pw) { pwEl.focus(); return; }
                if (saveEl.checked) {
                    try { await Capacitor.Plugins.Sftp.savePassword({ password: pw }); } catch (_) {}
                }
                modal.remove();
                resolve(pw);
            };

            wireTap(modal.querySelector('#_ce-cancel'), () => { modal.remove(); resolve(null); });
            wireTap(modal.querySelector('#_ce-ok'), doOk);
            pwEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doOk(); });
        });
    }

    async _downloadAndInstall() {
        const body = this._el.querySelector('.config-editor-body');
        const btn = body.querySelector('.ce-update-btn');
        const statusEl = body.querySelector('.ce-update-status');

        // Prefer DOM values (honours unsaved edits); fall back to saved config when editor not rendered.
        const fu = this._cockpitConfig?.flightUpload || CockpitConfig._config?.flightUpload || {};
        const host      = body.querySelector('#ce-fu-host')?.value.trim()  || fu.host        || '';
        const port      = parseInt(body.querySelector('#ce-fu-port')?.value, 10) || fu.port  || 22;
        const username  = body.querySelector('#ce-fu-user')?.value.trim()  || fu.username    || '';
        const apkRemote = body.querySelector('#ce-fu-apk')?.value.trim()   || fu.apkRemotePath || '';

        if (!host || !username || !apkRemote) {
            statusEl.textContent = 'Set Host, Username, and APK Remote Path in Flight Upload (SFTP) below.';
            statusEl.style.color = 'var(--status-danger, #c0392b)';
            return;
        }

        const password = await this._getOrPromptPassword();
        if (password === null) return;

        btn.disabled = true;
        statusEl.textContent = 'Downloading…';
        statusEl.style.color = 'var(--text-secondary, #a0b8d0)';

        try {
            const result = await Capacitor.Plugins.Sftp.download({
                host,
                port,
                username,
                password,
                remoteFile: apkRemote,
            });

            if (!result.ok) {
                statusEl.textContent = `Download failed: ${result.error}`;
                statusEl.style.color = 'var(--status-danger, #c0392b)';
                btn.disabled = false;
                return;
            }

            statusEl.textContent = 'Download complete. Launching installer…';
            statusEl.style.color = '#1a8c35';
            await Capacitor.Plugins.Sftp.installApk();
            statusEl.textContent = '';
            btn.disabled = false;
        } catch (err) {
            statusEl.textContent = `Error: ${err.message}`;
            statusEl.style.color = 'var(--status-danger, #c0392b)';
            btn.disabled = false;
        }
    }

    _applySearch(query) {
        const body = this._el.querySelector('.config-editor-body');
        const q = query.trim().toLowerCase();

        // Walk top-level children: section headers and cards
        let lastHeader = null;
        let headerHasVisibleCard = false;

        Array.from(body.children).forEach(child => {
            if (child.classList.contains('ce-section-header')) {
                // Flush previous header visibility
                if (lastHeader) lastHeader.style.display = headerHasVisibleCard ? '' : 'none';
                lastHeader = child;
                headerHasVisibleCard = false;
                return;
            }
            if (child.classList.contains('ce-actions') || child.classList.contains('ce-update-bar')) {
                child.style.display = '';
                return;
            }
            // ds-card — check title + all labels
            if (!q) {
                child.style.display = '';
                headerHasVisibleCard = true;
                return;
            }
            const text = child.textContent.toLowerCase();
            const visible = text.includes(q);
            child.style.display = visible ? '' : 'none';
            if (visible) headerHasVisibleCard = true;
        });
        // Flush last header
        if (lastHeader) lastHeader.style.display = (!q || headerHasVisibleCard) ? '' : 'none';
    }

    _updateKeyStatus(hasKey) {
        const body = this._el.querySelector('.config-editor-body');
        if (!body) return;
        const statusEl = body.querySelector('#ce-fu-key-status');
        const importBtn = body.querySelector('#ce-fu-import-btn');
        const clearBtn = body.querySelector('#ce-fu-clear-btn');
        if (!statusEl) return;
        if (hasKey) {
            statusEl.textContent = 'imported ✓';
            statusEl.style.color = '#1a8c35';
            if (importBtn) importBtn.style.display = 'none';
            if (clearBtn) clearBtn.style.display = '';
        } else {
            statusEl.textContent = 'not imported';
            statusEl.style.color = 'var(--text-secondary, #a0b8d0)';
            if (importBtn) importBtn.style.display = '';
            if (clearBtn) clearBtn.style.display = 'none';
        }
    }
}
