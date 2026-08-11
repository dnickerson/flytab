/**
 * FlyTab — Stratux WebSocket Client
 * Direct WebSocket connection to Stratux at 192.168.10.1.
 * No HTTPS proxy — Android connects directly via HTTP/WS to Stratux.
 * Auto-reconnect with exponential backoff.
 * Fires DOM events: stratux:traffic, stratux:situation, stratux:connect, stratux:disconnect,
 *   stratux:stale, stratux:fresh, stratux:weather, stratux:nexrad, stratux:fisb-frame
 *
 * Transport: prefers the native StratuxWS Capacitor plugin (OkHttp under the hood,
 * with TCP keepalive and WebSocket protocol-level pings). Falls back to the
 * browser WebSocket API when running outside Capacitor. The browser API can't
 * detect half-closed connections, which manifests in flight as readyState=OPEN
 * forever after a network glitch with no onclose firing.
 */

// One global event router for the StratuxWS plugin: a single addListener per
// event type, dispatched to the active wrapper for each channel via session id
// (so events from a closed socket can't be misrouted to its replacement).
const _StratuxNativeBus = (() => {
    const native = (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.StratuxWS)
        ? Capacitor.Plugins.StratuxWS : null;
    if (!native) return null;
    const sessions = new Map(); // channel → { id, handlers }
    const route = (type) => (ev) => {
        const s = sessions.get(ev.channel);
        if (!s || s.id !== ev.session) return;  // stale event from a replaced socket
        const h = s.handlers[type];
        if (h) h(ev);
    };
    native.addListener('open',    route('onopen'));
    native.addListener('message', route('onmessage'));
    native.addListener('close',   route('onclose'));
    native.addListener('error',   route('onerror'));
    let nextId = 1;
    return {
        attach(channel, handlers) {
            const id = String(nextId++);
            sessions.set(channel, { id, handlers });
            return id;
        },
        detach(channel, id) {
            const s = sessions.get(channel);
            if (s && s.id === id) sessions.delete(channel);
        },
        open(channel, url, session) { native.open({ channel, url, session }); },
        close(channel)              { native.close({ channel }); },
    };
})();

// One global router for the StratuxUDP plugin (GDL 90 over UDP). When this
// is available the client uses it for ownship + traffic and skips the WS
// /traffic and /situation channels entirely. FIS-B weather (/weather and
// /jsonio) keeps using the WS — GDL 90 doesn't carry pre-parsed FIS-B.
const _StratuxUdpBus = (() => {
    const native = (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.StratuxUDP)
        ? Capacitor.Plugins.StratuxUDP : null;
    if (!native) return null;
    let attached = null;
    native.addListener('situation', (ev) => { if (attached && attached.onSituation) attached.onSituation(ev); });
    native.addListener('traffic',   (ev) => { if (attached && attached.onTraffic)   attached.onTraffic(ev); });
    native.addListener('heartbeat', (ev) => { if (attached && attached.onHeartbeat) attached.onHeartbeat(ev); });
    return {
        start(port) { return native.start({ port }); },
        stop()      { return native.stop(); },
        attach(handlers) { attached = handlers; },
        detach()         { attached = null; },
    };
})();

// _createStratuxWs returns an object that mimics the surface of the browser
// WebSocket API used by this client (readyState, onopen, onmessage, onclose,
// onerror, close()), backed by the native plugin when available.
function _createStratuxWs(channel, url) {
    if (!_StratuxNativeBus) return new WebSocket(url);
    const ws = {
        url, readyState: 0,            // CONNECTING
        onopen: null, onmessage: null, onclose: null, onerror: null,
        _channel: channel, _sid: '',
        close() {
            if (this.readyState >= 2) return;
            this.readyState = 3;
            _StratuxNativeBus.detach(this._channel, this._sid);
            _StratuxNativeBus.close(this._channel);
            // Mirror the browser WebSocket: close() fires onclose. The native
            // plugin's eventual close event is filtered by session id, so this
            // is the only path that fires for client-initiated closes.
            const cb = this.onclose;
            if (cb) queueMicrotask(() => cb({ code: 1000, reason: 'client_close' }));
        },
    };
    ws._sid = _StratuxNativeBus.attach(channel, {
        onopen:    ()   => { ws.readyState = 1; if (ws.onopen)    ws.onopen({}); },
        onmessage: (ev) => { if (ws.onmessage) ws.onmessage({ data: ev.data }); },
        onclose:   (ev) => {
            if (ws.readyState === 3) return;
            ws.readyState = 3;
            _StratuxNativeBus.detach(channel, ws._sid);
            if (ws.onclose) ws.onclose({ code: ev.code, reason: ev.reason });
        },
        onerror:   (ev) => { if (ws.onerror) ws.onerror({ message: ev.message }); },
    });
    _StratuxNativeBus.open(channel, url, ws._sid);
    return ws;
}

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
        this._situationReconnectTimer = null;
        this._weatherReconnectTimer = null;
        this._jsonioReconnectTimer = null;
        this._disconnected = false;

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

    /** True when GDL 90 UDP transport is available and active. */
    get udpMode() { return !!_StratuxUdpBus && !this._simMode; }

    connect() {
        this._disconnected = false;
        // Cancel any pending reconnect timer so the external call and the timer
        // don't both call _connectTraffic() independently.
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Connecting to Stratux at ${this._wsBase} (sim=${this._simMode}, udp=${this.udpMode})`);

        // Run UDP (GDL 90) and WS (JSON) in parallel: GDL 90 is the more
        // reliable transport (no connection state, no half-closed problem),
        // but WS is the proven path. Both feed the same _handleTraffic /
        // _handleSituation, keyed by ICAO so duplicate updates are harmless.
        // If either transport fails for any reason, the other keeps the
        // cockpit alive.
        if (this.udpMode) {
            _StratuxUdpBus.attach({
                onSituation: (msg) => this._handleSituation(msg),
                onTraffic:   (msg) => this._handleTraffic(msg),
                onHeartbeat: () => {
                    if (!this._connected) {
                        if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', 'GDL 90: first heartbeat — connected');
                        this._setConnected(true);
                    }
                },
            });
            // Surface a bind failure to the diag log; WS path keeps the cockpit
            // alive in that case but the user should know UDP isn't available.
            Promise.resolve(_StratuxUdpBus.start(4000)).then(
                () => { if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', 'GDL 90 UDP listening on :4000'); },
                (e) => { if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `GDL 90 UDP start failed: ${e?.message || e}`); }
            );
        }
        this._connectTraffic();
        this._connectSituation();
        // FIS-B weather channels connect in BOTH real and sim mode. Real Stratux always
        // served these; the sim bridge (mock-stratux.py) now emits NEXRAD on /jsonio, so
        // sim mode must subscribe too or FIS-B/NEXRAD can never be exercised on the ground.
        this._connectWeather();
        this._connectJsonio();
        if (!this._simMode) {
            // HTTP status/towers polling targets the real Stratux REST API (the sim bridge
            // doesn't serve it), so keep these real-mode only.
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
        this._disconnected = true;
        if (_StratuxUdpBus) { _StratuxUdpBus.detach(); _StratuxUdpBus.stop(); }
        if (this._trafficWs) { this._trafficWs.close(); this._trafficWs = null; }
        if (this._situationWs) { this._situationWs.close(); this._situationWs = null; }
        if (this._weatherWs) { this._weatherWs.close(); this._weatherWs = null; }
        if (this._jsonioWs) { this._jsonioWs.close(); this._jsonioWs = null; }
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this._situationReconnectTimer) { clearTimeout(this._situationReconnectTimer); this._situationReconnectTimer = null; }
        if (this._weatherReconnectTimer) { clearTimeout(this._weatherReconnectTimer); this._weatherReconnectTimer = null; }
        if (this._jsonioReconnectTimer) { clearTimeout(this._jsonioReconnectTimer); this._jsonioReconnectTimer = null; }
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
        if (this._trafficWs) {
            this._trafficWs.onclose = null;
            this._trafficWs.onerror = null;
            this._trafficWs.close();
        }
        const url = this._wsUrl('/traffic');
        try {
            this._trafficWs = _createStratuxWs('traffic', url);
        } catch { this._scheduleReconnect(); return; }

        this._trafficWs.onopen = () => {
            this._reconnectDelay = 2000;
            this._setConnected(true);
            if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', 'Traffic WS connected');
        };

        this._trafficWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this._handleTraffic(msg);
            } catch { /* ignore malformed */ }
        };

        // Same stale-onclose race as situation/weather/jsonio (see _connectSituation
        // for the full explanation) — disconnect()+connect() can leave a deferred
        // onclose from the just-replaced socket to fire after a new one is live.
        const trafficWsRef = this._trafficWs;
        this._trafficWs.onclose = (e) => {
            if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Traffic WS closed, reconnecting traffic only… code=${e?.code} reason=${e?.reason || ''}`);
            if (!this._disconnected && this._trafficWs === trafficWsRef) {
                this._scheduleTrafficReconnect(trafficWsRef);
            }
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
            this._situationWs = _createStratuxWs('situation', url);
        } catch { return; }

        this._situationWs.onopen = () => {
        };

        this._situationWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this._handleSituation(msg);
            } catch { /* ignore */ }
        };

        // Capture this specific socket instance so the handler below can tell
        // "this onclose belongs to the socket that's still current" from "this
        // onclose belongs to a socket that's already been replaced" — _disconnected
        // alone can't: connect() resets it synchronously, and _createStratuxWs's
        // close() defers firing onclose via queueMicrotask, so a stale onclose from
        // a socket disconnect() already closed can fire AFTER a synchronous
        // disconnect()+connect() cycle (e.g. config-editor.js's Stratux-IP-change
        // handler) has already reset the flag and stood up a brand-new socket.
        const situationWsRef = this._situationWs;
        this._situationWs.onclose = (e) => {
            if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Situation WS closed code=${e?.code} reason=${e?.reason || ''}`);
            if (!this._disconnected && this._situationWs === situationWsRef && this._trafficWs?.readyState === WebSocket.OPEN) {
                this._situationReconnectTimer = setTimeout(() => {
                    this._situationReconnectTimer = null;
                    // Guard: don't create a duplicate if already reconnected, and never
                    // reconnect if disconnect() ran (or this socket was replaced) while
                    // this timer was pending.
                    if (!this._disconnected && this._situationWs === situationWsRef && (!this._situationWs || this._situationWs.readyState !== WebSocket.OPEN)) {
                        this._connectSituation();
                    }
                }, 2000);
            }
        };
    }

    _handleSituation(msg) {
        // Always reset stale timer first — even during GPS suppression — so a Stratux
        // power-off/restart recovers without requiring a full WebSocket connect cycle.
        const wasStale = this._stale;
        this._stale = false;
        clearTimeout(this._staleTimer);
        this._staleTimer = setTimeout(() => {
            this._stale = true;
            this.dispatchEvent(new CustomEvent('stratux:stale', { detail: { ageMs: 5000 } }));
        }, 5000);

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
            // Stratux data resumed after a stale period while still connected —
            // fire stratux:fresh so GpsSource can deactivate the GPS fallback.
            if (wasStale && this._connected) {
                if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', 'stratux:fresh — data resumed after stale while connected');
                this.dispatchEvent(new CustomEvent('stratux:fresh'));
            }
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
        if (typeof DiagLog !== 'undefined') {
            if (prevQuality === undefined) {
                DiagLog.log('stratux', `First situation: fix=${msg.GPSFixQuality} lat=${msg.GPSLatitude} lon=${msg.GPSLongitude} sats=${msg.GPSSatellites}/${msg.GPSSatellitesSeen}`);
            } else if (prevQuality !== msg.GPSFixQuality) {
                DiagLog.log('stratux', `GPS fix changed: ${prevQuality} → ${msg.GPSFixQuality} sats=${msg.GPSSatellites}`);
            }
        }
        this.dispatchEvent(new CustomEvent('stratux:situation', { detail: this.situation }));
        // stale timer already reset at top of this function
    }

    // ========== Device Status Polling ==========

    _pollStatus() {
        if (this._statusTimer) return;
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
        if (this._towerTimer) return;
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
            this._weatherWs = _createStratuxWs('weather', url);
        } catch { return; }

        this._weatherWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this.dispatchEvent(new CustomEvent('stratux:weather', { detail: msg }));
            } catch { /* ignore malformed */ }
        };

        // Capture this specific socket instance — see the matching comment in
        // _connectSituation() above. udpMode alone can't distinguish "this onclose
        // is for the current socket" from "this onclose is stale" because it's a
        // static plugin/config availability getter, not a connection-freshness
        // signal — on hardware with the native UDP plugin present, udpMode stays
        // true across a disconnect()+connect() cycle, so a flag-only gate (even
        // with !this._disconnected) still lets a stale onclose schedule a spurious
        // reconnect. The identity check closes that regardless of udpMode.
        const weatherWsRef = this._weatherWs;
        this._weatherWs.onclose = (e) => {
            if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Weather WS closed code=${e?.code} reason=${e?.reason || ''}`);
            // Reconnect after 5s if the overall Stratux connection is still alive
            // (covers both WS-mode traffic OPEN and UDP-mode where traffic flows
            // separately). !this._disconnected is required because udpMode reflects
            // static plugin/config availability, not connection lifecycle — it is
            // never falsified by disconnect(), so without this check this fires
            // unconditionally on any hardware with the native UDP plugin present.
            // The gate must wrap the setTimeout() call itself, not just the code
            // inside it — a stale onclose from a socket disconnect() already closed
            // can still fire (queueMicrotask defers it) after connect() runs, and if
            // only the callback body were gated, an unconditional setTimeout here
            // would still schedule a spurious reconnect 5s after every disconnect()+
            // connect() cycle (e.g. config-editor.js's Stratux-IP-change handler).
            if (!this._disconnected && this._weatherWs === weatherWsRef && (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN)) {
                this._weatherReconnectTimer = setTimeout(() => {
                    this._weatherReconnectTimer = null;
                    if (!this._disconnected && this._weatherWs === weatherWsRef && (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN)) {
                        this._connectWeather();
                    }
                }, 5000);
            }
        };
    }

    // ========== FIS-B JSON I/O WebSocket (/jsonio) ==========

    _connectJsonio() {
        if (this._jsonioWs) { this._jsonioWs.close(); }
        const url = this._wsUrl('/jsonio');
        try {
            this._jsonioWs = _createStratuxWs('jsonio', url);
        } catch { return; }

        this._jsonioWs.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                // /jsonio also carries Stratux's trafficUpdate/radarUpdate/situationUpdate
                // broadcasts (same connection subscribes to all four server-side) — those
                // are TrafficInfo/Settings/SituationData objects, never uatparse.Frame, so
                // they never carry a Product_id field (uatparse.Frame always sets it, even
                // to 0). Drop them here instead of misdispatching as stratux:fisb-frame.
                if (msg.Product_id === undefined) return;
                // Stratux UATFrame JSON uses field name "NEXRAD" ([]NEXRADBlock struct).
                // Discriminate by presence of NEXRAD array — covers all PIDs 51-64.
                if (msg.NEXRAD && msg.NEXRAD.length > 0) {
                    if (typeof DiagLog !== 'undefined' && !this._nexradLogged) {
                        this._nexradLogged = true;
                        DiagLog.log('stratux', `First NEXRAD block: PID=${msg.Product_id} blocks=${msg.NEXRAD.length}`);
                    }
                    this.dispatchEvent(new CustomEvent('stratux:nexrad', { detail: msg }));
                } else {
                    this.dispatchEvent(new CustomEvent('stratux:fisb-frame', { detail: msg }));
                }
            } catch { /* ignore malformed */ }
        };

        // Capture this specific socket instance — see the matching comments in
        // _connectSituation() and _connectWeather() above.
        const jsonioWsRef = this._jsonioWs;
        this._jsonioWs.onclose = (e) => {
            if (typeof DiagLog !== 'undefined') DiagLog.log('stratux', `Jsonio WS closed code=${e?.code} reason=${e?.reason || ''}`);
            // See the matching comment in _weatherWs.onclose above: the gate must
            // wrap the setTimeout() call itself, not just the code inside it, and
            // must include the identity check (not just !this._disconnected) since
            // udpMode alone can't tell a stale onclose from a current one.
            if (!this._disconnected && this._jsonioWs === jsonioWsRef && (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN)) {
                this._jsonioReconnectTimer = setTimeout(() => {
                    this._jsonioReconnectTimer = null;
                    if (!this._disconnected && this._jsonioWs === jsonioWsRef && (this.udpMode || this._trafficWs?.readyState === WebSocket.OPEN)) {
                        this._connectJsonio();
                    }
                }, 5000);
            }
        };
    }

    // ========== Reconnect ==========

    /** Reconnect only the traffic WS — don't tear down situation/weather/jsonio */
    _scheduleTrafficReconnect(trafficWsRef) {
        this._setConnected(false);
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            // Guard: never reconnect if disconnect() ran, or this socket was
            // already replaced by a fresh connect() cycle, while this timer
            // was pending — same race the identity check in _connectTraffic's
            // onclose exists for.
            if (this._disconnected || this._trafficWs !== trafficWsRef) return;
            this._connectTraffic();
            // Reconnect companion sockets only if fully closed — not if still connecting
            if (!this._situationWs || this._situationWs.readyState === WebSocket.CLOSED) {
                this._connectSituation();
            }
            if (!this._weatherWs || this._weatherWs.readyState === WebSocket.CLOSED) {
                this._connectWeather();
            }
            if (!this._jsonioWs || this._jsonioWs.readyState === WebSocket.CLOSED) {
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
