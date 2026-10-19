/**
 * SuaNotams — which Restricted/Warning/Alert/Prohibited areas and MOAs a NOTAM
 * activates, and when.
 *
 * The FAA issues one "!SUA" NOTAM per activation under the ARTCC, e.g.
 *   !SUAE 10/004 ZJX AIRSPACE LGT OUT/NIGHT VISION GOGGLE TRAINING MOODY 2 NORTH MOA ACT 500FT-7999FT
 *   !SUAE 10/050 ZJX AIRSPACE R2904A ACT SFC-1700FT
 * with effectiveStart/effectiveEnd. They come through the NOTAM proxy (the
 * FitPC, CockpitConfig.notamBase -- the one WX Briefing uses), one request for
 * the ARTCCs near the map view and the active route. R/W/A/P areas match the
 * NASR id ("R2904A"); MOAs match the NASR name without its state ("MOODY 2
 * NORTH MOA, GA"). On 2026-10-19's NOTAMs (all CONUS ARTCCs) that matched 317
 * of 328; the rest were refueling tracks, a TFR and a high-speed area, which
 * are not SUA. Was: flywhere.app/api/notams (503, no credentials), an R-2501
 * pattern the FAA text never uses, and names compared with the state left on --
 * nothing ever matched (Dana, 2026-10-19).
 *
 * There is no internet in flight: the activations are kept (localStorage
 * flytab_sua_notams) and judged against the clock, so one downloaded on the
 * ground turns the area active at its start time in the air.
 */
class SuaNotams {
    static STORE_KEY = 'flytab_sua_notams';
    static STALE_MS = 15 * 60 * 1000;      // refetch an ARTCC after this (when online)
    static ARTCC_MARGIN_DEG = 1;
    static RETRY_MS = 60 * 1000;           // after a failed fetch
    static KEEP_TEXT = 300;                // chars of NOTAM text kept

    constructor() {
        this._acts = new Map();          // suaId -> [{ number, start, end, text, artcc }]
        this._fetchedAt = new Map();     // ARTCC ('ZJX') -> ms of its last good fetch
        this._index = null;              // { byId: Map, moaNames: [[name, id]] } from NASR
        this._artccBoxes = null;         // [{ id: 'ZJX', south, west, north, east }] -- loaded once
        this._checkedBoxesAt = 0;
        this._fetching = null;
        this._failedAt = 0;
        this._lastError = null;
        this._timer = null;
        this._load();
    }

    // ── What the map and the popup read ───────────────────────────────────

    /** The activation in force now, or null. */
    getNotam(sua, now = Date.now()) {
        return (this._acts.get(sua?.id) || []).find((a) => a.start <= now && now < a.end) || null;
    }

    hasActiveNotam(sua, now = Date.now()) { return !!this.getNotam(sua, now); }

    /** The next activation starting within 24 h, or null. */
    getUpcoming(sua, now = Date.now()) {
        return (this._acts.get(sua?.id) || [])
            .filter((a) => a.start > now && a.start - now < 24 * 3600e3)
            .sort((x, y) => x.start - y.start)[0] || null;
    }

    /**
     * When this area's NOTAMs were last downloaded (ms): the oldest download of
     * the ARTCCs that may issue them; 0 if one of those was never downloaded.
     */
    checkedAt(sua) {
        const b = SuaNotams._bbox(sua?.boundary);
        if (!b || !this._artccBoxes) return 0;
        const zs = this._artccsFor(b);
        if (!zs.length) return 0;
        return Math.min(...zs.map((z) => this._fetchedAt.get(z) || 0));
    }

    // ── Fetching ──────────────────────────────────────────────────────────

    /**
     * Make sure the NOTAMs for the ARTCCs under these boxes are current
     * (fetches when stale; quiet offline, keeping what it has).
     * @param nasr  NasrDB (getSuaInBounds / getAirspaceInBounds)
     * @param boxes [{ south, west, north, east }] -- the map view, the route
     */
    async refresh(nasr, boxes) {
        if (!nasr || !boxes?.length) return;
        if (this._fetching) return this._fetching;
        // Called on every map refresh: look at most every 20 s.
        if (Date.now() - this._checkedBoxesAt < 20000) return;
        this._checkedBoxesAt = Date.now();
        this._fetching = this._refresh(nasr, boxes).finally(() => { this._fetching = null; });
        return this._fetching;
    }

    async _refresh(nasr, boxes) {
        await this._loadArtccs(nasr);
        const artccs = new Set();
        for (const b of boxes) for (const z of this._artccsFor(b)) artccs.add(z);
        const now = Date.now();
        const due = [...artccs].filter((z) => now - (this._fetchedAt.get(z) || 0) > SuaNotams.STALE_MS).sort();
        if (!due.length || now - this._failedAt < SuaNotams.RETRY_MS) return;
        await this._buildIndex(nasr);            // the NASR cycle may have changed since the last fetch

        const base = (typeof CockpitConfig !== 'undefined' && CockpitConfig.notamBase)
            || (typeof Settings !== 'undefined' && Settings.workerBase) || 'https://www.flywhere.app/api';
        try {
            const resp = await fetch(`${base}/notams?location=${due.join(',')}`, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            this._apply(due, data.features || [], Date.now());
            this._lastError = null;
            this._failedAt = 0;
            this._save();
            this._changed();
        } catch (err) {
            // Offline (in flight) or the proxy is down: keep what we have.
            this._failedAt = Date.now();
            this._lastError = err?.message || String(err);
            console.debug('[SuaNotams] fetch failed:', this._lastError);
        }
    }

    /** Replace the activations of these ARTCCs with those in `features`. */
    _apply(artccs, features, fetchedAt) {
        const fetched = new Set(artccs);
        for (const [id, list] of this._acts) {
            const keep = list.filter((a) => !fetched.has(a.artcc));
            if (keep.length) this._acts.set(id, keep); else this._acts.delete(id);
        }
        const seen = new Set();
        for (const f of features) {
            const act = SuaNotams.parseActivation(f);
            if (!act) continue;
            const id = this._match(act.designator);
            if (!id) continue;
            const key = `${id}|${act.start}|${act.end}`;
            if (seen.has(key)) continue;            // the DOM and INTL copies
            seen.add(key);
            // Tagged with the ARTCC it was fetched for, so the next fetch of that ARTCC replaces it.
            const artcc = fetched.has(act.artcc) ? act.artcc : artccs[0];
            const list = this._acts.get(id) || [];
            list.push({ number: act.number, start: act.start, end: act.end, text: act.text, artcc });
            this._acts.set(id, list);
        }
        for (const z of artccs) this._fetchedAt.set(z, fetchedAt);
        this._prune(fetchedAt);
    }

    /**
     * The activation in one NOTAM feature (NMS GeoJSON), or null.
     * { designator, number, artcc, start, end, text }
     */
    static parseActivation(feature) {
        const n = feature?.properties?.coreNOTAMData?.notam;
        if (!n) return null;
        const text = String(n.text || '');
        if (n.type === 'C' || /\bNOTAMC\b/.test(text)) return null;          // a cancellation
        if (/TEMPORARY FLIGHT RESTRICTION/.test(text)) return null;
        const m = /\bAIRSPACE\s+(.+?)\s+ACT\b/.exec(text);
        if (!m) return null;
        const start = Date.parse(n.effectiveStart);
        const endRaw = Date.parse(n.effectiveEnd);
        // No start: in force now; no end (PERM): until removed. Shown active
        // rather than dropped -- the safe side.
        return {
            designator: m[1],
            number: n.number || n.id || '',
            artcc: SuaNotams._artccId(n.location || ''),
            start: Number.isFinite(start) ? start : 0,
            end: Number.isFinite(endRaw) ? endRaw : Infinity,
            text: text.slice(0, SuaNotams.KEEP_TEXT),
        };
    }

    // ── Matching to NASR areas ────────────────────────────────────────────

    /**
     * Each ARTCC's box (NASR has 26 boundaries, "ZJX-*"), loaded once. A box,
     * not the polygon: NASR's ARTCC boundary is several rings run together
     * (ZJX jumps back to its start at point 52), so point-in-polygon fails
     * inside it; a box can only be too big. Western-hemisphere points only:
     * ZOA/ZAK/ZAP run past 180 deg and their box would cover the world.
     */
    async _loadArtccs(nasr) {
        if (this._artccBoxes) return;
        const all = await nasr.getAirspaceInBounds(-90, -180, 90, 180, 100000);
        this._artccBoxes = all.filter((a) => a.class === 'ARTCC')
            .map((a) => ({ id: SuaNotams._artccId(a.id), ...SuaNotams._bbox((a.boundary || []).filter((p) => p[1] < 0)) }))
            .filter((a) => a.id && Number.isFinite(a.south));
    }

    /**
     * The ARTCCs that may issue NOTAMs for this box: those whose box, 1 deg
     * wider, overlaps it. On 2026-10-19's 364 matched NOTAMs this always held
     * the issuing ARTCC (0.5 deg missed one: JUNIPER MOA, ZLC), ~3.3 per area.
     */
    _artccsFor(b) {
        const M = SuaNotams.ARTCC_MARGIN_DEG;
        return (this._artccBoxes || []).filter((a) =>
            a.south - M <= b.north && a.north + M >= b.south && a.west - M <= b.east && a.east + M >= b.west).map((a) => a.id);
    }

    static _bbox(pts) {
        if (!pts?.length) return null;
        let south = 90, north = -90, west = 180, east = -180;
        for (const p of pts) {
            const lat = Array.isArray(p) ? p[0] : p.lat, lon = Array.isArray(p) ? p[1] : p.lon;
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            south = Math.min(south, lat); north = Math.max(north, lat); west = Math.min(west, lon); east = Math.max(east, lon);
        }
        return south <= north ? { south, west, north, east } : null;
    }

    /** NASR SUA ids and MOA names to match NOTAMs against. */
    async _buildIndex(nasr) {
        const rows = await nasr.getSuaInBounds(-90, -180, 90, 180, 100000);
        const byId = new Map();
        const moaNames = [];
        for (const r of rows) {
            if (!r?.id) continue;
            if (r.type === 'MOA') {
                const name = SuaNotams._moaName(r.name);
                if (name) moaNames.push([name, r.id]);
            } else {
                byId.set(SuaNotams._norm(r.id).replace(/ /g, ''), r.id);
            }
        }
        moaNames.sort((a, b) => b[0].length - a[0].length);   // the longest name that fits wins
        this._index = { byId, moaNames };
    }

    /** NASR id for the area a NOTAM's "AIRSPACE <designator> ACT" names, or null. */
    _match(designator) {
        if (!this._index) return null;
        const seg = ` ${SuaNotams._norm(designator)} `;
        // R2904A, W-470F, A-292, P-56A (the FAA writes them without the hyphen)
        for (const m of seg.matchAll(/ ([RWAP]) ?(\d{2,4}[A-Z]{0,2}) /g)) {
            const id = this._index.byId.get(m[1] + m[2]);
            if (id) return id;
        }
        for (const [name, id] of this._index.moaNames) {
            if (seg.includes(` ${name} `)) return id;
        }
        return null;
    }

    static _artccId(s) {
        const m = /^K?(Z[A-Z]{2})/.exec(String(s || '').toUpperCase());
        return m ? m[1] : '';
    }

    static _norm(s) {
        return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    }

    /** "MOODY 2 NORTH MOA, GA" -> "MOODY 2 NORTH MOA" */
    static _moaName(name) {
        return SuaNotams._norm(String(name || '').replace(/(,\s*[A-Z]{2})+\s*$/i, ''));
    }

    // ── Keeping it for the flight ────────────────────────────────────────

    _prune(now) {
        for (const [id, list] of this._acts) {
            const keep = list.filter((a) => a.end > now);
            if (keep.length) this._acts.set(id, keep); else this._acts.delete(id);
        }
    }

    _save() {
        try {
            const acts = [...this._acts].map(([id, l]) => [id, l.map((a) => ({ ...a, end: a.end === Infinity ? null : a.end }))]);
            localStorage.setItem(SuaNotams.STORE_KEY, JSON.stringify({
                v: 1, acts, fetchedAt: [...this._fetchedAt],
            }));
        } catch (_) {}
    }

    _load() {
        try {
            const raw = typeof localStorage !== 'undefined' && localStorage.getItem(SuaNotams.STORE_KEY);
            if (!raw) return;
            const d = JSON.parse(raw);
            if (d?.v !== 1) return;
            this._acts = new Map((d.acts || []).map(([id, l]) => [id, l.map((a) => ({ ...a, end: a.end == null ? Infinity : a.end }))]));
            this._fetchedAt = new Map(d.fetchedAt || []);
            this._prune(Date.now());
        } catch (_) {}
    }

    /** Tell the map (and wake it at the next start or end, so an area turns on/off on time). */
    _changed() {
        if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('sua-notams:changed'));
        if (this._timer) clearTimeout(this._timer);
        const now = Date.now();
        let next = Infinity;
        for (const l of this._acts.values()) for (const a of l) {
            if (a.start > now) next = Math.min(next, a.start);
            if (a.end > now) next = Math.min(next, a.end);
        }
        if (next < Infinity) {
            const wait = Math.min(Math.max(next - now + 1000, 1000), 6 * 3600e3);
            this._timer = setTimeout(() => this._changed(), wait);
        }
    }
}

// Singleton
if (typeof window !== 'undefined') {
    window.SuaNotams = window.SuaNotams || new SuaNotams();
    // Activations loaded from storage: wake the map at their start/end times.
    setTimeout(() => window.SuaNotams._changed(), 0);
}
