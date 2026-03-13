/**
 * FlyTab — Engine Monitor WebSocket Client
 * Connects to engine monitor at ws://192.168.10.1:8080/ws/engine
 * Replaces HTTP polling with real-time 1Hz WebSocket push.
 * Fires: engine:data, engine:connect, engine:disconnect
 */

class EngineClient extends EventTarget {
    constructor(ip = '192.168.10.1', port = 8082) {
        super();
        this._ws = null;
        this._ip = ip;
        this._port = port;
        this._connected = false;
        this._reconnectDelay = 2000;
        this._maxDelay = 30000;
        this._reconnectTimer = null;
        this.lastData = null;
        this._lastDataTime = 0;
    }

    get connected() { return this._connected; }
    get ip() { return this._ip; }
    get port() { return this._port; }

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
        this._setConnected(false);
    }

    _doConnect() {
        if (this._ws) {
            this._ws.close();
            this._ws = null;
        }

        const url = `ws://${this._ip}:${this._port}/`;
        try {
            this._ws = new WebSocket(url);
        } catch {
            this._scheduleReconnect();
            return;
        }

        this._ws.onopen = () => {
            this._reconnectDelay = 2000;
            this._setConnected(true);
        };

        this._ws.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                this.lastData = data;
                this._lastDataTime = Date.now();
                this.dispatchEvent(new CustomEvent('engine:data', { detail: data }));
            } catch { /* ignore malformed */ }
        };

        this._ws.onclose = () => {
            this._scheduleReconnect();
        };

        this._ws.onerror = () => { /* onclose will fire */ };
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
            this.lastData = null;
            this._lastDataTime = 0;
        }
        const event = state ? 'engine:connect' : 'engine:disconnect';
        this.dispatchEvent(new CustomEvent(event));
    }
}
