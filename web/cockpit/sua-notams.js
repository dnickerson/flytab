/**
 * SuaNotams — which Restricted/Warning/Alert/Prohibited areas and MOAs a NOTAM
 * activates, and when.
 *
 * The FAA issues one "!SUA" NOTAM per activation under the ARTCC, e.g.
 *   !SUAE 10/004 ZJX AIRSPACE LGT OUT/NIGHT VISION GOGGLE TRAINING MOODY 2 NORTH MOA ACT 500FT-7999FT
 *   !SUAE 10/050 ZJX AIRSPACE R2904A ACT SFC-1700FT
 * with effectiveStart/effectiveEnd. They come through the NOTAM proxy (the
 * FitPC, CockpitConfig.notamBase -- the one WX Briefing uses), up to six
 * ARTCCs per request, for those near the map view, its areas and the route. R/W/A/P areas match the
 * NASR id ("R2904A"); MOAs match the NASR name without its state ("MOODY 2
 * NORTH MOA, GA"). On 2026-10-19's NOTAMs (all CONUS ARTCCs) that matched 364
 * of 374 activations; the rest were refueling tracks and a high-speed area,
 * which are not SUA. Was: flywhere.app/api/notams (503, no credentials), an R-2501
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
    static ARTCC_MARGIN_DEG = 2;     // 1 held the issuing ARTCC for 364/364 on 10-19; 2 for margin (review)
    // NASR ARTCCs the NMS API does not take as a location (ZAP: no NOTAM list
    // back, 10-19). Every other one answered with NOTAMs that day (fewest:
    // ZSU 18, ZAU 21; the oceanic ZWY 21, ZAK 69 -- ZAK alone issues W-237H/J).
    static NOT_NMS = new Set(['ZAP']);
    static PER_REQUEST = 6;          // ARTCCs per proxy request
    static RETRY_MS = 60 * 1000;           // after a failed fetch
    static KEEP_TEXT = 300;                // chars of NOTAM text kept

    constructor() {
        this._acts = new Map();          // suaId -> [{ number, start, end, text, artcc }]
        this._fetchedAt = new Map();     // ARTCC ('ZJX') -> ms of its last good fetch
        this._index = null;              // { byKey: Map<key, ids[]>, moaNames: [[name, ids[]]] } from NASR
        this._artccBoxes = null;         // [{ id: 'ZJX', south, west, north, east }] -- loaded once
        this._artccLoadedAt = 0;
        this._fetching = null;
        this._failedAt = 0;
        this._retryAt = new Map();       // ARTCC -> ms before which it is not asked again (empty: 15 min, FAA error: 1, 2, 4, 8, 15 min)
        this._failCount = new Map();     // ARTCC -> FAA errors in a row
        this._lastError = null;
        this._timer = null;
        this._load();
    }

    // ── What the map and the popup read ───────────────────────────────────

    /** The activation in force now, or null. */
    getNotam(sua, now = Date.now()) {
        // Overlapping activations: the one that runs longest ("until" its end).
        return (this._acts.get(sua?.id) || []).filter((a) => a.start <= now && now < a.end)
            .sort((x, y) => y.end - x.end)[0] || null;
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
        if (!SuaNotams.matchable(sua)) return 0;
        const b = SuaNotams._bbox(sua?.boundary);
        if (!b || !this._artccBoxes) return 0;
        const zs = this._artccsFor(b);
        if (!zs.length) return 0;
        return Math.min(...zs.map((z) => this._fetchedAt.get(z) || 0));
    }

    /**
     * False for areas no !SUA NOTAM names in a form matched here -- National
     * Security Areas ("NEVERETT", typed A in NASR). Their popup says to check
     * the NOTAMs instead of "no activation NOTAM".
     */
    static matchable(sua) {
        if (!sua?.id) return false;
        if (sua.type === 'MOA') return /\bMOA\b/i.test(sua.name || '');
        return /^[RWAP]\d/.test(String(sua.id).toUpperCase());
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
        // Called on every map refresh; cheap unless an ARTCC is due (25 boxes).
        this._fetching = this._refresh(nasr, boxes).finally(() => { this._fetching = null; });
        return this._fetching;
    }

    async _refresh(nasr, boxes) {
        await this._loadArtccs(nasr);
        const artccs = new Set();
        for (const b of boxes) for (const z of this._artccsFor(b)) artccs.add(z);
        const now = Date.now();
        const age = (z) => now - (this._fetchedAt.get(z) || 0);   // < 0: the clock was set back
        const waiting = (z) => { const t = this._retryAt.get(z); return t != null && now < t && t - now <= SuaNotams.STALE_MS; };
        // The view's ARTCCs first, then the areas' and the route's.
        const inView = new Set(this._artccsFor(boxes[0]));
        const due = [...artccs].filter((z) => (age(z) > SuaNotams.STALE_MS || age(z) < 0) && !waiting(z))
            .sort((a, b) => (inView.has(b) - inView.has(a)) || a.localeCompare(b));
        const sinceFail = now - this._failedAt;
        if (!due.length || (sinceFail >= 0 && sinceFail < SuaNotams.RETRY_MS)) return;
        // NASR wiped (Reset NASR Data): nothing to match -- don't ask the FAA every minute.
        if (!(await nasr.getSuaInBounds(-90, -180, 90, 180, 1)).length) return;

        const base = (typeof CockpitConfig !== 'undefined' && CockpitConfig.notamBase)
            || (typeof Settings !== 'undefined' && Settings.workerBase) || 'https://www.flywhere.app/api';
        // A few ARTCCs per request: the proxy asks the FAA for each in turn
        // (~0.5 s each) and stops a request at 25 s -- 19 in one request
        // could pass the client's 30 s timeout (review 5).
        for (let i = 0; i < due.length; i += SuaNotams.PER_REQUEST) {
            if (!(await this._fetchSome(nasr, base, due.slice(i, i + SuaNotams.PER_REQUEST)))) break;   // offline: stop
        }
    }

    /**
     * One request for these ARTCCs; false only if it could not be made or
     * answered (offline, HTTP error, NASR gone) -- an answer whose ARTCCs all
     * failed at the FAA does not hold up the next request (review 6).
     */
    async _fetchSome(nasr, base, due) {
        try {
            // no-store: the proxy marks answers cacheable for 5 min, and a retry
            // of the same ARTCCs must not get the failed answer back (review 6).
            // deadline=25: the proxy stops at 25 s and lists the rest as failed
            // (only clients that read `failed` ask for it -- not WX Briefing).
            const resp = await fetch(`${base}/notams?location=${due.join(',')}&deadline=25`, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const features = data.features || [];
            // Not fetched (kept as it was, not "no activation NOTAM"; reviews
            // 2026-10-19): one the proxy lists as `failed` (tools/notam-proxy.py
            // since 10-19), and one with nothing back -- the older proxy skips
            // FAA errors silently, and every ARTCC has NOTAMs.
            const got = new Set(features.map((f) => SuaNotams._artccId(f?.properties?.coreNOTAMData?.notam?.location)));
            const failed = new Set((Array.isArray(data.failed) ? data.failed : []).map(SuaNotams._artccId));
            const ok = due.filter((z) => !failed.has(z) && got.has(z));
            const t = Date.now();
            for (const z of due) {
                if (ok.includes(z)) { this._retryAt.delete(z); this._failCount.delete(z); continue; }
                if (!failed.has(z)) { this._retryAt.set(z, t + SuaNotams.STALE_MS); continue; }
                // An FAA error: 1 min, then 2, 4, 8, 15 -- a refused token or an FAA
                // outage is not asked about 20 times a minute (review 7).
                const n = (this._failCount.get(z) || 0) + 1;
                this._failCount.set(z, n);
                this._retryAt.set(z, t + Math.min(SuaNotams.RETRY_MS * 2 ** (n - 1), SuaNotams.STALE_MS));
            }
            if (!ok.length) { this._lastError = `no NOTAMs returned for ${due.join(',')}`; return true; }
            await this._buildIndex(nasr);        // the NASR cycle may have changed since the last fetch
            // NASR wiped (Reset NASR Data) mid-session: nothing to match, so
            // applying would drop every activation (review).
            if (!this._index?.byKey.size && !this._index?.moaNames.length) throw new Error('NASR SUA not loaded');
            this._apply(ok, features.filter((f) => ok.includes(SuaNotams._artccId(f?.properties?.coreNOTAMData?.notam?.location))), Date.now());
            this._lastError = ok.length < due.length ? `not fetched: ${due.filter((z) => !ok.includes(z)).join(',')}` : null;
            this._failedAt = 0;
            this._save();
            this._changed();
            return true;
        } catch (err) {
            // Offline (in flight) or the proxy is down: keep what we have.
            this._failedAt = Date.now();
            this._lastError = err?.message || String(err);
            console.debug('[SuaNotams] fetch failed:', this._lastError);
            return false;
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
            for (const id of this._match(act.designator)) {
                const key = `${id}|${act.start}|${act.end}`;
                if (seen.has(key)) continue;            // the DOM and INTL copies
                seen.add(key);
                // Tagged with the ARTCC it was fetched for, so the next fetch of that ARTCC replaces it.
                const artcc = fetched.has(act.artcc) ? act.artcc : artccs[0];
                const list = this._acts.get(id) || [];
                list.push({ number: act.number, start: act.start, end: act.end, text: act.text, artcc });
                this._acts.set(id, list);
            }
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
        const text = String(n.text || '').replace(/\s+/g, ' ').trim();   // NOTAM text can wrap
        if (n.type === 'C' || /\bNOTAMC\b/.test(text)) return null;          // a cancellation
        if (/TEMPORARY FLIGHT RESTRICTION/i.test(text)) return null;
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
        if (this._artccBoxes?.length) return;
        // Empty (NASR not imported, or a bundle without ARTCCs): look again at
        // most once a minute -- it reads the whole airspace store (review 6).
        if (this._artccBoxes && Date.now() - this._artccLoadedAt >= 0 && Date.now() - this._artccLoadedAt < SuaNotams.RETRY_MS) return;
        // Not kept while empty: the map starts before NASR is imported (a new
        // install, Reset NASR Data) -- it latched [] and never fetched (review).
        const all = await nasr.getAirspaceInBounds(-90, -180, 90, 180, 100000);
        // The minute's wait only when there is airspace but no ARTCC in it: an
        // empty store (NASR still importing) is cheap to look at, and the first
        // download should follow the import, not wait for a pan (review 7).
        this._artccLoadedAt = all.length ? Date.now() : 0;
        this._artccBoxes = all.filter((a) => a.class === 'ARTCC')
            .map((a) => ({ id: SuaNotams._artccId(a.id), ...SuaNotams._bbox((a.boundary || []).filter((p) => p[1] < 0)) }))
            .filter((a) => a.id && Number.isFinite(a.south) && !SuaNotams.NOT_NMS.has(a.id));
    }

    /**
     * The ARTCCs that may issue NOTAMs for this box: those whose box,
     * ARTCC_MARGIN_DEG wider, overlaps it. On 2026-10-19's 364 matched NOTAMs this always held
     * the issuing ARTCC (0.5 deg missed one: JUNIPER MOA, ZLC), ~3.3 per area;
     * ARTCC_MARGIN_DEG is 2 to leave room (~3.8 per area).
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

    /**
     * NASR areas by the keys a NOTAM can name them by. R/W/A/P: the id, also
     * without a "_2" split-polygon suffix (R4804A_2) and without a HIGH/LOW/
     * NORTH/SOUTH word (R3202HIGH, W93NORTH). MOAs: the name up to "MOA"
     * ("MOODY 2 NORTH MOA, GA", "SNAKE LOW MOA GULFPORT, MS").
     */
    async _buildIndex(nasr) {
        const rows = await nasr.getSuaInBounds(-90, -180, 90, 180, 100000);
        const byKey = new Map();
        const add = (k, id) => { if (!k) return; const l = byKey.get(k) || []; if (!l.includes(id)) l.push(id); byKey.set(k, l); };
        const moaNames = new Map();
        for (const r of rows) {
            if (!SuaNotams.matchable(r)) continue;
            if (r.type === 'MOA') {
                const name = SuaNotams._moaName(r.name);
                if (name) moaNames.set(name, [...(moaNames.get(name) || []), r.id]);
                continue;
            }
            const id = String(r.id).toUpperCase();
            const bare = id.replace(/_\d+$/, '');
            add(bare, r.id);
            const w = /^([RWAP]\d+[A-Z]?)(HIGH|LOW|NORTH|SOUTH|EAST|WEST)$/.exec(bare);
            if (w) { add(w[1] + ' ' + w[2], r.id); add(w[1], r.id); }
        }
        this._index = { byKey, moaNames: [...moaNames].sort((a, b) => b[0].length - a[0].length) };
    }

    /**
     * NASR ids of every area a NOTAM's "AIRSPACE <designator> ACT" names ([]
     * if none). "R4401A/B", "R4401A B C" and "X MOA AND Y MOA" name several.
     * A designator NASR only has sub-areas of (W161A -> W161AN, W161AS) lights
     * all of them: shown active rather than missed.
     */
    _match(designator) {
        if (!this._index) return [];
        const { byKey, moaNames } = this._index;
        const out = new Set();
        // "R4401A-E", "R4401A THRU E" -> "R4401A B C D E" (before the hyphen is lost)
        const ranged = String(designator || '').toUpperCase().replace(
            /\b([RWAP]-?\d{1,4})([A-Z])\s*(?:-|THRU|THROUGH)\s*([RWAP]-?\d{1,4})?([A-Z])\b/g,
            (all, base, a, base2, b) => ((!base2 || base2.replace('-', '') === base.replace('-', '')) && b > a && b.charCodeAt(0) - a.charCodeAt(0) < 12
                ? base + [...Array(b.charCodeAt(0) - a.charCodeAt(0) + 1)].map((_, i) => String.fromCharCode(a.charCodeAt(0) + i)).join(' ')
                : all));
        let seg = ` ${SuaNotams._norm(ranged)} `;
        const lookup = (k, word) => {
            if (Array.isArray(word) && word.length) { word.forEach((w) => lookup(k, w)); return; }
            if (Array.isArray(word)) word = null;
            const hit = (word && (byKey.get(`${k} ${word}`) || byKey.get(k + word[0]))) || byKey.get(k)
                || [...byKey].filter(([key]) => key.length > k.length && key.startsWith(k) && /^[A-Z]+$/.test(key.slice(k.length))).flatMap(([, ids]) => ids);
            for (const id of hit) out.add(id);
        };
        for (const m of seg.matchAll(/ ([RWAP]) ?(\d{1,4})([A-Z]{0,2})((?: (?:AND )?[A-Z](?= ))*)((?: (?:AND )?(?:HIGH|LOW|NORTH|SOUTH|EAST|WEST)(?= ))*)/g)) {
            const [, kind, num, letters, more, words] = m;
            const word = (words || '').trim().split(' ').filter((w) => w && w !== 'AND');   // "NORTH AND SOUTH"

            lookup(kind + num + letters, word);
            for (const extra of (more || '').trim().split(' ').filter((w) => w && w !== 'AND')) lookup(kind + num + extra, word);   // R4401A B C, R4401A/B, W497A AND B
        }
        const names = new Map(moaNames);
        // "RESERVE AND DOME MOA": a whole name (less MOA) before AND
        for (const [name, ids] of moaNames) {
            if (seg.includes(` ${name.slice(0, -4)} AND `)) ids.forEach((id) => out.add(id));
        }
        for (const [name, ids] of moaNames) {                      // longest first; a matched name is blanked out
            const at = seg.indexOf(` ${name} `);
            if (at < 0) continue;
            ids.forEach((id) => out.add(id));
            seg = seg.slice(0, at) + ' ' + '#'.repeat(name.length) + ' ' + seg.slice(at + name.length + 2);
        }
        // Several MOAs in one name: "BULLDOG A AND B MOA", "GAMECOCK C/D MOA",
        // "MOODY 2 NORTH AND SOUTH MOA". Only names NASR has are taken.
        const toks = seg.trim().split(' ');
        for (let i = 0; i < toks.length; i++) {
            if (toks[i] !== 'MOA') continue;                        // a MOA not matched whole above
            let lo = i;
            while (lo > 0 && !toks[lo - 1].startsWith('#') && i - lo < 10) lo--;
            const pre = toks.slice(lo, i);
            found: for (let k = 2; k <= Math.min(7, pre.length - 1); k++) {
                const tail = pre.slice(pre.length - k);             // "A AND B", "C D", "NORTH AND SOUTH"
                if (tail[0] === 'AND' || tail[tail.length - 1] === 'AND') continue;
                const parts = tail.filter((w) => w !== 'AND');
                if (parts.length < 2) continue;
                const rest = pre.slice(0, pre.length - k);
                for (let b = 1; b <= Math.min(4, rest.length); b++) {
                    const base = rest.slice(rest.length - b).join(' ');
                    const ids = parts.map((p) => names.get(`${base} ${p} MOA`));
                    if (ids.every(Boolean)) { ids.flat().forEach((id) => out.add(id)); break found; }
                }
            }
        }
        return [...out];
    }

    static _artccId(s) {
        const m = /^K?(Z[A-Z]{2})/.exec(String(s || '').toUpperCase());
        return m ? m[1] : '';
    }

    static _norm(s) {
        return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    }

    /** "MOODY 2 NORTH MOA, GA" -> "MOODY 2 NORTH MOA"; "SNAKE LOW MOA GULFPORT, MS" -> "SNAKE LOW MOA" */
    static _moaName(name) {
        const m = /^(.*?\bMOA)\b/i.exec(String(name || ''));
        return m ? SuaNotams._norm(m[1]) : '';
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
    setTimeout(() => window.SuaNotams?._changed?.(), 0);
}
