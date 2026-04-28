/**
 * FlyTab — Stratux WebSocket Client
 * Direct WebSocket connection to Stratux at 192.168.10.1.
 * No HTTPS proxy — Android connects directly via HTTP/WS to Stratux.
 * Auto-reconnect with exponential backoff.
 * Fires DOM events: stratux:traffic, stratux:situation, stratux:connect, stratux:disconnect,
 *   stratux:weather, stratux:nexrad, stratux:fisb-frame
 */

class StratuxClient extends EventTarget {
    constructor() {
        super();
        this._trafficWs = null;
        this._situationWs = null;
        this._weatherWs = null;
        this._jsonioWs = null;
        this._connected = false;
        this._reconnectDelay = 2000;
        this._maxDelay = 30000;
        this._reconnectTimer = null;
        this._statusTimer = null;
        this._towerTimer = null;

        // Traffic map: icao_addr → target object
        this.traffic = new Map();
        // Latest situation data
        this.situation = null;
        // Device status from /getStatus
        this.deviceStatus = null;
        // Tower data from /getTowers
        this.towerData = {};

        this._purgeInterval = null;

        // When true, _handleSituation only stores AHRS data — GPS events are not dispatched.
        // Set by GpsSource when internal (Android device) GPS is active.
        this._suppressGpsSituation = false;
        this._lastStratuxAhrs = null;

        // Stale-data detection: mirrors EngineClient pattern.
        // If no situation message arrives within 5s, mark GPS/AHRS data as stale.
        this._stale = false;
        this._staleTimer = null;
    }

    connect() {
        if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Connecting to Stratux at ${this._wsBase} (sim=${this._simMode})`);
        this._connectTraffic();
        this._connectSituation();
        if (!this._simMode) {
            this._connectWeather();
            this._connectJsonio();
            this._pollStatus();
            this._pollTowers();
        }
        this._startPurge();

        // Start the stale timer immediately so that if Stratux never connects
        // (e.g. not on the Stratux Wi-Fi network), stratux:stale fires after 5s
        // and GpsSource auto-fallback can activate device GPS.
        this._stale = false;
        clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            this._stale = true;
            this.dispatchEvent(new CustomEvent('stratux:stale', { detail: { ageMs: 5000 } }));
        }, 5000);
    }

    disconnect() {
        if (this._trafficWs) { this._trafficWs.close(); this._trafficWs = null; }
        if (this._situationWs) { this._situationWs.close(); this._situationWs = null; }
        if (this._weatherWs) { this._weatherWs.close(); this._weatherWs = null; }
        if (this._jsonioWs) { this._jsonioWs.close(); this._jsonioWs = null; }
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this._purgeInterval) { clearInterval(this._purgeInterval); this._purgeInterval = null; }
        if (this._statusTimer) { clearInterval(this._statusTimer); this._statusTimer = null; }
        if (this._towerTimer) { clearInterval(this._towerTimer); this._towerTimer = null; }
        clearTimeout(this._staleTimer);
        this._staleTimer = null;
        this._stale = false;
        this._setConnected(false);
    }

    /** Stratux IP — always direct, never location.hostname */
    get ip() {
        return Settings.stratuxIp || '192.168.10.1';
    }

    /** True when cockpit-config.json has simMode: true */
    get _simMode() {
        return !!(CockpitConfig.raw.simMode);
    }

    /** WebSocket base (host:port) — uses bridge in sim mode */
    get _wsBase() {
        if (this._simMode) {
            const cfg = CockpitConfig.raw;
            const bridgeIp   = cfg.simBridgeIp   || '10.0.2.2'; // Android emulator host
            const bridgePort = cfg.simBridgePort  || 5678;
            return `${bridgeIp}:${bridgePort}`;
        }
        return this.ip;
    }

    /**
     * WebSocket URL — direct ws:// to Stratux.
     * No HTTPS proxy needed — Android is a native app, no mixed-content restrictions.
     */
    _wsUrl(stratuxPath) {
        return `ws://${this._wsBase}${stratuxPath}`;
    }

    // ========== Traffic WebSocket ==========

    _connectTraffic() {
        if (this._trafficWs) { this._trafficWs.close(); }
        const url = this._wsUrl('/traffic');
        try {
            this._trafficWs = new WebSocket(url);
        } catch { this._scheduleReconnect(); return; }

        this._trafficWs.onopen = () => {
            this._reconnectDelay = 2000;
            this._setConnected(true);
            if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', 'Traffic WS connected');
            if (typeof TrafficDiag !== 'undefined') TrafficDiag.wsEvent('traffic_open');
        };

        this._trafficWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this._handleTraffic(msg);
            } catch { /* ignore malformed */ }
        };

        this._trafficWs.onclose = () => {
            if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', 'Traffic WS closed, reconnecting traffic only…');
            if (typeof TrafficDiag !== 'undefined') TrafficDiag.wsEvent('traffic_close');
            this._scheduleTrafficReconnect();
        };
        this._trafficWs.onerror = () => { /* onclose will fire */ };
    }

    _handleTraffic(msg) {
        const icao = msg.Icao_addr;
        if (!icao) return;

        // Filter own-ship
        const ownHex = Settings.ownshipModeS.toUpperCase();
        if (icao.toString(16).toUpperCase().padStart(6, '0') === ownHex) return;

        const target = {
            icao_addr: icao,
            hex: icao.toString(16).toUpperCase().padStart(6, '0'),
            callsign: (msg.Tail || '').trim(),
            lat: msg.Lat,
            lon: msg.Lng,
            alt: msg.Alt,
            track: msg.Track,
            speed: msg.Speed,
            vvel: msg.Vvel,
            squawk: msg.Squawk,
            on_ground: msg.OnGround,
            age: msg.Age,
            last_seen: Date.now(),
            extrapolated: msg.ExtrapolatedPosition || false,
            signal_level: msg.SignalLevel,
            target_type: msg.TargetType,
        };

        this.traffic.set(icao, target);
        this.dispatchEvent(new CustomEvent('stratux:traffic', { detail: target }));
    }

    // ========== Situation WebSocket ==========

    _connectSituation() {
        if (this._situationWs) { this._situationWs.close(); }
        const url = this._wsUrl('/situation');
        try {
            this._situationWs = new WebSocket(url);
        } catch { return; }

        this._situationWs.onopen = () => {
            if (typeof TrafficDiag !== 'undefined') TrafficDiag.wsEvent('sit_open');
        };

        this._situationWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this._handleSituation(msg);
            } catch { /* ignore */ }
        };

        this._situationWs.onclose = () => {
            if (typeof TrafficDiag !== 'undefined') TrafficDiag.wsEvent('sit_close');
            if (this._trafficWs?.readyState === WebSocket.OPEN) {
                setTimeout(() => {
                    // Guard: don't create a duplicate if already reconnected
                    if (!this._situationWs || this._situationWs.readyState !== WebSocket.OPEN) {
                        this._connectSituation();
                    }
                }, 2000);
            }
        };
    }

    _handleSituation(msg) {
        // When internal GPS is active, only extract AHRS data from Stratux —
        // do NOT overwrite situation or dispatch event (GpsSource handles that).
        if (this._suppressGpsSituation) {
            this._lastStratuxAhrs = {
                alt_baro: msg.BaroPressureAltitude,
                pitch: msg.AHRSPitch,
                roll: msg.AHRSRoll,
                g_load: msg.AHRSGLoad,
                g_load_min: msg.AHRSGLoadMin,
                g_load_max: msg.AHRSGLoadMax,
            };
            return;
        }

        const prevQuality = this.situation?.gps_fix_quality;
        this.situation = {
            lat: msg.GPSLatitude,
            lon: msg.GPSLongitude,
            alt_msl: msg.GPSAltitudeMSL,
            alt_baro: msg.BaroPressureAltitude,
            ground_speed: msg.GPSGroundSpeed,
            true_course: msg.GPSTrueCourse,
            vertical_speed: msg.GPSVerticalSpeed,
            gps_fix_quality: msg.GPSFixQuality,
            gps_sats: msg.GPSSatellites,
            gps_sats_seen: msg.GPSSatellitesSeen,
            pitch: msg.AHRSPitch,
            roll: msg.AHRSRoll,
            g_load: msg.AHRSGLoad,
            g_load_min: msg.AHRSGLoadMin,
            g_load_max: msg.AHRSGLoadMax,
            timestamp: Date.now(),
        };
        // Log first situation or fix quality changes
        if (typeof DiagLog !== 'undefined') {
            if (prevQuality === undefined) {
                DiagLog.log('stratux', `First situation: fix=${msg.GPSFixQuality} lat=${msg.GPSLatitude} lon=${msg.GPSLongitude} sats=${msg.GPSSatellites}/${msg.GPSSatellitesSeen}`);
            } else if (prevQuality !== msg.GPSFixQuality) {
                DiagLog.log('stratux', `GPS fix changed: ${prevQuality} → ${msg.GPSFixQuality} sats=${msg.GPSSatellites}`);
            }
        }
        this.dispatchEvent(new CustomEvent('stratux:situation', { detail: this.situation }));

        // Reset stale timer — data is fresh
        this._stale = false;
        clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            this._stale = true;
            this.dispatchEvent(new CustomEvent('stratux:stale', { detail: { ageMs: 5000 } }));
        }, 5000);
    }

    // ========== Device Status Polling ==========

    _pollStatus() {
        const poll = async () => {
            try {
                // Direct HTTP to Stratux — no proxy needed on Android
                const r = await fetch(`http://${this.ip}/getStatus`, { cache: 'no-store' });
                if (r.ok) this.deviceStatus = await r.json();
            } catch { /* offline */ }
        };
        poll();
        this._statusTimer = setInterval(poll, 10000);
    }

    _pollTowers() {
        const poll = async () => {
            try {
                const r = await fetch(`http://${this.ip}/getTowers`, { cache: 'no-store' });
                if (r.ok) {
                    this.towerData = await r.json();
                    this.dispatchEvent(new CustomEvent('stratux:towers', { detail: this.towerData }));
                }
            } catch { /* offline */ }
        };
        poll();
        this._towerTimer = setInterval(poll, 10000);
    }

    // ========== Weather WebSocket (/weather) ==========

    _connectWeather() {
        if (this._weatherWs) { this._weatherWs.close(); }
        const url = this._wsUrl('/weather');
        try {
            this._weatherWs = new WebSocket(url);
        } catch { return; }

        this._weatherWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this.dispatchEvent(new CustomEvent('stratux:weather', { detail: msg }));
            } catch { /* ignore malformed */ }
        };

        this._weatherWs.onclose = () => {
            // Reconnect after 5s if traffic is still alive
            setTimeout(() => {
                if (this._trafficWs?.readyState === WebSocket.OPEN) {
                    this._connectWeather();
                }
            }, 5000);
        };
    }

    // ========== FIS-B JSON I/O WebSocket (/jsonio) ==========

    _connectJsonio() {
        if (this._jsonioWs) { this._jsonioWs.close(); }
        const url = this._wsUrl('/jsonio');
        try {
            this._jsonioWs = new WebSocket(url);
        } catch { return; }

        this._jsonioWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                const pid = msg.Product_id;
                if (((pid >= 51 && pid <= 54) || pid === 63) && msg.NEXRADBlock) {
                    this.dispatchEvent(new CustomEvent('stratux:nexrad', { detail: msg }));
                } else {
                    this.dispatchEvent(new CustomEvent('stratux:fisb-frame', { detail: msg }));
                }
            } catch { /* ignore malformed */ }
        };

        this._jsonioWs.onclose = () => {
            setTimeout(() => {
                if (this._trafficWs?.readyState === WebSocket.OPEN) {
                    this._connectJsonio();
                }
            }, 5000);
        };
    }

    // ========== Reconnect ==========

    /** Reconnect only the traffic WS — don't tear down situation/weather/jsonio */
    _scheduleTrafficReconnect() {
        // Only mark disconnected if situation WS is also down
        if (!this._situationWs || this._situationWs.readyState !== WebSocket.OPEN) {
            this._setConnected(false);
        }
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._reconnectDelay = 2000;
            this._connectTraffic();
            // Reconnect other sockets only if they're also closed
            if (!this._situationWs || this._situationWs.readyState !== WebSocket.OPEN) {
                this._connectSituation();
            }
            if (!this._weatherWs || this._weatherWs.readyState !== WebSocket.OPEN) {
                this._connectWeather();
            }
            if (!this._jsonioWs || this._jsonioWs.readyState !== WebSocket.OPEN) {
                this._connectJsonio();
            }
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
    }

    _scheduleReconnect() {
        this._setConnected(false);
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._connectTraffic();
            this._connectSituation();
            this._connectWeather();
            this._connectJsonio();
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
    }

    _setConnected(state) {
        if (this._connected === state) return;
        this._connected = state;
        // Don't null situation on disconnect — the situation WS may still be
        // delivering data, and even if it isn't, the last known position is
        // more useful than nothing. The stale-data purge timer handles aging.
        // Keep the traffic purge running regardless of connected state — stopping it
        // on a WS drop causes phantom aircraft to persist until reconnect.
        const event = state ? 'stratux:connect' : 'stratux:disconnect';
        if (state) {
            // Traffic WS just connected — reset the stale timer so situation data
            // has a full 5s window to start flowing. Without this, the startup stale
            // timer could fire between traffic WS connect and the first situation
            // message (e.g. while the Pi is still booting), locking the app in
            // fallback mode even though Stratux is reachable.
            this._stale = false;
            clearTimeout(this._staleTimer);
            this._staleTimer = setTimeout(() => {
                this._stale = true;
                this.dispatchEvent(new CustomEvent('stratux:stale', { detail: { ageMs: 5000 } }));
            }, 5000);
            // Rescue situation WS if it lost the startup race
            if (!this._situationWs || this._situationWs.readyState === WebSocket.CLOSED) {
                this._connectSituation();
            }
        }
        this.dispatchEvent(new CustomEvent(event));
    }

    get connected() { return this._connected; }
    get stale() { return this._stale; }

    // ========== Traffic Purge ==========

    _startPurge() {
        if (this._purgeInterval) return;
        this._purgeInterval = setInterval(() => {
            const now = Date.now();
            for (const [icao, target] of this.traffic) {
                if (now - target.last_seen > 60000) {
                    this.traffic.delete(icao);
                }
            }
        }, 5000);
    }
}
