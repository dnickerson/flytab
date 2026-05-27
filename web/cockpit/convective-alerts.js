/**
 * FlyTab — Convective Alert Panel
 * Displays route alerts from ConvectiveIntelligenceEngine.
 * Positioned above the map, dismissable, color-coded by level.
 *
 * EXPERIMENTAL — NOT FOR NAVIGATION.
 */

class ConvectiveAlerts {
    constructor() {
        this._el      = null;
        this._list    = null;
        this._active  = false;
        this._lastLevel = 0;
        this._buildDOM();
    }

    _buildDOM() {
        this._el = document.createElement('div');
        this._el.className = 'conv-alerts-panel';
        Object.assign(this._el.style, {
            position:    'absolute',
            top:         '56px',
            left:        '50%',
            transform:   'translateX(-50%)',
            zIndex:      '950',
            minWidth:    '320px',
            maxWidth:    '520px',
            display:     'none',
            pointerEvents: 'auto',
        });
        this._list = document.createElement('div');
        this._list.className = 'conv-alerts-list';
        this._el.appendChild(this._list);
    }

    /**
     * Mount panel into the map container.
     * @param {HTMLElement} mapContainer
     */
    mount(mapContainer) {
        if (!this._el.parentNode) mapContainer.appendChild(this._el);
    }

    /**
     * Update displayed alerts.
     * @param {Array<{level,message,voice,minutesToBoundary?}>} alerts
     * @param {{ outflowBoundary?,convergenceBoundary?,rapidWarming? }|null} oatSignals
     */
    showAlerts(alerts, oatSignals) {
        if (!this._active) return;

        const allAlerts = [...alerts];
        if (oatSignals?.outflowBoundary) {
            allAlerts.push({ level: 3, message: 'OAT DROP — POSSIBLE STORM OUTFLOW — EVALUATE IMMEDIATELY', voice: true });
        }
        if (oatSignals?.convergenceBoundary) {
            allAlerts.push({ level: 2, message: 'Wind shear signature — possible convective trigger zone', voice: false });
        }
        if (oatSignals?.rapidWarming) {
            allAlerts.push({ level: 1, message: 'Approaching heating maximum — monitor for convective development', voice: false });
        }

        if (allAlerts.length === 0) {
            this._el.style.display = 'none';
            this._lastLevel = 0;
            return;
        }

        this._el.style.display = '';
        this._list.innerHTML = '';

        const COLORS = { 4: '#FF0000', 3: '#FF4400', 2: '#FF8800', 1: '#FFBB00' };

        for (const alert of allAlerts) {
            const row = document.createElement('div');
            const color = COLORS[alert.level] || '#FFBB00';
            Object.assign(row.style, {
                background:   'rgba(0,0,0,0.82)',
                border:       `1px solid ${color}`,
                borderRadius: '5px',
                padding:      '8px 12px',
                marginBottom: '4px',
                color,
                fontSize:     '13px',
                fontWeight:   '700',
                fontFamily:   '"JetBrains Mono", monospace',
            });
            row.textContent = alert.message;
            if (alert.minutesToBoundary != null) {
                const sub = document.createElement('div');
                Object.assign(sub.style, { fontSize: '11px', fontWeight: '400', marginTop: '2px', color: '#ccc' });
                sub.textContent = `${alert.minutesToBoundary} min to boundary`;
                row.appendChild(sub);
            }
            this._list.appendChild(row);

            if (alert.voice && alert.level >= 3 && alert.level > this._lastLevel) {
                this._speak(alert.message);
            }
        }

        this._lastLevel = allAlerts.reduce((max, a) => Math.max(max, a.level ?? 0), 0);
    }

    setActive(on) {
        this._active = on;
        if (!on) { this._el.style.display = 'none'; this._lastLevel = 0; }
    }

    _speak(text) {
        if (!('speechSynthesis' in window)) return;
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(text);
        utt.rate  = 0.85;
        utt.pitch = 1.0;
        window.speechSynthesis.speak(utt);
    }
}
