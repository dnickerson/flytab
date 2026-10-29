/**
 * FlyTab — TFRs from tfr.faa.gov, through the NOTAM proxy (FitPC, GET /tfrs).
 *
 * The FAA's own TFR data: every area as an exact polygon, with its altitudes
 * and its own times. The NOTAM-text TFRs (NMS staging, flytab #146) missed the
 * Charlotte / Rock Hill VIP TFR on 2026-10-29 and drew its circles as a line.
 *
 * Downloaded on the ground (no internet in flight): at start and every
 * REFRESH_MS, for a box around where we are and the loaded route, and kept
 * (CACHE_KEY) for the flight. Areas whose end has passed drop off.
 */
class FaaTfrClient extends EventTarget {
    static CACHE_KEY = 'flytab_faa_tfr_cache';
    static REFRESH_MS = 15 * 60 * 1000;
    static TIMEOUT_MS = 60 * 1000;
    static BOX_MARGIN_NM = 150;
    static MAX_SPAN_DEG = 30;
    /** The FAA data is the TFR picture (NOTAM-text TFRs hidden) while younger than this. */
    static CURRENT_MS = 24 * 60 * 60 * 1000;

    /**
     * @param {Object} opts
     * @param {() => string|null} opts.baseUrl      the NOTAM proxy (CockpitConfig.notamBase)
     * @param {() => Array<[number,number]>} opts.points  where we are + the route, [lat, lon]
     * @param {() => boolean} [opts.canFetch]        false in flight (no internet)
     */
    constructor(opts = {}) {
        super();
        this._baseUrl = opts.baseUrl || (() => null);
        this._points = opts.points || (() => []);
        this._canFetch = opts.canFetch || (() => true);
        this.data = FaaTfrClient._load();     // { fetchedAt, bbox, tfrs } | null
        this.lastError = null;
        this._timer = null;
        this._inFlight = null;
    }

    start() {
        this.refresh();
        if (!this._timer) this._timer = setInterval(() => this.refresh(), FaaTfrClient.REFRESH_MS);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /** Is the downloaded FAA data recent enough to be the TFR picture? */
    isCurrent(now = Date.now()) {
        const t = Date.parse(this.data?.fetchedAt || '');
        return Number.isFinite(t) && now - t >= 0 && now - t < FaaTfrClient.CURRENT_MS;
    }

    /** Download now (shared by concurrent callers). Resolves true when new data arrived. */
    refresh() {
        if (this._inFlight) return this._inFlight;
        this._inFlight = this._refresh().finally(() => { this._inFlight = null; });
        return this._inFlight;
    }

    async _refresh() {
        const base = this._baseUrl();
        if (!base || !this._canFetch()) return false;
        const box = FaaTfrClient.bboxFor(this._points(), FaaTfrClient.BOX_MARGIN_NM);
        if (!box) return false;
        const url = `${base.replace(/\/$/, '')}/tfrs?bbox=${box.map((v) => v.toFixed(3)).join(',')}`;
        try {
            const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(FaaTfrClient.TIMEOUT_MS) });
            const body = await r.json().catch(() => null);
            if (!r.ok || !body || !Array.isArray(body.tfrs)) throw new Error(body?.error || `HTTP ${r.status}`);
            this.data = {
                fetchedAt: typeof body.fetchedAt === 'string' ? body.fetchedAt : new Date().toISOString(),
                bbox: box,
                failed: Array.isArray(body.failed) ? body.failed.map(String).slice(0, 100) : [],
                tfrs: body.tfrs.map(FaaTfrClient._clean).filter(Boolean),
            };
            FaaTfrClient._save(this.data);
            this.lastError = null;
            if (typeof DiagLog !== 'undefined') {
                DiagLog.log('tfr', `tfr.faa.gov: ${this.data.tfrs.length} TFRs${this.data.failed.length ? `, no details for ${this.data.failed.join(' ')}` : ''}`);
            }
            this.dispatchEvent(new CustomEvent('faatfr:updated', { detail: this.data }));
            return true;
        } catch (e) {
            this.lastError = e?.message || String(e);
            if (typeof DiagLog !== 'undefined') DiagLog.log('tfr', `tfr.faa.gov download failed: ${this.lastError} (keeping ${this.data?.fetchedAt || 'nothing'})`);
            this.dispatchEvent(new CustomEvent('faatfr:error', { detail: { error: this.lastError } }));
            return false;
        }
    }

    /**
     * Every area not yet over, one entry per area: status 'active' (now within
     * its times), 'upcoming', or 'unknown' (no times from the FAA).
     */
    areas(now = Date.now()) {
        const out = [];
        for (const t of this.data?.tfrs || []) {
            for (const a of t.areas) {
                const s = Date.parse(a.start || ''), e = Date.parse(a.end || '');
                if (Number.isFinite(e) && e <= now) continue;
                const status = !Number.isFinite(s) && !Number.isFinite(e) ? 'unknown'
                    : (Number.isFinite(s) && s > now) ? 'upcoming' : 'active';
                out.push({ tfr: t, area: a, status, fetchedAt: this.data.fetchedAt });
            }
        }
        return out;
    }

    /**
     * TFRs at or near a point (an airport): one entry per TFR -- its most
     * relevant area (inside before near, active before upcoming) -- with
     * distanceNm (0 = inside). Nearest first.
     */
    near(lat, lon, withinNm = 5, now = Date.now()) {
        const rank = { active: 0, upcoming: 1, unknown: 2 };
        const best = new Map();
        for (const e of this.areas(now)) {
            const d = FaaTfrClient.distanceNm(lat, lon, e.area.polygon);
            if (d > withinNm) continue;
            const cur = best.get(e.tfr.id);
            let better;
            if (!cur) better = true;
            else if ((d === 0) !== (cur.distanceNm === 0)) better = d === 0;              // inside wins
            else if (rank[e.status] !== rank[cur.status]) better = rank[e.status] < rank[cur.status];  // then active
            else better = d < cur.distanceNm;                                              // then closer
            if (better) best.set(e.tfr.id, { ...e, distanceNm: d });
        }
        return [...best.values()].sort((a, b) => a.distanceNm - b.distanceNm || rank[a.status] - rank[b.status]);
    }

    /** 0 inside the polygon ([lat, lon] points), else the distance to its nearest edge, nm. */
    static distanceNm(lat, lon, poly) {
        if (!Array.isArray(poly) || poly.length < 3) return Infinity;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const [yi, xi] = poly[i], [yj, xj] = poly[j];
            if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
        }
        if (inside) return 0;
        const kx = 60 * Math.cos(lat * Math.PI / 180), ky = 60;          // nm per degree, locally
        let min = Infinity;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const ax = (poly[j][1] - lon) * kx, ay = (poly[j][0] - lat) * ky;
            const bx = (poly[i][1] - lon) * kx, by = (poly[i][0] - lat) * ky;
            const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
            min = Math.min(min, Math.hypot(ax + t * dx, ay + t * dy));
        }
        return min;
    }

    /** [lat, lon] points + margin -> [W, S, E, N] (at most MAX_SPAN_DEG each way), or null. */
    static bboxFor(points, marginNm) {
        const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (!pts.length) return null;
        let s = Math.min(...pts.map((p) => p[0])), n = Math.max(...pts.map((p) => p[0]));
        let w = Math.min(...pts.map((p) => p[1])), e = Math.max(...pts.map((p) => p[1]));
        const dLat = marginNm / 60;
        const dLon = marginNm / (60 * Math.max(0.2, Math.cos(((s + n) / 2) * Math.PI / 180)));
        s -= dLat; n += dLat; w -= dLon; e += dLon;
        const max = FaaTfrClient.MAX_SPAN_DEG;
        if (n - s > max) { const c = (s + n) / 2; s = c - max / 2; n = c + max / 2; }
        if (e - w > max) { const c = (w + e) / 2; w = c - max / 2; e = c + max / 2; }
        return [Math.max(-180, w), Math.max(-90, s), Math.min(180, e), Math.min(90, n)];
    }

    /** Keep only what the map and popup use, in the expected types (it comes off the network). */
    static _clean(t) {
        if (!t || typeof t.id !== 'string' || !Array.isArray(t.areas)) return null;
        const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);
        const num = (v) => (Number.isFinite(v) ? v : null);
        const areas = t.areas.map((a) => {
            const poly = Array.isArray(a?.polygon)
                ? a.polygon.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
                    && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180).map((p) => [p[0], p[1]])
                : [];
            if (poly.length < 3) return null;
            return {
                name: str(a.name, 60) || '', polygon: poly,
                lowerFt: num(a.lowerFt), lowerRef: str(a.lowerRef, 4), upperFt: num(a.upperFt), upperRef: str(a.upperRef, 4),
                start: str(a.start, 30), end: str(a.end, 30),
            };
        }).filter(Boolean);
        if (!areas.length) return null;
        return {
            id: t.id.slice(0, 20), title: str(t.title) || '', name: str(t.name) || '', legal: str(t.legal, 40),
            type: str(t.type, 20), facility: str(t.facility, 10), timeZone: str(t.timeZone, 6),
            start: str(t.start, 30), end: str(t.end, 30), detail: t.detail === true, text: str(t.text, 6000) || '',
            areas,
        };
    }

    static _load() {
        try {
            const d = JSON.parse(localStorage.getItem(FaaTfrClient.CACHE_KEY) || 'null');
            if (!d || !Array.isArray(d.tfrs) || typeof d.fetchedAt !== 'string') return null;
            return { ...d, tfrs: d.tfrs.map(FaaTfrClient._clean).filter(Boolean) };
        } catch { return null; }
    }

    static _save(d) {
        try { localStorage.setItem(FaaTfrClient.CACHE_KEY, JSON.stringify(d)); } catch { /* storage full: keep in memory */ }
    }
}

if (typeof window !== 'undefined') window.FaaTfrClient = FaaTfrClient;
