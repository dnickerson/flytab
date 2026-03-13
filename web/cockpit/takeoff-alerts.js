/**
 * FlyPi — Takeoff Alerts
 * Displays DMMS speed reference and emergency procedure reminders
 * during departure phase of flight.
 */

class TakeoffAlerts {
    constructor(container) {
        this._container = container;
        this._departureElevFt = 0;
        this._rotationDetected = false;
        this._dismissed = false;

        // Config
        this._showDmms = CockpitConfig.get('takeoffAlerts.showDmms') !== false;
        this._dmmsDisplayUntilAglFt = CockpitConfig.get('takeoffAlerts.dmmsDisplayUntilAglFt') || 1000;
        this._dmmsFlash = CockpitConfig.get('takeoffAlerts.dmmsFlashWhenBelow') !== false;
        this._lowAltMsgs = CockpitConfig.get('takeoffAlerts.lowAltitudeMessages') || [];
        this._dmmsKt = CockpitConfig.dmmsKt;

        // Build DOM elements (hidden initially)
        this._dmmsEl = this._buildDmmsOverlay();
        this._bannerEl = this._buildBanner();

        this._container.appendChild(this._dmmsEl);
        this._container.appendChild(this._bannerEl);

        // Flash animation via CSS class toggle
        this._flashInterval = null;
    }

    // ========== Public API ==========

    /**
     * Called each GPS/situation update.
     * @param {number} altMsl - GPS altitude MSL in feet
     * @param {number} speedKt - ground speed in knots
     * @param {number} departureElevFt - departure airport field elevation
     * @param {string} flightPhase - 'preflight'|'taxi'|'departure'|'enroute'|'arrival'|'landed'
     */
    update(altMsl, speedKt, departureElevFt, flightPhase) {
        if (departureElevFt != null) {
            this._departureElevFt = departureElevFt;
        }

        const agl = (altMsl || 0) - this._departureElevFt;
        const speed = speedKt || 0;

        // Detect rotation (speed above 40 kt indicates takeoff roll)
        if (speed > 40 && !this._rotationDetected) {
            this._rotationDetected = true;
        }

        // Reset rotation detection when back on ground
        if (speed < 10 && agl < 50) {
            this._rotationDetected = false;
            this._dismissed = false;
        }

        // DMMS display
        this._updateDmms(agl, speed);

        // Low altitude messages
        this._updateBanner(agl, speed, flightPhase);
    }

    /**
     * Set departure airport field elevation.
     */
    setDepartureElevation(elevFt) {
        this._departureElevFt = elevFt || 0;
    }

    /**
     * Force hide all alerts.
     */
    hide() {
        this._dismissed = true;
        this._dmmsEl.style.display = 'none';
        this._bannerEl.style.display = 'none';
        this._stopFlash();
    }

    // ========== DMMS Display ==========

    _updateDmms(agl, speed) {
        if (!this._showDmms || this._dismissed) {
            this._dmmsEl.style.display = 'none';
            return;
        }

        // Show DMMS during departure when below threshold altitude
        const shouldShow = this._rotationDetected &&
            (agl < this._dmmsDisplayUntilAglFt || speed <= this._dmmsKt + 10);

        // Auto-dismiss: above altitude AND speed is well above DMMS
        if (this._rotationDetected && agl >= this._dmmsDisplayUntilAglFt && speed > this._dmmsKt + 10) {
            this._dmmsEl.style.display = 'none';
            this._stopFlash();
            return;
        }

        if (!shouldShow) {
            this._dmmsEl.style.display = 'none';
            this._stopFlash();
            return;
        }

        this._dmmsEl.style.display = '';

        // Update speed comparison
        const speedText = this._dmmsEl.querySelector('.dmms-speed');
        const dmmsValue = this._dmmsEl.querySelector('.dmms-value');
        dmmsValue.textContent = `DMMS: ${this._dmmsKt} kt`;

        if (speed > 0) {
            speedText.textContent = `${Math.round(speed)} kt`;
        } else {
            speedText.textContent = '';
        }

        // Color coding
        const belowDmms = this._rotationDetected && speed < this._dmmsKt;

        if (belowDmms) {
            this._dmmsEl.style.background = 'rgba(255, 0, 0, 0.85)';
            this._dmmsEl.style.borderColor = '#ff4444';
            dmmsValue.style.color = '#ffffff';
            speedText.style.color = '#ffffff';
            if (this._dmmsFlash) this._startFlash();
        } else {
            this._dmmsEl.style.background = 'rgba(0, 180, 0, 0.85)';
            this._dmmsEl.style.borderColor = '#00cc00';
            dmmsValue.style.color = '#ffffff';
            speedText.style.color = '#ffffff';
            this._stopFlash();
        }
    }

    _startFlash() {
        if (this._flashInterval) return;
        this._flashInterval = setInterval(() => {
            this._dmmsEl.style.opacity = this._dmmsEl.style.opacity === '0.3' ? '1' : '0.3';
        }, 400);
    }

    _stopFlash() {
        if (this._flashInterval) {
            clearInterval(this._flashInterval);
            this._flashInterval = null;
        }
        this._dmmsEl.style.opacity = '1';
    }

    // ========== Low Altitude Banner ==========

    _updateBanner(agl, speed, flightPhase) {
        if (this._dismissed || this._lowAltMsgs.length === 0) {
            this._bannerEl.style.display = 'none';
            return;
        }

        // Find the first matching message (most restrictive altitude first)
        let activeMsg = null;
        for (const msg of this._lowAltMsgs) {
            // Check phase if specified
            if (msg.phase && flightPhase && msg.phase !== flightPhase) continue;

            // Only show after rotation
            if (!this._rotationDetected) continue;

            if (agl < msg.belowAglFt) {
                activeMsg = msg;
                break;
            }
        }

        if (!activeMsg) {
            this._bannerEl.style.display = 'none';
            return;
        }

        this._bannerEl.style.display = '';
        this._bannerEl.textContent = activeMsg.message;
        this._bannerEl.style.color = activeMsg.color || '#ffcc00';
        this._bannerEl.style.background = activeMsg.background || '#000000';
        this._bannerEl.style.fontSize = activeMsg.fontSize || '24pt';
    }

    // ========== DOM Construction ==========

    _buildDmmsOverlay() {
        const el = document.createElement('div');
        el.className = 'takeoff-dmms-overlay';
        el.innerHTML = `
            <div class="dmms-value">DMMS: ${this._dmmsKt} kt</div>
            <div class="dmms-speed"></div>
        `;

        Object.assign(el.style, {
            position: 'absolute',
            bottom: '80px',
            right: '12px',
            zIndex: '1001',
            background: 'rgba(13, 17, 23, 0.9)',
            border: '2px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            padding: '8px 14px',
            color: '#ffffff',
            fontFamily: '"JetBrains Mono", "SF Mono", monospace',
            fontSize: '16px',
            fontWeight: 'bold',
            textAlign: 'center',
            pointerEvents: 'none',
            display: 'none',
            transition: 'background 0.2s',
        });

        const dmmsValue = el.querySelector('.dmms-value');
        Object.assign(dmmsValue.style, {
            color: '#ffffff',
            fontSize: '16px',
        });

        const speedText = el.querySelector('.dmms-speed');
        Object.assign(speedText.style, {
            color: '#ffffff',
            fontSize: '20px',
            marginTop: '2px',
        });

        return el;
    }

    _buildBanner() {
        const el = document.createElement('div');
        el.className = 'takeoff-alert-banner';

        Object.assign(el.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            right: '0',
            zIndex: '1002',
            textAlign: 'center',
            fontFamily: '"JetBrains Mono", "SF Mono", monospace',
            fontWeight: 'bold',
            letterSpacing: '2px',
            padding: '10px 16px',
            pointerEvents: 'none',
            display: 'none',
            // Defaults overridden per-message
            color: '#ffcc00',
            background: '#000000',
            fontSize: '24pt',
        });

        return el;
    }
}
