/**
 * FlyTab — Engine Monitor WebSocket Client
 * Connects to engine monitor at ws://192.168.10.1:8082/
 * Falls back to HTTP polling at :httpPort/api/status (default 8080) after 3 WS failures.
 * Periodically retries WebSocket even when in HTTP fallback mode.
 * Fires: engine:data, engine:connect, engine:disconnect, engine:stale
 */

// Mirrors _StratuxNativeBus/_createStratuxWs in stratux-client.js. Single fixed
// channel ('engine') since there's only one Pi socket. Backed by the native
// EngineWS plugin (ping-interval + synthesized 1006 close on a half-open Pi
// socket — see EngineWsPlugin.java); falls back to the browser WebSocket API
// outside Capacitor (e.g. desktop dev, or this test suite).
const _EngineNativeBus = (() => {
    const native = (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.EngineWS)
        ? Capacitor.Plugins.EngineWS : null;
    if (!native) return null;
    const sessions = new Map();
    const route = (type) => (ev) => {
        const s = sessions.get(ev.channel);
        if (!s || s.id !== ev.session) return;
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

function _createEngineWs(url) {
    if (!_EngineNativeBus) return new WebSocket(url);
    const channel = 'engine';
    const ws = {
        url, readyState: 0,
        onopen: null, onmessage: null, onclose: null, onerror: null,
        _sid: '',
        close() {
            if (this.readyState >= 2) return;
            this.readyState = 3;
            _EngineNativeBus.detach(channel, this._sid);
            _EngineNativeBus.close(channel);
            const cb = this.onclose;
            if (cb) queueMicrotask(() => cb({ code: 1000, reason: 'client_close' }));
        },
    };
    ws._sid = _EngineNativeBus.attach(channel, {
        onopen:    ()   => { ws.readyState = 1; if (ws.onopen)  ws.onopen({}); },
        onmessage: (ev) => { if (ws.onmessage) ws.onmessage({ data: ev.data }); },
        onclose:   (ev) => {
            if (ws.readyState === 3) return;
            ws.readyState = 3;
            _EngineNativeBus.detach(channel, ws._sid);
            if (ws.onclose) ws.onclose({ code: ev.code, reason: ev.reason });
        },
        onerror:   (ev) => { if (ws.onerror) ws.onerror({ message: ev.message }); },
    });
    _EngineNativeBus.open(channel, url, ws._sid);
    return ws;
}

class EngineClient extends EventTarget {
    // Minimum Pi payload-contract version this build of FlyTab requires (#113).
    // Bump alongside any code change that depends on a new/changed field name,
    // nesting, unit, or shared physical constant published by engine_monitor.py's
    // PI_API_CONTRACT. Not the app version — this is what the two sides compare.
    static MIN_PI_CONTRACT = 2;

    constructor(ip = '192.168.10.1', port = 8082, httpPort = 8080) {
        super();
        this._ws = null;
        this._ip = ip;
        this._port = port;
        this._httpPort = httpPort;
        this._connected = false;
        this._reconnectDelay = 2000;
        this._maxDelay = 30000;
        this._reconnectTimer = null;
        this._pollTimer = null;
        this._wsFailCount = 0;
        this._useHttpFallback = false;
        this._wsRetryTimer = null;      // periodic WS retry when in HTTP fallback
        this.lastData = null;
        this._lastDataTime = 0;
        this._staleTimer = null;
        this._stale = false;
    }

    get connected() { return this._connected; }
    get ip() { return this._ip; }
    get port() { return this._port; }
    /** True if connected but no data received in >5 seconds (possible Pi serial hang) */
    get stale() { return this._stale; }
    /** Milliseconds since last data, or Infinity if never received */
    get dataAge() { return this._lastDataTime ? Date.now() - this._lastDataTime : Infinity; }

    /** Pi's api_contract, or 0 if the field is missing entirely (#113) —
     *  a Pi that predates this handshake reports as contract 0, not "unknown". */
    get piContract() { return this.lastData?.api_contract ?? 0; }
    /** Pi's human-readable VERSION string, or null if not yet known. */
    get piVersion() { return this.lastData?.version ?? null; }
    /** Optional feature flags the connected Pi build supports. */
    get piCapabilities() { return this.lastData?.capabilities ?? []; }
    /** True only once we have a live reading AND it reports an old contract —
     *  never true while merely disconnected/no data yet, that is a separate,
     *  already-visible failure mode ("ENGINE MON. OFFLINE"), not a version
     *  mismatch, and the two must not be conflated on screen. */
    get piContractOld() {
        return this._connected && !!this.lastData && this.piContract < EngineClient.MIN_PI_CONTRACT;
    }

    /** Pi engine-monitor base URL built from window.engineClient.ip, or null
     *  if unavailable. window.engineClient is assigned synchronously at
     *  app.js:518, before any UI that calls this can construct — a missing
     *  ip here means something is genuinely wrong, so this returns null
     *  rather than guessing a fallback IP. Single source for what was two
     *  verbatim copies (fuel-overlay.js, engine-page.js — issue #128). */
    static baseUrl() {
        const ip = window.engineClient?.ip;
        return ip ? `http://${ip}:8080` : null;
    }

    connect() {
        this._doConnect();
    }

    disconnect() {
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
        }
        if (this._staleTimer) {
            clearInterval(this._staleTimer);
            this._staleTimer = null;
        }
        if (this._wsRetryTimer) {
            clearInterval(this._wsRetryTimer);
            this._wsRetryTimer = null;
        }
        this._setConnected(false);
    }

    _doConnect() {
        if (this._useHttpFallback) {
            this._startHttpPolling();
            return;
        }

        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }

        const url = `ws://${this._ip}:${this._port}/`;
        try {
            this._ws = _createEngineWs(url);
        } catch {
            this._scheduleReconnect();
            return;
        }

        this._ws.onopen = () => {
            this._reconnectDelay = 2000;
            this._wsFailCount = 0;
            // If we were in HTTP fallback, stop it — WS is back
            if (this._useHttpFallback) {
                this._useHttpFallback = false;
                if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
                if (this._wsRetryTimer) { clearInterval(this._wsRetryTimer); this._wsRetryTimer = null; }
            }
            this._setConnected(true);
            this._startStaleCheck();
        };

        this._ws.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                this._onData(data);
            } catch { /* ignore malformed */ }
        };

        this._ws.onclose = () => {
            this._wsFailCount++;
            if (this._wsFailCount >= 3) {
                this._useHttpFallback = true;
                this._startHttpPolling();
                // Periodically retry WebSocket (every 60s) to recover from fallback
                if (!this._wsRetryTimer) {
                    this._wsRetryTimer = setInterval(() => {
                        this._useHttpFallback = false;
                        this._wsFailCount = 0;
                        this._doConnect();
                    }, 60000);
                }
            } else {
                this._scheduleReconnect();
            }
        };

        this._ws.onerror = () => { /* onclose will fire */ };
    }

    _onData(data) {
        this.lastData = data;
        this._lastDataTime = Date.now();
        if (this._stale) {
            this._stale = false;
            this.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: false } }));
        }
        this.dispatchEvent(new CustomEvent('engine:data', { detail: data }));
    }

    _startStaleCheck() {
        if (this._staleTimer) return;
        // Check every 3 seconds if data has gone stale (no update in 5s)
        this._staleTimer = setInterval(() => {
            if (!this._connected) return;
            const age = Date.now() - this._lastDataTime;
            if (age > 5000 && !this._stale) {
                this._stale = true;
                this.dispatchEvent(new CustomEvent('engine:stale', { detail: { stale: true, ageMs: age } }));
            }
        }, 3000);
    }

    _startHttpPolling() {
        if (this._pollTimer) return;
        this._pollTimer = setInterval(() => this._pollHttp(), 2000);
        this._pollHttp();
    }

    async _pollHttp() {
        try {
            const resp = await fetch(`http://${this._ip}:${this._httpPort}/api/status`, { signal: AbortSignal.timeout(3000) });
            if (!resp.ok) throw new Error('bad status');
            const data = await resp.json();
            this._onData(data);
            this._setConnected(true);
        } catch {
            this._setConnected(false);
        }
    }

    _scheduleReconnect() {
        this._setConnected(false);
        if (this._reconnectTimer) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._doConnect();
        }, this._reconnectDelay);
        this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
    }

    _setConnected(state) {
        if (this._connected === state) return;
        this._connected = state;
        if (!state) {
            // Don't null lastData — keep last known values visible (marked stale).
            // Nulling causes all gauges to flash "---" on transient WiFi glitches.
            if (this._staleTimer) { clearInterval(this._staleTimer); this._staleTimer = null; }
            this._stale = false;
        }
        const event = state ? 'engine:connect' : 'engine:disconnect';
        this.dispatchEvent(new CustomEvent(event));
    }
}
