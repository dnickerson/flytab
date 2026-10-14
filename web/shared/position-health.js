/**
 * FlyTab — Position health: is own-ship trustworthy, and if not, why?
 *
 * 2026-10-13: own-ship faded in and out for a whole flight. The cause
 * (ExpressVPN breaking every Stratux connection every ~47 s) took ADB,
 * dumpsys and a log export to find. This puts the same reasoning in the
 * cockpit, in plain words, from data FlyTab already has:
 *
 *   own-ship   live / held (n s left) / hidden          CockpitMap.ownshipState
 *   cause      one of CAUSES, checked link by link:
 *                VPN up                                  VpnStatus (native plugin)
 *                Stratux data flowing but no GPS fix     StratuxClient + GpsFix
 *                no Stratux data, engine monitor feeding EngineGpsBridge.active
 *                no Stratux data AND no engine data   -> the tablet's Wi-Fi
 *                no Stratux data, engine data fine    -> at the Stratux
 *                no Stratux data, engine state unknown -> no blame
 *   restart    Stratux uptime went backwards            StratuxClient.deviceStatus.Uptime
 *   history    one record per problem episode, kept in localStorage
 *
 * The tablet has no GPS; Stratux (or the engine monitor relaying it) is the
 * only position source, so these are the only causes there are.
 *
 * Fires 'change' on an EventTarget each tick. No DOM.
 */
class PositionHealthMonitor extends EventTarget {
    /**
     * @param {object} deps
     *   stratux  StratuxClient (EventTarget: .connected .stale .situation .deviceStatus)
     *   engine   EngineClient  (.stale)
     *   bridge   EngineGpsBridge (.active) — optional
     *   gpsSource GpsSource (.source, ._configuredSource) — optional
     *   map      CockpitMap (.ownshipState) — optional until the map exists
     *   vpn      VpnStatus (query()) — optional (browser has no plugin)
     *   storage  localStorage-like — optional
     *   now      () => ms — injectable clock
     */
    constructor(deps) {
        super();
        this._d = deps;
        this._now = deps.now || (() => Date.now());
        this._storage = deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);

        this._hadFix = false;          // own-ship was live at least once this session
        this._engineSeen = false;      // engine monitor connected at least once this session
        this._feedLostAt = null;       // when Stratux data stopped (stale/disconnect)
        this._lastLinkError = null;    // { channel, message, at } from stratux:link-error
        this._vpnActive = null;        // true / false / null (couldn't check)
        this._lastVpnCheckAt = 0;
        this._prevUptimeMs = null;
        this._stratuxRestartAt = null;

        this._episode = null;          // current problem: { id, start, code, text, error }
        this._nextEpisodeId = 1;
        this._lastEnded = null;        // most recently ended episode (for "restored")
        this._history = this._loadHistory();

        this._state = this._compute();
        this._timer = null;
        this._listeners = [];
    }

    // ---------- lifecycle ----------

    start() {
        const s = this._d.stratux;
        const on = (target, type, fn) => { target?.addEventListener?.(type, fn); this._listeners.push([target, type, fn]); };
        const lost = () => { if (this._feedLostAt == null) this._feedLostAt = this._lossStart(); this.tick(); };
        on(s, 'stratux:stale', lost);
        on(s, 'stratux:disconnect', lost);
        // Recovery is the first situation after a loss: evaluate right away so the
        // banner clears and the episode's duration is exact, not a tick late.
        on(s, 'stratux:situation', () => {
            if (this._feedLostAt != null && this._stratuxFlowing(this._now())) { this._feedLostAt = null; this.tick(); }
        });
        if (typeof window !== 'undefined') {
            on(window, 'stratux:link-error', (e) => {
                this._lastLinkError = { channel: e.detail?.channel, message: e.detail?.message, at: this._now() };
            });
        }
        this._timer = setInterval(() => this.tick(), PositionHealthMonitor.TICK_MS);
        this.tick();
    }

    stop() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        for (const [t, type, fn] of this._listeners) t?.removeEventListener?.(type, fn);
        this._listeners = [];
    }

    /**
     * Attach sources created later in app startup (the engine monitor and its GPS
     * bridge come up after the map). The monitor runs without them meanwhile:
     * engine state reads "unknown", never "lost".
     */
    setSources({ engine, bridge, map, gpsSource } = {}) {
        if (gpsSource) this._d.gpsSource = gpsSource;
        if (engine) this._d.engine = engine;
        if (bridge) this._d.bridge = bridge;
        if (map) this._d.map = map;
    }

    get state() { return this._state; }
    get history() { return this._history.slice(); }

    // ---------- the 1 Hz evaluation ----------

    tick() {
        const now = this._now();
        this._checkRestart(now);
        if (this._d.vpn && now - this._lastVpnCheckAt >= PositionHealthMonitor.VPN_CHECK_MS) {
            this._lastVpnCheckAt = now;
            this._checkVpn();               // async; result lands on a later tick
        }
        const s = this._d.stratux;
        if (s && this._stratuxFlowing(now)) this._feedLostAt = null;
        else if (s && this._feedLostAt == null) this._feedLostAt = this._lossStart();

        const st = this._compute();
        this._trackEpisode(st, now);
        st.episodeId = this._episode?.id ?? null;
        st.lastEnded = this._lastEnded;
        this._state = st;
        // Only tell listeners when something they show changed (not every second).
        const { at, ...shown } = st;
        const key = JSON.stringify(shown);
        if (key !== this._lastKey) {
            this._lastKey = key;
            this.dispatchEvent(new CustomEvent('change', { detail: st }));
        }
        return st;
    }

    /**
     * Is Stratux position data actually arriving? Not just "not stale":
     * StratuxClient._setConnected(true) clears stale as soon as the TRAFFIC socket
     * opens, before any situation, leaving the old fix in .situation. So require
     * a Stratux situation (not the engine bridge's or the device's) stamped
     * within SITUATION_FRESH_MS.
     */
    _stratuxFlowing(now) {
        const s = this._d.stratux;
        if (!s || s.stale || s.connected === false) return false;
        const sit = s.situation;
        return !!sit && !sit._source && typeof sit.timestamp === 'number'
            && now - sit.timestamp < PositionHealthMonitor.SITUATION_FRESH_MS;
    }

    /**
     * When the data actually stopped: StratuxClient.lastDataAt (stale only fires
     * STALE_MS later, so counting from detection would read ~5 s short).
     */
    _lossStart() {
        const now = this._now();
        const last = this._d.stratux?.lastDataAt;
        return (typeof last === 'number' && last > 0 && last <= now) ? last : now;
    }

    async _checkVpn() {
        try {
            const r = await this._d.vpn.query(PositionHealthMonitor.VPN_PROBE_APP);
            this._vpnActive = r ? !!r.vpnActive : null;
        } catch { this._vpnActive = null; }
    }

    /** Stratux's Uptime (ms since its software started) going backwards = it restarted. */
    _checkRestart(now) {
        const up = this._d.stratux?.deviceStatus?.Uptime;
        if (typeof up !== 'number' || !Number.isFinite(up)) return;
        if (this._prevUptimeMs != null && up + PositionHealthMonitor.UPTIME_SLACK_MS < this._prevUptimeMs) {
            this._stratuxRestartAt = now - up;
            if (typeof DiagLog !== 'undefined') DiagLog.log('position', `Stratux restarted (uptime ${Math.round(this._prevUptimeMs / 1000)} s -> ${Math.round(up / 1000)} s) — power interruption?`);
        }
        this._prevUptimeMs = up;
    }

    _compute() {
        const now = this._now();
        const s = this._d.stratux;
        const own = this._d.map?.ownshipState ?? { state: 'none', holdRemainingMs: 0 };
        if (own.state === 'live') this._hadFix = true;

        const flowing = this._stratuxFlowing(now);
        const sit = s?.situation;
        const hasFix = typeof GpsFix !== 'undefined' ? GpsFix.has3DFix(sit) : (sit?.gps_fix_quality ?? 0) >= 1;
        // EngineClient resets stale to false when it DISCONNECTS, so stale alone
        // can't mean "OK": the link must also be up.
        // Unknown until the engine monitor has connected at least once this session
        // (Pi off or still booting is not "lost" -- don't blame the tablet for it).
        const eng = this._d.engine;
        if (eng?.connected === true) this._engineSeen = true;
        const engineOk = (eng && this._engineSeen) ? (eng.connected === true && eng.stale === false) : null;
        const gsrc = this._d.gpsSource;
        const deviceGps = gsrc?.source === 'internal';
        // A device fix actually being drawn -- auto-mode fallback starts as soon as
        // Stratux goes stale, whether or not the tablet ever gets a position.
        const deviceFix = deviceGps && sit?._source === 'internal'
            && (typeof GpsFix !== 'undefined' ? GpsFix.has3DFix(sit) : true);
        const bridge = this._d.bridge?.active === true;
        const lostS = this._feedLostAt != null ? Math.max(0, Math.round((now - this._feedLostAt) / 1000)) : 0;
        const dev = s?.deviceStatus;

        let code, text;
        if (this._vpnActive === true) {
            code = 'vpn'; text = 'A VPN is on — it disrupts the Stratux link. Turn it off.';
        } else if (deviceGps && gsrc._configuredSource === 'internal') {
            if (deviceFix) { code = 'ok'; text = "Position from the tablet's own GPS (GPS source set to Internal)"; }
            else { code = 'gps-nofix'; text = "Tablet's own GPS has no fix (GPS source set to Internal)"; }
        } else if (deviceFix && own.state === 'live') {
            code = 'device-gps'; text = "No data from Stratux — position from the tablet's own GPS";
        } else if (flowing && !hasFix) {
            const sats = sit?.gps_sats ?? dev?.GPS_satellites_locked;
            const dr = sit?.gps_fix_quality === 6;
            code = 'gps-nofix';
            text = dr ? 'Stratux GPS is dead reckoning — no real fix'
                : `Stratux GPS has no fix${sats != null ? ` (${sats} satellites)` : ''}`;
        } else if (!flowing && bridge) {
            code = 'engine-gps'; text = 'No data from Stratux — position from the engine monitor';
        } else if (!flowing && engineOk === false) {
            code = 'link-tablet'; text = `No data from Stratux or the engine monitor for ${lostS} s — tablet Wi-Fi problem`;
        } else if (!flowing && engineOk === true) {
            code = 'link-stratux'; text = `No data from Stratux for ${lostS} s — engine monitor still connected: problem at the Stratux`;
        } else if (!flowing) {
            // Engine monitor state unknown (not up yet): don't guess which side failed.
            code = 'link'; text = `No data from Stratux for ${lostS} s`;
        } else {
            code = 'ok'; text = 'Position from Stratux GPS';
        }

        const restartRecent = this._stratuxRestartAt != null && now - this._stratuxRestartAt < PositionHealthMonitor.RESTART_NOTE_MS;
        return {
            ownship: own.state,                       // 'live' | 'held' | 'hidden' | 'none'
            holdRemainingS: Math.ceil((own.holdRemainingMs || 0) / 1000),
            hadFix: this._hadFix,
            cause: { code, text },
            severity: code === 'ok' ? 'ok' : (code === 'vpn' || own.state === 'hidden') ? 'danger' : 'caution',
            stratux: {
                flowing, lostS, hasFix,
                solution: dev?.GPS_solution ?? null,
                sats: sit?.gps_sats ?? dev?.GPS_satellites_locked ?? null,
                accuracyM: dev?.GPS_position_accuracy ?? null,
                uptimeS: typeof dev?.Uptime === 'number' ? Math.round(dev.Uptime / 1000) : null,
                restartAt: this._stratuxRestartAt,
                restartRecent,
            },
            link: { lastError: this._lastLinkError },
            engine: { ok: engineOk, bridgeActive: bridge },
            vpn: { active: this._vpnActive },
            at: now,
        };
    }

    // ---------- episodes (dropout history) ----------

    _trackEpisode(st, now) {
        // Before the first fix this session, "no data" is just startup (Stratux
        // booting, tablet joining its Wi-Fi), not a dropout. A VPN always counts.
        // An episode STARTS only after the first fix this session (or for a VPN):
        // before that, "no data" is just startup. Once open it lasts until the
        // cause is clear -- a VPN switched off while the link is still down is
        // not "restored".
        const bad = st.cause.code !== 'ok';
        const problem = this._episode ? bad : bad && (st.hadFix || st.cause.code === 'vpn');
        if (problem && !this._episode) {
            const linkCause = st.cause.code.startsWith('link') || st.cause.code === 'engine-gps' || st.cause.code === 'device-gps';
            const start = linkCause && this._feedLostAt != null ? this._feedLostAt : now;
            this._episode = { id: this._nextEpisodeId++, start, code: st.cause.code, text: st.cause.text, error: null };
            if (typeof DiagLog !== 'undefined') DiagLog.log('position', `Problem: ${st.cause.text}`);
        } else if (problem && this._episode && st.cause.code === 'vpn' && this._episode.code !== 'vpn') {
            // The episode keeps its ROOT cause (the first one seen); a VPN found
            // later is the root cause of the link loss, so it takes over.
            this._episode.code = 'vpn';
            this._episode.text = st.cause.text;
        }
        if (this._episode && this._lastLinkError && this._lastLinkError.at >= this._episode.start - 2000) {
            this._episode.error = this._lastLinkError.message;
        }
        if (!problem && this._episode) {
            const ep = { ...this._episode, end: now, durationS: Math.round((now - this._episode.start) / 1000) };
            this._episode = null;
            this._lastEnded = ep;
            this._history.unshift({ start: ep.start, end: ep.end, durationS: ep.durationS, code: ep.code, text: ep.text, error: ep.error });
            this._history.length = Math.min(this._history.length, PositionHealthMonitor.HISTORY_MAX);
            this._saveHistory();
            if (typeof DiagLog !== 'undefined') DiagLog.log('position', `Restored after ${ep.durationS} s (${ep.code})${ep.error ? ` — ${ep.error}` : ''}`);
        }
    }

    _loadHistory() {
        try { return JSON.parse(this._storage?.getItem(PositionHealthMonitor.STORAGE_KEY) || '[]') || []; }
        catch { return []; }
    }

    _saveHistory() {
        try { this._storage?.setItem(PositionHealthMonitor.STORAGE_KEY, JSON.stringify(this._history)); }
        catch { /* quota */ }
    }
}

PositionHealthMonitor.TICK_MS = 1000;
// Stratux sends situation at 10 Hz (WS) and ownship at 1 Hz (GDL 90); matches
// StratuxClient.DATA_FRESH_MS.
PositionHealthMonitor.SITUATION_FRESH_MS = 3000;
PositionHealthMonitor.VPN_CHECK_MS = 5000;
// Any allowed package works: vpnActive is about the whole device.
PositionHealthMonitor.VPN_PROBE_APP = 'com.expressvpn.vpn';
// Stratux's Uptime is monotonic, so any drop means a restart, and a real one drops
// it by minutes. The margin is only defensive (a re-delivered older poll response).
PositionHealthMonitor.UPTIME_SLACK_MS = 5000;
PositionHealthMonitor.RESTART_NOTE_MS = 5 * 60 * 1000;
PositionHealthMonitor.HISTORY_MAX = 50;
PositionHealthMonitor.STORAGE_KEY = 'flytab_position_events';
