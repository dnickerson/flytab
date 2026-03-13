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
            this._render();
        } catch (err) {
            body.innerHTML = `<div class="ds-error">Failed to load config: ${err.message}</div>`;
        }
    }

    _render() {
        const body = this._el.querySelector('.config-editor-body');
        const sections = [];

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
            'showCdPhone': { type: 'bool', label: 'Show CD Phone' },
            'defaultCdPhone': { type: 'text', label: 'Default CD Phone' },
            'showCraft': { type: 'bool', label: 'Show CRAFT' },
        }));

        sections.push(this._renderSection('logbook', 'Logbook', this._cockpitConfig.logbook || {}, {
            'autoCreate': { type: 'bool', label: 'Auto Create' },
            'defaultConditions': { type: 'select', options: ['VFR', 'IFR'], label: 'Default Conditions' },
            'trackHobbs': { type: 'bool', label: 'Track Hobbs' },
        }));

        // Connection settings (from localStorage, not cockpit-config.json)
        sections.push(this._sectionHeader('Connection'));
        const hs = this._cockpitConfig.homeServer || {};
        sections.push(`<div class="ds-card">
            <div class="ds-card-title">Home Network</div>
            <div class="ce-fields">
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-home-tile">Tile Server</label>
                    <input type="text" id="ce-home-tile" class="ce-input" style="width:250px"
                        value="${hs.tileBase || 'http://192.168.1.77:8090/tiles'}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-home-plate">Plate Server</label>
                    <input type="text" id="ce-home-plate" class="ce-input" style="width:250px"
                        value="${hs.plateBase || 'http://192.168.1.77:8090/plates'}">
                </div>
                <div class="ce-field-row">
                    <label class="ce-label" for="ce-home-nasr">NASR Server</label>
                    <input type="text" id="ce-home-nasr" class="ce-input" style="width:250px"
                        value="${hs.nasrBase || 'http://192.168.1.77:8090/nasr'}">
                </div>
                <div class="ce-field-row" style="font-size:14px;color:var(--text-secondary)">
                    Home server URLs for downloading tiles, plates, and NASR data
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
            'dmms_factor': { type: 'number', label: 'DMMS Factor', min: 1.0, max: 2.0, step: 0.001 },
        }));

        // Save button
        sections.push(`<div class="ce-actions">
            <button class="ce-save-btn">SAVE CONFIGURATION</button>
            <button class="ce-reload-btn">RELOAD</button>
        </div>`);

        body.innerHTML = sections.join('');

        // Bind save/reload — touchstart + click for iPad
        this._wireTap(body.querySelector('.ce-save-btn'), () => this._save());
        this._wireTap(body.querySelector('.ce-reload-btn'), () => this._load());

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
            input = `<input type="text" id="${id}" data-section="${section}" data-key="${key}" value="${value ?? ''}" class="ce-input">`;
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

            // Collect home server URLs
            const tileEl = body.querySelector('#ce-home-tile');
            const plateEl = body.querySelector('#ce-home-plate');
            const nasrEl = body.querySelector('#ce-home-nasr');
            if (!this._cockpitConfig.homeServer) this._cockpitConfig.homeServer = {};
            if (tileEl) this._cockpitConfig.homeServer.tileBase = tileEl.value.trim();
            if (plateEl) this._cockpitConfig.homeServer.plateBase = plateEl.value.trim();
            if (nasrEl) this._cockpitConfig.homeServer.nasrBase = nasrEl.value.trim();

            // Collect cockpit config values
            this._collectValues('cockpit');
            this._collectValues('aircraft');

            // FlyTab: save configs to localStorage (bundled files are read-only)
            try {
                localStorage.setItem('flypi_cfg_cockpit_config_json', JSON.stringify(this._cockpitConfig));
                localStorage.setItem('flypi_cfg_aircraft_config_json', JSON.stringify(this._aircraftConfig));
                // Update in-memory config
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

                // Reload config in the running app
                if (typeof CockpitConfig !== 'undefined') {
                    await CockpitConfig.load();
                }
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
            const sections = ['map', 'enginePage', 'flightRecording', 'radar', 'approachCharts', 'takeoffAlerts', 'ifr', 'logbook'];
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

    /** Wire touchstart + click with debounce for iPad reliability */
    _wireTap(el, handler) {
        if (!el) return;
        let touchFired = false;
        el.addEventListener('touchstart', (e) => {
            e.stopPropagation();
            touchFired = true;
            handler(e);
            setTimeout(() => { touchFired = false; }, 400);
        });
        el.addEventListener('click', (e) => {
            if (!touchFired) handler(e);
        });
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
            <div class="config-editor-body"></div>
        `;
        this._wireTap(this._el.querySelector('.config-editor-close'), () => this.hide());
        this._parentEl.appendChild(this._el);
    }
}
