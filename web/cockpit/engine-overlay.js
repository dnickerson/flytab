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
     *
     * The catalog -- not the saved config -- decides how a catalog value looks
     * (label, unit, decimals, color rule): saved settings only say WHICH values
     * are on, so a rule change here reaches tablets whose saved config still
     * carries older labels or thresholds. `level` names a shared EngineLimits
     * rule so the map and the ENG page color the same reading the same way;
     * only carb temp has one so far.
     */
    static CATALOG = [
        { key: 'carb_temp',     label: 'CARB TEMP', unit: '°F', level: 'carbTemp' },
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

    /**
     * How to show a configured field: its catalog entry when it is a catalog value
     * (whatever label/thresholds the saved config holds -- e.g. the first release's
     * "CARB" with warnBelow 40), else the field as configured (a value added to
     * cockpit-config.json by hand, which may set its own warnBelow/dangerBelow).
     */
    static resolveField(field) {
        const want = EngineOverlay._norm(field?.key);
        const entry = EngineOverlay.CATALOG.find(c => EngineOverlay._norm(c.key) === want);
        return entry ? { ...entry } : { ...field };
    }

    /** 'danger' | 'caution' | 'normal' for a value of a resolved field. */
    static levelFor(field, value) {
        if (field.level === 'carbTemp' && typeof EngineLimits !== 'undefined') {
            return EngineLimits.carbTempLevel(value);
        }
        if (field.dangerBelow != null && value < field.dangerBelow) return 'danger';
        if (field.warnBelow != null && value < field.warnBelow) return 'caution';
        return 'normal';
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
        // Only which values are on is saved; how they look comes from the catalog.
        const chosen = EngineOverlay.CATALOG.filter(c => want.has(EngineOverlay._norm(c.key)))
            .map(c => ({ key: c.key, label: c.label, unit: c.unit }));
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

        this._fields = (config.fields || []).filter(f => f && f.key).map(EngineOverlay.resolveField);

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
            label.textContent = field.label || field.key;

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

            const level = ok ? EngineOverlay.levelFor(field, value) : 'normal';
            valEl.className = 'engine-overlay-value' + (level === 'normal' ? '' : ' ' + level);
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
