/**
 * FlyTab — Engine Overlay
 * Small floating widget on the map showing configurable engine fields.
 * Default: just carb temp. Reads from EnginePanel.lastData.
 */

class EngineOverlay {
    constructor(container) {
        this._container = container;
        this._el = null;
        this._fields = [];
        this._fieldEls = []; // cached { valEl, field } per field
        this._buildDOM();
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
            row.className = 'engine-overlay-field';

            const label = document.createElement('span');
            label.className = 'engine-overlay-label';
            label.textContent = field.label;

            const val = document.createElement('span');
            val.className = 'engine-overlay-value';
            val.textContent = '--' + (field.unit || '');

            row.appendChild(label);
            row.appendChild(val);
            this._el.appendChild(row);
            this._fieldEls.push({ valEl: val, field });
        }

        this._container.appendChild(this._el);
    }

    /**
     * Update with engine data.
     * @param {Object|null} data — engine data from EnginePanel.lastData
     */
    update(data) {
        if (!this._el) return;

        for (const { valEl, field } of this._fieldEls) {
            const value = data ? data[field.key] : null;
            const displayVal = value != null ? Math.round(value) : '--';
            const unit = field.unit || '';
            valEl.textContent = displayVal + unit;

            let cls = 'engine-overlay-value';
            if (value != null) {
                if (field.dangerBelow != null && value < field.dangerBelow) {
                    cls += ' danger';
                } else if (field.warnBelow != null && value < field.warnBelow) {
                    cls += ' caution';
                }
            }
            valEl.className = cls;
        }
    }

    destroy() {
        if (this._el && this._el.parentNode) {
            this._el.parentNode.removeChild(this._el);
            this._el = null;
        }
        this._fieldEls = [];
    }
}
