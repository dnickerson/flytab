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
        this._buildDOM();
        if (engineClient) this._listen(engineClient);
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
        const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
        const want = norm(key);
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
        if (!this._el) return;

        for (const { rowEl, valEl, field } of this._fieldEls) {
            const raw = EngineOverlay.valueFor(data, field.key);
            const value = raw == null || raw === '' ? null : Number(raw);
            const ok = value != null && Number.isFinite(value);
            valEl.textContent = (ok ? Math.round(value) : '--') + (field.unit || '');

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
