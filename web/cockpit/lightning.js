/**
 * FlyPi — Lightning Strikes Layer
 * Real-time lightning visualization using Blitzortung.org WebSocket feed.
 * Strikes rendered as canvas markers with age-based coloring (white → red → fade).
 * Strikes older than 20 minutes are removed.
 */

class LightningLayer {
    constructor() {
        this._map = null;
        this._active = false;
        this._ws = null;
        this._layer = L.layerGroup();
        this._strikes = [];          // { marker, time }
        this._cleanupTimer = null;
        this._reconnectTimer = null;
        this._renderer = L.canvas({ padding: 0.5 });

        // Config
        this._maxAge = 20 * 60 * 1000;   // 20 minutes in ms
        this._cleanupInterval = 15000;     // prune every 15s
        this._servers = [1, 5, 6, 7];
    }

    // ========== Public API ==========

    show(map) {
        if (this._active) return;
        this._map = map;
        this._active = true;
        this._layer.addTo(this._map);
        this._connect();
        this._startCleanup();
    }

    hide() {
        this._active = false;
        this._disconnect();
        this._stopCleanup();
        this._clearStrikes();
        if (this._map) {
            this._map.removeLayer(this._layer);
        }
        this._map = null;
    }

    toggle(map) {
        if (this._active) {
            this.hide();
        } else {
            this.show(map);
        }
        return this._active;
    }

    get active() { return this._active; }

    // ========== WebSocket ==========

    _connect() {
        if (this._ws) return;

        const serverId = this._servers[Math.floor(Math.random() * this._servers.length)];
        const url = `wss://ws${serverId}.blitzortung.org:3000/`;

        try {
            this._ws = new WebSocket(url);

            this._ws.onopen = () => {
                // Subscribe to real-time strikes
                this._ws.send(JSON.stringify({ time: 0 }));
                console.log('Lightning: connected to Blitzortung');
            };

            this._ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.lat != null && data.lon != null) {
                        this._addStrike(data);
                    }
                } catch { /* ignore parse errors */ }
            };

            this._ws.onclose = () => {
                this._ws = null;
                if (this._active) {
                    // Reconnect after 5 seconds
                    this._reconnectTimer = setTimeout(() => this._connect(), 5000);
                }
            };

            this._ws.onerror = () => {
                // onclose will fire after this
            };
        } catch (err) {
            console.warn('Lightning: WebSocket connection failed', err);
            if (this._active) {
                this._reconnectTimer = setTimeout(() => this._connect(), 10000);
            }
        }
    }

    _disconnect() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
        if (this._ws) {
            this._ws.onclose = null; // prevent reconnect
            this._ws.close();
            this._ws = null;
        }
    }

    // ========== Strike Rendering ==========

    _addStrike(data) {
        if (!this._map) return;

        const now = Date.now();
        const marker = L.circleMarker([data.lat, data.lon], {
            renderer: this._renderer,
            radius: 4,
            color: '#ffff00',
            fillColor: '#ffffff',
            fillOpacity: 1,
            weight: 1,
        });

        marker.addTo(this._layer);
        this._strikes.push({ marker, time: now });
    }

    _startCleanup() {
        this._cleanupTimer = setInterval(() => this._pruneOld(), this._cleanupInterval);
    }

    _stopCleanup() {
        if (this._cleanupTimer) {
            clearInterval(this._cleanupTimer);
            this._cleanupTimer = null;
        }
    }

    _pruneOld() {
        const now = Date.now();
        const cutoff = now - this._maxAge;

        // Update colors based on age, remove expired
        const remaining = [];
        for (const strike of this._strikes) {
            const age = now - strike.time;
            if (age > this._maxAge) {
                this._layer.removeLayer(strike.marker);
            } else {
                // Age-based color: white → yellow → orange → red
                const pct = age / this._maxAge;
                const color = LightningLayer._ageColor(pct);
                strike.marker.setStyle({ color, fillColor: color, fillOpacity: 1 - pct * 0.7 });
                remaining.push(strike);
            }
        }
        this._strikes = remaining;
    }

    _clearStrikes() {
        for (const strike of this._strikes) {
            this._layer.removeLayer(strike.marker);
        }
        this._strikes = [];
    }

    // ========== Helpers ==========

    /** Map age percentage (0=new, 1=old) to color */
    static _ageColor(pct) {
        if (pct < 0.25) return '#ffffff';       // white (< 5 min)
        if (pct < 0.5) return '#ffff00';        // yellow (5-10 min)
        if (pct < 0.75) return '#ff8800';       // orange (10-15 min)
        return '#ff2200';                        // red (15-20 min)
    }
}
