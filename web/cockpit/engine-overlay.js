/**
 * FlyTab — Engine Overlay
 * Small floating widget on the map (top-right, under D->) showing configurable
 * engine fields from cockpit-config.json `engineOverlay.fields`. Default: carb temp.
 *
 * Fed straight from EngineClient (engine:data / engine:stale / engine:disconnect),
 * not from Stratux: engine values must keep updating with no GPS, and must blank
 * to "--" rather than keep showing an old reading when the engine monitor goes
 * quiet.
 */

class EngineOverlay {
    /**
     * Engine values the pilot can put on the map (layer panel -> Map Engine Box).
     * Keys resolve against the Pi's /api/status (see valueFor): top-level fields
     * (percent_power) and the EDM row under `data` (Carb_Temp, RPM, MP, Fuel_Flow,
     * Oil_Temp, Oil_Press, Volts, CHT1-4, EGT1-4 -- engine_monitor.py parse_line).
     * Only carb temp carries thresholds: no other engine limits exist in the
     * config, and inventing redlines here would be worse than showing none.
     */
    static CATALOG = [
        { key: 'carb_temp',     label: 'CARB TEMP', unit: '°F', warnBelow: 40, dangerBelow: 32 },
        { key: 'rpm',           label: 'RPM',       unit: '' },
        { key: 'mp',            label: 'MP',        unit: '"',    decimals: 1 },
        { key: 'fuel_flow',     label: 'FF',        unit: ' gph', decimals: 1 },
        { key: 'percent_power', label: '% PWR',     unit: '%' },
        { key: 'oil_temp',      label: 'OIL TEMP',  unit: '°F' },
        { key: 'oil_press',     label: 'OIL PRESS', unit: ' psi' },
        { key: 'cht_max',       label: 'CHT MAX',   unit: '°F' },
        { key: 'egt_max',       label: 'EGT MAX',   unit: '°F' },
        { key: 'volts',         label: 'VOLTS',     unit: 'V',    decimals: 1 },
    ];

    /** More than this many cards would cover too much of the map. */
    static MAX_FIELDS = 6;

    /** Values computed from several EDM fields; a 0 reading is an unfitted probe. */
    static DERIVED = {
        chtmax: (d) => EngineOverlay._maxOf(d, ['CHT1', 'CHT2', 'CHT3', 'CHT4']),
        egtmax: (d) => EngineOverlay._maxOf(d, ['EGT1', 'EGT2', 'EGT3', 'EGT4']),
    };

    static _maxOf(d, keys) {
        const vals = keys.map(k => Number(d[k])).filter(v => Number.isFinite(v) && v > 0);
        return vals.length ? Math.max(...vals) : null;
    }

    static _norm(s) {
        return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    }

    /** Catalog keys currently shown (from config), in catalog order. */
    static selectedKeys() {
        let fields = [];
        try { fields = (typeof CockpitConfig !== 'undefined' && CockpitConfig.get('engineOverlay.fields')) || []; } catch (_) { /* none */ }
        const on = new Set(fields.map(f => EngineOverlay._norm(f.key)));
        return EngineOverlay.CATALOG.filter(c => on.has(EngineOverlay._norm(c.key))).map(c => c.key);
    }

    /**
     * Save which catalog values to show (catalog order, at most MAX_FIELDS) and
     * tell any live overlay to rebuild. Fields added to cockpit-config.json by hand
     * that aren't in the catalog are kept, after the catalog ones.
     */
    static setSelectedKeys(keys) {
        const want = new Set((keys || []).map(EngineOverlay._norm));
        const catalogNorm = new Set(EngineOverlay.CATALOG.map(c => EngineOverlay._norm(c.key)));
        let current = [];
        try { current = CockpitConfig.get('engineOverlay.fields') || []; } catch (_) { /* none */ }
        const custom = current.filter(f => !catalogNorm.has(EngineOverlay._norm(f.key)));
        const chosen = EngineOverlay.CATALOG.filter(c => want.has(EngineOverlay._norm(c.key))).map(c => ({ ...c }));
        const fields = [...chosen, ...custom].slice(0, EngineOverlay.MAX_FIELDS);
        CockpitConfig.patch('engineOverlay.fields', fields);
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('engineoverlay:fieldschanged'));
        return fields;
    }

    /**
     * @param {HTMLElement} container
     * @param {EventTarget|null} [engineClient]  EngineClient; when given the overlay
     *        subscribes itself. update() can still be called directly.
     */
    constructor(container, engineClient = null) {
        this._container = container;
        this._el = null;
        this._fields = [];
        this._fieldEls = []; // cached { rowEl, valEl, field } per field
        this._engineClient = null;
        this._lastData = null;
        this._buildDOM();
        if (engineClient) this._listen(engineClient);
        // The layer panel's Map Engine Box picker changed the fields: rebuild in place.
        this._onFieldsChanged = () => this.rebuild();
        if (typeof window !== 'undefined') window.addEventListener('engineoverlay:fieldschanged', this._onFieldsChanged);
    }

    /** Re-read the configured fields and redraw with the last data. */
    rebuild() {
        if (this._el && this._el.parentNode) this._el.parentNode.removeChild(this._el);
        this._el = null;
        this._fields = [];
        this._fieldEls = [];
        this._buildDOM();
        this.update(this._lastData);
    }

    _buildDOM() {
        let config;
        try {
            config = typeof CockpitConfig !== 'undefined' ? CockpitConfig.get('engineOverlay') : null;
        } catch (_) { return; }
        if (!config || !config.enabled) return;

        this._fields = config.fields || [];

        this._el = document.createElement('div');
        this._el.className = 'engine-overlay';
        this._el.style.pointerEvents = 'none';

        // Position
        const pos = config.position || 'top-right';
        if (pos === 'top-right') {
            this._el.style.top = '64px';
            this._el.style.right = '8px';
        } else if (pos === 'top-left') {
            this._el.style.top = '64px';
            this._el.style.left = '8px';
        } else if (pos === 'bottom-right') {
            this._el.style.bottom = '60px';
            this._el.style.right = '8px';
        }

        // Build field elements once
        for (const field of this._fields) {
            const row = document.createElement('div');
            row.className = 'engine-overlay-field stale';

            const label = document.createElement('span');
            label.className = 'engine-overlay-label';
            label.textContent = EngineOverlay.labelFor(field);

            const val = document.createElement('span');
            val.className = 'engine-overlay-value';
            val.textContent = '--' + (field.unit || '');

            row.appendChild(label);
            row.appendChild(val);
            this._el.appendChild(row);
            this._fieldEls.push({ rowEl: row, valEl: val, field });
        }

        this._container.appendChild(this._el);
    }

    _listen(engineClient) {
        this._engineClient = engineClient;
        this._onData = (e) => this.update(EngineOverlay.flatten(e.detail));
        this._onStale = (e) => { if (e.detail?.stale) this.update(null); };
        this._onDisconnect = () => this.update(null);
        engineClient.addEventListener('engine:data', this._onData);
        engineClient.addEventListener('engine:stale', this._onStale);
        engineClient.addEventListener('engine:disconnect', this._onDisconnect);
        // Data that arrived before the overlay existed.
        if (engineClient.lastData && engineClient.connected !== false && !engineClient.stale) {
            this.update(EngineOverlay.flatten(engineClient.lastData));
        }
    }

    /** The Pi nests the EDM row under `data` (e.g. data.Carb_Temp); flatten it. */
    static flatten(raw) {
        return raw && raw.data ? { ...raw, ...raw.data } : raw;
    }

    /**
     * Value for a configured key. The Pi's EDM fields are Capitalized_With_Underscores
     * (Carb_Temp, Oil_Temp, RPM) while the config has always said carb_temp, so match
     * ignoring case and punctuation -- that mismatch is why CARB showed "--" forever.
     */
    static valueFor(data, key) {
        if (!data || !key) return null;
        if (data[key] != null) return data[key];
        const norm = EngineOverlay._norm;
        const want = norm(key);
        if (EngineOverlay.DERIVED[want]) return EngineOverlay.DERIVED[want](data);
        for (const k of Object.keys(data)) {
            if (norm(k) === want && data[k] != null) return data[k];
        }
        return null;
    }

    /**
     * Label to show. The field was first shipped labelled "CARB"; a tablet whose saved
     * config override still holds that label (CockpitConfig keeps overrides that differ
     * from the bundle) shows "CARB TEMP" too.
     */
    static labelFor(field) {
        const key = String(field.key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (key === 'carbtemp' && (!field.label || field.label === 'CARB')) return 'CARB TEMP';
        return field.label || field.key;
    }

    /**
     * Update with engine data; null (stale/disconnected) shows "--".
     * @param {Object|null} data — flattened engine data
     */
    update(data) {
        this._lastData = data;
        if (!this._el) return;

        for (const { rowEl, valEl, field } of this._fieldEls) {
            const raw = EngineOverlay.valueFor(data, field.key);
            const value = raw == null || raw === '' ? null : Number(raw);
            const ok = value != null && Number.isFinite(value);
            const shown = ok ? (field.decimals ? value.toFixed(field.decimals) : Math.round(value)) : '--';
            valEl.textContent = shown + (field.unit || '');

            let cls = 'engine-overlay-value';
            if (ok) {
                if (field.dangerBelow != null && value < field.dangerBelow) {
                    cls += ' danger';
                } else if (field.warnBelow != null && value < field.warnBelow) {
                    cls += ' caution';
                }
            }
            valEl.className = cls;
            rowEl.className = 'engine-overlay-field' + (ok ? '' : ' stale');
        }
    }

    destroy() {
        if (this._onFieldsChanged && typeof window !== 'undefined') {
            window.removeEventListener('engineoverlay:fieldschanged', this._onFieldsChanged);
        }
        if (this._engineClient) {
            this._engineClient.removeEventListener('engine:data', this._onData);
            this._engineClient.removeEventListener('engine:stale', this._onStale);
            this._engineClient.removeEventListener('engine:disconnect', this._onDisconnect);
            this._engineClient = null;
        }
        if (this._el && this._el.parentNode) {
            this._el.parentNode.removeChild(this._el);
            this._el = null;
        }
        this._fieldEls = [];
    }
}
